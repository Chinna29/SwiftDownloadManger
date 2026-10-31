import React, { useEffect, useRef, useState } from 'react';
import { bytes } from '../format.js';

function duration(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
}

export default function AddDialog({ settings, onClose }) {
  const sf = window.sf;
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [dir, setDir] = useState(settings.downloadDir);
  const [segments, setSegments] = useState(settings.segments);
  const [startNow, setStartNow] = useState(settings.autoStart);
  const [info, setInfo] = useState(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState('');

  const [mode, setMode] = useState('file'); // 'file' | 'video'
  const [video, setVideo] = useState(null);
  const [videoProbing, setVideoProbing] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [quality, setQuality] = useState(settings.videoQuality || 'best');
  const [tools, setTools] = useState(null);
  const [install, setInstall] = useState(null);

  const urlRef = useRef(null);
  const probeSeq = useRef(0);

  useEffect(() => {
    sf.clipboardUrl().then((u) => { if (u) setUrl(u); });
    sf.video.status().then(setTools);
    urlRef.current?.focus();
    return sf.video.onInstall((p) => {
      setInstall(p.phase === 'done' || p.phase === 'error' ? null : p);
      if (p.phase === 'done') sf.video.status().then(setTools);
      if (p.phase === 'error') setVideoError(p.error);
    });
  }, []);

  useEffect(() => {
    setInfo(null);
    setError('');
    setVideo(null);
    setVideoError('');
    setMode('file');
    if (!/^https?:\/\/\S+$/i.test(url.trim())) return;
    const seq = ++probeSeq.current;
    setProbing(true);
    const t = setTimeout(async () => {
      const r = await sf.jobs.probe(url.trim());
      if (seq !== probeSeq.current) return;
      setProbing(false);
      if (r.ok) {
        setInfo(r.info);
        setFilename((f) => f || r.info.filename);
      } else {
        setError(r.error);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [url]);

  const looksLikePage = info && /^text\/html/i.test(info.contentType || '');
  const ytdlpReady = !!tools?.ytdlp;

  const analyze = async () => {
    setVideoError('');
    setVideoProbing(true);
    const r = await sf.video.probe(url.trim());
    setVideoProbing(false);
    if (r.ok) {
      setVideo(r.info);
      setMode('video');
      if (!r.info.qualities.some((q) => q.key === quality)) setQuality('best');
    } else {
      setVideoError(r.error);
    }
  };

  const installYtdlp = async () => {
    setVideoError('');
    const r = await sf.video.install('ytdlp');
    if (r.ok) {
      setTools(r.status);
      analyze();
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    if (mode === 'video' && video) {
      await sf.jobs.add({ kind: 'video', url: url.trim(), dir, video, quality, autoStart: startNow });
    } else {
      await sf.jobs.add({ url: url.trim(), filename: filename.trim() || undefined, dir, segments, autoStart: startNow });
    }
    onClose();
  };

  const browse = async () => {
    const d = await sf.chooseDir(dir);
    if (d) setDir(d);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New download</h2>

        <label className="field">
          <span>URL</span>
          <input ref={urlRef} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/file.zip or a video page" spellCheck={false} />
        </label>

        <div className="probe">
          {probing && <span className="dim">Checking…</span>}
          {error && <span className="err">{error}</span>}
          {info && !looksLikePage && (
            <>
              <span>{info.size != null ? bytes(info.size) : 'Unknown size'}</span>
              <span className={info.resumable ? 'ok' : 'warn'}>{info.resumable ? 'Resumable · segmented' : 'Not resumable · single stream'}</span>
              {info.contentType && <span className="dim">{info.contentType}</span>}
            </>
          )}
          {info && looksLikePage && mode === 'file' && <span className="warn">This is a web page, not a file.</span>}
        </div>

        {info && mode === 'file' && (
          <div className="video-cta">
            {ytdlpReady && (
              <button type="button" onClick={analyze} disabled={videoProbing}>
                {videoProbing ? 'Analyzing…' : looksLikePage ? '▶ Analyze as video (yt-dlp)' : '▶ Treat as video page instead'}
              </button>
            )}
            {!ytdlpReady && looksLikePage && !install && (
              <button type="button" onClick={installYtdlp}>⬇ Install yt-dlp (≈65 MB with its JS runtime) to download videos</button>
            )}
            {install && (
              <span className="dim">
                {install.phase === 'downloading' && install.size
                  ? 'Downloading ' + install.kind + ' ' + Math.round((install.downloaded / install.size) * 100) + '%'
                  : install.phase === 'extracting' ? 'Extracting ' + install.kind + '…' : 'Installing ' + install.kind + '…'}
              </span>
            )}
            {videoError && <span className="err">{videoError}</span>}
          </div>
        )}

        {mode === 'video' && video && (
          <div className="video-card">
            {video.thumbnail && <img src={video.thumbnail} alt="" />}
            <div className="video-info">
              <div className="video-title" title={video.title}>{video.title}</div>
              <div className="dim">
                {video.extractor}{video.uploader ? ' · ' + video.uploader : ''}{video.duration ? ' · ' + duration(video.duration) : ''}
              </div>
              <label className="field inline">
                <span>Quality</span>
                <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                  {video.qualities.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}
                </select>
              </label>
              {!tools?.ffmpeg && quality !== 'audio' && (
                <div className="warn small">Without ffmpeg only pre-merged formats are available (usually up to 720p). Install it in Settings for higher quality.</div>
              )}
              <button type="button" className="link" onClick={() => setMode('file')}>Download as a plain file instead</button>
            </div>
          </div>
        )}

        {mode === 'file' && (
          <label className="field">
            <span>Save as</span>
            <input value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="Filename (auto)" spellCheck={false} />
          </label>
        )}

        <label className="field">
          <span>Folder</span>
          <div className="row">
            <input value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
            <button type="button" onClick={browse}>Browse…</button>
          </div>
        </label>

        {mode === 'file' && (
          <label className="field inline">
            <span>Segments</span>
            <input type="range" min="1" max="32" value={segments} onChange={(e) => setSegments(Number(e.target.value))} />
            <b>{segments}</b>
          </label>
        )}

        <label className="check">
          <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
          Start immediately
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!url.trim() || probing || videoProbing || (mode === 'video' && !video)}>
            {mode === 'video' ? 'Download video' : 'Add download'}
          </button>
        </div>
      </form>
    </div>
  );
}
