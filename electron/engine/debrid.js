'use strict';
// Debrid accounts: turn a file-host link into a direct link through the user's own account.
// Real-Debrid, AllDebrid, Premiumize and TorBox, by API key. Keys stay in settings.json.
const { request } = require('./http');

const SERVICES = {
  realdebrid: { name: 'Real-Debrid', tokenHelp: 'https://real-debrid.com/apitoken' },
  alldebrid: { name: 'AllDebrid', tokenHelp: 'https://alldebrid.com/apikeys' },
  premiumize: { name: 'Premiumize', tokenHelp: 'https://www.premiumize.me/account' },
  torbox: { name: 'TorBox', tokenHelp: 'https://torbox.app/settings' },
};

async function json(url, { method = 'GET', headers = {}, body = null } = {}) {
  const res = await new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(u, { method, headers: { 'User-Agent': 'SwiftFetch/0.1', ...headers } }, resolve);
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  let text = '';
  for await (const c of res) text += c;
  let data = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  if (res.statusCode >= 400) {
    const msg = (data && (data.error || data.detail || data.message)) || ('HTTP ' + res.statusCode);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

const hostsCache = new Map(); // service -> { at, hosts: Set }

async function supportedHosts(service, key) {
  const c = hostsCache.get(service);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.hosts;
  let hosts = new Set();
  try {
    if (service === 'realdebrid') {
      const d = await json('https://api.real-debrid.com/rest/1.0/hosts/domains', { headers: { Authorization: 'Bearer ' + key } });
      for (const h of d || []) hosts.add(String(h).toLowerCase());
    } else if (service === 'alldebrid') {
      const d = await json('https://api.alldebrid.com/v4/hosts/domains?agent=SwiftFetch&apikey=' + encodeURIComponent(key));
      for (const h of (d?.data?.hosts || [])) hosts.add(String(h).toLowerCase());
    } else if (service === 'premiumize') {
      const d = await json('https://www.premiumize.me/api/services/list?apikey=' + encodeURIComponent(key));
      for (const h of (d?.directdl || [])) hosts.add(String(h).toLowerCase());
    } else if (service === 'torbox') {
      const d = await json('https://api.torbox.app/v1/api/webdl/hosters', { headers: { Authorization: 'Bearer ' + key } });
      for (const h of (d?.data || [])) for (const dom of (h.domains || [h.domain]).filter(Boolean)) hosts.add(String(dom).toLowerCase());
    }
  } catch { /* keep empty: unrestrict will be attempted anyway when the user forces it */ }
  hostsCache.set(service, { at: Date.now(), hosts });
  return hosts;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

async function unrestrictWith(service, key, url) {
  if (service === 'realdebrid') {
    const d = await json('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'link=' + encodeURIComponent(url),
    });
    return { url: d.download, filename: d.filename, size: d.filesize };
  }
  if (service === 'alldebrid') {
    const d = await json('https://api.alldebrid.com/v4/link/unlock?agent=SwiftFetch&apikey=' + encodeURIComponent(key) + '&link=' + encodeURIComponent(url));
    if (d.status !== 'success') throw new Error(d?.error?.message || 'AllDebrid refused the link');
    return { url: d.data.link, filename: d.data.filename, size: d.data.filesize };
  }
  if (service === 'premiumize') {
    const d = await json('https://www.premiumize.me/api/transfer/directdl?apikey=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'src=' + encodeURIComponent(url),
    });
    if (d.status !== 'success' || !d.content?.length) throw new Error(d.message || 'Premiumize refused the link');
    const f = d.content[0];
    return { url: f.link, filename: f.path ? f.path.split('/').pop() : null, size: f.size };
  }
  if (service === 'torbox') {
    const d = await json('https://api.torbox.app/v1/api/webdl/createwebdownload', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ link: url }),
    });
    const id = d?.data?.webdownload_id ?? d?.data?.id;
    if (!id) throw new Error(d?.detail || 'TorBox did not accept the link');
    // TorBox resolves asynchronously; poll briefly for the direct link.
    for (let i = 0; i < 20; i++) {
      const info = await json('https://api.torbox.app/v1/api/webdl/mylist?id=' + id, { headers: { Authorization: 'Bearer ' + key } });
      const item = Array.isArray(info?.data) ? info.data[0] : info?.data;
      if (item && item.download_finished && item.files?.length) {
        const file = item.files[0];
        const dl = await json(`https://api.torbox.app/v1/api/webdl/requestdl?token=${encodeURIComponent(key)}&web_id=${id}&file_id=${file.id}`);
        return { url: dl.data, filename: file.short_name || file.name, size: file.size };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('TorBox is still fetching the file; try again in a minute');
  }
  throw new Error('Unknown debrid service: ' + service);
}

/**
 * accounts: [{ service, key, enabled }] in priority order.
 * Returns { url, filename, size, service } for the first account that unlocks the link,
 * or null when no account claims the host. Throws only when a claiming account fails.
 */
async function unrestrict(url, accounts, { force = false } = {}) {
  const host = hostOf(url);
  const errors = [];
  for (const acc of accounts || []) {
    if (!acc || acc.enabled === false || !acc.key || !SERVICES[acc.service]) continue;
    const hosts = await supportedHosts(acc.service, acc.key);
    const claims = force || [...hosts].some((h) => host === h || host.endsWith('.' + h));
    if (!claims) continue;
    try {
      const r = await unrestrictWith(acc.service, acc.key, url);
      if (r && r.url) return { ...r, service: acc.service };
    } catch (e) {
      errors.push(SERVICES[acc.service].name + ': ' + e.message);
    }
  }
  if (errors.length) throw new Error(errors.join(' · '));
  return null;
}

async function checkAccount(service, key) {
  if (service === 'realdebrid') { const d = await json('https://api.real-debrid.com/rest/1.0/user', { headers: { Authorization: 'Bearer ' + key } }); return { user: d.username, premium: d.type === 'premium', expires: d.expiration }; }
  if (service === 'alldebrid') { const d = await json('https://api.alldebrid.com/v4/user?agent=SwiftFetch&apikey=' + encodeURIComponent(key)); if (d.status !== 'success') throw new Error(d?.error?.message || 'Invalid key'); return { user: d.data.user.username, premium: !!d.data.user.isPremium, expires: d.data.user.premiumUntil }; }
  if (service === 'premiumize') { const d = await json('https://www.premiumize.me/api/account/info?apikey=' + encodeURIComponent(key)); if (d.status !== 'success') throw new Error(d.message || 'Invalid key'); return { user: d.customer_id, premium: d.premium_until > Date.now() / 1000, expires: d.premium_until }; }
  if (service === 'torbox') { const d = await json('https://api.torbox.app/v1/api/user/me', { headers: { Authorization: 'Bearer ' + key } }); return { user: d?.data?.email, premium: (d?.data?.plan || 0) > 0, expires: d?.data?.premium_expires_at }; }
  throw new Error('Unknown service');
}

module.exports = { SERVICES, unrestrict, checkAccount, supportedHosts };
