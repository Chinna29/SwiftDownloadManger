import React, { useEffect, useMemo, useState } from 'react';
import JobRow from './components/JobRow.jsx';
import AddDialog from './components/AddDialog.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import { speed as fmtSpeed } from './format.js';

const FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'active', label: 'Active', match: (j) => ['downloading', 'queued', 'probing'].includes(j.status) },
  { key: 'paused', label: 'Paused', match: (j) => j.status === 'paused' || j.status === 'cancelled' },
  { key: 'completed', label: 'Completed', match: (j) => j.status === 'completed' },
  { key: 'failed', label: 'Failed', match: (j) => j.status === 'failed' },
];

export default function App() {
  const sf = window.sf;
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState(null);
  const [bridge, setBridge] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    sf.jobs.list().then(setJobs);
    sf.settings.get().then(setSettings);
    sf.bridge.status().then(setBridge);
    const off1 = sf.jobs.onChange(setJobs);
    const off2 = sf.bridge.onStatus(setBridge);
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); setShowAdd(true); }
      if (e.key === 'Escape') { setShowAdd(false); setShowSettings(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => { off1(); off2(); window.removeEventListener('keydown', onKey); };
  }, []);

  const counts = useMemo(() => {
    const c = {};
    for (const f of FILTERS) c[f.key] = jobs.filter(f.match).length;
    return c;
  }, [jobs]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) || FILTERS[0];
    const q = query.trim().toLowerCase();
    return jobs.filter(f.match).filter((j) => !q || (j.filename || '').toLowerCase().includes(q) || j.url.toLowerCase().includes(q));
  }, [jobs, filter, query]);

  const totalSpeed = jobs.reduce((a, j) => a + (j.status === 'downloading' ? j.speed || 0 : 0), 0);
  const anyActive = jobs.some((j) => j.status === 'downloading' || j.status === 'queued');
  const anyPaused = jobs.some((j) => j.status === 'paused' || j.status === 'failed');

  if (!settings) return <div className="loading">Loading…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇣</span>
          <span>SwiftFetch</span>
        </div>
        <div className="toolbar">
          <button className="primary" onClick={() => setShowAdd(true)} title="Ctrl+N">+ Add URL</button>
          <button onClick={() => sf.jobs.resumeAll()} disabled={!anyPaused}>Resume all</button>
          <button onClick={() => sf.jobs.pauseAll()} disabled={!anyActive}>Pause all</button>
          <button onClick={() => sf.jobs.clearCompleted()} disabled={!counts.completed}>Clear completed</button>
          <button onClick={() => sf.jobs.clearFailed()} disabled={!counts.failed}>Clear failed</button>
          <span className="spacer" />
          <input className="search" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button onClick={() => setShowSettings(true)} title="Settings">⚙</button>
        </div>
      </header>

      <div className="body">
        <nav className="sidebar">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
              <span>{f.label}</span>
              <span className="count">{counts[f.key]}</span>
            </button>
          ))}
        </nav>

        <main className="list">
          {visible.length === 0 && (
            <div className="empty">
              <div className="empty-icon">⇣</div>
              <p>{jobs.length === 0 ? 'No downloads yet. Paste a link with Add URL, or install the browser extension.' : 'Nothing matches this view.'}</p>
            </div>
          )}
          {visible.map((j) => (
            <JobRow key={j.id} job={j} selected={selected === j.id} onSelect={(id) => setSelected(selected === id ? null : id)} />
          ))}
        </main>
      </div>

      <footer className="statusbar">
        <span>{counts.active} active · {counts.completed} completed</span>
        <span>{totalSpeed > 0 ? '↓ ' + fmtSpeed(totalSpeed) : ''}</span>
        <span className="spacer" />
        {settings.speedLimitKB > 0 && <span>Limit {settings.speedLimitKB} KB/s</span>}
        <span className={'dot ' + (bridge?.listening ? 'on' : 'off')} title={'Browser bridge on port ' + bridge?.port} />
        <span>Bridge {bridge?.listening ? 'on' : 'off'}</span>
      </footer>

      {showAdd && <AddDialog settings={settings} onClose={() => setShowAdd(false)} />}
      {showSettings && (
        <SettingsDialog settings={settings} bridge={bridge} onSave={setSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
