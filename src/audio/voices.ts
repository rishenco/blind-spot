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

/**
 * The `bright` the twelve off-diagonal norms below were fitted at.
 *
 * Exported so the class that carries a composed contact has to *name* this number, and so a
 * retune of that class's brightness fails an assertion instead of walking the fit. The norms are
 * hostage to it for the same reason `ATTACK_WINDOW_SEC` is hostage to the window: the exciter's
 * cutoff is `exciterLp × spec.bright`, and moving a cutoff moves how much of the strike lands
 * inside the attack window. The leak is small — every class's level tracks its own gain to
 * within 0.21 dB across the shipped 0.55–1.6 range of `bright` — but "small" is measured against
 * §3.9's half-decibel budget, and the whole of that budget is already spent elsewhere.
 *
 * 1.45 is the impact's shape: a thrown thing strikes harder than a walk (1.0) and not as hard as
 * a body landing (1.6).
 */
export const COMPOSED_NORM_FIT_BRIGHT = 1.45;

/**
 * The twelve *fitted* cells of the composed attack normalization — [object][surface], with the
 * diagonal deliberately absent.
 *
 * `null` on the diagonal is not a placeholder to be filled in later. It is the point: a
 * composed contact where the two bodies are the same material **is** a single-material contact,
 * and its norm has to be the same float a footfall on that surface uses or the two disagree
 * about how loud the same material is. So the diagonal is not written here at all —
 * `COMPOSED_ATTACK_NORMS` takes it from `MATERIAL_VOICES[i].attackNorm` — and the module-load
 * check at the bottom of this file refuses a table that tries to write one.
 *
 * **Why twelve numbers and not two.** The tempting shape is `normObj × normSurf`: four fitted
 * values, composed. It fails, and it fails for a reason that is visible in the graph rather than
 * in the fit. The modal bank is *fed by* the exciter (`lp.connect(bp)`), so the level inside the
 * attack window is a function of both rows at once and not a product of two independent ones.
 * Measured against this table, the separable model is close on the object rows that mostly drive
 * modes — metal's cells sit within 0.63 dB of it and stone's within 0.32 — and hopeless on dust,
 * which misses by 2.07 dB on metal and 3.09 dB on dust: dust is nearly all scuff, and how much of
 * that scuff survives the window depends entirely on what it is driving. Three decibels is six
 * times §3.9's whole budget, and `tests/audio/composedVoice.test.ts` asserts it rather than
 * leaving it as a sentence here.
 *
 * Sixteen *numbers* is not sixteen voices: the audio content is still four excitations and four
 * resonator banks, and every one of them is the shipped one.
 *
 * Fitted the way the shipped four were, and by the same estimator the test uses to check them:
 * 192 strikes stratified across `NOISE_SLOTS`, power-meaned over `ATTACK_WINDOW_SEC`, at
 * `COMPOSED_NORM_FIT_BRIGHT`. That makes the pair invariant a regression pin at birth rather
 * than an independent measurement — the same honest circularity the four `attackNorm`s carry,
 * and worth stating because the independent content lives elsewhere: the radii are exact
 * arithmetic on the bus, and level-tracks-carry is structural through `gainFor`.
 */
const COMPOSED_OFF_DIAGONAL_NORMS: readonly (readonly (number | null)[])[] = Object.freeze([
  //                            surface: concrete    metal     stone     dust
  /* object concrete */ Object.freeze([null, 0.787030, 0.980666, 1.071759]),
  /* object metal    */ Object.freeze([1.508906, null, 1.468010, 1.677572]),
  /* object stone    */ Object.freeze([1.234623, 0.936895, null, 1.348517]),
  /* object dust     */ Object.freeze([1.365230, 0.847094, 1.271354, null]),
]);

/**
 * The attack normalization of a contact between two bodies, `[object][surface]`.
 *
 * **The diagonal is the shipped four, by reference — not copied literals.** That is the whole
 * reason this table is built rather than written. A copied diagonal is a second place the
 * footfall's level lives, and the day a refit moved one of them the game's every step would get
 * quietly louder while `MATERIAL_ATTACK_NORMS` — the thing the loudness law is asserted against
 * — still read the old number. Taking the same float makes that drift unavailable: there is one
 * `attackNorm` per material and this table points at it.
 *
 * The price of the choice, measured rather than assumed: the diagonal was fitted at the walk
 * shape and this table's off-diagonals at `COMPOSED_NORM_FIT_BRIGHT`, so on the diagonal the
 * familiar `bright` leak is left in. A composed contact between two bodies of one material lands
 * metal −0.097 dB, stone −0.016 and dust +0.262 from the reference pair, where the twelve fitted
 * cells land at 0.000. All three are inside §3.9's 0.5 dB tolerance, and buying them back would
 * mean refitting the numbers every footstep in the game is levelled by, to save at most a quarter
 * of a decibel on a sound nothing emits yet. Not worth it; recorded here so nobody has to
 * re-derive that it was considered.
 */
