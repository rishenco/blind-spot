/**
 * MapDef -> collision set + occluder set + walkable/ladder volumes (engine-plan §2), plus the
 * queries the movement controller and the paint pipeline run against them.
 *
 * Everything here is pure and DOM-free so vitest can drive it directly.
 *
 * Shapes: axis-aligned boxes and vertical cylinders. The player is a vertical cylinder
 * (capsule with flat caps): `x, z` centre, `feetY` at the bottom, radius `r`, height `h`.
 * Flat caps are deliberate — they make ledges, step-up and mantle heights exact.
 *
 * Query surface (all take the built `World`):
 *   solidAt / capsuleOverlaps / overlapSolids   — static tests
 *   moveCapsule                                 — collide-and-slide + step-up (the mover)
 *   resolvePenetration                          — push a capsule out of anything it starts in
 *   groundUnder / headroom                      — support and clearance probes
 *   ledgeProbe                                  — mantle/vault candidate in front of the player
 *   ladderAt                                    — climb volumes
 *   raycast / segmentClear / countWalls         — sight/hearing lines (vision §3.4)
 */

import { GROUND_PROBE_FRAC, OCCLUDER_MIN_CHORD, STEP_UP_MAX } from '../const.js';
import type { AirVolume, LadderDef, MapDef, Solid, SolidKind } from './types.js';

// ------------------------------------------------------------------------------------------
// Built structures
// ------------------------------------------------------------------------------------------

export interface CollisionSolid {
  readonly index: number;
  readonly id: string;
  readonly kind: SolidKind;
  readonly shape: 'box' | 'cyl';
  /** AABB — for a cylinder this is its bounding box. */
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  /** Cylinder axis + radius (0 for boxes). */
  readonly cx: number;
  readonly cz: number;
  readonly r: number;
}

/** A top face a body can stand on. Also the input to hold-line derivation (vision §5). */
export interface WalkableTop {
  readonly solid: CollisionSolid;
  readonly y: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** The grab volume in front of a ladder's climbing plane. */
export interface LadderVolume {
  readonly def: LadderDef;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly yBase: number;
  readonly yTop: number;
  /** Unit vector from the ladder plane toward the climber. */
  readonly outX: number;
  readonly outZ: number;
}

export interface World {
  readonly map: MapDef;
  readonly solids: readonly CollisionSolid[];
  /**
   * Solids that block sound (`countWalls` reads this, never `solids`). Its own array, so M3 can
   * narrow it to sound-occluding kinds without touching the collision set. INVARIANT: it stays
   * index-aligned with `solids`, because the broadphase indexes both — a future narrowing masks
   * entries out inside `countWalls`, it never re-packs the array.
   */
  readonly occluders: readonly CollisionSolid[];
  readonly walkables: readonly WalkableTop[];
  readonly ladders: readonly LadderVolume[];
  readonly air: readonly AirVolume[];
  readonly bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly minZ: number;
    readonly maxX: number;
    readonly maxY: number;
    readonly maxZ: number;
  };
  /** Uniform XZ broadphase grid. */
  readonly grid: Grid;
}

interface Grid {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  readonly buckets: readonly (readonly number[])[];
}

const GRID_CELL = 2.0;
/**
 * One straddle tolerance for BOTH axes' overlap tests (1 mm). It is what keeps "standing
 * exactly on a top face" and "head exactly at a ceiling" reading as touching rather than
 * overlapping. 1e-3 over the arithmetic 1e-6: depenetration pushes out by EPS and then has to
 * agree that the body is clear, and a sub-millimetre residue must never re-trigger a push. The
 * horizontal and vertical tests share it so they can never disagree about the same body.
 */
const EPS_STRADDLE = 1e-3;
const EPS = 1e-6;

// ------------------------------------------------------------------------------------------
// Build
// ------------------------------------------------------------------------------------------

function toCollisionSolid(s: Solid, index: number): CollisionSolid {
  if (s.type === 'box') {
    return {
      index,
      id: s.id,
      kind: s.kind,
      shape: 'box',
      minX: s.min[0],
      minY: s.min[1],
      minZ: s.min[2],
      maxX: s.max[0],
      maxY: s.max[1],
      maxZ: s.max[2],
      cx: 0,
      cz: 0,
      r: 0,
    };
  }
  return {
    index,
    id: s.id,
    kind: s.kind,
    shape: 'cyl',
    minX: s.cx - s.r,
    minY: s.yMin,
    minZ: s.cz - s.r,
    maxX: s.cx + s.r,
    maxY: s.yMax,
    maxZ: s.cz + s.r,
    cx: s.cx,
    cz: s.cz,
    r: s.r,
  };
}

