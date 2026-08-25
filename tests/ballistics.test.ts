/**
 * `stepBallistic` — the swept integrator a thrown body runs on.
 *
 * Same contract as `moveBody.test.ts`: hand-built worlds, real simulation ticks (`dt = 1/120`,
 * the rate `core/loop.ts` runs at), and exact numbers wherever the arithmetic allows one. All
 * of it is `+ − * /`, `Math.sqrt` and `Math.hypot`, so a body moving along an axis is asserted
 * to the bit; the oblique cases pay one normalise-and-rescale round trip for their direction and
 * are asserted `toBeCloseTo(_, 12)` with the plane they landed on checked separately.
 *
 * **This file is a mutation net, not a description.** The integrator has no callers yet, so
 * nothing downstream would notice if it quietly stopped sweeping, stopped standing off, or
 * started reflecting a `t = 0` contact — and each of those is a bug that looks like nothing at
 * all until a can is falling through the tower. Every test below names the mutation it is here
 * to kill, and the two loudest ones (a sweep that does not reach, a standoff of zero) were
 * verified by actually making the mutation and watching this file go red.
 */

import { describe, expect, it } from 'vitest';
import { StaticWorld, aabbFromBounds, type Aabb } from '../src/core/collision';
import { MAT_CONCRETE, MAT_DUST, MAT_METAL, MAT_STONE } from '../src/paint/materials';
import { LANDING_MIN_IMPACT } from '../src/paint/soundEvents';
import {
  defaultBallisticTunables,
  stepBallistic,
  wakeBallistic,
  type BallisticBody,
  type BallisticContact,
  type BallisticTunables,
} from '../src/core/ballistics';

/** `core/loop.ts` runs the simulation at 120 Hz and never hands `fixedUpdate` anything else. */
const DT = 1 / 120;

const T = defaultBallisticTunables();

/**
 * The defaults with a few fields moved. Several tests want gravity off — not because a can flies
 * level, but because a horizontal question deserves a horizontal answer, and an arc drags a
 * `√(vx² + vy²)` into every number that was going to be exact.
 */
function tuned(overrides: Partial<BallisticTunables>): BallisticTunables {
  return { ...defaultBallisticTunables(), ...overrides };
}

/** A 40 × 40 slab whose top is y = 0. */
function flatWorld(): StaticWorld {
  const w = new StaticWorld();
  w.add(aabbFromBounds(-20, -1, -20, 20, 0, 20, MAT_CONCRETE));
  return w;
}

function bodyAt(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  grounded = false,
): BallisticBody {
  return { x, y, z, vx, vy, vz, grounded, asleep: false };
}

/**
 * Steps a body until it sleeps or the tick budget runs out, keeping every record it produced.
 *
 * The records are safe to keep because `stepBallistic` allocates fresh ones — the array it
 * writes into is cleared per call, and a caller that had to copy each record before the next
 * tick would be a caller that could not merge two bodies' logs, which is exactly what the
 * throwable system does.
 */
interface Flight {
  log: BallisticContact[];
  ticks: number;
  /** Lowest y the body ever held, at the end of any tick. */
  minY: number;
  /** Highest y reached between one contact and the next: one entry per flight segment. */
  apexes: number[];
}

function fly(
  world: StaticWorld,
  body: BallisticBody,
  maxTicks: number,
  t: BallisticTunables = T,
): Flight {
  const contacts: BallisticContact[] = [];
  const log: BallisticContact[] = [];
  const apexes: number[] = [];
  let minY = body.y;
  let peak = -Infinity;
  let ticks = 0;
  for (; ticks < maxTicks && !body.asleep; ticks++) {
    stepBallistic(world, body, DT, contacts, t);
    if (contacts.length > 0) {
      if (peak > -Infinity) apexes.push(peak);
      peak = -Infinity;
      for (const c of contacts) log.push(c);
    }
    if (body.y > peak) peak = body.y;
    if (body.y < minY) minY = body.y;
  }
  return { log, ticks, minY, apexes };
}

function kinds(log: readonly BallisticContact[]): string[] {
  return log.map((c) => c.kind);
}

function normalOf(c: BallisticContact): [number, number, number] {
  return [c.nx, c.ny, c.nz];
}

