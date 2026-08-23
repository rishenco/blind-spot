/**
 * The fixed-step sim and the frame loop that drives it (main.ts, sim.ts, engine-plan §3).
 *
 * Contract under test:
 *   engine-plan §3  the sim is a fixed 60 Hz step with an accumulator; the renderer runs free.
 *   sim.ts          `alpha` — "Fraction of a step left over, for render-side interpolation";
 *                   `renderPos()` — "Where the body should be DRAWN this frame… Every renderer
 *                   reads this, never `player.x/y/z`."
 *   vision §12      "Comfort floor: … no motion blur"; and vision §5, "movement stays genuinely
 *                   good" — a camera that stutters at 144 Hz is the one thing a parkour game
 *                   cannot ship with.
 *   visual-brief §1.8  the rig's decay rates (EYE_SMOOTH, FOV_SMOOTH, LANDING_DIP_DECAY,
 *                   TILT_SMOOTH) are all per-SECOND, so feeding it the wrong dt is not cosmetic.
 *   math.ts         "No Math.random() anywhere in the engine — every stochastic thing is seeded."
 *   engine-plan §11 co-op needs a transport, not a rewrite — which is a determinism claim.
 *
 * These probes replicate main.ts's loop expression exactly rather than importing it — main.ts
 * touches `document`, `window` and WebGL on import and cannot run in node.
 *
 * Three review findings live here:
 *   B5  the rig was charged `simDt || dtMs/1000`, so on the frames the accumulator did not spill
 *       it was charged the raw frame time AND then again inside the next frame's simDt: a
 *       refresh-rate-dependent camera. Ruled fix: charge `dtMs / 1000` always, delete the `||`.
 *   S1  `alpha` was computed for render interpolation and read by nothing, so a 144 Hz display
 *       showed 60 Hz judder. Ruled fix: a prev-pose snapshot in the sim, blended by `alpha`.
 *   N3  `new Sim(map)` aliased the caller's map def, making `sampleMap` a live singleton every
 *       run wrote through. Ruled fix: deep-clone at the door.
 */

import { describe, expect, it } from 'vitest';
import { COYOTE_TIME, SIM_MAX_STEPS, SIM_STEP } from '../src/core/const.js';
import type { SoundEvent } from '../src/core/events.js';
import { CameraRig, type MoveInput } from '../src/core/movement.js';
import { Sim } from '../src/core/sim.js';
import { buildWorld } from '../src/core/map/build.js';
import { sampleMap } from '../src/core/map/sampleMap.js';
import type { MapDef, Solid } from '../src/core/map/types.js';
import { PaintPipeline } from '../src/core/paint.js';
import { bakeSurfels } from '../src/core/surfels.js';

const box = (
  id: string,
  kind: Solid['kind'],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): Solid => ({ type: 'box', id, kind, min: [x0, y0, z0], max: [x1, y1, z1] });

const gym: MapDef = {
  name: 'frame-loop gym',
  solids: [box('floor', 'floor', 0, -1, 0, 200, 0, 200)],
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [10, 0, 10], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [200, 16, 200] }],
  markers: [],
  bounds: { min: [0, -1, 0], max: [200, 16, 200] },
};

const NEUTRAL: MoveInput = {
  forward: 0,
  right: 0,
  jumpPressed: false,
  crouch: false,
  sprint: false,
  yawDelta: 0,
  pitchDelta: 0,
};

const steps = (s: number): number => Math.round(s / SIM_STEP);

/**
 * One frame of main.ts's loop, verbatim in its arithmetic:
 *
 *     sim.advance(dtMs / 1000);
 *     rig.update(dtMs / 1000, sim.movement);
 *     syncCamera();                 // draws sim.renderPos(), not player.x/y/z
 *
 * Returns what the rig was actually charged for this frame.
 */
function mainFrame(sim: Sim, rig: CameraRig, dtMs: number, patch: Partial<MoveInput>): number {
  Object.assign(sim.input, NEUTRAL, patch);
  const dt = dtMs / 1000;
  sim.advance(dt);
  rig.update(dt, sim.movement);
  return dt;
}

