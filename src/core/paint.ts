/**
 * Paint — sound events in, lit surfels out (engine-plan §3 "Paint", §4 "Sound events").
 *
 * This is the file the whole game is named after. `core/surfels.ts` decided where a dot may
 * exist; nothing is visible until a sound reaches it. Two separate questions live here, and
 * keeping them separate is the point:
 *
 *   DELIVERY  — "does this listener receive this event at all?" Per listener, per event.
 *               Range gate + wall gate, and the `quality` number stains and audio read.
 *   PAINT     — "which surfels does this event light?" Per event, ONCE, from the event's own
 *               origin outward. Paint is a property of the sound, not of the ear: the wall
 *               reductions in step 2 are measured from the event to the SURFACE, not to you.
 *
 * The seam matters for co-op (vision §10, engine-plan §11.1): one emission, many listeners.
 * Delivery is therefore a pure function of a listener position — it never touches the bus, and
 * `bus.emit` never computes it. What a consumer sees is a COPY of the event with its own
 * delivery fields filled; the bus's own record stays neutral forever.
 *
 * Nothing here uses `Math.random`, a wall clock, or any state outside the field's buffers: the
 * same events applied in the same order always produce the same picture (visual-brief §2).
 */

import {
  DITHER_GAIN,
  HEARING_BASE,
  PAINT_BUDGET_MS,
  WALL1_INTENSITY,
  WALL1_QUALITY,
  WALL1_RADIUS,
  WALL_FUZZ,
  WALL_MAX,
} from './const.js';
import type { SoundClass, SoundEvent } from './events.js';
import { EventBus } from './events.js';
import { clamp01, eventQuality, hash1, inCone } from './math.js';
import { countWalls, pointInSolid, queryXZ, type CollisionSolid, type World } from './map/build.js';
import type { SolidKind } from './map/types.js';
import { UNPAINTED, type SurfelField } from './surfels.js';

// ---------------------------------------------------------------------------------------------
// Delivery (engine-plan §4)
// ---------------------------------------------------------------------------------------------

/** What one listener got. `delivered === false` means the other fields are meaningless. */
export interface Delivery {
  delivered: boolean;
  dist: number;
  walls: 0 | 1 | 2;
  quality: number;
}

export const makeDelivery = (): Delivery => ({ delivered: false, dist: 0, walls: 0, quality: 0 });

/**
 * Vision §3.4: "**Floors:** only the loud class (landings, detonations, dispatch hatches, lift
 * machinery) bleeds through". Applies to HEARING only — see `applyEvent` for why paint still
 * treats a slab as a wall.
 */
const LOUD_THROUGH_FLOORS: ReadonlySet<SoundClass> = new Set<SoundClass>(['landing', 'detonation']);

const FLOOR_KINDS: ReadonlySet<SolidKind> = new Set<SolidKind>(['floor', 'ceiling']);

/**
 * The solids a sound is standing in or on, which therefore cannot be "between" it and anything.
 *
 * A footstep is emitted at the FEET — y exactly 0 on the interior floor — so the floor slab is,
 * to the millimetre, coplanar with the sound. Count it as a wall and every step you take paints
 * the ground you are standing on through an imaginary wall: 40 % radius, half intensity, origin
 * fuzzed 2 m. Your own headlights, muffled by the floor they are bouncing off. The same rescue
 * covers a sound that ends up genuinely buried (a badly aimed test detonation, a prop settled
 * inside geometry): it radiates out of the solid instead of blacking out the map.
 *
 * Recomputed per event, not per patch — one broadphase query for a set that is almost always
 * empty or a single slab.
 */
function originSolids(world: World, x: number, y: number, z: number, out: Set<number>): Set<number> {
  out.clear();
  queryXZ(world, x, z, x, z, scratchOriginQuery);
  for (const idx of scratchOriginQuery) {
    if (pointInSolid(world.solids[idx]!, x, y, z)) out.add(idx);
  }
  return out;
}
const scratchOriginQuery: number[] = [];

/**
 * The wall filter one event uses: never its own supporting solid, and — for the loud classes
 * only, and only when asked — never a floor slab (vision §3.4 "only the loud class … bleeds
 * through"). Allocated once per event, not once per patch.
 */
