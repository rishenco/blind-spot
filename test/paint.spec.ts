/**
 * Paint — the pipeline that turns sound into the only light there is (engine-plan §3–§4).
 *
 * Two questions live in `core/paint.ts` and this file keeps them apart on purpose:
 *
 *   DELIVERY  "does this listener receive this event?"  engine-plan §4's explicit gate,
 *             `d <= max(HEARING_BASE, hearRadius) && walls <= 1`, per listener, per event.
 *   PAINT     "which surfels does this event light?"    vision §3.1/§3.4, per event, ONCE, from
 *             the event's own origin — the wall reductions are measured to the SURFACE, not to
 *             your ear.
 *
 * The laws under test, all of them from the vision:
 *
 *   §1.1  every question has a price — nothing is lit that no sound reached, so a fresh field
 *         plus zero events is black, and `resetPaint` puts it back.
 *   §1.2  the system never lies — a muffled sound lands in ONE wrong place (a stable per-event
 *         fuzz), not a different wrong place every time you look at it.
 *   §1.3  absence is black — two walls is nothing at all, not a dim something.
 *   §3.4  through one wall: radius x0.4, intensity x0.5, origin fuzzed +-2 m. Floors: only the
 *         loud class bleeds, and that is a HEARING rule — paint still treats a slab as a wall.
 *   §3.6  paint is kept for the whole run: a bus reset is not a paint reset.
 *
 * Everything runs on small hand-checkable fixtures. "Dock Approach" is the bake spec's job.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DITHER_GAIN,
  EV,
  HEARING_BASE,
  PING_COOLDOWN,
  SIM_STEP,
  WALL1_INTENSITY,
  WALL1_QUALITY,
  WALL1_RADIUS,
  WALL_FUZZ,
  WAVE_SPEED_DETONATION,
  WAVE_SPEED_E,
  WAVE_SPEED_Q,
} from '../src/core/const.js';
import { EventBus, type EmitSpec, type SoundEvent } from '../src/core/events.js';
import { eventQuality } from '../src/core/math.js';
import { buildWorld } from '../src/core/map/build.js';
import type { MapDef, Solid, SolidKind } from '../src/core/map/types.js';
import { applyEvent, deliverTo, fuzzVector, PaintPipeline, RangeAccum, withDelivery } from '../src/core/paint.js';
import { Sim } from '../src/core/sim.js';
import { bakeSurfels, UNPAINTED, type SurfelField } from '../src/core/surfels.js';

// ------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------

const box = (
  id: string,
  kind: SolidKind,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): Solid => ({ type: 'box', id, kind, min: [x0, y0, z0], max: [x1, y1, z1] });

const mapOf = (name: string, solids: Solid[], air: MapDef['air'], bounds: MapDef['bounds']): MapDef => ({
  name,
  solids,
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [1, 0, 1], yaw: 0 },
  air,
  markers: [],
  bounds,
});

/**
 * The gym: 30 x 12 m of floor cut by two full-height walls, so a listener or a surface can sit
 * behind zero, one or two of them without moving anything else.
 *
 *   x < 9.8       the CLEAN zone — a 5 m event here reaches no wall at all
 *   table         top 5 / bottom 4: the same surfaces face opposite ways, for the facing rule
 *   cube          1 m, on integer boundaries, so some PATCH_SIZE cells hold only its creases
 */
const gymMap = mapOf(
  'paint gym',
  [
    box('floor', 'floor', 0, -0.4, 0, 30, 0, 12),
    box('wallA', 'wall', 9.8, 0, 0, 10.2, 6, 12),
    box('wallB', 'wall', 19.8, 0, 0, 20.2, 6, 12),
    box('table', 'crate', 4, 4, 4, 8, 5, 8),
    box('cube', 'crate', 12, 2, 2, 13, 3, 3),
  ],
  [{ min: [0, 0, 0], max: [30, 6, 12] }],
  { min: [0, -0.4, 0], max: [30, 6, 12] },
);

const gym = buildWorld(gymMap);
const field = bakeSurfels(gym);

/** No walls, no ceiling, 80 m of room: the delivery gate's own measuring stick. */
const openWorld = buildWorld(
  mapOf(
    'open',
    [box('floor', 'floor', 0, -0.4, 0, 80, 0, 20)],
    [{ min: [0, 0, 0], max: [80, 10, 20] }],
    { min: [0, -0.4, 0], max: [80, 10, 20] },
  ),
);

/** Three storeys, two slabs: the only fixture where "loud bleeds through floors" is visible. */
const towerWorld = buildWorld(
  mapOf(
    'tower',
    [
      box('ground', 'floor', 0, -0.4, 0, 10, 0, 10),
      box('deck1', 'floor', 0, 3, 0, 10, 4, 10),
      box('deck2', 'floor', 0, 7, 0, 10, 8, 10),
    ],
    [
      { min: [0, 0, 0], max: [10, 3, 10] },
      { min: [0, 4, 0], max: [10, 7, 10] },
      { min: [0, 8, 0], max: [10, 11, 10] },
    ],
    { min: [0, -0.4, 0], max: [10, 11, 10] },
  ),
);

// ------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------

/** One bus per call so ids — and therefore fuzz seeds — are reproducible per test. */
const makeEvent = (spec: EmitSpec, time = 0): SoundEvent => {
  const bus = new EventBus();
  bus.now = time;
  return bus.emit(spec);
};

/** A clean-zone event: 5 m of paint from (5, 1.6, 6), reaching no wall. */
const cleanPing = (over: Partial<EmitSpec> = {}, time = 0): SoundEvent =>
  makeEvent(
    {
      class: 'qPing',
      source: 'self',
      x: 5,
      y: 1.6,
      z: 6,
      paintRadius: 5,
      hearRadius: 30,
      intensity: 1,
      waveSpeed: Infinity,
      ...over,
    },
    time,
  );

const litDots = (f: SurfelField): number[] => {
  const out: number[] = [];
  for (let i = 0; i < f.count; i++) if (f.paintTime[i] !== UNPAINTED) out.push(i);
  return out;
};

const at = (f: SurfelField, i: number): [number, number, number] => [
  f.positions[i * 3]!,
  f.positions[i * 3 + 1]!,
  f.positions[i * 3 + 2]!,
];

const distTo = (f: SurfelField, i: number, ox: number, oy: number, oz: number): number => {
  const [x, y, z] = at(f, i);
  return Math.hypot(x - ox, y - oy, z - oz);
};

/** The exact number `applyEvent` writes: `I0 * clamp01(1 - d^2/R^2)`, in float32. */
const expectedI = (I0: number, d: number, R: number): number => {
  const q = 1 - (d * d) / (R * R);
  return I0 * (q < 0 ? 0 : q > 1 ? 1 : q);
};

beforeEach(() => {
  field.resetPaint();
});

// ------------------------------------------------------------------------------------------

