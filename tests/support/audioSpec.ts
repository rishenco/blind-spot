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
        + 'deviation: dust has the widest per-strike spread of the four (7.57 dB peak-to-peak, '
        + 'see ATTACK_LEVEL_SAMPLE) because it is nearly all exciter and has almost no modal '
        + 'ring to steady it. Averaged over the sample the law holds to 0.09 dB. This pin is '
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
 * the attack window is 85 ms, so consecutive seeds read ~98 % the same audio and are barely one
 * sample: sixteen of them from seed 200 put metal 0.78 dB off its multiplier, and from seed 500
 * put a stance 1.01 dB off. From seed 0 they land at 0.16 dB and everything passes, which is why
 * the simplification survives being tried.
 *
 * **Do not simplify this into a single render.** A one-strike version of the loudness test
 * passes or fails on which noise slice it happened to read — see the `bodyRmsDb` pins above,
 * where the same law that holds to 0.36 dB over the sample reads 1.9 dB off on one strike.
 */
export const ATTACK_LEVEL_SAMPLE = Object.freeze({
  /**
   * Strikes per material, stratified across the whole bank.
   *
   * **Measured, and the previous 16 was not.** Every seed in the bank was tabulated once and the
   * estimator run over it at every sample size and at sixteen offsets within a stratum, so what
   * follows is the estimator's own error separated from the law's:
   *
   * | strikes | worst \|residual\| over 16 phases |
   * |---|---|
   * | 16 | 1.396 dB |
   * | 32 | 0.761 |
   * | 64 | 0.619 |
   * | 96 | 0.466 |
   * | 128 | 0.549 |
   * | 192 | **0.383** |
   * | 256 | 0.384 |
   * | 384 | 0.370 |
   *
   * The converged residual — every one of the 997 seeds — is 0.359 dB, at `landing`/dust, and it
   * is the `bright` leak `BRIGHT_LEAK_MAX_DB` already documents rather than anything new. So 192
   * is where the estimate stops moving: past it the number is the law's residual and nothing of
   * the estimator's is left. 16 was not that point and never was. It sat at 1.396 dB worst — over
   * `acrossStancesToleranceDb`, twice over `toleranceDb` — and passed only because the shipped
   * offset happens to be a lucky one, landing at 0.305 where its neighbours reach 1.4. A sample
   * whose passing depends on which stratum offset it starts from is not measuring the law; it is
   * spending the tolerance the law is supposed to be judged against.
   *
   * The table is a tabulation, not a model: shifting the seeds by the offset it names as the
   * worst one and running this suite for real reproduces its 1.396 dB to six figures, and doing
   * the same at 192 changes nothing that fails.
   */
  strikes: 192,
  /** When the first strike lands in the render, seconds. */
  firstAtSec: 0.05,
  /**
   * How many strikes share one render.
   *
   * Cost, and only cost. Every scheduled voice is processed for the whole of the render it is in,
   * so `strikes` strikes in one render of length `spacingSec × strikes` is quadratic work: at 192
   * it is a 38 s render carrying 192 voices, sixteen times over. Cut into chunks it is linear.
   * Measured, as whole-file wall time: **12.5 s at 8 per render against 232 s at 192**. Without
   * this, raising `strikes` would have cost four minutes a run.
   *
   * That it does not move the answer had to be checked rather than assumed, because chunking
   * changes what each strike has ringing behind it: the first strike of every chunk starts in
   * silence. Running the whole file at `strikesPerRender: 1` — the extreme of that, every strike
   * alone in its own render — moves metal's estimate by 0.005 dB and every other material's by
   * 0.0001 dB, against a tolerance of 0.5. Metal is the one that moves because metal is the one
   * that is still ringing; see `spacingSec` for the same effect measured directly.
   */
  strikesPerRender: 8,
  /**
   * Seconds between strikes.
   *
   * 0.2 is longer than every attack window, and it is deliberately *not* longer than metal's
   * 0.30–0.38 s modes: a strike therefore lands with the previous one still ringing about 32 dB
   * down inside its 85 ms window, which looks like a systematic bias in favour of exactly the
   * materials that ring.
   *
   * Measured, and it is not one. The same 96-seed sample rendered at 0.2 s, at 0.5 s, at 1.0 s
   * and one-strike-per-render agrees to 0.0036 dB on metal's estimate and to 0.0001 dB on every
   * other material's — three orders of magnitude under `toleranceDb`. Per strike the effect
   * reaches 0.096 dB on metal, but its sign follows the phase the ring happens to be at, so it
   * averages out rather than accumulating: metal's mean shifts −0.004 dB at `walk-step` and
   * +0.004 at `landing`. Widening the spacing would triple the render time to buy that.
   */
  spacingSec: 0.2,
  /**
   * Measured peak-to-peak spread of the individual strikes at this sample, walk-step, dB.
   *
   * Recorded because it is the reason the sample exists, and because the *ordering* is itself a
   * result: dust and metal scatter most — dust because it is nearly all exciter with no modal
   * ring to steady it, metal because its Q~146 mode is driven by a slice of the burst close to
   * one degree of freedom — while concrete and stone sit at half that. Nothing asserts these
   * exactly; `maxSpreadDb` is the guard.
   *
   * They roughly doubled for metal when `strikes` went from 16 to 192, which is what a
   * peak-to-peak *should* do when a sample gets twelve times bigger: the extremes of a
   * distribution are found by looking, and 16 strikes had not looked. The spread is a property
   * of the material, and the old numbers were an underestimate of it.
   */
  spreadDb: Object.freeze({ concrete: 2.54, metal: 6.89, stone: 2.64, dust: 7.57 }),
  /**
   * The ceiling any single material's spread must stay under, dB.
   *
   * 12 against a measured worst of 9.07 (crouch-step on dust, the quietest and most
   * exciter-dominated combination the game has). Not a tolerance on a pinned value — a smoke
   * alarm. If a material's strike-to-strike scatter grows past this, `strikes` strikes are no
   * longer enough to estimate its mean and every number below it in this file is being read off
   * noise. It moved with `strikes` for the reason `spreadDb` gives, not because anything got
   * noisier.
   */
  maxSpreadDb: 12,
});

