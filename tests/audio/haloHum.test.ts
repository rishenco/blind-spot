/**
 * The Halo hum — §3.8's self-readout, measured.
 *
 * "A ring around the reticle whose brightness equals your current audible radius, plus a matching
 * hum pitch. You always know exactly how loud you are. **Non-negotiable:** the genre's most-
 * repeated complaint is 'I can't tell when I'm detectable.'"
 *
 * That is the only place the vision doc uses the word non-negotiable, so it is worth a test that
 * can actually fail. §3.8 now fixes the map as law — `55·√(r/1.5)` Hz, gliding continuously
 * rather than stepping between stances, at a level that stays low and near-constant — which
 * turns three sentences of intent into three numbers. The hum is the audio half of the readout, and its entire job is to be
 * *legible*: a player must be able to hear the difference between crouching (2 m audible) and
 * sprinting (24 m) without looking at anything. Legibility reduces to three measurable claims,
 * one per describe block below — the pitch is right, the pitch is monotonic, and the loudness
 * does not move with it.
 *
 * The third is the one a listening test would never catch and a metric catches instantly. If the
 * hum got *louder* as the radius grew, it would mask the footsteps at the sprint end — the tier
 * where the reading matters most — and the readout would be least usable exactly when it is most
 * needed. Pitch is the channel; level must stay out of the way.
 */

import { describe, expect, it } from 'vitest';
import { estimateF0, hasNaN, peakInfo, rmsDb } from '../support/audioMetrics';
import {
  HALO_LEVEL_SPREAD_MAX_DB,
  HALO_PEAK_DBFS,
  HALO_PITCH_POINTS,
  HALO_PITCH_TOLERANCE_CENTS,
  MAX_PEAK_DBFS,
} from '../support/audioSpec';
import { renderOffline } from '../support/audioRender';
import { haloHum, humPitch } from '../support/probeVoices';

/**
 * Crouch → walk → sprint → quiet, with a plateau at each tier.
 *
 * The plateaus are the point: `estimateF0` answers for a window as a whole, so the hum can only
 * be read where it is holding still. That is a property of pitch estimation, not a limitation of
 * this test — a sweep genuinely has no single period, and `metrics.test.ts` pins that the
 * estimator says 0 rather than guessing a number from the middle of the ramp.
 */
const SWEEP = [
  { t: 0.01, r: 2 },
  { t: 1.5, r: 2 },
  { t: 2.5, r: 11 },
  { t: 3.5, r: 11 },
  { t: 4.5, r: 24 },
  { t: 5.5, r: 24 },
  { t: 6.5, r: 2 },
  { t: 7.9, r: 2 },
] as const;

const hum = await renderOffline(8, (ctx, master) => {
  haloHum(ctx, master, SWEEP, 0.05, 8);
});

/** Cents between two frequencies — the unit a pitch error is actually legible in. */
const centsBetween = (measured: number, expected: number): number =>
  1200 * Math.log2(measured / expected);

describe('humPitch, the radius → pitch map', () => {
  /**
   * Pure arithmetic, no render: the calibration itself. Two octaves (55 → 220 Hz) across the
   * whole loudness range, on a square-root map so the quiet end — where the player is making
   * decisions about being heard — gets the resolution.
   */
  it('spans two octaves from the quietest crouch to the loudest sprint', () => {
    expect(humPitch(1.5)).toBeCloseTo(55, 6);
    expect(humPitch(24)).toBeCloseTo(220, 6);
    expect(humPitch(24) / humPitch(1.5)).toBeCloseTo(4, 6);
  });

  it('clamps outside the audible-radius range rather than running off the keyboard', () => {
    expect(humPitch(0)).toBe(humPitch(1.5));
    expect(humPitch(-10)).toBe(humPitch(1.5));
    expect(humPitch(1000)).toBe(humPitch(24));
  });

  it('rises with every increase in radius', () => {
    let previous = 0;
    for (const r of [1.5, 2, 4, 8, 11, 18, 24]) {
      const hz = humPitch(r);
      expect(hz).toBeGreaterThan(previous);
      previous = hz;
    }
  });

  /**
   * Half-log, not linear: the bottom half of the radius range gets more than half the pitch
   * range. A linear map would make crouch and walk nearly the same note, which is the pair the
   * player most needs to tell apart.
   */
  it('spends more pitch on the quiet end than a linear map would', () => {
    const midRadius = (1.5 + 24) / 2;
    const linearMidPitch = (55 + 220) / 2;
    expect(humPitch(midRadius)).toBeGreaterThan(linearMidPitch);
  });
});

