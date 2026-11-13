# SwiftFetch

An open-source download manager for Windows in the spirit of IDM: multi-segment downloads,
pause and resume, a queue with concurrency and speed limits, and a Chrome/Edge extension that
hands browser downloads to the app. No paid services, no accounts, no telemetry.

Built with Electron, Node.js and React. Everything in the stack is free and open source.

## Features

- **Segmented downloads.** Files are split into up to 32 byte ranges fetched in parallel and
  written at their offsets into a pre-allocated file.
- **Pause / resume.** Per-segment progress is saved next to the file (`*.sfpart`), so a paused,
  crashed or rebooted download continues where it stopped. Servers that do not support ranges
  fall back to a single stream.
- **Queue.** Configurable number of simultaneous downloads, retries with exponential backoff,
  global speed limit, pause/resume all.
- **Browser extension.** Captures downloads from Chrome or Edge (with cookies and referer so
  authenticated downloads work), adds "Download with SwiftFetch" to the right-click menu, and
  lists video/audio files detected on the current page.
- **Video downloads via yt-dlp.** Paste a YouTube (or any yt-dlp supported) page URL, pick a
  quality or audio-only, and the app runs the bundled yt-dlp as a job with live progress, pause,
  resume and cancel. yt-dlp, Deno (its JavaScript runtime) and ffmpeg are downloaded on demand
  from their official GitHub releases into the app's data folder; nothing is installed system-wide.
- **Organized folders.** Downloads go to `Downloads\SwiftDM` and are sorted into `Videos`,
  `Audio`, `Images` and `Files` by extension or content type (editable in Settings → Folders).
  Pick a different folder in the Add dialog and it is used as-is.
- **Tray and startup.** Closing the window keeps SwiftFetch in the tray (pause/resume all, add
  from clipboard, quit). It can start with Windows, minimized to the tray.
- **Desktop notifications** when a download finishes.

### Added for parity with Mister Download Manager (v0.2)

Reimplemented from MDM's documented behaviour (MDM itself is GPL-3.0 and written in Rust, so
no code was copied; SwiftFetch stays MIT). See [ROADMAP.md](ROADMAP.md) for what is still open.

- **Batch download.** `https://host/img*.jpg` with a number or letter range and zero padding.
  Pasting a plain URL suggests the wildcard from its last digit run.
- **Link grabber.** Paste text, HTML, Markdown or an IDM `.ef2` export, grab every link on a page,
  import a `.txt`/`.ef2` list, or right-click a page in the browser -> *Download all links* /
  *Download selected links*. Links are grouped into packages (archive volumes, hosts, magnets),
  checked online (size, web page, offline, login needed), ticked and started or queued.
- **Named queues and scheduler.** Main and Synchronization queues plus your own, each with its
  own concurrency, start time (daily on chosen days, or once), stop time, start-on-launch,
  retry count, and a *when done* action: exit, sleep, hibernate, shut down or open a file, with
  a 30 s cancellable countdown. *Download later* in any Add dialog puts the file in a queue.
- **Download limits.** At most N MB every H hours; downloads wait and resume on their own.
- **Properties per download.** Description, refresh an expired address and continue, move or
  rename the finished file, set or verify a checksum (MD5, SHA-1, SHA-256, SHA-512, CRC32),
  extract an archive (with password), redownload, export as `.ef2`.
- **Duplicate links.** Ask, number, resume/open, or overwrite, globally or per add.
- **Archives.** Optional automatic extraction when a download finishes: ZIP built in, 7z/RAR/TAR
  through 7-Zip when it is installed; extract into a folder named after the archive; move the
  archive to the Recycle Bin afterwards.
- **Torrents.** Magnet links and `.torrent` files through WebTorrent: metadata lookup, pick the
  files, sequential mode for playback while downloading, seeding until a share ratio or time
  limit, per-direction speed limits. Magnets copied to the clipboard open the torrent dialog.
- **FTP / FTPS** with resume, passive mode, and saved logins.
- **Google Drive links** (`file/d/...`, `uc?id=`, Docs/Sheets/Slides exports, large-file virus-scan
  confirmation) resolve to the real file when the download starts.
