import React, { useState } from 'react';

export default function SettingsDialog({ settings, bridge, onSave, onClose }) {
  const sf = window.sf;
  const [s, setS] = useState({ ...settings });
  const up = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setS((prev) => ({ ...prev, [k]: v }));
  };

  const browse = async () => {
    const d = await sf.chooseDir(s.downloadDir);
    if (d) setS((prev) => ({ ...prev, downloadDir: d }));
  };

  const save = async (e) => {
    e.preventDefault();
    const saved = await sf.settings.set({
      ...s,
      maxConcurrent: Number(s.maxConcurrent),
      segments: Number(s.segments),
      speedLimitKB: Number(s.speedLimitKB),
      bridgePort: Number(s.bridgePort),
    });
    onSave(saved);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Settings</h2>

        <label className="field">
          <span>Default folder</span>
          <div className="row">
            <input value={s.downloadDir} onChange={up('downloadDir')} spellCheck={false} />
            <button type="button" onClick={browse}>Browse…</button>
          </div>
        </label>

        <div className="grid2">
          <label className="field">
            <span>Max simultaneous downloads</span>
            <input type="number" min="1" max="10" value={s.maxConcurrent} onChange={up('maxConcurrent')} />
          </label>
          <label className="field">
            <span>Segments per file</span>
            <input type="number" min="1" max="32" value={s.segments} onChange={up('segments')} />
          </label>
          <label className="field">
            <span>Speed limit (KB/s, 0 = unlimited)</span>
            <input type="number" min="0" step="64" value={s.speedLimitKB} onChange={up('speedLimitKB')} />
          </label>
          <label className="field">
            <span>Browser bridge port</span>
            <input type="number" min="1024" max="65535" value={s.bridgePort} onChange={up('bridgePort')} />
          </label>
        </div>

        <label className="check"><input type="checkbox" checked={!!s.autoStart} onChange={up('autoStart')} /> Start new downloads immediately</label>
        <label className="check"><input type="checkbox" checked={!!s.notifyOnComplete} onChange={up('notifyOnComplete')} /> Notify when a download completes</label>
        <label className="check"><input type="checkbox" checked={!!s.showOnBrowserAdd} onChange={up('showOnBrowserAdd')} /> Bring window to front when the browser sends a download</label>

        <div className="hint">
          <b>Browser extension:</b> bridge is {bridge?.listening ? 'listening' : 'not running'} on 127.0.0.1:{bridge?.port}.
          Load the <code>extension</code> folder in Chrome or Edge via <i>Manage extensions → Developer mode → Load unpacked</i>.
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </div>
  );
}
