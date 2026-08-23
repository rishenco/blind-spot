/**
 * Fixed-step (60 Hz) simulation orchestration (engine-plan §2).
 *
 * The sim owns the world, the clock, the player, the event bus and the systems that write to
 * them. Consumers only ever see the read-only `SimView`. Milestone 2 plugs movement in; paint
 * (M3), player systems (M4) and the dog (M5) join the same `step()`.
 *
 * Order inside a step is deliberate: the bus clock is stamped first so every event emitted this
 * tick carries this tick's time, then movement runs (and emits). Systems that CONSUME events —
 * paint, audio — are listeners on the bus, so they see events in emission order, inside the
 * step that produced them.
 */

import { SIM_MAX_STEPS, SIM_STEP } from './const.js';
import { EventBus } from './events.js';
import { buildWorld, type World } from './map/build.js';
import type { MapDef } from './map/types.js';
import { makeInput, MovementController, type MoveInput } from './movement.js';

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
  readonly time: number;
  readonly steps: number;
}

export class Sim {
  readonly world: World;
  readonly map: MapDef;
  readonly player: PlayerState;
  readonly bus = new EventBus();
  readonly movement: MovementController;
  /** Intent for the next step. The boot layer (or the scripted harness) writes it. */
  readonly input: MoveInput = makeInput();
  time = 0;
  steps = 0;
  private accumulator = 0;

  constructor(map: MapDef) {
    this.map = map;
    this.world = buildWorld(map);
    this.player = {
      x: map.spawn.pos[0],
      y: map.spawn.pos[1],
      z: map.spawn.pos[2],
      yaw: map.spawn.yaw,
      pitch: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      stance: 'stand',
      grounded: true,
    };
    this.movement = new MovementController(this.world, this.player, this.bus);
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
    this.time += dt;
    this.steps++;
    this.bus.now = this.time;
    this.movement.update(dt, this.input);
  }

  /** Fraction of a step left over, for render-side interpolation. */
  get alpha(): number {
    return this.accumulator / SIM_STEP;
  }

  view(): SimView {
    return {
      world: this.world,
      map: this.map,
      player: this.player,
      bus: this.bus,
      movement: this.movement,
      time: this.time,
      steps: this.steps,
    };
  }
}
