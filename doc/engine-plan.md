# BLIND SPOT — Visual-Prototype Engine Plan

*v1.0, 2026-08-23. Phase-3 architecture. Binding for the engine implementer and for the
three look implementers. Refines `doc/vision.md` and `doc/visual-brief.md`; the vision's
laws win on any conflict.*

## 0. Scope

A solo, fully client-side visual prototype: one floor (`doc/sample-map.md`), full
perception pipeline, movement verbs, one patrolling dog, props, procedural audio, and a
**Look contract** that lets three art directions be implemented in parallel and switched
live at runtime. Explicitly OUT of scope: cells/Heat/chips gameplay, dog
investigate/attack AI, co-op, meta. Perception is event-sourced from day one (vision §16):
sound events in → paint derived. No pre-reset code exists; everything is written fresh.

## 1. Stack

- Vite + TypeScript (strict) + Three.js (pin current stable exact versions). Runtime deps:
  `three` only. Dev deps: `vitest`, `typescript`, `vite`, `playwright` (verification),
  `@types/three` if needed.
- Scripts: `dev`, `build`, `preview`, `test` (vitest run), `typecheck` (tsc --noEmit),
  `verify` (boot + Playwright screenshot run, below).
- 60 fps on a mid-range GPU; sample map ≤ ~500 k surfels; per-frame CPU work independent
  of surfel count except surfels actually painted that frame.

## 2. Module map

```
src/
  main.ts               boot, canvas, resize, look registry + switching (keys 1/2/3, ?look=)
  core/
    const.ts            ALL tuning constants (single file, commented)
    math.ts             helpers (falloff, easing, seeded hash)
    events.ts           SoundEvent types + bus + recent-event ring buffer (with quality)
    map/types.ts        MapDef types (solids, ladders, props, routes, spawn)
    map/sampleMap.ts    the authored floor, exactly per doc/sample-map.md
    map/build.ts        MapDef -> collision set + occluder set + walkable/ladder volumes
    surfels.ts          lattice bake, edge/hold extraction, spatial hash, patch table
    paint.ts            applyEvent(): query, cone filter, LOS, delay, falloff, dither write
    movement.ts         capsule controller + verbs + footstep/landing/slide emitters
    player.ts           energy, pings, halo model, hands rig state
    dog.ts              route follower, procedural gait pose, emitter, ghost snapshots
    props.ts            cans, chain curtains, beacon
    audio.ts            WebAudio synth (steps, pings, gait, clatter, hum, land), mute M?—no: key 0
    sim.ts              fixed-step (60 Hz) orchestration; exposes read-only SimView
    debug.ts            F3 stats overlay, M top-down ortho view, F6 dog2, F7 test detonation
  looks/
    types.ts            THE LOOK CONTRACT (below)
    index.ts            registry: debug, phosphor, blueprint, signal (stubs until built)
    debug/              neutral look, part of the engine milestone
    phosphor/  blueprint/  signal/     (Phase-5 folders; engine ships stubs = debug clone)
test/                   vitest specs for core logic
```

## 3. Surfels (the painted world's data)

**Bake (at load):**
- For every solid face, generate lattice points on a world-axis triplanar grid, spacing
  `SURFEL_SPACING = 0.22` (structural: same world position ⇒ same dot, across faces and
  rescans). Offset dots to the face plane; store position + face normal.
- Cull faces buried inside other solids (sample-center inside-solid test).
- **Edges:** where two exposed faces meet at a crease (box edges), emit line segments
  (subdivided to ≤0.5 m pieces) with an `edge` class. Classify a subset as `hold` (vision
  §5: walkable top edges 0.7..2.6 above adjacent standing surface, ladder rails + rungs,
  the duct lip, pit lip, shelf/catwalk/beam lips). Holds render brighter/thicker in looks.
- Per surfel static attributes: `position (f32×3)`, `normal (oct or f32×3)`,
  `dither (f32, stable hash of lattice coords)`, `flags (u8: edge/hold in the line buffer;
  surfel buffer is dots only)`.
