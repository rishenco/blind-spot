/**
 * The whole game, booted and driven in Node, with no DOM and no renderer.
 *
 * `tests/determinism.test.ts` proves the *parts* compose deterministically by wiring them up by
 * hand. This file proves the assembled thing does: `createHeadlessGame` builds the same `GameSim`
 * the browser builds, and `ScriptedInput` drives it through the same `GameInputSource` the
 * keyboard implements — no setters, no mocks, no swapped-out paint system. Everything after M0
 * (dogs, throwables, audio) gets tested through this door.
 *
 * Two things here are not about the simulation being right, but about it being *testable*:
 *  - the DOM guard, which fails loudly the day something inside the sim reaches for `document`;
 *  - the tunables test, which fails the day a dev-panel slider goes back to writing into the
 *    module-level sound table and quietly couples every simulation in the process together.
 */

import { describe, expect, it } from 'vitest';
import { createHeadlessGame } from '../src/game/headless';
import { E_PING_HEIGHT, GameSim } from '../src/game/sim';
import { SOUND_CLASSES, WAVE_SPEEDS, type SoundClassProfile } from '../src/paint/soundEvents';

describe('the headless environment', () => {
  /**
   * The guard the whole file exists to protect. If this ever fails, the test environment grew a
   * DOM and the sim's freedom from one has stopped being checked by anything.
   */
  it('has no DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  it('boots the real game with no renderer, no canvas and no input device', () => {
    const game = createHeadlessGame();
    const s = game.sim.debugState();
    expect(s.structBuilt).toBe(true);
    // The reveal lattice precomputes off the collider list, so an empty world is a silently
    // blank game. `GameSim` asserts the build order; this is the same claim from outside.
    expect(game.sim.world.boxes.length).toBeGreaterThan(0);
    expect(Number(s.structDots)).toBeGreaterThan(0);
    expect(Number(s.structUnlockedDots)).toBe(0);
    game.sim.dispose();
  });
});

describe('walking, headless', () => {
  it('makes footsteps, and the footsteps unlock geometry', () => {
    const game = createHeadlessGame();
    const steps: string[] = [];
    game.sim.bus.subscribe((e) => {
      if (e.class.endsWith('step')) steps.push(e.class);
    });

    game.input.hold('forward');
    game.run(4);
    game.input.release('forward');
    // Finish whatever unlock work the last event left outstanding. It is amortised over wall
    // clock in play (law 5: movement never waits for information), so *when* a dot lights is a
    // timing question; *which* dots light is not.
    game.sim.paint.structured.drain();

    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((c) => c === 'walk-step')).toBe(true);
    expect(Number(game.sim.debugState().structUnlockedDots)).toBeGreaterThan(0);
    game.sim.dispose();
  });

  /**
   * The per-tick order, pinned from outside.
   *
   * `GameSim.tick` brings clock, ears and reveal up to *this* instant before it lets anything
   * emit, so a footstep made at the bottom of the tick is stamped with this tick's time and gated
   * (§3.1) against this tick's listener. All three are read from inside a bus subscriber, which
   * is the one place in the process that can see the middle of a tick. Move any of the three
   * below `player.update` and this goes red.
   */
  it('has the clock, the ears and the reveal all current before anything emits', () => {
    const game = createHeadlessGame();
    /** Per emitted event: how stale each of the three was when the event went out. */
    const stale: Array<{ ears: number; stamp: number; reveal: number }> = [];
    let startX = 0;
    let startY = 0;
    let startZ = 0;

    game.sim.bus.subscribe((e) => {
      const l = game.sim.paint.listenerPosition;
      stale.push({
        // The ears are at this tick's body, not last tick's.
        ears: Math.hypot(l.x - startX, l.y - (startY + E_PING_HEIGHT), l.z - startZ),
        // The bus was stamped with this tick's clock before anything emitted.
        stamp: e.time - game.sim.clock,
        // The reveal was advanced to this tick before it was handed an event to answer.
        reveal: game.sim.paint.clock - game.sim.clock,
      });
    });

    game.input.hold('forward');
    const p = game.sim.player.position;
    for (let tick = 0; tick < 480; tick++) {
      startX = p.x;
      startY = p.y;
      startZ = p.z;
      if (tick === 120 || tick === 300) game.input.tapKey('KeyQ');
      game.step();
    }

    expect(stale.length).toBeGreaterThan(0);
    for (const d of stale) {
      expect(d.ears).toBe(0);
      expect(d.stamp).toBe(0);
      expect(d.reveal).toBe(0);
    }
    game.sim.dispose();
  });

  /**
   * A ping is asked from where the body is when the key is read — before the tick moves it.
   * Three centimetres at a walk, and the reason it is pinned is that the alternative (ping after
   * the move) is invisible to every other test in this file.
   */
  it('fires a ping from the body the tick started with', () => {
    const game = createHeadlessGame();
    game.input.hold('forward');
    game.run(1);

    const p = game.sim.player.position;
    const before = { x: p.x, y: p.y, z: p.z };
    game.input.tapKey('KeyQ');
    game.step();

    const last = game.sim.bus.lastEvent;
    expect(last?.class).toBe('q-ping');
    expect(last?.x).toBe(before.x);
    expect(last?.z).toBe(before.z);
    // It also moved during that same tick, so this is a real distinction and not a tautology.
    expect(p.x).not.toBe(before.x);
    game.sim.dispose();
  });

  it('runs the same number of ticks per simulated second whatever the wall clock does', () => {
    const game = createHeadlessGame({ hz: 100 });
    expect(game.stepSeconds).toBeCloseTo(0.01, 12);
    game.run(2);
    expect(game.sim.clock).toBeCloseTo(2, 9);
    game.sim.dispose();
  });
});

