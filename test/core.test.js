'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const naming = require('../src/main/naming');
const formats = require('../src/main/formats');
const parse = require('../src/main/parse');
const urls = require('../src/main/urls');
const { decide, Library } = require('../src/main/library');
const themes = require('../src/renderer/themes');

test('banned characters are removed from titles', () => {
  assert.equal(naming.cleanName('Jimmy Cuts Grass?!'), 'Jimmy Cuts Grass!');
  assert.equal(naming.cleanName('A/B: C*D "E" <F> G|H \\ I'), 'AB CD E F GH I');
  assert.equal(naming.cleanName('   spaces    everywhere   '), 'spaces everywhere');
  assert.equal(naming.cleanName('ends with dots...'), 'ends with dots');
  assert.equal(naming.cleanName('???'), 'Untitled');
  assert.equal(naming.cleanName(''), 'Untitled');
  assert.equal(naming.cleanName(null), 'Untitled');
  assert.equal(naming.cleanName('CON'), 'CON_');
  assert.equal(naming.cleanName('nul.txt'), 'nul.txt_');
  assert.equal(naming.cleanName('tab\there\u200b'), 'tab here');
  assert.equal(naming.cleanName('Café 🔥 Ünïcode'), 'Café 🔥 Ünïcode');
});

test('long titles are cut without breaking emoji', () => {
  const long = '🔥'.repeat(400);
  const out = naming.cleanName(long);
  assert.equal(Array.from(out).length, naming.MAX_NAME);
  assert.ok(!out.includes('\ufffd'));
});

test('names fit inside the Windows path limit', () => {
  const dir = 'C:\\Users\\Slim\\Documents\\Videos\\SlimTakes\\' + 'X'.repeat(80);
  const base = naming.fitToPath(dir, 'Y'.repeat(150), 'mp4');
  assert.ok(dir.length + 1 + base.length + 4 + 5 + 24 <= 240, 'path too long');
});

test('duplicate titles get (2), (3)...', () => {
  const taken = new Set(['jimmy cuts grass', 'jimmy cuts grass (2)']);
  assert.equal(naming.uniqueBase('Jimmy Cuts Grass', (b) => taken.has(b.toLowerCase())), 'Jimmy Cuts Grass (3)');
  assert.equal(naming.uniqueBase('Fresh', () => false), 'Fresh');
  assert.ok(naming.sameTitle('Jimmy (2)', 'jimmy'));
  assert.ok(!naming.sameTitle('Jimmy 2', 'Jimmy'));
});

test('creator folder names come from the channel', () => {
  assert.equal(naming.creatorFolderName({ channel: 'Jimmy The Lawn Guy', uploader: 'x' }), 'Jimmy The Lawn Guy');
  assert.equal(naming.creatorFolderName({ uploader: 'Some: Uploader?' }), 'Some Uploader');
  assert.equal(naming.creatorFolderName({}), 'Other');
});

test('percent signs are escaped for yt-dlp', () => {
  assert.equal(naming.escapeTemplate('C:\\100% Real\\a.%(ext)s'.replace('.%(ext)s', '')), 'C:\\100%% Real\\a');
});

test('duplicate decision: same title + same length is skipped', () => {
  const entries = [{ base: 'Jimmy Cuts Grass', duration: 768 }];
  const r = decide({ entries, title: 'Jimmy Cuts Grass', duration: 769, dir: 'C:\\S\\J', ext: 'mp4' });
  assert.equal(r.skip, true);
});

test('duplicate decision: same title + different length is kept as (2)', () => {
  const entries = [{ base: 'Jimmy Cuts Grass', duration: 768 }];
  const r = decide({ entries, title: 'Jimmy Cuts Grass', duration: 930, dir: 'C:\\S\\J', ext: 'mp4' });
  assert.deepEqual(r, { skip: false, base: 'Jimmy Cuts Grass (2)' });
});

test('duplicate decision: unknown length never skips, still numbered', () => {
  const entries = [{ base: 'Jimmy Cuts Grass', duration: 768 }, { base: 'Jimmy Cuts Grass (2)', duration: null }];
  const r = decide({ entries, title: 'Jimmy Cuts Grass', duration: null, dir: 'C:\\S\\J', ext: 'mp4' });
  assert.deepEqual(r, { skip: false, base: 'Jimmy Cuts Grass (3)' });
});

test('duplicate decision: a numbered copy with matching length counts too', () => {
  const entries = [{ base: 'Jimmy Cuts Grass (2)', duration: 930 }];
  const r = decide({ entries, title: 'Jimmy Cuts Grass?', duration: 930, dir: 'C:\\S\\J', ext: 'mp4' });
  assert.equal(r.skip, true);
});