- Per surfel dynamic attributes (updated only when painted): `paintTime (f32, sim seconds;
  init −1e9)`, `paintIntensity (f32 0..1)`. Edge segments carry the same pair per vertex.
- Structures: spatial hash (cell 2 m) surfel index; **patch table**: 1 m clusters with
  center + member range, for patch-level LOS (one raycast per patch, not per surfel).
- Buffers are THREE.BufferGeometry with the above as attributes; dynamic attrs use
  partial `addUpdateRange` uploads per painted region.

**Paint (`applyEvent`):**
1. Gather candidate patches in the event's paint radius (cone-filtered for E-ping: 25°
   half-angle 12.5°? — use full cone angle 25°, i.e. ±12.5° around the aim direction).
2. Patch LOS: raycast patch center → origin against occluder boxes; count penetrated
   walls. 0 walls → full. 1 wall → radius ×0.4, intensity ×0.5, origin offset by the
   event's stable fuzz vector (seeded per event; magnitude `min(WALL_FUZZ, 0.4 × R)` —
   see §4). ≥2 walls → nothing. (vision §3.4)
3. Per surfel in surviving patches: `d = dist(surfel, effectiveOrigin)`;
   `I = intensity × clamp01(1 − (d/R)²)` (quadratic falloff to zero at radius R).
   Light the surfel iff `I ≥ surfel.dither × DITHER_GAIN` — intensity = coverage density,
   stable per lattice point (visual-brief §2).
4. `delay = d / waveSpeed(class)` (0 for instant classes). Write
   `paintTime = max(old, event.time + delay)`, `paintIntensity = max(old, I)`.
   The shader derives everything else from `now − paintTime` (rim at small age, cooling,
   thinning: a surfel drops out when its age-alpha × intensity falls below its dither
   band — same dots drop first, oldest look thins to edges).

   *(M3 review, ruling R1b — amended.)* Both channels merge with `max`, and the re-hear
   decay this step used to specify (`max(I, old × 0.85)`) is gone. `max` is commutative,
   associative and idempotent, so the converged picture is a pure function of the SET of
   delivered events: it cannot depend on the order they were heard in, on how many frames
   the wavefronts took to arrive, or on how fast the machine is. `× 0.85` is none of those
   things — with two overlapping events the result depends on which was applied first, so
   two co-op clients deriving geometry from the same event stream (§11.1) would draw
   different worlds. Determinism outranks a tuning value. Age stays the only recency
   channel; `paintIntensity` now means "the loudest this surface was ever heard", and a
   quiet re-hear buys freshness without dimming what a loud one already established.
5. Normal-facing check: skip surfels whose normal faces away from the effective origin
   (dot < 0) — sound paints the face it hits.

**Schedule (`PaintPipeline.hear` / `pump`) — due-gated, one path.** `paintTime` is not only a
colour, it is the shader's visibility gate (`uNow − paintTime >= 0`), so a write whose stamp is
in the renderer's future does not "brighten later" — it *blanks* the surface until the wavefront
lands, erasing a memory skeleton the player already bought (vision §3.6). The store therefore
never holds a future timestamp:

- An **instant** class (`waveSpeed === Infinity`) is due the moment it happens and is painted
  whole inside `hear()`.
- A **travelling** class is queued as a `PaintJob` — a patch list sorted by arrival — and
  released by `pump(now)`, which paints exactly the patches whose wavefront has landed, in
  arrival order. That is the only pass: there is no work-ahead pass and no millisecond budget.
- A patch is released once its **farthest** member is due (`|Δcentre| + patchRadius + fuzz`), so
  a near member can wait up to `(2·patchRadius + 2·fuzz)/waveSpeed` — ~41 ms for a detonation.
  Bounded lateness is the price of never being early, and it is the right way round: late paint
  is a surface that arrives a frame after its sound, early paint is a hole in the world.
