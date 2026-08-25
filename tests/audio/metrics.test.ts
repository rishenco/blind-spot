/**
 * The instrument, tested against arithmetic.
 *
 * This is the file that matters most in the audio harness, and it is deliberately the one that
 * touches no game code and no audio backend. Everything measured here is a signal built by hand
 * whose answer is known analytically — a sine's RMS is amplitude/√2, a decaying exponential's
 * energy in a window is a closed-form integral, white noise's spectral centroid is a quarter of
 * the sample rate. If a metric disagrees with the closed form, the metric is wrong.
 *
 * The failure mode this exists to prevent has a specific shape, and the harness ran straight
 * into it: **a metric that is wrong will happily pin a wrong number forever.** The audio
 * prototype measured spectral centroid with an unwindowed 4096-sample DFT and concluded that
 * centroid cannot tell metal from stone (2713 Hz vs 2756 Hz). Re-measured with a Hann window,
 * the same two sounds read 1805 Hz and 765 Hz. The original numbers were mostly the *rectangular
 * window's own leakage skirts*, not the sounds — a measurement that would have gone green over
 * anything. Nothing downstream can catch that; only testing the instrument can.
 *
 * The FFT is `fft.js` rather than a hand-rolled one, and borrowing it does not excuse trusting
 * it: the spectral assertions below pin its bin layout to within one bin (a 1 kHz tone one bin
 * off reads 1012 Hz, and the tolerance here is ±3 Hz), its treatment of the Nyquist bin (white
 * noise's centroid), and its inverse transform (`estimateF0` round-trips forward and back).
 */

import { describe, expect, it } from 'vitest';
import {
  SILENCE_DB,
  centroidHz,
  estimateF0,
  hasNaN,
  peakInfo,
  rmsDb,
  stereoEnergyRatio,
  tailDb,
  toDb,
} from '../support/audioMetrics';
import { TEST_SAMPLE_RATE, bufferOf } from '../support/audioRender';
import { makeRng } from '../../src/core/rng';

const SR = TEST_SAMPLE_RATE;