function fresh(): { sim: Sim; rig: CameraRig } {
  const sim = new Sim(gym);
  const rig = new CameraRig();
  const p = sim.player;
  p.x = 10;
  p.y = 0;
  p.z = 10;
  p.grounded = true;
  p.stance = 'stand';
  sim.movement.apexY = 0;
  sim.movement.coyote = COYOTE_TIME;
  return { sim, rig };
}

/** Run `frames` frames at a steady refresh and report how the two clocks diverge. */
function run(hz: number, frames: number, patch: Partial<MoveInput> = { forward: 1, sprint: true }) {
  const { sim, rig } = fresh();
  const dtMs = 1000 / hz;
  let charged = 0;
  let zeroStepFrames = 0;
  // `syncCamera()` draws `sim.renderPos()`, so THAT is the pose under test — the raw p.x/p.z is
  // the simulation's truth at 60 Hz, not the picture.
  const drawn: [number, number, number] = [0, 0, 0];
  let poseChanges = 0;
  // The first frames out of a standing start genuinely do not move the body, and a stationary
  // body is supposed to draw a stationary picture — so the pose tally starts after the run does.
  const WARM = 10;
  sim.renderPos(drawn);
  let lastX = drawn[0];
  let lastZ = drawn[2];
  for (let i = 0; i < frames; i++) {
    const before = sim.time;
    charged += mainFrame(sim, rig, dtMs, patch);
    if (sim.time === before) zeroStepFrames++;
    sim.renderPos(drawn);
    if (i >= WARM && (drawn[0] !== lastX || drawn[2] !== lastZ)) poseChanges++;
    lastX = drawn[0];
    lastZ = drawn[2];
  }
  return {
    sim,
    rig,
    charged,
    zeroStepFrames,
    poseChanges,
    measured: frames - WARM,
    wall: (frames * dtMs) / 1000,
  };
}

// ==========================================================================================
// The rig is charged frame time, exactly once (review finding B5)
// ==========================================================================================

describe('the render clock and the sim clock are charged independently and honestly', () => {
  /**
   * B5. The loop used to read `rig.update(simDt || dtMs / 1000, …)`, where
   * `simDt = sim.advance(...) * SIM_STEP`. `simDt` is 0 on any frame whose leftover accumulator
   * did not reach one whole 1/60 s step — at 144 Hz that is more than half of all frames. On those
   * frames the `||` fell through to the RAW FRAME TIME, and then that same wall time was charged
   * AGAIN as part of the next frame's `simDt` when the accumulator finally spilled. Every rate the
   * rig applies is per-second, so the result was a refresh-rate-dependent camera: eye height, FOV
   * kick, landing dip and slide tilt all settled ~1.6x faster on a 144 Hz monitor.
   *
   * The rig is a render-side smoother. It wants FRAME time, always, and the `||` is gone.
   */
  it('charges the rig the wall clock exactly once at 144 Hz', () => {
    const r = run(144, 600);
    expect(r.zeroStepFrames, 'the 144 Hz loop really does skip steps').toBeGreaterThan(300);
    expect(
      r.charged,
      `sim advanced ${r.sim.time.toFixed(4)} s, rig charged ${r.charged.toFixed(4)} s over ${r.wall.toFixed(4)} s of wall clock`,
    ).toBeCloseTo(r.wall, 9);
  });

  it('the rig clock tracks the sim clock to within the un-spilled accumulator', () => {
    // The two clocks are not identical and are not meant to be: the sim only moves in whole
    // 1/60 s steps, so at any instant it lags the wall clock by whatever is still in the
    // accumulator. That leftover IS `alpha * SIM_STEP`, and it is the entire difference.
    for (const hz of [60, 75, 144, 240]) {
      const r = run(hz, 600);
      const excess = r.charged - r.sim.time;
      expect(excess, `${hz} Hz: excess ${excess.toFixed(6)} s`).toBeGreaterThanOrEqual(-1e-9);
      expect(excess, `${hz} Hz: excess ${excess.toFixed(6)} s`).toBeLessThan(SIM_STEP);
      expect(excess, `${hz} Hz`).toBeCloseTo(r.sim.alpha * SIM_STEP, 9);
    }
  });

  it('the camera settles identically at 60 and 144 Hz', () => {
    // Same 0.5 s of wall clock, same input, two refresh rates. A landing dip is the clearest
    // read because LANDING_DIP_DECAY is a pure per-second exponential with no sim coupling.
    const dipAt = (hz: number): number => {
      const { sim, rig } = fresh();
      sim.player.y = 8;
      sim.player.grounded = false;
      sim.player.stance = 'air';
      sim.movement.apexY = 8;
      const dtMs = 1000 / hz;
      // Fall to the deck first, at a rate that steps every frame so both start identically.
      for (let i = 0; i < 240 && !sim.player.grounded; i++) mainFrame(sim, rig, 1000 / 60, {});
      const peak = rig.dip;
      expect(peak).toBeGreaterThan(0.05);
      for (let i = 0; i < Math.round(0.5 * hz); i++) mainFrame(sim, rig, dtMs, {});
      return rig.dip;
    };
    const a = dipAt(60);
    const b = dipAt(144);
    expect(b, `dip after 0.5 s: 60 Hz ${a.toFixed(5)} m, 144 Hz ${b.toFixed(5)} m`).toBeCloseTo(a, 4);
  });
});

