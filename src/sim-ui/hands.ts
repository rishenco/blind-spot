/**
 * Scripted hands: a reproducible human being at the keyboard.
 *
 * The hard part of tuning feel without a live playtest is that "feel" is a property of the loop
 * between a person's fingers and the screen, and a person cannot be checked into git. What CAN
 * be checked in is a *rule* that a person would follow — "press catch at the moment the ball is
 * closest", "hold the wind-up for half a second, then let go" — driven from the same
 * `PerceptionFrame` a person gets, through the same `Intent` a person produces.
 *
 * That gives three things at once:
 *
 *   1. **Storyboards.** A keyframe generator can step the same script tick by tick and shoot
 *      wind-up → release → flight → arrival, so a human reviewing the game sees the feel of an
 *      action as a strip of frames rather than as a promise in a report.
 *   2. **Numbers.** The same run reports how long the player was audible, how many balls they
 *      fumbled, how many pings they bought. A change to the feedback layer that makes a catch
 *      systematically late shows up as a number here.
 *   3. **A fairness argument.** `catch-early` presses two metres too soon on purpose. If the
 *      read-out under the player's nose does not then say EARLY, with a plausible number of
 *      milliseconds, the game is punishing people without telling them why — which is the exact
 *      failure this whole layer exists to prevent.
 *
 * Every rule below reads the frame and nothing else. None of them may look at the world; if one
 * ever needed to, it would no longer be a model of a player.
 */
import { idleIntent, type Intent, type PerceptionFrame, type Vec2 } from '../sim/types';
import type { Poll } from './input';

export interface HandScript {
  readonly name: string;
  /** Zeroed by the playground before a run — a script is replayed, so it must be restartable. */
  reset(): void;
  /** One tick of a person. `t` is sim time; the frame is that person's own perception. */
  act(frame: PerceptionFrame, t: number): Intent;
  /** Free-form note for the storyboard caption, e.g. "winding up · 62%". */
  readonly label: string;
}

const unit = (v: Vec2): Vec2 => {
  const m = Math.hypot(v.x, v.y);
  return m > 1e-6 ? { x: v.x / m, y: v.y / m } : { x: 1, y: 0 };
};

/** Time to the ball's closest approach, from perception only — the same number the HUD shows. */
function ballTca(frame: PerceptionFrame, prev: Vec2 | null): { d: number; tca: number; pos: Vec2 | null } {
  const ball = frame.emitters.find((e) => e.kind === 'ball');
  if (!ball) return { d: Infinity, tca: Infinity, pos: null };
  const self = frame.self;
  const rel = { x: ball.pos.x - self.pos.x, y: ball.pos.y - self.pos.y };
  const d = Math.hypot(rel.x, rel.y);
  if (!prev) return { d, tca: Infinity, pos: ball.pos };
  const vel = { x: (ball.pos.x - prev.x) * 60 - self.vel.x, y: (ball.pos.y - prev.y) * 60 - self.vel.y };
  const vv = vel.x * vel.x + vel.y * vel.y;
  const tca = vv > 1e-6 ? -(rel.x * vel.x + rel.y * vel.y) / vv : Infinity;
  return { d, tca, pos: ball.pos };
}

/**
 * The thrower: face the far goal, wind up for `hold` seconds, release, then stand still.
 *
 * `hold` is read against `frame.self.chargeT` and not against a private timer, exactly as the
 * simulation contract asks — a whistle or a steal can end a wind-up without asking the hands.
 */
export class ThrowHand implements HandScript {
  readonly name: string;
  label = 'waiting';
  private done = false;
  /**
   * `target` overrides "aim at the far goal" — a storyboard needs the ball to go somewhere
   * known. `delay` is how long to stand still first, which is how a passer waits for a receiver
   * to walk quietly into position instead of throwing at where nobody is yet.
   */
  constructor(
    private hold: number,
    name = 'throw-hand',
    private target: Vec2 | null = null,
    private delay = 0.4,
  ) {
    this.name = name;
  }
  reset(): void {
    this.done = false;
    this.label = 'waiting';
  }
  act(frame: PerceptionFrame, t: number): Intent {
    const intent = idleIntent();
    const at = this.target ?? frame.field.goalCentre[frame.self.team === 0 ? 1 : 0];
    intent.aim = unit({ x: at.x - frame.self.pos.x, y: at.y - frame.self.pos.y });
    if (!frame.self.hasBall) {
      // The ball is loose or gone: pick it up if it is at our feet, otherwise stand and listen.
      intent.catch = ballTca(frame, null).d < 1.0;
      this.label = this.done ? 'released' : 'no ball';
      return intent;
    }
    if (this.done || t < this.delay) {
      this.label = this.done ? 'released' : 'settling';
      return intent;
    }
    if (frame.self.chargeT < this.hold) {
      intent.charge = true;
      this.label = `winding up · ${Math.round((frame.self.chargeT / 0.6) * 100)}%`;
      return intent;
    }
    // The release is simply the absence of the hold on this tick.
    this.done = true;
    this.label = 'release';
    return intent;
  }
}

/**
 * The receiver: stand still and press catch by a rule.
 *
 * `mode` is the whole experiment. 'timed' presses at the moment of closest approach — what a
 * player who has read the ball correctly does. 'early' presses as soon as the ball is inside a
 * given range, which is what a nervous player does, and is the case the read-out has to explain.
 */
