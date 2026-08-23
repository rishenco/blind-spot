/**
 * M2 ADVERSARIAL REVIEW — the frame loop that drives the fixed-step sim (main.ts:163-184).
 *
 * Contract under test:
 *   engine-plan §3  the sim is a fixed 60 Hz step with an accumulator; the renderer runs free.
 *   sim.ts:107      `alpha` — "Fraction of a step left over, for render-side interpolation."
 *   vision §12      "Comfort floor: … no motion blur"; and vision §5, "movement stays genuinely
 *                   good" — a camera that stutters at 144 Hz is the one thing a parkour game
 *                   cannot ship with.
 *   visual-brief §1.8  the rig's decay rates (EYE_SMOOTH, FOV_SMOOTH, LANDING_DIP_DECAY,
 *                   TILT_SMOOTH) are all per-SECOND, so feeding it the wrong dt is not cosmetic.
 *
 * These probes replicate main.ts's loop expression exactly rather than importing it — main.ts
 * touches `document`, `window` and WebGL on import and cannot run in node.
 *
 * Labels: PIN = passes today, pins verified-correct behaviour. BUG = fails today, on purpose.
 */

import { describe, expect, it } from 'vitest';
import { COYOTE_TIME, SIM_MAX_STEPS, SIM_STEP } from '../src/core/const.js';
import { CameraRig, type MoveInput } from '../src/core/movement.js';
import { Sim } from '../src/core/sim.js';
import type { MapDef, Solid } from '../src/core/map/types.js';

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
  name: 'review frame-loop gym',
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

/**
 * One frame of main.ts:163-184, verbatim in its arithmetic:
 *
 *     simDt = sim.advance(dtMs / 1000) * SIM_STEP;
 *     rig.update(simDt || dtMs / 1000, sim.movement);
 *
 * Returns what the rig was actually charged for this frame.
 */
function mainFrame(sim: Sim, rig: CameraRig, dtMs: number, patch: Partial<MoveInput>): number {
  Object.assign(sim.input, NEUTRAL, patch);
  const simDt = sim.advance(dtMs / 1000) * SIM_STEP;
  const charged = simDt || dtMs / 1000; // <- main.ts:179
  rig.update(charged, sim.movement);
  return charged;
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
  // `syncCamera()` (main.ts:69) reads the raw p.x/p.y/p.z, so THAT is the pose under test —
  // the rig's own smoothed offsets are a separate (and separately wrong) clock.
  let poseChanges = 0;
  let lastX = sim.player.x;
  let lastZ = sim.player.z;
  for (let i = 0; i < frames; i++) {
    const before = sim.time;
    charged += mainFrame(sim, rig, dtMs, patch);
    if (sim.time === before) zeroStepFrames++;
    if (sim.player.x !== lastX || sim.player.z !== lastZ) poseChanges++;
    lastX = sim.player.x;
    lastZ = sim.player.z;
  }
  return { sim, rig, charged, zeroStepFrames, poseChanges, wall: (frames * dtMs) / 1000 };
}

// ==========================================================================================
// BUG — the rig is charged twice for the time the sim did not advance
// ==========================================================================================

