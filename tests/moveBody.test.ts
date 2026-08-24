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
import { StaticWorld, aabbFromBounds, moveBody, type MoveResult } from '../src/core/collision';
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
  w.add(aabbFromBounds(-20, -1, -20, 20, 0, 20));
  return w;
}

/** Copies the shared result object, which the next `moveBody` call would otherwise overwrite. */
function snapshot(r: MoveResult): MoveResult {
  return { ...r };
}

describe('walking into a wall', () => {
  function wallWorld(): StaticWorld {
    const w = flatWorld();
    w.add(aabbFromBounds(2, 0, -20, 3, 3, 20));
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
    w.add(aabbFromBounds(2, 0, -20, 20, h, 20));
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
    const w = riserWorld(0.25);
    const p = new THREE.Vector3(1.63, 0, 0);
    const v = new THREE.Vector3(3.5, 0, 0);
    const r = moveBody(w, p, v, DT, SHAPE, false);
    expect(r.stepUp).toBe(0);
    expect(p.y).toBe(0);
  });
});

describe('ground snap', () => {
  /** Upper floor (top y = 0) for x <= 0; a lower ledge beyond it. */
  function lipWorld(dropTop: number): StaticWorld {
    const w = new StaticWorld();
    w.add(aabbFromBounds(-20, -1, -20, 0, 0, 20));
    w.add(aabbFromBounds(0, -2, -20, 20, dropTop, 20));
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

  it('SUSPECTED BUG: a body resting on the floor "lands" again every single tick', () => {
    // Gravity is re-applied every tick, so every tick the feet dip below the floor and the same
    // vertical pass calls it a fresh landing at `gravity * dt`. `PlayerController.onLanded` — and
    // therefore its `land` event — fires 120 times a second while simply standing still.
    // `game.ts` masks it by discarding impacts under LANDING_MIN_IMPACT (5 m/s), so nothing
    // reaches the sound bus, but any new consumer of `land` gets the spam.
    const w = flatWorld();
    const p = new THREE.Vector3(0, 0, 0);
    const v = new THREE.Vector3(0, 0, 0);
    const gravity = 16; // defaultMovementTunables().gravity
    const speeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      v.y -= gravity * DT; // what PlayerController.simulate does before moveBody
      speeds.push(moveBody(w, p, v, DT, SHAPE, true).landingSpeed);
    }
    expect(speeds).toEqual([gravity * DT, gravity * DT, gravity * DT]);
    expect(p.y).toBe(0);
  });

  it('clamps the head to a ceiling and zeroes the rise', () => {
    const w = flatWorld();
    w.add(aabbFromBounds(-20, 2, -20, 20, 3, 20));
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
    const alongX = aabbFromBounds(2, 0, -20, 3, 2, 2);
    const alongZ = aabbFromBounds(-20, 0, 2, 2, 2, 3);
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

describe('the shared MoveResult', () => {
  it('HAZARD: every call returns the same object, overwriting the previous result', () => {
    // `moveBody` returns a module-level singleton. Holding on to a result across a second call —
    // two bodies in one tick, a queued replay, a diagnostic that logs later — silently reads the
    // *newer* values. Pinned so that the next work item's fix (returning a fresh object, or
    // taking an out-parameter) shows up here as a deliberate change and not as a regression.
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
    });
  });
});
