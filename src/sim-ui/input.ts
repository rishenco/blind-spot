/**
 * Keyboard, mouse and gamepad for the human slot.
 *
 * It produces an `Intent` — the same struct a bot returns — so the human goes through exactly
 * the same door into the simulation, and a recorded match replays from the recorded intents
 * with no special case. What it adds on top is a `Poll`: the *edges* of this tick (a catch was
 * pressed, a wind-up started, a throw was released). The simulation does not need them; the
 * feedback layer does, because "why did that happen" has to be answered at the instant the
 * finger moved, not one tick later when the consequence arrives.
 *
 * Two things about this scheme are design, not convenience:
 *
 *   * **Running is the default and quiet costs a held key.** The trade the whole game is about
 *     must sit under a finger, not in a menu.
 *   * **On a stick, loudness is continuous.** The simulation scales speed by `|move|` and
 *     derives loudness from the speed that results, so a half-pushed stick really is a
 *     half-loud player. That is the single best argument for a gamepad here, and it costs one
 *     `navigator.getGamepads()` call per frame.
 */
import { norm2 } from '../sim/math';
import { idleIntent, type Intent, type Vec2 } from '../sim/types';

/** What the hands did this tick, on top of the intent the simulation reads. */
export interface Poll {
  intent: Intent;
  /** Rising edges, for feedback that has to fire on the press and not on the outcome. */
  pressedCatch: boolean;
  pressedPing: boolean;
  pressedDive: boolean;
  startedCharge: boolean;
  releasedCharge: boolean;
  /** 0..1 analog throw of the movement axis — the loudness dial on a stick. */
  moveMagnitude: number;
  /** True while the last movement input came from a gamepad (changes the on-screen prompts). */
  pad: boolean;
  /** Set while the human is aiming with a mouse, so the HUD can draw a cursor and not a stick. */
  pointerAim: boolean;
}

const DEADZONE = 0.22;
/** Above this stick throw the body is running; below it, walking. Matches the sim's own split. */
const RUN_THRESHOLD = 0.72;

function applyDeadzone(x: number, y: number): { x: number; y: number; m: number } {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return { x: 0, y: 0, m: 0 };
  // Rescale so the first millimetre past the deadzone is not a jump to 22% speed.
  const scaled = Math.min(1, (m - DEADZONE) / (1 - DEADZONE));
  return { x: (x / m) * scaled, y: (y / m) * scaled, m: scaled };
}

export class HumanInput {
  private keys = new Set<string>();
  /**
   * Keys and buttons that went down since the last poll, even if they are already back up.
   *
   * The playground polls once per simulated tick, and several ticks can be consumed inside one
   * animation frame — so a tap shorter than a frame lands entirely between two polls and simply
   * never happens. In a game whose three interesting actions are all taps (ping, catch, dive)
   * that is not a rare edge case, it is "the game ignored me", which is the single worst thing a
   * control scheme can do. Latching the press until it has been read once fixes it, and costs a
   * set.
   */
  private latchedKeys = new Set<string>();
  private latchedButtons = new Set<number>();
  private mouseWorld: Vec2 | null = null;
  private mouseSeen = false;
  private charging = false;
  private catchHeld = false;
  private diveHeld = false;
  /** Buttons the last poll saw down, so this poll can tell a hold from a fresh press. */
  private prev = { charge: false, catchB: false, ping: false, dive: false };
  private padIndex: number | null = null;
  private padActive = false;
  private padAim: Vec2 | null = null;
  /** Latest pad button state, sampled in `readPad` and merged into the intent in `poll`. */
  private padButtons = { charge: false, catchB: false, dive: false, ping: false };

  /** Maps a canvas point to world metres; set by the playground for whichever pane is hovered. */
  toWorld: ((clientX: number, clientY: number, target: HTMLCanvasElement) => Vec2) | null = null;
  /** Called on the first real key/mouse/pad press — the browser's gesture gate for audio. */
  onFirstGesture: (() => void) | null = null;
  private gestured = false;