/**
 * How far `ATTACK_WINDOW_SEC` may travel — the window §3.9's invariant is *defined over*.
 *
 * The constant lives in `src/audio/voices.ts`, next to the four `attackNorm` values that were
 * fitted against it, and that is where it belongs: a window owned by this file would leave the
 * synthesis normalizing against a definition it does not hold. The consequence is that no code
 * under `src/` reads it. Moving it changes no graph and makes no sound — it changes only the
 * measurement the law is judged by, which makes it the one number in the material system that a
 * *failing fit* can be rescued with. Widen the window and metal, whose modes are still ringing at
 * 0.15 s where concrete's longest is gone by 0.09, keeps adding energy to a measurement concrete
 * has stopped contributing to; the residuals walk and no voice has moved.
 *
 * Measured, and the sensitivity is one-sided: narrowing it to 0.02 s fails five assertions in
 * `materialVoices.test.ts`, and widening it to 0.15 s — or to 0.35 s, longer than metal's entire
 * 0.38 s ring — failed none. So the ceiling is the end that needed saying.
 *
 * **Only the floor is a number here, and the ceiling deliberately is not.** The ceiling is where
 * `RING_TAIL_WINDOW` begins: an attack window that reached it would be measuring the half of the
 * voice §3.9 reserves — "timbre and decay are untouched" — and the half `ringTailDb` already owns,
 * so one render would be answering two questions with one window. `materialVoices.test.ts`
 * therefore asserts against `RING_TAIL_WINDOW.fromSec` itself rather than against a copy of it
 * written down here, for the same reason `keeps every centroid tolerance on its own side of the
 * split` exists: two pins that can disagree about the same render are one pin too many. That
 * boundary is also exactly metal's shortest resonant mode, `{ f: 5170, t60: 0.15 }` — the fastest
 * thing in the material table that is still a ring, and a 0.15 s "attack" contains the whole of
 * its 60 dB decay.
 */
