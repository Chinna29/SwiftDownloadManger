'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Settings } = require('./settings');
const { Queue } = require('./engine/queue');
const { SpeedLimiter } = require('./engine/limiter');
const { probe } = require('./engine/http');
const { YtDlp, QUALITIES } = require('./engine/ytdlp');
const { GalleryDl } = require('./engine/gallerydl');
const { CATEGORY_NAMES, DEFAULT_CATEGORIES, categorize, resolveDir } = require('./engine/categories');
const { Scheduler } = require('./engine/scheduler');
const links = require('./engine/links');
const torrents = require('./engine/torrents');
const debrid = require('./engine/debrid');
const netctx = require('./engine/netctx');
const { find7zip } = require('./engine/archives');
const { startBridge } = require('./bridge/server');

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const appRoot = path.join(__dirname, '..');
let win = null;
let tray = null;
let queue = null;
let settings = null;
let limiter = null;
let bridge = null;
let ytdlp = null;
let gallerydl = null;
let scheduler = null;
let quitting = false;
let clipboardTimer = null;
let lastClipboard = null;

const DEFAULT_CLIPBOARD_TYPES = 'zip rar 7z tar gz xz bz2 iso img dmg pkg deb rpm appimage msi msix exe apk jar mp3 m4a flac wav ogg opus mp4 mkv webm avi mov m4v pdf epub mobi docx xlsx pptx odt gguf safetensors ckpt onnx parquet torrent';

const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    showWindow();
    handleCommandLine(argv, cwd);
  });
  app.whenReady().then(boot);
}

/* ================= boot ================= */

