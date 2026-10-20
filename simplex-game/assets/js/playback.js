// Timelines: turn a study record (or a recorded game) into "state at time t" for the Stage.

const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (p, q, t) => [lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t)];
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

export function kindsOf(frame) {
  return frame.O.map((_, i) => (!frame.alive[i] ? "hidden" : frame.exposed[i] === false ? "shielded" : frame.exposed[i] === true ? "exposed" : "neutral"));
}

function nerveEdges(simplices) {
  const E = new Map();
  for (const s of simplices || []) for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) E.set(s[i] * 100 + s[j], [s[i], s[j]]);
  return [...E.values()];
}

/** Per-tick facts for narration. */
export function tickFacts(frames) {
  const out = [];
  for (let k = 1; ; k++) {
    const fm = frames.find((f) => f.tick === k && f.phase === "after_move");
    const fa = frames.find((f) => f.tick === k && f.phase === "after_attack");
    if (!fm) break;
    const hits = fm.hits || [];
    const elim = hits.filter((h) => h.result === "eliminated").length;
    const blocked = hits.filter((h) => h.result === "blocked").length;
    const wasted = hits.filter((h) => h.result === "wasted").length;
    const shieldedBefore = fm.O.map((_, i) => fm.alive[i] && fm.exposed[i] === false);
    let opened = 0;
    if (fa) fa.O.forEach((_, i) => { if (fa.alive[i] && shieldedBefore[i] && fa.exposed[i] === true) opened++; });
    const aliveAfter = fa ? fa.alive.filter((a) => a).length : 0;
    const shieldedAtAttack = shieldedBefore.filter(Boolean).length;
    const groups = groupsOf(fm.nerve || [], fm.D.length);
    out.push({ tick: k, hits: hits.length, elim, blocked, wasted, opened, aliveAfter, shieldedAtAttack, groups });
  }
  return out;
}

function groupsOf(simplices, n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (const [a, b] of nerveEdges(simplices)) parent[find(a)] = find(b);
  const g = new Map();
  for (let j = 0; j < n; j++) { const r = find(j); g.set(r, (g.get(r) || 0) + 1); }
  return [...g.values()].filter((c) => c > 1).length;
}

