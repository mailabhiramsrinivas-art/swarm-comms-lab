// Run each preset over several seeds; report mean response time and breach share.
// Reproduces the Results chapter of presentation/index.html. Usage, from the repository root: node presentation/tools/bench.mjs
const root = new URL("../..", import.meta.url).href.replace(/\/$/, "");
const { defaultConfig, PRESETS } = await import(root + '/js/config.js');
const { Sim } = await import(root + '/js/sim.js');
const secs = 120, dt = 1 / 60, seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
for (const key of Object.keys(PRESETS)) {
  let inter = 0, breach = 0, respSum = 0, respN = 0, L = { 3: 0, 2: 0, 1: 0 }, msg = 0, bytes = 0;
  for (const seed of seeds) {
    const cfg = defaultConfig(); cfg.seed = seed; PRESETS[key].apply(cfg);
    const sim = new Sim(cfg, key);
    for (let i = 0; i < secs / dt; i++) {
      sim.step(dt);
      const m = sim.drones.filter((d) => d.alive);
      for (const d of m) L[d.layer] += dt / m.length;
    }
    const m = sim.metrics();
    inter += m.intercepted; breach += m.breaches;
    respSum += sim.stats.responseSum; respN += sim.stats.responseN;
    msg += m.msgRate; bytes += m.byteRate;
  }
  const T = secs * seeds.length;
  console.log(`${key.padEnd(10)} intercepted ${inter}  breaches ${breach}  breachShare ${(100 * breach / (inter + breach)).toFixed(1)}%  avgResp ${(respSum / respN).toFixed(2)}s  L3 ${(100 * L[3] / T).toFixed(0)}% L2 ${(100 * L[2] / T).toFixed(0)}% L1 ${(100 * L[1] / T).toFixed(0)}%  msgs/s ${(msg / seeds.length).toFixed(0)}  bytes/s ${(bytes / seeds.length).toFixed(0)}`);
}
