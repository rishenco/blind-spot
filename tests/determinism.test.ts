/**
 * The flagship: the whole simulation, driven headlessly, twice, and compared exactly.
 *
 * Why this file exists. The browser screenshot suite (`tools/shoot.mjs`) cannot serve as a
 * refactoring safety net: it drives the game for *wall-clock* durations, while `core/loop.ts`
 * discards any frame longer than `maxFrameSeconds` instead of banking it, so under software GL a
 * "2 second" hold simulates a variable amount of time. Two runs of identical, unmodified code
 * drift by dozens of numbers. This file replaces that with a fixed-tick harness: the same script
 * always produces the same trace, so any behavioural change in a later refactor shows up as an
 * exact numeric diff in milliseconds instead of as screenshot noise in minutes.
 *
 * What it proves:
 *  1. the simulation is deterministic under a fixed timestep (run A === run B, exactly);
 *  2. the simulation has no DOM dependency — the guard below fails loudly if one appears;
 *  3. the paint system, attached and fed real sound events, never feeds back into the body.
 */

import { describe, expect, it } from 'vitest';
import { StaticWorld } from '../src/core/collision';
import { PaintSystem } from '../src/paint/paintSystem';
import {
  LANDING_MIN_IMPACT,
  PLAYER_EMITTER_ID,
  SoundBus,
  type SoundClass,
} from '../src/paint/soundEvents';
import { MATERIAL_NAMES } from '../src/paint/materials';
import {
  PlayerController,
  defaultCameraTunables,
  defaultMovementTunables,
} from '../src/player/controller';
import { SPAWN, SPAWN_YAW_DEG, buildRoom } from '../src/world/room';
import { ScriptedInput, type InputFrame } from './support/input';
import type { Action } from '../src/core/input';

const HZ = 120;
const DT = 1 / HZ;
/**
 * Simulated seconds per run. Two runs of this cost well under a second of wall clock.
 *
 * Eight of those seconds are the original script — walk, sprint, crouch-strafe, jump — and the
 * rest is the material tour appended to it (see `frameAt`). The tour is what stops the whole of
 * §3.9 from being deletable without moving a single number in this file.
 */
const SECONDS = 16;
/** Where the head is when the paint system listens, matching `game.ts`'s E_PING_HEIGHT usage. */
const EAR_HEIGHT = 1.5;
/** `game.ts` emits footstep sounds a little above the feet. */
const STEP_SOUND_HEIGHT = 0.1;

/**
 * The tick the material tour starts on — the end of the original eight-second script.
 *
 * Everything before it is untouched, so the first 8 s of this trace is the same 8 s it always
 * was, and every characterization number below that did move can be pointed at a tick after
 * this one.
 */
const TOUR_START = 8 * HZ;
/** The tick the tour stops walking south and turns to face the foot of the stair flight. */
const TOUR_TURN = 1404;
/** The tick the tour jumps, standing on the stone deck. */
const TOUR_DECK_JUMP = 1660;
/**
 * The tick the tour backs away from the wall it fell against.
 *
 * Without it the run ends standing still, pinned in a corner, and `end.x` and `end.speed` become
 * the wall's numbers rather than the run's — a pinned outcome that half a dozen different bugs
 * would still satisfy. Backing off the wall costs 0.4 s and hands the last assertion a body that
 * is somewhere because of everything that happened to it.
 */
const TOUR_BACK = 1870;

/**
 * A fixed script of intent, indexed by tick. Deliberately varied — walk, sprint, crouch-strafe,
 * a jump with the button held (which is also the mantle probe), and a steady mouse turn so the
 * body arcs through the room instead of pinning against one wall.
 *
 * **The tour after `TOUR_START` is coverage, not decoration.** The original eight seconds walk
 * the length of the room on its poured concrete floor and step on nothing else, so every radius
 * in the trace was multiplied by exactly 1.0 and §3.9 could have been deleted without moving a
 * number here. The tour walks the body south along the west wall, turns it east, and marches it
 * up the nine cut-stone treads onto the deck — a run of stone footfalls at 1.15x — where it
 * jumps (a landing on stone) and then walks off the deck's east lip and falls 2.5 m back onto
 * concrete (a landing on the ordinary surface, from the loudest drop in the run). Concrete, then
 * stone, then concrete: the boundary is crossed in both directions, which is the only way a
 * material that is latched once and never updated shows up as a wrong answer rather than as a
 * missing one.
 */
