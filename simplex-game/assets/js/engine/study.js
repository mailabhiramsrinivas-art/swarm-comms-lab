// One complete "study" of a formation by the learned D: its reading (with the flip history), the team-size
// choice, the placement, and the game, as a JSON-ready record for the viewer. Used by the site's worker
// and by the scripts that precompute the gallery.

import { CONFIG_DEFAULT, Referee, isFlat } from "./referee.js";
import { LearnedD, KMeansGreedy } from "./agents.js";
import { SimplexEnv, runEpisode } from "./env.js";
import { meanNN } from "./formations.js";
import { dist } from "./geom.js";

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const P4 = (P) => P.map((p) => [r4(p[0]), r4(p[1]), r4(p[2])]);

export const REFEREE_PRESETS = {
  quick: { stepsPerTet: 1000, restarts: 1, label: "quick (1,000 steps per tetrahedron)" },
  standard: { stepsPerTet: 4000, restarts: 1, label: "standard (4,000 steps per tetrahedron; the training referee)" },
  thorough: { stepsPerTet: 16000, restarts: 4, label: "thorough (16,000 x 4; the test referee above 12 players)" },
};

function readingJSON(rd) {
  return {
    ids: rd.ids, tets: rd.tets, edges: rd.edges, hull: rd.hull_vertices, facets: rd.hull_facets, tris: rd.tris,
    T: rd.T, dim: rd.dim, mode: rd.mode, perturbed: !!rd.perturbed,
    exposed: rd.exposed_ids, shielded: rd.shielded_ids,
  };
}

export function formationStats(O, cfg = CONFIG_DEFAULT) {
  let dmin = Infinity, diam = 0;
  for (let i = 0; i < O.length; i++) for (let j = i + 1; j < O.length; j++) { const d = dist(O[i], O[j]); dmin = Math.min(dmin, d); diam = Math.max(diam, d); }
  return { m: O.length, meanNN: meanNN(O), minDist: dmin, diameter: diam, flat: isFlat(O, cfg) };
}

/**
 * study(nets, O, opts) -> record. opts: {cfg, w, n ("auto" | number), referee ("quick"|"standard"|"thorough"),
 * kmeans (bool), targetFix (bool), onProgress(stage, detail)}
 */
export function study(nets, O, opts = {}) {
  const cfg = { ...CONFIG_DEFAULT, ...(opts.cfg || {}) };
  const progress = opts.onProgress || (() => {});
  const w = opts.w ?? cfg.o_weight_test;
  const refPreset = REFEREE_PRESETS[opts.referee || "standard"];
  const m = O.length;
  const rec = { version: 1, cfg, w, m, O: P4(O), stats: formationStats(O, cfg), referee: opts.referee || "standard" };

  // 1. D reads the formation (triangulation agent)
  progress("reading", "D triangulates the formation");
  const agent = new LearnedD(nets, cfg, { targetFix: opts.targetFix });
  const alive = O.map(() => true);
  const rdD = agent.reader.read(O, alive);
  rec.dReading = readingJSON(rdD);
  const run = agent.reader.runFor(O, alive);
  if (run) {
    const ids = run.ids;
    rec.flips = {
      T0: run.run.T0, T: run.run.T, budget: run.run.budget,
      delaunay: run.run.delaunay.map((t) => t.map((v) => ids[v])),
      history: run.run.history.map((h) => (h.kind === "stop" ? h : { kind: h.kind, T: h.T, d: ids[h.d], e: ids[h.e], removed: h.removed.map((t) => t.map((v) => ids[v])), added: h.added.map((t) => t.map((v) => ids[v])) })),
    };
  }

  // 2. the referee's reading (the rules), for comparison
  progress("referee", "the referee checks the formation");
  const referee = new Referee(cfg, refPreset);
  const rdR = referee.read(O, alive);
  rec.refReading = readingJSON(rdR);
  rec.readingAgrees = JSON.stringify(rec.dReading.exposed) === JSON.stringify(rec.refReading.exposed);

  // 3. team size
  progress("team", "D chooses its team size");
  const probs = agent.winProbs(O);
  const lb = agent.lowerBound(m);
  const nAuto = m <= 20 ? agent.chooseN(O) : null;
  rec.team = { probs: probs.map((p) => r4(p)), lowerBound: lb, threshold: cfg.win_threshold, nAuto };
  let n = opts.n === undefined || opts.n === "auto" ? nAuto : Number(opts.n);
  rec.team.n = n;
  rec.team.manual = !(opts.n === undefined || opts.n === "auto");
  if (n === null) { rec.outcome = "declared_cannot_win"; return rec; }

  // 4. placement
  progress("place", `D places ${n} players`);
  const pd = agent.placeDetail(O, n);
  const order = pd.scores.map((s, k) => [s, k]).sort((a, b) => b[0] - a[0]);
  const keep = new Set(order.slice(0, 120).map(([, k]) => k));
  pd.chosen.forEach((k) => keep.add(k));
  rec.placement = {
    beta: r4(nets.place.beta),
    nCandidates: pd.scores.length,
    candidates: [...keep].sort((a, b) => a - b).map((k) => ({ k, pos: P4([pd.g.candPos[k]])[0], kind: pd.g.kinds[k], cover: [...pd.g.cover[k]].sort((a, b) => a - b), score: r4(pd.scores[k]) })),
    steps: pd.steps.map((s) => ({ pick: s.pick, adjusted: r4(s.adjusted) })),
    D0: P4(pd.positions),
  };

  // 5. the game
  progress("play", "D plays the game");
  const env = new SimplexEnv(cfg, referee);
  const res = runEpisode(env, agent, O, n, w, pd.positions, (t) => progress("play", `tick ${t} of ${cfg.deadline}`));
  rec.game = summarizeGame(res);

  // 6. optional comparison: the k-means team with the same number of players
  if (opts.kmeans) {
    progress("kmeans", "the k-means team plays the same formation");
    const km = new KMeansGreedy(cfg, 0);
    const env2 = new SimplexEnv(cfg, referee);
    const res2 = runEpisode(env2, km, O, n, w, null);
    rec.kmeans = summarizeGame(res2);
  }
  rec.refereeTimeMs = Math.round(referee.stats.time_ms);
  return rec;
}

export function summarizeGame(res) {
  return {
    outcome: res.outcome, n: res.n, ticks: res.ticks, aliveLeft: res.alive_left, stats: res.stats,
    frames: res.frames, trace: res.trace.map((t) => ({ tick: t.tick, chosen: t.chosen || [], comps: t.comps, pairs: t.pairs.map((p) => ({ d: p.d, o: p.o, s: r4(p.score) })), none: (t.none || []).map(r4) })),
  };
}

/** Play the learned D at each n from lo to hi (same formation, same O weight) and report wins. */
export function scanN(nets, O, opts = {}) {
  const cfg = { ...CONFIG_DEFAULT, ...(opts.cfg || {}) };
  const w = opts.w ?? cfg.o_weight_test;
  const referee = new Referee(cfg, REFEREE_PRESETS[opts.referee || "standard"]);
  const out = [];
  for (let n = opts.lo; n <= opts.hi; n++) {
    if (opts.onProgress) opts.onProgress("scan", `n = ${n}`);
    const agent = new LearnedD(nets, cfg, { targetFix: opts.targetFix });
    const env = new SimplexEnv(cfg, referee);
    const res = runEpisode(env, agent, O, n, w, null);
    out.push({ n, outcome: res.outcome, ticks: res.ticks, aliveLeft: res.alive_left });
  }
  return out;
}
