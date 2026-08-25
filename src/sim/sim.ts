/**
 * The simulation. Pure logic: no DOM, no renderer, no wall clock, no `Math.random()`.
 *
 * Contract: `new Simulation(config, seed)` plus a fixed sequence of `Intent` arrays is the whole
 * input of a match. The same pair produces the same match down to the last bit, which is what
 * makes replays, the keyframe generator and any future bot benchmark mean anything. `hash()`
 * exists so a test can say that in one line.
 *
 * Everything the outside world learns from a tick comes back from `step()`: the sound events the
 * physics produced and whatever the active pings revealed. Nothing is pushed anywhere, and the
 * simulation holds no references to its consumers.
 */
import type { SimConfig } from './config';
import { makeField, confineBody, insideCrease, insideCreaseOf, sampleGeometry, inGoalMouth } from './field';
import {
  clamp,
  clone2,
  dist2,
  dot2,
  len2,
  lerp,
  norm2,
  scatterDir,
  v2,
} from './math';
import { makeRng, type Rng } from '../core/rng';
import {
  BALL_ID,
  type ContinuousEmitter,
  type EntityId,
  type FieldInfo,
  type Intent,
  type MatchPhase,
  type SonarHit,
  type SonarReturn,
  type SoundEvent,
  type SoundKind,
  type TeamId,
  type Vec2,
} from './types';

export type MoveState = 'stand' | 'walk' | 'run';

export interface PlayerState {
  id: EntityId;
  team: TeamId;
  pos: Vec2;
  vel: Vec2;
  aim: Vec2;
  move: MoveState;
  hasBall: boolean;
  charging: boolean;
  chargeT: number;
  /** > 0 while the body is airborne in a dive. */
  diveT: number;
  /** > 0 while getting back up: no movement, no dive, but the hands still work. */
  recoverT: number;
  diveCd: number;
  diveDir: Vec2;
  pingCd: number;
  /** Cooldown before this body may touch the ball again (after a release, catch or fumble). */
  ballCd: number;
  /** Cooldown before this body may shout for the ball again. */
  callCd: number;
  /** Metres travelled since the last footstep sound. */
  strideAcc: number;
  brakeCd: number;
  /** Fastest speed seen inside the current brake window, and its age. */
  peakSpeed: number;
  peakAge: number;
  /**
   * Heading the body has been holding, and for how long. A sharp turn away from it is as loud
   * as a hard stop — `player.brakeTurnCos` was declared in the config and read by nobody, which
   * meant half of the loudness table's "резкая смена направления" row simply did not exist.
   */
  dirRef: Vec2;
  dirRefNext: Vec2;
  dirRefAge: number;
  /** > 0 while this body is on the ground after tripping over a trap: silent-less, helpless, visible. */
  downT: number;
  /**
   * > 0 while this body is lying down AS a trap — a dive that has finished its dash. Not the same
   * state as `downT`: this body chose to be here and is what somebody else trips over, `downT` is
   * what happens to the somebody else. See `TackleConfig`.
   */
  lieT: number;
  /** > 0 while a hard collision has taken the body's control away. */
  staggerT: number;
  /** Seconds spent contesting the current carrier, and who that carrier is. */
  contestT: number;
  contestTarget: EntityId | null;
  /** Grace after a steal: this body can neither be robbed nor rob again until it expires. */
  robbedCd: number;
  /** Whether the current lying-down instance has already tripped somebody. */
  trapSprung: boolean;
  /**
   * True for this tick if a body contact is holding this carrier's ground for him — the arms'-
   * length proprioception a blind carrier gets for free from being shoved, published so the
   * decision layer does not have to infer "I am being marked" from stale sound alone.
   */
  pinned: boolean;
  /** > 0 while the hands are open after a catch press. */
  reachT: number;
  /** Cooldown before the hands can be opened again. */
  reachCd: number;
  /** Whether the ball came inside reach during the current open window. */
  reachSawBall: boolean;
  /** Why the last attempt on the ball failed, and when — proprioception, published to the frame. */
  lastCatchFail: 'early' | 'late' | 'past' | 'sprint' | null;
  lastCatchFailT: number;
  /** Audible radius of the loudest noise this body made this tick — the "am I loud" readout. */
  loudness: number;
  /**
   * The gloves: this body, and only this body, may stand inside its own crease.
   *
   * Assigned by the simulation (nearest to his own goal, with hysteresis) and never by a button.
   * It is proprioception, so it is published to the frame — a blind keeper still knows he is the
   * keeper — and it is the only asymmetry between two bodies in the game.
   */
  keeper: boolean;
}

export interface BallState {
  pos: Vec2;
  vel: Vec2;
  /** Player id when held, null when loose. */
  carrier: EntityId | null;
  lastToucher: EntityId | null;
  /** Who threw it last — an interception is a catch by someone not on the thrower's team. */
  lastThrower: EntityId | null;
  lastThrowerTeam: TeamId | null;
  /** Set at release: was it let go from outside the crease? A goal needs this. */
  goalValid: boolean;
  /** How long this loose ball has been lying inside a crease — see `creaseBallTimeoutSec`. */
  inCreaseT: number;
  /** How long the current carrier has held it — the ramp behind the ball's voice. */
  carryT: number;
  /** Time since the last beep of a carried ball. */
  voiceT: number;
}

/** A ping in flight: the front is still travelling and has not revealed everything yet. */
export interface PendingPing {
  id: number;
  owner: EntityId;
  origin: Vec2;
  aim: Vec2;
  cosHalf: number;
  t: number;
  radius: number;
  /** Static samples sorted by distance from the origin, revealed as the front passes them. */
  geometry: { pos: Vec2; kind: 'wall' | 'crease'; d: number }[];
  geomCursor: number;
  /** Bodies already lit by this front — a body is revealed at most once per ping. */
  litBodies: Set<EntityId>;
}

export interface WorldState {
  tick: number;
  t: number;
  phase: MatchPhase;
  /** Seconds left in the current phase (restart freeze). */
  phaseT: number;
  score: [number, number];
  players: PlayerState[];
  ball: BallState;
  pings: PendingPing[];
  nextPingId: number;
  /** Team that will restart play, set when a goal goes in. */
  restartTeam: TeamId;
}

/** A body meeting the ball. Reported so the match can tell a pass from an interception. */
export interface BallTouch {
  kind: 'catch' | 'fumble';
  player: EntityId;
  /** Who threw the ball that was touched, if it was in flight from a throw. */
  fromThrower: EntityId | null;
  fromTeam: TeamId | null;
}

export interface StepOutput {
  events: SoundEvent[];
  touches: BallTouch[];
  /** Returns produced this tick, one per (ping, tick) that lit at least something. */
  sonar: (SonarReturn & { owner: EntityId })[];
  /** Goals scored this tick, for stats and for the timeline. */
  goals: { team: TeamId; scorer: EntityId | null; t: number }[];
  /** Possession handed over by a rule rather than by play (the goalkeeper throw). */
  turnovers: { team: TeamId; reason: 'crease' | 'passivity'; t: number }[];
  /**
   * The fight for the ball, event by event — what the rule tournament actually measures.
   *
   * Optional so that the handful of places that hand-build an empty `StepOutput` (the debug
   * playground's first frame, the match's own priming frame) did not all have to change on the
   * day contact was added. The simulation always fills it in.
   */
  contests?: ContestEvent[];
}

export type ContestKind =
  | 'steal'
  | 'tackle'
  | 'tackle-miss'
  | 'collision'
  | 'block'
  | 'through'
  /** A keeper, inside his own crease, stopping or catching a shot. */
  | 'save';

/**
 * One moment of contact. `player` is whoever acted (the thief, the diver, the faster body in a
 * collision); `victim` is who it happened to, when there is one.
 */
export interface ContestEvent {
  kind: ContestKind;
  player: EntityId;
  victim: EntityId | null;
  t: number;
}

/** Read-only face of the world, handed to `perceive` — never to a controller. */
export type WorldView = Readonly<WorldState>;

export class Simulation {
  readonly config: SimConfig;
  readonly field: FieldInfo;
  readonly seed: number;
  state: WorldState;

  private rng: Rng;
  private prevIntents: Intent[];
  private readonly events: SoundEvent[] = [];
  private readonly sonar: (SonarReturn & { owner: EntityId })[] = [];
  private readonly goals: { team: TeamId; scorer: EntityId | null; t: number }[] = [];
  private readonly touches: BallTouch[] = [];
  private readonly turnovers: { team: TeamId; reason: 'crease' | 'passivity'; t: number }[] = [];
  private readonly contests: ContestEvent[] = [];

  constructor(config: SimConfig, seed: number) {
    this.config = config;
    this.field = makeField(config.field);
    this.seed = seed;
    // One stream for the whole simulation, consumed in a fixed order. Perception draws from its
    // own streams so that adding an observer cannot shift the physics by one random number.
    this.rng = makeRng(seed);
    this.state = this.makeInitialState();
    this.prevIntents = this.state.players.map(() => idleIntentInternal());
  }

