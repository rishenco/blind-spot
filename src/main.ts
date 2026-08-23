/**
 * Boot (engine-plan §2).
 *
 * Milestone 3 turns the lights on — or rather, it stops turning them on. The world is baked into
 * a surfel lattice at boot, the black screen is the truth, and every dot you ever see arrives
 * because something made a noise. The boot layer's job is to wire four things that deliberately
 * do not know about each other:
 *
 *   Sim  ──emit──▶  EventBus  ──▶  PaintPipeline (delivery + paint into the shared buffers)
 *                                        └──delivered──▶  AudioEngine · LookHost's stains
 *                                      SurfelField's two geometries ──▶ LookHost ──▶ the screen
 *
 * Audio hangs off the DELIVERED feed rather than off the bus: what you hear and what you see are
 * the same events, filtered by the same gate, computed once (engine-plan §4, §8).
 *
 * Nothing in `core/` imports a look, and no look writes to the sim. The bake and the paint
 * pipeline are attached HERE rather than inside `Sim`, exactly like the audio engine: a Sim is a
 * cheap thing that specs build by the dozen, and a bake is a hundred thousand dots.
 *
 * Keys:  WASD move · Shift sprint · Ctrl/C crouch (slide at speed) · Space jump/mantle
 *        E directed ping (25° cone, 40 m) · Q spatial ping (360°, 12 m)
 *        0/1/2/3 look (0 = debug) · M top-down debug view · F3 stats · F6 dog 2 on the plan
 *        F7 test detonation 12 m ahead · B camera motion · N mute
 * Query: ?look=<debug|phosphor|blueprint|signal>   boot straight into a look (engine-plan §9)
 *        ?topdown   open with the top-down view up (deterministic headless capture)
 *        ?stats     open with the F3 readout up
 *        ?nobob     start with camera motion off — bob, landing dip and slide roll, one
 *                   switch (comfort law, vision §12)
 *        ?flat      reduce-flashing comfort mode (vision §12); also honours the OS setting
 *        ?sim=script  run a scripted movement route instead of reading the keyboard
 *                     (script|script1|corridor, script2|mantle — see core/debug.ts SCRIPTS)
 */

import { PerspectiveCamera, WebGLRenderer } from 'three';
import { AudioEngine } from './core/audio.js';
import { CORE_CONSTANTS, FOV_BASE, MOUSE_SENSITIVITY, SIM_STEP } from './core/const.js';
import { DebugOverlay, SCRIPTS, SCRIPT_ALIASES, ScriptedInput, testDetonation } from './core/debug.js';
import type { SoundEvent } from './core/events.js';
import { yawToThreeRotationY } from './core/math.js';
import { sampleMap } from './core/map/sampleMap.js';
import { CameraRig } from './core/movement.js';
import { PaintPipeline } from './core/paint.js';
import { Sim } from './core/sim.js';
import type { Stance } from './core/sim.js';
import { bakeSurfels, type SurfelField } from './core/surfels.js';
import { LOOK_BY_KEY, LookHost, resolveLookId, type LookId } from './looks/index.js';
import type { LookContext, PlayerView } from './looks/types.js';

const params = new URLSearchParams(window.location.search);

const app = document.getElementById('app');
const hud = document.getElementById('hud') as HTMLDivElement | null;
const overlayRoot = document.getElementById('overlay');
const boot = document.getElementById('boot');
if (!app || !hud || !overlayRoot) throw new Error('boot: #app / #hud / #overlay missing from index.html');

const sim = new Sim(sampleMap);
const debug = new DebugOverlay(overlayRoot, sim);
const rig = new CameraRig();
const audio = new AudioEngine();

// ---------------------------------------------------------------------------------------
// Bake + paint
// ---------------------------------------------------------------------------------------

/**
 * The bake runs synchronously, under the "baking lattice…" boot screen. It is ~200 ms of pure
 * geometry, once, and doing it synchronously keeps `window.blindspot` valid the instant the
 * module finishes — which is what the verify harness (and every console session) relies on.
 *
 * `sim.world` and not the imported `sampleMap`: a Sim deep-clones its map def, and painting the
 * module constant would mean painting a world this Sim does not live in (engine-plan §11.1).
 */
