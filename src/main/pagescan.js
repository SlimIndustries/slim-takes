'use strict';
// Page scan: the backup for channel/profile links the engine can't read.
// Opens the page in a locked-down window (like Slim Reaper reads pages), clicks past age/entry
// popups, collects the video links, follows "next page" links, and hands the videos back as a list.
// Nothing here is specific to any one site.

const { BrowserWindow, session } = require('electron');
const { crawl, resolveLinks } = require('./crawl');

const PAGE_TIMEOUT = 30000;
const PARTITION = 'slimtakes-pagescan'; // separate from the app; not kept after quit

let prepared = false;
let visibleWin = null;
const borrowedUA = new Map(); // site -> the user's own browser identity, when its pass was borrowed

// Is the page Cloudflare's "are you human" check?
const CF_CHECK = String.raw`(() => !!(window._cf_chl_opt || /^just a moment/i.test(document.title) ||
  document.querySelector('#challenge-form, #challenge-stage, #challenge-running, iframe[src*="challenges.cloudflare.com"]')))()`;
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

/** Forget everything the scan windows stored (cookies from clicking popups, cache). */
async function clearScanData() {
  const ses = session.fromPartition(PARTITION);
  borrowedUA.clear();
  await Promise.all([ses.clearStorageData().catch(() => {}), ses.clearCache().catch(() => {})]);
}

module.exports = { pageScan, openVisible, scanVisible, closeVisible, clearScanData, followLinks, fetchPage, siteCookies, usePass, isScanningVisible, CF_CHECK };
