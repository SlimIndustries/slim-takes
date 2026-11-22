'use strict';
// Download one video file as fast as the site will allow, the way download managers do:
//  - the file is fetched in 4 MB pieces over several connections at once (sites often slow each one down);
//  - every piece is a fresh request, so sites that start each request fast and then slow it down
//    keep giving the fast start, even when only one connection is allowed;
//  - the number of connections finds its own level: a site that turns extra ones away gets fewer
//    (shared across all downloads from the same server), and gets tried with more again later;
//  - other servers with the very same file (checked byte for byte) are used at the same time;
//  - an expired link is renewed and the download carries on where it was;
//  - pausing keeps what's done, so resuming (even after a restart) carries on instead of starting over;
//  - a piece that stalls is asked for again; "slow down" answers are respected.
// If a site won't do pieces at all, it falls back to one plain connection.

const fs = require('fs');
const crypto = require('crypto');
const { sniffMedia } = require('./scanlogic');

const CHUNK = 4 * 1024 * 1024;       // each request asks for 4 MB
const MIN_SPLIT = 8 * 1024 * 1024;   // smaller files: one plain request is fine
const HEAD = 65536;                  // the first bytes, asked for first (and used to recognise the file)
const PIECE_TRIES = 6;               // server hiccups on one piece before giving up on it
const STALL_MS = 20000;              // no data for this long: ask for the piece again
const RAMP_EVERY = 40;               // after this many good pieces in a row, try one more connection
const MAX_CONNECTIONS = 16;
const REFRESHES = 3;
const TRANSIENT = new Set([500, 502, 504, 408, 520, 521, 522, 523, 524]);

class FastGetError extends Error {
  constructor(message, props = {}) { super(message); Object.assign(this, props); }
}

/** A cookie header for a URL from a Netscape cookies.txt (the format the app already saves). */
function cookieHeader(cookieText, url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  const out = [];
  const now = Date.now() / 1000;
  for (let line of String(cookieText || '').split(/\r?\n/)) {
    if (line.startsWith('#HttpOnly_')) line = line.slice(10);
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [domain, , cpath, secure, expires, name, ...rest] = f;
    const d = domain.replace(/^\./, '').toLowerCase();
    if (!(host === d || host.endsWith('.' + d))) continue;
    if (secure === 'TRUE' && u.protocol !== 'https:') continue;
    if (cpath && !u.pathname.startsWith(cpath)) continue;
    if (Number(expires) && Number(expires) < now) continue;
    out.push(`${name}=${rest.join('\t')}`);
  }
  return out.join('; ');
}

// ---------- connections per server, shared by every download from it ----------
// limit: how many at once the server currently accepts (Infinity until it turns one away).
const pools = new Map();
function serverOf(url) { try { return new URL(url).host.toLowerCase(); } catch { return String(url); } }
function pool(server, learned) {
  let p = pools.get(server);
  if (!p) {
    p = { server, limit: learned > 0 ? learned : Infinity, inUse: 0, accepted: 0, waiters: [], good: 0, best: 0, refused: 0, busyUntil: 0 };
    pools.set(server, p);
  }
  return p;
}
function wake(p) {
  while (p.waiters.length && p.inUse < p.limit && Date.now() >= p.busyUntil) { p.inUse++; p.waiters.shift().go(); }
  if (p.waiters.length && p.busyUntil > Date.now() && !p.timer) {
    p.timer = setTimeout(() => { p.timer = null; wake(p); }, p.busyUntil - Date.now() + 5);
  }
}
function acquire(p, signal) {
  if (p.inUse < p.limit && Date.now() >= p.busyUntil && !p.waiters.length) { p.inUse++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const w = { go: () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); } };
    const onAbort = () => { p.waiters = p.waiters.filter((x) => x !== w); reject(new FastGetError('Stopped', { aborted: true })); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    p.waiters.push(w);
    wake(p);
  });
}
function release(p) { p.inUse = Math.max(0, p.inUse - 1); wake(p); }
/** The server turned a connection away: allow one fewer than were open (never below 1). */
function tooMany(p, retryAfterMs) {
  // The connections the server accepted and is still sending on are what it allows at once.
  p.limit = Math.max(1, Math.min(p.limit, p.accepted));
  p.good = 0;
  p.refused++;
  if (retryAfterMs) p.busyUntil = Math.max(p.busyUntil, Date.now() + retryAfterMs);
}
/** A piece came down fine: remember the most that worked, and every so often try one more. */
function worked(p, cap, every = RAMP_EVERY) {
  p.good++;
  if (p.limit !== Infinity && p.good >= every && p.limit < cap) { p.limit++; p.good = 0; wake(p); }
}

function retryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (!v) return 0;
  const n = Number(v);
  const ms = Number.isFinite(n) ? n * 1000 : Date.parse(v) - Date.now();
  return Math.max(1000, Math.min(30000, ms || 0));
}

const hash = (b) => crypto.createHash('sha1').update(b).digest('hex');

/**
 * Download `url` to `file`. opts: {
 *   headers, or headersFor(url) (referer, user agent, cookies for that address),
 *   connections (1-16, the most for this one download), learnedLimit (what this server accepted last time),
 *   mirrors: [other addresses that may have the same file],
 *   refresh: async () => a new address for the same video (links that expire), or null,
 *   keepOnStop (pausing keeps what's done, for carrying on later), signal, onProgress({ downloaded, total, speed }),
 *   fetchImpl (tests), log
 * }
 * Returns { total, connections, servers, resumedFrom, seconds, speed, limit } or throws FastGetError
 *   (.notVideo, .rateLimited, .status, .aborted, .expired, .splitFailed).
 */
async function fastGet(url, file, opts = {}) {
  try {
    return await fastGetPieces(url, file, opts);
  } catch (e) {
    // Pieces didn't work out at all: the plain way, one connection, start to finish.
    if (e.splitFailed && !(opts.signal && opts.signal.aborted)) {
      if (opts.log) opts.log(`the site wouldn't send the file in pieces (${e.message}): downloading it in one go`);
      clearState(file);
      return plainGet(e.url || url, file, opts);
    }
    throw e;
  }
}

function makeGetter(opts) {
  const doFetch = opts.fetchImpl || fetch;
  const headersFor = opts.headersFor || (() => opts.headers || {});
  return (addr, range, ctl) => doFetch(addr, {
    headers: { ...headersFor(addr), ...(range ? { Range: range } : {}) },
    redirect: 'follow', signal: ctl ? ctl.signal : opts.signal
  });
}

function speedMeter(onProgress, startBytes) {
  const samples = [];
  let last = 0;
  return (downloaded, total, force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - last < 400) return;
    last = now;
    samples.push([now, downloaded]);
    while (samples.length > 2 && now - samples[0][0] > 4000) samples.shift(); // speed over the last few seconds
    const [t0, b0] = samples[0];
    const speed = now - t0 > 0 ? ((downloaded - b0) * 1000) / (now - t0) : 0;
    onProgress({ downloaded, total, speed: Math.max(0, speed), resumedFrom: startBytes });
  };
}

function checkStart(bytes, type) {
  const kind = sniffMedia(bytes, type);
  if (kind === 'html' || kind === 'text') throw new FastGetError('The site sent a web page instead of the video.', { notVideo: true });
}

function statusError(res, what = 'the video file') {
  if (res.status === 429) return new FastGetError('The site asked Slim Takes to slow down (too many requests).', { rateLimited: true, status: 429, retryAfter: retryAfterMs(res) });
  return new FastGetError(`The site refused ${what} (HTTP ${res.status}).`, { status: res.status, expired: [401, 403, 404, 410].includes(res.status) });
}

async function readBody(res, maxBytes) {
  const out = [];
  let n = 0;
  for await (const chunk of res.body) {
    const take = n + chunk.length > maxBytes ? chunk.subarray(0, maxBytes - n) : chunk;
    out.push(take); n += take.length;
    if (n >= maxBytes) break;
  }
  try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* done */ }
  return Buffer.concat(out.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length)));
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(new FastGetError('Stopped', { aborted: true }));
  const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', on); resolve(); }, ms);
  const on = () => { clearTimeout(t); reject(new FastGetError('Stopped', { aborted: true })); };
  if (signal) signal.addEventListener('abort', on, { once: true });
});

