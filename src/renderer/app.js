'use strict';
/* Slim Takes — window logic. Plain JavaScript, no frameworks. */

const api = window.slim;

// ---------------------------------------------------------------- helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  grab: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 4v5"/>',
  watch: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  retry: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'
};
function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}
function iconBtn(name, label, onclick, cls = '') {
  return h('button', { type: 'button', class: 'btn icon ' + cls, 'aria-label': label, title: label, onclick }, icon(name, 16));
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
function fmtDur(sec) {
  if (!sec && sec !== 0) return '—';
  sec = Math.round(sec);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
}
function fmtEta(sec) {
  if (sec == null) return '';
  if (sec < 60) return Math.max(1, Math.round(sec)) + 's left';
  if (sec < 3600) return Math.round(sec / 60) + 'm left';
  return (sec / 3600).toFixed(1) + 'h left';
}
function fmtDate(ymd) {
  if (!ymd || !/^\d{8}$/.test(ymd)) return '—';
  const d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtWhen(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 0) {
    const m = Math.round(-diff / 60000);
    return m < 60 ? `in ${m}m` : `in ${Math.floor(m / 60)}h ${m % 60}m`;
  }
  if (diff < 60000) return 'just now';
  if (diff < 3600e3) return Math.round(diff / 60000) + ' minutes ago';
  if (diff < 86400e3) return Math.round(diff / 3600e3) + ' hours ago';
  const days = Math.round(diff / 86400e3);
  return days === 1 ? '1 day ago' : days < 30 ? days + ' days ago' : new Date(ms).toLocaleDateString();
}
function toast(msg, ms = 4000) {
  const t = h('div', { class: 'toast', text: msg });
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
function fileUrl(p) { return 'slimfile://' + encodeURIComponent(p); }
const PLAYABLE = /\.(mp4|webm|m4a|mp3|opus|wav|flac|mov)$/i;

const FORMATS = [
  ['mp4', 'MP4'], ['mkv', 'MKV'], ['mov', 'MOV'], ['webm', 'WebM'], ['avi', 'AVI (slow, converts)'],
  ['mp3', 'MP3 (audio)'], ['m4a', 'M4A (audio)'], ['flac', 'FLAC (audio)'], ['wav', 'WAV (audio)'], ['opus', 'Opus (audio)']
];
const QUALITIES = [['best', 'Best available'], ['2160', '4K'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']];
const AUDIO = new Set(['mp3', 'm4a', 'flac', 'wav', 'opus']);
function qualityLabel(q) { return (QUALITIES.find((x) => x[0] === q) || [q, q + 'p'])[1]; }
function formatLabel(f) { return (FORMATS.find((x) => x[0] === f) || [f, f.toUpperCase()])[1].replace(/ \(.*\)/, ''); }

function select(options, value, onchange, attrs = {}) {
  return h('select', { class: 'input', ...attrs, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

// ---------------------------------------------------------------- state
const state = {
  view: 'downloads',
  settings: {},
  engine: {},
  version: '',
  items: [],            // queue, in order
  paused: false,
  private: false,
  pasteText: '',
  pasteFormat: null,
  pasteQuality: null,
  preview: null,        // looked-up single video
  previewOpts: null,
  busy: null,           // text while looking something up
  grab: { url: '', result: null, loading: false, error: null, include: { videos: true, shorts: false, streams: false },
    selected: new Set(), filters: { newest: 'all', date: 'any', from: '', to: '', length: 'any', min: '', max: '' },
    format: null, quality: null, addWatch: true, pending: [], showCount: 300 },
  watch: { channels: [], status: {} },
  watchUrl: '',
  history: [],
  histTab: 'all',
  histSearch: '',
  freeBytes: null,
  update: null,
  clipLinks: null
};

function applyTheme() {
  const t = window.SlimThemes.themeVars(state.settings.theme, state.settings.customAccent);
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(t)) if (k !== 'name') root.setProperty('--' + k, v);
  document.body.classList.toggle('blurthumbs', !!state.settings.blurThumbs);
}

async function saveSettings(patch) {
  state.settings = await api.setSettings(patch);
  applyTheme();
  return state.settings;
}

// ---------------------------------------------------------------- boot
async function boot() {
  const init = await api.init();
  state.settings = init.settings;
  state.version = init.version;
  applyTheme();
  if (init.locked) return renderLock();
  afterUnlock(init);
}

async function afterUnlock(init) {
  if (!init || init.locked) init = await api.init();
  state.settings = init.settings;
  state.engine = init.engine;
  state.items = init.queue;
  state.paused = init.paused;
  state.watch = init.watch || state.watch;
  state.freeBytes = init.freeBytes;
  applyTheme();
  wireEvents();
  if (!state.engine.ready) return renderSetup();
  renderShell();
}

let wired = false;
function wireEvents() {
  if (wired) return;
  wired = true;
  api.on('queue:item', (it) => {
    const i = state.items.findIndex((x) => x.id === it.id);
    if (i >= 0) state.items[i] = it; else state.items.push(it);
    updateQueueItem(it);
    updateBadge();
  });
  api.on('queue:list', (list) => { state.items = list; if (state.view === 'downloads') renderQueue(); updateBadge(); });
  api.on('queue:state', (s) => { state.paused = s.paused; if (state.view === 'downloads') renderQueue(); });
  api.on('queue:idle', ({ finished, whenDone }) => {
    toast(`All done — ${finished} download${finished === 1 ? '' : 's'} finished`);
    if (whenDone && whenDone !== 'nothing') whenDoneCountdown(whenDone);
    refreshFree();
  });
  api.on('queue:diskLow', (free) => toast(`Downloads paused: only ${fmtBytes(free)} left on the drive.`, 8000));
  api.on('queue:onlyPreviews', ({ host, count }) => toast(`${host || 'A site'} is only giving previews, not full videos, so ${count} download${count === 1 ? ' was' : 's were'} paused. It may need you to be logged in.`, 15000));
  api.on('queue:notVideos', ({ host, count }) => toast(`${host || 'A site'} is sending web pages instead of videos, so ${count} download${count === 1 ? ' was' : 's were'} paused. It may need you to be logged in. Check a video in your browser, then press Resume all to try again.`, 15000));
  api.on('queue:needsPass', ({ host, count }) => toast(`${count} download${count === 1 ? '' : 's'} from ${host || 'a site'} ${count === 1 ? 'is' : 'are'} waiting for a fresh pass. Use "Open the page" in Channel grab (or your normal browser) and they'll carry on by themselves.`, 12000));
  api.on('watch:changed', (w) => { state.watch = w; if (state.view === 'watch') renderView(); });
  api.on('history:changed', () => { if (state.view === 'history') loadHistory(); });
  api.on('clipboard:links', (links) => {
    if (!document.hasFocus()) { state.clipLinks = links; return; }
    state.clipLinks = links;
    renderClipBanner();
  });
  api.on('grab:status', (t) => {
    if (state.busy) setBusy(t);
    const el = document.getElementById('grab-progress');
    if (el) el.textContent = t;
  });
  api.on('app:update', (u) => {
    if (u.newer) { state.update = u; renderUpdateBanner(); }
    else if (u.current) toast(`You're on the latest version (${u.current}).`);
  });
  window.addEventListener('focus', renderClipBanner);
  setupDragDrop();
  setInterval(refreshFree, 60000);
}

async function refreshFree() {
  state.freeBytes = await api.diskFree();
  const el = document.getElementById('freespace');
  if (el) el.textContent = state.freeBytes != null ? `${fmtBytes(state.freeBytes)} free` : '';
}

// ---------------------------------------------------------------- lock screen
function renderLock() {
  const app = document.getElementById('app');
  const input = h('input', { class: 'input pinbox', type: 'password', inputmode: 'numeric', maxlength: '8', autocomplete: 'off', 'aria-label': 'PIN' });
  const msg = h('div', { class: 'err', role: 'alert' });
  const tryPin = async () => {
    const ok = await api.verifyPin(input.value);
    if (ok) afterUnlock();
    else { msg.textContent = 'Wrong PIN'; input.value = ''; input.focus(); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPin(); });
  app.replaceChildren(h('div', { class: 'fullcenter' },
    h('div', { class: 'setup' },
      h('img', { src: 'logo.png', alt: 'Slim Takes logo' }),
      h('h1', { class: 'anton', style: { margin: 0, fontSize: '32px' } }, 'SLIM TAKES IS LOCKED'),
      input, msg,
      h('button', { type: 'button', class: 'btn primary big', onclick: tryPin }, 'Unlock'))));
  input.focus();
}

// ---------------------------------------------------------------- first-run engine setup
function renderSetup(errorText) {
  const app = document.getElementById('app');
  const parts = { ytdlp: 'yt-dlp — the download engine', ffmpeg: 'ffmpeg — joins and converts video', deno: 'Deno — needed for YouTube' };
  const rows = {};
  const steps = h('div', { class: 'steps' }, Object.entries(parts).map(([k, label]) => {
    const done = k === 'ffmpeg' ? state.engine.ffmpeg : state.engine[k];
    const bar = h('div', { class: 'bar' }, h('div', { style: { width: done ? '100%' : '0%' } }));
    const st = h('span', { class: 'small ' + (done ? 'ok' : 'mute'), text: done ? 'Ready' : 'Waiting' });
    rows[k] = { bar, st };
    return h('div', { class: 'col' }, h('div', { class: 'row' }, h('span', { class: 'grow', text: label }), st), bar);
  }));
  const err = h('div', { class: 'err', role: 'alert', text: errorText || '' });
  const btn = h('button', { type: 'button', class: 'btn primary big' }, errorText ? 'Try again' : 'Set up now');
  const off = api.on('engine:step', (s) => {
    const r = rows[s.part];
    if (!r) return;
    const pct = s.total ? Math.round((s.got / s.total) * 100) : null;
    r.st.className = 'small hot';
    r.st.textContent = pct != null ? `${s.label} — ${pct}% of ${fmtBytes(s.total)}` : s.label + '…';
    r.bar.firstChild.style.width = (pct != null ? pct : 5) + '%';
  });
  const go = async () => {
    btn.disabled = true;
    err.textContent = '';
    const r = await api.installEngine(false);
    off();
    state.engine = r.status;
    if (r.ok && r.status.ready) { toast('Engine ready. Let\'s go.'); renderShell(); }
    else renderSetup(r.message || 'Setup did not finish.');
  };
  btn.addEventListener('click', go);
  app.replaceChildren(h('div', { class: 'fullcenter' },
    h('div', { class: 'setup' },
      h('img', { src: 'logo.png', alt: 'Slim Takes logo' }),
      h('h1', { class: 'anton', style: { margin: 0, fontSize: '32px' } }, 'FIRST-TIME SETUP'),
      h('span', { class: 'small mute', style: { marginTop: '-10px', letterSpacing: '2px' } }, 'BY SLIM INDUSTRIES'),
      h('p', { class: 'mute', style: { margin: 0 } }, 'Slim Takes needs three free helper programs (about 250 MB). They download once and update themselves.'),
      steps, err, btn,
      h('p', { class: 'small mute', style: { margin: 0 } }, 'Stuck? Check your internet connection, then press Try again.'))));
  if (!errorText) go();
}

// ---------------------------------------------------------------- shell
const NAV = [['downloads', 'Downloads', 'download'], ['grab', 'Channel grab', 'grab'], ['watch', 'Channel Watch', 'watch'], ['history', 'History', 'history'], ['settings', 'Settings', 'settings']];

function renderShell() {
  const app = document.getElementById('app');
  const nav = h('nav', { class: 'side', 'aria-label': 'Main' },
    h('div', { class: 'brand' },
      h('img', { src: 'logo.png', alt: '' }),
      h('div', {}, h('div', { class: 'anton slim' }, 'SLIM'), h('div', { class: 'anton take' }, 'TAKES'))),
    NAV.map(([key, label, ic]) => h('button', { type: 'button', class: 'navbtn' + (state.view === key ? ' on' : ''), 'data-view': key, 'aria-current': state.view === key ? 'page' : null, onclick: () => go(key) },
      icon(ic, 20), label, key === 'downloads' ? h('span', { class: 'badge hidden', id: 'qbadge' }) : null)),
    h('div', { class: 'sidefoot' },
      h('span', {}, h('span', { class: 'dot' }), 'Engine ready'),
      h('span', { id: 'freespace', text: state.freeBytes != null ? `${fmtBytes(state.freeBytes)} free` : '' }),
      h('span', { text: 'v' + state.version })));
  const main = h('main', { class: 'view', id: 'view' });
  app.replaceChildren(h('div', { class: 'shell' }, nav, main));
  renderView();
  updateBadge();
}

function clearGrab() {
  Object.assign(state.grab, { url: '', result: null, error: null, loading: false, selected: new Set() });
  if (state.view === 'grab') renderView();
}

function go(view) {
  // Leaving Channel grab: forget a failed link, so nothing old is waiting when you come back.
  if (state.view === 'grab' && view !== 'grab' && state.grab.error && !state.grab.loading) {
    Object.assign(state.grab, { error: null, url: state.grab.result ? state.grab.url : '' });
  }
  state.view = view;
  document.querySelectorAll('.navbtn').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  renderView();
}

function updateBadge() {
  const b = document.getElementById('qbadge');
  if (!b) return;
  const n = state.items.filter((i) => ['waiting', 'starting', 'downloading', 'processing'].includes(i.status)).length;
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

function renderView() {
  const v = document.getElementById('view');
  if (!v) return;
  v.scrollTop = 0;
  const views = { downloads: viewDownloads, grab: viewGrab, watch: viewWatch, history: viewHistory, settings: viewSettings };
  v.replaceChildren(...[].concat(views[state.view]()).filter((x) => x != null && x !== false));
  renderClipBanner();
  renderUpdateBanner();
  if (state.view === 'history') loadHistory();
}

function topBanners() {
  return [h('div', { id: 'updatebanner' }), h('div', { id: 'clipbanner' })];
}

function renderClipBanner() {
  const box = document.getElementById('clipbanner');
  if (!box) return;
  const links = state.clipLinks;
  if (!links || !links.length) { box.replaceChildren(); return; }
  box.replaceChildren(h('div', { class: 'banner' },
    h('span', { class: 'grow' }, links.length === 1 ? `Copied link: ${links[0]}` : `${links.length} copied links`),
    h('button', { type: 'button', class: 'btn primary', onclick: () => { const l = state.clipLinks; state.clipLinks = null; renderClipBanner(); addLinks(l); } }, 'Add'),
    h('button', { type: 'button', class: 'btn', onclick: () => { state.clipLinks = null; renderClipBanner(); } }, 'Dismiss')));
}

function renderUpdateBanner() {
  const box = document.getElementById('updatebanner');
  if (!box) return;
  const u = state.update;
  if (!u || !u.newer) { box.replaceChildren(); return; }
  box.replaceChildren(h('div', { class: 'banner' },
    h('span', { class: 'grow' }, `Slim Takes ${u.latest} is out (you have ${u.current}).`),
    h('button', { type: 'button', class: 'btn primary', onclick: () => api.openExternal(u.url) }, 'Get it'),
    h('button', { type: 'button', class: 'btn', onclick: () => { state.update = null; renderUpdateBanner(); } }, 'Later')));
}

// ---------------------------------------------------------------- adding links
async function addLinks(links) {
  if (!links || !links.length) return;
  const fmt = state.pasteFormat || state.settings.format;
  const q = state.pasteQuality || state.settings.quality;
  if (links.length === 1) return lookupOne(links[0]);
  if (state.view !== 'downloads') go('downloads');
  let queued = 0, lists = 0, failed = 0;
  for (let i = 0; i < links.length; i++) {
    setBusy(`Looking up link ${i + 1} of ${links.length}…`);
    try {
      const r = await api.lookup(links[i], { private: state.private });
      if (r.kind === 'video') {
        await api.queueAdd(specFromVideo(r, { format: fmt, quality: q }));
        queued++;
      } else { state.grab.pending.push(links[i]); lists++; }
    } catch (e) { failed++; toast(`Couldn't read ${links[i]}: ${cleanErr(e)}`, 7000); }
  }
  setBusy(null);
  toast(`Added ${queued} video${queued === 1 ? '' : 's'}` + (lists ? `, ${lists} channel/playlist link${lists === 1 ? '' : 's'} waiting in Channel grab` : '') + (failed ? `, ${failed} failed` : ''));
  if (lists && !state.grab.result) { const next = state.grab.pending.shift(); go('grab'); loadGrab(next); }
}

async function lookupOne(url) {
  if (state.view !== 'downloads') go('downloads');
  setBusy('Looking up the link…');
  state.preview = null;
  renderPreview();
  try {
    const r = await api.lookup(url, { include: state.grab.include, private: state.private });
    setBusy(null);
    if (r.kind === 'list') {
      showGrabResult(r);
      toast(r.scanned ? 'That\'s a channel, so it opened in Channel grab (found by reading the page directly).' : 'That\'s a channel, so it opened in Channel grab.');
      return;
    }
    state.preview = r;
    state.previewOpts = {
      format: state.pasteFormat || state.settings.format,
      quality: bestQualityFor(r, state.pasteQuality || state.settings.quality),
      trimStart: '', trimEnd: '',
      subs: state.settings.subs, sponsorblock: state.settings.sponsorblock, liveFromStart: false
    };
    renderPreview();
  } catch (e) {
    setBusy(null);
    if (/Page scan/i.test(cleanErr(e))) {
      // Channel link that needed Page scan: show the options (Open the page) in Channel grab.
      Object.assign(state.grab, { url, loading: false, result: null, error: cleanErr(e) });
      go('grab');
      return;
    }
    toast('Couldn\'t read that link: ' + cleanErr(e), 8000);
  }
}

function cleanErr(e) { return String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }

// If the video tops out below the chosen quality, the best below it is used automatically.
function bestQualityFor(video, wanted) {
  if (wanted === 'best' || !video.heights || !video.heights.length) return wanted;
  return wanted;
}

function specFromVideo(v, o) {
  return {
    url: v.url, title: v.title, folder: v.folder, site: v.site, extractor: v.extractor, videoId: v.id,
    duration: v.duration, thumbnail: v.thumbnail, format: o.format, quality: o.quality,
    trim: (o.trimStart || o.trimEnd) ? { start: o.trimStart, end: o.trimEnd } : null,
    subs: o.subs, sponsorblock: o.sponsorblock, liveFromStart: o.liveFromStart, isLive: v.isLive,
    private: state.private, source: 'single',
    direct: v.direct || null // (a video taken from its page: a ticket the app swaps for the real details)
  };
}

function setBusy(text) {
  state.busy = text;
  const el = document.getElementById('busy');
  if (el) { el.textContent = text || ''; el.classList.toggle('hidden', !text); }
}

// ---------------------------------------------------------------- Downloads view
function viewDownloads() {
  const input = h('textarea', {
    class: 'input grow', rows: '1', id: 'paste', 'aria-label': 'Links',
    placeholder: 'Paste links (videos, channels or playlists)', value: state.pasteText,
    oninput: (e) => { state.pasteText = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPaste(); } }
  });
  const privSwitch = h('button', { type: 'button', class: 'switch', 'aria-pressed': String(state.private), style: { marginLeft: 'auto' },
    onclick: () => { state.private = !state.private; renderView(); } }, h('span', { class: 'track' }), 'Private mode');

  return [
    ...topBanners(),
    h('div', { class: 'head' }, h('h1', { class: 'anton' }, 'DOWNLOADS'), privSwitch),
    state.private ? h('div', { class: 'privbanner' }, 'Private mode is on: downloads you add now won\'t appear in History, notifications or Discord.') : null,
    h('section', { class: 'card pastebar', 'aria-label': 'Add links' },
      input,
      h('label', { class: 'field' }, 'Format', select(FORMATS, state.pasteFormat || state.settings.format, (v) => { state.pasteFormat = v; })),
      h('label', { class: 'field' }, 'Quality', select(QUALITIES, state.pasteQuality || state.settings.quality, (v) => { state.pasteQuality = v; })),
      h('button', { type: 'button', class: 'btn primary big', onclick: submitPaste }, 'Add'),
      h('button', { type: 'button', class: 'btn big', title: 'Import links from a text file', onclick: importLinksFile }, 'Import')),
    h('div', { class: 'small mute', style: { marginTop: '-8px' } }, 'Videos open a preview here. Channel and playlist links open in Channel grab, where you pick which videos to grab.'),
    h('div', { id: 'busy', class: 'mute' + (state.busy ? '' : ' hidden'), role: 'status', text: state.busy || '' }),
    h('div', { id: 'dl-preview' }),
    h('div', { id: 'dl-queue', class: 'col', style: { gap: '10px' } }),
    h('footer', { class: 'row small mute', style: { marginTop: 'auto', borderTop: '1px solid var(--line)', paddingTop: '10px', gap: '18px' } },
      h('span', {}, `Speed limit: ${state.settings.speedLimitMB ? state.settings.speedLimitMB + ' MB/s' : 'none'}`),
      h('span', {}, `At once: ${state.settings.concurrent}`),
      h('span', {}, `Polite mode: ${state.settings.polite ? 'on' : 'off'}`),
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); showLog(); } }, 'Open log'))
  ];
}
// Fill the dynamic parts once the view is in the page.
const _renderView = renderView;
renderView = function () {
  _renderView();
  if (state.view === 'downloads') { renderPreview(); renderQueue(); }
};

async function submitPaste() {
  const links = await api.extractLinks(state.pasteText);
  if (!links.length) { toast('Paste a link that starts with http:// or https://'); return; }
  state.pasteText = '';
  const p = document.getElementById('paste');
  if (p) p.value = '';
  addLinks(links);
}

async function importLinksFile() {
  const links = await api.importLinks();
  if (links === null) return;
  if (!links.length) { toast('No links found in that file.'); return; }
  addLinks(links);
}

function renderPreview() {
  const box = document.getElementById('dl-preview');
  if (!box) return;
  const v = state.preview;
  if (!v) { box.replaceChildren(); return; }
  const o = state.previewOpts;
  const avail = v.heights && v.heights.length ? v.heights : null;
  const qOpts = QUALITIES.filter(([q]) => q === 'best' || !avail || avail.some((ht) => ht >= parseInt(q, 10) * 0.9) || q === o.quality);
  const isYT = /youtube/i.test(v.extractor + v.site);
  const audio = AUDIO.has(o.format);
  const ext = o.format;
  const box2 = h('section', { class: 'card preview', 'aria-label': 'Preview' },
    h('div', { class: 'thumbbox' },
      v.thumbnail ? h('img', { class: 'thumb', src: v.thumbnail, alt: '', style: { width: '256px', height: '144px' } }) : h('div', { class: 'thumb', style: { width: '256px', height: '144px' } }),
      v.duration ? h('span', { class: 'len' }, fmtDur(v.duration)) : (v.isLive ? h('span', { class: 'len' }, 'LIVE') : null)),
    h('div', { class: 'col grow', style: { gap: '10px', minWidth: '280px' } },
      h('div', { class: 'col', style: { gap: '2px' } },
        h('div', { class: 'title1', style: { fontSize: '18px', whiteSpace: 'normal' }, text: v.title }),
        h('div', { class: 'mute', text: [v.channelName || v.folder, v.site, avail ? `up to ${qualityLabel(String(avail[0] >= 2160 ? 2160 : avail[0]))} available` : null].filter(Boolean).join(' · ') })),
      v.have === 'have' ? h('div', { class: 'err' }, 'You already have this video (same title and length) — it will be skipped.') : null,
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Format', select(FORMATS, o.format, (x) => { o.format = x; renderPreview(); })),
        audio ? null : h('label', { class: 'field' }, 'Quality', select(qOpts, o.quality, (x) => { o.quality = x; })),
        h('label', { class: 'field' }, 'Trim start', h('input', { class: 'input', style: { width: '90px' }, placeholder: '0:00', value: o.trimStart, oninput: (e) => { o.trimStart = e.target.value.trim(); } })),
        h('label', { class: 'field' }, 'Trim end', h('input', { class: 'input', style: { width: '90px' }, placeholder: v.duration ? fmtDur(v.duration) : 'end', value: o.trimEnd, oninput: (e) => { o.trimEnd = e.target.value.trim(); } }))),
      h('div', { class: 'row' },
        audio ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.subs, onchange: (e) => { o.subs = e.target.checked; } }), 'Subtitles'),
        isYT ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.sponsorblock, onchange: (e) => { o.sponsorblock = e.target.checked; } }), 'Skip sponsor segments') : null,
        v.isLive && isYT ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.liveFromStart, onchange: (e) => { o.liveFromStart = e.target.checked; } }), 'Record from the start') : null),
      h('div', { class: 'small mute' }, 'Saves to ', h('span', { style: { color: 'var(--text)' }, text: `${v.folder}\\${v.title.replace(/[\\/:*?"<>|]/g, '').trim()}.${ext}` }))),
    h('div', { class: 'col', style: { justifyContent: 'flex-end' } },
      h('button', { type: 'button', class: 'btn primary big', onclick: async () => {
        if (!validTrim(o)) return;
        await api.queueAdd(specFromVideo(v, o));
        state.preview = null;
        renderPreview();
      } }, v.isLive ? 'Record' : 'Download'),
      h('button', { type: 'button', class: 'btn', onclick: () => { state.preview = null; renderPreview(); } }, 'Close')));
  box.replaceChildren(box2);
}

