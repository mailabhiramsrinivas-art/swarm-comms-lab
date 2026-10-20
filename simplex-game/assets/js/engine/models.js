// The four trained networks and the inputs they see (ports of learn/tri_agent/{env,policy}.py,
// learn/tick_policy/model.py and learn/placement/model.py).

import { MLP, gather, concatCols, scatterMean, scatterSum, addInPlace, softplus, sigmoid, edgeMessages, projCols } from "./nn.js";
import {
  OrientTable, Triangulation, delaunay3, legalFlips, applyFlip, tetOf, faceOf, edgeOf, dist,
} from "./geom.js";
import { aliveDelaunayEdges, hullVertexIds, CONFIG_DEFAULT } from "./referee.js";

const H = 64;

// =====================================================================================================
// Triangulation agent
// =====================================================================================================
function vol(P, t) {
  const [a, b, c, d] = tetOf(t);
  const A = P[a], B = P[b], C = P[c], D = P[d];
  const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]], w = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
  const cx = v[1] * w[2] - v[2] * w[1], cy = v[2] * w[0] - v[0] * w[2], cz = v[0] * w[1] - v[1] * w[0];
  return Math.abs(u[0] * cx + u[1] * cy + u[2] * cz) / 6;
}

export class FlipEnv {
  constructor(X0, budgetFactor = 2.0) { this.X0 = X0; this.budgetFactor = budgetFactor; }
  reset() {
    const k = this.X0.length;
    const mean = [0, 0, 0];
    for (const p of this.X0) { mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
    mean[0] /= k; mean[1] /= k; mean[2] /= k;
    const X = this.X0.map((p) => [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]]);
    this.P = X;
    this.otab = new OrientTable(X);
    const d = delaunay3(X);
    if (!d.ok) { const e = new Error("degenerate"); e.degenerate = true; throw e; }
    this.delaunayTets = d.tets.slice();
    this.tri = new Triangulation(X, d.tets, this.otab);
    this.T0 = this.tri.T;
    let s = 0, cnt = 0;
    for (const e of this.tri.edgeMap.keys()) { s += dist(X[e >> 5], X[e & 31]); cnt++; }
    this.L0 = s / cnt;
    this.vol0 = d.hull.volume / Math.max(this.T0, 1);
    this.hull = new Float64Array(k);
    for (const v of d.hull.vertices) this.hull[v] = 1;
    this.L = this.tri.totalLength();
    this.best = { T: this.tri.T, L: this.L, tets: this.tri.sortedTets() };
    this.steps = 0;
    this.budget = Math.ceil(this.budgetFactor * this.T0);
    this.done = false;
    return this.obs();
  }
  obs() {
    const tri = this.tri, P = this.P, L0 = this.L0;
    const m = P.length;
    const deg = new Float64Array(m), inc = new Float64Array(m);
    const edges = [...tri.edgeMap.entries()];
    for (const [e] of edges) { deg[e >> 5]++; deg[e & 31]++; }
    for (const t of tri.tets) for (const v of tetOf(t)) inc[v]++;
    const E = edges.length;
    const src = new Int32Array(2 * E), dst = new Int32Array(2 * E), ef = new Float64Array(4 * E);
    edges.forEach(([e, ts], i) => {
      const a = e >> 5, b = e & 31;
      src[i] = a; src[E + i] = b; dst[i] = b; dst[E + i] = a;
      const ln = dist(P[a], P[b]) / L0, ring = ts.size / 6;
      ef[2 * i] = ln; ef[2 * i + 1] = ring; ef[2 * (E + i)] = ln; ef[2 * (E + i) + 1] = ring;
    });
    this.cands = legalFlips(tri);
    const K = this.cands.length;
    const tri3 = new Int32Array(3 * K), pair = new Int32Array(2 * K), cf = new Float64Array(7 * K);
    this.cands.forEach(([kind, key, parts], c) => {
      const [old, nw] = parts;
      let abc, d, e, dT, sgn;
      if (kind === "23") {
        abc = faceOf(key);
        const notIn = (t) => tetOf(t).find((v) => !abc.includes(v));
        d = notIn(old[0]); e = notIn(old[1]); dT = 1; sgn = 1;
      } else {
        [d, e] = edgeOf(key);
        const s = new Set(); for (const t of old) for (const v of tetOf(t)) if (v !== d && v !== e) s.add(v);
        abc = [...s].sort((x, y) => x - y); dT = -1; sgn = -1;
      }
      const dl = sgn * dist(P[d], P[e]) / L0;
      const vo = old.map((t) => vol(P, t) / this.vol0), vn = nw.map((t) => vol(P, t) / this.vol0);
      tri3.set(abc, 3 * c); pair[2 * c] = d; pair[2 * c + 1] = e;
      cf.set([kind === "23" ? 1 : 0, kind === "32" ? 1 : 0, dT, dl, Math.min(...vo), Math.max(...vo), vn.length ? Math.min(...vn) : 0], 7 * c);
    });
    const nf = new Float64Array(3 * m), x = new Float64Array(3 * m);
    for (let i = 0; i < m; i++) {
      nf[3 * i] = this.hull[i]; nf[3 * i + 1] = deg[i] / 10; nf[3 * i + 2] = inc[i] / 20;
      x[3 * i] = P[i][0] / L0; x[3 * i + 1] = P[i][1] / L0; x[3 * i + 2] = P[i][2] / L0;
    }
    return { m, x, nf, src, dst, ef, E2: 2 * E, tri3, pair, cf, K };
  }
  step(a) {
    if (a === this.cands.length) { this.done = true; return null; }
    const [kind, key, parts] = this.cands[a];
    applyFlip(this.tri, parts);
    const [old] = parts;
    let d, e;
    if (kind === "23") { const f = faceOf(key); const notIn = (t) => tetOf(t).find((v) => !f.includes(v)); d = notIn(old[0]); e = notIn(old[1]); }
    else [d, e] = edgeOf(key);
    this.L += (kind === "23" ? 1 : -1) * dist(this.P[d], this.P[e]);
    if (this.tri.T < this.best.T || (this.tri.T === this.best.T && this.L < this.best.L)) this.best = { T: this.tri.T, L: this.L, tets: this.tri.sortedTets() };
    this.steps++;
    const o = this.obs();
    if (this.steps >= this.budget || !this.cands.length) this.done = true;
    return { obs: o, kind, key, d, e, parts };
  }
}

