# BLIND SPOT — Project State

> Read this first after any context compaction. Concise, durable decisions only.

## What this is
Browser 3D 1v1 PvP prototype. Players see the world only as **point-cloud memories**
produced by echolocation pulses. Observations are frozen at the moment they were taken
and never self-update. Core thought the game must produce:
*"I know what used to be here. I need to decide what is probably here now."*

## Hard architecture invariants (do not violate)
1. **The server never sends a client the opponent's live transform.** It sends only
   `Observation` records (position + timestamp + confidence) produced by a legitimate
   information event. This is the whole game; a leak here is a P0 bug.
2. **Simulation state vs perceived state are separate objects.** `sim` (server truth)
   and `perceived` (client render source) never share a reference.
3. Static geometry is NOT secret (same map every match) so the client generates
   geometry point clouds locally from `map.ts`. Only *dynamic* reveals cross the wire.
4. Enemy ghosts are frozen poses — **no interpolation, no live transform, ever**.

## Stack
TypeScript + Vite + Three.js (client), Node + `ws` (server), shared modules in `src/shared`.
`npm run dev` runs both (server :8787, client :5173, vite proxies `/ws`).

## Modules built so far
- `src/shared/math.ts` — Vec3 helpers, `dirFromAngles`, `mulberry32` PRNG.
- `src/shared/world.ts` — AABB `Box` list + uniform XZ grid + DDA `raycast` + `lineOfSight`.
  Materials: Concrete/Metal/Glass/Cloth/Grate/Objective.
  **Verified**: 20k random rays match brute force; ~1100 rays/ms on the real map.
- `src/shared/collide.ts` — axis-separated AABB player movement w/ step-up. Shared so the
  server can revalidate movement identically.
- `src/shared/map.ts` — "Substation 7", 57x53m, 103 boxes. Zones: CONCOURSE (pillared hall
  + mezzanine), LATTICE (offset-doorway cells), SPINE (central artery), BAFFLES
  (scan-absorbing cloth panels), VAULT (glass chamber). **Verified**: fully connected
  flood-fill, all spawns/sites in open space.
- `src/client/pointfield.ts` — ring-buffer `Points` + shader. Each point stores the time the
  wavefront *reaches* it, so pulses propagate with zero per-frame CPU. Age drives fade,
  shrink, desaturation, hue drift to cold blue.
- `src/client/scan.ts` — `PulseQueue`/`PulseJob`. Frame-budgeted ray casting; per-material
  response (glass & grate let rays pass through, cloth returns almost nothing).

## Key material trick (keep this)
Cloth baffles are **solid walls that return almost no signal** — in your reconstruction they
read as open doorways. Glass returns a faint plane *and lets the pulse through*, so you can
scan a room you cannot enter. The map itself generates false negatives.

## Tools
- `npx tsx tools/test-raycast.ts` — raycaster correctness + perf (must stay green)
- `npx tsx tools/test-map.ts` — map connectivity flood fill + ASCII preview

## Status
Design phase running (Fable agent → `DESIGN.md`). Engine foundations done & tested.
