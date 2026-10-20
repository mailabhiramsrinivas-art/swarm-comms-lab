// Robust geometric predicates: a float evaluation with a forward error bound, and an exact BigInt
// fallback when the float result cannot be trusted (same scheme as geometry/predicates.py).

const EPS = 2.220446049250313e-16;
const ORIENT_BOUND = 16 * EPS;
const INSPHERE_BOUND = 64 * EPS;

const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer);

/** x = mant * 2^exp exactly (mant a BigInt). */
function decompose(x) {
  if (x === 0) return [0n, 0];
  _f64[0] = x;
  const lo = _u32[0], hi = _u32[1];
  const sign = hi >>> 31 ? -1n : 1n;
  const bexp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (bexp === 0) e = -1074; else { mant |= 1n << 52n; e = bexp - 1075; }
  return [sign * mant, e];
}

/** Convert doubles to BigInts sharing one power-of-two scale. */
function scaled(values) {
  const parts = values.map(decompose);
  let emin = Infinity;
  for (const [m, e] of parts) if (m !== 0n && e < emin) emin = e;
  if (!isFinite(emin)) emin = 0;
  return parts.map(([m, e]) => (m === 0n ? 0n : m << BigInt(e - emin)));
}

const bsign = (v) => (v > 0n ? 1 : v < 0n ? -1 : 0);

function det3big(a, b, c, d, e, f, g, h, i) {
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/** Float value of det[b-a, c-a, d-a] as computed by orient3d_batch (einsum with np.cross). */
export function orient3dValue(a, b, c, d) {
  const u0 = b[0] - a[0], u1 = b[1] - a[1], u2 = b[2] - a[2];
  const v0 = c[0] - a[0], v1 = c[1] - a[1], v2 = c[2] - a[2];
  const w0 = d[0] - a[0], w1 = d[1] - a[1], w2 = d[2] - a[2];
  return u0 * (v1 * w2 - v2 * w1) + u1 * (v2 * w0 - v0 * w2) + u2 * (v0 * w1 - v1 * w0);
}

/** Exact sign of det[b-a, c-a, d-a]. */
export function orient3dSign(a, b, c, d) {
  const u0 = b[0] - a[0], u1 = b[1] - a[1], u2 = b[2] - a[2];
  const v0 = c[0] - a[0], v1 = c[1] - a[1], v2 = c[2] - a[2];
  const w0 = d[0] - a[0], w1 = d[1] - a[1], w2 = d[2] - a[2];
  const det = u0 * (v1 * w2 - v2 * w1) + u1 * (v2 * w0 - v0 * w2) + u2 * (v0 * w1 - v1 * w0);
  const perm = Math.abs(u0) * (Math.abs(v1 * w2) + Math.abs(v2 * w1))
    + Math.abs(u1) * (Math.abs(v0 * w2) + Math.abs(v2 * w0))
    + Math.abs(u2) * (Math.abs(v0 * w1) + Math.abs(v1 * w0));
  if (Math.abs(det) > ORIENT_BOUND * perm + 1e-300) return det > 0 ? 1 : -1;
  return orient3dExact(a, b, c, d);
}

export function orient3dExact(a, b, c, d) {
  const S = scaled([...a, ...b, ...c, ...d]);
  const [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz] = S;
  return bsign(det3big(bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az, dx - ax, dy - ay, dz - az));
}

/**
 * Sign s such that, for a tetrahedron with orient3dSign(a,b,c,d) = o != 0, point e lies strictly inside the
 * circumsphere iff s * o > 0 (s = 0: on the sphere).
 */
export function insphereSign(a, b, c, d, e) {
  const rows = [a, b, c, d].map((p) => {
    const q0 = p[0] - e[0], q1 = p[1] - e[1], q2 = p[2] - e[2];
    return [q0, q1, q2, q0 * q0 + q1 * q1 + q2 * q2];
  });
  const det = det4(rows);
  let bound = INSPHERE_BOUND * 24;
  for (const r of rows) bound *= Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]) + r[3];
  if (Math.abs(det) > bound) return det > 0 ? -1 : 1;   // python: insphere = -det
  return insphereExact(a, b, c, d, e);
}

function det4(M) {
  let total = 0;
  for (let j = 0; j < 4; j++) {
    const m = [];
    for (let i = 1; i < 4; i++) for (let k = 0; k < 4; k++) if (k !== j) m.push(M[i][k]);
    const d3 = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    total += (j % 2 ? -1 : 1) * M[0][j] * d3;
  }
  return total;
}

function insphereExact(a, b, c, d, e) {
  const S = scaled([...a, ...b, ...c, ...d, ...e]);
  const E = S.slice(12, 15);
  const R = [];
  for (let p = 0; p < 4; p++) {
    const q0 = S[3 * p] - E[0], q1 = S[3 * p + 1] - E[1], q2 = S[3 * p + 2] - E[2];
    R.push([q0, q1, q2, q0 * q0 + q1 * q1 + q2 * q2]);
  }
  let total = 0n;
  for (let j = 0; j < 4; j++) {
    const m = [];
    for (let i = 1; i < 4; i++) for (let k = 0; k < 4; k++) if (k !== j) m.push(R[i][k]);
    total += (j % 2 ? -1n : 1n) * R[0][j] * det3big(...m);
  }
  return -bsign(total);
}

/** 2D orientation sign of (b-a, c-a), exact. */
export function orient2dSign(a, b, c) {
  const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const perm = Math.abs((b[0] - a[0]) * (c[1] - a[1])) + Math.abs((b[1] - a[1]) * (c[0] - a[0]));
  if (Math.abs(det) > 8 * EPS * perm + 1e-300) return det > 0 ? 1 : -1;
  const [ax, ay, bx, by, cx, cy] = scaled([a[0], a[1], b[0], b[1], c[0], c[1]]);
  return bsign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

/** incircle: sign s such that for a triangle with orient2dSign(a,b,c) = o != 0, d is inside iff s * o > 0. */
export function incircleSign(a, b, c, d) {
  const r = [a, b, c].map((p) => { const x = p[0] - d[0], y = p[1] - d[1]; return [x, y, x * x + y * y]; });
  const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
    + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  let bound = 48 * EPS;
  for (const q of r) bound *= Math.abs(q[0]) + Math.abs(q[1]) + q[2];
  if (Math.abs(det) > bound) return det > 0 ? 1 : -1;
  const S = scaled([a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]]);
  const R = [];
  for (let p = 0; p < 3; p++) { const x = S[2 * p] - S[6], y = S[2 * p + 1] - S[7]; R.push([x, y, x * x + y * y]); }
  return bsign(det3big(R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]));
}
