'use strict';
const { tmpdir } = require('./helpers/tmp');
// Convert & Trim against real files, with the real ffmpeg: every format, trims (exact and fast),
// odd files, names, never overwriting, cancel, waveform and preview copies.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('../src/main/convert');

const FFMPEG = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const FFPROBE = ['/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((p) => fs.existsSync(p));
const skip = !(FFMPEG && FFPROBE) && 'no ffmpeg here';
const engine = { ffmpeg: FFMPEG, ffprobe: FFPROBE };

const dir = tmpdir('conv-');
const ff = (...a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const streams = (f) => execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', f]).toString().trim().split(/[\s,]+/).filter(Boolean);
const dur = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const bitrate = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0', f]).toString()) || Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'csv=p=0', f]).toString());
// The picture's first frame number shows where a cut really starts (the test clip counts frames).
const firstFrameTime = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', f]).toString().trim().split(/\s+/)[0]);

const F = {};
test.before(() => {
  if (skip) return;
  // 20 s video + sound, a keyframe only every 5 s (so a fast cut visibly snaps).
  F.mp4 = path.join(dir, 'clip.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc2=duration=20:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '125', '-keyint_min', '125', '-sc_threshold', '0', '-c:a', 'aac', '-shortest', F.mp4);
  F.mkv = path.join(dir, 'picture only.mkv');
  ff('-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x240:rate=25', '-c:v', 'libx264', '-preset', 'ultrafast', F.mkv);
  F.wav = path.join(dir, 'sound only.wav');
  ff('-f', 'lavfi', '-i', 'sine=frequency=300:duration=12', '-f', 'lavfi', '-i', 'anoisesrc=d=12:a=0.02', '-filter_complex', 'amix=inputs=2', F.wav);
  F.webm = path.join(dir, 'vp9 clip.webm');
  ff('-f', 'lavfi', '-i', 'testsrc2=duration=5:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=5', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', F.webm);
  // An MP3 with cover art: the cover is not "a picture" to convert.
  const cover = path.join(dir, 'cover.png');
  ff('-f', 'lavfi', '-i', 'color=c=red:s=200x200', '-frames:v', '1', cover);
  F.mp3cover = path.join(dir, 'song with cover.mp3');
  ff('-f', 'lavfi', '-i', 'sine=duration=8', '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'png', '-disposition:v', 'attached_pic', F.mp3cover);
  F.broken = path.join(dir, 'broken.mp4');
  // Fixed junk (the same every run; random bytes now and then look like a subtitle file to ffmpeg).
  let junk = Buffer.alloc(0), h = Buffer.from('slim');
  while (junk.length < 200000) { h = require('crypto').createHash('sha256').update(h).digest(); junk = Buffer.concat([junk, h]); }
  fs.writeFileSync(F.broken, junk.subarray(0, 200000));
  F.truncated = path.join(dir, 'half downloaded.mp4');
  fs.writeFileSync(F.truncated, fs.readFileSync(F.mp4).subarray(0, 60000));
  F.weird = path.join(dir, "Tëst & 'clip' #1 (final) 日本.mp4");
  fs.copyFileSync(F.mp4, F.weird);
  F.text = path.join(dir, 'notes.mp4');
  fs.writeFileSync(F.text, '<!doctype html><html>not a video</html>');
});

const conv = async (file, job, extra = {}) => {
  const info = await C.probe(FFPROBE, file);
  return C.convertFile(info, job, { ...engine, ...extra });
};

test('reading files: picture/sound found correctly (cover art isn\'t "picture"); junk and damaged files refused clearly', { skip }, async () => {
  const a = await C.probe(FFPROBE, F.mp4);
  assert.ok(a.hasVideo && a.hasAudio && Math.abs(a.duration - 20) < 0.2 && a.width === 640);
  const b = await C.probe(FFPROBE, F.mkv);
  assert.ok(b.hasVideo && !b.hasAudio);
  const c = await C.probe(FFPROBE, F.wav);
  assert.ok(!c.hasVideo && c.hasAudio);
  const d = await C.probe(FFPROBE, F.mp3cover);
  assert.ok(!d.hasVideo && d.hasAudio, 'cover art is not a video');
  for (const bad of [F.broken, F.text]) await assert.rejects(C.probe(FFPROBE, bad), (e) => e.unreadable && /can't read this file|no picture or sound/.test(e.message));
  await assert.rejects(C.probe(FFPROBE, path.join(dir, 'nope.mp4')), (e) => e.missing);
  await assert.rejects(C.probe(FFPROBE, dir), /folder, not a file/);
});

for (const fmt of C.VIDEO_FORMATS) {
  test(`video -> ${fmt.toUpperCase()}: plays, has picture and sound, full length, original untouched`, { skip }, async () => {
    const before = fs.readFileSync(F.mp4);
    const r = await conv(F.mp4, { format: fmt, outDir: path.join(dir, 'out-' + fmt) });
    assert.ok(r.out.endsWith('.' + fmt));
    const s = streams(r.out);
    assert.ok(s.includes('video') && s.includes('audio'), s.join(','));
    assert.ok(Math.abs(dur(r.out) - 20) < 0.5, 'length ' + dur(r.out));
    assert.ok(before.equals(fs.readFileSync(F.mp4)), 'original not changed');
    if (fmt !== 'webm') assert.equal(r.mode, 'copy', 'H.264 + AAC repackage into ' + fmt + ' without re-encoding');
    else assert.equal(r.mode, 'encode', 'WebM needs VP9/Opus, so it\'s converted');
  });
}

test('VP9/Opus WebM -> MP4 and MOV: repackaged or converted, both play', { skip }, async () => {
  for (const fmt of ['mp4', 'mov', 'mkv']) {
    const r = await conv(F.webm, { format: fmt, outDir: path.join(dir, 'webm-' + fmt) });
    const s = streams(r.out);
    assert.ok(s.includes('video') && s.includes('audio'));
    assert.ok(Math.abs(dur(r.out) - 5) < 0.5);
  }
});

for (const fmt of C.AUDIO_FORMATS) {
  test(`sound out to ${fmt.toUpperCase()}: sound only, full length`, { skip }, async () => {
    const r = await conv(F.mp4, { format: fmt, quality: 'high', outDir: path.join(dir, 'aud-' + fmt) });
    assert.deepEqual(streams(r.out).filter((x) => x === 'video'), [], 'no picture');
    assert.ok(streams(r.out).includes('audio'));
    assert.ok(Math.abs(dur(r.out) - 20) < 0.5, fmt + ' length ' + dur(r.out));
  });
}

test('MP3 quality: High / Medium / Small really differ (320 / 192 / 128 kbps)', { skip }, async () => {
  const rates = {};
  for (const q of ['high', 'medium', 'small']) {
    const r = await conv(F.wav, { format: 'mp3', quality: q, outDir: path.join(dir, 'q-' + q) });
    rates[q] = bitrate(r.out);
  }
  assert.ok(Math.abs(rates.high - 320000) < 20000 && Math.abs(rates.medium - 192000) < 15000 && Math.abs(rates.small - 128000) < 10000, JSON.stringify(rates));
});

test('no sound -> MP3 refused with a plain reason; no picture -> MP4 refused; cover-art MP3 -> MP4 refused', { skip }, async () => {
  await assert.rejects(conv(F.mkv, { format: 'mp3' }), /has no sound/);
  await assert.rejects(conv(F.wav, { format: 'mp4' }), /has no picture/);
  await assert.rejects(conv(F.mp3cover, { format: 'mkv' }), /has no picture/);
  const ok = await conv(F.mp3cover, { format: 'm4a', outDir: path.join(dir, 'coverout') });
  assert.ok(streams(ok.out).includes('audio'));
});

test('exact trim (video): starts and ends where asked (within a frame or two)', { skip }, async () => {
  const r = await conv(F.mp4, { format: 'mp4', trim: { start: 7.3, end: 12.8 }, outDir: path.join(dir, 'exact') });
  assert.match(path.basename(r.out), /^clip \(0m07s-0m13s\)\.mp4$/);
  assert.ok(Math.abs(dur(r.out) - 5.5) < 0.12, 'length ' + dur(r.out));
  assert.equal(r.mode, 'encode');
  assert.ok(streams(r.out).includes('audio'));
});

test('fast trim (video): no re-encode, snaps back to a keyframe (here up to 5 s early), never late', { skip }, async () => {
  const r = await conv(F.mp4, { format: 'mp4', trim: { start: 7.3, end: 12.8, fast: true }, outDir: path.join(dir, 'fast') });
  assert.equal(r.mode, 'copy');
  const d = dur(r.out);
  assert.ok(d >= 5.4 && d <= 11, 'fast cut keeps at least the selection: ' + d);
});

test('audio trim is exact even when "fast" is asked for; and trimmed straight to MP3 from a video', { skip }, async () => {
  const r = await conv(F.wav, { format: 'wav', trim: { start: 2.25, end: 9.75, fast: true }, outDir: path.join(dir, 'atrim') });
  assert.ok(Math.abs(dur(r.out) - 7.5) < 0.02, 'length ' + dur(r.out));
  const m = await conv(F.mp4, { format: 'mp3', trim: { start: 3, end: 8 }, outDir: path.join(dir, 'vtrim-mp3') });
  assert.ok(Math.abs(dur(m.out) - 5) < 0.1, 'mp3 clip ' + dur(m.out));
  assert.ok(!streams(m.out).includes('video') && streams(m.out).includes('mp3'));
});

test('bad cuts refused with plain reasons; a "cut" of the whole file is just a conversion', { skip }, async () => {
  await assert.rejects(conv(F.mp4, { format: 'mp4', trim: { start: 9, end: 4 } }), /end of the cut has to be after the start/);
  await assert.rejects(conv(F.mp4, { format: 'mp4', trim: { start: 5, end: 5.05 } }), /too short/);
  await assert.rejects(conv(F.mp4, { format: 'mp4', trim: { start: 50, end: 60 } }), /past the end|after the start/);
  const r = await conv(F.mp4, { format: 'mkv', trim: { start: 0, end: 20 }, outDir: path.join(dir, 'whole') });
  assert.equal(path.basename(r.out), 'clip.mkv', 'no cut times in the name');
});

test('never overwrites: same name gets (1), (2); converting MP4 to MP4 next to itself makes "clip (1).mp4"', { skip }, async () => {
  const out = path.join(dir, 'dupes');
  const a = await conv(F.mp4, { format: 'mp3', outDir: out });
  const b = await conv(F.mp4, { format: 'mp3', outDir: out });
  const c = await conv(F.mp4, { format: 'mp3', outDir: out });
  assert.deepEqual([a, b, c].map((x) => path.basename(x.out)), ['clip.mp3', 'clip (1).mp3', 'clip (2).mp3']);
  const copy = path.join(dir, 'selfcopy');
  fs.mkdirSync(copy);
  const src = path.join(copy, 'clip.mp4');
  fs.copyFileSync(F.mp4, src);
  const before = fs.readFileSync(src);
  const r = await conv(src, { format: 'mp4' });
  assert.equal(path.basename(r.out), 'clip (1).mp4');
  assert.ok(before.equals(fs.readFileSync(src)));
});

test('names with accents, symbols, quotes and other alphabets work', { skip }, async () => {
  const r = await conv(F.weird, { format: 'mp3', trim: { start: 1, end: 3 } });
  assert.equal(path.basename(r.out), "Tëst & 'clip' #1 (final) 日本 (0m01s-0m03s).mp3");
  assert.ok(fs.existsSync(r.out));
});

test('a half-downloaded file fails with a plain message and leaves nothing behind', { skip }, async () => {
  const out = path.join(dir, 'trunc-out');
  fs.mkdirSync(out);
  let info;
  try { info = await C.probe(FFPROBE, F.truncated); } catch (e) { assert.match(e.message, /can't read this file/); return; }
  await assert.rejects(C.convertFile(info, { format: 'mkv', outDir: out }, engine));
  assert.deepEqual(fs.readdirSync(out), [], 'no partial files');
});

test('cancel halfway: stops quickly, no partial or finished file left', { skip }, async () => {
  const big = path.join(dir, 'long.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc2=duration=120:size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=duration=120', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', big);
  const out = path.join(dir, 'cancel-out');
  fs.mkdirSync(out);
  const info = await C.probe(FFPROBE, big);
  const ctl = new AbortController();
  let seen = 0;
  const t = Date.now();
  await assert.rejects(C.convertFile(info, { format: 'webm', outDir: out }, { ...engine, signal: ctl.signal, onProgress: (p) => { seen = p.pct; if (p.pct > 3) ctl.abort(); } }), (e) => e.aborted);
  assert.ok(seen > 3 && seen < 90);
  assert.ok(Date.now() - t < 60000);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(fs.readdirSync(out), [], 'nothing left');
});

test('progress goes up steadily to the end', { skip }, async () => {
  const seen = [];
  await conv(F.mp4, { format: 'webm', outDir: path.join(dir, 'prog') }, { onProgress: (p) => seen.push(p.pct) });
  assert.ok(seen.length >= 2);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1] - 0.01);
  assert.ok(seen[seen.length - 1] > 50);
});

test('saving into a folder that can\'t be used fails clearly', { skip }, async () => {
  const blocker = path.join(dir, 'a-file');
  fs.writeFileSync(blocker, 'x');
  await assert.rejects(conv(F.mp4, { format: 'mp3', outDir: path.join(blocker, 'sub') }), /can't save in that folder/);
});

test('waveform: right number of points, 0 to 1, quiet part shows as quiet', { skip }, async () => {
  const q = path.join(dir, 'loud-quiet-loud.wav');
  ff('-f', 'lavfi', '-i', 'sine=frequency=400:duration=3', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=3', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', q);
  const info = await C.probe(FFPROBE, q);
  const w = await C.waveform(FFMPEG, info, { buckets: 300 });
  assert.equal(w.length, 300);
  assert.ok(w.every((v) => v >= 0 && v <= 1));
  const avg = (a, b) => w.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
  assert.ok(avg(10, 90) > 0.5 && avg(120, 180) < 0.05 && avg(210, 290) > 0.5, [avg(10, 90), avg(120, 180), avg(210, 290)].join(' '));
  assert.equal(await C.waveform(FFMPEG, await C.probe(FFPROBE, F.mkv)), null, 'no sound: no waveform');
});

test('preview copy for files the player can\'t show: small MP4 (or M4A), made once and reused', { skip }, async () => {
  const pv = path.join(dir, 'previews');
  const info = await C.probe(FFPROBE, F.webm);
  const a = await C.previewCopy(FFMPEG, info, pv);
  assert.ok(a.endsWith('.mp4') && streams(a).includes('video'));
  const mtime = fs.statSync(a).mtimeMs;
  const b = await C.previewCopy(FFMPEG, info, pv);
  assert.equal(a, b);
  assert.equal(fs.statSync(b).mtimeMs, mtime, 'reused, not made again');
  const au = await C.previewCopy(FFMPEG, await C.probe(FFPROBE, F.wav), pv);
  assert.ok(au.endsWith('.m4a'));
});

test('the converter list: one at a time, in order; cancel a waiting one; only chosen files may be opened', { skip }, async () => {
  const pv = path.join(dir, 'conv-previews');
  const cv = new C.Converter({ engine, previewDir: pv });
  const added = await cv.addFiles([F.mp4, F.wav, F.broken, path.join(dir, 'missing.mp4')]);
  assert.deepEqual(added.map((x) => x.ok), [true, true, false, false]);
  assert.match(added[2].error, /can't read this file|no picture or sound/);
  const out = path.join(dir, 'list-out');
  fs.mkdirSync(out);
  const events = [];
  cv.on('job', (j) => events.push([j.id, j.status]));
  const made = cv.start([
    { path: F.mp4, format: 'webm', outDir: out },
    { path: F.wav, format: 'mp3', outDir: out },
    { path: F.wav, format: 'flac', outDir: out },
    { path: path.join(dir, 'never-added.mp4'), format: 'mp3' },
    { path: F.wav, format: 'mp4' }
  ]);
  assert.deepEqual(made.map((m) => m.ok), [true, true, true, false, false]);
  assert.match(made[4].error, /has no picture/);
  assert.ok(cv.cancel(made[2].id), 'a waiting one can be canceled');
  await new Promise((resolve) => { const t = setInterval(() => { if (cv.list().every((j) => !['waiting', 'converting'].includes(j.status))) { clearInterval(t); resolve(); } }, 100); });
  const l = cv.list();
  assert.deepEqual(l.map((j) => j.status), ['done', 'done', 'canceled']);
  // Never two at once.
  const now = new Set();
  let most = 0;
  for (const [id, s] of events) { if (s === 'converting') now.add(id); else now.delete(id); most = Math.max(most, now.size); }
  assert.equal(most, 1);
  assert.ok(cv.allowed(F.mp4) && cv.allowed(l[0].out), 'chosen files and results may be played');
  assert.ok(!cv.allowed(path.join(os.homedir(), '.bashrc')) && !cv.allowed('/etc/passwd'), 'nothing else');
  assert.equal(cv.clearFinished().length, 0);
});

test('ffmpeg arguments: trims put the start before the input (fast seeking) and keep only main picture + sound', () => {
  const info = { path: '/x/in.mkv', hasVideo: true, hasAudio: true, duration: 100 };
  const a = C.ffmpegArgs(info, C.checkJob(info, { format: 'mp4', trim: { start: 10, end: 20 } }), '/x/out.mp4.partial', 'encode');
  assert.ok(a.indexOf('-ss') < a.indexOf('-i') && a[a.indexOf('-t') + 1] === '10.000');
  assert.ok(a.includes('libx264') && a.includes('+faststart') && a[a.length - 2] === 'mp4');
  const b = C.ffmpegArgs(info, C.checkJob(info, { format: 'mkv' }), '/x/o', 'copy');
  assert.ok(b.includes('copy') && !b.includes('-ss') && b.includes('0:v:0'));
  const c = C.ffmpegArgs(info, C.checkJob(info, { format: 'opus', quality: 'small' }), '/x/o', 'encode');
  assert.ok(c.includes('libopus') && c[c.indexOf('-b:a') + 1] === '96k' && c.includes('-vn'));
  assert.equal(C.stamp(3725.4), '1h02m05s');
  assert.equal(C.stamp(65), '1m05s');
});