async function boot() {
  const userData = app.getPath('userData');
  const downloads = app.getPath('downloads');
  settings = new Settings(path.join(userData, 'settings.json'), {
    downloadDir: path.join(downloads, 'SwiftDM'),
    organize: true,
    categories: { ...DEFAULT_CATEGORIES },
    maxConcurrent: 3,
    segments: 8,
    speedLimitKB: 0,
    bridgePort: 47831,
    autoStart: true,
    notifyOnComplete: true,
    showOnBrowserAdd: true,
    videoQuality: 'best',
    videoContainer: 'mp4',
    launchAtStartup: true,
    closeToTray: true,
    migratedSwiftDM: false,
    // MDM-parity settings
    duplicatePolicy: 'ask',           // ask | numbered | overwrite | resume
    clipboardMonitor: true,
    clipboardTypes: DEFAULT_CLIPBOARD_TYPES,
    markOfTheWeb: true,
    extractArchives: false,
    extractInto: 'auto',               // auto | always | never
    deleteArchiveAfterExtract: false,
    sounds: { complete: false, failed: false, queueStart: false, queueStop: false, completeFile: '', failedFile: '' },
    theme: 'system',                   // system | dark | light
    zoom: 100,
    proxy: { mode: 'none', url: '', username: '', password: '', bypassLocal: true },
    siteLogins: [],
    debridAccounts: [],
    ftpPassive: true,
    torrentShare: { seed: true, ratio: 1, minutes: 0 },
    torrentLimits: { down: 0, up: 0 },
    keepTorrentFiles: true,
    confirmDelete: true,
    userAgent: '',
    queues: null,
    downloadLimits: { enabled: false, mb: 200, hours: 5, warn: true },
  });

  if (!settings.get('migratedSwiftDM')) {
    const patch = { migratedSwiftDM: true };
    if (path.resolve(settings.get('downloadDir')) === path.resolve(downloads)) patch.downloadDir = path.join(downloads, 'SwiftDM');
    settings.set(patch);
  }
  ensureCategoryFolders();
  applyNetwork();

  limiter = new SpeedLimiter(settings.get('speedLimitKB') * 1024);
  ytdlp = new YtDlp(path.join(userData, 'bin'));
  gallerydl = new GalleryDl(path.join(userData, 'bin'));
  scheduler = new Scheduler({ settings });
  const cookiesDir = path.join(userData, 'cookies');
  fs.rmSync(cookiesDir, { recursive: true, force: true });
  queue = new Queue({ storePath: path.join(userData, 'jobs.json'), settings, limiter, ytdlp, gallerydl, scheduler, cookiesDir });
  for (const j of queue.jobs.values()) if (j.cookiesFile) j.cookiesFile = null;

  settings.on('change', async (data, before) => {
    limiter.setRate(data.speedLimitKB * 1024);
    queue.tick();
    if (data.bridgePort !== before.bridgePort) await restartBridge();
    if (data.launchAtStartup !== before.launchAtStartup) applyLoginItem();
    if (data.downloadDir !== before.downloadDir || data.organize !== before.organize) ensureCategoryFolders();
    if (JSON.stringify(data.proxy) !== JSON.stringify(before.proxy) || JSON.stringify(data.siteLogins) !== JSON.stringify(before.siteLogins)) applyNetwork();
    if (data.clipboardMonitor !== before.clipboardMonitor) setupClipboardMonitor();
    if (JSON.stringify(data.torrentLimits) !== JSON.stringify(before.torrentLimits)) torrents.setLimits({ downloadLimit: (data.torrentLimits?.down || 0) * 1024, uploadLimit: (data.torrentLimits?.up || 0) * 1024 });
    refreshTrayMenu();
  });

  queue.on('change', (snap) => send('jobs:changed', snap));
  queue.on('completed', (job) => {
    if (settings.get('notifyOnComplete') && Notification.isSupported()) {
      const n = new Notification({ title: 'Download complete', body: job.filename });
      n.on('click', () => job.filePath && shell.showItemInFolder(job.filePath));
      n.show();
    }
    playSound('complete');
  });
  queue.on('failed', (job) => { if (job.source !== 'lookup') playSound('failed'); });
  queue.on('checksum', (job) => send('jobs:checksum', { id: job.id, result: job.checksum?.result }));

  scheduler.on('change', () => send('queues:changed', scheduler.list()));
  scheduler.on('queue:start', () => playSound('queueStart'));
  scheduler.on('queue:stop', () => playSound('queueStop'));
  scheduler.on('queue:finished', (id) => { const q = scheduler.get(id); if (q && Notification.isSupported()) new Notification({ title: 'Queue finished', body: q.name }).show(); });
  scheduler.on('countdown', (c) => { send('scheduler:countdown', c); if (c) showWindow(); });
  scheduler.on('limit', (l) => { send('scheduler:limit', l); if (l.hit && settings.get('downloadLimits')?.warn && Notification.isSupported()) new Notification({ title: 'Download limit reached', body: 'Downloads resume ' + (l.resumeAt ? 'at ' + new Date(l.resumeAt).toLocaleTimeString() : 'when the period is over') }).show(); });
  scheduler.on('open-file', (f) => shell.openPath(f));
  scheduler.on('exit', () => { quitting = true; app.quit(); });

  registerIpc();
  createTray();
  createWindow();
  applyLoginItem();
  setupClipboardMonitor();
  scheduler.run();
  await restartBridge();
  handleCommandLine(process.argv, process.cwd());
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function ensureCategoryFolders() {
  try {
    const base = settings.get('downloadDir');
    fs.mkdirSync(base, { recursive: true });
    if (settings.get('organize')) for (const name of [...CATEGORY_NAMES, 'Torrents']) fs.mkdirSync(path.join(base, name), { recursive: true });
  } catch (e) {
    console.error('Could not create download folders:', e.message);
  }
}

function applyNetwork() {
  netctx.configure({ proxy: settings.get('proxy'), logins: settings.get('siteLogins') });
}

/* ================= command line ================= */

/**
 * IDM-style switches and plain arguments:
 *   swiftfetch /d URL [/p folder] [/f filename] [/a] [/n]   /a = add to queue only, /n = no dialog
 *   swiftfetch URL ...   file.torrent   list.txt   list.ef2   magnet:...
 */
function handleCommandLine(argv, cwd) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => a !== '--hidden' && a !== '.' && !a.startsWith('--'));
  if (!args.length) return;
  let url = null, dir = null, file = null, later = false, quiet = false;
  const urls = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const low = a.toLowerCase();
    if (low === '/d' && args[i + 1]) { url = args[++i]; continue; }
    if (low === '/p' && args[i + 1]) { dir = args[++i]; continue; }
    if (low === '/f' && args[i + 1]) { file = args[++i]; continue; }
    if (low === '/a') { later = true; continue; }
    if (low === '/n' || low === '/q' || low === '/s') { quiet = true; continue; }
    if (/^(https?|ftp|ftps|ftpes):\/\//i.test(a) || /^magnet:/i.test(a)) { urls.push(a); continue; }
    const p = path.isAbsolute(a) ? a : path.join(cwd || process.cwd(), a);
    if (fs.existsSync(p)) {
      if (/\.torrent$/i.test(p)) { addTorrentFile(p); continue; }
      if (/\.(txt|ef2)$/i.test(p)) { importListFile(p); continue; }
    }
  }
  if (url) urls.unshift(url);
  if (!urls.length) return;
  if (urls.length === 1 && !quiet) {
    showWindow();
    send('add:request', { url: urls[0], dir, filename: file, later });
    return;
  }
  for (const u of urls) queue.add({ url: u, dir: dir || undefined, filename: file || undefined, autoStart: !later, source: 'cli', onDuplicate: 'auto' }).catch(() => {});
}