const field: SurfelField = bakeSurfels(sim.world);
const paint = new PaintPipeline(field, sim.world);
// The F3 paint timings are the ONLY wall-clock read in the paint path, and they are a boot-layer
// opt-in for exactly that reason: with `profile` off, nothing in `hear`/`pump` touches
// `performance.now`, which is what lets the determinism specs swap the global clocks out and
// assert zero calls. Nothing here depends on the number — it is a readout, not an input.
paint.profile = true;
paint.attach(sim.bus);
audio.attach(paint);

/**
 * THE LISTENER is the player, and it is set from the SIM pose rather than the interpolated one.
 * Delivery answers "was this event within earshot" — a simulation question, decided inside the
 * step that emitted the sound. The interpolated pose is for the PICTURE (the camera, the contact
 * shell, the halo); using it here would make what you can HEAR depend on your refresh rate.
 *
 * Ears sit at the head, not the feet: `eyeTarget` is the posture's eye offset, which drops when
 * you crouch. A one-metre error would not change much through open air, but it decides which
 * side of a 1.2 m duct lip the listener is on, and that changes the wall count.
 */
function syncListener(): void {
  const p = sim.player;
  paint.setListener(p.x, p.y + sim.movement.eyeTarget, p.z);
}

/**
 * Scripted mode steps the sim a FIXED number of times per frame instead of chasing the wall
 * clock: the route then plays out identically on a 144 Hz desktop and a throttled headless
 * browser, which is the whole point of using it as a verification fixture.
 */
const scriptId = SCRIPT_ALIASES[params.get('sim') ?? ''];
const script = scriptId ? new ScriptedInput(sim, SCRIPTS[scriptId]!) : null;
const SCRIPT_STEPS_PER_FRAME = 4;

// ---------------------------------------------------------------------------------------
// Renderer. Optional: the top-down view is 2D, so a machine without WebGL still boots and
// still verifies. A failure is reported once, loudly, and never again.
// ---------------------------------------------------------------------------------------

const camera = new PerspectiveCamera(FOV_BASE, 1, 0.05, 200);

let renderer: WebGLRenderer | null = null;
try {
  renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  app.appendChild(renderer.domElement);
} catch (err) {
  console.warn('WebGL unavailable — running overlay-only.', err);
}

const renderPos: [number, number, number] = [0, 0, 0];

