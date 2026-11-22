'use strict';
const { tmpdir } = require('./helpers/tmp');
// The downloader against sites that fight back: connection limits, fast-start-then-slow, expiring
// links, stalls, "slow down" answers, other servers with the same file, and carrying on after a pause.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fastGet, resetPools, stateFile } = require('../src/main/fastget');
const { serve, videoBytes, sha, MB } = require('./helpers/server');

const tmpFile = () => path.join(tmpdir('fl-'), 'out.mp4');
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t]; };
test.beforeEach(() => resetPools());

for (const status of [503, 403, 429]) {
  test(`a site that allows only 2 connections (turns more away with ${status}): settles on 2, file right, faster than 1`, async () => {
    const file = videoBytes(24 * MB);
    const srv = await serve(file, { throttle: 48 * 1024, maxConns: 2, refuseStatus: status, retryAfter: status === 429 ? 1 : 0 });
    try {
      const logs = [];
      const [r, ms] = await timed(() => fastGet(srv.base + '/v.mp4', tmpFile(), { connections: 8, log: (m) => logs.push(m) }));
      assert.equal(r.split, true);
      assert.equal(r.limit, 2, logs.join('\n'));
      assert.ok(srv.stats.refused <= 12, 'only a few refusals: ' + srv.stats.refused);
      assert.ok(logs.some((l) => /turned a connection away .*using 2 at once/.test(l)), logs.join('\n'));
      resetPools();
      const one = tmpFile();
      const [, single] = await timed(() => fastGet(srv.base + '/v.mp4', one, { connections: 1 }));
      assert.equal(sha(fs.readFileSync(one)), sha(file));
      assert.ok(ms * 1.5 < single, `2 connections ${ms} ms vs 1: ${single} ms`);
    } finally { srv.server.close(); }
  });
}

test('remembered limit: starting at what the site accepted last time means no refusals at all', async () => {
  const file = videoBytes(16 * MB);
  const srv = await serve(file, { maxConns: 3 });
  try {
    const out = tmpFile();
    const r = await fastGet(srv.base + '/v.mp4', out, { connections: 16, learnedLimit: 3 });
    assert.equal(srv.stats.refused, 0);
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.ok(r.connections <= 3);
  } finally { srv.server.close(); }
});

test('a site allowing only 1 connection: still done in pieces, nothing lost', async () => {
  const file = videoBytes(14 * MB + 333);
  const srv = await serve(file, { maxConns: 1, throttle: 256 * 1024 });
  try {
    const out = tmpFile();
    const r = await fastGet(srv.base + '/v.mp4', out, { connections: 8 });
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.equal(r.limit, 1);
    assert.equal(r.split, true);
  } finally { srv.server.close(); }
});

test('a site that starts every request fast then slows it: pieces on ONE connection beat one long request', async () => {
  const file = videoBytes(16 * MB);
  const srv = await serve(file, { burst: { bytes: 3 * MB, slow: 32 * 1024 }, maxConns: 1 });
  try {
    const a = tmpFile();
    const [, pieces] = await timed(() => fastGet(srv.base + '/v.mp4', a, { connections: 1 }));
    assert.equal(sha(fs.readFileSync(a)), sha(file));
    // One long request (the old way): the slow-down kicks in after the first 3 MB.
    const b = tmpFile();
    const t = Date.now();
    const res = await fetch(srv.base + '/v.mp4');
    fs.writeFileSync(b, Buffer.from(await res.arrayBuffer()));
    const plain = Date.now() - t;
    assert.ok(pieces * 2 < plain, `pieces ${pieces} ms vs one long request ${plain} ms`);
  } finally { srv.server.close(); }
});

