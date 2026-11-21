// Runs the page window's real steps (grabflow.js) in a real browser against mock sites built like
// the ones that failed: previews in the page code, a decoy link, an ad on the first click, and a
// player that only loads the real video after a real (mouse) click.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const http = require('http');
const assert = require('assert');
const { grabFlow } = require('../../src/main/grabflow');
const { mediaProbe } = require('../../src/main/scanlogic');

const mp4 = (n) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(n, 7)]);
const SIZES = { '/media/full_720p.mp4': 60e6, '/mirror/full_720p.mp4': 60e6, '/video/ol_9f47512.mp4': 3e6, '/media/real_1_720p.mp4': 70e6, '/media/real_2_720p.mp4': 80e6, '/media/real_3_720p.mp4': 90e6, '/previews/p1.mp4': 400e3, '/previews/p2.mp4': 500e3, '/media/clip_short.mp4': 3e6 };

const head = (title, secs) => `<!doctype html><html><head><title>${title} - Example Tube</title>
<meta property="og:title" content="${title}">
<script type="application/ld+json">{"@type":"VideoObject","name":"${title}","duration":"PT${Math.floor(secs / 60)}M${secs % 60}S"}</script></head>`;
const previews = `<div class="related">
  <a href="/video/p1"><img src="/t/1.jpg" data-preview="/previews/p1.mp4"></a>
  <a href="/video/p2"><img src="/t/2.jpg" data-preview="/previews/p2.mp4"></a></div>
<script>var thumbs = {"p1":"http:\\/\\/HOST\\/previews\\/p1.mp4","p2":"http:\\/\\/HOST\\/previews\\/p2.mp4","hd":"http:\\/\\/HOST\\/get_file\\/full_1080p.mp4"};</script>`;

// The site from the log: first real click = ad (pop-up), second real click = the real video. Ignores clicks made by scripts.
const adThenPlay = (host) => head('Real Clip', 720) + `<body><h1>Real Clip</h1>
<div id="player" class="video-player" style="width:960px;height:540px;background:#111"><img src="/t/poster.jpg" width="960" height="540"></div>
${previews.replace(/HOST/g, host)}
<script>
  let clicks = 0;
  document.getElementById('player').addEventListener('click', (e) => {
    if (!e.isTrusted) return;            // scripted clicks do nothing here
    clicks++;
    if (clicks === 1) { window.open('/ad', '_blank'); document.title = document.title + ' '; return; } // the "flash": an ad
    const v = document.createElement('video');
    v.width = 960; v.height = 540; v.muted = true; v.src = '/media/full_720p.mp4';
    document.getElementById('player').replaceChildren(v);
    v.play().catch(() => {});
  });
</script></body></html>`;

// The player asks for its video from two servers (main + backup), like the slow site in the latest log.
const twoServers = () => head('Two Servers Clip', 720) + `<body><h1>Two Servers Clip</h1>
<div id="player" style="width:960px;height:540px;background:#111"></div>
<script>
  document.getElementById('player').addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const v = document.createElement('video');
    v.width = 960; v.height = 540; v.muted = true; v.src = '/media/full_720p.mp4';
    document.getElementById('player').replaceChildren(v);
    v.play().catch(() => {});
    fetch('/mirror/full_720p.mp4', { headers: { Range: 'bytes=0-1023' } });
  });
</script></body></html>`;

// The player plays a short ad clip from an ad server (the same one on every video); the real video's
// file is only written in the page's code. Like the site in the latest log.
const adFirst = (host, n) => head('Ad First Clip ' + n, 0) + `<body><h1>Ad First Clip ${n}</h1>
<div id="player" style="width:960px;height:540px;background:#111"></div>
<script>var cfg = {"file":"http:\\/\\/${host}\\/media\\/real_${n}_720p.mp4","quality":"720p"};</script>
<script>
  document.getElementById('player').addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const v = document.createElement('video');
    v.width = 960; v.height = 540; v.muted = true; v.src = '/video/ol_9f47512.mp4';
    document.getElementById('player').replaceChildren(v);
    v.play().catch(() => {});
  });
</script></body></html>`;

// First click sends the window itself to an ad page; second click (after coming back) plays an HLS stream.
const adRedirect = () => head('Stream Clip', 600) + `<body><h1>Stream Clip</h1>
<div id="player" style="width:900px;height:500px;background:#222"></div>
<script>
  let n = Number(sessionStorage.getItem('n') || 0);
  document.getElementById('player').addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    n++; sessionStorage.setItem('n', n);
    if (n === 1) { location.href = '/ad'; return; }
    fetch('/hls/master.m3u8');           // the player asks for its stream
  });
</script></body></html>`;