// ==========================================================================================
// alpha is consumed: the drawn pose moves every frame (review finding S1)
// ==========================================================================================

describe('the drawn pose is interpolated by sim.alpha (sim.renderPos)', () => {
  /**
   * S1. `alpha` was documented as "for render-side interpolation" and read by nothing: the camera
   * was set straight from the raw `p.x / p.y / p.z`. On a 144 Hz display the world therefore held
   * still for one or two frames and then jumped a whole 1/60 s of motion — at SPEED_SPRINT a 10 cm
   * hitch, sixty times a second, in a game whose whole promise is that movement feels good.
   *
   * The sim now snapshots the pose at the top of each step and `renderPos()` blends prev→current
   * by `alpha`, which is what `syncCamera()` draws.
   */
  it('the camera pose advances on every frame at 144 Hz', () => {
    const r = run(144, 600);
    expect(
      r.poseChanges,
      `camera pose changed on ${r.poseChanges}/${r.measured} frames (${r.zeroStepFrames} zero-step frames)`,
    ).toBe(r.measured);
  });

  it('a frame that runs no step still moves the picture', () => {
    const { sim, rig } = fresh();
    for (let i = 0; i < 60; i++) mainFrame(sim, rig, 1000 / 60, { forward: 1, sprint: true });
    const a0 = sim.alpha;
    const x0 = sim.renderPos()[0];
    const rawX = sim.player.x;
    const t0 = sim.time;
    mainFrame(sim, rig, 2, { forward: 1, sprint: true }); // 2 ms — cannot fill a 16.67 ms step
    expect(sim.time, 'the sim really did not step').toBe(t0);
    expect(sim.player.x, 'and the raw pose really did not move').toBe(rawX);
    expect(sim.alpha, 'alpha really did move').toBeGreaterThan(a0);
    expect(sim.alpha).toBeLessThan(1);
    expect(sim.renderPos()[0], 'the drawn pose followed alpha').not.toBe(x0);
  });

  it('never extrapolates: the drawn pose stays between the two poses the sim produced', () => {
    const { sim, rig } = fresh();
    const drawn: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 400; i++) {
      // A jittery refresh, so alpha lands everywhere in [0, 1).
      mainFrame(sim, rig, [3, 17, 7, 21, 11][i % 5]!, { forward: 1, sprint: true });
      sim.renderPos(drawn);
      expect(sim.alpha).toBeGreaterThanOrEqual(0);
      expect(drawn[0]).toBeLessThanOrEqual(sim.player.x + 1e-9);
      expect(Math.abs(drawn[1] - sim.player.y)).toBeLessThan(1e-3); // flat floor: nothing to blend
    }
    // …and the blend spans exactly the two poses the sim produced and no further: alpha 0 draws
    // the earlier one, alpha ~1 the later one. Nothing is ever drawn outside that segment, which
    // is what makes this interpolation and not prediction (vision §3.7 says the same about ghosts:
    // "never interpolated, never predicted by the renderer").
    const { sim: clean } = fresh();
    Object.assign(clean.input, NEUTRAL, { forward: 1, sprint: true });
    for (let i = 0; i < 30; i++) clean.step(SIM_STEP);
    const earlier = clean.player.x;
    clean.step(SIM_STEP);
    const later = clean.player.x;
    expect(later).toBeGreaterThan(earlier);
    expect(clean.alpha).toBe(0);
    expect(clean.renderPos()[0]).toBe(earlier);
    clean.advance(SIM_STEP * 0.999); // fill the accumulator without spilling it
    expect(clean.alpha).toBeCloseTo(0.999, 6);
    expect(clean.player.x, 'still no step').toBe(later);
    expect(clean.renderPos()[0]).toBeCloseTo(later, 3);
  });

  it('is inert when the sim has not stepped at all', () => {
    // Frame 0: prev and current are the same pose, so alpha cannot manufacture motion.
    const { sim } = fresh();
    const p = sim.renderPos();
    expect(p).toEqual([sim.player.x, sim.player.y, sim.player.z]);
  });
});