function frameAt(tick: number): InputFrame {
  const t = tick / HZ;
  const down: Action[] = [];
  const pressed: Action[] = [];
  let x = 0;
  let y = 1;
  // A steady 2 px/tick yaw sweep, plus an occasional pitch nudge: enough to curve the run right
  // across the room, through the chokepoint, into the far wall and back out again.
  let dx = 2;
  let dy = tick % 40 === 0 ? -2 : 0;

  if (t < 2) {
    // walk
  } else if (t < 3.5) {
    down.push('sprint');
  } else if (t < 4.5) {
    x = 1;
    down.push('crouch');
  } else if (tick < TOUR_START) {
    // walk
  } else {
    // --- the material tour. The sweep stops here and the turns become deliberate, because
    // where the body goes from now on is the whole point of the extra eight seconds.
    dy = 0;
    if (tick < TOUR_START + 60) {
      // Swing the arc's leftover heading round to due -Z, still walking, and run the west wall.
      dx = 5.5;
    } else if (tick < TOUR_TURN) {
      dx = 0;
    } else if (tick < TOUR_TURN + 60) {
      // Stand and turn to face +X, square on to the foot of the flight. Standing still, because
      // a turn taken while walking arrives at the treads at an angle and climbs the corner.
      dx = 12.5;
      y = 0;
    } else if (tick < TOUR_BACK) {
      dx = 0;
    } else {
      dx = 0;
      y = -1;
    }
  }

  if (tick === 540) pressed.push('jump');
  if (tick >= 540 && tick < 560) down.push('jump');
  // The same jump again, 9.3 s later and 2.52 m higher: the only landing in the run that
  // touches down on something other than the floor.
  if (tick === TOUR_DECK_JUMP) pressed.push('jump');
  if (tick >= TOUR_DECK_JUMP && tick < TOUR_DECK_JUMP + 20) down.push('jump');

  return { axes: { x, y }, look: { dx, dy }, down, pressed };
}

interface RunResult {
  /** Sampled (x, y, z) every `TRACE_EVERY` ticks. */
  trace: number[];
  /** Every footstep and landing the body emitted, serialised. */
  events: string[];
  /** Every sound the bus stamped, serialised. */
  sounds: string[];
  end: { x: number; y: number; z: number; yaw: number; pitch: number; speed: number };
  stepCount: number;
  /** Lattice dots the reveal has unlocked — proof the paint system really ran. */
  unlockedDots: number;
  ms: number;
}

const TRACE_EVERY = 10;

function classFor(tier: 'crouch' | 'walk' | 'sprint'): SoundClass {
  return tier === 'crouch' ? 'crouch-step' : tier === 'sprint' ? 'sprint-step' : 'walk-step';
}

/** A material index as it appears in a trace line. `null` is a class that struck nothing. */
function matName(mat: number | null): string {
  return mat === null ? 'mat=none' : `mat=${MATERIAL_NAMES[mat] ?? mat}`;
}

