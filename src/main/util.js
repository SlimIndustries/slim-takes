'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

// ---------- log ----------
class Logger {
  constructor(file) {
    this.file = file;
    this.lines = [];
    this.listeners = new Set();
    try {
      // Keep the log file from growing forever.
      if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old');
    } catch { /* ignore */ }
  }
  write(msg, level = 'info') {
    const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${level.toUpperCase()} ${msg}`;
    this.lines.push(line);
    if (this.lines.length > 3000) this.lines.splice(0, this.lines.length - 3000);
    try { fs.appendFileSync(this.file, line + '\n'); } catch { /* ignore */ }
    for (const fn of this.listeners) { try { fn(line); } catch { /* ignore */ } }
  }
  info(m) { this.write(m, 'info'); }
  warn(m) { this.write(m, 'warn'); }
  error(m) { this.write(m, 'error'); }
  text() { return this.lines.join('\n'); }
  clear() {
    this.lines = [];
    try { fs.writeFileSync(this.file, ''); fs.rmSync(this.file + '.old', { force: true }); } catch { /* ignore */ }
  }
}

// ---------- json file store ----------
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = Array.isArray(defaults) ? loaded : { ...structuredClone(defaults), ...loaded };
    } catch (e) {
      if (fs.existsSync(file)) {
        // Corrupt file: keep a copy so nothing is silently lost.
        try { fs.copyFileSync(file, file + '.broken'); } catch { /* ignore */ }
      }
    }
    this.timer = null;
  }
  get() { return this.data; }
  set(data) { this.data = data; this.saveSoon(); }
  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 300);
  }
  saveNow() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
    } catch { /* disk full or locked; try again next change */ }
  }
}

// ---------- downloads over https (follows GitHub's redirects) ----------
function fetchToFile(url, dest, { onProgress, headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'SlimTakes', ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchToFile(next, dest, { onProgress, headers, redirects: redirects + 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (${res.statusCode}) for ${url}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const tmp = dest + '.download';
      const out = fs.createWriteStream(tmp);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (onProgress) onProgress(got, total);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        try { fs.renameSync(tmp, dest); resolve(dest); } catch (e) { reject(e); }
      }));
      out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } reject(e); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Connection timed out')));
  });
}

function fetchJson(url, { headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SlimTakes', Accept: 'application/json', ...headers } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchJson(new URL(res.headers.location, url).toString(), { headers, timeout }));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timed out')));
  });
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Bad webhook address')); }
    if (u.protocol !== 'https:') return reject(new Error('Webhook must start with https://'));
    const body = Buffer.from(JSON.stringify(payload));
    const req = https.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'User-Agent': 'SlimTakes' } }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode < 300 ? resolve() : reject(new Error(`Discord said ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timed out')));
    req.end(body);
  });
}

// ---------- run a program and collect its output ----------
function run(cmd, args, { env, timeout = 0, onLine, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, ...env }, cwd });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message });
    }
    let stdout = '', stderr = '', buf = '';
    let timer = null;
    if (timeout) timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (onLine) {
        buf += d;
        let i;
        while ((i = buf.search(/[\r\n]/)) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; if (onLine) d.split(/[\r\n]+/).forEach((l) => l.trim() && onLine(l)); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); if (onLine && buf.trim()) onLine(buf); resolve({ code, stdout, stderr }); });
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function freeBytes(dir) {
  try {
    let d = dir;
    while (d && !fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; }
    const s = fs.statfsSync(d);
    return s.bavail * s.bsize;
  } catch { return null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

module.exports = { Logger, JsonStore, fetchToFile, fetchJson, postJson, run, ensureDir, freeBytes, sleep, compareVersions };