export const COMPOSED_ATTACK_NORMS: readonly (readonly number[])[] = Object.freeze(
  MATERIAL_VOICES.map((row, obj) =>
    Object.freeze(
      MATERIAL_VOICES.map((_, surf) =>
        obj === surf ? row.attackNorm : (COMPOSED_OFF_DIAGONAL_NORMS[obj]?.[surf] ?? NaN),
      ),
    ),
  ),
);

/**
 * Which row of `MATERIAL_VOICES` a material index names, concrete for one it does not.
 *
 * The fallback is `materialLoudness`'s, deliberately: an index off the end of the table answers
 * with the ordinary surface there too, so the two halves of "unknown material" agree instead of
 * one of them crashing mid-stride. It resolves to an *index* rather than to a row because the
 * composed norm is looked up by index, and a lookup that fell back differently from the row
 * selector would pair concrete's modes with some other material's level.
 */
function materialRow(mat: number | null): number {
  return mat !== null && MATERIAL_VOICES[mat] !== undefined ? mat : MAT_CONCRETE;
}

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
 * A rise to `peak` and then a fall to silence — `fallTo` with an onset in front of it.
 *
 * The rise is the whole reason this exists rather than being three more lines inside
 * `boomVoice`. A gain that starts at full amplitude on one sample is a step, and a step is a
 * click: broadband, instantaneous, and the single most weapon-like thing a synthesised
 * detonation can do. Every layer of the boom therefore opens over milliseconds rather than over
 * a sample, and `ONSET_SEC` is where the shortest of those is written down.
 */
function burst(param: AudioParam, peak: number, at: number, rise: number, fall: number): void {
  param.setValueAtTime(1e-4, at);
  param.exponentialRampToValueAtTime(Math.max(1e-4, peak), at + rise);
  param.exponentialRampToValueAtTime(1e-4, at + rise + fall);
}

/**
 * Where the detonation's front opens, Hz, before `spec.bright` scales it.
 *
 * Low for a bang, and that is the §14 argument made in one number. A shock front is identified
 * by what is *above* 2 kHz; at 1350 Hz — 900 times the boom's 1.5 — with two poles over it the
 * band that says "crack" is 20 dB down before the sound has begun, and measures at 0.01 % of the
 * attack's energy. Raise it far and the sphere stops being a charge that goes off and starts
 * being something that goes through a wall, which is a different game and a different design
 * document.
 */
const FRONT_HZ = 900;

/** How long the detonation's fastest layer takes to reach full amplitude. See `burst`. */
const ONSET_SEC = 0.004;

/**
 * Where the detonation's body stops, Hz — the floor under the whole sound.
 *
 * Below about 30 Hz a small speaker moves and nothing arrives, so this band is excursion without
 * information: it costs peak headroom, it drags the loudest event in the game towards clipping,
 * and no player hears the difference. Cutting it is the cheapest 2 dB of headroom in the file.
 */
const BODY_FLOOR_HZ = 30;