function syncCamera(): void {
  const p = sim.player;
  // Draw the INTERPOLATED pose, not the raw one (sim.renderPos): the sim is a fixed 60 Hz and
  // the display is whatever it is, so on a fast monitor most frames run no step at all. Look
  // angles come straight from the player — see the note on Sim.prevX about aim latency.
  sim.renderPos(renderPos);
  camera.position.set(renderPos[0], renderPos[1] + rig.eyeOffset, renderPos[2]);
  camera.rotation.set(p.pitch, yawToThreeRotationY(p.yaw), rig.roll, 'YXZ');
  if (Math.abs(camera.fov - rig.fov) > 0.005) {
    camera.fov = rig.fov;
    camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------------------------------
// The look context (engine-plan §9). Built once, shared by every look, mutated in place.
// ---------------------------------------------------------------------------------------

/**
 * The vertical render window (vision §3.6 "within one floor above/below"). "Dock Approach" is a
 * single floor with a trench under it, so the span is set to cover the whole map from anywhere
 * inside it: cutting a one-floor map into thirds would be a rendering bug wearing a law's
 * clothes. The five-floor build sets the centre to the floor the player is on and the span to
 * one floor either side; the uniform is written every frame from today so nothing has to change
 * downstream when it starts moving.
 */
const FLOOR_SPAN = 12.0;

/**
 * The look-facing view of the player (engine-plan §9). The scalars are copied out of
 * `sim.playerSystems` once a frame; the hands rig is the live pose object, shared the same way the
 * surfel geometries are — it is four bones rewritten every step, and a per-frame deep copy would
 * buy nothing the contract's "a look never mutates core state" does not already promise.
 */
const playerView: { -readonly [K in keyof PlayerView]: PlayerView[K] } = {
  pos: renderPos as readonly [number, number, number],
  stance: 'stand' as Stance,
  speed: 0,
  audibleRadius: 0,
  energy: sim.playerSystems.energy,
  energyMax: sim.playerSystems.energyMax,
  hands: sim.playerSystems.hands,
  lastPing: sim.playerSystems.lastPing,
};

const reduceFlashing =
  params.has('flat') ||
  (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/** A `LookContext` the boot layer may write to; looks receive it as the read-only contract. */
type MutableLookContext = { -readonly [K in keyof LookContext]: LookContext[K] };

/**
 * Things the frame loop refreshes after the camera and before the look draws. `dt` is wall-frame
 * elapsed (for render-side smoothers); `now` is the render clock — the interpolated SIM instant
 * this frame depicts, the same value the pump and `uNow` get. Anything that decays in world time
 * uses `now` deltas: a decay charged with wall dt runs at a different rate on a different monitor.
 */
const frameHooks: Array<(dt: number, now: number) => void> = [];

let looks: LookHost | null = null;
const lookId: LookId = resolveLookId(params.get('look'));

if (renderer) {
  const ctx: MutableLookContext = {
    renderer,
    camera,
    surfelGeom: field.geometry,
    edgeGeom: field.edgeGeometry,
    dog: [], // M5
    events: {
      subscribe: (cb) => paint.onDelivered(cb),
      recent: (limit) => paint.recent(limit),
    },
    player: playerView,
    hud,
    constants: CORE_CONSTANTS,
    // THE RENDER CLOCK. Interpolated sim time, so it is smooth at any refresh rate and lives on
    // the same axis as `event.time` — which is what makes `now - paintTime` mean "how long since
    // that sound got here", and a NEGATIVE age mean "it has not got here yet" (the wavefront).
    // It leads the drawn pose by up to one step on purpose: an event emitted in the step that is
    // currently being interpolated must not be stuck at a negative age for a whole frame.
    time: () => sim.time + sim.alpha * SIM_STEP,
    reduceFlashing: () => reduceFlashing,
    floorCentre: 0,
    floorSpan: FLOOR_SPAN,
  };
  looks = new LookHost(ctx, lookId);
  paint.onDelivered((e: SoundEvent) => looks?.onEvent(e));

  /** Per-frame refresh of everything a look reads off the player. */
  const syncLookState = (_dt: number, _now: number): void => {
    const p = sim.player;
    const ps = sim.playerSystems;
    playerView.stance = p.stance;
    playerView.speed = sim.movement.speedXZ;
    playerView.audibleRadius = ps.audibleRadius;
    playerView.energy = ps.energy;
    playerView.energyMax = ps.energyMax;
    playerView.lastPing = ps.lastPing;

    ctx.floorCentre = renderPos[1] + 1.6;
    ctx.floorSpan = FLOOR_SPAN;
  };
  frameHooks.push(syncLookState);
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  renderer?.setSize(w, h, false);
  looks?.resize(w, h);
  debug.resize(w, h);
}

window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------

const held = new Set<string>();

function firstGesture(): void {
  // Autoplay policy: an AudioContext only starts inside a user gesture.
  audio.resume();
}

function readKeyboard(): void {
  const forward = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
  const right = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
  sim.input.forward = forward;
  sim.input.right = right;
  sim.input.sprint = held.has('ShiftLeft') || held.has('ShiftRight');
  sim.input.crouch = held.has('ControlLeft') || held.has('ControlRight') || held.has('KeyC');
}

window.addEventListener('keydown', (e) => {
  firstGesture();
  if (e.repeat) return;
  held.add(e.code);

  // Engine-plan §9 owns the number row: 0 is the debug look, 1/2/3 the authored directions.
  // (Audio mute moved to N when the looks arrived — the switch protocol is the fixed contract.)
  const look = LOOK_BY_KEY[e.code];
  if (look) {
    looks?.switchTo(look);
    e.preventDefault();
    return;
  }

  switch (e.code) {
    case 'Space':
      sim.input.jumpPressed = true;
      e.preventDefault();
      break;
    // Latched, not fired here: a ping must leave from inside a fixed step, stamped with that
    // step's clock and aimed by that step's pose (core/player.ts `PlayerIntent`).
    case 'KeyE':
      sim.playerSystems.intent.pingE = true;
      break;
    case 'KeyQ':
      sim.playerSystems.intent.pingQ = true;
      break;
    case 'KeyM':
      debug.toggleTopDown();
      e.preventDefault();
      break;
    case 'F3':
      debug.toggleStats();
      e.preventDefault();
      break;
    case 'F6':
      debug.toggleDog2();
      e.preventDefault();
      break;
    case 'F7':
      testDetonation(sim);
      e.preventDefault();
      break;
    case 'KeyB':
      rig.motionEffects = !rig.motionEffects;
      break;
    case 'KeyN':
      audio.toggleMute();
      break;
    default:
      break;
  }
});

window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear());

app.addEventListener('pointerdown', () => {
  firstGesture();
  if (!document.pointerLockElement) void app.requestPointerLock();
});

window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== app) return;
  // Yaw 0 == +x increasing toward +z, so a rightward mouse move is +yaw. Pitch is inverted:
  // screen-space "up" is a negative movementY.
  sim.input.yawDelta += e.movementX * MOUSE_SENSITIVITY;
  sim.input.pitchDelta -= e.movementY * MOUSE_SENSITIVITY;
});

