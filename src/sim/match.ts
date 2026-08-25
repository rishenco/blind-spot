/**
 * A match: the simulation, one `Perceiver` per player, one `Controller` per player, and the
 * bookkeeping that turns the whole thing into numbers and into a replay.
 *
 * The wiring is the point. Controllers are constructed here and are handed a
 * `ControllerContext` and, once a tick, a `PerceptionFrame`. They are never handed the
 * `Simulation`, the `WorldState` or their own `Perceiver`. Everything they can ever know went
 * through `perception.ts` first.
 *
 * Order inside a tick, and why:
 *   1. every controller returns an `Intent` based on the frame it got at the END of the previous
 *      tick — so a reaction is at best one tick old, exactly as it is for a human;
 *   2. the simulation advances and produces sounds;
 *   3. those sounds are run through each observer's ears (and, optionally, the team voice link);
 *   4. each controller receives its new frame.
 *
 * A replay is a re-simulation, not a recording of state: seed + config + controller names +
 * whatever intents came from outside (a human at a keyboard) reproduce the match exactly.
 */
import type { SimConfig } from './config';
import { cloneConfig, perceptionFor } from './config';
import { makeField } from './field';
import { dist2 } from './math';
import { Perceiver } from './perception';
import { Simulation, type StepOutput, type WorldView } from './sim';
import { emptyPlayerStats, emptyShapeStats, type MatchStats, type PlayerStats } from './stats';
import { makeRng } from '../core/rng';
import {
  idleIntent,
  type Controller,
  type ControllerContext,
  type EntityId,
  type FieldInfo,
  type Intent,
  type PerceptionFrame,
  type SoundEvent,
  type TeamId,
  type Vec2,
} from './types';

export type ControllerFactory = (ctx: ControllerContext) => Controller;

export interface MatchOptions {
  config: SimConfig;
  seed: number;
  /** One entry per player, in id order. Names are what a replay stores. */
  controllers: { name: string; make: ControllerFactory }[];
  /** Keep the full sound log for the debug timeline. Off in batch runs. */
  keepLog?: boolean;
}

/** One notable thing that happened, for the scrubber's timeline. */
export interface TimelineEntry {
  tick: number;
  t: number;
  kind: 'goal' | 'catch' | 'interception' | 'fumble' | 'throw' | 'ping' | 'restart' | 'contest';
  player: EntityId | null;
  team: TeamId | null;
  label: string;
}

export interface MatchResult {
  stats: MatchStats;
  winner: TeamId | null;
  timeline: TimelineEntry[];
}

export class Match {
  readonly sim: Simulation;
  readonly config: SimConfig;
  readonly field: FieldInfo;
  readonly controllers: Controller[] = [];
  readonly controllerNames: string[] = [];
  readonly stats: MatchStats;
  readonly timeline: TimelineEntry[] = [];
  /** Full sound log, only when `keepLog` is on. */
  readonly log: SoundEvent[] = [];

  private readonly perceivers: Perceiver[] = [];
  private readonly frames: PerceptionFrame[] = [];
  private readonly external: (Intent | null)[] = [];
  private readonly lastIntents: Intent[] = [];
  private readonly keepLog: boolean;
  /** Which team held the ball last, for the possession-change counter. */
  private lastOwner: TeamId | null = null;
  /** Who has the ball right now and since when — the clock behind "how long before he threw". */
  private heldBy: EntityId | null = null;
  private heldSince = 0;
  /** Passes completed inside the attack in progress. Zero here is what "гонка к мячу" looks like. */
  private possessionPasses = 0;
  private possessionStart = 0;

