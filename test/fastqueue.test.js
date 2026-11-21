'use strict';
// The queue + the multi-connection downloader together, against a local server that slows each
// connection down, with real ffmpeg for the format conversions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, 'fake-bin');
for (const f of fs.readdirSync(BIN)) fs.chmodSync(path.join(BIN, f), 0o755);
process.env.SLIMTAKE_BIN = BIN;

const { Engine } = require('../src/main/engine');
const { Library } = require('../src/main/library');
const { Queue } = require('../src/main/queue');
const { History } = require('../src/main/history');
const { Sites } = require('../src/main/sites');
const { JsonStore } = require('../src/main/util');
const settingsMod = require('../src/main/settings');
const { buildArgs } = require('../src/main/formats');
const { serve, videoBytes, sha, MB } = require('./helpers/server');

const REAL_FFMPEG = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const REAL_FFPROBE = ['/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((p) => fs.existsSync(p));

function setup(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fq-'));
  process.env.FAKE_STATE_DIR = tmp;
  const log = { lines: [], info(m) { this.lines.push(m); }, warn(m) { this.lines.push(m); }, error(m) { this.lines.push(m); } };
  const settings = { ...settingsMod.defaults(tmp), polite: false, retries: 2, minFreeGB: 0, connections: 4, ...extra };
  const engine = new Engine({ dir: tmp, log });
  const library = new Library({ storeFile: path.join(tmp, 'lib.json'), probeDuration: async () => null, log });
  const history = new History(new JsonStore(path.join(tmp, 'history.json'), []));
  const sites = new Sites({ store: new JsonStore(path.join(tmp, 'sites.json'), {}), dir: path.join(tmp, 'sites'), log });
  const queue = new Queue({ engine, library, getSettings: () => settings, log, history, sites, store: new JsonStore(path.join(tmp, 'queue.json'), []),
    notify: { done() {}, failed() {} } });
  return { tmp, settings, queue, sites, log };
}
function waitFor(queue, pred, ms = 60000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out: ' + JSON.stringify(queue.list().map((i) => [i.title, i.status, i.note, i.error])))), ms);
    const check = () => { if (pred(queue.list())) { clearTimeout(t); queue.off('item', check); queue.off('list', check); resolve(queue.list()); } };
    queue.on('item', check); queue.on('list', check); check();
  });
}
const direct = (base, file = '/v.mp4', extra = {}) => ({ mediaUrl: base + file, referer: base + '/video/1', ua: 'Mozilla/5.0 Test', cookieFile: null, ...extra });
const finished = (l) => l.every((x) => ['done', 'failed', 'paused', 'canceled'].includes(x.status));
const filesIn = (dir) => { try { return fs.readdirSync(dir).map((f) => path.join(dir, f)); } catch { return []; } };

test('a throttled site: the video comes down over 4 connections, much faster, byte-for-byte right', async () => {
  const file = videoBytes(24 * MB);
  const srv = await serve(file, { throttle: 64 * 1024 });
  try {
    const a = setup({ connections: 1 });
    a.queue.add({ url: 'https://slow.example/video/1', title: 'One Connection', folder: 'S', extractor: 'Generic', direct: direct(srv.base) });
    let t = Date.now();
    // connections: 1 means the engine route (the old way): use the downloader directly for the comparison
    const { fastGet } = require('../src/main/fastget');
    await fastGet(srv.base + '/v.mp4', path.join(a.tmp, 'single.mp4'), { connections: 1 });
    const single = Date.now() - t;
    a.queue.cancelAll();

    const s = setup();
    t = Date.now();
    s.queue.add({ url: 'https://slow.example/video/1', title: 'Fast One', folder: 'S', extractor: 'Generic', direct: direct(srv.base) });
    const list = await waitFor(s.queue, finished);
    const multi = Date.now() - t;
    assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
    assert.equal(sha(fs.readFileSync(list[0].filePath)), sha(file), 'identical file');
    assert.match(list[0].filePath, /Fast One\.mp4$/);
    assert.ok(multi * 2.5 < single, `queue with 4 connections: ${multi} ms vs one connection: ${single} ms`);
    assert.deepEqual(filesIn(path.join(s.settings.folder, 'S')).filter((f) => /part/.test(f)), [], 'no leftover pieces');
  } finally { srv.server.close(); }
});

