/**
 * REVIEW PROBE — milestone 3 against the vision's laws.
 *
 *   §1.1 / §1.2  nothing is lit that no delivered sound reached; a muffled sound lands in one
 *                wrong place, and never further out than the sound itself carries.
 *   §1.3         "absence is black" — unknown space is never drawn.
 *   §3.6         "Scanned geometry is kept for the whole run… every surface cools into a permanent
 *                dim memory skeleton — you never lose the map, only the fine read."
 *
 * The §3.6 probes are the interesting ones. The shader draws a surfel only when
 * `paintTime > -1e8 && uNow - paintTime >= 0` (src/looks/debug/index.ts:122-123), and
 * `paintPatch` writes `pt[i] = t` unconditionally (src/core/paint.ts:468). A wave-speed event
 * therefore stamps FUTURE times over surfaces that were already painted — and for as long as the
 * wavefront takes to arrive, geometry the player already owned is drawn as if it had never been
 * heard at all.
 */

import { describe, expect, it } from 'vitest';
import { WAVE_SPEED_DETONATION, WAVE_SPEED_E, WAVE_SPEED_Q } from '../../src/core/const.js';
import { EventBus, type SoundEvent } from '../../src/core/events.js';
import { buildWorld } from '../../src/core/map/build.js';
import { sampleMap } from '../../src/core/map/sampleMap.js';
import { applyEvent, PaintPipeline } from '../../src/core/paint.js';
import { bakeSurfels, UNPAINTED, type SurfelField } from '../../src/core/surfels.js';

const world = buildWorld(sampleMap);
const field: SurfelField = bakeSurfels(world);

const bus = new EventBus();

const emit = (spec: Parameters<EventBus['emit']>[0], time: number): SoundEvent => {
  bus.now = time;
  return bus.emit(spec);
};

/** Walk the player along the hall, painting the route with ordinary instant footsteps. */
const walkTheRoute = (paint: PaintPipeline, from: number, to: number, t0: number): number => {
  let t = t0;
  let n = 0;
  for (let x = from; x <= to; x += 1) {
    paint.setListener(x, 1.6, 8);
    paint.hear(emit({ class: 'walkStep', source: 'self', x, y: 0.1, z: 8 }, t));
    t += 0.35;
    n++;
  }
  return n;
};

const litAt = (now: number): number => {
  let n = 0;
  for (let i = 0; i < field.count; i++) {
    const p = field.paintTime[i]!;
    if (p !== UNPAINTED && p <= now) n++;
  }
  return n;
};

// ---------------------------------------------------------------------------------------------

