'use strict';
const path = require('path');

// The GitHub repo the app checks for new releases. Change this if the repo name differs.
const UPDATE_REPO = 'slimindustries/slim-takes';

function defaults(videosDir) {
  return {
    folder: path.join(videosDir, 'SlimTakes'),
    format: 'mp4',
    quality: '1080',
    concurrent: 3,
    speedLimitMB: 0,
    polite: true,
    retries: 2,
    minFreeGB: 10,
    whenDone: 'nothing',
    sponsorblock: true,
    subs: false,
    embed: true,
    setFileDate: true,
    cover: false,
    cookiesBrowser: 'none',
    notifyWindows: true,
    discordWebhook: '',
    blurThumbs: false,
    clearHistoryOnClose: false,
    pinHash: null,
    pinSalt: null,
    tray: true,
    startWithWindows: false,
    watchInterval: '2h',
    theme: 'crimson',
    customAccent: '#ff3b3b',
    clipboardWatch: true,
    checkAppUpdates: true,
    autoUpdateEngine: true,
    lastEngineUpdate: 0,
    trayHintShown: false,
    autoClearDays: 0,
    windowBounds: null
  };
}

// Only these keys may be changed from the window, each with a check.
const RULES = {
  folder: (v) => typeof v === 'string' && v.length > 2 && v.length < 200,
  format: (v) => ['mp4', 'mkv', 'mov', 'webm', 'avi', 'mp3', 'm4a', 'flac', 'wav', 'opus'].includes(v),
  quality: (v) => ['best', '2160', '1440', '1080', '720', '480', '360'].includes(v),
  concurrent: (v) => Number.isInteger(v) && v >= 1 && v <= 8,
  speedLimitMB: (v) => typeof v === 'number' && v >= 0 && v <= 1000,
  polite: (v) => typeof v === 'boolean',
  retries: (v) => Number.isInteger(v) && v >= 0 && v <= 5,
  minFreeGB: (v) => typeof v === 'number' && v >= 0 && v <= 500,
  whenDone: (v) => ['nothing', 'sleep', 'shutdown'].includes(v),
  sponsorblock: (v) => typeof v === 'boolean',
  subs: (v) => typeof v === 'boolean',
  embed: (v) => typeof v === 'boolean',
  setFileDate: (v) => typeof v === 'boolean',
  cover: (v) => typeof v === 'boolean',
  cookiesBrowser: (v) => ['none', 'firefox', 'chrome', 'edge', 'brave', 'opera', 'vivaldi'].includes(v),
  notifyWindows: (v) => typeof v === 'boolean',
  discordWebhook: (v) => typeof v === 'string' && (v === '' || /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(v)),
  blurThumbs: (v) => typeof v === 'boolean',
  clearHistoryOnClose: (v) => typeof v === 'boolean',
  tray: (v) => typeof v === 'boolean',
  startWithWindows: (v) => typeof v === 'boolean',
  watchInterval: (v) => ['1h', '2h', '6h', '12h', '24h', 'manual'].includes(v),
  theme: (v) => ['crimson', 'ice', 'toxic', 'amber', 'violet', 'daylight', 'custom'].includes(v),
  customAccent: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
  clipboardWatch: (v) => typeof v === 'boolean',
  checkAppUpdates: (v) => typeof v === 'boolean',
  autoUpdateEngine: (v) => typeof v === 'boolean',
  autoClearDays: (v) => [0, 1, 7, 30].includes(v)
};

function applyPatch(current, patch) {
  const next = { ...current };
  const rejected = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (RULES[k] && RULES[k](v)) next[k] = v;
    else rejected.push(k);
  }
  return { next, rejected };
}

function publicSettings(s) {
  const { pinHash, pinSalt, windowBounds, ...rest } = s;
  return { ...rest, hasPin: !!pinHash };
}

module.exports = { defaults, applyPatch, publicSettings, UPDATE_REPO };
