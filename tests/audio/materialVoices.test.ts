/**
 * The two-axis material fingerprint — and the two findings that shaped it.
 *
 * §3.9 makes a promise the game leans on hard: "the spider's footfalls carry the material they
 * strike, so its voice tells you what it is walking on and therefore *where it is* — a change of
 * timbre mid-stride is a change of surface". That is not flavour text. It is a *tracking
 * mechanic*: in a world that is black, the timbre of a footfall is a coordinate. So there has to
 * be a number that says whether two materials are still telling themselves apart, and the number
 * has to be the right one.
 *
 * **Finding 1: the obvious axis is a trap twice over.** Spectral centroid — brightness — looks
 * like the material axis and is not.
 *
 *  1. The M1 audio prototype measured metal at 2713 Hz and stone at 2756 Hz and concluded that
 *     centroid cannot separate them. Re-measured with a windowed FFT (`tests/audio/metrics.test.ts`
 *     shows why that matters) the same two sounds read 1240.7 Hz and 410.6 Hz — the near-equality
 *     was the prototype's *unwindowed* DFT measuring its own leakage skirt, not the sounds. So
 *     the literal claim was false, and believing it would have thrown away a usable axis.
 *  2. But the conclusion it was used to justify survives, for a better reason: centroid does not
 *     **order** the materials. Dust reads 618 Hz — brighter than stone (411) and concrete (314)
 *     — because dust is nearly all broadband exciter and has almost no low modes to weigh it
 *     down. Brightness is a "scuff versus ring" axis, not a hardness axis. The prototype's own
 *     harness printed `centroid ordering dust<concrete<stone<metal: PASS`, and that ordering was
 *     a coincidence of the leakage that would have been pinned and defended.
 *
 * What actually separates them is the **ring tail**: how much sound is left 150–300 ms after the
 * strike. Metal sits at −60.4 dBFS there; stone, its nearest neighbour, at −99.5. A 39 dB gap,
 * from metal's 0.30–0.38 s modes against everyone else's 0.04–0.14 s. That is the assertion
 * shape every later material commit should copy: **pin the tail tightly because it is the
 * design, pin the centroid as a coarse partition because that is all it can carry.**
 *
 * **Finding 2: one render cannot measure a material.** The exciter reads a slice of a seeded
 * noise bank, and a single strike's level lands 2–6 dB from its own mean depending on which
 * slice it got. So this file measures two different things two different ways. The fingerprint —
 * timbre — is one render, because timbre is a shape and a shape is stable. The loudness law of
 * §3.9 is a *sample* of many strikes spread across the bank, because loudness is an expectation.
 * `ATTACK_LEVEL_SAMPLE` says why in full — including how many strikes "many" is and how that was
 * measured — and the first test of the last describe block demonstrates the trap rather than
 * asserting around it.
 *
 * Everything here renders the shipped voices — `src/audio/voices.ts`, through the real
 * `AudioDirector`, on real `SoundBus` events. The fixture these numbers used to come from is
 * gone.
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
  ATTACK_LEVEL_SAMPLE,
  BODY_WINDOW,
  BRIGHT_LEAK_MAX_DB,
  CENTROID_SPLIT_HZ,
  MATERIAL_FINGERPRINTS,
  MATERIAL_LOUDNESS_LAW,
  MAX_PEAK_DBFS,
  MIN_METAL_TAIL_SEPARATION_DB,
  RING_TAIL_WINDOW,
  type PinnedMaterial,
} from '../support/audioSpec';
import { renderOffline } from '../support/audioRender';
import {
  ATTACK_WINDOW_SEC,
  MATERIAL_ATTACK_NORMS,
  NOISE_SLOTS,
  playVoice,
} from '../../src/audio/voices';
import {
  AUDIO_CLASS_VOICES,
  AudioDirector,
  isContactVoice,
  type ListenerState,
  type VoiceSpec,
} from '../../src/audio/director';
import { MATERIAL_NAMES, materialLoudness } from '../../src/paint/materials';
import {
  PLAYER_EMITTER_ID,
  SOUND_CLASSES,
  SoundBus,
  type SoundClass,
} from '../../src/paint/soundEvents';

/** The one render conditions every pinned number in `audioSpec.ts` was measured under. */
const STRIKE_AT = ATTACK_LEVEL_SAMPLE.firstAtSec;
const RENDER_SECONDS = 1;

