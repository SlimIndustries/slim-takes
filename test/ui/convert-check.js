// Convert & Trim in the real window code, in a real browser, with real video and audio files:
// sidebar order, adding files (picker and drag-and-drop), formats and quality, converting, the trim
// screen for a video (preview, handles, typed times, Set start/end, looping the selection, Exact/Fast) and
// an audio file (waveform), the preview copy for files the player can't show, and that copying or
// pasting a link never starts anything by itself.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http'); const assert = require('assert');
const { execFileSync } = require('child_process');
const APP = path.resolve(__dirname, '../..');
const SHOTS = path.join(APP, 'test/ui/shots');
const FF = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvui-'));
  const ff = (...a) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
  ff('-f', 'lavfi', '-i', 'testsrc2=duration=20:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(dir, 'Jimmy Cuts Grass.mp4'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=30', path.join(dir, 'Lo-fi Beats To Mow To.wav'));
  fs.writeFileSync(path.join(dir, 'Old Camcorder Tape.avi'), Buffer.alloc(50000, 7)); // the player can't show this one
  fs.copyFileSync(path.join(dir, 'Jimmy Cuts Grass.mp4'), path.join(dir, 'preview.mp4'));

  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('p') || '');
    const f = path.join(dir, path.basename(p));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(f).size;
    const type = f.endsWith('.wav') ? 'audio/wav' : f.endsWith('.avi') ? 'video/x-msvideo' : 'video/mp4';
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const a = Number(m[1]), b = m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(f, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const info = (name, extra) => ({ ok: true, info: { path: '/media/' + name, name, size: fs.statSync(path.join(dir, name)).size, ...extra } });
  const vid = info('Jimmy Cuts Grass.mp4', { duration: 20, hasVideo: true, hasAudio: true, height: 360 });
  const aud = info('Lo-fi Beats To Mow To.wav', { duration: 30, hasVideo: false, hasAudio: true });
  const avi = info('Old Camcorder Tape.avi', { duration: 20, hasVideo: true, hasAudio: true, height: 360 });

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, bypassCSP: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ content: fs.readFileSync(APP + '/test/ui/mock-api.js', 'utf8') });
  await p.addInitScript({ content: `window._cv = { pick: ${JSON.stringify([vid, aud, avi, { ok: false, path: '/media/notes.mp4', name: 'notes.mp4', error: "Slim Takes can't read this file." }])}, byPath: { '/drop/Dropped Clip.mp4': ${JSON.stringify({ ok: true, info: { ...vid.info, path: '/media/Jimmy Cuts Grass.mp4', name: 'Dropped Clip.mp4' } })} }, previewPath: '/media/preview.mp4' };` });
  const { startMediaServer } = require(APP + '/src/main/mediaserver');
  const ms = await startMediaServer({ allowed: () => true });
  await p.exposeFunction('cvMediaUrl', (file, n) => ms.url(path.join(dir, path.basename(file)), n));
  await p.goto('file://' + APP + '/src/renderer/index.html');
  await p.waitForTimeout(400);
  await p.evaluate((port) => { window.fileUrl = (x) => `http://127.0.0.1:${port}/f?p=` + encodeURIComponent(x); fileUrl = window.fileUrl; }, port);

  // 1. Sidebar: Convert & Trim under Channel Watch, after a divider.
  const nav = await p.$$eval('nav.side > button.navbtn, nav.side > .navsep', (els) => els.map((e) => (e.classList.contains('navsep') ? '---' : e.textContent.replace(/\d+$/, '').trim())));
  assert.deepEqual(nav, ['Downloads', 'Channel grab', 'Channel Watch', '---', 'Convert & Trim', 'History', 'Settings'], nav.join(' | '));

  // 2. Copying or pasting a link starts nothing until Add / Enter.
  await p.fill('#paste', 'https://www.youtube.com/@SomeChannel');
  await p.waitForTimeout(600);
  assert.equal(await p.evaluate(() => document.querySelectorAll('.banner').length), 0, 'no "copied link" pop-up');
  assert.equal(await p.evaluate(() => (location.hash || '') + document.querySelector('.navbtn.on').dataset.view), 'downloads', 'still on Downloads, nothing started');

  // 3. Convert & Trim: empty, then Choose files.
  await p.click('.navbtn[data-view="convert"]');
  await p.waitForTimeout(150);
  assert.ok(await p.isVisible('text=Drop video or audio files here'));
  assert.ok(await p.isVisible('text=No files yet'));
  await p.click('button:text-is("Choose files…")');
  await p.waitForTimeout(200);
  assert.equal(await p.$$eval('.cv-item', (x) => x.length), 3);
  assert.ok(await p.isVisible("text=notes.mp4: Slim Takes can't read this file."), 'the unreadable one is explained');

  // 4. Formats: MP3 shows quality; FLAC doesn't; MP4 can't take the sound-only file.
  const fmtSel = 'section[aria-label="Output"] select >> nth=0';
  assert.equal(await p.inputValue(fmtSel), 'mp3');
  assert.ok(await p.isVisible('text=Audio quality'));
  await p.selectOption(fmtSel, 'flac'); await p.waitForTimeout(100);
  assert.ok(!(await p.isVisible('text=Audio quality')), 'FLAC is lossless: no quality to pick');
  await p.selectOption(fmtSel, 'mp4'); await p.waitForTimeout(100);
  assert.ok(await p.isVisible('text=No picture in this file: pick an audio format (like MP3)'));
  assert.equal(await p.textContent('#cv-go'), 'Convert 2 files', 'the sound-only file is left out for MP4');
  await p.selectOption(fmtSel, 'mp3'); await p.waitForTimeout(100);
  await p.selectOption('section[aria-label="Output"] select >> nth=1', 'medium');
  assert.equal(await p.textContent('#cv-go'), 'Convert 3 files');
  await p.screenshot({ path: path.join(SHOTS, '40-convert-list.png') });

  // 5. Trim the video.
  await p.click('.cv-item:has-text("Jimmy Cuts Grass") button:has-text("Trim")');
  await p.waitForSelector('video.cv-video');
  await p.waitForFunction(() => { const v = document.querySelector('video.cv-video'); return v && v.readyState >= 1; }, null, { timeout: 10000 });
  assert.ok(await p.isVisible('text=Jimmy Cuts Grass.mp4 · 0:20 · 360p'));
  assert.equal(await p.inputValue('section[aria-label="Save the clip"] select'), 'mp4', 'a trimmed video stays a video by default (even with MP3 picked above)');
  // Drag the start handle to about a quarter of the way.
  const track = await p.$('.cv-track');
  const box = await track.boundingBox();
  const hs = await p.$('.cv-handle >> nth=0');
  const hb = await hs.boundingBox();
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.25, hb.y + hb.height / 2, { steps: 6 });
  await p.mouse.up();
  const start = await p.inputValue('input[aria-label="Start time"]');
  assert.ok(/^0:0[4-6]\.\d$/.test(start), 'dragged start ≈ 0:05: ' + start);
  // Type the end.
  await p.fill('input[aria-label="End time"]', '0:12.5');
  await p.press('input[aria-label="End time"]', 'Enter');
  await p.waitForTimeout(100);
  assert.equal(await p.inputValue('input[aria-label="End time"]'), '0:12.5');
  assert.ok(await p.isVisible('text=Keeps'));
  // A bad time is refused politely.
  await p.fill('input[aria-label="Start time"]', 'banana');
  await p.press('input[aria-label="Start time"]', 'Enter');
  await p.waitForTimeout(100);
  assert.ok(await p.isVisible('text=Type a time like 2:05 or 1:02:05.5'));
  assert.equal(await p.inputValue('input[aria-label="Start time"]'), start, 'kept the old start');
  // Set start here: seek to 3 s first.
  await p.evaluate(() => { document.querySelector('video.cv-video').currentTime = 3; });
  await p.waitForTimeout(300);
  await p.click('button:text-is("Set start here")');
  assert.equal(await p.inputValue('input[aria-label="Start time"]'), '0:03.0');
  // Play loops the selection (3 s to 4 s) until paused.
  await p.fill('input[aria-label="End time"]', '0:04.0'); await p.press('input[aria-label="End time"]', 'Enter');
  await p.evaluate(() => { document.querySelector('video.cv-video').muted = true; });
  await p.click('.cv-play');
  const loopSeen = await p.evaluate(async () => { const v = document.querySelector('video.cv-video'); const s = []; for (let i = 0; i < 50; i++) { s.push([v.currentTime, v.paused]); await new Promise((r) => setTimeout(r, 60)); } return s; });
  assert.ok(loopSeen.slice(5).every(([, pz]) => !pz), 'kept playing');
  assert.ok(loopSeen.slice(8).every(([x]) => x >= 2.8 && x <= 4.3), 'stayed in the selection: ' + loopSeen.map(([x]) => x.toFixed(1)).join(' '));
  assert.ok(loopSeen.some(([x], i) => i && x < loopSeen[i - 1][0] - 0.5), 'looped back to the start');
  await p.click('.cv-play');
  await p.waitForTimeout(200);
  assert.ok(await p.evaluate(() => document.querySelector('video.cv-video').paused), 'pause pauses');
  await p.fill('input[aria-label="End time"]', '0:12.5'); await p.press('input[aria-label="End time"]', 'Enter');
  // Keyboard: arrow keys move a handle.
  await p.focus('.cv-handle >> nth=1');
  await p.keyboard.press('ArrowRight');
  assert.equal(await p.inputValue('input[aria-label="End time"]'), '0:13.5');
  // Save as MP4: Exact / Fast choice.
  await p.selectOption('section[aria-label="Save the clip"] select', 'mp4'); await p.waitForTimeout(200);
  assert.ok(await p.isVisible('text=Cuts on the exact frame you picked'));
  await p.click('button[role="radio"]:text-is("Fast")'); await p.waitForTimeout(200);
  assert.ok(await p.isVisible('text=may start up to a couple of seconds early'));
  assert.ok(await p.isVisible('text=Saves as Jimmy Cuts Grass (0m03s-0m14s).mp4 next to the original'), await p.textContent('main'));
  assert.equal(await p.inputValue('input[aria-label="Start time"]'), '0:03.0', 'the cut survives switching options');
  await p.screenshot({ path: path.join(SHOTS, '41-trim-video.png') });
  await p.click('button:text-is("Save clip")');
  await p.waitForTimeout(400);
  const sp = await p.evaluate(() => window._cv.started[window._cv.started.length - 1]);
  assert.equal(sp.format, 'mp4');
  assert.ok(Math.abs(sp.trim.start - 3) < 0.01 && Math.abs(sp.trim.end - 13.5) < 0.01 && sp.trim.fast === true, JSON.stringify(sp));
  assert.ok(await p.isVisible('text=Drop video or audio files here'), 'back on the list');
  assert.ok(await p.isVisible('.cv-item:has-text("Jimmy Cuts Grass") >> text=Saved: Jimmy Cuts Grass.mp4'));

  // 6. Trim the audio file: waveform, no Exact/Fast.
  await p.click('.cv-item:has-text("Lo-fi Beats") button:has-text("Trim")');
  await p.waitForSelector('canvas.cv-wave');
  await p.waitForTimeout(500);
  const painted = await p.evaluate(() => { const c = document.querySelector('canvas.cv-wave'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  assert.ok(painted > 1000, 'waveform drawn: ' + painted);
  assert.ok(!(await p.isVisible('button[role="radio"]:text-is("Fast")')), 'no Fast/Exact for audio');
  assert.ok(await p.isVisible('text=Audio cuts are always exact.'));
  assert.equal(await p.inputValue('section[aria-label="Save the clip"] select'), 'mp3', 'audio: the Convert-to choice (MP3)');
  await p.fill('input[aria-label="Start time"]', '12'); await p.press('input[aria-label="Start time"]', 'Enter');
  await p.fill('input[aria-label="End time"]', '19.75'); await p.press('input[aria-label="End time"]', 'Enter');
  assert.equal(await p.inputValue('input[aria-label="Start time"]'), '0:12.0');
  assert.equal(await p.inputValue('input[aria-label="End time"]'), '0:19.8');
  await p.screenshot({ path: path.join(SHOTS, '42-trim-audio.png') });
  // Back keeps the cut on the file, and Convert uses it.
  await p.click('button[aria-label="Back to Convert & Trim"]');
  await p.waitForTimeout(150);
  assert.ok(await p.isVisible('.cv-item:has-text("Lo-fi Beats") >> text=0:12 – 0:20'), 'the cut shows on the file');
  await p.evaluate(() => { window._cv.started = []; });
  await p.click('#cv-go');
  await p.waitForTimeout(400);
  const specs = await p.evaluate(() => window._cv.started);
  const lofi = specs.find((x) => /Lo-fi/.test(x.path));
  assert.ok(lofi && lofi.format === 'mp3' && lofi.quality === 'medium' && Math.abs(lofi.trim.start - 12) < 0.01, JSON.stringify(specs));
  assert.ok(!specs.some((x) => /Jimmy/.test(x.path)), 'the finished one isn\'t converted again');

  // 7. A file the player can't show: a preview copy is made and played.
  await p.click('.cv-item:has-text("Old Camcorder") button:has-text("Trim")');
  await p.waitForFunction(() => window._cv.previewed === '/media/Old Camcorder Tape.avi', null, { timeout: 10000 });
  assert.equal(await p.inputValue('section[aria-label="Save the clip"] select'), 'mp4', 'an AVI clip is saved as MP4 by default');
  await p.waitForFunction(() => { const v = document.querySelector('video.cv-video'); return v && v.readyState >= 1 && /preview/.test(v.src); }, null, { timeout: 10000 });
  // Remove from the Trim screen: back to the drop screen, the file is gone from the list.
  assert.ok(await p.isVisible('button.cv-remove-top:has-text("Remove")'), 'a Remove button on the Trim screen');
  await p.click('button.cv-remove-top');
  await p.waitForTimeout(200);
  assert.ok(await p.isVisible('text=Drop video or audio files here'), 'back on the drop screen');
  assert.ok(!(await p.isVisible('.cv-item:has-text("Old Camcorder")')), 'that file is off the list');
  assert.equal(await p.evaluate(() => document.querySelectorAll('video, audio').length), 0, 'player stopped');

  // 8. Save to a folder of your choice.
  await p.selectOption('section[aria-label="Output"] select >> nth=2', 'pick');
  await p.waitForTimeout(200);
  assert.equal(await p.inputValue('section[aria-label="Output"] select >> nth=2'), 'folder');
  assert.ok(await p.isVisible('option:text-is("D:\\\\Clips")') || (await p.$$eval('option', (o) => o.map((x) => x.textContent))).includes('D:\\Clips'));

  // 9. Dragging a video onto the window (from any screen) opens it in Convert & Trim.
  await p.click('.navbtn[data-view="downloads"]');
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(10)], 'Dropped Clip.mp4', { type: 'video/mp4' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => document.querySelector('.navbtn.on').dataset.view), 'convert');
  assert.ok(await p.evaluate(() => window._cv.added.includes('/drop/Dropped Clip.mp4')));
  // Dropping a link on Downloads still adds it like before (unchanged).
  await p.click('.navbtn[data-view="downloads"]');
  const before = await p.evaluate(() => document.querySelectorAll('.qitem').length);
  await p.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'not a link'); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
  await p.waitForTimeout(200);
  assert.ok(await p.isVisible('text=No links found in what you dropped.'));
  assert.equal(await p.evaluate(() => document.querySelectorAll('.qitem').length), before);

  // 10. Stop a conversion that's running.
  await p.click('.navbtn[data-view="convert"]');
  await p.evaluate(() => { window._cv.hold = true; window._cv.pick = [window._cv.pick[0]]; });
  await p.click('button:text-is("Clear finished")');
  await p.click('button:text-is("Choose files…")'); await p.waitForTimeout(150);
  await p.click('#cv-go'); await p.waitForTimeout(200);
  assert.ok(await p.isVisible('.cv-item >> text=Converting'));
  await p.click('.cv-item .cv-remove'); await p.waitForTimeout(150);
  assert.ok((await p.evaluate(() => window._cv.canceled.length)) >= 1, 'removing a converting file stops it');
  assert.equal(await p.$$eval('.cv-item', (x) => x.length), 0, 'and takes it off the list');
  // Remove one file with its X; Remove all clears the rest.
  await p.evaluate(() => { window._cv.hold = false; window._cv.pick = [{ ok: true, info: { path: '/media/A.mp4', name: 'A.mp4', size: 1e6, duration: 5, hasVideo: true, hasAudio: true } }, { ok: true, info: { path: '/media/B.mp4', name: 'B.mp4', size: 1e6, duration: 5, hasVideo: true, hasAudio: true } }, { ok: true, info: { path: '/media/C.mp4', name: 'C.mp4', size: 1e6, duration: 5, hasVideo: true, hasAudio: true } }]; });
  await p.click('button:text-is("Choose files…")'); await p.waitForTimeout(150);
  assert.equal(await p.$$eval('.cv-item', (x) => x.length), 3);
  const xb = await (await p.$('.cv-item >> nth=0')).boundingBox(); const rb = await (await p.$('.cv-item >> nth=0 >> .cv-remove')).boundingBox();
  assert.ok(rb.x + rb.width > xb.x + xb.width - 20 && rb.y < xb.y + 20, 'the X sits in the top-right corner');
  await p.click('.cv-item:has-text("B.mp4") .cv-remove'); await p.waitForTimeout(100);
  assert.deepEqual(await p.$$eval('.cv-item', (x) => x.map((e) => e.querySelector('.title').textContent)), ['A.mp4', 'C.mp4']);
  await p.screenshot({ path: path.join(SHOTS, '45-remove-x.png') });
  await p.click('button:has-text("Remove all")'); await p.waitForTimeout(100);
  assert.equal(await p.$$eval('.cv-item', (x) => x.length), 0);

  assert.deepEqual(errs, []);
  await b.close(); server.close(); await ms.close();
  console.log('convert & trim UI: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
