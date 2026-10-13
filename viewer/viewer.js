// Simplex Game viewer: plays back episode logs (format simplex-episode/1) in 3D.
// Reads only the log; it knows nothing about how the game engine decides things.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (s) => document.querySelector(s);
const FORMAT = 'simplex-episode/1';
const COL = {
  exposed: 0xff6b6b, shielded: 0x3ddc97, dead: 0x4a5664,
  d: 0x4da3ff, link: 0x8fa6bd, linkU: 0x5c6f82, nerve: 0xb18cff,
  hit: { eliminated: 0xffffff, wasted: 0xf5b342, blocked: 0xff4d6d, out_of_range: 0x7f93a8, invalid: 0x7f93a8 },
};
const PHASE = { start: 'Start', move: 'Move', attack: 'Attack', plan: 'Plan' };
// seconds spent going INTO a frame of each phase, at 1x
const DURATION = { move: 1.4, attack: 1.0, plan: 0.9, start: 0.6 };

const state = { list: [], ep: null, meta: null, t: 0, playing: false, speed: 1, rec: null, holdUntil: 0 };

// ---- three.js scene -------------------------------------------------------------
const canvas = $('#three');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1.6, 0.01, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotateSpeed = 0.8;
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.4);
fillLight.position.set(-6, -4, -5);
scene.add(fillLight);
let world = new THREE.Group();
scene.add(world);

const objs = {};

function segments(color, dashed = false, opacity = 0.8) {
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.14, gapSize: 0.1, transparent: true, opacity })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const l = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
  l.frustumCulled = false;
  world.add(l);
  return l;
}

function setSegments(line, pairs) {
  const arr = new Float32Array(pairs.length * 6);
  pairs.forEach(([a, b], k) => { arr.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6); });
  line.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  if (line.material.isLineDashedMaterial && pairs.length) line.computeLineDistances();
  line.visible = pairs.length > 0;
}

// thick lines (WebGL lines are 1px): unit cylinders stretched between two points
const UP = new THREE.Vector3(0, 1, 0);
const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
function tubePool(color, opacity = 1) {
  const pool = [];
  return {
    pool,
    set(pairs, radius) {
      while (pool.length < pairs.length) {
        const mesh = new THREE.Mesh(tubeGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity }));
        mesh.frustumCulled = false;
        world.add(mesh);
        pool.push(mesh);
      }
      pool.forEach((mesh, k) => {
        mesh.visible = k < pairs.length;
        if (!mesh.visible) return;
        const [a, b] = pairs[k];
        const d = b.clone().sub(a);
        const L = d.length();
        mesh.position.copy(a).addScaledVector(d, 0.5);
        mesh.scale.set(radius, Math.max(L, 1e-6), radius);
        if (L > 1e-9) mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(L));
      });
    },
    show(on) { if (!on) pool.forEach((m) => { m.visible = false; }); },
  };
}

function labelTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;                    // wide enough for 'out of range'
  const g = c.getContext('2d');
  g.font = '600 34px ui-monospace, Menlo, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(7,11,16,0.85)';
  g.strokeText(text, 128, 32);
  g.fillStyle = color;
  g.fillText(text, 128, 32);
  return new THREE.CanvasTexture(c);
}

function label(text, color) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(text, color), depthTest: false, transparent: true }));
  s.scale.set(1.0, 0.25, 1);
  s.renderOrder = 10;
  world.add(s);
  return s;
}

