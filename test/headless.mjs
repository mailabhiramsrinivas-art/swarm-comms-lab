// Run each preset headless and print a summary. Usage: node test/headless.mjs [seconds]
import { defaultConfig, PRESETS } from '../js/config.js';
import { Sim } from '../js/sim.js';

const secs = Number(process.argv[2] || 40);
const dt = 1 / 60;
for (const key of Object.keys(PRESETS)) {
  const cfg = defaultConfig();
  PRESETS[key].apply(cfg);
  const sim = new Sim(cfg, key);
  const layerTime = { 3: 0, 2: 0, 1: 0 };
  const t0 = performance.now();
  for (let i = 0; i < secs / dt; i++) {
    sim.step(dt);
    const m = sim.drones.filter((d) => d.alive);
    for (const d of m) layerTime[d.layer] += dt / m.length;
  }
  const ms = performance.now() - t0;
  const m = sim.metrics();
  console.log(`\n== ${key} (${secs}s sim in ${ms.toFixed(0)}ms)`);
  console.log(`intercepted ${m.intercepted}  breaches ${m.breaches}  active ${m.active}  avgResp ${m.avgResponse?.toFixed(2)}s  yields ${m.yields}  elections ${m.elections}`);
  console.log(`layer share: L3 ${(100*layerTime[3]/secs).toFixed(0)}%  L2 ${(100*layerTime[2]/secs).toFixed(0)}%  L1 ${(100*layerTime[1]/secs).toFixed(0)}%   coords now: ${m.coordinators.join(',')}`);
  console.log(`msgs/s ${m.msgRate.toFixed(0)}  bytes/s ${m.byteRate.toFixed(0)}  partitions ${m.partitions}`);
  const interesting = sim.logs.filter((l) => ['coord', 'lost', 'net', 'claim'].includes(l.type)).slice(0, 12);
  for (const l of interesting) console.log(`  t=${l.t.toFixed(1)} [${l.type}] ${l.text}`);
}
