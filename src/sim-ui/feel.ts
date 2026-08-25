/**
 * The player's own body-sense: everything the HUD, the audio and the tutor need, derived from
 * one `PerceptionFrame` and the player's own fingers. Nothing else.
 *
 * This file exists because of one specific failure the concept warns about: a blind game where
 * the player cannot tell *why* something happened is not tense, it is annoying. So every
 * outcome that a person could read as "the game cheated me" gets an explanation computed at the
 * instant of the input:
 *
 *   * a missed catch says TOO FAST or OUT OF REACH, and never fails silently;
 *   * a wind-up says how much power is in it and when it crossed the commit threshold;
 *   * a ping says, for a beat, that the whole pitch just heard you.
 *
 * The verdicts are computed from the *perceived* ball — the same noisy estimate the player is
 * hearing — and from proprioception. That is deliberate: a verdict computed from the truth
 * would sometimes contradict what the player's ears said, which is worse than no verdict. The
 * error in the read-out is the same error the player was working with, so the read-out is
 * always consistent with the sound.
 */
import type { PerceptionFrame, SoundKind, Vec2 } from '../sim/types';
import type { Poll } from './input';
import type { PerceivedModel } from './perceived';

export type CatchVerdict = 'caught' | 'sprint' | 'past' | 'late' | 'pending';

export interface CatchAttempt {
  t: number;
  verdict: CatchVerdict;
  /** Signed seconds: positive = pressed this long before the ball's closest approach. */
  offset: number;
  /** Distance to the perceived ball at the moment of the press. */
  distance: number;
}

export interface Hint {
  id: string;
  text: string;
  /** Sim time it was first shown; -1 while unshown. */
  shownAt: number;
}

export interface Flash {
  kind: 'ping' | 'throw' | 'fumble' | 'catch' | 'goal' | 'conceded';
  t: number;
  strength: number;
}

const HINT_LIFE = 5.0;

export interface FeelConfig {
  minCharge: number;
  maxCharge: number;
  catchRadius: number;
  /** How fast the reach shrinks with the ball's speed — see `SimConfig.catching`. */
  catchSpeedSpan: number;
  minReachFrac: number;
  slowBallSpeed: number;
  /** Above this own speed a hard ball cannot be taken cleanly. */
  sprintSpeed: number;
  keeperReachMul: number;
  walkLoud: number;
  runLoud: number;
  pingCooldown: number;
  /** Seconds a carrier may hold the ball before the rules take it away. 0 = no rule. */
  carryTimeout: number;
}

/**
 * Live feel state for one human player.
 *
 * `update` is called once per simulated tick with the frame that tick produced and the poll
 * that drove it, so everything in here advances on simulation time and never on wall time —
 * the keyframe harness drives ticks by hand and must see exactly what a player would.
 */
export class Feel {
  readonly cfg: FeelConfig;
  t = 0;
  /** 0..1 wind-up, and whether it has passed the point where the throw stops being a lob. */
  charge = 0;
  chargeT = 0;
  committed = false;
  /** Set on the tick a throw leaves the hand; decays, and drives the release kick. */
  releaseFlash = 0;
  releasePower = 0;
  releaseAim: Vec2 = { x: 1, y: 0 };
  /** Latest catch attempt and its verdict; kept for the read-out under the player's nose. */
  lastCatch: CatchAttempt | null = null;
  /** Rolling own-loudness, smoothed for the meter (the raw value is a step function). */
  loudness = 0;
  loudnessPeak = 0;
  /** Seconds the player has been perfectly silent — the thing that makes standing still a move. */
  silentFor = 0;
  pingCooldown = 0;
  /**
   * How long this body has been holding the ball.
   *
   * Counted here rather than read from the frame because the simulation does not publish it,
   * and a person absolutely must have it: the rules take the ball off a carrier after five
   * seconds, and a hidden clock that dispossesses you is the definition of an unfair game.
   * Counting elapsed seconds while holding a ball is something a blindfolded human does
   * perfectly well, so this is proprioception and not a leak.
   */
  carryFor = 0;
  flashes: Flash[] = [];
  hints: Hint[] = [];
  /** Ball-relative numbers the HUD draws as the catch telegraph. */
  ballDistance = Infinity;
  ballClosing = 0;
  ballTca = Infinity;
  /** True while the ball is inside the reach it has at its current speed. */
  ballInReach = false;
  /**
   * The reach this body has RIGHT NOW, in metres.
   *
   * Not a constant any more: catching is automatic, and what a player has to learn instead is
   * that a fast ball can only be taken in a small area. Drawing that area, shrinking live as the
   * ball speeds up, is how the rule gets taught without a word of text.
   */
  reachNow = 0;
  score: readonly [number, number] = [0, 0];
  /** Match statistics a person can read without a debug panel. */
  stats = { pings: 0, throws: 0, catches: 0, fumbles: 0, loudSeconds: 0, quietSeconds: 0 };