test('library: archive IDs, reservations and folder scan', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const dir = path.join(tmp, 'Jimmy');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'Jimmy Cuts Grass.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const lib = new Library({ storeFile: path.join(tmp, 'lib.json'), probeDuration: async () => 768 });
  const a = await lib.claim({ dir, title: 'Jimmy Cuts Grass', duration: 768, ext: 'mp4' });
  assert.equal(a.skip, true);
  const b = await lib.claim({ dir, title: 'Jimmy Cuts Grass', duration: 500, ext: 'mp4' });
  assert.equal(b.base, 'Jimmy Cuts Grass (2)');
  const c = await lib.claim({ dir, title: 'Jimmy Cuts Grass', duration: 400, ext: 'mp4' });
  assert.equal(c.base, 'Jimmy Cuts Grass (3)', 'reserved names must not be reused');
  lib.addId('Youtube', 'abc', path.join(dir, 'Jimmy Cuts Grass.mp4'));
  assert.ok(lib.hasId('youtube', 'abc'));
  const lib2 = new Library({ storeFile: path.join(tmp, 'lib.json'), probeDuration: async () => null });
  assert.ok(lib2.hasId('Youtube', 'abc'), 'archive persists');
  lib2.addId('Youtube', 'nofile');
  assert.ok(!lib2.hasId('Youtube', 'nofile'), 'an ID is only kept with the file it was saved as');
  assert.equal(lib2.status(dir, 'Jimmy Cuts Grass', 768), 'have');
  assert.equal(lib2.status(dir, 'Jimmy Cuts Grass', 100), 'sametitle');
  assert.equal(lib2.status(dir, 'Leaf Blower', 100), 'new');
});

test('format args: MP4 1080p default', () => {
  const a = formats.buildArgs({ format: 'mp4', quality: '1080', embed: true });
  const f = a[a.indexOf('-f') + 1];
  assert.match(f, /height<=1080/);
  assert.match(f, /\/bv\*\+ba\/b$/, 'falls back to best when nothing fits');
  assert.ok(a.includes('--merge-output-format'));
  assert.ok(a.includes('--embed-thumbnail'));
});

test('format args: audio formats extract audio', () => {
  for (const fmt of formats.AUDIO_FORMATS) {
    const a = formats.buildArgs({ format: fmt, quality: '1080' });
    assert.ok(a.includes('-x'));
    assert.equal(a[a.indexOf('--audio-format') + 1], fmt);
    assert.ok(!a.includes('--merge-output-format'));
  }
  assert.ok(!formats.buildArgs({ format: 'wav' }).includes('--embed-thumbnail'), 'wav cannot hold a thumbnail');
});

test('format args: every video format builds sane args', () => {
  for (const fmt of formats.VIDEO_FORMATS) {
    for (const q of formats.QUALITIES) {
      const a = formats.buildArgs({ format: fmt, quality: q });
      assert.ok(a.length > 2);
      assert.ok(!a.includes(undefined));
      if (q === 'best') assert.ok(!a[a.indexOf('-f') + 1].includes('height<='));
    }
  }
  assert.ok(formats.buildArgs({ format: 'avi' }).includes('--recode-video'));
  assert.ok(!formats.buildArgs({ format: 'mkv' }).includes('--remux-video'));
  const r = formats.buildArgs({ format: 'mov', forceRecode: true });
  assert.equal(r[r.indexOf('--recode-video') + 1], 'mov');
});

test('format args: trim, filters, extras', () => {
  const a = formats.buildArgs({ format: 'mp4', trim: { start: '1:30', end: '2:00' }, subs: true, sponsorblock: true,
    speedLimitBytes: 5e6, cookiesBrowser: 'firefox', dateAfter: '2026-01-01', minDuration: 60, maxDuration: 1200, polite: true });
  assert.equal(a[a.indexOf('--download-sections') + 1], '*90-120');
  assert.ok(a.includes('--embed-subs'));
  assert.equal(a[a.indexOf('--sponsorblock-remove') + 1], 'sponsor');
  assert.equal(a[a.indexOf('-r') + 1], '5000000');
  assert.equal(a[a.indexOf('--cookies-from-browser') + 1], 'firefox');
  assert.equal(a[a.indexOf('--dateafter') + 1], '20260101');
  assert.equal(a[a.indexOf('--match-filter') + 1], 'duration>=60 & duration<=1200');
  assert.ok(a.includes('--sleep-requests'));
  const b = formats.buildArgs({ format: 'mp4', trim: { start: '', end: '45' } });
  assert.equal(b[b.indexOf('--download-sections') + 1], '*0-45');
  assert.equal(formats.timeToSeconds('1:02:03'), 3723);
  assert.equal(formats.timeToSeconds('abc'), null);
});

test('size estimates', () => {
  assert.equal(formats.estimateBytes(0, 'mp4', '1080'), 0);
  const e = formats.estimateBytes(600, 'mp4', '1080');
  assert.ok(e > 300e6 && e < 400e6);
  assert.ok(formats.estimateBytes(600, 'mp3', '1080') < 30e6);
});

test('progress lines parse', () => {
  const p = parse.parseLine('STPROG|downloading|5000|10000|NA|250000.5|20|NA|NA');
  assert.equal(p.type, 'progress');
  assert.equal(p.pct, 50);
  assert.equal(p.speed, 250000.5);
  const est = parse.parseLine('STPROG|downloading|5000|NA|20000|NA|NA|NA|NA');
  assert.equal(est.pct, 25);
  const frag = parse.parseLine('STPROG|downloading|5000|NA|NA|NA|NA|3|12');
  assert.equal(frag.pct, 25);
});

