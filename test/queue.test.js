'use strict';
// Runs the real queue against a pretend yt-dlp, end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, 'fake-bin');
for (const f of fs.readdirSync(BIN)) fs.chmodSync(path.join(BIN, f), 0o755);
process.env.SLIMTAKE_BIN = BIN;

const { Engine } = require('../src/main/engine');
const { Library } = require('../src/main/library');
const { Queue } = require('../src/main/queue');
const { History } = require('../src/main/history');
const { Prober } = require('../src/main/probe');
const { Watch } = require('../src/main/watch');
const { JsonStore } = require('../src/main/util');
const settingsMod = require('../src/main/settings');

function setup(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stq-'));
  process.env.FAKE_STATE_DIR = tmp;
  const log = { info() {}, warn() {}, error() {} };
  const settings = { ...settingsMod.defaults(tmp), polite: false, retries: 2, minFreeGB: 0, ...extra };
  const engine = new Engine({ dir: tmp, log });
  const library = new Library({ storeFile: path.join(tmp, 'lib.json'), probeDuration: (f) => engine.probeDuration(f), log });
  const history = new History(new JsonStore(path.join(tmp, 'history.json'), []));
  const notified = { done: [], failed: [] };
  const queueStore = new JsonStore(path.join(tmp, 'queue.json'), []);
  const queue = new Queue({ engine, library, getSettings: () => settings, log, history, store: queueStore,
    notify: { done: (i) => notified.done.push(i.title), failed: (i) => notified.failed.push(i.title) } });
  return { tmp, settings, engine, library, history, queue, notified, log, queueStore };
}

function waitFor(queue, pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out: ' + JSON.stringify(queue.list().map((i) => [i.title, i.status, i.note, i.error])))), ms);
    const check = () => { if (pred(queue.list())) { clearTimeout(t); queue.off('item', check); queue.off('list', check); resolve(queue.list()); } };
    queue.on('item', check);
    queue.on('list', check);
    check();
  });
}
const settled = (list) => list.every((i) => ['done', 'failed', 'skipped', 'canceled'].includes(i.status));