function buildGrid(solids: readonly CollisionSolid[], b: World['bounds']): Grid {
  const x0 = Math.floor(b.minX / GRID_CELL);
  const z0 = Math.floor(b.minZ / GRID_CELL);
  const nx = Math.floor(b.maxX / GRID_CELL) - x0 + 1;
  const nz = Math.floor(b.maxZ / GRID_CELL) - z0 + 1;
  const buckets: number[][] = new Array(nx * nz);
  for (let i = 0; i < buckets.length; i++) buckets[i] = [];
  for (const s of solids) {
    const ix0 = Math.max(0, Math.floor(s.minX / GRID_CELL) - x0);
    const ix1 = Math.min(nx - 1, Math.floor(s.maxX / GRID_CELL) - x0);
    const iz0 = Math.max(0, Math.floor(s.minZ / GRID_CELL) - z0);
    const iz1 = Math.min(nz - 1, Math.floor(s.maxZ / GRID_CELL) - z0);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) buckets[iz * nx + ix]!.push(s.index);
    }
  }
  return { cell: GRID_CELL, x0, z0, nx, nz, buckets };
}

function ladderVolume(def: LadderDef): LadderVolume {
  const halfW = def.width / 2;
  const d = def.depth;
  let minX: number, maxX: number, minZ: number, maxZ: number, outX = 0, outZ = 0;
  switch (def.facing) {
    case '+x':
      minX = def.x;
      maxX = def.x + d;
      minZ = def.z - halfW;
      maxZ = def.z + halfW;
      outX = 1;
      break;
    case '-x':
      minX = def.x - d;
      maxX = def.x;
      minZ = def.z - halfW;
      maxZ = def.z + halfW;
      outX = -1;
      break;
    case '+z':
      minX = def.x - halfW;
      maxX = def.x + halfW;
      minZ = def.z;
      maxZ = def.z + d;
      outZ = 1;
      break;
    default:
      minX = def.x - halfW;
      maxX = def.x + halfW;
      minZ = def.z - d;
      maxZ = def.z;
      outZ = -1;
      break;
  }
  return { def, minX, minZ, maxX, maxZ, yBase: def.yBase, yTop: def.yTop, outX, outZ };
}

/**
 * Sample points across a solid's top face. A single centre probe is not enough: a large slab
 * whose centre happens to sit under a wall would lose its whole top face.
 */
function topFaceProbes(s: CollisionSolid): Array<[number, number]> {
  if (s.shape === 'cyl') {
    return [
      [s.cx, s.cz],
      [s.cx + s.r * 0.6, s.cz],
      [s.cx - s.r * 0.6, s.cz],
      [s.cx, s.cz + s.r * 0.6],
      [s.cx, s.cz - s.r * 0.6],
    ];
  }
  const nx = Math.min(5, Math.max(1, Math.ceil((s.maxX - s.minX) / 2)));
  const nz = Math.min(5, Math.max(1, Math.ceil((s.maxZ - s.minZ) / 2)));
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      pts.push([s.minX + ((i + 0.5) / nx) * (s.maxX - s.minX), s.minZ + ((k + 0.5) / nz) * (s.maxZ - s.minZ)]);
    }
  }
  return pts;
}

export function buildWorld(map: MapDef): World {
  const solids = map.solids.map(toCollisionSolid);
  const bounds = {
    minX: map.bounds.min[0],
    minY: map.bounds.min[1],
    minZ: map.bounds.min[2],
    maxX: map.bounds.max[0],
    maxY: map.bounds.max[1],
    maxZ: map.bounds.max[2],
  };
  const grid = buildGrid(solids, bounds);
  const world: World = {
    map,
    solids,
    // Its own array (World.occluders): index-aligned with `solids` today, narrowable by kind
    // in M3 without disturbing collision.
    occluders: solids.slice(),
    walkables: [],
    ladders: map.ladders.map(ladderVolume),
    air: map.air,
    bounds,
    grid,
  };
  /**
   * Top of the authored interior — the highest playable air (map/types.ts `air`). Anything
   * whose top face is at or above it is the roof of the level, not a surface anything can ever
   * stand on, so it is not a walkable and must not feed hold-line derivation.
   */
  const interiorTop = map.air.length ? Math.max(...map.air.map((a) => a.max[1])) : Infinity;
  // Walkable tops: every top face with at least one point not buried under another solid.
  const walkables: WalkableTop[] = [];
  for (const s of solids) {
    if (s.maxY >= interiorTop - EPS) continue;
    const probeY = s.maxY + 0.05;
    const exposed = topFaceProbes(s).some((p) => solidAt(world, p[0], probeY, p[1], s.index) === null);
    if (!exposed) continue;
    walkables.push({ solid: s, y: s.maxY, minX: s.minX, minZ: s.minZ, maxX: s.maxX, maxZ: s.maxZ });
  }
  return { ...world, walkables };
}

