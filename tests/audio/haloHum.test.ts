/**
 * The Halo hum — §3.8's self-readout, measured as the game plays it.
 *
 * "A ring around the reticle whose brightness equals your current audible radius, plus a matching
 * hum pitch. You always know exactly how loud you are. **Non-negotiable:** the genre's most-
 * repeated complaint is 'I can't tell when I'm detectable.'"
 *
 * That is the only place the vision doc uses the word non-negotiable, so it is worth a test that
 * can actually fail. §3.8 fixes the map as law — `55·√(r/1.5)` Hz, gliding continuously rather
 * than stepping between stances, at a level that stays low, near-constant and out of the way of
 * events — which turns four sentences of intent into four measurable claims, one per describe
 * block below.
 *
 * **This file no longer measures a fixture.** `tests/support/haloProbe.ts` held a prototype hum
 * while §3.8 was unbuilt, and its header said it left the day the real one landed. It has: every
 * number here comes from `src/audio/halo.ts` driven the way `Game.update` drives it — a real
 * `Halo` glided at 60 Hz, one `setRadius` per frame — so what is pinned is what a player hears.
 *
 * The arithmetic of the map (`humPitch`, `haloBrightness`, the glide) is proved in
 * `tests/halo.test.ts`, with no audio backend anywhere in the claim. What only a render can
 * answer is whether the *sound* carries it, and that is all this file asks.
 */

import { describe, expect, it } from 'vitest';
import { estimateF0, hasNaN, peakInfo, rmsDb } from '../support/audioMetrics';
import {
  HALO_DUCK,
  HALO_LEVEL_SPREAD_MAX_DB,
  HALO_PEAK_DBFS,
  HALO_PITCH_POINTS,
  HALO_PITCH_TOLERANCE_CENTS,
  MAX_PEAK_DBFS,
} from '../support/audioSpec';
import { renderOffline } from '../support/audioRender';
import { HaloHum } from '../../src/audio/halo';
import { HALO_MAX_RADIUS_M, Halo, humPitch } from '../../src/paint/halo';

/** The rate `Game.update` pushes a radius in at, near enough. */
const FRAME = 1 / 60;

/**
 * Crouch → walk → sprint → quiet, as *targets*, exactly as the body hands them over.
 *
 * The transitions are not authored: each one is §3.8's glide running from wherever the readout
 * was, on the same `Halo` the ring is drawn from. That is why the plateaus are 2.6 s apart —
 * the pitch of a plateau only means something once the glide has settled into it, and seven
 * time constants is where the residual stops mattering at the resolution `estimateF0` reads.
 */
const TARGETS: readonly { readonly atSec: number; readonly radiusM: number }[] = [
  { atSec: 0, radiusM: 2 },
  { atSec: 1.8, radiusM: 11 },
  { atSec: 4.4, radiusM: 24 },
  { atSec: 7.0, radiusM: 2 },
];
const SWEPT_SEC = 9.5;
/** Where the run ends up back at a crouch — the readout is a live reading, not a high-water mark. */
const BACK_TO_QUIET: readonly [number, number] = [8.4, 9.3];

function targetAt(t: number): number {
  let radius = TARGETS[0]!.radiusM;
  for (const point of TARGETS) if (point.atSec <= t) radius = point.radiusM;
  return radius;
}

/** Drive a hum through the timeline the way the game drives it, one push per frame. */
function driveSweep(ctx: BaseAudioContext, out: AudioNode): void {
  const halo = new Halo();
  halo.reset(TARGETS[0]!.radiusM);
  const hum = new HaloHum(ctx, out, { startAt: 0, radiusM: halo.radius });
  for (let i = 1; i * FRAME < SWEPT_SEC; i++) {
    const t = i * FRAME;
    halo.advance(targetAt(t), FRAME);
    hum.setRadius(halo.radius, t);
  }
}

/** A hum held at one radius, driven at the same frame rate. Used by the ducking block. */
function driveSteady(ctx: BaseAudioContext, out: AudioNode, seconds: number, radiusM: number): HaloHum {
  const hum = new HaloHum(ctx, out, { startAt: 0, radiusM });
  for (let i = 1; i * FRAME < seconds; i++) hum.setRadius(radiusM, i * FRAME);
  return hum;
}

const swept = await renderOffline(SWEPT_SEC, driveSweep);