// ---------------------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------------------

let last = performance.now();
/** Rolling event rate for the F3 panel (engine-plan §10 "event/s"). */
let evAcc = 0;
let evLast = 0;
let evRate = 0;

function frame(now: number): void {
  const dtMs = Math.min(250, now - last);
  last = now;
  const dt = dtMs / 1000;

  if (script) {
    for (let i = 0; i < SCRIPT_STEPS_PER_FRAME; i++) {
      script.sync();
      syncListener();
      sim.step(SIM_STEP);
    }
  } else {
    readKeyboard();
    syncListener();
    sim.advance(dt);
  }

  // The rig is a RENDER-side smoother, so it is charged with real elapsed time, every frame,
  // whether or not a sim step ran. Charging it with the sim time consumed instead double-counted
  // on catch-up frames and starved it on fast ones: at 144 Hz it was fed 6.60 s over 4.17 s of
  // wall clock, which is why the landing dip was 8x weaker there than at 60 Hz. Smoothers are
  // wall-clock things; only the sim is allowed to care about the fixed step.
  rig.update(dt, sim.movement);
  syncCamera();
  // The hum is the audible half of the halo (vision §3.8) and the only sound not triggered by an
  // event, so it is steered here, from the same number the ring's brightness reads.
  audio.setHalo(sim.playerSystems.audibleRadius);

  // The render clock: the interpolated instant this frame is actually depicting. The frame hooks,
  // the pump, the look and the shaders' `uNow` must all read the SAME value, or a surfel could be
  // drawn on the frame before the one that painted it. Hoisted above the hooks because anything
  // that decays in SIM time (the halo) has to bleed on this axis, not on wall-frame dt.
  const nowRender = sim.time + sim.alpha * SIM_STEP;
  for (const hook of frameHooks) hook(dt, nowRender);

  // Travelling sounds (pings, detonations) are released over the frames their own wavefront takes
  // to cross the room: everything the wave has reached by `nowRender` is painted here, and nothing
  // ahead of it is written at all. See `PaintPipeline.pump`.
  paint.pump(nowRender);
  // One upload per frame, not one per event: a frame that ran four steps and painted eight
  // sounds hands the GPU a single merged set of ranges.
  paint.flush();
  looks?.update(nowRender, dt);
  looks?.render();

  evAcc += dtMs;
  if (evAcc >= 500) {
    evRate = ((sim.bus.emitted - evLast) * 1000) / evAcc;
    evLast = sim.bus.emitted;
    evAcc = 0;
  }
  debug.update(dtMs);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------------------
// F3 extras (engine-plan §10: surfel count, painted count, draw calls, event/s)
// ---------------------------------------------------------------------------------------

debug.extraLines = () => {
  const c = field.counts;
  const ps = sim.playerSystems;
  const calls = renderer ? renderer.info.render.calls : 0;
  return [
    `surfels    ${c.surfels} dots  ${c.edges} edges (${c.holds} holds)  ${c.patches} patches`,
    `painted    ${field.paintedDots} dots  ${field.paintedEdgeVerts} edge verts   bake ${c.ms.toFixed(0)} ms`,
    `paint      ${paint.lastMs.toFixed(2)} ms/frame  worst ${paint.maxMs.toFixed(2)} ms` +
      `  pending ${paint.pendingPatches}  heard ${paint.heard} missed ${paint.missed}`,
    `render     ${calls} draw calls  ${evRate.toFixed(1)} event/s  look ${looks ? looks.id : 'none'}`,
    `halo       ${ps.audibleRadius.toFixed(1)} m audible   energy ${ps.energy.toFixed(0)}/${ps.energyMax}` +
      `   hands ${ps.hands.state} ${ps.hands.phase.toFixed(2)}`,
  ];
};

if (params.has('topdown')) debug.setTopDown(true);
if (params.has('stats')) debug.toggleStats();
if (params.has('nobob')) rig.motionEffects = false;

boot?.classList.add('hidden');
syncCamera();
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------------------
// Handy for the verify script and the browser console.
// ---------------------------------------------------------------------------------------

/**
 * Ink coverage of the FIRST-PERSON canvas, read straight out of the drawing buffer.
 *
 * A screenshot proves a file was written, not that anything was DRAWN. This renders and reads
 * back in the same task (a WebGL drawing buffer is undefined the moment you yield) and reports
 * three thresholds, because this renderer has three legitimately different brightnesses:
 *
 *   `any`   — anything at all above black; catches the 2 m contact shell, which is nearly invisible.
 *   `lit`   — actual paint.
 *   `white` — SATURATED paint: every channel pinned at the top. This one is a failure measure, not
 *             a success one. Vision §12 says "visual porridge must be structurally impossible" and
 *             §3.2 puts every depth cue inside the cyan band — a saturated pixel has thrown its
 *             depth cue away, and a field of them is the porridge. Verify asserts it stays small.
 *
 * A COVERAGE FRACTION CANNOT TELL A CLOUD FROM A SHEET. A frame of separate saturated dots and a
 * frame with one saturated rectangle can read the same percentage, and only the second one has
 * lost the near-field read (visual-brief §2 "dots stay dots"). So the white pixels are also
 * measured structurally: `whiteBlob` is the largest connected run of them, which is one dot's
 * area while the near field is a cloud and grows without bound the moment splats fuse.
 *
 * `rect` restricts the count to a fraction of the frame, given as [x, y, w, h] in 0..1 with the
 * origin at the BOTTOM-LEFT (readPixels' own origin, not the screenshot's). A whole-frame fraction
 * cannot tell where the ink is, and one of the things worth asserting — that the contact shell is
 * measured from the body and not the eye (vision §3.1) — is a claim about exactly that.
 */
const WHITE_LEVEL = 250;

interface InkReport {
  lit: number;
  any: number;
  white: number;
  /** Saturated pixels as a raw count, and the largest connected run of them. Both in pixels. */
  whitePx: number;
  whiteBlob: number;
  width: number;
  height: number;
}

// Reused across calls: the per-frame allocation would otherwise be megabytes of garbage on every
// sampled frame, which is exactly the frames a peak measurement wants to be cheap on.
let blobMask = new Uint8Array(0);
let blobStack = new Int32Array(0);

/**
 * Largest 4-connected run of saturated pixels in `blobMask`, in pixels. Consumes the mask.
 *
 * FOUR-connected on purpose: two round splats that meet only at a corner are still two splats, and
 * counting them as one would make the measure drift upward with density rather than with fusion.
 * A sheet is solid, so it is caught either way.
 */
function largestWhiteBlob(w: number, h: number): number {
  const mask = blobMask;
  const n = w * h;
  if (blobStack.length < n) blobStack = new Int32Array(n);
  const stack = blobStack;
  let best = 0;
  for (let seed = 0; seed < n; seed++) {
    if (mask[seed] !== 1) continue;
    mask[seed] = 2;
    let top = 0;
    stack[top++] = seed;
    let size = 0;
    while (top > 0) {
      const i = stack[--top]!;
      size++;
      const x = i % w;
      if (x > 0 && mask[i - 1] === 1) {
        mask[i - 1] = 2;
        stack[top++] = i - 1;
      }
      if (x < w - 1 && mask[i + 1] === 1) {
        mask[i + 1] = 2;
        stack[top++] = i + 1;
      }
      if (i >= w && mask[i - w] === 1) {
        mask[i - w] = 2;
        stack[top++] = i - w;
      }
      if (i + w < n && mask[i + w] === 1) {
        mask[i + w] = 2;
        stack[top++] = i + w;
      }
    }
    if (size > best) best = size;
  }
  return best;
}

function measureInk(rect?: readonly [number, number, number, number]): InkReport {
  if (!renderer || !looks) return { lit: 0, any: 0, white: 0, whitePx: 0, whiteBlob: 0, width: 0, height: 0 };
  looks.render();
  const gl = renderer.getContext();
  const bw = gl.drawingBufferWidth;
  const bh = gl.drawingBufferHeight;
  const x = rect ? Math.max(0, Math.min(bw - 1, Math.round(rect[0] * bw))) : 0;
  const y = rect ? Math.max(0, Math.min(bh - 1, Math.round(rect[1] * bh))) : 0;
  const w = rect ? Math.max(1, Math.min(bw - x, Math.round(rect[2] * bw))) : bw;
  const h = rect ? Math.max(1, Math.min(bh - y, Math.round(rect[3] * bh))) : bh;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const n = w * h;
  if (blobMask.length < n) blobMask = new Uint8Array(n);
  let lit = 0;
  let any = 0;
  let white = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    const sum = r + g + b;
    if (sum > 60) lit++;
    if (sum > 8) any++;
    const sat = r >= WHITE_LEVEL && g >= WHITE_LEVEL && b >= WHITE_LEVEL;
    blobMask[p] = sat ? 1 : 0;
    if (sat) white++;
  }
  return {
    lit: lit / n,
    any: any / n,
    white: white / n,
    whitePx: white,
    whiteBlob: white === 0 ? 0 : largestWhiteBlob(w, h),
    width: w,
    height: h,
  };
}

