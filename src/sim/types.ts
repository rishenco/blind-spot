/**
 * BLIND HANDBALL — shared vocabulary of the 2D simulation.
 *
 * Three layers meet in this file and they are deliberately kept apart:
 *
 *   1. WORLD   — the truth. `WorldState`, `PlayerState`, `BallState`. Only the simulation and
 *                the truth renderer are allowed to hold one.
 *   2. SOUND   — what the world emits. `SoundEvent`, produced by physics and actions, never by
 *                a script or a trigger volume (concept, law 3).
 *   3. PERCEPT — what one observer got out of it. `PerceptionFrame`. This is the ONLY input a
 *                controller (human UI or bot) ever receives.
 *
 * The separation is structural, not a convention: a `PerceptionFrame` contains plain copied
 * numbers, has no reference to any world object, and a `Controller` is handed nothing else.
 * There is no code path from a controller back into the world short of returning an `Intent`.
 */

/** Player ids are 0..2N-1 (0..N-1 = team 0, N..2N-1 = team 1). The ball uses BALL_ID. */
export type EntityId = number;
export const BALL_ID = -1;
export type TeamId = 0 | 1;

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Every noise in the game. One kind = one row of the loudness table in the concept, and the
 * table lives in `SimConfig.loudness` so tuning never means editing code.
 */
export type SoundKind =
  | 'step-walk'
  | 'step-run'
  | 'brake'
  | 'dive'
  | 'catch'
  | 'fumble'
  | 'throw'
  | 'ball-hum'
  | 'ball-wall'
  | 'sonar'
  | 'whistle';

/**
 * `'ball-hum'` is the odd one out: it is NOT emitted as a discrete event. The ball is a
 * continuous emitter (see `ContinuousEmitter`) — it sings without pause, so turning it into 60
 * marks a second would flood every consumer and would misdescribe what an observer actually
 * gets, which is a running estimate of one position rather than a stream of separate facts. The
 * row stays in the loudness table because the emitter's audible radius is read from it.
 */

/**
 * A sound as the world made it: exact position, exact source.
 *
 * `intensity` is the audible radius in metres — the concept's loudness table is a table of
 * radii, so keeping loudness in the same unit means "can I hear it" is one comparison and
 * needs no calibration curve. Nothing downstream is allowed to read a `SoundEvent`; observers
 * get `ObservedEvent`s, which are these run through `perceive`.
 */
export interface SoundEvent {
  t: number;
  tick: number;
  kind: SoundKind;
  pos: Vec2;
  /** Audible radius in metres. */
  intensity: number;
  /** Who made it. Stripped for opponents on the way to an observer. */
  sourceId: EntityId;
}

/** What one observer got out of one `SoundEvent`. Noisy position, possibly anonymous source. */
export interface ObservedEvent {
  /** Sim time at which the observer *received* it (emission + reaction latency). */
  t: number;
  /** Sim time at which it happened, as far as the observer can tell (== emission time). */
  emittedAt: number;
  kind: SoundKind;
  /** Localised position: true position plus hearing error. Never the exact one unless sigma is 0. */
  pos: Vec2;
  /** Audible radius of the event in metres — a loudness cue, heard honestly. */
  intensity: number;
  /**
   * Along-bearing standard deviation (m) of the error that was applied — the big axis of the
   * error cigar, and the observer's honest uncertainty about *how far away* the sound was.
   */
  sigma: number;
  /** Across-bearing standard deviation (m) — the small axis. Ears point better than they range. */
  sigmaBearing: number;
  /**
   * Unit vector from the observer to the reported position: the axis the cigar lies along.
   * Handed over so a consumer can stamp the right ellipse into a belief grid without having to
   * re-derive the geometry (and get it subtly wrong).
   */
  bearing: Vec2;
  /** Distance from the observer to the reported position at the moment of hearing. */
  distance: number;
  /** Self, teammate and ball keep their identity; opponents come through as null. */
  sourceId: EntityId | null;
  /** True when this observer made the sound. */
  self: boolean;
  /** True when this arrived over the team channel (voice) rather than the observer's own ears. */
  relayed: boolean;
}

/**
 * A source that never stops sounding. The ball is the only one in v1.
 *
 * An observer does not receive marks from it; it receives a continuously updated, noisy
 * estimate of where it is (`ObservedEmitter`). That is what "мяч слышен всегда" really means:
 * you always know roughly where the ball is, and never exactly.
 */
