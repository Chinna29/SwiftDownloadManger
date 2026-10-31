'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { Download } = require('./downloader');
const { probe: httpProbe, sanitizeFilename } = require('./http');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_URL = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
// yt-dlp needs a JavaScript runtime to solve YouTube's player challenges; Deno is the one it recommends.
const DENO_URL = 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip';

const QUALITIES = [
  { key: 'best', label: 'Best available' },
  { key: '2160', label: '4K (2160p)' },
  { key: '1440', label: '1440p' },
  { key: '1080', label: '1080p' },
  { key: '720', label: '720p' },
  { key: '480', label: '480p' },
  { key: '360', label: '360p' },
  { key: 'audio', label: 'Audio only' },
];

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

/** Manages the yt-dlp and ffmpeg binaries under <binDir> and runs probes. */
class YtDlp {
  constructor(binDir) {
    this.binDir = binDir;
    this.exe = path.join(binDir, 'yt-dlp.exe');
    this.ffmpeg = path.join(binDir, 'ffmpeg.exe');
    this.deno = path.join(binDir, 'deno.exe');
    this._installing = null;
  }

  hasYtDlp() { return fs.existsSync(this.exe); }
  hasFfmpeg() { return fs.existsSync(this.ffmpeg); }
  hasDeno() { return fs.existsSync(this.deno); }

  /** Extra args that point yt-dlp at the bundled runtimes. */
  runtimeArgs() {
    const args = [];
    if (this.hasDeno()) args.push('--js-runtimes', 'deno:' + this.deno);
    if (this.hasFfmpeg()) args.push('--ffmpeg-location', this.binDir);
    return args;
  }

  async status() {
    const out = { ytdlp: null, ffmpeg: null, deno: null, binDir: this.binDir, installing: this._installing };
    if (this.hasYtDlp()) {
      const r = await run(this.exe, ['--version']);
      out.ytdlp = r.code === 0 ? r.stdout.trim() : 'installed';
    }
    if (this.hasFfmpeg()) {
      const r = await run(this.ffmpeg, ['-version']);
      const m = /ffmpeg version (\S+)/.exec(r.stdout);
      out.ffmpeg = m ? m[1] : 'installed';
    }
    if (this.hasDeno()) {
      const r = await run(this.deno, ['--version']);
      const m = /deno (\S+)/.exec(r.stdout);
      out.deno = m ? m[1] : 'installed';
    }
    return out;
  }

  /**
   * Download yt-dlp.exe or the ffmpeg zip (and extract it). onProgress({kind, downloaded, size, phase}).
   */
  async install(kind, onProgress = () => {}) {
    if (this._installing) throw new Error('Another install is already running');
    this._installing = kind;
    try {
      await fsp.mkdir(this.binDir, { recursive: true });
      if (kind === 'ytdlp') {
        const tmp = path.join(this.binDir, 'yt-dlp.download.exe');
        await this._fetch(YTDLP_URL, tmp, (p) => onProgress({ kind, ...p, phase: 'downloading' }));
        await fsp.rename(tmp, this.exe);
        // The JS runtime is effectively part of a working yt-dlp install for YouTube.
        if (!this.hasDeno()) await this._installZip('deno', DENO_URL, ['deno.exe'], onProgress);
      } else if (kind === 'deno') {
        await this._installZip('deno', DENO_URL, ['deno.exe'], onProgress);
      } else if (kind === 'ffmpeg') {
        await this._installZip('ffmpeg', FFMPEG_URL, ['ffmpeg.exe', 'ffprobe.exe'], onProgress);
      } else {
        throw new Error('Unknown component: ' + kind);
      }
      onProgress({ kind, phase: 'done' });
    } finally {
      this._installing = null;
    }
  }

