/**
 * The voices, measured — the shipped synthesis, rendered offline and read with a meter.
 *
 * `director.test.ts` checks the arithmetic of *whether* and *how loud* without making a sound.
 * This file is the other half: it builds the real graphs from `src/audio/voices.ts` through the
 * real `AudioDirector` on real `SoundBus` events, renders them, and asserts on what came out.
 * Everything here is therefore a claim about the game's own audio rather than about a fixture —
 * which is the point of `voices.ts` taking a `BaseAudioContext` instead of an `AudioContext`.
 *
 * The claim this file exists for is §3.5's: Q and E "differ in *shape*, not reach". A difference
 * of shape that the player cannot hear is not a difference, so it is measured — on spectral
 * centroid, which is the axis brightness lives on, and on the *direction* the centroid moves,
 * which is the axis a sweep lives on. Both are pinned, because either alone could be reproduced
 * by accident: two sounds can share a brightness and sweep opposite ways, or sweep together and
 * sit an octave apart.
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
import { MAX_PEAK_DBFS } from '../support/audioSpec';
import { renderOffline } from '../support/audioRender';
import { NOISE_SLOTS, contactVoice, pingVoice, playVoice } from '../../src/audio/voices';
import { AudioDirector, type ListenerState, type VoiceSpec } from '../../src/audio/director';
import { MAT_CONCRETE, MAT_DUST, MAT_METAL, MAT_STONE } from '../../src/paint/materials';
import {
  PLAYER_EMITTER_ID,
  SoundBus,
  type SoundClass,
  type SoundEmitSpec,
} from '../../src/paint/soundEvents';

/**
 * The render conditions every number below was measured under.
 *
 * The strike is offset from t=0 so a metric can look *before* it — a voice that leaked energy
 * backwards through a filter's ring-up would otherwise be invisible — and the render outlasts
 * the longest voice (landing, 0.9 s) so nothing is cut off by the schedule.
 */
const STRIKE_AT = 0.05;
const RENDER_SECONDS = 1.4;

/** Close enough to be inside `NEAR_FIELD_M`, so gain is the class's full near-field level. */
const LISTENER: ListenerState = { x: 0, y: 0, z: 0, range: 40, emitter: PLAYER_EMITTER_ID };

/**
 * One spec, built the way the game builds it: a real emit on a real bus, decided by the real
 * director. Nothing here hand-writes a `VoiceSpec` — a spec invented by the test would let the
 * synthesis pass against numbers the director never produces.
 */
function specFor(cls: SoundClass, extra: Partial<SoundEmitSpec> = {}): VoiceSpec {
  const bus = new SoundBus();
  const aim = cls === 'e-ping' ? { dirX: 1, dirY: 0, dirZ: 0 } : {};
  const event = bus.emit({
    class: cls,
    x: 0,
    y: 0,
    z: 0,
    source: 'player',
    emitter: PLAYER_EMITTER_ID,
    ...aim,
    ...extra,
  });
  const spec = new AudioDirector(LISTENER).decide(event);
  if (spec === null) throw new Error(`specFor('${cls}'): the listener at the origin heard nothing`);
  return spec;
}

function render(spec: VoiceSpec): Promise<AudioBufferLike> {
  return renderOffline(RENDER_SECONDS, (ctx, master) => {
    playVoice(ctx, master, spec, STRIKE_AT);
  });
}

/** Every class rendered once, so the whole file measures the same six buffers. */
const CLASSES: readonly SoundClass[] = [
  'crouch-step',
  'walk-step',
  'sprint-step',
  'landing',
  'q-ping',
  'e-ping',
];
const rendered = new Map<SoundClass, AudioBufferLike>();
for (const cls of CLASSES) rendered.set(cls, await render(specFor(cls)));
const buffer = (cls: SoundClass): AudioBufferLike => rendered.get(cls)!;

// ---------------------------------------------------------------------------

