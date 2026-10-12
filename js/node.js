// One member of the swarm: the ground station (id 0) or a drone (id 1..N).
// Every node runs the same code. Which layer a drone is in is never set from
// outside — it falls out of what the node has (or hasn't) heard recently:
//
//   Layer 3  fresh PLAN from the coordinator     -> follow it
//   Layer 2  no plan, but peers are audible      -> negotiate with CLAIMs
//   Layer 1  nobody audible                      -> own camera, own choice

import { MSG, messageBytes } from './network.js';
import { buildPlan, peerChoose, soloChoose, engageCost, extrapolate } from './policy.js';
import { gauss, steer, interceptTime } from './util.js';

export class Node {
  constructor(sim, { id, kind, x, y }) {
    this.sim = sim;
    this.id = id;
    this.kind = kind; // 'gs' | 'drone'
    this.name = kind === 'gs' ? 'GS' : 'D' + id;
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.alive = true;
    this.resetMind(sim.time);
  }

  get radio() { return this.kind === 'gs' ? this.sim.cfg.gs.radio : this.sim.cfg.defenders.radio; }
  get sensor() { return this.kind === 'gs' ? this.sim.cfg.gs.sensor : this.sim.cfg.defenders.sensor; }

  resetMind(now) {
    const T = this.sim.cfg.timing, r = this.sim.rng;
    this.bornAt = now;
    this.seq = 0;
    this.heard = new Map();   // nodeId -> newest timestamp heard from it
    this.tracks = new Map();  // enemyId -> { id, x, y, vx, vy, t, own }
    this.dead = new Set();    // enemies reported neutralised
    this.claims = new Map();  // droneId -> { id, target, cost, t }
    this.peers = new Map();   // droneId -> { id, x, y, vx, vy, target, t }
    this.plans = new Map();   // coordinatorId -> { coord, t, assign: Map }
    this.ownPlan = null;
    this.seen = new Map();    // "origin:seq" -> time, to drop duplicate relays
    this.visible = [];
    this.layer = this.kind === 'gs' ? 0 : 1;
    this.target = null;
    this.cost = Infinity;
    this.hasPeers = false;
    this.isCoord = false;
    this.leader = this.id;
    this.yieldLog = new Map();
    this.next = {
      state: now + r() / T.stateHz,
      obs: now + r() / T.obsHz,
      claim: now + r() / T.claimHz,
      plan: now + r() / T.planHz,
      prune: now + 1,
    };
  }

  // ---- sensing --------------------------------------------------------------

  sense(now) {
    const rng = this.sim.rng;
    this.visible.length = 0;
    for (const e of this.sim.enemies) {
      if (!e.alive || Math.hypot(e.x - this.x, e.y - this.y) > this.sensor) continue;
      const o = {
        id: e.id,
        x: e.x + gauss(rng) * 2, y: e.y + gauss(rng) * 2,
        vx: e.vx + gauss(rng), vy: e.vy + gauss(rng),
        t: now, own: true,
      };
      this.tracks.set(e.id, o);
      this.visible.push(o);
      if (e.firstSeen == null) e.firstSeen = now;
    }
  }

  mergeTrack(o) {
    if (this.dead.has(o.id)) return;
    const cur = this.tracks.get(o.id);
    if (!cur || cur.t < o.t) this.tracks.set(o.id, { id: o.id, x: o.x, y: o.y, vx: o.vx, vy: o.vy, t: o.t, own: false });
  }

  // ---- deciding -------------------------------------------------------------