/** The ducking block's three renders: undisturbed, one event, and a burst of five. */
const DUCK_AT = 0.5;
const DUCK_HELD_M = 11;
const DUCK_SEC = 2.5;
const plain = await renderOffline(DUCK_SEC, (ctx, master) => {
  driveSteady(ctx, master, DUCK_SEC, DUCK_HELD_M);
});
const ducked = await renderOffline(DUCK_SEC, (ctx, master) => {
  driveSteady(ctx, master, DUCK_SEC, DUCK_HELD_M).duck(DUCK_AT);
});
/** Five footfalls 60 ms apart — closer together than a sprint, which is the point. */
const burst = await renderOffline(DUCK_SEC, (ctx, master) => {
  const hum = driveSteady(ctx, master, DUCK_SEC, DUCK_HELD_M);
  for (const t of [0.5, 0.56, 0.62, 0.68, 0.74]) hum.duck(t);
});
/**
 * Eight events 30 ms apart — a cluster tighter than the duck's own 50 ms hold.
 *
 * Not a step rate: it is a landing and the stride that follows it, a ping over a footfall, or
 * two of four players moving at once. Anything that arrives inside the hold leaves a release
 * scheduled behind the duck that replaced it, and this is the render where that shows.
 */
const CLUSTER_LAST = 0.5 + 7 * 0.03;
const cluster = await renderOffline(DUCK_SEC, (ctx, master) => {
  const hum = driveSteady(ctx, master, DUCK_SEC, DUCK_HELD_M);
  for (let i = 0; i < 8; i++) hum.duck(0.5 + i * 0.03);
});

/** Cents between two frequencies — the unit a pitch error is actually legible in. */
const centsBetween = (measured: number, expected: number): number =>
  1200 * Math.log2(measured / expected);

// ---------------------------------------------------------------------------

