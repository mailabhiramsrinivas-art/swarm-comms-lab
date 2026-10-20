// Small SVG charts with hover tooltips (no library).
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const fmtPct = (v) => `${Math.round(v * 100)}%`;

let tipEl = null;
function tip(html, x, y) {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tip"; tipEl.setAttribute("role", "status"); document.body.appendChild(tipEl); }
  if (html === null) { tipEl.classList.remove("on"); return; }
  tipEl.innerHTML = html;
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${y}px`;
  tipEl.classList.add("on");
}

function frame(host, title, sub, W = 560, H = 250) {
  host.innerHTML = "";
  if (title) {
    const cap = document.createElement("figcaption");
    cap.textContent = title;
    if (sub) { const s = document.createElement("span"); s.className = "sub"; s.textContent = sub; cap.appendChild(s); }
    host.appendChild(cap);
  }
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  if (title) el("title", {}, svg).textContent = title;
  host.appendChild(svg);
  return svg;
}

function widthOf(host) { return Math.max(280, Math.round(host.clientWidth || host.parentElement?.clientWidth || 560)); }

/** redraw a chart when its container changes width */
const observed = new WeakMap();
function keepResponsive(host, draw) {
  let o = observed.get(host);
  if (!o) {
    o = { draw, w: host.clientWidth };
    observed.set(host, o);
    if ("ResizeObserver" in window) new ResizeObserver(() => { const w = host.clientWidth; if (Math.abs(w - o.w) > 24) { o.w = w; o.draw(); } }).observe(host);
  }
  o.draw = draw; o.w = host.clientWidth;
}

function linearScale(d0, d1, r0, r1) { const f = (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0); f.inv = (p) => d0 + ((p - r0) / (r1 - r0)) * (d1 - d0); return f; }

function addTable(host, head, rows) {
  const d = document.createElement("details");
  d.className = "table-toggle";
  const s = document.createElement("summary"); s.textContent = "Show as a table"; d.appendChild(s);
  const t = document.createElement("table"); t.className = "data";
  t.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
  d.appendChild(t);
  host.appendChild(d);
}

/** P(win | n) bars: n = 1..m, threshold line, chosen n highlighted, optional planner n*. */
function pwinChart_(host, { probs, lowerBound, threshold, chosen, m, nStar = null, title = "D's estimate of its chance to win, by team size", compact = false }) {
  const N = Math.min(m, probs.length);
  const W = widthOf(host), H = (compact ? 200 : 240) + (nStar ? 14 : 0), L = 42, R = 12, T = 18, B = nStar ? 54 : 40;
  const svg = frame(host, title, `It takes the smallest team at or above ${fmtPct(threshold)} that can reach everyone in time (at least ${lowerBound}).`, W, H);
  const x = (n) => L + ((n - 0.5) / N) * (W - L - R);
  const bw = Math.max(4, ((W - L - R) / N) * 0.62);
  const y = linearScale(0, 1, H - B, T);
  const g = el("g", { class: "grid" }, svg);
  for (const v of [0, 0.25, 0.5, 0.75, 1]) { el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) }, g); el("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end", class: "lbl" }, svg).textContent = fmtPct(v); }
  const ax = el("g", { class: "axis" }, svg);
  for (let n = 1; n <= N; n++) if (N <= 12 || n % 2 === 1 || n === N) el("text", { x: x(n), y: H - B + 16, "text-anchor": "middle" }, ax).textContent = n;
  el("text", { x: (L + W - R) / 2, y: H - 4, "text-anchor": "middle", class: "lbl" }, svg).textContent = "D players";
  for (let n = 1; n <= N; n++) {
    const p = probs[n - 1];
    const isChosen = n === chosen;
    const tooFew = n < lowerBound;
    const col = isChosen ? "var(--s-learned)" : "var(--s-learned)";
    const h = Math.max(1, y(0) - y(p));
    const top = y(p);
    // rounded data end, square at the baseline
    const r4 = Math.min(4, bw / 2, h);
    const d = `M${x(n) - bw / 2},${y(0)} V${top + r4} Q${x(n) - bw / 2},${top} ${x(n) - bw / 2 + r4},${top} H${x(n) + bw / 2 - r4} Q${x(n) + bw / 2},${top} ${x(n) + bw / 2},${top + r4} V${y(0)} Z`;
    el("path", { d, fill: col, "fill-opacity": isChosen ? 1 : tooFew ? 0.14 : 0.38 }, svg);
    const hit = el("rect", { x: x(n) - (W - L - R) / N / 2, y: T, width: (W - L - R) / N, height: H - B - T, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (e) => tip(`${n} player${n > 1 ? "s" : ""}: ${fmtPct(p)}${tooFew ? " (too few to reach everyone in time)" : ""}${isChosen ? " &nbsp;chosen" : ""}`, e.clientX, e.clientY));
    hit.addEventListener("pointerleave", () => tip(null));
  }
  el("line", { x1: L, x2: W - R, y1: y(threshold), y2: y(threshold), class: "ref" }, svg);
  el("text", { x: L + 6, y: y(threshold) - 6, "text-anchor": "start", class: "reftext" }, svg).textContent = `${fmtPct(threshold)} target`;
  if (chosen) el("text", { x: x(chosen), y: y(probs[chosen - 1]) - 8, "text-anchor": "middle", class: "dlabel" }, svg).textContent = `${chosen} chosen`;
  if (nStar && nStar <= N) {
    el("path", { d: `M${x(nStar)},${H - B + 21} l-5,8 h10 z`, fill: "var(--ink-2)" }, svg);
    el("text", { x: x(nStar) + 9, y: H - B + 29, class: "lbl" }, svg).textContent = "planner's size";
  }
  addTable(host, ["team size", "P(win)"], probs.slice(0, N).map((p, i) => [i + 1, fmtPct(p)]));
}

/** Line chart with a crosshair tooltip. series: [{name, color, values (aligned with xs), dash}] */
function lineChart_(host, { title, sub, xs, series, xLabel, yLabel = "", yMin = 0, yMax = 1, yFmt = fmtPct, xFmt = (v) => v, band = null, refX = null, H: Hh = 250 }) {
  const W = widthOf(host), H = Hh, L = 46, R = 70, T = 16, B = 42;
  const svg = frame(host, title, sub, W, H);
  // evenly spaced categories: sweep values are uneven, and the m axis is a sequence of integers anyway
  const step0 = (W - R - L) / Math.max(xs.length - 1, 1);
  const x = (v) => { const i = xs.indexOf(v); return L + (i < 0 ? 0 : i) * step0; };
  const y = linearScale(yMin, yMax, H - B, T);
  if (band) {
    const inside = xs.map((v, i) => [v, i]).filter(([v]) => v >= band[0] - 1e-9 && v <= band[1] + 1e-9).map(([, i]) => i);
    if (inside.length) {
      const x0 = Math.max(L, L + (inside[0] - 0.5) * step0), x1 = Math.min(W - R, L + (inside[inside.length - 1] + 0.5) * step0);
      el("rect", { x: x0, y: T, width: Math.max(2, x1 - x0), height: H - B - T, class: "band-rect" }, svg);
      el("text", { x: (x0 + x1) / 2, y: T + 12, "text-anchor": "middle", class: "reftext" }, svg).textContent = "trained range";
    }
  }
  const g = el("g", { class: "grid" }, svg);
  const yt = 5;
  for (let i = 0; i < yt; i++) { const v = yMin + ((yMax - yMin) * i) / (yt - 1); el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) }, g); el("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end", class: "lbl" }, svg).textContent = yFmt(v); }
  const ax = el("g", { class: "axis" }, svg);
  const step = xs.length > 12 && W < 700 ? 2 : 1;
  xs.forEach((v, i) => { if (i % step === 0 || i === xs.length - 1) el("text", { x: x(v), y: H - B + 16, "text-anchor": "middle" }, ax).textContent = xFmt(v); });
  if (xLabel) el("text", { x: (L + W - R) / 2, y: H - 4, "text-anchor": "middle", class: "lbl" }, svg).textContent = xLabel;
  if (refX !== null && xs.includes(refX)) { el("line", { x1: x(refX), x2: x(refX), y1: T, y2: H - B, class: "ref" }, svg); el("text", { x: x(refX) + 4, y: T + 10, class: "reftext" }, svg).textContent = "trained"; }
  for (const s of series) {
    const pts = xs.map((v, i) => [x(v), s.values[i] === null ? null : y(s.values[i])]).filter((p) => p[1] !== null);
    el("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(""), fill: "none", stroke: s.color, "stroke-width": 2, "stroke-dasharray": s.dash || "none", "stroke-linejoin": "round" }, svg);
    for (const p of pts) el("circle", { cx: p[0], cy: p[1], r: 3.2, fill: s.color, stroke: "var(--wall)", "stroke-width": 1.5 }, svg);
    const lp = pts[pts.length - 1];
    if (lp) el("text", { x: lp[0] + 8, y: lp[1] + 4, class: "dlabel" }, svg).textContent = s.short || s.name;
  }
  // crosshair
  const cross = el("line", { y1: T, y2: H - B, stroke: "var(--ink-3)", "stroke-width": 1, visibility: "hidden" }, svg);
  const hit = el("rect", { x: L, y: T, width: W - R - L, height: H - B - T, fill: "transparent" }, svg);
  hit.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let bi = 0, bd = Infinity;
    xs.forEach((v, i) => { const d = Math.abs(x(v) - px); if (d < bd) { bd = d; bi = i; } });
    cross.setAttribute("x1", x(xs[bi])); cross.setAttribute("x2", x(xs[bi])); cross.setAttribute("visibility", "visible");
    tip(`<b>${xLabel ? xLabel + " " : ""}${xFmt(xs[bi])}</b><br>${series.map((s) => `${s.name}: ${s.values[bi] === null ? "n/a" : yFmt(s.values[bi])}`).join("<br>")}`, e.clientX, e.clientY);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip(null); });
  if (series.length > 1) {
    const lg = document.createElement("div"); lg.className = "chart-legend";
    lg.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("");
    host.appendChild(lg);
  }
  addTable(host, [xLabel || "x", ...series.map((s) => s.name)], xs.map((v, i) => [xFmt(v), ...series.map((s) => (s.values[i] === null ? "n/a" : yFmt(s.values[i])))]));
}

/** Simple bar chart (one series, signed values allowed). */
function barChart_(host, { title, sub, xs, values, color = "var(--s-learned)", xLabel, yFmt = (v) => v.toFixed(1), yMin, yMax, H: Hh = 230 }) {
  const W = widthOf(host), H = Hh, L = 46, R = 12, T = 16, B = 42;
  const svg = frame(host, title, sub, W, H);
  const lo = yMin ?? Math.min(0, ...values), hi = yMax ?? Math.max(...values) * 1.15;
  const y = linearScale(lo, hi, H - B, T);
  const bwSlot = (W - L - R) / xs.length;
  const bw = bwSlot * 0.6;
  const g = el("g", { class: "grid" }, svg);
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) { const v = lo + ((hi - lo) * i) / ticks; el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) }, g); el("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end", class: "lbl" }, svg).textContent = yFmt(v); }
  el("line", { x1: L, x2: W - R, y1: y(0), y2: y(0), stroke: "var(--ink-3)", "stroke-width": 1 }, svg);
  const ax = el("g", { class: "axis" }, svg);
  xs.forEach((v, i) => {
    const cx = L + bwSlot * (i + 0.5);
    if (xs.length <= 12 || i % 2 === 0 || i === xs.length - 1) el("text", { x: cx, y: H - B + 16, "text-anchor": "middle" }, ax).textContent = v;
    const val = values[i];
    const y0 = y(0), y1 = y(val);
    const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0));
    const r = Math.min(4, bw / 2, h);
    const d = val >= 0
      ? `M${cx - bw / 2},${y0} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${y0} Z`
      : `M${cx - bw / 2},${y0} V${top + h - r} Q${cx - bw / 2},${top + h} ${cx - bw / 2 + r},${top + h} H${cx + bw / 2 - r} Q${cx + bw / 2},${top + h} ${cx + bw / 2},${top + h - r} V${y0} Z`;
    el("path", { d, fill: color }, svg);
    const hit = el("rect", { x: cx - bwSlot / 2, y: T, width: bwSlot, height: H - B - T, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (e) => tip(`<b>${xLabel ? xLabel + " " : ""}${v}</b><br>${yFmt(val)}`, e.clientX, e.clientY));
    hit.addEventListener("pointerleave", () => tip(null));
  });
  if (xLabel) el("text", { x: (L + W - R) / 2, y: H - 4, "text-anchor": "middle", class: "lbl" }, svg).textContent = xLabel;
  addTable(host, [xLabel || "x", "value"], xs.map((v, i) => [v, yFmt(values[i])]));
}

export function pwinChart(host, args) { pwinChart_(host, args); keepResponsive(host, () => pwinChart_(host, args)); }
export function lineChart(host, args) { lineChart_(host, args); keepResponsive(host, () => lineChart_(host, args)); }
export function barChart(host, args) { barChart_(host, args); keepResponsive(host, () => barChart_(host, args)); }
