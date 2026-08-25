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
import { makeField, confineBody, insideCrease, sampleGeometry, inGoalMouth } from './field';
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
  /** > 0 while this body is on the ground after being tackled: silent-less, helpless, visible. */
  downT: number;
  /** > 0 while a hard collision has taken the body's control away. */
  staggerT: number;
  /** Seconds spent contesting the current carrier, and who that carrier is. */
  contestT: number;
  contestTarget: EntityId | null;
  /** Grace after a steal: this body can neither be robbed nor rob again until it expires. */
  robbedCd: number;
  /** Whether the dive in progress has already connected with somebody. */
  tackleHit: boolean;
  /** > 0 while the hands are open after a catch press. */
  reachT: number;
  /** Cooldown before the hands can be opened again. */
  reachCd: number;
  /** Whether the ball came inside reach during the current open window. */
  reachSawBall: boolean;
  /** Why the last attempt on the ball failed, and when — proprioception, published to the frame. */
  lastCatchFail: 'early' | 'late' | 'past' | null;
  lastCatchFailT: number;
  /** Audible radius of the loudest noise this body made this tick — the "am I loud" readout. */
  loudness: number;
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
  /** How long the current carrier has held it — see `match.carryTimeoutSec`. */
  carryT: number;
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

export type ContestKind = 'steal' | 'tackle' | 'tackle-miss' | 'collision' | 'block' | 'through';

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

  /** The continuous sources audible right now. The ball is the only one in v1. */
  emitters(): ContinuousEmitter[] {
    const b = this.state.ball;
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
        strideAcc: 0,
        brakeCd: 0,
        peakSpeed: 0,
        peakAge: 0,
        dirRef: v2(1, 0),
        dirRefNext: v2(1, 0),
        dirRefAge: 0,
        downT: 0,
        staggerT: 0,
        contestT: 0,
        contestTarget: null,
        robbedCd: 0,
        tackleHit: false,
        reachT: 0,
        reachCd: 0,
        reachSawBall: false,
        lastCatchFail: null,
        lastCatchFailT: -99,
        loudness: 0,
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
      p.strideAcc = 0;
      p.brakeCd = 0;
      p.peakSpeed = 0;
      p.peakAge = 0;
      p.dirRef = v2(p.team === 0 ? 1 : -1, 0);
      p.dirRefNext = clone2(p.dirRef);
      p.dirRefAge = 0;
      p.downT = 0;
      p.staggerT = 0;
      p.contestT = 0;
      p.contestTarget = null;
      p.robbedCd = 0;
      p.tackleHit = false;
      p.reachT = 0;
      p.reachCd = 0;
      p.reachSawBall = false;
      p.lastCatchFail = null;
      p.lastCatchFailT = -99;
      p.loudness = 0;
      confineBody(f, p.pos, p.vel, this.config.player.radius);
    }
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
      for (const p of s.players) p.loudness = p.hasBall ? cfg.loudness['ball-hum'] : 0;
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

    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i]!;
      const intent = intents[i] ?? idleIntentInternal();
      const prev = this.prevIntents[i] ?? idleIntentInternal();
      p.loudness = 0;
      this.stepPlayer(p, intent, prev, dt);
    }

    this.resolveCollisions();
    this.resolveTackles();
    this.stepBall(dt);
    this.resolveBallContacts(intents);
    this.resolveSteals(intents, dt);
    this.checkCreaseBall(dt);
    this.checkPassivity(dt);
    this.advancePings(dt);

    // The carried ball hums from the carrier's hands, so the carrier is as loud as the ball.
    for (const p of s.players) {
      if (p.hasBall) p.loudness = Math.max(p.loudness, cfg.loudness['ball-hum']);
    }

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

  private emit(kind: SoundKind, pos: Vec2, sourceId: EntityId): void {
    const intensity = this.config.loudness[kind];
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

    // --- flat on the ground: the price of being tackled, and of tackling nothing -----------
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

    // --- dive: a committed burst, then a helpless recovery -------------------
    if (p.diveT > 0) {
      p.diveT -= dt;
      p.vel = { x: p.diveDir.x * cfg.dive.speed, y: p.diveDir.y * cfg.dive.speed };
      if (p.diveT <= 0) {
        // A dive that hit nobody leaves you lying there longer — that is the bet the tackle is:
        // you spent your body on a prediction, and a wrong prediction costs time on the floor.
        const miss = p.tackleHit ? 1 : cfg.contest.tackle.enabled ? cfg.contest.tackle.missPenalty : 1;
        p.recoverT = cfg.dive.recoverySec * miss;
        if (!p.tackleHit && cfg.contest.tackle.enabled) {
          this.contests.push({ kind: 'tackle-miss', player: p.id, victim: null, t: this.state.t });
        }
        p.vel = v2();
      }
    } else if (p.recoverT > 0) {
      p.recoverT -= dt;
      p.vel = v2();
    } else {
      if (intent.dive && !prev.dive && p.diveCd <= 0) {
        p.diveT = cfg.dive.durationSec;
        p.tackleHit = false;
        p.diveCd = cfg.dive.cooldownSec + cfg.dive.durationSec + cfg.dive.recoverySec;
        const dir = len2(intent.move) > 1e-6 ? norm2(intent.move, p.aim) : clone2(p.aim);
        p.diveDir = dir;
        p.vel = { x: dir.x * cfg.dive.speed, y: dir.y * cfg.dive.speed };
        this.emit('dive', p.pos, p.id);
      } else {
        this.applyMovement(p, intent, dt);
      }
    }

    const before = clone2(p.pos);
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    confineBody(this.field, p.pos, p.vel, cfg.player.radius);

    this.footsteps(p, dist2(before, p.pos), dt);

    // --- ping ---------------------------------------------------------------
    if (intent.ping && !prev.ping && p.pingCd <= 0) {
      p.pingCd = cfg.ping.cooldownSec;
      this.firePing(p);
      // The loudest sound in the game, and it carries the pinger's exact position. That is the
      // whole price of asking a question (concept, law 4).
      this.emit('sonar', p.pos, p.id);
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
   * where they touched), staggers both, and knocks the ball out of a carrier's hands.
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
        if (a.downT > 0 && b.downT > 0) continue;
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
        // A body on the floor is furniture: it gets pushed by nobody and pushes nobody aside.
        const aMoves = a.downT <= 0;
        const bMoves = b.downT <= 0;
        const share = aMoves && bMoves ? 0.5 : 1;
        if (aMoves) {
          a.pos.x -= nx * overlap * share;
          a.pos.y -= ny * overlap * share;
        }
        if (bMoves) {
          b.pos.x += nx * overlap * share;
          b.pos.y += ny * overlap * share;
        }
        const closing = (a.vel.x - b.vel.x) * nx + (a.vel.y - b.vel.y) * ny;
        if (closing > 0) {
          const imp = closing * (1 + col.restitution) * share;
          if (aMoves) {
            a.vel.x -= nx * imp;
            a.vel.y -= ny * imp;
          }
          if (bMoves) {
            b.vel.x += nx * imp;
            b.vel.y += ny * imp;
          }
        }
        confineBody(this.field, a.pos, a.vel, R);
        confineBody(this.field, b.pos, b.vel, R);
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
   * The dive tackle: a bet on where somebody is going to be.
   *
   * This is the mechanic the whole information economy hangs on. Hearing where an opponent *is*
   * is worth little; a dive has to be aimed where he *will be* 0.4 s from now, which is the only
   * question in the game whose answer has to be predicted rather than observed. Hit and he is on
   * the floor for a second, noisy and useless. Miss and it is you.
   */
  private resolveTackles(): void {
    const tk = this.config.contest.tackle;
    if (!tk.enabled) return;
    const s = this.state;
    for (const diver of s.players) {
      if (diver.diveT <= 0 || diver.tackleHit) continue;
      for (const other of s.players) {
        if (other.team === diver.team || other.downT > 0) continue;
        if (dist2(diver.pos, other.pos) > tk.radius + this.config.player.radius) continue;
        diver.tackleHit = true;
        diver.diveT = 0;
        diver.recoverT = this.config.dive.recoverySec;
        diver.vel = v2();
        other.downT = tk.stunSec;
        other.staggerT = 0;
        const away = norm2({ x: other.pos.x - diver.pos.x, y: other.pos.y - diver.pos.y }, other.aim);
        // The thud, from the man who went down. Louder than a run, quieter than the fumble that
        // follows if he was carrying — a mistake still costs more than a hit.
        this.emit('brake', other.pos, other.id);
        if (other.hasBall && tk.dropsBall) this.knockBallLoose(other, away);
        this.contests.push({ kind: 'tackle', player: diver.id, victim: other.id, t: s.t });
        break;
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
   * Catching, fumbling and stealing — all of the ways a body and the ball can meet.
   *
   * A catch is a timed action, and the timing lives in `catching.reachSec`: one press opens the
   * hands for a fifth of a second, and the ball has to be inside `catching.radius` while they
   * are open. Press too early and they shut before it arrives; press too late and it hits a shut
   * body, which is a fumble — the loudest ordinary event in the game. Both halves of that are
   * reachable, which the previous rule (a window around the moment of closest approach) could
   * not manage: the ball met the body before the moment it was supposed to be timed against.
   *
   * A ball crawling along the floor is not a timing problem and is simply picked up.
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
      if (p.downT > 0) continue;
      const prev = this.prevIntents[i] ?? idleIntentInternal();
      const rel = { x: b.pos.x - p.pos.x, y: b.pos.y - p.pos.y };
      const d = len2(rel);

      const relVel = { x: b.vel.x - p.vel.x, y: b.vel.y - p.vel.y };
      const relSpeed = len2(relVel);
      const slow = relSpeed < cfg.catching.slowBallSpeed;
      const pressed = intent.catch && !prev.catch;
      const open = p.reachT > 0;
      if (open && d <= cfg.catching.radius) p.reachSawBall = true;

      if ((open || (pressed && slow)) && d <= cfg.catching.radius) {
        b.carrier = p.id;
        b.lastToucher = p.id;
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
        b.lastThrower = null;
        b.lastThrowerTeam = null;
        this.emit('catch', p.pos, p.id);
        return;
      }

      if (d <= bodyR && relSpeed >= cfg.catching.contactFumbleMinSpeed) {
        if (this.stopsBall(p, relSpeed)) {
          // Hit by a ball nobody caught: a deflection, and everyone hears the mistake.
          p.lastCatchFail = 'late';
          p.lastCatchFailT = s.t;
          this.fumble(p, rel, d, 'contact');
          return;
        }
        // It went past him. He cannot have a second bite at it — that is what "he did not time
        // it" has to mean if a block is a decision — but it is NOT silent: a punishment nobody
        // can perceive is indistinguishable from a bug, and this one lands on a player who just
        // pressed a button and got nothing. The ball whistles past, quietly, close by.
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
        p.pingCd, p.ballCd, p.strideAcc, p.brakeCd, p.peakSpeed, p.peakAge, p.loudness,
        p.dirRef.x, p.dirRef.y, p.dirRefNext.x, p.dirRefNext.y, p.dirRefAge, p.downT, p.staggerT, p.contestT,
        p.contestTarget ?? -99, p.robbedCd, p.tackleHit ? 1 : 0, p.reachT, p.reachCd,
      );
    }
    const b = s.ball;
    nums.push(
      b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.carrier ?? -99, b.lastToucher ?? -99,
      b.lastThrower ?? -99, b.goalValid ? 1 : 0, b.inCreaseT, b.carryT,
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
  };
}
