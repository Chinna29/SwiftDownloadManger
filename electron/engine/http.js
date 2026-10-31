'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_REDIRECTS = 10;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SwiftFetch/0.1';

/**
 * Issue an HTTP(S) request, following redirects. Resolves with the IncomingMessage.
 * The caller is responsible for consuming or destroying the response.
 */
function request(url, { method = 'GET', headers = {}, signal, timeout = 30000 } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Invalid URL: ' + url)); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return reject(new Error('Unsupported protocol: ' + u.protocol));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method,
      headers: { 'User-Agent': DEFAULT_UA, 'Accept': '*/*', 'Accept-Encoding': 'identity', ...headers },
      signal,
    }, (res) => {
      const status = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, u).toString();
        const nextMethod = status === 303 ? 'GET' : method;
        return request(next, { method: nextMethod, headers, signal, timeout }, redirects + 1).then(resolve, reject);
      }
      res.finalUrl = u.toString();
      resolve(res);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function parseContentDisposition(value) {
  if (!value) return null;
  // RFC 5987: filename*=UTF-8''encoded
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
  if (star) {
    try { return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(value);
  if (plain) return (plain[2] ?? plain[3] ?? '').trim();
  return null;
}

function sanitizeFilename(name) {
  let n = String(name || '').replace(/[\/:*?"<>|\x00-\x1f]/g, '_').trim();
  n = n.replace(/^\.+$/, '').replace(/[. ]+$/, '');
  if (!n) n = 'download';
  if (n.length > 180) n = n.slice(0, 180);
  return n;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) return sanitizeFilename(decodeURIComponent(last));
    return sanitizeFilename(u.hostname) || 'download';
  } catch {
    return 'download';
  }
}

/**
 * Probe a URL with a 1-byte ranged GET. One request tells us the size,
 * whether the server honours Range requests, the final URL and a filename.
 */
async function probe(url, headers = {}, signal) {
  const res = await request(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal });
  const status = res.statusCode;
  let size = null;
  let resumable = false;

  if (status === 206) {
    resumable = true;
    const m = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(res.headers['content-range'] || '');
    if (m && m[1] !== '*') size = Number(m[1]);
  } else if (status === 200) {
    if (res.headers['content-length']) size = Number(res.headers['content-length']);
    resumable = /bytes/i.test(res.headers['accept-ranges'] || '');
  } else if (status === 416) {
    // Empty file or server quirk: fall back to plain HEAD-like info.
    size = 0;
  } else {
    res.resume();
    throw new Error(`Server responded with HTTP ${status}`);
  }

  const cd = parseContentDisposition(res.headers['content-disposition']);
  const filename = cd ? sanitizeFilename(cd) : filenameFromUrl(res.finalUrl);
  const contentType = (res.headers['content-type'] || '').split(';')[0].trim();
  res.destroy();

  return { url, finalUrl: res.finalUrl, size, resumable, filename, contentType };
}

module.exports = { request, probe, sanitizeFilename, filenameFromUrl, DEFAULT_UA };
