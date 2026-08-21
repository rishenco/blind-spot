// Axis-separated AABB collision for a player-sized box. Shared so the server can
// re-simulate (and therefore validate) client movement with identical results.

import type { World } from './world.ts';
import type { Vec3 } from './math.ts';

export const PLAYER_RADIUS = 0.34;
export const PLAYER_HEIGHT = 1.72;
export const STEP_HEIGHT = 0.42;

export interface MoveResult {
  pos: Vec3;
  grounded: boolean;
  /** Total distance the solver had to push the body out of geometry — a proxy for "scraped a wall". */
  pushed: number;
}

function overlaps(w: World, x: number, y: number, z: number, h: number): number[] {
  const r = PLAYER_RADIUS;
  const out: number[] = [];
  for (let i = 0; i < w.boxes.length; i++) {
    const b = w.boxes[i]!;
    if (x + r <= b.min.x || x - r >= b.max.x) continue;
    if (z + r <= b.min.z || z - r >= b.max.z) continue;
    if (y + h <= b.min.y || y >= b.max.y) continue;
    out.push(i);
  }
  return out;
}

/**
 * Move a player capsule-ish box by (dx,dy,dz), resolving each axis independently.
 * Small ledges up to STEP_HEIGHT are stepped over so the player does not snag on kerbs.
 */
export function movePlayer(w: World, pos: Vec3, dx: number, dy: number, dz: number, height = PLAYER_HEIGHT): MoveResult {
  let { x, y, z } = pos;
  const r = PLAYER_RADIUS;
  let pushed = 0;

  // ---- X ----
  x += dx;
  for (const i of overlaps(w, x, y, z, height)) {
    const b = w.boxes[i]!;
    // A low ledge we can step onto is not a wall.
    if (b.max.y - y <= STEP_HEIGHT && b.max.y > y) { y = b.max.y; continue; }
    if (dx > 0) { pushed += x + r - b.min.x; x = b.min.x - r; }
    else if (dx < 0) { pushed += b.max.x - (x - r); x = b.max.x + r; }
  }

  // ---- Z ----
  z += dz;
  for (const i of overlaps(w, x, y, z, height)) {
    const b = w.boxes[i]!;
    if (b.max.y - y <= STEP_HEIGHT && b.max.y > y) { y = b.max.y; continue; }
    if (dz > 0) { pushed += z + r - b.min.z; z = b.min.z - r; }
    else if (dz < 0) { pushed += b.max.z - (z - r); z = b.max.z + r; }
  }

  // ---- Y ----
  y += dy;
  let grounded = false;
  for (const i of overlaps(w, x, y, z, height)) {
    const b = w.boxes[i]!;
    if (dy <= 0 && y < b.max.y && pos.y >= b.max.y - STEP_HEIGHT) { y = b.max.y; grounded = true; }
    else if (dy > 0 && y + height > b.min.y) { y = b.min.y - height; }
  }
  // Standing exactly on a surface reports grounded even with zero vertical velocity.
  if (!grounded) {
    const probe = overlaps(w, x, y - 0.06, z, height);
    for (const i of probe) { if (w.boxes[i]!.max.y <= y + 0.06) { grounded = true; break; } }
  }

  return { pos: { x, y, z }, grounded, pushed };
}
