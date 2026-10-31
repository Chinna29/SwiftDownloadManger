'use strict';

/** Token-bucket speed limiter shared by all segments of all downloads. rate = bytes/sec, 0 = unlimited. */
class SpeedLimiter {
  constructor(rate = 0) {
    this.setRate(rate);
  }

  setRate(rate) {
    this.rate = Math.max(0, Number(rate) || 0);
    this.tokens = 0;
    this.last = Date.now();
  }

  async take(bytes) {
    if (this.rate <= 0) return;
    for (;;) {
      const now = Date.now();
      const elapsed = (now - this.last) / 1000;
      this.last = now;
      this.tokens = Math.min(this.rate, this.tokens + elapsed * this.rate);
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const waitMs = Math.ceil(((bytes - this.tokens) / this.rate) * 1000);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 1000)));
    }
  }
}

module.exports = { SpeedLimiter };
