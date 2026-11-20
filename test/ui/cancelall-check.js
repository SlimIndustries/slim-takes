const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path'); const fs = require('fs'); const assert = require('assert');
const APP = path.resolve(__dirname, '../..');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 820 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ content: fs.readFileSync(APP + '/test/ui/mock-api.js', 'utf8') });
  await p.goto('file://' + APP + '/src/renderer/index.html'); await p.waitForTimeout(400);
  await p.screenshot({ path: APP + '/test/ui/shots/23-cancel-all.png' });
  await p.click('button:text-is("Cancel all")'); await p.waitForTimeout(150);
  await p.screenshot({ path: APP + '/test/ui/shots/24-cancel-all-confirm.png' });
  await p.click('.dialog button:text-is("Cancel them")'); await p.waitForTimeout(200);
  assert.ok(await p.isVisible('text=Canceled 4 downloads.'));
  assert.deepEqual(errs, []); await b.close(); console.log('cancel all UI ok');
})().catch((e) => { console.error(e); process.exit(1); });