test('done lines parse, even with | in the path', () => {
  const d = parse.parseLine('STDONE|C:\\V\\A|B.mp4|1763500000|20251118|768.5|abc123|Youtube');
  assert.equal(d.type, 'done');
  assert.equal(d.filepath, 'C:\\V\\A|B.mp4');
  assert.equal(d.timestamp, 1763500000);
  assert.equal(d.uploadDate, '20251118');
  assert.equal(d.duration, 768.5);
  assert.equal(d.id, 'abc123');
  const na = parse.parseLine('STDONE|C:\\x.mp4|NA|NA|NA|id|Vimeo');
  assert.equal(na.timestamp, null);
  assert.equal(na.uploadDate, null);
});

test('other yt-dlp lines are classified', () => {
  assert.equal(parse.parseLine('ERROR: [youtube] x: Video unavailable').type, 'error');
  assert.equal(parse.parseLine('[download] Y upload date is not in range 20260101-99991231').type, 'skipped');
  assert.equal(parse.parseLine('[Merger] Merging formats into "x.mp4"').type, 'processing');
  assert.equal(parse.parseLine('   '), null);
  assert.equal(parse.uploadDateToDate('20261118', null).getUTCDate(), 18);
  assert.equal(parse.uploadDateToDate(null, null), null);
});