  /** Timestamp of the last failure the core reported, so each one is announced exactly once. */
  private lastFailT = -99;

  private hintQueue: { id: string; text: string; when: (f: PerceptionFrame, s: Feel) => boolean }[];

  constructor(cfg: FeelConfig, pad = false) {
    this.cfg = cfg;
    this.hintQueue = defaultHints(pad);
  }

  reset(): void {
    this.t = 0;
    this.charge = 0;
    this.chargeT = 0;
    this.committed = false;
    this.releaseFlash = 0;
    this.lastCatch = null;
    this.loudness = 0;
    this.silentFor = 0;
    this.flashes = [];
    this.hints = [];
    this.lastFailT = -99;
    this.carryFor = 0;
    this.score = [0, 0];
    this.stats = { pings: 0, throws: 0, catches: 0, fumbles: 0, loudSeconds: 0, quietSeconds: 0 };
  }

  update(frame: PerceptionFrame, model: PerceivedModel, poll: Poll | null, dt: number): void {
    const self = frame.self;
    this.t = frame.match.t;
    this.pingCooldown = self.pingCooldown;

    // --- the wind-up ------------------------------------------------------
    this.chargeT = self.chargeT;
    this.charge = Math.min(1, self.chargeT / this.cfg.maxCharge);
    const wasCommitted = this.committed;
    this.committed = self.charging && self.chargeT >= this.cfg.minCharge;
    if (this.committed && !wasCommitted) this.push('catch', 0.35);

    if (self.hasBall) this.carryFor += dt;
    else this.carryFor = 0;

    // --- loudness ---------------------------------------------------------
    // The raw readout is a step function (walk radius, then a ramp to the run radius); the meter
    // eases towards it so the needle moves like a needle and not like a light switch.
    const target = self.ownLoudness;
    this.loudness += (target - this.loudness) * Math.min(1, dt * 12);
    this.loudnessPeak = Math.max(target, this.loudnessPeak - dt * 6);
    if (target <= 0.01) {
      this.silentFor += dt;
      this.stats.quietSeconds += dt;
    } else {
      this.silentFor = 0;
      if (target > this.cfg.walkLoud + 0.5) this.stats.loudSeconds += dt;
    }

    // --- the ball, as the catch telegraph reads it ------------------------
    const ball = model.ball;
    if (ball) {
      const rel = { x: ball.pos.x - self.pos.x, y: ball.pos.y - self.pos.y };
      const relVel = { x: ball.vel.x - self.vel.x, y: ball.vel.y - self.vel.y };
      this.ballDistance = Math.hypot(rel.x, rel.y);
      const vv = relVel.x * relVel.x + relVel.y * relVel.y;
      this.ballClosing = vv > 1e-6 ? -(rel.x * relVel.x + rel.y * relVel.y) / Math.sqrt(vv) : 0;
      this.ballTca = vv > 1e-6 ? -(rel.x * relVel.x + rel.y * relVel.y) / vv : Infinity;
      // The window the telegraph shows is the *reachable* half of the simulation's window.
      // The rules eat an encounter the moment a body and the ball actually touch (a block, a
      // deflection or a pass-through, depending on the ruleset), so a press that lands after
      // closest approach almost never resolves as a catch. Drawing the symmetric ±window would
      // therefore promise a green light that does not exist, and the whole point of this layer
      // is to stop promising things.
      const relSpeed = Math.sqrt(vv);
      const base = this.cfg.catchRadius * (self.keeper ? this.cfg.keeperReachMul : 1);
      const over = relSpeed - this.cfg.slowBallSpeed;
      this.reachNow =
        over <= 0
          ? base
          : base * Math.min(1, Math.max(this.cfg.minReachFrac, 1 - over / Math.max(1e-6, this.cfg.catchSpeedSpan)));
      this.ballInReach = !self.hasBall && this.ballDistance <= this.reachNow;
    } else {
      this.ballDistance = Infinity;
      this.ballInReach = false;
      this.reachNow = this.cfg.catchRadius * (self.keeper ? this.cfg.keeperReachMul : 1);
    }

    // --- what the ball did -----------------------------------------------
    // Nothing here reads a button any more: catching is automatic, so the only verdicts left are
    // the ones the simulation hands over as proprioception. That is a strict improvement — the
    // verdict used to be reconstructed out here from the sign of a time-to-closest-approach, and
    // it was wrong for the four ticks between a press and the ball arriving.
    if (self.lastCatchFail && self.lastCatchFailT > this.lastFailT) {
      this.lastFailT = self.lastCatchFailT;
      const verdict: CatchVerdict =
        self.lastCatchFail === 'sprint' ? 'sprint' : self.lastCatchFail === 'past' ? 'past' : 'late';
      this.lastCatch = { t: this.t, verdict, offset: 0, distance: this.ballDistance };
    }
    if (poll?.pressedPing && self.pingCooldown <= 0) this.push('ping', 1);
    if (poll?.releasedCharge && self.hasBall) {
      // Sim resolves the release on this same tick; the power is whatever was in the hand.
      this.releasePower = Math.min(1, Math.max(0, this.chargeT / this.cfg.maxCharge));
    }

    // --- what the ears heard about the player's own body ------------------
    for (const ev of frame.events) {
      if (!ev.self) continue;
      if (ev.kind === 'throw') {
        this.releaseFlash = 1;
        this.releaseAim = { x: self.aim.x, y: self.aim.y };
        this.push('throw', 1);
        this.stats.throws++;
      } else if (ev.kind === 'catch') {
        // There is no press to hang the verdict on any more, so the catch itself creates the
        // read-out. Saying CAUGHT is not decoration: it is the difference between "the ball is
        // gone from the air" and "the ball is in my hands" for somebody who cannot see either.
        this.lastCatch = { t: this.t, verdict: 'caught', offset: 0, distance: this.ballDistance };
        this.push('catch', 0.8);
        this.stats.catches++;
      } else if (ev.kind === 'fumble') {
        if (!this.lastCatch || this.t - this.lastCatch.t > 0.25) {
          this.lastCatch = { t: this.t, verdict: 'late', offset: 0, distance: this.ballDistance };
        }
        this.push('fumble', 1);
        this.stats.fumbles++;
      } else if (ev.kind === 'sonar') {
        this.stats.pings++;
      }
    }

    if (frame.match.score[0] !== this.score[0] || frame.match.score[1] !== this.score[1]) {
      const mine = frame.match.score[self.team];
      this.push(mine > this.score[self.team] ? 'goal' : 'conceded', 1);
      this.score = [frame.match.score[0], frame.match.score[1]];
    }

    this.releaseFlash = Math.max(0, this.releaseFlash - dt * 2.2);
    for (const f of this.flashes) f.strength -= dt * 1.6;
    this.flashes = this.flashes.filter((f) => f.strength > 0);

    this.tutor(frame);
  }