/** Game timeline from frames [placement, after_move 1, after_attack 1, ...]. */
export function gameTimeline(frames, opts = {}) {
  const r = opts.r || 1;
  const T0 = opts.lead ?? 1.0, DT = opts.tickDur ?? 3.4;
  const ticks = [];
  for (let k = 1; ; k++) {
    const fm = frames.find((f) => f.tick === k && f.phase === "after_move");
    const fa = frames.find((f) => f.tick === k && f.phase === "after_attack");
    if (!fm) break;
    ticks.push({ fm, fa: fa || fm });
  }
  const f0 = frames[0];
  const duration = T0 + ticks.length * DT + 0.6;
  const facts = tickFacts(frames);
  function stateAt(t) {
    if (t < T0 || !ticks.length) {
      const k = kindsOf(f0);
      return { O: f0.O, oKind: k, D: f0.D, r, edges: f0.edges, hull: f0.facets, nerve: nerveEdges(f0.nerve), hud: { tick: 0, alive: f0.alive.filter((a) => a).length, phase: "start" } };
    }
    let k = Math.floor((t - T0) / DT);
    if (k >= ticks.length) {
      const fa = ticks[ticks.length - 1].fa;
      return { O: fa.O, oKind: kindsOf(fa), D: fa.D, r, edges: fa.edges, hull: fa.facets, nerve: nerveEdges(fa.nerve), hud: { tick: ticks.length, alive: fa.alive.filter((a) => a).length, phase: "end" } };
    }
    const u = t - T0 - k * DT;
    const { fm, fa } = ticks[k];
    const prev = k === 0 ? f0 : ticks[k - 1].fa;
    const base = { r, hud: { tick: k + 1, alive: fm.alive.filter((a) => a).length } };
    if (u < 1.4) {
      const s = ease(u / 1.4);
      const O = prev.O.map((p, i) => lerp3(p, fm.O[i], s));
      const D = prev.D.map((p, j) => lerp3(p, fm.D[j], s));
      const kinds = kindsOf(prev);
      return { ...base, O, D, oKind: kinds, edges: prev.edges, hull: prev.facets, trails: prev.D.map((p, j) => [p, fm.D[j]]), hud: { ...base.hud, phase: "move", alive: prev.alive.filter((a) => a).length } };
    }
    const nv = nerveEdges(fm.nerve);
    if (u < 1.8) return { ...base, O: fm.O, D: fm.D, oKind: kindsOf(fm), edges: fm.edges, hull: fm.facets, nerve: nv, nerveAlpha: clamp01((u - 1.4) / 0.3), hud: { ...base.hud, phase: "read" } };
    const attacks = (fm.hits || []).map((h) => ({ ...h, p: ease(clamp01((u - 1.8) / 0.5)) }));
    if (u < 2.5) return { ...base, O: fm.O, D: fm.D, oKind: kindsOf(fm), edges: fm.edges, hull: fm.facets, nerve: nv, attacks, hud: { ...base.hud, phase: "hit", hits: fm.hits.length } };
    const s = clamp01((u - 2.5) / 0.7);
    const killed = new Set((fm.hits || []).filter((h) => h.result === "eliminated").map((h) => h.o));
    const kinds = kindsOf(fa).map((kd, i) => (killed.has(i) ? (s < 1 ? "dead" : "hidden") : kd));
    const oScale = fa.O.map((_, i) => (killed.has(i) ? 1 - s * 0.7 : 1));
    const glow = fa.O.map((_, i) => (fm.exposed[i] === false && fa.alive[i] && fa.exposed[i] === true ? Math.sin(Math.PI * s) : 0));
    return { ...base, O: fa.O, D: fa.D, oKind: kinds, oScale, glow, edges: fa.edges, hull: fa.facets, nerve: nv, nerveAlpha: 1 - s, attacks: s < 0.6 ? attacks : [],
      hud: { ...base.hud, phase: "clear", alive: fa.alive.filter((a) => a).length } };
  }
  return { duration, stateAt, ticks: ticks.length, facts, tickStart: (k) => T0 + (k - 1) * DT, tickDur: DT, lead: T0 };
}

const edgesOfTets = (tets, O, L) => {
  const E = new Map();
  for (const t of tets) for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    const u = Math.min(t[a], t[b]), v = Math.max(t[a], t[b]);
    if (!E.has(u * 100 + v)) { const p = O[u], q = O[v]; E.set(u * 100 + v, [u, v, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < L ? 1 : 0]); }
  }
  return [...E.values()];
};
const tkey = (t) => t.slice().sort((a, b) => a - b).join(",");

/** Formation appearing, then the Delaunay split. */
export function appearTimeline(rec, withDelaunay) {
  const O = rec.O, m = O.length;
  const L = rec.cfg.support_length;
  const del = rec.flips ? rec.flips.delaunay : rec.dReading.tets;
  const edges = edgesOfTets(del, O, L);
  const dur = withDelaunay ? 2.2 : 1.6;
  return {
    duration: dur,
    stateAt(t) {
      const oScale = O.map((_, i) => ease(clamp01(t * 2.2 - (i / m) * 1.6)));
      if (!withDelaunay) return { O, oKind: O.map(() => "neutral"), oScale, hud: { count: m } };
      const ea = clamp01((t - 0.6) / 1.2);
      return { O, oKind: O.map(() => "neutral"), edges: edges.map((e) => [e[0], e[1], 1]), edgeAlpha: ea, hud: { T: del.length } };
    },
  };
}