/** One second of a sine, sampled exactly — no phase offset, so the answers stay closed-form. */
function sine(hz: number, amplitude = 1, seconds = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

/** Sum of sines — for testing that the centroid really is a magnitude-weighted mean. */
function sines(parts: readonly { hz: number; amplitude: number }[], seconds = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (const part of parts) {
    for (let i = 0; i < n; i++) {
      out[i]! += part.amplitude * Math.sin((2 * Math.PI * part.hz * i) / SR);
    }
  }
  return out;
}

/** Uniform white noise from the game's own seeded generator. Deterministic across machines. */
function noise(seed: number, amplitude = 1, seconds = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const rnd = makeRng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * amplitude;
  return out;
}

function silence(seconds = 1): Float32Array {
  return new Float32Array(Math.round(seconds * SR));
}

// ---------------------------------------------------------------------------

describe('toDb and the silence floor', () => {
  it('converts amplitude to dBFS', () => {
    expect(toDb(1)).toBe(0);
    expect(toDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(toDb(Math.SQRT1_2)).toBeCloseTo(-3.0103, 4);
  });

  /**
   * The reason the floor is a number and not `-Infinity`: a failing assertion has to print
   * something a human can compare against the value they pinned.
   */
  it('reports digital silence as a comparable number, not -Infinity', () => {
    expect(toDb(0)).toBe(SILENCE_DB);
    expect(toDb(-1)).toBe(SILENCE_DB); // a negative amplitude is a caller bug, not a quiet sound
    expect(Number.isFinite(toDb(0))).toBe(true);
    // Anything genuinely quieter than the floor is clamped up to it — a lie only inside a region
    // that is silent by any definition that matters (the floor is 110 dB below a 16-bit LSB).
    expect(toDb(1e-30)).toBe(SILENCE_DB);
  });
});

describe('rmsDb', () => {
  /**
   * The single most load-bearing constant in the file. A full-scale sine is −3.01 dBFS, exactly,
   * and if this drifts every dB number in `audioSpec.ts` is measured against a broken ruler.
   */
  it('reads a full-scale sine at -3.01 dBFS', () => {
    expect(rmsDb(bufferOf([sine(1000)]))).toBeCloseTo(-3.0103, 3);
  });

  it('scales exactly with amplitude', () => {
    const full = rmsDb(bufferOf([sine(1000, 1)]));
    expect(rmsDb(bufferOf([sine(1000, 0.5)]))).toBeCloseTo(full - 6.0206, 3);
    expect(rmsDb(bufferOf([sine(1000, 0.1)]))).toBeCloseTo(full - 20, 3);
  });

  /** Uniform noise on [−1, 1] has RMS 1/√3, which is −4.77 dBFS. */
  it('reads uniform white noise at -4.77 dBFS', () => {
    expect(rmsDb(bufferOf([noise(7)]))).toBeCloseTo(20 * Math.log10(1 / Math.sqrt(3)), 1);
  });

  it('reads silence at the floor', () => {
    expect(rmsDb(bufferOf([silence()]))).toBe(SILENCE_DB);
  });

  /**
   * The mixdown averages rather than sums, which is what makes a stereo render's level
   * comparable to a mono one — and which costs 6 dB on a hard-panned signal. Both halves of that
   * trade are pinned here because the second half is the one that surprises people.
   */
  it('mixes channels down by averaging, so a duplicated mono signal keeps its level', () => {
    const tone = sine(1000);
    expect(rmsDb(bufferOf([tone, tone]))).toBeCloseTo(-3.0103, 3);
  });

  it('reads a hard-panned tone 6 dB low in the mixdown, and correctly per channel', () => {
    const panned = bufferOf([sine(1000), silence()]);
    expect(rmsDb(panned)).toBeCloseTo(-3.0103 - 6.0206, 3);
    expect(rmsDb(panned, 0)).toBeCloseTo(-3.0103, 3);
    expect(rmsDb(panned, 1)).toBe(SILENCE_DB);
  });

  it('windows by seconds, and clamps a window that runs past the buffer', () => {
    // Half a second of tone, half a second of nothing.
    const half = new Float32Array(SR);
    half.set(sine(1000, 1, 0.5), 0);
    const buffer = bufferOf([half]);
    expect(rmsDb(buffer, undefined, 0, 0.5)).toBeCloseTo(-3.0103, 3);
    expect(rmsDb(buffer, undefined, 0.5, 1)).toBe(SILENCE_DB);
    // Whole buffer: half the energy, so 3 dB down.
    expect(rmsDb(buffer)).toBeCloseTo(-3.0103 - 3.0103, 2);
    // Past the end measures what exists, rather than throwing — `toSec = Infinity` is the common
    // call and a short render is a legitimate thing to ask about.
    expect(rmsDb(buffer, undefined, 0, 99)).toBeCloseTo(rmsDb(buffer), 9);
    // A window entirely outside the buffer has no samples, and no samples is silence.
    expect(rmsDb(buffer, undefined, 5, 6)).toBe(SILENCE_DB);
  });
});

describe('peakInfo', () => {
  it('finds the peak, its time, and whether headroom is gone', () => {
    const info = peakInfo(bufferOf([sine(1000)]));
    expect(info.peak).toBeCloseTo(1, 5);
    expect(info.peakDb).toBeCloseTo(0, 3);
    // A 1 kHz sine first reaches its crest a quarter period in: 0.25 ms.
    expect(info.peakAtSec).toBeCloseTo(0.00025, 5);
    expect(info.clipped).toBe(true);
  });

  it('leaves clipped false when there is headroom', () => {
    expect(peakInfo(bufferOf([sine(1000, 0.99)])).clipped).toBe(false);
    expect(peakInfo(bufferOf([sine(1000, 0.99)])).peakDb).toBeCloseTo(-0.0873, 3);
  });

  /**
   * Ties resolve to the earliest *time*, not to the lowest channel index — the attack, not an
   * echo of it. Scanning channel-major would report the right level at the wrong moment, which
   * is the kind of wrong that only shows up when someone asserts on timing.
   */
  it('reports the earliest instant of the peak across channels', () => {
    const early = new Float32Array(100);
    const late = new Float32Array(100);
    late[10] = 1; // channel 1 peaks first
    early[40] = 1;
    const info = peakInfo(bufferOf([early, late], 1000));
    expect(info.peak).toBe(1);
    expect(info.peakAtSec).toBeCloseTo(0.01, 9);
  });

  it('reports silence without pretending it peaked somewhere', () => {
    const info = peakInfo(bufferOf([silence()]));
    expect(info.peak).toBe(0);
    expect(info.peakDb).toBe(SILENCE_DB);
    expect(info.clipped).toBe(false);
  });
});

describe('tailDb', () => {
  /**
   * The load-bearing metric of the material system, checked against a closed form.
   *
   * For x(t) = sin(2πft)·e^(−t/τ), the mean square over [a, b) is
   *   (1/2)·(τ/2)·(e^(−2a/τ) − e^(−2b/τ)) / (b − a)
   * (the ½ is the sine's mean square; the rest is ∫e^(−2t/τ)). If `tailDb` and that integral
   * agree to a hundredth of a dB across two different decay constants, `tailDb` is measuring
   * decay and not something correlated with it.
   */
  it.each([0.02, 0.05, 0.1, 0.25])('matches the analytic energy of an e^(-t/%s) decay', (tau) => {
    const n = SR;
    const decaying = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      decaying[i] = Math.sin((2 * Math.PI * 500 * i) / SR) * Math.exp(-i / SR / tau);
    }
    const buffer = bufferOf([decaying, decaying]);
    const [a, b] = [0.2, 0.3];
    const meanSquare = 0.5 * (tau / 2) * (Math.exp((-2 * a) / tau) - Math.exp((-2 * b) / tau)) / (b - a);
    expect(tailDb(buffer, a, b)).toBeCloseTo(20 * Math.log10(Math.sqrt(meanSquare)), 2);
  });

  /**
   * The reason `tailDb` takes an end time at all. A render with two strikes 0.4 s apart has a
   * second attack sitting inside any open-ended tail window, and the open-ended answer is ~50 dB
   * louder than the truth — which would read as "this material rings" when it does not.
   */
  it('needs its window bounded, or the next strike lands inside the tail', () => {
    const n = SR;
    const twoStrikes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const first = Math.exp(-i / SR / 0.02);
      const t2 = (i - 0.4 * SR) / SR;
      const second = t2 >= 0 ? Math.exp(-t2 / 0.02) : 0;
      twoStrikes[i] = Math.sin((2 * Math.PI * 500 * i) / SR) * (first + second);
    }
    const buffer = bufferOf([twoStrikes]);
    const bounded = tailDb(buffer, 0.2, 0.35);
    const unbounded = tailDb(buffer, 0.2);
    expect(bounded).toBeLessThan(-100);
    expect(unbounded).toBeGreaterThan(bounded + 40);
  });

  it('is rmsDb of the mixdown with the window named after the question', () => {
    const buffer = bufferOf([sine(1000), sine(1000)]);
    expect(tailDb(buffer, 0.3, 0.6)).toBeCloseTo(rmsDb(buffer, undefined, 0.3, 0.6), 9);
  });
});

