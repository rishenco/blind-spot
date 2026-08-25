/**
 * `raycastWorld` — the nearest-hit ray query, and the shared slab core underneath it.
 *
 * Two jobs here, and they pull in opposite directions:
 *
 *  1. **Pin the new surface.** `raycastWorld` exists for M2 throwables (a bounce needs the
 *     normal, and a can off metal needs the *box*) and M4 spiders (surface-attach needs the
 *     normal), neither of which is written yet. So the tests have to state the contract those
 *     will be built on rather than describe today's only caller — especially the degenerate
 *     answers, which are where a physics consumer actually lives: origin on a face, origin
 *     inside a box, ray along a face, `maxDist` landing exactly on the surface.
 *  2. **Prove the consolidation moved nothing.** `raySlabEnter` replaced two hand-written
 *     ray-slab loops — `sweepSphereWorld`'s and `StructuredPaint.hits`'s. Both are pre-existing
 *     behaviour with pinned consequences downstream (the lattice dot count in `rng.test.ts` is
 *     the paint-side canary), so the loops each get a differential test against a verbatim copy
 *     of the code they replaced. Those copies are historical records: if one of them disagrees
 *     with the shared core, the shared core is wrong. Do not edit a legacy copy to agree.
 *
 * Every number below comes out of `+ - * /` and `Math.sqrt` on exactly representable inputs
 * wherever it could be arranged, so the assertions are exact equalities; the oblique rays,
 * whose directions are normalised, use a tolerance and check the hit lands on the face plane.
 */

import { describe, expect, it } from 'vitest';
import {
  StaticWorld,
  aabbFromBounds,
  createRayHit,
  raySlabEnter,
  raycastWorld,
  sweepSphereWorld,
  type Aabb,
  type RayHit,
} from '../src/core/collision';
import { MAT_CONCRETE, MAT_METAL } from '../src/paint/materials';
import { makeRng } from '../src/core/rng';
import { createHeadlessGame } from '../src/game/headless';

/** The unit cube centred on the origin: every face is one metre out along its own axis. */
const CUBE = aabbFromBounds(-1, -1, -1, 1, 1, 1, MAT_CONCRETE);

function worldOf(...boxes: Aabb[]): StaticWorld {
  const w = new StaticWorld();
  for (const b of boxes) w.add(b);
  return w;
}

/** Casts along the normalised direction from `from` towards `to`, so `t` is a real distance. */
function castTowards(
  world: StaticWorld,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  maxDist = 100,
  out?: RayHit,
): RayHit | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len = Math.hypot(dx, dy, dz);
  return raycastWorld(world, from[0], from[1], from[2], dx / len, dy / len, dz / len, maxDist, out);
}

function normalOf(hit: RayHit): [number, number, number] {
  return [hit.nx, hit.ny, hit.nz];
}

interface Face {
  readonly name: string;
  readonly normal: [number, number, number];
  /** Index of the axis the face is on, and the plane it sits at. */
  readonly axis: 0 | 1 | 2;
  readonly plane: number;
  /** An oblique approach: outside the cube on `axis`, aimed at a point inside the face square. */
  readonly from: [number, number, number];
  readonly to: [number, number, number];
}

/**
 * All six faces of `CUBE`. The oblique `from` is always outside the cube *on the face's own
 * axis* and the whole segment approaches that plane monotonically, so the first surface the ray
 * can reach is the face under test — no accidental corner clip to explain away.
 */
const FACES: readonly Face[] = [
  { name: '-X', normal: [-1, 0, 0], axis: 0, plane: -1, from: [-4, 0.7, -0.5], to: [-1, 0.2, 0.3] },
  { name: '+X', normal: [1, 0, 0], axis: 0, plane: 1, from: [4, -0.6, 0.4], to: [1, 0.3, -0.2] },
  { name: '-Y', normal: [0, -1, 0], axis: 1, plane: -1, from: [0.3, -4, 0.6], to: [-0.2, -1, 0.1] },
  { name: '+Y', normal: [0, 1, 0], axis: 1, plane: 1, from: [-0.4, 4, 0.2], to: [0.5, 1, -0.3] },
  { name: '-Z', normal: [0, 0, -1], axis: 2, plane: -1, from: [0.2, -0.3, -4], to: [-0.4, 0.5, -1] },
  { name: '+Z', normal: [0, 0, 1], axis: 2, plane: 1, from: [-0.5, 0.4, 4], to: [0.1, -0.2, 1] },
];

