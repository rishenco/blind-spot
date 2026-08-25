/**
 * Dummy strategies: sparring partners and baselines.
 *
 * None of these is an AI and none of them pretends to be. They exist so the playground is alive,
 * so a scenario can be written, and so the real bot has something to be measured against. What
 * they DO demonstrate is the shape of the contract: every one of them sees the world only
 * through `PerceptionFrame`, including the ball, whose position they only ever know
 * approximately.
 *
 * `Statue` is the important one. It stands still, makes no sound, and is therefore invisible —
 * the concept's "тишина как позиция" in its purest form. Any bot that cannot beat a wall of
 * statues does not understand the game; any bot that never chooses to be one has not understood
 * it either.
 */
import { clamp, dist2, len2, norm2, sub2, unitDir } from '../math';
import {
  idleIntent,
  type Controller,
  type ControllerContext,
  type ControllerDebug,
  type Intent,
  type ObservedEmitter,
  type PerceptionFrame,
  type Vec2,
} from '../types';

/** Everything the dummies share: last frame, the ball estimate, and edge-safe button presses. */
abstract class BaseController implements Controller {
  abstract readonly name: string;
  protected ctx: ControllerContext;
  protected frame: PerceptionFrame | null = null;
  /** Ticks to keep a one-shot button released, so the next press is a real rising edge. */
  private catchCooldown = 0;
  protected debug: ControllerDebug = {};

  constructor(ctx: ControllerContext) {
    this.ctx = ctx;
  }

  reset(ctx: ControllerContext): void {
    this.ctx = ctx;
    this.frame = null;
    this.catchCooldown = 0;
  }

  onPerceive(frame: PerceptionFrame): void {
    this.frame = frame;
  }

  debugSnapshot(): ControllerDebug | null {
    return this.debug;
  }

  abstract decide(dt: number): Intent;

  /** The heard ball, or null when nothing is audible (which for a 30 m hum means never). */
  protected ball(): ObservedEmitter | null {
    const f = this.frame;
    if (!f) return null;
    for (const em of f.emitters) if (em.kind === 'ball') return em;
    return null;
  }

  /**
   * Should I stab the catch button this tick? Only when the ball is close enough and not
   * running away — a mistimed press is a fumble, and a fumble is the loudest thing a body can do.
   */
  protected wantCatch(dt: number, ballPos: Vec2, ballVel: Vec2 | null): boolean {
    this.catchCooldown = Math.max(0, this.catchCooldown - dt);
    const f = this.frame;
    if (!f || f.self.hasBall || this.catchCooldown > 0) return false;
    const cfg = this.ctx.config.catching;
    const d = dist2(f.self.pos, ballPos);
    if (d > cfg.radius * 0.9) return false;
    // The ball's velocity is not part of what a listener is told, so this estimates the moment
    // of closest approach from its own movement alone — which is exactly the guess a blind
    // human makes, and exactly why a mistimed grab is a real risk for both of them.
    const closing = -((ballPos.x - f.self.pos.x) * f.self.vel.x + (ballPos.y - f.self.pos.y) * f.self.vel.y);
    const speed = f.self.speed;
    const tca = speed > 0.2 ? Math.max(0, d - cfg.radius * 0.2) / speed : 0;
    const stationaryish = speed < 0.2 || closing >= 0;
    if (!(stationaryish || tca <= cfg.windowSec)) return false;
    if (ballVel) {
      const away = (ballPos.x - f.self.pos.x) * ballVel.x + (ballPos.y - f.self.pos.y) * ballVel.y;
      if (away > 0 && len2(ballVel) > 2) return false;
    }
    this.catchCooldown = 0.3;
    return true;
  }
}

/** Stands still. Makes no sound. Cannot be found without a ping. The baseline. */
export class Statue extends BaseController {
  readonly name = 'statue';
  decide(): Intent {
    this.debug = { label: 'silent' };
    return idleIntent();
  }
}

/** Runs at the ball, grabs it, throws it at the opposing goal. No plan beyond that. */
export class BallChaser extends BaseController {
  readonly name = 'ballchaser';

