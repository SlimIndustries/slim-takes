'use strict';
// Slim Takes — main process.

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, clipboard, protocol, nativeImage, powerSaveBlocker, screen, session } = require('electron');
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
const { extractLinks } = require('./src/main/urls');
const { estimateBytes } = require('./src/main/formats');
const settingsMod = require('./src/main/settings');
const { serveFile } = require('./src/main/range');
const { FolderSync } = require('./src/main/sync');
const { pageScan, openVisible, scanVisible, closeVisible, clearScanData, followLinks, fetchPage, siteCookies, usePass, isScanningVisible } = require('./src/main/pagescan');
const { BROWSERS, LABEL: BROWSER_LABEL, browserIdentity, exportBrowserCookies } = require('./src/main/browserpass');
const { Sites } = require('./src/main/sites');
const { uploaderFromHtml, nameFromUrl } = require('./src/main/scanlogic');
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

const engine = new Engine({ dir: path.join(dataDir, 'engine'), log });
const library = new Library({ storeFile: path.join(dataDir, 'library.json'), probeDuration: (f) => engine.probeDuration(f), log });
const sites = new Sites({ store: new JsonStore(path.join(dataDir, 'sites.json'), {}), dir: path.join(dataDir, 'sites'), log });
const prober = new Prober({ engine, log, sites });
const history = new History(new JsonStore(path.join(dataDir, 'history.json'), []));
const queue = new Queue({
  engine, library, getSettings: S, log, history,
  store: new JsonStore(path.join(dataDir, 'queue.json'), []),
  notify: { done: (it) => notifyDone(it), failed: (it) => notifyFailed(it) },
  sites
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

handle('lookup', async (url, opts = {}) => {
  try {
    const result = await prober.lookup(url, { include: opts.include, quiet: !!opts.private, cookiesBrowser: S().cookiesBrowser, onLine: (l) => send('lookup:line', l) });
    return decorate(result, opts);
  } catch (e) {
    if (sites.isBlocked(url, e.message)) throw new Error('Page scan: this site is protected by Cloudflare. Press "Open the page", tick the "I\'m human" box if it shows one, then press Scan now.');
    if (!/Unsupported URL/i.test(e.message)) throw e;
    return decorate(await scanList(url, { quiet: !!opts.private }), opts);
  }
});
handle('lookupList', async (url, opts = {}) => {
  try {
    const result = await prober.lookupList(url, { include: opts.include, cookiesBrowser: S().cookiesBrowser, onLine: (l) => send('lookup:line', l) });
    return decorate(result, opts);
  } catch (e) {
    if (sites.isBlocked(url, e.message)) throw new Error('Page scan: this site is protected by Cloudflare. Press "Open the page", tick the "I\'m human" box if it shows one, then press Scan now.');
    if (!/Unsupported URL/i.test(e.message)) throw e;
    return decorate(await scanList(url, { quiet: !!opts.private }), opts);
  }
});
handle('pageScan', async (url, opts = {}) => decorate(await scanList(url, { quiet: !!opts.private }), opts));
// Show-me mode: open the page for the user, then read whatever they're looking at.
handle('pageScan:open', (url) => openVisible(url, win, { onLoop: () => { log.info('Page window: the site check keeps repeating'); send('pageScan:loop', url); } }));
// "Use my browser instead": borrow the site's pass from the user's own browser.
handle('pageScan:useBrowser', async (url, browser) => {
  if (!/^https?:\/\//i.test(String(url)) || !BROWSERS.includes(browser)) throw new Error('Pick a browser first.');
  if (isScanningVisible()) throw new Error('A scan is still reading the page. Wait for it to finish (or Cancel it) first.');
  const cookies = await exportBrowserCookies(engine, browser, url);
  const { ua, target } = await browserIdentity(browser);
  sites.savePass(url, cookies, ua, { from: 'browser', target });
  await usePass(url, cookies, ua);
  closeVisible();
  log.info(`Using ${BROWSER_LABEL[browser]}'s pass for this site`);
  return { ok: true, browser: BROWSER_LABEL[browser] };
});
handle('pageScan:visible', async (url, opts = {}) => decorate(await scanList(url, { quiet: !!opts.private, visible: true }), opts));
handle('pageScan:cancel', () => closeVisible());

// Page scan: read the profile page directly, then check the videos can be downloaded, and use the
// uploader name of a video so the folder matches what a single download would use.
async function scanList(url, { quiet = false, visible = false } = {}) {
  log.info(visible ? 'Page scan (shown page)' : 'Page scan: the engine could not read this link, reading the page directly');
  send('grab:status', 'Reading the page directly…');
  const opts = { log, quiet, onProgress: (t) => send('grab:status', t) };
  const scan = visible ? await scanVisible(url, opts) : await pageScan(url, opts);
  // If the site gave the window a Cloudflare "I'm human" pass, share it with the engine for this site.
  // (A pass borrowed from the user's own browser is kept: it's tied to that browser.)
  if (sites.passFrom(url) !== 'browser') {
    try { const { cookies, ua } = await siteCookies(url); sites.savePass(url, cookies, ua); } catch (e) { log.warn('Could not save the site pass: ' + e.message); }
  }
  if (!scan.groups.length) {
    const err = new Error('Page scan couldn\'t find any videos on that page. Try "Open the page": click past any popups yourself, then press Scan now.');
    err.noVideos = true;
    throw err;
  }
  // Let the engine decide which links are this creator's videos.
  const chosen = await chooseVideos(scan, url, {
    lookup: (u) => prober.lookup(u, { cookiesBrowser: S().cookiesBrowser, quiet }),
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
  return { kind: 'list', scanned: true, url, title: creatorName || scanName || folder, channelName: creatorName, folder, site: first.site, extractor: first.extractor, thumbnail: null, entries };
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
  const list = Array.isArray(specs) ? specs : [specs];
  return queue.addMany(list.filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url)));
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
  log.clear();
  await session.defaultSession.clearCache().catch(() => {});
  await clearScanData();
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
    if (!allowedFile(p)) return new Response('Not allowed', { status: 403 });
    try { return serveFile(p, request.headers.get('range')); }
    catch (e) { return new Response('Could not read file', { status: 500 }); }
  });
}

// ---------- clipboard: offer to add copied links ----------
let lastClip = '';
function startClipboardWatch() {
  // Ignore whatever was already copied before Slim Takes started.
  try { lastClip = clipboard.readText(); } catch { /* ignore */ }
  setInterval(() => {
    if (!S().clipboardWatch || !unlocked) return;
    let text = '';
    try { text = clipboard.readText(); } catch { return; }
    if (!text || text === lastClip) return;
    lastClip = text;
    const links = extractLinks(text);
    if (links.length && links.length <= 50) send('clipboard:links', links);
  }, 1500);
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
  startClipboardWatch();
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
  folderSync.stop();
  if (S().clearHistoryOnClose) { history.clear(); log.clear(); }
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
