/**
 * The pinned audio table — every number an audio test asserts, in one file.
 *
 * Same discipline as the `SOUND_CLASSES` pin in `tests/headless.test.ts`, and for the same
 * reason: playtests are *expected* to move these, and when they do the change should read as a
 * one-line diff in a table someone deliberately edited, not as a mystery failure three files
 * away. A test that inlines `expect(centroid).toBeCloseTo(1795)` teaches nobody what 1795
 * was, or how far it was allowed to move, or what breaks in the game if it moves further.
 *
 * **Everything here is a tolerance, never an exact value.** The photometric suite is
 * threshold-based for the same reason: a render is float arithmetic through a native DSP
 * backend, and pinning an exact number would make the suite a hostage to the last decimal place
 * of a biquad. Each tolerance below carries a comment saying *why it is as wide as it is* — a
 * tolerance without a stated reason is a number someone widened until the test went green.
 *
 * Every value was measured with `tests/support/audioMetrics.ts` against a render built by
 * `tests/support/audioRender.ts` at 48 kHz through a 0.85 master gain. Change the render
 * conditions and the whole table moves together, which is the point.
 *
 * **Everything below is now measured against the shipped synthesis.** Until this commit the
 * material numbers came from `tests/support/probeVoices.ts`, a fixture written before there was
 * any audio to measure; `src/audio/voices.ts` ships the real voices and that fixture is gone. So
 * the whole material table moved at once, and the moves are not drift — they are the difference
 * between a prototype and the game. The one column that did not simply move is the loudness law,
 * which changed *shape*: see `ATTACK_LEVEL_SAMPLE`.
 */

/** A pinned measurement: the value observed, and how far it may drift before anyone cares. */
export interface Pinned {
  /** The measured value. */
  readonly value: number;
  /** Half-width of the accepted band, in the same unit. */
  readonly tol: number;
  /** Why the tolerance is this wide. Not optional — see the file header. */
  readonly why: string;
}

// ---------------------------------------------------------------------------
// The material fingerprint (§3.9)

/**
 * The window the ring tail is measured in, relative to the start of the render, seconds.
 *
 * The strike is at t = 0.05, so this is **150–300 ms after contact**: late enough that every
 * exciter and every thump is over, early enough that metal's 0.30–0.38 s modes are still going.
 * Bounded on both sides on purpose — the open-ended form would swallow the next footstep in any
 * render with more than one.
 */
export const RING_TAIL_WINDOW = Object.freeze({ fromSec: 0.2, toSec: 0.35 });

/**
 * The window the centroid and RMS are measured in — the strike plus 250 ms.
 *
 * Wide enough to contain the whole event for every material, so the number is a property of the
 * sound rather than of where the window happened to land.
 */
export const BODY_WINDOW = Object.freeze({ fromSec: 0.05, toSec: 0.3 });

export interface MaterialFingerprint {
  /** Spectral centroid over `BODY_WINDOW`, Hz. Coarse on purpose: see `CENTROID_SPLIT_HZ`. */
  readonly centroidHz: Pinned;
  /** RMS over `RING_TAIL_WINDOW`, dBFS. The discriminator. */
  readonly ringTailDb: Pinned;
  /** RMS over `BODY_WINDOW`, dBFS — how loud the contact is overall. */
  readonly bodyRmsDb: Pinned;
}

/**
 * The two-axis fingerprint of each material voice, as the game renders it: one `walk-step`
 * emitted on a real `SoundBus`, decided by a real `AudioDirector` at the near field, struck at
 * t = 0.05 with seed 11, over a 1 s render.
 *
 * Read the ring-tail column first. It is the only column that separates metal from everything
 * else, and it does so by nearly 40 dB.
 *
 * Two things changed with the move off the fixture, and both are visible in the numbers.
 * The gains are no longer equal — every material now arrives at the level §3.3 and §3.9 give it,
 * because the spec comes through the director — so `bodyRmsDb` reads the loudness law rather than
 * the modal bank. And every centroid dropped by roughly half, because the shipped exciter is
 * lowpassed at `exciterLp × spec.bright` where the fixture's was flat: the partition survives with
 * *more* relative margin, which is why `CENTROID_SPLIT_HZ` moved down rather than widening.
 */
