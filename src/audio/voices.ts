/**
 * The voices — the only code in the game that builds an audio graph.
 *
 * Every function here takes a `BaseAudioContext` rather than an `AudioContext`, which is what
 * makes the shipped synthesis testable at all: `OfflineAudioContext` is the same base class, so
 * `tests/audio/*` renders *this* code faster than real time with no browser, no device and no
 * clock, and a number pinned there is a number the game produces. A voice that reached for
 * `ctx.destination`, or for anything only a live context has, would quietly become untestable —
 * so they take their destination as an argument and connect to that.
 *
 * Nothing here decides *whether* or *how loud*. That is `director.ts`, and the separation is
 * load-bearing: `spec.gain` arrives already carrying §3.3's distance law and §3.9's material
 * multiplier, and a voice that applied a level of its own would be the second loudness knob the
 * vision doc spent a commit ruling out.
 *
 * **What a voice may and may not vary between materials.** §3.9's law is that the multiplier is
 * the *only* thing that makes one material louder than another, so every material voice below is
 * normalized on its attack — `attackNorm`, measured — to the same level at unit gain. What is
 * left to carry identity is timbre and decay, which is the right split: metal's 0.3 s ring is
 * metal's whole signature, and equalizing total energy instead would have made metal's strike
 * quieter to pay for its ring.
 */

import { makeRng } from '../core/rng';
import { MAT_CONCRETE, MATERIAL_NAMES } from '../paint/materials';
import type { VoiceSpec } from './director';

/**
 * The window a voice's attack is normalized over, seconds after the strike (§3.9: "the first
 * ~85 ms, the part that answers 'how loud was that'").
 *
 * Exported because the assertion that enforces the law measures exactly this window, and a test
 * that chose its own would be checking a different claim than the one the code implements.
 *
 * **Nothing under `src/` reads it, and that is the hazard rather than an oversight.** The four
 * `attackNorm` values below were *fitted* against this window, so what it names is the definition
 * §3.9's invariant is stated over — not a parameter the synthesis obeys. Move it and no graph
 * changes; what changes is the judgement. Widen it and metal, whose modes are still ringing at
 * 0.15 s where concrete's longest is gone by 0.09, keeps adding energy to a measurement concrete
 * has stopped contributing to, and the measured residuals walk without a single voice having
 * moved. That is a working way to make a failing fit go green, and it is one-sided: narrowing
 * this to 0.02 fails five assertions, widening it to 0.15 — or to 0.35, longer than metal's whole
 * 0.38 s ring — used to fail none.
 *
 * So it is bounded from the side that judges by it. `tests/audio/materialVoices.test.ts` pins how
 * far it may travel, against `ATTACK_WINDOW_BOUNDS`, whose ceiling is the ring-tail window that
 * §3.9's "timbre and decay are untouched" reserves. It stays here, next to the numbers it
 * explains, because a window owned by the test suite would leave this file normalizing against a
 * definition it does not hold.
 */
export const ATTACK_WINDOW_SEC = 0.085;

/** One resonant mode of a material. */
interface Mode {
  /** Mode frequency, Hz. */
  readonly f: number;
  /** Time to decay 60 dB, seconds — what the ring tail measures. */
  readonly t60: number;
  /** Relative gain within the bank. */
  readonly g: number;
}

interface MaterialVoice {
  readonly modes: readonly Mode[];
  /** Cutoff of the lowpass the exciter passes through, Hz — how hard the strike is. */
  readonly exciterLp: number;
  /** Exciter decay, seconds. */
  readonly exciterTau: number;
  /** Level of the pitch-dropping thump — the mass arriving, not the surface answering. */
  readonly thump: number;
  /** How much raw exciter is heard directly — scuff rather than ring. */
  readonly scuff: number;
  /**
   * Attack normalization (§3.9). Measured, not designed: it is whatever makes this material's
   * RMS over `ATTACK_WINDOW_SEC` equal every other material's at unit gain, so that the §3.9
   * multiplier — which reaches the voice through `spec.gain` — is the sole level difference
   * between them. `tests/audio/materialVoices.test.ts` fails if any of these drifts.
   *
   * **Fitted against a sample of strikes, never against one render.** The exciter reads a slice
   * of the noise bank, and one strike's attack sits 2–6 dB from its own mean depending which
   * slice it got — so a norm fitted to a single seed is fitted to that seed's noise. These three
   * are power means over sixteen strikes spread across `NOISE_SLOTS`; the numbers each moved
   * 4–5 % when that replaced the single-render fit they were first derived from. The test now
   * measures over a larger sample than the fit used (`ATTACK_LEVEL_SAMPLE.strikes`, and see its
   * comment for why), and these three values survived that: refitting is not what closed the
   * gap, and none of them has needed to move. Concrete is 1 by definition — it is the reference.
   */
  readonly attackNorm: number;
}