export interface ContinuousEmitter {
  id: EntityId;
  kind: 'ball';
  pos: Vec2;
  vel: Vec2;
  /** Audible radius in metres. */
  intensity: number;
}

/**
 * One continuous emitter as one observer hears it, this tick.
 *
 * The error is a *smoothed* random walk, not fresh noise every tick: independent per-tick noise
 * would let anyone average 60 samples a second and recover the exact position for free, which
 * would quietly delete the game's uncertainty. `SimConfig.perception.emitterNoiseSmoothing`
 * controls how long an error persists.
 */
export interface ObservedEmitter {
  id: EntityId | null;
  kind: 'ball';
  /** Noisy estimate of the emitter's position. */
  pos: Vec2;
  /** Along-bearing sigma (m) — the long axis of the error. */
  sigma: number;
  /** Across-bearing sigma (m) — the short axis. */
  sigmaBearing: number;
  /** Unit vector from the observer to the reported position. */
  bearing: Vec2;
  /** Distance from the observer to the reported position. */
  distance: number;
}

export type SonarHitKind = 'wall' | 'crease' | 'player' | 'ball';

/** One point returned by an active ping. Geometry and bodies come back in the same list. */
export interface SonarHit {
  pos: Vec2;
  kind: SonarHitKind;
  /** Same anonymity rule as sounds: opponents come back as null. */
  sourceId: EntityId | null;
  /** Velocity is only ever known for the ball and for identified bodies; null otherwise. */
  vel: Vec2 | null;
}

/**
 * What an own ping sends back, one tick's worth.
 *
 * A ping is a travelling front, not an instant photograph (inherited from the previous
 * prototype's lidar, and better for this game): a point lights up at `t + distance/waveSpeed`,
 * so near geometry resolves before far geometry and a body can physically outrun the front.
 * `SimConfig.ping.waveSpeed = Infinity` collapses this back to an instant snapshot — both
 * variants are shot as keyframes so the look can be chosen by eye.
 *
 * `hits` are only the points that lit up *this* tick. Consumers accumulate and fade them
 * themselves; nothing in the simulation keeps a ping alive.
 */
export interface SonarReturn {
  /** Monotonic id of the ping this belongs to — successive frames share it. */
  pingId: number;
  /** Sim time at which the ping was fired. */
  t: number;
  origin: Vec2;
  range: number;
  /** How far the front has travelled by the end of this tick. */
  waveRadius: number;
  /**
   * The region this tick's sweep actually checked: the annulus between `sweptFrom` and
   * `sweptTo`, restricted to the cone `aim ± acos(coneCos)`.
   *
   * This is the negative half of the answer, and it matters as much as the positive one:
   * anything inside that sector would have come back as a hit, so anything NOT in `hits` was
   * genuinely not there. A belief that only ever grows from hits believes in ghosts forever;
   * this is what lets it carve them out.
   */
  sweptFrom: number;
  sweptTo: number;
  aim: Vec2;
  /** Cosine of the cone's half-angle. -1 for the 360° ping. */
  coneCos: number;
  hits: SonarHit[];
  /** True on the tick the front reaches full range: nothing more will come from this ping. */
  complete: boolean;
}

/** Proprioception: what a body knows about itself without hearing anything. Always honest. */
export interface SelfState {
  id: EntityId;
  team: TeamId;
  pos: Vec2;
  vel: Vec2;
  aim: Vec2;
  speed: number;
  hasBall: boolean;
  charging: boolean;
  chargeT: number;
  pingCooldown: number;
  diving: boolean;
  recovering: boolean;
  /** Audible radius of the noise this body is making right now — the concept's "am I loud" readout. */
  ownLoudness: number;
}

export type MatchPhase = 'restart' | 'play' | 'over';

/** Public, non-secret match facts: everyone hears the whistle and knows the score. */
export interface MatchInfo {
  t: number;
  tick: number;
  phase: MatchPhase;
  score: readonly [number, number];
  /** Seconds left on the match clock. */
  timeLeft: number;
}

/** Static geometry. The pitch is not a secret — players know the field they are standing on. */
export interface FieldInfo {
  width: number;
  height: number;
  halfWidth: number;
  halfHeight: number;
  goalWidth: number;
  creaseRadius: number;
  /** Goal centres, indexed by the team that DEFENDS them. */
  goalCentre: readonly [Vec2, Vec2];
}

/**
 * The whole input of a controller for one tick. No world reference, by construction.
 *
 * `events` and `sonar` are only what arrived since the previous frame — a controller that wants
 * history keeps its own, which is exactly the belief layer the AI agent will build.
 */
