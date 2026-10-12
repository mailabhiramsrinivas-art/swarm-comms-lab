// The world: enemies, physics, contacts, scripted events and metrics.
// No DOM access here, so the simulation can also run headless (see test/).

import { PRESETS } from './config.js';
import { Network, MSG } from './network.js';
import { Node } from './node.js';
import { mulberry32, steer } from './util.js';

const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
function compass(a) {
  const i = Math.round(((a % (2 * Math.PI)) + 2 * Math.PI) / (Math.PI / 4)) % 8;
  return COMPASS[i];
}

export class Sim {
  constructor(cfg, presetKey) {
    this.reset(cfg, presetKey);
  }

  reset(cfg, presetKey) {
    this.cfg = cfg;
    this.presetKey = presetKey || null;
    this.rng = mulberry32(cfg.seed);
    this.time = 0;
    this.nodes = [];
    this.enemies = [];
    this.effects = [];
    this.logs = [];
    this.logCount = 0;
    this._logSeen = new Map();
    this.net = new Network(this);
    this.stats = { intercepted: 0, breaches: 0, responseSum: 0, responseN: 0, yields: 0, elections: 0 };
    this.nextEnemyId = 1;
    this.wave = 0;
    this.nextWave = 2;
    this.events = presetKey && PRESETS[presetKey] ? PRESETS[presetKey].events.map((e) => ({ ...e })) : [];
    if (this.events.some((e) => e.action === 'waveFrom')) this.nextWave = cfg.enemies.waveInterval;
    this.updateCtx();

    const gs = new Node(this, { id: 0, kind: 'gs', x: cfg.gs.x, y: cfg.gs.y });
    gs.alive = cfg.gs.enabled;
    this.nodes.push(gs);
    for (let i = 1; i <= cfg.defenders.count; i++) {
      const s = this.patrolSlot(i, 0);
      this.nodes.push(new Node(this, { id: i, kind: 'drone', x: s.x, y: s.y }));
    }
    this.partitions = this.countPartitions();
    this.nextPartitionCheck = 0.5;
    this.log('info', `Reset: ${cfg.defenders.count} drones${cfg.gs.enabled ? ' + ground station' : ''}`);
  }

  updateCtx() {
    const c = this.cfg;
    this.ctx = {
      speed: c.defenders.speed,
      asset: c.asset,
      urgency: c.policy.urgency,
      hysteresis: c.policy.hysteresis,
      maxPerTarget: c.policy.maxPerTarget,
    };
  }

  node(id) { return this.nodes.find((n) => n.id === id); }
  get drones() { return this.nodes.filter((n) => n.kind === 'drone'); }

  patrolSlot(id, t) {
    const c = this.cfg, n = c.defenders.count;
    const a = (2 * Math.PI * (id - 1)) / n + t * 0.04 - Math.PI / 2;
    return { x: c.asset.x + Math.cos(a) * c.defenders.patrolRadius, y: c.asset.y + Math.sin(a) * c.defenders.patrolRadius };
  }

  // ---- main step ------------------------------------------------------------

  step(dt) {
    this.time += dt;
    const now = this.time;
    this.updateCtx();

    for (const ev of this.events) {
      if (!ev.done && now >= ev.t) { ev.done = true; this.runEvent(ev); }
    }
    if (this.cfg.enemies.autoWaves && now >= this.nextWave) this.spawnWave();

    for (const e of this.enemies) if (e.alive) this.moveEnemy(e, now, dt);
    for (const n of this.nodes) if (n.alive) n.move(now, dt);
    this.checkContacts(now);

    this.net.step(now, dt);
    for (const n of this.nodes) if (n.alive) n.sense(now);
    for (const n of this.nodes) if (n.alive) n.think(now);
    for (const n of this.nodes) if (n.alive) n.communicate(now);

    this.trackEngagement(now);
    this.net.decayHeat(dt);
    this.enemies = this.enemies.filter((e) => e.alive);
    this.effects = this.effects.filter((f) => now - f.t < f.life);

    if (now >= this.nextPartitionCheck) {
      this.nextPartitionCheck = now + 0.5;
      const p = this.countPartitions();
      if (p !== this.partitions) {
        this.log('net', p > 1 ? `Network split into ${p} groups` : 'Network rejoined into 1 group');
        this.partitions = p;
      }
    }
  }

