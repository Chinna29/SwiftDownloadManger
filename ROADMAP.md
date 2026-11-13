# Roadmap

SwiftFetch set out to match [Mister Download Manager](https://github.com/anefzaoui/misterdownloadmanager)
(MDM 0.5.x) feature for feature. MDM is GPL-3.0 and written in Rust; SwiftFetch is MIT and
JavaScript, so everything below was reimplemented from MDM's documented behaviour, not ported.

## Done (branch `feature/mdm-parity`)

| MDM feature | SwiftFetch |
| --- | --- |
| Batch download with `*` ranges | Add > Batch download |
| Link grabber, packages, online lookups | Add > Link grabber; browser right-click > Download all / selected links |
| Import `.txt` / `.ef2`, export `.ef2` | Add > Import list; right-click > Export |
| Clipboard monitor | Settings > Downloads |
| Named queues, start/stop times, daily/once, start on launch, retries | Queues > Scheduler |
| When done: exit / shutdown / sleep / hibernate / open file | Scheduler > Schedule (30 s countdown) |
| Download limits (N MB per H hours) | Scheduler > Download limits |
| Speed limiter | Settings > General |
| Duplicate-link policy | Settings > Downloads, or per add |
| Download File Info (description, category, server), move/rename, redownload, refresh address | Properties |
| Checksums MD5 / SHA-1 / SHA-256 / SHA-512 / CRC32 | Add dialog and Properties |
| Mark of the Web | Settings > Downloads |
| Archive extraction (zip native, 7z/rar via 7-Zip), delete after | Settings > Archives; Properties for passwords |
| Torrents: magnet, .torrent, file selection, sequential, share ratio, limits | Add > Add torrent |
| Debrid: Real-Debrid, AllDebrid, Premiumize, TorBox | Settings > Accounts |
| FTP / FTPS | paste an `ftp://` link |
| Google Drive links | paste a Drive / Docs link |
| Proxy: none / system / manual, SOCKS | Settings > Connection |
| Site logins | Settings > Site logins |
| Galleries (gallery-dl) | Add dialog > Download whole gallery |
| Sounds | Settings > Appearance & sounds |
| Themes, dark mode, interface size | Settings > Appearance & sounds |
| CLI (`/d /p /f /a`, files on the shortcut) | `swiftfetch.cmd` |
| Sort, filters, find, multi-select, context menu | main window |
| Tray with queue start/stop | tray icon |

## Still open

Ordered roughly by how often people ask for them.

- **Remote control / web UI**: manage the queue from another device. The loopback bridge is
  the natural base (bind to LAN with a token).
- **MCP server**: expose add / list / pause / resume to AI agents; MDM ships one.
- **Server mode**: headless process without the window, driven by the CLI or remote control.
- **Automation API**: documented JSON API on the bridge beyond what the extension uses.
- **Portable mode**: keep settings next to the executable instead of `%APPDATA%`.
- **Wake from sleep for a scheduled queue**: Windows wake timers (`SetWaitableTimer`).
- **PAC proxy scripts**: only none / system / manual are supported; a PAC URL set in Windows is
  not evaluated.
- **DNS over HTTPS, network adapter binding**: not planned unless requested.
- **Drop target**: a small always-on-top window to drop links on.
- **Crash reports**: opt-in local crash log.
- **Translations**: MDM ships 86 languages; SwiftFetch is English only. Strings are not yet
  externalised.
- **Firefox extension**: the background script uses MV3 APIs Firefox supports; needs a
  manifest variant and testing.
- **Columns view**: MDM has a classic table with movable columns; SwiftFetch uses cards with
  sort and find.

## SwiftFetch ideas not from MDM

- Dynamic segment splitting (steal the remaining range of a slow segment)
- Playlist and channel downloads through yt-dlp
- Per-category speed limits
