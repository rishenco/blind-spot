/**
 * The detonation, measured — the one voice whose whole design is an absence.
 *
 * §14 does not hedge about the thrown sphere: it does no damage, it cannot stagger, and hitting
 * the spider with one is worth exactly what hitting a wall with one is worth. The verb is "ask a
 * question from somewhere you are not". So the sound has one job — be the loudest deliberate act
 * in the game (§3.3: 32 m of carry) — and one prohibition, which is that it must not read as a
 * weapon. Everything here is one of those two claims turned into a number, and `DETONATION` in
 * `tests/support/audioSpec.ts` is where each number's argument lives.
 *
 * **Why this file scans the whole noise bank.** Every other voice in the game is measured on a
 * handful of renders, and `ATTACK_LEVEL_SAMPLE` explains how a stratified sample of 192 strikes
 * is enough to measure an expectation. Two of the claims below are not expectations. "The mix
 * never clips" is a statement about the *worst* slot in the bank, and an extreme-value statistic
 * does not converge from a sample: the same voice reads −3.56 dBFS over 192 stratified slots and
 * −3.00 over all 997, because slot 526 is not in the sample. So the pass below renders every one
 * of the 997 offsets `noiseOffset` can produce, and answers three questions off that one pass —
 * the ceiling, the level's stability, and the sharpest edge the voice makes — because it is the
 * expensive thing in this file (about ten seconds) and one pass should buy as much as it can.
 * The renders are cut to `SCAN_SECONDS` for the same reason: the latest peak any slot produces
 * lands at 123 ms, so a render that stops at 180 ms measures everything the pass asks about.
 *
 * Everything renders the shipped voice — `src/audio/voices.ts`, through the real `AudioDirector`,
 * on real `SoundBus` events, at the gain `gainFor` chose. No spec here is hand-written: a spec
 * the test invented would let the synthesis pass against numbers the director never produces.
 */

import { describe, expect, it } from 'vitest';
import {
  bandShare,
  centroidHz,
  hasNaN,
  maxStep,
  peakInfo,
  rmsDb,
  stereoEnergyRatio,
  type AudioBufferLike,
} from '../support/audioMetrics';
import { DETONATION, MAX_PEAK_DBFS } from '../support/audioSpec';
import { renderOffline } from '../support/audioRender';
import { ATTACK_WINDOW_SEC, NOISE_SLOTS, playVoice } from '../../src/audio/voices';
import { AudioDirector, type ListenerState, type VoiceSpec } from '../../src/audio/director';
import { MAT_METAL } from '../../src/paint/materials';
import {
  PLAYER_EMITTER_ID,
  SoundBus,
  type SoundClass,
  type SoundEmitSpec,
} from '../../src/paint/soundEvents';

/** When the sphere goes off, seconds into the render. Far enough in to look *before* it. */
const STRIKE_AT = 0.05;
/** Long enough to outlast the voice's own 1.4 s schedule and hear that it has finished. */
const RENDER_SECONDS = 2;
/** Long enough for the peak and the attack window; see the bank scan in the header. */
const SCAN_SECONDS = STRIKE_AT + 0.18;
/** The envelope's window: long enough to be an RMS, short enough to still be a shape. */
const ENVELOPE_WINDOW_SEC = 0.1;

/**
 * At the origin, so `gainFor` clamps to `NEAR_FIELD_M` and every voice is at its own loudest.
 *
 * That is the condition the ceiling claim is about — the sphere can land at the player's feet —
 * and it is also the condition under which two voices' measured levels are directly comparable,
 * since the distance term is identical and the only thing left between them is carry.
 */
const LISTENER: ListenerState = { x: 0, y: 0, z: 0, range: 40, emitter: PLAYER_EMITTER_ID };

/** One spec, built the way the game builds it: a real emit on a real bus, decided by the real
 *  director. `bus` is a parameter so a caller can walk the sequence counter — and therefore the
 *  noise bank — without inventing a seed. */
