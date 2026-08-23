/**
 * Surfel bake — the painted world's data (engine-plan §3).
 *
 * The world is black. The only thing a look can ever draw is a surfel that some sound has lit,
 * so this file decides, once at load, WHERE a dot may exist at all. Nothing here knows about
 * sound: it produces the lattice, the crease lines and the acceleration structures, and hands
 * `paintTime` / `paintIntensity` buffers to `core/paint.ts` to write into.
 *
 * Three laws shape every decision below:
 * - vision §1.3 "absence is black": a face buried inside another solid is not a surface anyone
 *   could ever hear, so it must not exist. Culled at bake time, not at draw time.
 * - visual-brief §2 "structural lattice": the grid is world-axis and absolute, so the SAME world
 *   position is the SAME dot with the SAME dither forever — across faces, across rescans, across
 *   runs. Nothing here may depend on a solid's own local frame.
 * - vision §5 "dots are matter, lines are holds": creases become line segments, and the subset a
 *   body could actually grab, stand on or duck under is flagged `hold`. A line that promises a
 *   traversal the movement code refuses is the system lying (§1.2), so the classifier below is
 *   deliberately conservative.
 *
 * Cost: the bake walks every face of every solid at SURFEL_SPACING. It runs once, behind the
 * "baking lattice…" boot screen, and reports its counts (`BakeCounts`) for the F3 overlay and
 * the budget assertion in test/surfels.spec.ts (vision §12: ~1 M point ceiling).
 */

import { BufferAttribute, BufferGeometry, DynamicDrawUsage } from 'three';
import {
  CAPSULE_RADIUS,
  CREASE_PROBE,
  EDGE_SEG_MAX,
  FACE_PROBE,
  HASH_CELL,
  HEIGHT_STAND,
  HOLD_DROP_SCAN,
  HOLD_MAX_STEP,
  HOLD_MIN_CLEARANCE,
  HOLD_MIN_STEP,
  LADDER_RUNG_SPACING,
  PATCH_SIZE,
  SURFEL_SPACING,
} from './const.js';
import { dither3i, latticeCentre, latticeFirstAtOrAfter } from './math.js';
import {
  groundUnder,
  insideAir,
  pointInSolid,
  queryXZ,
  type CollisionSolid,
  type World,
} from './map/build.js';

/** `paintTime` for a surfel no sound has ever reached. Any age computed from it is astronomical. */
export const UNPAINTED = -1e9;

/**
 * Dither quantisation. Dither is a stable hash of the LATTICE CELL, and a face plane is an
 * arbitrary real (x = 23.6, y = 3.5, …), so the hash key is the world position quantised eight
 * times finer than the lattice: lattice centres land on exact integers of this grid, and two
 * coplanar faces at the same world position therefore hash identically. Coarser and two
 * neighbouring dots would share a dither; finer and float noise would break the "same position ⇒
 * same dot" law.
 */
const DITHER_Q = SURFEL_SPACING / 8;

/**
 * How far a patch's line-of-sight probe is pushed off the surface it sits on (see `patchProbe`).
 * Twice the bake's own exposure probe: far enough that no float slop can leave the ray origin
 * inside the face, small enough that it cannot hop a gap into a neighbouring solid.
 */
const PROBE_LIFT = FACE_PROBE * 2;

/** Stable [0,1) dither for a world position on the lattice (visual-brief §2). */
export const surfelDither = (x: number, y: number, z: number): number =>
  dither3i(Math.round(x / DITHER_Q), Math.round(y / DITHER_Q), Math.round(z / DITHER_Q));

export interface BakeCounts {
  /** Dots. */
  readonly surfels: number;
  /** Line segments (2 vertices each). */
  readonly edges: number;
  /** Of those segments, how many are flagged `hold`. */
  readonly holds: number;
  readonly patches: number;
  /** Lattice samples tested — the bake's real cost, most of which are culled. */
  readonly samples: number;
  readonly ms: number;
}

// ------------------------------------------------------------------------------------------
// Bake-time scratch
// ------------------------------------------------------------------------------------------

interface RawEdge {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  hold: boolean;
}

/** The six axis-aligned faces of a box, as (axis, sign) pairs. axis 0=x, 1=y, 2=z. */
const FACES: ReadonlyArray<readonly [0 | 1 | 2, 1 | -1]> = [
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [2, 1],
  [2, -1],
];

/** Does an AABB touch any authored air volume? Whole-face early-out for the exposure test. */
function boxTouchesAir(
  world: World,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  for (const a of world.air) {
    if (bx < a.min[0] || ax > a.max[0]) continue;
    if (by < a.min[1] || ay > a.max[1]) continue;
    if (bz < a.min[2] || az > a.max[2]) continue;
    return true;
  }
  return false;
}

/**
 * The bake's one exposure predicate: a point is FREE when it is inside authored playable air
 * and inside no solid. Air is what makes "outside the level" black — the underside of the floor
 * slab and the outside of the shell are not buried in anything, and without the air test they
 * would bake a second full-map lattice nobody can ever hear.
 */
