'use strict';
const http = require('http');

/**
 * Tiny loopback HTTP API the browser extension talks to.
 *   GET  /ping          -> { ok, app, version }
 *   POST /add           -> { url, filename?, referer?, cookies?, userAgent? }
 *   GET  /jobs          -> snapshot
 * Only extension origins (or requests with no Origin, e.g. curl) are accepted,
 * so a random web page cannot push downloads into the app.
 */
function startBridge({ port, version, queue, ytdlp, onAdded }) {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const allowed = !origin || /^(chrome|moz|edge|safari-web)-extension:\/\//i.test(origin);

    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      res.writeHead(allowed ? 204 : 403);
      return res.end();
    }
    if (!allowed) return json(res, 403, { ok: false, error: 'Origin not allowed' });

    try {
      if (req.method === 'GET' && req.url === '/ping') {
        return json(res, 200, {
          ok: true, app: 'SwiftFetch', version,
          tools: { ytdlp: !!ytdlp?.hasYtDlp(), ffmpeg: !!ytdlp?.hasFfmpeg() },
        });
      }
      if (req.method === 'POST' && req.url === '/probe') {
        const body = await readJson(req);
        if (!ytdlp || !ytdlp.hasYtDlp()) {
          return json(res, 200, { ok: false, error: 'yt-dlp is not installed. Open SwiftFetch → Settings → Video downloads → Install.', needsInstall: true });
        }
        try {
          const info = await ytdlp.probe(body.url);
          return json(res, 200, { ok: true, info, tools: { ffmpeg: ytdlp.hasFfmpeg() } });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message });
        }
      }
      if (req.method === 'GET' && req.url === '/jobs') {
        return json(res, 200, { ok: true, jobs: queue.snapshot() });
      }
      if (req.method === 'POST' && req.url === '/add') {
        const body = await readJson(req);
        const headers = {};
        if (body.referer) headers.Referer = body.referer;
        if (body.cookies) headers.Cookie = body.cookies;
        if (body.userAgent) headers['User-Agent'] = body.userAgent;
        const id = await queue.add({
          url: body.url,
          filename: body.filename || undefined,
          headers,
          source: 'browser',
          kind: body.kind === 'video' ? 'video' : 'file',
          quality: body.quality || undefined,
        });
        if (onAdded) onAdded(id);
        return json(res, 200, { ok: true, id });
      }
      json(res, 404, { ok: false, error: 'Not found' });
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
  });

  return new Promise((resolve) => {
    server.on('error', (e) => {
      console.error('Bridge server error:', e.message);
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

module.exports = { startBridge };