export class CatchHand implements HandScript {
  readonly name: string;
  label = 'listening';
  private prev: Vec2 | null = null;
  private fired = false;
  /** `station`: walk here quietly first, then stand and wait for the pass. */
  constructor(
    private mode: 'timed' | 'early',
    private earlyRange = 3.2,
    name = 'catch-hand',
    private station: Vec2 | null = null,
  ) {
    this.name = name;
  }
  reset(): void {
    this.prev = null;
    this.fired = false;
    this.label = 'listening';
  }
  act(frame: PerceptionFrame, _t: number): Intent {
    const intent = idleIntent();
    const { d, tca, pos } = ballTca(frame, this.prev);
    this.prev = pos;
    intent.aim = pos ? unit({ x: pos.x - frame.self.pos.x, y: pos.y - frame.self.pos.y }) : frame.self.aim;
    if (this.station) {
      const away = { x: this.station.x - frame.self.pos.x, y: this.station.y - frame.self.pos.y };
      const gap = Math.hypot(away.x, away.y);
      if (gap > 0.3) {
        // Walking, not running: a receiver who sprints into position has announced the pass.
        intent.move = { x: away.x / gap, y: away.y / gap };
        intent.moveMode = 'walk';
      }
    }
    if (this.fired || frame.self.hasBall) {
      this.label = frame.self.hasBall ? 'holding' : 'pressed';
      return intent;
    }
    const press =
      this.mode === 'early'
        ? d < this.earlyRange && Number.isFinite(tca) && tca > 0
        // A real receiver presses *into* the arrival, not on top of it: the rules resolve a
        // body/ball encounter the instant they touch, so the last reachable tick is the one
        // before contact. Pressing "exactly at closest approach" is already too late.
        : d < 2.2 && Number.isFinite(tca) && tca > 0.02 && tca < 0.1;
    if (press) {
      this.fired = true;
      intent.catch = true;
      this.label = this.mode === 'early' ? `pressed at ${d.toFixed(1)} m` : `pressed ${(tca * 1000).toFixed(0)} ms before arrival`;
    } else {
      this.label = `ball ${d.toFixed(1)} m${Number.isFinite(tca) ? ` · ${(tca * 1000).toFixed(0)} ms` : ''}`;
    }
    return intent;
  }
}

/** Loudness demo: sprint, then walk, then stand — the three states of being findable. */
export class LoudHand implements HandScript {
  readonly name = 'loud-hand';
  label = 'run';
  reset(): void {
    this.label = 'run';
  }
  act(frame: PerceptionFrame, t: number): Intent {
    const intent = idleIntent();
    intent.aim = { x: 1, y: 0 };
    if (t < 2) {
      intent.move = { x: 1, y: 0.15 };
      intent.moveMode = 'run';
      this.label = 'RUNNING — heard at 9 m';
    } else if (t < 4) {
      intent.move = { x: 0.4, y: -1 };
      intent.moveMode = 'walk';
      this.label = 'walking — heard at 3 m';
    } else {
      this.label = 'still — silent, invisible';
    }
    void frame;
    return intent;
  }
}

/** The ping: two quiet seconds, one scream, then silence again. */
export class PingHand implements HandScript {
  readonly name = 'ping-hand';
  label = 'quiet';
  private fired = false;
  reset(): void {
    this.fired = false;
    this.label = 'quiet';
  }
  act(frame: PerceptionFrame, t: number): Intent {
    const intent = idleIntent();
    intent.aim = { x: 1, y: 0 };
    if (t < 1) {
      intent.move = { x: 0.7, y: 0.2 };
      intent.moveMode = 'walk';
      this.label = 'walking in quietly';
    } else if (!this.fired && frame.self.pingCooldown <= 0) {
      intent.ping = true;
      this.fired = true;
      this.label = 'PING — and the whole pitch just heard where you are';
    } else {
      this.label = this.fired ? 'the second after: they know, you look' : 'quiet';
    }
    return intent;
  }
}

/**
 * Turns a script's intents into the same `Poll` a pair of hands produces.
 *
 * The feedback layer keys off *edges* — the tick a catch was pressed, the tick a wind-up was
 * let go — so a scripted run has to produce them too, or the storyboard would show a HUD that
 * a live player never sees. Diffing successive intents is exactly what the DOM does for a real
 * keyboard, so this is the same signal and not an imitation of it.
 */
export class ScriptPoller {
  private prev: Intent = idleIntent();
  reset(): void {
    this.prev = idleIntent();
  }
  poll(intent: Intent): Poll {
    const poll: Poll = {
      intent,
      pressedCatch: intent.catch && !this.prev.catch,
      pressedPing: intent.ping && !this.prev.ping,
      pressedDive: intent.dive && !this.prev.dive,
      startedCharge: intent.charge && !this.prev.charge,
      releasedCharge: !intent.charge && this.prev.charge,
      moveMagnitude: Math.min(1, Math.hypot(intent.move.x, intent.move.y)),
      pad: false,
      pointerAim: false,
    };
    this.prev = {
      move: { x: intent.move.x, y: intent.move.y },
      moveMode: intent.moveMode,
      aim: { x: intent.aim.x, y: intent.aim.y },
      ping: intent.ping,
      charge: intent.charge,
      catch: intent.catch,
      dive: intent.dive,
    };
    return poll;
  }
}
