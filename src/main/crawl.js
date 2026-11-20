'use strict';
// Walks a profile's pages and collects its video links. Works with any "driver" (a real hidden
// window in the app, or a test browser), so it can be tested without Electron.
//
// driver = { load(url), js(code), settle(ms) }

const { candidateGroups, nameFromUrl, summarise, COLLECT, AGE_CLICK, CLICK_NEXT } = require('./scanlogic');

const countLinks = (all, url) => candidateGroups(all, url).reduce((n, g) => n + g.items.length, 0);
const { cleanName } = require('./naming');

const MAX_PAGES = 40;
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Is this the same page (ignoring #fragments and a trailing slash)?
function samePage(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    const p = (u) => u.pathname.replace(/\/+$/, '') || '/';
    return x.host === y.host && p(x) === p(y) && x.search === y.search;
  } catch { return a === b; }
}

async function readPage(driver, { log, quiet, scrolls = 4, state }) {
  // Click past age/entry popups (up to twice: an age check, then maybe a cookie banner).
  // If a click lands somewhere else, go straight back and stop clicking popups for this scan.
  if (!state.noClick) {
    for (let i = 0; i < 2; i++) {
      const before = await driver.js('location.href').catch(() => null);
      const clicked = await driver.js(AGE_CLICK).catch(() => null);
      if (!clicked) break;
      if (log) log.info('Page scan: clicked past an entry popup');
      await driver.settle(2500);
      const after = await driver.js('location.href').catch(() => null);
      if (before && after && !samePage(before, after)) {
        if (log) log.info('Page scan: that popup button went to another page, going back (no more popup clicks this scan)');
        state.noClick = true;
        await driver.load(before);
        break;
      }
    }
  }
  // Let lazy-loading galleries fill in.
  for (let i = 0; i < scrolls; i++) {
    await driver.js('window.scrollTo(0, document.body ? document.body.scrollHeight : 0)').catch(() => {});
    await wait(scrolls > 1 ? 700 : 100);
  }
  const res = await driver.js(COLLECT);
  if (log && !quiet) log.info(`Page scan saw ${res.links.length} links. Most common kinds: ${summarise(res.links, res.at) || 'none'}`);
  return res;
}

// This profile's numbered pages (1 2 3 … 23): links that sit under the profile's own address.
function pageLinks(res, startUrl) {
  let base;
  try { base = new URL(startUrl); } catch { return []; }
  const prefix = base.pathname.replace(/\/+$/, '');
  return (res.numbered || []).filter((p) => {
    try {
      const u = new URL(p.href);
      return u.host === base.host && p.n > 0 && p.n < 10000 && (u.pathname === base.pathname || u.pathname.replace(/\/+$/, '') === prefix || u.pathname.startsWith(prefix + '/'));
    } catch { return false; }
  });
}

async function crawl(driver, startUrl, { log, onProgress, quiet, firstLoaded = false, politeMs = 1200, scrolls = 4, maxPages = MAX_PAGES } = {}) {
  const all = [];
  let name = '';
  const visited = new Set();
  const state = { noClick: false };
  let nextUrl = startUrl;
  let viaButton = false;
  let lastPage = 0;      // highest page number the site shows
  let empties = 0;       // pages in a row that added nothing
  let siteNum = null;    // the site's own number for the page just read
  for (let page = 1; page <= maxPages; page++) {
    const of = lastPage > page ? ` of ${lastPage}` : '';
    if (onProgress) onProgress(`Reading the page directly… page ${page}${of}`);
    if (!viaButton) {
      if (!nextUrl || visited.has(nextUrl)) break;
      visited.add(nextUrl);
      if (!(firstLoaded && page === 1)) await driver.load(nextUrl);
    }
    let res = await readPage(driver, { log, quiet, scrolls, state });
    if (log && !quiet) log.info(`Page scan page ${page} address: ${res.at}`);
    if (page === 1) name = res.h1 || (res.title || '').split(/\s+[|\-–—:]\s+/)[0];
    let before = countLinks(all, startUrl);
    let found = countLinks([...all, ...res.links], startUrl);
    if (page > 1 && found === before && !viaButton && res.at) {
      // Nothing new: could be a hiccup. Reload the page once before deciding.
      if (log) log.info(`Page scan page ${page}: nothing new, reloading it once`);
      await driver.load(res.at);
      res = await readPage(driver, { log, quiet, scrolls, state });
      found = countLinks([...all, ...res.links], startUrl);
    }
    if (res.at) visited.add(res.at);
    all.push(...res.links);
    if (log) log.info(`Page scan page ${page}: ${found} possible video links so far`);
    const nums = pageLinks(res, startUrl);
    for (const p of nums) lastPage = Math.max(lastPage, p.n);
    siteNum = res.current || (siteNum ? siteNum + 1 : page);
    if (page > 1 && found === before) {
      empties++;
      if (empties >= 2) break; // two empty pages in a row: we've reached the end
    } else empties = 0;
    // Where next: the page's Next link, else the next numbered page, else a script "Next" button.
    let nx = res.next && !visited.has(res.next) ? res.next : null;
    if (!nx) {
      const want = nums.find((p) => p.n === siteNum + 1 && !visited.has(p.href));
      if (want) nx = want.href;
    }
    if (nx) { nextUrl = nx; viaButton = false; }
    else if (res.nextButton) {
      const clicked = await driver.js(CLICK_NEXT).catch(() => false);
      if (!clicked) break;
      viaButton = true;
      await driver.settle(3000);
    } else break;
    await wait(politeMs); // be polite
  }
  const groups = candidateGroups(all, startUrl);
  if (log && !quiet) log.info('Page scan link groups: ' + (groups.slice(0, 10).map((g) => `${g.shape} (${g.items.length})`).join(', ') || 'none'));
  return { groups, name: cleanName(name || nameFromUrl(startUrl) || '', null) };
}

// ---------- tracking links ----------
// Some sites link videos through a "click" address that forwards to the real video page.
// If the first link forwards somewhere else, follow every link to its real address.
async function resolveLinks(videos, fetchFn, { onProgress, log, concurrency = 6 } = {}) {
  if (!videos.length) return videos;
  const finalUrl = async (url) => {
    try {
      const res = await fetchFn(url, { method: 'GET', redirect: 'follow' });
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* ignore */ }
      return res.url || url;
    } catch { return url; }
  };
  const same = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.host === y.host && x.pathname === y.pathname; } catch { return a === b; } };
  const first = await finalUrl(videos[0].url);
  if (same(first, videos[0].url)) return videos;
  if (log) log.info('Page scan: video links forward to their real pages, following them');
  const out = videos.map((v) => ({ ...v }));
  out[0].url = first;
  let i = 1, done = 1;
  const worker = async () => {
    while (i < out.length) {
      const k = i++;
      out[k].url = await finalUrl(out[k].url);
      done++;
      if (onProgress && done % 10 === 0) onProgress(`Following video links… ${done} of ${out.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, out.length) }, worker));
  const seen = new Set();
  return out.filter((v) => (seen.has(v.url) ? false : (seen.add(v.url), true)));
}

module.exports = { crawl, resolveLinks };