test('link extraction and YouTube channels', () => {
  const links = urls.extractLinks('one https://youtu.be/abc, two https://vimeo.com/123) and https://youtu.be/abc again');
  assert.deepEqual(links, ['https://youtu.be/abc', 'https://vimeo.com/123']);
  assert.equal(urls.youtubeChannelBase('https://www.youtube.com/@JimmyLawn'), 'https://www.youtube.com/@JimmyLawn');
  assert.equal(urls.youtubeChannelBase('https://youtube.com/@JimmyLawn/videos'), 'https://www.youtube.com/@JimmyLawn');
  assert.equal(urls.youtubeChannelBase('https://www.youtube.com/channel/UC123/'), 'https://www.youtube.com/channel/UC123');
  assert.equal(urls.youtubeChannelBase('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(urls.youtubeChannelBase('https://www.youtube.com/@x/playlists'), null);
  assert.equal(urls.youtubeTabs('B', { videos: true, shorts: false, streams: true }).length, 2);
  assert.equal(urls.siteName({ extractor_key: 'YoutubeTab' }), 'YouTube');
  assert.equal(urls.siteName({ extractor_key: 'Vimeo' }), 'Vimeo');
  assert.equal(urls.siteName({}), 'Web');
});

test('themes: presets complete and custom accents readable', () => {
  const keys = Object.keys(themes.THEMES.crimson);
  for (const t of Object.values(themes.THEMES)) assert.deepEqual(Object.keys(t), keys);
  const light = themes.customTheme('#ffee00');
  const dark = themes.customTheme('#3300aa');
  assert.notEqual(light.on, '#ffffff', 'dark text on bright accents');
  assert.equal(dark.on, '#ffffff', 'white text on dark accents');
  assert.equal(themes.customTheme('nonsense').acc, '#ff3b3b');
});

const range = require('../src/main/range');
const scan = require('../src/main/scanlogic');

test('player seeking: byte ranges', () => {
  assert.deepEqual(range.parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(range.parseRange('bytes=500-599', 1000), { start: 500, end: 599 });
  assert.deepEqual(range.parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.deepEqual(range.parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.equal(range.parseRange('bytes=1000-', 1000), 'bad');
  assert.equal(range.parseRange('bytes=5-2', 1000), 'bad');
  assert.equal(range.parseRange('nonsense', 1000), 'bad');
  assert.equal(range.parseRange(null, 1000), null);
  assert.equal(range.mimeFor('C:\\a\\b.MP4'), 'video/mp4');
});

test('player seeking: the served bytes are the right part of the file', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-'));
  const f = path.join(tmp, 'v.mp4');
  fs.writeFileSync(f, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  const r = range.serveFile(f, 'bytes=500-509');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 500-509/1000');
  const body = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...body], Array.from({ length: 10 }, (_, i) => (500 + i) % 256));
  const full = range.serveFile(f, null);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(range.serveFile(f, 'bytes=2000-').status, 416);
});

test('creator name from a profile link', () => {
  assert.equal(scan.nameFromUrl('https://www.example.com/model/some_name/videos'), 'Some Name');
  assert.equal(scan.nameFromUrl('https://www.example.com/maker/jane-doe'), 'Jane Doe');
  assert.equal(scan.nameFromUrl('https://www.example.com/@CoolGuy'), 'CoolGuy');
  assert.equal(scan.nameFromUrl('https://www.example.com/u/bob/videos/2'), 'Bob');
  assert.equal(scan.nameFromUrl('https://www.example.com/'), null);
  assert.equal(scan.nameFromUrl('not a url'), null);
});

test('page scan picks the video links out of a page', () => {
  const page = 'https://www.example.com/maker/jane/videos';
  const links = [
    { href: '/', text: 'Home' }, { href: '/login', text: 'Log in' }, { href: '/tags/outdoor', text: 'outdoor' },
    { href: '/maker/jane/videos', text: 'Videos' }, { href: '/maker/jane/videos?page=2', text: 'Next' },
    { href: 'https://other.com/video-1', text: 'elsewhere' },
    { href: '/video-a1b2c3/first_clip', text: 'First Clip', thumb: 'https://img.example.com/1.jpg' },
    { href: '/video-d4e5f6/second_clip', text: '' }, { href: '/video-d4e5f6/second_clip#x', text: 'Second Clip' },
    { href: '/video-g7h8i9/third', text: 'Third' },
    { href: '/maker/other1', text: 'Other' }, { href: '/maker/other2', text: 'Other 2' }
  ];
  const v = scan.pickVideoLinks(links, page);
  assert.deepEqual(v.map((x) => x.title), ['First Clip', 'Second Clip', 'Third']);
  assert.equal(v[0].url, 'https://www.example.com/video-a1b2c3/first_clip');
  assert.equal(v[0].thumbnail, 'https://img.example.com/1.jpg');
  assert.deepEqual(scan.pickVideoLinks([{ href: '/about' }], page), []);
  assert.equal(scan.titleFromPath('/video-123/my_cool-clip'), 'my cool clip');
});

test('page scan never mistakes site menus for videos', () => {
  const page = 'https://www.example.com/maker/x';
  const menus = ['/history', '/hits', '/best', '/tags', '/upload', '/favorites', '/maker/x/videos?page=2', '/page/3'].map((href) => ({ href, text: href }));
  assert.deepEqual(scan.pickVideoLinks(menus, page), []);
  const withVideos = [...menus, { href: '/video-1ab23cd/a', text: 'A' }, { href: '/video-2bc34de/b', text: 'B' }];
  assert.deepEqual(scan.pickVideoLinks(withVideos, page).map((v) => v.title), ['A', 'B']);
});

const migrate = require('../src/main/migrate');

test('rename: old data folder and SlimTake save folder move over, paths updated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const oldData = path.join(root, 'Slim Take'), newData = path.join(root, 'Slim Takes');
  const saveOld = path.join(root, 'Videos', 'SlimTake'), saveNew = path.join(root, 'Videos', 'SlimTakes');
  fs.mkdirSync(path.join(oldData, 'engine'), { recursive: true });
  fs.mkdirSync(path.join(saveOld, 'Jimmy'), { recursive: true });
  fs.writeFileSync(path.join(saveOld, 'Jimmy', 'a.mp4'), 'x');
  fs.writeFileSync(path.join(oldData, 'engine', 'yt-dlp.exe'), 'bin');
  fs.writeFileSync(path.join(oldData, 'settings.json'), JSON.stringify({ folder: saveOld, theme: 'ice' }));
  fs.writeFileSync(path.join(oldData, 'history.json'), JSON.stringify([{ id: 1, filePath: path.join(saveOld, 'Jimmy', 'a.mp4') }, { id: 2, filePath: path.join(root, 'Elsewhere', 'b.mp4') }]));
  fs.writeFileSync(path.join(oldData, 'library.json'), JSON.stringify({ cache: { [path.join(saveOld, 'Jimmy')]: { 'a.mp4': { duration: 5 } } }, files: { 'youtube x': path.join(saveOld, 'Jimmy', 'a.mp4') } }));

  assert.equal(migrate.moveDataFolder(oldData, newData), true);
  assert.ok(fs.existsSync(path.join(newData, 'engine', 'yt-dlp.exe')), 'engine came along');
  assert.equal(migrate.moveDataFolder(oldData, newData), false, 'only once');
  assert.equal(migrate.renameSaveFolder(newData), true);
  assert.ok(fs.existsSync(path.join(saveNew, 'Jimmy', 'a.mp4')), 'videos moved to SlimTakes');
  const s = JSON.parse(fs.readFileSync(path.join(newData, 'settings.json'), 'utf8'));
  assert.equal(s.folder, saveNew);
  assert.equal(s.theme, 'ice', 'other settings kept');
  const h = JSON.parse(fs.readFileSync(path.join(newData, 'history.json'), 'utf8'));
  assert.equal(h[0].filePath, path.join(saveNew, 'Jimmy', 'a.mp4'));
  assert.equal(h[1].filePath, path.join(root, 'Elsewhere', 'b.mp4'), 'files elsewhere untouched');
  const lib = JSON.parse(fs.readFileSync(path.join(newData, 'library.json'), 'utf8'));
  assert.ok(lib.cache[path.join(saveNew, 'Jimmy')]);
  assert.deepEqual(lib.files, { 'youtube x': path.join(saveNew, 'Jimmy', 'a.mp4') }, 'saved file locations follow the rename');
  assert.equal(migrate.renameSaveFolder(newData), false, 'only once');
  assert.equal(migrate.swapPrefix('C:\\V\\SlimTake\\x.mp4', 'c:\\v\\slimtake', 'C:\\V\\SlimTakes'.replace(/\\/g, path.sep)), 'C:\\V\\SlimTake\\x.mp4'.startsWith('C:') && path.sep === '\\' ? 'C:\\V\\SlimTakes\\x.mp4' : 'C:\\V\\SlimTake\\x.mp4');
});

test('page scan: link kinds from the real failing log are handled', () => {
  const page = 'https://www.example.com/maker/somebody';
  const links = [];
  for (let i = 0; i < 312; i++) links.push({ href: `/search/term${i % 40}`, text: 'tag' });
  for (let i = 0; i < 27; i++) links.push({ href: `/maker/other_${i}`, text: 'maker' });
  for (let i = 0; i < 13; i++) links.push({ href: '/', text: 'home' });
  links.push({ href: '/upload', text: 'Upload' }, { href: '/history', text: 'History' });
  for (let i = 0; i < 12; i++) links.push({ href: `/prof-video-click/upload/somebody/${1000 + i}abc/clip_title_${i}`, text: `Clip ${i}` });
  const v = scan.pickVideoLinks(links, page);
  assert.equal(v.length, 12, 'all twelve video links kept even though they contain "upload"');
  assert.ok(v.every((x) => x.url.includes('/prof-video-click/')));
  assert.ok(scan.isMenuLink(new URL('https://e.com/upload')));
  assert.ok(scan.isMenuLink(new URL('https://e.com/search/abc123')));
  assert.ok(!scan.isMenuLink(new URL('https://e.com/prof-video-click/upload/x/123/y')));
});

const { chooseVideos } = require('../src/main/choose');

test('page scan keeps every link style of the creator, drops other uploaders and duplicates', async () => {
  const mk = (ids, fn, ctx = 'Somebody') => ids.map((id) => ({ url: fn(id), title: 'Clip ' + id, thumbnail: null, ctx: ctx + ' clip' }));
  const scanRes = {
    name: 'Somebody',
    groups: [
      { shape: '/prof-video-click/*/*/*/*', score: 6, items: mk([1, 2, 3, 4, 5, 6], (i) => `https://e.com/prof-video-click/upload/somebody/${i}00/c`) },
      { shape: '/*/*', score: 5, items: mk([6, 7, 8, 9, 10], (i) => `https://e.com/${i}00x/c`) },          // other link style (6 is a duplicate)
      { shape: '/related-*/*', score: 4, items: mk([91, 92, 93, 94], (i) => `https://e.com/related-${i}0/c`, 'Someone Else') }, // other uploader
      { shape: '/maker-*/*', score: 2, items: mk([1, 2], (i) => `https://e.com/maker-${i}/x`) }          // not videos
    ]
  };
  // tracking links forward to "/<id>00x/c"
  const follow = async (items) => items.map((it) => ({ ...it, url: it.url.replace(/prof-video-click\/upload\/somebody\/(\d+)\/c/, '$1x/c') }));
  const lookup = async (u) => {
    if (/maker-/.test(u)) throw new Error('Unsupported URL');
    if (/related-/.test(u)) return { kind: 'video', url: u, channelName: 'Someone Else', folder: 'Someone Else', id: 'r' };
    return { kind: 'video', url: u, channelName: 'Somebody', folder: 'Somebody', id: u.match(/(\d+)00x/)[1], extractor: 'Site' };
  };
  const r = await chooseVideos(scanRes, 'https://e.com/maker/somebody', { lookup, follow });
  assert.equal(r.owner.folder, 'Somebody');
  assert.equal(r.videos.length, 10, 'videos 1-10, the duplicate counted once: ' + r.videos.map((v) => v.url).join(' '));
  assert.ok(r.videos.every((v) => /\/\d+00x\/c$/.test(v.url)));
  assert.ok(!r.videos.some((v) => /related/.test(v.url)), 'other uploader dropped');
});

test('page scan picks the creator whose name matches the page, even if another group is bigger', async () => {
  const items = (n, base) => Array.from({ length: n }, (_, i) => ({ url: `https://e.com/${base}-${i}1/c`, title: 't', ctx: '' }));
  const scanRes = { name: 'Roberta Ruiva', groups: [
    { shape: '/rec-*/*', score: 20, items: items(20, 'rec') },
    { shape: '/v-*/*', score: 8, items: items(8, 'v') }
  ] };
  const lookup = async (u) => ({ kind: 'video', url: u, channelName: /rec-/.test(u) ? 'Popular Person' : 'Robertaruiva', folder: /rec-/.test(u) ? 'Popular Person' : 'Robertaruiva' });
  const r = await chooseVideos(scanRes, 'https://e.com/maker/roberta_ruiva', { lookup, follow: async (x) => x });
  assert.equal(r.owner.folder, 'Robertaruiva');
  assert.equal(r.videos.length, 8);
});

test('related-video tiles inside a group are dropped when tiles name the creator', () => {
  const its = [1, 2, 3, 4, 5].map((i) => ({ url: 'u' + i, ctx: 'Robertaruiva some title' })).concat([{ url: 'x', ctx: 'OtherGuy title' }]);
  assert.deepEqual(scan.keepCreatorTiles(its, ['Robertaruiva']).map((i) => i.url), ['u1', 'u2', 'u3', 'u4', 'u5']);
  const unnamed = [{ url: 'a', ctx: 'title' }, { url: 'b', ctx: 'title' }];
  assert.equal(scan.keepCreatorTiles(unnamed, ['Robertaruiva']).length, 2, 'tiles without names: keep all');
  assert.equal(scan.nameKey('Roberta_Ruiva'), scan.nameKey('robertaruiva'));
});

test('uploader name is found in a video page when the engine has none', () => {
  assert.equal(scan.uploaderFromHtml('<script type="application/ld+json">{"@type":"VideoObject","author":{"@type":"Person","name":"Robertaruiva"}}</script>'), 'Robertaruiva');
  assert.equal(scan.uploaderFromHtml('<script type="application/ld+json">[{"creator":"Jane Doe"}]</script>'), 'Jane Doe');
  assert.equal(scan.uploaderFromHtml('<meta name="author" content="Some Creator">'), 'Some Creator');
  assert.equal(scan.uploaderFromHtml('<div class="video-metadata"><a class="uploader-tag" href="/maker/x"><span class="name">Robertaruiva</span></a></div>'), 'Robertaruiva');
  assert.equal(scan.uploaderFromHtml('<span class="video-uploader">Big &amp; Bold</span>'), 'Big & Bold');
  assert.equal(scan.uploaderFromHtml('<a class="uploader" href="#">Subscribe</a>'), null, 'button words are not names');
  assert.equal(scan.uploaderFromHtml('<p>nothing here</p>'), null);
  assert.equal(scan.uploaderFromHtml(null), null);
});

test('a video remembers its creator folder', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-'));
  const lib = new Library({ storeFile: path.join(tmp, 'lib.json'), probeDuration: async () => null });
  lib.rememberFolder({ url: 'https://www.site.com/video-abc123/title/', extractor: 'Site', id: 'abc123' }, 'Robertaruiva');
  assert.equal(lib.folderFor({ url: 'https://site.com/video-abc123/title' }), 'Robertaruiva', 'same video, slightly different link');
  assert.equal(lib.folderFor({ url: 'https://elsewhere.com/x', extractor: 'site', id: 'abc123' }), 'Robertaruiva', 'by video ID');
  assert.equal(lib.folderFor({ url: 'https://site.com/video-zzz/other' }), null);
  const lib2 = new Library({ storeFile: path.join(tmp, 'lib.json'), probeDuration: async () => null });
  assert.equal(lib2.folderFor({ url: 'https://site.com/video-abc123/title' }), 'Robertaruiva', 'remembered after restart');
});

test('page scan: when the engine knows no uploaders, the page decides whose videos they are', async () => {
  const items = (ids, ctx) => ids.map((i) => ({ url: `https://e.com/video-${i}x/c`, title: 'Clip ' + i, ctx }));
  const scanRes = { name: 'Robertaruiva', groups: [
    { shape: '/video-*/*', score: 9, items: [...items([1, 2, 3, 4, 5, 6, 7], 'Robertaruiva Clip'), ...items([90, 91], 'Other Person Clip')] },
    { shape: '/rec-*/*', score: 8, items: [1, 2, 3, 4].map((i) => ({ url: `https://e.com/rec-${i}x/c`, title: 'r', ctx: 'Other Person' })) }
  ] };
  // engine: no uploader for anything, folder is just the site's name
  const lookup = async (u) => ({ kind: 'video', url: u, hasUploader: false, channelName: '', folder: 'SITE' });
  const uploaderOf = async (v) => (/video-9|rec-/.test(v.url) ? 'Other Person' : 'Robertaruiva');
  const r = await chooseVideos(scanRes, 'https://e.com/maker/roberta_ruiva', { lookup, uploaderOf, follow: async (x) => x });
  assert.deepEqual(r.videos.map((v) => v.url.match(/video-(\d+)/)[1]).map(Number), [1, 2, 3, 4, 5, 6, 7]);
});

test('page scan: groups are kept when no uploader name can be found anywhere (regression)', async () => {
  const items = (base, n, ctx) => Array.from({ length: n }, (_, i) => ({ url: `https://e.com/${base}-${i}1/c`, title: 't', ctx }));
  const lookup = async (u) => ({ kind: 'video', url: u, hasUploader: false, channelName: '', folder: 'SITE', site: 'Site' });
  const uploaderOf = async () => null; // page shows no uploader either
  // 1. tiles name the creator: both of her link styles kept, someone else's left out
  let r = await chooseVideos({ name: 'Robertaruiva', groups: [
    { shape: '/a-*/*', score: 9, items: items('a', 5, 'Robertaruiva clip') },
    { shape: '/b-*/*', score: 8, items: items('b', 5, 'Robertaruiva clip') },
    { shape: '/c-*/*', score: 7, items: items('c', 4, 'Other Person clip') }
  ] }, 'https://e.com/maker/roberta_ruiva', { lookup, uploaderOf, follow: async (x) => x });
  assert.equal(r.videos.length, 10);
  assert.ok(!r.videos.some((v) => /\/c-/.test(v.url)));
  // 2. tiles show no names at all: fall back to the engine treating them the same -> all kept
  r = await chooseVideos({ name: 'Robertaruiva', groups: [
    { shape: '/a-*/*', score: 9, items: items('a', 5, '') },
    { shape: '/b-*/*', score: 8, items: items('b', 5, '') }
  ] }, 'https://e.com/maker/roberta_ruiva', { lookup, uploaderOf, follow: async (x) => x });
  assert.equal(r.videos.length, 10);
});


test('deleted after clearing history: the video can be downloaded again (the reported bug)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const dir = path.join(tmp, 'Jimmy');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'Jimmy Cuts Grass.mp4');
  fs.writeFileSync(file, 'x');
  const store = path.join(tmp, 'lib.json');
  const lib = new Library({ storeFile: store, probeDuration: async () => 768 });
  lib.addId('Generic', 'v1', file);
  lib.noteFile(file, 768);
  assert.equal(lib.status(dir, 'Jimmy Cuts Grass', 768, 'Generic', 'v1'), 'have');
  // History cleared (nothing links the file any more), then the file deleted, even with the app closed
  fs.rmSync(file);
  const lib2 = new Library({ storeFile: store, probeDuration: async () => null });
  assert.equal(lib2.hasId('Generic', 'v1'), false, 'the ID is free again');
  assert.equal(lib2.status(dir, 'Jimmy Cuts Grass', 768, 'Generic', 'v1'), 'new', 'and title/length no longer match a deleted file');
});