describe('a ping, headless', () => {
  it('is fired by a key, not by a setter, and unlocks the room around it', () => {
    const game = createHeadlessGame();
    const before = game.sim.debugProbe('region', { region: 'crateFront' }) as {
      dots: number;
      unlocked: number;
    };
    expect(before.dots).toBeGreaterThan(0);
    expect(before.unlocked).toBe(0);

    // Exactly the path a player's keyboard takes: a raw code edge that one tick sees.
    game.input.tapKey('KeyQ');
    game.step();
    expect(game.sim.debugState().lastEvent).toBe('q-ping');
    game.sim.paint.structured.drain();

    const after = game.sim.debugProbe('region', { region: 'crateFront' }) as { unlocked: number };
    expect(after.unlocked).toBeGreaterThan(0);

    // §3.5: one ping per 0.75 s, and the cooldown is the sim's, not the driver's. The full 0.75
    // — not 0.75 minus a tick — because the tick decrements the cooldown before it fires, so the
    // ping the decrement enabled starts its own wait from the top.
    expect(game.sim.pingCooldownSeconds).toBe(0.75);
    const events = Number(game.sim.debugState().soundEvents);
    game.input.tapKey('KeyQ');
    game.step();
    expect(Number(game.sim.debugState().soundEvents)).toBe(events);
    game.sim.dispose();
  });
});

// ---------------------------------------------------------------------------

/**
 * The busiest tick of `scriptedRun`, measured — see the characterization test below.
 *
 * One, today, because the only emitter is one player and the script never lines a ping up with
 * the footfall of the same tick. It is not a ceiling: a ping fires at the top of `GameSim.tick`
 * and a footstep at the bottom of `player.update`, so two in a tick is already reachable, and a
 * landing plus a footstep makes three.
 */
const PEAK_PER_TICK = 1;

interface Run {
  trace: number[];
  sounds: string[];
  /** The worst single tick's emission count over the whole script. */
  peakPerTick: number;
}

/**
 * One scripted run: walk, look, ping, sprint, jump, beam. Everything a tick can do, in an order
 * that puts a wave in flight while the body is still moving.
 */
function scriptedRun(seed: number): Run {
  const game = createHeadlessGame({ seed });
  const sounds: string[] = [];
  game.sim.bus.subscribe((e) => {
    sounds.push(
      `${e.seq} ${e.class} ${e.source}#${e.emitter} ${e.time.toFixed(9)} ` +
        `${e.x.toFixed(9)} ${e.z.toFixed(9)} r=${e.paintRadius.toFixed(9)}`,
    );
  });

  const trace: number[] = [];
  const p = game.sim.player.position;
  for (let tick = 0; tick < 720; tick++) {
    if (tick === 0) game.input.hold('forward');
    if (tick === 40) game.input.look(90, 12);
    if (tick === 60) game.input.tapKey('KeyQ');
    if (tick === 200) game.input.hold('sprint');
    if (tick === 300) game.input.press('jump');
    if (tick === 420) game.input.tapKey('KeyE');
    if (tick === 500) {
      game.input.release('sprint');
      game.input.hold('crouch');
    }
    if (tick === 640) game.input.hold('back');
    game.step();
    trace.push(p.x, p.y, p.z);
  }
  const peakPerTick = Number(game.sim.debugState().soundMaxEmittedPerTick);
  game.sim.dispose();
  return { trace, sounds, peakPerTick };
}

