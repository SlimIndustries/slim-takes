'use strict';
// A tiny private web server for the Trim player: serves the video/audio files the user chose, with
// seeking (byte ranges), to this PC only (127.0.0.1), and only with a random secret in the address.
// Why not the app's own file channel? Chromium's media player has bugs with custom file channels
// (a video can go blank after jumping around and won't load again); over plain local http it doesn't.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg'
};

/**
 * Start the server. opts: { allowed(path) -> boolean, hook(req, res) -> true if it handled it (tests only) }.
 * Resolves to { url(path, n), close(), port, token }.
 */
function startMediaServer({ allowed, hook } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const open = new Set();
  const server = http.createServer((req, res) => {
    res.on('close', () => open.delete(res));
    open.add(res);
    try { handle(req, res); } catch { try { res.writeHead(500); res.end(); } catch { /* gone */ } }
  });
  let port = 0;

  function deny(res, code = 403) { res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(code === 403 ? 'Not allowed' : 'Not found'); }

  function handle(req, res) {
    // Only this PC, only the right address (stops web pages from reaching it via tricks with names).
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return deny(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405);
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const parts = u.pathname.split('/');
    if (parts[1] !== token || parts[2] !== 'm') return deny(res);
    const file = u.searchParams.get('p') || '';
    if (!file || !allowed || !allowed(file)) return deny(res);
    if (hook && hook(req, res, file)) return;
    let st;
    try { st = fs.statSync(file); } catch { return deny(res, 404); }
    if (!st.isFile()) return deny(res, 404);
    const size = st.size;
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    let start = 0, end = size - 1, status = 200;
    const range = String(req.headers.range || '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (range && m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); } // the last N bytes
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
      if (start >= size || start > end) {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      status = 206;
      base['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    res.writeHead(status, { ...base, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    // The player cancels requests all the time when you jump around: always close the file then.
    const stop = () => stream.destroy();
    res.on('close', stop);
    stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
    stream.pipe(res);
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.keepAliveTimeout = 5000;
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port, token,
        /** The address for a file. n: a different number gives a different address (for reloading). */
        url: (file, n) => `http://127.0.0.1:${port}/${token}/m?p=${encodeURIComponent(file)}${n ? '&r=' + n : ''}`,
        close: () => new Promise((r) => { for (const x of open) { try { x.destroy(); } catch { /* gone */ } } server.close(() => r()); }),
        openRequests: () => open.size
      });
    });
  });
}

module.exports = { startMediaServer };
