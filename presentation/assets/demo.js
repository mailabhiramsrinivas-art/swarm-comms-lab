// A plain-language front end for the Swarm Comms Lab simulator.
// It reuses the engineering simulator's own engine and renderer from /js unchanged,
// and only replaces the controls, the readouts and the wording around them.

import { defaultConfig } from '../../js/config.js';
import { Sim } from '../../js/sim.js';
import { Renderer, COLORS } from '../../js/render.js';

const DT = 1 / 60;
const DIR = { E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west', N: 'north', NE: 'north-east' };
const BASE_LOSS = 0.02;

const who = (name) => (name === 'GS' ? 'the ground station' : 'Drone ' + name.slice(1));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function freshConfig() {
  const cfg = defaultConfig();
  cfg.comms.loss = BASE_LOSS;
  cfg.comms.latencyMs = 15;
  return cfg;
}

// Turn the simulator's engineering log into sentences an investor can read.
function plain(l) {
  const t = l.text;
  let m;
  switch (l.type) {
    case 'wave':
      m = t.match(/^Wave (\d+): (\d+) enemies from the (\w+)/);
      return m ? `Wave ${m[1]}: ${m[2]} threats coming in from the ${DIR[m[3]] || m[3]}` : null;
    case 'coord':
      if ((m = t.match(/^(\w+) is now coordinator/))) return `${cap(who(m[1]))} is now leading the swarm`;
      if ((m = t.match(/^(\w+) steps down: hears (\w+)/))) return `${cap(who(m[1]))} hands the lead back to ${who(m[2])}`;
      if ((m = t.match(/^(\w+) stops coordinating/))) return `${cap(who(m[1]))} is out of contact and stops leading`;
      return null;
    case 'lost':
      m = t.match(/^(\w+) destroyed( \(was coordinator\))?/);
      return m ? `${cap(who(m[1]))} was destroyed${m[2] ? ' while leading the swarm' : ''}` : null;
    case 'net':
      m = t.match(/split into (\d+)/);
      return m ? `The swarm split into ${m[1]} groups that cannot hear each other` : 'The swarm is back in contact as one group';
    case 'breach':
      return 'A threat reached the protected site';
    default:
      return null;
  }
}

export function mountDemo(root) {
  const canvas = root.querySelector('canvas');
  const q = (s) => root.querySelector(s);
  const playBtn = q('[data-action="play"]');
  const feed = q('[data-feed]');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let cfg = freshConfig();
  const sim = new Sim(cfg, 'clear');
  const renderer = new Renderer(canvas);
  renderer.opts = { links: true, sensors: false, targets: true, belief: true };

  let playing = !reduce, visible = true, last = null, acc = 0, logCursor = 0;
  const events = [];

  function setPressed(action, on) {
    const b = q(`[data-action="${action}"]`);
    if (b) b.setAttribute('aria-pressed', String(on));
  }

  function reset() {
    cfg = freshConfig();
    sim.reset(cfg, 'clear');
    renderer.resize();
    logCursor = 0;
    events.length = 0;
    setPressed('jam', false);
    setPressed('cut', false);
    note('Simulation restarted: 8 drones and the ground station guarding the site');
  }

  function note(text) {
    events.unshift({ t: sim.time, text });
    events.length = Math.min(events.length, 6);
    renderFeed();
  }

  const actions = {
    play() { playing = !playing; syncPlay(); },
    wave() { sim.spawnWave(); },
    kill() {
      if (!sim.nodes.some((n) => n.alive && n.isCoord)) { note('There is no leader to destroy right now'); return; }
      sim.killCoordinator();
    },
    jam() {
      const on = !cfg.comms.zone.on;
      cfg.comms.zone.on = on;
      setPressed('jam', on);
      if (on) { sim.spawnWave(Math.PI * 1.25); note('Radio jammed in the orange area. Threats are coming in through it'); }
      else note('Jamming switched off');
    },
    cut() {
      const on = cfg.comms.loss < 1;
      cfg.comms.loss = on ? 1 : BASE_LOSS;
      setPressed('cut', on);
      note(on ? 'All radio links cut. Every drone is now on its own' : 'Radio links restored');
    },
    respawn() { sim.respawnLost(); note('Lost drones replaced'); },
    reset,
  };

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && actions[b.dataset.action]) actions[b.dataset.action]();
  });

  function syncPlay() {
    if (!playBtn) return;
    playBtn.textContent = playing ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-label', playing ? 'Pause the simulation' : 'Play the simulation');
  }

  function pullLogs() {
    for (const l of sim.logs) {
      if (l.n <= logCursor) continue;
      logCursor = l.n;
      const text = plain(l);
      if (text) events.unshift({ t: l.t, text });
    }
    events.length = Math.min(events.length, 6);
  }

  function renderFeed() {
    if (!feed) return;
    if (!events.length) { feed.innerHTML = '<li class="none">Waiting for the first wave…</li>'; return; }
    feed.innerHTML = events.map((e, i) =>
      `<li class="${i === 0 ? 'fresh' : ''}"><time>${clock(e.t)}</time><span>${e.text}</span></li>`).join('');
  }

  const stat = (k) => q(`[data-stat="${k}"]`);
  function renderStats() {
    const m = sim.metrics();
    const set = (k, v) => { const el = stat(k); if (el && el.textContent !== v) el.textContent = v; };
    set('stopped', m.intercepted.toLocaleString());
    set('through', m.breaches.toLocaleString());
    set('reaction', m.avgResponse != null ? m.avgResponse.toFixed(1) + ' s' : '–');
    set('leader', m.coordinators.length ? m.coordinators.map((n) => cap(who(n))).join(' and ') : 'Nobody: every drone is on its own');
    const total = m.layers[3] + m.layers[2] + m.layers[1];
    const bar = q('[data-modes]');
    if (bar && total) {
      bar.children[0].style.width = (100 * m.layers[3] / total) + '%';
      bar.children[1].style.width = (100 * m.layers[2] / total) + '%';
      bar.children[2].style.width = (100 * m.layers[1] / total) + '%';
    }
    set('m3', String(m.layers[3]));
    set('m2', String(m.layers[2]));
    set('m1', String(m.layers[1]));
  }

  // The engine's renderer prints an engineering status line in the top corner.
  // Paint over it and write a plain one instead.
  function plainOverlay() {
    const g = canvas.getContext('2d');
    const u = renderer.dpr;
    const m = sim.metrics();
    g.setTransform(1, 0, 0, 1, 0, 0);
    // Same string and font the renderer used, so only its box is covered.
    const hud = `t ${sim.time.toFixed(1)}s   coordinator ${m.coordinators.join(' + ') || 'none'}   ` +
      `L3 ${m.layers[3]} · L2 ${m.layers[2]} · L1 ${m.layers[1]}`;
    g.font = `${11 * u}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    g.fillStyle = COLORS.bg;
    g.fillRect(5 * u, 5 * u, g.measureText(hud).width + 14 * u, 22 * u);
    const lead = m.coordinators.length ? 'Leader: ' + m.coordinators.map((n) => cap(who(n))).join(' + ') : 'No leader: every drone on its own';
    g.font = `600 ${12 * u}px system-ui, -apple-system, sans-serif`;
    const w = g.measureText(lead).width;
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.roundRect ? g.roundRect(8 * u, 7 * u, w + 18 * u, 21 * u, 6 * u) : g.rect(8 * u, 7 * u, w + 18 * u, 21 * u);
    g.fill();
    g.fillStyle = '#e6eef6';
    g.textAlign = 'left';
    g.fillText(lead, 17 * u, 22 * u);
  }

  let statTimer = 0;
  function frame(ts) {
    if (last == null) last = ts;
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    // Off screen: no stepping and no drawing, so a long page stays light.
    if (!visible) { acc = 0; requestAnimationFrame(frame); return; }
    if (playing) {
      acc += dt;
      let steps = 0;
      while (acc >= DT && steps < 20) { sim.step(DT); acc -= DT; steps++; }
    } else acc = 0;
    renderer.draw(sim);
    plainOverlay();
    statTimer += dt;
    if (statTimer > 0.2) {
      statTimer = 0;
      const before = logCursor;
      pullLogs();
      if (logCursor !== before) renderFeed();
      renderStats();
    }
    requestAnimationFrame(frame);
  }

  new ResizeObserver(() => renderer.resize()).observe(canvas);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden) last = null; });

  syncPlay();
  renderFeed();
  renderStats();
  requestAnimationFrame(frame);
  return { sim, actions };
}

for (const el of document.querySelectorAll('[data-demo]')) mountDemo(el);
