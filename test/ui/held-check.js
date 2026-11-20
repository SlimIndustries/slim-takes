const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'); const assert = require('assert');
const APP = require('path').resolve(__dirname, '../..');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ content: fs.readFileSync(APP + '/test/ui/mock-api.js', 'utf8') });
  await p.goto('file://' + APP + '/src/renderer/index.html'); await p.waitForTimeout(400);
  await p.evaluate(() => {
    state.items.unshift({ id: 'h1', title: 'Garden Clip 1', folder: 'Garden Collection', site: 'example.com', format: 'mp4', quality: '1080', status: 'paused', note: 'Waiting: this site needs a fresh pass', heldForPass: true, addedAt: Date.now() });
    state.items.unshift({ id: 'h2', title: 'Garden Clip 2', folder: 'Garden Collection', site: 'example.com', format: 'mp4', quality: '1080', status: 'waiting', note: 'Waiting for the page window (1 ahead)', addedAt: Date.now() });
    renderView();
    window.slim._emit('queue:needsPass', { host: 'example.com', count: 2 });
  });
  await p.waitForTimeout(300);
  assert.ok(await p.isVisible('button:text-is("Resume all")'));
  assert.ok(await p.isVisible('text=Waiting: this site needs a fresh pass'));
  await p.screenshot({ path: APP + '/test/ui/shots/27-held.png' });
  assert.deepEqual(errs, []); await b.close(); console.log('held downloads UI ok');
})().catch((e) => { console.error(e); process.exit(1); });
