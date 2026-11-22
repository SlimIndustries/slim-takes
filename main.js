'use strict';
// Slim Takes — main process.

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, protocol, nativeImage, powerSaveBlocker, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { Logger, JsonStore, postJson, fetchJson, ensureDir, compareVersions } = require('./src/main/util');
const { Engine } = require('./src/main/engine');
const { Library } = require('./src/main/library');
const { Prober } = require('./src/main/probe');
const { Queue } = require('./src/main/queue');
const { History } = require('./src/main/history');
const { Watch } = require('./src/main/watch');
const { extractLinks, looksLikeVideo } = require('./src/main/urls');
const { estimateBytes } = require('./src/main/formats');
const settingsMod = require('./src/main/settings');
const { serveFile } = require('./src/main/range');
const { contextMenuTemplate } = require('./src/main/contextmenu');
const { Converter, isMediaName } = require('./src/main/convert');
const { startMediaServer } = require('./src/main/mediaserver');
const { FolderSync } = require('./src/main/sync');
const { pageScan, openVisible, scanVisible, closeVisible, clearScanData, followLinks, fetchPage, siteCookies, usePass, isScanningVisible, freshWindowPass, grabMedia } = require('./src/main/pagescan');
const { BROWSERS, LABEL: BROWSER_LABEL, browserIdentity, exportBrowserCookies, readCookieFile } = require('./src/main/browserpass');
const { Sites, hostOf } = require('./src/main/sites');
const { uploaderFromHtml, nameFromUrl, cleanPageTitle } = require('./src/main/scanlogic');
const { cleanName } = require('./src/main/naming');
const { chooseVideos } = require('./src/main/choose');

app.setAppUserModelId('com.slimindustries.slimtakes');
// Present as plain Chrome everywhere, including background parts of pages (workers), not just the
// page itself: "are you human" checks loop forever when the two don't match.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|slim-takes|Slim Takes|SlimTakes)\/\S+/gi, '');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'slimfile', privileges: { stream: true, supportFetchAPI: true, secure: true, standard: false } }
]);

const ICON = path.join(__dirname, 'assets', 'icon.png');
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;
let unlocked = false;
let blocker = null;

// ---------- data ----------
const dataDir = app.getPath('userData');
// The app used to be called "Slim Take": bring its data along, once.
const { moveDataFolder, renameSaveFolder } = require('./src/main/migrate');
let movedFromOldName = false;
try { movedFromOldName = moveDataFolder(path.join(app.getPath('appData'), 'Slim Take'), dataDir); } catch { /* start fresh */ }
ensureDir(dataDir);
try { if (fs.existsSync(path.join(dataDir, 'slimtake.log')) && !fs.existsSync(path.join(dataDir, 'slimtakes.log'))) fs.renameSync(path.join(dataDir, 'slimtake.log'), path.join(dataDir, 'slimtakes.log')); } catch { /* ignore */ }
const log = new Logger(path.join(dataDir, 'slimtakes.log'));
log.info(`Slim Takes ${app.getVersion()} starting`);
if (movedFromOldName) log.info('Moved settings, history and engine over from Slim Take');
try { renameSaveFolder(dataDir, log); } catch (e) { log.warn('Save folder rename: ' + e.message); }

const settingsStore = new JsonStore(path.join(dataDir, 'settings.json'), settingsMod.defaults(app.getPath('videos')));
const S = () => settingsStore.get();
{ const up = settingsMod.upgrade(S()); if (up) settingsStore.set(up); }

const engine = new Engine({ dir: path.join(dataDir, 'engine'), log });
const library = new Library({ storeFile: path.join(dataDir, 'library.json'), probeDuration: (f) => engine.probeDuration(f), log });
const sites = new Sites({ store: new JsonStore(path.join(dataDir, 'sites.json'), {}), dir: path.join(dataDir, 'sites'), log });
const prober = new Prober({ engine, log, sites });
const history = new History(new JsonStore(path.join(dataDir, 'history.json'), []));
// Convert & Trim: files the user picks or drops, converted one at a time.
const converter = new Converter({ engine, log, previewDir: path.join(dataDir, 'previews') });
converter.on('job', (j) => send('convert:job', j));
// The Trim player gets its files from a private local server (see mediaserver.js for why).
let mediaServer = null;
const mediaServerReady = () => (mediaServer = mediaServer || startMediaServer({ allowed: (p) => converter.allowed(p) }).catch((e) => { log.warn('Trim player server: ' + e.message); mediaServer = null; return null; }));
const queue = new Queue({
  engine, library, getSettings: S, log, history,
  store: new JsonStore(path.join(dataDir, 'queue.json'), []),
  notify: { done: (it) => notifyDone(it), failed: (it) => notifyFailed(it) },
  sites,
  resolveDirect: async (url, { quiet } = {}) => { const d = await grabDirect(url, { quiet }); delete d.grab; return d; }
});
const watch = new Watch({ store: new JsonStore(path.join(dataDir, 'watch.json'), { channels: [], lastRun: 0 }), prober, queue, library, getSettings: S, log, scanList: (url) => scanList(url) });