describe('the rendered hum', () => {
  it('is finite, leaves headroom, and sits at the level §3.8 asks for', () => {
    expect(hasNaN(hum)).toBe(false);
    const peak = peakInfo(hum);
    expect(peak.clipped).toBe(false);
    expect(peak.peakDb).toBeLessThan(MAX_PEAK_DBFS);
    // "Level stays low and near-constant (≈ −21 dBFS) ... so the tone can sit under everything
    // without fatiguing." A hum the player mutes is a readout the player does not have.
    expect(Math.abs(peak.peakDb - HALO_PEAK_DBFS.value), HALO_PEAK_DBFS.why)
      .toBeLessThanOrEqual(HALO_PEAK_DBFS.tol);
  });

  /**
   * The readout, measured at each tier.
   *
   * Measured error is +1 to +5 cents and it is **not** estimator error — `estimateF0` reads a
   * pure sine to within 0.1 cents. It is the hum's own 0.7 % detuned second oscillator pulling
   * the composite period sharp by roughly its share of the mix. Recorded here because the
   * alternative is somebody chasing a five-cent bias through the FFT for an afternoon.
   */
  it.each(HALO_PITCH_POINTS)('reads $radiusM m as $hz Hz', ({ radiusM, hz, windowSec }) => {
    const [from, to] = windowSec;
    const measured = estimateF0(hum, from, to);
    expect(measured).toBeGreaterThan(0); // 0 would mean "no pitch here" — a dead readout
    expect(Math.abs(centsBetween(measured, hz))).toBeLessThan(HALO_PITCH_TOLERANCE_CENTS);
    // And the spec table agrees with the function it was measured from.
    expect(hz).toBeCloseTo(humPitch(radiusM), 1);
  });

  /**
   * Monotonic, asserted separately from the absolute pitches.
   *
   * A map that got the three tiers right but inverted between them would pass every pin above
   * and be unusable — and inverted is a real failure mode, since it is one sign error in a
   * radius-to-pitch conversion.
   */
  it('rises tier by tier, and returns when the player goes quiet again', () => {
    const [crouch, walk, sprint] = HALO_PITCH_POINTS.map(({ windowSec }) =>
      estimateF0(hum, windowSec[0], windowSec[1]),
    );
    expect(walk!).toBeGreaterThan(crouch!);
    expect(sprint!).toBeGreaterThan(walk!);
    // Back to a crouch at the end: the readout is a live reading, not a high-water mark.
    const backToQuiet = estimateF0(hum, 6.8, 7.8);
    expect(Math.abs(centsBetween(backToQuiet, crouch!))).toBeLessThan(HALO_PITCH_TOLERANCE_CENTS);
  });

  /**
   * The claim a listening test would never make and the one most worth having.
   *
   * If level tracked radius, the hum would be loudest while sprinting — drowning the footsteps
   * that are the player's main source of geometry (§3.3: "moving fast **is** scanning") at
   * exactly the moment the readout matters. Pitch carries the information; level stays put.
   */
  it('keeps its level near-constant, so the readout never masks what it reports on', () => {
    const levels = HALO_PITCH_POINTS.map(({ windowSec }) =>
      rmsDb(hum, undefined, windowSec[0], windowSec[1]),
    );
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(HALO_LEVEL_SPREAD_MAX_DB);
    // Specifically: sprinting is not the loudest tier. Most of the spread is the 520 Hz lowpass
    // treating a 63 Hz fundamental differently from a 220 Hz one, not the hum getting louder.
    const sprintLevel = levels[levels.length - 1]!;
    expect(sprintLevel).toBeLessThan(Math.max(...levels) + 0.01);
  });
});
