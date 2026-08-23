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
  type World,
} from '../src/core/map/build.js';
import { MAP_D, MAP_H, MAP_W, sampleMap } from '../src/core/map/sampleMap.js';
import type { DoorDef } from '../src/core/map/types.js';
import { CAN_RADIUS, CAPSULE_RADIUS, HEIGHT_CROUCH, HEIGHT_STAND } from '../src/core/const.js';

const world = buildWorld(sampleMap);
const R = CAPSULE_RADIUS;
/** Height a dog's ears/body occupy — the y the patrol legs are checked at. */
const DOG_Y = 0.5;
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

  it('opens the catwalk hatch over the ladder and lands the climber on deck (derivation 3)', () => {
    const l = world.ladders.find((v) => v.def.id === 'ladder-mezzanine');
    expect(l).toBeTruthy();
    expect(l!.yTop).toBe(3.5);
    expect(ladderAt(world, 0.5, 0, 23, R)?.def.id).toBe('ladder-mezzanine');

    // (a) The hatch is open over the ladder's own x-footprint, and only there. Slab returns
    //     immediately north and south of it, and the +x dismount strip runs straight through.
    for (const x of [l!.minX + 0.05, (l!.minX + l!.maxX) / 2, l!.maxX - 0.05]) {
      expect(solidAt(world, x, 3.4, 23), `hatch @ x${x}`).toBeNull();
    }
    expect(solidAt(world, 0.5, 3.4, 22)?.id).toBe('catwalk-west-w-n');
    expect(solidAt(world, 0.5, 3.4, 24)?.id).toBe('catwalk-west-w-s');
    expect(solidAt(world, 1.2, 3.4, 23)?.id).toBe('catwalk-west-e');

    // (b) The climber faces +x, so they step off one capsule radius clear of the rungs — and
    //     there is deck under them at catwalk height, not a 3.5 m drop.
    const stepX = l!.maxX + R;
    const dismount = groundUnder(world, stepX, 23, 3.5, R, 0.6);
    expect(dismount?.y).toBe(3.5);
    expect(dismount?.solid.id).toBe('catwalk-west-e');
    expect(capsuleOverlaps(world, stepX, 3.5, 23, R, HEIGHT_STAND)).toBe(false);

    // The deck stays continuous either side of the hatch.
    expect(groundUnder(world, 0.5, 22, 3.5, R, 0.5)?.y).toBe(3.5);
    expect(groundUnder(world, 0.5, 24, 3.5, R, 0.5)?.y).toBe(3.5);
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

  it('leaves the slide duct at 1.2 m — crouchable, not standable', () => {
    const duct = world.solids.find((s) => s.id === 'duct')!;
    expect(duct.minY).toBeGreaterThan(HEIGHT_CROUCH);
    expect(duct.minY).toBeLessThan(HEIGHT_STAND);
    expect(headroom(world, 24, 1, 0, R, 5)).toBeCloseTo(1.2, 6);
    expect(capsuleOverlaps(world, 24, 0, 1, R, HEIGHT_STAND)).toBe(true);
    expect(capsuleOverlaps(world, 24, 0, 1, R, HEIGHT_CROUCH)).toBe(false);
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

  it('leaves a straight crouch lane through the can field into door [f]', () => {
    // doc §2 D2: "crouch line through is authored to exist". A body of radius R must clear
    // every can (radius CAN_RADIUS) somewhere inside the 1.6 m opening, on a straight line.
    const field = sampleMap.props.filter((p) => p.type === 'can' && p.id.startsWith('can-field'));
    expect(field).toHaveLength(6);
    const door = sampleMap.doors.find((d) => d.id === 'f')!;
    const need = R + CAN_RADIUS;
    let best = -1;
    for (let x = door.from + R; x <= door.to - R; x += 0.005) {
      let clear = Infinity;
      for (const c of field) clear = Math.min(clear, Math.abs(x - (c as { x: number }).x));
      if (clear > best) best = clear;
    }
    expect(best).toBeGreaterThan(need);
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

  it('walks every patrol leg of every route without crossing a solid (derivation 6)', () => {
    // A dog navigates to the next waypoint in a straight line; a leg that penetrates geometry
    // is an unwalkable patrol, not a steering problem for M5 to solve.
    const bad: string[] = [];
    for (const route of sampleMap.dogRoutes) {
      const wps = route.waypoints;
      for (let i = 0; i < wps.length; i++) {
        const a = wps[i]!;
        const b = wps[(i + 1) % wps.length]!;
        const walls = countWalls(world, a.x, DOG_Y, a.z, b.x, DOG_Y, b.z);
        if (walls > 0) bad.push(`${route.id} (${a.x},${a.z})->(${b.x},${b.z}) crosses ${walls}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps dog 2 on the floor and clear of the B-hall columns and the tank', () => {
    const route = sampleMap.dogRoutes.find((r) => r.id === 'dog2')!;
    // Derivation 6: the doc's z=10 north leg runs through the columns at (12,10) and (18,10).
    expect(route.waypoints.filter((w) => w.z === 11.5)).toHaveLength(2);
    const wps = route.waypoints;
    for (let i = 0; i < wps.length; i++) {
      const a = wps[i]!;
      const b = wps[(i + 1) % wps.length]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.25));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const where = `dog2 @ ${x.toFixed(2)},${z.toFixed(2)}`;
        expect(groundUnder(world, x, z, 0, 0.3, 0.5)?.y, `${where} ground`).toBe(0);
        expect(capsuleOverlaps(world, x, 0, z, 0.3, 0.9), `${where} body`).toBe(false);
      }
    }
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
      'catwalk-west-w-n',
      'catwalk-west-w-s',
      'catwalk-west-e',
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

  it('drops tops at or above the interior ceiling', () => {
    // The ceiling slab's own top (y 7.4) is outside the playable volume: nothing stands on the
    // roof, and a walkable there would feed M3's hold lines a surface no body can reach.
    const interiorTop = Math.max(...sampleMap.air.map((a) => a.max[1]));
    for (const w of world.walkables) expect(w.y, w.solid.id).toBeLessThan(interiorTop);
    expect(new Set(world.walkables.map((w) => w.solid.id)).has('ceiling')).toBe(false);
  });

  it('holds the authored counts (update these deliberately when the map changes)', () => {
    expect(world.solids).toHaveLength(63);
    expect(world.walkables).toHaveLength(21);
  });

  it('indexes every solid in the broadphase', () => {
    expect(world.solids).toHaveLength(sampleMap.solids.length);
    world.solids.forEach((s, i) => expect(s.index).toBe(i));
  });

  it('keeps occluders in their own array, index-aligned with solids', () => {
    // countWalls reads `occluders`, never `solids`. M3 may narrow it to the kinds that really
    // block sound; the collision set must not change when it does, so it must not be the
    // SAME array — an alias would make that filtering silently delete collision geometry.
    expect(world.occluders).not.toBe(world.solids);
    expect(world.occluders).toEqual(world.solids);
    world.occluders.forEach((s, i) => expect(s).toBe(world.solids[i]));
  });

  it('declares the world bounds readonly', () => {
    // A compile-time guarantee, not Object.freeze: the assignment below is a runtime no-op and
    // must be a type error. Drop the `readonly` modifiers and `npm run typecheck` fails on the
    // now-unused @ts-expect-error, which is exactly the alarm we want.
    const b: World['bounds'] = world.bounds;
    // @ts-expect-error bounds fields are readonly
    b.minX = b.minX;
    expect(world.bounds.minX).toBeCloseTo(-0.4, 9);
  });
});

describe('authored solid overlaps (engine-plan §10)', () => {
  /**
   * Overlaps that are authored on purpose. Two families, both forced by sample-map §0:
   *
   *   (a) wall-run T-junctions — a run authored as explicit segments ends INSIDE the run it
   *       meets, because both are 0.4 thick and centred on their plan coordinate; and
   *   (b) a mass that runs out to the wall CENTRELINE it abuts ("every zone rectangle in the
   *       doc is the nominal rectangle out to those centrelines"), lapping 0.2 m into it.
   *
   * Anything not on this list is a mistake: the point of the spec is that a new overlap —
   * crate into crate, deck into column — cannot appear unnoticed.
   */
  const ALLOWED = new Set([
    // (a) T-junctions and corner joins between wall runs
    'w-c-south:pre-b|w-a-east:pre-mez-e',
    'w-c-south:pre-b|w-a-east:sill-mez-e',
    'w-c-south:pre-c|w-b-d1:pre-e',
    'w-listening:end|w-e-d2:pre-h',
    // (b) masses authored out to the centreline of the wall they abut
    'w-c-south:pre-b|catwalk-north',
    'w-listening:pre-g|catwalk-west-w-s',
    'w-listening:lintel-g|catwalk-west-w-s',
    'w-listening:lintel-g|catwalk-west-e',
    'w-listening:end|machinery-row',
    'w-listening:end|mass-block',
    'w-b-d1:end|mass-block',
    'w-e-d2:pre-h|mass-block',
  ]);

  it('has no unintended interpenetration anywhere inside the building', () => {
    // The envelope is excluded: things resting on the floor slab or tucked under the ceiling
    // are not authoring errors, they are the building.
    const envelope = new Set(['shell-w', 'shell-e', 'shell-n', 'shell-s', 'ceiling']);
    const interior = world.solids.filter((s) => !envelope.has(s.id) && s.kind !== 'floor');
    const bad: string[] = [];
    for (let i = 0; i < interior.length; i++) {
      for (let k = i + 1; k < interior.length; k++) {
        const a = interior[i]!;
        const b = interior[k]!;
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        if (ox <= 1e-6 || oy <= 1e-6 || oz <= 1e-6) continue;
        if (ALLOWED.has(`${a.id}|${b.id}`)) continue;
        bad.push(`${a.id} x ${b.id} (${ox.toFixed(3)} x ${oy.toFixed(3)} x ${oz.toFixed(3)} m)`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps the allowlist honest — every entry is still a real overlap', () => {
    const by = new Map(world.solids.map((s) => [s.id, s]));
    for (const pair of ALLOWED) {
      const [aId, bId] = pair.split('|') as [string, string];
      const a = by.get(aId);
      const b = by.get(bId);
      expect(a, aId).toBeTruthy();
      expect(b, bId).toBeTruthy();
      const ox = Math.min(a!.maxX, b!.maxX) - Math.max(a!.minX, b!.minX);
      const oy = Math.min(a!.maxY, b!.maxY) - Math.max(a!.minY, b!.minY);
      const oz = Math.min(a!.maxZ, b!.maxZ) - Math.max(a!.minZ, b!.minZ);
      expect(Math.min(ox, oy, oz), pair).toBeGreaterThan(1e-6);
    }
  });

  it('never lets two crates interpenetrate (derivation 4)', () => {
    const crates = world.solids.filter((s) => s.kind === 'crate');
    const bad: string[] = [];
    for (let i = 0; i < crates.length; i++) {
      for (let k = i + 1; k < crates.length; k++) {
        const a = crates[i]!;
        const b = crates[k]!;
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        if (ox > 1e-6 && oy > 1e-6 && oz > 1e-6) bad.push(`${a.id} x ${b.id}`);
      }
    }
    expect(bad).toEqual([]);
    // …and the nudged crate really does sit flush against the 2.0 stack, not away from it.
    const crate = world.solids.find((s) => s.id === 'crate-41.8-7.4')!;
    const stack = world.solids.find((s) => s.id === 'crate-stack')!;
    expect(crate.minZ).toBeCloseTo(stack.maxZ, 9);
  });
});
