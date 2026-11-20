'use strict';
// "Use my browser instead": when a site's "are you human" check keeps repeating in the app's own
// page window, the user ticks the box in their normal browser, and this borrows that browser's
// pass (cookies) for that one site, along with a matching browser identity.
// Only the cookies for that site are kept; the full export is deleted straight away.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run } = require('./util');

const BROWSERS = ['firefox', 'chrome', 'edge', 'brave', 'opera', 'vivaldi'];
const LABEL = { firefox: 'Firefox', chrome: 'Chrome', edge: 'Edge', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi' };

// Where Windows records each browser's version.
const REG_KEYS = {
  chrome: [['HKCU\\Software\\Google\\Chrome\\BLBeacon', 'version']],
  edge: [['HKCU\\Software\\Microsoft\\Edge\\BLBeacon', 'version']],
  brave: [['HKCU\\Software\\BraveSoftware\\Brave-Browser\\BLBeacon', 'version']],
  vivaldi: [['HKCU\\Software\\Vivaldi\\BLBeacon', 'version']],
  opera: [],
  firefox: [
    ['HKLM\\SOFTWARE\\Mozilla\\Mozilla Firefox', 'CurrentVersion'],
    ['HKCU\\SOFTWARE\\Mozilla\\Mozilla Firefox', 'CurrentVersion'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Mozilla\\Mozilla Firefox', 'CurrentVersion']
  ]
};

async function regQuery(key, value) {
  if (process.platform !== 'win32') return null;
  const r = await run('reg', ['query', key, '/v', value], { timeout: 8000 });
  const m = r.code === 0 && r.stdout.match(/REG_SZ\s+(.+?)\s*$/m);
  return m ? m[1] : null;
}

// Firefox ships a new major version every 4 weeks (128 came out on 9 July 2024).
function guessFirefoxMajor(now = Date.now()) {
  return 128 + Math.max(0, Math.floor((now - Date.UTC(2024, 6, 9)) / (28 * 86400000)));
}

/**
 * The user agent the user's own browser sends (Cloudflare ties its pass to it), and the engine's
 * matching connection type. `opts.query` and `opts.chromeMajor` can be swapped out for tests.
 */
async function browserIdentity(browser, { query = regQuery, chromeMajor, now } = {}) {
  let major = null;
  for (const [key, value] of REG_KEYS[browser] || []) {
    const v = await query(key, value).catch(() => null);
    const m = v && String(v).match(/^(\d+)\./);
    if (m) { major = Number(m[1]); break; }
  }
  if (browser === 'firefox') {
    if (!major || major < 100) major = guessFirefoxMajor(now);
    return { target: 'firefox', ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${major}.0) Gecko/20100101 Firefox/${major}.0` };
  }
  if (!major || major < 100) major = Number(chromeMajor || String(process.versions.chrome || '142').split('.')[0]);
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` +
    (browser === 'edge' ? ` Edg/${major}.0.0.0` : '');
  return { target: 'chrome', ua };
}

function hostMatches(domain, host) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === host || d.endsWith('.' + host) || host.endsWith('.' + d);
}

/** Read a Netscape cookies.txt (the engine's format) into cookie objects, keeping only one site's. */
function readCookieFile(text, host) {
  const out = [];
  for (let line of String(text).split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice(10); }
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [domain, , cpath, secure, expires, name, ...rest] = f;
    if (!hostMatches(domain, host)) continue;
    out.push({ domain, hostOnly: !domain.startsWith('.'), path: cpath || '/', secure: secure === 'TRUE', httpOnly,
      expirationDate: Number(expires) || undefined, name, value: rest.join('\t') });
  }
  return out;
}

function friendly(browser, stderr) {
  const name = LABEL[browser] || browser;
  const e = String(stderr || '');
  if (/dpapi|decrypt|app.?bound|could not copy|permission denied|locked|being used by another process/i.test(e)) {
    return `${name} locks its cookies so other apps can't read them (Chrome, Edge and Brave do this now). Firefox works best for this: pick Firefox, tick the box there, then press Done.`;
  }
  if (/could not find|no such|not installed|profile/i.test(e)) return `Couldn't find ${name} on this PC. Pick the browser you actually used.`;
  return `Couldn't read ${name}'s cookies: ` + (e.split(/\r?\n/).find((l) => /ERROR/.test(l)) || e).replace(/^ERROR:\s*/, '').slice(0, 200);
}

/**
 * Borrow one site's cookies from the user's browser, via the engine (it knows how to read every
 * browser's cookie store). Returns cookie objects for that site only.
 */
async function exportBrowserCookies(engine, browser, url) {
  if (!BROWSERS.includes(browser)) throw new Error('Pick a browser first.');
  const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  const tmp = path.join(os.tmpdir(), `slimtakes-${crypto.randomBytes(8).toString('hex')}.txt`);
  try {
    // The engine loads the browser's cookies and writes them out on exit; the link itself is never fetched.
    const r = await run(engine.ytdlp, [...engine.baseArgs(), '--ignore-config', '--no-warnings', '--cookies-from-browser', browser,
      '--cookies', tmp, '--simulate', '--', 'about:blank'], { env: engine.env(), timeout: 60000 });
    if (!fs.existsSync(tmp)) throw new Error(friendly(browser, r.stderr));
    const cookies = readCookieFile(fs.readFileSync(tmp, 'utf8'), host);
    if (!cookies.some((c) => /^cf_clearance$/i.test(c.name))) {
      throw new Error(`${LABEL[browser]} doesn't have an "I'm human" pass for this site yet. Open the site in ${LABEL[browser]}, tick the box, wait until you can see the videos, close ${LABEL[browser]}, then press Done again.`);
    }
    return cookies;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

module.exports = { BROWSERS, LABEL, browserIdentity, exportBrowserCookies, readCookieFile, guessFirefoxMajor };
