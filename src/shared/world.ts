// Static world representation: axis-aligned boxes + a uniform XZ grid for fast raycasting.
// Shared by client (scan point generation, collision) and server (line-of-sight, hitscan).

import type { Vec3 } from './math.ts';

/** Surface materials change how a surface answers a pulse. */
export const enum Mat {
  Concrete = 0, // default: normal return
  Metal = 1,    // bright, sharp, high return
  Glass = 2,    // weak, sparse return (easy to miss a whole wall)
  Cloth = 3,    // absorbent: very weak return, near-invisible baffles
  Grate = 4,    // noisy, scattered return
  Objective = 5,// the artifact / objective marker: distinctive colour
}

export interface Box {
  min: Vec3;
  max: Vec3;
  mat: Mat;
}

export interface Hit {
  t: number;      // distance along ray
  nx: number; ny: number; nz: number;
  mat: Mat;
  box: number;
}

const CELL = 4; // metres per acceleration-grid cell

export class World {
  boxes: Box[];
  minX = Infinity; minZ = Infinity; maxX = -Infinity; maxZ = -Infinity;
  private gw = 0; private gh = 0;
  private cells: Int32Array[] = [];

  constructor(boxes: Box[]) {
    this.boxes = boxes;
    for (const b of boxes) {
      if (b.min.x < this.minX) this.minX = b.min.x;
      if (b.min.z < this.minZ) this.minZ = b.min.z;
      if (b.max.x > this.maxX) this.maxX = b.max.x;
      if (b.max.z > this.maxZ) this.maxZ = b.max.z;
    }
    this.gw = Math.max(1, Math.ceil((this.maxX - this.minX) / CELL));
    this.gh = Math.max(1, Math.ceil((this.maxZ - this.minZ) / CELL));
    const buckets: number[][] = Array.from({ length: this.gw * this.gh }, () => []);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const x0 = this.cx(b.min.x), x1 = this.cx(b.max.x);
      const z0 = this.cz(b.min.z), z1 = this.cz(b.max.z);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) buckets[z * this.gw + x]!.push(i);
    }
    this.cells = buckets.map((b) => Int32Array.from(b));
  }

  private cx(x: number) { return Math.min(this.gw - 1, Math.max(0, Math.floor((x - this.minX) / CELL))); }
  private cz(z: number) { return Math.min(this.gh - 1, Math.max(0, Math.floor((z - this.minZ) / CELL))); }

  /**
   * Raycast against the world. Walks the XZ grid with DDA and slab-tests candidate boxes.
   * Returns the nearest hit within maxT, or null.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): Hit | null {
    let best: Hit | null = null;
    let bestT = maxT;

    // DDA setup over the XZ grid.
    let cxi = this.cx(ox), czi = this.cz(oz);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const invDx = dx !== 0 ? 1 / dx : Infinity;
    const invDz = dz !== 0 ? 1 / dz : Infinity;
    const nextBoundX = this.minX + (cxi + (stepX > 0 ? 1 : 0)) * CELL;
    const nextBoundZ = this.minZ + (czi + (stepZ > 0 ? 1 : 0)) * CELL;
    let tMaxX = stepX !== 0 ? (nextBoundX - ox) * invDx : Infinity;
    let tMaxZ = stepZ !== 0 ? (nextBoundZ - oz) * invDz : Infinity;
    const tDeltaX = stepX !== 0 ? Math.abs(CELL * invDx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(CELL * invDz) : Infinity;

    // Visited-set via generation stamps would be nicer; boxes spanning cells are cheap to retest.
    let guard = 0;
    let tCur = 0;
    while (guard++ < 512) {
      const bucket = this.cells[czi * this.gw + cxi];
      if (bucket) {
        for (let k = 0; k < bucket.length; k++) {
          const i = bucket[k]!;
          const b = this.boxes[i]!;
          const h = slab(b, ox, oy, oz, dx, dy, dz, bestT);
          if (h && h.t < bestT) { bestT = h.t; h.box = i; best = h; }
        }
      }
      // Stop when the nearest hit is closer than the entry point of the next cell.
      if (best && bestT <= tCur) break;
      if (tMaxX < tMaxZ) {
        tCur = tMaxX;
        if (tCur > bestT || tCur > maxT) break;
        cxi += stepX; tMaxX += tDeltaX;
        if (cxi < 0 || cxi >= this.gw) break;
      } else {
        tCur = tMaxZ;
        if (tCur > bestT || tCur > maxT) break;
        czi += stepZ; tMaxZ += tDeltaZ;
        if (czi < 0 || czi >= this.gh) break;
      }
    }
    return best;
  }

  /** True when nothing blocks the segment a->b (small epsilon pullback at both ends). */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) return true;
    const h = this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d - 0.05);
    return h === null;
  }
}

const EPS = 1e-6;

function slab(b: Box, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): Hit | null {
  let tmin = 0, tmax = maxT;
  let nAxis = 0, nSign = 0;

  // X
  if (Math.abs(dx) < EPS) { if (ox < b.min.x || ox > b.max.x) return null; }
  else {
    const inv = 1 / dx;
    let t1 = (b.min.x - ox) * inv, t2 = (b.max.x - ox) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; nAxis = 0; nSign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Y
  if (Math.abs(dy) < EPS) { if (oy < b.min.y || oy > b.max.y) return null; }
  else {
    const inv = 1 / dy;
    let t1 = (b.min.y - oy) * inv, t2 = (b.max.y - oy) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; nAxis = 1; nSign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Z
  if (Math.abs(dz) < EPS) { if (oz < b.min.z || oz > b.max.z) return null; }
  else {
    const inv = 1 / dz;
    let t1 = (b.min.z - oz) * inv, t2 = (b.max.z - oz) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; nAxis = 2; nSign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  if (tmin <= 0 || tmin > maxT) return null;
  return {
    t: tmin,
    nx: nAxis === 0 ? nSign : 0,
    ny: nAxis === 1 ? nSign : 0,
    nz: nAxis === 2 ? nSign : 0,
    mat: b.mat,
    box: -1,
  };
}