- **Premium link accounts.** Real-Debrid, AllDebrid, Premiumize and TorBox: add your own API
  key and links to hosts they support are unrestricted automatically.
- **Proxy and site logins.** None, system (Windows Internet Settings) or manual HTTP/SOCKS proxy,
  with local bypass; per-host HTTP Basic logins. Both also apply to yt-dlp and gallery-dl.
- **Galleries** through gallery-dl (installed on demand): whole albums from Imgur, Flickr,
  DeviantArt, Reddit, Pixiv and many more.
- **Mark of the Web.** Finished files get the `Zone.Identifier` stream so SmartScreen treats
  them like browser downloads (can be turned off).
- **Clipboard monitor.** Copy a link to a file type you care about and SwiftFetch offers it.
- **Command line.** `swiftfetch.cmd URL`, IDM-style `/d URL /p folder /f name /a`, or drop a
  `.torrent`, `.txt` or `.ef2` file on the shortcut; a second instance forwards to the running app.
- **Interface.** Light/dark/system theme, interface size, sort and find, multi-select with
  Shift/Ctrl, right-click menu, category and queue views in the sidebar, completion and failure
  sounds (system beep or your own `.wav`), tray menu with start/stop queue.

## Run from source

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite dev server and opens Electron against it with hot reload.

## Launch without a terminal

```bash
npm run shortcut
```

Builds the renderer and creates **SwiftFetch** shortcuts on the Desktop and in the Start Menu
that launch the app directly from this checkout. `swiftfetch.cmd` in the project root does the
same from a shell. Settings → System has the same "Create shortcuts" button, plus **Start
SwiftFetch when Windows starts** and **Keep running in the tray**.

## Build an installer

```bash
npm run build
```

Produces an NSIS installer under `release/` using electron-builder.

## Install the browser extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the `extension` folder of this repo.
4. Start SwiftFetch. The popup shows a green dot when the app is reachable.

The extension talks to the app over `http://127.0.0.1:47831` (change the port in both the app
settings and the extension popup if it clashes). Only extension origins are accepted by that
endpoint, so ordinary web pages cannot push downloads into the app.

## Video downloads

1. Open **Settings → Video downloads** and click **Install** next to yt-dlp. This fetches
   yt-dlp (≈24 MB) and Deno (≈43 MB). The Add dialog offers the same install the first time you
   paste a video page URL.
2. Install **ffmpeg** (≈130 MB) unless you only want low quality. Without it only pre-merged
   formats are available, which on YouTube is often just 360p; with it you get 720p, 1080p, 4K
   and audio-only extraction. The quality lists only ever show resolutions that will really be
   downloaded.
3. Paste a video page URL in **Add URL**, click **Analyze as video**, choose a quality, download.
   In the browser, a floating **Download** button appears over any video player; click it to see
   the resolution list with sizes and start the download in one click, IDM style. The extension
   popup and the right-click menu offer the same with the default quality.

### Logged-in sites, feeds and streams

