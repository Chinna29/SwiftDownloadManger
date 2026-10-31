'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class Settings extends EventEmitter {
  constructor(filePath, defaults) {
    super();
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = { ...defaults };
    try {
      if (fs.existsSync(filePath)) {
        Object.assign(this.data, JSON.parse(fs.readFileSync(filePath, 'utf8')));
      }
    } catch (e) {
      console.error('Could not read settings:', e.message);
    }
  }

  get(key) {
    return key === undefined ? { ...this.data } : this.data[key];
  }

  set(patch) {
    const before = { ...this.data };
    Object.assign(this.data, patch);
    this.data.maxConcurrent = clamp(this.data.maxConcurrent, 1, 10);
    this.data.segments = clamp(this.data.segments, 1, 32);
    this.data.speedLimitKB = Math.max(0, Number(this.data.speedLimitKB) || 0);
    this.data.bridgePort = clamp(this.data.bridgePort, 1024, 65535);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('Could not write settings:', e.message);
    }
    this.emit('change', this.data, before);
    return { ...this.data };
  }
}

function clamp(v, lo, hi) {
  v = Number(v);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

module.exports = { Settings };