export interface PerceptionFrame {
  self: SelfState;
  match: MatchInfo;
  field: FieldInfo;
  events: readonly ObservedEvent[];
  /** Continuous sources audible right now — in v1, the ball and nothing else. */
  emitters: readonly ObservedEmitter[];
  sonar: readonly SonarReturn[];
  /**
   * The radius within which this observer WOULD have heard each kind of sound, given the
   * loudness table and its own hearing. Silence is information: no `step-run` in this frame
   * means nobody ran within `hearing['step-run']` metres of here, and a belief layer is
   * expected to use that to shrink itself rather than to wait for evidence that never comes.
   */
  hearing: Readonly<Record<SoundKind, number>>;
  /** Team-mates' ids (excluding self) — knowing who is on your team is not intel about where. */
  teammates: readonly EntityId[];
  opponents: readonly EntityId[];
}

export type MoveMode = 'walk' | 'run';

/**
 * A controller's whole output. Everything is a *request*; the simulation decides what happens
 * (a dive during recovery is ignored, a ping on cooldown is ignored, and so on).
 *
 * `charge` is a held button: the throw fires on the falling edge, with the direction of `aim`
 * at the moment of release. `ping`, `catch` and `dive` are read as rising edges.
 */
export interface Intent {
  /** Desired movement direction. Length > 1 is clamped; length 0 means "stand still". */
  move: Vec2;
  moveMode: MoveMode;
  /** Facing / throw direction. Length 0 keeps the previous aim. */
  aim: Vec2;
  ping: boolean;
  charge: boolean;
  catch: boolean;
  dive: boolean;
}

export function idleIntent(): Intent {
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

/** Optional, renderer-agnostic debug output of a controller. The playground draws whatever is here. */
export interface ControllerDebug {
  /** One-line state label, e.g. "intercept" or "hold — silent". */
  label?: string;
  /** Free-form key/value readouts shown in the player panel. */
  readouts?: Record<string, string | number>;
  /**
   * Belief clouds: weighted position hypotheses about somebody. Drawn as dots whose alpha is
   * the weight. This slot is empty in this milestone — it is the AI agent's to fill.
   */
  beliefs?: BeliefCloud[];
  /** Arbitrary annotations (a target point, an intercept point, a corridor). */
  markers?: DebugMarker[];
  /** Considered actions with their scores; the playground shows the top few. */
  scores?: { action: string; score: number }[];
}

export interface BeliefCloud {
  /** Who this cloud is about, or a free label when the source is anonymous. */
  about: EntityId | string;
  /** Age of the newest evidence behind it, seconds. */
  age: number;
  /** 0..1 summary confidence, used for the overlay's opacity scale. */
  confidence: number;
  points: { pos: Vec2; weight: number }[];
}

export interface DebugMarker {
  kind: 'point' | 'line' | 'circle';
  pos: Vec2;
  /** Second endpoint for 'line', ignored otherwise. */
  to?: Vec2;
  /** Radius for 'circle'. */
  r?: number;
  label?: string;
  /** CSS colour; the playground has a default. */
  color?: string;
}

/** Everything a controller is told once, at construction/reset time. */
export interface ControllerContext {
  self: EntityId;
  team: TeamId;
  teammates: readonly EntityId[];
  opponents: readonly EntityId[];
  field: FieldInfo;
  /** Read-only view of the tuning numbers. Not a way into the world. */
  config: SimConfigView;
  /** A private, seeded stream. Using `Math.random()` anywhere is a determinism bug. */
  rng: () => number;
}

/**
 * The contract every brain implements — human input adapter, dummy strategy, and the future AI.
 *
 * `onPerceive` is called once per tick with that tick's fresh perception; `decide` is called
 * right after and must return an intent. They are separate on purpose: the AI's belief update
 * belongs in `onPerceive`, its policy in `decide`, and keeping them apart makes it obvious in a
 * profile which half costs what.
 */
export interface Controller {
  readonly name: string;
  reset?(ctx: ControllerContext): void;
  onPerceive?(frame: PerceptionFrame): void;
  decide(dt: number): Intent;
  /** Called by the debug playground only. Must be cheap and must not mutate anything. */
  debugSnapshot?(): ControllerDebug | null;
}

/** Config as controllers see it: the same object, typed deeply read-only. */
export type SimConfigView = DeepReadonly<import('./config').SimConfig>;

export type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
