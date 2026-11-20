// End-to-end check of Page scan's crawler against a local test site shaped like the real failing one:
// an age popup, tracking links that forward to the real video pages, a normal "Next" link,
// then a "Next" button that loads more videos by script.
const http = require('http');
const assert = require('assert/strict');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { crawl, resolveLinks } = require('../../src/main/crawl');
const { chooseVideos } = require('../../src/main/choose');

// Second link style used for some of the creator's videos, and a "related videos" sidebar.
const directTiles = (ids, who) => ids.map((id) => `<div class="thumb"><a href="/video-${id}abc/clip_${id}"><img alt="Clip ${id}" src="/img/${id}.jpg"></a><p class="uploader">${who}</p></div>`).join('');
const tiles = (ids) => ids.map((id) => `<div class="thumb"><a href="/prof-video-click/upload/somebody/${id}/clip_${id}"><img alt="Clip ${id}" src="/img/${id}.jpg"></a><p><a href="/prof-video-click/upload/somebody/${id}/clip_${id}">Clip ${id}</a></p><p class="uploader">Somebody</p></div>`).join('');
const nav = '<nav><a href="/">Home</a><a href="/upload">Upload</a><a href="/history">History</a>' + Array.from({ length: 30 }, (_, i) => `<a href="/search/tag${i}">tag${i}</a>`).join('') + '</nav>';
const age = '<div id="age" style="position:fixed;inset:0;background:#00a"><div class="modal"><p>This site contains adult content. I am 18 years old or older</p><button onclick="document.getElementById(\'age\').remove()">Enter</button><a href="#" onclick="return false">Reject all cookies</a></div></div>';

const pages = {
  '/maker/somebody': `<h1>Somebody</h1>${nav}<div id="grid">${tiles([101, 102, 103])}${directTiles([104, 105], 'Somebody')}</div><aside>${directTiles([901, 902], 'Someone Else')}</aside><div class="pagination"><a href="/maker/somebody">1</a><a href="/maker/somebody/2">2</a><a class="next" href="/maker/somebody/2">Next</a></div>${age}`,
  '/maker/somebody/2': `<h1>Somebody</h1>${nav}<div id="grid">${tiles([106, 107, 108, 109, 110])}</div>
    <div class="pagination"><a href="#" id="more">Next</a></div>
    <script>
      let loaded = 0;
      document.getElementById('more').addEventListener('click', (e) => {
        e.preventDefault();
        if (loaded++ === 0) document.getElementById('grid').insertAdjacentHTML('beforeend', ${JSON.stringify(tiles([111, 112, 113, 114, 115]))});
        else document.getElementById('more').remove();
      });
    </script>`
};

// The second test site.
const PER = 6;
const homeHits = { count: 0 };
let flaky = 0;
const gardenTiles = (p) => Array.from({ length: PER }, (_, i) => 1000 + (p - 1) * PER + i).map((id) => `<div class="item"><a href="/video/${id}/clip-${id}/"><img alt="Clip ${id}" src="/i/${id}.jpg"></a></div>`).join('');
const otherChannels = Array.from({ length: 20 }, (_, i) => `<a href="/channel/other${i}/">Other ${i}</a>`).join('');
const pager = (p) => '<div class="pagination">' + [1, 2, 3, 4, 5].map((n) => n === p ? `<span class="active">${n}</span>` : `<a href="/channel/garden/${n === 1 ? '' : n + '/'}">${n}</a>`).join('') + '</div>';
const sticky = '<div style="position:fixed;bottom:0;left:0;right:0" class="bar"><span>Best videos for you</span><a href="/home/">Continue</a><button onclick="location.href=\'/home/\'">OK</button></div>';
function gardenPage(p) {
  if (p === 3 && flaky++ === 0) return `<h1>Garden Collection</h1>${nav}<div class="list"></div>${pager(p)}`;
  return `<h1>Garden Collection</h1>${nav}<div class="list">${gardenTiles(p)}</div><aside>${otherChannels}</aside>${pager(p)}${p === 2 ? sticky : ''}`;
}
const homePage = () => { homeHits.count++; return `<h1>Home</h1>${nav}<div class="list">${Array.from({ length: 20 }, (_, i) => `<div class="item"><a href="/video/${5000 + i}/x-${i}/"><img alt="x" src="/i/x.jpg"></a></div>`).join('')}</div><a class="next" href="/home/2/">Next</a>`; };

