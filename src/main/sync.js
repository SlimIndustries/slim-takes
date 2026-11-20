'use strict';
// Keeps History and the Downloads list in step with the SlimTakes folder.
// Delete a video (or a whole creator folder) in File Explorer and it disappears from the app,
// and counts as never downloaded, so Channel grab offers it again.

const fs = require('fs');
const path = require('path');

class FolderSync {
  constructor({ getRoot, history, queue, library, log }) {
    this.getRoot = getRoot;
    this.history = history;
    this.queue = queue;
    this.library = library;
    this.log = log;
    this.watcher = null;
    this.watchedRoot = null;
    this.timer = null;
  }

  inside(root, p) {
    const r = path.resolve(root).toLowerCase() + path.sep;
    return path.resolve(p).toLowerCase().startsWith(r);
  }

  /** Check every finished download still exists. Safe: does nothing if the main folder itself is missing. */
  run() {
    const root = this.getRoot();
    // Main folder gone (unplugged drive, network hiccup)? Don't touch anything.
    if (!root || !fs.existsSync(root)) return 0;
    const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

    const gone = [];
    for (const h of this.history.all()) {
      if (h.status !== 'done' || !h.filePath) continue;
      if (!this.inside(root, h.filePath)) continue; // saved somewhere else (old main folder): leave it
      if (!exists(h.filePath)) gone.push(h);
    }
    for (const h of gone) {
      this.library.forget(h.extractor, h.videoId);
      this.library.dropPath(h.filePath);
    }
    if (gone.length) this.history.removeMany(gone.map((h) => h.id));

    // The Downloads list (includes private downloads, which never reach History).
    const missingItems = this.queue.items.filter((i) => i.status === 'done' && i.filePath && this.inside(root, i.filePath) && !exists(i.filePath));
    for (const i of missingItems) {
      this.library.forget(i.extractor, i.videoId);
      this.library.dropPath(i.filePath);
    }
    const removed = this.queue.removeMissing((p) => !this.inside(root, p) || exists(p));

    const n = gone.length + removed;
    if (n) this.log.info(`Removed ${n} deleted download(s) from the lists`);
    return n;
  }

  runSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { try { this.run(); } catch (e) { this.log.warn('Folder check: ' + e.message); } }, 1500);
  }

  /** Watch the main folder (and everything inside it) for deletions. */
  start() {
    const root = this.getRoot();
    if (this.watchedRoot === root && this.watcher) return;
    this.stop();
    if (!root || !fs.existsSync(root)) return;
    try {
      this.watcher = fs.watch(root, { recursive: true }, (type) => { if (type === 'rename') this.runSoon(); });
      this.watcher.on('error', () => { this.stop(); });
      this.watchedRoot = root;
    } catch (e) {
      this.log.warn('Could not watch the folder for deletions: ' + e.message);
    }
  }

  stop() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    this.watcher = null;
    this.watchedRoot = null;
  }
}

module.exports = { FolderSync };
