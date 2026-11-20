'use strict';
// Recognising links.

function extractLinks(text) {
  const found = String(text || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (let u of found) {
    u = u.replace(/[),.;\]]+$/, '');
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

// A YouTube channel's home page (not a single tab like /videos).
const YT_CHANNEL = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)\/?(?:[?#].*)?$/i;
const YT_TAB = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)\/(videos|shorts|streams|live|featured|playlists)\/?/i;

function youtubeChannelBase(url) {
  let m = String(url).match(YT_CHANNEL);
  if (m) return `https://www.youtube.com/${m[1]}`;
  m = String(url).match(YT_TAB);
  if (m && /^(videos|shorts|streams|live|featured)$/i.test(m[2])) return `https://www.youtube.com/${m[1]}`;
  return null;
}

function youtubeTabs(base, include) {
  const tabs = [];
  if (include.videos) tabs.push({ key: 'videos', url: `${base}/videos` });
  if (include.shorts) tabs.push({ key: 'shorts', url: `${base}/shorts` });
  if (include.streams) tabs.push({ key: 'streams', url: `${base}/streams` });
  return tabs;
}

function siteName(info) {
  const key = (info && (info.extractor_key || info.ie_key || info.extractor)) || '';
  const clean = String(key).replace(/(Tab|Playlist|User|Channel|Search|Video|IE)$/,'').replace(/:.*/, '');
  const known = { Youtube: 'YouTube', TikTok: 'TikTok', Twitter: 'X', Vimeo: 'Vimeo', Twitch: 'Twitch', TwitchVod: 'Twitch',
    Instagram: 'Instagram', Facebook: 'Facebook', Reddit: 'Reddit', Dailymotion: 'Dailymotion', Soundcloud: 'SoundCloud', Bandcamp: 'Bandcamp' };
  return known[clean] || clean || 'Web';
}

/**
 * Does this link point at one video (not a channel, profile or playlist)?
 * Used so a single video never opens as a list of everything on its page.
 */
function looksLikeVideo(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const p = u.pathname.toLowerCase();
  if (/(^|\.)youtu\.be$/i.test(u.hostname)) return p.length > 1;
  // Clear signs of a single video.
  if (u.searchParams.has('v')) return true;
  if (/\/(video|watch|status|shorts|reel|clip)\/[^/]+/.test(p)) return true;
  // Channels, profiles, playlists and other lists.
  if (/\/(playlist|playlists|channel|channels|user|users|c|profile|profiles|model|models|creator|creators|series|collection|collections|category|categories|tag|tags|search)(\/|$)/.test(p)) return false;
  if (/^\/@/.test(p)) return false;
  // Weaker signs.
  if (/\/(v|embed|clips|reels|live|p)\/[^/]+/.test(p)) return true;
  if (/\/videos\/\d+/.test(p)) return true;
  if (/^\/\d{5,}\/?$/.test(p)) return true;
  return /\.(mp4|webm|mov|m4v|mkv|m3u8)$/.test(p);
}

module.exports = { looksLikeVideo, extractLinks, youtubeChannelBase, youtubeTabs, siteName };