- **Cookies.** Video downloads started from the extension carry your browser cookies for that
  site, so anything you can watch while signed in to X, Facebook or Instagram downloads too.
  Each job gets its own Netscape cookie file under `%APPDATA%\swiftfetch\cookies\`, passed to
  yt-dlp with `--cookies` and deleted when the job finishes. Downloads started from the app's
  Add URL dialog carry no cookies.
- **Feeds.** On X, Facebook, Instagram, Reddit, TikTok and LinkedIn the on-page button resolves
  the permalink of the post that contains the video, so it works while scrolling a feed, not only
  on the post's own page.
- **HLS and DASH.** The extension popup lists `.m3u8` and `.mpd` playlists it sees and sends them
  to yt-dlp, which downloads the fragments and stitches them into one file.
- **Media sniffer.** A page-level hook (`extension/sniffer.js`, injected into every frame) watches
  the player's own `fetch` and `XMLHttpRequest` traffic and recognises manifests by their content,
  not their URL, so playlists built in JavaScript and served with generic content types are still
  caught. It records the request headers the player used (tokens, custom auth) and SwiftFetch
  replays them through yt-dlp's `--add-headers`. Master playlists are listed first in the popup.
  Encrypted DRM streams are detected but cannot be downloaded.
- **Output container.** Settings → Video lets you choose MP4 or MKV (needs ffmpeg).
- **In-page downloads.** Files the page builds itself (`blob:` and `data:` URLs, such as exports
  and generated PDFs) cannot be fetched by an external app, so Chrome saves them and the
  extension then hands the finished file to SwiftFetch, which moves it into the right SwiftDM
  folder and lists it as completed. Toggle in the popup.
- **Not possible.** DRM services (Netflix, Prime and similar) are encrypted and are not supported
  by yt-dlp or SwiftFetch; torrents, magnet links and FTP are different protocols.

Downloading from YouTube is against its terms of service. Keep it to your own uploads,
Creative Commons content, or offline personal viewing. Sites that rehost pirated content
are deliberately not a target of this feature.

## Project layout

```
electron/
  main.js              Electron main process, IPC, notifications
  preload.js           Safe bridge exposed to the renderer as window.sf
  settings.js          JSON-backed settings
  engine/http.js       Request helper with redirects and a one-request probe
  engine/downloader.js Segmented download with resume state
  engine/queue.js      Job list, scheduling, persistence
  engine/limiter.js    Token-bucket speed limiter
  engine/categories.js Category detection and folder routing
  engine/cookies.js    Netscape cookie files for yt-dlp, one per job
  engine/ytdlp.js      yt-dlp/Deno/ffmpeg installer, probe, and video job runner
  engine/scheduler.js  Named queues, schedules, download limits, when-done actions
  engine/links.js      Link extraction, batch patterns, packages, online lookup, .ef2 export
  engine/torrents.js   WebTorrent client: lookup, file selection, seeding limits
  engine/ftp.js        FTP/FTPS probe and resumable download (basic-ftp)
  engine/gdrive.js     Google Drive / Docs link resolver
  engine/debrid.js     Real-Debrid, AllDebrid, Premiumize, TorBox unrestrict
  engine/netctx.js     Proxy agents and saved site logins
  engine/archives.js   ZIP (adm-zip) and 7-Zip extraction
  engine/checksum.js   MD5 / SHA / CRC32 verification
  engine/motw.js       Zone.Identifier (Mark of the Web)
  engine/gallerydl.js  gallery-dl installer and job runner
  bridge/server.js     Loopback HTTP API for the extension (/add, /probe, /import, /links)
src/                   React renderer
extension/             Manifest V3 extension for Chrome / Edge
scripts/dev.js         Dev runner (Vite + Electron)
scripts/make-icons.js  Generates the PNG and ICO icons
scripts/make-shortcut.js Desktop / Start Menu shortcuts
swiftfetch.cmd         Launches the app from a shell
```

## Dependency notes

- `webtorrent` 2.x calls `arr2hex()` on the info hash string that `parse-torrent` returns; `uint8-util`
  2.3.x made that throw, which breaks every magnet and `.torrent` add. `package.json` therefore pins
  `uint8-util` to 2.2.6 through npm `overrides`. Remove the pin once WebTorrent handles 2.3.
- `https-proxy-agent` and `socks-proxy-agent` stay on their CommonJS majors (7 and 8): the newer ones
  are ESM-only and Electron 33's Node runtime cannot `require()` them.

## Where data lives

- Settings and the job list: `%APPDATA%\swiftfetch\settings.json` and `jobs.json`
- In-flight downloads: `<target>.sfdownload` (data) and `<target>.sfpart` (resume state)
- yt-dlp, Deno, ffmpeg and gallery-dl binaries: `%APPDATA%\swiftfetch\bin\`
- Torrent data is downloaded straight into the target folder; the `.torrent` metadata is kept in `jobs.json` for re-seeding

## Roadmap

See [ROADMAP.md](ROADMAP.md): the remaining Mister Download Manager features (remote control,
MCP server, server mode, translations, portable mode...) and SwiftFetch's own ideas.

## License

MIT
