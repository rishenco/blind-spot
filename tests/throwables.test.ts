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
  CAN_REARM_M,
  CAN_STACK_PITCH,
  CAN_THROW_MAX,
  CAN_THROW_MIN,
} from '../src/world/cans';

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
    throwInGame(game, 0.05, 8);
    const prints = game.sim.paint.prints;
    expect(game.sim.throwables.inWorld).toBe(1);
    expect(prints.placed).toBe(1);

    const can = game.sim.throwables.cansSnapshot()[0]!;
    const p = game.sim.player.position;
    const dist = Math.hypot(can.x - p.x, can.z - p.z);
    // Precondition, stated out loud: a tap has to land inside a Q-ping or this proves nothing.
    expect(dist).toBeLessThan(SOUND_CLASSES['q-ping'].paintRadius);

    game.sim.paint.clear();
    expect(prints.placed).toBe(1);
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
    throwInGame(near, 0.05, 8);
    const can = near.sim.throwables.cansSnapshot()[0]!;
    const p = near.sim.player.position;
    const d = Math.hypot(can.x - p.x, can.y - p.y, can.z - p.z);
    expect(d).toBeLessThan(SOUND_CLASSES['prop-knock'].hearingRadius);
    expect(near.sim.paint.prints.placed).toBe(1);
    expect(near.sim.paint.prints.known).toBe(1);
    near.sim.dispose();

    const far = createHeadlessGame();
    throwInGame(far, 0.05, 8);
    const fcan = far.sim.throwables.cansSnapshot()[0]!;
    const fp = far.sim.player.position;
    const fd = Math.hypot(fcan.x - fp.x, fcan.y - fp.y, fcan.z - fp.z);
    expect(fd).toBeGreaterThan(SOUND_CLASSES['prop-knock'].hearingRadius * 1.5);
    expect(far.sim.paint.prints.placed).toBe(1);
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

  it('a full rack cannot lift, but it can still kick', () => {
    const b = bench();
    b.hand.spawnAt(4, 0.02, 0);
    expect(b.hand.carried).toBe(CAN_RACK_CAP);
    b.rig.position.x = 4;
    b.rig.groundSpeed = 1;
    expect(b.tick()).toEqual([]);
    expect(b.hand.inWorld).toBe(1);
    expect(b.hand.canAt(0)!.asleep).toBe(true);

    b.rig.velocity.x = CAN_LIFT_SPEED + 1;
    b.rig.groundSpeed = CAN_LIFT_SPEED + 1;
    const sounds = b.tick();
    expect(sounds.map((s) => s.kind)).toEqual(['impact']);
    expect(b.hand.canAt(0)!.asleep).toBe(false);
    expect(b.hand.carried).toBe(CAN_RACK_CAP);
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

  it('lifting a can that holds up others wakes every one of them, all the way up', () => {
    const b = bench();
    b.throwAfter(0.05);
    b.settle();
    const stray = new Set(b.hand.cansSnapshot().map((c) => c.id));
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(b.hand.spawnAt(10, 0.05 + i * CAN_STACK_PITCH, 0));
    expect(b.prints.poses.size).toBe(6 + stray.size);

    // Reach the bottom can only: 0.58 m to the side puts every can above it out of `CAN_REACH`.
    b.rig.position.x = 10 - 0.58;
    b.rig.groundSpeed = 0;
    b.tick();

    expect(b.hand.carried).toBe(CAN_RACK_CAP);
    const left = b.hand.cansSnapshot().filter((c) => !stray.has(c.id));
    expect(left.length).toBe(5);
    // Every survivor is awake and every print is gone: the column is coming down.
    expect(left.every((c) => !c.asleep)).toBe(true);
    expect(b.prints.poses.size).toBe(stray.size);
    for (const id of ids.slice(1)) expect(b.hand.canAt(id)!.grounded).toBe(false);
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
    expect(game.sim.throwables.inWorld).toBe(2);
    expect(game.sim.paint.prints.placed).toBe(2);

    game.input.tapKey('KeyR');
    game.step();

    expect(game.sim.throwables.carried).toBe(CAN_RACK_CAP);
    expect(game.sim.throwables.inWorld).toBe(0);
    expect(game.sim.paint.prints.placed).toBe(0);
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
    expect(idle.worldCans).toBe(0);
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
    expect(done.worldCans).toBe(1);
    expect(done.canPrints).toBe(1);
    const poses = done.canPoses as Array<Record<string, unknown>>;
    expect(poses.length).toBe(1);
    expect(typeof poses[0]!.x).toBe('number');
    expect(poses[0]!.asleep).toBe(true);
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

  it('keeps the emission rate sane through a six-can cascade', () => {
    const game = createHeadlessGame();
    throwInGame(game, 0.05, 5);
    const p = game.sim.player.position;
    for (let i = 0; i < 6; i++) {
      game.sim.throwables.spawnAt(p.x + 0.58, 0.05 + i * CAN_STACK_PITCH, p.z);
    }
    const before = game.sim.bus.emitted;
    let peak = 0;
    for (let i = 0; i < 900; i++) {
      game.step();
      peak = Math.max(peak, game.sim.bus.emittedThisTick);
    }
    const total = game.sim.bus.emitted - before;
    // A stack coming down is a clatter, not a flood: the whole collapse costs fewer events than
    // four seconds of sprinting, and no single tick emits more than a handful.
    expect(total).toBeGreaterThan(6);
    expect(total).toBeLessThanOrEqual(40);
    expect(peak).toBeLessThanOrEqual(8);
    expect(game.sim.throwables.inWorld).toBe(6);
    game.sim.dispose();
  });

  /**
   * The named tripwire: **the throw verb is a lantern or it is nothing.**
   *
   * Everything else about M2 — the charge curve, the rack, the cairn, the stack — is
   * arrangement around one claim: a can thrown into the dark lights the place it lands,
   * somewhere you are not. If a thrown can ever stops painting on impact, this fails outright and says why, rather
   * than the suite going quietly green around a verb that no longer does anything.
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