describe('raycastWorld — the six faces', () => {
  for (const face of FACES) {
    it(`reports the ${face.name} normal head-on`, () => {
      // Straight down the axis from three metres out: the direction is a unit axis vector, so
      // the distance is exact rather than merely close.
      const from: [number, number, number] = [
        face.normal[0] * 4,
        face.normal[1] * 4,
        face.normal[2] * 4,
      ];
      const hit = castTowards(worldOf(CUBE), from, [0, 0, 0]);
      expect(hit).not.toBeNull();
      expect(hit!.t).toBe(3);
      expect(normalOf(hit!)).toEqual(face.normal);
      expect(hit!.box).toBe(CUBE);
    });

    it(`reports the ${face.name} normal at an angle`, () => {
      const hit = castTowards(worldOf(CUBE), face.from, face.to);
      expect(hit).not.toBeNull();
      expect(normalOf(hit!)).toEqual(face.normal);
      // The angled hit is only meaningful if it landed where we aimed: on the face's plane.
      const p = [
        face.from[0] + ((face.to[0] - face.from[0]) / dist(face.from, face.to)) * hit!.t,
        face.from[1] + ((face.to[1] - face.from[1]) / dist(face.from, face.to)) * hit!.t,
        face.from[2] + ((face.to[2] - face.from[2]) / dist(face.from, face.to)) * hit!.t,
      ];
      expect(p[face.axis]).toBeCloseTo(face.plane, 12);
      expect(hit!.t).toBeCloseTo(dist(face.from, face.to), 12);
    });
  }

  it('always points the normal back at the ray, on every face and from every angle', () => {
    // The invariant a bounce (`v - 2(v·n)n`) and a surface-attach both stand on. It is stated
    // once here rather than re-derived per consumer.
    for (const face of FACES) {
      const hit = castTowards(worldOf(CUBE), face.from, face.to)!;
      const len = dist(face.from, face.to);
      const d = [
        (face.to[0] - face.from[0]) / len,
        (face.to[1] - face.from[1]) / len,
        (face.to[2] - face.from[2]) / len,
      ];
      expect(hit.nx * d[0]! + hit.ny * d[1]! + hit.nz * d[2]!).toBeLessThan(0);
    }
  });
});

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
}

describe('raycastWorld — misses', () => {
  it('returns null when the ray passes the box entirely', () => {
    expect(raycastWorld(worldOf(CUBE), -4, 3, 0, 1, 0, 0, 100)).toBeNull();
  });

  it('returns null when the box is behind the origin', () => {
    expect(raycastWorld(worldOf(CUBE), -4, 0, 0, -1, 0, 0, 100)).toBeNull();
  });

  it('returns null for an empty world', () => {
    expect(raycastWorld(new StaticWorld(), 0, 0, 0, 1, 0, 0, 100)).toBeNull();
  });
});

describe('raycastWorld — maxDist', () => {
  const wall = aabbFromBounds(4, -1, -1, 5, 1, 1, MAT_CONCRETE);

  it('does not see a surface beyond maxDist', () => {
    expect(raycastWorld(worldOf(wall), 0, 0, 0, 1, 0, 0, 3.999)).toBeNull();
  });

  it('sees a surface at exactly maxDist — the boundary is inclusive', () => {
    // Decided, not inherited: the slab test itself counts a corner grazed at `tmin === tmax`,
    // and for a thrown object stepped by `speed * dt` the alternative is to end the tick exactly
    // touching the wall and hope the next one notices.
    const hit = raycastWorld(worldOf(wall), 0, 0, 0, 1, 0, 0, 4);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBe(4);
    expect(normalOf(hit!)).toEqual([-1, 0, 0]);
  });

  it('measures t in the units of the direction it was given', () => {
    // Not a licence to pass a non-unit direction — a note that `t` is a parameter along `d`, so
    // a caller that scales the direction scales the answer.
    expect(raycastWorld(worldOf(wall), 0, 0, 0, 0.5, 0, 0, 100)!.t).toBe(8);
  });
});

