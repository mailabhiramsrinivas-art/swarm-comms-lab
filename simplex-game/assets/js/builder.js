// Formation builder: place O players in 3D, then let the learned D study and play your formation.
import { MOUSE, TOUCH } from "three";
import { Stage } from "./stage.js";
import { StudyView } from "./studyview.js";

const $ = (s, r = document) => r.querySelector(s);
const r3 = (x) => Math.round(x * 1000) / 1000;
const DEFAULTS = { r: 1.0, v_D: 0.5, v_O: 0.4, deadline: 5, support_length: 4.0, cohesion_length: 2.0, win_threshold: 0.9 };
const ADV = [
  { id: "r", label: "Reach of a D player", min: 0.3, max: 3, step: 0.05 },
  { id: "v_D", label: "D speed per tick", min: 0.05, max: 2, step: 0.05 },
  { id: "v_O", label: "O speed per tick (0 = still)", min: 0, max: 2, step: 0.05 },
  { id: "deadline", label: "Ticks", min: 1, max: 12, step: 1 },
  { id: "support_length", label: "Support length", min: 0.5, max: 10, step: 0.1 },
  { id: "cohesion_length", label: "Regrouping distance", min: 0.2, max: 10, step: 0.1 },
  { id: "win_threshold", label: "Confidence target", min: 0.3, max: 0.99, step: 0.01 },
];
const FAMILIES = [["ball", "ball"], ["shell", "hollow shell"], ["clusters", "clusters"], ["layers", "layers"], ["filament", "filament"], ["lattice", "lattice"]];

class EngineClient {
  constructor() {
    this.w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.next = 1; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this._res = res; this._rej = rej; });
    this.w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "ready") { this._res(); return; }
      const p = this.pending.get(m.id);
      if (m.type === "error" && m.id === null) { this._rej(new Error(m.message)); return; }
      if (!p) return;
      if (m.type === "progress") p.onProgress && p.onProgress(m.stage, m.detail);
      else if (m.type === "result") { this.pending.delete(m.id); p.res(m.rec); }
      else if (m.type === "error") { this.pending.delete(m.id); p.rej(new Error(m.message)); }
    };
    this.w.onerror = (e) => this._rej(new Error(e.message || "worker failed to start"));
  }
  call(type, payload, onProgress) {
    const id = this.next++;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej, onProgress }); this.w.postMessage({ id, type, payload }); });
  }
}

