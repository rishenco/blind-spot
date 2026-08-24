/**
 * An input device driven by a script instead of by hands.
 *
 * It implements `GameInputSource` — the same interface the browser's `Input` satisfies — so a
 * test or a tool drives the game exactly the way a player does: by holding keys and letting the
 * tick read them. That is why `window.__blindspot` exposes no setters and never will. Nothing in
 * here reaches for `window`, `document` or a timer.
 *
 * Edge semantics are `input.ts`'s, deliberately: a key that goes down is *down* and also
 * *pressed this tick*, and `endTick` clears the pressed sets and nothing else. Get that wrong
 * and the hotkeys (Q, E, R, T, K) fire on every tick a key is held rather than once.
 */

import type { Action, GameInputSource } from './inputSource';

export class ScriptedInput implements GameInputSource {
  private readonly down = new Set<Action>();
  private readonly pressedThisTick = new Set<Action>();
  private readonly codesPressedThisTick = new Set<string>();
  /** Actions held for exactly one tick by `press`, released by `endTick`. */
  private readonly taps = new Set<Action>();

  private lookX = 0;
  private lookY = 0;

  // Returned by value from the tick path, so they are allocated once and reused (`Input` is
  // free to allocate; a harness that runs a million ticks is not).
  private readonly axes = { x: 0, y: 0 };
  private readonly lookDelta = { dx: 0, dy: 0 };

  // ---- driving it ----------------------------------------------------------

  /** Presses a key and keeps it down. The press edge fires once, on this tick. */
  hold(action: Action): void {
    if (this.down.has(action)) return;
    this.down.add(action);
    this.pressedThisTick.add(action);
  }

  /** Releases a held key. */
  release(action: Action): void {
    this.down.delete(action);
    this.taps.delete(action);
  }

  /** A tap: down and pressed for exactly this tick, released by `endTick`. */
  press(action: Action): void {
    this.hold(action);
    this.taps.add(action);
  }

  /** Releases everything, as a window blur does. */
  releaseAll(): void {
    this.down.clear();
    this.taps.clear();
  }

  /** A raw key code edge for this tick — the hotkeys (`KeyQ`, `KeyE`, `KeyR`, `KeyT`, `KeyK`). */
  tapKey(code: string): void {
    this.codesPressedThisTick.add(code);
  }

  /** Adds to this tick's mouse-look delta, in pixels. */
  look(dx: number, dy: number): void {
    this.lookX += dx;
    this.lookY += dy;
  }

  // ---- what the simulation reads -------------------------------------------

  moveAxes(): { x: number; y: number } {
    let x = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    let y = (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.axes.x = x;
    this.axes.y = y;
    return this.axes;
  }

  consumeLook(): { dx: number; dy: number } {
    this.lookDelta.dx = this.lookX;
    this.lookDelta.dy = this.lookY;
    this.lookX = 0;
    this.lookY = 0;
    return this.lookDelta;
  }

  isDown(action: Action): boolean {
    return this.down.has(action);
  }

  wasPressed(action: Action): boolean {
    return this.pressedThisTick.has(action);
  }

  wasKeyPressed(code: string): boolean {
    return this.codesPressedThisTick.has(code);
  }

  /** Called by the driver at the end of each sim tick; edge state is tick-scoped. */
  endTick(): void {
    this.pressedThisTick.clear();
    this.codesPressedThisTick.clear();
    for (const action of this.taps) this.down.delete(action);
    this.taps.clear();
  }
}
