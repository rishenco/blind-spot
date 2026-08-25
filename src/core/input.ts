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
export type Action = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'crouch' | 'fire';

const KEY_BINDINGS: Record<string, Action> = {
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
  // The trigger also lives on a key, and not only on the mouse: the left button is the
  // drag-look fallback (and the click that asks for pointer lock), so in those two situations
  // a mouse-only trigger would either fire when you meant to look or not fire at all.
  KeyE: 'fire',
};

/**
 * Keys that belong to the game rather than to a text field. When one of these arrives while a
 * lil-gui number box has focus, the panel has plainly been abandoned and the player is trying
 * to walk: the field is blurred and the key handled normally.
 *
 * Digits, arrows, Enter/Escape/Tab and the editing keys are deliberately absent — those are how
 * you actually type a value into a slider's box, and stealing them would trade one broken input
 * for another.
 */
function isGameKey(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || code === 'Space' || code.startsWith('Shift');
}

function editingTarget(): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  if (el === null) return null;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return el;
  return null;
}

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

  constructor(private readonly target: HTMLElement) {
    /*
     * Capture phase, on the window, deliberately.
     *
     * The reported bug — "когда настройки трогаешь, если не кликать ещё юай, то видимо перехват
     * WASD отрубается" — has two halves. lil-gui calls stopPropagation() on the key events inside
     * its controllers, so a bubble-phase listener never sees them at all; and a number widget is
     * a real <input> that keeps focus after you drag its slider, so the W you press next is
     * *typed into the box*. Capturing at the window beats the first half (capture runs before any
     * handler further down can stop anything), and `editingTarget()` below beats the second.
     */
    this.on(window, 'keydown', this.onKeyDown as EventListener, true);
    this.on(window, 'keyup', this.onKeyUp as EventListener, true);
    this.on(window, 'blur', this.onBlur);
    this.on(target, 'mousedown', this.onMouseDown as EventListener);
    this.on(window, 'mouseup', this.onMouseUp as EventListener);
    this.on(window, 'mousemove', this.onMouseMove as EventListener);
    this.on(document, 'pointerlockchange', this.onPointerLockChange);
    this.on(document, 'pointerlockerror', this.onPointerLockError);
    this.on(target, 'contextmenu', (e) => e.preventDefault());
  }

  private on(el: EventTarget, type: string, fn: EventListener, capture = false): void {
    el.addEventListener(type, fn, capture);
    this.disposers.push(() => el.removeEventListener(type, fn, capture));
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

  /** True if this raw key code went down during the tick being simulated (UI hotkeys). */
  wasKeyPressed(code: string): boolean {
    return this.codesPressedThisTick.has(code);
  }

  /**
   * True if *any* key went down this tick. Used for one thing only: browsers will not start an
   * AudioContext outside a user gesture, so something has to notice the first press.
   */
  anyKeyPressed(): boolean {
    return this.codesPressedThisTick.size > 0;
  }

  /** Called by the loop at the end of each sim tick; edge state is tick-scoped. */
  endTick(): void {
    this.pressedThisTick.clear();
    this.codesPressedThisTick.clear();
  }

  // ---- handlers ------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const editing = editingTarget();
    if (editing !== null) {
      // Typing a number into the tuning panel: leave the field alone.
      if (!isGameKey(e.code)) return;
      // Anything else means the player is done with the panel and wants to move.
      editing.blur();
    }
    this.codesPressedThisTick.add(e.code);
    const action = KEY_BINDINGS[e.code];
    if (action === undefined) return;
    // Space/arrows would scroll the page; movement keys are ours.
    e.preventDefault();
    this.down.add(action);
    this.pressedThisTick.add(action);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    // No focus check here on purpose: a key that went *down* as a game key must come back up as
    // one, or it stays held for ever — which is the second, nastier half of the same bug.
    const action = KEY_BINDINGS[e.code];
    if (action !== undefined) this.down.delete(action);
  };

  private onBlur = (): void => {
    // Losing the window with the trigger held would otherwise leave it held.
    this.down.clear();
    this.dragging = false;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    /*
     * The trigger, but only once the mouse is actually captured. The click that *asks* for
     * pointer lock must not also fire a round — clicking into the window to start playing would
     * announce your position to the whole hall before you had touched anything.
     */
    if (this.isLocked) {
      this.down.add('fire');
      this.pressedThisTick.add('fire');
    } else if (this.lockMode === 'pointerlock') this.requestLock();
    // Track the drag regardless of mode: if the lock request is denied part-way through
    // this gesture we keep looking around instead of eating the player's input.
    this.dragging = true;
    this.lastDragX = e.clientX;
    this.lastDragY = e.clientY;
    e.preventDefault();
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.dragging = false;
      this.down.delete('fire');
    }
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