export class FlipPolicy {
  constructor(W) {
    this.embed = new MLP(W, "tri", "embed", 2);
    this.layers = [0, 1, 2].map((i) => ({
      phi_e: new MLP(W, "tri", `layers.${i}.phi_e`, 2, true),
      phi_h: new MLP(W, "tri", `layers.${i}.phi_h`, 2),
    }));
    this.flip = new MLP(W, "tri", "flip", 3);
    this.stop = new MLP(W, "tri", "stop", 2);
  }
  /** logits over [candidates..., STOP] */
  logits(o) {
    const m = o.m, E = o.E2;
    let h = this.embed.forward(o.nf, m);
    const d2 = new Float64Array(E);
    for (let i = 0; i < E; i++) {
      const a = o.dst[i], b = o.src[i];
      const dx = o.x[3 * a] - o.x[3 * b], dy = o.x[3 * a + 1] - o.x[3 * b + 1], dz = o.x[3 * a + 2] - o.x[3 * b + 2];
      d2[i] = dx * dx + dy * dy + dz * dz;
    }
    for (const L of this.layers) {
      const msg = edgeMessages(L.phi_e, h, H, m, o.src, o.dst, d2, o.ef, 2, E);
      const agg = scatterMean(msg, H, o.dst, m);
      h = addInPlace(h, L.phi_h.forward(concatCols([[h, H], [agg, H]], m), m));
    }
    const pooled = new Float64Array(H);
    for (let i = 0; i < m; i++) for (let k = 0; k < H; k++) pooled[k] += h[i * H + k];
    for (let k = 0; k < H; k++) pooled[k] /= m;
    const K = o.K;
    const out = new Float64Array(K + 1);
    if (K) {
      const L0 = this.flip.layers[0], full = L0.inp, o0 = L0.out, w = L0.w, b = L0.b;
      const A = projCols(h, m, H, w, o0, full, 0), B = projCols(h, m, H, w, o0, full, H);
      const pre = new Float64Array(K * o0);
      for (let c = 0; c < K; c++) {
        const t1 = o.tri3[3 * c] * o0, t2 = o.tri3[3 * c + 1] * o0, t3 = o.tri3[3 * c + 2] * o0;
        const p1 = o.pair[2 * c] * o0, p2 = o.pair[2 * c + 1] * o0;
        for (let q = 0; q < o0; q++) {
          const wo = q * full + 2 * H;
          let v = b[q] + A[t1 + q] + A[t2 + q] + A[t3 + q] + B[p1 + q] + B[p2 + q];
          for (let k = 0; k < 7; k++) v += w[wo + k] * o.cf[7 * c + k];
          pre[c * o0 + q] = v / (1 + Math.exp(-v));
        }
      }
      out.set(this.flip.forwardFrom(pre, K, 1), 0);
    }
    out[K] = this.stop.forward(pooled, 1)[0];
    return out;
  }
}

