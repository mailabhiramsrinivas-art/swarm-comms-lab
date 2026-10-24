// Side-by-side demonstration: communication alone vs our model (communication + decision-making).
// The engagement is simulated with the formation game's rules (model-sim.js); the radio messages
// are drawn as dots travelling between drones.

import { RULES, read, delaunay, demoFormation, modelTeam, plainTeam } from './model-sim.js';

const W = 100, H = 75, S = { x: 84, y: 37.5 }, G = { x: 84, y: 45 }, RAD = Math.PI / 180;
const U = 7, TE = 7.5, ROUND = 1.3, ANCHOR = { x: 36, y: 37.5 };
const C = { bg: '#0b1118', drone: '#4da3ff', gs: '#b18cff', hit: '#ff4d6d', shield: '#3ddc97', unread: '#9a8c93', see: '#ffd166', plan: '#5ee6ff', claim: '#ff9f43' };
const HOME = [...Array(8)].map((_, k) => { const a = (22.5 + 45 * k) * RAD; return { x: S.x + 13 * Math.cos(a), y: S.y + 13 * Math.sin(a) }; });
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const lerp = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
const center = (t) => ({ x: 12 + 3.2 * Math.min(t, TE), y: 37.5 });
const toWorld = (p) => ({ x: ANCHOR.x + U * p.x, y: ANCHOR.y + U * p.y });
const home = (k) => (t) => ({ x: HOME[k].x + 0.5 * Math.sin(t * 1.3 + k), y: HOME[k].y + 0.5 * Math.cos(t * 1.1 + k) });

