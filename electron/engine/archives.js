'use strict';
// Extract archives after download: zip natively (adm-zip), 7z/rar/tar.* through 7-Zip when installed.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');

const ARCHIVE_RE = /\.(zip|7z|rar|tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|gz|xz|bz2)$/i;
const VOLUME_RE = /\.(part\d+\.rar|r\d{2}|7z\.\d{3}|zip\.\d{3}|z\d{2})$/i;

function isArchive(name) {
  return ARCHIVE_RE.test(name) || VOLUME_RE.test(name);
}

function find7zip() {
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, '7-Zip', '7z.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', '7-Zip', '7z.exe'),
    '/usr/bin/7z', '/usr/local/bin/7z', '/opt/homebrew/bin/7z',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).toString().trim().split('\n').pop()));
      resolve(stdout.toString());
    });
  });
}

/** Where extracted files go: a folder named after the archive unless it holds one top-level item. */
function targetFor(archivePath, topLevelCount, mode = 'auto') {
  const dir = path.dirname(archivePath);
  const base = path.basename(archivePath).replace(ARCHIVE_RE, '').replace(VOLUME_RE, '');
  if (mode === 'never') return dir;
  if (mode === 'always' || topLevelCount !== 1) return path.join(dir, base);
  return dir;
}

async function extractZip(archivePath, { mode = 'auto', password = null } = {}) {
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
  const target = targetFor(archivePath, tops.size, mode);
  await fsp.mkdir(target, { recursive: true });
  let count = 0;
  for (const e of entries) {
    // Never write outside the target (zip-slip).
    const dest = path.resolve(target, e.entryName);
    if (!dest.startsWith(path.resolve(target) + path.sep) && dest !== path.resolve(target)) continue;
    if (e.isDirectory) { await fsp.mkdir(dest, { recursive: true }); continue; }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const data = password ? e.getData(password) : e.getData();
    let out = dest;
    let n = 1;
    while (fs.existsSync(out)) { const ext = path.extname(dest); out = dest.slice(0, dest.length - ext.length) + ' (' + n++ + ')' + ext; }
    await fsp.writeFile(out, data);
    count++;
  }
  return { target, count };
}

async function extractWith7z(archivePath, { mode = 'auto', password = null } = {}) {
  const sevenZip = find7zip();
  if (!sevenZip) throw new Error('7-Zip is needed to extract this archive (7-zip.org)');
  const listOut = await run(sevenZip, ['l', '-slt', '-ba', ...(password ? ['-p' + password] : ['-p']), archivePath]);
  const paths = [...listOut.matchAll(/^Path = (.+)$/gm)].map((m) => m[1]);
  const tops = new Set(paths.map((p) => p.split(/[\\/]/)[0]));
  const target = targetFor(archivePath, tops.size, mode);
  await fsp.mkdir(target, { recursive: true });
  await run(sevenZip, ['x', '-y', '-aou', '-o' + target, ...(password ? ['-p' + password] : ['-p']), archivePath]);
  return { target, count: paths.length };
}

/**
 * Extract an archive next to itself. Returns { target, count } or throws with a plain reason.
 * Split archives: pass the first volume (part1.rar / .001); 7-Zip finds the rest.
 */
async function extractArchive(archivePath, opts = {}) {
  const name = path.basename(archivePath).toLowerCase();
  if (VOLUME_RE.test(name) && !/\.(part0*1\.rar|001)$/i.test(name) && !/\.part0*1\.rar$/i.test(name)) {
    throw new Error('Not the first volume of the archive');
  }
  if (/\.zip$/i.test(name)) {
    try { return await extractZip(archivePath, opts); }
    catch (e) {
      if (find7zip()) return extractWith7z(archivePath, opts);
      throw new Error('Could not extract zip: ' + e.message);
    }
  }
  return extractWith7z(archivePath, opts);
}

module.exports = { isArchive, extractArchive, find7zip };
