/**
 * M2 ADVERSARIAL REVIEW — the camera rig (visual-brief §1.8, comfort laws vision §12).
 *
 * Contract under test:
 *   vision §12   "Comfort floor: FOV 80–110, no motion blur, toggleable bob/shake,
 *                reduce-flashing mode, ping spacing ≥0.75 s, chroma-not-luminance pulses."
 *   visual-brief §1.8  "FOV widens on sprint, head cadence locks to footfall audio, landings
 *                dip, slides tilt."
 *   movement.ts:813  "Comfort laws (vision §12) are structural here: FOV stays inside 80–110,
 *                bob is capped at HEAD_BOB_MAX and can be switched off entirely (`motionEffects`)."
 *   vision §1.2  the system never lies — and §3.1, the only thing you see without sound is a
 *                contact shell around your body, which cannot describe an eye inside a wall.
 *
 * Labels: PIN = passes today, pins verified-correct behaviour. BUG = fails today, on purpose.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPSULE_RADIUS,
  COYOTE_TIME,
  EYE_CROUCH,
  EYE_STAND,
  FOV_BASE,
  FOV_SPRINT_KICK,
  HEAD_BOB_MAX,
  LANDING_DIP_MAX,
  SIM_STEP,
  SLIDE_TILT_DEG,
} from '../src/core/const.js';
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

/** Open floor plus one low duct with a 1.3 m underside — a slide-under, not a walk-under. */
const DUCT_UNDER = 1.3;
const gym: MapDef = {
  name: 'review camera gym',
  solids: [
    box('floor', 'floor', 0, -1, 0, 200, 0, 200),
    box('duct', 'beam', 20, DUCT_UNDER, 10, 30, 2.4, 16),
  ],
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [5, 0, 13], yaw: 0 },
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
const deg = (rad: number): number => (rad * 180) / Math.PI;

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
  sim.bus.reset();
}

/** Step the sim and the rig together, exactly as a 60 Hz frame would. */
function tick(sim: Sim, rig: CameraRig, patch: Partial<MoveInput>): void {
  Object.assign(sim.input, NEUTRAL, patch);
  sim.step(SIM_STEP);
  rig.update(SIM_STEP, sim.movement);
}

/** Carve a slide and return the roll the rig settles on, in degrees. */
function carve(right: number): number {
  const sim = new Sim(gym);
  const rig = new CameraRig();
  place(sim, 5, 0, 60);
  for (let i = 0; i < steps(1.5); i++) tick(sim, rig, { forward: 1, sprint: true });
  let settled = 0;
  for (let i = 0; i < steps(0.8); i++) {
    tick(sim, rig, { forward: 1, right, sprint: true, crouch: true });
    if (sim.movement.sliding) settled = deg(rig.roll);
  }
  return settled;
}

// ==========================================================================================
// BUG — the slide tilt does not tell you which way you are carving
// ==========================================================================================

describe('BUG · slide roll is asymmetric (visual-brief §1.8 "slides tilt")', () => {
  /**
   * movement.ts:839 —
   *   rollTarget = SLIDE_TILT_DEG * (0.4 + 0.6 * lateral)
   * `lateral` is the signed sideways component of the carve, but the 0.4 base lean is NOT signed,
   * so the expression only goes negative past lateral < -0.667. A left carve and a right carve
   * therefore tilt the camera the SAME way over most of the steering range, and a straight slide
   * is permanently tilted 1.6° to one side. vision §12 requires meaning to be readable by more
   * than hue — a direction cue that points the wrong way is worse than none.
   */
  it('expected: a straight slide is level — actual: it leans 1.6°', () => {
    expect(Math.abs(carve(0))).toBeLessThan(0.2);
  });

  it('expected: carving left mirrors carving right — actual: both lean the same way', () => {
    const r = carve(1);
    const l = carve(-1);
    expect(r).toBeGreaterThan(0.5); // a right carve does tilt
    expect(l, `right ${r.toFixed(2)}° vs left ${l.toFixed(2)}°`).toBeCloseTo(-r, 1);
  });

  it('expected: |roll| never exceeds SLIDE_TILT_DEG in either direction', () => {
    // The positive side already spends its whole budget on one direction: 4 * (0.4 + 0.6) = 4°
    // right, but only 4 * (0.4 - 0.6) = -0.8° left. The cue is 5x weaker on one side.
    const r = Math.abs(carve(1));
    const l = Math.abs(carve(-1));
    expect(Math.max(r, l)).toBeLessThanOrEqual(SLIDE_TILT_DEG + 1e-6);
    expect(Math.min(r, l) / Math.max(r, l), `${r.toFixed(2)}° vs ${l.toFixed(2)}°`).toBeGreaterThan(0.8);
  });
});

