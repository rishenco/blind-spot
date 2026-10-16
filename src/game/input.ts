/** Keyboard + pointer-locked mouse. Edge-triggered actions are consumed with `take()`. */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  locked = false;
  /** Called synchronously inside user gestures (audio unlock, pointer lock must happen there). */
  onGesture: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (e.code !== 'Escape') {
        this.pressed.add('AnyKey');
        this.onGesture?.();
      }
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
    canvas.addEventListener('mousedown', (e) => {
      this.pressed.add(`Mouse${e.button}`);
      this.pressed.add('AnyClick');
      this.onGesture?.();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Deltas are tracked even without pointer lock, so the camera still works where lock is refused.
    addEventListener('mousemove', (e) => {
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.down.clear();
    });
  }

  /** Request pointer lock; resolves false if the browser refuses. */
  lock(): Promise<boolean> {
    if (this.locked) return Promise.resolve(true);
    try {
      const r = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (r && typeof r.then === 'function') return r.then(() => true, () => false);
    } catch {
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True once per press. */
  take(code: string): boolean {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  /** Movement axes from WASD/arrows: x = right, y = forward. */
  axes(): { x: number; y: number } {
    const k = (a: string, b: string) => (this.down.has(a) || this.down.has(b) ? 1 : 0);
    return {
      x: k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'),
      y: k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown'),
    };
  }

  /** Call at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = this.mouseDY = 0;
  }
}
