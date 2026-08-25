/**
 * Characterization tests for `src/core/collision.ts` — the pure-geometry half.
 *
 * These pin what the code *does today*, not what it ought to do. Where the current behaviour
 * looks like a bug it is still pinned, with a `SUSPECTED BUG` note, because a later refactor
 * has to reproduce today's behaviour bit-for-bit or we cannot tell a refactor from a regression.
 *
 * Every number here comes out of `+ - * /` and `Math.sqrt`, all of which are exactly specified
 * by IEEE 754, so the assertions are exact equalities rather than tolerances.
 */

import { describe, expect, it } from 'vitest';
import {
  StaticWorld,
  aabbFromBounds,
  aabbFromFootprint,
  canOccupy,
  canOccupyWorld,
  circleOverlapsFootprint,
  highestTopUnder,
  sweepSphereWorld,
  type Aabb,
} from '../src/core/collision';
import { MAT_CONCRETE, MAT_DUST } from '../src/paint/materials';

/** The slack `collision.ts` calls EPS. Not exported, so it is restated here and pinned below. */
const EPS = 1e-3;
const UNIT = aabbFromBounds(0, 0, 0, 1, 1, 1, MAT_CONCRETE);

describe('aabbFromBounds', () => {
  it('passes bounds straight through and defaults shell=false', () => {
    expect(aabbFromBounds(-1, -2, -3, 4, 5, 6, MAT_CONCRETE)).toEqual({
      minX: -1, minY: -2, minZ: -3, maxX: 4, maxY: 5, maxZ: 6, mat: MAT_CONCRETE, shell: false,
    });
  });

  it('carries an explicit material and shell flag', () => {
    const b = aabbFromBounds(0, 0, 0, 1, 1, 1, MAT_DUST, true);
    expect(b.mat).toBe(MAT_DUST);
    expect(b.shell).toBe(true);
  });
});

describe('aabbFromFootprint', () => {
  it('centres on X/Z, sits its base on Y and grows upward by sizeY', () => {
    expect(aabbFromFootprint(2, 1, 3, 2, 4, 6, MAT_CONCRETE)).toEqual({
      minX: 1, minY: 1, minZ: 0, maxX: 3, maxY: 5, maxZ: 6, mat: MAT_CONCRETE, shell: false,
    });
  });

  it('states mat and shell, exactly as aabbFromBounds does', () => {
    // This used to pin the opposite: a footprint box left both fields *absent*, so half the
    // world answered `b.mat === 0` with "no" while meaning concrete. Now that §3.9 reads `mat`
    // on every footfall, an absent material is a surface with no voice — so the two
    // constructors agree, and neither will guess a material for a caller that did not say.
    const f = aabbFromFootprint(0, 0, 0, 1, 1, 1, MAT_DUST, true);
    expect('mat' in f).toBe(true);
    expect('shell' in f).toBe(true);
    expect(f.mat).toBe(MAT_DUST);
    expect(f.shell).toBe(true);
    // Structurally identical to the same box built the other way — the point of the change.
    expect(aabbFromFootprint(0, 0, 0, 1, 1, 1, MAT_CONCRETE)).toEqual(
      aabbFromBounds(-0.5, 0, -0.5, 0.5, 1, 0.5, MAT_CONCRETE),
    );
  });
});

describe('circleOverlapsFootprint', () => {
  it('is true when the centre is inside the footprint', () => {
    expect(circleOverlapsFootprint(0.5, 0.5, 0.35, UNIT)).toBe(true);
  });

  it('touching is NOT overlapping: the test is strict `<`', () => {
    // Exactly `radius` from the +X face: distance² === radius², and `d2 < r2` is false.
    expect(circleOverlapsFootprint(1.35, 0.5, 0.35, UNIT)).toBe(false);
    // One ulp closer and it overlaps.
    expect(circleOverlapsFootprint(1.3499999, 0.5, 0.35, UNIT)).toBe(true);
  });

  it('measures to the nearest point on the box, so corners are round', () => {
    // 0.5 m diagonally out from the (1, 1) corner is 0.5 m from the corner, not 0.5 m from a face.
    expect(circleOverlapsFootprint(1.5, 1.5, 0.5, UNIT)).toBe(false);
    expect(circleOverlapsFootprint(1.3, 1.3, 0.5, UNIT)).toBe(true);
  });

  it('a zero radius never overlaps anything, not even from dead centre', () => {
    // `d2 < 0` is unsatisfiable, so the degenerate circle is invisible to the test even when
    // its centre is inside the box. Pinned because it is the one input where "overlaps" and
    // "is inside" part company; nothing in the game passes radius 0 today.
    expect(circleOverlapsFootprint(1, 0.5, 0, UNIT)).toBe(false);
    expect(circleOverlapsFootprint(0.5, 0.5, 0, UNIT)).toBe(false);
  });

  it('ignores Y entirely', () => {
    const tall = aabbFromBounds(0, 100, 0, 1, 200, 1, MAT_CONCRETE);
    expect(circleOverlapsFootprint(0.5, 0.5, 0.35, tall)).toBe(true);
  });
});

