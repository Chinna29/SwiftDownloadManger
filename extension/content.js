'use strict';
// SwiftFetch on-page button: floats over the largest visible <video>, and on click shows the
// real resolution list (from yt-dlp via the app) so the user picks one before downloading.
// Built with createElement only: sites like YouTube enforce Trusted Types, which forbids innerHTML.
(() => {
  if (window.top !== window || window.__swiftfetchInjected) return;
  window.__swiftfetchInjected = true;

  const HOST = location.hostname;
  let enabled = true;
  let hidden = false;
  let host, shadow, btn, panel, video = null, rafPending = false, panelOpen = false, lastUrl = location.href;
  const cache = new Map();

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
    .btn {
      position: fixed; z-index: 2147483646; display: none; align-items: center; gap: 6px;
      padding: 6px 11px 6px 9px; border-radius: 999px; cursor: pointer; user-select: none;
      background: rgba(15, 17, 21, 0.88); color: #fff; font-size: 12px; font-weight: 600;
      border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      opacity: 0.82; transition: opacity .15s, transform .15s; backdrop-filter: blur(6px);
    }
    .btn:hover { opacity: 1; transform: translateY(-1px); }
    .btn.show { display: flex; }
    .btn .ic { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 5px; background: #4f8cff; font-size: 13px; }
    .panel {
      position: fixed; z-index: 2147483647; display: none; width: 340px; max-height: 70vh; overflow: auto;
      background: #0f1115; color: #e6e9ef; border: 1px solid #262c38; border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.55); font-size: 13px;
    }
    .panel.show { display: block; }
    .hd { display: flex; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #262c38; background: #161a22; border-radius: 12px 12px 0 0; }
    .hd img { width: 72px; height: 40px; object-fit: cover; border-radius: 5px; background: #1c212b; flex-shrink: 0; }
    .hd .t { font-weight: 600; line-height: 1.3; max-height: 2.6em; overflow: hidden; }
    .hd .m { color: #8b93a7; font-size: 11px; margin-top: 3px; }
    .rows { padding: 6px 0; }
    .row { display: flex; align-items: center; gap: 10px; padding: 7px 14px; }
    .row:hover { background: #161a22; }
    .row .q { font-weight: 600; min-width: 92px; }
    .row .s { color: #8b93a7; font-size: 12px; flex: 1; }
    .row button { background: #4f8cff; color: #fff; border: 0; border-radius: 6px; padding: 5px 11px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .row button:hover { background: #7fb0ff; }
    .row button:disabled { opacity: .5; cursor: default; }
    .msg { padding: 16px 14px; color: #8b93a7; line-height: 1.5; }
    .msg.err { color: #ff6b6b; }
    .ft { display: flex; justify-content: space-between; padding: 8px 14px; border-top: 1px solid #262c38; font-size: 11px; color: #8b93a7; }
    .ft a { color: #8b93a7; cursor: pointer; text-decoration: none; }
    .ft a:hover { color: #e6e9ef; text-decoration: underline; }
    .note { padding: 6px 14px 10px; color: #f2b84b; font-size: 11px; line-height: 1.4; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #334; border-top-color: #4f8cff; border-radius: 50%; animation: r .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes r { to { transform: rotate(360deg); } }
  `;

  /** Tiny element builder: el('div', {class:'x', onclick:fn}, child, 'text'). */
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  chrome.storage.local.get({ pageButton: true, hiddenHosts: [] }, (s) => {
    enabled = s.pageButton !== false;
    hidden = (s.hiddenHosts || []).includes(HOST);
    init();
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.pageButton) enabled = ch.pageButton.newValue !== false;
    if (ch.hiddenHosts) hidden = (ch.hiddenHosts.newValue || []).includes(HOST);
    update();
  });

  function init() {
    host = document.createElement('div');
    host.id = 'swiftfetch-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    btn = el('div', { class: 'btn', title: 'Download this video with SwiftFetch' }, el('span', { class: 'ic' }, '⇣'), el('span', null, 'Download'));
    panel = el('div', { class: 'panel' });
    shadow.append(style, btn, panel);
    (document.body || document.documentElement).appendChild(host);
    btn.addEventListener('click', (e) => { e.stopPropagation(); panelOpen ? closePanel() : openPanel(); });

    const mo = new MutationObserver(throttle(findVideo, 600));
    mo.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('mousedown', (e) => { if (panelOpen && e.target !== host) closePanel(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelOpen) closePanel(); }, true);
    setInterval(findVideo, 1500);
    setInterval(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; closePanel(); findVideo(); }
    }, 500);
    findVideo();
  }

  function throttle(fn, ms) {
    let t = 0, timer = null;
    return () => {
      const now = Date.now();
      if (now - t >= ms) { t = now; fn(); }
      else if (!timer) timer = setTimeout(() => { timer = null; t = Date.now(); fn(); }, ms - (now - t));
    };
  }

  function findVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 240 || r.height < 120) continue;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    if (best !== video) { video = best; if (!video) closePanel(); }
    update();
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; update(); });
  }

  function update() {
    if (!btn) return;
    const show = enabled && !hidden && video && document.contains(video) && !document.fullscreenElement && !document.pictureInPictureElement;
    if (!show) { btn.classList.remove('show'); if (panelOpen) closePanel(); return; }
    const r = video.getBoundingClientRect();
    if (r.width < 240 || r.bottom < 40 || r.top > innerHeight - 20) { btn.classList.remove('show'); return; }
    btn.classList.add('show');
    const bw = btn.offsetWidth || 110;
    const top = Math.max(8, Math.min(r.top + 12, innerHeight - 48));
    const left = Math.max(8, Math.min(r.right - bw - 12, innerWidth - bw - 8));
    btn.style.top = top + 'px';
    btn.style.left = left + 'px';
    if (panelOpen) {
      const pw = 340;
      panel.style.top = Math.min(top + 40, innerHeight - 120) + 'px';
      panel.style.left = Math.max(8, Math.min(left + bw - pw, innerWidth - pw - 8)) + 'px';
    }
  }

  /**
   * In a feed (X, Facebook, Instagram, Reddit) the page URL is not the video's URL.
   * Walk up from the player to the nearest post container and use its permalink.
   */
  function resolvePostUrl(v) {
    const host = HOST.replace(/^www\./, '');
    const patterns = [];
    if (/(^|\.)(x\.com|twitter\.com)$/.test(host)) patterns.push(/\/status\/\d+/);
    if (/(^|\.)facebook\.com$/.test(host)) patterns.push(/\/(videos|reel|reels|watch|posts|share\/v|share\/r)\b/);
    if (/(^|\.)instagram\.com$/.test(host)) patterns.push(/\/(p|reel|reels|tv)\/[\w-]+/);
    if (/(^|\.)reddit\.com$/.test(host)) patterns.push(/\/comments\/\w+/);
    if (/(^|\.)tiktok\.com$/.test(host)) patterns.push(/\/video\/\d+/);
    if (/(^|\.)linkedin\.com$/.test(host)) patterns.push(/\/(posts|feed\/update)\//);
    if (!patterns.length) return location.href;

    const matches = (href) => patterns.some((re) => re.test(href));
    // If the page itself is already a permalink, prefer it.
    if (matches(location.pathname)) return location.href;

    let node = v;
    for (let depth = 0; node && node !== document.body && depth < 14; depth++) {
      const scope = node.matches && node.matches('article, [role="article"], [data-testid="tweet"], shreddit-post, [data-pagelet]') ? node : null;
      const container = scope || node;
      const links = container.querySelectorAll ? container.querySelectorAll('a[href]') : [];
      let best = null;
      for (const a of links) {
        let href;
        try { href = new URL(a.getAttribute('href'), location.origin); } catch { continue; }
        if (href.origin !== location.origin && !/facebook\.com|x\.com|twitter\.com/.test(href.hostname)) continue;
        if (!matches(href.pathname)) continue;
        // X: the timestamp link is the canonical status link; Facebook: shortest video/post link wins.
        if (a.querySelector('time')) return href.origin + href.pathname;
        if (!best || href.pathname.length < best.pathname.length) best = href;
      }
      if (best && scope) return best.origin + best.pathname;
      if (best && depth >= 6) return best.origin + best.pathname;
      node = node.parentElement;
    }
    return location.href;
  }

  async function openPanel() {
    panelOpen = true;
    panel.classList.add('show');
    update();
    const url = video ? resolvePostUrl(video) : location.href;
    const pageAtOpen = location.href;
    render(el('div', { class: 'msg' }, el('span', { class: 'spin' }), 'Analyzing video…'));
    let r = cache.get(url);
    if (!r || Date.now() - r.at > 5 * 60 * 1000) {
      r = await send({ type: 'probePage', url, referer: pageAtOpen });
      r.at = Date.now();
      if (r.ok) cache.set(url, r);
    }
    if (!panelOpen || location.href !== pageAtOpen) return;
    if (!r.ok) {
      render(
        el('div', { class: 'msg err' }, r.error || 'Could not analyze this page'),
        r.offline && el('div', { class: 'msg' }, 'Start the SwiftFetch app and click Download again.'),
        footer(),
      );
      return;
    }
    const info = r.info;
    const rows = info.qualities.map((q) => {
      const sizeEl = el('span', { class: 's' }, (q.size ? '≈ ' + fmtBytes(q.size) : '') + (q.merged ? ' · merge' : ''));
      const b = el('button', null, 'Download');
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        b.disabled = true;
        b.textContent = 'Sending…';
        const res = await send({ type: 'download', url, referer: pageAtOpen, kind: 'video', quality: q.key });
        b.textContent = res.ok ? 'Sent ✓' : 'Failed';
        if (res.ok) setTimeout(closePanel, 1200);
        else { b.disabled = false; sizeEl.textContent = res.error || 'Error'; }
      });
      return el('div', { class: 'row' }, el('span', { class: 'q' }, qualityLabel(q)), sizeEl, b);
    });
    const shown = Math.max(0, ...info.qualities.map((q) => q.height || 0));
    const maxH = info.heights?.length ? Math.max(...info.heights) : 0;
    const note = !r.tools?.ffmpeg && maxH > shown
      ? el('div', { class: 'note' }, 'Up to ' + maxH + 'p is available once ffmpeg is installed in SwiftFetch → Settings → Video downloads.')
      : null;
    const meta = [info.extractor || '', info.uploader, info.duration ? fmtDur(info.duration) : null].filter(Boolean).join(' · ');
    const srcNote = url !== pageAtOpen ? el('div', { class: 'note', style: 'color:#8b93a7' }, 'Post: ' + url) : null;
    render(
      el('div', { class: 'hd' },
        info.thumbnail && el('img', { src: info.thumbnail, alt: '' }),
        el('div', null, el('div', { class: 't' }, info.title), el('div', { class: 'm' }, meta)),
      ),
      el('div', { class: 'rows' }, rows),
      srcNote,
      note,
      footer(),
    );
  }

  function footer() {
    const hide = el('a', null, 'Hide on ' + HOST);
    hide.addEventListener('click', () => {
      chrome.storage.local.get({ hiddenHosts: [] }, (s) => {
        chrome.storage.local.set({ hiddenHosts: Array.from(new Set([...(s.hiddenHosts || []), HOST])) });
      });
      closePanel();
    });
    const file = el('a', null, 'Download page URL as file');
    file.addEventListener('click', async () => {
      file.textContent = 'Sending…';
      const res = await send({ type: 'download', url: location.href, referer: location.href, kind: 'file' });
      file.textContent = res.ok ? 'Sent ✓' : (res.error || 'Failed');
    });
    return el('div', { class: 'ft' }, hide, file);
  }

  function render(...nodes) {
    panel.replaceChildren(...nodes.filter(Boolean));
    update();
  }

  function closePanel() {
    panelOpen = false;
    if (panel) panel.classList.remove('show');
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: 'Extension was reloaded. Refresh the page.' });
          else resolve(r || { ok: false, error: 'No response' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'Extension was reloaded. Refresh the page.' });
      }
    });
  }

  function qualityLabel(q) {
    if (q.key === 'audio') return 'Audio only';
    if (q.key === 'best') return 'Best' + (q.height ? ' (' + q.height + 'p)' : '');
    return q.label;
  }
  function fmtBytes(n) {
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i >= 2 ? 1 : 0) + ' ' + u[i];
  }
  function fmtDur(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
  }
})();