describe('law 1 / law 2 — nothing is lit that no delivered sound reached', () => {
  it('PIN: a fresh field is black, and an undelivered event leaves it black', () => {
    field.resetPaint();
    const paint = new PaintPipeline(field, world);
    paint.setListener(3, 1.6, 3);
    // 60 m away with an 11 m class and 18 m ears: the gate refuses it, so nothing is painted.
    const e = emit({ class: 'walkStep', source: 'self', x: 3, y: 0, z: 3 }, 0);
    paint.setListener(3, 1.6, 3 + 60);
    expect(paint.hear(e)).toBeNull();
    expect(paint.missed).toBe(1);
    expect(field.paintedDots).toBe(0);
    for (let i = 0; i < field.count; i++) expect(field.paintTime[i]).toBe(UNPAINTED);
  });

  it('PIN: resetPaint puts the whole run back to black, dots and edges alike', () => {
    field.resetPaint();
    const paint = new PaintPipeline(field, world);
    paint.setListener(6, 1.6, 6);
    paint.hear(emit({ class: 'qPing', source: 'self', x: 6, y: 1.6, z: 6, waveSpeed: Infinity }, 1));
    expect(field.paintedDots).toBeGreaterThan(0);
    field.resetPaint();
    expect(field.paintedDots).toBe(0);
    expect(field.paintedEdgeVerts).toBe(0);
    expect(litAt(1e6)).toBe(0);
  });

  it('BUG: a through-wall origin fuzz paints further out than the class’s own paint radius', () => {
    // §3.4 says one wall COSTS radius: R -> 0.4R, origin fuzzed +-2 m. For the quiet classes the
    // 2 m displacement is bigger than the whole reduced radius (crouchStep 1.5 -> 0.6,
    // dogGaitPatrol 2 -> 0.8, mantle/beaconHum 3 -> 1.2), so a muffled sound can light a surface
    // the same sound in open air could never have touched. Demonstrated on real geometry: a
    // 1.5 m crouch step behind a wall lights floor dots more than 1.5 m away.
    const wallMap = {
      name: 'fuzz gym',
      solids: [
        { type: 'box', id: 'floor', kind: 'floor', min: [0, -0.4, 0], max: [12, 0, 12] },
        { type: 'box', id: 'wall', kind: 'wall', min: [5, 0, 0], max: [5.4, 3, 12] },
      ],
      ladders: [],
      props: [],
      doors: [],
      dogRoutes: [],
      spawn: { pos: [1, 0, 1], yaw: 0 },
      air: [{ min: [0, 0, 0], max: [12, 4, 12] }],
      markers: [],
      bounds: { min: [0, -0.4, 0], max: [12, 4, 12] },
    } as unknown as Parameters<typeof buildWorld>[0];
    const w = buildWorld(wallMap);
    const f = bakeSurfels(w);
    const b = new EventBus();
    const R0 = 1.5;
    let worst = 0;
    for (let k = 0; k < 96; k++) {
      f.resetPaint();
      b.now = k;
      const e = b.emit({
        class: 'crouchStep',
        source: 'self',
        x: 4.6,
        y: 0.05,
        z: 6,
        paintRadius: R0,
        hearRadius: 30,
        intensity: 0.35,
        waveSpeed: Infinity,
      });
      applyEvent(f, w, e, null, null);
      for (let i = 0; i < f.count; i++) {
        if (f.paintTime[i] === UNPAINTED) continue;
        const d = Math.hypot(f.positions[i * 3]! - 4.6, f.positions[i * 3 + 1]! - 0.05, f.positions[i * 3 + 2]! - 6);
        worst = Math.max(worst, d);
      }
    }
    expect(worst, `a 1.5 m sound painted a surface ${worst.toFixed(2)} m away`).toBeLessThanOrEqual(R0 + 1e-3);
  });
});

