// A small 2D version of the formation game, used by the "our model" demonstration.
// Rules follow the Simplex Game engine (simplex-game/assets/js/engine/referee.js and the O
// evasion script), in units of the hit radius r:
//   - a drone can hit one threat within r; drones move up to 0.5 r per round, threats up to 0.4 r
//   - a threat is shielded if it is not on the formation's outer boundary and every Delaunay
//     triangle it belongs to has all three sides shorter than 4 r; a hit on it is blocked
//   - threats flee the nearest drone while regrouping with Delaunay neighbours farther than 2 r
//   - the formation must be cleared within 5 rounds
// Two teams play the same formation: "model" (reads shielding, smallest winning team, placement,
// per-round matching among drones that share a threat) and "plain" (all drones, nearest threats,
// no knowledge of shielding).

export const RULES = { r: 1, vD: 0.5, vO: 0.4, support: 4, cohesion: 2, deadline: 5, wFlee: 0.5, wCoh: 0.5 };

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------- geometry ----------
export function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const d = Math.max(maxX - minX, maxY - minY) * 20 + 1, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const P = pts.concat([{ x: cx - d, y: cy - d }, { x: cx + d, y: cy - d }, { x: cx, y: cy + d }]);
  let tris = [[n, n + 1, n + 2]];
  const circ = (t) => {
    const [a, b, c] = t.map((i) => P[i]);
    const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const ux = ((a.x * a.x + a.y * a.y) * (b.y - c.y) + (b.x * b.x + b.y * b.y) * (c.y - a.y) + (c.x * c.x + c.y * c.y) * (a.y - b.y)) / D;
    const uy = ((a.x * a.x + a.y * a.y) * (c.x - b.x) + (b.x * b.x + b.y * b.y) * (a.x - c.x) + (c.x * c.x + c.y * c.y) * (b.x - a.x)) / D;
    return { x: ux, y: uy, r2: (a.x - ux) ** 2 + (a.y - uy) ** 2 };
  };
  for (let i = 0; i < n; i++) {
    const p = P[i];
    const bad = [], keep = [];
    for (const t of tris) { const c = circ(t); ((p.x - c.x) ** 2 + (p.y - c.y) ** 2 < c.r2) ? bad.push(t) : keep.push(t); }
    const edges = new Map();
    for (const t of bad) for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      const k = a < b ? a + ',' + b : b + ',' + a;
      edges.set(k, edges.has(k) ? null : [a, b]);
    }
    tris = keep;
    for (const e of edges.values()) if (e) tris.push([e[0], e[1], i]);
  }
  return tris.filter((t) => t.every((v) => v < n));
}

export function hull(pts) {
  const idx = pts.map((_, i) => i).sort((i, j) => pts[i].x - pts[j].x || pts[i].y - pts[j].y);
  const cross = (o, a, b) => (pts[a].x - pts[o].x) * (pts[b].y - pts[o].y) - (pts[a].y - pts[o].y) * (pts[b].x - pts[o].x);
  const lo = [], up = [];
  for (const i of idx) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], i) <= 0) lo.pop(); lo.push(i); }
  for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], i) <= 0) up.pop(); up.push(i); }
  return new Set(lo.slice(0, -1).concat(up.slice(0, -1)));
}

// Exposure of each alive threat: true = can be hit, false = shielded.
export function read(O, alive) {
  const ids = O.map((_, i) => i).filter((i) => alive[i]);
  const exposed = O.map(() => true);
  const pts = ids.map((i) => O[i]);
  const tris = ids.length >= 3 ? delaunay(pts) : [];
  if (ids.length >= 3 && tris.length) {
    const H = hull(pts);
    const ok = tris.map((t) => [[t[0], t[1]], [t[1], t[2]], [t[0], t[2]]].every(([a, b]) => dist(pts[a], pts[b]) < RULES.support));
    const star = pts.map(() => []);
    tris.forEach((t, k) => t.forEach((v) => star[v].push(k)));
    pts.forEach((_, v) => { if (!H.has(v) && star[v].length && star[v].every((k) => ok[k])) exposed[ids[v]] = false; });
  }
  const edges = [];
  const seen = new Set();
  for (const t of tris) for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[0], t[2]]]) {
    const A = ids[a], B = ids[b], k = Math.min(A, B) + ',' + Math.max(A, B);
    if (!seen.has(k)) { seen.add(k); edges.push([A, B]); }
  }
  return { exposed, edges };
}

