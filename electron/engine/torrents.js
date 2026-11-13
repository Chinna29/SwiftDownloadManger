'use strict';
// Torrents and magnet links through WebTorrent (MIT). One shared client; each torrent job is a
// TorrentDownload with the same event surface as the HTTP Download.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');

let clientPromise = null;

async function getClient(opts = {}) {
  if (!clientPromise) {
    clientPromise = import('webtorrent').then((m) => {
      const WebTorrent = m.default;
      const c = new WebTorrent({
        maxConns: opts.maxConns || 60,
        dht: opts.dht !== false,
        utp: true,
        lsd: true,
        downloadLimit: opts.downloadLimit || -1,
        uploadLimit: opts.uploadLimit || -1,
      });
      c.on('error', (e) => console.error('[torrent client]', e.message));
      return c;
    });
  }
  return clientPromise;
}

function setLimits({ downloadLimit, uploadLimit }) {
  if (!clientPromise) return;
  clientPromise.then((c) => {
    if (downloadLimit !== undefined) c.throttleDownload(downloadLimit > 0 ? downloadLimit : -1);
    if (uploadLimit !== undefined) c.throttleUpload(uploadLimit > 0 ? uploadLimit : -1);
  });
}

function describe(t) {
  return {
    infoHash: t.infoHash,
    name: t.name,
    length: t.length,
    files: t.files.map((f, i) => ({ index: i, name: f.name, path: f.path, length: f.length })),
    magnetURI: t.magnetURI,
    announce: t.announce,
  };
}

/**
 * Read a magnet link or .torrent (path or buffer) and return its file list, without downloading.
 * For a magnet the metadata comes from peers; waits up to timeoutMs.
 */
async function lookup(source, { dir, timeoutMs = 45000 } = {}) {
  const client = await getClient();
  const src = typeof source === 'string' && !source.startsWith('magnet:') && fs.existsSync(source) ? fs.readFileSync(source) : source;
  return new Promise((resolve, reject) => {
    let done = false;
    const existing = typeof src === 'string' ? client.torrents.find((t) => t.magnetURI === src) : null;
    if (existing && existing.ready) return resolve({ ...describe(existing), torrentFile: existing.torrentFile });
    const t = client.add(src, { path: dir || undefined, deselect: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const peers = t.numPeers;
      client.remove(t, { destroyStore: true }, () => {});
      reject(new Error(peers ? 'Found ' + peers + ' peers but none sent the file list yet. Try again, or check that the link has trackers.' : 'No peers answered. The link may have no trackers, or a firewall or VPN blocks BitTorrent.'));
    }, timeoutMs);
    t.once('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    t.once('metadata', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const info = { ...describe(t), torrentFile: t.torrentFile };
      // Keep nothing running until the user picks files.
      client.remove(t, { destroyStore: true }, () => resolve(info));
    });
  });
}

class TorrentDownload extends EventEmitter {
  /**
   * @param {object} o
   * @param {Buffer|string} o.source  torrentFile buffer or magnet URI
   * @param {string} o.dir
   * @param {number[]|null} o.selected  file indexes to download (null = all)
   * @param {boolean} o.sequential
   * @param {object} o.share  { ratio: 1.0, minutes: 0, seed: true }
   */
  constructor({ source, dir, selected = null, sequential = false, share = {} }) {
    super();
    this.source = source;
    this.dir = dir;
    this.selected = selected;
    this.sequential = sequential;
    this.share = { seed: true, ratio: 1.0, minutes: 0, ...share };
    this.torrent = null;
    this.stopped = false;
    this.cancelled = false;
    this.running = false;
    this.downloaded = 0;
    this.size = null;
    this.speed = 0;
    this.uploadSpeed = 0;
    this.peers = 0;
    this.ratio = 0;
    this.stage = 'connecting';
    this._timer = null;
    this._seedStart = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const client = await getClient();
    await fsp.mkdir(this.dir, { recursive: true });
    const src = Buffer.isBuffer(this.source) ? this.source : this.source;
    const t = client.add(src, { path: this.dir, strategy: this.sequential ? 'sequential' : 'rarest', deselect: !!this.selected });
    this.torrent = t;
    t.on('error', (e) => this._fail(e));
    t.on('warning', (w) => this.emit('log', 'torrent: ' + (w.message || w)));
    const onReady = () => {
      if (this.selected) {
        for (const i of this.selected) if (t.files[i]) t.files[i].select();
      }
      this.size = this.selected ? this.selected.reduce((a, i) => a + (t.files[i]?.length || 0), 0) : t.length;
      this.stage = 'downloading';
      this.emit('meta', describe(t));
      this._timer = setInterval(() => this._tick(), 500);
    };
    if (t.ready) onReady(); else t.once('ready', onReady);
    t.on('done', () => this._onDone());
  }

