'use strict';
// Link discovery and batch patterns: pull download links out of pasted text, HTML, Markdown or
// an IDM .ef2 export, expand "photo*.jpg" style batch patterns, and group links into packages.
const path = require('path');
const { request, probe } = require('./http');

const URL_RE = /\b(?:https?|ftp|ftps|ftpes):\/\/[^\s<>"'()\[\]{}]+|magnet:\?[^\s<>"']+/gi;
const MD_RE = /\[[^\]]*\]\(\s*(<?)((?:https?|ftp|ftps|magnet)[^)\s]+)\1\s*\)/gi;
const HREF_RE = /(?:href|src)\s*=\s*(["'])(.*?)\1/gi;
const PAGE_EXT = /\.(html?|php|aspx?|jsp|cfm|cgi|xhtml)(\?|#|$)/i;
const ARCHIVE_VOLUME_RE = /^(.*?)(?:\.part(\d+)\.rar|\.r(\d{2})|\.(7z|zip|tar(?:\.gz)?)\.(\d{3})|\.z(\d{2}))$/i;

function trimPunct(u) {
  return u.replace(/[.,;:!?'")\]}>]+$/, '');
}

/**
 * Every download link in a blob of text. Handles bare URLs, Markdown links, HTML href/src
 * (resolved against baseUrl), and IDM .ef2 blocks (URL plus referer and cookie lines).
 * Returns [{ url, referer?, cookie? }] with each URL once, in order of first appearance.
 */
function extractLinks(text, baseUrl = null) {
  const out = [];
  const seen = new Set();
  const add = (url, extra = {}) => {
    if (!url) return;
    let u = trimPunct(String(url).trim());
    if (baseUrl && !/^(https?|ftp|ftps|ftpes|magnet):/i.test(u)) {
      try { u = new URL(u, baseUrl).toString(); } catch { return; }
    }
    if (!/^(https?|ftp|ftps|ftpes|magnet):/i.test(u)) return;
    if (/^(https?|ftp|ftps|ftpes):\/\/[^/]+\/?$/i.test(u) && baseUrl) return; // a page's own origin
    const key = u.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: u, ...extra });
  };

  const src = String(text || '');

  // IDM export format: "<" newline URL newline "referer: ..." newline "cookie: ..." newline ">"
  if (/^\s*<\s*$/m.test(src) && /^\s*>\s*$/m.test(src)) {
    const blocks = src.split(/^\s*<\s*$/m).slice(1);
    for (const block of blocks) {
      const body = block.split(/^\s*>\s*$/m)[0];
      const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const extra = {};
      for (const l of lines.slice(1)) {
        const m = /^(referer|cookie|user-agent|filename)\s*:\s*(.*)$/i.exec(l);
        if (m) extra[m[1].toLowerCase()] = m[2];
      }
      add(lines[0], extra);
    }
    if (out.length) return out;
  }

  let m;
  while ((m = MD_RE.exec(src))) add(m[2]);
  while ((m = HREF_RE.exec(src))) add(m[2]);
  while ((m = URL_RE.exec(src))) add(m[0]);
  return out;
}

/** Fetch a web page and list the links on it. */
async function linksFromPage(url, headers = {}) {
  const res = await request(url, { headers: { ...headers, Accept: 'text/html,*/*' } });
  const ct = String(res.headers['content-type'] || '');
  if (!/html|xml/i.test(ct)) { res.destroy(); throw new Error('Not a web page (' + (ct || 'unknown type') + ')'); }
  let html = '';
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) { res.destroy(); break; }
    html += chunk.toString('utf8');
  }
  const links = extractLinks(html, res.finalUrl || url);
  let title = '';
  const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (t) title = t[1].replace(/\s+/g, ' ').trim();
  return { title, links: links.filter((l) => l.url !== (res.finalUrl || url)) };
}

/**
 * Expand a batch pattern with one asterisk: numbers (with zero padding) or letters.
 *   expandPattern('https://x/photo*.jpg', { kind: 'numbers', from: 1, to: 150, width: 3 })
 */
function expandPattern(pattern, { kind = 'numbers', from = 1, to = 10, width = 1 } = {}) {
  const idx = pattern.indexOf('*');
  if (idx < 0 || pattern.indexOf('*', idx + 1) >= 0) throw new Error('Put exactly one * where the number or letter changes');
  const head = pattern.slice(0, idx);
  const tail = pattern.slice(idx + 1);
  const out = [];
  if (kind === 'letters') {
    const a = String(from).toLowerCase().charCodeAt(0);
    const b = String(to).toLowerCase().charCodeAt(0);
    const upper = /[A-Z]/.test(String(from));
    for (let c = Math.min(a, b); c <= Math.max(a, b); c++) {
      const ch = String.fromCharCode(c);
      out.push(head + (upper ? ch.toUpperCase() : ch) + tail);
    }
  } else {
    const lo = Number(from), hi = Number(to);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('From and To must be numbers');
    if (Math.abs(hi - lo) > 10000) throw new Error('That range would create more than 10,000 downloads');
    const step = hi >= lo ? 1 : -1;
    for (let n = lo; step > 0 ? n <= hi : n >= hi; n += step) {
      out.push(head + String(n).padStart(Math.max(1, Number(width) || 1), '0') + tail);
    }
  }
  return out;
}

/** Detect a pattern in a single URL: "ep01.mp4" -> { pattern: 'ep*.mp4', from: 1, width: 2 }. */
function suggestPattern(url) {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() || '';
    // The number that changes is the last digit run before the extension ("ep01.mp4" -> 01, not the 4).
    const ext = path.extname(file);
    const stem = file.slice(0, file.length - ext.length);
    const m = /^(.*?)(\d+)(\D*)$/.exec(stem);
    if (!m || !m[2]) return null;
    const base = u.origin + u.pathname.slice(0, u.pathname.length - file.length);
    return { pattern: base + m[1] + '*' + m[3] + ext + u.search, from: Number(m[2]), width: m[2].length, kind: 'numbers' };
  } catch {
    return null;
  }
}

