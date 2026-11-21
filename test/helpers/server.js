'use strict';
// A local video server for tests: can slow down each connection, refuse split downloads, fail parts, etc.
const http = require('http');
const crypto = require('crypto');
const MB = 1024 * 1024;
function videoBytes(size, seed = 1) {
  const b = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x & 0xff; }
  Buffer.from([0, 0, 0, 24]).copy(b, 0);
  Buffer.from('ftypisom').copy(b, 4);
  return b;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// opts: throttle (bytes per 20 ms per connection), noRanges, failRate, needHeaders, html, redirect,
//   maxConns (more at once are turned away with refuseStatus, default 503; retryAfter seconds),
//   burst { bytes, slow }: each request gets `bytes` fast, then `slow` bytes per 20 ms,
//   tokens: only addresses with ?t=<a token in stats.tokens> work (403 otherwise); expireAfter: n pieces, then token 'a' stops working,
//   stallOnce: offset; the first request for a piece past it hangs without sending anything
function serve(file, opts = {}) {
  const stats = { born: Date.now(), requests: 0, ranged: 0, peak: 0, open: 0, seenHeaders: [], refused: 0, bytes: 0, tokens: new Set(['a', 'b']), pieces: 0 };
  let stalled = false;
  const server = http.createServer((req, res) => {
    stats.requests++;
    if (opts.tokens) {
      const t = new URL(req.url, 'http://x').searchParams.get('t');
      if (!stats.tokens.has(t)) { res.writeHead(403); return res.end('expired'); }
    }
    if (opts.busyFor && Date.now() - stats.born < opts.busyFor) { stats.refused++; res.writeHead(503); return res.end('busy'); }
    if (opts.maxConns && req.headers.range && stats.open >= opts.maxConns) {
      stats.refused++;
      res.writeHead(opts.refuseStatus || 503, opts.retryAfter ? { 'Retry-After': String(opts.retryAfter) } : {});
      return res.end('busy');
    }
    stats.seenHeaders.push({ cookie: req.headers.cookie, referer: req.headers.referer, ua: req.headers['user-agent'] });
    if (opts.redirect && req.url === '/v.mp4') { res.writeHead(302, { Location: '/cdn/v.mp4?token=1' }); return res.end(); }
    if (opts.needHeaders && (!/pass=ok/.test(req.headers.cookie || '') || !req.headers.referer)) { res.writeHead(403); return res.end('no'); }
    if (opts.html) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!DOCTYPE html><html><head><title>Some Channel</title></head><body>x</body></html>'); }
    let from = 0, to = file.length - 1, status = 200;
    const m = (req.headers.range || '').match(/bytes=(\d+)-(\d*)/);
    // A site that answers the first part properly but sends the whole file for later parts.
    if (m && opts.onlyFirstPart && Number(m[1]) > 0) {
      stats.refused++;
      if (opts.onlyFirstPart === 429) { res.writeHead(429, { 'Retry-After': '1' }); return res.end('slow down'); }
    }
    else if (m && !opts.noRanges) {
      if (opts.failRate && Number(m[1]) > 0 && Math.random() < opts.failRate) { res.writeHead(500); return res.end('oops'); }
      from = Number(m[1]); to = m[2] ? Math.min(Number(m[2]), file.length - 1) : file.length - 1; status = 206; stats.ranged++;
    }
    if (m && Number(m[1]) > 0) {
      stats.pieces++;
      if (opts.expireAfter && stats.pieces > opts.expireAfter) stats.tokens.delete('a');
    }
    const headers = { 'Content-Type': 'video/mp4', 'Content-Length': to - from + 1, 'Accept-Ranges': opts.noRanges ? 'none' : 'bytes' };
    if (status === 206) headers['Content-Range'] = `bytes ${from}-${to}/${file.length}`;
    res.writeHead(status, headers);
    stats.open++; stats.peak = Math.max(stats.peak, stats.open);
    let pos = from;
    let closed = false;
    const done = () => { if (!closed) { closed = true; stats.open--; } };
    if (opts.stallOnce != null && !stalled && from > opts.stallOnce) { stalled = true; stats.stalls = 1; return; } // hangs
    const step = opts.throttle || 1e9;
    let sent = 0;
    const pump = () => {
      if (closed) return;
      if (pos > to) { done(); return res.end(); }
      let n = step;
      let slow = !!opts.throttle;
      if (opts.burst) { slow = sent >= opts.burst.bytes; n = slow ? opts.burst.slow : opts.burst.bytes - sent; }
      const end = Math.min(to + 1, pos + n);
      const ok = res.write(file.subarray(pos, end));
      stats.bytes += end - pos; sent += end - pos;
      pos = end;
      if (pos > to) { done(); return res.end(); } // finished sending: no longer counts as open
      if (slow) setTimeout(pump, 20); else if (ok) setImmediate(pump); else res.once('drain', pump);
    };
    res.on('close', done);
    pump();
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, stats, opts, base: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { serve, videoBytes, sha, MB };
