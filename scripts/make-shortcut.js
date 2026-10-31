'use strict';
// Creates Desktop and Start Menu shortcuts that launch SwiftFetch directly (no dev terminal).
// Works for the source checkout: the shortcut runs node_modules/electron/dist/electron.exe
// with the project folder as its app path. Run "npm run shortcut" to (re)create them.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'win32') {
  console.error('Shortcuts are only generated on Windows.');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const icon = path.join(root, 'build', 'icon.ico');
if (!fs.existsSync(electronExe)) {
  console.error('Electron is not installed. Run npm install first.');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('Renderer is not built. Run npm run build:renderer first.');
  process.exit(1);
}

const ps = (s) => s.replace(/'/g, "''");
const script = `
$ws = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SwiftFetch.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'SwiftFetch.lnk')
)
foreach ($p in $targets) {
  $s = $ws.CreateShortcut($p)
  $s.TargetPath = '${ps(electronExe)}'
  $s.Arguments = '"${ps(root)}"'
  $s.WorkingDirectory = '${ps(root)}'
  $s.IconLocation = '${ps(fs.existsSync(icon) ? icon : electronExe)},0'
  $s.Description = 'SwiftFetch download manager'
  $s.Save()
  Write-Output "created $p"
}
`;

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  process.stdout.write(out);
} catch (e) {
  console.error('Could not create shortcuts:', e.stderr || e.message);
  process.exit(1);
}
