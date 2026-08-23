/**
 * REVIEW PROBE — milestone 3, claim 1 (the amortization contract) and claim 2 (behavioural half).
 *
 * The claims:
 *   1a  after `settle()` the picture is EXACTLY the picture the synchronous path would have made
 *   1b  no patch is painted later than its conservative wavefront arrival time
 *   1c  the per-frame pump slice is bounded by budgetMs (pass 2 only)
 *   1d  instant classes (waveSpeed Infinity) paint synchronously inside `hear()`
 *   1e  a consumer that never calls pump gets fully synchronous behaviour
 *   2   "patches own disjoint dot/segment buffer runs, so paint ORDER cannot change any written
 *       value" (src/core/paint.ts:337-340 and test/paint.spec.ts:707-708)
 *
 * The existing suite exercises all of these with exactly ONE event in flight. Two overlapping
 * events share dots, and the two writes at src/core/paint.ts:468 (`pt[i] = t`, last writer wins)
 * and :470 (`pi[i] = max(I, old*0.85)`, non-commutative) are both order-sensitive.
 */

import { describe, expect, it } from 'vitest';
import { WAVE_SPEED_DETONATION, WAVE_SPEED_E } from '../../src/core/const.js';
import { EventBus, type EmitSpec, type SoundEvent } from '../../src/core/events.js';
import { buildWorld } from '../../src/core/map/build.js';
import type { MapDef, Solid, SolidKind } from '../../src/core/map/types.js';
import { applyEvent, PaintPipeline } from '../../src/core/paint.js';
import { bakeSurfels, UNPAINTED, type SurfelField } from '../../src/core/surfels.js';

// ---------------------------------------------------------------------------------------------
// Fixture: a bare 40 x 12 m hall. No walls, so no fuzz and no LOS surprises — the only variable
// left is the order patches are visited in.
// ---------------------------------------------------------------------------------------------

const box = (id: string, kind: SolidKind, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Solid => ({
  type: 'box',
  id,
  kind,
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});

const hallMap: MapDef = {
  name: 'review hall',
  solids: [
    box('floor', 'floor', 0, -0.4, 0, 40, 0, 12),
    box('pillarA', 'crate', 14, 0, 5, 15, 3, 6),
    box('pillarB', 'crate', 24, 0, 5, 25, 3, 6),
  ],
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [1, 0, 1], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [40, 6, 12] }],
  markers: [],
  bounds: { min: [0, -0.4, 0], max: [40, 6, 12] },
};

const hall = buildWorld(hallMap);
const field: SurfelField = bakeSurfels(hall);

/** One bus for the pair so the two events get distinct ids (and therefore distinct fuzz seeds). */
const pair = (): [SoundEvent, SoundEvent] => {
  const bus = new EventBus();
  bus.now = 0;
  const spec = (over: Partial<EmitSpec>): EmitSpec => ({
    class: 'detonation',
    source: 'detonation',
    x: 0,
    y: 1.6,
    z: 6,
    paintRadius: 20,
    hearRadius: 80,
    intensity: 1,
    waveSpeed: WAVE_SPEED_DETONATION,
    ...over,
  });
  // A: far from the overlap, so its wavefront gets there late.
  const a = bus.emit(spec({ x: 8, paintRadius: 20 }));
  // B: sitting in the overlap, so its wavefront gets there at once.
  const b = bus.emit(spec({ x: 22, paintRadius: 8 }));
  return [a, b];
};

interface Snapshot {
  time: Float32Array;
  intensity: Float32Array;
  edgeTime: Float32Array;
  dots: number;
}

const snapshot = (): Snapshot => ({
  time: Float32Array.from(field.paintTime),
  intensity: Float32Array.from(field.paintIntensity),
  edgeTime: Float32Array.from(field.edgePaintTime),
  dots: field.paintedDots,
});

/** The picture a non-amortizing consumer makes: every event applied whole, in emission order. */
const synchronous = (events: readonly SoundEvent[]): Snapshot => {
  field.resetPaint();
  for (const e of events) applyEvent(field, hall, e, null, null);
  return snapshot();
};

const pipeline = (lx = 15): PaintPipeline => {
  const p = new PaintPipeline(field, hall);
  p.amortize = true;
  p.setListener(lx, 1.6, 6);
  return p;
};

const diffCount = (a: Float32Array, b: Float32Array): number => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

// ---------------------------------------------------------------------------------------------