// ==========================================================================================
// BUG — "toggleable bob/shake" toggles only the bob
// ==========================================================================================

describe('BUG · motionEffects does not disable the shake (vision §12 "toggleable bob/shake")', () => {
  /**
   * movement.ts:850 gates ONLY `bobY` on `motionEffects`. The landing dip (:843-847) and the slide
   * tilt (:832-841) — the two things a comfort-sensitive player actually needs off, because they
   * move the horizon rather than the eye height — keep running. main.ts:188 wires `?nobob` and
   * main.ts:131 wires the B key to the same single flag, so there is no way to turn the shake off.
   */
  it('expected: with bob off, a landing does not dip the camera — actual: it dips the full amount', () => {
    const sim = new Sim(gym);
    const rig = new CameraRig();
    rig.motionEffects = false;
    place(sim, 60, 0, 60);
    sim.player.y = 6;
    sim.player.grounded = false;
    sim.player.stance = 'air';
    sim.movement.apexY = 6;
    let worstDip = 0;
    for (let i = 0; i < steps(3); i++) {
      tick(sim, rig, {});
      worstDip = Math.max(worstDip, rig.dip);
    }
    expect(sim.movement.lastFall).toBeGreaterThan(4); // it really was a big landing
    expect(worstDip).toBe(0);
  });

  it('expected: with bob off, a slide does not roll the horizon — actual: it rolls 3.3°', () => {
    const sim = new Sim(gym);
    const rig = new CameraRig();
    rig.motionEffects = false;
    place(sim, 5, 0, 60);
    for (let i = 0; i < steps(1.5); i++) tick(sim, rig, { forward: 1, sprint: true });
    let worstRoll = 0;
    for (let i = 0; i < steps(0.8); i++) {
      tick(sim, rig, { forward: 1, right: 1, sprint: true, crouch: true });
      worstRoll = Math.max(worstRoll, Math.abs(deg(rig.roll)));
    }
    expect(worstRoll).toBe(0);
  });
});

// ==========================================================================================
// BUG — the smoothed eye height is not clamped to headroom
// ==========================================================================================

describe('BUG (minor) · a last-moment slide puts the eye inside the duct for ~50 ms', () => {
  /**
   * movement.ts:827 — `eyeY = damp(eyeY, m.eyeTarget, EYE_SMOOTH, dt)`. The BODY drops to crouch
   * height on the frame the slide starts and the collider is honest about the duct from that
   * frame on, but the EYE eases down over ~0.2 s. Crouch early (a metre or more out) and the eye
   * has settled by the time the head sphere crosses the soffit; crouch at the last instant the
   * collider still allows and the camera spends three frames up to 0.20 m INSIDE the slab.
   *
   * Small — 50 ms, and only on a late input — but it is the one class of image vision §3.1 has
   * no way to render honestly: there is no "inside matter" state, so the frame shows the far
   * side of a wall you are technically still outside of. Severity: NIT, listed because the fix
   * is a two-line clamp of `eyeY` to the headroom the collider already computes.
   */
  it('expected: the eye never rises above a 1.3 m soffit the head is under — actual: 1.50 m', () => {
    const sim = new Sim(gym);
    const rig = new CameraRig();
    place(sim, 14, 0, 13);
    let framesInside = 0;
    let worst = 0;
    for (let i = 0; i < steps(2.5); i++) {
      // 19.6 is the last trigger that still fits: the standing capsule is stopped at 19.65.
      tick(sim, rig, { forward: 1, sprint: true, crouch: sim.player.x > 19.6 });
      const eye = sim.player.y + rig.eyeOffset;
      const headFront = sim.player.x + CAPSULE_RADIUS;
      if (headFront > 20 && sim.player.x < 30 && eye > DUCT_UNDER) {
        framesInside++;
        worst = Math.max(worst, eye);
      }
    }
    expect(sim.player.x, 'expected to actually get under the duct').toBeGreaterThan(22);
    expect(
      framesInside,
      `${framesInside} frames with the eye up to ${worst.toFixed(3)} m (duct underside ${DUCT_UNDER} m)`,
    ).toBe(0);
  });
});

// ==========================================================================================
// PIN — the comfort laws that ARE enforced
// ==========================================================================================

