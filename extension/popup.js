'use strict';
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));

function fmtBytes(n) {
  if (!n) return 'size unknown';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function say(text, ok = true) {
  const el = $('msg');
  el.textContent = text;
  el.style.color = ok ? '#8b93a7' : '#ff6b6b';
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { settings, online } = await send({ type: 'status' });

  $('dot').classList.toggle('on', online);
  $('appState').textContent = online ? 'app running' : 'app not running';
  $('enabled').checked = settings.enabled;
  $('pageButton').checked = settings.pageButton !== false;
  $('relayBlobs').checked = settings.relayBlobs !== false;
  $('port').value = settings.port;
  $('minSize').value = settings.minSizeKB;

  const save = () => send({
    type: 'setSettings',
    settings: {
      enabled: $('enabled').checked,
      pageButton: $('pageButton').checked,
      relayBlobs: $('relayBlobs').checked,
      port: Number($('port').value) || 47831,
      minSizeKB: Number($('minSize').value) || 0,
    },
  });
  $('enabled').onchange = save;
  $('pageButton').onchange = save;
  $('relayBlobs').onchange = save;
  $('port').onchange = save;
  $('minSize').onchange = save;

  $('dlPage').onclick = async () => {
    if (!tab?.url || !/^https?:/i.test(tab.url)) return say('This page URL cannot be downloaded.', false);
    const r = await send({ type: 'download', url: tab.url, referer: tab.url, kind: 'video' });
    say(r.ok ? 'Sent to SwiftFetch as a video download.' : r.error, r.ok);
  };

  if (tab) {
    const { media } = await send({ type: 'media', tabId: tab.id });
    if (media.length) {
      const box = $('media');
      box.innerHTML = '';
      for (const m of media) {
        const row = document.createElement('div');
        row.className = 'media';
        const name = m.url.split('/').pop().split('?')[0] || m.url;
        const isStream = m.kind === 'stream';
        row.innerHTML = '<div class="info"><div class="name" title="' + m.url.replace(/"/g, '&quot;') + '">' + name + '</div>' +
          '<div class="meta">' + m.type + (isStream ? ' · via yt-dlp' : ' · ' + fmtBytes(m.size)) + (m.sniffed ? ' · sniffed' : '') + '</div></div>';
        const btn = document.createElement('button');
        btn.textContent = 'Download';
        btn.onclick = async () => {
          btn.disabled = true;
          // Streams go through yt-dlp, which stitches the fragments into one file.
          const r = await send({ type: 'download', url: m.url, referer: m.referer || tab.url, kind: isStream ? 'video' : 'file', headers: m.headers || {} });
          say(r.ok ? 'Sent to SwiftFetch.' : r.error, r.ok);
          btn.disabled = false;
        };
        row.appendChild(btn);
        box.appendChild(row);
      }
    }
  }
}

init();
