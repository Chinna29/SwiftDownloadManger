import React, { useEffect, useRef, useState } from 'react';
import { bytes } from '../format.js';

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
  const urlRef = useRef(null);
  const probeSeq = useRef(0);

  useEffect(() => {
    sf.clipboardUrl().then((u) => { if (u) setUrl(u); });
    urlRef.current?.focus();
  }, []);

  useEffect(() => {
    setInfo(null);
    setError('');
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

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    await sf.jobs.add({ url: url.trim(), filename: filename.trim() || undefined, dir, segments, autoStart: startNow });
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
          <input ref={urlRef} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/file.zip" spellCheck={false} />
        </label>

        <div className="probe">
          {probing && <span className="dim">Checking…</span>}
          {error && <span className="err">{error}</span>}
          {info && (
            <>
              <span>{info.size != null ? bytes(info.size) : 'Unknown size'}</span>
              <span className={info.resumable ? 'ok' : 'warn'}>{info.resumable ? 'Resumable · segmented' : 'Not resumable · single stream'}</span>
              {info.contentType && <span className="dim">{info.contentType}</span>}
            </>
          )}
        </div>

        <label className="field">
          <span>Save as</span>
          <input value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="Filename (auto)" spellCheck={false} />
        </label>

        <label className="field">
          <span>Folder</span>
          <div className="row">
            <input value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
            <button type="button" onClick={browse}>Browse…</button>
          </div>
        </label>

        <label className="field inline">
          <span>Segments</span>
          <input type="range" min="1" max="32" value={segments} onChange={(e) => setSegments(Number(e.target.value))} />
          <b>{segments}</b>
        </label>

        <label className="check">
          <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
          Start immediately
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!url.trim() || probing}>Add download</button>
        </div>
      </form>
    </div>
  );
}
