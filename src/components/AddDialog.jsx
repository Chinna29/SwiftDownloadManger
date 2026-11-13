import React, { useEffect, useRef, useState } from 'react';
import { bytes, hostOf } from '../format.js';
import { Choice, Destination } from './Menu.jsx';

function duration(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
}

const HASH_NAMES = { md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512', crc32: 'CRC32' };
const HASH_BY_LEN = { 8: 'CRC32', 32: 'MD5', 40: 'SHA-1', 64: 'SHA-256', 128: 'SHA-512' };

/** Mirror the engine's parsing so the dialog can tell the user what will be verified. */
function detectChecksumAlgo(input) {
  const str = String(input || '').trim();
  const m = /^([a-z0-9-]+)\s*[:=]\s*(.+)$/i.exec(str);
  let algo = null;
  let hex = str;
  if (m) { algo = m[1].toLowerCase().replace('-', ''); hex = m[2]; }
  hex = hex.replace(/[\s:-]/g, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (algo) return HASH_NAMES[algo] && HASH_BY_LEN[hex.length] === HASH_NAMES[algo] ? HASH_NAMES[algo] : null;
  return HASH_BY_LEN[hex.length] || null;
}

const URL_RE = /^(https?|ftp|ftps|ftpes):\/\/\S+$/i;

export default function AddDialog({ settings, queues, initial, onClose, onDone, onTorrent }) {
  const sf = window.sf;
  const [url, setUrl] = useState(initial?.url || '');
  const [filename, setFilename] = useState(initial?.filename || '');
  const [dir, setDir] = useState(initial?.dir || settings.downloadDir);
  const [segments, setSegments] = useState(settings.segments);
  const [checksum, setChecksum] = useState('');
  const [description, setDescription] = useState('');
  const [startNow, setStartNow] = useState(initial?.later ? false : settings.autoStart);
  const [queueId, setQueueId] = useState('main');
  const [info, setInfo] = useState(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState('');
  const [dup, setDup] = useState(null);
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState('file'); // 'file' | 'video' | 'gallery'
  const [video, setVideo] = useState(null);
  const [videoProbing, setVideoProbing] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [quality, setQuality] = useState(settings.videoQuality || 'best');
  const [tools, setTools] = useState(null);
  const [install, setInstall] = useState(null);
  const [gallery, setGallery] = useState(null);

  const [target, setTarget] = useState(null);
  const urlRef = useRef(null);
  const probeSeq = useRef(0);

  const isFtp = /^ftps?:\/\//i.test(url.trim()) || /^ftpes:\/\//i.test(url.trim());
  const isMagnet = /^magnet:/i.test(url.trim());

  useEffect(() => {
    const kind = mode === 'video' && video ? 'video' : 'file';
    const name = kind === 'video' ? (video?.title || '') : (filename || info?.filename || '');
    if (!dir || (!name && !info)) { setTarget(null); return; }
    let alive = true;
    sf.jobs.targetDir({ dir, filename: name, contentType: info?.contentType, kind, quality }).then((t) => { if (alive) setTarget(t); });
    return () => { alive = false; };
  }, [dir, filename, info, mode, video, quality]);

  useEffect(() => {
    if (!initial?.url) sf.clipboardUrl().then((u) => { if (u && !/^magnet:/i.test(u)) setUrl(u); });
    sf.tools.status().then(setTools);
    urlRef.current?.focus();
    if (initial?.url) urlRef.current?.select();
    return sf.video.onInstall((p) => {
      setInstall(p.phase === 'done' || p.phase === 'error' ? null : p);
      if (p.phase === 'done') sf.tools.status().then(setTools);
      if (p.phase === 'error') setVideoError(p.error);
    });
  }, []);

  useEffect(() => {
    setInfo(null); setError(''); setVideo(null); setVideoError(''); setMode('file'); setGallery(null);
    const u = url.trim();
    if (isMagnet) return;
    if (!URL_RE.test(u)) return;
    const seq = ++probeSeq.current;
    setProbing(true);
    const t = setTimeout(async () => {
      const r = await sf.jobs.probe(u);
      if (seq !== probeSeq.current) return;
      setProbing(false);
      if (r.ok) { setInfo(r.info); setFilename((f) => f || r.info.filename); }
      else setError(r.error);
      if (tools?.gallerydl && /^https?:/i.test(u)) sf.gallery.supports(u).then((g) => { if (seq === probeSeq.current && g) setGallery(g); });
    }, 400);
    return () => clearTimeout(t);
  }, [url]);

  const looksLikePage = info && /^text\/html/i.test(info.contentType || '');
  const ytdlpReady = !!tools?.ytdlp;
  const checksumAlgo = detectChecksumAlgo(checksum);
  const isDrive = /(^|\.)(drive|docs)\.google\.com$/i.test(hostOf(url.trim()));

  const analyze = async () => {
    setVideoError(''); setVideoProbing(true);
    const r = await sf.video.probe(url.trim());
    setVideoProbing(false);
    if (r.ok) { setVideo(r.info); setMode('video'); if (!r.info.qualities.some((q) => q.key === quality)) setQuality('best'); }
    else setVideoError(r.error);
  };
  const installYtdlp = async () => { setVideoError(''); const r = await sf.video.install('ytdlp'); if (r.ok) { setTools(await sf.tools.status()); analyze(); } };

  const buildOpts = () => {
    const common = { dir, autoStart: startNow, queueId: startNow ? null : queueId, description: description.trim() || undefined };
    if (mode === 'video' && video) return { ...common, kind: 'video', url: url.trim(), video, quality };
    if (mode === 'gallery') return { ...common, kind: 'gallery', url: url.trim() };
    return { ...common, url: url.trim(), filename: filename.trim() || undefined, segments, checksum: checksum.trim() || undefined };
  };

  const submit = async (e, onDuplicate) => {
    e?.preventDefault();
    if (!url.trim()) return;
    if (isMagnet) { onTorrent?.(url.trim()); onClose(); return; }
    setBusy(true);
    try {
      const r = await sf.jobs.add({ ...buildOpts(), onDuplicate });
      if (r && r.duplicate) { setDup(r); setBusy(false); return; }
      onDone?.(r);
      onClose();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  const onDupPick = (v) => {
    setDup(null);
    if (!v) return;
    if (v === 'open') { sf.jobs.openFile(dup.existingId); onClose(); return; }
    submit(null, v);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New download {initial?.fromClipboard && <span className="dim small">· from clipboard</span>}</h2>

        <label className="field">
          <span>URL</span>
          <input ref={urlRef} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://, ftp:// or a video page… (magnet links open the torrent dialog)" spellCheck={false} />
        </label>

        <div className="probe">
          {probing && <span className="dim">Checking…</span>}
          {error && <span className="err">{error}</span>}
          {isMagnet && <span className="ok">Magnet link — continues in the torrent dialog.</span>}
          {info && !looksLikePage && (
            <>
              <span>{info.size != null ? bytes(info.size) : 'Unknown size'}</span>
              <span className={info.resumable ? 'ok' : 'warn'}>{info.resumable ? (isFtp ? 'FTP · resumable' : 'Resumable · segmented') : 'Not resumable · single stream'}</span>
              {info.contentType && <span className="dim">{info.contentType}</span>}
            </>
          )}
          {info && looksLikePage && mode === 'file' && !isDrive && <span className="warn">This is a web page, not a file.</span>}
          {isDrive && mode === 'file' && <span className="ok">Google Drive link — the real file is fetched when the download starts.</span>}
        </div>

        {info && mode === 'file' && !isDrive && (
          <div className="video-cta">
            {ytdlpReady && (
              <button type="button" onClick={analyze} disabled={videoProbing}>
                {videoProbing ? 'Analyzing…' : looksLikePage ? '▶ Analyze as video (yt-dlp)' : '▶ Treat as video page instead'}
              </button>
            )}
            {gallery && <button type="button" onClick={() => setMode('gallery')}>🖼 Download whole gallery ({gallery.extractor || 'gallery-dl'})</button>}
            {!ytdlpReady && looksLikePage && !install && (
              <button type="button" onClick={installYtdlp}>⬇ Install yt-dlp (≈65 MB with its JS runtime) to download videos</button>
            )}
            {install && (
              <span className="dim">
                {install.phase === 'downloading' && install.size ? 'Downloading ' + install.kind + ' ' + Math.round((install.downloaded / install.size) * 100) + '%'
                  : install.phase === 'extracting' ? 'Extracting ' + install.kind + '…' : 'Installing ' + install.kind + '…'}
              </span>
            )}
            {videoError && <span className="err">{videoError}</span>}
          </div>
        )}

        {mode === 'gallery' && (
          <div className="hint">Every image and video of this page / album is fetched with gallery-dl into a folder named after the site and gallery. <button type="button" className="link" onClick={() => setMode('file')}>Download as a plain file instead</button></div>
        )}

        {mode === 'video' && video && (
          <div className="video-card">
            {video.thumbnail && <img src={video.thumbnail} alt="" />}
            <div className="video-info">
              <div className="video-title" title={video.title}>{video.title}</div>
              <div className="dim">{video.extractor}{video.uploader ? ' · ' + video.uploader : ''}{video.duration ? ' · ' + duration(video.duration) : ''}</div>
              <label className="field inline">
                <span>Quality</span>
                <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                  {video.qualities.map((q) => (
                    <option key={q.key} value={q.key}>{q.key === 'best' && q.height ? 'Best (' + q.height + 'p)' : q.label}{q.size ? ' · ≈ ' + bytes(q.size) : ''}</option>
                  ))}
                </select>
              </label>
              {!tools?.ffmpeg && quality !== 'audio' && (
                <div className="warn small">Without ffmpeg only pre-merged formats are available (on YouTube that is often just 360p). Install it in Settings to unlock the higher resolutions.</div>
              )}
              <button type="button" className="link" onClick={() => setMode('file')}>Download as a plain file instead</button>
            </div>
          </div>
        )}

        {mode === 'file' && !isMagnet && (
          <label className="field">
            <span>Save as</span>
            <input value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="Filename (auto)" spellCheck={false} />
          </label>
        )}

        {!isMagnet && <Destination dir={dir} setDir={setDir} queues={queues} queueId={queueId} setQueueId={setQueueId} startNow={startNow} setStartNow={setStartNow} target={target} />}

        {mode === 'file' && !isMagnet && !isFtp && (
          <label className="field inline">
            <span>Segments</span>
            <input type="range" min="1" max="32" value={segments} onChange={(e) => setSegments(Number(e.target.value))} />
            <b>{segments}</b>
          </label>
        )}

        {mode === 'file' && !isMagnet && (
          <div className="grid2">
            <label className="field">
              <span>Checksum <span className="dim small">(optional)</span></span>
              <input value={checksum} onChange={(e) => setChecksum(e.target.value)} placeholder="sha256:… / MD5 / SHA / CRC32" spellCheck={false} />
              {checksum.trim() && (checksumAlgo
                ? <span className="ok small">Verified as {checksumAlgo} when finished.</span>
                : <span className="warn small">Not a recognized hash — ignored.</span>)}
            </label>
            <label className="field">
              <span>Description <span className="dim small">(optional)</span></span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A note shown in the list" />
            </label>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!url.trim() || probing || videoProbing || busy || (mode === 'video' && !video)}>
            {isMagnet ? 'Open torrent…' : mode === 'video' ? (startNow ? 'Download video' : 'Queue video') : mode === 'gallery' ? 'Download gallery' : startNow ? 'Download' : 'Download later'}
          </button>
        </div>
      </form>
      {dup && (
        <Choice
          title="Already in the list"
          text={'This address is already in your downloads:\n' + (dup.existing.filename || dup.existing.url) + ' (' + dup.existing.status + ')\n\nWhat do you want to do?'}
          buttons={[
            dup.existing.status === 'completed' ? { label: 'Open existing file', value: 'open', primary: true } : { label: 'Resume existing', value: 'resume', primary: true },
            { label: 'Download again (new name)', value: 'numbered' },
            { label: 'Overwrite', value: 'overwrite', danger: true },
            { label: 'Cancel', value: null },
          ]}
          onPick={onDupPick}
        />
      )}
    </div>
  );
}
