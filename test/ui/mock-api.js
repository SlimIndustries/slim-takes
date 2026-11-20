// Stand-in for the Electron bridge, so the window can be rendered in a normal browser for checks.
(function () {
  const params = new URLSearchParams(location.search);
  const listeners = {};
  const now = Date.now();
  const settings = {
    folder: 'C:\\Users\\Slim\\Videos\\SlimTakes', format: 'mp4', quality: '1080', concurrent: 3, speedLimitMB: 0, polite: true, retries: 2,
    minFreeGB: 10, whenDone: 'nothing', sponsorblock: true, subs: false, embed: true, setFileDate: true, cover: false, cookiesBrowser: 'none',
    notifyWindows: true, discordWebhook: '', blurThumbs: false, clearHistoryOnClose: false, tray: true, startWithWindows: false,
    watchInterval: '2h', theme: params.get('theme') || 'crimson', customAccent: '#33ccaa', clipboardWatch: true, checkAppUpdates: true,
    autoUpdateEngine: true, hasPin: params.get('locked') === '1'
  };
  const queue = [
    { id: 'a', title: 'Jimmy Edges The Driveway', folder: 'Jimmy The Lawn Guy', format: 'mp4', quality: '1080', status: 'downloading', pct: 72.4, speed: 7.2e6, eta: 33, downloaded: 612e6, total: 850e6, addedAt: now - 5000 },
    { id: 'b', title: 'Full Backyard Makeover (Part 2)', folder: 'Jimmy The Lawn Guy', format: 'mp4', quality: '1080', status: 'downloading', pct: 38, speed: 6.1e6, eta: 120, downloaded: 410e6, total: 1.1e9, addedAt: now - 4000 },
    { id: 'c', title: 'Lo-fi Beats To Mow To', folder: 'Chill Tapes', format: 'mp3', quality: '1080', status: 'processing', pct: 100, note: 'Finishing up…', addedAt: now - 3000 },
    { id: 'd', title: 'Mountain Bike Trail POV', folder: 'Trailside', format: 'mov', quality: '2160', status: 'waiting', pct: 0, addedAt: now - 2000 },
    { id: 'e', title: 'Desert Canyon Descent', folder: 'Trailside', format: 'mp4', quality: '1080', status: 'failed', error: 'Age-restricted. Turn on "Use browser login" in Settings (be logged in on that browser).', addedAt: now - 1000 },
    { id: 'f', title: 'Jimmy Cuts Grass', folder: 'Jimmy The Lawn Guy', format: 'mp4', quality: '1080', status: 'done', pct: 100, filePath: 'C:\\Users\\Slim\\Videos\\SlimTakes\\Jimmy The Lawn Guy\\Jimmy Cuts Grass.mp4', addedAt: now - 100 },
    { id: 'g', title: 'Leaf Blower Showdown', folder: 'Jimmy The Lawn Guy', format: 'mp4', quality: '1080', status: 'skipped', note: 'Already have (same title and length)', addedAt: now - 50 }
  ];
  const entries = [];
  const titles = ['Jimmy Cuts Grass', 'Jimmy Edges The Driveway', 'Full Backyard Makeover (Part 2)', 'Full Backyard Makeover (Part 1)', 'Jimmy Cuts Grass', 'Leaf Blower Showdown', 'Mulch Day', 'Hedge Trim Speedrun'];
  for (let i = 0; i < 40; i++) entries.push({ id: 'e' + i, url: 'https://www.youtube.com/watch?v=e' + i, title: titles[i % titles.length] + (i >= 8 ? ' #' + i : ''),
    duration: 300 + i * 37, uploadDate: '2026' + String(11 - Math.floor(i / 4)).padStart(2, '0') + String(28 - (i % 4) * 7).padStart(2, '0'), have: i === 3 || i === 5 ? 'have' : i === 4 ? 'sametitle' : 'new', estimate: (300 + i * 37) * 562500 });
  const grab = { kind: 'list', url: 'https://www.youtube.com/@JimmyTheLawnGuy', isYouTubeChannel: true, title: 'Jimmy The Lawn Guy', folder: 'Jimmy The Lawn Guy', site: 'YouTube', extractor: 'Youtube', entries, watched: false };
  const video = { kind: 'video', url: 'https://www.youtube.com/watch?v=abc', id: 'abc', extractor: 'Youtube', site: 'YouTube', title: 'Jimmy Cuts Grass', folder: 'Jimmy The Lawn Guy', channelName: 'Jimmy The Lawn Guy', duration: 768, heights: [2160, 1440, 1080, 720], have: 'new' };
  const watch = { channels: [
    { id: 'w1', name: 'Jimmy The Lawn Guy', site: 'YouTube', format: 'mp4', quality: '1080', enabled: true, lastChecked: now - 14 * 60000, lastNew: 2, downloaded: 177 },
    { id: 'w2', name: 'Chill Tapes', site: 'YouTube', format: 'mp3', quality: '1080', enabled: true, lastChecked: now - 14 * 60000, lastNew: 0, downloaded: 64 },
    { id: 'w3', name: 'Trailside', site: 'Vimeo', format: 'mov', quality: '2160', enabled: false, lastChecked: now - 86400e3, lastNew: 0, downloaded: 23, lastError: null }
  ], status: { checking: false, lastRun: now - 14 * 60000, nextRun: now + 106 * 60000, interval: '2h' } };
  const history = [
    { id: 'h1', title: 'Jimmy Cuts Grass', folder: 'Jimmy The Lawn Guy', site: 'YouTube', format: 'mp4', quality: '1080', size: 310e6, filePath: 'C:\\x\\a.mp4', status: 'done', at: now - 3600e3 },
    { id: 'h2', title: 'Rainy Night Jazz Mix', folder: 'Chill Tapes', site: 'YouTube', format: 'mp3', quality: '1080', size: 98e6, filePath: 'C:\\x\\b.mp3', status: 'done', at: now - 86400e3 },
    { id: 'h3', title: 'Desert Canyon Descent', folder: 'Trailside', site: 'Vimeo', format: 'mov', quality: '2160', status: 'failed', error: 'The site refused the download (403). Update the engine in Settings and retry.', at: now - 2 * 86400e3 }
  ];
  const engineReady = params.get('setup') !== '1';
  window.slim = {
    init: async () => ({ locked: params.get('locked') === '1', version: '1.2.0', settings, engine: { ytdlp: engineReady, ffmpeg: engineReady, deno: engineReady, ready: engineReady }, queue, paused: false, watch, freeBytes: 412e9 }),
    verifyPin: async () => false, setPin: async () => settings,
    setSettings: async (p) => Object.assign(settings, p),
    engineStatus: async () => ({ ready: true }), installEngine: () => new Promise(() => {
      setTimeout(() => (listeners['engine:step'] || []).forEach((f) => f({ part: 'ytdlp', label: 'Downloading yt-dlp', got: 18e6, total: 18e6 })), 50);
      setTimeout(() => (listeners['engine:step'] || []).forEach((f) => f({ part: 'ffmpeg', label: 'Downloading ffmpeg', got: 61e6, total: 140e6 })), 100);
    }),
    updateEngine: async () => ({ ok: true, message: 'Already up to date' }), engineVersion: async () => '2026.11.01',
    extractLinks: async (t) => (t.match(/https?:\/\/\S+/g) || []),
    lookup: async (u) => { if (/scanfail/.test(u)) throw new Error("Error invoking remote method 'lookup': Error: Page scan couldn't find any videos on that page. Try \"Open the page\": click past any popups yourself, then press Scan now."); return /@|maker/.test(u) ? grab : video; }, lookupList: async () => grab, pageScan: async () => ({ ...grab, scanned: true }), pageScanOpen: async () => true, pageScanVisible: async () => ({ ...grab, scanned: true }), pageScanCancel: async () => {},
    queueAdd: async () => [], queueAction: async () => true, pauseAll: async () => {}, resumeAll: async () => {}, clearFinished: async () => {}, cancelAll: async () => 4, queueList: async () => queue,
    history: async () => history, historyRemove: async () => {}, historyClear: async () => {},
    watchGet: async () => watch, watchAdd: async () => 'x', watchAddUrl: async () => 'x', watchRemove: async () => {}, watchUpdate: async () => {}, watchCheckNow: async () => 0,
    chooseFolder: async () => null, importLinks: async () => null, openFile: async () => '', showFile: async () => {}, fileExists: async () => true, openFolder: async () => '', openExternal: async () => {}, pathForFile: () => null,
    log: async () => '[2026-11-20 05:00:00] INFO Slim Takes 1.0.0 starting', openLogFolder: async () => {}, power: async () => true, checkUpdate: async () => ({}), diskFree: async () => 412e9,
    pageScanUseBrowser: async (u, b) => { if (b === 'chrome') throw new Error("Error invoking remote method 'pageScan:useBrowser': Error: Chrome locks its cookies so other apps can't read them (Chrome, Edge and Brave do this now). Firefox works best for this: pick Firefox, tick the box there, then press Done."); return { ok: true, browser: 'Firefox' }; },
    on: (ev, fn) => { (listeners[ev] ||= []).push(fn); return () => { listeners[ev] = listeners[ev].filter((f) => f !== fn); }; },
    _emit: (ev, ...a) => (listeners[ev] || []).forEach((f) => f(...a)),
    _grab: grab, _video: video
  };
})();