function makeWallFilter(
  own: ReadonlySet<number>,
  passFloors: boolean,
): ((s: CollisionSolid) => boolean) | undefined {
  if (own.size === 0 && !passFloors) return undefined;
  return (s: CollisionSolid): boolean => {
    if (own.has(s.index)) return false;
    if (passFloors && FLOOR_KINDS.has(s.kind)) return false;
    return true;
  };
}

/**
 * Does `e` reach a listener standing at (lx, ly, lz), and how well?
 *
 * The gate is engine-plan §4's explicit "implement as" directive:
 *
 *     delivered iff  d <= max(HEARING_BASE, hearRadius)  AND  walls <= 1
 *
 * so a loud class carries to its own hear radius even past your ears' base range, and a quiet
 * class you are standing on top of still reaches you. `quality` is computed by `eventQuality`
 * (core/math.ts) and MAY legitimately be 0 — a walk step (hear 11) heard from 15 m away is
 * delivered, audible, paints, and carries no usable signal for a stain. Quality is a stain and
 * audio number; it is never a gate, and paint never reads it.
 *
 * `hearingRange` is the LISTENER's own hearing (vision §3.1 base 18 m, +8 with the Sensitivity
 * chip) — a parameter, not a constant, because the chip system is going to move it.
 */
const deliveryOwn = new Set<number>();

export function deliverTo(
  world: World,
  lx: number,
  ly: number,
  lz: number,
  e: SoundEvent,
  hearingRange: number = HEARING_BASE,
  out: Delivery = makeDelivery(),
): Delivery {
  const dx = lx - e.origin[0];
  const dy = ly - e.origin[1];
  const dz = lz - e.origin[2];
  const d = Math.hypot(dx, dy, dz);
  out.dist = d;
  out.walls = 0;
  out.quality = 0;
  out.delivered = false;
  if (d > Math.max(hearingRange, e.hearRadius)) return out;

  const filter = makeWallFilter(
    originSolids(world, e.origin[0], e.origin[1], e.origin[2], deliveryOwn),
    LOUD_THROUGH_FLOORS.has(e.class),
  );
  const walls = countWalls(world, e.origin[0], e.origin[1], e.origin[2], lx, ly, lz, filter);
  if (walls >= WALL_MAX) {
    out.walls = 2;
    return out;
  }
  out.walls = walls === 0 ? 0 : 1;
  out.quality = eventQuality(d, e.hearRadius, out.walls, WALL1_QUALITY);
  out.delivered = true;
  return out;
}

/** A copy of `e` carrying one listener's delivery fields. The bus's own record stays neutral. */
export function withDelivery(e: SoundEvent, d: Delivery): SoundEvent {
  return { ...e, wallsToListener: d.walls, distToListener: d.dist, quality: d.quality };
}

// ---------------------------------------------------------------------------------------------
// Fuzz (vision §3.4 "origin fuzzed ±2 m")
// ---------------------------------------------------------------------------------------------

/**
 * The stable displacement applied to an event's origin when it is painting through a wall.
 * Seeded from `e.fuzzSeed` (itself `hash1(id)`, monotonic and never replayed), so the same event
 * fuzzes the same way for every patch it touches, every frame, every listener, and on every
 * machine — a muffled sound is heard in one wrong place, not smeared over a different wrong
 * place each time you look at it. Uniform inside a WALL_FUZZ sphere.
 */
