'use strict';
// File and folder naming rules.
// - The file name is the video title.
// - Characters Windows does not allow are simply removed.
// - Different videos with the same title get " (2)", " (3)" and so on.

const path = require('path');

const BANNED = /[\\/:*?"<>|]/g;
// Control characters and the zero-width / direction marks that sometimes ride along in titles.
const INVISIBLE = /[\u0000-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const MAX_NAME = 150;          // longest file or folder name we will produce
const MAX_FULL_PATH = 240;     // Windows' classic limit is 260; yt-dlp adds temp suffixes
const TEMP_SUFFIX_ROOM = 24;   // room for ".f137.mp4.part" style temp names

function cutToLength(str, max) {
  // Cut by characters, not UTF-16 units, so emoji are never split in half.
  const chars = Array.from(str);
  if (chars.length <= max) return str;
  return chars.slice(0, max).join('');
}

function cleanName(raw, fallback = 'Untitled') {
  let s = String(raw == null ? '' : raw)
    .replace(/[\t\n\r\v\f]/g, ' ')
    .replace(INVISIBLE, '')
    .replace(BANNED, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = cutToLength(s, MAX_NAME).trim();
  // Windows refuses names that end in a dot or space.
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = fallback;
  if (RESERVED.test(s) || RESERVED.test(s.split('.')[0])) s = s + '_';
  return s;
}

// Shorten a base name so the full path (folder + name + ext + temp suffix) fits.
function fitToPath(dir, base, ext) {
  const room = MAX_FULL_PATH - TEMP_SUFFIX_ROOM - dir.length - 1 - (ext ? ext.length + 1 : 0) - 5; // 5 = " (99)"
  if (room < 8) return cutToLength(base, 8).replace(/[. ]+$/g, '') || 'Video';
  if (Array.from(base).length <= room) return base;
  return cutToLength(base, room).replace(/[. ]+$/g, '') || 'Video';
}

// Remove a trailing " (2)" style counter, so "Jimmy (2)" and "Jimmy" compare as the same title.
function stripCounter(base) {
  return base.replace(/ \((\d{1,4})\)$/, '');
}

function sameTitle(a, b) {
  return stripCounter(a).toLocaleLowerCase() === stripCounter(b).toLocaleLowerCase();
}

// Pick a free name: "Title", then "Title (2)", "Title (3)" ...
// `taken(nameWithoutExt)` returns true when that name is already used.
function uniqueBase(base, taken) {
  if (!taken(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base} (${n})`;
    if (!taken(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

function creatorFolderName(info) {
  const raw = info.channel || info.uploader || info.playlist_uploader || info.playlist_channel ||
    info.creator || info.artist || info.playlist_title || info.extractor_key || 'Other';
  return cleanName(raw, 'Other');
}

// yt-dlp output templates treat % specially; a literal % must be doubled.
function escapeTemplate(p) {
  return p.replace(/%/g, '%%');
}

function splitExt(fileName) {
  const ext = path.extname(fileName);
  return { base: ext ? fileName.slice(0, -ext.length) : fileName, ext: ext.replace(/^\./, '') };
}

module.exports = {
  cleanName, fitToPath, stripCounter, sameTitle, uniqueBase, creatorFolderName,
  escapeTemplate, splitExt, MAX_NAME
};
