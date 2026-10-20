// 3D triangulations: Delaunay, convex hull, bistellar flips and the annealing search for few tetrahedra
// (ports of geometry/triangulation.py, flips.py and fast_mintri.py). Indices are local (0..k-1), k <= 32.

import { orient3dSign, orient3dValue, insphereSign, orient2dSign, incircleSign } from "./exact.js";
import { PCG64, seedFromPoints } from "./rng.js";

// ------------------------------------------------------------------ integer keys (5 bits per index)
export const tetKey = (a, b, c, d) => (((a * 32 + b) * 32 + c) * 32 + d);
export const faceKey = (a, b, c) => ((a * 32 + b) * 32 + c);
export const edgeKey = (a, b) => a * 32 + b;
export const tetOf = (k) => [k >> 15, (k >> 10) & 31, (k >> 5) & 31, k & 31];
export const faceOf = (k) => [k >> 10, (k >> 5) & 31, k & 31];
export const edgeOf = (k) => [k >> 5, k & 31];

function sort3(a, b, c) { let t; if (a > b) { t = a; a = b; b = t; } if (b > c) { t = b; b = c; c = t; } if (a > b) { t = a; a = b; b = t; } return [a, b, c]; }
function sort4(v) { return v.slice().sort((x, y) => x - y); }
export const sTet = (a, b, c, d) => { const s = sort4([a, b, c, d]); return tetKey(s[0], s[1], s[2], s[3]); };
export const sFace = (a, b, c) => { const s = sort3(a, b, c); return faceKey(s[0], s[1], s[2]); };
export const sEdge = (a, b) => (a < b ? edgeKey(a, b) : edgeKey(b, a));

export function tetFaces(t) {
  const [a, b, c, d] = tetOf(t);
  return [faceKey(a, b, c), faceKey(a, b, d), faceKey(a, c, d), faceKey(b, c, d)];
}
export function tetEdges(t) {
  const [a, b, c, d] = tetOf(t);
  return [edgeKey(a, b), edgeKey(a, c), edgeKey(a, d), edgeKey(b, c), edgeKey(b, d), edgeKey(c, d)];
}

export const dist = (p, q) => { const x = p[0] - q[0], y = p[1] - q[1], z = p[2] - q[2]; return Math.sqrt(x * x + y * y + z * z); };

// ------------------------------------------------------------------ exact orientation table
export class OrientTable {
  constructor(P) {
    const m = P.length;
    this.m = m;
    this.s0 = m * m * m; this.s1 = m * m; this.s2 = m;
    const tab = new Int8Array(m * m * m * m);
    const perms = [];
    const permute = (arr, l) => {
      if (l === arr.length) { perms.push(arr.slice()); return; }
      for (let i = l; i < arr.length; i++) { [arr[l], arr[i]] = [arr[i], arr[l]]; permute(arr, l + 1); [arr[l], arr[i]] = [arr[i], arr[l]]; }
    };
    permute([0, 1, 2, 3], 0);
    const parity = perms.map((p) => { let inv = 0; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (p[i] > p[j]) inv++; return inv % 2 ? -1 : 1; });
    for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) for (let c = b + 1; c < m; c++) for (let d = c + 1; d < m; d++) {
      const s = orient3dSign(P[a], P[b], P[c], P[d]);
      const q = [a, b, c, d];
      for (let k = 0; k < 24; k++) {
        const p = perms[k];
        tab[q[p[0]] * this.s0 + q[p[1]] * this.s1 + q[p[2]] * this.s2 + q[p[3]]] = s * parity[k];
      }
    }
    this.tab = tab;
  }
  sign(a, b, c, d) { return this.tab[a * this.s0 + b * this.s1 + c * this.s2 + d]; }
  /** open segment de passes through the interior of triangle abc */
  crosses(a, b, c, d, e) {
    const t = this.tab, s0 = this.s0, s1 = this.s1, s2 = this.s2;
    const u = t[a * s0 + b * s1 + c * s2 + d];
    const v = t[a * s0 + b * s1 + c * s2 + e];
    if (u === 0 || v === 0 || u === v) return false;
    const de = d * s0 + e * s1;
    const t1 = t[de + a * s2 + b];
    if (t1 === 0) return false;
    return t[de + b * s2 + c] === t1 && t[de + c * s2 + a] === t1;
  }
}

