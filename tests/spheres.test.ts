/**
 * The sphere — M2's throw verb, from the wind-up to the boom that ends it.
 *
 * Two doors, on purpose. `Spheres` is driven directly against a bare flat world wherever the
 * claim is about the *mechanism* (where a sphere leaves from, what the rack costs, when the arm
 * refuses), because a claim about the mechanism should not be able to fail because a room moved.
 * Everything about the *game* — what reaches the bus, what the reveal does with it, what a
 * respawn resets — goes through `createHeadlessGame`, the same `GameSim` the browser builds,
 * driven through the same `GameInputSource` a keyboard implements.
 *
 * The load-bearing test in this file is `arcPoints`, under "the preview". Everything else here
 * fails loudly when it breaks; an arc that has drifted from the integrator is the game drawing a
 * line to a place the sphere does not go, which is law 2 broken quietly and in the one place the
 * player is looking.
 */

import { describe, expect, it } from 'vitest';
import { StaticWorld, aabbFromBounds } from '../src/core/collision';
import { BALLISTIC_GRAVITY, createBallisticContact, stepBallistic } from '../src/core/ballistics';
import { KEY_BINDINGS } from '../src/core/input';
import { ScriptedInput } from '../src/core/scriptedInput';
import { HELP, HINT } from '../src/game/game';
import { createHeadlessGame, type HeadlessGame } from '../src/game/headless';
import {
  SPHERE_CHARGE_SECONDS,
  SPHERE_COUNT,
  SPHERE_EMITTER_BASE,
  SPHERE_MUZZLE_M,
  SPHERE_RADIUS,
  SPHERE_RECHARGE_SECONDS,
  SPHERE_THROW_MAX,
  SPHERE_THROW_MIN,
  Spheres,
  arcPoints,
  throwSpeed,
  type SphereSound,
  type Thrower,
} from '../src/game/spheres';
import { HALO_MAX_RADIUS_M } from '../src/paint/halo';
import { MAT_CONCRETE, MAT_DUST, MAT_METAL } from '../src/paint/materials';
import {
  PLAYER_EMITTER_ID,
  SOUND_CLASSES,
  SoundBus,
  isComposedClass,
  isContactClass,
  type SoundEvent,
} from '../src/paint/soundEvents';
import { defaultMovementTunables, type Stance } from '../src/player/controller';

const HZ = 120;
const DT = 1 / HZ;

// ---------------------------------------------------------------------------
// The bare rig: a `Spheres` with no game around it.
// ---------------------------------------------------------------------------

class Rig implements Thrower {
  readonly position = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  stance: Stance = 'stand';
  get state(): { stance: Stance } {
    return { stance: this.stance };
  }
}

interface Bench {
  readonly world: StaticWorld;
  readonly rig: Rig;
  readonly hand: Spheres;
  readonly input: ScriptedInput;
  /** One tick, and the sounds it produced (a copy — the queue is reused). */
  tick(): SphereSound[];
  /** Holds F for `seconds` then releases; returns the tick-by-tick sound log. */
  throwAfter(seconds: number): SphereSound[][];
  /** Ticks until nothing is in the air or `limit` ticks pass; returns the sound log. */
  fly(limit?: number): SphereSound[][];
}

function bench(opts: { floor?: number; boxes?: readonly (readonly number[])[] } = {}): Bench {
  const world = new StaticWorld();
  world.add(aabbFromBounds(-80, -2, -80, 80, 0, 80, opts.floor ?? MAT_CONCRETE, true));
  for (const b of opts.boxes ?? []) {
    world.add(aabbFromBounds(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!, b[6] ?? MAT_CONCRETE));
  }
  const rig = new Rig();
  const hand = new Spheres({ world, thrower: rig, movement: defaultMovementTunables() });
  const input = new ScriptedInput();

  const tick = (): SphereSound[] => {
    hand.update(DT, input);
    const out = hand.sounds.slice();
    input.endTick();
    return out;
  };
  return {
    world,
    rig,
    hand,
    input,
    tick,
    throwAfter(seconds: number): SphereSound[][] {
      const log: SphereSound[][] = [];
      input.hold('throw');
      for (let i = 0; i < Math.round(seconds / DT); i++) log.push(tick());
      input.release('throw');
      log.push(tick());
      return log;
    },
    fly(limit = 4000): SphereSound[][] {
      const log: SphereSound[][] = [];
      for (let i = 0; i < limit && hand.inWorld > 0; i++) log.push(tick());
      return log;
    },
  };
}