// ------------------------------------------------------------------------------------------
// Broadphase
// ------------------------------------------------------------------------------------------

let queryStamp = 0;
let stamps: Int32Array = new Int32Array(0);

/** Gather the solid indices whose AABB may overlap the XZ rect. Deduplicated. */
export function queryXZ(world: World, minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
  out.length = 0;
  const g = world.grid;
  if (stamps.length < world.solids.length) stamps = new Int32Array(world.solids.length);
  const stamp = ++queryStamp;
  const ix0 = Math.max(0, Math.floor(minX / g.cell) - g.x0);
  const ix1 = Math.min(g.nx - 1, Math.floor(maxX / g.cell) - g.x0);
  const iz0 = Math.max(0, Math.floor(minZ / g.cell) - g.z0);
  const iz1 = Math.min(g.nz - 1, Math.floor(maxZ / g.cell) - g.z0);
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      for (const idx of g.buckets[iz * g.nx + ix]!) {
        if (stamps[idx] === stamp) continue;
        stamps[idx] = stamp;
        out.push(idx);
      }
    }
  }
  return out;
}

/**
 * Candidate-list pool. Every query borrows its own buffer and returns it in a `finally`, so
 * queries nest safely: `ledgeProbe` iterating candidates while `capsuleOverlaps` runs, or a
 * `countWalls` filter that asks the world a question mid-iteration (M3's paint step does
 * exactly that). A shared module scratch made those cases silently return wrong answers.
 */
const pool: number[][] = [];
const take = (): number[] => pool.pop() ?? [];
const give = (a: number[]): void => {
  if (pool.length < 8) pool.push(a);
};

// ------------------------------------------------------------------------------------------
// Point / overlap tests
// ------------------------------------------------------------------------------------------

function pointInSolid(s: CollisionSolid, x: number, y: number, z: number): boolean {
  if (y < s.minY || y > s.maxY) return false;
  if (s.shape === 'box') return x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ;
  const dx = x - s.cx;
  const dz = z - s.cz;
  return dx * dx + dz * dz <= s.r * s.r;
}

/** The solid containing a point, or null. `skipIndex` lets the bake ignore one solid. */
export function solidAt(world: World, x: number, y: number, z: number, skipIndex = -1): CollisionSolid | null {
  const buf = take();
  try {
    queryXZ(world, x, z, x, z, buf);
    for (const idx of buf) {
      if (idx === skipIndex) continue;
      const s = world.solids[idx]!;
      if (pointInSolid(s, x, y, z)) return s;
    }
    return null;
  } finally {
    give(buf);
  }
}

/** XZ penetration of a disc (x,z,r) into a solid's footprint, or null if they do not overlap. */
function xzPenetration(s: CollisionSolid, x: number, z: number, r: number): { depth: number; nx: number; nz: number } | null {
  if (s.shape === 'cyl') {
    const dx = x - s.cx;
    const dz = z - s.cz;
    const rr = s.r + r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return null;
    const d = Math.sqrt(d2);
    if (d < EPS) return { depth: rr, nx: 1, nz: 0 };
    return { depth: rr - d, nx: dx / d, nz: dz / d };
  }
  const px = x < s.minX ? s.minX : x > s.maxX ? s.maxX : x;
  const pz = z < s.minZ ? s.minZ : z > s.maxZ ? s.maxZ : z;
  const dx = x - px;
  const dz = z - pz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  if (d2 > EPS * EPS) {
    const d = Math.sqrt(d2);
    return { depth: r - d, nx: dx / d, nz: dz / d };
  }
  // Centre is inside the footprint: push out through the nearest face.
  const toMaxX = s.maxX - x + r;
  const toMinX = x - s.minX + r;
  const toMaxZ = s.maxZ - z + r;
  const toMinZ = z - s.minZ + r;
  let depth = toMaxX;
  let nx = 1;
  let nz = 0;
  if (toMinX < depth) {
    depth = toMinX;
    nx = -1;
    nz = 0;
  }
  if (toMaxZ < depth) {
    depth = toMaxZ;
    nx = 0;
    nz = 1;
  }
  if (toMinZ < depth) {
    depth = toMinZ;
    nx = 0;
    nz = -1;
  }
  return { depth, nx, nz };
}