  private push(kind: Flash['kind'], strength: number): void {
    this.flashes.push({ kind, t: this.t, strength });
    if (this.flashes.length > 12) this.flashes.shift();
  }

  /**
   * The self-teaching layer.
   *
   * A jam player gets thirty seconds. Each hint fires once, when the situation it describes is
   * the situation the player is actually in — "hold to wind up" arrives when the ball lands in
   * their hands, not in a wall of text on a title screen.
   */
  private tutor(frame: PerceptionFrame): void {
    if (this.hintQueue.length === 0) return;
    const next = this.hintQueue[0]!;
    const live = this.hints.filter((h) => this.t - h.shownAt < HINT_LIFE);
    if (live.length > 0) return;
    if (next.when(frame, this)) {
      this.hints.push({ id: next.id, text: next.text, shownAt: this.t });
      this.hintQueue.shift();
    }
  }

  /** The hint that should be on screen right now, if any. */
  get activeHint(): Hint | null {
    for (let i = this.hints.length - 1; i >= 0; i--) {
      const h = this.hints[i]!;
      if (this.t - h.shownAt < HINT_LIFE) return h;
    }
    return null;
  }

  /** Read-out for the missed-catch line under the player's nose; null when it has faded. */
  get catchReadout(): { text: string; colour: string; alpha: number } | null {
    const c = this.lastCatch;
    if (!c) return null;
    const age = this.t - c.t;
    if (age > 1.6) return null;
    const alpha = Math.max(0, 1 - age / 1.6);
    // The wording is deliberately about DISTANCE and not only about milliseconds. Measured on
    // the real numbers, a 18 m/s pass crosses the 1.2 m catch radius in about 130 ms, which is
    // narrower than the ±180 ms timing window — so in practice a player never misses by
    // mistiming a ball that is on them, they miss by grabbing at a ball that has not arrived.
    // Telling them "too early" without saying "by two and a half metres" would be true and
    // useless.
    if (c.verdict === 'caught') return { text: 'CAUGHT', colour: '#7dffa8', alpha };
    // Three failures, and each one names the thing to do differently. There is no button to blame
    // any more, so a verdict that does not name a cause is worse than no verdict at all.
    if (c.verdict === 'sprint') return { text: 'TOO FAST · slow down to take it', colour: '#ff9a52', alpha };
    if (c.verdict === 'past') {
      return { text: `OUT OF REACH · it was ${c.distance.toFixed(1)} m wide`, colour: '#ff9a52', alpha };
    }
    if (c.verdict === 'late') return { text: 'OFF THE BODY · too hard to hold', colour: '#ff4d6d', alpha };
    return null;
  }
}