describe('raycastWorld — nearest hit', () => {
  const near = aabbFromBounds(2, -1, -1, 3, 1, 1, MAT_CONCRETE);
  const far = aabbFromBounds(6, -1, -1, 7, 1, 1, MAT_CONCRETE);

  it('takes the nearest of several boxes whichever order the world holds them in', () => {
    for (const world of [worldOf(near, far), worldOf(far, near)]) {
      const hit = raycastWorld(world, 0, 0, 0, 1, 0, 0, 100)!;
      expect(hit.t).toBe(2);
      expect(hit.box).toBe(near);
    }
  });

  it('takes the near face of two boxes sharing one', () => {
    const left = aabbFromBounds(2, -1, -1, 3, 1, 1, MAT_CONCRETE);
    const right = aabbFromBounds(3, -1, -1, 4, 1, 1, MAT_CONCRETE);
    const world = worldOf(left, right);
    const forward = raycastWorld(world, 0, 0, 0, 1, 0, 0, 100)!;
    expect(forward.t).toBe(2);
    expect(forward.box).toBe(left);
    expect(normalOf(forward)).toEqual([-1, 0, 0]);
    // And from the other side, the far box's own outer face.
    const back = raycastWorld(world, 10, 0, 0, -1, 0, 0, 100)!;
    expect(back.t).toBe(6);
    expect(back.box).toBe(right);
    expect(normalOf(back)).toEqual([1, 0, 0]);
  });

  it('gives a tie at the shared face to the first box in the world', () => {
    // Two boxes are entered at t = 0 from the plane they share; nothing tells them apart, so
    // the rule is stability, not merit. Stated so a consumer does not read meaning into it.
    const left = aabbFromBounds(2, -1, -1, 3, 1, 1, MAT_CONCRETE);
    const right = aabbFromBounds(3, -1, -1, 4, 1, 1, MAT_CONCRETE);
    expect(raycastWorld(worldOf(left, right), 3, 0, 0, 1, 0, 0, 100)!.box).toBe(left);
    expect(raycastWorld(worldOf(right, left), 3, 0, 0, 1, 0, 0, 100)!.box).toBe(right);
  });

  it('gives a tie at a distance to the first box too, not just a tie at zero', () => {
    // The same rule where it is actually load-bearing: two boxes stacked across the plane
    // y = 0, both entered at t = 2. The zero-distance tie above short-circuits on "nothing can
    // be nearer than a box we are already inside", so it cannot see which way the comparison
    // that settles ties is written.
    const lower = aabbFromBounds(2, -1, -1, 3, 0, 1, MAT_CONCRETE);
    const upper = aabbFromBounds(2, 0, -1, 3, 1, 1, MAT_CONCRETE);
    const first = raycastWorld(worldOf(lower, upper), 0, 0, 0, 1, 0, 0, 100)!;
    expect(first.t).toBe(2);
    expect(first.box).toBe(lower);
    expect(raycastWorld(worldOf(upper, lower), 0, 0, 0, 1, 0, 0, 100)!.box).toBe(upper);
  });

  it('carries the struck box itself, so material and shell survive the query', () => {
    // The whole reason `box` is in `RayHit`: a can off metal and a can off concrete are not the
    // same sound (§3.9), and the query is where that fact is available.
    const metal = aabbFromBounds(2, -1, -1, 3, 1, 1, MAT_METAL);
    const hit = raycastWorld(worldOf(metal), 0, 0, 0, 1, 0, 0, 100)!;
    expect(hit.box).toBe(metal);
    expect(hit.box.mat).toBe(MAT_METAL);
  });
});

describe('raycastWorld — grazing a face', () => {
  const slab = aabbFromBounds(0, 0, 0, 2, 1, 2, MAT_CONCRETE);

  it('counts a ray running exactly along the top face as a hit', () => {
    // y = 1 is the slab's top. The Y axis is parallel and only gates the box (the origin is on
    // the boundary, which counts as inside it), so the X slab decides and the -X face answers.
    // This is also the case the EPS-inflated broadphase exists for: the query box is
    // zero-thickness in Y here, and `StaticWorld.query` treats touching as not overlapping, so
    // an un-inflated query would cull the very slab the ray is running along.
    const hit = raycastWorld(worldOf(slab), -3, 1, 1, 1, 0, 0, 100);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBe(3);
    expect(normalOf(hit!)).toEqual([-1, 0, 0]);
  });

  it('misses a hair above that face', () => {
    expect(raycastWorld(worldOf(slab), -3, 1 + 1e-6, 1, 1, 0, 0, 100)).toBeNull();
  });

  it('grazes a face the same way when the parallel component is negative zero', () => {
    // Not a curiosity: a look direction is usually built as `-sin(pitch)` on Y, which at a level
    // pitch is exactly -0, and this ray runs along the slab's *bottom* face where the origin sits
    // on `lo`. That combination is the one place the parallel branch changes an answer — drop it
    // and the slab arithmetic gives `(lo - o) * -Infinity === NaN` alongside a `t2` of -Infinity,
    // which clamps the exit behind the origin and throws the box away. Everywhere else the
    // branch and the division happen to agree, so if this graze is not tested the branch is not
    // tested.
    const hit = raycastWorld(worldOf(slab), -3, 0, 1, 1, -0, 0, 100);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBe(3);
    expect(normalOf(hit!)).toEqual([-1, 0, 0]);
  });

  it('counts a ray running exactly along a vertical face too', () => {
    const hit = raycastWorld(worldOf(slab), 0, 0.5, -3, 0, 0, 1, 100);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBe(3);
    expect(normalOf(hit!)).toEqual([0, 0, -1]);
  });
});