// ==========================================================================================
// The accumulator itself
// ==========================================================================================

describe('the fixed-step accumulator (engine-plan §3)', () => {
  it('agrees with the rig exactly at 60 Hz, the rate the loop was tuned at', () => {
    const r = run(60, 600);
    expect(r.zeroStepFrames).toBe(0);
    expect(r.charged).toBeCloseTo(r.sim.time, 9);
    expect(r.charged).toBeCloseTo(r.wall, 9);
    expect(r.poseChanges).toBe(r.measured);
  });

  it('clamps a runaway catch-up to SIM_MAX_STEPS instead of spiralling', () => {
    const { sim } = fresh();
    // A 10 s stall (tab backgrounded). Uncapped this is 600 steps in one frame.
    const stepped = sim.advance(10);
    expect(stepped).toBe(SIM_MAX_STEPS);
    expect(sim.time).toBeCloseTo(SIM_MAX_STEPS * SIM_STEP, 9);
    // …and the leftover is dropped rather than banked, so the next frame is not also 5 steps.
    expect(sim.advance(1 / 60)).toBeLessThanOrEqual(1);
  });

  it('never partially applies a step: sim.time is always an exact multiple of SIM_STEP', () => {
    const { sim, rig } = fresh();
    for (const dtMs of [3, 7, 16.7, 1, 40, 8.3, 250, 11, 16.7, 16.7]) {
      mainFrame(sim, rig, dtMs, { forward: 1 });
      const q = sim.time / SIM_STEP;
      expect(Math.abs(q - Math.round(q)), `after ${dtMs} ms`).toBeLessThan(1e-9);
    }
  });

  it('drops input edges the same way regardless of how many steps a frame carries', () => {
    // `jumpPressed` is an edge the sim consumes; a 5-step catch-up frame must not jump 5 times.
    const { sim } = fresh();
    Object.assign(sim.input, NEUTRAL, { jumpPressed: true });
    sim.advance(5 / 60);
    expect(sim.player.vy).toBeGreaterThan(0);
    expect(sim.bus.counts.landing).toBe(0);
    // One takeoff, not five: vy is a single jump impulse, not a stack of them, and exactly one
    // takeoff event was published for it (review finding B2b).
    const single = new Sim(gym);
    single.player.grounded = true;
    single.movement.coyote = COYOTE_TIME;
    Object.assign(single.input, NEUTRAL, { jumpPressed: true });
    single.step(SIM_STEP);
    expect(sim.player.vy).toBeLessThanOrEqual(single.player.vy + 1e-9);
    expect(sim.bus.counts.walkStep + sim.bus.counts.sprintStep).toBe(1);
  });
});

// ==========================================================================================
// A Sim owns its map (review finding N3)
// ==========================================================================================

