/**
 * Speed caps and the noise economy — what a body can reach, and what it pays to get there.
 *
 * Contract under test:
 *   vision §5    crouch 1.7 · walk 3.5 · sprint 6.0 m/s. Sprint is the top speed of a body.
 *   vision §3.3  the event table binds a gait to a paint radius and a hearing radius:
 *                crouch 1.5/2 · walk 4/11 · sprint 7/24.
 *   vision §3.8  "A ring around the reticle whose brightness equals your current audible radius…
 *                You always know exactly how loud you are. Non-negotiable."
 *   vision §1.1  every way of learning emits sound the world can hear. No free, silent intel.
 *   vision TL;DR "your own footsteps are your headlights; whatever lets you see also gives you away."
 *   const.ts     OVERSPEED_DECAY — "Excess speed bleeds instead of being clamped."
 *
 * Three review findings live here and each probe names the one it pins:
 *   B1  the air branch had no ceiling and the overspeed bleed sat inside the grounded branch, so
 *       a bunny-hop compounded speed without limit and never paid the bleed.
 *   B2a `land()` zeroed the banked stride on EVERY touchdown, so a hopping body was silent.
 *   B3  the footstep class was read off the held keys instead of off the body's speed.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCEL_AIR,
  AIR_WISH_CAP,
  COYOTE_TIME,
  EV,
  OVERSPEED_DECAY,
  SIM_STEP,
  SLIDE_BOOST_SPEED,
  SPEED_CROUCH,
  SPEED_SPRINT,
  SPEED_WALK,
  STRIDE_SPRINT,
} from '../src/core/const.js';
import { gaitForSpeed, stepClass, type MoveInput } from '../src/core/movement.js';
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

/**
 * A 600x600 floor (long runs need room and must never be stopped by an edge), one unclimbable
 * wall to rub in the SW corner, and one 90° inside corner to jam into. The open lane used by the
 * speed probes is the middle of the plate, far from every solid.
 */
const gym: MapDef = {
  name: 'speed gym',
  solids: [
    box('floor', 'floor', 0, -1, 0, 600, 0, 600),
    box('tall', 'wall', 10, 0, 30, 13, 3.6, 36),
    box('cornerA', 'wall', 40, 0, 40, 60, 4, 41),
    box('cornerB', 'wall', 40, 0, 41, 41, 4, 60),
  ],
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [300, 0, 300], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [600, 16, 600] }],
  markers: [],
  bounds: { min: [0, -1, 0], max: [600, 16, 600] },
};

/** Middle of the open plate — nothing within 200 m in any direction. */
const LANE: readonly [number, number] = [300, 300];

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

function drive(sim: Sim, seconds: number, patch: Partial<MoveInput> = {}, press = false): void {
  for (let i = 0; i < steps(seconds); i++) {
    Object.assign(sim.input, NEUTRAL, patch);
    if (press && i === 0) sim.input.jumpPressed = true;
    sim.step(SIM_STEP);
  }
}

const SPRINT = { forward: 1, sprint: true } as const;

/**
 * A textbook Quake/Source strafe-jump, expressed exactly as a mouse would express it: hold the
 * strafe key, and turn so the wish vector sits just off the velocity — the angle where the
 * projection onto wishdir is a hair under AIR_WISH_CAP, which is where `accelerate` pays out the
 * most. Setting `p.yaw` per step is what a mouse delta does (movement.ts step 1 applies the
 * delta before anything else), so nothing here is reaching past the input layer.
 */
function strafeJump(sim: Sim, seconds: number): { peak: number; distance: number } {
  const p = sim.player;
  let peak = 0;
  let distance = 0;
  const margin = ACCEL_AIR * SIM_STEP;
  for (let i = 0; i < steps(seconds); i++) {
    const v = Math.hypot(p.vx, p.vz);
    const theta = v > 0.01 ? Math.acos(Math.max(-1, Math.min(1, (AIR_WISH_CAP - margin) / v))) : 0;
    p.yaw = Math.atan2(p.vz, p.vx) + theta - Math.PI / 2;
    Object.assign(sim.input, NEUTRAL, { right: 1, jumpPressed: true });
    const x0 = p.x;
    const z0 = p.z;
    sim.step(SIM_STEP);
    distance += Math.hypot(p.x - x0, p.z - z0);
    peak = Math.max(peak, sim.movement.speedXZ);
  }
  return { peak, distance };
}

// ==========================================================================================
// The ceiling holds in the air too (review finding B1)
// ==========================================================================================

