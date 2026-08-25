/**
 * The two-axis material fingerprint — and the finding that shaped it.
 *
 * §3.9 makes a promise the game leans on hard: "the spider's footfalls carry the material they
 * strike, so its voice tells you what it is walking on and therefore *where it is* — a change of
 * timbre mid-stride is a change of surface". That is not flavour text. It is a *tracking
 * mechanic*: in a world that is black, the timbre of a footfall is a coordinate. So there has to
 * be a number that says whether two materials are still telling themselves apart, and the number
 * has to be the right one.
 *
 * The obvious candidate is spectral centroid — brightness — and it is a trap twice over.
 *
 *  1. The M1 audio prototype measured metal at 2713 Hz and stone at 2756 Hz and concluded that
 *     centroid cannot separate them. Re-measured with a windowed FFT (`tests/audio/metrics.test.ts`
 *     shows why that matters) the same two renders read 1795 Hz and 751 Hz — the near-equality
 *     was the prototype's *unwindowed* DFT measuring its own leakage skirt, not the sounds. So
 *     the literal claim was false, and believing it would have thrown away a usable axis.
 *  2. But the conclusion it was used to justify survives, for a better reason: centroid does not
 *     **order** the materials. Dust reads 1006 Hz — brighter than stone (751) and concrete (585)
 *     — because dust is nearly all broadband exciter and has almost no low modes to weigh it
 *     down. Brightness is a "scuff versus ring" axis, not a hardness axis. The prototype's own
 *     harness printed `centroid ordering dust<concrete<stone<metal: PASS`, and that ordering was
 *     a coincidence of the leakage that would have been pinned and defended.
 *
 * What actually separates them is the **ring tail**: how much sound is left 150–300 ms after the
 * strike. Metal sits at −52.7 dBFS there; stone, its nearest neighbour, at −95.4. A 42.7 dB gap,
 * from metal's 0.30–0.38 s modes against everyone else's 0.04–0.14 s. That is the assertion
 * shape every later material commit should copy: **pin the tail tightly because it is the
 * design, pin the centroid as a coarse partition because that is all it can carry.**
 *
 * The voices under test are `tests/support/probeVoices.ts` — a fixture, not the game's audio.
 * When `src/audio/` lands, that file goes and these assertions point at the real builders.
 */

import { describe, expect, it } from 'vitest';
import {
  centroidHz,
  hasNaN,
  peakInfo,
  rmsDb,
  stereoEnergyRatio,
  tailDb,
  type AudioBufferLike,
} from '../support/audioMetrics';
import {
  BODY_WINDOW,
  CENTROID_SPLIT_HZ,
  MATERIAL_FINGERPRINTS,
  MAX_PEAK_DBFS,
  MIN_METAL_TAIL_SEPARATION_DB,
  RING_TAIL_WINDOW,
  STONE_IS_QUIETER_THAN_ITS_MULTIPLIER,
  type PinnedMaterial,
} from '../support/audioSpec';
import { renderOffline } from '../support/audioRender';
import { MATERIAL_NAMES, contact } from '../support/probeVoices';

/** The one render conditions every pinned number in `audioSpec.ts` was measured under. */
const STRIKE_AT = 0.05;
const RENDER_SECONDS = 1;

function strike(mat: PinnedMaterial): Promise<AudioBufferLike> {
  return renderOffline(RENDER_SECONDS, (ctx, master) => {
    contact(ctx, master, { t: STRIKE_AT, mat, gain: 0.5, seed: 11 });
  });
}

/** Every material rendered once, so the whole file measures the same four buffers. */
const rendered = new Map<PinnedMaterial, AudioBufferLike>();
for (const mat of MATERIAL_NAMES) rendered.set(mat, await strike(mat));

const ring = (mat: PinnedMaterial): number =>
  tailDb(rendered.get(mat)!, RING_TAIL_WINDOW.fromSec, RING_TAIL_WINDOW.toSec);
const bright = (mat: PinnedMaterial): number =>
  centroidHz(rendered.get(mat)!, BODY_WINDOW.fromSec, BODY_WINDOW.toSec);