describe('BUG · main.ts:179 double-counts time on the frames the sim does not step', () => {
  /**
   * `rig.update(simDt || dtMs / 1000, …)`. `simDt` is 0 on any frame whose leftover accumulator
   * did not reach one whole 1/60 s step — at 144 Hz that is more than half of all frames. On
   * those frames the `||` falls through to the RAW FRAME TIME, so the rig is charged for the
   * whole frame, and then charged again as part of the next frame's `simDt` when the accumulator
   * finally spills. Over a run the rig receives strictly more time than the sim advanced.
   *
   * Every rate the rig applies is per-second (EYE_SMOOTH 12, FOV_SMOOTH ~, TILT_SMOOTH 8,
   * LANDING_DIP_DECAY 7), so this is a refresh-rate-dependent camera: eye height, FOV kick,
   * landing dip and slide tilt all settle ~1.6x faster on a 144 Hz monitor than on a 60 Hz one.
   * Fix direction: charge the rig `dtMs / 1000` ALWAYS (it is a render-side smoother, it wants
   * frame time, not sim time), or charge it `simDt` and accept that it only ticks on sim steps.
   * Do not do both.
   */
  it('expected: the rig is charged the wall clock exactly once — actual: 1.59x at 144 Hz', () => {
    const r = run(144, 600);
    expect(r.zeroStepFrames, 'the 144 Hz loop really does skip steps').toBeGreaterThan(300);
    expect(
      r.charged,
      `sim advanced ${r.sim.time.toFixed(4)} s, rig charged ${r.charged.toFixed(4)} s over ${r.wall.toFixed(4)} s of wall clock`,
    ).toBeCloseTo(r.wall, 3);
  });

  it('expected: the rig clock tracks the sim clock — actual: it runs ahead and never resyncs', () => {
    const r = run(144, 600);
    // The excess is exactly the wall time spent inside the zero-step frames.
    const excess = r.charged - r.sim.time;
    expect(excess, `excess ${excess.toFixed(4)} s`).toBeCloseTo(0, 3);
  });

  it('expected: the camera settles identically at 60 and 144 Hz — actual: 144 Hz settles faster', () => {
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
// BUG — `sim.alpha` is built for interpolation and wired to nothing
// ==========================================================================================

describe('BUG · sim.alpha is computed for render interpolation but never consumed', () => {
  /**
   * sim.ts:107 exposes `alpha` documented as "Fraction of a step left over, for render-side
   * interpolation." Nothing in src/ reads it: main.ts:69 sets the camera straight from the raw
   * `p.x / p.y / p.z`. The visible result is that on a 144 Hz display the world holds still for
   * one or two frames and then jumps 1/60 s worth of motion — at SPEED_SPRINT that is a 10 cm
   * hitch, 60 times a second, in a game whose whole promise (vision §5) is that "movement stays
   * genuinely good".
   *
   * Fix direction: keep a previous-position snapshot in the sim and have `syncCamera()` lerp
   * prev→current by `sim.alpha`; the accumulator that makes `alpha` correct is already there.
   */
  it('expected: the camera pose advances on every frame — actual: it freezes on 58 % of them', () => {
    const r = run(144, 600);
    expect(
      r.poseChanges,
      `camera pose changed on ${r.poseChanges}/600 frames (${r.zeroStepFrames} zero-step frames)`,
    ).toBe(600);
  });

  it('expected: something in the render path reads sim.alpha — actual: alpha is inert', () => {
    // Proven structurally: `alpha` is a live, correct number that nothing acts on. If the camera
    // interpolated, two frames with different alphas and no sim step would show different poses.
    const { sim, rig } = fresh();
    for (let i = 0; i < 60; i++) mainFrame(sim, rig, 1000 / 60, { forward: 1, sprint: true });
    const a0 = sim.alpha;
    const x0 = sim.player.x;
    const t0 = sim.time;
    mainFrame(sim, rig, 2, { forward: 1, sprint: true }); // 2 ms — cannot fill a 16.67 ms step
    expect(sim.time, 'the sim really did not step').toBe(t0);
    expect(sim.alpha, 'alpha really did move').toBeGreaterThan(a0);
    expect(sim.alpha).toBeLessThan(1);
    expect(
      sim.player.x,
      `alpha moved ${a0.toFixed(3)} -> ${sim.alpha.toFixed(3)} and the pose main.ts:69 reads did not budge`,
    ).not.toBe(x0);
  });
});

// ==========================================================================================
// PIN — the accumulator itself is right
// ==========================================================================================

describe('PIN · the fixed-step accumulator (engine-plan §3)', () => {
  it('agrees with the rig exactly at 60 Hz, the rate the loop was tuned at', () => {
    const r = run(60, 600);
    expect(r.zeroStepFrames).toBe(0);
    expect(r.charged).toBeCloseTo(r.sim.time, 9);
    expect(r.charged).toBeCloseTo(r.wall, 9);
    expect(r.poseChanges).toBe(600);
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
    let n = 0;
    for (const dtMs of [3, 7, 16.7, 1, 40, 8.3, 250, 11, 16.7, 16.7]) {
      n += mainFrame(sim, rig, dtMs, { forward: 1 }) > 0 ? 0 : 0;
      const q = sim.time / SIM_STEP;
      expect(Math.abs(q - Math.round(q)), `after ${dtMs} ms`).toBeLessThan(1e-9);
    }
    expect(n).toBe(0);
  });

  it('drops input edges the same way regardless of how many steps a frame carries', () => {
    // `jumpPressed` is an edge the sim consumes; a 5-step catch-up frame must not jump 5 times.
    const { sim } = fresh();
    Object.assign(sim.input, NEUTRAL, { jumpPressed: true });
    sim.advance(5 / 60);
    expect(sim.player.vy).toBeGreaterThan(0);
    expect(sim.bus.counts.landing).toBe(0);
    // One takeoff, not five: vy is a single jump impulse, not a stack of them.
    const single = new Sim(gym);
    single.player.grounded = true;
    single.movement.coyote = COYOTE_TIME;
    Object.assign(single.input, NEUTRAL, { jumpPressed: true });
    single.step(SIM_STEP);
    expect(sim.player.vy).toBeLessThanOrEqual(single.player.vy + 1e-9);
  });
});
