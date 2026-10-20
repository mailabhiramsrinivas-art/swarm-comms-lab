// Reading a formation: exposure / shielding (geometry/shielding.py), the referee (geometry/referee.py; the
// browser always uses its annealing "fast" mode), O's Delaunay neighbours (geometry/neighbours.py) and the
// plain-Delaunay reader used by the baselines (planner/readers.py).

import {
  delaunay3, delaunay2, hull2, hullFromTets, svd3, diameter, perturb, mintriSearch, tetOf, edgeOf, dist,
} from "./geom.js";
import { orient3dSign, orient3dValue } from "./exact.js";

export const CONFIG_DEFAULT = {
  r: 1.0, v_D: 0.5, v_O: 0.4, support_length: 4.0, cohesion_length: 2.0, deadline: 5,
  m_range: [4, 20], spacing_range: [0.5, 1.2], o_weight_train: [0.3, 0.7], o_weight_test: 0.5, win_threshold: 0.9,
  perturb_rel: 1e-9, degenerate_rel: 1e-10, flat_rel: 1e-7,
};

/** shielding.exposure: id -> true (exposed) / false (shielded) */
export function exposure(aliveIds, tets, hullVertices, X, supportLength) {
  const exposed = new Map();
  for (const i of aliveIds) exposed.set(i, true);
  if (aliveIds.length < 4 || !tets.length) return exposed;
  const hull = new Set(hullVertices);
  const star = new Map();
  const tetOk = tets.map((t) => {
    let ok = true;
    for (let i = 0; i < 4 && ok; i++) for (let j = i + 1; j < 4; j++) if (!(dist(X[t[i]], X[t[j]]) < supportLength)) { ok = false; break; }
    return ok;
  });
  tets.forEach((t, k) => { for (const v of t) { if (!star.has(v)) star.set(v, []); star.get(v).push(k); } });
  for (const v of aliveIds) {
    if (hull.has(v) || !star.has(v)) continue;
    if (star.get(v).every((k) => tetOk[k])) exposed.set(v, false);
  }
  return exposed;
}

function readingObj(ids, tets, tris, edges, hv, hf, dim, T, length, exposed, mode, extra = {}) {
  return {
    ids, tets, tris, edges, hull_vertices: hv, hull_facets: hf, dim, T, length, exposed, mode,
    perturbed: false, flat: false, solved: true, ...extra,
    get exposed_ids() { return this.ids.filter((i) => this.exposed.get(i)); },
    get shielded_ids() { return this.ids.filter((i) => !this.exposed.get(i)); },
  };
}

function allPairs(ids) { const E = []; for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) E.push([ids[a], ids[b]]); return E; }

function trivialReading(ids, Xd) {
  const k = ids.length;
  const edges = allPairs(ids);
  const tris = k === 3 ? [ids.slice()] : [];
  let L = 0; for (const [a, b] of edges) L += dist(Xd(a), Xd(b));
  const ex = new Map(ids.map((i) => [i, true]));
  return readingObj(ids, [], tris, edges, ids.slice(), [], k - 1, 0, L, ex, "trivial");
}

