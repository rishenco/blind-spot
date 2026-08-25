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
 * The two-axis fingerprint of each material voice, as rendered by `probeVoices.contact`
 * (t = 0.05, gain 0.5, seed 11, 1 s render).
 *
 * Read the ring-tail column first. It is the only column that separates metal from everything
 * else, and it does so by more than 40 dB.
 */
export const MATERIAL_FINGERPRINTS = Object.freeze({
  dust: {
    centroidHz: {
      value: 1006.0,
      tol: 150,
      why: 'Dust is almost pure lowpassed exciter, so its centroid tracks the 1100 Hz cutoff '
        + 'directly. ±150 Hz is roughly a ±15 % move of that cutoff — a real retune of how '
        + 'soft dust is, rather than a rounding difference.',
    },
    ringTailDb: {
      value: -101.8,
      tol: 10,
      why: 'This is a single 0.05 s mode ringing out into the float noise floor: not a design '
        + 'quantity, just "nothing is left". ±10 dB because at −100 dBFS the absolute value is '
        + 'meaningless; the assertion that carries weight is MIN_METAL_TAIL_SEPARATION_DB.',
    },
    bodyRmsDb: {
      value: -38.5,
      tol: 3,
      why: '§3.9 gives dust a ×0.6 loudness multiplier, but it lands ~10.8 dB under concrete '
        + 'because it has almost no modal content to be loud with. ±3 dB catches a change to '
        + 'either the multiplier or the modal bank without firing on gain-staging noise.',
    },
  },
  concrete: {
    centroidHz: {
      value: 584.8,
      tol: 100,
      why: 'Concrete\'s two strongest modes are 170 and 410 Hz, so the centroid sits low and is '
        + 'dominated by them. ±100 Hz survives a modest mode retune; a change that pushed it '
        + 'past 700 Hz would mean concrete had stopped being the dull default it is measured '
        + 'against.',
    },
    ringTailDb: {
      value: -97.4,
      tol: 10,
      why: 'As dust: the 0.04–0.09 s modes are long gone by 150 ms. Loose for the same reason.',
    },
    bodyRmsDb: {
      value: -27.8,
      tol: 3,
      why: 'Concrete is the ×1.0 reference every other material is stated relative to, so this '
        + 'is effectively the gain-staging pin for the whole table.',
    },
  },
  stone: {
    centroidHz: {
      value: 751.0,
      tol: 120,
      why: 'Sits between concrete and dust and is only ~166 Hz above concrete, which is why the '
        + 'tolerance cannot be tightened much without making an ordinary retune a failure — and '
        + 'is itself the evidence that centroid is a poor material axis.',
    },
    ringTailDb: {
      value: -95.4,
      tol: 10,
      why: 'Stone\'s longest mode is 0.14 s, so by 150 ms it is at the floor too. This is the '
        + 'value metal is compared against, because stone is metal\'s nearest neighbour on this '
        + 'axis: 42.7 dB away.',
    },
    bodyRmsDb: {
      value: -28.4,
      tol: 3,
      why: 'KNOWN DEVIATION from §3.9: stone\'s ×1.15 multiplier predicts it ~1.2 dB *louder* '
        + 'than concrete, and it renders 0.7 dB quieter — its modal gains give back more than '
        + 'the multiplier adds. Pinned as measured so the deviation is visible; see '
        + 'STONE_IS_QUIETER_THAN_ITS_MULTIPLIER.',
    },
  },
  metal: {
    centroidHz: {
      value: 1795.0,
      tol: 250,
      why: 'The one centroid worth a real assertion: metal is ~1044 Hz above stone, so ±250 Hz '
        + 'leaves the gap unambiguous while allowing the 5170 Hz mode to be retuned. Wider than '
        + 'the others because metal has five modes spread over four octaves and moving any of '
        + 'them moves the mean.',
    },
    ringTailDb: {
      value: -52.7,
      tol: 3,
      why: 'The tightest pin in the file, because this one *is* the design: it is metal\'s '
        + '0.30–0.38 s modes still audible 150 ms after the strike. ±3 dB is about a ±10 % move '
        + 'in T60. If this drifts down, metal has stopped sounding like metal and §3.9\'s '
        + 'promise — that the spider\'s footfalls tell you what it is walking on — is broken.',
    },
    bodyRmsDb: {
      value: -24.3,
      tol: 3,
      why: '§3.9 gives metal ×1.5 over concrete (+3.5 dB) and it measures +3.5 dB. The one '
        + 'multiplier that arrives intact.',
    },
  },
} satisfies Record<string, MaterialFingerprint>);

export type PinnedMaterial = keyof typeof MATERIAL_FINGERPRINTS;

/**
 * The load-bearing number of the whole material system: how far metal's ring tail must stay
 * above every other material's.
 *
 * Measured separation to the nearest neighbour (stone) is 42.7 dB. Pinned at 35 to leave ~8 dB
 * of tuning headroom, because the assertion is not "metal rings at exactly this level" — it is
 * "a struck surface's material is legible by ear", which is §3.9's actual promise and the reason
 * the spider is trackable by the timbre of its footfalls at all.
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
 * Re-measured with a Hann window instead of the prototype's unwindowed DFT, it can — 1795 vs
 * 751 — so the near-equality was an artefact of the instrument, not of the sounds. But the
 * *conclusion* survives, for a better reason: centroid does not **order** the materials. Dust
 * (1006 Hz) sits above stone (751) and concrete (585), because dust is nearly all broadband
 * exciter and no low modes. Brightness is a "how much scuff versus how much low ring" axis, not
 * a hardness axis.
 *
 * So the honest shape of the claim is a *partition*, not an ordering: metal above the split,
 * everything else below it, and no assertion at all about the internal order of the other three.
 */
export const CENTROID_SPLIT_HZ = Object.freeze({
  /** Every non-metal material's centroid must stay below this. Measured max: dust at 1006 Hz. */
  dullCeiling: 1300,
  /** Metal's centroid must stay above this. Measured: 1795 Hz. */
  metalFloor: 1500,
});

/**
 * A deviation from §3.9 that the table records rather than hides.
 *
 * §3.9's first-pass multipliers are metal ×1.5 · stone ×1.15 · concrete ×1.0 · dust ×0.6, which
 * predicts stone ~1.2 dB louder than concrete. It renders 0.66 dB *quieter*: the multiplier is
 * applied, but stone's modal gains are lower than concrete's by more than the multiplier makes
 * up. Pinned so that whoever fixes it sees a failing number instead of discovering it by ear.
 */
export const STONE_IS_QUIETER_THAN_ITS_MULTIPLIER = Object.freeze({
  /** Measured stone RMS minus concrete RMS, dB. §3.9 predicts about +1.2. */
  measuredDeltaDb: -0.66,
  tol: 1.0,
  why: 'A dB of slack: the claim is the sign of the gap, not its size. Tighten it the day '
    + 'somebody actually tunes the modal gains to honour the multiplier.',
});

// ---------------------------------------------------------------------------
// The Halo hum (§3.8)

/**
 * The Halo's radius → pitch calibration: audible radius in metres against the hum's fundamental.
 *
 * §3.8 is non-negotiable about the player always knowing how loud they are, and pitch is the
 * readout. These three rows are the three movement tiers of §3.3 read through
 * `probeVoices.humPitch`: crouch (2 m), walk (11 m), sprint (24 m).
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
