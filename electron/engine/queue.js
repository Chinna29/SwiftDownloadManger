'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Download, PART_EXT, STATE_EXT } = require('./downloader');
const { VideoDownload } = require('./ytdlp');
const { probe, sanitizeFilename } = require('./http');

const PERSIST_FIELDS = [
  'id', 'url', 'finalUrl', 'filename', 'dir', 'filePath', 'size', 'resumable', 'contentType',
  'status', 'downloaded', 'segments', 'segmentCount', 'error', 'headers', 'addedAt', 'completedAt', 'source',
  'kind', 'video', 'quality', 'stage',
];

/**
 * Holds every job, persists them, and keeps at most `maxConcurrent` running.
 * Emits 'change' with a full serialisable snapshot (throttled), and
 * 'completed' / 'failed' with the job for notifications.
 */
class Queue extends EventEmitter {
  constructor({ storePath, settings, limiter, ytdlp }) {
    super();
    this.storePath = storePath;
    this.settings = settings;
    this.limiter = limiter;
    this.ytdlp = ytdlp;
    this.jobs = new Map();
    this.active = new Map(); // id -> Download
    this._persistTimer = null;
    this._changeTimer = null;
    this._load();
  }

  /* ---------- persistence ---------- */

  _load() {
    try {
      if (!fs.existsSync(this.storePath)) return;
      const list = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      for (const j of list) {
        if (j.status === 'downloading' || j.status === 'probing' || j.status === 'queued') {
          const resumable = j.filePath || (j.kind === 'video' && j.video);
          j.status = resumable ? 'paused' : 'failed';
          if (!resumable) j.error = 'Interrupted before the download started';
        }
        j.speed = 0;
        j.eta = null;
        this.jobs.set(j.id, j);
      }
    } catch (e) {
      console.error('Could not load jobs:', e.message);
    }
  }