function buildScenario(kind) {
  const O0 = demoFormation();
  const homesR = HOME.map((h) => ({ x: (h.x - ANCHOR.x) / U, y: (h.y - ANCHOR.y) / U }));
  let team, drones;
  if (kind === 'model') {
    team = modelTeam(O0, 8);
    // the drones nearest the formation go; match them to the chosen spots
    const order = HOME.map((h, k) => [h.x, k]).sort((a, b) => a[0] - b[0]).map((e) => e[1]).slice(0, team.n);
    const used = new Set();
    drones = team.spots.map((s) => {
      let best = -1, bd = Infinity;
      for (const k of order) if (!used.has(k)) { const d = Math.hypot(homesR[k].x - s.x, homesR[k].y - s.y); if (d < bd) { bd = d; best = k; } }
      used.add(best);
      return best;
    });
  } else {
    team = plainTeam(O0, homesR);
    drones = HOME.map((_, k) => k);
  }
  const res = team.res, R = res.rounds.length, TR = TE + R * ROUND;
  const depart = kind === 'model' ? 4.6 : 3.4;
  const sc = { kind, O0, team, drones, res, R, TR, depart, msgs: [], bub: [], strikes: [], kills: {}, breach: {} };

  // threat kill times
  res.rounds.forEach((r, i) => r.hits.forEach((h) => {
    const ts = TE + i * ROUND + 0.65;
    sc.strikes.push({ t: ts, d: drones[h.d], o: h.o, ok: h.ok });
    if (h.ok && !(h.o in sc.kills)) sc.kills[h.o] = ts + 0.15;
  }));
  // survivors break through to the site after the deadline
  res.alive.forEach((a, i) => {
    if (!a) return;
    const p = toWorld(res.O[i]), d = Math.hypot(S.x - p.x, S.y - p.y);
    sc.breach[i] = { from: p, t0: TR, t1: TR + d / 15 };
  });

  // radio messages
  const relay = [[1.5, 'D3', 'D2'], [1.5, 'D3', 'D4'], [1.9, 'D2', 'D1'], [1.9, 'D4', 'D5'], [1.9, 'D4', 'G'], [2.3, 'D1', 'D0'], [2.3, 'D5', 'D6'], [2.7, 'D6', 'D7']];
  relay.forEach(([t, a, b]) => sc.msgs.push({ t, a, b, c: C.see }));
  const planTo = (t0, ks) => ks.forEach((k, i) => sc.msgs.push({ t: t0 + i * 0.05, a: 'G', b: 'D' + k, c: C.plan }));
  sc.bub.push([1.5, 'D3', 'Formation spotted']);
  if (kind === 'model') {
    planTo(4.0, drones);
    sc.bub.push([3.0, 'G', 'Reading the formation'], [4.0, 'G', `${team.n} go, ${8 - team.n} guard the site`]);
    let said = false;
    res.rounds.forEach((r, i) => r.claims.forEach(([a, b]) => {
      const t0 = TE + i * ROUND + 0.08;
      sc.msgs.push({ t: t0, a: 'D' + drones[a], b: 'D' + drones[b], c: C.claim }, { t: t0 + 0.28, a: 'D' + drones[b], b: 'D' + drones[a], c: C.claim });
      if (!said) { sc.bub.push([t0, 'D' + drones[a], 'I take this one']); said = true; }
    }));
    sc.bub.push([TR + 0.1, 'G', 'Cleared']);
  } else {
    planTo(3.0, drones);
    for (let i = 1; i < R; i++) planTo(TE + i * ROUND, drones);
    sc.bub.push([3.0, 'G', 'Everyone go']);
    const fb = sc.strikes.find((s) => !s.ok);
    if (fb) sc.bub.push([fb.t, 'D' + fb.d, 'Blocked: shielded']);
    const firstBreach = Math.min(...Object.values(sc.breach).map((b) => b.t1));
    if (isFinite(firstBreach)) sc.bub.push([firstBreach, 'G', `${res.left} got through`]);
  }

  // captions
  const rd0 = team.reading, shielded = rd0.exposed.filter((e) => !e).length;
  const blockedR1 = res.rounds[0] ? res.rounds[0].hits.filter((h) => !h.ok).length : 0;
  sc.cap = kind === 'model' ? [
    [0, 'A formation of 12 threats heads for the site.'],
    [1.5, 'A drone spots it. The warning hops from drone to drone until the leader knows.'],
    [3.0, `Our model reads the formation: ${12 - shielded} threats on the outside can be hit, ${shielded} inside are shielded.`],
    [4.0, `It picks the smallest team that clears it within 5 rounds: ${team.n} drones. ${8 - team.n} stay to guard the site.`],
    [4.6, 'The plan goes out by radio and the drones fly to the positions our model chose.'],
    [TE, 'Each round, drones that can reach the same threat agree by radio who takes it, then all strike together.'],
    [TR + 0.1, `Cleared in ${R} rounds with no blocked hits, using ${team.n} of 8 drones.`],
  ] : [
    [0, 'A formation of 12 threats heads for the site.'],
    [1.5, 'A drone spots it. The warning hops from drone to drone until the leader knows.'],
    [3.0, 'With communication alone, the leader sends all 8 drones at the nearest threats.'],
    [TE, 'Some of those threats are shielded inside the formation, so those hits are blocked.'],
    [TE + ROUND, `${blockedR1} hits blocked. The formation scatters and the drones chase it.`],
    [TR, res.won ? `Cleared in ${R} rounds, with ${res.blocked} hits blocked.` : `After 5 rounds, ${res.left} threats are still flying and break through to the site.`],
  ];
  return sc;
}

// ---------- positions over time ----------
function threatPos(sc, i, t) {
  if (t <= TE) { const c = center(t), p = sc.O0[i]; return { x: c.x + U * p.x, y: c.y + U * p.y }; }
  const k = Math.floor((t - TE) / ROUND);
  if (k < sc.R) { const r = sc.res.rounds[k], u = ease(((t - TE) - k * ROUND) / 0.6); return toWorld(lerp(r.O[i], r.On[i], u)); }
  const b = sc.breach[i];
  if (b) { const u = Math.min(1, (t - b.t0) / (b.t1 - b.t0)); return lerp(b.from, S, u); }
  return toWorld(sc.res.O[i]);
}
function threatAlive(sc, i, t) {
  if (i in sc.kills) return t < sc.kills[i];
  const b = sc.breach[i];
  return !b || t < b.t1;
}
function dronePos(sc, k, t) {
  const j = sc.drones.indexOf(k), h = home(k)(t);
  if (j < 0 || t <= sc.depart) return h;
  const spot = sc.team.spots[j];
  if (t <= TE) { const c = center(t); return lerp(h, { x: c.x + U * spot.x, y: c.y + U * spot.y }, ease((t - sc.depart) / (TE - sc.depart))); }
  const kk = Math.floor((t - TE) / ROUND);
  if (kk < sc.R) { const r = sc.res.rounds[kk], u = ease(((t - TE) - kk * ROUND) / 0.6); return toWorld(lerp(r.D[j], r.Dn[j], u)); }
  if (!sc.res.won) return toWorld(sc.res.D[j]);
  return lerp(toWorld(sc.res.D[j]), h, ease((t - sc.TR - 0.6) / 3));
}
const nodePos = (sc, id, t) => (id === 'G' ? G : dronePos(sc, +id.slice(1), t));