const folderSync = new FolderSync({ getRoot: () => S().folder, history, queue, library, log });

unlocked = !S().pinHash;

// ---------- window ----------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function savedBounds() {
  const b = S().windowBounds;
  if (!b || !b.width || !b.height) return { width: 1280, height: 820 };
  // Only reuse the old spot if it's still on a connected screen.
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y >= area.y - 20 && b.y < area.y + area.height - 100;
  return visible ? b : { width: b.width, height: b.height };
}

function createWindow() {
  const bounds = savedBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0b0a0e',
    title: 'Slim Takes',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  // Right-click: Cut / Copy / Paste / Select all in text boxes.
  win.webContents.on('context-menu', (_e, params) => {
    const t = contextMenuTemplate(params);
    if (t.length) Menu.buildFromTemplate(t).popup({ window: win });
  });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (S().windowBounds && S().windowBounds.maximized) win.maximize();
    if (!startHidden) win.show();
  });
  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      const maximized = win.isMaximized();
      const b = maximized ? (S().windowBounds || win.getNormalBounds()) : win.getBounds();
      settingsStore.set({ ...S(), windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } });
    }, 500);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);

  // Links clicked inside the app open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (!quitting && S().tray) {
      e.preventDefault();
      win.hide();
      if (!S().trayHintShown) {
        settingsStore.set({ ...S(), trayHintShown: true });
        showNotification('Slim Takes is still running', 'It keeps downloading and watching channels from the tray. Right-click the tray icon to quit.');
      }
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (tray) return;
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Slim Takes');
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Slim Takes', click: showWindow },
    { type: 'separator' },
    queue.paused ? { label: 'Resume downloads', click: () => queue.resumeAll() } : { label: 'Pause downloads', click: () => queue.pauseAll() },
    { label: 'Check watched channels now', click: () => watch.checkAll() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  rebuild();
  queue.on('state', rebuild);
  tray.on('click', showWindow);
}

// ---------- notifications ----------
function showNotification(title, body) {
  if (!S().notifyWindows || !Notification.isSupported()) return;
  try {
    const n = new Notification({ title, body, icon: ICON, silent: false });
    n.on('click', showWindow);
    n.show();
  } catch (e) { log.warn('Notification failed: ' + e.message); }
}

let discordBatch = [];
let discordTimer = null;
function queueDiscord(line) {
  const hook = S().discordWebhook;
  if (!hook) return;
  discordBatch.push(line);
  clearTimeout(discordTimer);
  discordTimer = setTimeout(async () => {
    const lines = discordBatch.splice(0);
    const head = lines.length === 1 ? 'Slim Takes finished a download' : `Slim Takes finished ${lines.length} downloads`;
    let text = `**${head}**\n` + lines.slice(0, 15).map((l) => `• ${l}`).join('\n');
    if (lines.length > 15) text += `\n…and ${lines.length - 15} more`;
    try { await postJson(hook, { username: 'Slim Takes', content: text.slice(0, 1900) }); }
    catch (e) { log.warn('Discord ping failed: ' + e.message); }
  }, 8000);
}

let doneBatch = 0;
let doneTimer = null;
function notifyDone(it) {
  // Private downloads: no titles anywhere, and nothing posted to Discord.
  if (!it.private) queueDiscord(`${it.title} — ${it.folder}`);
  doneBatch++;
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => {
    const n = doneBatch;
    doneBatch = 0;
    if (win && win.isVisible() && win.isFocused()) return;
    if (n === 1 && !it.private) showNotification('Download finished', it.title);
    else showNotification('Downloads finished', `${n} download${n === 1 ? '' : 's'} finished`);
  }, 3000);
}
function notifyFailed(it) {
  if (win && win.isVisible() && win.isFocused()) return;
  showNotification('Download failed', it.private ? 'A download failed' : it.title);
}

// ---------- events to the window ----------
queue.on('item', (v) => send('queue:item', v));
queue.on('list', () => send('queue:list', queue.list()));
queue.on('state', () => send('queue:state', { paused: queue.paused }));
// A site's downloads are held until it gets a fresh pass: say so once.
// A site kept sending web pages instead of videos: its downloads were paused. Say so once.
queue.on('notVideos', ({ host, count, private: priv }) => {
  const where = priv ? 'a site' : host;
  send('queue:notVideos', { host: priv ? null : host, count });
  showNotification('Downloads paused', `${where} is sending web pages instead of videos, so ${count} download${count === 1 ? ' was' : 's were'} paused. It may need you to be logged in. Check a video in your browser, then press Resume all to try again.`);
});
queue.on('onlyPreviews', ({ host, count, private: priv }) => {
  const where = priv ? 'a site' : host;
  send('queue:onlyPreviews', { host: priv ? null : host, count });
  showNotification('Downloads paused', `${where} is only giving previews, not full videos, so ${count} download${count === 1 ? ' was' : 's were'} paused. It may need you to be logged in.`);
});
queue.on('needsPass', ({ host, count, private: priv }) => {
  const where = priv ? 'a site' : host;
  send('queue:needsPass', { host: priv ? null : host, count });
  showNotification('Downloads waiting for a fresh pass', `${count} download${count === 1 ? '' : 's'} from ${where} ${count === 1 ? 'is' : 'are'} waiting. In Slim Takes, use "Open the page" (or your normal browser) to get past the site's check: they'll carry on by themselves.`);
});
queue.on('diskLow', (free) => {
  send('queue:diskLow', free);
  showNotification('Downloads paused', `Only ${(free / 1e9).toFixed(1)} GB left on the drive.`);
});
queue.on('idle', (finished) => {
  send('queue:idle', { finished, whenDone: S().whenDone });
  updatePowerBlock();
});
queue.on('item', () => { updatePowerBlock(); updateTaskbar(); });
queue.on('list', () => updateTaskbar());

