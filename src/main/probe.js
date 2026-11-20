'use strict';
// Looks a link up before downloading: is it one video, or a channel/profile/playlist?

const { run } = require('./util');
const { creatorFolderName, cleanName } = require('./naming');
const { nameFromUrl } = require('./scanlogic');
const { youtubeChannelBase, youtubeTabs, siteName } = require('./urls');

function bestThumb(info) {
  if (info.thumbnail) return info.thumbnail;
  const list = Array.isArray(info.thumbnails) ? info.thumbnails.filter((t) => t && t.url) : [];
  if (!list.length) return null;
  // Prefer a medium-sized one: big enough to look good, small enough to load fast.
  const sized = list.filter((t) => t.width && t.width >= 320 && t.width <= 1280);
  return (sized[sized.length - 1] || list[list.length - 1]).url;
}

function normaliseVideo(info) {
  const heights = [...new Set((info.formats || []).map((f) => f.height).filter((h) => Number.isFinite(h) && h > 0))].sort((a, b) => b - a);
  return {
    kind: 'video',
    url: info.webpage_url || info.original_url || info.url,
    id: info.id,
    extractor: info.extractor_key || info.ie_key || '',
    site: siteName(info),
    title: info.title || info.fulltitle || info.id || 'Untitled',
    folder: creatorFolderName(info),
    channelName: info.channel || info.uploader || info.creator || info.artist || '',
    hasUploader: !!(info.channel || info.uploader || info.creator || info.artist),
    duration: Number.isFinite(info.duration) ? info.duration : null,
    thumbnail: bestThumb(info),
    uploadDate: info.upload_date || null,
    heights,
    isLive: !!info.is_live
  };
}

function normaliseEntry(e, parent) {
  const url = e.url && /^https?:/i.test(e.url) ? e.url : (e.webpage_url || (parent.extractor === 'YoutubeTab' || /youtube/i.test(e.ie_key || '') ? `https://www.youtube.com/watch?v=${e.id}` : e.url));
  return {
    id: e.id,
    url,
    extractor: e.ie_key || parent.extractor,
    title: e.title || e.id || 'Untitled',
    duration: Number.isFinite(e.duration) ? e.duration : null,
    uploadDate: e.upload_date || (e.timestamp ? new Date(e.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, '') : null),
    thumbnail: bestThumb(e),
    isLive: e.live_status === 'is_live',
    // Playlists can mix uploaders: each video then goes to its own uploader's folder.
    folder: (e.channel || e.uploader) ? creatorFolderName({ channel: e.channel, uploader: e.uploader }) : null
  };
}

function looksLikeList(e) {
  return e && (e._type === 'playlist' || (e._type === 'url' && /Tab|Playlist|Channel|User/.test(e.ie_key || '') && !e.duration));
}

class Prober {
  constructor({ engine, log, sites }) {
    this.engine = engine;
    this.log = log;
    this.sites = sites || null; // per-site extras (Cloudflare); optional
  }

  async dump(url, { flat = true, onLine, cookiesBrowser, retried = false } = {}) {
    const args = [...this.engine.baseArgs(), '-J', '--no-playlist', '--no-warnings'];
    if (flat) args.push('--flat-playlist');
    const siteArgs = this.sites ? this.sites.argsFor(url) : [];
    // A saved Cloudflare pass already carries the cookies for this site.
    if (cookiesBrowser && cookiesBrowser !== 'none' && !siteArgs.includes('--cookies')) args.push('--cookies-from-browser', cookiesBrowser);
    args.push(...siteArgs);
    args.push('--', url);
    const r = await run(this.engine.ytdlp, args, { timeout: 15 * 60 * 1000, env: this.engine.env(), onLine: onLine ? (l) => { if (!l.startsWith('{')) onLine(l); } : null });
    if (r.code !== 0 || !r.stdout.trim().startsWith('{')) {
      const err = (r.stderr.split('\n').filter((l) => /ERROR/.test(l)).pop() || r.stderr.trim().split('\n').pop() || 'Could not read that link').replace(/^ERROR:\s*/, '');
      // Cloudflare: try once more connecting like a normal browser (remembered for this site).
      if (!retried && this.sites && this.sites.noteBlocked(url, err)) return this.dump(url, { flat, onLine, cookiesBrowser, retried: true });
      throw new Error(err);
    }
    return JSON.parse(r.stdout);
  }

