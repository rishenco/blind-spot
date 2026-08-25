/**
 * Material voices — vision §3.9, and the sentence that makes it a law rather than a table:
 * "the multiplier scales every radius the event carries, not just the class default".
 *
 * Three separate claims, and they are tested separately because they fail separately:
 *
 *  1. the table itself — four materials, each with a name and a voice, in a fixed order;
 *  2. `SoundBus.emit` is the one place a voice is applied, it applies to *both* radii, it
 *     applies to explicit overrides, and it does not touch a class that strikes nothing;
 *  3. the material that reaches the bus is the surface the body is actually standing on, taken
 *     from the collision result rather than probed for a second time.
 *
 * The third is the one that could not be caught anywhere else. Both scripted characterization
 * runs (`determinism.test.ts`, `headless.test.ts`) walk the length of the room on its poured
 * concrete floor and never step on anything else, so every radius in them is 1.0x and the whole
 * of §3.9 could be deleted without moving a single trace. The end-to-end block below stands the
 * real controller on the real room's stone deck and its metal crate, which is the only way to
 * see the difference.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StaticWorld, aabbFromBounds } from '../src/core/collision';
import {
  MATERIAL_NAMES,
  MAT_CONCRETE,
  MAT_DUST,
  MAT_METAL,
  MAT_STONE,
  materialLoudness,
} from '../src/paint/materials';
import {
  COMPOSED_CLASSES,
  CONTACT_CLASSES,
  IMPACT_FULL_SPEED,
  IMPACT_MIN_SPEED,
  LANDING_FULL_IMPACT,
  PLAYER_EMITTER_ID,
  SOUND_CLASSES,
  SoundBus,
  isComposedClass,
  isContactClass,
  materialVoiceFor,
  type SoundClass,
} from '../src/paint/soundEvents';
import {
  PlayerController,
  defaultCameraTunables,
  defaultMovementTunables,
  type PlayerEvent,
} from '../src/player/controller';
import { buildRoom } from '../src/world/room';
import { ScriptedInput, emptyFrame } from './support/input';

describe('the material table (§3.9)', () => {
  it('names four materials, in the order the constants index', () => {
    expect(MATERIAL_NAMES).toEqual(['concrete', 'metal', 'stone', 'dust']);
    expect([MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST]).toEqual([0, 1, 2, 3]);
    expect(MATERIAL_NAMES[MAT_DUST]).toBe('dust');
  });

  it('gives every named material a voice — §3.9 first pass, verbatim', () => {
    expect(materialLoudness(MAT_CONCRETE)).toBe(1.0);
    expect(materialLoudness(MAT_METAL)).toBe(1.5);
    expect(materialLoudness(MAT_STONE)).toBe(1.15);
    expect(materialLoudness(MAT_DUST)).toBe(0.6);
  });

  it('has no silent material: every name in the table answers with a number', () => {
    // The drift this guards is a name added without a multiplier — a surface that exists, is
    // walked on, and is exactly as loud as concrete because nobody said otherwise.
    for (let i = 0; i < MATERIAL_NAMES.length; i++) {
      expect(Number.isFinite(materialLoudness(i)), MATERIAL_NAMES[i]).toBe(true);
      expect(materialLoudness(i)).toBeGreaterThan(0);
    }
  });

  it('is the quiet end that makes routing a choice: dust < concrete < stone < metal', () => {
    // §3.9's reason for dust existing. Without something *below* concrete, "go slow and stay
    // quiet" has nothing to pay it, because every surface is normal-or-louder.
    expect(materialLoudness(MAT_DUST)).toBeLessThan(materialLoudness(MAT_CONCRETE));
    expect(materialLoudness(MAT_CONCRETE)).toBeLessThan(materialLoudness(MAT_STONE));
    expect(materialLoudness(MAT_STONE)).toBeLessThan(materialLoudness(MAT_METAL));
  });

  it('answers an unrecognised index with concrete rather than throwing', () => {
    expect(materialLoudness(99)).toBe(1);
    expect(materialLoudness(-1)).toBe(1);
  });
});

describe('which classes have a material at all', () => {
  it('steps and landings strike something; pings do not', () => {
    expect(CONTACT_CLASSES).toEqual({
      'crouch-step': true,
      'walk-step': true,
      'sprint-step': true,
      landing: true,
      'q-ping': false,
      'e-ping': false,
      // A thrown can meets a floor and so does the can settling; the wind-up is the rig's arm
      // and meets nothing, so no surface gets a say in how loud it is.
      'prop-impact': true,
      'prop-knock': true,
      'throw-windup': false,
    });
  });

  it('names the two-bodied contacts, and every one of them is a contact', () => {
    // The pair that carries §3.9's geometric mean. Composed implies contact — `soundEvents.ts`
    // throws at module load otherwise — and this is the same statement read as data, so a class
    // added to one table and not the other is a failure here rather than a crash on import.
    expect(COMPOSED_CLASSES).toEqual({
      'crouch-step': false,
      'walk-step': false,
      'sprint-step': false,
      landing: false,
      'q-ping': false,
      'e-ping': false,
      'prop-impact': true,
      'prop-knock': true,
      'throw-windup': false,
    });
    for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
      if (isComposedClass(cls)) expect(isContactClass(cls), cls).toBe(true);
    }
  });

  it('every implemented class answers the question', () => {
    for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
      expect(typeof isContactClass(cls), cls).toBe('boolean');
    }
  });
});

describe('SoundBus.emit applies the voice, once, to both radii (§3.9)', () => {
  const walk = SOUND_CLASSES['walk-step'];

  it('scales the class default: a walk-step on steel is 6 m of paint and 16.5 m of carry', () => {
    const e = new SoundBus().emit({ class: 'walk-step', x: 0, y: 0, z: 0, mat: MAT_METAL });
    expect(e.paintRadius).toBeCloseTo(walk.paintRadius * 1.5, 9);
    expect(e.hearingRadius).toBeCloseTo(walk.hearingRadius * 1.5, 9);
    expect(e.paintRadius).toBe(6);
    expect(e.hearingRadius).toBe(16.5);
  });

  it('scales *both* radii by the same factor, for every material', () => {
    // The half that matters most: a surface that painted further without carrying further would
    // be loud to the player and quiet to the spider, which is the asymmetry `canHear` exists to
    // prevent and law 2 forbids outright.
    for (const mat of [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST]) {
      const e = new SoundBus().emit({ class: 'walk-step', x: 0, y: 0, z: 0, mat });
      const paintFactor = e.paintRadius / walk.paintRadius;
      const hearFactor = e.hearingRadius / walk.hearingRadius;
      expect(paintFactor, MATERIAL_NAMES[mat]).toBeCloseTo(materialLoudness(mat), 9);
      expect(hearFactor, MATERIAL_NAMES[mat]).toBeCloseTo(materialLoudness(mat), 9);
    }
  });

  it('dust is quieter than the class says, in both directions', () => {
    const e = new SoundBus().emit({ class: 'sprint-step', x: 0, y: 0, z: 0, mat: MAT_DUST });
    expect(e.paintRadius).toBeCloseTo(7 * 0.6, 9);
    expect(e.hearingRadius).toBeCloseTo(24 * 0.6, 9);
    expect(e.paintRadius).toBeLessThan(SOUND_CLASSES['sprint-step'].paintRadius);
  });

  it('an unstated material is concrete, and concrete changes nothing', () => {
    const bus = new SoundBus();
    const stated = bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0, mat: MAT_CONCRETE });
    const unstated = bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect(unstated.paintRadius).toBe(stated.paintRadius);
    expect(unstated.paintRadius).toBe(walk.paintRadius);
    expect(unstated.hearingRadius).toBe(walk.hearingRadius);
  });

  it('scales an explicit override too — a 14 m landing on steel is 21 m, louder than a Q-ping', () => {
    // §3.9: "the multiplier scales every radius the event carries, not just the class default".
    // The landing computed its own radius from impact speed before the bus ever saw it, and it
    // is still the steel that decides how far that rings out. This is the number the vision doc
    // names, and the consequence it names with it: dropping onto a steel floor paints further
    // than the deliberate 12 m room-read you would have to spend 10 energy on.
    const radius = SoundBus.landingRadius(LANDING_FULL_IMPACT);
    expect(radius).toBe(14);
    const e = new SoundBus().emit({
      class: 'landing',
      x: 0,
      y: 0,
      z: 0,
      paintRadius: radius,
      mat: MAT_METAL,
    });
    expect(e.paintRadius).toBe(21);
    expect(e.paintRadius).toBeGreaterThan(SOUND_CLASSES['q-ping'].paintRadius);
    // And the carry with it: the class's 28 m, not the override, times the same 1.5.
    expect(e.hearingRadius).toBe(42);
  });

  it('scales an explicit hearing override as well, not only the paint one', () => {
    const e = new SoundBus().emit({
      class: 'walk-step',
      x: 0,
      y: 0,
      z: 0,
      paintRadius: 10,
      hearingRadius: 20,
      mat: MAT_STONE,
    });
    expect(e.paintRadius).toBeCloseTo(11.5, 9);
    expect(e.hearingRadius).toBeCloseTo(23, 9);
  });

  it('leaves a ping alone: a ping strikes nothing, so no floor can change its reach', () => {
    // A Q-ping fired from a steel walkway must not reach 18 m where the same Q-ping one step
    // later on concrete reaches 12. The price of a deliberate act does not move under your feet.
    const q = new SoundBus().emit({ class: 'q-ping', x: 0, y: 0, z: 0 });
    expect(q.paintRadius).toBe(SOUND_CLASSES['q-ping'].paintRadius);
    expect(q.hearingRadius).toBe(SOUND_CLASSES['q-ping'].hearingRadius);
  });

  it('refuses a ping that claims a material, instead of ignoring the field', () => {
    // An emitter that hands a ping a material has misunderstood what it is emitting, and a
    // silently discarded field is how that misunderstanding survives to the next reader.
    const bus = new SoundBus();
    expect(() => bus.emit({ class: 'e-ping', x: 0, y: 0, z: 0, mat: MAT_METAL })).toThrow(
      /strikes nothing/,
    );
    // Rejected before the sequence number is taken: the bus keeps no trace of a refused emit.
    expect(bus.emitted).toBe(0);
  });
});

describe('a composed contact is priced by both bodies (§3.9 generalized)', () => {
  const impact = SOUND_CLASSES['prop-impact'];
  const MATERIALS = [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST];
  const name = (mat: number): string => MATERIAL_NAMES[mat]!;

  /** §3.9's multiplier for a contact between two bodies: the geometric mean of the two voices. */
  const gm = (obj: number, surf: number): number =>
    Math.sqrt(materialLoudness(obj) * materialLoudness(surf));

  const hit = (obj: number, surf: number, over: Partial<{ paintRadius: number }> = {}) =>
    new SoundBus().emit({
      class: 'prop-impact',
      x: 0,
      y: 0,
      z: 0,
      mat: surf,
      objMat: obj,
      ...over,
    });

  /**
   * The law, at every pair, to the bit.
   *
   * `toBe` and not `toBeCloseTo`: this is arithmetic on four literals, and the three rules that
   * lost to the geometric mean all fail it by whole decibels rather than by rounding. The
   * product puts metal on metal at 2.25x — outside §3.9's own band, and a footfall and an impact
   * on the same plate would then obey different physics. Either material alone silences the
   * other half of the contact, which is the half the paint needs: a bolt dropped on dust and a
   * bolt dropped on steel would light the same radius, and the probe would have stopped
   * reporting the world.
   */
  it('scales both radii by the geometric mean, for all sixteen pairs', () => {
    for (const obj of MATERIALS) {
      for (const surf of MATERIALS) {
        const e = hit(obj, surf);
        const label = `${name(obj)} on ${name(surf)}`;
        expect(e.paintRadius, label).toBe(impact.paintRadius * gm(obj, surf));
        expect(e.hearingRadius, label).toBe(impact.hearingRadius * gm(obj, surf));
      }
    }
  });

  it('scales *both* radii by the same factor, for all sixteen pairs', () => {
    // The composed half of the claim the single-material block above makes: a pair that painted
    // further than it carried would be loud to the player and quiet to the spider.
    for (const obj of MATERIALS) {
      for (const surf of MATERIALS) {
        const e = hit(obj, surf);
        expect(e.paintRadius / impact.paintRadius, `${name(obj)} on ${name(surf)}`).toBe(
          e.hearingRadius / impact.hearingRadius,
        );
      }
    }
  });

  /**
   * Symmetry, and it is the *property* rather than a gap in the coverage.
   *
   * Swapping the two arguments of the geometric mean is a mutation this file deliberately
   * survives: a bolt landing on a dust pile and a clod landing on a steel plate are equally
   * loud, and what tells them apart is timbre — measured at −89.9 dBFS / 250 Hz against
   * −43.4 / 999 (`tests/audio/composedVoice.test.ts`). §3.9 splits those two jobs on purpose:
   * the multiplier carries loudness, the voice carries identity. A test that demanded the level
   * distinguish them would be asking the multiplier to do the voice's work.
   */
  it('is symmetric: what struck what changes the sound, not the distance', () => {
    for (const obj of MATERIALS) {
      for (const surf of MATERIALS) {
        const there = hit(obj, surf);
        const back = hit(surf, obj);
        expect(there.paintRadius, `${name(obj)}/${name(surf)}`).toBe(back.paintRadius);
        expect(there.hearingRadius, `${name(obj)}/${name(surf)}`).toBe(back.hearingRadius);
        // …and they are genuinely two different events: each still reports its own two bodies.
        expect([there.objMat, there.mat]).toEqual([obj, surf]);
        expect([back.objMat, back.mat]).toEqual([surf, obj]);
      }
    }
  });

  /**
   * The reduction, which is the constraint that chose the rule.
   *
   * A can of the same stuff as the floor is a single-material contact, and it has to be priced
   * as one — otherwise the diagonal of the composed table and §3.9's four multipliers are two
   * different laws for the same event, and a metal footfall and a metal-on-metal clang would
   * disagree about how far steel carries.
   */
  it('reduces exactly to the single-material law on the diagonal', () => {
    const walk = SOUND_CLASSES['walk-step'];
    for (const mat of MATERIALS) {
      const e = hit(mat, mat);
      expect(e.paintRadius / impact.paintRadius, name(mat)).toBe(materialLoudness(mat));
      const step = new SoundBus().emit({ class: 'walk-step', x: 0, y: 0, z: 0, mat });
      expect(e.hearingRadius / impact.hearingRadius, name(mat)).toBe(
        step.hearingRadius / walk.hearingRadius,
      );
    }
    // The number §3.9 names, arrived at through the composed path: steel on steel is still 1.5x.
    expect(hit(MAT_METAL, MAT_METAL).hearingRadius).toBe(impact.hearingRadius * 1.5);
  });

  it('never leaves the band §3.9 tunes, and reaches both ends of it only on the diagonal', () => {
    // Closure is the other half of why the mean and not the product: every pair lands inside
    // the four multipliers the doc actually tuned, so no pair of ordinary materials can out-shout
    // the loudest surface in the game or undercut the quietest.
    const factors: number[] = [];
    for (const obj of MATERIALS) {
      for (const surf of MATERIALS) factors.push(hit(obj, surf).paintRadius / impact.paintRadius);
    }
    expect(Math.min(...factors)).toBe(materialLoudness(MAT_DUST));
    expect(Math.max(...factors)).toBe(materialLoudness(MAT_METAL));
    for (const f of factors) {
      expect(f).toBeGreaterThanOrEqual(0.6);
      expect(f).toBeLessThanOrEqual(1.5);
    }
  });

  it('scales a speed-scaled paint radius too, by the same pair', () => {
    // §3.9's "every radius the event carries": the impact computed its own paint radius from how
    // fast the thing was going before the bus saw it, and the two bodies still price it.
    const radius = SoundBus.impactRadius(IMPACT_FULL_SPEED);
    const e = hit(MAT_METAL, MAT_DUST, { paintRadius: radius });
    expect(e.paintRadius).toBe(radius * gm(MAT_METAL, MAT_DUST));
    // Hearing stays the class's, scaled by the same pair — speed moves paint, not ear level.
    expect(e.hearingRadius).toBe(impact.hearingRadius * gm(MAT_METAL, MAT_DUST));
  });

  it('asks the Halo the same question and gets the same answer', () => {
    // `carryRadius` is what §3.8's ring reads. It shares the resolver rather than recomputing
    // the mean, so the ring cannot claim a radius the emitted event does not have.
    const bus = new SoundBus();
    for (const obj of MATERIALS) {
      for (const surf of MATERIALS) {
        expect(bus.carryRadius('prop-impact', surf, obj), `${name(obj)} on ${name(surf)}`).toBe(
          hit(obj, surf).hearingRadius,
        );
      }
    }
  });

  it('refuses a second body on a class that has only one, and on one that has none', () => {
    // The guard that keeps footfalls on the diagonal by construction: the rig has no material of
    // its own yet, and a `objMat` quietly accepted here would price every step by a body nobody
    // has decided on.
    const bus = new SoundBus();
    expect(() =>
      bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0, mat: MAT_CONCRETE, objMat: MAT_METAL }),
    ).toThrow(/not a contact between two bodies/);
    expect(() => bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0, objMat: MAT_METAL })).toThrow(
      /not a contact between two bodies/,
    );
    expect(() => bus.carryRadius('walk-step', MAT_CONCRETE, MAT_METAL)).toThrow(
      /not a contact between two bodies/,
    );
    expect(bus.emitted).toBe(0);
  });

  it('refuses a composed contact that names only the floor', () => {
    // The other direction, and the more dangerous one: silently defaulting the missing body to
    // concrete would charge a steel can as a lump of concrete and nothing would ever say so.
    const bus = new SoundBus();
    expect(() => bus.emit({ class: 'prop-impact', x: 0, y: 0, z: 0, mat: MAT_METAL })).toThrow(
      /named no objMat/,
    );
    expect(() => bus.emit({ class: 'prop-knock', x: 0, y: 0, z: 0 })).toThrow(/named no objMat/);
    expect(() => bus.carryRadius('prop-impact', MAT_METAL)).toThrow(/named no objMat/);
    expect(bus.emitted).toBe(0);
  });

  it('answers an unrecognised second body with concrete, the way it answers a first one', () => {
    // Same policy as `materialLoudness`: an index nobody recognises is the default surface, not
    // a throw and not a NaN radius. The guard above is about a *missing* body, which is a
    // different mistake — the emitter forgot to say, rather than said something unknown.
    expect(materialVoiceFor('prop-impact', MAT_METAL, 99)).toBe(gm(MAT_CONCRETE, MAT_METAL));
    expect(materialVoiceFor('prop-impact', 99, MAT_METAL)).toBe(gm(MAT_METAL, MAT_CONCRETE));
    expect(materialVoiceFor('prop-impact', MAT_DUST, MAT_DUST)).toBe(materialLoudness(MAT_DUST));
    // And a class with only one body ignores the argument it was never given a meaning for.
    expect(materialVoiceFor('walk-step', MAT_METAL)).toBe(materialLoudness(MAT_METAL));
    expect(materialVoiceFor('q-ping', null)).toBe(1);
  });

  it('is silent below the speed that makes a contact a sound at all', () => {
    // The set-down verb, free: the emitter gates on this and never reaches the bus, so placing a
    // can is the quiet way to move it. Pinned here because the band's floor is what makes that
    // verb exist rather than a comment in an emitter that does not exist yet.
    expect(SoundBus.impactRadius(IMPACT_MIN_SPEED)).toBe(impact.paintRadius);
    expect(IMPACT_MIN_SPEED).toBeLessThan(IMPACT_FULL_SPEED);
  });
});

