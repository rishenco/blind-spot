/**
 * Static-world collision: the world is a list of axis-aligned boxes and the player is a
 * vertical cylinder (a capsule with flat caps — for a kinematic FPS controller this behaves
 * identically in practice and keeps ground/step logic exact).
 *
 * Resolution is split: vertical first (gravity, landing, ceilings), then horizontal
 * (collide-and-slide with a step-up tolerance), then an optional ground snap so walking
 * down stairs and ramps doesn't launch the player into the air.
 *
 * ## Module-level scratch: what it does and does not promise
 *
 * This file keeps several module-level scratch objects — `candidateScratch`, `queryScratch`,
 * `sweepScratch`, `rayScratch`, `pushScratch`, `slidePlain`, `slideStepped` — so the hot path
 * allocates nothing per tick. They are **deliberate and correct for the way this module is
 * used**: any number of bodies may be moved through `moveBody` (or `canOccupyWorld` /
 * `sweepSphereWorld` / `raycastWorld`) as long as the calls happen *sequentially on one
 * thread*. Each call fills the scratch it
 * needs at the top and is finished with it before it returns, so body N+1 never sees body N's
 * leftovers. Ticking a player, twenty thrown cans and six spiders one after another in a fixed
 * update is exactly that pattern, and needs no change here.
 *
 * They break in only two ways, neither of which occurs today:
 *
 * - **Reentrancy** — calling back into this module from inside a call already in progress
 *   (e.g. a collision callback that itself calls `moveBody`, or moving bodies from a Worker
 *   sharing this module instance). The inner call would stomp the outer call's candidate list
 *   mid-loop. Nothing in this codebase takes callbacks, so this cannot currently happen; if a
 *   callback is ever added, that is the moment to give the scratch a per-call owner, not before.
 * - **Retention** — holding a returned array past the next call. `world.query` returns the very
 *   buffer it was handed, so `const c = world.query(..., scratch)` is only valid until the next
 *   call that uses `scratch`. Copy it if you need it to survive.
 *
 * `MoveResult` used to be in this list and is not any more: `moveBody` takes an optional `out`,
 * so a caller that wants to keep its result across other bodies' calls owns one (see
 * `createMoveResult`). Omitting `out` still returns the shared instance, which is fine for the
 * overwhelmingly common read-it-immediately case. `RayHit` and `raycastWorld` follow that same
 * shape, for the same reason.
 *
 * `slabEntryAxis` is scratch too, and the one piece of it that leaves the module's own
 * functions: `raySlabEnter` is exported (the paint occlusion test in `paint/structured.ts` runs
 * the same loop) and writes it on every call. Only `raycastWorld` reads it, immediately, on the
 * winning box — see the note there.
 */

import type * as THREE from 'three';

export interface Aabb {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  /**
   * What this box is made of — an index into `paint/materials`. Collision does not care; the
   * rest of the game does, because a return off metal and a return off concrete are not the
   * same sound. Absent means concrete (0), which is what most of a facility is.
   */
  readonly mat?: number;
  /**
   * True when this box *is the room* — a floor, a ceiling, an outer wall, a partition — rather
   * than a thing standing in it. Collision does not care; the reveal does, because hearing one
   * face of a crate tells you a crate is there (so all of it surfaces) while hearing one patch
   * of a wall tells you nothing whatsoever about the room on its far side.
   */
  readonly shell?: boolean;
}

/** Numerical slack, in metres, used for "were we above this surface" style tests. */
const EPS = 1e-3;

export function aabbFromBounds(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  mat = 0,
  shell = false,
): Aabb {
  return { minX, minY, minZ, maxX, maxY, maxZ, mat, shell };
}

/** Box given by its centre on X/Z, its base on Y, and its full size. */
export function aabbFromFootprint(
  centerX: number,
  baseY: number,
  centerZ: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): Aabb {
  return {
    minX: centerX - sizeX / 2,
    minY: baseY,
    minZ: centerZ - sizeZ / 2,
    maxX: centerX + sizeX / 2,
    maxY: baseY + sizeY,
    maxZ: centerZ + sizeZ / 2,
  };
}