const challenge = '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-stage"></div></body></html>';
const checkyTiles = (p) => Array.from({ length: PER }, (_, i) => 3000 + (p - 1) * PER + i).map((id) => `<div class="item"><a href="/video/${id}/c-${id}/"><img alt="C ${id}" src="/i/${id}.jpg"></a></div>`).join('');
// v1.2.5 test sites
const CODES = Array.from({ length: 30 }, (_, i) => {
  const L = 'abcdefghijklmnopqrstuvwxyz';
  const c = 'Qx' + L[i % 26] + L[(i * 5 + 3) % 26].toUpperCase() + L[Math.floor(i / 26)] + 'mLnwJoX'; // 11 letters, unique
  return i % 3 === 0 ? c.slice(0, 10) + (i % 10) : c; // a third have a number, the rest only letters
});
const codedPage = (p) => {
  const mine = p === 1 ? CODES.slice(0, 25) : CODES.slice(25);
  const tiles = mine.map((c) => `<div class="item"><a href="/watch/${c}"><img src="/t/${c}.jpg" alt=""></a><a class="title" href="/watch/${c}">Clip ${c}</a></div>`).join('');
  const pager = p === 1 ? '<div class="pagination"><span class="active">1</span><a href="/star/coded/?p=2">2</a><a class="next" href="/star/coded/?p=2">Next</a></div>' : '<div class="pagination"><a href="/star/coded/">1</a><span class="active">2</span></div>';
  return `<!doctype html><html><head><title>Coded - Videos</title></head><body><h1>Coded</h1>${nav}<div class="list">${tiles}</div>${pager}</body></html>`;
};
const scriptedPage = () => `<!doctype html><html><head><title>Scripted</title></head><body><h1>Scripted</h1>${nav}<div class="list">` +
  Array.from({ length: 6 }, (_, i) => `<div class="tile" data-href="/watch/scr${i}Xy"><img src="/t/s${i}.jpg" alt="Scripted ${i}"><span>Scripted ${i}</span></div>`).join('') + '</div></body></html>';