  async _installZip(kind, url, exeNames, onProgress) {
    const zip = path.join(this.binDir, kind + '.zip');
    const tmpDir = path.join(this.binDir, kind + '-tmp');
    await this._fetch(url, zip, (p) => onProgress({ kind, ...p, phase: 'downloading' }));
    onProgress({ kind, phase: 'extracting' });
    await fsp.rm(tmpDir, { recursive: true, force: true });
    const r = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
    ]);
    if (r.code !== 0) throw new Error('Could not extract ' + kind + ': ' + (r.stderr || r.stdout).trim());
    for (const name of exeNames) {
      const found = await findFile(tmpDir, name);
      if (!found) throw new Error(name + ' not found in archive');
      await fsp.copyFile(found, path.join(this.binDir, name));
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.rm(zip, { force: true });
  }

  async _fetch(url, filePath, onProgress) {
    const info = await httpProbe(url);
    await fsp.rm(filePath, { force: true });
    await fsp.rm(filePath + '.sfpart', { force: true });
    const dl = new Download({ url: info.finalUrl, filePath, segments: 4, size: info.size, resumable: info.resumable });
    await new Promise((resolve, reject) => {
      dl.on('progress', (p) => onProgress({ downloaded: p.downloaded, size: p.size }));
      dl.once('complete', resolve);
      dl.once('error', reject);
      dl.once('paused', () => reject(new Error('Download interrupted')));
      dl.start();
    });
  }

  async update() {
    if (!this.hasYtDlp()) throw new Error('yt-dlp is not installed');
    const r = await run(this.exe, ['-U']);
    return (r.stdout + r.stderr).trim().split('\n').pop();
  }

  /** Ask yt-dlp for metadata. Returns a compact description for the UI. */
  async probe(url) {
    if (!this.hasYtDlp()) throw new Error('yt-dlp is not installed');
    const r = await run(this.exe, [...this.runtimeArgs(), '-J', '--no-playlist', '--no-warnings', '--no-check-formats', url], { timeout: 60000 });
    if (r.code !== 0) throw new Error(cleanError(r.stderr) || 'yt-dlp could not read this page');
    let info;
    try { info = JSON.parse(r.stdout); } catch { throw new Error('yt-dlp returned unreadable data'); }
    if (info._type === 'playlist' && info.entries?.length) info = info.entries[0];

    const formats = info.formats || [];
    const heights = new Set();
    let hasAudioOnly = false;
    for (const f of formats) {
      if (f.vcodec && f.vcodec !== 'none' && f.height) heights.add(f.height);
      if ((!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none') hasAudioOnly = true;
    }
    const maxHeight = heights.size ? Math.max(...heights) : null;
    const available = QUALITIES.filter((q) => {
      if (q.key === 'best') return true;
      if (q.key === 'audio') return hasAudioOnly || heights.size === 0;
      return [...heights].some((h) => h <= Number(q.key) && h > (nextLower(q.key) || 0));
    }).map((q) => {
      const est = estimateSize(formats, q.key, maxHeight, this.hasFfmpeg());
      return { ...q, size: est.size, height: est.height, merged: est.merged };
    }).filter((q) => {
      // Drop presets that would silently resolve to a lower resolution (e.g. 1080p -> 360p without ffmpeg).
      if (q.key === 'best' || q.key === 'audio') return true;
      return q.height != null && q.height > (nextLower(q.key) || 0);
    });

    return {
      id: info.id,
      title: info.title || info.id,
      extractor: info.extractor_key || info.extractor,
      duration: info.duration || null,
      thumbnail: info.thumbnail || null,
      uploader: info.uploader || info.channel || null,
      webpage: info.webpage_url || url,
      ext: info.ext || 'mp4',
      heights: [...heights].sort((a, b) => b - a),
      qualities: available,
    };
  }

  formatArgs(quality) {
    const ff = this.hasFfmpeg();
    if (quality === 'audio') {
      return ff ? ['-f', 'ba/b', '-x', '--audio-format', 'm4a'] : ['-f', 'ba[ext=m4a]/ba/b'];
    }
    const h = quality && quality !== 'best' ? Number(quality) : null;
    const cap = h ? `[height<=${h}]` : '';
    if (ff) return ['-f', `bv*${cap}+ba/b${cap}/bv*+ba/b`, '--merge-output-format', 'mp4'];
    return ['-f', `b${cap}/b/bv*${cap}`];
  }
}

/**
 * Rough size for a quality preset, mirroring the format selector: best video at or below the cap
 * plus best audio when ffmpeg can merge, otherwise the best pre-merged (progressive) format.
 */
function estimateSize(formats, key, maxHeight, canMerge) {
  const sz = (f) => f.filesize ?? f.filesize_approx ?? null;
  const hasV = (f) => f.vcodec && f.vcodec !== 'none';
  const hasA = (f) => f.acodec && f.acodec !== 'none';
  const rank = (f) => (f.height || 0) * 1e6 + (f.tbr || 0);
  const audioAll = formats.filter((f) => hasA(f) && !hasV(f)).sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
  const audio = audioAll[0];

  if (key === 'audio') {
    // Without ffmpeg we fetch ba[ext=m4a]/ba, so estimate the same way.
    const f = (!canMerge && audioAll.find((a) => a.ext === 'm4a')) || audio || formats.filter(hasA).sort((a, b) => (a.tbr || 0) - (b.tbr || 0))[0];
    return { size: f ? sz(f) : null, height: null, merged: false };
  }
  const cap = key === 'best' ? maxHeight || Infinity : Number(key);
  if (canMerge) {
    const v = formats.filter((f) => hasV(f) && (f.height || 0) <= cap).sort((a, b) => rank(b) - rank(a))[0];
    if (!v) return { size: null, height: null, merged: false };
    if (hasA(v)) return { size: sz(v), height: v.height, merged: false };
    const vs = sz(v), as = audio ? sz(audio) : null;
    return { size: vs != null ? vs + (as || 0) : null, height: v.height, merged: true };
  }
  const p = formats.filter((f) => hasV(f) && hasA(f) && (f.height || 0) <= cap).sort((a, b) => rank(b) - rank(a))[0];
  return p ? { size: sz(p), height: p.height, merged: false } : { size: null, height: null, merged: false };
}

function nextLower(key) {
  const order = QUALITIES.filter((q) => /^\d+$/.test(q.key)).map((q) => Number(q.key));
  const i = order.indexOf(Number(key));
  return order[i + 1] ?? null;
}

async function findFile(dir, name) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = await findFile(p, name);
      if (r) return r;
    } else if (e.name.toLowerCase() === name) {
      return p;
    }
  }
  return null;
}

