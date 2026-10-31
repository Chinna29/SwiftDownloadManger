import React, { useState } from 'react';
import SegmentBar from './SegmentBar.jsx';
import { bytes, speed, eta, percent, when, STATUS_LABEL } from '../format.js';

const ICONS = {
  pause: '⏸',
  play: '▶',
  retry: '↻',
  folder: '📁',
  open: '↗',
  remove: '✕',
};

export default function JobRow({ job, selected, onSelect }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sf = window.sf;
  const pct = percent(job);
  const canPause = job.status === 'downloading' || job.status === 'queued';
  const canResume = job.status === 'paused' || job.status === 'failed' || job.status === 'cancelled';

  const remove = (deleteFile) => {
    sf.jobs.remove(job.id, deleteFile);
    setConfirmDelete(false);
  };

  return (
    <div className={'job ' + job.status + (selected ? ' selected' : '')} onClick={() => onSelect(job.id)}>
      <div className="job-main">
        <div className="job-title">
          <span className="job-name" title={job.filePath || job.url}>{job.filename || job.url}</span>
          <span className={'pill ' + job.status}>{STATUS_LABEL[job.status] || job.status}</span>
          {job.kind === 'video' && <span className="pill video">video{job.quality && job.quality !== 'best' ? ' · ' + (job.quality === 'audio' ? 'audio' : job.quality + 'p') : ''}</span>}
          {job.source === 'browser' && <span className="pill src">{job.imported ? 'moved from browser' : 'browser'}</span>}
        </div>
        <SegmentBar job={job} />
        <div className="job-meta">
          <span>{bytes(job.downloaded)}{job.size ? ' / ' + bytes(job.size) : ''}</span>
          <span>{job.size ? pct.toFixed(1) + '%' : ''}</span>
          {job.status === 'downloading' && <span>{speed(job.speed)}</span>}
          {job.status === 'downloading' && <span>ETA {eta(job.eta)}</span>}
          {job.status === 'downloading' && job.kind === 'video' && job.stage && <span className="dim">{job.stage}</span>}
          {job.status === 'completed' && <span>{when(job.completedAt)}</span>}
          {job.status === 'failed' && <span className="err" title={job.error}>{job.error}</span>}
          {job.status !== 'downloading' && job.status !== 'failed' && job.status !== 'completed' && job.kind !== 'video' && (
            <span className="dim">{job.resumable ? (job.segments?.length || job.segmentCount) + ' segments' : 'single stream'}</span>
          )}
          {job.kind === 'video' && job.video?.uploader && <span className="dim">{job.video.uploader}</span>}
        </div>
      </div>

      <div className="job-actions" onClick={(e) => e.stopPropagation()}>
        {canPause && <button title="Pause" onClick={() => sf.jobs.pause(job.id)}>{ICONS.pause}</button>}
        {canResume && (
          <button title={job.status === 'failed' ? 'Retry' : 'Resume'} onClick={() => sf.jobs.resume(job.id)}>
            {job.status === 'failed' ? ICONS.retry : ICONS.play}
          </button>
        )}
        {job.status === 'completed' && <button title="Open file" onClick={() => sf.jobs.openFile(job.id)}>{ICONS.open}</button>}
        {job.filePath && <button title="Show in folder" onClick={() => sf.jobs.showInFolder(job.id)}>{ICONS.folder}</button>}
        {!confirmDelete && <button title="Remove" className="danger" onClick={() => setConfirmDelete(true)}>{ICONS.remove}</button>}
        {confirmDelete && (
          <span className="confirm">
            <button onClick={() => remove(false)}>Remove</button>
            {job.status === 'completed' && <button className="danger" onClick={() => remove(true)}>Delete file</button>}
            <button onClick={() => setConfirmDelete(false)}>Cancel</button>
          </span>
        )}
      </div>

      {selected && (
        <div className="job-details" onClick={(e) => e.stopPropagation()}>
          <div><label>URL</label><span className="mono" title={job.url}>{job.url}</span></div>
          {job.finalUrl && job.finalUrl !== job.url && <div><label>Final URL</label><span className="mono">{job.finalUrl}</span></div>}
          <div><label>Saved to</label><span className="mono">{job.filePath || job.dir}</span></div>
          <div><label>Type</label><span>{job.contentType || '—'}</span></div>
          {job.kind === 'video' && <div><label>Source</label><span>{job.video?.extractor || 'yt-dlp'}{job.video?.id ? ' · ' + job.video.id : ''}</span></div>}
          <div><label>Resumable</label><span>{job.resumable ? 'Yes' : 'No'}</span></div>
          <div><label>Added</label><span>{when(job.addedAt)}</span></div>
        </div>
      )}
    </div>
  );
}
