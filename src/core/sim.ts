/**
 * Fixed-step (60 Hz) simulation orchestration (engine-plan §2).
 *
 * The sim owns the world, the clock, the player, the event bus and the systems that write to
 * them. Consumers only ever see the read-only `SimView`. Milestone 2 plugs movement in; paint
 * (M3) and player systems (M4) are here, and the dog (M5) joins the same `step()`.
 *
 * Order inside a step is deliberate: the bus clock is stamped first so every event emitted this
 * tick carries this tick's time, then movement runs (and emits), then the player systems — so a
 * ping leaves from the pose this step produced and is billed the gait this step reached. Systems
 * that CONSUME events — paint, audio — are listeners on the bus, so they see events in emission
 * order, inside the step that produced them.
 */

import { SIM_MAX_STEPS, SIM_STEP } from './const.js';
import { EventBus } from './events.js';
import { clamp01, lerp } from './math.js';
import { buildWorld, type World } from './map/build.js';
import type { MapDef } from './map/types.js';
import { makeInput, MovementController, type MoveInput } from './movement.js';
import { PlayerSystems } from './player.js';

export type Stance = 'stand' | 'crouch' | 'slide' | 'air' | 'ladder';

export interface PlayerState {
  /** Position is the capsule's FEET: x/z are the axis centre, y is the sole — not the centre and
   *  not the eye (eye is y + EYE_HEIGHT). The spawn [3, 0, 3] therefore stands ON the interior
   *  floor, whose top is y = 0. */
  x: number;
  y: number;
  z: number;
  /** yaw 0 == +x, increasing toward +z (core/math.ts). */
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  stance: Stance;
  grounded: boolean;
}

export interface SimView {
  readonly world: World;
  readonly map: MapDef;
  readonly player: Readonly<PlayerState>;
  readonly bus: EventBus;
  readonly movement: MovementController;
  readonly playerSystems: PlayerSystems;
  readonly time: number;
  readonly steps: number;
}

export class Sim {
  readonly world: World;
  readonly map: MapDef;
  readonly player: PlayerState;
  readonly bus = new EventBus();
  readonly movement: MovementController;
  readonly playerSystems: PlayerSystems;
  /** Intent for the next step. The boot layer (or the scripted harness) writes it. */
  readonly input: MoveInput = makeInput();
  time = 0;
  steps = 0;
  private accumulator = 0;
  /**
   * The body's pose at the START of the most recent step. The sim runs at a fixed 60 Hz but the
   * renderer does not: on a 144 Hz display more than half of all frames run zero steps, and
   * drawing the raw pose on those frames shows the same image twice or three times in a row —
   * 60 Hz judder on a 144 Hz screen, in a game whose whole pitch is that movement feels good.
   * `renderPos()` blends this with the current pose by `alpha`. Yaw and pitch are deliberately
   * NOT interpolated: look input is applied at the top of the step it arrives in, and blending
   * it backwards would add up to a full step of aim latency to every mouse movement.
   */
  private prevX: number;
  private prevY: number;
  private prevZ: number;

  constructor(map: MapDef) {
    // A Sim OWNS its map. Handed the caller's object by reference, `sampleMap` becomes a live
    // singleton every run writes through — the debug overlay's dog toggle already mutates it,
    // and vision §11's per-run randomisation ("dog patrols, cell placement, cache and trap
    // arming randomized per run") will write to it for real. The second run of a session would
    // then start from the first run's leftovers. One clone at the door makes that impossible.
    this.map = structuredClone(map);
    this.world = buildWorld(this.map);
    this.player = {
      x: this.map.spawn.pos[0],
      y: this.map.spawn.pos[1],
      z: this.map.spawn.pos[2],
      yaw: this.map.spawn.yaw,
      pitch: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      stance: 'stand',
      grounded: true,
    };
    this.movement = new MovementController(this.world, this.player, this.bus);
    this.playerSystems = new PlayerSystems(this.world, this.player, this.movement, this.bus);
    this.prevX = this.player.x;
    this.prevY = this.player.y;
    this.prevZ = this.player.z;
  }

  /** Feed real elapsed seconds; runs whole fixed steps and clamps runaway catch-up. */
  advance(dt: number): number {
    this.accumulator += Math.min(dt, SIM_STEP * SIM_MAX_STEPS);
    let ran = 0;
    while (this.accumulator >= SIM_STEP && ran < SIM_MAX_STEPS) {
      this.step(SIM_STEP);
      this.accumulator -= SIM_STEP;
      ran++;
    }
    return ran;
  }

  /** One fixed tick. Systems are added here milestone by milestone. */
  step(dt: number): void {
    this.prevX = this.player.x;
    this.prevY = this.player.y;
    this.prevZ = this.player.z;
    this.time += dt;
    this.steps++;
    this.bus.now = this.time;
    this.movement.update(dt, this.input);
    this.playerSystems.update(dt);
  }

  /** Fraction of a step left over, for render-side interpolation. */
  get alpha(): number {
    return this.accumulator / SIM_STEP;
  }

  /**
   * Where the body should be DRAWN this frame: the previous and current sim poses blended by
   * `alpha`. Every renderer reads this, never `player.x/y/z` — the raw pose is the simulation's
   * truth at 60 Hz, this is the picture. `alpha` is 0 immediately after a step and rises toward
   * 1 as the next one approaches, so the result is never extrapolated past a pose the sim
   * actually produced.
   */
  renderPos(out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const a = clamp01(this.alpha);
    out[0] = lerp(this.prevX, this.player.x, a);
    out[1] = lerp(this.prevY, this.player.y, a);
    out[2] = lerp(this.prevZ, this.player.z, a);
    return out;
  }

  view(): SimView {
    return {
      world: this.world,
      map: this.map,
      player: this.player,
      bus: this.bus,
      movement: this.movement,
      playerSystems: this.playerSystems,
      time: this.time,
      steps: this.steps,
    };
  }
}
