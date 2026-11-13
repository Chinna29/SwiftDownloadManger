'use strict';
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

/**
 * Named queues, their schedules, download limits and "when done" actions.
 *
 * A job either belongs to a queue (job.queueId) and runs only while that queue is running,
 * or to none and runs as soon as it is added. Queues are started by hand or by their
 * schedule; the Scheduler ticks every 15 s to start/stop them by the clock, to enforce the
 * download limit, and to run the when-done action once a queue has nothing left.
 */

const DEFAULT_QUEUES = [
  { id: 'main', name: 'Main download queue', builtin: true, concurrent: 4 },
  { id: 'sync', name: 'Synchronization queue', builtin: true, concurrent: 2, keepFinished: true },
];

function defaultSchedule() {
  return {
    startOnLaunch: false,
    startEnabled: false, startTime: '22:00',
    mode: 'daily', days: [0, 1, 2, 3, 4, 5, 6], onceDate: '',
    stopEnabled: false, stopTime: '07:00',
    retries: 0,
    whenDone: 'none', // none | exit | shutdown | sleep | hibernate | open
    whenDoneFile: '',
  };
}

function normalizeQueue(q) {
  return {
    id: q.id,
    name: q.name || q.id,
    builtin: !!q.builtin,
    keepFinished: !!q.keepFinished,
    concurrent: Math.max(1, Math.min(10, Number(q.concurrent) || 4)),
    schedule: { ...defaultSchedule(), ...(q.schedule || {}) },
  };
}

class Scheduler extends EventEmitter {
  constructor({ settings }) {
    super();
    this.settings = settings;
    this.running = new Set();          // queue ids currently running
    this.lastFired = new Map();        // 'start:main:2026-11-13' -> true
    this.bytesLog = [];                // [{ t, n }] for download limits
    this.limitHit = false;
    this.limitResumeAt = null;
    this._timer = null;
    this._countdown = null;
    const stored = settings.get('queues');
    if (!Array.isArray(stored) || !stored.length) settings.set({ queues: DEFAULT_QUEUES.map(normalizeQueue) });
  }

  /* ---------- queues ---------- */

  list() {
    return (this.settings.get('queues') || []).map(normalizeQueue).map((q) => ({ ...q, running: this.running.has(q.id) }));
  }

  get(id) {
    return this.list().find((q) => q.id === id) || null;
  }

  save(queues) {
    this.settings.set({ queues: queues.map(normalizeQueue) });
    this.emit('change');
  }

  create(name) {
    const queues = this.list();
    const id = 'q' + Date.now().toString(36);
    queues.push(normalizeQueue({ id, name: name || 'New queue' }));
    this.save(queues);
    return id;
  }

  update(id, patch) {
    const queues = this.list().map((q) => (q.id === id ? normalizeQueue({ ...q, ...patch, schedule: { ...q.schedule, ...(patch.schedule || {}) } }) : q));
    this.save(queues);
  }

  remove(id) {
    const q = this.get(id);
    if (!q || q.builtin) return false;
    this.running.delete(id);
    this.save(this.list().filter((x) => x.id !== id));
    return true;
  }

  start(id) {
    if (!this.get(id)) return;
    this.running.add(id);
    this.emit('queue:start', id);
    this.emit('change');
  }

  stop(id, { finished = false } = {}) {
    if (!this.running.has(id)) return;
    this.running.delete(id);
    this.emit('queue:stop', id, { finished });
    this.emit('change');
  }

  isRunning(id) {
    return this.running.has(id);
  }

  /* ---------- download limits ---------- */

  limits() {
    return { enabled: false, mb: 200, hours: 5, warn: true, ...(this.settings.get('downloadLimits') || {}) };
  }

  recordBytes(n) {
    if (!n) return;
    const now = Date.now();
    const last = this.bytesLog[this.bytesLog.length - 1];
    if (last && now - last.t < 10000) last.n += n;
    else this.bytesLog.push({ t: now, n });
    const horizon = now - 48 * 3600 * 1000;
    while (this.bytesLog.length && this.bytesLog[0].t < horizon) this.bytesLog.shift();
  }