describe('air acceleration obeys the same ceiling as the ground (vision §5: 6.0 m/s is the top speed)', () => {
  /**
   * B1. The ground branch has always capped accel at `max(cap, before)` — accel may hold a speed
   * you already have but never raise you past your gait. The air branch had no such ceiling, and
   * the OVERSPEED_DECAY bleed lived INSIDE the `p.grounded` branch, which a bunny-hop never
   * enters: the jump verb clears `p.grounded` before the branch is chosen. So the two holes
   * compounded — a strafe-jump gained a little every frame and never paid any of it back.
   *
   * The fix hoists the bleed out of the grounded branch (it now runs on every frame, airborne
   * included, so the bunny-hop frame pays it) and gives the air branch the same
   * `ceiling = max(cap, before)` guard.
   */
  it('strafe-jumping never exceeds SPEED_SPRINT, however long it is held', () => {
    const sim = fresh();
    place(sim, LANE[0], 0, LANE[1]);
    drive(sim, 1.5, SPRINT);
    expect(sim.movement.speedXZ).toBeCloseTo(SPEED_SPRINT, 3);
    const { peak } = strafeJump(sim, 30);
    expect(peak).toBeLessThanOrEqual(SPEED_SPRINT + 1e-6);
  });

  it('has an asymptote: 10 s and 30 s of strafe-jumping end at the same speed', () => {
    const a = fresh();
    place(a, LANE[0], 0, LANE[1]);
    drive(a, 1.5, SPRINT);
    strafeJump(a, 10);
    const at10 = a.movement.speedXZ;

    const b = fresh();
    place(b, LANE[0], 0, LANE[1]);
    drive(b, 1.5, SPRINT);
    strafeJump(b, 30);
    const at30 = b.movement.speedXZ;

    expect(at30).toBeLessThan(at10 + 1);
    expect(at30).toBeLessThanOrEqual(SPEED_SPRINT + 1e-6);
  });

  it('the OVERSPEED_DECAY bleed still runs while airborne, so a bhop cannot bank a boost', () => {
    // Slide-boost past the sprint cap, then hold jump for 5 s. const.ts calls the bleed the reason
    // overspeed "only ever decays": at 2.2 m/s² five seconds is far more than enough to give the
    // whole boost back, and holding jump must not be a way to opt out of it.
    const sim = fresh();
    place(sim, LANE[0], 0, LANE[1]);
    drive(sim, 1.5, SPRINT);
    drive(sim, SIM_STEP, { ...SPRINT, crouch: true });
    const boosted = sim.movement.speedXZ;
    expect(boosted).toBeGreaterThan(SPEED_SPRINT);

    for (let i = 0; i < steps(5); i++) {
      Object.assign(sim.input, NEUTRAL, { ...SPRINT, jumpPressed: true });
      sim.step(SIM_STEP);
    }
    expect(sim.movement.speedXZ).toBeLessThanOrEqual(SPEED_SPRINT + OVERSPEED_DECAY * SIM_STEP);
  });
});

// ==========================================================================================
// A hopping body pays for its ground (review findings B2a and B2b)
// ==========================================================================================