// Progress on the taskbar icon while downloading.
let taskbarTimer = null;
function updateTaskbar() {
  if (taskbarTimer) return;
  taskbarTimer = setTimeout(() => {
    taskbarTimer = null;
    if (!win || win.isDestroyed()) return;
    const active = queue.items.filter((i) => ['starting', 'downloading', 'processing'].includes(i.status));
    const waiting = queue.items.filter((i) => i.status === 'waiting').length;
    if (!active.length) {
      if (queue.paused && queue.items.some((i) => i.status === 'paused')) win.setProgressBar(1, { mode: 'paused' });
      else win.setProgressBar(-1);
      return;
    }
    const known = active.filter((i) => i.pct && !i.isLive);
    if (!known.length) { win.setProgressBar(2, { mode: 'indeterminate' }); return; }
    // Average of what's running, scaled by what's still waiting.
    const avg = known.reduce((s, i) => s + i.pct, 0) / known.length / 100;
    const share = active.length / (active.length + waiting);
    win.setProgressBar(Math.max(0.02, Math.min(1, avg * share)), { mode: 'normal' });
  }, 500);
}
history.onChange = () => send('history:changed');
watch.on('changed', () => send('watch:changed', { channels: watch.list(), status: watch.status() }));
log.listeners.add((line) => send('log:line', line));

