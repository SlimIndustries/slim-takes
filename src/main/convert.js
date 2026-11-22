'use strict';
// Convert & Trim: change a video or audio file's format, take the sound out, or keep one part of it.
// The original is never changed or overwritten. Uses the ffmpeg/ffprobe the app already has.
//
//  - Video to video: repackaged without re-encoding when the formats allow (seconds, no quality
//    lost); converted only when that doesn't work.
//  - To audio (MP3, M4A, FLAC, WAV, Opus): the sound is taken out, at the chosen quality.
//  - Trim: "exact" cuts on the exact frame (re-encodes the clip); "fast" copies (no quality lost,
//    but the start snaps to the nearest keyframe, up to a couple of seconds early). Audio cuts are
//    always exact.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const VIDEO_FORMATS = ['mp4', 'mkv', 'mov', 'webm'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'flac', 'wav', 'opus'];
const FORMATS = [...VIDEO_FORMATS, ...AUDIO_FORMATS];
const QUALITIES = ['high', 'medium', 'small'];
const MEDIA_FILE = /\.(mp4|m4v|mkv|mov|webm|avi|wmv|flv|mpe?g|ts|m2ts|mts|3gp|ogv|mp3|m4a|aac|wav|flac|opus|ogg|oga|wma|aiff?|mka|amr|ac3)$/i;

const BITRATE = {
  high: { mp3: '320k', m4a: '256k', opus: '160k' },
  medium: { mp3: '192k', m4a: '192k', opus: '128k' },
  small: { mp3: '128k', m4a: '128k', opus: '96k' }
};
const AUDIO_CODEC = { mp3: 'libmp3lame', m4a: 'aac', opus: 'libopus', flac: 'flac', wav: 'pcm_s16le' };
const MUXER = { mp4: 'mp4', mkv: 'matroska', mov: 'mov', webm: 'webm', mp3: 'mp3', m4a: 'ipod', flac: 'flac', wav: 'wav', opus: 'ogg' };
const ENCODE_VIDEO = {
  h264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'],
  vp9: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-c:a', 'libopus', '-b:a', '128k']
};

class ConvertError extends Error {
  constructor(message, props = {}) { super(message); Object.assign(this, props); }
}

const isAudioFormat = (f) => AUDIO_FORMATS.includes(f);
const isMediaName = (p) => MEDIA_FILE.test(String(p || ''));

/** Run a program; returns { code, stdout, stderr } (stderr: the last few KB). */
function runProc(cmd, args, { signal, onStdout, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return reject(e); }
    let stderr = '';
    let stdout = '';
    let killed = false;
    const kill = () => { killed = true; try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const onAbort = () => kill();
    if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = timeout ? setTimeout(kill, timeout) : null;
    child.stdout.on('data', (d) => { if (onStdout) onStdout(d); else { stdout += d; if (stdout.length > 4e6) stdout = stdout.slice(-2e6); } });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    child.on('error', (e) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new ConvertError('Canceled', { aborted: true }));
      resolve({ code: killed ? -1 : code, stdout, stderr });
    });
  });
}

/** What's in a file: { path, name, size, duration, hasVideo, hasAudio, vcodec, acodec, width, height, container }. */
async function probe(ffprobe, file) {
  let st;
  try { st = fs.statSync(file); } catch { throw new ConvertError('That file can\'t be found any more.', { missing: true }); }
  if (!st.isFile()) throw new ConvertError('That\'s a folder, not a file.');
  const r = await runProc(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic', '-of', 'json', file], { timeout: 60000 });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* not readable */ }
  if (r.code !== 0 || !j || !j.format) throw new ConvertError('Slim Takes can\'t read this file. It may not be a video or audio file, or it may be damaged.', { unreadable: true });
  const streams = j.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) throw new ConvertError('This file has no picture or sound Slim Takes can use.', { unreadable: true });
  const duration = Number(j.format.duration) || null;
  return {
    path: file, name: path.basename(file), size: st.size, mtime: st.mtimeMs, duration,
    hasVideo: !!video, hasAudio: !!audio,
    vcodec: video ? video.codec_name : null, acodec: audio ? audio.codec_name : null,
    width: video ? video.width : null, height: video ? video.height : null,
    container: String(j.format.format_name || '')
  };
}

