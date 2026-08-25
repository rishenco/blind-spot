/**
 * The phonometric vocabulary — what a test is allowed to say about a rendered sound.
 *
 * The photometric suite (`tools/shoot.mjs`) exists because "look at the screenshot" is not a
 * test: it decodes the PNG and asserts on pixels. This file is the same move for the other half
 * of the perception channel. Audio in BLIND SPOT is not decoration — §3 makes sound the *only*
 * way the player sees, so "listen to it and see if it sounds metallic" is not a test either.
 * Every claim an audio test makes has to reduce to a number some function here produced.
 *
 * Three rules the whole file obeys, because a measuring instrument that drifts is worse than no
 * instrument at all — it pins wrong numbers and passes forever:
 *
 *  1. **Deterministic.** No sampling, no randomness, no wall clock, no thresholds that depend on
 *     the buffer's length in a way the caller cannot see. The same buffer always yields the same
 *     number, bit for bit, on every machine.
 *  2. **Documented negatively.** Each metric says what it does *not* measure. Spectral centroid
 *     is the standing example (see tests/audio/materialVoices.test.ts): it looks like the
 *     obvious way to tell materials apart, it cannot *order* them, and the prototype that first
 *     measured it got even the pairwise answer wrong because its FFT was unwindowed. A test
 *     built on it would have gone green over mush.
 *  3. **Structural, not nominal.** Everything takes `AudioBufferLike`, so the same metric reads
 *     an `OfflineAudioContext` render, a hand-built probe signal, or a decoded file. Nothing here
 *     imports the audio backend; nothing here knows what a game is.
 *
 * The FFT is `fft.js` (radix-4, ~750k downloads/week, ships its own types) rather than a
 * hand-rolled one, per CLAUDE.md. It is still tested against analytically known signals in
 * tests/audio/metrics.test.ts: borrowing an FFT does not excuse trusting it.
 */

import FFT from 'fft.js';

/**
 * The shape every metric reads.
 *
 * Deliberately structural and deliberately minimal: `AudioBuffer` from node-web-audio-api, the
 * browser's `AudioBuffer`, and a plain object built by a test all satisfy it. That keeps the
 * metrics importable from a context that has no audio backend at all.
 */
export interface AudioBufferLike {
  readonly sampleRate: number;
  /** Frames per channel. */
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * dBFS reported for digital silence, and the floor every dB metric clamps to.
 *
 * A number rather than `-Infinity` so a failing assertion prints something a human can compare,
 * and so a diff of pinned values stays a diff of numbers. −200 dBFS is ~110 dB below the least
 * significant bit of 16-bit audio: nothing audible, and nothing a render can legitimately land on
 * gets clamped up to it. Values genuinely below it (float32 reaches ~−760 dBFS) are reported as
 * the floor, which is a lie only in a region that is silent by any definition that matters.
 */
export const SILENCE_DB = -200;

/** Largest analysis frame the spectral metrics use, in samples. See `centroidHz`. */
const MAX_FRAME = 4096;
/** Smallest analysis frame that still resolves anything useful at 48 kHz (~11.7 Hz per bin). */
const MIN_FRAME = 256;

// ---------------------------------------------------------------------------
// region helpers

/** Amplitude → dBFS, floored at `SILENCE_DB`. Not RMS-aware: feed it a linear magnitude. */
export function toDb(amplitude: number): number {
  if (!(amplitude > 0)) return SILENCE_DB;
  const db = 20 * Math.log10(amplitude);
  return db < SILENCE_DB ? SILENCE_DB : db;
}

/**
 * Seconds → the half-open sample range `[start, end)`, clamped to the buffer.
 *
 * Clamping rather than throwing: `toSec = Infinity` means "to the end" at every call site, and a
 * window that runs past a short render is a question with an honest answer (measure what exists)
 * rather than a crash. A window that is entirely outside the buffer collapses to zero samples,
 * and every metric treats zero samples as silence.
 */
function range(buffer: AudioBufferLike, fromSec: number, toSec: number): [number, number] {
  const sr = buffer.sampleRate;
  const rawStart = Number.isFinite(fromSec) ? Math.round(fromSec * sr) : 0;
  const rawEnd = Number.isFinite(toSec) ? Math.round(toSec * sr) : buffer.length;
  const start = Math.max(0, Math.min(buffer.length, rawStart));
  const end = Math.max(start, Math.min(buffer.length, rawEnd));
  return [start, end];
}

/**
 * The region as one Float32Array.
 *
 * `channel === undefined` mixes every channel down by *averaging* (not summing): a mono signal
 * duplicated to both channels keeps its level, which is what makes a stereo render's RMS
 * comparable to a mono one. The cost, stated because it bites: a hard-panned pair is 6 dB
 * quieter in the mixdown than either channel alone, and a signal panned in *anti-phase* cancels
 * to nothing. Use `stereoEnergyRatio` for balance questions and an explicit channel index when
 * phase matters.
 */
function region(
  buffer: AudioBufferLike,
  channel: number | undefined,
  start: number,
  end: number,
): Float32Array {
  const n = end - start;
  const out = new Float32Array(n);
  if (n === 0) return out;
  if (channel !== undefined) {
    out.set(buffer.getChannelData(channel).subarray(start, end));
    return out;
  }
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[start + i]!;
  }
  if (channels > 1) for (let i = 0; i < n; i++) out[i]! /= channels;
  return out;
}

