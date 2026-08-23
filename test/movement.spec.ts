/**
 * The first-person controller and its emitters (vision §5, engine-plan §5, §10 M2 slice).
 *
 * Design laws under test, in the order vision.md states them:
 *   law 1  every way of learning emits sound — moving publishes strides, landings, slides, and
 *          the numbers come from the vision §3.3 table, never from the controller
 *   law 4  loud before lethal — a drop announces itself
 *   law 5  movement stays genuinely good — no fall damage, no encumbrance, no stamina; momentum
 *          survives every verb it possibly can
 *
 * Everything runs on the fixed step through the real `Sim`, so what is asserted is what ships.
 * The gym below is synthetic on purpose: one obstacle per verb, at round heights, so a failure
 * names the verb instead of naming a corner of the authored map.
 */

import { describe, expect, it } from 'vitest';
import {
  COYOTE_TIME,
  EV,
  EYE_CROUCH,
  EYE_STAND,
  GRAVITY,
  HEIGHT_CROUCH,
  HEIGHT_STAND,
  JUMP_VELOCITY,
  LANDING_MAX_FALL,
  LANDING_MIN_FALL,
  LANDING_STAGGER_FALL,
  LANDING_STAGGER_TIME,
  MANTLE_MAX_HEIGHT,
  SIM_STEP,
  SLIDE_BOOST_SPEED,
  SLIDE_DECAY,
  SLIDE_ENTRY_SPEED,
  SLIDE_MIN_SPEED,
  SLIDE_STRIDE,
  SPEED_CROUCH,
  SPEED_LADDER,
  SPEED_SPRINT,
  SPEED_WALK,
  STRIDE_CROUCH,
  STRIDE_SPRINT,
  STRIDE_WALK,
  VAULT_MAX_HEIGHT,
} from '../src/core/const.js';
import type { MoveInput } from '../src/core/movement.js';
import { Sim } from '../src/core/sim.js';
import type { MapDef, Solid } from '../src/core/map/types.js';