test('old ID lists without file locations are dropped once (unsticks "already have it")', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const store = path.join(tmp, 'lib.json');
  fs.writeFileSync(store, JSON.stringify({ cache: {}, archive: ['generic stuck1', 'youtube stuck2'] }));
  const lib = new Library({ storeFile: store, probeDuration: async () => null });
  assert.equal(lib.hasId('Generic', 'stuck1'), false);
  assert.equal(lib.hasId('Youtube', 'stuck2'), false);
});

test('clear history forgets downloaded IDs; files on disk still count as duplicates', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const dir = path.join(tmp, 'Jimmy');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'Jimmy Cuts Grass.mp4');
  fs.writeFileSync(file, 'x');
  const lib = new Library({ storeFile: path.join(tmp, 'lib.json'), probeDuration: async () => 768 });
  lib.addId('Youtube', 'abc', file);
  lib.clearIds();
  assert.equal(lib.hasId('Youtube', 'abc'), false);
  const again = await lib.claim({ dir, title: 'Jimmy Cuts Grass', duration: 768, ext: 'mp4' });
  assert.equal(again.skip, true, 'still on disk: still skipped as a duplicate');
});

test('single video links are told apart from channels and playlists', () => {
  const { looksLikeVideo } = require('../src/main/urls');
  const yes = ['https://www.youtube.com/watch?v=abc&list=PL1', 'https://youtu.be/abc', 'https://vimeo.com/123456789', 'https://x.com/someone/status/1',
    'https://www.tiktok.com/@a/video/1', 'https://example.com/video/198308/some-title/', 'https://www.twitch.tv/videos/12345'];
  const no = ['https://www.youtube.com/@jimmy', 'https://www.youtube.com/playlist?list=PL1', 'https://vimeo.com/someone', 'https://example.com/channel/some-collection/',
    'https://example.com/videos/category-name/', 'https://www.instagram.com/someone/', 'https://soundcloud.com/artist'];
  for (const u of yes) assert.ok(looksLikeVideo(u), u);
  for (const u of no) assert.ok(!looksLikeVideo(u), u);
});

