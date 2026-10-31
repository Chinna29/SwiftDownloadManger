'use strict';
// SwiftFetch browser integration (Manifest V3 service worker).
//  - Intercepts browser downloads and hands them to the app over 127.0.0.1:<port>.
//  - Adds "Download with SwiftFetch" to the context menu for links and media.
//  - Watches responses for video/audio so the popup can offer them for download.

const DEFAULTS = { enabled: true, pageButton: true, relayBlobs: true, port: 47831, minSizeKB: 0, skipExtensions: [], hiddenHosts: [] };
const MEDIA_TYPES = /^(video|audio)\//i;
const MEDIA_EXT = /\.(mp4|webm|mkv|m4v|mov|avi|flv|mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i;

let settingsCache = null;
async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.local.get(DEFAULTS);
  settingsCache = { ...DEFAULTS, ...stored };
  return settingsCache;
}
chrome.storage.onChanged.addListener(() => { settingsCache = null; });

function base(port, path) {
  return 'http://127.0.0.1:' + port + path;
}

async function ping(port, timeoutMs = 600) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(base(port, '/ping'), { signal: ctrl.signal });
    const j = await r.json();
    return !!j.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function cookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => c.name + '=' + c.value).join('; ');
  } catch {
    return '';
  }
}

// Sites whose extractors talk to sibling domains; include their cookies too.
const COOKIE_SIBLINGS = {
  'x.com': ['twitter.com'],
  'twitter.com': ['x.com'],
  'facebook.com': ['fb.com', 'fbcdn.net'],
  'instagram.com': ['facebook.com'],
  'youtube.com': ['google.com'],
};

function registrableDomain(hostname) {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const twoLevel = /^(co|com|net|org|gov|edu|ac)$/i.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2;
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

/**
 * Collect every cookie for the page's site (all subdomains) plus known sibling
 * domains, in the shape yt-dlp needs for a Netscape cookie file. Used only for
 * video downloads sent from the browser, and only for that one job.
 */
async function collectCookieJar(pageUrl, refererUrl) {
  const domains = new Set();
  for (const u of [pageUrl, refererUrl]) {
    try {
      const host = new URL(u).hostname;
      const base = registrableDomain(host);
      domains.add(base);
      for (const sib of COOKIE_SIBLINGS[base] || []) domains.add(sib);
    } catch { /* ignore bad urls */ }
  }
  const jar = [];
  const seen = new Set();
  for (const domain of domains) {
    let list = [];
    try { list = await chrome.cookies.getAll({ domain }); } catch { continue; }
    for (const c of list) {
      const key = c.domain + '|' + c.path + '|' + c.name;
      if (seen.has(key)) continue;
      seen.add(key);
      jar.push({
        domain: c.domain, path: c.path, name: c.name, value: c.value,
        secure: !!c.secure, httpOnly: !!c.httpOnly,
        expirationDate: c.expirationDate || 0,
      });
    }
  }
  return jar;
}

async function sendToApp({ url, filename, referer, kind, quality }) {
  const s = await getSettings();
  const isVideo = kind === 'video';
  const payload = {
    url,
    kind: isVideo ? 'video' : 'file',
    quality: quality || undefined,
    filename: filename || undefined,
    referer: referer || undefined,
    cookies: isVideo ? undefined : await cookieHeader(url),
    cookieJar: isVideo ? await collectCookieJar(url, referer) : undefined,
    userAgent: navigator.userAgent,
  };
  const r = await fetch(base(s.port, '/add'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'App rejected the download');
  return j.id;
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message }).catch?.(() => {});
}

/* ---------- download interception ---------- */

const handled = new Set();
// Downloads Chrome must finish itself (blob:, data:); once complete, the file is moved into SwiftDM.
const relayIds = new Map(); // downloadId -> { url, referer, startedAt }

chrome.downloads.onCreated.addListener(async (item) => {
  if (handled.has(item.id)) return;
  handled.add(item.id);

  const s = await getSettings();
  if (!s.enabled) return;
  const url = item.finalUrl || item.url;
  if (item.byExtensionId) return;
  if (/^(blob|data):/i.test(url)) {
    // The bytes live only in the page; let Chrome save them, then relay the finished file.
    if (s.relayBlobs) relayIds.set(item.id, { url: item.url.slice(0, 200), referer: item.referrer || '', startedAt: Date.now() });
    return;
  }
  if (!/^https?:/i.test(url)) return; // file: and other schemes stay in the browser

  const name = (item.filename || '').split(/[\\/]/).pop() || url.split('/').pop().split('?')[0];
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (s.skipExtensions.includes(ext)) return;
  if (s.minSizeKB > 0 && item.fileSize > 0 && item.fileSize < s.minSizeKB * 1024) return;

  if (!(await ping(s.port))) return; // app not running: let the browser handle it

  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
    await sendToApp({ url, filename: name, referer: item.referrer });
  } catch (e) {
    console.warn('SwiftFetch: could not hand off download', e);
    notify('SwiftFetch', 'Could not send download to the app: ' + e.message);
  }
});

/* ---------- blob / data download relay ---------- */