  runEvent(ev) {
    if (ev.action === 'killCoordinator') this.killCoordinator();
    else if (ev.action === 'waveFrom') this.spawnWave(ev.angle);
  }

  // ---- enemies --------------------------------------------------------------

  spawnWave(angle) {
    const c = this.cfg.enemies, A = this.cfg.asset, rng = this.rng, now = this.time;
    const center = angle ?? rng() * 2 * Math.PI;
    this.wave++;
    for (let i = 0; i < c.perWave; i++) {
      const a = center + (rng() - 0.5) * 1.2;
      const r = 450 + rng() * 30;
      const behavior = c.behavior === 'mixed' ? ['direct', 'weave', 'evade'][Math.floor(rng() * 3)] : c.behavior;
      this.enemies.push({
        id: this.nextEnemyId++,
        x: A.x + Math.cos(a) * r, y: A.y + Math.sin(a) * r,
        vx: 0, vy: 0, alive: true, behavior,
        phase: rng() * Math.PI * 2, born: now, firstSeen: null, firstEngaged: null,
      });
    }
    this.nextWave = now + c.waveInterval;
    this.log('wave', `Wave ${this.wave}: ${c.perWave} enemies from the ${compass(center)}`);
  }

  moveEnemy(e, now, dt) {
    const c = this.cfg.enemies, A = this.cfg.asset;
    let ux = A.x - e.x, uy = A.y - e.y;
    const d = Math.hypot(ux, uy) || 1;
    ux /= d; uy /= d;
    let dx = ux, dy = uy;
    if (e.behavior === 'weave') {
      const s = Math.sin(now * 1.7 + e.phase) * 0.9;
      dx += -uy * s; dy += ux * s;
    } else if (e.behavior === 'evade') {
      let best = null, bd = 80;
      for (const n of this.nodes) {
        if (!n.alive || n.kind !== 'drone') continue;
        const nd = Math.hypot(n.x - e.x, n.y - e.y);
        if (nd < bd) { bd = nd; best = n; }
      }
      if (best) {
        dx += ((e.x - best.x) / bd) * 1.3;
        dy += ((e.y - best.y) / bd) * 1.3;
      }
    }
    const m = Math.hypot(dx, dy) || 1;
    steer(e, (dx / m) * c.speed, (dy / m) * c.speed, c.accel, c.speed, dt);
  }

