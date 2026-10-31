'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification } = require('electron');
const path = require('path');
const { Settings } = require('./settings');
const { Queue } = require('./engine/queue');
const { SpeedLimiter } = require('./engine/limiter');
const { probe } = require('./engine/http');
const { YtDlp, QUALITIES } = require('./engine/ytdlp');
const { startBridge } = require('./bridge/server');

const isDev = !!process.env.VITE_DEV_SERVER_URL;
let win = null;
let queue = null;
let settings = null;
let limiter = null;
let bridge = null;
let ytdlp = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(boot);
}

async function boot() {
  const userData = app.getPath('userData');
  settings = new Settings(path.join(userData, 'settings.json'), {
    downloadDir: app.getPath('downloads'),
    maxConcurrent: 3,
    segments: 8,
    speedLimitKB: 0,
    bridgePort: 47831,
    autoStart: true,
    notifyOnComplete: true,
    showOnBrowserAdd: true,
    videoQuality: 'best',
  });

  limiter = new SpeedLimiter(settings.get('speedLimitKB') * 1024);
  ytdlp = new YtDlp(path.join(userData, 'bin'));
  queue = new Queue({ storePath: path.join(userData, 'jobs.json'), settings, limiter, ytdlp });

  settings.on('change', async (data, before) => {
    limiter.setRate(data.speedLimitKB * 1024);
    queue.tick();
    if (data.bridgePort !== before.bridgePort) await restartBridge();
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
  createWindow();
  await restartBridge();
}

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
      if (settings.get('showOnBrowserAdd') && win) {
        if (win.isMinimized()) win.restore();
        win.show();
      }
    },
  });
  if (win && !win.isDestroyed()) win.webContents.send('bridge:status', bridgeStatus());
}

function bridgeStatus() {
  return { listening: !!bridge, port: settings.get('bridgePort') };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 760,
    minHeight: 460,
    title: 'SwiftFetch',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
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
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

function registerIpc() {
  ipcMain.handle('jobs:list', () => queue.snapshot());
  ipcMain.handle('jobs:add', (_e, opts) => queue.add({ ...opts, autoStart: opts.autoStart ?? settings.get('autoStart') }));
  ipcMain.handle('jobs:probe', async (_e, url, headers) => {
    try { return { ok: true, info: await probe(url, headers || {}) }; }
    catch (e) { return { ok: false, error: e.message }; }
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
  ipcMain.handle('settings:set', (_e, patch) => settings.set(patch));
  ipcMain.handle('bridge:status', () => bridgeStatus());

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
}

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  try {
    if (queue) await queue.shutdown();
  } finally {
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win) createWindow(); });
