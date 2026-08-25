/**
 * The Halo — §3.8's self-readout, on the simulation side.
 *
 * §3.8 is the one place the vision doc writes *non-negotiable*: "a ring around the reticle whose
 * brightness equals your current audible radius, plus a matching hum pitch. You always know
 * exactly how loud you are." Two readouts, one quantity — so the failure this file is built to
 * catch is not either readout being wrong on its own. It is the two of them being computed in
 * two places and drifting, which is silent, survives every unit test written per-readout, and
 * ends with a player trusting the ring and ignoring the hum.
 *
 * The audible half of the readout is measured phonometrically in `tests/audio/haloHum.test.ts`;
 * that file renders the tone and reads its pitch back out of the samples. This one is about the
 * *number* both faces are drawn from: where it comes from, that it is continuous, and that it is
 * the same number the sound bus will charge the player for.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Aabb } from '../src/core/collision';
import {
  HALO_GLIDE_SEC,
  HALO_MAX_HZ,
  HALO_MAX_RADIUS_M,
  HALO_REFERENCE_HZ,
  HALO_REFERENCE_M,
  Halo,
  haloBrightness,
  humPitch,
} from '../src/paint/halo';
import { MAT_CONCRETE, MAT_DUST, MAT_METAL, MAT_STONE, materialLoudness } from '../src/paint/materials';
import {
  PLAYER_EMITTER_ID,
  SOUND_CLASSES,
  SoundBus,
  isContactClass,
  type SoundClass,
  type SoundEvent,
} from '../src/paint/soundEvents';
import { createHeadlessGame, type HeadlessGame } from '../src/game/headless';
import { TIME_SCALES, stepClassOf } from '../src/game/sim';
import { HALO_ALPHA_EPSILON, HALO_RING_MIN_ALPHA, haloRingAlpha } from '../src/ui/hud';
import { HALO_PITCH_POINTS, HALO_PITCH_TOLERANCE_CENTS } from './support/audioSpec';

const STEP_CLASSES = ['crouch-step', 'walk-step', 'sprint-step'] as const;
const MATERIALS = [MAT_DUST, MAT_CONCRETE, MAT_STONE, MAT_METAL] as const;

const cents = (a: number, b: number): number => 1200 * Math.log2(a / b);

describe('the pitch map (§3.8)', () => {
  it('is 55·√(r/1.5) — the reference radius reads 55 Hz', () => {
    // The formula the doc fixes, at the point it fixes it to. Everything below is this line
    // evaluated somewhere else, so if this one is wrong nothing else in the file means anything.
    expect(humPitch(HALO_REFERENCE_M)).toBeCloseTo(HALO_REFERENCE_HZ, 10);
    expect(humPitch(6)).toBeCloseTo(HALO_REFERENCE_HZ * Math.sqrt(4), 10);
    expect(humPitch(24)).toBeCloseTo(220, 6);
  });

  it('agrees with the pins the rendered hum is measured against', () => {
    // `HALO_PITCH_POINTS` is what `tests/audio/haloHum.test.ts` asserts the *rendered tone*
    // against. If this map and that table disagreed, the two halves of the readout would be
    // calibrated to different curves and the phonometric suite would be measuring a fiction.
    for (const point of HALO_PITCH_POINTS) {
      expect(Math.abs(cents(humPitch(point.radiusM), point.hz))).toBeLessThan(
        HALO_PITCH_TOLERANCE_CENTS,
      );
    }
  });

  it('is strictly increasing everywhere inside the range', () => {
    // The readout's whole claim is "louder reads higher". A map that plateaued anywhere would
    // make two different loudnesses indistinguishable at exactly the radius they diverged.
    let previous = -Infinity;
    for (let r = HALO_REFERENCE_M; r <= HALO_MAX_RADIUS_M; r += 0.05) {
      const hz = humPitch(r);
      expect(hz).toBeGreaterThan(previous);
      previous = hz;
    }
  });

  it('floors at the reference rather than going silent or negative', () => {
    // A body standing still emits nothing, and a pitch cannot encode zero. The floor is the
    // honest reading: "nothing more than a metre and a half away can hear you."
    for (const r of [0, 0.001, 1, 1.4999, -5, -Infinity]) {
      expect(humPitch(r)).toBe(HALO_REFERENCE_HZ);
    }
  });

  it('ceilings at the loudest reading rather than running away', () => {
    for (const r of [HALO_MAX_RADIUS_M, HALO_MAX_RADIUS_M + 1, 1e6, Infinity]) {
      expect(humPitch(r)).toBe(HALO_MAX_HZ);
    }
  });

  it('answers the floor for NaN instead of poisoning the readout', () => {
    // A NaN radius does not throw; it makes every downstream comparison false and the readout
    // goes dead — which is precisely the complaint §3.8 exists to answer.
    expect(humPitch(NaN)).toBe(HALO_REFERENCE_HZ);
    expect(haloBrightness(NaN)).toBe(0);
  });
});

describe('two readouts, one quantity (§3.8)', () => {
  it('spans exactly 0 to 1 across the range the readout can express', () => {
    expect(haloBrightness(HALO_REFERENCE_M)).toBeCloseTo(0, 12);
    expect(haloBrightness(HALO_MAX_RADIUS_M)).toBeCloseTo(1, 12);
    expect(haloBrightness(0)).toBe(0);
    expect(haloBrightness(1e6)).toBeCloseTo(1, 12);
  });

  it('is an affine image of the pitch — the two faces cannot disagree about anything', () => {
    // This is the assertion the file exists for, and it is deliberately stronger than "both go
    // up together". Brightness and pitch must be the *same* function of the radius up to a
    // linear rescale, so that the normalised position of any radius is identical on both dials.
    //
    // The tempting independent implementation — brightness = r / max — passes an ordering test
    // and fails this one: at the walk carry (11 m) it reads 0.31 of the ring's span while the
    // hum sits at 0.44 of its own. The ring would be saying "a third as loud as a sprint" while
    // the hum said "nearly half", and a player reading both is reading two different games.
    const span = HALO_MAX_HZ - HALO_REFERENCE_HZ;
    for (let r = HALO_REFERENCE_M; r <= HALO_MAX_RADIUS_M; r += 0.25) {
      expect(haloBrightness(r)).toBeCloseTo((humPitch(r) - HALO_REFERENCE_HZ) / span, 12);
    }
    // Named checkpoint, so the identity above is also legible as a claim about the game: a walk
    // on concrete sits 40 % of the way up *both* dials, where `r / max` would put it at 26 %.
    expect(haloBrightness(11)).toBeCloseTo(0.398, 3);
    expect(11 / HALO_MAX_RADIUS_M).toBeCloseTo(0.262, 3);
  });

  it('never orders two radii differently on the two dials', () => {
    const radii = [0, 1.2, 2, 3, 6.6, 11, 14.4, 16.5, 24, 27.6, 36, 100];
    for (const a of radii) {
      for (const b of radii) {
        expect(Math.sign(haloBrightness(a) - haloBrightness(b))).toBe(
          Math.sign(humPitch(a) - humPitch(b)),
        );
      }
    }
  });
});

describe('the ceiling covers the game (§3.3, §3.9)', () => {
  it('is the loudest noise the body can make, with nothing to spare', () => {
    // Derived by sweeping the tables rather than written down, so that a louder material, a
    // louder landing or a new class raises the top of the dial instead of silently saturating
    // against it. Both directions matter: a ceiling below the loudest noise pegs the readout
    // exactly where the player most needs resolution, and one far above it wastes the dial.
    //
    // The sweep is over *every* class and not just the strides, which is the correction this
    // test carries. While the readout could only see the gait ladder, the ceiling was a sprint
    // on steel (36 m) and that was consistent. Now that a ping and a landing reach the ring, a
    // 36 m ceiling would peg on a landing (28 m, and 42 on steel) — §3.4's loud class, the one
    // that bleeds through floors, flattened against the top of its own dial.
    const bus = new SoundBus();
    let loudest = 0;
    for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
      // Contact classes take a surface, the pings strike nothing — the same split §3.9 makes,
      // asked of the shipped predicate rather than restated as a list. A landing is a contact
      // class and is not in STEP_CLASSES, which is exactly the row this test is here to cover.
      const mats = isContactClass(cls) ? MATERIALS : [undefined];
      for (const mat of mats) {
        const r = bus.carryRadius(cls, mat);
        expect(r).toBeLessThanOrEqual(HALO_MAX_RADIUS_M);
        if (r > loudest) loudest = r;
      }
    }
    expect(loudest).toBeCloseTo(HALO_MAX_RADIUS_M, 10);
    expect(HALO_MAX_RADIUS_M).toBeCloseTo(28 * 1.5, 10);
    // And a sprint on steel, the old ceiling, now has real dial above it.
    expect(haloBrightness(24 * 1.5)).toBeLessThan(1);
    expect(haloBrightness(24 * 1.5)).toBeGreaterThan(0.85);
  });

  it('reads the material voice, so dust and steel are different readings of one stride', () => {
    // The reading has to move with the surface or the ring cannot tell a player that the walkway
    // ahead is the loud one — which is the routing decision §3.9 says happens every few seconds.
    const bus = new SoundBus();
    const walkOn = (mat: number): number => bus.carryRadius('walk-step', mat);
    expect(walkOn(MAT_DUST) / walkOn(MAT_CONCRETE)).toBeCloseTo(materialLoudness(MAT_DUST), 10);
    expect(walkOn(MAT_METAL) / walkOn(MAT_CONCRETE)).toBeCloseTo(materialLoudness(MAT_METAL), 10);
    // And the readout follows it: the same stride is more than a quarter of the dial apart.
    // (0.28 today. It was 0.35 while the ceiling was a sprint's 36 m — raising the top to cover
    // landings stretches the dial, and every existing reading pays a little of that. Worth it:
    // a reading that is compressed is still a reading, and one that is pegged is not.)
    expect(haloBrightness(walkOn(MAT_METAL)) - haloBrightness(walkOn(MAT_DUST))).toBeGreaterThan(
      0.25,
    );
  });
});

describe('the glide (§3.8: "continuously rather than stepping between stances")', () => {
  it('passes through many distinct readings on the way, not three gears', () => {
    // §3.8: "quantizing the hum into gears would hide exactly the in-between states where you
    // most want to know how loud you are." The emitted radius *is* piecewise constant — three
    // step classes, four materials — so the continuity has to come from the glide, and this is
    // the assertion that a re-quantized implementation has to fail. A snap, or a three-gear
    // readout, produces two distinct pitches over this sweep; the glide produces dozens.
    const halo = new Halo();
    halo.reset(2);
    const pitches = new Set<number>();
    for (let i = 0; i < 60; i++) {
      halo.advance(24, 1 / 120);
      pitches.add(halo.pitchHz);
    }
    expect(pitches.size).toBeGreaterThan(50);
    // And they climb the whole way rather than jumping and sitting.
    const seen = [...pitches];
    expect(seen[0]).toBeGreaterThan(humPitch(2));
    expect(seen[0]).toBeLessThan(humPitch(6));
    expect(seen[seen.length - 1]).toBeGreaterThan(humPitch(22));
  });

  it('is monotone toward the target and reaches it', () => {
    const halo = new Halo();
    halo.reset(24);
    let previous = 24;
    for (let i = 0; i < 360; i++) {
      halo.advance(2, 1 / 120);
      expect(halo.radius).toBeLessThan(previous);
      expect(halo.radius).toBeGreaterThan(2);
      previous = halo.radius;
    }
    expect(halo.radius).toBeCloseTo(2, 4);
  });

  it('crosses most of the gap in one time constant, by construction', () => {
    // The tuning value has to mean something, and what it means is 1 − 1/e of the distance.
    // Pinned here so that changing HALO_GLIDE_SEC is a deliberate retune of a stated quantity
    // rather than a number nobody can check.
    const halo = new Halo();
    halo.reset(0);
    halo.advance(10, HALO_GLIDE_SEC);
    expect(halo.radius).toBeCloseTo(10 * (1 - Math.exp(-1)), 9);
  });

  it('reads the same at 60 Hz and at 480 Hz', () => {
    // A glide written as `r += (target - r) * rate` is frame-rate dependent, reads correctly at
    // the rate it was tuned at, and quietly reports a different loudness on a slower machine.
    const coarse = new Halo();
    const fine = new Halo();
    coarse.reset(1);
    fine.reset(1);
    for (let i = 0; i < 30; i++) coarse.advance(20, 1 / 60);
    for (let i = 0; i < 240; i++) fine.advance(20, 1 / 480);
    expect(coarse.radius).toBeCloseTo(fine.radius, 9);
  });

  it('holds still on a zero or backwards dt, and survives a NaN one', () => {
    const halo = new Halo();
    halo.reset(5);
    for (const dt of [0, -1 / 120, NaN]) {
      halo.advance(24, dt);
      expect(halo.radius).toBe(5);
      // The target still updates: a paused clock should not also freeze what the readout knows.
      expect(halo.targetRadius).toBe(24);
    }
  });

  it('treats a NaN or negative target as silence rather than passing it on', () => {
    const halo = new Halo();
    halo.reset(10);
    halo.advance(NaN, 1 / 120);
    expect(halo.targetRadius).toBe(0);
    expect(Number.isFinite(halo.radius)).toBe(true);
    halo.advance(-3, 1 / 120);
    expect(halo.targetRadius).toBe(0);
  });

  it('resets without gliding — a respawn is not a stance change', () => {
    const halo = new Halo();
    halo.reset(24);
    expect(halo.radius).toBe(24);
    expect(halo.targetRadius).toBe(24);
    halo.reset();
    expect(halo.radius).toBe(0);
    expect(halo.pitchHz).toBe(HALO_REFERENCE_HZ);
    expect(halo.brightness).toBe(0);
  });
});

/**
 * One scripted run: stand, walk, sprint, crouch, jump — with the bus tapped.
 *
 * Everything below is checked against a real `GameSim` rather than against a hand-fed `Halo`,
 * because the claim §3.8 makes is about the *game's* loudness, and the ways this can go wrong
 * are all in the wiring: a readout fed the paint radius, a readout that forgot the material, a
 * readout sampled before the body moved.
 */