test('page window: picks the real video file, not ads, previews or stream pieces', () => {
  const { pickMedia, cleanPageTitle, heightOf } = require('../src/main/scanlogic');
  const best = pickMedia([
    { url: 'https://cdn.example.net/ads/preroll.mp4', from: 'script' },
    { url: 'https://cdn.example.net/v/123_480p.mp4', label: '480p', from: 'source' },
    { url: 'https://cdn.example.net/v/123_1080p.mp4', label: '1080p', from: 'source' },
    { url: 'https://cdn.example.net/previews/123.mp4', from: 'script' }
  ], [{ url: 'https://cdn.example.net/hls/123/seg-1.ts' }, { url: 'https://cdn.example.net/v/tiny.mp4', len: 4000 }]);
  assert.equal(best.url, 'https://cdn.example.net/v/123_1080p.mp4');
  assert.equal(best.height, 1080);
  const hls = pickMedia([], [{ url: 'https://cdn.example.net/hls/123/master.m3u8', type: 'application/vnd.apple.mpegurl' }]);
  assert.ok(hls.hls);
  assert.equal(pickMedia([{ url: 'blob:https://x/1' }], []), null);
  assert.equal(cleanPageTitle('Jimmy Cuts Grass - Example Videos | Example.com', 'www.example.com'), 'Jimmy Cuts Grass');
  assert.equal(cleanPageTitle('Jimmy Cuts Grass', 'example.com'), 'Jimmy Cuts Grass');
  assert.equal(heightOf('video_720p.mp4'), 720);
});