describe('every voice the game can make', () => {
  /**
   * Runs before every other assertion here, for the reason `materialVoices.test.ts` states: one
   * non-finite sample poisons every node downstream and most metrics answer `NaN`, which compares
   * false against everything — so a dead render sails through a file full of `toBeLessThan`.
   */
  it.each(CLASSES)('renders %s finite, with headroom, and centred', (cls) => {
    const b = buffer(cls);
    expect(hasNaN(b)).toBe(false);
    const peak = peakInfo(b);
    expect(peak.clipped).toBe(false);
    expect(peak.peakDb).toBeLessThan(MAX_PEAK_DBFS);
    // The voice is the loudest thing in its own render, and it happens when it was scheduled.
    expect(peak.peakAtSec).toBeGreaterThanOrEqual(STRIKE_AT);
    expect(peak.peakAtSec).toBeLessThan(STRIKE_AT + 0.05);
    // No panner anywhere in these graphs yet — spatialisation is a later commit — so any
    // imbalance would be a bug rather than a choice, and would bias every mixdown number here.
    expect(stereoEnergyRatio(b)).toBeCloseTo(1, 6);
  });

  /** Nothing sounds before it is struck. A filter ringing up early would show as energy here. */
  it.each(CLASSES)('leaves %s silent until it happens', (cls) => {
    expect(rmsDb(buffer(cls), undefined, 0, STRIKE_AT)).toBeLessThan(-100);
  });

  /**
   * The property the whole phonometric approach stands on, asserted against the *shipped*
   * builders rather than against a fixture. Any un-seeded randomness in a voice — a `Math.random`
   * exciter, a noise buffer filled per call — makes every pinned number in this file a number
   * that was true once.
   */
  it('renders the same spec to the same samples, bit for bit', async () => {
    const spec = specFor('landing', { mat: MAT_METAL });
    const a = await render(spec);
    const b = await render(spec);
    let differing = 0;
    for (let c = 0; c < a.numberOfChannels; c++) {
      const da = a.getChannelData(c);
      const db = b.getChannelData(c);
      for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) differing++;
    }
    expect(differing).toBe(0);
  });

  /**
   * And two *different* events do not. `spec.seed` is the event's sequence number, so consecutive
   * footfalls read from different slices of the shared noise bank; without that a sprint is the
   * same 40 ms of noise eight times a second, which is a machine gun rather than a runner.
   */
  it('gives two footfalls different noise, from the same bank', async () => {
    const bus = new SoundBus();
    const director = new AudioDirector(LISTENER);
    const one = director.decide(bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 }))!;
    const two = director.decide(bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 }))!;
    expect(two.seed).not.toBe(one.seed);
    const a = await render(one);
    const b = await render(two);
    const da = a.getChannelData(0);
    const db = b.getChannelData(0);
    let differing = 0;
    for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) differing++;
    // Not "some samples differ" — most of them do. A one-sample difference would pass a
    // `toBeGreaterThan(0)` while the two footsteps were audibly identical.
    expect(differing / da.length).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------

/**
 * The noise bank's slot count — a stated property that nothing used to check.
 *
 * `NOISE_SLOTS`'s comment has always said "prime, so seeds do not wrap onto a short cycle", and
 * until this block that sentence was the only thing holding the number: replacing 997 with 512
 * passed the entire suite. 512 is the worst available substitute rather than a neutral one, and
 * this is the *why* made checkable, in arithmetic instead of in a render.
 *
 * The mechanism is the one the test above cares about. `noiseOffset` reads slot
 * `seed % NOISE_SLOTS` and the seed is the bus's sequence number, so any subsequence of events
 * taken at a fixed stride walks the bank at that stride — and a fixed stride is what a gait is:
 * one foot of two, a landing every fourth stride, one player of four sharing a bus. A stride `s`
 * visits `NOISE_SLOTS / gcd(s, NOISE_SLOTS)` slots before repeating, which is the whole bank for
 * every stride exactly when the count is prime. At 512, half the strides below it fold onto a
 * short orbit and a stride of 8 hears the same 64 slices for the rest of the run — the machine-gun
 * sprint the noise bank exists to prevent, reached by a door nobody was watching, and inaudible
 * to "two consecutive footfalls differ" because consecutive is the one stride that still works.
 */