interface Tap {
  readonly event: SoundEvent;
  /** The Halo's target at the end of the tick the event was emitted on. */
  readonly target: number;
}

/** Taps the bus and the Halo together while `drive` runs the game, one tick at a time. */
function tapRun(game: HeadlessGame, ticks: number, drive: (tick: number) => void): Tap[] {
  const pending: SoundEvent[] = [];
  const stop = game.sim.bus.subscribe((event) => {
    pending.push(event);
  });
  const taps: Tap[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    drive(tick);
    game.step();
    // Read *after* the tick, which is when the Halo has been advanced. The controller settles
    // velocity, stance and ground material before it fans out the footstep and touches none of
    // them afterwards, so this reading is the one the emitter saw.
    for (const event of pending) taps.push({ event, target: game.sim.halo.targetRadius });
    pending.length = 0;
  }
  stop();
  return taps;
}

/** Walk, sprint, crouch, walk, stop — every step class the body has, in one run. */
function scriptedRun(): Tap[] {
  const game = createHeadlessGame({ seed: 7 });
  return tapRun(game, 1200, (tick) => {
    if (tick === 60) game.input.hold('forward');
    if (tick === 300) game.input.hold('sprint');
    if (tick === 600) {
      game.input.release('sprint');
      game.input.hold('crouch');
    }
    if (tick === 850) game.input.release('crouch');
    if (tick === 1000) game.input.release('forward');
  });
}

