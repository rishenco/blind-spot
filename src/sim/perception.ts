/**
 * Perception — the only bridge between the world and anything that decides.
 *
 * This is the contract the whole project stands on, so it is worth being blunt about what it
 * guarantees:
 *
 *   - A `Perceiver` holds the world for the length of one call and hands back plain numbers.
 *     A `PerceptionFrame` shares no object with `WorldState`: every vector is a fresh literal.
 *     There is no field on it that leads back to a player, the ball or the simulation.
 *   - A controller is constructed with a `ControllerContext` (its own id, its team, the pitch,
 *     the config, an RNG) and is fed `PerceptionFrame`s. It is never given a `Simulation`, a
 *     `WorldState` or a `Perceiver`. If the right-hand view of the debug playground can be
 *     drawn, a bot has exactly the same information a human has — and if that view could be
 *     drawn from the world instead, this file would be a lie.
 *
 * What an observer gets, and what it costs:
 *   - discrete sounds, within their audible radius, with a localisation error that grows with
 *     distance, and with the source identity stripped for opponents;
 *   - one continuous estimate per continuous emitter (the ball), noisy in the same way but
 *     *temporally correlated*, so it cannot be averaged away;
 *   - its own sonar returns, streaming in as the front travels;
 *   - honest proprioception: where its own body is, how fast, how loud.
 */
import type { SimConfig } from './config';
import { clamp, dist2, gauss } from './math';
import { makeRng, type Rng } from '../core/rng';
import type { WorldView } from './sim';
import {
  BALL_ID,
  type ContinuousEmitter,
  type EntityId,
  type FieldInfo,
  type ObservedEmitter,
  type ObservedEvent,
  type PerceptionFrame,
  type SelfState,
  type SonarHit,
  type SonarReturn,
  type SoundEvent,
  type TeamId,
  type Vec2,
} from './types';

interface Delayed {
  deliverAt: number;
  event: ObservedEvent;
}

/** One observer's ears. One instance per player, owned by the match, never by a controller. */
export class Perceiver {
  readonly id: EntityId;
  readonly team: TeamId;
  readonly teammates: EntityId[];
  readonly opponents: EntityId[];

  private readonly cfg: SimConfig;
  private readonly rng: Rng;
  private readonly queue: Delayed[] = [];
  /** Smoothed localisation error per continuous emitter, so the noise cannot be averaged out. */
  private readonly emitterOffset = new Map<EntityId, Vec2>();
  private readonly sonarInbox: SonarReturn[] = [];

  constructor(id: EntityId, cfg: SimConfig, seed: number) {
    this.cfg = cfg;
    this.id = id;
    const size = cfg.teamSize;
    this.team = id < size ? 0 : 1;
    this.teammates = [];
    this.opponents = [];
    for (let i = 0; i < size * 2; i++) {
      if (i === id) continue;
      const t = i < size ? 0 : 1;
      (t === this.team ? this.teammates : this.opponents).push(i);
    }
    // A stream per observer: adding or removing an observer must not shift anyone else's noise,
    // and must never touch the simulation's own stream.
    this.rng = makeRng((seed ^ 0x9e3779b9) + id * 0x85ebca6b);
  }

  /**
   * Runs this tick's sounds through this observer's ears. Returns what was heard (already
   * noisy) so the match can relay it to teammates when the team channel is on.
   */
  hear(view: WorldView, events: readonly SoundEvent[]): ObservedEvent[] {
    const heard: ObservedEvent[] = [];
    const me = view.players[this.id];
    if (!me) return heard;
    const p = this.cfg.perception;
    for (const ev of events) {
      const self = ev.sourceId === this.id;
      const d = dist2(me.pos, ev.pos);
      // Your own noise you always know about; everything else has to reach you.
      if (!self && d > ev.intensity * p.hearingScale) continue;
      const obs = this.localise(ev, me.pos, d, self, false);
      heard.push(obs);
      this.queue.push({ deliverAt: ev.t + p.reactionLatencySec, event: obs });
    }
    return heard;
  }