export function fuzzVector(fuzzSeed: number, out: [number, number, number]): [number, number, number] {
  const s = Math.floor(fuzzSeed * 4294967296) | 0;
  const theta = hash1(s + 1) * Math.PI * 2;
  const cosPhi = hash1(s + 2) * 2 - 1;
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  const r = WALL_FUZZ * Math.cbrt(hash1(s + 3));
  out[0] = r * sinPhi * Math.cos(theta);
  out[1] = r * cosPhi;
  out[2] = r * sinPhi * Math.sin(theta);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Ranged uploads
// ---------------------------------------------------------------------------------------------

/**
 * Gathers the index spans a frame's paint touched so only those bytes go to the GPU.
 *
 * Patches are baked in a spatially coherent order (surfels.ts `PatchBuilder`), so a sound's
 * footprint is a handful of runs rather than a scatter. Runs closer together than MERGE_SLACK
 * elements are merged: re-uploading a few hundred floats nobody changed is far cheaper than an
 * extra `bufferSubData` call, and cheaper still than the per-range object allocation inside the
 * 60 Hz loop.
 */
const MERGE_SLACK = 512;

class RangeAccum {
  private starts: number[] = [];
  private ends: number[] = [];

  add(start: number, count: number): void {
    if (count <= 0) return;
    const end = start + count;
    // Fast path: paint walks patches in ascending order most of the time, so try the last run.
    const n = this.starts.length;
    if (n > 0) {
      const last = n - 1;
      if (start >= this.starts[last]! && start <= this.ends[last]! + MERGE_SLACK) {
        if (end > this.ends[last]!) this.ends[last] = end;
        return;
      }
    }
    this.starts.push(start);
    this.ends.push(end);
  }

  get empty(): boolean {
    return this.starts.length === 0;
  }

  /** Push the accumulated runs onto the two dynamic attributes of one geometry and clear. */
  flushTo(attrs: readonly { addUpdateRange(start: number, count: number): void; needsUpdate: boolean }[]): void {
    if (this.starts.length === 0) return;
    const order = this.starts.map((_, i) => i).sort((a, b) => this.starts[a]! - this.starts[b]!);
    let runStart = -1;
    let runEnd = -1;
    const emit = (): void => {
      if (runStart < 0) return;
      for (const a of attrs) a.addUpdateRange(runStart, runEnd - runStart);
    };
    for (const i of order) {
      const s = this.starts[i]!;
      const e = this.ends[i]!;
      if (runStart < 0) {
        runStart = s;
        runEnd = e;
      } else if (s <= runEnd + MERGE_SLACK) {
        if (e > runEnd) runEnd = e;
      } else {
        emit();
        runStart = s;
        runEnd = e;
      }
    }
    emit();
    for (const a of attrs) a.needsUpdate = true;
    this.starts.length = 0;
    this.ends.length = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// applyEvent
// ---------------------------------------------------------------------------------------------

/** Scratch shared by every `applyEvent` call — paint runs inside the step and must not allocate. */
const scratchPatches: number[] = [];
const scratchFuzz: [number, number, number] = [0, 0, 0];
const paintOwn = new Set<number>();

export interface PaintResult {
  /** Dots that crossed the dither threshold this call (re-lights included). */
  dots: number;
  /** Edge VERTICES lit. */
  edgeVerts: number;
  /** Patches the sphere test handed to the LOS pass. */
  patchesTested: number;
  /** Patches that survived LOS and actually got walked. */
  patchesLit: number;
}

const emptyResult = (): PaintResult => ({ dots: 0, edgeVerts: 0, patchesTested: 0, patchesLit: 0 });

/**
 * Everything one event contributes to paint, resolved once and then reused for every patch.
 *
 * Split out of `applyEvent` so the synchronous path and the amortized `PaintJob` run the exact
 * same per-patch code. A job outlives the call that created it, so it may not borrow the module
 * scratch above: whoever builds a setup owns the buffers inside it.
 */
interface PaintSetup {
  ox: number;
  oy: number;
  oz: number;
  fuzz: readonly [number, number, number];
  wallFilter: ((s: CollisionSolid) => boolean) | undefined;
  cone: SoundEvent['cone'];
  coneHalfCos: number;
  coneLen: number;
  R0: number;
  intensity: number;
  time: number;
  wave: number;
}

function makePaintSetup(
  world: World,
  e: SoundEvent,
  fuzzOut: [number, number, number],
  ownOut: Set<number>,
): PaintSetup {
  const ox = e.origin[0];
  const oy = e.origin[1];
  const oz = e.origin[2];
  const cone = e.cone;
  return {
    ox,
    oy,
    oz,
    fuzz: fuzzVector(e.fuzzSeed, fuzzOut),
    // Paint's wall filter is NOT delivery's: floors stay opaque here even for a detonation.
    wallFilter: makeWallFilter(originSolids(world, ox, oy, oz, ownOut), false),
    cone,
    coneHalfCos: cone ? Math.cos((cone.angleDeg * 0.5 * Math.PI) / 180) : 0,
    coneLen: cone ? Math.hypot(cone.dir[0], cone.dir[1], cone.dir[2]) : 0,
    R0: e.paintRadius,
    intensity: e.intensity,
    time: e.time,
    wave: e.waveSpeed,
  };
}

/**
 * Light everything one sound reaches (engine-plan §3 "Paint", steps 1–5).
 *
 * Wall handling here is deliberately NOT the delivery filter. `deliverTo` lets a detonation's
 * SOUND through a slab, because vision §3.4 says the loud class bleeds between floors. Its PAINT
 * through that same slab is still one-wall paint — "Through one wall: radius −60 %, origin fuzzed
 * ±2 m, dimmer paint" — which is exactly §3.4's "dim moving patch on your floor/ceiling". You hear
 * the blast below you at full strength and see only a smudge of where it happened. Both halves of
 * that paragraph are laws; they just answer different questions.
 *
 * `dotsAccum` / `segAccum` are the caller's upload ranges; pass null when painting outside a
 * frame (specs, warm-up) and upload the whole buffer yourself.
 *
 * This is the WHOLE event, synchronously. `PaintPipeline` spreads wave-speed events over the
 * frames their own wavefront takes to arrive instead — see `PaintJob` — but the result is the
 * same set of writes either way (patches own disjoint dot and segment runs, so the order they
 * are visited in cannot change the picture).
 */
export function applyEvent(
  field: SurfelField,
  world: World,
  e: SoundEvent,
  dotsAccum: RangeAccum | null,
  segAccum: RangeAccum | null,
  out: PaintResult = emptyResult(),
): PaintResult {
  out.dots = 0;
  out.edgeVerts = 0;
  out.patchesTested = 0;
  out.patchesLit = 0;

  const R0 = e.paintRadius;
  if (R0 <= 0 || e.intensity <= 0) return out;
  const ox = e.origin[0];
  const oy = e.origin[1];
  const oz = e.origin[2];

  // Step 1 — candidate patches. Gathered at the FULL radius: a patch behind a wall paints with a
  // smaller radius, never a larger one, so the full-radius sphere is always a superset.
  const patches = field.queryPatches(ox, oy, oz, R0, scratchPatches);
  out.patchesTested = patches.length;
  if (patches.length === 0) return out;

  const setup = makePaintSetup(world, e, scratchFuzz, paintOwn);
  for (const p of patches) paintPatch(field, world, p, setup, dotsAccum, segAccum, out);
  return out;
}

/**
 * Steps 1b–5 for ONE patch. Adds to `out` rather than overwriting it, so a caller walking a
 * patch list across several frames still ends up with the event's true totals.
 */
function paintPatch(
  field: SurfelField,
  world: World,
  p: number,
  s: PaintSetup,
  dotsAccum: RangeAccum | null,
  segAccum: RangeAccum | null,
  out: PaintResult,
): void {
  const ox = s.ox;
  const oy = s.oy;
  const oz = s.oz;
  const R0 = s.R0;
  const fuzz = s.fuzz;
  const cone = s.cone;
  const coneHalfCos = s.coneHalfCos;
  const coneLen = s.coneLen;
  const wave = s.wave;

  const pos = field.positions;
  const nrm = field.normals;
  const dth = field.dither;
  const pt = field.paintTime;
  const pi = field.paintIntensity;
  const eps = field.edgePositions;
  const edt = field.edgeDither;
  const ept = field.edgePaintTime;
  const epi = field.edgePaintIntensity;
  const pcx = field.patchCentre[p * 3]!;
  const pcy = field.patchCentre[p * 3 + 1]!;
  const pcz = field.patchCentre[p * 3 + 2]!;
  const prad = field.patchRadius[p]!;

  // Step 1b — cone pre-filter (E-ping). Widened by the patch's own radius so a patch straddling
  // the beam edge is not thrown away before its surfels get their exact test.
  if (cone && !patchInCone(ox, oy, oz, cone.dir, coneHalfCos, coneLen, pcx, pcy, pcz, prad)) return;

  // Prune before the raycast: even the patch's most eager member cannot clear its dither.
  const near = Math.max(0, Math.hypot(pcx - ox, pcy - oy, pcz - oz) - prad);
  if (s.intensity * clamp01(1 - (near * near) / (R0 * R0)) < field.patchMinDither[p]! * DITHER_GAIN) return;

  // Step 2 — patch LOS. ONE raycast serves every dot and every segment the patch owns, and it
  // starts from `patchProbe` — a point the bake proved is in open air (surfels.ts).
  const walls = countWalls(
    world,
    field.patchProbe[p * 3]!,
    field.patchProbe[p * 3 + 1]!,
    field.patchProbe[p * 3 + 2]!,
    ox,
    oy,
    oz,
    s.wallFilter,
  );
  if (walls >= WALL_MAX) return;
  const through = walls === 1;
  const R = through ? R0 * WALL1_RADIUS : R0;
  const I0 = through ? s.intensity * WALL1_INTENSITY : s.intensity;
  const ex = through ? ox + fuzz[0] : ox;
  const ey = through ? oy + fuzz[1] : oy;
  const ez = through ? oz + fuzz[2] : oz;
  // Re-test against the reduced sphere: most one-wall patches fall out here for free.
  const ddx = pcx - ex;
  const ddy = pcy - ey;
  const ddz = pcz - ez;
  const reach = R + prad;
  if (ddx * ddx + ddy * ddy + ddz * ddz > reach * reach) return;
  out.patchesLit++;

  const invR2 = 1 / (R * R);

  // --- dots -----------------------------------------------------------------------------------
  const d0 = field.patchDotStart[p]!;
  const d1 = d0 + field.patchDotCount[p]!;
  let lo = -1;
  let hi = -1;
  for (let i = d0; i < d1; i++) {
    const i3 = i * 3;
    const vx = ex - pos[i3]!;
    const vy = ey - pos[i3 + 1]!;
    const vz = ez - pos[i3 + 2]!;
    // Step 5 — sound paints the face it hits.
    if (nrm[i3]! * vx + nrm[i3 + 1]! * vy + nrm[i3 + 2]! * vz < 0) continue;
    const d2 = vx * vx + vy * vy + vz * vz;
    if (d2 >= R * R) continue;
    // Step 3 — quadratic falloff to exactly zero at R.
    const I = I0 * clamp01(1 - d2 * invR2);
    if (I < dth[i]! * DITHER_GAIN) continue;
    if (cone && !inCone(ox, oy, oz, cone.dir[0], cone.dir[1], cone.dir[2], pos[i3]!, pos[i3 + 1]!, pos[i3 + 2]!, cone.angleDeg))
      continue;
    // Step 4 — the wavefront. `d / Infinity` is 0, so instant classes need no branch.
    const t = s.time + Math.sqrt(d2) / wave;
    if (pt[i]! === UNPAINTED) field.paintedDots++;
    pt[i] = t;
    const old = pi[i]!;
    pi[i] = I > old * 0.85 ? I : old * 0.85;
    out.dots++;
    if (lo < 0) lo = i;
    hi = i;
  }
  if (lo >= 0 && dotsAccum) dotsAccum.add(lo, hi - lo + 1);

  // --- edge segments --------------------------------------------------------------------------
  // Per VERTEX: a segment straddling the falloff edge fades along its own length in the shader.
  const s0 = field.patchSegStart[p]!;
  const s1 = s0 + field.patchSegCount[p]!;
  let elo = -1;
  let ehi = -1;
  for (let sIdx = s0; sIdx < s1; sIdx++) {
    for (let v = 0; v < 2; v++) {
      const k = sIdx * 2 + v;
      const k3 = k * 3;
      const vx = ex - eps[k3]!;
      const vy = ey - eps[k3 + 1]!;
      const vz = ez - eps[k3 + 2]!;
      const d2 = vx * vx + vy * vy + vz * vz;
      if (d2 >= R * R) continue;
      const I = I0 * clamp01(1 - d2 * invR2);
      if (I < edt[k]! * DITHER_GAIN) continue;
      if (cone && !inCone(ox, oy, oz, cone.dir[0], cone.dir[1], cone.dir[2], eps[k3]!, eps[k3 + 1]!, eps[k3 + 2]!, cone.angleDeg))
        continue;
      const t = s.time + Math.sqrt(d2) / wave;
      if (ept[k]! === UNPAINTED) field.paintedEdgeVerts++;
      ept[k] = t;
      const old = epi[k]!;
      epi[k] = I > old * 0.85 ? I : old * 0.85;
      out.edgeVerts++;
      if (elo < 0) elo = k;
      ehi = k;
    }
  }
  if (elo >= 0 && segAccum) segAccum.add(elo, ehi - elo + 1);
}

/** Conservative cone/sphere overlap: is any part of the patch inside the beam? */
function patchInCone(
  ox: number,
  oy: number,
  oz: number,
  dir: readonly [number, number, number],
  halfCos: number,
  dirLen: number,
  px: number,
  py: number,
  pz: number,
  radius: number,
): boolean {
  if (dirLen < 1e-9) return false;
  const vx = px - ox;
  const vy = py - oy;
  const vz = pz - oz;
  const len = Math.hypot(vx, vy, vz);
  if (len <= radius) return true;
  const c = (vx * dir[0] + vy * dir[1] + vz * dir[2]) / (len * dirLen);
  // Widen the half-angle by the angle the patch subtends: cos(a + b) with sin/cos of both.
  const sinB = Math.min(1, radius / len);
  const cosB = Math.sqrt(Math.max(0, 1 - sinB * sinB));
  const sinA = Math.sqrt(Math.max(0, 1 - halfCos * halfCos));
  return c >= halfCos * cosB - sinA * sinB;
}

// ---------------------------------------------------------------------------------------------
// Amortized paint (engine-plan §10 budget, vision §12 "60 fps")
// ---------------------------------------------------------------------------------------------

/**
 * One wave-speed event's paint, spread over the frames its own wavefront takes to travel.
 *
 * A detonation paints 22 m through a whole floor. Done in one call that is the single most
 * expensive thing the engine does — and it is triggered by the loudest, most dramatic moment in
 * the game, so a hitch lands exactly where it is least forgivable.
 *
 * But the sound has not ARRIVED yet. Vision §3.3 gives a detonation a wave speed, so its paint
 * legitimately reaches 22 m only after 22/140 ≈ 157 ms — ten frames at 60 fps. The shader already
 * refuses to draw a surfel until `now >= paintTime`, so a dot painted early is invisible anyway;
 * a dot painted late is a lie. That asymmetry is the whole schedule:
 *
 *   - patches are sorted by the earliest time the wavefront can touch them,
 *   - a patch the wave HAS reached is painted this frame no matter what the budget says,
 *   - patches ahead of the wave are painted only while `PAINT_BUDGET_MS` lasts.
 *
 * Because the list is sorted, every patch due this frame sits in an unbroken prefix, so "paint
 * all due patches" is a `while` and never a search — and a patch can never be painted after its
 * wavefront time. The budgeted work-ahead then eats into the far shells, so the due prefix keeps
 * arriving already-painted and the peak never lands on one frame.
 *
 * `arrive` is deliberately conservative: it measures to the NEAREST point of the patch and then
 * subtracts `WALL_FUZZ`, because a through-wall patch paints from a fuzzed origin that may sit up
 * to 2 m closer than the true one. Being early is free; being late is the bug.
 */
class PaintJob {
  cursor = 0;
  constructor(
    readonly setup: PaintSetup,
    readonly patches: Int32Array,
    readonly arrive: Float64Array,
  ) {}
  get remaining(): number {
    return this.patches.length - this.cursor;
  }
}

/** Patches painted between two clock reads in the budgeted pass. Power of two. */
const PUMP_CLOCK_STRIDE = 8;

/**
 * Build the arrival-sorted patch list for one event, or null when it paints nothing.
 * Allocates — once per wave-speed event, never per frame and never per patch.
 */
function makePaintJob(field: SurfelField, world: World, e: SoundEvent): PaintJob | null {
  const R0 = e.paintRadius;
  if (R0 <= 0 || e.intensity <= 0) return null;
  const ox = e.origin[0];
  const oy = e.origin[1];
  const oz = e.origin[2];
  const found = field.queryPatches(ox, oy, oz, R0, scratchPatches);
  const n = found.length;
  if (n === 0) return null;

  const when = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = found[i]!;
    const dx = field.patchCentre[p * 3]! - ox;
    const dy = field.patchCentre[p * 3 + 1]! - oy;
    const dz = field.patchCentre[p * 3 + 2]! - oz;
    const nearest = Math.hypot(dx, dy, dz) - field.patchRadius[p]! - WALL_FUZZ;
    when[i] = e.time + Math.max(0, nearest) / e.waveSpeed;
  }

  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a, b) => when[a]! - when[b]!);

  const patches = new Int32Array(n);
  const arrive = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const src = order[i]!;
    patches[i] = found[src]!;
    arrive[i] = when[src]!;
  }
  // The job outlives this call, so it gets its own fuzz tuple and its own origin-solid set.
  return new PaintJob(makePaintSetup(world, e, [0, 0, 0], new Set<number>()), patches, arrive);
}