async function addTorrentFile(p) {
  try {
    const buf = fs.readFileSync(p);
    const info = await torrents.lookup(buf, {});
    showWindow();
    send('torrent:request', { ...info, torrentFile: buf.toString('base64'), sourcePath: p });
  } catch (e) {
    if (Notification.isSupported()) new Notification({ title: 'Torrent', body: e.message }).show();
  }
}

function importListFile(p) {
  const st = fs.statSync(p);
  if (st.size > 64 * 1024 * 1024) return;
  const text = fs.readFileSync(p, 'utf8');
  const found = links.extractLinks(text);
  showWindow();
  send('links:incoming', { title: path.basename(p), links: found, packages: links.groupIntoPackages(found) });
}

/* ================= clipboard monitor ================= */

function setupClipboardMonitor() {
  clearInterval(clipboardTimer);
  clipboardTimer = null;
  if (!settings.get('clipboardMonitor')) return;
  lastClipboard = (clipboard.readText() || '').trim(); // never act on what was already there
  clipboardTimer = setInterval(() => {
    let text;
    try { text = (clipboard.readText() || '').trim(); } catch { return; }
    if (!text || text === lastClipboard) return;
    lastClipboard = text;
    if (text.length > 4096 || /\s/.test(text)) return;
    if (/^magnet:\?/i.test(text)) { showWindow(); send('torrent:magnet', { magnet: text }); return; }
    if (!/^(https?|ftp|ftps|ftpes):\/\/\S+$/i.test(text)) return;
    const types = String(settings.get('clipboardTypes') || DEFAULT_CLIPBOARD_TYPES).toLowerCase().split(/[\s,]+/).filter(Boolean);
    let ext = '';
    try { ext = path.extname(new URL(text).pathname).slice(1).toLowerCase(); } catch { return; }
    const matches = types.includes('*') || (ext && types.some((t) => t === ext || (t.includes('*') && new RegExp('^' + t.replace(/\*/g, '.*') + '$').test(ext))));
    if (!matches) return;
    showWindow();
    send('add:request', { url: text, fromClipboard: true });
  }, 1000);
}

/* ================= sounds ================= */

function playSound(kind) {
  const s = settings.get('sounds') || {};
  if (!s[kind]) return;
  const file = kind === 'complete' ? s.completeFile : kind === 'failed' ? s.failedFile : '';
  if (file && fs.existsSync(file) && process.platform === 'win32') {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
  } else {
    shell.beep();
  }
}

/* ================= start with Windows / shortcuts ================= */

function loginItemConfig() {
  const args = app.isPackaged ? ['--hidden'] : [appRoot, '--hidden'];
  return { path: process.execPath, args };
}

function applyLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const cfg = loginItemConfig();
  try { app.setLoginItemSettings({ openAtLogin: !!settings.get('launchAtStartup'), name: 'SwiftFetch', path: cfg.path, args: cfg.args }); }
  catch (e) { console.error('Could not update login item:', e.message); }
}