/**
 * Send a request once the server has a free connection, and keep trying while it says "busy"
 * (503 / 429): those mean "not now", not "no". Returns the answer with the connection still held:
 * the caller gives it back with release(p). Gives up (FastGetError .busy) after opts.busyMaxMs.
 */
async function whenFree(p, opts, send) {
  const started = Date.now();
  let n = 0;
  for (;;) {
    await acquire(p, opts.signal);
    let res;
    try { res = await send(); } catch (e) { release(p); throw wrapAbort(e, opts.signal); }
    if (res.status !== 503 && res.status !== 429) return res;
    const wait = retryAfterMs(res);
    const others = p.accepted > 0;
    await drain(res);
    release(p);
    n++;
    // Others are working: it's the connection limit. Nothing working: the server is busy, so back off.
    tooMany(p, others ? (res.status === 429 ? wait : 0) : (wait || Math.min(8000, 1000 * n)));
    if (opts.log && n === 1) opts.log(`${p.server} is busy (HTTP ${res.status}): waiting for a free connection`);
    if (Date.now() - started > (opts.busyMaxMs || 180000)) {
      throw new FastGetError('The video server stayed busy (it allows only a few downloads at once).', { busy: true, status: res.status });
    }
    await sleep(others ? 250 : 50, opts.signal);
  }
}

/** Ask for the first bytes: is this address splittable, how big is the file, what do its first bytes look like?
 *  If it isn't splittable, the answer (the whole file) comes back with its connection still held (.held). */
async function probe(get, addr, opts, busyMaxMs) {
  const p = pool(serverOf(addr), opts.learnedLimit);
  const res = await whenFree(p, { ...opts, busyMaxMs: busyMaxMs || opts.busyMaxMs }, () => get(addr, `bytes=0-${HEAD - 1}`));
  try {
    if (res.status >= 400) { await drain(res); throw statusError(res); }
    const cr = (res.headers.get('content-range') || '').match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
    const splittable = res.status === 206 && !!cr && Number(cr[1]) === 0;
    if (!splittable) return { res, held: p, splittable: false, total: Number(res.headers.get('content-length')) || null, type: res.headers.get('content-type') };
    const head = await readBody(res, HEAD);
    release(p);
    return { splittable: true, total: Number(cr[3]), head, type: res.headers.get('content-type') };
  } catch (e) { release(p); throw e; }
}

/** A few bytes from the middle of a file (to compare two servers' copies). */
async function sample(get, addr, at, opts) {
  const p = pool(serverOf(addr));
  const res = await whenFree(p, { ...opts, busyMaxMs: 8000, log: null }, () => get(addr, `bytes=${at}-${at + 4095}`));
  try { return res.status === 206 ? await readBody(res, 4096) : (await drain(res), null); } finally { release(p); }
}

// ---------- carrying on later ----------
const stateFile = (file) => file + '.json';
function loadState(file, total, headHash) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(file), 'utf8'));
    if (s.v !== 1 || s.total !== total || s.head !== headHash || s.chunk !== CHUNK) return null;
    if (fs.statSync(file).size !== total) return null;
    return new Set(s.done);
  } catch { return null; }
}
function saveState(file, total, headHash, done) {
  try { fs.writeFileSync(stateFile(file), JSON.stringify({ v: 1, total, head: headHash, chunk: CHUNK, done: [...done] })); } catch { /* best effort */ }
}
function clearState(file) { try { fs.unlinkSync(stateFile(file)); } catch { /* none */ } }