/** 125.4 -> "2m05s"; 3725 -> "1h02m05s" (for file names). */
function stamp(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return h ? `${h}h${p2(m)}m${p2(r)}s` : `${m}m${p2(r)}s`;
}

/** A file name in `dir` that isn't taken (and isn't the original): "name.ext", then "name (1).ext", … */
function freeName(dir, base, ext, original) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (let n = 0; n < 10000; n++) {
    const p = path.join(dir, `${base}${n ? ` (${n})` : ''}.${ext}`);
    if (original && same(p, original)) continue;
    if (!fs.existsSync(p) && !fs.existsSync(p + '.partial')) return p;
  }
  throw new ConvertError('Too many files with that name in the folder.');
}

/** Check a job against what the file has. Returns the cleaned-up job, or throws a ConvertError. */
function checkJob(info, job) {
  const format = String(job.format || '').toLowerCase();
  if (!FORMATS.includes(format)) throw new ConvertError('Pick a format to convert to.');
  const quality = QUALITIES.includes(job.quality) ? job.quality : 'high';
  if (isAudioFormat(format) && !info.hasAudio) throw new ConvertError('This file has no sound, so it can\'t be made into ' + format.toUpperCase() + '.', { final: true });
  if (!isAudioFormat(format) && !info.hasVideo) throw new ConvertError('This file has no picture. Pick an audio format (like MP3) instead.', { final: true });
  let trim = null;
  if (job.trim && (job.trim.start != null || job.trim.end != null)) {
    const dur = info.duration || Infinity;
    const start = Math.max(0, Number(job.trim.start) || 0);
    const end = job.trim.end == null ? dur : Math.min(Number(job.trim.end), dur);
    if (!Number.isFinite(start) || !(end > start)) throw new ConvertError('The end of the cut has to be after the start.', { final: true });
    if (end - start < 0.1) throw new ConvertError('The cut is too short (less than a tenth of a second).', { final: true });
    if (start >= dur) throw new ConvertError('The start of the cut is past the end of the file.', { final: true });
    // A "cut" that keeps everything isn't a cut.
    if (!(start < 0.05 && end >= dur - 0.05)) trim = { start, end, fast: job.trim.fast === true && !isAudioFormat(format) };
  }
  return { format, quality, trim, outDir: job.outDir || null };
}

/** The ffmpeg arguments for one attempt. mode: 'copy' (repackage) or 'encode'. */
function ffmpegArgs(info, job, out, mode) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y'];
  if (job.trim) a.push('-ss', job.trim.start.toFixed(3));
  a.push('-i', info.path);
  if (job.trim) a.push('-t', (job.trim.end - job.trim.start).toFixed(3));
  const f = job.format;
  if (isAudioFormat(f)) {
    a.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', AUDIO_CODEC[f]);
    if (BITRATE[job.quality][f]) a.push('-b:a', BITRATE[job.quality][f]);
    if (f === 'mp3') a.push('-id3v2_version', '3');
  } else {
    a.push('-map', '0:v:0', '-map', '0:a?', '-sn', '-dn');
    if (mode === 'copy') {
      a.push('-c', 'copy');
      if (job.trim) a.push('-avoid_negative_ts', 'make_zero');
    } else {
      a.push(...(f === 'webm' ? ENCODE_VIDEO.vp9 : ENCODE_VIDEO.h264));
    }
    if (f === 'mp4' || f === 'mov') a.push('-movflags', '+faststart');
  }
  a.push('-f', MUXER[f], out);
  return a;
}

/** ffmpeg's last error line, in plainer words where we know it. */
function friendly(stderr) {
  const line = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || 'ffmpeg stopped';
  if (/No space left/i.test(stderr)) return 'The drive is full.';
  if (/Permission denied|Access is denied/i.test(stderr)) return 'Slim Takes isn\'t allowed to save in that folder.';
  if (/Invalid data found|moov atom not found|could not find codec parameters/i.test(stderr)) return 'The file seems to be damaged or incomplete.';
  return line.slice(0, 300);
}

