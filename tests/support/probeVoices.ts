/**
 * Test signals shaped like the game's contact sounds — **not** the game's audio.
 *
 * The metrics in `audioMetrics.ts` are proved against sines and noise, whose answers are known
 * analytically. That proves the instrument. It does not prove the instrument can *see the thing
 * we care about*, which is §3.9's claim that a surface's material is audible: "the spider's
 * footfalls carry the material they strike, so its voice tells you what it is walking on".
 *
 * This file is the smallest signal that puts that claim under a number. It is the M1 audio
 * prototype's `contact` and `haloHum` voices, ported to TypeScript unchanged, and it lives in
 * `tests/` because it is a **fixture**: a stand-in whose only job is to exercise the two-axis
 * material fingerprint (`materialVoices.test.ts`). Nothing under `src/` imports it and nothing
 * ships it. When real voices land in `src/audio/`, this file is deleted and the same assertions
 * are pointed at the real builders — the assertions are the deliverable, not the sound.
 *
 * Two properties matter more than how it sounds:
 *  - **Seeded.** Every noise source is a `mulberry32` buffer, never `Math.random`. A pinned
 *    spectral number against an unseeded noise burst is a number that was true once.
 *  - **Native nodes only.** Built entirely from `ctx.create*` factories, which the browser and
 *    node-web-audio-api both implement identically, so nothing here is testable only in Node.
 */

/**
 * The seeded PRNG every noise source draws from — the same generator `src/core/rng.ts` uses, so
 * an audio render is reproducible for the same reason a simulation run is.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mono noise with a built-in exponential decay — the exciter that strikes a surface. */
