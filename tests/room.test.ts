/**
 * What the level is made of, asserted against the level rather than against a comment.
 *
 * `tests/materials.test.ts` proves the §3.9 table is wired into the bus: name a material on an
 * event and both of its radii scale. That test passes perfectly on a game where no collider is
 * ever made of dust — which is exactly the state this room was in until the apron went down, and
 * exactly the state a room file can drift back into silently, because nothing else in the suite
 * reads a `mat` off a box. So this file asks the opposite question: given the shipped room, what
 * can a body actually stand on, and does the answer match the routing choice §3.9 promises?
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StaticWorld, moveBody, type Aabb } from '../src/core/collision';
import { MATERIAL_NAMES, MAT_CONCRETE, MAT_DUST } from '../src/paint/materials';
import { buildRoom } from '../src/world/room';

/** The player's collider, as `defaultMovementTunables` sizes it. */
const SHAPE = { radius: 0.35, height: 1.7, stepHeight: 0.3 };
/** Feet height the probes fall from: above every walkable top in the room except the deck. */
const DROP_FROM = 2.5;

function room(): StaticWorld {
  const world = new StaticWorld();
  buildRoom(world).dispose();
  return world;
}

/**
 * True when a body with its feet at `feetY` cannot occupy (x, z) — something is in the way.
 *
 * `margin` widens the collider. Lane-finding passes one, because a corridor that clears the
 * steel bench by nothing is not a corridor: it is a floating-point coincidence, and it would
 * hand the material sweep below a footstep that grazes the bench and reports steel.
 */
function blocked(world: StaticWorld, x: number, z: number, feetY = 0, margin = 0): boolean {
  const r = SHAPE.radius + margin;
  for (const b of world.boxes) {
    if (b.maxY <= feetY + SHAPE.stepHeight || b.minY >= feetY + SHAPE.height) continue;
    const cx = Math.min(Math.max(x, b.minX), b.maxX);
    const cz = Math.min(Math.max(z, b.minZ), b.maxZ);
    if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
  }
  return false;
}

/**
 * Drops the real player collider onto (x, z) with the real solver and reports the box it came
 * to rest on. Not a box lookup: the answer §3.9 needs is the one `MoveResult.groundBox` gives,
 * because that is the only one that cannot disagree with where the body physically is.
 *
 * Returns `null` when the drop was never free to begin with. Without that the solver quietly
 * shoves a body started inside the tank out to somewhere else and reports the floor *there*,
 * which is how a probe ends up asserting confidently about a spot it never stood on.
 */
function standOn(world: StaticWorld, x: number, z: number): Aabb | null {
  if (blocked(world, x, z, DROP_FROM)) return null;
  const position = new THREE.Vector3(x, DROP_FROM, z);
  const velocity = new THREE.Vector3(0, 0, 0);
  let result = moveBody(world, position, velocity, 1 / 120, SHAPE, false);
  for (let i = 0; i < 240 && !result.grounded; i++) {
    velocity.y -= 16 / 120;
    result = moveBody(world, position, velocity, 1 / 120, SHAPE, result.grounded);
  }
  if (!result.grounded) return null;
  // The fall must have been straight down, or the answer belongs to a different column — the
  // stair treads in particular will shoulder a body sideways on the way past.
  if (Math.abs(position.x - x) > 1e-6 || Math.abs(position.z - z) > 1e-6) return null;
  return result.groundBox;
}

/** The material name under (x, z), or `'air'` where nothing let the body down onto a surface. */
function floorAt(world: StaticWorld, x: number, z: number): string {
  const box = standOn(world, x, z);
  return box === null ? 'air' : (MATERIAL_NAMES[box.mat] ?? String(box.mat));
}

/** The tank's footprint, which is the thing the far room forks around. */
const TANK = { minX: 5.3, maxX: 11.7, minZ: -5.2, maxZ: 1.2 };
/** Where both routes start (just east of the chokepoint doorway) and where both end. */
const DOOR: [number, number] = [-3.2, 0];
const EAST: [number, number] = [14.4, 0];

