/**
 * Collision queries the movement controller (M2) is built on: depenetration, collide-and-slide,
 * step-up, ground/headroom probes, ledge detection, ladders and rays.
 *
 * Most cases run on a tiny synthetic fixture so the numbers are readable; the cases that are
 * really about the authored map run on "Dock Approach".
 */

import { describe, expect, it } from 'vitest';
import {
  buildWorld,
  capsuleOverlaps,
  groundUnder,
  headroom,
  ladderAt,
  ledgeProbe,
  moveCapsule,
  overlapSolids,
  queryXZ,
  raycast,
  resolvePenetration,
  segmentClear,
  solidAt,
} from '../src/core/map/build.js';
import type { MapDef, Solid } from '../src/core/map/types.js';
import { sampleMap } from '../src/core/map/sampleMap.js';
import { CAPSULE_RADIUS, HEIGHT_CROUCH, HEIGHT_STAND, STEP_UP_MAX } from '../src/core/const.js';

const R = CAPSULE_RADIUS;
const H = HEIGHT_STAND;

// ------------------------------------------------------------------------------------------
// Fixture (20 x 20 m of floor):
//   step-0.3   east    a 0.3 lip — walk-up height
//   wall-0.5   west    a 0.5 lip — too tall to walk up
//   block      north   a long 3 m wall to slide along
//   ledge      south   a 1 m mantle target, open above
//   ledge-covered + lowceil  south-east, a 1 m ledge with 0.6 m of headroom
//   pillar     south-east corner, a cylinder
// ------------------------------------------------------------------------------------------

const box = (id: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Solid => ({
  type: 'box',
  id,
  kind: 'wall',
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});

const fixtureMap: MapDef = {
  name: 'fixture',
  solids: [
    box('ground', -10, -1, -10, 10, 0, 10),
    box('step-0.3', 2, 0, -2, 4, 0.3, 2),
    box('wall-0.5', -4, 0, -2, -2, 0.5, 2),
    box('block', -8, 0, 4, 1, 3, 6),
    box('ledge', -1, 0, -6, 1, 1, -4),
    box('ledge-covered', 3, 0, -6, 5, 1, -4),
    // Thick enough that its own top is out of mantle range: the only candidate here is the
    // ledge underneath it, and that one has no standing room.
    box('lowceil', 3, 1.6, -6, 5, 2.6, -4),
    { type: 'cyl', id: 'pillar', kind: 'wall', cx: 6, cz: 8, r: 1, yMin: 0, yMax: 3 },
  ],
  ladders: [{ id: 'fixture-ladder', x: 9.9, z: 0, yBase: 0, yTop: 4, facing: '-x', width: 0.6, depth: 0.7 }],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [0, 0, 0], yaw: 0 },
  air: [{ min: [-10, 0, -10], max: [10, 6, 10] }],
  markers: [],
  bounds: { min: [-10, -1, -10], max: [10, 6, 10] },
};

const fx = buildWorld(fixtureMap);
const world = buildWorld(sampleMap);

describe('broadphase', () => {
  it('returns each candidate once, and only real candidates', () => {
    const out: number[] = [];
    queryXZ(fx, -0.5, -0.5, 0.5, 0.5, out);
    expect(new Set(out).size).toBe(out.length);
    const ids = out.map((i) => fx.solids[i]!.id);
    expect(ids).toContain('ground');
    expect(ids).not.toContain('pillar');
  });

  it('finds solids that span many cells', () => {
    const out: number[] = [];
    queryXZ(fx, 9.9, 9.9, 9.95, 9.95, out);
    expect(out.map((i) => fx.solids[i]!.id)).toContain('ground');
  });

  it('is re-entrant: a query inside a query does not corrupt the outer one', () => {
    // ledgeProbe iterates candidates while calling capsuleOverlaps, which queries again.
    expect(ledgeProbe(fx, 0, 0, -3.2, 0, -1, R, H, { ahead: 1.0 })?.solid.id).toBe('ledge');
  });
});

