'use strict';
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

/** Guess the algorithm from the digest's length. */
function detectAlgorithm(hex) {
  const h = String(hex || '').trim().toLowerCase().replace(/^(md5|sha1|sha-1|sha256|sha-256|sha512|sha-512|crc32)\s*[:=]\s*/, '');
  if (!/^[0-9a-f]+$/.test(h)) return null;
  switch (h.length) {
    case 8: return { algo: 'crc32', hex: h };
    case 32: return { algo: 'md5', hex: h };
    case 40: return { algo: 'sha1', hex: h };
    case 64: return { algo: 'sha256', hex: h };
    case 128: return { algo: 'sha512', hex: h };
    default: return null;
  }
}

/** Stream a file through the hash. onProgress(bytesDone, total) is optional. */
function hashFile(filePath, algo, onProgress) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(filePath).size;
    let done = 0;
    let crc = 0;
    const hash = algo === 'crc32' ? null : crypto.createHash(algo);
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => {
      if (hash) hash.update(chunk);
      else crc = zlib.crc32(chunk, crc);
      done += chunk.length;
      if (onProgress) onProgress(done, total);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(hash ? hash.digest('hex') : (crc >>> 0).toString(16).padStart(8, '0'));
    });
  });
}

/** Compare a file against an expected digest. Returns { algo, expected, actual, match }. */
async function verifyFile(filePath, expectedHex, onProgress) {
  const d = detectAlgorithm(expectedHex);
  if (!d) throw new Error('That does not look like an MD5, SHA-1, SHA-256, SHA-512 or CRC32 checksum');
  const actual = await hashFile(filePath, d.algo, onProgress);
  return { algo: d.algo, expected: d.hex, actual, match: actual === d.hex };
}

module.exports = { detectAlgorithm, hashFile, verifyFile };
