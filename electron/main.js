'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Settings } = require('./settings');
const { Queue } = require('./engine/queue');
const { SpeedLimiter } = require('./engine/limiter');
const { probe } = require('./engine/http');
const { YtDlp, QUALITIES } = require('./engine/ytdlp');
const { CATEGORY_NAMES, DEFAULT_CATEGORIES, categorize, resolveDir } = require('./engine/categories');
const { startBridge } = require('./bridge/server');

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const appRoot = path.join(__dirname, '..');
const startHidden = process.argv.includes('--hidden');
let win = null;
let tray = null;
let queue = null;
let settings = null;
let limiter = null;
let bridge = null;
let ytdlp = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
}

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
    launchAtStartup: true,
    closeToTray: true,
    migratedSwiftDM: false,
  });

  // Users from before the SwiftDM layout had the bare Downloads folder as default: move them over once.
  if (!settings.get('migratedSwiftDM')) {
    const patch = { migratedSwiftDM: true };
    if (path.resolve(settings.get('downloadDir')) === path.resolve(downloads)) {
      patch.downloadDir = path.join(downloads, 'SwiftDM');
    }
    settings.set(patch);
  }
  ensureCategoryFolders();

  limiter = new SpeedLimiter(settings.get('speedLimitKB') * 1024);
  ytdlp = new YtDlp(path.join(userData, 'bin'));
  queue = new Queue({ storePath: path.join(userData, 'jobs.json'), settings, limiter, ytdlp });

  settings.on('change', async (data, before) => {
    limiter.setRate(data.speedLimitKB * 1024);
    queue.tick();
    if (data.bridgePort !== before.bridgePort) await restartBridge();
    if (data.launchAtStartup !== before.launchAtStartup) applyLoginItem();
    if (data.downloadDir !== before.downloadDir || data.organize !== before.organize) ensureCategoryFolders();
  });

  queue.on('change', (snap) => win && !win.isDestroyed() && win.webContents.send('jobs:changed', snap));
  queue.on('completed', (job) => {
    if (settings.get('notifyOnComplete') && Notification.isSupported()) {
      const n = new Notification({ title: 'Download complete', body: job.filename });
      n.on('click', () => shell.showItemInFolder(job.filePath));
      n.show();
    }
  });

  registerIpc();
  createTray();
  createWindow();
  applyLoginItem();
  await restartBridge();
}

function ensureCategoryFolders() {
  try {
    const base = settings.get('downloadDir');
    fs.mkdirSync(base, { recursive: true });
    if (settings.get('organize')) {
      for (const name of CATEGORY_NAMES) fs.mkdirSync(path.join(base, name), { recursive: true });
    }
  } catch (e) {
    console.error('Could not create download folders:', e.message);
  }
}

/* ---------- start with Windows ---------- */

function loginItemConfig() {
  // Packaged: the installed exe. Dev: electron.exe with the project path as its app argument.
  const args = app.isPackaged ? ['--hidden'] : [appRoot, '--hidden'];
  return { path: process.execPath, args };
}

function applyLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const cfg = loginItemConfig();
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.get('launchAtStartup'), name: 'SwiftFetch', path: cfg.path, args: cfg.args });
  } catch (e) {
    console.error('Could not update login item:', e.message);
  }
}

/* ---------- shortcuts ---------- */

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
    const ok = shell.writeShortcutLink(p, 'create', {
      target: cfg.path,
      args: app.isPackaged ? '' : '"' + appRoot + '"',
      cwd: appRoot,
      icon: fs.existsSync(icon) ? icon : cfg.path,
      iconIndex: 0,
      description: 'SwiftFetch download manager',
    });
    if (ok) made.push(p);
  }
  return { ok: made.length > 0, created: made };
}