export class StaticWorld {
  readonly boxes: Aabb[] = [];

  add(box: Aabb): Aabb {
    this.boxes.push(box);
    return box;
  }

  clear(): void {
    this.boxes.length = 0;
  }

  /** Collects boxes overlapping the given bounds into `out` (cleared first). */
  query(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Aabb[],
  ): Aabb[] {
    out.length = 0;
    for (const b of this.boxes) {
      if (b.maxX <= minX || b.minX >= maxX) continue;
      if (b.maxY <= minY || b.minY >= maxY) continue;
      if (b.maxZ <= minZ || b.minZ >= maxZ) continue;
      out.push(b);
    }
    return out;
  }
}

/** True when the circle of `radius` at (x, z) overlaps the box's XZ footprint. */
export function circleOverlapsFootprint(x: number, z: number, radius: number, b: Aabb): boolean {
  const cx = x < b.minX ? b.minX : x > b.maxX ? b.maxX : x;
  const cz = z < b.minZ ? b.minZ : z > b.maxZ ? b.maxZ : z;
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < radius * radius;
}

interface Push {
  nx: number;
  nz: number;
  depth: number;
}

const pushScratch: Push = { nx: 0, nz: 0, depth: 0 };

/**
 * Minimum translation on XZ that separates a circle from a box footprint,
 * or null when they don't overlap. Returns a shared scratch object.
 */
function circlePush(x: number, z: number, radius: number, b: Aabb): Push | null {
  const cx = x < b.minX ? b.minX : x > b.maxX ? b.maxX : x;
  const cz = z < b.minZ ? b.minZ : z > b.maxZ ? b.maxZ : z;
  const dx = x - cx;
  const dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > radius * radius) return null;

  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    pushScratch.nx = dx / d;
    pushScratch.nz = dz / d;
    pushScratch.depth = radius - d;
    return pushScratch;
  }

  // Centre is inside the footprint: leave through the nearest face.
  const toMinX = x - b.minX;
  const toMaxX = b.maxX - x;
  const toMinZ = z - b.minZ;
  const toMaxZ = b.maxZ - z;
  let best = toMinX;
  pushScratch.nx = -1;
  pushScratch.nz = 0;
  if (toMaxX < best) {
    best = toMaxX;
    pushScratch.nx = 1;
    pushScratch.nz = 0;
  }
  if (toMinZ < best) {
    best = toMinZ;
    pushScratch.nx = 0;
    pushScratch.nz = -1;
  }
  if (toMaxZ < best) {
    best = toMaxZ;
    pushScratch.nx = 0;
    pushScratch.nz = 1;
  }
  pushScratch.depth = best + radius;
  return pushScratch;
}

/** True when a body of the given size can occupy (x, feetY, z) without intersecting anything. */
export function canOccupy(
  candidates: readonly Aabb[],
  x: number,
  feetY: number,
  z: number,
  radius: number,
  height: number,
): boolean {
  const head = feetY + height;
  for (const b of candidates) {
    if (b.maxY <= feetY + EPS || b.minY >= head - EPS) continue;
    if (circleOverlapsFootprint(x, z, radius, b)) return false;
  }
  return true;
}

/**
 * Highest box top at or below `ceilY` under the body circle, or -Infinity when the circle
 * hangs over nothing. `floorY` discards surfaces further down than we care about.
 */
export function highestTopUnder(
  candidates: readonly Aabb[],
  x: number,
  z: number,
  radius: number,
  floorY: number,
  ceilY: number,
): number {
  let best = -Infinity;
  for (const b of candidates) {
    if (b.maxY > ceilY + EPS) continue;
    if (b.maxY < floorY - EPS) continue;
    if (b.maxY <= best) continue;
    if (!circleOverlapsFootprint(x, z, radius, b)) continue;
    best = b.maxY;
  }
  return best;
}