/** Sum of squares over a region — the primitive both `rmsDb` and `stereoEnergyRatio` sit on. */
function energy(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return sum;
}

// ---------------------------------------------------------------------------
// level

/**
 * Root-mean-square level of a region, in dBFS.
 *
 * **Measures:** average power over the whole window. A full-scale sine reads −3.01 dBFS; a
 * full-scale square reads 0.
 *
 * **Does not measure:** anything about *when* the energy happened. A 10 ms click in a 10 s window
 * reads as near-silence, and a window that is 90 % silence reads 10 dB low — RMS is only as
 * meaningful as the window you chose, so choose the window deliberately and say why. For "is
 * anything left after the strike", use `tailDb`, which is the same arithmetic with the window
 * named after the question.
 *
 * @param channel Channel index, or `undefined` for the averaged mixdown (see `region`).
 */
export function rmsDb(
  buffer: AudioBufferLike,
  channel?: number,
  fromSec = 0,
  toSec = Infinity,
): number {
  const [start, end] = range(buffer, fromSec, toSec);
  const samples = region(buffer, channel, start, end);
  if (samples.length === 0) return SILENCE_DB;
  return toDb(Math.sqrt(energy(samples) / samples.length));
}

export interface PeakInfo {
  /** Largest absolute sample value found in any channel. */
  peak: number;
  /** `peak` in dBFS, floored at `SILENCE_DB`. */
  peakDb: number;
  /** Time of the earliest sample that attains `peak`, in seconds. */
  peakAtSec: number;
  /**
   * True when `peak >= 1`. The float render itself is undamaged — this is a headroom claim:
   * anything at or above full scale clips the moment it reaches an integer output or a device.
   */
  clipped: boolean;
}

/**
 * Peak amplitude, where it happened, and whether the mix has headroom left.
 *
 * **Measures:** the single loudest instant, scanned sample-major across channels so ties resolve
 * to the *earliest* time rather than to the lowest channel index — the attack, not an echo of it.
 *
 * **Does not measure:** loudness. A transient can peak at −1 dBFS and be inaudible next to a
 * sustained −20 dBFS tone. Peak is a clipping and timing metric; `rmsDb` is the loudness one.
 */
export function peakInfo(buffer: AudioBufferLike): PeakInfo {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  let peak = 0;
  let peakIndex = 0;
  for (let i = 0; i < buffer.length; i++) {
    for (const data of channels) {
      const a = Math.abs(data[i]!);
      if (a > peak) {
        peak = a;
        peakIndex = i;
      }
    }
  }
  return {
    peak,
    peakDb: toDb(peak),
    peakAtSec: peakIndex / buffer.sampleRate,
    clipped: peak >= 1,
  };
}

/**
 * How much sound is left in a window that starts *after* an event, in dBFS.
 *
 * This is the load-bearing metric of the material system, and it earns the separate name even
 * though the arithmetic is `rmsDb` with a different window. The finding it exists to express:
 * spectral centroid does **not** separate metal from stone (they land within ~2 % of each other),
 * but the ring tail separates them by more than 40 dB — metal is still singing 150–300 ms after
 * the strike where concrete, stone and dust are already at the noise floor. §3.9 says a surface's
 * material must be audible; *this number is what "audible" means* for a struck surface, and a
 * test that pinned centroid instead would go green while the material voices turned to mush.
 *
 * **Measures:** RMS of the averaged mixdown over `[afterSec, toSec)`.
 *
 * **Does not measure:** the strike itself, or *why* the tail is there. Bound the window: the
 * open-ended form runs to the end of the buffer, and in a render with more than one strike that
 * silently includes the next one. Absolute dBFS also moves with gain staging — assert the
 * *difference* between two materials when you want the claim to survive a mix change.
 */
