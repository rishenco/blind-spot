# BLIND SPOT

A first-person parkour-stealth game about seeing with sound. The world is black; every noise —
your own footsteps, a ping, anything that will later make one — draws the geometry it reached,
and what you have heard cools into a permanent memory skeleton you never lose. See
[`doc/vision.md`](doc/vision.md) for the design.

This branch is the game itself: one room, one movement system, one look. It was distilled from
the prototype's lab build, which carried four alternative point-cloud renderers, a lit graybox
movement room, a scene registry and a picker so the choices could be compared side by side. The
comparison is over — Blueprint won — so none of that machinery is here.

## Run it

Needs Docker (with the compose plugin) and `make`:

```sh
make up      # builds the image, serves it, opens http://localhost:8080
make down    # stop
make logs    # server logs
make rebuild # clean rebuild (if a stale image misbehaves)
```

After pulling a new version of the branch, just run `make up` again — it rebuilds.

## Dev (no docker)

Needs Node 22:

```sh
make dev     # vite dev server with hot reload
make shoot   # headless build + Playwright smoke suite (tools/shoot.mjs), screenshots in shots/
```

`npm run typecheck` is the fast check; `npm run build` produces `dist/index.html`, a single
self-contained file with no runtime network use at all.

## Controls

WASD move · Shift sprint · C/Ctrl crouch · Space jump (and climb at a ledge) · Q spatial ping ·
E directed beam · L debug reveal (lights on) · B bloom · T paint-clock speed · K clear the map ·
V first/third person · R respawn · H help. Click the canvas to capture the mouse; Esc releases.

The panel on the right is the dev panel: every number the look and the wave are made of, live.

## The code

```
src/
  main.ts              boot: renderer, input, HUD, dev panel, the fixed-step loop
  game/game.ts         the game — clock, keys, wiring, the read-only state tooling drives
  world/room.ts        the level: colliders (the real world) and meshes (the L reveal only)
  player/controller.ts movement — walk/sprint/crouch/jump/mantle, camera feel, footstep events
  core/                input, the fixed-timestep loop, AABB collision and sweeps
  paint/
    soundEvents.ts     the sound bus: every noise in the game goes through it (laws 1 and 2)
    paintSystem.ts     the shared half of perception: hearing gate, event layer, wavefronts
    structured.ts      the reveal — sound unlocks exact geometry as a lattice and contours
    waveFx.ts          the firing streak and the dust a front lights in empty air
    ageRamp.ts         age is the only axis anything is drawn on (§3.2, §3.6)
    materials.ts       what a surface is made of, and the cyan matter palette
    post.ts            selective bloom
  ui/hud.ts            debug readout, hint line, help card
tools/
  shoot.mjs            headless driver: drives the build with real input and asserts on it
  png.mjs              minimal PNG reader, so the assertions can be photometric
```

Two rules the code is built around and will not survive losing:

- **Every noise goes through the bus.** A blip with no real event behind it is impossible to
  produce, which is what makes "the system never lies" enforceable rather than aspirational.
- **The colliders are the world.** Movement and the reveal both run against the same box list;
  the meshes exist only so `L` can turn the lights on and show what the sonar had to find.
