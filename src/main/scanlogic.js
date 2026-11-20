'use strict';
// Pure helpers for Page scan (reading a profile page directly when yt-dlp can't)
// and for naming a creator folder from a link.

const { cleanName } = require('./naming');

// Path words that describe a section of a profile rather than the creator's name.
const SECTION_WORDS = /^(videos?|uploads?|posts?|media|shorts|streams?|live|playlists?|featured|page|pages|home|about|latest|newest|popular|top|all|sort|best|new|recent)$/i;

/** Best guess at a creator name from a profile link, e.g. /model/some_name/videos -> "some name". */
function nameFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const parts = u.pathname.split('/').map((p) => decodeURIComponent(p)).filter(Boolean)
    .filter((p) => !SECTION_WORDS.test(p) && !/^\d+$/.test(p));
  if (!parts.length) return null;
  const raw = parts[parts.length - 1].replace(/^@/, '').replace(/[_+]+/g, ' ').replace(/-+/g, ' ').trim();
  if (!raw) return null;
  return cleanName(raw.replace(/\b\w/g, (c) => c.toUpperCase()), null);
}

// Turn a path into a "shape" so links of the same kind group together:
// "/video-k3j2h/some-title" -> "/video-*/*"
function shapeOf(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  if (!segs.length) return '/';
  const first = segs[0].replace(/[0-9a-z]*\d[0-9a-z]*/gi, '*').replace(/(\*[-_]?)+/g, '*');
  return '/' + first + (segs.length > 1 ? '/' + Array(segs.length - 1).fill('*').join('/') : '');
}