/** learn/tri_agent/evaluate.agent_triangulate, plus the flip history for the animation. */
export function agentTriangulate(policy, X) {
  const env = new FlipEnv(X);
  let o = env.reset();
  const history = [];
  for (;;) {
    const lg = policy.logits(o);
    let a = 0;
    for (let i = 1; i < lg.length; i++) if (lg[i] > lg[a]) a = i;
    if (a === env.cands.length) { history.push({ kind: "stop", T: env.tri.T }); break; }
    const st = env.step(a);
    history.push({ kind: st.kind, d: st.d, e: st.e, removed: st.parts[0].map(tetOf), added: st.parts[1].map(tetOf), T: env.tri.T });
    o = st.obs;
    if (env.done) break;
  }
  return { T: env.best.T, L: env.best.L, tets: env.best.tets.map(tetOf), T0: env.T0, delaunay: env.delaunayTets.map(tetOf), history, budget: env.budget };
}

// =====================================================================================================
// Per-tick network
// =====================================================================================================
const T_NODE_F = 6, T_EDGE_F = 7;

export function buildTickGraph(O, alive, D, lastD, lastO, exposedIds, tets, stage, cfg = CONFIG_DEFAULT, moveRadius = null, knn = 4) {
  const ids = []; for (let i = 0; i < O.length; i++) if (alive[i]) ids.push(i);
  const c = [0, 0, 0];
  if (ids.length) { for (const i of ids) { c[0] += O[i][0]; c[1] += O[i][1]; c[2] += O[i][2]; } c[0] /= ids.length; c[1] /= ids.length; c[2] /= ids.length; }
  const pos = new Map(ids.map((i, k) => [i, k]));
  const n = D.length, No = ids.length, N = No + n;
  const x = new Float64Array(3 * N);
  ids.forEach((i, k) => { x[3 * k] = O[i][0] - c[0]; x[3 * k + 1] = O[i][1] - c[1]; x[3 * k + 2] = O[i][2] - c[2]; });
  D.forEach((d, j) => { const k = No + j; x[3 * k] = d[0] - c[0]; x[3 * k + 1] = d[1] - c[1]; x[3 * k + 2] = d[2] - c[2]; });
  const ex = new Set(exposedIds || []);
  const supp = new Float64Array(No), hull = new Float64Array(No);
  let Eoo = new Map();
  if (tets) {
    for (const t of tets) {
      if (!t.every((v) => pos.has(v))) continue;
      let ok = true;
      for (let a = 0; a < 4 && ok; a++) for (let b = a + 1; b < 4; b++) if (!(dist(O[t[a]], O[t[b]]) < cfg.support_length)) { ok = false; break; }
      for (const v of t) supp[pos.get(v)] += ok ? 1 : 0;
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) { const u = Math.min(t[a], t[b]), w = Math.max(t[a], t[b]); Eoo.set(u * 1000 + w, [u, w]); }
    }
  }
  if (!Eoo.size) for (const [a, b] of aliveDelaunayEdges(O, alive, cfg)) Eoo.set(a * 1000 + b, [a, b]);
  if (No >= 4) {
    const hv = hullVertexIds(O, alive, cfg);
    if (hv) for (const v of hv) hull[pos.get(v)] = 1; else hull.fill(1);
  } else hull.fill(1);
  const nf = new Float64Array(N * T_NODE_F);
  ids.forEach((i, k) => {
    nf[k * 6] = 1; nf[k * 6 + 2] = ex.has(i) ? 1 : 0; nf[k * 6 + 3] = supp[k] / 10; nf[k * 6 + 4] = hull[k];
    nf[k * 6 + 5] = Math.hypot(lastO[i][0], lastO[i][1], lastO[i][2]) / Math.max(cfg.v_O, 1e-9);
  });
  D.forEach((_, j) => { const k = No + j; nf[k * 6 + 1] = 1; nf[k * 6 + 5] = Math.hypot(lastD[j][0], lastD[j][1], lastD[j][2]) / cfg.v_D; });
  const src = [], dst = [], ef = [];
  for (const [a, b] of Eoo.values()) {
    const ia = pos.get(a), ib = pos.get(b);
    const L = dist(O[a], O[b]);
    const f = [1, 0, L / cfg.r, L < cfg.support_length ? 1 : 0, 0, 0, 0];
    src.push(ia, ib); dst.push(ib, ia); ef.push(...f, ...f);
  }
  const rad = stage === "target" ? cfg.r : (moveRadius || 2 * cfg.r);
  const pairD = [], pairO = [], pairDl = [], pairId = [];
  for (let j = 0; j < n; j++) {
    const dv = ids.map((i) => [O[i][0] - D[j][0], O[i][1] - D[j][1], O[i][2] - D[j][2]]);
    const dd = dv.map((v) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]));
    const sel = new Set();
    dd.forEach((v, k) => { if (v <= rad) sel.add(k); });
    if (stage === "move") dd.map((v, k) => [v, k]).sort((p, q) => p[0] - q[0] || p[1] - q[1]).slice(0, knn).forEach(([, k]) => sel.add(k));
    for (const k of [...sel].sort((p, q) => p - q)) {
      const i = ids[k];
      const u = dv[k].map((v) => v / Math.max(dd[k], 1e-9));
      const lo = lastO[i];
      const f = [0, 1, dd[k] / cfg.r, dd[k] <= cfg.r ? 1 : 0, ex.has(i) ? 1 : 0, (lo[0] * u[0] + lo[1] * u[1] + lo[2] * u[2]) / Math.max(cfg.v_O, 1e-9)];
      f.splice(3, 0, 0);   // [is_OO, is_DO, dist/r, supported(=0), in_range, exposed, radial O move]
      const dn = No + j;
      src.push(k, dn); dst.push(dn, k); ef.push(...f, ...f);
      if (stage === "target" && dd[k] <= cfg.r && ex.has(i)) { pairD.push(dn); pairO.push(k); pairDl.push(j); pairId.push(i); }
    }
  }
  return {
    N, No, n, ids, x, nf, src: Int32Array.from(src), dst: Int32Array.from(dst), ef: Float64Array.from(ef), E: src.length,
    dIdx: Int32Array.from({ length: n }, (_, j) => No + j), dLast: Float64Array.from(lastD.flat()),
    pairD, pairO, pairDl, pairId,
  };
}