export const ATTACK_WINDOW_BOUNDS = Object.freeze({
  /**
   * The shortest window that still contains the attack, seconds.
   *
   * Dust's exciter: `exciterTau` 0.012 through the six time constants `fallTo` gives it, so the
   * burst is still falling until 0.072 s after the strike. Dust is nearly all exciter — one short
   * mode and `scuff` 0.9 — so a window below this fits the normalization to a fraction of the
   * very thing being normalized, on the material with the widest strike-to-strike spread in the
   * table. The shipped 0.085 clears it by 18 %.
   */
  minSec: 0.072,
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
   * Worst measured residual there is 0.085 dB (dust), and the whole of that is the law: the
   * estimator's own contribution at `strikes` = 192 is under 0.03 dB. ±0.5 is six times it:
   * tight enough that a material whose multiplier was applied twice (metal would be +3.5 dB out)
   * or not at all fails immediately, loose enough to survive a modal retune that shifts where
   * the attack window's energy sits.
   *
   * It reads 0.176 dB at the previous `strikes` = 16, and that is the entry worth keeping: the
   * difference between the two is not the voices changing, it is sixteen strikes reporting their
   * own sampling error as the material's residual.
   */
  toleranceDb: 0.5,
  /**
   * Tolerance across the other three stances, dB.
   *
   * Wider than the walk tolerance because the fit is at one `bright` and the stances span 0.55
   * to 1.6 of it, so a little of the exciter's cutoff move leaks into the level. Worst measured
   * residual anywhere is 0.357 dB (dust, landing) and it grows monotonically with `bright`,
   * which is the leak being visible rather than hidden. See BRIGHT_LEAK_MAX_DB for the bound on
   * the leak itself. That number is now the *converged* one — every seed in the bank gives
   * 0.359 — where at `strikes` = 16 it read 0.305 at the shipped offset and 1.40 two offsets
   * away, which is the sampling error wearing the law's name.
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
// The composed contact (§3.9 generalized) — two bodies, two rows, one sound

/*
 * These five arrived with the seam in `src/audio/voices.ts`, before any class carried a composed
 * contact, and lived in `tests/audio/composedVoice.test.ts` for exactly one commit — the whole
 * verification story of that commit was that it touched no existing file, pinned numbers
 * included. The class exists now (`prop-impact`), so they take their place beside the
 * single-material pins they generalize, unchanged: every number below is the same measurement it
 * was when it was made.
 */

/**
 * Above this, 150–300 ms after the strike, a surface is still ringing, dBFS.
 *
 * Measured at this file's gain staging, the four metal-surfaced pairs sit between −67.5 and
 * −61.5 dBFS; the loosest is 12.5 dB clear of this line. Absolute rather than relative because
 * the claim being made is "there is still a sound there", and it is paired with
 * `DULL_TAIL_CEILING_DBFS` so the two together are a partition rather than two independent
 * numbers. Both move together if the gain staging does — assert differences, not these, when the
 * claim is about how far apart two materials are.
 */
export const RINGING_TAIL_FLOOR_DBFS = -80;

/**
 * Below this, the surface has stopped, dBFS. Measured worst (loudest) dull pair: −99.4.
 *
 * 9.4 dB of margin, and the gap between the two constants is 10 dB of no-man's land that no
 * measured pair is anywhere near — which is what stops a modest retune from making the partition
 * ambiguous instead of failing it.
 */
export const DULL_TAIL_CEILING_DBFS = -90;

/**
 * The least a struck metal surface may out-ring a struck dull one, dB, at the same object.
 *
 * Measured minimum over the four objects is 32.0 dB (a metal object, metal floor against
 * concrete floor); the largest is 37.9. This is `MIN_METAL_TAIL_SEPARATION_DB`'s claim asked of
 * the composed voice, and pinned lower than its 35 for one reason: at the composed shape the
 * *object* row also feeds the bank, so the same surface separation is worth a few dB less when a
 * dull object is doing the driving. 25 keeps 7 dB of headroom under the worst measured pair.
 */
export const MIN_SURFACE_TAIL_SEPARATION_DB = 25;

/**
 * The most the *object* may move the ring on a fixed surface, dB.
 *
 * The other half of "the ring belongs to the floor": on steel, the four objects ring within
 * 6.0 dB of each other — the object drives the bank harder or softer, it does not decide whether
 * the bank rings at all. 15 is 2.5× that. Wired backwards this reads 34.5 dB, because it becomes
 * the *surface* spread measured under the object's name.
 */
export const MAX_OBJECT_TAIL_SPREAD_DB = 15;

/**
 * The least a dust object must out-brighten a concrete one on the same dull floor, Hz.
 *
 * Measured 396 Hz on concrete, 411 on stone, 725 on dust. It is the scuff: dust's exciter is the
 * softest in the table (1100 Hz against concrete's 3200) but almost all of it is heard directly
 * — `scuff` 0.9 against 0.25 — where concrete's is mostly spent driving modes that sit below
 * it.
 * So a handful of grit reads *brighter* on the attack than a lump of concrete, which is the same
 * "brightness is a scuff-versus-ring axis, not a hardness axis" finding `materialVoices.test.ts`
 * records, arriving here as the object axis.
 *
 * 250 leaves 146 Hz of margin on the tightest of the three, which is inside the ±100–150 Hz
 * tolerances the material centroids already carry. Ignore `objMat` in the voice and this
 * collapses to exactly 0 on all three floors, which is the mutation this number exists for.
 */
export const MIN_OBJECT_CENTROID_GAP_HZ = 250;

// ---------------------------------------------------------------------------
// The Halo hum (§3.8)

/**
 * The Halo's radius → pitch calibration: audible radius in metres against the hum's fundamental.
 *
 * §3.8 is non-negotiable about the player always knowing how loud they are, and pitch is the
 * readout. These three rows are the three movement tiers of §3.3 read through `paint/halo`'s
 * `humPitch`: crouch (2 m), walk (11 m), sprint (24 m) — the **hearing** radii of §3.3's
 * right-hand column on concrete, which is what the Halo reports.
 *
 * `windowSec` is where each tier sits in `haloHum.test.ts`'s timeline, and it moved when the
 * fixture went: the hum is now driven the way the game drives it, one `setRadius` per 60 Hz
 * frame through §3.8's real glide, so a plateau needs ~1.2 s (about seven glide constants) to
 * have settled before the pitch means anything.
 *
 * These windows used to have a second job — dodging the near-unison's beat nulls, 2.25 s apart at
 * the crouch end, where `estimateF0` correctly answered "no pitch here" rather than guessing. They
 * do not any more: shrinking the near-unison closed the nulls, and the pitch now reads
 * continuously across every plateau (see `HALO_BEAT_MAX_DEPTH_DB`). A test suite steering around
 * a hole in the readout was the clue that the hole should not have been there.
 */
export const HALO_PITCH_POINTS = Object.freeze([
  { radiusM: 2, hz: 63.51, windowSec: [0.6, 1.5] },
  { radiusM: 11, hz: 148.94, windowSec: [3.2, 4.1] },
  { radiusM: 24, hz: 220.0, windowSec: [5.8, 6.7] },
] as const);

/**
 * How far a measured hum pitch may sit from `humPitch`, in cents.
 *
 * Measured error is −3.2 to +1.3 cents, and it is *not* estimator error — `estimateF0` reads a
 * pure sine to within 0.1 cents. It is the hum's own 0.7 % detuned second oscillator pulling the
 * composite period around by roughly its share of the mix; it was +2.7 to +5.8 while that partial
 * ran at 0.8. 25 cents is an eighth of a semitone: far tighter than anything audible as a wrong
 * reading, far looser than the beat.
 *
 * It is also the tolerance the plateau assertion uses at half width, and that one has teeth: a
 * hum that stopped scheduling a ramp while the radius held still reads **169 cents sharp** for
 * the whole plateau, because the next ramp then interpolates from the far side of it.
 */
export const HALO_PITCH_TOLERANCE_CENTS = 25;

/**
 * How high the crouch plateau's spectral centroid may sit, Hz — §3.8's "felt more than heard".
 *
 * §3.8 fixes the quiet end as a character and not only as a note: "a crouch-step on concrete
 * carries 2 m and sits at 63 Hz, **felt more than heard**". That is a claim about where the
 * tone's energy is, and until this number existed nothing in the suite could see it. Every pitch
 * assertion reads the *fundamental*, which a partial's ratio leaves alone — `estimateF0` and the
 * ear both track the fundamental, which is exactly what `PARTIALS` says about it. Every level
 * assertion reads amplitude, which a quiet partial an octave up barely moves. So the tone can be
 * handed a bright upper partial, keep `HALO_PITCH_POINTS`, `HALO_PEAK_DBFS`,
 * `HALO_LEVEL_SPREAD_MAX_DB` and `HALO_BEAT_MAX_DEPTH_DB` all green, and stop being felt at all.
 *
 * Measured over `HALO_PITCH_POINTS[0]`'s window on the swept render: **76.1 Hz**, which is 1.20×
 * the 63.5 Hz fundamental it reports — the reading is its own bass note plus a little. Move
 * `PARTIALS`' third entry from 2.5× to 5× and the same window reads 100.9 Hz, +33 %, with nothing
 * else in the suite moving. 90 sits between them on purpose: 18 % above the measurement, 11 %
 * below the mutant, and far below the 148.9 Hz fundamental of the tier above — so a crouch's
 * whole spectrum stays under the note a walk plays, which is the readable version of the claim.
 *
 * **The crouch plateau, and not the sweep.** The 520 Hz lowpass (`TONE_LP_HZ`) hides that same
 * mutation at the loud end, where 5 × 220 Hz is past the cutoff: the sprint plateau's centroid
 * actually *falls*, 251.4 → 242.6 Hz. The quiet end is the only place the change is visible, and
 * it is also the only place §3.8 makes a claim about the tone's character.
 */
export const HALO_CROUCH_CENTROID_MAX_HZ = 90;

/**
 * How far apart in *time* the hum and the ring may drift, seconds.
 *
 * §3.8's whole argument for the Halo is that the ring and the hum are two readouts of one
 * quantity and must never disagree, and `paint/halo.ts` makes it structurally impossible for them
 * to disagree about *value*: `haloBrightness` is an affine image of `humPitch`, proved with no
 * audio anywhere in the claim (`tests/halo.test.ts`). They can still disagree about *when*. The
 * ring is drawn from `Halo.radius` on the frame it is read; the hum's pitch is a ramp scheduled
 * to land `TRACK_SEC` later. Nothing bounded that: `haloHum.test.ts` reads pitch at plateaus,
 * where a lag has nothing to show, so `TRACK_SEC` could be moved to 0.06 or 0.1 and the whole
 * suite stayed green. A tenth of a second at the start of a crouch→walk glide is 650 cents — the
 * ring showing one stance while the ear plays another, in the readout §3.8 calls non-negotiable.
 *
 * Measured as a time rather than as a pitch error, so it reads in the unit the claim is made in:
 * track the rendered F0 across the 2 m → 11 m transition, find when it crosses the geometric
 * midpoint of the two plateaus, and subtract when the glide the *ring* is drawn from crosses the
 * same point. Baseline reads **0.0199 s** against a `TRACK_SEC` of 0.02 — the estimator recovers
 * the constant to a millisecond, and does so at every analysis width from 60 to 120 ms and on the
 * falling transition too, which is why one width and one transition is enough to assert on.
 *
 * 0.033 s is **two frames** at the 60 Hz `Game.update` pushes at, which is the ceiling
 * `TRACK_SEC`'s own docstring claims for itself — "one frame's worth of smoothing on top". The
 * bound is that sentence, held to. It leaves 13 ms over the measured 0.0199, against a
 * measurement that reproduces to a millisecond across analysis widths and across both
 * transitions, so the slack is a wide margin rather than a fudge.
 *
 * Bounded on both sides, because a hum that *led* the ring is the same disagreement mirrored, and
 * §3.7's rule that a readout never predicts applies to the ear exactly as it does to the
 * renderer. A `TRACK_SEC` of 0 therefore passes: no lead, no lag, no disagreement.
 *
 * One honest note about what this adds. At HEAD the silence gate's fade is scheduled through the
 * same `TRACK_SEC`, so `leaves when the body stops` already fails somewhere around 0.037 — a
 * lag this size is not currently invisible. But that coverage is incidental and it is mute: it
 * reports a tone still audible during a pause, which points a reader at the gate, and it would
 * evaporate the moment the pitch lead and the gate's lead became two constants. This one fails
 * saying the hum is late, in seconds, which is the defect.
 */
export const HALO_TRACK_MAX_LAG_SEC = 0.033;

/**
 * The hum's peak level, dBFS.
 *
 * §3.8 states this as law — "level stays low and near-constant (≈ −21 dBFS) and ducks under
 * events, so the information rides on pitch and the tone can sit under everything without
 * fatiguing" — so it is a design quantity, and `HALO_LEVEL` in `src/audio/halo.ts` is set to land
 * on it rather than the other way round. The swept render peaks at −21.06. RMS at the plateaus
 * runs 6–9 dB below that, since a 63 Hz fundamental and a 220 Hz one meet the 520 Hz lowpass
 * differently.
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
 * across the three plateaus is 3.1 dB and none of it is intended: it is the 520 Hz lowpass
 * meeting a 63 Hz fundamental differently from a 220 Hz one. 10 dB leaves room for a filter
 * retune and still fails a hum whose level followed its pitch.
 */
export const HALO_LEVEL_SPREAD_MAX_DB = 10;

/**
 * How far the hum's own tremolo may swing, dB — the readout must never go away by itself.
 *
 * The tone is a near-unison (`PARTIALS` in `src/audio/halo.ts`), and a near-unison beats: two
 * partials at gains `a` and `b` swing between `a + b` and `|a - b|` once per `Δratio × f` seconds.
 * That is deliberate — it is what makes the tone read as a machine idling rather than as a test
 * tone — but the *depth* was never chosen, and at the original 0.8 against 1.0 it was 16-18 dB.
 * A tone that nearly vanishes once a second is a problem twice over: §3.8 asks the level to stay
 * "near-constant" so the reading rides on pitch, and the silence gate spends the tone's absence
 * to mean "you are making no noise at all" — a meaning it cannot hold if the tone leaves on its
 * own. The nulls were load-bearing in this very file, too: `HALO_PITCH_POINTS` says its windows
 * "dodge the near-unison's beat nulls ... where `estimateF0` correctly answers 'no pitch here'".
 * A readout §3.8 calls non-negotiable, with a hole in it, and a test suite steering around the
 * hole.
 *
 * At 0.35 the measured swing is 6.1-6.5 dB across the whole radius range and `estimateF0` reads
 * the pitch continuously. 9 dB leaves room to retune the partial and still fails the 0.8 that
 * made the nulls.
 */
export const HALO_BEAT_MAX_DEPTH_DB = 9;

/**
 * How the hum gets out of the way of an event — §3.8's "ducks under events".
 *
 * The reason the duck exists is masking: the hum is the only continuous tone in the game, and
 * what it would sit on top of is footfalls, which are the player's primary source of geometry
 * (§3.3: "moving fast **is** scanning"). A readout that costs you the thing it is reporting on
 * is a bad trade, so it steps aside for every voice the mixer builds.
 *
 * Measured, at the hum's own gain: −9.1 dB at the floor, recovered to within 0.01 dB by 0.9 s,
 * and 0.03 dB of effect on anything else sharing the master. `bleedMaxDb` is the one with teeth
 * — a duck automated on the master bus instead of on the hum would attenuate the very event it
 * was making room for, by about 10 dB.
 */
export const HALO_DUCK = Object.freeze({
  /** Least dip the hum must show while an event is landing, dB. Measured 9.1. */
  minDepthDb: 6,
  /** By when the hum must be back, seconds after the event. Measured: 0.01 dB out at 0.9 s. */
  recoveredBySec: 0.9,
  /** How close to undisturbed "back" means, dB. */
  recoveredWithinDb: 0.5,
  /** How much the duck may move anything else in the mix, dB. Measured 0.03. */
  bleedMaxDb: 0.2,
});

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