  get playerCount(): number {
    return this.config.teamSize * 2;
  }

  teamOf(id: EntityId): TeamId {
    return id < this.config.teamSize ? 0 : 1;
  }

  /**
   * The continuous sources audible right now.
   *
   * A LOOSE ball only. In flight it is the loudest continuous thing in the game — that is the
   * price of a pass and the reason an interception is possible at all — but in a pair of hands
   * it is not a continuous source any more, it is a beep with a rising rate (`ballVoice`).
   */
  emitters(): ContinuousEmitter[] {
    const b = this.state.ball;
    if (b.carrier !== null) return [];
    return [
      {
        id: BALL_ID,
        kind: 'ball',
        pos: clone2(b.pos),
        vel: clone2(b.vel),
        intensity: this.config.loudness['ball-hum'],
      },
    ];
  }

  // -- setup ---------------------------------------------------------------

  private makeInitialState(): WorldState {
    const n = this.config.teamSize * 2;
    const players: PlayerState[] = [];
    for (let i = 0; i < n; i++) {
      players.push({
        id: i,
        team: i < this.config.teamSize ? 0 : 1,
        pos: v2(),
        vel: v2(),
        aim: v2(1, 0),
        move: 'stand',
        hasBall: false,
        charging: false,
        chargeT: 0,
        diveT: 0,
        recoverT: 0,
        diveCd: 0,
        diveDir: v2(1, 0),
        pingCd: 0,
        ballCd: 0,
        callCd: 0,
        strideAcc: 0,
        brakeCd: 0,
        peakSpeed: 0,
        peakAge: 0,
        dirRef: v2(1, 0),
        dirRefNext: v2(1, 0),
        dirRefAge: 0,
        downT: 0,
        lieT: 0,
        staggerT: 0,
        contestT: 0,
        contestTarget: null,
        robbedCd: 0,
        trapSprung: false,
        pinned: false,
        reachT: 0,
        reachCd: 0,
        reachSawBall: false,
        lastCatchFail: null,
        lastCatchFailT: -99,
        loudness: 0,
        keeper: false,
      });
    }
    const state: WorldState = {
      tick: 0,
      t: 0,
      phase: 'play',
      phaseT: 0,
      score: [0, 0],
      players,
      ball: {
        pos: v2(),
        vel: v2(),
        carrier: null,
        lastToucher: null,
        lastThrower: null,
        lastThrowerTeam: null,
        goalValid: false,
        inCreaseT: 0,
        carryT: 0,
        voiceT: 0,
      },
      pings: [],
      nextPingId: 1,
      restartTeam: 0,
    };
    const kickoff: TeamId = this.config.match.kickoffTeam === 'alternate' ? ((seedParity(this.seed)) as TeamId) : 0;
    state.restartTeam = kickoff;
    this.layout(state, kickoff);
    return state;
  }

  /**
   * Puts everyone back on their marks. `team` restarts with the ball, standing just outside its
   * own crease — the concept's "розыгрыш от своих ворот".
   */
  private layout(state: WorldState, team: TeamId): void {
    const f = this.field;
    const size = this.config.teamSize;
    const restartX = f.halfWidth - f.creaseRadius - 1.2;
    for (const p of state.players) {
      const own = p.team === team;
      const idx = p.id % size;
      const spread = size === 1 ? 0 : (idx / (size - 1) - 0.5) * (f.height - 4);
      const sign = p.team === 0 ? -1 : 1;
      const jitter = this.config.match.spawnJitter;
      p.pos = own ? v2(sign * restartX, spread) : v2(sign * (f.halfWidth * 0.35), spread);
      if (jitter > 0) {
        p.pos.x += (this.rng() * 2 - 1) * jitter;
        p.pos.y += (this.rng() * 2 - 1) * jitter;
      }
      p.vel = v2();
      p.aim = v2(p.team === 0 ? 1 : -1, 0);
      p.move = 'stand';
      p.hasBall = false;
      p.charging = false;
      p.chargeT = 0;
      p.diveT = 0;
      p.recoverT = 0;
      p.diveCd = 0;
      p.ballCd = 0;
      p.callCd = 0;
      p.strideAcc = 0;
      p.brakeCd = 0;
      p.peakSpeed = 0;
      p.peakAge = 0;
      p.dirRef = v2(p.team === 0 ? 1 : -1, 0);
      p.dirRefNext = clone2(p.dirRef);
      p.dirRefAge = 0;
      p.downT = 0;
      p.lieT = 0;
      p.staggerT = 0;
      p.contestT = 0;
      p.contestTarget = null;
      p.robbedCd = 0;
      p.trapSprung = false;
      p.pinned = false;
      p.reachT = 0;
      p.reachCd = 0;
      p.reachSawBall = false;
      p.lastCatchFail = null;
      p.lastCatchFailT = -99;
      p.loudness = 0;
      p.keeper = false;
      confineBody(f, p.pos, p.vel, this.config.player.radius);
    }
    // Gloves before the whistle: whoever restarts furthest back is his team's keeper, so the
    // role is settled before the first step rather than flickering into existence during it.
    this.updateKeepers(state);
    const carrier = state.players.find((p) => p.team === team) ?? state.players[0]!;
    carrier.hasBall = true;
    state.ball.carrier = carrier.id;
    state.ball.vel = v2();
    state.ball.lastToucher = carrier.id;
    state.ball.lastThrower = null;
    state.ball.lastThrowerTeam = null;
    state.ball.goalValid = false;
    state.ball.inCreaseT = 0;
    state.ball.carryT = 0;
    state.ball.voiceT = 0;
    this.placeCarriedBall(state, carrier);
    state.pings.length = 0;
  }

  private placeCarriedBall(state: WorldState, p: PlayerState): void {
    const off = this.config.player.radius + this.config.ball.carryOffset;
    state.ball.pos = v2(p.pos.x + p.aim.x * off, p.pos.y + p.aim.y * off);
    state.ball.vel = clone2(p.vel);
  }

  // -- the tick ------------------------------------------------------------