describe('stereoEnergyRatio', () => {
  it('is 1 for a centred signal and for a mono buffer', () => {
    const tone = sine(1000);
    expect(stereoEnergyRatio(bufferOf([tone, tone]))).toBeCloseTo(1, 9);
    // One channel cannot be unbalanced, so a mono buffer is centred by definition rather than
    // by measurement — otherwise every mono render would fail a panning assertion by dividing
    // by a channel that is not there.
    expect(stereoEnergyRatio(bufferOf([tone]))).toBe(1);
  });

  it('is Infinity hard left and 0 hard right', () => {
    expect(stereoEnergyRatio(bufferOf([sine(1000), silence()]))).toBe(Infinity);
    expect(stereoEnergyRatio(bufferOf([silence(), sine(1000)]))).toBe(0);
  });

  it('reads an energy ratio, so a 6 dB lean reads as 4', () => {
    expect(stereoEnergyRatio(bufferOf([sine(1000, 1), sine(1000, 0.5)]))).toBeCloseTo(4, 6);
  });

  /**
   * Silence returns NaN rather than 1. A dead render must not pass a panning test by looking
   * perfectly centred — that is the exact failure a panning test exists to catch.
   */
  it('refuses to call silence centred', () => {
    expect(stereoEnergyRatio(bufferOf([silence(), silence()]))).toBeNaN();
  });

  it('windows like the other metrics', () => {
    const left = new Float32Array(SR);
    const right = new Float32Array(SR);
    left.set(sine(1000, 1, 0.5), 0);
    right.set(sine(1000, 1, 0.5), SR / 2);
    const buffer = bufferOf([left, right]);
    expect(stereoEnergyRatio(buffer, 0, 0.5)).toBe(Infinity);
    expect(stereoEnergyRatio(buffer, 0.5, 1)).toBe(0);
    expect(stereoEnergyRatio(buffer)).toBeCloseTo(1, 6);
  });
});

