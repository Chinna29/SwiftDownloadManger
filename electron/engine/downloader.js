'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { request } = require('./http');

const PART_EXT = '.sfdownload';
const STATE_EXT = '.sfpart';
const MIN_SEGMENT_BYTES = 256 * 1024;
const PROGRESS_INTERVAL_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One file download. Emits: 'progress', 'paused', 'complete', 'error', 'log'.
 *
 * Files on disk while in flight:
 *   <target>.sfdownload  the data, pre-sized, written at segment offsets
 *   <target>.sfpart      JSON state so a paused/crashed download can resume
 */
class Download extends EventEmitter {
  constructor(opts) {
    super();
    this.url = opts.url;
    this.filePath = opts.filePath;
    this.headers = opts.headers || {};
    this.wantSegments = Math.max(1, Math.min(32, opts.segments || 8));
    this.size = opts.size ?? null;
    this.resumable = !!opts.resumable;
    this.limiter = opts.limiter || null;
    this.maxRetries = opts.maxRetries ?? 8;

    this.partPath = this.filePath + PART_EXT;
    this.statePath = this.filePath + STATE_EXT;

    this.segments = [];
    this.downloaded = 0;
    this.speed = 0;
    this.stopped = false;
    this.cancelled = false;
    this.running = false;
    this.fh = null;
    this.ac = null;
    this._timer = null;
    this._stateTimer = null;
    this._lastTick = { t: 0, bytes: 0 };
  }

  /* ---------- state persistence ---------- */

  async _loadState() {
    try {
      const raw = await fsp.readFile(this.statePath, 'utf8');
      const st = JSON.parse(raw);
      if (st.url !== this.url || !Array.isArray(st.segments)) return false;
      if (!fs.existsSync(this.partPath)) return false;
      this.size = st.size;
      this.resumable = st.resumable;
      this.segments = st.segments.map((s) => ({ ...s, retries: 0 }));
      this.downloaded = this.segments.reduce((a, s) => a + s.downloaded, 0);
      return true;
    } catch {
      return false;
    }
  }

  async _saveState() {
    const st = {
      url: this.url,
      size: this.size,
      resumable: this.resumable,
      segments: this.segments.map(({ start, end, downloaded }) => ({ start, end, downloaded })),
    };
    try {
      await fsp.writeFile(this.statePath, JSON.stringify(st));
    } catch (e) {
      this.emit('log', 'Could not save state: ' + e.message);
    }
  }

  _planSegments() {
    if (!this.resumable || !this.size || this.size < MIN_SEGMENT_BYTES * 2) {
      this.segments = [{ start: 0, end: this.size ? this.size - 1 : -1, downloaded: 0, retries: 0 }];
      return;
    }
    const n = Math.min(this.wantSegments, Math.floor(this.size / MIN_SEGMENT_BYTES));
    const chunk = Math.floor(this.size / n);
    this.segments = [];
    for (let i = 0; i < n; i++) {
      const start = i * chunk;
      const end = i === n - 1 ? this.size - 1 : start + chunk - 1;
      this.segments.push({ start, end, downloaded: 0, retries: 0 });
    }
  }

  /* ---------- lifecycle ---------- */

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.cancelled = false;
    this.ac = new AbortController();

    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const resumed = await this._loadState();
      if (!resumed) {
        this._planSegments();
        this.downloaded = 0;
        this.fh = await fsp.open(this.partPath, 'w');
        if (this.size) await this.fh.truncate(this.size); // pre-allocate
        await this._saveState();
      } else {
        this.emit('log', 'Resuming from ' + this.downloaded + ' bytes');
        this.fh = await fsp.open(this.partPath, 'r+');
      }

      this._startProgressTimer();
      await Promise.all(this.segments.map((seg) => this._runSegment(seg)));
      this._stopProgressTimer();

      if (this.stopped) {
        await this._saveState();
        await this._closeHandle();
        if (this.cancelled) await this._deleteParts();
        this.emit('paused');
        return;
      }

