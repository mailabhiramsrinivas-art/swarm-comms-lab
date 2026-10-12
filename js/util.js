// Small math helpers and a seeded RNG so runs are reproducible.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng) {
  const u = Math.max(rng(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export const hypot = Math.hypot;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Steer velocity (vx, vy) toward a desired velocity, limited by max acceleration.
export function steer(body, dvx, dvy, accel, maxSpeed, dt) {
  let ax = dvx - body.vx, ay = dvy - body.vy;
  const a = Math.hypot(ax, ay), maxA = accel * dt;
  if (a > maxA) { ax *= maxA / a; ay *= maxA / a; }
  body.vx += ax; body.vy += ay;
  const s = Math.hypot(body.vx, body.vy);
  if (s > maxSpeed) { body.vx *= maxSpeed / s; body.vy *= maxSpeed / s; }
  body.x += body.vx * dt; body.y += body.vy * dt;
}

// Time for a pursuer at (px,py) with speed s to reach a target moving at constant
// velocity. Returns Infinity if it can never catch up.
export function interceptTime(px, py, s, tx, ty, tvx, tvy) {
  const rx = tx - px, ry = ty - py;
  const a = tvx * tvx + tvy * tvy - s * s;
  const b = 2 * (rx * tvx + ry * tvy);
  const c = rx * rx + ry * ry;
  if (Math.abs(a) < 1e-6) return b < 0 ? -c / b : Infinity;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  const t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  return t > 0 ? t : Infinity;
}
