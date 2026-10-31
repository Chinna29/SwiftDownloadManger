'use strict';
// Generates PNG icons (rounded blue square with a white down-arrow) without any dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function icon(x, y, s) {
  const r = s * 0.22;
  const cx = Math.min(Math.max(x + 0.5, r), s - r);
  const cy = Math.min(Math.max(y + 0.5, r), s - r);
  const inside = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
  if (!inside) return [0, 0, 0, 0];

  const u = (x + 0.5) / s, v = (y + 0.5) / s;
  // arrow shaft
  const shaft = Math.abs(u - 0.5) < 0.09 && v > 0.2 && v < 0.58;
  // arrow head (triangle)
  const head = v >= 0.5 && v <= 0.76 && Math.abs(u - 0.5) <= (0.76 - v) * 1.1;
  // base line
  const base = v > 0.8 && v < 0.88 && u > 0.26 && u < 0.74;
  if (shaft || head || base) return [255, 255, 255, 255];
  return [79, 140, 255, 255];
}

/** Windows .ico container with PNG-compressed entries (supported since Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const root = path.join(__dirname, '..');
const outs = [
  [16, 'extension/icons/icon16.png'],
  [32, 'extension/icons/icon32.png'],
  [48, 'extension/icons/icon48.png'],
  [128, 'extension/icons/icon128.png'],
  [256, 'build/icon.png'],
];
const made = {};
for (const [size, rel] of outs) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  made[size] = png(size, icon);
  fs.writeFileSync(p, made[size]);
  console.log('wrote', rel);
}
const icoPath = path.join(root, 'build', 'icon.ico');
fs.writeFileSync(icoPath, ico([16, 32, 48, 256].map((s) => ({ size: s, data: made[s] }))));
console.log('wrote build/icon.ico');