const isStep = (tap: Tap): boolean => tap.event.class.endsWith('-step');

/**
 * The largest surface of each material a body could actually stand on, found in the world.
 *
 * Searched rather than written down, because the point of the walk below is that the readout
 * follows §3.9 on *whatever the room is made of* — and the room is content, which moves. A
 * hard-coded pair of coordinates would go quietly wrong the first time somebody rebuilt the
 * stairs; this goes loudly wrong instead, at the coverage assertion.
 *
 * "Could stand on": a top face big enough to take a stride, low enough to be floor rather than
 * ceiling or the top of a full-height wall, and with head clearance above it.
 */
function standableSlabs(boxes: readonly Aabb[]): Map<number, Aabb> {
  const area = (b: Aabb): number => (b.maxX - b.minX) * (b.maxZ - b.minZ);
  const best = new Map<number, Aabb>();
  for (const b of boxes) {
    if (b.maxY > 3 || area(b) < 2) continue;
    const clear = boxes.every(
      (o) =>
        o === b ||
        o.maxY <= b.maxY + 0.05 ||
        o.minY >= b.maxY + 2.2 ||
        o.maxX <= b.minX ||
        o.minX >= b.maxX ||
        o.maxZ <= b.minZ ||
        o.minZ >= b.maxZ,
    );
    if (!clear) continue;
    const current = best.get(b.mat);
    if (current === undefined || area(b) > area(current)) best.set(b.mat, b);
  }
  return best;
}