function cleanError(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.filter((l) => /^ERROR/i.test(l)).pop() || lines.pop() || '';
  return err.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').slice(0, 300);
}

/**
 * Runs one yt-dlp download as a child process. Same event surface as Download:
 * 'progress', 'paused', 'complete', 'error', 'log'.
 */
class VideoDownload extends EventEmitter {
  constructor({ ytdlp, url, dir, quality, videoId, speedLimitKB = 0 }) {
    super();
    this.ytdlp = ytdlp;
    this.url = url;
    this.dir = dir;
    this.quality = quality || 'best';
    this.videoId = videoId;
    this.speedLimitKB = speedLimitKB;
    this.proc = null;
    this.stopped = false;
    this.cancelled = false;
    this.downloaded = 0;
    this.size = null;
    this.speed = 0;
    this.eta = null;
    this.stage = 'starting';
    this.stream = 0;
    this.finalPath = null;
    this.lastError = '';
  }

  async start() {
    if (!this.ytdlp.hasYtDlp()) {
      this.emit('error', new Error('yt-dlp is not installed. Install it from Settings.'));
      return;
    }
    await fsp.mkdir(this.dir, { recursive: true });
    const outTpl = path.join(this.dir, '%(title)s [%(id)s].%(ext)s');
    const args = [
      ...this.ytdlp.runtimeArgs(),
      ...this.ytdlp.formatArgs(this.quality),
      '-o', outTpl,
      '--no-playlist',
      '--newline',
      '--progress',
      '--progress-template',
      'download:SF|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '--print', 'after_move:SFPATH|%(filepath)s',
      '--no-mtime',
      '--windows-filenames',
      '--concurrent-fragments', '4',
      '--retries', '10',
      '--fragment-retries', '10',
      '--no-check-formats',
    ];
    if (this.speedLimitKB > 0) args.push('--limit-rate', Math.round(this.speedLimitKB) + 'K');
    args.push(this.url);

    this.emit('log', 'yt-dlp ' + args.join(' '));
    this.proc = spawn(this.ytdlp.exe, args, { windowsHide: true, cwd: this.dir });

    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        this._line(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      for (const l of String(d).split('\n')) {
        const t = l.trim();
        if (!t) continue;
        if (/^ERROR/i.test(t)) this.lastError = t;
        this.emit('log', t);
      }
    });