describe('raycastWorld — origin at or inside a box', () => {
  it('hits at t = 0 with the reversed exit face, straight down an axis', () => {
    const hit = raycastWorld(worldOf(CUBE), 0, 0, 0, 1, 0, 0, 100)!;
    expect(hit.t).toBe(0);
    expect(hit.box).toBe(CUBE);
    // Leaving through +X, so the answer is -X: the normal still faces the ray. `null` was the
    // alternative and would leave a can that ended a tick inside a wall with nothing to push
    // against, and a spider with no surface under the foot that is touching it.
    expect(normalOf(hit)).toEqual([-1, 0, 0]);
    expect(normalOf(raycastWorld(worldOf(CUBE), 0, 0, 0, -1, 0, 0, 100)!)).toEqual([1, 0, 0]);
    expect(normalOf(raycastWorld(worldOf(CUBE), 0, 0, 0, 0, 1, 0, 100)!)).toEqual([0, -1, 0]);
    expect(normalOf(raycastWorld(worldOf(CUBE), 0, 0, 0, 0, -1, 0, 100)!)).toEqual([0, 1, 0]);
    expect(normalOf(raycastWorld(worldOf(CUBE), 0, 0, 0, 0, 0, 1, 100)!)).toEqual([0, 0, -1]);
    expect(normalOf(raycastWorld(worldOf(CUBE), 0, 0, 0, 0, 0, -1, 100)!)).toEqual([0, 0, 1]);
  });

  it('picks the nearest exit when the ray leaves obliquely', () => {
    // From the centre, (0.6, 0.8, 0) leaves the +Y face at t = 1.25 and would not reach +X until
    // t ≈ 1.67, so Y is the face and -Y is the normal.
    const hit = raycastWorld(worldOf(CUBE), 0, 0, 0, 0.6, 0.8, 0, 100)!;
    expect(hit.t).toBe(0);
    expect(normalOf(hit)).toEqual([0, -1, 0]);
  });

  it('keeps the normal facing the ray from inside as well', () => {
    for (const [dx, dy, dz] of [
      [0.6, 0.8, 0],
      [-0.5, 0.5, -0.7071067811865476],
      [0.2672612419124244, -0.5345224838248488, 0.8017837257372732],
    ]) {
      const hit = raycastWorld(worldOf(CUBE), 0.3, -0.2, 0.1, dx!, dy!, dz!, 100)!;
      expect(hit.t).toBe(0);
      expect(hit.nx * dx! + hit.ny * dy! + hit.nz * dz!).toBeLessThan(0);
    }
  });

  it('reports the face an origin is standing on when the ray heads into the box', () => {
    // Exactly on the -X face, pointing in. The ray leaves through +X, so the reversed exit face
    // is -X — the face underfoot, which is the answer a surface probe wants.
    const hit = raycastWorld(worldOf(CUBE), -1, 0.5, 0.5, 1, 0, 0, 100)!;
    expect(hit.t).toBe(0);
    expect(normalOf(hit)).toEqual([-1, 0, 0]);
  });

  it('answers an oblique ray off a face with the exit rule, not with the face underfoot', () => {
    // The one place the single rule is visibly a choice. From a point *on* the -X face heading
    // up and inwards, two faces are a zero distance away: the -X face the origin sits on, and
    // the +Y face the ray leaves through at t = 0.625. The rule is uniformly "reversed nearest
    // exit", so +Y wins and the normal is -Y.
    //
    // The alternative — record an entry face whenever `t1` merely ties the running `tmin`, which
    // would name -X here — was rejected for a specific reason: it means writing `t1 >= tmin` in
    // `raySlabEnter`, and that assignment fires on `t1 === -0` and turns a `tmin` of `+0` into
    // `-0`, which `sweepSphereWorld` then returns in place of the 0 its own tests pin under
    // `Object.is`. One rule for every t = 0 answer, and the shared core's arithmetic untouched.
    const hit = raycastWorld(worldOf(CUBE), -1, 0.5, 0.5, 0.6, 0.8, 0, 100)!;
    expect(hit.t).toBe(0);
    expect(normalOf(hit)).toEqual([0, -1, 0]);
  });

  it('still reports contact when the ray heads away from the face it starts on', () => {
    // Contact counts (see the graze above): the box overlaps the ray at exactly one point, and
    // a query that hid geometry it is touching would be lying about it. The consequence a
    // consumer must handle is that `t === 0` is contact, not impact — separate along `n`,
    // never reflect, or a can resting on a floor bounces back into the floor.
    const hit = raycastWorld(worldOf(CUBE), -1, 0.5, 0.5, -1, 0, 0, 100)!;
    expect(hit.t).toBe(0);
    expect(normalOf(hit)).toEqual([1, 0, 0]);
  });

  it('prefers a box it is inside over one further along', () => {
    const far = aabbFromBounds(6, -1, -1, 7, 1, 1, MAT_CONCRETE);
    const hit = raycastWorld(worldOf(far, CUBE), 0, 0, 0, 1, 0, 0, 100)!;
    expect(hit.t).toBe(0);
    expect(hit.box).toBe(CUBE);
  });
});