function validTrim(o) {
  const ok = (t) => !t || /^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t);
  if (!ok(o.trimStart) || !ok(o.trimEnd)) { toast('Trim times look like 1:30 or 1:02:30'); return false; }
  return true;
}

function renderQueue() {
  const box = document.getElementById('dl-queue');
  if (!box) return;
  const counts = { down: 0, wait: 0, done: 0, failed: 0 };
  let speed = 0;
  for (const i of state.items) {
    if (['downloading', 'processing', 'starting'].includes(i.status)) { counts.down++; speed += i.speed || 0; }
    else if (i.status === 'waiting' || i.status === 'paused') counts.wait++;
    else if (i.status === 'done') counts.done++;
    else if (i.status === 'failed') counts.failed++;
  }
  const head = h('div', { class: 'head' },
    h('h2', { class: 'anton' }, 'QUEUE'),
    h('span', { class: 'mute', id: 'qsummary', text: `${counts.down} downloading · ${counts.wait} waiting · ${counts.done} done` + (speed ? ` · ${fmtBytes(speed)}/s` : '') }),
    h('label', { class: 'row small mute', style: { marginLeft: 'auto', gap: '8px' } }, 'When done',
      select([['nothing', 'Do nothing'], ['sleep', 'Sleep'], ['shutdown', 'Shut down']], state.settings.whenDone, (x) => saveSettings({ whenDone: x }))),
    state.paused || state.items.some((i) => i.status === 'paused')
      ? h('button', { type: 'button', class: 'btn primary', onclick: () => api.resumeAll() }, 'Resume all') : null,
    !state.paused ? h('button', { type: 'button', class: 'btn', onclick: () => api.pauseAll() }, 'Pause all') : null,
    counts.down + counts.wait ? h('button', { type: 'button', class: 'btn', onclick: async () => {
      const n = counts.down + counts.wait;
      if (!(await confirmBox('Cancel all', `Cancel ${n} download${n === 1 ? '' : 's'} that ${n === 1 ? 'hasn\'t' : 'haven\'t'} finished? Anything already downloaded stays.`, { yes: 'Cancel them', no: 'Keep them' }))) return;
      const done = await api.cancelAll();
      toast(`Canceled ${done} download${done === 1 ? '' : 's'}.`);
    } }, 'Cancel all') : null,
    h('button', { type: 'button', class: 'btn', onclick: () => api.clearFinished() }, 'Clear finished'));
  const list = h('div', { class: 'col', id: 'qlist', style: { gap: '8px' } });
  if (!state.items.length) list.append(h('div', { class: 'empty' }, 'Nothing in the queue. Paste a link above to get started.'));
  // Active first, then waiting, then finished (newest finished first).
  const order = { downloading: 0, processing: 0, starting: 0, waiting: 1, paused: 1, failed: 2, done: 3, skipped: 3, canceled: 3 };
  const sorted = [...state.items].sort((a, b) => (order[a.status] - order[b.status]) || (order[a.status] >= 2 ? b.addedAt - a.addedAt : a.addedAt - b.addedAt));
  for (const it of sorted.slice(0, 400)) list.append(queueRow(it));
  if (sorted.length > 400) list.append(h('div', { class: 'mute small' }, `…and ${sorted.length - 400} more`));
  box.replaceChildren(head, list);
}

