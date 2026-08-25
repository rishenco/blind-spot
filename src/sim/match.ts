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
import { cloneConfig } from './config';
import { makeField } from './field';
import { dist2 } from './math';
import { Perceiver } from './perception';
import { Simulation, type StepOutput, type WorldView } from './sim';
import { emptyPlayerStats, type MatchStats, type PlayerStats } from './stats';
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
  kind: 'goal' | 'catch' | 'interception' | 'fumble' | 'throw' | 'ping' | 'restart';
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
    if (this.config.perception.teamShare) {
      for (const p of this.perceivers) {
        for (const mate of p.teammates) p.relay(view, heard[mate] ?? []);
      }
    }
    for (const ret of out.sonar) this.perceivers[ret.owner]?.receiveSonar(ret);
    for (let i = 0; i < this.perceivers.length; i++) {
      const frame = this.perceivers[i]!.frame(view, this.field);
      this.frames[i] = frame;
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
