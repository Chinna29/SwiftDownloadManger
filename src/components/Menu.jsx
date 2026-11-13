import React, { useEffect, useRef, useState } from 'react';

/** Toolbar dropdown: <Dropdown label="Add ▾" items=[{label, onClick, disabled, sep}] /> */
export function Dropdown({ label, items, className = '', title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', () => setOpen(false));
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span className="dropdown" ref={ref}>
      <button type="button" className={className} title={title} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && (
        <div className="menu">
          {items.filter(Boolean).map((it, i) => it.sep
            ? <div className="menu-sep" key={'s' + i} />
            : (
              <button type="button" key={it.label + i} disabled={it.disabled} onClick={() => { setOpen(false); it.onClick(); }}>
                <span>{it.label}</span>{it.hint && <span className="menu-hint">{it.hint}</span>}
              </button>
            ))}
        </div>
      )}
    </span>
  );
}

/** Right-click menu anchored at a screen position. */
export function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); window.removeEventListener('blur', onClose); };
  }, [onClose]);
  const style = { left: Math.min(x, window.innerWidth - 240), top: Math.min(y, window.innerHeight - 12 - items.length * 30) };
  return (
    <div className="menu context" style={style} ref={ref}>
      {items.filter(Boolean).map((it, i) => it.sep
        ? <div className="menu-sep" key={'s' + i} />
        : (
          <button type="button" key={it.label + i} disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => { onClose(); it.onClick(); }}>
            <span>{it.label}</span>{it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ))}
    </div>
  );
}

/** Tiny confirm/choice modal: buttons = [{label, value, primary, danger}] */
export function Choice({ title, text, buttons, onPick }) {
  return (
    <div className="modal-backdrop" onMouseDown={() => onPick(null)}>
      <div className="modal narrow" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {text && <div className="dim" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>}
        <div className="modal-actions">
          {buttons.map((b) => (
            <button key={b.value ?? b.label} type="button" className={(b.primary ? 'primary' : '') + (b.danger ? ' danger' : '')} onClick={() => onPick(b.value)}>{b.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Folder picker row + queue / start-now choice shared by the add dialogs. */
export function Destination({ dir, setDir, queues, queueId, setQueueId, startNow, setStartNow, target }) {
  const sf = window.sf;
  const browse = async () => { const d = await sf.chooseDir(dir); if (d) setDir(d); };
  return (
    <>
      <label className="field">
        <span>Folder</span>
        <div className="row">
          <input value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
          <button type="button" onClick={browse}>Browse…</button>
        </div>
        {target && target.dir !== dir && <span className="dim small">Saves to <span className="mono">{target.dir}</span> ({target.category})</span>}
      </label>
      <div className="row wrap">
        <label className="check"><input type="radio" checked={startNow} onChange={() => setStartNow(true)} /> Start now</label>
        <label className="check">
          <input type="radio" checked={!startNow} onChange={() => setStartNow(false)} /> Download later in
          <select value={queueId} onChange={(e) => { setQueueId(e.target.value); setStartNow(false); }}>
            {(queues || []).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
          </select>
        </label>
      </div>
    </>
  );
}