declare global {
  interface Window {
    blindspot?: {
      sim: Sim;
      debug: DebugOverlay;
      rig: CameraRig;
      audio: AudioEngine;
      script: ScriptedInput | null;
      field: SurfelField;
      paint: PaintPipeline;
      looks: LookHost | null;
      detonate: (distance?: number) => SoundEvent;
      ink: (rect?: readonly [number, number, number, number]) => InkReport;
      stats: () => Record<string, number | string>;
    };
  }
}

window.blindspot = {
  sim,
  debug,
  rig,
  audio,
  script,
  field,
  paint,
  looks,
  detonate: (distance?: number) => testDetonation(sim, distance),
  ink: measureInk,
  stats: () => {
    const c = field.counts;
    const f = debug.frameStats;
    return {
      surfels: c.surfels,
      edges: c.edges,
      holds: c.holds,
      patches: c.patches,
      bakeMs: c.ms,
      paintedDots: field.paintedDots,
      paintedEdgeVerts: field.paintedEdgeVerts,
      paintLastMs: paint.lastMs,
      paintMaxMs: paint.maxMs,
      paintPending: paint.pendingPatches,
      heard: paint.heard,
      missed: paint.missed,
      drawCalls: renderer ? renderer.info.render.calls : 0,
      fps: f.fps,
      frameMs: f.frameMs,
      eventRate: evRate,
      look: looks ? looks.id : 'none',
      audibleRadius: sim.playerSystems.audibleRadius,
      energy: sim.playerSystems.energy,
      handsState: sim.playerSystems.hands.state,
      handsPhase: sim.playerSystems.hands.phase,
    };
  },
};