/** Working state for one horizontal collide-and-slide pass. */
interface SlidePass {
  x: number;
  z: number;
  vx: number;
  vz: number;
  hitWall: boolean;
}

const slidePlain: SlidePass = { x: 0, z: 0, vx: 0, vz: 0, hitWall: false };
const slideStepped: SlidePass = { x: 0, z: 0, vx: 0, vz: 0, hitWall: false };

/**
 * Metres of extra reach the lifted slide must buy before the step-up is committed. Far below
 * anything a player can feel (0.01 mm), far above double-precision noise: a body grinding along
 * a riser at a shallow angle only recovers ~1 mm of blocked motion per tick, and the step has to
 * fire on that. A wall the lift does not clear blocks both passes identically, gains exactly 0,
 * and is still a wall.
 */
const STEP_MIN_GAIN = 1e-5;

/**
 * Moves (x, z) by (dx, dz) at a fixed feet height, sliding along whatever blocks it.
 * Boxes whose top is at or below `feetY` are floor, not wall, and never block.
 */
function slideXZ(
  candidates: readonly Aabb[],
  s: SlidePass,
  feetY: number,
  height: number,
  radius: number,
  dx: number,
  dz: number,
): void {
  s.x += dx;
  s.z += dz;
  for (let iter = 0; iter < 4; iter++) {
    let touched = false;
    for (const b of candidates) {
      if (b.maxY <= feetY + EPS || b.minY >= feetY + height - EPS) continue;
      const push = circlePush(s.x, s.z, radius, b);
      if (push === null) continue;
      s.x += push.nx * push.depth;
      s.z += push.nz * push.depth;
      const vn = s.vx * push.nx + s.vz * push.nz;
      if (vn < 0) {
        s.vx -= push.nx * vn;
        s.vz -= push.nz * vn;
      }
      s.hitWall = true;
      touched = true;
    }
    if (!touched) break;
  }
}

/**
 * True when raising the body from `feetY` to `feetY + lift` would not drive its head into
 * anything. Only the newly swept head slab is tested — what is already around the body at
 * its current height is the horizontal pass's problem, not the lift's.
 */
function hasLiftHeadroom(
  candidates: readonly Aabb[],
  x: number,
  z: number,
  radius: number,
  feetY: number,
  height: number,
  lift: number,
): boolean {
  const oldHead = feetY + height;
  const newHead = oldHead + lift;
  for (const b of candidates) {
    if (b.maxY <= oldHead + EPS || b.minY >= newHead - EPS) continue;
    if (circleOverlapsFootprint(x, z, radius, b)) return false;
  }
  return true;
}

export interface BodyShape {
  radius: number;
  /** Full standing (or crouched) height of the collider, feet to head. */
  height: number;
  /** Max ledge height the body walks up without jumping. */
  stepHeight: number;
}

export interface MoveResult {
  grounded: boolean;
  hitCeiling: boolean;
  hitWall: boolean;
  /** Metres gained by step-ups this tick (drives camera step smoothing). */
  stepUp: number;
  /** Downward speed at the moment of landing, 0 when no landing happened. */
  landingSpeed: number;
}

const candidateScratch: Aabb[] = [];
const queryScratch: Aabb[] = [];

/** A zeroed result, for a caller that wants one of its own. Allocate once, not per tick. */
export function createMoveResult(): MoveResult {
  return {
    grounded: false,
    hitCeiling: false,
    hitWall: false,
    stepUp: 0,
    landingSpeed: 0,
  };
}

/** The default `out` for `moveBody` — see the note on scratch at the top of the file. */
const sharedResult: MoveResult = createMoveResult();

/**
 * Integrates `position` by `velocity * dt` against the world, mutating both.
 * `position` is the centre of the body's feet.
 *
 * Returns `out`, every field of which is overwritten. `out` defaults to a module-shared
 * instance, so a caller that reads the result before moving anything else can ignore it; a
 * caller that keeps the result across another body's move must pass its own (`createMoveResult`,
 * allocated once at construction — never per tick).
 */