  decide(dt: number): Intent {
    const f = this.frame;
    const intent = idleIntent();
    if (!f) return intent;
    const goal = f.field.goalCentre[this.ctx.team === 0 ? 1 : 0];

    if (f.self.hasBall) {
      const toGoal = norm2(sub2(goal, f.self.pos), { x: 1, y: 0 });
      intent.aim = toGoal;
      intent.move = toGoal;
      intent.moveMode = 'run';
      // The wind-up is read back from proprioception, never from a private timer: the throw
      // fires when the button is let go, and only the body knows how long it was really held
      // (a whistle, a restart or a fumble can end a wind-up without the controller's consent).
      intent.charge = f.self.chargeT < this.ctx.config.throwing.maxCharge;
      this.debug = { label: 'carry → shoot', readouts: { charge: f.self.chargeT.toFixed(2) } };
      return intent;
    }

    const ball = this.ball();
    if (!ball) {
      this.debug = { label: 'lost the ball' };
      return intent;
    }
    const to = sub2(ball.pos, f.self.pos);
    intent.move = norm2(to, { x: 1, y: 0 });
    intent.aim = intent.move;
    intent.moveMode = 'run';
    intent.catch = this.wantCatch(dt, ball.pos, null);
    this.debug = {
      label: 'chase',
      readouts: { dist: dist2(f.self.pos, ball.pos).toFixed(2), sigma: ball.sigma.toFixed(2) },
      markers: [{ kind: 'circle', pos: ball.pos, r: ball.sigma + 0.2, label: 'ball', color: '#ffd166' }],
    };
    return intent;
  }
}

/** Holds the line between the heard ball and its own goal. Walks, so it stays quiet. */
export class Goalie extends BaseController {
  readonly name = 'goalie';

  decide(dt: number): Intent {
    const f = this.frame;
    const intent = idleIntent();
    if (!f) return intent;
    const own = f.field.goalCentre[this.ctx.team];
    const far = f.field.goalCentre[this.ctx.team === 0 ? 1 : 0];

    if (f.self.hasBall) {
      // Clear it upfield rather than dribbling out of position.
      const dir = norm2(sub2(far, f.self.pos), { x: 1, y: 0 });
      intent.aim = dir;
      intent.charge = f.self.chargeT < this.ctx.config.throwing.maxCharge;
      this.debug = { label: 'clear', readouts: { charge: f.self.chargeT.toFixed(2) } };
      return intent;
    }

    const ball = this.ball();
    if (!ball) return intent;
    const toBall = norm2(sub2(ball.pos, own), { x: 1, y: 0 });
    const standoff = f.field.creaseRadius + this.ctx.config.player.radius + 0.4;
    const post: Vec2 = { x: own.x + toBall.x * standoff, y: own.y + toBall.y * standoff };
    const delta = sub2(post, f.self.pos);
    const d = len2(delta);
    if (d > 0.25) {
      intent.move = norm2(delta, { x: 0, y: 0 });
      // Sprint only when badly out of position: a goalkeeper that runs is a lit beacon.
      intent.moveMode = d > 2.5 ? 'run' : 'walk';
    }
    intent.aim = norm2(sub2(ball.pos, f.self.pos), { x: 1, y: 0 });
    intent.catch = this.wantCatch(dt, ball.pos, null);
    this.debug = {
      label: 'guard',
      readouts: { post: `${post.x.toFixed(1)},${post.y.toFixed(1)}`, gap: d.toFixed(2) },
      markers: [{ kind: 'point', pos: post, label: 'post', color: '#7bdff2' }],
    };
    return intent;
  }
}

/** Deterministic wandering, seeded from the match. Noise with no intent behind it. */
export class RandomWalker extends BaseController {
  readonly name = 'randomwalker';
  private dir: Vec2 = { x: 1, y: 0 };
  private hold = 0;
  private pingIn = 3;
  private pingFlag = false;

