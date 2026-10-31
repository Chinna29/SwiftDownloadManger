'use strict';
// Starts the Vite dev server, waits until it answers, then launches Electron against it.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
const PORT = 5173;
const URL = 'http://localhost:' + PORT;

// vite's package "exports" map hides bin/vite.js from require.resolve, so build the path by hand.
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
});

let electron = null;

function waitForServer(tries = 0) {
  http.get(URL, (res) => {
    res.resume();
    launchElectron();
  }).on('error', () => {
    if (tries > 100) {
      console.error('Vite did not start');
      shutdown(1);
    } else {
      setTimeout(() => waitForServer(tries + 1), 200);
    }
  });
}

function launchElectron() {
  const electronPath = require('electron');
  electron = spawn(electronPath, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: URL },
  });
  electron.on('exit', (code) => shutdown(code ?? 0));
}

function shutdown(code) {
  if (vite && !vite.killed) vite.kill();
  if (electron && !electron.killed) electron.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
vite.on('exit', (code) => { if (!electron) shutdown(code ?? 0); });

waitForServer();
