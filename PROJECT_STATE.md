# BLIND SPOT — Project State

> Read this first after any context compaction. Durable decisions only, not a diary.

## What this is
A browser 3D 1v1 PvP prototype. Players see the world only as **point-cloud memories**
produced by echolocation pulses. An observation is frozen at the moment it was taken and
never updates itself. The thought the game exists to produce:
*"I know what used to be here. I need to decide what is probably here now."*

## Hard invariants (do not violate)
1. **The server never sends a client the opponent's live transform.** `Room.reveal()` is the
   only door through which enemy information leaves, and it degrades to FULL / COARSE /
   TRACE **server-side** before queueing. A modified client gains nothing.
2. **Simulation state and perceived state are separate objects.** `src/client/perception.ts`
   is the only thing the renderer reads, and its only entry point is `applyEvent()`.
3. Static geometry is not secret (same map every match), so the client raycasts its own copy
   from emitter parameters. Only *dynamic* reveals cross the wire — bandwidth-trivial.
4. Ghosts are frozen photographs: fixed slots, replaced wholesale, **never interpolated**.
5. `snap.relicHeld` is deliberately reduced so it cannot say *who* holds the relic.

## Design (locked; full brief in DESIGN.md)
- **Reciprocity Law** — every emission is two-sided. A pulse paints geometry for you *and*
  renders your position to the enemy through walls (COARSE, 35m). This, not the 4s cooldown,
  is what stops scan spam.
- **Relic arc** (anti-stall) — relic at 1 of 5 sites; heartbeat every 20s paints its
  neighbourhood in gold for BOTH players. Carrier cannot sprint and "sings" every 5s.
  Extraction = channel 3.5s in The Well, fully lit. Overdrive 6:00. Hard cap 8:00, then
  sudden death (first touch wins). No draws.
- **Three-Color Law** — cyan = matter, orange = life, amber = sound, gold = objective.
  Age = temperature. Depth is encoded *only inside* the cyan band, so a warm silhouette can
  never be mistaken for near geometry.
- Weapons: JUDGE (50 dmg, tracer + impact bloom visible to BOTH — a gun that doubles as a
  paid scanner) and WHISPER (16 dmg, near-silent, shooter-only impact).
- Gadgets: Sensor Spike, Decoy Shard, Echo Bomb. 12 upgrade cards in 3 tiers.

## Rendering model (the parts that were hard)
- **Surface splatting.** A structural point is sized to the screen footprint of the 0.045m
  voxel it stands for (`uVoxProj / dist`). Voxel dedup caps density, so total coverage is
  bounded by visible surface area and *cannot* blow out. Near wall = surface; far wall =
  grain. Alpha is divided by splat size to conserve energy.
- **Voxel dedup** (`PointField.VOX = 0.045`) — rescanning a wall refreshes that measurement
  in place instead of stacking a second copy. This is what lets memory persist. It is also
  the resolution ceiling on close surfaces; 0.09 was too coarse and read as scattered dots.
- **The wavefront is data, not animation.** Every point stores the time the wave *reaches*
  it, so the reveal propagates with zero per-frame CPU. Casting is frame-budgeted.
- **Elliptical pulse cone** (70° wide, ~43° tall). A circular cone spends most rays on the
  floor 2m ahead and the ceiling 3m up — the least informative surfaces in the game.
- **Tangential jitter.** Noise is scattered in the surface tangent plane; isotropic jitter
  puffs every flat wall into a 10cm slab of fog.
- **Memory must stay bright.** The dim blue wireframe *is* the player's map. When it faded
  too far the game quietly became "whatever you scanned in the last four seconds".
- **Ghosts dissolve as well as cool.** Entity points drift outward with age (t^2, up to
  0.38m), so a stale sighting visibly comes apart into an unstructured cloud. Colour alone
  was legible but did not read peripherally; dissolution does.
- Post: half-float target → high-threshold bloom (0.75 scale) → ACES grade. A low bloom
  threshold at low internal resolution blows a single isolated point into a hard square.

## Perf (measured under SwiftShader, so read the ratios not the numbers)
`full chain 4.7fps · no bloom 12.0 · no post 22.2 · post-on-but-no-points 5.1`
→ the point cloud is nearly free; full-screen passes dominate. On a GPU both are cheap.
`post.autoQuality()` drops bloom under 38fps; test harnesses pin it off so captures show
the intended look.

## Layout
```
src/shared/  math world collide map config proto upgrades   (client+server)
src/client/  main controller perception pointfield ghost scan post net audio
src/server/  index room
tools/       test-*.ts  shot*.ts  dev.sh  test-all.sh
Dockerfile   docker-compose.yml  .dockerignore
```

## Run
`npm install && npm run dev` → client :5173, server :8787 (vite proxies `/ws`).
`sh tools/dev.sh` restarts both by port. `BS_ROOM_SEED=7` fixes the relic site for tests.

`docker compose up --build` → everything on :8787. Notes on the image, so nobody
re-derives them:
- **Debian, not Alpine.** package-lock.json resolves `@esbuild/linux-x64` (glibc) and
  carries no musl variant, so `npm ci` on Alpine leaves tsx without an esbuild binary
  and the server never boots. Switching base image means regenerating the lock on musl.
- The runtime stage deletes `node_modules/three`: vite has already inlined it into
  `dist/`, and nothing under `src/server` or `src/shared` imports it.
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in the build stage, or the playwright
  devDependency drags ~150MB of browsers into a layer the image never uses.
- `CMD` is `node --import tsx`, not the `tsx` shim, so node is PID 1 and takes SIGTERM
  directly (`docker stop` returns in ~200ms, exit 143).
- The `npm ci` steps accept an optional `--secret id=ca` for TLS-inspecting proxies; with
  no secret the mount is absent and the build is unchanged.

## Tests — `sh tools/test-all.sh`
raycaster (brute-force cross-check) · map (connectivity + standability) · firewall
(33 headless protocol assertions) · scan yield · dedup convergence · movement (real keys in
a real browser) · **stale-information acceptance test** (two browser clients) · gameplay ·
full match · soak. All green. The eight browser suites also pass unchanged against the
container image (`BS_URL=http://localhost:8787`); the other three touch no server.

## Bugs found and fixed (keep, so they are not reintroduced)
- **W walked backwards** — the controller's basis had the wrong sign on the forward term.
  Invisible for a long time because every test positioned players by teleporting.
- **The win was never announced** — `checkEnd()` returned early once the phase was already
  `over`, and the win is set inside `stepCarry`.
- **Extraction was inside a crate** — the carrier could not physically stand in the ring.
  Fixed by carving The Well; `test-map.ts` now asserts standability.
- **Every point hit the size clamp** (scale constant ~2.7x too high) so the cloud covered
  the screen and saturated to white.
- **Notices were indexed by array position** while the array was being shifted.

## Rejected approaches
- Full rainbow depth colouring (Scanner Sombre style): an orange enemy became
  indistinguishable from near geometry. Depth now lives inside the cyan band only.
- Deriving point positions from voxel centres to force exact dedup: the first observation's
  position is already stable because a rescan writes into the existing index, and snapping
  produced a visible lattice.
- Distance-only near-field thinning: it removed the grazing walls that make a corridor read
  as a corridor. Thinning is now gated on incidence, so only face-on splatter is cut.