describe('the event carries the material forward, not only its effect', () => {
  /**
   * Why the field exists at all. A radius answers "how far", and that is everything a listener
   * who only wants reach ever needs — the multiplier is already baked in by the time the event
   * leaves `emit`. But §3.9's claim is about *timbre*: "a change of timbre mid-stride is a change
   * of surface" is a promise to the ear, and no amount of metres can carry it. An audio
   * subscriber has to know it was steel to make the sound of steel, so the event says so.
   */
  it('hands a contact class its material back, for every material', () => {
    for (const mat of [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST]) {
      const e = new SoundBus().emit({ class: 'walk-step', x: 0, y: 0, z: 0, mat });
      expect(e.mat, MATERIAL_NAMES[mat]).toBe(mat);
    }
  });

  it('reads an unstated material as concrete, the same default the radii used', () => {
    // The two must not disagree: an event scaled by concrete that reports no material would tell
    // an audio subscriber to pick a voice the radii were never computed for.
    const e = new SoundBus().emit({ class: 'landing', x: 0, y: 0, z: 0 });
    expect(e.mat).toBe(MAT_CONCRETE);
    expect(e.paintRadius).toBe(SOUND_CLASSES.landing.paintRadius);
  });

  it('reports null for a ping, which is not the same answer as concrete', () => {
    // `null` rather than 0, because a ping did not strike concrete — it struck nothing. A
    // subscriber that reads 0 here would give the sonar pulse a footfall's voice.
    for (const cls of ['q-ping', 'e-ping'] as const) {
      const e = new SoundBus().emit({ class: cls, x: 0, y: 0, z: 0, dirX: 1, dirY: 0, dirZ: 0 });
      expect(e.mat, cls).toBeNull();
      expect(e.mat, cls).not.toBe(MAT_CONCRETE);
    }
  });

  it('agrees with the radii it shipped with: the material named is the material applied', () => {
    // The invariant an audio subscriber depends on — what it is told to *sound* like and what
    // the world was told to *learn* from are one reading of one sound (law 2, "one bus, two
    // senses"). Checked over every class that strikes something, so a new contact class cannot
    // quietly ship a material the radii did not use.
    const walk = SOUND_CLASSES['walk-step'];
    for (const mat of [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST]) {
      const e = new SoundBus().emit({ class: 'walk-step', x: 0, y: 0, z: 0, mat });
      expect(e.paintRadius / walk.paintRadius, MATERIAL_NAMES[mat]).toBeCloseTo(
        materialLoudness(e.mat ?? MAT_CONCRETE),
        9,
      );
    }
  });
});