// ------------------------------------------------------------------------------------------
// The gym. Flat 60x60 floor at y=0, one obstacle per verb, all in their own z lane so a run-up
// along +x can never clip the neighbour:
//
//   z  2..6    vault      0.9 m — under VAULT_MAX_HEIGHT, so running into it climbs it
//   z 10..16   mantle     2.0 m — under MANTLE_MAX_HEIGHT, so it needs a jump press
//   z 20..26   reach      3.0 m — out of reach standing, catchable at the top of a jump
//   z 30..36   tall       3.6 m — out of reach even jumping: the reject case
//   z 14..20   tower      4.0 m with a ladder up its west face (x 24)
//   x 30..36 / z 2..8     duct   a ceiling slab 1.3 m up: the stand-up gate
//   z 45                  the clear lane used for stride / slide / speed runs
// ------------------------------------------------------------------------------------------

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
  name: 'movement gym',
  solids: [
    box('floor', 'floor', 0, -1, 0, 60, 0, 60),
    box('vault', 'crate', 10, 0, 2, 13, 0.9, 6),
    box('mantle', 'machine', 10, 0, 10, 13, 2.0, 16),
    box('reach', 'machine', 10, 0, 20, 13, 3.0, 26),
    box('tall', 'wall', 10, 0, 30, 13, 3.6, 36),
    box('tower', 'wall', 24, 0, 14, 27, 4.0, 20),
    box('duct', 'ceiling', 30, 1.3, 2, 36, 1.6, 8),
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

const YAW_EAST = 0;
const YAW_NORTH = -Math.PI / 2;
const YAW_WEST = Math.PI;

const fresh = (): Sim => new Sim(gym);

/** Drop the body somewhere with a clean history. Position, not input — the verbs do the rest. */
function place(sim: Sim, x: number, y: number, z: number, yaw = YAW_EAST, grounded = true): void {
  const p = sim.player;
  p.x = x;
  p.y = y;
  p.z = z;
  p.yaw = yaw;
  p.vx = p.vy = p.vz = 0;
  p.grounded = grounded;
  p.stance = grounded ? 'stand' : 'air';
  sim.movement.apexY = y;
  sim.movement.coyote = grounded ? COYOTE_TIME : 0;
  sim.movement.strideAccum = 0;
  sim.bus.reset();
}

const steps = (seconds: number): number => Math.round(seconds / SIM_STEP);

/**
 * An intent REPLACES the whole input, exactly as a keyboard frame does (and as `ScriptedInput`
 * does): an omitted field means "not held", never "still held from before".
 */
const NEUTRAL: MoveInput = {
  forward: 0,
  right: 0,
  jumpPressed: false,
  crouch: false,
  sprint: false,
  yawDelta: 0,
  pitchDelta: 0,
};

/** Hold an intent for a while. `press` fires jump once, on the first step (an edge, like a key). */
function drive(sim: Sim, seconds: number, patch: Partial<MoveInput> = {}, press = false): void {
  const n = steps(seconds);
  for (let i = 0; i < n; i++) {
    Object.assign(sim.input, NEUTRAL, patch);
    if (press && i === 0) sim.input.jumpPressed = true;
    sim.step(SIM_STEP);
  }
}

/** Hold an intent until something happens. Returns the seconds it took; throws if it never does. */
function driveUntil(
  sim: Sim,
  done: () => boolean,
  limit: number,
  patch: Partial<MoveInput> = {},
  press = false,
): number {
  const n = steps(limit);
  for (let i = 0; i < n; i++) {
    Object.assign(sim.input, NEUTRAL, patch);
    if (press && i === 0) sim.input.jumpPressed = true;
    sim.step(SIM_STEP);
    if (done()) return (i + 1) * SIM_STEP;
  }
  const p = sim.player;
  throw new Error(
    `condition not reached within ${limit}s (at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`,
  );
}

/** Let the body fall from `height` onto the floor and report the resulting fall distance. */
function dropFrom(sim: Sim, height: number, x = 5, z = 45): number {
  place(sim, x, height, z, YAW_EAST, false);
  driveUntil(sim, () => sim.player.grounded, 4);
  return sim.movement.lastFall;
}

const FORWARD = { forward: 1 } as const;
const SPRINT = { forward: 1, sprint: true } as const;

// ------------------------------------------------------------------------------------------

describe('gait speeds (vision §5)', () => {
  it('tops out at the authored speed for each stance', () => {
    const cases: Array<[Partial<MoveInput>, number]> = [
      [{ forward: 1, crouch: true }, SPEED_CROUCH],
      [FORWARD, SPEED_WALK],
      [SPRINT, SPEED_SPRINT],
    ];
    for (const [patch, speed] of cases) {
      const sim = fresh();
      place(sim, 2, 0, 45);
      drive(sim, 1.5, patch);
      expect(sim.movement.speedXZ).toBeCloseTo(speed, 3);
    }
  });

  it('sprints only forward — a backpedal is a walk', () => {
    const sim = fresh();
    place(sim, 30, 0, 45);
    drive(sim, 1.5, { forward: -1, sprint: true });
    expect(sim.movement.speedXZ).toBeCloseTo(SPEED_WALK, 3);
  });

  it('never taxes movement: nothing on the player can run out (law 5)', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    drive(sim, 20, SPRINT);
    // 20 s of full sprint, and the twentieth second is exactly as fast as the first.
    expect(sim.movement.speedXZ).toBeCloseTo(SPEED_SPRINT, 3);
    expect(sim.player.x).toBeGreaterThan(2 + 19 * SPEED_SPRINT);
  });

  /**
   * Ground accel is Quake-style, and Quake-style accel only measures your speed ALONG wishdir.
   * Run diagonally into a wall and the component across it is invisible to the cap, so the
   * projection equilibrates at cap / cos(angle) — an 8.5 m/s "sprint" for free, just by rubbing.
   * The Halo (§3.8) promises you always know how loud you are, and the gait table is what makes
   * a sprint step a sprint step: a speed the player never asked for breaks both.
   */
  it('cannot manufacture speed by rubbing a wall at an angle', () => {
    const sim = fresh();
    // 45° into the west face of the `tall` block (x=10, z 30..36), which is far too high to climb.
    place(sim, 9, 0, 30.5, Math.PI / 4);
    let peak = 0;
    for (let i = 0; i < steps(0.7); i++) {
      Object.assign(sim.input, NEUTRAL, SPRINT);
      sim.step(SIM_STEP);
      peak = Math.max(peak, sim.movement.speedXZ);
    }
    // Pinned to the wall, sliding along it, and never faster than a sprint.
    expect(sim.player.x).toBeCloseTo(9.65, 2);
    expect(sim.player.z).toBeGreaterThan(33);
    expect(peak).toBeLessThanOrEqual(SPEED_SPRINT + 1e-6);
  });
});