  _persist() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(async () => {
      const list = [...this.jobs.values()].map((j) => {
        const out = {};
        for (const k of PERSIST_FIELDS) if (j[k] !== undefined) out[k] = j[k];
        return out;
      });
      try {
        await fsp.mkdir(path.dirname(this.storePath), { recursive: true });
        await fsp.writeFile(this.storePath, JSON.stringify(list, null, 2));
      } catch (e) {
        console.error('Could not persist jobs:', e.message);
      }
    }, 300);
  }

  _changed(persist = true) {
    if (persist) this._persist();
    if (this._changeTimer) return;
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      this.emit('change', this.snapshot());
    }, 150);
  }

  snapshot() {
    return [...this.jobs.values()]
      .map((j) => ({ ...j }))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  get(id) {
    return this.jobs.get(id);
  }

  /* ---------- adding ---------- */

  async add({ url, filename, dir, headers = {}, segments, autoStart = true, source = 'app', kind = 'file', video = null, quality = null }) {
    url = String(url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported');

    const job = {
      id: crypto.randomUUID(),
      url,
      finalUrl: url,
      filename: filename ? sanitizeFilename(filename) : null,
      dir: dir || this.settings.get('downloadDir'),
      filePath: null,
      size: null,
      resumable: false,
      contentType: null,
      status: 'probing',
      downloaded: 0,
      speed: 0,
      eta: null,
      segments: [],
      segmentCount: segments || this.settings.get('segments'),
      error: null,
      headers,
      addedAt: Date.now(),
      completedAt: null,
      source,
      kind,
      video: null,
      quality: null,
      stage: null,
    };
    this.jobs.set(job.id, job);
    this._changed();

    try {
      if (kind === 'video') {
        if (!this.ytdlp || !this.ytdlp.hasYtDlp()) throw new Error('yt-dlp is not installed. Install it from Settings.');
        const info = video || (await this.ytdlp.probe(url));
        job.video = {
          id: info.id, title: info.title, extractor: info.extractor, duration: info.duration,
          thumbnail: info.thumbnail, uploader: info.uploader, webpage: info.webpage,
        };
        job.quality = quality || this.settings.get('videoQuality') || 'best';
        job.resumable = true;
        job.contentType = 'video via yt-dlp';
        job.filename = sanitizeFilename(info.title) + (job.quality === 'audio' ? '.m4a' : '.mp4');
        job.status = autoStart ? 'queued' : 'paused';
      } else {
        const info = await probe(url, headers);
        job.finalUrl = info.finalUrl;
        job.size = info.size;
        job.resumable = info.resumable;
        job.contentType = info.contentType;
        if (!job.filename) job.filename = info.filename;
        job.filePath = await this._uniquePath(job.dir, job.filename);
        job.filename = path.basename(job.filePath);
        job.status = autoStart ? 'queued' : 'paused';
      }
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      this.emit('failed', job);
    }
    this._changed();
    this.tick();
    return job.id;
  }

  async _uniquePath(dir, filename) {
    const ext = path.extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    let candidate = path.join(dir, filename);
    let i = 1;
    const taken = (p) =>
      fs.existsSync(p) || fs.existsSync(p + PART_EXT) || fs.existsSync(p + STATE_EXT) ||
      [...this.jobs.values()].some((j) => j.filePath === p);
    while (taken(candidate)) {
      candidate = path.join(dir, base + ' (' + i + ')' + ext);
      i += 1;
    }
    return candidate;
  }

  /* ---------- scheduling ---------- */

  tick() {
    const max = this.settings.get('maxConcurrent');
    const queued = [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.addedAt - b.addedAt);
    for (const job of queued) {
      if (this.active.size >= max) break;
      this._start(job);
    }
  }

  _start(job) {
    const dl = job.kind === 'video'
      ? new VideoDownload({
        ytdlp: this.ytdlp,
        url: job.url,
        dir: job.dir,
        quality: job.quality,
        videoId: job.video?.id,
        speedLimitKB: this.settings.get('speedLimitKB'),
      })
      : new Download({
        url: job.finalUrl || job.url,
        filePath: job.filePath,
        headers: job.headers,
        segments: job.segmentCount,
        size: job.size,
        resumable: job.resumable,
        limiter: this.limiter,
      });
    this.active.set(job.id, dl);
    job.status = 'downloading';
    job.error = null;
    job.stage = job.kind === 'video' ? 'starting' : null;

    dl.on('progress', (p) => {
      job.downloaded = p.downloaded;
      job.size = p.size;
      job.speed = p.speed;
      job.eta = p.eta;
      job.segments = p.segments;
      if (p.stage) job.stage = p.stage + (p.stream ? ' (stream ' + (p.stream + 1) + ')' : '');
      this._changed(false);
    });
    dl.on('log', (msg) => console.log('[' + job.filename + '] ' + msg));
    dl.on('paused', () => {
      this.active.delete(job.id);
      if (this.jobs.has(job.id)) {
        job.status = job.status === 'cancelling' ? 'cancelled' : 'paused';
        job.speed = 0;
        job.eta = null;
        this._changed();
      }
      this.tick();
    });
    dl.on('complete', (r) => {
      this.active.delete(job.id);
      job.status = 'completed';
      job.completedAt = Date.now();
      job.speed = 0;
      job.eta = null;
      job.stage = null;
      if (r && r.filePath) {
        job.filePath = r.filePath;
        job.filename = path.basename(r.filePath);
        if (r.size != null) job.size = r.size;
      }
      job.downloaded = job.size ?? job.downloaded;
      this._changed();
      this.emit('completed', job);
      this.tick();
    });
    dl.on('error', (err) => {
      this.active.delete(job.id);
      job.status = 'failed';
      job.error = err.message;
      job.speed = 0;
      job.eta = null;
      this._changed();
      this.emit('failed', job);
      this.tick();
    });

    this._changed();
    dl.start();
  }

  /* ---------- controls ---------- */

  pause(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    const dl = this.active.get(id);
    if (dl) dl.pause();
    else if (job.status === 'queued') {
      job.status = 'paused';
      this._changed();
    }
  }

  resume(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    const restartable = job.filePath || (job.kind === 'video' && job.video);
    if (['paused', 'failed', 'cancelled'].includes(job.status) && restartable) {
      job.status = 'queued';
      job.error = null;
      this._changed();
      this.tick();
    } else if (job.status === 'failed' && !restartable) {
      // Probe failed earlier: re-add from scratch.
      const { url, filename, dir, headers, segmentCount, source, kind, quality } = job;
      this.jobs.delete(id);
      this.add({ url, filename, dir, headers, segments: segmentCount, source, kind, quality });
    }
  }

  async remove(id, deleteFile = false) {
    const job = this.jobs.get(id);
    if (!job) return;
    const dl = this.active.get(id);
    if (dl) {
      job.status = 'cancelling';
      this.jobs.delete(id);
      await dl.cancel();
    } else if (job.kind === 'video') {
      if (job.status !== 'completed') await VideoDownload.cleanupDir(job.dir, job.video?.id);
      else if (deleteFile && job.filePath) await fsp.rm(job.filePath, { force: true }).catch(() => {});
    } else if (job.filePath) {
      await fsp.rm(job.filePath + PART_EXT, { force: true }).catch(() => {});
      await fsp.rm(job.filePath + STATE_EXT, { force: true }).catch(() => {});
      if (deleteFile && job.status === 'completed') {
        await fsp.rm(job.filePath, { force: true }).catch(() => {});
      }
    }
    this.jobs.delete(id);
    this._changed();
    this.tick();
  }

  pauseAll() {
    for (const j of this.jobs.values()) {
      if (j.status === 'downloading' || j.status === 'queued') this.pause(j.id);
    }
  }

  resumeAll() {
    for (const j of this.jobs.values()) {
      if (j.status === 'paused' || j.status === 'failed') this.resume(j.id);
    }
  }

  clearCompleted() {
    for (const j of [...this.jobs.values()]) {
      if (j.status === 'completed') this.jobs.delete(j.id);
    }
    this._changed();
  }

  async shutdown() {
    const pending = [...this.active.values()].map(
      (dl) => new Promise((resolve) => {
        dl.once('paused', resolve);
        dl.once('error', resolve);
        dl.once('complete', resolve);
        dl.pause();
      }),
    );
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 4000))]);
    clearTimeout(this._persistTimer);
    const list = [...this.jobs.values()].map((j) => {
      const out = {};
      for (const k of PERSIST_FIELDS) if (j[k] !== undefined) out[k] = j[k];
      if (out.status === 'downloading' || out.status === 'queued') out.status = 'paused';
      return out;
    });
    await fsp.writeFile(this.storePath, JSON.stringify(list, null, 2)).catch(() => {});
  }
}

module.exports = { Queue };
