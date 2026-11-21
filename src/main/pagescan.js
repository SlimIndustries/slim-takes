'use strict';
// Page scan: the backup for channel/profile links the engine can't read.
// Opens the page in a locked-down window (like Slim Reaper reads pages), clicks past age/entry
// popups, collects the video links, follows "next page" links, and hands the videos back as a list.
// Nothing here is specific to any one site.

const { BrowserWindow, session } = require('electron');
const { crawl, resolveLinks } = require('./crawl');
const { mediaProbe, CF_CHECK } = require('./scanlogic');
const { grabFlow } = require('./grabflow');
const { Lanes } = require('./lanes');

const PAGE_TIMEOUT = 30000;
const PARTITION = 'slimtakes-pagescan'; // separate from the app; not kept after quit

let prepared = false;
let visibleWin = null;
const borrowedUA = new Map(); // site -> the user's own browser identity, when its pass was borrowed
const borrowedPass = new Map(); // site -> the "I'm human" cookie value borrowed from the user's browser

const LOOP_LOADS = 3;        // the check came back this many times...
const LOOP_MS = 45000;       // ...or has been on screen this long

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } }

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function scanSession() {
  const ses = session.fromPartition(PARTITION);
  if (!prepared) {
    ses.on('will-download', (e) => e.preventDefault());
    // Look like a normal Chrome browser: some sites send unknown browsers a different page.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|slim-takes|Slim Takes|SlimTakes)\/\S+/gi, ''));
    prepared = true;
  }
  return ses;
}

