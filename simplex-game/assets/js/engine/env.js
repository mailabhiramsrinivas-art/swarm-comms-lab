// The game (sim/env.py): simultaneous moves, the referee's reading at attack time, hits and eliminations.

import { dist } from "./geom.js";
import { nerve } from "./match.js";
import { evasionMoves } from "./agents.js";
import { CONFIG_DEFAULT } from "./referee.js";

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const pos4 = (P) => P.map((p) => [r4(p[0]), r4(p[1]), r4(p[2])]);

export function clipRows(V, vmax) {
  return V.map((v) => {
    const n = Math.hypot(v[0], v[1], v[2]);
    return n > vmax ? v.map((x) => x * (vmax / n)) : v.slice();
  });
}

function frameOf(tick, phase, O, alive, D, rd, nerveS, cfg, extra = {}) {
  return {
    tick, phase,
    O: pos4(O), alive: alive.slice(),
    exposed: O.map((_, i) => (alive[i] && rd && rd.exposed.has(i) ? rd.exposed.get(i) : null)),
    D: pos4(D),
    tets: rd ? rd.tets : [], tris: rd ? rd.tris : [],
    edges: rd ? rd.edges.map(([a, b]) => [a, b, dist(O[a], O[b]) < cfg.support_length ? 1 : 0]) : [],
    hull: rd ? rd.hull_vertices : [], facets: rd ? rd.hull_facets : [],
    dim: rd ? rd.dim : -1, mode: rd ? rd.mode : null, perturbed: rd ? !!rd.perturbed : false,
    nerve: nerveS, ...extra,
  };
}

export class SimplexEnv {
  constructor(cfg = CONFIG_DEFAULT, referee) {
    this.cfg = cfg;
    this.referee = referee;
  }
  reset(Oinit, Dinit, w) {
    this.O = Oinit.map((p) => p.slice());
    this.m = this.O.length;
    this.D = Dinit.map((p) => p.slice());
    this.n = this.D.length;
    this.w = w;
    this.alive = new Array(this.m).fill(true);
    this.tick = 0;
    this.done = false;
    this.outcome = null;
    this.lastD = this.D.map(() => [0, 0, 0]);
    this.lastO = this.O.map(() => [0, 0, 0]);
    this.stats = { eliminated: 0, wasted: 0, blocked: 0, blocked_misread: 0, hits: 0, attack_shielded: [], attack_alive: [] };
    const rd0 = this.referee.read(this.O, this.alive);
    this.frames = [frameOf(0, "placement", this.O, this.alive, this.D, rd0, this._nerve(rd0, null), this.cfg)];
    return this.obsBefore();
  }
  _nerve(rd, dReading) {
    const perceived = dReading && dReading.exposed ? new Set(dReading.exposed) : new Set(rd ? rd.exposed_ids : []);
    const subset = this.alive.map((a, i) => a && perceived.has(i));
    return nerve(this.D, this.O, subset, this.cfg.r);
  }
  obsBefore() {
    return { tick: this.tick + 1, phase: "before_move", O: this.O.map((p) => p.slice()), alive: this.alive.slice(), D: this.D.map((p) => p.slice()),
      lastD: this.lastD.map((p) => p.slice()), lastO: this.lastO.map((p) => p.slice()) };
  }
  reachLists() {
    return this.D.map((d) => { const out = []; this.O.forEach((o, i) => { if (this.alive[i] && dist(d, o) <= this.cfg.r) out.push(i); }); return out; });
  }
  move(dMoves) {
    const dm = this.n ? clipRows(dMoves, this.cfg.v_D) : [];
    let om = this.cfg.v_O > 0 ? clipRows(evasionMoves(this.O, this.alive, this.D, this.w, this.cfg.v_O, this.cfg.cohesion_length, this.cfg), this.cfg.v_O) : this.O.map(() => [0, 0, 0]);
    om = om.map((v, i) => (this.alive[i] ? v : [0, 0, 0]));
    this.O = this.O.map((p, i) => [p[0] + om[i][0], p[1] + om[i][1], p[2] + om[i][2]]);
    this.D = this.D.map((p, j) => [p[0] + dm[j][0], p[1] + dm[j][1], p[2] + dm[j][2]]);
    this.lastD = dm; this.lastO = om;
    this.tick++;
    this.readingAttack = this.referee.read(this.O, this.alive);
    this.stats.attack_shielded.push(this.readingAttack.shielded_ids.length);
    this.stats.attack_alive.push(this.readingAttack.ids.length);
    return { ...this.obsBefore(), tick: this.tick, phase: "after_move", reach: this.reachLists() };
  }
  attack(targets, dReading) {
    const reach = this.reachLists();
    const rd = this.readingAttack;
    const perceived = dReading && dReading.exposed ? new Set(dReading.exposed) : null;
    const hits = [], toKill = new Set(), claimed = new Set();
    targets.forEach((o, j) => {
      if (o === null || o === undefined) return;
      if (!reach[j].includes(o)) throw new Error(`D${j} targeted O${o}, not in reach`);
      this.stats.hits++;
      let res;
      if (!rd.exposed.get(o)) { res = "blocked"; this.stats.blocked++; if (perceived && perceived.has(o)) this.stats.blocked_misread++; }
      else if (claimed.has(o)) { res = "wasted"; this.stats.wasted++; }
      else { res = "eliminated"; claimed.add(o); toKill.add(o); }
      hits.push({ d: j, o, result: res });
    });
    const nerveAttack = this._nerve(rd, dReading);
    const aliveBefore = this.alive.slice();
    for (const o of toKill) this.alive[o] = false;
    this.stats.eliminated += toKill.size;
    this.frames.push(frameOf(this.tick, "after_move", this.O, aliveBefore, this.D, rd, nerveAttack, this.cfg, {
      hits, d_reading: dReading ? { exposed: dReading.exposed, tets: dReading.tets } : null, d_moves: pos4(this.lastD), o_moves: pos4(this.lastO),
    }));
    const any = this.alive.some((a) => a);
    const rp = any ? this.referee.read(this.O, this.alive) : null;
    this.frames.push(frameOf(this.tick, "after_attack", this.O, this.alive, this.D, rp, rp ? this._nerve(rp, null) : [], this.cfg));
    if (!any) { this.done = true; this.outcome = "win"; }
    else if (this.tick >= this.cfg.deadline) { this.done = true; this.outcome = "loss"; }
    return { hits, eliminated: [...toKill].sort((a, b) => a - b), done: this.done, outcome: this.outcome };
  }
}

/** Play one game. agent: LearnedD / KMeansGreedy. Returns {outcome, n, ticks, frames, stats, trace}. */
export function runEpisode(env, agent, O, n, w, Dinit = null, onTick = null) {
  agent.reset();
  const D0 = Dinit || agent.place(O, n);
  let obs = env.reset(O, D0, w);
  while (!env.done) {
    const mv = agent.move(obs);
    const obs2 = env.move(mv);
    const tg = agent.target(obs2);
    env.attack(tg, agent.readingForLog());
    if (onTick) onTick(env.tick);
    obs = env.obsBefore();
  }
  return {
    outcome: env.outcome, n, ticks: env.outcome === "win" ? env.tick : null, frames: env.frames, stats: env.stats,
    alive_left: env.alive.filter((a) => a).length, trace: agent.trace || [],
  };
}
