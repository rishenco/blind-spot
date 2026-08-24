/**
 * A scripted stand-in for `Input`, so the simulation can be driven from a test without a DOM.
 *
 * `PlayerController.update` only ever calls four methods — `moveAxes`, `consumeLook`, `isDown`
 * and `wasPressed` — so a plain object satisfies it at runtime. Its *declared* parameter type is
 * the concrete `Input` class, whose public surface is wider (`lookMode`, `isCapturing`,
 * `endTick`, `wasKeyPressed`), so the stub needs one cast to typecheck.
 *
 * That cast is deliberately isolated here, in exactly one place. The narrow interface the
 * controller actually depends on is coming in the headless-split work item; when it lands,
 * `PlayerController.update` takes `PlayerInput` instead of `Input`, and the `as unknown as Input`
 * below is deleted with nothing else changing.
 */

import type { Action, Input } from '../../src/core/input';

/** The four methods `PlayerController.update` really needs. */
export interface PlayerInput {
  moveAxes(): { x: number; y: number };
  consumeLook(): { dx: number; dy: number };
  isDown(action: Action): boolean;
  wasPressed(action: Action): boolean;
}

/** One tick's worth of intent. */
export interface InputFrame {
  /** Movement intent in local space: x = right, y = forward. */
  axes: { x: number; y: number };
  /** Mouse delta in pixels for this tick. */
  look: { dx: number; dy: number };
  /** Actions held down this tick. */
  down: readonly Action[];
  /** Actions whose key went down *on* this tick (edge). */
  pressed: readonly Action[];
}

export function emptyFrame(): InputFrame {
  return { axes: { x: 0, y: 0 }, look: { dx: 0, dy: 0 }, down: [], pressed: [] };
}

/**
 * An input whose current frame can be swapped between ticks. The returned value is typed as
 * `Input` for the controller's benefit; the single cast is the one described above.
 */
export class ScriptedInput implements PlayerInput {
  frame: InputFrame = emptyFrame();

  moveAxes(): { x: number; y: number } {
    return this.frame.axes;
  }

  consumeLook(): { dx: number; dy: number } {
    return this.frame.look;
  }

  isDown(action: Action): boolean {
    return this.frame.down.includes(action);
  }

  wasPressed(action: Action): boolean {
    return this.frame.pressed.includes(action);
  }

  /** The same object, wearing the type `PlayerController.update` currently demands. */
  get asInput(): Input {
    return this as unknown as Input;
  }
}