// ---- loading an episode -------------------------------------------------------------
function prepare(ep) {
  const F = ep.frames.length, m = ep.formation.m;
  const elim = new Array(m).fill(Infinity);
  const exposed = [], links = [], cum = [];
  const counts = { eliminated: 0, wasted: 0, blocked: 0, out_of_range: 0, invalid: 0 };
  ep.frames.forEach((fr, i) => {
    fr.O_alive.forEach((a, k) => { if (!a && elim[k] === Infinity) elim[k] = i; });
    exposed.push(fr.phase === 'attack' && i > 0 ? exposed[i - 1] : fr.O_exposed);
    // attack frames carry no triangulation: show the move frame's, minus the eliminated
    let L = fr.links;
    if (!L.length && fr.phase === 'attack' && i > 0) L = links[i - 1].filter((e) => fr.O_alive[e.a] && fr.O_alive[e.b]);
    const alive = fr.O_alive.map((a, k) => (a ? k : -1)).filter((k) => k >= 0);
    if (!L.length && alive.length >= 2 && alive.length <= 3) {
      // no tetrahedra: the shape is a triangle or an edge
      L = [];
      for (let a = 0; a < alive.length; a++) for (let b = a + 1; b < alive.length; b++) {
        const p = fr.O[alive[a]], q = fr.O[alive[b]];
        L.push({ a: alive[a], b: alive[b], supported: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < ep.constants.cohesion_length });
      }
    }
    links.push(L);
    fr.hits.forEach((h) => { counts[h.result] = (counts[h.result] || 0) + 1; });
    cum.push({ ...counts });
  });
  const attackOfTick = {};
  ep.frames.forEach((fr, i) => { if (fr.phase === 'attack') attackOfTick[fr.tick] = i; });
  return { F, m, n: ep.n, elim, exposed, links, cum, attackOfTick };
}

function build(ep) {
  scene.remove(world);
  world.traverse((o) => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); });
  world = new THREE.Group();
  scene.add(world);
  const meta = prepare(ep);
  const r = ep.constants.r;
  const oGeo = new THREE.SphereGeometry(0.13 * r, 28, 18);
  objs.O = Array.from({ length: meta.m }, () => {
    const mesh = new THREE.Mesh(oGeo, new THREE.MeshStandardMaterial({ color: COL.exposed, roughness: 0.45, metalness: 0.1, transparent: true }));
    world.add(mesh);
    return mesh;
  });
  const coreGeo = new THREE.SphereGeometry(0.1 * r, 24, 16);
  const shellGeo = new THREE.SphereGeometry(r, 48, 32);
  objs.D = Array.from({ length: meta.n }, () => {
    const core = new THREE.Mesh(coreGeo, new THREE.MeshStandardMaterial({ color: COL.d, emissive: COL.d, emissiveIntensity: 0.35 }));
    const shell = new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({
      color: COL.d, transparent: true, opacity: 0.07, depthWrite: false, roughness: 1, side: THREE.DoubleSide }));
    shell.renderOrder = 2;
    world.add(core, shell);
    return { core, shell };
  });
  objs.linkS = segments(COL.link, false, 0.7);
  objs.linkU = segments(COL.linkU, true, 0.55);
  objs.nerve = tubePool(COL.nerve, 0.9);
  objs.nerveTri = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    color: COL.nerve, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
  objs.nerveTri.frustumCulled = false;
  world.add(objs.nerveTri);
  objs.hits = {};
  for (const [k, c] of Object.entries(COL.hit)) objs.hits[k] = tubePool(c, 1);
  objs.tags = Array.from({ length: meta.n }, () => {
    const tag = label('', '#fff');
    tag.scale.set(1.6, 0.4, 1);
    return tag;
  });
  objs.oLabels = Array.from({ length: meta.m }, (_, k) => label(`O${k}`, '#ffb3b3'));
  objs.dLabels = Array.from({ length: meta.n }, (_, k) => label(`D${k}`, '#9fcbff'));

  // fit the camera around every position the game visits
  const pts = [];
  ep.frames.forEach((fr) => { fr.O.forEach((p) => pts.push(p)); fr.D.forEach((p) => pts.push(p)); });
  const box = new THREE.Box3().setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
  state.fit = { c: box.getCenter(new THREE.Vector3()), rad: box.getSize(new THREE.Vector3()).length() / 2 + 0.5 * r };
  fitCamera(new THREE.Vector3(1, 0.65, 1.25));

  state.ep = ep;
  state.meta = meta;
  state.t = 0;
  state.playing = false;
  buildTicks();
  applyToggles();
}