// ---------- drawing ----------
function draw(cv, sc, t) {
  const c = cv.getContext('2d'), u = cv._d || 1, w = cv.width, h = cv.height, k = w / W, X = (v) => v * k;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = C.bg; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(120,150,180,0.07)'; c.lineWidth = u;
  for (let x = 10; x < W; x += 10) { c.beginPath(); c.moveTo(X(x), 0); c.lineTo(X(x), h); c.stroke(); }
  for (let y = 10; y < H; y += 10) { c.beginPath(); c.moveTo(0, X(y)); c.lineTo(w, X(y)); c.stroke(); }
  // radio links
  const nodes = [G, ...HOME.map((_, i) => dronePos(sc, i, t))];
  c.strokeStyle = 'rgba(77,163,255,0.13)';
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 24) { c.beginPath(); c.moveTo(X(a.x), X(a.y)); c.lineTo(X(b.x), X(b.y)); c.stroke(); }
  }
  // site and leader
  c.strokeStyle = '#e8eef5'; c.lineWidth = 1.5 * u;
  c.beginPath(); c.arc(X(S.x), X(S.y), X(3), 0, 7); c.stroke();
  c.beginPath(); c.moveTo(X(S.x - 1.6), X(S.y)); c.lineTo(X(S.x + 1.6), X(S.y)); c.moveTo(X(S.x), X(S.y - 1.6)); c.lineTo(X(S.x), X(S.y + 1.6)); c.stroke();
  c.fillStyle = 'rgba(177,140,255,0.25)'; c.strokeStyle = C.gs;
  c.beginPath(); for (let i = 0; i < 6; i++) { const a = (60 * i + 30) * RAD; c.lineTo(X(G.x + 2.2 * Math.cos(a)), X(G.y + 2.2 * Math.sin(a))); } c.closePath(); c.fill(); c.stroke();
  if (sc.kind === 'model') { c.font = `500 ${11 * u}px sans-serif`; c.fillStyle = C.plan; c.textAlign = 'center'; c.fillText('Model', X(G.x), X(G.y + 6.2)); }
  // threats, read with the real rule from their current positions
  const ids = sc.O0.map((_, i) => i).filter((i) => threatAlive(sc, i, t));
  const P = sc.O0.map((_, i) => threatPos(sc, i, t));
  const alive = sc.O0.map((_, i) => ids.includes(i));
  const showRead = sc.kind === 'model' && t >= 3.0 && t < sc.TR + 0.2;
  let exposed = null;
  if (showRead) {
    const Pr = P.map((p) => ({ x: p.x / U, y: p.y / U }));
    const rd = read(Pr, alive);
    exposed = rd.exposed;
    const al = Math.min(1, (t - 3.0) / 0.8) * 0.5;
    c.strokeStyle = `rgba(150,190,230,${al})`; c.lineWidth = u;
    for (const [a, b] of rd.edges) { c.beginPath(); c.moveTo(X(P[a].x), X(P[a].y)); c.lineTo(X(P[b].x), X(P[b].y)); c.stroke(); }
  }
  for (const i of ids) {
    const p = P[i];
    let col = C.unread, sh = false;
    if (exposed && t >= 3.6) { if (exposed[i]) col = C.hit; else { col = C.shield; sh = true; } }
    if (sc.kind !== 'model') for (const s of sc.strikes) if (!s.ok && s.o === i && t >= s.t && t < s.t + 1.1) { col = C.shield; sh = true; }
    c.fillStyle = col; c.beginPath(); c.arc(X(p.x), X(p.y), X(1.75), 0, 7); c.fill();
    if (sh) { c.strokeStyle = 'rgba(61,220,151,0.7)'; c.lineWidth = 1.3 * u; c.beginPath(); c.arc(X(p.x), X(p.y), X(2.8), 0, 7); c.stroke(); }
  }
  // kills and breaches
  for (const i in sc.kills) { const e = t - sc.kills[i]; if (e >= 0 && e < 0.6) { const p = threatPos(sc, +i, sc.kills[i]); c.strokeStyle = `rgba(255,255,255,${1 - e / 0.6})`; c.lineWidth = 1.5 * u; c.beginPath(); c.arc(X(p.x), X(p.y), X(1.4 + 5 * e), 0, 7); c.stroke(); } }
  for (const i in sc.breach) { const e = t - sc.breach[i].t1; if (e >= 0 && e < 0.8) { c.strokeStyle = `rgba(255,77,109,${1 - e / 0.8})`; c.lineWidth = 2.5 * u; c.beginPath(); c.arc(X(S.x), X(S.y), X(3 + 6 * e), 0, 7); c.stroke(); } }
  // strikes
  for (const s of sc.strikes) {
    const e = t - s.t; if (e < -0.05 || e >= 0.32) continue;
    const a = dronePos(sc, s.d, t), b = threatPos(sc, s.o, s.t);
    c.strokeStyle = s.ok ? 'rgba(255,255,255,0.9)' : C.shield; c.lineWidth = 1.6 * u;
    c.beginPath(); c.moveTo(X(a.x), X(a.y)); c.lineTo(X(b.x), X(b.y)); c.stroke();
    if (!s.ok) {
      c.strokeStyle = C.shield; c.lineWidth = 2 * u; c.beginPath(); c.arc(X(b.x), X(b.y), X(3.6), 0, 7); c.stroke();
      c.strokeStyle = '#ff6b6b'; c.beginPath(); c.moveTo(X(b.x - 1.2), X(b.y - 1.2)); c.lineTo(X(b.x + 1.2), X(b.y + 1.2)); c.moveTo(X(b.x + 1.2), X(b.y - 1.2)); c.lineTo(X(b.x - 1.2), X(b.y + 1.2)); c.stroke();
    }
  }
  // messages in flight
  for (const m of sc.msgs) {
    const e = t - m.t; if (e < 0 || e > 0.7) continue;
    const a = nodePos(sc, m.a, t), b = nodePos(sc, m.b, t);
    if (e < 0.4) {
      const q = e / 0.4;
      c.strokeStyle = m.c + '40'; c.lineWidth = u; c.beginPath(); c.moveTo(X(a.x), X(a.y)); c.lineTo(X(b.x), X(b.y)); c.stroke();
      for (let j = 2; j >= 0; j--) { const qq = Math.max(0, q - j * 0.08); c.fillStyle = m.c; c.globalAlpha = j ? 0.35 / j : 1; c.beginPath(); c.arc(X(a.x + (b.x - a.x) * qq), X(a.y + (b.y - a.y) * qq), (j ? 2 : 3.3) * u, 0, 7); c.fill(); }
      c.globalAlpha = 1;
    } else {
      const r = (e - 0.4) / 0.3; c.strokeStyle = m.c; c.globalAlpha = 1 - r; c.lineWidth = 1.5 * u;
      c.beginPath(); c.arc(X(b.x), X(b.y), X(1.5 + 3 * r), 0, 7); c.stroke(); c.globalAlpha = 1;
    }
  }
  // drones
  for (let i = 0; i < 8; i++) {
    const p = dronePos(sc, i, t), q = dronePos(sc, i, t + 0.08);
    let ang = Math.atan2(q.y - p.y, q.x - p.x); if (Math.hypot(q.x - p.x, q.y - p.y) < 0.02) ang = -Math.PI / 2;
    c.save(); c.translate(X(p.x), X(p.y)); c.rotate(ang); c.fillStyle = C.drone;
    c.beginPath(); c.moveTo(X(2.5), 0); c.lineTo(X(-1.6), X(1.6)); c.lineTo(X(-0.8), 0); c.lineTo(X(-1.6), X(-1.6)); c.closePath(); c.fill(); c.restore();
  }
  // speech bubbles
  c.font = `${11 * u}px sans-serif`; c.textAlign = 'left';
  for (const [bt, at, tx] of sc.bub) {
    const e = t - bt; if (e < 0 || e > 1.5) continue;
    const p = nodePos(sc, at, t), tw = c.measureText(tx).width, pw = tw + 12 * u, ph = 18 * u;
    let bx = X(p.x) + 8 * u, by = X(p.y) - 26 * u;
    if (bx + pw > w - 4 * u) bx = X(p.x) - pw - 8 * u;
    bx = Math.max(4 * u, bx); by = Math.max(4 * u, by);
    c.globalAlpha = e < 0.15 ? e / 0.15 : e > 1.3 ? (1.5 - e) / 0.2 : 1;
    c.fillStyle = 'rgba(255,255,255,0.94)'; c.beginPath(); c.roundRect ? c.roundRect(bx, by, pw, ph, 5 * u) : c.rect(bx, by, pw, ph); c.fill();
    c.fillStyle = '#0f1d26'; c.fillText(tx, bx + 6 * u, by + 12.5 * u); c.globalAlpha = 1;
  }
}