// ------------------------------------------------------------------ triangulation structure
export class Triangulation {
  constructor(P, tets = [], otab = null) {
    this.P = P;
    this.otab = otab;
    this.tets = new Set();
    this.faceMap = new Map();
    this.edgeMap = new Map();
    for (const t of tets) this.addTet(t);
  }
  addTet(t) {
    this.tets.add(t);
    for (const f of tetFaces(t)) { const l = this.faceMap.get(f); if (l) l.push(t); else this.faceMap.set(f, [t]); }
    for (const e of tetEdges(t)) { const s = this.edgeMap.get(e); if (s) s.add(t); else this.edgeMap.set(e, new Set([t])); }
  }
  removeTet(t) {
    this.tets.delete(t);
    for (const f of tetFaces(t)) {
      const l = this.faceMap.get(f);
      const i = l.indexOf(t); l.splice(i, 1);
      if (!l.length) this.faceMap.delete(f);
    }
    for (const e of tetEdges(t)) {
      const s = this.edgeMap.get(e);
      s.delete(t);
      if (!s.size) this.edgeMap.delete(e);
    }
  }
  copy() {
    const n = Object.create(Triangulation.prototype);
    n.P = this.P; n.otab = this.otab;
    n.tets = new Set(this.tets);
    n.faceMap = new Map(); for (const [f, v] of this.faceMap) n.faceMap.set(f, v.slice());
    n.edgeMap = new Map(); for (const [e, v] of this.edgeMap) n.edgeMap.set(e, new Set(v));
    return n;
  }
  get T() { return this.tets.size; }
  sortedTets() { return [...this.tets].sort((a, b) => a - b); }
  totalLength(X = null) {
    X = X || this.P;
    const keys = [...this.edgeMap.keys()].sort((a, b) => a - b);
    let s = 0;
    for (const k of keys) s += dist(X[k >> 5], X[k & 31]);
    return s;
  }
}

// ------------------------------------------------------------------ flips (geometry/flips.py)
function crosses(tri, a, b, c, d, e) {
  if (tri.otab) return tri.otab.crosses(a, b, c, d, e);
  const P = tri.P;
  const s1 = orient3dSign(P[a], P[b], P[c], P[d]), s2 = orient3dSign(P[a], P[b], P[c], P[e]);
  if (s1 === 0 || s2 === 0 || s1 === s2) return false;
  const t1 = orient3dSign(P[d], P[e], P[a], P[b]);
  return t1 !== 0 && t1 === orient3dSign(P[d], P[e], P[b], P[c]) && t1 === orient3dSign(P[d], P[e], P[c], P[a]);
}

const notIn3 = (t, a, b, c) => { const v = tetOf(t); for (const x of v) if (x !== a && x !== b && x !== c) return x; return -1; };

export function flip23Parts(tri, f) {
  const tl = tri.faceMap.get(f);
  if (!tl || tl.length !== 2) return null;
  const [a, b, c] = faceOf(f);
  const t1 = tl[0], t2 = tl[1];
  const d = notIn3(t1, a, b, c), e = notIn3(t2, a, b, c);
  if (tri.edgeMap.has(sEdge(d, e))) return null;
  if (!crosses(tri, a, b, c, d, e)) return null;
  return [[t1, t2], [sTet(a, b, d, e), sTet(b, c, d, e), sTet(c, a, d, e)]];
}

export function flip32Parts(tri, ek) {
  const ts = tri.edgeMap.get(ek);
  if (!ts || ts.size !== 3) return null;
  const d = ek >> 5, e = ek & 31;
  const linkSet = new Set();
  for (const t of ts) for (const v of tetOf(t)) if (v !== d && v !== e) linkSet.add(v);
  if (linkSet.size !== 3) return null;
  const link = [...linkSet].sort((x, y) => x - y);
  for (const x of link) { const fl = tri.faceMap.get(sFace(d, e, x)); if (!fl || fl.length !== 2) return null; }
  const [a, b, c] = link;
  if (tri.faceMap.has(faceKey(a, b, c))) return null;
  if (!crosses(tri, a, b, c, d, e)) return null;
  return [[...ts], [sTet(a, b, c, d), sTet(a, b, c, e)]];
}