/** Does the disc (x,z,r) overlap the solid's footprint at all? */
function xzOverlaps(s: CollisionSolid, x: number, z: number, r: number): boolean {
  return xzPenetration(s, x, z, r) !== null;
}

export function capsuleOverlaps(world: World, x: number, feetY: number, z: number, r: number, h: number): boolean {
  const top = feetY + h;
  const buf = take();
  try {
    queryXZ(world, x - r, z - r, x + r, z + r, buf);
    for (const idx of buf) {
      const s = world.solids[idx]!;
      if (top <= s.minY + EPS_STRADDLE || feetY >= s.maxY - EPS_STRADDLE) continue;
      if (xzOverlaps(s, x, z, r)) return true;
    }
    return false;
  } finally {
    give(buf);
  }
}

export function overlapSolids(world: World, x: number, feetY: number, z: number, r: number, h: number): CollisionSolid[] {
  const top = feetY + h;
  const hits: CollisionSolid[] = [];
  const buf = take();
  try {
    queryXZ(world, x - r, z - r, x + r, z + r, buf);
    for (const idx of buf) {
      const s = world.solids[idx]!;
      if (top <= s.minY + EPS_STRADDLE || feetY >= s.maxY - EPS_STRADDLE) continue;
      if (xzOverlaps(s, x, z, r)) hits.push(s);
    }
    return hits;
  } finally {
    give(buf);
  }
}

// ------------------------------------------------------------------------------------------
// Support / clearance probes
// ------------------------------------------------------------------------------------------

export interface GroundHit {
  readonly y: number;
  readonly solid: CollisionSolid;
}

/**
 * Highest surface supporting the footprint (x,z,r), searching from `feetY + tol` down to
 * `feetY - maxDrop`. This is a footprint query, not a ray: standing over a lip works.
 */
export function groundUnder(
  world: World,
  x: number,
  z: number,
  feetY: number,
  r: number,
  maxDrop: number,
  tol = 0.02,
): GroundHit | null {
  const ceilY = feetY + tol;
  const floorY = feetY - maxDrop;
  let best: GroundHit | null = null;
  const buf = take();
  try {
    queryXZ(world, x - r, z - r, x + r, z + r, buf);
    for (const idx of buf) {
      const s = world.solids[idx]!;
      if (s.maxY > ceilY || s.maxY < floorY) continue;
      if (!xzOverlaps(s, x, z, r)) continue;
      if (!best || s.maxY > best.y) best = { y: s.maxY, solid: s };
    }
    return best;
  } finally {
    give(buf);
  }
}

/** Clear height above `feetY` over the footprint, capped at `maxRise`. */
export function headroom(world: World, x: number, z: number, feetY: number, r: number, maxRise: number): number {
  let best = maxRise;
  const buf = take();
  try {
    queryXZ(world, x - r, z - r, x + r, z + r, buf);
    for (const idx of buf) {
      const s = world.solids[idx]!;
      if (s.minY < feetY + EPS_STRADDLE || s.minY - feetY >= best) continue;
      if (!xzOverlaps(s, x, z, r)) continue;
      best = s.minY - feetY;
    }
    return best;
  } finally {
    give(buf);
  }
}

export interface LedgeHit {
  readonly x: number;
  readonly z: number;
  /** Surface the body would end up standing on. */
  readonly topY: number;
  /** topY - feetY. */
  readonly height: number;
  readonly solid: CollisionSolid;
}

/**
 * Mantle/vault candidate: the highest surface in front of the body between `minHeight` and
 * `maxHeight` above the feet, that a standing body actually fits on.
 * (movement.ts owns the verb; this owns the geometry question.)
 */
