// The step-by-step view of one study: formation, Delaunay, flips, reading, team size, placement, play, result.
import { appearTimeline, flipsTimeline, readingState, placementTimeline, gameTimeline } from "./playback.js";
import { pwinChart } from "./charts.js";

export const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const pct = (v) => `${Math.round(v * 100)}%`;
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const plural = (n, s, p = s + "s") => `${n} ${n === 1 ? s : p}`;

const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>',
  restart: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3a5 5 0 1 1-4.6 3H1.2A7 7 0 1 0 8 1V0L4.5 2.5 8 5z"/></svg>',
};

const LEG = {
  neutral: '<span><i class="dot" style="background:#b7c1cd"></i>O player, not yet read</span>',
  exposed: '<span><i class="dot exposed"></i>exposed O</span>',
  shielded: '<span><i class="dot shielded"></i>shielded O (ringed)</span>',
  d: '<span><i class="dot d"></i>D player and its reach</span>',
  supp: '<span><i class="line"></i>edge shorter than the support length</span>',
  unsupp: '<span><i class="line dash"></i>longer edge</span>',
  cand: '<span><i class="dot cand"></i>candidate spot (larger = higher score)</span>',
  nerve: '<span><i class="line nerve"></i>D players whose reach overlaps</span>',
  hit: '<span><i class="line" style="border-color:#fff"></i>hit</span>',
};

export function buildPlayerBar(host) {
  host.innerHTML = `
    <button class="icon-btn pb-play" type="button" aria-label="Play">${ICON.play}</button>
    <button class="icon-btn pb-restart" type="button" aria-label="Play this step again">${ICON.restart}</button>
    <input class="scrub" type="range" min="0" max="1000" value="0" aria-label="Position in this step">
    <span class="time"></span>`;
  return { play: host.querySelector(".pb-play"), restart: host.querySelector(".pb-restart"), scrub: host.querySelector(".scrub"), time: host.querySelector(".time") };
}

export class StudyView {
  constructor({ stage, stepsEl, textEl, barEl, hudEl, legendEl, kind = "tour", onStep = null }) {
    this.stage = stage;
    this.stepsEl = stepsEl; this.textEl = textEl; this.hudEl = hudEl; this.legendEl = legendEl;
    this.kind = kind; this.onStep = onStep;
    this.bar = buildPlayerBar(barEl);
    this.t = 0; this.playing = false; this.speed = 1;
    this.bar.play.addEventListener("click", () => this.toggle());
    this.bar.restart.addEventListener("click", () => { this.t = 0; this.play(); });
    this.bar.scrub.addEventListener("input", () => { if (!this.tl) return; this.t = (this.bar.scrub.value / 1000) * this.tl.duration; this.pause(); this.render(); });
    stage.onFrame = (dt) => this.frame(dt);
  }