// ---------------------------------------------------------------------------

const HZ = 120;
const DT = 1 / HZ;

/** Top of the stone deck at the head of the stair flight (`world/room.ts`), and its middle. */
const STONE_DECK = new THREE.Vector3(-7.0, 2.52, -7.6);
/** Top of the 1.8 m metal crate by the spawn lane. */
const METAL_CRATE = new THREE.Vector3(-9.0, 1.8, 2.2);
/** Open concrete floor, well clear of both. */
const CONCRETE_FLOOR = new THREE.Vector3(-12.5, 0, 0);

/**
 * Stands the real controller on `at` in the real room, walks it forward, and returns the
 * material of every footfall it made. No bus and no paint — this is about which surface the
 * body reports, which is the half that cannot be checked by staring at radii.
 */
function walkFrom(at: THREE.Vector3, yawDeg: number, ticks = 90): number[] {
  const world = new StaticWorld();
  const room = buildRoom(world);
  const player = new PlayerController(world, defaultMovementTunables(), defaultCameraTunables());
  player.setSpawn(at, yawDeg);

  const mats: number[] = [];
  player.onEvent((e: PlayerEvent) => {
    if (e.type === 'footstep') mats.push(e.mat);
  });

  const input = new ScriptedInput();
  input.frame = { ...emptyFrame(), axes: { x: 0, y: 1 } };
  for (let tick = 0; tick < ticks; tick++) player.update(DT, input);
  room.dispose();
  return mats;
}