/** True when the point is strictly inside any box — the one thing physics may never produce. */
function insideAnyBox(world: StaticWorld, body: BallisticBody): boolean {
  for (const b of world.boxes) {
    if (body.x <= b.minX || body.x >= b.maxX) continue;
    if (body.y <= b.minY || body.y >= b.maxY) continue;
    if (body.z <= b.minZ || body.z >= b.maxZ) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Free flight
// ---------------------------------------------------------------------------

describe('free flight', () => {
  it('applies gravity to the velocity before moving, not after', () => {
    // Semi-implicit Euler, the convention `PlayerController` already uses: one tick from rest
    // falls by `g·dt²`, not by zero. The mutation this exists to kill — move first, then apply
    // gravity — leaves `y` at exactly 10 for a body that started with no velocity: a first tick
    // of free fall that goes nowhere, and is invisible in every downstream number afterwards.
    const world = flatWorld();
    const body = bodyAt(0, 10, 0, 0, 0, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, T);
    expect(body.vy).toBe(-(16 * DT));
    expect(body.y).toBe(10 - 16 * DT * DT);
    expect(contacts).toHaveLength(0);
  });

  it('carries horizontal velocity untouched — no drag, no friction in the air', () => {
    const world = flatWorld();
    const body = bodyAt(0, 10, 0, 6, 0, -3);
    const contacts: BallisticContact[] = [];
    for (let i = 0; i < 20; i++) stepBallistic(world, body, DT, contacts, T);
    expect(body.vx).toBe(6);
    expect(body.vz).toBe(-3);
    expect(body.x).toBeCloseTo(6 * 20 * DT, 12);
    expect(body.z).toBeCloseTo(-3 * 20 * DT, 12);
  });

  it('falls the closed-form discrete distance over twenty ticks', () => {
    // Σ g·dt²·k for k = 1..n — the discrete free fall, which is `g·dt²·n(n+1)/2` and not
    // the continuous ½gt². Pins that exactly one gravity step happens per tick.
    const world = flatWorld();
    const body = bodyAt(0, 10, 0, 0, 0, 0);
    const contacts: BallisticContact[] = [];
    const n = 20;
    for (let i = 0; i < n; i++) stepBallistic(world, body, DT, contacts, T);
    expect(body.y).toBeCloseTo(10 - 16 * DT * DT * ((n * (n + 1)) / 2), 12);
  });
});

// ---------------------------------------------------------------------------
// 2–3. The sweep: the pane, and the tick boundary
// ---------------------------------------------------------------------------

describe('a pane thinner than one tick of travel', () => {
  /**
   * The centrepiece. `moveBody` cannot do this — `slideXZ` teleports to `p + v·dt` and pushes
   * out of whatever it overlaps *there*, and `circlePush` ejects through the nearest face, so a
   * step landing past the midplane exits the far side. Measured on the real thing: a 0.06 m body at
   * 24 m/s passes clean through a 0.1 m wall. Every trap the tower plans is thinner than that.
   *
   * The phase sweep is the point. A single start position proves nothing: a can that happens to
   * land its tick boundary on the near face is stopped by an integrator that never swept at all.
   * Forty phases across one full step length means no implementation gets to be lucky.
   *
   * Named mutations that must fail here:
   *  (a) *integrate, then depenetrate* — advance `p += v·dt` before casting: the cast starts on
   *      the far side and the pane is behind it.
   *  (b) *a sweep that does not reach* — `maxDist = speed·tRemain / 2` while the miss branch
   *      still advances the whole remainder: at any phase where the pane sits in the far half of
   *      the step, the cast reports clear and the body walks through. Verified by mutation.
   */
  for (const [thickness, speed] of [
    [0.05, 15],
    [0.05, 24],
    [0.02, 24],
  ] as const) {
    it(`stops a ${speed} m/s body at a ${thickness} m pane from every launch phase`, () => {
      const step = speed * DT;
      for (let phase = 0; phase < 40; phase++) {
        const world = flatWorld();
        const pane = world.add(aabbFromBounds(2, 0, -20, 2 + thickness, 3, 20, MAT_METAL));
        const body = bodyAt(-(phase / 40) * step, 1, 0, speed, 0, 0);
        let furthest = body.x;
        const contacts: BallisticContact[] = [];
        const log: BallisticContact[] = [];
        for (let i = 0; i < 400; i++) {
          stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
          for (const c of contacts) log.push(c);
          if (body.x > furthest) furthest = body.x;
        }
        // Never past the near face, on any tick — not merely "ended up on the right side".
        expect(furthest).toBeLessThan(2);
        expect(kinds(log)).toEqual(['bounce']);
        expect(log[0]!.box).toBe(pane);
        expect(log[0]!.speed).toBe(speed);
        expect(normalOf(log[0]!)).toEqual([-1, 0, 0]);
        expect(body.vx).toBe(-(0.45 * speed));
      }
    });
  }

  it('strikes a wall standing at exactly one tick of travel, this tick', () => {
    // `raycastWorld`'s inclusive `maxDist`, consumed. The exclusive reading leaves the body
    // exactly touching the wall with its velocity unreversed and defers the whole contact to the
    // next tick, which is one tick of a can sitting inside the surface it just reached.
    const world = flatWorld();
    world.add(aabbFromBounds(2, 0, -20, 2.05, 3, 20, MAT_CONCRETE));
    const body = bodyAt(2 - 15 * DT, 1, 0, 15, 0, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
    expect(kinds(contacts)).toEqual(['bounce']);
    expect(contacts[0]!.x).toBe(2);
    expect(body.vx).toBe(-6.75);
    expect(body.x).toBe(2 - T.skin);
  });

  it('does not strike a wall a hair beyond one tick of travel', () => {
    // The other half of "inclusive": the boundary is a boundary, not a reach-further licence.
    const world = flatWorld();
    world.add(aabbFromBounds(2, 0, -20, 2.05, 3, 20, MAT_CONCRETE));
    const body = bodyAt(2 - 15 * DT - 1e-6, 1, 0, 15, 0, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
    expect(contacts).toHaveLength(0);
    expect(body.vx).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 4–5. Bounce
// ---------------------------------------------------------------------------

describe('bounce', () => {
  it('returns restitution × the approach and keeps tangentKeep × the tangent', () => {
    // Exact, on purpose: 0.45 × 8 and 0.75 × 4 are both representable, so a dropped `(1 + e)`,
    // a sign flip, or restitution applied to the tangent all miss by a mile rather than by an
    // ulp. The recorded `speed` is the *approach*, not the rebound — what you hear is the energy
    // that arrived.
    const world = flatWorld();
    const body = bodyAt(0, 0.05, 0, 4, -8, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
    expect(kinds(contacts)).toEqual(['bounce']);
    expect(contacts[0]!.speed).toBe(8);
    expect(normalOf(contacts[0]!)).toEqual([0, 1, 0]);
    expect(body.vy).toBe(3.6);
    expect(body.vx).toBe(3);
    expect(body.vz).toBe(0);
  });

  it('stands the body off along the normal, never leaving it on the face', () => {
    const world = flatWorld();
    const body = bodyAt(0, 0.05, 0, 0, -8, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
    expect(contacts[0]!.y).toBe(0); // the contact is on the face
    expect(body.y).toBeGreaterThanOrEqual(T.skin); // the body is not
  });

  it('spends itself: apexes shrink, and a two-metre drop is asleep in 139 ticks', () => {
    // Four independent fences stop a can bouncing forever, and this is all of them at once:
    // geometric decay (e² per apex), the `bounceMin` cut that ends the Zeno tail, the roll to
    // `restSpeed`, and `maxSweeps`. The mutation this catches is `restitution = 1`: the body
    // never stops bouncing and the tick count becomes the budget rather than a settle.
    // (`tangentKeep = 1` does *not* show up here and the claim that it would is wrong — a
    // straight drop has no tangent to keep. It is caught by the bounce arithmetic above and by
    // the oblique chain below, which is where a tangent exists.)
    const world = flatWorld();
    const body = bodyAt(0, 2, 0, 0, 0, 0);
    const flight = fly(world, body, 120 * 30);
    expect(kinds(flight.log)).toEqual(['bounce', 'bounce', 'ground', 'rest']);
    expect(flight.ticks).toBe(139);
    expect(body.asleep).toBe(true);
    // Apex after the first bounce, then after the second: each strictly lower, and the last one
    // is the resting pose rather than a hop.
    expect(flight.apexes[1]).toBeCloseTo(0.406, 3);
    expect(flight.apexes[2]).toBeCloseTo(0.0826, 4);
    for (let i = 2; i < flight.apexes.length; i++) {
      expect(flight.apexes[i]!).toBeLessThan(flight.apexes[i - 1]!);
    }
    expect(flight.minY).toBe(T.skin);
  });

  it('grounds out instead of bouncing once the rebound would fall under bounceMin', () => {
    // The physics cut, isolated: 2.2 m/s of approach rebounds at 0.99 and is a touchdown; 2.3
    // rebounds at 1.035 and is a bounce. Nothing about audibility is involved — that floor lives
    // in the emitter, and conflating the two would tie "can you hear it" to "does it still hop".
    const world = flatWorld();
    const soft = bodyAt(0, 0.01, 0, 0, -2.2, 0);
    const softContacts: BallisticContact[] = [];
    stepBallistic(world, soft, DT, softContacts, tuned({ gravity: 0 }));
    expect(kinds(softContacts)).toEqual(['ground']);
    expect(soft.grounded).toBe(true);
    expect(soft.vy).toBe(0);

    const hard = bodyAt(0, 0.01, 0, 0, -2.3, 0);
    const hardContacts: BallisticContact[] = [];
    stepBallistic(world, hard, DT, hardContacts, tuned({ gravity: 0 }));
    expect(kinds(hardContacts)).toEqual(['bounce']);
    expect(hard.grounded).toBe(false);
    expect(hard.vy).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6–7. The two degenerate answers `raycastWorld` is allowed to give
// ---------------------------------------------------------------------------

describe('the standoff', () => {
  it('keeps every contact in a bounce chain an honest floor hit', () => {
    // The mutation: `skin = 0`. Then a resolved contact leaves the body sitting exactly on the
    // face, and the next cast of the same tick starts from a point *on* a surface — where
    // `raycastWorld` answers `t = 0` with whichever face the ray leaves through first. For the
    // upward, forward direction a bounce produces that is the floor's own top, reversed:
    // `(0, −1, 0)`. The clamp then kills the rebound inside the tick that created it, and the
    // can never leaves the ground again. (For a downward-sloping roll it is worse and stranger —
    // the answer is a *sideways* face, `(−1, 0, 0)`, naming a wall twenty metres away.)
    //
    // So: every normal in the chain is the floor's, the body never dips below the floor's top,
    // and the bounces actually go somewhere.
    const world = flatWorld();
    const body = bodyAt(0, 0.5, 0, 3, -6, 0);
    const flight = fly(world, body, 120 * 30);
    expect(kinds(flight.log)).toEqual(['bounce', 'bounce', 'ground', 'rest']);
    for (const c of flight.log) expect(normalOf(c)).toEqual([0, 1, 0]);
    expect(flight.minY).toBe(T.skin);
    expect(flight.apexes[1]).toBeCloseTo(0.3157, 4);
    expect(flight.apexes[2]).toBeCloseTo(0.0627, 4);
    expect(body.asleep).toBe(true);
  });

  it('is exactly one skin, along the normal, on a wall as well as on a floor', () => {
    const world = flatWorld();
    world.add(aabbFromBounds(1, 0, -20, 2, 3, 20, MAT_STONE));
    const body = bodyAt(0.9, 1, 0, 12, 0, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
    expect(contacts[0]!.x).toBe(1);
    expect(body.x).toBe(1 - T.skin);
    expect(body.y).toBe(1);
  });
});

describe('a t = 0 contact', () => {
  it('separates without reflecting, so a body on a face is never bounced by it', () => {
    // `raycastWorld` pins that `t = 0` is contact rather than impact: there is no approach to
    // reverse. The mutation — drop the `hit.t > 0` guard and let a `t = 0` answer take the bounce
    // branch — manufactures energy out of a query result and makes a can resting on a floor hop
    // off it.
    //
    // The approach speed here is 4 m/s and that is load-bearing: the mutation only shows itself
    // above `bounceMin / restitution` = 2.22 m/s, because below that the bounce branch is not
    // taken either way and the two implementations agree. The first draft of this test used 2 m/s
    // and the mutation survived it — a test that can only see a bug in half the input range is
    // not a test of the guard, it is a test of the threshold.
    const world = flatWorld();
    const body = bodyAt(0, 0, 0, 0, -4, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
    expect(kinds(contacts)).toEqual(['graze']);
    expect(contacts[0]!.speed).toBe(4);
    expect(body.vy).toBe(0); // zeroed, not reversed — and emphatically not +1.8
    expect(body.y).toBe(T.skin);
    // A separation is not a landing: the touchdown that grounds this body is the honest `t > 0`
    // contact it makes on the next tick, once gravity has given it somewhere to fall from.
    expect(body.grounded).toBe(false);
  });

  it('recovers a body spawned inside a box instead of oscillating in it', () => {
    // The defensive path, and the reason the thrower's spawn contract exists rather than a throw
    // here: the reversed exit-face normal plus the clamp walk an illegal pose back out over a
    // few ticks. Ugly, bounded, and it ends with the body resting legally on top of the slab.
    const world = flatWorld();
    const body = bodyAt(0, -0.3, 0, 2, 0, 0);
    const flight = fly(world, body, 120 * 10);
    expect(body.asleep).toBe(true);
    expect(insideAnyBox(world, body)).toBe(false);
    expect(body.y).toBeGreaterThanOrEqual(0);
    expect(flight.log.every((c) => c.speed >= 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8–9. More than one contact in a tick
// ---------------------------------------------------------------------------

describe('several contacts in one tick', () => {
  it('resolves a wall then the floor inside one tick, in the order they were struck', () => {
    // 12 right, 16 down: speed exactly 20, direction exactly (0.6, −0.8, 0), so the geometry is
    // arranged rather than approximated. The wall is 0.03 m away along x and the floor 0.09 m
    // below; the tick reaches 1/6 m, which is enough for both.
    //
    // Mutations: *return after the first hit* loses the second record entirely; *consume
    // distance instead of time* leaves the same two records but puts the body somewhere else
    // (the second segment's leftover is 0.0619 m of travel instead of 0.0017 s of it — an eight
    // centimetre difference in the final pose), which is why the pose is asserted and not just
    // the log.
    const world = flatWorld();
    const wall = world.add(aabbFromBounds(1, 0, -20, 3, 3, 20, MAT_METAL));
    const body = bodyAt(0.97, 0.09, 0, 12, -16, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));

    expect(kinds(contacts)).toEqual(['bounce', 'bounce']);
    expect(contacts[0]!.box).toBe(wall);
    expect(normalOf(contacts[0]!)).toEqual([-1, 0, 0]);
    expect(contacts[0]!.x).toBe(1);
    expect(contacts[0]!.y).toBeCloseTo(0.05, 12);
    expect(contacts[1]!.box).toBe(world.boxes[0]);
    expect(normalOf(contacts[1]!)).toEqual([0, 1, 0]);
    expect(contacts[1]!.x).toBeCloseTo(0.9765, 12);
    expect(contacts[1]!.y).toBeCloseTo(0, 12);
    // Both approaches are 12: the wall takes the horizontal component, the floor takes what the
    // wall's tangent handed on.
    expect(contacts[0]!.speed).toBe(12);
    expect(contacts[1]!.speed).toBeCloseTo(12, 12);

    expect(body.vx).toBeCloseTo(-4.05, 12);
    expect(body.vy).toBeCloseTo(5.4, 12);
    expect(body.x).toBeCloseTo(0.96975, 12);
    expect(body.y).toBeCloseTo(0.01, 12);
  });

  it('drops the residual motion when the sweep budget runs out, and never the containment', () => {
    // A 0.05 m slot at 200 m/s: the tick wants 1.67 m of travel and gets four bounces out of it,
    // which is the whole budget. What is left over is thrown away — a couple of centimetres lost
    // inside a wedge is the safe direction to be wrong in, and ending the tick inside a wall is
    // not. The final pose is exactly the last standoff: one skin off the face it last struck.
    const world = new StaticWorld();
    world.add(aabbFromBounds(-1, -1, -5, 0, 3, 5, MAT_CONCRETE));
    world.add(aabbFromBounds(0.05, -1, -5, 1, 3, 5, MAT_CONCRETE));
    const body = bodyAt(0.025, 1, 0, 200, 0, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));

    expect(kinds(contacts)).toEqual(['bounce', 'bounce', 'bounce', 'bounce']);
    expect(contacts).toHaveLength(T.maxSweeps);
    expect(body.x).toBe(T.skin);
    expect(body.x).toBeGreaterThan(0);
    expect(body.x).toBeLessThan(0.05);
    expect(insideAnyBox(world, body)).toBe(false);
    expect(Number.isFinite(body.vx)).toBe(true);
    expect(body.vx).toBeCloseTo(200 * 0.45 ** 4, 12);
  });
});

// ---------------------------------------------------------------------------
// 10–12. The ground regime
// ---------------------------------------------------------------------------

describe('roll, rest and sleep', () => {
  /**
   * A 0.05 m drop with 3 m/s of run-up, and the drop height is chosen rather than picked: nine
   * ticks of discrete free fall cover exactly `g·dt²·(9·10/2)` = 0.05 m, so the touchdown lands
   * exactly on a tick boundary at exactly the inclusive `maxDist`. That is what makes the roll
   * below closed-form: no fraction of a tick is spent between landing and rolling.
   */
  function landAndRoll(): { world: StaticWorld; body: BallisticBody; flight: Flight } {
    const world = flatWorld();
    const body = bodyAt(0, 0.05, 0, 3, 0, 0);
    return { world, body, flight: fly(world, body, 120 * 30) };
  }

  it('records exactly one touchdown, nothing at all while rolling, and one settle', () => {
    // The emission policy in one assertion. A per-tick rolling sound is not a tuning risk, it is
    // a measured catastrophe: the paint subscriber drains its whole pending job synchronously, so
    // an event per tick at prop-impact radii is 0.5–1× realtime spent in paint alone, the event
    // marker ring recycles in 4.3 s and the wave slots in 66 ms. Rolling is silent because the
    // physics has nothing to say about it, not because something downstream throttles it.
    //
    // Mutation: *re-fire the rest record every asleep tick* — the count goes from one to
    // hundreds while every other assertion here still passes.
    const { body, flight } = landAndRoll();
    expect(kinds(flight.log)).toEqual(['ground', 'rest']);
    expect(flight.log[0]!.speed).toBe(1.2); // nine ticks of gravity, exactly
    expect(flight.log[0]!.x).toBeCloseTo(0.225, 12); // nine ticks at 3 m/s, exactly
    expect(normalOf(flight.log[0]!)).toEqual([0, 1, 0]);
    expect(body.asleep).toBe(true);
    expect(body.grounded).toBe(true);
  });

  it('rolls the closed-form discrete distance and stops there', () => {
    // Speed decays by `rollDecel·dt` = 1/15 per tick *before* the body moves, so the k-th tick of
    // the roll travels `(3 − k/15)·dt`. The body sleeps on the first tick whose decayed speed is
    // under `restSpeed`: 3 − 43/15 = 0.133 < 0.15, so tick 43 stops and 42 ticks move. The sum is
    // an arithmetic series, and it is a genuinely independent prediction rather than the loop
    // written twice.
    const { body, flight } = landAndRoll();
    const moving = 42;
    const rolled = (moving * 3 - (moving * (moving + 1)) / 2 / 15) * DT;
    expect(body.x - flight.log[0]!.x).toBeCloseTo(rolled, 12);
    // And it is under the continuous bound, which is the number the retrieval promise leans on:
    // everything after the last audible contact is at most `v²/(2a)` of silent travel.
    expect(body.x - flight.log[0]!.x).toBeLessThan((3 * 3) / (2 * T.rollDecel));
  });

  it('rests exactly one skin above the surface it rests on, and names that surface', () => {
    const { world, body, flight } = landAndRoll();
    const rest = flight.log[1]!;
    expect(rest.kind).toBe('rest');
    expect(rest.speed).toBe(0);
    expect(body.y).toBeCloseTo(T.skin, 12);
    expect(rest.y).toBe(body.y);
    expect(rest.x).toBe(body.x);
    expect(rest.z).toBe(body.z);
    expect(rest.box).toBe(world.boxes[0]);
    expect(normalOf(rest)).toEqual([0, 1, 0]);
    expect(body.vx).toBe(0);
    expect(body.vy).toBe(0);
    expect(body.vz).toBe(0);
  });

  it('bounces off a wall it rolls into rather than sticking to it', () => {
    // A grounded body still meets walls, and it meets them as a can: the horizontal sweep from a
    // skin above the floor cannot see the floor it is standing on (a parallel ray from outside
    // the slab misses it), so the only thing in the way is the wall.
    const world = flatWorld();
    const wall = world.add(aabbFromBounds(1, 0, -20, 2, 3, 20, MAT_METAL));
    const body = bodyAt(0, T.skin, 0, 6, 0, 0, true);
    const flight = fly(world, body, 120 * 30);
    expect(kinds(flight.log)).toEqual(['bounce', 'rest']);
    expect(flight.log[0]!.box).toBe(wall);
    expect(normalOf(flight.log[0]!)).toEqual([-1, 0, 0]);
    expect(body.x).toBeLessThan(1);
    expect(body.asleep).toBe(true);
    expect(body.grounded).toBe(true);
  });

  it('calls a slow wall contact a graze, because a wall is not a floor', () => {
    // `ny > 0.5` is the whole difference between "landed" and "scraped", and it is only visible
    // on a contact too slow to bounce — a fast one is a `bounce` whichever face it struck. Widen
    // the test to `ny > -0.5` and this body reports a touchdown against a vertical wall two
    // metres in the air.
    //
    // The support probe is a second fence and would clear the bogus `grounded` at the end of this
    // very tick, which is exactly why the assertion is on the *record*: the wrong flag repairs
    // itself, the wrong sound does not.
    const world = flatWorld();
    world.add(aabbFromBounds(1, 0, -20, 2, 3, 20, MAT_METAL));
    const body = bodyAt(0.99, 2, 0, 2, 0, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
    expect(kinds(contacts)).toEqual(['graze']);
    expect(normalOf(contacts[0]!)).toEqual([-1, 0, 0]);
    expect(contacts[0]!.speed).toBe(2);
    expect(body.grounded).toBe(false);
    expect(body.vx).toBe(0); // the tangent survives, the into-wall component does not
    expect(body.x).toBe(1 - T.skin);
  });

  it('falls silently off an edge and pays for the landing on the floor below', () => {
    // The whole story in one run: roll, roll off, silence for the flight, one fresh touchdown on
    // the lower slab — carrying *that* slab's box, not the ledge's, because §3.9 makes the
    // struck surface the sound. The drop is 0.12 m so the landing arrives under `bounceMin` and
    // is a touchdown rather than a bounce; nothing about the silence depends on that.
    const world = new StaticWorld();
    const ledge = world.add(aabbFromBounds(-5, -1, -5, 0, 0, 5, MAT_METAL));
    const lower = world.add(aabbFromBounds(0, -1, -5, 20, -0.12, 5, MAT_DUST));
    const body = bodyAt(-0.1, T.skin, 0, 2, 0, 0, true);

    const contacts: BallisticContact[] = [];
    const log: { tick: number; contact: BallisticContact }[] = [];
    let leftTheLedge = -1;
    let ticks = 0;
    for (; ticks < 120 * 30 && !body.asleep; ticks++) {
      stepBallistic(world, body, DT, contacts, T);
      for (const c of contacts) log.push({ tick: ticks, contact: c });
      if (!body.grounded && leftTheLedge < 0) leftTheLedge = ticks;
    }

    // Both ticks pinned, because the interesting mutation is *remove the support probe*: without
    // it the body keeps rolling on nothing, out over the void at the ledge's height, and only
    // discovers the drop when the settle does its own probe. It still lands, still on the lower
    // slab, still with one record — the only thing that moves is *when* it stops being supported,
    // which is why that is the number asserted rather than the story around it.
    expect(leftTheLedge).toBe(6);
    expect(log[0]!.tick).toBe(21);
    expect(log[1]!.tick).toBe(42);
    expect(body.x).toBeGreaterThan(0); // it really went over the edge
    expect(kinds(log.map((l) => l.contact))).toEqual(['ground', 'rest']);
    expect(log[0]!.contact.box).toBe(lower);
    expect(log[0]!.contact.box).not.toBe(ledge);
    expect(log[0]!.contact.y).toBeCloseTo(-0.12, 12);
    expect(body.y).toBeCloseTo(-0.12 + T.skin, 12);
  });
});

describe('sleep', () => {
  /** A world that counts how often anything asks it a question. */
  class CountingWorld extends StaticWorld {
    queries = 0;
    override query(
      minX: number,
      minY: number,
      minZ: number,
      maxX: number,
      maxY: number,
      maxZ: number,
      out: Aabb[],
    ): Aabb[] {
      this.queries++;
      return super.query(minX, minY, minZ, maxX, maxY, maxZ, out);
    }
  }

  it('costs nothing at all: a thousand ticks asleep is zero queries and an unmoved body', () => {
    // A can that is picked up is a can that stopped costing anything; a can that is never picked
    // up must also stop costing anything, and there is no cap on how many of those a run
    // accumulates. Mutation: *remove the asleep early return* — every assertion but the query
    // count still passes, because a sleeping body on a floor re-derives its own stillness.
    const world = new CountingWorld();
    world.add(aabbFromBounds(-20, -1, -20, 20, 0, 20, MAT_CONCRETE));
    const body = bodyAt(1, T.skin, 2, 0, 0, 0, true);
    body.asleep = true;
    const before = { ...body };
    const contacts: BallisticContact[] = [];
    for (let i = 0; i < 1000; i++) stepBallistic(world, body, DT, contacts, T);
    expect(world.queries).toBe(0);
    expect(body).toEqual(before);
    expect(contacts).toHaveLength(0);
  });

  it('still clears the contacts array on the tick it sleeps through', () => {
    // The out-array contract has no exceptions: the caller drains after every step, so a stale
    // record surviving one asleep tick would be emitted twice.
    const world = flatWorld();
    const body = bodyAt(0, 0.05, 0, 0, -8, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
    expect(contacts).toHaveLength(1);
    body.asleep = true;
    stepBallistic(world, body, DT, contacts, T);
    expect(contacts).toHaveLength(0);
  });

  it('wakes on a kick and leaves the support probe to decide whether it is still grounded', () => {
    const world = flatWorld();
    const resting = bodyAt(0, T.skin, 0, 0, 0, 0, true);
    resting.asleep = true;
    wakeBallistic(resting, 4, 0, 0);
    expect(resting.asleep).toBe(false);
    expect(resting.grounded).toBe(true);
    const flight = fly(world, resting, 120 * 30);
    expect(kinds(flight.log)).toEqual(['rest']);
    expect(resting.x).toBeGreaterThan(0.9);
    expect(resting.asleep).toBe(true);

    // Kicked off the end of its support instead: the probe falsifies `grounded` the same tick.
    const world2 = new StaticWorld();
    world2.add(aabbFromBounds(-5, -1, -5, 0, 0, 5, MAT_CONCRETE));
    const edge = bodyAt(-0.01, T.skin, 0, 4, 0, 0, true);
    edge.asleep = true;
    wakeBallistic(edge, 4, 0, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world2, edge, DT, contacts, T);
    expect(edge.grounded).toBe(false);
    expect(contacts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 13–15. Many bodies
// ---------------------------------------------------------------------------

describe('a pool of bodies', () => {
  function twoCanWorld(): { world: StaticWorld; near: Aabb; far: Aabb } {
    const world = new StaticWorld();
    const near = world.add(aabbFromBounds(-5, -1, -5, 5, 0, 0, MAT_METAL));
    const far = world.add(aabbFromBounds(-5, -1, 0, 5, 0, 5, MAT_DUST));
    return { world, near, far };
  }

  it('writes the contact log in slot order when two bodies land on the same tick', () => {
    // The only observable a reversed pool loop has. Slot is inventory index, assigned at throw
    // and never reordered, and the log the bus sees is ordered `(tick, slot, sweep)` — two runs
    // of the same throw cannot disagree about who painted first.
    const { world, near, far } = twoCanWorld();
    const slots = [bodyAt(0, 0.05, -1, 0, 0, 0), bodyAt(0, 0.05, 1, 0, 0, 0)];
    const contacts: BallisticContact[] = [];
    const log: BallisticContact[] = [];
    for (let tick = 0; tick < 30; tick++) {
      for (const body of slots) {
        stepBallistic(world, body, DT, contacts, T);
        for (const c of contacts) log.push(c);
      }
    }
    expect(kinds(log)).toEqual(['ground', 'ground', 'rest', 'rest']);
    expect(log[0]!.box).toBe(near);
    expect(log[1]!.box).toBe(far);
    expect(log[0]!.z).toBe(-1);
    expect(log[1]!.z).toBe(1);
  });

  it('leaves the bodies themselves indifferent to the order they were stepped in', () => {
    // Slot order decides the *log*, and nothing else. Any mutation that gave the integrator
    // cross-body state — a remembered last contact, a shared regime flag — would show up here
    // as two bodies that disagree about themselves depending on who went first.
    const forward = twoCanWorld();
    const forwardSlots = [bodyAt(0, 0.05, -1, 2, 0, 0), bodyAt(0.3, 0.4, 1, -1, 3, 0)];
    const backward = twoCanWorld();
    const backwardSlots = [bodyAt(0, 0.05, -1, 2, 0, 0), bodyAt(0.3, 0.4, 1, -1, 3, 0)];
    const contacts: BallisticContact[] = [];
    for (let tick = 0; tick < 400; tick++) {
      for (let i = 0; i < 2; i++) stepBallistic(forward.world, forwardSlots[i]!, DT, contacts, T);
      for (let i = 1; i >= 0; i--) {
        stepBallistic(backward.world, backwardSlots[i]!, DT, contacts, T);
      }
    }
    expect(forwardSlots[0]).toEqual(backwardSlots[0]);
    expect(forwardSlots[1]).toEqual(backwardSlots[1]);
    expect(forwardSlots[0]!.asleep).toBe(true);
    expect(forwardSlots[1]!.asleep).toBe(true);
  });

  it('runs five bodies through a scripted world twice and produces the same trace exactly', () => {
    // `determinism.test.ts` in miniature, and for the same reason: this is the property the whole
    // screenshot suite stands on. `stepBallistic` is a pure function of `(state, dt, tunables)` —
    // no clock, no generator, no iteration over anything unordered — so the only way this moves
    // is if some future edit reaches for one of those.
    const traceA = scriptedPoolTrace();
    const traceB = scriptedPoolTrace();
    expect(traceA).toEqual(traceB);
    // A trace worth comparing: it has to contain real events, or two empty arrays match forever.
    expect(traceA.contacts.length).toBeGreaterThan(20);
    expect(traceA.contacts.filter((c) => c.startsWith('bounce')).length).toBeGreaterThan(4);
    expect(traceA.contacts.filter((c) => c.startsWith('rest')).length).toBe(5);
  });

  function scriptedPoolTrace(): { contacts: string[]; ending: number[] } {
    const world = new StaticWorld();
    world.add(aabbFromBounds(-10, -1, -10, 10, 0, 10, MAT_CONCRETE));
    world.add(aabbFromBounds(3, 0, -10, 4, 3, 10, MAT_METAL));
    world.add(aabbFromBounds(-4, 0, -10, -3, 3, 10, MAT_STONE));
    world.add(aabbFromBounds(-1, 0, -1, 1, 0.5, 1, MAT_DUST));
    const pool: BallisticBody[] = [
      bodyAt(0, 1.5, 0, 9, 2, 0),
      bodyAt(-1, 1.2, 2, -7, 1, -1),
      bodyAt(2, 2.0, -2, 4, -3, 3),
      bodyAt(-2, 0.8, -1, 11, 0, 0),
      bodyAt(1, 1.0, 1, 0, -6, -5),
    ];
    const contacts: BallisticContact[] = [];
    const trace: string[] = [];
    for (let tick = 0; tick < 900; tick++) {
      for (let slot = 0; slot < pool.length; slot++) {
        stepBallistic(world, pool[slot]!, DT, contacts, T);
        for (const c of contacts) {
          const n = `${c.nx},${c.ny},${c.nz}`;
          trace.push(
            `${c.kind}|${tick}|${slot}|${c.speed}|${c.x}|${c.y}|${c.z}|${n}|${c.box.mat}`,
          );
        }
      }
    }
    const ending: number[] = [];
    for (const b of pool) {
      ending.push(b.x, b.y, b.z, b.vx, b.vy, b.vz, b.grounded ? 1 : 0, b.asleep ? 1 : 0);
    }
    return { contacts: trace, ending };
  }
});

// ---------------------------------------------------------------------------
// 14, 16. Conventions
// ---------------------------------------------------------------------------

describe('conventions', () => {
  it('gives a landing on a seam to the first box the world was given', () => {
    // The same first-box-wins tie-break `raycastWorld` documents and `room.ts` leans on for the
    // apron: two abutting slabs of different materials share a plane, a body landing on it is
    // entering both at the same distance, and stability beats an arbitrary re-sort. Stated here
    // because it decides which *voice* the landing gets (§3.9), which is the audible half of a
    // rule that would otherwise look like an implementation detail.
    for (const dustFirst of [false, true]) {
      const world = new StaticWorld();
      const dust = aabbFromBounds(0, -1, -5, 5, 0, 5, MAT_DUST);
      const concrete = aabbFromBounds(-5, -1, -5, 0, 0, 5, MAT_CONCRETE);
      const first = dustFirst ? dust : concrete;
      world.add(first);
      world.add(dustFirst ? concrete : dust);
      const body = bodyAt(0, 0.05, 0, 0, -2, 0);
      const flight = fly(world, body, 60, tuned({ gravity: 0 }));
      expect(kinds(flight.log)).toEqual(['ground', 'rest']);
      expect(flight.log[0]!.box).toBe(first);
      expect(flight.log[1]!.box).toBe(first);
    }
  });

  it('clears the contacts array at the top of every call', () => {
    const world = flatWorld();
    const body = bodyAt(0, 0.05, 0, 0, -8, 0);
    const contacts: BallisticContact[] = [];
    contacts.push({
      kind: 'graze',
      speed: 99,
      x: 0,
      y: 0,
      z: 0,
      nx: 0,
      ny: 1,
      nz: 0,
      box: world.boxes[0]!,
    });
    stepBallistic(world, body, DT, contacts, tuned({ gravity: 0 }));
    expect(kinds(contacts)).toEqual(['bounce']);
  });

  it('hands back fresh records, so a caller may keep them across other bodies', () => {
    // The scratch decision that is *not* shared here, unlike `RayHit` and `MoveResult`: the
    // throwable system merges several bodies' logs before it emits any of them, and a pooled
    // record would change contents under it on the next body's step.
    const world = flatWorld();
    const one = bodyAt(0, 0.05, 0, 0, -8, 0);
    const two = bodyAt(3, 0.05, 0, 0, -6, 0);
    const contacts: BallisticContact[] = [];
    stepBallistic(world, one, DT, contacts, tuned({ gravity: 0 }));
    const kept = contacts[0]!;
    stepBallistic(world, two, DT, contacts, tuned({ gravity: 0 }));
    expect(kept.speed).toBe(8);
    expect(contacts[0]!.speed).toBe(6);
    expect(contacts[0]).not.toBe(kept);
  });

  it('pins the default tunables', () => {
    expect(defaultBallisticTunables()).toEqual({
      gravity: 16,
      restitution: 0.45,
      tangentKeep: 0.75,
      bounceMin: 1.0,
      rollDecel: 8,
      restSpeed: 0.15,
      skin: 1e-3,
      maxSweeps: 4,
    });
  });

  it('hands out a fresh tunables object each call, so one body cannot retune another', () => {
    const a = defaultBallisticTunables();
    a.gravity = 0;
    expect(defaultBallisticTunables().gravity).toBe(16);
  });

  it('uses the same gravity the player does, so the two integrators agree on a tick', () => {
    // 16 plain, with no `fallGravityMult`: the player's 1.6× fall multiplier is a game-feel cheat
    // for a body with a jump arc, and `LANDING_MIN_IMPACT`'s "≈ a 0.8 m drop" is only true at 16.
    // So a can dropped 0.8 m has to arrive at the player's own landing threshold — the moment the
    // gravity here drifts from the gravity there, every band §3.3 derives from a drop height is
    // telling the truth about one body and a story about the other.
    const world = flatWorld();
    const body = bodyAt(0, 0.8, 0, 0, 0, 0);
    const flight = fly(world, body, 120 * 30);
    expect(flight.log[0]!.speed).toBeGreaterThan(LANDING_MIN_IMPACT);
    expect(flight.log[0]!.speed).toBeLessThan(LANDING_MIN_IMPACT + 0.1);
    // Discrete, not `√(2gh)`: the tick that lands is the tick after the one that fell short, so
    // the arrival is a hair faster than the continuous answer and this is where that shows.
    expect(flight.log[0]!.speed).toBeCloseTo(Math.sqrt(2 * 16 * 0.8), 1);
  });
});