describe('a Sim owns its map definition', () => {
  /**
   * N3. `new Sim(sampleMap)` stored the caller's object by reference, so `sim.map` WAS the
   * module-level `sampleMap`, sharing the same `dogRoutes` array and the same route objects.
   * `debug.ts`'s `toggleDog2` (F6) does `route.defaultOn = !route.defaultOn` on it. Today that is
   * a debug flag; the moment vision §11's per-run randomisation ("dog patrols, cell placement,
   * cache and trap arming randomized per run") writes into the map def, the second run of a
   * session starts from the first run's leftovers.
   *
   * The Sim constructor deep-clones the def. The F6 round trip itself is proven end to end in
   * `scripts/verify.mjs` (DebugOverlay needs a DOM, and no jsdom is installed here).
   */
  it('each Sim gets its own object graph, all the way down', () => {
    const a = new Sim(sampleMap);
    const b = new Sim(sampleMap);
    expect(a.map).not.toBe(sampleMap);
    expect(b.map.dogRoutes).not.toBe(a.map.dogRoutes);
    expect(b.map.dogRoutes[0]).not.toBe(a.map.dogRoutes[0]);
    expect(a.map.solids[0]).not.toBe(sampleMap.solids[0]);
    // …and it is a faithful copy, not a reshaped one.
    expect(a.map).toEqual(sampleMap);
  });

  it('a write through one Sim is invisible to the next, and to the module singleton', () => {
    // This is exactly the write `debug.ts`'s F6 handler performs.
    const a = new Sim(sampleMap);
    const route = a.map.dogRoutes.find((r) => r.id === 'dog2');
    expect(route, 'sampleMap still has a dog2 route').toBeDefined();
    const original = route!.defaultOn;
    route!.defaultOn = !original;
    const b = new Sim(sampleMap);
    expect(b.map.dogRoutes.find((r) => r.id === 'dog2')!.defaultOn).toBe(original);
    expect(sampleMap.dogRoutes.find((r) => r.id === 'dog2')!.defaultOn).toBe(original);
  });
});

// ==========================================================================================
// Determinism — the property every later milestone borrows
// ==========================================================================================

/** A route with every verb in it: sprint, turn, jump, slide, crouch, drop. */
const SCRIPT: Array<[number, Partial<MoveInput>]> = [
  [1.2, { forward: 1, sprint: true }],
  [0.4, { forward: 1, sprint: true, yawDelta: 0.02 }],
  [0.6, { forward: 1, sprint: true, crouch: true }],
  [0.1, { forward: 1, sprint: true, jumpPressed: true }],
  [0.8, { forward: 1, right: 0.6, sprint: true }],
  [0.5, { forward: 1, crouch: true }],
  [0.9, { forward: 1 }],
  [0.3, { forward: -1, sprint: true }],
  [0.6, {}],
];

interface Trace {
  end: number[];
  events: Array<[number, string, number, number, number, number]>;
  counts: Record<string, number>;
  /** Dots the attached paint pipeline lit, or 0 when the trace ran without one. */
  painted: number;
}

/**
 * The shipped world and its surfel field, baked ONCE at module scope.
 *
 * The bake belongs outside `trace()` for two reasons: it is load-time work rather than frame
 * work, and the clock-swap spec below must not measure it — what that spec is about is the
 * per-frame path, which in a real client is sim.step + paint.hear + paint.pump + paint.flush.
 */
const paintWorld = buildWorld(sampleMap);
const paintField = bakeSurfels(paintWorld);

/**
 * Run the script. With `withPaint`, the full client frame is traced instead of the sim alone:
 * a `PaintPipeline` follows the bus, hears every footstep the script makes, and is pumped and
 * flushed once per step with the sim's own clock — the same order `main.ts` uses.
 */
