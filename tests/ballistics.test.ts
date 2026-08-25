/**
 * `stepBallistic` — the swept integrator a thrown sphere runs on.
 *
 * Same contract as `moveBody.test.ts`: hand-built worlds, real simulation ticks (`dt = 1/120`,
 * the rate `core/loop.ts` runs at), and exact numbers wherever the arithmetic allows one. All of
 * it is `+ − * /`, `Math.sqrt` and `Math.hypot`, so a body moving along an axis is asserted to
 * the bit; the oblique cases pay one normalise-and-rescale round trip for their direction and
 * are asserted `toBeCloseTo(_, 12)` with the plane they landed on checked separately.
 *
 * **This file is a mutation net, not a description.** The module is two dozen lines and every
 * one of them can fail silently: a sweep that does not reach is a sphere through a pane, a
 * standoff of zero is a boom voiced from inside the wall it struck, an integrator that moves
 * before it accelerates is an arc that no longer matches the one `arcPoints` draws. None of
 * those look like anything from the outside — they look like a verb that mostly works. Every
 * test below names the mutation it is here to kill.
 */

import { describe, expect, it } from 'vitest';
import { StaticWorld, aabbFromBounds } from '../src/core/collision';
import { MAT_CONCRETE, MAT_DUST, MAT_METAL } from '../src/paint/materials';
import { LANDING_MIN_IMPACT } from '../src/paint/soundEvents';
import {
  BALLISTIC_GRAVITY,
  createBallisticContact,
  defaultBallisticTunables,
  stepBallistic,
  type BallisticBody,
  type BallisticContact,
  type BallisticTunables,
} from '../src/core/ballistics';

/** `core/loop.ts` runs the simulation at 120 Hz and never hands `fixedUpdate` anything else. */
const DT = 1 / 120;

const T = defaultBallisticTunables();

/**
 * The defaults with a field moved. Most tests want gravity off — not because a sphere flies
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
): BallisticBody {
  return { x, y, z, vx, vy, vz };
}

function normalOf(c: BallisticContact): [number, number, number] {
  return [c.nx, c.ny, c.nz];
}

/**
 * Flies a body until it touches something or the budget runs out — the whole life of a sphere.
 *
 * There is no second contact to wait for: `game/spheres.ts` removes the body on the tick this
 * returns, so a loop that kept stepping would be simulating something that does not exist.
 */
interface Flight {
  /** The contact, or `null` if the budget ran out first. */
  hit: BallisticContact | null;
  ticks: number;
  /** The speed the body arrived at, m/s — the velocity of the tick that made contact. */
  speed: number;
}

