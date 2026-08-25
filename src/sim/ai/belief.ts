/**
 * Layer 1 — perception into belief.
 *
 * This class is the *only* thing the decision layer is allowed to read. It is constructed from
 * a `ControllerContext` and fed `PerceptionFrame`s, exactly what a human's screen is fed, and
 * it holds no reference to the world, the simulation or a `Perceiver`. If that ever stopped
 * being true the bot would still look fine on screen, which is precisely why the brief insists
 * on the separation being structural rather than a promise (`ai.test.ts` asserts it by reading
 * this directory's imports).
 *
 * What it maintains:
 *
 *   - one occupancy grid per opponent — where he might be, shaped by walls, by the crease, by
 *     what we heard and, above all, by what we did NOT hear;
 *   - one coarse mirror grid per opponent — where *he* probably thinks *I* am. Same estimator,
 *     run from the other chair. Without it, "stand still and shut up", the feint and the lying
 *     ping all have to be hardcoded; with it they fall out of one utility axis;
 *   - a bounded-memory track of the ball, which never stops humming;
 *   - a point track of the team-mate, who is identified when he makes noise;
 *   - a guess at who is holding the ball, inferred from catches, throws and the way the hum moves.
 */
import { clamp, dist2, len2, norm2 } from '../math';
import type { SimConfigView } from '../types';
import type {
  ControllerContext,
  EntityId,
  FieldInfo,
  ObservedEvent,
  PerceptionFrame,
  SoundKind,
  TeamId,
  Vec2,
} from '../types';
import { BallTracker, type BallEstimate, type BallPhysics } from './ball';
import { gridMaskFor, OccupancyGrid, type GridMask } from './grid';

/** Everything the belief layer can be tuned or crippled by. All of it lives in `config.ai`. */
export interface BeliefKnobs {
  /** Opponent grid resolution, metres. */
  cell: number;
  /** Mirror grid resolution — deliberately coarser: we need its order of magnitude, not its detail. */
  mirrorCell: number;
  /** Prediction/decision rate, Hz. */
  stepHz: number;
  /** Prior over what an unheard opponent is doing. */
  wStand: number;
  wWalk: number;
  wRun: number;
  /** Fraction of belief replaced by uniform each prediction step — the "he could be anywhere" floor. */
  floor: number;
  /** Probability a body inside a ping's swept volume really is reported. Never 1. */
  pDetectSonar: number;
  /** Metres shaved off the swept volume before using it as negative information. */
  sonarShrink: number;
  /** Probability that a sound inside its audible radius really reaches the ear. Never 1. */
  pDetectHear: number;
  /** How many ball observations the bot may hold and average. The honesty knob for the hum. */
  observationMemory: number;
  /** A direction hint older than this is discarded and the diffusion goes back to isotropic. */
  dirHintLifeSec: number;
}

