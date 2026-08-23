/**
 * What movement publishes, and whether the numbers are the doc's (vision §3.3, engine-plan §4).
 *
 * Contract under test:
 *   vision §3.3  the event table, verbatim: crouch 1.5/2 · walk 4/11 · sprint 7/24 ·
 *                landing (>2 m drop) 8–14 / 28 · slide 5 continuous / 16.
 *   vision §5    ladder climb 2.5 m/s, SILENT. No fall damage; a >4 m landing costs a 0.3 s
 *                stagger and a loud paint flash instead.
 *   vision §1.2  "the system never lies" — every blip has a real physical source, so an event's
 *                origin has to be where the thing actually happened.
 *   engine-plan §4  origin is the feet; the sim stamps `time`, emitters never pass a clock.
 *   audio.ts     recovers the landing's strength from `paintRadius` against the 8→14 range.
 *
 * The emission ORDER inside a step (verb events, then landing, then stride) is pinned here too:
 * M3's paint pass and the audio engine are both listeners, so they see whatever order this file
 * proves. movement.ts's header documents the same order as a contract.
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
} from '../src/core/const.js';
import type { SoundEvent } from '../src/core/events.js';
import { clamp01, invLerp } from '../src/core/math.js';
import type { MoveInput } from '../src/core/movement.js';
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

/** Open plate to fall onto and run across, plus one wall carrying a ladder. */
const gym: MapDef = {
  name: 'emitter gym',
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

/**
 * The two climbs, side by side, so the mantle scuff and the ladder's silence can be compared in
 * one fixture: a 2 m ledge that needs the mantle verb, and a 4 m tower with a ladder up its west
 * face whose top-out runs the SAME glide.
 */
const climbGym: MapDef = {
  name: 'climb gym',
  solids: [
    box('floor', 'floor', 0, -1, 0, 60, 0, 60),
    box('tower', 'wall', 24, 0, 14, 27, 4.0, 20),
    box('ledge', 'machine', 30, 0, 8, 33, 2.0, 14),
  ],
  ladders: [{ id: 'tower-ladder', x: 24, z: 17, yBase: 0, yTop: 4, facing: '-x', width: 2, depth: 0.6 }],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [2, 0, 45], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [60, 16, 60] }],
  markers: [],
  bounds: { min: [0, -1, 0], max: [60, 16, 60] },
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

/** `press` fires the jump verb on the FIRST step only — the verb is edge-triggered. */
function drive(sim: Sim, seconds: number, patch: Partial<MoveInput> = {}, press = false): void {
  const n = steps(seconds);
  for (let i = 0; i < n; i++) {
    Object.assign(sim.input, NEUTRAL, patch);
    if (press && i === 0) sim.input.jumpPressed = true;
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
// The §3.3 table, verbatim
// ==========================================================================================

describe('every emitted class carries its vision §3.3 row unmodified', () => {
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
// The jump takeoff, and the order events come out in
// ==========================================================================================

describe('the jump takeoff (review finding B2b — proposed vision §3.3 addendum)', () => {
  /**
   * A jump used to be completely silent: the body left the ground publishing nothing, and
   * `land()` then discarded the banked stride on touchdown, so a hopping body crossed a whole
   * floor without a single event — free, silent traversal, which law 1 forbids outright.
   *
   * The ruled fix: the shove against the floor IS the sound, so a jump emits at TAKEOFF, reusing
   * the §3.3 step rows rather than inventing one, with the class derived from the body's speed
   * as the feet leave and floored at walk.
   */
  it('publishes exactly one step event on the frame the feet leave', () => {
    const sim = fresh();
    place(sim, 10, 0, 10);
    drive(sim, SIM_STEP, {}, true);
    expect(sim.bus.emitted).toBe(1);
    expect(sim.player.grounded).toBe(false);
    const e = sim.bus.last!;
    expect(e.time).toBe(sim.time); // this step, not the one before it
    expect(e.origin[1]).toBe(sim.player.y);
    // The rest of the arc is silent: nothing else publishes until the landing.
    drive(sim, 0.5, {});
    expect(sim.bus.emitted).toBe(1);
  });

  it('takes its class from the body, floored at walk — a standing hop is never crouch-quiet', () => {
    const still = fresh();
    place(still, 10, 0, 10);
    drive(still, SIM_STEP, {}, true);
    expect(still.bus.last!.class).toBe('walkStep');

    // Crouch-walking at 1.7 m/s would derive `crouch` from the speed bands; the floor overrides.
    const crouched = fresh();
    place(crouched, 10, 0, 10);
    drive(crouched, 1, { forward: 1, crouch: true });
    crouched.bus.reset();
    drive(crouched, SIM_STEP, { forward: 1, crouch: true }, true);
    expect(crouched.bus.counts.crouchStep).toBe(0);
    expect(crouched.bus.last!.class).toBe('walkStep');

    const running = fresh();
    place(running, 10, 0, 10);
    drive(running, 1.5, { forward: 1, sprint: true });
    running.bus.reset();
    drive(running, SIM_STEP, { forward: 1, sprint: true }, true);
    expect(running.bus.last!.class).toBe('sprintStep');
    expect(running.bus.last!.hearRadius).toBe(EV.sprintStep.hear);
  });

  it('never shares its step with a landing', () => {
    // The jump sets vy = +JUMP_VELOCITY and gravity takes only GRAVITY*dt back off it, so the
    // body is unambiguously airborne by the time the land phase runs. Asserted over a long
    // hop-hold, where takeoffs and landings alternate as fast as the verb allows.
    const sim = fresh();
    place(sim, 10, 0, 10);
    drive(sim, 1.5, { forward: 1, sprint: true });
    sim.bus.reset();
    let sameStep = 0;
    for (let i = 0; i < steps(6); i++) {
      const before = sim.bus.emitted;
      Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true, jumpPressed: true });
      sim.step(SIM_STEP);
      const produced = sim.bus.recent(sim.bus.emitted - before);
      const classes = produced.map((e) => e.class);
      if (classes.includes('landing') && (classes.includes('walkStep') || classes.includes('sprintStep'))) {
        sameStep++;
      }
    }
    expect(sim.bus.emitted, 'the hop really did publish').toBeGreaterThan(5);
    expect(sameStep).toBe(0);
  });

  it('emits verb events before the stride events of the same step (movement.ts step order)', () => {
    // The order is a contract for every bus listener (M3 paint, audio): verbs (mantle, jump
    // takeoff) first, then the landing, then stride/slide. A takeoff leaves the ground, so it
    // can never be followed by a stride in its own step — that is the strongest form of the
    // guarantee and the one asserted here.
    const sim = fresh();
    place(sim, 10, 0, 10);
    drive(sim, 2, { forward: 1, sprint: true });
    sim.bus.reset();
    const order: Array<[number, string]> = [];
    const off = sim.bus.on((e) => order.push([e.time, e.class]));
    for (let i = 0; i < steps(4); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true, jumpPressed: i % 20 === 0 });
      sim.step(SIM_STEP);
    }
    off();
    // Group by sim step: nothing that publishes a takeoff publishes anything else after it.
    const byStep = new Map<number, string[]>();
    for (const [t, c] of order) byStep.set(t, [...(byStep.get(t) ?? []), c]);
    for (const [t, classes] of byStep) {
      expect(classes.length, `step ${t.toFixed(4)} emitted ${classes.join(', ')}`).toBeLessThanOrEqual(1);
    }
    expect(order.length).toBeGreaterThan(5);
  });
});

