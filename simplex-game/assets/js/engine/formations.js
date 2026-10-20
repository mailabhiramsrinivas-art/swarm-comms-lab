// O formation generator (a port of sim/formations.py with this engine's RNG: same families and rules,
// different random draws). Families: ball, clusters, shell, layers, filament, lattice.

import { PCG64 } from "./rng.js";
import { orient3dValue } from "./exact.js";
import { dist } from "./geom.js";

export const FAMILIES = ["ball", "clusters", "shell", "layers", "filament", "lattice"];

function normal3(rng) { return [rng.normal(), rng.normal(), rng.normal()]; }
const norm = (v) => Math.hypot(v[0], v[1], v[2]);

function raw(family, m, rng) {
  if (family === "ball") return Array.from({ length: m }, () => { const v = normal3(rng); const n = norm(v); const s = Math.cbrt(rng.random()); return v.map((x) => (x / n) * s); });
  if (family === "clusters") {
    const k = 1 + rng.intBelow(4);
    const centres = Array.from({ length: k }, () => normal3(rng).map((x) => x * 3));
    return Array.from({ length: m }, (_, i) => { const c = centres[i < k ? i : rng.intBelow(k)]; return normal3(rng).map((x, q) => c[q] + x * 0.6); });
  }
  if (family === "shell") {
    const thick = 0.1 + 0.25 * rng.random();
    return Array.from({ length: m }, () => { const v = normal3(rng); const n = norm(v); const s = 1 + thick * (2 * rng.random() - 1); return v.map((x) => (x / n) * s); });
  }
  if (family === "layers") {
    const k = 2 + rng.intBelow(2);
    const gap = 0.6 + 0.6 * rng.random();
    const span = Math.sqrt(m / k) * 0.5;
    return Array.from({ length: m }, (_, i) => { const lab = i < k ? i : rng.intBelow(k); return [(2 * rng.random() - 1) * span, (2 * rng.random() - 1) * span, lab * gap + rng.normal() * 0.05]; });
  }
  if (family === "filament") {
    const t = Array.from({ length: m }, () => rng.random()).sort((a, b) => a - b);
    const amp = [1.0, 0.6, 0.3];
    const coef = [0, 1, 2].map((j) => [0, 1, 2].map(() => rng.normal() * amp[j]));
    const phase = [0, 1, 2].map(() => [0, 1, 2].map(() => rng.random() * 2 * Math.PI));
    const drift = normal3(rng);
    return t.map((tt) => [0, 1, 2].map((d) => {
      let v = 0; for (let j = 0; j < 3; j++) v += coef[j][d] * Math.sin((j + 1) * Math.PI * tt + phase[j][d]);
      return (v + tt * drift[d] * 2.0) * Math.sqrt(m) + rng.normal() * 0.15;
    }));
  }
  if (family === "lattice") {
    let side = Math.max(2, Math.ceil(Math.cbrt(m / (0.35 + 0.35 * rng.random()))));
    while (side ** 3 < m) side++;
    const grid = [];
    for (let a = 0; a < side; a++) for (let b = 0; b < side; b++) for (let c = 0; c < side; c++) grid.push([a, b, c]);
    for (let i = grid.length - 1; i > 0; i--) { const j = rng.intBelow(i + 1); [grid[i], grid[j]] = [grid[j], grid[i]]; }
    return grid.slice(0, m).map((p) => p.map((x) => x + rng.normal() * 0.1));
  }
  throw new Error("unknown family " + family);
}

export function meanNN(X) {
  let s = 0;
  for (let i = 0; i < X.length; i++) { let b = Infinity; for (let j = 0; j < X.length; j++) if (j !== i) b = Math.min(b, dist(X[i], X[j])); s += b; }
  return s / X.length;
}

function randomRotation(rng) {
  // uniform random unit quaternion (Shoemake)
  const u1 = rng.random(), u2 = rng.random(), u3 = rng.random();
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  const q = [a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3)];
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

const centre = (X) => { const c = [0, 0, 0]; for (const p of X) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return X.map((p) => [p[0] - c[0] / X.length, p[1] - c[1] / X.length, p[2] - c[2] / X.length]); };

export function wellConditioned(X) {
  const m = X.length;
  const mnn = meanNN(X);
  let dmin = Infinity, diam = 0;
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) { const d = dist(X[i], X[j]); dmin = Math.min(dmin, d); diam = Math.max(diam, d); }
  if (dmin < 0.05 * mnn) return false;
  for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) for (let c = b + 1; c < m; c++) for (let d = c + 1; d < m; d++)
    if (Math.abs(orient3dValue(X[a], X[b], X[c], X[d])) < 1e-6 * diam ** 3) return false;
  return true;
}

/** A random formation: family, m, spacing (mean nearest-neighbour distance in units of r), seed. */
export function generate(m, family = "ball", spacing = 0.85, seed = 1) {
  const rng = new PCG64([7, m, seed, FAMILIES.indexOf(family) + 1]);
  for (let tries = 0; tries < 300; tries++) {
    let X = centre(raw(family, m, rng));
    const s = spacing / meanNN(X);
    X = X.map((p) => p.map((x) => x * s));
    const R = randomRotation(rng);
    X = X.map((p) => [0, 1, 2].map((i) => R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2]));
    X = X.map((p) => p.map((x) => x + rng.normal() * 0.01 * spacing));
    X = centre(X);
    if (wellConditioned(X)) return X;
  }
  throw new Error(`could not generate a well-conditioned ${family} formation with m=${m}`);
}

/** Rescale a formation so its mean nearest-neighbour distance equals `spacing`, centred. */
export function rescale(X, spacing) {
  const C = centre(X);
  const s = spacing / meanNN(C);
  return C.map((p) => p.map((x) => x * s));
}