  decide(dt: number): Intent {
    const f = this.frame;
    const intent = idleIntent();
    if (!f) return intent;
    this.hold -= dt;
    if (this.hold <= 0) {
      this.hold = 0.4 + this.ctx.rng() * 1.2;
      this.dir = unitDir(this.ctx.rng);
    }
    // Bounce off the boundary instead of grinding along it.
    const f2 = f.field;
    if (Math.abs(f.self.pos.x) > f2.halfWidth - 1.5 && f.self.pos.x * this.dir.x > 0) this.dir.x *= -1;
    if (Math.abs(f.self.pos.y) > f2.halfHeight - 1.5 && f.self.pos.y * this.dir.y > 0) this.dir.y *= -1;

    intent.move = this.dir;
    intent.aim = this.dir;
    intent.moveMode = this.ctx.rng() < 0.35 ? 'run' : 'walk';

    this.pingIn -= dt;
    this.pingFlag = false;
    if (this.pingIn <= 0) {
      this.pingIn = 2 + this.ctx.rng() * 4;
      this.pingFlag = true;
    }
    intent.ping = this.pingFlag;

    const ball = this.ball();
    if (ball) intent.catch = this.wantCatch(dt, ball.pos, null);
    if (f.self.hasBall) intent.charge = f.self.chargeT < 0.3;
    this.debug = { label: 'wander' };
    return intent;
  }
}

/**
 * The measuring stick: an attacker that can actually finish.
 *
 * It is deliberately simple and deliberately honest — it navigates to the ball it *hears*, and
 * it shoots at a goal whose position is public knowledge. It has no beliefs about opponents at
 * all, which is exactly why it is a baseline: whatever the real bot adds, it has to beat this.
 */
export class Striker extends BaseController {
  readonly name = 'striker';
  private aimPoint: Vec2 | null = null;

  decide(dt: number): Intent {
    const f = this.frame;
    const intent = idleIntent();
    if (!f) return intent;
    const cfg = this.ctx.config;
    const goal = f.field.goalCentre[this.ctx.team === 0 ? 1 : 0];

    if (f.self.hasBall) {
      const dGoal = dist2(f.self.pos, goal);
      const shootRange = f.field.creaseRadius + 4.5;
      if (!this.aimPoint) {
        // Pick a corner of the mouth, deterministically, and commit to it.
        const side = this.ctx.rng() < 0.5 ? -1 : 1;
        const inset = f.field.goalWidth / 2 - 0.35;
        this.aimPoint = { x: goal.x, y: side * inset };
      }
      const toTarget = norm2(sub2(this.aimPoint, f.self.pos), { x: 1, y: 0 });
      intent.aim = toTarget;

      if (dGoal > shootRange) {
        // Close the distance, but never straight through the crease.
        intent.move = toTarget;
        intent.moveMode = 'run';
        this.debug = { label: 'advance', readouts: { toGoal: dGoal.toFixed(1) } };
        return intent;
      }

      const wanted = clamp(
        0.25 + (dGoal - f.field.creaseRadius) * 0.06,
        cfg.throwing.minCharge,
        cfg.throwing.maxCharge,
      );
      const releasing = f.self.chargeT >= wanted;
      intent.charge = !releasing;
      this.debug = {
        label: releasing ? 'release' : 'wind up',
        readouts: { charge: f.self.chargeT.toFixed(2), wanted: wanted.toFixed(2) },
        markers: [{ kind: 'line', pos: f.self.pos, to: this.aimPoint, label: 'shot', color: '#ff8fab' }],
      };
      return intent;
    }

    this.aimPoint = null;

    const ball = this.ball();
    if (!ball) {
      this.debug = { label: 'deaf' };
      return intent;
    }
    const to = sub2(ball.pos, f.self.pos);
    const d = len2(to);
    intent.move = norm2(to, { x: 1, y: 0 });
    intent.aim = intent.move;
    // Walk the last stretch: arriving quietly matters more than arriving 0.2 s earlier, and a
    // slower approach makes the catch window easier to hit.
    intent.moveMode = d > 3 ? 'run' : 'walk';
    intent.catch = this.wantCatch(dt, ball.pos, null);
    this.debug = {
      label: 'recover ball',
      readouts: { dist: d.toFixed(2), sigma: ball.sigma.toFixed(2) },
      markers: [{ kind: 'circle', pos: ball.pos, r: Math.max(0.2, ball.sigma), label: 'ball' }],
    };
    return intent;
  }
}