export function noiseBurst(
  ctx: BaseAudioContext,
  seconds: number,
  tau: number,
  seed: number,
): AudioBuffer {
  const n = Math.max(2, Math.floor(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) data[i] = (rnd() * 2 - 1) * Math.exp(-i / (tau * ctx.sampleRate));
  return buffer;
}

interface Mode {
  /** Mode frequency, Hz. */
  readonly f: number;
  /** Time to decay 60 dB, seconds. This is the number the ring tail measures. */
  readonly t60: number;
  /** Relative gain. */
  readonly g: number;
}

export interface MaterialVoice {
  readonly modes: readonly Mode[];
  /** Cutoff of the lowpass the exciter passes through, Hz — how hard the strike is. */
  readonly exciterLp: number;
  /** Exciter decay constant, seconds. */
  readonly exciterTau: number;
  /** Level of the pitch-dropping thump — the mass arriving, as opposed to the surface answering. */
  readonly thump: number;
  /** §3.9's loudness multiplier: metal ×1.5 · stone ×1.15 · concrete ×1.0 · dust ×0.6. */
  readonly loud: number;
  /** How much of the raw exciter is heard directly — scuff rather than ring. */
  readonly scuff: number;
}

export type MaterialName = 'concrete' | 'metal' | 'stone' | 'dust';

/** The four materials in §3.9 order of loudness: dust · concrete · stone · metal. */
export const MATERIAL_NAMES: readonly MaterialName[] = ['dust', 'concrete', 'stone', 'metal'];

/**
 * Modal signatures, copied from the M1 prototype.
 *
 * The design content is in `t60`, not in `f`: metal's modes hang on for 0.15–0.38 s where
 * concrete's are gone in 0.04–0.09 s. That difference is the whole reason the ring tail — not
 * the spectral centroid — turns out to be the metric that tells materials apart.
 */
export const MATERIAL_VOICES: Readonly<Record<MaterialName, MaterialVoice>> = Object.freeze({
  concrete: {
    modes: [
      { f: 170, t60: 0.09, g: 1.0 },
      { f: 410, t60: 0.07, g: 0.6 },
      { f: 880, t60: 0.055, g: 0.35 },
      { f: 1500, t60: 0.04, g: 0.18 },
    ],
    exciterLp: 3200, exciterTau: 0.006, thump: 0.9, loud: 1.0, scuff: 0.25,
  },
  metal: {
    modes: [
      { f: 340, t60: 0.30, g: 1.1 },
      { f: 845, t60: 0.38, g: 1.7 },
      { f: 1980, t60: 0.30, g: 1.4 },
      { f: 3350, t60: 0.22, g: 1.0 },
      { f: 5170, t60: 0.15, g: 0.55 },
    ],
    exciterLp: 8000, exciterTau: 0.004, thump: 0.55, loud: 1.5, scuff: 0.25,
  },
  stone: {
    modes: [
      { f: 255, t60: 0.13, g: 0.9 },
      { f: 610, t60: 0.14, g: 1.0 },
      { f: 1160, t60: 0.10, g: 0.4 },
      { f: 2320, t60: 0.07, g: 0.2 },
    ],
    exciterLp: 5000, exciterTau: 0.005, thump: 0.7, loud: 1.15, scuff: 0.25,
  },
  dust: {
    modes: [{ f: 130, t60: 0.05, g: 0.5 }],
    // Nearly all scuff and almost no ring: dust is the quiet class §3.9 asks for, and it is
    // quiet by having nothing to resonate rather than by being turned down.
    exciterLp: 1100, exciterTau: 0.012, thump: 0.35, loud: 0.6, scuff: 0.9,
  },
});

/** Bandpass Q that gives a mode the stated T60. (Q ≈ π·f·t60 / ln(1000), and ln(1000) ≈ 6.9.) */
const qOf = (f: number, t60: number): number => Math.max(0.7, 0.4545 * f * t60);

export interface ContactOptions {
  /** When the strike happens, seconds into the render. */
  t: number;
  mat: MaterialName;
  gain: number;
  /** Seeds the exciter noise. Two strikes with the same seed are the same strike. */
  seed: number;
  thumpF0?: number;
  thumpDrop?: number;
  /** Scales the exciter cutoff — a harder, faster contact is brighter. */
  bright?: number;
}

/**
 * One contact: a seeded noise exciter through a parallel modal bank, plus a pitch-dropping
 * thump. Footsteps scale it by tier; landings scale it by impact speed.
 */
export function contact(ctx: BaseAudioContext, out: AudioNode, options: ContactOptions): void {
  const { t, mat, gain, seed, thumpF0 = 120, thumpDrop = 0.06, bright = 1 } = options;
  const voice = MATERIAL_VOICES[mat];

  const sum = ctx.createGain();
  sum.gain.value = gain * voice.loud;
  sum.connect(out);

  const exciter = ctx.createBufferSource();
  exciter.buffer = noiseBurst(ctx, 0.05, voice.exciterTau, seed);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = voice.exciterLp * bright;
  lp.Q.value = 0.5;
  exciter.connect(lp);

  const scuff = ctx.createGain();
  scuff.gain.value = voice.scuff;
  lp.connect(scuff);
  scuff.connect(sum);

  for (const mode of voice.modes) {
    const q = qOf(mode.f, mode.t60);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = mode.f;
    bp.Q.value = q;
    // A unit-peak bandpass fed by noise passes RMS ~ sqrt(f/Q), so a narrow long-ringing mode
    // arrives starved. Equalise by sqrt(Q/f) or metal's defining modes are inaudible at the gain
    // the table says they have — and the ring tail, which is the whole material signal, vanishes.
    const eq = Math.min(14, Math.sqrt(q / mode.f) * 34);
    const g = ctx.createGain();
    g.gain.value = mode.g * 2.2 * eq;
    lp.connect(bp);
    bp.connect(g);
    g.connect(sum);
  }

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(thumpF0, t);
  osc.frequency.exponentialRampToValueAtTime(thumpF0 * 0.35, t + thumpDrop);
  const thump = ctx.createGain();
  thump.gain.setValueAtTime(voice.thump * 0.8, t);
  // Ramp to 1e-4 rather than 0: an exponential ramp to zero is undefined and produces NaN, which
  // is precisely why `hasNaN` runs before every other assertion in the audio tests.
  thump.gain.exponentialRampToValueAtTime(0.0001, t + thumpDrop * 2.5);
  osc.connect(thump);
  thump.connect(sum);

  exciter.start(t);
  osc.start(t);
  osc.stop(t + thumpDrop * 3);
}

/**
 * Audible radius (m) → Halo hum pitch (Hz): 1.5 m reads 55 Hz, 24 m reads 220 Hz — two octaves
 * across the whole loudness range, on a square-root (i.e. half-log) map so the quiet end, where
 * the player is making decisions about being heard, gets the resolution.
 *
 * §3.8 is emphatic that the player must always know how loud they are; pitch is the readout, so
 * this function is the readout's calibration and `estimateF0` is how a test checks it.
 */
export const humPitch = (radiusM: number): number =>
  55 * Math.sqrt(Math.max(1.5, Math.min(24, radiusM)) / 1.5);

export interface HumPoint {
  t: number;
  /** Audible radius at that moment, metres. */
  r: number;
}

/**
 * The Halo hum: three oscillators (fundamental, a 0.7 % detune for body, a quiet 2.5× partial)
 * lowpassed, following a piecewise radius automation.
 *
 * Level stays near-constant on purpose — *pitch* is the readout, not loudness, so a player can
 * hear their own radius over their own footsteps.
 */
export function haloHum(
  ctx: BaseAudioContext,
  out: AudioNode,
  points: readonly HumPoint[],
  level: number,
  until: number,
): void {
  if (points.length === 0) throw new Error('haloHum: needs at least one point');
  const first = points[0]!;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 520;
  lp.Q.value = 0.6;
  const master = ctx.createGain();
  master.gain.value = level;
  lp.connect(master);
  master.connect(out);

  for (const [ratio, gain] of [[1, 1], [1.007, 0.8], [2.5, 0.12]] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(humPitch(first.r) * ratio, first.t);
    for (let i = 1; i < points.length; i++) {
      const point = points[i]!;
      osc.frequency.exponentialRampToValueAtTime(humPitch(point.r) * ratio, point.t);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    osc.connect(g);
    g.connect(lp);
    osc.start(first.t);
    osc.stop(until);
  }
}