describe('stride emitters (vision §3.3)', () => {
  /**
   * The accumulator is exact, so the whole run is one identity: every metre walked is either
   * inside a published footstep or still banked. That catches a drifting stride length, a
   * double emit and a swallowed remainder in one assertion.
   */
  const strideRun = (patch: Partial<MoveInput>, seconds: number): { path: number; banked: number; sim: Sim } => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    const x0 = sim.player.x;
    drive(sim, seconds, patch);
    return { path: sim.player.x - x0, banked: sim.movement.strideAccum, sim };
  };

  it('walks a footstep every 1.9 m', () => {
    const { path, banked, sim } = strideRun(FORWARD, 6);
    expect(sim.bus.counts.walkStep).toBeGreaterThan(8);
    expect(sim.bus.counts.walkStep * STRIDE_WALK + banked).toBeCloseTo(path, 6);
    expect(sim.bus.counts.sprintStep + sim.bus.counts.crouchStep).toBe(0);
  });

  it('sprints a footstep every 2.6 m', () => {
    const { path, banked, sim } = strideRun(SPRINT, 6);
    expect(sim.bus.counts.sprintStep).toBeGreaterThan(10);
    expect(sim.bus.counts.sprintStep * STRIDE_SPRINT + banked).toBeCloseTo(path, 6);
    // The spin-up to sprint speed covers under a quarter of a metre — no walk step slips out.
    expect(sim.bus.counts.walkStep).toBe(0);
  });

  it('crouches a footstep every 1.3 m', () => {
    const { path, banked, sim } = strideRun({ forward: 1, crouch: true }, 6);
    expect(sim.bus.counts.crouchStep).toBeGreaterThan(5);
    expect(sim.bus.counts.crouchStep * STRIDE_CROUCH + banked).toBeCloseTo(path, 6);
    expect(sim.bus.counts.walkStep + sim.bus.counts.sprintStep).toBe(0);
  });

  it('publishes each step at the foot, with the class row for the gait', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    drive(sim, 3, SPRINT);
    const e = sim.bus.last!;
    expect(e.class).toBe('sprintStep');
    expect(e.source).toBe('self');
    expect(e.paintRadius).toBe(EV.sprintStep.paint);
    expect(e.hearRadius).toBe(EV.sprintStep.hear);
    expect(e.origin[1]).toBeCloseTo(0, 4);
    expect(e.origin[0]).toBeGreaterThan(2);
    expect(e.origin[2]).toBeCloseTo(45, 6);
    expect(e.time).toBeLessThanOrEqual(sim.time + 1e-9);
  });

  it('stays silent while standing still', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    drive(sim, 3);
    expect(sim.bus.emitted).toBe(0);
  });

  it('is louder the faster you go — sprinting lights 7 m per footfall', () => {
    expect(EV.crouchStep.paint).toBeLessThan(EV.walkStep.paint);
    expect(EV.walkStep.paint).toBeLessThan(EV.sprintStep.paint);
    expect(EV.crouchStep.hear).toBeLessThan(EV.walkStep.hear);
    expect(EV.walkStep.hear).toBeLessThan(EV.sprintStep.hear);
  });
});

