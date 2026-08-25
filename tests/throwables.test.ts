/**
 * The hand — M2's throw verb, from the charge curve to the cairn it leaves on the floor.
 *
 * Two doors, on purpose. `Throwables` is driven directly against a bare flat world wherever the
 * claim is about the *mechanism* (where a can leaves from, what a contact costs, when a rack
 * refuses), because a claim about the mechanism should not be able to fail because a room moved.
 * Everything about the *game* — what reaches the bus, what the reveal does with it, what a
 * respawn resets — goes through `createHeadlessGame`, the same `GameSim` the browser builds,
 * driven through the same `GameInputSource` a keyboard implements.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StaticWorld, aabbFromBounds } from '../src/core/collision';
import { KEY_BINDINGS } from '../src/core/input';
import { ScriptedInput } from '../src/core/scriptedInput';
import { HELP, HINT } from '../src/game/game';
import { createHeadlessGame, type HeadlessGame } from '../src/game/headless';
import {
  CAN_EMITTER_BASE,
  Throwables,
  throwSpeed,
  type CanReadout,
  type PrintSink,
  type ThrowSound,
  type Thrower,
} from '../src/game/throwables';
import {
  CENTRE_SCALE,
  PRINT_DOTS,
  PRINT_RING_DOTS,
  RestingPrints,
} from '../src/paint/prints';
import { MAT_CONCRETE, MAT_DUST, MAT_METAL } from '../src/paint/materials';
import {
  IMPACT_MAX_RADIUS,
  IMPACT_MIN_SPEED,
  PLAYER_EMITTER_ID,
  SOUND_CLASSES,
  SoundBus,
  defaultSoundTunables,
  materialVoiceFor,
  type SoundEvent,
} from '../src/paint/soundEvents';
import { defaultMovementTunables, type Stance } from '../src/player/controller';
import {
  CAN_CHARGE_SECONDS,
  CAN_LIFT_SPEED,
  CAN_MAT,
  CAN_MUZZLE_M,
  CAN_RACK_CAP,
  CAN_RADIUS,
  CAN_REACH,
  CAN_REARM_M,
  CAN_STACK_PITCH,
  CAN_THROW_MAX,
  CAN_THROW_MIN,
} from '../src/world/cans';
import { CAN_STACK } from '../src/world/room';

const HZ = 120;
const DT = 1 / HZ;

// ---------------------------------------------------------------------------
// The bare rig: a `Throwables` with no game around it.
// ---------------------------------------------------------------------------

/** A print layer that only remembers what it was told, so a test can read the poses back. */
class FakePrints implements PrintSink {
  readonly capacity = 64;
  readonly poses = new Map<number, { x: number; y: number; z: number; radius: number }>();
  place(id: number, x: number, y: number, z: number, radius: number): void {
    this.poses.set(id, { x, y, z, radius });
  }
  remove(id: number): void {
    this.poses.delete(id);
  }
  /** Is there a print for `id` at (x, y, z)? The mark of a settle, as opposed to any knock. */
  has(id: number, x: number, y: number, z: number): boolean {
    const p = this.poses.get(id);
    return p !== undefined && Math.hypot(p.x - x, p.y - y, p.z - z) < 1e-9;
  }
}

class Rig implements Thrower {
  readonly position = { x: 0, y: 0, z: 0 };
  readonly velocity = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  stance: Stance = 'stand';
  groundSpeed = 0;
  get state(): { stance: Stance; speed: number } {
    return { stance: this.stance, speed: this.groundSpeed };
  }
}

interface Bench {
  readonly world: StaticWorld;
  readonly rig: Rig;
  readonly prints: FakePrints;
  readonly hand: Throwables;
  readonly input: ScriptedInput;
  /** One tick, and the sounds it produced (a copy — the queue is reused). */
  tick(): ThrowSound[];
  /** Holds F for `seconds` then releases; returns the tick-by-tick sound log. */
  throwAfter(seconds: number): ThrowSound[][];
  /** Ticks until every can is asleep or `limit` ticks pass; returns the sound log. */
  settle(limit?: number): ThrowSound[][];
}

function bench(opts: { floor?: number; boxes?: readonly (readonly number[])[] } = {}): Bench {
  const world = new StaticWorld();
  world.add(aabbFromBounds(-80, -2, -80, 80, 0, 80, opts.floor ?? MAT_CONCRETE, true));
  for (const b of opts.boxes ?? []) {
    world.add(aabbFromBounds(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!, b[6] ?? MAT_CONCRETE));
  }
  const rig = new Rig();
  const prints = new FakePrints();
  const hand = new Throwables({
    world,
    thrower: rig,
    movement: defaultMovementTunables(),
    prints,
  });
  const input = new ScriptedInput();

  const tick = (): ThrowSound[] => {
    hand.update(DT, input);
    const out = hand.sounds.slice();
    input.endTick();
    return out;
  };
  return {
    world,
    rig,
    prints,
    hand,
    input,
    tick,
    throwAfter(seconds: number): ThrowSound[][] {
      const log: ThrowSound[][] = [];
      input.hold('throw');
      for (let i = 0; i < Math.round(seconds / DT); i++) log.push(tick());
      input.release('throw');
      log.push(tick());
      return log;
    },
    settle(limit = 4000): ThrowSound[][] {
      const log: ThrowSound[][] = [];
      for (let i = 0; i < limit; i++) {
        let moving = false;
        for (const c of hand.cansSnapshot()) if (!c.asleep) moving = true;
        if (!moving) break;
        log.push(tick());
      }
      return log;
    },
  };
}

function flatten(log: ThrowSound[][]): ThrowSound[] {
  return log.flat();
}

// ---------------------------------------------------------------------------
// The game door.
// ---------------------------------------------------------------------------

/** Every event the bus carries, in order, for a headless run. */
function recordBus(game: HeadlessGame): SoundEvent[] {
  const out: SoundEvent[] = [];
  game.sim.bus.subscribe((e) => out.push({ ...e }));
  return out;
}

/** Holds F for `seconds`, releases, and runs `after` seconds of flight. */
function throwInGame(game: HeadlessGame, seconds: number, after = 6): void {
  game.input.hold('throw');
  game.run(seconds);
  game.input.release('throw');
  game.run(after);
}

/**
 * How many cans the room hands you before you have thrown anything.
 *
 * Not zero, and every count below is written against this rather than against an empty world:
 * `world/room.ts` authors a stack beside the tank and `GameSim` boots it. A test that asserted
 * `inWorld === 1` after one throw was quietly asserting the room was empty, which stopped being
 * true the moment the stack was wired — and would stop being true again for the next prop.
 */
const BOOT_CANS = CAN_STACK.length;

/**
 * The can *this throw* put in the world — identified by difference, never by index.
 *
 * `cansSnapshot()[0]` is the bottom of the authored stack, twenty metres away beside the tank,
 * so "the can" has to be named rather than assumed. The only naming that survives a room growing
 * a second stack is the one that does not depend on the room at all: the can that was not there
 * a moment ago.
 */
function throwOne(game: HeadlessGame, seconds: number, after = 6): CanReadout {
  const before = new Set(game.sim.throwables.cansSnapshot().map((c) => c.id));
  throwInGame(game, seconds, after);
  const fresh = game.sim.throwables.cansSnapshot().filter((c) => !before.has(c.id));
  expect(fresh.length).toBe(1);
  return fresh[0]!;
}


/**
 * Throws the whole rack straight down at the rig's feet, so a test can walk up to the stack
 * wanting something. A full rack cannot lift (`Throwables.lift`), so an un-emptied rack turns
 * every mining test into a test of nothing.
 */
function emptyRack(game: HeadlessGame): void {
  game.input.look(0, 900);
  game.step();
  for (let i = 0; i < CAN_RACK_CAP; i++) throwInGame(game, 0.05, 1.2);
  expect(game.sim.throwables.carried).toBe(0);
  game.input.look(0, -900);
  game.step();
}

/** Puts the rig on the lane `back` metres west of the column, facing along it. */
function atTheStack(game: HeadlessGame, back: number): void {
  game.sim.player.setSpawn(new THREE.Vector3(CAN_STACK[0]!.x - back, 0, CAN_STACK[0]!.z), -90);
  game.step();
}

