'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Download, PART_EXT, STATE_EXT } = require('./downloader');
const { VideoDownload } = require('./ytdlp');
const { FtpDownload, probeFtp } = require('./ftp');
const { TorrentDownload } = require('./torrents');
const { GalleryDownload } = require('./gallerydl');
const { probe, sanitizeFilename } = require('./http');
const { categorize, resolveDir } = require('./categories');
const { writeCookieFile, removeCookieFile } = require('./cookies');
const { isDriveUrl, resolveDrive } = require('./gdrive');
const { unrestrict } = require('./debrid');
const { markFromInternet } = require('./motw');
const { verifyFile } = require('./checksum');
const { isArchive, extractArchive } = require('./archives');

/** Headers other than the ones yt-dlp has dedicated flags for. */
function extraHeadersOf(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^(referer|user-agent|cookie)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const PERSIST_FIELDS = [
  'id', 'url', 'finalUrl', 'filename', 'dir', 'filePath', 'size', 'resumable', 'contentType',
  'status', 'downloaded', 'segments', 'segmentCount', 'error', 'headers', 'addedAt', 'completedAt', 'lastTryAt', 'source',
  'kind', 'video', 'quality', 'stage', 'category', 'cookiesFile', 'container', 'imported',
  'queueId', 'description', 'checksum', 'torrent', 'retries', 'debrid', 'extractWhenDone', 'extracted', 'waitReason', 'extra',
];

const RETRY_DELAY_MS = 30000;

/**
 * Holds every job, persists them, and keeps at most `maxConcurrent` running.
 * Jobs in a named queue run only while that queue is running (Scheduler); jobs without a
 * queue run at once. Emits 'change' with a full serialisable snapshot (throttled), plus
 * 'completed' / 'failed' / 'duplicate' with the job.
 */
class Queue extends EventEmitter {
  constructor({ storePath, settings, limiter, ytdlp, gallerydl, scheduler, cookiesDir }) {
    super();
    this.storePath = storePath;
    this.settings = settings;
    this.limiter = limiter;
    this.ytdlp = ytdlp;
    this.gallerydl = gallerydl;
    this.scheduler = scheduler;
    this.cookiesDir = cookiesDir || path.join(path.dirname(storePath), 'cookies');
    this.jobs = new Map();
    this.active = new Map(); // id -> downloader
    this._persistTimer = null;
    this._changeTimer = null;
    this._retryTimers = new Map();
    this._load();
    if (scheduler) {
      scheduler.on('queue:start', () => this.tick());
      scheduler.on('queue:stop', (id) => this._stopQueueJobs(id));
      scheduler.on('limit', ({ hit }) => { if (!hit) this._releaseWaiting(); else this._holdForLimit(); });
      scheduler.on('tick', () => this.tick());
    }
  }

  /* ---------- persistence ---------- */

  _load() {
    try {
      if (!fs.existsSync(this.storePath)) return;
      const list = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      for (const j of list) {
        if (j.status === 'downloading' || j.status === 'probing' || j.status === 'queued' || j.status === 'waiting') {
          const resumable = j.filePath || (j.kind === 'video' && j.video) || (j.kind === 'torrent' && j.torrent) || j.kind === 'gallery';
          // Queue members go back to queued so a schedule can pick them up; loose jobs pause.
          j.status = resumable ? (j.queueId ? 'queued' : 'paused') : 'failed';
          if (!resumable) j.error = 'Interrupted before the download started';
        }
        j.speed = 0;
        j.eta = null;
        j.waitReason = null;
        this.jobs.set(j.id, j);
      }
    } catch (e) {
      console.error('Could not load jobs:', e.message);
    }
  }

  _serialize(j) {
    const out = {};
    for (const k of PERSIST_FIELDS) if (j[k] !== undefined) out[k] = j[k];
    return out;
  }

  _persist() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(async () => {
      const list = [...this.jobs.values()].map((j) => this._serialize(j));
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
      .map((j) => ({ ...j, torrent: j.torrent ? { ...j.torrent, torrentFile: undefined } : null }))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  get(id) {
    return this.jobs.get(id);
  }

  findByUrl(url) {
    const key = String(url || '').trim().toLowerCase();
    return [...this.jobs.values()].find((j) => (j.url || '').toLowerCase() === key || (j.finalUrl || '').toLowerCase() === key) || null;
  }

  /* ---------- adding ---------- */

  static kindFor(url, requested) {
    // The URL scheme wins for magnet and FTP links; a requested kind only picks video / gallery / torrent for http(s).
    if (/^magnet:/i.test(url)) return 'torrent';
    if (requested === 'video' || requested === 'gallery' || requested === 'torrent') return requested;
    if (/^(ftp|ftps|ftpes):\/\//i.test(url)) return 'ftp';
    return 'file';
  }

  /**
   * Add a download. Returns the job id, or { duplicate, existingId } when the URL is already
   * in the list and the duplicate policy is "ask" and no `onDuplicate` choice was given.
   */
  async add(opts) {
    const {
      filename, dir, headers = {}, segments, source = 'app', video = null, quality = null, cookieJar = null,
      queueId = null, description = '', checksum = null, torrent = null, extractWhenDone = null, onDuplicate = null,
    } = opts;
    let { url, autoStart = true } = opts;
    url = String(url || '').trim();
    const kind = Queue.kindFor(url, opts.kind);
    if (kind !== 'torrent' && !/^(https?|ftp|ftps|ftpes):\/\//i.test(url)) throw new Error('Only http(s), ftp(s) and magnet links are supported');
    if (kind === 'torrent' && !/^magnet:/i.test(url) && !(torrent && torrent.torrentFile)) throw new Error('A torrent needs a magnet link or a .torrent file');

    // Duplicate links.
    const existing = this.findByUrl(url);
    if (existing && !opts.allowDuplicate) {
      const setting = this.settings.get('duplicatePolicy') || 'ask';
      // 'auto' (browser / CLI adds, where nobody can answer a question) turns "ask" into a numbered copy.
      const policy = onDuplicate === 'auto' ? (setting === 'ask' ? 'numbered' : setting) : (onDuplicate || setting);
      if (policy === 'ask') return { duplicate: true, existingId: existing.id, existing: { ...existing } };
      if (policy === 'resume') {
        if (existing.status === 'completed') { this.emit('completed', existing, { again: true }); return existing.id; }
        this.resume(existing.id);
        return existing.id;
      }
      if (policy === 'overwrite') {
        await this.remove(existing.id, true);
      }
      // 'numbered' falls through: a new job with a numbered file name.
    }

    // Downloads start at once unless they are put in a queue ("Download Later").
    const targetQueue = autoStart ? null : (queueId || 'main');

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
      headers: { ...headers },
      addedAt: Date.now(),
      completedAt: null,
      lastTryAt: null,
      source,
      kind,
      video: null,
      quality: null,
      stage: null,
      cookiesFile: null,
      container: null,
      queueId: targetQueue,
      description: description || '',
      checksum: checksum ? { expected: String(checksum).trim(), result: null } : null,
      torrent: null,
      retries: 0,
      debrid: null,
      extractWhenDone: extractWhenDone,
      extracted: null,
      waitReason: null,
      extra: {},
    };
    this.jobs.set(job.id, job);
    this._changed();

    try {
      if (kind === 'video') {
        if (!this.ytdlp || !this.ytdlp.hasYtDlp()) throw new Error('yt-dlp is not installed. Install it from Settings.');
        job.cookiesFile = await writeCookieFile(this.cookiesDir, cookieJar, job.id);
        const context = { cookiesFile: job.cookiesFile, referer: headers.Referer, userAgent: headers['User-Agent'], extraHeaders: extraHeadersOf(headers) };
        const info = video || (await this.ytdlp.probe(url, context));
        if (info.isLive) throw new Error('Live streams are not supported yet. Try again once the stream has ended.');
        job.video = { id: info.id, title: info.title, extractor: info.extractor, duration: info.duration, thumbnail: info.thumbnail, uploader: info.uploader, webpage: info.webpage };
        job.quality = quality || this.settings.get('videoQuality') || 'best';
        job.container = this.settings.get('videoContainer') === 'mkv' ? 'mkv' : 'mp4';
        job.resumable = true;
        job.contentType = 'video via yt-dlp';
        job.filename = sanitizeFilename(info.title) + (job.quality === 'audio' ? '.m4a' : '.' + job.container);
        job.category = categorize(job, this.settings.get('categories'));
        job.dir = this._routeDir(dir, job.category);
      } else if (kind === 'gallery') {
        if (!this.gallerydl || !this.gallerydl.has()) throw new Error('gallery-dl is not installed. Install it from Settings.');
        job.cookiesFile = await writeCookieFile(this.cookiesDir, cookieJar, job.id);
        job.resumable = true;
        job.contentType = 'gallery via gallery-dl';
        job.filename = sanitizeFilename(filename || new URL(url).hostname + ' gallery');
        job.category = 'Images';
        job.dir = this._routeDir(dir, 'Images');
      } else if (kind === 'torrent') {
        const t = torrent || {};
        job.torrent = {
          torrentFile: t.torrentFile || null, infoHash: t.infoHash || null, name: t.name || null,
          files: t.files || null, selected: t.selected || null, sequential: !!t.sequential,
          share: t.share || this.settings.get('torrentShare') || { seed: true, ratio: 1, minutes: 0 },
        };
        job.resumable = true;
        job.contentType = 'torrent';
        job.filename = sanitizeFilename(t.name || filename || 'torrent');
        job.size = t.selected && t.files ? t.selected.reduce((a, i) => a + (t.files[i]?.length || 0), 0) : (t.length || null);
        job.category = 'Torrents';
        job.dir = this._routeDir(dir, 'Torrents');
      } else if (kind === 'ftp') {
        const info = await probeFtp(url, { passive: this.settings.get('ftpPassive') !== false });
        job.size = info.size;
        job.resumable = true;
        job.contentType = info.contentType;
        if (!job.filename) job.filename = info.filename;
        job.category = categorize(job, this.settings.get('categories'));
        job.dir = this._routeDir(dir, job.category);
        job.filePath = await this._uniquePath(job.dir, job.filename);
        job.filename = path.basename(job.filePath);
      } else {
        // Plain file: debrid and Google Drive first, then the usual probe.
        await this._resolveSpecialHosts(job);
        const info = await probe(job.finalUrl || url, job.headers);
        job.finalUrl = info.finalUrl;
        job.size = job.size ?? info.size;
        job.resumable = info.resumable && !job.extra.forceSingle;
        if (job.extra.forceSingle) job.segmentCount = 1;
        job.contentType = info.contentType;
        if (!job.filename) job.filename = info.filename;
        if (/^text\/html/i.test(info.contentType || '') && /^https?:/i.test(url) && !opts.forceFile) {
          job.contentType = info.contentType;
        }
        job.category = categorize(job, this.settings.get('categories'));
        job.dir = this._routeDir(dir, job.category);
        job.filePath = await this._uniquePath(job.dir, job.filename);
        job.filename = path.basename(job.filePath);
      }
      job.status = 'queued';
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      if (job.kind === 'video' && !job.video) { await removeCookieFile(job.cookiesFile); job.cookiesFile = null; }
      this.emit('failed', job);
    }
    this._changed();
    this.tick();
    return job.id;
  }

  async _resolveSpecialHosts(job) {
    const accounts = this.settings.get('debridAccounts') || [];
    if (accounts.some((a) => a && a.enabled !== false && a.key)) {
      const r = await unrestrict(job.url, accounts);
      if (r) {
        job.finalUrl = r.url;
        job.debrid = r.service;
        if (!job.filename && r.filename) job.filename = sanitizeFilename(r.filename);
        if (r.size) job.size = r.size;
        return;
      }
    }
    if (isDriveUrl(job.url)) {
      const r = await resolveDrive(job.url, job.headers);
      job.finalUrl = r.url;
      job.headers = { ...job.headers, ...(r.headers || {}) };
      if (!job.filename && r.filename) job.filename = r.filename;
      if (r.ext && !job.filename) job.filename = 'document' + r.ext;
      job.extra.gdrive = r.note || 'Google Drive';
      // Drive's confirm URLs answer a probe with 206 but serve every later request from the start.
      if (r.resumable === false) job.extra.forceSingle = true;
    }
  }

  _routeDir(chosenDir, category) {
    return resolveDir({ chosenDir, baseDir: this.settings.get('downloadDir'), organize: this.settings.get('organize'), category });
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

  /** Expand a batch pattern or a list of links into jobs (all go to a queue unless autoStart). */
  async addMany(items, common = {}) {
    const ids = [];
    for (const it of items) {
      const o = typeof it === 'string' ? { url: it } : it;
      try {
        const r = await this.add({ ...common, ...o, onDuplicate: common.onDuplicate || 'numbered' });
        if (typeof r === 'string') ids.push(r);
      } catch (e) {
        console.warn('addMany skipped', o.url, e.message);
      }
    }
    return ids;
  }

  /* ---------- scheduling ---------- */

  tick() {
    const max = this.settings.get('maxConcurrent');
    const limitHit = this.scheduler ? this.scheduler.limitReached() : false;
    const perQueueActive = new Map();
    for (const dl of this.active.keys()) {
      const j = this.jobs.get(dl);
      if (j && j.queueId) perQueueActive.set(j.queueId, (perQueueActive.get(j.queueId) || 0) + 1);
    }
    const queued = [...this.jobs.values()].filter((j) => j.status === 'queued' || j.status === 'waiting').sort((a, b) => a.addedAt - b.addedAt);
    for (const job of queued) {
      if (job.queueId) {
        const q = this.scheduler && this.scheduler.get(job.queueId);
        if (!q || !this.scheduler.isRunning(job.queueId)) continue;
        if ((perQueueActive.get(job.queueId) || 0) >= q.concurrent) continue;
      }
      if (limitHit) {
        if (job.status !== 'waiting') { job.status = 'waiting'; job.waitReason = 'Download limit reached; resumes when the period is over'; this._changed(); }
        continue;
      }
      if (this.active.size >= max) break;
      if (job.status === 'waiting') { job.status = 'queued'; job.waitReason = null; }
      this._start(job);
      if (job.queueId) perQueueActive.set(job.queueId, (perQueueActive.get(job.queueId) || 0) + 1);
    }
    this._checkDrainedQueues();
  }

  _checkDrainedQueues() {
    if (!this.scheduler) return;
    for (const q of this.scheduler.list()) {
      if (!q.running) continue;
      const pending = [...this.jobs.values()].some((j) => j.queueId === q.id && ['queued', 'downloading', 'probing', 'waiting'].includes(j.status));
      if (!pending && !this._retryPending(q.id)) this.scheduler.queueDrained(q.id);
    }
  }

  _retryPending(queueId) {
    for (const [id] of this._retryTimers) { const j = this.jobs.get(id); if (j && j.queueId === queueId) return true; }
    return false;
  }

  _stopQueueJobs(queueId) {
    for (const j of this.jobs.values()) {
      if (j.queueId !== queueId) continue;
      if (j.status === 'downloading') this.pause(j.id, { keepQueued: true });
      else if (j.status === 'waiting') { j.status = 'queued'; j.waitReason = null; }
    }
    this._changed();
  }

  _holdForLimit() {
    for (const j of this.jobs.values()) {
      if (j.status === 'downloading' && this.active.has(j.id)) {
        j.waitReason = 'Download limit reached; resumes when the period is over';
        this.pause(j.id, { keepQueued: true });
      }
    }
  }

  _releaseWaiting() {
    for (const j of this.jobs.values()) if (j.status === 'waiting') { j.status = 'queued'; j.waitReason = null; }
    this._changed();
    this.tick();
  }

  _start(job) {
    let dl;
    if (job.kind === 'video') {
      dl = new VideoDownload({
        ytdlp: this.ytdlp, url: job.url, dir: job.dir, quality: job.quality, videoId: job.video?.id,
        speedLimitKB: this.settings.get('speedLimitKB'), container: job.container || 'mp4',
        cookiesFile: job.cookiesFile, referer: job.headers?.Referer, userAgent: job.headers?.['User-Agent'], extraHeaders: extraHeadersOf(job.headers),
      });
    } else if (job.kind === 'gallery') {
      dl = new GalleryDownload({ gallerydl: this.gallerydl, url: job.url, dir: job.dir, cookiesFile: job.cookiesFile });
    } else if (job.kind === 'torrent') {
      const t = job.torrent || {};
      dl = new TorrentDownload({
        source: t.torrentFile ? Buffer.from(t.torrentFile, 'base64') : job.url,
        dir: job.dir, selected: t.selected, sequential: t.sequential, share: t.share,
      });
      dl.on('meta', (m) => { job.torrent = { ...job.torrent, infoHash: m.infoHash, name: m.name, files: m.files }; if (!job.filename || job.filename === 'torrent') job.filename = sanitizeFilename(m.name); this._changed(); });
    } else if (job.kind === 'ftp') {
      dl = new FtpDownload({ url: job.url, filePath: job.filePath, size: job.size, passive: this.settings.get('ftpPassive') !== false, limiter: this.limiter });
    } else {
      dl = new Download({
        url: job.finalUrl || job.url, filePath: job.filePath, headers: job.headers, segments: job.segmentCount,
        size: job.size, resumable: job.resumable, limiter: this.limiter,
      });
    }
    this.active.set(job.id, dl);
    job.status = 'downloading';
    job.error = null;
    job.waitReason = null;
    job.lastTryAt = Date.now();
    job.stage = job.kind === 'video' || job.kind === 'torrent' ? 'starting' : null;

    let lastBytes = job.downloaded || 0;
    dl.on('progress', (p) => {
      job.downloaded = p.downloaded;
      job.size = p.size;
      job.speed = p.speed;
      job.eta = p.eta;
      job.segments = p.segments || [];
      if (p.stage) job.stage = p.stage + (p.stream ? ' (stream ' + (p.stream + 1) + ')' : '');
      if (p.uploadSpeed !== undefined) job.extra = { ...job.extra, uploadSpeed: p.uploadSpeed, peers: p.peers, ratio: p.ratio };
      if (this.scheduler && p.downloaded > lastBytes) { this.scheduler.recordBytes(p.downloaded - lastBytes); lastBytes = p.downloaded; }
      this._changed(false);
    });
    dl.on('log', (msg) => console.log('[' + job.filename + '] ' + msg));
    dl.on('paused', () => {
      this.active.delete(job.id);
      if (this.jobs.has(job.id)) {
        if (job.status === 'cancelling') job.status = 'cancelled';
        else if (job._keepQueued) job.status = job.waitReason ? 'waiting' : 'queued';
        else job.status = 'paused';
        delete job._keepQueued;
        job.speed = 0;
        job.eta = null;
        this._changed();
      }
      this.tick();
    });
    dl.on('complete', (r) => this._onComplete(job, r));
    dl.on('error', (err) => this._onError(job, err));

    this._changed();
    dl.start();
  }

  async _onComplete(job, r) {
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
    if (job.cookiesFile) { removeCookieFile(job.cookiesFile); job.cookiesFile = null; }
    if (job.torrent && job.torrent.torrentFile && this.settings.get('keepTorrentFiles') === false) job.torrent.torrentFile = null;
    this._changed();

    // After-download steps: mark of the web, checksum, extraction.
    try {
      if (this.settings.get('markOfTheWeb') !== false && job.filePath && job.kind !== 'torrent' && job.kind !== 'gallery') {
        await markFromInternet(job.filePath, { url: job.url, referer: job.headers?.Referer });
      }
      if (job.checksum && job.checksum.expected && job.filePath) await this.verifyChecksum(job.id);
      const wantExtract = job.extractWhenDone ?? this.settings.get('extractArchives');
      if (wantExtract && job.filePath && isArchive(job.filename)) await this.extract(job.id);
    } catch (e) {
      job.extra = { ...job.extra, postError: e.message };
    }
    this.emit('completed', job);
    this._changed();
    this.tick();
  }

  _onError(job, err) {
    this.active.delete(job.id);
    job.speed = 0;
    job.eta = null;
    const q = job.queueId && this.scheduler ? this.scheduler.get(job.queueId) : null;
    const maxRetries = q ? Number(q.schedule.retries) || 0 : 0;
    if (q && this.scheduler.isRunning(q.id) && (maxRetries === 0 || job.retries < maxRetries)) {
      // In a running queue: move to the end and try again shortly.
      job.retries += 1;
      job.status = 'queued';
      job.error = err.message + ' (retry ' + job.retries + (maxRetries ? '/' + maxRetries : '') + ' in 30 s)';
      job.addedAt = Date.now();
      const t = setTimeout(() => { this._retryTimers.delete(job.id); this.tick(); }, RETRY_DELAY_MS);
      this._retryTimers.set(job.id, t);
      this._changed();
      return;
    }
    job.status = 'failed';
    job.error = err.message;
    this._changed();
    this.emit('failed', job);
    this.tick();
  }

  /* ---------- controls ---------- */

  pause(id, { keepQueued = false } = {}) {
    const job = this.jobs.get(id);
    if (!job) return;
    const dl = this.active.get(id);
    if (dl) { if (keepQueued) job._keepQueued = true; dl.pause(); }
    else if (job.status === 'queued' || job.status === 'waiting') {
      job.status = 'paused';
      job.waitReason = null;
      this._changed();
    }
  }

  resume(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    const restartable = job.filePath || (job.kind === 'video' && job.video) || (job.kind === 'torrent' && job.torrent) || job.kind === 'gallery';
    if (['paused', 'failed', 'cancelled'].includes(job.status) && restartable) {
      job.status = 'queued';
      job.error = null;
      job.retries = 0;
      this._changed();
      this.tick();
    } else if (job.status === 'failed' && !restartable) {
      const { url, filename, dir, headers, segmentCount, source, kind, quality, queueId, description } = job;
      this.jobs.delete(id);
      this.add({ url, filename, dir, headers, segments: segmentCount, source, kind, quality, queueId, description, autoStart: !queueId, allowDuplicate: true });
    }
  }

  async remove(id, deleteFile = false) {
    const job = this.jobs.get(id);
    if (!job) return;
    const t = this._retryTimers.get(id);
    if (t) { clearTimeout(t); this._retryTimers.delete(id); }
    const dl = this.active.get(id);
    if (dl) {
      job.status = 'cancelling';
      this.jobs.delete(id);
      await dl.cancel();
      await removeCookieFile(job.cookiesFile);
    } else if (job.kind === 'video') {
      if (job.status !== 'completed') await VideoDownload.cleanupDir(job.dir, job.video?.id);
      else if (deleteFile && job.filePath) await fsp.rm(job.filePath, { force: true }).catch(() => {});
      await removeCookieFile(job.cookiesFile);
    } else if (job.kind === 'torrent') {
      if (deleteFile && job.filePath) await fsp.rm(job.filePath, { recursive: true, force: true }).catch(() => {});
    } else if (job.filePath) {
      await fsp.rm(job.filePath + PART_EXT, { force: true }).catch(() => {});
      await fsp.rm(job.filePath + STATE_EXT, { force: true }).catch(() => {});
      if (deleteFile) await fsp.rm(job.filePath, { force: true }).catch(() => {});
    }
    this.jobs.delete(id);
    this._changed();
    this.tick();
  }

  pauseAll() {
    for (const j of this.jobs.values()) if (j.status === 'downloading' || j.status === 'queued' || j.status === 'waiting') this.pause(j.id);
  }

  resumeAll() {
    for (const j of this.jobs.values()) if (j.status === 'paused' || j.status === 'failed') this.resume(j.id);
  }

  clearCompleted() {
    for (const j of [...this.jobs.values()]) if (j.status === 'completed') this.jobs.delete(j.id);
    this._changed();
  }

  async clearFailed() {
    for (const j of [...this.jobs.values()]) if (j.status === 'failed' || j.status === 'cancelled') await this.remove(j.id, false);
    this._changed();
  }

  /* ---------- editing a job ---------- */

  setDescription(id, text) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.description = String(text || '').slice(0, 1000);
    this._changed();
  }

  /** Change the address of an unfinished download (expired link, mirror). */
  async changeUrl(id, url) {
    const job = this.jobs.get(id);
    if (!job || job.status === 'downloading' || job.status === 'completed') throw new Error('Stop the download first');
    url = String(url || '').trim();
    if (!/^(https?|ftp|ftps|ftpes):\/\//i.test(url)) throw new Error('Not a valid address');
    job.url = url;
    job.finalUrl = url;
    job.error = null;
    if (job.kind === 'file') {
      try {
        const info = await probe(url, job.headers);
        job.finalUrl = info.finalUrl;
        job.resumable = info.resumable;
        if (job.size != null && info.size != null && info.size !== job.size) {
          // A different file: start over rather than mixing two versions.
          await fsp.rm(job.filePath + PART_EXT, { force: true }).catch(() => {});
          await fsp.rm(job.filePath + STATE_EXT, { force: true }).catch(() => {});
          job.downloaded = 0;
          job.segments = [];
        }
        job.size = info.size;
      } catch (e) {
        job.error = e.message;
      }
    }
    this._changed();
  }

  /** Download again from scratch (deletes the finished file first). */
  async redownload(id) {
    const job = this.jobs.get(id);
    if (!job || this.active.has(id)) return;
    if (job.filePath) {
      await fsp.rm(job.filePath, { force: true, recursive: job.kind === 'torrent' }).catch(() => {});
      await fsp.rm(job.filePath + PART_EXT, { force: true }).catch(() => {});
      await fsp.rm(job.filePath + STATE_EXT, { force: true }).catch(() => {});
    }
    job.downloaded = 0;
    job.segments = [];
    job.completedAt = null;
    job.error = null;
    job.retries = 0;
    if (job.checksum) job.checksum.result = null;
    job.extracted = null;
    job.status = 'queued';
    this._changed();
    this.tick();
  }

  /** Move or rename a finished file (or set a new target for one that has not started). */
  async moveFile(id, newPath) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown download');
    if (this.active.has(id)) throw new Error('Stop the download first');
    if (!path.isAbsolute(newPath)) throw new Error('Give a full path');
    await fsp.mkdir(path.dirname(newPath), { recursive: true });
    if (job.status === 'completed' && job.filePath && fs.existsSync(job.filePath)) {
      try { await fsp.rename(job.filePath, newPath); }
      catch (e) { if (e.code !== 'EXDEV') throw e; await fsp.copyFile(job.filePath, newPath); await fsp.rm(job.filePath, { force: true }); }
    } else if (job.filePath) {
      for (const ext of ['', PART_EXT, STATE_EXT]) if (fs.existsSync(job.filePath + ext)) await fsp.rename(job.filePath + ext, newPath + ext);
    }
    job.filePath = newPath;
    job.filename = path.basename(newPath);
    job.dir = path.dirname(newPath);
    this._changed();
  }

  async setChecksum(id, expected) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.checksum = expected ? { expected: String(expected).trim(), result: null } : null;
    this._changed();
    if (job.checksum && job.status === 'completed') return this.verifyChecksum(id);
    return null;
  }

  async verifyChecksum(id) {
    const job = this.jobs.get(id);
    if (!job || !job.checksum || !job.filePath) return null;
    try {
      const r = await verifyFile(job.filePath, job.checksum.expected, (done, total) => {
        job.checksum.progress = total ? done / total : 0;
        this._changed(false);
      });
      job.checksum.result = { algo: r.algo, actual: r.actual, match: r.match, at: Date.now() };
      job.checksum.progress = undefined;
    } catch (e) {
      job.checksum.result = { error: e.message, at: Date.now() };
    }
    this._changed();
    this.emit('checksum', job);
    return job.checksum.result;
  }

  async extract(id, { password = null } = {}) {
    const job = this.jobs.get(id);
    if (!job || !job.filePath || job.status !== 'completed') throw new Error('Only a finished download can be extracted');
    job.extracted = { status: 'running' };
    this._changed(false);
    try {
      const r = await extractArchive(job.filePath, { mode: this.settings.get('extractInto') || 'auto', password });
      job.extracted = { status: 'done', target: r.target, count: r.count, at: Date.now() };
      if (this.settings.get('deleteArchiveAfterExtract')) {
        const { shell } = require('electron');
        await shell.trashItem(job.filePath).catch(() => fsp.rm(job.filePath, { force: true }));
        job.extra = { ...job.extra, archiveTrashed: true };
      }
    } catch (e) {
      job.extracted = { status: 'failed', error: e.message, at: Date.now() };
      throw e;
    } finally {
      this._changed();
    }
    return job.extracted;
  }

  stopSeeding(id) {
    const dl = this.active.get(id);
    if (dl && typeof dl.stopSeeding === 'function') dl.stopSeeding();
  }

  /* ---------- queues ---------- */

  addToQueue(ids, queueId) {
    for (const id of [].concat(ids)) {
      const job = this.jobs.get(id);
      if (!job) continue;
      job.queueId = queueId || null;
      if (job.status === 'downloading' && queueId && this.scheduler && !this.scheduler.isRunning(queueId)) this.pause(id, { keepQueued: true });
      else if (job.status === 'paused' && queueId) job.status = 'queued';
    }
    this._changed();
    this.tick();
  }

  removeFromQueue(ids) {
    for (const id of [].concat(ids)) {
      const job = this.jobs.get(id);
      if (!job) continue;
      job.queueId = null;
      if (job.status === 'queued' || job.status === 'waiting') job.status = 'paused';
    }
    this._changed();
  }

  /* ---------- import ---------- */

  async importFile({ path: srcPath, filename, url, referer, mime, source = 'browser' }) {
    if (!srcPath || !path.isAbsolute(srcPath)) throw new Error('A full file path is required');
    let st;
    try { st = await fsp.stat(srcPath); } catch { throw new Error('File not found: ' + srcPath); }
    if (!st.isFile()) throw new Error('Not a file: ' + srcPath);

    const name = sanitizeFilename(filename || path.basename(srcPath));
    const category = categorize({ filename: name, contentType: mime }, this.settings.get('categories'));
    const dir = this._routeDir(null, category);
    await fsp.mkdir(dir, { recursive: true });
    const target = await this._uniquePath(dir, name);

    if (path.resolve(target) !== path.resolve(srcPath)) {
      try { await fsp.rename(srcPath, target); }
      catch (e) { if (e.code !== 'EXDEV') throw e; await fsp.copyFile(srcPath, target); await fsp.rm(srcPath, { force: true }); }
    }

    const job = {
      id: crypto.randomUUID(), url: url || 'file://' + srcPath, finalUrl: url || null, filename: path.basename(target), dir, filePath: target,
      size: st.size, resumable: false, contentType: mime || null, status: 'completed', downloaded: st.size, speed: 0, eta: null,
      segments: [], segmentCount: 1, error: null, headers: referer ? { Referer: referer } : {}, addedAt: Date.now(), completedAt: Date.now(),
      lastTryAt: Date.now(), source, kind: 'file', category, imported: true, queueId: null, description: '', checksum: null, torrent: null,
      retries: 0, debrid: null, extractWhenDone: null, extracted: null, waitReason: null, extra: {},
    };
    this.jobs.set(job.id, job);
    this._changed();
    this.emit('completed', job);
    return { id: job.id, filePath: target, category };
  }

  async shutdown() {
    for (const t of this._retryTimers.values()) clearTimeout(t);
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
      const out = this._serialize(j);
      if (out.status === 'downloading' || out.status === 'waiting') out.status = out.queueId ? 'queued' : 'paused';
      return out;
    });
    await fsp.writeFile(this.storePath, JSON.stringify(list, null, 2)).catch(() => {});
  }
}

module.exports = { Queue };
