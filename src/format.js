export function bytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i];
}

export function speed(bps) {
  if (!bps || bps < 1) return '—';
  return bytes(bps) + '/s';
}

export function eta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd';
}

export function percent(job) {
  if (!job.size) return job.status === 'completed' ? 100 : 0;
  return Math.min(100, (job.downloaded / job.size) * 100);
}

export function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export const STATUS_LABEL = {
  probing: 'Checking',
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  cancelling: 'Cancelling',
};

STATUS_LABEL.waiting = 'Waiting';

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'magnet:') { const m = /dn=([^&]+)/.exec(u.search || url); return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : 'magnet link'; }
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || u.hostname;
  } catch { return url; }
}

export function kindLabel(job) {
  if (job.kind === 'video') return 'video' + (job.quality && job.quality !== 'best' ? ' · ' + (job.quality === 'audio' ? 'audio' : job.quality + 'p') : '');
  if (job.kind === 'torrent') return 'torrent';
  if (job.kind === 'ftp') return 'ftp';
  if (job.kind === 'gallery') return 'gallery';
  return null;
}