function trace(withPaint = false): Trace {
  const sim = new Sim(sampleMap);
  const p = sim.player;
  let paint: PaintPipeline | null = null;
  if (withPaint) {
    paintField.resetPaint();
    paint = new PaintPipeline(paintField, paintWorld);
    paint.profile = false;
    paint.attach(sim.bus);
  }
  // The shipped spawn, turned down the long open lane rather than into the near wall.
  p.x = sampleMap.spawn.pos[0];
  p.y = sampleMap.spawn.pos[1];
  p.z = sampleMap.spawn.pos[2];
  p.yaw = Math.PI / 2;
  p.grounded = true;
  sim.movement.apexY = 0;
  sim.movement.coyote = COYOTE_TIME;
  const events: Trace['events'] = [];
  sim.bus.on((e: SoundEvent) =>
    events.push([e.time, e.class, e.origin[0], e.origin[1], e.origin[2], e.fuzzSeed]),
  );
  for (const [secs, patch] of SCRIPT) {
    for (let i = 0; i < steps(secs); i++) {
      Object.assign(sim.input, NEUTRAL, patch);
      paint?.setListener(p.x, p.y + 1.6, p.z);
      sim.step(SIM_STEP);
      if (paint) {
        paint.pump(sim.time);
        paint.flush();
      }
    }
  }
  const painted = paint ? paintField.paintedDots : 0;
  paint?.dispose();
  return {
    end: [p.x, p.y, p.z, p.yaw, p.pitch, p.vx, p.vy, p.vz],
    events,
    counts: { ...sim.bus.counts } as unknown as Record<string, number>,
    painted,
  };
}

describe('the sim is reproducible bit-for-bit', () => {
  it('two Sims running one script in one process end in byte-identical states', () => {
    const a = trace();
    const b = trace();
    expect(b.end).toEqual(a.end);
    expect(b.counts).toEqual(a.counts);
    expect(b.events.length).toBe(a.events.length);
    expect(b.events).toEqual(a.events);
    expect(a.events.length, 'the script really did make noise').toBeGreaterThan(10);
  });

  it('a replayed script reproduces the same fuzzSeeds, so M3 paint will land in the same place', () => {
    const a = trace();
    const b = trace();
    const seeds = (t: Trace): number[] => t.events.map((e) => e[5]);
    expect(seeds(b)).toEqual(seeds(a));
    expect(new Set(seeds(a)).size, 'and the seeds are not all one value').toBeGreaterThan(5);
  });

  it('no wall clock and no unseeded randomness anywhere the sim OR paint can reach', () => {
    // Stronger than grepping the source: take the global clocks and the RNG away and watch. The
    // whole trace is synchronous, so nothing but the frame runs between the swap and the restore.
    //
    // R5: the traced frame is the WHOLE frame — a PaintPipeline follows the sim's bus, so this
    // covers hear() and pump() as well as movement. `pump` used to read `performance.now` on
    // every call regardless of the `profile` flag (it was the work-ahead pass's deadline), and
    // this spec could not see it because `trace()` built a bare Sim. Profiling is the only clock
    // read on the paint path now, and it is off by default; the bake happens at module scope, so
    // what is measured here is the per-frame path and nothing else.
    const realRandom = Math.random;
    const realDateNow = Date.now;
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    const realPerfNow = perf?.now;
    let random = 0;
    let dateNow = 0;
    let perfNow = 0;
    let painted = 0;
    try {
      Math.random = () => {
        random++;
        return 0.5;
      };
      Date.now = () => {
        dateNow++;
        return 0;
      };
      if (perf && realPerfNow) {
        perf.now = () => {
          perfNow++;
          return 0;
        };
      }
      painted = trace(true).painted;
    } finally {
      Math.random = realRandom;
      Date.now = realDateNow;
      if (perf && realPerfNow) perf.now = realPerfNow;
    }
    expect(painted, 'the traced frame really did paint the world').toBeGreaterThan(1000);
    expect(
      [random, dateNow, perfNow],
      `Math.random x${random}, Date.now x${dateNow}, performance.now x${perfNow}`,
    ).toEqual([0, 0, 0]);
  });

  it('paints the same world twice from the same script, whatever the frame cadence was', () => {
    // MIGRATED. The end of the determinism chain: identical input gives identical events gives
    // an identical picture. This is the property co-op borrows — two clients derive geometry from
    // the same tiny event payloads (engine-plan §11.1) and must agree without ever comparing it.
    const a = trace(true);
    const picture = Float32Array.from(paintField.paintTime);
    const b = trace(true);
    expect(b.painted).toBe(a.painted);
    let differing = 0;
    for (let i = 0; i < picture.length; i++) if (picture[i] !== paintField.paintTime[i]) differing++;
    expect(differing, `${differing} surfels disagreed between two identical runs`).toBe(0);
  });
});
