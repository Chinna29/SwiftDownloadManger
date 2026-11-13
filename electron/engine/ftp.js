'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { Client } = require('basic-ftp');
const { sanitizeFilename } = require('./http');

const PART_EXT = '.sfdownload';

function parseFtpUrl(url) {
  const u = new URL(url);
  const secure = u.protocol === 'ftps:' ? 'implicit' : u.protocol === 'ftpes:' ? true : false;
  const port = u.port ? Number(u.port) : (secure === 'implicit' ? 990 : 21);
  // "%2F" after the host means "from the server's root".
  let remotePath = decodeURIComponent(u.pathname);
  return {
    host: u.hostname, port, secure,
    user: u.username ? decodeURIComponent(u.username) : 'anonymous',
    password: u.password ? decodeURIComponent(u.password) : 'anonymous@',
    remotePath: remotePath || '/',
    filename: sanitizeFilename(decodeURIComponent(u.pathname.split('/').pop() || 'download')),
  };
}

async function connect(info, { passive = true } = {}) {
  const client = new Client(30000);
  client.ftp.verbose = false;
  await client.access({ host: info.host, port: info.port, user: info.user, password: info.password, secure: info.secure, secureOptions: { rejectUnauthorized: true } });
  if (!passive) client.ftp.passive = false;
  return client;
}

/** Size and modification time of the remote file. */
async function probeFtp(url, opts = {}) {
  const info = parseFtpUrl(url);
  const client = await connect(info, opts);
  try {
    let size = null;
    try { size = await client.size(info.remotePath); } catch { /* server may not support SIZE */ }
    let mtime = null;
    try { mtime = await client.lastMod(info.remotePath); } catch { /* optional */ }
    return { url, finalUrl: url, size, resumable: true, filename: info.filename, contentType: 'application/octet-stream', mtime: mtime ? mtime.toISOString() : null };
  } finally {
    client.close();
  }
}

/** One FTP/FTPS download with resume. Same events as Download: progress, paused, complete, error, log. */
class FtpDownload extends EventEmitter {
  constructor({ url, filePath, size = null, passive = true, limiter = null }) {
    super();
    this.url = url;
    this.filePath = filePath;
    this.partPath = filePath + PART_EXT;
    this.size = size;
    this.passive = passive;
    this.limiter = limiter;
    this.downloaded = 0;
    this.speed = 0;
    this.client = null;
    this.stopped = false;
    this.cancelled = false;
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const info = parseFtpUrl(this.url);
    let timer = null;
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      let startAt = 0;
      try { startAt = (await fsp.stat(this.partPath)).size; } catch { /* fresh */ }
      this.downloaded = startAt;
      this.client = await connect(info, { passive: this.passive });
      if (this.size == null) { try { this.size = await this.client.size(info.remotePath); } catch { /* unknown */ } }
      if (this.size != null && startAt >= this.size && this.size > 0) {
        await this._finish();
        return;
      }
      const out = fs.createWriteStream(this.partPath, { flags: startAt ? 'a' : 'w' });
      let last = { t: Date.now(), b: startAt };
      this.client.trackProgress((p) => {
        this.downloaded = startAt + p.bytes;
        const now = Date.now();
        if (now - last.t >= 500) {
          const inst = ((this.downloaded - last.b) / (now - last.t)) * 1000;
          this.speed = this.speed ? this.speed * 0.7 + inst * 0.3 : inst;
          last = { t: now, b: this.downloaded };
        }
      });
      timer = setInterval(() => this._emitProgress(), 400);
      this.emit('log', 'FTP ' + (startAt ? 'resuming at ' + startAt : 'starting') + ' ' + info.remotePath);
      await this.client.downloadTo(out, info.remotePath, startAt);
      clearInterval(timer);
      this.client.trackProgress();
      this.client.close();
      this.client = null;
      if (this.stopped) { this.emit('paused'); return; }
      await this._finish();
    } catch (err) {
      if (timer) clearInterval(timer);
      try { if (this.client) { this.client.trackProgress(); this.client.close(); } } catch { /* ignore */ }
      this.client = null;
      if (this.stopped) {
        if (this.cancelled) await this._deleteParts();
        this.emit('paused');
      } else {
        this.emit('error', err);
      }
    } finally {
      this.running = false;
    }
  }

  async _finish() {
    const st = await fsp.stat(this.partPath).catch(() => null);
    if (st) await fsp.rename(this.partPath, this.filePath);
    this.downloaded = st ? st.size : this.downloaded;
    this.size = this.size ?? this.downloaded;
    this._emitProgress();
    this.emit('complete', { filePath: this.filePath, size: this.downloaded });
  }

  _emitProgress() {
    const remaining = this.size != null ? this.size - this.downloaded : null;
    this.emit('progress', { downloaded: this.downloaded, size: this.size, speed: this.speed, eta: remaining != null && this.speed > 1 ? remaining / this.speed : null, segments: [] });
  }

  pause() {
    if (!this.running || this.stopped) return;
    this.stopped = true;
    try { this.client && this.client.close(); } catch { /* ignore */ }
  }

  async cancel() {
    this.cancelled = true;
    if (this.running) this.pause();
    else await this._deleteParts();
  }

  async _deleteParts() {
    await fsp.rm(this.partPath, { force: true }).catch(() => {});
  }
}

module.exports = { FtpDownload, probeFtp, parseFtpUrl };