  constructor(opts: MatchOptions) {
    this.config = cloneConfig(opts.config);
    this.sim = new Simulation(this.config, opts.seed);
    this.field = makeField(this.config.field);
    this.keepLog = opts.keepLog ?? false;
    const n = this.sim.playerCount;
    if (opts.controllers.length !== n) {
      throw new Error(`need ${n} controllers, got ${opts.controllers.length}`);
    }
    this.stats = {
      seed: opts.seed,
      ticks: 0,
      duration: 0,
      score: [0, 0],
      players: [],
      possessionChanges: 0,
      shape: emptyShapeStats(),
    };
    for (let i = 0; i < n; i++) {
      const team: TeamId = i < this.config.teamSize ? 0 : 1;
      const perceiver = new Perceiver(i, this.config, opts.seed);
      this.perceivers.push(perceiver);
      const ctx: ControllerContext = {
        self: i,
        team,
        teammates: perceiver.teammates,
        opponents: perceiver.opponents,
        field: this.field,
        config: this.config,
        // A private stream per controller: two bots of the same kind must not share dice, and
        // adding a controller must not shift anybody else's.
        rng: makeRng((opts.seed ^ 0x5bf03635) + i * 0x27d4eb2f),
      };
      const spec = opts.controllers[i]!;
      const controller = spec.make(ctx);
      controller.reset?.(ctx);
      this.controllers.push(controller);
      this.controllerNames.push(spec.name);
      this.stats.players.push(emptyPlayerStats(i, team, spec.name));
      this.external.push(null);
      this.lastIntents.push(idleIntent());
    }
    // Everyone gets a frame before deciding anything, so tick 1 is not decided blind.
    this.distributeFrames({ events: [], touches: [], sonar: [], goals: [], turnovers: [] });
    this.lastOwner = this.sim.state.ball.carrier === null ? null : this.sim.teamOf(this.sim.state.ball.carrier);
    this.heldBy = this.sim.state.ball.carrier;
  }

  get view(): WorldView {
    return this.sim.state;
  }

  get isOver(): boolean {
    return this.sim.state.phase === 'over';
  }

  /** The frame player `id` received at the end of the last tick. For the debug views only. */
  frameOf(id: EntityId): PerceptionFrame | undefined {
    return this.frames[id];
  }

  intentOf(id: EntityId): Intent {
    return this.lastIntents[id] ?? idleIntent();
  }

  /**
   * Overrides one player's intent for the next tick (a human at the keyboard). Pass null to
   * hand control back to its controller.
   */
  setExternalIntent(id: EntityId, intent: Intent | null): void {
    this.external[id] = intent;
  }

  step(): StepOutput {
    const dt = this.config.dt;
    const intents: Intent[] = [];
    for (let i = 0; i < this.controllers.length; i++) {
      const ext = this.external[i];
      const intent = ext ?? this.controllers[i]!.decide(dt);
      intents.push(intent);
      this.lastIntents[i] = intent;
    }
    const out = this.sim.step(intents);
    this.accumulate(out);
    this.distributeFrames(out);
    return out;
  }

  /** Runs until the match ends. `maxTicks` is a safety net, not a rule. */
  run(maxTicks = 200000): MatchResult {
    while (!this.isOver && this.stats.ticks < maxTicks) this.step();
    return this.result();
  }

  result(): MatchResult {
    const s = this.sim.state;
    this.stats.score = [s.score[0], s.score[1]];
    this.stats.duration = s.t;
    const winner: TeamId | null =
      s.score[0] === s.score[1] ? null : s.score[0] > s.score[1] ? 0 : 1;
    return { stats: this.stats, winner, timeline: this.timeline };
  }

  // -- internals -----------------------------------------------------------

  private distributeFrames(out: StepOutput): void {
    const view = this.sim.state;
    const heard: ReturnType<Perceiver['hear']>[] = [];
    for (const p of this.perceivers) heard.push(p.hear(view, out.events));
    // The voice link is a per-team channel now that perception knobs can differ by team: one
    // side may be wired up and the other not.
    for (const p of this.perceivers) {
      if (!perceptionFor(this.config, p.team).teamShare) continue;
      for (const mate of p.teammates) p.relay(view, heard[mate] ?? []);
    }
    for (const ret of out.sonar) this.perceivers[ret.owner]?.receiveSonar(ret);
    for (let i = 0; i < this.perceivers.length; i++) {
      const frame = this.perceivers[i]!.frame(view, this.field);
      this.frames[i] = frame;
      const st = this.stats.players[i];
      if (st) st.heardEvents += frame.events.length;
      this.controllers[i]!.onPerceive?.(frame);
    }
  }

  private accumulate(out: StepOutput): void {
    const s = this.sim.state;
    const dt = this.config.dt;
    this.stats.ticks += 1;
    this.stats.duration = s.t;
    this.stats.score = [s.score[0], s.score[1]];

    if (this.keepLog) this.log.push(...out.events);

    for (const p of s.players) {
      const st = this.stats.players[p.id]!;
      st.ticks += 1;
      if (p.hasBall) st.possessionTicks += 1;
      if (p.loudness <= 0) st.silentTicks += 1;
      st.distanceToBallSum += dist2(p.pos, s.ball.pos);
      st.distanceRun += Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y) * dt;
    }