// ---------------------------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------------------------

export type DeliveredListener = (e: SoundEvent) => void;

/**
 * One listener's view of the world's sound: subscribes to a bus, decides what reaches this ear,
 * paints what it hears, and republishes the delivered copies for the look's stain layer.
 *
 * Solo has exactly one of these. Co-op has one per local rig; nothing about the class assumes it
 * is alone, and nothing about it writes back to the bus.
 *
 * Attached by the BOOT layer, not by `Sim`. A bake is a hundred thousand dots and a hundred
 * milliseconds; `test/noise.spec.ts` builds dozens of Sims on a 600 m gym map and would pay for
 * one every time. Paint is a consumer of the sim, exactly like audio.
 */
export class PaintPipeline {
  readonly field: SurfelField;
  readonly world: World;

  /** Where the ear is. Written every frame from `sim.renderPos` (engine-plan §11.1). */
  lx = 0;
  ly = 0;
  lz = 0;
  /** Vision §3.1 base 18 m; the Sensitivity chip moves it. */
  hearingRange = HEARING_BASE;

  /** Set true by the boot layer only — reading a clock inside the sim breaks determinism specs. */
  profile = false;
  /**
   * Milliseconds of paint work in the last completed FRAME, and the worst frame since reset.
   *
   * Per frame, not per event: with `amortize` on, one event's cost is deliberately spread over
   * several frames, so "the worst event" stopped being the number that decides whether the game
   * holds 60 fps. `flush()` closes the frame and rolls these over.
   */
  lastMs = 0;
  maxMs = 0;
  lastResult: PaintResult = emptyResult();

