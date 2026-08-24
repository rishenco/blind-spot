# BLIND SPOT — visual-prototype engine

A first-person parkour-stealth game about seeing with sound. The world is black. Every sound —
your own footsteps, a sonar ping, a patrolling robo-dog, a kicked can — paints the geometry around
where it happened, as points. Louder means denser; the source decides the colour of the marker,
never the colour of the matter. Whatever lets you see also tells the world where you are, so there
is no free intel on either side: your headlights are the noise you make.

This repository is the **visual prototype**, not the game. It is the instrument built to answer
one question before any content exists: is a point cloud painted by sound readable at parkour
speed? So it ships one authored floor ("Dock Approach"), the full perception pipeline (surfel bake,
event-sourced paint, propagation through walls, aging into a permanent memory skeleton), the
movement verbs, both sonar pings, one patrolling dog with its ghosts, props, procedural audio, and
a **look contract** that lets three art directions be written in parallel and hot-switched at
runtime. Cells, Heat, chips, dog investigate/attack AI, co-op and meta are deliberately out of
scope (`doc/engine-plan.md` §0). The design is `doc/vision.md`; the laws there win every conflict.

## Prerequisites

- **Node 20.19+ or 22.12+** (Vite 8's own requirement). No other toolchain.
- A browser with WebGL2 for the first-person view. Without WebGL the page still boots and the
  top-down debug view (`M`) still works — the first person is simply absent.
- `npm run verify` additionally needs a Playwright chromium binary (see [Verification](#verification)).

## Run it

```sh
npm install
npm run dev          # http://localhost:5173  (strict port)
```

Production bundle, served the way `verify` serves it:

```sh
npm run build        # -> dist/
npm run preview      # http://localhost:4173  (strict port; == npx vite preview --port 4173)
```

With Docker instead of a local Node (the client is fully static, so the image is just the
bundle behind nginx):

```sh
docker compose up --build           # build + serve      -> http://localhost:8080
docker compose --profile dev up dev # live-reload dev server -> http://localhost:5173
```

**The first screen is black, and that is correct.** Boot bakes the lattice synchronously (a couple
of hundred milliseconds, under the "baking lattice…" splash), and vision §1.3 says absence is never
drawn — no
ambient light, no fog, no outlines. All you get standing still is a faint 2 m contact shell around
your body. Walk, and your own footfalls light the room ~4 m at a time. Sprint, and they light ~7 m.

Around the reticle: a ring whose brightness is your current audible radius, and a printed readout
of that radius in metres plus the reactor (`⚡ energy/max`). A refused ping prints why.

Keys `1`/`2`/`3` are the three art directions, all authored: `1` (Phosphor — slow-decay
sonar-scope look: every dot a struck phosphor grain that flares, breathes, and refuses to die),
`2` (Blueprint — line-led drafting look), `3` (Signal — raw-data decode look: quantized samples
that resolve into the lattice). `0` is the plain debug look the engine shipped with.

## Controls

Exactly what `src/main.ts` binds. Click the canvas once to take pointer lock; the same click also
starts the audio context.

| Key | Does | Bound at |
|---|---|---|
| `W` `A` `S` `D` | Move (forward/left/back/right) | `src/main.ts:288` |
| Mouse | Look (pointer lock; click `#app` to acquire) | `src/main.ts:353`, `:358` |
| `Shift` (either) | Sprint — 6.0 m/s, 1 energy/s, and 7 m of paint per footfall | `src/main.ts:292` |
| `Ctrl` (either) or `C` | Crouch — 1.7 m/s, 1.5 m of paint. Held at ≥5.5 m/s it becomes a **slide** | `src/main.ts:293` |
| `Space` | Jump; **mantle** a ledge up to 2.2 m when one is in front of you; jump off a ladder | `src/main.ts:311` |
| `E` | Directed ping — 25° cone, 40 m, 18 energy. Heard 30 m at **both** ends of the beam | `src/main.ts:317` |
| `Q` | Spatial ping — 360°, 12 m, 10 energy | `src/main.ts:320` |
| `0` | Look: debug (the neutral one; the engine ships with it up) | `src/main.ts:303`, `src/looks/index.ts:37` |
| `1` `2` `3` | Look: phosphor / blueprint / signal — the three authored art directions | `src/looks/index.ts:38` |
| `M` | Top-down debug plan: the authored map, doors, patrol routes and your own trail | `src/main.ts:323` |
| `N` | Mute / unmute audio | `src/main.ts:342` |
| `B` | Camera motion effects on/off (head bob, landing dip, slide roll) | `src/main.ts:339` |
| `F3` | Stats panel: surfels, painted dots, paint ms/frame, draw calls, event/s, halo, dogs | `src/main.ts:327` |
| `F6` | Spawn/despawn the optional second patrol (dog 2), live | `src/main.ts:331` |
| `F7` | Test detonation 12 m along your aim (backed off short of a wall) — the loudest paint in the game | `src/main.ts:335` |

Verbs with no key of their own: **vault** (a ledge ≤1.2 m triggers on contact and keeps your
speed), **ladder** (walk into it to grab, `W`/`S` to climb at 2.5 m/s — silent, per vision §5;
`Space` jumps off, crouch drops off), **slide** (crouch above 5.5 m/s). There is no fall damage:
a drop over 4 m costs a 0.3 s stagger and a very loud landing instead.

## URL parameters

| Parameter | Effect |
|---|---|
| `?look=debug\|phosphor\|blueprint\|signal` | Boot straight into a look. Unknown values fall back to `debug`. |
| `?topdown` | Open with the top-down plan up. |
| `?stats` | Open with the `F3` readout up. |
| `?nobob` | Start with camera motion off (the `B` toggle's initial state). |
| `?flat` | Reduce-flashing comfort mode. The OS `prefers-reduced-motion` setting turns it on too. |
| `?sim=…` | Run a scripted route instead of reading the keyboard (below). |
| `?dogs=…` `?props=…` | Which patrols and which props are live: `none`, `all`, or a comma list of ids. |

**Scripted routes** (`src/core/debug.ts` `SCRIPTS`) replay a fixed input list at a fixed number of
steps per frame, so they play out identically on any machine — they are the verification fixtures
and the fastest way to see the pipeline work without touching a key:

| `?sim=` | Route |
|---|---|
| `script`, `script1`, `corridor` | Corridor C end to end: sprint, slide the duct, jump, drop 2.8 m into the trench, climb out silently. |
| `script2`, `mantle` | Cross the machine hall at a sprint and mantle the 2.2 m machinery row. |
| `script3`, `ping` | Walk somewhere quiet, go silent, `Q` the room, then `E` the tank 10 m away. |
| `script4`, `lantern` | The Lantern rig: mantle the row, go completely silent, and hear dog 1 through the listening wall for 25 s. |

**Rosters.** With the parameter absent, a scripted run gets what its own route declares (nothing,
unless the route is about a dog) and a hand-played run gets the map's defaults: dog 1 patrolling
and every prop live. Ids are `dog1` (default on) and `dog2` (default off); `can-c-1`, `can-c-2`,
`can-field-1`…`can-field-6`, `chain-c`, `beacon`. Unknown ids are dropped silently. Example:
`?sim=script4&dogs=dog1,dog2&props=none`.

## Test-driving the sample map

The floor is "Dock Approach" — 45 × 30 m, one storey plus a trench, laid out in
`doc/sample-map.md` §1. You spawn at (3, 3) in zone A, the spawn dock, facing east. Press `M` at any
time to see the plan and where you have actually been; the geometry you have painted stays painted
for the whole run, cooling into a dim navy skeleton you can still navigate by.

`doc/sample-map.md` §4 is the tester's script, and each beat is chosen to isolate one claim:

1. **Sprint C end to end** — slide the duct, jump the pit. Nothing lights your way but your own
   footfalls. (This is the Blindfold Gauntlet seed, vision §15.1. `?sim=script` drives it.)
2. **Drop into the pit on purpose, then climb the ladder out.** Descending is fast and loud, and
   the landing floods the trench with paint; the climb is slow and emits nothing at all. Feel the
   asymmetry — it is the whole economy of the descent.
3. **Chain-curtain into D1 loud, then again crouched.** Mantle to the high shelf, `E`-ping D1 from
   above, drop off it loudly.
4. **Thread the can field into D2 crouched.** Watch the beacon's stain breathe on its 4 s cycle.
5. **Climb the machinery row in B and stand still.** Track dog 1 through the listening wall by its
   gait-paint alone for 20 s, then call which door it leaves by. (The Lantern Test, vision §15.2.
   `?sim=script4&dogs=dog1` drives it; the post is on top of the row because at floor level the
   sound arrives through two walls, and two walls is silence.)
6. **Stand still in B until the world is only skeleton, then `E`-ping the tank once.** One
   question, one answer, and the room you had forgotten comes back.

`F7` anywhere is the counter-example worth seeing at least once: a single detonation paints 22 m in
every direction and is the one class loud enough to bleed through a floor, which is why vision §6
calls a dog something you spend rather than something you fight.

## Verification

Four commands, and `doc/engine-plan.md` §11 requires all four green:

```sh
npm run typecheck    # tsc --noEmit, strict
npm test             # vitest run — the specs under test/
npm run build        # vite build -> dist/
npm run verify       # node scripts/verify.mjs — builds, then drives the real bundle in a browser
```

`npm run verify` builds `dist/`, serves it from a tiny static server on `127.0.0.1:4180`, drives it
in Playwright chromium, and writes one screenshot per capture into `verify-out/` (git-ignored).
Eleven captures run: the boot screen, the top-down plan, the two movement routes, the black world,
the world a route paints, an `F7` detonation at two window sizes, the `F3` panel, the sonar route
and the Lantern route. Each one asserts what the numbers must be — the exact painted-dot counts of
each fixed route, the ink coverage of the frame, the largest connected run of saturated pixels (the
anti-porridge guard), the delivered-event tallies, the surfel budget, draw calls, and that the
browser console stayed clean.

It prints **`VERIFY OK`** only when every check on every capture passed. Otherwise it prints
`VERIFY FAILED (n)` with each failure named, and exits non-zero. A screenshot only proves a file
was written, so the images are meant to be **looked at** as well: a black `fp-script.png` is a
failure even if every number passed.

Flags: `--no-build` reuses the existing `dist/`, `--port <n>` moves the static server.

> **Browser binary.** `scripts/verify.mjs` launches chromium from a hard-coded
> `/opt/pw-browsers/chromium` (line 46), which is where this project's environment keeps it. On a
> machine where Playwright's browsers live elsewhere, point that constant at your own binary.
> Headless software GL is fine — the harness runs SwiftShader deliberately, and the frame-rate
> figures it prints are a liveness floor, not the 60 fps target.

### Budgets

Vision §12 sets hard budgets, and `test/budgets.spec.ts` is the registry that pins them: the
lattice pitch, the point-pool ceiling, the splat size floors and the size of every bounded pool in
the engine. The headline numbers, as this build measures them:

| Budget | Value | Where |
|---|---|---|
| Point ceiling (vision §12) | ~1 M | `test/budgets.spec.ts`, and asserted in-browser on every verify capture |
| "Dock Approach" bake | 118,394 dots + 1,362 edge segments = 121,118 points | `src/core/surfels.ts` |
| Lattice pitch | 0.22 m | `SURFEL_SPACING` |
| Render window | 45 m radius, ±1 floor | `WINDOW_RADIUS`, `src/main.ts` `FLOOR_SPAN` |
| Splat size floor / near floor | 2.2 px / 4.0 px | `SPLAT_MIN_PX`, `SPLAT_NEAR_PX` |
| Near-field splat cap | 1.2% of frame height | `SPLAT_CAP_FRAC` (look-private) |
| Event ring / delivered ring / stain ring | 96 each | `EVENT_RING`, `PaintPipeline`, `STAIN_CAP` |
| Dog ghosts / live poses / body points | 6 / 5 / ~600 | `DOG_MAX_GHOSTS`, `DOG_SMEAR_SAMPLES`, `DOG_CLOUD_TARGET` |
| Sim catch-up clamp | 5 steps | `SIM_MAX_STEPS` |

The matter layer is the one pool that never evicts — vision §3.6 keeps every painted surface for
the whole run — and it does not need to: it is fixed-size typed arrays allocated once by the bake,
so growth is structurally impossible and seven floors of this density still fit under the ceiling.
Every transient pool (event history, stains, ghosts, the debug trail) is a hard cap that overwrites
oldest-first. The one budget no unit test can state is the 60 fps target; `npm run verify` measures
frame cost in a real browser instead.

## Layout

```
doc/vision.md         the design. Laws are fixed; numbers are tuning.
doc/engine-plan.md    architecture, module map, the look contract, milestones
doc/visual-brief.md   what a tester must be able to feel, and the look direction
doc/sample-map.md     "Dock Approach": zones, doors, patrol, test choreography
src/core/             sim, events, surfels, paint, movement, player, dog, props, audio, map
src/looks/            the look contract + debug look + the three authored looks
src/main.ts           boot: wires sim -> bus -> paint -> looks, input, the frame loop
test/                 vitest specs
scripts/verify.mjs    the browser verification run
```

`src/core` never imports a look, and no look writes to the sim. Sound events are the only thing
that crosses: geometry is never transmitted, always re-derived from the events a listener received
— which is what makes the co-op build a transport problem rather than a rewrite.

In the browser console, `window.blindspot` exposes the live `sim`, `paint`, `field`, `looks` and
`debug`, plus `stats()`, `ink()` and `detonate()`.