describe('jump', () => {
  it('leaves the ground at the authored velocity and arcs to the ballistic apex', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    let apex = 0;
    drive(sim, 0.02, {}, true);
    expect(sim.player.vy).toBeGreaterThan(JUMP_VELOCITY - GRAVITY * SIM_STEP - 1e-6);
    for (let i = 0; i < steps(1.2); i++) {
      sim.step(SIM_STEP);
      apex = Math.max(apex, sim.player.y);
    }
    const ideal = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
    expect(apex).toBeGreaterThan(ideal - 0.1);
    expect(apex).toBeLessThan(ideal + 0.02);
    expect(sim.player.grounded).toBe(true);
    expect(sim.player.y).toBeCloseTo(0, 4);
  });

  it('is not a landing — a jump on the spot paints nothing', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    drive(sim, 1.2, {}, true);
    expect(sim.movement.lastFall).toBeLessThan(LANDING_MIN_FALL);
    expect(sim.bus.counts.landing).toBe(0);
  });

  it('keeps your run: a sprinting jump lands still sprinting', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    drive(sim, 1.5, SPRINT);
    drive(sim, 1.0, SPRINT, true);
    expect(sim.player.grounded).toBe(true);
    expect(sim.movement.speedXZ).toBeCloseTo(SPEED_SPRINT, 2);
  });

  it('buffers a press made just before touchdown', () => {
    const sim = fresh();
    place(sim, 2, 1.0, 45, YAW_EAST, false);
    // Press while still falling, a few centimetres up: the buffer spends it on touchdown.
    driveUntil(sim, () => sim.player.y < 0.25, 1);
    expect(sim.player.grounded).toBe(false);
    driveUntil(sim, () => sim.player.grounded, 0.2, {}, true);
    expect(sim.movement.jumpBuffer).toBeGreaterThan(0);
    drive(sim, SIM_STEP);
    expect(sim.player.vy).toBeGreaterThan(1);
    expect(sim.player.grounded).toBe(false);
  });
});

describe('coyote time', () => {
  const walkOffTheLedge = (sim: Sim): void => {
    place(sim, 11.5, 2.0, 13, YAW_NORTH);
    driveUntil(sim, () => !sim.player.grounded, 3, FORWARD);
  };

  it('lets you jump just after the edge', () => {
    const sim = fresh();
    walkOffTheLedge(sim);
    expect(sim.movement.coyote).toBeGreaterThan(0);
    drive(sim, SIM_STEP, FORWARD, true);
    expect(sim.player.vy).toBeCloseTo(JUMP_VELOCITY - GRAVITY * SIM_STEP, 5);
  });

  it('closes after COYOTE_TIME', () => {
    const sim = fresh();
    walkOffTheLedge(sim);
    drive(sim, COYOTE_TIME + 4 * SIM_STEP, FORWARD);
    expect(sim.player.grounded).toBe(false);
    expect(sim.movement.coyote).toBe(0);
    drive(sim, SIM_STEP, FORWARD, true);
    expect(sim.player.vy).toBeLessThan(0);
  });
});