async function fastGetPieces(url, file, opts) {
  const { signal, log } = opts;
  const cap = Math.max(1, Math.min(MAX_CONNECTIONS, Number(opts.connections) || 4));
  const get = makeGetter(opts);
  const started = Date.now();

  let first;
  try { first = await probe(get, url, opts); } catch (e) { throw wrapAbort(e, signal); }
  if (!first.splittable) {
    // The whole file came back (no pieces from this site): use that answer as the download.
    return plainGet(url, file, opts, first);
  }
  const total = first.total;
  checkStart(first.head.subarray(0, 4096), first.type);
  const headHash = hash(first.head);
  if (total < MIN_SPLIT || total <= HEAD) { clearState(file); return plainGet(url, file, opts); }

  // Pieces: number i covers [i*CHUNK, (i+1)*CHUNK); piece 0 starts after the first bytes we already have.
  const count = Math.ceil(total / CHUNK);
  let done = loadState(file, total, headHash);
  const resumed = !!done;
  if (!done) done = new Set();
  const fd = fs.openSync(file, resumed ? 'r+' : 'w');
  let fdOpen = true;
  const closeFd = () => { if (fdOpen) { fdOpen = false; try { fs.closeSync(fd); } catch { /* gone */ } } };
  let keep = false;
  try {
    if (!resumed) fs.ftruncateSync(fd, total);
    fs.writeSync(fd, first.head, 0, first.head.length, 0);
    const pieceRange = (i) => [i === 0 ? HEAD : i * CHUNK, Math.min(total, (i + 1) * CHUNK) - 1];
    const todo = [];
    for (let i = 0; i < count; i++) if (!done.has(i) && pieceRange(i)[0] <= pieceRange(i)[1]) todo.push(i);
    let downloaded = first.head.length;
    for (const i of done) { const [a, b] = pieceRange(i); downloaded += b - a + 1; }
    const resumedFrom = resumed ? downloaded : 0;
    if (resumed && log) log(`carrying on from ${Math.round(downloaded / 1e6)} MB (already downloaded before)`);
    const report = speedMeter(opts.onProgress, resumedFrom);

    // Servers: the main address, plus others that hold exactly the same file.
    const sources = [{ url, pool: pool(serverOf(url), opts.learnedLimit), dead: false, bytes: 0, refusedInARow: 0, main: true }];
    for (const m of (opts.mirrors || []).slice(0, 3)) {
      if (!m || m === url || serverOf(m) === serverOf(url) && m.split('?')[0] === url.split('?')[0]) continue;
      try {
        const p = await probe(get, m, { ...opts, learnedLimit: undefined, log: null }, 8000);
        if (!p.splittable || p.total !== total || hash(p.head) !== headHash) {
          if (p.res) { await drain(p.res); release(p.held); }
          if (log) log(`another server (${serverOf(m)}) has a different file: not used`);
          continue;
        }
        // Same start and size: compare a piece from the middle too before trusting it.
        const mid = Math.floor(total / 2);
        const ba = await sample(get, url, mid, opts);
        const bb = await sample(get, m, mid, opts);
        if (!ba || !bb || !ba.equals(bb)) { if (log) log(`another server (${serverOf(m)}) has a different file: not used`); continue; }
        sources.push({ url: m, pool: pool(serverOf(m)), dead: false, bytes: 0, refusedInARow: 0 });
        if (log) log(`another server (${serverOf(m)}) has the same file: using both`);
      } catch (e) {
        if (signal && signal.aborted) throw wrapAbort(e, signal);
        if (log) log(`another server (${serverOf(m)}) didn't answer properly: not used`);
      }
    }
    if (log) log(`up to ${cap} connection${cap === 1 ? '' : 's'}${sources.length > 1 ? ` per server, ${sources.length} servers` : ''}, ${Math.round(total / 1e6)} MB${resumed ? `, ${todo.length} pieces left` : ''}`);

    let failed = null;
    let refreshes = 0;
    let refreshing = null;
    let peak = 0;       // the most connections that were really sending at once (for the log)
    let streaming = 0;
    let active = 0;
    let lastSave = Date.now();
    const keepState = () => { if (Date.now() - lastSave > 2000) { lastSave = Date.now(); saveState(file, total, headHash, done); } };

    // The main link stopped working (expired?): get a new one for the same file, once at a time.
    const renew = async (src) => {
      if (!opts.refresh || refreshes >= REFRESHES) return false;
      if (!refreshing) {
        refreshing = (async () => {
          refreshes++;
          if (log) log('the video link stopped working (it may have expired): getting a fresh one');
          const next = await opts.refresh().catch(() => null);
          if (!next) return false;
          const p = await probe(get, next, opts).catch(() => null);
          if (!p || !p.splittable || p.total !== total || hash(p.head) !== headHash) { if (p && p.res) { await drain(p.res); release(p.held); } if (log) log('the fresh link is for a different file'); return false; }
          const best = src.pool.best;
          src.url = next;
          src.pool = pool(serverOf(next), best || undefined);
          // Its refusals were the expired link, not too many connections: allow what worked before.
          if (best && src.pool.limit < best) { src.pool.limit = best; wake(src.pool); }
          src.dead = false; src.refusedInARow = 0;
          if (log) log('got a fresh link: carrying on');
          return true;
        })().finally(() => { setTimeout(() => { refreshing = null; }, 0); });
      }
      return refreshing;
    };

    const fetchPiece = async (src, i) => {
      const [from, to] = pieceRange(i);
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      if (signal) signal.addEventListener('abort', stop, { once: true });
      let got = 0;
      let counted = false;
      let stall;
      const arm = () => { clearTimeout(stall); stall = setTimeout(() => { ctl.stalled = true; ctl.abort(); }, opts.stallMs || STALL_MS); };
      try {
        arm();
        const res = await get(src.url, `bytes=${from}-${to}`, ctl);
        // Server hiccups ("error", "bad gateway", "timeout"): ask for the piece again, they're not a "no".
        if (TRANSIENT.has(res.status)) { await drain(res); return { transient: 'HTTP ' + res.status }; }
        if (res.status !== 206) { const accepted = src.pool.accepted; await drain(res); return { refused: res.status, retryAfter: retryAfterMs(res), accepted }; }
        const cr = (res.headers.get('content-range') || '').match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
        if (!cr || Number(cr[1]) !== from || Number(cr[3]) !== total) { await drain(res); return { refused: 'wrong part' }; }
        if (/text\/html/i.test(res.headers.get('content-type') || '')) { await drain(res); return { refused: 'web page' }; }
        let pos = from;
        src.pool.accepted++; counted = true;
        streaming++; peak = Math.max(peak, streaming);
        // The server took more at once than the limit says (some were already on their way): it allows that many.
        if (src.pool.accepted > src.pool.limit) src.pool.limit = src.pool.accepted;
        src.pool.best = Math.max(src.pool.best, src.pool.accepted);
        for await (const chunk of res.body) {
          arm();
          const room = to + 1 - pos;
          const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
          if (take.length) fs.writeSync(fd, take, 0, take.length, pos);
          pos += take.length; got += take.length; downloaded += take.length; src.bytes += take.length;
          report(downloaded, total);
          if (pos > to) break;
        }
        if (pos !== to + 1) return { transient: 'came back short', got };
        return { ok: true };
      } catch (e) {
        if (signal && signal.aborted) throw new FastGetError('Stopped', { aborted: true });
        return { transient: ctl.stalled ? 'stalled' : (e && (e.cause && e.cause.code || e.code)) || 'connection dropped', got, network: !ctl.stalled };
      } finally {
        clearTimeout(stall);
        if (counted) { src.pool.accepted--; streaming--; }
        if (signal) signal.removeEventListener('abort', stop);
      }
    };

    // Each worker takes the next piece, waits for a free connection on its server, and fetches it.
    const worker = async (src) => {
      while (!failed && !src.dead) {
        if (!todo.length) {
          // Nothing left to start, but a piece in flight may still fail and come back.
          if (active === 0) return;
          await new Promise((res) => setTimeout(res, 150));
          continue;
        }
        await acquire(src.pool, signal);
        if (failed || src.dead) { release(src.pool); return; }
        if (!todo.length) { release(src.pool); continue; } // all handed out for now: wait above in case one comes back
        const i = todo.shift();
        active++;
        let r;
        try { r = await fetchPiece(src, i); } finally { active--; release(src.pool); }
        if (r.ok) {
          done.add(i); src.refusedInARow = 0; src.alone = 0; src.busySince = 0; src.netFails = 0; // hiccups only count in a row
          worked(src.pool, cap, opts.rampEvery);
          keepState();
          continue;
        }
        if (r.got) { downloaded -= r.got; src.bytes -= r.got; }
        todo.unshift(i); // somebody does it again
        src.tries = (src.tries || 0) + 1;
        if (r.refused !== undefined) {
          src.refusedInARow++;
          const busy = r.refused === 429 || r.refused === 503;
          const otherOpen = r.accepted > 0;
          const what = typeof r.refused === 'number' ? 'HTTP ' + r.refused : r.refused;
          if (otherOpen) {
            // Others are working: the server is turning away extra connections. Use fewer (no waiting,
            // unless it said exactly how long to wait).
            const before = src.pool.limit;
            tooMany(src.pool, r.refused === 429 ? r.retryAfter : 0);
            if (log && src.pool.limit !== before) log(`${serverOf(src.url)} turned a connection away (${what}): using ${src.pool.limit} at once`);
          } else if (busy) {
            // Refused even on its own with "busy / slow down": back off properly.
            src.alone = (src.alone || 0) + 1;
            tooMany(src.pool, r.retryAfter || Math.min(8000, 1000 * src.alone));
            if (log && src.alone === 1) log(`${serverOf(src.url)} is busy (${what}): waiting a moment`);
            src.busySince = src.busySince || Date.now();
            // Busy for minutes on end: stop for now (what's done is kept; the queue tries again later).
            if (Date.now() - src.busySince > (opts.busyMaxMs || 180000)) { src.dead = true; src.busy = true; src.busyStatus = r.refused; }
          }
          if (src.refusedInARow >= 3 && !otherOpen && !busy) {
            // Refused even alone: the link has expired, or this server won't do pieces.
            if (src.main && [401, 403, 404, 410].includes(r.refused) && await renew(src)) continue;
            src.dead = true;
            if (log) log(`${serverOf(src.url)} stopped sending pieces (${what})`);
          }
          if (!src.dead && !otherOpen) await new Promise((res) => setTimeout(res, Math.min(3000, 200 * src.refusedInARow)));
        } else {
          src.netFails = (src.netFails || 0) + 1;
          if (r.network && src.pool.accepted > 0 && src.netFails % 2 === 0) tooMany(src.pool, 500); // dropped while others open: too many
          if (src.netFails >= PIECE_TRIES * 2 && !sources.some((s) => s !== src && !s.dead)) { failed = new FastGetError(`pieces kept failing (${r.transient})`, { splitFailed: !done.size, network: true }); }
          else if (src.netFails >= PIECE_TRIES * 2) src.dead = true;
          await new Promise((res) => setTimeout(res, Math.min(4000, 300 * src.netFails)));
        }
      }
    };

    // Workers per server: as many as this download may use; the shared pool decides how many really run.
    const runners = [];
    const spawn = (src) => { for (let k = 0; k < cap; k++) runners.push(worker(src).catch((e) => { failed = failed || wrapAbort(e, signal); })); };
    sources.forEach(spawn);
    await Promise.all(runners);
    // A server that died left pieces behind with nobody to take them? (all dead)
    if (!failed && todo.length) {
      const main = sources[0];
      if (sources.every((s) => s.dead)) {
        if (signal && signal.aborted) failed = new FastGetError('Stopped', { aborted: true });
        else if (sources.some((s) => s.busy)) failed = new FastGetError('The video server stayed busy (it allows only a few downloads at once).', { busy: true, status: sources.find((s) => s.busy).busyStatus });
        else if (!done.size) failed = new FastGetError('pieces were refused', { splitFailed: true, url: main.url });
        else failed = new FastGetError('The site stopped sending the video (the link may have expired).', { expired: true, status: 403 });
      }
    }
    if (failed) { if (!failed.splitFailed) keep = !!opts.keepOnStop || !!failed.expired || !!failed.rateLimited || !!failed.busy; throw failed; }
    if (signal && signal.aborted) { keep = !!opts.keepOnStop; throw new FastGetError('Stopped', { aborted: true }); }

    report(total, total, true);
    clearState(file);
    const seconds = (Date.now() - started) / 1000;
    const servers = sources.filter((s) => s.bytes > 0).map((s) => ({ server: serverOf(s.url), mb: Math.round(s.bytes / 1e6) }));
    const main = sources[0].pool;
    return { total, split: true, connections: peak, servers, resumedFrom, seconds, speed: (total - resumedFrom) / Math.max(0.001, seconds), limit: main.limit === Infinity ? null : main.limit, best: main.best };
  } catch (e) {
    const err = wrapAbort(e, signal);
    if (err.aborted) keep = keep || !!opts.keepOnStop;
    closeFd();
    if (keep) throw err; // what's done stays for next time
    try { fs.unlinkSync(file); } catch { /* none */ }
    clearState(file);
    throw err;
  } finally {
    closeFd();
    if (keep) saveState(file, total, headHash, done);
  }
}