  setRecord(rec, step = 0) {
    this.rec = rec;
    this.steps = this.makeSteps(rec);
    this.stepsEl.innerHTML = this.steps.map((s, i) => `<li><button type="button" data-i="${i}">${s.title}</button></li>`).join("");
    this.stepsEl.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => this.goTo(Number(b.dataset.i))));
    this.stage.fit(rec.O.concat(rec.placement ? rec.placement.D0 : []), 1.15);
    this.goTo(step);
  }

  goTo(i, autoplay = true) {
    if (!this.steps || i < 0 || i >= this.steps.length) return;
    this.i = i;
    const s = this.steps[i];
    this.tl = s.timeline();
    this.stepsEl.querySelectorAll("button").forEach((b, k) => { b.setAttribute("aria-current", k === i ? "step" : "false"); b.classList.toggle("done", k < i); });
    this.textEl.innerHTML = "";
    s.text(this.textEl);
    const nav = document.createElement("div");
    nav.className = "actions";
    nav.style.marginTop = "18px";
    if (i > 0) nav.insertAdjacentHTML("beforeend", `<button type="button" class="btn small" data-go="${i - 1}">Back</button>`);
    if (i < this.steps.length - 1) nav.insertAdjacentHTML("beforeend", `<button type="button" class="btn small primary" data-go="${i + 1}">Next: ${this.steps[i + 1].title}</button>`);
    nav.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => this.goTo(Number(b.dataset.go))));
    this.textEl.appendChild(nav);
    this.legendEl.innerHTML = (s.legend || []).map((k) => LEG[k]).join("");
    const still = (reducedMotion() && !s.isGame) || s.startAtEnd;
    this.t = still ? this.tl.duration : 0;
    if (autoplay && !still && !(reducedMotion() && s.isGame)) this.play(); else this.pause();
    this.render();
    if (this.onStep) this.onStep(i, s);
  }

  play() { if (this.t >= (this.tl?.duration ?? 0) - 1e-3) this.t = 0; this.playing = true; this.bar.play.innerHTML = ICON.pause; this.bar.play.setAttribute("aria-label", "Pause"); }
  pause() { this.playing = false; this.bar.play.innerHTML = ICON.play; this.bar.play.setAttribute("aria-label", "Play"); }
  toggle() { this.playing ? this.pause() : this.play(); }

  frame(dt) {
    if (!this.tl) return;
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t >= this.tl.duration) { this.t = this.tl.duration; this.pause(); }
      this.render();
    }
  }

  render() {
    const st = this.tl.stateAt(this.t);
    this.stage.show(st);
    this.bar.scrub.value = String(Math.round((this.t / this.tl.duration) * 1000));
    const s = this.steps[this.i];
    this.bar.time.textContent = s.timeLabel ? s.timeLabel(this.t, st) : "";
    this.hudEl.innerHTML = s.hud ? s.hud(st, this.t) : "";
    if (s.onRender) s.onRender(st, this.t);
  }

  // --------------------------------------------------------------------------------------------- steps
  makeSteps(rec) {
    const m = rec.m;
    const cfg = rec.cfg;
    const steps = [];
    const dR = rec.dReading, refR = rec.refReading;
    const fl = rec.flips;
    const test = rec.test;
    steps.push({
      title: "The formation", legend: ["neutral"],
      timeline: () => appearTimeline(rec, false),
      hud: () => `<span><b>${m}</b> O players</span>`,
      text: (el) => {
        el.innerHTML = `<h3>The formation</h3>
          <p>${m} O players${test ? `, a <em>${test.family}</em> formation from the test set` : ""}. On average each one is ${f2(rec.stats.meanNN)} units from its nearest neighbour, where 1 unit is the reach of a D player.</p>
          <p class="note">Both teams see every position at every moment, so D can study the whole shape before it commits to anything.</p>`;
      },
    });
    if (rec.stats.flat || dR.dim < 3) {
      steps.push({
        title: "Who is shielded", legend: ["exposed"],
        timeline: () => ({ duration: 0.5, stateAt: () => readingState(rec, "d") }),
        text: (el) => { el.innerHTML = `<h3>A flat formation</h3><p>These players lie (nearly) on one plane or line, so the formation cannot be split into tetrahedra. Under the rules nobody can be shielded: every player is exposed from the start.</p>`; },
      });
    } else {
      steps.push({
        title: "Start from Delaunay", legend: ["neutral", "supp"],
        timeline: () => appearTimeline(rec, true), startAtEnd: false,
        hud: () => `<span><b>${fl ? fl.T0 : dR.T}</b> tetrahedra</span>`,
        text: (el) => {
          el.innerHTML = `<h3>Start from the Delaunay split</h3>
            <p>D first splits the formation into tetrahedra the standard way: the Delaunay triangulation, where no tetrahedron's circumsphere contains another player. Here that gives ${fl ? fl.T0 : dR.T} tetrahedra.</p>
            <p class="note">It is a valid split, but rarely the one with the fewest pieces, and the rules are defined on the split with the fewest.</p>`;
        },
      });
      steps.push({
        title: "Flip to fewer pieces", legend: ["neutral", "supp"],
        timeline: () => flipsTimeline(rec),
        hud: (st) => `<span><b>${st.hud.T}</b> tetrahedra</span><span>flip <b>${Math.min(st.hud.flips, fl ? fl.history.filter((h) => h.kind !== "stop").length : 0)}</b> of ${fl ? fl.history.filter((h) => h.kind !== "stop").length : 0}</span>${st.hud.kind ? `<span>${st.hud.kind === "23" ? "2 to 3" : "3 to 2"} flip</span>` : ""}`,
        timeLabel: (t, st) => (st.hud.done ? "done" : ""),
        text: (el) => {
          const k = fl ? fl.history.filter((h) => h.kind !== "stop").length : 0;
          const n23 = fl ? fl.history.filter((h) => h.kind === "23").length : 0;
          const best = fl ? fl.T : dR.T;
          el.innerHTML = `<h3>Flip to fewer tetrahedra</h3>
            <p>The triangulation agent, a trained network, changes the split one flip at a time. A <em>3-2 flip</em> replaces three tetrahedra around an edge with two, removing that edge. A <em>2-3 flip</em> does the reverse, which costs one piece now but can open better flips later.</p>
            <p>Every split of the same players has <em>E = m + h + T − 3</em> edges, where h counts players on the outer surface, so fewer tetrahedra always means fewer edges.</p>
            <ul class="fact-list">
              <li><span>Delaunay</span><b>${fl ? fl.T0 : dR.T}</b></li>
              <li><span>after ${plural(k, "flip")} (${n23} of them 2-3)</span><b>${best}</b></li>
              <li><span>the referee's own search</span><b>${refR.T}</b></li>
            </ul>
            <p class="note">The highlighted edge is the one each flip adds or removes. The agent keeps the best split it has seen and stops by itself.</p>`;
        },
      });
      steps.push({
        title: "Who is shielded", legend: ["exposed", "shielded", "supp", "unsupp"],
        timeline: () => ({ duration: 0.8, stateAt: (t) => ({ ...readingState(rec, "d"), hullAlpha: Math.min(1, t / 0.6) }) }),
        hud: (st) => `<span><b>${st.hud.exposed}</b> exposed</span><span><b>${st.hud.shielded}</b> shielded</span>`,
        text: (el) => {
          const agrees = rec.readingAgrees;
          el.innerHTML = `<h3>Who is shielded</h3>
            <p>Players on the outer surface are always exposed. An inner player is shielded when every tetrahedron it belongs to has all six edges shorter than ${cfg.support_length} units (solid lines). One long edge (dashed) leaves it exposed.</p>
            <ul class="fact-list"><li><span>exposed now</span><b>${dR.exposed.length}</b></li><li><span>shielded now</span><b>${dR.shielded.length}</b></li></ul>
            <p class="note">${agrees ? "D's reading matches the referee's: the same players are exposed." : `D's reading differs from the referee's (the referee finds ${refR.shielded.length} shielded). A hit on a player D wrongly thinks is exposed is blocked.`} Shielded players can only be removed after their outer neighbours are gone, so D must peel the formation from the outside in.</p>`;
        },
      });
    }
    steps.push({
      title: "How many players", legend: ["exposed", "shielded"],
      timeline: () => ({ duration: 0.4, stateAt: () => readingState(rec, "d") }),
      text: (el) => {
        const tm = rec.team;
        const n = tm.n;
        el.innerHTML = `<h3>How many players</h3>
          <p>Each D player can remove at most one O player per tick, so with ${m} players and ${cfg.deadline} ticks D needs at least ${tm.lowerBound}. The team-size network looks at the formation and estimates D's chance of winning with each team size.</p>
          <figure class="chart"></figure>
          <p>${n === null ? "No team size reaches the target, so D declares it cannot win." : tm.manual ? `You fixed the team at ${n}. On its own D would have taken ${tm.nAuto ?? "none"}.` : `D takes <strong>${n}</strong>: the smallest team with an estimated chance of at least ${pct(tm.threshold)} (it estimates ${pct(tm.probs[n - 1])}).`}${test ? ` For this test formation the planner, which searched for the smallest team that wins every time, needed ${test.nStar}.` : ""}</p>`;
        pwinChart(el.querySelector("figure"), { probs: tm.probs, lowerBound: tm.lowerBound, threshold: tm.threshold, chosen: n, m, nStar: test ? test.nStar : null, compact: true });
      },
    });
    if (rec.placement) {
      steps.push({
        title: "Where to stand", legend: ["cand", "d", "exposed", "shielded"],
        timeline: () => placementTimeline(rec),
        hud: (st) => `<span><b>${st.hud.placed}</b> of ${st.hud.n} placed</span><span><b>${st.hud.candidates}</b> candidate spots</span>`,
        text: (el) => {
          const pl = rec.placement;
          el.innerHTML = `<h3>Where to stand</h3>
            <p>D considers ${pl.nCandidates} candidate spots: the O players' own positions, midpoints of close pairs, and the centres of the triangles and tetrahedra in its reading. The placement network gives each spot a score.</p>
            <p>It then picks ${rec.team.n} spots one at a time, each time lowering the score of spots whose reach covers players that are already covered. That spreads the team over the formation instead of piling it on the best spot.</p>
            <p class="note">The lines show which O players the newest D player can reach from its spot.</p>`;
        },
      });
    }
    if (rec.game) {
      const gt = () => gameTimeline(rec.game.frames, { r: cfg.r });
      let tlCache = null;
      steps.push({
        title: "Play the ticks", legend: ["d", "exposed", "shielded", "nerve", "hit"], isGame: true,
        timeline: () => (tlCache = gt()),
        hud: (st) => `<span>tick <b>${st.hud.tick}</b> of ${cfg.deadline}</span><span><b>${st.hud.alive}</b> O left</span>${st.hud.phase ? `<span>${{ start: "start", move: "moving", read: "reading", hit: "hitting", clear: "removing", end: "end" }[st.hud.phase]}</span>` : ""}`,
        timeLabel: (t, st) => (st.hud.tick ? `tick ${st.hud.tick}` : "placement"),
        text: (el) => {
          const facts = tlCache ? tlCache.facts : [];
          el.innerHTML = `<h3>Play the ticks</h3>
            <p>Each tick, every player moves at once. O flees the nearest D player while keeping its formation together. Then the referee reads the formation again and each D player may hit one exposed O player within its reach.</p>
            <ol class="tick-log">${facts.map((f) => `<li data-tick="${f.tick}"><strong>Tick ${f.tick}.</strong> ${plural(f.hits, "hit")}, ${f.elim} removed${f.blocked ? `, ${f.blocked} blocked by a shield` : ""}${f.wasted ? `, ${f.wasted} wasted` : ""}. ${f.opened ? `${plural(f.opened, "shielded player")} ${f.opened === 1 ? "is" : "are"} now exposed. ` : ""}${f.aliveAfter ? `${f.aliveAfter} left.` : "None left."}</li>`).join("")}</ol>
            <p class="note">Pink lines join D players whose reach overlaps. Each such group shares out its targets so that no two players hit the same O player.</p>`;
        },
        onRender: (st) => {
          this.textEl.querySelectorAll(".tick-log li").forEach((li) => li.classList.toggle("now", Number(li.dataset.tick) === st.hud.tick));
        },
      });
      steps.push({
        title: "Result", legend: ["d", "exposed", "shielded"], startAtEnd: true,
        timeline: () => { const g = gt(); return { duration: g.duration, stateAt: (t) => g.stateAt(t) }; },
        hud: (st) => `<span><b>${st.hud.alive}</b> O left</span>`,
        text: (el) => {
          const g = rec.game;
          const won = g.outcome === "win";
          let rows = `<li><span>outcome</span><b>${won ? `won in ${plural(g.ticks, "tick")}` : `lost, ${g.aliveLeft} O left`}</b></li>
            <li><span>D players used</span><b>${g.n}</b></li>
            <li><span>hits blocked by a shield</span><b>${g.stats.blocked}</b></li>`;
          if (test) rows += `<li><span>planner's team size for this formation</span><b>${test.nStar}</b></li>`;
          if (rec.kmeans) rows += `<li><span>k-means team with ${g.n} players</span><b>${rec.kmeans.outcome === "win" ? `won in ${plural(rec.kmeans.ticks, "tick")}` : `lost, ${rec.kmeans.aliveLeft} left`}</b></li>`;
          let rep = "";
          if (test && test.replay && test.replay.length) {
            const w = test.replay.filter((r) => r.outcome === "win").length;
            rep = `<p class="note">The test set plays every formation with five O behaviours (different mixes of fleeing and regrouping). Here the learned D won ${w} of ${test.replay.length} of them${test.recorded.own !== null ? `, and the project's own evaluation recorded ${test.recorded.own} of 5` : ""}.</p>`;
          }
          el.innerHTML = `<h3>${won ? "Every O player removed" : "Time ran out"}</h3>
            <ul class="fact-list">${rows}</ul>${rep}
            <p class="note">The O behaviour in this game: weight ${f2(rec.w)} on fleeing, ${f2(1 - rec.w)} on regrouping.</p>`;
        },
      });
    }
    return steps;
  }
}
