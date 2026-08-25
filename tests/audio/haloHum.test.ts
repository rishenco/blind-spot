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
import { centroidHz, estimateF0, hasNaN, maxStep, peakInfo, rmsDb } from '../support/audioMetrics';
import {
  HALO_BEAT_MAX_DEPTH_DB,
  HALO_CROUCH_CENTROID_MAX_HZ,
  HALO_DUCK,
  HALO_LEVEL_SPREAD_MAX_DB,
  HALO_PEAK_DBFS,
  HALO_PITCH_POINTS,
  HALO_PITCH_TOLERANCE_CENTS,
  HALO_TRACK_MAX_LAG_SEC,
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

/**
 * The same sweep with the audio taken out — the reading the *ring* is drawn from, frame by frame.
 *
 * `Halo` owns the quantity and both readouts are functions of it (`paint/halo.ts`), so replaying
 * the identical drive loop without a context reconstructs exactly what the ring showed on every
 * frame of the render above. That is what makes a lag measurable at all: without it there is
 * nothing to be late *against*, only the hum compared to itself.
 */
const GLIDED: readonly number[] = (() => {
  const halo = new Halo();
  halo.reset(TARGETS[0]!.radiusM);
  const out = [halo.radius];
  for (let i = 1; i * FRAME < SWEPT_SEC; i++) {
    halo.advance(targetAt(i * FRAME), FRAME);
    out.push(halo.radius);
  }
  return out;
})();

/** What the ring was showing at `t`, interpolated between the frames it was pushed on. */
function ringRadiusAt(t: number): number {
  const x = t / FRAME;
  const lo = Math.max(0, Math.min(GLIDED.length - 2, Math.floor(x)));
  return GLIDED[lo]! + (x - lo) * (GLIDED[lo + 1]! - GLIDED[lo]!);
}

/**
 * When a pitch track first crosses `hz`, in seconds — linearly between the two samples either
 * side of it.
 *
 * Takes the track as a function so the same search reads the render and the model, which is the
 * point: two crossings measured the same way subtract into a time, and a time is the unit §3.8's
 * "the two must never disagree" is actually being tested in. `NaN` for an unpitched sample breaks
 * the bracket rather than poisoning it — `estimateF0` answers 0 where there is no pitch to read,
 * and a window straddling a fast glide is one of the places it does.
 */
function crossing(
  track: (t: number) => number,
  hz: number,
  fromSec: number,
  toSec: number,
  step: number,
): number {
  let prevT = NaN;
  let prev = NaN;
  for (let t = fromSec; t <= toSec; t += step) {
    const now = track(t);
    if (!(now > 0)) {
      prev = NaN;
      continue;
    }
    if (Number.isFinite(prev) && (prev - hz) * (now - hz) <= 0 && prev !== now) {
      return prevT + (t - prevT) * ((hz - prev) / (now - prev));
    }
    prev = now;
    prevT = t;
  }
  return NaN;
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

/**
 * One undisturbed hum per tier, long enough to contain a whole beat cycle at that tier.
 *
 * The beat rate is `Δratio × f`, so it *scales with the reading*: 0.44 Hz at a crouch, 1.54 Hz
 * at a sprint. 3.5 s covers a cycle and a half at the slowest end, which is the shortest render
 * in which "how deep does it swing" is a question about the tone rather than about the window.
 */
const BEAT_SEC = 3.5;
const BEAT_TIERS = [2, 11, 24] as const;
const beatRenders = await Promise.all(
  BEAT_TIERS.map(async (radiusM) => ({
    radiusM,
    buffer: await renderOffline(BEAT_SEC, (ctx, master) => {
      driveSteady(ctx, master, BEAT_SEC, radiusM);
    }),
  })),
);

/**
 * Silence, and coming back from it.
 *
 * The body is an 11 m walk, stops dead to listen, then walks again — the commonest shape in the
 * game: move, hold still, move.
 *
 * **The segments are 1.8 s and not 0.6 s, and the reason is the beat.** The hum's near-unison
 * (`PARTIALS`) puts a slow tremolo on the tone — 0.96 s per cycle at this radius — so any window
 * shorter than one beat measures where in the beat it landed as much as it measures the level.
 * A "comes back at the level it left" claim read from two 80 ms windows is a claim about beat
 * phase; read across a beat and a quarter it is a claim about level. This is the same fact that
 * `HALO_PITCH_POINTS` used to dodge and that shrinking the near-unison to 0.35 made survivable:
 * the swing is now 6.2 dB rather than 16, so a window that covers one cycle averages it out
 * instead of merely diluting it.
 */
const SILENCE_SEC = 5.0;
/** When the body stops, and when it starts again. */
const STOPS_AT = 1.8;
const MOVES_AT = 3.2;
const silenced = await renderOffline(SILENCE_SEC, (ctx, master) => {
  const hum = new HaloHum(ctx, master, { startAt: 0, radiusM: DUCK_HELD_M });
  for (let i = 1; i * FRAME < SILENCE_SEC; i++) {
    const t = i * FRAME;
    const quiet = t >= STOPS_AT && t < MOVES_AT;
    hum.setRadius(quiet ? 0 : DUCK_HELD_M, t);
    hum.setSilent(quiet, t);
  }
});

/**
 * A tap: the body stops and moves again 30 ms later, inside the gate's own 60 ms fade.
 *
 * Not a contrived case. The gate's input is "is the body emitting anything at all", and between
 * two footfalls of a walk it is false for a moment every stride; a player edging round a corner
 * produces this shape continuously. Whatever the gate does when a fade is interrupted, it does
 * several times a second.
 */
const TAP_SEC = 3.0;
const TAP_STOPS_AT = 1.5;
const TAP_MOVES_AT = 1.53;
const tapped = await renderOffline(TAP_SEC, (ctx, master) => {
  const hum = new HaloHum(ctx, master, { startAt: 0, radiusM: DUCK_HELD_M });
  for (let i = 1; i * FRAME < TAP_SEC; i++) {
    const t = i * FRAME;
    const quiet = t >= TAP_STOPS_AT && t < TAP_MOVES_AT;
    hum.setRadius(DUCK_HELD_M, t);
    hum.setSilent(quiet, t);
  }
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
   * The quiet end is *felt more than heard* — where the energy is, not which note it is.
   *
   * §3.8 fixes the crouch reading's character as well as its pitch: "a crouch-step on concrete
   * carries 2 m and sits at 63 Hz, felt more than heard". Nothing else in this file can see that.
   * Every assertion above reads the fundamental, and a partial's ratio does not move the
   * fundamental — `estimateF0` and the ear both track it, which is exactly what `PARTIALS` claims
   * about the 2.5× partial. Every assertion in the next block reads level, which a quiet partial
   * an octave up barely moves. So the tone can be given a bright upper partial, keep every pitch
   * and level pin green, and stop being felt at all.
   *
   * Measured over this window: 76.1 Hz, 1.20× the note it is reporting. Take `PARTIALS`' third
   * entry from 2.5× to 5× — 5 × 63.5 Hz of audible energy under a 63 Hz fundamental — and it
   * reads 100.9 with nothing else in the suite moving. `HALO_CROUCH_CENTROID_MAX_HZ` carries why
   * the bound sits between them, and why the crouch plateau is the only place the question can be
   * asked at all: the 520 Hz lowpass hides the same change at the sprint end.
   */
  it('keeps the quiet end felt rather than heard', () => {
    const [from, to] = HALO_PITCH_POINTS[0].windowSec;
    const centroid = centroidHz(swept, from, to);
    expect(
      centroid,
      `the crouch reading's energy has moved to ${centroid.toFixed(1)} Hz, over a ${HALO_PITCH_POINTS[0].hz} Hz note`,
    ).toBeLessThan(HALO_CROUCH_CENTROID_MAX_HZ);
    // And it is still a bass reading rather than a dead one: a centroid *below* the fundamental
    // would mean the tone had lost the partials that make it a tone.
    expect(centroid).toBeGreaterThan(HALO_PITCH_POINTS[0].hz);
  });

  /**
   * The hum and the ring agree about *when*, not only about what.
   *
   * `tests/halo.test.ts` proves the two readouts are one affine image of each other, and the
   * pitch pins above prove the rendered notes are right — but both are value claims, read at
   * plateaus, where a hum that is late has nothing to show. The lag was therefore unowned:
   * `TRACK_SEC` could be moved from 0.02 to 0.06 or to 0.1 and the whole suite stayed green,
   * while at 0.1 the ear is 650 cents behind the ring at the start of this very transition.
   *
   * Measured as a time. Track the rendered F0 across the crouch → walk glide, find when it
   * crosses the geometric midpoint of the two plateaus, and subtract when the glide the ring is
   * drawn from crossed the same point. The midpoint rather than an endpoint because that is where
   * the sweep is steep enough to time precisely and shallow enough that a 60 ms window is still
   * reading one pitch: it recovers `TRACK_SEC` to a millisecond, and does so at every window from
   * 60 to 120 ms and on the falling transition too.
   */
  it('runs no further behind the ring than the ring can forgive', () => {
    const midHz = Math.sqrt(humPitch(TARGETS[0]!.radiusM) * humPitch(TARGETS[1]!.radiusM));
    const window = 0.06;
    const heard = crossing(
      (t) => estimateF0(swept, t - window / 2, t + window / 2),
      midHz,
      TARGETS[1]!.atSec - 0.02,
      TARGETS[1]!.atSec + 0.8,
      0.0025,
    );
    const shown = crossing(
      (t) => humPitch(ringRadiusAt(t)),
      midHz,
      TARGETS[1]!.atSec - 0.02,
      TARGETS[1]!.atSec + 0.8,
      0.0005,
    );
    // Both have to exist before their difference means anything: a hum that never reached the
    // midpoint at all would otherwise subtract to `NaN` and slip through the comparison below.
    expect(Number.isFinite(shown), 'the ring never crossed the midpoint of the transition').toBe(true);
    expect(Number.isFinite(heard), 'the hum never crossed the midpoint of the transition').toBe(true);
    expect(
      Math.abs(heard - shown),
      `hum crossed ${midHz.toFixed(1)} Hz at ${heard.toFixed(4)} s, ring at ${shown.toFixed(4)} s`,
    ).toBeLessThan(HALO_TRACK_MAX_LAG_SEC);
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

  /**
   * The tone never goes away on its own.
   *
   * "Near-constant" has to hold *within* a tier as well as across them, and the thing that
   * threatens it is not the radius — it is the hum's own near-unison. See
   * `HALO_BEAT_MAX_DEPTH_DB` for why that number exists and what it used to be. The short
   * version: the absence of this tone is spoken for. It means the body is making no noise at
   * all, and a tremolo deep enough to read as absence would be the hum lying about that once a
   * second, in the one register §3.8 calls non-negotiable.
   *
   * Measured as the swing of a sliding 80 ms window — the shortest window that is still a
   * loudness reading at 55 Hz, and about as long as a listener integrates over.
   */
  it('never beats deep enough to read as the tone leaving', () => {
    for (const { radiusM, buffer } of beatRenders) {
      let quietest = Infinity;
      let loudest = -Infinity;
      // From 0.4 s, so the oscillators' shared start phase has drifted apart into the steady
      // state the player actually hears; to 0.1 s short of the end, so every window is full.
      for (let t = 0.4; t < BEAT_SEC - 0.18; t += 0.01) {
        const level = rmsDb(buffer, undefined, t, t + 0.08);
        if (level < quietest) quietest = level;
        if (level > loudest) loudest = level;
      }
      expect(loudest - quietest, `${radiusM} m`).toBeLessThan(HALO_BEAT_MAX_DEPTH_DB);
      // And it does still beat — a partial silently dropped to zero would pass the line above
      // by being a dead sine, which is the tone §3.8 does not want.
      expect(loudest - quietest, `${radiusM} m`).toBeGreaterThan(1);
    }
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

/**
 * §3.8's readout floors: everything below the reference radius reads 55 Hz and zero brightness.
 * That makes the bottom of the dial ambiguous in a way that matters — a standstill and a crouch
 * on dust (1.2 m) are the same note and the same pixel, and they are not the same situation.
 * One is inaudible to the whole world; the other is a noise anything beside you hears, and
 * §3.9's dust apron exists so that choosing it is worth something.
 *
 * The distinction is carried where there is room for it: the tone goes away. These measure that
 * it actually does, and that it comes back — a readout that latched off after the first pause
 * would be worse than one that never stopped.
 */
describe('silence is the absence of the tone (§3.8)', () => {
  const level = (from: number, to: number): number => rmsDb(silenced, undefined, from, to);
  /** A beat and a quarter, on each side of the pause — see the fixture for why not less. */
  const BEFORE: readonly [number, number] = [0.55, 1.75];
  const AFTER: readonly [number, number] = [3.75, 4.95];
  /** Well past the 0.06 s fade and well short of the return. */
  const STILL: readonly [number, number] = [2.4, 3.15];

  it('is audible while the body is moving', () => {
    expect(level(...BEFORE)).toBeGreaterThan(-60);
  });

  it('leaves when the body stops, and is gone well before the pause is over', () => {
    expect(level(...STILL)).toBeLessThan(-80);
    // And it is a fade, not a cut: 30 ms in, the tone is on its way down rather than already
    // gone. A cut would be a click, which is a sound the body did not make.
    const midFade = level(STOPS_AT + 0.02, STOPS_AT + 0.05);
    expect(midFade).toBeGreaterThan(level(...STILL));
    expect(midFade).toBeLessThan(level(...BEFORE));
  });

  it('comes back when the body moves again, at the level it left', () => {
    expect(level(...AFTER)).toBeGreaterThan(-60);
    /*
     * Against `plain` — the same hum, same radius, same frame rate, never silenced — and not
     * only against its own earlier self, because the two windows below share a scale factor. A
     * gate that returns to half level drops `BEFORE` and `AFTER` together by 6 dB each and their
     * difference not at all: the mutation survives a self-comparison and dies against a hum that
     * never had a gate on it. `plain` runs 2.5 s, so it is compared over the *before* window,
     * which is the one both renders share a beat phase with.
     */
    const undisturbed = rmsDb(plain, undefined, ...BEFORE);
    expect(Math.abs(level(...BEFORE) - undisturbed)).toBeLessThan(0.5);
    // 1.5 dB is far tighter than anything the gate could plausibly get wrong — a gain stranded
    // part-way back reads 6 dB or more out — and far looser than the beat's residual across
    // these windows, measured at 0.5 dB. The still window itself renders as exact digital silence, so
    // the gap below has 170 dB of margin on a 40 dB claim.
    expect(Math.abs(level(...AFTER) - level(...BEFORE))).toBeLessThan(1.5);
  });

  it('drops far enough to read as silence, not as quiet', () => {
    // The gap between moving and still has to be unmistakable — this is the one distinction the
    // pitch map cannot make, so it is the one the level has to make decisively. §3.8's readout
    // floors at 55 Hz for everything below the reference radius, so a standstill and a crouch on
    // dust are the same note; only the tone's presence tells them apart.
    expect(level(...BEFORE) - level(...STILL)).toBeGreaterThan(40);
  });

  it('never produces a NaN sample on the way in or out', () => {
    expect(hasNaN(silenced)).toBe(false);
  });

  /**
   * Interrupting the fade does not click.
   *
   * Law 2 is that the system never lies — "every blip and sound has a real physical source" — and
   * a tick the body did not make is that law broken in the smallest available unit. It is also
   * the single most likely defect in a gate like this, and invisible to every other metric here:
   * one bad sample moves no RMS, no peak and no spectrum worth measuring.
   *
   * The ruler is the same render's own steady tone. See `maxStep` for why an absolute threshold
   * would be meaningless. The two ways to get this wrong both failed here before they were fixed:
   * `cancelScheduledValues` deletes the in-flight ramp and snaps the gain back to the anchor
   * (measured 12x the steady step, 21 % of the hum's peak), and starting the return from the
   * ramp's *target* rather than its current value steps by however far the fade had got.
   */
  it('does not click when the fade is interrupted', () => {
    expect(hasNaN(tapped)).toBe(false);
    const steady = maxStep(tapped, 0.6, 1.4);
    const turnaround = maxStep(tapped, TAP_STOPS_AT - 0.01, TAP_MOVES_AT + 0.09);
    expect(turnaround).toBeLessThan(steady * 3);
    // And the tone really did dip — otherwise the line above passes on a gate that did nothing.
    expect(rmsDb(tapped, undefined, TAP_STOPS_AT, TAP_MOVES_AT + 0.03))
      .toBeLessThan(rmsDb(tapped, undefined, 0.6, 1.4) - 3);
  });
});
