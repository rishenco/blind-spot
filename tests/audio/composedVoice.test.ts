/**
 * The composed contact — two bodies, two rows, one sound.
 *
 * §3.9 gives every *surface* a voice. A thrown object is the first event in the game where the
 * surface is only half the answer: a can hitting a steel walkway is the can's strike and the
 * walkway's ring, and a voice that took both halves from one material would make every impact
 * sound like the floor (you could not tell what was thrown) or like the object (you could not
 * tell where it landed). `contactVoice` therefore selects two rows — `spec.objMat` drives the
 * exciter, the scuff and the thump; `spec.mat` drives the modal bank — and this file is what
 * says those two wires are the right way round.
 *
 * **Why that needs a test at all.** Swapping the two selectors is a one-character edit that
 * changes no level, no duration, no class table and no pinned fingerprint: every material still
 * appears in every sound, just in the wrong half of it. Nothing else in the suite can see it.
 * So the two assertions this file exists for are directional by construction. `rings for the
 * surface, not for the thing that struck it` reads +32.9 dB and, wired backwards, −32.9;
 * `carries what struck the ... floor into the attack` reads +396 Hz and, wired backwards, −30.
 * The second is also the one that survives the milder mutation of ignoring `objMat` altogether,
 * which leaves every ring correct and collapses that gap to 0.000 Hz.
 *
 * **And why nothing else in the suite moved.** `spec.objMat` is `null` for every event the game
 * emits today, and a null resolves both selectors to the same row and the norm branch to the
 * same float. `renders %s the same whether or not the object names it` is that claim as one
 * assertion; the rest of the suite re-rendering unchanged is the same claim measured everywhere
 * else at once — wiring the composition backwards fails twelve tests in this file and not one
 * anywhere else.
 *
 * The impact class does not exist yet — it arrives with the throwable, along with its row in
 * `AUDIO_CLASS_VOICES` and the bus arithmetic that pairs two materials into one carry radius.
 * Until then this file renders that class's *shape* by hand from a director-built spec, the way
 * `voices.test.ts` renders a halved gain: `COMPOSED_NORM_FIT_BRIGHT` is the brightness the twelve
 * off-diagonal norms were fitted at, and the day a class carries a composed contact it owes an
 * assertion that its `bright` is still that number.
 *
 * Pins live here rather than in `tests/support/audioSpec.ts` for one commit only: the whole
 * verification story of the seam is that not a single existing test file was touched. They move
 * to the pinned table with the class.
 */

import { describe, expect, it } from 'vitest';
import {
  centroidHz,
  hasNaN,
  peakInfo,
  rmsDb,
  tailDb,
  type AudioBufferLike,
} from '../support/audioMetrics';
import {
  ATTACK_LEVEL_SAMPLE,
  MATERIAL_LOUDNESS_LAW,
  MAX_PEAK_DBFS,
  RING_TAIL_WINDOW,
} from '../support/audioSpec';
import { renderOffline } from '../support/audioRender';
import {
  ATTACK_WINDOW_SEC,
  COMPOSED_ATTACK_NORMS,
  COMPOSED_NORM_FIT_BRIGHT,
  MATERIAL_ATTACK_NORMS,
  NOISE_SLOTS,
  contactVoice,
} from '../../src/audio/voices';
import { AudioDirector, type ListenerState, type VoiceSpec } from '../../src/audio/director';
import { MATERIAL_NAMES } from '../../src/paint/materials';
import { PLAYER_EMITTER_ID, SoundBus } from '../../src/paint/soundEvents';

/** The render conditions every number below was measured under. */
const STRIKE_AT = ATTACK_LEVEL_SAMPLE.firstAtSec;
const RENDER_SECONDS = 1;

/**
 * The noise slice the timbre renders read — fixed, and the same one `materialVoices.test.ts`
 * fingerprints with, so the two files are looking at the same slice of the bank.
 */
const FINGERPRINT_SEED = 11;

/** Close enough to be inside `NEAR_FIELD_M`, so gain is the class's full near-field level. */
const LISTENER: ListenerState = { x: 0, y: 0, z: 0, range: 40, emitter: PLAYER_EMITTER_ID };

const MATERIALS = ['concrete', 'metal', 'stone', 'dust'] as const;
type Material = (typeof MATERIALS)[number];