export function applyFlip(tri, parts) {
  for (const t of parts[0]) tri.removeTet(t);
  for (const t of parts[1]) tri.addTet(t);
}

export function flip32(tri, ek) {
  const p = flip32Parts(tri, ek);
  if (!p) return false;
  applyFlip(tri, p);
  return true;
}

/** All legal flips: [kind, key, parts] in face-map order then edge-map order. */
export function legalFlips(tri) {
  const out = [];
  for (const [f, tl] of tri.faceMap) if (tl.length === 2) { const p = flip23Parts(tri, f); if (p) out.push(["23", f, p]); }
  for (const [e, ts] of tri.edgeMap) if (ts.size === 3) { const p = flip32Parts(tri, e); if (p) out.push(["32", e, p]); }
  return out;
}

// ------------------------------------------------------------------ Delaunay and hull (brute force, exact)
/**
 * Delaunay tetrahedra of P (k <= 32) by the empty-circumsphere test over all quadruples.
 * Returns {tets, ok}; ok = false when P is degenerate (zero-volume quadruple in the result, cospherical
 * points, a dropped point or overlapping / missing tetrahedra) so the caller can perturb.
 */
export function delaunay3(P) {
  const k = P.length;
  const tets = [];
  let degenerate = false;
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) for (let c = b + 1; c < k; c++) for (let d = c + 1; d < k; d++) {
    const o = orient3dSign(P[a], P[b], P[c], P[d]);
    if (o === 0) continue;
    let empty = true;
    for (let e = 0; e < k && empty; e++) {
      if (e === a || e === b || e === c || e === d) continue;
      const s = insphereSign(P[a], P[b], P[c], P[d], P[e]) * o;
      if (s > 0) empty = false;
      else if (s === 0) degenerate = true;
    }
    if (empty) tets.push(tetKey(a, b, c, d));
  }
  if (degenerate || !tets.length) return { tets, ok: false };
  // validity: every face in at most two tetrahedra, every point used, volume = hull volume
  const fc = new Map();
  const used = new Set();
  let vol = 0;
  for (const t of tets) {
    for (const f of tetFaces(t)) fc.set(f, (fc.get(f) || 0) + 1);
    const [a, b, c, d] = tetOf(t);
    used.add(a); used.add(b); used.add(c); used.add(d);
    vol += Math.abs(orient3dValue(P[a], P[b], P[c], P[d])) / 6;
  }
  for (const v of fc.values()) if (v > 2) return { tets, ok: false };
  if (used.size !== k) return { tets, ok: false };
  const hull = hullFromTets(P, tets);
  if (!hull || Math.abs(vol - hull.volume) > 1e-9 * Math.max(hull.volume, 1e-300)) return { tets, ok: false };
  return { tets, ok: true, hull };
}

/** Hull from a valid tetrahedralisation: boundary faces, their vertices, volume (signed facet sum). */
export function hullFromTets(P, tets) {
  const fc = new Map();
  for (const t of tets) for (const f of tetFaces(t)) fc.set(f, (fc.get(f) || 0) + 1);
  const facets = [];
  const verts = new Set();
  for (const [f, c] of fc) if (c === 1) { facets.push(f); const [a, b, cc] = faceOf(f); verts.add(a); verts.add(b); verts.add(cc); }
  facets.sort((a, b) => a - b);
  // volume from the facets (divergence theorem with outward orientation)
  const cen = [0, 0, 0];
  for (const v of verts) { cen[0] += P[v][0]; cen[1] += P[v][1]; cen[2] += P[v][2]; }
  cen[0] /= verts.size; cen[1] /= verts.size; cen[2] /= verts.size;
  let vol = 0;
  for (const f of facets) { const [a, b, c] = faceOf(f); vol += Math.abs(orient3dValue(cen, P[a], P[b], P[c])) / 6; }
  return { vertices: [...verts].sort((a, b) => a - b), facets: facets.map(faceOf), volume: vol };
}

