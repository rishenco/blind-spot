/**
 * M2 ADVERSARIAL REVIEW — what movement publishes, and whether the numbers are the doc's.
 *
 * Contract under test:
 *   vision §3.3  the event table, verbatim: crouch 1.5/2 · walk 4/11 · sprint 7/24 ·
 *                landing (>2 m drop) 8–14 / 28 · slide 5 continuous / 16.
 *   vision §5    ladder climb 2.5 m/s, SILENT. No fall damage; a >4 m landing costs a 0.3 s
 *                stagger and a loud paint flash instead.
 *   vision §1.2  "the system never lies" — every blip has a real physical source, so an event's
 *                origin has to be where the thing actually happened.
 *   engine-plan §4  origin is the feet; the sim stamps `time`, emitters never pass a clock.
 *   audio.ts:120 recovers the landing's strength from `paintRadius` against the 8→14 range.
 *
 * Labels: PIN = passes today, pins verified-correct behaviour. BUG = fails today, on purpose.
 */

import { describe, expect, it } from 'vitest';
import {
  COYOTE_TIME,
  EV,
  LANDING_MAX_FALL,
  LANDING_MIN_FALL,
  LANDING_STAGGER_FALL,
  LANDING_STAGGER_TIME,
  SIM_STEP,
  SLIDE_STRIDE,
  SPEED_LADDER,
  STRIDE_CROUCH,
  STRIDE_SPRINT,
  STRIDE_WALK,
} from '../../src/core/const.js';
import type { SoundEvent } from '../../src/core/events.js';
import { clamp01, invLerp } from '../../src/core/math.js';
import type { MoveInput } from '../../src/core/movement.js';
import { Sim } from '../../src/core/sim.js';
import type { MapDef, Solid } from '../../src/core/map/types.js';

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