test('formats: MKV and MOV repackaged, MP3 sound taken out (real ffmpeg), all playable', { skip: !REAL_FFMPEG && 'no ffmpeg here' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fqv-'));
  const src = path.join(tmp, 'real.mp4');
  execFileSync(REAL_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', src]);
  const bytes = fs.readFileSync(src);
  const srv = await serve(Buffer.concat([bytes, Buffer.alloc(0)]), { throttle: 256 * 1024 });
  try {
    const s = setup();
    for (const fmt of ['mkv', 'mov', 'mp3', 'mp4']) {
      s.queue.add({ url: 'https://slow.example/video/' + fmt, title: 'Clip ' + fmt, folder: 'F', extractor: 'Generic', format: fmt, direct: direct(srv.base) });
    }
    const list = await waitFor(s.queue, finished, 120000);
    for (const it of list) {
      assert.equal(it.status, 'done', JSON.stringify(it));
      const ext = it.filePath.split('.').pop();
      if (REAL_FFPROBE) {
        const streams = execFileSync(REAL_FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', it.filePath]).toString().trim().split(/\s+/);
        if (ext === 'mp3') assert.deepEqual(streams, ['audio'], 'mp3 is sound only');
        else assert.ok(streams.includes('video') && streams.includes('audio'), ext + ' has picture and sound');
      }
    }
    assert.deepEqual(list.map((x) => x.filePath.split('.').pop()).sort(), ['mkv', 'mov', 'mp3', 'mp4']);
  } finally { srv.server.close(); }
});

test('stress: 12 videos from a throttled site, 3 at once x 4 connections, all correct, nothing left over', async () => {
  const files = Array.from({ length: 12 }, (_, i) => videoBytes((6 + (i % 4) * 5) * MB + i, i + 1));
  const servers = await Promise.all(files.map((f) => serve(f, { throttle: 512 * 1024 })));
  try {
    const s = setup({ concurrent: 3 });
    files.forEach((f, i) => s.queue.add({ url: `https://slow.example/video/s${i}`, title: 'Stress ' + i, folder: 'ST', extractor: 'Generic', direct: direct(servers[i].base) }));
    const list = await waitFor(s.queue, finished, 180000);
    list.forEach((it, i) => {
      assert.equal(it.status, 'done', JSON.stringify(it));
      const n = Number(it.title.split(' ')[1]);
      assert.equal(sha(fs.readFileSync(it.filePath)), sha(files[n]), 'file ' + n);
    });
    assert.ok(filesIn(path.join(s.settings.folder, 'ST')).every((f) => /\.mp4$/.test(f)), 'only finished videos in the folder');
    const peakTotal = servers.reduce((n, x) => n + x.stats.peak, 0);
    assert.ok(peakTotal <= 12 * 4, 'never more than 4 connections per video');
  } finally { servers.forEach((x) => x.server.close()); }
});

test('pause in the middle keeps what\'s done, resume carries on from there; cancel and remove leave nothing behind', async () => {
  const file = videoBytes(30 * MB);
  const srv = await serve(file, { throttle: 64 * 1024 });
  try {
    const s = setup();
    s.queue.add({ url: 'https://slow.example/video/p', title: 'Paused', folder: 'P', extractor: 'Generic', direct: direct(srv.base) });
    await waitFor(s.queue, (l) => l[0].status === 'downloading' && l[0].downloaded > 14 * MB);
    s.queue.pause(s.queue.items[0].id);
    let list = await waitFor(s.queue, (l) => l[0].status === 'paused');
    const kept = filesIn(path.join(s.settings.folder, 'P'));
    assert.ok(kept.some((f) => /Paused\.fast\.part$/.test(f)) && kept.some((f) => /Paused\.fast\.part\.json$/.test(f)), 'kept for carrying on: ' + kept);
    srv.stats.bytes = 0;
    s.queue.resume(s.queue.items[0].id);
    list = await waitFor(s.queue, finished);
    assert.equal(list[0].status, 'done');
    assert.equal(sha(fs.readFileSync(list[0].filePath)), sha(file));
    assert.ok(srv.stats.bytes < 26 * MB, 'only the rest came down after resuming: ' + srv.stats.bytes);
    assert.ok(s.log.lines.some((l) => /carrying on from \d+ MB/.test(l)));
    assert.deepEqual(filesIn(path.join(s.settings.folder, 'P')).filter((f) => /part/.test(f)), [], 'nothing left once finished');

    // Canceled while downloading: everything goes.
    s.queue.add({ url: 'https://slow.example/video/c', title: 'Canceled', folder: 'P', extractor: 'Generic', direct: direct(srv.base) });
    await waitFor(s.queue, (l) => l.some((x) => x.title === 'Canceled' && x.status === 'downloading' && x.downloaded > 6 * MB));
    s.queue.cancelAll();
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(!filesIn(path.join(s.settings.folder, 'P')).some((f) => /Canceled/.test(f)), 'nothing left from the canceled one');

    // Paused, then taken off the list: the kept half goes too.
    s.queue.add({ url: 'https://slow.example/video/r', title: 'Removed', folder: 'P', extractor: 'Generic', direct: direct(srv.base) });
    await waitFor(s.queue, (l) => l.some((x) => x.title === 'Removed' && x.status === 'downloading' && x.downloaded > 9 * MB));
    const rid = s.queue.items.find((x) => x.title === 'Removed').id;
    s.queue.pause(rid);
    await waitFor(s.queue, (l) => l.find((x) => x.title === 'Removed').status === 'paused');
    assert.ok(filesIn(path.join(s.settings.folder, 'P')).some((f) => /Removed\.fast\.part/.test(f)));
    s.queue.remove(rid);
    assert.ok(!filesIn(path.join(s.settings.folder, 'P')).some((f) => /Removed/.test(f)), 'removed: nothing left');
  } finally { srv.server.close(); }
});

test('closing the app mid-download, then starting again: carries on (with a fresh link from the page)', async () => {
  const file = videoBytes(30 * MB);
  const srv = await serve(file, { throttle: 64 * 1024, tokens: true });
  try {
    const s = setup();
    s.queue.add({ url: 'https://slow.example/video/q', title: 'Quit Midway', folder: 'Q', extractor: 'Generic', direct: direct(srv.base, '/v.mp4?t=a') });
    await waitFor(s.queue, (l) => l[0].status === 'downloading' && l[0].downloaded > 14 * MB);
    s.queue.stopAllForQuit();
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(filesIn(path.join(s.settings.folder, 'Q')).some((f) => /\.fast\.part\.json$/.test(f)), 'progress kept on quit');
    // Next start: the old link has expired; the page gives a new one.
    srv.stats.tokens.delete('a');
    const t = new Queue({ engine: s.queue.engine, library: s.queue.library, getSettings: () => s.settings, log: s.log, history: s.queue.history, sites: s.sites,
      store: new JsonStore(path.join(s.tmp, 'queue.json'), []), notify: { done() {}, failed() {} },
      resolveDirect: async (url) => ({ mediaUrl: srv.base + '/v.mp4?t=b', referer: url, ua: 'UA', cookieFile: null }) });
    assert.equal(t.items.length, 1, 'restored');
    t.items[0].direct.at = 0; // the saved link is old by now
    srv.stats.bytes = 0;
    t.pump();
    const list = await waitFor(t, finished);
    assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
    assert.equal(sha(fs.readFileSync(list[0].filePath)), sha(file));
    assert.ok(srv.stats.bytes < 26 * MB, 'carried on instead of starting over: ' + srv.stats.bytes);
  } finally { srv.server.close(); }
});

test('the link expires during the download: the page window is asked for a fresh one and it carries on', async () => {
  const file = videoBytes(24 * MB);
  const srv = await serve(file, { tokens: true, expireAfter: 2, throttle: 128 * 1024 });
  try {
    const s = setup();
    let asked = 0;
    s.queue.resolveDirect = async (url) => { asked++; return { mediaUrl: srv.base + '/v.mp4?t=b', referer: url, ua: 'UA', cookieFile: null }; };
    s.queue.add({ url: 'https://slow.example/video/e', title: 'Expiring', folder: 'E', extractor: 'Generic', direct: direct(srv.base, '/v.mp4?t=a') });
    const list = await waitFor(s.queue, finished);
    assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
    assert.equal(asked, 1);
    assert.equal(sha(fs.readFileSync(list[0].filePath)), sha(file));
    assert.ok(srv.stats.bytes < file.length * 1.4);
  } finally { srv.server.close(); }
});

test('a site that allows 2 connections: learned once, remembered, the next video starts at 2 with no refusals', async () => {
  const srv = await serve(videoBytes(16 * MB), { maxConns: 2, throttle: 128 * 1024 });
  try {
    require('../src/main/fastget').resetPools();
    const s = setup({ connections: 16 });
    s.queue.add({ url: 'https://slow.example/video/l1', title: 'Learn', folder: 'L', extractor: 'Generic', direct: direct(srv.base) });
    await waitFor(s.queue, finished);
    const server = new URL(srv.base).host;
    assert.equal(s.sites.fastLimit(server), 2);
    // A new run of the app (nothing in memory), same site.
    require('../src/main/fastget').resetPools();
    srv.stats.refused = 0;
    s.queue.add({ url: 'https://slow.example/video/l2', title: 'Remembered', folder: 'L', extractor: 'Generic', direct: direct(srv.base) });
    const list = await waitFor(s.queue, finished);
    assert.ok(list.every((x) => x.status === 'done'));
    assert.equal(srv.stats.refused, 0, 'no refusals the second time');
    assert.ok(s.log.lines.some((l) => /MB\/s, 2 connections at once/.test(l)), s.log.lines.join('\n'));
  } finally { srv.server.close(); }
});

test('another server from the page with the same file is used too; a different one isn\'t', async () => {
  const file = videoBytes(20 * MB);
  const a = await serve(file, { throttle: 48 * 1024, maxConns: 2 });
  const b = await serve(file, { throttle: 48 * 1024, maxConns: 2 });
  const preview = await serve(videoBytes(3 * MB));
  try {
    const s = setup();
    s.queue.add({ url: 'https://slow.example/video/m', title: 'Two Servers', folder: 'M', extractor: 'Generic', direct: direct(a.base, '/v.mp4', { alternates: [preview.base + '/v.mp4', b.base + '/v.mp4'] }) });
    const list = await waitFor(s.queue, finished);
    assert.equal(list[0].status, 'done');
    assert.equal(sha(fs.readFileSync(list[0].filePath)), sha(file));
    assert.ok(s.log.lines.some((l) => /from 2 servers/.test(l)), s.log.lines.join('\n'));
    assert.ok(b.stats.bytes > 2 * MB, 'the second server really sent part of it');
  } finally { a.server.close(); b.server.close(); preview.server.close(); }
});

test('a channel from a 2-connection video server (8 videos, 3 at once): all finish, none fail, no old-engine fallbacks, site not held', async () => {
  require('../src/main/fastget').resetPools();
  const files = Array.from({ length: 8 }, (_, i) => videoBytes((9 + i) * MB + i, i + 1));
  const http = require('http');
  const servers = await Promise.all(files.map((f) => serve(f, { throttle: 192 * 1024 })));
  const shared = { open: 0, refused: 0, peak: 0 };
  const proxy = http.createServer((req, res) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('f'));
    if (shared.open >= 2) { shared.refused++; res.writeHead(503); return res.end(); }
    shared.open++; shared.peak = Math.max(shared.peak, shared.open);
    let closed = false;
    const done = () => { if (!closed) { closed = true; shared.open--; } };
    res.on('close', done);
    http.get(servers[n].base + '/v.mp4', { headers: req.headers.range ? { range: req.headers.range } : {} }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); up.on('end', done); });
  });
  await new Promise((r) => proxy.listen(0, r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const s = setup({ concurrent: 3, connections: 8 });
    let mostAtOnce = 0, lateMost = 0, doneCount = 0;
    s.queue.on('item', () => {
      const l = s.queue.list();
      const n = l.filter((x) => x.status === 'downloading').length;
      mostAtOnce = Math.max(mostAtOnce, n);
      doneCount = l.filter((x) => x.status === 'done').length;
      if (doneCount >= 2) lateMost = Math.max(lateMost, n);
    });
    files.forEach((f, i) => s.queue.add({ url: `https://tube.example/watch/v${i}`, title: 'Chan ' + i, folder: 'C', extractor: 'Generic', direct: direct(base, `/v.mp4?f=${i}`) }));
    const list = await waitFor(s.queue, finished, 240000);
    list.forEach((it) => {
      assert.equal(it.status, 'done', JSON.stringify(it));
      const n = Number(it.title.split(' ')[1]);
      assert.equal(sha(fs.readFileSync(it.filePath)), sha(files[n]), 'file ' + n);
    });
    assert.ok(!s.log.lines.some((l) => /using the engine instead|Failed:/.test(l)), s.log.lines.filter((l) => /engine instead|Failed/.test(l)).join('\n'));
    assert.equal(s.queue.heldHosts.size, 0, 'the site was never held');
    assert.ok(lateMost <= 2, 'once the limit was known, no more than 2 ran at once from that server: ' + lateMost);
  } finally { proxy.close(); servers.forEach((x) => x.server.close()); }
});