/**
 * Which noise slice the fingerprint renders read.
 *
 * Fixed rather than left to the bus's sequence number, because a fingerprint pinned to whatever
 * `seq` a neighbouring test happened to leave behind is a number that moves when an unrelated
 * file is edited. It is the *only* field this test overrides on a director-built spec.
 */
const FINGERPRINT_SEED = 11;

/** Close enough to be inside `NEAR_FIELD_M`, so gain is the class's full near-field level. */
const LISTENER: ListenerState = { x: 0, y: 0, z: 0, range: 40, emitter: PLAYER_EMITTER_ID };

/** The pinned table's materials, in the order the file reads best. */
const MATERIALS = ['dust', 'concrete', 'stone', 'metal'] as const;

/** Every class that strikes a surface, from the sound table rather than from a second list. */
const STANCES: readonly SoundClass[] = (Object.keys(SOUND_CLASSES) as SoundClass[]).filter(
  isContactVoice,
);

const indexOf = (mat: PinnedMaterial): number => MATERIAL_NAMES.indexOf(mat);

/**
 * One spec, built the way the game builds it: a real emit on a real bus, decided by the real
 * director, at the near field. Only the seed is the test's — see `FINGERPRINT_SEED`.
 *
 * Nothing here hand-writes a `VoiceSpec`. A spec invented by the test would let the synthesis
 * pass against a level the director never produces, which is precisely the claim §3.9 makes:
 * the level is the carry radius, and the carry radius already carries the material.
 */
function specFor(cls: SoundClass, mat: PinnedMaterial, seed: number): VoiceSpec {
  const bus = new SoundBus();
  const event = bus.emit({
    class: cls,
    x: 0,
    y: 0,
    z: 0,
    mat: indexOf(mat),
    source: 'player',
    emitter: PLAYER_EMITTER_ID,
  });
  const spec = new AudioDirector(LISTENER).decide(event);
  if (spec === null) throw new Error(`specFor('${cls}'): the listener at the origin heard nothing`);
  return { ...spec, seed };
}

function strike(mat: PinnedMaterial): Promise<AudioBufferLike> {
  return renderOffline(RENDER_SECONDS, (ctx, master) => {
    playVoice(ctx, master, specFor('walk-step', mat, FINGERPRINT_SEED), STRIKE_AT);
  });
}

/** Every material rendered once, so the whole file measures the same four buffers. */
const rendered = new Map<PinnedMaterial, AudioBufferLike>();
for (const mat of MATERIALS) rendered.set(mat, await strike(mat));

const ring = (mat: PinnedMaterial): number =>
  tailDb(rendered.get(mat)!, RING_TAIL_WINDOW.fromSec, RING_TAIL_WINDOW.toSec);
const bright = (mat: PinnedMaterial): number =>
  centroidHz(rendered.get(mat)!, BODY_WINDOW.fromSec, BODY_WINDOW.toSec);
const body = (mat: PinnedMaterial): number =>
  rmsDb(rendered.get(mat)!, undefined, BODY_WINDOW.fromSec, BODY_WINDOW.toSec);

// ---------------------------------------------------------------------------
// The attack-level sample (§3.9's loudness law)