function makeWindow(show, parent) {
  const win = new BrowserWindow({
    show,
    parent: show ? parent : undefined,
    width: 1200,
    height: 850,
    title: 'Slim Takes — click past any popups, then press Scan now in Slim Takes',
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setMenuBarVisibility(false);
  if (!show) win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // no pop-up windows or ad tabs
  // No background connection checks from the page (they only add noise and reveal more about the PC).
  try { win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch { /* older Electron */ }
  return win;
}

async function load(win, url) {
  const ua = borrowedUA.get(hostOf(url));
  if (ua) win.webContents.setUserAgent(ua);
  await Promise.race([
    win.loadURL(url),
    wait(PAGE_TIMEOUT).then(() => { throw new Error('The page took too long to load'); })
  ]).catch((e) => { if (!/ERR_ABORTED/.test(e.message)) throw e; });
}

function settle(win, ms = 2500) {
  // Wait for a navigation started by a click (if any) to finish.
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    win.webContents.once('did-stop-loading', () => setTimeout(finish, 400));
    setTimeout(finish, ms);
  });
}

// Wrap a window as a crawl driver.
const CLOSED = 'The page window was closed before the scan finished. Open the page again and leave it open until the scan is done.';
function driverFor(win) {
  const alive = () => { if (win.isDestroyed()) throw new Error(CLOSED); };
  return {
    load: async (url) => { alive(); return load(win, url); },
    js: async (code) => { alive(); return win.webContents.executeJavaScript(code, true); },
    settle: async (ms) => { if (!win.isDestroyed()) await settle(win, ms); }
  };
}

let scanningVisible = false;
function isScanningVisible() { return scanningVisible; }

/** Normal, hidden scan. */
async function pageScan(url, opts = {}) {
  scanSession();
  const win = makeWindow(false);
  try {
    return await crawl(driverFor(win), url, opts);
  } finally {
    win.destroy();
  }
}

/**
 * Show-me mode, step 1: open the page where the user can see it and click past anything.
 * onLoop() is called once if Cloudflare's check keeps coming back (it has decided this window isn't
 * a real browser), so the app can offer the user's own browser instead.
 */
async function openVisible(url, parent, { onLoop } = {}) {
  scanSession();
  closeVisible();
  const win = makeWindow(true, parent);
  visibleWin = win;
  win.on('closed', () => { if (visibleWin === win) visibleWin = null; });
  if (onLoop) watchForLoop(win, onLoop);
  await load(win, url).catch(() => {});
  return true;
}

function watchForLoop(win, onLoop) {
  let loads = 0, since = 0, told = false;
  const isCheck = () => (win.isDestroyed() ? Promise.resolve(false) : win.webContents.executeJavaScript(CF_CHECK, true).catch(() => false));
  const tell = () => { if (!told) { told = true; clearInterval(timer); try { onLoop(); } catch { /* ignore */ } } };
  win.webContents.on('did-finish-load', async () => {
    if (await isCheck()) { loads++; if (loads >= LOOP_LOADS) tell(); }
  });
  const timer = setInterval(async () => {
    if (win.isDestroyed()) { clearInterval(timer); return; }
    if (await isCheck()) { since = since || Date.now(); if (Date.now() - since > LOOP_MS) tell(); }
    else { since = 0; loads = 0; }
  }, 3000);
  win.on('closed', () => clearInterval(timer));
}

/** Use a pass borrowed from the user's own browser in the page windows too (cookies + identity). */
async function usePass(url, cookies, ua) {
  const ses = scanSession();
  const host = hostOf(url);
  if (ua && host) borrowedUA.set(host, ua);
  const cf = cookies.find((c) => /^cf_clearance$/i.test(c.name));
  if (cf && host) borrowedPass.set(host, cf.value);
  for (const c of cookies) {
    const domain = String(c.domain || '');
    try {
      await ses.cookies.set({ url: `https://${domain.replace(/^\./, '')}${c.path || '/'}`, name: c.name, value: c.value,
        domain: c.hostOnly ? undefined : domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
        expirationDate: c.expirationDate });
    } catch { /* a cookie the window won't take: skip it */ }
  }
}

/** Show-me mode, step 2: read the page the user is looking at (and its next pages). */
async function scanVisible(startUrl, opts = {}) {
  if (!visibleWin || visibleWin.isDestroyed()) throw new Error('The page window was closed. Open the page again.');
  const win = visibleWin;
  scanningVisible = true;
  try {
    // Use wherever the user ended up (they may have clicked through to the videos).
    return await crawl(driverFor(win), startUrl, { ...opts, firstLoaded: true });
  } catch (e) {
    throw win.isDestroyed() ? new Error(CLOSED) : e;
  } finally {
    scanningVisible = false;
    closeVisible();
  }
}

function closeVisible() {
  if (visibleWin && !visibleWin.isDestroyed()) visibleWin.destroy();
  visibleWin = null;
}

// Follow tracking links, using the scan's own session (same cookies as the page).
function followLinks(videos, opts) {
  const ses = scanSession();
  return resolveLinks(videos, (url, init) => ses.fetch(url, init), opts);
}

/** Fetch a page's HTML the way a normal browser would (same cookies as Page scan). */
async function fetchPage(url, timeoutMs = 15000) {
  const ses = scanSession();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await ses.fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 2_000_000);
  } catch { return null; } finally { clearTimeout(t); }
}

/** The scan window's cookies for a site (e.g. the Cloudflare "I'm human" pass) and its browser identity. */
async function siteCookies(url) {
  const ses = scanSession();
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return { cookies: [], ua: ses.getUserAgent() }; }
  const all = await ses.cookies.get({});
  const cookies = all.filter((c) => { const d = String(c.domain || '').replace(/^\./, ''); return d === host || d.endsWith('.' + host) || host.endsWith('.' + d) || d === 'www.' + host; });
  return { cookies, ua: ses.getUserAgent() };
}

/**
 * Did the page window earn its own fresh "I'm human" pass for this site (rather than only
 * carrying the one borrowed from the user's browser)? The freshest pass should win.
 */
function freshWindowPass(url, cookies) {
  const cf = (cookies || []).find((c) => /^cf_clearance$/i.test(c.name));
  if (!cf) return false;
  return borrowedPass.get(hostOf(url)) !== cf.value;
}

// ---------- getting a video straight from its page ----------
// For sites that refuse the engine, or that the engine doesn't know: open the video page in a hidden
// window, let its player start, and note the video file it asks for. Two pages at a time at most;
// strict (Cloudflare) sites one at a time.
const lanes = new Lanes(2);