describe('the surface the body is really on reaches the bus (§3.9)', () => {
  it('walking the room floor reports concrete', () => {
    const mats = walkFrom(CONCRETE_FLOOR, -90);
    expect(mats.length).toBeGreaterThan(0);
    expect(new Set(mats)).toEqual(new Set([MAT_CONCRETE]));
  });

  it('walking the stone deck reports stone, not the concrete floor under it', () => {
    // The deck top is 2.52 m above the floor that the previous test walks. A material read off
    // the world by position, or defaulted, or left over from the last surface, answers concrete
    // here — and a stair flight that sounds like the floor is the thing §3.9 exists to prevent.
    const mats = walkFrom(STONE_DECK, 0);
    expect(mats.length).toBeGreaterThan(0);
    expect(mats[0]).toBe(MAT_STONE);
    expect(new Set(mats)).toEqual(new Set([MAT_STONE]));
  });

  it('walking a metal crate reports metal', () => {
    const mats = walkFrom(METAL_CRATE, 0, 40);
    expect(mats.length).toBeGreaterThan(0);
    expect(mats[0]).toBe(MAT_METAL);
  });

  it('stepping off the crate onto the floor changes voice mid-run', () => {
    // The crate is 1.8 m square, so a walking body crosses it and drops onto the floor inside
    // one short run: the same stride, two materials, in the order the feet met them. A ground
    // material cached once and never updated passes every test above and fails this one.
    const mats = walkFrom(METAL_CRATE, 0, 200);
    expect(mats[0]).toBe(MAT_METAL);
    expect(mats[mats.length - 1]).toBe(MAT_CONCRETE);
    expect(new Set(mats)).toEqual(new Set([MAT_METAL, MAT_CONCRETE]));
  });

  it('and the difference is audible: the same stride is louder on steel than on stone', () => {
    // End to end, through the bus, with the numbers §3.9 promises: 4 m x 1.5 against 4 m x 1.15.
    const on = (mat: number): number =>
      new SoundBus().emit({
        class: 'walk-step',
        source: 'player',
        emitter: PLAYER_EMITTER_ID,
        x: 0,
        y: 0,
        z: 0,
        mat,
      }).paintRadius;
    expect(on(walkFrom(METAL_CRATE, 0, 40)[0]!)).toBeGreaterThan(
      on(walkFrom(STONE_DECK, 0)[0]!),
    );
    expect(on(walkFrom(STONE_DECK, 0)[0]!)).toBeGreaterThan(on(walkFrom(CONCRETE_FLOOR, -90)[0]!));
  });
});