export const MATERIAL_FINGERPRINTS = Object.freeze({
  dust: {
    centroidHz: {
      value: 618.0,
      tol: 150,
      why: 'Dust is almost pure lowpassed exciter, so its centroid tracks its 1100 Hz cutoff '
        + 'directly — scaled here by the walk-step\'s bright of 1.0. ±150 Hz is roughly a '
        + '±15 % move of that cutoff: a real retune of how soft dust is, rather than a '
        + 'rounding difference.',
    },
    ringTailDb: {
      value: -104.2,
      tol: 10,
      why: 'This is a single 0.05 s mode ringing out into the float noise floor: not a design '
        + 'quantity, just "nothing is left". ±10 dB because at -104 dBFS the absolute value is '
        + 'meaningless; the assertion that carries weight is MIN_METAL_TAIL_SEPARATION_DB.',
    },
    bodyRmsDb: {
      value: -43.9,
      tol: 3,
      why: 'One strike, on one noise slice, at the level the director gave it. It sits 6.3 dB '
        + 'under concrete where the law promises 4.4, and that gap is *this render*, not a '
        + 'deviation: dust has the widest per-strike spread of the four (5.86 dB peak-to-peak, '
        + 'see ATTACK_LEVEL_SAMPLE) because it is nearly all exciter and has almost no modal '
        + 'ring to steady it. Averaged over the sample the law holds to 0.31 dB. This pin is '
        + 'gain-staging, and ±3 dB is what that job needs.',
    },
  },
  concrete: {
    centroidHz: {
      value: 313.5,
      tol: 100,
      why: 'Concrete\'s two strongest modes are 170 and 410 Hz and its exciter is lowpassed at '
        + '900 Hz, so the centroid sits low and the modes dominate it. ±100 Hz survives a '
        + 'modest mode retune; a change that pushed it past 400 Hz would mean concrete had '
        + 'stopped being the dull default everything else is measured against.',
    },
    ringTailDb: {
      value: -104.1,
      tol: 10,
      why: 'As dust: the 0.04–0.09 s modes are long gone by 150 ms. Loose for the same reason.',
    },
    bodyRmsDb: {
      value: -37.5,
      tol: 3,
      why: 'Concrete is the x1.0 reference every other material is stated relative to, so this '
        + 'is effectively the gain-staging pin for the whole table. It moved 9.7 dB down from '
        + 'the fixture\'s number for one reason: the level is no longer a test\'s chosen 0.5, it '
        + 'is what gainFor answers for a walk-step heard at the near field.',
    },
  },
  stone: {
    centroidHz: {
      value: 410.6,
      tol: 120,
      why: 'Sits between concrete and dust and is only ~97 Hz above concrete, which is why the '
        + 'tolerance cannot be tightened much without making an ordinary retune a failure — and '
        + 'is itself the evidence that centroid is a poor material axis.',
    },
    ringTailDb: {
      value: -99.5,
      tol: 10,
      why: 'Stone\'s longest mode is 0.14 s, so by 150 ms it is at the floor too. This is the '
        + 'value metal is compared against, because stone is metal\'s nearest neighbour on this '
        + 'axis: 39.1 dB away.',
    },
    bodyRmsDb: {
      value: -37.0,
      tol: 3,
      why: 'Stone now arrives *above* concrete, which is what changed when the level started '
        + 'coming from the carry radius: the fixture had every material at one gain and let the '
        + 'modal bank decide, and stone\'s bank is quieter than concrete\'s. It is +0.57 dB here '
        + 'against a promised +1.21, which is one noise slice\'s worth of scatter and not a '
        + 'deviation — see MATERIAL_LOUDNESS_LAW for where the claim is actually enforced.',
    },
  },
  metal: {
    centroidHz: {
      value: 1240.7,
      tol: 250,
      why: 'The one centroid worth a real assertion: metal is ~830 Hz above dust, the brightest '
        + 'of the others, so ±250 Hz leaves the gap unambiguous while allowing the 5170 Hz '
        + 'mode to be retuned. Wider than the others because metal has five modes spread over '
        + 'four octaves and moving any of them moves the mean.',
    },
    ringTailDb: {
      value: -60.4,
      tol: 3,
      why: 'The tightest pin in the file, because this one *is* the design: it is metal\'s '
        + '0.30–0.38 s modes still audible 150 ms after the strike. ±3 dB is about a ±10 % '
        + 'move in T60. If this drifts down, metal has stopped sounding like metal and §3.9\'s '
        + 'promise — that the spider\'s footfalls tell you what it is walking on — is broken.',
    },
    bodyRmsDb: {
      value: -34.4,
      tol: 3,
      why: '+3.16 dB over concrete on this strike against a promised +3.52. The nearest of the '
        + 'three to its multiplier on a single render, because metal has the most modal energy '
        + 'and therefore the least dependence on which slice of the noise bank it read.',
    },
  },
} satisfies Record<string, MaterialFingerprint>);