    this.proc.on('error', (e) => this._finish(1, e.message));
    this.proc.on('close', (code) => this._finish(code));
  }

  _line(line) {
    if (line.startsWith('SF|')) {
      const [, status, dl, total, est, speed, eta] = line.split('|');
      const num = (v) => (v && v !== 'NA' ? Number(v) : null);
      const d = num(dl) || 0;
      if (d < this.downloaded - 1024 * 1024) { this.stream += 1; this._tick = null; } // a new stream started (video -> audio)
      this.downloaded = d;
      this.size = num(total) ?? num(est);
      // yt-dlp reports NA for speed on fragmented (HLS/DASH) downloads, so keep our own estimate.
      const now = Date.now();
      if (this._tick && now - this._tick.t >= 400) {
        const inst = ((d - this._tick.bytes) / (now - this._tick.t)) * 1000;
        this._ownSpeed = this._ownSpeed ? this._ownSpeed * 0.7 + inst * 0.3 : inst;
        this._tick = { t: now, bytes: d };
      } else if (!this._tick) {
        this._tick = { t: now, bytes: d };
      }
      this.speed = num(speed) ?? this._ownSpeed ?? 0;
      this.eta = num(eta) ?? (this.size && this.speed > 1 ? (this.size - d) / this.speed : null);
      this.stage = status === 'finished' ? 'processing' : 'downloading';
      this.emit('progress', this._snapshot());
    } else if (line.startsWith('SFPATH|')) {
      this.finalPath = line.slice('SFPATH|'.length).trim();
    } else if (line) {
      if (/\[(Merger|ExtractAudio|FixupM3u8|VideoConvertor)\]/.test(line)) {
        this.stage = 'processing';
        this.emit('progress', this._snapshot());
      }
      this.emit('log', line);
    }
  }

  _snapshot() {
    return {
      downloaded: this.downloaded,
      size: this.size,
      speed: this.speed,
      eta: this.eta,
      stage: this.stage,
      stream: this.stream,
      segments: [],
    };
  }

  async _finish(code, msg) {
    if (this._done) return;
    this._done = true;
    this.proc = null;
    if (this.stopped) {
      if (this.cancelled) await this.cleanup();
      this.emit('paused');
      return;
    }
    if (code === 0 && this.finalPath) {
      let size = null;
      try { size = (await fsp.stat(this.finalPath)).size; } catch { /* keep null */ }
      this.downloaded = size ?? this.downloaded;
      this.size = size ?? this.size;
      this.stage = 'done';
      this.emit('complete', { filePath: this.finalPath, size: this.size });
    } else {
      const reason = cleanError(this.lastError) || msg || ('yt-dlp exited with code ' + code);
      this.emit('error', new Error(reason));
    }
  }

  pause() {
    if (!this.proc || this.stopped) return;
    this.stopped = true;
    killTree(this.proc.pid);
  }

  async cancel() {
    this.cancelled = true;
    if (this.proc) {
      this.stopped = true;
      killTree(this.proc.pid);
    } else {
      await this.cleanup();
    }
  }

  /** Remove partial files left by yt-dlp for this video id. */
  async cleanup() {
    await VideoDownload.cleanupDir(this.dir, this.videoId);
  }

  static async cleanupDir(dir, videoId) {
    if (!videoId) return;
    const tag = '[' + videoId + ']';
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { return; }
    for (const name of entries) {
      if (!name.includes(tag)) continue;
      if (/\.(part|ytdl|part-Frag\d+)$/i.test(name) || /\.f\d+\.\w+$/i.test(name) || /\.temp\.\w+$/i.test(name)) {
        await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
      }
    }
  }
}

module.exports = { YtDlp, VideoDownload, QUALITIES, sanitizeFilename };