export function ledgeProbe(
  world: World,
  x: number,
  feetY: number,
  z: number,
  forwardX: number,
  forwardZ: number,
  r: number,
  standHeight: number,
  opts: { ahead?: number; minHeight?: number; maxHeight?: number } = {},
): LedgeHit | null {
  const ahead = opts.ahead ?? 1.0;
  const minH = opts.minHeight ?? 0.4;
  const maxH = opts.maxHeight ?? 2.2;
  const len = Math.hypot(forwardX, forwardZ);
  if (len < EPS) return null;
  const px = x + (forwardX / len) * ahead;
  const pz = z + (forwardZ / len) * ahead;
  let best: LedgeHit | null = null;
  // The clearance test below re-enters the broadphase; the pooled buffer makes that safe.
  const buf = take();
  try {
    queryXZ(world, px - r, pz - r, px + r, pz + r, buf);
    for (const idx of buf) {
      const s = world.solids[idx]!;
      const height = s.maxY - feetY;
      if (height < minH - EPS || height > maxH + EPS) continue;
      if (!xzOverlaps(s, px, pz, r)) continue;
      if (best && s.maxY <= best.topY) continue;
      if (capsuleOverlaps(world, px, s.maxY + EPS_STRADDLE * 2, pz, r, standHeight)) continue;
      best = { x: px, z: pz, topY: s.maxY, height, solid: s };
    }
    return best;
  } finally {
    give(buf);
  }
}

export function ladderAt(world: World, x: number, feetY: number, z: number, r: number, h = 0): LadderVolume | null {
  for (const l of world.ladders) {
    if (feetY + h < l.yBase - 0.1 || feetY > l.yTop + 0.4) continue;
    const px = x < l.minX ? l.minX : x > l.maxX ? l.maxX : x;
    const pz = z < l.minZ ? l.minZ : z > l.maxZ ? l.maxZ : z;
    const dx = x - px;
    const dz = z - pz;
    if (dx * dx + dz * dz <= r * r) return l;
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// Movement
// ------------------------------------------------------------------------------------------

export interface MoveResult {
  x: number;
  y: number;
  z: number;
  /** A wall pushed the body sideways this move. */
  hitWall: boolean;
  /** Accumulated (normalised) push direction of the walls hit, for slide/wall-run logic. */
  wallNX: number;
  wallNZ: number;
  /** A downward move was stopped by a surface. */
  hitGround: boolean;
  /** An upward move was stopped by a surface. */
  hitCeiling: boolean;
  /** How far the body was lifted by step-up this move (0 if none). */
  steppedUp: number;
  /** Horizontal distance actually achieved along the requested direction. */
  travelXZ: number;
  requestedXZ: number;
}

/**
 * Push a capsule out of anything it is intersecting. Horizontal first, then vertical.
 *
 * `moved` says the body was pushed at all; `resolved` says it actually ended up clear. They
 * differ where the iteration budget runs out or a body is wedged between opposed faces (a
 * crusher, a too-tight duct) — callers that must not leave a body inside geometry check
 * `resolved`, not `moved`.
 */
export function resolvePenetration(
  world: World,
  x: number,
  feetY: number,
  z: number,
  r: number,
  h: number,
  iterations = 4,
): { x: number; y: number; z: number; moved: boolean; resolved: boolean } {
  let px = x;
  let py = feetY;
  let pz = z;
  let moved = false;
  for (let i = 0; i < iterations; i++) {
    const hit = deepestXZ(world, px, py, pz, r, h);
    if (!hit) break;
    px += hit.nx * (hit.depth + EPS);
    pz += hit.nz * (hit.depth + EPS);
    moved = true;
  }
  for (let i = 0; i < iterations; i++) {
    const hit = deepestY(world, px, py, pz, r, h);
    if (!hit) break;
    py += hit.dy;
    moved = true;
  }
  return { x: px, y: py, z: pz, moved, resolved: !capsuleOverlaps(world, px, py, pz, r, h) };
}

function deepestXZ(
  world: World,
  x: number,
  feetY: number,
  z: number,
  r: number,
  h: number,
): { depth: number; nx: number; nz: number } | null {
  const top = feetY + h;
  let best: { depth: number; nx: number; nz: number } | null = null;
  const buf = take();
  try {
    queryXZ(world, x - r, z - r, x + r, z + r, buf);
    for (const idx of buf) {
      const s = world.solids[idx]!;
      if (top <= s.minY + EPS_STRADDLE || feetY >= s.maxY - EPS_STRADDLE) continue;
      const p = xzPenetration(s, x, z, r);
      if (p && (!best || p.depth > best.depth)) best = p;
    }
    return best;
  } finally {
    give(buf);
  }
}

function deepestY(world: World, x: number, feetY: number, z: number, r: number, h: number): { dy: number } | null {
  const top = feetY + h;
  let best: { dy: number } | null = null;
  const buf = take();
  try {
    queryXZ(world, x - r, z - r, x + r, z + r, buf);
    for (const idx of buf) {
      const s = world.solids[idx]!;
      if (top <= s.minY + EPS_STRADDLE || feetY >= s.maxY - EPS_STRADDLE) continue;
      if (!xzOverlaps(s, x, z, r)) continue;
      const up = s.maxY - feetY;
      const down = top - s.minY;
      const dy = up <= down ? up + EPS : -(down + EPS);
      if (!best || Math.abs(dy) > Math.abs(best.dy)) best = { dy };
    }
    return best;
  } finally {
    give(buf);
  }
}

interface SlideResult {
  x: number;
  z: number;
  hit: boolean;
  nx: number;
  nz: number;
  travel: number;
}

/** Substepped horizontal move with per-step depenetration — the classic collide-and-slide. */
function slideXZ(world: World, x: number, feetY: number, z: number, dx: number, dz: number, r: number, h: number): SlideResult {
  const len = Math.hypot(dx, dz);
  const res: SlideResult = { x, z, hit: false, nx: 0, nz: 0, travel: 0 };
  if (len < EPS) {
    for (let i = 0; i < 4; i++) {
      const p = deepestXZ(world, res.x, feetY, res.z, r, h);
      if (!p) break;
      res.x += p.nx * (p.depth + EPS);
      res.z += p.nz * (p.depth + EPS);
      res.hit = true;
      res.nx += p.nx;
      res.nz += p.nz;
    }
    return res;
  }
  const stepLen = Math.min(r * 0.8, 0.2);
  const steps = Math.max(1, Math.ceil(len / stepLen));
  const sx = dx / steps;
  const sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    res.x += sx;
    res.z += sz;
    for (let k = 0; k < 4; k++) {
      const p = deepestXZ(world, res.x, feetY, res.z, r, h);
      if (!p) break;
      res.x += p.nx * (p.depth + EPS);
      res.z += p.nz * (p.depth + EPS);
      res.hit = true;
      res.nx += p.nx;
      res.nz += p.nz;
    }
  }
  const nlen = Math.hypot(res.nx, res.nz);
  if (nlen > EPS) {
    res.nx /= nlen;
    res.nz /= nlen;
  }
  res.travel = ((res.x - x) * dx + (res.z - z) * dz) / len;
  return res;
}

/** Substepped vertical move. */
function moveY(
  world: World,
  x: number,
  feetY: number,
  z: number,
  dy: number,
  r: number,
  h: number,
): { y: number; hitGround: boolean; hitCeiling: boolean } {
  let y = feetY;
  let hitGround = false;
  let hitCeiling = false;
  if (Math.abs(dy) < EPS) {
    return { y, hitGround, hitCeiling };
  }
  const steps = Math.max(1, Math.ceil(Math.abs(dy) / 0.2));
  const sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    y += sy;
    for (let k = 0; k < 3; k++) {
      const p = deepestY(world, x, y, z, r, h);
      if (!p) break;
      y += p.dy;
      if (p.dy > 0) hitGround = true;
      else hitCeiling = true;
    }
  }
  return { y, hitGround, hitCeiling };
}