  /**
   * Advances the world by exactly `config.dt`. `intents` must have one entry per player, in id
   * order; anything missing is treated as "stand still and do nothing".
   */
  step(intents: readonly Intent[]): StepOutput {
    const cfg = this.config;
    const dt = cfg.dt;
    const s = this.state;
    this.events.length = 0;
    this.sonar.length = 0;
    this.goals.length = 0;
    this.touches.length = 0;
    this.turnovers.length = 0;
    this.contests.length = 0;

    s.tick += 1;
    s.t += dt;

    if (s.phase === 'over') {
      this.advancePings(dt);
      return this.output();
    }

    if (s.phase === 'restart') {
      s.phaseT -= dt;
      for (const p of s.players) p.loudness = 0;
      // Intents are ignored while everyone walks back to their marks, but they are still
      // *recorded*: otherwise a button held across the freeze would look like a fresh press the
      // moment play resumes, and a button released across it would have its release eaten.
      for (let i = 0; i < s.players.length; i++) {
        this.prevIntents[i] = copyIntent(intents[i] ?? idleIntentInternal());
      }
      if (s.phaseT <= 0) {
        s.phase = 'play';
        s.phaseT = 0;
      }
      this.advancePings(dt);
      this.checkClock();
      return this.output();
    }

    this.updateKeepers();

    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i]!;
      const intent = intents[i] ?? idleIntentInternal();
      const prev = this.prevIntents[i] ?? idleIntentInternal();
      p.loudness = 0;
      p.pinned = false;
      this.stepPlayer(p, intent, prev, dt);
    }

    this.resolveCollisions();
    this.resolveTraps();
    this.stepBall(dt);
    this.resolveBallContacts(intents);
    this.resolveSteals(intents, dt);
    this.checkCreaseBall(dt);
    this.checkPassivity(dt);
    this.ballVoice(dt);
    this.advancePings(dt);

    for (let i = 0; i < s.players.length; i++) {
      this.prevIntents[i] = copyIntent(intents[i] ?? idleIntentInternal());
    }

    this.checkClock();
    return this.output();
  }

  private output(): StepOutput {
    return {
      events: this.events.slice(),
      touches: this.touches.slice(),
      turnovers: this.turnovers.slice(),
      contests: this.contests.slice(),
      sonar: this.sonar.slice(),
      goals: this.goals.slice(),
    };
  }

  private checkClock(): void {
    const s = this.state;
    const m = this.config.match;
    if (s.phase === 'over') return;
    if (s.score[0] >= m.goalsToWin || s.score[1] >= m.goalsToWin || s.t >= m.durationSec) {
      s.phase = 'over';
    }
  }

  /**
   * Who wears the gloves.
   *
   * Deepest body of each team, with two rules that keep it from being a nuisance:
   *
   *   - hysteresis (`keeper.switchMargin`), because the role is what lets a body stand inside
   *     the crease, and a role that flickers is a body being teleported out of the crease twice
   *     a second by the confinement rule;
   *   - the incumbent cannot be stripped while he is *standing in* his crease. Otherwise the
   *     moment his team-mate drops behind him the rules would eject him from where he stands,
   *     which reads as a bug however correct the depth chart is.
   *
   * Possession is deliberately NOT part of it. Tying the gloves to who has the ball means the
   * role changes hands at the noisiest, most crowded moment of the game, and it buys nothing: a
   * team pressing forward has both bodies far from its own goal anyway, so the keeper of an
   * attacking team is simply the man who happens to be back — which is exactly what it should be.
   */
  private updateKeepers(state: WorldState = this.state): void {
    const cfg = this.config.keeper;
    const s = state;
    if (!cfg.enabled) {
      for (const p of s.players) p.keeper = false;
      return;
    }
    const carrier = s.ball.carrier === null ? null : s.players[s.ball.carrier] ?? null;
    for (let team = 0; team < 2; team++) {
      const own = this.field.goalCentre[team]!;
      let incumbent: PlayerState | null = null;
      let best: PlayerState | null = null;
      let bestD = Infinity;
      for (const p of s.players) {
        if (p.team !== team) continue;
        if (p.keeper) incumbent = p;
        const d = dist2(p.pos, own);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (!best) continue;
      // A team with the ball has no keeper. Two bodies attacking against one defender and a
      // keeper is what makes a pass worth anything; a permanent keeper turns 2×2 into 1×1 with
      // two spectators, and a pass into a throw at a man standing in his own goal.
      const attacking = carrier !== null && carrier.team === team;
      if (attacking) {
        // But he is not stripped of the gloves *inside* his crease: the rules would eject him
        // from where he stands the instant his side won the ball, which reads as a bug however
        // correct the depth chart is. He gives them up on his way out, which is also when a
        // human would stop thinking of himself as the keeper.
        if (incumbent && !insideCreaseOf(this.field, team, incumbent.pos, this.config.player.radius)) {
          incumbent.keeper = false;
        }
        continue;
      }
      if (!incumbent) {
        best.keeper = true;
        continue;
      }
      if (incumbent === best) continue;
      if (insideCreaseOf(this.field, team, incumbent.pos, this.config.player.radius)) continue;
      if (dist2(incumbent.pos, own) - bestD < cfg.switchMargin) continue;
      incumbent.keeper = false;
      best.keeper = true;
    }
  }

  /** The crease index this body is allowed inside, or -1. The whole of the keeper's privilege. */
  private creaseAccess(p: PlayerState): number {
    return this.config.keeper.enabled && p.keeper ? p.team : -1;
  }

  /** True while this body is the keeper AND standing in his own crease — where his job is. */
  private keeping(p: PlayerState): boolean {
    return (
      this.config.keeper.enabled &&
      p.keeper &&
      insideCreaseOf(this.field, p.team, p.pos, this.config.player.radius)
    );
  }

  /**
   * How far this body's hands reach for a ball closing at `relSpeed`.
   *
   * The reach shrinks with the ball's speed, and that single curve is what replaced the catch
   * button when catching became automatic. A rolling ball is picked up by being near it; a pass
   * has to be met on its line; a shot has to hit your hands. It is also the whole of what makes
   * a keeper a keeper — his multiplier is applied before the shrink, so the faster the ball the
   * bigger the difference between his hands and anybody else's.
   */
  private reachRadius(p: PlayerState, relSpeed: number): number {
    const c = this.config.catching;
    const base = this.keeping(p) ? c.radius * this.config.keeper.reachMul : c.radius;
    const over = relSpeed - c.slowBallSpeed;
    if (over <= 0) return base;
    return base * clamp(1 - over / Math.max(1e-6, c.catchSpeedSpan), c.minReachFrac, 1);
  }

  private emit(kind: SoundKind, pos: Vec2, sourceId: EntityId): void {
    this.emitAt(kind, pos, sourceId, this.config.loudness[kind]);
  }

  /** The same, with the audible radius decided by the caller — the ball's ramping beep. */
  private emitAt(kind: SoundKind, pos: Vec2, sourceId: EntityId, intensity: number): void {
    if (intensity <= 0) return;
    this.events.push({
      t: this.state.t,
      tick: this.state.tick,
      kind,
      pos: clone2(pos),
      intensity,
      sourceId,
    });
    if (sourceId >= 0) {
      const p = this.state.players[sourceId];
      if (p) p.loudness = Math.max(p.loudness, intensity);
    }
  }

  // -- players -------------------------------------------------------------

  private stepPlayer(p: PlayerState, intent: Intent, prev: Intent, dt: number): void {
    const cfg = this.config;
    p.pingCd = Math.max(0, p.pingCd - dt);
    p.diveCd = Math.max(0, p.diveCd - dt);
    p.ballCd = Math.max(0, p.ballCd - dt);
    p.callCd = Math.max(0, p.callCd - dt);
    p.brakeCd = Math.max(0, p.brakeCd - dt);
    p.robbedCd = Math.max(0, p.robbedCd - dt);
    p.staggerT = Math.max(0, p.staggerT - dt);
    p.reachCd = Math.max(0, p.reachCd - dt);
    if (p.reachT > 0) {
      p.reachT -= dt;
      if (p.reachT <= 0) {
        p.reachT = 0;
        p.reachCd = cfg.catching.reachCooldownSec;
        // The hands closed on nothing. That is the "too early" half of the timing, and it is
        // the half a player can only learn about if somebody tells him.
        if (!p.reachSawBall && !p.hasBall) {
          p.lastCatchFail = 'early';
          p.lastCatchFailT = this.state.t;
        }
        p.reachSawBall = false;
      }
    }
    // Opening the hands is a rising edge, and it cannot be held: one press, one window.
    if (intent.catch && !prev.catch && p.reachT <= 0 && p.reachCd <= 0 && p.downT <= 0) {
      p.reachT = cfg.catching.reachSec;
      p.reachSawBall = false;
    }

    const aimLen = len2(intent.aim);
    if (aimLen > 1e-6) p.aim = norm2(intent.aim, p.aim);

    // --- tripped: the price of walking into somebody's trap -----------------
    // A body on the floor does not move, cannot ping, cannot throw and cannot dive. It is not
    // silent either: the fall itself rang out, and its position is now common knowledge.
    if (p.downT > 0) {
      p.downT -= dt;
      p.vel = v2();
      p.move = 'stand';
      p.charging = false;
      p.chargeT = 0;
      p.strideAcc = 0;
      p.peakSpeed = 0;
      p.peakAge = 0;
      if (p.hasBall) this.placeCarriedBall(this.state, p);
      return;
    }

    // --- lying down: the trap itself, live -----------------------------------
    // Not attacking anybody — `resolveTraps` is what turns somebody else's own legs into a fall.
    // This body simply cannot do anything else while it commits to being an obstacle.
    if (p.lieT > 0) {
      p.lieT -= dt;
      p.vel = v2();
      p.move = 'stand';
      p.charging = false;
      p.chargeT = 0;
      p.strideAcc = 0;
      p.peakSpeed = 0;
      p.peakAge = 0;
      if (p.lieT <= 0) {
        const gloves = this.keeping(p) ? cfg.keeper.diveRecoveryMul : 1;
        p.recoverT = cfg.contest.tackle.getUpSec * gloves;
        // The trap's whole life is over — nothing more will walk into it. `trapSprung` already
        // holds its final value (every tick it was still lying got one `resolveTraps` check), so
        // this is the one moment that knows for certain whether the bet paid off.
        if (!p.trapSprung) {
          this.contests.push({ kind: 'tackle-miss', player: p.id, victim: null, t: this.state.t });
        }
      }
      if (p.hasBall) this.placeCarriedBall(this.state, p);
      return;
    }

    // --- dive: a committed burst, then either lying down or an ordinary recovery ---
    if (p.diveT > 0) {
      p.diveT -= dt;
      p.vel = { x: p.diveDir.x * cfg.dive.speed, y: p.diveDir.y * cfg.dive.speed };
      if (p.diveT <= 0) {
        p.vel = v2();
        // The keeper is exempt from the trap, always — the concept is explicit that his dive is
        // a reflex for the ball, never a plan against a body ("никогда вратарю"), and a keeper
        // who spent the next 2 s lying on his own goal line after every save would make the save
        // worse than the shot: the rebound just walks in behind him. He gets the plain, short
        // recovery the mechanic used to give everybody, scaled by his own gloves knob.
        if (cfg.contest.tackle.enabled && !this.keeping(p)) {
          // The dash is over; the trap begins. Whether anybody ever walks into it is not decided
          // here — see `resolveTraps`, run once a tick for as long as `lieT` stays positive.
          p.lieT = cfg.contest.tackle.lieSec;
        } else {
          const gloves = this.keeping(p) ? cfg.keeper.diveRecoveryMul : 1;
          p.recoverT = cfg.dive.recoverySec * gloves;
        }
      }
    } else if (p.recoverT > 0) {
      p.recoverT -= dt;
      p.vel = v2();
    } else {
      if (intent.dive && !prev.dive && p.diveCd <= 0) {
        p.diveT = cfg.dive.durationSec;
        p.trapSprung = false;
        const tail = cfg.contest.tackle.enabled
          ? cfg.contest.tackle.lieSec + cfg.contest.tackle.getUpSec
          : cfg.dive.recoverySec;
        p.diveCd = this.keeping(p)
          ? cfg.dive.cooldownSec * cfg.keeper.diveCooldownMul + cfg.dive.durationSec
          : cfg.dive.cooldownSec + cfg.dive.durationSec + tail;
        const dir = len2(intent.move) > 1e-6 ? norm2(intent.move, p.aim) : clone2(p.aim);
        p.diveDir = dir;
        p.vel = { x: dir.x * cfg.dive.speed, y: dir.y * cfg.dive.speed };
        // The one sound a trap makes: committing to the dive. It is heard exactly like the old
        // attacking dive was — 11 m, the loudness table's row for it — and it is the whole of the
        // symmetry law's price here: the mark fades in a few seconds, so an opponent who was not
        // listening right then has to trust a stale memory of where it happened, not a live view.
        this.emit('dive', p.pos, p.id);
      } else {
        this.applyMovement(p, intent, dt);
      }
    }

    const before = clone2(p.pos);
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    confineBody(this.field, p.pos, p.vel, cfg.player.radius, this.creaseAccess(p));

    this.footsteps(p, dist2(before, p.pos), dt);

    // --- ping ---------------------------------------------------------------
    if (intent.ping && !prev.ping && p.pingCd <= 0) {
      p.pingCd = cfg.ping.cooldownSec;
      this.firePing(p);
      // The loudest sound in the game, and it carries the pinger's exact position. That is the
      // whole price of asking a question (concept, law 4).
      this.emit('sonar', p.pos, p.id);
    }

    // --- the shout ----------------------------------------------------------
    // The one deliberate noise in the game that carries no information about the ball: it says
    // "I am open". A team-mate hears who it was; everybody else hears a body, at 9 m, exactly
    // where it stood. That symmetry is the price, and it is the whole design of the mechanic.
    if (intent.call && !prev.call && p.callCd <= 0 && p.downT <= 0 && !p.hasBall) {
      p.callCd = cfg.player.callCooldownSec;
      this.emit('call', p.pos, p.id);
    }

    // --- throw: hold to wind up, release to let go ---------------------------
    if (p.hasBall) {
      if (intent.charge) {
        p.charging = true;
        p.chargeT += dt;
      } else if (p.charging) {
        this.releaseThrow(p);
      }
    } else {
      p.charging = false;
      p.chargeT = 0;
    }

    if (p.hasBall) this.placeCarriedBall(this.state, p);
  }

  private applyMovement(p: PlayerState, intent: Intent, dt: number): void {
    const cfg = this.config.player;
    // A hard bump takes the body's control away for a moment: no steering, only coasting to a
    // halt. This is the "сбивает темп" half of body contact — the loud half is the sound.
    const want = p.staggerT > 0 ? { x: 0, y: 0 } : intent.move;
    const wantLen = len2(want);
    const maxSpeed = intent.moveMode === 'run' ? cfg.runSpeed : cfg.walkSpeed;
    let target: Vec2;
    if (wantLen < 1e-6) {
      target = v2();
      p.move = 'stand';
    } else {
      const u = Math.min(1, wantLen);
      const dir = norm2(want, p.aim);
      target = { x: dir.x * maxSpeed * u, y: dir.y * maxSpeed * u };
      p.move = intent.moveMode === 'run' ? 'run' : 'walk';
    }
    const dvx = target.x - p.vel.x;
    const dvy = target.y - p.vel.y;
    const dvLen = Math.sqrt(dvx * dvx + dvy * dvy);
    const step = cfg.accel * dt;
    if (dvLen <= step || dvLen < 1e-9) {
      p.vel.x = target.x;
      p.vel.y = target.y;
    } else {
      p.vel.x += (dvx / dvLen) * step;
      p.vel.y += (dvy / dvLen) * step;
    }
  }

  /**
   * Footsteps and braking. Both are pure consequences of how the body moved — nothing here
   * knows about intent, so a body slammed to a stop by a wall is exactly as loud as one that
   * chose to stop (concept, law 3: every sound has a physical cause).
   */
  private footsteps(p: PlayerState, travelled: number, dt: number): void {
    const cfg = this.config.player;
    const speed = len2(p.vel);

    if (speed > 0.05 && p.diveT <= 0) {
      p.strideAcc += travelled;
      if (p.strideAcc >= cfg.strideLength) {
        p.strideAcc -= cfg.strideLength;
        p.move = speed > (cfg.walkSpeed + cfg.runSpeed) / 2 ? 'run' : 'walk';
        this.emit(p.move === 'run' ? 'step-run' : 'step-walk', p.pos, p.id);
      }
    } else {
      p.strideAcc = 0;
    }

    // Braking is louder than running: a sharp drop inside the window rings out.
    if (speed > p.peakSpeed) {
      p.peakSpeed = speed;
      p.peakAge = 0;
    } else {
      p.peakAge += dt;
      if (p.peakAge > cfg.brakeWindowSec) {
        p.peakSpeed = speed;
        p.peakAge = 0;
      }
    }
    // The self-readout: how loud this body is *right now*, which is a continuous quantity even
    // though the sounds it makes are discrete footfalls. The halo in the UI and the "silent
    // share" statistic both read this, so a body that is sprinting counts as loud on every tick,
    // not only on the ticks a foot happens to land.
    if (p.diveT > 0) {
      p.loudness = Math.max(p.loudness, this.config.loudness.dive);
    } else if (speed > 0.1) {
      const walkLoud = this.config.loudness['step-walk'];
      const runLoud = this.config.loudness['step-run'];
      const u = clamp((speed - cfg.walkSpeed) / Math.max(1e-6, cfg.runSpeed - cfg.walkSpeed), 0, 1);
      p.loudness = Math.max(p.loudness, speed <= cfg.walkSpeed ? walkLoud : lerp(walkLoud, runLoud, u));
    }

    if (p.brakeCd <= 0 && p.peakSpeed - speed >= cfg.brakeSpeedDrop) {
      p.brakeCd = cfg.brakeCooldownSec;
      p.peakSpeed = speed;
      p.peakAge = 0;
      if (speed > 1e-6) {
        p.dirRef = { x: p.vel.x / speed, y: p.vel.y / speed };
        p.dirRefNext = clone2(p.dirRef);
      }
      p.dirRefAge = 0;
      this.emit('brake', p.pos, p.id);
      return;
    }

    // A hard turn is as loud as a hard stop, and for the same physical reason: the feet have to
    // kill the old velocity before they can make the new one. The concept's loudness table says
    // "резкая смена направления / стоп" in one row; until now only the second half existed, so
    // a runner could switch direction at full speed in silence — and the feint, which is exactly
    // that manoeuvre, was only half as expensive as it is supposed to be.
    if (speed >= cfg.brakeTurnMinSpeed) {
      const dir = { x: p.vel.x / speed, y: p.vel.y / speed };
      // Two references, rotated every window, so the one being compared against is always
      // between one and two windows old. A single reference reset on a timer is phase-dependent:
      // if the reset happens to land in the middle of the turn, the comparison sees half of it
      // and a genuine ninety-degree cut goes out silently — which it did, on exactly the timing
      // this test uses.
      p.dirRefAge += dt;
      if (p.dirRefAge >= cfg.brakeTurnWindowSec) {
        p.dirRef = clone2(p.dirRefNext);
        p.dirRefNext = dir;
        p.dirRefAge = 0;
      }
      if (p.brakeCd <= 0 && dot2(p.dirRef, dir) < cfg.brakeTurnCos) {
        p.brakeCd = cfg.brakeCooldownSec;
        p.dirRef = dir;
        p.dirRefNext = dir;
        p.dirRefAge = 0;
        this.emit('brake', p.pos, p.id);
      }
    } else {
      p.dirRefAge = 0;
      if (speed > 1e-6) {
        p.dirRef = { x: p.vel.x / speed, y: p.vel.y / speed };
        p.dirRefNext = clone2(p.dirRef);
      }
    }
  }

  private releaseThrow(p: PlayerState): void {
    const cfg = this.config;
    const th = cfg.throwing;
    const t = p.chargeT;
    let speed: number;
    if (t < th.minCharge) {
      speed = lerp(th.weakSpeed, th.minSpeed, clamp(t / th.minCharge, 0, 1));
    } else {
      const u = clamp((t - th.minCharge) / (th.maxCharge - th.minCharge), 0, 1);
      speed = lerp(th.minSpeed, th.maxSpeed, u);
    }
    p.charging = false;
    p.chargeT = 0;
    p.hasBall = false;
    p.ballCd = cfg.catching.cooldownSec;

    const b = this.state.ball;
    const off = cfg.player.radius + cfg.ball.carryOffset;
    b.pos = v2(p.pos.x + p.aim.x * off, p.pos.y + p.aim.y * off);
    b.vel = v2(p.aim.x * speed, p.aim.y * speed);
    if (cfg.ball.inheritCarrierVelocity) {
      b.vel.x += p.vel.x;
      b.vel.y += p.vel.y;
    }
    b.carrier = null;
    b.lastToucher = p.id;
    b.lastThrower = p.id;
    b.lastThrowerTeam = p.team;
    // Players cannot enter a crease, so this is all but always true — it is checked anyway so
    // the rule survives whatever future mechanic does let a body in there.
    b.goalValid = !insideCrease(this.field, b.pos);
    this.emit('throw', b.pos, p.id);
  }

  // -- the fight for the ball ----------------------------------------------

  /**
   * Body contact.
   *
   * Two bodies stop occupying the same point, which is the whole mechanic: a silent defender
   * standing in a corridor is now a wall rather than a rumour, and that is the cheapest way to
   * make "where is he" a question worth paying for. A hard bump is loud (both bodies ring out
   * where they touched) and staggers both — but it does NOT decide who keeps the ball
   * (`col.dropsBall` stays off by default; taking the ball off a carrier by touching him is not a
   * thing this game does, see `TackleConfig`'s comment).
   *
   * What it does decide, since 2026-08-25, is who keeps the GROUND. `carrierYieldShare` splits
   * the overlap and the stopping impulse unevenly whenever exactly one of the two bodies is
   * holding the ball: the carrier absorbs almost all of it, the defender almost none. Plant
   * yourself in a corridor and a carrier who walks into you does not push you aside — he is the
   * one who gets pushed, for as long as you hold the spot. That is the без-судьи version of a
   * foul: nobody can rule it, so the physics itself never lets the carrier win the exchange.
   */
  private resolveCollisions(): void {
    const col = this.config.contest.collision;
    if (!col.enabled) return;
    const s = this.state;
    const R = this.config.player.radius;
    const minGap = R * 2;
    for (let i = 0; i < s.players.length; i++) {
      const a = s.players[i]!;
      for (let j = i + 1; j < s.players.length; j++) {
        const b = s.players[j]!;
        const aImmobile = a.downT > 0 || a.lieT > 0;
        const bImmobile = b.downT > 0 || b.lieT > 0;
        if (aImmobile && bImmobile) continue;
        let dx = b.pos.x - a.pos.x;
        let dy = b.pos.y - a.pos.y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d >= minGap) continue;
        if (d < 1e-6) {
          // Exactly coincident: separate along a fixed axis rather than dividing by zero. It has
          // to be deterministic, so it cannot be a random direction.
          dx = 1;
          dy = 0;
          d = 1;
        }
        const nx = dx / d;
        const ny = dy / d;
        const overlap = minGap - d;
        // A body on the floor (down or lying as a trap) is furniture: it gets pushed by nobody
        // and pushes nobody aside. Otherwise, unless this is a fight over a ball one side is
        // holding, the two split the overlap evenly, same as always.
        const aMoves = !aImmobile;
        const bMoves = !bImmobile;
        let shareA = 0.5;
        let shareB = 0.5;
        if (!aMoves) {
          shareA = 0;
          shareB = 1;
        } else if (!bMoves) {
          shareA = 1;
          shareB = 0;
        } else if (a.hasBall !== b.hasBall) {
          const yield_ = clamp(col.carrierYieldShare, 0, 1);
          shareA = a.hasBall ? yield_ : 1 - yield_;
          shareB = b.hasBall ? yield_ : 1 - yield_;
          // "Somebody is holding my ground for me" — felt through the arms, not the ears, so it
          // is proprioception and can be published honestly regardless of whether either body
          // could actually place the other by sound right now.
          if (a.hasBall) a.pinned = true;
          else b.pinned = true;
        }
        if (aMoves) {
          a.pos.x -= nx * overlap * shareA;
          a.pos.y -= ny * overlap * shareA;
        }
        if (bMoves) {
          b.pos.x += nx * overlap * shareB;
          b.pos.y += ny * overlap * shareB;
        }
        const closing = (a.vel.x - b.vel.x) * nx + (a.vel.y - b.vel.y) * ny;
        if (closing > 0) {
          const impBase = closing * (1 + col.restitution);
          if (aMoves) {
            a.vel.x -= nx * impBase * shareA;
            a.vel.y -= ny * impBase * shareA;
          }
          if (bMoves) {
            b.vel.x += nx * impBase * shareB;
            b.vel.y += ny * impBase * shareB;
          }
        }
        confineBody(this.field, a.pos, a.vel, R, this.creaseAccess(a));
        confineBody(this.field, b.pos, b.vel, R, this.creaseAccess(b));
        if (closing < col.loudSpeed) continue;
        // Hard enough to hear. Both bodies made the noise, so both are drawn on both screens —
        // a collision is the one event in the game that gives away two positions at once.
        this.emit('brake', a.pos, a.id);
        this.emit('brake', b.pos, b.id);
        a.staggerT = Math.max(a.staggerT, col.staggerSec);
        b.staggerT = Math.max(b.staggerT, col.staggerSec);
        this.contests.push({ kind: 'collision', player: a.id, victim: b.id, t: s.t });
        if (col.dropsBall) {
          if (a.hasBall) this.knockBallLoose(a, { x: -nx, y: -ny });
          else if (b.hasBall) this.knockBallLoose(b, { x: nx, y: ny });
        }
      }
    }
  }

  /**
   * The trap: a bet on where somebody is going to run, not on where he is now.
   *
   * This is the mechanic the whole information economy hangs on, and it changed shape on
   * 2026-08-25 without changing its point: hearing where an opponent *is* is worth little, and a
   * dive has to be aimed where he *will be* 0.4 s from now, which is the only question in the game
   * whose answer has to be predicted rather than observed. What changed is who does the hitting.
   * A lying body (`lieT > 0`) does not reach for anybody — it is `resolveCollisions`, run first
   * every tick, that already stops another body walking through it. This function only asks: did
   * an opponent's own legs carry him into a body that was not going to move? If so, it is his
   * fall, not the trapper's blow, and the ball goes with him if he was holding it.
   */
  private resolveTraps(): void {
    const tk = this.config.contest.tackle;
    if (!tk.enabled) return;
    const s = this.state;
    const R = this.config.player.radius;
    for (const trap of s.players) {
      if (trap.lieT <= 0) continue;
      for (const other of s.players) {
        if (other.team === trap.team || other.downT > 0 || other.lieT > 0) continue;
        if (dist2(trap.pos, other.pos) > tk.radius + R) continue;
        trap.trapSprung = true;
        other.downT = tk.stumbleSec;
        other.staggerT = 0;
        const away = norm2({ x: other.pos.x - trap.pos.x, y: other.pos.y - trap.pos.y }, other.aim);
        // The thud, from the man who went down. Louder than a run, quieter than the fumble that
        // follows if he was carrying — a mistake still costs more than a stumble.
        this.emit('brake', other.pos, other.id);
        if (other.hasBall && tk.dropsBall) this.knockBallLoose(other, away);
        this.contests.push({ kind: 'tackle', player: trap.id, victim: other.id, t: s.t });
      }
    }
  }

  /**
   * The steal: stay close to the carrier long enough and the ball is yours.
   *
   * The cheapest possible version of "the carrier is hunted", and the reason it is worth having
   * is asymmetry rather than the steal itself: the carrier hums across the whole pitch, so a
   * hunter always knows where to go, while the carrier has to *find* his hunters — with hearing
   * he is drowning out himself, or with a ping he can afford because he is audible anyway.
   */
  private resolveSteals(intents: readonly Intent[], dt: number): void {
    const st = this.config.contest.steal;
    const s = this.state;
    const b = s.ball;
    if (!st.enabled || b.carrier === null || s.phase !== 'play') {
      if (!st.enabled) return;
      for (const p of s.players) {
        p.contestT = 0;
        p.contestTarget = null;
      }
      return;
    }
    const holder = s.players[b.carrier]!;
    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i]!;
      if (p.team === holder.team || p.downT > 0) {
        p.contestT = 0;
        p.contestTarget = null;
        continue;
      }
      if (p.contestTarget !== holder.id) {
        p.contestTarget = holder.id;
        p.contestT = 0;
      }
      const intent = intents[i] ?? idleIntentInternal();
      const close = dist2(p.pos, holder.pos) <= st.radius + this.config.player.radius;
      const fast = st.minSpeed <= 0 || len2(p.vel) >= st.minSpeed;
      const pressing = !st.requirePress || intent.catch;
      if (!close || !fast || !pressing) {
        p.contestT = 0;
        continue;
      }
      p.contestT += dt;
      if (p.contestT < st.holdSec) continue;
      if (p.robbedCd > 0 || holder.robbedCd > 0) continue;
      p.contestT = 0;
      p.robbedCd = st.graceSec;
      holder.robbedCd = st.graceSec;
      this.contests.push({ kind: 'steal', player: p.id, victim: holder.id, t: s.t });
      if (st.knockLoose) {
        this.knockBallLoose(holder, norm2({ x: holder.pos.x - p.pos.x, y: holder.pos.y - p.pos.y }, holder.aim));
        return;
      }
      holder.hasBall = false;
      holder.charging = false;
      holder.chargeT = 0;
      holder.ballCd = this.config.catching.cooldownSec;
      p.hasBall = true;
      p.ballCd = 0;
      b.carrier = p.id;
      b.vel = v2();
      b.lastToucher = p.id;
      b.lastThrower = null;
      b.lastThrowerTeam = null;
      b.goalValid = false;
      b.carryT = 0;
      b.voiceT = 0;
      this.placeCarriedBall(s, p);
      // The scuffle of the ball changing hands, and it carries further than a catch does: every
      // change of possession has to be audible, or the pitch's one shared fact — where the ball
      // is — quietly stops meaning what everybody thinks it means.
      this.emit('steal', p.pos, p.id);
      this.touches.push({ kind: 'catch', player: p.id, fromThrower: null, fromTeam: null });
      return;
    }
  }

  /** Takes the ball out of a carrier's hands and puts it on the floor, loudly. */
  private knockBallLoose(p: PlayerState, dir: Vec2): void {
    const cfg = this.config;
    const b = this.state.ball;
    const away = norm2(dir, p.aim);
    const speed = cfg.catching.fumbleSpeed * (0.5 + 0.5 * this.rng());
    p.hasBall = false;
    p.charging = false;
    p.chargeT = 0;
    p.ballCd = cfg.catching.cooldownSec;
    b.carrier = null;
    b.pos = {
      x: p.pos.x + away.x * (cfg.player.radius + cfg.ball.radius + 0.02),
      y: p.pos.y + away.y * (cfg.player.radius + cfg.ball.radius + 0.02),
    };
    b.vel = { x: away.x * speed, y: away.y * speed };
    b.lastToucher = p.id;
    b.lastThrower = null;
    b.lastThrowerTeam = null;
    b.goalValid = !insideCrease(this.field, b.pos);
    b.inCreaseT = 0;
    b.carryT = 0;
    b.voiceT = 0;
    this.touches.push({ kind: 'fumble', player: p.id, fromThrower: null, fromTeam: null });
    this.emit('fumble', p.pos, p.id);
  }

  // -- ball ----------------------------------------------------------------

  private stepBall(dt: number): void {
    const cfg = this.config;
    const b = this.state.ball;
    if (b.carrier !== null) return;

    const speed = len2(b.vel);
    if (speed > 0) {
      const drop = cfg.ball.friction * dt;
      const next = Math.max(0, speed - drop);
      if (next <= cfg.ball.restSpeed) {
        b.vel = v2();
      } else {
        b.vel.x = (b.vel.x / speed) * next;
        b.vel.y = (b.vel.y / speed) * next;
      }
    }

    let remaining = dt;
    const f = this.field;
    const r = cfg.ball.radius;

    // Walk the tick in segments so a fast ball reflects properly instead of tunnelling.
    for (let guard = 0; guard < 4 && remaining > 1e-9; guard++) {
      const nx = b.pos.x + b.vel.x * remaining;
      const ny = b.pos.y + b.vel.y * remaining;

      // Goal first: the mouth is a hole in the wall, not a wall.
      const goal = this.goalCrossing(b.pos, { x: nx, y: ny });
      if (goal) {
        b.pos = goal.pos;
        if (goal.valid) this.scoreGoal(goal.team);
        // A ball that goes in without a valid release is not a goal — but it is still out of
        // the world, and there is no wall behind the net to bring it back. It becomes the
        // defending team's throw, exactly like a ball that dies inside the crease.
        else this.deadBall(goal.team === 0 ? 1 : 0);
        return;
      }

      let hit: { u: number; axis: 'x' | 'y'; at: Vec2 } | null = null;
      const limX = f.halfWidth - r;
      const limY = f.halfHeight - r;
      const consider = (u: number, axis: 'x' | 'y') => {
        if (u < 0 || u > 1) return;
        if (!hit || u < hit.u) {
          hit = { u, axis, at: { x: b.pos.x + (nx - b.pos.x) * u, y: b.pos.y + (ny - b.pos.y) * u } };
        }
      };
      if (nx < -limX) consider((-limX - b.pos.x) / (nx - b.pos.x), 'x');
      if (nx > limX) consider((limX - b.pos.x) / (nx - b.pos.x), 'x');
      if (ny < -limY) consider((-limY - b.pos.y) / (ny - b.pos.y), 'y');
      if (ny > limY) consider((limY - b.pos.y) / (ny - b.pos.y), 'y');

      if (!hit) {
        b.pos.x = nx;
        b.pos.y = ny;
        break;
      }
      const h = hit as { u: number; axis: 'x' | 'y'; at: Vec2 };
      // Inside the mouth the short wall does not exist; let it fly to the goal line.
      if (h.axis === 'x' && inGoalMouth(f, h.at.y)) {
        b.pos.x = nx;
        b.pos.y = ny;
        break;
      }
      b.pos = h.at;
      if (h.axis === 'x') b.vel.x = -b.vel.x * cfg.field.wallRestitution;
      else b.vel.y = -b.vel.y * cfg.field.wallRestitution;
      this.emit('ball-wall', b.pos, BALL_ID);
      remaining *= 1 - h.u;
    }
  }

  /**
   * The carried ball's beep.
   *
   * Silent for `voice.quietSec` after it changes hands, then a beep whose period falls and whose
   * audible radius rises with `ball.carryT`. Nothing else in the game pressures a carrier: he is
   * not slowed down and the ball has no weight (concept law 5). He is simply, audibly, running
   * out of anonymity — and so is anybody he passes to, from zero.
   */
  private ballVoice(dt: number): void {
    const s = this.state;
    const b = s.ball;
    if (b.carrier === null || s.phase !== 'play') {
      b.voiceT = 0;
      return;
    }
    const v = this.config.ball.voice;
    const carrier = s.players[b.carrier];
    if (!carrier) return;
    const held = b.carryT;
    if (held < v.quietSec) {
      // The window a pass buys. The carrier makes his own footstep noise and nothing else.
      b.voiceT = 0;
      return;
    }
    const u = clamp((held - v.quietSec) / Math.max(1e-6, v.rampSec), 0, 1);
    const full = this.config.loudness['ball-carry'];
    const intensity = lerp(full * v.startLoudFrac, full, u);
    const interval = lerp(v.intervalStart, v.intervalMin, u);
    // The carrier's own readout is continuous even though the sound is not: he can feel how
    // loud the thing in his hands has become, which is the whole point of the mechanic.
    carrier.loudness = Math.max(carrier.loudness, intensity);
    b.voiceT += dt;
    if (b.voiceT < interval) return;
    b.voiceT -= interval;
    this.emitAt('ball-carry', b.pos, b.carrier, intensity);
  }

  /** The passivity rule (off unless `match.carryTimeoutSec` is set). See the config comment. */
  private checkPassivity(dt: number): void {
    const limit = this.config.match.carryTimeoutSec;
    const s = this.state;
    const b = s.ball;
    if (b.carrier === null || s.phase !== 'play') {
      b.carryT = 0;
      return;
    }
    b.carryT += dt;
    if (limit <= 0 || b.carryT < limit) return;
    const holder = s.players[b.carrier]!;
    let best: PlayerState | null = null;
    let bestD = Infinity;
    for (const p of s.players) {
      if (p.team === holder.team) continue;
      const d = dist2(p.pos, holder.pos);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    b.carryT = 0;
    if (!best) return;
    holder.hasBall = false;
    holder.charging = false;
    holder.chargeT = 0;
    best.hasBall = true;
    best.ballCd = 0;
    b.carrier = best.id;
    b.vel = v2();
    b.lastToucher = best.id;
    b.lastThrower = null;
    b.lastThrowerTeam = null;
    b.goalValid = false;
    b.voiceT = 0;
    this.placeCarriedBall(s, best);
    this.turnovers.push({ team: best.team, reason: 'passivity', t: s.t });
    this.emit('whistle', b.pos, best.id);
  }

  /**
   * The goalkeeper throw. A crease is a place nobody may stand, so a ball that comes to rest in
   * one is a dead match; after a moment it goes to the defending team, whose player nearest its
   * own goal picks it up. Whistled, so everyone hears it happen.
   */
  private checkCreaseBall(dt: number): void {
    const s = this.state;
    const b = s.ball;
    if (b.carrier !== null || s.phase !== 'play') {
      b.inCreaseT = 0;
      return;
    }
    if (!insideCrease(this.field, b.pos)) {
      b.inCreaseT = 0;
      return;
    }
    b.inCreaseT += dt;
    if (b.inCreaseT < this.config.field.creaseBallTimeoutSec) return;

    const goal0 = dist2(b.pos, this.field.goalCentre[0]);
    const goal1 = dist2(b.pos, this.field.goalCentre[1]);
    b.inCreaseT = 0;
    this.giveTo(goal0 < goal1 ? 0 : 1, 'crease');
  }

  /**
   * Hands the ball to the team defending `team`'s goal — its player nearest that goal picks it
   * up, and the whistle tells everyone it happened. Used by the crease rule and by a ball that
   * left the pitch through a goal mouth without a valid release.
   */
  private deadBall(team: TeamId): void {
    this.giveTo(team, 'crease');
  }

  private giveTo(team: TeamId, reason: 'crease' | 'passivity'): void {
    const s = this.state;
    const b = s.ball;
    const own = this.field.goalCentre[team];
    let best: PlayerState | null = null;
    let bestD = Infinity;
    for (const p of s.players) {
      if (p.team !== team) continue;
      const d = dist2(p.pos, own);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return;
    for (const p of s.players) {
      p.hasBall = false;
      p.charging = false;
      p.chargeT = 0;
    }
    best.hasBall = true;
    best.ballCd = 0;
    b.carrier = best.id;
    b.vel = v2();
    b.lastToucher = best.id;
    b.lastThrower = null;
    b.lastThrowerTeam = null;
    b.goalValid = false;
    b.inCreaseT = 0;
    b.carryT = 0;
    b.voiceT = 0;
    this.placeCarriedBall(s, best);
    this.turnovers.push({ team, reason, t: s.t });
    this.emit('whistle', b.pos, best.id);
  }

  /** Returns the goal that a segment crosses, if any. Team = whoever gets the point. */
  private goalCrossing(a: Vec2, bPos: Vec2): { team: TeamId; pos: Vec2; valid: boolean } | null {
    const f = this.field;
    for (const side of [-1, 1] as const) {
      const line = side * f.halfWidth;
      const crossed = side < 0 ? a.x > line && bPos.x <= line : a.x < line && bPos.x >= line;
      if (!crossed) continue;
      const denom = bPos.x - a.x;
      if (Math.abs(denom) < 1e-9) continue;
      const u = (line - a.x) / denom;
      const y = a.y + (bPos.y - a.y) * u;
      if (Math.abs(y) > f.goalWidth / 2) continue;
      // The ball went in at x = -half → the team attacking -x (team 1) scores.
      return { team: side < 0 ? 1 : 0, pos: { x: line, y }, valid: this.state.ball.goalValid };
    }
    return null;
  }

  private scoreGoal(team: TeamId): void {
    const s = this.state;
    const b = s.ball;
    s.score[team] += 1;
    this.goals.push({ team, scorer: b.lastThrower, t: s.t });
    this.emit('whistle', b.pos, BALL_ID);
    const conceding: TeamId = team === 0 ? 1 : 0;
    s.restartTeam = conceding;
    this.layout(s, conceding);
    s.phase = 'restart';
    s.phaseT = this.config.match.restartDelaySec;
    this.checkClock();
  }

  /**
   * Catching, fumbling and blocking — all of the ways a body and the ball can meet.
   *
   * Catching is AUTOMATIC (`catching.auto`), which cancels the concept's "ловля — действие с
   * таймингом". The человек cancelled it himself after playing the build: a timing test on top
   * of a hearing test spent the game's spare button and its whole difficulty budget on the least
   * interesting decision in it.
   *
   * What carries the skill instead is `reachRadius`: the reach shrinks with the ball's relative
   * speed, so being in the right place is what catches a pass, and the only remaining way to
   * fumble one is to try to take it at a full sprint.
   */
  private resolveBallContacts(intents: readonly Intent[]): void {
    const cfg = this.config;
    const s = this.state;
    const b = s.ball;
    if (b.carrier !== null) return;

    const bodyR = cfg.player.radius + cfg.ball.radius;
    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i]!;
      if (p.ballCd > 0) continue;
      const intent = intents[i] ?? idleIntentInternal();
      // Flat on the floor you are out of the play entirely: the ball goes over you, and that is
      // the price of a dive that missed.
      if (p.downT > 0) continue;
      const prev = this.prevIntents[i] ?? idleIntentInternal();
      const rel = { x: b.pos.x - p.pos.x, y: b.pos.y - p.pos.y };
      const d = len2(rel);

      const relVel = { x: b.vel.x - p.vel.x, y: b.vel.y - p.vel.y };
      const relSpeed = len2(relVel);
      const reach = this.reachRadius(p, relSpeed);
      // The press still exists in the contract (a bot may use it to block), but nothing about
      // catching depends on it any more.
      const pressed = intent.catch && !prev.catch;
      const open = p.reachT > 0;
      if (open && d <= reach) p.reachSawBall = true;

      if (d <= reach && (cfg.catching.auto || open || pressed)) {
        // Running through a hard ball does not work, and it is the one failure left in catching:
        // a fumble you can see coming and prevent by slowing down.
        const sprinting = len2(p.vel) > cfg.catching.sprintSpeed && relSpeed > cfg.catching.sprintBallSpeed;
        if (sprinting) {
          p.lastCatchFail = 'sprint';
          p.lastCatchFailT = s.t;
          this.fumble(p, rel, d, 'contact');
          return;
        }
        b.carrier = p.id;
        b.lastToucher = p.id;
        // A new pair of hands starts from silence: this single line is what makes a pass worth
        // making rather than a rule to be obeyed.
        b.carryT = 0;
        b.voiceT = 0;
        p.hasBall = true;
        p.ballCd = 0;
        p.reachT = 0;
        p.reachSawBall = false;
        p.lastCatchFail = null;
        this.placeCarriedBall(s, p);
        this.touches.push({
          kind: 'catch',
          player: p.id,
          fromThrower: b.lastThrower,
          fromTeam: b.lastThrowerTeam,
        });
        this.noteSave(p, b.lastThrowerTeam, relSpeed);
        b.lastThrower = null;
        b.lastThrowerTeam = null;
        this.emit('catch', p.pos, p.id);
        return;
      }

      if (d <= bodyR && relSpeed >= cfg.catching.contactFumbleMinSpeed) {
        if (this.stopsBall(p, relSpeed)) {
          this.noteSave(p, b.lastThrowerTeam, relSpeed);
          // Hit by a ball too fast to hold: a deflection, and everyone hears the mistake.
          p.lastCatchFail = 'late';
          p.lastCatchFailT = s.t;
          this.fumble(p, rel, d, 'contact');
          return;
        }
        // It went past him — through the gap between his hands, which at this speed is most of
        // his body. Not silent: a punishment nobody can perceive is indistinguishable from a bug.
        p.ballCd = cfg.catching.cooldownSec;
        p.lastCatchFail = 'past';
        p.lastCatchFailT = s.t;
        this.emit('ball-near', p.pos, BALL_ID);
        this.contests.push({ kind: 'through', player: p.id, victim: null, t: s.t });
        continue;
      }
    }
  }

  /**
   * A shot that died on the keeper. Counted, not simulated: the stop itself already happened
   * through the ordinary catch/block rules — a keeper has no special power over a ball, only a
   * place to stand and slightly longer arms.
   */
  private noteSave(p: PlayerState, fromTeam: TeamId | null, relSpeed: number): void {
    if (!this.keeping(p)) return;
    if (fromTeam === null || fromTeam === p.team) return;
    if (relSpeed < this.config.catching.slowBallSpeed) return;
    this.contests.push({ kind: 'save', player: p.id, victim: null, t: this.state.t });
  }

  /**
   * Does this body stop a ball it did not catch?
   *
   * Under the old rule it always did, and that is why two parked defenders were unbeatable: a
   * body on the shot line was a guaranteed turnover whatever the shot, so the correct defence
   * was to stand still and the correct attack was nothing at all. Under `'speed'` a hard throw
   * is likely to go straight past a body that was not reaching for it, and a body that *was* —
   * pressing catch, or committed to a dive — still stops everything. Blocking becomes an action
   * with a cost instead of a piece of scenery.
   */
  private stopsBall(p: PlayerState, relSpeed: number): boolean {
    const blk = this.config.contest.block;
    if (blk.mode === 'always') return true;
    // Hands open, or a body committed to a dive: he reached for it, so he gets it.
    if (blk.activeAlwaysStops && (p.reachT > 0 || p.diveT > 0)) return true;
    const over = relSpeed - this.config.catching.contactFumbleMinSpeed;
    const pStop = clamp(1 - over / Math.max(1e-6, blk.speedSpan), blk.minStop, 1);
    if (pStop >= 1) return true;
    const stopped = this.rng() < pStop;
    if (stopped) this.contests.push({ kind: 'block', player: p.id, victim: null, t: this.state.t });
    return stopped;
  }

  private fumble(p: PlayerState, rel: Vec2, d: number, _why: 'mistimed' | 'contact'): void {
    const cfg = this.config;
    const b = this.state.ball;
    const away = d > 1e-6 ? { x: rel.x / d, y: rel.y / d } : { x: p.aim.x, y: p.aim.y };
    const scattered = scatterDir(away, (this.rng() * 2 - 1) * cfg.catching.fumbleScatter);
    const speed = cfg.catching.fumbleSpeed * (0.7 + 0.6 * this.rng());
    b.pos = {
      x: p.pos.x + scattered.x * (cfg.player.radius + cfg.ball.radius + 0.02),
      y: p.pos.y + scattered.y * (cfg.player.radius + cfg.ball.radius + 0.02),
    };
    b.vel = { x: scattered.x * speed, y: scattered.y * speed };
    b.carrier = null;
    b.lastToucher = p.id;
    b.goalValid = !insideCrease(this.field, b.pos);
    b.inCreaseT = 0;
    p.ballCd = cfg.catching.cooldownSec;
    p.hasBall = false;
    this.touches.push({
      kind: 'fumble',
      player: p.id,
      fromThrower: b.lastThrower,
      fromTeam: b.lastThrowerTeam,
    });
    this.emit('fumble', p.pos, p.id);
  }

  // -- sonar ---------------------------------------------------------------

  private firePing(p: PlayerState): void {
    const cfg = this.config.ping;
    const geom: { pos: Vec2; kind: 'wall' | 'crease' }[] = [];
    sampleGeometry(this.field, p.pos, cfg.range, cfg.wallSampleStep, geom);
    const withDist = geom.map((g) => ({ ...g, d: dist2(p.pos, g.pos) }));
    withDist.sort((a, b) => (a.d === b.d ? cmpVec(a.pos, b.pos) : a.d - b.d));
    // 360° needs no trigonometry at all; a narrower cone computes its cosine once, here, and
    // never again — the per-tick path stays transcendental-free.
    const cosHalf = cfg.coneDeg >= 360 ? -1 : Math.cos((cfg.coneDeg / 2) * (Math.PI / 180));
    this.state.pings.push({
      id: this.state.nextPingId++,
      owner: p.id,
      origin: clone2(p.pos),
      aim: clone2(p.aim),
      cosHalf,
      t: this.state.t,
      radius: 0,
      geometry: withDist,
      geomCursor: 0,
      litBodies: new Set<EntityId>(),
    });
  }

  /**
   * Moves every live front forward by one tick and reports what it lit up on the way.
   *
   * Bodies are sampled at the moment the front reaches them, not at the moment the ping was
   * fired — so something fast really can outrun a ping, and a ping fired at a runner comes back
   * pointing slightly behind him.
   */
  private advancePings(dt: number): void {
    const cfg = this.config.ping;
    const s = this.state;
    if (s.pings.length === 0) return;
    const speed = cfg.waveSpeed;
    const keep: PendingPing[] = [];
    for (const ping of s.pings) {
      const prevR = ping.radius;
      const nextR = speed === Infinity ? cfg.range : Math.min(cfg.range, prevR + speed * dt);
      ping.radius = nextR;
      const hits: SonarHit[] = [];

      while (ping.geomCursor < ping.geometry.length) {
        const g = ping.geometry[ping.geomCursor]!;
        if (g.d > nextR) break;
        ping.geomCursor++;
        if (inCone(ping, g.pos)) hits.push({ pos: clone2(g.pos), kind: g.kind, sourceId: null, vel: null });
      }

      for (const other of s.players) {
        if (other.id === ping.owner || ping.litBodies.has(other.id)) continue;
        const d = dist2(ping.origin, other.pos);
        if (d > nextR || d <= prevR - 1e-9) continue;
        if (!inCone(ping, other.pos)) continue;
        ping.litBodies.add(other.id);
        hits.push({
          pos: clone2(other.pos),
          kind: 'player',
          sourceId: other.id,
          vel: clone2(other.vel),
        });
      }
      if (!ping.litBodies.has(BALL_ID)) {
        const d = dist2(ping.origin, s.ball.pos);
        if (d <= nextR && inCone(ping, s.ball.pos)) {
          ping.litBodies.add(BALL_ID);
          hits.push({
            pos: clone2(s.ball.pos),
            kind: 'ball',
            sourceId: BALL_ID,
            vel: clone2(s.ball.vel),
          });
        }
      }

      const complete = nextR >= cfg.range - 1e-9 && ping.geomCursor >= ping.geometry.length;
      // A return is emitted on EVERY tick the front is alive, even when it found nothing. An
      // empty sweep is not an empty message: it is the statement "this annulus is clear", which
      // is the only way a belief can ever shrink.
      {
        this.sonar.push({
          owner: ping.owner,
          pingId: ping.id,
          t: ping.t,
          origin: clone2(ping.origin),
          range: cfg.range,
          waveRadius: nextR,
          // The negative half of the answer: this tick's front swept the annulus prevR..nextR
          // inside the cone, and everything in it that was not reported was not there.
          sweptFrom: prevR,
          sweptTo: nextR,
          aim: clone2(ping.aim),
          coneCos: ping.cosHalf,
          hits,
          complete,
        });
      }
      if (!complete) keep.push(ping);
    }
    s.pings = keep;
  }

  // -- determinism ---------------------------------------------------------

  /**
   * FNV-1a over the raw bits of every number in the world state.
   *
   * Raw bits, not rounded values: the point of the hash is to catch a divergence of one ulp
   * before it grows into a different match, and a hash that rounds first would hide exactly the
   * bug it exists to find.
   */
  hash(): number {
    const nums: number[] = [];
    const s = this.state;
    nums.push(s.tick, s.t, s.phase === 'play' ? 1 : s.phase === 'restart' ? 2 : 3, s.phaseT);
    nums.push(s.score[0], s.score[1], s.restartTeam, s.nextPingId, s.pings.length);
    for (const p of s.players) {
      nums.push(
        p.id, p.team, p.pos.x, p.pos.y, p.vel.x, p.vel.y, p.aim.x, p.aim.y,
        p.hasBall ? 1 : 0, p.charging ? 1 : 0, p.chargeT, p.diveT, p.recoverT, p.diveCd,
        p.pingCd, p.ballCd, p.callCd, p.strideAcc, p.brakeCd, p.peakSpeed, p.peakAge, p.loudness,
        p.dirRef.x, p.dirRef.y, p.dirRefNext.x, p.dirRefNext.y, p.dirRefAge, p.downT, p.lieT, p.staggerT, p.contestT,
        p.contestTarget ?? -99, p.robbedCd, p.trapSprung ? 1 : 0, p.reachT, p.reachCd,
        p.keeper ? 1 : 0, p.pinned ? 1 : 0,
      );
    }
    const b = s.ball;
    nums.push(
      b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.carrier ?? -99, b.lastToucher ?? -99,
      b.lastThrower ?? -99, b.goalValid ? 1 : 0, b.inCreaseT, b.carryT, b.voiceT,
    );
    return hashNumbers(nums);
  }
}