/** Every prop contact the bus carried from here on, in order. */
function recordProps(game: HeadlessGame): SoundEvent[] {
  const out: SoundEvent[] = [];
  game.sim.bus.subscribe((e) => {
    if (e.class === 'prop-impact' || e.class === 'prop-knock') out.push({ ...e });
  });
  return out;
}

// ===========================================================================

describe('the verb, as the player finds it', () => {
  /**
   * F throws, the HUD says so, and the help panel says what holding it does.
   *
   * This is the shortest possible answer to "I couldn't find anything new in the build". A verb
   * is not shipped when its code runs; it is shipped when a player who has not read the source
   * can find it, and the only two places this game tells anyone anything are the hint line and
   * the H panel. Both are asserted against the *binding*, not against a copy of the letter, so
   * moving the key and forgetting the text is a red test.
   */
  it('is on F, is in the hint line, and is in the help panel', () => {
    expect(KEY_BINDINGS['KeyF']).toBe('throw');
    const keys = Object.entries(KEY_BINDINGS)
      .filter(([, a]) => a === 'throw')
      .map(([k]) => k);
    // Exactly one key, and no second action on it: a charge that also crouches is not a verb.
    expect(keys).toEqual(['KeyF']);

    expect(HINT).toContain('F throw');
    // The same separator every other entry uses, and the existing ones are still in order.
    const order = ['WASD move', 'Q ping', 'E beam', 'F throw', 'L reveal'];
    let at = -1;
    for (const part of order) {
      const next = HINT.indexOf(part);
      expect(next).toBeGreaterThan(at);
      at = next;
    }

    const row = HELP.find((r) => r.keys === 'F');
    expect(row).toBeDefined();
    // The charge is the whole skill and it is invisible: the panel has to say it is held.
    expect(row!.action).toMatch(/hold/i);
    expect(row!.action).toMatch(/throw/i);
  });
});

describe('the charge (§1)', () => {
  it('ramps linearly from the floor to the cap and holds at the cap forever', () => {
    expect(throwSpeed(0)).toBe(CAN_THROW_MIN);
    expect(throwSpeed(CAN_CHARGE_SECONDS)).toBe(CAN_THROW_MAX);
    expect(throwSpeed(CAN_CHARGE_SECONDS / 2)).toBeCloseTo(
      (CAN_THROW_MIN + CAN_THROW_MAX) / 2,
      10,
    );
    // Held indefinitely: overcharging is not a mechanic, and neither is losing the throw.
    expect(throwSpeed(CAN_CHARGE_SECONDS * 20)).toBe(CAN_THROW_MAX);
    // A negative reading is a clock bug, not a slower throw.
    expect(throwSpeed(-5)).toBe(CAN_THROW_MIN);
  });

  it('winds while F is held, and the wind-up drops to zero the tick it is released', () => {
    const b = bench();
    b.input.hold('throw');
    b.tick();
    expect(b.hand.charging).toBe(true);
    expect(b.hand.charge).toBeCloseTo(DT, 10);
    for (let i = 0; i < 59; i++) b.tick();
    expect(b.hand.charge).toBeCloseTo(60 * DT, 6);
    expect(b.hand.chargeFraction).toBeCloseTo((60 * DT) / CAN_CHARGE_SECONDS, 6);
    b.input.release('throw');
    b.tick();
    expect(b.hand.charging).toBe(false);
    expect(b.hand.charge).toBe(0);
    expect(b.hand.thrown).toBe(1);
  });

  it('is audible exactly twice on a full charge: the arm, then the click at full tension', () => {
    const b = bench();
    const log = b.throwAfter(CAN_CHARGE_SECONDS + 0.4);
    const windups = flatten(log).filter((s) => s.kind === 'windup');
    expect(windups.length).toBe(2);
    expect(windups[0]!.stage).toBe('start');
    expect(windups[1]!.stage).toBe('full');
    // The click is the charge meter, so it has to land *at* full tension, not near it.
    const isClick = (s: ThrowSound): boolean => s.kind === 'windup' && s.stage === 'full';
    const clickTick = log.findIndex((t) => t.some(isClick));
    expect(clickTick * DT).toBeGreaterThanOrEqual(CAN_CHARGE_SECONDS - DT);
    expect(clickTick * DT).toBeLessThanOrEqual(CAN_CHARGE_SECONDS + DT);
  });

  it('says nothing a second time: a short throw makes one wind-up, never two', () => {
    const b = bench();
    const windups = flatten(b.throwAfter(CAN_CHARGE_SECONDS * 0.5)).filter(
      (s) => s.kind === 'windup',
    );
    expect(windups.length).toBe(1);
    expect(windups[0]!.stage).toBe('start');
  });

  it('refuses an empty rack before the arm moves: no motion, no sound, nothing on the bus', () => {
    const game = createHeadlessGame();
    const bus = recordBus(game);
    for (let i = 0; i < CAN_RACK_CAP; i++) throwInGame(game, 0.05, 0.4);
    expect(game.sim.throwables.carried).toBe(0);
    // Let the four land and go quiet first: a can still bouncing would put its own impacts in
    // the window below, and the claim here is about the *refusal* making no sound.
    for (let i = 0; i < 2000 && !game.sim.throwables.cansSnapshot().every((c) => c.asleep); i++) {
      game.step();
    }
    expect(game.sim.throwables.cansSnapshot().every((c) => c.asleep)).toBe(true);
    const emittedBefore = game.sim.bus.emitted;
    const worldBefore = game.sim.throwables.inWorld;
    const busBefore = bus.length;

    game.input.hold('throw');
    game.run(1.5);
    game.input.release('throw');
    game.run(0.5);

    expect(game.sim.throwables.refused).toBe(1);
    expect(game.sim.throwables.charging).toBe(false);
    expect(game.sim.throwables.charge).toBe(0);
    expect(game.sim.throwables.inWorld).toBe(worldBefore);
    // The refusal is silent in the strongest sense: the bus does not move at all. §1's one
    // off-bus sound is the Halo hum and that carve-out is not extensible.
    expect(game.sim.bus.emitted).toBe(emittedBefore);
    expect(bus.length).toBe(busBefore);
    game.sim.dispose();
  });

  it('spends nothing the game rations: a charged throw costs what standing still costs', () => {
    const thrower = createHeadlessGame();
    const control = createHeadlessGame();
    /*
     * There is no energy system in the tree yet (vision §4 is unbuilt), so "the throw costs zero
     * energy" cannot be asserted as a delta on a bar that does not exist. What *can* be asserted
     * is the whole of the claim as the code can currently express it: two identical runs, one of
     * which charges and throws, agree on every rationed quantity the sim has. The tripwire below
     * fails the day a bar lands, with instructions, rather than letting this quietly stop
     * covering §1's "energy cost exactly zero".
     */
    thrower.sim.firePing('q-ping');
    control.sim.firePing('q-ping');
    throwInGame(thrower, CAN_CHARGE_SECONDS + 0.2, 0.2);
    control.run(CAN_CHARGE_SECONDS + 0.4);

    const a = thrower.sim.debugState();
    const c = control.sim.debugState();
    if ('energy' in a) {
      throw new Error(
        'An energy bar has landed on GameSim.debugState. Vision §1 pins a throw at exactly ' +
          'zero energy: assert (before.energy - after.energy) === 0 across a charge-and-throw ' +
          'here, and delete this tripwire.',
      );
    }
    expect(a.pingCooldown).toBe(c.pingCooldown);
    expect(thrower.sim.throwables.thrown).toBe(1);
    thrower.sim.dispose();
    control.sim.dispose();
  });
});