export class TickPolicy {
  constructor(W, vD = 0.5) {
    this.vD = vD;
    this.embed = new MLP(W, "tick", "embed", 2);
    this.msg = [0, 1, 2].map((i) => new MLP(W, "tick", `msg.${i}`, 2, true));
    this.upd = [0, 1, 2].map((i) => new MLP(W, "tick", `upd.${i}`, 2));
    this.moveW = new MLP(W, "tick", "move_w", 2);
    this.moveSelf = new MLP(W, "tick", "move_self", 2);
    this.pair = new MLP(W, "tick", "pair", 2);
    this.nohit = new MLP(W, "tick", "nohit", 2);
  }
  encode(g) {
    let h = this.embed.forward(g.nf, g.N);
    const E = g.E;
    const rel = new Float64Array(3 * E), d2 = new Float64Array(E);
    for (let i = 0; i < E; i++) {
      const s = g.src[i], t = g.dst[i];
      for (let k = 0; k < 3; k++) rel[3 * i + k] = g.x[3 * s + k] - g.x[3 * t + k];
      d2[i] = rel[3 * i] ** 2 + rel[3 * i + 1] ** 2 + rel[3 * i + 2] ** 2;
    }
    let m = null;
    for (let l = 0; l < 3; l++) {
      m = edgeMessages(this.msg[l], h, H, g.N, g.src, g.dst, d2, g.ef, T_EDGE_F, E);
      h = addInPlace(h, this.upd[l].forward(concatCols([[h, H], [scatterMean(m, H, g.dst, g.N), H]], g.N), g.N));
    }
    return { h, m, rel };
  }
  move(g) {
    const { h, m, rel } = this.encode(g);
    const isD = new Uint8Array(g.N); for (const k of g.dIdx) isD[k] = 1;
    const sel = []; for (let i = 0; i < g.E; i++) if (isD[g.dst[i]]) sel.push(i);
    const w = this.moveW.forward(gather(m, H, sel), sel.length);
    const contrib = new Float64Array(3 * sel.length);
    sel.forEach((e, q) => { for (let k = 0; k < 3; k++) contrib[3 * q + k] = rel[3 * e + k] * w[q]; });
    const V = scatterSum(contrib, 3, sel.map((e) => g.dst[e]), g.N);
    const ws = this.moveSelf.forward(gather(h, H, g.dIdx), g.n);
    const out = [];
    for (let j = 0; j < g.n; j++) {
      const k = g.dIdx[j];
      const v = [0, 1, 2].map((c) => V[3 * k + c] + g.dLast[3 * j + c] * ws[j]);
      const nrm = Math.max(Math.hypot(v[0], v[1], v[2]), 1e-9);
      const f = this.vD * Math.tanh(nrm) / nrm;
      out.push([v[0] * f, v[1] * f, v[2] * f]);
    }
    return out;
  }
  targets(g) {
    const { h } = this.encode(g);
    const P = g.pairD.length;
    const ekey = new Map();
    for (let i = 0; i < g.E; i++) ekey.set(g.dst[i] * (g.N + 1) + g.src[i], i);
    const feat = new Float64Array(P * (2 * H + T_EDGE_F));
    for (let p = 0; p < P; p++) {
      const base = p * (2 * H + T_EDGE_F);
      feat.set(h.subarray(g.pairD[p] * H, g.pairD[p] * H + H), base);
      feat.set(h.subarray(g.pairO[p] * H, g.pairO[p] * H + H), base + H);
      const e = ekey.get(g.pairD[p] * (g.N + 1) + g.pairO[p]);
      feat.set(g.ef.subarray(e * T_EDGE_F, e * T_EDGE_F + T_EDGE_F), base + 2 * H);
    }
    const sPair = P ? Array.from(this.pair.forward(feat, P)) : [];
    const sNone = Array.from(this.nohit.forward(gather(h, H, g.dIdx), g.n));
    return { sPair, sNone };
  }
}