// Put the whole game in view from direction `dir`, using the narrower of the
// vertical and horizontal fields of view (phones are taller than wide).
function fitCamera(dir) {
  const { c, rad } = state.fit;
  const v = THREE.MathUtils.degToRad(camera.fov) / 2;
  const h = Math.atan(Math.tan(v) * camera.aspect);
  const dist = (rad / Math.sin(Math.min(v, h))) * 0.92;
  controls.target.copy(c);
  camera.position.copy(c).add(dir.clone().normalize().multiplyScalar(dist));
  camera.near = rad / 100;
  camera.far = rad * 50;
  camera.updateProjectionMatrix();
  controls.update();
}

// ---- drawing one moment ---------------------------------------------------------------
const V = (p) => new THREE.Vector3(p[0], p[1], p[2]);
const lerp = (p, q, s) => new THREE.Vector3(p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, p[2] + (q[2] - p[2]) * s);

function draw() {
  const { ep, meta } = state;
  if (!ep) return;
  const t = Math.min(Math.max(state.t, 0), meta.F - 1);
  const i = Math.floor(t), f = t - i, j = Math.min(i + 1, meta.F - 1);
  const A = ep.frames[i], B = ep.frames[j];
  const s = B.phase === 'move' ? f * f * (3 - 2 * f) : 0;      // positions only change going into a move
  const Opos = A.O.map((p, k) => lerp(p, B.O[k], s));
  const Dpos = A.D.map((p, k) => lerp(p, B.D[k], s));
  const ex = meta.exposed[i];

  Opos.forEach((p, k) => {
    const mesh = objs.O[k], lab = objs.oLabels[k];
    mesh.position.copy(p);
    const e = meta.elim[k];
    if (i >= e) {
      const fade = Math.max(0, 1 - (t - e) / 0.9);         // gone by the next phase
      mesh.visible = fade > 0.01;
      mesh.material.color.setHex(fade > 0.75 ? 0xffffff : COL.dead);
      mesh.material.opacity = 0.9 * fade;
      mesh.scale.setScalar(1 + 0.8 * (1 - fade));
      lab.visible = false;
    } else {
      mesh.visible = true;
      mesh.material.color.setHex(ex[k] === false ? COL.shielded : COL.exposed);
      mesh.material.opacity = 1;
      mesh.scale.setScalar(1);
      lab.visible = $('#showLabels').checked;
      lab.position.copy(p).add(new THREE.Vector3(0, 0.27, 0));
    }
  });
  Dpos.forEach((p, k) => {
    objs.D[k].core.position.copy(p);
    objs.D[k].shell.position.copy(p);
    objs.dLabels[k].position.copy(p).add(new THREE.Vector3(0, 0.25, 0));
  });

  const L = meta.links[i];
  setSegments(objs.linkS, L.filter((e) => e.supported).map((e) => [Opos[e.a], Opos[e.b]]));
  setSegments(objs.linkU, L.filter((e) => !e.supported).map((e) => [Opos[e.a], Opos[e.b]]));
  const tubeR = 0.022 * ep.constants.r;
  objs.nerve.set(A.nerve.edges.map(([a, b]) => [Dpos[a], Dpos[b]]), tubeR);
  const tri = new Float32Array(A.nerve.triangles.length * 9);
  A.nerve.triangles.forEach(([a, b, c], k) => tri.set([...Dpos[a].toArray(), ...Dpos[b].toArray(), ...Dpos[c].toArray()], k * 9));
  objs.nerveTri.geometry.setAttribute('position', new THREE.BufferAttribute(tri, 3));
  objs.nerveTri.visible = A.nerve.triangles.length > 0 && $('#showNerve').checked;
  for (const [k, pool] of Object.entries(objs.hits)) {
    pool.set(A.phase === 'attack' ? A.hits.filter((h) => h.result === k).map((h) => [Dpos[h.d], V(A.O[h.o])]) : [], tubeR * 1.4);
  }
  // a floating tag on every hit that did not eliminate
  const tagged = A.phase === 'attack' ? A.hits.filter((h) => h.result !== 'eliminated') : [];
  objs.tags.forEach((tag, k) => {
    const h = tagged[k];
    tag.visible = !!h && $('#showAttacks').checked;
    if (!h) return;
    if (tag.userData.text !== h.result) {
      tag.material.map.dispose();
      tag.material.map = labelTexture(h.result.replace(/_/g, ' '), '#' + COL.hit[h.result].toString(16).padStart(6, '0'));
      tag.material.needsUpdate = true;
      tag.userData.text = h.result;
    }
    tag.position.copy(Dpos[h.d]).lerp(V(A.O[h.o]), 0.5).add(new THREE.Vector3(0, 0.22, 0));
  });
  applyToggles();
  updatePanels(i, t);
}

