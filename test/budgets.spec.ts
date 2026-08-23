/**
 * THE BUDGET REGISTRY (vision §12, engine-plan §11 "budget check").
 *
 * Vision §12 states four hard budgets: a ~1 M point ceiling, splats ≥2–3 px, "hard point-pool
 * budgets with oldest-first eviction", and 60 fps on a mid-range GPU. Three of the four are
 * structural and are pinned here. The fourth is a wall-clock property of a real browser and
 * belongs to `npm run verify`, which measures it on every capture; nothing in this file pretends
 * to assert frame rate.
 *
 * WHY A REGISTRY AND NOT MORE BEHAVIOUR. Every cap below already has its behaviour pinned by the
 * spec that owns the thing it caps — the bus ring in test/events.spec.ts, the ghost and pose caps
 * in test/dog.spec.ts, the stain ring in test/marks.spec.ts, the catch-up clamp in
 * test/sim.spec.ts, the splat floors in test/looks.spec.ts. What none of them state is the BUDGET
 * ITSELF: the list of every bounded pool in the engine and the number it is bounded at. A cap that
 * silently doubles passes every one of those specs (they all read the constant they are checking)
 * and quietly spends the memory and the frame this milestone is supposed to be counting. So the
 * numbers are written down here, once, and a tuning pass has to come and change them on purpose.
 *
 * Two pools that had no cap assertion anywhere get their behaviour here rather than only their
 * number: the paint pipeline's delivered-event ring, and the fact that the MATTER pool cannot grow
 * at all after the bake — the one budget in the game that is enforced by never allocating again.
 *
 * Nothing in this file is authorised to move a number. It is a mirror.
 */

import { describe, expect, it } from 'vitest';
import coreDebugSource from '../src/core/debug.ts?raw';
import dogSource from '../src/core/dog.ts?raw';
import paintSource from '../src/core/paint.ts?raw';
import lookSource from '../src/looks/debug/index.ts?raw';
import marksSource from '../src/looks/debug/marks.ts?raw';
import {
  CAN_MAX_BOUNCES,
  DOG_CLOUD_TARGET,
  DOG_MAX_GHOSTS,
  DOG_SMEAR_SAMPLES,
  DOG_SMEAR_WINDOW,
  EVENT_RING,
  SIM_MAX_STEPS,
  SPLAT_MIN_PX,
  SPLAT_NEAR_PX,
  SURFEL_SPACING,
  WINDOW_RADIUS,
} from '../src/core/const.js';
import { EventBus } from '../src/core/events.js';
import { PaintPipeline } from '../src/core/paint.js';
import { buildWorld } from '../src/core/map/build.js';
import { sampleMap } from '../src/core/map/sampleMap.js';
import type { MapDef } from '../src/core/map/types.js';
import { bakeSurfels } from '../src/core/surfels.js';

/** The shipped floor, baked once: every figure about the matter pool below is measured on it. */
const dockApproach = bakeSurfels(buildWorld(sampleMap));

/**
 * Read a cap that is private to its own module out of its source, the way scripts/verify.mjs
 * reads `SPLAT_CAP_FRAC`. A private cap is still a budget; not being exported is not a reason for
 * it to be the one number nobody is counting.
 */
const sourceNum = (src: string, re: RegExp, what: string): number => {
  const m = re.exec(src);
  expect(m, `${what} not found in source`).not.toBeNull();
  return Number(m![1]);
};

// ---------------------------------------------------------------------------------------------
// 1. The matter pool — the ~1 M point ceiling (vision §12)
// ---------------------------------------------------------------------------------------------