export type PinnedMaterial = keyof typeof MATERIAL_FINGERPRINTS;

/**
 * The load-bearing number of the whole material system: how far metal's ring tail must stay
 * above every other material's.
 *
 * Measured separation to the nearest neighbour (stone) is 39.1 dB. Pinned at 35 to leave ~4 dB
 * of tuning headroom, because the assertion is not "metal rings at exactly this level" — it is
 * "a struck surface's material is legible by ear", which is §3.9's actual promise and the reason
 * the spider is trackable by the timbre of its footfalls at all.
 *
 * The margin narrowed from ~8 dB to ~4 when the fixture gave way to the shipped voices, and the
 * number stayed at 35 rather than being loosened to keep the old slack: 35 dB is the claim worth
 * defending, and a pin that follows the measurement down every time is not a pin. There is no
 * flake risk in the four remaining decibels — a render is bit-identical — so the only thing that
 * can spend them is somebody retuning metal's T60, which is exactly what this should catch.
 *
 * This is the assertion that a naive centroid-ordering test would have replaced, and it is worth
 * being explicit about what that would have cost: the material voices could have decayed into
 * mush and the centroid test would still have passed.
 */
export const MIN_METAL_TAIL_SEPARATION_DB = 35;

/**
 * What the centroid axis is *allowed* to claim.
 *
 * The prototype reported that centroid cannot separate metal from stone (2713 Hz vs 2756 Hz).
 * Re-measured with a Hann window instead of the prototype's unwindowed DFT, it can — 1240.7 vs
 * 410.6 — so the near-equality was an artefact of the instrument, not of the sounds. But the
 * *conclusion* survives, for a better reason: centroid does not **order** the materials. Dust
 * (618 Hz) sits above stone (411) and concrete (314), because dust is nearly all broadband
 * exciter and no low modes. Brightness is a "how much scuff versus how much low ring" axis, not
 * a hardness axis.
 *
 * So the honest shape of the claim is a *partition*, not an ordering: metal above the split,
 * everything else below it, and no assertion at all about the internal order of the other three.
 *
 * Both edges moved *down* with the shipped voices rather than apart, because the real exciter is
 * lowpassed at `exciterLp × spec.bright` where the fixture's was flat: every centroid roughly
 * halved and the partition kept its relative margin. The two numbers are set so that a material
 * sitting at the far edge of its own centroid pin still lands on the right side of the split —
 * dust's 618 + 150 = 768 is under the ceiling, metal's 1240.7 − 250 = 991 is over the floor —
 * because two pins that can disagree about the same render are one pin too many.
 */
export const CENTROID_SPLIT_HZ = Object.freeze({
  /** Every non-metal material's centroid must stay below this. Measured max: dust at 618 Hz. */
  dullCeiling: 850,
  /** Metal's centroid must stay above this. Measured: 1240.7 Hz. */
  metalFloor: 950,
});

/**
 * How an attack level is measured when the claim is about a *material* rather than a render.
 *
 * §3.9's loudness law is a statement about what a contact on a surface sounds like, and one
 * render cannot measure that. The exciter reads a slice of a seeded noise bank, and a single
 * strike's attack level lands 2–6 dB from its own mean depending on which slice it got — not
 * jitter to be averaged away as error, but the physics: metal's Q~146 mode is driven by a ~6 Hz
 * slice of a ~24 ms burst, which is close to one degree of freedom. So the law is enforced over
 * a *sample* of strikes, summed as a power mean (mean of squared amplitude, then back to dB),
 * because that is the expected level; a mean of decibels biases low by the variance.
 *
 * The seeds are `Math.round(i * NOISE_SLOTS / strikes)` and the stratification is the part that
 * is easy to get wrong. `voices.ts` maps consecutive seeds to bank offsets ~1.3 ms apart while
 * the attack window is 85 ms, so sixteen consecutive seeds read ~98 % the same audio and are
 * barely one sample: from seed 200 they put metal 0.78 dB off its multiplier, from seed 500 they
 * put a stance 1.01 dB off. From seed 0 they land at 0.16 dB and everything passes, which is why
 * the simplification survives being tried. Spread across the whole bank, sixteen strikes land
 * within 0.1 dB of a 332-strike estimate wherever they start.
 *
 * **Do not simplify this into a single render.** A one-strike version of the loudness test
 * passes or fails on which noise slice it happened to read — see the `bodyRmsDb` pins above,
 * where the same law that holds to 0.31 dB over the sample reads 1.9 dB off on one strike.
 */
