'use strict';
// Page scan, step 2: decide which link groups really are this creator's videos.
// Each likely group gets one link tested by the download engine. Groups that are downloadable
// videos by the same uploader are kept, together; everything else (menus, other creators,
// "related videos") is dropped.

const { nameKey, nameFromUrl } = require('./scanlogic');

/**
 * scan: { groups, name }  (from the crawler)
 * deps: { lookup(url) -> video info or throws, follow(items) -> items with real addresses, log, onProgress }
 * Returns { owner, videos } where owner is the engine's info for one video, or throws.
 */
async function chooseVideos(scan, url, { lookup, follow, log, onProgress, maxGroups = 6, uploaderOf }) {
  // Who uploaded a video: the engine's answer, or (when it doesn't know) whatever uploaderOf finds.
  const who = async (v) => (v.hasUploader === false && uploaderOf ? await uploaderOf(v) : (v.channelName || v.folder || null));
  const tested = [];
  const groups = scan.groups.slice(0, maxGroups);
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (onProgress) onProgress(`Checking which links are videos… (${gi + 1} of ${groups.length})`);
    let info = null, sample = null;
    // Try up to two links from the group (the first might be a dead one).
    for (const item of g.items.slice(0, 2)) {
      try {
        const [real] = await follow([item]);
        const v = await lookup(real.url);
        if (v && v.kind === 'video') { info = { ...v, who: await who(v) }; sample = real; break; }
      } catch { /* not a video */ }
    }
    tested.push({ g, info, sample });
    if (log) log.info(`Page scan: ${g.shape} (${g.items.length}) ${info ? 'are videos' : 'are not videos'}`);
  }
  const videoGroups = tested.filter((t) => t.info);
  if (!videoGroups.length) return { owner: null, videos: [] };

  // Whose profile is this? Prefer the uploader whose name matches the page or the link.
  const pageKeys = [nameKey(scan.name), nameKey(nameFromUrl(url))].filter((k) => k.length >= 3);
  const matchesPage = (t) => {
    const k = nameKey(t.info.who);
    return k && pageKeys.some((p) => p.includes(k) || k.includes(p));
  };
  const owner = (videoGroups.find(matchesPage) || videoGroups[0]).info;
  const ownerKey = nameKey(owner.who);
  const creatorKeys = [owner.who, scan.name, nameFromUrl(url)].map(nameKey).filter((k) => k.length >= 3);
  const share = (g) => {
    const withText = g.items.filter((it) => nameKey(it.ctx));
    if (!withText.length) return null; // tiles show no text at all
    return withText.filter((it) => creatorKeys.some((k) => nameKey(it.ctx).includes(k))).length / withText.length;
  };
  const ownerShare = share(videoGroups.find((t) => t.info === owner).g);
  const tilesNameCreator = ownerShare != null && ownerShare >= 0.5;
  // Keep a group if it's the creator's: by uploader name when known; otherwise by the names shown on
  // its tiles (if this site shows them); otherwise because the engine treats it the same as the creator's.
  const sameEngine = (t) => (t.info.folder || '') === (owner.folder || '') && (t.info.site || '') === (owner.site || '');
  const keep = videoGroups.filter((t) => {
    if (t.info === owner) return true;
    const k = nameKey(t.info.who);
    if (k && ownerKey) return k === ownerKey;
    if (tilesNameCreator) return (share(t.g) || 0) >= 0.5;
    return sameEngine(t);
  });
  if (log) for (const t of videoGroups) log.info(`Page scan: ${t.g.shape} uploader "${t.info.who || 'unknown'}" -> ${keep.includes(t) ? 'kept' : 'left out'}`);
  if (log) log.info(`Page scan: keeping ${keep.length} of ${videoGroups.length} video link groups (same uploader)`);

  // Follow every kept link to its real address and remove duplicates.
  const names = [owner.who, scan.name, nameFromUrl(url)].filter(Boolean);
  const all = [];
  const keys = names.map(nameKey).filter((k) => k.length >= 3);
  const mentions = (it) => keys.some((k) => nameKey(it.ctx).includes(k));
  for (const t of keep) {
    if (onProgress) onProgress('Following video links…');
    let items = t.g.items;
    const named = items.filter(mentions);
    // Some tiles name the creator and some don't: the others may be "related videos" from
    // someone else. Ask the engine about just those doubtful ones.
    if (named.length && named.length < items.length) {
      const doubtful = items.filter((it) => !mentions(it));
      const ok = new Set();
      for (const it of doubtful.slice(0, 40)) {
        if (onProgress) onProgress('Checking a few videos that may be someone else\'s…');
        try {
          const [real] = await follow([it]);
          const v = await lookup(real.url);
          const w = v && v.kind === 'video' ? await who(v) : null;
          // Keep it if it's the creator's, or if nobody can tell who made it.
          if (v && v.kind === 'video' && (!w || !ownerKey || nameKey(w) === ownerKey)) ok.add(it.url);
        } catch { /* not this creator's */ }
      }
      if (doubtful.length > 40) for (const it of doubtful.slice(40)) ok.add(it.url); // too many to check: keep the rest
      items = items.filter((it) => mentions(it) || ok.has(it.url));
      if (log) log.info(`Page scan: ${doubtful.length - (items.length - named.length)} video(s) by someone else left out`);
    }
    all.push(...await follow(items));
  }
  const seen = new Set();
  const videos = [];
  for (const v of all) {
    let key = v.url;
    try { const u = new URL(v.url); key = (u.host + u.pathname).replace(/\/+$/, '').toLowerCase(); } catch { /* keep raw */ }
    if (seen.has(key)) continue;
    seen.add(key);
    const { ctx, ...clean } = v;
    videos.push(clean);
  }
  if (log) log.info(`Page scan: ${videos.length} videos after removing duplicates`);
  return { owner, videos };
}

module.exports = { chooseVideos };