- The frame calls `pump(now)` with the **same clock the shader gets as `uNow`**, before `flush()`
  and before the look renders. Combined with the max-merge above, the reveal is write-timed and
  the converged picture is still a pure function of the event set.

*Open, M5 (M3 review, A4 — accepted trade-off, deliberately not fixed).* Due work is unbudgeted:
`pump` pays the whole backlog in one call. A consumer that lets several wave events pass their
arrival before pumping — one long frame, a tab regaining focus, a load hitch, a script scrubbing
time forward — pays for all of them at once, and a detonation is 5286 patches. If playtests show
that spike, the fix is a hard per-frame ceiling above which *bounded lateness* is preferred to a
dropped frame (a patch may be released a frame or two after its arrival, never before it), with
the overflow carried to the next pump. Pinned as a deliberate choice in `test/paint.spec.ts`.

**Contact shell:** shader-side, always-on: surfels within 2 m of the camera get a faint
floor alpha (≈0.05) regardless of paint (vision §3.1). No other unpainted visibility.

## 4. Sound events

```ts
type SoundClass = 'crouchStep'|'walkStep'|'sprintStep'|'landing'|'slide'|'mantle'|'propKnock'|
                  'chainRattle'|'qPing'|'ePing'|'dogGait'|'detonation'|'beaconHum';
type SourceKind = 'self'|'dog'|'prop'|'objective'|'detonation'|'teammate';
interface SoundEvent {
  id: number; time: number; origin: V3; class: SoundClass; source: SourceKind;
  intensity: number;            // 0..1 scales paint density
  paintRadius: number; hearRadius: number;
  cone?: { dir: V3; angleDeg: number };   // E-ping only
  waveSpeed: number;            // m/s; Infinity for instant classes
  // derived for consumers (stains, audio):
  fuzzSeed: number; wallsToListener: 0|1|2; distToListener: number; quality: number;
}
```
`quality = clamp01(1 − d/hearRadius) × (walls === 0 ? 1 : walls === 1 ? 0.45 : 0) `
(≥2 walls ⇒ event not delivered at all). Events with `quality = 0` never reach looks or
paint (you receive paint only within your hearing, base 18 m — vision §3.1; hearing range
check uses `HEARING_BASE = 18` vs `d`, but loud classes with hearRadius > 18 are heard to
their hearRadius — implement as: delivered iff `d ≤ max(HEARING_BASE, hearRadius)`).
Numbers per class come from vision §3.3 verbatim (crouch 1.5/2, walk 4/11, sprint 7/24,
landing 8–14/28, slide 5/16 continuous, prop 8–12/25, Q 12/18, E 40-cone/30, dog gait
2/4/8 by mode, detonation 22-through-floors/60, beacon 3/12). Wave speeds: Q 45, E 85,
detonation 140 m/s; all step/prop/slide/gait classes instant.

**Through-wall fuzz is clamped to the degraded radius** *(M3 review, ruling R3)*. Vision §3.4
gives the muffled origin a ±2 m displacement, but that number is written for the loud classes.
Applied flat it inverts the whole point of the wall: a 1.5 m crouch step painting through one
wall has its radius cut to 0.6 m and is then thrown up to 2 m sideways, so it can light a surface
2.6 m away — further than the same step reaches in open air, and *audible through a wall it could
not be heard through in the open*. The magnitude is therefore
`min(WALL_FUZZ, WALL1_RADIUS × paintRadius)`, which bounds through-wall reach at
`2 × WALL1_RADIUS × R = 0.8 R < R` for every class. Loud classes (`R ≥ WALL_FUZZ / WALL1_RADIUS
= 5 m`: sprint 7, landing 8–14, slide 5, prop 8–12, Q 12, E 40, detonation 22) keep the full ±2 m
and are unchanged; only crouch (0.6 m) and walk (1.6 m) are clamped.

