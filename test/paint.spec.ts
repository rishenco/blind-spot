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
  HEARING_BASE,
  WALL1_INTENSITY,
  WALL1_QUALITY,
  WALL1_RADIUS,
  WALL_FUZZ,
  WAVE_SPEED_DETONATION,
} from '../src/core/const.js';
import { EventBus, type EmitSpec, type SoundEvent } from '../src/core/events.js';
import { eventQuality } from '../src/core/math.js';
import { buildWorld } from '../src/core/map/build.js';
import type { MapDef, Solid, SolidKind } from '../src/core/map/types.js';
import { applyEvent, deliverTo, fuzzVector, PaintPipeline, RangeAccum, withDelivery } from '../src/core/paint.js';
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
    const reach = e.paintRadius * WALL1_RADIUS + WALL_FUZZ;
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

  it('lets a rescan refresh age without letting it dim the surface below 85 %', () => {
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
    const after = field.paintIntensity[pick]!;
    const heard = expectedI(0.25, distTo(field, pick, 5, 1.6, 6), 5);
    expect(heard).toBeLessThan(before * 0.85);
    expect(after).toBeCloseTo(before * 0.85, 6);
    // Age is what a rescan really buys you: the surface is a touch dimmer and freshly known.
    expect(field.paintTime[pick]).toBe(9);

    // …and a louder rescan takes the loud value outright.
    applyEvent(field, gym, cleanPing({ intensity: 1 }, 11), null, null);
    expect(field.paintIntensity[pick]).toBeCloseTo(before, 6);
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
});

// ------------------------------------------------------------------------------------------

/**
 * Amortized paint (engine-plan §10 budget; vision §12 "60 fps on a mid-range GPU").
 *
 * A 22 m detonation is the most paint work the engine ever does, and it fires at the loudest
 * moment in the game — the worst possible place for a frame hitch. It is therefore scheduled
 * against its own wavefront instead of being painted in one blocking call.
 *
 * Two things have to be true at once, and they pull in opposite directions:
 *
 *   BOUNDED  no frame does more than a slice of the work, or the hitch is just moved.
 *   HONEST   no surfel is painted after the moment its own sound reached it. The shader draws a
 *            surfel as soon as `now >= paintTime`, so a late patch is a hole in the world that
 *            appears a frame after the blast has already lit everything around it — the system
 *            visibly lying about when the sound got there (design law 2).
 *
 * The schedule buys both by only ever budgeting work AHEAD of the wavefront. These specs pin
 * that: the settled picture is identical to the synchronous one, nothing is ever late even with
 * the work-ahead budget set to zero, and the first frame's share is a small fraction of the job.
 */
describe('amortized paint: spreading a blast over its own wavefront (engine-plan §10)', () => {
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

  /** Paint `e` in one synchronous call and snapshot the result. */
  const reference = (e: SoundEvent): { time: Float32Array; intensity: Float32Array; dots: number } => {
    field.resetPaint();
    applyEvent(field, gym, e, null, null);
    return {
      time: Float32Array.from(field.paintTime),
      intensity: Float32Array.from(field.paintIntensity),
      dots: field.paintedDots,
    };
  };

  const pipeline = (): PaintPipeline => {
    const p = new PaintPipeline(field, gym);
    p.amortize = true;
    p.setListener(15, 1.6, 6);
    return p;
  };

  it('MUST settle to exactly the picture one synchronous call would have made', () => {
    const e = blast();
    const ref = reference(e);
    expect(ref.dots).toBeGreaterThan(1_000); // the fixture is actually a stress case

    field.resetPaint();
    const paint = pipeline();
    paint.hear(e);
    // Nothing yet: the sound has not travelled anywhere. Queued, not painted.
    expect(field.paintedDots).toBe(0);
    expect(paint.pendingPatches).toBeGreaterThan(0);

    paint.settle(10);
    expect(paint.pendingPatches).toBe(0);
    expect(field.paintedDots).toBe(ref.dots);
    // Byte-identical, not merely similar: patches own disjoint dot and segment runs, so the
    // order they are visited in cannot change a single write.
    expect(Array.from(field.paintTime)).toEqual(Array.from(ref.time));
    expect(Array.from(field.paintIntensity)).toEqual(Array.from(ref.intensity));
  });

  it('MUST never paint a surfel later than the moment its sound arrived', () => {
    const e = blast();
    const ref = reference(e);

    field.resetPaint();
    const paint = pipeline();
    paint.hear(e);

    // Budget ZERO: no work-ahead at all, so every patch is painted on the exact frame its
    // wavefront reaches it and nothing is carried by slack. The strictest form of the promise.
    let late = 0;
    let firstVisibleFrame = -1;
    for (let f = 0; f < 60; f++) {
      const now = f / 60;
      paint.pump(now, 0);
      for (let i = 0; i < field.count; i++) {
        const due = ref.time[i]!;
        if (due === UNPAINTED || due > now) continue;
        // The shader would be drawing this surfel on this frame. It had better be painted.
        if (field.paintTime[i] === UNPAINTED) late++;
        else if (firstVisibleFrame < 0) firstVisibleFrame = f;
      }
    }
    expect(late).toBe(0);
    // And it really was a wavefront, not an instant flash disguised as one.
    expect(firstVisibleFrame).toBeGreaterThanOrEqual(0);
    expect(field.paintedDots).toBe(ref.dots);
    expect(paint.pendingPatches).toBe(0);
  });

  it('MUST hand any one frame only a small slice of the work', () => {
    const e = blast();
    field.resetPaint();
    const paint = pipeline();
    paint.hear(e);

    const total = paint.pendingPatches;
    expect(total).toBeGreaterThan(100);

    // The frame the blast goes off, with no work-ahead: only what the sound has already touched.
    paint.pump(0, 0);
    const firstFrame = total - paint.pendingPatches;
    expect(firstFrame).toBeGreaterThan(0);
    expect(firstFrame).toBeLessThan(total * 0.25);

    // 22 m at 140 m/s is 157 ms, so by a third of a second the wave has passed everything and
    // the queue must be empty whether or not any budget was ever spent.
    for (let f = 1; f <= 20; f++) paint.pump(f / 60, 0);
    expect(paint.pendingPatches).toBe(0);
  });

  it('MUST keep instant classes synchronous — a footstep has nothing to wait for', () => {
    field.resetPaint();
    const paint = pipeline();
    // waveSpeed Infinity: the whole event is due the moment it is emitted.
    paint.hear(makeEvent({ class: 'walkStep', source: 'self', x: 5, y: 0, z: 6 }));
    expect(field.paintedDots).toBeGreaterThan(0);
    expect(paint.pendingPatches).toBe(0);
  });

  it('MUST stay synchronous for a consumer that never pumps', () => {
    field.resetPaint();
    // Default off: a spec, a replay or a headless consumer can `hear()` and read the field back
    // in the same breath. Only something running a frame loop opts in.
    const paint = new PaintPipeline(field, gym);
    expect(paint.amortize).toBe(false);
    paint.setListener(15, 1.6, 6);
    paint.hear(blast());
    expect(field.paintedDots).toBeGreaterThan(1_000);
    expect(paint.pendingPatches).toBe(0);
  });
});
