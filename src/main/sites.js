'use strict';
// Per-site extras, only for sites that need them (e.g. ones behind Cloudflare's "are you human" check):
//  - impersonate: connect like a normal Chrome browser
//  - pass: the "I'm human" pass (cookies) from the Open the page window, shared with the engine
// Sites that never hit a check have no entry, and nothing changes for them.

const fs = require('fs');
const path = require('path');

const CLOUDFLARE = /cloudflare|anti-bot challenge|generic:impersonate|cf-mitigated|just a moment/i;
const NO_IMPERSONATE = /impersonate target .* (is )?not available|no impersonate target|impersonation is not supported/i;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

// Netscape cookie file, the format yt-dlp reads with --cookies.
function toCookieFile(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Made by Slim Takes from the Open the page window', ''];
  for (const c of cookies) {
    if (!c.name || /[\t\n\r]/.test(String(c.value))) continue;
    const domain = c.hostOnly === false || String(c.domain).startsWith('.') ? (String(c.domain).startsWith('.') ? c.domain : '.' + c.domain) : c.domain;
    lines.push([
      domain,
      String(domain).startsWith('.') ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      c.expirationDate ? Math.floor(c.expirationDate) : 0,
      c.name,
      c.value
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

class Sites {
  constructor({ store, dir, log }) {
    this.store = store; // JsonStore: { [host]: { impersonate, impersonateUnavailable, pass: { file, ua, at } } }
    this.dir = dir;
    this.log = log || { info() {}, warn() {} };
  }

  get(host) { return (host && this.store.get()[host]) || null; }

  update(host, patch) {
    if (!host) return;
    const all = this.store.get();
    all[host] = { ...(all[host] || {}), ...patch };
    this.store.set(all);
  }

  /** Extra engine arguments for a link. Empty for ordinary sites. */
  argsFor(url) {
    const s = this.get(hostOf(url));
    if (!s) return [];
    const args = [];
    // Connect like the browser the pass came from (Chrome unless it was borrowed from Firefox).
    const target = (s.pass && s.pass.target) || 'chrome';
    if (s.impersonate && !s.impersonateUnavailable) args.push('--impersonate', target, '--extractor-args', 'generic:impersonate');
    if (s.pass && s.pass.file && fs.existsSync(s.pass.file)) {
      args.push('--cookies', s.pass.file);
      if (s.pass.ua) args.push('--user-agent', s.pass.ua);
    }
    return args;
  }

  hasPass(url) {
    const s = this.get(hostOf(url));
    return !!(s && s.pass && s.pass.file && fs.existsSync(s.pass.file));
  }

  /** Called when the engine reports a Cloudflare block. Returns true if a retry with new settings makes sense. */
  noteBlocked(url, message) {
    const host = hostOf(url);
    if (!host) return false;
    const s = this.get(host) || {};
    if (NO_IMPERSONATE.test(message)) {
      if (!s.impersonateUnavailable) this.update(host, { impersonateUnavailable: true });
      return false;
    }
    if (!CLOUDFLARE.test(message)) return false;
    if (!s.impersonate && !s.impersonateUnavailable) {
      this.log.info(`${host}: protected by Cloudflare, connecting like a normal browser from now on`);
      this.update(host, { impersonate: true });
      return true;
    }
    return false;
  }

  /**
   * Is this error a site-protection block? Cloudflare messages always count; a plain "403 Forbidden"
   * counts only for sites already known to be behind Cloudflare (after the browser retry, strict
   * sites answer with a bare 403).
   */
  isBlocked(url, message) {
    const m = String(message || '');
    if (CLOUDFLARE.test(m)) return true;
    const s = this.get(hostOf(url));
    return !!(s && s.impersonate && /HTTP Error 403|403:? Forbidden/i.test(m));
  }

  /** Where the site's pass came from: 'browser' (the user's own browser), 'window' (Open the page), or null. */
  passFrom(url) {
    if (!this.hasPass(url)) return null;
    return this.get(hostOf(url)).pass.from || 'window';
  }

  /**
   * Save the "I'm human" pass for a site: from the Open the page window, or borrowed from the
   * user's own browser (extra = { from: 'browser', target: 'firefox' | 'chrome' }).
   */
  savePass(url, cookies, ua, extra = {}) {
    const host = hostOf(url);
    if (!host || !cookies.some((c) => /^cf_clearance$/i.test(c.name))) return false; // only when Cloudflare gave a pass
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, host.replace(/[^a-z0-9.-]/g, '_') + '.cookies.txt');
    fs.writeFileSync(file, toCookieFile(cookies));
    this.update(host, { impersonate: true, pass: { file, ua, at: Date.now(), ...extra } });
    this.log.info(`${host}: saved the Cloudflare pass for downloads`);
    return true;
  }

  /** Forget all passes (Clear history). */
  clearPasses() {
    const all = this.store.get();
    for (const s of Object.values(all)) {
      if (s.pass && s.pass.file) { try { fs.rmSync(s.pass.file, { force: true }); } catch { /* ignore */ } }
      if (s.direct) { try { fs.rmSync(s.direct, { force: true }); } catch { /* ignore */ } }
      delete s.pass;
      delete s.direct;
      delete s.needsWindow;
    }
    this.store.set(all);
  }

  /** This site refuses the engine even with a pass: get its videos through the page window instead. */
  // (Forgotten after a few hours, so the faster engine gets another go; nothing is held against a site.)
  needsWindow(url) {
    const s = this.get(hostOf(url));
    return !!(s && s.needsWindow && Date.now() - (s.needsWindowAt || 0) < NEEDS_WINDOW_MS);
  }

  markNeedsWindow(url) {
    const host = hostOf(url);
    if (host && !this.needsWindow(url)) this.update(host, { needsWindow: true, needsWindowAt: Date.now() });
  }

  /** A clean slate for a site (after the user gets a fresh pass). */
  clearNeedsWindow(url) {
    const host = hostOf(url);
    const s = host && this.get(host);
    if (s && s.needsWindow) this.update(host, { needsWindow: false, needsWindowAt: 0 });
  }

  /** Save the page window's cookies for downloading a video file straight from a site. */
  writeDirectCookies(url, cookies) {
    const host = hostOf(url);
    if (!host || !cookies || !cookies.length) return null;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, host.replace(/[^a-z0-9.-]/gi, '_') + '.direct.txt');
    fs.writeFileSync(file, toCookieFile(cookies), { mode: 0o600 });
    this.update(host, { direct: file });
    return file;
  }

  /** Engine options for downloading a video file found on a page (sent like the page window would). */
  directArgs(direct) {
    const args = [];
    if (!direct) return args;
    if (direct.referer) args.push('--referer', direct.referer);
    if (direct.ua) args.push('--user-agent', direct.ua);
    if (direct.cookieFile && direct.cookieFile.startsWith(this.dir) && fs.existsSync(direct.cookieFile)) args.push('--cookies', direct.cookieFile);
    const s = this.get(hostOf(direct.mediaUrl)) || this.get(hostOf(direct.referer));
    if (s && s.impersonate && !s.impersonateUnavailable) args.push('--impersonate', /Firefox\//.test(direct.ua || '') ? 'firefox' : 'chrome');
    return args;
  }
}

const isCloudflare = (msg) => CLOUDFLARE.test(String(msg || ''));

const NEEDS_WINDOW_MS = 6 * 3600 * 1000;

module.exports = { Sites, hostOf, toCookieFile, isCloudflare };