describe('canOccupy', () => {
  const under = [aabbFromBounds(-1, -1, -1, 1, 0, 1, MAT_CONCRETE)];
  const over = [aabbFromBounds(-1, 1.7, -1, 1, 3, 1, MAT_CONCRETE)];

  it('standing exactly on a surface is legal', () => {
    expect(canOccupy(under, 0, 0, 0, 0.35, 1.7)).toBe(true);
  });

  it('tolerates EPS of interpenetration at the feet, and rejects one ulp more', () => {
    // `b.maxY <= feetY + EPS` skips the box, so sinking up to 1 mm into the floor still "fits".
    expect(canOccupy(under, 0, -EPS, 0, 0.35, 1.7)).toBe(true);
    expect(canOccupy(under, 0, -0.0011, 0, 0.35, 1.7)).toBe(false);
  });

  it('tolerates EPS of interpenetration at the head, symmetrically', () => {
    expect(canOccupy(over, 0, 0, 0, 0.35, 1.7)).toBe(true);
    expect(canOccupy(over, 0, EPS, 0, 0.35, 1.7)).toBe(true);
    expect(canOccupy(over, 0, 0.0011, 0, 0.35, 1.7)).toBe(false);
  });

  it('ignores boxes the body does not stand over', () => {
    expect(canOccupy(under, 5, -0.5, 5, 0.35, 1.7)).toBe(true);
  });

  it('an empty candidate list always fits', () => {
    expect(canOccupy([], 0, 0, 0, 0.35, 1.7)).toBe(true);
  });
});

describe('highestTopUnder', () => {
  const stack = [aabbFromBounds(-1, -1, -1, 1, 0.5, 1, MAT_CONCRETE), aabbFromBounds(-1, -1, -1, 1, 0.2, 1, MAT_CONCRETE)];

  it('returns -Infinity when the circle hangs over nothing', () => {
    expect(highestTopUnder(stack, 9, 9, 0.35, -Infinity, 10)).toBe(-Infinity);
    expect(highestTopUnder([], 0, 0, 0.35, -Infinity, 10)).toBe(-Infinity);
  });

  it('picks the highest of several tops, regardless of list order', () => {
    expect(highestTopUnder(stack, 0, 0, 0.35, -Infinity, 10)).toBe(0.5);
    expect(highestTopUnder([...stack].reverse(), 0, 0, 0.35, -Infinity, 10)).toBe(0.5);
  });

  it('a surface exactly at the ceiling counts, and EPS above it still counts', () => {
    expect(highestTopUnder(stack, 0, 0, 0.35, -Infinity, 0.5)).toBe(0.5);
    expect(highestTopUnder(stack, 0, 0, 0.35, -Infinity, 0.5 - EPS)).toBe(0.5);
    // One ulp past the slack and the 0.5 top is discarded — the 0.2 one is not, and wins.
    expect(highestTopUnder(stack, 0, 0, 0.35, -Infinity, 0.4989)).toBe(0.2);
  });

  it('a surface exactly at the floor counts, and EPS below it still counts', () => {
    expect(highestTopUnder(stack, 0, 0, 0.35, 0.5, 10)).toBe(0.5);
    expect(highestTopUnder(stack, 0, 0, 0.35, 0.5 + EPS, 10)).toBe(0.5);
    expect(highestTopUnder(stack, 0, 0, 0.35, 0.5011, 10)).toBe(-Infinity);
  });

  it('a surface exactly at the feet is found (ceilY = feetY)', () => {
    const floor = [aabbFromBounds(-1, -1, -1, 1, 0, 1, MAT_CONCRETE)];
    expect(highestTopUnder(floor, 0, 0, 0.35, -Infinity, 0)).toBe(0);
  });
});