describe('landings (law 4, law 5)', () => {
  it('says nothing about a short drop', () => {
    const sim = fresh();
    const fall = dropFrom(sim, LANDING_MIN_FALL - 0.5);
    expect(fall).toBeCloseTo(LANDING_MIN_FALL - 0.5, 2);
    expect(sim.bus.counts.landing).toBe(0);
  });

  it('paints 8 m at the threshold and 14 m at the top of the scale', () => {
    const near = fresh();
    dropFrom(near, LANDING_MIN_FALL + 0.05);
    expect(near.bus.counts.landing).toBe(1);
    expect(near.bus.last!.paintRadius).toBeGreaterThanOrEqual(EV.landing.paint);
    expect(near.bus.last!.paintRadius).toBeLessThan(EV.landing.paint + 0.2);

    const mid = fresh();
    dropFrom(mid, 5);
    // 5 m is exactly halfway between LANDING_MIN_FALL and LANDING_MAX_FALL.
    expect(mid.bus.last!.paintRadius).toBeCloseTo((EV.landing.paint + EV.landing.paintMax) / 2, 1);

    const far = fresh();
    dropFrom(far, LANDING_MAX_FALL + 4);
    expect(far.bus.last!.paintRadius).toBeCloseTo(EV.landing.paintMax, 6);
  });

  it('is the loudest thing a body can do without a ping', () => {
    const sim = fresh();
    dropFrom(sim, 5);
    const e = sim.bus.last!;
    expect(e.class).toBe('landing');
    expect(e.hearRadius).toBe(EV.landing.hear);
    expect(e.hearRadius).toBeGreaterThan(EV.sprintStep.hear);
    expect(e.origin[1]).toBeCloseTo(0, 4);
  });

  it('costs a stagger above 4 m and nothing below it', () => {
    const light = fresh();
    dropFrom(light, LANDING_STAGGER_FALL - 0.5);
    expect(light.movement.staggerTime).toBe(0);

    const heavy = fresh();
    dropFrom(heavy, LANDING_STAGGER_FALL + 1);
    expect(heavy.movement.staggerTime).toBeCloseTo(LANDING_STAGGER_TIME, 6);
  });

  it('never damages: the stagger is a flat 0.3 s however far you fall (law 5)', () => {
    const short = fresh();
    dropFrom(short, 5);
    const tall = fresh();
    dropFrom(tall, 14);
    expect(tall.movement.lastFall).toBeCloseTo(14, 1);
    expect(tall.movement.staggerTime).toBeCloseTo(short.movement.staggerTime, 6);
    // No health, no damage, nothing to lose — the state has no such field to begin with.
    expect(Object.keys(tall.player)).not.toContain('health');
    // …and 0.3 s later you are sprinting again, from a 14 m fall.
    drive(tall, 1.5, SPRINT);
    expect(tall.movement.speedXZ).toBeCloseTo(SPEED_SPRINT, 2);
  });

  it('slows you only while the stagger lasts', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    drive(sim, 1.5, SPRINT);
    place(sim, 2, 6, 45, YAW_EAST, false);
    driveUntil(sim, () => sim.player.grounded, 3, SPRINT);
    drive(sim, LANDING_STAGGER_TIME * 0.5, SPRINT);
    expect(sim.movement.speedXZ).toBeLessThan(SPEED_WALK);
    drive(sim, 1.0, SPRINT);
    expect(sim.movement.speedXZ).toBeCloseTo(SPEED_SPRINT, 2);
  });

  it('clears the stride accumulator, so a landing never shares its step with a footstep', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    drive(sim, 2, SPRINT);
    place(sim, 2, 5, 45, YAW_EAST, false);
    sim.movement.strideAccum = STRIDE_SPRINT - 0.01; // primed to fire on the very next metre
    driveUntil(sim, () => sim.player.grounded, 3, SPRINT);
    expect(sim.bus.last!.class).toBe('landing');
    expect(sim.movement.strideAccum).toBeLessThan(0.2);
  });
});

describe('crouch and the stand-up gate', () => {
  it('shrinks the capsule and the eye, feet staying put', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    drive(sim, 0.2, { crouch: true });
    expect(sim.movement.height).toBe(HEIGHT_CROUCH);
    expect(sim.movement.eyeTarget).toBe(EYE_CROUCH);
    expect(sim.player.y).toBeCloseTo(0, 4);
    expect(sim.player.stance).toBe('crouch');
    drive(sim, 0.2);
    expect(sim.movement.height).toBe(HEIGHT_STAND);
    expect(sim.movement.eyeTarget).toBe(EYE_STAND);
  });

  it('refuses to stand under a duct, and stands the moment you clear it', () => {
    const sim = fresh();
    place(sim, 33, 0, 5, YAW_WEST);
    drive(sim, 0.3, { crouch: true });
    expect(sim.movement.height).toBe(HEIGHT_CROUCH);

    // Release crouch but stay under the slab: still crouched, still moving.
    drive(sim, 0.5, FORWARD);
    expect(sim.movement.height).toBe(HEIGHT_CROUCH);
    expect(sim.player.stance).toBe('crouch');
    expect(sim.player.x).toBeLessThan(33);

    driveUntil(sim, () => sim.movement.height === HEIGHT_STAND, 4, FORWARD);
    expect(sim.player.x).toBeLessThan(30);
    expect(sim.player.stance).toBe('stand');
  });
});