describe('the launch (§2)', () => {
  it('leaves from the eye at the current stance height, one muzzle length along the aim', () => {
    for (const [stance, eye] of [
      ['stand', defaultMovementTunables().eyeStand],
      ['crouch', defaultMovementTunables().eyeCrouch],
    ] as const) {
      const b = bench();
      b.rig.stance = stance;
      b.rig.position.x = 3;
      b.rig.position.z = -4;
      // yaw 0, pitch 0 aims down -Z, exactly as `GameSim.firePing` builds the E-beam's aim.
      b.throwAfter(0.05);
      const can = b.hand.canAt(0)!;
      expect(can.x).toBeCloseTo(3, 6);
      // One tick of flight has already happened, so Y has fallen by a half-gravity step and Z
      // has advanced; the muzzle offset is what puts it in front of the eye rather than in it.
      expect(can.y).toBeLessThan(eye);
      expect(can.y).toBeGreaterThan(eye - 0.01);
      expect(-4 - can.z).toBeGreaterThan(CAN_MUZZLE_M);
    }
  });

  it('with a wall 30 cm away, spawns short and launches anyway at the full charged speed', () => {
    // A wall whose near face is 0.30 m along the aim, inside `CAN_MUZZLE_M`'s 0.35.
    const b = bench({ boxes: [[-5, 0, -0.6, 5, 4, -0.3, MAT_CONCRETE]] });
    const log = b.throwAfter(CAN_CHARGE_SECONDS + 0.2);
    const impacts = flatten(log).filter((s) => s.kind === 'impact');
    expect(impacts.length).toBe(1);
    const hit = impacts[0]!;
    // Full speed, undiminished: the throw is never refused and never quietly downgraded.
    expect(hit.speed).toBeCloseTo(CAN_THROW_MAX, 3);
    // In front of the wall, not inside it. A can spawned on the face grazes (silently) instead.
    expect(hit.z).toBeCloseTo(-0.3, 3);
    expect(hit.nz).toBeCloseTo(1, 6);
  });

  it('is silent in flight: the queue does not move between launch and first contact', () => {
    const b = bench();
    b.rig.pitch = Math.PI / 6;
    const launch = b.throwAfter(CAN_CHARGE_SECONDS + 0.2);
    expect(launch[launch.length - 1]!.length).toBe(0);
    let ticksSilent = 0;
    for (let i = 0; i < 4000; i++) {
      const sounds = b.tick();
      if (sounds.length > 0) break;
      ticksSilent++;
    }
    // A lofted full charge is airborne for well over a second, and every tick of it is silent.
    expect(ticksSilent).toBeGreaterThan(120);
  });

  it('is silent in flight through the bus, too', () => {
    const game = createHeadlessGame();
    game.sim.player.pitch = Math.PI / 6;
    game.input.hold('throw');
    game.run(CAN_CHARGE_SECONDS + 0.2);
    game.input.release('throw');
    game.step();
    const afterLaunch = game.sim.bus.emitted;
    let silentTicks = 0;
    for (let i = 0; i < 600; i++) {
      game.step();
      if (game.sim.bus.emitted !== afterLaunch) break;
      silentTicks++;
    }
    expect(silentTicks).toBeGreaterThan(60);
    game.sim.dispose();
  });
});

describe('contacts (§3)', () => {
  /**
   * The §3.3 table, walked end to end on one flight.
   *
   * A level tap on concrete makes four sounds and no others, and the interesting one is the
   * third: a touchdown at 1.1 m/s, under `IMPACT_MIN_SPEED`, which `soundEvents.ts` says has "no
   * event at all" and `ballistics.ts` says must be voiced or a can can go dark 2.5 m from the
   * last thing that painted it. Both are honoured by voicing it *as a knock*, and the way you
   * can tell that is what happened is that it is emitted at a pose the can then rolls away from
   * — a settle sound never is. Gate every touchdown and this list loses a sound; voice every
   * touchdown as an impact and it gains a flashbulb where the table wants a tap.
   */
  it('walks the table on one flight: two clangs, a quiet touchdown, then the settle', () => {
    const b = bench();
    const log = flatten([...b.throwAfter(0.05), ...b.settle()]).filter((s) => s.kind !== 'windup');
    expect(log.map((s) => s.kind)).toEqual(['impact', 'impact', 'knock', 'knock']);
    for (const s of log) {
      if (s.kind === 'impact') expect(s.speed).toBeGreaterThanOrEqual(IMPACT_MIN_SPEED);
    }
    const rest = b.hand.canAt(0)!;
    const touchdown = log[2]!;
    const settle = log[3]!;
    // The settle is at the rest pose; the quiet touchdown is a metre short of it, which is what
    // makes it a *touchdown* and not a second settle.
    expect(Math.hypot(settle.x - rest.x, settle.z - rest.z)).toBeLessThan(1e-6);
    expect(Math.hypot(touchdown.x - rest.x, touchdown.z - rest.z)).toBeGreaterThan(0.5);
    expect(b.prints.poses.size).toBe(1);
  });

  /**
   * A can that trickles into a wall stops against it without a word.
   *
   * `ballistics.ts` records that contact as a `graze` — "a contact that resolved without a bounce
   * and without landing" — and §3.3 has no row for it, because nothing struck anything: the
   * approach speed was below `bounceMin` and the can simply ran out of floor. Voicing it would
   * put a sound in the world with no impact behind it (law 2), and it would put one at the exact
   * moment a player is listening for where their can stopped.
   *
   * The wall is placed 11 cm short of where this same throw comes to rest on open floor, so the
   * can definitely reaches it — asserted below, since a wall the can never touches would make
   * this test pass for the wrong reason.
   */
  it('touches a wall it trickles into in silence: a graze is not a contact §3.3 prices', () => {
    const WALL_Z = -6.85;
    const open = bench();
    open.throwAfter(0.05);
    open.settle();
    expect(open.hand.canAt(0)!.z).toBeLessThan(WALL_Z);

    const b = bench({ boxes: [[-4, 0, WALL_Z - 2, 4, 5, WALL_Z]] });
    const log = flatten([...b.throwAfter(0.05), ...b.settle()]).filter((s) => s.kind !== 'windup');
    // Stopped by the wall, not by friction: this is the contact whose silence is the claim.
    expect(b.hand.canAt(0)!.z).toBeCloseTo(WALL_Z, 2);
    expect(log.map((s) => s.kind)).toEqual(['impact', 'impact', 'knock', 'knock']);
    // The only sound at the wall is the settle itself.
    expect(log.filter((s) => Math.abs(s.z - WALL_Z) < 0.05).length).toBe(1);
  });

  it('prices a landing in §3.3s impact band, and names both materials', () => {
    const game = createHeadlessGame();
    const bus = recordBus(game);
    game.sim.player.pitch = Math.PI / 18;
    throwInGame(game, CAN_CHARGE_SECONDS + 0.2, 8);

    const impacts = bus.filter((e) => e.class === 'prop-impact');
    expect(impacts.length).toBeGreaterThan(0);
    for (const e of impacts) {
      expect(e.source).toBe('prop');
      // Never the player's own emitter id, or §3.8's ring flares at a can across the room.
      expect(e.emitter).toBeGreaterThanOrEqual(CAN_EMITTER_BASE);
      expect(e.emitter).not.toBe(PLAYER_EMITTER_ID);
      expect(e.objMat).toBe(CAN_MAT);
      const voice = materialVoiceFor('prop-impact', e.mat, e.objMat);
      // The band, in the units the doc writes it in: 8 m at the floor of the curve, 12 m at the
      // top, scaled by the composed voice exactly once, on the bus.
      const bare = e.paintRadius / voice;
      expect(bare).toBeGreaterThanOrEqual(SOUND_CLASSES['prop-impact'].paintRadius - 1e-6);
      expect(bare).toBeLessThanOrEqual(IMPACT_MAX_RADIUS + 1e-6);
      expect(e.hearingRadius).toBeCloseTo(SOUND_CLASSES['prop-impact'].hearingRadius * voice, 6);
    }
    game.sim.dispose();
  });

  it('takes its voice from the surface struck: louder on metal than on dust', () => {
    const readings = [MAT_DUST, MAT_CONCRETE, MAT_METAL].map((mat) => {
      const b = bench({ floor: mat });
      b.rig.pitch = -Math.PI / 4;
      b.throwAfter(CAN_CHARGE_SECONDS + 0.2);
      const first = flatten(b.settle()).find((s) => s.kind === 'impact' || s.kind === 'knock')!;
      return { mat, reported: first.mat };
    });
    // The hand reports the box the physics resolved against; §3.9's arithmetic is the bus's job
    // and is asserted through it below.
    expect(readings.map((r) => r.reported)).toEqual([MAT_DUST, MAT_CONCRETE, MAT_METAL]);
    const dust = materialVoiceFor('prop-impact', MAT_DUST, CAN_MAT);
    const metal = materialVoiceFor('prop-impact', MAT_METAL, CAN_MAT);
    expect(metal).toBeGreaterThan(dust);
  });

  it('composes metal on metal when a can is lifted off another can', () => {
    const game = createHeadlessGame();
    // Make room in the rack, then hang a can in mid-air within reach: nothing under it, so the
    // surface it leaves is another can — metal on metal, the hottest voice §3.9 has.
    throwInGame(game, 0.05, 1.5);
    const p = game.sim.player.position;
    game.sim.throwables.spawnAt(p.x + 0.3, p.y + 0.4, p.z);
    const bus = recordBus(game);
    game.step();

    const knock = bus.find((e) => e.class === 'prop-knock')!;
    expect(knock).toBeDefined();
    expect(knock.mat).toBe(MAT_METAL);
    expect(knock.objMat).toBe(CAN_MAT);
    const voice = materialVoiceFor('prop-knock', MAT_METAL, CAN_MAT);
    expect(voice).toBeCloseTo(1.5, 10);
    expect(knock.hearingRadius).toBeCloseTo(SOUND_CLASSES['prop-knock'].hearingRadius * 1.5, 6);
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    game.sim.dispose();
  });

  it('makes exactly one settle sound per flight, and one more if it is woken again', () => {
    const b = bench();
    b.rig.pitch = Math.PI / 8;
    b.throwAfter(0.05);
    const first = flatten(b.settle());
    const settleKnocks = first.filter(
      (s) => s.kind === 'knock' && b.prints.has(s.can, s.x, s.y, s.z),
    );
    expect(settleKnocks.length).toBe(1);
    expect(b.prints.poses.size).toBe(1);
    // Asleep is asleep: nothing further is emitted, however long the world runs.
    for (let i = 0; i < 600; i++) expect(b.tick().length).toBe(0);
  });
});