export function beliefKnobs(cfg: SimConfigView): BeliefKnobs {
  const ai = cfg.ai as Record<string, unknown>;
  const num = (key: string, fallback: number): number => {
    const v = ai[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    cell: num('beliefCell', 0.5),
    mirrorCell: num('mirrorCell', 1),
    stepHz: num('beliefHz', 10),
    wStand: num('wStand', 0.3),
    wWalk: num('wWalk', 0.35),
    wRun: num('wRun', 0.35),
    floor: num('beliefFloor', 0.012),
    pDetectSonar: num('pDetectSonar', 0.9),
    sonarShrink: num('sonarShrink', 0.6),
    pDetectHear: num('pDetectHear', 0.95),
    observationMemory: num('observationMemory', 12),
    dirHintLifeSec: num('dirHintLife', 0.8),
  };
}

export interface OpponentTrack {
  id: EntityId;
  grid: OccupancyGrid;
  /** Sim time of the last positive evidence about this track. */
  lastSeenT: number;
  /** Newest positive fix, for the direction hint and for the overlay. */
  lastFix: Vec2 | null;
  lastFixT: number;
  /** Decaying "he was heading this way" estimate, m/s. */
  dir: Vec2;
  dirT: number;
}

export interface MirrorTrack {
  /** Whose head this is a model of. */
  opponent: EntityId;
  grid: OccupancyGrid;
  /** Sim time at which this opponent last had a hard fix on me. */
  lastFixT: number;
  /**
   * How much of the "he is close enough to hear me" hypothesis has already been spent, and when.
   *
   * Without this the mirror is catastrophically wrong. Ten footsteps in a row are not ten
   * independent chances to be overheard: they are one chance, because it is the same listener in
   * the same place. Folding each of them in as an independent 10 % detection compounds to near
   * certainty within a couple of seconds, and the bot concludes it is permanently visible — which
   * silently deletes stealth, the feint, and the entire reason the mirror exists. The credit
   * decays as his own position decorrelates, so walking somewhere new really is a fresh risk.
   */
  credit: number;
  creditT: number;
}

export type Possession = 'self' | 'mate' | 'opponent' | 'loose' | 'unknown';

export interface MateTrack {
  id: EntityId;
  pos: Vec2;
  t: number;
  /** True while the estimate is fresh enough to plan a pass with. */
  fresh: boolean;
}

/** Baseline over which the hum's movement is judged, and the speed that counts as carried. */
const BALL_BASELINE_SEC = 1.2;
const BALL_CARRY_MIN_SPEED = 0.8;

/** Seconds over which "he already heard me from there" stops being a reason not to worry. */
const MIRROR_CREDIT_TAU = 2.2;

const DISCRETE_BODY_KINDS: SoundKind[] = [
  'step-walk',
  'step-run',
  'brake',
  'dive',
  'catch',
  'fumble',
  'throw',
  'sonar',
];

export class Belief {
  readonly knobs: BeliefKnobs;
  readonly opponents: OpponentTrack[] = [];
  readonly mirrors: MirrorTrack[] = [];
  readonly mate: MateTrack | null;
  ball: BallEstimate | null = null;
  possession: Possession = 'unknown';
  possessionT = 0;
  now = 0;
  /** Grew every tick, reset by the prediction step: the belief clock is 10 Hz, the world's is 60. */
  private sinceStep = 0;
  /** Kinds of anonymous sound heard since the last prediction step — silence is only informative if total. */
  private heardRun = false;
  private heardWalk = false;
  private lastPhase = 'play';
  private lastThrowT = -10;
  private ballStillSince = -1;
  private ballMovingSince = -1;
  /**
   * A ring of ball estimates on a long baseline, purely to answer "is the hum actually moving".
   *
   * The instantaneous velocity out of `BallTracker` cannot answer it. The simulation's emitter
   * noise is a slow random walk of the same size as the localisation sigma (about 0.6 m at ten
   * metres) and it turns over in half a second, so differentiating it produces several metres a
   * second of pure fiction — enough to make a ball lying on the floor look like a ball being
   * carried, which is what made the bot invent an opponent carrier in every quiet scenario. Over
   * a 1.2 s baseline the noise decorrelates and a walking carrier has moved three metres.
   */
  private readonly ballTrail: { t: number; x: number; y: number }[] = [];

  private readonly ctx: ControllerContext;
  private readonly cfg: SimConfigView;
  private readonly field: FieldInfo;
  private readonly mask: GridMask;
  private readonly mirrorMask: GridMask;
  private readonly scratch: OccupancyGrid;
  private readonly silentWalk: Float32Array;
  private readonly silentRun: Float32Array;
  private readonly mirrorSilentWalk: Float32Array;
  private readonly mirrorSilentRun: Float32Array;
  private readonly tracker: BallTracker;
  private readonly samplesBuf: { pos: Vec2; weight: number }[] = [];

  constructor(ctx: ControllerContext) {
    this.ctx = ctx;
    this.cfg = ctx.config;
    this.field = ctx.field;
    this.knobs = beliefKnobs(ctx.config);
    const bodyR = this.cfg.player.radius;
    this.mask = gridMaskFor(this.field, this.knobs.cell, bodyR);
    this.mirrorMask = gridMaskFor(this.field, this.knobs.mirrorCell, bodyR);
    for (const id of ctx.opponents) {
      this.opponents.push({
        id,
        grid: new OccupancyGrid(this.mask),
        lastSeenT: -99,
        lastFix: null,
        lastFixT: -99,
        dir: { x: 0, y: 0 },
        dirT: -99,
      });
      this.mirrors.push({
        opponent: id,
        grid: new OccupancyGrid(this.mirrorMask),
        lastFixT: -99,
        credit: 0,
        creditT: -99,
      });
    }
    this.mate = ctx.teammates.length > 0 ? { id: ctx.teammates[0]!, pos: { x: 0, y: 0 }, t: -99, fresh: false } : null;
    this.scratch = new OccupancyGrid(this.mask);
    this.silentWalk = new Float32Array(this.mask.spec.nx * this.mask.spec.ny);
    this.silentRun = new Float32Array(this.mask.spec.nx * this.mask.spec.ny);
    this.mirrorSilentWalk = new Float32Array(this.mirrorMask.spec.nx * this.mirrorMask.spec.ny);
    this.mirrorSilentRun = new Float32Array(this.mirrorMask.spec.nx * this.mirrorMask.spec.ny);
    this.tracker = new BallTracker(this.knobs.observationMemory);
  }

  get ballPhysics(): BallPhysics {
    return {
      friction: this.cfg.ball.friction,
      restitution: this.cfg.field.wallRestitution,
      radius: this.cfg.ball.radius,
      restSpeed: this.cfg.ball.restSpeed,
    };
  }

  reset(): void {
    for (const t of this.opponents) {
      t.grid.setUniform();
      t.lastSeenT = -99;
      t.lastFix = null;
      t.dir = { x: 0, y: 0 };
      t.dirT = -99;
    }
    for (const m of this.mirrors) {
      m.grid.setUniform();
      m.lastFixT = -99;
      m.credit = 0;
      m.creditT = -99;
    }
    this.tracker.reset();
    this.ball = null;
    this.possession = 'unknown';
    this.sinceStep = 0;
  }

  // -- the update ----------------------------------------------------------

  /** One tick of evidence. Positive updates land immediately; prediction runs at `stepHz`. */
  update(frame: PerceptionFrame): void {
    const dt = this.cfg.dt;
    this.now = frame.match.t;

    this.tracker.observe(frame.emitters.find((e) => e.kind === 'ball') ?? null, this.now);
    this.ball = this.tracker.estimate();

    // A whistle resets everyone to the kickoff formation. That is not a peek at the world: the
    // rules are public, and a human staring at a black screen knows exactly the same thing.
    if (frame.match.phase === 'restart' && this.lastPhase !== 'restart') this.applyFormationPrior();
    if (this.lastPhase === 'restart' && frame.match.phase === 'play') this.applyFormationPrior();
    this.lastPhase = frame.match.phase;

    this.absorbEvents(frame);
    this.absorbSonar(frame);
    this.updatePossession(frame);

    // Carrying the ball is a continuous confession. The hum is not a discrete event, so it
    // never reaches `onOwnSound` — but it is audible across the whole pitch, so a carrier is
    // located by everyone, always. Without this the bot thinks it is sneaking around with a
    // siren in its hands, and every price it puts on noise is wrong.
    if (frame.self.hasBall) {
      for (const m of this.mirrors) {
        m.grid.setPoint(frame.self.pos, this.knobs.mirrorCell * 0.9);
        m.lastFixT = this.now;
        m.credit = 1;
        m.creditT = this.now;
      }
    }

    this.sinceStep += dt;
    const stepDt = 1 / Math.max(1, this.knobs.stepHz);
    if (this.sinceStep + 1e-9 >= stepDt) {
      this.predict(frame, this.sinceStep);
      this.sinceStep = 0;
      this.heardRun = false;
      this.heardWalk = false;
    }
  }

  // -- evidence ------------------------------------------------------------

  private absorbEvents(frame: PerceptionFrame): void {
    const anonymous: ObservedEvent[] = [];
    for (const ev of frame.events) {
      if (ev.self) {
        this.onOwnSound(ev, frame);
        continue;
      }
      if (ev.kind === 'ball-hum' || ev.kind === 'ball-wall' || ev.kind === 'whistle') continue;
      if (ev.sourceId !== null) {
        // Named: a team-mate. Free position, and honest — voices are not anonymous.
        if (this.mate && ev.sourceId === this.mate.id) {
          this.mate.pos = { x: ev.pos.x, y: ev.pos.y };
          this.mate.t = this.now;
          this.mate.fresh = true;
        }
        continue;
      }
      if (!DISCRETE_BODY_KINDS.includes(ev.kind)) continue;
      anonymous.push(ev);
      if (ev.kind === 'step-run' || ev.kind === 'brake' || ev.kind === 'dive') this.heardRun = true;
      if (ev.kind === 'step-walk') this.heardWalk = true;
      if (ev.kind === 'sonar') this.onOpponentPing(ev, frame);
    }
    for (const ev of anonymous) this.associate(ev);
    if (this.mate && this.now - this.mate.t > 2.5) this.mate.fresh = false;
  }

  /**
   * Data association, cheapest-first, as in librcsc: gate, then take the unambiguous pairing,
   * and only fall back to soft weighting when two tracks really could both have made the sound.
   *
   * The exclusivity step matters as much as the assignment: if this footstep was certainly
   * opponent A, then it was certainly not opponent B, and B's belief should shrink around that
   * spot. Written naively, that information is simply lost.
   */
  private associate(ev: ObservedEvent): void {
    const tracks = this.opponents;
    if (tracks.length === 0) return;
    const sr = Math.max(0.25, ev.sigma);
    const st = Math.max(0.15, ev.sigmaBearing);
    if (tracks.length === 1) {
      tracks[0]!.grid.multiplyGaussian(ev.pos, ev.bearing, sr, st);
      this.markFix(tracks[0]!, ev.pos);
      return;
    }
    let total = 0;
    const lambdas: number[] = [];
    for (const t of tracks) {
      const l = t.grid.likelihoodMass(ev.pos, ev.bearing, sr, st);
      lambdas.push(l);
      total += l;
    }
    if (total <= 1e-12) {
      // Nobody could have made this sound: our belief was wrong, not the world. Re-open it.
      for (const t of tracks) {
        t.grid.setUniform();
        t.grid.multiplyGaussian(ev.pos, ev.bearing, sr, st);
      }
      this.markFix(tracks[0]!, ev.pos);
      return;
    }
    let bestI = 0;
    for (let i = 1; i < lambdas.length; i++) if (lambdas[i]! > lambdas[bestI]!) bestI = i;
    const second = lambdas.reduce((acc, v, i) => (i === bestI ? acc : Math.max(acc, v)), 0);
    if (lambdas[bestI]! > second * 4) {
      // Unambiguous: hard assignment, plus the negative half for everyone else.
      tracks[bestI]!.grid.multiplyGaussian(ev.pos, ev.bearing, sr, st);
      this.markFix(tracks[bestI]!, ev.pos);
      for (let i = 0; i < tracks.length; i++) {
        if (i === bestI) continue;
        tracks[i]!.grid.multiplyNegativeSector(ev.pos, 0, Math.max(1.2, 2 * sr), { x: 1, y: 0 }, -1, 0.6, [], 0);
      }
      return;
    }
    for (let i = 0; i < tracks.length; i++) {
      const w = lambdas[i]! / total;
      if (w < 1e-4) continue;
      this.scratch.copyFrom(tracks[i]!.grid);
      this.scratch.multiplyGaussian(ev.pos, ev.bearing, sr, st);
      tracks[i]!.grid.blendFrom(this.scratch, w);
      if (w > 0.35) this.markFix(tracks[i]!, ev.pos);
    }
  }

  private markFix(track: OpponentTrack, at: Vec2): void {
    if (track.lastFix && this.now - track.lastFixT > 1e-3 && this.now - track.lastFixT < 1.0) {
      const dt = this.now - track.lastFixT;
      const vx = (at.x - track.lastFix.x) / dt;
      const vy = (at.y - track.lastFix.y) / dt;
      const speed = Math.sqrt(vx * vx + vy * vy);
      // Reject nonsense: nobody moves faster than a sprint, and a jump between two tracks looks
      // exactly like that.
      if (speed <= this.cfg.player.runSpeed * 1.4) {
        track.dir = { x: vx, y: vy };
        track.dirT = this.now;
      }
    }
    track.lastFix = { x: at.x, y: at.y };
    track.lastFixT = this.now;
    track.lastSeenT = this.now;
  }

  private absorbSonar(frame: PerceptionFrame): void {
    if (frame.sonar.length === 0) return;
    const shrink = this.knobs.sonarShrink;
    for (const ret of frame.sonar) {
      const spare: Vec2[] = [];
      const opponentHits: Vec2[] = [];
      for (const hit of ret.hits) {
        if (hit.kind !== 'player') continue;
        spare.push(hit.pos);
        if (hit.sourceId === null) opponentHits.push(hit.pos);
        else if (this.mate && hit.sourceId === this.mate.id) {
          this.mate.pos = { x: hit.pos.x, y: hit.pos.y };
          this.mate.t = this.now;
          this.mate.fresh = true;
        }
      }
      // The negative half first, over the annulus this tick's front actually checked — shrunk,
      // and never with certainty. Then the positive hits, which are exact.
      const r0 = ret.sweptFrom + shrink;
      const r1 = ret.sweptTo - shrink * 0.5;
      if (r1 > r0) {
        for (const t of this.opponents) {
          t.grid.multiplyNegativeSector(ret.origin, r0, r1, ret.aim, ret.coneCos, this.knobs.pDetectSonar, spare, 1.5);
        }
      }
      for (const hit of opponentHits) this.absorbSonarHit(hit);
    }
  }

  private absorbSonarHit(at: Vec2): void {
    const tracks = this.opponents;
    if (tracks.length === 0) return;
    let bestI = 0;
    let best = -1;
    for (let i = 0; i < tracks.length; i++) {
      const l = tracks[i]!.grid.likelihoodMass(at, { x: 1, y: 0 }, 1.2, 1.2);
      if (l > best) {
        best = l;
        bestI = i;
      }
    }
    const t = tracks[bestI]!;
    // A ping return is a photograph: it says where, exactly, with no hearing error at all.
    t.grid.setPoint(at, Math.max(0.35, this.knobs.cell * 0.8));
    this.markFix(t, at);
  }

  /**
   * An opponent's ping. Two facts arrive at once and both are worth having: his exact position
   * (the ping is the one sound with no localisation error), and — if I am inside its range —
   * the knowledge that he has just seen me. The second one is what makes the mirror belief
   * collapse and the bot stop treating itself as invisible.
   */
  private onOpponentPing(ev: ObservedEvent, frame: PerceptionFrame): void {
    this.absorbSonarHit(ev.pos);
    const d = dist2(frame.self.pos, ev.pos);
    if (d <= this.cfg.ping.range) {
      for (const m of this.mirrors) {
        m.grid.setPoint(frame.self.pos, this.knobs.mirrorCell * 0.8);
        m.lastFixT = this.now;
        m.credit = 1;
        m.creditT = this.now;
      }
    }
  }

  /**
   * My own noise, folded into what the opponents now know about me.
   *
   * This is the whole reason the mirror exists. I know exactly what I emitted, where and how
   * loudly; the only unknown is whether an opponent was close enough to hear it, and my own
   * belief about him answers that as a probability. So the update is a mixture: with p he heard
   * it and now has a fix on me, with 1-p he heard nothing and his picture of me keeps rotting.
   */
  private onOwnSound(ev: ObservedEvent, frame: PerceptionFrame): void {
    if (ev.kind === 'ball-hum' || ev.kind === 'whistle') return;
    const radius = ev.intensity * this.cfg.perception.hearingScale;
    const exact = this.cfg.perception.exactKinds.includes(ev.kind);
    for (let i = 0; i < this.mirrors.length; i++) {
      const m = this.mirrors[i]!;
      const track = this.opponents[i]!;
      const pHeard = Math.min(0.98, track.grid.massInCircle(ev.pos, radius) * this.knobs.pDetectHear);
      if (pHeard < 1e-3) continue;
      // Spend only what has not been spent already (see `MirrorTrack.credit`).
      const decayed = m.credit * Math.max(0, 1 - (this.now - m.creditT) / MIRROR_CREDIT_TAU);
      const fresh = clamp(pHeard - decayed, 0, 1);
      m.credit = Math.max(decayed, pHeard);
      m.creditT = this.now;
      if (fresh < 1e-3 && !exact) continue;
      if (exact) {
        // A ping tells the whole pitch where I am, precisely. There is no hiding it and no
        // point modelling it as fuzzy.
        if (pHeard > 0.5) {
          m.grid.setPoint(ev.pos, this.knobs.mirrorCell * 0.8);
          m.lastFixT = this.now;
          m.credit = 1;
          m.creditT = this.now;
        }
        continue;
      }
      const d = Math.max(1, dist2(track.grid.centroid(), ev.pos));
      const sr = Math.min(this.cfg.perception.localizationSigmaCap, this.cfg.perception.localizationSigmaPerMeter * d);
      const st = d * this.cfg.perception.localizationBearingDeg * (Math.PI / 180);
      const bearing = norm2({ x: ev.pos.x - track.grid.centroid().x, y: ev.pos.y - track.grid.centroid().y }, { x: 1, y: 0 });
      m.grid.multiplyDetection(ev.pos, bearing, Math.max(0.4, sr), Math.max(0.3, st), fresh);
      if (pHeard > 0.5) m.lastFixT = this.now;
    }
    if (ev.kind === 'throw') this.lastThrowT = this.now;
    void frame;
  }

  // -- possession ----------------------------------------------------------

  /**
   * Who has the ball, worked out the way a blind player works it out: from the slap of a catch,
   * the crack of a throw, and from the way the hum moves. A hum that walks across the pitch at
   * three metres a second and does not slow down is in somebody's hands.
   */
  private updatePossession(frame: PerceptionFrame): void {
    if (frame.self.hasBall) {
      this.setPossession('self');
      this.attachCarrier();
      return;
    }
    // Discrete evidence first: a catch, a throw and a fumble each say something unambiguous
    // about who is holding what, and they say it the instant they are heard.
    for (const ev of frame.events) {
      if (ev.kind === 'catch') {
        if (ev.sourceId !== null && this.mate && ev.sourceId === this.mate.id) this.setPossession('mate');
        else if (ev.sourceId === null) this.setPossession('opponent');
      } else if (ev.kind === 'throw' || ev.kind === 'fumble') {
        this.setPossession('loose');
        if (ev.kind === 'throw') this.lastThrowT = this.now;
      } else if (ev.kind === 'whistle') {
        this.setPossession('unknown');
      }
    }

    const ball = this.ball;
    if (!ball) return;
    const speed = this.ballBaselineSpeed(ball.pos);
    const carrySpeed = this.cfg.player.runSpeed * 1.15;
    if (speed < BALL_CARRY_MIN_SPEED) {
      if (this.ballStillSince < 0) this.ballStillSince = this.now;
      this.ballMovingSince = -1;
    } else {
      this.ballStillSince = -1;
      if (this.ballMovingSince < 0) this.ballMovingSince = this.now;
    }

    // Then the hum itself, which never latches. A belief about possession that can only be
    // *entered* is the bug that made the bot spend half of every match acting as a support
    // player for a team-mate who had thrown the ball away eight seconds earlier: it heard the
    // catch, and nothing ever told it the ball was on the floor again.
    if (len2(ball.vel) > carrySpeed * 1.5 || this.now - this.lastThrowT < 0.9) {
      this.setPossession('loose');
    } else if (this.ballStillSince > 0 && this.now - this.ballStillSince > 0.6) {
      this.setPossession(this.whoIsStandingOn(ball.pos) ?? 'loose');
    } else if (this.ballMovingSince > 0 && this.now - this.ballMovingSince > 0.4) {
      // A hum that walks and does not slow down like friction is in somebody's hands.
      this.setPossession(this.whoIsStandingOn(ball.pos) ?? 'opponent');
    }

    if (this.possession === 'opponent') this.attachCarrier();
  }

  /** Metres per second the hum has really covered, measured over a baseline the noise cannot fake. */
  private ballBaselineSpeed(at: Vec2): number {
    this.ballTrail.push({ t: this.now, x: at.x, y: at.y });
    while (this.ballTrail.length > 2 && this.now - this.ballTrail[0]!.t > BALL_BASELINE_SEC) {
      this.ballTrail.shift();
    }
    const first = this.ballTrail[0]!;
    const dt = this.now - first.t;
    if (dt < BALL_BASELINE_SEC * 0.6) return 0;
    return dist2(at, { x: first.x, y: first.y }) / dt;
  }

  /**
   * Who, if anyone, does belief put on top of the ball. Used to decide whether a hum that is not
   * moving is a ball on the floor or a ball in a pair of hands.
   */
  private whoIsStandingOn(at: Vec2): Possession | null {
    if (this.mate && this.mate.fresh && dist2(this.mate.pos, at) < 1.6) return 'mate';
    for (const t of this.opponents) {
      // Only a *confident* track counts: a diffuse belief happens to cover the ball as well as
      // it covers everything else, and reading that as "an opponent has it" would be a fantasy.
      if (this.now - t.lastSeenT > 1.5) continue;
      if (t.grid.massInCircle(at, 1.6) > 0.55) return 'opponent';
    }
    return null;
  }

  /**
   * A believed opponent carrier is a body located by the loudest thing on the pitch, so fold the
   * hum into his track. This is exactly the asymmetry the game is built on: the carrier is never
   * a secret, and his partner always is.
   */
  private attachCarrier(): void {
    if (this.possession !== 'opponent' || this.opponents.length === 0 || !this.ball) return;
    const ball = this.ball;
    const sigma = Math.max(0.6, ball.sigma) + this.cfg.ball.carryOffset;
    let bestI = 0;
    let best = -1;
    for (let i = 0; i < this.opponents.length; i++) {
      const l = this.opponents[i]!.grid.likelihoodMass(ball.pos, { x: 1, y: 0 }, sigma, sigma);
      if (l > best) {
        best = l;
        bestI = i;
      }
    }
    const t = this.opponents[bestI]!;
    t.grid.multiplyGaussian(ball.pos, { x: 1, y: 0 }, sigma, sigma);
    t.lastSeenT = this.now;
    t.lastFix = { x: ball.pos.x, y: ball.pos.y };
    t.lastFixT = this.now;
  }

  private setPossession(p: Possession): void {
    if (this.possession !== p) {
      this.possession = p;
      this.possessionT = this.now;
    }
  }

  // -- prediction ----------------------------------------------------------

  private predict(frame: PerceptionFrame, dt: number): void {
    const me = frame.self.pos;
    const runR = frame.hearing['step-run'];
    const walkR = frame.hearing['step-walk'];
    const stride = this.cfg.player.strideLength;
    const pRunStep = Math.min(1, (dt * this.cfg.player.runSpeed) / stride);
    const pWalkStep = Math.min(1, (dt * this.cfg.player.walkSpeed) / stride);

    this.fillSilence(this.silentRun, this.mask, me, runR, this.heardRun ? 0 : pRunStep);
    this.fillSilence(this.silentWalk, this.mask, me, walkR, this.heardWalk ? 0 : pWalkStep);

    for (const t of this.opponents) {
      // A fresh direction estimate slides the cloud after the runner; a stale one is dropped and
      // the cloud goes back to growing evenly. That switch is the feint, seen from inside.
      if (this.now - t.dirT < this.knobs.dirHintLifeSec) {
        const decay = 1 - (this.now - t.dirT) / this.knobs.dirHintLifeSec;
        t.grid.advect(t.dir.x * dt * decay, t.dir.y * dt * decay);
      }
      t.grid.predict({
        dt,
        wStand: this.knobs.wStand,
        wWalk: this.knobs.wWalk,
        wRun: this.knobs.wRun,
        walkSpeed: this.cfg.player.walkSpeed,
        runSpeed: this.cfg.player.runSpeed,
        silentWalk: this.silentWalk,
        silentRun: this.silentRun,
        floor: this.knobs.floor,
      });
    }

    for (let i = 0; i < this.mirrors.length; i++) {
      const m = this.mirrors[i]!;
      const listener = this.opponents[i]!.grid.centroid();
      this.fillSilence(this.mirrorSilentRun, this.mirrorMask, listener, runR, pRunStep);
      this.fillSilence(this.mirrorSilentWalk, this.mirrorMask, listener, walkR, pWalkStep);
      m.grid.predict({
        dt,
        wStand: this.knobs.wStand,
        wWalk: this.knobs.wWalk,
        wRun: this.knobs.wRun,
        walkSpeed: this.cfg.player.walkSpeed,
        runSpeed: this.cfg.player.runSpeed,
        silentWalk: this.mirrorSilentWalk,
        silentRun: this.mirrorSilentRun,
        floor: this.knobs.floor,
      });
    }
  }

  /**
   * The doughnut, in one loop.
   *
   * `out[c]` is the probability that a body moving in cell `c` at that gait would NOT have been
   * heard by a listener standing at `listener`. Close in it is near zero, so the belief there
   * can only stand still; past the audible radius it is one, and the belief grows freely.
   * Everything interesting the bot does about silence comes out of this function.
   */
  private fillSilence(out: Float32Array, mask: GridMask, listener: Vec2, radius: number, pEvent: number): void {
    out.fill(1);
    if (pEvent <= 0 || radius <= 0) return;
    const { nx, ny, cell, ox, oy } = mask.spec;
    const margin = 1.5;
    const inner = Math.max(0, radius - margin);
    const inner2 = inner * inner;
    const outer2 = radius * radius;
    const p = pEvent * this.knobs.pDetectHear;
    const band = Math.max(1e-6, radius - inner);
    // Only the audible disc is ever anything but 1, and a walking step's disc is a hundredth of
    // the pitch — walking the whole grid to write 1 into 97 % of it was pure waste. Distances
    // stay squared until the boundary band, where the ramp genuinely needs the root.
    const ix0 = Math.max(0, Math.floor((listener.x - radius - ox) / cell));
    const ix1 = Math.min(nx - 1, Math.ceil((listener.x + radius - ox) / cell));
    const iy0 = Math.max(0, Math.floor((listener.y - radius - oy) / cell));
    const iy1 = Math.min(ny - 1, Math.ceil((listener.y + radius - oy) / cell));
    for (let iy = iy0; iy <= iy1; iy++) {
      const dy = oy + iy * cell - listener.y;
      const dy2 = dy * dy;
      const row = iy * nx;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = ox + ix * cell - listener.x;
        const d2 = dx * dx + dy2;
        if (d2 >= outer2) continue;
        if (d2 <= inner2) {
          out[row + ix] = 1 - p;
          continue;
        }
        out[row + ix] = 1 - p * ((radius - Math.sqrt(d2)) / band);
      }
    }
  }

  /**
   * Kickoff and restart: everyone knows the formation, because it is in the rules. The only
   * thing that has to be inferred is which end is restarting, and the ball's hum answers that.
   */
  private applyFormationPrior(): void {
    const ball = this.ball;
    if (!ball) return;
    const restartTeam: TeamId = ball.pos.x < 0 ? 0 : 1;
    const f = this.field;
    const size = this.cfg.teamSize;
    const restartX = f.halfWidth - f.creaseRadius - 1.2;
    const sigma = this.cfg.match.spawnJitter + 0.9;
    for (const t of this.opponents) {
      const team: TeamId = t.id < size ? 0 : 1;
      const idx = t.id % size;
      const spread = size === 1 ? 0 : (idx / (size - 1) - 0.5) * (f.height - 4);
      const sign = team === 0 ? -1 : 1;
      const x = team === restartTeam ? sign * restartX : sign * (f.halfWidth * 0.35);
      t.grid.setPoint({ x, y: spread }, sigma);
      t.lastSeenT = this.now;
      t.lastFix = { x, y: spread };
      t.lastFixT = this.now;
      t.dir = { x: 0, y: 0 };
      t.dirT = -99;
    }
    if (this.mate) {
      const team: TeamId = this.mate.id < size ? 0 : 1;
      const idx = this.mate.id % size;
      const spread = size === 1 ? 0 : (idx / (size - 1) - 0.5) * (f.height - 4);
      const sign = team === 0 ? -1 : 1;
      this.mate.pos = { x: team === restartTeam ? sign * restartX : sign * (f.halfWidth * 0.35), y: spread };
      this.mate.t = this.now;
      this.mate.fresh = true;
    }
    for (let i = 0; i < this.mirrors.length; i++) {
      const m = this.mirrors[i]!;
      const team: TeamId = this.ctx.team;
      const idx = this.ctx.self % size;
      const spread = size === 1 ? 0 : (idx / (size - 1) - 0.5) * (f.height - 4);
      const sign = team === 0 ? -1 : 1;
      m.grid.setPoint(
        { x: team === restartTeam ? sign * restartX : sign * (f.halfWidth * 0.35), y: spread },
        sigma,
      );
      m.lastFixT = this.now;
    }
  }

  // -- read-out ------------------------------------------------------------

  /** Deterministic stratified samples of one opponent's belief, for the decision layer. */
  opponentSamples(index: number, k: number): { pos: Vec2; weight: number }[] {
    const out: { pos: Vec2; weight: number }[] = [];
    this.opponents[index]?.grid.samples(k, out);
    return out;
  }

  /** How sure opponent `index` is about where I am right now: mass within `r` of my true spot. */
  mirrorMass(index: number, myPos: Vec2, r = 2.5): number {
    const m = this.mirrors[index];
    if (!m) return 0;
    return m.grid.massInCircle(myPos, r);
  }

  /** Seconds since any opponent had a hard fix on me — "how long have I been invisible". */
  secondsUnseen(): number {
    let newest = -99;
    for (const m of this.mirrors) newest = Math.max(newest, m.lastFixT);
    return clamp(this.now - newest, 0, 999);
  }

  /** Scratch buffer reuse for callers that need samples every decision. */
  sampleBuffer(): { pos: Vec2; weight: number }[] {
    return this.samplesBuf;
  }
}