function survivorsAt(i) { return state.ep.frames[i].O_alive.filter(Boolean).length; }
function shapeDim(k) { return k >= 4 ? '3' : k === 3 ? '2 · triangle' : k === 2 ? '1 · edge' : k === 1 ? '0 · point' : 'empty'; }

let lastPanel = -1;
function updatePanels(i, t) {
  const { ep, meta } = state;
  const fr = ep.frames[i];
  const surv = survivorsAt(i);
  const D = ep.constants.deadline_ticks;
  $('#hud').innerHTML = `<b>Tick ${fr.tick} of ${D}</b> · ${PHASE[fr.phase]}<br>${surv} of ${meta.m} O left · ${meta.n} D`;
  $('#scrub').value = t / Math.max(1, meta.F - 1);
  for (const sp of document.querySelectorAll('#ticks span')) sp.classList.toggle('now', Number(sp.dataset.tick) === fr.tick);
  const end = i === meta.F - 1;
  const banner = $('#banner');
  banner.hidden = !end;
  if (end) {
    banner.className = 'banner ' + (ep.result.win ? 'win' : 'lose');
    banner.textContent = ep.result.win ? `D wins in ${ep.result.ticks_used} ticks` : `O survives: ${ep.result.survivors} left`;
  }
  if (i === lastPanel) return;
  lastPanel = i;
  const c = meta.cum[i];
  const tiles = [
    ['Tick', `${fr.tick} / ${D}`], ['Phase', PHASE[fr.phase]], ['O left', `${surv} / ${meta.m}`, surv ? '' : 'good'],
    ['Shape dimension', shapeDim(surv)], ['D players', meta.n], ['Eliminated', c.eliminated, 'good'],
    ['Wasted hits', c.wasted, c.wasted ? 'warn' : ''], ['Blocked hits', c.blocked, c.blocked ? 'bad' : ''],
  ];
  $('#readout').innerHTML = tiles.map(([k, v, cls]) => `<div class="tile"><span>${k}</span><b class="${cls || ''}">${v}</b></div>`).join('');
  const hits = $('#hits');
  hits.innerHTML = '';
  const ai = meta.attackOfTick[fr.tick];
  if (fr.phase === 'start') hits.innerHTML = '<li class="none">Play starts at tick 1.</li>';
  else if (ai === undefined || i < ai) hits.innerHTML = '<li class="none">Everyone is moving. Hits come next.</li>';
  else {
    const list = ep.frames[ai].hits;
    if (!list.length) hits.innerHTML = '<li class="none">No hits this tick.</li>';
    for (const h of list) {
      const li = document.createElement('li');
      li.className = h.result;
      li.innerHTML = `<span>D${h.d} → O${h.o}</span><span>${h.result.replace(/_/g, ' ')}</span>`;
      hits.appendChild(li);
    }
  }
}

function buildTicks() {
  const { ep, meta } = state;
  const box = $('#ticks');
  box.innerHTML = '';
  ep.frames.forEach((fr, i) => {
    if (fr.phase !== 'move' && fr.phase !== 'start') return;
    const sp = document.createElement('span');
    sp.style.left = `${(i / Math.max(1, meta.F - 1)) * 100}%`;
    if (i === 0) sp.style.transform = 'none';                    // keep 'Start' inside the track
    sp.dataset.tick = fr.tick;
    sp.textContent = `T${fr.tick}`;
    box.appendChild(sp);
  });
  lastPanel = -1;
}

