// Runs the real Page scan page scripts in a browser against test pages shaped like real ones.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
const assert = require('assert/strict');
const scan = require('../../src/main/scanlogic');

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage();
  const open = (f) => page.goto('file://' + path.join(__dirname, 'pages', f));
  const run = (code) => page.evaluate(code);
  // file:// pages have no host; pretend they live on www.example.com for link picking
  const fix = (links) => links.map((l) => ({ ...l, href: l.href.replace(/^file:\/\/[^?#]*?\/test\/ui\/pages/, 'https://www.example.com').replace(/^file:\/\//, 'https://www.example.com') }));

  await open('profile.html');
  assert.equal(await run(scan.AGE_CLICK), 'Option One : ENTER', 'clicks the main enter button');
  assert.equal(await run('window.picked'), 'first');
  assert.equal(await run(scan.AGE_CLICK), null, 'nothing left to click');
  const res = await run(scan.COLLECT);
  assert.ok(res.next && res.next.endsWith('/maker/some_maker/2'), 'finds the Next page: ' + res.next);
  assert.equal(res.h1, 'some maker');
  const vids = scan.pickVideoLinks(fix(res.links), 'https://www.example.com/maker/some_maker');
  assert.deepEqual(vids.map((v) => v.title), ['First Clip', 'Second Clip', 'Third Clip', 'Fourth Clip']);
  assert.ok(vids.every((v) => /\/video-/.test(v.url)));

  await open('gate.html');
  assert.equal(await run(scan.AGE_CLICK), 'Yes, I am 21+ - Enter', 'age gate page');
  assert.equal(await run('window.picked'), 'enter');

  await open('plain.html');
  assert.equal(await run(scan.AGE_CLICK), 'Accept all', 'cookie banner: accept, never reject');
  const plain = await run(scan.COLLECT);
  assert.equal(scan.pickVideoLinks(fix(plain.links), 'https://www.example.com/u/x').length, 2);

  await open('menus.html');
  assert.equal(await run(scan.AGE_CLICK), null, 'no popup, no click');
  const menus = await run(scan.COLLECT);
  assert.deepEqual(scan.pickVideoLinks(fix(menus.links), 'https://www.example.com/maker/x'), [], 'menu links are never videos');

  await b.close();
  console.log('page scan scripts: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
