/**
 * Characterization tests for `moveBody` — the integrate-and-resolve core of movement.
 *
 * Same contract as `collision.test.ts`: these pin what the code does today. Every world here is
 * hand-built and tiny, and every tick is a real simulation tick (`dt = 1/120`, the rate
 * `core/loop.ts` runs at), so the numbers are the ones the game actually produces.
 *
 * All arithmetic on these paths is `+ - * /` and `Math.sqrt`, so positions are asserted exactly.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  StaticWorld,
  aabbFromBounds,
  createMoveResult,
  moveBody,
  type Aabb,
  type MoveResult,
} from '../src/core/collision';
import { MAT_CONCRETE, MAT_METAL, MAT_STONE } from '../src/paint/materials';
import { defaultMovementTunables } from '../src/player/controller';

/**
 * The player's collider, spelled out rather than derived, so every number below is readable in
 * place. The test right underneath keeps it honest against `defaultMovementTunables()`.
 */
const SHAPE = { radius: 0.35, height: 1.7, stepHeight: 0.3 };

it('SHAPE is still the standing player collider', () => {
  const m = defaultMovementTunables();
  expect(SHAPE).toEqual({ radius: m.radius, height: m.standHeight, stepHeight: m.stepHeight });
});
/** `core/loop.ts` runs the simulation at 120 Hz and never hands `fixedUpdate` anything else. */
const DT = 1 / 120;

/** A 40 x 40 slab whose top is y = 0. */
function flatWorld(): StaticWorld {
  const w = new StaticWorld();
  w.add(aabbFromBounds(-20, -1, -20, 20, 0, 20, MAT_CONCRETE));
  return w;
}

/** Copies a result object, which the next `moveBody` call into it would otherwise overwrite. */
function snapshot(r: MoveResult): MoveResult {
  return { ...r };
}

describe('walking into a wall', () => {
  function wallWorld(): StaticWorld {
    const w = flatWorld();
    w.add(aabbFromBounds(2, 0, -20, 3, 3, 20, MAT_CONCRETE));
    return w;
  }

  it('stops at exactly wallFace - radius and zeroes the into-wall velocity', () => {
    const w = wallWorld();
    const p = new THREE.Vector3(0, 0, 0);
    const v = new THREE.Vector3(6, 0, 0);
    for (let i = 0; i < 200; i++) moveBody(w, p, v, DT, SHAPE, true);
    expect(p.x).toBe(2 - 0.35); // 1.65, bit-exact
    expect(p.y).toBe(0);
    expect(p.z).toBe(0);
    expect(v.x).toBe(0);
  });

  it('reports hitWall on the tick of contact but NOT once resting against it', () => {
    // SUSPECTED BUG (cosmetic, and load-bearing for anything that reads `hitWall` as
    // "am I against a wall"). After the push resolves, `2 - 0.35` is one ulp further from the
    // face than `0.35`, so `d2 > radius²` and `circlePush` returns null: the resting body reads
    // as touching nothing. `hitWall` is therefore an *edge*, not a state, and only by accident.
    const w = wallWorld();
    const p = new THREE.Vector3(1.6, 0, 0);
    const v = new THREE.Vector3(6, 0, 0);
    const flags = [];
    for (let i = 0; i < 4; i++) flags.push(moveBody(w, p, v, DT, SHAPE, true).hitWall);
    expect(flags).toEqual([true, false, false, false]);
    expect(p.x).toBe(2 - 0.35);
  });

  it('SUSPECTED BUG: resolution is depenetration, not a sweep, so a big dt tunnels', () => {
    // The broadphase query covers the whole swept region, but `slideXZ` teleports the body to
    // `x + dx` and only then pushes it out of whatever it overlaps *there*. One second of travel
    // at 6 m/s lands the body 3 m past a 1 m wall, overlapping nothing, so nothing stops it.
    // Latent today — `core/loop.ts` only ever passes `stepSeconds` (1/120) — but any future
    // variable-dt path, or a fast dash chip, walks straight into it.
    const w = wallWorld();
    const p = new THREE.Vector3(0, 0, 0);
    const v = new THREE.Vector3(6, 0, 0);
    const r = moveBody(w, p, v, 1, SHAPE, true);
    expect(p.x).toBe(6);
    expect(r.hitWall).toBe(false);
  });

  it('SUSPECTED BUG: the same tunnelling drops a falling body through the floor', () => {
    const w = flatWorld();
    const p = new THREE.Vector3(0, 5, 0);
    const v = new THREE.Vector3(0, -10, 0);
    const r = moveBody(w, p, v, 1, SHAPE, false);
    expect(p.y).toBe(-5); // 4 m below the floor's underside
    expect(r.grounded).toBe(false);
    expect(r.landingSpeed).toBe(0);
  });
});

