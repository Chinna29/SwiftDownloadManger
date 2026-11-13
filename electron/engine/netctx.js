'use strict';
// Network context shared by every request: proxy choice and per-site logins.
const { execFileSync } = require('child_process');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const state = {
  proxy: { mode: 'none', url: '', username: '', password: '', bypassLocal: true }, // none | system | manual
  logins: [],   // [{ host, path, username, password }]
  systemProxy: null,
  agents: new Map(),
};

function configure({ proxy, logins } = {}) {
  if (proxy) state.proxy = { ...state.proxy, ...proxy };
  if (Array.isArray(logins)) state.logins = logins;
  state.agents.clear();
  if (state.proxy.mode === 'system') state.systemProxy = readSystemProxy();
}

/** Windows' proxy settings (Internet Options), or the usual environment variables elsewhere. */
function readSystemProxy() {
  const env = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY;
  if (env) return env;
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true });
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
    if (!enabled || !m) return null;
    let server = m[1];
    // "http=host:port;https=host:port" or "host:port"
    if (server.includes('=')) {
      const parts = Object.fromEntries(server.split(';').map((p) => p.split('=')));
      server = parts.https || parts.http || Object.values(parts)[0];
    }
    if (!/^\w+:\/\//.test(server)) server = (server.startsWith('socks') ? 'socks5://' : 'http://') + server;
    return server;
  } catch {
    return null;
  }
}

function proxyUrl() {
  const p = state.proxy;
  if (p.mode === 'manual' && p.url) {
    try {
      const u = new URL(/^\w+:\/\//.test(p.url) ? p.url : 'http://' + p.url);
      if (p.username) { u.username = p.username; u.password = p.password || ''; }
      return u.toString();
    } catch { return null; }
  }
  if (p.mode === 'system') return state.systemProxy;
  return null;
}

function isLocal(hostname) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1)/.test(hostname) || !hostname.includes('.');
}

/** An http.Agent for this URL under the current proxy setting, or undefined for a direct connection. */
function agentFor(url) {
  const purl = proxyUrl();
  if (!purl) return undefined;
  try {
    const target = new URL(url);
    if (state.proxy.bypassLocal && isLocal(target.hostname)) return undefined;
  } catch { /* fall through */ }
  const key = purl;
  if (!state.agents.has(key)) {
    const agent = /^socks/i.test(purl) ? new SocksProxyAgent(purl) : new HttpsProxyAgent(purl);
    state.agents.set(key, agent);
  }
  return state.agents.get(key);
}

/** yt-dlp / gallery-dl argument for the current proxy, if any. */
function proxyArgs() {
  const purl = proxyUrl();
  return purl ? ['--proxy', purl] : [];
}

/** Authorization header for a URL, from the saved site logins (longest matching host+path wins). */
function authHeader(url) {
  let host, pathName;
  try { const u = new URL(url); host = u.hostname.toLowerCase(); pathName = u.pathname; } catch { return null; }
  let best = null;
  for (const l of state.logins) {
    if (!l.host) continue;
    const h = String(l.host).toLowerCase().replace(/^\*\./, '');
    const hostOk = host === h || host.endsWith('.' + h);
    const pathOk = !l.path || pathName.startsWith(l.path);
    if (hostOk && pathOk && (!best || (l.path || '').length > (best.path || '').length)) best = l;
  }
  if (!best || !best.username) return null;
  return 'Basic ' + Buffer.from(best.username + ':' + (best.password || '')).toString('base64');
}

function snapshot() {
  return { proxy: { ...state.proxy, password: state.proxy.password ? '••••' : '' }, effectiveProxy: proxyUrl() ? proxyUrl().replace(/\/\/[^@]*@/, '//***@') : null, logins: state.logins.map((l) => ({ ...l, password: l.password ? '••••' : '' })) };
}

module.exports = { configure, agentFor, proxyArgs, authHeader, proxyUrl, snapshot, readSystemProxy };
