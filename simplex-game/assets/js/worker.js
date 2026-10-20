// Runs the learned D off the main thread: studies, team-size scans and live shielding previews.
import { buildNets, Referee, CONFIG_DEFAULT } from "./engine/engine.js";
import { study, scanN, REFEREE_PRESETS } from "./engine/study.js";
import { generate } from "./engine/formations.js";

let nets = null;
const ready = (async () => {
  const base = new URL("../models/", import.meta.url);
  const [man, buf] = await Promise.all([
    fetch(new URL("weights.json", base)).then((r) => r.json()),
    fetch(new URL("weights.bin", base)).then((r) => r.arrayBuffer()),
  ]);
  nets = buildNets(man, buf);
  postMessage({ type: "ready" });
})().catch((e) => postMessage({ type: "error", id: null, message: "Could not load the trained networks: " + e.message }));

onmessage = async (ev) => {
  const { id, type, payload } = ev.data;
  try {
    await ready;
    if (type === "study") {
      const rec = study(nets, payload.O, { ...payload.opts, onProgress: (stage, detail) => postMessage({ type: "progress", id, stage, detail }) });
      postMessage({ type: "result", id, rec });
    } else if (type === "scan") {
      const res = scanN(nets, payload.O, { ...payload.opts, onProgress: (stage, detail) => postMessage({ type: "progress", id, stage, detail }) });
      postMessage({ type: "result", id, rec: res });
    } else if (type === "preview") {
      const cfg = { ...CONFIG_DEFAULT, ...(payload.cfg || {}) };
      const rd = new Referee(cfg, REFEREE_PRESETS.quick).read(payload.O, null);
      postMessage({ type: "result", id, rec: { exposed: rd.exposed_ids, shielded: rd.shielded_ids, tets: rd.tets, edges: rd.edges, dim: rd.dim, T: rd.T } });
    } else if (type === "generate") {
      postMessage({ type: "result", id, rec: generate(payload.m, payload.family, payload.spacing, payload.seed) });
    }
  } catch (e) {
    postMessage({ type: "error", id, message: e.message || String(e) });
  }
};
