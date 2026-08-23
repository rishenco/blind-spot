/**
 * REVIEW SPEC (milestone-1 adversarial review) — src/core/map/build.ts.
 *
 * Each `it` names one finding. Delete this file once they are fixed.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld, countWalls, raycast, solidAt } from '../src/core/map/build.js';
import { sampleMap } from '../src/core/map/sampleMap.js';

const world = buildWorld(sampleMap);

describe('review: shared-scratch re-entrancy', () => {
  it('countWalls is unaffected by a filter that queries the world', () => {
    // Segment from corridor C south through the C/B wall and the D1/D2 wall = 2 walls.
    const A = [28, 1.5, 1] as const;
    const B = [28, 1.5, 20] as const;
    const plain = countWalls(world, A[0], A[1], A[2], B[0], B[1], B[2]);
    expect(plain).toBe(2);

    // An always-true filter must be a pure no-op, whatever it does internally.
    // M3's paint step ("count penetrated walls against OCCLUDER boxes") will pass exactly
    // this kind of predicate.
    const withFilter = countWalls(world, A[0], A[1], A[2], B[0], B[1], B[2], (s) => {
      solidAt(world, 0, 100, 0); // any nested query at all
      return s !== null;
    });
    expect(withFilter).toBe(plain);
  });
});

describe('review: raycast normals', () => {
  it('always returns a unit-length normal', () => {
    // Origin at the exact axis of the tank cylinder (16, 16), r 3, y 0..6.5.
    const hit = raycast(world, 16, 3, 16, 1, 0, 0, 10);
    expect(hit).not.toBeNull();
    expect(hit!.solid.id).toBe('tank');
    expect(Math.hypot(hit!.nx, hit!.ny, hit!.nz)).toBeCloseTo(1, 6);
  });

  it('returns a unit-length normal for an ordinary outside hit (this part is correct)', () => {
    const hit = raycast(world, 10, 3, 16, 1, 0, 0, 10);
    expect(hit).not.toBeNull();
    expect(Math.hypot(hit!.nx, hit!.ny, hit!.nz)).toBeCloseTo(1, 6);
  });
});