// One listener for the whole page-window session, handing each window's requests to its own grab.
const collectors = new Map(); // webContents id -> { media: Map, requests: [] }
let listening = false;
function listen(ses) {
  if (listening) return;
  listening = true;
  const header = (h, name) => { for (const k of Object.keys(h || {})) if (k.toLowerCase() === name) return [].concat(h[k])[0]; return ''; };
  ses.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (d) => {
    const c = collectors.get(d.webContentsId);
    if (!c) return;
    if (c.requests.length < 400) c.requests.push(d.url);
    const type = String(header(d.responseHeaders, 'content-type'));
    if (MEDIA_TYPE.test(type) || MEDIA_URL.test(d.url)) c.media.set(d.url, { url: d.url, type, len: fileSize(d.statusCode, header(d.responseHeaders, 'content-range'), header(d.responseHeaders, 'content-length')) });
  });
}

/**
 * Get the video from a page. opts: { useVisible, log, solo (one page at a time for this site),
 * check (only say whether it's a video page: no cookies or page copy needed) }.
 */
async function grabMedia(url, opts = {}) {
  const release = await lanes.acquire(hostOf(url) || url, !!opts.solo);
  try {
    return await doGrab(url, opts);
  } finally {
    // Be polite between pages: a short, slightly random pause before the next one.
    setTimeout(release, opts.noPause ? 0 : 800 + Math.floor(Math.random() * 1700));
  }
}

const MEDIA_TYPE = /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
const MEDIA_URL = /\.(mp4|m4v|webm|mov|m3u8|mpd)(\?|$)/i;

/**
 * A file's full size from a response. Players ask for videos in chunks ("bytes 0-65535/123456789"):
 * the chunk's own length is not the file's size. 0 = not known.
 */
function fileSize(status, contentRange, contentLength) {
  const m = String(contentRange || '').match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  if (status === 206) return 0;
  return Number(contentLength) || 0;
}

function siteError(message, props) { return Object.assign(new Error(message), props); }