export function tailDb(buffer: AudioBufferLike, afterSec: number, toSec = Infinity): number {
  return rmsDb(buffer, undefined, afterSec, toSec);
}

/**
 * Left energy divided by right energy over a region.
 *
 * 1 is centred, > 1 leans left, < 1 leans right, `Infinity` is hard left (right is digitally
 * silent), 0 is hard right. A **mono buffer returns exactly 1** — one channel cannot be
 * unbalanced — and a region that is silent in both channels returns `NaN`, because a silent
 * signal has no balance and pretending it is centred would let a dead render pass a panning test.
 *
 * **Measures:** energy ratio only.
 *
 * **Does not measure:** perceived direction. An HRTF panner encodes direction largely in
 * inter-aural *time* and spectral shaping, so a hard-right HRTF source still puts real energy in
 * the left ear — assert HRTF loosely (a ratio well under 1) and `equalpower` tightly.
 */
export function stereoEnergyRatio(
  buffer: AudioBufferLike,
  fromSec = 0,
  toSec = Infinity,
): number {
  if (buffer.numberOfChannels < 2) return 1;
  const [start, end] = range(buffer, fromSec, toSec);
  const left = energy(region(buffer, 0, start, end));
  const right = energy(region(buffer, 1, start, end));
  if (left === 0 && right === 0) return NaN;
  if (right === 0) return Infinity;
  return left / right;
}

/**
 * True when any sample in any channel is not a finite number.
 *
 * Named for NaN because NaN is how this usually arrives — an `exponentialRampToValueAtTime`
 * aimed at 0, a divide by a zero gain, an uninitialised buffer — but it deliberately catches
 * ±Infinity too, because the consequence is identical: one non-finite sample poisons every
 * summing node downstream and turns the entire mix silent or into a DC blast. Every audio test
 * should assert this before it asserts anything else, since a NaN render makes most other
 * metrics quietly return NaN and NaN comparisons are always false — the exact failure mode where
 * a broken render passes a test suite.
 */
export function hasNaN(buffer: AudioBufferLike): boolean {
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i]!)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// spectrum

/** Largest power of two ≤ n, clamped into the analysis-frame band. Zero if the region is short. */
function frameSizeFor(n: number): number {
  if (n < MIN_FRAME) return 0;
  let size = MIN_FRAME;
  while (size * 2 <= n && size * 2 <= MAX_FRAME) size *= 2;
  return size;
}

/** Hann window of length n. Periodic form (denominator n, not n−1) — the correct one for FFTs. */
function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Magnitude spectrum of a region, averaged over Hann-windowed half-overlapping frames.
 *
 * Returns bins 0…size/2 inclusive (Nyquist included); `binHz` is the width of one bin. Averaging
 * frames rather than analysing one is what makes the result stable: a single frame's answer moves
 * with exactly where it landed relative to the attack, which would make every spectral assertion
 * depend on a start time nobody chose deliberately.
 */
function magnitudeSpectrum(
  samples: Float32Array,
  sampleRate: number,
): { mags: Float64Array; binHz: number } | null {
  const size = frameSizeFor(samples.length);
  if (size === 0) return null;
  const fft = new FFT(size);
  const spectrum: number[] = fft.createComplexArray();
  const window = hann(size);
  const frame = new Float64Array(size);
  const mags = new Float64Array(size / 2 + 1);
  const hop = size / 2;
  let frames = 0;
  // Only whole frames. The final partial frame is dropped, so a region whose last <85 ms carries
  // the answer needs a window chosen to contain it — say so at the call site rather than here.
  for (let offset = 0; offset + size <= samples.length; offset += hop) {
    // Subtract the frame's mean *before* windowing. Dropping bin 0 is not enough on its own: the
    // Hann mainlobe is four bins wide, so a DC offset leaks into bins 1 and 2 and drags the
    // answer down — a +0.5 offset on a full-scale 1 kHz sine reads 810 Hz instead of 1000. The
    // cost is a highpass at one bin (11.7 Hz in a 4096-point frame at 48 kHz), which is below
    // anything audible and far below anything the game emits.
    let mean = 0;
    for (let i = 0; i < size; i++) mean += samples[offset + i]!;
    mean /= size;
    for (let i = 0; i < size; i++) frame[i] = (samples[offset + i]! - mean) * window[i]!;
    fft.realTransform(spectrum, frame);
    for (let k = 0; k <= size / 2; k++) {
      mags[k]! += Math.hypot(spectrum[2 * k]!, spectrum[2 * k + 1]!);
    }
    frames++;
  }
  if (frames === 0) return null;
  for (let k = 0; k < mags.length; k++) mags[k]! /= frames;
  return { mags, binHz: sampleRate / size };
}

