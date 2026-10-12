// Radio model: broadcast to every node in range, per-link loss and latency,
// an optional interference zone, and TTL-limited relaying (flooding).

export const MSG = {
  STATE: 'STATE',
  OBS: 'OBS',
  CLAIM: 'CLAIM',
  RELEASE: 'RELEASE',
  PLAN: 'PLAN',
  ELECT: 'ELECT',
};

// Approximate on-air size in bytes, assuming a compact binary encoding.
// Header: type 1 + origin 1 + seq 2 + timestamp 4 + ttl 1 = 9 bytes.
export function messageBytes(type, p) {
  switch (type) {
    case MSG.STATE: return 9 + 8;
    case MSG.OBS: return 10 + 7 * p.tracks.length;
    case MSG.CLAIM: return 9 + 3;
    case MSG.RELEASE: return 9 + 2;
    case MSG.PLAN: return 10 + 2 * p.assign.length + 7 * p.cues.length;
    case MSG.ELECT: return 9;
    default: return 9;
  }
}

export class Network {
  constructor(sim) {
    this.sim = sim;
    this.queue = [];
    this.rate = {};       // type -> transmissions/s (moving average)
    this.byteRate = 0;
    this.linkHeat = new Map(); // "a-b" -> recent traffic, for drawing
    this.sent = 0;
    this.dropped = 0;
    for (const t of Object.values(MSG)) this.rate[t] = 0;
    this._pending = {};
    this._pendingBytes = 0;
  }

  linked(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y) <= (a.radio + b.radio) / 2;
  }

  inZone(n) {
    const z = this.sim.cfg.comms.zone;
    return z.on && Math.hypot(n.x - z.x, n.y - z.y) <= z.r;
  }

  lossBetween(a, b) {
    const c = this.sim.cfg.comms;
    let keep = 1 - c.loss;
    if (this.inZone(a) || this.inZone(b)) keep *= 1 - c.zone.strength;
    return 1 - keep;
  }

  // One transmission from `from`. Every node in range may hear it.
  transmit(from, msg) {
    const sim = this.sim, rng = sim.rng;
    const lat = sim.cfg.comms.latencyMs / 1000;
    this._pending[msg.type] = (this._pending[msg.type] || 0) + 1;
    this._pendingBytes += msg.bytes;
    this.sent++;
    for (const n of sim.nodes) {
      if (n === from || !n.alive || !this.linked(from, n)) continue;
      const key = from.id < n.id ? from.id + '-' + n.id : n.id + '-' + from.id;
      this.linkHeat.set(key, (this.linkHeat.get(key) || 0) + 1);
      if (rng() < this.lossBetween(from, n)) { this.dropped++; continue; }
      this.queue.push({ to: n, from: from.id, msg, at: sim.time + lat * (1 + 0.5 * rng()) });
    }
  }

  step(now, dt) {
    if (this.queue.length) {
      const due = [], rest = [];
      for (const q of this.queue) (q.at <= now ? due : rest).push(q);
      this.queue = rest;
      due.sort((a, b) => a.at - b.at);
      for (const q of due) if (q.to.alive) q.to.receive(q.msg, q.from, now);
    }
    // Exponential moving averages (~1 s window) for the stats panel.
    const k = Math.exp(-dt / 1.0);
    for (const t of Object.keys(this.rate)) {
      this.rate[t] = this.rate[t] * k + ((this._pending[t] || 0) / dt) * (1 - k);
    }
    this.byteRate = this.byteRate * k + (this._pendingBytes / dt) * (1 - k);
    this._pending = {};
    this._pendingBytes = 0;
  }

  decayHeat(dt) {
    const k = Math.exp(-dt / 0.35);
    for (const [key, v] of this.linkHeat) {
      const nv = v * k;
      if (nv < 0.01) this.linkHeat.delete(key); else this.linkHeat.set(key, nv);
    }
  }
}
