/**
 * Static-world collision: the world is a list of axis-aligned boxes and the player is a
 * vertical cylinder (a capsule with flat caps — for a kinematic FPS controller this behaves
 * identically in practice and keeps ground/step logic exact).
 *
 * Resolution is split: vertical first (gravity, landing, ceilings), then horizontal
 * (collide-and-slide with a step-up tolerance), then an optional ground snap so walking
 * down stairs and ramps doesn't launch the player into the air.
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
   * paint system does, because a return off metal and a return off concrete are not the same
   * sound. Absent means concrete (0), which is what most of a facility is.
   */
  readonly mat?: number;
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
): Aabb {
  return { minX, minY, minZ, maxX, maxY, maxZ, mat };
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
const result: MoveResult = {
  grounded: false,
  hitCeiling: false,
  hitWall: false,
  stepUp: 0,
  landingSpeed: 0,
};

/**
 * Integrates `position` by `velocity * dt` against the world, mutating both.
 * `position` is the centre of the body's feet. Returns a shared result object.
 */
export function moveBody(
  world: StaticWorld,
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  dt: number,
  shape: BodyShape,
  wasGrounded: boolean,
): MoveResult {
  const { radius, height, stepHeight } = shape;
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
    let tmin = 0;
    let tmax = nearest;
    // One slab per axis, indexed rather than vectorised — the Aabb is six plain numbers.
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
