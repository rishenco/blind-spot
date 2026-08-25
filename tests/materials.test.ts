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
  CONTACT_CLASSES,
  LANDING_FULL_IMPACT,
  PLAYER_EMITTER_ID,
  SOUND_CLASSES,
  SoundBus,
  isContactClass,
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
    });
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
