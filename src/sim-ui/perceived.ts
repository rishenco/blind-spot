/**
 * The model behind the right-hand pane: what one player knows.
 *
 * The only method that puts anything in is `ingest(frame)`, and its only argument is a
 * `PerceptionFrame`. There is no other entry point, no world reference, and no back channel —
 * which is the whole point of the double view. If this class ever needed the world to draw a
 * convincing picture, the perception contract would be wrong and the AI built on it would be a
 * lie.
 *
 * Everything in here fades. The previous prototype accumulated a permanent map; on an empty
 * rectangle that would be nonsense — the interesting thing is never the geometry, it is *where
 * people are now*, and that knowledge has to rot.
 */
import type {
  ControllerDebug,
  EntityId,
  ObservedEvent,
  PerceptionFrame,
  SonarHitKind,
  SoundKind,
  Vec2,
} from '../sim/types';

export interface Mark {
  pos: Vec2;
  kind: SoundKind;
  intensity: number;
  sigma: number;
  sigmaBearing: number;
  bearing: Vec2;
  sourceId: EntityId | null;
  self: boolean;
  relayed: boolean;
  born: number;
}

export interface SonarPoint {
  pos: Vec2;
  kind: SonarHitKind;
  sourceId: EntityId | null;
  vel: Vec2 | null;
  born: number;
}

export interface SonarSnapshot {
  pingId: number;
  origin: Vec2;
  firedAt: number;
  waveRadius: number;
  /** How far out the front has confirmed what is there — including where it found nothing. */
  checkedRadius: number;
  points: SonarPoint[];
}

export interface BallEstimate {
  pos: Vec2;
  sigma: number;
  sigmaBearing: number;
  bearing: Vec2;
  /** Finite difference of successive estimates — noisy, which is honest. */
  vel: Vec2;
  updatedAt: number;
}

export class PerceivedModel {
  readonly observer: EntityId;
  frame: PerceptionFrame | null = null;
  marks: Mark[] = [];
  sonar: SonarSnapshot[] = [];
  ball: BallEstimate | null = null;
  ballTrail: Vec2[] = [];
  selfTrail: Vec2[] = [];
  /** Kept for the panel: the last few things this player heard, newest first. */
  recent: ObservedEvent[] = [];
  /**
   * Whatever this player's controller chose to publish through `debugSnapshot()`.
   *
   * This is NOT perception — it is the bot talking about itself, and it is set by the playground,
   * never by `ingest`. It lives here only so the renderer has one object to draw from. A human
   * player has none, and a bot that fills it in cannot use it to see anything.
   */
  controllerDebug: ControllerDebug | null = null;

  private markLife: number;
  private sonarLife: number;
  private trailLength: number;

  constructor(observer: EntityId, markLife: number, sonarLife: number, trailLength = 90) {
    this.observer = observer;
    this.markLife = markLife;
    this.sonarLife = sonarLife;
    this.trailLength = trailLength;
  }

  reset(): void {
    this.frame = null;
    this.marks = [];
    this.sonar = [];
    this.ball = null;
    this.ballTrail = [];
    this.selfTrail = [];
    this.recent = [];
    this.controllerDebug = null;
  }

  ingest(frame: PerceptionFrame): void {
    this.frame = frame;
    const now = frame.match.t;

    for (const ev of frame.events) {
      this.marks.push({
        pos: ev.pos,
        kind: ev.kind,
        intensity: ev.intensity,
        sigma: ev.sigma,
        sigmaBearing: ev.sigmaBearing,
        bearing: ev.bearing,
        sourceId: ev.sourceId,
        self: ev.self,
        relayed: ev.relayed,
        born: now,
      });
      this.recent.unshift(ev);
    }
    if (this.recent.length > 12) this.recent.length = 12;

    for (const ret of frame.sonar) {
      let snap = this.sonar.find((s) => s.pingId === ret.pingId);
      if (!snap) {
        snap = {
          pingId: ret.pingId,
          origin: ret.origin,
          firedAt: ret.t,
          waveRadius: ret.waveRadius,
          checkedRadius: ret.sweptTo,
          points: [],
        };
        this.sonar.push(snap);
      }
      snap.waveRadius = ret.waveRadius;
      snap.checkedRadius = Math.max(snap.checkedRadius, ret.sweptTo);
      for (const hit of ret.hits) {
        snap.points.push({ pos: hit.pos, kind: hit.kind, sourceId: hit.sourceId, vel: hit.vel, born: now });
      }
    }

    const heardBall = frame.emitters.find((e) => e.kind === 'ball');
    if (heardBall) {
      const prev = this.ball;
      const dt = prev ? Math.max(1e-3, now - prev.updatedAt) : 1;
      this.ball = {
        pos: heardBall.pos,
        sigma: heardBall.sigma,
        sigmaBearing: heardBall.sigmaBearing,
        bearing: heardBall.bearing,
        vel: prev
          ? { x: (heardBall.pos.x - prev.pos.x) / dt, y: (heardBall.pos.y - prev.pos.y) / dt }
          : { x: 0, y: 0 },
        updatedAt: now,
      };
      this.ballTrail.push(heardBall.pos);
      if (this.ballTrail.length > this.trailLength) this.ballTrail.shift();
    }

    this.selfTrail.push({ x: frame.self.pos.x, y: frame.self.pos.y });
    if (this.selfTrail.length > this.trailLength) this.selfTrail.shift();

    this.prune(now);
  }

  /** Age-out. Marks live `markLife` seconds; a ping snapshot lives `sonarLife` after its last hit. */
  private prune(now: number): void {
    const markCut = now - this.markLife;
    if (this.marks.length > 0 && this.marks[0]!.born < markCut) {
      this.marks = this.marks.filter((m) => m.born >= markCut);
    }
    if (this.sonar.length > 0) {
      const sonarCut = now - this.sonarLife;
      for (const snap of this.sonar) snap.points = snap.points.filter((p) => p.born >= sonarCut);
      // A snapshot survives while it still has dots OR while its "I checked here" disc is fresh:
      // the absence it recorded is worth as much as the dots and must not vanish first.
      this.sonar = this.sonar.filter((s) => s.points.length > 0 || now - s.firedAt < this.sonarLife);
    }
  }

  /** 0..1 freshness of a mark, for the renderer's alpha ramp. */
  markAlpha(m: Mark, now: number): number {
    const age = now - m.born;
    return Math.max(0, 1 - age / this.markLife);
  }

  sonarAlpha(p: SonarPoint, now: number): number {
    const age = now - p.born;
    return Math.max(0, 1 - age / this.sonarLife);
  }
}