describe('overlap tests', () => {
  it('separates "standing on" from "inside"', () => {
    expect(capsuleOverlaps(fx, 0, 0, 0, R, H)).toBe(false); // feet exactly on the ground
    expect(capsuleOverlaps(fx, 0, -0.05, 0, R, H)).toBe(true);
    expect(capsuleOverlaps(fx, 3, 0.3, 0, R, H)).toBe(false); // on top of the step
    expect(capsuleOverlaps(fx, 3, 0.2, 0, R, H)).toBe(true);
  });

  it('respects the capsule radius in XZ', () => {
    expect(capsuleOverlaps(fx, 1.6, 0, 0, R, H)).toBe(false); // 0.4 clear of the step face
    expect(capsuleOverlaps(fx, 1.7, 0, 0, R, H)).toBe(true); // 0.3 clear
  });

  it('respects the capsule height in Y', () => {
    expect(capsuleOverlaps(fx, 0, 0, -5, R, HEIGHT_CROUCH)).toBe(true); // inside the ledge
    expect(capsuleOverlaps(fx, 4, 1, -5, R, 0.5)).toBe(false); // crouched under the low ceiling
    expect(capsuleOverlaps(fx, 4, 1, -5, R, H)).toBe(true); // standing hits it
  });

  it('lists everything a capsule intersects', () => {
    const ids = overlapSolids(fx, 4, 0.5, -5, R, H).map((s) => s.id);
    expect(ids.sort()).toEqual(['ledge-covered', 'lowceil']);
  });

  it('treats the cylinder as round, not square', () => {
    expect(solidAt(fx, 6, 1, 8)?.id).toBe('pillar');
    expect(solidAt(fx, 6.8, 1, 8.8)).toBeNull(); // inside the AABB corner, outside the disc
    expect(solidAt(fx, 6.9, 1, 8)?.id).toBe('pillar');
  });
});

describe('ground and headroom probes', () => {
  it('finds the highest support under the footprint', () => {
    expect(groundUnder(fx, 0, 0, 0, R, 1)?.solid.id).toBe('ground');
    expect(groundUnder(fx, 3, 0, 0.3, R, 1)?.solid.id).toBe('step-0.3');
    expect(groundUnder(fx, 0, -5, 1.0, R, 2)?.solid.id).toBe('ledge');
  });

  it('supports a body standing over a lip (footprint, not a ray)', () => {
    // Centre is past the step's edge, but the footprint still overlaps it.
    expect(groundUnder(fx, 4.2, 0, 0.3, R, 0.4)?.solid.id).toBe('step-0.3');
    // Fully past it: the next surface down.
    expect(groundUnder(fx, 4.5, 0, 0.3, R, 0.4)?.solid.id).toBe('ground');
  });

  it('ignores surfaces above the feet and below the search depth', () => {
    expect(groundUnder(fx, 3, 0, 0.1, R, 0.05)).toBeNull(); // step top is above the feet
    expect(groundUnder(fx, 0, 0, 5, R, 1)).toBeNull(); // nothing within 1 m below
  });

  it('measures clearance up to the cap', () => {
    expect(headroom(fx, 4, -5, 1.0, R, 4)).toBeCloseTo(0.6, 9); // ledge top -> low ceiling
    expect(headroom(fx, 0, 0, 0, R, 4)).toBe(4); // open above, capped
  });
});