describe('the hum is the pitch map, made audible (§3.8)', () => {
  /**
   * The readout, measured at each tier.
   *
   * Measured error is +2.7 to +5.8 cents and it is **not** estimator error — `estimateF0` reads a
   * pure sine to within 0.1 cents. It is the hum's own 0.7 % detuned second oscillator pulling
   * the composite period sharp by roughly its share of the mix. Recorded here because the
   * alternative is somebody chasing a five-cent bias through the FFT for an afternoon.
   */
  it.each(HALO_PITCH_POINTS)('reads $radiusM m as $hz Hz', ({ radiusM, hz, windowSec }) => {
    const [from, to] = windowSec;
    const measured = estimateF0(swept, from, to);
    expect(measured).toBeGreaterThan(0); // 0 would mean "no pitch here" — a dead readout
    expect(Math.abs(centsBetween(measured, hz))).toBeLessThan(HALO_PITCH_TOLERANCE_CENTS);
    // And the spec table agrees with the function the game reads the radius through.
    expect(hz).toBeCloseTo(humPitch(radiusM), 1);
  });

  /**
   * Monotonic, asserted separately from the absolute pitches.
   *
   * A map that got the three tiers right but inverted between them would pass every pin above
   * and be unusable — and inverted is a real failure mode, since it is one sign error in a
   * radius-to-pitch conversion.
   */
  it('rises tier by tier, and returns when the player goes quiet again', () => {
    const [crouch, walk, sprint] = HALO_PITCH_POINTS.map(({ windowSec }) =>
      estimateF0(swept, windowSec[0], windowSec[1]),
    );
    expect(walk!).toBeGreaterThan(crouch!);
    expect(sprint!).toBeGreaterThan(walk!);
    const back = estimateF0(swept, BACK_TO_QUIET[0], BACK_TO_QUIET[1]);
    expect(Math.abs(centsBetween(back, crouch!))).toBeLessThan(HALO_PITCH_TOLERANCE_CENTS);
  });

  /**
   * A plateau holds its pitch instead of sliding toward the stance that ends it.
   *
   * This is the assertion that pays for itself. A WebAudio ramp interpolates from the *previous
   * event*, so a hum that skipped scheduling while the radius sat still would leave its previous
   * event at the start of the plateau — and the ramp that finally ends the plateau then sweeps
   * across the whole of it. Measured, with the no-op skip in place: the crouch reads 66 Hz in its
   * first half and 68 Hz in its second, on its way to a walk that has not happened yet. The
   * readout would be reporting the future, which is the one thing §3.7 says the renderer must
   * never do and the same argument applies to the ear.
   *
   * Both halves sit before the near-unison's first beat null at ~1.05 s, where `estimateF0`
   * correctly answers "no pitch here" and there is nothing to compare.
   */
  it('holds a plateau still rather than sliding toward the stance that ends it', () => {
    const early = estimateF0(swept, 0.2, 0.6);
    const late = estimateF0(swept, 0.6, 1.0);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
    expect(Math.abs(centsBetween(late, early))).toBeLessThan(HALO_PITCH_TOLERANCE_CENTS / 2);
  });

  /**
   * A reading that arrives late changes nothing.
   *
   * Automation is a sorted timeline, not a queue: an event inserted behind the ramp already in
   * flight lands *between* two frames that were scheduled long ago, and the readout chirps at a
   * moment that has nothing to do with what the player was doing. There is no legitimate caller
   * for it — `Game.update` pushes at `ctx.currentTime`, which only moves forward — so the right
   * answer is to drop it, and the assertion is that the render is bit-for-bit what it was.
   */
  it('drops a push that arrives behind the ramp already in flight', async () => {
    const stale = await renderOffline(1.5, (ctx, master) => {
      const hum = driveSteady(ctx, master, 1.5, DUCK_HELD_M);
      hum.setRadius(HALO_MAX_RADIUS_M, 0.2);
    });
    const reference = stale.length;
    let worst = 0;
    for (let channel = 0; channel < stale.numberOfChannels; channel++) {
      const a = stale.getChannelData(channel);
      const b = plain.getChannelData(channel);
      for (let i = 0; i < reference; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
    }
    expect(worst).toBe(0);
  });
});

describe('the level is not the readout (§3.8)', () => {
  it('is finite, leaves headroom, and sits at the level §3.8 asks for', () => {
    expect(hasNaN(swept)).toBe(false);
    const peak = peakInfo(swept);
    expect(peak.clipped).toBe(false);
    expect(peak.peakDb).toBeLessThan(MAX_PEAK_DBFS);
    // "Level stays low and near-constant (≈ −21 dBFS) ... so the tone can sit under everything
    // without fatiguing." A hum the player mutes is a readout the player does not have.
    expect(Math.abs(peak.peakDb - HALO_PEAK_DBFS.value), HALO_PEAK_DBFS.why)
      .toBeLessThanOrEqual(HALO_PEAK_DBFS.tol);
  });

  /**
   * The claim a listening test would never make and the one most worth having.
   *
   * If level tracked radius, the hum would be loudest while sprinting — drowning the footsteps
   * that are the player's main source of geometry (§3.3: "moving fast **is** scanning") at
   * exactly the moment the readout matters. Pitch carries the information; level stays put.
   */
  it('keeps its level near-constant, so the readout never masks what it reports on', () => {
    const levels = HALO_PITCH_POINTS.map(({ windowSec }) =>
      rmsDb(swept, undefined, windowSec[0], windowSec[1]),
    );
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(HALO_LEVEL_SPREAD_MAX_DB);
    // Specifically: sprinting is not the loudest tier. Most of the spread is the 520 Hz lowpass
    // treating a 63 Hz fundamental differently from a 220 Hz one, not the hum getting louder.
    const sprintLevel = levels[levels.length - 1]!;
    expect(sprintLevel).toBeLessThan(Math.max(...levels) + 0.01);
  });
});

describe('it gets out of the way of events (§3.8)', () => {
  const against = (buffer: typeof plain, from: number, to: number): number =>
    rmsDb(buffer, undefined, from, to) - rmsDb(plain, undefined, from, to);

  it('drops out from under the event and climbs back on its own', () => {
    expect(against(ducked, 0.53, 0.56)).toBeLessThan(-HALO_DUCK.minDepthDb);
    const backAt = DUCK_AT + HALO_DUCK.recoveredBySec;
    expect(Math.abs(against(ducked, backAt, backAt + 0.5)))
      .toBeLessThan(HALO_DUCK.recoveredWithinDb);
  });

  /**
   * Nothing before the event moves.
   *
   * The duck is scheduled ahead of time here, which is the case that catches a retrigger built
   * out of ramps: cancelling a linear ramp that spans the cancel time rewrites the automation
   * *before* it, and the hum would step down a fraction of a second early — audibly, and for a
   * reason nobody would find.
   */
  it('leaves everything before the event exactly as it was', () => {
    expect(Math.abs(against(ducked, 0.2, 0.48))).toBeLessThan(0.01);
  });

  /**
   * A burst holds the hum down instead of pumping it back up between steps.
   *
   * A sprint lands a footfall every ~350 ms against a 120 ms release, so overlapping ducks are
   * the normal case. By 0.78 s a single duck has recovered to within a decibel; the burst is
   * still down, because each duck starts from where the last one had got to.
   */
  it('stays down through a burst rather than pumping between steps', () => {
    expect(against(ducked, 0.78, 0.81)).toBeGreaterThan(-1);
    expect(against(burst, 0.78, 0.81)).toBeLessThan(-HALO_DUCK.minDepthDb);
    // Held down across the whole burst, not sawtoothing between steps: a duck that restarted
    // from full gain each time would spend most of its 60 ms gaps on the way back down.
    expect(against(burst, 0.5, 0.8)).toBeLessThan(-HALO_DUCK.minDepthDb);
    // And it still recovers afterwards — a duck that latched would be worse than none.
    expect(Math.abs(against(burst, 1.6, 2.4))).toBeLessThan(HALO_DUCK.recoveredWithinDb);
  });

  /**
   * A cluster tighter than the hold leaves no stale release behind.
   *
   * Each duck schedules its own recovery 50 ms out. A duck arriving 30 ms later must take that
   * recovery *off* the timeline, or it fires anyway — from underneath the newer duck — and the
   * hum starts climbing back while events are still landing on it. Measured: 13.4 dB down at the
   * end of the cluster with the old release cancelled, 7.0 dB with it left in place, which is
   * half the duck given away in the exact case the duck was written for.
   */
  it('does not let a superseded recovery fire from under the next event', () => {
    expect(against(cluster, CLUSTER_LAST + 0.03, CLUSTER_LAST + 0.06))
      .toBeLessThan(-HALO_DUCK.minDepthDb - 4);
    expect(Math.abs(against(cluster, 1.6, 2.4))).toBeLessThan(HALO_DUCK.recoveredWithinDb);
  });

  /**
   * What ducks is the readout, never the world.
   *
   * A duck automated on the master bus would attenuate the very event it was making room for —
   * the mixer would be quietly deciding that a footstep landing near the player is worth less
   * than one landing in silence, in a currency §3.3 never priced. So a loud neighbour on the
   * same master is rendered beside the hum and must not notice the duck at all.
   */
  it('ducks itself and nothing else on the master', async () => {
    const beside = async (duck: boolean): Promise<number> => {
      const buffer = await renderOffline(1.5, (ctx, master) => {
        const hum = driveSteady(ctx, master, 1.5, DUCK_HELD_M);
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 1000;
        const gain = ctx.createGain();
        gain.gain.value = 0.3;
        osc.connect(gain);
        gain.connect(master);
        osc.start(0);
        if (duck) hum.duck(DUCK_AT);
      });
      return rmsDb(buffer, undefined, 0.52, 0.6);
    };
    expect(Math.abs((await beside(true)) - (await beside(false))))
      .toBeLessThan(HALO_DUCK.bleedMaxDb);
  });

  /**
   * Stopping leaves silence rather than a click or a tail.
   *
   * The hum is the one voice that would otherwise outlive the game — every other sound is a
   * strike already scheduled to end — so `dispose` has to be able to end it, and ending an
   * oscillator without a fade is a step discontinuity, which is a click.
   */
  /**
   * Stopping takes the level down, and it does it in the fade and not at `osc.stop`.
   *
   * The two windows are the whole point. `[1.10, 1.20]` is five fade constants after the stop
   * and still before the oscillators are released, so it can only be quiet if the *fade* made it
   * quiet: drop the fade and the hum keeps sounding at full level right through it, which is the
   * readout still talking about a rig that stopped.
   *
   * There is no step detector here, and that is a measured decision rather than an omission. A
   * click is a discontinuity, invisible to peak (it is a drop *to* zero) and to RMS (one sample),
   * so the obvious instrument is the largest sample-to-sample step. Built and measured, it does
   * not discriminate: the running hum's own slew is 0.00182 and cutting the oscillators dead
   * reads 0.00232 — 1.3×, and only because of where the phase happened to land. The 520 Hz
   * lowpass the bank passes through is why. Its impulse response is long next to one sample at
   * 48 kHz, so it smears any cut downstream of it into a slope; the filter is already the
   * anti-click, and a detector that mostly measures the filter would pass against broken code.
   */
  it('fades out when stopped, and leaves no tail', async () => {
    const stopped = await renderOffline(2, (ctx, master) => {
      driveSteady(ctx, master, 1, DUCK_HELD_M).stop(1);
    });
    expect(hasNaN(stopped)).toBe(false);
    const peak = peakInfo(stopped);
    expect(peak.clipped).toBe(false);
    expect(Math.abs(peak.peakDb - HALO_PEAK_DBFS.value)).toBeLessThanOrEqual(HALO_PEAK_DBFS.tol);

    // Measured: −50.1 dB below the running hum with the fade, +2.8 dB above it without one.
    const running = rmsDb(stopped, undefined, 0.3, 0.9);
    expect(rmsDb(stopped, undefined, 1.1, 1.2) - running).toBeLessThan(-30);
    expect(rmsDb(stopped, undefined, 1.5, 2)).toBeLessThan(-120);
  });
});