/** 0 or 1 from a seed — used only to decide who kicks off when the config asks for it. */
function seedParity(seed: number): number {
  return (seed >>> 0) & 1;
}

function cmpVec(a: Vec2, b: Vec2): number {
  return a.x === b.x ? a.y - b.y : a.x - b.x;
}

function inCone(ping: PendingPing, p: Vec2): boolean {
  if (ping.cosHalf <= -1) return true;
  const dx = p.x - ping.origin.x;
  const dy = p.y - ping.origin.y;
  const l = Math.sqrt(dx * dx + dy * dy);
  if (l < 1e-6) return true;
  return dot2({ x: dx / l, y: dy / l }, ping.aim) >= ping.cosHalf;
}

/** Hashes an array of doubles by their bytes. Exported so replays and tests can hash anything. */
export function hashNumbers(nums: readonly number[]): number {
  const buf = new Float64Array(nums.length);
  for (let i = 0; i < nums.length; i++) buf[i] = nums[i]!;
  const bytes = new Uint8Array(buf.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function idleIntentInternal(): Intent {
  return {
    move: { x: 0, y: 0 },
    moveMode: 'walk',
    aim: { x: 0, y: 0 },
    ping: false,
    charge: false,
    catch: false,
    dive: false,
    call: false,
  };
}

function copyIntent(i: Intent): Intent {
  return {
    move: { x: i.move.x, y: i.move.y },
    moveMode: i.moveMode,
    aim: { x: i.aim.x, y: i.aim.y },
    ping: i.ping,
    charge: i.charge,
    catch: i.catch,
    dive: i.dive,
    call: i.call,
  };
}