describe('the resting print (§4)', () => {
  it('is bought with a sound: laid dark, stamped only by an event that reaches it', () => {
    const material = new THREE.ShaderMaterial();
    const prints = new RestingPrints(material, 4);
    const bus = new SoundBus(defaultSoundTunables());
    bus.subscribe((e) => prints.handle(e, e.time, 0, 0));

    prints.place(0, 10, 0, 0, 0.06);
    expect(prints.placed).toBe(1);
    // Placed is not known. A can nobody has heard is nowhere (law 1).
    expect(prints.known).toBe(0);
    expect(prints.isKnown(0)).toBe(false);

    bus.setTime(1);
    bus.emit({ class: 'q-ping', x: 30, y: 0, z: 0 });
    expect(prints.known).toBe(0);

    bus.setTime(2);
    bus.emit({ class: 'q-ping', x: 6, y: 0, z: 0 });
    expect(prints.known).toBe(1);
    expect(prints.knownDots).toBe(7);

    // A later, closer sound re-whitens it exactly as it re-whitens the wall behind it.
    const aged = prints.age(0, 12);
    bus.setTime(12);
    bus.emit({ class: 'q-ping', x: 10, y: 0, z: 0 });
    expect(prints.age(0, 12.5)).toBeLessThan(aged);

    // K forgets the map without tidying the room: the pose stays, the knowledge goes.
    prints.clear();
    expect(prints.placed).toBe(1);
    expect(prints.known).toBe(0);

    // The thing moved, so its geometry did.
    prints.remove(0);
    expect(prints.placed).toBe(0);
    prints.dispose();
    material.dispose();
  });

  /**
   * The cairn's shape, read off the buffer: six dots on a `CAN_RADIUS` ring plus a fatter one in
   * the middle, all of them at the pose the can actually occupies.
   *
   * The ring is what makes a can read as a *placed thing* rather than as floor — it is locally
   * denser than the 0.18 m lattice can ever be — and the centre dot at `CENTRE_SCALE` is the only
   * thing distinguishing a cairn from a very small wall. Neither may drift off the pose: a print
   * drawn anywhere but where the can lies is law 2 broken at the smallest scale the game has
   * (`world/cans.ts`), and it is broken silently, because nothing else in the game knows where
   * the can is.
   */
  it('draws a cairn: six dots on the can-radius ring, one fatter dot at the true pose', () => {
    const material = new THREE.ShaderMaterial();
    const prints = new RestingPrints(material, 2);
    prints.place(1, 3, 0.5, -2, CAN_RADIUS);

    const geom = prints.object.geometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const scale = geom.getAttribute('aScale') as THREE.BufferAttribute;
    const base = 1 * PRINT_DOTS;
    expect(PRINT_DOTS).toBe(PRINT_RING_DOTS + 1);

    const radii: number[] = [];
    for (let d = 0; d < PRINT_RING_DOTS; d++) {
      const i = base + d;
      // Flat ring in the horizontal plane, so a cairn on the floor is a cairn, not a sphere.
      expect(pos.getY(i)).toBeCloseTo(0.5, 10);
      radii.push(Math.hypot(pos.getX(i) - 3, pos.getZ(i) - -2));
      expect(scale.getX(i)).toBeCloseTo(1, 10);
    }
    // 6 decimals, not 10: the buffer is float32 and the ring is built from sin/cos.
    for (const r of radii) expect(r).toBeCloseTo(CAN_RADIUS, 6);
    // Evenly spaced, not six dots piled at one bearing.
    const bearings = new Set<number>();
    for (let d = 0; d < PRINT_RING_DOTS; d++) {
      const i = base + d;
      bearings.add(Math.round((Math.atan2(pos.getZ(i) - -2, pos.getX(i) - 3) * 180) / Math.PI));
    }
    expect(bearings.size).toBe(PRINT_RING_DOTS);

    const centre = base + PRINT_RING_DOTS;
    expect(pos.getX(centre)).toBeCloseTo(3, 10);
    expect(pos.getY(centre)).toBeCloseTo(0.5, 10);
    expect(pos.getZ(centre)).toBeCloseTo(-2, 10);
    expect(scale.getX(centre)).toBeCloseTo(CENTRE_SCALE, 10);
    expect(CENTRE_SCALE).toBeGreaterThan(1);

    prints.dispose();
    material.dispose();
  });

  it('appears when a thrown can settles, survives K as a pose, and is relearned by a ping', () => {
    const game = createHeadlessGame();
    const can = throwOne(game, 0.05, 8);
    const prints = game.sim.paint.prints;
    expect(game.sim.throwables.inWorld).toBe(BOOT_CANS + 1);
    expect(prints.placed).toBe(BOOT_CANS + 1);

    const p = game.sim.player.position;
    const dist = Math.hypot(can.x - p.x, can.z - p.z);
    // Precondition, stated out loud: a tap has to land inside a Q-ping or this proves nothing.
    expect(dist).toBeLessThan(SOUND_CLASSES['q-ping'].paintRadius);
    // And the companion precondition the boot stack added for free: it is out there, its print
    // is laid, and it is far enough that the ping below cannot reach it. So `known` counting to
    // exactly one is a claim about *which* can was learned, not just how many.
    for (const stacked of CAN_STACK) {
      expect(Math.hypot(stacked.x - p.x, stacked.z - p.z)).toBeGreaterThan(
        SOUND_CLASSES['q-ping'].paintRadius,
      );
    }

    game.sim.paint.clear();
    expect(prints.placed).toBe(BOOT_CANS + 1);
    expect(prints.known).toBe(0);

    game.sim.firePing('q-ping');
    expect(prints.known).toBe(1);
    game.sim.dispose();
  });

  /**
   * A can close enough to hear lights its own cairn as it lands — no ping, nothing else.
   *
   * This is the whole of §4's bargain in one assertion: the print is laid during the tick the can
   * settles, so it is already there when `GameSim` drains that tick's sound queue onto the bus
   * and the settle knock's own wavefront sweeps over it. Lay it a tick later and the can lands in
   * silence and stays dark until something else happens to reach it.
   *
   * The aim is 60° down so the can rests 2.6 m away, inside `prop-knock`'s 4 m carry. The
   * companion case is asserted below and is not a bug: throw one across the room and its settle
   * is a sound you cannot hear, so the cairn stays dark. Law 1 is not waived because it is your
   * own can.
   */
  it('lights its own cairn when it lands within earshot, and stays dark when it does not', () => {
    const near = createHeadlessGame();
    near.input.look(0, 500);
    near.step();
    expect(near.sim.player.pitch).toBeCloseTo(-Math.PI / 3, 3);
    const can = throwOne(near, 0.05, 8);
    const p = near.sim.player.position;
    const d = Math.hypot(can.x - p.x, can.y - p.y, can.z - p.z);
    expect(d).toBeLessThan(SOUND_CLASSES['prop-knock'].hearingRadius);
    expect(near.sim.paint.prints.placed).toBe(BOOT_CANS + 1);
    // One, not BOOT_CANS + 1: the authored stack laid its prints at boot and nothing has been
    // heard out there, so the room's own cans are as dark as the far case below. An authored can
    // is not free intel — law 1 does not waive itself for props the level designer placed.
    expect(near.sim.paint.prints.known).toBe(1);
    near.sim.dispose();

    const far = createHeadlessGame();
    const fcan = throwOne(far, 0.05, 8);
    const fp = far.sim.player.position;
    const fd = Math.hypot(fcan.x - fp.x, fcan.y - fp.y, fcan.z - fp.z);
    expect(fd).toBeGreaterThan(SOUND_CLASSES['prop-knock'].hearingRadius * 1.5);
    expect(far.sim.paint.prints.placed).toBe(BOOT_CANS + 1);
    expect(far.sim.paint.prints.known).toBe(0);
    far.sim.dispose();
  });

  it('goes the instant the can does: picking one up takes its geometry with it', () => {
    const b = bench();
    b.rig.pitch = -Math.PI / 3;
    b.throwAfter(0.05);
    b.settle();
    expect(b.prints.poses.size).toBe(1);
    const pose = b.prints.poses.get(0)!;

    // Walk the rig to the can, slowly, from far enough away to have re-armed.
    b.rig.position.x = pose.x + CAN_REARM_M + 1;
    b.rig.position.z = pose.z;
    b.tick();
    b.rig.position.x = pose.x;
    b.rig.position.z = pose.z;
    b.rig.groundSpeed = 1;
    const sounds = b.tick();

    expect(b.prints.poses.size).toBe(0);
    expect(b.hand.inWorld).toBe(0);
    expect(b.hand.carried).toBe(CAN_RACK_CAP);
    expect(sounds.filter((s) => s.kind === 'knock').length).toBe(1);
  });
});

