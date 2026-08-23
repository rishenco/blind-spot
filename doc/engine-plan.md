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
   event's stable fuzz vector (±2 m, seeded per event). ≥2 walls → nothing. (vision §3.4)
3. Per surfel in surviving patches: `d = dist(surfel, effectiveOrigin)`;
   `I = intensity × clamp01(1 − (d/R)²)` (quadratic falloff to zero at radius R).
   Light the surfel iff `I ≥ surfel.dither × DITHER_GAIN` — intensity = coverage density,
   stable per lattice point (visual-brief §2).
4. `delay = d / waveSpeed(class)` (0 for instant classes). Write
   `paintTime = event.time + delay`, `paintIntensity = max(I, old × 0.85)`.
   The shader derives everything else from `now − paintTime` (rim at small age, cooling,
   thinning: a surfel drops out when its age-alpha × intensity falls below its dither
   band — same dots drop first, oldest look thins to edges).
5. Normal-facing check: skip surfels whose normal faces away from the effective origin
   (dot < 0) — sound paints the face it hits.

**Contact shell:** shader-side, always-on: surfels within 2 m of the camera get a faint
floor alpha (≈0.05) regardless of paint (vision §3.1). No other unpainted visibility.

## 4. Sound events

```ts
type SoundClass = 'crouchStep'|'walkStep'|'sprintStep'|'landing'|'slide'|'propKnock'|
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
step-up ≤ 0.35.

## 6. Player systems

- **Energy:** cap 100, regen 6/s, E-ping 18, Q-ping 10, sprint drain 1/s. Empty blocks
  pings only. (vision §4)
- **Pings:** shared 0.75 s cooldown. E: cone 25°, 40 m. Q: sphere 12 m. Both emit their
  own hearable event (E hearable at both ends — implement as second virtual event at beam
  impact center, hear 30 m, once the front arrives; paints nothing extra).
- **Halo model:** `audibleRadius(t)` = smoothed max over the last 1.2 s of self-emitted
  hearRadius, decaying; drives reticle ring brightness (looks) and hum pitch (audio).
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