/** Spawns on a slab at one end and walks the length of it. */
function walkAcross(box: Aabb): Tap[] {
  const alongX = box.maxX - box.minX >= box.maxZ - box.minZ;
  // Yaw is the room's convention: −90° faces +X, −180° faces −Z.
  const at = alongX
    ? new THREE.Vector3(box.minX + 0.6, box.maxY + 0.02, (box.minZ + box.maxZ) / 2)
    : new THREE.Vector3((box.minX + box.maxX) / 2, box.maxY + 0.02, box.maxZ - 0.6);
  const game = createHeadlessGame({ seed: 3 });
  game.sim.player.setSpawn(at, alongX ? -90 : -180);
  return tapRun(game, 260, (tick) => {
    if (tick === 0) game.input.hold('forward');
  });
}

describe('the readout is the bus\'s own number (§3.1, §3.9)', () => {
  it('every footstep the world hears is exactly what the Halo was claiming', () => {
    // The strongest assertion in the file. §3.8's radius is §3.3's *right-hand* column — how far
    // away the body can be heard — and §3.9 says the surface scales it. The only way to be sure
    // the readout is not a second, parallel implementation of that law is to compare it to the
    // event the bus actually emitted, on the tick it emitted it. Feed the Halo the paint radius,
    // or read the tier a tick late, and this fails.
    const steps = scriptedRun().filter(isStep);
    expect(steps.length).toBeGreaterThan(12);
    let exact = 0;
    for (const step of steps) {
      /*
       * The readout never under-reports the noise the world just heard.
       *
       * This used to be an equality, and the peak-hold is what loosened it in one direction and
       * only one: the reading is `max(gait, the tail of anything louder)`, so a crouch-step
       * taken half a second after a walk-step reads the walk's tail, not the crouch. That is the
       * intended answer — the walk-step is genuinely still crossing the room at 25-45 m/s — but
       * it means equality no longer holds on every step.
       *
       * What must still hold exactly is the direction: the ring may read *louder* than this
       * stride because of a louder one still ringing out, and it may never read quieter than a
       * noise the bus has just emitted. A readout wired to the paint column, or reading the tier
       * a tick late, breaks this immediately — both fail low.
       */
      expect(step.target).toBeGreaterThanOrEqual(step.event.hearingRadius - 1e-9);
      if (Math.abs(step.target - step.event.hearingRadius) < 1e-9) exact += 1;
      // Explicitly *not* the paint radius. The two differ by more than 2x on every step class,
      // so a readout wired to the wrong column would be caught here even without the pin above.
      expect(step.event.hearingRadius).not.toBeCloseTo(step.event.paintRadius, 3);
    }
    // And the bound is not vacuous: on most steps nothing louder is ringing out, and there the
    // reading is still exactly the event's own number rather than merely above it.
    expect(exact).toBeGreaterThan(steps.length / 2);
  });

  it('covers every step class — an invariant checked at one point is a coincidence', () => {
    const classes = new Set(scriptedRun().filter(isStep).map((t) => t.event.class));
    expect(classes).toEqual(new Set(STEP_CLASSES));
  });

  it('holds on every surface the room is made of, not just the default one', () => {
    // This is the half of the invariant a concrete-only run cannot see. Concrete is x1.0, so a
    // readout that had dropped §3.9's voice entirely — asking the bus about `MAT_CONCRETE`
    // instead of the ground the feet are on — passes the run above and fails here on the first
    // stone stride: 12.65 m claimed against 11 m emitted.
    const world = createHeadlessGame({ seed: 3 }).sim.world;
    const slabs = standableSlabs(world.boxes);
    const walked = new Set<number>();
    const radii = new Set<number>();
    for (const box of slabs.values()) {
      for (const step of walkAcross(box).filter(isStep)) {
        expect(step.target).toBeCloseTo(step.event.hearingRadius, 10);
        walked.add(step.event.mat ?? MAT_CONCRETE);
        radii.add(step.target);
      }
    }
    // The room has to keep offering surfaces with different voices, or the paragraph above is
    // describing a test that no longer runs.
    expect(walked.size).toBeGreaterThanOrEqual(2);
    expect([...walked].some((m) => materialLoudness(m) !== 1)).toBe(true);
    expect(radii.size).toBeGreaterThanOrEqual(2);
  });

  it('reads zero while the body is silent, and the readout follows it down', () => {
    // The most important single reading: nothing can hear you. A readout that idled at the last
    // stance would say a standing player is still audible at 24 m, which is a lie in the
    // direction that gets someone killed.
    const game = createHeadlessGame({ seed: 7 });
    game.input.hold('forward');
    game.input.hold('sprint');
    game.run(3);
    expect(game.sim.halo.targetRadius).toBeGreaterThan(20);
    expect(game.sim.halo.radius).toBeGreaterThan(20);

    game.input.release('forward');
    game.input.release('sprint');
    game.run(2);
    expect(game.sim.audibleRadius()).toBe(0);
    expect(game.sim.halo.targetRadius).toBe(0);
    expect(game.sim.halo.radius).toBeLessThan(0.01);
    expect(game.sim.halo.pitchHz).toBe(HALO_REFERENCE_HZ);
    expect(game.sim.halo.brightness).toBe(0);
  });

  it('is silent in the air — a body in flight lays down no contact noise', () => {
    const game = createHeadlessGame({ seed: 7 });
    game.input.hold('forward');
    game.run(2);
    expect(game.sim.audibleRadius()).toBeGreaterThan(0);
    game.input.press('jump');
    game.step(30);
    expect(game.sim.player.state.grounded).toBe(false);
    expect(game.sim.audibleRadius()).toBe(0);
  });

  it('glides on wall time, not on the paint clock', () => {
    // T scales how fast the world's *memory* ages (`GameSim.clock`), and how loud the player is
    // right now is not a thing that ages. Wire the Halo to the scaled clock and pressing T to
    // inspect the reveal at 0.1x would also make the readout crawl, which is a readout that
    // disagrees with the body for reasons the player has no way to see.
    const decayAt = (presses: number): number => {
      const game = createHeadlessGame({ seed: 7 });
      for (let i = 0; i < presses; i++) {
        game.input.tapKey('KeyT');
        game.step();
      }
      game.input.hold('forward');
      game.input.hold('sprint');
      game.run(3);
      game.input.release('forward');
      game.input.release('sprint');
      game.step(12); // 0.1 s of glide back toward silence
      return game.sim.halo.radius;
    };
    const atOneX = decayAt(0);
    expect(atOneX).toBeGreaterThan(1); // the reading is mid-glide, so there is something to see
    for (const presses of [1, 2, 3]) {
      expect(TIME_SCALES[presses % TIME_SCALES.length]).not.toBe(1);
      expect(decayAt(presses)).toBeCloseTo(atOneX, 9);
    }
  });

  /**
   * This used to assert the opposite — "is not moved by pings, the Halo answers for the gait,
   * not for events" — on the reasoning that a ping is not a *state*, so letting it in would make
   * the ring spike on a keypress and stop meaning "how loud am I being".
   *
   * That reasoning is wrong, and the way it is wrong is worth keeping written down. How loud am
   * I being, at the instant I fire an e-ping, is 30 m: further than any gait, further than a
   * sprint on steel. §3.8 does not exist to report the gait ladder, it exists because the
   * genre's most-repeated complaint is "I can't tell when I'm detectable" — and the old readout
   * answered that complaint with silence at the exact moment the player had made themselves the
   * loudest thing in the building. "It would spike on a keypress" is a description of the ring
   * working, not an argument: the player pressed the key, and the spike is the consequence they
   * authored.
   *
   * It also had a gameplay cost. §3.5 gives the e-ping its whole character as a *bait tool, not
   * a free telescope* — the price is that it wakes both ends of the beam. A price the loudness
   * instrument does not show is not a price, it is a surprise arriving later.
   */
  it('is moved by pings — an e-ping is the loudest thing the body can do on purpose', () => {
    const game = createHeadlessGame({ seed: 7 });
    game.run(1);
    expect(game.sim.audibleRadius()).toBe(0); // standing still: the gait says nothing
    expect(game.sim.halo.silent).toBe(true);

    game.input.tapKey('KeyE');
    game.step(2);
    // The gait still says nothing, and that is correct — the readout is no longer only the gait.
    expect(game.sim.audibleRadius()).toBe(0);
    // Bounded rather than pinned: the hold starts decaying the tick it is set, so the exact
    // reading depends on how many ticks have passed. That it never *exceeds* what the bus
    // carried is the half that matters — the ring may not claim a loudness the world did not.
    const e = SOUND_CLASSES['e-ping'].hearingRadius;
    expect(game.sim.halo.targetRadius).toBeLessThanOrEqual(e);
    expect(game.sim.halo.targetRadius).toBeGreaterThan(e * 0.9);
    expect(game.sim.halo.silent).toBe(false);
  });

  it('a ping outranks the stride it was fired mid-way through, and then gives it back', () => {
    const game = createHeadlessGame({ seed: 7 });
    game.input.hold('forward');
    game.run(2);
    const walking = game.sim.halo.targetRadius;
    expect(walking).toBeGreaterThan(5);

    game.input.tapKey('KeyE');
    game.step(2);
    const pinging = game.sim.halo.targetRadius;
    expect(pinging).toBeGreaterThan(walking * 1.5);

    // ...and the hold decays back to the gait rather than latching there.
    game.run(2);
    expect(game.sim.halo.targetRadius).toBeCloseTo(walking, 6);
    game.input.release('forward');
  });

  it('a landing reaches the readout, and the ceiling is high enough to grade it', () => {
    // §3.4 makes landings the loud class that bleeds through floors; §3.3 hears one at 28 m,
    // and 42 on steel. A dial topping out at a sprint's 36 would peg on exactly that.
    const game = createHeadlessGame({ seed: 7 });
    game.run(1);
    const before = game.sim.halo.targetRadius;
    game.sim.bus.emit({
      class: 'landing',
      x: 0,
      y: 0,
      z: 0,
      emitter: PLAYER_EMITTER_ID,
      source: 'player',
    });
    game.step();
    const land = SOUND_CLASSES.landing.hearingRadius;
    expect(game.sim.halo.targetRadius).toBeGreaterThan(before);
    expect(game.sim.halo.targetRadius).toBeLessThanOrEqual(land);
    expect(game.sim.halo.targetRadius).toBeGreaterThan(land * 0.95);
    expect(haloBrightness(SOUND_CLASSES.landing.hearingRadius * 1.5)).toBeCloseTo(1, 10);
  });

  it('does not flare at a teammate — the Halo answers "how loud am I", not "who is near"', () => {
    const game = createHeadlessGame({ seed: 7 });
    game.run(1);
    expect(game.sim.halo.silent).toBe(true);
    game.sim.bus.emit({
      class: 'sprint-step',
      x: 0,
      y: 0,
      z: 0,
      source: 'player',
      emitter: PLAYER_EMITTER_ID + 1,
    });
    game.step(2);
    expect(game.sim.halo.targetRadius).toBe(0);
    expect(game.sim.halo.silent).toBe(true);
  });

  it('the sim answers with the bus\'s carry radius for the tier it is in', () => {
    // The composition itself, stated once: tier from the controller's own gait ladder, surface
    // from the box the collision pass resolved against, radius from the bus that emits the step.
    const game = createHeadlessGame({ seed: 7 });
    game.input.hold('forward');
    game.input.hold('sprint');
    game.run(3);
    const tier = game.sim.player.stepTier;
    expect(tier).not.toBeNull();
    expect(game.sim.audibleRadius()).toBeCloseTo(
      game.sim.bus.carryRadius(stepClassOf(tier!), game.sim.player.groundMaterial),
      10,
    );
  });

  it('follows the dev panel: retuning a class moves the reading in the same tick', () => {
    // `carryRadius` reads the simulation's own tunables rather than the frozen table, so a
    // slider drag moves the ring immediately. A readout wired to `SOUND_CLASSES` would show the
    // shipped number while the world emitted the tuned one.
    const game = createHeadlessGame({ seed: 7 });
    game.input.hold('forward');
    game.input.hold('sprint');
    game.run(3);
    const before = game.sim.audibleRadius();
    game.sim.bus.tunables.classes['sprint-step'].hearingRadius = 48;
    expect(game.sim.audibleRadius()).toBeCloseTo(before * 2, 8);
  });
});