/**
 * The four material voices of §3.9.
 *
 * The design content is in `t60`, not in `f`. Metal's modes hang on for 0.15–0.38 s where
 * concrete's are gone in 0.04–0.09 s, and that is why the *ring tail* — not the spectral
 * centroid — is the metric that tells materials apart: brightness turns out to be a "scuff
 * versus ring" axis that puts dust above stone, which is no use as a hardness reading.
 *
 * Dust is nearly all scuff and one short mode. It is the quiet class §3.9 asks for, but it is
 * quiet by having nothing to resonate — its *level* comes from the ×0.6 multiplier like
 * everyone else's, which is the correction the loudness law made.
 */
const MATERIAL_VOICES: readonly MaterialVoice[] = Object.freeze([
  // concrete
  Object.freeze({
    modes: Object.freeze([
      { f: 170, t60: 0.09, g: 1.0 },
      { f: 410, t60: 0.07, g: 0.6 },
      { f: 880, t60: 0.055, g: 0.35 },
      { f: 1500, t60: 0.04, g: 0.18 },
    ]),
    exciterLp: 3200,
    exciterTau: 0.006,
    thump: 0.9,
    scuff: 0.25,
    attackNorm: 1,
  }),
  // metal
  Object.freeze({
    modes: Object.freeze([
      { f: 340, t60: 0.3, g: 1.1 },
      { f: 845, t60: 0.38, g: 1.7 },
      { f: 1980, t60: 0.3, g: 1.4 },
      { f: 3350, t60: 0.22, g: 1.0 },
      { f: 5170, t60: 0.15, g: 0.55 },
    ]),
    exciterLp: 8000,
    exciterTau: 0.004,
    thump: 0.55,
    scuff: 0.25,
    attackNorm: 1.104115,
  }),
  // stone
  Object.freeze({
    modes: Object.freeze([
      { f: 255, t60: 0.13, g: 0.9 },
      { f: 610, t60: 0.14, g: 1.0 },
      { f: 1160, t60: 0.1, g: 0.4 },
      { f: 2320, t60: 0.07, g: 0.2 },
    ]),
    exciterLp: 5000,
    exciterTau: 0.005,
    thump: 0.7,
    scuff: 0.25,
    attackNorm: 1.203781,
  }),
  // dust
  Object.freeze({
    modes: Object.freeze([{ f: 130, t60: 0.05, g: 0.5 }]),
    exciterLp: 1100,
    exciterTau: 0.012,
    thump: 0.35,
    scuff: 0.9,
    attackNorm: 2.087194,
  }),
]);

/** Bandpass Q that gives a mode the stated T60. (Q ≈ π·f·t60 / ln(1000), ln(1000) ≈ 6.9.) */
const qOf = (f: number, t60: number): number => Math.max(0.7, 0.4545 * f * t60);

/**
 * Seconds of seeded white noise every exciter is cut from.
 *
 * One buffer per context rather than one per contact. A footstep allocating and filling a fresh
 * `AudioBuffer` is a few thousand samples of work on the frame that has to stay smooth (law 5:
 * movement never pays for information), and at a sprint that is eight allocations a second for
 * noise that is statistically identical anyway. Instead each contact reads from a different
 * offset — `spec.seed`, i.e. the event's sequence number — so two strikes still differ and the
 * same event is still the same noise.
 */
const NOISE_SECONDS = 2;

/**
 * How many distinct start offsets the bank is divided into.
 *
 * **Prime, and the primality is the whole of the choice.** `noiseOffset` reads slot
 * `seed % NOISE_SLOTS`, and the seed is the bus's sequence number — so any *subsequence* of
 * events taken at a fixed stride walks the bank at that stride, and subsequences at a fixed
 * stride are what a gait is: one foot of two, a landing every fourth stride, one player of four
 * sharing a bus. A stride `s` visits `NOISE_SLOTS / gcd(s, NOISE_SLOTS)` slots before it repeats,
 * which is the whole bank for *every* stride exactly when this number is prime.
 *
 * A round number is the worst available and looks harmless. At 512, half the strides below it
 * fold onto a short orbit and a stride of 8 hears the same 64 slices for the rest of the run —
 * which is the machine-gun sprint the noise bank exists to prevent, arriving through a door
 * nobody was watching. `tests/audio/voices.test.ts` asserts the primality rather than trusting
 * this sentence, and asserts the orbit property it buys alongside it, because the second is what
 * the game actually depends on.
 *
 * Exported because the level law of §3.9 is a claim about the *expected* loudness of a contact,
 * and one render cannot measure an expectation: a single strike's attack level varies by 2–6 dB
 * depending on which slice of the bank it read. A test that enforces the law has to average over
 * slots spread across the whole bank, and a test that invented its own slot count would be
 * sampling a distribution the code does not have.
 */
