/**
 * REVIEW PROBE — milestone 3, claim 5 ("zero nondeterminism: no Math.random / Date.now /
 * performance.now anywhere in the paint path").
 *
 * `test/sim.spec.ts:438` takes the global clocks away and asserts zero calls — but its `trace()`
 * helper (test/sim.spec.ts:390-417) builds only a `Sim`. No `PaintPipeline` is ever attached, so
 * that spec says nothing about paint, and nothing at all about `pump()`.
 *
 * `PaintPipeline.pump` calls `nowMs()` unconditionally (src/core/paint.ts:753 and :766),
 * independently of the `profile` flag, and uses the result as the pass-2 deadline. The comment at
 * src/main.ts:81-82 ("Profiling reads a wall clock, so it is a boot-layer opt-in") is therefore
 * only true of `hear()`.
 */

import { describe, expect, it } from 'vitest';
import { WAVE_SPEED_DETONATION } from '../../src/core/const.js';
import { EventBus, type EmitSpec, type SoundEvent } from '../../src/core/events.js';
import { buildWorld } from '../../src/core/map/build.js';
import type { MapDef, Solid, SolidKind } from '../../src/core/map/types.js';
import { PaintPipeline } from '../../src/core/paint.js';
import { bakeSurfels, type SurfelField } from '../../src/core/surfels.js';

const box = (id: string, kind: SolidKind, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Solid => ({
  type: 'box',
  id,
  kind,
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});

const hallMap: MapDef = {
  name: 'determinism hall',
  solids: [box('floor', 'floor', 0, -0.4, 0, 40, 0, 12), box('pillar', 'crate', 18, 0, 5, 19, 3, 6)],
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

const twoBlasts = (): [SoundEvent, SoundEvent] => {
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
  return [bus.emit(spec({ x: 8, paintRadius: 20 })), bus.emit(spec({ x: 22, paintRadius: 8 }))];
};

/** Swap `performance.now` for `clock`, run `fn`, restore. Returns the call count. */
const withClock = (clock: () => number, fn: () => void): number => {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  const real = perf?.now;
  let calls = 0;
  try {
    if (perf && real) {
      perf.now = () => {
        calls++;
        return clock();
      };
    }
    fn();
  } finally {
    if (perf && real) perf.now = real;
  }
  return calls;
};

const picture = (): Float32Array => Float32Array.from(field.paintTime);

const diff = (a: Float32Array, b: Float32Array): number => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

describe('claim 5 — is the paint path really clock-free?', () => {
  it('BUG: pump() reads performance.now even with profiling off', () => {
    field.resetPaint();
    const paint = new PaintPipeline(field, hall);
    paint.amortize = true;
    paint.profile = false;
    paint.setListener(15, 1.6, 6);
    const [a, b] = twoBlasts();
    let calls = 0;
    calls += withClock(() => 0, () => {
      paint.hear(a);
      paint.hear(b);
    });
    calls += withClock(() => 0, () => {
      for (let f = 0; f < 30; f++) paint.pump(f / 60);
    });
    expect(calls, `performance.now called ${calls} times by hear()+pump() with profile=false`).toBe(0);
  });

  it('BUG: the final picture depends on how fast the machine is', () => {
    // Same events, same sim clock, same frames — only the WALL clock differs. A machine fast
    // enough to finish the work-ahead inside 3 ms and a machine that blows the budget on the
    // first check end up with different `paintTime` values on the same surfels, because the two
    // jobs' overlapping patches get visited in a different order.
    const run = (clock: () => number): Float32Array => {
      field.resetPaint();
      const paint = new PaintPipeline(field, hall);
      paint.amortize = true;
      paint.setListener(15, 1.6, 6);
      const [a, b] = twoBlasts();
      withClock(clock, () => {
        paint.hear(a);
        paint.hear(b);
        for (let f = 0; f < 40; f++) paint.pump(f / 60);
      });
      expect(paint.pendingPatches).toBe(0);
      return picture();
    };

    // "Infinitely fast": the clock never advances, so the 3 ms budget never expires.
    const fast = run(() => 0);
    // "Hopelessly slow": every clock read jumps a second, so pass 2 gives up immediately.
    let t = 0;
    const slow = run(() => (t += 1000));

    const d = diff(fast, slow);
    expect(d, `${d} surfels carry a different paintTime depending only on wall-clock speed`).toBe(0);
  });

  it('PIN: with a SINGLE event in flight the picture is clock-independent', () => {
    // Scoping the defect: the wall clock only leaks into the result through cross-job ordering.
    const run = (clock: () => number): Float32Array => {
      field.resetPaint();
      const paint = new PaintPipeline(field, hall);
      paint.amortize = true;
      paint.setListener(8, 1.6, 6);
      const [a] = twoBlasts();
      withClock(clock, () => {
        paint.hear(a);
        for (let f = 0; f < 40; f++) paint.pump(f / 60);
      });
      return picture();
    };
    let t = 0;
    expect(diff(run(() => 0), run(() => (t += 1000)))).toBe(0);
  });

  it('PIN: no Math.random and no Date.now on any paint path', () => {
    field.resetPaint();
    const realRandom = Math.random;
    const realDateNow = Date.now;
    let random = 0;
    let dateNow = 0;
    try {
      Math.random = () => {
        random++;
        return 0.5;
      };
      Date.now = () => {
        dateNow++;
        return 0;
      };
      const paint = new PaintPipeline(field, hall);
      paint.amortize = true;
      paint.setListener(15, 1.6, 6);
      const [a, b] = twoBlasts();
      paint.hear(a);
      paint.hear(b);
      for (let f = 0; f < 40; f++) paint.pump(f / 60);
      paint.flush();
      paint.settle(2);
      paint.reset();
    } finally {
      Math.random = realRandom;
      Date.now = realDateNow;
    }
    expect([random, dateNow], `Math.random x${random}, Date.now x${dateNow}`).toEqual([0, 0]);
  });

  it('PIN: two identical runs on the same machine agree exactly (the property the suite relies on)', () => {
    const run = (): Float32Array => {
      field.resetPaint();
      const paint = new PaintPipeline(field, hall);
      paint.amortize = true;
      paint.setListener(15, 1.6, 6);
      const [a, b] = twoBlasts();
      paint.hear(a);
      paint.hear(b);
      paint.settle(10);
      return picture();
    };
    expect(diff(run(), run())).toBe(0);
  });
});