/** Thin SVD of the centred k x 3 matrix by one-sided Jacobi: singular values (desc) and right vectors (rows). */
export function svd3(X) {
  const k = X.length;
  const mean = [0, 0, 0];
  for (const p of X) { mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
  mean[0] /= k; mean[1] /= k; mean[2] /= k;
  const A = X.map((p) => [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]]);
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      let alpha = 0, beta = 0, gamma = 0;
      for (let i = 0; i < k; i++) { alpha += A[i][p] * A[i][p]; beta += A[i][q] * A[i][q]; gamma += A[i][p] * A[i][q]; }
      if (Math.abs(gamma) <= 1e-300 || Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta)) continue;
      off = Math.max(off, Math.abs(gamma) / Math.sqrt(alpha * beta));
      const zeta = (beta - alpha) / (2 * gamma);
      const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
      const c = 1 / Math.sqrt(1 + t * t), s = c * t;
      for (let i = 0; i < k; i++) { const x = A[i][p], y = A[i][q]; A[i][p] = c * x - s * y; A[i][q] = s * x + c * y; }
      for (let i = 0; i < 3; i++) { const x = V[i][p], y = V[i][q]; V[i][p] = c * x - s * y; V[i][q] = s * x + c * y; }
    }
    if (off < 1e-15) break;
  }
  const sv = [0, 1, 2].map((j) => Math.sqrt(A.reduce((s, r) => s + r[j] * r[j], 0)));
  const order = [0, 1, 2].sort((a, b) => sv[b] - sv[a]);
  return { sv: order.map((j) => sv[j]), Vt: order.map((j) => [V[0][j], V[1][j], V[2][j]]), mean, C: A.map((_, i) => [X[i][0] - mean[0], X[i][1] - mean[1], X[i][2] - mean[2]]) };
}

export function diameter(X) {
  let d = 0;
  for (let i = 0; i < X.length; i++) for (let j = i + 1; j < X.length; j++) d = Math.max(d, dist(X[i], X[j]));
  return d;
}

/** X + rel * diam * uniform(-1, 1) with numpy's RNG seeded by the position hash (referee._perturb). */
export function perturb(X, rel, salt = "perturb") {
  const diam = diameter(X);
  const rng = new PCG64(seedFromPoints(X, salt));
  return X.map((p) => [p[0] + rel * diam * rng.uniform(-1, 1), p[1] + rel * diam * rng.uniform(-1, 1), p[2] + rel * diam * rng.uniform(-1, 1)]);
}

/** 2D Delaunay triangles (local index triples, sorted) by the empty-circle test; perturbs if degenerate. */
export function delaunay2(Q) {
  const k = Q.length;
  const tris = [];
  let degenerate = false;
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) for (let c = b + 1; c < k; c++) {
    const o = orient2dSign(Q[a], Q[b], Q[c]);
    if (o === 0) continue;
    let empty = true;
    for (let d = 0; d < k && empty; d++) {
      if (d === a || d === b || d === c) continue;
      const s = incircleSign(Q[a], Q[b], Q[c], Q[d]) * o;
      if (s > 0) empty = false; else if (s === 0) degenerate = true;
    }
    if (empty) tris.push([a, b, c]);
  }
  if (degenerate) {
    const rng = new PCG64(seedFromPoints(Q.map((q) => [q[0], q[1], 0]), "flat2d"));
    let diam = 0;
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) diam = Math.max(diam, Math.hypot(Q[i][0] - Q[j][0], Q[i][1] - Q[j][1]));
    const Q2 = Q.map((q) => [q[0] + 1e-9 * diam * rng.uniform(-1, 1), q[1] + 1e-9 * diam * rng.uniform(-1, 1)]);
    return delaunay2(Q2);
  }
  return tris;
}

/** 2D convex hull vertex indices (monotone chain). */
export function hull2(Q) {
  const idx = Q.map((_, i) => i).sort((i, j) => Q[i][0] - Q[j][0] || Q[i][1] - Q[j][1]);
  const cross = (o, a, b) => (Q[a][0] - Q[o][0]) * (Q[b][1] - Q[o][1]) - (Q[a][1] - Q[o][1]) * (Q[b][0] - Q[o][0]);
  const lower = [], upper = [];
  for (const i of idx) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop(); lower.push(i); }
  for (let t = idx.length - 1; t >= 0; t--) { const i = idx[t]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop(); upper.push(i); }
  return [...new Set(lower.slice(0, -1).concat(upper.slice(0, -1)))];
}

