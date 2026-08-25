/**
 * Keyboard + mouse-look input.
 *
 * Mouse look has two paths that behave identically to the rest of the game:
 *  - Pointer Lock (preferred): raw movementX/Y while the cursor is captured.
 *  - Drag fallback (automatic): if pointer lock is denied or unavailable — which is the
 *    normal case inside a sandboxed iframe or headless browser — look is driven by
 *    dragging with the mouse held down.
 * Both accumulate into the same per-frame delta, so consumers never branch on the mode.
 */

export type LookMode = 'pointerlock' | 'drag';

/** Logical actions, decoupled from physical keys. */
export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'crouch'
  /**
   * The hand: hold to wind the arm, release to throw (`game/spheres.ts`).
   *
   * A key and deliberately not a mouse button. Button 0 is the drag-look fallback above, which
   * every headless tool and the whole screenshot suite steers with — a throw bound there either
   * fights look or adds a second mouse path to every driver. Riding `Action` instead means
   * `ScriptedInput` drives the verb for free through the same generic `hold`/`release` a player
   * uses, so nothing anywhere needs a setter to make the rig throw.
   */
  | 'throw';

/**
 * Physical key → logical action. Exported so the binding itself can be asserted: `Input` only
 * exists with a `window` and a `document`, so this table is otherwise unreachable from the suite,
 * and a verb whose key silently moved is a verb the HUD lies about (`game/game.ts`'s hint line).
 */
export const KEY_BINDINGS: Record<string, Action> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyC: 'crouch',
  ControlLeft: 'crouch',
  ControlRight: 'crouch',
  KeyF: 'throw',
};

export class Input {
  /** Accumulated look delta in pixels since the last consumeLook(). */
  private lookX = 0;
  private lookY = 0;

  private readonly down = new Set<Action>();
  private readonly pressedThisTick = new Set<Action>();
  /** Raw KeyboardEvent.code values that went down during the tick being simulated. */
  private readonly codesPressedThisTick = new Set<string>();

  private dragging = false;
  private lastDragX = 0;
  private lastDragY = 0;

  private lockRequested = false;
  private lockMode: LookMode = 'drag';

  private readonly disposers: Array<() => void> = [];

  /**
   * How many user gestures — key or primary-button presses — have reached this input.
   *
   * Here rather than in the thing that needs it, because a gesture is a fact about the input
   * device and every browser API that is gated on one (audio, pointer lock, fullscreen) will ask
   * the same question. Counted rather than latched so a caller can tell "no gesture yet" from
   * "the last one failed", and read-only from outside: nothing may claim a gesture that the user
   * did not make, which is the whole point of the browser's rule.
   */
  private gestureCount = 0;

  constructor(private readonly target: HTMLElement) {
    this.on(window, 'keydown', this.onKeyDown as EventListener);
    this.on(window, 'keyup', this.onKeyUp as EventListener);
    this.on(window, 'blur', this.onBlur);
    this.on(target, 'mousedown', this.onMouseDown as EventListener);
    this.on(window, 'mouseup', this.onMouseUp as EventListener);
    this.on(window, 'mousemove', this.onMouseMove as EventListener);
    this.on(document, 'pointerlockchange', this.onPointerLockChange);
    this.on(document, 'pointerlockerror', this.onPointerLockError);
    this.on(target, 'contextmenu', (e) => e.preventDefault());
  }

  private on(el: EventTarget, type: string, fn: EventListener): void {
    el.addEventListener(type, fn);
    this.disposers.push(() => el.removeEventListener(type, fn));
  }

  // ---- state queries -------------------------------------------------------

  isDown(action: Action): boolean {
    return this.down.has(action);
  }

  /** True if the action's key went down during the tick being simulated. */
  wasPressed(action: Action): boolean {
    return this.pressedThisTick.has(action);
  }

