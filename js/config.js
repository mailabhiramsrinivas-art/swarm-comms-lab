// Default parameters for the simulation. Units: world units (~metres), seconds.
// Everything the UI can change lives here so experiments are reproducible.

export const VERSION = '0.1.0';

export function defaultConfig() {
  return {
    seed: 7,
    world: { size: 1000 },
    asset: { x: 500, y: 500, r: 28 },
    gs: { enabled: true, x: 500, y: 560, sensor: 240, radio: 420 },
    defenders: {
      count: 8,
      speed: 55,
      accel: 90,
      sensor: 140,
      radio: 250,
      tagRadius: 12,
      patrolRadius: 170,
    },
    enemies: {
      perWave: 10,
      speed: 42,
      accel: 40,
      autoWaves: true,
      waveInterval: 10,
      behavior: 'mixed', // direct | weave | evade | mixed
    },
    comms: {
      latencyMs: 20,  // per hop, plus up to 50% jitter
      loss: 0.05,     // per-link packet loss probability
      hops: 3,        // relay limit (TTL)
      zone: { on: false, x: 280, y: 330, r: 160, strength: 0.9 },
    },
    policy: {
      maxPerTarget: 1, // how many drones may chase one target (to be learned later)
      hysteresis: 0.85, // discount on the current target's cost to stop flip-flopping
      urgency: 0.3,     // weight on enemy time-to-asset when ranking targets
    },
    timing: {
      stateHz: 5,
      obsHz: 5,
      claimHz: 5,
      planHz: 5,
      contactTimeout: 0.6, // no message from anyone this long -> solo (Layer 1)
      planTimeout: 0.6,    // plan older than this -> peer claims (Layer 2)
      leaderTimeout: 1.0,  // coordinator silent this long -> next lowest ID takes over
      trackTimeout: 1.0,   // forget tracks not refreshed this long
    },
  };
}

// Presets bundle a config tweak with optional scripted events (t in sim seconds).
export const PRESETS = {
  clear: {
    label: 'Clear skies',
    blurb: 'Good links everywhere. The ground station coordinates the whole swarm (Layer 3).',
    apply(c) { c.comms.loss = 0.02; c.comms.latencyMs = 15; c.comms.hops = 3; c.comms.zone.on = false; },
    events: [],
  },
  patchy: {
    label: 'Patchy links',
    blurb: 'Short radio range and heavy loss. Watch drones drop to peer claims and recover.',
    apply(c) { c.comms.loss = 0.35; c.comms.latencyMs = 60; c.comms.hops = 2; c.defenders.radio = 190; c.gs.radio = 260; },
    events: [],
  },
  zone: {
    label: 'Interference zone',
    blurb: 'A zone kills most packets. Drones that chase into it lose the plan and fall back.',
    apply(c) { c.comms.zone.on = true; c.comms.zone.strength = 0.95; c.enemies.behavior = 'direct'; },
    events: [{ t: 0.5, action: 'waveFrom', angle: Math.PI * 1.25 }],
  },
  coordLoss: {
    label: 'Coordinator lost',
    blurb: 'The ground station is destroyed at 6 s, then the elected drone at 14 s. The swarm re-elects each time.',
    apply(c) {},
    events: [{ t: 6, action: 'killCoordinator' }, { t: 14, action: 'killCoordinator' }],
  },
  blackout: {
    label: 'Total blackout',
    blurb: 'Every packet is lost. Each drone is on its own (Layer 1) using only its camera.',
    apply(c) { c.comms.loss = 1; },
    events: [],
  },
};