/**
 * The detonation's one level constant — measured, and a normalization rather than a volume.
 *
 * Same job as `MaterialVoice.attackNorm` and the same rule: it is fitted once so that the level
 * the player hears is `gainFor`'s and nothing else, and then it never varies with anything. What
 * it is fitted *to* is different, because the boom has no siblings to be levelled against — one
 * class, one voice, no material — so there is nothing for §3.9's invariant to equalise here.
 *
 * The obvious target was §3.3's carry column. It says the boom is the loudest deliberate act in
 * the game — 32 m against the E-ping's 30 and the Q-ping's 18 — and the Q-ping is the natural
 * reference, being the other 360° room-read, so fitting the boom's 85 ms attack onto Q's would
 * make the whole audible difference between the two their carry ratio and nothing else. Measured
 * over 192 stratified noise slots, that wanted 0.898.
 *
 * **It does not fit, and the reason is crest, not loudness.** A detonation is broadband noise
 * and peaks about 13.6 dB over its own attack RMS; a ping is a narrow tone and peaks about 10 dB
 * over its. Equalise their RMS and the boom's *peak* is 3.6 dB higher for free — and the boom
 * carries furthest, so `gainFor` also hands it the largest near-field gain in the game
 * (`EDGE_GAIN · 32 / NEAR_FIELD_M` = 0.427). At attack parity the loudest slot in the noise bank
 * renders at −0.7 dBFS through the master, which is past `MAX_PEAK_DBFS` before a single other
 * sound has been added to it.
 *
 * So the ceiling sets the constant, and 0.690461 is where the worst of the 997 noise slots peaks
 * at exactly −3 dBFS at `NEAR_FIELD_M` — `MAX_PEAK_DBFS` with 2 dB left over for whatever else
 * is landing in the same millisecond, which is precisely what that constant exists for. The
 * median slot lands at −7.3 dBFS, alongside the rest of the game's voices.
 *
 * What that costs is 2.3 dB of attack level, and §3.3 survives it: the boom's attack sits at
 * −7.77 dB against Q's −5.48, and once the carry radii are applied it still *arrives* 2.7 dB
 * over the Q-ping and 4.9 dB over the E-ping at the same distance — and goes on arriving for a
 * second, where a ping is over in a fifth of one. Peak is headroom; loudness is energy over
 * time; the boom is the loudest act in the game on the second of those and does not need to win
 * the first. `tests/audio/boomVoice.test.ts` asserts the ordering and the ceiling together;
 * `DETONATION` in `tests/support/audioSpec.ts` holds the measured margins.
 */
const BOOM_ATTACK_NORM = 0.690461;

/**
 * One contact: a seeded noise exciter through a parallel modal bank, plus a pitch-dropping thump.
 *
 * The whole of §3.9's audible half is here. `spec.bright` scales the exciter's cutoff, so a
 * sprint is a harder strike on the same surface than a crouch; `spec.toneHz` is the thump, which
 * is weight. Level is `spec.gain` times the attack normalization and nothing else.
 *
 * **A contact is two bodies, and the graph already knew it.** The four subgraphs below split
 * cleanly along that line and always have: the exciter, the scuff and the thump are the *strike*
 * — the arriving body's hardness, texture and mass — and the modal bank is the *surface
 * answering*. So the two rows are selected separately. `spec.mat` is what was struck and picks
 * the modes; `spec.objMat` is what struck it and picks the exciter, the scuff and the thump. The
 * bank is fed by the exciter, which is physical and intended — a can dropped on steel drives the
 * steel — and it is also why the level of the pair cannot be factorized (see
 * `COMPOSED_ATTACK_NORMS`).
 *
 * What that buys, measured: 150–300 ms after the strike, concrete thrown at steel is still
 * ringing ~33 dB above steel thrown at concrete. Swap the two selectors and the two numbers swap
 * with them, so the difference does not shrink — it changes sign. The ring belongs to the floor,
 * and the strike belongs to the can; `tests/audio/composedVoice.test.ts` is where both halves of
 * that sentence are held.
 *
 * **`objMat === null` is the single-material voice, bit for bit.** Both selectors then resolve to
 * the same row and the norm branch takes `attackNorm` — which is the same float
 * `COMPOSED_ATTACK_NORMS` holds on its diagonal, by reference. Every footfall, landing and step
 * the game emits today takes that path and renders exactly the samples it rendered before the
 * seam existed. The branch is kept rather than folded into the table lookup precisely so that
 * equality is a thing a test can assert instead of a thing that is true by having nowhere to
 * differ.
 */