test('the video server stays busy: the download waits, tries again later, keeps what\'s done; the site isn\'t held', async () => {
  require('../src/main/fastget').resetPools();
  const file = videoBytes(20 * MB);
  const srv = await serve(file, { throttle: 64 * 1024 });
  try {
    const s = setup();
    s.queue.busyMaxMs = 1500;
    s.queue.add({ url: 'https://tube.example/watch/busy', title: 'Busy One', folder: 'B', extractor: 'Generic', direct: direct(srv.base) });
    await waitFor(s.queue, (l) => l[0].status === 'downloading' && l[0].downloaded > 9 * MB);
    // From now on the server says "busy" to everything.
    srv.opts.busyFor = 1e9; srv.stats.born = Date.now();
    await waitFor(s.queue, (l) => /video server is busy/.test(l[0].note || ''), 60000);
    const it = s.queue.list()[0];
    assert.equal(it.status, 'waiting');
    assert.equal(s.queue.heldHosts.size, 0);
    assert.ok(filesIn(path.join(s.settings.folder, 'B')).some((f) => /\.fast\.part\.json$/.test(f)), 'what\'s done is kept');
    assert.ok(s.log.lines.some((l) => /video server is busy, trying again/.test(l)));
  } finally { srv.server.close(); }
});

test('the old engine way gets "503 busy" for a page\'s video file: tries again later instead of failing', async () => {
  const s = setup({ connections: 1 });
  s.queue.add({ url: 'https://tube.example/watch/e503', title: 'Engine Busy', folder: 'E', extractor: 'Generic', direct: { mediaUrl: 'https://cdn.example/busy503/v.mp4', referer: 'https://tube.example/watch/e503', ua: 'UA', cookieFile: null } });
  await waitFor(s.queue, (l) => /video server is busy/.test(l[0].note || ''));
  assert.equal(s.queue.list()[0].status, 'waiting');
  assert.equal(s.queue.heldHosts.size, 0);
  s.queue.cancelAll();
});