export interface MoveOptions {
  /** Max ledge the body walks up without jumping. 0 disables step-up. */
  stepUp?: number;
  /**
   * Footprint radius of the support probe. Defaults to `r * GROUND_PROBE_FRAC` — the same ring
   * the grounded check uses (const.ts), so "what step-up lands on" and "what holds you up" are
   * one answer and you cannot be stepped onto a lip you would then fall off.
   */
  probeRadius?: number;
}

/**
 * Move a capsule by `delta`, colliding and sliding. Horizontal first (so a blocked horizontal
 * move can retry lifted by `stepUp`), then vertical.
 */
export function moveCapsule(
  world: World,
  x: number,
  feetY: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  r: number,
  h: number,
  opts: MoveOptions = {},
): MoveResult {
  const stepUp = opts.stepUp ?? STEP_UP_MAX;
  const probeR = opts.probeRadius ?? r * GROUND_PROBE_FRAC;
  const requested = Math.hypot(dx, dz);
  let y = feetY;

  let flat = slideXZ(world, x, y, z, dx, dz, r, h);
  let steppedUp = 0;

  if (flat.hit && stepUp > 0 && requested > EPS && flat.travel < requested - 1e-3) {
    const raisedY = y + stepUp;
    if (!capsuleOverlaps(world, x, raisedY, z, r, h)) {
      const lifted = slideXZ(world, x, raisedY, z, dx, dz, r, h);
      if (lifted.travel > flat.travel + 1e-4) {
        const ground = groundUnder(world, lifted.x, lifted.z, raisedY, probeR, stepUp + 0.05);
        if (ground && ground.y >= y - EPS && ground.y <= raisedY + EPS) {
          steppedUp = ground.y - y;
          y = ground.y;
          flat = lifted;
        }
      }
    }
  }

  const vert = moveY(world, flat.x, y, flat.z, dy, r, h);

  return {
    x: flat.x,
    y: vert.y,
    z: flat.z,
    hitWall: flat.hit,
    wallNX: flat.nx,
    wallNZ: flat.nz,
    hitGround: vert.hitGround,
    hitCeiling: vert.hitCeiling,
    steppedUp,
    travelXZ: flat.travel,
    requestedXZ: requested,
  };
}

