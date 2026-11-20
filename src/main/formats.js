'use strict';
// Turns the user's choices (format, quality, trim, extras) into yt-dlp arguments.

const VIDEO_FORMATS = ['mp4', 'mkv', 'mov', 'webm', 'avi'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'flac', 'wav', 'opus'];
const QUALITIES = ['best', '2160', '1440', '1080', '720', '480', '360'];
// Containers yt-dlp can embed a thumbnail / chapters into.
const THUMB_OK = new Set(['mp4', 'mkv', 'mov', 'm4a', 'mp3', 'flac', 'opus']);
const SUBS_OK = new Set(['mp4', 'mkv', 'mov', 'webm']);

function isAudio(fmt) { return AUDIO_FORMATS.includes(fmt); }

function heightFilter(quality) {
  return quality && quality !== 'best' ? `[height<=${parseInt(quality, 10)}]` : '';
}

// Format selector: prefer streams that already fit the container (instant, no
// re-encode), then anything at or below the chosen height, then the best there is.
function formatSelector(fmt, quality) {
  if (isAudio(fmt)) {
    if (fmt === 'm4a') return 'ba[ext=m4a]/ba/b';
    if (fmt === 'opus') return 'ba[acodec=opus]/ba/b';
    return 'ba/b';
  }
  const h = heightFilter(quality);
  const any = `bv*${h}+ba/b${h}/bv*+ba/b`;
  if (fmt === 'mp4' || fmt === 'mov' || fmt === 'avi') {
    return `bv*${h}[vcodec^=avc1]+ba[acodec^=mp4a]/bv*${h}[vcodec^=avc1]+ba/b${h}[vcodec^=avc1]/bv*${h}[ext=mp4]+ba[ext=m4a]/` + any;
  }
  if (fmt === 'webm') {
    return `bv*${h}[ext=webm]+ba[ext=webm]/b${h}[ext=webm]/` + any;
  }
  return any; // mkv takes anything
}

function timeToSeconds(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number') return t;
  const parts = String(t).trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * opts: { format, quality, trim:{start,end}, subs, sponsorblock, embed, cover,
 *         speedLimitBytes, cookiesBrowser, liveFromStart, dateAfter, dateBefore,
 *         minDuration, maxDuration, polite, ffmpegDir }
 */
function buildArgs(opts) {
  const fmt = opts.format || 'mp4';
  const args = [];

  args.push('-f', formatSelector(fmt, opts.quality || '1080'));

  if (isAudio(fmt)) {
    args.push('-x', '--audio-format', fmt, '--audio-quality', '0');
  } else if (fmt === 'avi') {
    args.push('--merge-output-format', 'mkv', '--recode-video', 'avi');
  } else if (opts.forceRecode) {
    // Fallback when the streams can't simply be repackaged into this container.
    args.push('--merge-output-format', 'mkv', '--recode-video', fmt);
  } else {
    args.push('--merge-output-format', fmt === 'mov' ? 'mp4' : fmt);
    if (fmt !== 'mkv') args.push('--remux-video', fmt);
  }

  const start = timeToSeconds(opts.trim && opts.trim.start);
  const end = timeToSeconds(opts.trim && opts.trim.end);
  if (start != null || end != null) {
    args.push('--download-sections', `*${start != null ? start : 0}-${end != null ? end : 'inf'}`);
    args.push('--force-keyframes-at-cuts');
  }

  if (opts.subs && SUBS_OK.has(fmt)) {
    args.push('--write-subs', '--sub-langs', 'en.*,en', '--embed-subs');
  }
  if (opts.sponsorblock) args.push('--sponsorblock-remove', 'sponsor');
  if (opts.embed !== false) {
    args.push('--embed-metadata');
    if (THUMB_OK.has(fmt)) args.push('--embed-thumbnail');
  }
  if (opts.cover) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  if (opts.speedLimitBytes) args.push('-r', String(Math.max(50 * 1024, Math.floor(opts.speedLimitBytes))));
  if (opts.cookiesBrowser && opts.cookiesBrowser !== 'none') args.push('--cookies-from-browser', opts.cookiesBrowser);
  if (opts.liveFromStart) args.push('--live-from-start');
  if (opts.dateAfter) args.push('--dateafter', String(opts.dateAfter).replace(/-/g, ''));
  if (opts.dateBefore) args.push('--datebefore', String(opts.dateBefore).replace(/-/g, ''));
  const filters = [];
  if (opts.minDuration) filters.push(`duration>=${Number(opts.minDuration)}`);
  if (opts.maxDuration) filters.push(`duration<=${Number(opts.maxDuration)}`);
  if (filters.length) args.push('--match-filter', filters.join(' & '));
  if (opts.polite) args.push('--sleep-requests', '1');
  if (opts.ffmpegDir) args.push('--ffmpeg-location', opts.ffmpegDir);

  return args;
}

// The extension the finished file will have.
function finalExt(fmt) {
  return fmt || 'mp4';
}

// Rough size estimate when the site doesn't tell us (channel lists usually don't).
const MBPS = { best: 8, 2160: 20, 1440: 10, 1080: 4.5, 720: 2.5, 480: 1.2, 360: 0.8 };
const AUDIO_MBPS = { mp3: 0.32, m4a: 0.16, opus: 0.13, flac: 1.0, wav: 1.41 };
function estimateBytes(durationSec, fmt, quality) {
  if (!durationSec) return 0;
  const mbps = isAudio(fmt) ? (AUDIO_MBPS[fmt] || 0.32) : (MBPS[quality] || MBPS[1080]);
  return Math.round(durationSec * mbps * 1e6 / 8);
}

module.exports = {
  VIDEO_FORMATS, AUDIO_FORMATS, QUALITIES, isAudio, formatSelector, buildArgs,
  finalExt, estimateBytes, timeToSeconds
};
