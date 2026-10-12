# Swarm Comms Lab

A browser simulation of a communication framework for a defensive drone swarm. Every drone runs the same code and falls back through three layers depending on what it can hear:

| Layer | When | What the drone does |
|---|---|---|
| **3 · Coordinator plan** | A fresh `PLAN` from the coordinator | Follows a globally optimal assignment (Hungarian algorithm) |
| **2 · Peer claims** | No plan, but peers are audible | Bids on targets with `CLAIM`s; lowest cost wins, ties go to the lower ID |
| **1 · Solo** | Nobody audible | Chases what its own camera sees, otherwise patrols |

The coordinator is simply the lowest ID a node has heard from recently. The ground station is ID 0, so it leads whenever it's reachable, and a drone takes over automatically when it isn't.

**Live page:** https://mailabhiramsrinivas-art.github.io/swarm-comms-lab/

## Run locally

ES modules need a local server (opening `index.html` directly won't work):

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

Run every scenario headless (Node 22+):

```bash
node test/headless.mjs 40
```

## Code map

| File | Role |
|---|---|
| `js/config.js` | Every tunable parameter and the scenario presets |
| `js/sim.js` | World, enemies, contacts, metrics. No DOM, so it runs headless |
| `js/node.js` | One swarm member: sensing, election, layer fallback, messaging |
| `js/network.js` | Radio model: range, loss, latency, interference zone, TTL relays |
| `js/policy.js` | Decision policy, a hand-written stand-in for the trained model |
| `js/render.js` | Canvas drawing |
| `js/main.js` | Controls, stats, log, inspector, animation loop |

### Plugging in a trained model

The comms layer only calls three functions in `js/policy.js`:

- `buildPlan(drones, tracks, now, ctx)`: Layer 3, returns `Map<droneId, trackId | null>`
- `peerChoose(self, tracks, claims, now, ctx)`: Layer 2, returns `{ target, cost }`
- `soloChoose(self, ownTracks, now, ctx)`: Layer 1, returns `{ target, cost }`

Replace them with a learned policy and the rest of the framework stays the same.

## Assumptions in v0.1

- Enemy identities are known to everyone (no data association yet)
- 2D world, simple point-mass dynamics, synchronized clocks, symmetric links
- Relaying is TTL-limited flooding
- Interception is a tag: getting within 12 m

See the Roadmap section on the page for what comes next.