    for (const ev of out.events) {
      const st: PlayerStats | undefined = this.stats.players[ev.sourceId];
      if (!st) continue;
      if (ev.kind === 'sonar') {
        st.pings += 1;
        this.push(ev.tick, ev.t, 'ping', ev.sourceId, st.team, `ping by P${ev.sourceId}`);
      } else if (ev.kind === 'throw') {
        st.throws += 1;
        this.push(ev.tick, ev.t, 'throw', ev.sourceId, st.team, `throw by P${ev.sourceId}`);
      }
    }

    for (const touch of out.touches) {
      const st = this.stats.players[touch.player]!;
      if (touch.kind === 'fumble') {
        st.fumbles += 1;
        this.push(s.tick, s.t, 'fumble', touch.player, st.team, `fumble by P${touch.player}`);
        continue;
      }
      st.catches += 1;
      if (touch.fromTeam !== null && touch.fromTeam !== st.team) {
        st.interceptions += 1;
        this.push(
          s.tick, s.t, 'interception', touch.player, st.team,
          `P${touch.player} intercepts P${touch.fromThrower}`,
        );
      } else if (touch.fromThrower !== null && touch.fromThrower !== touch.player) {
        st.passesReceived += 1;
        this.push(
          s.tick, s.t, 'catch', touch.player, st.team,
          `P${touch.player} takes the pass from P${touch.fromThrower}`,
        );
      } else {
        this.push(s.tick, s.t, 'catch', touch.player, st.team, `P${touch.player} picks up`);
      }
    }

    this.trackShape(out);

    for (const contest of out.contests ?? []) {
      const st = this.stats.players[contest.player];
      const victim = contest.victim !== null ? this.stats.players[contest.victim] : undefined;
      switch (contest.kind) {
        case 'steal':
          if (st) st.steals += 1;
          if (victim) victim.robbed += 1;
          this.push(s.tick, contest.t, 'contest', contest.player, st?.team ?? null,
            `P${contest.player} strips P${contest.victim}`);
          break;
        case 'tackle':
          if (st) st.tackles += 1;
          if (victim) victim.tackled += 1;
          this.push(s.tick, contest.t, 'contest', contest.player, st?.team ?? null,
            `P${contest.player} tackles P${contest.victim}`);
          break;
        case 'tackle-miss':
          if (st) st.tackleMisses += 1;
          break;
        case 'collision':
          if (st) st.collisions += 1;
          if (victim) victim.collisions += 1;
          break;
        case 'through':
          if (st) st.ballsThrough += 1;
          break;
        case 'save':
          this.stats.shape.keeperSaves += 1;
          this.push(s.tick, contest.t, 'contest', contest.player, st?.team ?? null,
            `P${contest.player} saves`);
          break;
        default:
          break;
      }
    }

    for (const turnover of out.turnovers) {
      this.push(
        s.tick, turnover.t, 'restart', null, turnover.team,
        turnover.reason === 'crease'
          ? `crease ball — possession to team ${turnover.team}`
          : `passivity — possession to team ${turnover.team}`,
      );
    }

