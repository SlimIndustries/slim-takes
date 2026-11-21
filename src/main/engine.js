'use strict';
// The download engine: yt-dlp (does the work), ffmpeg/ffprobe (merging, converting,
// reading lengths) and Deno (YouTube needs it to unlock video links).
// All three are downloaded on first launch into the app's own data folder.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fetchToFile, run, ensureDir } = require('./util');

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

const SOURCES = {
  ytdlp: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  ffmpeg: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  deno: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip'
};

class Engine {
  constructor({ dir, log }) {
    // SLIMTAKE_BIN lets the tests (and non-Windows development) point at other programs.
    this.dir = process.env.SLIMTAKE_BIN || ensureDir(dir);
    this.log = log;
    this.busy = false;
  }

  path(name) { return path.join(this.dir, name + EXE); }
  get ytdlp() { return this.path('yt-dlp'); }
  get ffmpeg() { return this.path('ffmpeg'); }
  get ffprobe() { return this.path('ffprobe'); }
  get deno() { return this.path('deno'); }

  status() {
    const has = (p) => { try { return fs.statSync(p).size > 0; } catch { return false; } };
    const s = { ytdlp: has(this.ytdlp), ffmpeg: has(this.ffmpeg) && has(this.ffprobe), deno: has(this.deno) };
    s.ready = s.ytdlp && s.ffmpeg && s.deno;
    return s;
  }

  // Extra arguments every yt-dlp call needs.
  baseArgs() {
    const a = ['--no-color', '--encoding', 'utf-8', '--ffmpeg-location', this.dir];
    if (fs.existsSync(this.deno)) a.push('--js-runtimes', `deno:${this.deno}`);
    return a;
  }

  env() {
    return { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  }

  async version() {
    const r = await run(this.ytdlp, ['--version'], { timeout: 20000 });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** First-run install. onStep({ part, label, got, total }) */
  async install(onStep, { force = false } = {}) {
    if (!WIN && !process.env.SLIMTAKE_BIN) throw new Error('Automatic engine setup is for Windows.');
    if (this.busy) throw new Error('Engine setup is already running');
    this.busy = true;
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slimtakes-'));
    try {
      const st = this.status();
      if (force || !st.ytdlp) {
        onStep({ part: 'ytdlp', label: 'Downloading yt-dlp' });
        await fetchToFile(SOURCES.ytdlp, this.ytdlp, { onProgress: (got, total) => onStep({ part: 'ytdlp', label: 'Downloading yt-dlp', got, total }) });
        this.log.info('yt-dlp installed');
      }
      if (force || !st.ffmpeg) {
        const zip = path.join(tmpRoot, 'ffmpeg.zip');
        onStep({ part: 'ffmpeg', label: 'Downloading ffmpeg' });
        await fetchToFile(SOURCES.ffmpeg, zip, { onProgress: (got, total) => onStep({ part: 'ffmpeg', label: 'Downloading ffmpeg', got, total }) });
        onStep({ part: 'ffmpeg', label: 'Unpacking ffmpeg' });
        await this.unzipPick(zip, tmpRoot, ['ffmpeg' + EXE, 'ffprobe' + EXE]);
        this.log.info('ffmpeg installed');
      }
      if (force || !st.deno) {
        const zip = path.join(tmpRoot, 'deno.zip');
        onStep({ part: 'deno', label: 'Downloading Deno (needed for YouTube)' });
        await fetchToFile(SOURCES.deno, zip, { onProgress: (got, total) => onStep({ part: 'deno', label: 'Downloading Deno (needed for YouTube)', got, total }) });
        onStep({ part: 'deno', label: 'Unpacking Deno' });
        await this.unzipPick(zip, tmpRoot, ['deno' + EXE]);
        this.log.info('Deno installed');
      }
      onStep({ part: 'done', label: 'Engine ready' });
      return this.status();
    } finally {
      this.busy = false;
      fs.rm(tmpRoot, { recursive: true, force: true }, () => {});
    }
  }

  // Windows 10/11 ship tar.exe, which can open .zip files.
  async unzipPick(zip, tmpRoot, wanted) {
    const out = ensureDir(path.join(tmpRoot, path.basename(zip, '.zip')));
    const tar = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip';
    const args = WIN ? ['-xf', zip, '-C', out] : ['-o', zip, '-d', out];
    const r = await run(tar, args, { timeout: 10 * 60 * 1000 });
    if (r.code !== 0) throw new Error('Could not unpack ' + path.basename(zip) + ': ' + (r.stderr || r.stdout).slice(0, 300));
    for (const name of wanted) {
      const found = findFile(out, name);
      if (!found) throw new Error(`${name} was not found inside ${path.basename(zip)}`);
      const dest = path.join(this.dir, name);
      try { fs.rmSync(dest, { force: true }); } catch { /* in use? */ }
      fs.copyFileSync(found, dest);
      if (!WIN) fs.chmodSync(dest, 0o755);
    }
  }

  /** yt-dlp updates itself in place. */
  async updateYtdlp() {
    if (!this.status().ytdlp) return { ok: false, message: 'yt-dlp is not installed yet' };
    const r = await run(this.ytdlp, ['-U'], { timeout: 5 * 60 * 1000, env: this.env() });
    const text = (r.stdout + '\n' + r.stderr).trim();
    this.log.info('yt-dlp update: ' + text.split('\n').slice(-2).join(' | '));
    if (r.code !== 0) return { ok: false, message: text.split('\n').pop() || 'Update failed' };
    const upToDate = /up to date|is up-to-date/i.test(text);
    return { ok: true, updated: !upToDate, message: upToDate ? 'Already up to date' : 'Updated' };
  }

  /** Does a video file have sound? true / false, or null if it can't tell. */
  async hasAudio(file) {
    const r = await run(this.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { timeout: 30000 }).catch(() => null);
    if (!r || r.code !== 0) return null;
    return r.stdout.trim().length > 0;
  }

  async probeDuration(file) {
    const r = await run(this.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 30000 });
    const n = parseFloat(r.stdout);
    return Number.isFinite(n) ? n : null;
  }
}

function findFile(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === name.toLowerCase()) return p;
    }
  }
  return null;
}

module.exports = { Engine, SOURCES };