const STATUS_TEXT = { waiting: 'Waiting', starting: 'Starting', downloading: 'Downloading', processing: 'Finishing up', paused: 'Paused', done: 'Done', failed: 'Failed', skipped: 'Skipped', canceled: 'Canceled' };

function queueRow(it) {
  const active = ['downloading', 'processing', 'starting'].includes(it.status);
  let detail = '';
  if (active) {
    if (it.isLive && !it.total) detail = `Recording · ${fmtBytes(it.downloaded)}`;
    else detail = [it.total ? `${fmtBytes(it.downloaded)} of ${fmtBytes(it.total)}` : null, it.speed ? fmtBytes(it.speed) + '/s' : null, fmtEta(it.eta)].filter(Boolean).join(' · ');
    if (it.note) detail = it.note + (detail ? ' · ' + detail : '');
  } else if (it.status === 'waiting') detail = it.note || 'Waiting for a free slot';
  else if (it.status === 'done') detail = (it.note ? it.note + ' · ' : '') + (it.filePath ? it.filePath : 'Saved');
  else if (it.status === 'skipped') detail = it.note || 'Skipped';
  else if (it.status === 'paused') detail = it.note || 'Paused — will continue where it left off';
  else if (it.status === 'canceled') detail = 'Canceled';

  const actions = [];
  if (active) actions.push(iconBtn('pause', 'Pause', () => api.queueAction('pause', it.id)), iconBtn('x', 'Cancel', () => api.queueAction('cancel', it.id)));
  else if (it.status === 'waiting') actions.push(iconBtn('pause', 'Pause', () => api.queueAction('pause', it.id)), iconBtn('x', 'Remove', () => api.queueAction('remove', it.id)));
  else if (it.status === 'paused') actions.push(iconBtn('play', 'Resume', () => api.queueAction('resume', it.id)), iconBtn('x', 'Remove', () => api.queueAction('remove', it.id)));
  else if (it.status === 'failed') {
    if (needsLogin(it.error)) actions.push(h('button', { type: 'button', class: 'btn', onclick: openAccounts }, 'Set up browser login'));
    if (it.updateHint) actions.push(h('button', { type: 'button', class: 'btn', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Updating…';
      const r = await api.updateEngine().catch((err) => ({ ok: false, message: cleanErr(err) }));
      toast(r.ok ? (r.updated ? 'Engine updated. Press Retry.' : 'The engine is already up to date. The site may be offline, or it changed: try again later.') : 'Engine update failed: ' + r.message, 8000);
      e.target.textContent = 'Update engine'; e.target.disabled = false;
    } }, 'Update engine'));
    actions.push(h('button', { type: 'button', class: 'btn primary', onclick: () => api.queueAction('retry', it.id) }, 'Retry'), iconBtn('x', 'Remove', () => api.queueAction('remove', it.id)));
  }
  else if (it.status === 'canceled') actions.push(iconBtn('retry', 'Start again', () => api.queueAction('resume', it.id)), iconBtn('x', 'Remove', () => api.queueAction('remove', it.id)));
  else if (it.status === 'done') {
    if (it.filePath && PLAYABLE.test(it.filePath)) actions.push(iconBtn('play', 'Play', () => playFile(it.filePath, it.private ? 'Private download' : it.title)));
    actions.push(iconBtn('folder', 'Show in folder', () => api.showFile(it.filePath)), iconBtn('x', 'Remove from list', () => api.queueAction('remove', it.id)));
  } else actions.push(iconBtn('x', 'Remove from list', () => api.queueAction('remove', it.id)));

  const pct = it.status === 'done' ? 100 : (it.pct || 0);
  const indet = active && (it.isLive || it.status === 'starting' || it.status === 'processing');
  return h('div', { class: 'card qitem', 'data-id': it.id },
    h('div', { class: 'thumbbox' }, it.thumbnail ? h('img', { class: 'thumb', src: it.thumbnail, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb', style: { width: '96px', height: '54px' } })),
    h('div', { class: 'col grow', style: { gap: '5px' } },
      h('div', { class: 'row', style: { gap: '10px', flexWrap: 'nowrap' } },
        h('span', { class: 'title1', text: it.title }),
        h('span', { class: 'small mute', style: { whiteSpace: 'nowrap' }, text: `${it.folder} · ${formatLabel(it.format)}${AUDIO.has(it.format) ? '' : ' · ' + qualityLabel(it.quality)}` }),
        it.private ? h('span', { class: 'pill on small' }, 'Private') : null),
      ['done', 'skipped', 'canceled'].includes(it.status) ? null : h('div', { class: 'bar' + (indet ? ' indet' : '') }, h('div', { style: { width: pct.toFixed(1) + '%' } })),
      it.error ? h('span', { class: 'err selectable', text: it.error }) : h('span', { class: 'small mute', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: detail })),
    h('span', { class: 'status st-' + it.status, text: active && it.pct && !indet ? `${Math.floor(it.pct)}%` : STATUS_TEXT[it.status] || it.status }),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } }, actions));
}

