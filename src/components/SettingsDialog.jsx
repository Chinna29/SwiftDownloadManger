import React, { useEffect, useState } from 'react';

export default function SettingsDialog({ settings, bridge, onSave, onClose }) {
  const sf = window.sf;
  const [s, setS] = useState({ ...settings });
  const [tools, setTools] = useState(null);
  const [qualities, setQualities] = useState([]);
  const [install, setInstall] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    sf.video.status().then(setTools);
    sf.video.qualities().then(setQualities);
    return sf.video.onInstall((p) => {
      if (p.phase === 'done' || p.phase === 'error') {
        setInstall(null);
        if (p.phase === 'error') setMsg(p.error);
        sf.video.status().then(setTools);
      } else {
        setInstall(p);
      }
    });
  }, []);

  const up = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setS((prev) => ({ ...prev, [k]: v }));
  };

  const browse = async () => {
    const d = await sf.chooseDir(s.downloadDir);
    if (d) setS((prev) => ({ ...prev, downloadDir: d }));
  };

  const doInstall = async (kind) => {
    setMsg('');
    const r = await sf.video.install(kind);
    if (!r.ok) setMsg(r.error);
  };

  const doUpdate = async () => {
    setMsg('Checking for updates…');
    const r = await sf.video.update();
    setMsg(r.ok ? r.message : r.error);
    if (r.ok) setTools(r.status);
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

  const installText = install
    ? install.phase === 'downloading' && install.size
      ? 'Downloading ' + install.kind + ' ' + Math.round((install.downloaded / install.size) * 100) + '%'
      : install.phase === 'extracting' ? 'Extracting ffmpeg…' : 'Installing ' + install.kind + '…'
    : '';

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal wide" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
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

        <h3>Video downloads (yt-dlp)</h3>
        <div className="tools">
          <div className="tool">
            <div>
              <b>yt-dlp</b>
              <span className={tools?.ytdlp ? 'ok' : 'warn'}>{tools ? (tools.ytdlp ? ' ' + tools.ytdlp : ' not installed') : ' …'}</span>
              <div className="dim small">Downloads from YouTube and about a thousand other sites. Fetched from the official GitHub releases.</div>
            </div>
            <div className="row">
              {!tools?.ytdlp && <button type="button" disabled={!!install} onClick={() => doInstall('ytdlp')}>Install (≈24 MB)</button>}
              {tools?.ytdlp && <button type="button" disabled={!!install} onClick={doUpdate}>Update</button>}
            </div>
          </div>
          <div className="tool">
            <div>
              <b>Deno</b>
              <span className={tools?.deno ? 'ok' : 'warn'}>{tools ? (tools.deno ? ' ' + tools.deno : ' not installed') : ' …'}</span>
              <div className="dim small">JavaScript runtime yt-dlp uses to unlock all YouTube formats. Installed together with yt-dlp.</div>
            </div>
            <div className="row">
              {!tools?.deno && <button type="button" disabled={!!install} onClick={() => doInstall('deno')}>Install (≈43 MB)</button>}
            </div>
          </div>
          <div className="tool">
            <div>
              <b>ffmpeg</b>
              <span className={tools?.ffmpeg ? 'ok' : 'warn'}>{tools ? (tools.ffmpeg ? ' ' + tools.ffmpeg : ' not installed') : ' …'}</span>
              <div className="dim small">Merges separate video and audio streams. Without it YouTube is often limited to 360p; with it you get 720p, 1080p, 4K and clean audio-only extraction.</div>
            </div>
            <div className="row">
              {!tools?.ffmpeg && <button type="button" disabled={!!install} onClick={() => doInstall('ffmpeg')}>Install (≈130 MB)</button>}
            </div>
          </div>
          <label className="field inline">
            <span>Default quality</span>
            <select value={s.videoQuality || 'best'} onChange={up('videoQuality')}>
              {qualities.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}
            </select>
          </label>
          {(installText || msg) && <div className="dim small">{installText || msg}</div>}
        </div>

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
