'use strict';
const { tmpdir } = require('./helpers/tmp');
// Stress tests for the multi-connection downloader, against a local server that slows down every
// single connection (like the sites that crawl at ~500 KB/s).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fastGet, cookieHeader, isStreamUrl } = require('../src/main/fastget');

const { serve, videoBytes, sha, MB } = require('./helpers/server');
const tmpFile = () => path.join(tmpdir('fg-'), 'out.mp4');

test('throttled site: 4 connections are much faster than 1, and the file is byte-for-byte right', async () => {
  const file = videoBytes(24 * MB);
  const { server, stats, base } = await serve(file, { throttle: 64 * 1024 }); // ~3.2 MB/s per connection
  try {
    const one = tmpFile();
    let t = Date.now();
    await fastGet(base + '/v.mp4', one, { connections: 1 });
    const single = Date.now() - t;
    assert.equal(sha(fs.readFileSync(one)), sha(file));
    const four = tmpFile();
    t = Date.now();
    const r = await fastGet(base + '/v.mp4', four, { connections: 4 });
    const multi = Date.now() - t;
    assert.equal(r.split, true);
    assert.equal(sha(fs.readFileSync(four)), sha(file), 'identical bytes');
    assert.ok(multi * 2.5 < single, `4 connections: ${multi} ms vs 1 connection: ${single} ms`);
    assert.ok(stats.peak >= 4, 'really used several connections at once');
  } finally { server.close(); }
});

test('8 connections, 3 downloads at once, big files: all correct', async () => {
  const files = [videoBytes(40 * MB, 1), videoBytes(33 * MB + 12345, 2), videoBytes(9 * MB + 1, 3)];
  const servers = await Promise.all(files.map((f) => serve(f, { throttle: 256 * 1024 })));
  try {
    const outs = files.map(() => tmpFile());
    await Promise.all(files.map((f, i) => fastGet(servers[i].base + '/v.mp4', outs[i], { connections: 8 })));
    files.forEach((f, i) => assert.equal(sha(fs.readFileSync(outs[i])), sha(f), 'file ' + i));
  } finally { servers.forEach((s) => s.server.close()); }
});

test('sites that refuse split downloads: falls back to one connection, still correct', async () => {
  const file = videoBytes(12 * MB);
  const { server, base } = await serve(file, { noRanges: true });
  try {
    const out = tmpFile();
    const r = await fastGet(base + '/v.mp4', out, { connections: 4 });
    assert.equal(r.split, false);
    assert.equal(sha(fs.readFileSync(out)), sha(file));
  } finally { server.close(); }
});

test('flaky site (1 in 5 parts fails): retries the parts, file still correct', async () => {
  const file = videoBytes(30 * MB);
  const { server, base } = await serve(file, { failRate: 0.2 });
  try {
    const out = tmpFile();
    const r = await fastGet(base + '/v.mp4', out, { connections: 6 });
    assert.equal(r.split, true);
    assert.equal(sha(fs.readFileSync(out)), sha(file));
  } finally { server.close(); }
});

test('cookies, referer and browser identity go with every request; redirects to a CDN work', async () => {
  const file = videoBytes(10 * MB);
  const { server, stats, base } = await serve(file, { needHeaders: true, redirect: true });
  try {
    const out = tmpFile();
    const cookies = '# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\tpass\tok\n.other.example\tTRUE\t/\tFALSE\t0\tsecret\tno\n';
    const headers = { Referer: base + '/video/1', 'User-Agent': 'Mozilla/5.0 Test', Cookie: cookieHeader(cookies, base + '/v.mp4') };
    assert.equal(headers.Cookie, 'pass=ok', 'only this site\'s cookies');
    await fastGet(base + '/v.mp4', out, { connections: 4, headers });
    assert.equal(sha(fs.readFileSync(out)), sha(file));
    assert.ok(stats.seenHeaders.every((h) => h.cookie === 'pass=ok' && h.referer && h.ua === 'Mozilla/5.0 Test'));
  } finally { server.close(); }
});

test('a web page instead of the video: refused, nothing left behind', async () => {
  const { server, base } = await serve(Buffer.alloc(0), { html: true });
  try {
    const out = tmpFile();
    await assert.rejects(fastGet(base + '/v.mp4', out, { connections: 4 }), (e) => e.notVideo === true);
    assert.ok(!fs.existsSync(out));
  } finally { server.close(); }
});

test('pause/cancel mid-download stops straight away and cleans up', async () => {
  const file = videoBytes(40 * MB);
  const { server, stats, base } = await serve(file, { throttle: 32 * 1024 });
  try {
    const out = tmpFile();
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 400);
    const t = Date.now();
    await assert.rejects(fastGet(base + '/v.mp4', out, { connections: 4, signal: ctl.signal }), (e) => e.aborted === true);
    assert.ok(Date.now() - t < 2000, 'stopped quickly');
    assert.ok(!fs.existsSync(out), 'partial file removed');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(stats.open, 0, 'no connections left open');
  } finally { server.close(); }
});

test('progress reports add up and end at the full size', async () => {
  const file = videoBytes(16 * MB);
  const { server, base } = await serve(file, { throttle: 96 * 1024 });
  try {
    const seen = [];
    await fastGet(base + '/v.mp4', tmpFile(), { connections: 4, onProgress: (p) => seen.push(p) });
    assert.ok(seen.length >= 2, 'reported along the way: ' + seen.length);
    assert.equal(seen[seen.length - 1].downloaded, file.length);
    const bad = seen.filter((p) => !(p.downloaded <= file.length && p.total === file.length));
    assert.deepEqual(bad, [], 'every report within the file size');
  } finally { server.close(); }
});

test('stream lists are left to the engine', () => {
  assert.ok(isStreamUrl('https://x/master.m3u8?t=1'));
  assert.ok(isStreamUrl('https://x/manifest.mpd'));
  assert.ok(!isStreamUrl('https://x/video_720p.mp4'));
});


test('site answers the first part but refuses the rest: switches to one connection, still correct', async () => {
  const file = videoBytes(20 * MB);
  const { server, stats, base } = await serve(file, { onlyFirstPart: true });
  try {
    const out = tmpFile();
    const r = await fastGet(base + '/v.mp4', out, { connections: 4 });
    assert.equal(r.split, false);
    assert.ok(stats.refused >= 1);
    assert.equal(sha(fs.readFileSync(out)), sha(file));
  } finally { server.close(); }
});
