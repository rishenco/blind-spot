/**
 * What the simulation is allowed to ask of an input device.
 *
 * The simulation must run with no DOM, so nothing inside it may name the concrete `Input` class
 * — that class exists only to translate `window` and `document` events into intent. These two
 * interfaces are the whole of the contract between them:
 *
 *  - `PlayerInputSource` — the four questions `PlayerController.update` asks each tick.
 *  - `GameInputSource`   — those plus the raw-code edge query the game's hotkeys need, and the
 *                          end-of-tick edge clear the loop owns.
 *
 * `Input` satisfies both structurally and is not told about them: a browser keyboard and a
 * `ScriptedInput` are the *same kind of thing*, which is exactly why tooling can drive the game
 * through real input instead of through setters (see `main.ts`).
 *
 * `Action` still lives with the key bindings in `input.ts`; it is imported here as a type only,
 * so the sim carries no runtime dependency on that module.
 */

import type { Action } from './input';

export type { Action };

/** Everything the player controller reads. */
export interface PlayerInputSource {
  /** Movement intent in local space: x = right, y = forward, magnitude <= 1. */
  moveAxes(): { x: number; y: number };
  /** Returns and clears the accumulated look delta (pixels). */
  consumeLook(): { dx: number; dy: number };
  isDown(action: Action): boolean;
  /** True if the action's key went down during the tick being simulated. */
  wasPressed(action: Action): boolean;
}

/** Everything a whole game tick reads, plus the edge-state clear the driver owns. */
export interface GameInputSource extends PlayerInputSource {
  /** True if this raw key code went down during the tick being simulated (hotkeys). */
  wasKeyPressed(code: string): boolean;
  /** Called once per sim tick, after the tick: edge state is tick-scoped. */
  endTick(): void;
}