  /** One call to see what the link is. Returns a video, or a list summary. */
  async lookup(url, opts = {}) {
    this.log.info(opts.quiet ? 'Looking up a link (private mode)' : 'Looking up ' + url);
    const ytBase = youtubeChannelBase(url);
    if (ytBase) return this.lookupList(url, { ...opts, include: opts.include || { videos: true, shorts: false, streams: false } });
    const info = await this.dump(url, opts);
    if (info._type === 'playlist' || Array.isArray(info.entries)) return this.listFromInfo(url, info, opts);
    return normaliseVideo(info);
  }

  async lookupList(url, opts = {}) {
    const ytBase = youtubeChannelBase(url);
    const include = opts.include || { videos: true, shorts: false, streams: false };
    if (ytBase) {
      const tabs = youtubeTabs(ytBase, include);
      const merged = { kind: 'list', url: ytBase, isYouTubeChannel: true, include, entries: [], title: '', folder: '', site: 'YouTube', extractor: 'Youtube', thumbnail: null };
      for (const tab of tabs) {
        let info;
        try { info = await this.dump(tab.url, opts); } catch (e) {
          // A channel with no Shorts or no streams just has no such tab.
          this.log.warn(`${tab.key}: ${e.message}`);
          continue;
        }
        const part = await this.listFromInfo(tab.url, info, opts);
        if (!merged.title) Object.assign(merged, { title: part.title, folder: part.folder, thumbnail: part.thumbnail, channelName: part.channelName });
        for (const e of part.entries) { e.tab = tab.key; merged.entries.push(e); }
      }
      if (!merged.title) throw new Error('Could not read that channel. Check the link, or untick Shorts/Livestreams if the channel has none.');
      return merged;
    }
    const info = await this.dump(url, opts);
    return this.listFromInfo(url, info, opts);
  }

  async listFromInfo(url, info, opts) {
    const parent = { extractor: info.extractor_key || '' };
    let raw = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
    // Some sites return a list of lists (e.g. a profile split into sections). Open them one level down.
    const nested = raw.filter(looksLikeList);
    if (nested.length && nested.length === raw.length) {
      const flat = [];
      for (const sub of nested.slice(0, 12)) {
        if (Array.isArray(sub.entries)) { flat.push(...sub.entries.filter(Boolean)); continue; }
        try {
          const inner = await this.dump(sub.url, opts);
          flat.push(...(inner.entries || []).filter(Boolean));
        } catch (e) { this.log.warn('Skipped a section: ' + e.message); }
      }
      raw = flat;
    }
    const seen = new Set();
    const entries = [];
    for (const e of raw) {
      if (looksLikeList(e)) continue;
      const n = normaliseEntry(e, parent);
      if (!n.url || seen.has(n.id || n.url)) continue;
      seen.add(n.id || n.url);
      entries.push(n);
    }
    // Folder rule: the same uploader always gets the same folder, whether you grab one video or the
    // whole channel. Sites don't always name the uploader on a list, so ask the first video, exactly
    // the way a single download is named.
    let channelName = info.channel || info.uploader || info.playlist_uploader || '';
    let folder = null;
    const isYouTube = /youtube/i.test(parent.extractor);
    if (entries.length && !(isYouTube && channelName)) {
      try {
        const first = normaliseVideo(await this.dump(entries[0].url, { flat: false, cookiesBrowser: opts && opts.cookiesBrowser }));
        if (first.hasUploader) { folder = first.folder; channelName = first.channelName; }
        if (!entries[0].duration && first.duration) entries[0].duration = first.duration;
      } catch (e) { this.log.warn('Could not check the first video for the uploader name: ' + e.message); }
    }
    if (!folder) folder = channelName ? creatorFolderName({ channel: channelName }) : (nameFromUrl(url) || cleanName(info.title, 'Other'));
    // A list of one uploader: every video uses the list's folder.
    if (!isYouTube || /youtube\.com\/(@|channel\/|c\/|user\/)/i.test(url)) for (const e of entries) e.folder = folder;
    const title = channelName || nameFromUrl(url) || String(info.title || folder).replace(/ - (Videos|Shorts|Live|Streams)$/i, '');
    return {
      kind: 'list',
      url,
      title,
      channelName,
      folder,
      site: siteName(info),
      extractor: parent.extractor,
      thumbnail: bestThumb(info),
      entries
    };
  }
}

module.exports = { Prober, normaliseVideo, normaliseEntry };