describe('a climb reports the ledge it climbed (§3.9)', () => {
  /**
   * The one tick where the surface and the collision result disagree. `advanceMantle` finishes a
   * climb by setting `grounded` itself and never calls `moveBody`, so on that tick the move
   * result still describes an airborne body: its `groundBox` is null and the last surface it
   * named is the floor the climb started from. A vault leaves with enough speed to advance the
   * stride, so that tick can emit a footfall — and on a run out of a concrete room onto a steel
   * crate, reading the stale surface is wrong by a factor of 1.5.
   *
   * The window is one tick wide and whether a footfall falls inside it depends on where the
   * stride phase happened to be when the climb started, so most approaches miss it. The
   * `LANDS_ON_THE_SEAM` offset below is one that does not — found by sweeping the approach in
   * 2 cm steps — and the test asserts that it still hits the seam, so that a future change to
   * the gait cannot quietly turn this into a test of the ordinary case.
   */
  interface Climb {
    steps: { mat: number; y: number; tick: number }[];
    completedTick: number;
  }

  /** Approach offset, in metres, whose first footfall on the crate lands on the seam tick. */
  const LANDS_ON_THE_SEAM = 0.14;

  function vaultOntoMetal(offset = 0): Climb {
    const world = new StaticWorld();
    world.add(aabbFromBounds(-20, -1, -20, 20, 0, 20, MAT_CONCRETE, true));
    world.add(aabbFromBounds(1, -1, -3, 5, 1.5, 3, MAT_METAL));

    const player = new PlayerController(world, defaultMovementTunables(), defaultCameraTunables());
    player.setSpawn(new THREE.Vector3(-offset, 0, 0), -90); // facing +x, at the crate

    let tick = 0;
    const steps: Climb['steps'] = [];
    player.onEvent((e: PlayerEvent) => {
      if (e.type === 'footstep') steps.push({ mat: e.mat, y: e.y, tick });
    });

    const input = new ScriptedInput();
    let wasClimbing = false;
    let completedTick = -1;
    for (tick = 0; tick < 420; tick++) {
      // Jump is the climb verb, and it is asked for only while the body is arriving at the
      // crate, so the rest of the run is an ordinary walk across the top and off the far side.
      const press = tick >= 45 && tick <= 140 && tick % 5 === 0;
      input.frame = {
        ...emptyFrame(),
        axes: { x: 0, y: 1 },
        down: press ? ['jump'] : [],
        pressed: press ? ['jump'] : [],
      };
      player.update(DT, input);
      if (wasClimbing && !player.mantling) completedTick = tick;
      wasClimbing = player.mantling;
    }
    return { steps, completedTick };
  }

  /** Footfalls taken at crate height — 1.5 m up, which only the climb reaches. */
  const onCrate = (c: Climb): Climb['steps'] => c.steps.filter((s) => s.y > 1.4);

  it('climbs the crate at all, and walks off the far side', () => {
    // The control. If the mantle never fires there is no window to get wrong and every
    // assertion below passes against anything; if the body never comes down again, the run is
    // not the round trip the last test reads as two materials.
    const climb = vaultOntoMetal();
    expect(climb.completedTick).toBeGreaterThan(0);
    expect(onCrate(climb).length).toBeGreaterThan(1);
    expect(climb.steps.some((s) => s.y < 0.1)).toBe(true);
  });

  it('a footfall on the very tick the climb ends is metal, not the floor it left', () => {
    const climb = vaultOntoMetal(LANDS_ON_THE_SEAM);
    const first = onCrate(climb)[0];
    expect(first).toBeDefined();
    // The assertion that keeps this test pointed at the seam rather than at the easy case.
    expect(first!.tick).toBe(climb.completedTick);
    expect(first!.mat).toBe(MAT_METAL);
  });

  it('no approach produces a footfall on the crate that is not metal', () => {
    // The property, swept across the phase offsets that decide where the seam falls: the
    // material a footfall reports is a fact about the surface, never about the route taken to
    // it or about which tick the stride happened to land on.
    for (let i = 0; i < 40; i++) {
      const climb = vaultOntoMetal(i * 0.02);
      for (const step of onCrate(climb)) {
        expect(step.mat, `offset ${(i * 0.02).toFixed(2)} m, tick ${step.tick}`).toBe(MAT_METAL);
      }
    }
  });

  it('and the floor either side of the climb is still concrete', () => {
    // The ledge material is picked up for the climb, not latched forever.
    const climb = vaultOntoMetal();
    const onFloor = climb.steps.filter((s) => s.y < 0.1);
    expect(onFloor.length).toBeGreaterThan(0);
    expect(onFloor.map((s) => s.mat)).toEqual(onFloor.map(() => MAT_CONCRETE));
  });
});
