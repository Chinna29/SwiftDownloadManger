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
  bridge/server.js     Loopback HTTP API for the extension
src/                   React renderer
extension/             Manifest V3 extension for Chrome / Edge
scripts/dev.js         Dev runner (Vite + Electron)
scripts/make-icons.js  Generates the PNG icons
```

## Where data lives

- Settings and the job list: `%APPDATA%\swiftfetch\settings.json` and `jobs.json`
- In-flight downloads: `<target>.sfdownload` (data) and `<target>.sfpart` (resume state)

## Roadmap ideas

- Dynamic segment splitting (steal the remaining range of a slow segment)
- HLS/DASH streams via yt-dlp
- Scheduler (start queue at a given time), per-category folders
- Firefox extension (the background script already uses only MV3 APIs Firefox supports)

## License

MIT