/** Open plate to fall onto and run across, plus one wall carrying a ladder. */
const gym: MapDef = {
  name: 'review emitter gym',
  solids: [
    box('floor', 'floor', 0, -1, 0, 200, 0, 200),
    box('ladderwall', 'wall', 60, 0, 20, 60.4, 8, 26),
  ],
  ladders: [
    {
      id: 'lad',
      x: 60,
      z: 23,
      yBase: 0,
      yTop: 8,
      facing: '-x',
      width: 1.2,
      depth: 0.8,
    },
  ],
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

const fresh = (): Sim => new Sim(gym);
const steps = (s: number): number => Math.round(s / SIM_STEP);

function place(sim: Sim, x: number, y: number, z: number, yaw = 0): void {
  const p = sim.player;
  p.x = x;
  p.y = y;
  p.z = z;
  p.yaw = yaw;
  p.vx = p.vy = p.vz = 0;
  p.grounded = true;
  p.stance = 'stand';
  sim.movement.apexY = y;
  sim.movement.coyote = COYOTE_TIME;
  sim.movement.strideAccum = 0;
  sim.bus.reset();
}

function drive(sim: Sim, seconds: number, patch: Partial<MoveInput> = {}): void {
  for (let i = 0; i < steps(seconds); i++) {
    Object.assign(sim.input, NEUTRAL, patch);
    sim.step(SIM_STEP);
  }
}

/**
 * Drop from exactly `height` onto the y=0 plate and return the landing event (or null).
 * Nothing here reaches past the public state the debug overlay already writes: position,
 * grounded, stance and `apexY` are the same fields F3 prints.
 */
function drop(sim: Sim, height: number): SoundEvent | null {
  const p = sim.player;
  place(sim, 20, 0, 20);
  p.y = height;
  p.grounded = false;
  p.stance = 'air';
  sim.movement.apexY = height;
  sim.bus.reset();
  for (let i = 0; i < steps(6); i++) {
    Object.assign(sim.input, NEUTRAL);
    sim.step(SIM_STEP);
    if (p.grounded) break;
  }
  expect(p.grounded).toBe(true);
  return sim.bus.counts.landing > 0 ? sim.bus.last : null;
}

// ==========================================================================================
// PIN — the §3.3 table, verbatim
// ==========================================================================================

describe('PIN · every emitted class carries its vision §3.3 row unmodified', () => {
  it('crouch / walk / sprint publish the table numbers and nothing else', () => {
    for (const [patch, cls, stride] of [
      [{ forward: 1, crouch: true }, 'crouchStep', STRIDE_CROUCH],
      [{ forward: 1 }, 'walkStep', STRIDE_WALK],
      [{ forward: 1, sprint: true }, 'sprintStep', STRIDE_SPRINT],
    ] as Array<[Partial<MoveInput>, 'crouchStep' | 'walkStep' | 'sprintStep', number]>) {
      const sim = fresh();
      place(sim, 10, 0, 10);
      drive(sim, 4, patch);
      const row = EV[cls];
      const seen = sim.bus.recent();
      expect(seen.length, cls).toBeGreaterThan(1);
      for (const e of seen) {
        expect(e.class, cls).toBe(cls);
        expect(e.source).toBe('self');
        expect(e.paintRadius, `${cls} paint`).toBe(row.paint);
        expect(e.hearRadius, `${cls} hear`).toBe(row.hear);
        expect(e.intensity, `${cls} intensity`).toBe(row.intensity);
        expect(e.waveSpeed).toBe(Infinity);
      }
      // Footsteps are published per stride of GROUND COVERED, not per second.
      const ids = seen.map((e) => e.id).sort((a, b) => a - b);
      const first = seen.find((e) => e.id === ids[0])!;
      const last = seen.find((e) => e.id === ids[ids.length - 1]!)!;
      const spanned = Math.hypot(last.origin[0] - first.origin[0], last.origin[2] - first.origin[2]);
      expect(spanned / (ids.length - 1), `${cls} stride`).toBeCloseTo(stride, 1);
    }
  });

  it('a slide publishes the slide row once per SLIDE_STRIDE of carve', () => {
    const sim = fresh();
    place(sim, 10, 0, 10);
    drive(sim, 1.5, { forward: 1, sprint: true });
    sim.bus.reset();
    const x0 = sim.player.x;
    drive(sim, 1.5, { forward: 1, sprint: true, crouch: true });
    const slid = sim.player.x - x0;
    const seen = sim.bus.recent();
    expect(seen.length).toBeGreaterThan(2);
    for (const e of seen) {
      expect(e.class).toBe('slide');
      expect(e.paintRadius).toBe(EV.slide.paint);
      expect(e.hearRadius).toBe(EV.slide.hear);
      expect(e.intensity).toBe(EV.slide.intensity);
    }
    expect(seen.length).toBeCloseTo(slid / SLIDE_STRIDE, 0);
    // A sliding body is publishing the slide row INSTEAD of footsteps, never both.
    expect(sim.bus.counts.sprintStep + sim.bus.counts.walkStep + sim.bus.counts.crouchStep).toBe(0);
  });

  it('the origin is the feet, and the clock is the sim step that produced it', () => {
    const sim = fresh();
    place(sim, 10, 0, 10);
    let checked = 0;
    const off = sim.bus.on((e) => {
      expect(e.origin[0]).toBe(sim.player.x);
      expect(e.origin[1]).toBe(sim.player.y); // feet, not the eye
      expect(e.origin[2]).toBe(sim.player.z);
      expect(e.time).toBe(sim.time);
      checked++;
    });
    drive(sim, 4, { forward: 1, sprint: true });
    off();
    expect(checked).toBeGreaterThan(3);
  });

  it('climbing a ladder is completely silent (vision §5)', () => {
    const sim = fresh();
    place(sim, 59, 0, 23, 0); // facing +x, into the ladder plane
    drive(sim, 0.5, { forward: 1 });
    expect(sim.movement.ladder, 'expected to be on the ladder').not.toBeNull();
    sim.bus.reset();
    const y0 = sim.player.y;
    drive(sim, 2, { forward: 1 });
    expect(sim.player.y - y0).toBeCloseTo(SPEED_LADDER * 2, 0); // it really did climb
    expect(sim.bus.emitted).toBe(0);
  });
});

// ==========================================================================================
// PIN — the landing curve, and the audio round-trip that reads it back (claimed fix 2)
// ==========================================================================================

describe('PIN · the landing scale (vision §3.3 8–14 m, §5 no fall damage)', () => {
  it('fires strictly above LANDING_MIN_FALL and not at or below it', () => {
    expect(drop(fresh(), LANDING_MIN_FALL - 0.01)).toBeNull();
    expect(drop(fresh(), LANDING_MIN_FALL)).toBeNull(); // ">2 m", so 2.00 is silent
    const just = drop(fresh(), LANDING_MIN_FALL + 0.05);
    expect(just).not.toBeNull();
    expect(just!.class).toBe('landing');
    expect(just!.hearRadius).toBe(EV.landing.hear);
  });

  it('lerps paint 8 → 14 across 2 → 8 m and clamps past the top', () => {
    for (const [fall, paint] of [
      [2.05, 8.05],
      [3.5, 9.5],
      [5.0, 11.0],
      [8.0, 14.0],
      [12.0, 14.0], // clamped: nothing paints more than the top of the row
    ] as Array<[number, number]>) {
      const e = drop(fresh(), fall);
      expect(e, `${fall} m`).not.toBeNull();
      expect(e!.paintRadius, `${fall} m`).toBeCloseTo(paint, 2);
    }
  });

  it("audio.ts:120 recovers the fall fraction from paintRadius exactly (the claimed M2 fix)", () => {
    for (const fall of [2.05, 2.5, 4.0, 6.0, 8.0, 15.0]) {
      const e = drop(fresh(), fall)!;
      const recovered = clamp01(invLerp(EV.landing.paint, EV.landing.paintMax, e.paintRadius));
      const truth = clamp01(invLerp(LANDING_MIN_FALL, LANDING_MAX_FALL, fall));
      expect(recovered, `${fall} m`).toBeCloseTo(truth, 5);
    }
    // …and the two ends really are distinguishable, which is the point of the fix.
    const soft = drop(fresh(), 2.05)!;
    const hard = drop(fresh(), 8)!;
    expect(clamp01(invLerp(EV.landing.paint, EV.landing.paintMax, soft.paintRadius))).toBeLessThan(0.05);
    expect(clamp01(invLerp(EV.landing.paint, EV.landing.paintMax, hard.paintRadius))).toBeCloseTo(1, 5);
  });

  it('stagger is the ONLY cost of a big drop, above 4 m, flat 0.3 s (vision §5: no fall damage)', () => {
    const soft = fresh();
    drop(soft, LANDING_STAGGER_FALL); // exactly 4 m: still no stagger
    expect(soft.movement.staggerTime).toBe(0);

    const hard = fresh();
    drop(hard, LANDING_STAGGER_FALL + 0.5);
    expect(hard.movement.staggerTime).toBeGreaterThan(0);
    expect(hard.movement.staggerTime).toBeLessThanOrEqual(LANDING_STAGGER_TIME);

    // Flat: a 5 m drop and a 40 m drop cost the same 0.3 s and no health anywhere.
    const huge = fresh();
    drop(huge, 40);
    expect(huge.movement.staggerTime).toBeCloseTo(hard.movement.staggerTime, 6);
    expect(Object.keys(huge.player)).not.toContain('health');
    expect(Object.keys(huge.player)).not.toContain('hp');
  });

  it('landing intensity stays the class constant — the scale lives in paintRadius (deviation 2)', () => {
    for (const fall of [2.05, 5, 8, 20]) {
      const e = drop(fresh(), fall)!;
      expect(e.intensity, `${fall} m`).toBe(EV.landing.intensity);
    }
  });
});