/** One plain request for the whole file (sites that won't send pieces). `answer`: a response already in hand. */
async function plainGet(url, file, opts, answer) {
  const { signal, log } = opts;
  const get = makeGetter(opts);
  const started = Date.now();
  let res = answer && answer.res;
  let held = answer && answer.held;
  let fd;
  const closeFd = () => { if (fd !== undefined) { const f = fd; fd = undefined; try { fs.closeSync(f); } catch { /* gone */ } } };
  try {
    if (!res) { held = pool(serverOf(url), opts.learnedLimit); res = await whenFree(held, opts, () => get(url, null)).catch((e) => { held = null; throw e; }); }
    if (res.status >= 400) { await drain(res); throw statusError(res); }
    const total = Number(res.headers.get('content-length')) || null;
    if (log && answer) log('the site doesn\'t send files in pieces: one connection');
    const report = speedMeter(opts.onProgress, 0);
    fd = fs.openSync(file, 'w');
    let pos = 0;
    let checked = false;
    for await (const chunk of res.body) {
      if (!checked) { checkStart(chunk.subarray(0, 4096), res.headers.get('content-type')); checked = true; }
      fs.writeSync(fd, chunk, 0, chunk.length, pos);
      pos += chunk.length;
      report(pos, total);
    }
    if (signal && signal.aborted) throw new FastGetError('Stopped', { aborted: true });
    if (total && pos !== total) throw new FastGetError(`The download stopped early (${pos} of ${total} bytes).`, { incomplete: true, network: true });
    report(pos, pos, true);
    const seconds = (Date.now() - started) / 1000;
    return { total: pos, connections: 1, servers: [{ server: serverOf(url), mb: Math.round(pos / 1e6) }], resumedFrom: 0, seconds, speed: pos / Math.max(0.001, seconds), limit: null, best: 1, plain: true, split: false };
  } catch (e) {
    closeFd();
    try { fs.unlinkSync(file); } catch { /* none */ }
    clearState(file);
    throw wrapAbort(e, signal);
  } finally {
    closeFd();
    if (held) { release(held); held = null; }
  }
}

function wrapAbort(e, signal) {
  if (e instanceof FastGetError) return e;
  if (signal && signal.aborted) return new FastGetError('Stopped', { aborted: true });
  return new FastGetError(e && e.message ? e.message : String(e), { network: true });
}

async function drain(res) {
  try { if (res.body && res.body.cancel) await res.body.cancel(); else await res.arrayBuffer(); } catch { /* ignore */ }
}

/** Is this a video stream list (HLS/DASH)? Those go to the engine, which fetches the pieces in parallel. */
function isStreamUrl(url) { return /\.(m3u8|mpd)(\?|$)/i.test(String(url || '')); }

/** Forget what servers accepted (tests). */
function resetPools() { pools.clear(); }

/** How many connections a server accepts at once, as found out while the app runs (null: no limit seen). */
function serverLimit(server) {
  const p = pools.get(String(server || '').toLowerCase());
  return p && p.limit !== Infinity ? p.limit : null;
}

module.exports = { fastGet, cookieHeader, isStreamUrl, FastGetError, CHUNK, MIN_SPLIT, MAX_CONNECTIONS, resetPools, pools, stateFile, serverLimit, serverOf };