/** Counts trace lines of one kind by the material they name: `{ concrete: 18, stone: 6 }`. */
function tally(lines: readonly string[], prefix: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    const name = line.split(' ').find((w) => w.startsWith('mat='))!.slice(4);
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

/** One complete headless run: real room, real paint, real controller, no mocks. */
function runSimulation(withPaint: boolean, seconds = SECONDS): RunResult {
  const started = performance.now();

  const world = new StaticWorld();
  buildRoom(world);
  const paint = withPaint ? new PaintSystem(world) : null;
  const bus = new SoundBus();
  if (paint) bus.subscribe(paint.handle);

  const player = new PlayerController(world, defaultMovementTunables(), defaultCameraTunables());
  player.setSpawn(SPAWN, SPAWN_YAW_DEG);

  const events: string[] = [];
  const sounds: string[] = [];
  bus.subscribe((e) => {
    sounds.push(
      `${e.seq} ${e.class} ${e.source}#${e.emitter} ${e.time.toFixed(9)} ` +
        // The material by name, not by index: the whole reason the tour exists is that a run
        // reading `mat=0` everywhere is a run in which §3.9 does nothing, and a name says that
        // at a glance where a 0 hides in a column of coordinates.
        `${e.x.toFixed(9)} ${e.z.toFixed(9)} ${matName(e.mat)} r=${e.paintRadius.toFixed(9)}`,
    );
  });
  player.onEvent((e) => {
    if (e.type === 'footstep') {
      events.push(
        `step ${e.tier} ${e.foot} ${matName(e.mat)} ${e.speed.toFixed(9)} ` +
          `${e.x.toFixed(9)} ${e.y.toFixed(9)} ${e.z.toFixed(9)}`,
      );
      bus.emit({
        class: classFor(e.tier),
        source: 'player',
        emitter: PLAYER_EMITTER_ID,
        x: e.x,
        y: e.y + STEP_SOUND_HEIGHT,
        z: e.z,
        // The harness mirrors `sim.ts`, and since §3.9 the surface is part of how loud a step
        // is. Leaving it off would quietly run the whole determinism suite at 1.0x concrete no
        // matter where the body went.
        mat: e.mat,
      });
      return;
    }
    events.push(
      `land ${e.stance} ${matName(e.mat)} ${e.impactSpeed.toFixed(9)} ` +
        `${e.x.toFixed(9)} ${e.z.toFixed(9)}`,
    );
    /*
     * Landings reach the bus here too, which they did not before.
     *
     * `sim.ts` has always emitted them and this harness had not, so the one class whose radius
     * is computed rather than read from a table — `landingRadius`, the 8-14 m band of §3.3 —
     * was the one class the bit-identity oracle never saw. It is also the class where §3.9's
     * "the multiplier scales every radius the event carries" has its loudest consequence, and
     * the tour now lands on stone as well as on concrete, so the two multiply here or they
     * multiply nowhere.
     */
    if (e.impactSpeed < LANDING_MIN_IMPACT) return;
    bus.emit({
      class: 'landing',
      source: 'player',
      emitter: PLAYER_EMITTER_ID,
      x: e.x,
      y: e.y + STEP_SOUND_HEIGHT,
      z: e.z,
      paintRadius: SoundBus.landingRadius(e.impactSpeed),
      mat: e.mat,
    });
  });

  const input = new ScriptedInput();
  const trace: number[] = [];
  let clock = 0;

  for (let tick = 0; tick < seconds * HZ; tick++) {
    input.frame = frameAt(tick);
    clock += DT;
    bus.setTime(clock);
    if (paint) {
      paint.setListener(player.position.x, player.position.y + EAR_HEIGHT, player.position.z);
      paint.advance(clock);
    }
    player.update(DT, input);
    if (tick % TRACE_EVERY === 0) {
      trace.push(player.position.x, player.position.y, player.position.z);
    }
  }

  const result: RunResult = {
    trace,
    events,
    sounds,
    end: {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      yaw: player.yaw,
      pitch: player.pitch,
      speed: player.state.speed,
    },
    stepCount: player.stepCount,
    unlockedDots: paint ? paint.structured.getStats().unlockedDots : 0,
    ms: performance.now() - started,
  };
  paint?.dispose();
  return result;
}

describe('the headless simulation', () => {
  it('runs with no DOM at all', () => {
    // The load-bearing guard. If someone later reaches for `document` or `window` inside the sim
    // (or inside three.js below WebGLRenderer), this file stops being a safety net, and it should
    // say so here rather than in a confusing failure three tests down.
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  it('builds the real room and its meshes without a renderer', () => {
    const world = new StaticWorld();
    const room = buildRoom(world);
    expect(world.boxes).toHaveLength(60);
    expect(room.reveal.visible).toBe(false);
    room.dispose();
  });
});

describe('determinism under a fixed timestep', () => {
  it('two identical runs produce bit-identical traces, events and end poses', () => {
    const a = runSimulation(true);
    const b = runSimulation(true);

    // Wall time is printed, not asserted: the point is that this whole file costs a fraction of
    // one `tools/shoot.mjs` screenshot, and the number should stay visible as the sim grows.
    console.log(
      `[determinism] ${SECONDS}s simulated x2 with paint: ` +
        `${a.ms.toFixed(0)} ms + ${b.ms.toFixed(0)} ms, ` +
        `${a.trace.length / 3} trace samples, ${a.events.length} body events, ` +
        `${a.sounds.length} sounds, ${a.unlockedDots} dots unlocked`,
    );

    // Element-wise Object.is, reported as the index of the first drift, so a failure names the
    // tick that diverged instead of dumping 288 doubles.
    const firstDrift = a.trace.findIndex((v, i) => !Object.is(v, b.trace[i]));
    expect(firstDrift, `first trace sample to drift (tick ${firstDrift * TRACE_EVERY / 3})`).toBe(-1);
    expect(b.trace).toHaveLength(a.trace.length);

    expect(b.events).toEqual(a.events);
    expect(b.sounds).toEqual(a.sounds);
    expect(b.stepCount).toBe(a.stepCount);

    // Object.is on every end-pose field: exact, and -0 is not 0.
    expect(b.end.x).toBe(a.end.x);
    expect(b.end.y).toBe(a.end.y);
    expect(b.end.z).toBe(a.end.z);
    expect(b.end.yaw).toBe(a.end.yaw);
    expect(b.end.pitch).toBe(a.end.pitch);
    expect(b.end.speed).toBe(a.end.speed);
  });

  it('actually exercised the body and the reveal (a trace of nothing would prove nothing)', () => {
    // A determinism test that drives a body which never moves passes forever and pins nothing.
    // These are the guards that the script really does walk, sprint, crouch, jump, cross the
    // room and hit walls — assert them, and the equality above becomes worth something.
    const run = runSimulation(true);
    expect(run.trace).toHaveLength((SECONDS * HZ / TRACE_EVERY) * 3);
    expect(run.stepCount).toBeGreaterThan(12);
    expect(run.events.length).toBeGreaterThan(run.stepCount);
    // Every footstep rings out, and so does every landing hard enough to be heard — three of
    // the run's four touchdowns clear `LANDING_MIN_IMPACT`; the spawn settle does not.
    expect(run.sounds.length).toBe(run.stepCount + 3);
    expect(run.unlockedDots).toBeGreaterThan(1000);

    const xs = run.trace.filter((_, i) => i % 3 === 0);
    const ys = run.trace.filter((_, i) => i % 3 === 1);
    const zs = run.trace.filter((_, i) => i % 3 === 2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(8); // crossed the long axis
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(5); // and the short one
    expect(Math.max(...ys)).toBeGreaterThan(0.5); // the jump left the floor
    // And the tour really climbed: the stone deck is 2.52 m up, which nothing on the floor
    // reaches. A tour that failed to find the treads would still walk, still emit, and still
    // pass every other guard in this test.
    expect(Math.max(...ys)).toBeGreaterThan(2.5);
    expect(Math.min(...xs)).toBeGreaterThan(-15); // stayed inside the -15 shell wall
  });

  it('pins the run\'s outcome, not just its repeatability', () => {
    // Characterization constants. V8 ships its own fdlibm, so `Math.sin/cos/exp/atan2` are
    // bit-stable across platforms and these numbers are reproducible anywhere Node runs.
    // They are NOT a specification: a deliberate movement retune is expected to move them, and
    // updating them is part of that change. An *accidental* move is the thing being caught.
    const run = runSimulation(false);
    expect(run.stepCount).toBe(32);
    expect(run.end.x).toBeCloseTo(-5.869444444444451, 9);
    expect(run.end.y).toBe(0); // resting on the floor, exactly
    expect(run.end.z).toBeCloseTo(-7.718096982864395, 9);
    expect(run.end.yaw).toBeCloseTo(-1.570796326794979, 9);
    expect(run.end.pitch).toBeCloseTo(0.10053096491487343, 9);
    expect(run.end.speed).toBeCloseTo(3.5, 9);
  });

  it('attaching the paint system changes nothing about the body', () => {
    // Law: the reveal listens, it never steers. If a future paint change reads back into the
    // controller (a shared scratch vector, a mutated tunable), these traces stop matching.
    const withPaint = runSimulation(true);
    const withoutPaint = runSimulation(false);
    expect(withoutPaint.trace).toEqual(withPaint.trace);
    expect(withoutPaint.events).toEqual(withPaint.events);
    expect(withoutPaint.end).toEqual(withPaint.end);
    console.log(
      `[determinism] same ${SECONDS}s without paint: ${withoutPaint.ms.toFixed(1)} ms ` +
        `(vs ${withPaint.ms.toFixed(0)} ms with)`,
    );
  });

  it('a shorter prefix of the same script is a prefix of the same trace', () => {
    // Restating determinism from a different angle: the state at tick N depends only on ticks
    // 0..N, never on how long the run is going to be. Catches accidental look-ahead or any
    // per-run state that is sized from the total tick count.
    const short = runSimulation(true, 3);
    const long = runSimulation(true, SECONDS);
    expect(long.trace.slice(0, short.trace.length)).toEqual(short.trace);
    expect(long.events.slice(0, short.events.length)).toEqual(short.events);
  });
});

describe('the tunables the run was measured against', () => {
  it('pins every default movement number', () => {
    // The traces above are only meaningful next to the numbers that produced them. Anything
    // edited here has to be edited alongside the pinned outcome, which is the point: a tuning
    // change is a two-line diff and an accident is a red test.
    expect(defaultMovementTunables()).toEqual({
      crouchSpeed: 1.7,
      walkSpeed: 3.5,
      sprintSpeed: 6.0,
      groundAccel: 40,
      groundFriction: 30,
      airAccel: 12,
      jumpVelocity: 5.4,
      gravity: 16,
      fallGravityMult: 1.6,
      jumpCutFactor: 0.5,
      coyoteTime: 0.12,
      jumpBuffer: 0.12,
      radius: 0.35,
      standHeight: 1.7,
      crouchHeight: 1.2,
      eyeStand: 1.62,
      eyeCrouch: 1.12,
      stepHeight: 0.3,
      eyeSmoothRate: 8,
      stepSmoothRate: 14,
      sprintMinForward: 0.5,
      landDipMax: 0.12,
      landDipRecovery: 7,
    });
  });

  it('pins every default camera number', () => {
    expect(defaultCameraTunables()).toEqual({
      fov: 90,
      sprintFovBonus: 6,
      fovSmoothRate: 4,
      sensitivity: 0.12,
      pitchClampDeg: 89,
      invertY: false,
    });
  });

  it('hands out a fresh object each call, so a dev-panel edit cannot leak between runs', () => {
    const a = defaultMovementTunables();
    const b = defaultMovementTunables();
    expect(a).not.toBe(b);
    a.walkSpeed = 99;
    expect(defaultMovementTunables().walkSpeed).toBe(3.5);
  });
});

describe('what the run currently does (characterization)', () => {
  it('emits one `land` event per touchdown, not one per grounded tick', () => {
    // `landingSpeed` is an airborne→grounded edge (see moveBody.test.ts), so the whole run
    // contains exactly the four moments the body arrives on a surface:
    //   1. the spawn settling onto the floor on its first tick — one tick of gravity, 16/120
    //      m/s, far under LANDING_MIN_IMPACT and therefore inaudible, but a real touchdown;
    //   2. the scripted jump at tick 540 coming back down at 6.07 m/s, which is audible;
    //   3. the same jump repeated on the stone deck, touching down on stone at the same speed —
    //      the run's only landing on something other than the poured floor;
    //   4. walking off the deck's east lip: a 2.52 m drop at 11.44 m/s, the loudest thing in
    //      the run, back onto concrete.
    // Everything in between — walking, sprinting, crouch-strafing, and marching up nine treads
    // whose 0.28 m risers are inside the 0.3 m step height — is one continuous stance and rings
    // out not at all. A staircase is climbed, not landed on.
    const run = runSimulation(false);
    const lands = run.events.filter((e) => e.startsWith('land '));
    const steps = run.events.filter((e) => e.startsWith('step '));
    expect(steps.length).toBe(run.stepCount);
    expect(run.events.length).toBe(lands.length + steps.length);

    expect(lands).toHaveLength(4);
    const impacts = lands.map((e) => Number(e.split(' ')[3]));
    expect(impacts[0]).toBeCloseTo(16 / HZ, 9); // gravity * dt: the spawn settle
    expect(impacts[1]).toBeCloseTo(6.073333333, 9); // the jump
    expect(impacts[2]).toBeCloseTo(6.073333333, 9); // the same jump, 2.52 m higher
    expect(impacts[3]).toBeCloseTo(11.44, 9); // off the deck
    // Three of the four clear the audible floor, which is what the sound bus filters on.
    expect(impacts.filter((v) => v >= 5)).toHaveLength(3);
  });

  it('classifies gaits the way the tier rule says it does', () => {
    const run = runSimulation(false);
    const tiers = new Set(
      run.events.filter((e) => e.startsWith('step ')).map((e) => e.split(' ')[1]),
    );
    // The script walks, sprints and crouch-strafes, and all three tiers show up.
    expect([...tiers].sort()).toEqual(['crouch', 'sprint', 'walk']);
    // The tier boundary is (walkSpeed + sprintSpeed) / 2 = 4.75 m/s while standing.
    for (const e of run.events) {
      if (!e.startsWith('step ')) continue;
      const [, tier, , , speedText] = e.split(' ');
      const speed = Number(speedText);
      if (tier === 'walk') expect(speed).toBeLessThanOrEqual(4.75);
      if (tier === 'sprint') expect(speed).toBeGreaterThan(4.75);
    }
  });

  it('alternates feet, starting on the left', () => {
    const run = runSimulation(false);
    const feet = run.events.filter((e) => e.startsWith('step ')).map((e) => e.split(' ')[2]);
    expect(feet.length).toBeGreaterThan(20);
    expect(feet[0]).toBe('left');
    for (let i = 1; i < feet.length; i++) expect(feet[i]).not.toBe(feet[i - 1]);
  });

  it('crosses a material boundary, in both directions (§3.9)', () => {
    /*
     * The hole this closes. Before the tour, every footfall and every landing in both scripted
     * runs happened on the room's poured concrete floor, so every radius on the bus was
     * multiplied by exactly 1.0 and the whole of §3.9 could have been deleted without moving a
     * single number in this file. The bit-identity oracle had no coverage of the one law that
     * says what a surface does to a sound.
     *
     * Pinned by *name and count*, not by "more than one": a run that found stone and lost
     * concrete, or one that reported the deck as the floor underneath it, both satisfy "more
     * than one material" and both are wrong.
     */
    const run = runSimulation(false);
    expect(tally(run.events, 'step ')).toEqual({ concrete: 27, stone: 5 });
    expect(tally(run.events, 'land ')).toEqual({ concrete: 3, stone: 1 });
    // The same mix as it reaches the bus, which is the half a listener actually receives. One
    // landing fewer: the spawn settle is under the audible floor and never rings out.
    expect(tally(run.sounds, '')).toEqual({ concrete: 29, stone: 6 });

    // And the crossing is a *round trip*. The first and last surfaces the feet meet are both
    // concrete with stone in between, which is what fails if a material is latched on first
    // contact and never updated — a bug that "the run saw two materials" cannot see.
    const stepMats = run.events
      .filter((e) => e.startsWith('step '))
      .map((e) => e.split(' ')[3]);
    expect(stepMats[0]).toBe('mat=concrete');
    expect(stepMats[stepMats.length - 1]).toBe('mat=concrete');
    expect(stepMats.filter((m) => m === 'mat=stone')).toHaveLength(5);
  });

  it('and the boundary is audible: the same stride is louder on stone (§3.9)', () => {
    // The consequence, read off the trace rather than off the table. A walk-step is 4 m of paint
    // on concrete and 4 x 1.15 = 4.6 m on cut stone, and the multiplication happens once, inside
    // `SoundBus.emit`. If the tour ever stops finding the treads this is the assertion that says
    // so in one line instead of leaving a tally quietly reading zero.
    const run = runSimulation(false);
    const radiusOn = (mat: string): number => {
      const line = run.sounds.find((l) => l.includes('walk-step') && l.includes(`mat=${mat}`))!;
      return Number(line.split('r=')[1]);
    };
    expect(radiusOn('concrete')).toBeCloseTo(4, 9);
    expect(radiusOn('stone')).toBeCloseTo(4.6, 9);
    expect(radiusOn('stone') / radiusOn('concrete')).toBeCloseTo(1.15, 9);
  });

  it('and a landing carries its surface too, not only the drop that made it (§3.9)', () => {
    // The half a class default cannot check. A landing arrives at `SoundBus.emit` with a radius
    // it computed itself from impact speed, and §3.9 says the surface scales *that* — "every
    // radius the event carries, not just the class default". The script jumps twice from
    // standing, so two landings share an impact speed to the last digit and differ only in what
    // they hit: the ratio between their paint radii is the stone multiplier, or the override
    // escaped the multiplication.
    const run = runSimulation(false);
    const landings = run.sounds.filter((l) => l.includes('landing'));
    const byMat = (mat: string) =>
      landings.filter((l) => l.includes(`mat=${mat}`)).map((l) => Number(l.split('r=')[1]));
    const jumps = run.events
      .filter((e) => e.startsWith('land '))
      .map((e) => Number(e.split(' ')[3]));
    // The two standing jumps, one per surface, at the same speed — that is what makes the ratio
    // below a reading of the multiplier rather than a reading of two different falls.
    const stoneLanding = byMat('stone');
    expect(stoneLanding).toHaveLength(1);
    expect(jumps.filter((v) => Math.abs(v - 6.073333333333333) < 1e-9)).toHaveLength(2);
    const concreteJump = byMat('concrete')[0];
    expect(concreteJump).toBeCloseTo(8.715555556, 9);
    expect(stoneLanding[0]).toBeCloseTo(10.022888889, 9);
    expect(stoneLanding[0] / concreteJump).toBeCloseTo(1.15, 9);
  });

  it('starts from the room spawn pose', () => {
    const world = new StaticWorld();
    buildRoom(world);
    const player = new PlayerController(world, defaultMovementTunables(), defaultCameraTunables());
    player.setSpawn(SPAWN, SPAWN_YAW_DEG);
    expect(player.position.toArray()).toEqual([-12.5, 0, 0]);
    expect(player.yaw).toBe(-Math.PI / 2);
    expect(player.pitch).toBe(0);
    expect(player.respawnCount).toBe(1);
    expect(player.state).toEqual({
      grounded: false, stance: 'stand', sprinting: false, mantling: false, speed: 0,
    });
  });
});