describe('hasNaN', () => {
  it('is false for every well-formed signal', () => {
    expect(hasNaN(bufferOf([sine(1000), noise(3)]))).toBe(false);
    expect(hasNaN(bufferOf([silence()]))).toBe(false);
  });

  /**
   * One non-finite sample poisons every summing node downstream, so this runs before every other
   * assertion in the audio tests: a NaN render makes most metrics return NaN, and every NaN
   * comparison is false, which is precisely how a broken render passes a suite.
   */
  it('catches NaN and, deliberately, ±Infinity too', () => {
    const withNaN = new Float32Array(100);
    withNaN[50] = NaN;
    const withInf = new Float32Array(100);
    withInf[50] = Infinity;
    const withNegInf = new Float32Array(100);
    withNegInf[99] = -Infinity;
    expect(hasNaN(bufferOf([withNaN]))).toBe(true);
    expect(hasNaN(bufferOf([withInf]))).toBe(true);
    expect(hasNaN(bufferOf([withNegInf]))).toBe(true);
    // And in any channel, not just the first.
    expect(hasNaN(bufferOf([new Float32Array(100), withNaN]))).toBe(true);
  });
});

describe('centroidHz', () => {
  /**
   * A single tone must land on itself. This is also the bin-layout test for `fft.js`: one bin at
   * a 4096-point frame and 48 kHz is 11.7 Hz, so an off-by-one in the spectrum indexing would
   * read ~1012 Hz and blow a ±3 Hz tolerance wide open.
   */
  it.each([100, 440, 1000, 4000])('puts a %d Hz sine on itself', (hz) => {
    expect(centroidHz(bufferOf([sine(hz)]))).toBeCloseTo(hz, -0.5);
  });

  /**
   * The centroid is a magnitude-weighted mean, so two tones land on their weighted mean. This is
   * the assertion a mirrored or half-filled spectrum cannot survive: fold the upper half in and
   * the answer moves by hundreds of Hz.
   *
   * It lands *near* the weighted mean rather than on it, and the ~1 % shortfall is the metric's
   * one documented inaccuracy rather than a bug: the sum of a windowed tone's bin magnitudes
   * depends slightly on where the tone falls between bins, so 500 Hz (two thirds of a bin off
   * centre) is weighted a shade more heavily than 1500 Hz (exactly on a bin). Pinned at ±20 Hz
   * so the bias stays visible and stays small — if it ever grows past that, the windowing has
   * changed underneath the whole material table.
   */
  it('lands on the magnitude-weighted mean of two tones, to within the scalloping bias', () => {
    const even = centroidHz(bufferOf([sines([{ hz: 500, amplitude: 1 }, { hz: 1500, amplitude: 1 }])]));
    expect(Math.abs(even - 1000)).toBeLessThan(20);
    const weighted = centroidHz(bufferOf([sines([{ hz: 1000, amplitude: 1 }, { hz: 3000, amplitude: 0.5 }])]));
    // (1000·1 + 3000·0.5) / 1.5 = 1666.7
    expect(Math.abs(weighted - 1666.7)).toBeLessThan(40);
  });

  /**
   * Uniform white noise has a flat magnitude spectrum, so its centroid is the mean of the
   * frequency axis: sampleRate/4 = 12 kHz. This one pins the *top* of the spectrum — drop the
   * Nyquist bin or stop early and the answer sags.
   */
  it('puts white noise at a quarter of the sample rate', () => {
    expect(centroidHz(bufferOf([noise(11)]))).toBeCloseTo(SR / 4, -2.5);
  });

  it('ignores overall gain — brightness is a shape, not a level', () => {
    const loud = centroidHz(bufferOf([sine(1000, 0.9)]));
    const quiet = centroidHz(bufferOf([sine(1000, 0.001)]));
    expect(quiet).toBeCloseTo(loud, 3);
  });

  /**
   * A constant offset — which a badly-terminated gain ramp leaves behind — must not drag the
   * answer toward zero.
   *
   * This test found a real bug in the metric. Excluding bin 0 is not enough: the Hann mainlobe
   * is four bins wide, so DC leaks into bins 1 and 2, and a +0.5 offset on a full-scale 1 kHz
   * sine read **810 Hz**. The fix is to subtract each frame's mean before windowing. Exactly the
   * kind of quiet 19 % error that would have been pinned as a material's "brightness" and
   * defended for months.
   */
  it('is blind to a DC offset', () => {
    const tone = sine(1000);
    const offset = new Float32Array(tone.length);
    for (let i = 0; i < tone.length; i++) offset[i] = tone[i]! + 0.5;
    expect(centroidHz(bufferOf([offset]))).toBeCloseTo(centroidHz(bufferOf([tone])), 1);
  });

  it('has no answer for silence, and says so', () => {
    expect(centroidHz(bufferOf([silence()]))).toBeNaN();
  });

  /**
   * A window too short to resolve a spectrum is a bug in the test, not a question with a quiet
   * answer — so it throws rather than returning something plausible.
   */
  it('throws rather than guessing when the window is too short', () => {
    const tiny = bufferOf([sine(1000, 1, 0.001)]); // 48 samples
    expect(() => centroidHz(tiny)).toThrow(/at least 256/);
  });

  /**
   * The finding that shaped this harness, reproduced on a signal whose answer is known.
   *
   * The prototype measured centroid with an *unwindowed* 4096-sample DFT. A rectangular window's
   * sidelobes fall off at only 6 dB/octave, so a transient's leakage skirt spreads energy across
   * the entire spectrum and the centroid measures the skirt instead of the signal. Here that is
   * made falsifiable: a pure 1 kHz sine analysed over a window that does not contain a whole
   * number of periods reads far above 1 kHz without a window function, and lands on 1 kHz with
   * one. The prototype's "metal 2713 Hz, stone 2756 Hz — indistinguishable" was that skirt.
   */
  it('windows its frames, without which leakage would dominate the answer', () => {
    // A 4096-sample frame at 48 kHz holds 85.3 periods of 1000 Hz — a deliberately non-integer
    // count, which is the ordinary case and the one leakage punishes.
    const tone = sine(1000, 1, 0.09);
    expect(centroidHz(bufferOf([tone]))).toBeCloseTo(1000, -0.7);

    // The same frame with no window, measured by brute force here so the comparison is real and
    // not a claim: this is what the prototype's instrument was doing.
    const n = 4096;
    let num = 0;
    let den = 0;
    for (let k = 1; k <= n / 2; k++) {
      let re = 0;
      let im = 0;
      const w = (2 * Math.PI * k) / n;
      for (let i = 0; i < n; i++) {
        re += tone[i]! * Math.cos(w * i);
        im -= tone[i]! * Math.sin(w * i);
      }
      const mag = Math.hypot(re, im);
      num += ((k * SR) / n) * mag;
      den += mag;
    }
    const rectangular = num / den;
    // Same 1 kHz sine, same frame length, same bins: the unwindowed answer is 2.5x too high, and
    // every Hz of that excess is the window's own leakage skirt.
    expect(rectangular).toBeGreaterThan(2000);
    expect(rectangular).toBeGreaterThan(2 * centroidHz(bufferOf([tone])));
  });
});