chrome.downloads.onChanged.addListener(async (delta) => {
  const pending = relayIds.get(delta.id);
  if (!pending) return;
  if (delta.state && delta.state.current === 'interrupted') { relayIds.delete(delta.id); return; }
  if (!delta.state || delta.state.current !== 'complete') return;
  relayIds.delete(delta.id);

  const s = await getSettings();
  if (!s.relayBlobs || !(await ping(s.port))) return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item || !item.filename || !item.exists) return;

  try {
    const r = await fetch(base(s.port, '/import'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: item.filename,
        filename: item.filename.split(/[\\/]/).pop(),
        url: pending.referer || pending.url,
        referer: pending.referer,
        mime: item.mime || '',
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'App rejected the file');
    // The file now lives in SwiftDM; drop Chrome's entry so it does not point at a moved file.
    await chrome.downloads.erase({ id: delta.id });
  } catch (e) {
    console.warn('SwiftFetch: blob relay failed, file left in the browser download folder', e);
  }
});

/* ---------- context menu ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sf-link', title: 'Download link with SwiftFetch', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'sf-media', title: 'Download media with SwiftFetch', contexts: ['image', 'video', 'audio'] });
    chrome.contextMenus.create({ id: 'sf-page', title: 'Download video from this page with SwiftFetch', contexts: ['page', 'video'] });
    chrome.contextMenus.create({ id: 'sf-link-video', title: 'Download link as video with SwiftFetch', contexts: ['link'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'sf-link' || info.menuItemId === 'sf-link-video' ? info.linkUrl
    : info.menuItemId === 'sf-media' ? info.srcUrl
    : info.pageUrl;
  const kind = info.menuItemId === 'sf-page' || info.menuItemId === 'sf-link-video' ? 'video' : 'file';
  if (!url || !/^https?:/i.test(url)) return;
  const s = await getSettings();
  if (!(await ping(s.port))) {
    notify('SwiftFetch is not running', 'Start the SwiftFetch app and try again.');
    return;
  }
  try {
    await sendToApp({ url, referer: tab?.url, kind });
  } catch (e) {
    notify('SwiftFetch', e.message);
  }
});

/* ---------- media detection ---------- */

const mediaByTab = new Map(); // tabId -> Map(url -> {url, type, size, seenAt})

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = Object.fromEntries((details.responseHeaders || []).map((h) => [h.name.toLowerCase(), h.value || '']));
    const ct = (headers['content-type'] || '').split(';')[0].trim();
    const len = Number(headers['content-length'] || 0);
    const isHls = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(details.url);
    const isDash = /dash\+xml/i.test(ct) || /\.mpd(\?|$)/i.test(details.url);
    const isMedia = MEDIA_TYPES.test(ct) || MEDIA_EXT.test(details.url) || details.type === 'media';
    if (!isMedia && !isHls && !isDash) return;
    // Individual HLS fragments are noise; the playlist is what yt-dlp needs.
    if (!isHls && !isDash && /\.(ts|m4s|aac)(\?|$)/i.test(details.url) && /\/(seg|segment|chunk|frag|media)[-_]?\d+/i.test(details.url)) return;

    let list = mediaByTab.get(details.tabId);
    if (!list) { list = new Map(); mediaByTab.set(details.tabId, list); }
    const clean = details.url.split('#')[0];
    const prev = list.get(clean);
    const kind = isHls || isDash ? 'stream' : 'file';
    const label = isHls ? 'HLS stream (m3u8)' : isDash ? 'DASH stream (mpd)' : (ct || 'media');
    list.set(clean, { url: clean, type: label, kind, size: Math.max(len, prev?.size || 0), seenAt: Date.now(), referer: details.initiator || '' });
    if (list.size > 30) list.delete(list.keys().next().value);
    updateBadge(details.tabId);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

function updateBadge(tabId) {
  const n = mediaByTab.get(tabId)?.size || 0;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f8cff' });
}

chrome.tabs.onRemoved.addListener((tabId) => mediaByTab.delete(tabId));
chrome.webNavigation?.onCommitted?.addListener((d) => {
  if (d.frameId === 0) { mediaByTab.delete(d.tabId); updateBadge(d.tabId); }
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) { mediaByTab.delete(tabId); updateBadge(tabId); }
});

/* ---------- popup messaging ---------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'status') {
      const s = await getSettings();
      sendResponse({ settings: s, online: await ping(s.port) });
    } else if (msg.type === 'media') {
      const list = [...(mediaByTab.get(msg.tabId)?.values() || [])].sort((a, b) => b.size - a.size);
      sendResponse({ media: list });
    } else if (msg.type === 'download') {
      try {
        const id = await sendToApp({ url: msg.url, referer: msg.referer, kind: msg.kind, quality: msg.quality });
        sendResponse({ ok: true, id });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    } else if (msg.type === 'probePage') {
      const s = await getSettings();
      if (!(await ping(s.port, 1500))) {
        sendResponse({ ok: false, offline: true, error: 'SwiftFetch is not running.' });
        return;
      }
      try {
        const r = await fetch(base(s.port, '/probe'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: msg.url,
            referer: msg.referer || msg.url,
            userAgent: navigator.userAgent,
            cookieJar: await collectCookieJar(msg.url, msg.referer),
          }),
        });
        sendResponse(await r.json());
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    } else if (msg.type === 'setSettings') {
      await chrome.storage.local.set(msg.settings);
      settingsCache = null;
      sendResponse({ ok: true });
    }
  })();
  return true;
});