describe('vision §3.6 — “you never lose the map”', () => {
  it('BUG: a detonation blanks the memory skeleton it sweeps, for the whole flight of its wavefront', () => {
    field.resetPaint();
    const paint = new PaintPipeline(field, world);
    paint.amortize = true;
    walkTheRoute(paint, 3, 30, 0);

    const now = 20; // twenty seconds into the run: the route is a cool memory skeleton
    const before = litAt(now);
    expect(before).toBeGreaterThan(1000);
    const wasLit = new Uint8Array(field.count);
    for (let i = 0; i < field.count; i++) {
      const p = field.paintTime[i]!;
      if (p !== UNPAINTED && p <= now) wasLit[i] = 1;
    }

    // A dog blows up mid-route. Production frame shape: hear during the step, then one pump with
    // the render clock and the production budget (src/main.ts).
    paint.setListener(16, 1.6, 8);
    paint.hear(
      emit(
        {
          class: 'detonation',
          source: 'detonation',
          x: 16,
          y: 1.0,
          z: 8,
          paintRadius: 22,
          hearRadius: 60,
          intensity: 1,
          waveSpeed: WAVE_SPEED_DETONATION,
        },
        now,
      ),
    );
    // WORST case, and deterministic: settle == an unbounded work-ahead, which is what the 3 ms
    // production budget actually reaches on this fixture (the whole job costs well under 3 ms).
    paint.settle(now);

    let erased = 0;
    let worstDelay = 0;
    for (let i = 0; i < field.count; i++) {
      if (!wasLit[i]) continue;
      const p = field.paintTime[i]!;
      if (p > now) {
        erased++;
        worstDelay = Math.max(worstDelay, p - now);
      }
    }
    expect(
      erased,
      `${erased} already-known dots were stamped in the future and are now undrawn for up to ${(worstDelay * 1000).toFixed(0)} ms`,
    ).toBe(0);
  });

  it('BUG: an E-ping blanks the geometry ahead of you for up to half a second before lighting it', () => {
    field.resetPaint();
    const paint = new PaintPipeline(field, world);
    paint.amortize = true;
    walkTheRoute(paint, 3, 38, 0);

    const now = 30;
    const wasLit = new Uint8Array(field.count);
    let before = 0;
    for (let i = 0; i < field.count; i++) {
      const p = field.paintTime[i]!;
      if (p !== UNPAINTED && p <= now) {
        wasLit[i] = 1;
        before++;
      }
    }
    expect(before).toBeGreaterThan(1000);

    paint.setListener(5, 1.6, 8);
    paint.hear(
      emit(
        {
          class: 'ePing',
          source: 'self',
          x: 5,
          y: 1.6,
          z: 8,
          cone: { dir: [1, 0, 0], angleDeg: 25 },
          paintRadius: 40,
          hearRadius: 30,
          intensity: 1,
          waveSpeed: WAVE_SPEED_E,
        },
        now,
      ),
    );
    // Deterministic stand-in for the production 3 ms budget: the whole 40 m cone costs far less
    // than 3 ms on this fixture, so a real frame reaches exactly this state.
    paint.settle(now);

    let erased = 0;
    let worstDelay = 0;
    for (let i = 0; i < field.count; i++) {
      if (!wasLit[i]) continue;
      if (field.paintTime[i]! > now) {
        erased++;
        worstDelay = Math.max(worstDelay, field.paintTime[i]! - now);
      }
    }
    expect(
      erased,
      `E-ping un-drew ${erased} of ${before} known dots for up to ${(worstDelay * 1000).toFixed(0)} ms`,
    ).toBe(0);
  });

  it('BUG: even with ZERO work-ahead budget the blast still blanks known geometry', () => {
    // Scoping the defect: it is not a work-ahead artifact that a smaller budget would fix. The
    // conservative arrival (centre − patchRadius − WALL_FUZZ, src/core/paint.ts:600) makes every
    // patch due up to (patchRadius + 2 m)/waveSpeed early, and each of its dots is then stamped
    // at its own later true arrival — in the future, over whatever was there before.
    field.resetPaint();
    const paint = new PaintPipeline(field, world);
    paint.amortize = true;
    walkTheRoute(paint, 3, 30, 0);

    const now = 20;
    const wasLit = new Uint8Array(field.count);
    for (let i = 0; i < field.count; i++) {
      const p = field.paintTime[i]!;
      if (p !== UNPAINTED && p <= now) wasLit[i] = 1;
    }
    paint.setListener(16, 1.6, 8);
    paint.hear(
      emit(
        {
          class: 'detonation',
          source: 'detonation',
          x: 16,
          y: 1.0,
          z: 8,
          paintRadius: 22,
          hearRadius: 60,
          intensity: 1,
          waveSpeed: WAVE_SPEED_DETONATION,
        },
        now,
      ),
    );
    paint.pump(now, 0);

    let erased = 0;
    let worstDelay = 0;
    for (let i = 0; i < field.count; i++) {
      if (!wasLit[i]) continue;
      if (field.paintTime[i]! > now) {
        erased++;
        worstDelay = Math.max(worstDelay, field.paintTime[i]! - now);
      }
    }
    expect(
      erased,
      `${erased} known dots blanked for up to ${(worstDelay * 1000).toFixed(0)} ms with budget 0`,
    ).toBe(0);
  });

  it('PIN: the erasure is the unconditional paintTime write, not the schedule (same in the sync path)', () => {
    // amortize OFF, one plain applyEvent: the same surfaces go dark, so a fix has to live in the
    // write at src/core/paint.ts:468, not in pump().
    field.resetPaint();
    const paint = new PaintPipeline(field, world);
    walkTheRoute(paint, 3, 30, 0);
    const now = 20;
    const wasLit: number[] = [];
    for (let i = 0; i < field.count; i++) {
      const p = field.paintTime[i]!;
      if (p !== UNPAINTED && p <= now) wasLit.push(i);
    }
    paint.setListener(16, 1.6, 8);
    paint.hear(
      emit(
        {
          class: 'qPing',
          source: 'self',
          x: 16,
          y: 1.6,
          z: 8,
          paintRadius: 12,
          hearRadius: 18,
          intensity: 1,
          waveSpeed: WAVE_SPEED_Q,
        },
        now,
      ),
    );
    let erased = 0;
    for (const i of wasLit) if (field.paintTime[i]! > now) erased++;
    // Pinning the defect's SIZE, not asserting it away: a 12 m Q-ping at 45 m/s puts 267 ms of
    // future stamps on everything it touches.
    expect(erased).toBeGreaterThan(0);
  });

  it('BUG: paintTime can move BACKWARDS, so a surface visibly ages when a newer sound touches it', () => {
    // A detonation at t=10 stamps a dot 14 m out at 10.10. A landing 50 ms later (paint radius up
    // to 14 m, instant) stamps the same dot at 10.05. Age is a colour (law 3) — a surface that was
    // just re-heard must never read older than it did a frame ago.
    field.resetPaint();
    const paint = new PaintPipeline(field, world);
    paint.setListener(20, 1.6, 8);
    paint.hear(
      emit(
        {
          class: 'detonation',
          source: 'detonation',
          x: 20,
          y: 1.0,
          z: 8,
          paintRadius: 22,
          hearRadius: 60,
          intensity: 1,
          waveSpeed: WAVE_SPEED_DETONATION,
        },
        10,
      ),
    );
    const stamped = Float32Array.from(field.paintTime);
    paint.hear(emit({ class: 'landing', source: 'self', x: 20, y: 0.1, z: 8, paintRadius: 14 }, 10.05));

    let aged = 0;
    let worst = 0;
    for (let i = 0; i < field.count; i++) {
      const before = stamped[i]!;
      if (before === UNPAINTED) continue;
      const after = field.paintTime[i]!;
      if (after < before) {
        aged++;
        worst = Math.max(worst, before - after);
      }
    }
    expect(aged, `${aged} surfels got OLDER by up to ${(worst * 1000).toFixed(0)} ms`).toBe(0);
  });
});

