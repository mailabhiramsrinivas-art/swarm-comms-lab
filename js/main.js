// Page wiring: controls, stats, event log, inspector and the animation loop.

import { defaultConfig, PRESETS, VERSION } from './config.js';
import { Sim } from './sim.js';
import { MSG } from './network.js';
import { Renderer, LAYER_COLOR } from './render.js';

const DT = 1 / 60;
const $ = (s) => document.querySelector(s);
const pct = (v) => Math.round(v * 100) + '%';

const CONTROLS = {
  comms: [
    { path: 'comms.latencyMs', label: 'Latency per hop', min: 0, max: 300, step: 5, fmt: (v) => v + ' ms' },
    { path: 'comms.loss', label: 'Packet loss', min: 0, max: 1, step: 0.01, fmt: pct },
    { path: 'comms.hops', label: 'Relay hops (TTL)', min: 1, max: 5, step: 1 },
    { path: 'defenders.radio', label: 'Drone radio range', min: 80, max: 500, step: 10, fmt: (v) => v + ' m' },
    { path: 'gs.radio', label: 'Ground station radio', min: 80, max: 700, step: 10, fmt: (v) => v + ' m' },
    { path: 'comms.zone.on', label: 'Interference zone', type: 'toggle' },
    { path: 'comms.zone.strength', label: 'Zone strength', min: 0, max: 1, step: 0.05, fmt: pct },
    { path: 'comms.zone.r', label: 'Zone radius', min: 40, max: 400, step: 10, fmt: (v) => v + ' m' },
  ],
  swarm: [
    { path: 'defenders.count', label: 'Defender drones', min: 2, max: 16, step: 1, reset: true },
    { path: 'gs.enabled', label: 'Ground station', type: 'toggle', reset: true },
    { path: 'policy.maxPerTarget', label: 'Max drones per target', min: 1, max: 3, step: 1, hint: 'Training decides this later' },
    { path: 'defenders.sensor', label: 'Drone camera range', min: 60, max: 400, step: 10, fmt: (v) => v + ' m' },
    { path: 'gs.sensor', label: 'Ground station sensor', min: 0, max: 500, step: 10, fmt: (v) => v + ' m' },
    { path: 'defenders.speed', label: 'Drone speed', min: 20, max: 100, step: 1, fmt: (v) => v + ' m/s' },
  ],
  threat: [
    { path: 'enemies.perWave', label: 'Enemies per wave', min: 1, max: 24, step: 1 },
    { path: 'enemies.waveInterval', label: 'Seconds between waves', min: 3, max: 30, step: 1, fmt: (v) => v + ' s' },
    { path: 'enemies.speed', label: 'Enemy speed', min: 10, max: 80, step: 1, fmt: (v) => v + ' m/s' },
    { path: 'enemies.behavior', label: 'Enemy behavior', type: 'select', options: ['mixed', 'direct', 'weave', 'evade'] },
    { path: 'enemies.autoWaves', label: 'Automatic waves', type: 'toggle' },
  ],
  timing: [
    { path: 'timing.planTimeout', label: 'No plan → Layer 2 after', min: 0.1, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) + ' s' },
    { path: 'timing.contactTimeout', label: 'No contact → Layer 1 after', min: 0.1, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) + ' s' },
    { path: 'timing.leaderTimeout', label: 'Silent coordinator → re-elect after', min: 0.2, max: 5, step: 0.1, fmt: (v) => v.toFixed(1) + ' s' },
    { path: 'timing.planHz', label: 'Plan broadcast rate', min: 1, max: 20, step: 1, fmt: (v) => v + ' Hz' },
    { path: 'timing.stateHz', label: 'State broadcast rate', min: 1, max: 20, step: 1, fmt: (v) => v + ' Hz' },
    { path: 'seed', label: 'Random seed', min: 1, max: 999, step: 1, reset: true },
  ],
};

const get = (o, p) => p.split('.').reduce((a, k) => a[k], o);
function set(o, p, v) {
  const ks = p.split('.'), last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
}

const state = {
  cfg: null,
  pending: new Map(),
  preset: 'clear',
  custom: false,
  playing: true,
  speed: 1,
  tool: 'inspect',
  dragging: false,
};

let sim, renderer;
const inputs = new Map();

