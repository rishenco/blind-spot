/**
 * Map sanity for "Dock Approach" (engine-plan §10: "no overlapping solids where rooms should
 * be, doors actually open: raycast through each doorway crosses no solid").
 *
 * Note on overlap: authored wall runs deliberately share corners with the runs they T into, so
 * "no overlapping solids" is asserted where it means something — inside the rooms.
 */

import { describe, expect, it } from 'vitest';
import {
  buildWorld,
  capsuleOverlaps,
  countWalls,
  groundUnder,
  headroom,
  insideAir,
  ladderAt,
  segmentClear,
  solidAt,
} from '../src/core/map/build.js';
import { MAP_D, MAP_H, MAP_W, sampleMap } from '../src/core/map/sampleMap.js';
import type { DoorDef } from '../src/core/map/types.js';
import { CAPSULE_RADIUS, HEIGHT_STAND } from '../src/core/const.js';

const world = buildWorld(sampleMap);
const R = CAPSULE_RADIUS;
const walkableDoors = sampleMap.doors.filter((d) => d.walkable);

/** Point on a door's centreline, `off` metres along the wall's normal. */
function acrossDoor(d: DoorDef, off: number, y: number): [number, number, number] {
  const mid = (d.from + d.to) / 2;
  return d.axis === 'z' ? [mid, y, d.at + off] : [d.at + off, y, mid];
}

describe('bounds and zones', () => {
  it('declares the authored extents', () => {
    expect([MAP_W, MAP_D, MAP_H]).toEqual([45, 30, 7]);
    const near = (v: readonly number[], want: number[]): void =>
      want.forEach((w, i) => expect(v[i]).toBeCloseTo(w, 9));
    near(sampleMap.bounds.min, [-0.4, -3.2, -0.4]); // shell, trench floor, shell
    near(sampleMap.bounds.max, [45.4, 7.4, 30.4]);
  });

  it('spawns a standing body in clear air on the floor of zone A', () => {
    const [sx, sy, sz] = sampleMap.spawn.pos;
    expect(capsuleOverlaps(world, sx, sy, sz, R, HEIGHT_STAND)).toBe(false);
    expect(groundUnder(world, sx, sz, sy, R, 1)?.y).toBe(0);
    expect(insideAir(world, sx, sy + 1, sz)).toBe(true);
    expect(sampleMap.spawn.yaw).toBe(0); // yaw 0 == +x
  });

  it('keeps every room interior clear at walking height', () => {
    const samples: Array<[string, number, number]> = [
      ['A', 3, 3],
      ['A', 1.2, 1.2],
      ['B', 8, 8],
      ['B', 20, 22],
      ['B', 2.5, 14],
      ['C', 15, 1],
      ['C', 28, 1],
      ['C', 44, 1],
      ['D1', 32, 9],
      ['D1', 44, 14],
      ['D2', 30, 20],
      ['D2', 40, 28],
      ['E', 4, 28],
      ['E', 22, 28],
    ];
    for (const [zone, x, z] of samples) {
      for (const y of [0.2, 1.0, 1.6]) {
        expect(solidAt(world, x, y, z), `${zone} @ ${x},${y},${z}`).toBeNull();
      }
      expect(capsuleOverlaps(world, x, 0, z, R, HEIGHT_STAND), `${zone} capsule @ ${x},${z}`).toBe(false);
      expect(groundUnder(world, x, z, 0, R, 1)?.y, `${zone} floor @ ${x},${z}`).toBe(0);
    }
  });

  it('seals the interior: shell and ceiling on all sides', () => {
    expect(solidAt(world, -0.2, 3, 15)?.id).toBe('shell-w');
    expect(solidAt(world, 45.2, 3, 15)?.id).toBe('shell-e');
    expect(solidAt(world, 22, 3, -0.2)?.id).toBe('shell-n');
    expect(solidAt(world, 22, 3, 30.2)?.id).toBe('shell-s');
    expect(solidAt(world, 22, 7.2, 15)?.id).toBe('ceiling');
    expect(solidAt(world, 22, 6.9, 15)).toBeNull();
  });
});

