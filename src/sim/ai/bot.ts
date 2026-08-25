/**
 * The bot.
 *
 * Wiring only: perception in, belief updated, a decision taken ten times a second, and steering
 * produced sixty times a second. All three layers live in separate files because the interesting
 * failure mode of this whole project is layer 2 quietly reading something layer 1 never heard —
 * and the way to make that impossible is for the decision code to have nothing else in scope.
 *
 * The 10 Hz / 60 Hz split is not an optimisation. It gives the bot a human-shaped reaction time
 * for free (0–100 ms of quantisation on top of the one-tick delay the contract already imposes,
 * plus whatever `reactionLatencySec` adds), and it stops the chooser from re-deciding on every
 * frame, which is what actually reads as "stupid bot" when two options are nearly tied.
 */
import { clamp, dist2, len2, norm2, sub2 } from '../math';
import {
  idleIntent,
  type BeliefCloud,
  type Controller,
  type ControllerContext,
  type ControllerDebug,
  type Intent,
  type PerceptionFrame,
  type Vec2,
} from '../types';
import { Belief } from './belief';
import { deriveFeatures, type Features } from './features';
import { aimFor, choose, type Action, type ScoredAction } from './policy';

/**
 * Variant switches. They exist for the rule tournament, which has to be able to run the same
 * brain with one capability removed — "does a bot that may not ping lose to one that may" is the
 * concept's second test, and there is no way to ask it with a difficulty dial.
 */
export interface BotOptions {
  /** false = this bot never pings. The control group of the ping test. */
  allowPing?: boolean;
}

interface Chosen {
  action: Action;
  /** Sim time the action was picked, for the minimum-hold rule. */
  at: number;
  /** Phase inside a macro. */
  phase: number;
  phaseT: number;
}

export class Bot implements Controller {
  readonly name: string;
  private ctx: ControllerContext;
  private belief: Belief;
  private frame: PerceptionFrame | null = null;
  private features: Features | null = null;
  private chosen: Chosen | null = null;
  private ranked: ScoredAction[] = [];
  private sinceDecision = 0;
  private catchLock = 0;
  private pingLock = 0;
  private diveLock = 0;
  private lastPossession = 'unknown';

  /** Switches that make a *variant* of this bot, for measurement. Not difficulty knobs. */
  private readonly opts: BotOptions;

  constructor(ctx: ControllerContext, name = 'bot', opts: BotOptions = {}) {
    this.name = name;
    this.ctx = ctx;
    this.opts = opts;
    this.belief = new Belief(ctx);
  }

  reset(ctx: ControllerContext): void {
    this.ctx = ctx;
    this.belief = new Belief(ctx);
    this.frame = null;
    this.features = null;
    this.chosen = null;
    this.ranked = [];
    this.sinceDecision = 0;
  }

  onPerceive(frame: PerceptionFrame): void {
    this.frame = frame;
    this.belief.update(frame);
  }

  decide(dt: number): Intent {
    const frame = this.frame;
    const intent = idleIntent();
    if (!frame) return intent;
    this.catchLock = Math.max(0, this.catchLock - dt);
    this.pingLock = Math.max(0, this.pingLock - dt);
    this.diveLock = Math.max(0, this.diveLock - dt);
    if (frame.match.phase !== 'play' || frame.self.down) {
      // Flat on the floor there is nothing to decide and nothing that would be obeyed. Dropping
      // the plan also means the bot re-decides the instant it gets up, with a world that has
      // moved on without it.
      this.chosen = null;
      this.sinceDecision = 99;
      return intent;
    }

    const cfg = this.ctx.config;
    this.sinceDecision += dt;
    const period = 1 / Math.max(1, this.belief.knobs.stepHz);
    // Re-decide on the clock, but also the moment the world changes shape under us: possession
    // flipping or the ball arriving are not things to notice 100 ms late.
    const ball = this.belief.ball;
    const urgent =
      this.belief.possession !== this.lastPossession ||
      (ball !== null && dist2(frame.self.pos, ball.pos) < 2.5) ||
      this.chosen === null ||
      this.features === null;
    const minHold = 0.3;
    if (this.sinceDecision >= period && (urgent || this.now() - (this.chosen?.at ?? -99) >= minHold)) {
      // Features are derived here and nowhere else. They cost roughly what one decision costs —
      // stratified samples of two grids, the effective areas, an interception scan — and deriving
      // them sixty times a second to use them ten times a second was most of the bot's CPU.
      this.features = deriveFeatures(
        this.belief,
        frame.self.pos,
        frame.self.speed,
        frame.self.hasBall,
        this.ctx.team,
        this.ctx.self,
        frame.field,
        cfg,
        frame.self.keeper,
        frame.self.pinned,
      );
      this.pick();
      this.sinceDecision = 0;
    }
    this.lastPossession = this.belief.possession;
    const f = this.features;
    if (!f) return intent;
    // Between decisions the plan stands, but the body and the ball have moved: steering and the
    // catch reflex run at 60 Hz off these fields and nothing else. `pinned` rides along too — it
    // is proprioception, free every tick, and a carrier who just got shoved cannot wait for the
    // next scheduled decision to notice.
    f.me = frame.self.pos;
    f.mySpeed = frame.self.speed;
    f.ball = ball;
    f.ballPos = ball ? ball.pos : null;
    f.pinned = frame.self.pinned;

    const chosen = this.chosen;
    if (!chosen) return intent;
    chosen.phaseT += dt;
    this.execute(chosen, frame, intent, f);
    this.catchReflex(frame, intent, f);
    this.keeperReflex(frame, intent, f);
    return intent;
  }

