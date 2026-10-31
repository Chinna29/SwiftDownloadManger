'use strict';
// Isolated-world companion to sniffer.js: forwards what the page-level hook found
// to the background service worker. Runs in every frame, since players often live
// in iframes on a different origin from the page.
(() => {
  if (window.__swiftfetchRelay) return;
  window.__swiftfetchRelay = true;
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__swiftfetch !== true || d.type !== 'sf-media' || ev.source !== window) return;
    try {
      chrome.runtime.sendMessage({
        type: 'sniffed',
        kind: d.kind,
        url: d.url,
        headers: d.headers || {},
        contentType: d.contentType || '',
        size: d.size || 0,
        frameUrl: location.href,
        topUrl: window.top === window ? location.href : (document.referrer || ''),
      });
    } catch { /* extension reloaded */ }
  });
})();