function specFor(bus: SoundBus, cls: SoundClass, extra: Partial<SoundEmitSpec> = {}): VoiceSpec {
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

function render(spec: VoiceSpec, seconds = RENDER_SECONDS): Promise<AudioBufferLike> {
  return renderOffline(seconds, (ctx, master) => {
    playVoice(ctx, master, spec, STRIKE_AT);
  });
}

/** RMS of the §3.9 attack window — the window every level claim in the audio suite is made in. */
const attackDb = (buffer: AudioBufferLike): number =>
  rmsDb(buffer, undefined, STRIKE_AT, STRIKE_AT + ATTACK_WINDOW_SEC);

const boom = await render(specFor(new SoundBus(), 'sphere-boom'));

/**
 * Every offset in the noise bank, rendered once.
 *
 * `decide` seeds the voice from `event.seq`, so 997 emits on one bus walk the whole of
 * `noiseOffset`'s range exactly once and nothing is sampled at all. Consecutive seeds are ~1.3 ms
 * apart in the bank, which `ATTACK_LEVEL_SAMPLE` warns is nearly the same audio twice — that
 * warning is about *sampling*, and this is a census, so it does not apply.
 */
const scan = await (async () => {
  const bus = new SoundBus();
  const levels: number[] = [];
  let worstPeakDb = -Infinity;
  let sharpestStep = 0;
  for (let i = 0; i < NOISE_SLOTS; i++) {
    const buffer = await render(specFor(bus, 'sphere-boom'), SCAN_SECONDS);
    const level = attackDb(buffer);
    levels.push(level);
    worstPeakDb = Math.max(worstPeakDb, peakInfo(buffer).peakDb);
    sharpestStep = Math.max(sharpestStep, maxStep(buffer) / 10 ** (level / 20));
  }
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const variance = levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length;
  return { levels, mean, sd: Math.sqrt(variance), worstPeakDb, sharpestStep };
})();

// ---------------------------------------------------------------------------

describe('the detonation renders at all', () => {
  /**
   * Runs before every other assertion here, for `materialVoices.test.ts`'s reason: one non-finite
   * sample poisons every node downstream and most metrics answer `NaN`, which compares false
   * against everything — so a dead render sails through a file full of `toBeLessThan`.
   */
  it('renders finite, with headroom, and centred', () => {
    expect(hasNaN(boom)).toBe(false);
    const peak = peakInfo(boom);
    expect(peak.clipped).toBe(false);
    expect(peak.peakDb).toBeLessThan(MAX_PEAK_DBFS);
    // The sphere is the loudest thing in its own render, and it happens when it was scheduled.
    // The window is wider than the other voices' because the body opens over 20 ms and the tail
    // over 80: measured, the latest slot peaks 123 ms in, which is the design and not a lag.
    expect(peak.peakAtSec).toBeGreaterThanOrEqual(STRIKE_AT);
    expect(peak.peakAtSec).toBeLessThan(STRIKE_AT + 0.15);
    // No panner in this graph yet — spatialisation is a later commit — so an imbalance would be a
    // bug rather than a choice, and would bias every mixdown number below.
    expect(stereoEnergyRatio(boom)).toBeCloseTo(1, 6);
  });

  /** Nothing sounds before it goes off. A filter ringing up early would show as energy here. */
  it('leaves the room silent until it happens', () => {
    expect(rmsDb(boom, undefined, 0, STRIKE_AT)).toBeLessThan(-100);
  });

  /**
   * The same event twice is the same samples twice.
   *
   * The whole phonometric approach stands on it, and the boom is the voice most able to break it:
   * it is the only one built from four layers off one noise source, and a graph that reached for
   * `Math.random` for any of them would still measure correctly on every other test in this file.
   */
  it('renders the same event to the same samples', async () => {
    const again = await render(specFor(new SoundBus(), 'sphere-boom'));
    expect(again.length).toBe(boom.length);
    let differing = 0;
    for (let c = 0; c < boom.numberOfChannels; c++) {
      const a = boom.getChannelData(c);
      const b = again.getChannelData(c);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
    }
    expect(differing).toBe(0);
  });
});

describe('the detonation takes its level from the bus', () => {
  /**
   * Level is `gainFor` and nothing else — read off two distances rather than off two gains.
   *
   * Doubling `spec.gain` by hand would test the multiplication; deciding the same class from two
   * listener distances tests the thing the game actually does, and fails a voice that had grown a
   * level of its own somewhere between `hearingRadius` and the output.
   */
  it('halves with twice the distance, to the decibel', async () => {
    const bus = new SoundBus();
    const near = specFor(bus, 'sphere-boom', { x: 4 });
    const far = specFor(bus, 'sphere-boom', { x: 8 });
    expect(far.gain).toBeCloseTo(near.gain / 2, 12);
    // Same slot in the bank would be ideal and is not available — `seq` moves with every emit —
    // so this is two different slots, which is why the tolerance is the bank's own spread and not
    // zero. `scan.sd` is 0.68 dB; 1.5 dB fails anything that is not the inverse-distance law.
    const drop = attackDb(await render(near)) - attackDb(await render(far));
    expect(drop).toBeGreaterThan(6.02 - 1.5);
    expect(drop).toBeLessThan(6.02 + 1.5);
  });

  /**
   * §3.3's carry column, as a thing a player can hear: the boom is the loudest deliberate act.
   *
   * At one distance the distance term is identical for all three, so the attack levels *are* the
   * arrival levels and no arithmetic stands between the table and the assertion. The boom's figure
   * is the census mean rather than one render, because one render of it is worth ±2 dB; the pings'
   * are single renders, because measured across the same bank their levels move by 0.02 dB.
   */
  it('arrives louder than either ping at the same distance', async () => {
    const bus = new SoundBus();
    const quiet = attackDb(await render(specFor(bus, 'q-ping')));
    const loud = attackDb(await render(specFor(bus, 'e-ping')));
    expect(scan.mean - quiet).toBeGreaterThan(DETONATION.overQuietPingDb);
    expect(scan.mean - loud).toBeGreaterThan(DETONATION.overLoudPingDb);
  });

  /**
   * The ceiling that actually sets `BOOM_ATTACK_NORM`.
   *
   * The boom carries furthest, so `gainFor` hands it the largest near-field gain in the game, and
   * it has the highest crest of any voice — this is the one place in the mix where `MAX_PEAK_DBFS`
   * binds. Asserted as a window, because drifting *down* through it is a failure too: it would
   * mean the constant had been quietly turned down, taking §3.3's ordering with it.
   */
  it('spends exactly its share of the mix at the closest range the game allows', () => {
    expect(scan.worstPeakDb).toBeLessThan(MAX_PEAK_DBFS);
    expect(Math.abs(scan.worstPeakDb - DETONATION.peakCeilingDbfs))
      .toBeLessThanOrEqual(DETONATION.peakCeilingTolDb);
  });

  /**
   * The noise slot may not decide how loud the event was.
   *
   * This is the bus contract at its most fragile. §3.9's window is 85 ms and the boom's energy is
   * low, so a body built as a narrow resonance would pass only a handful of cycles inside the
   * window and its RMS would be a small-sample statistic — the first draft measured 1.09 dB of
   * standard deviation across this same census, which is level being set by `spec.seed` instead
   * of by distance, and would let a boom at 20 m arrive louder than a boom at 10 m.
   */
  it('sounds the same loudness whichever slot of the noise bank it reads', () => {
    expect(scan.sd).toBeLessThan(DETONATION.levelSdMaxDb);
  });
});

describe('the detonation is not a weapon', () => {
  /**
   * No crack, measured on the edge.
   *
   * A shock front is a step: the sample-to-sample discontinuity is what the ear hears as the snap
   * of a gunshot. Normalized by the voice's own attack RMS rather than by its peak, because crest
   * moves with the noise slot and would make the same edge read differently render to render.
   * Measured across the census: 0.41 at worst and 0.19 typically, against the E-ping's
   * 0.61 and a landing's 0.68.
   */
  it('never makes an edge as sharp as the sound of hitting the floor', () => {
    expect(scan.sharpestStep).toBeLessThan(DETONATION.maxStepPerRms);
  });

  /**
   * No crack, measured on the spectrum — and weight, measured the same way.
   *
   * Both halves matter and neither implies the other: a voice can be dim and thin at once, which
   * would be a hiss rather than a detonation. The upper bound is what a shock front would break;
   * the lower is what a body that had drifted up out of the bottom two octaves would break.
   */
  it('puts its energy underneath rather than on top', () => {
    const attack: [number, number] = [STRIKE_AT, STRIKE_AT + ATTACK_WINDOW_SEC];
    expect(bandShare(boom, ...attack, 2000, 24000)).toBeLessThan(DETONATION.attackAbove2kMax);
    expect(bandShare(boom, ...attack, 0, 250)).toBeGreaterThan(DETONATION.attackBelow250Min);
    // A coarse partition, in `centroidHz`'s own terms: the E-ping sits near 1400 Hz and this must
    // not be found anywhere near it.
    expect(centroidHz(boom, ...attack)).toBeLessThan(600);
  });

  /**
   * No debris: the envelope falls and keeps falling.
   *
   * Crackle, secondary bursts and rattle are one thing seen from outside — a tail that goes back
   * up. Every layer of this voice is a single smooth `burst`, so the measured rise is 0 dB, and a
   * fifth of a decibel of tolerance is there for the RMS of a decaying noise signal near its own
   * floor rather than for anything the design permits.
   */
  it('leaves nothing rattling behind it', () => {
    const windows = envelope(boom);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]! - windows[i - 1]!, `window ${i}`)
        .toBeLessThan(DETONATION.envelopeRiseMaxDb);
    }
  });

  /**
   * A charge going off is a long sound; a gunshot is a short one.
   *
   * Duration is part of the §14 claim rather than decoration — it is also most of why the boom
   * reads as the loudest act in the game while peaking below the ceiling, since loudness is
   * energy over time and peak is only headroom. Measured, the window at 0.8 s sits 59.8 dB
   * under the first and there is still something at 1.3 s.
   */
  it('is still going a second later', () => {
    const windows = envelope(boom);
    const at = Math.round(DETONATION.audibleUntilSec / ENVELOPE_WINDOW_SEC);
    expect(windows[0]! - windows[at]!).toBeLessThan(DETONATION.audibleUntilMaxDropDb);
  });
});