  /** Accepts a teammate's already-noisy observations over the team channel (voice). */
  relay(view: WorldView, observed: readonly ObservedEvent[]): void {
    const me = view.players[this.id];
    if (!me) return;
    for (const ev of observed) {
      if (ev.sourceId === this.id) continue; // no point being told about your own footsteps
      this.queue.push({
        deliverAt: ev.emittedAt + this.cfg.perception.reactionLatencySec,
        event: {
          ...ev,
          pos: { x: ev.pos.x, y: ev.pos.y },
          relayed: true,
          self: false,
          distance: dist2(me.pos, ev.pos),
        },
      });
    }
  }

  /** Sonar returns belonging to this observer, handed over by the match. */
  receiveSonar(ret: SonarReturn): void {
    this.sonarInbox.push({
      pingId: ret.pingId,
      t: ret.t,
      origin: { x: ret.origin.x, y: ret.origin.y },
      range: ret.range,
      waveRadius: ret.waveRadius,
      complete: ret.complete,
      hits: ret.hits.map((h) => this.anonymiseHit(h)),
    });
  }

  /** Builds this tick's frame. After this call the inboxes are empty again. */
  frame(view: WorldView, field: FieldInfo): PerceptionFrame {
    const me = view.players[this.id]!;
    const now = view.t;
    const events: ObservedEvent[] = [];
    // The queue is tiny (a handful of events per tick even at latency 0.3 s); an in-place
    // compaction keeps it allocation-free and, more importantly, order-stable.
    let w = 0;
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i]!;
      if (item.deliverAt <= now + 1e-9) events.push(item.event);
      else this.queue[w++] = item;
    }
    this.queue.length = w;

    const sonar = this.sonarInbox.slice();
    this.sonarInbox.length = 0;

    return {
      self: this.selfState(view),
      match: {
        t: view.t,
        tick: view.tick,
        phase: view.phase,
        score: [view.score[0], view.score[1]] as const,
        timeLeft: Math.max(0, this.cfg.match.durationSec - view.t),
      },
      field,
      events,
      emitters: this.observeEmitters(view, me.pos),
      sonar,
      teammates: this.teammates,
      opponents: this.opponents,
    };
  }

  // -- internals -----------------------------------------------------------

  private selfState(view: WorldView): SelfState {
    const me = view.players[this.id]!;
    return {
      id: me.id,
      team: me.team,
      pos: { x: me.pos.x, y: me.pos.y },
      vel: { x: me.vel.x, y: me.vel.y },
      aim: { x: me.aim.x, y: me.aim.y },
      speed: Math.sqrt(me.vel.x * me.vel.x + me.vel.y * me.vel.y),
      hasBall: me.hasBall,
      charging: me.charging,
      chargeT: me.chargeT,
      pingCooldown: me.pingCd,
      diving: me.diveT > 0,
      recovering: me.recoverT > 0,
      ownLoudness: me.loudness,
    };
  }

  /**
   * Draws one localisation error, shaped like hearing actually is: long along the line to the
   * source, short across it. You can point at a sound; you cannot tell how far away it is.
   */
  private anisotropicOffset(from: Vec2, to: Vec2, d: number, sigma: number): Vec2 {
    const radial = gauss(this.rng) * sigma;
    const tangential = gauss(this.rng) * sigma * this.cfg.perception.localizationBearingFactor;
    if (d < 1e-6) return { x: radial, y: tangential };
    const ux = (to.x - from.x) / d;
    const uy = (to.y - from.y) / d;
    return { x: ux * radial - uy * tangential, y: uy * radial + ux * tangential };
  }

  /** Sigma of the hearing error at distance `d`, in metres. */
  private sigmaAt(d: number): number {
    const p = this.cfg.perception;
    return Math.min(p.localizationSigmaCap, p.localizationSigmaPerMeter * d);
  }

  private localise(
    ev: SoundEvent,
    from: Vec2,
    d: number,
    self: boolean,
    relayed: boolean,
  ): ObservedEvent {
    const p = this.cfg.perception;
    const exact = self || p.exactKinds.includes(ev.kind);
    const sigma = exact ? 0 : this.sigmaAt(d);
    let x = ev.pos.x;
    let y = ev.pos.y;
    if (sigma > 0) {
      const off = this.anisotropicOffset(from, ev.pos, d, sigma);
      // truthLeak blends the true position back in. 0 = honest; it exists to be measured
      // against, not to be switched on quietly.
      const k = 1 - clamp(p.truthLeak, 0, 1);
      x = ev.pos.x + off.x * k;
      y = ev.pos.y + off.y * k;
    }
    return {
      t: ev.t + p.reactionLatencySec,
      emittedAt: ev.t,
      kind: ev.kind,
      pos: { x, y },
      intensity: ev.intensity,
      sigma,
      distance: d,
      sourceId: this.identify(ev.sourceId),
      self,
      relayed,
    };
  }

  /**
   * The anonymity rule: you know your own noise, your teammates' noise and the ball. An
   * opponent's footstep arrives with no name on it, and working out which of them made it is
   * the listener's problem (data association — the AI brief calls this out by name).
   */
  private identify(source: EntityId): EntityId | null {
    if (!this.cfg.perception.anonymousSources) return source;
    if (source === BALL_ID) return source;
    if (source === this.id) return source;
    const size = this.cfg.teamSize;
    const team = source < size ? 0 : 1;
    return team === this.team ? source : null;
  }

  private anonymiseHit(h: SonarHit): SonarHit {
    const id = h.sourceId === null ? null : this.identify(h.sourceId);
    return {
      pos: { x: h.pos.x, y: h.pos.y },
      kind: h.kind,
      sourceId: id,
      // Velocity of an unidentified body is not something a snapshot gives you.
      vel: h.vel && id !== null ? { x: h.vel.x, y: h.vel.y } : null,
    };
  }

  private observeEmitters(view: WorldView, myPos: Vec2): ObservedEmitter[] {
    const out: ObservedEmitter[] = [];
    const p = this.cfg.perception;
    for (const em of emittersOf(view, this.cfg)) {
      const d = dist2(myPos, em.pos);
      if (d > em.intensity * p.hearingScale) continue;
      const sigma = this.sigmaAt(d);
      let off = this.emitterOffset.get(em.id);
      if (!off) {
        off = { x: 0, y: 0 };
        this.emitterOffset.set(em.id, off);
      }
      // An Ornstein–Uhlenbeck-style walk: the error drifts instead of resampling, so listening
      // longer sharpens the estimate only as much as the emitter's own movement allows.
      const a = clamp(p.emitterNoiseSmoothing, 0, 1);
      const fresh = Math.sqrt(Math.max(0, 1 - a * a));
      // The walk lives in (radial, tangential) coordinates; it is rotated into the world below,
      // so the error stays an ellipse pointing at the emitter even as the emitter moves.
      off.x = off.x * a + gauss(this.rng) * fresh;
      off.y = off.y * a + gauss(this.rng) * fresh * p.localizationBearingFactor;
      const k = 1 - clamp(p.truthLeak, 0, 1);
      let ex = off.x * sigma * k;
      let ey = off.y * sigma * k;
      if (d > 1e-6) {
        const ux = (em.pos.x - myPos.x) / d;
        const uy = (em.pos.y - myPos.y) / d;
        const rx = ux * ex - uy * ey;
        const ry = uy * ex + ux * ey;
        ex = rx;
        ey = ry;
      }
      const x = em.pos.x + ex;
      const y = em.pos.y + ey;
      out.push({
        id: em.id,
        kind: em.kind,
        pos: { x, y },
        sigma,
        distance: dist2(myPos, { x, y }),
      });
    }
    return out;
  }
}

/** The world's continuous sources. Kept here so perception has one place to ask. */
export function emittersOf(view: WorldView, cfg: SimConfig): ContinuousEmitter[] {
  return [
    {
      id: BALL_ID,
      kind: 'ball',
      pos: { x: view.ball.pos.x, y: view.ball.pos.y },
      vel: { x: view.ball.vel.x, y: view.ball.vel.y },
      intensity: cfg.loudness['ball-hum'],
    },
  ];
}