/** Survivors (nearly) on a plane or a line: dim 2 / 1 reading, everyone exposed (referee._flat_reading). */
export function flatReading(ids, X, cfg) {
  const k = ids.length;
  const { sv, Vt, C } = svd3(X);
  const diam = diameter(X);
  const Xd = (i) => X[ids.indexOf(i)];
  const ex = new Map(ids.map((i) => [i, true]));
  if (sv[1] / (Math.sqrt(k) * diam) < cfg.flat_rel) {
    const proj = C.map((c) => c[0] * Vt[0][0] + c[1] * Vt[0][1] + c[2] * Vt[0][2]);
    const order = proj.map((_, i) => i).sort((a, b) => proj[a] - proj[b]);
    const edges = [];
    for (let j = 0; j < k - 1; j++) { const a = ids[order[j]], b = ids[order[j + 1]]; edges.push(a < b ? [a, b] : [b, a]); }
    edges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let L = 0; for (const [a, b] of edges) L += dist(Xd(a), Xd(b));
    const hv = [ids[order[0]], ids[order[k - 1]]].sort((a, b) => a - b);
    return readingObj(ids, [], [], edges, hv, [], 1, 0, L, ex, "flat", { flat: true });
  }
  const Q = C.map((c) => [c[0] * Vt[0][0] + c[1] * Vt[0][1] + c[2] * Vt[0][2], c[0] * Vt[1][0] + c[1] * Vt[1][1] + c[2] * Vt[1][2]]);
  const tl = delaunay2(Q);
  const tris = tl.map((t) => t.map((v) => ids[v]).sort((a, b) => a - b)).sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const E = new Map();
  for (const t of tris) for (const [a, b] of [[t[0], t[1]], [t[0], t[2]], [t[1], t[2]]]) E.set(a * 1000 + b, [a, b]);
  const edges = [...E.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let L = 0; for (const [a, b] of edges) L += dist(Xd(a), Xd(b));
  const hv = hull2(Q).map((v) => ids[v]).sort((a, b) => a - b);
  return readingObj(ids, [], tris, edges, hv, [], 2, 0, L, ex, "flat", { flat: true });
}

/** Thickness test of the referee: are these points (nearly) coplanar? */
export function isFlat(X, cfg) {
  const k = X.length;
  if (k < 4) return true;
  const { sv } = svd3(X);
  const diam = diameter(X);
  return sv[2] / (Math.sqrt(k) * diam) < cfg.flat_rel;
}

/** Triangulation coordinates P for X: X itself, or a perturbed copy when near-degenerate (referee rules). */
export function triangulationCoords(X, cfg, salt = "perturb") {
  const k = X.length;
  const diam = diameter(X);
  let minO = Infinity;
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) for (let c = b + 1; c < k; c++) for (let d = c + 1; d < k; d++) {
    const v = Math.abs(orient3dValue(X[a], X[b], X[c], X[d]));
    if (v < minO) minO = v;
  }
  let P = X, perturbed = false;
  if (minO < cfg.degenerate_rel * diam ** 3) { P = perturb(X, cfg.perturb_rel, salt); perturbed = true; }
  let del = delaunay3(P);
  let rel = cfg.perturb_rel;
  let tries = 0;
  while (!del.ok && tries < 4) {
    rel = perturbed ? rel * 1000 : rel;
    P = perturb(X, rel, salt); perturbed = true;
    del = delaunay3(P);
    tries++;
  }
  if (!del.ok) throw new Error("could not triangulate a degenerate formation");
  return { P, perturbed, del };
}

/** Referee: deterministic minimum-tetrahedra reading of the alive players (annealing fast mode). */
export class Referee {
  constructor(cfg = CONFIG_DEFAULT, { stepsPerTet = 4000, restarts = 1 } = {}) {
    this.cfg = cfg;
    this.stepsPerTet = stepsPerTet;
    this.restarts = restarts;
    this.cache = new Map();
    this.mode = "fast";
    this.stats = { calls: 0, time_ms: 0 };
  }

  read(Xall, alive = null) {
    const ids = [];
    for (let i = 0; i < Xall.length; i++) if (!alive || alive[i]) ids.push(i);
    const X = ids.map((i) => Xall[i]);
    const key = ids.join(",") + "|" + X.map((p) => p.join(",")).join(";");
    const hit = this.cache.get(key);
    if (hit) return hit;
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();
    const rd = this._read(ids, X);
    this.stats.calls++;
    this.stats.time_ms += (typeof performance !== "undefined" ? performance : Date).now() - t0;
    this.cache.set(key, rd);
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
    return rd;
  }

  _read(ids, X) {
    const k = ids.length;
    const Xd = (i) => X[ids.indexOf(i)];
    if (k < 4) return trivialReading(ids, Xd);
    if (isFlat(X, this.cfg)) return flatReading(ids, X, this.cfg);
    const { P, perturbed } = triangulationCoords(X, this.cfg);
    const res = mintriSearch(P, X, this.stepsPerTet, this.restarts);
    const tri = res.tri;
    const tets = tri.sortedTets().map((t) => tetOf(t).map((v) => ids[v]).sort((a, b) => a - b))
      .sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]);
    const edges = [...tri.edgeMap.keys()].map((e) => { const [a, b] = edgeOf(e); const A = ids[a], B = ids[b]; return A < B ? [A, B] : [B, A]; })
      .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const hull = tri.hull;
    const hv = hull.vertices.map((v) => ids[v]).sort((a, b) => a - b);
    const hf = hull.facets.map((f) => f.map((v) => ids[v]).sort((a, b) => a - b)).sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    const Xmap = {}; ids.forEach((i, j) => { Xmap[i] = X[j]; });
    const exp = exposure(ids, tets, hv, Xmap, this.cfg.support_length);
    return readingObj(ids, tets, [], edges, hv, hf, 3, tets.length, tri.totalLength(X), exp, "fast",
      { perturbed, delaunayT: res.delaunayT, steps: res.steps });
  }
}

