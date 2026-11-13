import React, { useEffect, useState } from 'react';
import { bytes, when, hostOf, STATUS_LABEL } from '../format.js';

const ARCHIVE_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|zipx|cab|iso)$/i;

/** Download file info: description, address, location, checksum, archive, torrent details. */
export default function PropertiesDialog({ job: initial, jobs, queues, settings, onClose }) {
  const sf = window.sf;
  const job = jobs.find((j) => j.id === initial.id) || initial;
  const [desc, setDesc] = useState(job.description || '');
  const [url, setUrl] = useState(job.url);
  const [savePath, setSavePath] = useState(job.filePath || (job.dir + '\\' + (job.filename || '')));
  const [checksum, setChecksum] = useState(job.checksum?.expected ? (job.checksum.algo ? job.checksum.algo + ':' : '') + job.checksum.expected : '');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => { setSavePath(job.filePath || (job.dir + '\\' + (job.filename || ''))); }, [job.filePath, job.filename, job.dir]);

  const done = job.status === 'completed';
  const active = job.status === 'downloading' || job.status === 'probing';
  const queue = queues.find((q) => q.id === job.queueId);
  const isArchive = ARCHIVE_RE.test(job.filename || '');
  const say = (t) => { setMsg(t); setTimeout(() => setMsg(''), 4000); };

  const saveDesc = async () => { await sf.jobs.setDescription(job.id, desc); say('Description saved.'); };
  const applyUrl = async () => {
    if (url.trim() === job.url) return;
    setBusy('url');
    try { await sf.jobs.changeUrl(job.id, url.trim()); say('Address updated' + (job.status === 'failed' || job.status === 'paused' ? '; resume to continue from the new address.' : '.')); }
    catch (e) { say(e.message); }
    setBusy('');
  };
  const move = async () => {
    if (!done || savePath === job.filePath) return;
    setBusy('move');
    try { await sf.jobs.moveFile(job.id, savePath); say('File moved.'); } catch (e) { say(e.message); }
    setBusy('');
  };
  const browseSave = async () => { const p = await sf.saveAs(savePath); if (p) setSavePath(p); };
  const verify = async () => {
    setBusy('sum');
    try {
      if (checksum.trim()) await sf.jobs.setChecksum(job.id, checksum.trim());
      if (done) { const r = await sf.jobs.verifyChecksum(job.id); say(r?.state === 'verified' ? 'Checksum verified ✓' : r?.state === 'mismatch' ? 'Checksum does NOT match ⚠' : 'Saved; the file will be checked when it finishes.'); }
      else say('Saved; the file will be checked when it finishes.');
    } catch (e) { say(e.message); }
    setBusy('');
  };
  const extract = async () => {
    setBusy('x');
    const r = await sf.jobs.extract(job.id, password || undefined);
    say(r.ok ? 'Extracted ' + (r.result?.count ?? '') + ' files to ' + r.result?.target : r.error);
    setBusy('');
  };
  const redownload = async () => { await sf.jobs.redownload(job.id); say('Downloading again from the start.'); };
  const exportOne = async (fmt) => { const p = await sf.jobs.export([job.id], fmt); if (p) say('Exported to ' + p); };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide props" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="ellipsis" title={job.filename || job.url}>{job.filename || job.url}</h2>
        <div className="props-grid">
          <label>Status</label><span>{STATUS_LABEL[job.status] || job.status}{job.waitReason ? ' · ' + job.waitReason : ''}{job.error && job.status === 'failed' ? ' · ' + job.error : ''}</span>
          <label>Size</label><span>{job.size ? bytes(job.size) : 'unknown'}{job.downloaded && !done ? ' · ' + bytes(job.downloaded) + ' so far' : ''}</span>
          <label>Type</label><span>{job.contentType || job.kind || '—'}{job.category ? ' · ' + job.category : ''}</span>
          <label>Server</label><span>{hostOf(job.finalUrl || job.url) || '—'}{job.resumable ? ' · resumable' : ' · not resumable'}{job.debrid ? ' · via ' + job.debrid : ''}{job.extra?.gdrive ? ' · ' + job.extra.gdrive : ''}</span>
          <label>Queue</label><span>{queue ? queue.name + (queue.running ? ' (running)' : ' (stopped)') : 'none — starts right away'}</span>
          <label>Added</label><span>{when(job.addedAt)}{job.completedAt ? ' · finished ' + when(job.completedAt) : ''}{job.lastTryAt && !done ? ' · last try ' + when(job.lastTryAt) : ''}</span>
          {job.headers?.Referer && <><label>Referer</label><span className="mono ellipsis" title={job.headers.Referer}>{job.headers.Referer}</span></>}
          {job.source && <><label>Source</label><span>{job.source}</span></>}
        </div>

        <label className="field">
          <span>Description</span>
          <div className="row"><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Notes about this download" /><button type="button" onClick={saveDesc} disabled={desc === (job.description || '')}>Save</button></div>
        </label>

        <label className="field">
          <span>Address {job.finalUrl && job.finalUrl !== job.url && <i className="dim">· redirected to {hostOf(job.finalUrl)}</i>}</span>
          <div className="row"><input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} disabled={active} /><button type="button" onClick={applyUrl} disabled={active || url.trim() === job.url || busy === 'url'}>Refresh address</button></div>
          <span className="dim small">Use this when a link expired: paste the fresh link to the same file and the download continues where it stopped.</span>
        </label>

        <label className="field">
          <span>Save as</span>
          <div className="row">
            <input value={savePath} onChange={(e) => setSavePath(e.target.value)} spellCheck={false} disabled={!done} />
            <button type="button" onClick={browseSave} disabled={!done}>Browse…</button>
            <button type="button" onClick={move} disabled={!done || savePath === job.filePath || busy === 'move'}>Move / rename</button>
          </div>
        </label>

        {job.kind !== 'torrent' && (
          <label className="field">
            <span>Checksum {job.checksum?.state && <i className={'dim ' + (job.checksum.state === 'verified' ? 'ok' : job.checksum.state === 'mismatch' ? 'err' : '')}>· {job.checksum.state}{job.checksum.actual ? ' · ' + job.checksum.actual : ''}</i>}</span>
            <div className="row"><input value={checksum} onChange={(e) => setChecksum(e.target.value)} placeholder="MD5, SHA-1, SHA-256, SHA-512 or CRC32 hex" spellCheck={false} /><button type="button" onClick={verify} disabled={busy === 'sum' || (!checksum.trim() && !job.checksum?.expected)}>{done ? 'Verify' : 'Save'}</button></div>
          </label>
        )}

        {isArchive && (
          <label className="field">
            <span>Archive {job.extracted?.status === 'done' && <i className="dim ok">· extracted {job.extracted.count ?? ''} files to {job.extracted.target}</i>}{job.extracted?.status === 'failed' && <i className="dim err">· {job.extracted.error}</i>}</span>
            <div className="row"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (if any)" /><button type="button" onClick={extract} disabled={!done || busy === 'x'}>{busy === 'x' ? 'Extracting…' : 'Extract'}</button></div>
          </label>
        )}

        {job.kind === 'torrent' && job.torrent && (
          <div className="field">
            <span>Torrent</span>
            <div className="dim small mono ellipsis">{job.torrent.infoHash}</div>
            <div className="small">{job.extra?.peers != null ? job.extra.peers + ' peers · ' : ''}{job.extra?.ratio != null ? 'ratio ' + Number(job.extra.ratio).toFixed(2) + ' · ' : ''}{job.extra?.uploadSpeed ? '↑ ' + bytes(job.extra.uploadSpeed) + '/s' : ''}</div>
            {(job.torrent.files || []).length > 0 && (
              <div className="file-list small">
                {job.torrent.files.map((f, i) => <div key={i} className={'pkg-row' + (job.torrent.selected && !job.torrent.selected.includes(i) ? ' off' : '')}><span className="name mono">{f.path}</span><span className="dim">{bytes(f.length)}</span></div>)}
              </div>
            )}
            {job.status === 'downloading' && job.stage === 'seeding' && <button type="button" onClick={() => sf.jobs.stopSeeding(job.id)}>Stop seeding</button>}
          </div>
        )}

        <div className="modal-actions">
          <span className="dim small">{msg}</span><span className="spacer" />
          <button type="button" onClick={() => exportOne('ef2')} title="IDM-compatible export">Export .ef2</button>
          <button type="button" onClick={redownload} disabled={active}>Redownload</button>
          {job.filePath && <button type="button" onClick={() => sf.jobs.showInFolder(job.id)}>Show in folder</button>}
          <button type="button" className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