  /**
   * Spread wave-speed events (pings, detonations) across the frames their wavefront takes to
   * arrive, instead of painting them in one call. Set by a consumer that runs a frame loop and
   * therefore calls `pump()`; off by default so a spec can `hear()` and read the field at once.
   */
  amortize = false;

  /** Lifetime tallies for the F3 overlay. */
  heard = 0;
  missed = 0;

  private readonly dotsAccum = new RangeAccum();
  private readonly segAccum = new RangeAccum();
  private readonly delivery = makeDelivery();
  private readonly ring: SoundEvent[] = [];
  private ringHead = 0;
  private readonly listeners = new Set<DeliveredListener>();
  private detach: (() => void) | null = null;
  private readonly jobs: PaintJob[] = [];
  private readonly pumpResult: PaintResult = emptyResult();
  private frameMs = 0;

  constructor(field: SurfelField, world: World, private readonly ringSize = 96) {
    this.field = field;
    this.world = world;
  }

  /** Follow the bus. Returns the detach, and detaching is idempotent. */
  attach(bus: EventBus): () => void {
    this.detach?.();
    const off = bus.on((e) => this.hear(e));
    this.detach = () => {
      off();
      this.detach = null;
    };
    return this.detach;
  }

  setListener(x: number, y: number, z: number): void {
    this.lx = x;
    this.ly = y;
    this.lz = z;
  }

