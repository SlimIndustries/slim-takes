'use strict';
// A small traffic light for the page window: at most `total` pages at once, and sites that are
// strict (Cloudflare) one page at a time.

class Lanes {
  constructor(total = 2) {
    this.total = total;
    this.active = 0;
    this.byKey = new Map(); // key -> pages open for that site
    this.waiting = [];
  }

  /** Wait for a turn. `solo`: this site gets one page at a time. Returns a release function. */
  acquire(key, solo = false) {
    return new Promise((resolve) => {
      this.waiting.push({ key, solo, resolve });
      this.next();
    });
  }

  next() {
    for (let i = 0; i < this.waiting.length && this.active < this.total; i++) {
      const w = this.waiting[i];
      const mine = this.byKey.get(w.key) || 0;
      if (w.solo && mine > 0) continue;
      this.waiting.splice(i, 1);
      i--;
      this.active++;
      this.byKey.set(w.key, mine + 1);
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        const n = (this.byKey.get(w.key) || 1) - 1;
        if (n) this.byKey.set(w.key, n); else this.byKey.delete(w.key);
        this.next();
      });
    }
  }
}

module.exports = { Lanes };