/** Delaunay as a Triangulation (raises on degenerate input, like geometry.triangulation.delaunay). */
export function delaunayTri(P, otab = null) {
  const d = delaunay3(P);
  if (!d.ok) { const err = new Error("degenerate"); err.degenerate = true; throw err; }
  const tri = new Triangulation(P, d.tets, otab);
  tri.hull = d.hull;
  return tri;
}

// ------------------------------------------------------------------ fast_mintri: descent + annealing
export function descend(tri, X) {
  let n = 0;
  for (;;) {
    const cands = [];
    for (const [e, ts] of tri.edgeMap) if (ts.size === 3) cands.push([e, dist(X[e >> 5], X[e & 31])]);
    cands.sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
    let done = true;
    for (const [e] of cands) if (flip32(tri, e)) { n++; done = false; break; }
    if (done) return n;
  }
}

class TetList {
  constructor(tets) { this.items = [...tets].sort((a, b) => a - b); this.pos = new Map(); this.items.forEach((t, i) => this.pos.set(t, i)); }
  add(t) { this.pos.set(t, this.items.length); this.items.push(t); }
  remove(t) {
    const i = this.pos.get(t); this.pos.delete(t);
    const last = this.items.pop();
    if (i < this.items.length) { this.items[i] = last; this.pos.set(last, i); }
  }
}

export function anneal(tri, X, steps, rng, Thot = 1.0, Tcold = 0.1) {
  const m = X.length;
  const D = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) D[i * m + j] = dist(X[i], X[j]);
  let curL = tri.totalLength(X);
  let best = tri.copy(), bestT = tri.T, bestL = curL;
  const tl = new TetList(tri.tets);
  const logRatio = Math.log(Tcold / Thot);
  const R = rng.randomArray(steps * 3);
  for (let s = 0; s < steps; s++) {
    const r0 = R[3 * s], r1 = R[3 * s + 1], r2 = R[3 * s + 2];
    const items = tl.items;
    const t = items[Math.floor(r0 * items.length)];
    let parts;
    if (r1 < 0.5) {
      const [a, b, c, d] = tetOf(t);
      const fsel = Math.floor(r2 * 4);
      const f = fsel === 0 ? faceKey(a, b, c) : fsel === 1 ? faceKey(a, b, d) : fsel === 2 ? faceKey(a, c, d) : faceKey(b, c, d);
      parts = flip23Parts(tri, f);
      if (!parts) continue;
      const temp = Thot * Math.exp(logRatio * s / steps);
      if (rng.random() >= Math.exp(-1.0 / temp)) continue;
      const [fa, fb, fc] = faceOf(f);
      const d0 = notIn3(parts[0][0], fa, fb, fc), e0 = notIn3(parts[0][1], fa, fb, fc);
      curL += D[d0 * m + e0];
    } else {
      const e = tetEdges(t)[Math.floor(r2 * 6)];
      parts = flip32Parts(tri, e);
      if (!parts) continue;
      curL -= D[(e >> 5) * m + (e & 31)];
    }
    for (const o of parts[0]) { tri.removeTet(o); tl.remove(o); }
    for (const n of parts[1]) { tri.addTet(n); tl.add(n); }
    if (tri.T <= bestT) {
      if (tri.T < bestT || curL < bestL) { best = tri.copy(); bestT = tri.T; bestL = curL; }
    }
  }
  return [best, bestT, best.totalLength(X)];
}

/** fast_mintri.search: best (T, length) triangulation; P triangulation coords, X true coords. */
export function mintriSearch(P, X = null, stepsPerTet = 4000, restarts = 1, start = null) {
  X = X || P;
  const seed = seedFromPoints(P);
  const otab = new OrientTable(P);
  const d0 = delaunayTri(P, otab);
  const steps = stepsPerTet * d0.T;
  let best = null, bT = Infinity, bL = Infinity;
  for (let rs = 0; rs < restarts; rs++) {
    const base = start && rs === 0 ? start : d0;
    const cur = new Triangulation(P, base.sortedTets(), otab);
    descend(cur, X);
    const rng = new PCG64(rs === 0 ? seed : [seed, BigInt(rs)]);
    const [b, T, L] = anneal(cur, X, steps, rng);
    if (T < bT || (T === bT && L < bL)) { best = b; bT = T; bL = L; }
  }
  best.otab = null;
  best.hull = d0.hull;
  return { tri: best, steps: steps * restarts, delaunayT: d0.T };
}