// ---------- assignment ----------
// Min-cost assignment (rows <= cols). Returns column per row.
function hungarian(cost) {
  const n = cost.length; if (!n) return [];
  const m = cost[0].length, INF = 1e18;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}
// Assign each drone to at most one target (any shape); returns target index or -1 per drone.
function assign(D, targets, costFn) {
  if (!D.length || !targets.length) return D.map(() => -1);
  if (D.length <= targets.length) return hungarian(D.map((d) => targets.map((t) => costFn(d, t))));
  const cols = hungarian(targets.map((t) => D.map((d) => costFn(d, t))));
  const out = D.map(() => -1);
  cols.forEach((di, ti) => { if (di >= 0) out[di] = ti; });
  return out;
}

// ---------- movement ----------
const step = (from, to, max) => { const d = dist(from, to); return d <= max ? { x: to.x, y: to.y } : { x: from.x + (to.x - from.x) / d * max, y: from.y + (to.y - from.y) / d * max }; };

function moveThreats(O, alive, D, edges) {
  const nb = O.map(() => []);
  for (const [a, b] of edges) { nb[a].push(b); nb[b].push(a); }
  return O.map((o, i) => {
    if (!alive[i]) return o;
    let px = 0, py = 0;
    if (D.length) {
      let j = 0, best = Infinity;
      D.forEach((d, k) => { const e = dist(d, o); if (e < best) { best = e; j = k; } });
      if (best > 1e-9) { px += RULES.wFlee * (o.x - D[j].x) / best; py += RULES.wFlee * (o.y - D[j].y) / best; }
    }
    const drifted = nb[i].filter((k) => alive[k] && dist(O[k], o) > RULES.cohesion);
    if (drifted.length) {
      const mx = drifted.reduce((s, k) => s + O[k].x, 0) / drifted.length - o.x, my = drifted.reduce((s, k) => s + O[k].y, 0) / drifted.length - o.y;
      const n = Math.hypot(mx, my); if (n > 1e-9) { px += RULES.wCoh * mx / n; py += RULES.wCoh * my / n; }
    }
    const n = Math.hypot(px, py);
    return n > 1e-9 ? { x: o.x + RULES.vO * px / n, y: o.y + RULES.vO * py / n } : o;
  });
}

// ---------- the two teams ----------
// Candidate start spots from the formation (plan, Flag 7): edge midpoints and triangle centres.
function candidates(O, alive, rd) {
  const out = [];
  for (const [a, b] of rd.edges) out.push({ x: (O[a].x + O[b].x) / 2, y: (O[a].y + O[b].y) / 2 });
  const ids = O.map((_, i) => i).filter((i) => alive[i]);
  for (const t of delaunay(ids.map((i) => O[i]))) { const [a, b, c] = t.map((v) => O[ids[v]]); out.push({ x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 }); }
  return out;
}
function placeModel(O, alive, rd, n) {
  const cand = candidates(O, alive, rd), covered = new Set(), spots = [];
  for (let k = 0; k < n; k++) {
    let best = null, bestScore = -1;
    for (const c of cand) {
      if (spots.some((s) => dist(s, c) < 0.6)) continue;
      let score = 0;
      O.forEach((o, i) => { if (alive[i] && rd.exposed[i] && dist(c, o) <= RULES.r) score += covered.has(i) ? 0.25 : 1; });
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) break;
    spots.push(best);
    O.forEach((o, i) => { if (alive[i] && rd.exposed[i] && dist(best, o) <= RULES.r) covered.add(i); });
  }
  return spots;
}