describe("the room's own stack (§8)", () => {
  /**
   * The wiring itself: `GameSim` boots `world/room.ts`'s authored column, and it is *dark*.
   *
   * This is the assertion the whole of M2 was missing while the boot seam sat unwired — the
   * stack existed as data and as a room test, and no can of it was ever in the game. It has two
   * halves and the second is the one with teeth. Cans in the world is a wiring claim; cans whose
   * prints are laid and *unknown* is law 1: an authored prop is not free intel, and a level
   * designer placing something does not hand the player its position. You learn the stack is
   * there the way you learn everything else — you make a noise, or it does.
   */
  it('boots where the room authored it, and is unlit until something is heard', () => {
    const game = createHeadlessGame();
    expect(game.sim.throwables.inWorld).toBe(BOOT_CANS);
    expect(game.sim.paint.prints.placed).toBe(BOOT_CANS);
    expect(game.sim.paint.prints.known).toBe(0);

    const booted = game.sim.throwables.cansSnapshot();
    for (const authored of CAN_STACK) {
      const match = booted.find(
        (c) => Math.hypot(c.x - authored.x, c.y - authored.y, c.z - authored.z) < 1e-9,
      );
      expect(match, `nothing booted at y=${authored.y.toFixed(2)}`).toBeDefined();
      // Asleep and armed: a column stands because nothing in it is moving, and an authored can is
      // touchable on the first tick — the re-arm rule is about things *you* let go of.
      expect(match!.asleep).toBe(true);
      expect(match!.armed).toBe(true);
      expect(match!.settled).toBe(true);
    }
    game.sim.dispose();
  });

  /**
   * Creep up with an empty rack and the column is a quiet resupply, mined off the top.
   *
   * The cleanest reading of the fork §8 asks for, measured from the game rather than argued.
   * Four lift knocks (`prop-knock`, 1.5 m paint), **no impact at all**, and the bottom can still
   * standing where the room put it — untouched, not merely un-pocketed. Nothing falls, because
   * taking the highest can in reach never unsupports anything, and nothing is nudged, because a
   * crouched rig has the deceleration to stop with the column still outside its shell.
   *
   * Two assertions carry the shape of the rules and are worth naming.
   *
   * *Descending heights* pins the reach as a cylinder. A ball has no height left at 0.6 m out, so
   * approaching the column would hand you the bottom can and drop the other four; that version
   * passes every count here and fails this line.
   *
   * *The bottom can asleep at its pose* pins the arm and the body as different distances. Share
   * one number and a rig that has just filled its rack is standing over a can it cannot pocket,
   * and the only thing left to do with such a can is move it — the take always ended in a clang,
   * unavoidably, which is the failure this suite already rejected once when the stack was a can
   * too tall. The quarter metre between `CAN_REACH` and the rig's own radius is where a player
   * gets to stand, and `crouch` is the stance that can stop inside it.
   */
  it('is mined off the top, quietly, by an empty rack that creeps up to it', () => {
    const game = createHeadlessGame();
    emptyRack(game);
    atTheStack(game, 3.5);
    const props = recordProps(game);

    game.input.hold('crouch');
    game.input.hold('forward');
    for (let i = 0; i < 600; i++) {
      game.step();
      if (game.sim.throwables.carried === CAN_RACK_CAP) break;
    }
    game.input.release('forward');
    game.run(3);

    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    expect(props.filter((e) => e.class === 'prop-impact')).toEqual([]);
    const lifts = props.filter((e) => e.class === 'prop-knock');
    expect(lifts.length).toBe(CAN_RACK_CAP);
    for (let i = 1; i < lifts.length; i++) {
      expect(lifts[i]!.y, 'the column is mined off the top, not out from under').toBeLessThan(
        lifts[i - 1]!.y,
      );
    }

    // Left standing: the bottom can, at its authored pose, never woken.
    const left = game.sim.throwables
      .cansSnapshot()
      .filter((c) => Math.hypot(c.x - CAN_STACK[0]!.x, c.z - CAN_STACK[0]!.z) < CAN_REACH);
    expect(left.length).toBe(1);
    expect(left[0]!.y).toBeCloseTo(CAN_STACK[0]!.y, 10);
    expect(left[0]!.z).toBeCloseTo(CAN_STACK[0]!.z, 10);
    expect(left[0]!.asleep).toBe(true);
    game.sim.dispose();
  });

  /**
   * A full rack does not make a stack of cans stop existing.
   *
   * The bug this pins was invisible until the stack was in the game: `lift` returned early on a
   * full rack, and returning early was the *whole* response — so a rig carrying four cans walked
   * straight through a 0.6 m column of five and the bus carried **zero events**. Measured, before
   * the fix: the rig came out the far side at x = 9.65 and every can was still asleep at the pose
   * the room authored. The matter layer showed five things and the body passed through them.
   *
   * That is law 2 at the scale the player is closest to, and it is §8's claim about props being
   * "the real price of moving through unpainted space" quietly refunded to anyone whose pockets
   * happened to be full. Whether the rig can pocket a can is a question about the rack. Whether
   * it moves one it walks into is not a question at all.
   */
  it('is not walked through by a full rack as though it were not there', () => {
    const game = createHeadlessGame();
    atTheStack(game, 3.5);
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    const props = recordProps(game);

    game.input.hold('forward');
    game.run(2.5);
    game.input.release('forward');
    game.run(3);

    // Nothing pocketed — a full rack is full — and nothing left standing either.
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    expect(game.sim.throwables.inWorld).toBe(BOOT_CANS);
    expect(props.length).toBeGreaterThanOrEqual(BOOT_CANS);
    for (const can of game.sim.throwables.cansSnapshot()) {
      const home = CAN_STACK.some(
        (a) => Math.hypot(can.x - a.x, can.y - a.y, can.z - a.z) < CAN_RADIUS,
      );
      expect(home, 'a can survived a body walking through it').toBe(false);
    }
    game.sim.dispose();
  });

  /**
   * Sprint the same line and the same column is a trap that rings the room.
   *
   * `CAN_LIFT_SPEED` is the whole difference — one number, two readings of the same three metres
   * of floor (`world/cans.ts`). Arriving at sprint the rig cannot pocket anything: the rack comes
   * out the far side exactly as full as it went in, five cans are loose on the floor of the
   * loudest lane in the room, and every one of them is `MAT_METAL`, the ×1.5 voice, going off
   * beside the landmark the whole room navigates by.
   *
   * That the rack is untouched is the part worth stating out loud. The lane is not "the fast
   * route that also resupplies you" — it is fast, and you pay, and you get nothing for it.
   */
  it('is kicked across the floor by a sprint, and hands the sprinter nothing', () => {
    const game = createHeadlessGame();
    atTheStack(game, 3.5);
    const props = recordProps(game);

    game.input.hold('forward');
    game.input.hold('sprint');
    game.run(2.5);
    game.input.release('forward');
    game.input.release('sprint');
    game.run(3);

    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    expect(game.sim.throwables.inWorld).toBe(BOOT_CANS);
    // Every can struck something: a boot is not a teleport, and a can that never landed would
    // be a can that made no sound where it stopped.
    expect(props.filter((e) => e.class === 'prop-impact').length).toBeGreaterThanOrEqual(BOOT_CANS);

    const loose = game.sim.throwables.cansSnapshot();
    for (const can of loose) {
      expect(can.asleep, 'a kicked can comes to rest inside three seconds').toBe(true);
      // On the floor, not stacked: the column is the thing that is gone.
      expect(can.y).toBeLessThan(CAN_STACK_PITCH);
      const home = CAN_STACK.some(
        (a) => Math.hypot(can.x - a.x, can.y - a.y, can.z - a.z) < CAN_RADIUS,
      );
      expect(home, `a can is still at an authored pose after a sprint through it`).toBe(false);
    }
    game.sim.dispose();
  });

  /**
   * The reach shape, on the bare rig, where nothing about the room can rescue it.
   *
   * Two cans at the same moment: one on the floor a whisker inside `CAN_REACH`, one at hand
   * height and half a metre out. Their straight-line distances from the feet are 0.59 m and
   * 0.71 m — so a *ball* of radius `CAN_REACH` contains only the floor can, and a cylinder
   * contains both. The rig takes the higher one, which is the answer only a cylinder can give.
   */
  it('reaches in a cylinder, not a ball: the high can is in reach at arm\'s length', () => {
    const b = bench();
    // A full rack cannot lift, so the rack goes on the floor first — four taps, level, which
    // puts them meters downrange where they cannot be part of the answer.
    for (let i = 0; i < CAN_RACK_CAP; i++) {
      b.throwAfter(0.05);
      b.settle();
    }
    expect(b.hand.carried).toBe(0);

    const low = b.hand.spawnAt(0.59, CAN_RADIUS, 0);
    const high = b.hand.spawnAt(0.5, 0.5, 0);
    expect(Math.hypot(0.59, CAN_RADIUS)).toBeLessThan(CAN_REACH);
    expect(Math.hypot(0.5, 0.5)).toBeGreaterThan(CAN_REACH);

    b.rig.groundSpeed = 1;
    b.tick();

    const left = b.hand.cansSnapshot().map((c) => c.id);
    expect(left).toContain(low);
    expect(left, 'the can outside a ball but inside the cylinder was not taken').not.toContain(
      high,
    );
    expect(b.hand.carried).toBe(1);
  });
});