/**
 * The shortest walk from the doorway to the far room's east end, forced past one side of the
 * tank, in metres — with the cells it crosses, so the caller can ask what it was walking on.
 *
 * A straight east-west sweep was the first version of this and it was wrong: it called the north
 * lane impassable because a crate narrows it to 0.85 m, when a body 0.7 m across simply walks
 * round the crate. A route is a path, so the test has to search for one. Dijkstra on a 0.25 m
 * grid, eight-connected, with the collider widened by 5 cm so a route has to be walkable rather
 * than exactly tangent to a crate.
 */
function route(world: StaticWorld, side: 'north' | 'south'): { metres: number; cells: number[][] } {
  const STEP = 0.25;
  const X0 = -3.6;
  const Z0 = -9.6;
  const nx = Math.round((14.8 - X0) / STEP);
  const nz = Math.round((9.6 - Z0) / STEP);
  const at = (i: number, k: number): [number, number] => [X0 + i * STEP, Z0 + k * STEP];
  const open = new Uint8Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      const [x, z] = at(i, k);
      // The forced side: closing the tank's other flank is what turns "a route exists" into
      // "a route exists on this side of the landmark".
      const flanking = x > TANK.minX - 0.6 && x < TANK.maxX + 0.6;
      if (flanking && side === 'north' && z < TANK.maxZ) continue;
      if (flanking && side === 'south' && z > TANK.minZ) continue;
      open[i * nz + k] = blocked(world, x, z, 0, 0.05) ? 0 : 1;
    }
  }
  const index = (p: [number, number]) =>
    Math.round((p[0] - X0) / STEP) * nz + Math.round((p[1] - Z0) / STEP);
  const dist = new Float64Array(nx * nz).fill(Infinity);
  const prev = new Int32Array(nx * nz).fill(-1);
  const heap: number[] = [];
  const push = (n: number) => {
    heap.push(n);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (dist[heap[p]!]! <= dist[heap[c]!]!) break;
      [heap[p], heap[c]] = [heap[c]!, heap[p]!];
      c = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && dist[heap[l]!]! < dist[heap[m]!]!) m = l;
        if (r < heap.length && dist[heap[r]!]! < dist[heap[m]!]!) m = r;
        if (m === p) break;
        [heap[p], heap[m]] = [heap[m]!, heap[p]!];
        p = m;
      }
    }
    return top;
  };
  const start = index(DOOR);
  const goal = index(EAST);
  dist[start] = 0;
  push(start);
  while (heap.length) {
    const cur = pop();
    if (cur === goal) break;
    const ci = Math.floor(cur / nz);
    const ck = cur % nz;
    for (let di = -1; di <= 1; di++) {
      for (let dk = -1; dk <= 1; dk++) {
        if (di === 0 && dk === 0) continue;
        const ni = ci + di;
        const nk = ck + dk;
        if (ni < 0 || nk < 0 || ni >= nx || nk >= nz || !open[ni * nz + nk]) continue;
        const n = ni * nz + nk;
        const w = dist[cur]! + Math.hypot(di, dk) * STEP;
        if (w < dist[n]!) {
          dist[n] = w;
          prev[n] = cur;
          push(n);
        }
      }
    }
  }
  const cells: number[][] = [];
  for (let n = goal; n !== -1 && Number.isFinite(dist[n]!); n = prev[n]!) {
    cells.push(at(Math.floor(n / nz), n % nz));
    if (n === start) break;
  }
  return { metres: dist[goal]!, cells };
}