function applyToggles() {
  const on = (id) => $(id).checked;
  objs.D?.forEach((d) => { d.shell.visible = on('#showSpheres'); });
  if (objs.linkS) { objs.linkS.visible &&= on('#showLinks'); objs.linkU.visible &&= on('#showLinks'); }
  objs.nerve?.show(on('#showNerve'));
  if (objs.hits) for (const p of Object.values(objs.hits)) p.show(on('#showAttacks'));
  objs.dLabels?.forEach((l) => { l.visible = on('#showLabels'); });
  controls.autoRotate = on('#autoRotate');
}

// ---- playback loop ------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const { ep, meta } = state;
  if (ep && state.playing) {
    const i = Math.min(Math.floor(state.t), meta.F - 1);
    const next = ep.frames[Math.min(i + 1, meta.F - 1)];
    state.t += (dt * state.speed) / DURATION[next.phase];
    if (state.t >= meta.F - 1) {
      state.t = meta.F - 1;
      state.playing = false;
      if (state.rec) state.holdUntil = now + 1500;
      syncPlay();
    }
  }
  controls.update();
  draw();
  renderer.render(scene, camera);
  if (state.rec) {
    composite();
    if (!state.playing && state.holdUntil && now > state.holdUntil) stopRecording();
  }
  requestAnimationFrame(frame);
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  const before = camera.aspect;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // refit when the shape of the view really changes (rotating a phone, resizing the window)
  if (state.fit && Math.abs(before - camera.aspect) > 0.05) fitCamera(camera.position.clone().sub(controls.target));
}
new ResizeObserver(resize).observe($('#canvasWrap'));

// ---- controls ---------------------------------------------------------------------------------
function syncPlay() { $('#play').textContent = state.playing ? 'Pause' : (state.ep && state.t >= state.meta.F - 1 ? 'Replay' : 'Play'); }
function togglePlay() {
  if (!state.ep) return;
  if (!state.playing && state.t >= state.meta.F - 1) state.t = 0;
  state.playing = !state.playing;
  syncPlay();
}
function stepPhase(dir) {
  if (!state.ep) return;
  state.playing = false;
  state.t = dir > 0 ? Math.min(Math.floor(state.t + 1e-6) + 1, state.meta.F - 1) : Math.max(Math.ceil(state.t - 1e-6) - 1, 0);
  syncPlay();
}
$('#play').onclick = togglePlay;
$('#next').onclick = () => stepPhase(1);
$('#prev').onclick = () => stepPhase(-1);
$('#restart').onclick = () => { state.t = 0; state.playing = true; syncPlay(); };
$('#scrub').oninput = (e) => { if (!state.ep) return; state.playing = false; state.t = Number(e.target.value) * (state.meta.F - 1); syncPlay(); };
for (const b of document.querySelectorAll('#speed button')) {
  b.onclick = () => {
    state.speed = Number(b.dataset.v);
    for (const x of document.querySelectorAll('#speed button')) x.classList.toggle('on', x === b);
  };
}
for (const id of ['#showSpheres', '#showLinks', '#showNerve', '#showAttacks', '#showLabels', '#autoRotate']) $(id).oninput = () => draw();
window.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, select, textarea')) return;
  if (ev.key === ' ') { ev.preventDefault(); togglePlay(); }
  else if (ev.key === 'ArrowRight') stepPhase(1);
  else if (ev.key === 'ArrowLeft') stepPhase(-1);
});

// ---- episode list and files --------------------------------------------------------------------
function renderList(activeKey) {
  const box = $('#episodes');
  box.innerHTML = '';
  for (const item of state.list) {
    const b = document.createElement('button');
    b.className = 'ep' + (item.key === activeKey ? ' on' : '');
    const t = document.createElement('strong'); t.textContent = item.title;
    const s = document.createElement('span'); s.textContent = item.blurb;
    b.append(t, s);
    b.onclick = () => open(item);
    box.appendChild(b);
  }
}