function init() {
  $('#version').textContent = 'v' + VERSION;
  renderer = new Renderer($('#view'));
  buildPresets();
  for (const [group, list] of Object.entries(CONTROLS)) buildControls($('#ctl-' + group), list);
  bindToolbar();
  bindCanvas();
  bindKeys();
  applyPreset('clear');
  new ResizeObserver(() => renderer.resize()).observe($('#view'));
  // Handy for poking at the swarm from the browser console.
  window.swarm = { get sim() { return sim; }, state, renderer };
  requestAnimationFrame(frame);
}

// ---- presets & controls -----------------------------------------------------

function buildPresets() {
  const box = $('#presets');
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = p.label;
    b.dataset.key = key;
    b.onclick = () => applyPreset(key);
    box.appendChild(b);
  }
}

function applyPreset(key) {
  const cfg = defaultConfig();
  PRESETS[key].apply(cfg);
  state.cfg = cfg;
  state.preset = key;
  state.custom = false;
  state.pending.clear();
  resetSim();
}

function resetSim() {
  for (const [p, v] of state.pending) set(state.cfg, p, v);
  state.pending.clear();
  if (sim) sim.reset(state.cfg, state.preset);
  else sim = new Sim(state.cfg, state.preset);
  renderer.selected = null;
  logCursor = 0;
  $('#log').innerHTML = '';
  syncControls();
  syncPresetUI();
  $('#reset').classList.remove('attention');
}

function syncPresetUI() {
  for (const b of document.querySelectorAll('#presets .chip')) b.classList.toggle('on', b.dataset.key === state.preset);
  const p = PRESETS[state.preset];
  $('#presetNote').innerHTML = `<strong>${state.custom ? 'Custom · based on ' : ''}${p.label}</strong> ${p.blurb}`;
}

function buildControls(box, list) {
  for (const c of list) {
    const row = document.createElement('label');
    row.className = 'ctl' + (c.type === 'toggle' ? ' ctl-toggle' : '');
    const head = document.createElement('span');
    head.className = 'ctl-head';
    head.innerHTML = `<span>${c.label}${c.reset ? ' <em title="Applies when you press Reset">reset</em>' : ''}</span><output></output>`;
    row.appendChild(head);
    let input;
    if (c.type === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.oninput = () => onChange(c, input.checked);
      row.insertBefore(input, head);
    } else if (c.type === 'select') {
      input = document.createElement('select');
      for (const o of c.options) input.add(new Option(o, o));
      input.oninput = () => onChange(c, input.value);
      row.appendChild(input);
    } else {
      input = document.createElement('input');
      input.type = 'range';
      input.min = c.min; input.max = c.max; input.step = c.step;
      input.oninput = () => onChange(c, Number(input.value));
      row.appendChild(input);
    }
    if (c.hint) {
      const h = document.createElement('small');
      h.textContent = c.hint;
      row.appendChild(h);
    }
    box.appendChild(row);
    inputs.set(c.path, { c, input, out: head.querySelector('output') });
  }
}

function onChange(c, v) {
  state.custom = true;
  if (c.reset) {
    state.pending.set(c.path, v);
    $('#reset').classList.add('attention');
  } else {
    set(state.cfg, c.path, v);
  }
  showValue(c.path, v);
  syncPresetUI();
}

function showValue(path, v) {
  const { c, out } = inputs.get(path);
  if (c.type === 'toggle') out.textContent = v ? 'on' : 'off';
  else out.textContent = c.fmt ? c.fmt(v) : v;
}

function syncControls() {
  for (const [path, { c, input }] of inputs) {
    const v = state.pending.has(path) ? state.pending.get(path) : get(state.cfg, path);
    if (c.type === 'toggle') input.checked = !!v;
    else input.value = v;
    showValue(path, v);
  }
}

// ---- toolbar, canvas, keys ----------------------------------------------------

