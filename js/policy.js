// Decision policy. This is a hand-written STAND-IN for the trained model:
// the comms framework only ever calls the three functions exported at the
// bottom (buildPlan, peerChoose, soloChoose), so a learned policy can replace
// them without touching the networking code.

import { interceptTime } from './util.js';

const INFEASIBLE = 50;  // added when a drone cannot catch the enemy before it hits the asset
const SLOT_STEP = 8;    // extra cost for the 2nd, 3rd ... drone on the same target
const GUARD_COST = 60;  // cost of staying on patrol instead of engaging

// Where a track is now, extrapolated from its last observation.
export function extrapolate(tr, now) {
  const dt = now - tr.t;
  return { x: tr.x + tr.vx * dt, y: tr.y + tr.vy * dt, vx: tr.vx, vy: tr.vy };
}

// Cost for drone `d` to engage track `tr`. Lower is better.
export function engageCost(d, tr, now, ctx) {
  const e = extrapolate(tr, now);
  let tti = interceptTime(d.x, d.y, ctx.speed, e.x, e.y, e.vx, e.vy);
  if (!isFinite(tti)) tti = Math.hypot(e.x - d.x, e.y - d.y) / ctx.speed * 3;
  const ax = ctx.asset.x - e.x, ay = ctx.asset.y - e.y;
  const da = Math.hypot(ax, ay);
  const closing = da > 1e-6 ? (ax * e.vx + ay * e.vy) / da : 0;
  const tta = closing > 1 ? Math.max(0, da - ctx.asset.r) / closing : 30;
  let cost = tti + ctx.urgency * Math.min(tta, 30);
  if (tti > tta) cost += INFEASIBLE;
  return { cost, tti, tta };
}

// Hungarian algorithm (min-cost assignment), rows <= cols. Returns col index per row.
export function hungarian(cost) {
  const n = cost.length;
  if (!n) return [];
  const m = cost[0].length;
  const INF = 1e18;
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(INF);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j] - 1] = j - 1;
  return out;
}

// LAYER 3 — coordinator: globally optimal assignment over every drone and
// track it knows about. Returns Map droneId -> trackId | null (null = patrol).
export function buildPlan(drones, tracks, now, ctx) {
  const plan = new Map();
  const K = ctx.maxPerTarget;
  const cols = [];
  for (const tr of tracks) for (let k = 0; k < K; k++) cols.push({ tr, k });
  const guardStart = cols.length;
  for (let i = 0; i < drones.length; i++) cols.push(null);
  const matrix = drones.map((d) =>
    cols.map((c) => {
      if (!c) return GUARD_COST;
      let cost = engageCost(d, c.tr, now, ctx).cost;
      if (d.target === c.tr.id) cost *= ctx.hysteresis; // keep plans stable between cycles
      return cost + c.k * SLOT_STEP;
    }),
  );
  const pick = hungarian(matrix);
  drones.forEach((d, i) => {
    const j = pick[i];
    plan.set(d.id, j >= 0 && j < guardStart ? cols[j].tr.id : null);
  });
  return plan;
}

// LAYER 2 — peer claims: pick the cheapest target where fewer than K other
// drones have a better (lower cost, then lower ID) claim. Deterministic, so
// everyone who sees the same claims reaches the same answer.
export function peerChoose(self, tracks, claims, now, ctx) {
  const K = ctx.maxPerTarget;
  let best = null, bestCost = Infinity, beatenBy = null;
  for (const tr of tracks) {
    let c = engageCost(self, tr, now, ctx).cost;
    if (tr.id === self.target) c *= ctx.hysteresis;
    let rank = 0, firstBetter = null;
    for (const cl of claims) {
      if (cl.target !== tr.id) continue;
      if (cl.cost < c || (cl.cost === c && cl.id < self.id)) {
        rank++;
        if (!firstBetter || cl.cost < firstBetter.cost) firstBetter = cl;
      }
    }
    if (tr.id === self.target && rank >= K) beatenBy = firstBetter;
    if (rank < K && c < bestCost) { best = tr.id; bestCost = c; }
  }
  if (bestCost >= GUARD_COST) { best = null; bestCost = Infinity; }
  return { target: best, cost: bestCost, beatenBy };
}

// LAYER 1 — solo: nearest-in-time enemy from the drone's own camera only.
export function soloChoose(self, ownTracks, now, ctx) {
  let best = null, bestCost = Infinity;
  for (const tr of ownTracks) {
    let c = engageCost(self, tr, now, ctx).cost;
    if (tr.id === self.target) c *= ctx.hysteresis;
    if (c < bestCost) { best = tr.id; bestCost = c; }
  }
  return { target: best, cost: bestCost };
}