describe('carry and retrieve (§5)', () => {
  it('a released can is inert until it has been a re-arm distance away, then catchable', () => {
    const b = bench();
    b.rig.pitch = -Math.PI / 2.02;
    b.throwAfter(0.05);
    b.settle();
    expect(b.hand.carried).toBe(CAN_RACK_CAP - 1);
    const can = b.hand.canAt(0)!;
    // It came to rest at the rig's own feet, and stays there: no key, but no vacuum either.
    expect(Math.hypot(can.x, can.z)).toBeLessThan(1);
    for (let i = 0; i < 240; i++) b.tick();
    expect(b.hand.carried).toBe(CAN_RACK_CAP - 1);
    expect(b.hand.cansSnapshot()[0]!.armed).toBe(false);

    // One excursion past the re-arm distance is all it takes.
    b.rig.position.x = CAN_REARM_M + 0.2;
    b.tick();
    expect(b.hand.cansSnapshot()[0]!.armed).toBe(true);
    b.rig.position.x = can.x;
    b.rig.position.z = can.z;
    b.tick();
    expect(b.hand.carried).toBe(CAN_RACK_CAP);
    expect(b.hand.inWorld).toBe(0);
  });

  it('walking lifts and sprinting kicks, decided by one number', () => {
    for (const [speed, expected] of [
      [CAN_LIFT_SPEED - 0.01, 'lift'],
      [CAN_LIFT_SPEED, 'kick'],
    ] as const) {
      const b = bench();
      // The can under test is one the rig threw at its own feet, so the rack has the free slot a
      // lift needs — a full rack is a different rule and is proved on its own below.
      b.rig.pitch = -Math.PI / 2.02;
      b.throwAfter(0.05);
      b.settle();
      expect(b.hand.carried).toBe(CAN_RACK_CAP - 1);
      const can = b.hand.canAt(0)!;
      const rest = { x: can.x, y: can.y, z: can.z };
      // Step away far enough to re-arm it, then arrive back at it already moving.
      b.rig.position.x = CAN_REARM_M + 0.5;
      b.tick();
      b.rig.position.x = rest.x;
      b.rig.position.z = rest.z;
      b.rig.velocity.x = speed;
      b.rig.groundSpeed = speed;
      const sounds = b.tick();
      if (expected === 'lift') {
        expect(b.hand.carried).toBe(CAN_RACK_CAP);
        expect(b.hand.inWorld).toBe(0);
        expect(sounds.map((s) => s.kind)).toEqual(['knock']);
        expect(b.prints.poses.size).toBe(0);
      } else {
        expect(b.hand.carried).toBe(CAN_RACK_CAP - 1);
        expect(b.hand.inWorld).toBe(1);
        expect(b.hand.canAt(0)!.asleep).toBe(false);
        expect(sounds.map((s) => s.kind)).toEqual(['impact']);
        expect(b.prints.poses.size).toBe(0);
      }
    }
  });

  /**
   * A full rack moves what it walks into, and *only* what it walks into.
   *
   * Two distances, on the bare rig, where nothing about a room can rescue either of them. An arm
   * reaches `CAN_REACH`; a body is `radius` across. Standing half a metre off, the rig's arm is
   * over the can and its shell is nowhere near it, and a rack with no room to pocket it means
   * nothing happens — no sound, the can still asleep. Step in to where the shell actually
   * contains the can and it moves, whatever the rack is doing.
   *
   * Merge the two distances and either half breaks. Use the arm for both and a rig that has just
   * filled its rack knocks over the can it is reaching past, every time, unavoidably. Use the
   * body for both and you cannot pick a can up without standing on it.
   *
   * The third tick is the sound the *speed* chooses. `kick` is one method reached at two very
   * different paces, and it voices itself where `onContact` does and by the same constant: a
   * shuffle is a `prop-knock`, a boot is a `prop-impact`.
   */
  it('a full rack moves what it walks into, and only what it walks into', () => {
    const b = bench();
    const movement = defaultMovementTunables();
    b.hand.spawnAt(4, 0.02, 0);
    expect(b.hand.carried).toBe(CAN_RACK_CAP);

    // Inside the arm, outside the shell: the rig is reaching over it, not standing in it.
    const gap = (CAN_REACH + movement.radius) / 2;
    expect(gap).toBeLessThan(CAN_REACH);
    expect(gap).toBeGreaterThan(movement.radius);
    b.rig.position.x = 4 - gap;
    b.rig.groundSpeed = 1;
    expect(b.tick()).toEqual([]);
    expect(b.hand.inWorld).toBe(1);
    expect(b.hand.canAt(0)!.asleep).toBe(true);

    // Inside the shell, still far under `CAN_LIFT_SPEED` and under `IMPACT_MIN_SPEED`: a nudge.
    b.rig.position.x = 4 - movement.radius / 2;
    b.rig.velocity.x = 1;
    expect(b.tick().map((s) => s.kind)).toEqual(['knock']);
    expect(b.hand.canAt(0)!.asleep).toBe(false);
    expect(b.hand.carried).toBe(CAN_RACK_CAP);

    // And the same contact taken at pace is the boot §8 prices the loud lane in.
    b.settle();
    const rest = b.prints.poses.get(0)!;
    b.rig.position.x = rest.x - CAN_REARM_M - 1;
    b.tick();
    b.rig.position.x = rest.x;
    b.rig.velocity.x = CAN_LIFT_SPEED + 1;
    b.rig.groundSpeed = CAN_LIFT_SPEED + 1;
    expect(b.tick().map((s) => s.kind)).toEqual(['impact']);
    expect(b.hand.carried).toBe(CAN_RACK_CAP);
  });

  /**
   * The shell has a top and a bottom, and walking under a can is not walking into it.
   *
   * The body test is a cylinder like the arm's, and a cylinder with no ends is a column of
   * infinite height: a can on a gantry three metres up would be booted by a rig strolling
   * underneath, and a can on the floor by a rig standing on a crate over it. Neither is a
   * contact, and law 2 does not let the game make a noise where nothing touched anything —
   * a `prop-impact` out of a ceiling is a lie that also paints 8-12 m of geometry.
   *
   * Both cans here sit outside the arm as well, so a full rack is not what makes this pass;
   * nothing about either of them is in reach of anything.
   */
  it('does not touch a can it walks under, or one it stands over', () => {
    const b = bench();
    const movement = defaultMovementTunables();
    const above = b.hand.spawnAt(0, movement.standHeight + 1, 0);
    b.rig.position.x = 0;
    b.rig.position.z = 0;
    b.rig.velocity.x = 1;
    b.rig.groundSpeed = 1;
    expect(b.tick()).toEqual([]);
    expect(b.hand.canAt(above)!.asleep).toBe(true);

    // And the other end: the rig up on something, the can on the floor well below its feet.
    const below = b.hand.spawnAt(20, CAN_RADIUS, 0);
    b.rig.position.x = 20;
    b.rig.position.y = CAN_REACH + 1;
    expect(b.tick()).toEqual([]);
    expect(b.hand.canAt(below)!.asleep).toBe(true);
  });

  /**
   * A boot is letting go of a can, hard — so it disarms, exactly as a throw does.
   *
   * Without that, a rig that keeps pace with the can it just kicked passes the contact test again
   * on the very next tick and kicks it again, and again, at 120 Hz: a `prop-impact` per tick,
   * each one an 8–12 m paint event. That is the one failure mode this verb cannot survive, since
   * it turns a mistake into a floodlight and a wall of sound. The re-arm distance is already the
   * game's rule for "you let go of this"; a kick uses it too.
   */
  it('disarms what it kicks, so keeping pace with a can does not re-kick it every tick', () => {
    const b = bench();
    b.hand.spawnAt(4, 0.02, 0);
    b.rig.position.x = 4;
    b.rig.velocity.x = CAN_LIFT_SPEED + 1.5;
    b.rig.groundSpeed = CAN_LIFT_SPEED + 1.5;
    expect(b.tick().map((s) => s.kind)).toEqual(['impact']);
    expect(b.hand.cansSnapshot()[0]!.armed).toBe(false);

    // Chase it: the rig stands on the can every tick, still sprinting.
    let sounds = 0;
    for (let i = 0; i < 240; i++) {
      const can = b.hand.canAt(0);
      if (can !== null) {
        b.rig.position.x = can.x;
        b.rig.position.z = can.z;
      }
      sounds += b.tick().length;
    }
    // The can lands and settles under the rig's feet and that is all: two sounds, not 240.
    expect(sounds).toBeLessThanOrEqual(3);
    expect(b.hand.inWorld).toBe(1);
  });

  it('takes the highest can in reach, so lifting off a column wakes nothing', () => {
    const b = bench();
    // Empty a slot so a lift is possible at all. The discarded can lands a few metres from the
    // rig and 10 m from the stack; it is tracked by id rather than by position so that where it
    // happens to come to rest can never decide this test.
    b.throwAfter(0.05);
    b.settle();
    const stray = new Set(b.hand.cansSnapshot().map((c) => c.id));
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(b.hand.spawnAt(10, 0.05 + i * CAN_STACK_PITCH, 0));
    b.rig.position.x = 10;
    b.rig.groundSpeed = 0;
    b.tick();
    const left = b.hand.cansSnapshot().filter((c) => !stray.has(c.id));
    // Three of the four are left, all still asleep — the top one went, nothing was disturbed.
    expect(left.length).toBe(3);
    expect(left.every((c) => c.asleep)).toBe(true);
    expect(b.hand.canAt(ids[3]!)).toBe(null);
    expect(Math.max(...left.map((c) => c.y))).toBeCloseTo(0.05 + 2 * CAN_STACK_PITCH, 6);
  });

  /**
   * The cascade, on the one column shape that can still trigger it: taller than the rig reaches.
   *
   * Reach is a cylinder `CAN_REACH` tall (`retrieve`), so on any column the rig can see the top
   * of, the highest-first rule takes the top and nothing is ever unsupported — which is the whole
   * reason `world/room.ts` derives its authored count off this same reach. Build one taller and
   * the rule bites: the rig takes the highest can it *can* reach, which is holding up everything
   * above it, and the column comes down from there.
   *
   * So this is two tests in one honest setup. It is the cascade test, and it is the demonstration
   * of what an over-tall stack costs — the failure the room's derivation exists to prevent, kept
   * alive here where it can be measured instead of only argued about in a docstring.
   */
  it('lifting a can that holds up others wakes every one of them, all the way up', () => {
    const b = bench();
    b.throwAfter(0.05);
    b.settle();
    const stray = new Set(b.hand.cansSnapshot().map((c) => c.id));
    const count = Math.ceil((2 * CAN_REACH) / CAN_STACK_PITCH);
    const ids: number[] = [];
    const heightOf = (i: number): number => 0.05 + i * CAN_STACK_PITCH;
    for (let i = 0; i < count; i++) ids.push(b.hand.spawnAt(10, heightOf(i), 0));
    expect(b.prints.poses.size).toBe(count + stray.size);

    const reachable = ids.filter((_, i) => heightOf(i) <= CAN_REACH);
    const above = ids.slice(reachable.length);
    // The setup's own precondition: there has to be a can out of reach for this to mean anything.
    expect(above.length).toBeGreaterThan(0);

    b.rig.position.x = 10 - 0.5;
    b.rig.groundSpeed = 0;
    b.tick();

    expect(b.hand.carried).toBe(CAN_RACK_CAP);
    // Taken: the highest can the rig could reach, which is not the highest can there is.
    expect(b.hand.canAt(reachable[reachable.length - 1]!)).toBe(null);
    for (const id of above) {
      const can = b.hand.canAt(id)!;
      expect(can.asleep, 'a can left with nothing under it is still asleep').toBe(false);
      expect(can.grounded).toBe(false);
    }
    // Everything below the one that went is undisturbed, and its print is still on the floor.
    for (const id of reachable.slice(0, -1)) expect(b.hand.canAt(id)!.asleep).toBe(true);
    expect(b.prints.poses.size).toBe(stray.size + reachable.length - 1);
  });
});