  /**
   * Deliver one event to this listener and paint what it reaches.
   *
   * Public so a spec (or the F7 hotkey path, or a future replay) can drive paint without a bus.
   * Returns the delivered copy, or null when the event never got here.
   */
  hear(e: SoundEvent): SoundEvent | null {
    const d = deliverTo(this.world, this.lx, this.ly, this.lz, e, this.hearingRange, this.delivery);
    if (!d.delivered) {
      this.missed++;
      return null;
    }
    this.heard++;
    const copy = withDelivery(e, d);

    const t0 = this.profile ? nowMs() : 0;
    // An instant class (every footstep, every landing) is small and has nothing to wait for:
    // `waveSpeed` is Infinity, so the whole event is already "due" and queueing it would only
    // add bookkeeping. Only a travelling sound can be scheduled.
    if (this.amortize && Number.isFinite(copy.waveSpeed)) {
      const job = makePaintJob(this.field, this.world, copy);
      if (job) this.jobs.push(job);
    } else {
      applyEvent(this.field, this.world, copy, this.dotsAccum, this.segAccum, this.lastResult);
    }
    if (this.profile) this.frameMs += nowMs() - t0;

    if (this.ring.length < this.ringSize) this.ring.push(copy);
    else {
      this.ring[this.ringHead] = copy;
      this.ringHead = (this.ringHead + 1) % this.ringSize;
    }
    for (const fn of this.listeners) fn(copy);
    return copy;
  }