async function doGrab(url, { useVisible = false, log, timeoutMs = 30000, check = false } = {}) {
  const ses = scanSession();
  listen(ses);
  let win = useVisible && visibleWin && !visibleWin.isDestroyed() ? visibleWin : null;
  const own = !win;
  if (own) win = makeWindow(false);
  win.webContents.setAudioMuted(true);
  const wcId = win.webContents.id;
  const got = { media: new Map(), requests: [] };
  collectors.set(wcId, got);
  let status = 0;
  const onNav = (e, navUrl, code) => { status = code || status; };
  win.webContents.on('did-navigate', onNav);
  const alive = () => { if (win.isDestroyed()) throw new Error('The page window was closed.'); };
  const checked = new Map(); // link -> first-bytes check (asked once per link)

  // The page window, as the shared grab steps (grabflow.js) see it.
  const driver = {
    async open(u) {
      alive();
      status = 0;
      let loadError = null;
      try { await load(win, u); } catch (e) { loadError = e; }
      if (!status && loadError) throw loadError;
      return { status };
    },
    here: () => (win.isDestroyed() ? '' : win.webContents.getURL()),
    js: async (code) => { alive(); return win.webContents.executeJavaScript(code, true); },
    async probeAll() {
      alive();
      const code = mediaProbe(false);
      const top = await win.webContents.executeJavaScript(code, true).catch(() => null);
      const out = top ? [...top.out] : [];
      let duration = top && top.duration;
      let framePlayer = false;
      let loginWall = !!(top && top.loginWall);
      let frames = [];
      try { frames = win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame); } catch { /* ignore */ }
      for (const f of frames.slice(0, 12)) {
        const r = await Promise.race([f.executeJavaScript(code, true).catch(() => null), wait(4000).then(() => null)]);
        if (!r) continue;
        out.push(...r.out);
        if (!duration && r.duration) duration = r.duration;
        if (r.player && r.player.w >= 320 && r.player.h >= 180) framePlayer = true;
        if (r.loginWall) loginWall = true;
      }
      const base = top || { title: '', thumb: null, at: url, ua: null, player: null };
      return { ...base, out, duration, framePlayer, loginWall };
    },
    async clickAt(x, y) {
      alive();
      // A real mouse click (players that ignore clicks made by page scripts still react to this).
      const wc = win.webContents;
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await wait(60);
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    },
    media: () => [...got.media.values()],
    requests: () => got.requests,
    async fetchStart(mediaUrl) {
      if (checked.has(mediaUrl)) { const c = checked.get(mediaUrl); if (c.error) throw c.error; return c; }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await ses.fetch(mediaUrl, { signal: ctl.signal, referrer: url, headers: { Range: 'bytes=0-4095', 'User-Agent': win.isDestroyed() ? ses.getUserAgent() : win.webContents.getUserAgent() } });
        if (res.status >= 400) throw new Error('the site answered ' + res.status);
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        const parts = [];
        let size = 0;
        while (reader && size < 4096) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          size += value.length;
        }
        if (reader) reader.cancel().catch(() => {});
        const bytes = new Uint8Array(size);
        let o = 0;
        for (const part of parts) { bytes.set(part, o); o += part.length; }
        // The file's full size: "bytes 0-4095/123456789", or the plain length if the site ignored the range.
        const range = res.headers.get('content-range') || '';
        const m = range.match(/\/(\d+)\s*$/);
        const total = m ? Number(m[1]) : (res.status === 200 ? Number(res.headers.get('content-length')) || null : null);
        const out = { bytes: bytes.slice(0, 4096), type: res.headers.get('content-type') || '', total };
        checked.set(mediaUrl, out);
        return out;
      } catch (e) {
        checked.set(mediaUrl, { error: e });
        throw e;
      } finally { clearTimeout(timer); ctl.abort(); }
    },
    settle: (ms) => settle(win, ms),
    // Some players won't start in a hidden window: "show" it, but invisible, unclickable, off the taskbar.
    async wakeUp() {
      if (!own || win.isDestroyed()) return;
      try {
        win.setOpacity(0);
        win.setIgnoreMouseEvents(true);
        win.setSkipTaskbar(true);
        win.setFocusable(false);
        win.showInactive();
        await wait(500);
      } catch { /* ignore */ }
    }
  };

  try {
    const r = await grabFlow(driver, url, { log: log ? (m) => log.info(m) : null, timeoutMs, check });
    if (check) return { media: r.media, videoPage: r.videoPage, title: r.info && r.info.title, duration: r.info && r.info.duration };
    const info = r.info || {};
    const found = r.media;
    if (log) log.info(`Got the video from the page (${found.hls ? 'stream' : 'file'}${found.height ? ', ' + found.height + 'p' : ''})`);
    const html = await driver.js('document.documentElement.outerHTML').catch(() => '');
    // Cookies for the site and for wherever the video file lives.
    const hosts = [hostOf(url), hostOf(found.url), ...(found.alternates || []).map((c) => hostOf(c.url))].filter(Boolean);
    const all = await ses.cookies.get({});
    const cookies = all.filter((c) => { const d = String(c.domain || '').replace(/^\./, '').replace(/^www\./, ''); return hosts.some((h) => d === h || h.endsWith('.' + d) || d.endsWith('.' + h)); });
    return { media: found, videoPage: r.videoPage, title: info.title, thumbnail: info.thumb, duration: info.duration, at: url, ua: info.ua || (win.isDestroyed() ? ses.getUserAgent() : win.webContents.getUserAgent()), html, cookies };
  } finally {
    collectors.delete(wcId);
    if (!win.isDestroyed()) win.webContents.removeListener('did-navigate', onNav);
    if (own && !win.isDestroyed()) win.destroy();
  }
}

function sameAddress(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.host.replace(/^www\./, '') === y.host.replace(/^www\./, '') && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch { return false; }
}

/** Forget everything the scan windows stored (cookies from clicking popups, cache). */
async function clearScanData() {
  const ses = session.fromPartition(PARTITION);
  borrowedUA.clear();
  borrowedPass.clear();
  await Promise.all([ses.clearStorageData().catch(() => {}), ses.clearCache().catch(() => {})]);
}

module.exports = { pageScan, openVisible, scanVisible, closeVisible, clearScanData, followLinks, fetchPage, siteCookies, usePass, isScanningVisible, freshWindowPass, grabMedia, CF_CHECK };