describe('hopping is not a silent traversal mode (vision §1 law 1, TL;DR "footsteps are your headlights")', () => {
  /**
   * B2a. `land()` zeroed `strideAccum` on EVERY touchdown, above the `fall <= LANDING_MIN_FALL`
   * early-out — so a 1.1 m hop, which publishes no landing at all, still confiscated the distance
   * banked between hops and the accumulator could never reach a stride. Combined with B1, "run
   * fast and hold space" was free, silent, unbounded-speed traversal: exactly what law 1 forbids.
   * The fix moves the reset BELOW the early-out, so only a real landing spends the bank.
   *
   * B2b. On top of that, the jump verb itself now publishes at takeoff — the shove against the
   * floor is a real sound, and it is what makes a hop audible on the way UP as well as down.
   */
  it('30 s of strafe-jumping crosses a floor and is heard doing it', () => {
    const sim = fresh();
    place(sim, LANE[0], 0, LANE[1]);
    drive(sim, 1.5, SPRINT);
    sim.bus.reset();
    const { distance, peak } = strafeJump(sim, 30);
    // Law 5: capping the speed must not cripple the movement. 30 s still covers 180 m.
    expect(distance).toBeGreaterThan(170);
    expect(peak).toBeLessThanOrEqual(SPEED_SPRINT + 1e-6);
    expect(sim.bus.emitted).toBeGreaterThan(0);
  });

  it('hopping the same ground is heard on every hop, at the sprint row', () => {
    const hop = fresh();
    place(hop, LANE[0], 0, LANE[1]);
    drive(hop, 1.5, SPRINT);
    hop.bus.reset();
    const hx = hop.player.x;
    let takeoffs = 0;
    for (let i = 0; i < steps(6); i++) {
      const wasGrounded = hop.player.grounded;
      Object.assign(hop.input, NEUTRAL, { ...SPRINT, jumpPressed: true });
      hop.step(SIM_STEP);
      if (wasGrounded && !hop.player.grounded) takeoffs++;
    }
    const hopDistance = hop.player.x - hx;

    const run = fresh();
    place(run, LANE[0], 0, LANE[1]);
    drive(run, 1.5, SPRINT);
    run.bus.reset();
    const rx = run.player.x;
    drive(run, 6, SPRINT);
    const runDistance = run.player.x - rx;

    // Same ground covered at the same gait…
    expect(hopDistance).toBeGreaterThan(runDistance * 0.9);
    expect(takeoffs).toBeGreaterThan(4);
    // …and every shove is paid for: at least one event per hop (B2b), never fewer.
    expect(run.bus.emitted).toBeGreaterThan(5);
    expect(hop.bus.emitted).toBeGreaterThanOrEqual(takeoffs);
    // …at the loudest row a body that fast can publish, not a quieter one (B3).
    expect(hop.bus.counts.sprintStep).toBe(hop.bus.emitted);
  });

  it('land() only discards the banked stride for a real landing (B2a)', () => {
    // Bank a stride, then take a 0.3 m step-down — far below LANDING_MIN_FALL (2 m), so `land()`
    // publishes nothing. Measure the ground covered between the touchdown and the next footstep:
    // with 0.05 m left in the bank it must be a few centimetres, not a whole fresh stride.
    const sim = fresh();
    place(sim, LANE[0], 0, LANE[1]);
    drive(sim, 1.5, SPRINT);
    sim.movement.strideAccum = STRIDE_SPRINT - 0.05; // one tick short of publishing
    sim.player.y = 0.3;
    sim.player.grounded = false;
    sim.player.stance = 'air';
    sim.movement.apexY = 0.3;
    sim.bus.reset();

    let touchdownX = 0;
    let stepX = 0;
    for (let i = 0; i < steps(2); i++) {
      const wasAir = !sim.player.grounded;
      drive(sim, SIM_STEP, SPRINT);
      if (wasAir && sim.player.grounded) touchdownX = sim.player.x;
      if (touchdownX > 0 && sim.bus.emitted > 0) {
        stepX = sim.player.x;
        break;
      }
    }
    expect(sim.bus.counts.landing).toBe(0); // correct: 0.3 m is not a landing
    expect(stepX).toBeGreaterThan(0); // a footstep did eventually publish
    expect(stepX - touchdownX).toBeLessThan(0.5);
  });
});

// ==========================================================================================
// The class comes off the body, not off the keyboard (review finding B3)
// ==========================================================================================