export const NOISE_SLOTS = 997;

/**
 * The seed the noise bank is filled with — fixed, and not part of the run's seed policy.
 *
 * `core/rng.ts` owns the simulation's nondeterminism budget and this is deliberately outside it:
 * the noise here is *timbre*, not gameplay, and a run's seed changing what a footstep sounds
 * like would mean every pinned spectral number in `tests/audio/` held for one seed only.
 */
const NOISE_SEED = 0x9e3779b9;

const noiseBanks = new WeakMap<BaseAudioContext, AudioBuffer>();

/** The context's seeded noise bank, built once on first use. */
function noiseBank(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseBanks.get(ctx);
  if (cached !== undefined) return cached;
  const n = Math.max(2, Math.floor(NOISE_SECONDS * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rnd = makeRng(NOISE_SEED);
  for (let i = 0; i < n; i++) data[i] = rnd() * 2 - 1;
  noiseBanks.set(ctx, buffer);
  return buffer;
}

/** Where in the bank a given seed reads from, seconds. */
function noiseOffset(seed: number, needSeconds: number): number {
  const usable = Math.max(0, NOISE_SECONDS - needSeconds);
  return ((Math.abs(Math.trunc(seed)) % NOISE_SLOTS) / NOISE_SLOTS) * usable;
}

/**
 * An exponential fall to silence.
 *
 * Ramps to 1e-4 rather than to 0 because `exponentialRampToValueAtTime(0, …)` is undefined and
 * renders NaN — which is exactly why `hasNaN` runs before every other assertion in the audio
 * tests, and why it is written once here instead of at each of the six places that need it.
 */
function fallTo(param: AudioParam, from: number, at: number, seconds: number): void {
  param.setValueAtTime(Math.max(1e-4, from), at);
  param.exponentialRampToValueAtTime(1e-4, at + seconds);
}

/**
 * One contact: a seeded noise exciter through a parallel modal bank, plus a pitch-dropping thump.
 *
 * The whole of §3.9's audible half is here. `spec.mat` picks the modes and the exciter; `spec.
 * bright` scales the exciter's cutoff, so a sprint is a harder strike on the same surface than a
 * crouch; `spec.toneHz` is the thump, which is weight. Level is `spec.gain` times the material's
 * attack normalization and nothing else.
 */
export function contactVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  spec: VoiceSpec,
  when: number,
): void {
  const voice = MATERIAL_VOICES[spec.mat ?? MAT_CONCRETE] ?? MATERIAL_VOICES[MAT_CONCRETE]!;
  const stop = when + spec.durationSec;

  const sum = ctx.createGain();
  sum.gain.value = spec.gain * voice.attackNorm;
  sum.connect(out);

  // The exciter: a slice of the bank, shaped by its own fall, then lowpassed by how hard the
  // contact was. Everything downstream is fed from `lp`, so the strike is one event heard four
  // ways rather than four sounds that have to be kept in sync.
  const exciter = ctx.createBufferSource();
  exciter.buffer = noiseBank(ctx);
  const env = ctx.createGain();
  fallTo(env.gain, 1, when, voice.exciterTau * 6);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = voice.exciterLp * spec.bright;
  lp.Q.value = 0.5;
  exciter.connect(env);
  env.connect(lp);

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
    /*
     * A unit-peak bandpass fed by noise passes RMS ~ sqrt(f/Q), so a narrow long-ringing mode
     * arrives starved. Equalise by sqrt(Q/f) or metal's defining modes are inaudible at the gain
     * the table says they have — and the ring tail, which is the entire material signal, vanishes
     * with them.
     */
    const eq = Math.min(14, Math.sqrt(q / mode.f) * 34);
    const g = ctx.createGain();
    g.gain.value = mode.g * 2.2 * eq;
    lp.connect(bp);
    bp.connect(g);
    g.connect(sum);
  }

  // The thump: the mass arriving, as opposed to the surface answering. Drops in pitch, because
  // that is what a heavy thing landing does and what tells a landing from a footfall.
  const drop = 0.06;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(spec.toneHz, when);
  osc.frequency.exponentialRampToValueAtTime(spec.toneHz * 0.35, when + drop);
  const thump = ctx.createGain();
  fallTo(thump.gain, voice.thump * 0.8, when, drop * 2.5);
  osc.connect(thump);
  thump.connect(sum);

  exciter.start(when, noiseOffset(spec.seed, spec.durationSec));
  exciter.stop(stop);
  osc.start(when);
  osc.stop(Math.min(stop, when + drop * 3));
}