export function moveBody(
  world: StaticWorld,
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  dt: number,
  shape: BodyShape,
  wasGrounded: boolean,
  out: MoveResult = sharedResult,
): MoveResult {
  const { radius, height, stepHeight } = shape;
  const result = out;
  result.grounded = false;
  result.hitCeiling = false;
  result.hitWall = false;
  result.stepUp = 0;
  result.landingSpeed = 0;

  // One broadphase query covering the whole tick's swept region (plus step/snap slack).
  const endX = position.x + velocity.x * dt;
  const endZ = position.z + velocity.z * dt;
  const endY = position.y + velocity.y * dt;
  const candidates = world.query(
    Math.min(position.x, endX) - radius - EPS,
    Math.min(position.y, endY) - stepHeight - EPS,
    Math.min(position.z, endZ) - radius - EPS,
    Math.max(position.x, endX) + radius + EPS,
    Math.max(position.y, endY) + height + stepHeight + EPS,
    Math.max(position.z, endZ) + radius + EPS,
    candidateScratch,
  );

  // ---- vertical -----------------------------------------------------------
  const prevY = position.y;
  position.y += velocity.y * dt;

  if (velocity.y <= 0) {
    let bestTop = -Infinity;
    for (const b of candidates) {
      if (b.maxY > prevY + EPS) continue; // we were not above it
      if (b.maxY <= position.y) continue; // we did not reach it
      if (b.minY >= position.y + height) continue;
      if (!circleOverlapsFootprint(position.x, position.z, radius, b)) continue;
      if (b.maxY > bestTop) bestTop = b.maxY;
    }
    if (bestTop > -Infinity) {
      position.y = bestTop;
      result.landingSpeed = -velocity.y;
      velocity.y = 0;
      result.grounded = true;
    }
  } else {
    const prevHead = prevY + height;
    let bestBottom = Infinity;
    for (const b of candidates) {
      if (b.minY < prevHead - EPS) continue; // we were not below it
      if (b.minY >= position.y + height) continue; // we did not reach it
      if (b.maxY <= position.y) continue;
      if (!circleOverlapsFootprint(position.x, position.z, radius, b)) continue;
      if (b.minY < bestBottom) bestBottom = b.minY;
    }
    if (bestBottom < Infinity) {
      position.y = bestBottom - height;
      velocity.y = 0;
      result.hitCeiling = true;
    }
  }

  // ---- horizontal (collide-and-slide, retried as a swept step) --------------
  // Two candidate resolutions of the same motion:
  //   plain   — slide at the current feet height;
  //   stepped — lift by stepHeight, slide there, then drop back onto whatever is below.
  // The stepped one wins only when it actually gets further along the intended motion, so a
  // real wall still stops the body while a stair riser, a kerb or a 0.1 m ramp tread does not.
  // Because the lifted pass ignores everything whose top is under the raised feet, a cylinder
  // straddling several treads at once (0.7 m wide body, 0.5 m treads) climbs without stalling.
  const startX = position.x;
  const startZ = position.z;
  const feetY = position.y;
  const dx = velocity.x * dt;
  const dz = velocity.z * dt;

  const plain = slidePlain;
  plain.x = startX;
  plain.z = startZ;
  plain.vx = velocity.x;
  plain.vz = velocity.z;
  plain.hitWall = false;
  slideXZ(candidates, plain, feetY, height, radius, dx, dz);

  let stepped = false;
  const moveLen = Math.hypot(dx, dz);
  const allowStep = (result.grounded || wasGrounded) && stepHeight > 0 && moveLen > EPS;

  if (allowStep && plain.hitWall) {
    // How far each pass falls short of where the tick wanted to end up. Distance-to-target,
    // not progress along the motion: a body already sliding along a riser has had the blocked
    // component of its velocity zeroed, so the tick's motion is nearly all tangential and a
    // projection onto it would dilute the (tiny, but real) blocked component below any usable
    // threshold — which is exactly how a sprint up a stair flight used to pin at a shallow
    // approach angle. The shortfall vector keeps that component at full size.
    const targetX = startX + dx;
    const targetZ = startZ + dz;
    const plainShort = Math.hypot(targetX - plain.x, targetZ - plain.z);
    if (
      plainShort > STEP_MIN_GAIN &&
      hasLiftHeadroom(candidates, startX, startZ, radius, feetY, height, stepHeight)
    ) {
      const liftY = feetY + stepHeight;
      const s = slideStepped;
      s.x = startX;
      s.z = startZ;
      s.vx = velocity.x;
      s.vz = velocity.z;
      s.hitWall = false;
      slideXZ(candidates, s, liftY, height, radius, dx, dz);

      const steppedShort = Math.hypot(targetX - s.x, targetZ - s.z);
      if (steppedShort < plainShort - STEP_MIN_GAIN) {
        // Drop back down. Everything still overlapping the body up there tops out at or below
        // `liftY` (the lifted slide guaranteed it), so landing on the highest of them is by
        // construction a legal pose — no second clearance test needed.
        const top = highestTopUnder(candidates, s.x, s.z, radius, feetY, liftY);
        position.x = s.x;
        position.z = s.z;
        velocity.x = s.vx;
        velocity.z = s.vz;
        result.hitWall = s.hitWall;
        if (top > -Infinity) {
          if (top > feetY) result.stepUp += top - feetY;
          position.y = top;
          result.grounded = true;
          if (velocity.y < 0) velocity.y = 0;
        } else {
          // Stepped over something with nothing behind it (a rail at a platform edge):
          // keep the height, let gravity and the ground snap sort out the landing.
          position.y = feetY;
        }
        stepped = true;
      }
    }
  }

  if (!stepped) {
    position.x = plain.x;
    position.z = plain.z;
    velocity.x = plain.vx;
    velocity.z = plain.vz;
    result.hitWall = plain.hitWall;
  }

  // ---- ground snap ---------------------------------------------------------
  // Walking off a step or down a ramp: reattach to ground within the step tolerance
  // instead of going briefly airborne (which would break coyote/friction feel).
  if (!result.grounded && wasGrounded && velocity.y <= 0) {
    let bestTop = -Infinity;
    for (const b of candidates) {
      if (b.maxY > position.y + EPS) continue;
      if (b.maxY < position.y - stepHeight) continue;
      if (!circleOverlapsFootprint(position.x, position.z, radius, b)) continue;
      if (b.maxY > bestTop) bestTop = b.maxY;
    }
    if (bestTop > -Infinity) {
      position.y = bestTop;
      velocity.y = 0;
      result.grounded = true;
    }
  }

  return result;
}

