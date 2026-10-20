import { Stage } from "./stage.js";
import { StudyView, buildPlayerBar, reducedMotion } from "./studyview.js";
import { appearTimeline, flipsTimeline, readingState, placementTimeline, gameTimeline } from "./playback.js";
import { pwinChart, lineChart, barChart } from "./charts.js";
import { initBuilder } from "./builder.js";

const DATA = "assets/data/";
const getJSON = (p) => fetch(DATA + p).then((r) => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
const $ = (s, r = document) => r.querySelector(s);
const pct = (v) => (v === null || v === undefined ? "n/a" : `${Math.round(v * 100)}%`);
const plural = (n, s, p = s + "s") => `${n} ${n === 1 ? s : p}`;

const LEGEND_GAME = '<span><i class="dot d"></i>D player and its reach</span><span><i class="dot exposed"></i>exposed O</span><span><i class="dot shielded"></i>shielded O (ringed)</span><span><i class="line nerve"></i>overlapping reach</span>';

function hudGame(st, deadline = 5) {
  return `${st.hud.tick ? `<span>tick <b>${st.hud.tick}</b> of ${deadline}</span>` : "<span>starting positions</span>"}<span><b>${st.hud.alive}</b> O left</span>`;
}

// ------------------------------------------------------------------ simple looping game player
class GamePlayer {
  constructor(stage, barEl, hudEl, { loop = false, deadline = 5 } = {}) {
    this.stage = stage; this.hudEl = hudEl; this.loop = loop; this.deadline = deadline;
    this.bar = buildPlayerBar(barEl);
    this.bar.restart.setAttribute("aria-label", "Play again");
    this.bar.scrub.setAttribute("aria-label", "Position in the game");
    this.t = 0; this.playing = false;
    this.bar.play.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.bar.restart.addEventListener("click", () => { this.t = 0; this.play(); });
    this.bar.scrub.addEventListener("input", () => { if (!this.tl) return; this.t = (this.bar.scrub.value / 1000) * this.tl.duration; this.pause(); this.render(); });
    stage.onFrame = (dt) => { if (this.playing && this.tl) { this.t += dt; if (this.t > this.tl.duration) { if (this.loop) this.t = 0; else { this.t = this.tl.duration; this.pause(); } } this.render(); } };
  }
  set(frames, opts = {}) {
    this.tl = gameTimeline(frames, opts);
    this.deadline = opts.deadline || 5;
    const pts = frames.flatMap((f) => f.O.concat(f.D));
    this.stage.fit(pts, 1.05);
    this.t = 0;
    if (reducedMotion()) { this.pause(); } else this.play();
    this.render();
  }
  play() { if (this.tl && this.t >= this.tl.duration) this.t = 0; this.playing = true; this.bar.play.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>'; this.bar.play.setAttribute("aria-label", "Pause"); }
  pause() { this.playing = false; this.bar.play.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>'; this.bar.play.setAttribute("aria-label", "Play"); }
  render() {
    const st = this.tl.stateAt(this.t);
    this.stage.show(st);
    this.hudEl.innerHTML = hudGame(st, this.deadline);
    this.bar.scrub.value = String(Math.round((this.t / this.tl.duration) * 1000));
    this.bar.time.textContent = st.hud.tick ? `tick ${st.hud.tick}` : "placement";
  }
}

// ------------------------------------------------------------------ hero: the tour formation on a loop
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
function initHero(tour) {
  const w = (n) => WORDS[n] || String(n);
  const g = tour.game;
  $(".hero .lede").textContent = `${w(tour.m).charAt(0).toUpperCase() + w(tour.m).slice(1)} players hold a 3D formation. A learned team reads its shape, decides it needs ${w(tour.team.n)} players, picks where to stand and ${g.outcome === "win" ? `removes everyone in ${w(g.ticks)} ticks` : "plays out the five ticks"}. This page shows how, step by step, and lets you build a formation for it to counter.`;
  const host = $("#hero-stage");
  const stage = new Stage(host, { autoRotate: !reducedMotion() });
  const seq = [
    [appearTimeline(tour, true), 0.4],
    [flipsTimeline(tour), 0.2],
    [{ duration: 1.6, stateAt: () => readingState(tour, "d") }, 0],
    [placementTimeline(tour), 0.6],
    [gameTimeline(tour.game.frames, { r: tour.cfg.r }), 2.5],
  ];
  const total = seq.reduce((s, [tl, hold]) => s + tl.duration + hold, 0);
  const pts = tour.O.concat(tour.placement.D0);
  const place = () => {
    const wide = window.innerWidth > 900;
    stage.setShift(wide ? 0.24 : 0);
    stage.fit(pts, wide ? 1.35 : 1.0);
  };
  place();
  window.addEventListener("resize", place);
  let t = reducedMotion() ? seq[0][0].duration + seq[1][0].duration + 1 : 0;
  const at = (tt) => {
    let acc = 0;
    for (const [tl, hold] of seq) { if (tt < acc + tl.duration + hold) return tl.stateAt(Math.min(tl.duration, tt - acc)); acc += tl.duration + hold; }
    return seq[seq.length - 1][0].stateAt(1e9);
  };
  stage.onFrame = (dt) => {
    if (!reducedMotion()) t = (t + dt) % total;
    stage.show(at(t));
  };
}

// ------------------------------------------------------------------ walkthrough
function initTour(tour) {
  const root = $("#tour");
  const stage = new Stage($("#tour-stage"));
  const view = new StudyView({
    stage, stepsEl: $(".steps", root), textEl: $(".step-text", root), barEl: $(".player-bar", root),
    hudEl: $(".stage-hud", root), legendEl: $(".stage-legend", root),
  });
  view.setRecord(tour, 0);
  view.pause();
  // start the first step when the section scrolls into view
  let started = false;
  new IntersectionObserver((es) => { if (!started && es.some((e) => e.isIntersecting)) { started = true; view.goTo(0); } }, { threshold: 0.3 }).observe(root);
}

// ------------------------------------------------------------------ formation size
function initSize(results) {
  const slider = $("#m-slider"), out = $("#m-out");
  $(".size-control .ticks").innerHTML = Array.from({ length: 17 }, (_, i) => `<span>${i + 4}</span>`).join("");
  const frameEl = $(".size-grid .stage-frame");
  const stage = new Stage($("#size-stage"));
  const player = new GamePlayer(stage, $(".size-bar"), $(".stage-hud", frameEl));
  $(".stage-legend", frameEl).innerHTML = LEGEND_GAME;
  const facts = $(".size-facts");
  const cache = new Map();
  let token = 0;
  async function load(m) {
    out.textContent = m;
    const my = ++token;
    facts.setAttribute("aria-busy", "true");
    const rec = cache.get(m) || (await getJSON(`gallery/m${m}.json`));
    cache.set(m, rec);
    if (my !== token) return;
    facts.removeAttribute("aria-busy");
    player.set(rec.game.frames, { r: rec.cfg.r, deadline: rec.cfg.deadline });
    const t = rec.test, g = rec.game;
    const wins = t.replay.filter((r) => r.outcome === "win").length;
    facts.innerHTML = `
      <h3>Test formation ${t.key.replace("test-", "")}</h3>
      <p>A <em>${t.family}</em> formation of ${m} players, ${plural(rec.refReading.shielded.length, "player")} shielded at the start. Even if every exposed player fell each round, it would take ${plural(t.peel, "round")} to clear it.</p>
      <figure class="chart"></figure>
      <ul class="fact-list">
        <li><span>D's team size</span><b>${rec.team.n}</b></li>
        <li><span>planner's team size</span><b>${t.nStar}</b></li>
        <li><span>this game</span><b>${g.outcome === "win" ? `won in ${plural(g.ticks, "tick")}` : `lost, ${g.aliveLeft} left`}</b></li>
        <li><span>wins over the five test behaviours</span><b>${wins} of ${t.replay.length}</b></li>
        <li><span>k-means team, ${g.n} players</span><b>${rec.kmeans.outcome === "win" ? `won in ${plural(rec.kmeans.ticks, "tick")}` : `lost, ${rec.kmeans.aliveLeft} left`}</b></li>
      </ul>
      <p class="note small">The project's own evaluation recorded ${t.recorded.own ?? "n/a"} of 5 wins for this formation, with its referee.</p>`;
    pwinChart($("figure", facts), { probs: rec.team.probs, lowerBound: rec.team.lowerBound, threshold: rec.team.threshold, chosen: rec.team.n, m, nStar: t.nStar, compact: true, title: "D's estimated chance to win" });
  }
  let deb = null;
  slider.addEventListener("input", () => { out.textContent = slider.value; clearTimeout(deb); deb = setTimeout(() => load(Number(slider.value)), 120); });
  load(Number(slider.value));
  // test-set charts
  const rows = results.byM;
  const xs = rows.map((r) => r.m);
  lineChart($("#chart-by-m"), {
    title: "Wins across the whole test set", sub: "850 formations, five games each. Planner's size = the smallest team the planner always wins with.",
    xs, xLabel: "O players", series: [
      { name: "learned D, its own team size", short: "own size", color: "var(--s-learned)", values: rows.map((r) => r.learnedOwn) },
      { name: "learned D, planner's team size", short: "planner's size", color: "var(--s-learned)", dash: "5 4", values: rows.map((r) => r.learnedAtNStar) },
      { name: "k-means team, planner's team size", short: "k-means", color: "var(--s-kmeans)", values: rows.map((r) => r.kmeansAtNStar) },
    ],
  });
  barChart($("#chart-extra"), {
    title: "Extra players D takes, compared with the planner", sub: "Average of D's team size minus the planner's, per formation size.",
    xs, values: rows.map((r) => r.extra), xLabel: "O players", yFmt: (v) => (v >= 0 ? "+" : "") + v.toFixed(1), yMin: -0.5, yMax: 1.5,
  });
}

// ------------------------------------------------------------------ settings
const PARAMS = [
  { id: "win_threshold", name: "Confidence target", what: "How sure the team-size network must be before it settles on a team size. A lower target means smaller teams and more losses; a higher one means bigger teams.", unit: "", fmt: (v) => `${Math.round(v * 100)}%` },
  { id: "support_length", name: "Support length", what: "An edge shorter than this counts as supported. An inner player is shielded only when every edge of every tetrahedron around it is supported, so a longer support length shields more players.", fmt: (v) => v },
  { id: "spacing", name: "Spacing", what: "The average distance between neighbouring O players, in units of D's reach. Tight formations have short edges, so more players are shielded; spread-out formations are easier to read but take longer to cross.", fmt: (v) => v, trainedText: "0.5 to 1.2" },
  { id: "r", name: "Reach", what: "How close a D player must be to hit an O player; also the radius of its sphere of influence. The networks measure distances in this unit.", fmt: (v) => v },
  { id: "v_D", name: "D speed", what: "How far a D player can move in one tick.", fmt: (v) => v },
  { id: "v_O", name: "O speed", what: "How far an O player can move in one tick. At 0 the formation stands still.", fmt: (v) => v },
  { id: "deadline", name: "Ticks", what: "How many ticks D has to remove everyone. Fewer ticks need more players, since each D player removes at most one O player per tick.", fmt: (v) => v },
  { id: "cohesion_length", name: "Regrouping distance", what: "O players pull back toward Delaunay neighbours that are farther away than this. A short distance makes the formation cling together; a long one lets it scatter.", fmt: (v) => v },
  { id: "w", name: "O's flee weight", what: "How O mixes its two urges: 0 means only regroup, 1 means only flee from the nearest D player. Training used values between 0.3 and 0.7; the test used varied values in that range.", fmt: (v) => v, trainedText: "0.3 to 0.7" },
];

async function initSettings(builderApi) {
  const tabs = $(".param-tabs"), panel = $(".param-panel");
  let geometry = null;
  try { geometry = await getJSON("geometry.json"); } catch (e) { geometry = null; }
  const notes = await getJSON("sweep_notes.json").catch(() => ({}));
  tabs.innerHTML = PARAMS.map((p, i) => `<button class="chip" role="tab" id="tab-${p.id}" aria-selected="${i === 0}" data-i="${i}">${p.name}</button>`).join("");
  const cache = new Map();
  async function show(i) {
    const p = PARAMS[i];
    tabs.querySelectorAll("button").forEach((b, k) => b.setAttribute("aria-selected", String(k === i)));
    panel.setAttribute("aria-labelledby", `tab-${p.id}`);
    let sw = cache.get(p.id);
    if (!sw) { try { sw = await getJSON(`sweeps/${p.id}.json`); cache.set(p.id, sw); } catch (e) { sw = null; } }
    const trained = Array.isArray(sw?.trained) ? sw.trained : sw ? [sw.trained, sw.trained] : null;
    const trainedText = p.trainedText || (sw ? p.fmt(sw.trained) : "");
    panel.innerHTML = `
      <div>
        <h3>${p.name}</h3>
        <p>${p.what}</p>
        <span class="trained">Trained with ${trainedText}</span>
        <p class="sweep-note">${notes[p.id] || ""}</p>
        <div class="actions"><button class="btn small" type="button" data-try>Try a value in the builder</button></div>
      </div>
      <div class="charts"><figure class="chart c1"></figure><figure class="chart c2"></figure></div>`;
    panel.querySelector("[data-try]").addEventListener("click", () => builderApi && builderApi.openWithParam(p.id));
    if (!sw) { panel.querySelector(".charts").innerHTML = `<p class="msg">This study has not been computed yet.</p>`; return; }
    const xs = sw.rows.map((r) => r.value);
    const band = trained && trained[0] !== trained[1] ? trained : null;
    const refX = trained && trained[0] === trained[1] ? trained[0] : null;
    lineChart($(".c1", panel), { title: "Wins at D's own team size", sub: `${sw.formations.length} test formations, one game each.`, xs, xLabel: p.name.toLowerCase(), xFmt: p.fmt, series: [{ name: "learned D", color: "var(--s-learned)", values: sw.rows.map((r) => r.win) }], band, refX, H: 230 });
    if (geometry && geometry[p.id]) {
      const gs = geometry[p.id];
      lineChart($(".c2", panel), { title: "Formations with a shielded player at the start", sub: `${geometry.formations} test formations, geometry only.`, xs: gs.map((r) => r.value), xLabel: p.name.toLowerCase(), xFmt: p.fmt, series: [{ name: "share", color: "var(--o-shielded)", values: gs.map((r) => r.anyShielded) }], band, refX, H: 230 });
    } else {
      const ns = sw.rows.map((r) => r.meanN);
      lineChart($(".c2", panel), { title: "Average team size D chooses", sub: "Same games.", xs, xLabel: p.name.toLowerCase(), xFmt: p.fmt, yMin: 0, yMax: Math.ceil(Math.max(...ns) + 1), yFmt: (v) => v.toFixed(1), series: [{ name: "team size", color: "var(--s-learned)", values: ns }], band, refX, H: 230 });
    }
  }
  tabs.addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) show(Number(b.dataset.i)); });
  tabs.addEventListener("keydown", (e) => {
    const cur = [...tabs.children].findIndex((b) => b.getAttribute("aria-selected") === "true");
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = (cur + (e.key === "ArrowRight" ? 1 : PARAMS.length - 1)) % PARAMS.length; show(n); tabs.children[n].focus(); }
  });
  show(0);
}