/**
 * Convert one file. job: { format, quality, trim: { start, end, fast }, outDir }.
 * Returns { out, mode, seconds }. Throws ConvertError (.aborted when canceled).
 */
async function convertFile(info, rawJob, { ffmpeg, ffprobe, signal, onProgress, log } = {}) {
  const job = checkJob(info, rawJob);
  const dir = job.outDir || path.dirname(info.path);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { throw new ConvertError('Slim Takes can\'t save in that folder.', { final: true }); }
  const stem = path.basename(info.path).replace(/\.[^.]+$/, '');
  const base = job.trim ? `${stem} (${stamp(job.trim.start)}-${stamp(job.trim.end)})` : stem;
  const started = Date.now();
  const total = job.trim ? job.trim.end - job.trim.start : (info.duration || 0);
  // Exact cuts and audio are always encoded; otherwise repackage first, convert only if that fails.
  const modes = isAudioFormat(job.format) || (job.trim && !job.trim.fast) ? ['encode'] : ['copy', 'encode'];
  let lastErr = null;
  for (const mode of modes) {
    const out = freeName(dir, base, job.format, info.path);
    const tmp = out + '.partial';
    let buf = '';
    const progress = (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && total > 0 && onProgress) {
          const t = Number(m[1]) / 1e6;
          const pct = Math.max(0, Math.min(99.5, (t / total) * 100));
          const el = (Date.now() - started) / 1000;
          onProgress({ pct, eta: pct > 2 ? Math.round(el * (100 - pct) / pct) : null, mode });
        }
      }
    };
    let r;
    try {
      r = await runProc(ffmpeg, ffmpegArgs(info, job, tmp, mode), { signal, onStdout: progress });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      if (e.aborted) throw e;
      throw new ConvertError('Couldn\'t start the converter: ' + e.message);
    }
    let ok = r.code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0;
    if (ok) {
      // Make sure what came out is really a playable file of the right kind and length.
      try {
        const got = await probe(ffprobe, tmp);
        if (isAudioFormat(job.format) ? !got.hasAudio : !got.hasVideo) ok = false;
        if (total > 1 && got.duration && got.duration < total * 0.5) ok = false;
        if (!ok) r.stderr = 'the result was incomplete';
      } catch { ok = false; r.stderr = 'the result couldn\'t be read'; }
    }
    if (ok) {
      let final = out;
      if (fs.existsSync(final)) final = freeName(dir, base, job.format, info.path); // taken in the meantime
      fs.renameSync(tmp, final);
      return { out: final, mode, seconds: (Date.now() - started) / 1000 };
    }
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    lastErr = friendly(r.stderr);
    if (mode === 'copy' && log) log(`repackaging to ${job.format.toUpperCase()} didn't work (${lastErr}): converting instead`);
  }
  throw new ConvertError(lastErr || 'The conversion didn\'t work.');
}

/** The sound's shape for the trim screen: `buckets` numbers from 0 to 1 (loudest point in each slice). */
async function waveform(ffmpeg, info, { buckets = 800, signal } = {}) {
  if (!info.hasAudio) return null;
  const RATE = 2000;
  const peaks = [];      // one per 0.05 s
  const per = RATE / 20;
  let cur = 0, n = 0;
  let rest = Buffer.alloc(0);
  const r = await runProc(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', info.path, '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], {
    signal,
    onStdout: (d) => {
      const b = rest.length ? Buffer.concat([rest, d]) : d;
      const even = b.length - (b.length % 2);
      for (let i = 0; i < even; i += 2) {
        const v = Math.abs(b.readInt16LE(i));
        if (v > cur) cur = v;
        if (++n >= per) { peaks.push(cur); cur = 0; n = 0; }
      }
      rest = b.subarray(even);
    }
  });
  if (n) peaks.push(cur);
  if (r.code !== 0 && !peaks.length) throw new ConvertError('Couldn\'t read the sound: ' + friendly(r.stderr));
  const out = new Array(buckets).fill(0);
  if (!peaks.length) return out;
  for (let i = 0; i < buckets; i++) {
    const a = Math.floor((i * peaks.length) / buckets), b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / buckets));
    let m = 0;
    for (let k = a; k < b && k < peaks.length; k++) if (peaks[k] > m) m = peaks[k];
    out[i] = m;
  }
  const top = Math.max(1, ...out);
  return out.map((v) => Math.round((v / top) * 1000) / 1000);
}