  private now(): number {
    return this.belief.now;
  }

  private pick(): void {
    const f = this.features!;
    const frame = this.frame!;
    const ai = this.ctx.config.ai as Record<string, unknown>;
    // `decisionQualityTeam`, when present, applies the narrowed candidate list to that team only.
    // It exists so the width of the search can be played against itself in one match, which is
    // the only way to ask "does looking at fewer options make this bot better" without comparing
    // two different tournaments to each other.
    const only = ai.decisionQualityTeam;
    const applies = typeof only !== 'number' || only === this.ctx.team;
    const quality = applies && typeof ai.decisionQuality === 'number' ? ai.decisionQuality : 1;
    this.ranked = choose({
      features: f,
      belief: this.belief,
      cfg: this.ctx.config,
      pingCooldown: frame.self.pingCooldown,
      callCooldown: frame.self.callCooldown,
      lastTag: this.chosen?.action.tag ?? null,
      decisionQuality: quality,
      allowPing: this.opts.allowPing !== false,
    });
    const best = this.ranked[0];
    if (!best) return;
    if (this.chosen && this.chosen.action.tag === best.action.tag) {
      // Same idea, refreshed target — keep the macro's phase running.
      this.chosen.action = best.action;
      return;
    }
    this.chosen = { action: best.action, at: this.now(), phase: 0, phaseT: 0 };
  }

  // -- execution -----------------------------------------------------------

  private execute(chosen: Chosen, frame: PerceptionFrame, intent: Intent, f: Features): void {
    const cfg = this.ctx.config;
    const a = chosen.action;
    intent.aim = aimFor(a, f);

    switch (a.kind) {
      case 'hold':
        break;
      case 'move':
      case 'investigate':
        this.steer(intent, f.me, a.to!, a.mode ?? 'walk');
        break;
      case 'contest': {
        // Get on top of him and stay there. Close in at a run, then stop running once inside the
        // steal radius so the last stride does not carry straight past him.
        const gap = dist2(f.me, a.to!);
        const reach = cfg.contest.steal.radius;
        this.steer(intent, f.me, a.to!, gap > reach * 1.4 ? 'run' : 'walk');
        // Under `requirePress` the steal is a held action, exactly like a catch.
        if (gap <= reach * 2 && cfg.contest.steal.requirePress) intent.catch = true;
        break;
      }
      case 'tackle':
        if (this.diveLock <= 0 && !frame.self.diving && !frame.self.recovering && !frame.self.down) {
          intent.dive = true;
          intent.move = a.dir!;
          this.diveLock = cfg.dive.cooldownSec;
        }
        break;
      case 'call':
        if (frame.self.callCooldown <= 1e-6) intent.call = true;
        break;
      case 'ping':
        if (this.pingLock <= 0 && frame.self.pingCooldown <= 1e-6) {
          intent.ping = true;
          this.pingLock = 0.25;
        }
        break;
      case 'shoot':
      case 'pass': {
        if (!frame.self.hasBall) {
          this.chosen = null;
          break;
        }
        const want = clamp(a.charge ?? cfg.throwing.maxCharge, 0, cfg.throwing.maxCharge);
        // The wind-up is read back from the body, never from a private timer: a whistle or a
        // restart can end a charge without the controller's consent (the dummies tripped on
        // exactly this).
        intent.charge = frame.self.chargeT < want;
        break;
      }
      case 'feint': {
        // Leg one is loud and goes the wrong way; leg two is quiet and goes the right way. The
        // whole point is that the noise and the body end up in different places.
        if (chosen.phase === 0) {
          this.steer(intent, f.me, a.via!, 'run');
          if (chosen.phaseT > 0.45 || dist2(f.me, a.via!) < 0.6) {
            chosen.phase = 1;
            chosen.phaseT = 0;
          }
        } else {
          this.steer(intent, f.me, a.to!, 'walk');
          if (dist2(f.me, a.to!) < 0.4) this.chosen = null;
        }
        break;
      }
      case 'dive':
        if (this.diveLock <= 0 && !frame.self.diving && !frame.self.recovering && !frame.self.down) {
          intent.dive = true;
          intent.move = a.dir!;
          this.diveLock = cfg.dive.cooldownSec;
        }
        break;
    }
  }