describe('raycastWorld — inputs that are not a ray', () => {
  const world = worldOf(CUBE);

  it('refuses a non-positive or NaN maxDist', () => {
    expect(raycastWorld(world, -4, 0, 0, 1, 0, 0, 0)).toBeNull();
    expect(raycastWorld(world, -4, 0, 0, 1, 0, 0, -1)).toBeNull();
    expect(raycastWorld(world, -4, 0, 0, 1, 0, 0, NaN)).toBeNull();
  });

  it('refuses a zero-length direction', () => {
    // Not merely "finds nothing": there is no axis to enter or leave through, so there is no
    // normal that could be reported without inventing one.
    expect(raycastWorld(world, 0, 0, 0, 0, 0, 0, 100)).toBeNull();
    expect(raycastWorld(world, -4, 0, 0, 0, 0, 0, 100)).toBeNull();
  });

  it('refuses a direction every slab would call parallel', () => {
    // Below 1e-9 per axis the slab test stops dividing, so such a direction has the same
    // no-axis problem as zero even though its length is not zero.
    expect(raycastWorld(world, 0, 0, 0, 1e-12, 0, 0, 100)).toBeNull();
    expect(raycastWorld(world, 0, 0, 0, 1e-9, 0, 0, 100)).not.toBeNull();
  });

  it('refuses NaN and infinities in the direction or the origin', () => {
    expect(raycastWorld(world, -4, 0, 0, NaN, 0, 0, 100)).toBeNull();
    expect(raycastWorld(world, -4, 0, 0, 1, NaN, 0, 100)).toBeNull();
    expect(raycastWorld(world, -4, 0, 0, 1, 0, NaN, 100)).toBeNull();
    expect(raycastWorld(world, -4, 0, 0, Infinity, 0, 0, 100)).toBeNull();
    expect(raycastWorld(world, NaN, 0, 0, 1, 0, 0, 100)).toBeNull();
    expect(raycastWorld(world, -4, Infinity, 0, 1, 0, 0, 100)).toBeNull();
  });
});

