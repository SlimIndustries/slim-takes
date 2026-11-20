'use strict';
// The download queue: runs yt-dlp for each item, reports progress, retries,
// skips duplicates, names files, and remembers unfinished work across restarts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const { buildArgs, finalExt, isAudio } = require('./formats');
const { escapeTemplate } = require('./naming');
const { parseLine, PROGRESS_TEMPLATE, DONE_PRINT, uploadDateToDate } = require('./parse');
const { ensureDir, freeBytes } = require('./util');

const ACTIVE = new Set(['starting', 'downloading', 'processing']);
const FINISHED = new Set(['done', 'failed', 'skipped', 'canceled']);
const RECODE_HINT = /remux|recode|conversion failed|could not write header|Postprocessing|codec/i;

// What goes in the log: never the title or path of a Private-mode download.
function label(it) { return it.private ? '[private download]' : it.title; }
// yt-dlp messages name the site, video ID and links: strip those for private downloads.
function scrub(it, msg) {
  if (!it.private) return msg;
  return String(msg).replace(/^\[[^\]]+\]\s*[^:\s]+:\s*/, '').replace(/https?:\/\/\S+/g, '[link]').replace(/[A-Za-z]:\\[^\s"']+/g, '[file]');
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // yt-dlp may have started ffmpeg; take the whole family down.
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

class Queue extends EventEmitter {
  constructor({ engine, library, getSettings, log, store, history, notify, sites }) {
    super();
    this.sites = sites || null; // per-site extras (Cloudflare); optional
    this.engine = engine;
    this.library = library;
    this.getSettings = getSettings;
    this.log = log;
    this.store = store;       // JsonStore for unfinished items
    this.history = history;   // History
    this.notify = notify;     // { done(item), failed(item) }
    this.items = [];
    this.procs = new Map();   // id -> child process
    this.paused = false;
    this.lastStartBySite = {};
    this.pumpTimer = null;
    this.sessionFinished = 0;
    this.restore();
  }

  // ---------- persistence ----------
  restore() {
    const saved = this.store.get();
    for (const it of Array.isArray(saved) ? saved : []) {
      if (FINISHED.has(it.status)) continue;
      // Keep the file name it had, so the half-finished download resumes.
      if (it.base && it.dir) (this.library.reserved[it.dir] ||= new Set()).add(it.base);
      this.items.push({ ...it, status: it.status === 'paused' ? 'paused' : 'waiting', pct: it.pct || 0, speed: null, eta: null, error: null });
    }
    if (this.items.length) this.log.info(`Restored ${this.items.length} unfinished download(s)`);
  }

  persist() {
    this.store.set(this.items.filter((i) => !FINISHED.has(i.status) && !i.private).map((i) => {
      const { process: _p, ...rest } = i;
      return rest;
    }));
  }

  // ---------- public API ----------
  list() {
    return this.items.map((i) => this.view(i));
  }

  view(i) {
    return {
      id: i.id, url: i.url, title: i.title, folder: i.folder, site: i.site, format: i.format, quality: i.quality,
      thumbnail: i.thumbnail, status: i.status, pct: i.pct, speed: i.speed, eta: i.eta, downloaded: i.downloaded,
      total: i.total, error: i.error, note: i.note, filePath: i.filePath, private: !!i.private, attempts: i.attempts,
      isLive: !!i.isLive, source: i.source, addedAt: i.addedAt, finishedAt: i.finishedAt || null
    };
  }

  counts() {
    const c = { waiting: 0, active: 0, done: 0, failed: 0, paused: 0 };
    for (const i of this.items) {
      if (i.status === 'waiting') c.waiting++;
      else if (ACTIVE.has(i.status)) c.active++;
      else if (i.status === 'done') c.done++;
      else if (i.status === 'failed') c.failed++;
      else if (i.status === 'paused') c.paused++;
    }
    return c;
  }

  add(spec) {
    const s = this.getSettings();
    const item = {
      id: crypto.randomUUID(),
      url: spec.url,
      title: spec.title || spec.url,
      folder: spec.folder || 'Other',
      site: spec.site || '',
      extractor: spec.extractor || '',
      videoId: spec.videoId || spec.id || null,
      duration: spec.duration || null,
      thumbnail: spec.thumbnail || null,
      format: spec.format || s.format,
      quality: spec.quality || s.quality,
      trim: spec.trim || null,
      subs: spec.subs != null ? spec.subs : s.subs,
      sponsorblock: spec.sponsorblock != null ? spec.sponsorblock : s.sponsorblock,
      filters: spec.filters || null,
      liveFromStart: !!spec.liveFromStart,
      isLive: !!spec.isLive,
      private: !!spec.private,
      source: spec.source || 'single',
      status: 'waiting',
      pct: 0, speed: null, eta: null, downloaded: null, total: null,
      attempts: 0, forceRecode: false, error: null, note: null, filePath: null,
      addedAt: Date.now()
    };
    if (item.videoId && this.library.hasId(item.extractor, item.videoId)) {
      item.status = 'skipped';
      item.note = 'Already have this video';
    } else if (this.items.some((o) => !FINISHED.has(o.status) && o.url === item.url && o.format === item.format)) {
      item.status = 'skipped';
      item.note = 'Already in the queue';
    }
    this.items.push(item);
    // Remember this video's creator folder, so pasting it alone later lands in the same place.
    this.library.rememberFolder({ url: item.url, extractor: item.extractor, id: item.videoId }, item.folder);
    this.changed(item);
    this.pump();
    return this.view(item);
  }

  addMany(specs) {
    const out = specs.map((s) => this.add(s));
    return out;
  }

  pause(id) {
    const it = this.find(id);
    if (!it) return;
    if (ACTIVE.has(it.status)) { it.stopReason = 'pause'; killTree(this.procs.get(id)); }
    if (it.status === 'waiting') { it.status = 'paused'; this.changed(it); }
  }

  resume(id) {
    const it = this.find(id);
    if (it && (it.status === 'paused' || it.status === 'failed' || it.status === 'canceled')) {
      if (it.status !== 'paused') it.attempts = 0;
      it.status = 'waiting'; it.error = null; it.note = null; it.retryAt = 0;
      if (this.paused) { this.paused = false; this.emit('state'); }
      this.changed(it); this.pump();
    }
  }

  retry(id) {
    const it = this.find(id);
    if (!it) return;
    it.attempts = 0; it.forceRecode = false;
    this.resume(id);
  }

  cancel(id) {
    const it = this.find(id);
    if (!it) return;
    if (ACTIVE.has(it.status)) { it.stopReason = 'cancel'; killTree(this.procs.get(id)); }
    else if (!FINISHED.has(it.status)) { it.status = 'canceled'; this.release(it); this.changed(it); }
  }

  remove(id) {
    const it = this.find(id);
    if (!it) return;
    if (ACTIVE.has(it.status)) { it.removeAfter = true; this.cancel(id); return; }
    this.release(it);
    this.items = this.items.filter((x) => x !== it);
    this.persist();
    this.emit('list');
  }

  /** Cancel everything not finished yet (waiting, paused and downloading) and take it off the list. */
  cancelAll() {
    const waiting = this.items.filter((i) => !FINISHED.has(i.status) && !ACTIVE.has(i.status));
    const active = this.items.filter((i) => ACTIVE.has(i.status));
    for (const it of waiting) this.release(it);
    this.items = this.items.filter((i) => !waiting.includes(i));
    for (const it of active) { it.removeAfter = true; this.cancel(it.id); }
    this.persist();
    this.emit('list');
    return waiting.length + active.length;
  }

  clearFinished() {
    this.items = this.items.filter((i) => !FINISHED.has(i.status));
    this.persist();
    this.emit('list');
  }

  /** Remove finished items older than `ms` from the list (History keeps them). */
  clearOlderThan(ms) {
    const cutoff = Date.now() - ms;
    const before = this.items.length;
    this.items = this.items.filter((i) => !(FINISHED.has(i.status) && (i.finishedAt || i.addedAt) < cutoff));
    if (this.items.length !== before) { this.persist(); this.emit('list'); }
  }

  /** Finished downloads whose file was deleted disappear from the list. */
  removeMissing(exists) {
    const before = this.items.length;
    this.items = this.items.filter((i) => !(i.status === 'done' && i.filePath && !exists(i.filePath)));
    if (this.items.length !== before) { this.persist(); this.emit('list'); }
    return before - this.items.length;
  }

  pauseAll() {
    this.paused = true;
    for (const it of this.items) {
      if (it.status === 'waiting') { it.status = 'paused'; }
      if (ACTIVE.has(it.status)) { it.stopReason = 'pause'; killTree(this.procs.get(it.id)); }
    }
    this.persist();
    this.emit('list');
    this.emit('state');
  }

  resumeAll() {
    this.paused = false;
    for (const it of this.items) if (it.status === 'paused') it.status = 'waiting';
    this.persist();
    this.emit('list');
    this.emit('state');
    this.pump();
  }

  stopAllForQuit() {
    for (const [, child] of this.procs) killTree(child);
    for (const it of this.items) if (ACTIVE.has(it.status)) it.status = 'waiting';
    this.persist();
    this.store.saveNow();
  }

  find(id) { return this.items.find((i) => i.id === id); }

  // ---------- running ----------
  pump() {
    clearTimeout(this.pumpTimer);
    if (this.paused) return;
    const s = this.getSettings();
    const limit = Math.max(1, Math.min(8, Number(s.concurrent) || 3));
    let running = this.items.filter((i) => ACTIVE.has(i.status)).length;
    const now = Date.now();
    let soonest = Infinity;

    for (const it of this.items) {
      if (running >= limit) break;
      if (it.status !== 'waiting') continue;
      if (it.retryAt && it.retryAt > now) { soonest = Math.min(soonest, it.retryAt - now); continue; }
      if (s.polite) {
        const last = this.lastStartBySite[it.site] || 0;
        const gap = 3000 + Math.floor(Math.random() * 3000);
        if (now - last < gap) { soonest = Math.min(soonest, gap - (now - last)); continue; }
      }
      // Disk space guard.
      if (s.minFreeGB > 0) {
        const free = freeBytes(s.folder);
        if (free != null && free < s.minFreeGB * 1e9) {
          this.log.warn(`Only ${(free / 1e9).toFixed(1)} GB free — pausing the queue`);
          this.pauseAll();
          this.emit('diskLow', free);
          return;
        }
      }
      this.lastStartBySite[it.site] = now;
      running++;
      this.start(it).catch((e) => this.fail(it, e.message));
    }
    if (soonest !== Infinity) this.pumpTimer = setTimeout(() => this.pump(), Math.min(soonest + 50, 60000));
    this.checkIdle();
  }

  checkIdle() {
    const busy = this.items.some((i) => ACTIVE.has(i.status) || i.status === 'waiting');
    if (!busy && this.sessionFinished > 0) {
      const finished = this.sessionFinished;
      this.sessionFinished = 0;
      this.emit('idle', finished);
    }
  }

  async start(it) {
    const s = this.getSettings();
    it.status = 'starting';
    it.error = null;
    it.note = null;
    it.stopReason = null;
    this.changed(it);

    const dir = path.join(s.folder, it.folder);
    ensureDir(dir);
    const ext = finalExt(it.format);

    if (!it.base) {
      const claim = await this.library.claim({ dir, title: it.title, duration: it.duration, ext });
      if (claim.skip) {
        it.status = 'skipped';
        it.note = claim.reason;
        this.changed(it);
        this.pump();
        return;
      }
      it.base = claim.base;
      it.dir = dir;
    }

    const concurrent = Math.max(1, Number(s.concurrent) || 3);
    const opts = {
      format: it.format,
      quality: it.quality,
      trim: it.trim,
      subs: it.subs,
      sponsorblock: it.sponsorblock && /youtube/i.test(it.extractor + it.site),
      embed: s.embed,
      cover: s.cover,
      speedLimitBytes: s.speedLimitMB ? (s.speedLimitMB * 1e6) / concurrent : 0,
      cookiesBrowser: this.sites && this.sites.hasPass(it.url) ? 'none' : s.cookiesBrowser,
      liveFromStart: it.liveFromStart,
      dateAfter: it.filters && it.filters.dateAfter,
      dateBefore: it.filters && it.filters.dateBefore,
      minDuration: it.filters && it.filters.minDuration,
      maxDuration: it.filters && it.filters.maxDuration,
      polite: s.polite,
      forceRecode: it.forceRecode
    };
    const out = path.join(it.dir, escapeTemplate(it.base)) + '.%(ext)s';
    const args = [
      ...this.engine.baseArgs(),
      '--newline', '--progress', '--progress-template', PROGRESS_TEMPLATE,
      '--print', DONE_PRINT, '--no-simulate',
      '--no-playlist', '--no-mtime', '--retries', '10', '--fragment-retries', '10',
      '-o', out,
      ...buildArgs(opts),
      ...(this.sites ? this.sites.argsFor(it.url) : []),
      '--', it.url
    ];
    this.log.info(it.private ? 'Start: [private download]' : `Start: ${it.title} -> ${path.join(it.folder, it.base)}.${ext}`);

    let child;
    try {
      child = spawn(this.engine.ytdlp, args, { windowsHide: true, env: { ...process.env, ...this.engine.env() } });
    } catch (e) {
      return this.fail(it, 'Could not start the engine: ' + e.message);
    }
    this.procs.set(it.id, child);
    it.status = 'downloading';
    this.changed(it);

    const state = { done: null, errors: [], skipped: null, lastPct: 0 };
    const onText = (chunk, carry) => {
      carry.buf += chunk;
      let i;
      while ((i = carry.buf.search(/[\r\n]/)) >= 0) {
        const line = carry.buf.slice(0, i);
        carry.buf = carry.buf.slice(i + 1);
        this.handleLine(it, line, state);
      }
    };
    const outCarry = { buf: '' }, errCarry = { buf: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => onText(d, outCarry));
    child.stderr.on('data', (d) => onText(d, errCarry));

    await new Promise((resolve) => {
      child.on('error', (e) => { state.errors.push(e.message); resolve(-1); });
      child.on('close', (code) => {
        if (outCarry.buf) this.handleLine(it, outCarry.buf, state);
        if (errCarry.buf) this.handleLine(it, errCarry.buf, state);
        resolve(code);
      });
    }).then((code) => this.finishRun(it, code, state));
  }

  handleLine(it, line, state) {
    const p = parseLine(line);
    if (!p) return;
    switch (p.type) {
      case 'progress':
        if (p.pct != null) it.pct = p.pct;
        it.speed = p.speed; it.eta = p.eta; it.downloaded = p.downloaded; it.total = p.total;
        if (it.status !== 'downloading') it.status = 'downloading';
        if (p.pct != null && p.pct >= 99.9) it.note = 'Finishing up…';
        else if (state.lastPct > 90 && p.pct != null && p.pct < 10) it.note = 'Downloading audio…';
        if (p.pct != null) state.lastPct = p.pct;
        this.changedSoon(it);
        break;
      case 'done':
        state.done = p;
        break;
      case 'error':
        state.errors.push(p.message);
        this.log.error(`${label(it)}: ${scrub(it, p.message)}`);
        break;
      case 'skipped':
        state.skipped = p.message;
        break;
      case 'processing':
        it.status = 'processing'; it.note = 'Finishing up…';
        this.changedSoon(it);
        break;
      case 'warning':
        this.log.warn(`${label(it)}: ${scrub(it, p.message)}`);
        break;
      default:
        break;
    }
  }

  finishRun(it, code, state) {
    this.procs.delete(it.id);
    const reason = it.stopReason;
    it.stopReason = null;
    it.speed = null; it.eta = null;

    if (reason === 'pause') {
      it.status = 'paused'; it.note = null;
      this.changed(it); this.pump();
      return;
    }
    if (reason === 'cancel') {
      it.status = 'canceled'; it.note = null;
      this.cleanupParts(it);
      this.release(it);
      if (it.removeAfter) { this.items = this.items.filter((x) => x !== it); this.persist(); this.emit('list'); }
      else this.changed(it);
      this.pump();
      return;
    }
    if (code === 0 && state.done) return this.complete(it, state.done);
    if (code === 0 && state.skipped) {
      it.status = 'skipped';
      it.note = /date/i.test(state.skipped) ? 'Outside the date range' : /filter/i.test(state.skipped) ? 'Outside the length filter' : 'Already have this video';
      this.release(it);
      this.changed(it); this.pump();
      return;
    }
    const message = state.errors[state.errors.length - 1] || (code === 0 ? 'Finished without a file' : `Engine stopped (code ${code})`);
    // Some streams can't be repackaged into MOV/WebM/MP4: convert instead, once.
    if (!it.forceRecode && !isAudio(it.format) && it.format !== 'mkv' && RECODE_HINT.test(message)) {
      this.log.warn(`${label(it)}: repackaging failed, converting instead`);
      it.forceRecode = true;
      it.status = 'waiting'; it.note = 'Converting format…';
      this.changed(it); this.pump();
      return;
    }
    // Cloudflare: retry straight away connecting like a normal browser (remembered for the site).
    if (this.sites && !it.cfRetried && this.sites.noteBlocked(it.url, message)) {
      it.cfRetried = true;
      it.status = 'waiting'; it.note = 'Site check, retrying as a browser…';
      this.changed(it); this.pump();
      return;
    }
    const s = this.getSettings();
    it.attempts = (it.attempts || 0) + 1;
    // Still blocked by the site's protection: retrying won't help, say what will.
    if (this.sites && this.sites.isBlocked(it.url, message)) {
      return this.fail(it, (this.sites.hasPass(it.url) ? 'Cloudflare still refused even with your pass. ' : '') + 'Cloudflare anti-bot challenge');
    }
    const permanent = /cloudflare|anti-bot|unavailable|private video|removed|not available|copyright|members-only|sign in to confirm your age|DRM|Unsupported URL|404/i.test(message);
    if (!permanent && it.attempts <= (s.retries || 0)) {
      it.status = 'waiting';
      it.retryAt = Date.now() + 15000 * it.attempts;
      it.note = `Retrying (${it.attempts}/${s.retries})…`;
      this.changed(it); this.pump();
      return;
    }
    this.fail(it, message);
  }

  fail(it, message) {
    this.procs.delete(it.id);
    it.status = 'failed';
    it.error = friendlyError(message);
    it.note = null;
    this.release(it);
    this.log.error(`Failed: ${label(it)}: ${it.private ? 'see app' : message}`);
    if (!it.private) this.history.add(it, 'failed');
    this.notify.failed(it);
    this.changed(it);
    this.pump();
  }

  complete(it, done) {
    it.status = 'done';
    it.pct = 100;
    it.note = null;
    it.filePath = done.filepath;
    // Date the file by when the video was uploaded, so "sort by date" = upload order.
    const when = uploadDateToDate(done.uploadDate, done.timestamp);
    if (when && this.getSettings().setFileDate !== false) {
      try { fs.utimesSync(done.filepath, new Date(), when); } catch (e) { this.log.warn('Could not set file date: ' + (it.private ? 'private file' : e.message)); }
    }
    this.library.addId(done.extractor || it.extractor, done.id || it.videoId);
    this.library.rememberFolder({ url: it.url, extractor: done.extractor || it.extractor, id: done.id || it.videoId }, it.folder);
    this.library.noteFile(done.filepath, done.duration || it.duration);
    this.release(it);
    try { it.total = fs.statSync(done.filepath).size; } catch { /* ignore */ }
    if (!it.private) this.history.add(it, 'done');
    this.sessionFinished++;
    this.notify.done(it);
    this.log.info(it.private ? 'Done: [private download]' : `Done: ${done.filepath}`);
    this.changed(it);
    this.pump();
  }

  release(it) {
    if (it.dir && it.base) this.library.release(it.dir, it.base);
    it.base = null;
    it.dir = null;
  }

  cleanupParts(it) {
    if (!it.dir || !it.base) return;
    try {
      for (const f of fs.readdirSync(it.dir)) {
        if (f.startsWith(it.base + '.') && /\.(part|ytdl|temp)(-Frag\d+)?$|\.f\d+\.\w+(\.part)?$/.test(f)) {
          try { fs.unlinkSync(path.join(it.dir, f)); } catch { /* in use */ }
        }
      }
    } catch { /* folder gone */ }
  }

  // ---------- change notifications ----------
  changed(it) {
    if (FINISHED.has(it.status) && !it.finishedAt) it.finishedAt = Date.now();
    if (!FINISHED.has(it.status)) it.finishedAt = null;
    this.persist();
    this.emit('item', this.view(it));
  }

  changedSoon(it) {
    const now = Date.now();
    if (!it._lastEmit || now - it._lastEmit > 250) {
      it._lastEmit = now;
      this.emit('item', this.view(it));
    }
  }
}

function friendlyError(msg) {
  const m = String(msg || '');
  if (/still refused even with your pass/i.test(m)) return 'This site\'s Cloudflare check refused the download even with your "I\'m human" pass. Open the page again in Channel grab to refresh it (or use your normal browser from there) and Retry; some strict sites can\'t be downloaded.';
  if (/cloudflare|anti-bot challenge|generic:impersonate/i.test(m)) return 'This site\'s Cloudflare check blocked the download. In Channel grab, use "Open the page" on this site, tick the "I\'m human" box, press Scan now, then Retry here.';
  if (/Sign in to confirm you.?re not a bot/i.test(m)) return 'The site wants a login check. Turn on "Use browser login" in Settings and try again.';
  if (/Sign in to confirm your age|age-restricted|confirm your age/i.test(m)) return 'Age-restricted. Turn on "Use browser login" in Settings (be logged in on that browser).';
  if (/Private video|members-only|This video is private/i.test(m)) return 'Private or members-only video.';
  if (/Video unavailable|has been removed|no longer available/i.test(m)) return 'Video unavailable or removed.';
  if (/DRM/i.test(m)) return 'This video is copy-protected (DRM) and can\'t be downloaded.';
  if (/Unsupported URL/i.test(m)) return 'This site or link isn\'t supported.';
  if (/HTTP Error 429|Too Many Requests/i.test(m)) return 'The site is limiting downloads right now. Polite mode helps; try again later.';
  if (/HTTP Error 403/i.test(m)) return 'The site refused the download (403). Update the engine in Settings and retry.';
  if (/No space left|disk full/i.test(m)) return 'The drive is full.';
  if (/getaddrinfo|Unable to download webpage|timed out|Connection/i.test(m)) return 'Network problem. Check your internet and retry.';
  if (/ffmpeg|ffprobe/i.test(m) && /not found|not installed/i.test(m)) return 'ffmpeg is missing. Use "Repair engine" in Settings.';
  return m.length > 300 ? m.slice(0, 300) + '…' : m;
}

module.exports = { Queue, friendlyError, killTree };