/** The three materials with no ring worth the name — everything except metal (§3.9). */
const DULL = ['concrete', 'stone', 'dust'] as const;

const indexOf = (mat: Material): number => MATERIAL_NAMES.indexOf(mat);

/**
 * The shape of a thrown thing's first contact, on a spec the director actually built.
 *
 * Only the class shaping is the test's — `bright`, `toneHz` and `durationSec`, which are the row
 * the impact class will carry — plus the seed and the two materials. Level is left exactly where
 * the director put it, and left there *unchanged across all sixteen pairs*: this file measures
 * timbre, and holding the gain still is what makes a difference between two renders a difference
 * of composition rather than of loudness. The loudness half of the law has its own block below.
 */
function impactSpec(obj: Material | null, surf: Material, seed = FINGERPRINT_SEED): VoiceSpec {
  const bus = new SoundBus();
  const event = bus.emit({
    class: 'walk-step',
    x: 0,
    y: 0,
    z: 0,
    mat: indexOf('concrete'),
    source: 'player',
    emitter: PLAYER_EMITTER_ID,
  });
  const spec = new AudioDirector(LISTENER).decide(event);
  if (spec === null) throw new Error('impactSpec: the listener at the origin heard nothing');
  return {
    ...spec,
    mat: indexOf(surf),
    objMat: obj === null ? null : indexOf(obj),
    bright: COMPOSED_NORM_FIT_BRIGHT,
    toneHz: 200,
    durationSec: 0.8,
    seed,
  };
}

const renderSpec = (spec: VoiceSpec): Promise<AudioBufferLike> =>
  renderOffline(RENDER_SECONDS, (ctx, master) => {
    contactVoice(ctx, master, spec, STRIKE_AT);
  });

/** All sixteen pairs rendered once, so the whole file measures the same buffers. */
const rendered = new Map<string, AudioBufferLike>();
for (const obj of MATERIALS) {
  for (const surf of MATERIALS) {
    rendered.set(`${obj}/${surf}`, await renderSpec(impactSpec(obj, surf)));
  }
}
const pair = (obj: Material, surf: Material): AudioBufferLike => rendered.get(`${obj}/${surf}`)!;

/** How much sound is left 150–300 ms after the strike — the surface's signature (§3.9). */
const ring = (obj: Material, surf: Material): number =>
  tailDb(pair(obj, surf), RING_TAIL_WINDOW.fromSec, RING_TAIL_WINDOW.toSec);

/**
 * Spectral centroid of the *attack* — the 85 ms that answer "what hit it".
 *
 * Deliberately not `BODY_WINDOW`, which the material fingerprints use: by 250 ms a ringing
 * surface has swamped whatever struck it, and the object's contribution is the strike.
 */
const strikeBright = (obj: Material, surf: Material): number =>
  centroidHz(pair(obj, surf), STRIKE_AT, STRIKE_AT + ATTACK_WINDOW_SEC);

// ---------------------------------------------------------------------------
// The pins

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
const RINGING_TAIL_FLOOR_DBFS = -80;

/**
 * Below this, the surface has stopped, dBFS. Measured worst (loudest) dull pair: −99.4.
 *
 * 9.4 dB of margin, and the gap between the two constants is 10 dB of no-man's land that no
 * measured pair is anywhere near — which is what stops a modest retune from making the partition
 * ambiguous instead of failing it.
 */
const DULL_TAIL_CEILING_DBFS = -90;

/**
 * The least a struck metal surface may out-ring a struck dull one, dB, at the same object.
 *
 * Measured minimum over the four objects is 32.0 dB (a metal object, metal floor against
 * concrete floor); the largest is 37.9. This is `MIN_METAL_TAIL_SEPARATION_DB`'s claim asked of
 * the composed voice, and pinned lower than its 35 for one reason: at the composed shape the
 * *object* row also feeds the bank, so the same surface separation is worth a few dB less when a
 * dull object is doing the driving. 25 keeps 7 dB of headroom under the worst measured pair.
 */
const MIN_SURFACE_TAIL_SEPARATION_DB = 25;