describe('collide and slide', () => {
  it('stops flush against a wall', () => {
    const m = moveCapsule(fx, 0, 0, 0, 0, 0, 5, R, H);
    expect(m.hitWall).toBe(true);
    expect(m.z).toBeCloseTo(4 - R, 2);
    expect(m.travelXZ).toBeLessThan(m.requestedXZ);
  });

  it('slides along it instead of stopping dead', () => {
    const m = moveCapsule(fx, 0, 0, 0, -2, 0, 5, R, H);
    expect(m.hitWall).toBe(true);
    expect(m.z).toBeCloseTo(4 - R, 2);
    expect(m.x).toBeCloseTo(-2, 2); // kept all of the tangential motion
    expect(Math.hypot(m.wallNX, m.wallNZ)).toBeCloseTo(1, 6);
    expect(m.wallNZ).toBeLessThan(-0.9); // pushed back south
  });

  it('does not tunnel through a wall at speed', () => {
    // One 60 Hz step of an absurd 2400 m/s dash straight at the block.
    const m = moveCapsule(fx, 0, 0, 0, 0, 0, 40, R, H);
    expect(m.z).toBeLessThan(4 - R + 1e-3);
  });

  it('walks up a step at the limit and is stopped by a taller one', () => {
    const up = moveCapsule(fx, 0.5, 0, 0, 3, 0, 0, R, H, { stepUp: STEP_UP_MAX });
    expect(up.steppedUp).toBeCloseTo(0.3, 6);
    expect(up.y).toBeCloseTo(0.3, 6);
    expect(up.x).toBeCloseTo(3.5, 6);

    const blocked = moveCapsule(fx, -0.5, 0, 0, -3, 0, 0, R, H, { stepUp: STEP_UP_MAX });
    expect(blocked.steppedUp).toBe(0);
    expect(blocked.x).toBeCloseTo(-2 + R, 2);
    expect(blocked.hitWall).toBe(true);
  });

  it('never steps up when step-up is disabled', () => {
    const m = moveCapsule(fx, 0.5, 0, 0, 3, 0, 0, R, H, { stepUp: 0 });
    expect(m.steppedUp).toBe(0);
    expect(m.x).toBeCloseTo(2 - R, 2);
  });

  it('falls onto the surface below and reports the landing', () => {
    const m = moveCapsule(fx, 0, 3, 0, 0, -5, 0, R, H);
    expect(m.hitGround).toBe(true);
    expect(m.y).toBeCloseTo(0, 3);
  });

  it('is stopped by the ceiling on the way up', () => {
    const m = moveCapsule(world, 3, 0, 5, 0, 8, 0, R, H);
    expect(m.hitCeiling).toBe(true);
    expect(m.y).toBeCloseTo(7 - H, 2);
  });

  it('leaves free motion untouched', () => {
    const m = moveCapsule(fx, 0, 0, 0, 1, 0, 1, R, H);
    expect(m.hitWall).toBe(false);
    expect(m.x).toBeCloseTo(1, 9);
    expect(m.z).toBeCloseTo(1, 9);
    expect(m.travelXZ).toBeCloseTo(m.requestedXZ, 6);
  });
});

describe('depenetration', () => {
  it('pushes a body out of a box sideways', () => {
    const p = resolvePenetration(fx, 3, 0, 0, R, H);
    expect(p.moved).toBe(true);
    expect(capsuleOverlaps(fx, p.x, p.y, p.z, R, H)).toBe(false);
  });

  it('pushes a body out of the cylinder radially', () => {
    const p = resolvePenetration(fx, 6, 1, 8, R, H);
    expect(Math.hypot(p.x - 6, p.z - 8)).toBeGreaterThanOrEqual(1 + R - 1e-6);
    expect(capsuleOverlaps(fx, p.x, p.y, p.z, R, H)).toBe(false);
  });

  it('leaves a clear body alone', () => {
    const p = resolvePenetration(fx, 0, 0, 0, R, H);
    expect(p.moved).toBe(false);
    expect([p.x, p.y, p.z]).toEqual([0, 0, 0]);
  });

  it('resolves a body standing inside the sample map tank', () => {
    const p = resolvePenetration(world, 16, 1, 16, R, H);
    expect(Math.hypot(p.x - 16, p.z - 16)).toBeGreaterThanOrEqual(3 + R - 1e-6);
    expect(capsuleOverlaps(world, p.x, p.y, p.z, R, H)).toBe(false);
  });
});

