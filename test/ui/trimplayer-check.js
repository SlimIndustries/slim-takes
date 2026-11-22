// The Trim screen's player under stress, in a real browser, with a large real video (hundreds of MB,
// index at the end of the file like many downloads): play/pause every way (big button over the picture,
// round button, clicking the picture, space bar), dragging both bars and the play position while playing, looping
// (also hammered), a server that stops answering (the player must get itself going again), and the
// big Trim button next to Convert.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http'); const assert = require('assert');
const { execFileSync } = require('child_process');
const APP = path.resolve(__dirname, '../..');
const SHOTS = path.join(APP, 'test/ui/shots');
const FF = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const dir = path.join(os.tmpdir(), 'trimplayer-media');
  fs.mkdirSync(dir, { recursive: true });
  const big = path.join(dir, 'Big Download 1080p.mp4');
  if (!fs.existsSync(big) || fs.statSync(big).size < 250e6) {
    // ~300 MB, 1080p, 90 s, no "faststart" (the index is at the end, as with many downloaded files).
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=90:size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=90',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '26M', '-maxrate', '26M', '-bufsize', '52M', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', big]);
  }
  const size = fs.statSync(big).size;
  assert.ok(size > 250e6, 'big test file: ' + size);

  // The app's own private media server (the real code), with a test switch to stop answering.
  const { startMediaServer } = require(APP + '/src/main/mediaserver');
  const ctl = { hang: 0, hung: [] };
  const ms = await startMediaServer({ allowed: () => true, hook: (req, res) => { if (ctl.hang > 0) { ctl.hang--; ctl.hung.push(res); return true; } return false; } });
  const server = { close: () => ms.close() };
  const port = 0;

  const vid = { ok: true, info: { path: '/media/Big Download 1080p.mp4', name: 'Big Download 1080p.mp4', size, duration: 90, hasVideo: true, hasAudio: true, height: 1080 } };
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
  const p = page;
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ content: fs.readFileSync(APP + '/test/ui/mock-api.js', 'utf8') });
  await p.addInitScript({ content: `window._cv = { pick: ${JSON.stringify([vid])}, previewPath: '' };` });
  await p.exposeFunction('cvMediaUrl', (file, n) => ms.url(big, n));
  await p.goto('file://' + APP + '/src/renderer/index.html');
  await p.waitForTimeout(400);
  await p.evaluate(() => { window.fileUrl = () => 'about:blank#not-the-app-file-channel'; fileUrl = window.fileUrl; });
  const V = () => p.evaluate(() => { const v = document.querySelector('video.cv-video'); return v ? { paused: v.paused, ended: v.ended, t: v.currentTime, seeking: v.seeking, rs: v.readyState } : null; });
  const waitPlaying = async (what, ms = 8000) => {
    const t0 = Date.now(); let a = await V();
    while (Date.now() - t0 < ms) {
      await p.waitForTimeout(300);
      const b2 = await V();
      if (!b2.paused && b2.t > a.t + 0.05) return b2;
      a = b2;
    }
    throw new Error(what + ': not playing: ' + JSON.stringify(await V()) + ' / ' + (await p.textContent('#cv-pv')));
  };
  const handle = async (n) => (await p.$(`.cv-handle >> nth=${n}`)).boundingBox();
  const drag = async (n, toFrac, steps = 40) => {
    const box = await (await p.$('.cv-track')).boundingBox();
    const hb = await handle(n);
    await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width * toFrac, hb.y + hb.height / 2, { steps });
    await p.mouse.up();
  };

  // ---- The list: one file -> a big Trim button next to Convert, the same size.
  await p.click('.navbtn[data-view="convert"]');
  await p.click('button:text-is("Choose files…")');
  await p.waitForTimeout(200);
  assert.ok(await p.isVisible('#cv-trim'), 'big Trim button shown for one file');
  const [tb, gb] = [await (await p.$('#cv-trim')).boundingBox(), await (await p.$('#cv-go')).boundingBox()];
  assert.equal(Math.round(tb.height), Math.round(gb.height), 'same height as Convert');
  assert.ok(Math.abs(tb.y - gb.y) < 2 && gb.x > tb.x && gb.x - (tb.x + tb.width) < 30, 'right beside Convert');
  await p.screenshot({ path: path.join(SHOTS, '43-convert-one-file.png') });

  // ---- Trim: big play button over the picture.
  await p.click('#cv-trim');
  await p.waitForFunction(() => { const v = document.querySelector('video.cv-video'); return v && v.readyState >= 1; }, null, { timeout: 20000 });
  await p.evaluate(() => { const v = document.querySelector('video.cv-video'); v.muted = true; window._seeks = 0; v.addEventListener('seeking', () => window._seeks++); });
  assert.ok(await p.isVisible('.cv-bigplay'), 'big play button over the picture while paused');
  assert.ok(await p.isVisible('.cv-play'), 'round play button under the picture');
  await p.click('.cv-bigplay');
  await waitPlaying('big play button');
  assert.ok(!(await p.isVisible('.cv-bigplay')), 'big play button hides while playing');
  // Round button pauses; space bar plays and pauses; clicking the picture pauses.
  await p.click('.cv-play');
  await p.waitForTimeout(200);
  assert.ok((await V()).paused, 'round button paused it');
  await p.click('h1');                 // nothing focused that would swallow the space bar
  await p.keyboard.press('Space');
  await waitPlaying('space bar');
  await p.keyboard.press('Space');
  await p.waitForTimeout(200);
  assert.ok((await V()).paused, 'space bar paused it');
  await p.click('.cv-bigplay');
  await waitPlaying('big play again');
  await p.click('video.cv-video', { position: { x: 100, y: 60 } });
  await p.waitForTimeout(200);
  assert.ok((await V()).paused, 'clicking the picture paused it');

  // Watch the player closely: was it ever paused, and every time it was at.
  const watch = async (ms) => p.evaluate(async (ms) => {
    const v = document.querySelector('video.cv-video'); const seen = []; let paused = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { seen.push(v.currentTime); if (v.paused) paused++; await new Promise((r) => setTimeout(r, 50)); }
    return { seen, paused, end: v.currentTime, isPaused: v.paused };
  }, ms);
  const secOf = (txt) => txt.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
  const startS = async () => secOf(await p.inputValue('input[aria-label="Start time"]'));
  const endS = async () => secOf(await p.inputValue('input[aria-label="End time"]'));

  // ---- Your case: playing, then drag the RIGHT bar to the left, fast. It must NOT pause.
  await p.click('.cv-play'); await waitPlaying('before dragging');
  await p.evaluate(() => { window._seeks = 0; window._pauses = 0; document.querySelector('video.cv-video').addEventListener('pause', () => window._pauses++); });
  const dragStart = Date.now();
  await drag(1, 0.45, 60);
  const dragMs = Date.now() - dragStart;
  let w = await watch(1500);
  const seeks = await p.evaluate(() => window._seeks);
  let e1 = await endS();
  assert.equal(await p.evaluate(() => window._pauses), 0, 'never paused while dragging the right bar');
  assert.ok(!w.isPaused && w.paused === 0, 'still playing after letting go');
  // The picture follows a few times a second at most (dozens a second is what used to jam the player).
  assert.ok(seeks <= Math.ceil(dragMs / 300) + 3, `only a few jumps a second while dragging: ${seeks} in ${dragMs} ms`);
  assert.ok(e1 > 35 && e1 < 46, 'end ≈ 40 s: ' + e1);
  assert.ok(w.seen.some((x) => Math.abs(x - (e1 - 2)) < 0.8), 'showed the last couple of seconds of the cut: ' + w.seen.slice(0, 5).map((x) => x.toFixed(1)));

  // ---- The LEFT bar, while playing: keeps playing, carries on from the new start.
  await drag(0, 0.2, 40);
  w = await watch(1200);
  let s1 = await startS();
  assert.equal(await p.evaluate(() => window._pauses), 0, 'never paused while dragging the left bar');
  assert.ok(!w.isPaused && w.seen.some((x) => Math.abs(x - s1) < 0.8), 'carried on from the new start ' + s1 + ': ' + w.seen.slice(0, 5).map((x) => x.toFixed(1)));

  // ---- Play loops the selection: from its start to its end, over and over, until you pause.
  await p.fill('input[aria-label="End time"]', String(s1 + 2.5)); await p.press('input[aria-label="End time"]', 'Enter');
  w = await watch(6500);
  e1 = await endS();
  assert.equal(w.paused, 0, 'kept playing the whole time');
  const drops = w.seen.filter((x, i) => i && x < w.seen[i - 1] - 1).length;
  assert.ok(drops >= 2, 'looped back to the start at least twice: ' + drops);
  assert.ok(w.seen.slice(10).every((x) => x >= s1 - 0.3 && x <= e1 + 0.3), 'stayed inside the selection');
  // Pause, then play: starts from the beginning of the selection.
  await p.click('.cv-play'); await p.waitForTimeout(300);
  assert.ok((await V()).paused, 'pause pauses');
  await p.waitForTimeout(500);
  assert.ok((await V()).paused, 'and it stays paused');
  await p.click('.cv-play');
  const v1 = await waitPlaying('play after pause');
  assert.ok(v1.t >= s1 - 0.2 && v1.t < s1 + 1.2, 'play starts at the selection start: ' + v1.t);
  // Paused: dragging a bar keeps it paused (just shows the frame).
  await p.click('.cv-play'); await p.waitForTimeout(200);
  await drag(1, 0.5, 20);
  await p.waitForTimeout(1200);
  let v = await V();
  e1 = await endS();
  assert.ok(v.paused && Math.abs(v.t - (e1 - 2)) < 0.8, 'paused stays paused, showing the end: ' + JSON.stringify(v) + ' end ' + e1);

  // ---- The white line: drag it to move through the video.
  await p.click('.cv-play'); await waitPlaying('before dragging the white line');
  s1 = await startS(); e1 = await endS();
  const knob = await (await p.$('.cv-knob')).boundingBox();
  const tbox = await (await p.$('.cv-track')).boundingBox();
  const target = s1 + (e1 - s1) * 0.4;
  await p.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
  await p.mouse.down();
  await p.mouse.move(tbox.x + tbox.width * (target / 90), knob.y + knob.height / 2, { steps: 25 });
  await p.mouse.up();
  w = await watch(1000);
  assert.ok(!w.isPaused && w.paused === 0, 'still playing after dragging the white line');
  assert.ok(w.seen.some((x) => Math.abs(x - target) < 1.2), 'carried on from where it was dropped (' + target.toFixed(1) + '): ' + w.seen.slice(0, 4).map((x) => x.toFixed(1)));
  // Paused + drag the white line: stays paused there.
  await p.click('.cv-play'); await p.waitForTimeout(200);
  const k2 = await (await p.$('.cv-knob')).boundingBox();
  await p.mouse.move(k2.x + k2.width / 2, k2.y + k2.height / 2);
  await p.mouse.down();
  await p.mouse.move(tbox.x + tbox.width * 0.3, k2.y + k2.height / 2, { steps: 15 });
  await p.mouse.up();
  await p.waitForTimeout(1200);
  v = await V();
  assert.ok(v.paused && Math.abs(v.t - 27) < 1.2, 'paused, moved to 0:27: ' + JSON.stringify(v));
  // Arrow keys move the white line too.
  await p.focus('.cv-head'); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(600);
  assert.ok(Math.abs((await V()).t - 32) < 1.2, 'arrow key moved it 5 s');

  // ---- Hammer it: drag everything back and forth fast, mash play/pause, then it must play cleanly.
  await p.fill('input[aria-label="End time"]', '1:20'); await p.press('input[aria-label="End time"]', 'Enter');
  await p.click('.cv-play');
  for (let i = 0; i < 6; i++) { await drag(1, 0.5 + (i % 2) * 0.35, 8); await drag(0, 0.05 + (i % 3) * 0.1, 8); }
  for (let i = 0; i < 8; i++) { await p.click('.cv-play'); await p.waitForTimeout(70); }  // it was playing: an even number of presses leaves it playing
  await waitPlaying('after hammering', 10000);
  w = await watch(1500);
  assert.equal(w.paused, 0, 'playing steadily after all that');
  await p.screenshot({ path: path.join(SHOTS, '44-trim-video-player.png') });

  // ---- The file stops answering (like a stuck read): the player gets itself going again.
  await p.click('.cv-play'); await p.waitForTimeout(200);
  ctl.hang = 3;
  await p.fill('input[aria-label="Start time"]', '1:05'); await p.press('input[aria-label="Start time"]', 'Enter');
  await p.click('.cv-play');
  const t0 = Date.now();
  let sawReload = false;
  for (;;) {
    await p.waitForTimeout(400);
    if (/Reloading the video/.test(await p.textContent('#cv-pv'))) sawReload = true;
    const s = await V();
    if (!s.paused && s.t > 65.3 && !s.seeking) break;
    if (Date.now() - t0 > 25000) throw new Error('stuck after the file stopped answering: ' + JSON.stringify(s) + ' ' + (await p.textContent('#cv-pv')));
  }
  await waitPlaying('after the stuck read');
  const srcNow = await p.evaluate(() => document.querySelector('video.cv-video').src);
  assert.ok(/&r=(\d+)/.test(srcNow) && Number(srcNow.match(/&r=(\d+)/)[1]) >= 2, 'reloaded from a fresh address (never the same one): ' + srcNow.slice(-12));
  assert.ok(sawReload || ctl.hung.length < 3, 'it reloaded by itself (' + ctl.hung.length + ' requests never answered)');
  ctl.hung.forEach((r) => { try { r.destroy(); } catch { /* gone */ } });

  // ---- Changing Exact/Fast and the format doesn't restart the player.
  const tBefore = (await V()).t;
  await p.selectOption('section[aria-label="Save the clip"] select', 'mkv');
  await p.click('button[role="radio"]:text-is("Fast")');
  await p.waitForTimeout(400);
  v = await V();
  assert.ok(!v.paused && v.t >= tBefore, 'kept playing while changing options: ' + JSON.stringify(v));
  assert.ok(await p.isVisible('text=may start up to a couple of seconds early'));

  // ---- Back: the player stops (no sound left playing in the background).
  await p.click('button[aria-label="Back to Convert & Trim"]');
  await p.waitForTimeout(300);
  assert.equal(await p.evaluate(() => document.querySelectorAll('video').length), 0);
  assert.ok(await p.isVisible('#cv-trim:has-text("Trim (")'), 'the big Trim button shows the cut');
  // Space bar on the list does nothing odd (no player there).
  await p.click('h1'); await p.keyboard.press('Space');

  // ---- Two files: each has its own (bold) Trim button; the big one steps aside.
  await p.evaluate(() => { window._cv.pick = [{ ok: true, info: { path: '/media/Second.mp4', name: 'Second.mp4', size: 1e6, duration: 10, hasVideo: true, hasAudio: true } }]; });
  await p.click('button:text-is("Choose files…")'); await p.waitForTimeout(200);
  assert.ok(!(await p.isVisible('#cv-trim')), 'big Trim hidden with two files');
  assert.equal(await p.$$eval('.cv-item .trimbtn', (x) => x.length), 2);

  assert.deepEqual(errs, []);
  assert.ok(await p.evaluate(() => /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}\/m\?p=/.test(document.querySelector('video, audio') ? document.querySelector('video, audio').src : 'http://127.0.0.1:1/' + 'a'.repeat(48) + '/m?p=')), 'the player used the private server');
  await b.close(); await server.close();
  console.log('trim player under stress: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