// Only previews and a trailer anywhere: must NOT be "downloaded" as the video.
const onlyPreviews = (host) => head('Locked Clip', 900) + `<body><h1>Locked Clip</h1>
<div id="player" style="width:960px;height:540px"><video width="960" height="540" src="/media/clip_short.mp4"></video></div>
${previews.replace(/HOST/g, host)}</body></html>`;

// An ordinary page (plain video tag, starts with the page's own button): must still work as before.
const plain = () => head('Plain Clip', 95) + `<body><h1>Plain Clip</h1><video width="854" height="480" src="/media/plain_480p.mp4"></video></body></html>`;

const server = http.createServer((req, res) => {
  const host = req.headers.host;
  const html = (b) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(b); };
  if (req.url === '/video/real') return html(adThenPlay(host));
  if (req.url === '/video/stream') return html(adRedirect());
  if (req.url === '/video/locked') return html(onlyPreviews(host));
  if (req.url === '/video/plain') return html(plain());
  if (req.url === '/video/two') return html(twoServers());
  { const m = req.url.match(/^\/video\/adfirst(\d)$/); if (m) return html(adFirst(host, m[1])); }
  if (req.url === '/ad') return html('<!doctype html><html><head><title>Hot Offer</title></head><body>ad</body></html>');
  if (req.url.startsWith('/get_file/')) { res.writeHead(302, { Location: '/channel/someone/' }); return res.end(); } // the decoy
  if (req.url === '/channel/someone/') return html('<!doctype html><html><head><title>Someone - Videos</title></head><body>list</body></html>');
  if (req.url === '/hls/master.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720.m3u8\n'); }
  const p = req.url.split('?')[0];
  if (/\.mp4$/.test(p)) {
    const total = SIZES[p] || 20e6;
    const body = mp4(4096 - 12);
    if (req.headers.range) { res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-4095/${total}`, 'Content-Length': 4096 }); return res.end(body); }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length }); return res.end(body);
  }
  res.writeHead(404); res.end();
});

function driverFor(page) {
  const media = new Map();
  const requests = [];
  page.on('response', (r) => {
    const url = r.url();
    requests.push(url);
    const type = r.headers()['content-type'] || '';
    if (/^video\/|mpegurl|dash\+xml/i.test(type) || /\.(mp4|m4v|webm|mov|m3u8|mpd)(\?|$)/i.test(url)) {
      // Same rule as the app: a chunk's length isn't the file's size.
      const m = String(r.headers()['content-range'] || '').match(/\/(\d+)\s*$/);
      media.set(url, { url, type, len: m ? Number(m[1]) : (r.status() === 206 ? 0 : Number(r.headers()['content-length']) || 0) });
    }
  });
  page.context().on('page', (p) => p.close().catch(() => {})); // pop-ups are blocked in the real page window
  return {
    media: () => [...media.values()],
    requests: () => requests,
    async open(u) { const r = await page.goto(u, { waitUntil: 'load' }); return { status: r ? r.status() : 0 }; },
    here: () => page.url(),
    js: (code) => page.evaluate(code),
    async probeAll() {
      const code = mediaProbe(false);
      const top = await page.evaluate(code).catch(() => null);
      const out = top ? [...top.out] : [];
      let duration = top && top.duration;
      for (const f of page.frames().slice(1)) { const r = await f.evaluate(code).catch(() => null); if (r) { out.push(...r.out); duration = duration || r.duration; } }
      return top ? { ...top, out, duration } : { out, duration };
    },
    clickAt: (x, y) => page.mouse.click(x, y),
    async fetchStart(u) {
      const r = await fetch(u, { headers: { Range: 'bytes=0-4095' } });
      if (r.status >= 400) throw new Error('the site answered ' + r.status);
      const range = r.headers.get('content-range') || '';
      const m = range.match(/\/(\d+)\s*$/);
      return { bytes: new Uint8Array(await r.arrayBuffer()).slice(0, 4096), type: r.headers.get('content-type') || '', total: m ? Number(m[1]) : null };
    },
    settle: (ms) => page.waitForTimeout(Math.min(ms, 800))
  };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const run = async (path, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 850 } });
    const page = await ctx.newPage();
    const lines = [];
    try {
      return { r: await grabFlow(driverFor(page), base + path, { log: (m) => lines.push(m), timeoutMs: 40000, ...opts }), lines };
    } catch (e) { return { e, lines }; } finally { await ctx.close(); }
  };

  // 1. The reported site: ad on the first real click, real video on the second; previews and a decoy in the code.
  const a = await run('/video/real');
  assert.ok(a.r, 'got a video: ' + (a.e && a.e.message) + '\n' + a.lines.join('\n'));
  assert.equal(a.r.media.url, base + '/media/full_720p.mp4', 'the full video, not a preview, trailer or decoy:\n' + a.lines.join('\n'));
  assert.equal(a.r.media.from, 'net', 'it is the file the player asked for');
  assert.ok(a.lines.some((l) => /click 2/.test(l)), 'needed the second click (the first opened an ad)');
  assert.ok(a.lines.some((l) => /saw a file from the page's code.*get_file/.test(l)) && a.lines.some((l) => /saw a file from the player/.test(l)), 'the log shows what it saw:\n' + a.lines.join('\n'));

  // 2. First click sends the window to an ad page: comes back, clicks again, gets the stream.
  const b = await run('/video/stream');
  assert.ok(b.r, (b.e && b.e.message) + '\n' + b.lines.join('\n'));
  assert.ok(b.r.media.hls && /master\.m3u8$/.test(b.r.media.url));
  assert.ok(b.lines.some((l) => /went to another page \(an ad\)/.test(l)));

  // 3. Only previews and a trailer: refuses them (10-minute video, 3 MB file) instead of "downloading" them.
  const c = await run('/video/locked', { clicks: 2 });
  assert.ok(c.e, 'should not pick a preview: ' + JSON.stringify(c.r && c.r.media));
  assert.ok(c.e.notVideo, c.e.message);
  assert.ok(c.lines.some((l) => /too small for the video \(a preview\)/.test(l)), c.lines.join('\n'));

  // 4. An ordinary page still works, quickly.
  const t0 = Date.now();
  const d = await run('/video/plain');
  assert.ok(d.r && /plain_480p\.mp4$/.test(d.r.media.url), (d.e && d.e.message) + '\n' + d.lines.join('\n'));
  assert.ok(Date.now() - t0 < 20000, 'ordinary pages aren\'t slowed down much');

  // 5. The player shows the video on two servers: picks one, and passes the other along as a backup.
  const e = await run('/video/two');
  assert.ok(e.r, (e.e && e.e.message) + '\n' + e.lines.join('\n'));
  const urls = [e.r.media.url, ...(e.r.media.alternates || []).map((c) => c.url)];
  assert.ok(urls.includes(base + '/media/full_720p.mp4') && urls.includes(base + '/mirror/full_720p.mp4'), 'both servers passed on: ' + JSON.stringify(urls));
  assert.ok(!(e.r.media.alternates || []).some((c) => c.url === e.r.media.url), 'the picked one isn\'t its own backup');
  // 6. The player plays only a 3 MB ad (same on every video); the real file is in the page's code.
  //    The first pages: the size gives it away. After that: recognised as an ad that plays everywhere.
  for (const n of ['1', '2', '3']) {
    const f = await run('/video/adfirst' + n);
    assert.ok(f.r, (f.e && f.e.message) + '\n' + f.lines.join('\n'));
    assert.equal(f.r.media.url, `${base}/media/real_${n}_720p.mp4`, 'the real video, not the ad clip:\n' + f.lines.join('\n'));
    if (n === '1') assert.ok(f.lines.some((l) => /only 3 MB \(an ad or a clip\): using the 70 MB file/.test(l)), f.lines.join('\n'));
    if (n === '3') assert.ok(f.lines.some((l) => /also plays on other videos \(an ad\)/.test(l)), f.lines.join('\n'));
    assert.ok(!(f.r.media.alternates || []).some((c) => /ol_9f47512/.test(c.url)) || n !== '3', 'the ad isn\'t passed on as a backup');
  }

  // ...and the earlier pages pass along no previews as "backups".
  assert.ok(!(a.r.media.alternates || []).some((c) => /previews|get_file/.test(c.url)), 'previews/decoys never offered as backups: ' + JSON.stringify(a.r.media.alternates));

  await browser.close();
  server.close();
  console.log('page window steps on mock sites: all checks passed');
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
