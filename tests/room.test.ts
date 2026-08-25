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
import { MATERIAL_NAMES, MAT_CONCRETE, MAT_DUST, MAT_METAL } from '../src/paint/materials';
import { SOUND_CLASSES } from '../src/paint/soundEvents';
import { defaultBobTunables, defaultMovementTunables } from '../src/player/controller';
import { CAN_RADIUS, CAN_REACH, CAN_STACK_PITCH, type CanPose } from '../src/world/cans';
import { CAN_STACK, buildRoom } from '../src/world/room';

/** The player's collider, as `defaultMovementTunables` sizes it. */
const SHAPE = { radius: 0.35, height: 1.7, stepHeight: 0.3 };
/** Feet height the probes fall from: above every walkable top in the room except the deck. */
const DROP_FROM = 2.5;
/**
 * How much wider than the body a lane has to be before this file calls it a lane, metres.
 *
 * Named because `route` is no longer the only thing that asks: the can stack's clearances are
 * measured with the same slack, and a corridor that was a lane for the router and a coin flip
 * for the clearance test would be the two of them disagreeing about the same 5 cm.
 */
const LANE_MARGIN = 0.05;
/**
 * Metres of travel between two footfalls, at every stance.
 *
 * The stride is distance-based (`player/controller.ts`: `strideLength = sprintSpeed /
 * strideFreq`, two footfalls per cycle), so a crouching player and a sprinting one lay down
 * contacts at the same *spacing* and differ only in how loud each one is. That is what makes
 * "how much warning does this prop give" a distance question rather than a speed question.
 */
const FOOTFALL_SPACING =
  defaultMovementTunables().sprintSpeed / defaultBobTunables().strideFreq / 2;

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
 *
 * `avoid` closes cells that hold no collider at all — the footprint of a *dynamic* prop, which
 * is the only way this router can be asked about one. It is a second argument rather than a
 * second function because the two questions have to be asked of the same graph: "is the lane
 * still passable with the cans in it" only means something next to "and it was this long
 * without them", and a forked copy of a Dijkstra is a place for the two to quietly diverge.
 */