function bindToolbar() {
  $('#play').onclick = togglePlay;
  $('#reset').onclick = resetSim;
  $('#wave').onclick = () => sim.spawnWave();
  $('#killCoord').onclick = () => sim.killCoordinator();
  $('#respawn').onclick = () => sim.respawnLost();
  for (const b of document.querySelectorAll('#speed button')) {
    b.onclick = () => {
      state.speed = Number(b.dataset.v);
      for (const x of document.querySelectorAll('#speed button')) x.classList.toggle('on', x === b);
    };
  }
  for (const b of document.querySelectorAll('#tools button')) {
    b.onclick = () => {
      state.tool = b.dataset.tool;
      for (const x of document.querySelectorAll('#tools button')) x.classList.toggle('on', x === b);
      $('#view').dataset.tool = state.tool;
    };
  }
  for (const [k, id] of [['links', 'optLinks'], ['sensors', 'optSensors'], ['targets', 'optTargets'], ['belief', 'optBelief']]) {
    const el = $('#' + id);
    el.checked = renderer.opts[k];
    el.oninput = () => (renderer.opts[k] = el.checked);
  }
}

function togglePlay() {
  state.playing = !state.playing;
  $('#play').textContent = state.playing ? 'Pause' : 'Play';
  $('#play').classList.toggle('on', !state.playing);
}

function nodeAt(p) {
  let best = null, bd = 28;
  for (const n of sim.nodes) {
    if (!n.alive) continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

function bindCanvas() {
  const cv = $('#view');
  cv.dataset.tool = state.tool;
  cv.addEventListener('pointerdown', (ev) => {
    const p = renderer.toWorld(ev.clientX, ev.clientY, sim);
    if (state.tool === 'zone') {
      state.dragging = true;
      cv.setPointerCapture(ev.pointerId);
      moveZone(p);
      return;
    }
    const n = nodeAt(p);
    if (state.tool === 'destroy') { if (n) sim.destroyNode(n.id); return; }
    renderer.selected = n ? n.id : null;
    updateInspector();
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!state.dragging) return;
    moveZone(renderer.toWorld(ev.clientX, ev.clientY, sim));
  });
  const end = () => (state.dragging = false);
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

function moveZone(p) {
  const z = state.cfg.comms.zone;
  z.x = p.x; z.y = p.y;
  if (!z.on) { z.on = true; state.custom = true; syncControls(); syncPresetUI(); }
}

function bindKeys() {
  window.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input, select, textarea')) return;
    const k = ev.key.toLowerCase();
    if (k === ' ') { ev.preventDefault(); togglePlay(); }
    else if (k === 'w') sim.spawnWave();
    else if (k === 'k') sim.killCoordinator();
    else if (k === 'r') resetSim();
  });
}

// ---- stats, log, inspector ------------------------------------------------------

let logCursor = 0;
const LOG_LABEL = { tag: 'intercept', breach: 'breach', coord: 'coord', lost: 'lost', claim: 'claim', net: 'network', wave: 'wave', info: 'info' };

function updateStats() {
  const m = sim.metrics();
  const total = m.alive || 1;
  $('#s-time').textContent = m.time.toFixed(1) + ' s';
  $('#s-int').textContent = m.intercepted;
  $('#s-breach').textContent = m.breaches;
  $('#s-resp').textContent = m.avgResponse == null ? '–' : (m.avgResponse * 1000).toFixed(0) + ' ms';
  $('#s-coord').textContent = m.coordinators.join(' + ') || 'none';
  $('#s-coord').classList.toggle('warn', m.coordinators.length !== 1);
  $('#s-part').textContent = m.partitions;
  $('#s-part').classList.toggle('warn', m.partitions > 1);
  $('#s-msgs').textContent = Math.round(m.msgRate);
  $('#s-bw').textContent = (m.byteRate / 1024).toFixed(1) + ' KB/s';
  $('#s-yield').textContent = m.yields;
  $('#s-over').textContent = m.overAssigned;
  $('#s-elect').textContent = m.elections;
  for (const L of [3, 2, 1]) {
    const el = $('#lb-' + L);
    el.style.flexGrow = m.layers[L];
    el.textContent = m.layers[L] ? `L${L} ${m.layers[L]}` : '';
  }
  $('#s-layers').title = `${m.layers[3]} following plan · ${m.layers[2]} peer claims · ${m.layers[1]} solo (of ${total})`;
  const maxRate = Math.max(1, ...Object.values(m.rate));
  $('#msgbars').innerHTML = Object.values(MSG).map((t) =>
    `<div class="mb"><span>${t}</span><i style="width:${(100 * m.rate[t]) / maxRate}%"></i><b>${Math.round(m.rate[t])}/s</b></div>`,
  ).join('');
}