function stats(sc, t) {
  const sent = t >= (sc.kind === 'model' ? 4.0 : 3.0) ? sc.team.n : 0;
  const rounds = sc.res.rounds.filter((_, i) => t >= TE + i * ROUND + 0.65).length;
  const blocked = sc.strikes.filter((s) => !s.ok && t >= s.t).length;
  const through = Object.values(sc.breach).filter((b) => t >= b.t1).length;
  let cap = ''; for (const [ct, tx] of sc.cap) if (t >= ct) cap = tx;
  return { sent, rounds, blocked, through, cap };
}

export function mountModelDemo(root) {
  const scenes = { plain: buildScenario('plain'), model: buildScenario('model') };
  const END = Math.max(...Object.values(scenes).map((s) => Math.max(s.TR + 4, ...Object.values(s.breach).map((b) => b.t1 + 1.5))));
  const LOOP = END + 2;
  const canv = { plain: root.querySelector('[data-scene="plain"] canvas'), model: root.querySelector('[data-scene="model"] canvas') };
  const fit = () => { for (const cv of Object.values(canv)) { const d = Math.min(window.devicePixelRatio || 1, 2), cw = cv.clientWidth || 320; cv.style.height = cw * 0.75 + 'px'; cv.width = Math.round(cw * d); cv.height = Math.round(cw * 0.75 * d); cv._d = d; } };
  new ResizeObserver(fit).observe(canv.model); fit();
  const pp = root.querySelector('[data-action="play"]'), scr = root.querySelector('[data-scrub]'), tm = root.querySelector('[data-time]');
  if (scr) scr.max = END.toFixed(1);
  let t = 0, playing = !matchMedia('(prefers-reduced-motion: reduce)').matches, last = null, visible = true;
  const syncBtn = () => { if (pp) { pp.textContent = playing ? 'Pause' : 'Play'; pp.setAttribute('aria-label', playing ? 'Pause the demonstration' : 'Play the demonstration'); } };
  if (pp) pp.onclick = () => { playing = !playing; syncBtn(); };
  const rs = root.querySelector('[data-action="restart"]'); if (rs) rs.onclick = () => { t = 0; playing = true; syncBtn(); };
  const sp = root.querySelector('[data-speed]'); let speed = 1; if (sp) sp.onchange = () => { speed = +sp.value; };
  if (scr) scr.oninput = () => { t = +scr.value; playing = false; syncBtn(); };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canv.model);
  syncBtn();
  const setText = (sel, v) => { const el = root.querySelector(sel); if (el && el.textContent !== String(v)) el.textContent = v; };
  function frame(ts) {
    if (last == null) last = ts;
    const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
    if (visible) {
      if (playing) { t += dt * speed; if (t > LOOP) t = 0; }
      const tc = Math.min(t, END);
      for (const key of ['plain', 'model']) {
        draw(canv[key], scenes[key], tc);
        const s = stats(scenes[key], tc);
        setText(`[data-scene="${key}"] [data-stat="sent"]`, s.sent);
        setText(`[data-scene="${key}"] [data-stat="rounds"]`, s.rounds);
        setText(`[data-scene="${key}"] [data-stat="blocked"]`, s.blocked);
        setText(`[data-scene="${key}"] [data-stat="through"]`, s.through);
        setText(`[data-scene="${key}"] [data-caption]`, s.cap);
      }
      if (scr) scr.value = tc.toFixed(1);
      if (tm) tm.textContent = tc.toFixed(1) + ' s';
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { scenes, seek: (v) => { t = v; playing = false; syncBtn(); } };
}

for (const el of document.querySelectorAll('[data-model-demo]')) el._demo = mountModelDemo(el);
