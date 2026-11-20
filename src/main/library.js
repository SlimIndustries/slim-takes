'use strict';
// Knows what is already in each creator folder, so duplicates can be skipped.
//
// Duplicate rules:
//  1. Same video ID as something already downloaded            -> skip (archive)
//  2. Same title AND same length (within 2 seconds)            -> skip
//  3. Same title, different length (or length unknown)         -> keep, save as "Title (2)"

const fs = require('fs');
const path = require('path');
const { cleanName, fitToPath, sameTitle, uniqueBase, splitExt } = require('./naming');

const MEDIA_EXT = new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'flv', 'mp3', 'm4a', 'flac', 'wav', 'opus', 'ogg', 'aac']);
const DURATION_TOLERANCE = 2;

/** Pure decision. entries: [{ base, duration }] already in the folder (plus reserved names). */
function decide({ entries, title, duration, dir, ext }) {
  const base = fitToPath(dir, cleanName(title), ext);
  if (duration) {
    const dup = entries.find((e) => e.duration && sameTitle(e.base, base) && Math.abs(e.duration - duration) <= DURATION_TOLERANCE);
    if (dup) return { skip: true, reason: 'Already have (same title and length)', match: dup.base };
  }
  const takenLower = new Set(entries.map((e) => e.base.toLocaleLowerCase()));
  const finalBase = uniqueBase(base, (b) => takenLower.has(b.toLocaleLowerCase()));
  return { skip: false, base: finalBase };
}

class Library {
  constructor({ storeFile, probeDuration, log }) {
    this.storeFile = storeFile;
    this.probeDuration = probeDuration; // async (filePath) => seconds | null
    this.log = log || (() => {});
    this.cache = {};       // dir -> { name: { size, mtimeMs, duration } }
    this.reserved = {};    // dir -> Set of lower-case bases claimed by queued downloads
    this.archive = new Set(); // "extractor id"
    this.folders = {};        // video link or ID -> creator folder it was saved under
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      this.cache = data.cache || {};
      this.archive = new Set(data.archive || []);
      this.folders = data.folders || {};
    } catch { /* first run */ }
  }

  save() {
    const tmp = this.storeFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ cache: this.cache, archive: [...this.archive], folders: this.folders }));
      fs.renameSync(tmp, this.storeFile);
    } catch (e) { this.log('Could not save library: ' + e.message); }
  }

  static key(extractor, id) {
    return `${String(extractor || '').toLowerCase()} ${id}`;
  }

  hasId(extractor, id) {
    return !!id && this.archive.has(Library.key(extractor, id));
  }

  addId(extractor, id) {
    if (!id) return;
    this.archive.add(Library.key(extractor, id));
    this.save();
  }

  /** Refresh the cached listing of a folder, probing lengths of new files. */
  async scan(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { this.cache[dir] = {}; return []; }
    const old = this.cache[dir] || {};
    const fresh = {};
    const toProbe = [];
    for (const name of names) {
      const { ext } = splitExt(name);
      if (!MEDIA_EXT.has(ext.toLowerCase())) continue;
      let st;
      try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
      if (!st.isFile()) continue;
      const prev = old[name];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) fresh[name] = prev;
      else { fresh[name] = { size: st.size, mtimeMs: st.mtimeMs, duration: null }; toProbe.push(name); }
    }
    // Probe a few at a time.
    for (let i = 0; i < toProbe.length; i += 4) {
      await Promise.all(toProbe.slice(i, i + 4).map(async (name) => {
        try { fresh[name].duration = await this.probeDuration(path.join(dir, name)); } catch { /* unknown */ }
      }));
    }
    this.cache[dir] = fresh;
    if (toProbe.length || Object.keys(old).length !== Object.keys(fresh).length) this.save();
    return this.entries(dir);
  }

  entries(dir) {
    const files = this.cache[dir] || {};
    const list = Object.entries(files).map(([name, v]) => ({ base: splitExt(name).base, duration: v.duration }));
    for (const r of this.reserved[dir] || []) list.push({ base: r, duration: null });
    return list;
  }

  static linkKey(url) {
    try { const u = new URL(url); return 'url ' + (u.host.replace(/^www\./, '') + u.pathname).replace(/\/+$/, '').toLowerCase(); } catch { return null; }
  }

  /** Remember which creator folder a video belongs to, so a later single download lands beside it. */
  rememberFolder({ url, extractor, id }, folder) {
    if (!folder) return;
    const keys = [Library.linkKey(url), id ? Library.key(extractor, id) : null].filter(Boolean);
    let changed = false;
    for (const k of keys) if (this.folders[k] !== folder) { this.folders[k] = folder; changed = true; }
    // Keep this from growing forever.
    const all = Object.keys(this.folders);
    if (all.length > 50000) for (const k of all.slice(0, all.length - 50000)) delete this.folders[k];
    if (changed) this.save();
  }

  folderFor({ url, extractor, id }) {
    return (id && this.folders[Library.key(extractor, id)]) || this.folders[Library.linkKey(url)] || null;
  }

  /** A deleted video counts as never downloaded: Channel grab will offer it again. */
  forget(extractor, id) {
    if (!id) return;
    if (this.archive.delete(Library.key(extractor, id))) this.save();
  }

  /** Drop a removed file (or whole folder) from the cached listings. */
  dropPath(p) {
    const dir = path.dirname(p);
    if (this.cache[dir] && this.cache[dir][path.basename(p)]) { delete this.cache[dir][path.basename(p)]; this.save(); }
    if (this.cache[p]) { delete this.cache[p]; this.save(); }
  }

  /** Decide the file name for a new download and reserve it. */
  async claim({ dir, title, duration, ext }) {
    await this.scan(dir);
    const result = decide({ entries: this.entries(dir), title, duration, dir, ext });
    if (!result.skip) {
      if (!this.reserved[dir]) this.reserved[dir] = new Set();
      this.reserved[dir].add(result.base);
    }
    return result;
  }

  release(dir, base) {
    if (this.reserved[dir]) this.reserved[dir].delete(base);
  }

  /** Record a finished file so the next check sees it straight away. */
  noteFile(filePath, duration) {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    try {
      const st = fs.statSync(filePath);
      if (!this.cache[dir]) this.cache[dir] = {};
      this.cache[dir][name] = { size: st.size, mtimeMs: st.mtimeMs, duration: duration || null };
      this.save();
    } catch { /* file vanished */ }
  }

  /** Quick check used by Channel grab to grey out videos already on disk. */
  status(dir, title, duration, extractor, id) {
    if (this.hasId(extractor, id)) return 'have';
    const base = cleanName(title);
    if (duration && this.entries(dir).some((e) => e.duration && sameTitle(e.base, base) && Math.abs(e.duration - duration) <= DURATION_TOLERANCE)) return 'have';
    if (this.entries(dir).some((e) => sameTitle(e.base, base))) return 'sametitle';
    return 'new';
  }
}

module.exports = { Library, decide, MEDIA_EXT };