function needsLogin(err) { return /browser login/i.test(err || ''); }

function openAccounts() {
  go('settings');
  setTimeout(() => {
    const card = document.getElementById('accounts-card');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash');
    const sel = card.querySelector('select');
    if (sel) sel.focus();
    setTimeout(() => card.classList.remove('flash'), 2200);
  }, 80);
}

function updateQueueItem(it) {
  if (state.view !== 'downloads') return;
  const list = document.getElementById('qlist');
  if (!list) return;
  const old = list.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
  const prev = old ? old.getAttribute('data-status') : null;
  if (!old || (prev && prev !== it.status)) {
    // New item or status change: rebuild the list so the order stays right.
    clearTimeout(updateQueueItem.t);
    updateQueueItem.t = setTimeout(renderQueue, 60);
    return;
  }
  const row = queueRow(it);
  row.setAttribute('data-status', it.status);
  old.replaceWith(row);
  const sum = document.getElementById('qsummary');
  if (sum) {
    let speed = 0, down = 0, wait = 0, done = 0;
    for (const i of state.items) {
      if (['downloading', 'processing', 'starting'].includes(i.status)) { down++; speed += i.speed || 0; }
      else if (i.status === 'waiting' || i.status === 'paused') wait++;
      else if (i.status === 'done') done++;
    }
    sum.textContent = `${down} downloading · ${wait} waiting · ${done} done` + (speed ? ` · ${fmtBytes(speed)}/s` : '');
  }
}
// Tag rows with their status after a full render.
const _renderQueue = renderQueue;
renderQueue = function () {
  _renderQueue();
  document.querySelectorAll('#qlist [data-id]').forEach((row) => {
    const it = state.items.find((x) => x.id === row.getAttribute('data-id'));
    if (it) row.setAttribute('data-status', it.status);
  });
};

// ---------------------------------------------------------------- Channel grab
function viewGrab() {
  const g = state.grab;
  const out = [
    ...topBanners(),
    h('div', { class: 'head' }, h('h1', { class: 'anton' }, 'CHANNEL GRAB')),
    h('p', { class: 'mute', style: { margin: '-8px 0 0' } }, 'See every video on a channel, profile or playlist, pick what you want, and grab them all.'),
    h('section', { class: 'card pastebar', 'aria-label': 'Channel link' },
      h('input', { class: 'input grow', id: 'grab-url', placeholder: 'Paste a channel, profile or playlist link…', value: g.url, 'aria-label': 'Channel link',
        oninput: (e) => { g.url = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') loadGrab(g.url); } }),
      h('button', { type: 'button', class: 'btn primary big', disabled: g.loading, onclick: () => loadGrab(g.url) }, g.loading ? 'Loading…' : 'Load list'),
      (g.result || g.error || g.url) && !g.loading ? h('button', { type: 'button', class: 'btn big', onclick: clearGrab }, 'Clear') : null),
    g.pending.length ? h('div', { class: 'banner' }, h('span', { class: 'grow' }, `${g.pending.length} more channel/playlist link${g.pending.length === 1 ? '' : 's'} waiting.`),
      h('button', { type: 'button', class: 'btn primary', onclick: () => loadGrab(g.pending.shift()) }, 'Load next')) : null
  ];
  if (g.loading) out.push(h('div', { class: 'card col' }, h('div', { class: 'bar indet' }, h('div', {})), h('span', { class: 'mute', id: 'grab-progress' }, 'Reading the list… big channels can take a minute.')));
  if (g.error) out.push(h('div', { class: 'card col', role: 'alert' }, h('span', { class: 'err', text: g.error }),
    g.url ? h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => showMeScan(g.url) }, 'Open the page'),
      /Page scan/i.test(g.error) ? null : h('button', { type: 'button', class: 'btn', onclick: () => scanGrab(g.url) }, 'Try Page scan'),
      h('button', { type: 'button', class: 'btn', onclick: () => go('downloads') }, 'Back to Downloads')) : null));
  if (!g.result && !g.loading && !g.error) out.push(h('div', { class: 'empty' }, 'Paste a channel, profile or playlist link above (or in Downloads) to see every video on it.'));
  if (g.result) out.push(...grabResult());
  return out;
}

// Show-me mode: the user sees the page, clicks past anything in the way, then we read it.
// If the site's "are you human" check keeps repeating in that window, the user can tick it in their
// own browser instead, and the app borrows that browser's pass for this site.
async function showMeScan(url) {
  const g = state.grab;
  await api.pageScanOpen(url);
  let scanning = false;
  let browser = state.settings.cookiesBrowser && state.settings.cookiesBrowser !== 'none' ? state.settings.cookiesBrowser : 'firefox';
  const status = h('p', { class: 'mute', style: { margin: 0 } }, 'A window opened with the page. Click past any age check, cookie banner or "are you a robot" box, and make sure you can see the videos. Then press Scan now.');
  const backupMsg = h('p', { class: 'err', style: { margin: 0 }, role: 'alert' });
  let borrowing = false;
  const doneBtn = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    if (scanning || borrowing) return;
    borrowing = true;
    scanBtn.disabled = true;
    doneBtn.disabled = true;
    doneBtn.textContent = 'Reading your browser\'s pass…';
    backupMsg.textContent = '';
    try {
      const r = await api.pageScanUseBrowser(url, browser);
      offLoop();
      close();
      toast(`Using ${r.browser}'s pass for this site.`);
      loadGrab(url);
    } catch (err) {
      backupMsg.textContent = cleanErr(err);
      borrowing = false;
      scanBtn.disabled = false;
      doneBtn.disabled = false;
      doneBtn.textContent = 'Done, use my browser\'s pass';
    }
  } }, 'Done, use my browser\'s pass');
  const backup = h('div', { class: 'card col hidden', style: { gap: '10px' } },
    h('strong', {}, 'Check keeps repeating? Use your normal browser instead'),
    h('p', { class: 'mute small', style: { margin: 0 } }, 'Some sites won\'t accept the "I\'m human" box in this window. Tick it in your own browser and Slim Takes will borrow that pass for this site only.'),
    h('label', { class: 'field' }, '1. Your browser', select([['firefox', 'Firefox (works best)'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['brave', 'Brave'], ['opera', 'Opera'], ['vivaldi', 'Vivaldi']], browser, (v) => { browser = v; })),
    h('div', { class: 'row' }, h('span', { class: 'small' }, '2.'),
      h('button', { type: 'button', class: 'btn', onclick: () => api.openExternal(url.replace(/^http:/i, 'https:')) }, 'Open the site in my browser'),
      h('button', { type: 'button', class: 'btn', onclick: () => { navigator.clipboard.writeText(url); toast('Link copied: paste it into your browser'); } }, 'Copy link')),
    h('p', { class: 'small mute', style: { margin: '-4px 0 0 18px' } }, 'Tick the box there, wait until you see the videos, then close that browser. (Not your usual browser? Use Copy link and paste it in.)'),
    h('div', { class: 'row' }, h('span', { class: 'small' }, '3.'), doneBtn),
    backupMsg);
  const showBackup = (looped) => {
    backup.classList.remove('hidden');
    backupLink.classList.add('hidden');
    if (looped) status.textContent = 'The site\'s "are you human" check keeps repeating in this window. It has decided the window isn\'t a normal browser, so use your own browser below.';
  };
  const backupLink = h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); showBackup(false); } }, 'Check keeps repeating? Use your normal browser instead');
  const scanBtn = h('button', { type: 'button', class: 'btn primary big', onclick: async (e) => {
    if (scanning || borrowing) return;
    scanning = true;
    e.target.disabled = true;
    doneBtn.disabled = true;
    e.target.textContent = 'Scanning…';
    status.textContent = 'Reading the page… this can take a minute if there are several pages.';
    g.loading = true; g.error = null; g.result = null; g.url = url;
    try {
      const r = await api.pageScanVisible(url, { format: g.format, quality: g.quality, private: state.private });
      close();
      showGrabResult(r);
    } catch (err) {
      close();
      g.loading = false;
      g.error = 'Page scan didn\'t work: ' + cleanErr(err);
      if (state.view !== 'grab') go('grab'); else renderView();
    }
  } }, 'Scan now');
  const offLoop = api.on('pageScan:loop', (u) => { if (u === url) showBackup(true); });
  const close = modal((close) => [
    h('h2', { class: 'anton' }, 'OPEN THE PAGE'),
    status,
    backupLink,
    backup,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      h('button', { type: 'button', class: 'btn', onclick: () => { api.pageScanCancel(); close(); } }, 'Cancel'),
      scanBtn)
  ], { onClose: () => { offLoop(); if (!scanning) api.pageScanCancel(); } });
  return close;
}