function createShortcuts() {
  if (process.platform !== 'win32') return { ok: false, error: 'Shortcuts are only supported on Windows' };
  const cfg = loginItemConfig();
  const icon = path.join(appRoot, 'build', 'icon.ico');
  const targets = [
    path.join(app.getPath('desktop'), 'SwiftFetch.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SwiftFetch.lnk'),
  ];
  const made = [];
  for (const p of targets) {
    const ok = shell.writeShortcutLink(p, 'create', { target: cfg.path, args: app.isPackaged ? '' : '"' + appRoot + '"', cwd: appRoot, icon: fs.existsSync(icon) ? icon : cfg.path, iconIndex: 0, description: 'SwiftFetch download manager' });
    if (ok) made.push(p);
  }
  return { ok: made.length > 0, created: made };
}

/* ================= tray ================= */

function trayIcon() {
  const ico = path.join(appRoot, 'build', 'icon.ico');
  const png = path.join(appRoot, 'extension', 'icons', 'icon32.png');
  return nativeImage.createFromPath(fs.existsSync(ico) ? ico : png);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('SwiftFetch');
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const queues = scheduler ? scheduler.list() : [];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open SwiftFetch', click: () => showWindow() },
    { label: 'Add download from clipboard', click: () => addFromClipboard() },
    { label: 'Add batch download from clipboard', click: () => { showWindow(); send('batch:request', { fromClipboard: true }); } },
    { type: 'separator' },
    { label: 'Start queue', submenu: queues.map((q) => ({ label: q.name + (q.running ? ' (running)' : ''), enabled: !q.running, click: () => scheduler.start(q.id) })) },
    { label: 'Stop queue', submenu: queues.map((q) => ({ label: q.name, enabled: q.running, click: () => scheduler.stop(q.id) })) },
    { label: 'Pause all', click: () => queue.pauseAll() },
    { label: 'Resume all', click: () => queue.resumeAll() },
    { type: 'separator' },
    { label: 'Open download folder', click: () => shell.openPath(settings.get('downloadDir')) },
    { label: 'Start with Windows', type: 'checkbox', checked: !!settings.get('launchAtStartup'), click: (item) => settings.set({ launchAtStartup: item.checked }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

async function addFromClipboard() {
  const t = (clipboard.readText() || '').trim();
  if (!/^(https?|ftp|ftps|ftpes):\/\/\S+$/i.test(t) && !/^magnet:/i.test(t)) {
    if (Notification.isSupported()) new Notification({ title: 'SwiftFetch', body: 'Clipboard does not contain a link.' }).show();
    return;
  }
  showWindow();
  send('add:request', { url: t });
}

/* ================= window ================= */

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

function createWindow(forceShow = false) {
  win = new BrowserWindow({
    width: 1160, height: 720, minWidth: 780, minHeight: 480,
    title: 'SwiftFetch',
    backgroundColor: settings.get('theme') === 'light' ? '#f4f6fa' : '#0f1115',
    autoHideMenuBar: true,
    show: forceShow || !startHidden,
    icon: path.join(appRoot, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(appRoot, 'dist', 'index.html'));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor((Number(settings.get('zoom')) || 100) / 100));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => { if (!quitting && settings.get('closeToTray')) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

/* ================= ipc ================= */

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => fn(...a));

  // jobs
  h('jobs:list', () => queue.snapshot());
  h('jobs:add', (opts) => queue.add({ ...opts, autoStart: opts.autoStart ?? settings.get('autoStart') }));
  h('jobs:addMany', (items, common) => queue.addMany(items, common || {}));
  h('jobs:probe', async (url, headers) => { try { return { ok: true, info: await probe(url, headers || {}) }; } catch (e) { return { ok: false, error: e.message }; } });
  h('jobs:targetDir', ({ dir, filename, contentType, kind, quality }) => {
    const category = kind === 'torrent' ? 'Torrents' : categorize({ filename, contentType, kind, quality }, settings.get('categories'));
    return { category, dir: resolveDir({ chosenDir: dir, baseDir: settings.get('downloadDir'), organize: settings.get('organize'), category }) };
  });
  h('jobs:pause', (id) => queue.pause(id));
  h('jobs:resume', (id) => queue.resume(id));
  h('jobs:remove', (id, deleteFile) => queue.remove(id, !!deleteFile));
  h('jobs:removeMany', async (ids, deleteFile) => { for (const id of ids) await queue.remove(id, !!deleteFile); });
  h('jobs:pauseAll', () => queue.pauseAll());
  h('jobs:resumeAll', () => queue.resumeAll());
  h('jobs:clearCompleted', () => queue.clearCompleted());
  h('jobs:clearFailed', () => queue.clearFailed());
  h('jobs:openFile', (id) => { const j = queue.get(id); return j && j.status === 'completed' && j.filePath ? shell.openPath(j.filePath) : null; });
  h('jobs:showInFolder', (id) => { const j = queue.get(id); if (j && j.filePath) shell.showItemInFolder(j.filePath); });
  h('jobs:setDescription', (id, text) => queue.setDescription(id, text));
  h('jobs:changeUrl', (id, url) => queue.changeUrl(id, url));
  h('jobs:redownload', (id) => queue.redownload(id));
  h('jobs:moveFile', (id, newPath) => queue.moveFile(id, newPath));
  h('jobs:setChecksum', (id, expected) => queue.setChecksum(id, expected));
  h('jobs:verifyChecksum', (id) => queue.verifyChecksum(id));
  h('jobs:extract', async (id, password) => { try { return { ok: true, result: await queue.extract(id, { password }) }; } catch (e) { return { ok: false, error: e.message }; } });
  h('jobs:stopSeeding', (id) => queue.stopSeeding(id));
  h('jobs:addToQueue', (ids, queueId) => queue.addToQueue(ids, queueId));
  h('jobs:removeFromQueue', (ids) => queue.removeFromQueue(ids));
  h('jobs:export', async (ids, format) => {
    const jobs = ids.map((id) => queue.get(id)).filter(Boolean);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), format === 'ef2' ? 'downloads.ef2' : 'downloads.txt'), filters: format === 'ef2' ? [{ name: 'IDM export', extensions: ['ef2'] }] : [{ name: 'Text', extensions: ['txt'] }] });
    if (r.canceled) return null;
    const text = format === 'ef2' ? links.toEf2(jobs) : jobs.map((j) => j.url).join('\r\n') + '\r\n';
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });

  // links / batch
  h('links:extract', (text, baseUrl) => { const found = links.extractLinks(text, baseUrl || null); return { links: found, packages: links.groupIntoPackages(found) }; });
  h('links:fromPage', async (url) => { try { const r = await links.linksFromPage(url); return { ok: true, title: r.title, links: r.links, packages: links.groupIntoPackages(r.links) }; } catch (e) { return { ok: false, error: e.message }; } });
  h('links:expand', (pattern, opts) => { try { return { ok: true, urls: links.expandPattern(pattern, opts) }; } catch (e) { return { ok: false, error: e.message }; } });
  h('links:suggest', (url) => links.suggestPattern(url));
  h('links:lookup', async (list, token) => links.lookupLinks(list, { onUpdate: (i, info) => send('links:lookup', { token, index: i, info }) }));
  h('links:importFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Link lists', extensions: ['txt', 'ef2', 'html', 'htm', 'md'] }, { name: 'All files', extensions: ['*'] }] });
    if (r.canceled) return null;
    const p = r.filePaths[0];
    if (fs.statSync(p).size > 64 * 1024 * 1024) return { error: 'That file is larger than 64 MB; it is not a list of links.' };
    const found = links.extractLinks(fs.readFileSync(p, 'utf8'));
    return { title: path.basename(p), links: found, packages: links.groupIntoPackages(found) };
  });
  h('clipboard:text', () => clipboard.readText() || '');

  // queues / scheduler
  h('queues:list', () => scheduler.list());
  h('queues:create', (name) => scheduler.create(name));
  h('queues:update', (id, patch) => scheduler.update(id, patch));
  h('queues:remove', (id) => scheduler.remove(id));
  h('queues:start', (id) => scheduler.start(id));
  h('queues:stop', (id) => scheduler.stop(id));
  h('queues:limits', () => ({ ...scheduler.limits(), usage: scheduler.windowUsage() }));
  h('queues:cancelCountdown', () => scheduler.cancelCountdown());
  h('queues:powerNow', () => scheduler.powerNow());

  // torrents
  h('torrents:lookup', async (source, dir) => { try { const info = await torrents.lookup(source, { dir }); return { ok: true, info: { ...info, torrentFile: info.torrentFile ? Buffer.from(info.torrentFile).toString('base64') : null } }; } catch (e) { return { ok: false, error: e.message }; } });
  h('torrents:chooseFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Torrent', extensions: ['torrent'] }] });
    if (r.canceled) return null;
    const buf = fs.readFileSync(r.filePaths[0]);
    return { path: r.filePaths[0], torrentFile: buf.toString('base64') };
  });

  // debrid / network
  h('debrid:services', () => debrid.SERVICES);
  h('debrid:check', async (service, key) => { try { return { ok: true, info: await debrid.checkAccount(service, key) }; } catch (e) { return { ok: false, error: e.message }; } });
  h('network:status', () => netctx.snapshot());

  // tools
  h('tools:status', async () => ({ ...(await ytdlp.status()), gallerydl: await gallerydl.version(), sevenZip: find7zip() }));
  h('video:status', () => ytdlp.status());
  h('video:qualities', () => QUALITIES);
  h('video:probe', async (url) => { try { return { ok: true, info: await ytdlp.probe(url) }; } catch (e) { return { ok: false, error: e.message }; } });
  h('video:install', async (kind) => {
    const prog = (p) => send('video:install', p);
    try {
      if (kind === 'gallerydl') await gallerydl.install(prog); else await ytdlp.install(kind, prog);
      return { ok: true, status: await ytdlp.status() };
    } catch (e) { prog({ kind, phase: 'error', error: e.message }); return { ok: false, error: e.message }; }
  });
  h('video:update', async () => { try { return { ok: true, message: await ytdlp.update(), status: await ytdlp.status() }; } catch (e) { return { ok: false, error: e.message }; } });
  h('gallery:supports', (url) => gallerydl.supports(url));

  // settings / app
  h('settings:get', () => settings.get());
  h('settings:set', (patch) => { const out = settings.set(patch); refreshTrayMenu(); return out; });
  h('settings:categoryNames', () => CATEGORY_NAMES);
  h('bridge:status', () => bridgeStatus());
  h('app:createShortcuts', () => createShortcuts());
  h('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, root: appRoot, platform: process.platform }));
  h('app:setZoom', (z) => { const v = Math.max(80, Math.min(200, Number(z) || 100)); settings.set({ zoom: v }); if (win) win.webContents.setZoomFactor(v / 100); return v; });
  h('app:playSound', (kind) => playSound(kind));
  h('dialog:chooseDir', async (current) => { const r = await dialog.showOpenDialog(win, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
  h('dialog:chooseFile', async (filters) => { const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filters || [] }); return r.canceled ? null : r.filePaths[0]; });
  h('dialog:saveAs', async (defaultPath) => { const r = await dialog.showSaveDialog(win, { defaultPath }); return r.canceled ? null : r.filePath; });
  h('clipboard:url', () => { const t = (clipboard.readText() || '').trim(); return /^(https?|ftp|ftps|ftpes):\/\/\S+$/i.test(t) || /^magnet:/i.test(t) ? t : ''; });
  h('shell:openExternal', (url) => { if (/^https?:/i.test(url)) shell.openExternal(url); });
  h('shell:openPath', (p) => shell.openPath(p));
}

/* ================= bridge ================= */

async function restartBridge() {
  if (bridge) { await new Promise((r) => bridge.close(r)); bridge = null; }
  bridge = await startBridge({
    port: settings.get('bridgePort'),
    version: app.getVersion(),
    queue, ytdlp,
    cookiesDir: path.join(app.getPath('userData'), 'cookies'),
    onAdded: () => { if (settings.get('showOnBrowserAdd')) showWindow(); },
    onLinks: (payload) => { showWindow(); send('links:incoming', payload); },
  });
  send('bridge:status', bridgeStatus());
}

function bridgeStatus() {
  return { listening: !!bridge, port: settings.get('bridgePort') };
}

/* ================= lifecycle ================= */

app.on('before-quit', async (e) => {
  if (quitting === 'done') return;
  e.preventDefault();
  quitting = true;
  try { if (queue) await queue.shutdown(); } finally {
    quitting = 'done';
    clearInterval(clipboardTimer);
    if (scheduler) scheduler.stopClock();
    if (tray) tray.destroy();
    app.quit();
  }
});
app.on('window-all-closed', () => { if (!settings || !settings.get('closeToTray')) app.quit(); });
app.on('activate', () => showWindow());
