'use strict';
// Reads yt-dlp's output lines and turns them into status updates.

const PROGRESS_TAG = 'STPROG|';
const DONE_TAG = 'STDONE|';

const PROGRESS_TEMPLATE =
  'download:' + PROGRESS_TAG +
  '%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s';

const DONE_PRINT = 'after_move:' + DONE_TAG + '%(filepath)s|%(timestamp)s|%(upload_date)s|%(duration)s|%(id)s|%(extractor_key)s';

function num(v) {
  if (v == null || v === '' || v === 'NA' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseLine(line) {
  const s = String(line).replace(/\r/g, '').trim();
  if (!s) return null;

  if (s.startsWith(PROGRESS_TAG)) {
    const [status, done, total, est, speed, eta, fi, fc] = s.slice(PROGRESS_TAG.length).split('|');
    const downloaded = num(done);
    let totalBytes = num(total) || num(est);
    let pct = null;
    if (downloaded != null && totalBytes) pct = Math.min(100, (downloaded / totalBytes) * 100);
    else if (num(fi) != null && num(fc)) pct = Math.min(100, (num(fi) / num(fc)) * 100);
    return { type: 'progress', status, downloaded, total: totalBytes, speed: num(speed), eta: num(eta), pct };
  }

  if (s.startsWith(DONE_TAG)) {
    // The file path itself can contain "|", so split from the right.
    const rest = s.slice(DONE_TAG.length);
    const parts = rest.split('|');
    const extractor = parts.pop();
    const id = parts.pop();
    const duration = num(parts.pop());
    const uploadDate = parts.pop();
    const timestamp = num(parts.pop());
    const filepath = parts.join('|');
    return { type: 'done', filepath, timestamp, uploadDate: uploadDate === 'NA' ? null : uploadDate, duration, id, extractor };
  }

  if (/^ERROR:/i.test(s)) return { type: 'error', message: s.replace(/^ERROR:\s*/i, '') };
  if (/^WARNING:/i.test(s)) return { type: 'warning', message: s.replace(/^WARNING:\s*/i, '') };

  if (/upload date is not in range|does not pass filter|has already been recorded in the archive/i.test(s)) {
    return { type: 'skipped', message: s.replace(/^\[[^\]]+\]\s*/, '') };
  }
  if (/^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|FFmpeg\w*|SponsorBlock|ModifyChapters|EmbedThumbnail|Metadata|ThumbnailsConvertor|FixupM3u8|SplitChapters)\]/.test(s)) {
    return { type: 'processing', message: s };
  }
  return { type: 'log', message: s };
}

// "20261118" or a unix timestamp -> Date (or null)
function uploadDateToDate(uploadDate, timestamp) {
  if (timestamp) return new Date(timestamp * 1000);
  if (uploadDate && /^\d{8}$/.test(uploadDate)) {
    const y = +uploadDate.slice(0, 4), m = +uploadDate.slice(4, 6), d = +uploadDate.slice(6, 8);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  }
  return null;
}

module.exports = { parseLine, PROGRESS_TEMPLATE, DONE_PRINT, uploadDateToDate };