describe('doors actually open', () => {
  it('authors eight walkable openings plus two mezzanine pass-throughs', () => {
    expect(walkableDoors.map((d) => d.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(
      sampleMap.doors
        .filter((d) => !d.walkable)
        .map((d) => d.id)
        .sort(),
    ).toEqual(['mez-e', 'mez-s']);
    for (const d of walkableDoors) {
      expect(d.to - d.from, `${d.id} width`).toBeCloseTo(1.6, 9);
      expect(d.yTop - d.yBottom, `${d.id} height`).toBeCloseTo(2.4, 9);
      expect(d.yBottom, `${d.id} sill`).toBe(0);
    }
  });

  for (const d of walkableDoors) {
    it(`[${d.id}] passes a raycast, a standing body and a lintel check`, () => {
      // Raycast straight through the opening at three heights: no solid crossed.
      for (const y of [0.15, 1.2, 2.2]) {
        const a = acrossDoor(d, -1.5, y);
        const b = acrossDoor(d, 1.5, y);
        expect(segmentClear(world, a[0], a[1], a[2], b[0], b[1], b[2]), `${d.id} @ y${y}`).toBe(true);
        expect(countWalls(world, a[0], a[1], a[2], b[0], b[1], b[2]), `${d.id} walls @ y${y}`).toBe(0);
      }
      // A standing capsule fits, and the only thing overhead is the lintel.
      const [x, , z] = acrossDoor(d, 0, 0);
      expect(capsuleOverlaps(world, x, 0, z, R, HEIGHT_STAND)).toBe(false);
      expect(headroom(world, x, z, 0, R, 4)).toBeCloseTo(2.4, 6);
      expect(solidAt(world, x, d.yTop + 0.2, z), `${d.id} lintel`).not.toBeNull();
    });
  }

  it('walls the openings shut on either side', () => {
    // Wall bodies, sampled well away from every opening.
    expect(solidAt(world, 6, 1, 3.5)?.id).toContain('w-a-east');
    expect(solidAt(world, 5, 1, 6)?.id).toContain('w-a-south');
    expect(solidAt(world, 15, 1, 2.2)?.id).toContain('w-c-south');
    expect(solidAt(world, 24, 1, 14)?.id).toContain('w-b-d1');
    expect(solidAt(world, 35, 1, 16)?.id).toContain('w-d1-d2');
    expect(solidAt(world, 22, 1, 26)?.id).toContain('w-listening');
    expect(solidAt(world, 26, 1, 29.5)?.id).toContain('w-e-d2');
  });

  it('keeps the mezzanine pass-throughs shut at walking height, open at catwalk height', () => {
    // mez-e (x 6, z 2.2..3.8) and mez-s (z 6, x 0..1.6) open only above y 3.2.
    expect(solidAt(world, 6, 1, 3)).not.toBeNull();
    expect(solidAt(world, 6, 5, 3)).toBeNull();
    expect(solidAt(world, 0.8, 1, 6)).not.toBeNull();
    expect(solidAt(world, 0.8, 5, 6)).toBeNull();
  });
});

describe('vertical features', () => {
  it('drops the corridor pit to the trench and lets the ladder out', () => {
    // Hole in the floor slab: x 31..35, north of the z=2.2 wall.
    expect(solidAt(world, 33, -0.2, 1)).toBeNull();
    expect(solidAt(world, 30.5, -0.2, 1)?.kind).toBe('floor'); // west lip
    expect(solidAt(world, 35.5, -0.2, 1)?.kind).toBe('floor'); // east lip
    expect(solidAt(world, 33, -0.2, 2.3)?.kind).toBe('floor'); // south lip
    // 2.8 m drop, per sample-map §2.
    expect(groundUnder(world, 33, 1, 0, R, 4)?.y).toBe(-2.8);
    expect(capsuleOverlaps(world, 33, -2.8, 1, R, HEIGHT_STAND)).toBe(false);
    const l = ladderAt(world, 34.2, -2.8, 1, R);
    expect(l?.def.id).toBe('ladder-trench');
    expect([l?.yBase, l?.yTop]).toEqual([-2.8, 0]);
  });

  it('puts the mezzanine ladder under the catwalk hatch', () => {
    const l = ladderAt(world, 0.5, 0, 23, R);
    expect(l?.def.id).toBe('ladder-mezzanine');
    expect(l?.yTop).toBe(3.5);
    // The hatch: no slab over the ladder, slab immediately north and south of it.
    expect(solidAt(world, 0.8, 3.4, 23)).toBeNull();
    expect(solidAt(world, 0.8, 3.4, 22)?.id).toBe('catwalk-west-n');
    expect(solidAt(world, 0.8, 3.4, 24)?.id).toBe('catwalk-west-s');
    expect(groundUnder(world, 0.8, 22, 3.5, R, 0.5)?.y).toBe(3.5);
  });

  it('runs the mezzanine as one continuous L (derivation 2)', () => {
    for (const [x, z] of [
      [0.8, 20],
      [0.8, 10],
      [0.8, 4.5],
      [3, 3],
      [8, 3],
    ] as const) {
      expect(groundUnder(world, x, z, 3.5, R, 0.4)?.y, `catwalk @ ${x},${z}`).toBe(3.5);
      expect(capsuleOverlaps(world, x, 3.5, z, R, HEIGHT_STAND), `headroom @ ${x},${z}`).toBe(false);
    }
  });

  it('keeps the gantry beam a 0.7 m mantle above the north catwalk', () => {
    expect(groundUnder(world, 9.6, 10, 4.2, R, 0.4)?.y).toBe(4.2);
    expect(4.2 - 3.5).toBeCloseTo(0.7, 9);
  });

  it('holds the crate mantle chain 1.2 -> 2.0 -> 3.3', () => {
    expect(groundUnder(world, 27, 6, 1.2, R, 0.4)?.y).toBe(1.2);
    expect(groundUnder(world, 42, 6, 2.0, R, 0.4)?.y).toBe(2.0);
    expect(groundUnder(world, 44, 7, 3.3, R, 0.4)?.y).toBe(3.3);
  });

  it('leaves the slide duct at 1.2 m — crouch height, not stand height', () => {
    expect(headroom(world, 24, 1, 0, R, 5)).toBeCloseTo(1.2, 6);
    expect(capsuleOverlaps(world, 24, 0, 1, R, HEIGHT_STAND)).toBe(true);
    expect(capsuleOverlaps(world, 24, 0, 1, R, 1.1)).toBe(false);
  });

  it('makes the machinery row a 2.2 m listening post', () => {
    expect(groundUnder(world, 12, 25, 2.2, R, 0.4)?.y).toBe(2.2);
  });

  it('stands the tank as one 6 m cylinder', () => {
    expect(solidAt(world, 16, 3, 16)?.id).toBe('tank');
    expect(solidAt(world, 16, 3, 18.9)?.id).toBe('tank');
    expect(solidAt(world, 16, 3, 19.1)).toBeNull();
    expect(solidAt(world, 16, 6.6, 16)).toBeNull();
  });
});

describe('propagation fixtures (vision §3.4)', () => {
  it('counts zero walls inside one room', () => {
    expect(countWalls(world, 8, 1.5, 8, 8, 1.5, 22)).toBe(0);
    expect(countWalls(world, 28, 1.5, 4, 44, 1.5, 12)).toBe(0);
  });

  it('counts one wall between neighbours', () => {
    expect(countWalls(world, 28, 1.5, 1, 28, 1.5, 6)).toBe(1); // C -> D1
    expect(countWalls(world, 20, 1.5, 20, 30, 1.5, 20)).toBe(1); // B -> D2 through the mass block
  });

  it('counts two walls two rooms away — the "nothing gets through" case', () => {
    expect(countWalls(world, 28, 1.5, 1, 28, 1.5, 20)).toBe(2); // C -> D1 -> D2
  });

  it('merges abutting and overlapping solids into one wall', () => {
    // At x = 24 the duct's south face meets the B|D1 wall, which in turn overlaps C's south
    // wall. Three authored boxes, one wall to hearing.
    expect(solidAt(world, 24, 3, 1.8)?.id).toBe('duct');
    expect(solidAt(world, 24, 3, 2.1)?.id).toContain('w-');
    expect(countWalls(world, 24, 3, 1, 24, 3, 5)).toBe(1);
    expect(countWalls(world, 24, 0.6, 1, 24, 0.6, 5)).toBe(1);
  });

  it('treats a doorway lintel as the wall it belongs to, and the opening as no wall', () => {
    expect(countWalls(world, 10.8, 3.0, 1, 10.8, 3.0, 5)).toBe(1); // over door [b]
    expect(countWalls(world, 10.8, 1.0, 1, 10.8, 1.0, 5)).toBe(0); // through door [b]
  });

  it('ignores grazes shorter than the minimum chord', () => {
    const graze = 16 + 2.9999; // ~0.05 m chord across the tank
    expect(countWalls(world, 10, 1.5, graze, 22, 1.5, graze)).toBe(0);
    const bite = 16 + 2.9; // ~1.5 m chord
    expect(countWalls(world, 10, 1.5, bite, 22, 1.5, bite)).toBe(1);
  });
});

describe('props and routes', () => {
  it('places eight cans, none of them solid', () => {
    const cans = sampleMap.props.filter((p) => p.type === 'can');
    expect(cans).toHaveLength(8);
    for (const c of cans) {
      if (c.type !== 'can') continue;
      expect(solidAt(world, c.x, 0.15, c.z), c.id).toBeNull();
    }
  });

  it('leaves a crouch lane through the can field', () => {
    const field = sampleMap.props.filter((p) => p.type === 'can' && p.id.startsWith('can-field'));
    expect(field).toHaveLength(6);
    // ~0.95 m of clear x at the [f] doorway, between the west and east clusters.
    const inLane = field.filter((p) => p.type === 'can' && Math.abs(p.x - 40.95) < 0.47);
    expect(inLane).toHaveLength(0);
  });

  it('hangs the chain curtain in door [c]', () => {
    const chain = sampleMap.props.find((p) => p.id === 'chain-c');
    const door = sampleMap.doors.find((d) => d.id === 'c');
    expect(chain?.type).toBe('chain');
    expect(door).toBeDefined();
    if (chain?.type === 'chain' && door) {
      expect(chain.min[0]).toBe(door.from);
      expect(chain.max[0]).toBe(door.to);
      expect(chain.max[1]).toBe(door.yTop);
    }
  });

  it('stands the beacon on its pedestal', () => {
    const beacon = sampleMap.props.find((p) => p.id === 'beacon');
    expect(beacon?.type).toBe('beacon');
    if (beacon?.type !== 'beacon') return;
    expect(groundUnder(world, beacon.x, beacon.z, beacon.y, R, 0.3)?.solid.id).toBe('beacon-pedestal');
  });

  it('keeps dog 1 on the floor and clear of walls along every leg', () => {
    const route = sampleMap.dogRoutes.find((r) => r.id === 'dog1');
    expect(route?.defaultOn).toBe(true);
    const wps = route?.waypoints ?? [];
    expect(wps.length).toBeGreaterThan(3);
    for (let i = 0; i < wps.length; i++) {
      const a = wps[i]!;
      const b = wps[(i + 1) % wps.length]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.25));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const where = `dog1 @ ${x.toFixed(2)},${z.toFixed(2)}`;
        expect(groundUnder(world, x, z, 0, 0.3, 0.5)?.y, `${where} ground`).toBe(0);
        expect(capsuleOverlaps(world, x, 0, z, 0.3, 0.9), `${where} body`).toBe(false);
      }
    }
  });

  it('flags dog 2 as off by default', () => {
    expect(sampleMap.dogRoutes.find((r) => r.id === 'dog2')?.defaultOn).toBe(false);
  });
});

describe('built world', () => {
  it('exposes the walkable tops movement will stand on', () => {
    const ids = new Set(world.walkables.map((w) => w.solid.id));
    for (const id of [
      'floor-w',
      'floor-pit-s',
      'floor-e',
      'trench-floor',
      'crate-27-6',
      'crate-stack',
      'catwalk-west-n',
      'catwalk-north',
      'gantry-beam',
      'high-shelf',
      'machinery-row',
      'beacon-pedestal',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('drops tops that are buried under another solid', () => {
    const ids = new Set(world.walkables.map((w) => w.solid.id));
    // The mezzanine pass-through sill tops out at y 3.2, directly under the north catwalk.
    expect(ids.has('w-a-east:sill-mez-e')).toBe(false);
  });

  it('indexes every solid in the broadphase', () => {
    expect(world.solids).toHaveLength(sampleMap.solids.length);
    world.solids.forEach((s, i) => expect(s.index).toBe(i));
    expect(world.occluders.length).toBe(world.solids.length);
  });
});