// Play one engagement. team: 'model' | 'plain'. Returns per-round frames.
export function play(O0, D0, team) {
  let O = O0.map((p) => ({ ...p })), D = D0.map((p) => ({ ...p }));
  const alive = O.map(() => true);
  const rounds = [];
  let blocked = 0;
  for (let t = 1; t <= RULES.deadline && alive.some(Boolean); t++) {
    const rd0 = read(O, alive);
    const live = O.map((_, i) => i).filter((i) => alive[i]);
    // where each drone heads this round
    const pool = team === 'model' ? live.filter((i) => rd0.exposed[i]) : live;
    const pick = assign(D, pool.map((i) => O[i]), (d, o) => dist(d, o));
    const goal = D.map((d, k) => (pick[k] >= 0 ? O[pool[pick[k]]] : d));
    const plan = D.map((d, k) => (pick[k] >= 0 ? pool[pick[k]] : -1));
    // everyone moves at once, from positions at the start of the round
    const Dn = D.map((d, k) => (dist(d, goal[k]) <= 0.6 * RULES.r ? d : step(d, goal[k], RULES.vD)));
    const On = moveThreats(O, alive, D, rd0.edges);
    const rd = read(On, alive);
    // attack
    const hits = [];
    let claims = [];
    if (team === 'model') {
      const cover = Dn.map((d) => live.filter((i) => rd.exposed[i] && dist(d, On[i]) <= RULES.r));
      const by = new Map();
      cover.forEach((U, k) => U.forEach((i) => { if (!by.has(i)) by.set(i, []); by.get(i).push(k); }));
      const pairs = new Set();
      for (const ks of by.values()) for (let a = 0; a < ks.length; a++) for (let b = a + 1; b < ks.length; b++) pairs.add(ks[a] + ',' + ks[b]);
      claims = [...pairs].map((s) => s.split(',').map(Number));
      const tgt = live.filter((i) => cover.some((U) => U.includes(i)));
      const m = assign(Dn, tgt.map((i) => On[i]), (d, o) => (dist(d, o) <= RULES.r ? dist(d, o) : 1e6));
      m.forEach((j, k) => { if (j >= 0 && dist(Dn[k], On[tgt[j]]) <= RULES.r) hits.push({ d: k, o: tgt[j], ok: true }); });
    } else {
      plan.forEach((i, k) => { if (i >= 0 && dist(Dn[k], On[i]) <= RULES.r) { const ok = rd.exposed[i]; if (!ok) blocked++; hits.push({ d: k, o: i, ok }); } });
    }
    for (const h of hits) if (h.ok) alive[h.o] = false;
    rounds.push({ t, O: O.map((p) => ({ ...p })), D: D.map((p) => ({ ...p })), On: On.map((p) => ({ ...p })), Dn: Dn.map((p) => ({ ...p })), exposedAfterMove: rd.exposed.slice(), hits, claims, alive: alive.slice() });
    O = On; D = Dn;
  }
  const left = alive.filter(Boolean).length;
  return { rounds, left, blocked, won: left === 0, O, D, alive };
}

// Our model's team: the smallest team that clears the formation within the deadline.
export function modelTeam(O0, maxDrones) {
  const alive = O0.map(() => true);
  const rd = read(O0, alive);
  for (let n = 1; n <= maxDrones; n++) {
    const spots = placeModel(O0, alive, rd, n);
    if (spots.length < n) continue;
    const res = play(O0, spots, 'model');
    if (res.won) return { n, spots, res, reading: rd };
  }
  const spots = placeModel(O0, alive, rd, maxDrones);
  return { n: maxDrones, spots, res: play(O0, spots, 'model'), reading: rd };
}

// The plain team: every drone, each to the nearest threat, starting just short of it.
export function plainTeam(O0, homes) {
  const alive = O0.map(() => true);
  const pick = assign(homes, O0, (d, o) => dist(d, o));
  const spots = homes.map((h, k) => { const o = O0[pick[k]]; const d = dist(h, o); return { x: o.x + (h.x - o.x) / d * 0.9, y: o.y + (h.y - o.y) / d * 0.9 }; });
  return { n: homes.length, spots, res: play(O0, spots, 'plain'), reading: read(O0, alive) };
}

// The demonstration formation: 8 threats around the edge, 4 inside, spacing 0.75 r to 1.2 r.
export function demoFormation() {
  const jit = [[0.05, -0.03], [-0.04, 0.06], [0.03, 0.04], [-0.06, -0.02], [0.02, -0.05], [0.06, 0.03], [-0.03, -0.06], [0.04, 0.02], [0.03, -0.02], [-0.02, 0.04], [0.04, 0.03], [-0.03, -0.04]];
  const O = [];
  for (let k = 0; k < 8; k++) { const a = (45 * k + 10) * Math.PI / 180; O.push({ x: 1.5 * Math.cos(a), y: 1.5 * Math.sin(a) }); }
  O.push({ x: 0.55, y: -0.55 }, { x: 0.55, y: 0.55 }, { x: -0.55, y: 0.55 }, { x: -0.55, y: -0.55 });
  return O.map((p, i) => ({ x: p.x + jit[i][0], y: p.y + jit[i][1] }));
}