/** A small copy that the app's player can always play (for files it can't play itself). Cached. */
async function previewCopy(ffmpeg, info, dir, { signal, onProgress } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash('sha1').update(`${info.path}|${info.size}|${info.mtime}`).digest('hex').slice(0, 16);
  const out = path.join(dir, `${key}.${info.hasVideo ? 'mp4' : 'm4a'}`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  const tmp = out + '.partial';
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', info.path];
  if (info.hasVideo) args.push('-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4', tmp);
  else args.push('-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '128k', '-f', 'ipod', tmp);
  let buf = '';
  const r = await runProc(ffmpeg, args, {
    signal,
    onStdout: (d) => {
      buf += d; const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) { const m = l.match(/^out_time_(?:us|ms)=(\d+)/); if (m && info.duration && onProgress) onProgress(Math.min(99, (Number(m[1]) / 1e6 / info.duration) * 100)); }
    }
  }).catch((e) => { try { fs.unlinkSync(tmp); } catch { /* none */ } throw e; });
  if (r.code !== 0) { try { fs.unlinkSync(tmp); } catch { /* none */ } throw new ConvertError('Couldn\'t make a preview: ' + friendly(r.stderr)); }
  fs.renameSync(tmp, out);
  return out;
}

/** Leftover preview copies older than a few days are removed. */
function tidyPreviews(dir, maxAgeMs = 3 * 24 * 3600 * 1000) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs || f.endsWith('.partial')) fs.unlinkSync(p); } catch { /* in use */ }
    }
  } catch { /* none */ }
}

/**
 * The list of conversions: one runs at a time (each already uses every CPU core), the rest wait.
 * Events: 'job' (a job's state changed).
 */
class Converter extends EventEmitter {
  constructor({ engine, log, previewDir } = {}) {
    super();
    this.engine = engine;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.previewDir = previewDir || path.join(os.tmpdir(), 'slimtakes-previews');
    this.files = new Map();  // path (lower case) -> info, for files the user picked or dropped
    this.outputs = new Set();
    this.jobs = [];
    this.running = null;
    this.seq = 0;
    tidyPreviews(this.previewDir);
  }

  get ffmpeg() { return this.engine.ffmpeg; }
  get ffprobe() { return this.engine.ffprobe; }

  /** Read files the user picked or dropped. Returns [{ ok, info } | { ok: false, path, name, error }]. */
  async addFiles(paths) {
    const out = [];
    for (const p of [...new Set((paths || []).filter((x) => typeof x === 'string' && x))].slice(0, 200)) {
      const full = path.resolve(p);
      try {
        const info = await probe(this.ffprobe, full);
        this.files.set(full.toLowerCase(), info);
        out.push({ ok: true, info });
      } catch (e) {
        out.push({ ok: false, path: full, name: path.basename(full), error: e.message });
      }
    }
    return out;
  }

  info(p) { return typeof p === 'string' ? this.files.get(path.resolve(p).toLowerCase()) || null : null; }

  /** May the app's player open this file? Only files the user chose here, their results and previews. */
  allowed(p) {
    if (typeof p !== 'string') return false;
    const full = path.resolve(p);
    if (this.files.has(full.toLowerCase()) || this.outputs.has(full.toLowerCase())) return fs.existsSync(full);
    const pv = path.resolve(this.previewDir).toLowerCase() + path.sep;
    return full.toLowerCase().startsWith(pv) && fs.existsSync(full);
  }

  view(j) {
    return { id: j.id, path: j.info.path, name: j.info.name, format: j.job.format, trim: j.job.trim || null, status: j.status, pct: j.pct, eta: j.eta, out: j.out || null, error: j.error || null, mode: j.mode || null };
  }

  list() { return this.jobs.map((j) => this.view(j)); }