// =====================================================================================================
// Placement and team size
// =====================================================================================================
const P_NODE_F = 7, P_EDGE_F = 4;

function combos2(m) { const out = []; for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) out.push([a, b]); return out; }

export function candidates(O, tets, r) {
  const m = O.length;
  const pts = O.map((p) => p.slice()), kinds = O.map(() => 0);
  for (const [a, b] of combos2(m)) if (dist(O[a], O[b]) < 2 * r) { pts.push([(O[a][0] + O[b][0]) / 2, (O[a][1] + O[b][1]) / 2, (O[a][2] + O[b][2]) / 2]); kinds.push(1); }
  const tris = new Map();
  for (const t of tets) {
    pts.push([0, 1, 2].map((c) => (O[t[0]][c] + O[t[1]][c] + O[t[2]][c] + O[t[3]][c]) / 4));
    kinds.push(3);
    for (const f of [[t[0], t[1], t[2]], [t[0], t[1], t[3]], [t[0], t[2], t[3]], [t[1], t[2], t[3]]]) tris.set(f.join(","), f);
  }
  const fl = [...tris.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  for (const f of fl) { pts.push([0, 1, 2].map((c) => (O[f[0]][c] + O[f[1]][c] + O[f[2]][c]) / 3)); kinds.push(2); }
  return { pts, kinds };
}

export function buildPGraph(O, tets, cfg = CONFIG_DEFAULT, knn = 4) {
  const r = cfg.r, m = O.length;
  const { pts: C, kinds } = candidates(O, tets, r);
  const c0 = [0, 0, 0]; for (const p of O) { c0[0] += p[0]; c0[1] += p[1]; c0[2] += p[2]; } c0[0] /= m; c0[1] /= m; c0[2] /= m;
  const N = m + C.length;
  const x = new Float64Array(3 * N);
  O.forEach((p, i) => { x[3 * i] = p[0] - c0[0]; x[3 * i + 1] = p[1] - c0[1]; x[3 * i + 2] = p[2] - c0[2]; });
  C.forEach((p, j) => { const i = m + j; x[3 * i] = p[0] - c0[0]; x[3 * i + 1] = p[1] - c0[1]; x[3 * i + 2] = p[2] - c0[2]; });
  const nf = new Float64Array(N * P_NODE_F);
  for (let i = 0; i < m; i++) nf[i * 7] = 1;
  const distCO = C.map((p) => O.map((o) => dist(p, o)));
  const cover = distCO.map((row) => { const s = new Set(); row.forEach((v, i) => { if (v <= r) s.add(i); }); return s; });
  C.forEach((_, j) => { const i = m + j; nf[i * 7 + 1] = 1; nf[i * 7 + 2 + kinds[j]] = 1; nf[i * 7 + 6] = cover[j].size / 10; });
  const src = [], dst = [], ef = [];
  const E = new Map();
  for (const t of tets) for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) { const u = Math.min(t[a], t[b]), w = Math.max(t[a], t[b]); E.set(u * 1000 + w, [u, w]); }
  for (const [a, b] of E.values()) {
    const L = dist(O[a], O[b]);
    const f = [1, 0, L / r, L <= r ? 1 : 0];
    src.push(a, b); dst.push(b, a); ef.push(...f, ...f);
  }
  C.forEach((_, c) => {
    const sel = new Set(cover[c]);
    distCO[c].map((v, i) => [v, i]).sort((p, q) => p[0] - q[0] || p[1] - q[1]).slice(0, knn).forEach(([, i]) => sel.add(i));
    for (const o of [...sel].sort((p, q) => p - q)) {
      const f = [0, 1, distCO[c][o] / r, distCO[c][o] <= r ? 1 : 0];
      src.push(o, m + c); dst.push(m + c, o); ef.push(...f, ...f);
    }
  });
  return { x, nf, src: Int32Array.from(src), dst: Int32Array.from(dst), ef: Float64Array.from(ef), E: src.length, N, m, candPos: C, kinds, cover };
}