/**
 * Below this a slab counts as parallel to the ray: the axis only gates the box, it never
 * contributes a distance.
 *
 * The threshold is not about a division by zero — IEEE division copes, and for every direction
 * component small enough to matter the resulting `t` is so enormous that the box is rejected on
 * range anyway. What the branch actually protects is the signed zero: a component of exactly
 * `-0` gives a reciprocal of `-Infinity`, and an origin sitting exactly on the slab's `lo` plane
 * then computes `(lo - o) * -Infinity === NaN` next to an exit of `-Infinity`, which clamps the
 * exit behind the origin and throws away a box the ray is running along. A level look direction
 * is `-sin(0)` — exactly `-0` — so that is not a hypothetical.
 */
const SLAB_PARALLEL = 1e-9;

/**
 * Which axis the last `raySlabEnter` crossed to get in — 0/1/2, or -1 for "it did not cross
 * one". See the scratch note at the top of the file.
 */
let slabEntryAxis = -1;

/**
 * The one ray-slab loop in the game: where along the ray does it enter this box?
 *
 * Returns the entry distance in units of `d` (metres when `d` is unit length), or `Infinity`
 * when the box is missed inside `[0, tmaxSeed]`. A hit's distance is always ≤ `tmaxSeed`, so
 * with a finite seed the sentinel cannot collide with a real answer.
 *
 * Three callers, three uses of the same arithmetic, which is why it is one function and not
 * three copies:
 *  - `inflate` grows the box on every axis first — the Minkowski shortcut that turns a sphere
 *    sweep into a ray query (`sweepSphereWorld`). Pass 0 for a true ray.
 *  - `tmaxSeed` is where the exit clamp starts. Seed it with the nearest hit found so far and
 *    the test prunes for free (a box entered beyond the current best reports a miss); seed it
 *    with the segment length for a plain any-hit occlusion query (`StructuredPaint.blocked`).
 *  - the face crossed on the way in is left in `slabEntryAxis`, which only `raycastWorld`
 *    reads. It is -1 when the entry never moved off `t = 0`: the ray began at or inside this
 *    box and crossed nothing to get there.
 *
 * A NaN direction or origin component makes every comparison on that axis false, so the axis is
 * silently skipped rather than rejecting the box. That is inherited behaviour, pinned by test,
 * and the reason `raycastWorld` refuses a non-finite query up front instead of relying on it.
 */