test('downloads land in creator folders, named by title, dated by upload', async () => {
  const { tmp, queue, history, notified, settings } = setup();
  queue.add({ url: 'https://www.youtube.com/watch?v=v1', title: 'Jimmy Cuts Grass?', folder: 'Jimmy The Lawn Guy', site: 'YouTube', extractor: 'Youtube', videoId: 'v1', duration: 768 });
  const list = await waitFor(queue, settled);
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
  const file = path.join(settings.folder, 'Jimmy The Lawn Guy', 'Jimmy Cuts Grass.mp4');
  assert.ok(fs.existsSync(file), 'file saved with clean title');
  assert.equal(fs.statSync(file).mtime.getUTCFullYear(), 2023, 'file date = upload date');
  assert.equal(history.all().length, 1);
  assert.deepEqual(notified.done, ['Jimmy Cuts Grass?']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('same title + same length is skipped; different length becomes (2); same ID is skipped', async () => {
  const { queue, settings } = setup();
  const base = { folder: 'Jimmy The Lawn Guy', site: 'YouTube', extractor: 'Youtube' };
  queue.add({ ...base, url: 'https://www.youtube.com/watch?v=v1', title: 'Jimmy Cuts Grass', videoId: 'v1', duration: 768 });
  await waitFor(queue, settled);
  queue.add({ ...base, url: 'https://www.youtube.com/watch?v=v3', title: 'Jimmy Cuts Grass', videoId: 'v3', duration: 930 });
  queue.add({ ...base, url: 'https://www.youtube.com/watch?v=v9', title: 'Jimmy Cuts Grass', videoId: 'v9', duration: 769 });
  queue.add({ ...base, url: 'https://www.youtube.com/watch?v=v1&again', title: 'Renamed upload', videoId: 'v1', duration: 768 });
  const list = await waitFor(queue, settled);
  const byUrl = (u) => list.find((i) => i.url.includes(u));
  assert.equal(byUrl('v=v3').status, 'done');
  assert.ok(byUrl('v=v3').filePath.endsWith('Jimmy Cuts Grass (2).mp4'));
  assert.equal(byUrl('v=v9').status, 'skipped', 'same title and length');
  assert.equal(byUrl('again').status, 'skipped', 'same video ID');
  const files = fs.readdirSync(path.join(settings.folder, 'Jimmy The Lawn Guy')).sort();
  assert.deepEqual(files, ['Jimmy Cuts Grass (2).mp4', 'Jimmy Cuts Grass.mp4']);
});

test('files already in the folder (not from Slim Takes) count as duplicates', async () => {
  const { queue, settings } = setup();
  const dir = path.join(settings.folder, 'Jimmy The Lawn Guy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Leaf Blower Showdown.mkv'), 'dur=500');
  queue.add({ url: 'https://www.youtube.com/watch?v=v2', title: 'Leaf Blower Showdown', folder: 'Jimmy The Lawn Guy', extractor: 'Youtube', videoId: 'v2', duration: 500 });
  const list = await waitFor(queue, settled);
  assert.equal(list[0].status, 'skipped');
});

test('parallel downloads with the same title never share a file name', async () => {
  const { queue, settings } = setup({ concurrent: 4 });
  for (let i = 0; i < 4; i++) queue.add({ url: `https://www.youtube.com/watch?v=p${i}`, title: 'Same Name', folder: 'Many', extractor: 'Youtube', videoId: 'p' + i, duration: 100 + i * 10 });
  const list = await waitFor(queue, settled);
  assert.ok(list.every((i) => i.status === 'done'), JSON.stringify(list.map((i) => i.status)));
  const files = fs.readdirSync(path.join(settings.folder, 'Many')).sort();
  assert.deepEqual(files, ['Same Name (2).mp4', 'Same Name (3).mp4', 'Same Name (4).mp4', 'Same Name.mp4']);
});

test('failures: permanent errors fail at once, network errors retry then succeed', async () => {
  const { queue, notified, history } = setup({ retries: 2 });
  // speed up retry waits
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const bump = setInterval(() => { offset += 20000; queue.pump(); }, 100);
  try {
    queue.add({ url: 'https://www.youtube.com/watch?v=fail1', title: 'Gone Video', folder: 'X', extractor: 'Youtube' });
    queue.add({ url: 'https://www.youtube.com/watch?v=flaky1', title: 'Flaky Video', folder: 'X', extractor: 'Youtube' });
    const list = await waitFor(queue, settled, 20000);
    const gone = list.find((i) => i.title === 'Gone Video');
    const flaky = list.find((i) => i.title === 'Flaky Video');
    assert.equal(gone.status, 'failed');
    assert.equal(gone.error, 'Video unavailable or removed.');
    assert.equal(gone.attempts, 1, 'no pointless retries');
    assert.equal(flaky.status, 'done');
    assert.deepEqual(notified.failed, ['Gone Video']);
    assert.equal(history.all().find((h) => h.title === 'Gone Video').status, 'failed');
  } finally { clearInterval(bump); Date.now = realNow; }
});

test('a container that cannot be repackaged falls back to converting', async () => {
  const { queue } = setup();
  queue.add({ url: 'https://www.youtube.com/watch?v=needsconvert', title: 'Needs Convert', folder: 'X', extractor: 'Youtube', format: 'mov' });
  const list = await waitFor(queue, settled);
  assert.equal(list[0].status, 'done');
  assert.ok(list[0].filePath.endsWith('.mov'));
});

test('private downloads stay out of history', async () => {
  const { queue, history } = setup();
  queue.add({ url: 'https://www.youtube.com/watch?v=pv', title: 'Secret', folder: 'P', extractor: 'Youtube', private: true });
  await waitFor(queue, settled);
  assert.equal(history.all().length, 0);
});

test('pause, resume and cancel', async () => {
  const { queue, settings } = setup();
  const it = queue.add({ url: 'https://www.youtube.com/watch?v=slow1', title: 'Slow One', folder: 'S', extractor: 'Youtube' });
  await waitFor(queue, (l) => l[0].status === 'downloading' && l[0].pct > 0);
  queue.pause(it.id);
  await waitFor(queue, (l) => l[0].status === 'paused');
  queue.resume(it.id);
  await waitFor(queue, (l) => l[0].status === 'downloading');
  queue.cancel(it.id);
  const list = await waitFor(queue, (l) => l[0].status === 'canceled');
  assert.equal(list[0].status, 'canceled');
  assert.ok(fs.existsSync(path.join(settings.folder, 'S')));
});

test('unfinished downloads survive a restart', async () => {
  const s = setup();
  s.queue.pauseAll();
  s.queue.add({ url: 'https://www.youtube.com/watch?v=later', title: 'Later', folder: 'L', extractor: 'Youtube' });
  s.queueStore.saveNow();
  const q2 = new Queue({ engine: s.engine, library: s.library, getSettings: () => s.settings, log: s.log, history: s.history,
    store: new JsonStore(path.join(s.tmp, 'queue.json'), []), notify: { done() {}, failed() {} } });
  assert.equal(q2.list().length, 1);
  assert.equal(q2.list()[0].title, 'Later');
  q2.pump();
  const list = await waitFor(q2, settled);
  assert.equal(list[0].status, 'done');
});

test('disk space guard pauses the queue', async () => {
  const s = setup({ minFreeGB: 1e6 / 1e3 * 1000 }); // absurd threshold -> always "low"
  let low = false;
  s.queue.on('diskLow', () => { low = true; });
  s.queue.add({ url: 'https://www.youtube.com/watch?v=d1', title: 'Disk', folder: 'D', extractor: 'Youtube' });
  assert.ok(low);
  assert.ok(s.queue.paused);
});

test('lookups, channel lists and Channel Watch', async () => {
  const s = setup();
  const prober = new Prober({ engine: s.engine, log: s.log });
  const v = await prober.lookup('https://www.youtube.com/watch?v=solo');
  assert.equal(v.kind, 'video');
  assert.deepEqual(v.heights, [1080, 720]);
  assert.equal(v.folder, 'Solo Channel');

  const list = await prober.lookup('https://www.example.com/channel/jimmy');
  assert.equal(list.kind, 'list');
  assert.equal(list.title, 'Jimmy The Lawn Guy');
  assert.equal(list.entries.length, 3);

  const watch = new Watch({ store: new JsonStore(path.join(s.tmp, 'watch.json'), { channels: [], lastRun: 0 }), prober, queue: s.queue, library: s.library, getSettings: () => s.settings, log: s.log });
  // Pretend the channel previously only had v1: v2 and v3 are "new".
  watch.add({ list: { ...list, entries: list.entries.filter((e) => e.id === 'v1') }, format: 'mp4', quality: '1080' });
  const n = await watch.checkAll();
  assert.equal(n, 2);
  const queued = s.queue.list().map((i) => i.title);
  assert.deepEqual(queued, ['Leaf Blower Showdown', 'Jimmy Cuts Grass'], 'oldest new upload first');
  assert.equal(await watch.checkAll(), 0, 'nothing new the second time');
  await waitFor(s.queue, settled);
});

test('a profile list with no uploader name uses the same folder as a single video from it', async () => {
  const s = setup();
  const prober = new Prober({ engine: s.engine, log: s.log });
  const single = await prober.lookup('https://www.example.com/video/a1');
  const list = await prober.lookup('https://www.example.com/anonlist/some_creator');
  assert.equal(single.folder, 'Some Creator');
  assert.equal(list.folder, 'Some Creator', 'never "Playlist"');
  assert.equal(list.title, 'Some Creator');
  assert.ok(list.entries.every((e) => e.folder === 'Some Creator'));
});

test('YouTube playlists put each video in its own uploader folder', async () => {
  const s = setup();
  const prober = new Prober({ engine: s.engine, log: s.log });
  const list = await prober.listFromInfo('https://www.youtube.com/playlist?list=PL1', { _type: 'playlist', title: 'Mix', extractor_key: 'YoutubeTab', entries: [
    { _type: 'url', ie_key: 'Youtube', id: 'x1', title: 'A', url: 'https://www.youtube.com/watch?v=x1', channel: 'Chan One' },
    { _type: 'url', ie_key: 'Youtube', id: 'x2', title: 'B', url: 'https://www.youtube.com/watch?v=x2', channel: 'Chan Two' }] }, {});
  assert.deepEqual(list.entries.map((e) => e.folder), ['Chan One', 'Chan Two']);
});

test('deleted files vanish from History and the list, and are forgotten', async () => {
  const s = setup();
  const { FolderSync } = require('../src/main/sync');
  const sync = new FolderSync({ getRoot: () => s.settings.folder, history: s.history, queue: s.queue, library: s.library, log: s.log });
  s.queue.add({ url: 'https://www.youtube.com/watch?v=v1', title: 'Jimmy Cuts Grass', folder: 'Jimmy', extractor: 'Youtube', videoId: 'v1', duration: 768 });
  s.queue.add({ url: 'https://www.youtube.com/watch?v=v3', title: 'Other One', folder: 'Jimmy', extractor: 'Youtube', videoId: 'v3', duration: 930 });
  const list = await waitFor(s.queue, settled);
  assert.equal(sync.run(), 0, 'nothing deleted yet');
  fs.unlinkSync(list.find((i) => i.videoId !== 'x' && i.title === 'Jimmy Cuts Grass').filePath);
  assert.equal(sync.run(), 2, 'one history entry + one list item');
  assert.deepEqual(s.history.all().map((h) => h.title), ['Other One']);
  assert.deepEqual(s.queue.list().map((i) => i.title), ['Other One']);
  assert.ok(!s.library.hasId('Youtube', 'v1'), 'deleted video counts as never downloaded');
  assert.ok(s.library.hasId('Youtube', 'v3'));
  // Whole folder deleted
  fs.rmSync(path.join(s.settings.folder, 'Jimmy'), { recursive: true });
  sync.run();
  assert.equal(s.history.all().length, 0);
  // Main folder missing (unplugged drive): nothing is touched
  s.history.add({ id: 'z', title: 'Z', filePath: path.join(s.settings.folder, 'A', 'z.mp4') }, 'done');
  fs.rmSync(s.settings.folder, { recursive: true });
  assert.equal(sync.run(), 0);
  assert.equal(s.history.all().length, 1);
});

test('private downloads never put their title in the log', async () => {
  const s = setup();
  const lines = [];
  s.log.info = (m) => lines.push(m); s.log.warn = (m) => lines.push(m); s.log.error = (m) => lines.push(m);
  s.queue.add({ url: 'https://www.youtube.com/watch?v=pv2', title: 'Very Secret Title', folder: 'Hidden Folder', extractor: 'Youtube', private: true });
  s.queue.add({ url: 'https://www.youtube.com/watch?v=fail9', title: 'Secret Failure', folder: 'Hidden Folder', extractor: 'Youtube', private: true });
  await waitFor(s.queue, settled);
  const all = lines.join('\n');
  assert.ok(!/Very Secret Title|Secret Failure|Hidden Folder|fail9/.test(all), all);
  assert.ok(/\[private download\]/.test(all));
});

test('auto-clear removes old finished items from the list only', async () => {
  const s = setup();
  s.queue.add({ url: 'https://www.youtube.com/watch?v=ac1', title: 'Old One', folder: 'A', extractor: 'Youtube' });
  await waitFor(s.queue, settled);
  s.queue.items[0].finishedAt = Date.now() - 3 * 86400e3;
  s.queue.clearOlderThan(86400e3);
  assert.equal(s.queue.list().length, 0);
  assert.equal(s.history.all().length, 1, 'History keeps it');
});

test('Channel Watch works with Page scan lists (no video IDs)', async () => {
  const s = setup();
  const prober = new Prober({ engine: s.engine, log: s.log });
  let page = [{ url: 'https://www.example.com/video/a1', title: 'Clip a1', folder: 'Some Creator' }];
  const scanList = async () => ({ kind: 'list', scanned: true, entries: page });
  const watch = new Watch({ store: new JsonStore(path.join(s.tmp, 'w.json'), { channels: [], lastRun: 0 }), prober, queue: s.queue, library: s.library, getSettings: () => s.settings, log: s.log, scanList });
  watch.add({ list: { url: 'https://www.example.com/maker/some', title: 'Some Creator', folder: 'Some Creator', site: 'SomeSite', scanned: true, entries: page }, format: 'mp4', quality: '1080' });
  assert.equal(await watch.checkAll(), 0);
  page = [{ url: 'https://www.example.com/video/a2', title: 'Clip a2' }, ...page];
  assert.equal(await watch.checkAll(), 1);
  assert.equal(s.queue.list()[0].folder, 'Some Creator');
  await waitFor(s.queue, settled);
});

test('a list whose videos have no uploader uses the name from the link, never the site name', async () => {
  const s = setup();
  const prober = new Prober({ engine: s.engine, log: s.log });
  const list = await prober.listFromInfo('https://www.example.com/maker/roberta_ruiva', { _type: 'playlist', extractor_key: 'SomeSite',
    entries: [{ _type: 'url', id: 'nouploader', url: 'https://www.example.com/video-nouploader/x' }] }, {});
  assert.equal(list.folder, 'Roberta Ruiva');
});

test('queued videos remember their folder for later single downloads', async () => {
  const s = setup();
  s.queue.add({ url: 'https://www.example.com/video-r1/clip', title: 'Clip', folder: 'Robertaruiva', extractor: 'Site', videoId: 'r1' });
  assert.equal(s.library.folderFor({ url: 'https://example.com/video-r1/clip' }), 'Robertaruiva');
  await waitFor(s.queue, settled);
});

const { Sites, toCookieFile, hostOf } = require('../src/main/sites');
function withSites(s) {
  const sites = new Sites({ store: new JsonStore(path.join(s.tmp, 'sites.json'), {}), dir: path.join(s.tmp, 'sites'), log: s.log });
  s.queue.sites = sites;
  return sites;
}

test('Cloudflare: lookup retries as a browser and remembers the site', async () => {
  const s = setup();
  const sites = withSites(s);
  const prober = new Prober({ engine: s.engine, log: s.log, sites });
  const v = await prober.lookup('https://www.cfblock-site.com/video/1');
  assert.equal(v.kind, 'video');
  assert.ok(sites.get('cfblock-site.com').impersonate, 'remembered');
  assert.ok(sites.argsFor('https://cfblock-site.com/other').includes('--impersonate'));
  assert.deepEqual(sites.argsFor('https://www.youtube.com/watch?v=x'), [], 'ordinary sites unchanged');
});

test('Cloudflare: a blocked download retries as a browser and finishes', async () => {
  const s = setup();
  withSites(s);
  s.queue.add({ url: 'https://www.cfblock-site.com/watch?v=cf1', title: 'Behind Cloudflare', folder: 'CF', extractor: 'Generic' });
  const list = await waitFor(s.queue, settled);
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
  assert.equal(list[0].attempts, 0, 'not counted as a failed attempt');
});

test('Cloudflare: strict sites need the pass; without it a clear message, with it the download works', async () => {
  const s = setup();
  const sites = withSites(s);
  s.queue.add({ url: 'https://www.cfstrict-site.com/watch?v=cs1', title: 'Strict', folder: 'CF', extractor: 'Generic' });
  let list = await waitFor(s.queue, settled);
  assert.equal(list[0].status, 'failed');
  assert.match(list[0].error, /Open the page/);
  assert.equal(list[0].attempts, 1, 'no pointless retries');
  // The user passes the check in the Open the page window; its cookies are saved for the site.
  const saved = sites.savePass('https://www.cfstrict-site.com/maker/x', [
    { name: 'cf_clearance', value: 'abc', domain: '.cfstrict-site.com', path: '/', secure: true, expirationDate: 2000000000 },
    { name: 'age_ok', value: '1', domain: 'www.cfstrict-site.com', hostOnly: true, path: '/' }
  ], 'Mozilla/5.0 Chrome/140');
  assert.ok(saved);
  const args = sites.argsFor('https://www.cfstrict-site.com/watch?v=cs1');
  assert.ok(args.includes('--cookies') && args.includes('--user-agent'));
  s.queue.retry(list[0].id);
  list = await waitFor(s.queue, (l) => l[0].status === 'done' || l[0].status === 'failed');
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
  sites.clearPasses();
  assert.ok(!sites.argsFor('https://www.cfstrict-site.com/x').includes('--cookies'), 'Clear history removes passes');
});

test('Cloudflare: no pass is saved for sites that never gave one', () => {
  const s = setup();
  const sites = withSites(s);
  assert.equal(sites.savePass('https://normal.com/x', [{ name: 'session', value: '1', domain: 'normal.com' }], 'UA'), false);
  assert.equal(sites.get('normal.com'), null);
  assert.equal(hostOf('https://www.Example.com/a'), 'example.com');
  const txt = toCookieFile([{ name: 'cf_clearance', value: 'v', domain: '.a.com', path: '/', secure: true, expirationDate: 123.9 }, { name: 'h', value: 'x', domain: 'a.com', hostOnly: true }]);
  assert.match(txt, /^# Netscape HTTP Cookie File/);
  assert.ok(txt.includes('.a.com\tTRUE\t/\tTRUE\t123\tcf_clearance\tv'));
  assert.ok(txt.includes('a.com\tFALSE\t/\tFALSE\t0\th\tx'));
});

test('Cloudflare: a bare 403 after the browser retry still counts as a block (the real case)', async () => {
  const s = setup();
  const sites = withSites(s);
  const prober = new Prober({ engine: s.engine, log: s.log, sites });
  let err;
  try { await prober.lookup('https://cfbare-site.net/channel/somechannel/'); } catch (e) { err = e; }
  assert.match(err.message, /HTTP Error 403: Forbidden/);
  assert.ok(sites.isBlocked('https://cfbare-site.net/channel/somechannel/', err.message), 'recognised as the site check');
  // a normal site's 403 is not treated as Cloudflare
  assert.ok(!sites.isBlocked('https://plain403.com/x', 'HTTP Error 403: Forbidden'));
  // downloads: fails once with the clear message (no pointless retries), then works with the pass
  s.queue.add({ url: 'https://cfbare-site.net/watch?v=b1', title: 'Bare', folder: 'CF', extractor: 'Generic' });
  let list = await waitFor(s.queue, settled);
  assert.equal(list[0].status, 'failed');
  assert.match(list[0].error, /Open the page/);
  assert.equal(list[0].attempts, 1);
  sites.savePass('https://cfbare-site.net/channel/somechannel/', [{ name: 'cf_clearance', value: 'ok', domain: '.cfbare-site.net', path: '/' }], 'UA');
  s.queue.retry(list[0].id);
  list = await waitFor(s.queue, (l) => ['done', 'failed'].includes(l[0].status));
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
});

test('a normal site\'s 403 keeps its normal handling', async () => {
  const s = setup({ retries: 0 });
  withSites(s);
  s.queue.add({ url: 'https://plain403.com/watch?v=p1', title: 'Plain', folder: 'P', extractor: 'Generic' });
  const list = await waitFor(s.queue, settled);
  assert.equal(list[0].status, 'failed');
  assert.doesNotMatch(list[0].error, /Cloudflare/);
});

// ---------- borrowing the "I'm human" pass from the user's own browser ----------
const browserpass = require('../src/main/browserpass');

test('browser pass: identity matches the user\'s browser version', async () => {
  const fx = await browserpass.browserIdentity('firefox', { query: async () => '145.0.1 (x64 en-US)' });
  assert.equal(fx.target, 'firefox');
  assert.equal(fx.ua, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0');
  const ch = await browserpass.browserIdentity('chrome', { query: async () => '143.0.7499.40' });
  assert.equal(ch.target, 'chrome');
  assert.match(ch.ua, /Chrome\/143\.0\.0\.0 Safari\/537\.36$/);
  const ed = await browserpass.browserIdentity('edge', { query: async () => null, chromeMajor: 142 });
  assert.match(ed.ua, /Chrome\/142\.0\.0\.0 Safari\/537\.36 Edg\/142\.0\.0\.0$/);
  // version unknown: Firefox is estimated from its 4-week release schedule
  assert.equal(browserpass.guessFirefoxMajor(Date.UTC(2025, 10, 11)), 145);
});

test('browser pass: keeps only that site\'s cookies, deletes the full export, downloads use it', async () => {
  const s = setup();
  const sites = withSites(s);
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('slimtakes-')).length;
  const cookies = await browserpass.exportBrowserCookies(s.engine, 'firefox', 'https://cfbare-site.net/channel/somechannel/');
  assert.deepEqual(cookies.map((c) => c.name).sort(), ['age_ok', 'cf_clearance']);
  assert.ok(cookies.find((c) => c.name === 'cf_clearance').httpOnly);
  assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('slimtakes-')).length, before, 'full browser export removed');
  const id = await browserpass.browserIdentity('firefox', { query: async () => '145.0' });
  sites.savePass('https://cfbare-site.net/channel/somechannel/', cookies, id.ua, { from: 'browser', target: id.target });
  assert.equal(sites.passFrom('https://cfbare-site.net/x'), 'browser');
  const args = sites.argsFor('https://cfbare-site.net/watch?v=1');
  assert.equal(args[args.indexOf('--impersonate') + 1], 'firefox');
  assert.equal(args[args.indexOf('--user-agent') + 1], id.ua);
  const file = fs.readFileSync(args[args.indexOf('--cookies') + 1], 'utf8');
  assert.match(file, /cf_clearance\tfrom-firefox/);
  assert.doesNotMatch(file, /secret-elsewhere/, 'other sites\' cookies are never kept');
  s.queue.add({ url: 'https://cfbare-site.net/watch?v=b2', title: 'Borrowed', folder: 'CF', extractor: 'Generic' });
  const list = await waitFor(s.queue, (l) => ['done', 'failed'].includes(l[0].status));
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
});

test('browser pass: clear messages when the browser can\'t help', async () => {
  const s = setup();
  await assert.rejects(browserpass.exportBrowserCookies(s.engine, 'chrome', 'https://cfbare-site.net/'), /locks its cookies.*Firefox works best/);
  await assert.rejects(browserpass.exportBrowserCookies(s.engine, 'edge', 'https://cfbare-site.net/'), /doesn't have an "I'm human" pass for this site yet/);
  await assert.rejects(browserpass.exportBrowserCookies(s.engine, 'netscape', 'https://cfbare-site.net/'), /Pick a browser/);
});

test('Cancel all: stops downloads, removes everything unfinished, keeps finished ones', async () => {
  const s = setup({ concurrent: 1 });
  s.queue.add({ url: 'https://www.youtube.com/watch?v=done1', title: 'Finished one', folder: 'F' });
  await waitFor(s.queue, (l) => l[0].status === 'done');
  for (let i = 0; i < 5; i++) s.queue.add({ url: `https://www.youtube.com/watch?v=slow${i}`, title: 'Slow ' + i, folder: 'F' });
  await waitFor(s.queue, (l) => l.some((x) => x.status === 'downloading'));
  assert.equal(s.queue.cancelAll(), 5);
  const list = await waitFor(s.queue, (l) => l.length === 1);
  assert.equal(list[0].title, 'Finished one');
  assert.equal(list[0].status, 'done');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(s.queue.list().length, 1, 'nothing new started afterwards');
});

test('a video page that comes back as a "list of one" is treated as that video', async () => {
  const s = setup();
  const prober = new Prober({ engine: s.engine, log: s.log });
  const r = await prober.lookup('https://www.example.com/video/123/oneembed-clip/');
  assert.equal(r.kind, 'video');
  assert.equal(r.title, 'Clip a7');
  // a channel with one video is still a channel
  const list = await prober.lookup('https://www.example.com/channel/oneembed-channel/');
  assert.equal(list.kind, 'list');
});

test('download, clear history, delete the file, paste it again: it downloads again', async () => {
  const s = setup();
  s.queue.add({ url: 'https://www.youtube.com/watch?v=again1', title: 'Again', folder: 'A', extractor: 'Youtube', videoId: 'again1' });
  let list = await waitFor(s.queue, (l) => l[0].status === 'done');
  const file = list[0].filePath;
  assert.ok(fs.existsSync(file));
  s.queue.clearFinished();      // nothing in the lists links to the file any more
  fs.rmSync(file);
  s.queue.add({ url: 'https://www.youtube.com/watch?v=again1', title: 'Again', folder: 'A', extractor: 'Youtube', videoId: 'again1' });
  list = await waitFor(s.queue, (l) => ['done', 'skipped', 'failed'].includes(l[0].status));
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
});

// ---------- sites that refuse the engine: videos come through the page window ----------
function pageWinSite(s, mediaUrls) {
  const sites = withSites(s);
  const page = 'https://pagewin-site.net/video/5338/some-clip-1711dd71/';
  sites.update('pagewin-site.net', { impersonate: true });
  sites.savePass(page, [{ name: 'cf_clearance', value: 'ok', domain: '.pagewin-site.net', path: '/' }], 'UA');
  const calls = [];
  s.queue.resolveDirect = async (url) => {
    calls.push(url);
    const mediaUrl = mediaUrls[Math.min(calls.length - 1, mediaUrls.length - 1)];
    return { mediaUrl, referer: url, ua: 'Mozilla/5.0 Chrome/142', cookieFile: sites.writeDirectCookies(url, [{ name: 'cf_clearance', value: 'ok', domain: '.pagewin-site.net', path: '/' }]) };
  };
  return { sites, page, calls };
}

test('site refuses the engine: the download comes through the page window, and later ones skip the engine', async () => {
  const s = setup();
  const { sites, page, calls } = pageWinSite(s, ['https://cdn.pagewin-media.net/v/abc_720p.mp4?needsreferer=1']);
  s.queue.add({ url: page, title: 'Some Clip', folder: 'Garden Collection', extractor: 'Generic', videoId: 'some-clip-1711dd71' });
  let list = await waitFor(s.queue, (l) => ['done', 'failed'].includes(l[0].status));
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
  assert.equal(calls.length, 1);
  assert.ok(sites.needsWindow(page), 'remembered for the site');
  assert.ok(s.library.hasId('Generic', 'some-clip-1711dd71'), 'counted under the video page\'s ID, not the file\'s');
  // the next video from that site goes straight to the page window
  s.queue.add({ url: 'https://pagewin-site.net/video/77/another/', title: 'Another', folder: 'Garden Collection', extractor: 'Generic', videoId: 'another' });
  list = await waitFor(s.queue, (l) => l.length === 2 && ['done', 'failed'].includes(l.find((x) => x.title === 'Another').status));
  assert.equal(list.find((x) => x.title === 'Another').status, 'done');
  assert.equal(calls.length, 2);
});

test('page window video link expired: gets a fresh one once, then says so plainly', async () => {
  const s = setup();
  const { page, calls } = pageWinSite(s, ['https://cdn.pagewin-media.net/v/expiredlink.mp4', 'https://cdn.pagewin-media.net/v/good_720p.mp4?needsreferer=1']);
  s.queue.add({ url: page, title: 'Expiring', folder: 'G', extractor: 'Generic', videoId: 'exp' });
  let list = await waitFor(s.queue, (l) => ['done', 'failed'].includes(l[0].status));
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
  assert.equal(calls.length, 2, 'fresh link fetched once');

  const s2 = setup();
  const p2 = pageWinSite(s2, ['https://cdn.pagewin-media.net/v/expiredlink.mp4']);
  s2.queue.add({ url: p2.page, title: 'Always Expired', folder: 'G', extractor: 'Generic', videoId: 'exp2' });
  list = await waitFor(s2.queue, (l) => ['done', 'failed', 'paused'].includes(l[0].status));
  assert.equal(list[0].status, 'paused', 'held for a fresh pass instead of failing');
  assert.ok(list[0].heldForPass);
  assert.match(list[0].error, /refused the video file too/i);
});

test('a video file from the page can\'t point the engine at files outside the app\'s own folder', () => {
  const s = setup();
  const sites = withSites(s);
  const args = sites.directArgs({ mediaUrl: 'https://cdn.x.net/v.mp4', referer: 'https://x.net/video/1', ua: 'UA', cookieFile: '/etc/passwd' });
  assert.ok(!args.includes('--cookies'), 'cookie files outside the app folder are ignored');
  assert.deepEqual(args.slice(0, 4), ['--referer', 'https://x.net/video/1', '--user-agent', 'UA']);
});


test('waiting for the page window doesn\'t take a download slot: other sites keep going', async () => {
  const s = setup({ concurrent: 1 });
  const { sites, calls } = pageWinSite(s, ['https://cdn.pagewin-media.net/v/a_720p.mp4?needsreferer=1']);
  sites.markNeedsWindow('https://pagewin-site.net/');
  const slow = s.queue.resolveDirect;
  s.queue.resolveDirect = async (url, o) => { await new Promise((r) => setTimeout(r, 700)); return slow(url, o); };
  s.queue.add({ url: 'https://pagewin-site.net/video/1/one/', title: 'One', folder: 'G', extractor: 'Generic' });
  s.queue.add({ url: 'https://pagewin-site.net/video/2/two/', title: 'Two', folder: 'G', extractor: 'Generic' });
  s.queue.add({ url: 'https://www.youtube.com/watch?v=meanwhile', title: 'Meanwhile', folder: 'Y', extractor: 'Youtube' });
  const order = [];
  s.queue.on('item', (it) => { if (it.status === 'done' && !order.includes(it.title)) order.push(it.title); });
  await waitFor(s.queue, (l) => l.length === 3 && l.every((x) => x.status === 'done'));
  assert.equal(order[0], 'Meanwhile', 'the other site didn\'t wait behind the page window: ' + order);
  assert.equal(calls.length, 2);
});

test('site check comes back: that site\'s downloads are held (one notice), then carry on after a fresh pass', async () => {
  const s = setup();
  const { calls } = pageWinSite(s, ['https://cdn.pagewin-media.net/v/a_720p.mp4?needsreferer=1']);
  const good = s.queue.resolveDirect;
  let refuse = true;
  s.queue.resolveDirect = async (url, o) => {
    if (refuse) { const e = new Error('The site\'s "are you human" check came up.'); e.siteCheck = true; throw e; }
    return good(url, o);
  };
  const notices = [];
  s.queue.on('needsPass', (n) => notices.push(n));
  for (let i = 1; i <= 3; i++) s.queue.add({ url: `https://pagewin-site.net/video/${i}/clip-${i}/`, title: 'Clip ' + i, folder: 'G', extractor: 'Generic' });
  s.queue.add({ url: 'https://www.youtube.com/watch?v=other', title: 'Other site', folder: 'Y', extractor: 'Youtube' });
  let list = await waitFor(s.queue, (l) => l.filter((x) => x.heldForPass).length === 3 && l.find((x) => x.title === 'Other site').status === 'done');
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(notices.length, 1, 'told once, not three times');
  assert.equal(notices[0].count, 3);
  assert.ok(list.filter((x) => x.heldForPass).every((x) => x.status === 'paused' && /fresh pass/.test(x.note)));
  // the user gets a fresh pass
  refuse = false;
  assert.equal(s.queue.releaseSite('https://pagewin-site.net/anything'), 3);
  list = await waitFor(s.queue, (l) => l.every((x) => x.status === 'done'));
  assert.ok(calls.length >= 3);
});

test('engine refused and no page-window route left: held, not failed; Retry really retries', async () => {
  const s = setup();
  const sites = withSites(s);
  s.queue.resolveDirect = async () => { throw new Error('Couldn\'t find the video on that page.'); };
  // no pass at all: blocked -> held straight away
  s.queue.add({ url: 'https://cfbare-site.net/watch?v=h1', title: 'Held', folder: 'CF', extractor: 'Generic' });
  let list = await waitFor(s.queue, (l) => l[0].status === 'paused' || l[0].status === 'failed');
  assert.equal(list[0].status, 'paused');
  assert.ok(list[0].heldForPass);
  // pass arrives; Retry goes through normally
  sites.savePass('https://cfbare-site.net/', [{ name: 'cf_clearance', value: 'ok', domain: '.cfbare-site.net', path: '/' }], 'UA');
  s.queue.retry(list[0].id);
  list = await waitFor(s.queue, (l) => l[0].status === 'done' || l[0].status === 'paused' || l[0].status === 'failed');
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
});

test('page window can\'t find the video: the engine gets one go instead', async () => {
  const s = setup();
  const sites = withSites(s);
  sites.markNeedsWindow('https://www.youtube.com/');
  let calls = 0;
  s.queue.resolveDirect = async () => { calls++; throw new Error('Couldn\'t find the video on that page.'); };
  s.queue.add({ url: 'https://www.youtube.com/watch?v=fallback1', title: 'Fallback', folder: 'Y', extractor: 'Youtube' });
  const list = await waitFor(s.queue, (l) => ['done', 'failed', 'paused'].includes(l[0].status));
  assert.equal(list[0].status, 'done');
  assert.equal(calls, 1);
});

test('a video link from the page that has gone stale is refreshed before downloading', async () => {
  const s = setup();
  const { calls, sites } = pageWinSite(s, ['https://cdn.pagewin-media.net/v/fresh_720p.mp4?needsreferer=1']);
  const old = { mediaUrl: 'https://cdn.pagewin-media.net/v/old.mp4?needsreferer=1', referer: 'https://pagewin-site.net/video/9/x/', ua: 'UA', cookieFile: null, at: Date.now() - 2 * 3600 * 1000 };
  s.queue.add({ url: 'https://pagewin-site.net/video/9/x/', title: 'Stale', folder: 'G', extractor: 'Generic', direct: old });
  const list = await waitFor(s.queue, (l) => ['done', 'failed', 'paused'].includes(l[0].status));
  assert.equal(list[0].status, 'done');
  assert.equal(calls.length, 1, 'fetched a fresh link first');
  assert.ok(sites);
});

// ---------- v1.2.4 stress tests: the page-window route for sites the engine doesn't know ----------
function unknownSite(s, { media = 'https://cdn.mediahost.example/v/main_720p.mp4', info = {}, delay = 0, fail = null } = {}) {
  const sites = withSites(s);
  sites.markNeedsWindow('https://unknownsite.example/');
  const calls = [];
  let running = 0, peak = 0;
  s.queue.resolveDirect = async (url) => {
    calls.push(url);
    running++; peak = Math.max(peak, running);
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (fail) { const e = fail(url, calls.length); if (e) throw e; }
      const id = url.split('/').filter(Boolean).pop();
      return { mediaUrl: typeof media === 'function' ? media(url) : media, referer: url, ua: 'UA', cookieFile: null,
        info: { title: info.title === undefined ? 'Real Title ' + id : info.title, duration: info.duration || null, thumbnail: null } };
    } finally { running--; }
  };
  return { sites, calls, peak: () => peak };
}

test('unknown site: code-like titles become the page\'s real title, and the length is filled in', async () => {
  const s = setup();
  unknownSite(s, { info: { title: 'Jimmy Cuts Grass Again', duration: 61 } });
  s.queue.add({ url: 'https://unknownsite.example/watch/aPmEvq2pjlW', title: 'aPmEvq2pjlW', folder: 'Jimmy The Lawn Guy', extractor: 'Generic' });
  s.queue.add({ url: 'https://unknownsite.example/watch/keepme', title: 'A Proper Title', folder: 'Jimmy The Lawn Guy', extractor: 'Generic' });
  const list = await waitFor(s.queue, (l) => l.every((x) => ['done', 'failed'].includes(x.status)));
  const a = list.find((x) => /aPmEvq2pjlW/.test(x.url));
  assert.equal(a.status, 'done');
  assert.equal(a.title, 'Jimmy Cuts Grass Again');
  assert.match(a.filePath, /Jimmy The Lawn Guy[\\/]Jimmy Cuts Grass Again\.mp4$/);
  assert.equal(list.find((x) => /keepme/.test(x.url)).title, 'A Proper Title', 'real titles are left alone');
});

test('unknown site: a short preview instead of the full video is flagged, not quietly called done', async () => {
  const s = setup();
  unknownSite(s, { media: 'https://cdn.mediahost.example/v/longpreview.mp4', info: { title: 'Long Video', duration: 1800 } });
  s.queue.add({ url: 'https://unknownsite.example/watch/long1', title: 'Long Video', folder: 'F', extractor: 'Generic' });
  await waitFor(s.queue, (l) => l[0].status === 'done');
  const list = await waitFor(s.queue, (l) => l[0].previewOnly, 3000);
  assert.match(list[0].note, /preview only/);
});

test('unknown site: copy-protected or login-only videos fail straight away with a clear reason (no engine attempt)', async () => {
  const s = setup();
  unknownSite(s, { fail: (url) => Object.assign(new Error(/drm/.test(url) ? 'This video is copy-protected (DRM), so it can\'t be downloaded.' : 'This video needs you to be logged in on the site, so Slim Takes can\'t get it.'), { final: true }) });
  s.queue.add({ url: 'https://unknownsite.example/watch/drm1', title: 'Protected', folder: 'F', extractor: 'Generic' });
  s.queue.add({ url: 'https://unknownsite.example/watch/members1', title: 'Members', folder: 'F', extractor: 'Generic' });
  const list = await waitFor(s.queue, (l) => l.every((x) => x.status === 'failed'));
  assert.match(list.find((x) => x.title === 'Protected').error, /copy-protected/);
  assert.match(list.find((x) => x.title === 'Members').error, /logged in/);
});

test('unknown site: page window finds nothing and the engine doesn\'t know the site: the window\'s reason is shown', async () => {
  const s = setup();
  const sites = withSites(s);
  sites.markNeedsWindow('https://unknownsite.example/');
  s.queue.resolveDirect = async () => { throw new Error('Couldn\'t find the video on that page.'); };
  s.queue.add({ url: 'https://unknownsite.example/watch/nothing', title: 'Nothing', folder: 'F', extractor: 'Generic' });
  const list = await waitFor(s.queue, (l) => ['failed', 'done'].includes(l[0].status));
  assert.equal(list[0].status, 'failed');
  assert.match(list[0].error, /Couldn't find the video/);
});

test('rate limits: the site\'s downloads wait, then carry on by themselves (page window and engine)', async () => {
  const s = setup();
  s.queue.slowDownMs = 400;
  let refused = 0;
  unknownSite(s, { fail: () => (refused++ < 1 ? Object.assign(new Error('The site asked Slim Takes to slow down (too many requests).'), { rateLimited: true }) : null) });
  for (let i = 0; i < 3; i++) s.queue.add({ url: `https://unknownsite.example/watch/r${i}`, title: 'R ' + i, folder: 'F', extractor: 'Generic' });
  await waitFor(s.queue, (l) => l.some((x) => /slow down/.test(x.note || '')));
  const list = await waitFor(s.queue, (l) => l.every((x) => x.status === 'done'), 15000);
  assert.equal(list.length, 3);
  // the engine saying 429
  const s2 = setup({ retries: 3 });
  withSites(s2);
  s2.queue.slowDownMs = 60000;
  s2.queue.resolveDirect = async () => ({ mediaUrl: 'x' });
  s2.queue.add({ url: 'https://www.example.com/watch?v=ratelimited', title: 'Busy', folder: 'F', extractor: 'Generic' });
  const l2 = await waitFor(s2.queue, (l) => l[0].status === 'paused' || l[0].status === 'failed');
  assert.equal(l2[0].status, 'paused');
  assert.match(l2[0].note, /slow down/);
  assert.equal(l2[0].attempts, 1, 'no pointless quick retries');
});

test('stress: two page-window lookups at once, never more; other sites keep downloading meanwhile', async () => {
  const s = setup({ concurrent: 3 });
  const u = unknownSite(s, { delay: 120 });
  for (let i = 0; i < 12; i++) s.queue.add({ url: `https://unknownsite.example/watch/p${i}`, title: 'P ' + i, folder: 'F', extractor: 'Generic' });
  for (let i = 0; i < 4; i++) s.queue.add({ url: `https://www.youtube.com/watch?v=yt${i}`, title: 'YT ' + i, folder: 'Y', extractor: 'Youtube' });
  const t0 = Date.now();
  const list = await waitFor(s.queue, (l) => l.length === 16 && l.every((x) => x.status === 'done'), 30000);
  assert.equal(u.peak(), 2, 'two page-window lookups at once at most');
  assert.equal(u.calls.length, 12);
  assert.ok(Date.now() - t0 < 12 * 120, 'faster than one at a time');
  assert.equal(s.queue.resolvingNow, 0, 'nothing left counted as running');
  assert.ok(list.filter((x) => /YT/.test(x.title)).every((x) => x.status === 'done'));
});

test('stress: 150 videos through the page window with pause, resume and cancel in the middle', async () => {
  const s = setup({ concurrent: 4 });
  unknownSite(s, { delay: 3 });
  for (let i = 0; i < 150; i++) s.queue.add({ url: `https://unknownsite.example/watch/bulk${i}`, title: 'Bulk ' + i, folder: 'Bulk', extractor: 'Generic' });
  await waitFor(s.queue, (l) => l.filter((x) => x.status === 'done').length >= 20, 30000);
  s.queue.pauseAll();
  await new Promise((r) => setTimeout(r, 300));
  const pausedAt = s.queue.list().filter((x) => x.status === 'done').length;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(s.queue.list().filter((x) => x.status === 'done').length <= pausedAt + 4, 'pause stops new downloads');
  s.queue.resumeAll();
  await waitFor(s.queue, (l) => l.filter((x) => x.status === 'done').length >= 80, 30000);
  const canceled = s.queue.cancelAll();
  assert.ok(canceled > 0);
  const list = await waitFor(s.queue, (l) => l.every((x) => x.status === 'done'), 15000);
  assert.ok(list.length >= 80 && list.length < 150, `kept ${list.length} finished`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.queue.resolvingNow, 0, 'no page-window lookups left hanging');
  assert.ok(s.queue.list().every((x) => x.status === 'done'), 'nothing new started after Cancel all');
  const names = new Set(list.map((x) => x.filePath));
  assert.equal(names.size, list.length, 'every file got its own name');
});

test('stress: a restart mid-way keeps page-window downloads (but not half-finished lookups)', async () => {
  const s = setup({ concurrent: 1 });
  unknownSite(s, { delay: 200 });
  for (let i = 0; i < 4; i++) s.queue.add({ url: `https://unknownsite.example/watch/rs${i}`, title: 'RS ' + i, folder: 'F', extractor: 'Generic' });
  await new Promise((r) => setTimeout(r, 100));
  s.queue.persist();
  const saved = s.queue.store.get();
  assert.ok(saved.length >= 3);
  assert.ok(saved.every((x) => x.resolving === undefined), 'a lookup in progress is not saved as running');
});
