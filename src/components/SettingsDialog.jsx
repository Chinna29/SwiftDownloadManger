import React, { useEffect, useState } from 'react';

const CATEGORY_HELP = { Videos: 'Video files', Audio: 'Audio files', Images: 'Pictures' };
const TABS = [
  ['general', 'General'], ['downloads', 'Downloads'], ['folders', 'Folders'], ['video', 'Video & tools'],
  ['connection', 'Connection'], ['logins', 'Site logins'], ['accounts', 'Accounts'], ['archives', 'Archives'], ['look', 'Appearance & sounds'], ['system', 'System'],
];

export default function SettingsDialog({ settings, bridge, onSave, onClose, initialTab }) {
  const sf = window.sf;
  const [s, setS] = useState(() => ({
    ...settings,
    categories: { ...(settings.categories || {}) },
    proxy: { mode: 'none', url: '', username: '', password: '', bypassLocal: true, ...(settings.proxy || {}) },
    siteLogins: [...(settings.siteLogins || [])],
    debridAccounts: [...(settings.debridAccounts || [])],
    sounds: { complete: false, failed: false, queueStart: false, queueStop: false, completeFile: '', failedFile: '', ...(settings.sounds || {}) },
    torrentShare: { seed: true, ratio: 1, minutes: 0, ...(settings.torrentShare || {}) },
    torrentLimits: { down: 0, up: 0, ...(settings.torrentLimits || {}) },
  }));
  const [tools, setTools] = useState(null);
  const [qualities, setQualities] = useState([]);
  const [install, setInstall] = useState(null);
  const [msg, setMsg] = useState('');
  const [shortcutMsg, setShortcutMsg] = useState('');
  const [tab, setTab] = useState(initialTab || 'general');
  const [services, setServices] = useState({});
  const [checks, setChecks] = useState({});
  const [net, setNet] = useState(null);

  useEffect(() => {
    sf.tools.status().then(setTools);
    sf.video.qualities().then(setQualities);
    sf.debrid.services().then(setServices);
    sf.network.status().then(setNet);
    return sf.video.onInstall((p) => {
      if (p.phase === 'done' || p.phase === 'error') { setInstall(null); if (p.phase === 'error') setMsg(p.error); sf.tools.status().then(setTools); }
      else setInstall(p);
    });
  }, []);

  const up = (k) => (e) => { const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setS((prev) => ({ ...prev, [k]: v })); };
  const upIn = (obj, k) => (e) => { const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setS((prev) => ({ ...prev, [obj]: { ...prev[obj], [k]: v } })); };
  const upCat = (name) => (e) => { const v = e.target.value; setS((prev) => ({ ...prev, categories: { ...prev.categories, [name]: v } })); };
  const upList = (key, i, patch) => setS((prev) => ({ ...prev, [key]: prev[key].map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const delList = (key, i) => setS((prev) => ({ ...prev, [key]: prev[key].filter((_, j) => j !== i) }));
  const addList = (key, item) => setS((prev) => ({ ...prev, [key]: [...prev[key], item] }));

  const browse = async () => { const d = await sf.chooseDir(s.downloadDir); if (d) setS((prev) => ({ ...prev, downloadDir: d })); };
  const pickSound = async (k) => { const f = await sf.chooseFile([{ name: 'Sounds', extensions: ['wav'] }]); if (f) setS((prev) => ({ ...prev, sounds: { ...prev.sounds, [k]: f } })); };
  const doInstall = async (kind) => { setMsg(''); const r = await sf.video.install(kind); if (!r.ok) setMsg(r.error); };
  const doUpdate = async () => { setMsg('Checking for updates…'); const r = await sf.video.update(); setMsg(r.ok ? r.message : r.error); if (r.ok) setTools(await sf.tools.status()); };
  const makeShortcuts = async () => { setShortcutMsg('Creating…'); const r = await sf.app.createShortcuts(); setShortcutMsg(r.ok ? 'Shortcuts created on the Desktop and in the Start Menu.' : r.error || 'Could not create shortcuts.'); };
  const checkAccount = async (i) => {
    const a = s.debridAccounts[i];
    setChecks((c) => ({ ...c, [i]: 'Checking…' }));
    const r = await sf.debrid.check(a.service, a.apiKey);
    setChecks((c) => ({ ...c, [i]: r.ok ? '✓ ' + (r.info.username || 'ok') + (r.info.premium === false ? ' (free account)' : r.info.expires ? ' · until ' + new Date(r.info.expires).toLocaleDateString() : '') : '✗ ' + r.error }));
  };

  const save = async (e) => {
    e.preventDefault();
    const saved = await sf.settings.set({
      ...s,
      maxConcurrent: Number(s.maxConcurrent), segments: Number(s.segments), speedLimitKB: Number(s.speedLimitKB), bridgePort: Number(s.bridgePort),
      zoom: Number(s.zoom) || 100,
      torrentShare: { ...s.torrentShare, ratio: Number(s.torrentShare.ratio) || 0, minutes: Number(s.torrentShare.minutes) || 0 },
      torrentLimits: { down: Number(s.torrentLimits.down) || 0, up: Number(s.torrentLimits.up) || 0 },
      siteLogins: s.siteLogins.filter((l) => l.host && l.username),
      debridAccounts: s.debridAccounts.filter((a) => a.apiKey),
    });
    if (Number(s.zoom) !== Number(settings.zoom)) sf.app.setZoom(Number(s.zoom) || 100);
    onSave(saved);
    onClose();
  };

  const installText = install
    ? install.phase === 'downloading' && install.size ? 'Downloading ' + install.kind + ' ' + Math.round((install.downloaded / install.size) * 100) + '%'
      : install.phase === 'extracting' ? 'Extracting ' + install.kind + '…' : 'Installing ' + install.kind + '…'
    : '';

  const Tool = ({ name, ok, desc, children }) => (
    <div className="tool">
      <div><b>{name}</b><span className={ok ? 'ok' : 'warn'}>{tools ? (ok ? ' ' + ok : ' not installed') : ' …'}</span><div className="dim small">{desc}</div></div>
      <div className="row">{children}</div>
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal xwide settings" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Settings</h2>
        <div className="settings-body">
          <nav className="settings-nav">
            {TABS.map(([k, label]) => <button type="button" key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
          </nav>
          <div className="settings-pane">

            {tab === 'general' && (<>
              <div className="grid2">
                <label className="field"><span>Max simultaneous downloads</span><input type="number" min="1" max="10" value={s.maxConcurrent} onChange={up('maxConcurrent')} /></label>
                <label className="field"><span>Segments per file</span><input type="number" min="1" max="32" value={s.segments} onChange={up('segments')} /></label>
                <label className="field"><span>Speed limit (KB/s, 0 = unlimited)</span><input type="number" min="0" step="64" value={s.speedLimitKB} onChange={up('speedLimitKB')} /></label>
                <label className="field"><span>Browser bridge port</span><input type="number" min="1024" max="65535" value={s.bridgePort} onChange={up('bridgePort')} /></label>
              </div>
              <label className="check"><input type="checkbox" checked={!!s.autoStart} onChange={up('autoStart')} /> Start new downloads immediately (otherwise they go to the main queue)</label>
              <label className="check"><input type="checkbox" checked={!!s.notifyOnComplete} onChange={up('notifyOnComplete')} /> Notify when a download completes</label>
              <label className="check"><input type="checkbox" checked={!!s.showOnBrowserAdd} onChange={up('showOnBrowserAdd')} /> Bring window to front when the browser sends a download</label>
              <label className="check"><input type="checkbox" checked={!!s.confirmDelete} onChange={up('confirmDelete')} /> Ask before removing a download from the list</label>
              <div className="hint">
                <b>Browser extension:</b> bridge is {bridge?.listening ? 'listening' : 'not running'} on 127.0.0.1:{bridge?.port}.
                Load the <code>extension</code> folder in Chrome or Edge via <i>Manage extensions → Developer mode → Load unpacked</i>.
                Command line: <code>swiftfetch.cmd &lt;url&gt;</code>, <code>/d URL /p folder /f name /a</code> (IDM-style), or drop a <code>.torrent</code>, <code>.txt</code> or <code>.ef2</code> file on the shortcut.
              </div>
            </>)}

            {tab === 'downloads' && (<>
              <label className="field inline"><span>When a link is already in the list</span>
                <select value={s.duplicatePolicy || 'ask'} onChange={up('duplicatePolicy')}>
                  <option value="ask">ask me</option><option value="numbered">download again with a numbered name</option>
                  <option value="resume">resume / open the existing one</option><option value="overwrite">overwrite the existing one</option>
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={!!s.clipboardMonitor} onChange={up('clipboardMonitor')} /> Watch the clipboard and offer to download copied links</label>
              <label className="field"><span>File types taken from the clipboard (space separated, * for everything)</span><input value={s.clipboardTypes || ''} onChange={up('clipboardTypes')} disabled={!s.clipboardMonitor} spellCheck={false} /></label>
              <label className="check"><input type="checkbox" checked={s.markOfTheWeb !== false} onChange={up('markOfTheWeb')} /> Mark downloaded files as coming from the Internet (Windows SmartScreen zone) </label>
              <label className="field"><span>Custom User-Agent <i className="dim">· blank = SwiftFetch's own; the browser's is used for links it sends</i></span><input value={s.userAgent || ''} onChange={up('userAgent')} spellCheck={false} placeholder="Mozilla/5.0 …" /></label>
              <label className="check"><input type="checkbox" checked={!!s.ftpPassive} onChange={up('ftpPassive')} /> FTP: passive mode (recommended behind routers)</label>
            </>)}

            {tab === 'folders' && (<>
              <label className="field"><span>Download folder</span>
                <div className="row"><input value={s.downloadDir} onChange={up('downloadDir')} spellCheck={false} /><button type="button" onClick={browse}>Browse…</button><button type="button" onClick={() => sf.app.openPath(s.downloadDir)}>Open</button></div>
              </label>
              <label className="check"><input type="checkbox" checked={!!s.organize} onChange={up('organize')} /> Sort downloads into category subfolders (Videos, Audio, Images, Files, Torrents)</label>
              <div className={'cats' + (s.organize ? '' : ' disabled')}>
                {['Videos', 'Audio', 'Images'].map((name) => (
                  <label className="field" key={name}><span>{name} <i className="dim">· {CATEGORY_HELP[name]} · extensions</i></span><input value={s.categories?.[name] || ''} onChange={upCat(name)} spellCheck={false} disabled={!s.organize} /></label>
                ))}
                <div className="dim small">Everything else goes to <b>Files</b>; torrents to <b>Torrents</b>. Video page downloads always go to Videos, or Audio when audio-only. A folder picked in the Add dialog is used as-is.</div>
              </div>
            </>)}

            {tab === 'video' && (<>
              <div className="tools">
                <Tool name="yt-dlp" ok={tools?.ytdlp} desc="Downloads from YouTube and about a thousand other sites. Fetched from the official GitHub releases.">
                  {!tools?.ytdlp && <button type="button" disabled={!!install} onClick={() => doInstall('ytdlp')}>Install (≈24 MB)</button>}
                  {tools?.ytdlp && <button type="button" disabled={!!install} onClick={doUpdate}>Update</button>}
                </Tool>
                <Tool name="Deno" ok={tools?.deno} desc="JavaScript runtime yt-dlp uses to unlock all YouTube formats.">
                  {!tools?.deno && <button type="button" disabled={!!install} onClick={() => doInstall('deno')}>Install (≈43 MB)</button>}
                </Tool>
                <Tool name="ffmpeg" ok={tools?.ffmpeg} desc="Merges separate video and audio streams; needed for 720p and above on YouTube and for audio extraction.">
                  {!tools?.ffmpeg && <button type="button" disabled={!!install} onClick={() => doInstall('ffmpeg')}>Install (≈130 MB)</button>}
                </Tool>
                <Tool name="gallery-dl" ok={tools?.gallerydl} desc="Downloads whole image galleries and albums (Imgur, Flickr, DeviantArt, Reddit, Pixiv and many more).">
                  {!tools?.gallerydl && <button type="button" disabled={!!install} onClick={() => doInstall('gallerydl')}>Install (≈15 MB)</button>}
                </Tool>
                <Tool name="7-Zip" ok={tools?.sevenZip ? 'found' : null} desc="Optional: extracts .7z and .rar archives. ZIP works without it. Install 7-Zip from 7-zip.org and it is picked up automatically." />
                <label className="field inline"><span>Default quality</span>
                  <select value={s.videoQuality || 'best'} onChange={up('videoQuality')}>{qualities.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}</select>
                </label>
                <label className="field inline"><span>Output container</span>
                  <select value={s.videoContainer || 'mp4'} onChange={up('videoContainer')} disabled={!tools?.ffmpeg}><option value="mp4">MP4 (plays everywhere)</option><option value="mkv">MKV (keeps any codec, no remux loss)</option></select>
                  {!tools?.ffmpeg && <span className="dim small">needs ffmpeg</span>}
                </label>
                {(installText || msg) && <div className="dim small">{installText || msg}</div>}
              </div>
            </>)}

            {tab === 'connection' && (<>
              <h3>Proxy</h3>
              <label className="field inline"><span>Mode</span>
                <select value={s.proxy.mode} onChange={upIn('proxy', 'mode')}><option value="none">No proxy</option><option value="system">Use Windows / system proxy</option><option value="manual">Manual</option></select>
                {s.proxy.mode === 'system' && net?.system && <span className="dim small">detected: {net.system}</span>}
                {s.proxy.mode === 'system' && net && !net.system && <span className="dim small">no system proxy set</span>}
              </label>
              {s.proxy.mode === 'manual' && (
                <div className="grid2">
                  <label className="field"><span>Proxy URL</span><input value={s.proxy.url} onChange={upIn('proxy', 'url')} placeholder="http://host:8080 or socks5://host:1080" spellCheck={false} /></label>
                  <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!s.proxy.bypassLocal} onChange={upIn('proxy', 'bypassLocal')} /> bypass for local addresses</label>
                  <label className="field"><span>Username</span><input value={s.proxy.username} onChange={upIn('proxy', 'username')} autoComplete="off" /></label>
                  <label className="field"><span>Password</span><input type="password" value={s.proxy.password} onChange={upIn('proxy', 'password')} autoComplete="new-password" /></label>
                </div>
              )}
              <div className="dim small">Used by direct downloads, FTP, yt-dlp and gallery-dl. Torrents connect directly.</div>
              <h3>Torrents</h3>
              <label className="check"><input type="checkbox" checked={!!s.torrentShare.seed} onChange={upIn('torrentShare', 'seed')} /> Keep sharing (seeding) after a torrent finishes</label>
              <div className="row wrap gap">
                <label className="field inline"><span>until ratio</span><input className="short" type="number" step="0.1" min="0" value={s.torrentShare.ratio} onChange={upIn('torrentShare', 'ratio')} disabled={!s.torrentShare.seed} /></label>
                <label className="field inline"><span>or after</span><input className="short" type="number" min="0" value={s.torrentShare.minutes} onChange={upIn('torrentShare', 'minutes')} disabled={!s.torrentShare.seed} /><span className="dim small">minutes (0 = no time limit)</span></label>
              </div>
              <div className="row wrap gap">
                <label className="field inline"><span>Torrent download limit</span><input className="short" type="number" min="0" value={s.torrentLimits.down} onChange={upIn('torrentLimits', 'down')} /><span className="dim small">KB/s</span></label>
                <label className="field inline"><span>upload limit</span><input className="short" type="number" min="0" value={s.torrentLimits.up} onChange={upIn('torrentLimits', 'up')} /><span className="dim small">KB/s (0 = unlimited)</span></label>
              </div>
              <label className="check"><input type="checkbox" checked={s.keepTorrentFiles !== false} onChange={up('keepTorrentFiles')} /> Keep the .torrent data with the download so it can be re-seeded later</label>
            </>)}

            {tab === 'logins' && (<>
              <div className="dim small">Saved logins are sent as HTTP Basic / FTP credentials when a download matches the host (and path prefix, if given). They are stored in settings.json on this computer.</div>
              <div className="list-edit">
                {s.siteLogins.map((l, i) => (
                  <div className="row" key={i}>
                    <input value={l.host || ''} onChange={(e) => upList('siteLogins', i, { host: e.target.value })} placeholder="host, e.g. files.example.com" spellCheck={false} />
                    <input value={l.path || ''} onChange={(e) => upList('siteLogins', i, { path: e.target.value })} placeholder="/path (optional)" spellCheck={false} className="short2" />
                    <input value={l.username || ''} onChange={(e) => upList('siteLogins', i, { username: e.target.value })} placeholder="user" autoComplete="off" className="short2" />
                    <input type="password" value={l.password || ''} onChange={(e) => upList('siteLogins', i, { password: e.target.value })} placeholder="password" autoComplete="new-password" className="short2" />
                    <button type="button" className="danger" onClick={() => delList('siteLogins', i)}>✕</button>
                  </div>
                ))}
                <div><button type="button" onClick={() => addList('siteLogins', { host: '', path: '', username: '', password: '' })}>+ Add login</button></div>
              </div>
            </>)}

            {tab === 'accounts' && (<>
              <div className="dim small">Premium link services turn one-click-hoster links (and magnets, where supported) into direct downloads. You need your own account; paste its API key here. Links to hosts the service supports are routed through it automatically.</div>
              <div className="list-edit">
                {s.debridAccounts.map((a, i) => (
                  <div className="row wrap" key={i} style={{ alignItems: 'center' }}>
                    <select value={a.service} onChange={(e) => upList('debridAccounts', i, { service: e.target.value })}>
                      {Object.entries(services).map(([k, v]) => <option key={k} value={k}>{v.name || k}</option>)}
                    </select>
                    <input type="password" value={a.apiKey || ''} onChange={(e) => upList('debridAccounts', i, { apiKey: e.target.value })} placeholder="API key / token" autoComplete="new-password" />
                    <label className="check small"><input type="checkbox" checked={a.enabled !== false} onChange={(e) => upList('debridAccounts', i, { enabled: e.target.checked })} /> on</label>
                    <button type="button" onClick={() => checkAccount(i)} disabled={!a.apiKey}>Check</button>
                    <button type="button" className="danger" onClick={() => delList('debridAccounts', i)}>✕</button>
                    {checks[i] && <span className="small dim" style={{ flexBasis: '100%' }}>{checks[i]}{services[a.service]?.keyUrl ? <> · <button type="button" className="link" onClick={() => sf.openExternal(services[a.service].keyUrl)}>get a key</button></> : null}</span>}
                  </div>
                ))}
                <div><button type="button" onClick={() => addList('debridAccounts', { service: Object.keys(services)[0] || 'realdebrid', apiKey: '', enabled: true })}>+ Add account</button></div>
              </div>
            </>)}

            {tab === 'archives' && (<>
              <label className="check"><input type="checkbox" checked={!!s.extractArchives} onChange={up('extractArchives')} /> Extract archives automatically when a download finishes</label>
              <label className="field inline"><span>Extract</span>
                <select value={s.extractInto || 'auto'} onChange={up('extractInto')} disabled={!s.extractArchives}>
                  <option value="auto">into a folder named after the archive, unless it already contains a single top folder</option>
                  <option value="always">always into a folder named after the archive</option>
                  <option value="never">next to the archive, as-is</option>
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={!!s.deleteArchiveAfterExtract} onChange={up('deleteArchiveAfterExtract')} disabled={!s.extractArchives} /> Move the archive to the Recycle Bin after a successful extraction</label>
              <div className="hint">ZIP is built in. 7z, RAR, TAR and others use 7-Zip when it is installed{tools?.sevenZip ? ' (found: ' + tools.sevenZip + ')' : ' (not found)'}. Password-protected archives can be extracted from the download's Properties.</div>
            </>)}

            {tab === 'look' && (<>
              <div className="grid2">
                <label className="field"><span>Theme</span>
                  <select value={s.theme || 'system'} onChange={up('theme')}><option value="system">Follow Windows</option><option value="dark">Dark</option><option value="light">Light</option></select>
                </label>
                <label className="field"><span>Interface size</span>
                  <select value={String(s.zoom || 100)} onChange={up('zoom')}>{[80, 90, 100, 110, 125, 150, 175, 200].map((z) => <option key={z} value={z}>{z}%</option>)}</select>
                </label>
              </div>
              <h3>Sounds</h3>
              {[['complete', 'Download completed', 'completeFile'], ['failed', 'Download failed', 'failedFile']].map(([k, label, fileKey]) => (
                <div className="row wrap gap" key={k} style={{ alignItems: 'center' }}>
                  <label className="check" style={{ minWidth: 190 }}><input type="checkbox" checked={!!s.sounds[k]} onChange={upIn('sounds', k)} /> {label}</label>
                  <input value={s.sounds[fileKey] || ''} onChange={upIn('sounds', fileKey)} placeholder="System beep (or pick a .wav)" spellCheck={false} disabled={!s.sounds[k]} />
                  <button type="button" onClick={() => pickSound(fileKey)} disabled={!s.sounds[k]}>Browse…</button>
                  <button type="button" onClick={() => sf.app.playSound(k)} disabled={!s.sounds[k]}>▶</button>
                </div>
              ))}
              <label className="check"><input type="checkbox" checked={!!s.sounds.queueStart} onChange={upIn('sounds', 'queueStart')} /> Beep when a queue starts</label>
              <label className="check"><input type="checkbox" checked={!!s.sounds.queueStop} onChange={upIn('sounds', 'queueStop')} /> Beep when a queue stops</label>
              <div className="dim small">Sound settings take effect after Save; the ▶ button plays what is currently saved.</div>
            </>)}

            {tab === 'system' && (<>
              <label className="check"><input type="checkbox" checked={!!s.launchAtStartup} onChange={up('launchAtStartup')} /> Start SwiftFetch when Windows starts (minimized to the tray)</label>
              <label className="check"><input type="checkbox" checked={!!s.closeToTray} onChange={up('closeToTray')} /> Keep running in the tray when the window is closed</label>
              <div className="tools">
                <div className="tool">
                  <div><b>Shortcuts</b><div className="dim small">Create Desktop and Start Menu shortcuts that open SwiftFetch directly, without a terminal.</div></div>
                  <button type="button" onClick={makeShortcuts}>Create shortcuts</button>
                </div>
                {shortcutMsg && <div className="dim small">{shortcutMsg}</div>}
              </div>
              <div className="hint">The tray icon menu has Start/Stop queue, Pause all / Resume all, Add from clipboard, Batch from clipboard and Quit. Closing the window only hides it while the option above is on.</div>
            </>)}
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </div>
  );
}