describe('claim 1a / claim 2 — does the schedule really reproduce the synchronous picture?', () => {
  it('PIN: with ONE event in flight, settle() is byte-identical to the synchronous call', () => {
    const [a] = pair();
    const ref = synchronous([a]);
    expect(ref.dots).toBeGreaterThan(500);

    field.resetPaint();
    const paint = pipeline(8);
    paint.hear(a);
    expect(field.paintedDots).toBe(0);
    paint.settle(10);
    expect(paint.pendingPatches).toBe(0);
    expect(field.paintedDots).toBe(ref.dots);
    expect(diffCount(field.paintTime, ref.time)).toBe(0);
    expect(diffCount(field.paintIntensity, ref.intensity)).toBe(0);
  });

  it('BUG: settle() does NOT reproduce the synchronous picture once two events overlap', () => {
    // The premise of claim 2 is that patch runs are disjoint, so visit order cannot matter. That
    // is true WITHIN one event. Two events share dots, and `settle(now)` visits them in neither
    // emission order nor arrival order: pass 1 drains each job's DUE prefix job-by-job, then
    // pass 2 drains the remainders job-by-job (src/core/paint.ts:757-769). A patch that is due
    // for job B but not yet for job A is therefore painted B-then-A, the reverse of synchronous.
    const [a, b] = pair();
    const ref = synchronous([a, b]);

    field.resetPaint();
    const paint = pipeline();
    paint.hear(a);
    paint.hear(b);
    // 0.02 s after the blasts: B's wavefront has covered its whole 8 m, A's has not.
    paint.settle(0.02);
    expect(paint.pendingPatches).toBe(0);

    expect(field.paintedDots).toBe(ref.dots); // the SET of lit dots is order-independent
    // …but the VALUES are not.
    expect(
      diffCount(field.paintTime, ref.time),
      'settle() produced different paintTime values than the synchronous path',
    ).toBe(0);
    expect(
      diffCount(field.paintIntensity, ref.intensity),
      'settle() produced different paintIntensity values than the synchronous path',
    ).toBe(0);
  });

  it('BUG: the per-frame pump path diverges from the synchronous picture too', () => {
    // This is the shape production actually runs (src/main.ts: hear during the sim step, then one
    // pump per frame with the render clock).
    const [a, b] = pair();
    const ref = synchronous([a, b]);

    field.resetPaint();
    const paint = pipeline();
    paint.hear(a);
    paint.hear(b);
    for (let f = 0; f < 40; f++) paint.pump(f / 60, 0); // budget 0 == due work only
    expect(paint.pendingPatches).toBe(0);

    expect(diffCount(field.paintTime, ref.time), 'paintTime differs after per-frame pump').toBe(0);
    expect(diffCount(field.paintIntensity, ref.intensity), 'paintIntensity differs after per-frame pump').toBe(0);
  });

  it('PIN: the divergence is real and measurable, not float noise (diagnostic for the two BUGs above)', () => {
    const [a, b] = pair();
    const ref = synchronous([a, b]);

    field.resetPaint();
    const paint = pipeline();
    paint.hear(a);
    paint.hear(b);
    paint.settle(0.02);

    const tDiff = diffCount(field.paintTime, ref.time);
    const iDiff = diffCount(field.paintIntensity, ref.intensity);
    // Order-dependence touches thousands of dots, and the intensity gap is far above float slack.
    expect(tDiff).toBeGreaterThan(100);
    let worstI = 0;
    for (let i = 0; i < field.count; i++) {
      worstI = Math.max(worstI, Math.abs(field.paintIntensity[i]! - ref.intensity[i]!));
    }
    expect(iDiff).toBeGreaterThan(0);
    expect(worstI).toBeGreaterThan(1e-3);
    field.resetPaint();
  });
});

describe('claim 1b — nothing is painted after its own wavefront', () => {
  it('PIN: with budget 0, every dot the reference says is due has been painted by that frame', () => {
    const [a] = pair();
    const ref = synchronous([a]);

    field.resetPaint();
    const paint = pipeline(8);
    paint.hear(a);
    let late = 0;
    for (let f = 0; f < 40; f++) {
      const now = f / 60;
      paint.pump(now, 0);
      for (let i = 0; i < field.count; i++) {
        const due = ref.time[i]!;
        if (due === UNPAINTED || due > now) continue;
        if (field.paintTime[i] === UNPAINTED) late++;
      }
    }
    expect(late).toBe(0);
  });

  it('PIN: the conservative arrival never exceeds any member dot’s true arrival (claim 3)', () => {
    // arrive = time + max(0, |centre-origin| - patchRadius - WALL_FUZZ)/wave, and paintPatch
    // stamps t = time + |dot-origin|/wave — measured from the FUZZED origin when the patch is
    // through a wall. Checked here against every dot AND the worst-case 2 m fuzz displacement.
    const [a] = pair();
    const ox = a.origin[0];
    const oy = a.origin[1];
    const oz = a.origin[2];
    for (let p = 0; p < field.patchCount; p++) {
      const cx = field.patchCentre[p * 3]!;
      const cy = field.patchCentre[p * 3 + 1]!;
      const cz = field.patchCentre[p * 3 + 2]!;
      const prad = field.patchRadius[p]!;
      const arrive = Math.max(0, Math.hypot(cx - ox, cy - oy, cz - oz) - prad - 2.0);
      const d0 = field.patchDotStart[p]!;
      for (let i = d0; i < d0 + field.patchDotCount[p]!; i++) {
        const d = Math.hypot(
          field.positions[i * 3]! - ox,
          field.positions[i * 3 + 1]! - oy,
          field.positions[i * 3 + 2]! - oz,
        );
        // Worst case: a one-wall patch paints from an origin displaced by up to WALL_FUZZ = 2 m
        // TOWARDS the dot, so its true stamp can be 2 m earlier than the unfuzzed distance.
        expect(arrive, `patch ${p} arrives after dot ${i}`).toBeLessThanOrEqual(Math.max(0, d - 2.0) + 1e-6);
      }
    }
  });
});