  /** Bytes downloaded in the current limit window and when the oldest of them drops out. */
  windowUsage() {
    const L = this.limits();
    const span = Math.max(1, Number(L.hours) || 1) * 3600 * 1000;
    const since = Date.now() - span;
    let used = 0;
    let oldest = null;
    for (const e of this.bytesLog) {
      if (e.t >= since) { used += e.n; if (oldest === null) oldest = e.t; }
    }
    return { used, limit: (Number(L.mb) || 0) * 1024 * 1024, resumeAt: oldest ? oldest + span : null };
  }

  limitReached() {
    const L = this.limits();
    if (!L.enabled) { this.limitHit = false; return false; }
    const { used, limit, resumeAt } = this.windowUsage();
    const hit = used >= limit;
    if (hit !== this.limitHit) {
      this.limitHit = hit;
      this.limitResumeAt = hit ? resumeAt : null;
      this.emit('limit', { hit, resumeAt, used, limit });
    }
    return hit;
  }

  /* ---------- clock ---------- */

  run() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick(), 15000);
    for (const q of this.list()) if (q.schedule.startOnLaunch) this.start(q.id);
    this.tick();
  }

  stopClock() {
    clearInterval(this._timer);
    this._timer = null;
  }

  tick() {
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const dayKey = now.toISOString().slice(0, 10);
    for (const q of this.list()) {
      const s = q.schedule;
      if (s.startEnabled && s.startTime === hhmm) {
        const due = s.mode === 'once' ? s.onceDate === dayKey : (s.days || []).includes(now.getDay());
        const key = 'start:' + q.id + ':' + dayKey;
        if (due && !this.lastFired.has(key)) { this.lastFired.set(key, true); this.start(q.id); }
      }
      if (s.stopEnabled && s.stopTime === hhmm && this.running.has(q.id)) {
        const key = 'stop:' + q.id + ':' + dayKey;
        if (!this.lastFired.has(key)) { this.lastFired.set(key, true); this.stop(q.id); }
      }
    }
    this.limitReached();
    this.emit('tick');
  }

  /** Called by the Queue when a running queue has nothing left to do. */
  queueDrained(id) {
    const q = this.get(id);
    if (!q || !this.running.has(id)) return;
    this.stop(id, { finished: true });
    this.emit('queue:finished', id);
    const action = q.schedule.whenDone;
    if (action && action !== 'none') this.runWhenDone(action, q.schedule.whenDoneFile);
  }

  runWhenDone(action, file) {
    if (action === 'open' && file) {
      this.emit('open-file', file);
      return;
    }
    if (action === 'exit') { this.emit('exit'); return; }
    if (!['shutdown', 'sleep', 'hibernate'].includes(action)) return;
    // 30-second countdown the UI can cancel.
    const at = Date.now() + 30000;
    this._countdown = { action, at };
    this.emit('countdown', { action, at });
    this._countdownTimer = setTimeout(() => {
      if (!this._countdown) return;
      this._countdown = null;
      powerAction(action);
    }, 30000);
  }

  cancelCountdown() {
    if (this._countdownTimer) clearTimeout(this._countdownTimer);
    this._countdown = null;
    this._countdownTimer = null;
    this.emit('countdown', null);
  }

  powerNow() {
    if (!this._countdown) return;
    const a = this._countdown.action;
    this.cancelCountdown();
    powerAction(a);
  }
}

function powerAction(action) {
  if (process.platform !== 'win32') return;
  const opts = { windowsHide: true, stdio: 'ignore', detached: true };
  if (action === 'shutdown') spawn('shutdown.exe', ['/s', '/t', '5'], opts).unref();
  else if (action === 'hibernate') spawn('shutdown.exe', ['/h'], opts).unref();
  else if (action === 'sleep') spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], opts).unref();
}

module.exports = { Scheduler, DEFAULT_QUEUES, defaultSchedule, normalizeQueue };