async function scanGrab(url) {
  const g = state.grab;
  g.loading = true; g.error = null; g.result = null; g.url = url;
  if (state.view !== 'grab') go('grab'); else renderView();
  try { showGrabResult(await api.pageScan(url, { format: g.format, quality: g.quality, private: state.private })); }
  catch (e) { g.loading = false; g.error = 'Page scan didn\'t work: ' + cleanErr(e); renderView(); }
}

async function loadGrab(url) {
  const g = state.grab;
  if (!url || !/^https?:\/\//i.test(url.trim())) { toast('Paste a link that starts with https://'); return; }
  g.url = url.trim();
  g.loading = true; g.error = null; g.result = null;
  if (state.view !== 'grab') go('grab'); else renderView();
  const off = api.on('lookup:line', (l) => {
    const el = document.getElementById('grab-progress');
    const m = String(l).match(/Downloading (?:page|API JSON page|webpage).*?(\d+)/i);
    if (el && m) el.textContent = `Reading the list… page ${m[1]}`;
  });
  try {
    const r = await api.lookupList(g.url, { include: g.include, format: g.format, quality: g.quality, private: state.private });
    off();
    if (r.kind !== 'list') { showSingle(r); return; }
    showGrabResult(r);
  } catch (e) {
    off();
    g.loading = false;
    g.error = 'Couldn\'t read that link: ' + cleanErr(e);
    renderView();
  }
}

// A single video (from Channel grab, or from Open the page): show it in Downloads, ready to grab.
function showSingle(r) {
  const g = state.grab;
  g.loading = false;
  g.error = null;
  g.result = null;
  go('downloads');
  state.preview = r;
  state.previewOpts = {
    format: state.pasteFormat || state.settings.format,
    quality: bestQualityFor(r, state.pasteQuality || state.settings.quality),
    trimStart: '', trimEnd: '', subs: state.settings.subs, sponsorblock: state.settings.sponsorblock, liveFromStart: false
  };
  renderPreview();
}

function showGrabResult(r) {
  if (r && r.kind !== 'list') { showSingle(r); return; }
  const g = state.grab;
  g.loading = false;
  g.error = null;
  g.result = r;
  g.url = r.url;
  g.showCount = 300;
  g.selected = new Set(r.entries.filter((e) => e.have !== 'have').map((e) => e.id || e.url));
  g.addWatch = !r.watched;
  if (state.view !== 'grab') go('grab'); else renderView();
}

function filteredEntries() {
  const g = state.grab, f = g.filters;
  let list = g.result.entries.slice();
  if (f.date !== 'any') {
    const now = new Date();
    let from = null, to = null;
    if (f.date === 'year') from = `${now.getFullYear()}0101`;
    if (f.date === '30d') from = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
    if (f.date === 'custom') { from = f.from ? f.from.replace(/-/g, '') : null; to = f.to ? f.to.replace(/-/g, '') : null; }
    // Videos without a known date stay in; the engine checks their date while downloading.
    list = list.filter((e) => !e.uploadDate || ((!from || e.uploadDate >= from) && (!to || e.uploadDate <= to)));
  }
  const min = f.length === 'over5' ? 300 : f.length === 'custom' && f.min ? Number(f.min) * 60 : null;
  const max = f.length === 'under20' ? 1200 : f.length === 'custom' && f.max ? Number(f.max) * 60 : null;
  if (min || max) list = list.filter((e) => !e.duration || ((!min || e.duration >= min) && (!max || e.duration <= max)));
  if (f.newest !== 'all') list = list.slice(0, Number(f.newest));
  return list;
}

function grabFilterArgs() {
  const f = state.grab.filters;
  const out = {};
  if (f.date === 'year') out.dateAfter = `${new Date().getFullYear()}0101`;
  if (f.date === '30d') out.dateAfter = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
  if (f.date === 'custom') { if (f.from) out.dateAfter = f.from; if (f.to) out.dateBefore = f.to; }
  if (f.length === 'over5') out.minDuration = 300;
  if (f.length === 'under20') out.maxDuration = 1200;
  if (f.length === 'custom') { if (f.min) out.minDuration = Number(f.min) * 60; if (f.max) out.maxDuration = Number(f.max) * 60; }
  return Object.keys(out).length ? out : null;
}

function grabResult() {
  const g = state.grab, r = g.result, f = g.filters;
  const fmt = g.format || state.settings.format, q = g.quality || state.settings.quality;
  const shown = filteredEntries();
  const key = (e) => e.id || e.url;
  const chosen = shown.filter((e) => g.selected.has(key(e)) && e.have !== 'have');
  const haveCount = r.entries.filter((e) => e.have === 'have').length;
  const est = chosen.reduce((s, e) => s + (e.estimate || 0), 0);
  const unknown = chosen.filter((e) => !e.estimate).length;
  const isYT = !!r.isYouTubeChannel;

  const refresh = () => renderView();
  const setF = (k, v) => { f[k] = v; refresh(); };

  const card = h('section', { class: 'card row', style: { gap: '18px' }, 'aria-label': 'Channel' },
    r.thumbnail ? h('img', { class: 'avatar', src: r.thumbnail, alt: '' }) : h('div', { class: 'avatar anton', text: (r.title || '?').slice(0, 1).toUpperCase() }),
    h('div', { class: 'col grow', style: { gap: '3px' } },
      h('div', { style: { fontSize: '20px', fontWeight: 700 }, text: r.title }),
      h('div', { class: 'mute', text: `${r.site} · ${r.entries.length} videos found` + (haveCount ? ` · ${haveCount} already downloaded (will be skipped)` : '') }),
      h('div', { class: 'small mute' }, 'Saves to ', h('span', { style: { color: 'var(--text)' }, text: `${r.folder}\\` })),
      r.note ? h('div', { class: 'small err', role: 'status', text: r.note }) : null,
      r.scanned ? h('div', { class: 'small hot' }, 'Found by reading the page directly. Lengths and dates fill in as each video downloads. ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); showMeScan(r.url); } }, 'Missing some? Open the page'))
        : h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); scanGrab(r.url); } }, 'Missing videos? Scan the page instead')),
    h('div', { class: 'col', style: { alignItems: 'flex-end', gap: '0' } },
      h('span', { class: 'anton bignum', text: est ? '~' + fmtBytes(est) : '—' }),
      h('span', { class: 'small mute', text: `estimated for ${chosen.length} selected` + (unknown ? ` (${unknown} unknown length)` : '') })));

  const filters = h('section', { class: 'card row', style: { alignItems: 'flex-end', gap: '14px' }, 'aria-label': 'Filters' },
    isYT ? h('fieldset', { class: 'row', style: { border: 0, margin: 0, padding: 0, gap: '8px' } },
      h('legend', { class: 'small mute', style: { padding: '0 0 4px' } }, 'Include (reloads the list)'),
      [['videos', 'Videos'], ['shorts', 'Shorts'], ['streams', 'Livestreams']].map(([k, label]) =>
        h('label', { class: 'pill' + (g.include[k] ? ' on' : '') }, h('input', { type: 'checkbox', checked: g.include[k], style: { accentColor: 'var(--acc)' },
          onchange: (e) => { g.include[k] = e.target.checked; if (!Object.values(g.include).some(Boolean)) g.include.videos = true; loadGrab(g.url); } }), label))) : null,
    h('label', { class: 'field' }, 'Newest', select([['all', 'All'], ['10', 'Newest 10'], ['25', 'Newest 25'], ['50', 'Newest 50'], ['100', 'Newest 100']], f.newest, (v) => setF('newest', v))),
    h('label', { class: 'field' }, 'Uploaded', select([['any', 'Any time'], ['year', 'This year'], ['30d', 'Last 30 days'], ['custom', 'Custom range…']], f.date, (v) => setF('date', v))),
    f.date === 'custom' ? h('label', { class: 'field' }, 'From', h('input', { class: 'input', type: 'date', value: f.from, onchange: (e) => setF('from', e.target.value) })) : null,
    f.date === 'custom' ? h('label', { class: 'field' }, 'To', h('input', { class: 'input', type: 'date', value: f.to, onchange: (e) => setF('to', e.target.value) })) : null,
    h('label', { class: 'field' }, 'Length', select([['any', 'Any length'], ['over5', 'Over 5 min'], ['under20', 'Under 20 min'], ['custom', 'Custom…']], f.length, (v) => setF('length', v))),
    f.length === 'custom' ? h('label', { class: 'field' }, 'Min (minutes)', h('input', { class: 'input', type: 'number', min: '0', style: { width: '90px' }, value: f.min, onchange: (e) => setF('min', e.target.value) })) : null,
    f.length === 'custom' ? h('label', { class: 'field' }, 'Max (minutes)', h('input', { class: 'input', type: 'number', min: '0', style: { width: '90px' }, value: f.max, onchange: (e) => setF('max', e.target.value) })) : null,
    h('label', { class: 'field' }, 'Format', select(FORMATS, fmt, (v) => { g.format = v; refresh(); })),
    AUDIO.has(fmt) ? null : h('label', { class: 'field' }, 'Quality', select(QUALITIES, q, (v) => { g.quality = v; refresh(); })));

  const rows = shown.slice(0, g.showCount).map((e) => {
    const have = e.have === 'have';
    const k = key(e);
    const st = have ? ['Already have', 'mute'] : e.have === 'sametitle' ? ['New · saves as (2)', 'ok'] : ['New', 'ok'];
    return h('label', { class: 'grow-row' + (have ? ' have' : '') },
      h('input', { type: 'checkbox', checked: !have && g.selected.has(k), disabled: have, 'aria-label': 'Select ' + e.title,
        onchange: (ev) => { if (ev.target.checked) g.selected.add(k); else g.selected.delete(k); updateGrabFooter(); } }),
      h('span', { class: 'title1', style: { paddingRight: '12px' }, text: e.title }),
      h('span', { text: fmtDate(e.uploadDate) }),
      h('span', { text: fmtDur(e.duration) }),
      h('span', { text: e.estimate ? '~' + fmtBytes(e.estimate) : '—' }),
      h('span', { class: 'small ' + st[1], style: { fontWeight: 600 }, text: st[0] }));
  });
  const table = h('section', { class: 'gtable grow-scroll', 'aria-label': 'Videos found' },
    h('div', { class: 'grow-row headrow' }, h('span'), h('span', {}, 'Title'), h('span', {}, 'Uploaded'), h('span', {}, 'Length'), h('span', {}, 'Size'), h('span', {}, 'Status')),
    rows,
    shown.length > g.showCount ? h('div', { style: { padding: '10px 14px' } }, h('button', { type: 'button', class: 'btn', onclick: () => { g.showCount += 500; refresh(); } }, `Show ${Math.min(500, shown.length - g.showCount)} more (${shown.length - g.showCount} hidden)`)) : null,
    !shown.length ? h('div', { class: 'empty', style: { border: 0 } }, 'No videos match these filters.') : null);

  const footer = h('section', { class: 'row', id: 'grab-footer', 'aria-label': 'Start' },
    h('button', { type: 'button', class: 'btn', onclick: () => { shown.forEach((e) => e.have !== 'have' && g.selected.add(key(e))); refresh(); } }, 'Select all'),
    h('button', { type: 'button', class: 'btn', onclick: () => { shown.forEach((e) => g.selected.delete(key(e))); refresh(); } }, 'Select none'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: g.addWatch, onchange: (e) => { g.addWatch = e.target.checked; } }), r.watched ? 'Already in Channel Watch' : 'Also add to Channel Watch'),
    h('button', { type: 'button', class: 'btn primary big', id: 'grab-start', style: { marginLeft: 'auto' }, disabled: !chosen.length, onclick: startGrab }, `Start grab · ${chosen.length} video${chosen.length === 1 ? '' : 's'}`));

  return [card, filters, table, footer];
}