export const ATTACK_LEVEL_SAMPLE = Object.freeze({
  /** Strikes per material. 16 is where the estimate stops moving; see the note above. */
  strikes: 16,
  /** When the first strike lands in the render, seconds. */
  firstAtSec: 0.05,
  /**
   * Seconds between strikes. 0.2 is longer than every attack window and short enough that all
   * four stances of all four materials render in a couple of seconds.
   */
  spacingSec: 0.2,
  /**
   * Measured peak-to-peak spread of the individual strikes at this sample, walk-step, dB.
   *
   * Recorded because it is the reason the sample exists, and because the *ordering* is itself a
   * result: dust scatters most because it is nearly all exciter, metal and concrete less, stone
   * least. Nothing asserts these exactly — `maxSpreadDb` is the guard.
   */
  spreadDb: Object.freeze({ concrete: 2.3, metal: 3.0, stone: 2.1, dust: 5.9 }),
  /**
   * The ceiling any single material's spread must stay under, dB.
   *
   * 8 against a measured worst of 5.9. Not a tolerance on a pinned value — a smoke alarm. If a
   * material's strike-to-strike scatter grows past this, sixteen strikes are no longer enough
   * to estimate its mean and every number below it in this file is being read off noise.
   */
  maxSpreadDb: 8,
});

/**
 * §3.9's loudness law, in the form a test can enforce.
 *
 * The law: a material's multiplier is the *whole* of the level difference it makes. Stated as an
 * invariant, over the attack window and the sample above:
 *
 *   attackDb(mat, cls) − attackDb('concrete', cls) === 20 * log10(materialLoudness(mat))
 *
 * for every material and every contact class. That is a stronger claim than "metal is louder
 * than concrete" and a much stronger one than the fixture's, which asserted the ordering for
 * metal and dust and skipped stone entirely. It is also the claim §3.9 actually makes — "the
 * multiplier scales every radius the event carries" — read at the ear instead of on the bus.
 *
 * It holds by construction rather than by tuning: `SoundBus.emit` multiplies the carry radius by
 * the material's voice, `gainFor` derives the level from that radius, and `voices.ts` normalizes
 * each material's attack to unit level so the modal bank cannot add a second opinion. The
 * `attackNorm` constants are the only fitted numbers in the chain, and they are fitted against
 * this invariant.
 */
export const MATERIAL_LOUDNESS_LAW = Object.freeze({
  /**
   * Tolerance at `walk-step`, dB — the stance the attack normalizations were fitted at.
   *
   * Worst measured residual there is 0.176 dB (metal). ±0.5 is three times that: tight enough
   * that a material whose multiplier was applied twice (metal would be +3.5 dB out) or not at
   * all fails immediately, loose enough to survive a modal retune that shifts where the attack
   * window's energy sits.
   */
  toleranceDb: 0.5,
  /**
   * Tolerance across the other three stances, dB.
   *
   * Wider than the walk tolerance because the fit is at one `bright` and the stances span 0.55
   * to 1.6 of it, so a little of the exciter's cutoff move leaks into the level. Worst measured
   * residual anywhere is 0.305 dB (dust, landing) and it grows monotonically with `bright`,
   * which is the leak being visible rather than hidden. See BRIGHT_LEAK_MAX_DB for the bound on
   * the leak itself.
   *
   * **0.7 and not 1.0, and a mutation chose the number.** Deleting metal's attack normalization
   * outright — `attackNorm: 1.104115` back to 1, which is the whole of §3.9's machinery for that
   * material removed — moves its landing residual to 0.894 dB, and a 1.0 dB tolerance let that
   * pass at the one stance while the other three caught it. A tolerance that admits a broken
   * material at any stance is a tolerance one stance too wide. 0.7 still leaves 2.3× the worst
   * honest residual, which is room for a fifth stance without re-fitting.
   */
  acrossStancesToleranceDb: 0.7,
});