test('settings saved by older versions: 4 connections (the old default) becomes 8; a choice of 2 is kept', () => {
  const up = settingsMod.upgrade({ ...settingsMod.defaults('/v'), connections: 4 });
  assert.equal(up.connections, 8);
  assert.equal(settingsMod.upgrade({ ...settingsMod.defaults('/v'), connections: 2 }).connections, 2);
  assert.equal(settingsMod.upgrade(up), null, 'only once');
});

test('a site that refuses split downloads still works (one connection), and a dead connection falls back to the engine', async () => {
  const file = videoBytes(12 * MB);
  const srv = await serve(file, { noRanges: true });
  try {
    const s = setup();
    s.queue.add({ url: 'https://slow.example/video/n', title: 'No Ranges', folder: 'N', extractor: 'Generic', direct: direct(srv.base) });
    s.queue.add({ url: 'https://slow.example/video/dead', title: 'Dead Link', folder: 'N', extractor: 'Generic', direct: direct('http://127.0.0.1:1', '/v.mp4') });
    const list = await waitFor(s.queue, finished);
    const nr = list.find((x) => x.title === 'No Ranges');
    assert.equal(nr.status, 'done');
    assert.equal(sha(fs.readFileSync(nr.filePath)), sha(file));
    const dead = list.find((x) => x.title === 'Dead Link');
    assert.equal(dead.status, 'done', 'fell back to the engine (the test engine downloads anything)');
    assert.ok(s.log.lines.some((l) => /using the engine instead/.test(l)));
  } finally { srv.server.close(); }
});