The `PaintJob` arrival bound (§3) uses the same clamped magnitude for its `+ fuzz` term, so the
clamp tightens the schedule as well as the reach: a walk step's patches now come due 4.7 ms
earlier than they would under a flat ±2 m, and a crouch step's 9.3 ms earlier.

### 4.1 Proposed vision §3.3 addenda (pending playtest)

Vision §3.3 tables the sounds movement makes, but the M2 controller found two verbs the table
does not name. Design law 1 ("every question has a price") and law 4 ("loud before lethal") both
say a real physical motion cannot be free, so M2 emits for both. **Neither is a vision quote —
both are first-pass tuning guesses, marked as such in `const.ts`, to be confirmed or killed by
the Blindfold Gauntlet (vision §15).**

- **Jump takeoff.** A jump publishes ONE step event at the instant the feet leave, reusing the
  existing §3.3 step rows rather than inventing a row: the class is the speed-derived gait at
  takeoff (§5's bands), **floored at walk** — a standing hop is never crouch-quiet. Without this,
  a hop chain was a silent traversal mode: the airborne frames emit no stride, and a 1.1 m apex
  is under `LANDING_MIN_FALL`, so bunny-hopping across a floor published nothing at all. That is
  a hole in law 1 big enough to route a whole run through, and it is the loudest kind of hole:
  the fastest way to move was also the quietest.
- **Mantle / vault.** A new `'mantle'` class, paint 3 m / heard 7 m, intensity 0.45 — between a
  crouch step (1.5/2) and a walk step (4/11), which is what a deliberate braced shove against a
  ledge should cost. Emitted once, at the moment the verb fires, at the feet, by mantles, vaults
  and airborne pull-ups alike. Audio is a soft distinct scuff (an upward sweep, where the slide
  sweeps down) so it never reads as a footstep.
- **The ladder stays fully silent, top-out included.** That one IS a vision §5 law, not a guess:
  the pull-up off the top rung reuses the mantle glide and shows `hands === 'mantle'`, but emits
  nothing. Descending is fast and loud; ascending is slow and quiet, all the way to the deck.

**Emission order within a fixed step is a guarantee, not an accident.** A step runs its verbs
before it runs its motion, so the order is always: verb events (mantle, then jump takeoff) →
landing → stride/slide. A takeoff therefore stamps the pose the body had *before* that step's
move phase, and **a takeoff and a landing can never share a step** (you cannot leave the ground
and arrive on it in the same tick). M3's paint pass may rely on both.

## 5. Movement

Verbs and speeds per vision §5: crouch 1.7, walk 3.5, sprint 6.0, ladder 2.5 (silent),
jump, mantle ≤ 2.2, slide. Tuning start points (in `const.ts`): ground accel 40, air
accel 10, gravity 22, jump v 7 (≈1.1 m), capsule r 0.35 h 1.7 (crouch 1.1), eye 1.62
(crouch 1.02), slide: entry ≥ 5.5 m/s → boost to 7.5 decaying 2.2/s, exits ≤ crouch
speed; mantle: ledge scan 1.0 ahead, top ≤ 2.2 above feet, 0.45 s glide, triggers hands.
Camera energy (visual-brief §1.8): FOV 92 base → +8 at sprint (smoothed), footfall-locked
head cadence (subtle, ≤0.035 m), landing dip, slide tilt ≈ 4°. No motion blur.
Strides (distance-based emitters): crouch 1.3 m, walk 1.9 m, sprint 2.6 m; slide emits
every 0.5 m; landing event when fall height > 2 m (intensity scales 8→14 m paint by
height, 0.3 s stagger; > 4 m same, no damage). Collision: swept AABB/capsule vs box set;
step-up ≤ 0.35. Jump takeoffs and mantles emit too — see §4.1.

**Gait is measured, never asked.** Both the stride length and the §3.3 row a footstep publishes
derive from the body's actual `speedXZ` against the §5 bands (≤1.7 crouch, ≤3.5 walk, else
sprint), with a crouched stance still forcing crouch. Keys choose a TARGET speed; they do not
choose a loudness. Otherwise releasing shift for a single tick while still travelling at 5.96
m/s published a walkStep — sprint ground at half the hear radius, a free stealth exploit that no
amount of tuning would have closed.