describe('footstep class is derived from speed, not from held keys (vision §3.3, §3.8 Halo)', () => {
  /**
   * B3. The gait used to read
   *   crouched ? 'crouch' : (input.sprint && input.forward > 0 && speedXZ > SPEED_WALK) ? …
   * which consults the KEYBOARD, so the published class — and with it the paint radius and the
   * radius a dog hears — was a function of what the player was holding rather than of how fast
   * the body was actually moving. §3.8 promises the opposite: the Halo's brightness IS your
   * audible radius, always, so releasing shift for one tick must not halve it.
   *
   * The fix derives the gait from `speedXZ` against the §5 bands (≤ SPEED_CROUCH → crouch,
   * ≤ SPEED_WALK → walk, else sprint), with a crouched STANCE still forcing crouch; the stride
   * length follows the same derived gait. Keys still choose the TARGET speed — they just no
   * longer get to lie about the result.
   */
  it('a 5.96 m/s step is a sprintStep even with shift released for one tick', () => {
    const sim = fresh();
    place(sim, LANE[0], 0, LANE[1]);
    drive(sim, 3, SPRINT);
    sim.movement.strideAccum = STRIDE_SPRINT - 0.02; // primed to publish on the next tick
    sim.bus.reset();
    drive(sim, SIM_STEP, { forward: 1 }); // shift released for exactly one 16 ms tick
    const e = sim.bus.last!;
    expect(sim.movement.speedXZ).toBeGreaterThan(SPEED_WALK * 1.5); // still ~5.96 m/s
    expect(e.class).toBe('sprintStep');
    expect(e.hearRadius).toBe(EV.sprintStep.hear);
  });

  it('there is no way to cover sprint ground at walk loudness', () => {
    // Tapping shift off for one tick in six. Identical route, identical distance, identical speed.
    const tapped = fresh();
    place(tapped, LANE[0], 0, LANE[1]);
    drive(tapped, 1.5, SPRINT);
    tapped.bus.reset();
    const tx = tapped.player.x;
    for (let i = 0; i < steps(10); i++) {
      Object.assign(tapped.input, NEUTRAL, { forward: 1, sprint: i % 6 !== 0 });
      tapped.step(SIM_STEP);
    }
    const tappedDistance = tapped.player.x - tx;

    const honest = fresh();
    place(honest, LANE[0], 0, LANE[1]);
    drive(honest, 1.5, SPRINT);
    honest.bus.reset();
    const hx = honest.player.x;
    drive(honest, 10, SPRINT);
    const honestDistance = honest.player.x - hx;

    expect(tappedDistance / honestDistance).toBeGreaterThan(0.99); // same 60 m, same speed
    expect(honest.bus.counts.sprintStep).toBeGreaterThan(5);
    // The loudest thing published must not depend on a key-tap that costs no ground.
    const loudestTapped = Math.max(
      ...(['crouchStep', 'walkStep', 'sprintStep'] as const).map((c) =>
        tapped.bus.counts[c] > 0 ? EV[c].hear : 0,
      ),
    );
    expect(loudestTapped).toBe(EV.sprintStep.hear);
  });

  it('moving faster than a sprint publishes the sprint row, whatever the keys say', () => {
    // Slide-boost past the cap and then hold forward ONLY — no shift, so the old keyboard gait
    // would have called this a walkStep: 4 m of paint and 11 m of hearing for a body doing
    // 7.4 m/s. The derived gait reads the body instead, and the overspeed window is a sprint.
    const sim = fresh();
    place(sim, LANE[0], 0, LANE[1]);
    drive(sim, 1.5, SPRINT);
    drive(sim, SIM_STEP, { ...SPRINT, crouch: true }); // slide boost past SPEED_SPRINT
    sim.bus.reset();
    let first: null | { cls: string; hear: number; speed: number } = null;
    for (let i = 0; i < steps(2) && !first; i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1 });
      sim.step(SIM_STEP);
      if (sim.bus.last) {
        first = {
          cls: sim.bus.last.class,
          hear: sim.bus.last.hearRadius,
          speed: sim.movement.speedXZ,
        };
      }
    }
    expect(first!.speed).toBeGreaterThan(SPEED_SPRINT);
    expect(first!.cls).toBe('sprintStep');
    expect(first!.hear).toBe(EV.sprintStep.hear);
  });

  it('the three §5 bands map onto the three §3.3 rows, edges included', () => {
    // The derived gait is the whole of the Halo's promise, so the band edges are pinned on the
    // mapping itself — a driven body cannot be parked on an exact edge, friction moves it.
    for (const [speed, cls] of [
      [0, 'crouchStep'],
      [0.5, 'crouchStep'],
      [SPEED_CROUCH, 'crouchStep'],
      [SPEED_CROUCH + 0.01, 'walkStep'],
      [SPEED_WALK, 'walkStep'],
      [SPEED_WALK + 0.01, 'sprintStep'],
      [SPEED_SPRINT, 'sprintStep'],
      [SLIDE_BOOST_SPEED, 'sprintStep'],
      [40, 'sprintStep'],
    ] as Array<[number, string]>) {
      expect(stepClass(gaitForSpeed(speed, false)), `${speed} m/s`).toBe(cls);
    }
    // A crouched STANCE still forces the crouch row however fast something else made you travel:
    // sneaking is a posture, and it is the one case where the keys legitimately win.
    for (const speed of [0, SPEED_WALK, SPEED_SPRINT, SLIDE_BOOST_SPEED]) {
      expect(stepClass(gaitForSpeed(speed, true)), `crouched at ${speed} m/s`).toBe('crouchStep');
    }
  });
});

// ==========================================================================================
// Ground accel cannot manufacture speed against geometry (the M2 fix, broadened)
// ==========================================================================================