describe('the readout the driver sees', () => {
  it('publishes the glided reading, where it is heading, and both faces of it', () => {
    const game = createHeadlessGame({ seed: 7 });
    game.input.hold('forward');
    game.input.hold('sprint');
    game.run(3);
    const state = game.sim.debugState();
    const radius = Number(state.haloRadius);
    expect(radius).toBeCloseTo(game.sim.halo.radius, 10);
    expect(Number(state.haloTarget)).toBeCloseTo(game.sim.halo.targetRadius, 10);
    expect(Number(state.haloHz)).toBeCloseTo(humPitch(radius), 10);
    expect(Number(state.haloBrightness)).toBeCloseTo(haloBrightness(radius), 10);
  });

  it('shows the glide in flight — the reading lags the body, briefly', () => {
    // If `haloRadius` and `haloTarget` were the same number there would be no glide to see, and
    // §3.8's "continuously rather than stepping" would be prose with no implementation.
    const game = createHeadlessGame({ seed: 7 });
    game.input.hold('forward');
    game.run(3);
    game.input.hold('sprint');
    game.step(12); // 0.1 s — well inside the 0.18 s time constant
    const state = game.sim.debugState();
    expect(Number(state.haloTarget)).toBeGreaterThan(Number(state.haloRadius) + 1);
  });
});