  /**
   * Steering, with one rule that matters more than the rest: slow down before you arrive.
   *
   * Braking hard is the loudest ordinary sound a body makes (11 m against a run's 9), so a bot
   * that sprints to its spot and stops dead has announced the spot to the whole pitch. Dropping
   * to a walk for the last stride keeps every speed change below the threshold, and the arrival
   * is silent.
   */
  private steer(intent: Intent, from: Vec2, to: Vec2, mode: 'walk' | 'run'): void {
    const d = sub2(to, from);
    const gap = len2(d);
    if (gap < 0.25) return;
    intent.move = norm2(d, { x: 0, y: 0 });
    intent.moveMode = mode === 'run' && gap > 1.6 ? 'run' : 'walk';
  }

  /**
   * Catching is a reflex, not a plan: whatever the chooser decided, a ball inside reach has to
   * be dealt with this tick or it becomes a fumble — the loudest mistake in the game.
   */
  private catchReflex(frame: PerceptionFrame, intent: Intent, f: Features): void {
    if (frame.self.hasBall || this.catchLock > 0 || frame.self.reaching || !f.ball) return;
    const cfg = this.ctx.config.catching;
    const reach = this.reach(frame);
    const rel = sub2(f.ball.pos, f.me);
    const d = len2(rel);
    const relVel = sub2(f.ball.vel, frame.self.vel);
    const relSpeed = len2(relVel);
    if (relSpeed < cfg.slowBallSpeed) {
      if (d > reach * 0.85) return;
      intent.catch = true;
      this.catchLock = 0.25;
      return;
    }
    // The hands stay open for `reachSec`, so the press has to be made while the ball is still
    // that much flight away — and closing them early is the whole of the "too soon" mistake.
    // Aim for the middle of the window rather than its edge: the bot's own reaction is quantised
    // to the decision tick, and it has to survive being a frame or two late.
    const closing = -(rel.x * relVel.x + rel.y * relVel.y) / Math.max(1e-6, d);
    if (closing <= 0) return;
    const arrival = (d - reach * 0.5) / Math.max(1e-6, closing);
    if (arrival <= cfg.reachSec * 0.6) {
      intent.catch = true;
      this.catchLock = 0.25;
    }
  }

  /** How far this body's hands reach right now — wider for a keeper standing in his crease. */
  private reach(frame: PerceptionFrame): number {
    const cfg = this.ctx.config;
    return frame.self.keeper && cfg.keeper.enabled ? cfg.catching.radius * cfg.keeper.reachMul : cfg.catching.radius;
  }

