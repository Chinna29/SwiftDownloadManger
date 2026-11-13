'use strict';
// Google Drive share links -> a direct, resumable download URL with the file's real name.
const { request, sanitizeFilename, parseContentDisposition } = require('./http');

const ID_PATTERNS = [
  /drive\.google\.com\/file\/d\/([\w-]+)/i,
  /drive\.google\.com\/(?:uc|open)\?(?:.*&)?id=([\w-]+)/i,
  /docs\.google\.com\/(document|spreadsheets|presentation|drawings)\/d\/([\w-]+)/i,
  /drive\.usercontent\.google\.com\/download\?(?:.*&)?id=([\w-]+)/i,
];

const DOC_EXPORT = {
  document: { mime: 'docx', ext: '.docx' },
  spreadsheets: { mime: 'xlsx', ext: '.xlsx' },
  presentation: { mime: 'pptx', ext: '.pptx' },
  drawings: { mime: 'png', ext: '.png' },
};

function isDriveUrl(url) {
  return ID_PATTERNS.some((re) => re.test(url));
}

function parse(url) {
  for (const re of ID_PATTERNS) {
    const m = re.exec(url);
    if (!m) continue;
    if (m.length === 3) return { id: m[2], doc: m[1] };
    return { id: m[1], doc: null };
  }
  return null;
}

async function readBody(res, limit = 2 * 1024 * 1024) {
  let s = '';
  for await (const c of res) { s += c.toString('utf8'); if (s.length > limit) break; }
  return s;
}

/**
 * Resolve a Drive link. Returns { url, filename, headers } where url can be downloaded
 * directly (with the given headers: cookies carried over from the confirm step).
 */
async function resolveDrive(url, headers = {}) {
  const p = parse(url);
  if (!p) throw new Error('Not a Google Drive link');

  if (p.doc) {
    const exp = DOC_EXPORT[p.doc];
    const direct = `https://docs.google.com/${p.doc}/d/${p.id}/export?format=${exp.mime}`;
    return { url: direct, filename: null, ext: exp.ext, headers, resumable: false, note: 'Google ' + p.doc + ' exported as ' + exp.ext.slice(1).toUpperCase() };
  }

  const first = `https://drive.usercontent.google.com/download?id=${p.id}&export=download`;
  const res = await request(first, { headers: { ...headers, Accept: '*/*' } });
  const ct = String(res.headers['content-type'] || '');
  if (!/text\/html/i.test(ct)) {
    // Small files come straight back.
    const cd = parseContentDisposition(res.headers['content-disposition']);
    res.destroy();
    return { url: res.finalUrl || first, filename: cd ? sanitizeFilename(cd) : null, headers, resumable: true };
  }
  const cookies = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const html = await readBody(res);

  if (/Too many users have viewed or downloaded this file recently/i.test(html)) throw new Error('Google Drive: too many users have viewed or downloaded this file recently. Try again later.');
  if (/You need access|Request access|Sign in/i.test(html) && !/confirm|uuid/i.test(html)) throw new Error('Google Drive: this file needs you to sign in. Download it from the browser so the extension can pass your Google session.');
  if (/folders\//i.test(url) || /application\/vnd\.google-apps\.folder/.test(html)) throw new Error('This is a Google Drive folder, not a file');

  // The "can't scan this file for viruses" page: a form whose hidden inputs we replay.
  const form = /<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) throw new Error('Google Drive did not offer a download for this file');
  const action = form[1].replace(/&amp;/g, '&');
  const params = new URLSearchParams();
  const inputRe = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
  let m;
  while ((m = inputRe.exec(form[2]))) params.set(m[1], m[2].replace(/&amp;/g, '&'));
  const direct = action + (action.includes('?') ? '&' : '?') + params.toString();
  const nameMatch = /<span class="uc-name-size"><a[^>]*>([^<]+)<\/a>/i.exec(html) || /class="uc-name-size">\s*<a[^>]*>([^<]+)</i.exec(html);
  const outHeaders = { ...headers };
  if (cookies) outHeaders.Cookie = outHeaders.Cookie ? outHeaders.Cookie + '; ' + cookies : cookies;

  // Drive answers a ranged probe on this URL with 206, yet can still serve an error page to the
  // real request (quota exceeded, abuse check). Ask once for the real body before trusting it.
  const check = await request(direct, { headers: { ...outHeaders, Accept: '*/*' } });
  const checkType = String(check.headers['content-type'] || '');
  if (/text\/html/i.test(checkType)) {
    const page = await readBody(check, 256 * 1024);
    const caption = /class="uc-error-(?:sub)?caption"[^>]*>([^<]+)</i.exec(page);
    const title = /<title>([^<]*)<\/title>/i.exec(page);
    const reason = (caption && caption[1].trim()) || (title && title[1].replace(/Google Drive\s*-\s*/i, '').trim()) || 'the file is not downloadable right now';
    throw new Error('Google Drive: ' + reason);
  }
  const cd = parseContentDisposition(check.headers['content-disposition']);
  check.destroy();
  return { url: direct, filename: (cd && sanitizeFilename(cd)) || (nameMatch ? sanitizeFilename(nameMatch[1].trim()) : null), headers: outHeaders, resumable: false };
}

module.exports = { isDriveUrl, resolveDrive };
