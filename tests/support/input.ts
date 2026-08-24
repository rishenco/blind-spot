/**
 * A scripted stand-in for `Input`, so the simulation can be driven from a test without a DOM.
 *
 * `PlayerController.update` takes `PlayerInputSource` (`src/core/inputSource.ts`) — the four
 * methods it really needs — so this class satisfies it by implementing that interface, with no
 * cast anywhere. It swaps a whole frame of intent at a time, which is what a table-driven
 * determinism script wants; `src/core/scriptedInput.ts` is the stateful hold/press flavour the
 * headless game harness drives.
 */

import type { Action, PlayerInputSource } from '../../src/core/inputSource';

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

/** An input whose current frame can be swapped between ticks. */
export class ScriptedInput implements PlayerInputSource {
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
}