/**
 * A ping — the two deliberate acts of §3.5, and the only sounds the player chooses to make.
 *
 * §3.5 says Q and E differ in *shape*, not reach: Q is the 360° room-read and the panic button,
 * E is the 110° look-around. A difference the player cannot hear is not a difference, so the
 * shape is what this reads — `spec.coneAngleDeg` — and it is what the two voices are built from:
 *
 *  - **Q, omnidirectional**, sweeps *down* and is lowpassed hard. It is a pulse released in every
 *    direction, and it sounds like a released balloon: round, dark, spreading.
 *  - **E, a cone**, sweeps *up* through a bright resonance. It is a question thrown forwards, and
 *    it sounds like one.
 *
 * That makes the two separable on brightness by a wide margin, which is the axis
 * `tests/audio/voices.test.ts` measures. It is also the sound of the price: the E-ping is the
 * loud one, heard at both ends of its beam (§3.3).
 */
export function pingVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  spec: VoiceSpec,
  when: number,
): void {
  const beam = spec.coneAngleDeg < 360;
  const stop = when + spec.durationSec;

  const sum = ctx.createGain();
  sum.gain.value = spec.gain;
  sum.connect(out);

  const shape = ctx.createBiquadFilter();
  shape.type = beam ? 'bandpass' : 'lowpass';
  shape.frequency.value = beam ? spec.toneHz * 2.4 : spec.toneHz * 2.6;
  shape.Q.value = beam ? 1.1 : 0.7;
  shape.connect(sum);

  // The sweep. Up and short for the beam, down and long for the room-read — one line apart, and
  // it is the whole difference in character.
  const sweepSeconds = beam ? 0.18 : 0.4;
  const endRatio = beam ? 2.4 : 0.5;
  for (const [ratio, gain] of beam
    ? ([[1, 1], [1.5, 0.5], [2.02, 0.28]] as const)
    : ([[1, 1], [0.5, 0.55], [1.49, 0.18]] as const)) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(spec.toneHz * ratio, when);
    osc.frequency.exponentialRampToValueAtTime(spec.toneHz * ratio * endRatio, when + sweepSeconds);
    const g = ctx.createGain();
    // A short rise rather than an instant one: a sonar pulse that starts at full amplitude on
    // one sample clicks, and a click is broadband — it would blur the brightness reading the two
    // pings are told apart by.
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-4, gain), when + 0.008);
    g.gain.exponentialRampToValueAtTime(1e-4, when + sweepSeconds * (beam ? 2.2 : 1.6));
    osc.connect(g);
    g.connect(shape);
    osc.start(when);
    osc.stop(stop);
  }

  // A breath of noise under the tone — the air the pulse moves. Bright and brief for the beam,
  // dull and longer for the omni, so the noise agrees with the tone about which one this is.
  const air = ctx.createBufferSource();
  air.buffer = noiseBank(ctx);
  const airBp = ctx.createBiquadFilter();
  airBp.type = 'bandpass';
  airBp.frequency.value = beam ? spec.toneHz * 3.2 : spec.toneHz * 1.2;
  airBp.Q.value = beam ? 2.2 : 1.4;
  const airGain = ctx.createGain();
  fallTo(airGain.gain, beam ? 0.5 : 0.32, when, beam ? 0.12 : 0.3);
  air.connect(airBp);
  airBp.connect(airGain);
  airGain.connect(shape);
  air.start(when, noiseOffset(spec.seed, spec.durationSec));
  air.stop(stop);
}

/** Builds whichever voice the spec names, at `when` on the context's clock. */
export function playVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  spec: VoiceSpec,
  when: number,
): void {
  if (spec.voice === 'contact') contactVoice(ctx, out, spec, when);
  else pingVoice(ctx, out, spec, when);
}

/**
 * The measured attack normalizations, exposed so the test that enforces §3.9 can name them.
 *
 * Read-only and index-aligned with `paint/materials`, so a material added to that table without
 * a voice here fails the length check rather than silently sounding like concrete.
 */
export const MATERIAL_ATTACK_NORMS: readonly number[] = Object.freeze(
  MATERIAL_VOICES.map((v) => v.attackNorm),
);

if (MATERIAL_ATTACK_NORMS.length !== MATERIAL_NAMES.length) {
  throw new Error(
    `audio/voices: ${MATERIAL_NAMES.length} materials but ${MATERIAL_ATTACK_NORMS.length} voices.`,
  );
}