export function contactVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  spec: VoiceSpec,
  when: number,
): void {
  const surf = materialRow(spec.mat);
  const obj = spec.objMat === null ? surf : materialRow(spec.objMat);
  /** The struck surface: what answers. */
  const resonance = MATERIAL_VOICES[surf]!;
  /** The arriving body: what strikes. The same row as `resonance` for every single-body contact. */
  const excitation = MATERIAL_VOICES[obj]!;
  const stop = when + spec.durationSec;

  const sum = ctx.createGain();
  sum.gain.value =
    spec.gain * (spec.objMat === null ? resonance.attackNorm : COMPOSED_ATTACK_NORMS[obj]![surf]!);
  sum.connect(out);

  // The exciter: a slice of the bank, shaped by its own fall, then lowpassed by how hard the
  // contact was. Everything downstream is fed from `lp`, so the strike is one event heard four
  // ways rather than four sounds that have to be kept in sync.
  const exciter = ctx.createBufferSource();
  exciter.buffer = noiseBank(ctx);
  const env = ctx.createGain();
  fallTo(env.gain, 1, when, excitation.exciterTau * 6);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = excitation.exciterLp * spec.bright;
  lp.Q.value = 0.5;
  exciter.connect(env);
  env.connect(lp);

  const scuff = ctx.createGain();
  scuff.gain.value = excitation.scuff;
  lp.connect(scuff);
  scuff.connect(sum);

  for (const mode of resonance.modes) {
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
  fallTo(thump.gain, excitation.thump * 0.8, when, drop * 2.5);
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

/**
 * The detonation — a sphere going off, and the loudest deliberate act the game has (§3.3: 32 m
 * of carry, against the E-ping's 30 and under the landing's effective 42).
 *
 * **It is a sonic charge and not a bomb**, and §14 is not being polite about that: a thrown
 * sphere does no damage, cannot stagger, and hitting the spider with one is worth exactly what
 * hitting a wall with one is worth. The verb is "ask a question from somewhere you are not". So
 * the sound has to arrive as *pressure* — big, round, and over — rather than as violence, and
 * the three things that would make it a weapon are left out on purpose:
 *
 *  - **No crack.** A gunshot and a grenade are identified by their shock front: a step edge with
 *    most of its energy above 2 kHz. Everything here is lowpassed and every layer opens over
 *    milliseconds rather than over a sample (see `burst`). Measured against the voices already
 *    shipped, on the steepest sample-to-sample step each one makes relative to its own attack
 *    RMS: the boom 0.19, the Q-ping 0.17, the E-ping 0.61, a landing 0.68. It is the second
 *    smoothest thing in the game and a third as sharp as the sound of hitting the floor. And on
 *    the spectrum it puts 1.0e-5 of its attack energy above 2 kHz, against a landing's 2.4e-4
 *    and the E-ping's 1.8e-3 — an order of magnitude darker up there than the sound of hitting
 *    the floor. What is left is a thing that goes *off*, not a thing that goes *through*
 *    something.
 *  - **No debris.** No crackle, no secondary bursts, no rattle after the fact. Four envelopes,
 *    each one smooth and monotonic, because a device discharging is an ordered event and because
 *    the game has no destruction to make the noise *of* (§14). It is also what makes 05's "and
 *    nothing at all followed it" audible rather than merely true on the bus.
 *  - **No distortion.** Nothing here is clipped or waveshaped. The grit those add is the sound of
 *    something breaking, and nothing breaks.
 *
 * What is left is the shape §3.3 asks for, in three noise layers off one release — one
 * `BufferSource` feeding all of them, for `contactVoice`'s reason: three chains from one source
 * are one event heard three ways, where three sources are three sounds somebody has to keep in
 * sync — plus one oscillator under them.
 *
 *  - **The front** — the transient, and deliberately with no tone in it. Lowpassed noise, wide
 *    at the instant of release and dark 90 ms later, which is what the air actually does with a
 *    pressure step. It is the layer that tells you *when* and (once there is a panner) *where*,
 *    and it is worth 2.0 dB over the first 10 ms — audible as an edge on the front of the
 *    sound, nowhere near loud enough to be the sound.
 *  - **The body** — the weight, and the layer that makes the sound concussive. Noise under a
 *    lowpass sliding from `toneHz x 4.5` down to `toneHz x 1.3`, over a fixed highpass at
 *    `BODY_FLOOR_HZ`. **The low end is stochastic on purpose**, and it is what separates a
 *    detonation from a landing: `contactVoice`'s thump is a pure sine because a mass arriving has
 *    exactly one pitch, where expanding air has none.
 *  - **The core** — one sine sliding the same way the body does, and the body's equal partner
 *    rather than its master: measured alone, the two sit 1.3 dB apart in the attack window. It
 *    may not go much past that. A sine loud enough to lead is a kick drum, and a player files a
 *    kick drum under "something landed" — but it is also the only layer with no randomness in
 *    it, so it is where the level stability the section below is about actually comes from, and
 *    balance is the whole of the tuning.
 *  - **The tail** — the pressure dispersing, darkening as it goes because the high end leaves
 *    first, and the only layer still audible after 0.4 s: it is worth 15 dB across 300–800 ms
 *    and 11 dB across 800–1400 ms, where the other three are gone. Noise, not
 *    the sine: a detonation that ends on a tone ends on a note, and this one has to end on air.
 *    Not a reverb either: the game has no room model, and a convolved tail would claim the same
 *    enclosure for a boom in a bare frame and a boom in a sealed room, which is law 2 broken by
 *    an audio effect. This tail is the source's own, and it says "big" without claiming a wall.
 *
 * **Why the body is a shelf and not a resonance.** The first draft made it a bandpass at
 * `toneHz x 1.8`, which is the obvious way to write "low noise" and is wrong here for a reason
 * worth recording. A band that narrow at 90 Hz passes about a dozen cycles inside §3.9's 85 ms
 * attack window, so the window's RMS is a small-sample statistic. Measured across all 997 slots
 * of the noise bank, the *same event* came out with a standard deviation of 1.09 dB and a range
 * of 6.53 dB depending on nothing but which slot `spec.seed` picked. That is level being decided
 * by the noise offset instead of by `gainFor`, which is the one thing a voice in this file may
 * not do — a boom at 20 m could arrive louder than a boom at 10 m. Opening the body into a shelf
 * between `BODY_FLOOR_HZ` and the sweep, with the sine core steadying what is left, brings that
 * to 0.68 dB and 3.90 dB, against the 0.47–0.51 dB the shipped contact voices already live with.
 * It buys the peak as well: at equal attack level the shelf peaks 4.1 dB lower than the band
 * did, which is most of the headroom `BOOM_ATTACK_NORM` needed and could not otherwise have
 * found.
 *
 * Level is `spec.gain` times one normalization and nothing else, exactly as everywhere else in
 * this file — see `BOOM_ATTACK_NORM` for what that constant is and what it is not.
 */
export function boomVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  spec: VoiceSpec,
  when: number,
): void {
  const stop = when + spec.durationSec;

  const sum = ctx.createGain();
  sum.gain.value = spec.gain * BOOM_ATTACK_NORM;
  sum.connect(out);

  // One release of air, heard three ways — front, body, tail. The core is the fourth layer and
  // the only one that is not this noise.

  const air = ctx.createBufferSource();
  air.buffer = noiseBank(ctx);

  // The front. `spec.bright` scales where it opens, so the class table keeps the one knob that
  // says how hard a thing struck; the ramp down to `toneHz * 2.5` inside 70 ms is the part that
  // makes it a release of pressure rather than a burst of static. Two poles rather than one, for
  // the reason under `FRONT_HZ`: 6 dB/oct leaves an audible edge above the corner, and an edge
  // is the one thing this sound may not have.
  const frontGain = ctx.createGain();
  burst(frontGain.gain, 3, when, ONSET_SEC, 0.085);
  let frontIn: AudioNode = frontGain;
  for (let i = 0; i < 2; i++) {
    const front = ctx.createBiquadFilter();
    front.type = 'lowpass';
    front.Q.value = 0.7;
    front.frequency.setValueAtTime(FRONT_HZ * spec.bright, when);
    front.frequency.exponentialRampToValueAtTime(spec.toneHz * 2.5, when + 0.07);
    front.connect(frontIn);
    frontIn = front;
  }
  air.connect(frontIn);
  frontGain.connect(sum);

  // The body: a shelf, two poles at each end, sliding down over 0.3 s. Two poles and not one on
  // the lowpass because a 6 dB/oct skirt at 400 Hz still leaves 2 kHz within 20 dB, and 2 kHz is
  // where "crack" lives; two on the highpass because one leaves the sub-30 Hz excursion
  // `BODY_FLOOR_HZ` exists to remove. Its rise is 20 ms — slower than the front's on purpose, so
  // the two layers do not put their peaks in the same millisecond and cost headroom for it.
  const bodyGain = ctx.createGain();
  burst(bodyGain.gain, 6.5, when, 0.02, 0.8);
  let bodyIn: AudioNode = bodyGain;
  for (let i = 0; i < 2; i++) {
    const floor = ctx.createBiquadFilter();
    floor.type = 'highpass';
    floor.Q.value = 0.7;
    floor.frequency.value = BODY_FLOOR_HZ;
    floor.connect(bodyIn);
    bodyIn = floor;
  }
  for (let i = 0; i < 2; i++) {
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.Q.value = 0.7;
    body.frequency.setValueAtTime(spec.toneHz * 4.5, when);
    body.frequency.exponentialRampToValueAtTime(spec.toneHz * 1.3, when + 0.3);
    body.connect(bodyIn);
    bodyIn = body;
  }
  air.connect(bodyIn);
  bodyGain.connect(sum);

  // The core: one sine sliding the same way the body does, and slower and further than any
  // thump. `contactVoice` drops its thump to 0.35x in 60 ms, which reads as an arrival; this
  // takes 0.22 s to reach 0.4x, which reads as a volume of air letting go. 0.9 against the
  // body's 6.5 puts the two within 1.3 dB of each other in the attack window, which is as far
  // as the sine may go: it is the layer that steadies the level, and it is also the layer that
  // would turn the sound into a kick drum if it led.
  const core = ctx.createOscillator();
  core.type = 'sine';
  core.frequency.setValueAtTime(spec.toneHz, when);
  core.frequency.exponentialRampToValueAtTime(spec.toneHz * 0.4, when + 0.22);
  const coreGain = ctx.createGain();
  burst(coreGain.gain, 0.9, when, 0.006, 0.7);
  core.connect(coreGain);
  coreGain.connect(sum);

  // The tail. It comes up *well* after the front — 80 ms, long enough to hear as a bloom rather
  // than as part of the strike, and short enough that it is one sound with what preceded it —
  // and it leaves over most of a second, darkening the whole way. The delay is doing two jobs:
  // it is what makes this the tail rather than a fourth way of saying "attack", and it keeps the
  // loudest layer's peak out of the same millisecond as the body's, which measured 0.4 dB of
  // headroom on its own.
  const tail = ctx.createBiquadFilter();
  tail.type = 'lowpass';
  tail.Q.value = 0.7;
  tail.frequency.setValueAtTime(spec.toneHz * 3.5, when);
  tail.frequency.exponentialRampToValueAtTime(spec.toneHz * 1.5, when + 0.7);
  const tailGain = ctx.createGain();
  burst(tailGain.gain, 5, when, 0.08, spec.durationSec - 0.1);
  air.connect(tail);
  tail.connect(tailGain);
  tailGain.connect(sum);

  air.start(when, noiseOffset(spec.seed, spec.durationSec));
  air.stop(stop);
  core.start(when);
  core.stop(stop);
}

/** Builds whichever voice the spec names, at `when` on the context's clock. */
export function playVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  spec: VoiceSpec,
  when: number,
): void {
  if (spec.voice === 'contact') contactVoice(ctx, out, spec, when);
  else if (spec.voice === 'boom') boomVoice(ctx, out, spec, when);
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

/**
 * The composed table is square, complete, and has no diagonal of its own — checked at module load.
 *
 * Three failures, all of which would otherwise reach a gain node as a number rather than as an
 * error. A missing cell arrives as `NaN`, and one non-finite sample poisons every summing node
 * downstream — the exact failure `hasNaN` exists to catch, except here it would be catchable only
 * after somebody had rendered it. A diagonal literal is worse than wrong: `COMPOSED_ATTACK_NORMS`
 * ignores it and takes `attackNorm` instead, so the number would sit in the file looking
 * authoritative and meaning nothing. And a row of the wrong length is what adding a fifth
 * material without extending this table looks like.
 *
 * A load-time throw and not a test, for the same reason the voice-count check above is one: it
 * runs in the game as well as in the suite, and there is no arrangement of imports that reaches
 * the synthesis without passing it.
 */
for (let obj = 0; obj < MATERIAL_VOICES.length; obj++) {
  const fitted = COMPOSED_OFF_DIAGONAL_NORMS[obj];
  if (fitted === undefined || fitted.length !== MATERIAL_VOICES.length) {
    throw new Error(
      `audio/voices: composed norms row ${obj} has ${fitted?.length ?? 0} cells, ` +
        `expected ${MATERIAL_VOICES.length}.`,
    );
  }
  for (let surf = 0; surf < fitted.length; surf++) {
    if ((fitted[surf] === null) !== (obj === surf)) {
      throw new Error(
        `audio/voices: composed norm [${MATERIAL_NAMES[obj]}][${MATERIAL_NAMES[surf]}] is ` +
          `${obj === surf ? 'a literal; the diagonal is MATERIAL_VOICES[i].attackNorm by reference' : 'null; every off-diagonal pair needs a fitted norm'}.`,
      );
    }
    const composed = COMPOSED_ATTACK_NORMS[obj]?.[surf];
    if (composed === undefined || !(composed > 0) || !Number.isFinite(composed)) {
      throw new Error(
        `audio/voices: composed norm [${MATERIAL_NAMES[obj]}][${MATERIAL_NAMES[surf]}] is ` +
          `${String(composed)}; a gain has to be a positive finite number.`,
      );
    }
  }
}