Speed itself is bounded the same way in the air as on the ground: both branches raise the
ceiling to `max(gaitCap, speedBefore)` — never above — and the `OVERSPEED_DECAY` bleed runs on
EVERY frame, airborne included, so no jump can bank a boost the ground would have taken back.
Strafe-jumping stays expressive and stays finite.

## 6. Player systems

- **Energy:** cap 100, regen 6/s, E-ping 18, Q-ping 10, sprint drain 1/s. Empty blocks
  pings only. (vision §4)
- **Pings:** shared 0.75 s cooldown. E: cone 25°, 40 m. Q: sphere 12 m. Both emit their
  own hearable event (E hearable at both ends — implement as second virtual event at beam
  impact center, hear 30 m, once the front arrives; paints nothing extra). Point-blank, the
  far end is legal-by-design: firing at a wall a metre away yields two real events ~32 ms
  apart at effectively the same place, because the wall genuinely re-radiates next to you.
- **Halo model:** `audibleRadius(t)` = smoothed max over the last 1.2 s of self-emitted
  hearRadius, decaying; drives reticle ring brightness (looks) and hum pitch (audio).
  Emission-time, far end included — a long beam keeps you loud until it lands.
- **Hands:** state machine (`none | mantle | ladder | vault`) with phase 0..1; core
  provides a simple boxy robot hand/forearm rig (positions/rotations for 2 hands); looks
  own its material/styling.

## 7. Dog

- Route follower on `dogRoutes` (patrol 3.0 m/s), stop-and-listen pauses per route data.
- Procedural quadruped: body box ~0.9×0.45×0.55, 4 two-segment legs with a trot gait
  phase, neck+head; ~600 local sample points on the same 0.22 lattice discipline (body-
  local bake). Per gait step (every 0.8 m) emit `dogGait` (paint 2 m patrol — vision
  §3.3) at the dog's position: this paints the world AND the dog itself (walking lantern).
- **Visibility = last heard:** the dog's rendered cloud uses the pose at its most recent
  delivered event. When it pauses (silent) it freezes → after 0.4 s becomes a **ghost**
  snapshot that cools hot → rust over ~10 s then dissolves (vision §3.7). Moving again
  re-lights it at the new pose (old ghost keeps dissolving). Motion smear: keep 0.3 s of
  pose history for the look to draw as smear.
- Dev toggle F6 spawns/removes dog 2 (B-hall loop).

## 8. Props & audio

- **Cans:** cylinder r 0.12 h 0.3; on capsule contact: impulse hop (arc + 2 bounces),
  each bounce a `propKnock` (paint 8–12 m by impulse). Settles and stays displaced.
- **Chain curtain:** door-filling strip plane; pass-through emits `chainRattle`
  (walk/sprint: paint 10 m hear 25; crouch: paint 4 m hear 8), sways 1.5 s.
- **Beacon:** every 4 s `beaconHum` (paint 3, hear 12, source `objective`, gold).
- **Audio synth (WebAudio, no assets):** stance-shaped noise-burst footsteps, chirp pings
  (E rising 300→1400 Hz 90 ms; Q soft 500 Hz pulse), dog gait tick-tick, can clatter
  (metallic FM burst), chain shimmer, landing thud, halo hum (sine, volume+pitch follow
  audibleRadius, barely audible at crouch), beacon soft major-third blip. Master gain
  0.6, key 0 mutes. All sounds trigger FROM SoundEvents (audio is a consumer of the same
  bus — never a separate truth).

## 9. THE LOOK CONTRACT (`src/looks/types.ts`)

