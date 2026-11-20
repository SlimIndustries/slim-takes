const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'); const assert = require('assert');
const APP = require('path').resolve(__dirname, '../..');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 820 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ content: fs.readFileSync(APP + '/test/ui/mock-api.js', 'utf8') });
  await p.goto('file://' + APP + '/src/renderer/index.html'); await p.waitForTimeout(400);
  const v = { kind: 'video', url: 'https://example.com/video/1/clip/', id: 'clip', extractor: 'Generic', site: 'example.com', title: 'Clip Title', folder: 'Garden Collection', channelName: 'Garden Collection', hasUploader: true, duration: 768, thumbnail: null, heights: [], isLive: false, viaPage: true, direct: 'ticket-123', have: 'new', savePath: 'C:\\x\\Garden Collection' };
  await p.evaluate((r) => showSingle(r), v);
  await p.waitForTimeout(200);
  const spec = await p.evaluate((r) => specFromVideo(r, state.previewOpts), v);
  assert.equal(spec.direct, 'ticket-123');
  await p.screenshot({ path: APP + '/test/ui/shots/26-video-from-page.png' });
  assert.deepEqual(errs, []); await b.close(); console.log('video from the page shows and carries its ticket: ok');
})().catch((e) => { console.error(e); process.exit(1); });