describe('the noise bank is cut into a prime number of slots', () => {
  it('is a whole number of them', () => {
    // `noiseOffset` divides by this after taking a remainder against it. A fraction makes the
    // slots unequal and the stated count a fiction; anything below 2 makes every strike identical.
    expect(Number.isInteger(NOISE_SLOTS)).toBe(true);
    expect(NOISE_SLOTS).toBeGreaterThan(1);
  });

  it('has no divisor but itself, by trial division', () => {
    const divisors: number[] = [];
    for (let d = 2; d * d <= NOISE_SLOTS; d++) if (NOISE_SLOTS % d === 0) divisors.push(d);
    expect(divisors, `${NOISE_SLOTS} is not prime`).toEqual([]);
  });

  /**
   * The same fact stated as the property the game depends on, because that is the one worth
   * failing on: a future slot count is wrong *because* some cadence of footfalls repeats itself,
   * not because a number failed a number-theory quiz.
   */
  it('leaves no emission cadence a short orbit to fall into', () => {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const short: number[] = [];
    for (let stride = 1; stride < NOISE_SLOTS; stride++) {
      if (NOISE_SLOTS / gcd(stride, NOISE_SLOTS) !== NOISE_SLOTS) short.push(stride);
    }
    expect(
      short.length,
      `strides that repeat before visiting the whole bank: ${short.slice(0, 8).join(', ')}`,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('the two pings are told apart by ear (§3.5)', () => {
  const q = buffer('q-ping');
  const e = buffer('e-ping');
  /** The window both pings are fully inside: after the strike, before either has decayed away. */
  const FROM = STRIKE_AT;
  const TO = 0.6;

  /**
   * The measured form of "differ in shape, not reach".
   *
   * Centroid is the ear's brightness, and these two sit 2.1 octaves apart — 359 Hz for the round
   * omnidirectional room-read against 1574 Hz for the directed beam. Pinned as a ratio rather
   * than as two absolute numbers so that re-tuning both pings together (a mix pass, a different
   * master level) does not fail a test about how *different* they are.
   */
  it('by brightness, and by more than two octaves of it', () => {
    const qBright = centroidHz(q, FROM, TO);
    const eBright = centroidHz(e, FROM, TO);
    expect(qBright).toBeGreaterThan(250);
    expect(qBright).toBeLessThan(500);
    expect(eBright).toBeGreaterThan(1300);
    expect(eBright).toBeLessThan(1900);
    expect(Math.log2(eBright / qBright)).toBeGreaterThan(2);
  });

  /**
   * And by which way the sweep runs, which is the half of the difference brightness cannot carry.
   * Q falls (394 → 249 Hz) like a pulse released in every direction; E rises (1411 → 2472 Hz)
   * like a question thrown forwards. Two sounds an octave apart that both fell would still be
   * "the same gesture, transposed" — this is the assertion that says they are not.
   */
  it('and by which way each one sweeps', () => {
    const qEarly = centroidHz(q, STRIKE_AT, STRIKE_AT + 0.11);
    const qLate = centroidHz(q, 0.25, TO);
    const eEarly = centroidHz(e, STRIKE_AT, STRIKE_AT + 0.11);
    const eLate = centroidHz(e, 0.25, TO);
    // Q darkens by at least a third; E brightens by at least half again.
    expect(qLate / qEarly).toBeLessThan(0.75);
    expect(eLate / eEarly).toBeGreaterThan(1.5);
  });

  /**
   * The price is audible too. §3.3 gives E a 30 m carry against Q's 18, and `gainFor` derives
   * level from exactly that — so the ping that wakes both ends of its beam is also the one that
   * arrives louder in your own ears. Nobody has to be told which one is the loud one.
   */
  it('and the loud one is the one that carries further', () => {
    const qSpec = specFor('q-ping');
    const eSpec = specFor('e-ping');
    expect(eSpec.gain / qSpec.gain).toBeCloseTo(30 / 18, 9);
  });
});

// ---------------------------------------------------------------------------

describe('a contact voice', () => {
  /**
   * §3.9's tracking mechanic in its smallest form: the same footfall on two surfaces is two
   * different sounds *after* the strike, not just two levels. Metal's 0.3–0.38 s modes are still
   * ringing at 200–350 ms where concrete's 0.04–0.09 s ones are long gone.
   *
   * `materialVoices.test.ts` pins the whole four-material table; this is the one-line version,
   * here so that a change to the shipped `contactVoice` fails in the file that owns it.
   */
  it('carries the surface it struck into its ring (§3.9)', async () => {
    const metal = await render(specFor('walk-step', { mat: MAT_METAL }));
    const concrete = await render(specFor('walk-step', { mat: MAT_CONCRETE }));
    const ringMetal = tailDb(metal, 0.25, 0.4);
    const ringConcrete = tailDb(concrete, 0.25, 0.4);
    expect(ringMetal - ringConcrete).toBeGreaterThan(30);
  });

  /**
   * The gait ladder: a harder contact is a *brighter* contact, not merely a louder one.
   * `bright` scales the exciter's cutoff, so the strike sharpens with effort — which is what
   * lets a listener tell a creeping thing from a running one even at equal distance, where the
   * §3.3 radii have already been equalised by distance.
   *
   * Landing is deliberately not in the chain: it is the brightest strike but the deepest thump
   * (92 Hz against a walk's 120), and the two pull the centroid opposite ways. Weight is not a
   * rung on the effort ladder.
   */
  it('gets brighter as the gait gets harder', () => {
    const bright = (cls: SoundClass): number => centroidHz(buffer(cls), STRIKE_AT, 0.3);
    expect(bright('crouch-step')).toBeLessThan(bright('walk-step'));
    expect(bright('walk-step')).toBeLessThan(bright('sprint-step'));
  });

  /**
   * Level is `spec.gain` and nothing else — the property that lets `director.ts` own §3.3 and
   * §3.9 alone. If the synthesis had a level of its own anywhere (a compressor, a per-material
   * makeup gain applied outside `attackNorm`, a soft clip) this would not be 6.02 dB.
   */
  it('is exactly as loud as its spec says, and no louder', async () => {
    const base = specFor('walk-step', { mat: MAT_STONE });
    const half = await renderOffline(RENDER_SECONDS, (ctx, master) => {
      contactVoice(ctx, master, { ...base, gain: base.gain / 2 }, STRIKE_AT);
    });
    const full = await renderOffline(RENDER_SECONDS, (ctx, master) => {
      contactVoice(ctx, master, base, STRIKE_AT);
    });
    const delta =
      rmsDb(full, undefined, STRIKE_AT, 0.3) - rmsDb(half, undefined, STRIKE_AT, 0.3);
    expect(delta).toBeCloseTo(20 * Math.log10(2), 6);
  });

  /**
   * An unknown material sounds like concrete rather than like silence or a crash.
   * `materialLoudness` already answers 1.0 for an index off the end of the table (a data bug is
   * caught by the test that walks `MATERIAL_NAMES`, not by a frame of gameplay); the voice has
   * to make the same choice, or the two halves of "unknown material" disagree.
   */
  it('falls back to the ordinary surface when the material is not one it knows', async () => {
    const known = specFor('walk-step', { mat: MAT_CONCRETE });
    const strange = await renderOffline(RENDER_SECONDS, (ctx, master) => {
      contactVoice(ctx, master, { ...known, mat: 99 }, STRIKE_AT);
    });
    const ordinary = await renderOffline(RENDER_SECONDS, (ctx, master) => {
      contactVoice(ctx, master, known, STRIKE_AT);
    });
    const a = strange.getChannelData(0);
    const b = ordinary.getChannelData(0);
    let differing = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
    expect(differing).toBe(0);
    expect(hasNaN(strange)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('playVoice', () => {
  /**
   * The dispatch is `spec.voice` and only `spec.voice`. Asserted as bit-identity against the two
   * builders called directly, because the failure this guards against is subtle: a dispatch that
   * read `spec.mat === null` instead would work for every event the game emits today and break
   * the first time something strikes a surface without one.
   */
  it.each([
    ['contact', 'walk-step' as SoundClass],
    ['ping', 'e-ping' as SoundClass],
  ])('builds the %s voice for a %s spec, and only that one', async (kind, cls) => {
    const spec = specFor(cls);
    expect(spec.voice).toBe(kind);
    const viaDispatch = await renderOffline(RENDER_SECONDS, (ctx, master) => {
      playVoice(ctx, master, spec, STRIKE_AT);
    });
    const direct = await renderOffline(RENDER_SECONDS, (ctx, master) => {
      if (kind === 'contact') contactVoice(ctx, master, spec, STRIKE_AT);
      else pingVoice(ctx, master, spec, STRIKE_AT);
    });
    const a = viaDispatch.getChannelData(0);
    const b = direct.getChannelData(0);
    let differing = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
    expect(differing).toBe(0);
    // And it is not the trivially-equal case of two silent renders.
    expect(rmsDb(viaDispatch, undefined, STRIKE_AT, 0.3)).toBeGreaterThan(-60);
  });

  /**
   * The quietest thing the game can emit still arrives as sound rather than as a rounding error.
   * A crouch-step on dust at the edge of its 1.2 m carry is the floor of the whole mix, and a
   * floor that renders to digital silence would mean §3.9's quiet end is not quiet — it is gone.
   */
  it('still makes a sound at the quietest thing in the game', async () => {
    const spec = specFor('crouch-step', { mat: MAT_DUST });
    const b = await render(spec);
    const level = rmsDb(b, undefined, STRIKE_AT, 0.3);
    expect(level).toBeGreaterThan(-90);
    expect(level).toBeLessThan(-40);
  });
});