describe('StaticWorld', () => {
  it('add returns the box it was given, by reference', () => {
    const w = new StaticWorld();
    const b = aabbFromBounds(0, 0, 0, 1, 1, 1, MAT_CONCRETE);
    expect(w.add(b)).toBe(b);
    expect(w.boxes).toHaveLength(1);
    expect(w.boxes[0]).toBe(b);
  });

  it('clear empties the list in place (the array identity survives)', () => {
    const w = new StaticWorld();
    const boxes = w.boxes;
    w.add(UNIT);
    w.clear();
    expect(w.boxes).toBe(boxes);
    expect(w.boxes).toHaveLength(0);
  });

  describe('query', () => {
    it('touching is not overlapping, on every axis', () => {
      const w = new StaticWorld();
      w.add(UNIT);
      const out: Aabb[] = [];
      expect(w.query(0, 0, 0, 1, 1, 1, out)).toHaveLength(1); // exactly coincident: in
      expect(w.query(1, 0, 0, 2, 1, 1, out)).toHaveLength(0); // flush against +X: out
      expect(w.query(-1, 0, 0, 0, 1, 1, out)).toHaveLength(0); // flush against -X: out
      expect(w.query(0, 1, 0, 1, 2, 1, out)).toHaveLength(0); // flush against +Y: out
      expect(w.query(0, 0, 1, 1, 1, 2, out)).toHaveLength(0); // flush against +Z: out
      expect(w.query(1 - 1e-9, 0, 0, 2, 1, 1, out)).toHaveLength(1); // a hair of overlap: in
    });

    it('returns candidates in insertion order', () => {
      // Load-bearing: `slideXZ` resolves pushes sequentially in candidate order and applies each
      // push to the position the previous one left behind, so the order the broadphase hands
      // boxes back in is part of the resolved position. Swapping the linear scan for a grid or
      // a BVH changes this order and therefore can change where the body ends up.
      const w = new StaticWorld();
      const first = w.add(aabbFromBounds(0, 0, 0, 1, 1, 1, MAT_CONCRETE));
      const second = w.add(aabbFromBounds(-5, 0, 0, -4, 1, 1, MAT_CONCRETE));
      const third = w.add(aabbFromBounds(10, 0, 0, 11, 1, 1, MAT_CONCRETE));
      const out: Aabb[] = [];
      w.query(-100, -100, -100, 100, 100, 100, out);
      expect(out).toEqual([first, second, third]);
      expect(out[0]).toBe(first);
    });

    it('clears `out` first and returns that same array', () => {
      const w = new StaticWorld();
      w.add(UNIT);
      const out: Aabb[] = [aabbFromBounds(0, 0, 0, 1, 1, 1, MAT_CONCRETE)];
      expect(w.query(50, 50, 50, 51, 51, 51, out)).toBe(out);
      expect(out).toHaveLength(0);
    });
  });
});