  think(now) {
    const T = this.sim.cfg.timing;
    for (const [id, tr] of this.tracks) if (now - tr.t > T.trackTimeout) this.tracks.delete(id);
    for (const [id, cl] of this.claims) if (now - cl.t > T.contactTimeout) this.claims.delete(id);
    for (const [id, p] of this.peers) if (now - p.t > T.leaderTimeout) this.peers.delete(id);

    // Election is implicit: the coordinator is the lowest ID I have heard from
    // recently (including me). Nobody votes; everyone applies the same rule.
    let hasPeers = false, leader = this.id;
    for (const [id, t] of this.heard) {
      if (now - t < T.contactTimeout) hasPeers = true;
      if (now - t < T.leaderTimeout && id < leader) leader = id;
    }
    this.hasPeers = hasPeers;
    this.leader = leader;
    const listening = this.kind !== 'gs' && now - this.bornAt < T.leaderTimeout;
    const wasCoord = this.isCoord;
    this.isCoord = leader === this.id && !listening && hasPeers;

    if (this.isCoord && !wasCoord) {
      this.sim.onElected(this);
      this.send(MSG.ELECT, {}, now);
      this.next.plan = now;
    } else if (!this.isCoord && wasCoord) {
      this.ownPlan = null;
      this.sim.onSteppedDown(this, leader);
    }

    if (this.isCoord && now >= this.next.plan) {
      this.next.plan = Math.max(this.next.plan + 1 / T.planHz, now - 0.5);
      this.makePlan(now);
    }

    if (this.kind !== 'drone') return;

    const ctx = this.sim.ctx;
    const prev = this.target;
    const plan = this.isCoord ? this.ownPlan : this.plans.get(leader);

    if (plan && now - plan.t < T.planTimeout && plan.assign.has(this.id)) {
      this.layer = 3;
      let tgt = plan.assign.get(this.id);
      if (tgt != null && (!this.tracks.has(tgt) || this.dead.has(tgt))) tgt = null;
      this.target = tgt;
      this.cost = tgt != null ? engageCost(this, this.tracks.get(tgt), now, ctx).cost : Infinity;
    } else if (hasPeers) {
      this.layer = 2;
      const tracks = [];
      for (const tr of this.tracks.values()) if (!this.dead.has(tr.id)) tracks.push(tr);
      const claims = [...this.claims.values()];
      const r = peerChoose(this, tracks, claims, now, ctx);
      if (r.beatenBy && prev != null && r.target !== prev) this.logYield(prev, r.beatenBy, now);
      this.target = r.target;
      this.cost = r.cost;
    } else {
      this.layer = 1;
      const r = soloChoose(this, this.visible, now, ctx);
      this.target = r.target;
      this.cost = r.cost;
    }

    // Act first, reconcile later: announce a new target immediately.
    if (this.target !== prev && this.target != null) {
      this.sendClaim(now);
      this.next.claim = now + 1 / T.claimHz;
    }
  }

  makePlan(now) {
    const T = this.sim.cfg.timing;
    const drones = [];
    if (this.kind === 'drone') drones.push({ id: this.id, x: this.x, y: this.y, target: this.target });
    for (const p of this.peers.values()) {
      if (now - p.t >= T.planTimeout) continue;
      const dt = now - p.t;
      drones.push({ id: p.id, x: p.x + p.vx * dt, y: p.y + p.vy * dt, target: p.target });
    }
    const tracks = [];
    for (const tr of this.tracks.values()) if (!this.dead.has(tr.id)) tracks.push(tr);
    const assign = buildPlan(drones, tracks, now, this.sim.ctx);
    this.ownPlan = { coord: this.id, t: now, assign };
    // Cue the positions of assigned targets so drones that missed an OBS can still chase.
    const used = new Set(assign.values());
    const cues = tracks.filter((tr) => used.has(tr.id)).map(({ id, x, y, vx, vy, t }) => ({ id, x, y, vx, vy, t }));
    this.send(MSG.PLAN, { assign: [...assign.entries()], cues }, now);
  }

  logYield(prev, winner, now) {
    const last = this.yieldLog.get(prev);
    if (last != null && now - last < 2) return;
    this.yieldLog.set(prev, now);
    this.sim.onYield(this, prev, winner);
  }

  // ---- talking --------------------------------------------------------------

  send(type, payload, now, ttl) {
    const msg = {
      type, origin: this.id, seq: ++this.seq, time: now,
      ttl: ttl ?? this.sim.cfg.comms.hops, payload,
    };
    msg.bytes = messageBytes(type, payload);
    this.seen.set(this.id + ':' + msg.seq, now);
    this.sim.net.transmit(this, msg);
  }

  sendClaim(now) {
    const cost = isFinite(this.cost) ? Math.round(this.cost * 100) / 100 : 999;
    // Claims are local negotiations: relay at most 2 hops.
    this.send(MSG.CLAIM, { target: this.target, cost }, now, Math.min(2, this.sim.cfg.comms.hops));
  }