describe('the surface does not colour the boom', () => {
  /**
   * §3.9 prices *contacts* by what they struck. A detonation strikes nothing — it is the sphere's
   * own voice, and the slab under it is a bystander — so the bus refuses to let a caller say
   * otherwise rather than accepting a material and ignoring it. `tools/listen.mjs` scene
   * `06-boom-materials` is the other half of this: four lobs onto four different floors, asserted
   * to be the same sound. Here is the reason they are allowed to be.
   */
  it('refuses to be told what it landed on', () => {
    const bus = new SoundBus();
    expect(() =>
      bus.emit({
        class: 'sphere-boom',
        x: 0,
        y: 0,
        z: 0,
        source: 'player',
        emitter: PLAYER_EMITTER_ID,
        mat: MAT_METAL,
      }),
    ).toThrow(/strikes nothing/);
    // And the spec the builder receives carries neither material, so there is nothing for
    // `boomVoice` to read even by accident.
    const spec = specFor(bus, 'sphere-boom');
    expect(spec.mat).toBeNull();
    expect(spec.objMat).toBeNull();
  });
});

/** The voice in 100 ms windows, dB — the shape "no debris" and "still going" are both read off. */
function envelope(buffer: AudioBufferLike): number[] {
  const windows: number[] = [];
  for (let t = 0; STRIKE_AT + t + ENVELOPE_WINDOW_SEC <= RENDER_SECONDS; t += ENVELOPE_WINDOW_SEC) {
    windows.push(rmsDb(buffer, undefined, STRIKE_AT + t, STRIKE_AT + t + ENVELOPE_WINDOW_SEC));
  }
  return windows;
}