  /** Movement intent in local space: x = right, y = forward, unclamped magnitude <= 1. */
  moveAxes(): { x: number; y: number } {
    let x = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    let y = (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  get lookMode(): LookMode {
    return this.lockMode;
  }

  private get isLocked(): boolean {
    return document.pointerLockElement === this.target;
  }

  /** True when look input is currently active (pointer locked, or mid-drag). */
  get isCapturing(): boolean {
    return this.isLocked || this.dragging;
  }

  /** Returns and clears the accumulated look delta (pixels). */
  consumeLook(): { dx: number; dy: number } {
    const dx = this.lookX;
    const dy = this.lookY;
    this.lookX = 0;
    this.lookY = 0;
    return { dx, dy };
  }

  /** User gestures seen so far. Zero means the browser will still refuse to start audio. */
  get gestures(): number {
    return this.gestureCount;
  }

  /** True if this raw key code went down during the tick being simulated (UI hotkeys). */
  wasKeyPressed(code: string): boolean {
    return this.codesPressedThisTick.has(code);
  }

  /** Called by the loop at the end of each sim tick; edge state is tick-scoped. */
  endTick(): void {
    this.pressedThisTick.clear();
    this.codesPressedThisTick.clear();
  }

  // ---- handlers ------------------------------------------------------------

  /**
   * True while the keystroke belongs to a text field rather than to the game.
   *
   * The dev panel is full of editable number fields, and without this typing a value into one
   * also respawns the player (`r`), clears the map (`k`) and crouches him (`c`) on the way past.
   */
  private static isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (el === null || el.tagName === undefined) return false;
    const tag = el.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (Input.isTyping(e.target)) return;
    this.gestureCount++;
    this.codesPressedThisTick.add(e.code);
    const action = KEY_BINDINGS[e.code];
    if (action === undefined) return;
    // Space/arrows would scroll the page; movement keys are ours.
    e.preventDefault();
    this.down.add(action);
    this.pressedThisTick.add(action);
  };

  // No typing guard on the way up: a key pressed in the world and released over a text field
  // has to be released, or the body walks off on its own.
  private onKeyUp = (e: KeyboardEvent): void => {
    const action = KEY_BINDINGS[e.code];
    if (action !== undefined) this.down.delete(action);
  };

  private onBlur = (): void => {
    this.down.clear();
    this.dragging = false;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.gestureCount++;
    if (this.lockMode === 'pointerlock' && !this.isLocked) this.requestLock();
    // Track the drag regardless of mode: if the lock request is denied part-way through
    // this gesture we keep looking around instead of eating the player's input.
    this.dragging = true;
    this.lastDragX = e.clientX;
    this.lastDragY = e.clientY;
    e.preventDefault();
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.dragging = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.isLocked) {
      this.lookX += e.movementX;
      this.lookY += e.movementY;
      return;
    }
    if (!this.dragging) return;
    this.lookX += e.clientX - this.lastDragX;
    this.lookY += e.clientY - this.lastDragY;
    this.lastDragX = e.clientX;
    this.lastDragY = e.clientY;
  };

  private onPointerLockChange = (): void => {
    if (this.isLocked) {
      this.lockRequested = false;
      this.dragging = false;
    }
  };

  private onPointerLockError = (): void => {
    this.fallbackToDrag();
  };

  private fallbackToDrag(): void {
    this.lockRequested = false;
    this.lockMode = 'drag';
  }

  private requestLock(): void {
    if (this.lockRequested) return;
    this.lockRequested = true;
    const el = this.target as HTMLElement & {
      requestPointerLock?: (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void;
    };
    try {
      const result = el.requestPointerLock?.();
      // Chrome returns a promise (since the unadjustedMovement option landed); older
      // engines return undefined and report failure via the pointerlockerror event.
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => this.fallbackToDrag());
      }
    } catch {
      this.fallbackToDrag();
    }
    // Safety net: if neither event fires (sandboxed iframe swallowing the request),
    // assume denial and switch to drag so the user is never stuck without look.
    window.setTimeout(() => {
      if (this.lockRequested && !this.isLocked) this.fallbackToDrag();
    }, 350);
  }

  /** Forces the drag-to-look path (used by tooling and by `?look=drag`). */
  forceDragLook(): void {
    this.lockMode = 'drag';
    this.lockRequested = false;
  }

  /** Probe support once at boot; unsupported environments start in drag mode. */
  detectLookMode(): void {
    const supported =
      typeof (this.target as HTMLElement).requestPointerLock === 'function' && 'pointerLockElement' in document;
    this.lockMode = supported ? 'pointerlock' : 'drag';
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.down.clear();
  }
}