describe('the matter pool (vision §12: ~1 M point ceiling)', () => {
  it('bakes “Dock Approach” far under the ceiling, with room for the whole descent', () => {
    const c = dockApproach.counts;
    // What actually reaches the GPU: one dot per surfel, two vertices per edge segment.
    const points = c.surfels + c.edges * 2;

    // Measured on this build: 118,394 dots + 1,362 edge segments (2,724 verts) = 121,118 points,
    // at SURFEL_SPACING 0.22 over 63 solids. The law first…
    expect(points).toBeLessThan(1_000_000);
    // …and then the headroom, which is the number that makes the law survive content. Vision §7
    // is five stacked floors plus two optional deeper ones, and vision §3.6 keeps every painted
    // surface for the whole run — so the ceiling has to hold SEVEN floors of this density at once,
    // not one. It does, with ~15% to spare.
    expect(points * 7).toBeLessThan(1_000_000);
    // Not a tautology with the line above: this is the band the measured floor sits in, and it
    // catches a bake that collapsed to nothing as well as one that quietly tripled.
    expect(points).toBeGreaterThan(50_000);
    expect(points).toBeLessThan(200_000);
  });

  it('is allocated once at the bake and never grows — eviction is structurally impossible', () => {
    // The permanence law (vision §3.6): scanned geometry is kept for the whole run and cools into
    // a memory skeleton, so the matter layer is the ONE pool that must not evict. What bounds it is
    // that it is fixed-size typed arrays sized by the bake, and paint only ever writes into them.
    const c = dockApproach.counts;
    expect(dockApproach.paintTime.length).toBe(c.surfels);
    expect(dockApproach.paintIntensity.length).toBe(c.surfels);
    expect(dockApproach.edgePaintTime.length).toBe(c.edges * 2);
    expect(dockApproach.edgePaintIntensity.length).toBe(c.edges * 2);
    expect(dockApproach.geometry.getAttribute('position').count).toBe(c.surfels);
    expect(dockApproach.edgeGeometry.getAttribute('position').count).toBe(c.edges * 2);
  });

  it('keeps the lattice pitch and the render window at their published values', () => {
    expect(SURFEL_SPACING).toBe(0.22);
    // Vision §3.6/§12: the hard render cut. Data outside persists; only drawing is windowed.
    expect(WINDOW_RADIUS).toBe(45.0);
  });

  it('floors a splat above the 2–3 px readability minimum (vision §12)', () => {
    // "Splats ≥2–3 px and temporally stable — the image must survive stream compression."
    expect(SPLAT_MIN_PX).toBe(2.2);
    expect(SPLAT_NEAR_PX).toBe(4.0);
    expect(SPLAT_MIN_PX).toBeGreaterThanOrEqual(2);
    expect(SPLAT_NEAR_PX).toBeGreaterThanOrEqual(SPLAT_MIN_PX);
    // The near-field CEILING is look-private (visual-brief §2) and lives in the debug look as a
    // fraction of frame height — 1.2% of it, i.e. 12 px of a 1000 px frame. Pinned as a fraction
    // because an absolute pixel cap means a different thing in every window; test/looks.spec.ts
    // owns the shader-side ordering, scripts/verify.mjs measures what it does to a real frame.
    expect(sourceNum(lookSource, /const SPLAT_CAP_FRAC = ([0-9.]+)/, 'SPLAT_CAP_FRAC')).toBe(0.012);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The transient pools — "hard point-pool budgets with oldest-first eviction" (vision §12)
// ---------------------------------------------------------------------------------------------

describe('the transient pools are capped, and every cap is written down', () => {
  it('pins the event-layer and history caps', () => {
    // The bus's own history, and the look's copy of it (looks read this for stains).
    expect(EVENT_RING).toBe(96);
    // The paint pipeline's DELIVERED ring — the same size, but a different list: what THIS listener
    // heard, with delivery fields filled. Its default is a constructor parameter, not a const.
    expect(sourceNum(paintSource, /ringSize = (\d+)/, 'PaintPipeline ringSize')).toBe(96);
    // The debug look's stain ring (visual-brief §1.13). Behaviour in test/marks.spec.ts.
    expect(sourceNum(marksSource, /const STAIN_CAP = (\d+)/, 'STAIN_CAP')).toBe(96);
    // The top-down view's breadcrumb trail (core/debug.ts) — the only pool with no spec of its own.
    expect(sourceNum(coreDebugSource, /const TRAIL_MAX = (\d+)/, 'TRAIL_MAX')).toBe(1200);
    expect(coreDebugSource).toContain('this.trail.splice(0, this.trail.length - TRAIL_MAX * 2)');
  });

  it('pins the dog’s caps (vision §3.7: a ghost is a photograph, and there are only so many)', () => {
    expect(DOG_MAX_GHOSTS).toBe(6);
    expect(DOG_SMEAR_SAMPLES).toBe(5);
    expect(DOG_SMEAR_WINDOW).toBe(0.3);
    expect(DOG_CLOUD_TARGET).toBe(600);
    // Ghosts outlive their dog, so a despawned dog is parked as an "orphan" and those are capped
    // too — the second half of a bounded total (core/dog.ts). Private, so read from source.
    expect(sourceNum(dogSource, /const DOG_MAX_ORPHANS = (\d+)/, 'DOG_MAX_ORPHANS')).toBe(4);
    // The whole event layer's worst case, stated as one number: 4 orphans + the live dogs, each
    // holding at most DOG_MAX_GHOSTS ghosts of DOG_CLOUD_TARGET points, is a thousandth of the
    // matter pool. Vision §6 caps a floor at 6 dogs.
    const worstGhostPoints = (6 + 4) * DOG_MAX_GHOSTS * DOG_CLOUD_TARGET;
    expect(worstGhostPoints).toBeLessThan(dockApproach.counts.surfels);
  });

  it('pins the per-frame and per-prop bounds', () => {
    // The catch-up clamp: a frame may never charge the sim more than this (test/sim.spec.ts).
    expect(SIM_MAX_STEPS).toBe(5);
    // One kick is one sound, not a rattling cascade (engine-plan §8, test/props.spec.ts).
    expect(CAN_MAX_BOUNCES).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Oldest-first eviction, where it is implemented and otherwise unpinned
// ---------------------------------------------------------------------------------------------

/** Two metres of floor and nothing else: enough for an event to be delivered and to paint. */
const cellMap: MapDef = {
  name: 'budget cell',
  solids: [{ type: 'box', id: 'floor', kind: 'floor', min: [0, -0.4, 0], max: [8, 0, 8] }],
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [4, 0, 4], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [8, 4, 8] }],
  markers: [],
  bounds: { min: [0, -0.4, 0], max: [8, 4, 8] },
};

describe('the paint pipeline’s delivered ring evicts oldest-first', () => {
  it('holds the newest 96 delivered events and forgets the rest, newest first', () => {
    const world = buildWorld(cellMap);
    const paint = new PaintPipeline(bakeSurfels(world), world);
    paint.setListener(4, 1.6, 4);

    const bus = new EventBus();
    const total = 96 * 3 + 7;
    for (let i = 0; i < total; i++) {
      bus.now = i * 0.5;
      // On the listener, so every one of them is delivered — a missed event never enters the ring.
      paint.hear(bus.emit({ class: 'walkStep', source: 'self', x: 4, y: 0.1, z: 4 }));
    }
    expect(paint.heard).toBe(total);
    expect(paint.missed).toBe(0);

    const seen = paint.recent();
    expect(seen).toHaveLength(EVENT_RING);
    // Newest first, contiguous, and the oldest survivor is exactly `total - 96` events back.
    expect(seen[0]!.time).toBe((total - 1) * 0.5);
    expect(seen[EVENT_RING - 1]!.time).toBe((total - EVENT_RING) * 0.5);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.id).toBe(seen[i - 1]!.id - 1);
    // A limit asks for a prefix of the same order, never a different window.
    expect(paint.recent(5).map((e) => e.id)).toEqual(seen.slice(0, 5).map((e) => e.id));
    expect(paint.recent(500)).toHaveLength(EVENT_RING);

    // And the matter pool it painted into never moved: 288 events, same arrays (§1 above).
    expect(paint.field.paintTime.length).toBe(paint.field.counts.surfels);
  });
});