describe('step-up', () => {
  /** A riser of height `h` occupying everything from x = 2 outward. */
  function riserWorld(h: number): StaticWorld {
    const w = flatWorld();
    w.add(aabbFromBounds(2, 0, -20, 20, h, 20, MAT_CONCRETE));
    return w;
  }

  function walkInto(h: number): { x: number; y: number } {
    const w = riserWorld(h);
    const p = new THREE.Vector3(0, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    for (let i = 0; i < 200; i++) moveBody(w, p, v, DT, SHAPE, true);
    return { x: p.x, y: p.y };
  }

  it('climbs a riser at stepHeight', () => {
    const end = walkInto(0.3);
    expect(end.y).toBe(0.3);
    expect(end.x).toBeGreaterThan(5); // walked on over the top
  });

  it('is blocked by a riser above stepHeight, stopping at the face', () => {
    const end = walkInto(0.31);
    expect(end.y).toBe(0);
    expect(end.x).toBe(2 - 0.35);
  });

  it('the real threshold is stepHeight + EPS, not stepHeight', () => {
    // `slideXZ` treats a box as floor when `b.maxY <= feetY + EPS`, and the lifted pass puts the
    // feet at exactly `stepHeight`. So the tallest climbable riser is `stepHeight + 1e-3`.
    expect(walkInto(0.3 + 1e-3).y).toBe(0.301);
    expect(walkInto(0.3011).y).toBe(0);
  });

  it('reports the climb in `stepUp` on the tick it happens, and 0 afterwards', () => {
    const w = riserWorld(0.25);
    const p = new THREE.Vector3(1.63, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    const first = snapshot(moveBody(w, p, v, DT, SHAPE, true));
    expect(first.stepUp).toBe(0.25);
    expect(first.grounded).toBe(true);
    // Grounding by step-up is not a touchdown: the body never left the floor, it walked up a
    // kerb. Only the vertical pass's airborne→grounded edge fills `landingSpeed`.
    expect(first.landingSpeed).toBe(0);
    // The stepped branch publishes the *lifted* pass's hitWall, and up there nothing was hit.
    expect(first.hitWall).toBe(false);
    expect(p.y).toBe(0.25);
    expect(p.x).toBe(1.63 + 3.5 * DT);
    expect(v.x).toBe(3.5); // a step costs no speed

    const second = snapshot(moveBody(w, p, v, DT, SHAPE, true));
    expect(second.stepUp).toBe(0);
    expect(p.y).toBe(0.25);
  });

  it('never steps while airborne and not previously grounded', () => {
    // This is also what makes the step-up branch structurally incapable of being a landing:
    // it only runs when the body was already grounded, or the vertical pass grounded it first.
    const w = riserWorld(0.25);
    const p = new THREE.Vector3(1.63, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    const r = moveBody(w, p, v, DT, SHAPE, false);
    expect(r.stepUp).toBe(0);
    expect(r.landingSpeed).toBe(0);
    expect(p.y).toBe(0);
  });
});

describe('ground snap', () => {
  /** Upper floor (top y = 0) for x <= 0; a lower ledge beyond it. */
  function lipWorld(dropTop: number): StaticWorld {
    const w = new StaticWorld();
    w.add(aabbFromBounds(-20, -1, -20, 0, 0, 20, MAT_CONCRETE));
    w.add(aabbFromBounds(0, -2, -20, 20, dropTop, 20, MAT_CONCRETE));
    return w;
  }

  it('reattaches to a surface within stepHeight when walking off a lip', () => {
    const w = lipWorld(-0.25);
    const p = new THREE.Vector3(0.34, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    const r = moveBody(w, p, v, DT, SHAPE, true);
    expect(p.y).toBe(-0.25);
    expect(r.grounded).toBe(true);
    expect(r.landingSpeed).toBe(0); // a snap is not a landing
    expect(v.y).toBe(0);
  });

  it('does not snap when the body was already airborne', () => {
    const w = lipWorld(-0.25);
    const p = new THREE.Vector3(0.34, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    const r = moveBody(w, p, v, DT, SHAPE, false);
    expect(p.y).toBe(0);
    expect(r.grounded).toBe(false);
  });

  it('does not snap to a surface further than stepHeight down', () => {
    const w = lipWorld(-0.4);
    const p = new THREE.Vector3(0.34, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    const r = moveBody(w, p, v, DT, SHAPE, true);
    expect(p.y).toBe(0);
    expect(r.grounded).toBe(false);
  });
});

describe('walking down a flight of stairs', () => {
  /**
   * A descending flight in +x: a landing at y = 0 for x <= 0, then twelve 0.5 m treads each
   * dropping 0.25 m (inside `stepHeight`, so the ground snap carries the body down), then a
   * floor at y = -3 from x = 6 outward.
   */
  function stairsWorld(): StaticWorld {
    const w = new StaticWorld();
    w.add(aabbFromBounds(-20, -30, -20, 0, 0, 20, MAT_CONCRETE));
    for (let k = 0; k < 12; k++) {
      w.add(aabbFromBounds(k * 0.5, -30, -20, (k + 1) * 0.5, -0.25 * (k + 1), 20, MAT_CONCRETE));
    }
    w.add(aabbFromBounds(6, -30, -20, 20, -3, 20, MAT_CONCRETE));
    return w;
  }

  /**
   * The mutation this exists to kill. "One landing per jump" is satisfied by an implementation
   * that fires a landing every time the *ground snap* reattaches the body — and a stair flight
   * reattaches it once per tread, all of them below `LANDING_MIN_IMPACT`, so the sound bus stays
   * silent and every jump-shaped test still passes. Descending three metres is one continuous
   * stance and must produce exactly zero landings.
   */
  it('descends three metres without a single landing', () => {
    const w = stairsWorld();
    const p = new THREE.Vector3(-1, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    let grounded = true;
    let landings = 0;
    let airborneTicks = 0;
    for (let i = 0; i < 300; i++) {
      v.y -= 16 * DT; // gravity, exactly as PlayerController applies it
      const r = moveBody(w, p, v, DT, SHAPE, grounded);
      grounded = r.grounded;
      if (r.landingSpeed !== 0) landings++;
      if (!grounded) airborneTicks++;
    }
    expect(landings).toBe(0);
    // Guards that make the zero worth something: it really walked the whole flight, and it did
    // it without ever leaving the ground, so there was never an edge to report.
    expect(p.x).toBeCloseTo(7.75, 9);
    expect(p.y).toBe(-3);
    expect(airborneTicks).toBe(0);
  });

  it('but stepping off the same flight into open air still lands, exactly once', () => {
    // The other half of the claim: the edge is suppressed because there is no edge, not because
    // landings stopped being reported. Same walk, but the far side is a 4 m drop instead of a
    // flight of treads — far beyond the snap tolerance, so the body genuinely goes airborne.
    const w = new StaticWorld();
    w.add(aabbFromBounds(-20, -30, -20, 0, 0, 20, MAT_CONCRETE));
    w.add(aabbFromBounds(0, -30, -20, 20, -4, 20, MAT_CONCRETE));
    const p = new THREE.Vector3(-1, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    let grounded = true;
    const impacts: number[] = [];
    for (let i = 0; i < 300; i++) {
      v.y -= 16 * DT;
      const r = moveBody(w, p, v, DT, SHAPE, grounded);
      grounded = r.grounded;
      if (r.landingSpeed !== 0) impacts.push(r.landingSpeed);
    }
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toBeGreaterThan(5); // and loud enough to clear LANDING_MIN_IMPACT
    expect(p.y).toBe(-4);
  });
});

describe('vertical resolution', () => {
  it('lands on the surface, records the impact speed and zeroes vy', () => {
    const w = flatWorld();
    const p = new THREE.Vector3(0, 0.05, 0);
    const v = new THREE.Vector3(0, -9, 0);
    const r = moveBody(w, p, v, DT, SHAPE, false);
    expect(p.y).toBe(0);
    expect(r.grounded).toBe(true);
    expect(r.landingSpeed).toBe(9);
    expect(v.y).toBe(0);
  });

  it('a body already resting on the floor never lands again', () => {
    // The pass a resting body takes is bit-for-bit the pass a touchdown takes: gravity dips the
    // feet through the floor plane, the same branch snaps them back. Only `wasGrounded` tells
    // the two apart. Without that test this reported `gravity * dt` on every single tick — 120
    // landings a second for standing still — which `LANDING_MIN_IMPACT` masked downstream
    // rather than fixed.
    const w = flatWorld();
    const p = new THREE.Vector3(0, 0, 0);
    const v = new THREE.Vector3(0, 0, 0);
    const gravity = 16; // defaultMovementTunables().gravity
    const speeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      v.y -= gravity * DT; // what PlayerController.simulate does before moveBody
      speeds.push(moveBody(w, p, v, DT, SHAPE, true).landingSpeed);
    }
    expect(speeds).toEqual([0, 0, 0]);
    // ...and it is still standing on the floor, so the resolution itself did happen.
    expect(p.y).toBe(0);
    expect(v.y).toBe(0);
  });

  it('reports the touchdown on the arrival tick only, then 0 while it rests', () => {
    // The edge, driven the way the controller drives it: gravity every tick, `wasGrounded` fed
    // back from the previous result. One number, then silence.
    const w = flatWorld();
    const p = new THREE.Vector3(0, 0.05, 0);
    const v = new THREE.Vector3(0, -9, 0);
    const gravity = 16;
    const speeds: number[] = [];
    let grounded = false;
    for (let i = 0; i < 5; i++) {
      v.y -= gravity * DT;
      const r = moveBody(w, p, v, DT, SHAPE, grounded);
      grounded = r.grounded;
      speeds.push(r.landingSpeed);
    }
    expect(speeds[0]).toBeCloseTo(9 + gravity * DT, 12);
    expect(speeds.slice(1)).toEqual([0, 0, 0, 0]);
    expect(p.y).toBe(0);
  });

  it('clamps the head to a ceiling and zeroes the rise', () => {
    const w = flatWorld();
    w.add(aabbFromBounds(-20, 2, -20, 20, 3, 20, MAT_CONCRETE));
    const p = new THREE.Vector3(0, 0.28, 0);
    const v = new THREE.Vector3(0, 5.4, 0);
    const r = moveBody(w, p, v, DT, SHAPE, false);
    expect(p.y).toBe(2 - 1.7);
    expect(r.hitCeiling).toBe(true);
    expect(r.grounded).toBe(false);
    expect(v.y).toBe(0);
  });

  it('rising freely leaves hitCeiling false', () => {
    const w = flatWorld();
    const p = new THREE.Vector3(0, 0, 0);
    const v = new THREE.Vector3(0, 5.4, 0);
    const r = moveBody(w, p, v, DT, SHAPE, false);
    expect(p.y).toBe(5.4 * DT);
    expect(r.hitCeiling).toBe(false);
    expect(v.y).toBe(5.4);
  });
});

describe('an inner corner (two boxes pushing at once)', () => {
  /** Two walls meeting at a right angle around (2, 2). */
  function cornerWorld(order: 'xFirst' | 'zFirst'): StaticWorld {
    const w = flatWorld();
    const alongX = aabbFromBounds(2, 0, -20, 3, 2, 2, MAT_CONCRETE);
    const alongZ = aabbFromBounds(-20, 0, 2, 2, 2, 3, MAT_CONCRETE);
    if (order === 'xFirst') {
      w.add(alongX);
      w.add(alongZ);
    } else {
      w.add(alongZ);
      w.add(alongX);
    }
    return w;
  }

  function driveIntoCorner(order: 'xFirst' | 'zFirst', ticks: number) {
    const w = cornerWorld(order);
    const p = new THREE.Vector3(1.8, 0, 1.8);
    const v = new THREE.Vector3(4, 0, 4);
    let r!: MoveResult;
    for (let i = 0; i < ticks; i++) r = moveBody(w, p, v, DT, SHAPE, true);
    return { x: p.x, z: p.z, vx: v.x, vz: v.z, r: snapshot(r) };
  }

  it('resolves both pushes in one tick to the exact corner pose', () => {
    // The order-sensitivity tripwire. `slideXZ` applies pushes sequentially, each onto the
    // position the previous one left, and iterates at most 4 times. These exact coordinates are
    // therefore a function of the candidate order the broadphase produced.
    const out = driveIntoCorner('xFirst', 1);
    expect(out.x).toBe(2 - 0.35);
    expect(out.z).toBe(2 - 0.35);
    expect(out.vx).toBe(0);
    expect(out.vz).toBe(0);
    expect(out.r.hitWall).toBe(true);
    expect(out.r.grounded).toBe(true);
  });

  it('is order-independent for this symmetric corner (the 4 iterations reach a fixpoint)', () => {
    const a = driveIntoCorner('xFirst', 20);
    const b = driveIntoCorner('zFirst', 20);
    expect(a).toEqual(b);
    expect(a.x).toBe(2 - 0.35);
    expect(a.z).toBe(2 - 0.35);
  });
});

describe('the MoveResult out-parameter', () => {
  it('SHARP EDGE of the default path: omitting `out` returns one reused singleton', () => {
    // Documented, not a bug: with no `out`, `moveBody` writes into a module-level instance so the
    // hot path allocates nothing. Reading it immediately — which is what every caller in the game
    // does — is correct. *Holding* it across a second call is not: the second call overwrites it
    // in place, and the first caller silently reads the newer body's answer. A caller that needs
    // its result to survive another body's move passes its own `out` (test below); this pins that
    // the cheap default is still the cheap default, so the change stayed bit-neutral.
    const w = flatWorld();

    const pLand = new THREE.Vector3(0, 0.05, 0);
    const vLand = new THREE.Vector3(0, -9, 0);
    const first = moveBody(w, pLand, vLand, DT, SHAPE, false);
    expect(first.grounded).toBe(true);
    expect(first.landingSpeed).toBe(9);

    const pAir = new THREE.Vector3(0, 5, 0);
    const vAir = new THREE.Vector3(0, 1, 0);
    const second = moveBody(w, pAir, vAir, DT, SHAPE, false);

    expect(second).toBe(first); // same reference
    expect(first.grounded).toBe(false); // the first caller's answer is gone
    expect(first.landingSpeed).toBe(0);
  });

  it('two bodies with their own `out` keep independent results across interleaved calls', () => {
    // The N-entity case M2 (thrown props) and M4 (spiders) create: several bodies moved one after
    // another inside a single fixed update, each keeping its own flags. Two lanes of one world so
    // the bodies genuinely produce different answers rather than coincidentally matching ones.
    const w = flatWorld();
    const floor = w.boxes[0]!;
    w.add(aabbFromBounds(2, 0, -20, 3, 3, 0, MAT_CONCRETE)); // lane A (z <= 0): a full-height wall
    // lane B (z >= 5): a 0.25 m riser
    const riser = w.add(aabbFromBounds(2, 0, 5, 20, 0.25, 20, MAT_CONCRETE));

    const outA = createMoveResult();
    const outB = createMoveResult();
    expect(outA).not.toBe(outB);

    // A falls onto the floor and slams into the wall; B walks up the riser.
    const pA = new THREE.Vector3(1.7, 0.05, -5);
    const vA = new THREE.Vector3(6, -9, 0);
    const pB = new THREE.Vector3(1.63, 0, 10);
    const vB = new THREE.Vector3(3.5, 0, 0);

    const rA = moveBody(w, pA, vA, DT, SHAPE, false, outA);
    expect(rA).toBe(outA);
    const aBeforeB = snapshot(outA);

    const rB = moveBody(w, pB, vB, DT, SHAPE, true, outB);
    expect(rB).toBe(outB);
    expect(rB).not.toBe(rA);

    // A's answer survived B's move untouched — the whole point of the parameter.
    expect(snapshot(outA)).toEqual(aBeforeB);
    expect(snapshot(outA)).toEqual({
      grounded: true,
      hitCeiling: false,
      hitWall: true,
      stepUp: 0,
      landingSpeed: 9,
      // The slab it fell onto — not the wall it is pressed against.
      groundBox: floor,
    });
    expect(snapshot(outB)).toEqual({
      grounded: true,
      hitCeiling: false,
      hitWall: false,
      stepUp: 0.25,
      landingSpeed: 0,
      // The step-up branch: grounded on the tread it climbed, not on the floor it left.
      groundBox: riser,
    });

    // Second interleaved round: A now rests against the wall, B walks on along the riser top.
    moveBody(w, pA, vA, DT, SHAPE, true, outA);
    moveBody(w, pB, vB, DT, SHAPE, true, outB);
    expect(snapshot(outA)).toEqual({
      grounded: true,
      hitCeiling: false,
      hitWall: false, // `hitWall` is an edge, not a state — see the wall test above
      stepUp: 0,
      landingSpeed: 0,
      groundBox: floor,
    });
    expect(snapshot(outB)).toEqual({
      grounded: true,
      hitCeiling: false,
      hitWall: false,
      stepUp: 0, // the climb already happened
      landingSpeed: 0,
      // Still the riser, found by the ground snap this time rather than by the step-up.
      groundBox: riser,
    });
  });

  it('a caller-owned `out` is untouched by moves that do not name it', () => {
    const w = flatWorld();
    const mine = createMoveResult();
    const p = new THREE.Vector3(0, 0.05, 0);
    const v = new THREE.Vector3(0, -9, 0);
    moveBody(w, p, v, DT, SHAPE, false, mine);
    const held = snapshot(mine);
    expect(held.landingSpeed).toBe(9);

    // Somebody else's body, moved on the default (shared) path.
    const pOther = new THREE.Vector3(0, 50, 0);
    const vOther = new THREE.Vector3(0, 0, 0);
    const shared = moveBody(w, pOther, vOther, DT, SHAPE, false);
    expect(shared).not.toBe(mine);
    expect(snapshot(mine)).toEqual(held);
  });

  it('resets every field at the top of each call', () => {
    const w = flatWorld();
    const p = new THREE.Vector3(0, 0.05, 0);
    const v = new THREE.Vector3(0, -9, 0);
    moveBody(w, p, v, DT, SHAPE, false);
    const p2 = new THREE.Vector3(0, 50, 0);
    const v2 = new THREE.Vector3(0, 0, 0);
    expect(snapshot(moveBody(w, p2, v2, DT, SHAPE, false))).toEqual({
      grounded: false,
      hitCeiling: false,
      hitWall: false,
      stepUp: 0,
      landingSpeed: 0,
      groundBox: null,
    });
  });
});

describe('an empty world', () => {
  it('integrates position freely and reports nothing', () => {
    const w = new StaticWorld();
    const p = new THREE.Vector3(1, 2, 3);
    const v = new THREE.Vector3(4, -5, 6);
    const r = snapshot(moveBody(w, p, v, DT, SHAPE, true));
    expect(p.x).toBe(1 + 4 * DT);
    expect(p.y).toBe(2 - 5 * DT);
    expect(p.z).toBe(3 + 6 * DT);
    expect(r).toEqual({
      grounded: false, hitCeiling: false, hitWall: false, stepUp: 0, landingSpeed: 0,
      groundBox: null,
    });
  });
});

describe('groundBox — which surface the feet are on (§3.9)', () => {
  /**
   * Added with material voices: how loud a footfall is now depends on what it struck, so the
   * emitter has to know which box that was. The answer has to come from the collision pass
   * itself — a downward raycast asking the same question a second time is a second opinion, and
   * the tick the two disagree is a tick the game reports a sound the physics did not make.
   */
  it('is the very box the body landed on, not a copy of it', () => {
    const w = new StaticWorld();
    const slab = w.add(aabbFromBounds(-20, -1, -20, 20, 0, 20, MAT_METAL));
    const p = new THREE.Vector3(0, 0.05, 0);
    const v = new THREE.Vector3(0, -9, 0);
    const r = moveBody(w, p, v, DT, SHAPE, false);
    expect(r.grounded).toBe(true);
    // Identity, not equality: the point of carrying the box is that `mat` is the world's own.
    expect(r.groundBox).toBe(slab);
    expect(r.groundBox!.mat).toBe(MAT_METAL);
  });

  it('is null while airborne, even in a result that was grounded a tick ago', () => {
    // The staleness case, and the reason `groundBox` is cleared at the top of the call with the
    // rest of the flags. A result that keeps last tick's floor reports a surface under a body
    // that is nowhere near it.
    const w = flatWorld();
    const out = createMoveResult();
    const p = new THREE.Vector3(0, 0.05, 0);
    const v = new THREE.Vector3(0, -9, 0);
    moveBody(w, p, v, DT, SHAPE, false, out);
    expect(out.groundBox).not.toBeNull();

    const pAir = new THREE.Vector3(0, 50, 0);
    const vAir = new THREE.Vector3(0, -1, 0);
    moveBody(w, pAir, vAir, DT, SHAPE, false, out);
    expect(out.grounded).toBe(false);
    expect(out.groundBox).toBeNull();
  });

  it('follows the body from one surface to the next, and reports each one', () => {
    // Two slabs of different materials side by side. The body walks off the first and onto the
    // second, and the answer changes on the tick the feet do — which is the whole mechanism
    // behind "a change of timbre mid-stride is a change of surface" (§3.9).
    const w = new StaticWorld();
    const west = w.add(aabbFromBounds(-20, -1, -20, 0, 0, 20, MAT_CONCRETE));
    const east = w.add(aabbFromBounds(0, -1, -20, 20, 0, 20, MAT_METAL));
    const p = new THREE.Vector3(-1, 0, 0);
    const v = new THREE.Vector3(4, 0, 0);
    const seen: (number | null)[] = [];
    for (let tick = 0; tick < 120; tick++) {
      v.y -= 9.81 * DT;
      const r = moveBody(w, p, v, DT, SHAPE, true);
      seen.push(r.groundBox === null ? null : r.groundBox.mat);
    }
    expect(seen[0]).toBe(MAT_CONCRETE);
    expect(seen[seen.length - 1]).toBe(MAT_METAL);
    expect(west.mat).not.toBe(east.mat);
    expect(seen).not.toContain(null); // never left the ground: both slabs are one flat plane
  });

  it('the step-up branch reports the tread it climbed, not the floor it left', () => {
    // `landingSpeed` deliberately stays 0 here (a flight of stairs is one continuous stance),
    // but the surface still changed, and the two answer different questions.
    const w = new StaticWorld();
    w.add(aabbFromBounds(-20, -1, -20, 20, 0, 20, MAT_CONCRETE));
    const tread = w.add(aabbFromBounds(2, 0, -20, 20, 0.25, 20, MAT_STONE));
    const p = new THREE.Vector3(1.63, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    const r = moveBody(w, p, v, DT, SHAPE, true);
    expect(r.stepUp).toBeGreaterThan(0);
    expect(r.landingSpeed).toBe(0);
    expect(r.groundBox).toBe(tread);
  });

  it('the ground-snap branch reports the step it settled onto', () => {
    // Walking off a lip: the body is reattached by the snap rather than by the vertical pass,
    // and that branch has to answer too or a footfall on the lower step goes silent-by-default.
    const w = new StaticWorld();
    const upper = w.add(aabbFromBounds(-20, -1, -20, 0, 0, 20, MAT_CONCRETE));
    const lower = w.add(aabbFromBounds(0, -1, -20, 20, -0.25, 20, MAT_STONE));
    const p = new THREE.Vector3(-0.1, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    let last: Aabb | null = null;
    for (let tick = 0; tick < 30; tick++) {
      const r = moveBody(w, p, v, DT, SHAPE, true);
      if (r.groundBox !== null) last = r.groundBox;
    }
    expect(upper.mat).not.toBe(lower.mat);
    expect(last).toBe(lower);
    expect(p.y).toBeCloseTo(-0.25, 6);
  });

  it('is non-null exactly when grounded, across every branch', () => {
    // The invariant the emitters lean on: `grounded` without a surface would be a footfall with
    // no material, and a surface without `grounded` would be a footfall in mid-air.
    const w = flatWorld();
    w.add(aabbFromBounds(2, 0, -20, 20, 0.25, 20, MAT_STONE));
    const p = new THREE.Vector3(0, 4, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    let grounded = false;
    let sawBoth = 0;
    for (let tick = 0; tick < 240; tick++) {
      v.y -= 9.81 * DT;
      const r = moveBody(w, p, v, DT, SHAPE, grounded);
      expect(r.grounded, `tick ${tick}`).toBe(r.groundBox !== null);
      if (r.grounded !== grounded) sawBoth++;
      grounded = r.grounded;
    }
    // The run really did pass through both states, so the invariant was tested and not assumed.
    expect(sawBoth).toBeGreaterThan(0);
    expect(grounded).toBe(true);
  });
});