describe('claim 1c — is the frame slice really bounded?', () => {
  it('PIN: pass 2 respects a zero budget: one frame paints only what the wave has reached', () => {
    const [a] = pair();
    field.resetPaint();
    const paint = pipeline(8);
    paint.hear(a);
    const total = paint.pendingPatches;
    expect(total).toBeGreaterThan(50);
    paint.pump(0, 0);
    const first = total - paint.pendingPatches;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(total * 0.35);
  });

  it('PIN: pass 1 pays the WHOLE due backlog in one call, whatever budgetMs says', () => {
    // Pass 1 (src/core/paint.ts:757-759) is deliberately unbudgeted: every job's DUE work is paid
    // in full, because a late patch is a hole in the world. That is a documented trade-off, and
    // this pins its cost: a consumer that lets several wave events go past their arrival before
    // pumping — one long frame, a tab regaining focus, a load hitch, a script scrubbing time
    // forward — pays for ALL of them in one call, however small `budgetMs` is. So "the per-frame
    // pump slice is bounded by budgetMs" is true only of work AHEAD of the wavefront.
    field.resetPaint();
    const paint = pipeline();
    const bus = new EventBus();
    bus.now = 0;
    for (let i = 0; i < 12; i++) {
      paint.hear(
        bus.emit({
          class: 'detonation',
          source: 'detonation',
          x: 3 + i * 3,
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

    // One pump, one second later: everything is due, so the 3 ms budget bounds nothing.
    paint.pump(1.0, 0);
    const paintedInOnePump = queued - paint.pendingPatches;
    expect(
      paintedInOnePump,
      `one pump with a ZERO budget still painted ${paintedInOnePump} of ${queued} queued patches`,
    ).toBe(queued);
    expect(paint.pendingPatches).toBe(0);
  });
});

describe('claim 1d / 1e — the synchronous escape hatches', () => {
  it('PIN: an instant class paints inside hear(), even with amortize on', () => {
    field.resetPaint();
    const paint = pipeline(5);
    const bus = new EventBus();
    bus.now = 0;
    paint.hear(bus.emit({ class: 'walkStep', source: 'self', x: 5, y: 0, z: 6 }));
    expect(field.paintedDots).toBeGreaterThan(0);
    expect(paint.pendingPatches).toBe(0);
  });

  it('PIN: amortize defaults off, so a consumer that never pumps is fully synchronous', () => {
    field.resetPaint();
    const paint = new PaintPipeline(field, hall);
    expect(paint.amortize).toBe(false);
    paint.setListener(8, 1.6, 6);
    const [a] = pair();
    paint.hear(a);
    expect(field.paintedDots).toBeGreaterThan(500);
    expect(paint.pendingPatches).toBe(0);
  });

  it('PIN: a cone event (E-ping) is scheduled and settles to the synchronous cone', () => {
    const bus = new EventBus();
    bus.now = 0;
    const e = bus.emit({
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
    const ref = synchronous([e]);
    expect(ref.dots).toBeGreaterThan(100);

    field.resetPaint();
    const paint = pipeline(4);
    paint.hear(e);
    paint.settle(5);
    expect(field.paintedDots).toBe(ref.dots);
    expect(diffCount(field.paintTime, ref.time)).toBe(0);
    field.resetPaint();
  });
});

describe('the pump’s own clock', () => {
  it('PIN: pump survives a clock that goes backwards without painting anything early', () => {
    const [a] = pair();
    field.resetPaint();
    const paint = pipeline(8);
    paint.hear(a);
    paint.pump(0.05, 0);
    const after = field.paintedDots;
    expect(after).toBeGreaterThan(0);
    // A sim reset rewinds the render clock. Nothing may be painted, and nothing may crash.
    paint.pump(0.0, 0);
    paint.pump(-5, 0);
    expect(field.paintedDots).toBe(after);
    expect(paint.pendingPatches).toBeGreaterThan(0);
  });

  it('PIN: reset() and dispose() drop in-flight jobs, which can never resurrect into a new run', () => {
    // `reset()` clears `jobs` (src/core/paint.ts:849) and `resetPaint()`s the field, which is the
    // right thing for a run restart. The probe below is the OTHER direction: a job queued before
    // reset must not resurrect afterwards and paint into the fresh run.
    const [a] = pair();
    field.resetPaint();
    const paint = pipeline(8);
    paint.hear(a);
    expect(paint.pendingPatches).toBeGreaterThan(0);
    paint.reset();
    expect(paint.pendingPatches).toBe(0);
    paint.pump(10, Infinity);
    expect(field.paintedDots, 'a dropped job must not paint into the new run').toBe(0);
    // dispose() must do the same.
    const p2 = pipeline(8);
    p2.hear(pair()[0]);
    p2.dispose();
    expect(p2.pendingPatches).toBe(0);
    p2.pump(10, Infinity);
    expect(field.paintedDots).toBe(0);
  });
});