describe('ledge probe (mantle candidate)', () => {
  it('finds a ledge ahead and reports its height', () => {
    const hit = ledgeProbe(fx, 0, 0, -3.2, 0, -1, R, H, { ahead: 1.0 });
    expect(hit?.solid.id).toBe('ledge');
    expect(hit?.topY).toBe(1);
    expect(hit?.height).toBe(1);
  });

  it('rejects a ledge with no standing room on top', () => {
    expect(ledgeProbe(fx, 4, 0, -3.2, 0, -1, R, H, { ahead: 1.0 })).toBeNull();
    expect(ledgeProbe(fx, 4, 0, -3.2, 0, -1, R, 0.5, { ahead: 1.0 })?.solid.id).toBe('ledge-covered');
  });

  it('rejects surfaces above the mantle limit and below the vault minimum', () => {
    expect(ledgeProbe(fx, 0, 0, 3.2, 0, 1, R, H, { ahead: 1.0 })).toBeNull(); // 3 m block
    expect(ledgeProbe(fx, 1.2, 0, 0, 1, 0, R, H, { ahead: 1.0, minHeight: 0.4 })).toBeNull(); // 0.3 step
    expect(ledgeProbe(fx, 1.2, 0, 0, 1, 0, R, H, { ahead: 1.0, minHeight: 0.2 })?.solid.id).toBe('step-0.3');
  });

  it('ignores what is behind the body', () => {
    expect(ledgeProbe(fx, 0, 0, -3.2, 0, 1, R, H, { ahead: 1.0 })).toBeNull();
  });

  it('finds the sample map crate chain from the floor', () => {
    expect(ledgeProbe(world, 27, 0, 4.2, 0, 1, R, H, { ahead: 1.2 })?.topY).toBe(1.2);
    expect(ledgeProbe(world, 42, 0, 4.0, 0, 1, R, H, { ahead: 1.2 })?.topY).toBe(2.0);
  });
});

describe('ladders', () => {
  it('grabs only inside the volume', () => {
    expect(ladderAt(fx, 9.5, 0, 0, R)?.def.id).toBe('fixture-ladder');
    expect(ladderAt(fx, 8.5, 0, 0, R)).toBeNull(); // too far out
    expect(ladderAt(fx, 9.5, 0, 1.5, R)).toBeNull(); // beside the rungs
  });

  it('grabs along the whole run and a little above the top', () => {
    expect(ladderAt(fx, 9.5, 2, 0, R)?.def.id).toBe('fixture-ladder');
    expect(ladderAt(fx, 9.5, 4.3, 0, R)?.def.id).toBe('fixture-ladder');
    expect(ladderAt(fx, 9.5, 5.0, 0, R)).toBeNull();
  });
});

describe('rays', () => {
  it('reports distance and face normal', () => {
    const hit = raycast(fx, 0, 0.2, 0, 1, 0, 0, 10);
    expect(hit?.solid.id).toBe('step-0.3');
    expect(hit?.t).toBeCloseTo(2, 6);
    expect([hit?.nx, hit?.ny, hit?.nz]).toEqual([-1, 0, 0]);
  });

  it('misses what is out of range and what is out of the height band', () => {
    expect(raycast(fx, 0, 0.2, 0, 1, 0, 0, 1.5)).toBeNull();
    expect(raycast(fx, 0, 1, 0, 1, 0, 0, 10)).toBeNull(); // over the 0.3 step
  });

  it('hits the nearest solid, not the first found', () => {
    const hit = raycast(fx, -9, 0.2, 0, 1, 0, 0, 20);
    expect(hit?.solid.id).toBe('wall-0.5');
    expect(hit?.t).toBeCloseTo(5, 6);
  });

  it('hits the cylinder on its curved face', () => {
    const hit = raycast(fx, 0, 1, 8, 1, 0, 0, 20);
    expect(hit?.solid.id).toBe('pillar');
    expect(hit?.t).toBeCloseTo(5, 6);
    expect(hit?.nx).toBeCloseTo(-1, 6);
  });

  it('answers segment clearance both ways', () => {
    expect(segmentClear(fx, 0, 0.2, 0, 1.5, 0.2, 0)).toBe(true);
    expect(segmentClear(fx, 0, 0.2, 0, 3, 0.2, 0)).toBe(false);
    expect(segmentClear(fx, 0, 1, 0, 5, 1, 0)).toBe(true); // over the 0.3 step
  });

  it('reports the sample map floor beneath the spawn', () => {
    const hit = raycast(world, 3, 1.6, 3, 0, -1, 0, 5);
    expect(hit?.solid.kind).toBe('floor');
    expect(hit?.t).toBeCloseTo(1.6, 6);
    expect(hit?.ny).toBe(1);
  });
});
