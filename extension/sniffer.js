// SwiftFetch media sniffer (runs in the page's MAIN world).
// Players usually build their playlist URL in JavaScript, serve it with a generic
// content type and fetch it with fetch() or XMLHttpRequest. Chrome's webRequest API
// cannot read response bodies, so this hook inspects them where they arrive: in the
// page. Anything that looks like an HLS or DASH manifest, or a direct media response,
// is reported to the extension's content script with the request headers the player
// used, so yt-dlp can repeat the request the same way.
(() => {
  if (window.__swiftfetchSniffer) return;
  window.__swiftfetchSniffer = true;

  const seen = new Set();
  const MAX_SNIFF = 4096;

  function report(kind, url, headers, extra) {
    try {
      const clean = String(url).split('#')[0];
      if (!/^https?:/i.test(clean) || seen.has(clean)) return;
      seen.add(clean);
      window.postMessage({ __swiftfetch: true, type: 'sf-media', kind, url: clean, headers: headers || {}, ...extra }, '*');
    } catch { /* never break the page */ }
  }

  function classifyText(text) {
    const head = text.slice(0, MAX_SNIFF);
    if (/^\s*#EXTM3U/.test(head)) return /#EXT-X-STREAM-INF/.test(head) ? 'hls-master' : 'hls';
    if (/<MPD[\s>]/.test(head)) return 'dash';
    return null;
  }

  function classifyType(ct, url) {
    const t = String(ct || '').toLowerCase();
    let p = String(url || '');
    try { p = new URL(p, location.href).pathname; } catch { /* keep raw */ }
    if (/mpegurl/.test(t) || /\.m3u8$/i.test(p)) return 'hls';
    if (/dash\+xml/.test(t) || /\.mpd$/i.test(p)) return 'dash';
    if (/^video\//.test(t) || /^audio\//.test(t)) return 'file';
    return null;
  }

  function headerObject(init, xhrHeaders) {
    const out = {};
    const src = xhrHeaders || (init && init.headers);
    if (!src) return out;
    try {
      if (typeof Headers !== 'undefined' && src instanceof Headers) src.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(src)) for (const [k, v] of src) out[k] = v;
      else for (const k of Object.keys(src)) out[k] = src[k];
    } catch { /* ignore */ }
    return out;
  }

  /* ---- fetch ---- */
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const reqHeaders = headerObject(init, input && input.headers instanceof Headers ? input.headers : null);
        p.then((res) => {
          try {
            const ct = res.headers.get('content-type') || '';
            const byType = classifyType(ct, res.url || url);
            if (byType === 'file') {
              const len = Number(res.headers.get('content-length') || 0);
              if (len > 512 * 1024 || /\.(mp4|webm|mkv|m4v|mov|mp3|m4a)(\?|$)/i.test(res.url || url)) report('file', res.url || url, reqHeaders, { contentType: ct, size: len });
              return;
            }
            if (byType === 'dash') { report(byType, res.url || url, reqHeaders, { contentType: ct }); return; }
            // Peek at the body: upgrades HLS to "master" when it lists variants, and catches
            // manifests served with a generic content type and no file extension.
            const len = Number(res.headers.get('content-length') || 0);
            if (len > 2 * 1024 * 1024) return;
            if (!byType && /^(image|font|video|audio)\//i.test(ct)) return;
            res.clone().text().then((text) => {
              const kind = classifyText(text) || byType;
              if (kind) report(kind, res.url || url, reqHeaders, { contentType: ct });
            }).catch(() => { if (byType) report(byType, res.url || url, reqHeaders, { contentType: ct }); });
          } catch { /* ignore */ }
        }).catch(() => {});
      } catch { /* ignore */ }
      return p;
    };
  }

  /* ---- XMLHttpRequest ---- */
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      try { this.__sfUrl = String(url); this.__sfHeaders = {}; } catch { /* ignore */ }
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      try { if (this.__sfHeaders) this.__sfHeaders[k] = v; } catch { /* ignore */ }
      return setHeader.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        this.addEventListener('load', () => {
          try {
            const url = this.responseURL || this.__sfUrl || '';
            const ct = this.getResponseHeader('content-type') || '';
            const byType = classifyType(ct, url);
            if (byType === 'file') {
              const len = Number(this.getResponseHeader('content-length') || 0);
              if (len > 512 * 1024) report('file', url, this.__sfHeaders, { contentType: ct, size: len });
              return;
            }
            if (byType === 'dash') { report(byType, url, this.__sfHeaders, { contentType: ct }); return; }
            const rt = this.responseType;
            let text = null;
            if (rt === '' || rt === 'text') text = this.responseText;
            else if (rt === 'arraybuffer' && this.response && this.response.byteLength < 2 * 1024 * 1024) {
              text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(this.response, 0, Math.min(MAX_SNIFF, this.response.byteLength)));
            }
            const kind = (text && classifyText(text)) || byType;
            if (kind) report(kind, url, this.__sfHeaders, { contentType: ct });
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      return send.apply(this, arguments);
    };
  }

  /* ---- <video src> and <source> that point at real files ---- */
  function scanVideoSources() {
    for (const v of document.querySelectorAll('video, audio, source')) {
      const src = v.currentSrc || v.src || v.getAttribute('src');
      if (src && /^https?:/i.test(src)) {
        const kind = classifyType('', src) || 'file';
        if (kind !== 'file' || /\.(mp4|webm|mkv|m4v|mov|mp3|m4a|ogg)(\?|$)/i.test(src)) report(kind, src, {}, { fromElement: true });
      }
    }
  }
  document.addEventListener('loadedmetadata', scanVideoSources, true);
  setTimeout(scanVideoSources, 1500);
})();
