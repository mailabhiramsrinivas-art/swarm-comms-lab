// Minimal dense-network runtime for the four trained networks (float32 weights, float64 arithmetic).

export class Weights {
  constructor(manifest, buffer) {
    this.manifest = manifest;
    this.f32 = new Float32Array(buffer);
  }
  get(model, key) {
    const e = this.manifest.models[model][key];
    if (!e) throw new Error(`missing weight ${model}.${key}`);
    const [off, shape] = e;
    const size = shape.reduce((a, b) => a * b, 1);
    return { data: this.f32.subarray(off, off + size), shape };
  }
}

/** A torch nn.Sequential MLP built by learn/common/nn.py:mlp (Linear at even indices, SiLU between). */
export class MLP {
  constructor(W, model, prefix, nLinear, lastAct = false) {
    this.layers = [];
    for (let i = 0; i < nLinear; i++) {
      const w = W.get(model, `${prefix}.${2 * i}.weight`), b = W.get(model, `${prefix}.${2 * i}.bias`);
      this.layers.push({ w: Float64Array.from(w.data), b: Float64Array.from(b.data), out: w.shape[0], inp: w.shape[1] });
    }
    this.lastAct = lastAct;
    this.inDim = this.layers[0].inp;
    this.outDim = this.layers[this.layers.length - 1].out;
  }
  /** X: Float64Array (rows x inDim) -> Float64Array (rows x outDim) */
  forward(X, rows) { return this.forwardFrom(X, rows, 0); }
  /** run layers start.. on X (the output of layer start-1, activation applied) */
  forwardFrom(X, rows, start) {
    let cur = X;
    const L = this.layers.length;
    for (let li = start; li < L; li++) {
      const { w, b, out, inp } = this.layers[li];
      const Y = linearKernel(cur, rows, inp, w, b, out);
      if (li < L - 1 || this.lastAct) for (let i = 0; i < Y.length; i++) { const v = Y[i]; Y[i] = v / (1 + Math.exp(-v)); }
      cur = Y;
    }
    return cur;
  }
}

/** Y = X W^T + b, register-blocked over 4 outputs (X rows x inp, W out x inp). */
export function linearKernel(X, rows, inp, w, b, out) {
  const Y = new Float64Array(rows * out);
  const o4 = out - (out % 4);
  for (let r = 0; r < rows; r++) {
    const xo = r * inp, yo = r * out;
    let o = 0;
    for (; o < o4; o += 4) {
      const w0 = o * inp, w1 = w0 + inp, w2 = w1 + inp, w3 = w2 + inp;
      let s0 = b[o], s1 = b[o + 1], s2 = b[o + 2], s3 = b[o + 3];
      for (let k = 0; k < inp; k++) {
        const xv = X[xo + k];
        s0 += xv * w[w0 + k]; s1 += xv * w[w1 + k]; s2 += xv * w[w2 + k]; s3 += xv * w[w3 + k];
      }
      Y[yo + o] = s0; Y[yo + o + 1] = s1; Y[yo + o + 2] = s2; Y[yo + o + 3] = s3;
    }
    for (; o < out; o++) {
      let s = b[o];
      const wo = o * inp;
      for (let k = 0; k < inp; k++) s += X[xo + k] * w[wo + k];
      Y[yo + o] = s;
    }
  }
  return Y;
}

/** X (rows x inp) @ W[:, c0:c0+inp]^T for a weight matrix W (out x full) -> rows x out (no bias) */
export function projCols(X, rows, inp, w, out, full, c0) {
  const Y = new Float64Array(rows * out);
  const o4 = out - (out % 4);
  for (let r = 0; r < rows; r++) {
    const xo = r * inp, yo = r * out;
    let o = 0;
    for (; o < o4; o += 4) {
      const w0 = o * full + c0, w1 = w0 + full, w2 = w1 + full, w3 = w2 + full;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = 0; k < inp; k++) {
        const xv = X[xo + k];
        s0 += xv * w[w0 + k]; s1 += xv * w[w1 + k]; s2 += xv * w[w2 + k]; s3 += xv * w[w3 + k];
      }
      Y[yo + o] = s0; Y[yo + o + 1] = s1; Y[yo + o + 2] = s2; Y[yo + o + 3] = s3;
    }
    for (; o < out; o++) {
      let s = 0;
      const wo = o * full + c0;
      for (let k = 0; k < inp; k++) s += X[xo + k] * w[wo + k];
      Y[yo + o] = s;
    }
  }
  return Y;
}

/**
 * Edge messages of an MLP whose input is [h[dst], h[src], d2, ef] (EGNN-style), computed without forming the
 * concatenated input: the first layer is split into per-node projections. Returns the MLP output (E x out).
 */
export function edgeMessages(mlp, h, H, N, src, dst, d2, ef, edim, E) {
  const L0 = mlp.layers[0];
  const full = L0.inp, out0 = L0.out, w = L0.w, b = L0.b;
  const A = projCols(h, N, H, w, out0, full, 0);
  const B = projCols(h, N, H, w, out0, full, H);
  const pre = new Float64Array(E * out0);
  for (let e = 0; e < E; e++) {
    const ao = dst[e] * out0, bo = src[e] * out0, po = e * out0, eo = e * edim, dv = d2[e];
    for (let o = 0; o < out0; o++) {
      const wo = o * full + 2 * H;
      let s = b[o] + A[ao + o] + B[bo + o] + w[wo] * dv;
      for (let k = 0; k < edim; k++) s += w[wo + 1 + k] * ef[eo + k];
      pre[po + o] = s / (1 + Math.exp(-s));
    }
  }
  return mlp.forwardFrom(pre, E, 1);
}

/** rows of A (n x d) selected by idx -> Float64Array (idx.length x d) */
export function gather(A, d, idx) {
  const out = new Float64Array(idx.length * d);
  for (let i = 0; i < idx.length; i++) out.set(A.subarray(idx[i] * d, idx[i] * d + d), i * d);
  return out;
}

/** concatenate column blocks: parts = [[array, width], ...], all with `rows` rows */
export function concatCols(parts, rows) {
  const W = parts.reduce((s, p) => s + p[1], 0);
  const out = new Float64Array(rows * W);
  for (let r = 0; r < rows; r++) {
    let o = r * W;
    for (const [a, w] of parts) { for (let k = 0; k < w; k++) out[o + k] = a[r * w + k]; o += w; }
  }
  return out;
}

export function scatterSum(src, d, index, n) {
  const out = new Float64Array(n * d);
  for (let i = 0; i < index.length; i++) { const o = index[i] * d, s = i * d; for (let k = 0; k < d; k++) out[o + k] += src[s + k]; }
  return out;
}

export function scatterMean(src, d, index, n) {
  const out = scatterSum(src, d, index, n);
  const cnt = new Float64Array(n);
  for (const i of index) cnt[i]++;
  for (let i = 0; i < n; i++) { const c = Math.max(cnt[i], 1); for (let k = 0; k < d; k++) out[i * d + k] /= c; }
  return out;
}

export function addInPlace(A, B) { for (let i = 0; i < A.length; i++) A[i] += B[i]; return A; }

export const softplus = (x) => (x > 20 ? x : Math.log1p(Math.exp(x)));
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