class Encoder {
  constructor(W, model) {
    this.embed = new MLP(W, model, "enc.embed", 2);
    this.msg = [0, 1, 2].map((i) => new MLP(W, model, `enc.msg.${i}`, 2, true));
    this.upd = [0, 1, 2].map((i) => new MLP(W, model, `enc.upd.${i}`, 2));
  }
  forward(g) {
    let h = this.embed.forward(g.nf, g.N);
    const E = g.E;
    const d2 = new Float64Array(E);
    for (let i = 0; i < E; i++) {
      const s = g.src[i], t = g.dst[i];
      const dx = g.x[3 * s] - g.x[3 * t], dy = g.x[3 * s + 1] - g.x[3 * t + 1], dz = g.x[3 * s + 2] - g.x[3 * t + 2];
      d2[i] = dx * dx + dy * dy + dz * dz;
    }
    for (let l = 0; l < 3; l++) {
      const m = edgeMessages(this.msg[l], h, H, g.N, g.src, g.dst, d2, g.ef, P_EDGE_F, E);
      h = addInPlace(h, this.upd[l].forward(concatCols([[h, H], [scatterMean(m, H, g.dst, g.N), H]], g.N), g.N));
    }
    return h;
  }
}

export class PlacementNet {
  constructor(W) {
    this.enc = new Encoder(W, "place");
    this.score = new MLP(W, "place", "score", 2);
    this.beta = W.get("place", "beta").data[0];
  }
  scores(g, n) {
    const h = this.enc.forward(g);
    const Cn = g.N - g.m;
    const feat = new Float64Array(Cn * (H + 1));
    for (let c = 0; c < Cn; c++) { feat.set(h.subarray((g.m + c) * H, (g.m + c + 1) * H), c * (H + 1)); feat[c * (H + 1) + H] = n / Math.max(g.m, 1); }
    return Array.from(this.score.forward(feat, Cn));
  }
}