function isFree(
  world: World,
  x: number,
  y: number,
  z: number,
  cand: readonly number[],
  skip: number,
): boolean {
  if (!insideAir(world, x, y, z)) return false;
  for (const idx of cand) {
    if (idx === skip) continue;
    if (pointInSolid(world.solids[idx]!, x, y, z)) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------------
// The baked field
// ------------------------------------------------------------------------------------------

export class SurfelField {
  /** Dots. */
  readonly count: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly dither: Float32Array;
  readonly paintTime: Float32Array;
  readonly paintIntensity: Float32Array;

  /** Line segments: `edgeCount` segments, 2 vertices each. */
  readonly edgeCount: number;
  readonly edgePositions: Float32Array;
  readonly edgeDither: Float32Array;
  /** 1 = hold (vision §5), 0 = plain crease. Per vertex, so a look can read it in the shader. */
  readonly edgeHold: Float32Array;
  readonly edgePaintTime: Float32Array;
  readonly edgePaintIntensity: Float32Array;

  /**
   * Patch table (engine-plan §3): PATCH_SIZE clusters, each owning one contiguous run of dots
   * AND one contiguous run of segments, so a single line-of-sight raycast per patch serves both
   * buffers. Patches are ordered floor-major then Morton within the floor, so a sound's
   * footprint maps to a handful of contiguous index runs — which is what makes ranged buffer
   * uploads worth doing at all.
   */
  readonly patchCount: number;
  readonly patchCentre: Float32Array;
  readonly patchRadius: Float32Array;
  /**
   * Where paint's one-raycast-per-patch line of sight is measured FROM (engine-plan §3 step 2).
   *
   * Not the centroid. A patch is a 1 m cube and a corner patch mixes floor dots with wall dots,
   * so its centroid routinely lands INSIDE the solid those dots sit on — and a ray that starts
   * inside a wall counts that wall, every time, for every patch. The whole map reads as occluded
   * from itself and the world stays black no matter how loud you are.
   *
   * This is instead the patch's most central DOT pushed PROBE_LIFT out along its own normal. The
   * bake already proved that point is in free air (that is what `isFree` tested to admit the dot
   * at all), so the ray always starts outside and the only solids it can cross are genuinely
   * between the patch and the sound.
   */
  readonly patchProbe: Float32Array;
  /**
   * The smallest dither any member of the patch carries. A patch cannot light a single dot unless
   * some dot's `intensity × falloff` clears its dither, so paint skips the whole patch — LOS
   * raycast included — when even its most eager member cannot pass. Pure pruning; changes no
   * pixel.
   */
  readonly patchMinDither: Float32Array;
  readonly patchDotStart: Uint32Array;
  readonly patchDotCount: Uint32Array;
  readonly patchSegStart: Uint32Array;
  readonly patchSegCount: Uint32Array;

  readonly counts: BakeCounts;

  /** Uniform HASH_CELL grid over patch centres (CSR: `cellStart` indexes into `cellItems`). */
  private readonly hx0: number;
  private readonly hy0: number;
  private readonly hz0: number;
  private readonly hnx: number;
  private readonly hny: number;
  private readonly hnz: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  /** Largest patch radius — how far a query AABB must be grown so no patch is missed. */
  private readonly maxPatchRadius: number;

  readonly geometry: BufferGeometry;
  readonly edgeGeometry: BufferGeometry;

  /** How many dots / edge vertices have ever been lit (F3 "painted count"). */
  paintedDots = 0;
  paintedEdgeVerts = 0;

  constructor(init: {
    positions: Float32Array;
    normals: Float32Array;
    dither: Float32Array;
    edgePositions: Float32Array;
    edgeDither: Float32Array;
    edgeHold: Float32Array;
    patchCentre: Float32Array;
    patchRadius: Float32Array;
    patchProbe: Float32Array;
    patchMinDither: Float32Array;
    patchDotStart: Uint32Array;
    patchDotCount: Uint32Array;
    patchSegStart: Uint32Array;
    patchSegCount: Uint32Array;
    bounds: World['bounds'];
    counts: Omit<BakeCounts, 'patches'>;
  }) {
    this.positions = init.positions;
    this.normals = init.normals;
    this.dither = init.dither;
    this.count = init.dither.length;
    this.paintTime = new Float32Array(this.count).fill(UNPAINTED);
    this.paintIntensity = new Float32Array(this.count);

    this.edgePositions = init.edgePositions;
    this.edgeDither = init.edgeDither;
    this.edgeHold = init.edgeHold;
    this.edgeCount = init.edgeDither.length / 2;
    this.edgePaintTime = new Float32Array(init.edgeDither.length).fill(UNPAINTED);
    this.edgePaintIntensity = new Float32Array(init.edgeDither.length);

    this.patchCentre = init.patchCentre;
    this.patchRadius = init.patchRadius;
    this.patchProbe = init.patchProbe;
    this.patchMinDither = init.patchMinDither;
    this.patchDotStart = init.patchDotStart;
    this.patchDotCount = init.patchDotCount;
    this.patchSegStart = init.patchSegStart;
    this.patchSegCount = init.patchSegCount;
    this.patchCount = init.patchRadius.length;
    this.counts = { ...init.counts, patches: this.patchCount };

    // --- spatial hash over patch centres -------------------------------------------------
    const b = init.bounds;
    this.hx0 = Math.floor(b.minX / HASH_CELL) - 1;
    this.hy0 = Math.floor(b.minY / HASH_CELL) - 1;
    this.hz0 = Math.floor(b.minZ / HASH_CELL) - 1;
    this.hnx = Math.floor(b.maxX / HASH_CELL) - this.hx0 + 2;
    this.hny = Math.floor(b.maxY / HASH_CELL) - this.hy0 + 2;
    this.hnz = Math.floor(b.maxZ / HASH_CELL) - this.hz0 + 2;
    const cells = this.hnx * this.hny * this.hnz;
    const counts = new Int32Array(cells);
    const cellOf = (p: number): number => {
      const ix = clampInt(Math.floor(this.patchCentre[p * 3] / HASH_CELL) - this.hx0, 0, this.hnx - 1);
      const iy = clampInt(Math.floor(this.patchCentre[p * 3 + 1] / HASH_CELL) - this.hy0, 0, this.hny - 1);
      const iz = clampInt(Math.floor(this.patchCentre[p * 3 + 2] / HASH_CELL) - this.hz0, 0, this.hnz - 1);
      return (iy * this.hnz + iz) * this.hnx + ix;
    };
    for (let p = 0; p < this.patchCount; p++) counts[cellOf(p)]++;
    this.cellStart = new Int32Array(cells + 1);
    for (let c = 0; c < cells; c++) this.cellStart[c + 1] = this.cellStart[c] + counts[c];
    this.cellItems = new Int32Array(this.patchCount);
    const cursor = this.cellStart.slice(0, cells);
    for (let p = 0; p < this.patchCount; p++) this.cellItems[cursor[cellOf(p)]++] = p;
    let maxR = 0;
    for (let p = 0; p < this.patchCount; p++) if (this.patchRadius[p] > maxR) maxR = this.patchRadius[p];
    this.maxPatchRadius = maxR;

    // --- geometry ------------------------------------------------------------------------
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('dither', new BufferAttribute(this.dither, 1));
    this.geometry.setAttribute('paintTime', dynamic(this.paintTime));
    this.geometry.setAttribute('paintIntensity', dynamic(this.paintIntensity));
    this.geometry.setDrawRange(0, this.count);
    this.geometry.boundingSphere = null;
    this.geometry.boundingBox = null;

    this.edgeGeometry = new BufferGeometry();
    this.edgeGeometry.setAttribute('position', new BufferAttribute(this.edgePositions, 3));
    this.edgeGeometry.setAttribute('dither', new BufferAttribute(this.edgeDither, 1));
    this.edgeGeometry.setAttribute('flagsHold', new BufferAttribute(this.edgeHold, 1));
    this.edgeGeometry.setAttribute('paintTime', dynamic(this.edgePaintTime));
    this.edgeGeometry.setAttribute('paintIntensity', dynamic(this.edgePaintIntensity));
    this.edgeGeometry.setDrawRange(0, this.edgeCount * 2);
  }

  /**
   * Patches whose sphere reaches within `radius` of the point. The hash holds each patch under
   * its CENTRE's cell, so the cell sweep is grown by the largest patch radius — a patch is never
   * missed because its members hang outside its own cell.
   */
  queryPatches(x: number, y: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const grow = radius + this.maxPatchRadius;
    const ix0 = clampInt(Math.floor((x - grow) / HASH_CELL) - this.hx0, 0, this.hnx - 1);
    const ix1 = clampInt(Math.floor((x + grow) / HASH_CELL) - this.hx0, 0, this.hnx - 1);
    const iy0 = clampInt(Math.floor((y - grow) / HASH_CELL) - this.hy0, 0, this.hny - 1);
    const iy1 = clampInt(Math.floor((y + grow) / HASH_CELL) - this.hy0, 0, this.hny - 1);
    const iz0 = clampInt(Math.floor((z - grow) / HASH_CELL) - this.hz0, 0, this.hnz - 1);
    const iz1 = clampInt(Math.floor((z + grow) / HASH_CELL) - this.hz0, 0, this.hnz - 1);
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const row = (iy * this.hnz + iz) * this.hnx;
        const from = this.cellStart[row + ix0];
        const to = this.cellStart[row + ix1 + 1];
        for (let k = from; k < to; k++) {
          const p = this.cellItems[k];
          const dx = this.patchCentre[p * 3] - x;
          const dy = this.patchCentre[p * 3 + 1] - y;
          const dz = this.patchCentre[p * 3 + 2] - z;
          const reach = radius + this.patchRadius[p];
          if (dx * dx + dy * dy + dz * dz <= reach * reach) out.push(p);
        }
      }
    }
    return out;
  }

  /** Wipe every painted surfel back to black. Run restarts only — paint persists otherwise. */
  resetPaint(): void {
    this.paintTime.fill(UNPAINTED);
    this.paintIntensity.fill(0);
    this.edgePaintTime.fill(UNPAINTED);
    this.edgePaintIntensity.fill(0);
    this.paintedDots = 0;
    this.paintedEdgeVerts = 0;
    for (const g of [this.geometry, this.edgeGeometry]) {
      for (const name of ['paintTime', 'paintIntensity']) {
        const a = g.getAttribute(name) as BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, a.array.length);
        a.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.edgeGeometry.dispose();
  }
}

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function dynamic(array: Float32Array): BufferAttribute {
  const a = new BufferAttribute(array, 1);
  a.setUsage(DynamicDrawUsage);
  return a;
}

// ------------------------------------------------------------------------------------------
// Bake
// ------------------------------------------------------------------------------------------

/**
 * Build the lattice for a world. Reads `world` — which for a running game is `sim.world`, the
 * Sim's OWN clone of the map def (engine-plan §11.1), never the imported module constant.
 */
export function bakeSurfels(world: World): SurfelField {
  const t0 = clockMs();

  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const nx: number[] = [];
  const ny: number[] = [];
  const nz: number[] = [];
  const edges: RawEdge[] = [];
  let samples = 0;

  const walkableSolids = new Set<number>();
  for (const w of world.walkables) walkableSolids.add(w.solid.index);

  /**
   * Faces that share a plane can both be exposed at the same world position (two flush slabs,
   * a wall and its own lintel). The lattice is absolute, so those would be the SAME dot twice.
   * Planes are keyed exactly once here and only the shared ones pay for an occupancy set.
   */
  const planeOccupancy = new Map<string, Set<number>>();
  const planeSeen = new Map<string, number>();
  for (const s of world.solids) {
    for (const [axis, sign] of FACES) {
      const k = planeKey(s, axis, sign);
      planeSeen.set(k, (planeSeen.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of planeSeen) if (n > 1) planeOccupancy.set(k, new Set<number>());

  const cand: number[] = [];

  for (const s of world.solids) {
    if (s.shape === 'box') {
      for (const [axis, sign] of FACES) {
        samples += bakeBoxFace(world, s, axis, sign, cand, planeOccupancy, px, py, pz, nx, ny, nz);
      }
      bakeBoxEdges(world, s, walkableSolids, edges);
    } else {
      samples += bakeCylinder(world, s, cand, px, py, pz, nx, ny, nz);
      bakeCylinderRims(world, s, walkableSolids, edges);
    }
  }

  bakeLadders(world, edges);
  samples += bakeChains(world, px, py, pz, nx, ny, nz);

  // --- pack into patch-ordered typed arrays ------------------------------------------------
  const dotCount = px.length;
  const patches = new PatchBuilder();
  for (let i = 0; i < dotCount; i++) patches.addDot(i, px[i], py[i], pz[i]);
  for (let e = 0; e < edges.length; e++) {
    const s = edges[e];
    patches.addSeg(e, (s.x0 + s.x1) * 0.5, (s.y0 + s.y1) * 0.5, (s.z0 + s.z1) * 0.5);
  }
  const packed = patches.pack();

  const positions = new Float32Array(dotCount * 3);
  const normals = new Float32Array(dotCount * 3);
  const dither = new Float32Array(dotCount);
  for (let o = 0; o < dotCount; o++) {
    const i = packed.dotOrder[o];
    positions[o * 3] = px[i];
    positions[o * 3 + 1] = py[i];
    positions[o * 3 + 2] = pz[i];
    normals[o * 3] = nx[i];
    normals[o * 3 + 1] = ny[i];
    normals[o * 3 + 2] = nz[i];
    dither[o] = surfelDither(px[i], py[i], pz[i]);
  }

  const segCount = edges.length;
  const edgePositions = new Float32Array(segCount * 6);
  const edgeDither = new Float32Array(segCount * 2);
  const edgeHold = new Float32Array(segCount * 2);
  let holds = 0;
  for (let o = 0; o < segCount; o++) {
    const e = edges[packed.segOrder[o]];
    edgePositions[o * 6] = e.x0;
    edgePositions[o * 6 + 1] = e.y0;
    edgePositions[o * 6 + 2] = e.z0;
    edgePositions[o * 6 + 3] = e.x1;
    edgePositions[o * 6 + 4] = e.y1;
    edgePositions[o * 6 + 5] = e.z1;
    edgeDither[o * 2] = surfelDither(e.x0, e.y0, e.z0);
    edgeDither[o * 2 + 1] = surfelDither(e.x1, e.y1, e.z1);
    edgeHold[o * 2] = e.hold ? 1 : 0;
    edgeHold[o * 2 + 1] = e.hold ? 1 : 0;
    if (e.hold) holds++;
  }

  // Patch spheres: centre on the members' centroid, radius out to the furthest member (plus a
  // segment's half-length, since a segment is filed under its midpoint).
  const patchCentre = new Float32Array(packed.patchCount * 3);
  const patchRadius = new Float32Array(packed.patchCount);
  const patchProbe = new Float32Array(packed.patchCount * 3);
  const patchMinDither = new Float32Array(packed.patchCount).fill(1);
  for (let p = 0; p < packed.patchCount; p++) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let n = 0;
    const d0 = packed.patchDotStart[p];
    const d1 = d0 + packed.patchDotCount[p];
    for (let i = d0; i < d1; i++) {
      cx += positions[i * 3];
      cy += positions[i * 3 + 1];
      cz += positions[i * 3 + 2];
      n++;
    }
    const s0 = packed.patchSegStart[p];
    const s1 = s0 + packed.patchSegCount[p];
    for (let i = s0; i < s1; i++) {
      cx += (edgePositions[i * 6] + edgePositions[i * 6 + 3]) * 0.5;
      cy += (edgePositions[i * 6 + 1] + edgePositions[i * 6 + 4]) * 0.5;
      cz += (edgePositions[i * 6 + 2] + edgePositions[i * 6 + 5]) * 0.5;
      n++;
    }
    if (n === 0) continue;
    cx /= n;
    cy /= n;
    cz /= n;
    let r2 = 0;
    for (let i = d0; i < d1; i++) {
      const dx = positions[i * 3] - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    for (let i = s0; i < s1; i++) {
      for (const v of [0, 3]) {
        const dx = edgePositions[i * 6 + v] - cx;
        const dy = edgePositions[i * 6 + v + 1] - cy;
        const dz = edgePositions[i * 6 + v + 2] - cz;
        r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
      }
    }
    patchCentre[p * 3] = cx;
    patchCentre[p * 3 + 1] = cy;
    patchCentre[p * 3 + 2] = cz;
    patchRadius[p] = Math.sqrt(r2);

    // LOS probe: the dot nearest the centroid, lifted off its own face into the air the bake
    // already proved is there. A patch with no dots (a bare crease, a ladder) falls back to its
    // first segment's midpoint — a crease is a silhouette, so it is exposed by construction too.
    let best = -1;
    let bestD2 = Infinity;
    for (let i = d0; i < d1; i++) {
      const dx = positions[i * 3] - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bestD2) {
        bestD2 = dd;
        best = i;
      }
    }
    if (best >= 0) {
      patchProbe[p * 3] = positions[best * 3] + normals[best * 3] * PROBE_LIFT;
      patchProbe[p * 3 + 1] = positions[best * 3 + 1] + normals[best * 3 + 1] * PROBE_LIFT;
      patchProbe[p * 3 + 2] = positions[best * 3 + 2] + normals[best * 3 + 2] * PROBE_LIFT;
    } else {
      patchProbe[p * 3] = (edgePositions[s0 * 6] + edgePositions[s0 * 6 + 3]) * 0.5;
      patchProbe[p * 3 + 1] = (edgePositions[s0 * 6 + 1] + edgePositions[s0 * 6 + 4]) * 0.5;
      patchProbe[p * 3 + 2] = (edgePositions[s0 * 6 + 2] + edgePositions[s0 * 6 + 5]) * 0.5;
    }

    let minD = 1;
    for (let i = d0; i < d1; i++) if (dither[i] < minD) minD = dither[i];
    for (let i = s0 * 2; i < s1 * 2; i++) if (edgeDither[i] < minD) minD = edgeDither[i];
    patchMinDither[p] = minD;
  }

  return new SurfelField({
    positions,
    normals,
    dither,
    edgePositions,
    edgeDither,
    edgeHold,
    patchCentre,
    patchRadius,
    patchProbe,
    patchMinDither,
    patchDotStart: packed.patchDotStart,
    patchDotCount: packed.patchDotCount,
    patchSegStart: packed.patchSegStart,
    patchSegCount: packed.patchSegCount,
    bounds: world.bounds,
    counts: { surfels: dotCount, edges: segCount, holds, samples, ms: clockMs() - t0 },
  });
}

/** Wall-clock only for the boot report; never read inside a sim step (test/sim.spec.ts). */
const clockMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0;

const planeKey = (s: CollisionSolid, axis: 0 | 1 | 2, sign: 1 | -1): string => {
  const p = facePlane(s, axis, sign);
  return `${axis}${sign > 0 ? '+' : '-'}:${Math.round(p / DITHER_Q)}`;
};

function facePlane(s: CollisionSolid, axis: 0 | 1 | 2, sign: 1 | -1): number {
  if (axis === 0) return sign > 0 ? s.maxX : s.minX;
  if (axis === 1) return sign > 0 ? s.maxY : s.minY;
  return sign > 0 ? s.maxZ : s.minZ;
}

// ------------------------------------------------------------------------------------------
// Box faces
// ------------------------------------------------------------------------------------------

function bakeBoxFace(
  world: World,
  s: CollisionSolid,
  axis: 0 | 1 | 2,
  sign: 1 | -1,
  cand: number[],
  planeOccupancy: Map<string, Set<number>>,
  px: number[],
  py: number[],
  pz: number[],
  nx: number[],
  ny: number[],
  nz: number[],
): number {
  const plane = facePlane(s, axis, sign);
  const probe = plane + sign * FACE_PROBE;
  // Tangent axes, in ascending axis order so the lattice is walked the same way everywhere.
  const u = axis === 0 ? 1 : 0;
  const v = axis === 2 ? 1 : 2;
  const lo = [s.minX, s.minY, s.minZ];
  const hi = [s.maxX, s.maxY, s.maxZ];

  // Whole-face early-out: a face whose probe slab touches no authored air is outside the level
  // (the top of the ceiling, the underside of the floor, the back of the shell).
  const pmin = [lo[0], lo[1], lo[2]];
  const pmax = [hi[0], hi[1], hi[2]];
  pmin[axis] = Math.min(plane, probe);
  pmax[axis] = Math.max(plane, probe);
  if (!boxTouchesAir(world, pmin[0], pmin[1], pmin[2], pmax[0], pmax[1], pmax[2])) return 0;

  queryXZ(
    world,
    pmin[0] - FACE_PROBE,
    pmin[2] - FACE_PROBE,
    pmax[0] + FACE_PROBE,
    pmax[2] + FACE_PROBE,
    cand,
  );
  const occ = planeOccupancy.get(planeKey(s, axis, sign));

  const n = [0, 0, 0];
  n[axis] = sign;
  const p = [0, 0, 0];
  p[axis] = plane;
  const probePt = [0, 0, 0];
  probePt[axis] = probe;

  let tested = 0;
  for (let iu = latticeFirstAtOrAfter(lo[u], SURFEL_SPACING); ; iu++) {
    const cu = latticeCentre(iu, SURFEL_SPACING);
    if (cu > hi[u]) break;
    for (let iv = latticeFirstAtOrAfter(lo[v], SURFEL_SPACING); ; iv++) {
      const cv = latticeCentre(iv, SURFEL_SPACING);
      if (cv > hi[v]) break;
      tested++;
      probePt[u] = cu;
      probePt[v] = cv;
      if (!isFree(world, probePt[0], probePt[1], probePt[2], cand, s.index)) continue;
      if (occ) {
        const key = (iu + 0x8000) * 0x10000 + (iv + 0x8000);
        if (occ.has(key)) continue;
        occ.add(key);
      }
      p[u] = cu;
      p[v] = cv;
      px.push(p[0]);
      py.push(p[1]);
      pz.push(p[2]);
      nx.push(n[0]);
      ny.push(n[1]);
      nz.push(n[2]);
    }
  }
  return tested;
}

// ------------------------------------------------------------------------------------------
// Box creases -> line segments (vision §5 "dots are matter, lines are holds")
// ------------------------------------------------------------------------------------------

/** The 12 edges of a box: the two face axes that meet, plus the sign of each. */
const BOX_EDGES: ReadonlyArray<readonly [0 | 1 | 2, 1 | -1, 0 | 1 | 2, 1 | -1]> = [
  [0, 1, 1, 1],
  [0, 1, 1, -1],
  [0, -1, 1, 1],
  [0, -1, 1, -1],
  [0, 1, 2, 1],
  [0, 1, 2, -1],
  [0, -1, 2, 1],
  [0, -1, 2, -1],
  [1, 1, 2, 1],
  [1, 1, 2, -1],
  [1, -1, 2, 1],
  [1, -1, 2, -1],
];

function bakeBoxEdges(world: World, s: CollisionSolid, walkableSolids: Set<number>, out: RawEdge[]): void {
  const lo = [s.minX, s.minY, s.minZ];
  const hi = [s.maxX, s.maxY, s.maxZ];
  for (const [axisA, signA, axisB, signB] of BOX_EDGES) {
    // The free axis is the one neither face owns: the direction the crease runs.
    const t = (3 - axisA - axisB) as 0 | 1 | 2;
    const na = [0, 0, 0];
    na[axisA] = signA;
    const nb = [0, 0, 0];
    nb[axisB] = signB;
    const base = [0, 0, 0];
    base[axisA] = facePlane(s, axisA, signA);
    base[axisB] = facePlane(s, axisB, signB);
    emitCrease(world, s, base, t, lo[t], hi[t], na, nb, walkableSolids, out);
  }
}

/**
 * Subdivide one crease to <= EDGE_SEG_MAX and keep the pieces whose corner is genuinely open.
 *
 * The test is a three-probe quadrant read at each piece's midpoint: the air just outside face A,
 * the air just outside face B, and the air diagonally outside both. All three free ⇒ a real
 * silhouette crease. It rejects the junction where two solids meet flush (one probe lands inside
 * the neighbour) and the concave corner where a wall meets the floor (ditto), while keeping door
 * jambs, the pit lip, the duct lip and every column silhouette.
 */
function emitCrease(
  world: World,
  s: CollisionSolid,
  base: readonly number[],
  t: 0 | 1 | 2,
  t0: number,
  t1: number,
  na: readonly number[],
  nb: readonly number[],
  walkableSolids: Set<number>,
  out: RawEdge[],
): void {
  const len = t1 - t0;
  if (len <= 1e-6) return;
  const pieces = Math.max(1, Math.ceil(len / EDGE_SEG_MAX));
  const step = len / pieces;
  const a = [base[0], base[1], base[2]];
  const b = [base[0], base[1], base[2]];
  const probe = [0, 0, 0];
  const E = CREASE_PROBE;
  for (let k = 0; k < pieces; k++) {
    const m = t0 + step * (k + 0.5);
    let open = true;
    for (const [qa, qb] of [
      [1, 1],
      [1, -1],
      [-1, 1],
    ] as const) {
      probe[0] = base[0] + na[0] * E * qa + nb[0] * E * qb;
      probe[1] = base[1] + na[1] * E * qa + nb[1] * E * qb;
      probe[2] = base[2] + na[2] * E * qa + nb[2] * E * qb;
      probe[t] = m;
      if (!insideAir(world, probe[0], probe[1], probe[2])) {
        open = false;
        break;
      }
      if (solidAtSkipping(world, probe[0], probe[1], probe[2], s.index)) {
        open = false;
        break;
      }
    }
    if (!open) continue;
    a[t] = t0 + step * k;
    b[t] = t0 + step * (k + 1);
    out.push({
      x0: a[0],
      y0: a[1],
      z0: a[2],
      x1: b[0],
      y1: b[1],
      z1: b[2],
      hold: classifyHold(world, s, base, t, m, na, nb, walkableSolids),
    });
  }
}

function solidAtSkipping(world: World, x: number, y: number, z: number, skip: number): boolean {
  const buf: number[] = scratchQuery;
  queryXZ(world, x, z, x, z, buf);
  for (const idx of buf) {
    if (idx === skip) continue;
    if (pointInSolid(world.solids[idx]!, x, y, z)) return true;
  }
  return false;
}
const scratchQuery: number[] = [];

/**
 * Which creases are holds (vision §5, engine-plan §3).
 *
 * TOP edges (one face points up) are holds when the drop to the surface a body would be standing
 * on is at least HOLD_MIN_STEP and either within reach (HOLD_MAX_STEP) or the top itself is
 * somewhere a body can stand. That second clause is what reconciles engine-plan §3's own list —
 * it names "shelf/catwalk/beam lips" as holds, and the catwalk (3.5), high shelf (3.3), gantry
 * beam (4.2) and pit lip (2.8) all sit past HOLD_MAX_STEP. HOLD_MAX_STEP still does its job on
 * everything that is NOT a standing surface: a random 3 m ledge stays scenery.
 *
 * BOTTOM edges (one face points down) are the overhead lips — the duct. A body uses one by
 * ducking or sliding under it, so the gap has to be big enough to fit through
 * (HOLD_MIN_CLEARANCE) and low enough that going under it is a decision (HEIGHT_STAND). A 2.4 m
 * door lintel is above standing height: it is a doorway, not an affordance, and stays a plain
 * crease.
 *
 * VERTICAL creases are never holds. Nothing in the movement set grabs one.
 */
function classifyHold(
  world: World,
  s: CollisionSolid,
  base: readonly number[],
  t: 0 | 1 | 2,
  m: number,
  na: readonly number[],
  nb: readonly number[],
  walkableSolids: Set<number>,
): boolean {
  const up = na[1] === 1 ? na : nb[1] === 1 ? nb : null;
  const down = na[1] === -1 ? na : nb[1] === -1 ? nb : null;
  if (!up && !down) return false;
  const horiz = up ? (na === up ? nb : na) : na[1] === 0 ? na : nb;
  const lipY = base[1];
  // Stand off the lip by a capsule radius: the drop that matters is the one a body standing
  // beside the edge would fall down, not the face of the solid itself.
  const qx = base[0] + horiz[0] * CAPSULE_RADIUS;
  const qz = base[2] + horiz[2] * CAPSULE_RADIUS;
  const px = t === 0 ? m : qx;
  const pz = t === 2 ? m : qz;
  const g = groundUnder(world, px, pz, lipY - 0.05, 0.08, HOLD_DROP_SCAN);
  const drop = lipY - (g ? g.y : lipY - HOLD_DROP_SCAN);
  if (up) return drop >= HOLD_MIN_STEP && (drop <= HOLD_MAX_STEP || walkableSolids.has(s.index));
  return drop >= HOLD_MIN_CLEARANCE && drop <= HEIGHT_STAND;
}

// ------------------------------------------------------------------------------------------
// Cylinders
// ------------------------------------------------------------------------------------------

/**
 * A vertical cylinder still has to obey the world-axis lattice, so its side is walked as four
 * arcs: where the surface faces mostly +/-z the lattice runs along x and z is solved from the
 * circle, and vice versa. The split at r/sqrt(2) is where the two families swap, and together
 * they cover the full circumference at a spacing between SURFEL_SPACING and SURFEL_SPACING*√2.
 */
function bakeCylinder(
  world: World,
  s: CollisionSolid,
  cand: number[],
  px: number[],
  py: number[],
  pz: number[],
  nx: number[],
  ny: number[],
  nz: number[],
): number {
  let tested = 0;
  queryXZ(world, s.minX - FACE_PROBE, s.minZ - FACE_PROBE, s.maxX + FACE_PROBE, s.maxZ + FACE_PROBE, cand);
  const split = s.r / Math.SQRT2;

  const put = (x: number, y: number, z: number, ax: number, ay: number, az: number): void => {
    tested++;
    if (!isFree(world, x + ax * FACE_PROBE, y + ay * FACE_PROBE, z + az * FACE_PROBE, cand, s.index)) return;
    px.push(x);
    py.push(y);
    pz.push(z);
    nx.push(ax);
    ny.push(ay);
    nz.push(az);
  };

  for (let iy = latticeFirstAtOrAfter(s.minY, SURFEL_SPACING); ; iy++) {
    const y = latticeCentre(iy, SURFEL_SPACING);
    if (y > s.maxY) break;
    for (let i = latticeFirstAtOrAfter(s.cx - split, SURFEL_SPACING); ; i++) {
      const x = latticeCentre(i, SURFEL_SPACING);
      if (x > s.cx + split) break;
      const dx = x - s.cx;
      const dz = Math.sqrt(Math.max(0, s.r * s.r - dx * dx));
      put(x, y, s.cz + dz, dx / s.r, 0, dz / s.r);
      put(x, y, s.cz - dz, dx / s.r, 0, -dz / s.r);
    }
    for (let k = latticeFirstAtOrAfter(s.cz - split, SURFEL_SPACING); ; k++) {
      const z = latticeCentre(k, SURFEL_SPACING);
      if (z > s.cz + split) break;
      const dz = z - s.cz;
      const dx = Math.sqrt(Math.max(0, s.r * s.r - dz * dz));
      put(s.cx + dx, y, z, dx / s.r, 0, dz / s.r);
      put(s.cx - dx, y, z, -dx / s.r, 0, dz / s.r);
    }
  }

  // Caps.
  for (const [capY, sign] of [
    [s.maxY, 1],
    [s.minY, -1],
  ] as const) {
    for (let i = latticeFirstAtOrAfter(s.minX, SURFEL_SPACING); ; i++) {
      const x = latticeCentre(i, SURFEL_SPACING);
      if (x > s.maxX) break;
      for (let k = latticeFirstAtOrAfter(s.minZ, SURFEL_SPACING); ; k++) {
        const z = latticeCentre(k, SURFEL_SPACING);
        if (z > s.maxZ) break;
        const dx = x - s.cx;
        const dz = z - s.cz;
        if (dx * dx + dz * dz > s.r * s.r) continue;
        put(x, capY, z, 0, sign, 0);
      }
    }
  }
  return tested;
}

/** The rim circles. A cylinder has no box edges; its silhouette line is the cap crease. */
function bakeCylinderRims(
  world: World,
  s: CollisionSolid,
  walkableSolids: Set<number>,
  out: RawEdge[],
): void {
  const pieces = Math.max(8, Math.ceil((2 * Math.PI * s.r) / EDGE_SEG_MAX));
  for (const [capY, sign] of [
    [s.maxY, 1],
    [s.minY, -1],
  ] as const) {
    const hold =
      sign > 0
        ? walkableSolids.has(s.index) || s.maxY - s.minY <= HOLD_MAX_STEP
        : s.minY >= HOLD_MIN_CLEARANCE && s.minY <= HEIGHT_STAND;
    for (let k = 0; k < pieces; k++) {
      const a0 = (k / pieces) * Math.PI * 2;
      const a1 = ((k + 1) / pieces) * Math.PI * 2;
      const am = (a0 + a1) * 0.5;
      const E = CREASE_PROBE;
      const mx = s.cx + Math.cos(am) * s.r;
      const mz = s.cz + Math.sin(am) * s.r;
      let open = true;
      for (const [qr, qy] of [
        [1, 1],
        [1, -1],
        [-1, 1],
      ] as const) {
        const x = mx + Math.cos(am) * E * qr;
        const z = mz + Math.sin(am) * E * qr;
        const y = capY + sign * E * qy;
        if (!insideAir(world, x, y, z) || solidAtSkipping(world, x, y, z, s.index)) {
          open = false;
          break;
        }
      }
      if (!open) continue;
      out.push({
        x0: s.cx + Math.cos(a0) * s.r,
        y0: capY,
        z0: s.cz + Math.sin(a0) * s.r,
        x1: s.cx + Math.cos(a1) * s.r,
        y1: capY,
        z1: s.cz + Math.sin(a1) * s.r,
        hold,
      });
    }
  }
}

// ------------------------------------------------------------------------------------------
// Ladders
// ------------------------------------------------------------------------------------------

/**
 * Ladders are climb volumes, not solids, so nothing above bakes them — yet engine-plan §3 names
 * "ladder rails + rungs" as holds, and vision §5 makes the line the promise that a body can climb
 * here. They are derived straight off the authored `LadderDef`: two rails on the climbing plane
 * at +/- half the rung width, and rungs across it every LADDER_RUNG_SPACING. Every piece is a
 * hold; a ladder is nothing but holds.
 */
function bakeLadders(world: World, out: RawEdge[]): void {
  for (const l of world.ladders) {
    const d = l.def;
    // Perpendicular to `facing`, in the horizontal plane: the direction the rungs span.
    const sx = l.outZ !== 0 ? 1 : 0;
    const sz = l.outX !== 0 ? 1 : 0;
    const half = d.width / 2;
    for (const side of [-1, 1] as const) {
      const rx = d.x + sx * half * side;
      const rz = d.z + sz * half * side;
      const pieces = Math.max(1, Math.ceil((d.yTop - d.yBase) / EDGE_SEG_MAX));
      for (let k = 0; k < pieces; k++) {
        const y0 = d.yBase + ((d.yTop - d.yBase) * k) / pieces;
        const y1 = d.yBase + ((d.yTop - d.yBase) * (k + 1)) / pieces;
        out.push({ x0: rx, y0, z0: rz, x1: rx, y1, z1: rz, hold: true });
      }
    }
    const rungs = Math.max(1, Math.round((d.yTop - d.yBase) / LADDER_RUNG_SPACING));
    // A rung is as wide as the ladder (0.6 m in the sample map), so it needs the same
    // EDGE_SEG_MAX subdivision every other emitter applies: a segment is assigned to ONE patch
    // by its midpoint and lit through that patch's line-of-sight, so an over-long segment is a
    // coarser lie about where it is (test/surfels.spec.ts pins the invariant globally).
    const across = Math.max(1, Math.ceil(d.width / EDGE_SEG_MAX));
    for (let k = 1; k < rungs; k++) {
      const y = d.yBase + ((d.yTop - d.yBase) * k) / rungs;
      for (let j = 0; j < across; j++) {
        const a = -half + (d.width * j) / across;
        const b = -half + (d.width * (j + 1)) / across;
        out.push({
          x0: d.x + sx * a,
          y0: y,
          z0: d.z + sz * a,
          x1: d.x + sx * b,
          y1: y,
          z1: d.z + sz * b,
          hold: true,
        });
      }
    }
  }
}

/**
 * Chain curtains as MATTER (vision §8, §1.2).
 *
 * A curtain is not a solid — it has no collision, you walk through it, and the whole point of it
 * is that passing through costs noise rather than time — and it is not an occluder either: a
 * doorway hung with chain does not muffle a sound the way a wall does. But it exists, and vision
 * §1.2 cuts both ways: an E-ping fired down that doorway has to come back with something, or the
 * player is being told an obstacle they can hear is not there. So it bakes into the same static
 * lattice as everything else, and is simply never consulted by collision or by wall counting.
 *
 * Both sides are baked, a hand's thickness apart either side of the curtain's mid-plane and
 * facing outward. Not coincident: one world position carries exactly one dot everywhere else in
 * the lattice (test/surfels.spec.ts pins it globally), and a doubled position would be a second
 * dot answering for the same place forever. The offset is the chain's own thickness, which is
 * both true and small enough to read as one hanging sheet rather than two.
 *
 * The bake is deliberately NOT roster-gated, and that split is the rule for every prop: the
 * ROSTER (`?props=`, core/roster.ts) decides which props run as EMITTERS, while the bake decides
 * what exists as MATTER. Silencing a curtain's rattle does not demolish the curtain — the strands
 * still hang in the doorway, still return an E-ping, and still occupy the same dots, so a capture
 * taken with `?props=none` sees exactly the world a capture with props sees, minus the sounds.
 * Anything else would make the roster an authoring tool and every pinned dot count a function of
 * which emitters happened to be switched on.
 *
 * Every SECOND lattice column carries strands. A curtain filled edge to edge is indistinguishable
 * from a wall, which is exactly the read vision §8 does not want — these are "read-and-route
 * puzzles (crouch through, go around)", so the geometry has to say "hanging, passable" at a
 * glance. The gap is the whole message.
 */
const CHAIN_HALF_THICK = FACE_PROBE;

function bakeChains(
  world: World,
  px: number[],
  py: number[],
  pz: number[],
  nx: number[],
  ny: number[],
  nz: number[],
): number {
  let samples = 0;
  for (const p of world.map.props) {
    if (p.type !== 'chain') continue;
    const thinZ = p.thinAxis === 'z';
    const mid = thinZ ? (p.min[2] + p.max[2]) / 2 : (p.min[0] + p.max[0]) / 2;
    const lo = thinZ ? p.min[0] : p.min[2];
    const hi = thinZ ? p.max[0] : p.max[2];
    for (let i = latticeFirstAtOrAfter(lo, SURFEL_SPACING); latticeCentre(i, SURFEL_SPACING) <= hi; i++) {
      if (i % 2 !== 0) continue;
      const across = latticeCentre(i, SURFEL_SPACING);
      for (
        let j = latticeFirstAtOrAfter(p.min[1], SURFEL_SPACING);
        latticeCentre(j, SURFEL_SPACING) <= p.max[1];
        j++
      ) {
        const y = latticeCentre(j, SURFEL_SPACING);
        samples++;
        // Air-only, same predicate the walls use: a curtain authored across a doorway that got
        // filled in later must not leave a sheet of dots floating inside the fill.
        if (!insideAir(world, thinZ ? across : mid, y, thinZ ? mid : across)) continue;
        for (const sign of [-1, 1] as const) {
          const plane = mid + sign * CHAIN_HALF_THICK;
          px.push(thinZ ? across : plane);
          py.push(y);
          pz.push(thinZ ? plane : across);
          nx.push(thinZ ? 0 : sign);
          ny.push(0);
          nz.push(thinZ ? sign : 0);
        }
      }
    }
  }
  return samples;
}

// ------------------------------------------------------------------------------------------
// Patch table
// ------------------------------------------------------------------------------------------

/**
 * Groups dots and segments into PATCH_SIZE cells and emits them in a spatially coherent order:
 * floor-major (y), then Morton within the floor. A sound's footprint is a sphere, and a sphere in
 * this order is a handful of index runs — which is what makes `addUpdateRange` cheaper than
 * re-uploading the whole buffer, and what keeps a detonation from touching every range there is.
 */
class PatchBuilder {
  private readonly slots = new Map<number, number>();
  private readonly keys: number[] = [];
  private readonly dots: number[][] = [];
  private readonly segs: number[][] = [];

  private slot(x: number, y: number, z: number): number {
    const cx = Math.floor(x / PATCH_SIZE) + 0x8000;
    const cy = Math.floor(y / PATCH_SIZE) + 0x8000;
    const cz = Math.floor(z / PATCH_SIZE) + 0x8000;
    // 32-bit Morton over (x,z), floor index in the high bits: < 2^48, exact as a double.
    const key = cy * 4294967296 + ((part1by1(cx) | (part1by1(cz) << 1)) >>> 0);
    let s = this.slots.get(key);
    if (s === undefined) {
      s = this.keys.length;
      this.slots.set(key, s);
      this.keys.push(key);
      this.dots.push([]);
      this.segs.push([]);
    }
    return s;
  }

  addDot(index: number, x: number, y: number, z: number): void {
    this.dots[this.slot(x, y, z)].push(index);
  }

  addSeg(index: number, x: number, y: number, z: number): void {
    this.segs[this.slot(x, y, z)].push(index);
  }

  pack(): {
    patchCount: number;
    dotOrder: Uint32Array;
    segOrder: Uint32Array;
    patchDotStart: Uint32Array;
    patchDotCount: Uint32Array;
    patchSegStart: Uint32Array;
    patchSegCount: Uint32Array;
  } {
    const order = this.keys.map((_, i) => i).sort((a, b) => this.keys[a] - this.keys[b]);
    const n = order.length;
    const patchDotStart = new Uint32Array(n);
    const patchDotCount = new Uint32Array(n);
    const patchSegStart = new Uint32Array(n);
    const patchSegCount = new Uint32Array(n);
    let dotTotal = 0;
    let segTotal = 0;
    for (const s of this.dots) dotTotal += s.length;
    for (const s of this.segs) segTotal += s.length;
    const dotOrder = new Uint32Array(dotTotal);
    const segOrder = new Uint32Array(segTotal);
    let d = 0;
    let g = 0;
    for (let p = 0; p < n; p++) {
      const src = order[p];
      patchDotStart[p] = d;
      for (const i of this.dots[src]) dotOrder[d++] = i;
      patchDotCount[p] = d - patchDotStart[p];
      patchSegStart[p] = g;
      for (const i of this.segs[src]) segOrder[g++] = i;
      patchSegCount[p] = g - patchSegStart[p];
    }
    return { patchCount: n, dotOrder, segOrder, patchDotStart, patchDotCount, patchSegStart, patchSegCount };
  }
}

/** Spread the low 16 bits of `n` into the even bit positions (Morton interleave). */
function part1by1(n: number): number {
  let v = n & 0xffff;
  v = (v | (v << 8)) & 0x00ff00ff;
  v = (v | (v << 4)) & 0x0f0f0f0f;
  v = (v | (v << 2)) & 0x33333333;
  v = (v | (v << 1)) & 0x55555555;
  return v >>> 0;
}