describe('raycastWorld — the out parameter', () => {
  const world = worldOf(CUBE);

  it('returns the hit object the caller passed', () => {
    const mine = createRayHit();
    const hit = raycastWorld(world, -4, 0, 0, 1, 0, 0, 100, mine);
    expect(hit).toBe(mine);
    expect(mine.t).toBe(3);
  });

  it('shares one instance between callers that do not pass one', () => {
    // The documented hazard, pinned so it cannot become a surprise: this mirrors `moveBody`,
    // and a caller holding a hit across another cast must own one (`createRayHit`).
    const first = raycastWorld(world, -4, 0, 0, 1, 0, 0, 100)!;
    const second = raycastWorld(world, 0, -4, 0, 0, 1, 0, 100)!;
    expect(second).toBe(first);
    expect(first.ny).toBe(-1);
  });

  it('leaves out alone on a miss, so a caller may keep its last hit there', () => {
    const mine = createRayHit();
    raycastWorld(world, -4, 0, 0, 1, 0, 0, 100, mine);
    expect(raycastWorld(world, -4, 30, 0, 1, 0, 0, 100, mine)).toBeNull();
    expect(mine.t).toBe(3);
    expect(mine.box).toBe(CUBE);
  });
});

// ---------------------------------------------------------------------------
// The consolidation: two verbatim copies of the loops `raySlabEnter` replaced.
// ---------------------------------------------------------------------------

/**
 * `sweepSphereWorld` exactly as it stood before the shared core landed. Historical record: it
 * is here to disagree with the current implementation, and if it ever does, the current one is
 * what needs fixing.
 */
function sweepSphereWorldLegacy(
  world: StaticWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  radius: number,
): number {
  if (maxDist <= 0) return 0;
  const ex = ox + dx * maxDist;
  const ey = oy + dy * maxDist;
  const ez = oz + dz * maxDist;
  const candidates = world.query(
    Math.min(ox, ex) - radius,
    Math.min(oy, ey) - radius,
    Math.min(oz, ez) - radius,
    Math.max(ox, ex) + radius,
    Math.max(oy, ey) + radius,
    Math.max(oz, ez) + radius,
    [],
  );

  let nearest = maxDist;
  for (const b of candidates) {
    let tmin = 0;
    let tmax = nearest;
    for (let axis = 0; axis < 3; axis++) {
      const o = axis === 0 ? ox : axis === 1 ? oy : oz;
      const d = axis === 0 ? dx : axis === 1 ? dy : dz;
      const lo = (axis === 0 ? b.minX : axis === 1 ? b.minY : b.minZ) - radius;
      const hi = (axis === 0 ? b.maxX : axis === 1 ? b.maxY : b.maxZ) + radius;
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) {
          tmin = Infinity;
          break;
        }
        continue;
      }
      const inv = 1 / d;
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) {
        tmin = Infinity;
        break;
      }
    }
    if (tmin < nearest) nearest = tmin;
    if (nearest <= 0) return 0;
  }
  return nearest;
}

/**
 * `StructuredPaint.hits` exactly as it stood before the shared core landed — bounding-sphere
 * prefilter and all, since the prefilter is part of what has to keep agreeing. Same status as
 * the copy above: a historical record, never edited to agree.
 */
function hitsLegacy(
  b: Aabb,
  ox: number,
  oy: number,
  oz: number,
  ux: number,
  uy: number,
  uz: number,
  maxT: number,
): boolean {
  const hx = (b.maxX - b.minX) / 2;
  const hy = (b.maxY - b.minY) / 2;
  const hz = (b.maxZ - b.minZ) / 2;
  const r = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const ex = b.minX + hx - ox;
  const ey = b.minY + hy - oy;
  const ez = b.minZ + hz - oz;
  const proj = ex * ux + ey * uy + ez * uz;
  if (proj - r > maxT) return false;
  if (proj < -r) return false;
  if (ex * ex + ey * ey + ez * ez - proj * proj > r * r) return false;

  let tmin = 0;
  let tmax = maxT;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? ux : a === 1 ? uy : uz;
    const lo = a === 0 ? b.minX : a === 1 ? b.minY : b.minZ;
    const hi = a === 0 ? b.maxX : a === 1 ? b.maxY : b.maxZ;
    if (d > -1e-9 && d < 1e-9) {
      if (o < lo || o > hi) return false;
      continue;
    }
    const invD = 1 / d;
    let t1 = (lo - o) * invD;
    let t2 = (hi - o) * invD;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}

/**
 * A world of boxes scattered around the origin, drawn from a fixed seed so a failure here is
 * reproducible and re-runnable. `makeRng` is the game's only generator (`src/core/rng.ts`); the
 * seed is arbitrary but must never be re-rolled to make a failure go away.
 */
