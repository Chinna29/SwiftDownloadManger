'use strict';
// SwiftFetch browser integration (Manifest V3 service worker).
//  - Intercepts browser downloads and hands them to the app over 127.0.0.1:<port>.
//  - Adds "Download with SwiftFetch" to the context menu for links and media.
//  - Watches responses for video/audio so the popup can offer them for download.

const DEFAULTS = { enabled: true, port: 47831, minSizeKB: 0, skipExtensions: [] };
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

async function sendToApp({ url, filename, referer }) {
  const s = await getSettings();
  const payload = {
    url,
    filename: filename || undefined,
    referer: referer || undefined,
    cookies: await cookieHeader(url),
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

chrome.downloads.onCreated.addListener(async (item) => {
  if (handled.has(item.id)) return;
  handled.add(item.id);

  const s = await getSettings();
  if (!s.enabled) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return; // blob:, data:, file: must stay in the browser
  if (item.byExtensionId) return;

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

/* ---------- context menu ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sf-link', title: 'Download link with SwiftFetch', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'sf-media', title: 'Download media with SwiftFetch', contexts: ['image', 'video', 'audio'] });
    chrome.contextMenus.create({ id: 'sf-page', title: 'Download this page URL with SwiftFetch', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'sf-link' ? info.linkUrl
    : info.menuItemId === 'sf-media' ? info.srcUrl
    : info.pageUrl;
  if (!url || !/^https?:/i.test(url)) return;
  const s = await getSettings();
  if (!(await ping(s.port))) {
    notify('SwiftFetch is not running', 'Start the SwiftFetch app and try again.');
    return;
  }
  try {
    await sendToApp({ url, referer: tab?.url });
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
    const isMedia = MEDIA_TYPES.test(ct) || MEDIA_EXT.test(details.url) || details.type === 'media';
    if (!isMedia) return;
    if (/mpegurl|dash\+xml/i.test(ct) || /\.(m3u8|mpd)(\?|$)/i.test(details.url)) return; // streaming manifests need a different pipeline

    let list = mediaByTab.get(details.tabId);
    if (!list) { list = new Map(); mediaByTab.set(details.tabId, list); }
    const clean = details.url.split('#')[0];
    const prev = list.get(clean);
    list.set(clean, { url: clean, type: ct || 'media', size: Math.max(len, prev?.size || 0), seenAt: Date.now() });
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
        const id = await sendToApp({ url: msg.url, referer: msg.referer });
        sendResponse({ ok: true, id });
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