const endlessPage = () => `<!doctype html><html><head><title>Endless</title></head><body><h1>Endless</h1>${nav}<div id="list" class="list"></div>
<script>
  let n = 0;
  function more() { const l = document.getElementById('list'); for (let i = 0; i < 10 && n < 60; i++, n++) { const d = document.createElement('div'); d.className = 'item'; d.innerHTML = '<a href="/watch/end' + n + '"><img src="/t/e' + n + '.jpg" alt="End ' + n + '"></a>'; l.appendChild(d); } document.body.style.minHeight = (n * 200 + 1000) + 'px'; }
  more();
  window.addEventListener('scroll', () => { if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 50) setTimeout(more, 100); });
</script></body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/star/coded/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(codedPage(Number(u.searchParams.get('p') || 1))); }
  if (u.pathname === '/star/scripted/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(scriptedPage()); }
  if (u.pathname === '/star/endless/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(endlessPage()); }
  const ck = u.pathname.match(/^\/channel\/checky\/(?:(\d+)\/)?$/);
  if (ck) {
    const p = Number(ck[1] || 1);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (p >= 3) return res.end(challenge);
    return res.end(`<!doctype html><html><head><title>Checky - Videos</title></head><body><h1>Checky</h1>${nav}<div class="list">${checkyTiles(p)}</div><a class="next" href="/channel/checky/${p + 1}/">Next</a></body></html>`);
  }
  if (u.pathname === '/channel/checkfirst/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(challenge); }
  const mm = u.pathname.match(/^\/channel\/garden\/(?:(\d+)\/)?$/);
  if (mm || /^\/home\//.test(u.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><html><head><title>Garden Collection - Videos</title></head><body>${mm ? gardenPage(Number(mm[1] || 1)) : homePage()}</body></html>`);
  }
  const m = u.pathname.match(/^\/prof-video-click\/upload\/somebody\/(\d+)\/(\w+)$/);
  if (m) { res.writeHead(302, { Location: `/video-${m[1]}abc/${m[2]}` }); return res.end(); }
  if (/^\/video-\d+abc\//.test(u.pathname)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>video</h1><span id="up">' + (/\/video-9/.test(u.pathname) ? 'Someone Else' : 'Somebody') + '</span>'); }
  if (pages[u.pathname]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<!doctype html><html><head><title>Somebody - Videos</title></head><body>${pages[u.pathname]}</body></html>`); }
  res.writeHead(404); res.end('nope');
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const driver = {
    load: (url) => page.goto(url),
    js: (code) => page.evaluate(code),
    settle: (ms) => page.waitForTimeout(Math.min(ms, 400))
  };
  const lines = [];
  const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
  const res = await crawl(driver, `${base}/maker/somebody`, { log, politeMs: 50, scrolls: 1 });
  assert.equal(res.name, 'Somebody');
  assert.ok(lines.some((l) => /clicked past an entry popup/.test(l)), 'age popup clicked');
  assert.ok(lines.some((l) => /page 3:/.test(l)), 'script Next button followed:\n' + lines.join('\n'));
  // "The engine": a video page is downloadable, and says who uploaded it.
  const lookup = async (u) => {
    const r = await fetch(u);
    const html = await r.text();
    const m = html.match(/<span id="up">([^<]+)</);
    if (!m) throw new Error('Unsupported URL');
    return { kind: 'video', url: r.url, channelName: m[1], folder: m[1], id: r.url.match(/video-(\d+)/)[1] };
  };
  const chosen = await chooseVideos(res, `${base}/maker/somebody`, {
    lookup, follow: (items) => resolveLinks(items, (url, init) => fetch(url, init)), log
  });
  const ids = chosen.videos.map((v) => Number(new URL(v.url).pathname.match(/video-(\d+)/)[1])).sort((a, b) => a - b);
  assert.deepEqual(ids, [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115], 'every creator video, both link styles, all pages:\n' + ids + '\n' + lines.join('\n'));
  assert.equal(chosen.owner.folder, 'Somebody');

  // A site whose links are already real: nothing is changed.
  const plain = [{ url: `${base}/video-1abc/x`, title: 'x' }];
  assert.deepEqual(await resolveLinks(plain, (url, init) => fetch(url, init)), plain);

  // ---- A channel shaped like the second real failure: a sticky bar whose "Continue" button leads
  // to another page (the home page, full of other people's videos), numbered pages with no Next link,
  // and one page that comes back empty the first time.
  const lines2 = [];
  const log2 = { info: (m) => lines2.push(m), warn: (m) => lines2.push(m) };
  const progress = [];
  const res2 = await crawl(driver, `${base}/channel/garden/`, { log: log2, politeMs: 20, scrolls: 1, onProgress: (t) => progress.push(t) });
  const ids2 = res2.groups.flatMap((g) => g.items).map((v) => v.url).filter((u) => /\/video\//.test(u)).map((u) => Number(u.match(/\/video\/(\d+)\//)[1])).sort((a, b) => a - b);
  const want = Array.from({ length: 5 * PER }, (_, i) => 1000 + i);
  assert.deepEqual(ids2, want, 'every page of the channel, nothing from the home page:\n' + ids2 + '\n' + lines2.join('\n'));
  assert.ok(lines2.some((l) => /went to another page, going back/.test(l)), 'derail noticed');
  assert.ok(lines2.some((l) => /nothing new, reloading it once/.test(l)), 'empty page reloaded');
  assert.ok(progress.some((t) => /page 3 of 5/.test(t)), 'progress shows the page count: ' + progress.join(' | '));
  assert.equal(homeHits.count, 1, 'went to the home page only once');

  // ---- The site's "are you human" check comes back on page 3: keep pages 1-2 and say where it stopped.
  const lines3 = [];
  const res3 = await crawl(driver, `${base}/channel/checky/`, { log: { info: (m) => lines3.push(m), warn: () => {} }, politeMs: 20, scrolls: 1 });
  const ids3 = res3.groups.flatMap((g) => g.items).map((v) => v.url).filter((u) => /\/video\//.test(u)).length;
  assert.equal(res3.checkStoppedAt, 3, lines3.join('\n'));
  assert.equal(ids3, 2 * PER, 'kept pages 1-2');
  // ...and on page 1: a clear "protected" error (so the app offers Open the page)
  let err;
  try { await crawl(driver, `${base}/channel/checkfirst/`, { politeMs: 20, scrolls: 1 }); } catch (e) { err = e; }
  assert.ok(err && err.siteCheck && /protected by Cloudflare/.test(err.message), String(err));

  // ---- v1.2.5: code-style IDs (some without any number), two links per tile, two pages: 25 + 5.
  const resA = await crawl(driver, `${base}/star/coded/`, { politeMs: 20, scrolls: 1 });
  const gotA = new Set(resA.groups.flatMap((g) => g.items).map((v) => v.url.split('/').pop()));
  for (const c of CODES) assert.ok(gotA.has(c), 'missing ' + c);
  assert.equal(resA.groups.find((g) => /watch/.test(g.shape)).items.length, 30, 'all 30, including codes with no number: ' + JSON.stringify(resA.groups.map((g) => [g.shape, g.items.length])));
  // ---- tiles made clickable by code (no normal links)
  const resC = await crawl(driver, `${base}/star/scripted/`, { politeMs: 20, scrolls: 1 });
  assert.equal(resC.groups.flatMap((g) => g.items).filter((v) => /\/watch\//.test(v.url)).length, 6, 'scripted tiles read');
  // ---- endless scroll: 60 videos, 10 more each time you scroll to the bottom
  const resD = await crawl(driver, `${base}/star/endless/`, { politeMs: 20, scrolls: 4 });
  assert.equal(resD.groups.flatMap((g) => g.items).filter((v) => /\/watch\//.test(v.url)).length, 60, 'kept scrolling until nothing new');
  // ---- the page limit: says so only when there really were more pages
  const resE = await crawl(driver, `${base}/star/coded/`, { politeMs: 20, scrolls: 1, maxPages: 1 });
  assert.equal(resE.hitPageLimit, true);
  assert.equal(resA.hitPageLimit, false);

  await browser.close();
  server.close();
  console.log('crawler end-to-end: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