function randomWorld(rng: () => number, count: number): StaticWorld {
  const world = new StaticWorld();
  for (let i = 0; i < count; i++) {
    const cx = (rng() - 0.5) * 12;
    const cy = (rng() - 0.5) * 12;
    const cz = (rng() - 0.5) * 12;
    const sx = 0.4 + rng() * 3;
    const sy = 0.4 + rng() * 3;
    const sz = 0.4 + rng() * 3;
    world.add(
      aabbFromBounds(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, MAT_CONCRETE),
    );
  }
  return world;
}

/** A unit direction drawn uniformly enough for a differential — rejection-sampled off a cube. */
function randomDirection(rng: () => number): [number, number, number] {
  for (;;) {
    const x = rng() * 2 - 1;
    const y = rng() * 2 - 1;
    const z = rng() * 2 - 1;
    const len = Math.hypot(x, y, z);
    if (len > 0.1) return [x / len, y / len, z / len];
  }
}

describe('the shared slab core reproduces what it replaced', () => {
  it('answers exactly as the old sweepSphereWorld did, over 600 pseudo-random rays', () => {
    const rng = makeRng(0x51ab5);
    const world = randomWorld(rng, 24);
    const mismatches: string[] = [];
    let struck = 0;
    let zeros = 0;
    for (let i = 0; i < 600; i++) {
      const ox = (rng() - 0.5) * 16;
      const oy = (rng() - 0.5) * 16;
      const oz = (rng() - 0.5) * 16;
      const [dx, dy, dz] = randomDirection(rng);
      const maxDist = 0.5 + rng() * 30;
      const radius = rng() < 0.25 ? 0 : rng() * 0.8;
      const now = sweepSphereWorld(world, ox, oy, oz, dx, dy, dz, maxDist, radius);
      const before = sweepSphereWorldLegacy(world, ox, oy, oz, dx, dy, dz, maxDist, radius);
      // Object.is, not toBeCloseTo: the whole claim is that the arithmetic is untouched, so
      // "close" would be a failure dressed up as a pass.
      if (!Object.is(now, before)) mismatches.push(`ray ${i}: ${now} !== ${before}`);
      if (now < maxDist) struck++;
      if (now === 0) zeros++;
    }
    expect(mismatches).toEqual([]);
    // Coverage, pinned: without it the assertion above would be just as happy with 600 rays
    // that all sailed past everything. Measured at 185 and 42 for this seed — the thresholds
    // are floors, so a change in the box layout that thins the sample fails here rather than
    // quietly weakening the differential.
    expect(struck).toBeGreaterThan(120);
    expect(zeros).toBeGreaterThan(20);
  });

  it('includes rays that start inside a box, where the answer is 0', () => {
    // Proof the differential above actually exercised the interesting branch rather than 600
    // clean misses: rays fired from inside the boxes themselves.
    const rng = makeRng(0x51ab6);
    const world = randomWorld(rng, 12);
    let zeros = 0;
    for (const b of world.boxes) {
      const [dx, dy, dz] = randomDirection(rng);
      const ox = (b.minX + b.maxX) / 2;
      const oy = (b.minY + b.maxY) / 2;
      const oz = (b.minZ + b.maxZ) / 2;
      expect(sweepSphereWorld(world, ox, oy, oz, dx, dy, dz, 20, 0.3)).toBe(
        sweepSphereWorldLegacy(world, ox, oy, oz, dx, dy, dz, 20, 0.3),
      );
      if (sweepSphereWorld(world, ox, oy, oz, dx, dy, dz, 20, 0.3) === 0) zeros++;
    }
    expect(zeros).toBe(world.boxes.length);
  });

  it('answers the occlusion question exactly as the old hits() did, over 600 rays', () => {
    // `StructuredPaint.hits` is private, so the differential runs against the core it now calls,
    // with the same arguments the paint passes: no inflation, the segment length as the clamp.
    // The end-to-end canary for this consolidation is the lattice dot count in rng.test.ts —
    // one flipped occlusion ray moves it.
    // Comparing the boolean both ways also settles the bounding-sphere prefilter, which the
    // consolidation left in place: the legacy copy runs it, the core does not, and agreement
    // over every box means the prefilter never threw away a blocker the slab test would keep.
    const rng = makeRng(0x0cc1);
    const world = randomWorld(rng, 24);
    const mismatches: string[] = [];
    let blocked = 0;
    for (let i = 0; i < 600; i++) {
      const ox = (rng() - 0.5) * 16;
      const oy = (rng() - 0.5) * 16;
      const oz = (rng() - 0.5) * 16;
      const [ux, uy, uz] = randomDirection(rng);
      const maxT = 0.5 + rng() * 30;
      for (const b of world.boxes) {
        const before = hitsLegacy(b, ox, oy, oz, ux, uy, uz, maxT);
        const now = raySlabEnter(b, ox, oy, oz, ux, uy, uz, 0, maxT) !== Infinity;
        if (now !== before) mismatches.push(`ray ${i}: ${now} !== ${before}`);
        if (before) blocked++;
      }
    }
    expect(mismatches).toEqual([]);
    // Without this the test above would pass just as happily on 14400 agreed misses.
    expect(blocked).toBeGreaterThan(100);
  });

  it('unlocks the shipped room with exactly the dots and edges it always has', () => {
    // The end-to-end canary for the occlusion half of the consolidation, and the reason it is
    // here rather than assumed: the lattice count in `rng.test.ts` does **not** cover this. That
    // number is what `buildRoom` *builds*, decided before a sound is ever emitted, so it is
    // blind to every occlusion ray. What occlusion decides is what a ping *unlocks*, which is
    // this number — a Q-ping from the spawn, drained to completion so the amortised job cannot
    // hide a difference behind timing.
    //
    // A real measurement of the shipped room, not a guess, and it must not be re-recorded to
    // make a change to the ray code pass. Authoring the room differently, or retuning the ping,
    // moves it legitimately; touching `raySlabEnter` does not.
    const game = createHeadlessGame();
    game.input.tapKey('KeyQ');
    game.step();
    game.sim.paint.structured.drain();
    const state = game.sim.debugState();
    // 24286 before the dust apron split the floor into three coplanar bands. The apron adds no
    // surface a ping can reach — the bands share one plane and one top — so what moved is the
    // jitter stream under every dot in the room, and the count moved by ten.
    expect(Number(state.structUnlockedDots)).toBe(24276);
    // 2537 before the apron. Splitting the floor put two new box edges in it, and the reveal
    // draws a contour wherever two faces meet whether or not the surface turns there — the same
    // thing the tank's nine abutting slices already do along their shared tops. The west one is
    // free: it runs under the chokepoint wall, where the floor already creases. The north one is
    // the 18.8 m the count moved for, and it lies on the line the doorway's south jamb already
    // draws, which is the second reason the apron starts there.
    expect(Number(state.structUnlockedEdges)).toBe(2654);
    game.sim.dispose();
  });
});

