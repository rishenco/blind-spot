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
import { perceptionFor, type PerceptionConfig, type SimConfig } from './config';
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
  type SoundKind,
  type TeamId,
  type Vec2,
} from './types';

/** Unit vector from the listener to a reported position; the axis the error cigar lies along. */
function bearingTo(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-9) return { x: 1, y: 0 };
  return { x: dx / d, y: dy / d };
}

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
  /**
   * The perception knobs THIS observer plays with: the globals with its team's overrides on top.
   *
   * Resolved once, here, rather than read from `cfg.perception` at every use — because the
   * concept's headline test ("does a telepath beat an honest bot") is a question about one
   * side's channel, and there is no way to ask it while both sides share one dial.
   */
  private readonly p: PerceptionConfig;
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
    this.p = perceptionFor(cfg, this.team);
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
    const p = this.p;
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
        deliverAt: ev.emittedAt + this.p.reactionLatencySec,
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
      sweptFrom: ret.sweptFrom,
      sweptTo: ret.sweptTo,
      aim: { x: ret.aim.x, y: ret.aim.y },
      coneCos: ret.coneCos,
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

    this.emitXray(view, now);
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
      hearing: this.hearingRadii(),
      events,
      emitters: this.observeEmitters(view, me.pos),
      sonar,
      teammates: this.teammates,
      opponents: this.opponents,
    };
  }

  private nextXrayT = 0;
  private xrayId = -1;

  /**
   * The cheat channel. Pushes a synthetic sonar return that lights up every other body exactly
   * where it is, and declares the rest of the pitch swept and empty.
   *
   * A sonar return is the right shape for this and not a shortcut: it is the only channel in the
   * contract that already carries both halves of knowing — where somebody IS, and where nobody
   * is. A consumer needs no special case, which is the point: the difference between an honest
   * bot and a telepathic one has to be the input, never the code.
   */
  private emitXray(view: WorldView, now: number): void {
    const hz = this.p.xrayHz;
    if (hz <= 0) return;
    if (now + 1e-9 < this.nextXrayT) return;
    this.nextXrayT = now + 1 / hz;
    const me = view.players[this.id];
    if (!me) return;
    const range = view.players.length > 0 ? this.cfg.field.width + this.cfg.field.height : 0;
    const hits: SonarHit[] = [];
    for (const other of view.players) {
      if (other.id === this.id) continue;
      hits.push(
        this.anonymiseHit({
          pos: { x: other.pos.x, y: other.pos.y },
          kind: 'player',
          sourceId: other.id,
          vel: { x: other.vel.x, y: other.vel.y },
        }),
      );
    }
    this.sonarInbox.push({
      pingId: this.xrayId--,
      t: now,
      origin: { x: me.pos.x, y: me.pos.y },
      range,
      waveRadius: range,
      sweptFrom: 0,
      sweptTo: range,
      aim: { x: me.aim.x, y: me.aim.y },
      coneCos: -1,
      hits,
      complete: true,
    });
  }

  // -- internals -----------------------------------------------------------

  /**
   * Cached per-kind audible radii — the shape of this observer's silence. Recomputed only when
   * the config's hearing scale is edited (the playground can do that live).
   */
  private hearingCache: { scale: number; radii: Record<SoundKind, number> } | null = null;

  private hearingRadii(): Readonly<Record<SoundKind, number>> {
    const scale = this.p.hearingScale;
    if (this.hearingCache && this.hearingCache.scale === scale) return this.hearingCache.radii;
    const radii = {} as Record<SoundKind, number>;
    for (const key of Object.keys(this.cfg.loudness) as SoundKind[]) {
      radii[key] = this.cfg.loudness[key] * scale;
    }
    this.hearingCache = { scale, radii };
    return radii;
  }

  private selfState(view: WorldView): SelfState {
    const me = view.players[this.id]!;
    // How hard somebody is pulling at the ball I am holding. Read off the bodies contesting me,
    // which is a thing my own arms would tell me and says nothing about where anybody is.
    let pressure = 0;
    if (me.hasBall) {
      const hold = Math.max(1e-6, this.cfg.contest.steal.holdSec);
      for (const other of view.players) {
        if (other.team === me.team || other.contestTarget !== me.id) continue;
        pressure = Math.max(pressure, clamp(other.contestT / hold, 0, 1));
      }
    }
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
      down: me.downT > 0,
      reaching: me.reachT > 0,
      stealPressure: pressure,
      carrySeconds: me.hasBall ? view.ball.carryT : 0,
      lastCatchFail: me.lastCatchFail,
      lastCatchFailT: me.lastCatchFailT,
      ownLoudness: me.loudness,
    };
  }

  /**
   * Draws one localisation error, shaped like hearing actually is: long along the line to the
   * source, short across it. You can point at a sound; you cannot tell how far away it is.
   */
  private anisotropicOffset(
    from: Vec2,
    to: Vec2,
    d: number,
    sigmas: { radial: number; tangential: number },
  ): Vec2 {
    const radial = gauss(this.rng) * sigmas.radial;
    const tangential = gauss(this.rng) * sigmas.tangential;
    if (d < 1e-6) return { x: radial, y: tangential };
    const ux = (to.x - from.x) / d;
    const uy = (to.y - from.y) / d;
    return { x: ux * radial - uy * tangential, y: uy * radial + ux * tangential };
  }

  /**
   * The two sigmas of the hearing error at distance `d`, in metres.
   *
   * Along the bearing the error is a fraction of the distance (and capped); across it, a small
   * angle times the distance. The angle is applied as `d · θ` rather than `d · tan θ`: at a few
   * degrees the difference is under a thousandth of a metre, and the small-angle form keeps
   * trigonometry — which is not bit-reproducible across engines — out of the perception path.
   */
  private sigmasAt(d: number): { radial: number; tangential: number } {
    const p = this.p;
    return {
      radial: Math.min(p.localizationSigmaCap, p.localizationSigmaPerMeter * d),
      tangential: d * p.localizationBearingDeg * (Math.PI / 180),
    };
  }

  private localise(
    ev: SoundEvent,
    from: Vec2,
    d: number,
    self: boolean,
    relayed: boolean,
  ): ObservedEvent {
    const p = this.p;
    const exact = self || p.exactKinds.includes(ev.kind);
    const sigmas = exact ? { radial: 0, tangential: 0 } : this.sigmasAt(d);
    let x = ev.pos.x;
    let y = ev.pos.y;
    if (sigmas.radial > 0 || sigmas.tangential > 0) {
      const off = this.anisotropicOffset(from, ev.pos, d, sigmas);
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
      sigma: sigmas.radial,
      sigmaBearing: sigmas.tangential,
      bearing: bearingTo(from, { x, y }),
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
    if (!this.p.anonymousSources) return source;
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
    const p = this.p;
    for (const em of emittersOf(view, this.cfg)) {
      const d = dist2(myPos, em.pos);
      if (d > em.intensity * p.hearingScale) continue;
      const sigmas = this.sigmasAt(d);
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
      off.y = off.y * a + gauss(this.rng) * fresh;
      const k = 1 - clamp(p.truthLeak, 0, 1);
      let ex = off.x * sigmas.radial * k;
      let ey = off.y * sigmas.tangential * k;
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
        sigma: sigmas.radial,
        sigmaBearing: sigmas.tangential,
        bearing: bearingTo(myPos, { x, y }),
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
