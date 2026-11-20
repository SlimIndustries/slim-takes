'use strict';
// One-time move from the old name ("Slim Take") to "Slim Takes":
//  1. the app's data folder (settings, history, Channel Watch, engine) is moved over;
//  2. a save folder named "SlimTake" is renamed to "SlimTakes", and every saved path is updated.
// Safe to run every launch: it does nothing once done, and never deletes anything.

const fs = require('fs');
const path = require('path');

function moveDataFolder(oldDir, newDir) {
  const oldSettings = path.join(oldDir, 'settings.json');
  if (!fs.existsSync(oldSettings) || fs.existsSync(path.join(newDir, 'settings.json'))) return false;
  if (!fs.existsSync(newDir)) {
    try { fs.renameSync(oldDir, newDir); return true; } catch { /* fall through to copy */ }
  }
  fs.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false });
  return true;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, data) { fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1)); fs.renameSync(file + '.tmp', file); }

// Replace an old folder prefix in any string, matching Windows paths case-insensitively.
function swapPrefix(value, oldRoot, newRoot) {
  if (typeof value !== 'string') return value;
  const lower = value.toLowerCase(), o = oldRoot.toLowerCase();
  if (lower === o) return newRoot;
  if (lower.startsWith(o + path.sep) || lower.startsWith(o + '/')) return newRoot + value.slice(oldRoot.length);
  return value;
}

function renameSaveFolder(dataDir, log) {
  const settingsFile = path.join(dataDir, 'settings.json');
  const settings = readJson(settingsFile);
  if (!settings || !settings.folder) return false;
  const oldRoot = settings.folder;
  if (path.basename(oldRoot) !== 'SlimTake') return false;
  const newRoot = path.join(path.dirname(oldRoot), 'SlimTakes');
  if (fs.existsSync(oldRoot)) {
    if (fs.existsSync(newRoot)) { if (log) log.warn('Both SlimTake and SlimTakes folders exist; keeping SlimTake for now'); return false; }
    try { fs.renameSync(oldRoot, newRoot); }
    catch (e) { if (log) log.warn('Could not rename the save folder (a file may be open): ' + e.message); return false; }
  }
  settings.folder = newRoot;
  writeJson(settingsFile, settings);

  const history = readJson(path.join(dataDir, 'history.json'));
  if (Array.isArray(history)) {
    for (const h of history) h.filePath = swapPrefix(h.filePath, oldRoot, newRoot);
    writeJson(path.join(dataDir, 'history.json'), history);
  }
  const queue = readJson(path.join(dataDir, 'queue.json'));
  if (Array.isArray(queue)) {
    for (const q of queue) { q.filePath = swapPrefix(q.filePath, oldRoot, newRoot); q.dir = swapPrefix(q.dir, oldRoot, newRoot); }
    writeJson(path.join(dataDir, 'queue.json'), queue);
  }
  const lib = readJson(path.join(dataDir, 'library.json'));
  if (lib && lib.cache) {
    const cache = {};
    for (const [k, v] of Object.entries(lib.cache)) cache[swapPrefix(k, oldRoot, newRoot)] = v;
    lib.cache = cache;
    if (lib.files) for (const k of Object.keys(lib.files)) lib.files[k] = swapPrefix(lib.files[k], oldRoot, newRoot);
    writeJson(path.join(dataDir, 'library.json'), lib);
  }
  if (log) log.info('Save folder renamed to SlimTakes');
  return true;
}

module.exports = { moveDataFolder, renameSaveFolder, swapPrefix };
