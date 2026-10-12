// Canvas renderer. Reads the sim; never changes it.

import { extrapolate } from './policy.js';

export const COLORS = {
  bg: '#0a0f15',
  grid: 'rgba(120,150,180,0.06)',
  ring: 'rgba(120,150,180,0.12)',
  text: '#d8e2ec',
  muted: '#7f93a8',
  l3: '#4da3ff',
  l2: '#f5b342',
  l1: '#ff6b6b',
  enemy: '#ff4d6d',
  tag: '#3ddc97',
  gs: '#b18cff',
  zone: '#f5b342',
  asset: '#e8eef5',
};
export const LAYER_COLOR = { 3: COLORS.l3, 2: COLORS.l2, 1: COLORS.l1, 0: COLORS.gs };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.opts = { links: true, sensors: false, targets: true, belief: true };
    this.selected = null;
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.max(200, Math.round(r.width));
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.px = size;
    this.dpr = dpr;
  }

  toWorld(clientX, clientY, sim) {
    const r = this.canvas.getBoundingClientRect();
    const s = sim.cfg.world.size / r.width;
    return { x: (clientX - r.left) * s, y: (clientY - r.top) * s };
  }

  draw(sim) {
    const g = this.g, W = sim.cfg.world.size;
    const k = (this.px / W) * this.dpr;     // world -> device pixels
    const u = this.dpr;                      // one CSS pixel
    const X = (v) => v * k;
    const now = sim.time;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // grid and range rings
    g.strokeStyle = COLORS.grid;
    g.lineWidth = u;
    g.beginPath();
    for (let v = 100; v < W; v += 100) {
      g.moveTo(X(v), 0); g.lineTo(X(v), X(W));
      g.moveTo(0, X(v)); g.lineTo(X(W), X(v));
    }
    g.stroke();
    const A = sim.cfg.asset;
    g.strokeStyle = COLORS.ring;
    g.setLineDash([4 * u, 6 * u]);
    for (const r of [150, 300, 450]) { g.beginPath(); g.arc(X(A.x), X(A.y), X(r), 0, 7); g.stroke(); }
    g.setLineDash([]);

    // interference zone
    const z = sim.cfg.comms.zone;
    if (z.on) {
      g.fillStyle = `rgba(245,179,66,${0.05 + 0.08 * z.strength})`;
      g.strokeStyle = 'rgba(245,179,66,0.55)';
      g.setLineDash([6 * u, 5 * u]);
      g.beginPath(); g.arc(X(z.x), X(z.y), X(z.r), 0, 7); g.fill(); g.stroke();
      g.setLineDash([]);
      this.label(g, 'interference ' + Math.round(z.strength * 100) + '%', X(z.x), X(z.y - z.r) - 6 * u, 'rgba(245,179,66,0.85)', u, 'center');
    }

    const alive = sim.nodes.filter((n) => n.alive);

    // sensor footprints
    if (this.opts.sensors) {
      g.fillStyle = 'rgba(77,163,255,0.035)';
      g.strokeStyle = 'rgba(77,163,255,0.12)';
      g.lineWidth = u;
      for (const n of alive) { g.beginPath(); g.arc(X(n.x), X(n.y), X(n.sensor), 0, 7); g.fill(); g.stroke(); }
    }

    // radio links: brightness = recent traffic
    if (this.opts.links) {
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i], b = alive[j];
          if (!sim.net.linked(a, b)) continue;
          const key = a.id < b.id ? a.id + '-' + b.id : b.id + '-' + a.id;
          const heat = sim.net.linkHeat.get(key) || 0;
          const degraded = sim.net.inZone(a) || sim.net.inZone(b);
          const al = Math.min(0.5, 0.05 + 0.07 * Math.log1p(heat));
          g.strokeStyle = degraded ? `rgba(245,179,66,${al * 0.7})` : `rgba(77,163,255,${al})`;
          g.lineWidth = u * (degraded ? 1 : 1 + Math.min(1, 0.15 * Math.log1p(heat)));
          if (degraded) g.setLineDash([3 * u, 4 * u]);
          g.beginPath(); g.moveTo(X(a.x), X(a.y)); g.lineTo(X(b.x), X(b.y)); g.stroke();
          if (degraded) g.setLineDash([]);
        }
      }
    }

    // what each drone is chasing (its belief, not the truth)
    if (this.opts.targets) {
      g.setLineDash([5 * u, 5 * u]);
      g.lineWidth = 1.2 * u;
      for (const n of alive) {
        if (n.kind !== 'drone' || n.target == null) continue;
        const tr = n.tracks.get(n.target);
        if (!tr) continue;
        const e = extrapolate(tr, now);
        g.strokeStyle = hexA(LAYER_COLOR[n.layer], 0.55);
        g.beginPath(); g.moveTo(X(n.x), X(n.y)); g.lineTo(X(e.x), X(e.y)); g.stroke();
      }
      g.setLineDash([]);
    }

    // enemies (truth). Dim outline = nobody currently sees it.
    const seenNow = new Set();
    for (const n of alive) for (const o of n.visible) seenNow.add(o.id);
    for (const e of sim.enemies) {
      const s = 7 * u, x = X(e.x), y = X(e.y);
      g.beginPath();
      g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath();
      if (seenNow.has(e.id)) {
        g.fillStyle = COLORS.enemy; g.fill();
      } else {
        g.strokeStyle = 'rgba(255,77,109,0.45)'; g.lineWidth = 1.2 * u; g.stroke();
      }
      this.label(g, 'E' + e.id, x + 9 * u, y - 7 * u, seenNow.has(e.id) ? 'rgba(255,140,160,0.9)' : 'rgba(255,77,109,0.4)', u);
    }

    // protected asset
    const flash = sim.effects.some((f) => f.kind === 'breach');
    g.strokeStyle = flash ? COLORS.l1 : COLORS.asset;
    g.lineWidth = 1.5 * u;
    g.beginPath(); g.arc(X(A.x), X(A.y), X(A.r), 0, 7); g.stroke();
    g.fillStyle = flash ? 'rgba(255,107,107,0.25)' : 'rgba(232,238,245,0.06)';
    g.fill();
    g.beginPath();
    g.moveTo(X(A.x) - 6 * u, X(A.y)); g.lineTo(X(A.x) + 6 * u, X(A.y));
    g.moveTo(X(A.x), X(A.y) - 6 * u); g.lineTo(X(A.x), X(A.y) + 6 * u);
    g.stroke();

    // lost nodes
    for (const n of sim.nodes) {
      if (n.alive || (n.kind === 'gs' && !sim.cfg.gs.enabled)) continue;
      const x = X(n.x), y = X(n.y), s = 5 * u;
      g.strokeStyle = 'rgba(127,147,168,0.45)'; g.lineWidth = 1.5 * u;
      g.beginPath(); g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s); g.stroke();
    }

    // nodes
    for (const n of alive) {
      const x = X(n.x), y = X(n.y);
      const col = n.kind === 'gs' ? COLORS.gs : LAYER_COLOR[n.layer];
      if (n.kind === 'gs') {
        const s = 10 * u;
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i + Math.PI / 6;
          g[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * s, y + Math.sin(a) * s);
        }
        g.closePath();
        g.fillStyle = hexA(col, 0.25); g.fill();
        g.strokeStyle = col; g.lineWidth = 1.5 * u; g.stroke();
      } else {
        let hx = n.vx, hy = n.vy;
        const sp = Math.hypot(hx, hy);
        if (sp < 1) { hx = 0; hy = -1; } else { hx /= sp; hy /= sp; }
        const s = 8 * u;
        g.beginPath();
        g.moveTo(x + hx * s * 1.2, y + hy * s * 1.2);
        g.lineTo(x - hx * s * 0.7 - hy * s * 0.7, y - hy * s * 0.7 + hx * s * 0.7);
        g.lineTo(x - hx * s * 0.3, y - hy * s * 0.3);
        g.lineTo(x - hx * s * 0.7 + hy * s * 0.7, y - hy * s * 0.7 - hx * s * 0.7);
        g.closePath();
        g.fillStyle = col; g.fill();
      }
      if (n.isCoord) {
        g.strokeStyle = COLORS.text;
        g.lineWidth = 1.2 * u;
        g.setLineDash([3 * u, 3 * u]);
        g.lineDashOffset = -now * 12 * u;
        g.beginPath(); g.arc(x, y, 15 * u, 0, 7); g.stroke();
        g.setLineDash([]); g.lineDashOffset = 0;
      }
      if (this.selected === n.id) {
        g.strokeStyle = '#ffffff'; g.lineWidth = 1.5 * u;
        g.beginPath(); g.arc(x, y, 19 * u, 0, 7); g.stroke();
      }
      this.label(g, n.name + (n.isCoord ? ' ★' : ''), x + 11 * u, y + 13 * u, n.kind === 'gs' ? COLORS.gs : COLORS.text, u);
    }

    // inspector overlay: the selected node's private picture of the world
    const sel = this.selected != null ? sim.node(this.selected) : null;
    if (sel && sel.alive) {
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.setLineDash([2 * u, 6 * u]);
      g.lineWidth = u;
      g.beginPath(); g.arc(X(sel.x), X(sel.y), X(sel.radio), 0, 7); g.stroke();
      g.setLineDash([]);
      if (this.opts.belief) {
        const truth = new Map(sim.enemies.map((e) => [e.id, e]));
        for (const tr of sel.tracks.values()) {
          const e = extrapolate(tr, now);
          const age = now - tr.t;
          const al = Math.max(0.2, 1 - age);
          g.strokeStyle = `rgba(255,255,255,${al})`;
          g.lineWidth = 1.3 * u;
          g.beginPath(); g.arc(X(e.x), X(e.y), 10 * u, 0, 7); g.stroke();
          const t = truth.get(tr.id);
          if (t) {
            g.strokeStyle = `rgba(255,255,255,${al * 0.5})`;
            g.beginPath(); g.moveTo(X(e.x), X(e.y)); g.lineTo(X(t.x), X(t.y)); g.stroke();
          }
        }
      }
    }

    // effects
    for (const f of sim.effects) {
      const p = (now - f.t) / f.life;
      const x = X(f.x), y = X(f.y);
      if (f.kind === 'tag') {
        g.strokeStyle = hexA(COLORS.tag, 1 - p); g.lineWidth = 2 * u;
        g.beginPath(); g.arc(x, y, (4 + 24 * p) * u, 0, 7); g.stroke();
      } else if (f.kind === 'breach') {
        g.strokeStyle = hexA(COLORS.l1, 1 - p); g.lineWidth = 3 * u;
        g.beginPath(); g.arc(X(A.x), X(A.y), X(A.r) + 30 * p * u, 0, 7); g.stroke();
      } else if (f.kind === 'lost') {
        g.strokeStyle = `rgba(200,210,220,${1 - p})`; g.lineWidth = 2 * u;
        g.beginPath(); g.arc(x, y, (6 + 30 * p) * u, 0, 7); g.stroke();
      }
    }

    // HUD
    const m = sim.metrics();
    const hud = `t ${now.toFixed(1)}s   coordinator ${m.coordinators.join(' + ') || 'none'}   ` +
      `L3 ${m.layers[3]} · L2 ${m.layers[2]} · L1 ${m.layers[1]}`;
    g.font = `${11 * u}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    g.textAlign = 'left';
    g.fillStyle = 'rgba(10,15,21,0.75)';
    g.fillRect(6 * u, 6 * u, g.measureText(hud).width + 12 * u, 20 * u);
    g.fillStyle = COLORS.text;
    g.fillText(hud, 12 * u, 20 * u);
  }

  label(g, text, x, y, color, u, align = 'left') {
    g.font = `${10 * u}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    g.textAlign = align;
    g.fillStyle = color;
    g.fillText(text, x, y);
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}
