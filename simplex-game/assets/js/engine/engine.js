// Engine entry point: load the trained weights and build the four networks.

import { Weights } from "./nn.js";
import { FlipPolicy, TickPolicy, PlacementNet, TeamSizeNet } from "./models.js";

export function buildNets(manifest, buffer) {
  const W = new Weights(manifest, buffer);
  return { tri: new FlipPolicy(W), tick: new TickPolicy(W), place: new PlacementNet(W), team: new TeamSizeNet(W) };
}

/** Browser / worker loader (fetch relative to a base URL). */
export async function loadNets(baseUrl) {
  const [man, buf] = await Promise.all([
    fetch(new URL("weights.json", baseUrl)).then((r) => r.json()),
    fetch(new URL("weights.bin", baseUrl)).then((r) => r.arrayBuffer()),
  ]);
  return buildNets(man, buf);
}

export * from "./referee.js";
export * from "./agents.js";
export * from "./env.js";
export * from "./geom.js";
export * from "./match.js";
export * from "./models.js";
export { PCG64, seedFromPoints } from "./rng.js";