describe('slide', () => {
  const intoSlide = (sim: Sim): void => {
    place(sim, 2, 0, 45);
    drive(sim, 1.5, SPRINT);
    expect(sim.movement.speedXZ).toBeGreaterThanOrEqual(SLIDE_ENTRY_SPEED);
    sim.bus.reset();
    drive(sim, SIM_STEP, { ...SPRINT, crouch: true });
  };

  it('needs speed: crouching at a walk is just a crouch', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    drive(sim, 1.5, FORWARD);
    drive(sim, 0.2, { forward: 1, crouch: true });
    expect(sim.movement.sliding).toBe(false);
    expect(sim.player.stance).toBe('crouch');
  });

  it('boosts on entry — a slide is faster than the sprint that fed it', () => {
    const sim = fresh();
    intoSlide(sim);
    expect(sim.movement.sliding).toBe(true);
    expect(sim.player.stance).toBe('slide');
    expect(sim.movement.height).toBe(HEIGHT_CROUCH);
    expect(sim.movement.speedXZ).toBeGreaterThan(SPEED_SPRINT);
    expect(sim.movement.slideSpeed).toBeCloseTo(SLIDE_BOOST_SPEED - SLIDE_DECAY * SIM_STEP, 6);
  });

  it('decays linearly at SLIDE_DECAY', () => {
    const sim = fresh();
    intoSlide(sim);
    const s0 = sim.movement.slideSpeed;
    drive(sim, 1.0, { ...SPRINT, crouch: true });
    expect(sim.movement.slideSpeed).toBeCloseTo(s0 - SLIDE_DECAY, 5);
    expect(sim.movement.speedXZ).toBeCloseTo(sim.movement.slideSpeed, 5);
  });

  it('ends itself at SLIDE_MIN_SPEED, after the authored duration', () => {
    const sim = fresh();
    intoSlide(sim);
    const t0 = sim.time;
    driveUntil(sim, () => !sim.movement.sliding, 6, { ...SPRINT, crouch: true });
    const expected = (SLIDE_BOOST_SPEED - SLIDE_MIN_SPEED) / SLIDE_DECAY;
    expect(sim.time - t0).toBeCloseTo(expected, 1);
    // Crouch is still held, so the slide falls back into a crouch, not a stand.
    expect(sim.player.stance).toBe('crouch');
  });

  it('ends the moment you let go of crouch', () => {
    const sim = fresh();
    intoSlide(sim);
    drive(sim, SIM_STEP, SPRINT);
    expect(sim.movement.sliding).toBe(false);
  });

  it('scrapes continuously — one event every half metre travelled', () => {
    const sim = fresh();
    intoSlide(sim);
    const x0 = sim.player.x;
    sim.bus.reset();
    sim.movement.slideAccum = 0;
    drive(sim, 1.0, { ...SPRINT, crouch: true });
    const path = sim.player.x - x0;
    expect(sim.bus.counts.slide).toBeGreaterThan(10);
    expect(sim.bus.counts.slide * SLIDE_STRIDE + sim.movement.slideAccum).toBeCloseTo(path, 6);
    expect(sim.bus.last!.paintRadius).toBe(EV.slide.paint);
    expect(sim.bus.counts.sprintStep).toBe(0);
  });

  it('hands the boost back on a slide-jump instead of confiscating it (law 5)', () => {
    const sim = fresh();
    intoSlide(sim);
    drive(sim, SIM_STEP, { ...SPRINT, crouch: true }, true);
    expect(sim.movement.sliding).toBe(false);
    expect(sim.player.grounded).toBe(false);
    expect(sim.movement.speedXZ).toBeGreaterThan(SPEED_SPRINT);
  });
});