  /**
   * Advance every scheduled event to the wavefront at `now`, then work ahead into `budgetMs`.
   *
   * Call once per frame, BEFORE `flush()` and before the look renders, with the SAME clock the
   * shader gets as `uNow`. That ordering is what makes the guarantee true: any surfel the shader
   * is about to draw (`now >= paintTime`) belongs to a patch whose `arrive <= paintTime <= now`,
   * and every such patch was painted by the unbudgeted pass a moment ago.
   *
   * `budgetMs` bounds only the work-ahead. Due work is never skipped, so a pathological frame
   * (two detonations, a 200 ms stall) pays what it owes instead of drawing a stale world.
   */
  pump(now: number, budgetMs: number = PAINT_BUDGET_MS): void {
    if (this.jobs.length === 0) return;
    const t0 = nowMs();

    // Pass 1 — everything the wavefront has already reached, across ALL jobs first, so one big
    // event's work-ahead can never starve another event's due work.
    for (const job of this.jobs) {
      while (job.cursor < job.patches.length && job.arrive[job.cursor]! <= now) this.paintNext(job);
    }

    // Pass 2 — spend what is left of the budget on the nearest unpainted shells.
    const deadline = t0 + budgetMs;
    let tick = 0;
    outer: for (const job of this.jobs) {
      while (job.cursor < job.patches.length) {
        if ((tick++ & (PUMP_CLOCK_STRIDE - 1)) === 0 && nowMs() >= deadline) break outer;
        this.paintNext(job);
      }
    }

    let write = 0;
    for (const job of this.jobs) if (job.remaining > 0) this.jobs[write++] = job;
    this.jobs.length = write;

    if (this.profile) this.frameMs += nowMs() - t0;
  }