  /** Add conversions. specs: [{ path, format, quality, trim, outDir }]. Returns the new jobs (or why not). */
  start(specs) {
    const made = [];
    for (const s of specs || []) {
      const info = this.info(s && s.path);
      if (!info) { made.push({ ok: false, error: 'Add the file again (it wasn\'t found).' }); continue; }
      let job;
      try { job = checkJob(info, s); } catch (e) { made.push({ ok: false, path: info.path, error: e.message }); continue; }
      if (s.outDir) {
        try { if (!fs.statSync(s.outDir).isDirectory()) throw new Error(); } catch { made.push({ ok: false, path: info.path, error: 'That save folder doesn\'t exist.' }); continue; }
      }
      const j = { id: 'c' + (++this.seq), info, job: { ...job, outDir: s.outDir || null }, status: 'waiting', pct: 0, eta: null };
      this.jobs.push(j);
      this.emit('job', this.view(j));
      made.push({ ok: true, id: j.id });
    }
    this.pump();
    return made;
  }

  cancel(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return false;
    if (j.status === 'waiting') { j.status = 'canceled'; this.emit('job', this.view(j)); return true; }
    if (j.status === 'converting' && j.ctl) { j.ctl.abort(); return true; }
    return false;
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === 'waiting' || j.status === 'converting');
    return this.list();
  }

  async pump() {
    if (this.running) return;
    const j = this.jobs.find((x) => x.status === 'waiting');
    if (!j) return;
    this.running = j;
    j.status = 'converting';
    j.ctl = new AbortController();
    this.emit('job', this.view(j));
    let last = 0;
    try {
      const what = `${j.info.name} -> ${j.job.format.toUpperCase()}${j.job.trim ? ` (cut ${stamp(j.job.trim.start)}-${stamp(j.job.trim.end)}, ${j.job.trim.fast ? 'fast' : 'exact'})` : ''}`;
      this.log.info('Convert: ' + what);
      const r = await convertFile(j.info, { ...j.job, trim: j.job.trim ? { ...j.job.trim } : null }, {
        ffmpeg: this.ffmpeg, ffprobe: this.ffprobe, signal: j.ctl.signal,
        log: (m) => this.log.info(`Convert: ${j.info.name}: ${m}`),
        onProgress: (p) => { j.pct = p.pct; j.eta = p.eta; j.mode = p.mode; if (Date.now() - last > 300) { last = Date.now(); this.emit('job', this.view(j)); } }
      });
      j.status = 'done'; j.pct = 100; j.eta = null; j.out = r.out; j.mode = r.mode;
      this.outputs.add(path.resolve(r.out).toLowerCase());
      this.log.info(`Convert done: ${r.out} (${r.mode === 'copy' ? 'repackaged' : 'converted'} in ${Math.round(r.seconds)}s)`);
    } catch (e) {
      if (e.aborted) { j.status = 'canceled'; this.log.info('Convert canceled: ' + j.info.name); }
      else { j.status = 'failed'; j.error = e.message; this.log.warn(`Convert failed: ${j.info.name}: ${e.message}`); }
      j.pct = j.status === 'canceled' ? 0 : j.pct;
    } finally {
      j.ctl = null;
      this.running = null;
      this.emit('job', this.view(j));
      setImmediate(() => this.pump());
    }
  }

  async waveform(p, opts) {
    const info = this.info(p);
    if (!info) throw new ConvertError('Add the file again (it wasn\'t found).');
    if (!info.peaks) info.peaks = await waveform(this.ffmpeg, info, opts);
    return info.peaks;
  }

  async preview(p, opts) {
    const info = this.info(p);
    if (!info) throw new ConvertError('Add the file again (it wasn\'t found).');
    return previewCopy(this.ffmpeg, info, this.previewDir, opts);
  }

  /** Stop everything (app closing). Half-made files are removed by each job. */
  stopAll() { for (const j of this.jobs) if (j.ctl) j.ctl.abort(); }
}

module.exports = { Converter, convertFile, probe, waveform, previewCopy, checkJob, ffmpegArgs, freeName, stamp, isMediaName, isAudioFormat, VIDEO_FORMATS, AUDIO_FORMATS, FORMATS, QUALITIES, ConvertError };
