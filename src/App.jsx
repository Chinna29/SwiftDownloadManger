import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JobRow from './components/JobRow.jsx';
import AddDialog from './components/AddDialog.jsx';
import BatchDialog from './components/BatchDialog.jsx';
import LinkGrabberDialog from './components/LinkGrabberDialog.jsx';
import TorrentDialog from './components/TorrentDialog.jsx';
import SchedulerDialog from './components/SchedulerDialog.jsx';
import PropertiesDialog from './components/PropertiesDialog.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import { Dropdown, ContextMenu, Choice } from './components/Menu.jsx';
import { speed as fmtSpeed, bytes } from './format.js';

const FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'active', label: 'Active', match: (j) => ['downloading', 'queued', 'probing', 'waiting'].includes(j.status) },
  { key: 'paused', label: 'Paused', match: (j) => j.status === 'paused' || j.status === 'cancelled' },
  { key: 'completed', label: 'Completed', match: (j) => j.status === 'completed' },
  { key: 'failed', label: 'Failed', match: (j) => j.status === 'failed' },
];
const CATEGORIES = ['Videos', 'Audio', 'Images', 'Files', 'Torrents'];
const SORTS = [['added', 'Date added'], ['name', 'Name'], ['size', 'Size'], ['status', 'Status'], ['done', 'Date finished']];

const categoryOf = (j) => (j.kind === 'torrent' ? 'Torrents' : j.category || 'Files');