// ---------- v1.2.4: sites the engine doesn't know ----------
test('page window traffic light: two pages at once, strict sites one at a time, never stuck', async () => {
  const { Lanes } = require('../src/main/lanes');
  const lanes = new Lanes(2);
  let active = 0, peak = 0;
  const perKey = new Map(), perKeyPeak = new Map();
  const job = async (key, solo, ms) => {
    const release = await lanes.acquire(key, solo);
    active++; peak = Math.max(peak, active);
    perKey.set(key, (perKey.get(key) || 0) + 1);
    perKeyPeak.set(key, Math.max(perKeyPeak.get(key) || 0, perKey.get(key)));
    await new Promise((r) => setTimeout(r, ms));
    active--; perKey.set(key, perKey.get(key) - 1);
    release(); release(); // a double release must be harmless
  };
  const jobs = [];
  for (let i = 0; i < 40; i++) jobs.push(job(i % 3 === 0 ? 'strict' : 'open' + (i % 2), i % 3 === 0, 5 + (i % 7)));
  await Promise.all(jobs);
  assert.equal(peak, 2, 'never more than two pages at once');
  assert.equal(perKeyPeak.get('strict'), 1, 'strict site: one at a time');
  assert.equal(lanes.active, 0);
  assert.equal(lanes.waiting.length, 0);
});