describe('how much the bus is asked to carry', () => {
  /**
   * A characterization number, not a budget — the bus gates nothing, and it must not: a dropped
   * event is a sound that painted nothing, which design law 2 forbids outright. What this pins
   * is the *shape* of today's traffic, so that when M2's twenty throwables or M4's spiders
   * arrive, the difference between "more emitters" and "an emitter that fires every tick instead
   * of every contact" is a number in a diff rather than a frame-rate mystery.
   */
  it('pins the scripted run\'s worst tick', () => {
    const run = scriptedRun(1234);
    console.log(`[headless] peak sound events in one tick: ${run.peakPerTick}`);
    expect(run.peakPerTick).toBe(PEAK_PER_TICK);
    // The run really did make noise, so the peak is a measurement and not an empty bus.
    expect(run.sounds.length).toBeGreaterThan(10);
  });

  it('reports the counters through debugState, live', () => {
    const game = createHeadlessGame();
    expect(game.sim.debugState().soundMaxEmittedPerTick).toBe(0);
    game.input.tapKey('KeyQ');
    game.step();
    const s = game.sim.debugState();
    // A ping fires inside the tick that read the key, so both counters see it immediately.
    expect(s.soundEmittedThisTick).toBe(1);
    expect(s.soundMaxEmittedPerTick).toBe(1);

    // The per-tick count resets at the next tick's `bus.setTime`; the peak does not.
    game.step();
    const later = game.sim.debugState();
    expect(later.soundEmittedThisTick).toBe(0);
    expect(later.soundMaxEmittedPerTick).toBe(1);
    game.sim.dispose();
  });
});

describe('determinism of the assembled game', () => {
  it('two runs with the same seed and the same script are identical', () => {
    const a = scriptedRun(1234);
    const b = scriptedRun(1234);
    expect(a.sounds.length).toBeGreaterThan(10);
    // Footsteps first: the tightest signal in the file. A one-tick shift in the per-tick order
    // moves a step's origin, or drops it through the hearing gate, and this list changes.
    expect(b.sounds).toEqual(a.sounds);
    expect(b.trace).toEqual(a.trace);
    expect(b.trace.some((v) => v !== 0)).toBe(true);
  });
});

describe('tunables belong to a simulation, not to the module', () => {
  /**
   * The regression this exists for: the dev panel used to bind lil-gui controls straight into
   * `SOUND_CLASSES` and `WAVE_SPEEDS`, which are module-level singletons. Dragging one slider
   * retuned every simulation in the process and made a seeded run unreproducible.
   */
  it('two GameSim instances do not share the sound table', () => {
    const a = new GameSim();
    const b = new GameSim();

    a.sound.classes['e-ping'].paintRadius = 99;
    a.sound.classes['e-ping'].coneAngleDeg = 13;
    a.sound.waveSpeeds.beam = 7;

    expect(b.sound.classes['e-ping'].paintRadius).toBe(SOUND_CLASSES['e-ping'].paintRadius);
    expect(b.sound.classes['e-ping'].coneAngleDeg).toBe(SOUND_CLASSES['e-ping'].coneAngleDeg);
    expect(b.sound.waveSpeeds.beam).toBe(WAVE_SPEEDS.beam);

    // And the tuning is not cosmetic: it reaches the events each bus actually emits.
    const ea = a.bus.emit({ class: 'e-ping', x: 0, y: 0, z: 0, dirX: 1, dirY: 0, dirZ: 0 });
    const eb = b.bus.emit({ class: 'e-ping', x: 0, y: 0, z: 0, dirX: 1, dirY: 0, dirZ: 0 });
    expect(ea.paintRadius).toBe(99);
    expect(ea.coneAngleDeg).toBe(13);
    expect(ea.waveSpeed).toBe(7);
    expect(eb.paintRadius).toBe(SOUND_CLASSES['e-ping'].paintRadius);
    expect(eb.waveSpeed).toBe(WAVE_SPEEDS.beam);

    a.dispose();
    b.dispose();
  });

  it('the module defaults are frozen, so the old mistake throws instead of spreading', () => {
    expect(Object.isFrozen(SOUND_CLASSES)).toBe(true);
    expect(Object.isFrozen(SOUND_CLASSES['e-ping'])).toBe(true);
    expect(Object.isFrozen(WAVE_SPEEDS)).toBe(true);
    expect(() => {
      (SOUND_CLASSES['e-ping'] as SoundClassProfile).paintRadius = 1;
    }).toThrow(TypeError);
    expect(() => {
      (WAVE_SPEEDS as Record<string, number>).beam = 1;
    }).toThrow(TypeError);
  });
});