/** How loud, as a word. The meter needs three bands, not a number nobody can feel. */
export function loudnessBand(loud: number, cfg: FeelConfig): 'silent' | 'quiet' | 'loud' {
  if (loud <= 0.01) return 'silent';
  if (loud <= cfg.walkLoud + 0.5) return 'quiet';
  return 'loud';
}

export const KIND_LABEL: Partial<Record<SoundKind, string>> = {
  'step-walk': 'steps',
  'step-run': 'RUNNING',
  brake: 'STOP',
  dive: 'DIVE',
  catch: 'catch',
  fumble: 'FUMBLE',
  throw: 'THROW',
  'ball-wall': 'wall',
  sonar: 'PING',
  whistle: 'whistle',
};

function defaultHints(pad: boolean): { id: string; text: string; when: (f: PerceptionFrame, s: Feel) => boolean }[] {
  const move = pad ? 'LEFT STICK' : 'WASD';
  const quiet = pad ? 'ease the stick' : 'hold SHIFT';
  const ping = pad ? 'LB' : 'SPACE';
  const throwKey = pad ? 'RT' : 'LEFT MOUSE';
  return [
    {
      id: 'ball',
      text: 'a LOOSE ball sings from anywhere — that gold mark is the one thing everybody knows',
      when: (f) => f.match.t > 0.6 && f.emitters.length > 0,
    },
    {
      id: 'move',
      text: `${move} to move · running is loud, ${quiet} to walk quietly`,
      when: (f) => f.match.t > 3,
    },
    {
      id: 'loud',
      text: 'that ring is how far away you can be heard right now. Standing still, nobody can see you at all',
      when: (_f, s) => s.loudness > s.cfg.walkLoud + 1,
    },
    {
      id: 'catch',
      text: 'catching is automatic — the ring is your reach, and it shrinks the faster the ball comes',
      when: (_f, s) => s.ballDistance < 3.5,
    },
    {
      id: 'throw',
      text: `hold ${throwKey} to wind up, release to throw. Longer hold, harder throw`,
      when: (f) => f.self.hasBall,
    },
    {
      id: 'carry',
      // The most important thing to teach now: the ball is silent when you take it and gets
      // louder the longer you keep it, so a pass is how you disappear again.
      text: 'the ball beeps in your hands, louder the longer you hold it. Pass, and you go quiet',
      when: (_f, s) => s.carryFor > 1.4,
    },
    {
      id: 'keeper',
      text: 'you are the keeper: you alone may stand inside your own arc, and you find the ball by ear',
      when: (f) => f.self.keeper,
    },
    {
      id: 'call',
      // The human's one way of taking part in the attack: a bot cannot throw at a body it
      // cannot place, and standing still is exactly what makes a body unplaceable.
      text: `${pad ? 'RB' : 'E'} shouts for the ball — your team-mate will throw at the shout, and so will they`,
      when: (f) => !f.self.hasBall && f.match.t > 8,
    },
    {
      id: 'ping',
      text: `${ping} pings: a second of sight, and every single player hears exactly where you fired it from`,
      when: (f) => f.match.t > 14 && f.self.pingCooldown <= 0,
    },
  ];
}
