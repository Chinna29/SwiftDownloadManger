import React, { useEffect, useMemo, useRef, useState } from 'react';
import { bytes, hostOf, nameFromUrl } from '../format.js';
import { Destination } from './Menu.jsx';

const STATUS_TEXT = {
  online: 'online', page: 'web page', offline: 'offline', login: 'needs login', busy: 'busy', error: 'error', magnet: 'magnet', ftp: 'ftp', pending: '…',
};

/**
 * Link grabber: paste text or links, grab a page, import a list, or receive links from the
 * browser extension. Links are grouped into packages, can be looked up (online / size / page),
 * ticked, and started or added to a queue.
 */
export default function LinkGrabberDialog({ settings, queues, incoming, onClose, onDone }) {
  const sf = window.sf;
  const [text, setText] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [title, setTitle] = useState(incoming?.title || '');
  const [packages, setPackages] = useState(incoming?.packages || []);
  const [checked, setChecked] = useState(() => new Set((incoming?.links || []).filter((l) => !l.isPage).map((l) => l.url)));
  const [info, setInfo] = useState({});           // url -> lookup result
  const [looking, setLooking] = useState(false);
  const [filter, setFilter] = useState('');
  const [onlyFiles, setOnlyFiles] = useState(true);
  const [busy, setBusy] = useState('');
  const [dir, setDir] = useState(settings.downloadDir);
  const [queueId, setQueueId] = useState('main');
  const [startNow, setStartNow] = useState(settings.autoStart);
  const [error, setError] = useState('');
  const token = useRef(0);

  const allLinks = useMemo(() => packages.flatMap((p) => p.links), [packages]);

  useEffect(() => sf.links.onLookup((m) => {
    if (m.token !== token.current) return;
    setInfo((prev) => ({ ...prev, [m.info.url]: m.info }));
  }), []);

  useEffect(() => {
    if (incoming?.links?.length && !incoming.skipLookup) lookup(incoming.links);
  }, []);

  const applyResult = (r, source) => {
    if (!r || r.error) { setError(r?.error || 'Nothing found'); return; }
    const links = r.links || [];
    if (!links.length) { setError('No links found in ' + source + '.'); return; }
    setError('');
    setTitle(r.title || source);
    setPackages(r.packages);
    setChecked(new Set(links.filter((l) => !l.isPage).map((l) => l.url)));
    setInfo({});
    lookup(links);
  };

  const lookup = async (links) => {
    const list = links.filter((l) => /^(https?|ftp|ftps):/i.test(l.url));
    if (!list.length) return;
    token.current += 1;
    setLooking(true);
    setInfo(Object.fromEntries(list.map((l) => [l.url, { url: l.url, status: 'pending' }])));
    const results = await sf.links.lookup(list, token.current);
    if (Array.isArray(results)) setInfo((prev) => { const n = { ...prev }; for (const r of results) if (r?.url) n[r.url] = r; return n; });
    setLooking(false);
  };

  const grabText = async () => { setBusy('text'); applyResult(await sf.links.extract(text, pageUrl || null), 'the pasted text'); setBusy(''); };
  const grabPage = async () => {
    if (!/^https?:\/\//i.test(pageUrl.trim())) { setError('Enter a page address first.'); return; }
    setBusy('page');
    const r = await sf.links.fromPage(pageUrl.trim());
    applyResult(r.ok ? r : { error: r.error }, pageUrl.trim());
    setBusy('');
  };
  const importFile = async () => { setBusy('file'); const r = await sf.links.importFile(); if (r) applyResult(r, r.title || 'the file'); setBusy(''); };
  const pasteClipboard = async () => { const t = await sf.clipboardText(); if (t) setText(t); };

  const toggle = (url) => setChecked((prev) => { const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n; });
  const togglePackage = (pkg, on) => setChecked((prev) => { const n = new Set(prev); for (const l of pkg.links) on ? n.add(l.url) : n.delete(l.url); return n; });
  const setAll = (on) => setChecked(on ? new Set(visible.map((l) => l.url)) : new Set());

  const q = filter.trim().toLowerCase();
  const visibleOf = (pkg) => pkg.links.filter((l) => {
    if (q && !l.url.toLowerCase().includes(q) && !(l.text || '').toLowerCase().includes(q)) return false;
    if (onlyFiles) { const st = info[l.url]?.status; if (st === 'page' || st === 'offline' || (l.isPage && !st)) return false; }
    return true;
  });
  const visible = packages.flatMap(visibleOf);
  const selected = allLinks.filter((l) => checked.has(l.url));
  const totalSize = selected.reduce((a, l) => a + (info[l.url]?.size || 0), 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!selected.length) return;
    setBusy('add');
    const items = selected.map((l) => {
      const headers = {};
      if (l.referer) headers.Referer = l.referer;
      if (l.cookie) headers.Cookie = l.cookie;
      if (incoming?.userAgent) headers['User-Agent'] = incoming.userAgent;
      return { url: l.url, filename: l.filename || undefined, headers, description: l.text && l.text !== l.url ? l.text.slice(0, 200) : undefined };
    });
    await sf.jobs.addMany(items, { dir, queueId: startNow ? null : queueId, autoStart: startNow, source: 'grabber', onDuplicate: 'numbered' });
    setBusy('');
    onDone?.();
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal xwide" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Link grabber {title && <span className="dim small">· {title}</span>}</h2>

        <div className="grabber-sources">
          <label className="field">
            <span>Paste links or any text containing links <button type="button" className="link" onClick={pasteClipboard}>paste clipboard</button></span>
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={'https://host/a.zip\nhttps://host/b.zip\nor HTML, Markdown, an IDM .ef2 export…'} spellCheck={false} />
          </label>
          <div className="row">
            <input value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} placeholder="https://example.com/downloads  (grab every link on a page)" spellCheck={false} />
            <button type="button" onClick={grabPage} disabled={busy === 'page'}>{busy === 'page' ? 'Fetching…' : 'Grab page'}</button>
            <button type="button" onClick={grabText} disabled={!text.trim() || busy === 'text'}>Scan text</button>
            <button type="button" onClick={importFile}>Import file…</button>
          </div>
          {error && <span className="err small">{error}</span>}
        </div>

        {packages.length > 0 && (
          <>
            <div className="row wrap gap small" style={{ alignItems: 'center' }}>
              <b>{allLinks.length} links in {packages.length} package{packages.length > 1 ? 's' : ''}</b>
              <span className="dim">{selected.length} selected{totalSize ? ' · ' + bytes(totalSize) : ''}</span>
              {looking && <span className="dim">checking links…</span>}
              <span className="spacer" />
              <label className="check small"><input type="checkbox" checked={onlyFiles} onChange={(e) => setOnlyFiles(e.target.checked)} /> hide pages &amp; offline</label>
              <input className="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <button type="button" className="link" onClick={() => setAll(true)}>all</button>
              <button type="button" className="link" onClick={() => setAll(false)}>none</button>
              <button type="button" className="link" onClick={() => lookup(allLinks)} disabled={looking}>re-check</button>
            </div>
            <div className="grabber-list">
              {packages.map((pkg) => {
                const rows = visibleOf(pkg);
                if (!rows.length) return null;
                const on = rows.every((l) => checked.has(l.url));
                return (
                  <div className="pkg" key={pkg.name}>
                    <label className="pkg-head">
                      <input type="checkbox" checked={on} onChange={(e) => togglePackage({ links: rows }, e.target.checked)} />
                      <b>{pkg.name}</b><span className="dim small">{rows.length} link{rows.length > 1 ? 's' : ''}{pkg.kind ? ' · ' + pkg.kind : ''}</span>
                    </label>
                    {rows.map((l) => {
                      const st = info[l.url];
                      return (
                        <label className="pkg-row" key={l.url} title={l.url}>
                          <input type="checkbox" checked={checked.has(l.url)} onChange={() => toggle(l.url)} />
                          <span className="name">{st?.filename || l.filename || nameFromUrl(l.url)}</span>
                          <span className="dim">{hostOf(l.url)}</span>
                          <span className={'st ' + (st?.status || '')}>{st ? (st.status === 'online' && st.size ? bytes(st.size) : STATUS_TEXT[st.status] || st.status) : (l.isPage ? 'page?' : '')}</span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <Destination dir={dir} setDir={setDir} queues={queues} queueId={queueId} setQueueId={setQueueId} startNow={startNow} setStartNow={setStartNow} />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!selected.length || busy === 'add'}>
            {busy === 'add' ? 'Adding…' : startNow ? 'Download ' + selected.length + ' selected' : 'Add ' + selected.length + ' to queue'}
          </button>
        </div>
      </form>
    </div>
  );
}
