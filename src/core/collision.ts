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
): Aabb {
  return { minX, minY, minZ, maxX, maxY, maxZ };
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
function circleOverlapsFootprint(x: number, z: number, radius: number, b: Aabb): boolean {
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

  // ---- horizontal (collide-and-slide with step-up) -------------------------
  position.x += velocity.x * dt;
  position.z += velocity.z * dt;

  const allowStep = result.grounded || wasGrounded;
  for (let iter = 0; iter < 4; iter++) {
    let touched = false;
    for (const b of candidates) {
      const feet = position.y;
      if (b.maxY <= feet + EPS || b.minY >= feet + height - EPS) continue;
      const push = circlePush(position.x, position.z, radius, b);
      if (push === null) continue;

      const stepTop = b.maxY;
      if (
        allowStep &&
        stepTop > feet &&
        stepTop <= feet + stepHeight + EPS &&
        canOccupy(candidates, position.x, stepTop, position.z, radius, height)
      ) {
        result.stepUp += stepTop - feet;
        position.y = stepTop;
        result.grounded = true;
        if (velocity.y < 0) velocity.y = 0;
        touched = true;
        continue;
      }

      position.x += push.nx * push.depth;
      position.z += push.nz * push.depth;
      const vn = velocity.x * push.nx + velocity.z * push.nz;
      if (vn < 0) {
        velocity.x -= push.nx * vn;
        velocity.z -= push.nz * vn;
      }
      result.hitWall = true;
      touched = true;
    }
    if (!touched) break;
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