/**
 * The seeds, stratified across the whole noise bank.
 *
 * `Math.round(i * NOISE_SLOTS / strikes)` and not `i`: consecutive seeds map to bank offsets
 * ~1.3 ms apart while the attack window is 85 ms, so consecutive seeds read ~98 % the same audio
 * and are barely one measurement.
 *
 * That is measurable rather than theoretical, and the measurement is the reason this line is
 * not the obvious one. Sixteen consecutive seeds put metal's walk residual at −0.78 dB from
 * seed 200, +0.62 dB from seed 800, and a stance at 1.01 dB from seed 500 — outside both
 * tolerances. From seed 0 they land at −0.16 dB and the suite passes, which is the trap: the
 * simplification looks fine exactly where somebody would try it.
 *
 * Stratifying is necessary and was not sufficient: `ATTACK_LEVEL_SAMPLE.strikes` carries the
 * measurement of how many stratified strikes it takes before the estimator stops contributing.
 *
 * `NOISE_SLOTS` comes from `voices.ts` rather than being re-declared here, because a test that
 * invented its own slot count would be sampling a distribution the code does not have.
 */
const SAMPLE_SEEDS: readonly number[] = Array.from(
  { length: ATTACK_LEVEL_SAMPLE.strikes },
  (_, i) => Math.round((i * NOISE_SLOTS) / ATTACK_LEVEL_SAMPLE.strikes),
);

/**
 * The attack level of each strike in one sample, dBFS.
 *
 * Rendered in chunks of `strikesPerRender` rather than all at once, which is a cost decision and
 * nothing else — see that field for the measurement, both of what it saves and of the thing it
 * could have changed and does not.
 */
async function attackLevels(cls: SoundClass, mat: PinnedMaterial): Promise<number[]> {
  const { firstAtSec, spacingSec, strikesPerRender } = ATTACK_LEVEL_SAMPLE;
  const out: number[] = [];
  for (let from = 0; from < SAMPLE_SEEDS.length; from += strikesPerRender) {
    const chunk = SAMPLE_SEEDS.slice(from, from + strikesPerRender);
    const buffer = await renderOffline(firstAtSec + spacingSec * chunk.length, (ctx, master) => {
      chunk.forEach((seed, i) => {
        playVoice(ctx, master, specFor(cls, mat, seed), firstAtSec + spacingSec * i);
      });
    });
    chunk.forEach((_, i) => {
      const at = firstAtSec + spacingSec * i;
      out.push(rmsDb(buffer, undefined, at, at + ATTACK_WINDOW_SEC));
    });
  }
  return out;
}

/**
 * The expected level of a sample, dB — a power mean, not a mean of decibels.
 *
 * Averaging decibels averages logarithms, which biases the answer low by roughly the variance:
 * the loud strikes that carry most of the energy are compressed into the mean while the quiet
 * ones are stretched. The mean of squared amplitude is the physical quantity, and it is what
 * "how loud is this material, typically" means.
 *
 * Do not "simplify" this to a mean of decibels. It used to be the case that nothing here would
 * stop you: swapping it left every render-backed test in this file passing, because the bias is
 * smaller than the tolerance and not because it is absent — the converged worst residual goes
 * from 0.359 dB to 0.611 dB, all of it on dust, since the bias scales with a material's spread
 * and dust has the widest. That is a quarter of §3.9's half-decibel budget spent on an estimator
 * being wrong, which is exactly what raising the strike count was meant to stop paying for.
 *
 * The last block in this file now catches it, in arithmetic rather than in a render — see "the
 * power mean is the estimator". The bias was always too small for a tolerance to see; the fix
 * was to stop asking a tolerance and check the definition instead.
 */
const powerMeanDb = (levels: readonly number[]): number =>
  10 * Math.log10(levels.reduce((sum, db) => sum + 10 ** (db / 10), 0) / levels.length);

const sampled = new Map<string, number[]>();
for (const cls of STANCES) {
  for (const mat of MATERIALS) sampled.set(`${cls}/${mat}`, await attackLevels(cls, mat));
}
const levels = (cls: SoundClass, mat: PinnedMaterial): number[] => sampled.get(`${cls}/${mat}`)!;
const attackDb = (cls: SoundClass, mat: PinnedMaterial): number => powerMeanDb(levels(cls, mat));