    for (const goal of out.goals) {
      if (goal.scorer !== null) {
        const st = this.stats.players[goal.scorer];
        if (st && st.team === goal.team) st.goals += 1;
      }
      this.push(
        s.tick, goal.t, 'goal', goal.scorer, goal.team,
        `GOAL team ${goal.team}${goal.scorer !== null ? ` (P${goal.scorer})` : ''} — ${s.score[0]}:${s.score[1]}`,
      );
    }
  }


  /**
   * The shape of the play: how an attack was built, not who won it.
   *
   * Everything here is read off events the simulation already produces — nothing new is emitted
   * for the sake of a statistic. A "shot" is decided geometrically (does the released ball's
   * line reach the opponent's goal mouth) rather than by asking a controller what it meant,
   * because a bot's intention is not a fact about the game and a human's is not available at all.
   */
  private trackShape(out: StepOutput): void {
    const s = this.sim.state;
    const shape = this.stats.shape;
    const f = this.field;

    for (const ev of out.events) {
      if (ev.kind !== 'throw') continue;
      const held = this.heldBy === ev.sourceId ? Math.max(0, s.t - this.heldSince) : 0;
      shape.throws += 1;
      shape.holdBeforeThrowSum += held;
      const team: TeamId = ev.sourceId < this.config.teamSize ? 0 : 1;
      if (this.aimedAtGoal(ev.pos, s.ball.vel, team) && !this.aimedAtMate(ev.sourceId, ev.pos, s.ball.vel)) {
        shape.shots += 1;
        shape.holdBeforeShotSum += held;
        const d = dist2(ev.pos, f.goalCentre[team === 0 ? 1 : 0]!);
        shape.shotDistanceSum += d;
        shape.shotDistances.push(d);
      }
    }

    for (const touch of out.touches) {
      if (touch.kind !== 'catch' || touch.fromThrower === null) continue;
      const team: TeamId = touch.player < this.config.teamSize ? 0 : 1;
      if (touch.fromTeam === team && touch.fromThrower !== touch.player) {
        this.possessionPasses += 1;
        shape.passes += 1;
      }
    }

    if (out.goals.length > 0) {
      shape.goals += out.goals.length;
      if (this.possessionPasses === 0) shape.goalsWithoutPass += out.goals.length;
    }

    const carrier = s.ball.carrier;
    if (carrier !== null) {
      const owner: TeamId = carrier < this.config.teamSize ? 0 : 1;
      if (this.lastOwner !== null && owner !== this.lastOwner) {
        this.stats.possessionChanges += 1;
        shape.possessions += 1;
        shape.possessionTimeSum += Math.max(0, s.t - this.possessionStart);
        this.possessionStart = s.t;
        this.possessionPasses = 0;
      }
      this.lastOwner = owner;
      if (carrier !== this.heldBy) {
        this.heldBy = carrier;
        this.heldSince = s.t;
      }
      // Straight off the simulation's own clock: "how long has THIS carrier had it", which is
      // also the number the ball's beep ramps on.
      shape.holdMax = Math.max(shape.holdMax, s.ball.carryT);
    } else {
      // A ball in flight belongs to nobody. Without this the same man picking up his own rebound
      // looked like one uninterrupted forty-second carry.
      this.heldBy = null;
    }
    // A goal ends the attack whoever restarts it — the ball is handed to the conceding team in
    // the same tick, so without this the scoring possession would be merged into the next one.
    if (out.goals.length > 0) {
      shape.possessions += 1;
      shape.possessionTimeSum += Math.max(0, s.t - this.possessionStart);
      this.possessionStart = s.t;
      this.possessionPasses = 0;
    }
  }

  /**
   * Is there a team-mate standing on this throw's line, in front of it?
   *
   * A pass to a man who happens to be in front of the goal is geometrically indistinguishable
   * from a shot, and counting it as one inflates both the shot rate and the shot distance — the
   * two numbers this whole measurement exists to read.
   */
  private aimedAtMate(thrower: EntityId, from: Vec2, vel: Vec2): boolean {
    const s = this.sim.state;
    const team = thrower < this.config.teamSize ? 0 : 1;
    const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
    if (speed < 1e-6) return false;
    const ux = vel.x / speed;
    const uy = vel.y / speed;
    for (const p of s.players) {
      if (p.id === thrower || p.team !== team) continue;
      const along = (p.pos.x - from.x) * ux + (p.pos.y - from.y) * uy;
      if (along <= 0) continue;
      const off = Math.abs((p.pos.x - from.x) * -uy + (p.pos.y - from.y) * ux);
      if (off <= this.config.catching.radius * 1.5) return true;
    }
    return false;
  }

  /** Would a ball released at `from` with velocity `vel` reach the goal `team` is attacking? */
  private aimedAtGoal(from: Vec2, vel: Vec2, team: TeamId): boolean {
    const f = this.field;
    const line = team === 0 ? f.halfWidth : -f.halfWidth;
    const dx = line - from.x;
    if (dx * vel.x <= 0) return false;
    const u = dx / vel.x;
    const y = from.y + vel.y * u;
    return Math.abs(y) <= f.goalWidth / 2;
  }

  private push(
    tick: number,
    t: number,
    kind: TimelineEntry['kind'],
    player: EntityId | null,
    team: TeamId | null,
    label: string,
  ): void {
    this.timeline.push({ tick, t, kind, player, team, label });
  }
}
