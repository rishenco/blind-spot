/**
 * A controller that plays back a written timeline.
 *
 * This is the tool for the deception scenarios the AI brief asks for: a scripted "human" runs a
 * feint, fires a lying ping, goes silent, or throws into the dark, and the bot's reaction is
 * then a reproducible fact rather than an anecdote. A scenario has to be short enough to read in
 * one breath, so the script is a list of actions with durations:
 *
 * ```ts
 * scripted([
 *   { for: 1.0, run: [1, 0], label: 'break right' },
 *   { for: 0.3, stand: true },            // the loud stop — the feint's hook
 *   { for: 2.0, walk: [-1, 0] },          // and away quietly in the other direction
 *   { ping: true },                       // one tick, one lie
 *   { for: 0.4, charge: true, aim: [0, 1] },
 *   { for: 0.5 },                         // charge not held any more => the throw goes off
 * ]);
 * ```
 *
 * Rules: an action lasts `for` seconds (one tick when absent), `charge` is held for as long as
 * consecutive actions ask for it and releases the moment one does not, and when the script runs
 * out the body stands still and silent forever.
 */
import { norm2 } from '../math';
import {
  idleIntent,
  type Controller,
  type ControllerContext,
  type ControllerDebug,
  type Intent,
  type PerceptionFrame,
} from '../types';

export interface ScriptAction {
  /** Duration in seconds. Omitted means a single tick — right for one-shot buttons. */
  for?: number;
  /** Move at running speed in this direction. */
  run?: [number, number];
  /** Move at walking speed (quiet) in this direction. */
  walk?: [number, number];
  /** Explicitly stand still (the default when neither run nor walk is given). */
  stand?: boolean;
  /** Facing / throw direction. Sticky: kept until another action changes it. */
  aim?: [number, number];
  ping?: boolean;
  charge?: boolean;
  catch?: boolean;
  dive?: boolean;
  /** Shown in the debug panel while this action runs. */
  label?: string;
}

export class Scripted implements Controller {
  readonly name: string;
  private readonly script: ScriptAction[];
  private index = 0;
  private elapsed = 0;
  private aim: [number, number] = [1, 0];
  private frame: PerceptionFrame | null = null;

  constructor(_ctx: ControllerContext, script: ScriptAction[], name = 'scripted') {
    this.script = script;
    this.name = name;
  }

  reset(): void {
    this.index = 0;
    this.elapsed = 0;
    this.aim = [1, 0];
  }

  onPerceive(frame: PerceptionFrame): void {
    this.frame = frame;
  }

  decide(dt: number): Intent {
    const intent = idleIntent();
    const action = this.script[this.index];
    if (!action) {
      intent.aim = { x: this.aim[0], y: this.aim[1] };
      return intent;
    }
    if (action.aim) this.aim = action.aim;
    intent.aim = norm2({ x: this.aim[0], y: this.aim[1] }, { x: 1, y: 0 });
    if (action.run) {
      intent.move = norm2({ x: action.run[0], y: action.run[1] }, { x: 0, y: 0 });
      intent.moveMode = 'run';
    } else if (action.walk) {
      intent.move = norm2({ x: action.walk[0], y: action.walk[1] }, { x: 0, y: 0 });
      intent.moveMode = 'walk';
    }
    intent.ping = action.ping === true;
    intent.charge = action.charge === true;
    intent.catch = action.catch === true;
    intent.dive = action.dive === true;

    this.elapsed += dt;
    if (this.elapsed >= (action.for ?? 0)) {
      this.index += 1;
      this.elapsed = 0;
    }
    return intent;
  }

  debugSnapshot(): ControllerDebug {
    const action = this.script[this.index];
    return {
      label: action?.label ?? (action ? `step ${this.index}` : 'script done'),
      readouts: {
        step: `${Math.min(this.index + 1, this.script.length)}/${this.script.length}`,
        heard: this.frame ? this.frame.events.length : 0,
      },
    };
  }
}

/** Factory helper so a scenario reads as data. */
export const scripted =
  (script: ScriptAction[], name = 'scripted') =>
  (ctx: ControllerContext): Controller =>
    new Scripted(ctx, script, name);