export function raySlabEnter(
  b: Aabb,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  inflate: number,
  tmaxSeed: number,
): number {
  slabEntryAxis = -1;
  let tmin = 0;
  let tmax = tmaxSeed;
  // One slab per axis, indexed rather than vectorised — the Aabb is six plain numbers.
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? ox : axis === 1 ? oy : oz;
    const d = axis === 0 ? dx : axis === 1 ? dy : dz;
    const lo = (axis === 0 ? b.minX : axis === 1 ? b.minY : b.minZ) - inflate;
    const hi = (axis === 0 ? b.maxX : axis === 1 ? b.maxY : b.maxZ) + inflate;
    if (Math.abs(d) < SLAB_PARALLEL) {
      if (o < lo || o > hi) return Infinity;
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
    if (t1 > tmin) {
      tmin = t1;
      slabEntryAxis = axis;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

const sweepScratch: Aabb[] = [];

/**
 * Sweeps a sphere of `radius` from an origin along a unit direction and returns how far it
 * travels before touching something (or `maxDist` when the way is clear).
 *
 * Boxes are inflated by `radius` and hit with an ordinary ray-slab test — the Minkowski
 * shortcut. It over-reports at box corners (the inflated box has square corners where the
 * true swept volume is round), which for its one caller — the third-person boom — is the
 * safe direction to be wrong in: the camera is pulled in slightly early rather than late.
 * An origin already inside an inflated box returns 0.
 */
export function sweepSphereWorld(
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
    sweepScratch,
  );

  let nearest = maxDist;
  for (const b of candidates) {
    // Seeding the exit clamp with the running nearest is the pruning: a box entered further
    // away than the best hit so far comes back as a miss and costs nothing to reject.
    const tmin = raySlabEnter(b, ox, oy, oz, dx, dy, dz, radius, nearest);
    if (tmin < nearest) nearest = tmin;
    if (nearest <= 0) return 0;
  }
  return nearest;
}

export interface RayHit {
  /** Distance along the direction handed in — metres when that direction is unit length. */
  t: number;
  /**
   * The struck face's unit normal, always pointing back towards the ray: `n · d < 0` holds for
   * every answer this function gives, including the origin-inside case. Consumers lean on that
   * — a bounce is `v - 2(v·n)n` and wants the near side, a surface-attach wants the face it
   * arrived at — and none of them should have to special-case a sign.
   */
  nx: number;
  ny: number;
  nz: number;
  /**
   * The box that was struck, not a copy of it: `box.mat` is what makes a can off metal and a
   * can off concrete different sounds, and `box.shell` is what makes a wall different from a
   * crate. Valid until the world is rebuilt.
   */
  box: Aabb;
}

/** The placeholder a hit carries before it has been filled in. In no world. */
const ZERO_BOX: Aabb = aabbFromBounds(0, 0, 0, 0, 0, 0);

/**
 * A zeroed hit, for a caller that wants one of its own. Allocate once, not per ray.
 *
 * Its fields mean nothing until a `raycastWorld` call fills them — in particular `box` is the
 * placeholder above.
 */
export function createRayHit(): RayHit {
  return { t: 0, nx: 0, ny: 0, nz: 0, box: ZERO_BOX };
}

/** The default `out` for `raycastWorld` — see the note on scratch at the top of the file. */
const sharedRayHit: RayHit = createRayHit();

const rayScratch: Aabb[] = [];

/**
 * Nearest hit of a ray against the static world, with the surface normal.
 *
 * `d` should be unit length: `t` comes back in its units, so a half-length direction reports
 * half the distance. Returns `null` when nothing is struck within `maxDist`, and otherwise
 * `out`, every field of which is overwritten. A miss leaves `out` alone, so a caller may keep
 * its last hit there. `out` defaults to a module-shared instance, so a caller that reads the
 * hit before casting again can ignore it; a caller that keeps a hit across another cast must
 * own one (`createRayHit`, allocated once — never per ray).
 *
 * Decisions a consumer has to be able to rely on, all pinned in `tests/raycast.test.ts`:
 *
 *  - **`maxDist` is inclusive.** A surface at exactly `maxDist` is struck. That matches the
 *    slab test itself, which counts a corner grazed at `tmin === tmax` as a hit, and it is the
 *    forgiving direction for a thrown object stepped by `speed * dt`: the alternative leaves it
 *    exactly touching a wall and relying on the next tick to notice.
 *  - **Ties go to the first box in the world.** Two boxes sharing a face are both entered at
 *    the same `t`; nothing distinguishes them, and stability beats an arbitrary re-sort.
 *  - **Contact counts as a hit, and `t === 0` means contact rather than impact.** A ray running
 *    exactly along a face grazes it; a ray whose origin sits on a surface reports that surface
 *    at `t = 0` even when it points away from it. Both are the slab test's own rule (it counts
 *    `tmin === tmax`), and a query has no business hiding geometry it is touching. The
 *    consequence a consumer must handle: at `t = 0` there is no approach to reverse, so
 *    separate along `n` — reflecting a velocity there would bounce a can resting on a floor
 *    back into the floor.
 *  - **An origin inside a box hits it at `t = 0`**, with the normal of the face the ray is on
 *    its way out through, reversed. `null` was the alternative and is worse in both directions:
 *    a thrown can that ended a tick a millimetre inside a wall would have nothing to bounce off
 *    and would keep going, and a spider probing for the surface under its own foot would lose
 *    that surface at the exact moment the foot reached it. A containing box with a reflectable
 *    normal is recoverable; silence is not. It also keeps the story here identical to
 *    `sweepSphereWorld`'s, which has always reported 0 rather than "clear" from inside a box.
 *    An origin sitting exactly *on* a face is the same case and takes the same rule, which for
 *    an axis-aligned ray names the face underfoot and for an oblique one can name whichever
 *    face it leaves through first. Both are a zero distance away and both face the ray; one
 *    rule for every `t = 0` answer is worth more than a second rule to tell them apart.
 *  - **A query that is not a ray returns `null`**: a non-positive or NaN `maxDist`, a non-finite
 *    origin or direction, or a direction so short that every slab would call it parallel (which
 *    includes zero). Those have no entry face, so there is no normal to answer with, and
 *    guessing one would be exactly the kind of lie law 2 forbids.
 */
export function raycastWorld(
  world: StaticWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  out: RayHit = sharedRayHit,
): RayHit | null {
  if (!(maxDist > 0)) return null; // catches 0, negatives and NaN
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return null;
  // A direction every slab would call parallel is not a direction: nothing is ever crossed, so
  // no face and no normal exist. Zero lands here, and so does anything below the threshold.
  if (
    !(
      Math.abs(dx) >= SLAB_PARALLEL ||
      Math.abs(dy) >= SLAB_PARALLEL ||
      Math.abs(dz) >= SLAB_PARALLEL
    )
  ) {
    return null;
  }

  const ex = ox + dx * maxDist;
  const ey = oy + dy * maxDist;
  const ez = oz + dz * maxDist;
  // The broadphase is inflated by EPS where the sweep's is inflated by the sphere radius, and
  // for the same reason: `query` treats touching as not overlapping, so a ray running exactly
  // along a floor gives a zero-thickness query slab that culls the very floor it is grazing —
  // while the slab test below counts that graze as a hit. The narrowphase decides; the
  // broadphase must not get there first.
  const candidates = world.query(
    Math.min(ox, ex) - EPS,
    Math.min(oy, ey) - EPS,
    Math.min(oz, ez) - EPS,
    Math.max(ox, ex) + EPS,
    Math.max(oy, ey) + EPS,
    Math.max(oz, ez) + EPS,
    rayScratch,
  );

  let nearest = maxDist;
  let hitBox: Aabb | null = null;
  let hitAxis = -1;
  for (const b of candidates) {
    const t = raySlabEnter(b, ox, oy, oz, dx, dy, dz, 0, nearest);
    if (t === Infinity) continue;
    // `>=`, so the first box entered at a given distance keeps the hit. Seeding the slab test
    // with `nearest` already rejected everything strictly further, so this only settles ties.
    if (hitBox !== null && t >= nearest) continue;
    nearest = t;
    hitBox = b;
    hitAxis = slabEntryAxis;
    if (t <= 0) break; // nothing can be nearer than the box we are already inside
  }
  if (hitBox === null) return null;

  // No face was crossed on the way in, so the ray started at or inside this box: name the face
  // it is leaving through instead. Both cases end on the same expression for the normal — the
  // entry face of a slab and the reversed exit face of one are the same side of it — so the
  // only thing the inside case has to answer is *which axis*.
  if (hitAxis < 0) {
    let exitT = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const d = axis === 0 ? dx : axis === 1 ? dy : dz;
      if (Math.abs(d) < SLAB_PARALLEL) continue;
      const o = axis === 0 ? ox : axis === 1 ? oy : oz;
      const far =
        d > 0
          ? axis === 0
            ? hitBox.maxX
            : axis === 1
              ? hitBox.maxY
              : hitBox.maxZ
          : axis === 0
            ? hitBox.minX
            : axis === 1
              ? hitBox.minY
              : hitBox.minZ;
      const t = (far - o) / d;
      // `hitAxis < 0` on the first non-parallel axis: the direction guard above proved there is
      // one, and taking it unconditionally means a pathological `t` can never leave us with no
      // axis at all. After that, nearest exit wins and ties go to the earlier axis, matching
      // the entry face's own tie-break.
      if (hitAxis < 0 || t < exitT) {
        exitT = t;
        hitAxis = axis;
      }
    }
  }

  // The face is the low one when the ray runs up the axis and the high one when it runs down,
  // and its outward normal points back at the origin either way.
  const sign = (hitAxis === 0 ? dx : hitAxis === 1 ? dy : dz) > 0 ? -1 : 1;
  out.t = nearest;
  out.nx = hitAxis === 0 ? sign : 0;
  out.ny = hitAxis === 1 ? sign : 0;
  out.nz = hitAxis === 2 ? sign : 0;
  out.box = hitBox;
  return out;
}

/** Convenience wrapper: can the body stand at this spot given the whole world? */
export function canOccupyWorld(
  world: StaticWorld,
  x: number,
  feetY: number,
  z: number,
  radius: number,
  height: number,
): boolean {
  const candidates = world.query(
    x - radius,
    feetY,
    z - radius,
    x + radius,
    feetY + height,
    z + radius,
    queryScratch,
  );
  return canOccupy(candidates, x, feetY, z, radius, height);
}