describe('the shipped room places every material it defines', () => {
  /**
   * The regression this file was written for. `MAT_DUST` had a multiplier, a synthesized voice,
   * a normalization invariant and a full unit suite for months while no collider in the game was
   * made of it — the quiet end of §3.9 was a number no body could ever stand on. A material
   * class with no surface is a promise the shipped game does not keep, so the loop is over the
   * table rather than over a list of the four names: adding a fifth class puts the burden on
   * whoever adds it to give it a floor.
   */
  it('has a collider of every class in the material table', () => {
    const world = room();
    const placed = new Set(world.boxes.map((b) => b.mat));
    for (let mat = 0; mat < MATERIAL_NAMES.length; mat++) {
      expect(placed.has(mat), `no collider is made of ${MATERIAL_NAMES[mat]}`).toBe(true);
    }
  });

  it('and a body can stand on each of them', () => {
    const world = room();
    // One walkable sample per class: the poured slab, the stone stairs, the steel bench, the
    // dust apron. Standing is the test, not existing — a material welded to the ceiling would
    // pass the count above and still be unreachable by any footstep.
    expect(floorAt(world, -12, 0)).toBe('concrete');
    expect(floorAt(world, -12.5, -7.6)).toBe('stone');
    expect(floorAt(world, 12, 1.5)).toBe('metal');
    expect(floorAt(world, 10, -6)).toBe('dust');
  });
});

describe('the dust apron is one floor with the concrete, not a step in it', () => {
  /**
   * Vision §5: nothing may turn movement into rationing, and a 10 cm lip at a material change
   * would be exactly that — a vault every time you cross a surface, plus a ledge the reveal
   * draws as a hold. The bands share a plane so that the only thing that changes underfoot is
   * what the floor is made of.
   */
  it('keeps one walking plane across the boundary', () => {
    const world = room();
    for (const z of [-4, -2.5, -1, 3]) {
      const box = standOn(world, 14, z);
      expect(box, `nothing to stand on at z=${z}`).not.toBeNull();
      expect(box!.maxY).toBe(0);
    }
  });

  it('puts the boundary on the chokepoint doorway jamb, run east', () => {
    const world = room();
    // Step out of the door and you are on concrete; turn right and two metres later you are not.
    expect(floorAt(world, -3, 0)).toBe('concrete');
    expect(floorAt(world, -3, -2.5)).toBe('dust');
    // The near room is untouched: west of the chokepoint wall there is no dust at all.
    for (let x = -14.5; x < -4.3; x += 0.5) {
      for (let z = -9; z <= 9; z += 1.5) {
        const box = standOn(world, x, z);
        if (box === null) continue;
        expect(MATERIAL_NAMES[box.mat], `dust leaked into the near room at ${x},${z}`).not.toBe(
          'dust',
        );
      }
    }
  });

  /**
   * Which band wins where the body straddles the line. The bands are coplanar, so `moveBody`'s
   * ground pass is choosing between two equal `maxY` values and keeps the first the broadphase
   * yields — the apron, because `buildRoom` lays it first. The consequence is the honest one:
   * a foot that reaches dust at all is standing on dust, so the surface answers a body's leading
   * edge and never lets a stride start on dust and be billed as concrete.
   */
  it('gives the tie to the quiet surface, at the body radius', () => {
    const world = room();
    // -1.9 is the seam; the collider is 0.35 across, and the overlap test is strict.
    expect(floorAt(world, 14, -1.54)).toBe('concrete');
    expect(floorAt(world, 14, -1.56)).toBe('dust');
  });
});