describe('estimateF0', () => {
  /**
   * Sub-cent accuracy on a steady tone, including at frequencies whose period is not an integer
   * number of samples — which is what the parabolic interpolation is for. Without it the answer
   * is quantised to sampleRate/lag, a 21 Hz step at 1 kHz, and the Halo's pitch readout would
   * look like it was stepping when the game was smooth.
   */
  it.each([55, 100, 220, 440, 997, 1000, 1234.567])('reads a %d Hz sine', (hz) => {
    const measured = estimateF0(bufferOf([sine(hz)]));
    const cents = 1200 * Math.log2(measured / hz);
    expect(Math.abs(cents)).toBeLessThan(1);
  });

  /**
   * Autocorrelation finds the *period*, not the loudest partial — so a tone with no energy at
   * its fundamental still reports the fundamental. Right for a pitch readout, and worth pinning
   * because it is also the behaviour that surprises whoever expected "strongest frequency".
   */
  it('finds a missing fundamental', () => {
    const missing = sines([
      { hz: 400, amplitude: 1 },
      { hz: 600, amplitude: 1 },
      { hz: 800, amplitude: 0.8 },
    ]);
    expect(estimateF0(bufferOf([missing]))).toBeCloseTo(200, 0);
  });

  /**
   * The octave guard. A perfectly periodic signal correlates just as well at twice its period,
   * so taking the global maximum drops an octave whenever float noise favours the multiple.
   */
  it('does not drop an octave on a strongly harmonic signal', () => {
    const harmonic = sines([
      { hz: 150, amplitude: 1 },
      { hz: 300, amplitude: 0.9 },
      { hz: 450, amplitude: 0.7 },
      { hz: 600, amplitude: 0.5 },
    ]);
    expect(estimateF0(bufferOf([harmonic]))).toBeCloseTo(150, 0);
  });

  /**
   * 0, not NaN, so `expect(f0).toBe(0)` is an assertion rather than a comparison that is false
   * either way. White noise's normalised autocorrelation at non-zero lag has standard deviation
   * ~1/√N, which for a one-second window is ~0.005 — nowhere near the 0.3 confidence floor, so
   * this is a wide moat and not a tuned threshold.
   */
  it('returns 0 for anything unpitched', () => {
    expect(estimateF0(bufferOf([noise(5)]))).toBe(0);
    expect(estimateF0(bufferOf([silence()]))).toBe(0);
    const click = new Float32Array(SR);
    click[100] = 1;
    expect(estimateF0(bufferOf([click]))).toBe(0);
  });

  it('is blind to level and to a DC offset', () => {
    expect(estimateF0(bufferOf([sine(440, 0.001)]))).toBeCloseTo(440, 0);
    const tone = sine(440);
    const offset = new Float32Array(tone.length);
    for (let i = 0; i < tone.length; i++) offset[i] = tone[i]! * 0.3 + 0.6;
    expect(estimateF0(bufferOf([offset]))).toBeCloseTo(440, 0);
  });

  it('honours the search band, and gives up rather than guessing outside it', () => {
    const buffer = bufferOf([sine(440)]);
    expect(estimateF0(buffer, 0, Infinity, 300, 600)).toBeCloseTo(440, 0);
    // 440 Hz is below the band, so there is no candidate lag: 0, not a wrong number.
    expect(estimateF0(buffer, 0, Infinity, 800, 2000)).toBe(0);
  });

  /**
   * One number for the whole window, so a sweep must be measured on a plateau — which is exactly
   * how the Halo hum has to be tested, since the hum *is* a sweep between the movement tiers.
   *
   * The good news, and the reason this is safe: a sweep measured whole does not return a
   * confidently wrong number in the middle of its range. It has no single period, the
   * autocorrelation never crosses the confidence floor, and the answer is 0 — "there is no pitch
   * here". A window narrow enough to sit on one part of the sweep reads that part.
   */
  it('answers for the window as a whole, so a sweep must be sampled on its plateaus', () => {
    const n = SR;
    const sweep = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const hz = 200 + (600 * i) / n; // 200 → 800 Hz over the second
      phase += (2 * Math.PI * hz) / SR;
      sweep[i] = Math.sin(phase);
    }
    const buffer = bufferOf([sweep]);
    expect(estimateF0(buffer)).toBe(0);
    // A short window near the start reads the start; near the end, the end.
    expect(estimateF0(buffer, 0, 0.08)).toBeLessThan(280);
    expect(estimateF0(buffer, 0, 0.08)).toBeGreaterThan(180);
    expect(estimateF0(buffer, 0.92, 1)).toBeGreaterThan(720);
    expect(estimateF0(buffer, 0.92, 1)).toBeLessThan(820);
  });
});