// ------------------------------------------------------------------------------------------
// Rays and hearing lines
// ------------------------------------------------------------------------------------------

export interface RayHit {
  readonly t: number;
  readonly solid: CollisionSolid;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /**
   * The ray started INSIDE this solid, so `t` is 0 and the normal is the reversed ray
   * direction rather than a real face. Consumers that mean "what did I hit out there" must
   * skip these; consumers that mean "am I embedded" want exactly these.
   */
  readonly inside: boolean;
}

/**
 * Entry/exit parameters of the infinite line a->b against a solid, or null if it misses.
 * t is the UNCLAMPED parameter along a->b (1 == b), so t0 < 0 means `a` is already inside the
 * solid — the fact `raycast` needs to report `inside`. Callers clamp to the span they care
 * about.
 */
function segmentInterval(
  s: CollisionSolid,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): { t0: number; t1: number } | null {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  let t0 = -Infinity;
  let t1 = Infinity;

  // y slab (shared by both shapes)
  if (Math.abs(dy) < EPS) {
    if (ay < s.minY || ay > s.maxY) return null;
  } else {
    let ty0 = (s.minY - ay) / dy;
    let ty1 = (s.maxY - ay) / dy;
    if (ty0 > ty1) [ty0, ty1] = [ty1, ty0];
    t0 = Math.max(t0, ty0);
    t1 = Math.min(t1, ty1);
    if (t0 > t1) return null;
  }

  if (s.shape === 'box') {
    for (const [a, d, lo, hi] of [
      [ax, dx, s.minX, s.maxX],
      [az, dz, s.minZ, s.maxZ],
    ] as const) {
      if (Math.abs(d) < EPS) {
        if (a < lo || a > hi) return null;
        continue;
      }
      let u0 = (lo - a) / d;
      let u1 = (hi - a) / d;
      if (u0 > u1) [u0, u1] = [u1, u0];
      t0 = Math.max(t0, u0);
      t1 = Math.min(t1, u1);
      if (t0 > t1) return null;
    }
    return { t0, t1 };
  }

  // Vertical cylinder: quadratic in XZ.
  const ox = ax - s.cx;
  const oz = az - s.cz;
  const A = dx * dx + dz * dz;
  const B = 2 * (ox * dx + oz * dz);
  const C = ox * ox + oz * oz - s.r * s.r;
  if (A < EPS) {
    if (C > 0) return null;
    return { t0, t1 };
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const u0 = (-B - sq) / (2 * A);
  const u1 = (-B + sq) / (2 * A);
  t0 = Math.max(t0, u0);
  t1 = Math.min(t1, u1);
  if (t0 > t1) return null;
  return { t0, t1 };
}

/**
 * Unit normal of the face the sample point sits on. `ux,uy,uz` is the (unit) ray direction,
 * used only for the degenerate case below — a normal must never come back zero-length, or
 * every reflection/facing test downstream silently produces NaN.
 */
function surfaceNormal(
  s: CollisionSolid,
  x: number,
  y: number,
  z: number,
  ux: number,
  uy: number,
  uz: number,
): [number, number, number] {
  if (s.shape === 'cyl') {
    if (y >= s.maxY - 1e-4) return [0, 1, 0];
    if (y <= s.minY + 1e-4) return [0, -1, 0];
    const dx = x - s.cx;
    const dz = z - s.cz;
    const d = Math.hypot(dx, dz);
    // On the axis (a ray starting inside the cylinder): there is no radial direction, so face
    // the ray that asked.
    if (d < EPS) return [-ux, -uy, -uz];
    return [dx / d, 0, dz / d];
  }
  const eps = 1e-4;
  if (Math.abs(x - s.minX) < eps) return [-1, 0, 0];
  if (Math.abs(x - s.maxX) < eps) return [1, 0, 0];
  if (Math.abs(y - s.minY) < eps) return [0, -1, 0];
  if (Math.abs(y - s.maxY) < eps) return [0, 1, 0];
  if (Math.abs(z - s.minZ) < eps) return [0, 0, -1];
  return [0, 0, 1];
}

/**
 * Nearest solid hit along a ray. A solid the origin is already inside reports a hit at t = 0
 * with `inside: true` — see `RayHit.inside`.
 */
export function raycast(
  world: World,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): RayHit | null {
  const len = Math.hypot(dx, dy, dz);
  if (len < EPS) return null;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const bx = ox + ux * maxDist;
  const by = oy + uy * maxDist;
  const bz = oz + uz * maxDist;
  const buf = take();
  let best: RayHit | null = null;
  try {
    queryXZ(world, Math.min(ox, bx), Math.min(oz, bz), Math.max(ox, bx), Math.max(oz, bz), buf);
    for (const idx of buf) {
      const s = world.solids[idx]!;
      const iv = segmentInterval(s, ox, oy, oz, bx, by, bz);
      if (!iv) continue;
      if (iv.t1 < 0 || iv.t0 > 1) continue;
      const inside = iv.t0 < 0;
      const t = inside ? 0 : iv.t0;
      const dist = t * maxDist;
      if (best && dist >= best.t) continue;
      const [nx, ny, nz] = surfaceNormal(s, ox + ux * dist, oy + uy * dist, oz + uz * dist, ux, uy, uz);
      best = { t: dist, solid: s, nx, ny, nz, inside };
    }
    return best;
  } finally {
    give(buf);
  }
}

/** True when nothing solid lies between the two points. */
export function segmentClear(
  world: World,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < EPS) return solidAt(world, ax, ay, az) === null;
  const hit = raycast(world, ax, ay, az, dx, dy, dz, len);
  return hit === null || hit.t >= len - EPS;
}

