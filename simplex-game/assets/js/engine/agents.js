// D agents: the learned D (learn/agent.py + learn/tick_policy/agent.py, reading with the triangulation agent
// as in the final evaluation) and the k-means baseline (planner/baselines.py), plus O's evasion rule.

import { dist, svd3 } from "./geom.js";
import { readingFrom, flatReading, isFlat, triangulationCoords, Referee, DelaunayReader, aliveDelaunayEdges, CONFIG_DEFAULT } from "./referee.js";
import { agentTriangulate, buildTickGraph, buildPGraph, greedySelect } from "./models.js";
import { nerve, components, linearSumAssignment } from "./match.js";
import { PCG64 } from "./rng.js";
import { delaunay3, tetOf } from "./geom.js";

// ------------------------------------------------------------------ D's own reading: the triangulation agent
export class TriAgentReader {
  constructor(policy, cfg = CONFIG_DEFAULT) {
    this.policy = policy;
    this.cfg = cfg;
    this.cache = new Map();
    this.fallback = new Referee(cfg, { stepsPerTet: 1 });
    this.runs = new Map();   // key -> agent run (flip history) for the viewer
  }
  key(ids, X) { return ids.join(",") + "|" + X.map((p) => p.join(",")).join(";"); }
  read(Xall, alive) {
    const ids = []; for (let i = 0; i < Xall.length; i++) if (alive[i]) ids.push(i);
    const X = ids.map((i) => Xall[i]);
    const key = this.key(ids, X);
    if (this.cache.has(key)) return this.cache.get(key);
    let rd;
    if (ids.length < 4) rd = this.fallback.read(Xall, alive);
    else if (isFlat(X, this.cfg)) rd = flatReading(ids, X, this.cfg);
    else {
      let P = X, perturbed = false;
      if (!delaunay3(X).ok) { ({ P, perturbed } = triangulationCoords(X, this.cfg, "tri_agent")); }
      const run = agentTriangulate(this.policy, P);
      const d = delaunay3(P);
      rd = readingFrom(ids, X, run.tets, d.hull.vertices, d.hull.facets, this.cfg.support_length, "tri_agent");
      rd.perturbed = perturbed;
      rd.agent = { T0: run.T0, T: run.T, steps: run.history.length, budget: run.budget };
      this.runs.set(key, { ids, run });
    }
    this.cache.set(key, rd);
    return rd;
  }
  runFor(Xall, alive) {
    const ids = []; for (let i = 0; i < Xall.length; i++) if (alive[i]) ids.push(i);
    return this.runs.get(this.key(ids, ids.map((i) => Xall[i])));
  }
}

function tetsOf(reading, O, alive) {
  if (reading.solved && reading.tets.length) return reading.tets.map((t) => t.slice());
  const ids = []; for (let i = 0; i < O.length; i++) if (alive[i]) ids.push(i);
  if (ids.length < 4) return [];
  const d = delaunay3(ids.map((i) => O[i]));
  if (!d.ok) return [];
  return d.tets.map(tetOf).map((t) => t.map((v) => ids[v]).sort((a, b) => a - b));
}

const zeros = (k) => Array.from({ length: k }, () => [0, 0, 0]);

// ------------------------------------------------------------------ the learned D
export class LearnedD {
  /** nets: {tick, place, team, tri}; opts.targetFix: pass the real last moves at the target stage (off = as evaluated) */
  constructor(nets, cfg = CONFIG_DEFAULT, opts = {}) {
    this.name = "learned";
    this.nets = nets;
    this.cfg = cfg;
    this.reader = new TriAgentReader(nets.tri, cfg);
    this.targetFix = !!opts.targetFix;
    this.trace = [];
  }
  reset() { this.trace = []; this._last = null; }

  pgraph(O) {
    const alive = O.map(() => true);
    const rd = this.reader.read(O, alive);
    return { g: buildPGraph(O, tetsOf(rd, O, alive), this.cfg), rd };
  }
  winProbs(O) { return this.nets.team.probs(this.pgraph(O).g); }
  lowerBound(m) { return Math.max(1, Math.ceil(m / this.cfg.deadline)); }
  chooseN(O) {
    const m = O.length;
    const p = this.winProbs(O);
    for (let n = this.lowerBound(m); n <= Math.min(m, p.length); n++) if (p[n - 1] >= this.cfg.win_threshold) return n;
    return null;
  }
  placeDetail(O, n) {
    const { g } = this.pgraph(O);
    const s = this.nets.place.scores(g, n);
    const sel = greedySelect(s, g.cover, n, this.nets.place.beta);
    return { g, scores: s, ...sel, positions: sel.chosen.map((k) => g.candPos[k].slice()) };
  }
  place(O, n) { return this.placeDetail(O, n).positions; }