test('video finder helpers: ad servers, bigger files, real video pages, DRM and login walls, code titles', () => {
  const { pickMedia, isVideoPage, explainNoMedia, looksLikeCode } = require('../src/main/scanlogic');
  const pick = pickMedia([], [
    { url: 'https://ads.example.net/creative/clip.mp4', len: 9e8 },
    { url: 'https://cdn.example.net/x/small.mp4', len: 3e6 },
    { url: 'https://cdn.example.net/x/main.mp4', len: 6e8 },
    { url: 'https://imasdk.googleapis.com/v.mp4', len: 9e8 }
  ]);
  assert.equal(pick.url, 'https://cdn.example.net/x/main.mp4');
  assert.ok(isVideoPage({ player: { w: 854, h: 480 }, out: [] }));
  assert.ok(!isVideoPage({ player: { w: 240, h: 135 }, out: [{ from: 'video' }] }), 'small autoplay preview on a list page');
  assert.ok(isVideoPage({ player: null, framePlayer: true, out: [] }), 'player inside a frame');
  assert.ok(isVideoPage({ player: null, out: [{ from: 'meta' }] }), 'page says it is a video');
  assert.ok(!isVideoPage(null));
  const drm = explainNoMedia({}, ['https://lic.example.net/widevine/license?x=1']);
  assert.ok(drm.final && /copy-protected/.test(drm.message));
  const login = explainNoMedia({ loginWall: true }, []);
  assert.ok(login.final && /logged in/.test(login.message));
  const none = explainNoMedia({}, ['https://cdn.example.net/app.js']);
  assert.ok(!none.final && /Couldn't find/.test(none.message));
  assert.ok(looksLikeCode('aPmEvq2pjlW', 'https://x.com/watch/aPmEvq2pjlW'));
  assert.ok(looksLikeCode('', 'https://x.com/watch/a'));
  assert.ok(!looksLikeCode('Jimmy Cuts Grass', 'https://x.com/watch/1'));
  assert.ok(!looksLikeCode('Grass', 'https://x.com/watch/1'));
});

test('page scan: video links without numbers, other parts of the same site, single-video channels', () => {
  const { hasVideoId, siteKey, candidateGroups } = require('../src/main/scanlogic');
  const id = (u) => hasVideoId(new URL(u));
  assert.ok(id('https://x.com/watch/abmLnwJoxQZ'), 'code with no number');
  assert.ok(id('https://x.com/video/jimmy-cuts-grass'), 'name after a video word');
  assert.ok(id('https://x.com/v/12345'));
  for (const u of ['https://x.com/watch/later', 'https://x.com/videos/popular', 'https://x.com/categories/lawns', 'https://x.com/about', 'https://x.com/watch/new'])
    assert.ok(!id(u), u);
  assert.equal(siteKey('m.example.co.uk'), 'example.co.uk');
  assert.equal(siteKey('video.cdn.example.com'), 'example.com');
  assert.equal(siteKey('127.0.0.1'), '127.0.0.1');
  assert.equal(siteKey('localhost'), 'localhost');
  const groups = candidateGroups([
    { href: 'https://m.example.com/watch/abmLnwJoxQZ' },
    { href: 'https://www.example.com/watch/b4jllLOAdjQ' },
    { href: 'https://video.example.com/watch/ZRjdEaRQxlP' },
    { href: 'https://another-site.net/watch/xYzAbCdEfG' }
  ], 'https://www.example.com/star/jimmy');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 3, 'same site, any part of it; other sites ignored');
  const single = candidateGroups([{ href: 'https://example.com/clip/aBcDeFgH' }, { href: 'https://example.com/about' }], 'https://example.com/star/jimmy');
  assert.equal(single.length, 1, 'a channel with just one video');
  const noise = candidateGroups([{ href: 'https://example.com/lawns' }, { href: 'https://example.com/news/today' }], 'https://example.com/star/jimmy');
  assert.equal(noise.length, 0, 'plain words are still not videos');
});