/**
 * The most the *object* may move the ring on a fixed surface, dB.
 *
 * The other half of "the ring belongs to the floor": on steel, the four objects ring within
 * 6.0 dB of each other — the object drives the bank harder or softer, it does not decide whether
 * the bank rings at all. 15 is 2.5× that. Wired backwards this reads 34.5 dB, because it becomes
 * the *surface* spread measured under the object's name.
 */
const MAX_OBJECT_TAIL_SPREAD_DB = 15;

/**
 * The least a dust object must out-brighten a concrete one on the same dull floor, Hz.
 *
 * Measured 396 Hz on concrete, 411 on stone, 725 on dust. It is the scuff: dust's exciter is the
 * softest in the table (1100 Hz against concrete's 3200) but almost all of it is heard directly
 * — `scuff` 0.9 against 0.25 — where concrete's is mostly spent driving modes that sit below it.
 * So a handful of grit reads *brighter* on the attack than a lump of concrete, which is the same
 * "brightness is a scuff-versus-ring axis, not a hardness axis" finding `materialVoices.test.ts`
 * records, arriving here as the object axis.
 *
 * 250 leaves 146 Hz of margin on the tightest of the three, which is inside the ±100–150 Hz
 * tolerances the material centroids already carry. Ignore `objMat` in the voice and this
 * collapses to exactly 0 on all three floors, which is the mutation this number exists for.
 */
const MIN_OBJECT_CENTROID_GAP_HZ = 250;

// ---------------------------------------------------------------------------