/**
 * Spectral centroid — the magnitude-weighted mean frequency of a region, in Hz.
 *
 * **Measures:** where the energy sits on the frequency axis, averaged over Hann-windowed,
 * half-overlapping frames. A 1 kHz sine reads ~1000; brighter material reads higher. Each frame's
 * mean is removed before the transform, so a DC offset — which would otherwise drag every answer
 * toward zero, and does so even with bin 0 discarded — is invisible here.
 *
 * **Does not measure — and this is the finding the harness is built around — what a material *is*.**
 * It does not *order* materials by anything a designer would call hardness. In the M1 voices it
 * reads dust at 1006 Hz, above stone (751) and concrete (585), because dust is nearly all
 * broadband exciter and has no low modes to weigh it down. Brightness is a "scuff versus ring"
 * axis. Use it as a coarse partition (metal is far above the other three and stays there), never
 * as a ranking, and reach for `tailDb` when the question is "is this metal".
 *
 * The windowing is not a detail. The M1 prototype measured centroid with an *unwindowed* DFT and
 * reported metal at 2713 Hz and stone at 2756 Hz — indistinguishable, and both wrong: a
 * rectangular window's sidelobes fall off at 6 dB/octave, so a transient's leakage skirt spreads
 * across the whole spectrum and the centroid measures the skirt. The same two renders read 1795
 * and 751 through this function. `metrics.test.ts` pins that difference on a signal whose answer
 * is known, because it is the reason to trust one number over the other.
 *
 * Also not measured: pitch (a bright inharmonic clang and a pure tone can share a centroid — use
 * `estimateF0`), and anything at all about silence, which returns `NaN` because a signal with no
 * energy has no centre of energy.
 *
 * One documented inaccuracy, because it is inherent and not a bug to be fixed: the weighting is
 * by *magnitude*, and the sum of a windowed tone's bin magnitudes depends slightly on where the
 * tone falls between bins (scalloping). Two equal tones at 500 and 1500 Hz read ~987 rather than
 * 1000 — about 1.3 %, and always in the direction of whichever component sits furthest off-bin.
 * Immaterial against the ±10 % tolerances the material table uses; fatal if anyone ever tries to
 * assert a centroid to the Hz.
 *
 * Returns `NaN` for a silent region, and throws when the region is shorter than 256 samples
 * (~5 ms at 48 kHz) — too short to resolve a spectrum, and a window that small is a bug in the
 * test rather than a question worth an answer.
 */
export function centroidHz(buffer: AudioBufferLike, fromSec = 0, toSec = Infinity): number {
  const [start, end] = range(buffer, fromSec, toSec);
  const samples = region(buffer, undefined, start, end);
  const spectrum = magnitudeSpectrum(samples, buffer.sampleRate);
  if (spectrum === null) {
    throw new Error(
      `centroidHz: region [${fromSec}, ${toSec}) is ${samples.length} samples; ` +
        `at least ${MIN_FRAME} are needed to resolve a spectrum`,
    );
  }
  const { mags, binHz } = spectrum;
  let num = 0;
  let den = 0;
  for (let k = 1; k < mags.length; k++) {
    num += k * binHz * mags[k]!;
    den += mags[k]!;
  }
  return den === 0 ? NaN : num / den;
}

// ---------------------------------------------------------------------------
// pitch

/** Default pitch search band. 40 Hz is below the Halo's quietest hum; 2 kHz is above any of it. */
const F0_MIN_HZ = 40;
const F0_MAX_HZ = 2000;
/**
 * Normalised-autocorrelation floor below which a region is called unpitched.
 *
 * White noise's normalised ACF at non-zero lag has standard deviation ~1/√N — for a 0.1 s window
 * at 48 kHz that is ~0.005, so the largest of a thousand candidate lags sits far below 0.3. The
 * threshold is therefore not a tuning knob: it is a wide moat between "periodic" and "not".
 */
const F0_MIN_CONFIDENCE = 0.3;
/**
 * How close to the best peak a *lower* lag has to be before it is preferred.
 *
 * A perfectly periodic signal correlates just as well at twice its period, so taking the global
 * maximum drops an octave whenever float noise happens to favour the multiple. Taking the first
 * peak that is nearly as good instead is the standard fix and always lands on the fundamental.
 */
const F0_OCTAVE_GUARD = 0.85;