  move(obs) {
    const rd = this.reader.read(obs.O, obs.alive);
    const g = buildTickGraph(obs.O, obs.alive, obs.D, obs.lastD, obs.lastO, rd.exposed_ids, rd.solved ? rd.tets : null, "move", this.cfg);
    this.nets.tick.vD = this.cfg.v_D;
    return this.nets.tick.move(g);
  }

  target(obs) {
    const rd = this.reader.read(obs.O, obs.alive);
    this._last = rd;
    const k = obs.D.length;
    const lastD = this.targetFix ? obs.lastD : zeros(k);
    const lastO = this.targetFix ? obs.lastO : zeros(obs.O.length);
    const g = buildTickGraph(obs.O, obs.alive, obs.D, lastD, lastO, rd.exposed_ids, rd.solved ? rd.tets : null, "target", this.cfg);
    const out = new Array(k).fill(null);
    const tr = { tick: obs.tick, pairs: [], none: [], comps: [] };
    this.trace.push(tr);
    if (!g.pairD.length) return out;
    const { sPair, sNone } = this.nets.tick.targets(g);
    tr.pairs = g.pairDl.map((j, p) => ({ d: j, o: g.pairId[p], score: sPair[p] }));
    tr.none = sNone;
    const ex = new Set(rd.exposed_ids);
    const subset = obs.alive.map((a, i) => a && ex.has(i));
    const N = nerve(obs.D, obs.O, subset, this.cfg.r);
    for (const comp of components(N, k)) {
      const ps = []; for (let p = 0; p < sPair.length; p++) if (comp.includes(g.pairDl[p])) ps.push(p);
      if (!ps.length) continue;
      const os = [...new Set(ps.map((p) => g.pairId[p]))].sort((a, b) => a - b);
      const C = comp.map(() => new Array(os.length + comp.length).fill(1e6));
      for (const p of ps) C[comp.indexOf(g.pairDl[p])][os.indexOf(g.pairId[p])] = -sPair[p];
      comp.forEach((j, a) => { C[a][os.length + a] = -sNone[j]; });
      const [rows, cols] = linearSumAssignment(C);
      rows.forEach((a, q) => { const c = cols[q]; if (c < os.length && C[a][c] < 1e5) out[comp[a]] = os[c]; });
      tr.comps.push({ d: comp, o: os });
    }
    tr.chosen = out.slice();
    return out;
  }
  readingForLog() {
    const rd = this._last;
    if (!rd) return null;
    return { tets: rd.tets, exposed: rd.exposed_ids, mode: rd.mode };
  }
}

// ------------------------------------------------------------------ k-means baseline (plain Delaunay reading)
function kmeans(O, k, rng, nInit = 10, iters = 100) {
  let best = null, bestInertia = Infinity;
  const m = O.length;
  for (let run = 0; run < nInit; run++) {
    // k-means++ seeding
    const C = [O[rng.intBelow(m)].slice()];
    while (C.length < k) {
      const d2 = O.map((p) => Math.min(...C.map((c) => dist(p, c) ** 2)));
      const tot = d2.reduce((a, b) => a + b, 0);
      let u = rng.random() * tot, idx = 0;
      for (; idx < m - 1; idx++) { u -= d2[idx]; if (u <= 0) break; }
      C.push(O[idx].slice());
    }
    let lab = new Array(m).fill(0);
    for (let it = 0; it < iters; it++) {
      const nl = O.map((p) => { let bj = 0, bd = Infinity; C.forEach((c, j) => { const d = dist(p, c); if (d < bd) { bd = d; bj = j; } }); return bj; });
      const same = nl.every((v, i) => v === lab[i]) && it > 0;
      lab = nl;
      for (let j = 0; j < k; j++) {
        const pts = O.filter((_, i) => lab[i] === j);
        if (pts.length) C[j] = [0, 1, 2].map((c) => pts.reduce((s, p) => s + p[c], 0) / pts.length);
      }
      if (same) break;
    }
    const inertia = O.reduce((s, p, i) => s + dist(p, C[lab[i]]) ** 2, 0);
    if (inertia < bestInertia) { bestInertia = inertia; best = C.map((c) => c.slice()); }
  }
  return best;
}

const stepToward = (src, dst, vmax) => {
  const v = [dst[0] - src[0], dst[1] - src[1], dst[2] - src[2]];
  const d = Math.hypot(v[0], v[1], v[2]);
  if (d <= vmax) return v;
  return v.map((x) => x * (vmax / d));
};

