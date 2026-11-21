'use strict';
// Turn a downloaded video file into the format the user picked (what the engine does after its own
// downloads). Used for files fetched by the multi-connection downloader.
//   mp4 -> mp4: just renamed. Other containers: repackaged without re-encoding where possible
//   (quick), converted only if that fails. Audio formats: the sound is extracted.

const fs = require('fs');
const { run } = require('./util');

const AUDIO = { mp3: ['-c:a', 'libmp3lame', '-q:a', '2'], m4a: ['-c:a', 'aac', '-b:a', '192k'], flac: ['-c:a', 'flac'], wav: ['-c:a', 'pcm_s16le'], opus: ['-c:a', 'libopus', '-b:a', '160k'] };
const REENCODE = {
  mp4: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
  mov: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'],
  mkv: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'],
  avi: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k'],
  webm: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k']
};

/** What kind of file it is, from its first bytes: 'mp4' (MP4/MOV family), 'mkv' (Matroska/WebM), or 'other'. */
function containerOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    if (/^(ftyp|moov|mdat|free|wide|skip)$/.test(b.toString('latin1', 4, 8))) return 'mp4';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'mkv';
    return 'other';
  } catch { return 'other'; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Package `src` as `format` at `outBase` + extension. Returns the final file path.
 * ffmpeg: path to ffmpeg. log(msg) optional. Throws if it can't be done.
 */
async function packageFile(src, outBase, format, ffmpeg, { log } = {}) {
  const fmt = (format || 'mp4').toLowerCase();
  const out = `${outBase}.${fmt}`;
  const kind = containerOf(src);
  const ff = async (args, what) => {
    const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...args, out], { timeout: 6 * 3600 * 1000 });
    if (r.code !== 0) {
      try { fs.unlinkSync(out); } catch { /* none */ }
      throw new Error(`Couldn't ${what}: ` + (r.stderr || '').trim().split(/\r?\n/).pop());
    }
  };
  if (AUDIO[fmt]) {
    await ff(['-vn', ...AUDIO[fmt]], 'take the sound out of the video');
  } else if (fmt === 'mp4' && kind === 'mp4') {
    fs.renameSync(src, out);
    return out;
  } else {
    try {
      await ff(['-map', '0', '-c', 'copy', ...(fmt === 'mp4' ? ['-movflags', '+faststart'] : [])], 'repackage the video');
    } catch (e) {
      if (log) log(`repackaging to ${fmt} didn't work, converting instead`);
      await ff(['-map', '0:v:0?', '-map', '0:a?', ...(REENCODE[fmt] || REENCODE.mp4)], 'convert the video');
    }
  }
  try { fs.unlinkSync(src); } catch { /* in use */ }
  return out;
}

module.exports = { packageFile, containerOf };