async function open(item) {
  try {
    const ep = item.data || (await (await fetch(`episodes/${item.file}`)).json());
    if (ep.format !== FORMAT) throw new Error(`not a ${FORMAT} file`);
    item.data = ep;
    state.name = (item.file || item.title).replace(/\.json$/, '');
    build(ep);
    renderList(item.key);
    state.playing = true;
    syncPlay();
  } catch (err) {
    $('#hits').innerHTML = '';
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = `Could not open this episode: ${err.message}`;
    $('#hits').appendChild(li);
  }
}

$('#fileInput').onchange = (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch { data = null; }
    const item = { key: `file:${file.name}`, title: `Your file: ${file.name}`, blurb: data?.title || 'Opened from your computer', data };
    if (!data) { item.blurb = 'Not valid JSON'; }
    state.list = [item, ...state.list.filter((x) => x.key !== item.key)];
    open(item);
  };
  reader.readAsText(file);
  ev.target.value = '';
};

// ---- video recording ------------------------------------------------------------------------------
const comp = document.createElement('canvas');
function composite() {
  const g = comp.getContext('2d');
  if (comp.width !== canvas.width || comp.height !== canvas.height) { comp.width = canvas.width; comp.height = canvas.height; }
  g.fillStyle = '#070b10';
  g.fillRect(0, 0, comp.width, comp.height);
  g.drawImage(canvas, 0, 0);
  const { ep, meta } = state;
  const i = Math.min(Math.floor(state.t), meta.F - 1);
  const fr = ep.frames[i];
  const u = comp.width / 900;
  g.font = `600 ${18 * u}px ui-monospace, Menlo, monospace`;
  g.fillStyle = '#d8e2ec';
  g.fillText(ep.title || 'Simplex Game', 20 * u, 34 * u);
  g.font = `${15 * u}px ui-monospace, Menlo, monospace`;
  g.fillStyle = '#9fb3c8';
  g.fillText(`Tick ${fr.tick} of ${ep.constants.deadline_ticks} · ${PHASE[fr.phase]} · ${survivorsAt(i)} of ${meta.m} O left · ${meta.n} D`, 20 * u, 58 * u);
  if (i === meta.F - 1) {
    g.font = `700 ${22 * u}px system-ui, sans-serif`;
    g.fillStyle = ep.result.win ? '#3ddc97' : '#ff6b6b';
    const msg = ep.result.win ? `D wins in ${ep.result.ticks_used} ticks` : `O survives: ${ep.result.survivors} left`;
    g.fillText(msg, 20 * u, comp.height - 24 * u);
  }
}

function startRecording() {
  const note = $('#recordNote');
  if (!state.ep) return;
  if (!comp.captureStream || !window.MediaRecorder) { note.textContent = 'This browser cannot record video.'; return; }
  const type = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  composite();
  const rec = new MediaRecorder(comp.captureStream(30), type ? { mimeType: type, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: rec.mimeType });
    const ext = rec.mimeType.includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.name || 'simplex-game'}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    note.textContent = `Saved ${a.download} (${(blob.size / 1e6).toFixed(1)} MB).`;
    $('#record').disabled = false;
  };
  state.rec = rec;
  state.holdUntil = 0;
  state.t = 0;
  state.playing = true;
  syncPlay();
  rec.start(250);
  $('#record').disabled = true;
  note.textContent = 'Recording… keep this tab visible until the game ends.';
}
function stopRecording() {
  const rec = state.rec;
  state.rec = null;
  state.holdUntil = 0;
  rec.stop();
}
$('#record').onclick = startRecording;

// ---- start ----------------------------------------------------------------------------------------
async function init() {
  try {
    const index = await (await fetch('episodes/index.json')).json();
    state.list = index.map((x) => ({ ...x, key: x.file }));
    renderList();
    await open(state.list[0]);
  } catch (err) {
    $('#hits').innerHTML = '<li class="none">Could not load the recorded games. Open an episode file instead.</li>';
  }
  resize();
  requestAnimationFrame(frame);
}

window.viewer = { state, seek: (t) => { state.playing = false; state.t = t; syncPlay(); } };
init();