```ts
interface LookContext {
  renderer: THREE.WebGLRenderer;         // shared; look must not change global state persistently
  camera: THREE.PerspectiveCamera;       // core-driven (movement + FOV kick)
  surfelGeom: THREE.BufferGeometry;      // dots: position,normal,dither,paintTime,paintIntensity
  edgeGeom: THREE.BufferGeometry;        // line segs: position,dither,flagsHold,paintTime,paintIntensity
  dog: DogView[];                        // {cloudGeom, poseHistory, ghosts: GhostSnapshot[], lastEventQuality}
  events: EventFeed;                     // subscribe(cb) + recent(): SoundEvent[] (with quality)
  player: PlayerView;                    // pos, stance, speed, audibleRadius, energy/max, hands: HandsView
  hud: HTMLDivElement;                   // look-owned DOM/canvas layer for the reticle halo
  constants: CoreConstants; time(): number;
  reduceFlashing(): boolean;
}
interface Look {
  readonly id: string; readonly title: string;
  init(ctx: LookContext): void;
  onEvent(e: SoundEvent): void;          // spawn stains / markers / rim cues
  update(now: number, dt: number): void; // animate materials, markers, hud
  render(): void;                        // look owns its scene graph + post chain
  resize(w: number, h: number): void;
  dispose(): void;                       // full cleanup; switching must not leak
}
```
Rules (binding):
- Looks read core state; they never mutate it, never edit files outside their folder
  (plus their one-line registry entry), never re-tune `const.ts`.
- Each look builds its own THREE.Points / LineSegments / marker objects over the SHARED
  geometries (own materials/shaders), its own post chain, its own HUD drawing.
- Aging semantics (ice-white → family hue → navy → skeleton alpha 0.22; thinning via
  dither band; rim at `now − paintTime < RIM_WINDOW ≈ 0.12 s`), event colors' meanings,
  and the noise-stain quality mapping are FIXED; only styling varies (visual-brief §2–3).
- Distance discipline in-shader: fade dot alpha with camera distance; beyond ~20 m bias
  to edges (edge buffer stays, dots thin harder); hard cut 45 m. Splats ≥ 2–3 px.
- `reduceFlashing()` true ⇒ no strobe/flicker effects (decode flickers, afterglow pulses
  become fades).
- Switch protocol: number keys 1/2/3 (0 = debug) hot-switch; paint state persists across
  switches so the same painted world can be compared. `?look=phosphor` boots directly.

**Debug look (engine milestone):** flat white-ish dots (age → gray), plain cyan lines,
red dog cloud, plain circle halo + printed audibleRadius/energy, no post. It proves the
pipeline and remains the fallback.

> **Exit note — the §15 gates must be re-run on a real look** *(M3 review, deviation 2:
> accepted).* The debug look renders age as greyscale on purpose: it is the instrument that
> proves the pipeline, and a colour ramp in it would hide a pipeline bug behind styling. But
> vision §3.2 puts *every* depth cue inside the cyan band, and §12 makes that a law
> ("depth cues only inside the cyan band"). So the debug look is deliberately missing the
> channel the readability laws are written about. Everything M3 measures — ink density,
> saturation, skeleton legibility, the fp-* captures — is measured on a look that omits it.
>
> Consequence: if the Blindfold Gauntlet or the Lantern Test (vision §15) is run against
> the debug look, a pass is not transferable and a fail may be the look's, not the design's.
> Both gates must be **re-run on the first shipped look** that implements the full §3.2
> two-layer palette, and the M3 numbers re-measured there before they are treated as
> evidence about the game.

## 10. Debug & verification

- F3 overlay: fps, frame ms, surfel count, painted count, draw calls, event/s.
- M: top-down orthographic debug view (solids as wireframe, dog route lines, player
  marker) — must visually match `doc/sample-map.md` §1.
- F7: test detonation 12 m ahead of the camera (paints through floors, white flash class)
  — the loudest-flashbulb showcase without dog AI.
- `?autotest`: scripted ~20 s demo (spawn → sprint C with slide+jump → Q-ping → E-ping at
  tank → wait 6 s aging → toggle top-down) driven by synthetic inputs; deterministic seed.