/**
 * How many distinct occluder runs the segment crosses (vision §3.4: 0 walls full, 1 wall
 * damped, >=2 nothing). Abutting or overlapping solids merge into one run, so a wall plus its
 * own door lintel is one wall, never two. Grazes shorter than OCCLUDER_MIN_CHORD are ignored.
 *
 * Reads `world.occluders`, not `world.solids`. `filter` may itself query the world — the paint
 * step does — because the candidate buffer is pooled per call, never shared.
 */
export function countWalls(
  world: World,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  filter?: (s: CollisionSolid) => boolean,
): number {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  if (len < EPS) return 0;
  const minT = OCCLUDER_MIN_CHORD / len;
  const intervals: Array<[number, number]> = [];
  const buf = take();
  try {
    queryXZ(world, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), buf);
    for (const idx of buf) {
      const s = world.occluders[idx]!;
      if (filter && !filter(s)) continue;
      const iv = segmentInterval(s, ax, ay, az, bx, by, bz);
      if (!iv) continue;
      const t0 = Math.max(0, iv.t0);
      const t1 = Math.min(1, iv.t1);
      if (t1 - t0 < minT) continue;
      intervals.push([t0, t1]);
    }
  } finally {
    give(buf);
  }
  if (intervals.length === 0) return 0;
  intervals.sort((p, q) => p[0] - q[0]);
  let runs = 1;
  let end = intervals[0]![1];
  for (let i = 1; i < intervals.length; i++) {
    const [t0, t1] = intervals[i]!;
    if (t0 > end + 1e-6) runs++;
    if (t1 > end) end = t1;
  }
  return runs;
}

// ------------------------------------------------------------------------------------------
// Air volumes (input to the surfel bake — engine-plan §3 "cull faces buried inside other solids")
// ------------------------------------------------------------------------------------------

export function insideAir(world: World, x: number, y: number, z: number): boolean {
  for (const a of world.air) {
    if (x >= a.min[0] && x <= a.max[0] && y >= a.min[1] && y <= a.max[1] && z >= a.min[2] && z <= a.max[2]) return true;
  }
  return false;
}
