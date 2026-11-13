import React, { useEffect, useState } from 'react';
import { Destination } from './Menu.jsx';

/**
 * Batch download: a URL with a wildcard, e.g. https://host/pic*.jpg, expanded over a range of
 * numbers (001..120, zero padded) or letters (a..z).
 */
export default function BatchDialog({ settings, queues, initialUrl, onClose, onDone }) {
  const sf = window.sf;
  const [pattern, setPattern] = useState(initialUrl || '');
  const [kind, setKind] = useState('numbers');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(10);
  const [width, setWidth] = useState(1);
  const [urls, setUrls] = useState([]);
  const [error, setError] = useState('');
  const [dir, setDir] = useState(settings.downloadDir);
  const [queueId, setQueueId] = useState('main');
  const [startNow, setStartNow] = useState(settings.autoStart);
  const [suggestedFrom, setSuggestedFrom] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialUrl === undefined) sf.clipboardUrl().then((u) => { if (u) setPattern(u); });
  }, []);

  // When a plain URL lands in the field (clipboard, paste, typing), suggest the wildcard from
  // its last digit run, once per URL, after a short pause so typing is not interrupted.
  useEffect(() => {
    const p = pattern.trim();
    if (!/^(https?|ftp|ftps):\/\/\S+$/i.test(p) || p.includes('*') || p === suggestedFrom) return;
    const t = setTimeout(() => sf.links.suggest(p).then((s) => {
      setSuggestedFrom(p);
      if (!s || !s.pattern) return;
      setPattern(s.pattern); setKind(s.kind || 'numbers'); setFrom(s.from ?? 1); setTo(s.to ?? (s.from ?? 1) + 9); setWidth(s.width || 1);
    }), 700);
    return () => clearTimeout(t);
  }, [pattern]);

  useEffect(() => {
    const p = pattern.trim();
    if (!p.includes('*')) { setUrls([]); setError(p ? 'Put a * where the number or letter changes, e.g. https://site/file*.zip' : ''); return; }
    sf.links.expand(p, { kind, from, to, width: Number(width) }).then((r) => {
      if (r.ok) { setUrls(r.urls); setError(''); } else { setUrls([]); setError(r.error); }
    });
  }, [pattern, kind, from, to, width]);

  const submit = async (e) => {
    e.preventDefault();
    if (!urls.length) return;
    setBusy(true);
    await sf.jobs.addMany(urls.map((url) => ({ url })), { dir, queueId: startNow ? null : queueId, autoStart: startNow, source: 'batch', onDuplicate: 'numbered' });
    setBusy(false);
    onDone?.();
    onClose();
  };

  const preview = urls.slice(0, 4);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal wide" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Batch download</h2>
        <label className="field">
          <span>Address with a wildcard</span>
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="https://example.com/photos/img*.jpg" spellCheck={false} autoFocus />
        </label>
        <div className="row wrap gap">
          <label className="field inline">
            <span>Replace * with</span>
            <select value={kind} onChange={(e) => { setKind(e.target.value); if (e.target.value === 'letters') { setFrom('a'); setTo('z'); } else { setFrom(1); setTo(10); } }}>
              <option value="numbers">numbers</option>
              <option value="letters">letters</option>
            </select>
          </label>
          <label className="field inline"><span>from</span><input className="short" value={from} onChange={(e) => setFrom(kind === 'numbers' ? Number(e.target.value) : e.target.value)} /></label>
          <label className="field inline"><span>to</span><input className="short" value={to} onChange={(e) => setTo(kind === 'numbers' ? Number(e.target.value) : e.target.value)} /></label>
          {kind === 'numbers' && (
            <label className="field inline"><span>digits</span><input className="short" type="number" min="1" max="8" value={width} onChange={(e) => setWidth(e.target.value)} title="Zero-pad to this many digits (3 → 007)" /></label>
          )}
        </div>
        <div className="hint">
          {error && <span className="err">{error}</span>}
          {!error && urls.length > 0 && (
            <>
              <b>{urls.length} files</b>
              <div className="mono small" style={{ marginTop: 6 }}>
                {preview.map((u) => <div key={u}>{u}</div>)}
                {urls.length > 4 && <div className="dim">… and {urls.length - 4} more, up to {urls[urls.length - 1]}</div>}
              </div>
            </>
          )}
        </div>
        <Destination dir={dir} setDir={setDir} queues={queues} queueId={queueId} setQueueId={setQueueId} startNow={startNow} setStartNow={setStartNow} />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!urls.length || busy}>{busy ? 'Adding…' : startNow ? 'Download ' + urls.length + ' files' : 'Add ' + urls.length + ' to queue'}</button>
        </div>
      </form>
    </div>
  );
}