// ==========================================================================================
// The mantle scuff — deviation 4, a proposed §3.3 addendum
// ==========================================================================================

describe('the mantle scuff (deviation 4 — proposed vision §3.3 addendum)', () => {
  /**
   * A braced heave onto a ledge is a real, audible act, so law 1 says it has a price. The row is
   * a FIRST-PASS TUNING GUESS (const.ts EV.mantle: 3 m paint / 7 m heard), sitting between a
   * crouch step and a walk step. A LADDER stays silent end to end — that one is a vision §5 law,
   * and the pull-up off the top of a ladder is part of the climb, not a mantle.
   */
  it('publishes one mantle event when the verb fires, at the feet', () => {
    const climb = new Sim(climbGym);
    place(climb, 29.5, 0, 11, 0);
    for (let i = 0; i < steps(2); i++) {
      Object.assign(climb.input, NEUTRAL, { forward: 1, jumpPressed: true });
      climb.step(SIM_STEP);
      if (climb.movement.hands === 'mantle') break;
    }
    expect(climb.movement.mantling, 'expected the mantle to trigger').toBe(true);
    expect(climb.bus.counts.mantle).toBe(1);
    const e = climb.bus.last!;
    expect(e.class).toBe('mantle');
    expect(e.source).toBe('self');
    expect(e.paintRadius).toBe(EV.mantle.paint);
    expect(e.hearRadius).toBe(EV.mantle.hear);
    expect(e.intensity).toBe(EV.mantle.intensity);
    expect(e.waveSpeed).toBe(Infinity);
    // Between a crouch step and a walk step, as the row's comment claims.
    expect(EV.mantle.hear).toBeGreaterThan(EV.crouchStep.hear);
    expect(EV.mantle.hear).toBeLessThan(EV.walkStep.hear);
  });

  it('the pull-up off a ladder stays silent (vision §5)', () => {
    // `topOut()` reuses the same glide, which is exactly why the event is emitted by the mantle
    // VERB and not by `startGlide` — otherwise the ladder would announce its own last metre.
    const sim = new Sim(climbGym);
    place(sim, 21, 0, 17, 0); // facing +x, walking into the tower's west face
    drive(sim, 2, { forward: 1 });
    expect(sim.movement.ladder, 'expected to be on the ladder').not.toBeNull();
    sim.bus.reset();
    drive(sim, 5, { forward: 1 });
    expect(sim.movement.ladder).toBeNull();
    expect(sim.player.y).toBeCloseTo(4, 2); // it really did top out onto the tower deck
    expect(sim.bus.counts.mantle).toBe(0);
    expect(sim.bus.emitted).toBe(0);
  });
});

// ==========================================================================================
// The landing curve, and the audio round-trip that reads it back
// ==========================================================================================

describe('the landing scale (vision §3.3 8–14 m, §5 no fall damage)', () => {
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

  it('audio recovers the fall fraction from paintRadius exactly', () => {
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