test('two servers with the same file: both used at once, about twice as fast, file right', async () => {
  const file = videoBytes(24 * MB);
  const a = await serve(file, { throttle: 48 * 1024, maxConns: 2 });
  const b = await serve(file, { throttle: 48 * 1024, maxConns: 2 });
  try {
    const one = tmpFile();
    const [, single] = await timed(() => fastGet(a.base + '/v.mp4', one, { connections: 8 }));
    resetPools();
    const logs = [];
    const out = tmpFile();
    const [r, both] = await timed(() => fastGet(a.base + '/v.mp4', out, { connections: 8, mirrors: [b.base + '/v.mp4'], log: (m) => logs.push(m) }));
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.equal(r.servers.length, 2, JSON.stringify(r.servers) + logs.join('\n'));
    assert.ok(logs.some((l) => /same file: using both/.test(l)));
    assert.ok(both * 1.4 < single, `two servers ${both} ms vs one ${single} ms`);
  } finally { a.server.close(); b.server.close(); }
});

test('other servers with a different file (other size, or same size but different inside) are not used', async () => {
  const file = videoBytes(12 * MB);
  const other = Buffer.from(file); other[6 * MB] ^= 0xff; other[6 * MB + 1] ^= 0xff; // same size and start, different middle
  const srv = await serve(file);
  const big = await serve(videoBytes(13 * MB));
  const sneaky = await serve(other);
  const dead = 'http://127.0.0.1:1/v.mp4';
  try {
    const logs = [];
    const out = tmpFile();
    const r = await fastGet(srv.base + '/v.mp4', out, { connections: 4, mirrors: [big.base + '/v.mp4', sneaky.base + '/v.mp4', dead], log: (m) => logs.push(m) });
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.equal(r.servers.length, 1);
    assert.equal(logs.filter((l) => /different file: not used|didn't answer properly/.test(l)).length, 3, logs.join('\n'));
  } finally { srv.server.close(); big.server.close(); sneaky.server.close(); }
});

test('a backup server that dies halfway: the main one finishes the job', async () => {
  const file = videoBytes(20 * MB);
  const a = await serve(file, { throttle: 64 * 1024 });
  const b = await serve(file, { throttle: 64 * 1024, expireAfter: 2, tokens: true });
  try {
    const out = tmpFile();
    const r = await fastGet(a.base + '/v.mp4', out, { connections: 4, mirrors: [b.base + '/v.mp4?t=a'] });
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.ok(r.servers.length >= 1);
  } finally { a.server.close(); b.server.close(); }
});

test('the link expires partway: a fresh one is fetched and it carries on (no starting over)', async () => {
  const file = videoBytes(24 * MB);
  const srv = await serve(file, { tokens: true, expireAfter: 2, throttle: 128 * 1024 });
  try {
    let asked = 0;
    const logs = [];
    const out = tmpFile();
    const r = await fastGet(srv.base + '/v.mp4?t=a', out, {
      connections: 4, log: (m) => logs.push(m),
      refresh: async () => { asked++; return srv.base + '/v.mp4?t=b'; }
    });
    assert.equal(asked, 1);
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.ok(logs.some((l) => /fresh link: carrying on/.test(l)), logs.join('\n'));
    assert.ok(srv.stats.bytes < file.length * 1.4, 'didn\'t download it all again: ' + srv.stats.bytes);
    assert.equal(r.limit === null || r.limit >= 2, true, 'the expiry wasn\'t taken for "too many connections": ' + r.limit);
  } finally { srv.server.close(); }
});

test('the link expires and no fresh one is possible: stops, keeps what\'s done, and carries on later with a new link', async () => {
  const file = videoBytes(24 * MB);
  const srv = await serve(file, { tokens: true, expireAfter: 3 });
  try {
    const out = tmpFile();
    await assert.rejects(fastGet(srv.base + '/v.mp4?t=a', out, { connections: 2 }), (e) => e.expired && e.status === 403);
    assert.ok(fs.existsSync(out) && fs.existsSync(stateFile(out)), 'kept for later');
    srv.stats.bytes = 0;
    const r = await fastGet(srv.base + '/v.mp4?t=b', out, { connections: 4 });
    assert.ok(r.resumedFrom > 0);
    assert.ok(srv.stats.bytes < file.length, 'second time only the rest: ' + srv.stats.bytes);
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.ok(!fs.existsSync(stateFile(out)), 'note removed when finished');
  } finally { srv.server.close(); }
});

test('pause keeps what\'s done; resume (even with a new link) carries on; a changed file starts over properly', async () => {
  const file = videoBytes(30 * MB);
  const srv = await serve(file, { throttle: 64 * 1024 });
  try {
    const out = tmpFile();
    const ctl = new AbortController();
    let seen = 0;
    const p = fastGet(srv.base + '/v.mp4', out, { connections: 4, keepOnStop: true, signal: ctl.signal, onProgress: (x) => { seen = x.downloaded; if (x.downloaded > 20 * MB) ctl.abort(); } });
    await assert.rejects(p, (e) => e.aborted);
    assert.ok(seen > 20 * MB);
    assert.ok(fs.existsSync(stateFile(out)));
    srv.stats.bytes = 0;
    const r = await fastGet(srv.base + '/v.mp4', out, { connections: 4, keepOnStop: true });
    assert.ok(r.resumedFrom >= 4 * MB, 'carried on from ' + r.resumedFrom);
    assert.ok(srv.stats.bytes < 27 * MB, 'only fetched the rest: ' + srv.stats.bytes);
    assert.equal(sha(fs.readFileSync(out)), sha(file));

    // A half-done download, but the site now has a different file at that size: never mixed up.
    const ctl2 = new AbortController();
    await assert.rejects(fastGet(srv.base + '/v.mp4', out, { connections: 4, keepOnStop: true, signal: ctl2.signal, onProgress: (x) => { if (x.downloaded > 8 * MB) ctl2.abort(); } }));
    const changed = videoBytes(30 * MB, 7);
    const srv2 = await serve(changed);
    const r2 = await fastGet(srv2.base + '/v.mp4', out, { connections: 4 });
    srv2.server.close();
    assert.equal(r2.resumedFrom, 0);
    assert.equal(sha(fs.readFileSync(out)), sha(changed));
  } finally { srv.server.close(); }
});

test('a piece that hangs forever is asked for again', async () => {
  const file = videoBytes(16 * MB);
  const srv = await serve(file, { stallOnce: 5 * MB });
  try {
    const out = tmpFile();
    await fastGet(srv.base + '/v.mp4', out, { connections: 4, stallMs: 1500 });
    assert.equal(srv.stats.stalls, 1);
    assert.equal(sha(fs.readFileSync(out)), sha(file));
  } finally { srv.server.close(); }
});

test('several downloads from the same server share its limit (3 at once on a 3-connection site)', async () => {
  const files = [videoBytes(12 * MB, 1), videoBytes(12 * MB, 2), videoBytes(12 * MB, 3)];
  // One server, three files (by address).
  const http = require('http');
  const servers = await Promise.all(files.map((f) => serve(f, { maxConns: 3, throttle: 128 * 1024 })));
  // Put all three behind one address so they really share a server.
  const shared = { open: 0, peak: 0, refused: 0 };
  const proxy = http.createServer((req, res) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('f'));
    if (req.headers.range && shared.open >= 3) { shared.refused++; res.writeHead(503); return res.end(); }
    shared.open++; shared.peak = Math.max(shared.peak, shared.open);
    let closed = false;
    const done = () => { if (!closed) { closed = true; shared.open--; } };
    res.on('close', done);
    http.get(servers[n].base + '/v.mp4', { headers: { range: req.headers.range || '' } }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); up.on('end', done); });
  });
  await new Promise((r) => proxy.listen(0, r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const outs = files.map(() => tmpFile());
    await Promise.all(files.map((f, i) => fastGet(`${base}/v.mp4?f=${i}`, outs[i], { connections: 8 })));
    files.forEach((f, i) => assert.equal(sha(fs.readFileSync(outs[i])), sha(f), 'file ' + i));
    assert.ok(shared.refused <= 15, 'turned away only a few times overall: ' + shared.refused);
  } finally { proxy.close(); servers.forEach((s) => s.server.close()); }
});