describe('the composed norm table', () => {
  it('is square, complete, and positive', () => {
    expect(COMPOSED_ATTACK_NORMS).toHaveLength(MATERIAL_NAMES.length);
    for (const row of COMPOSED_ATTACK_NORMS) {
      expect(row).toHaveLength(MATERIAL_NAMES.length);
      for (const cell of row) {
        expect(Number.isFinite(cell)).toBe(true);
        expect(cell).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The diagonal is the shipped four *by reference*, and `toBe` is the assertion that says so.
   *
   * Not `toBeCloseTo`, not a copy of the literals: a composed contact between two bodies of the
   * same material is a single-material contact, and its norm has to be the identical float a
   * footfall on that surface uses. A copied diagonal would be a second home for the number every
   * step in the game is levelled by — and the day a refit moved one of the two, every footfall
   * would get quietly louder while `MATERIAL_ATTACK_NORMS`, which is what §3.9's loudness law is
   * asserted against, still read the old value. This is the assertion that makes that
   * unavailable, and it is why `COMPOSED_ATTACK_NORMS` is built rather than written out.
   */
  it.each(MATERIALS)('takes %s\'s diagonal cell from the shipped attack norm, exactly', (mat) => {
    const i = indexOf(mat);
    expect(COMPOSED_ATTACK_NORMS[i]![i]).toBe(MATERIAL_ATTACK_NORMS[i]);
  });

  /**
   * Why the table is twelve fitted numbers and not two rows of four, checked rather than
   * asserted in a comment.
   *
   * The separable model is `norm(o, s) = norm(o, concrete) × norm(concrete, s)` — four fitted
   * values composed into sixteen — and it is the shape anyone would reach for first. It fails
   * because the modal bank is *fed by* the exciter, so the attack window sums energy from both
   * rows at once rather than scaling one by the other. The worst cell is dust on dust at
   * 3.09 dB and the worst off-diagonal is dust on metal at 2.07 dB, against a loudness budget of
   * half a decibel: dust is nearly all scuff, and how much of that scuff survives the window
   * depends entirely on what it is driving.
   *
   * Pinned as "misses by more than four times the whole tolerance" rather than at a value,
   * because the number is a property of the voices and will move with any modal retune. What
   * must not move is that it is far too large to factorize away.
   */
  it('cannot be factorized into one norm per material', () => {
    let worst = 0;
    let where = '';
    for (const obj of MATERIALS) {
      for (const surf of MATERIALS) {
        const o = indexOf(obj);
        const s = indexOf(surf);
        const separable =
          COMPOSED_ATTACK_NORMS[o]![indexOf('concrete')]! *
          COMPOSED_ATTACK_NORMS[indexOf('concrete')]![s]!;
        const errorDb = Math.abs(20 * Math.log10(COMPOSED_ATTACK_NORMS[o]![s]! / separable));
        if (errorDb > worst) {
          worst = errorDb;
          where = `${obj} on ${surf}`;
        }
      }
    }
    expect(worst, `worst separable error is ${worst.toFixed(3)} dB at ${where}`).toBeGreaterThan(
      4 * MATERIAL_LOUDNESS_LAW.toleranceDb,
    );
  });
});

// ---------------------------------------------------------------------------

describe('objMat === null is the single-material voice', () => {
  /**
   * The seam's whole verification story in one assertion, and the diagonal-by-reference norm's
   * as well: naming the surface as the striking body must render the same samples as naming no
   * striking body at all. Both selectors resolve to the same row either way, and the norm branch
   * — which is a *different* branch in the two cases — takes the same float, because the table's
   * diagonal is that float.
   *
   * Bit-identity rather than a tolerance, for the reason `the offline render` gives: two renders
   * of the same graph that differed at all would make every pinned number in the audio suite a
   * number that was true once.
   */
  it.each(MATERIALS)('renders %s the same whether or not the object names it', async (mat) => {
    const nulled = await renderSpec(impactSpec(null, mat));
    const explicit = await renderSpec(impactSpec(mat, mat));
    expect(nulled.length).toBe(explicit.length);
    let differing = 0;
    for (let c = 0; c < nulled.numberOfChannels; c++) {
      const a = nulled.getChannelData(c);
      const b = explicit.getChannelData(c);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
    }
    expect(differing).toBe(0);
    // And it is not the trivially-equal case of two silent renders.
    expect(rmsDb(nulled, undefined, STRIKE_AT, 0.3)).toBeGreaterThan(-60);
  });

  /**
   * The same identity at a material the table does not have.
   *
   * `contactVoice` resolves an unknown index to concrete — the choice `materialLoudness` already
   * makes, so that the two halves of "unknown material" agree instead of one of them crashing
   * mid-stride. The hazard the composed voice adds is that the *norm* is looked up by index too:
   * a row selector that fell back to concrete while the norm lookup did not would pair concrete's
   * modes with some other material's level, silently and only for bad data.
   */
  it('answers an unknown material with the ordinary surface, in both halves', async () => {
    const known = impactSpec(null, 'concrete');
    const strange = await renderSpec({ ...known, mat: 99, objMat: 99 });
    const alsoStrange = await renderSpec({ ...known, mat: 99, objMat: null });
    const ordinary = await renderSpec(known);
    expect(hasNaN(strange)).toBe(false);
    const reference = ordinary.getChannelData(0);
    for (const buffer of [strange, alsoStrange]) {
      const data = buffer.getChannelData(0);
      let differing = 0;
      for (let i = 0; i < data.length; i++) if (data[i] !== reference[i]) differing++;
      expect(differing).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the composition is directional', () => {
  /** The usual first assertion: a poisoned render answers most metrics with `NaN`. */
  it.each(MATERIALS)('renders every pair on %s finite and with headroom', (surf) => {
    for (const obj of MATERIALS) {
      const buffer = pair(obj, surf);
      expect(hasNaN(buffer), `${obj} on ${surf}`).toBe(false);
      const peak = peakInfo(buffer);
      expect(peak.clipped, `${obj} on ${surf}`).toBe(false);
      expect(peak.peakDb, `${obj} on ${surf}`).toBeLessThan(MAX_PEAK_DBFS);
    }
  });

  /**
   * **The ring belongs to the floor.** The named catcher for the wires being crossed.
   *
   * Concrete thrown at steel rings at −67.4 dBFS 150–300 ms after the strike; steel thrown at
   * concrete is at −100.3. Swap the two row selectors in `contactVoice` and the two numbers swap
   * with them, so this reads −32.9 dB instead of +32.9 and fails by 58 dB. It is also what fails
   * if the modal bank is ever fed from the object — "everything from the can" — which would be
   * the same mistake made in one direction only.
   */
  it('rings for the surface, not for the thing that struck it', () => {
    const onSteel = ring('concrete', 'metal');
    const onConcrete = ring('metal', 'concrete');
    expect(
      onSteel - onConcrete,
      `concrete on metal ${onSteel.toFixed(1)} dBFS, metal on concrete ${onConcrete.toFixed(1)}`,
    ).toBeGreaterThan(MIN_SURFACE_TAIL_SEPARATION_DB);
    expect(onSteel).toBeGreaterThan(RINGING_TAIL_FLOOR_DBFS);
    expect(onConcrete).toBeLessThan(DULL_TAIL_CEILING_DBFS);
  });

  /**
   * The same claim over the whole table rather than at one pair: whatever is thrown, a steel
   * floor rings and a dull one does not.
   *
   * This is the assertion M2 actually plays. The one prop that ships is a metal can, so the live
   * row of the norm table in game is `obj = metal` — and the player-facing promise is that
   * throwing it *reports the floor it hit*: a can that rang the same everywhere would be a probe
   * that answers with itself, which is the opposite of what a thrown probe is for.
   */
  it.each(MATERIALS)('lets a %s object report the floor it hit, not itself', (obj) => {
    expect(ring(obj, 'metal'), `${obj} on metal`).toBeGreaterThan(RINGING_TAIL_FLOOR_DBFS);
    for (const surf of DULL) {
      expect(ring(obj, surf), `${obj} on ${surf}`).toBeLessThan(DULL_TAIL_CEILING_DBFS);
      expect(
        ring(obj, 'metal') - ring(obj, surf),
        `${obj}: metal floor vs ${surf} floor`,
      ).toBeGreaterThan(MIN_SURFACE_TAIL_SEPARATION_DB);
    }
  });

  /**
   * And the object may season the ring but never own it: on steel, all four objects ring within
   * 6.0 dB of each other. Wired backwards this is the surface spread wearing the object's name
   * and reads 34.5 dB.
   */
  it('lets the object drive the ring without deciding it', () => {
    const tails = MATERIALS.map((obj) => ring(obj, 'metal'));
    expect(
      Math.max(...tails) - Math.min(...tails),
      `object spread on steel: ${tails.map((t) => t.toFixed(1)).join(', ')} dBFS`,
    ).toBeLessThan(MAX_OBJECT_TAIL_SPREAD_DB);
  });

  /**
   * **The strike belongs to the can.** The object-axis catcher, and the one that survives the
   * milder mutation.
   *
   * Ignoring `objMat` altogether — taking the whole voice from the surface — leaves every ring
   * assertion above passing, because the rings were always the surface's. What it destroys is
   * this: on the same dull floor, a dust clod and a lump of concrete arrive 396 Hz apart in the
   * attack, and under that mutation they arrive at the identical number.
   *
   * Measured on the dull floors only, and that is the honest limit of the axis rather than a
   * convenience: on steel the surface's own modes ring *inside* the 85 ms attack window and the
   * four objects land within 212 Hz of each other. The object is legible on dull ground and
   * nearly mute on a ringing floor — nobody should expect to identify a thrown thing by ear on
   * a steel walkway.
   */
  it.each(DULL)('carries what struck the %s floor into the attack', (surf) => {
    const grit = strikeBright('dust', surf);
    const lump = strikeBright('concrete', surf);
    expect(
      grit - lump,
      `on ${surf}: dust object ${grit.toFixed(0)} Hz, concrete object ${lump.toFixed(0)} Hz`,
    ).toBeGreaterThan(MIN_OBJECT_CENTROID_GAP_HZ);
  });
});

// ---------------------------------------------------------------------------

/**
 * §3.9's loudness law, generalized to two bodies.
 *
 * The law is that the material *multiplier* is the only thing that makes one contact louder than
 * another — so everything else about a material, timbre and decay included, has to arrive at the
 * same level. For a single body that is the four `attackNorm`s. For a pair it is the sixteen
 * cells of `COMPOSED_ATTACK_NORMS`, and the claim is the same one: at equal gain, all sixteen
 * pairs deliver the same attack level, and the loudness difference between a can on steel and a
 * can on dust is left entirely to the multiplier the bus will apply.
 *
 * The multiplier half is not asserted here because it does not exist yet — the composed carry
 * radius is the bus's, and it lands with the impact class. What is here is the half that lives
 * in the synthesis, and it is the half that has to be true first: if the voices did not level
 * themselves, no arithmetic on the bus could make them.
 *
 * Same estimator as `materialVoices.test.ts`, deliberately: `ATTACK_LEVEL_SAMPLE.strikes`
 * stratified across the bank, power-meaned, over `ATTACK_WINDOW_SEC`. A block that invented its
 * own sample would be measuring a distribution the shipped code does not have — and the twelve
 * off-diagonal norms were fitted by exactly this estimator, so this is a regression pin at birth
 * rather than an independent measurement. That circularity is the same one the four shipped
 * norms carry, and it is worth stating: what is *not* circular is the diagonal, which was fitted
 * at the walk shape and is measured here at `COMPOSED_NORM_FIT_BRIGHT`.
 */
const SAMPLE_SEEDS: readonly number[] = Array.from(
  { length: ATTACK_LEVEL_SAMPLE.strikes },
  (_, i) => Math.round((i * NOISE_SLOTS) / ATTACK_LEVEL_SAMPLE.strikes),
);

/** A power mean, not a mean of decibels — see `materialVoices.test.ts` for why that matters. */
const powerMeanDb = (levels: readonly number[]): number =>
  10 * Math.log10(levels.reduce((sum, db) => sum + 10 ** (db / 10), 0) / levels.length);

async function attackDb(obj: Material, surf: Material): Promise<number> {
  const { firstAtSec, spacingSec, strikesPerRender } = ATTACK_LEVEL_SAMPLE;
  const out: number[] = [];
  for (let from = 0; from < SAMPLE_SEEDS.length; from += strikesPerRender) {
    const chunk = SAMPLE_SEEDS.slice(from, from + strikesPerRender);
    const buffer = await renderOffline(firstAtSec + spacingSec * chunk.length, (ctx, master) => {
      chunk.forEach((seed, i) => {
        contactVoice(ctx, master, impactSpec(obj, surf, seed), firstAtSec + spacingSec * i);
      });
    });
    chunk.forEach((_, i) => {
      const at = firstAtSec + spacingSec * i;
      out.push(rmsDb(buffer, undefined, at, at + ATTACK_WINDOW_SEC));
    });
  }
  return powerMeanDb(out);
}

const sampled = new Map<string, number>();
for (const obj of MATERIALS) {
  for (const surf of MATERIALS) sampled.set(`${obj}/${surf}`, await attackDb(obj, surf));
}
const attackReference = sampled.get('concrete/concrete')!;

describe('the sixteen pairs all arrive at one level', () => {
  /**
   * Every pair, against the reference pair, at the same gain.
   *
   * The twelve off-diagonals land at 0.000 dB, which is what fitting them by this estimator
   * buys. The three non-trivial diagonals do not, and that is the price of taking them from
   * `MATERIAL_VOICES` by reference instead of refitting them at this shape: metal reads
   * −0.097 dB, stone −0.016 and dust +0.262, which is the same `bright` leak
   * `BRIGHT_LEAK_MAX_DB` bounds elsewhere — the norms were fitted at a walk's 1.0 and are being
   * measured at 1.45. All three are inside §3.9's own half-decibel budget, and buying them back
   * would move the level of every footstep in the game to save at most a quarter of a decibel on
   * a sound nothing emits yet.
   */
  it.each(MATERIALS)('levels every object thrown at %s', (surf) => {
    for (const obj of MATERIALS) {
      const residual = sampled.get(`${obj}/${surf}`)! - attackReference;
      expect(
        Math.abs(residual),
        `${obj} on ${surf}: ${residual.toFixed(3)} dB from concrete on concrete`,
      ).toBeLessThanOrEqual(MATERIAL_LOUDNESS_LAW.toleranceDb);
    }
  });

  /**
   * And the diagonal specifically, because it is the one place a *measured* number could move
   * without any test in this file changing: the diagonal cells are shared with the footfall, so
   * a residual growing here is the leak growing, and the leak is what would eventually make
   * refitting them at the composed shape the right call. Recorded at the tighter of the two
   * bounds so it is noticed while it is still cheap.
   */
  it.each(MATERIALS)('keeps %s on itself inside the bright leak', (mat) => {
    const residual = sampled.get(`${mat}/${mat}`)! - attackReference;
    expect(
      Math.abs(residual),
      `${mat} on ${mat}: ${residual.toFixed(3)} dB, fitted at a walk and measured at ` +
        `bright ${COMPOSED_NORM_FIT_BRIGHT}`,
    ).toBeLessThanOrEqual(MATERIAL_LOUDNESS_LAW.toleranceDb);
  });
});