function updateGrabFooter() {
  const g = state.grab;
  const shown = filteredEntries();
  const n = shown.filter((e) => g.selected.has(e.id || e.url) && e.have !== 'have').length;
  const b = document.getElementById('grab-start');
  if (b) { b.textContent = `Start grab · ${n} video${n === 1 ? '' : 's'}`; b.disabled = !n; }
}

async function startGrab() {
  const g = state.grab, r = g.result;
  const fmt = g.format || state.settings.format, q = g.quality || state.settings.quality;
  const chosen = filteredEntries().filter((e) => g.selected.has(e.id || e.url) && e.have !== 'have');
  if (!chosen.length) return;
  const filters = grabFilterArgs();
  // Channels list newest first; download oldest first.
  const specs = chosen.slice().reverse().map((e) => ({
    url: e.url, title: e.title, folder: e.folder || r.folder, site: r.site, extractor: e.extractor || r.extractor, videoId: e.id,
    duration: e.duration, thumbnail: e.thumbnail, format: fmt, quality: q, filters, private: state.private, source: 'grab', isLive: e.isLive
  }));
  await api.queueAdd(specs);
  if (g.addWatch && !r.watched) {
    await api.watchAdd({ list: r, format: fmt, quality: q, include: g.include });
    toast(`${r.title} added to Channel Watch`);
  }
  toast(`${specs.length} video${specs.length === 1 ? '' : 's'} added to the queue`);
  g.result = null; g.url = '';
  if (g.pending.length) { loadGrab(g.pending.shift()); return; }
  go('downloads');
}

// ---------------------------------------------------------------- Channel Watch
function viewWatch() {
  const w = state.watch, st = w.status || {};
  const urlInput = h('input', { class: 'input grow', placeholder: 'Paste a channel or profile link to watch…', value: state.watchUrl, 'aria-label': 'Channel link to watch',
    oninput: (e) => { state.watchUrl = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') addWatchUrl(); } });
  const list = (w.channels || []).map((c) => h('div', { class: 'card row', style: { gap: '16px' } },
    c.thumbnail ? h('img', { class: 'avatar', src: c.thumbnail, alt: '', style: { width: '48px', height: '48px' } }) : h('div', { class: 'avatar anton', style: { width: '48px', height: '48px', fontSize: '20px' }, text: (c.name || '?').slice(0, 1).toUpperCase() }),
    h('div', { class: 'col grow', style: { gap: '2px', minWidth: '220px' } },
      h('div', { style: { fontWeight: 600, fontSize: '16px' }, text: c.name }),
      h('div', { class: 'small mute', text: `${c.site} · checked ${fmtWhen(c.lastChecked)} · ${c.downloaded || 0} new downloaded so far` }),
      c.lastError ? h('div', { class: 'err', text: c.lastError }) : null),
    h('label', { class: 'field' }, 'Format', select(FORMATS, c.format, (v) => api.watchUpdate(c.id, { format: v }))),
    AUDIO.has(c.format) ? null : h('label', { class: 'field' }, 'Quality', select(QUALITIES, c.quality, (v) => api.watchUpdate(c.id, { quality: v }))),
    c.enabled ? h('span', { class: 'status ' + (c.lastNew ? 'hot' : 'ok'), text: c.lastNew ? `${c.lastNew} new last check` : 'Up to date' }) : null,
    h('button', { type: 'button', class: 'switch', 'aria-pressed': String(!!c.enabled), onclick: () => api.watchUpdate(c.id, { enabled: !c.enabled }) }, h('span', { class: 'track' }), c.enabled ? 'Watching' : 'Paused'),
    iconBtn('trash', 'Stop watching', async () => { if (await confirmBox(`Stop watching ${c.name}?`, 'Videos already downloaded stay where they are.')) api.watchRemove(c.id); })));

  return [
    ...topBanners(),
    h('div', { class: 'head' }, h('h1', { class: 'anton' }, 'CHANNEL WATCH'), h('span', { class: 'mute' }, 'New uploads download automatically')),
    h('section', { class: 'card row', style: { alignItems: 'flex-end', gap: '16px' }, 'aria-label': 'Watch settings' },
      h('label', { class: 'field' }, 'Check for new uploads', select([['1h', 'Every hour'], ['2h', 'Every 2 hours'], ['6h', 'Every 6 hours'], ['12h', 'Every 12 hours'], ['24h', 'Once a day'], ['manual', 'Manual only']], state.settings.watchInterval, (v) => saveSettings({ watchInterval: v }))),
      h('div', { class: 'col small mute', style: { gap: '2px' } },
        h('span', {}, `Last check: ${fmtWhen(st.lastRun)}`),
        h('span', {}, st.nextRun ? `Next check: ${fmtWhen(st.nextRun)}` : 'Automatic checks are off')),
      h('span', { class: 'small mute' }, state.settings.discordWebhook ? 'Discord pings are on' : 'Add a Discord webhook in Settings to get pinged'),
      h('button', { type: 'button', class: 'btn primary big', style: { marginLeft: 'auto' }, disabled: st.checking, onclick: () => api.watchCheckNow() }, st.checking ? 'Checking…' : 'Check now')),
    h('section', { class: 'card pastebar', 'aria-label': 'Add a channel' }, urlInput,
      h('button', { type: 'button', class: 'btn primary big', onclick: addWatchUrl }, 'Watch')),
    h('p', { class: 'small mute', style: { margin: 0 } }, 'Adding a channel here only grabs uploads from now on. To grab what\'s already there, use Channel grab.'),
    list.length ? h('div', { class: 'col', style: { gap: '10px' } }, list) : h('div', { class: 'empty' }, 'Not watching any channels yet.'),
    h('div', { class: 'banner', style: { background: 'transparent', borderStyle: 'dashed', borderColor: 'var(--line)' } },
      h('span', { class: 'grow mute' }, 'Checks only run while Slim Takes is open. Closing the window keeps it running in the tray.'),
      h('button', { type: 'button', class: 'btn', onclick: () => go('settings') }, 'Tray & startup settings'))
  ];
}

async function addWatchUrl() {
  const url = (state.watchUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) { toast('Paste a link that starts with https://'); return; }
  toast('Reading the channel… this can take a minute.');
  try {
    await api.watchAddUrl(url, { format: state.settings.format, quality: state.settings.quality, include: { videos: true, shorts: false, streams: false } });
    state.watchUrl = '';
    toast('Channel added. New uploads will download automatically.');
    state.watch = await api.watchGet();
    renderView();
  } catch (e) { toast('Couldn\'t add that channel: ' + cleanErr(e), 8000); }
}

// ---------------------------------------------------------------- History
function viewHistory() {
  const search = h('input', { class: 'input grow', type: 'search', placeholder: 'Search titles or channels…', value: state.histSearch, 'aria-label': 'Search history',
    oninput: (e) => { state.histSearch = e.target.value; renderHistoryList(); } });
  const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' },
    [['all', 'All'], ['done', 'Completed'], ['failed', 'Failed']].map(([k, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(state.histTab === k), onclick: () => { state.histTab = k; renderView(); } }, label)));
  return [
    ...topBanners(),
    h('div', { class: 'head' }, h('h1', { class: 'anton' }, 'HISTORY'),
      h('button', { type: 'button', class: 'btn', style: { marginLeft: 'auto' }, onclick: () => api.openFolder() }, 'Open SlimTakes folder'),
      h('button', { type: 'button', class: 'btn', onclick: importLinksFile }, 'Import links from file'),
      h('button', { type: 'button', class: 'btn danger', onclick: async () => { if (await confirmBox('Clear all history?', 'This clears the History list, the log and cached thumbnails. Your downloaded files are not touched.')) api.historyClear(); } }, 'Clear history')),
    h('div', { class: 'row' }, search, tabs),
    h('div', { id: 'histlist', class: 'col', style: { gap: '8px' } }),
    h('p', { class: 'small mute', style: { margin: 'auto 0 0' } }, 'Downloads made in Private mode are never listed here.')
  ];
}

async function loadHistory() {
  state.history = await api.history();
  renderHistoryList();
}

function renderHistoryList() {
  const box = document.getElementById('histlist');
  if (!box) return;
  const q = state.histSearch.trim().toLowerCase();
  const list = state.history.filter((x) => (state.histTab === 'all' || x.status === state.histTab) &&
    (!q || (x.title || '').toLowerCase().includes(q) || (x.folder || '').toLowerCase().includes(q)));
  if (!list.length) { box.replaceChildren(h('div', { class: 'empty' }, state.history.length ? 'Nothing matches.' : 'No downloads yet.')); return; }
  box.replaceChildren(...list.slice(0, 300).map((x) => {
    const ok = x.status === 'done';
    return h('div', { class: 'card qitem' },
      h('div', { class: 'thumbbox' }, x.thumbnail ? h('img', { class: 'thumb', src: x.thumbnail, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb', style: { width: '96px', height: '54px' } })),
      h('div', { class: 'col grow', style: { gap: '3px' } },
        h('span', { class: 'title1', text: x.title }),
        h('span', { class: 'small mute', text: [x.folder, x.site, formatLabel(x.format) + (AUDIO.has(x.format) ? '' : ' ' + qualityLabel(x.quality)), x.size ? fmtBytes(x.size) : null, new Date(x.at).toLocaleString()].filter(Boolean).join(' · ') }),
        !ok && x.error ? h('span', { class: 'err selectable', text: x.error }) : null),
      h('span', { class: 'status ' + (ok ? 'st-done' : 'st-failed'), text: ok ? 'Completed' : 'Failed' }),
      ok ? h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } },
        x.filePath && PLAYABLE.test(x.filePath) ? h('button', { type: 'button', class: 'btn primary', onclick: () => playFile(x.filePath, x.title) }, 'Play') : null,
        h('button', { type: 'button', class: 'btn', onclick: async () => { const r = await api.openFile(x.filePath); if (r) toast('File not found — it may have been moved or deleted.'); } }, 'Open file'),
        h('button', { type: 'button', class: 'btn', onclick: () => api.showFile(x.filePath) }, 'Show in folder'),
        iconBtn('x', 'Remove from history', () => api.historyRemove(x.id)))
        : h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } },
          h('button', { type: 'button', class: 'btn primary', onclick: async () => { await api.queueAdd({ url: x.url, title: x.title, folder: x.folder, site: x.site, format: x.format, quality: x.quality, thumbnail: x.thumbnail }); api.historyRemove(x.id); toast('Added back to the queue'); } }, 'Retry'),
          needsLogin(x.error) ? h('button', { type: 'button', class: 'btn', onclick: openAccounts }, 'Set up browser login') : null,
          h('button', { type: 'button', class: 'btn', onclick: () => { navigator.clipboard.writeText(x.error || ''); toast('Error copied'); } }, 'Copy error'),
          iconBtn('x', 'Remove from history', () => api.historyRemove(x.id))));
  }), ...(list.length > 300 ? [h('div', { class: 'small mute' }, `Showing 300 of ${list.length}. Search to find older ones.`)] : []));
}