  _tick() {
    const t = this.torrent;
    if (!t) return;
    this.downloaded = this.selected ? this.selected.reduce((a, i) => a + (t.files[i]?.downloaded || 0), 0) : t.downloaded;
    this.speed = t.downloadSpeed;
    this.uploadSpeed = t.uploadSpeed;
    this.peers = t.numPeers;
    this.ratio = t.ratio;
    const remaining = this.size != null ? this.size - this.downloaded : null;
    this.emit('progress', {
      downloaded: this.downloaded, size: this.size, speed: this.speed, eta: remaining != null && this.speed > 1 ? remaining / this.speed : null,
      segments: [], stage: this.stage, uploadSpeed: this.uploadSpeed, peers: this.peers, ratio: this.ratio,
    });
    if (this.stage === 'seeding') this._checkShareLimits();
  }

  _onDone() {
    if (this.stopped) return;
    const t = this.torrent;
    this.downloaded = this.size ?? t.downloaded;
    if (!this.share.seed || (this.share.ratio <= 0 && this.share.minutes <= 0)) return this._complete();
    this.stage = 'seeding';
    this._seedStart = Date.now();
    this.emit('log', 'Download finished; sharing until ratio ' + this.share.ratio + (this.share.minutes ? ' or ' + this.share.minutes + ' min' : ''));
  }

  _checkShareLimits() {
    const t = this.torrent;
    const byRatio = this.share.ratio > 0 && t.ratio >= this.share.ratio;
    const byTime = this.share.minutes > 0 && Date.now() - this._seedStart >= this.share.minutes * 60000;
    if (byRatio || byTime) this._complete();
  }

  async _complete() {
    clearInterval(this._timer);
    const t = this.torrent;
    const info = t ? describe(t) : null;
    const filePath = t ? (t.files.length === 1 ? path.join(this.dir, t.files[0].path) : path.join(this.dir, t.name)) : this.dir;
    await this._remove(false);
    this.running = false;
    this.emit('complete', { filePath, size: this.downloaded, torrent: info });
  }

  async _fail(err) {
    clearInterval(this._timer);
    await this._remove(false);
    this.running = false;
    if (this.stopped) this.emit('paused');
    else this.emit('error', err);
  }

  async _remove(destroyStore) {
    const t = this.torrent;
    this.torrent = null;
    if (!t) return;
    const client = await getClient();
    await new Promise((r) => client.remove(t, { destroyStore }, () => r()));
  }

  pause() {
    if (!this.running || this.stopped) return;
    this.stopped = true;
    clearInterval(this._timer);
    this._remove(false).then(() => { this.running = false; this.emit('paused'); });
  }

  async cancel() {
    this.cancelled = true;
    this.stopped = true;
    clearInterval(this._timer);
    await this._remove(true);
    this.running = false;
    this.emit('paused');
  }

  /** Stop sharing now and mark complete (only meaningful while seeding). */
  stopSeeding() {
    if (this.stage === 'seeding') this._complete();
  }
}

module.exports = { getClient, lookup, setLimits, TorrentDownload };