test('the server says "busy / slow down" to every piece for minutes: stops for now, keeps nothing broken', async () => {
  const file = videoBytes(12 * MB);
  const srv = await serve(file, { onlyFirstPart: 429 });
  try {
    const out = tmpFile();
    const t = Date.now();
    await assert.rejects(fastGet(srv.base + '/v.mp4', out, { connections: 4, busyMaxMs: 3000 }), (e) => e.busy);
    assert.ok(Date.now() - t >= 3000, 'waited it out first');
  } finally { srv.server.close(); }
});

test('the server is busy for a while, even for the very first request: waits and then downloads, no error', async () => {
  const file = videoBytes(12 * MB);
  const srv = await serve(file, { busyFor: 2500 });
  try {
    const out = tmpFile();
    const logs = [];
    await fastGet(srv.base + '/v.mp4', out, { connections: 4, log: (m) => logs.push(m) });
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.ok(logs.some((l) => /is busy \(HTTP 503\): waiting/.test(l)), logs.join('\n'));
  } finally { srv.server.close(); }
});

test('a 2-connection server and 3 downloads starting at once (like a channel): all finish, nothing refused at the start fails', async () => {
  const files = [videoBytes(10 * MB, 1), videoBytes(10 * MB, 2), videoBytes(10 * MB, 3)];
  const http = require('http');
  const servers = await Promise.all(files.map((f) => serve(f, { throttle: 128 * 1024 })));
  // One address in front of all three (one shared limit of 2, like the real video server), 503 above that, first requests included.
  const shared = { open: 0, refused: 0, peak: 0 };
  const proxy = http.createServer((req, res) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('f'));
    if (shared.open >= 2) { shared.refused++; res.writeHead(503); return res.end(); }
    shared.open++; shared.peak = Math.max(shared.peak, shared.open);
    let closed = false;
    const done = () => { if (!closed) { closed = true; shared.open--; } };
    res.on('close', done);
    http.get(servers[n].base + '/v.mp4', { headers: req.headers.range ? { range: req.headers.range } : {} }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); up.on('end', done); });
  });
  await new Promise((r) => proxy.listen(0, r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const outs = files.map(() => tmpFile());
    await Promise.all(files.map((f, i) => fastGet(`${base}/v.mp4?f=${i}`, outs[i], { connections: 8 })));
    files.forEach((f, i) => assert.equal(sha(fs.readFileSync(outs[i])), sha(f), 'file ' + i));
    assert.ok(shared.peak <= 2);
  } finally { proxy.close(); servers.forEach((s) => s.server.close()); }
});