  /** Finish every scheduled event immediately. For specs, warm-up, and teardown — never a frame. */
  settle(now: number): void {
    this.pump(now, Infinity);
  }

  /** Patches still waiting on their wavefront. Zero means the world is fully painted. */
  get pendingPatches(): number {
    let n = 0;
    for (const job of this.jobs) n += job.remaining;
    return n;
  }

  private paintNext(job: PaintJob): void {
    paintPatch(
      this.field,
      this.world,
      job.patches[job.cursor]!,
      job.setup,
      this.dotsAccum,
      this.segAccum,
      this.pumpResult,
    );
    job.cursor++;
  }

  /** The look's `EventFeed.subscribe`. Fires only for events THIS listener received. */
  onDelivered(fn: DeliveredListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** The look's `EventFeed.recent()` — newest first, delivery fields filled. */
  recent(limit = this.ring.length): SoundEvent[] {
    const out: SoundEvent[] = [];
    const n = Math.min(limit, this.ring.length);
    const base = this.ring.length < this.ringSize ? this.ring.length : this.ringHead;
    for (let i = 1; i <= n; i++) {
      const e = this.ring[(base - i + this.ringSize * 2) % this.ring.length];
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * Hand the frame's touched spans to the GPU. Called once per frame, after the sim has stepped
   * and before the look renders: a frame that ran four steps and painted eight events uploads
   * one merged set of ranges, not eight.
   */
  flush(): void {
    this.dotsAccum.flushTo([
      this.field.geometry.getAttribute('paintTime') as unknown as UpdatableAttr,
      this.field.geometry.getAttribute('paintIntensity') as unknown as UpdatableAttr,
    ]);
    this.segAccum.flushTo([
      this.field.edgeGeometry.getAttribute('paintTime') as unknown as UpdatableAttr,
      this.field.edgeGeometry.getAttribute('paintIntensity') as unknown as UpdatableAttr,
    ]);
    // Close the frame's profile window: everything `hear()` and `pump()` charged since the last
    // flush was one frame's worth of paint, which is the number the 16.7 ms budget is about.
    this.lastMs = this.frameMs;
    if (this.frameMs > this.maxMs) this.maxMs = this.frameMs;
    this.frameMs = 0;
  }

  /** Run restart: black world, empty history. Paint otherwise persists for the whole run. */
  reset(): void {
    this.field.resetPaint();
    this.ring.length = 0;
    this.ringHead = 0;
    this.jobs.length = 0;
    this.heard = 0;
    this.missed = 0;
    this.lastMs = 0;
    this.maxMs = 0;
    this.frameMs = 0;
  }

  dispose(): void {
    this.detach?.();
    this.listeners.clear();
    this.jobs.length = 0;
  }
}

interface UpdatableAttr {
  addUpdateRange(start: number, count: number): void;
  needsUpdate: boolean;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0;

export { RangeAccum };