/** Reading from given tetrahedra (local indices) on X (planner.readers.reading_from). */
export function readingFrom(ids, X, tetsLocal, hullVertices, hullFacets, supportLength, mode) {
  const tets = tetsLocal.map((t) => t.map((v) => ids[v]).sort((a, b) => a - b))
    .sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]);
  const E = new Map();
  for (const [a, b, c, d] of tets) for (const [u, v] of [[a, b], [a, c], [a, d], [b, c], [b, d], [c, d]]) E.set(u * 1000 + v, [u, v]);
  const edges = [...E.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const hv = hullVertices.map((v) => ids[v]).sort((a, b) => a - b);
  const Xmap = {}; ids.forEach((i, j) => { Xmap[i] = X[j]; });
  let L = 0; for (const [a, b] of edges) L += dist(Xmap[a], Xmap[b]);
  const exp = exposure(ids, tets, hv, Xmap, supportLength);
  const hf = hullFacets.map((f) => f.map((v) => ids[v]).sort((a, b) => a - b)).sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  return readingObj(ids.slice(), tets, [], edges, hv, hf, 3, tets.length, L, exp, mode);
}

/** Plain Delaunay reader (the baselines' reading). */
export class DelaunayReader {
  constructor(cfg = CONFIG_DEFAULT) { this.cfg = cfg; this.cache = new Map(); this.fallback = new Referee(cfg, { stepsPerTet: 1 }); }
  read(Xall, alive) {
    const ids = []; for (let i = 0; i < Xall.length; i++) if (alive[i]) ids.push(i);
    const X = ids.map((i) => Xall[i]);
    if (ids.length < 4 || isFlat(X, this.cfg)) return this.fallback.read(Xall, alive);
    const d = delaunay3(X);
    if (!d.ok) return this.fallback.read(Xall, alive);
    return readingFrom(ids, X, d.tets.map(tetOf), d.hull.vertices, d.hull.facets, this.cfg.support_length, "delaunay");
  }
}

/** neighbours.delaunay_edges: local index pairs of the Delaunay graph (flat / collinear / tiny cases). */
export function delaunayEdgesLocal(X, cfg = CONFIG_DEFAULT) {
  const k = X.length;
  if (k < 2) return [];
  if (k < 4) { const E = []; for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) E.push([a, b]); return E; }
  const { sv, Vt, C } = svd3(X);
  const diam = diameter(X);
  if (sv[1] / (Math.sqrt(k) * diam) < cfg.flat_rel) {
    const proj = C.map((c) => c[0] * Vt[0][0] + c[1] * Vt[0][1] + c[2] * Vt[0][2]);
    const order = proj.map((_, i) => i).sort((a, b) => proj[a] - proj[b]);
    const E = []; for (let j = 0; j < k - 1; j++) { const a = order[j], b = order[j + 1]; E.push(a < b ? [a, b] : [b, a]); }
    return E.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  }
  let simp;
  if (sv[2] / (Math.sqrt(k) * diam) < cfg.flat_rel) {
    const Q = C.map((c) => [c[0] * Vt[0][0] + c[1] * Vt[0][1] + c[2] * Vt[0][2], c[0] * Vt[1][0] + c[1] * Vt[1][1] + c[2] * Vt[1][2]]);
    simp = delaunay2(Q);
  } else {
    let d = delaunay3(X);
    let tries = 0, rel = cfg.perturb_rel;
    while (!d.ok && tries < 4) { d = delaunay3(perturb(X, rel, "neighbours")); rel *= 1000; tries++; }
    simp = d.tets.map(tetOf);
  }
  const E = new Map();
  for (const s of simp) {
    const v = s.slice().sort((a, b) => a - b);
    for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) E.set(v[i] * 1000 + v[j], [v[i], v[j]]);
  }
  return [...E.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** Delaunay edges among the alive players, as O-id pairs. */
export function aliveDelaunayEdges(O, alive, cfg = CONFIG_DEFAULT) {
  const ids = []; for (let i = 0; i < O.length; i++) if (alive[i]) ids.push(i);
  return delaunayEdgesLocal(ids.map((i) => O[i]), cfg).map(([a, b]) => [ids[a], ids[b]]);
}

/** Convex hull vertex ids of the alive players (for network features); null if flat. */
export function hullVertexIds(O, alive, cfg = CONFIG_DEFAULT) {
  const ids = []; for (let i = 0; i < O.length; i++) if (alive[i]) ids.push(i);
  const X = ids.map((i) => O[i]);
  if (ids.length < 4 || isFlat(X, cfg)) return null;
  let d = delaunay3(X);
  let tries = 0, rel = cfg.perturb_rel;
  while (!d.ok && tries < 4) { d = delaunay3(perturb(X, rel, "hull")); rel *= 1000; tries++; }
  if (!d.ok) return null;
  return d.hull.vertices.map((v) => ids[v]);
}

export { orient3dSign };