describe('raycastWorld agrees with sweepSphereWorld on distance', () => {
  it('reports the same distance a zero-radius sweep does, over 400 pseudo-random rays', () => {
    // Two queries, one geometry: a sweep of a point *is* a ray, so their distances must agree
    // wherever both see the surface. They differ deliberately in two places, both excluded
    // here and both tested above: a sweep reports `maxDist` for "clear" where a ray reports
    // null, and the ray's broadphase is EPS-inflated so it also catches an exact graze.
    const rng = makeRng(0xd1ff0);
    const world = randomWorld(rng, 20);
    const mismatches: string[] = [];
    let struck = 0;
    let inside = 0;
    for (let i = 0; i < 400; i++) {
      const ox = (rng() - 0.5) * 16;
      const oy = (rng() - 0.5) * 16;
      const oz = (rng() - 0.5) * 16;
      const [dx, dy, dz] = randomDirection(rng);
      const maxDist = 0.5 + rng() * 30;
      const swept = sweepSphereWorld(world, ox, oy, oz, dx, dy, dz, maxDist, 0);
      const hit = raycastWorld(world, ox, oy, oz, dx, dy, dz, maxDist);
      const cast = hit === null ? maxDist : hit.t;
      if (!Object.is(swept, cast)) mismatches.push(`ray ${i}: sweep ${swept} vs cast ${cast}`);
      if (hit !== null) {
        struck++;
        if (hit.t === 0) inside++;
        // Every hit, not just the tidy ones, keeps the normal facing the ray.
        if (hit.nx * dx + hit.ny * dy + hit.nz * dz >= 0) {
          mismatches.push(`ray ${i}: normal ${hit.nx},${hit.ny},${hit.nz} does not face the ray`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Coverage floors, as above: measured at 70 hits of which 12 start inside a box.
    expect(struck).toBeGreaterThan(50);
    expect(inside).toBeGreaterThan(5);
  });
});