describe('delivery: does this ear get this event (engine-plan §4)', () => {
  it('delivers exactly out to max(HEARING_BASE, hearRadius) and not one millimetre further', () => {
    // A walk step is heard 11 m by a DOG; your own ears are 18 m (vision §3.1), and the gate takes
    // the larger. The boundary is inclusive — `d > max(...)` misses.
    const e = makeEvent({ class: 'walkStep', source: 'self', x: 10, y: 2, z: 10 });
    expect(deliverTo(openWorld, 10 + HEARING_BASE, 2, 10, e).delivered).toBe(true);
    expect(deliverTo(openWorld, 10 + HEARING_BASE + 1e-3, 2, 10, e).delivered).toBe(false);
    // …and a class louder than your ears carries to ITS radius, well past 18 m.
    const det = makeEvent({ class: 'detonation', source: 'detonation', x: 10, y: 2, z: 10 });
    expect(det.hearRadius).toBeGreaterThan(HEARING_BASE);
    expect(deliverTo(openWorld, 10 + 40, 2, 10, det).delivered).toBe(true);
    expect(deliverTo(openWorld, 10 + det.hearRadius + 1e-3, 2, 10, det).delivered).toBe(false);
  });

  it('delivers a signal it cannot resolve: audible at quality 0', () => {
    // The doc is explicit that quality is a stain-and-audio number and never a gate. A walk step
    // at 15 m is past its own 11 m hear radius but inside your 18 m ears: you hear SOMETHING.
    const e = makeEvent({ class: 'walkStep', source: 'self', x: 10, y: 2, z: 10 });
    const d = deliverTo(openWorld, 25, 2, 10, e);
    expect(d.delivered).toBe(true);
    expect(d.dist).toBeCloseTo(15, 6);
    expect(d.quality).toBe(0);
  });

  it('moves with the listener’s own hearing range, not with a constant', () => {
    // The Sensitivity chip is +8 m of hearing (vision §9) and it must not need a paint rewrite.
    const e = makeEvent({ class: 'walkStep', source: 'self', x: 10, y: 2, z: 10 });
    expect(deliverTo(openWorld, 32, 2, 10, e).delivered).toBe(false);
    expect(deliverTo(openWorld, 32, 2, 10, e, HEARING_BASE + 8).delivered).toBe(true);
    // The gate takes the LARGER of the two, so a small listener range never mutes a class that is
    // loud on its own terms — a walk step is an 11 m sound whatever your ears are worth.
    expect(deliverTo(openWorld, 15, 2, 10, e, 4).delivered).toBe(true);
    expect(deliverTo(openWorld, 10 + e.hearRadius + 1e-3, 2, 10, e, 4).delivered).toBe(false);
  });

  it('reports the wall count the world actually has, and stops at two', () => {
    const det = makeEvent({ class: 'detonation', source: 'detonation', x: 2, y: 2, z: 6 });
    expect(deliverTo(gym, 8, 2, 6, det).walls).toBe(0);
    expect(deliverTo(gym, 15, 2, 6, det).walls).toBe(1);
    const two = deliverTo(gym, 25, 2, 6, det);
    expect(two.walls).toBe(2);
    // vision §1.3 — two walls is silence, not a quiet something.
    expect(two.delivered).toBe(false);
    expect(two.quality).toBe(0);
  });

  it('lets only the loud classes bleed through floors (vision §3.4)', () => {
    // Two slabs between the ears and the sound. A footstep is two walls away and simply is not
    // there; a landing and a detonation are the classes the vision names, and they arrive clean.
    const quiet = makeEvent({ class: 'walkStep', source: 'self', x: 5, y: 1, z: 5, hearRadius: 60 });
    const land = makeEvent({ class: 'landing', source: 'self', x: 5, y: 1, z: 5 });
    const det = makeEvent({ class: 'detonation', source: 'detonation', x: 5, y: 1, z: 5 });
    expect(deliverTo(towerWorld, 5, 9, 5, quiet).walls).toBe(2);
    expect(deliverTo(towerWorld, 5, 9, 5, quiet).delivered).toBe(false);
    for (const e of [land, det]) {
      const d = deliverTo(towerWorld, 5, 9, 5, e);
      expect(d.walls, e.class).toBe(0);
      expect(d.delivered, e.class).toBe(true);
    }
    // A wall is still a wall for the loud class — only floors and ceilings are transparent.
    expect(deliverTo(gym, 25, 2, 6, det).delivered).toBe(false);
  });

  it('never counts the solid a sound is standing in as a wall between them', () => {
    // A footstep is emitted at the feet, coplanar with the floor slab, and a buried prop is
    // legitimately inside geometry. Either one radiates OUT; neither is muffled by itself.
    const buried = makeEvent({ class: 'propKnock', source: 'prop', x: 6, y: 4.5, z: 6 });
    expect(deliverTo(gym, 6, 4.5, 2, buried).walls).toBe(0);
    // Proof it is the rescue and not an accident of geometry: the same ray from just OUTSIDE the
    // same box, crossing the same 4 m of crate, counts the wall.
    const outside = makeEvent({ class: 'propKnock', source: 'prop', x: 6, y: 4.5, z: 8.1 });
    expect(deliverTo(gym, 6, 4.5, 2, outside).walls).toBe(1);
  });

  it('computes quality with core/math.ts and nothing else', () => {
    for (const [lx, want] of [
      [4, 0],
      [12, 1],
      [16, 1],
    ] as const) {
      const e = makeEvent({ class: 'sprintStep', source: 'self', x: 2, y: 2, z: 6 });
      const d = deliverTo(gym, lx, 2, 6, e);
      expect(d.walls, `listener at ${lx}`).toBe(want);
      expect(d.quality, `listener at ${lx}`).toBeCloseTo(
        eventQuality(d.dist, e.hearRadius, d.walls, WALL1_QUALITY),
        12,
      );
    }
    // One wall costs quality even at the same distance: the muffled read is a worse read.
    const e = makeEvent({ class: 'sprintStep', source: 'self', x: 8, y: 2, z: 6 });
    const clear = deliverTo(gym, 2, 2, 6, e);
    const muffled = deliverTo(gym, 14, 2, 6, e);
    expect(muffled.dist).toBeCloseTo(clear.dist, 6);
    expect(muffled.quality).toBeCloseTo(clear.quality * WALL1_QUALITY, 12);
  });

  it('fills the delivery fields on the copy, never on the bus’s own record (engine-plan §11.1)', () => {
    // One emission, many listeners: the bus record has to stay neutral or the second ear reads the
    // first ear's numbers. This is the seam co-op is built on.
    const bus = new EventBus();
    bus.now = 3;
    const e = bus.emit({ class: 'walkStep', source: 'self', x: 2, y: 0, z: 6 });
    const near = withDelivery(e, deliverTo(gym, 4, 1.6, 6, e));
    const far = withDelivery(e, deliverTo(gym, 8, 1.6, 6, e));
    expect(e.distToListener).toBe(0);
    expect(e.wallsToListener).toBe(0);
    expect(e.quality).toBe(1);
    expect(near).not.toBe(e);
    expect(near.distToListener).toBeLessThan(far.distToListener);
    expect(near.quality).toBeGreaterThan(far.quality);
    expect(near.id).toBe(e.id);
    expect(near.fuzzSeed).toBe(e.fuzzSeed);
    expect(bus.last).toBe(e);
  });
});