describe('the ring is the guaranteed readout (§3.8)', () => {
  /*
   * §3.8 gives the ring one job — "brightness equals your current audible radius" — and one
   * privilege: it is the face that survives the player turning the sound off, which the doc
   * treats as a live possibility ("a volume slider is an accessibility control, not a retreat —
   * the ring remains the guaranteed readout"). So the map from brightness to opacity is tested
   * here rather than left to the browser. The hum has a phonometric suite behind it; until this
   * existed the ring had a `toFixed(3)` and a hope.
   *
   * The Halo-ring section of `tools/shoot.mjs` covers the other half — that the number reaches
   * the DOM and changes pixels — which is not something a node test can see.
   */
  it('is affine in the brightness — no second curve on top of the first', () => {
    // The point is not that it rises. It is that it rises *the way the brightness does*, so the
    // ring cannot say "a third as loud as a sprint" where the hum says "nearly half". A gamma on
    // the opacity — the obvious perceptual "fix" — breaks this and nothing else would catch it.
    const slope = haloRingAlpha(1) - haloRingAlpha(0);
    for (let b = 0; b <= 1.0001; b += 0.05) {
      expect(haloRingAlpha(b)).toBeCloseTo(haloRingAlpha(0) + b * slope, 12);
    }
  });

  it('reaches full opacity at the loudest reading and the floor at the quietest', () => {
    expect(haloRingAlpha(1)).toBeCloseTo(1, 12);
    expect(haloRingAlpha(0)).toBeCloseTo(HALO_RING_MIN_ALPHA, 12);
  });

  it('never fades out — the quietest reading is a reading, not a missing HUD', () => {
    // `haloBrightness` is 0 at 1.5 m, which means "nothing further than a metre and a half can
    // hear you", not "the readout is off". A ring at zero opacity there would put the complaint
    // §3.8 calls non-negotiable back at the one end of the dial where a player is listening
    // hardest for an answer. NaN lands there too rather than propagating into the style string.
    for (const b of [0, -1, -1e9, Number.NaN]) {
      expect(haloRingAlpha(b)).toBeGreaterThan(0.1);
      expect(haloRingAlpha(b)).toBeCloseTo(HALO_RING_MIN_ALPHA, 12);
    }
  });

  it('clamps rather than running past a legal opacity', () => {
    for (const b of [1, 1.5, 1e9, Number.POSITIVE_INFINITY]) {
      expect(haloRingAlpha(b)).toBeCloseTo(1, 12);
    }
  });

  it('elides writes below what a compositor can show, instead of quantizing the glide', () => {
    /*
     * §3.8 says the readout "glides continuously rather than stepping between stances", and the
     * stepped variant is the fallback it parks behind a playtest gate — not the shipped
     * behaviour. `Hud.setHalo` skips the DOM write when the opacity has moved less than
     * `HALO_ALPHA_EPSILON`, which makes that one constant the only place in the build where the
     * glide can be turned into steps by moving a digit.
     *
     * The digit's entire meaning is which side of one 8-bit alpha step it lands on. Below a
     * step, every suppressed write would have painted the pixel that is already on the screen:
     * an optimisation the eye cannot reach. At or above a step, states the eye *can* tell apart
     * collapse into one another and the ring arrives in roughly 1/ε rungs — sixteen across its
     * span at 0.05 — which is the prepared fallback shipped by accident.
     *
     * Nothing else in either suite can see that, which was checked rather than assumed: at 0.05
     * all 509 node tests pass and `tools/shoot.mjs` reads back its crouch, walk and sprint ring
     * means unchanged to the digit. The constant's only observable is a style string,
     * `haloRingAlpha` is pure and never reaches it, and the browser suite only ever photographs
     * the ring *settled* — where an elision leaves the reading within ε of the truth. The
     * stepping is in the transit between stances, and nothing takes a picture of that.
     */
    const EIGHT_BIT_STEP = 1 / 255;
    expect(HALO_ALPHA_EPSILON).toBeGreaterThan(0);
    expect(HALO_ALPHA_EPSILON).toBeLessThan(EIGHT_BIT_STEP);
  });

  it('still writes for one metre of carry at the deafest end of the dial', () => {
    // The same bound stated in the units the player moves the readout in, and the reason the
    // one above is not merely arithmetic about pixels. `humPitch` is a square root, so the ring
    // is at its least sensitive at the top of the range: a metre of extra carry buys less
    // opacity at 42 m than anywhere else on the dial. If a metre *there* cannot clear the
    // elision, then nowhere near the loud end can, and the ring goes quiet exactly where §3.8
    // says a player is most in need of an answer — while a landing on steel is ringing out.
    const alphaAt = (r: number) => haloRingAlpha(haloBrightness(r));
    const perMetreAtTheTop = alphaAt(HALO_MAX_RADIUS_M) - alphaAt(HALO_MAX_RADIUS_M - 1);
    expect(perMetreAtTheTop).toBeGreaterThan(0);
    expect(perMetreAtTheTop).toBeGreaterThan(HALO_ALPHA_EPSILON);
    // And it is the shallowest metre there is, so this is the worst case and not a lucky one.
    expect(alphaAt(3) - alphaAt(2)).toBeGreaterThan(perMetreAtTheTop);
  });

  it('orders the three stances the way the pitch does, end to end', () => {
    // The whole chain, from §3.3's carry radius to the number the DOM is handed.
    const [crouch, walk, sprint] = [2, 11, 24].map((r) => haloRingAlpha(haloBrightness(r)));
    expect(crouch!).toBeLessThan(walk!);
    expect(walk!).toBeLessThan(sprint!);
    expect(crouch!).toBeGreaterThan(HALO_RING_MIN_ALPHA);
    // A sprint on concrete is loud, but not the loudest thing the game has: steel is (§3.9), so
    // the ring must still have somewhere to go.
    expect(sprint!).toBeLessThan(1);
    expect(haloRingAlpha(haloBrightness(HALO_MAX_RADIUS_M))).toBeCloseTo(1, 12);
  });
});

describe('the tables the readout is built on', () => {
  it('pins the three step carries the whole file leans on', () => {
    // Same discipline as `tests/hearing.test.ts`: a crouch-step that carried 24 m would make
    // half the assertions above pass for the wrong reason.
    expect(SOUND_CLASSES['crouch-step'].hearingRadius).toBe(2);
    expect(SOUND_CLASSES['walk-step'].hearingRadius).toBe(11);
    expect(SOUND_CLASSES['sprint-step'].hearingRadius).toBe(24);
  });

  it('maps every step tier to its own class', () => {
    const seen = new Set<SoundClass>();
    for (const tier of ['crouch', 'walk', 'sprint'] as const) seen.add(stepClassOf(tier));
    expect(seen).toEqual(new Set(STEP_CLASSES));
  });
});