function updateLog() {
  const box = $('#log');
  const fresh = sim.logs.filter((l) => l.n > logCursor);
  if (!fresh.length) return;
  logCursor = fresh[fresh.length - 1].n;
  const frag = document.createDocumentFragment();
  for (const l of fresh) {
    const li = document.createElement('li');
    li.className = 'lg-' + l.type;
    li.innerHTML = `<time>${l.t.toFixed(1)}</time><span class="tag">${LOG_LABEL[l.type] || l.type}</span>`;
    li.appendChild(document.createTextNode(l.text));
    frag.prepend(li);
  }
  box.prepend(frag);
  while (box.children.length > 150) box.lastChild.remove();
}

function updateInspector() {
  const box = $('#inspector');
  const n = renderer.selected != null ? sim.node(renderer.selected) : null;
  if (!n) {
    box.innerHTML = '<p class="muted">Click a drone or the ground station to see what <em>it</em> knows. Its private picture of the sky is drawn as white rings.</p>';
    return;
  }
  if (!n.alive) { box.innerHTML = `<p><strong>${n.name}</strong> is destroyed.</p>`; return; }
  const now = sim.time, T = sim.cfg.timing;
  const layerName = { 3: 'Layer 3 · following plan', 2: 'Layer 2 · peer claims', 1: 'Layer 1 · solo', 0: 'Ground station' }[n.layer];
  const leader = sim.node(n.leader);
  const plan = n.isCoord ? n.ownPlan : n.plans.get(n.leader);
  const heard = [...n.heard.entries()].filter(([, t]) => now - t < T.leaderTimeout).sort((a, b) => a[0] - b[0]);
  const tracks = [...n.tracks.values()].sort((a, b) => a.id - b.id);
  const claims = [...n.claims.values()].sort((a, b) => a.id - b.id);
  const name = (id) => (id === 0 ? 'GS' : 'D' + id);
  box.innerHTML = `
    <div class="insp-head"><strong>${n.name}</strong><span class="pill" style="--c:${n.kind === 'gs' ? '#b18cff' : LAYER_COLOR[n.layer]}">${layerName}</span></div>
    <dl>
      <dt>Role</dt><dd>${n.isCoord ? 'Coordinator ★' : leader && leader !== n ? 'Follows ' + leader.name : 'No coordinator heard'}</dd>
      <dt>Target</dt><dd>${n.target != null ? 'E' + n.target + (isFinite(n.cost) ? ` · cost ${n.cost.toFixed(1)}` : '') : n.kind === 'gs' ? '–' : 'patrolling'}</dd>
      <dt>Plan age</dt><dd>${plan ? ((now - plan.t) * 1000).toFixed(0) + ' ms' : 'none'}</dd>
      <dt>Hears</dt><dd>${heard.length ? heard.map(([id, t]) => `<span title="${((now - t) * 1000).toFixed(0)} ms ago">${name(id)}</span>`).join(' ') : 'nobody'}</dd>
      <dt>Tracks</dt><dd>${tracks.length ? tracks.map((t) => `<span class="${t.own ? 'own' : ''}" title="${t.own ? 'own camera' : 'relayed'}">E${t.id}·${((now - t.t) * 1000).toFixed(0)}ms</span>`).join(' ') : 'none'}</dd>
      <dt>Claims</dt><dd>${claims.length ? claims.map((c) => `${name(c.id)}→E${c.target}`).join(' ') : 'none'}</dd>
    </dl>
    <p class="muted small">Bold tracks come from its own camera; others were relayed. Ages show how stale each piece of information is.</p>`;
}

// ---- loop -------------------------------------------------------------------------

let last = performance.now(), acc = 0, lastUi = 0;
function frame(ts) {
  const real = Math.min(0.1, (ts - last) / 1000);
  last = ts;
  if (state.playing) {
    acc += real * state.speed;
    let steps = 0;
    while (acc >= DT && steps < 40) { sim.step(DT); acc -= DT; steps++; }
    if (steps === 40) acc = 0;
  }
  renderer.draw(sim);
  if (ts - lastUi > 150) {
    lastUi = ts;
    updateStats();
    updateLog();
    if (renderer.selected != null) updateInspector();
  }
  requestAnimationFrame(frame);
}

init();
