/**
 * Keyboard and mouse for the human-driven slot.
 *
 * Deliberately thin: this exists so a person can feel whether the game is playable at all, not
 * to be a control scheme. It produces an `Intent` — the same struct a bot returns — so the human
 * goes through exactly the same door into the simulation, and so a recorded match replays from
 * the recorded intents without a special case.
 */
import { norm2 } from '../sim/math';
import { idleIntent, type Intent, type Vec2 } from '../sim/types';

export class HumanInput {
  private keys = new Set<string>();
  private mouseWorld: Vec2 | null = null;
  private charging = false;
  private catchPressed = false;
  private divePressed = false;

  /** Maps a canvas point to world metres; set by the playground for whichever pane is hovered. */
  toWorld: ((clientX: number, clientY: number, target: HTMLCanvasElement) => Vec2) | null = null;

  attach(root: HTMLElement, canvases: HTMLCanvasElement[]): void {
    window.addEventListener('keydown', (e) => {
      // Let the browser have the keys the UI needs (typing in lil-gui fields, etc.).
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    for (const canvas of canvases) {
      canvas.addEventListener('mousemove', (e) => {
        if (this.toWorld) this.mouseWorld = this.toWorld(e.clientX, e.clientY, canvas);
      });
      canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) this.charging = true;
        if (e.button === 2) this.catchPressed = true;
        e.preventDefault();
      });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.charging = false;
      if (e.button === 2) this.catchPressed = false;
    });
    void root;
  }

  /** Builds this tick's intent. `selfPos` is the human's own body — proprioception, not a peek. */
  intent(selfPos: Vec2, currentAim: Vec2): Intent {
    const intent = idleIntent();
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (x !== 0 || y !== 0) intent.move = norm2({ x, y }, { x: 0, y: 0 });
    // Running is the default; holding shift is the quiet option, which is the trade the whole
    // game is about — so it should cost a held key, not be one.
    intent.moveMode = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 'walk' : 'run';

    const aimTarget = this.mouseWorld;
    intent.aim = aimTarget
      ? norm2({ x: aimTarget.x - selfPos.x, y: aimTarget.y - selfPos.y }, currentAim)
      : currentAim;

    intent.ping = this.keys.has('Space');
    intent.charge = this.charging || this.keys.has('KeyF');
    intent.catch = this.catchPressed || this.keys.has('KeyC');
    intent.dive = this.divePressed || this.keys.has('KeyQ');
    return intent;
  }

  get helpText(): string {
    return 'WASD move · shift = walk (quiet) · mouse = aim · LMB hold/release = throw · RMB or C = catch · space = ping · Q = dive';
  }
}