describe('the tank makes the apron a route rather than a patch', () => {
  /**
   * The routing choice §3.9 promises, stated as geometry rather than as a comment: the tank is
   * the one thing in the room that has to be gone *around*, so it forks the far room into a
   * north way and a south way — and the fork is only a choice if the two sides differ. Drop a
   * crate into either flank and this file goes red.
   */
  it('is passable on both sides of the landmark', () => {
    const world = room();
    expect(route(world, 'north').metres).toBeLessThan(Infinity);
    expect(route(world, 'south').metres).toBeLessThan(Infinity);
  });

  it('and only the southern way is quiet', () => {
    const world = room();
    const north = route(world, 'north');
    const south = route(world, 'south');
    const dustFraction = (cells: number[][]) =>
      cells.filter(([x, z]) => floorAt(world, x!, z!) === 'dust').length / cells.length;
    // The loud way is loud for its whole length: not one step of it is on the quiet surface.
    expect(dustFraction(north.cells)).toBe(0);
    // The quiet way is mostly dust — the rest is the concrete either end, where both routes
    // share the doorway and the east wall.
    expect(dustFraction(south.cells)).toBeGreaterThan(0.6);
  });

  /**
   * And it costs something, which is the half of §3.9 that is easy to lose. Quiet has to be paid
   * for in distance or in speed or it is a free win, and "priced in the same currency as
   * everything else" becomes a sentence the game does not mean.
   *
   * The two absolute lengths are characterization to half a metre, not law — move a crate and
   * they move, and re-recording them is the right response. `south > north` is the law: the day
   * the quiet way becomes the short way, quiet has stopped costing anything, and no comment
   * anywhere would have caught it.
   */
  it('and charges for it in distance before it charges for it in speed', () => {
    const world = room();
    const north = route(world, 'north').metres;
    const south = route(world, 'south').metres;
    expect(north).toBeCloseTo(20.9, 0);
    expect(south).toBeCloseTo(24.0, 0);
    expect(south).toBeGreaterThan(north + 2);
  });

  /**
   * Long enough to be a decision. A two-metre dust patch is a texture; a route is something you
   * are still standing on several strides later, which at a 1.57 m walking stride means the
   * quiet way has to hold for the better part of ten of them.
   */
  it('holds dust for the whole length of the southern lane', () => {
    const world = room();
    let run = 0;
    for (let x = -3; x <= 14.5; x += 0.25) {
      run += floorAt(world, x, -8.5) === 'dust' ? 0.25 : -run;
    }
    expect(run).toBeGreaterThan(15);
  });
});

describe('the near room is the control group', () => {
  /**
   * §3.9's whole argument for a class below concrete is that "go slow and stay quiet" needs
   * something to pay it. That only reads if the ordinary floor is still the ordinary floor: the
   * spawn end has to sound normal, or the apron is not quieter than anything.
   */
  it('still spawns you on plain concrete', () => {
    const world = room();
    expect(floorAt(world, -12.5, 0)).toBe(MATERIAL_NAMES[MAT_CONCRETE]);
    expect(floorAt(world, -12.5, 0)).not.toBe(MATERIAL_NAMES[MAT_DUST]);
  });
});

describe('the floor is one slab in three bands (§3.9)', () => {
  /**
   * "The bands abut exactly — no overlap, no gap — and both halves of that matter."
   *
   * `room.ts` says that in its own comment and, until this test, nothing checked either half.
   * The only things that noticed were the two whole-room golden hashes (`rng.test.ts`,
   * `raycast.test.ts`), which fail on *any* geometry edit and are therefore regenerated as a
   * matter of routine whenever the room legitimately changes — i.e. exactly the moment a real
   * gap would ride through unread. A gap is a hole a body falls through. An overlap is worse:
   * the apron is "laid first, so `moveBody` resolves the coplanar tie in favour of dust", and
   * that sentence only means anything while the tie has exactly two sides.
   */
  it('tiles the room exactly once, with no gap and no overlap', () => {
    const bands = room().boxes.filter((b) => b.maxY === 0 && b.minY < 0);
    expect(bands.length).toBeGreaterThanOrEqual(3);
    const minX = Math.min(...bands.map((b) => b.minX));
    const maxX = Math.max(...bands.map((b) => b.maxX));
    const minZ = Math.min(...bands.map((b) => b.minZ));
    const maxZ = Math.max(...bands.map((b) => b.maxZ));
    // Sampled on cell centres, so a probe never lands on a seam and counts both sides of an
    // honest abutment. The step is small enough to fall inside any hole a body could.
    const STEP = 0.25;
    for (let x = minX + STEP / 2; x < maxX; x += STEP) {
      for (let z = minZ + STEP / 2; z < maxZ; z += STEP) {
        const covering = bands.filter(
          (b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ,
        );
        expect(covering.length, `(${x.toFixed(2)}, ${z.toFixed(2)})`).toBe(1);
      }
    }
  });
});