export class TeamSizeNet {
  constructor(W) {
    this.enc = new Encoder(W, "team");
    this.head = new MLP(W, "team", "head", 2);
  }
  /** P(win | n) for n = 1..20 */
  probs(g) {
    const h = this.enc.forward(g);
    const pooled = new Float64Array(H);
    for (let i = 0; i < g.m; i++) for (let k = 0; k < H; k++) pooled[k] += h[i * H + k];
    for (let k = 0; k < H; k++) pooled[k] /= Math.max(g.m, 1);
    const out = this.head.forward(pooled, 1);
    const base = out[0];
    const inc = Array.from(out.subarray(1)).map(softplus);
    const logits = [];
    let cum = 0;
    for (let k = 0; k < inc.length; k++) { cum += inc[k]; logits.push(base + cum - inc[0]); }
    return logits.map(sigmoid);
  }
}

/** Pick n candidates greedily, discounting candidates whose cover overlaps what is already covered. */
export function greedySelect(scores, cover, n, beta) {
  const chosen = [], covered = new Set(), steps = [];
  for (let s = 0; s < n; s++) {
    let best = -1, bestV = -Infinity;
    const adj = scores.map((sc, k) => {
      if (chosen.includes(k)) return -Infinity;
      const c = cover[k];
      let ov = 0; for (const v of c) if (covered.has(v)) ov++;
      return sc - beta * (ov / Math.max(c.size, 1));
    });
    adj.forEach((v, k) => { if (v > bestV) { bestV = v; best = k; } });
    chosen.push(best);
    for (const v of cover[best]) covered.add(v);
    steps.push({ pick: best, adjusted: bestV });
  }
  return { chosen, steps };
}