describe('vault, mantle, ledge-grab', () => {
  it('vaults a low ledge automatically, just by running into it', () => {
    const sim = fresh();
    place(sim, 6, 0, 4);
    driveUntil(sim, () => sim.movement.hands === 'vault', 4, FORWARD);
    expect(sim.movement.mantling).toBe(true);
    driveUntil(sim, () => !sim.movement.mantling, 1, {});
    expect(sim.player.y).toBeCloseTo(0.9, 4);
    expect(sim.player.grounded).toBe(true);
    expect(0.9).toBeLessThanOrEqual(VAULT_MAX_HEIGHT);
  });

  it('keeps your speed over a vault', () => {
    const sim = fresh();
    place(sim, 4, 0, 4);
    driveUntil(sim, () => sim.movement.hands === 'vault', 4, SPRINT);
    driveUntil(sim, () => !sim.movement.mantling, 1, {});
    expect(sim.movement.speedXZ).toBeGreaterThan(SPEED_WALK);
  });

  it('will not auto-climb a tall ledge you are only running past', () => {
    const sim = fresh();
    place(sim, 6, 0, 13);
    drive(sim, 3, SPRINT);
    expect(sim.movement.mantling).toBe(false);
    expect(sim.player.y).toBeCloseTo(0, 4);
    expect(sim.player.x).toBeLessThan(10); // stopped at the face
  });

  it('mantles that same ledge when you ask for it', () => {
    const sim = fresh();
    place(sim, 6, 0, 13);
    drive(sim, 2, SPRINT);
    driveUntil(sim, () => sim.movement.hands === 'mantle', 1, FORWARD, true);
    driveUntil(sim, () => !sim.movement.mantling, 1, {});
    expect(sim.player.y).toBeCloseTo(2.0, 4);
    expect(sim.player.grounded).toBe(true);
    expect(2.0).toBeLessThanOrEqual(MANTLE_MAX_HEIGHT);
  });

  it('catches a lip a jump can reach but a stand cannot (ledge-grab)', () => {
    const sim = fresh();
    place(sim, 6, 0, 23);
    drive(sim, 2, SPRINT);
    expect(sim.player.y).toBeCloseTo(0, 4); // 3 m is out of reach standing
    driveUntil(sim, () => sim.movement.hands === 'mantle', 2.5, FORWARD, true);
    // It caught the lip on the way DOWN — a jump alone never reaches the top.
    expect(sim.player.vy).toBeLessThanOrEqual(0);
    driveUntil(sim, () => !sim.movement.mantling, 1);
    expect(sim.player.y).toBeCloseTo(3.0, 4);
    expect(sim.player.grounded).toBe(true);
  });

  it('refuses anything above MANTLE_MAX_HEIGHT, jump or no jump', () => {
    const sim = fresh();
    place(sim, 6, 0, 33);
    drive(sim, 2, SPRINT);
    for (let i = 0; i < 4; i++) drive(sim, 0.6, FORWARD, true);
    drive(sim, 1, FORWARD); // let the last arc finish, still shoving at the wall
    expect(sim.movement.mantling).toBe(false);
    expect(sim.player.y).toBeCloseTo(0, 4);
    expect(sim.player.x).toBeLessThan(10);
  });

  it('will not pull up where there is no room to stand', () => {
    const sim = fresh();
    // Crouched under the duct: 1.3 m of headroom cannot hold a standing body.
    place(sim, 33, 0, 5);
    drive(sim, 0.3, { crouch: true });
    expect(sim.movement.height).toBe(HEIGHT_CROUCH);
    drive(sim, 1.0, { forward: 1, crouch: true }, true);
    expect(sim.movement.mantling).toBe(false);
    expect(sim.movement.height).toBe(HEIGHT_CROUCH);
  });
});

