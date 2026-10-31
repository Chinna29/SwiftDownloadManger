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
  bridge/server.js     Loopback HTTP API for the extension
src/                   React renderer
extension/             Manifest V3 extension for Chrome / Edge
scripts/dev.js         Dev runner (Vite + Electron)
scripts/make-icons.js  Generates the PNG and ICO icons
scripts/make-shortcut.js Desktop / Start Menu shortcuts
swiftfetch.cmd         Launches the app from a shell
```

## Where data lives

- Settings and the job list: `%APPDATA%\swiftfetch\settings.json` and `jobs.json`
- In-flight downloads: `<target>.sfdownload` (data) and `<target>.sfpart` (resume state)
- yt-dlp, Deno and ffmpeg binaries: `%APPDATA%\swiftfetch\bin\`

## Roadmap ideas

- Dynamic segment splitting (steal the remaining range of a slow segment)
- Playlist and channel downloads
- Scheduler (start queue at a given time), per-category folders
- Firefox extension (the background script already uses only MV3 APIs Firefox supports)

## License

MIT