/**
 * How much a class's `bright` may move its *level*, dB — the separation of timbre from loudness.
 *
 * `AUDIO_CLASS_VOICES` gives each contact class a `bright` that scales the exciter's cutoff, and
 * a filter cutoff moving is a level moving unless something stops it. If it were not bounded,
 * `bright` would be a second volume knob sitting beside `hearingRadius`, and the commit that
 * made the level the carry radius would be quietly untrue: a designer making sprint-steps
 * *sound* harder would be making them louder too, in a currency §3.3 never priced.
 *
 * Measured: concrete's attack level tracks its own gain to within 0.21 dB across the full 0.55
 * to 1.6 range of `bright` — a 3× cutoff sweep that moves the level by a fifth of a decibel.
 * Pinned at 0.35 to leave headroom for a retune without leaving room for a volume knob.
 */
export const BRIGHT_LEAK_MAX_DB = 0.35;

// ---------------------------------------------------------------------------
// The Halo hum (§3.8)

/**
 * The Halo's radius → pitch calibration: audible radius in metres against the hum's fundamental.
 *
 * §3.8 is non-negotiable about the player always knowing how loud they are, and pitch is the
 * readout. These three rows are the three movement tiers of §3.3 read through
 * `haloProbe.humPitch`: crouch (2 m), walk (11 m), sprint (24 m).
 */
export const HALO_PITCH_POINTS = Object.freeze([
  { radiusM: 2, hz: 63.51, windowSec: [0.6, 1.4] },
  { radiusM: 11, hz: 148.94, windowSec: [2.7, 3.4] },
  { radiusM: 24, hz: 220.0, windowSec: [4.7, 5.4] },
] as const);

/**
 * How far a measured hum pitch may sit from `humPitch`, in cents.
 *
 * Measured error is +1 to +5 cents, and it is *not* estimator error — `estimateF0` reads a pure
 * sine to within 0.1 cents. It is the hum's own 0.7 % detuned second oscillator pulling the
 * composite period sharp by roughly its share of the mix. 25 cents is an eighth of a semitone:
 * far tighter than anything audible as a wrong reading, far looser than the beat.
 */
export const HALO_PITCH_TOLERANCE_CENTS = 25;

/**
 * The hum's peak level, dBFS.
 *
 * §3.8 now states this as law — "level stays low and near-constant (≈ −21 dBFS) and ducks under
 * events, so the information rides on pitch and the tone can sit under everything without
 * fatiguing" — so it is a design quantity and not an accident of the fixture's gain. The render
 * peaks at −21.01. RMS at the plateaus runs 6–13 dB below that, since a 63 Hz fundamental and a
 * 220 Hz one meet the 520 Hz lowpass differently.
 */
export const HALO_PEAK_DBFS = Object.freeze({
  value: -21.0,
  tol: 2,
  why: '±2 dB: the doc says "≈ −21", and the claim is that the hum sits under everything, not '
    + 'that it hits a number. Tighten it if the mix ever gets a real bus structure to hang off.',
});

/**
 * The hum's level must stay near-constant across the tiers — pitch is the readout, not loudness.
 *
 * If level tracked radius too, a player could not hear their own Halo over their own footsteps
 * at the sprint end, which is exactly the tier where the reading matters most. Measured spread
 * across the three plateaus is ~7 dB and most of that is the lowpass at 520 Hz attenuating the
 * quiet end's 63 Hz fundamental less than its partials.
 */
export const HALO_LEVEL_SPREAD_MAX_DB = 10;

// ---------------------------------------------------------------------------
// Mix hygiene

/**
 * Headroom every render must leave, dBFS.
 *
 * −1 dBFS, not 0: a buffer that touches full scale has no room for the summing that happens when
 * two footsteps and a ping land in the same millisecond, and inter-sample peaks clip on playback
 * even when no *sample* does. `peakInfo().clipped` catches the sample case; this catches the
 * case where the next sound to arrive would have caused it.
 */
export const MAX_PEAK_DBFS = -1;
