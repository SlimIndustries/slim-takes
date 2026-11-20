// Renders the real window code with the stand-in bridge and saves screenshots.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '../../src/renderer');
const OUT = path.resolve(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-api.js'), 'utf8');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  async function open(query, w = 1280, h = 820) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/slimfile|ERR_FILE_NOT_FOUND|net::/.test(m.text())) errors.push(`${query}: console: ${m.text()}`); });
    // Inline the stand-in bridge before the app script runs (file:// pages ignore query strings for addInitScript otherwise).
    await page.addInitScript({ content: `history.replaceState(null,'', location.pathname + '?${query}');\n` + MOCK });
    await page.goto('file://' + path.join(ROOT, 'index.html'));
    await page.waitForTimeout(400);
    return page;
  }
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });

  let p = await open('');
  await shot(p, '01-downloads');
  await p.fill('#paste', 'https://www.youtube.com/watch?v=abc');
  await p.click('button:text-is("Add")');
  await p.waitForTimeout(300);
  await shot(p, '02-preview');
  await p.click('[data-view="grab"]');
  await p.waitForTimeout(200);
  await shot(p, '03a-grab-empty');
  await p.click('[data-view="downloads"]');
  await p.fill('#paste', 'https://www.youtube.com/@JimmyTheLawnGuy');
  await p.click('button:text-is("Add")');
  await p.waitForTimeout(400);
  await shot(p, '03-grab');
  await p.selectOption('select >> nth=1', 'custom');
  await p.waitForTimeout(200);
  await shot(p, '03b-grab-custom-dates');
  await p.click('[data-view="watch"]');
  await p.waitForTimeout(200);
  await shot(p, '04-watch');
  await p.click('[data-view="history"]');
  await p.waitForTimeout(300);
  await shot(p, '05-history');
  await p.click('[data-view="settings"]');
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, '06-settings.png') });
  await p.evaluate(() => { const v = document.getElementById('view'); v.scrollTop = v.scrollHeight; });
  await p.waitForTimeout(200);
  await shot(p, '06b-settings-bottom');
  await p.click('[data-view="downloads"]');
  await p.click('text=Set up browser login');
  await p.waitForTimeout(900);
  await shot(p, '06c-accounts-jump');
  await p.click('[data-view="settings"]');
  await p.click('text=Open log');
  await p.waitForTimeout(200);
  await shot(p, '07-log');
  await p.keyboard.press('Escape');
  await p.click('[data-view="downloads"]');
  await p.click('text=Private mode');
  await p.waitForTimeout(150);
  await shot(p, '08-private');

  await p.click('[data-view="downloads"]');
  await p.fill('#paste', 'https://www.example.com/maker/scanfail');
  await p.click('button:text-is("Add")');
  await p.waitForTimeout(400);
  await shot(p, '14-scan-failed');
  await p.click('button:text-is("Open the page")');
  await p.waitForTimeout(300);
  await shot(p, '15-show-me');
  await p.click('button:text-is("Scan now")');
  await p.waitForTimeout(400);
  await shot(p, '16-scanned-list');

  p = await open('setup=1');
  await p.waitForTimeout(300);
  await shot(p, '09-setup');
  p = await open('locked=1');
  await shot(p, '10-locked');
  p = await open('theme=daylight');
  await shot(p, '11-daylight');
  p = await open('theme=custom');
  await shot(p, '12-custom');
  p = await open('', 1000, 700);
  await shot(p, '13-small-window');

  await browser.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
})();