function route(
  world: StaticWorld,
  side: 'north' | 'south',
  avoid?: (x: number, z: number) => boolean,
): { metres: number; cells: number[][] } {
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
      const shut = blocked(world, x, z, 0, LANE_MARGIN) || (avoid?.(x, z) ?? false);
      open[i * nz + k] = shut ? 0 : 1;
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

/**
 * The nearest box a standing body would walk into, leaving (x, z) along +Z or -Z.
 *
 * The can stack's clearances are measured against *this* rather than against `TANK.maxZ` and a
 * remembered 4.8, because those two numbers are this file's copy of the room's mind. A clearance
 * asserted against a copy is a clearance that keeps passing after someone moves the wall.
 */
function nearest(world: StaticWorld, x: number, z: number, dir: 1 | -1): Aabb | null {
  let best: Aabb | null = null;
  let bestFace = dir * Infinity;
  for (const b of world.boxes) {
    if (b.maxY <= SHAPE.stepHeight || b.minY >= SHAPE.height) continue;
    if (x < b.minX || x > b.maxX) continue;
    const face = dir === 1 ? b.minZ : b.maxZ;
    if (dir === 1 ? face < z : face > z) continue;
    if (dir === 1 ? face < bestFace : face > bestFace) {
      best = b;
      bestFace = face;
    }
  }
  return best;
}

/**
 * Where a body may put its centre without touching anything: no collider inside its radius, and
 * no can inside `CAN_REACH`.
 *
 * `CAN_REACH` is used raw where `blocked` is given a body radius, and the difference is not an
 * oversight: `cans.ts` defines it as the distance from the rig's *body centre* to a can it
 * stoops for. It is already the number this predicate wants, and adding the radius to it would
 * be counting the body twice.
 *
 * `cans` is a parameter so a test can ask what the lane would be like with *part* of the stack —
 * which is the only way to ask whether the lean costs the player anything.
 */
function legalCentre(
  world: StaticWorld,
  x: number,
  z: number,
  cans: readonly CanPose[] = CAN_STACK,
): boolean {
  if (blocked(world, x, z, 0, LANE_MARGIN)) return false;
  return !cans.some((c) => Math.hypot(x - c.x, z - c.z) < CAN_REACH + LANE_MARGIN);
}

/** The widest unbroken run of legal centres between two z at this x, in metres. */
function threadWidth(
  world: StaticWorld,
  x: number,
  zA: number,
  zB: number,
  cans: readonly CanPose[] = CAN_STACK,
): number {
  // Millimetres, counted as whole samples rather than accumulated as floats: this is compared
  // against itself across can subsets, and a scan that drifts would make two equal lanes differ.
  const STEP = 0.001;
  const lo = Math.min(zA, zB);
  const steps = Math.round((Math.max(zA, zB) - lo) / STEP);
  let best = 0;
  let run = 0;
  for (let i = 0; i <= steps; i++) {
    run = legalCentre(world, x, lo + i * STEP, cans) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best * STEP;
}

/** The stack as `route`'s `avoid`: a cell is shut where a body standing in it touches a can. */
function cansInTheWay(x: number, z: number): boolean {
  return CAN_STACK.some((c) => Math.hypot(x - c.x, z - c.z) < CAN_REACH + LANE_MARGIN);
}

/** A route's cells as a doorway-to-east-wall polyline, sampled every centimetre. */
function walkLine(cells: number[][]): Array<{ d: number; x: number; z: number }> {
  const STEP = 0.01;
  const path = [...cells].reverse();
  const line: Array<{ d: number; x: number; z: number }> = [];
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = [path[i - 1]![0]!, path[i - 1]![1]!];
    const [bx, bz] = [path[i]![0]!, path[i]![1]!];
    const len = Math.hypot(bx - ax, bz - az);
    for (let t = 0; t < len; t += STEP) {
      line.push({ d: d + t, x: ax + ((bx - ax) * t) / len, z: az + ((bz - az) * t) / len });
    }
    d += len;
  }
  return line;
}

/** How far along the line before it first comes within `r` of (x, z). Infinity if it never does. */
function firstWithin(
  line: ReadonlyArray<{ d: number; x: number; z: number }>,
  r: number,
  x: number,
  z: number,
): number {
  for (const p of line) if (Math.hypot(p.x - x, p.z - z) <= r) return p.d;
  return Infinity;
}

/** The closest the line ever comes to (x, z), in metres. */
function closestApproach(
  line: ReadonlyArray<{ d: number; x: number; z: number }>,
  x: number,
  z: number,
): number {
  let best = Infinity;
  for (const p of line) best = Math.min(best, Math.hypot(p.x - x, p.z - z));
  return best;
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

describe('the north lane pinch carries a stack of cans (§8)', () => {
  /**
   * The room's first authored sound-trap, and the half of it that lives here: a placement, and
   * the four questions it had to answer to earn the spot. The apron made the far room a fork —
   * north short and loud, south long and quiet — and this stack is what makes the loud lane
   * *bite*, so that reading a room and routing through it is a skill the level asks for rather
   * than a sentence in a design doc.
   */
  it('is data and not geometry: no collider stands in the column', () => {
    const world = room();
    // The rule `room.ts` states in prose, asserted against the world it built: a box under a can
    // is lattice painted at a place the can has since rolled away from, which is law 2 lying.
    //
    // Nothing else in this file catches it. Built as colliders these six cans leave the north
    // lane 20.9 m long — the grid climbs north a stride early and pays nothing for it, because
    // the lane has to climb for the bench anyway — so the two route pins above stay green while
    // the room grows a wall nobody authored.
    for (const can of CAN_STACK) {
      for (const b of world.boxes) {
        const nx = Math.min(Math.max(can.x, b.minX), b.maxX);
        const nz = Math.min(Math.max(can.z, b.minZ), b.maxZ);
        const near = (can.x - nx) ** 2 + (can.z - nz) ** 2 < CAN_RADIUS * CAN_RADIUS;
        const half = CAN_STACK_PITCH / 2;
        const overlaps = b.minY < can.y + half && b.maxY > can.y - half;
        expect(near && overlaps, `a collider fills the can at y=${can.y.toFixed(2)}`).toBe(false);
      }
    }
  });

  it('stands one can-reach off the tank shoulder, dead centre of the pinch', () => {
    const world = room();
    const base = CAN_STACK[0]!;
    const shoulder = nearest(world, base.x, base.z, -1);
    const partition = nearest(world, base.x, base.z, 1);
    expect(shoulder, 'nothing south of the stack').not.toBeNull();
    expect(partition, 'nothing north of the stack').not.toBeNull();
    // What it is stacked against is the landmark itself — 6 m of metal, not a crate. That is the
    // apron's precedent: a placement has to sit on a line the player can already point at.
    expect(shoulder!.mat).toBe(MAT_METAL);
    expect(shoulder!.maxY).toBeGreaterThan(SHAPE.height);
    expect(partition!.shell).toBe(true);
    // The pinch: 3.6 m between the tank's north face and the side chamber.
    expect(partition!.minZ - shoulder!.maxZ).toBeCloseTo(3.6, 10);
    // And the derivation, which is the whole placement: one CAN_REACH off that face, on the
    // shoulder's own centre line.
    expect(base.z - shoulder!.maxZ).toBeCloseTo(CAN_REACH, 10);
    expect(base.x).toBeCloseTo((shoulder!.minX + shoulder!.maxX) / 2, 10);
  });

  it('leaves the loud lane walkable, and still the short way round the landmark', () => {
    const world = room();
    const plain = route(world, 'north').metres;
    const dodging = route(world, 'north', cansInTheWay).metres;
    const south = route(world, 'south', cansInTheWay).metres;
    expect(dodging).toBeLessThan(Infinity);
    expect(dodging).toBeLessThan(south);
    // Dodging costs something, or the cans are not in the lane at all...
    expect(dodging).toBeGreaterThan(plain);
    // ...but almost nothing: 0.21 m, because the lane has to climb north for the steel bench
    // anyway. The stack is not priced in distance — it is priced in having to commit to the wide
    // line before you can see it, and in the ×1.5 clang if you do not. A stack that added metres
    // would be a wall with extra steps, and it would take the north lane's whole reason to exist
    // with it.
    expect(dodging - plain).toBeLessThan(0.5);
  });

  it('closes the inside of the corner and leaves the partition side threadable', () => {
    const world = room();
    const base = CAN_STACK[0]!;
    const shoulder = nearest(world, base.x, base.z, -1)!;
    const partition = nearest(world, base.x, base.z, 1)!;
    const zs = CAN_STACK.map((c) => c.z);
    // Nothing fits between the column and the tank, and this is structural rather than tuned:
    // the gap is CAN_REACH and a body needs its own radius on top of CAN_REACH to pass without
    // touching a can, so no collider size makes the inside of the corner passable.
    expect(threadWidth(world, base.x, shoulder.maxZ, Math.min(...zs))).toBe(0);
    // The way round is real: 1.95 m of legal standing room, against a body 0.7 m across. A
    // decision, not a needle threaded at walking speed in the dark.
    const around = threadWidth(world, base.x, Math.max(...zs), partition.minZ);
    expect(around).toBeGreaterThan(1.2);
    expect(around).toBeCloseTo(1.95, 1);
  });

  it('sits on the lane fast line, so the run that does not read it kicks it', () => {
    const world = room();
    // The fast line *is* the short line here: the lane's speed is capped by its length, not by
    // its corners, so the router's answer is the line a sprinter takes. Measured against the
    // shipped collider it passes the column at 0.12 m — inside CAN_REACH by a factor of five,
    // and above CAN_LIFT_SPEED that contact is a kick rather than a pickup.
    const line = walkLine(route(world, 'north').cells);
    const closest = Math.min(...CAN_STACK.map((c) => closestApproach(line, c.x, c.z)));
    expect(closest).toBeLessThan(CAN_REACH);
    expect(closest).toBeCloseTo(0.12, 1);
  });

  it('gives two walk-steps of paint before it is within reach', () => {
    const world = room();
    const line = walkLine(route(world, 'north').cells);
    const paintRadius = SOUND_CLASSES['walk-step'].paintRadius;
    const near = (r: number) => Math.min(...CAN_STACK.map((c) => firstWithin(line, r, c.x, c.z)));
    const inReach = near(CAN_REACH);
    const painted = near(paintRadius);
    // Far enough down the lane that the approach is walked, not stumbled into: 11.7 m past the
    // doorway. The 2 m contact shell of §3.1 does not exist (doc/known-issues.md), so a player's
    // own footfalls are the entire readability story, and the north lane is concrete for its
    // whole length (pinned above), so that footfall paints its full 4 m.
    expect(inReach).toBeGreaterThan(4);
    expect(inReach).toBeCloseTo(11.7, 0);
    // The window is 3.6 m of approach with the cairn painted and out of reach. Footfalls are
    // 1.58 m apart at every stance, so two of them land inside it wherever the stride happens to
    // be in its cycle when you come through the door — the warning cannot be missed by luck,
    // only by not looking.
    expect(inReach - painted).toBeGreaterThan(2 * FOOTFALL_SPACING);
  });
});

describe('an authored can burdens whoever authors it', () => {
  /**
   * The apron's pattern, applied to props: the loop is over the authored list, not over the one
   * stack that exists today, so a second stack cannot be added without answering the same
   * questions this one had to. A can hanging in the air, buried in a wall, or dropped into a
   * corridor too narrow to walk round fails here on the day it is written.
   */
  it('stacks on the can pitch, on the floor under it', () => {
    const world = room();
    expect(CAN_STACK.length).toBe(5);
    for (const can of CAN_STACK) {
      const ground = standOn(world, can.x, can.z);
      expect(ground, `no floor under the can at y=${can.y.toFixed(2)}`).not.toBeNull();
      // A can owns a slot one pitch tall, so the bottom of the column is half a pitch up and the
      // whole bar is CAN_STACK_PITCH × the count — 0.60 m, the silhouette cans.ts asks for.
      const slot = (can.y - ground!.maxY) / CAN_STACK_PITCH - 0.5;
      expect(slot).toBeCloseTo(Math.round(slot), 10);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(CAN_STACK.length);
    }
  });

  /**
   * The column has to be mineable to the last can by a player who walks up to it.
   *
   * Retrieval measures three dimensions from the *feet* and takes the highest can in reach
   * (`game/throwables.ts`), so a column taller than `CAN_REACH` strands its top can: reaching
   * for it hands you the one below instead, and the stranded can falls on the pile. That is a
   * clang on the first touch of the stack, on every run, that no amount of skill avoids — and
   * an authored count of six did exactly that until the count was derived off this reach.
   *
   * The second half is the half that matters. Reachability alone is satisfied by a stack of
   * one; asserting that one *more* can would break it says the column is as tall as the rule
   * allows and no taller, so this fails from either direction — a shortened stack and an
   * over-tall one both land here rather than in a playtest.
   */
  it('is mineable to the last can, and is exactly as tall as reach allows', () => {
    const world = room();
    for (const can of CAN_STACK) {
      const ground = standOn(world, can.x, can.z)!;
      // The vertical leg alone, which is the floor of any 3-D distance to it: unreachable here
      // is unreachable from everywhere on the floor.
      const up = can.y - ground.maxY;
      expect(up, `the can at y=${can.y.toFixed(2)} is out of reach`).toBeLessThanOrEqual(CAN_REACH);
    }

    const top = CAN_STACK[CAN_STACK.length - 1]!;
    const ground = standOn(world, top.x, top.z)!;
    expect(top.y - ground.maxY + CAN_STACK_PITCH).toBeGreaterThan(CAN_REACH);
  });

  it('leans off plumb by centimetres, and stays a column while it does', () => {
    const base = CAN_STACK[0]!;
    let previous = -1;
    for (const can of CAN_STACK) {
      const drift = Math.hypot(can.x - base.x, can.z - base.z);
      // The lean accumulates upward — it is a mis-stack, not a tilt applied to a primitive.
      expect(drift).toBeGreaterThanOrEqual(previous);
      // ...and stays under a can's own print, or the column has stopped reading as a column.
      expect(drift).toBeLessThan(CAN_RADIUS);
      previous = drift;
    }
    // There is a lean at all: a plumb column reads as something the renderer made.
    expect(previous).toBeGreaterThan(0.02);
    expect(previous).toBeLessThan(0.04);
  });

  it('never leans into the lane it leaves open', () => {
    const world = room();
    for (const can of CAN_STACK) {
      const partition = nearest(world, can.x, can.z, 1)!;
      // The clearance a placement is judged on is measured at the bottom can, so the lean is only
      // free if the leaning cans take nothing off it. Asked as "what would this lane be with the
      // bottom can alone", because that is the number the placement was signed off against —
      // three centimetres the wrong way is three centimetres nobody re-measured.
      const whole = threadWidth(world, can.x, can.z, partition.minZ);
      const alone = threadWidth(world, can.x, can.z, partition.minZ, [CAN_STACK[0]!]);
      expect(whole, `the lean eats into the lane beside y=${can.y.toFixed(2)}`).toBe(alone);
    }
  });

  it('leaves a metre and a fifth of threadable lane on some side of every can', () => {
    const world = room();
    for (const can of CAN_STACK) {
      const south = nearest(world, can.x, can.z, -1);
      const north = nearest(world, can.x, can.z, 1);
      expect(south, 'a can with nothing south of it').not.toBeNull();
      expect(north, 'a can with nothing north of it').not.toBeNull();
      const widest = Math.max(
        threadWidth(world, can.x, south!.maxZ, can.z),
        threadWidth(world, can.x, can.z, north!.minZ),
      );
      // Reading a prop at walk speed and going round it has to be survivable rather than a coin
      // flip, and 1.2 m against a 0.7 m body is the width this room calls a lane.
      expect(widest, `nowhere to walk past the can at y=${can.y.toFixed(2)}`).toBeGreaterThan(1.2);
    }
  });
});