describe('ground accel cannot manufacture speed against geometry', () => {
  it('holds at every approach angle and in every gait', () => {
    for (const deg of [5, 10, 20, 30, 45, 60, 75, 85]) {
      for (const [name, patch, cap] of [
        ['sprint', { forward: 1, sprint: true }, SPEED_SPRINT],
        ['walk', { forward: 1 }, SPEED_WALK],
        ['crouch', { forward: 1, crouch: true }, SPEED_CROUCH],
      ] as Array<[string, Partial<MoveInput>, number]>) {
        const sim = fresh();
        place(sim, 9, 0, 30.5, (deg * Math.PI) / 180);
        let peak = 0;
        for (let i = 0; i < steps(2); i++) {
          Object.assign(sim.input, NEUTRAL, patch);
          sim.step(SIM_STEP);
          peak = Math.max(peak, sim.movement.speedXZ);
        }
        expect(peak, `${deg}° ${name}`).toBeLessThanOrEqual(cap + 1e-6);
      }
    }
  });

  it('holds in a 90° inside corner, where both axes are being clamped at once', () => {
    const sim = fresh();
    place(sim, 44, 0, 44, -Math.PI / 4 - Math.PI / 2);
    let peak = 0;
    for (let i = 0; i < steps(3); i++) {
      Object.assign(sim.input, NEUTRAL, SPRINT);
      sim.step(SIM_STEP);
      peak = Math.max(peak, sim.movement.speedXZ);
    }
    expect(peak).toBeLessThanOrEqual(SPEED_SPRINT + 1e-6);
    expect(sim.movement.speedXZ).toBeCloseTo(0, 3); // jammed, not squirting out
  });

  it('holds when a slide is driven into the wall (the slide keeps its own budget)', () => {
    const sim = fresh();
    place(sim, 6, 0, 30.5, Math.PI / 4);
    let peak = 0;
    for (let i = 0; i < steps(1.5); i++) {
      Object.assign(sim.input, NEUTRAL, SPRINT);
      sim.step(SIM_STEP);
      peak = Math.max(peak, sim.movement.speedXZ);
    }
    for (let i = 0; i < steps(2); i++) {
      Object.assign(sim.input, NEUTRAL, { ...SPRINT, crouch: true });
      sim.step(SIM_STEP);
      peak = Math.max(peak, sim.movement.speedXZ);
    }
    expect(peak).toBeLessThanOrEqual(SLIDE_BOOST_SPEED + 1e-6);
  });

  it('rubbing a wall leaves no residual overspeed to drift on (deviation 6)', () => {
    const sim = fresh();
    place(sim, 9, 0, 30.5, Math.PI / 4);
    for (let i = 0; i < steps(1.2); i++) {
      Object.assign(sim.input, NEUTRAL, SPRINT);
      sim.step(SIM_STEP);
    }
    expect(sim.movement.speedXZ).toBeLessThanOrEqual(SPEED_SPRINT + 1e-6);
    // Let go: friction owns the step, and the body stops inside the normal braking distance.
    drive(sim, 0.5);
    expect(sim.movement.speedXZ).toBe(0);
  });
});

// ==========================================================================================
// Inherited overspeed, and the parts of air control that were always right
// ==========================================================================================

describe('inherited overspeed decays on the ground, and air control adds nothing forward', () => {
  it('bleeds a slide boost back to the gait cap at OVERSPEED_DECAY', () => {
    const sim = fresh();
    place(sim, LANE[0], 0, LANE[1]);
    drive(sim, 1.5, SPRINT);
    drive(sim, SIM_STEP, { ...SPRINT, crouch: true });
    const boosted = sim.movement.speedXZ;
    expect(boosted).toBeGreaterThan(SPEED_SPRINT);
    drive(sim, SIM_STEP, SPRINT); // let go of crouch: slide over, overspeed inherited
    const t0 = sim.time;
    while (sim.movement.speedXZ > SPEED_SPRINT + 1e-4 && sim.time - t0 < 5) drive(sim, SIM_STEP, SPRINT);
    expect(sim.time - t0).toBeCloseTo((boosted - SPEED_SPRINT) / OVERSPEED_DECAY, 1);
    expect(sim.movement.speedXZ).toBeCloseTo(SPEED_SPRINT, 3);
  });

  it('holding forward in the air buys nothing (Source-style air control)', () => {
    const sim = fresh();
    place(sim, LANE[0], 0, LANE[1]);
    drive(sim, 1.5, SPRINT);
    let peak = 0;
    for (let i = 0; i < steps(10); i++) {
      Object.assign(sim.input, NEUTRAL, { ...SPRINT, jumpPressed: true });
      sim.step(SIM_STEP);
      peak = Math.max(peak, sim.movement.speedXZ);
    }
    expect(peak).toBeLessThanOrEqual(SPEED_SPRINT + 1e-6);
  });

  it('never rations movement: 20 s of sprint is as fast at the end as at the start (law 5)', () => {
    const sim = fresh();
    place(sim, 100, 0, LANE[1]);
    drive(sim, 20, SPRINT);
    expect(sim.player.x - 100).toBeGreaterThan(115); // it really did run 120 m of open floor
    expect(sim.movement.speedXZ).toBeCloseTo(SPEED_SPRINT, 3);
  });
});
