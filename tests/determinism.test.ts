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
import { PLAYER_EMITTER_ID, SoundBus, type SoundClass } from '../src/paint/soundEvents';
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
/** Simulated seconds per run. Two runs of this cost well under a second of wall clock. */
const SECONDS = 8;
/** Where the head is when the paint system listens, matching `game.ts`'s E_PING_HEIGHT usage. */
const EAR_HEIGHT = 1.5;
/** `game.ts` emits footstep sounds a little above the feet. */
const STEP_SOUND_HEIGHT = 0.1;

/**
 * A fixed script of intent, indexed by tick. Deliberately varied — walk, sprint, crouch-strafe,
 * a jump with the button held (which is also the mantle probe), and a steady mouse turn so the
 * body arcs through the room instead of pinning against one wall.
 */
function frameAt(tick: number): InputFrame {
  const t = tick / HZ;
  const down: Action[] = [];
  const pressed: Action[] = [];
  let x = 0;
  let y = 0;

  if (t < 2) {
    y = 1;
  } else if (t < 3.5) {
    y = 1;
    down.push('sprint');
  } else if (t < 4.5) {
    y = 1;
    x = 1;
    down.push('crouch');
  } else {
    y = 1;
  }

  if (tick === 540) pressed.push('jump');
  if (tick >= 540 && tick < 560) down.push('jump');

  // A steady 2 px/tick yaw sweep, plus an occasional pitch nudge: enough to curve the run right
  // across the room, through the chokepoint, into the far wall and back out again.
  return { axes: { x, y }, look: { dx: 2, dy: tick % 40 === 0 ? -2 : 0 }, down, pressed };
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
        `${e.x.toFixed(9)} ${e.z.toFixed(9)} r=${e.paintRadius.toFixed(9)}`,
    );
  });
  player.onEvent((e) => {
    if (e.type === 'footstep') {
      events.push(`step ${e.tier} ${e.foot} ${e.speed.toFixed(9)} ${e.x.toFixed(9)} ${e.y.toFixed(9)} ${e.z.toFixed(9)}`);
      bus.emit({
        class: classFor(e.tier),
        source: 'player',
        emitter: PLAYER_EMITTER_ID,
        x: e.x,
        y: e.y + STEP_SOUND_HEIGHT,
        z: e.z,
      });
      return;
    }
    events.push(`land ${e.stance} ${e.impactSpeed.toFixed(9)} ${e.x.toFixed(9)} ${e.z.toFixed(9)}`);
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
    expect(run.sounds.length).toBe(run.stepCount);
    expect(run.unlockedDots).toBeGreaterThan(1000);

    const xs = run.trace.filter((_, i) => i % 3 === 0);
    const ys = run.trace.filter((_, i) => i % 3 === 1);
    const zs = run.trace.filter((_, i) => i % 3 === 2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(8); // crossed the long axis
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(5); // and the short one
    expect(Math.max(...ys)).toBeGreaterThan(0.5); // the jump left the floor
    expect(Math.min(...xs)).toBeGreaterThan(-15); // stayed inside the -15 shell wall
  });

  it('pins the run\'s outcome, not just its repeatability', () => {
    // Characterization constants. V8 ships its own fdlibm, so `Math.sin/cos/exp/atan2` are
    // bit-stable across platforms and these numbers are reproducible anywhere Node runs.
    // They are NOT a specification: a deliberate movement retune is expected to move them, and
    // updating them is part of that change. An *accidental* move is the thing being caught.
    const run = runSimulation(false);
    expect(run.stepCount).toBe(18);
    expect(run.end.x).toBeCloseTo(-14.65, 9);
    expect(run.end.y).toBe(0); // resting on the floor, exactly
    expect(run.end.z).toBeCloseTo(5.526392270089369, 9);
    expect(run.end.yaw).toBeCloseTo(0.6911503837896704, 9);
    expect(run.end.pitch).toBeCloseTo(0.10053096491487343, 9);
    expect(run.end.speed).toBeCloseTo(3.7794682539109683, 9);
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
    // `landingSpeed` is an airborne→grounded edge (see moveBody.test.ts), so the whole 8 s run
    // contains exactly the two moments the body arrives on a surface:
    //   1. the spawn settling onto the floor on its first tick — one tick of gravity, 16/120
    //      m/s, far under LANDING_MIN_IMPACT and therefore inaudible, but a real touchdown;
    //   2. the scripted jump at tick 540 coming back down at 6.07 m/s, which is audible.
    // Everything in between — 8 seconds of walking, sprinting and crouch-strafing across a flat
    // floor — is one continuous stance and rings out not at all.
    const run = runSimulation(false);
    const lands = run.events.filter((e) => e.startsWith('land '));
    const steps = run.events.filter((e) => e.startsWith('step '));
    expect(steps.length).toBe(run.stepCount);
    expect(run.events.length).toBe(lands.length + steps.length);

    expect(lands).toHaveLength(2);
    const impacts = lands.map((e) => Number(e.split(' ')[2]));
    expect(impacts[0]).toBeCloseTo(16 / HZ, 9); // gravity * dt: the spawn settle
    expect(impacts[1]).toBeCloseTo(6.073333333, 9); // the jump
    // One of the two clears the audible floor, which is what the sound bus filters on.
    expect(impacts.filter((v) => v >= 5)).toHaveLength(1);
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
      const [, tier, , speedText] = e.split(' ');
      const speed = Number(speedText);
      if (tier === 'walk') expect(speed).toBeLessThanOrEqual(4.75);
      if (tier === 'sprint') expect(speed).toBeGreaterThan(4.75);
    }
  });

  it('alternates feet, starting on the left', () => {
    const run = runSimulation(false);
    const feet = run.events.filter((e) => e.startsWith('step ')).map((e) => e.split(' ')[2]);
    expect(feet[0]).toBe('left');
    for (let i = 1; i < feet.length; i++) expect(feet[i]).not.toBe(feet[i - 1]);
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