describe('vision §3.6 — accumulation is monotone in coverage', () => {
  it('PIN: the set of ever-painted dots only grows; paintedDots never double-counts', () => {
    field.resetPaint();
    const paint = new PaintPipeline(field, world);
    let ever = 0;
    const seen = new Uint8Array(field.count);
    for (let k = 0; k < 8; k++) {
      paint.setListener(4 + k * 3, 1.6, 8);
      paint.hear(emit({ class: 'sprintStep', source: 'self', x: 4 + k * 3, y: 0.1, z: 8 }, k * 0.4));
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

  it('PIN: repeated quiet re-hearing decays intensity by 0.85 each time (engine-plan §3 step 4)', () => {
    // Documented, but it compounds: a surface lit brightly once and then brushed by twenty quiet
    // sounds keeps its age and loses its density read. Pinned here so a future change is deliberate.
    field.resetPaint();
    const paint = new PaintPipeline(field, world);
    paint.setListener(10, 1.6, 8);
    paint.hear(
      emit(
        { class: 'qPing', source: 'self', x: 10, y: 1.6, z: 8, paintRadius: 12, intensity: 1, waveSpeed: Infinity },
        0,
      ),
    );
    // A dot that is lit brightly AND whose dither is low enough that a much quieter event still
    // clears its gate — the only dots the 0.85 rule can actually erode.
    let probe = -1;
    for (let i = 0; i < field.count; i++) {
      if (field.paintTime[i] !== UNPAINTED && field.paintIntensity[i]! > 0.9 && field.dither[i]! < 0.05) {
        probe = i;
        break;
      }
    }
    expect(probe).toBeGreaterThanOrEqual(0);
    const start = field.paintIntensity[probe]!;
    for (let k = 1; k <= 6; k++) {
      paint.hear(
        emit(
          {
            class: 'qPing',
            source: 'self',
            x: 10,
            y: 1.6,
            z: 8,
            paintRadius: 12,
            intensity: 0.1,
            hearRadius: 30,
            waveSpeed: Infinity,
          },
          k,
        ),
      );
    }
    const end = field.paintIntensity[probe]!;
    // Six quiet re-hearings knock a bright surface down to 0.85^6 = 38 % of its density read,
    // while its AGE keeps resetting to now. Documented in engine-plan §3 step 4; pinned here so
    // the compounding is a decision and not a surprise.
    expect(end).toBeLessThan(start);
    expect(end / start).toBeCloseTo(Math.pow(0.85, 6), 2);
  });
});