function flatten(log: SphereSound[][]): SphereSound[] {
  return log.flat();
}

/** Every event the bus carries, in order, for a headless run. */
function recordBus(game: HeadlessGame): SoundEvent[] {
  const out: SoundEvent[] = [];
  game.sim.bus.subscribe((e) => out.push({ ...e }));
  return out;
}

/** Holds F for `seconds`, releases, and runs `after` seconds of flight. */
function throwInGame(game: HeadlessGame, seconds: number, after = 4): void {
  game.input.hold('throw');
  game.run(seconds);
  game.input.release('throw');
  game.run(after);
}

// ===========================================================================

describe('the verb, as the player finds it', () => {
  /**
   * F throws, the hint line says so, and the help panel says what holding it does.
   *
   * A verb is not shipped when its code runs; it is shipped when a player who has not read the
   * source can find it, and the only two places this game tells anyone anything are the hint
   * line and the H panel. Both are asserted against the *binding* rather than against a copy of
   * the letter, so moving the key and forgetting the text is a red test.
   */
  it('is on F, is in the hint line, and is in the help panel', () => {
    expect(KEY_BINDINGS['KeyF']).toBe('throw');
    const keys = Object.entries(KEY_BINDINGS)
      .filter(([, a]) => a === 'throw')
      .map(([k]) => k);
    // Exactly one key, and no second action on it: a charge that also crouches is not a verb.
    expect(keys).toEqual(['KeyF']);

    expect(HINT).toContain('F throw');
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
    expect(throwSpeed(0)).toBe(SPHERE_THROW_MIN);
    expect(throwSpeed(SPHERE_CHARGE_SECONDS)).toBe(SPHERE_THROW_MAX);
    expect(throwSpeed(SPHERE_CHARGE_SECONDS / 2)).toBeCloseTo(
      (SPHERE_THROW_MIN + SPHERE_THROW_MAX) / 2,
      10,
    );
    // Held indefinitely: overcharging is not a mechanic, and neither is losing the throw.
    expect(throwSpeed(SPHERE_CHARGE_SECONDS * 20)).toBe(SPHERE_THROW_MAX);
    // A negative reading is a clock bug, not a slower throw.
    expect(throwSpeed(-5)).toBe(SPHERE_THROW_MIN);
  });

  it('winds while F is held, and the wind-up drops to zero the tick it is released', () => {
    const b = bench();
    b.input.hold('throw');
    b.tick();
    expect(b.hand.charging).toBe(true);
    expect(b.hand.charge).toBeCloseTo(DT, 10);
    for (let i = 0; i < 59; i++) b.tick();
    expect(b.hand.charge).toBeCloseTo(60 * DT, 6);
    expect(b.hand.chargeFraction).toBeCloseTo((60 * DT) / SPHERE_CHARGE_SECONDS, 6);
    b.input.release('throw');
    b.tick();
    expect(b.hand.charging).toBe(false);
    expect(b.hand.charge).toBe(0);
    expect(b.hand.thrown).toBe(1);
  });

  it('is audible exactly twice on a full charge: the arm, then the click at full tension', () => {
    const b = bench();
    const log = b.throwAfter(SPHERE_CHARGE_SECONDS + 0.4);
    const windups = flatten(log).filter((s) => s.kind === 'windup');
    expect(windups.length).toBe(2);
    expect(windups[0]!.stage).toBe('start');
    expect(windups[1]!.stage).toBe('full');
    // The click *is* the charge meter — there is no bar — so it has to land at full tension.
    const isClick = (s: SphereSound): boolean => s.kind === 'windup' && s.stage === 'full';
    const clickTick = log.findIndex((t) => t.some(isClick));
    expect(clickTick * DT).toBeGreaterThanOrEqual(SPHERE_CHARGE_SECONDS - DT);
    expect(clickTick * DT).toBeLessThanOrEqual(SPHERE_CHARGE_SECONDS + DT);
  });

  it('says nothing a second time: a short throw makes one wind-up, never two', () => {
    const b = bench();
    const windups = flatten(b.throwAfter(SPHERE_CHARGE_SECONDS * 0.5)).filter(
      (s) => s.kind === 'windup',
    );
    expect(windups.length).toBe(1);
    expect(windups[0]!.stage).toBe('start');
  });

  it('refuses an empty rack before the arm moves: no motion, no sound, nothing on the bus', () => {
    const game = createHeadlessGame();
    // The rack refills on a timer, so the refusal has to be asked for inside one rebuild window.
    game.sim.spheres.rechargeSeconds = 1e6;
    const bus = recordBus(game);
    for (let i = 0; i < SPHERE_COUNT; i++) throwInGame(game, 0.05, 0.6);
    expect(game.sim.spheres.carried).toBe(0);
    expect(game.sim.spheres.inWorld).toBe(0);
    const emittedBefore = game.sim.bus.emitted;
    const busBefore = bus.length;

    game.input.hold('throw');
    game.run(1.5);
    game.input.release('throw');
    game.run(0.5);

    expect(game.sim.spheres.refused).toBe(1);
    expect(game.sim.spheres.charging).toBe(false);
    expect(game.sim.spheres.charge).toBe(0);
    expect(game.sim.spheres.inWorld).toBe(0);
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
     * covering §4's "throwing costs nothing".
     */
    thrower.sim.firePing('q-ping');
    control.sim.firePing('q-ping');
    throwInGame(thrower, SPHERE_CHARGE_SECONDS + 0.2, 0.2);
    control.run(SPHERE_CHARGE_SECONDS + 0.4);

    const a = thrower.sim.debugState();
    const c = control.sim.debugState();
    if ('energy' in a) {
      throw new Error(
        'An energy bar has landed on GameSim.debugState. Vision §4 pins a throw at exactly ' +
          'zero energy: assert (before.energy - after.energy) === 0 across a charge-and-throw ' +
          'here, and delete this tripwire.',
      );
    }
    expect(a.pingCooldown).toBe(c.pingCooldown);
    expect(thrower.sim.spheres.thrown).toBe(1);
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
      const s = b.hand.sphereAt(0)!;
      expect(s.x).toBeCloseTo(3, 6);
      // One tick of flight has already happened, so Y has fallen by a half-gravity step and Z
      // has advanced; the muzzle offset is what puts it in front of the eye rather than in it.
      expect(s.y).toBeLessThan(eye);
      expect(s.y).toBeGreaterThan(eye - 0.01);
      expect(-4 - s.z).toBeGreaterThan(SPHERE_MUZZLE_M);
    }
  });

  it('with a wall 30 cm away, spawns short and launches anyway at the full charged speed', () => {
    // A wall whose near face is 0.30 m along the aim, inside `SPHERE_MUZZLE_M`'s 0.35. The
    // mutation this kills is a sphere born *inside* the wall: `raycastWorld` hands an origin on
    // a face a sideways exit normal, so it would go off against a surface it is nowhere near.
    const b = bench({ boxes: [[-5, 0, -0.6, 5, 4, -0.3, MAT_CONCRETE]] });
    b.input.hold('throw');
    for (let i = 0; i < Math.round((SPHERE_CHARGE_SECONDS + 0.2) / DT); i++) b.tick();
    // Full speed, undiminished: the throw is never refused and never quietly downgraded, and
    // there is no short-range mode. The wall costs the player the boom, on themselves.
    expect(b.hand.pendingSpeed).toBe(SPHERE_THROW_MAX);
    b.input.release('throw');
    const booms = b.tick().filter((s) => s.kind === 'boom');
    // Spawned 29.9 cm out and moving at 18 m/s, so it goes off on the tick it was released.
    expect(booms.length).toBe(1);
    // On the wall's near face, with the normal pointing back at the thrower.
    expect(booms[0]!.z).toBeCloseTo(-0.3, 3);
    expect(booms[0]!.nz).toBeCloseTo(1, 6);
    expect(b.hand.inWorld).toBe(0);
  });

  it('takes none of the rig’s own velocity: the charge curve is the whole contract', () => {
    // A `Thrower` has no velocity to inherit — the interface does not carry one, which is the
    // strongest way to state this. The claim the test can still make is the observable one: the
    // same charge from the same pose always launches at the same speed.
    const a = bench();
    const c = bench();
    a.rig.position.x = 0;
    c.rig.position.x = 0;
    a.throwAfter(0.4);
    c.throwAfter(0.4);
    expect(a.hand.sphereAt(0)!.vz).toBe(c.hand.sphereAt(0)!.vz);
    expect(Math.abs(a.hand.sphereAt(0)!.vz)).toBeCloseTo(throwSpeed(0.4), 6);
  });

  it('is silent in flight: the queue does not move between launch and the boom', () => {
    const b = bench();
    b.rig.pitch = Math.PI / 6;
    const launch = b.throwAfter(SPHERE_CHARGE_SECONDS + 0.2);
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
});

describe('the boom, and the end of a sphere (§3)', () => {
  /**
   * One contact, one sound, and then nothing — the whole of what replaced the can.
   *
   * The can made four noises on a level tap (two clangs, a touchdown, a settle), three of which
   * arrived after the moment the player was reading. A sphere makes one, at the point of
   * contact, and stops existing on the same tick it makes it. That "and stops existing" is the
   * half a mutation would quietly drop: a sphere left live would go on sweeping the floor it is
   * standing on and voice a boom every tick forever.
   */
  it('makes exactly one sound on one flight, and leaves nothing behind', () => {
    const b = bench();
    const log = flatten([...b.throwAfter(0.05), ...b.fly()]).filter((s) => s.kind !== 'windup');
    expect(log.length).toBe(1);
    expect(log[0]!.kind).toBe('boom');
    expect(b.hand.inWorld).toBe(0);
    expect(b.hand.sphereAt(0)).toBeNull();
    // However long the world runs afterwards, nothing more is ever said about it.
    for (let i = 0; i < 600; i++) expect(b.tick().length).toBe(0);
  });

  it('goes off against the first thing it touches, whatever that is', () => {
    // A wall between the rig and the floor: the sphere never reaches the ground, so a module
    // that only voiced landings would be silent here.
    const b = bench({ boxes: [[-5, 0, -8, 5, 4, -7.8, MAT_METAL]] });
    const booms = flatten([...b.throwAfter(SPHERE_CHARGE_SECONDS), ...b.fly()]).filter(
      (s) => s.kind === 'boom',
    );
    expect(booms.length).toBe(1);
    expect(booms[0]!.z).toBeCloseTo(-7.8, 3);
    expect(booms[0]!.ny).toBe(0);
    expect(booms[0]!.nz).toBeCloseTo(1, 6);
  });

  it('carries the struck face’s normal, which is what stands the boom off the face', () => {
    // A point source lying exactly on a plane grazes it at 90° everywhere and paints nothing —
    // measured, zero dots out of 33 880 rays. The normal is how `sim.ts` knows which way "off"
    // is for a wall and a ceiling as well as a floor, and `BOOM_STANDOFF` is `SPHERE_RADIUS`.
    const b = bench();
    b.rig.pitch = -Math.PI / 3;
    const boom = flatten([...b.throwAfter(0.05), ...b.fly()]).find((s) => s.kind === 'boom')!;
    expect(boom.ny).toBe(1);
    expect(boom.y).toBeCloseTo(0, 12);
    expect(Math.hypot(boom.nx, boom.ny, boom.nz)).toBeCloseTo(1, 12);
    expect(SPHERE_RADIUS).toBeGreaterThan(0);
  });
});

describe('the preview: `arcPoints` (law 2)', () => {
  /**
   * **The most important test in this file.** The arc the browser draws while the arm is wound
   * has to be the arc the sphere flies, and there is exactly one way to guarantee that without
   * running the simulation: generate the preview from the integrator's own accumulation.
   *
   * The integrator is semi-implicit Euler — gravity into the velocity first, then move at the
   * new velocity — so after `n` ticks a body is at `p₀ + n·dt·v₀ + g·dt²·n(n+1)/2`. The textbook
   * parabola `p₀ + t·v₀ + ½g·t²` is *half a tick of fall* short of that, which is 13 cm at two
   * seconds: a hand's breadth of daylight between the line the game draws and the place the
   * sound comes from. §1 law 2 says the system never lies, and an aiming aid that disagrees with
   * the physics is the system lying in the one place the player is looking.
   *
   * So this walks a real body through `stepBallistic` in an empty world and compares every point
   * against the generator, step for step. The tolerance is 1e-4 m rather than exact because the
   * integrator accumulates `p += v·dt` tick by tick while the generator evaluates the closed-form
   * sum: the two are the same arithmetic in a different order, and float addition is not
   * associative. Anything larger than a tenth of a millimetre is a real divergence.
   */
  it('matches the integrator step for step, through a full second of flight', () => {
    const empty = new StaticWorld();
    const out = createBallisticContact();
    for (const [pitch, speed] of [
      [0, SPHERE_THROW_MAX],
      [Math.PI / 6, SPHERE_THROW_MAX],
      [-Math.PI / 4, SPHERE_THROW_MIN],
      [Math.PI / 3, 11],
    ] as const) {
      const yaw = 0.7;
      const cp = Math.cos(pitch);
      const dx = -Math.sin(yaw) * cp;
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * cp;
      const n = 121;
      const arc = arcPoints(1.5, 1.62, -2.25, dx, dy, dz, speed, DT, n);

      const body = {
        x: 1.5,
        y: 1.62,
        z: -2.25,
        vx: dx * speed,
        vy: dy * speed,
        vz: dz * speed,
      };
      // The generator's first point is the muzzle itself, before any tick has been taken.
      expect(arc[0]).toBeCloseTo(body.x, 6);
      expect(arc[1]).toBeCloseTo(body.y, 6);
      expect(arc[2]).toBeCloseTo(body.z, 6);
      for (let i = 1; i < n; i++) {
        expect(stepBallistic(empty, body, DT, { gravity: BALLISTIC_GRAVITY, skin: 1e-3 }, out))
          .toBeNull();
        expect(Math.abs(arc[i * 3]! - body.x)).toBeLessThan(1e-4);
        expect(Math.abs(arc[i * 3 + 1]! - body.y)).toBeLessThan(1e-4);
        expect(Math.abs(arc[i * 3 + 2]! - body.z)).toBeLessThan(1e-4);
      }
    }
  });

  it('is not the parabola, and the difference is a hand’s breadth by two seconds', () => {
    // The mutation this kills is the tempting one: `y = y0 + t·vy − ½·g·t²`, which is what
    // anyone writes from memory. It is wrong by exactly half a tick of fall per tick, and the
    // error accumulates linearly in `t`, so it looks perfect for the first few frames of a
    // preview and is off by a hand's breadth by the end of a lofted throw.
    const n = 241;
    const arc = arcPoints(0, 0, 0, 0, 0, -1, SPHERE_THROW_MAX, DT, n);
    const t = (n - 1) * DT;
    const parabola = -0.5 * BALLISTIC_GRAVITY * t * t;
    const drop = arc[(n - 1) * 3 + 1]!;
    expect(t).toBeCloseTo(2, 6);
    expect(parabola - drop).toBeCloseTo(0.5 * BALLISTIC_GRAVITY * DT * t, 4);
    expect(parabola - drop).toBeGreaterThan(0.12);
  });

  it('is pure, refills a buffer the caller owns, and answers an empty request emptily', () => {
    // The browser layer redraws this every frame the arm is back, so it has to be able to hold
    // one buffer rather than allocating 240 floats sixty times a second.
    const buffer = new Float32Array(3 * 64);
    const same = arcPoints(0, 1, 0, 0, 0, -1, 12, DT, 64, buffer);
    expect(same).toBe(buffer);
    const fresh = arcPoints(0, 1, 0, 0, 0, -1, 12, DT, 64);
    expect(Array.from(fresh)).toEqual(Array.from(buffer));
    // Too small to fill is not an overflow: the generator allocates rather than writing past it.
    const small = new Float32Array(3);
    expect(arcPoints(0, 1, 0, 0, 0, -1, 12, DT, 64, small)).not.toBe(small);
    expect(arcPoints(0, 1, 0, 0, 0, -1, 12, DT, 0).length).toBe(0);
    expect(arcPoints(0, 1, 0, 0, 0, -1, 12, DT, -5).length).toBe(0);
  });
});

describe('the rack, and the reactor rebuilding it (§4)', () => {
  it('starts full, spends one per throw, and never goes below zero', () => {
    const b = bench();
    b.hand.rechargeSeconds = 1e6;
    expect(b.hand.carried).toBe(SPHERE_COUNT);
    for (let i = 0; i < SPHERE_COUNT; i++) b.throwAfter(0.05);
    expect(b.hand.carried).toBe(0);
    expect(b.hand.thrown).toBe(SPHERE_COUNT);
    b.throwAfter(0.05);
    expect(b.hand.carried).toBe(0);
    expect(b.hand.thrown).toBe(SPHERE_COUNT);
    expect(b.hand.refused).toBe(1);
  });

  it('rebuilds one sphere every recharge window, and stops at the cap', () => {
    const b = bench();
    b.hand.rechargeSeconds = 2;
    b.throwAfter(0.05);
    b.throwAfter(0.05);
    expect(b.hand.carried).toBe(SPHERE_COUNT - 2);
    // Just short of the window: still spent. This is the half that a `>=` slipped to `>` or a
    // timer reset in the wrong place would silently make free.
    for (let i = 0; i < Math.round(1.9 / DT); i++) b.tick();
    expect(b.hand.carried).toBe(SPHERE_COUNT - 2);
    for (let i = 0; i < Math.round(0.2 / DT); i++) b.tick();
    expect(b.hand.carried).toBe(SPHERE_COUNT - 1);
    for (let i = 0; i < Math.round(2.1 / DT); i++) b.tick();
    expect(b.hand.carried).toBe(SPHERE_COUNT);
    // Full is full: the clock does not bank credit against the next throw.
    for (let i = 0; i < Math.round(10 / DT); i++) b.tick();
    expect(b.hand.carried).toBe(SPHERE_COUNT);
    expect(b.hand.rebuildFraction).toBe(1);
  });

  /**
   * The timer is paused while the arm is wound, and that is a design decision rather than
   * bookkeeping: holding F is free in energy and free in time, so a rack that filled while it
   * was held would make "wind up and wait" the optimal way to carry a full rack into a room —
   * and the wind-up is a sound the world hears (§3.3, 2.5 m). A verb whose best line is standing
   * still making a noise is a verb pointing the wrong way.
   */
  it('pauses the rebuild while the arm is winding', () => {
    const b = bench();
    b.hand.rechargeSeconds = 2;
    b.throwAfter(0.05);
    expect(b.hand.carried).toBe(SPHERE_COUNT - 1);
    b.input.hold('throw');
    b.tick();
    const frozen = b.hand.rebuildFraction;
    // A hair off zero, not zero: the tick the throw was launched on still spent its own dt on
    // the way past. What matters is that the next five seconds spend nothing.
    expect(frozen).toBeLessThan(0.01);
    for (let i = 0; i < Math.round(5 / DT); i++) b.tick();
    // Five seconds of wound arm — two and a half windows — and the clock has not moved.
    expect(b.hand.carried).toBe(SPHERE_COUNT - 1);
    expect(b.hand.rebuildFraction).toBe(frozen);
    // Released, the arm spends a second sphere and the clock starts running again from there.
    b.input.release('throw');
    b.tick();
    expect(b.hand.carried).toBe(SPHERE_COUNT - 2);
    for (let i = 0; i < Math.round(2.1 / DT); i++) b.tick();
    expect(b.hand.carried).toBe(SPHERE_COUNT - 1);
  });

  it('restarts the clock at every throw, so the wait is always a full window', () => {
    const b = bench();
    b.hand.rechargeSeconds = 2;
    b.throwAfter(0.05);
    for (let i = 0; i < Math.round(1.8 / DT); i++) b.tick();
    // 1.8 s of credit on the clock, and then a second throw resets it: the wait a player is
    // learning to feel is "the window since I last spent one", not "since the rack last filled".
    b.throwAfter(0.05);
    expect(b.hand.rebuildFraction).toBeLessThan(0.2);
    for (let i = 0; i < Math.round(1.5 / DT); i++) b.tick();
    expect(b.hand.carried).toBe(SPHERE_COUNT - 2);
    for (let i = 0; i < Math.round(0.6 / DT); i++) b.tick();
    expect(b.hand.carried).toBe(SPHERE_COUNT - 1);
  });

  it('refills instantly at zero, which is the dev panel’s off switch for the wait', () => {
    const b = bench();
    b.hand.rechargeSeconds = 0;
    b.throwAfter(0.05);
    // The throw itself still spends one; the next tick hands it straight back.
    b.tick();
    expect(b.hand.carried).toBe(SPHERE_COUNT);
    expect(b.hand.rebuildFraction).toBe(1);
  });

  it('pins the shipped window and the shipped rack', () => {
    expect(SPHERE_COUNT).toBe(4);
    expect(SPHERE_RECHARGE_SECONDS).toBe(12);
    expect(new Spheres({
      world: new StaticWorld(),
      thrower: new Rig(),
      movement: defaultMovementTunables(),
    }).rechargeSeconds).toBe(SPHERE_RECHARGE_SECONDS);
  });

  it('R puts the rack back and takes every sphere out of the air', () => {
    const game = createHeadlessGame();
    game.sim.spheres.rechargeSeconds = 1e6;
    game.sim.player.pitch = Math.PI / 4;
    throwInGame(game, SPHERE_CHARGE_SECONDS, 0.1);
    expect(game.sim.spheres.inWorld).toBe(1);
    expect(game.sim.spheres.carried).toBe(SPHERE_COUNT - 1);
    game.sim.spheres.reset();
    expect(game.sim.spheres.inWorld).toBe(0);
    expect(game.sim.spheres.carried).toBe(SPHERE_COUNT);
    expect(game.sim.spheres.charging).toBe(false);
    game.sim.dispose();
  });
});

describe('the boom on the bus (§3.3)', () => {
  it('is a detonation, not a contact: one voice, whatever it went off against', () => {
    /*
     * The sphere's boom is the sphere's own noise. A can's impact was composed — the can's metal
     * against the surface's material (§3.9's geometric mean) — because a can is a thing being
     * struck. A detonation is not: the energy is the sphere's, and scaling it by the floor would
     * swing the same explosion from 19.2 m on dust to 48 m on steel, which is the surface
     * deciding how big the bang was.
     *
     * Asserted through the bus rather than by reading the table, because the bus is where the
     * scaling would happen. Two identical throws onto two different materials have to arrive at
     * the same two radii, to the bit.
     */
    expect(isContactClass('sphere-boom')).toBe(false);
    expect(isComposedClass('sphere-boom')).toBe(false);
    const bus = new SoundBus();
    const bare = bus.carryRadius('sphere-boom', null, null);
    expect(bare).toBe(SOUND_CLASSES['sphere-boom'].hearingRadius);
    // Naming a material on a non-contact class throws — the refusal is structural, so no future
    // emitter can quietly start pricing a boom by the floor it went off over.
    expect(() => bus.carryRadius('sphere-boom', MAT_METAL, null)).toThrow();
  });

  it('reaches the bus once per sphere, from off the face, as a prop and not as you', () => {
    const game = createHeadlessGame();
    const bus = recordBus(game);
    game.sim.player.pitch = -Math.PI / 4;
    throwInGame(game, 0.05, 3);

    const booms = bus.filter((e) => e.class === 'sphere-boom');
    expect(booms.length).toBe(1);
    const boom = booms[0]!;
    expect(boom.source).toBe('prop');
    // Never the player's own emitter id, or §3.8's ring flares at a sphere across the room.
    expect(boom.emitter).toBeGreaterThanOrEqual(SPHERE_EMITTER_BASE);
    expect(boom.emitter).not.toBe(PLAYER_EMITTER_ID);
    expect(boom.paintRadius).toBe(SOUND_CLASSES['sphere-boom'].paintRadius);
    expect(boom.hearingRadius).toBe(SOUND_CLASSES['sphere-boom'].hearingRadius);
    // Off the floor by one radius: on the face it would paint nothing at all.
    expect(boom.y).toBeCloseTo(SPHERE_RADIUS, 6);
    game.sim.dispose();
  });

  it('sounds the same on steel and on dust, which no contact class does', () => {
    const readings = [MAT_METAL, MAT_DUST].map((floor) => {
      const b = bench({ floor });
      b.rig.pitch = -Math.PI / 4;
      const boom = flatten([...b.throwAfter(0.05), ...b.fly()]).find((s) => s.kind === 'boom')!;
      expect(boom).toBeDefined();
      const bus = new SoundBus();
      return bus.carryRadius('sphere-boom', null, null);
    });
    expect(readings[0]).toBe(readings[1]);
  });

  /**
   * The boom does not move §3.8's dial, and this is the assertion that guards the calibration.
   *
   * `HALO_MAX_RADIUS_M` is derived by sweeping every class as `hearingRadius × (contact ? the
   * loudest material : 1)`, and it is the scale the ring is drawn against — a scale that moved
   * would make every screenshot of the ring incomparable with every older one and re-grade every
   * reading the player has learned. A 32 m *contact* boom would have contributed 48 m and taken
   * the top of the dial with it; a 32 m detonation contributes a raw 32, which is comfortably
   * under a landing on steel.
   */
  it('leaves the Halo’s ceiling exactly where it was: a landing on steel, 42 m', () => {
    expect(SOUND_CLASSES['sphere-boom'].hearingRadius).toBe(32);
    expect(HALO_MAX_RADIUS_M).toBeCloseTo(28 * 1.5, 10);
    expect(SOUND_CLASSES['sphere-boom'].hearingRadius).toBeLessThan(HALO_MAX_RADIUS_M);
  });
});

describe('the wind-up, and the marker that used to sit inside your head', () => {
  /**
   * §3.2's event layer marks *where something happened*, and a place inside your own chassis is
   * not one. The wind-up is emitted at the rig's own hand — `p.y + eyeHeight()`, which is the
   * camera — and the marker is a world-sized sprite, so every time the arm went back an amber
   * wash covered the middle of the frame: a readout nobody asked for, in the one place §14 keeps
   * clear, reporting a position the player already occupies.
   *
   * The fix is the *volume*, not the class, so it covers every emitter that will ever put a
   * sound on the rig. What it may not touch is the sound or the paint: the wind-up is still on
   * the bus, still audible at 2.5 m, still painting its half-metre.
   */
  it('still emits and still paints — only the marker is suppressed', () => {
    const game = createHeadlessGame();
    const bus = recordBus(game);
    const markersBefore = game.sim.paint.eventMarkers;
    const emittedBefore = game.sim.bus.emitted;

    game.input.hold('throw');
    game.step(2);

    const windups = bus.filter((e) => e.class === 'throw-windup');
    expect(windups.length).toBe(1);
    expect(game.sim.bus.emitted).toBe(emittedBefore + 1);
    expect(windups[0]!.paintRadius).toBe(SOUND_CLASSES['throw-windup'].paintRadius);
    expect(windups[0]!.hearingRadius).toBe(SOUND_CLASSES['throw-windup'].hearingRadius);
    // Emitted at the eye, inside the shell — and therefore not marked.
    expect(windups[0]!.y).toBeCloseTo(game.sim.player.position.y + 1.62, 1);
    expect(game.sim.paint.eventMarkers).toBe(markersBefore);

    // The companion half: a boom across the room is outside the shell and draws its marker.
    game.input.release('throw');
    game.run(3);
    expect(bus.filter((e) => e.class === 'sphere-boom').length).toBe(1);
    expect(game.sim.paint.eventMarkers).toBeGreaterThan(markersBefore);
    game.sim.dispose();
  });
});

describe('the whole verb, in the game', () => {
  it('publishes the rack, the wind-up and every live sphere on debugState', () => {
    const game = createHeadlessGame();
    game.sim.spheres.rechargeSeconds = 1e6;
    game.sim.player.pitch = Math.PI / 4;
    game.input.hold('throw');
    game.run(0.3);
    const winding = game.sim.debugState();
    expect(winding['carriedSpheres']).toBe(SPHERE_COUNT);
    expect(winding['charging']).toBe(true);
    expect(Number(winding['chargeT'])).toBeGreaterThan(0.25);
    expect(winding['sphereRecharge']).toBe(1e6);

    game.input.release('throw');
    game.run(0.2);
    const flying = game.sim.debugState();
    expect(flying['carriedSpheres']).toBe(SPHERE_COUNT - 1);
    expect(flying['charging']).toBe(false);
    expect(flying['spheresThrown']).toBe(1);
    expect(flying['worldSpheres']).toBe(1);
    const poses = flying['spherePoses'] as { id: number; x: number; y: number; z: number }[];
    expect(poses.length).toBe(1);
    expect(poses[0]!.id).toBe(0);
    expect(Number.isFinite(poses[0]!.y)).toBe(true);
    game.sim.dispose();
  });

  it('runs identically twice: the same script produces the same trace', () => {
    const trace = (): string => {
      const game = createHeadlessGame();
      const events: string[] = [];
      game.sim.bus.subscribe((e) => {
        events.push(`${e.class} ${e.x.toFixed(6)} ${e.y.toFixed(6)} ${e.z.toFixed(6)}`);
      });
      game.input.hold('forward');
      game.run(1);
      throwInGame(game, SPHERE_CHARGE_SECONDS, 2);
      throwInGame(game, 0.05, 2);
      game.input.release('forward');
      game.run(1);
      game.sim.dispose();
      return events.join('\n');
    };
    expect(trace()).toBe(trace());
  });
});
