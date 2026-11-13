import React, { useState } from 'react';
import SegmentBar from './SegmentBar.jsx';
import { bytes, speed, eta, percent, when, STATUS_LABEL, kindLabel } from '../format.js';

const ICONS = { pause: '⏸', play: '▶', retry: '↻', folder: '📁', open: '↗', remove: '✕', info: 'ⓘ' };

/** Pill shown for a job that carried an expected hash. Null once nothing to show. */
function checksumBadge(cs) {
  if (!cs || cs.state === 'pending') return null;
  const algo = (cs.algo || '').toUpperCase();
  switch (cs.state) {
    case 'verifying': return { cls: 'verifying', text: 'verifying…', title: 'Checking the ' + algo + ' hash of the finished file' };
    case 'verified': return { cls: 'verified', text: '✓ ' + algo, title: algo + ' verified · ' + cs.actual };
    case 'mismatch': return { cls: 'mismatch', text: '⚠ ' + algo + ' mismatch', title: 'Expected ' + cs.expected + '\nGot      ' + (cs.actual || '—') };
    default: return { cls: 'unverified', text: algo + ' not verified', title: cs.error || 'Could not read the file to verify it' };
  }
}

export function isSeeding(job) {
  return job.kind === 'torrent' && job.status === 'downloading' && job.stage === 'seeding';
}

export default function JobRow({ job, selected, queue, onSelect, onContextMenu, onProperties, confirmDelete: askFirst = true }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sf = window.sf;
  const pct = percent(job);
  const canPause = job.status === 'downloading' || job.status === 'queued' || job.status === 'waiting';
  const canResume = job.status === 'paused' || job.status === 'failed' || job.status === 'cancelled';
  const csBadge = checksumBadge(job.checksum);
  const kind = kindLabel(job);
  const seeding = isSeeding(job);

  const remove = (deleteFile) => { sf.jobs.remove(job.id, deleteFile); setConfirmDelete(false); };
  const onRemoveClick = () => { if (askFirst || job.status === 'completed') setConfirmDelete(true); else remove(false); };

  return (
    <div className={'job ' + job.status + (selected ? ' selected' : '')} onClick={(e) => onSelect(job.id, e)} onContextMenu={(e) => { e.preventDefault(); onContextMenu?.(e, job); }} onDoubleClick={() => job.status === 'completed' ? sf.jobs.openFile(job.id) : onProperties?.(job)}>
      <div className="job-main">
        <div className="job-title">
          <span className="job-name" title={job.filePath || job.url}>{job.filename || job.url}</span>
          <span className={'pill ' + (seeding ? 'completed' : job.status)}>{seeding ? 'Seeding' : STATUS_LABEL[job.status] || job.status}</span>
          {kind && <span className={'pill ' + job.kind}>{kind}</span>}
          {queue && <span className="pill queue" title={queue.running ? 'Queue is running' : 'Queue is stopped'}>{queue.name}</span>}
          {job.source === 'browser' && <span className="pill src">{job.imported ? 'moved from browser' : 'browser'}</span>}
          {job.debrid && <span className="pill src">{job.debrid}</span>}
          {csBadge && <span className={'pill ' + csBadge.cls} title={csBadge.title}>{csBadge.text}</span>}
          {job.extracted?.status === 'done' && <span className="pill verified" title={'Extracted to ' + job.extracted.target}>extracted</span>}
          {job.extracted?.status === 'running' && <span className="pill verifying">extracting…</span>}
        </div>
        <SegmentBar job={job} />
        <div className="job-meta">
          <span>{bytes(job.downloaded)}{job.size ? ' / ' + bytes(job.size) : ''}</span>
          <span>{job.size ? pct.toFixed(1) + '%' : ''}</span>
          {job.status === 'downloading' && !seeding && <span>{speed(job.speed)}</span>}
          {job.status === 'downloading' && !seeding && <span>ETA {eta(job.eta)}</span>}
          {job.status === 'downloading' && job.stage && job.kind !== 'torrent' && <span className="dim">{job.stage}</span>}
          {job.kind === 'torrent' && job.extra?.peers != null && job.status === 'downloading' && <span className="dim">{job.extra.peers} peers · ↑ {speed(job.extra.uploadSpeed)} · ratio {Number(job.extra.ratio || 0).toFixed(2)}</span>}
          {job.status === 'waiting' && <span className="warn">{job.waitReason}</span>}
          {job.status === 'queued' && queue && !queue.running && <span className="dim">waits for the queue to start</span>}
          {job.status === 'completed' && <span>{when(job.completedAt)}</span>}
          {job.status === 'failed' && <span className="err" title={job.error}>{job.error}</span>}
          {job.status === 'queued' && job.error && job.retries > 0 && <span className="warn" title={job.error}>{job.error}</span>}
          {!['downloading', 'failed', 'completed', 'waiting'].includes(job.status) && job.kind === 'file' && (
            <span className="dim">{job.resumable ? (job.segments?.length || job.segmentCount) + ' segments' : 'single stream'}</span>
          )}
          {job.kind === 'video' && job.video?.uploader && <span className="dim">{job.video.uploader}</span>}
          {job.description && <span className="dim ellipsis" title={job.description}>“{job.description}”</span>}
        </div>
      </div>

      <div className="job-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        {seeding && <button title="Stop seeding" onClick={() => sf.jobs.stopSeeding(job.id)}>⏏</button>}
        {canPause && !seeding && <button title="Pause" onClick={() => sf.jobs.pause(job.id)}>{ICONS.pause}</button>}
        {canResume && (
          <button title={job.status === 'failed' ? 'Retry' : 'Resume'} onClick={() => sf.jobs.resume(job.id)}>
            {job.status === 'failed' ? ICONS.retry : ICONS.play}
          </button>
        )}
        {job.status === 'completed' && <button title="Open file" onClick={() => sf.jobs.openFile(job.id)}>{ICONS.open}</button>}
        {job.filePath && <button title="Show in folder" onClick={() => sf.jobs.showInFolder(job.id)}>{ICONS.folder}</button>}
        <button title="Properties" onClick={() => onProperties?.(job)}>{ICONS.info}</button>
        {!confirmDelete && <button title="Remove" className="danger" onClick={onRemoveClick}>{ICONS.remove}</button>}
        {confirmDelete && (
          <span className="confirm">
            <button onClick={() => remove(false)}>Remove</button>
            {job.status === 'completed' && <button className="danger" onClick={() => remove(true)}>Delete file</button>}
            <button onClick={() => setConfirmDelete(false)}>Cancel</button>
          </span>
        )}
      </div>
    </div>
  );
}