/* ---------- tray ---------- */

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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open SwiftFetch', click: () => showWindow() },
    { label: 'Add download from clipboard', click: () => addFromClipboard() },
    { type: 'separator' },
    { label: 'Pause all', click: () => queue.pauseAll() },
    { label: 'Resume all', click: () => queue.resumeAll() },
    { type: 'separator' },
    { label: 'Open download folder', click: () => shell.openPath(settings.get('downloadDir')) },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: !!settings.get('launchAtStartup'),
      click: (item) => settings.set({ launchAtStartup: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

async function addFromClipboard() {
  const t = (clipboard.readText() || '').trim();
  if (!/^https?:\/\/\S+$/i.test(t)) {
    if (Notification.isSupported()) new Notification({ title: 'SwiftFetch', body: 'Clipboard does not contain a link.' }).show();
    return;
  }
  await queue.add({ url: t, source: 'tray' });
  showWindow();
}

/* ---------- window ---------- */

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
    width: 1100,
    height: 700,
    minWidth: 760,
    minHeight: 460,
    title: 'SwiftFetch',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: forceShow || !startHidden,
    icon: path.join(appRoot, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(appRoot, 'dist', 'index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!quitting && settings.get('closeToTray')) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

/* ---------- ipc ---------- */

function registerIpc() {
  ipcMain.handle('jobs:list', () => queue.snapshot());
  ipcMain.handle('jobs:add', (_e, opts) => queue.add({ ...opts, autoStart: opts.autoStart ?? settings.get('autoStart') }));
  ipcMain.handle('jobs:probe', async (_e, url, headers) => {
    try { return { ok: true, info: await probe(url, headers || {}) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('jobs:targetDir', (_e, { dir, filename, contentType, kind, quality }) => {
    const category = categorize({ filename, contentType, kind, quality }, settings.get('categories'));
    return {
      category,
      dir: resolveDir({ chosenDir: dir, baseDir: settings.get('downloadDir'), organize: settings.get('organize'), category }),
    };
  });
  ipcMain.handle('jobs:pause', (_e, id) => queue.pause(id));
  ipcMain.handle('jobs:resume', (_e, id) => queue.resume(id));
  ipcMain.handle('jobs:remove', (_e, id, deleteFile) => queue.remove(id, !!deleteFile));
  ipcMain.handle('jobs:pauseAll', () => queue.pauseAll());
  ipcMain.handle('jobs:resumeAll', () => queue.resumeAll());
  ipcMain.handle('jobs:clearCompleted', () => queue.clearCompleted());
  ipcMain.handle('jobs:openFile', (_e, id) => {
    const j = queue.get(id);
    return j && j.status === 'completed' ? shell.openPath(j.filePath) : null;
  });
  ipcMain.handle('jobs:showInFolder', (_e, id) => {
    const j = queue.get(id);
    if (j && j.filePath) shell.showItemInFolder(j.filePath);
  });

  ipcMain.handle('video:status', () => ytdlp.status());
  ipcMain.handle('video:qualities', () => QUALITIES);
  ipcMain.handle('video:probe', async (_e, url) => {
    try { return { ok: true, info: await ytdlp.probe(url) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('video:install', async (_e, kind) => {
    const send = (p) => win && !win.isDestroyed() && win.webContents.send('video:install', p);
    try {
      await ytdlp.install(kind, send);
      return { ok: true, status: await ytdlp.status() };
    } catch (e) {
      send({ kind, phase: 'error', error: e.message });
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('video:update', async () => {
    try { return { ok: true, message: await ytdlp.update(), status: await ytdlp.status() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const out = settings.set(patch);
    refreshTrayMenu();
    return out;
  });
  ipcMain.handle('settings:categoryNames', () => CATEGORY_NAMES);
  ipcMain.handle('bridge:status', () => bridgeStatus());
  ipcMain.handle('app:createShortcuts', () => createShortcuts());
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, root: appRoot }));

  ipcMain.handle('dialog:chooseDir', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('clipboard:url', () => {
    const t = (clipboard.readText() || '').trim();
    return /^https?:\/\/\S+$/i.test(t) ? t : '';
  });
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
}

/* ---------- bridge ---------- */

async function restartBridge() {
  if (bridge) {
    await new Promise((r) => bridge.close(r));
    bridge = null;
  }
  bridge = await startBridge({
    port: settings.get('bridgePort'),
    version: app.getVersion(),
    queue,
    ytdlp,
    onAdded: () => {
      if (settings.get('showOnBrowserAdd')) showWindow();
    },
  });
  if (win && !win.isDestroyed()) win.webContents.send('bridge:status', bridgeStatus());
}

function bridgeStatus() {
  return { listening: !!bridge, port: settings.get('bridgePort') };
}

/* ---------- lifecycle ---------- */

app.on('before-quit', async (e) => {
  if (quitting === 'done') return;
  e.preventDefault();
  quitting = true;
  try {
    if (queue) await queue.shutdown();
  } finally {
    quitting = 'done';
    if (tray) tray.destroy();
    app.quit();
  }
});

// With a tray icon the app keeps running when the window is closed; quitting is explicit.
app.on('window-all-closed', () => {
  if (!settings || !settings.get('closeToTray')) app.quit();
});
app.on('activate', () => showWindow());
