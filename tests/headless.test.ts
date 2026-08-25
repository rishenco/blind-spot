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
import { E_PING_HEIGHT, GameSim, Q_PING_HEIGHT } from '../src/game/sim';
import { MATERIAL_NAMES } from '../src/paint/materials';
import { defaultMovementTunables } from '../src/player/controller';
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

describe('where a ping leaves the rig', () => {
  /*
   * §3.5 gives the two pings different *shapes* and the same reach. The code gives them
   * different origins as well, and until this block existed nothing said so on purpose: the
   * only witness to `Q_PING_HEIGHT` was the whole-room dot-count golden in
   * `tests/raycast.test.ts`, which fails on any change to geometry or emission and is
   * regenerated whenever one is legitimate — i.e. it stops guarding the number at exactly the
   * moment a real regression would ride through with it.
   *
   * So the claim is asserted in its own terms instead. The beam has no freedom: it carries the
   * look vector, so it leaves from the point the look and the ears share. The pulse does have
   * freedom, and the code spends it on the reactor — the height `game.ts` draws the rig marker
   * at, off this same constant.
   */
  it('radiates the pulse from the reactor and the beam from the ears', () => {
    const move = defaultMovementTunables();
    // A point on the body, in *both* stances — 1.15 against a 1.2 m crouched collider, with 5 cm
    // to spare. §3.5 calls Q the panic button, which is the ping you press from behind cover, and
    // a 360° pulse radiating from above a crouched rig's own head would be a sound with nothing
    // at its origin (law 2). `E_PING_HEIGHT` clears the crouched collider and is exempt only
    // because it has no choice: move it off the aim and the beam stops answering where you look.
    expect(Q_PING_HEIGHT).toBeGreaterThan(0);
    expect(Q_PING_HEIGHT).toBeLessThanOrEqual(move.crouchHeight);
    expect(move.crouchHeight).toBeLessThan(move.standHeight);
    // And below the ears, so the room-read and the look-around are not one lantern in two shapes.
    expect(Q_PING_HEIGHT).toBeLessThan(E_PING_HEIGHT);
  });

  it('emits each ping at the height it claims, through the key that fires it', () => {
    // The constants above are only worth bounding if they are the heights the bus actually
    // receives. Driven by key edges rather than by `firePing`, so this is the path a player's
    // keyboard takes, and read off the body the tick started with — see the test above.
    const game = createHeadlessGame();
    const p = game.sim.player.position;

    const feetAtQ = p.y;
    game.input.tapKey('KeyQ');
    game.step();
    expect(game.sim.bus.lastEvent?.class).toBe('q-ping');
    expect(game.sim.bus.lastEvent?.y).toBeCloseTo(feetAtQ + Q_PING_HEIGHT, 12);

    // §3.5's 0.75 s between pings; one simulated second clears it.
    game.run(1);
    const feetAtE = p.y;
    game.input.tapKey('KeyE');
    game.step();
    expect(game.sim.bus.lastEvent?.class).toBe('e-ping');
    expect(game.sim.bus.lastEvent?.y).toBeCloseTo(feetAtE + E_PING_HEIGHT, 12);

    // And a real distance apart on the chassis, measured inside the running game rather than
    // off the table: reactor to ears is 35 cm, and a separation that shrank to a few centimetres
    // would mean the two emitters had merged in everything but the constant's name.
    expect(game.sim.bus.lastEvent!.y - (feetAtE + Q_PING_HEIGHT)).toBeGreaterThan(0.3);
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
 * landing plus a footstep makes three. The material tour put two landings into the run and left
 * this at one, which is the interesting part: no touchdown has yet shared a tick with a footfall.
 */
const PEAK_PER_TICK = 1;

interface Run {
  trace: number[];
  sounds: string[];
  /** The worst single tick's emission count over the whole script. */
  peakPerTick: number;
}

/** A material index as a bus line spells it. `null` is a class that struck nothing — a ping. */
function matName(mat: number | null): string {
  return mat === null ? 'none' : (MATERIAL_NAMES[mat] ?? String(mat));
}

/** Counts the run's bus lines of one class by the material they name: `{ concrete: 18 }`. */
function tally(sounds: readonly string[], cls: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of sounds) {
    if (line.split(' ')[1] !== cls) continue;
    const name = line.split(' ').find((w) => w.startsWith('mat='))!.slice(4);
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

/**
 * One scripted run: walk, look, ping, sprint, jump, beam — everything a tick can do, in an order
 * that puts a wave in flight while the body is still moving — and then a tour across a material
 * boundary and back.
 *
 * The tour is the second half. The original script walks the poured slab and nothing else, which
 * means §3.9's multipliers are all ×1.0 for its whole length: the material table could be deleted
 * and this run would not move a number. So after the original 720 ticks the body turns around,
 * runs back east to the steel bench, steps *onto* it, and drops back off onto concrete. That
 * buys the trace a metal footstep, a metal landing and a concrete landing to compare it with —
 * the loudness law observed from both sides of one boundary, twice.
 *
 * The tour then walks the *other* boundary. Steel is the loud end of §3.9 and it was the only
 * end this run ever visited; dust is the quiet end, and it is the whole reason the table has a
 * class below concrete. So the body carries on south down the east wall, crosses the door-line
 * at z = -1.9 onto the apron (`APRON_Z` in `src/world/room.ts`), walks six steps on it, turns
 * round and comes back onto concrete. Same stride, three surfaces, one run: 6 m of paint on
 * steel, 4 on concrete, 2.4 on dust.
 */
function scriptedRun(seed: number): Run {
  const game = createHeadlessGame({ seed });
  const sounds: string[] = [];
  game.sim.bus.subscribe((e) => {
    sounds.push(
      `${e.seq} ${e.class} ${e.source}#${e.emitter} ${e.time.toFixed(9)} ` +
        `${e.x.toFixed(9)} ${e.z.toFixed(9)} mat=${matName(e.mat)} r=${e.paintRadius.toFixed(9)}`,
    );
  });

  const trace: number[] = [];
  const p = game.sim.player.position;
  for (let tick = 0; tick < 1660; tick++) {
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
    // The material tour. Stand up, turn back east, and walk onto the steel bench.
    if (tick === 720) {
      game.input.release('back');
      game.input.release('crouch');
      game.input.look(-529.2, 0);
    }
    if (tick === 850) game.input.look(439.2, 0);
    // A short hop up onto the bench top: three taps, because one is cut short by the jump-cut
    // and lands too softly to be heard at all (`LANDING_MIN_IMPACT`).
    if (tick >= 875 && tick <= 895 && tick % 5 === 0) game.input.press('jump');
    // And off the far end again, held long enough that the drop back to concrete is audible.
    if (tick === 960) game.input.hold('jump');
    if (tick === 980) game.input.release('jump');
    // Off the wall the drop left it pinned against, so the run ends walking on concrete rather
    // than standing still on it — the return half of the boundary crossing, in footsteps.
    if (tick === 1100) game.input.look(-750, 0);
    // South down the east wall and over the door-line onto the dust apron, then about-face and
    // back onto concrete — the same round trip the bench leg makes, at the quiet end.
    if (tick === 1370) game.input.look(1500, 0);
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

describe('the scripted run crosses a material boundary', () => {
  /**
   * §3.9 is a law about *every* radius a contact event carries, and until this run left the
   * poured slab it was a law nothing here exercised: every multiplier in the trace was concrete's
   * ×1.0, so deleting the material table would have changed no number in this file. Pinning the
   * mix by name and by count is what makes the tour non-deletable in turn — drop the bench leg
   * or the apron leg and these go red rather than quietly going back to one material.
   */
  it('walks off concrete onto steel and onto dust, and the trace says which is which', () => {
    const run = scriptedRun(1234);

    expect(tally(run.sounds, 'walk-step')).toEqual({ concrete: 12, metal: 2, dust: 6 });
    expect(tally(run.sounds, 'sprint-step')).toEqual({ concrete: 6 });
    expect(tally(run.sounds, 'crouch-step')).toEqual({ concrete: 1 });
    // Both directions of the boundary, in the class that costs the most to be wrong about.
    // Dust has no landing because nothing on the apron is high enough to fall off: the one
    // thing standing on it is a 2.4 m crate, and mantling stops at 2.2 m.
    expect(tally(run.sounds, 'landing')).toEqual({ metal: 1, concrete: 1 });

    // And each is a *round trip*, not a one-way walk onto a surface that the run then ends on:
    // the footstep series starts on concrete, visits steel, visits dust, and finishes back on
    // concrete. A boundary crossed once is a boundary that could be a spawn point.
    const steps = run.sounds.filter((l) => l.split(' ')[1].endsWith('step'));
    const mats = steps.map((l) => l.split(' ').find((w) => w.startsWith('mat='))!.slice(4));
    expect(mats[0]).toBe('concrete');
    expect(mats[mats.length - 1]).toBe('concrete');
    for (const mat of ['metal', 'dust']) {
      expect(mats.indexOf(mat)).toBeGreaterThan(0);
      expect(mats.lastIndexOf(mat)).toBeLessThan(mats.length - 1);
    }
    // Steel first, then dust: the two boundaries are separate legs, not one confused smear.
    expect(mats.lastIndexOf('metal')).toBeLessThan(mats.indexOf('dust'));
  });

  /**
   * The player-facing half of §3.9, in the one place that can state it end to end: the *same*
   * stride, on three surfaces, one tour apart. Steel is ×1.5, so the walk-step that paints 4 m
   * of slab paints 6 m of bench; dust is ×0.6, so the same stride paints 2.4 m — and the
   * enemy's column of the §3.3 table moves with all three, because `SoundBus.emit` scales both
   * radii from one multiplier.
   *
   * The ratio is the assertion that matters. Absolute radii move whenever §3.3 is retuned, and
   * they should; what may not move is that the surface is the only thing between them.
   */
  it('and the steel is louder, and the dust quieter, by exactly their multipliers', () => {
    const run = scriptedRun(1234);
    const radiusOf = (mat: string) =>
      Number(
        run.sounds
          .find((l) => l.split(' ')[1] === 'walk-step' && l.includes(`mat=${mat} `))!
          .split('r=')[1],
      );
    expect(radiusOf('concrete')).toBeCloseTo(4, 9);
    expect(radiusOf('metal')).toBeCloseTo(6, 9);
    expect(radiusOf('dust')).toBeCloseTo(2.4, 9);
    expect(radiusOf('metal') / radiusOf('concrete')).toBeCloseTo(1.5, 9);
    expect(radiusOf('dust') / radiusOf('concrete')).toBeCloseTo(0.6, 9);
    // The quiet end is genuinely the quiet end: 2.4 m is barely past the 2 m contact shell, so
    // walking the apron is close to moving blind.
    expect(radiusOf('dust')).toBeLessThan(radiusOf('concrete'));
  });

  /**
   * A ping strikes nothing, so it has no material to be scaled by — `null`, not concrete's 0,
   * because "the default material" and "no material at all" are different answers and only one
   * of them is true of a sonar pulse.
   */
  it('and the pings carry no material at all', () => {
    const run = scriptedRun(1234);
    expect(tally(run.sounds, 'q-ping')).toEqual({ none: 1 });
    expect(tally(run.sounds, 'e-ping')).toEqual({ none: 1 });
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