describe('the rack (§5) and the reset', () => {
  it('round-trips: four out, four back, and never more than the cap', () => {
    const b = bench();
    expect(b.hand.carried).toBe(CAN_RACK_CAP);
    const poses: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < CAN_RACK_CAP; i++) {
      b.rig.yaw = (i * Math.PI) / 2;
      b.throwAfter(0.05);
      b.settle();
    }
    expect(b.hand.carried).toBe(0);
    expect(b.hand.inWorld).toBe(CAN_RACK_CAP);
    for (const c of b.hand.cansSnapshot()) poses.push({ x: c.x, z: c.z });

    for (const pose of poses) {
      b.rig.position.x = pose.x + CAN_REARM_M + 1;
      b.rig.position.z = pose.z;
      b.tick();
      b.rig.position.x = pose.x;
      b.tick();
    }
    expect(b.hand.carried).toBe(CAN_RACK_CAP);
    expect(b.hand.inWorld).toBe(0);

    // A fifth can cannot be conjured: the cap is the cap.
    b.hand.spawnAt(0.1, 0.02, 0);
    b.tick();
    expect(b.hand.carried).toBe(CAN_RACK_CAP);
    expect(b.hand.inWorld).toBe(1);
  });

  it('R puts the rack back and takes every thrown can out of the world', () => {
    const game = createHeadlessGame();
    throwInGame(game, 0.05, 5);
    throwInGame(game, 0.05, 5);
    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP - 2);
    expect(game.sim.throwables.inWorld).toBe(BOOT_CANS + 2);
    expect(game.sim.paint.prints.placed).toBe(BOOT_CANS + 2);

    game.input.tapKey('KeyR');
    game.step();

    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    // Back to the room as authored, not to an empty room: R restores a start state, and the
    // stack beside the tank is part of it. Counting alone would pass a reset that left the
    // column lying in a heap, so the poses are checked as well — a respawn that forgot where
    // the room put its cans would be a room that quietly degrades over a session of resets.
    expect(game.sim.throwables.inWorld).toBe(BOOT_CANS);
    expect(game.sim.paint.prints.placed).toBe(BOOT_CANS);
    const back = game.sim.throwables.cansSnapshot();
    for (const authored of CAN_STACK) {
      const match = back.find(
        (c) => Math.hypot(c.x - authored.x, c.y - authored.y, c.z - authored.z) < 1e-9,
      );
      expect(match, `no can back at (${authored.x}, ${authored.y}, ${authored.z})`).toBeDefined();
      expect(match!.asleep).toBe(true);
    }
    game.sim.dispose();
  });

  it('R drops a charge that was in progress', () => {
    const game = createHeadlessGame();
    game.input.hold('throw');
    game.run(0.4);
    expect(game.sim.throwables.charging).toBe(true);
    game.input.tapKey('KeyR');
    game.step();
    expect(game.sim.throwables.charging).toBe(false);
    expect(game.sim.throwables.charge).toBe(0);
    game.input.release('throw');
    game.sim.dispose();
  });
});