// ---------------------------------------------------------------- Settings
function viewSettings() {
  const s = state.settings;
  const set = (patch) => saveSettings(patch).then(() => renderView());
  const chk = (key, label, hint) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s[key], onchange: (e) => saveSettings({ [key]: e.target.checked }) }), label, hint ? h('span', { class: 'hint' }, hint) : null);

  const themeKeys = ['crimson', 'ice', 'toxic', 'amber', 'violet', 'daylight'];
  const swatches = h('div', { class: 'swatches' },
    themeKeys.map((k) => {
      const t = window.SlimThemes.THEMES[k];
      return h('button', { type: 'button', class: 'swatch', title: t.name, 'aria-label': t.name + ' theme', 'aria-pressed': String(s.theme === k),
        style: { background: `linear-gradient(135deg, ${t.bg} 50%, ${t.acc} 50%)` }, onclick: () => set({ theme: k }) });
    }),
    h('button', { type: 'button', class: 'swatch', title: 'Custom', 'aria-label': 'Custom colour theme', 'aria-pressed': String(s.theme === 'custom'),
      style: { background: `linear-gradient(135deg, #0b0a0e 50%, ${s.customAccent} 50%)` }, onclick: () => set({ theme: 'custom' }) }));

  return [
    ...topBanners(),
    h('div', { class: 'head' }, h('h1', { class: 'anton' }, 'SETTINGS')),
    h('div', { class: 'sgrid' },
      h('section', { class: 'card scard', 'aria-label': 'Saving' },
        h('h2', { class: 'anton' }, 'SAVING'),
        h('div', { class: 'field' }, 'Main folder',
          h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
            h('input', { class: 'input grow', value: s.folder, readonly: true, 'aria-label': 'Main folder' }),
            h('button', { type: 'button', class: 'btn', onclick: async () => { const f = await api.chooseFolder(); if (f) set({ folder: f }); } }, 'Change'),
            h('button', { type: 'button', class: 'btn', onclick: () => api.openFolder() }, 'Open'))),
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
          h('label', { class: 'field grow' }, 'Default format', select(FORMATS, s.format, (v) => set({ format: v }))),
          h('label', { class: 'field grow' }, 'Default quality', select(QUALITIES, s.quality, (v) => set({ quality: v })))),
        h('span', { class: 'hint' }, 'If a video doesn\'t go up to the default quality, the best one below it is used. Files are named after the video title, in a folder per creator.'),
        chk('setFileDate', 'Set file date to the upload date', '(sort by date = upload order)'),
        chk('cover', 'Save a cover image next to each video', '(for Plex / Jellyfin)')),

      h('section', { class: 'card scard', 'aria-label': 'Downloads' },
        h('h2', { class: 'anton' }, 'DOWNLOADS'),
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
          h('label', { class: 'field grow' }, 'At once', select([1, 2, 3, 4, 5, 6].map((n) => [String(n), String(n)]), String(s.concurrent), (v) => set({ concurrent: Number(v) }))),
          h('label', { class: 'field grow', title: 'Sites often slow down each connection. More connections per video = faster downloads from those sites. If a site allows fewer, Slim Takes finds out and uses fewer for it.' }, 'Connections per video',
            select([['1', '1 (off)'], ['2', '2'], ['4', '4'], ['6', '6'], ['8', '8'], ['16', '16 (max)']], String(s.connections || 8), (v) => set({ connections: Number(v) }))),
          h('label', { class: 'field grow' }, 'Speed limit', select([['0', 'None'], ['50', '50 MB/s'], ['20', '20 MB/s'], ['10', '10 MB/s'], ['5', '5 MB/s'], ['2', '2 MB/s'], ['1', '1 MB/s']], String(s.speedLimitMB), (v) => set({ speedLimitMB: Number(v) })))),
        chk('polite', 'Polite mode', '(short pauses so sites don\'t block big grabs)'),
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
          h('label', { class: 'field grow' }, 'Retry failed downloads', select([['0', 'Don\'t retry'], ['1', '1 time'], ['2', '2 times'], ['3', '3 times']], String(s.retries), (v) => set({ retries: Number(v) }))),
          h('label', { class: 'field grow' }, 'Pause when disk has less than', select([['0', 'Off'], ['5', '5 GB free'], ['10', '10 GB free'], ['25', '25 GB free'], ['50', '50 GB free']], String(s.minFreeGB), (v) => set({ minFreeGB: Number(v) })))),
        h('label', { class: 'field' }, 'Clear finished items from the Downloads list', select([['0', 'Never'], ['1', 'After 1 day'], ['7', 'After 7 days'], ['30', 'After 30 days']], String(s.autoClearDays || 0), (v) => set({ autoClearDays: Number(v) }))),
        h('span', { class: 'hint' }, 'They stay in History either way.')),

      h('section', { class: 'card scard', id: 'accounts-card', 'aria-label': 'Accounts' },
        h('h2', { class: 'anton' }, 'ACCOUNTS'),
        h('label', { class: 'field' }, 'Use browser login', select([['none', 'Off'], ['firefox', 'Firefox (works best)'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['brave', 'Brave'], ['opera', 'Opera'], ['vivaldi', 'Vivaldi']], s.cookiesBrowser, (v) => set({ cookiesBrowser: v }))),
        h('span', { class: 'hint' }, 'Needed for age-restricted, private or members-only videos. Pick the browser you\'re logged in with. Chrome, Edge and other Chrome-based browsers must be fully closed first, and can still fail; Firefox is the reliable choice.')),

      h('section', { class: 'card scard', 'aria-label': 'Look' },
        h('h2', { class: 'anton' }, 'THEME'),
        swatches,
        s.theme === 'custom' ? h('label', { class: 'row' }, 'Accent colour',
          h('input', { type: 'color', value: s.customAccent, style: { width: '56px', height: '40px', border: 0, background: 'transparent' }, onchange: (e) => set({ customAccent: e.target.value }) })) : null,
        h('span', { class: 'hint', text: `Current: ${s.theme === 'custom' ? 'Custom' : window.SlimThemes.THEMES[s.theme].name}` })),

      h('section', { class: 'card scard', 'aria-label': 'Privacy' },
        h('h2', { class: 'anton' }, 'PRIVACY'),
        h('div', { class: 'row' },
          h('span', { class: 'grow' }, s.hasPin ? 'PIN lock is on' : 'Lock Slim Takes with a PIN'),
          s.hasPin ? h('button', { type: 'button', class: 'btn', onclick: async () => { state.settings = await api.setPin(null); toast('PIN removed'); renderView(); } }, 'Remove PIN') : null,
          h('button', { type: 'button', class: 'btn', onclick: setPinDialog }, s.hasPin ? 'Change PIN' : 'Set PIN')),
        chk('blurThumbs', 'Blur thumbnails until hovered'),
        chk('clearHistoryOnClose', 'Clear history when Slim Takes quits'),
        h('span', { class: 'hint' }, 'Private mode is switched on from the Downloads screen.')),

      h('section', { class: 'card scard', 'aria-label': 'Extras' },
        h('h2', { class: 'anton' }, 'EXTRAS'),
        chk('sponsorblock', 'Skip sponsor segments (YouTube)'),
        chk('subs', 'Download subtitles (English)'),
        chk('embed', 'Embed thumbnail and video info in the file'),
        chk('clipboardWatch', 'Offer to add links I copy')),

      h('section', { class: 'card scard', 'aria-label': 'Notifications' },
        h('h2', { class: 'anton' }, 'NOTIFICATIONS'),
        chk('notifyWindows', 'Windows notifications'),
        h('label', { class: 'field' }, 'Discord webhook',
          h('input', { class: 'input', placeholder: 'https://discord.com/api/webhooks/…', value: s.discordWebhook,
            onchange: async (e) => {
              const v = e.target.value.trim();
              const r = await saveSettings({ discordWebhook: v });
              if (r.discordWebhook !== v) toast('That doesn\'t look like a Discord webhook link.');
            } })),
        h('span', { class: 'hint' }, 'Private mode downloads are never posted.')),

      h('section', { class: 'card scard', 'aria-label': 'App' },
        h('h2', { class: 'anton' }, 'APP'),
        chk('tray', 'Keep running in the tray when closed'),
        chk('startWithWindows', 'Start with Windows (in the tray)'),
        chk('checkAppUpdates', 'Tell me when a new Slim Takes is out'),
        chk('autoUpdateEngine', 'Keep the engine updated automatically'),
        h('div', { class: 'row' },
          h('span', { class: 'grow small mute', id: 'enginever' }, 'Engine: checking…'),
          h('button', { type: 'button', class: 'btn', onclick: async (e) => {
            e.target.disabled = true; e.target.textContent = 'Updating…';
            const r = await api.updateEngine();
            toast(r.ok ? `Engine: ${r.message}` : `Engine update failed: ${r.message}`);
            renderView();
          } }, 'Update engine'),
          h('button', { type: 'button', class: 'btn', onclick: async () => { if (await confirmBox('Re-download the engine?', 'Use this if downloads keep failing. It re-downloads yt-dlp, ffmpeg and Deno (about 250 MB).')) { state.engine = { ready: false }; renderSetupForce(); } } }, 'Repair engine')),
        h('div', { class: 'row' },
          h('span', { class: 'grow small mute', text: `Slim Takes v${state.version}` }),
          h('button', { type: 'button', class: 'btn', onclick: () => api.checkUpdate() }, 'Check for updates'),
          h('button', { type: 'button', class: 'btn', onclick: showLog }, 'Open log')))),
    h('footer', { class: 'appfoot' },
      h('img', { src: 'logo.png', alt: '' }),
      h('div', { class: 'col', style: { gap: '2px' } },
        h('span', {}, h('b', {}, 'Slim Takes'), ` v${state.version}`),
        h('span', {}, '© 2026 Slim Industries. All rights reserved.'),
        h('span', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigator.clipboard.writeText('slimindustries.apps@gmail.com'); toast('Email address copied'); } }, 'slimindustries.apps@gmail.com'), ' · ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.openExternal('https://github.com/slimindustries'); } }, 'GitHub')),
        h('span', { class: 'small' }, 'Powered by yt-dlp, FFmpeg and Deno.')))
  ];
}
const _viewSettings = viewSettings;
viewSettings = function () {
  const out = _viewSettings();
  api.engineVersion().then((v) => { const el = document.getElementById('enginever'); if (el) el.textContent = v ? `Engine: yt-dlp ${v} + ffmpeg + Deno` : 'Engine: not found — use Repair'; });
  return out;
};