test('more connections get tried again after a while (the limit isn\'t stuck low forever)', async () => {
  const file = videoBytes(40 * MB);
  const srv = await serve(file);
  try {
    const r = await fastGet(srv.base + '/v.mp4', tmpFile(), { connections: 6, learnedLimit: 1, rampEvery: 2 });
    assert.ok(r.limit > 1 && r.connections > 1, `went up to ${r.limit} (${r.connections} at once)`);
  } finally { srv.server.close(); }
});

test('a site with lots of server hiccups (half of all pieces get "500 error", one connection): still finishes, file right', async () => {
  const file = videoBytes(48 * MB);
  const srv = await serve(file, { failRate: 0.5 });
  try {
    const out = tmpFile();
    const r = await fastGet(srv.base + '/v.mp4', out, { connections: 1 });
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.equal(r.split, true);
    assert.ok(srv.stats.requests > 16, 'there really were many hiccups: ' + srv.stats.requests + ' requests for 12 pieces');
  } finally { srv.server.close(); }
});

test('server hiccups never count as "too many connections" (the connection count stays up)', async () => {
  const file = videoBytes(24 * MB);
  const srv = await serve(file, { failRate: 0.3, throttle: 256 * 1024 });
  try {
    const r = await fastGet(srv.base + '/v.mp4', tmpFile(), { connections: 4 });
    assert.ok(r.limit === null || r.limit >= 3, 'limit stayed up: ' + r.limit);
  } finally { srv.server.close(); }
});