function fly(
  world: StaticWorld,
  body: BallisticBody,
  maxTicks: number,
  t: BallisticTunables = T,
): Flight {
  const out = createBallisticContact();
  for (let ticks = 1; ticks <= maxTicks; ticks++) {
    const hit = stepBallistic(world, body, DT, t, out);
    if (hit !== null) return { hit, ticks, speed: Math.hypot(body.vx, body.vy, body.vz) };
  }
  return { hit: null, ticks: maxTicks, speed: Math.hypot(body.vx, body.vy, body.vz) };
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
    // gravity — leaves `y` at exactly 10 for a body that started with no velocity, and takes
    // `arcPoints` (`game/spheres.ts`) out of step with the thing it is drawing.
    const world = flatWorld();
    const body = bodyAt(0, 10, 0, 0, 0, 0);
    expect(stepBallistic(world, body, DT, T, createBallisticContact())).toBeNull();
    expect(body.vy).toBe(-(16 * DT));
    expect(body.y).toBe(10 - 16 * DT * DT);
  });

  it('carries horizontal velocity untouched — no drag, no friction in the air', () => {
    const world = flatWorld();
    const body = bodyAt(0, 10, 0, 6, 0, -3);
    const out = createBallisticContact();
    for (let i = 0; i < 20; i++) stepBallistic(world, body, DT, T, out);
    expect(body.vx).toBe(6);
    expect(body.vz).toBe(-3);
    expect(body.x).toBeCloseTo(6 * 20 * DT, 12);
    expect(body.z).toBeCloseTo(-3 * 20 * DT, 12);
  });

  it('falls the closed-form discrete distance over twenty ticks', () => {
    // Σ g·dt²·k for k = 1..n — the discrete free fall, `g·dt²·n(n+1)/2` and not the continuous
    // ½gt². Pins that exactly one gravity step happens per tick, which is the sum the arc
    // preview is generated from.
    const world = flatWorld();
    const body = bodyAt(0, 10, 0, 0, 0, 0);
    const out = createBallisticContact();
    const n = 20;
    for (let i = 0; i < n; i++) stepBallistic(world, body, DT, T, out);
    expect(body.y).toBeCloseTo(10 - 16 * DT * DT * ((n * (n + 1)) / 2), 12);
  });

  it('refuses a tick with no motion in it rather than walking the body backwards', () => {
    // `!(reach > 0)` is a NaN trapdoor as much as a zero guard: a `dt` of NaN makes every
    // comparison false, and the branch that survives has to be the one that does nothing.
    const world = flatWorld();
    for (const dt of [0, Number.NaN]) {
      const body = bodyAt(0, 5, 0, 0, 0, 0);
      expect(stepBallistic(world, body, dt, tuned({ gravity: 0 }), createBallisticContact()))
        .toBeNull();
      expect(body.x).toBe(0);
      expect(body.y).toBe(5);
      expect(body.z).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The sweep: the pane, and the tick boundary
// ---------------------------------------------------------------------------

describe('a pane thinner than one tick of travel', () => {
  /**
   * The centrepiece, and the reason this module exists at all. `moveBody` cannot do this —
   * `slideXZ` teleports to `p + v·dt` and pushes out of whatever it overlaps *there*, and
   * `circlePush` ejects through the nearest face, so a step landing past the midplane exits the
   * far side. Measured on the real thing: a 0.06 m body at 24 m/s passes clean through a 0.1 m
   * wall. Every sound-trap the tower plans is thinner than that, and a sphere that tunnelled is
   * a boom that never happened — the verb silently not working.
   *
   * The phase sweep is the point. A single start position proves nothing: a body that happens to
   * land its tick boundary on the near face is stopped by an integrator that never swept at all.
   * Forty phases across one full step length means no implementation gets to be lucky.
   *
   * Named mutations that must fail here:
   *  (a) *integrate, then test* — advance `p += v·dt` before casting: the cast starts on the far
   *      side and the pane is behind it.
   *  (b) *a sweep that does not reach* — `maxDist = speed·dt / 2`: at any phase where the pane
   *      sits in the far half of the step, the cast reports clear and the body walks through.
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
        const flight = fly(world, body, 400, tuned({ gravity: 0 }));
        expect(flight.hit).not.toBeNull();
        // The contact is on the near face, not past it and not on the far one.
        expect(flight.hit!.x).toBe(2);
        expect(flight.hit!.box).toBe(pane);
        expect(normalOf(flight.hit!)).toEqual([-1, 0, 0]);
        // And the body ends its life a skin clear of the face rather than inside the pane.
        expect(body.x).toBe(2 - T.skin);
        expect(insideAnyBox(world, body)).toBe(false);
      }
    });
  }

  it('strikes a wall standing at exactly one tick of travel, this tick', () => {
    // `raycastWorld`'s inclusive `maxDist`, consumed. The exclusive reading leaves the body
    // exactly touching the wall and defers the contact to the next tick, which is one tick of a
    // sphere sitting inside the surface it should have gone off against.
    const world = flatWorld();
    world.add(aabbFromBounds(2, 0, -20, 2.05, 3, 20, MAT_CONCRETE));
    const body = bodyAt(2 - 15 * DT, 1, 0, 15, 0, 0);
    const hit = stepBallistic(world, body, DT, tuned({ gravity: 0 }), createBallisticContact());
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(2);
    expect(body.x).toBe(2 - T.skin);
  });

  it('does not strike a wall a hair beyond one tick of travel', () => {
    // The other half of "inclusive": the boundary is a boundary, not a reach-further licence.
    const world = flatWorld();
    world.add(aabbFromBounds(2, 0, -20, 2.05, 3, 20, MAT_CONCRETE));
    const body = bodyAt(2 - 15 * DT - 1e-6, 1, 0, 15, 0, 0);
    const hit = stepBallistic(world, body, DT, tuned({ gravity: 0 }), createBallisticContact());
    expect(hit).toBeNull();
    expect(body.vx).toBe(15);
  });

  it('spends the whole tick when nothing is in the way — exactly `p + v·dt`', () => {
    // Stepped by the velocity, not by `direction · reach`: the normalise-and-rescale round trip
    // is a rounding error the body has no reason to carry, and `arcPoints` draws the un-rounded
    // version. An oblique free step is asserted to the bit here for exactly that reason.
    const world = flatWorld();
    const body = bodyAt(0, 5, 0, 3, 0, -7);
    stepBallistic(world, body, DT, tuned({ gravity: 0 }), createBallisticContact());
    expect(body.x).toBe(3 * DT);
    expect(body.z).toBe(-7 * DT);
  });
});

// ---------------------------------------------------------------------------
// 3. The contact
// ---------------------------------------------------------------------------

describe('the contact record', () => {
  it('reports the point on the face, and stands the body off it by exactly one skin', () => {
    // Two different places, deliberately. The sound comes from where the surfaces met (the
    // standoff is a numerical device and has no business leaking into what the world hears);
    // the body ends up a millimetre clear, because whatever draws a sphere reads that pose.
    const floor = flatWorld();
    const dropped = bodyAt(0, 0.05, 0, 0, -8, 0);
    const down = fly(floor, dropped, 40, tuned({ gravity: 0 }));
    expect(down.hit!.y).toBe(0);
    expect(normalOf(down.hit!)).toEqual([0, 1, 0]);
    expect(dropped.y).toBe(T.skin);

    const world = flatWorld();
    world.add(aabbFromBounds(2, 0, -20, 2.5, 3, 20, MAT_CONCRETE));
    const flung = bodyAt(0, 1, 0, 12, 0, 0);
    const across = fly(world, flung, 400, tuned({ gravity: 0 }));
    expect(across.hit!.x).toBe(2);
    expect(normalOf(across.hit!)).toEqual([-1, 0, 0]);
    expect(flung.x).toBe(2 - T.skin);
  });

  it('names the box it struck, which is how the boom knows what it went off against', () => {
    // Identity, not a copy: `game/sim.ts` reads nothing off it today (a sphere's boom is its own
    // voice, not the surface's — `SOUND_CLASSES['sphere-boom']`), but the physics is the only
    // thing that knows *which* box the body actually touched, and handing back anything but the
    // world's own box is an answer that can drift from it.
    const world = new StaticWorld();
    const dust = world.add(aabbFromBounds(-5, -1, -5, 0, 0, 5, MAT_DUST));
    const metal = world.add(aabbFromBounds(0, -1, -5, 5, 0, 5, MAT_METAL));
    const onDust = fly(world, bodyAt(-2, 0.05, 0, 0, -8, 0), 40, tuned({ gravity: 0 }));
    const onMetal = fly(world, bodyAt(2, 0.05, 0, 0, -8, 0), 40, tuned({ gravity: 0 }));
    expect(onDust.hit!.box).toBe(dust);
    expect(onMetal.hit!.box).toBe(metal);
    expect(onDust.hit!.box.mat).toBe(MAT_DUST);
  });

  it('gives a landing on a seam to the first box the world was given', () => {
    // The same first-box-wins tie-break `raycastWorld` documents and `room.ts` leans on for the
    // apron: two abutting slabs share a plane, a body landing on it is entering both at the same
    // distance, and stability beats an arbitrary re-sort.
    for (const dustFirst of [false, true]) {
      const world = new StaticWorld();
      const dust = aabbFromBounds(0, -1, -5, 5, 0, 5, MAT_DUST);
      const concrete = aabbFromBounds(-5, -1, -5, 0, 0, 5, MAT_CONCRETE);
      const first = dustFirst ? dust : concrete;
      world.add(first);
      world.add(dustFirst ? concrete : dust);
      const flight = fly(world, bodyAt(0, 0.05, 0, 0, -2, 0), 60, tuned({ gravity: 0 }));
      expect(flight.hit!.box).toBe(first);
    }
  });

  it('reports a body already touching a face as a contact, at t = 0', () => {
    /*
     * `raycastWorld` answers with the geometry it is already touching, and for a sphere that is
     * a contact like any other: the body is standing on the thing it is about to go off
     * against. The old bouncing can had to special-case this to avoid an oscillation — reflect,
     * re-enter, reflect — and a sphere cannot, because the caller removes it on this same tick.
     * There is no next tick to oscillate in.
     */
    const world = flatWorld();
    const body = bodyAt(0, 0, 0, 0, -1, 0);
    const hit = stepBallistic(world, body, DT, tuned({ gravity: 0 }), createBallisticContact());
    expect(hit).not.toBeNull();
    expect(hit!.y).toBe(0);
    expect(normalOf(hit!)).toEqual([0, 1, 0]);
    expect(body.y).toBe(T.skin);
  });

  it('answers a body that starts inside a box immediately, and moves it outward', () => {
    /*
     * A sphere is never launched into a wall — the spawn contract in `game/spheres.ts` is
     * `min(handDist, hit.t − skin)` precisely so it cannot be — but "cannot be" is how a body
     * ends up under the floor for the rest of a run, so the degenerate case is pinned rather
     * than assumed away. One sweep cannot climb out of a box it is 40 cm deep in, and it is not
     * asked to: it reports the contact on the tick it is handed, with the outward normal, and
     * the caller voices the boom and removes the body. What it may never do is bury it further.
     */
    const world = flatWorld();
    const body = bodyAt(0, -0.4, 0, 0, -6, 0);
    const hit = stepBallistic(world, body, DT, tuned({ gravity: 0 }), createBallisticContact());
    expect(hit).not.toBeNull();
    expect(normalOf(hit!)).toEqual([0, 1, 0]);
    expect(body.y).toBe(-0.4 + T.skin);
  });

  it('fills the caller’s record, so one body cannot overwrite another’s contact', () => {
    // The scratch decision this module makes twice over: the `RayHit` is shared and private, the
    // *contact* is the caller's. `Spheres` steps a pool in one loop and voices each contact as
    // it comes, and a record that changed under it on the next body's step would attribute a
    // boom to the wrong place.
    const world = flatWorld();
    const one = createBallisticContact();
    const two = createBallisticContact();
    stepBallistic(world, bodyAt(0, 0.05, 0, 0, -8, 0), DT, tuned({ gravity: 0 }), one);
    stepBallistic(world, bodyAt(3, 0.05, 0, 0, -6, 0), DT, tuned({ gravity: 0 }), two);
    expect(one.x).toBe(0);
    expect(two.x).toBe(3);
    expect(one).not.toBe(two);
  });

  it('starts empty, with a degenerate box rather than a plausible wrong one', () => {
    const fresh = createBallisticContact();
    expect(fresh.box.minX).toBe(fresh.box.maxX);
    expect(fresh.box.minY).toBe(fresh.box.maxY);
    expect(fresh.box.minZ).toBe(fresh.box.maxZ);
  });
});

// ---------------------------------------------------------------------------
// 4. Conventions
// ---------------------------------------------------------------------------

describe('conventions', () => {
  it('pins the default tunables', () => {
    expect(defaultBallisticTunables()).toEqual({ gravity: 16, skin: 1e-3 });
    expect(BALLISTIC_GRAVITY).toBe(16);
  });

  it('hands out a fresh tunables object each call, so one body cannot retune another', () => {
    const a = defaultBallisticTunables();
    a.gravity = 0;
    expect(defaultBallisticTunables().gravity).toBe(16);
  });

  it('uses the same gravity the player does, so the two integrators agree on a tick', () => {
    // 16 plain, with no `fallGravityMult`: the player's 1.6× fall multiplier is a game-feel cheat
    // for a body with a jump arc, and `LANDING_MIN_IMPACT`'s "≈ a 0.8 m drop" is only true at 16.
    // So a sphere dropped 0.8 m has to arrive at the player's own landing threshold — the moment
    // the gravity here drifts from the gravity there, every band §3.3 derives from a drop height
    // is telling the truth about one body and a story about the other.
    const flight = fly(flatWorld(), bodyAt(0, 0.8, 0, 0, 0, 0), 120 * 30);
    expect(flight.speed).toBeGreaterThan(LANDING_MIN_IMPACT);
    expect(flight.speed).toBeLessThan(LANDING_MIN_IMPACT + 0.1);
    // Discrete, not `√(2gh)`: the tick that lands is the tick after the one that fell short, so
    // the arrival is a hair faster than the continuous answer and this is where that shows.
    expect(flight.speed).toBeCloseTo(Math.sqrt(2 * 16 * 0.8), 1);
  });
});