test('a web page instead of the video, or a refused link: handled like before (fresh link / stop the site)', async () => {
  const html = await serve(Buffer.alloc(0), { html: true });
  const file = videoBytes(9 * MB);
  const good = await serve(file);
  try {
    const s = setup();
    let n = 0;
    s.queue.resolveDirect = async (url) => ({ mediaUrl: good.base + '/v.mp4', referer: url, ua: 'UA', cookieFile: null, n: ++n });
    s.queue.add({ url: 'https://slow.example/video/h', title: 'Got A Page', folder: 'H', extractor: 'Generic', direct: direct(html.base) });
    const list = await waitFor(s.queue, finished);
    assert.equal(list[0].status, 'done', 'the web page was refused, a fresh link was used: ' + JSON.stringify(list[0]));
    assert.equal(n, 1);
    assert.equal(sha(fs.readFileSync(list[0].filePath)), sha(file));
  } finally { html.server.close(); good.server.close(); }
});

test('with a speed limit set, downloads go the engine way (the limit is respected)', async () => {
  const srv = await serve(videoBytes(9 * MB));
  try {
    const s = setup({ speedLimitMB: 5 });
    s.queue.add({ url: 'https://slow.example/video/l', title: 'Limited', folder: 'L', extractor: 'Generic', direct: direct(srv.base) });
    const list = await waitFor(s.queue, finished);
    assert.equal(list[0].status, 'done');
    assert.equal(srv.stats.requests, 0, 'the multi-connection downloader wasn\'t used');
  } finally { srv.server.close(); }
});

test('cookies saved for the site are sent with every part', async () => {
  const file = videoBytes(10 * MB);
  const srv = await serve(file, { needHeaders: true });
  try {
    const s = setup();
    const cookieFile = s.sites.writeDirectCookies(srv.base + '/', [{ name: 'pass', value: 'ok', domain: '127.0.0.1', path: '/', hostOnly: true }]);
    s.queue.add({ url: 'https://slow.example/video/k', title: 'With Cookies', folder: 'K', extractor: 'Generic', direct: direct(srv.base, '/v.mp4', { cookieFile }) });
    const list = await waitFor(s.queue, finished);
    assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
    assert.equal(sha(fs.readFileSync(list[0].filePath)), sha(file));
  } finally { srv.server.close(); }
});

test('streams get several pieces at once from the engine', () => {
  const args = buildArgs({ format: 'mp4', quality: '1080', concurrentFragments: 4 });
  assert.equal(args[args.indexOf('--concurrent-fragments') + 1], '4');
  assert.ok(!buildArgs({ format: 'mp4', quality: '1080', concurrentFragments: 1 }).includes('--concurrent-fragments'));
});