export function initBuilder() {
  const tools = $(".builder-tools"), sets = $(".builder-settings");
  const frameEl = $(".builder-frame");
  const stage = new Stage($("#builder-stage"));
  const hud = $(".stage-hud", frameEl), legend = $(".stage-legend", frameEl), hint = $(".edit-hint", frameEl);
  const stepsBox = $(".builder-steps");
  const engine = new EngineClient();
  let engineErr = null;
  engine.ready.catch((e) => { engineErr = e; status(`The in-browser engine could not start: ${e.message}`, "err"); });

  const state = { O: [], mode: "add", z: 0, sel: null, preview: null, view: null, running: false, lastRec: null, testKey: null, undo: [] };

  // ------------------------------------------------------------ tools panel
  tools.innerHTML = `
    <div class="panel-title">Start from</div>
    <div class="field"><span class="field-label">A preset shape</span>
      <div class="mini-grid">
        <label class="hint">shape<select id="b-family">${FAMILIES.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></label>
        <label class="hint">players<input id="b-m" type="number" min="4" max="20" value="12"></label>
        <label class="hint">spacing<input id="b-spacing" type="number" min="0.3" max="3" step="0.05" value="0.85"></label>
        <label class="hint">variant<input id="b-seed" type="number" min="1" max="999" value="1"></label>
      </div>
      <button class="btn small" type="button" id="b-gen">Make this shape</button></div>
    <div class="field"><span class="field-label">A test formation</span>
      <div class="mini-grid">
        <label class="hint">players<select id="b-test-m">${Array.from({ length: 17 }, (_, i) => `<option value="${i + 4}">${i + 4}</option>`).join("")}</select></label>
        <label class="hint">number (0 to 49)<input id="b-test-i" type="number" min="0" max="49" value="0"></label>
      </div>
      <button class="btn small" type="button" id="b-test">Load it</button><span class="hint" id="b-test-note"></span></div>
    <div class="panel-title">Edit</div>
    <div class="seg" role="group" aria-label="Editing tool" id="b-mode">
      <button type="button" data-mode="add" aria-pressed="true">Add</button><button type="button" data-mode="move" aria-pressed="false">Move</button><button type="button" data-mode="delete" aria-pressed="false">Delete</button><button type="button" data-mode="view" aria-pressed="false">Turn</button>
    </div>
    <div class="field" style="margin-top:12px"><label for="b-z">Height of new players: <output id="b-z-out">0.0</output></label>
      <input id="b-z" type="range" min="-3" max="3" step="0.1" value="0"><span class="hint">Selected player: arrow keys up and down change its height.</span></div>
    <div class="field-row">
      <button class="btn small" type="button" id="b-undo">Undo</button>
      <button class="btn small" type="button" id="b-rescale">Fit to training spacing</button>
      <button class="btn small" type="button" id="b-clear">Clear</button>
    </div>
    <div id="b-msgs"></div>
    <details class="more"><summary>Coordinates</summary><table class="pt-table"><tbody id="b-table"></tbody></table>
      <div class="field-row" style="margin-top:8px"><button class="btn small" type="button" id="b-export">Download as JSON</button>
      <label class="btn small" for="b-import">Open a JSON file</label><input id="b-import" type="file" accept=".json,application/json" hidden></div></details>`;

  // ------------------------------------------------------------ settings panel
  sets.innerHTML = `
    <div class="panel-title">D's team</div>
    <div class="seg" role="group" aria-label="Team size" id="b-nmode"><button type="button" data-n="auto" aria-pressed="true">D chooses</button><button type="button" data-n="fixed" aria-pressed="false">Fixed</button></div>
    <div class="field" id="b-nfield" hidden style="margin-top:10px"><label for="b-n">Number of D players</label><input id="b-n" type="number" min="1" max="20" value="5"></div>
    <div class="panel-title">O's behaviour</div>
    <div class="field"><label for="b-w">Flee weight: <output id="b-w-out">0.50</output></label><input id="b-w" type="range" min="0" max="1" step="0.05" value="0.5">
      <span class="hint">0 = only regroup, 1 = only flee. Training used 0.3 to 0.7.</span></div>
    <div class="panel-title">Referee</div>
    <div class="field"><select id="b-ref" aria-label="Referee strength"><option value="quick">Quick</option><option value="standard" selected>Standard (training referee)</option><option value="thorough">Thorough (test referee, slow above 14 players)</option></select></div>
    <label class="check"><input type="checkbox" id="b-km" checked> Also play a k-means team of the same size</label>
    <details class="more" id="b-adv"><summary>Game rules</summary>
      ${ADV.map((a) => `<div class="field"><label for="b-${a.id}">${a.label}</label><input id="b-${a.id}" type="number" min="${a.min}" max="${a.max}" step="${a.step}" value="${DEFAULTS[a.id]}"><span class="hint" id="b-${a.id}-hint">trained with ${DEFAULTS[a.id]}</span></div>`).join("")}
      <label class="check"><input type="checkbox" id="b-fix"> Give the per-tick network the real last moves when it picks targets (the fix; off = as evaluated)</label>
      <button class="btn small" type="button" id="b-reset">Back to the trained rules</button>
    </details>
    <div class="panel-title">Run</div>
    <button class="btn primary" type="button" id="b-run">Let D study this formation</button>
    <div class="progress" hidden><i></i></div>
    <div id="b-status" aria-live="polite"></div>
    <div id="b-after" hidden>
      <button class="btn small" type="button" id="b-edit">Edit the formation</button>
      <button class="btn small" type="button" id="b-scan">Try other team sizes</button>
      <div id="b-scan-out"></div>
    </div>`;

  const msgs = $("#b-msgs"), statusEl = $("#b-status"), prog = $(".progress", sets);
  function status(text, kind = "") { statusEl.innerHTML = text ? `<p class="msg ${kind}">${text}</p>` : ""; }

  // ------------------------------------------------------------ helpers
  const cfgFromUI = () => {
    const c = {};
    for (const a of ADV) { const v = Number($(`#b-${a.id}`).value); if (isFinite(v)) c[a.id] = Math.min(a.max, Math.max(a.min, v)); }
    return c;
  };
  function oodNotes() {
    const out = [];
    const c = cfgFromUI();
    for (const a of ADV) {
      const off = Math.abs(c[a.id] - DEFAULTS[a.id]) > 1e-9;
      const h = $(`#b-${a.id}-hint`);
      h.textContent = `trained with ${DEFAULTS[a.id]}${off ? ": outside training" : ""}`;
      h.classList.toggle("ood", off);
      if (off) out.push(a.label.toLowerCase());
    }
    const w = Number($("#b-w").value);
    if (w < 0.3 || w > 0.7) out.push("O's flee weight");
    return out;
  }
  const meanNN = (X) => {
    if (X.length < 2) return 0;
    let s = 0;
    for (let i = 0; i < X.length; i++) { let b = Infinity; for (let j = 0; j < X.length; j++) if (j !== i) b = Math.min(b, Math.hypot(X[i][0] - X[j][0], X[i][1] - X[j][1], X[i][2] - X[j][2])); s += b; }
    return s / X.length;
  };
  function checks() {
    const X = state.O, m = X.length;
    const out = [];
    let ok = true;
    if (m < 4) { out.push(["err", `Add at least ${4 - m} more player${4 - m === 1 ? "" : "s"} (the game needs 4 to 20).`]); ok = false; }
    if (m > 20) { out.push(["err", `Remove ${m - 20} player${m - 20 === 1 ? "" : "s"}: the networks were trained on up to 20.`]); ok = false; }
    let dmin = Infinity;
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) dmin = Math.min(dmin, Math.hypot(X[i][0] - X[j][0], X[i][1] - X[j][1], X[i][2] - X[j][2]));
    if (m >= 2 && dmin < 0.05) { out.push(["err", "Two players are on top of each other. Move one of them."]); ok = false; }
    const sp = meanNN(X);
    if (m >= 4 && (sp < 0.5 || sp > 1.2)) out.push(["warn", `Average spacing is ${sp.toFixed(2)}; the test formations used 0.5 to 1.2. D will still play, but it has not seen such formations.`]);
    if (m >= 4) {
      const zs = X.map((p) => p[2]);
      if (Math.max(...zs) - Math.min(...zs) < 1e-6) out.push(["warn", "All players are at one height, so the formation is flat: nobody can be shielded. Change the height of a few players to give it depth."]);
    }
    const ood = oodNotes();
    if (ood.length) out.push(["warn", `Outside the training range: ${ood.join(", ")}.`]);
    msgs.innerHTML = `<p class="msg">${m} O player${m === 1 ? "" : "s"}${m >= 2 ? `, average spacing ${sp.toFixed(2)}` : ""}${state.preview && state.preview.n === m ? `; quick reading: ${state.preview.shielded.length} shielded` : ""}</p>` + out.map(([k, t]) => `<p class="msg ${k}">${t}</p>`).join("");
    $("#b-run").disabled = !ok || state.running;
    return ok;
  }

  function renderTable() {
    $("#b-table").innerHTML = state.O.map((p, i) => `<tr data-i="${i}"><td>${i}</td>${[0, 1, 2].map((c) => `<td><input type="number" step="0.05" value="${r3(p[c])}" data-c="${c}" aria-label="Player ${i} ${"xyz"[c]}"></td>`).join("")}<td><button type="button" aria-label="Delete player ${i}">×</button></td></tr>`).join("");
  }
  $("#b-table").addEventListener("change", (e) => {
    const inp = e.target.closest("input"); if (!inp) return;
    const i = Number(inp.closest("tr").dataset.i);
    pushUndo(); state.O[i][Number(inp.dataset.c)] = Number(inp.value); changed(false);
  });
  $("#b-table").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; pushUndo(); state.O.splice(Number(b.closest("tr").dataset.i), 1); state.sel = null; changed(); });

  function pushUndo() { state.undo.push(state.O.map((p) => p.slice())); if (state.undo.length > 60) state.undo.shift(); }

  let prevTimer = null, prevToken = 0;
  function changed(table = true) {
    state.testKey = null; $("#b-test-note").textContent = "";
    if (table) renderTable();
    state.preview = null;
    drawEditor();
    checks();
    clearTimeout(prevTimer);
    const X = state.O.map((p) => p.slice());
    if (X.length >= 4 && X.length <= 20) {
      prevTimer = setTimeout(async () => {
        const my = ++prevToken;
        try {
          const rd = await engine.call("preview", { O: X, cfg: cfgFromUI() });
          if (my !== prevToken || state.view) return;
          state.preview = { ...rd, n: X.length };
          drawEditor(); checks();
        } catch (e) { /* degenerate while editing: ignore */ }
      }, 250);
    }
  }

  function drawEditor() {
    const pv = state.preview;
    const kinds = state.O.map((_, i) => (pv && pv.n === state.O.length ? (pv.shielded.includes(i) ? "shielded" : "exposed") : "neutral"));
    const L = Number($("#b-support_length").value) || 4;
    const edges = pv && pv.n === state.O.length ? pv.edges.map(([a, b]) => { const p = state.O[a], q = state.O[b]; return [a, b, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < L ? 1 : 0]; }) : [];
    stage.show({ O: state.O, oKind: kinds, edges, edgeAlpha: 0.7, select: state.mode === "move" ? state.sel : null });
    hud.innerHTML = `<span><b>${state.O.length}</b> O players</span>${pv && pv.n === state.O.length ? `<span><b>${pv.shielded.length}</b> shielded (quick reading)</span>` : ""}`;
  }

  // ------------------------------------------------------------ editor input
  function setMode(m) {
    state.mode = m;
    $("#b-mode").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
    const c = stage.controls;
    if (m === "view") { c.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }; c.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE }; }
    else { c.mouseButtons = { LEFT: null, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }; c.touches = { ONE: null, TWO: TOUCH.DOLLY_ROTATE }; }
    hint.textContent = {
      add: `Click the grid to add a player at height ${state.z.toFixed(1)}. Right-drag (or two fingers) turns the view; scroll to zoom.`,
      move: "Drag a player across its height level. Arrow keys up and down change the selected player's height.",
      delete: "Click a player to remove it.",
      view: "Drag to turn the view; scroll to zoom.",
    }[m];
    drawEditor();
  }
  $("#b-mode").addEventListener("click", (e) => { const b = e.target.closest("button[data-mode]"); if (b) setMode(b.dataset.mode); });
  $("#b-z").addEventListener("input", (e) => { state.z = Number(e.target.value); $("#b-z-out").textContent = state.z.toFixed(1); stage.setGrid(state.z, gridSize()); setMode(state.mode); });
  const gridSize = () => { let r = 3; for (const p of state.O) r = Math.max(r, Math.abs(p[0]) + 1, Math.abs(p[1]) + 1); return Math.ceil(r) * 2; };

  const canvas = stage.renderer.domElement;
  let drag = null;
  canvas.addEventListener("pointerdown", (ev) => {
    if (state.view || ev.button !== 0 || state.mode === "view") return;
    if (state.mode === "add") {
      const p = stage.planePoint(ev, state.z);
      if (!p || Math.hypot(p[0], p[1]) > 25) return;
      pushUndo(); state.O.push([r3(p[0]), r3(p[1]), r3(p[2])]); state.sel = state.O.length - 1; changed();
    } else {
      const i = stage.pickO(ev);
      if (i < 0) return;
      if (state.mode === "delete") { pushUndo(); state.O.splice(i, 1); state.sel = null; changed(); }
      else { pushUndo(); state.sel = i; drag = { i, z: state.O[i][2] }; canvas.setPointerCapture(ev.pointerId); drawEditor(); }
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const p = stage.planePoint(ev, drag.z);
    if (!p) return;
    state.O[drag.i] = [r3(p[0]), r3(p[1]), drag.z];
    drawEditor();
  });
  const endDrag = () => { if (drag) { drag = null; changed(); } };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Formation editor. Use the coordinates table for keyboard editing.");
  canvas.addEventListener("keydown", (ev) => {
    if (state.view || state.sel === null || !state.O[state.sel]) return;
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") { ev.preventDefault(); pushUndo(); state.O[state.sel][2] = r3(state.O[state.sel][2] + (ev.key === "ArrowUp" ? 0.1 : -0.1)); changed(); }
    if (ev.key === "Delete" || ev.key === "Backspace") { pushUndo(); state.O.splice(state.sel, 1); state.sel = null; changed(); }
  });

  $("#b-undo").addEventListener("click", () => { if (!state.undo.length) return; state.O = state.undo.pop(); state.sel = null; changed(); });
  $("#b-clear").addEventListener("click", () => { pushUndo(); state.O = []; state.sel = null; changed(); });
  $("#b-rescale").addEventListener("click", () => {
    if (state.O.length < 2) return;
    pushUndo();
    const c = [0, 1, 2].map((k) => state.O.reduce((s, p) => s + p[k], 0) / state.O.length);
    const s = 0.85 / meanNN(state.O);
    state.O = state.O.map((p) => p.map((x, k) => r3((x - c[k]) * s)));
    changed(); stage.fit(state.O, 1.3);
  });
  $("#b-gen").addEventListener("click", async () => {
    const m = Math.max(4, Math.min(20, Number($("#b-m").value) || 12));
    try {
      const X = await engine.call("generate", { m, family: $("#b-family").value, spacing: Number($("#b-spacing").value) || 0.85, seed: Number($("#b-seed").value) || 1 });
      pushUndo(); state.O = X.map((p) => p.map(r3)); state.sel = null; leaveView(); changed(); stage.fit(state.O, 1.3);
    } catch (e) { status(e.message, "err"); }
  });
  let tests = null;
  $("#b-test").addEventListener("click", async () => {
    if (!tests) tests = await fetch("assets/data/test_formations.json").then((r) => r.json());
    const m = Number($("#b-test-m").value), i = Math.max(0, Math.min(49, Number($("#b-test-i").value) || 0));
    const f = tests.find((t) => t.m === m && t.idx === i);
    if (!f) return;
    pushUndo(); state.O = f.X.map((p) => p.slice()); state.sel = null; leaveView(); changed(); stage.fit(state.O, 1.3);
    state.testKey = f.key;
    $("#b-test-note").textContent = ` ${f.family}; planner needed ${f.nStar}; recorded: learned D won ${f.rec.own ?? f.rec.atNStar} of 5.`;
  });
  $("#b-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ players: state.O }, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "formation.json"; a.click(); URL.revokeObjectURL(a.href);
  });
  $("#b-import").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const X = (Array.isArray(j) ? j : j.players || j.positions || j.X).map((p) => [Number(p[0]), Number(p[1]), Number(p[2])]);
      if (!X.every((p) => p.every(isFinite))) throw new Error("expected a list of [x, y, z] points");
      pushUndo(); state.O = X; leaveView(); changed(); stage.fit(state.O, 1.3);
    } catch (err) { status(`That file could not be read: ${err.message}.`, "err"); }
    e.target.value = "";
  });

  // ------------------------------------------------------------ settings
  $("#b-nmode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-n]"); if (!b) return;
    $("#b-nmode").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("#b-nfield").hidden = b.dataset.n === "auto";
  });
  $("#b-w").addEventListener("input", (e) => { $("#b-w-out").textContent = Number(e.target.value).toFixed(2); checks(); });
  for (const a of ADV) $(`#b-${a.id}`).addEventListener("change", () => { checks(); if (a.id === "support_length") changed(false); });
  $("#b-reset").addEventListener("click", () => { for (const a of ADV) $(`#b-${a.id}`).value = DEFAULTS[a.id]; $("#b-fix").checked = false; checks(); changed(false); });

  // ------------------------------------------------------------ run
  let view = null;
  function enterView(rec) {
    if (!view) {
      view = new StudyView({ stage, stepsEl: $(".steps", stepsBox), textEl: $(".step-text", stepsBox), barEl: $(".builder-bar"), hudEl: hud, legendEl: legend, kind: "builder" });
    } else stage.onFrame = (dt) => view.frame(dt);
    state.view = rec;
    stepsBox.hidden = false; $(".builder-bar").hidden = false;
    hint.textContent = "";
    stage.setGrid(0, 1, false);
    view.setRecord(rec, 0);
    $("#b-after").hidden = false;
  }
  function leaveView() {
    if (!state.view) return;
    state.view = null;
    stage.onFrame = null;
    stepsBox.hidden = true; $(".builder-bar").hidden = true;
    $("#b-after").hidden = true;
    stage.setGrid(state.z, gridSize(), true);
    setMode(state.mode);
    legend.innerHTML = '<span><i class="dot exposed"></i>exposed</span><span><i class="dot shielded"></i>shielded</span><span><i class="line"></i>supported edge</span><span><i class="line dash"></i>long edge</span>';
  }
  $("#b-edit").addEventListener("click", () => { leaveView(); drawEditor(); checks(); });

  function opts() {
    const fixed = $("#b-nmode").querySelector('[data-n="fixed"]').getAttribute("aria-pressed") === "true";
    return {
      cfg: cfgFromUI(), w: Number($("#b-w").value), n: fixed ? Math.max(1, Math.min(20, Number($("#b-n").value) || 1)) : "auto",
      referee: $("#b-ref").value, kmeans: $("#b-km").checked, targetFix: $("#b-fix").checked,
    };
  }
  const STAGES = { reading: 0.1, referee: 0.25, team: 0.4, place: 0.5, play: 0.6, kmeans: 0.9, scan: 0.5 };
  $("#b-run").addEventListener("click", async () => {
    if (!checks() || state.running) return;
    if (engineErr) { status(`The in-browser engine could not start: ${engineErr.message}`, "err"); return; }
    state.running = true; $("#b-run").disabled = true;
    prog.hidden = false; prog.firstElementChild.style.width = "4%";
    status("Starting the engine…");
    const X = state.O.map((p) => p.slice());
    const t0 = performance.now();
    try {
      const rec = await engine.call("study", { O: X, opts: opts() }, (stg, detail) => {
        prog.firstElementChild.style.width = `${Math.round((STAGES[stg] ?? 0.5) * 100 + (stg === "play" ? (Number((detail.match(/tick (\d+)/) || [])[1]) || 0) * 5 : 0))}%`;
        status(detail.charAt(0).toUpperCase() + detail.slice(1) + "…");
      });
      if (state.testKey && tests) {
        const f = tests.find((t) => t.key === state.testKey);
        if (f) rec.test = { key: f.key, family: f.family, idx: f.idx, nStar: f.nStar, peel: f.peel, recorded: f.rec, replay: [] };
      }
      state.lastRec = rec;
      prog.firstElementChild.style.width = "100%";
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (rec.outcome === "declared_cannot_win") status(`D looked at this formation and declared it cannot win with up to ${Math.min(20, rec.m)} players (${secs} s).`, "warn");
      else status(`${rec.game.outcome === "win" ? `D won in ${rec.game.ticks} tick${rec.game.ticks === 1 ? "" : "s"}` : `D lost: ${rec.game.aliveLeft} O player${rec.game.aliveLeft === 1 ? "" : "s"} left`} with ${rec.team.n} player${rec.team.n === 1 ? "" : "s"} (${secs} s). Step through what it did below the view.`);
      if (rec.placement) enterView(rec);
      $("#b-scan-out").innerHTML = "";
    } catch (e) {
      status(`D could not study this formation: ${e.message}. Spread the players out a little or change their heights, then try again.`, "err");
    } finally {
      state.running = false; prog.hidden = true; checks();
    }
  });
  $("#b-scan").addEventListener("click", async () => {
    const rec = state.lastRec; if (!rec || state.running) return;
    const lo = rec.team.lowerBound, hi = Math.min(rec.m, Math.max(rec.team.n || lo, lo) + 1);
    state.running = true; $("#b-scan").disabled = true;
    const out = $("#b-scan-out");
    out.innerHTML = `<p class="msg">Playing team sizes ${lo} to ${hi}…</p>`;
    try {
      const o = opts();
      const res = await engine.call("scan", { O: rec.O, opts: { ...o, lo, hi } }, (s, d) => { out.innerHTML = `<p class="msg">Playing ${d}…</p>`; });
      out.innerHTML = `<ul class="fact-list" style="margin-top:10px">${res.map((r) => `<li><span>${r.n} D player${r.n === 1 ? "" : "s"}${r.n === rec.team.nAuto ? " (D's choice)" : ""}</span><b>${r.outcome === "win" ? `won in ${r.ticks} tick${r.ticks === 1 ? "" : "s"}` : `lost, ${r.aliveLeft} left`}</b></li>`).join("")}</ul><p class="hint">Same formation and O behaviour, the learned D's own placement and play at each size.</p>`;
    } catch (e) { out.innerHTML = `<p class="msg err">${e.message}</p>`; }
    finally { state.running = false; $("#b-scan").disabled = false; checks(); }
  });

  // ------------------------------------------------------------ start with a preset
  stepsBox.hidden = true; $(".builder-bar").hidden = true;
  stage.setGrid(0, 8, true);
  leaveView();
  setMode("add");
  legend.innerHTML = '<span><i class="dot exposed"></i>exposed</span><span><i class="dot shielded"></i>shielded</span><span><i class="line"></i>supported edge</span><span><i class="line dash"></i>long edge</span>';
  engine.ready.then(() => engine.call("generate", { m: 12, family: "ball", spacing: 0.85, seed: 1 })).then((X) => {
    if (state.O.length) return;
    state.O = X.map((p) => p.map(r3)); changed(); stage.fit(state.O, 1.3); stage.setGrid(state.z, gridSize(), true);
  }).catch(() => {});
  checks();

  return {
    openWithParam(id) {
      document.getElementById("builder").scrollIntoView({ behavior: "smooth" });
      if (id === "w") { setTimeout(() => $("#b-w").focus(), 500); return; }
      if (id === "spacing") { setTimeout(() => $("#b-spacing").focus(), 500); return; }
      $("#b-adv").open = true;
      setTimeout(() => { const el = $(`#b-${id}`); if (el) el.focus(); }, 500);
    },
  };
}