- **Verify script** (`npm run verify`): builds, serves, drives `?autotest` in Playwright
  chromium (executablePath `/opt/pw-browsers/chromium`, try
  `--use-angle=swiftshader-webgl` / `--enable-unsafe-swiftshader` for headless WebGL),
  captures 6 screenshots at keyframes + the top-down view into `verify-out/` (git-
  ignored), asserts: no console errors, canvas not fully black after first ping, surfel
  count within budget. If headless WebGL is genuinely unavailable, the script must say so
  loudly and still assert boot + console cleanliness.
- Vitest: falloff/dither math, LOS wall counting on an authored fixture, cone membership,
  stride emitter distances, energy spend/regen/cooldown, mantle ledge detection fixture,
  event quality formula, map sanity (no overlapping solids where rooms should be, doors
  actually open: raycast through each doorway crosses no solid).

## 11. Milestones (engine implementer, commit each)

1. Scaffold + map data + collision + top-down debug view (M) — screenshot matches plan.
2. Movement verbs + camera energy + stride/landing/slide events + audio steps.
3. Surfel bake + paint pipeline + debug look dots/lines/aging (F7 detonation works).
4. Pings + energy + halo + hands rig + contact shell.
5. Dog + ghosts + props + beacon + stains data (quality on events).
6. Autotest + verify + vitest green + README run instructions + budget check.
```
Done means: `npm run typecheck && npm test && npm run build && npm run verify` all green,
and the six §4 "feels" of `doc/visual-brief.md` are experiencable with the debug look.
```

### 11.1 What milestone 2 hands milestone 3

Contracts M3 (surfels + paint) may build on without re-deriving them. All are pinned by specs.

- **Event ids are monotonic for the life of a bus** — `reset()` clears history, tallies and
  `last`, but never the id counter. Anything keyed by event id (a paint splat, a stain, a de-dup
  cache, later a network ack) stays unambiguous across a run restart, and `fuzzSeed = hash1(id)`
  never replays the same jitter for two different sounds. (`test/events.spec.ts`)
- **`SoundClass` gained `'mantle'`** — see §4.1. `bus.counts.mantle` exists; anything that
  switches exhaustively over the class union must handle it.
- **Emission order inside a fixed step is guaranteed**: verb events (mantle, jump takeoff) →
  landing → stride/slide. A takeoff stamps the pre-move pose; a takeoff and a landing never share
  a step. (§4.1, `test/emitters.spec.ts`)
- **Delivery fields stay neutral at emission.** `wallsToListener = 0`, `distToListener = 0`,
  `quality = 1` are M3's to fill PER LISTENER. If M3 starts computing them inside `emit`, the
  seam has been broken — a co-op bus has many listeners and one emission.
- **Draw the interpolated pose, never the raw one.** `sim.renderPos(out)` blends the previous
  step's pose with the current one by `sim.alpha`; `main.ts` reads it every frame. At `alpha === 0`
  it returns the PREVIOUS pose, which is correct — that is the pose the last completed step
  produced. Any M3 geometry anchored to the player (the contact shell, the halo, self-paint
  origins) must use `renderPos`, or it will swim against the camera at non-60 Hz refresh rates.
  Event ORIGINS are different: they are stamped from `player` inside the step that produced them,
  and are simulation truth, not picture.
- **A `Sim` deep-clones its map def** (`structuredClone` in the constructor). Mutating
  `sim.map` — as the F6 patrol toggle does — touches that Sim's copy only, never the shared
  module constant and never another Sim. M3's bake must read `sim.map`/`sim.world`, not the
  imported `sampleMap`, or two sims will disagree about the world they are painting.
- **The rig is charged the real frame time, once** (`rig.update(dtMs / 1000, …)`), independently
  of how many fixed steps that frame ran. Camera smoothing is therefore refresh-rate independent;
  paint aging should be charged the same way rather than per step.
