// Checks the page-side video finder on a local page shaped like a real video page.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const http = require('http');
const assert = require('assert');
const { MEDIA_PROBE, mediaProbe, pickMedia, cleanPageTitle, isVideoPage, explainNoMedia } = require('../../src/main/scanlogic');

const page = `<!doctype html><html><head><title>Clip Title - Example</title>
<meta property="og:title" content="Clip Title - Example">
<meta property="og:image" content="/thumbs/clip.jpg">
<script type="application/ld+json">{"@type":"VideoObject","name":"Clip Title","duration":"PT12M48S","thumbnailUrl":"/t.jpg"}</script>
</head><body>
<h1>Clip Title</h1>
<div class="player"><video id="v" poster="/thumbs/poster.jpg" preload="none">
  <source src="/media/clip_480p.mp4" label="480p" type="video/mp4">
  <source src="/media/clip_1080p.mp4" label="1080p" type="video/mp4">
</video><button class="vjs-big-play-button">Play</button></div>
<script>var player = {"ads":{"preroll":"https:\\/\\/ads.example.net\\/vast\\/pre.mp4"},"sources":[{"quality":"720p","file":"https:\\/\\/cdn.example.net\\/media\\/clip_720p.mp4?token=abc&amp;exp=1"}]};</script>
<div class="related"><a href="/video/2/other/"><img src="/previews/2.mp4"></a></div>
</body></html>`;

const framed = `<!doctype html><html><head><title>Framed</title></head><body><h1>Framed clip</h1>
<iframe src="/embed/9" width="640" height="360"></iframe>
<button class="vjs-big-play-button" onclick="window.clicked = true">Play</button></body></html>`;
const embed = `<!doctype html><html><body><video src="/media/framed_720p.mp4" width="640" height="360"></video></body></html>`;
const listPage = `<!doctype html><html><head><title>Jimmy The Lawn Guy - Videos</title></head><body><h1>Jimmy The Lawn Guy</h1>
<div class="hero"><video src="/previews/hero.mp4" width="240" height="135" autoplay muted loop></video></div>
<div class="list"><a href="/watch/aPmEvq2pjlW"><img src="/t/1.jpg" alt="Clip One"></a></div></body></html>`;
const withRelated = `<!doctype html><html><head><title>Main Clip</title></head><body>
<video src="/media/main_1080p.mp4" width="960" height="540"></video>
<div class="related"><video src="/media/other_1080p.mp4" width="200" height="112"></video></div></body></html>`;
const membersOnly = `<!doctype html><html><head><title>Members Clip</title></head><body><h1>Members Clip</h1>
<div class="gate"><p>This video is for members only. Sign in to watch.</p><form><input type="email"><input type="password"></form></div></body></html>`;
const server = http.createServer((req, res) => {
  const pages = { '/list/jimmy': listPage, '/watch/related': withRelated, '/watch/members': membersOnly };
  if (pages[req.url]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(pages[req.url]); }
  if (req.url === '/video/1/clip-title/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page); }
  if (req.url === '/video/9/framed/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(framed); }
  if (req.url === '/embed/9') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(embed); }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const p = await browser.newPage();
  await p.goto(base + '/video/1/clip-title/');
  const info = await p.evaluate(MEDIA_PROBE);
  const best = pickMedia(info.out, []);
  assert.equal(best && best.url, base + '/media/clip_1080p.mp4', JSON.stringify(info.out));
  assert.ok(info.out.some((c) => c.url === 'https://cdn.example.net/media/clip_720p.mp4?token=abc&exp=1'), 'player setup links unescaped');
  assert.ok(!pickMedia(info.out.filter((c) => /ads\./.test(c.url)), []), 'ad links never picked');
  assert.equal(info.duration, 768, 'length from the page');
  assert.equal(cleanPageTitle(info.title, 'www.example.com'), 'Clip Title', 'title without the site name');
  assert.equal(info.thumb, base + '/thumbs/clip.jpg');
  // A player inside a frame: the finder works there too; and without pressing play when asked not to.
  await p.goto(base + '/video/9/framed/');
  const top = await p.evaluate(mediaProbe(false));
  assert.equal(await p.evaluate(() => !!window.clicked), false, 'no play button pressed in no-click mode');
  assert.equal(top.out.length, 0);
  const frame = p.frames().find((f) => /\/embed\/9$/.test(f.url()));
  const inner = await frame.evaluate(MEDIA_PROBE);
  assert.equal(pickMedia([...top.out, ...inner.out], []).url, base + '/media/framed_720p.mp4');

  // A list page with a small autoplaying banner is not a video page.
  await p.goto(base + '/list/jimmy');
  const lp = await p.evaluate(mediaProbe(false));
  assert.equal(isVideoPage(lp), false, 'list page with a banner: not a video page');
  // Only the main player counts: the small "related" player is ignored.
  await p.goto(base + '/watch/related');
  const rp = await p.evaluate(mediaProbe(false));
  assert.ok(isVideoPage(rp));
  assert.deepEqual([...new Set(rp.out.map((c) => c.url))], [base + '/media/main_1080p.mp4'], 'related player ignored');
  // A members-only page: no video, and the reason is the login wall.
  await p.goto(base + '/watch/members');
  const mp = await p.evaluate(mediaProbe(false));
  assert.equal(mp.out.length, 0);
  assert.ok(mp.loginWall);
  assert.match(explainNoMedia(mp, []).message, /logged in/);

  await browser.close();
  server.close();
  console.log('page video finder: all checks passed');
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