/** Group links into packages: archive volumes together, then by site. */
function groupIntoPackages(links) {
  const packages = new Map();
  for (const l of links) {
    let host = 'Various files';
    let file = '';
    try {
      const u = new URL(l.url);
      host = u.hostname.replace(/^www\./, '');
      file = decodeURIComponent(u.pathname.split('/').pop() || '');
    } catch { /* magnet or odd URL */ }
    let name = host;
    const vol = ARCHIVE_VOLUME_RE.exec(file);
    if (vol) name = vol[1] + ' (archive, ' + host + ')';
    if (/^magnet:/i.test(l.url)) name = 'Magnet links';
    if (!packages.has(name)) packages.set(name, { name, host, links: [] });
    packages.get(name).links.push({ ...l, file, isPage: PAGE_EXT.test(l.url), volume: !!vol });
  }
  return [...packages.values()];
}

/**
 * Ask servers about each link (name, size, resumable), a few at a time and at most two per
 * host at once. onUpdate(index, info) is called as results arrive.
 */
async function lookupLinks(links, { headers = {}, concurrency = 6, perHost = 2, onUpdate } = {}) {
  const results = new Array(links.length).fill(null);
  const perHostActive = new Map();
  let next = 0;
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

  async function worker() {
    for (;;) {
      let i = -1;
      for (let k = next; k < links.length; k++) {
        if (results[k] !== null) continue;
        const h = hostOf(links[k].url);
        if ((perHostActive.get(h) || 0) < perHost) { i = k; break; }
      }
      if (i < 0) {
        if (next >= links.length && results.every((r) => r !== null)) return;
        await new Promise((r) => setTimeout(r, 150));
        if (results.every((r) => r !== null)) return;
        continue;
      }
      results[i] = { pending: true };
      while (next < links.length && results[next] !== null) next++;
      const h = hostOf(links[i].url);
      perHostActive.set(h, (perHostActive.get(h) || 0) + 1);
      let info;
      const link = links[i];
      if (/^magnet:/i.test(link.url)) {
        info = { status: 'magnet', filename: 'Magnet link', size: null };
      } else if (!/^https?:/i.test(link.url)) {
        info = { status: 'ftp', filename: path.basename(link.url), size: null };
      } else {
        try {
          const extra = {};
          if (link.referer) extra.Referer = link.referer;
          if (link.cookie) extra.Cookie = link.cookie;
          const p = await probe(link.url, { ...headers, ...extra });
          const isPage = /^text\/html/i.test(p.contentType || '');
          info = { status: isPage ? 'page' : 'online', filename: p.filename, size: p.size, resumable: p.resumable, contentType: p.contentType, finalUrl: p.finalUrl };
        } catch (e) {
          const msg = String(e.message || '');
          info = { status: /401|403/.test(msg) ? 'login' : /404|410/.test(msg) ? 'offline' : /429|503/.test(msg) ? 'busy' : 'error', error: msg };
        }
      }
      results[i] = info;
      perHostActive.set(h, perHostActive.get(h) - 1);
      if (onUpdate) onUpdate(i, info);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, worker));
  return results;
}

/** IDM-compatible .ef2 text for a set of jobs. */
function toEf2(jobs) {
  return jobs.map((j) => {
    const lines = ['<', j.url];
    if (j.headers?.Referer) lines.push('referer: ' + j.headers.Referer);
    if (j.headers?.Cookie) lines.push('cookie: ' + j.headers.Cookie);
    lines.push('>');
    return lines.join('\r\n');
  }).join('\r\n') + '\r\n';
}

module.exports = { extractLinks, linksFromPage, expandPattern, suggestPattern, groupIntoPackages, lookupLinks, toEf2 };