describe('the whole verb, in the game', () => {
  it('publishes the rack and the wind-up on debugState', () => {
    const game = createHeadlessGame();
    const idle = game.sim.debugState();
    expect(idle.carriedCans).toBe(CAN_RACK_CAP);
    expect(idle.chargeT).toBe(0);
    expect(idle.worldCans).toBe(BOOT_CANS);
    expect(Array.isArray(idle.canPoses)).toBe(true);

    game.input.hold('throw');
    game.run(0.5);
    const winding = game.sim.debugState();
    expect(Number(winding.chargeT)).toBeCloseTo(0.5, 2);
    expect(winding.charging).toBe(true);

    game.input.release('throw');
    game.run(6);
    const done = game.sim.debugState();
    expect(done.carriedCans).toBe(CAN_RACK_CAP - 1);
    expect(done.worldCans).toBe(BOOT_CANS + 1);
    expect(done.canPrints).toBe(BOOT_CANS + 1);
    const poses = done.canPoses as Array<Record<string, unknown>>;
    expect(poses.length).toBe(BOOT_CANS + 1);
    expect(typeof poses[0]!.x).toBe('number');
    for (const pose of poses) expect(pose.asleep).toBe(true);
    game.sim.dispose();
  });

  it('runs identically twice: the same script produces the same trace', () => {
    const trace = (): string => {
      const game = createHeadlessGame({ seed: 7 });
      const rows: string[] = [];
      game.sim.bus.subscribe((e) => {
        rows.push(
          `${e.seq} ${e.class} ${e.time.toFixed(6)} ${e.x.toFixed(6)} ${e.y.toFixed(6)} ` +
            `${e.z.toFixed(6)} ${e.paintRadius.toFixed(6)} ${e.hearingRadius.toFixed(6)}`,
        );
      });
      game.sim.player.pitch = Math.PI / 7;
      throwInGame(game, CAN_CHARGE_SECONDS + 0.1, 6);
      game.input.hold('forward');
      game.run(2);
      game.input.release('forward');
      throwInGame(game, 0.2, 6);
      for (const c of game.sim.throwables.cansSnapshot()) {
        rows.push(`can ${c.id} ${c.x.toFixed(9)} ${c.y.toFixed(9)} ${c.z.toFixed(9)}`);
      }
      game.sim.dispose();
      return rows.join('\n');
    };
    const a = trace();
    expect(a.length).toBeGreaterThan(0);
    expect(trace()).toBe(a);
  });

  /**
   * A stack coming down is a clatter, not a flood.
   *
   * The loudest thing M2 can do to the bus in one place, driven the way a player produces it —
   * sprint the north lane into the room's own column. Its companion above asserts what happens;
   * this one only asks what it *costs*, because a verb that spikes the event rate spikes the
   * paint pass and the mixer with it, and the failure mode of a clatter is a hitch.
   *
   * Props alone, not the whole bus: seven and a half seconds of sprinting is a dozen footsteps
   * and they are not what is being measured. The peak is per-tick across *everything*, though —
   * a flood does not care which class it came from.
   */
  it('keeps the emission rate sane through a collapsing stack', () => {
    const game = createHeadlessGame();
    atTheStack(game, 3.5);
    const props = recordProps(game);
    let peak = 0;
    game.input.hold('forward');
    game.input.hold('sprint');
    for (let i = 0; i < 900; i++) {
      game.step();
      peak = Math.max(peak, game.sim.bus.emittedThisTick);
    }
    game.input.release('forward');
    game.input.release('sprint');

    // More than one contact per can — a boot, then where it lands — and nowhere near a flood.
    expect(props.length).toBeGreaterThan(BOOT_CANS);
    expect(props.length).toBeLessThanOrEqual(40);
    expect(peak).toBeLessThanOrEqual(8);
    expect(game.sim.throwables.inWorld).toBe(BOOT_CANS);
    game.sim.dispose();
  });

  /**
   * The named tripwire: **the throw verb is a lantern or it is nothing.**
   *
   * Everything else about M2 — the charge curve, the rack, the cairn, the stack — is
   * arrangement around one claim: a can thrown into the dark lights the place it lands,
   * somewhere you are not. If a thrown can ever stops painting on impact, this fails outright
   * and says why, rather than the suite going quietly green around a verb that no longer does
   * anything.
   *
   * It has already caught one real bug. `ballistics.ts` reports a contact at the point *on* the
   * struck face, and a point source lying on a plane grazes that plane at 90° everywhere: emitted
   * there, a `prop-impact` unlocked **0 dots out of 33 880 rays** — a perfectly formed event, on
   * the bus, at the right radius, painting nothing. `PROP_STANDOFF` in `sim.ts` is the fix and
   * this is the test that would have failed without it.
   */
  it('THE THROW IS A LANTERN: a thrown can always paints the place it lands', () => {
    const game = createHeadlessGame();
    game.sim.paint.structured.drain();
    const before = game.sim.paint.structured.getStats().unlockedDots;
    expect(before).toBe(0);

    let heardImpacts = 0;
    game.sim.bus.subscribe((e) => {
      if (e.class !== 'prop-impact') return;
      const l = game.sim.paint.listenerPosition;
      if (SoundBus.canHear(e, l.x, l.y, l.z, game.sim.paint.perception.hearingRange)) {
        heardImpacts++;
      }
    });

    game.sim.player.pitch = Math.PI / 18;
    throwInGame(game, CAN_CHARGE_SECONDS + 0.2, 8);
    game.sim.paint.structured.drain();
    const unlocked = game.sim.paint.structured.getStats().unlockedDots;

    expect(heardImpacts).toBeGreaterThan(0);
    // A walk-step on concrete hands back a couple of thousand dots. An impact you can hear is a
    // deliberate act at three times the radius, so anything in the hundreds means the sound
    // reached the room and the room answered — and anything at zero means it did not.
    expect(unlocked).toBeGreaterThan(2000);
    game.sim.dispose();
  });
});