  checkContacts(now) {
    const A = this.cfg.asset, tagR = this.cfg.defenders.tagRadius;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (Math.hypot(e.x - A.x, e.y - A.y) < A.r) {
        e.alive = false;
        this.stats.breaches++;
        this.effects.push({ kind: 'breach', x: e.x, y: e.y, t: now, life: 0.8 });
        this.log('breach', `E${e.id} reached the asset`);
        continue;
      }
      for (const n of this.nodes) {
        if (!n.alive || n.kind !== 'drone') continue;
        if (Math.hypot(n.x - e.x, n.y - e.y) < tagR) {
          e.alive = false;
          this.stats.intercepted++;
          this.effects.push({ kind: 'tag', x: e.x, y: e.y, t: now, life: 0.7 });
          this.log('tag', `${n.name} intercepted E${e.id}`);
          n.onTag(e.id, now);
          break;
        }
      }
    }
  }

  trackEngagement(now) {
    for (const e of this.enemies) {
      if (!e.alive || e.firstSeen == null || e.firstEngaged != null) continue;
      if (this.nodes.some((n) => n.alive && n.kind === 'drone' && n.target === e.id)) {
        e.firstEngaged = now;
        this.stats.responseSum += now - e.firstSeen;
        this.stats.responseN++;
      }
    }
  }

  // ---- swarm events (called by nodes and the UI) ----------------------------

  onElected(n) {
    this.stats.elections++;
    this.log('coord', `${n.name} is now coordinator`);
  }

  onSteppedDown(n, leader) {
    const l = this.node(leader);
    if (leader < n.id && l) this.log('coord', `${n.name} steps down: hears ${l.name}`);
    else this.log('coord', `${n.name} stops coordinating: no peers in range`);
  }

  onYield(n, target, winner) {
    this.stats.yields++;
    const w = this.node(winner.id);
    this.log('claim', `${n.name} yields E${target} to ${w ? w.name : 'D' + winner.id} (cost ${winner.cost.toFixed(1)} < ${n.name}'s)`);
  }

  destroyNode(id) {
    const n = this.node(id);
    if (!n || !n.alive) return;
    const wasCoord = n.isCoord;
    n.alive = false;
    n.isCoord = false;
    n.target = null;
    this.effects.push({ kind: 'lost', x: n.x, y: n.y, t: this.time, life: 1.2 });
    this.log('lost', `${n.name} destroyed${wasCoord ? ' (was coordinator)' : ''}`);
  }

  killCoordinator() {
    const coords = this.nodes.filter((n) => n.alive && n.isCoord).sort((a, b) => a.id - b.id);
    if (!coords.length) { this.log('info', 'No coordinator to remove'); return; }
    this.destroyNode(coords[0].id);
  }

  respawnLost() {
    let k = 0;
    for (const n of this.nodes) {
      if (n.alive) continue;
      if (n.kind === 'gs' && !this.cfg.gs.enabled) continue;
      const p = n.kind === 'gs' ? { x: this.cfg.gs.x, y: this.cfg.gs.y } : this.patrolSlot(n.id, this.time);
      n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
      n.alive = true;
      n.resetMind(this.time);
      k++;
    }
    this.log('info', k ? `Respawned ${k} node${k > 1 ? 's' : ''}` : 'Nothing to respawn');
  }

  // ---- metrics --------------------------------------------------------------

  countPartitions() {
    const alive = this.nodes.filter((n) => n.alive);
    const seen = new Set();
    let groups = 0;
    for (const s of alive) {
      if (seen.has(s)) continue;
      groups++;
      const stack = [s];
      seen.add(s);
      while (stack.length) {
        const a = stack.pop();
        for (const b of alive) {
          if (!seen.has(b) && this.net.linked(a, b)) { seen.add(b); stack.push(b); }
        }
      }
    }
    return groups;
  }

  metrics() {
    const drones = this.drones.filter((n) => n.alive);
    const layers = { 3: 0, 2: 0, 1: 0 };
    for (const d of drones) layers[d.layer]++;
    const chasing = new Map();
    for (const d of drones) if (d.target != null) chasing.set(d.target, (chasing.get(d.target) || 0) + 1);
    let over = 0;
    for (const v of chasing.values()) if (v > this.cfg.policy.maxPerTarget) over++;
    const msgRate = Object.values(this.net.rate).reduce((a, b) => a + b, 0);
    return {
      time: this.time,
      intercepted: this.stats.intercepted,
      breaches: this.stats.breaches,
      active: this.enemies.length,
      layers,
      alive: drones.length,
      coordinators: this.nodes.filter((n) => n.alive && n.isCoord).map((n) => n.name),
      partitions: this.partitions,
      msgRate,
      byteRate: this.net.byteRate,
      rate: { ...this.net.rate },
      avgResponse: this.stats.responseN ? this.stats.responseSum / this.stats.responseN : null,
      overAssigned: over,
      yields: this.stats.yields,
      elections: this.stats.elections,
    };
  }

  log(type, text) {
    const last = this._logSeen.get(text);
    if (last != null && this.time - last < 1.5) return;
    this._logSeen.set(text, this.time);
    this.logs.push({ t: this.time, type, text, n: ++this.logCount });
    if (this.logs.length > 300) this.logs.shift();
  }
}

export { MSG };
