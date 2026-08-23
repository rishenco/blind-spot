import { describe, expect, it } from 'vitest';
import {
  clamp,
  clamp01,
  damp,
  dither3i,
  eventQuality,
  falloff,
  hash1,
  inCone,
  latticeCentre,
  latticeFirstAtOrAfter,
  latticeIndex,
  makeRng,
  smoothstep,
  yawToForward,
} from '../src/core/math.js';
import { HEARING_BASE, SURFEL_SPACING, WALL1_QUALITY } from '../src/core/const.js';

describe('scalars', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
  });

  it('smoothsteps with flat ends', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('damps toward the target frame-rate independently', () => {
    // Two half-steps must land where one full step lands.
    const one = damp(0, 1, 4, 0.2);
    const two = damp(damp(0, 1, 4, 0.1), 1, 4, 0.1);
    expect(two).toBeCloseTo(one, 12);
  });
});

describe('falloff (vision §3.1: quadratic, zero at the radius)', () => {
  it('is 1 at the origin and 0 at/after the radius', () => {
    expect(falloff(0, 10)).toBe(1);
    expect(falloff(10, 10)).toBe(0);
    expect(falloff(11, 10)).toBe(0);
    expect(falloff(5, 0)).toBe(0);
  });

  it('is monotonically decreasing', () => {
    let prev = Infinity;
    for (let d = 0; d <= 12; d += 0.5) {
      const v = falloff(d, 12);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });

  it('falls quadratically', () => {
    expect(falloff(6, 12)).toBeCloseTo(0.75, 12); // 1 - 0.5^2
  });
});

describe('dither (stable per lattice cell — rescans must refresh in place)', () => {
  it('returns the same value for the same cell, always', () => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [12, -3, 400],
      [-77, 9, -1],
    ] as const) {
      expect(dither3i(x, y, z)).toBe(dither3i(x, y, z));
    }
  });

  it('is in [0,1) and well spread', () => {
    let lo = 0;
    let hi = 0;
    let n = 0;
    for (let x = 0; x < 24; x++) {
      for (let z = 0; z < 24; z++) {
        const d = dither3i(x, 3, z);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(1);
        if (d < 0.5) lo++;
        else hi++;
        n++;
      }
    }
    expect(n).toBe(576);
    // Coverage == density only holds if the dither is roughly uniform.
    expect(Math.abs(lo - hi) / n).toBeLessThan(0.12);
  });

  it('separates neighbouring cells', () => {
    expect(dither3i(4, 4, 4)).not.toBe(dither3i(5, 4, 4));
    expect(dither3i(4, 4, 4)).not.toBe(dither3i(4, 5, 4));
    expect(dither3i(4, 4, 4)).not.toBe(dither3i(4, 4, 5));
  });

  it('hash1 and makeRng are deterministic', () => {
    expect(hash1(1234)).toBe(hash1(1234));
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 8; i++) expect(a()).toBe(b());
  });
});

describe('lattice', () => {
  it('round-trips index -> centre -> index', () => {
    for (const w of [0.0, 0.11, 3.7, -2.2]) {
      const i = latticeIndex(w, SURFEL_SPACING);
      const c = latticeCentre(i, SURFEL_SPACING);
      expect(latticeIndex(c, SURFEL_SPACING)).toBe(i);
    }
  });

  it('finds the first centre at or after a coordinate', () => {
    const i = latticeFirstAtOrAfter(1.0, SURFEL_SPACING);
    expect(latticeCentre(i, SURFEL_SPACING)).toBeGreaterThanOrEqual(1.0);
    expect(latticeCentre(i - 1, SURFEL_SPACING)).toBeLessThan(1.0);
  });
});

describe('cone membership (E-ping: 25° full angle => ±12.5°)', () => {
  const [fx, fy, fz] = yawToForward(0); // +x

  it('accepts the axis and rejects behind', () => {
    expect(inCone(0, 0, 0, fx, fy, fz, 10, 0, 0, 25)).toBe(true);
    expect(inCone(0, 0, 0, fx, fy, fz, -10, 0, 0, 25)).toBe(false);
  });

  it('cuts at the half angle', () => {
    const r = 10;
    const inside = (deg: number): boolean => {
      const a = (deg * Math.PI) / 180;
      return inCone(0, 0, 0, fx, fy, fz, Math.cos(a) * r, 0, Math.sin(a) * r, 25);
    };
    expect(inside(12.0)).toBe(true);
    expect(inside(13.0)).toBe(false);
    expect(inside(-12.0)).toBe(true);
    expect(inside(-13.0)).toBe(false);
  });

  it('is a 3D cone, not a 2D wedge', () => {
    expect(inCone(0, 0, 0, fx, fy, fz, 10, 8, 0, 25)).toBe(false);
    expect(inCone(0, 0, 0, fx, fy, fz, 10, 0.5, 0, 25)).toBe(true);
  });
});

describe('event quality (vision §3.4)', () => {
  it('is full at the origin and zero past the range', () => {
    expect(eventQuality(0, 24, 0, HEARING_BASE, WALL1_QUALITY)).toBe(1);
    expect(eventQuality(30, 24, 0, HEARING_BASE, WALL1_QUALITY)).toBe(0);
  });

  it('never exceeds the listener base range', () => {
    // A quiet event (hear 2 m) heard by an 18 m listener still uses the larger range.
    expect(eventQuality(9, 2, 0, HEARING_BASE, WALL1_QUALITY)).toBeCloseTo(0.5, 12);
  });

  it('damps through one wall and stops dead at two', () => {
    const clear = eventQuality(9, 18, 0, HEARING_BASE, WALL1_QUALITY);
    expect(eventQuality(9, 18, 1, HEARING_BASE, WALL1_QUALITY)).toBeCloseTo(clear * WALL1_QUALITY, 12);
    expect(eventQuality(9, 18, 2, HEARING_BASE, WALL1_QUALITY)).toBe(0);
    expect(eventQuality(1, 60, 3, HEARING_BASE, WALL1_QUALITY)).toBe(0);
  });
});