/** For the log: the most common kinds of links on a page, e.g. "/video-*\/* x24". */
function summarise(links, pageUrl) {
  const counts = new Map();
  for (const l of links) {
    let u;
    try { u = new URL(l.href, pageUrl); } catch { continue; }
    const k = shapeOf(u.pathname);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} x${n}`).join(', ');
}

const VIDEO_HINT = /(video|watch|view|clip|movie|embed|\/v\/|\/v[-_]|play)/i;
// Site menus and section pages, never individual videos. Only the FIRST part of a link is checked
// ("/upload", "/search/..."), because real video links can contain these words further along.
const MENU_FIRST = /^(login|log-in|signin|sign-in|signup|sign-up|register|search|tags?|categor\w*|account|upload|premium|privacy|terms|tos|dmca|contact|help|faq|lang\w*|history|favou?rites?|settings|notifications|messages|subscriptions|feed|about|legal|cookies?|ads|advertis\w*)$/i;
const NOT_VIDEO_ANYWHERE = /([?&]page=|\/page\/\d|\.(jpe?g|png|gif|webp|css|js|xml|ico|svg)$)/i;
function isMenuLink(u) {
  const first = (u.pathname.split('/')[1] || '').toLowerCase();
  return MENU_FIRST.test(first) || NOT_VIDEO_ANYWHERE.test(u.pathname + u.search);
}
const HAS_ID = /\d/;

/**
 * links: [{ href, text, thumb }] collected from the page(s).
 * pageUrl: the profile link (links must be on the same site).
 * Returns the links that look like individual videos.
 */
/**
 * links: [{ href, text, thumb, ctx }] collected from the page(s).
 * Returns every group of same-shaped links that could be videos, best first:
 * [{ shape, score, items: [{ url, title, thumbnail, ctx }] }]
 * Which groups really are this creator's videos is decided later, by testing a link from each
 * group with the download engine.
 */
function candidateGroups(links, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch { return []; }
  const host = base.hostname.replace(/^www\./, '');
  const byHref = new Map();
  for (const l of links) {
    let u;
    try { u = new URL(l.href, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (u.hostname.replace(/^www\./, '') !== host) continue;
    u.hash = '';
    const key = u.origin + u.pathname + u.search;
    if (u.pathname === base.pathname) continue;
    if (isMenuLink(u)) continue;
    if (!HAS_ID.test(u.pathname + u.search)) continue;
    const prev = byHref.get(key);
    const text = (l.text || '').trim();
    if (!prev) byHref.set(key, { url: key, path: u.pathname + u.search, title: text, thumb: l.thumb || null, ctx: l.ctx || '' });
    else {
      if (text.length > prev.title.length) prev.title = text;
      if (!prev.thumb && l.thumb) prev.thumb = l.thumb;
      if (!prev.ctx && l.ctx) prev.ctx = l.ctx;
    }
  }
  const groups = new Map();
  for (const item of byHref.values()) {
    const shape = shapeOf(new URL(item.url).pathname);
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(item);
  }
  const out = [];
  for (const [shape, items] of groups) {
    const hinted = VIDEO_HINT.test(shape) || VIDEO_HINT.test(items[0].path);
    if (items.length < 2 && !hinted) continue;
    out.push({
      shape,
      score: items.length * (hinted ? 3 : 1),
      items: items.map((i) => ({ url: i.url, title: i.title || titleFromPath(i.path), thumbnail: i.thumb, ctx: i.ctx }))
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The single most likely group (used when the engine can't be asked, and in quick checks). */
function pickVideoLinks(links, pageUrl) {
  const best = candidateGroups(links, pageUrl).find((g) => g.items.length >= 2);
  return best ? best.items.map(({ ctx, ...v }) => v) : [];
}

/** "Roberta_Ruiva", "robertaruiva", "Roberta Ruiva" -> "robertaruiva", for loose name matching. */
function nameKey(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

/**
 * Within a group, drop videos whose tile clearly belongs to someone else (e.g. "related videos"),
 * but only when most tiles in the group name the creator, so it's safe to judge by that.
 */
function keepCreatorTiles(items, creatorNames) {
  const keys = creatorNames.map(nameKey).filter((k) => k.length >= 3);
  if (!keys.length) return items;
  const mentions = (it) => keys.some((k) => nameKey(it.ctx).includes(k));
  const named = items.filter(mentions);
  return named.length >= Math.ceil(items.length * 0.6) ? named : items;
}

function titleFromPath(p) {
  const seg = p.split('?')[0].split('/').filter(Boolean).pop() || 'Video';
  return seg.replace(/[-_]+/g, ' ').replace(/\b\d{5,}\b/g, '').trim() || 'Video';
}

// ---------- uploader name from a video page ----------
function decodeEntities(t) {
  return String(t).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function stripTags(t) { return decodeEntities(String(t).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function plausibleName(t) {
  const s = stripTags(t);
  return s && s.length >= 2 && s.length <= 60 && !/^(home|videos?|upload|subscribe|follow|profile|channel|more|share)$/i.test(s) ? s : null;
}

/** Look for who uploaded a video in its page: structured data first, then common page markers. */
function uploaderFromHtml(html) {
  if (!html) return null;
  // Structured data (JSON-LD): "author"/"creator"/"uploader" with a name.
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
    for (const it of items) {
      for (const key of ['author', 'creator', 'uploader']) {
        let v = it && it[key];
        if (Array.isArray(v)) v = v[0];
        const name = typeof v === 'string' ? v : v && v.name;
        if (plausibleName(name || '')) return plausibleName(name);
      }
    }
  }
  // <meta name="author" content="...">
  let m = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i);
  if (m && plausibleName(m[1])) return plausibleName(m[1]);
  // itemprop="author" ... itemprop="name" or a link marked as the uploader/author/owner/channel.
  m = html.match(/itemprop=["']author["'][\s\S]{0,300}?itemprop=["']name["'][^>]*(?:content=["']([^"']+)["']|>([^<]+)<)/i);
  if (m && plausibleName(m[1] || m[2])) return plausibleName(m[1] || m[2]);
  m = html.match(/<a[^>]+(?:class|itemprop|data-[\w-]+)=["'][^"']*\b(?:uploader|author|owner|creator|channel-name|channel_name|profile-name|user-name|username)\b[^"']*["'][^>]*>([\s\S]{1,200}?)<\/a>/i);
  if (m && plausibleName(m[1])) return plausibleName(m[1]);
  m = html.match(/class=["'][^"']*\b(?:uploader|video-uploader|author-name|owner-name|channel-name)\b[^"']*["'][^>]*>([\s\S]{1,200}?)<\//i);
  if (m && plausibleName(m[1])) return plausibleName(m[1]);
  return null;
}

// ---------- scripts that run inside the scanned page ----------

// Gather links, the next-page link and a name for the creator.
const COLLECT = String.raw`(() => {
  const abs = (h) => { try { return new URL(h, location.href).href; } catch { return null; } };
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = abs(a.getAttribute('href'));
    if (!href) continue;
    const img = a.querySelector('img');
    const text = (a.getAttribute('title') || (img && img.getAttribute('alt')) || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const thumb = img ? (img.getAttribute('data-src') || img.getAttribute('data-thumb_url') || img.currentSrc || img.src || null) : null;
    // The text of the tile the link sits in (often includes the uploader's name).
    // Climb to the video's own tile, but never into a box that holds other videos' links.
    let tile = a.parentElement;
    const distinct = (el) => new Set([...el.querySelectorAll('a[href]')].map((x) => x.getAttribute('href'))).size;
    for (let up = 0; up < 4 && tile && tile.parentElement && distinct(tile.parentElement) <= 1; up++) tile = tile.parentElement;
    const ctx = tile ? (tile.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240) : '';
    links.push({ href, text, thumb: thumb && /^https?:/.test(thumb) ? thumb : null, ctx });
  }
  let next = null;
  const rel = document.querySelector('link[rel="next"], a[rel="next"]');
  if (rel) next = abs(rel.getAttribute('href'));
  if (!next) {
    for (const a of document.querySelectorAll('a[href]')) {
      const t = (a.textContent || '').trim().toLowerCase();
      const raw = a.getAttribute('href') || '';
      const cls = (typeof a.className === 'string' ? a.className : '') + ' ' + (a.parentElement && typeof a.parentElement.className === 'string' ? a.parentElement.className : '');
      if (/^(next|next page|›|»|>|→)$/.test(t) || /(^|[\s_-])next([\s_-]|$)/i.test(cls) || a.getAttribute('aria-label') === 'Next') {
        const h = abs(raw);
        if (h && h !== location.href && !/^(javascript:|#)/i.test(raw)) { next = h; break; }
      }
    }
  }
  // A "Next" that's really a button (loads more videos by script, address doesn't change).
  let nextButton = false;
  if (!next) {
    for (const el of document.querySelectorAll('a, button, [role="button"], li, span')) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (/^(next|next page|›|»|→|load more|show more|more videos)$/.test(t) && el.offsetParent !== null && !el.closest('[disabled], .disabled')) { nextButton = true; break; }
    }
  }
  // Numbered page links (1 2 3 … 23) on this site, and which page we're on.
  const numbered = [];
  let current = null;
  for (const el of document.querySelectorAll('a, span, li, strong, em, b, button')) {
    if (el.children.length > 1) continue;
    const t = (el.textContent || '').trim();
    if (!/^\d{1,4}$/.test(t)) continue;
    const n = Number(t);
    const cls = ((typeof el.className === 'string' ? el.className : '') + ' ' + (el.parentElement && typeof el.parentElement.className === 'string' ? el.parentElement.className : '')).toLowerCase();
    const isCurrent = el.getAttribute('aria-current') === 'page' || /(^|[\s_-])(active|current|selected)([\s_-]|$)/.test(cls);
    if (el.tagName === 'A' && el.getAttribute('href')) {
      const h = abs(el.getAttribute('href'));
      if (h && new URL(h).hostname === location.hostname && !/^(javascript:|#)/i.test(el.getAttribute('href'))) {
        numbered.push({ n, href: h });
        if (isCurrent || h === location.href) current = current || n;
      }
    } else if (isCurrent && n > 0) current = current || n;
  }
  const h1 = document.querySelector('h1');
  return { links, next, nextButton, numbered, current, h1: h1 ? h1.textContent.trim() : '', title: document.title || '', at: location.href };
})()`;

// Click a script-driven "Next" / "Load more" button.
const CLICK_NEXT = String.raw`(() => {
  for (const el of document.querySelectorAll('a, button, [role="button"], li, span')) {
    const t = (el.textContent || '').trim().toLowerCase();
    if (/^(next|next page|›|»|→|load more|show more|more videos)$/.test(t) && el.offsetParent !== null && !el.closest('[disabled], .disabled')) {
      const target = el.querySelector('a, button') || el;
      target.click();
      return true;
    }
  }
  return false;
})()`;

// Click past "are you 18/21?" and "enter site" style popups, the way a person would.
// Only clicks buttons inside a popup/overlay, never "leave", "reject" or links to other sites.
const AGE_CLICK = String.raw`(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const inPopup = (el) => {
    for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const id = ((p.id || '') + ' ' + (typeof p.className === 'string' ? p.className : '')).toLowerCase();
      if (cs.position === 'fixed' || cs.position === 'sticky' || p.getAttribute('role') === 'dialog' || p.getAttribute('aria-modal') === 'true' ||
          /(modal|popup|overlay|age|disclaimer|gate|consent|verif|warning|cookie|splash|enter)/.test(id)) return true;
    }
    return false;
  };
  // Some sites put the age check on its own page instead of a popup.
  const gatePage = /(18|21)\s*(\+|years|or older|and over)|age verification|adult content|you must be/i.test(document.body ? document.body.innerText.slice(0, 3000) : '') &&
    document.querySelectorAll('a[href]').length < 40;
  const textOf = (el) => (el.value || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const scored = [];
  for (const el of document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
    if (!visible(el) || !(gatePage || inPopup(el))) continue;
    const t = textOf(el);
    if (!t || t.length > 80) continue;
    let s = 0;
    if (/\b(18|21)\b/.test(t)) s += 5;
    if (/\benter\b/i.test(t)) s += 3;
    if (/\b(i agree|agree|accept|yes|continue|confirm|ok)\b/i.test(t)) s += 2;
    if (/\b(leave|exit|under|reject|decline|refuse|manage|settings|preferences|cancel|close|no)\b/i.test(t)) s = -1;
    if (el.tagName === 'A') {
      const h = (el.getAttribute('href') || '').trim();
      if (h && !/^(#|javascript:)/i.test(h)) {
        try {
          const to = new URL(h, location.href);
          if (to.hostname !== location.hostname) s = -1;                  // another site
          else if (!gatePage && to.pathname !== location.pathname) s = -1; // a popup button doesn't lead to another page
        } catch (e) { s = -1; }
      }
    }
    if (s > 0) scored.push({ el, t, s });
  }
  scored.sort((a, b) => b.s - a.s);
  if (!scored.length) return null;
  scored[0].el.click();
  return scored[0].t.slice(0, 60);
})()`;

module.exports = { uploaderFromHtml, nameFromUrl, pickVideoLinks, candidateGroups, nameKey, keepCreatorTiles, shapeOf, titleFromPath, summarise, isMenuLink, COLLECT, AGE_CLICK, CLICK_NEXT };