// ------------------------------------------------------------------ what it learned
function initLearned(results, demos) {
  const sb = $("#scoreboard");
  const row = (label, v, color, note) => `<div class="score-row"><span>${label}</span><span class="bar"><i style="width:${v * 100}%;background:${color}"></i></span><b>${pct(v)}</b></div>${note ? `<div class="score-note">${note}</div>` : ""}`;
  sb.innerHTML = `<h3>Wins at the planner's team size</h3>
    <p class="small">All 850 test formations, five games each, every team with the same number of players as the planner needed.</p>
    ${row("planner", 1, "var(--ink-2)", "By definition: its team size is the smallest one where it wins all five.")}
    ${row("learned D", results.triReading.atNStar, "var(--s-learned)", "Reading the formation with its own triangulation agent. Given the referee's correct reading instead: " + pct(results.refereeReading.atNStar) + ".")}
    ${row("k-means team", results.kmeansAtNStar, "var(--s-kmeans)", "Places players at k-means cluster centres, then chases and matches targets greedily.")}
    ${row("random team", results.randomAtNStar, "var(--ink-3)", "Random placement, then each player hits the nearest exposed O player.")}
    <p class="small">With its own choice of team size, the learned D wins ${pct(results.triReading.own)}.</p>`;
  // recorded comparisons
  const cases = [];
  for (const d of demos) {
    const key = d.title.split(":")[0];
    let c = cases.find((x) => x.key === key);
    if (!c) { c = { key, eps: {} }; cases.push(c); }
    c.eps[d.agent] = d;
  }
  const NAMES = { case1_small: "6 players, nobody shielded", case2_large: "18-player lattice, 4 shielded", case3_no_shielding: "10 players in clusters", case4_peel2: "14-player ball, two layers" };
  const TEAMS = [["learned", "learned D"], ["planner", "planner"], ["kmeans_greedy", "k-means team"]];
  const ctl = $(".compare-controls");
  ctl.innerHTML = `<label for="case-sel">Formation</label><select id="case-sel">${cases.map((c, i) => `<option value="${i}">${NAMES[c.key] || c.key}</option>`).join("")}</select>
    <div class="seg" role="group" aria-label="Team">${TEAMS.map(([k, n], i) => `<button type="button" data-team="${k}" aria-pressed="${i === 0}">${n}</button>`).join("")}</div>`;
  const frameEl = $(".compare-grid .stage-frame");
  const stage = new Stage($("#compare-stage"));
  const player = new GamePlayer(stage, $(".compare-bar"), $(".stage-hud", frameEl));
  $(".stage-legend", frameEl).innerHTML = LEGEND_GAME;
  let ci = 0, team = "learned";
  const facts = $(".compare-facts");
  function show() {
    const c = cases[ci];
    const d = c.eps[team];
    ctl.querySelectorAll("[data-team]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.team === team)));
    player.set(d.frames, { r: d.cfg.r, deadline: d.cfg.deadline });
    const rowsHtml = TEAMS.filter(([k]) => c.eps[k]).map(([k, n]) => { const e = c.eps[k]; return `<li><span>${n}</span><b>${e.outcome === "win" ? `won in ${plural(e.ticks, "tick")}` : `lost, ${e.frames[e.frames.length - 1].alive.filter((a) => a).length} left`}</b></li>`; }).join("");
    facts.innerHTML = `<h3>${NAMES[c.key] || c.key}</h3><p class="small">${d.m} O players, ${d.n} D players for every team, O flee weight ${d.w}.</p><ul class="fact-list">${rowsHtml}</ul>`;
  }
  $("#case-sel").addEventListener("change", (e) => { ci = Number(e.target.value); show(); });
  ctl.querySelectorAll("[data-team]").forEach((b) => b.addEventListener("click", () => { team = b.dataset.team; show(); }));
  ci = 1; $("#case-sel").value = "1";
  show();
}

// ------------------------------------------------------------------ boot
async function boot() {
  const [tour, results, demos] = await Promise.all([getJSON("tour.json"), getJSON("results.json"), getJSON("recorded_demos.json")]);
  initHero(tour);
  initTour(tour);
  initSize(results);
  const builderApi = initBuilder();
  initSettings(builderApi);
  initLearned(results, demos);
}
boot().catch((e) => {
  console.error(e);
  const m = document.createElement("p");
  m.className = "msg err wrap";
  m.textContent = `The page could not load its data (${e.message}). If you opened index.html straight from your disk, serve the folder instead (for example with "python3 -m http.server") or open the GitHub Pages link.`;
  document.querySelector("main").prepend(m);
});
