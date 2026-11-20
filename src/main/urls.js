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

module.exports = { extractLinks, youtubeChannelBase, youtubeTabs, siteName };
