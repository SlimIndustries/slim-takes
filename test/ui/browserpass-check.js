// Checks the "use your normal browser instead" part of the Open the page window.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '../../src/renderer');
const OUT = path.resolve(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-api.js'), 'utf8');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript({ content: MOCK });
  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForTimeout(400);
  const URL = 'https://www.example.com/channel/someone/';
  await page.evaluate((u) => { showMeScan(u); }, URL);
  await page.waitForTimeout(200);
  assert.ok(await page.isVisible('text=Check keeps repeating? Use your normal browser instead'), 'link shown');
  assert.ok(!(await page.isVisible('text=1. Your browser')), 'backup hidden at first');
  // another page's loop is ignored; this page's loop opens the backup
  await page.evaluate(() => window.slim._emit('pageScan:loop', 'https://other.example/'));
  assert.ok(!(await page.isVisible('text=1. Your browser')));
  await page.evaluate((u) => window.slim._emit('pageScan:loop', u), URL);
  await page.waitForTimeout(100);
  assert.ok(await page.isVisible('text=1. Your browser'), 'backup opened on loop');
  assert.ok(await page.isVisible('text=keeps repeating in this window'));
  await page.screenshot({ path: path.join(OUT, '20-browser-pass.png') });
  // Chrome: friendly error, modal stays
  await page.selectOption('.dialog select', 'chrome');
  await page.click('button:text-is("Done, use my browser\'s pass")');
  await page.waitForTimeout(200);
  assert.ok(await page.isVisible('text=Firefox works best'), 'chrome error shown');
  await page.screenshot({ path: path.join(OUT, '21-browser-pass-error.png') });
  // Firefox: works, modal closes, list loads
  await page.selectOption('.dialog select', 'firefox');
  await page.click('button:text-is("Done, use my browser\'s pass")');
  await page.waitForTimeout(500);
  assert.ok(!(await page.isVisible('.dialog')), 'modal closed');
  assert.ok(await page.isVisible('text=Using Firefox\'s pass for this site.'), 'toast');
  await page.screenshot({ path: path.join(OUT, '22-browser-pass-done.png') });
  assert.deepEqual(errors, []);
  // the Cloudflare check detector
  const p2 = await browser.newPage();
  const { CF_CHECK } = { CF_CHECK: require('fs').readFileSync(path.resolve(__dirname, '../../src/main/pagescan.js'), 'utf8').match(/CF_CHECK = String\.raw`([\s\S]*?)`;/)[1] };
  await p2.setContent('<title>Just a moment...</title><div id="challenge-stage"></div>');
  assert.equal(await p2.evaluate(CF_CHECK), true);
  await p2.setContent('<title>Someone - Videos</title><a href="/v/1">video</a>');
  assert.equal(await p2.evaluate(CF_CHECK), false);
  await browser.close();
  console.log('browser pass UI: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
