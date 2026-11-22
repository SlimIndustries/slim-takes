'use strict';
const { tmpdir } = require('./helpers/tmp');
// Loads the app's main file with a stand-in for Electron (Electron itself isn't needed for this), then
// calls the window's requests the way the window would: catches mistakes in how things are wired up.
// Also: the right-click menu, and that nothing watches what you copy any more.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { contextMenuTemplate } = require('../src/main/contextmenu');

const FFMPEG = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const FFPROBE = ['/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((p) => fs.existsSync(p));

test('right-click menu: Cut/Copy/Paste/Select all in text boxes; Copy on selected text; nothing elsewhere', () => {
  const box = contextMenuTemplate({ isEditable: true, selectionText: '', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
  assert.deepEqual(box.filter((x) => x.role).map((x) => [x.label, x.enabled]), [['Cut', false], ['Copy', false], ['Paste', true], ['Select all', true]]);
  const withSel = contextMenuTemplate({ isEditable: true, selectionText: 'https://x', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
  assert.ok(withSel.find((x) => x.role === 'cut').enabled && withSel.find((x) => x.role === 'copy').enabled);
  const nothingToPaste = contextMenuTemplate({ isEditable: true, editFlags: { canPaste: false } });
  assert.equal(nothingToPaste.find((x) => x.role === 'paste').enabled, false);
  assert.deepEqual(contextMenuTemplate({ isEditable: false, selectionText: 'some words' }).map((x) => x.role), ['copy']);
  assert.deepEqual(contextMenuTemplate({ isEditable: false, selectionText: '' }), []);
});

test('the app main file starts and its Convert & Trim requests work end to end (Electron stand-in)', { skip: !(FFMPEG && FFPROBE) && 'no ffmpeg here' }, async () => {
  const tmp = tmpdir('mainwire-');
  const handlers = {};
  const sent = [];
  const calls = { menus: [], shown: [] };
  let protocolHandler = null;
  let ready;
  const whenReady = new Promise((r) => { ready = r; });
  // Anything not listed below answers with a do-nothing function (only the parts this test uses matter).
  const loose = (o) => new Proxy(o, { get: (t, k) => (k in t || typeof k === 'symbol' ? t[k] : () => loose({})) });
  class FakeWin {
    constructor() { this.webContents = loose({ on: (ev, fn) => { if (ev === 'context-menu') calls.contextMenu = fn; }, send: (ch, x) => sent.push([ch, x]), isDestroyed: () => false, session: loose({}) }); return loose(this); }
    setMenuBarVisibility() {} loadFile() {} once() {} on() {} isDestroyed() { return false; } isMinimized() { return false; } isMaximized() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1000, height: 700 }; } getNormalBounds() { return this.getBounds(); } show() {} focus() {} maximize() {}
  }
  const electron = {
    app: loose({
      userAgentFallback: 'Mozilla/5.0 Chrome/140 Electron/39.0.0', getPath: (k) => path.join(tmp, k), getVersion: () => '1.3.0', whenReady: () => whenReady, on() {}, quit() {}, requestSingleInstanceLock: () => true,
      setLoginItemSettings() {}, getLoginItemSettings: () => ({}), setAppUserModelId() {}, isPackaged: false, commandLine: { appendSwitch() {} }
    }),
    BrowserWindow: FakeWin,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
    shell: { openPath: async () => '', showItemInFolder: (p) => calls.shown.push(p), openExternal() {} },
    Tray: class { constructor() { return loose(this); } },
    Menu: { buildFromTemplate: (t) => ({ popup: () => calls.menus.push(t) }), setApplicationMenu() {} },
    Notification: class { static isSupported() { return false; } show() {} on() {} },
    protocol: { registerSchemesAsPrivileged() {}, handle: (s, fn) => { protocolHandler = fn; } },
    nativeImage: { createFromPath: () => ({ resize: () => ({}), isEmpty: () => false }) },
    powerSaveBlocker: { start: () => 1, stop() {} },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: loose({ defaultSession: loose({ clearCache: async () => {}, cookies: loose({ get: async () => [] }), webRequest: loose({}) }), fromPartition: () => loose({ webRequest: loose({}), cookies: loose({ get: async () => [] }), clearStorageData: async () => {}, clearCache: async () => {} }) }),
    contextBridge: {}, ipcRenderer: {}, webUtils: {}
  };
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) { if (request === 'electron') return electron; return origLoad.call(this, request, parent, isMain); };
  const origExit = process.exit;
  process.exit = (c) => { throw new Error('the app tried to exit: ' + c); };
  // The engine looks for its programs in its own folder: point it at this machine's ffmpeg.
  const engDir = path.join(tmp, 'userData', 'engine');
  fs.mkdirSync(engDir, { recursive: true });
  for (const [n, src] of [['ffmpeg', FFMPEG], ['ffprobe', FFPROBE]]) { try { fs.symlinkSync(src, path.join(engDir, n)); } catch { /* exists */ } }
  try {
    const timersBefore = new Set();
    require('../main.js');
    ready();
    await new Promise((r) => setTimeout(r, 300));

    // Everything the window asks for has a handler; nothing about copied links remains.
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    for (const [, ch] of preload.matchAll(/invoke\('([^']+)'/g)) assert.ok(handlers[ch], 'no handler for ' + ch);
    assert.ok(!/clipboard/i.test(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')), 'main no longer reads the clipboard');
    assert.ok(!/clipboard:links/.test(preload));

    // A real file through the real handlers.
    const media = path.join(tmp, 'My Clip.mp4');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', media]);
    const call = (name, ...a) => handlers[name]({}, ...a);
    const added = await call('convert:addPaths', [media, path.join(tmp, 'nope.mp4'), 42]);
    assert.deepEqual(added.map((x) => x.ok), [true, false]);
    // The player may open that file now (and only files like it).
    const res = await protocolHandler({ url: 'slimfile://' + encodeURIComponent(media), headers: { get: (k) => (k === 'range' ? 'bytes=0-99' : null) } });
    assert.equal(res.status, 206);
    const denied = await protocolHandler({ url: 'slimfile://' + encodeURIComponent(path.join(os.homedir(), '.bashrc')), headers: { get: () => null } });
    assert.equal(denied.status, 403);
    // The Trim player's private server: a working address for chosen files only.
    const mu = await call('convert:mediaUrl', media, 1);
    assert.match(mu, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}\/m\?p=.*&r=1$/);
    const part = await fetch(mu, { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.notEqual(await call('convert:mediaUrl', media, 2), mu, 'a reload gets a new address');
    assert.equal(await call('convert:mediaUrl', '/etc/passwd', 1), null, 'nothing else');
    const made = await call('convert:start', [{ path: media, format: 'mp3', quality: 'small', trim: { start: 1, end: 4 } }]);
    assert.ok(made[0].ok, JSON.stringify(made));
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const done = sent.find(([ch, j]) => ch === 'convert:job' && j.status === 'done');
        const bad = sent.find(([ch, j]) => ch === 'convert:job' && j.status === 'failed');
        if (done || bad || Date.now() - t0 > 60000) { clearInterval(tick); bad ? reject(new Error(bad[1].error)) : done ? resolve() : reject(new Error('timed out')); }
      }, 100);
    });
    const out = sent.find(([ch, j]) => ch === 'convert:job' && j.status === 'done')[1].out;
    assert.equal(path.basename(out), 'My Clip (0m01s-0m04s).mp3');
    await call('convert:show', out);
    assert.deepEqual(calls.shown, [out]);
    await call('convert:show', '/etc/passwd');
    assert.equal(calls.shown.length, 1, 'only its own results are shown');
    const peaks = await call('convert:waveform', media);
    assert.equal(peaks.length, 800);
    // Right-click in the window pops the menu.
    calls.contextMenu({}, { isEditable: true, editFlags: { canPaste: true } });
    assert.equal(calls.menus.length, 1);
    // Settings accept the new choices, refuse nonsense; no copied-links setting left.
    const r = await call('settings:set', { convertFormat: 'flac', convertQuality: 'small', convertOutDir: tmp });
    assert.ok(!r || !r.rejected || !r.rejected.length, JSON.stringify(r));
  } finally {
    Module._load = origLoad;
    Module._resolveFilename = origResolve;
    process.exit = origExit;
  }
  // main.js starts timers (watch, folder sync…): this test ends the process when it's done.
  setTimeout(() => process.exit(0), 200).unref();
});
