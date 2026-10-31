'use strict';
const path = require('path');

/** Category folder names, in display order. 'Files' is the catch-all. */
const CATEGORY_NAMES = ['Videos', 'Audio', 'Images', 'Files'];

const DEFAULT_CATEGORIES = {
  Videos: 'mp4 mkv webm avi mov flv wmv m4v mpg mpeg ts 3gp',
  Audio: 'mp3 m4a aac flac wav ogg opus wma aiff',
  Images: 'jpg jpeg png gif webp bmp svg tif tiff heic avif ico',
};

const MIME_MAP = [
  [/^video\//i, 'Videos'],
  [/^audio\//i, 'Audio'],
  [/^image\//i, 'Images'],
];

function parseList(s) {
  return String(s || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
}

/**
 * Decide the category folder for a job. Extension wins over content type so a renamed
 * file still lands where the user expects.
 */
function categorize({ filename, contentType, kind, quality }, categories = DEFAULT_CATEGORIES) {
  if (kind === 'video') return quality === 'audio' ? 'Audio' : 'Videos';
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  if (ext) {
    for (const name of ['Videos', 'Audio', 'Images']) {
      if (parseList(categories[name]).includes(ext)) return name;
    }
  }
  const ct = String(contentType || '');
  for (const [re, name] of MIME_MAP) if (re.test(ct)) return name;
  return 'Files';
}

function samePath(a, b) {
  const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Final directory for a job. Only auto-routes when the user kept the default root;
 * a folder they chose explicitly is respected as-is.
 */
function resolveDir({ chosenDir, baseDir, organize, category }) {
  const chosen = chosenDir || baseDir;
  if (!organize) return chosen;
  if (!samePath(chosen, baseDir)) return chosen;
  return path.join(baseDir, category);
}

module.exports = { CATEGORY_NAMES, DEFAULT_CATEGORIES, categorize, resolveDir, samePath, parseList };
