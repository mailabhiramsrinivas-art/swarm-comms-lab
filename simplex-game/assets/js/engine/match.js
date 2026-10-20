// The nerve of D's spheres of influence (geometry/nerve.py) and the Hungarian assignment
// (a port of scipy.optimize.linear_sum_assignment, Crouse's shortest augmenting path).

import { dist } from "./geom.js";

/** Maximal simplices of the nerve over the O subset (alive and perceived exposed), sorted. */
export function nerve(D, O, subset, r) {
  const n = D.length;
  if (!n) return [];
  const covers = D.map((d) => { const s = new Set(); O.forEach((o, i) => { if (subset[i] && dist(d, o) <= r) s.add(i); }); return s; });
  const gens = new Map();
  for (let i = 0; i < O.length; i++) {
    if (!subset[i]) continue;
    const s = [];
    for (let j = 0; j < n; j++) if (covers[j].has(i)) s.push(j);
    if (s.length) gens.set(s.join(","), s);
  }
  const all = [...gens.values()];
  const isSub = (a, b) => a.length < b.length && a.every((x) => b.includes(x));
  const maximal = all.filter((s) => !all.some((t) => isSub(s, t)));
  maximal.sort((a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; });
  return maximal;
}

export function nerveEdges(simplices) {
  const E = new Map();
  for (const s of simplices) for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) E.set(s[i] * 1000 + s[j], [s[i], s[j]]);
  return [...E.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Connected components of the nerve's 1-skeleton over all n D players (isolated ones included). */
export function components(simplices, n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [a, b] of nerveEdges(simplices)) parent[find(a)] = find(b);
  const groups = new Map();
  for (let j = 0; j < n; j++) { const r = find(j); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(j); }
  const out = [...groups.values()];
  out.sort((a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; });
  return out;
}

/** scipy.optimize.linear_sum_assignment(cost) for a dense nr x nc matrix (array of rows). Returns [rows, cols]. */
export function linearSumAssignment(costRows) {
  let nr = costRows.length;
  if (!nr) return [[], []];
  let nc = costRows[0].length;
  if (!nc) return [[], []];
  const transpose = nc < nr;
  let cost;
  if (transpose) {
    cost = new Float64Array(nr * nc);
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cost[j * nr + i] = costRows[i][j];
    [nr, nc] = [nc, nr];
  } else {
    cost = new Float64Array(nr * nc);
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cost[i * nc + j] = costRows[i][j];
  }
  const u = new Float64Array(nr), v = new Float64Array(nc);
  const spc = new Float64Array(nc);
  const path = new Int32Array(nc).fill(-1);
  const col4row = new Int32Array(nr).fill(-1);
  const row4col = new Int32Array(nc).fill(-1);
  const SR = new Uint8Array(nr), SC = new Uint8Array(nc);
  const remaining = new Int32Array(nc);
  for (let curRow = 0; curRow < nr; curRow++) {
    let minVal = 0;
    let numRemaining = nc;
    for (let it = 0; it < nc; it++) remaining[it] = nc - it - 1;
    SR.fill(0); SC.fill(0); spc.fill(Infinity);
    let sink = -1;
    let i = curRow;
    while (sink === -1) {
      let index = -1, lowest = Infinity;
      SR[i] = 1;
      for (let it = 0; it < numRemaining; it++) {
        const j = remaining[it];
        const r = minVal + cost[i * nc + j] - u[i] - v[j];
        if (r < spc[j]) { path[j] = i; spc[j] = r; }
        if (spc[j] < lowest || (spc[j] === lowest && row4col[j] === -1)) { lowest = spc[j]; index = it; }
      }
      minVal = lowest;
      if (minVal === Infinity) throw new Error("infeasible cost matrix");
      const j = remaining[index];
      if (row4col[j] === -1) sink = j; else i = row4col[j];
      SC[j] = 1;
      remaining[index] = remaining[--numRemaining];
    }
    u[curRow] += minVal;
    for (let r = 0; r < nr; r++) if (SR[r] && r !== curRow) u[r] += minVal - spc[col4row[r]];
    for (let j = 0; j < nc; j++) if (SC[j]) v[j] -= minVal - spc[j];
    let j = sink;
    for (;;) {
      const r = path[j];
      row4col[j] = r;
      const tmp = col4row[r]; col4row[r] = j; j = tmp;
      if (r === curRow) break;
    }
  }
  if (transpose) {
    const order = Array.from(col4row.keys()).sort((a, b) => col4row[a] - col4row[b]);
    return [order.map((k) => col4row[k]), order];
  }
  return [Array.from({ length: nr }, (_, i) => i), Array.from(col4row)];
}