  attach(root: HTMLElement, canvases: HTMLCanvasElement[]): void {
    window.addEventListener('keydown', (e) => {
      // Let the browser have the keys the UI needs (typing in lil-gui fields, etc.).
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      this.keys.add(e.code);
      this.latchedKeys.add(e.code);
      this.gesture();
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.latchedKeys.clear();
      this.latchedButtons.clear();
      this.charging = false;
      this.catchHeld = false;
      this.diveHeld = false;
    });
    for (const canvas of canvases) {
      canvas.addEventListener('mousemove', (e) => {
        if (this.toWorld) {
          this.mouseWorld = this.toWorld(e.clientX, e.clientY, canvas);
          this.mouseSeen = true;
          this.padActive = false;
        }
      });
      canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) this.charging = true;
        if (e.button === 2) this.catchHeld = true;
        if (e.button === 1) this.diveHeld = true;
        this.latchedButtons.add(e.button);
        this.gesture();
        e.preventDefault();
      });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.charging = false;
      if (e.button === 2) this.catchHeld = false;
      if (e.button === 1) this.diveHeld = false;
    });
    window.addEventListener('gamepadconnected', (e) => {
      this.padIndex = (e as GamepadEvent).gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.padIndex = null;
      this.padActive = false;
    });
    void root;
  }

  private gesture(): void {
    if (this.gestured) return;
    this.gestured = true;
    this.onFirstGesture?.();
  }

  /** Reads the pad, if any, and folds it into the key/mouse state. Returns the analog axes. */
  private readPad(): { move: Vec2; magnitude: number; aim: Vec2 | null } | null {
    const pads = navigator.getGamepads?.() ?? [];
    let pad: Gamepad | null = null;
    if (this.padIndex !== null) pad = pads[this.padIndex] ?? null;
    if (!pad) for (const p of pads) if (p) { pad = p; break; }
    if (!pad) return null;

    const move = applyDeadzone(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0));
    const look = applyDeadzone(pad.axes[2] ?? 0, -(pad.axes[3] ?? 0));
    const btn = (i: number): boolean => (pad!.buttons[i]?.pressed ?? false) || (pad!.buttons[i]?.value ?? 0) > 0.4;

    // Standard mapping: RT wind-up, RB/A catch, LB ping, X dive. A trigger is analog, so a
    // wind-up can be started gently — which is what makes the throw feel like a throw on a pad.
    const rt = pad.buttons[7]?.value ?? 0;
    this.padButtons = {
      charge: rt > 0.15 || btn(0),
      catchB: btn(5) || btn(1),
      dive: btn(2),
      ping: btn(4),
    };

    if (move.m > 0 || look.m > 0 || this.padButtons.charge || this.padButtons.catchB) {
      this.padActive = true;
      this.gesture();
    }
    return {
      move: { x: move.x, y: move.y },
      magnitude: move.m,
      aim: look.m > 0 ? { x: look.x / look.m, y: look.y / look.m } : null,
    };
  }

  /**
   * Builds this tick's intent and the edges around it.
   *
   * `selfPos` is the human's own body — proprioception, not a peek at the world.
   */
  poll(selfPos: Vec2, currentAim: Vec2): Poll {
    const pad = this.readPad();
    const intent = idleIntent();

    // Movement reads the *held* state only — a one-frame tap of W is not a step, and latching
    // it would make the body twitch. Actions read held-or-latched.
    const down = (code: string): boolean => this.keys.has(code) || this.latchedKeys.has(code);
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    const keyWalk = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    let magnitude = 0;
    if (pad && pad.magnitude > 0) {
      intent.move = pad.move;
      magnitude = pad.magnitude;
      // On a stick the mode follows the throw, so "quiet" is a wrist and not a modifier.
      intent.moveMode = magnitude > RUN_THRESHOLD ? 'run' : 'walk';
      if (intent.moveMode === 'walk' && magnitude > 0) {
        // Below the run threshold, hand the sim the full walk speed unless the stick is really
        // feathered — otherwise the whole lower half of the stick is a crawl nobody wants.
        const w = Math.min(1, magnitude / RUN_THRESHOLD);
        intent.move = { x: (pad.move.x / magnitude) * w, y: (pad.move.y / magnitude) * w };
      }
    } else if (x !== 0 || y !== 0) {
      intent.move = norm2({ x, y }, { x: 0, y: 0 });
      magnitude = keyWalk ? 0.45 : 1;
      intent.moveMode = keyWalk ? 'walk' : 'run';
    } else {
      intent.moveMode = keyWalk ? 'walk' : 'run';
    }

    let aim = currentAim;
    if (pad?.aim) {
      aim = pad.aim;
      this.padAim = pad.aim;
    } else if (this.padActive && this.padAim) {
      aim = this.padAim;
    } else if (this.mouseWorld) {
      aim = norm2({ x: this.mouseWorld.x - selfPos.x, y: this.mouseWorld.y - selfPos.y }, currentAim);
    }
    intent.aim = aim;

    const pb = pad ? this.padButtons : { charge: false, catchB: false, dive: false, ping: false };
    intent.ping = pb.ping || down('Space');
    intent.charge = pb.charge || this.charging || this.latchedButtons.has(0) || down('KeyF');
    intent.catch = pb.catchB || this.catchHeld || this.latchedButtons.has(2) || down('KeyC') || down('KeyE');
    intent.dive = pb.dive || this.diveHeld || this.latchedButtons.has(1) || down('KeyQ');

    const poll: Poll = {
      intent,
      pressedCatch: intent.catch && !this.prev.catchB,
      pressedPing: intent.ping && !this.prev.ping,
      pressedDive: intent.dive && !this.prev.dive,
      startedCharge: intent.charge && !this.prev.charge,
      releasedCharge: !intent.charge && this.prev.charge,
      moveMagnitude: magnitude,
      pad: this.padActive,
      pointerAim: !this.padActive && this.mouseSeen,
    };
    this.prev = {
      charge: intent.charge,
      catchB: intent.catch,
      ping: intent.ping,
      dive: intent.dive,
    };
    this.latchedKeys.clear();
    this.latchedButtons.clear();
    return poll;
  }

  /** Backwards-compatible shim for callers that only want the intent. */
  intent(selfPos: Vec2, currentAim: Vec2): Intent {
    return this.poll(selfPos, currentAim).intent;
  }

  get usingPad(): boolean {
    return this.padActive;
  }

  get helpText(): string {
    return this.padActive
      ? 'stick = move (push far = run = loud) · right stick = aim · RT hold/release = throw · RB = catch · LB = ping · X = dive'
      : 'WASD move · SHIFT = walk (quiet) · mouse aim · LMB hold/release = THROW · RMB/E = catch · SPACE = ping · Q = dive';
  }
}
