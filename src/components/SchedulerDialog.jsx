import React, { useEffect, useState } from 'react';
import { bytes, STATUS_LABEL } from '../format.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WHEN_DONE = [
  ['none', 'Do nothing'], ['exit', 'Exit SwiftFetch'], ['open', 'Open a file / program'],
  ['sleep', 'Sleep'], ['hibernate', 'Hibernate'], ['shutdown', 'Shut down the computer'],
];

/** Queues, their schedules, the files in them, and download limits. */
export default function SchedulerDialog({ queues, jobs, settings, onClose, onSettings, initialQueue }) {
  const sf = window.sf;
  const [list, setList] = useState(queues || []);
  const [cur, setCur] = useState(initialQueue || queues?.[0]?.id || 'main');
  const [tab, setTab] = useState('schedule');
  const [draft, setDraft] = useState(null);
  const [limits, setLimits] = useState({ ...(settings.downloadLimits || { enabled: false, mb: 200, hours: 5, warn: true }) });
  const [usage, setUsage] = useState(null);
  const [newName, setNewName] = useState('');
  const [pick, setPick] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => sf.queues.onChange(setList), []);
  useEffect(() => { sf.queues.limits().then((l) => setUsage(l.usage)); }, [tab]);

  const q = list.find((x) => x.id === cur) || list[0];
  useEffect(() => { if (q) setDraft({ name: q.name, concurrent: q.concurrent, schedule: { ...q.schedule } }); }, [cur, list.length]);

  if (!q || !draft) return null;
  const s = draft.schedule;
  const upS = (k, v) => setDraft((d) => ({ ...d, schedule: { ...d.schedule, [k]: v } }));
  const inQueue = jobs.filter((j) => j.queueId === q.id && j.status !== 'completed');
  const finished = jobs.filter((j) => j.queueId === q.id && j.status === 'completed');
  const candidates = jobs.filter((j) => j.queueId !== q.id && j.status !== 'completed' && j.status !== 'downloading');

  const save = async () => {
    await sf.queues.update(q.id, { name: draft.name, concurrent: Number(draft.concurrent), schedule: s });
    const saved = await sf.settings.set({ downloadLimits: { ...limits, mb: Number(limits.mb) || 0, hours: Number(limits.hours) || 1 } });
    onSettings?.(saved);
    setMsg('Saved.');
    setTimeout(() => setMsg(''), 1500);
  };
  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    const created = await sf.queues.create(name);
    setNewName('');
    if (created?.id) setCur(created.id);
  };
  const removeQueue = async () => { await sf.queues.remove(q.id); setCur('main'); };
  const chooseFile = async () => { const f = await sf.chooseFile([{ name: 'Programs and files', extensions: ['*'] }]); if (f) upS('whenDoneFile', f); };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal xwide scheduler" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Scheduler</h2>
        <div className="sched-body">
          <aside className="sched-queues">
            {list.map((x) => (
              <button type="button" key={x.id} className={x.id === q.id ? 'active' : ''} onClick={() => setCur(x.id)}>
                <span className="ellipsis">{x.name}</span>
                <span className={'dot ' + (x.running ? 'on' : 'off')} title={x.running ? 'running' : 'stopped'} />
              </button>
            ))}
            <div className="row" style={{ marginTop: 8 }}>
              <input placeholder="New queue…" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }} />
              <button type="button" onClick={create} disabled={!newName.trim()}>+</button>
            </div>
          </aside>

          <section className="sched-main">
            <div className="row" style={{ alignItems: 'center' }}>
              <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} disabled={q.builtin} style={{ fontWeight: 600 }} />
              {q.running
                ? <button type="button" onClick={() => sf.queues.stop(q.id)}>■ Stop now</button>
                : <button type="button" className="primary" onClick={() => sf.queues.start(q.id)}>▶ Start now</button>}
              {!q.builtin && <button type="button" className="danger" onClick={removeQueue} title="Delete queue (its downloads stay in the list)">Delete</button>}
            </div>
            <div className="tabs">
              {[['schedule', 'Schedule'], ['files', 'Files in queue (' + inQueue.length + ')'], ['limits', 'Download limits']].map(([k, label]) => (
                <button type="button" key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
              ))}
            </div>

            {tab === 'schedule' && (
              <div className="sched-form">
                <label className="field inline"><span>Download at the same time</span><input type="number" min="1" max="10" className="short" value={draft.concurrent} onChange={(e) => setDraft((d) => ({ ...d, concurrent: e.target.value }))} /> <span className="dim small">files from this queue</span></label>
                <label className="check"><input type="checkbox" checked={!!s.startOnLaunch} onChange={(e) => upS('startOnLaunch', e.target.checked)} /> Start this queue when SwiftFetch starts</label>
                <div className="row wrap gap">
                  <label className="check"><input type="checkbox" checked={!!s.startEnabled} onChange={(e) => upS('startEnabled', e.target.checked)} /> Start downloading at</label>
                  <input type="time" value={s.startTime} onChange={(e) => upS('startTime', e.target.value)} disabled={!s.startEnabled} />
                  <select value={s.mode} onChange={(e) => upS('mode', e.target.value)} disabled={!s.startEnabled}>
                    <option value="daily">every day / on these days</option>
                    <option value="once">once, on</option>
                  </select>
                  {s.mode === 'once' && <input type="date" value={s.onceDate || ''} onChange={(e) => upS('onceDate', e.target.value)} disabled={!s.startEnabled} />}
                </div>
                {s.mode === 'daily' && (
                  <div className="row gap days">
                    {DAYS.map((d, i) => (
                      <label key={d} className={'day' + (s.days?.includes(i) ? ' on' : '') + (s.startEnabled ? '' : ' off')}>
                        <input type="checkbox" checked={!!s.days?.includes(i)} disabled={!s.startEnabled} onChange={(e) => upS('days', e.target.checked ? [...(s.days || []), i].sort() : (s.days || []).filter((x) => x !== i))} />{d}
                      </label>
                    ))}
                  </div>
                )}
                <div className="row wrap gap">
                  <label className="check"><input type="checkbox" checked={!!s.stopEnabled} onChange={(e) => upS('stopEnabled', e.target.checked)} /> Stop downloading at</label>
                  <input type="time" value={s.stopTime} onChange={(e) => upS('stopTime', e.target.value)} disabled={!s.stopEnabled} />
                </div>
                <label className="field inline"><span>Retry a failed download</span><input type="number" min="0" max="99" className="short" value={s.retries} onChange={(e) => upS('retries', Number(e.target.value))} /><span className="dim small">times (0 = don't retry) while the queue runs, 30 s apart</span></label>
                <div className="row wrap gap">
                  <label className="field inline"><span>When the queue finishes</span>
                    <select value={s.whenDone} onChange={(e) => upS('whenDone', e.target.value)}>{WHEN_DONE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  </label>
                  {s.whenDone === 'open' && (<><input value={s.whenDoneFile || ''} onChange={(e) => upS('whenDoneFile', e.target.value)} placeholder="C:\path\to\program.exe or file" spellCheck={false} /><button type="button" onClick={chooseFile}>Browse…</button></>)}
                </div>
                {['shutdown', 'sleep', 'hibernate', 'exit'].includes(s.whenDone) && <div className="hint">A 30-second countdown appears first so you can cancel it.</div>}
              </div>
            )}

            {tab === 'files' && (
              <div className="sched-files">
                {inQueue.length === 0 && <div className="dim">Nothing waiting in this queue. Use <i>Download later</i> in the Add dialog, or pick files below.</div>}
                {inQueue.map((j) => (
                  <div className="pkg-row" key={j.id}>
                    <span className="name" title={j.url}>{j.filename || j.url}</span>
                    <span className="dim">{STATUS_LABEL[j.status] || j.status}{j.size ? ' · ' + bytes(j.size) : ''}</span>
                    <button type="button" className="link" onClick={() => sf.jobs.removeFromQueue([j.id])}>remove from queue</button>
                  </div>
                ))}
                {finished.length > 0 && <div className="dim small">{finished.length} finished file{finished.length > 1 ? 's' : ''} {q.keepFinished ? 'kept for re-sync' : ''}</div>}
                <div>
                  <button type="button" onClick={() => setPick((p) => !p)} disabled={!candidates.length}>{pick ? 'Hide' : 'Add files from the list…'}</button>
                </div>
                {pick && candidates.map((j) => (
                  <div className="pkg-row" key={j.id}>
                    <span className="name" title={j.url}>{j.filename || j.url}</span>
                    <span className="dim">{STATUS_LABEL[j.status] || j.status}{j.queueId ? ' · in ' + (list.find((x) => x.id === j.queueId)?.name || j.queueId) : ''}</span>
                    <button type="button" className="link" onClick={() => sf.jobs.addToQueue([j.id], q.id)}>add</button>
                  </div>
                ))}
              </div>
            )}

            {tab === 'limits' && (
              <div className="sched-form">
                <label className="check"><input type="checkbox" checked={!!limits.enabled} onChange={(e) => setLimits({ ...limits, enabled: e.target.checked })} /> Limit how much is downloaded</label>
                <div className="row wrap gap">
                  <span>At most</span><input type="number" min="1" className="short" value={limits.mb} onChange={(e) => setLimits({ ...limits, mb: e.target.value })} disabled={!limits.enabled} /><span>MB every</span>
                  <input type="number" min="1" max="168" className="short" value={limits.hours} onChange={(e) => setLimits({ ...limits, hours: e.target.value })} disabled={!limits.enabled} /><span>hours</span>
                </div>
                <label className="check"><input type="checkbox" checked={!!limits.warn} onChange={(e) => setLimits({ ...limits, warn: e.target.checked })} disabled={!limits.enabled} /> Show a notification when the limit is reached</label>
                {usage && <div className="hint">Used in the current period: <b>{bytes(usage.used || 0)}</b>{limits.enabled ? ' of ' + limits.mb + ' MB' : ''}{usage.resetAt ? ' · resets ' + new Date(usage.resetAt).toLocaleTimeString() : ''}. Downloads in every queue wait while the limit is reached and resume on their own.</div>}
              </div>
            )}
          </section>
        </div>
        <div className="modal-actions">
          <span className="dim small">{msg}</span><span className="spacer" />
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