describe('sweepSphereWorld', () => {
  function boxWorld(): StaticWorld {
    const w = new StaticWorld();
    w.add(aabbFromBounds(4, -1, -1, 5, 1, 1, MAT_CONCRETE));
    return w;
  }

  it('stops radius short of the struck face', () => {
    expect(sweepSphereWorld(boxWorld(), 0, 0, 0, 1, 0, 0, 10, 0.2)).toBe(4 - 0.2);
  });

  it('returns maxDist when the way is clear', () => {
    expect(sweepSphereWorld(boxWorld(), 0, 5, 0, 1, 0, 0, 10, 0.2)).toBe(10);
    expect(sweepSphereWorld(boxWorld(), 0, 0, 0, -1, 0, 0, 10, 0.2)).toBe(10);
  });

  it('never reports further than maxDist even with the box beyond it', () => {
    expect(sweepSphereWorld(boxWorld(), 0, 0, 0, 1, 0, 0, 2, 0.2)).toBe(2);
  });

  it('returns 0 for a non-positive maxDist without touching the world', () => {
    expect(sweepSphereWorld(boxWorld(), 0, 0, 0, 1, 0, 0, 0, 0.2)).toBe(0);
    expect(sweepSphereWorld(boxWorld(), 0, 0, 0, 1, 0, 0, -1, 0.2)).toBe(0);
  });

  it('returns 0 when the origin is already inside an inflated box', () => {
    // 3.9 is outside the box (min 4) but inside it once inflated by 0.2.
    expect(sweepSphereWorld(boxWorld(), 3.9, 0, 0, 1, 0, 0, 10, 0.2)).toBe(0);
  });

  it('a zero radius degrades to a plain ray', () => {
    expect(sweepSphereWorld(boxWorld(), 0, 0, 0, 1, 0, 0, 10, 0)).toBe(4);
  });

  it('over-reports at box corners, by exactly the square-corner error', () => {
    // The documented Minkowski shortcut (see the function's comment): boxes are inflated by
    // `radius` and hit with a ray-slab test, so the inflated box has SQUARE corners where the
    // true swept volume is round. Approaching a corner diagonally therefore stops early.
    const w = new StaticWorld();
    w.add(aabbFromBounds(0, -1, 0, 2, 1, 2, MAT_CONCRETE));
    const d = Math.SQRT1_2;
    const r = 0.3;
    const reported = sweepSphereWorld(w, -2, 0, -2, d, 0, d, 10, r);
    const trueDistance = Math.hypot(2, 2) - r; // sphere touching the (0,0) corner
    expect(reported).toBeCloseTo(2.4041630560342613, 12);
    // Early, never late — the safe direction for its one caller, the third-person boom.
    expect(reported).toBeLessThan(trueDistance);
    // The error is the corner cut: r * (sqrt(2) - 1) along a 45° approach.
    expect(trueDistance - reported).toBeCloseTo(r * (Math.SQRT2 - 1), 12);
  });

  it('handles a direction with a zero component (the degenerate-slab branch)', () => {
    const w = boxWorld();
    // dy = 0 and the origin's Y is inside the inflated Y slab: the axis is skipped.
    expect(sweepSphereWorld(w, 0, 0.5, 0, 1, 0, 0, 10, 0.2)).toBe(3.8);
    // dy = 0 and the origin's Y is outside it: the box is rejected outright.
    expect(sweepSphereWorld(w, 0, 50, 0, 1, 0, 0, 10, 0.2)).toBe(10);
  });

  it('reports the nearest of several boxes', () => {
    const w = boxWorld();
    w.add(aabbFromBounds(2, -1, -1, 3, 1, 1, MAT_CONCRETE));
    expect(sweepSphereWorld(w, 0, 0, 0, 1, 0, 0, 10, 0.2)).toBe(2 - 0.2);
  });
});

describe('canOccupyWorld', () => {
  function pillarWorld(): StaticWorld {
    const w = new StaticWorld();
    w.add(aabbFromBounds(-1, 0, -1, 1, 2, 1, MAT_CONCRETE));
    return w;
  }

  it('rejects a pose inside a pillar and accepts one clear of it', () => {
    expect(canOccupyWorld(pillarWorld(), 0, 0, 0, 0.35, 1.7)).toBe(false);
    expect(canOccupyWorld(pillarWorld(), 5, 0, 5, 0.35, 1.7)).toBe(true);
  });

  it('inherits the strict touching-is-not-overlapping rule', () => {
    expect(canOccupyWorld(pillarWorld(), 1.35, 0, 0, 0.35, 1.7)).toBe(true);
    expect(canOccupyWorld(pillarWorld(), 1.3, 0, 0, 0.35, 1.7)).toBe(false);
  });

  it('SUSPECTED BUG: its broadphase box is not inflated by EPS, so it can miss a grazing box', () => {
    // `canOccupy` deliberately tolerates EPS of interpenetration, but `canOccupyWorld` queries
    // the world with the *exact* body box. A box whose top is within EPS *below* the feet is
    // excluded by the query (touching is not overlapping) and never reaches `canOccupy`, so the
    // two functions disagree at the EPS boundary the design says to tolerate. Harmless today —
    // both answers are "yes" here — but the discrepancy is real and pinned so a rewrite of the
    // broadphase cannot quietly change which of the two rules wins.
    const w = new StaticWorld();
    w.add(aabbFromBounds(-1, -1, -1, 1, 0, 1, MAT_CONCRETE));
    const candidates: Aabb[] = [];
    w.query(-0.35, 0, -0.35, 0.35, 1.7, 0.35, candidates);
    expect(candidates).toHaveLength(0); // the floor never reaches canOccupy at all
    expect(canOccupyWorld(w, 0, 0, 0, 0.35, 1.7)).toBe(true);
  });
});
