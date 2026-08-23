/**
 * REVIEW PROBE — milestone 3, claim 2 (structural half).
 *
 * Claim under test: "patches own disjoint dot/segment buffer runs, so paint order cannot change
 * any written value." This file checks only the STRUCTURAL half of that sentence — that the
 * partition really is disjoint and total, and that per-patch paint touches only its own runs.
 *
 * The behavioural half ("paint order cannot change any written value") is tested in
 * m3-amortization.spec.ts and does NOT follow from disjointness once two events are in play.
 */

import { describe, expect, it } from 'vitest';
import { buildWorld } from '../../src/core/map/build.js';
import { sampleMap } from '../../src/core/map/sampleMap.js';
import { bakeSurfels, UNPAINTED, type SurfelField } from '../../src/core/surfels.js';
import { applyEvent } from '../../src/core/paint.js';
import { EventBus, type SoundEvent } from '../../src/core/events.js';

const world = buildWorld(sampleMap);
const field: SurfelField = bakeSurfels(world);

const emit = (over: Partial<Parameters<EventBus['emit']>[0]> = {}, time = 0): SoundEvent => {
  const bus = new EventBus();
  bus.now = time;
  return bus.emit({
    class: 'qPing',
    source: 'self',
    x: 10,
    y: 1.6,
    z: 10,
    paintRadius: 12,
    hearRadius: 60,
    intensity: 1,
    waveSpeed: Infinity,
    ...over,
  });
};

describe('PIN: the patch partition is disjoint and total (claim 2, structural)', () => {
  it('PIN: every dot belongs to exactly one patch and every patch run is contiguous', () => {
    const owner = new Int32Array(field.count).fill(-1);
    let covered = 0;
    for (let p = 0; p < field.patchCount; p++) {
      const s = field.patchDotStart[p]!;
      const n = field.patchDotCount[p]!;
      expect(s + n, `patch ${p} dot run overruns the buffer`).toBeLessThanOrEqual(field.count);
      for (let i = s; i < s + n; i++) {
        expect(owner[i], `dot ${i} claimed twice (patches ${owner[i]} and ${p})`).toBe(-1);
        owner[i] = p;
        covered++;
      }
    }
    expect(covered, 'total: every dot covered exactly once').toBe(field.count);
    for (let i = 0; i < field.count; i++) expect(owner[i]).toBeGreaterThanOrEqual(0);
  });

  it('PIN: every edge segment belongs to exactly one patch, and the runs tile the buffer', () => {
    const owner = new Int32Array(field.edgeCount).fill(-1);
    let covered = 0;
    for (let p = 0; p < field.patchCount; p++) {
      const s = field.patchSegStart[p]!;
      const n = field.patchSegCount[p]!;
      expect(s + n, `patch ${p} seg run overruns`).toBeLessThanOrEqual(field.edgeCount);
      for (let i = s; i < s + n; i++) {
        expect(owner[i], `segment ${i} claimed twice`).toBe(-1);
        owner[i] = p;
        covered++;
      }
    }
    expect(covered).toBe(field.edgeCount);
  });

  it('PIN: patch runs are laid out in ascending, gapless order (the RangeAccum assumption)', () => {
    let nextDot = 0;
    let nextSeg = 0;
    for (let p = 0; p < field.patchCount; p++) {
      expect(field.patchDotStart[p], `patch ${p} dot start`).toBe(nextDot);
      nextDot += field.patchDotCount[p]!;
      expect(field.patchSegStart[p], `patch ${p} seg start`).toBe(nextSeg);
      nextSeg += field.patchSegCount[p]!;
    }
    expect(nextDot).toBe(field.count);
    expect(nextSeg).toBe(field.edgeCount);
  });

  it('PIN: patchRadius really bounds every member dot AND both endpoints of every member segment', () => {
    // This is the premise the conservative arrival formula rests on (claim 3): if patchRadius
    // under-covers even one member, that member can be painted after its own wavefront.
    let worst = 0;
    for (let p = 0; p < field.patchCount; p++) {
      const cx = field.patchCentre[p * 3]!;
      const cy = field.patchCentre[p * 3 + 1]!;
      const cz = field.patchCentre[p * 3 + 2]!;
      const r = field.patchRadius[p]!;
      const d0 = field.patchDotStart[p]!;
      for (let i = d0; i < d0 + field.patchDotCount[p]!; i++) {
        const d = Math.hypot(
          field.positions[i * 3]! - cx,
          field.positions[i * 3 + 1]! - cy,
          field.positions[i * 3 + 2]! - cz,
        );
        worst = Math.max(worst, d - r);
        expect(d, `dot ${i} outside patch ${p} radius`).toBeLessThanOrEqual(r + 1e-4);
      }
      const s0 = field.patchSegStart[p]!;
      for (let s = s0; s < s0 + field.patchSegCount[p]!; s++) {
        for (let v = 0; v < 2; v++) {
          const k = (s * 2 + v) * 3;
          const d = Math.hypot(
            field.edgePositions[k]! - cx,
            field.edgePositions[k + 1]! - cy,
            field.edgePositions[k + 2]! - cz,
          );
          worst = Math.max(worst, d - r);
          expect(d, `seg vert ${k / 3} outside patch ${p} radius`).toBeLessThanOrEqual(r + 1e-4);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-4);
  });

  it('PIN: painting one patch writes inside that patch run and nowhere else', () => {
    // Drive applyEvent with a radius small enough to light a handful of patches, then prove every
    // dot it touched belongs to a patch whose centre is inside the paint sphere.
    field.resetPaint();
    const e = emit({ paintRadius: 6 });
    applyEvent(field, world, e, null, null);

    const patchOf = new Int32Array(field.count).fill(-1);
    for (let p = 0; p < field.patchCount; p++) {
      const s = field.patchDotStart[p]!;
      for (let i = s; i < s + field.patchDotCount[p]!; i++) patchOf[i] = p;
    }
    let touched = 0;
    for (let i = 0; i < field.count; i++) {
      if (field.paintTime[i] === UNPAINTED) continue;
      touched++;
      const p = patchOf[i]!;
      const d = Math.hypot(
        field.patchCentre[p * 3]! - e.origin[0],
        field.patchCentre[p * 3 + 1]! - e.origin[1],
        field.patchCentre[p * 3 + 2]! - e.origin[2],
      );
      expect(d, `dot ${i} lit but its patch centre is ${d} m away`).toBeLessThanOrEqual(
        e.paintRadius + field.patchRadius[p]! + 1e-4,
      );
    }
    expect(touched).toBeGreaterThan(50);
    field.resetPaint();
  });
});
