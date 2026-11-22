'use strict';
// The Trim player's private local server: seeking (byte ranges), safety (secret, this PC only,
// only chosen files), and that it never gets stuck when the player cancels lots of requests.
const { tmpdir } = require('./helpers/tmp');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { startMediaServer } = require('../src/main/mediaserver');

const dir = tmpdir('media-');
const file = path.join(dir, 'Clip & Co #1.mp4');
const data = crypto.randomBytes(5 * 1024 * 1024 + 123);
fs.writeFileSync(file, data);
const other = path.join(dir, 'secret.txt');
fs.writeFileSync(other, 'private');

const get = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});

test('serves the whole file, any byte range, the last N bytes; refuses impossible ranges', async () => {
  const s = await startMediaServer({ allowed: (p) => p === file });
  try {
    const all = await get(s.url(file));
    assert.equal(all.status, 200);
    assert.ok(all.body.equals(data));
    assert.equal(all.headers['accept-ranges'], 'bytes');
    assert.equal(all.headers['content-type'], 'video/mp4');
    const mid = await get(s.url(file), { Range: 'bytes=1000000-1999999' });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers['content-range'], `bytes 1000000-1999999/${data.length}`);
    assert.ok(mid.body.equals(data.subarray(1000000, 2000000)));
    const open = await get(s.url(file), { Range: 'bytes=5000000-' });
    assert.ok(open.body.equals(data.subarray(5000000)));
    const tail = await get(s.url(file), { Range: 'bytes=-500' });
    assert.ok(tail.body.equals(data.subarray(data.length - 500)));
    const past = await get(s.url(file), { Range: `bytes=${data.length + 10}-` });
    assert.equal(past.status, 416);
    const head = await get(s.url(file), {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers['content-length']), data.length);
    // A different "reload" number is a different address for the same file.
    assert.notEqual(s.url(file, 1), s.url(file, 2));
    assert.ok((await get(s.url(file, 7), { Range: 'bytes=0-9' })).body.equals(data.subarray(0, 10)));
  } finally { await s.close(); }
});

test('safety: wrong secret, files not chosen, other names for the server, and other methods are all refused', async () => {
  const s = await startMediaServer({ allowed: (p) => p === file });
  try {
    const good = s.url(file);
    assert.equal((await get(good.replace(s.token, 'x'.repeat(48)))).status, 403);
    assert.equal((await get(s.url(other))).status, 403);
    assert.equal((await get(s.url('/etc/passwd'))).status, 403);
    assert.equal((await get(good, { Host: 'evil.example:' + s.port })).status, 403, 'a web page using a trick name for this PC is refused');
    assert.equal((await get(good, {}, 'POST')).status, 405);
    const bound = new URL(good);
    assert.equal(bound.hostname, '127.0.0.1');
  } finally { await s.close(); }
});

test('the player cancelling hundreds of requests mid-way (jumping around): nothing gets stuck, files get closed', async () => {
  const s = await startMediaServer({ allowed: (p) => p === file });
  try {
    const u = new URL(s.url(file));
    for (let round = 0; round < 10; round++) {
      await Promise.all(Array.from({ length: 30 }, (_, i) => new Promise((resolve) => {
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Range: `bytes=${(i * 97331) % data.length}-` } }, (res) => {
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', () => resolve());
        req.end();
      })));
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.openRequests(), 0, 'all canceled requests cleaned up');
    // And it still answers normally afterwards.
    const after = await get(s.url(file), { Range: 'bytes=4000000-4000099' });
    assert.ok(after.body.equals(data.subarray(4000000, 4000100)));
  } finally { await s.close(); }
});

test('a file that disappears while being played: an error answer, no crash', async () => {
  const gone = path.join(dir, 'gone.mp4');
  fs.writeFileSync(gone, data);
  const s = await startMediaServer({ allowed: () => true });
  try {
    fs.unlinkSync(gone);
    assert.equal((await get(s.url(gone))).status, 404);
  } finally { await s.close(); }
});