// Keep the PC awake while something is downloading.
function updatePowerBlock() {
  const busy = queue.items.some((i) => ['starting', 'downloading', 'processing'].includes(i.status));
  if (busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
}

// ---------- IPC ----------
function guard(fn) {
  return async (event, ...args) => {
    if (!unlocked) throw new Error('Locked');
    return fn(...args);
  };
}
const handle = (name, fn) => ipcMain.handle(name, guard(fn));

ipcMain.handle('init', () => ({
  locked: !unlocked,
  version: app.getVersion(),
  settings: settingsMod.publicSettings(S()),
  engine: engine.status(),
  queue: unlocked ? queue.list() : [],
  paused: queue.paused,
  watch: unlocked ? { channels: watch.list(), status: watch.status() } : null,
  freeBytes: freeSpace()
}));

ipcMain.handle('pin:verify', (e, pin) => {
  const s = S();
  if (!s.pinHash) { unlocked = true; return true; }
  const ok = hashPin(String(pin || ''), s.pinSalt) === s.pinHash;
  if (ok) unlocked = true;
  return ok;
});

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

handle('pin:set', (pin) => {
  const s = { ...S() };
  if (pin == null || pin === '') { s.pinHash = null; s.pinSalt = null; }
  else {
    if (!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN must be 4 to 8 digits');
    s.pinSalt = crypto.randomBytes(16).toString('hex');
    s.pinHash = hashPin(String(pin), s.pinSalt);
  }
  settingsStore.set(s);
  return settingsMod.publicSettings(s);
});

handle('settings:set', (patch) => {
  const { next, rejected } = settingsMod.applyPatch(S(), patch);
  if (rejected.length) log.warn('Ignored settings: ' + rejected.join(', '));
  settingsStore.set(next);
  if ('startWithWindows' in patch) applyLoginItem();
  if ('watchInterval' in patch) send('watch:changed', { channels: watch.list(), status: watch.status() });
  if ('folder' in patch) { try { ensureDir(next.folder); } catch (e) { log.warn('Folder: ' + e.message); } folderSync.start(); folderSync.runSoon(); }
  if ('autoClearDays' in patch) autoClear();
  return settingsMod.publicSettings(next);
});

handle('engine:status', () => engine.status());
handle('engine:install', async (force) => {
  try {
    const st = await engine.install((step) => send('engine:step', step), { force: !!force });
    settingsStore.set({ ...S(), lastEngineUpdate: Date.now() });
    return { ok: true, status: st };
  } catch (e) {
    log.error('Engine setup failed: ' + e.message);
    return { ok: false, message: e.message, status: engine.status() };
  }
});
handle('engine:update', async () => {
  const r = await engine.updateYtdlp();
  if (r.ok) settingsStore.set({ ...S(), lastEngineUpdate: Date.now() });
  return r;
});
handle('engine:version', () => engine.version());

handle('links:extract', (text) => extractLinks(text));

// ---------- sites that refuse the engine: get the video through the page window ----------
// The page window can view the page; it lets the player start, notes the video file it asks for,
// and that file is downloaded with the window's pass and identity.
async function grabDirect(url, { quiet = false, useVisible = false } = {}) {
  log.info(quiet ? 'Getting a video from its page (private mode)' : 'Getting the video from its page: ' + url);
  const pass = await ensureBrowserPass(url);
  let g;
  try {
    g = await grabMedia(url, { useVisible, log: quiet ? null : log, solo: strictSite(url) });
  } catch (e) {
    if (e.siteCheck) {
      log.info('Page window: the site\'s check came up' + (pass.from ? ` (using the pass from ${pass.from === 'browser' ? 'your browser' : 'the page window'}${pass.expired ? ', which has expired' : ''})` : ' (no pass saved)'));
      e.passExpired = !!pass.expired;
      e.bothRefused = sites.hasPass(url);
    }
    throw e;
  }
  return {
    mediaUrl: g.media.url, referer: g.at || url, ua: g.ua, cookieFile: sites.writeDirectCookies(url, g.cookies), grab: g,
    // Other addresses the player showed for the video: used too if they hold the very same file.
    alternates: (g.media.alternates || []).map((c) => c.url).filter((u) => u && u !== g.media.url).slice(0, 3),
    // What the page says about the video: lets the queue fix up names and lengths before saving.
    info: { title: cleanPageTitle(g.title, hostOf(url) || ''), duration: Number.isFinite(g.duration) ? Math.round(g.duration) : null, thumbnail: g.thumbnail || null }
  };
}

// Strict sites (behind Cloudflare) get one page-window page at a time.
function strictSite(url) { const e = sites.get(hostOf(url)); return !!(e && e.impersonate); }

// The page window keeps cookies only in memory: after a restart, load the pass borrowed from the
// user's browser back in (it's saved on disk for the engine). Also says if that pass has run out.
const loadedPasses = new Set();
async function ensureBrowserPass(url) {
  const from = sites.passFrom(url);
  if (from !== 'browser') return { from };
  const host = hostOf(url);
  const entry = sites.get(host);
  let cookies = [];
  try { cookies = readCookieFile(fs.readFileSync(entry.pass.file, 'utf8'), host); } catch { return { from }; }
  const cf = cookies.find((c) => /^cf_clearance$/i.test(c.name));
  const expired = !!(cf && cf.expirationDate && cf.expirationDate * 1000 < Date.now());
  if (!loadedPasses.has(host)) {
    await usePass(url, cookies, entry.pass.ua);
    loadedPasses.add(host);
  }
  return { from, expired };
}

// What to tell the user when a site's protection stops a lookup.
function blockedMessage(e) {
  if (e && e.passExpired) return 'Page scan: your browser pass for this site has expired. Press "Open the page", then "Check keeps repeating? Use your normal browser instead", and do the steps again.';
  if (e && e.bothRefused) return 'Page scan: this site refused Slim Takes even with your pass (it\'s blocking download apps right now). If your normal browser shows an "are you human" check on this page, tick it there, then press "Open the page" → "Use your normal browser instead" → Done. Otherwise try again later.';
  return 'Page scan: this site is protected by Cloudflare. Press "Open the page", tick the "I\'m human" box if it shows one, then press Scan now.';
}
const isSiteCheck = (e) => !!(e && (e.siteCheck || e.passExpired || e.bothRefused));

async function grabVideo(url, opts = {}) {
  const d = await grabDirect(url, opts);
  const g = d.grab;
  delete d.grab;
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const uploader = uploaderFromHtml(g.html);
  const segs = (() => { try { return new URL(url).pathname.split('/').filter(Boolean); } catch { return []; } })();
  return {
    kind: 'video',
    url,
    id: segs[segs.length - 1] || url,
    extractor: 'Generic',
    site: host,
    title: cleanPageTitle(g.title, host) || segs[segs.length - 1] || 'Untitled',
    folder: cleanName(uploader || host || 'Other'),
    channelName: uploader || '',
    hasUploader: true, // (read from the page already; don't fetch it again)
    duration: Number.isFinite(g.duration) ? Math.round(g.duration) : null,
    thumbnail: g.thumbnail || null,
    uploadDate: null,
    heights: g.media.height ? [g.media.height] : [],
    isLive: false,
    viaPage: true,
    direct: d
  };
}

// Video files taken from a page are handed to the window as a ticket, never as file paths.
const directTickets = new Map();
function ticketFor(result) {
  if (result && result.direct && typeof result.direct === 'object') {
    const t = crypto.randomUUID();
    directTickets.set(t, result.direct);
    result.direct = t;
  }
  return result;
}

/**
 * Look up one video. If its site refuses the engine even with a pass, or the engine doesn't know
 * the site at all, go through the page window instead.
 * opts.check: only checking whether this is a video page (Channel grab's test): no download details.
 */
async function lookupVideo(url, opts = {}) {
  const quiet = !!opts.private;
  const viaWindow = () => (opts.check ? checkVideoPage(url, { quiet }) : grabVideo(url, { quiet, useVisible: opts.useVisible }));
  if (looksLikeVideo(url) && sites.needsWindow(url)) return viaWindow();
  try {
    return await prober.lookup(url, { include: opts.include, quiet, cookiesBrowser: S().cookiesBrowser, onLine: (l) => send('lookup:line', l) });
  } catch (e) {
    if (looksLikeVideo(url) && sites.hasPass(url) && sites.isBlocked(url, e.message)) {
      log.info('The site refused the engine even with its pass: using the page window for its videos');
      sites.markNeedsWindow(url);
      return viaWindow();
    }
    if (looksLikeVideo(url) && /Unsupported URL/i.test(e.message)) {
      log.info('The engine doesn\'t know this site: trying the page window');
      const r = await viaWindow();
      sites.markNeedsWindow(url); // worked: this site's videos go through the page window
      return r;
    }
    throw e;
  }
}

/** Channel grab's test: is this link the page of one video? (A proper player and a video file.) */
async function checkVideoPage(url, { quiet } = {}) {
  await ensureBrowserPass(url).catch(() => {});
  const g = await grabMedia(url, { log: quiet ? null : log, solo: strictSite(url), check: true });
  if (!g.videoPage) throw new Error('Not a video page (no main player)');
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const segs = (() => { try { return new URL(url).pathname.split('/').filter(Boolean); } catch { return []; } })();
  return { kind: 'video', url, id: segs[segs.length - 1] || url, extractor: 'Generic', site: host, title: cleanPageTitle(g.title, host),
    folder: cleanName(host || 'Other'), channelName: '', hasUploader: false, duration: Number.isFinite(g.duration) ? Math.round(g.duration) : null,
    thumbnail: null, uploadDate: null, heights: g.media && g.media.height ? [g.media.height] : [], isLive: false, viaPage: true };
}

function logLookupFailure(e, opts) {
  log.warn('Lookup failed: ' + (opts && opts.private ? '[private link]' : String(e && e.message || e).split('\n')[0].slice(0, 300)));
}

handle('lookup', async (url, opts = {}) => {
  try {
    const result = await lookupVideo(url, opts);
    return ticketFor(await decorate(result, opts));
  } catch (e) {
    logLookupFailure(e, opts);
    if (sites.isBlocked(url, e.message) || isSiteCheck(e)) throw new Error(blockedMessage(e));
    if (!/Unsupported URL/i.test(e.message)) throw e;
    // A single video the engine can't read: scanning its page would only collect the "related videos".
    if (looksLikeVideo(url)) throw new Error('Slim Takes can\'t read videos on this site (the download engine doesn\'t support it). If it\'s from a channel or profile, try pasting that link instead.');
    return decorate(await scanList(url, { quiet: !!opts.private }), opts);
  }
});
handle('lookupList', async (url, opts = {}) => {
  try {
    // A single video link opens as that video, never as a list.
    const result = looksLikeVideo(url)
      ? await lookupVideo(url, opts)
      : await prober.lookupList(url, { include: opts.include, cookiesBrowser: S().cookiesBrowser, onLine: (l) => send('lookup:line', l) });
    return ticketFor(await decorate(result, opts));
  } catch (e) {
    logLookupFailure(e, opts);
    if (sites.isBlocked(url, e.message) || isSiteCheck(e)) throw new Error(blockedMessage(e));
    if (!/Unsupported URL/i.test(e.message)) throw e;
    // A single video the engine can't read: scanning its page would only collect the "related videos".
    if (looksLikeVideo(url)) throw new Error('Slim Takes can\'t read videos on this site (the download engine doesn\'t support it). If it\'s from a channel or profile, try pasting that link instead.');
    return decorate(await scanList(url, { quiet: !!opts.private }), opts);
  }
});
handle('pageScan', async (url, opts = {}) => decorate(await scanList(url, { quiet: !!opts.private }), opts));
// Show-me mode: open the page for the user, then read whatever they're looking at.
handle('pageScan:open', async (url) => { await ensureBrowserPass(url).catch(() => {}); return openVisible(url, win, { onLoop: () => { log.info('Page window: the site check keeps repeating'); send('pageScan:loop', url); } }); });
// "Use my browser instead": borrow the site's pass from the user's own browser.
handle('pageScan:useBrowser', async (url, browser) => {
  if (!/^https?:\/\//i.test(String(url)) || !BROWSERS.includes(browser)) throw new Error('Pick a browser first.');
  if (isScanningVisible()) throw new Error('A scan is still reading the page. Wait for it to finish (or Cancel it) first.');
  const cookies = await exportBrowserCookies(engine, browser, url);
  const { ua, target } = await browserIdentity(browser);
  sites.savePass(url, cookies, ua, { from: 'browser', target });
  await usePass(url, cookies, ua);
  loadedPasses.add(hostOf(url));
  closeVisible();
  log.info(`Using ${BROWSER_LABEL[browser]}'s pass for this site`);
  // A clean slate for the site: the engine gets another go, and held downloads carry on.
  sites.clearNeedsWindow(url);
  const resumed = queue.releaseSite(url);
  if (resumed) log.info(`Carrying on with ${resumed} held download(s)`);
  return { ok: true, browser: BROWSER_LABEL[browser] };
});
handle('pageScan:visible', async (url, opts = {}) => {
  if (!looksLikeVideo(url)) {
    const r = await decorate(await scanList(url, { quiet: !!opts.private, visible: true }), opts);
    queue.releaseSite(url); // got through: held downloads from this site carry on
    return r;
  }
  // A single video behind the site check: keep the freshest pass, then look up just that video
  // (through this same window if the site refuses the engine).
  send('grab:status', 'Looking up the video…');
  await keepFreshPass(url);
  try {
    const r = ticketFor(await decorate(await lookupVideo(url, { ...opts, useVisible: true }), opts));
    queue.releaseSite(url);
    return r;
  } catch (e) {
    logLookupFailure(e, opts);
    if (isSiteCheck(e)) throw new Error(blockedMessage(e).replace(/^Page scan: /, ''));
    throw e;
  } finally {
    closeVisible();
  }
});

// If the page window just earned its own "I'm human" pass, it's the freshest: use it for downloads.
// (Otherwise keep the one borrowed from the user's own browser.)
async function keepFreshPass(url) {
  try {
    const { cookies, ua } = await siteCookies(url);
    if (sites.passFrom(url) !== 'browser' || freshWindowPass(url, cookies)) sites.savePass(url, cookies, ua);
  } catch (e) { log.warn('Could not save the site pass: ' + e.message); }
}
handle('pageScan:cancel', () => closeVisible());

// Page scan: read the profile page directly, then check the videos can be downloaded, and use the
// uploader name of a video so the folder matches what a single download would use.
async function scanList(url, { quiet = false, visible = false } = {}) {
  log.info(visible ? 'Page scan (shown page)' : 'Page scan: the engine could not read this link, reading the page directly');
  send('grab:status', 'Reading the page directly…');
  const opts = { log, quiet, onProgress: (t) => send('grab:status', t) };
  await ensureBrowserPass(url).catch(() => {});
  const scan = visible ? await scanVisible(url, opts) : await pageScan(url, opts);
  // If the site gave the window a Cloudflare "I'm human" pass, share it with the engine for this site.
  // (A pass borrowed from the user's own browser is kept, unless the window earned a fresher one.)
  await keepFreshPass(url);
  if (!scan.groups.length) {
    const err = new Error('Page scan couldn\'t find any videos on that page. Try "Open the page": click past any popups yourself, then press Scan now.');
    err.noVideos = true;
    throw err;
  }
  // Let the engine decide which links are this creator's videos.
  const chosen = await chooseVideos(scan, url, {
    lookup: (u) => lookupVideo(u, { private: quiet, check: true }),
    follow: (items) => followLinks(items, { log, onProgress: opts.onProgress }),
    log: quiet ? null : log,
    onProgress: opts.onProgress,
    uploaderOf: async (v) => uploaderFromHtml(await fetchPage(v.url))
  });
  if (!chosen.owner || !chosen.videos.length) {
    throw new Error('Page scan found links on that page, but none of them could be downloaded. Try "Open the page" to check you\'re on the videos page.');
  }
  const first = chosen.owner;
  // The engine doesn't always know who uploaded a video: then the profile page's own name is used.
  const pageName = cleanName(scan.name || nameFromUrl(url) || '', null);
  const folder = first.hasUploader ? first.folder : (pageName || first.folder);
  const creatorName = first.hasUploader ? first.channelName : (pageName || first.channelName);
  const firstKey = (u) => { try { const x = new URL(u); return (x.host + x.pathname).replace(/\/+$/, '').toLowerCase(); } catch { return u; } };
  const ownerKey = firstKey(first.url || '');
  const entries = chosen.videos.map((v) => {
    const isOwner = firstKey(v.url) === ownerKey;
    return {
      id: isOwner ? first.id : null,
      url: v.url,
      extractor: first.extractor,
      title: isOwner ? first.title : v.title,
      duration: isOwner ? first.duration : null,
      uploadDate: isOwner ? first.uploadDate : null,
      thumbnail: v.thumbnail || (isOwner ? first.thumbnail : null),
      folder
    };
  });
  const scanName = scan.name;
  // The site's check came back partway: say how far the list goes.
  const note = scan.checkStoppedAt
    ? `The site's "are you human" check came back on page ${scan.checkStoppedAt}${scan.lastPage ? ' of ' + scan.lastPage : ''}, so this list only has pages 1–${scan.checkStoppedAt - 1}. Press "Open the page" to get past it, then scan again for the rest (videos you already have are skipped).`
    : scan.hitPageLimit ? 'This channel has more than 200 pages: the list has the first 200. Videos you already have are skipped, so you can grab these and scan again later for more.'
    : null;
  return { kind: 'list', scanned: true, url, title: creatorName || scanName || folder, channelName: creatorName, folder, site: first.site, extractor: first.extractor, thumbnail: null, entries, note };
}

// Mark what's already on disk and add size estimates.
async function decorate(result, opts) {
  const s = S();
  const dir = path.join(s.folder, result.folder || 'Other');
  if (result.kind === 'video') {
    const remembered = library.folderFor({ url: result.url, extractor: result.extractor, id: result.id });
    if (remembered) result.folder = remembered;
    else if (!result.hasUploader) {
      // The engine doesn't know the uploader: read it from the video's page, like a person would.
      const name = uploaderFromHtml(await fetchPage(result.url));
      if (name) { result.folder = cleanName(name); result.channelName = name; }
    }
    const vdir = path.join(s.folder, result.folder || 'Other');
    await library.scan(vdir);
    result.have = library.status(vdir, result.title, result.duration, result.extractor, result.id);
    result.savePath = vdir;
    return result;
  }
  const fmt = opts.format || s.format, q = opts.quality || s.quality;
  const scanned = new Set();
  for (const e of result.entries) {
    const d = path.join(s.folder, e.folder || result.folder || 'Other');
    if (!scanned.has(d)) { await library.scan(d); scanned.add(d); }
    e.have = library.status(d, e.title, e.duration, e.extractor || result.extractor, e.id);
    e.estimate = estimateBytes(e.duration, fmt, q);
  }
  result.savePath = dir;
  result.watched = watch.data().channels.some((c) => c.url === result.url);
  return result;
}

handle('queue:add', (specs) => {
  const list = (Array.isArray(specs) ? specs : [specs]).filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url));
  // A video file found on its page comes back as a ticket; swap in the real details (never trust paths from the window).
  for (const x of list) x.direct = typeof x.direct === 'string' ? (directTickets.get(x.direct) || null) : null;
  return queue.addMany(list);
});
handle('queue:action', (action, id) => {
  const fns = { pause: 'pause', resume: 'resume', retry: 'retry', cancel: 'cancel', remove: 'remove' };
  if (fns[action]) queue[fns[action]](id);
  return true;
});
handle('queue:pauseAll', () => queue.pauseAll());
handle('queue:resumeAll', () => queue.resumeAll());
handle('queue:clearFinished', () => queue.clearFinished());
handle('queue:cancelAll', () => queue.cancelAll());
handle('queue:list', () => queue.list());

handle('history:get', () => history.all());
handle('history:remove', (id) => history.remove(id));
handle('history:clear', async () => {
  history.clear();
  library.clearIds();
  log.clear();
  await session.defaultSession.clearCache().catch(() => {});
  await clearScanData();
  loadedPasses.clear();
  sites.clearPasses();
  log.info('History, log and thumbnail cache cleared');
});

handle('watch:get', () => ({ channels: watch.list(), status: watch.status() }));
handle('watch:add', (payload) => watch.add(payload));
handle('watch:addUrl', async (url, opts = {}) => {
  let list;
  try { list = await prober.lookupList(url, { include: opts.include, cookiesBrowser: S().cookiesBrowser }); }
  catch (e) { if (!/Unsupported URL/i.test(e.message)) throw e; list = await scanList(url); }
  return watch.add({ list, format: opts.format || S().format, quality: opts.quality || S().quality, include: opts.include });
});
handle('watch:remove', (id) => watch.remove(id));
handle('watch:update', (id, patch) => watch.update(id, patch));
handle('watch:checkNow', () => watch.checkAll());

handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose where Slim Takes saves videos', properties: ['openDirectory', 'createDirectory'], defaultPath: S().folder });
  return r.canceled ? null : r.filePaths[0];
});
// ---------- Convert & Trim ----------
const MEDIA_EXTS = ['mp4', 'm4v', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', '3gp', 'ogv', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'ogg', 'oga', 'wma', 'aif', 'aiff', 'mka', 'amr', 'ac3'];
handle('convert:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose video or audio files', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video and audio', extensions: MEDIA_EXTS }, { name: 'All files', extensions: ['*'] }]
  });
  if (r.canceled) return null;
  return converter.addFiles(r.filePaths);
});
// Files dropped on the window (their paths come from the window; each is checked by reading it).
handle('convert:addPaths', (paths) => converter.addFiles(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []));
handle('convert:start', (specs) => converter.start(Array.isArray(specs) ? specs : []));
handle('convert:cancel', (id) => converter.cancel(String(id)));
handle('convert:clear', () => converter.clearFinished());
handle('convert:list', () => converter.list());
handle('convert:waveform', (p) => converter.waveform(p));
handle('convert:preview', (p) => converter.preview(p, { onProgress: (pct) => send('convert:previewProgress', { path: p, pct }) }));
handle('convert:show', (p) => { if (converter.allowed(p)) shell.showItemInFolder(p); });
handle('convert:mediaUrl', async (p, n) => {
  if (!converter.allowed(p)) return null;
  const s = await mediaServerReady();
  return s ? s.url(p, Number(n) || 0) : null;
});
handle('convert:chooseFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose where converted files go', properties: ['openDirectory', 'createDirectory'], defaultPath: S().convertOutDir || S().folder });
  return r.canceled ? null : r.filePaths[0];
});
handle('convert:isMedia', (names) => (Array.isArray(names) ? names.map((n) => isMediaName(n)) : []));
handle('dialog:importLinks', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import links', properties: ['openFile'], filters: [{ name: 'Text files', extensions: ['txt', 'csv', 'md'] }] });
  if (r.canceled) return null;
  const text = fs.readFileSync(r.filePaths[0], 'utf8');
  return extractLinks(text);
});

