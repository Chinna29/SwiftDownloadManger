import React, { useEffect, useState } from 'react';
import { bytes } from '../format.js';
import { Destination } from './Menu.jsx';

/** Magnet link or .torrent file → metadata lookup → pick files → download (and seed). */
export default function TorrentDialog({ settings, queues, initial, onClose, onDone }) {
  const sf = window.sf;
  const [magnet, setMagnet] = useState(initial?.magnet || '');
  const [file, setFile] = useState(initial?.torrentFile ? { path: initial.sourcePath, torrentFile: initial.torrentFile } : null);
  const [info, setInfo] = useState(initial?.infoHash ? initial : null);
  const [selected, setSelected] = useState(() => new Set((initial?.files || []).map((_, i) => i)));
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');
  const [sequential, setSequential] = useState(false);
  const [dir, setDir] = useState(settings.downloadDir ? settings.downloadDir + (settings.organize ? '\\Torrents' : '') : '');
  const [queueId, setQueueId] = useState('main');
  const [startNow, setStartNow] = useState(settings.autoStart);
  const [busy, setBusy] = useState(false);
  const share = settings.torrentShare || { seed: true, ratio: 1, minutes: 0 };

  useEffect(() => {
    if (!initial) sf.clipboardUrl().then((u) => { if (/^magnet:/i.test(u)) setMagnet(u); });
  }, []);

  const lookup = async (source) => {
    setError(''); setLooking(true); setInfo(null);
    const r = await sf.torrents.lookup(source, dir);
    setLooking(false);
    if (!r.ok) { setError(r.error); return; }
    setInfo(r.info);
    setSelected(new Set(r.info.files.map((_, i) => i)));
  };

  useEffect(() => {
    if (info) return;
    const m = magnet.trim();
    if (/^magnet:\?xt=urn:btih:/i.test(m)) lookup(m);
  }, [magnet]);

  const chooseFile = async () => {
    const f = await sf.torrents.chooseFile();
    if (!f) return;
    setFile(f); setMagnet('');
    lookup({ torrentFile: f.torrentFile });
  };

  const toggle = (i) => setSelected((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const files = info?.files || [];
  const total = files.reduce((a, f, i) => a + (selected.has(i) ? f.length : 0), 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!info) return;
    setBusy(true);
    const source = magnet.trim() || info.magnetURI;
    await sf.jobs.add({
      kind: 'torrent', url: source, dir, filename: info.name, autoStart: startNow, queueId: startNow ? null : queueId, source: 'app', onDuplicate: 'numbered',
      torrent: { torrentFile: file?.torrentFile || info.torrentFile || null, infoHash: info.infoHash, name: info.name, files, selected: [...selected], sequential, share },
    });
    setBusy(false);
    onDone?.();
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal wide" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Add torrent</h2>
        <label className="field">
          <span>Magnet link</span>
          <div className="row">
            <input value={magnet} onChange={(e) => { setMagnet(e.target.value); setInfo(null); setFile(null); }} placeholder="magnet:?xt=urn:btih:…" spellCheck={false} autoFocus />
            <button type="button" onClick={chooseFile}>.torrent file…</button>
          </div>
          {file?.path && <span className="dim small mono">{file.path}</span>}
        </label>
        {looking && <div className="dim">Fetching metadata from peers… this can take up to a minute for a magnet link.</div>}
        {error && <div className="err">{error}</div>}
        {info && (
          <div className="torrent-box">
            <div className="row" style={{ alignItems: 'baseline' }}>
              <b className="ellipsis" title={info.name}>{info.name}</b>
              <span className="dim small">{files.length} file{files.length !== 1 ? 's' : ''} · {bytes(info.length)}</span>
              <span className="spacer" />
              <button type="button" className="link" onClick={() => setSelected(new Set(files.map((_, i) => i)))}>all</button>
              <button type="button" className="link" onClick={() => setSelected(new Set())}>none</button>
            </div>
            <div className="file-list">
              {files.map((f, i) => (
                <label key={i} className="pkg-row">
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} />
                  <span className="name mono" title={f.path}>{f.path}</span>
                  <span className="dim">{bytes(f.length)}</span>
                </label>
              ))}
            </div>
            <div className="row wrap gap small">
              <span>{selected.size} selected · {bytes(total)}</span>
              <label className="check small"><input type="checkbox" checked={sequential} onChange={(e) => setSequential(e.target.checked)} /> sequential (play while downloading)</label>
              <span className="dim">{share.seed ? 'seeds until ratio ' + share.ratio + (share.minutes ? ' or ' + share.minutes + ' min' : '') : 'no seeding'} · change in Settings → Connection</span>
            </div>
          </div>
        )}
        <Destination dir={dir} setDir={setDir} queues={queues} queueId={queueId} setQueueId={setQueueId} startNow={startNow} setStartNow={setStartNow} />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!info || !selected.size || busy}>{busy ? 'Adding…' : startNow ? 'Download' : 'Add to queue'}</button>
        </div>
      </form>
    </div>
  );
}
