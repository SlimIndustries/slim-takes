'use strict';
// Finished and failed downloads. Private-mode downloads never get here.

const MAX = 5000;

class History {
  constructor(store) {
    this.store = store;
    this.onChange = () => {};
  }
  all() { return this.store.get(); }
  add(item, status) {
    const list = this.store.get();
    list.unshift({
      id: item.id,
      title: item.title,
      folder: item.folder,
      site: item.site,
      format: item.format,
      quality: item.quality,
      size: item.total || null,
      filePath: item.filePath || null,
      url: item.url,
      videoId: item.videoId || null,
      extractor: item.extractor || null,
      thumbnail: item.thumbnail || null,
      status,
      error: item.error || null,
      at: Date.now()
    });
    // A retried item that later succeeds replaces its old "failed" entry.
    const seen = new Set();
    const deduped = list.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
    if (deduped.length > MAX) deduped.length = MAX;
    this.store.set(deduped);
    this.onChange();
  }
  remove(id) {
    this.store.set(this.store.get().filter((h) => h.id !== id));
    this.onChange();
  }
  removeMany(ids) {
    if (!ids.length) return;
    const drop = new Set(ids);
    this.store.set(this.store.get().filter((h) => !drop.has(h.id)));
    this.onChange();
  }
  clear() {
    this.store.set([]);
    this.store.saveNow();
    this.onChange();
  }
}

module.exports = { History };