  /**
   * The save.
   *
   * A blind keeper has exactly two things: the line he is standing on, and the sound of the
   * release. He cannot know the corner — nothing he can hear says which one — so when the hum
   * says the ball is coming past him out of reach, his only answer is to throw his body at where
   * it will cross his own line, on the strength of an estimate that is often wrong.
   *
   * That is a reflex and not a plan, so it lives here rather than in the chooser: by the time a
   * 10 Hz decision noticed the shot, the ball would already be behind him.
   */
  private keeperReflex(frame: PerceptionFrame, intent: Intent, f: Features): void {
    const cfg = this.ctx.config;
    if (!frame.self.keeper || !cfg.keeper.enabled) return;
    if (frame.self.hasBall || frame.self.down || frame.self.diving || frame.self.recovering) return;
    if (this.diveLock > 0 || !f.ball) return;
    const rel = sub2(f.ball.pos, f.me);
    const d = len2(rel);
    const relVel = sub2(f.ball.vel, frame.self.vel);
    const closing = -(rel.x * relVel.x + rel.y * relVel.y) / Math.max(1e-6, d);
    // Only a real shot: a slow ball is walked to, and a ball going away is not a shot at all.
    if (closing < cfg.catching.slowBallSpeed * 2) return;
    const eta = d / Math.max(1e-6, closing);
    if (eta > cfg.dive.durationSec * 1.6 || eta < 0.04) return;
    // Where it will be when a dive could reach it, and how far off my line that is.
    const lead = { x: f.ball.pos.x + f.ball.vel.x * eta, y: f.ball.pos.y + f.ball.vel.y * eta };
    const miss = dist2(lead, f.me);
    const reach = this.reach(frame) * 0.9;
    const diveReach = cfg.dive.speed * cfg.dive.durationSec + cfg.contest.tackle.radius;
    if (miss <= reach || miss > diveReach) return;
    intent.dive = true;
    intent.move = norm2(sub2(lead, f.me), { x: 1, y: 0 });
    this.diveLock = cfg.dive.durationSec + cfg.dive.recoverySec;
  }

  // -- the overlay ---------------------------------------------------------

  debugSnapshot(): ControllerDebug | null {
    const f = this.features;
    if (!f) return { label: 'waiting' };
    const beliefs: BeliefCloud[] = [];
    for (let i = 0; i < this.belief.opponents.length; i++) {
      const t = this.belief.opponents[i]!;
      beliefs.push({
        about: `opp P${t.id}`,
        age: clamp(this.belief.now - t.lastSeenT, 0, 99),
        confidence: clamp(1 - f.oppArea[i]! / (f.field.width * f.field.height * 0.5), 0.05, 1),
        cell: t.grid.spec.cell,
        color: i === 0 ? '#ff5c8a' : '#ff9d5c',
        points: t.grid.debugPoints(420),
      });
    }
    for (const m of this.belief.mirrors) {
      beliefs.push({
        about: `mirror of P${m.opponent}`,
        age: clamp(this.belief.now - m.lastFixT, 0, 99),
        confidence: clamp(f.mirrorKnown, 0.05, 1),
        cell: m.grid.spec.cell,
        color: '#9d7bff',
        points: m.grid.debugPoints(200),
      });
    }
    const markers = [];
    if (f.intercept) {
      markers.push({ kind: 'circle' as const, pos: f.intercept.point, r: 0.5, label: 'intercept', color: '#7dffa8' });
    }
    const chosen = this.chosen?.action;
    if (chosen?.to) markers.push({ kind: 'line' as const, pos: f.me, to: chosen.to, label: chosen.tag, color: '#ffd166' });
    if (chosen?.via) markers.push({ kind: 'point' as const, pos: chosen.via, label: 'feint', color: '#ff7a5c' });
    if (chosen?.target) markers.push({ kind: 'line' as const, pos: f.me, to: chosen.target, label: 'throw', color: '#ff8fab' });
    markers.push({ kind: 'point' as const, pos: f.mirrorCentre, label: 'they think I am', color: '#9d7bff' });

    const top = this.ranked.slice(0, 4);
    return {
      label: `${f.role}${f.primary ? '' : '·2'} — ${chosen?.tag ?? '—'}`,
      readouts: {
        ball: this.belief.possession,
        unseen: f.secondsUnseen.toFixed(1),
        known: f.mirrorKnown.toFixed(2),
        'opp m²': f.oppArea.map((a) => a.toFixed(0)).join('/'),
        age: f.oppAge.map((a) => a.toFixed(1)).join('/'),
        axes: top[0] ? Object.entries(top[0].axes).map(([k, v]) => `${k[0]}${v.toFixed(2)}`).join(' ') : '—',
      },
      beliefs,
      markers,
      scores: top.map((s) => ({ action: s.action.tag, score: s.score })),
    };
  }

  /** Test and measurement hook. Not used by the game, and never a way back into the world. */
  get beliefState(): Belief {
    return this.belief;
  }

  get featureState(): Features | null {
    return this.features;
  }
}