export class KMeansGreedy {
  constructor(cfg = CONFIG_DEFAULT, seed = 0) { this.name = "kmeans_greedy"; this.cfg = cfg; this.reader = new DelaunayReader(cfg); this.rng = new PCG64(seed); this.trace = []; }
  reset() { this._last = null; }
  chooseN(O) { return Math.max(1, Math.ceil(O.length / this.cfg.deadline)); }
  place(O, n) {
    const k = Math.min(n, O.length);
    let C = kmeans(O, k, this.rng);
    while (C.length < n) { const p = O[this.rng.intBelow(O.length)]; C.push([p[0] + this.rng.normal() * 0.1, p[1] + this.rng.normal() * 0.1, p[2] + this.rng.normal() * 0.1]); }
    return C;
  }
  move(obs) {
    const rd = this.reader.read(obs.O, obs.alive);
    let exp = rd.exposed_ids; if (!exp.length) exp = rd.ids;
    const out = obs.D.map(() => [0, 0, 0]);
    if (!exp.length) return out;
    const cost = obs.D.map((d) => exp.map((i) => dist(d, obs.O[i])));
    const [rows, cols] = linearSumAssignment(cost);
    const assigned = new Map(rows.map((r, q) => [r, cols[q]]));
    obs.D.forEach((d, j) => {
      let tgt;
      if (assigned.has(j)) tgt = obs.O[exp[assigned.get(j)]];
      else { let bi = exp[0], bd = Infinity; for (const i of exp) { const v = dist(obs.O[i], d); if (v < bd) { bd = v; bi = i; } } tgt = obs.O[bi]; }
      out[j] = stepToward(d, tgt, this.cfg.v_D);
    });
    return out;
  }
  target(obs) {
    const rd = this.reader.read(obs.O, obs.alive);
    this._last = rd;
    const cand = [...new Set(obs.reach.flatMap((r) => r.filter((i) => rd.exposed.get(i))))].sort((a, b) => a - b);
    const out = new Array(obs.D.length).fill(null);
    if (!cand.length) return out;
    const BIG = 1e6;
    const cost = obs.D.map((d, j) => cand.map((i) => (obs.reach[j].includes(i) ? dist(obs.O[i], d) : BIG)));
    const [rows, cols] = linearSumAssignment(cost);
    rows.forEach((j, q) => { const c = cols[q]; if (cost[j][c] < BIG) out[j] = cand[c]; });
    return out;
  }
  readingForLog() { const rd = this._last; return rd ? { tets: rd.tets, exposed: rd.exposed_ids, mode: rd.mode } : null; }
}

// ------------------------------------------------------------------ O's rule R1 (sim/o_policies.py)
export function evasionMoves(O, alive, D, w, vO, cohesionLength, cfg = CONFIG_DEFAULT) {
  const out = O.map(() => [0, 0, 0]);
  const ids = []; for (let i = 0; i < O.length; i++) if (alive[i]) ids.push(i);
  if (!ids.length || vO === 0) return out;
  const edges = aliveDelaunayEdges(O, alive, cfg);
  const P = ids.map((i) => O[i]);
  const f = P.map((p) => {
    if (!D.length) return [0, 0, 0];
    let bj = 0, bd = Infinity;
    D.forEach((d, j) => { const v = dist(p, d); if (v < bd) { bd = v; bj = j; } });
    const v = [p[0] - D[bj][0], p[1] - D[bj][1], p[2] - D[bj][2]];
    const nv = Math.hypot(v[0], v[1], v[2]);
    return nv > 1e-12 ? v.map((x) => x / Math.max(nv, 1e-300)) : [0, 0, 0];
  });
  const pos = new Map(ids.map((i, k) => [i, k]));
  const acc = P.map(() => [0, 0, 0]), cnt = new Array(P.length).fill(0);
  for (const [a, b] of edges) {
    if (!pos.has(a) || !pos.has(b)) continue;
    const ia = pos.get(a), ib = pos.get(b);
    if (dist(P[ib], P[ia]) > cohesionLength) {
      for (let c = 0; c < 3; c++) { acc[ia][c] += P[ib][c]; acc[ib][c] += P[ia][c]; }
      cnt[ia]++; cnt[ib]++;
    }
  }
  P.forEach((p, k) => {
    const c = cnt[k] > 0 ? [acc[k][0] / cnt[k] - p[0], acc[k][1] / cnt[k] - p[1], acc[k][2] / cnt[k] - p[2]] : [0, 0, 0];
    const nc = Math.hypot(c[0], c[1], c[2]);
    const ch = nc > 1e-12 ? c.map((x) => x / Math.max(nc, 1e-300)) : [0, 0, 0];
    const d = [0, 1, 2].map((q) => w * f[k][q] + (1 - w) * ch[q]);
    const nd = Math.hypot(d[0], d[1], d[2]);
    out[ids[k]] = nd > 1e-12 ? d.map((x) => vO * x / Math.max(nd, 1e-300)) : [0, 0, 0];
  });
  return out;
}

export { svd3 };