describe('PIN · the rig respects the vision §12 comfort floor', () => {
  it('keeps FOV strictly inside 80–110 through every gait change', () => {
    const sim = new Sim(gym);
    const rig = new CameraRig();
    place(sim, 5, 0, 60);
    let lo = Infinity;
    let hi = -Infinity;
    const script: Array<Partial<MoveInput>> = [
      { forward: 1, sprint: true },
      { forward: 1 },
      { forward: 1, crouch: true },
      {},
      { forward: 1, sprint: true },
      { forward: 1, sprint: true, crouch: true },
      { forward: 1, sprint: true, jumpPressed: true },
    ];
    for (const patch of script) {
      for (let i = 0; i < steps(1); i++) {
        tick(sim, rig, patch);
        lo = Math.min(lo, rig.fov);
        hi = Math.max(hi, rig.fov);
      }
    }
    expect(lo).toBeGreaterThanOrEqual(80);
    expect(hi).toBeLessThanOrEqual(110);
    expect(lo).toBeGreaterThanOrEqual(FOV_BASE - 1e-6); // never narrows below the base
    expect(hi).toBeLessThanOrEqual(FOV_BASE + FOV_SPRINT_KICK + 1e-6);
  });

  it('settles at FOV_BASE standing and FOV_BASE + kick at a full sprint', () => {
    const sim = new Sim(gym);
    const rig = new CameraRig();
    place(sim, 5, 0, 60);
    for (let i = 0; i < steps(3); i++) tick(sim, rig, {});
    expect(rig.fov).toBeCloseTo(FOV_BASE, 2);
    for (let i = 0; i < steps(3); i++) tick(sim, rig, { forward: 1, sprint: true });
    expect(rig.fov).toBeCloseTo(FOV_BASE + FOV_SPRINT_KICK, 1);
  });

  it('bounds the landing dip and consumes the impulse exactly once', () => {
    const sim = new Sim(gym);
    const rig = new CameraRig();
    place(sim, 60, 0, 60);
    sim.player.y = 12;
    sim.player.grounded = false;
    sim.player.stance = 'air';
    sim.movement.apexY = 12;
    let worst = 0;
    for (let i = 0; i < steps(4); i++) {
      tick(sim, rig, {});
      worst = Math.max(worst, rig.dip);
      expect(sim.movement.landingImpulse).toBe(0); // consumed on the frame it appeared
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(LANDING_DIP_MAX + 1e-9);
    expect(rig.dip).toBeLessThan(0.001); // and it decays away
  });

  it('caps head bob at HEAD_BOB_MAX and really does stop when motionEffects is false', () => {
    const on = new Sim(gym);
    const rigOn = new CameraRig();
    place(on, 5, 0, 60);
    let worstOn = 0;
    for (let i = 0; i < steps(4); i++) {
      tick(on, rigOn, { forward: 1, sprint: true });
      worstOn = Math.max(worstOn, Math.abs(rigOn.bobY));
    }
    expect(worstOn).toBeGreaterThan(0);
    expect(worstOn).toBeLessThanOrEqual(HEAD_BOB_MAX + 1e-9);

    const off = new Sim(gym);
    const rigOff = new CameraRig();
    rigOff.motionEffects = false;
    place(off, 5, 0, 60);
    for (let i = 0; i < steps(4); i++) tick(off, rigOff, { forward: 1, sprint: true });
    expect(Math.abs(rigOff.bobY)).toBeLessThan(1e-6);
  });

  it('returns the roll to level and the eye to standing height after the slide', () => {
    const sim = new Sim(gym);
    const rig = new CameraRig();
    place(sim, 5, 0, 60);
    for (let i = 0; i < steps(1.5); i++) tick(sim, rig, { forward: 1, sprint: true });
    for (let i = 0; i < steps(0.6); i++) tick(sim, rig, { forward: 1, right: 1, sprint: true, crouch: true });
    expect(Math.abs(rig.roll)).toBeGreaterThan(0);
    expect(rig.eyeY).toBeLessThan(EYE_STAND);
    expect(rig.eyeY).toBeGreaterThanOrEqual(EYE_CROUCH - 1e-6);
    for (let i = 0; i < steps(3); i++) tick(sim, rig, { forward: 1 });
    expect(Math.abs(deg(rig.roll))).toBeLessThan(0.01);
    expect(rig.eyeY).toBeCloseTo(EYE_STAND, 3);
  });
});