export default function App() {
  const sf = window.sf;
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState(null);
  const [queues, setQueues] = useState([]);
  const [bridge, setBridge] = useState(null);
  const [filter, setFilter] = useState({ type: 'status', key: 'all' });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'added', dir: 'desc' });
  const [selected, setSelected] = useState(() => new Set());
  const [dialog, setDialog] = useState(null);          // { type, ...payload }
  const [ctx, setCtx] = useState(null);                // { x, y, job }
  const [countdown, setCountdown] = useState(null);
  const [limitHit, setLimitHit] = useState(null);
  const [choice, setChoice] = useState(null);
  const lastClick = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    sf.jobs.list().then(setJobs);
    sf.settings.get().then(setSettings);
    sf.queues.list().then(setQueues);
    sf.bridge.status().then(setBridge);
    const offs = [
      sf.jobs.onChange(setJobs),
      sf.queues.onChange(setQueues),
      sf.bridge.onStatus(setBridge),
      sf.app.onAddRequest((p) => setDialog({ type: 'add', initial: p })),
      sf.app.onBatchRequest(() => setDialog({ type: 'batch' })),
      sf.links.onIncoming((p) => setDialog({ type: 'links', incoming: p })),
      sf.torrents.onRequest((p) => setDialog({ type: 'torrent', initial: p })),
      sf.torrents.onMagnet((p) => setDialog({ type: 'torrent', initial: p })),
      sf.queues.onCountdown(setCountdown),
      sf.queues.onLimit((l) => setLimitHit(l && l.hit ? l : null)),
    ];
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); setDialog({ type: 'add' }); }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if (mod && e.key.toLowerCase() === 'a' && !/input|textarea/i.test(e.target.tagName)) { e.preventDefault(); setSelected(new Set(visibleRef.current.map((j) => j.id))); }
      if (e.key === 'Escape') { setDialog(null); setCtx(null); setSelected(new Set()); }
      if (e.key === 'Delete' && !/input|textarea/i.test(e.target.tagName) && selectedRef.current.size) removeSelected(false);
    };
    window.addEventListener('keydown', onKey);
    return () => { offs.forEach((f) => f()); window.removeEventListener('keydown', onKey); };
  }, []);

  // Theme: follow the OS, or force dark / light.
  useEffect(() => {
    if (!settings) return;
    const apply = () => {
      const t = settings.theme === 'system' || !settings.theme ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings?.theme]);

  const counts = useMemo(() => {
    const c = {};
    for (const f of FILTERS) c[f.key] = jobs.filter(f.match).length;
    for (const cat of CATEGORIES) c['cat:' + cat] = jobs.filter((j) => categoryOf(j) === cat).length;
    for (const q of queues) c['q:' + q.id] = jobs.filter((j) => j.queueId === q.id && j.status !== 'completed').length;
    return c;
  }, [jobs, queues]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = jobs.filter((j) => {
      if (filter.type === 'status') return (FILTERS.find((x) => x.key === filter.key) || FILTERS[0]).match(j);
      if (filter.type === 'cat') return categoryOf(j) === filter.key;
      if (filter.type === 'queue') return j.queueId === filter.key;
      return true;
    });
    if (q) list = list.filter((j) => (j.filename || '').toLowerCase().includes(q) || j.url.toLowerCase().includes(q) || (j.description || '').toLowerCase().includes(q));
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (j) => sort.key === 'name' ? (j.filename || j.url).toLowerCase() : sort.key === 'size' ? (j.size || 0) : sort.key === 'status' ? j.status : sort.key === 'done' ? (j.completedAt || 0) : (j.addedAt || 0);
    return list.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir);
  }, [jobs, filter, query, sort]);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const selectedRef = useRef(selected); selectedRef.current = selected;

  const totalSpeed = jobs.reduce((a, j) => a + (j.status === 'downloading' ? j.speed || 0 : 0), 0);
  const anyActive = jobs.some((j) => j.status === 'downloading' || j.status === 'queued' || j.status === 'waiting');
  const anyPaused = jobs.some((j) => j.status === 'paused' || j.status === 'failed');
  const mainQueue = queues.find((q) => q.id === 'main') || queues[0];
  const runningQueues = queues.filter((q) => q.running);
  const queueById = useMemo(() => Object.fromEntries(queues.map((q) => [q.id, q])), [queues]);

  const onSelect = (id, e) => {
    setSelected((prev) => {
      const n = new Set(e?.ctrlKey || e?.metaKey ? prev : []);
      if (e?.shiftKey && lastClick.current) {
        const ids = visible.map((j) => j.id);
        const a = ids.indexOf(lastClick.current), b = ids.indexOf(id);
        if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) n.add(ids[i]); return n; }
      }
      if ((e?.ctrlKey || e?.metaKey) && prev.has(id)) n.delete(id); else n.add(id);
      if (!e?.ctrlKey && !e?.metaKey && prev.size === 1 && prev.has(id)) n.clear();
      return n;
    });
    lastClick.current = id;
  };

  const removeSelected = (deleteFiles) => {
    const ids = [...selectedRef.current];
    if (!ids.length) return;
    const hasFiles = ids.some((id) => jobs.find((j) => j.id === id)?.status === 'completed');
    if (!deleteFiles && !settingsRef.current?.confirmDelete && !hasFiles) { sf.jobs.removeMany(ids, false); setSelected(new Set()); return; }
    setChoice({
      title: 'Remove ' + ids.length + ' download' + (ids.length > 1 ? 's' : '') + '?',
      text: hasFiles ? 'Finished files can be kept on disk or deleted too.' : '',
      buttons: [{ label: 'Remove from list', value: 'list', primary: true }, hasFiles && { label: 'Delete files too', value: 'files', danger: true }, { label: 'Cancel', value: null }].filter(Boolean),
      onPick: (v) => { setChoice(null); if (!v) return; sf.jobs.removeMany(ids, v === 'files'); setSelected(new Set()); },
    });
  };
  const settingsRef = useRef(settings); settingsRef.current = settings;

  const selJobs = [...selected].map((id) => jobs.find((j) => j.id === id)).filter(Boolean);
  const ctxItems = (job) => {
    const targets = selected.has(job.id) && selected.size > 1 ? selJobs : [job];
    const ids = targets.map((j) => j.id);
    const many = targets.length > 1;
    return [
      !many && job.status === 'completed' && { label: 'Open', onClick: () => sf.jobs.openFile(job.id) },
      !many && job.filePath && { label: 'Show in folder', onClick: () => sf.jobs.showInFolder(job.id) },
      { sep: true },
      targets.some((j) => ['downloading', 'queued', 'waiting'].includes(j.status)) && { label: many ? 'Pause selected' : 'Pause', onClick: () => ids.forEach((id) => sf.jobs.pause(id)) },
      targets.some((j) => ['paused', 'failed', 'cancelled'].includes(j.status)) && { label: many ? 'Resume selected' : 'Resume', onClick: () => ids.forEach((id) => sf.jobs.resume(id)) },
      { label: 'Redownload', onClick: () => ids.forEach((id) => sf.jobs.redownload(id)) },
      { sep: true },
      { label: 'Add to queue', hint: '▸', onClick: () => setChoice({ title: 'Add to which queue?', buttons: [...queues.map((q) => ({ label: q.name, value: q.id })), { label: 'Cancel', value: null }], onPick: (v) => { setChoice(null); if (v) sf.jobs.addToQueue(ids, v); } }) },
      targets.some((j) => j.queueId) && { label: 'Remove from queue', onClick: () => sf.jobs.removeFromQueue(ids) },
      { sep: true },
      !many && { label: 'Properties…', hint: 'ⓘ', onClick: () => setDialog({ type: 'props', job }) },
      { label: 'Copy address' + (many ? 'es' : ''), onClick: () => navigator.clipboard.writeText(targets.map((j) => j.url).join('\n')) },
      { label: 'Export ' + (many ? 'selected' : '') + ' as .ef2…', onClick: () => sf.jobs.export(ids, 'ef2') },
      { sep: true },
      { label: many ? 'Remove ' + targets.length + ' selected' : 'Remove', danger: true, onClick: () => { setSelected(new Set(ids)); setTimeout(() => removeSelected(false), 0); } },
    ];
  };

  const toggleQueue = () => { if (!mainQueue) return; (mainQueue.running ? sf.queues.stop : sf.queues.start)(mainQueue.id); };

  if (!settings) return <div className="loading">Loading…</div>;

  const addItems = [
    { label: 'Add URL…', hint: 'Ctrl+N', onClick: () => setDialog({ type: 'add' }) },
    { label: 'Batch download…', hint: 'file*.zip', onClick: () => setDialog({ type: 'batch' }) },
    { label: 'Add torrent / magnet…', onClick: () => setDialog({ type: 'torrent' }) },
    { label: 'Link grabber…', hint: 'page / text', onClick: () => setDialog({ type: 'links' }) },
    { sep: true },
    { label: 'Import list (.txt / .ef2)…', onClick: async () => { const r = await sf.links.importFile(); if (r) setDialog({ type: 'links', incoming: r }); } },
  ];
  const queueItems = [
    ...queues.map((q) => ({ label: (q.running ? '■ Stop ' : '▶ Start ') + q.name, hint: counts['q:' + q.id] + ' waiting', onClick: () => (q.running ? sf.queues.stop : sf.queues.start)(q.id) })),
    { sep: true },
    { label: 'Scheduler…', onClick: () => setDialog({ type: 'scheduler' }) },
  ];
  const deleteItems = [
    { label: 'Remove selected', hint: selected.size || '', disabled: !selected.size, onClick: () => removeSelected(false) },
    { sep: true },
    { label: 'Clear completed', hint: counts.completed, disabled: !counts.completed, onClick: () => sf.jobs.clearCompleted() },
    { label: 'Clear failed', hint: counts.failed, disabled: !counts.failed, onClick: () => sf.jobs.clearFailed() },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo">⇣</span><span>SwiftFetch</span></div>
        <div className="toolbar">
          <Dropdown className="primary" label="+ Add ▾" items={addItems} />
          <button onClick={toggleQueue} disabled={!mainQueue} title={mainQueue ? (mainQueue.running ? 'Stop ' : 'Start ') + mainQueue.name : ''}>{mainQueue?.running ? '■ Stop queue' : '▶ Start queue'}</button>
          <Dropdown label="Queues ▾" items={queueItems} />
          <button onClick={() => sf.jobs.resumeAll()} disabled={!anyPaused}>Resume all</button>
          <button onClick={() => sf.jobs.pauseAll()} disabled={!anyActive}>Pause all</button>
          <Dropdown label="Delete ▾" items={deleteItems} />
          <span className="spacer" />
          <select className="sort" value={sort.key} onChange={(e) => setSort({ ...sort, key: e.target.value })} title="Sort by">{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })} title="Sort direction">{sort.dir === 'asc' ? '↑' : '↓'}</button>
          <input ref={searchRef} className="search" placeholder="Find… (Ctrl+F)" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button onClick={() => setDialog({ type: 'settings' })} title="Settings">⚙</button>
        </div>
      </header>

      {countdown && (
        <div className="banner warn">
          <span>{countdown.label || 'Queue finished'} — {countdown.action} in <b>{countdown.seconds}s</b></span>
          <span className="spacer" />
          <button onClick={() => sf.queues.powerNow()}>Now</button>
          <button className="primary" onClick={() => sf.queues.cancelCountdown()}>Cancel</button>
        </div>
      )}
      {limitHit && (
        <div className="banner">
          <span>Download limit reached ({bytes(limitHit.used || 0)} of {bytes(limitHit.limit || 0)}). Downloads wait until {limitHit.resumeAt ? new Date(limitHit.resumeAt).toLocaleTimeString() : 'the period is over'}.</span>
          <span className="spacer" />
          <button onClick={() => setDialog({ type: 'scheduler' })}>Change limit</button>
        </div>
      )}

      <div className="body">
        <nav className="sidebar">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter.type === 'status' && filter.key === f.key ? 'active' : ''} onClick={() => setFilter({ type: 'status', key: f.key })}>
              <span>{f.label}</span><span className="count">{counts[f.key]}</span>
            </button>
          ))}
          <div className="side-h">Categories</div>
          {CATEGORIES.map((c) => (
            <button key={c} className={filter.type === 'cat' && filter.key === c ? 'active' : ''} onClick={() => setFilter({ type: 'cat', key: c })}>
              <span>{c}</span><span className="count">{counts['cat:' + c]}</span>
            </button>
          ))}
          <div className="side-h">Queues <button className="link" onClick={() => setDialog({ type: 'scheduler' })} title="Scheduler">⏱</button></div>
          {queues.map((q) => (
            <button key={q.id} className={filter.type === 'queue' && filter.key === q.id ? 'active' : ''} onClick={() => setFilter({ type: 'queue', key: q.id })} title={q.running ? 'running' : 'stopped'}>
              <span className="ellipsis"><span className={'dot ' + (q.running ? 'on' : 'off')} /> {q.name}</span><span className="count">{counts['q:' + q.id]}</span>
            </button>
          ))}
        </nav>

        <main className="list" onClick={(e) => { if (e.target === e.currentTarget) setSelected(new Set()); }}>
          {visible.length === 0 && (
            <div className="empty">
              <div className="empty-icon">⇣</div>
              <p>{jobs.length === 0 ? 'No downloads yet. Paste a link with Add URL, drop a batch pattern, grab links from a page, or install the browser extension.' : 'Nothing matches this view.'}</p>
            </div>
          )}
          {visible.map((j) => (
            <JobRow key={j.id} job={j} selected={selected.has(j.id)} queue={queueById[j.queueId]} onSelect={onSelect} confirmDelete={settings.confirmDelete !== false}
              onContextMenu={(e, job) => { if (!selected.has(job.id)) setSelected(new Set([job.id])); setCtx({ x: e.clientX, y: e.clientY, job }); }}
              onProperties={(job) => setDialog({ type: 'props', job })} />
          ))}
        </main>
      </div>

      <footer className="statusbar">
        <span>{counts.active} active · {counts.completed} completed{selected.size ? ' · ' + selected.size + ' selected' : ''}</span>
        <span>{totalSpeed > 0 ? '↓ ' + fmtSpeed(totalSpeed) : ''}</span>
        {runningQueues.length > 0 && <span className="ok">▶ {runningQueues.map((q) => q.name).join(', ')}</span>}
        <span className="spacer" />
        {settings.speedLimitKB > 0 && <span>Limit {settings.speedLimitKB} KB/s</span>}
        {settings.clipboardMonitor && <span title="Copied links are offered for download">📋</span>}
        <span className={'dot ' + (bridge?.listening ? 'on' : 'off')} title={'Browser bridge on port ' + bridge?.port} />
        <span>Bridge {bridge?.listening ? 'on' : 'off'}</span>
      </footer>

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems(ctx.job)} onClose={() => setCtx(null)} />}
      {choice && <Choice {...choice} />}

      {dialog?.type === 'add' && <AddDialog settings={settings} queues={queues} initial={dialog.initial} onClose={() => setDialog(null)} onTorrent={(magnet) => setTimeout(() => setDialog({ type: 'torrent', initial: { magnet } }), 0)} />}
      {dialog?.type === 'batch' && <BatchDialog settings={settings} queues={queues} initialUrl={dialog.url} onClose={() => setDialog(null)} />}
      {dialog?.type === 'torrent' && <TorrentDialog settings={settings} queues={queues} initial={dialog.initial} onClose={() => setDialog(null)} />}
      {dialog?.type === 'links' && <LinkGrabberDialog settings={settings} queues={queues} incoming={dialog.incoming} onClose={() => setDialog(null)} />}
      {dialog?.type === 'scheduler' && <SchedulerDialog queues={queues} jobs={jobs} settings={settings} onSettings={setSettings} initialQueue={filter.type === 'queue' ? filter.key : undefined} onClose={() => setDialog(null)} />}
      {dialog?.type === 'props' && <PropertiesDialog job={dialog.job} jobs={jobs} queues={queues} settings={settings} onClose={() => setDialog(null)} />}
      {dialog?.type === 'settings' && <SettingsDialog settings={settings} bridge={bridge} onSave={setSettings} onClose={() => setDialog(null)} />}
    </div>
  );
}