/** What §3.9 promises this material's level to be, relative to concrete, in dB. */
const promisedDb = (mat: PinnedMaterial): number => 20 * Math.log10(materialLoudness(indexOf(mat)));

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
  it.each(MATERIALS)('renders %s finite, with headroom, and centred', (mat) => {
    const buffer = rendered.get(mat)!;
    expect(hasNaN(buffer)).toBe(false);
    const peak = peakInfo(buffer);
    expect(peak.clipped).toBe(false);
    expect(peak.peakDb).toBeLessThan(MAX_PEAK_DBFS);
    // The strike is the loudest thing in its own render, and it happens when it was scheduled.
    expect(peak.peakAtSec).toBeGreaterThanOrEqual(STRIKE_AT);
    expect(peak.peakAtSec).toBeLessThan(STRIKE_AT + 0.02);
    // No panner in this graph yet, so any imbalance would be a bug rather than a choice — and
    // would quietly bias every mixdown-based number in the table.
    expect(stereoEnergyRatio(buffer)).toBeCloseTo(1, 6);
  });

  /**
   * The pinned table and the game's material table are the same set.
   *
   * Without this, adding a fifth material to `paint/materials` leaves this file measuring four
   * of five and passing — the failure mode where the new surface is the only one nobody checked.
   */
  it('fingerprints exactly the materials the game has', () => {
    expect([...MATERIALS].sort()).toEqual([...MATERIAL_NAMES].sort());
    expect(Object.keys(MATERIAL_FINGERPRINTS).sort()).toEqual([...MATERIAL_NAMES].sort());
    expect(MATERIAL_ATTACK_NORMS).toHaveLength(MATERIAL_NAMES.length);
    // Concrete is the reference the other three are stated against, so its normalization is 1
    // exactly. If it were fitted like the others, "relative to concrete" would mean nothing.
    expect(MATERIAL_ATTACK_NORMS[indexOf('concrete')]).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('axis 1: the ring tail (the discriminator)', () => {
  it.each(MATERIALS)('%s rings for as long as it is pinned to', (mat) => {
    const pin = MATERIAL_FINGERPRINTS[mat].ringTailDb;
    expect(Math.abs(ring(mat) - pin.value), pin.why).toBeLessThanOrEqual(pin.tol);
  });

  /**
   * The load-bearing assertion of the whole material system.
   *
   * Measured separation to metal's nearest neighbour is 39.1 dB; the pin demands 35, leaving
   * ~4 dB of tuning headroom. This is what "a surface's material is audible" reduces to, and it
   * is what a centroid-ordering test would have replaced: the voices could decay into mush and
   * a brightness assertion would still pass.
   */
  it('puts metal more than 35 dB above every other material', () => {
    const metal = ring('metal');
    for (const mat of MATERIALS) {
      if (mat === 'metal') continue;
      expect(metal - ring(mat), `metal vs ${mat}`).toBeGreaterThan(MIN_METAL_TAIL_SEPARATION_DB);
    }
  });

  /**
   * And the honest limit of the axis, pinned so nobody over-reads it: the tail separates metal
   * from everything, and separates nothing else from anything. Dust, concrete and stone all sit
   * within ~5 dB of each other at the floor, which is the sound of three different filters
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
  it.each(MATERIALS)('%s is as bright as it is pinned to be', (mat) => {
    const pin = MATERIAL_FINGERPRINTS[mat].centroidHz;
    expect(Math.abs(bright(mat) - pin.value), pin.why).toBeLessThanOrEqual(pin.tol);
  });

  it('splits metal from the rest, with a gap wide enough to be a decision', () => {
    expect(bright('metal')).toBeGreaterThan(CENTROID_SPLIT_HZ.metalFloor);
    for (const mat of MATERIALS) {
      if (mat === 'metal') continue;
      expect(bright(mat), `${mat} must stay below the dull ceiling`).toBeLessThan(
        CENTROID_SPLIT_HZ.dullCeiling,
      );
    }
    expect(CENTROID_SPLIT_HZ.metalFloor).toBeGreaterThan(CENTROID_SPLIT_HZ.dullCeiling);
  });

  /**
   * Two pins that can disagree about the same render are one pin too many.
   *
   * The per-material centroid tolerances and the partition are separate numbers in `audioSpec`,
   * and nothing stops someone widening a tolerance until a material's allowed band crosses the
   * split — at which point a render inside its own pin fails the partition, and the failure
   * reads as a synthesis bug rather than as a spec that contradicts itself.
   */
  it('keeps every centroid tolerance on its own side of the split', () => {
    for (const mat of MATERIALS) {
      const pin = MATERIAL_FINGERPRINTS[mat].centroidHz;
      const { dullCeiling, metalFloor } = CENTROID_SPLIT_HZ;
      if (mat === 'metal') expect(pin.value - pin.tol).toBeGreaterThan(metalFloor);
      else expect(pin.value + pin.tol).toBeLessThan(dullCeiling);
    }
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
    // Stone and concrete are only ~97 Hz apart, which is inside an ordinary retune. Their order
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
  it.each(MATERIALS)('%s lands in its pinned cell of the (centroid, tail) plane', (mat) => {
    const isMetal = mat === 'metal';
    expect(bright(mat) > CENTROID_SPLIT_HZ.metalFloor).toBe(isMetal);
    expect(ring(mat) > -85).toBe(isMetal);
  });

  it.each(MATERIALS)('%s is as loud as it is pinned to be', (mat) => {
    const pin = MATERIAL_FINGERPRINTS[mat].bodyRmsDb;
    expect(Math.abs(body(mat) - pin.value), pin.why).toBeLessThanOrEqual(pin.tol);
  });
});

// ---------------------------------------------------------------------------

describe("§3.9's loudness law: the multiplier is the whole of the difference", () => {
  /**
   * The trap this block is built around, demonstrated instead of described.
   *
   * These four buffers are the fingerprint renders — one strike each, one noise slice each — and
   * read that way at least one material misses its multiplier by more than the law's own
   * tolerance. Nothing is broken: `ATTACK_LEVEL_SAMPLE` explains that a single strike lands
   * 2–6 dB from its own mean because the exciter read a particular slice of the bank. The point
   * of asserting it is that the cheap version of the next test — one render, one comparison —
   * *fails*, so nobody can arrive at it by simplifying and conclude the synthesis is wrong.
   */
  it('cannot be measured from a single strike', () => {
    const off = MATERIALS.filter(
      (mat) =>
        Math.abs(body(mat) - body('concrete') - promisedDb(mat)) >
        MATERIAL_LOUDNESS_LAW.toleranceDb,
    );
    const why = 'if this is empty, the single-strike shortcut has become viable';
    expect(off.length, why).toBeGreaterThan(0);
  });

  /**
   * The invariant, at the stance the attack normalizations were fitted at.
   *
   * `attackDb(mat) − attackDb(concrete) === 20·log10(multiplier)`, for every material. It is a
   * far stronger claim than an ordering: a multiplier applied twice (metal would land +3.5 dB
   * out), applied to the wrong radius, or dropped in the voice builder all fail it, and all of
   * them would pass "metal is louder than concrete".
   *
   * Concrete's row is the reference and reads zero against zero by construction. It is in the
   * loop anyway so the loop is over the whole table — see `fingerprints exactly the materials
   * the game has` for why that matters.
   */
  it.each(MATERIALS)('a walk-step on %s arrives at exactly its multiplier', (mat) => {
    const measured = attackDb('walk-step', mat) - attackDb('walk-step', 'concrete');
    expect(
      Math.abs(measured - promisedDb(mat)),
      `${mat}: measured ${measured.toFixed(3)} dB, §3.9 promises ${promisedDb(mat).toFixed(3)}`,
    ).toBeLessThanOrEqual(MATERIAL_LOUDNESS_LAW.toleranceDb);
  });

  /**
   * And the same invariant at every other stance — the part that says the multiplier is a
   * property of the *surface* and not of the fit.
   *
   * The normalizations were fitted at `walk-step`, so this is where a fit that only worked at
   * one brightness would show. Stances span `bright` 0.55 to 1.6; the worst residual anywhere is
   * 0.357 dB (dust at `landing`), and it grows with `bright`, which is the exciter's cutoff
   * leaking a little level. `acrossStancesToleranceDb` is wider than the walk tolerance for
   * exactly that reason and no other.
   *
   * That 0.357 is now the *law's* residual and not the sample's: the same figure computed over
   * every seed in the bank is 0.359. It is the number this assertion is meant to be about, and
   * at the previous sample size it was not — see `ATTACK_LEVEL_SAMPLE.strikes`.
   */
  it.each(STANCES)('%s carries every multiplier too', (cls) => {
    const base = attackDb(cls, 'concrete');
    for (const mat of MATERIALS) {
      const measured = attackDb(cls, mat) - base;
      expect(
        Math.abs(measured - promisedDb(mat)),
        `${cls} on ${mat}: measured ${measured.toFixed(3)}, promised ${promisedDb(mat).toFixed(3)}`,
      ).toBeLessThanOrEqual(MATERIAL_LOUDNESS_LAW.acrossStancesToleranceDb);
    }
  });

  /**
   * The player-facing consequence of §3.9, as one assertion: "crossing the steel walkway is loud
   * and fast, crossing the dusty slab is quiet and slow — a real routing choice every few
   * seconds, priced in the same currency as everything else."
   *
   * Same stride, two surfaces. The ear hears ×2.5 and the map is painted ×2.5 wider, because
   * they are two readings of one multiplier: `SoundBus.emit` scales both radii, `gainFor` reads
   * one of them. The radii are asserted *exactly* — they are arithmetic on the bus — and the
   * level within 1 dB, which is twice the per-material tolerance because this is the difference
   * of two independently sampled residuals.
   *
   * This is the assertion that would catch the change nobody would notice by ear: scaling the
   * paint radius by the material and forgetting the hearing radius leaves the world looking
   * right and sounding wrong, on the one axis §3.9 exists to keep in step.
   */
  it('makes metal ×2.5 louder and ×2.5 wider than dust, on the same stride', () => {
    const measured = attackDb('walk-step', 'metal') - attackDb('walk-step', 'dust');
    const ratio = materialLoudness(indexOf('metal')) / materialLoudness(indexOf('dust'));
    const promised = 20 * Math.log10(ratio);
    expect(
      Math.abs(measured - promised),
      `metal vs dust: measured ${measured.toFixed(3)} dB, promised ${promised.toFixed(3)}`,
    ).toBeLessThanOrEqual(2 * MATERIAL_LOUDNESS_LAW.toleranceDb);

    const bus = new SoundBus();
    const at = { class: 'walk-step' as const, x: 0, y: 0, z: 0 };
    const metal = bus.emit({ ...at, mat: indexOf('metal') });
    const dust = bus.emit({ ...at, mat: indexOf('dust') });
    expect(metal.paintRadius / dust.paintRadius).toBeCloseTo(ratio, 10);
    expect(metal.hearingRadius / dust.hearingRadius).toBeCloseTo(ratio, 10);
    // The two radii moved by the *same* factor: one multiplier, not two that happen to agree.
    expect(metal.paintRadius / dust.paintRadius).toBeCloseTo(
      metal.hearingRadius / dust.hearingRadius,
      10,
    );
  });

  /**
   * The sample is only an estimate if the strikes scatter less than the sample can average out.
   *
   * A smoke alarm rather than a pinned value: if a material's strike-to-strike spread grows past
   * `maxSpreadDb`, the sample stops being enough to estimate its mean and every number in this
   * block is being read off noise. Dust is the widest at ~7.6 dB here, because it is nearly all
   * exciter and has no modal ring to steady it; metal is close behind for the opposite reason.
   */
  it.each(MATERIALS)('%s scatters little enough for the sample to mean something', (mat) => {
    const xs = levels('walk-step', mat);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(ATTACK_LEVEL_SAMPLE.maxSpreadDb);
  });

  /**
   * `bright` is timbre, not volume — the other half of "the level is the carry radius".
   *
   * Each contact class scales the exciter's cutoff by its own `bright`, and a filter cutoff
   * moving is a level moving unless something stops it. If it were not bounded, a designer
   * making sprint-steps *sound* harder would be making them louder too, in a currency §3.3 never
   * priced — a second volume knob beside `hearingRadius`, which is precisely the arrangement the
   * level law was written to prevent.
   *
   * Measured against concrete so the material is held still: across the full 0.55–1.6 range of
   * `bright`, each class's level tracks its own gain to within 0.21 dB.
   */
  it('lets no class change its level through brightness alone', () => {
    const refDb = attackDb('walk-step', 'concrete');
    const refGain = specFor('walk-step', 'concrete', 0).gain;
    for (const cls of STANCES) {
      const gainDb = 20 * Math.log10(specFor(cls, 'concrete', 0).gain / refGain);
      const leak = attackDb(cls, 'concrete') - refDb - gainDb;
      expect(
        Math.abs(leak),
        `${cls} (bright ${AUDIO_CLASS_VOICES[cls].bright}) leaks ${leak.toFixed(3)} dB of level`,
      ).toBeLessThanOrEqual(BRIGHT_LEAK_MAX_DB);
    }
  });
});

/**
 * The estimator itself, checked against arithmetic rather than against a render.
 *
 * Every number in the block above is a `powerMeanDb` of a sample, so the whole loudness law is
 * only as true as this one line is. Its own docstring says "no assertion below will stop you"
 * from simplifying it to a mean of decibels — that was accurate when written, and these tests
 * are what make it false. Killing that mutation does not need a render, because the mean of
 * squared amplitude is not a measurement: it is a definition, and a definition can be checked
 * by hand.
 *
 * This is not testing the test. `powerMeanDb` is a helper with one job and a closed-form answer;
 * pinning it against numbers computed on paper is the same thing every other pin in this file
 * does, minus the noise.
 */
describe('the power mean is the estimator, and it is not a mean of decibels', () => {
  it('averages power, not logarithms', () => {
    // 0 dB is amplitude² = 1, 20 dB is 100. Mean power 50.5 → 10·log10(50.5) = 17.0332 dB.
    // A mean of decibels would answer 10 — off by seven, which no tolerance in this file
    // would tolerate if it were ever asserted on.
    expect(powerMeanDb([0, 20])).toBeCloseTo(17.0332, 3);
  });

  it('leaves a constant sample alone', () => {
    // The one input both estimators agree on, which is exactly why it cannot be the only case.
    for (const db of [-40, -12.5, 0, 6]) expect(powerMeanDb([db, db, db])).toBeCloseTo(db, 10);
  });

  it('never reads below the mean of decibels, and reads strictly above it when the sample spreads', () => {
    // Jensen, in the direction that matters: the loud strikes carry the energy. This is the
    // property the docstring describes as a low bias, stated as something a test can hold.
    const meanDb = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
    const spread = [-50, -30, -10, 0];
    expect(powerMeanDb(spread)).toBeGreaterThan(meanDb(spread));
    // And the gap grows with the spread, which is why dust — the widest — pays the most for it.
    const wider = [-70, -30, -10, 0];
    expect(powerMeanDb(wider) - meanDb(wider)).toBeGreaterThan(powerMeanDb(spread) - meanDb(spread));
  });
});
