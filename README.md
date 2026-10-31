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
- **Desktop notifications** when a download finishes.

## Run from source

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite dev server and opens Electron against it with hot reload.

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
2. Optionally install **ffmpeg** (≈130 MB). Without it only pre-merged formats are available,
   which on YouTube means up to 720p; with it you get 1080p and above plus audio-only extraction.
3. Paste a video page URL in **Add URL**, click **Analyze as video**, choose a quality, download.
   From the browser, use the extension popup's **Download video from this page** or the
   right-click entry of the same name.

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
  engine/ytdlp.js      yt-dlp/Deno/ffmpeg installer, probe, and video job runner
  bridge/server.js     Loopback HTTP API for the extension
src/                   React renderer
extension/             Manifest V3 extension for Chrome / Edge
scripts/dev.js         Dev runner (Vite + Electron)
scripts/make-icons.js  Generates the PNG icons
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