async function renderSetupForce() {
  const r = await api.installEngine(true);
  state.engine = r.status;
  if (r.ok) { toast('Engine re-downloaded.'); renderShell(); }
  else renderSetup(r.message);
}

// ---------------------------------------------------------------- dialogs
function modal(content, { wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' }, content(close)));
  root.append(overlay);
  document.addEventListener('keydown', esc);
  const f = overlay.querySelector('button, input, video');
  if (f) f.focus();
  return close;
}

function confirmBox(title, text, { yes = 'Yes', no = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    modal((close) => [
      h('h2', { class: 'anton' }, title.toUpperCase()),
      h('p', { class: 'mute', style: { margin: 0 } }, text),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { type: 'button', class: 'btn', onclick: () => { answered = true; close(); resolve(false); } }, no),
        h('button', { type: 'button', class: 'btn primary', onclick: () => { answered = true; close(); resolve(true); } }, yes))
    ], { onClose: () => { if (!answered) resolve(false); } });
  });
}

function setPinDialog() {
  const a = h('input', { class: 'input pinbox', type: 'password', inputmode: 'numeric', maxlength: '8', 'aria-label': 'New PIN' });
  const b = h('input', { class: 'input pinbox', type: 'password', inputmode: 'numeric', maxlength: '8', 'aria-label': 'Repeat PIN' });
  const msg = h('div', { class: 'err', role: 'alert' });
  modal((close) => [
    h('h2', { class: 'anton' }, 'SET A PIN'),
    h('p', { class: 'mute', style: { margin: 0 } }, '4 to 8 digits. You\'ll need it every time Slim Takes opens. If you forget it, delete settings.json in the app\'s data folder.'),
    h('div', { class: 'col', style: { alignItems: 'center' } }, a, b, msg),
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        if (!/^\d{4,8}$/.test(a.value)) { msg.textContent = 'Use 4 to 8 digits.'; return; }
        if (a.value !== b.value) { msg.textContent = 'The two PINs don\'t match.'; return; }
        state.settings = await api.setPin(a.value);
        close(); toast('PIN set'); renderView();
      } }, 'Save PIN'))
  ]);
}

async function showLog() {
  const text = await api.log();
  const box = h('div', { class: 'logbox', text: text || 'Nothing logged yet.' });
  const off = api.on('log:line', (l) => { box.textContent += '\n' + l; box.scrollTop = box.scrollHeight; });
  modal((close) => [
    h('h2', { class: 'anton' }, 'LOG'),
    box,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      h('button', { type: 'button', class: 'btn', onclick: () => api.openLogFolder() }, 'Open data folder'),
      h('button', { type: 'button', class: 'btn', onclick: () => { navigator.clipboard.writeText(box.textContent); toast('Log copied — paste it to whoever is helping you.'); } }, 'Copy log'),
      h('button', { type: 'button', class: 'btn primary', onclick: close }, 'Close'))
  ], { wide: true, onClose: off });
  box.scrollTop = box.scrollHeight;
}

function playFile(p, title) {
  const video = h('video', { class: 'player', controls: true, autoplay: true, src: fileUrl(p) });
  const err = h('div', { class: 'err hidden' }, 'This file can\'t play inside Slim Takes. ',
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.openFile(p); } }, 'Open it in your normal player'));
  video.addEventListener('error', () => err.classList.remove('hidden'));
  modal((close) => [
    h('div', { class: 'row' }, h('span', { class: 'title1 grow', text: title }), h('button', { type: 'button', class: 'btn', onclick: () => api.openFile(p) }, 'Open in player'), h('button', { type: 'button', class: 'btn primary', onclick: close }, 'Close')),
    video, err
  ], { wide: true, onClose: () => { video.pause(); video.removeAttribute('src'); video.load(); } });
}

function whenDoneCountdown(what) {
  let left = 60;
  const label = what === 'shutdown' ? 'Shutting down' : 'Going to sleep';
  const text = h('p', { class: 'mute', style: { margin: 0 } });
  let timer = null;
  const close = modal((close) => [
    h('h2', { class: 'anton' }, 'ALL DOWNLOADS DONE'),
    text,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      h('button', { type: 'button', class: 'btn', onclick: () => { clearInterval(timer); close(); api.power(what); } }, 'Do it now'),
      h('button', { type: 'button', class: 'btn primary', onclick: close }, 'Cancel'))
  ], { onClose: () => clearInterval(timer) });
  const tick = () => {
    text.textContent = `${label} in ${left} seconds…`;
    if (left-- <= 0) { clearInterval(timer); close(); api.power(what); }
  };
  tick();
  timer = setInterval(tick, 1000);
}

// ---------------------------------------------------------------- drag & drop
function setupDragDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dropzone-on'); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dropzone-on'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dropzone-on');
    let text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    for (const f of e.dataTransfer.files || []) {
      if (/\.(txt|csv|md)$/i.test(f.name) && f.size < 5e6) text += '\n' + await f.text();
    }
    const links = await api.extractLinks(text);
    if (links.length) addLinks(links);
    else toast('No links found in what you dropped.');
  });
}

boot().catch((e) => {
  document.getElementById('app').replaceChildren(h('div', { class: 'fullcenter' }, h('div', { class: 'setup' },
    h('h1', { class: 'anton' }, 'SOMETHING WENT WRONG'), h('p', { class: 'err selectable', text: String(e && e.stack || e) }))));
});
