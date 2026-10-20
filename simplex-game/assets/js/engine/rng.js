// Random numbers that match numpy exactly: SeedSequence + PCG64 (numpy.random.default_rng), and the
// SHA-256 position hash the project uses to seed its referee (fast_mintri.seed_from_points).
// Matching numpy bit for bit means the in-browser referee makes the same choices as the Python one.

// ------------------------------------------------------------------ SHA-256
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

export function sha256(bytes) {
  const len = bytes.length;
  const nBlocks = Math.ceil((len + 9) / 64);
  const buf = new Uint8Array(nBlocks * 64);
  buf.set(bytes);
  buf[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 4, bitLen >>> 0, false);
  dv.setUint32(buf.length - 8, Math.floor(bitLen / 4294967296), false);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let b = 0; b < nBlocks; b++) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(b * 64 + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

const textEnc = new TextEncoder();

/** fast_mintri.seed_from_points: sha256(float64 bytes of X (row-major) + salt), first 8 bytes little-endian. */
export function seedFromPoints(X, salt = "") {
  const k = X.length;
  const f = new Float64Array(k * 3);
  for (let i = 0; i < k; i++) { f[3 * i] = X[i][0]; f[3 * i + 1] = X[i][1]; f[3 * i + 2] = X[i][2]; }
  const sb = textEnc.encode(salt);
  const bytes = new Uint8Array(f.byteLength + sb.length);
  bytes.set(new Uint8Array(f.buffer), 0);
  bytes.set(sb, f.byteLength);
  const h = sha256(bytes);
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(h[i]);
  return v;
}

// ------------------------------------------------------------------ SeedSequence (numpy)
const INIT_A = 0x43b0d7e5, MULT_A = 0x931e8875, INIT_B = 0x8b51f9dd, MULT_B = 0x58f38ded;
const MIX_MULT_L = 0xca01f9dd, MIX_MULT_R = 0x4973f715;

function intToWords(n) {
  n = BigInt(n);
  if (n < 0n) throw new Error("negative seed");
  if (n === 0n) return [0];
  const out = [];
  while (n > 0n) { out.push(Number(n & 0xffffffffn)); n >>= 32n; }
  return out;
}

function hashmix(value, hc) {
  value = (value ^ hc[0]) >>> 0;
  hc[0] = Math.imul(hc[0], MULT_A) >>> 0;
  value = Math.imul(value, hc[0]) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return value;
}

function mix(x, y) {
  let r = (Math.imul(MIX_MULT_L, x) - Math.imul(MIX_MULT_R, y)) >>> 0;
  r = (r ^ (r >>> 16)) >>> 0;
  return r;
}

/** numpy.random.SeedSequence(entropy).generate_state(nWords64, uint64) -> array of BigInt. entropy: int or int[] */
export function seedSequenceState(entropy, nWords64) {
  const words = Array.isArray(entropy) ? entropy.flatMap(intToWords) : intToWords(entropy);
  const pool = new Uint32Array(4);
  const hc = [INIT_A];
  for (let i = 0; i < 4; i++) pool[i] = hashmix(i < words.length ? words[i] : 0, hc);
  for (let s = 0; s < 4; s++) for (let d = 0; d < 4; d++) if (s !== d) pool[d] = mix(pool[d], hashmix(pool[s], hc));
  for (let s = 4; s < words.length; s++) for (let d = 0; d < 4; d++) pool[d] = mix(pool[d], hashmix(words[s], hc));
  let h = INIT_B;
  const st = new Uint32Array(nWords64 * 2);
  for (let i = 0; i < st.length; i++) {
    let v = pool[i % 4];
    v = (v ^ h) >>> 0;
    h = Math.imul(h, MULT_B) >>> 0;
    v = Math.imul(v, h) >>> 0;
    v = (v ^ (v >>> 16)) >>> 0;
    st[i] = v;
  }
  const out = [];
  for (let k = 0; k < nWords64; k++) out.push((BigInt(st[2 * k + 1]) << 32n) | BigInt(st[2 * k]));
  return out;
}

// ------------------------------------------------------------------ PCG64 (numpy), 16-bit limbs for speed
const MASK128 = (1n << 128n) - 1n;
const MULT128 = 0x2360ED051FC65DA44385DF649FCCF645n;

function toLimbs(x, arr) { for (let i = 0; i < 8; i++) { arr[i] = Number(x & 0xffffn); x >>= 16n; } }
function fromLimbs(arr) { let x = 0n; for (let i = 7; i >= 0; i--) x = (x << 16n) | BigInt(arr[i]); return x; }

export class PCG64 {
  /** seed: int / BigInt / int[] (SeedSequence entropy), as numpy.random.default_rng(seed). */
  constructor(seed) {
    const v = seedSequenceState(seed, 4);
    const initstate = ((v[0] << 64n) | v[1]) & MASK128;
    const initseq = ((v[2] << 64n) | v[3]) & MASK128;
    const inc = ((initseq << 1n) | 1n) & MASK128;
    let state = 0n;
    state = (state * MULT128 + inc) & MASK128;
    state = (state + initstate) & MASK128;
    state = (state * MULT128 + inc) & MASK128;
    this.s = new Float64Array(8);
    this.inc = new Float64Array(8);
    this.m = new Float64Array(8);
    toLimbs(state, this.s);
    toLimbs(inc, this.inc);
    toLimbs(MULT128, this.m);
    this.t = new Float64Array(8);
  }

  _step() {
    const a = this.s, m = this.m, inc = this.inc, r = this.t;
    let carry = 0;
    for (let k = 0; k < 8; k++) {
      let acc = carry + inc[k];
      for (let i = 0; i <= k; i++) acc += a[i] * m[k - i];
      const lo = acc % 65536;
      r[k] = lo;
      carry = (acc - lo) / 65536;
    }
    for (let k = 0; k < 8; k++) a[k] = r[k];
  }

  /** next uint64 as two uint32 [hi, lo] */
  _next64() {
    this._step();
    const l = this.s;
    const xh = ((((l[7] << 16) | l[6]) ^ ((l[3] << 16) | l[2])) >>> 0);
    const xl = ((((l[5] << 16) | l[4]) ^ ((l[1] << 16) | l[0])) >>> 0);
    const rot = l[7] >>> 10;
    let nh, nl;
    if (rot === 0) { nh = xh; nl = xl; }
    else if (rot < 32) { nh = ((xh >>> rot) | (xl << (32 - rot))) >>> 0; nl = ((xl >>> rot) | (xh << (32 - rot))) >>> 0; }
    else if (rot === 32) { nh = xl; nl = xh; }
    else { const s = rot - 32; nh = ((xl >>> s) | (xh << (32 - s))) >>> 0; nl = ((xh >>> s) | (xl << (32 - s))) >>> 0; }
    this._hi = nh; this._lo = nl;
  }

  /** Generator.random(): (next_uint64 >> 11) * 2^-53 */
  random() {
    this._next64();
    return (this._hi * 2097152 + (this._lo >>> 11)) * 1.1102230246251565e-16;
  }

  /** Generator.random(n) into a Float64Array */
  randomArray(n) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.random();
    return out;
  }

  /** Generator.uniform(lo, hi) */
  uniform(lo, hi) { return lo + (hi - lo) * this.random(); }

  /** Standard normal (Box-Muller; NOT numpy's ziggurat: only used where exact numpy parity is not needed). */
  normal() {
    if (this._spare !== undefined) { const v = this._spare; this._spare = undefined; return v; }
    let u = 0, v = 0;
    while (u <= 1e-300) u = this.random();
    v = this.random();
    const rad = Math.sqrt(-2 * Math.log(u));
    this._spare = rad * Math.sin(2 * Math.PI * v);
    return rad * Math.cos(2 * Math.PI * v);
  }

  /** integer in [0, n) (not numpy-identical) */
  intBelow(n) { return Math.min(n - 1, Math.floor(this.random() * n)); }

  getState() { return fromLimbs(this.s); }
}