const body = (mat: PinnedMaterial): number =>
  rmsDb(rendered.get(mat)!, undefined, BODY_WINDOW.fromSec, BODY_WINDOW.toSec);

// ---------------------------------------------------------------------------

describe('the offline render', () => {
  /**
   * The property everything else in the audio suite stands on. If two renders of the same graph
   * differed at all, every pinned number would be a number that was true once, and the right
   * response would be to delete the suite rather than widen the tolerances.
   */
  it('is bit-identical for the same graph', async () => {
    const a = await strike('metal');
    const b = await strike('metal');
    expect(a.length).toBe(b.length);
    let differing = 0;
    for (let c = 0; c < a.numberOfChannels; c++) {
      const da = a.getChannelData(c);
      const db = b.getChannelData(c);
      for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) differing++;
    }
    expect(differing).toBe(0);
  });

  /**
   * Runs before every other assertion in the file, and should run before every assertion in
   * every audio test written after it. A single non-finite sample poisons every summing node
   * downstream, and most metrics answer a poisoned buffer with `NaN` — which compares false
   * against everything, so a dead render sails through a suite full of `toBeLessThan`.
   */
  it.each(MATERIAL_NAMES)('renders %s finite, with headroom, and centred', (mat) => {
    const buffer = rendered.get(mat)!;
    expect(hasNaN(buffer)).toBe(false);
    const peak = peakInfo(buffer);
    expect(peak.clipped).toBe(false);
    expect(peak.peakDb).toBeLessThan(MAX_PEAK_DBFS);
    // The strike is the loudest thing in its own render, and it happens when it was scheduled.
    expect(peak.peakAtSec).toBeGreaterThanOrEqual(STRIKE_AT);
    expect(peak.peakAtSec).toBeLessThan(STRIKE_AT + 0.02);
    // No panner in this graph, so any imbalance would be a bug in the fixture rather than a
    // choice — and would quietly bias every mixdown-based number in the table.
    expect(stereoEnergyRatio(buffer)).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------

describe('axis 1: the ring tail (the discriminator)', () => {
  it.each(MATERIAL_NAMES)('%s rings for as long as it is pinned to', (mat) => {
    const pin = MATERIAL_FINGERPRINTS[mat].ringTailDb;
    expect(Math.abs(ring(mat) - pin.value), pin.why).toBeLessThanOrEqual(pin.tol);
  });

  /**
   * The load-bearing assertion of the whole material system.
   *
   * Measured separation to metal's nearest neighbour is 42.7 dB; the pin demands 35, leaving
   * ~8 dB of tuning headroom. This is what "a surface's material is audible" reduces to, and it
   * is what a centroid-ordering test would have replaced: the voices could decay into mush and
   * a brightness assertion would still pass.
   */
  it('puts metal more than 35 dB above every other material', () => {
    const metal = ring('metal');
    for (const mat of MATERIAL_NAMES) {
      if (mat === 'metal') continue;
      expect(metal - ring(mat), `metal vs ${mat}`).toBeGreaterThan(MIN_METAL_TAIL_SEPARATION_DB);
    }
  });

  /**
   * And the honest limit of the axis, pinned so nobody over-reads it: the tail separates metal
   * from everything, and separates nothing else from anything. Dust, concrete and stone all sit
   * within ~7 dB of each other at the floor, which is the sound of three different filters
   * having already finished. If a later commit gives stone a real ring, *this* is the assertion
   * that has to be edited — and editing it is how the change gets noticed.
   */
  it('does not separate the three dull materials from each other', () => {
    const dull = (['dust', 'concrete', 'stone'] as const).map(ring);
    expect(Math.max(...dull) - Math.min(...dull)).toBeLessThan(15);
    for (const value of dull) expect(value).toBeLessThan(-85);
  });
});

describe('axis 2: the centroid (a coarse partition, not an ordering)', () => {
  it.each(MATERIAL_NAMES)('%s is as bright as it is pinned to be', (mat) => {
    const pin = MATERIAL_FINGERPRINTS[mat].centroidHz;
    expect(Math.abs(bright(mat) - pin.value), pin.why).toBeLessThanOrEqual(pin.tol);
  });

  it('splits metal from the rest, with a gap wide enough to be a decision', () => {
    expect(bright('metal')).toBeGreaterThan(CENTROID_SPLIT_HZ.metalFloor);
    for (const mat of MATERIAL_NAMES) {
      if (mat === 'metal') continue;
      expect(bright(mat), `${mat} must stay below the dull ceiling`).toBeLessThan(
        CENTROID_SPLIT_HZ.dullCeiling,
      );
    }
    expect(CENTROID_SPLIT_HZ.metalFloor).toBeGreaterThan(CENTROID_SPLIT_HZ.dullCeiling);
  });

  /**
   * The negative result, asserted rather than assumed.
   *
   * A test that pinned `dust < concrete < stone < metal` would look like a stronger claim and
   * would be a coincidence — dust is the *second brightest* of the four. Writing that down as a
   * passing test means the day someone reaches for centroid as a material axis, the suite
   * already says why not.
   */
  it('does not order the materials by hardness — dust outranks stone and concrete', () => {
    expect(bright('dust')).toBeGreaterThan(bright('stone'));
    expect(bright('dust')).toBeGreaterThan(bright('concrete'));
    // Stone and concrete are only ~166 Hz apart, which is inside an ordinary retune. Their order
    // is not a fact worth defending, and this records that it is not being defended.
    expect(Math.abs(bright('stone') - bright('concrete'))).toBeLessThan(300);
  });
});

describe('the two axes together are the fingerprint', () => {
  /**
   * Why *two* axes and not one: neither alone identifies a material, and together they do the
   * job the game needs. Centroid answers "bright or dull"; the tail answers "ringing or dead".
   * Metal is the only material that is both bright and ringing, so the pair identifies it
   * outright — and identifying metal is the case that matters, because metal is the surface a
   * player crosses fast and loud (§3.9: "crossing the steel walkway is loud and fast").
   */
  it.each(MATERIAL_NAMES)('%s lands in its pinned cell of the (centroid, tail) plane', (mat) => {
    const isMetal = mat === 'metal';
    expect(bright(mat) > CENTROID_SPLIT_HZ.metalFloor).toBe(isMetal);
    expect(ring(mat) > -85).toBe(isMetal);
  });

  it.each(MATERIAL_NAMES)('%s is as loud as it is pinned to be', (mat) => {
    const pin = MATERIAL_FINGERPRINTS[mat].bodyRmsDb;
    expect(Math.abs(body(mat) - pin.value), pin.why).toBeLessThanOrEqual(pin.tol);
  });

  /**
   * A deviation from §3.9 recorded as a passing test rather than left to be found by ear.
   *
   * §3.9's first-pass multipliers (metal ×1.5 · stone ×1.15 · concrete ×1.0 · dust ×0.6) predict
   * stone ~1.2 dB *louder* than concrete. It renders 0.66 dB quieter: the multiplier is applied,
   * but stone's modal gains give back more than it adds. Metal's ×1.5 arrives intact (+3.5 dB
   * predicted, +3.5 measured), so the machinery works and the tuning does not.
   *
   * The prototype never caught this because its loudness check compared metal and dust against
   * concrete and skipped stone entirely — an ordering asserted three quarters of the way.
   */
  it('KNOWN DEVIATION: stone is quieter than concrete, where §3.9 says louder', () => {
    const delta = body('stone') - body('concrete');
    expect(
      Math.abs(delta - STONE_IS_QUIETER_THAN_ITS_MULTIPLIER.measuredDeltaDb),
      STONE_IS_QUIETER_THAN_ITS_MULTIPLIER.why,
    ).toBeLessThanOrEqual(STONE_IS_QUIETER_THAN_ITS_MULTIPLIER.tol);
    expect(delta).toBeLessThan(0); // the deviation itself
    // Metal's multiplier, by contrast, arrives: ×1.5 is +3.52 dB.
    expect(body('metal') - body('concrete')).toBeCloseTo(20 * Math.log10(1.5), 0);
  });
});
