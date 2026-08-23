/**
 * REVIEW SPEC (milestone-1 adversarial review) — engine-plan §4 conformance.
 *
 * These assert the plan's literal contract. Delete this file once the findings are fixed
 * (or once the plan itself is amended and the change is recorded in engine-plan §4).
 */
import { describe, expect, it } from 'vitest';
import { eventQuality } from '../src/core/math.js';
import { EV, HEARING_BASE, WALL1_QUALITY } from '../src/core/const.js';

/** engine-plan §4, verbatim: `quality = clamp01(1 - d/hearRadius) * (walls===0 ? 1 : walls===1 ? 0.45 : 0)`. */
const planQuality = (d: number, hearRadius: number, walls: number): number => {
  if (walls >= 2) return 0;
  const q = Math.max(0, Math.min(1, 1 - d / hearRadius));
  return q * (walls === 0 ? 1 : 0.45);
};

/** engine-plan §4: "delivered iff `d <= max(HEARING_BASE, hearRadius)`" — a SEPARATE gate. */
const planDelivered = (d: number, hearRadius: number): boolean => d <= Math.max(HEARING_BASE, hearRadius);

describe('review: eventQuality matches engine-plan §4', () => {
  it('uses hearRadius (not max(hearRadius, HEARING_BASE)) as the quality denominator', () => {
    // A crouch step (hearRadius 2 m) heard from 1 m away is at HALF its audible range.
    expect(eventQuality(1, EV.crouchStep.hear, 0, HEARING_BASE, WALL1_QUALITY)).toBeCloseTo(
      planQuality(1, EV.crouchStep.hear, 0),
      12,
    );
  });

  it('reaches 0 at the class hearRadius for every quiet class', () => {
    for (const [name, ev] of Object.entries(EV)) {
      if (ev.hear >= HEARING_BASE) continue; // loud classes are unaffected by the bug
      expect(
        eventQuality(ev.hear, ev.hear, 0, HEARING_BASE, WALL1_QUALITY),
        `${name} (hear ${ev.hear} m) must deliver quality 0 at its own hearRadius`,
      ).toBeCloseTo(0, 12);
    }
  });

  it('separates loud from quiet at the same listener distance', () => {
    // A sprint step (24 m) and a crouch step (2 m) heard from 1.5 m must NOT read alike:
    // visual-brief §1.13 drives stain definition from quality.
    const loud = eventQuality(1.5, EV.sprintStep.hear, 0, HEARING_BASE, WALL1_QUALITY);
    const quiet = eventQuality(1.5, EV.crouchStep.hear, 0, HEARING_BASE, WALL1_QUALITY);
    expect(loud - quiet).toBeGreaterThan(0.3);
  });

  it('agrees with the plan across the whole class table (0 and 1 wall)', () => {
    for (const ev of Object.values(EV)) {
      for (const walls of [0, 1] as const) {
        for (const d of [0, 0.5, 1, 3, 8, 17.9]) {
          if (!planDelivered(d, ev.hear)) continue;
          expect(eventQuality(d, ev.hear, walls, HEARING_BASE, WALL1_QUALITY)).toBeCloseTo(
            planQuality(d, ev.hear, walls),
            12,
          );
        }
      }
    }
  });

  it('still returns 0 through two or more walls (this part is correct)', () => {
    expect(eventQuality(1, EV.sprintStep.hear, 2, HEARING_BASE, WALL1_QUALITY)).toBe(0);
    expect(eventQuality(1, EV.sprintStep.hear, 5, HEARING_BASE, WALL1_QUALITY)).toBe(0);
  });

  it('still applies the 0.45 one-wall factor (this part is correct)', () => {
    const zero = eventQuality(4, EV.detonation.hear, 0, HEARING_BASE, WALL1_QUALITY);
    const one = eventQuality(4, EV.detonation.hear, 1, HEARING_BASE, WALL1_QUALITY);
    expect(one).toBeCloseTo(zero * WALL1_QUALITY, 12);
  });
});