function allowedFile(p) {
  if (typeof p !== 'string') return false;
  const full = path.resolve(p);
  const root = path.resolve(S().folder);
  return full.toLowerCase().startsWith(root.toLowerCase() + path.sep) && fs.existsSync(full);
}
handle('file:open', (p) => (allowedFile(p) ? shell.openPath(p) : 'File not found'));
handle('file:show', (p) => {
  if (allowedFile(p)) shell.showItemInFolder(p);
  else if (typeof p === 'string' && fs.existsSync(path.dirname(p))) shell.openPath(path.dirname(p));
  else shell.openPath(S().folder);
});
handle('file:exists', (p) => allowedFile(p));
handle('folder:open', (sub) => {
  const target = sub ? path.join(S().folder, String(sub).replace(/[\\/]/g, '')) : S().folder;
  ensureDir(target);
  return shell.openPath(target);
});
handle('open:external', (url) => { if (/^https:\/\//i.test(String(url))) shell.openExternal(url); });

handle('log:get', () => log.text());
handle('log:openFolder', () => shell.openPath(dataDir));

handle('power:act', (what) => {
  log.info('When done: ' + what);
  if (process.platform !== 'win32') return false;
  if (what === 'shutdown') execFile('shutdown', ['/s', '/t', '0'], { windowsHide: true });
  if (what === 'sleep') execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { windowsHide: true });
  return true;
});

handle('app:checkUpdate', () => checkAppUpdate(true));
handle('disk:free', () => freeSpace());

function freeSpace() {
  const { freeBytes } = require('./src/main/util');
  return freeBytes(S().folder);
}

// ---------- local video playback (built-in player) ----------
function registerFileProtocol() {
  protocol.handle('slimfile', (request) => {
    const p = decodeURIComponent(request.url.slice('slimfile://'.length).replace(/^\/+/, ''));
    if (!allowedFile(p) && !converter.allowed(p)) return new Response('Not allowed', { status: 403 });
    try { return serveFile(p, request.headers.get('range')); }
    catch (e) { return new Response('Could not read file', { status: 500 }); }
  });
}

// ---------- updates ----------
async function checkAppUpdate(manual) {
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${settingsMod.UPDATE_REPO}/releases/latest`);
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const newer = latest && compareVersions(latest, app.getVersion()) > 0;
    const info = { newer, latest, current: app.getVersion(), url: rel.html_url };
    if (newer || manual) send('app:update', info);
    return info;
  } catch (e) {
    if (manual) log.warn('Update check failed: ' + e.message);
    return { newer: false, error: e.message, current: app.getVersion() };
  }
}

async function dailyEngineUpdate() {
  const s = S();
  if (!s.autoUpdateEngine || !engine.status().ytdlp) return;
  if (Date.now() - (s.lastEngineUpdate || 0) < 24 * 3600e3) return;
  if (queue.items.some((i) => ['starting', 'downloading', 'processing'].includes(i.status))) return;
  const r = await engine.updateYtdlp();
  if (r.ok) settingsStore.set({ ...S(), lastEngineUpdate: Date.now() });
}

function autoClear() {
  const days = S().autoClearDays;
  if (days) queue.clearOlderThan(days * 86400e3);
}

function applyLoginItem() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  // The portable .exe unpacks to a temp folder each run; point Windows at the real file.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: !!S().startWithWindows, path: exe, args: ['--hidden'] });
}

// ---------- lifecycle ----------
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  registerFileProtocol();
  createWindow();
  createTray();
  applyLoginItem();
  watch.startTimer();
  folderSync.run();
  folderSync.start();
  autoClear();
  setInterval(autoClear, 3600e3);
  try { ensureDir(S().folder); } catch (e) { log.warn('Save folder: ' + e.message); }
  if (engine.status().ready) setTimeout(() => queue.pump(), 1500);
  setTimeout(() => { if (S().checkAppUpdates) checkAppUpdate(false); }, 8000);
  setTimeout(dailyEngineUpdate, 20000);
  setInterval(dailyEngineUpdate, 3 * 3600e3);
});

let cleanedUp = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (cleanedUp) return;
  e.preventDefault();
  queue.stopAllForQuit();
  converter.stopAll();
  if (mediaServer) mediaServer.then((s) => s && s.close()).catch(() => {});
  folderSync.stop();
  if (S().clearHistoryOnClose) { history.clear(); library.clearIds(); log.clear(); }
  settingsStore.saveNow();
  // Thumbnails the window showed (including private ones) are cached by the browser engine: wipe them.
  closeVisible();
  Promise.race([Promise.all([session.defaultSession.clearCache(), clearScanData()]), new Promise((r) => setTimeout(r, 3000))])
    .catch(() => {})
    .finally(() => { cleanedUp = true; app.quit(); });
});

app.on('window-all-closed', () => {
  if (!S().tray) app.quit();
});
