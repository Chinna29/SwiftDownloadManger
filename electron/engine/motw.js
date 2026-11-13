'use strict';
const fsp = require('fs/promises');

/**
 * Mark a downloaded file as coming from the internet, the way browsers do, so SmartScreen
 * checks programs before they first run and Office opens documents in Protected View.
 * Windows only: writes the Zone.Identifier alternate data stream. Silently a no-op elsewhere
 * or on file systems without streams (FAT, exFAT).
 */
async function markFromInternet(filePath, { url, referer } = {}) {
  if (process.platform !== 'win32' || !filePath) return false;
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  if (referer && /^https?:/i.test(referer)) lines.push('ReferrerUrl=' + referer.slice(0, 2048));
  if (url && /^https?:/i.test(url)) lines.push('HostUrl=' + url.slice(0, 2048));
  try {
    await fsp.writeFile(filePath + ':Zone.Identifier', lines.join('\r\n') + '\r\n');
    return true;
  } catch {
    return false;
  }
}

module.exports = { markFromInternet };