/**
 * Fundamental frequency of a region by autocorrelation, in Hz.
 *
 * **Measures:** the period of a periodic signal. Built for the Halo hum (§3.8), whose whole job
 * is to tell the player their audible radius through *pitch* — so a test that the hum rises with
 * loudness is a test that this function can read it. Accurate to well under a cent on a steady
 * tone: the peak lag is refined by parabolic interpolation, so the answer is not quantised to
 * `sampleRate / integerLag`.
 *
 * **Does not measure:** anything about an unpitched sound. White noise, a click and silence all
 * return **0** — the "no pitch here" answer, deliberately not `NaN`, so `expect(f0).toBe(0)` is
 * an assertion rather than a comparison that is false either way. Nor does it track a *moving*
 * pitch: the answer is one number for the whole window, so measure a plateau of a sweep, never
 * the sweep. Nor does it hear the loudest partial — for a sound with a missing or weak
 * fundamental it still reports the fundamental, which is right for pitch and wrong if what you
 * actually wanted was the strongest frequency present.
 *
 * The search band is 40–2000 Hz and the window must hold at least two periods of the lowest
 * candidate (~50 ms at 40 Hz); a window shorter than two periods of a tone cannot see it and the
 * function returns 0 rather than guessing.
 */
export function estimateF0(
  buffer: AudioBufferLike,
  fromSec = 0,
  toSec = Infinity,
  minHz = F0_MIN_HZ,
  maxHz = F0_MAX_HZ,
): number {
  const [start, end] = range(buffer, fromSec, toSec);
  const samples = region(buffer, undefined, start, end);
  const n = samples.length;
  if (n < 64) return 0;

  // Remove DC before correlating: a constant offset correlates perfectly with itself at every
  // lag and would swamp the periodic part.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i]!;
  mean /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = samples[i]! - mean;

  // Autocorrelation via FFT: zero-pad past 2n so the wrap-around of a circular correlation lands
  // in padding instead of in the answer.
  let size = 1;
  while (size < 2 * n) size *= 2;
  const fft = new FFT(size);
  const input: number[] = fft.createComplexArray();
  const spectrum: number[] = fft.createComplexArray();
  for (let i = 0; i < n; i++) input[2 * i] = x[i]!;
  fft.transform(spectrum, input);
  // |X|² is the power spectrum; its inverse transform is the autocorrelation (Wiener–Khinchin).
  for (let k = 0; k < size; k++) {
    const re = spectrum[2 * k]!;
    const im = spectrum[2 * k + 1]!;
    spectrum[2 * k] = re * re + im * im;
    spectrum[2 * k + 1] = 0;
  }
  const acfComplex: number[] = fft.createComplexArray();
  fft.inverseTransform(acfComplex, spectrum);

  const r0 = acfComplex[0]!;
  if (!(r0 > 0)) return 0; // digital silence

  const lagMin = Math.max(1, Math.ceil(buffer.sampleRate / maxHz));
  // Two bounds, whichever bites first: the requested low frequency, and half the window — beyond
  // that the unbiased estimate is averaging too few products to trust.
  const lagMax = Math.min(Math.floor(buffer.sampleRate / minHz), Math.floor(n / 2));
  if (lagMax <= lagMin + 1) return 0;

  // Unbiased and normalised: r[lag] sums only n−lag products, so without the correction every
  // long lag is spuriously small and the search leans sharp.
  const c = new Float64Array(lagMax + 2);
  const first = Math.max(1, lagMin - 1);
  const last = Math.min(lagMax + 1, n - 1);
  for (let lag = first; lag <= last; lag++) {
    c[lag] = (acfComplex[2 * lag]! / (n - lag)) / (r0 / n);
  }

  let best = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) if (c[lag]! > best) best = c[lag]!;
  if (best < F0_MIN_CONFIDENCE) return 0;

  // First local maximum within the octave guard of the best one — the fundamental, not a multiple.
  let chosen = -1;
  const threshold = best * F0_OCTAVE_GUARD;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (c[lag]! >= threshold && c[lag]! >= c[lag - 1]! && c[lag]! >= c[lag + 1]!) {
      chosen = lag;
      break;
    }
  }
  if (chosen < 0) return 0;

  // Parabolic interpolation through the three samples around the peak. Without it the answer is
  // quantised to sampleRate/lag, which at 1 kHz and 48 kHz is a 21 Hz step — useless for a pitch
  // readout the player is meant to hear as continuous.
  const y0 = c[chosen - 1]!;
  const y1 = c[chosen]!;
  const y2 = c[chosen + 1]!;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom === 0 ? 0 : (0.5 * (y0 - y2)) / denom;
  const lag = chosen + (Math.abs(shift) < 1 ? shift : 0);
  return lag > 0 ? buffer.sampleRate / lag : 0;
}