  communicate(now) {
    const T = this.sim.cfg.timing;
    if (now >= this.next.state) {
      this.next.state = Math.max(this.next.state + 1 / T.stateHz, now - 0.5);
      this.send(MSG.STATE, {
        kind: this.kind, x: this.x, y: this.y, vx: this.vx, vy: this.vy,
        target: this.target, layer: this.layer,
      }, now);
    }
    if (now >= this.next.obs) {
      this.next.obs = Math.max(this.next.obs + 1 / T.obsHz, now - 0.5);
      if (this.visible.length) {
        // Share observations, not conclusions: only what my own sensor sees.
        this.send(MSG.OBS, { tracks: this.visible.map(({ id, x, y, vx, vy, t }) => ({ id, x, y, vx, vy, t })) }, now);
      }
    }
    if (this.kind === 'drone' && now >= this.next.claim) {
      this.next.claim = Math.max(this.next.claim + 1 / T.claimHz, now - 0.5);
      if (this.target != null) this.sendClaim(now);
    }
    if (now >= this.next.prune) {
      this.next.prune = now + 1;
      for (const [k, t] of this.seen) if (now - t > 3) this.seen.delete(k);
    }
  }

  receive(msg, fromId, now) {
    // Hearing a relay is still proof the relaying node is alive and in range.
    if (fromId !== this.id && (this.heard.get(fromId) ?? -1) < now) this.heard.set(fromId, now);
    const key = msg.origin + ':' + msg.seq;
    if (this.seen.has(key)) return;
    this.seen.set(key, now);
    if (msg.origin === this.id) return;
    if ((this.heard.get(msg.origin) ?? -1) < msg.time) this.heard.set(msg.origin, msg.time);

    const p = msg.payload;
    switch (msg.type) {
      case MSG.STATE:
        if (p.kind === 'drone') {
          this.peers.set(msg.origin, { id: msg.origin, x: p.x, y: p.y, vx: p.vx, vy: p.vy, target: p.target, t: msg.time });
        }
        break;
      case MSG.OBS:
        for (const o of p.tracks) this.mergeTrack(o);
        break;
      case MSG.CLAIM: {
        const cur = this.claims.get(msg.origin);
        if (!cur || cur.t <= msg.time) {
          this.claims.set(msg.origin, { id: msg.origin, target: p.target, cost: p.cost, t: msg.time });
        }
        break;
      }
      case MSG.RELEASE:
        this.dead.add(p.target);
        this.tracks.delete(p.target);
        for (const [id, c] of this.claims) if (c.target === p.target) this.claims.delete(id);
        break;
      case MSG.PLAN: {
        const cur = this.plans.get(msg.origin);
        if (!cur || cur.t < msg.time) {
          this.plans.set(msg.origin, { coord: msg.origin, t: msg.time, assign: new Map(p.assign) });
          for (const c of p.cues) this.mergeTrack(c);
        }
        break;
      }
      case MSG.ELECT:
        break;
    }
    if (msg.ttl > 1) this.sim.net.transmit(this, { ...msg, ttl: msg.ttl - 1 });
  }

  onTag(enemyId, now) {
    this.dead.add(enemyId);
    this.tracks.delete(enemyId);
    this.target = null;
    this.send(MSG.RELEASE, { target: enemyId, reason: 'tagged' }, now);
  }

  // ---- moving ---------------------------------------------------------------

  move(now, dt) {
    if (this.kind !== 'drone') return;
    const c = this.sim.cfg.defenders;
    let dvx = 0, dvy = 0;
    const tr = this.target != null ? this.tracks.get(this.target) : null;
    if (tr) {
      // Lead pursuit toward the predicted intercept point.
      const e = extrapolate(tr, now);
      let t = interceptTime(this.x, this.y, c.speed, e.x, e.y, e.vx, e.vy);
      if (!isFinite(t)) t = 0;
      t = Math.min(t, 4);
      const ax = e.x + e.vx * t - this.x, ay = e.y + e.vy * t - this.y;
      const d = Math.hypot(ax, ay) || 1;
      dvx = (ax / d) * c.speed; dvy = (ay / d) * c.speed;
    } else {
      const s = this.sim.patrolSlot(this.id, now);
      const ax = s.x - this.x, ay = s.y - this.y;
      const d = Math.hypot(ax, ay);
      const sp = Math.min(c.speed * 0.6, d * 1.2);
      if (d > 0.01) { dvx = (ax / d) * sp; dvy = (ay / d) * sp; }
    }
    steer(this, dvx, dvy, c.accel, c.speed, dt);
  }
}