describe('paint: which surfels one sound lights (vision §3.1)', () => {
  it('lights nothing at all when there is no sound', () => {
    expect(litDots(field)).toHaveLength(0);
    expect(field.paintedDots).toBe(0);
    expect(field.paintedEdgeVerts).toBe(0);
  });

  it('leaves the field black when the ear never got the event (vision §1.1, §1.3)', () => {
    // MIGRATED. Law 1: nothing is lit that no DELIVERED sound reached. The gate is the whole
    // story — an event that happened is not an event you heard, and unheard is black, not dim.
    const paint = new PaintPipeline(field, gym);
    const e = cleanPing({ hearRadius: 11 });
    paint.setListener(5, 1.6, 6 + 60);
    expect(paint.hear(e)).toBeNull();
    expect(paint.missed).toBe(1);
    expect(field.paintedDots).toBe(0);
    for (let i = 0; i < field.count; i++) expect(field.paintTime[i]).toBe(UNPAINTED);
    paint.dispose();
  });

  it('puts the whole run back to black on resetPaint, dots and edges alike', () => {
    // MIGRATED. The run-scoped map has exactly one eraser, and it must leave nothing behind:
    // a surviving paintTime is a surface the next run would see without ever having heard it.
    applyEvent(field, gym, cleanPing(), null, null);
    expect(field.paintedDots).toBeGreaterThan(0);
    expect(field.paintedEdgeVerts).toBeGreaterThan(0);
    field.resetPaint();
    expect(field.paintedDots).toBe(0);
    expect(field.paintedEdgeVerts).toBe(0);
    for (let i = 0; i < field.count; i++) expect(field.paintTime[i]).toBe(UNPAINTED);
    for (let k = 0; k < field.edgePaintTime.length; k++) expect(field.edgePaintTime[k]).toBe(UNPAINTED);
  });

  it('lights nothing outside the paint radius, and everything inside obeys the falloff exactly', () => {
    const e = cleanPing();
    const r = applyEvent(field, gym, e, null, null);
    expect(r.dots).toBeGreaterThan(100);
    for (const i of litDots(field)) {
      const d = distTo(field, i, 5, 1.6, 6);
      expect(d, `dot ${i} at ${at(field, i).join(',')}`).toBeLessThan(e.paintRadius);
      // Step 3 — quadratic falloff to exactly zero at R, and the dither gate is the density.
      expect(field.paintIntensity[i], `dot ${i}`).toBeCloseTo(expectedI(e.intensity, d, e.paintRadius), 6);
      expect(field.paintIntensity[i]!, `dot ${i}`).toBeGreaterThanOrEqual(field.dither[i]! * DITHER_GAIN);
    }
  });

  it('keeps every dot it refused honest: dark because of dither, distance or facing', () => {
    const e = cleanPing();
    applyEvent(field, gym, e, null, null);
    let checked = 0;
    for (let i = 0; i < field.count; i++) {
      if (field.paintTime[i] !== UNPAINTED) continue;
      const d = distTo(field, i, 5, 1.6, 6);
      if (d >= e.paintRadius) continue;
      const I = expectedI(e.intensity, d, e.paintRadius);
      const [x, y, z] = at(field, i);
      const facing =
        field.normals[i * 3]! * (5 - x) + field.normals[i * 3 + 1]! * (1.6 - y) + field.normals[i * 3 + 2]! * (6 - z);
      // Inside the sphere and unlit ⇒ it failed the dither gate, or the sound is behind its face,
      // or its whole patch is occluded. Never "the loop just missed it".
      const occluded = field.paintedDots > 0 && facing >= 0 && I >= field.dither[i]! * DITHER_GAIN;
      if (occluded) {
        // The only in-range, forward-facing, bright-enough dots left are behind the table.
        expect(y, `dot ${i} at ${x},${y},${z}`).toBeGreaterThan(4);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('paints the face a sound hits and never the far side of it (engine-plan §3 step 5)', () => {
    // The table's underside (y 4, normal -y) and its top (y 5, normal +y) are 1 m apart. A sound
    // under it lights the underside; the top is unreachable — not dimmer, unreachable — and no
    // amount of fuzz can reach round, because WALL_FUZZ is 2 m and the table is not.
    const e = cleanPing({ intensity: 1, paintRadius: 6 });
    applyEvent(field, gym, e, null, null);
    const under = [];
    const over = [];
    for (let i = 0; i < field.count; i++) {
      const [x, y, z] = at(field, i);
      if (x < 4 || x > 8 || z < 4 || z > 8) continue;
      if (Math.abs(y - 4) < 1e-6 && field.normals[i * 3 + 1] === -1) under.push(i);
      if (Math.abs(y - 5) < 1e-6 && field.normals[i * 3 + 1] === 1) over.push(i);
    }
    expect(under.length).toBeGreaterThan(50);
    expect(over.length).toBeGreaterThan(50);
    expect(under.filter((i) => field.paintTime[i] !== UNPAINTED).length).toBeGreaterThan(20);
    expect(over.filter((i) => field.paintTime[i] !== UNPAINTED)).toHaveLength(0);
  });

  it('stamps the wavefront with distance/waveSpeed, so a detonation expands (vision §3.7)', () => {
    const e = cleanPing({ waveSpeed: WAVE_SPEED_DETONATION, paintRadius: 8 }, 12.5);
    applyEvent(field, gym, e, null, null);
    const lit = litDots(field);
    expect(lit.length).toBeGreaterThan(100);
    let earliest = Infinity;
    let latest = -Infinity;
    for (const i of lit) {
      const d = distTo(field, i, 5, 1.6, 6);
      expect(field.paintTime[i], `dot ${i}`).toBeCloseTo(e.time + d / WAVE_SPEED_DETONATION, 5);
      expect(field.paintTime[i]!).toBeGreaterThanOrEqual(e.time - 1e-6);
      earliest = Math.min(earliest, field.paintTime[i]!);
      latest = Math.max(latest, field.paintTime[i]!);
    }
    // A front, not a flash: the far side of the blast lights measurably later than the near side.
    expect(latest - earliest).toBeGreaterThan(0.02);
  });

  it('stamps an instant class at the event time itself', () => {
    const e = cleanPing({ waveSpeed: Infinity }, 7.25);
    applyEvent(field, gym, e, null, null);
    for (const i of litDots(field)) expect(field.paintTime[i], `dot ${i}`).toBe(e.time);
  });

  it('refuses to light anything from a silent or radiusless event', () => {
    for (const over of [{ intensity: 0 }, { paintRadius: 0 }, { paintRadius: -1 }]) {
      const r = applyEvent(field, gym, cleanPing(over), null, null);
      expect(r.dots, JSON.stringify(over)).toBe(0);
      expect(r.patchesTested, JSON.stringify(over)).toBe(0);
    }
    expect(litDots(field)).toHaveLength(0);
  });

  it('writes only inside the patch runs its own sphere reached', () => {
    // MIGRATED. The patch table is a partition (test/surfels.spec.ts pins disjoint+total+bounded);
    // this is the other half — paint never writes outside the runs of the patches it selected, so
    // "which patches does this sound reach" is the whole of "which dots does this sound light".
    const e = cleanPing({ paintRadius: 6 });
    applyEvent(field, gym, e, null, null);
    const patchOf = new Int32Array(field.count).fill(-1);
    for (let p = 0; p < field.patchCount; p++) {
      const s = field.patchDotStart[p]!;
      for (let i = s; i < s + field.patchDotCount[p]!; i++) patchOf[i] = p;
    }
    let touched = 0;
    for (const i of litDots(field)) {
      touched++;
      const p = patchOf[i]!;
      expect(p, `dot ${i} was lit but belongs to no patch`).toBeGreaterThanOrEqual(0);
      const d = Math.hypot(
        field.patchCentre[p * 3]! - e.origin[0],
        field.patchCentre[p * 3 + 1]! - e.origin[1],
        field.patchCentre[p * 3 + 2]! - e.origin[2],
      );
      expect(d, `dot ${i} lit but its patch centre is ${d.toFixed(2)} m out`).toBeLessThanOrEqual(
        e.paintRadius + field.patchRadius[p]! + 1e-4,
      );
    }
    expect(touched).toBeGreaterThan(50);
  });

  it('lights the bare creases too — a patch made only of lines is still a patch', () => {
    // The gantry beams and tank rims of a real map own PATCH_SIZE cells with no dots in them at
    // all. If those fell out of the LOS pass the map would lose exactly its silhouettes.
    const dotless: number[] = [];
    for (let p = 0; p < field.patchCount; p++) if (field.patchDotCount[p] === 0 && field.patchSegCount[p]! > 0) dotless.push(p);
    expect(dotless.length, 'the fixture must contain a lines-only patch').toBeGreaterThan(0);
    const p = dotless[0]!;
    const e = cleanPing({
      x: field.patchCentre[p * 3]! + 1.5,
      y: field.patchCentre[p * 3 + 1]! + 0.4,
      z: field.patchCentre[p * 3 + 2]! + 1.5,
      paintRadius: 6,
    });
    applyEvent(field, gym, e, null, null);
    const s0 = field.patchSegStart[p]!;
    let lit = 0;
    for (let k = s0 * 2; k < (s0 + field.patchSegCount[p]!) * 2; k++) if (field.edgePaintTime[k] !== UNPAINTED) lit++;
    expect(lit).toBeGreaterThan(0);
    expect(field.paintedEdgeVerts).toBeGreaterThan(0);
  });
});

describe('paint through walls (vision §3.4)', () => {
  const detonate = (x: number): SoundEvent =>
    makeEvent({ class: 'detonation', source: 'detonation', x, y: 1.6, z: 6 });

  it('gets through one wall dimmer, shorter and displaced — and through two, not at all', () => {
    const e = detonate(8);
    applyEvent(field, gym, e, null, null);
    const beyondA: number[] = [];
    const beyondB: number[] = [];
    for (const i of litDots(field)) {
      const x = field.positions[i * 3]!;
      if (x > 10.2 + 1e-6) beyondA.push(i);
      if (x > 20.2 + 1e-6) beyondB.push(i);
    }
    expect(beyondA.length, 'one wall passes a muffled sound').toBeGreaterThan(20);
    // vision §1.3 — absence is black. Two walls is not a dim something.
    expect(beyondB, 'two walls is silence').toHaveLength(0);
    // …and what did get through is halved and lives inside the shrunken, displaceable sphere.
    const reach = e.paintRadius * WALL1_RADIUS + Math.min(WALL_FUZZ, WALL1_RADIUS * e.paintRadius);
    for (const i of beyondA) {
      expect(field.paintIntensity[i]!, `dot ${i}`).toBeLessThanOrEqual(e.intensity * WALL1_INTENSITY + 1e-6);
      expect(distTo(field, i, 8, 1.6, 6), `dot ${i}`).toBeLessThan(reach);
    }
    // The full-strength sphere would have reached far past all of that.
    expect(e.paintRadius).toBeGreaterThan(reach);
  });

  it('keeps a floor opaque to paint even for the class that is heard through it', () => {
    // Both halves of vision §3.4 are laws and they answer different questions: you HEAR the blast
    // below you at full strength (delivery lets floors pass) and you SEE only a smudge of where it
    // happened (paint does not). The gym has no slab to stand on, so this checks the rule itself.
    const det = makeEvent({ class: 'detonation', source: 'detonation', x: 5, y: 1, z: 5 });
    expect(deliverTo(towerWorld, 5, 5, 5, det).walls).toBe(0);
    const f = bakeSurfels(towerWorld);
    applyEvent(f, towerWorld, det, null, null);
    let above = 0;
    let below = 0;
    for (let i = 0; i < f.count; i++) {
      if (f.paintTime[i] === UNPAINTED) continue;
      if (f.positions[i * 3 + 1]! > 4 - 1e-6) above++;
      else below++;
    }
    expect(below, 'the floor it happened on lights up').toBeGreaterThan(100);
    expect(above, 'the storey above gets a smudge at best').toBeLessThan(below / 4);
    f.dispose();
  });

  it('fuzzes a muffled origin to one wrong place, forever (vision §1.2)', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 0, 0];
    for (const seed of [0, 0.125, 0.5, 0.9999]) {
      fuzzVector(seed, a);
      fuzzVector(seed, b);
      expect(b, `seed ${seed}`).toEqual(a);
      expect(Math.hypot(a[0], a[1], a[2]), `seed ${seed}`).toBeLessThanOrEqual(WALL_FUZZ + 1e-9);
      // …and clamped, the displacement stays inside whatever bound it was given.
      fuzzVector(seed, b, 0.6);
      expect(Math.hypot(b[0], b[1], b[2]), `seed ${seed} clamped`).toBeLessThanOrEqual(0.6 + 1e-9);
    }
    // Different events fuzz differently — otherwise every muffled sound in the run lands on the
    // same offset and the displacement reads as a systematic aim error.
    const seen = new Set<string>();
    for (let k = 0; k < 24; k++) {
      fuzzVector(k / 24, a);
      seen.add(a.map((v) => v.toFixed(4)).join(','));
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  /**
   * MIGRATED (review BUG). Vision §3.4 makes one wall a COST: radius → 0.4 R, origin fuzzed ±2 m.
   * A flat 2 m displacement is not a small perturbation of a quiet class — it is larger than the
   * whole reduced radius (crouchStep 1.5 → 0.6, dogGaitPatrol 2 → 0.8, mantle 3 → 1.2), so a
   * muffled sound could light a surface the SAME sound in open air could never have touched. That
   * is design law 2 (the system never lies) failing in the quietest, most trusted direction: you
   * would be reading paint from a crouch step you could not possibly have heard from there.
   *
   * The fix clamps the displacement to the degraded radius, so through-wall reach is at most
   * 0.4R + min(2, 0.4R) ≤ 0.8R < R. Loud classes (R ≥ 5 m) are untouched.
   */
  it('never lets a muffled sound paint further out than the same sound would in open air', () => {
    // The law, over the whole authored class table — no fixture can reach every class.
    for (const [name, ev] of Object.entries(EV)) {
      const reach = WALL1_RADIUS * ev.paint + Math.min(WALL_FUZZ, WALL1_RADIUS * ev.paint);
      expect(reach, `${name}: through-wall reach ${reach.toFixed(2)} m vs ${ev.paint} m clean`).toBeLessThanOrEqual(
        ev.paint,
      );
    }

    // …and measured on geometry, over 96 different fuzz seeds: a 4 m walk step just in front of
    // wallA must never light a dot more than 4 m from where the foot actually fell, even though
    // the fuzz is free to throw its origin straight through the wall and away from it.
    const R0 = EV.walkStep.paint;
    const bus = new EventBus();
    let worst = 0;
    let throughWall = 0;
    for (let k = 0; k < 96; k++) {
      field.resetPaint();
      bus.now = k;
      const e = bus.emit({
        class: 'walkStep',
        source: 'self',
        x: 9.6,
        y: 0.05,
        z: 6,
        paintRadius: R0,
        hearRadius: 30,
        intensity: EV.walkStep.intensity,
        waveSpeed: Infinity,
      });
      applyEvent(field, gym, e, null, null);
      for (const i of litDots(field)) {
        worst = Math.max(worst, distTo(field, i, 9.6, 0.05, 6));
        if (field.positions[i * 3]! > 10.2 + 1e-6) throughWall++;
      }
    }
    expect(throughWall, 'the probe must actually be painting through the wall').toBeGreaterThan(0);
    expect(worst, `a ${R0} m sound painted a surface ${worst.toFixed(2)} m away`).toBeLessThanOrEqual(R0 + 1e-3);
  });

  it('paints the same picture from the same events, every time', () => {
    const e1 = detonate(8);
    const e2 = cleanPing({}, 1.5);
    const run = (): { t: Float32Array; i: Float32Array } => {
      const f = bakeSurfels(gym);
      applyEvent(f, gym, e1, null, null);
      applyEvent(f, gym, e2, null, null);
      const out = { t: f.paintTime.slice(), i: f.paintIntensity.slice() };
      f.dispose();
      return out;
    };
    const a = run();
    const b = run();
    expect(b.t).toEqual(a.t);
    expect(b.i).toEqual(a.i);
    expect(a.i.some((v) => v > 0)).toBe(true);
  });
});

describe('accumulation over a run (vision §3.6)', () => {
  it('counts every dot it has ever lit, once', () => {
    const e = cleanPing();
    const first = applyEvent(field, gym, e, null, null);
    const lit = litDots(field).length;
    expect(field.paintedDots).toBe(lit);
    expect(first.dots).toBe(lit);
    // Re-hearing the same sound re-lights the same dots: work happens, the tally does not move.
    const second = applyEvent(field, gym, e, null, null);
    expect(second.dots).toBe(first.dots);
    expect(field.paintedDots).toBe(lit);
    // A second sound somewhere else only ever adds.
    applyEvent(field, gym, cleanPing({ x: 15, paintRadius: 6 }), null, null);
    expect(field.paintedDots).toBeGreaterThan(lit);
  });

  /**
   * REWRITTEN. This spec used to pin engine-plan §3 step 4's `max(I, old × 0.85)` re-hear decay:
   * a quiet rescan knocked a bright surface down to 85 % of its density read. The decay is gone.
   *
   * It was not commutative. `apply(A) then apply(B)` and `apply(B) then apply(A)` left different
   * paintIntensity values wherever two events overlapped, so the picture depended on the order
   * patches were visited in — which the schedule does not fix, two clients do not agree on, and no
   * amount of care in `pump()` can recover. Both channels now merge with `max`, which is
   * commutative, associative and idempotent, so the converged picture is a pure function of the
   * SET of delivered events. Determinism outranks a tuning value.
   *
   * paintIntensity is therefore "the loudest this surface was ever heard" — a permanent property of
   * the surface. AGE remains the sole recency channel (vision §3.2 "age is temperature"), which is
   * where the recency read belonged all along.
   */
  it('lets a rescan refresh age, and never lets it dim the surface at all', () => {
    const loud = cleanPing({ intensity: 1 }, 1);
    applyEvent(field, gym, loud, null, null);
    // Pick a dot the quiet event will certainly reach as well: bright, close, low dither.
    let pick = -1;
    for (const i of litDots(field)) {
      if (field.dither[i]! > 0.05) continue;
      if (distTo(field, i, 5, 1.6, 6) > 2) continue;
      if (pick < 0 || field.dither[i]! < field.dither[pick]!) pick = i;
    }
    expect(pick).toBeGreaterThanOrEqual(0);
    const before = field.paintIntensity[pick]!;
    expect(field.paintTime[pick]).toBe(1);

    const quiet = cleanPing({ intensity: 0.25 }, 9);
    applyEvent(field, gym, quiet, null, null);
    const heard = expectedI(0.25, distTo(field, pick, 5, 1.6, 6), 5);
    expect(heard, 'the quiet event really is quieter than what is already there').toBeLessThan(before);
    expect(field.paintIntensity[pick], 'a quiet re-hear cannot dim a surface').toBe(before);
    // Age is what a rescan buys you, and all it buys you: freshly known, exactly as dense.
    expect(field.paintTime[pick]).toBe(9);

    // …and a louder rescan takes the loud value outright.
    field.paintIntensity[pick] = 0.1;
    applyEvent(field, gym, cleanPing({ intensity: 1 }, 11), null, null);
    expect(field.paintIntensity[pick]).toBeCloseTo(before, 6);
  });

  it('merges both channels with max, so twenty quiet re-hearings change nothing but the age', () => {
    // The compounding this replaces: under the old `max(I, old × 0.85)` rule six quiet sounds took
    // a bright surface to 0.85^6 = 38 % of its density read while its age kept resetting to now.
    const paint = new PaintPipeline(field, gym);
    paint.setListener(5, 1.6, 6);
    paint.hear(cleanPing({ intensity: 1 }, 0));
    // A dot dim enough in dither that a tenth-intensity re-hear still clears its threshold — so
    // the six quiet sounds really do land on it, and "unchanged" is a merge result, not a miss.
    let probe = -1;
    for (const i of litDots(field)) {
      if (field.dither[i]! >= 0.05) continue;
      if (probe < 0 || field.paintIntensity[i]! > field.paintIntensity[probe]!) probe = i;
    }
    expect(probe, 'the gym must offer a low-dither dot the quiet re-hears can still reach').toBeGreaterThanOrEqual(0);
    const start = field.paintIntensity[probe]!;
    expect(start).toBeGreaterThan(0.8);
    for (let k = 1; k <= 6; k++) paint.hear(cleanPing({ intensity: 0.1 }, k));
    expect(field.paintIntensity[probe]).toBe(start);
    expect(field.paintTime[probe], 'age still tracks the newest sound').toBe(6);
    paint.dispose();
  });

  it('survives a bus reset and dies only when the run does', () => {
    // engine-plan: paint is kept for the whole run (vision §3.6 "kept for the whole run"). The bus
    // ring is a 96-event scratchpad and its reset is a different event entirely.
    const bus = new EventBus();
    const paint = new PaintPipeline(field, gym);
    paint.setListener(5, 1.6, 6);
    const off = paint.attach(bus);
    bus.now = 2;
    bus.emit({ class: 'qPing', source: 'self', x: 5, y: 1.6, z: 6, paintRadius: 5 });
    // A Q-ping travels at 45 m/s, so it is scheduled, not instant: settle past its far shell.
    paint.settle(Infinity);
    const lit = field.paintedDots;
    expect(lit).toBeGreaterThan(0);
    expect(paint.heard).toBe(1);

    bus.reset();
    expect(bus.size).toBe(0);
    expect(field.paintedDots, 'the map you bought is still yours').toBe(lit);
    expect(litDots(field).length).toBe(lit);

    paint.reset();
    expect(field.paintedDots).toBe(0);
    expect(litDots(field)).toHaveLength(0);
    expect(paint.heard).toBe(0);
    expect(paint.missed).toBe(0);
    off();
    paint.dispose();
  });

  it('hands the GPU every index it touched and nothing it did not need to', () => {
    const dotsAccum = new RangeAccum();
    const segAccum = new RangeAccum();
    applyEvent(field, gym, cleanPing(), dotsAccum, segAccum);
    const ranges: Array<[number, number]> = [];
    const attr = {
      addUpdateRange: (start: number, count: number): void => {
        ranges.push([start, count]);
      },
      needsUpdate: false,
    };
    dotsAccum.flushTo([attr]);
    expect(attr.needsUpdate).toBe(true);
    expect(ranges.length).toBeGreaterThan(0);
    const covered = (i: number): boolean => ranges.some(([s, c]) => i >= s && i < s + c);
    const lit = litDots(field);
    for (const i of lit) expect(covered(i), `dot ${i} was painted but never uploaded`).toBe(true);
    // Ranges are sorted, disjoint and inside the buffer — three's `addUpdateRange` merges only
    // adjacent runs, and a range past the end silently uploads garbage.
    let prevEnd = -1;
    for (const [s, c] of ranges) {
      expect(s).toBeGreaterThan(prevEnd);
      expect(s + c).toBeLessThanOrEqual(field.count);
      prevEnd = s + c - 1;
    }
    // The whole point of ranged uploads: a 5 m ping is a small slice of a big buffer.
    const total = ranges.reduce((n, [, c]) => n + c, 0);
    expect(total).toBeLessThan(field.count);
    expect(total).toBeGreaterThanOrEqual(lit.length);
  });

  it('covers two interleaved events with one set of ranges, and merges only what is near', () => {
    // MIGRATED (review §6.1, written out): the accumulator is the one place where "which indices
    // did we touch" is tracked separately from the writes themselves, so a gap in its bookkeeping
    // is a stale GPU buffer — geometry the player paid for that never reaches the screen.
    //
    // Two events far enough apart to own different patch runs but close enough that their runs
    // INTERLEAVE in buffer order (the field is laid out by lattice position, not by event).
    field.resetPaint();
    const dotsAccum = new RangeAccum();
    const segAccum = new RangeAccum();
    applyEvent(field, gym, cleanPing({ x: 5 }), dotsAccum, segAccum);
    const afterFirst = new Set(litDots(field));
    applyEvent(field, gym, cleanPing({ x: 15, paintRadius: 6 }, 1), dotsAccum, segAccum);

    const ranges: Array<[number, number]> = [];
    const attr = {
      addUpdateRange: (start: number, count: number): void => {
        ranges.push([start, count]);
      },
      needsUpdate: false,
    };
    dotsAccum.flushTo([attr]);
    const lit = litDots(field);
    expect(lit.length, 'both events must actually land').toBeGreaterThan(afterFirst.size);
    expect([...lit].some((i) => !afterFirst.has(i)), 'the second event must reach new dots').toBe(true);
    const covered = (i: number): boolean => ranges.some(([s, c]) => i >= s && i < s + c);
    for (const i of lit) expect(covered(i), `dot ${i} was painted by one of two events but never uploaded`).toBe(true);
    let prevEnd = -1;
    for (const [s, c] of ranges) {
      expect(s, 'flushed ranges must come out sorted and disjoint').toBeGreaterThan(prevEnd);
      expect(s + c).toBeLessThanOrEqual(field.count);
      prevEnd = s + c - 1;
    }
    field.resetPaint();
  });

  it('merges two runs at a 512-element gap and keeps them apart at 513', () => {
    // MIGRATED (review §6.1): MERGE_SLACK is 512, and "within slack" is inclusive. The boundary is
    // worth pinning because it is the only number in the accumulator: one off and either every
    // ping uploads the whole buffer or a run is dropped between two ranges.
    const flush = (runs: Array<[number, number]>): Array<[number, number]> => {
      const acc = new RangeAccum();
      for (const [s, c] of runs) acc.add(s, c);
      const out: Array<[number, number]> = [];
      acc.flushTo([{ addUpdateRange: (s: number, c: number) => void out.push([s, c]), needsUpdate: false }]);
      return out;
    };
    // Gap of exactly 512 free elements between the end of one run and the start of the next.
    expect(flush([[0, 10], [522, 10]])).toEqual([[0, 532]]);
    // One more, and they stay two uploads.
    expect(flush([[0, 10], [523, 10]])).toEqual([
      [0, 10],
      [523, 10],
    ]);
    // Order of arrival is irrelevant — flushTo sorts before it merges.
    expect(flush([[522, 10], [0, 10]])).toEqual([[0, 532]]);
    // Overlapping and touching runs collapse whatever the gap rule says.
    expect(flush([[100, 50], [120, 50]])).toEqual([[100, 70]]);
  });

  it('routes a bus event through delivery to paint, and drops what it cannot hear', () => {
    const bus = new EventBus();
    const paint = new PaintPipeline(field, gym);
    paint.setListener(2, 1.6, 6);
    const off = paint.attach(bus);
    const seen: SoundEvent[] = [];
    const offFeed = paint.onDelivered((e) => seen.push(e));

    bus.now = 4;
    bus.emit({ class: 'walkStep', source: 'self', x: 3, y: 0, z: 6 });
    expect(paint.heard).toBe(1);
    expect(field.paintedDots).toBeGreaterThan(0);
    const afterFirst = field.paintedDots;

    // Behind two walls: not delivered, so not painted, and the feed never sees it.
    bus.emit({ class: 'detonation', source: 'detonation', x: 25, y: 1.6, z: 6 });
    expect(paint.missed).toBe(1);
    expect(field.paintedDots).toBe(afterFirst);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.class).toBe('walkStep');
    expect(seen[0]!.distToListener).toBeCloseTo(Math.hypot(1, 1.6), 6);
    expect(paint.recent()[0]).toBe(seen[0]);

    offFeed();
    off();
    // Detaching really detaches: the pipeline is a consumer, not a permanent hook.
    bus.emit({ class: 'walkStep', source: 'self', x: 3, y: 0, z: 6 });
    expect(paint.heard).toBe(1);
    paint.dispose();
  });

  it('hears a paint-radius-0 event and paints nothing from it (the E-ping far end)', () => {
    // The E-ping is heard at BOTH ends (vision §3.3), but the cone already painted everything the
    // beam swept: a sphere at the far end would hand the player geometry around a corner they
    // never illuminated. So `player.ts` emits the far end with paintRadius 0, and that has to be
    // an event you HEAR — delivered, republished to the looks and the stain layer — that simply
    // lights nothing. Not an event that is dropped, and not one that queues a job to paint later.
    const bus = new EventBus();
    const paint = new PaintPipeline(field, gym);
    paint.setListener(5, 1.6, 6);
    paint.attach(bus);
    const seen: SoundEvent[] = [];
    paint.onDelivered((e) => seen.push(e));

    bus.now = 2;
    bus.emit({
      class: 'ePing',
      source: 'self',
      variant: 'far',
      x: 5,
      y: 1.6,
      z: 6,
      paintRadius: 0,
      hearRadius: 30,
    });

    expect(paint.heard).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.paintRadius).toBe(0);
    expect(field.paintedDots).toBe(0);
    expect(paint.pendingPatches).toBe(0);
    // …and settling proves there was nothing queued to arrive later, either.
    paint.settle(Infinity);
    expect(field.paintedDots).toBe(0);
    expect(litDots(field)).toHaveLength(0);
    paint.dispose();
  });
});


// ------------------------------------------------------------------------------------------

/**
 * SCHEDULED PAINT — a sound arrives at its own speed (engine-plan §3, vision §3.3, §3.6).
 *
 * A 22 m detonation is the most paint work the engine ever does, and it fires at the loudest
 * moment in the game. It is not painted in one blocking call, and the reason is not cost: vision
 * §3.3 gives it a wave speed, so its paint legitimately reaches 22 m only after 22/140 ≈ 157 ms.
 * The schedule follows the physics, and the cost bound falls out of it for free.
 *
 * There is ONE code path. Instant classes (`waveSpeed === Infinity` — every footstep, every
 * landing) are wholly due the moment they happen and are painted inside `hear()`. Travelling
 * classes are queued and released by `pump(now)` as their own wavefront arrives. Four laws:
 *
 *   NEVER LATE   every patch whose arrival has passed is painted before `pump(now)` returns.
 *   NEVER EARLY  no write ever leaves a `paintTime` in the future of the clock that wrote it.
 *                This is the one that used to be broken: the shader draws a surfel only when
 *                `now >= paintTime`, so a surfel written ahead of its wavefront is UN-DRAWN —
 *                a future stamp blanks whatever the player already knew about that surface
 *                (vision §3.6 "you never lose the map"). Painting ahead does not pre-warm the
 *                picture; it erases it.
 *   COMMUTATIVE  both channels merge with `max`, so the converged picture is a pure function of
 *                the SET of delivered events — not of hear order, not of patch visit order, not
 *                of the frame cadence, not of how fast the machine is. Two co-op clients fed the
 *                same event stream must derive the same world (engine-plan §11.1).
 *   BOUNDED      no frame does more than the slice of work its wavefront released.
 *
 * The price of NEVER EARLY is bounded lateness: a patch is released only once its FARTHEST member
 * is due, so a near member waits up to (2·patchRadius + 2·fuzz)/waveSpeed. That is measured and
 * pinned below rather than left to chance.
 */
describe('scheduled paint: a sound arrives at its own speed (engine-plan §3)', () => {
  /** Centre of the gym, 22 m of paint at 140 m/s — the real detonation, on a whole-map fixture. */
  const blast = (time = 0): SoundEvent =>
    makeEvent(
      {
        class: 'detonation',
        source: 'detonation',
        x: 15,
        y: 1.6,
        z: 6,
        paintRadius: 22,
        hearRadius: 60,
        intensity: 1,
        waveSpeed: WAVE_SPEED_DETONATION,
      },
      time,
    );

  /**
   * Three OVERLAPPING wave-speed events from ONE bus, so their ids — and therefore their fuzz
   * seeds — differ. Overlap is the whole point: within a single event patch runs are disjoint and
   * order cannot matter, so one event can never detect a non-commutative merge.
   */
  const trio = (): SoundEvent[] => {
    const bus = new EventBus();
    const at = (x: number, paintRadius: number, waveSpeed: number, time: number): SoundEvent => {
      bus.now = time;
      return bus.emit({
        class: 'detonation',
        source: 'detonation',
        x,
        y: 1.6,
        z: 6,
        paintRadius,
        hearRadius: 80,
        intensity: 1,
        waveSpeed,
      });
    };
    return [at(8, 20, WAVE_SPEED_DETONATION, 0), at(15, 12, WAVE_SPEED_Q, 0.01), at(22, 16, WAVE_SPEED_E, 0.02)];
  };

  interface Snapshot {
    time: Float32Array;
    intensity: Float32Array;
    edgeTime: Float32Array;
    edgeIntensity: Float32Array;
    dots: number;
  }

  const snapshot = (): Snapshot => ({
    time: Float32Array.from(field.paintTime),
    intensity: Float32Array.from(field.paintIntensity),
    edgeTime: Float32Array.from(field.edgePaintTime),
    edgeIntensity: Float32Array.from(field.edgePaintIntensity),
    dots: field.paintedDots,
  });

  /** The converged picture: every event applied whole, by the reference function. */
  const converged = (events: readonly SoundEvent[]): Snapshot => {
    field.resetPaint();
    for (const e of events) applyEvent(field, gym, e, null, null);
    return snapshot();
  };

  const pipeline = (lx = 15): PaintPipeline => {
    const p = new PaintPipeline(field, gym);
    p.setListener(lx, 1.6, 6);
    return p;
  };

  const diffCount = (a: Float32Array, b: Float32Array): number => {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  };

  const expectSame = (a: Snapshot, b: Snapshot, what: string): void => {
    expect(a.dots, `${what}: paintedDots`).toBe(b.dots);
    expect(diffCount(a.time, b.time), `${what}: paintTime`).toBe(0);
    expect(diffCount(a.intensity, b.intensity), `${what}: paintIntensity`).toBe(0);
    expect(diffCount(a.edgeTime, b.edgeTime), `${what}: edge paintTime`).toBe(0);
    expect(diffCount(a.edgeIntensity, b.edgeIntensity), `${what}: edge paintIntensity`).toBe(0);
  };

  /** Seeded, so "a random frame cadence" is a fixed cadence the suite can reproduce forever. */
  const mulberry32 = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // --- the four laws ------------------------------------------------------------------------

  it('MUST converge to a picture that depends only on the SET of events, not the frame cadence', () => {
    const events = trio();
    const ref = converged(events);
    expect(ref.dots).toBeGreaterThan(1_000); // the fixture is actually a stress case

    // Path A: hear all three, then settle once at the end.
    field.resetPaint();
    const a = pipeline();
    for (const e of events) a.hear(e);
    a.settle(Infinity);
    expect(a.pendingPatches).toBe(0);
    const settled = snapshot();
    expectSame(settled, ref, 'settle-at-the-end vs converged');

    // Path B: the same three events, pumped on a lumpy seeded cadence — some frames 4 ms, some
    // 90 ms, in the order a real machine actually delivers them.
    field.resetPaint();
    const b = pipeline();
    for (const e of events) b.hear(e);
    const rand = mulberry32(0xb11d);
    let t = 0;
    for (let f = 0; f < 400 && b.pendingPatches > 0; f++) {
      t += 0.004 + rand() * 0.086;
      b.pump(t);
    }
    expect(b.pendingPatches, 'the cadence must actually finish the work').toBe(0);
    expectSame(snapshot(), ref, 'random-cadence pump vs converged');
  });

  it('MUST produce the same picture whatever order the events were heard in', () => {
    const events = trio();
    const forward = ((): Snapshot => {
      field.resetPaint();
      const p = pipeline();
      for (const e of events) p.hear(e);
      p.settle(Infinity);
      return snapshot();
    })();

    field.resetPaint();
    const p = pipeline();
    for (const e of [...events].reverse()) p.hear(e);
    p.settle(Infinity);
    expectSame(snapshot(), forward, 'reversed hear order');

    // …and one interleaved order that is neither: hear one, pump a while, hear the rest.
    field.resetPaint();
    const q = pipeline();
    q.hear(events[1]!);
    q.pump(0.05);
    q.hear(events[2]!);
    q.pump(0.1);
    q.hear(events[0]!);
    q.settle(Infinity);
    expectSame(snapshot(), forward, 'interleaved hear/pump order');
  });

  it('MUST never be late: after pump(now) nothing whose arrival has passed is still queued', () => {
    const events = trio();
    field.resetPaint();
    const paint = pipeline();
    for (const e of events) paint.hear(e);
    expect(paint.pendingPatches).toBeGreaterThan(100);

    for (let f = 0; f < 60; f++) {
      const now = f / 60;
      paint.pump(now);
      // `nextArrival` is the earliest still-unreleased patch across every job. If it were <= now,
      // a surfel the shader is entitled to draw this frame would not be on the GPU yet.
      expect(paint.nextArrival, `frame ${f}`).toBeGreaterThan(now);
    }
    expect(paint.pendingPatches, 'and the wave really did finish inside a second').toBe(0);
  });

  it('MUST never be early: no write ever carries a paintTime past the clock that wrote it', () => {
    // The law vision §3.6 rests on. A future stamp is not a harmless head start — the shader's
    // `age >= 0` gate stops drawing that surfel, so an early write un-draws known geometry.
    const events = trio();
    field.resetPaint();
    const paint = pipeline();

    const check = (now: number, label: string): void => {
      let worst = -Infinity;
      for (let i = 0; i < field.count; i++) {
        const p = field.paintTime[i]!;
        if (p !== UNPAINTED && p > worst) worst = p;
      }
      for (let k = 0; k < field.edgeCount * 2; k++) {
        const p = field.edgePaintTime[k]!;
        if (p !== UNPAINTED && p > worst) worst = p;
      }
      expect(worst, `${label}: a surfel is stamped ${(worst - now) * 1000} ms in the future`).toBeLessThanOrEqual(
        now + 1e-9,
      );
    };

    // `hear()` itself is a write site, and its clock is the event's own time.
    for (const e of events) {
      paint.hear(e);
      check(e.time, `hear(${e.class} @ ${e.time})`);
    }
    for (let f = 0; f < 60; f++) {
      const now = f / 60;
      paint.pump(now);
      check(now, `pump(${now})`);
    }
    // settle() obeys the same rule for a finite clock…
    field.resetPaint();
    const p2 = pipeline();
    for (const e of events) p2.hear(e);
    p2.settle(0.05);
    check(0.05, 'settle(0.05)');
    // …and settle(Infinity) is the only clock under which a future stamp is not future.
    p2.settle(Infinity);
    expect(p2.pendingPatches).toBe(0);
  });

  it('MUST paint an instant class wholly inside hear() — a footstep has nothing to wait for', () => {
    field.resetPaint();
    const paint = pipeline(5);
    const ref = converged([makeEvent({ class: 'walkStep', source: 'self', x: 5, y: 0, z: 6 })]);

    field.resetPaint();
    paint.hear(makeEvent({ class: 'walkStep', source: 'self', x: 5, y: 0, z: 6 }));
    expect(field.paintedDots).toBeGreaterThan(0);
    expect(paint.pendingPatches, 'nothing was queued').toBe(0);
    expectSame(snapshot(), ref, 'instant class inside hear()');
  });

  // --- the shape of the schedule -------------------------------------------------------------

  it('gives a consumer that never pumps the instant classes and nothing else', () => {
    // REWRITTEN from "amortize defaults off, so a consumer that never pumps is fully synchronous".
    // The flag is gone and with it the second code path: a wave-speed sound is ALWAYS scheduled,
    // because painting it whole would mean writing its far shells before they had arrived.
    field.resetPaint();
    const paint = pipeline();
    paint.hear(blast());
    expect(field.paintedDots, 'a travelling sound has not arrived anywhere yet').toBe(0);
    expect(paint.pendingPatches).toBeGreaterThan(0);

    paint.hear(makeEvent({ class: 'walkStep', source: 'self', x: 15, y: 0, z: 6 }));
    expect(field.paintedDots, 'but an instant one is painted on the spot').toBeGreaterThan(0);
  });

  it('hands one frame only the slice of work its own wavefront released', () => {
    // REWRITTEN from the budget specs. There is no budget: what bounds a frame is the wavefront,
    // and the bound is a law rather than a tuning value, because painting ahead of it is the bug.
    field.resetPaint();
    const paint = pipeline();
    paint.hear(blast());
    const total = paint.pendingPatches;
    expect(total).toBeGreaterThan(100);

    paint.pump(0);
    expect(paint.pendingPatches, 'at t=0 the blast has travelled nowhere').toBe(total);

    // The first shell lands about a third of a frame in — one patch radius plus the fuzz
    // allowance, at 140 m/s. Three frames in the wave is 7 m out and has released a slice.
    paint.pump(3 / 60);
    const soFar = total - paint.pendingPatches;
    expect(soFar).toBeGreaterThan(0);
    expect(soFar, 'a wavefront hands over a slice, not the job').toBeLessThan(total * 0.25);

    // 22 m at 140 m/s is 157 ms, so by a third of a second the wave has passed everything.
    for (let f = 2; f <= 25; f++) paint.pump(f / 60);
    expect(paint.pendingPatches).toBe(0);
  });

  it('pays the WHOLE due backlog in one call — the accepted spike (engine-plan §3, M5 item)', () => {
    // MIGRATED, and still a PIN rather than a fix. Due work is unbudgeted on purpose: a late patch
    // is a hole in the world. The cost is that a consumer which lets several wave events go past
    // their arrival before pumping — one long frame, a tab regaining focus, a load hitch, a script
    // scrubbing time forward — pays for ALL of them in one call. Recorded in engine-plan §3 as an
    // open M5 tuning item (a hard per-frame ceiling, preferring bounded lateness to a dropped
    // frame); pinned here so the trade-off is deliberate and any change to it is visible.
    field.resetPaint();
    const paint = pipeline();
    const bus = new EventBus();
    bus.now = 0;
    for (let i = 0; i < 12; i++) {
      paint.hear(
        bus.emit({
          class: 'detonation',
          source: 'detonation',
          x: 3 + i * 2,
          y: 1.6,
          z: 6,
          paintRadius: 20,
          hearRadius: 90,
          intensity: 1,
          waveSpeed: WAVE_SPEED_DETONATION,
        }),
      );
    }
    const queued = paint.pendingPatches;
    expect(queued).toBeGreaterThan(500);

    // One pump, one second later: everything is due, and all of it is paid at once.
    paint.pump(1.0);
    expect(paint.pendingPatches, `one pump left ${paint.pendingPatches} of ${queued} queued`).toBe(0);
  });

  it('releases a patch only once its FARTHEST member is due, and by a bounded margin', () => {
    // MIGRATED AND INVERTED from "the conservative arrival never exceeds any member's true
    // arrival". The bound used to be EARLY (centre − patchRadius − WALL_FUZZ) so that no member
    // could be painted after its own wavefront; being early was thought to be free. It is not —
    // an early write is a future stamp, and a future stamp un-draws the surface (see MUST never be
    // early). The bound is now LATE (centre + patchRadius + fuzz), and this is its cost.
    const e = blast();
    const fuzzMag = Math.min(WALL_FUZZ, WALL1_RADIUS * e.paintRadius);
    let worstLate = 0;
    for (let p = 0; p < field.patchCount; p++) {
      const dc = Math.hypot(
        field.patchCentre[p * 3]! - e.origin[0],
        field.patchCentre[p * 3 + 1]! - e.origin[1],
        field.patchCentre[p * 3 + 2]! - e.origin[2],
      );
      const prad = field.patchRadius[p]!;
      if (dc - prad > e.paintRadius) continue;
      const arrive = (dc + prad + fuzzMag) / WAVE_SPEED_DETONATION;
      const d0 = field.patchDotStart[p]!;
      for (let i = d0; i < d0 + field.patchDotCount[p]!; i++) {
        const d = Math.hypot(
          field.positions[i * 3]! - e.origin[0],
          field.positions[i * 3 + 1]! - e.origin[1],
          field.positions[i * 3 + 2]! - e.origin[2],
        );
        // Worst case the other way: a one-wall patch paints from an origin displaced up to
        // fuzzMag TOWARDS the dot, so its true stamp can be that much earlier.
        const trueStamp = Math.max(0, d - fuzzMag) / WAVE_SPEED_DETONATION;
        expect(arrive, `patch ${p} releases before dot ${i} is due`).toBeGreaterThanOrEqual(trueStamp - 1e-9);
        worstLate = Math.max(worstLate, arrive - trueStamp);
      }
    }
    // The margin is (2·patchRadius + 2·fuzz)/waveSpeed and nothing more — ~41 ms for a detonation,
    // two or three frames. Invisible; an early write is not.
    const bound = (2 * Math.max(...Array.from(field.patchRadius)) + 2 * fuzzMag) / WAVE_SPEED_DETONATION;
    expect(worstLate).toBeLessThanOrEqual(bound + 1e-9);
    expect(worstLate).toBeLessThan(0.05);
  });

  it('settles a cone event (E-ping) to exactly the converged cone', () => {
    const e = makeEvent({
      class: 'ePing',
      source: 'self',
      x: 4,
      y: 1.6,
      z: 6,
      cone: { dir: [1, 0, 0], angleDeg: 25 },
      paintRadius: 30,
      hearRadius: 40,
      intensity: 1,
      waveSpeed: WAVE_SPEED_E,
    });
    expect(e.cone).toBeDefined();
    const ref = converged([e]);
    expect(ref.dots).toBeGreaterThan(100);

    field.resetPaint();
    const paint = pipeline(4);
    paint.hear(e);
    paint.settle(Infinity);
    expectSame(snapshot(), ref, 'settled cone');
  });

  it('survives a clock that goes backwards without painting anything early', () => {
    field.resetPaint();
    const paint = pipeline();
    paint.hear(blast());
    paint.pump(0.05);
    const after = field.paintedDots;
    expect(after).toBeGreaterThan(0);
    // A sim reset rewinds the render clock. Nothing may be painted, and nothing may crash.
    paint.pump(0);
    paint.pump(-5);
    expect(field.paintedDots).toBe(after);
    expect(paint.pendingPatches).toBeGreaterThan(0);
  });

  it('drops in-flight jobs on reset() and dispose(), which can never resurrect into a new run', () => {
    field.resetPaint();
    const paint = pipeline();
    paint.hear(blast());
    expect(paint.pendingPatches).toBeGreaterThan(0);
    paint.reset();
    expect(paint.pendingPatches).toBe(0);
    expect(paint.nextArrival).toBe(Infinity);
    paint.settle(Infinity);
    expect(field.paintedDots, 'a dropped job must not paint into the new run').toBe(0);

    const p2 = pipeline();
    p2.hear(blast());
    p2.dispose();
    expect(p2.pendingPatches).toBe(0);
    p2.settle(Infinity);
    expect(field.paintedDots).toBe(0);
  });

  it('never reads a wall clock or an unseeded random on any paint path', () => {
    field.resetPaint();
    const realRandom = Math.random;
    const realDateNow = Date.now;
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    const realPerf = perf?.now;
    let random = 0;
    let dateNow = 0;
    let perfNow = 0;
    try {
      Math.random = (): number => {
        random++;
        return 0.5;
      };
      Date.now = (): number => {
        dateNow++;
        return 0;
      };
      if (perf && realPerf) {
        perf.now = (): number => {
          perfNow++;
          return 0;
        };
      }
      const paint = pipeline();
      expect(paint.profile, 'profiling is opt-in, and it is the only clock read there is').toBe(false);
      for (const e of trio()) paint.hear(e);
      for (let f = 0; f < 40; f++) {
        paint.pump(f / 60);
        paint.flush();
      }
      paint.settle(Infinity);
      paint.reset();
      paint.dispose();
    } finally {
      Math.random = realRandom;
      Date.now = realDateNow;
      if (perf && realPerf) perf.now = realPerf;
    }
    expect(
      [random, dateNow, perfNow],
      `Math.random x${random}, Date.now x${dateNow}, performance.now x${perfNow}`,
    ).toEqual([0, 0, 0]);
  });
});

/**
 * VISION §3.6 — "you never lose the map".
 *
 * "Scanned geometry is kept for the whole run: detail decays with age, but every surface cools into
 * a permanent dim memory skeleton — you never lose the map, only the fine read."
 *
 * The shader draws a surfel when `paintTime > sentinel && uNow - paintTime >= 0`, so `paintTime`
 * is not only a colour, it is a VISIBILITY gate. Writing a future time onto a surface the player
 * already owned therefore does not brighten it later — it blanks it now, for as long as the
 * wavefront takes to arrive. These specs walk a route until it is a cool memory skeleton and then
 * set off the loudest thing in the game on top of it.
 */
describe('a new sound never un-draws the map (vision §3.6)', () => {
  /** Walk the length of the gym on ordinary instant footsteps, listener following. */
  const walkRoute = (paint: PaintPipeline, from: number, to: number, t0: number): void => {
    let t = t0;
    for (let x = from; x <= to; x += 1) {
      paint.setListener(x, 1.6, 6);
      paint.hear(makeEvent({ class: 'walkStep', source: 'self', x, y: 0.1, z: 6 }, t));
      t += 0.35;
    }
  };

  /** Everything the shader would be drawing at `now`. */
  const drawnAt = (now: number): Uint8Array => {
    const out = new Uint8Array(field.count);
    for (let i = 0; i < field.count; i++) {
      const p = field.paintTime[i]!;
      if (p !== UNPAINTED && p <= now) out[i] = 1;
    }
    return out;
  };

  const countBlanked = (was: Uint8Array, now: number): { blanked: number; worstMs: number } => {
    let blanked = 0;
    let worst = 0;
    for (let i = 0; i < field.count; i++) {
      if (!was[i]) continue;
      const p = field.paintTime[i]!;
      if (p === UNPAINTED || p > now) {
        blanked++;
        worst = Math.max(worst, p === UNPAINTED ? Infinity : p - now);
      }
    }
    return { blanked, worstMs: worst * 1000 };
  };

  const loud = (over: Partial<EmitSpec>, time: number): SoundEvent =>
    makeEvent(
      {
        class: 'detonation',
        source: 'detonation',
        x: 15,
        y: 1.0,
        z: 6,
        paintRadius: 22,
        hearRadius: 60,
        intensity: 1,
        waveSpeed: WAVE_SPEED_DETONATION,
        ...over,
      },
      time,
    );

  it('keeps every dot a detonation sweeps drawn, on every frame of its flight', () => {
    const paint = new PaintPipeline(field, gym);
    walkRoute(paint, 1, 29, 0);

    const t0 = 20; // twenty seconds in: the route is a cool memory skeleton
    const was = drawnAt(t0);
    let known = 0;
    for (const v of was) known += v;
    expect(known, 'the route really is a map worth losing').toBeGreaterThan(1_000);

    paint.setListener(15, 1.6, 6);
    paint.hear(loud({}, t0));

    // Every frame of the wavefront's flight, not just the end. A blank that heals in 150 ms is
    // still a blank the player watched happen.
    for (let f = 0; f <= 40; f++) {
      const now = t0 + f / 60;
      paint.pump(now);
      const { blanked, worstMs } = countBlanked(was, now);
      expect(blanked, `frame ${f}: ${blanked} known dots un-drawn for up to ${worstMs.toFixed(0)} ms`).toBe(0);
    }
    expect(paint.pendingPatches).toBe(0);
    // …and the blast really did do something: it lit the walls the footsteps never reached.
    let after = 0;
    for (const v of drawnAt(t0 + 1)) after += v;
    expect(after).toBeGreaterThan(known);
  });

  it('keeps the geometry ahead of you drawn while an E-ping crosses it', () => {
    const paint = new PaintPipeline(field, gym);
    walkRoute(paint, 1, 29, 0);

    const t0 = 30;
    const was = drawnAt(t0);
    let known = 0;
    for (const v of was) known += v;
    expect(known).toBeGreaterThan(1_000);

    paint.setListener(2, 1.6, 6);
    paint.hear(
      loud(
        {
          class: 'ePing',
          source: 'self',
          x: 2,
          y: 1.6,
          z: 6,
          cone: { dir: [1, 0, 0], angleDeg: 25 },
          paintRadius: 40,
          hearRadius: 30,
          waveSpeed: WAVE_SPEED_E,
        },
        t0,
      ),
    );
    for (let f = 0; f <= 60; f++) {
      const now = t0 + f / 60;
      paint.pump(now);
      const { blanked, worstMs } = countBlanked(was, now);
      expect(blanked, `frame ${f}: E-ping un-drew ${blanked} of ${known} known dots (${worstMs.toFixed(0)} ms)`).toBe(0);
    }
  });

  it('never lets paintTime move backwards, so a re-heard surface never reads older', () => {
    // A detonation at t=10 stamps a dot 14 m out at 10.10. A landing 50 ms later (instant, 14 m of
    // paint) reaches the same dot and would stamp it 10.05. Age is a colour (vision §1.3 / §3.2):
    // a surface that was just re-heard must never read older than it did a frame ago.
    const paint = new PaintPipeline(field, gym);
    paint.setListener(15, 1.6, 6);
    paint.hear(loud({}, 10));
    paint.settle(Infinity);
    const stamped = Float32Array.from(field.paintTime);

    paint.hear(makeEvent({ class: 'landing', source: 'self', x: 15, y: 0.1, z: 6, paintRadius: 14 }, 10.05));

    let aged = 0;
    let worst = 0;
    let refreshed = 0;
    for (let i = 0; i < field.count; i++) {
      const before = stamped[i]!;
      if (before === UNPAINTED) continue;
      const after = field.paintTime[i]!;
      if (after < before) {
        aged++;
        worst = Math.max(worst, before - after);
      }
      if (after > before) refreshed++;
    }
    expect(aged, `${aged} surfels got OLDER by up to ${(worst * 1000).toFixed(0)} ms`).toBe(0);
    // The landing is not a no-op: the near dots the blast stamped BEFORE 10.05 are refreshed.
    expect(refreshed, 'a newer sound still refreshes what it genuinely reaches later').toBeGreaterThan(0);
  });

  it('grows the set of ever-painted dots monotonically, and counts each one once', () => {
    const paint = new PaintPipeline(field, gym);
    let ever = 0;
    const seen = new Uint8Array(field.count);
    for (let k = 0; k < 8; k++) {
      paint.setListener(2 + k * 3, 1.6, 6);
      paint.hear(makeEvent({ class: 'sprintStep', source: 'self', x: 2 + k * 3, y: 0.1, z: 6 }, k * 0.4));
      for (let i = 0; i < field.count; i++) {
        if (field.paintTime[i] !== UNPAINTED && !seen[i]) {
          seen[i] = 1;
          ever++;
        }
      }
      expect(field.paintedDots, `after ${k + 1} steps`).toBe(ever);
    }
    expect(ever).toBeGreaterThan(500);
  });
});

// ------------------------------------------------------------------------------------------

describe('a zero-radius event is heard and blind (engine-plan §6)', () => {
  /** Fire one E-ping down the paint gym at wallA and return the far end it scheduled. */
  const farEnd = (): { sim: Sim; far: SoundEvent } => {
    const sim = new Sim(gymMap);
    const p = sim.player;
    p.x = 2;
    p.y = 0;
    p.z = 6;
    p.yaw = 0; // +x, into wallA's near face at 9.8
    p.pitch = 0;
    sim.bus.now = PING_COOLDOWN;
    let far: SoundEvent | null = null;
    const off = sim.bus.on((e) => {
      if (e.variant === 'far') far = e;
    });
    sim.playerSystems.intent.pingE = true;
    for (let i = 0; i < 60; i++) sim.step(SIM_STEP);
    off();
    expect(far, 'the beam has to have landed on wallA').not.toBeNull();
    return { sim, far: far! };
  };

  it('MUST deliver the E far end to a listener standing on it and still light nothing', () => {
    // The cone already painted everything the beam swept. A sphere at the impact centre would hand
    // the player geometry around a corner they never illuminated — vision §3.1 prices every metre
    // of light, so the far end buys hearing only. The listener is placed exactly ON the origin:
    // the most favourable case there is for the event to paint something.
    const { sim, far } = farEnd();
    expect(far.paintRadius).toBe(0);

    const fresh = bakeSurfels(sim.world);
    const pipe = new PaintPipeline(fresh, sim.world);
    pipe.setListener(far.origin[0], far.origin[1], far.origin[2]);
    expect(fresh.paintedDots).toBe(0);

    const delivered = pipe.hear(far);
    pipe.pump(far.time + 10);

    expect(delivered).not.toBeNull(); // hearable…
    expect(pipe.heard).toBe(1);
    expect(pipe.missed).toBe(0);
    expect(fresh.paintedDots).toBe(0); // …and blind.
    expect(fresh.paintedEdgeVerts).toBe(0);
    expect(pipe.pendingPatches).toBe(0);
  });
});