      await this._closeHandle();
      if (this.size != null && this.downloaded !== this.size) {
        throw new Error('Size mismatch: expected ' + this.size + ', got ' + this.downloaded);
      }
      await fsp.rename(this.partPath, this.filePath);
      await fsp.rm(this.statePath, { force: true });
      this._emitProgress();
      this.emit('complete', { filePath: this.filePath, size: this.downloaded });
    } catch (err) {
      this._stopProgressTimer();
      this.stopped = true;
      if (this.ac) this.ac.abort();
      await this._saveState();
      await this._closeHandle();
      if (this.cancelled) {
        await this._deleteParts();
        this.emit('paused');
      } else {
        this.emit('error', err);
      }
    } finally {
      this.running = false;
    }
  }

  pause() {
    if (!this.running || this.stopped) return;
    this.stopped = true;
    this.ac.abort();
  }

  async cancel() {
    this.cancelled = true;
    if (this.running) {
      this.stopped = true;
      this.ac.abort();
    } else {
      await this._deleteParts();
    }
  }

  async _deleteParts() {
    await fsp.rm(this.partPath, { force: true }).catch(() => {});
    await fsp.rm(this.statePath, { force: true }).catch(() => {});
  }

  async _closeHandle() {
    if (this.fh) {
      const fh = this.fh;
      this.fh = null;
      await fh.close().catch(() => {});
    }
  }

  /* ---------- segment worker ---------- */

  async _runSegment(seg) {
    const ranged = this.resumable && this.size != null;
    for (;;) {
      if (this.stopped) return;
      const from = seg.start + seg.downloaded;
      if (ranged && from > seg.end) return;

      let res;
      try {
        const headers = { ...this.headers };
        if (ranged) headers.Range = 'bytes=' + from + '-' + seg.end;
        res = await request(this.url, { headers, signal: this.ac.signal });

        if (ranged && res.statusCode !== 206) {
          res.resume();
          throw new Error('Server ignored Range request (HTTP ' + res.statusCode + ')');
        }
        if (!ranged) {
          if (res.statusCode !== 200) { res.resume(); throw new Error('HTTP ' + res.statusCode); }
          // Non-resumable: always restarts from byte 0.
          if (seg.downloaded) {
            seg.downloaded = 0;
            this.downloaded = 0;
          }
          if (this.size == null && res.headers['content-length']) {
            this.size = Number(res.headers['content-length']);
            seg.end = this.size - 1;
          }
        }

        await this._pipe(res, seg, ranged);
        if (!ranged && this.size == null) {
          this.size = seg.downloaded;
          seg.end = this.size - 1;
        }
        return;
      } catch (err) {
        if (res) res.destroy();
        if (this.stopped) return;
        seg.retries += 1;
        if (seg.retries > this.maxRetries) throw err;
        const backoff = Math.min(30000, 500 * Math.pow(2, seg.retries - 1));
        this.emit('log', 'Segment ' + seg.start + '-' + seg.end + ' failed (' + err.message + '); retry ' + seg.retries + ' in ' + backoff + 'ms');
        await sleep(backoff);
      }
    }
  }

  async _pipe(res, seg, ranged) {
    for await (let chunk of res) {
      if (this.stopped) { res.destroy(); return; }
      if (ranged) {
        const remaining = seg.end - (seg.start + seg.downloaded) + 1;
        if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
        if (chunk.length === 0) { res.destroy(); return; }
      }
      if (this.limiter) await this.limiter.take(chunk.length);
      const position = seg.start + seg.downloaded;
      await this.fh.write(chunk, 0, chunk.length, position);
      seg.downloaded += chunk.length;
      this.downloaded += chunk.length;
      if (ranged && seg.start + seg.downloaded > seg.end) { res.destroy(); return; }
    }
    if (ranged && seg.start + seg.downloaded <= seg.end) {
      throw new Error('Connection closed before segment finished');
    }
  }

  /* ---------- progress ---------- */

  _startProgressTimer() {
    this._lastTick = { t: Date.now(), bytes: this.downloaded };
    this._timer = setInterval(() => this._emitProgress(), PROGRESS_INTERVAL_MS);
    this._stateTimer = setInterval(() => this._saveState(), 5000);
  }

  _stopProgressTimer() {
    clearInterval(this._timer);
    clearInterval(this._stateTimer);
    this._timer = this._stateTimer = null;
  }

  _emitProgress() {
    const now = Date.now();
    const dt = (now - this._lastTick.t) / 1000;
    if (dt > 0) {
      const inst = (this.downloaded - this._lastTick.bytes) / dt;
      this.speed = this.speed ? this.speed * 0.7 + inst * 0.3 : inst;
      this._lastTick = { t: now, bytes: this.downloaded };
    }
    const remaining = this.size != null ? this.size - this.downloaded : null;
    const eta = remaining != null && this.speed > 1 ? remaining / this.speed : null;
    this.emit('progress', {
      downloaded: this.downloaded,
      size: this.size,
      speed: this.speed,
      eta,
      segments: this.segments.map(({ start, end, downloaded }) => ({ start, end, downloaded })),
    });
  }
}

module.exports = { Download, PART_EXT, STATE_EXT };