/** The triangulation agent's flips, one after another. */
export function flipsTimeline(rec) {
  const O = rec.O;
  const L = rec.cfg.support_length;
  const fl = rec.flips;
  const hist = fl ? fl.history.filter((h) => h.kind !== "stop") : [];
  const per = Math.max(0.07, Math.min(0.4, 7 / Math.max(hist.length, 1)));
  const states = [];
  let cur = new Map((fl ? fl.delaunay : rec.dReading.tets).map((t) => [tkey(t), t]));
  states.push({ tets: [...cur.values()], T: cur.size });
  for (const h of hist) {
    for (const t of h.removed) cur.delete(tkey(t));
    for (const t of h.added) cur.set(tkey(t), t);
    states.push({ tets: [...cur.values()], T: cur.size, h });
  }
  const best = rec.dReading.tets;
  const duration = 0.6 + hist.length * per + 1.2;
  return {
    duration, per, steps: hist.length,
    stateAt(t) {
      const k = Math.max(0, Math.min(hist.length, Math.floor((t - 0.6) / per) + 1));
      if (t >= 0.6 + hist.length * per + 0.3) {
        return { O, oKind: O.map(() => "neutral"), edges: edgesOfTets(best, O, L).map((e) => [e[0], e[1], 1]), hud: { T: best.length, T0: fl ? fl.T0 : best.length, flips: hist.length, done: true } };
      }
      const st = states[k];
      const local = clamp01((t - 0.6 - (k - 1) * per) / per);
      const hot = st.h ? [[st.h.d, st.h.e]] : [];
      return { O, oKind: O.map(() => "neutral"), edges: edgesOfTets(st.tets, O, L).map((e) => [e[0], e[1], 1]), hot, hotAlpha: 1 - local * 0.6,
        hotTets: st.h ? st.h.added : [], hotTetAlpha: 0.22 * (1 - local), hud: { T: st.T, T0: fl ? fl.T0 : st.T, flips: k, kind: st.h ? st.h.kind : null } };
    },
  };
}

/** D's reading: exposed and shielded players, supported and unsupported edges, the hull. */
export function readingState(rec, which = "d") {
  const rd = which === "d" ? rec.dReading : rec.refReading;
  const O = rec.O;
  const L = rec.cfg.support_length;
  const ex = new Set(rd.exposed);
  return { O, oKind: O.map((_, i) => (ex.has(i) ? "exposed" : "shielded")), edges: edgesOfTets(rd.tets, O, L), hull: rd.facets, hullAlpha: 1,
    hud: { exposed: rd.exposed.length, shielded: rd.shielded.length } };
}

/** Candidate spots, then the greedy picks turning into D players. */
export function placementTimeline(rec) {
  const pl = rec.placement;
  const base = readingState(rec, "d");
  const byK = new Map(pl.candidates.map((c) => [c.k, c]));
  const scores = pl.candidates.map((c) => c.score);
  const lo = Math.min(...scores), hi = Math.max(...scores);
  const norm = (s) => (hi > lo ? (s - lo) / (hi - lo) : 1);
  const picks = pl.steps.map((s) => byK.get(s.pick));
  const per = Math.max(0.35, Math.min(0.8, 4 / picks.length));
  const duration = 1.4 + picks.length * per + 0.8;
  return {
    duration,
    stateAt(t) {
      const ca = clamp01(t / 1.0);
      const k = Math.max(0, Math.min(picks.length, Math.floor((t - 1.4) / per) + 1));
      const chosen = new Set(picks.slice(0, k).map((c) => c.k));
      const cands = pl.candidates.filter((c) => !chosen.has(c.k)).map((c) => ({ pos: c.pos, size: 0.5 + 1.3 * norm(c.score), alpha: ca * (0.18 + 0.7 * norm(c.score)) }));
      const D = picks.slice(0, k).map((c) => c.pos);
      const last = k > 0 ? picks[k - 1] : null;
      const local = clamp01((t - 1.4 - (k - 1) * per) / per);
      const dScale = D.map((_, j) => (j === k - 1 ? ease(local) : 1));
      const glow = rec.O.map((_, i) => (last && last.cover.includes(i) ? 1 - local * 0.5 : 0));
      const cover = last ? last.cover.map((i) => [last.pos, rec.O[i]]) : [];
      return { ...base, hullAlpha: 0.6, edgeAlpha: 0.5, cands, D, dScale, r: rec.cfg.r, glow, cover, haloAlpha: 1, hud: { placed: k, n: picks.length, candidates: pl.nCandidates } };
    },
  };
}
