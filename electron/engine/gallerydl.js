'use strict';
// Image galleries through gallery-dl (its official Windows build, fetched on demand like yt-dlp).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Download } = require('./downloader');
const { probe: httpProbe } = require('./http');

const GALLERY_DL_URL = 'https://github.com/mikf/gallery-dl/releases/latest/download/gallery-dl.exe';

class GalleryDl {
  constructor(binDir) {
    this.binDir = binDir;
    this.exe = path.join(binDir, 'gallery-dl.exe');
  }

  has() { return fs.existsSync(this.exe); }

  async version() {
    if (!this.has()) return null;
    return new Promise((resolve) => {
      const p = spawn(this.exe, ['--version'], { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('close', () => resolve(out.trim() || 'installed'));
      p.on('error', () => resolve('installed'));
    });
  }

  async install(onProgress = () => {}) {
    await fs.promises.mkdir(this.binDir, { recursive: true });
    const info = await httpProbe(GALLERY_DL_URL);
    const tmp = this.exe + '.download';
    await fs.promises.rm(tmp, { force: true });
    const dl = new Download({ url: info.finalUrl, filePath: tmp, segments: 4, size: info.size, resumable: info.resumable });
    await new Promise((resolve, reject) => {
      dl.on('progress', (p) => onProgress({ kind: 'gallerydl', downloaded: p.downloaded, size: p.size, phase: 'downloading' }));
      dl.once('complete', resolve);
      dl.once('error', reject);
      dl.start();
    });
    await fs.promises.rename(tmp, this.exe);
    onProgress({ kind: 'gallerydl', phase: 'done' });
  }

  /** Does gallery-dl know this URL? Uses its extractor list match via --simulate on the first item. */
  async supports(url) {
    if (!this.has()) return false;
    return new Promise((resolve) => {
      const p = spawn(this.exe, ['--simulate', '--range', '1', url], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => { p.kill(); resolve(false); }, 20000);
      p.on('close', (code) => { clearTimeout(t); resolve(code === 0 && !/Unsupported URL/i.test(err)); });
      p.on('error', () => { clearTimeout(t); resolve(false); });
    });
  }
}

/** Downloads a whole gallery into <dir>/<site>/<gallery>. Events: progress, paused, complete, error, log. */
class GalleryDownload extends EventEmitter {
  constructor({ gallerydl, url, dir, cookiesFile = null, extraArgs = [] }) {
    super();
    this.gallerydl = gallerydl;
    this.url = url;
    this.dir = dir;
    this.cookiesFile = cookiesFile;
    this.extraArgs = extraArgs;
    this.proc = null;
    this.stopped = false;
    this.cancelled = false;
    this.count = 0;
    this.lastFile = null;
    this.downloaded = 0;
  }

  async start() {
    if (!this.gallerydl.has()) { this.emit('error', new Error('gallery-dl is not installed. Install it from Settings.')); return; }
    await fs.promises.mkdir(this.dir, { recursive: true });
    const args = ['-D', this.dir, '--no-skip', '--write-metadata', ...this.extraArgs];
    if (this.cookiesFile) args.push('--cookies', this.cookiesFile);
    args.push(this.url);
    this.proc = spawn(this.gallerydl.exe, args, { windowsHide: true, cwd: this.dir });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        // gallery-dl prints each saved file's path.
        this.count += 1;
        this.lastFile = line;
        try { this.downloaded += fs.statSync(line).size; } catch { /* ignore */ }
        this.emit('progress', { downloaded: this.downloaded, size: null, speed: 0, eta: null, segments: [], stage: this.count + ' files', count: this.count });
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { for (const l of d.split('\n')) if (l.trim()) this.emit('log', l.trim()); });
    this.proc.on('error', (e) => this._finish(1, e.message));
    this.proc.on('close', (code) => this._finish(code));
  }

  _finish(code, msg) {
    this.proc = null;
    if (this.stopped) { this.emit('paused'); return; }
    if (code === 0) this.emit('complete', { filePath: this.dir, size: this.downloaded, count: this.count });
    else this.emit('error', new Error(msg || ('gallery-dl exited with code ' + code + (this.count ? ' after ' + this.count + ' files' : ''))));
  }

  pause() {
    if (!this.proc || this.stopped) return;
    this.stopped = true;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else this.proc.kill();
  }

  async cancel() { this.cancelled = true; this.pause(); }
}

module.exports = { GalleryDl, GalleryDownload };
