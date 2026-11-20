'use strict';
// The only bridge between the window and the rest of the app.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const EVENTS = ['queue:item', 'queue:list', 'queue:state', 'queue:idle', 'queue:diskLow', 'engine:step', 'watch:changed',
  'history:changed', 'log:line', 'clipboard:links', 'app:update', 'lookup:line', 'grab:status', 'pageScan:loop'];

contextBridge.exposeInMainWorld('slim', {
  init: () => invoke('init'),
  verifyPin: (pin) => invoke('pin:verify', pin),
  setPin: (pin) => invoke('pin:set', pin),
  setSettings: (patch) => invoke('settings:set', patch),

  engineStatus: () => invoke('engine:status'),
  installEngine: (force) => invoke('engine:install', force),
  updateEngine: () => invoke('engine:update'),
  engineVersion: () => invoke('engine:version'),

  extractLinks: (text) => invoke('links:extract', text),
  lookup: (url, opts) => invoke('lookup', url, opts),
  lookupList: (url, opts) => invoke('lookupList', url, opts),
  pageScan: (url, opts) => invoke('pageScan', url, opts),
  pageScanOpen: (url) => invoke('pageScan:open', url),
  pageScanVisible: (url, opts) => invoke('pageScan:visible', url, opts),
  pageScanCancel: () => invoke('pageScan:cancel'),
  pageScanUseBrowser: (url, browser) => invoke('pageScan:useBrowser', url, browser),

  queueAdd: (specs) => invoke('queue:add', specs),
  queueAction: (action, id) => invoke('queue:action', action, id),
  pauseAll: () => invoke('queue:pauseAll'),
  resumeAll: () => invoke('queue:resumeAll'),
  clearFinished: () => invoke('queue:clearFinished'),
  cancelAll: () => invoke('queue:cancelAll'),
  queueList: () => invoke('queue:list'),

  history: () => invoke('history:get'),
  historyRemove: (id) => invoke('history:remove', id),
  historyClear: () => invoke('history:clear'),

  watchGet: () => invoke('watch:get'),
  watchAdd: (payload) => invoke('watch:add', payload),
  watchAddUrl: (url, opts) => invoke('watch:addUrl', url, opts),
  watchRemove: (id) => invoke('watch:remove', id),
  watchUpdate: (id, patch) => invoke('watch:update', id, patch),
  watchCheckNow: () => invoke('watch:checkNow'),

  chooseFolder: () => invoke('dialog:folder'),
  importLinks: () => invoke('dialog:importLinks'),
  openFile: (p) => invoke('file:open', p),
  showFile: (p) => invoke('file:show', p),
  fileExists: (p) => invoke('file:exists', p),
  openFolder: (sub) => invoke('folder:open', sub),
  openExternal: (url) => invoke('open:external', url),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },

  log: () => invoke('log:get'),
  openLogFolder: () => invoke('log:openFolder'),
  power: (what) => invoke('power:act', what),
  checkUpdate: () => invoke('app:checkUpdate'),
  diskFree: () => invoke('disk:free'),

  on: (event, fn) => {
    if (!EVENTS.includes(event)) return () => {};
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  }
});