describe('ladder (vision §5: slow, quiet, chosen)', () => {
  const grab = (sim: Sim): void => {
    place(sim, 21, 0, 17);
    driveUntil(sim, () => sim.movement.ladder !== null, 4, FORWARD);
    sim.bus.reset();
  };

  it('attaches only when you push into it', () => {
    const sim = fresh();
    place(sim, 21, 0, 17);
    // Sidling past with no forward intent must not snap you onto the rungs.
    drive(sim, 2, { right: 1 });
    expect(sim.movement.ladder).toBeNull();
    grab(sim);
    expect(sim.player.stance).toBe('ladder');
    expect(sim.player.grounded).toBe(false);
  });

  it('climbs at 2.5 m/s', () => {
    const sim = fresh();
    grab(sim);
    const y0 = sim.player.y;
    drive(sim, 1.0, FORWARD);
    expect(sim.player.y - y0).toBeCloseTo(SPEED_LADDER, 2);
    expect(sim.player.stance).toBe('ladder');
  });

  it('is silent — the whole climb emits nothing', () => {
    const sim = fresh();
    grab(sim);
    drive(sim, 1.4, FORWARD);
    expect(sim.player.y).toBeGreaterThan(3);
    expect(sim.bus.emitted).toBe(0);
  });

  it('tops out onto the deck above', () => {
    const sim = fresh();
    grab(sim);
    driveUntil(sim, () => sim.player.grounded, 4, FORWARD);
    expect(sim.player.y).toBeCloseTo(4.0, 4);
    expect(sim.movement.ladder).toBeNull();
    expect(sim.bus.emitted).toBe(0); // arriving is silent too
  });

  it('climbs back down and lets go at the bottom', () => {
    const sim = fresh();
    grab(sim);
    drive(sim, 1.0, FORWARD);
    driveUntil(sim, () => sim.movement.ladder === null, 3, { forward: -1 });
    expect(sim.player.y).toBeCloseTo(0, 4);
    expect(sim.player.grounded).toBe(true);
  });

  it('drops off on crouch and kicks off on jump', () => {
    const dropOff = fresh();
    grab(dropOff);
    drive(dropOff, 0.5, FORWARD);
    drive(dropOff, SIM_STEP, { crouch: true });
    expect(dropOff.movement.ladder).toBeNull();
    expect(dropOff.player.stance).toBe('air');

    const kickOff = fresh();
    grab(kickOff);
    drive(kickOff, 0.5, FORWARD);
    drive(kickOff, SIM_STEP, {}, true);
    expect(kickOff.movement.ladder).toBeNull();
    expect(kickOff.player.vy).toBeGreaterThan(0);
    expect(kickOff.player.vx).toBeLessThan(0); // pushed off the face, westward
  });
});

describe('look', () => {
  it('consumes mouse deltas exactly once, however many steps a frame runs', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    sim.input.yawDelta = 0.5;
    sim.input.pitchDelta = -0.25;
    sim.step(SIM_STEP);
    expect(sim.player.yaw).toBeCloseTo(0.5, 6);
    expect(sim.player.pitch).toBeCloseTo(-0.25, 6);
    sim.step(SIM_STEP);
    expect(sim.player.yaw).toBeCloseTo(0.5, 6);
    expect(sim.input.yawDelta).toBe(0);
  });

  it('clamps pitch and wraps yaw', () => {
    const sim = fresh();
    place(sim, 2, 0, 45);
    sim.input.pitchDelta = 5;
    sim.step(SIM_STEP);
    expect(sim.player.pitch).toBeLessThan(Math.PI / 2);
    expect(sim.player.pitch).toBeGreaterThan(Math.PI / 2 - 0.1);
    sim.input.yawDelta = 7;
    sim.step(SIM_STEP);
    expect(Math.abs(sim.player.yaw)).toBeLessThanOrEqual(Math.PI);
  });
});
