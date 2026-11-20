'use strict';
// Channel Watch: follows channels and queues new uploads automatically.

const crypto = require('crypto');
const { EventEmitter } = require('events');

// Videos found by Page scan have no ID yet, so their link identifies them.
const keyOf = (e) => e.id || e.url;

const INTERVALS = { '1h': 3600e3, '2h': 7200e3, '6h': 21600e3, '12h': 43200e3, '24h': 86400e3, manual: 0 };

class Watch extends EventEmitter {
  constructor({ store, prober, queue, library, getSettings, log, scanList }) {
    super();
    this.scanList = scanList || null; // Page scan, for sites yt-dlp can't list
    this.store = store;   // { channels: [], lastRun: 0 }
    this.prober = prober;
    this.queue = queue;
    this.library = library;
    this.getSettings = getSettings;
    this.log = log;
    this.checking = false;
    this.timer = null;
  }

  data() { return this.store.get(); }

  list() {
    return this.data().channels.map((c) => ({
      id: c.id, url: c.url, name: c.name, folder: c.folder, site: c.site, format: c.format, quality: c.quality,
      include: c.include, enabled: c.enabled, lastChecked: c.lastChecked, lastNew: c.lastNew, lastError: c.lastError,
      downloaded: c.downloaded || 0, thumbnail: c.thumbnail || null
    }));
  }

  status() {
    const s = this.getSettings();
    const every = INTERVALS[s.watchInterval] || 0;
    const lastRun = this.data().lastRun || 0;
    return { checking: this.checking, lastRun, nextRun: every ? lastRun + every : null, interval: s.watchInterval };
  }

  save() {
    this.store.set({ ...this.data() });
    this.emit('changed');
  }

  /** list = a probe result (kind 'list'). Everything currently on the channel counts as "seen". */
  add({ list, format, quality, include }) {
    const d = this.data();
    const existing = d.channels.find((c) => c.url === list.url);
    if (existing) {
      existing.enabled = true;
      for (const e of list.entries) if (!existing.seen.includes(keyOf(e))) existing.seen.push(keyOf(e));
      this.save();
      return existing.id;
    }
    const ch = {
      id: crypto.randomUUID(),
      url: list.url,
      name: list.title,
      folder: list.folder,
      site: list.site,
      extractor: list.extractor,
      thumbnail: list.thumbnail || null,
      format, quality,
      include: include || list.include || { videos: true, shorts: false, streams: false },
      enabled: true,
      seen: list.entries.map(keyOf).filter(Boolean),
      scanned: !!list.scanned,
      downloaded: 0,
      lastChecked: Date.now(),
      lastNew: 0,
      lastError: null
    };
    d.channels.push(ch);
    this.save();
    this.log.info(`Watching ${ch.name}`);
    return ch.id;
  }

  remove(id) {
    const d = this.data();
    d.channels = d.channels.filter((c) => c.id !== id);
    this.save();
  }

  update(id, patch) {
    const c = this.data().channels.find((x) => x.id === id);
    if (!c) return;
    for (const k of ['enabled', 'format', 'quality', 'include']) if (k in patch) c[k] = patch[k];
    this.save();
  }

  async checkOne(c) {
    try {
      const list = c.scanned && this.scanList
        ? await this.scanList(c.url)
        : await this.prober.lookupList(c.url, { include: c.include, cookiesBrowser: this.getSettings().cookiesBrowser });
      const fresh = list.entries.filter((e) => keyOf(e) && !c.seen.includes(keyOf(e)) && !(e.id && this.library.hasId(e.extractor || c.extractor, e.id)));
      // Oldest first, so they download (and sort) in upload order.
      for (const e of fresh.reverse()) {
        this.queue.add({
          url: e.url, title: e.title, folder: c.folder, site: c.site, extractor: e.extractor || c.extractor, videoId: e.id,
          duration: e.duration, thumbnail: e.thumbnail, format: c.format, quality: c.quality, source: 'watch', isLive: e.isLive
        });
      }
      for (const e of list.entries) if (keyOf(e) && !c.seen.includes(keyOf(e))) c.seen.push(keyOf(e));
      c.lastChecked = Date.now();
      c.lastNew = fresh.length;
      c.downloaded = (c.downloaded || 0) + fresh.length;
      c.lastError = null;
      if (fresh.length) this.log.info(`Channel Watch: ${fresh.length} new from ${c.name}`);
      return fresh.length;
    } catch (e) {
      c.lastChecked = Date.now();
      c.lastError = e.message;
      this.log.warn(`Channel Watch: ${c.name}: ${e.message}`);
      return 0;
    }
  }

  async checkAll() {
    if (this.checking) return 0;
    this.checking = true;
    this.emit('changed');
    let total = 0;
    try {
      for (const c of this.data().channels) {
        if (!c.enabled) continue;
        total += await this.checkOne(c);
        this.save();
      }
    } finally {
      this.data().lastRun = Date.now();
      this.checking = false;
      this.save();
    }
    this.emit('checked', total);
    return total;
  }

  startTimer() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const st = this.status();
      if (st.nextRun && Date.now() >= st.nextRun && this.data().channels.some((c) => c.enabled)) this.checkAll();
    }, 60e3);
  }
}

module.exports = { Watch, INTERVALS };
