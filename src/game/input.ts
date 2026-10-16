/** Keyboard + pointer-locked mouse. Edge-triggered actions are consumed with `take()`. */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  locked = false;

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
    canvas.addEventListener('mousedown', (e) => {
      this.pressed.add(`Mouse${e.button}`);
      this.pressed.add('AnyClick');
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.down.clear();
    });
  }

  lock(): void {
    if (!this.locked) this.canvas.requestPointerLock?.()?.catch?.(() => {});
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
