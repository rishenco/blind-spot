/**
 * All tuning in one object.
 *
 * Rule for this file: if a number decides how the game feels, it lives here and nowhere else.
 * The values are the concept's first pass — they are tuning, not law. The two things that are
 * law and are still expressed as numbers (the loudness table's *shape*, and the fact that a
 * ping is the loudest event in the game) are marked as such in comments.
 */
import type { SoundKind } from './types';

export interface FieldConfig {
  /** Long axis, metres. Goals sit on the short walls at x = ±width/2. */
  width: number;
  /** Short axis, metres. */
  height: number;
  /** Goal mouth length, centred on the short wall. */
  goalWidth: number;
  /** Goalkeeper crease: nobody may enter this arc around a goal centre. */
  creaseRadius: number;
  /** How much speed a ball keeps when it bounces off a wall. */
  wallRestitution: number;
  /**
   * A loose ball that lingers this long inside a crease is handed to the defending team.
   *
   * Not in the concept, and unavoidable: nobody may enter a crease, so a ball that stops in
   * there is a ball nobody can ever reach — the match simply stops. This is the goalkeeper
   * throw that the concept's "вратаря как роли нет" would otherwise leave a hole where.
   */
  creaseBallTimeoutSec: number;
}

/**
 * The goalkeeper — added 2026-08-25, and it is a rule change, not a tuning number.
 *
 * The concept says the crease is forbidden to *everybody*. Real handball says the crease belongs
 * to the keeper, and the difference is the whole match: with nobody allowed inside four metres
 * of the goal, the mouth is open by rule, so "get to the ball first and throw it at the empty
 * net" is not a degenerate bot strategy, it is the correct one. Giving one body per team the
 * right to stand in there is the smallest change that puts something in the way.
 *
 * The role is assigned by the simulation, never by a button: this is 2×2 played on a jam, and a
 * game whose central mechanic is listening cannot also ask a player to manage a depth chart.
 */
export interface KeeperConfig {
  enabled: boolean;
  /**
   * How much nearer his own goal another body has to be before the gloves change hands.
   *
   * Hysteresis, and it has to be generous: the role decides who may stand inside the crease, so
   * a role that flickers is a body being shoved out of the crease by the rules twice a second.
   */
  switchMargin: number;
  /** Multiplier on the catch reach while the keeper is inside his own crease. */
  reachMul: number;
  /**
   * How far from the centre of his goal the keeper stands while defending, metres.
   *
   * The one number that decides whether goalkeeping is a guess. Deep on his line he sees the
   * whole mouth open in front of him and has to pick a half; stepping out closes the angle until
   * his arms cover everything and the shooter has nothing left to aim at. Real keepers live on
   * that trade and so does this one.
   */
  depth: number;
  /** And how far out he steps when his own team has the ball: the outlet, not the last man. */
  attackDepth: number;
  /** Dive cooldown multiplier inside the crease: a keeper's dive along his line is cheap. */
  diveCooldownMul: number;
  /** Dive recovery multiplier inside the crease. */
  diveRecoveryMul: number;
}

export interface MatchConfig {
  goalsToWin: number;
  durationSec: number;
  /** Frozen seconds after a goal before play resumes. */
  restartDelaySec: number;
  /**
   * Seeded jitter (metres) applied to every kickoff position.
   *
   * Without it a match between two deterministic strategies is the same match for every seed —
   * 200 "different" runs produce one result, and the batch runner measures nothing. This is the
   * only randomisation in the setup, and it is drawn from the simulation's own seeded stream.
   */
  spawnJitter: number;
  /**
   * Who kicks off. 'fixed' = team 0 always, which is the concept as written; 'alternate' gives
   * the ball to the team chosen by the seed's parity.
   *
   * It matters for measurement, not for play: the side that kicks off has a real advantage, so
   * with 'fixed' a tournament between two deterministic strategies produces the same result on
   * every seed. The batch runner alternates by default for exactly that reason.
   */
  kickoffTeam: 'fixed' | 'alternate';
  /**
   * Passivity rule: a carrier that holds the ball longer than this loses it to the nearest
   * opponent. 0 turns it off.
   *
   * It is ON by default because the concept asks for it in so many words ("держать мяч дольше
   * 5 с нельзя" — real handball's three-second rule, stretched). It was previously off, and
   * with no contact and no tackle in v1 that left a hole big enough to drive a strategy
   * through: a carrier could simply stand still forever and no opponent had any way to object.
   * The rule is what turns this into a game of passing rather than a game of walking the ball
   * in, which is the point the concept makes about it.
   */
  carryTimeoutSec: number;
}

export interface PlayerConfig {
  radius: number;
  /** m/s² — same acceleration for speeding up and braking. */
  accel: number;
  runSpeed: number;
  walkSpeed: number;
  /** Metres of travel between footstep sounds. */
  strideLength: number;
  /**
   * A speed drop bigger than this within `brakeWindowSec` counts as an audible stop.
   *
   * It has to sit above the walking speed and above the run→walk difference, or "walk quietly
   * into position and stand still" — the concept's central tactical resource — emits an 11 m
   * brake every single time it is used, and silence becomes unreachable for anybody who ever
   * moved. See the AI report; this was 2.5 (exactly `walkSpeed`) and nothing could ever arrive
   * anywhere quietly.
   */
  brakeSpeedDrop: number;
  brakeWindowSec: number;
  /** cos of the turn angle that counts as an audible direction change (0 = 90°). */
  brakeTurnCos: number;
  /** Minimum gap between two brake sounds from the same body. */
  brakeCooldownSec: number;
  /** Minimum speed at which a sharp turn counts as an audible direction change. */
  brakeTurnMinSpeed: number;
  /**
   * Window over which a turn is measured, seconds.
   *
   * It cannot be `brakeWindowSec`: a body at 5.5 m/s with 18 m/s² of grip needs about 0.43 s to
   * swap its velocity through ninety degrees, so a 0.2 s window sees forty degrees of it and a
   * hard cut is silent. Long enough to contain a real cut, short enough that jogging round a
   * wide arc never accumulates into one.
   */
  brakeTurnWindowSec: number;
  /** Minimum gap between two shouts for the ball. */
  callCooldownSec: number;
}

/**
 * The ball's voice — the biggest design change in the project, decided by the человек after
 * playing: *«в руках молчит, но всё же периодически пингует… стоит подумать, как сделать, чтобы
 * надо было постоянно пасовать»*.
 *
 * Before this, the ball hummed across the whole pitch without pause, in flight and in the hands
 * alike. One line of consequences followed from it and it explains almost every complaint about
 * the build: the only fact anybody needed was given away for free → everybody converged on the
 * ball → permanent scrimmage → permanent noise → nothing was ever hidden → silence never
 * happened → a ping had nothing to ask about → positioning was pointless and running was
 * everything.
 *
 * Now a carried ball is SILENT for a moment and then begins to beep, faster and louder the
 * longer one pair of hands keeps it. Passing resets it for both men, so a pass is not a duty
 * imposed by a timer — it is how you become invisible again. Carrying the ball stays legal and
 * stays fast (concept law 5: no weight, no speed penalty); it just gets audibly more expensive,
 * and the carrier hears his own price rising before anybody else acts on it.
 */
export interface BallVoiceConfig {
  /** Seconds of complete silence after the ball changes hands. The reward for a pass. */
  quietSec: number;
  /** Beep period at the end of the quiet window, and at the end of the ramp. */
  intervalStart: number;
  intervalMin: number;
  /** Seconds of holding over which period and loudness travel from start to full. */
  rampSec: number;
  /** First beep's audible radius as a fraction of the `ball-carry` row of the loudness table. */
  startLoudFrac: number;
}

export interface BallConfig {
  radius: number;
  /** m/s² of ground friction while loose. */
  friction: number;
  restitution: number;
  /** How far in front of the carrier's centre the ball is held. */
  carryOffset: number;
  /** The ball sings on this period while it exists (loose or carried). */
  humIntervalSec: number;
  /** How a carried ball gives its holder away. See `BallVoiceConfig`. */
  voice: BallVoiceConfig;
  /** Whether a throw adds the carrier's velocity. Off: a throw is a throw, not a slingshot. */
  inheritCarrierVelocity: boolean;
  /** Below this speed a loose ball is considered stopped. */
  restSpeed: number;
}

export interface CatchConfig {
  /** How far the hands reach at walking pace, for a ball that is barely moving. */
  radius: number;
  /**
   * Catching is automatic — a ball inside the reach is caught, with no button at all.
   *
   * This cancels the concept's "ловля — действие с таймингом", and the человек cancelled it
   * himself after playing: "поймать автоматом, правую кнопку не юзать". The timing was a test of
   * reaction inside a game that is already a test of hearing, and it spent the game's one spare
   * mouse button on it.
   *
   * What replaces the timing as the skill is `catchSpeedSpan` below: the faster the ball, the
   * smaller the area it can be taken in. A lob is caught by being roughly there; a 16 m/s shot
   * has to hit your hands. So receiving a pass is still a thing you can be bad at — it is now a
   * question of standing in the right place rather than of pressing at the right millisecond.
   */
  auto: boolean;
  /**
   * Relative speed, above `slowBallSpeed`, at which the reach has shrunk to `minReachFrac`.
   *
   * This is the whole difficulty curve of catching and of intercepting, in one number.
   */
  catchSpeedSpan: number;
  /** Floor of the shrinking reach, as a fraction of `radius`. */
  minReachFrac: number;
  /** Above this own speed a body is sprinting and cannot take a hard ball cleanly. */
  sprintSpeed: number;
  /** Relative ball speed above which a sprinting body fumbles instead of catching. */
  sprintBallSpeed: number;
  /**
   * How long one press keeps the hands open, seconds — and the whole of what makes a catch an
   * action with a timing rather than a proximity test.
   *
   * The rule it replaces was "press within ±`windowSec` of the moment of closest approach", and
   * arithmetic killed it: a ball at 16 m/s crosses a 1.2 m reach in 150 ms, which is narrower
   * than the ±180 ms window, so the window was never the binding constraint. Worse, the late
   * half of it was physically unreachable — the ball meets the body (0.47 m) before it reaches
   * closest approach, so every failed catch was "grabbed too early" and no other outcome existed.
   *
   * Opening a window instead makes both halves real: press too early and the hands shut before
   * the ball arrives; press too late and it hits you with them shut, which is a fumble.
   */
  reachSec: number;
  /** How long the hands stay shut after a reach lapses. Stops the button being held down. */
  reachCooldownSec: number;
  /** A body cannot touch the ball again for this long after releasing or fumbling it. */
  cooldownSec: number;
  /**
   * Below this relative speed the ball is not "in flight" and is simply picked up: the timing
   * window applies to catching a *pass*, not to bending down for a ball at your feet. Without
   * this, the concept's numbers make a resting ball uncatchable — the ±0.18 s window around
   * closest approach is narrower than the distance it takes to walk into the ball at all.
   */
  slowBallSpeed: number;
  /**
   * A body only fumbles a ball that hits it hard enough to be heard as a mistake. A ball
   * trickling past your ankles is not a 20 m event.
   */
  contactFumbleMinSpeed: number;
  /** Speed the ball keeps after a fumble. */
  fumbleSpeed: number;
  /** Random angular scatter of a fumble, radians (deterministic — from the sim's own stream). */
  fumbleScatter: number;
}

export interface ThrowConfig {
  /** Charge below this is a weak lob; above it, speed scales up to maxCharge. */
  minCharge: number;
  maxCharge: number;
  /** Release speed at zero charge, at minCharge, and at maxCharge (m/s). */
  weakSpeed: number;
  minSpeed: number;
  maxSpeed: number;
}

export interface DiveConfig {
  durationSec: number;
  recoverySec: number;
  speed: number;
  cooldownSec: number;
}

export interface PingConfig {
  cooldownSec: number;
  /** Snapshot radius, metres. */
  range: number;
  /**
   * Speed of the revealing front, m/s. A readable speed, not a physical one: a point lights up
   * at `t + distance/waveSpeed`. `Infinity` turns the ping back into an instant snapshot.
   */
  waveSpeed: number;
  /** Aperture in degrees, centred on the pinger's aim. 360 = the concept's omni ping. */
  coneDeg: number;
  /** Wall geometry is returned as points sampled this far apart. */
  wallSampleStep: number;
  /**
   * How long a return stays legible — a renderer/belief hint, not physics. Unlike the previous
   * prototype, nothing accumulates into a permanent map: on an empty rectangle a map that never
   * dies would delete the game. This is a melting snapshot, and it melts to nothing.
   */
  lifeSec: number;
}

/**
 * Perception knobs. Everything that separates "what happened" from "what an observer got".
 *
 * These are the difficulty dial for the AI as well: the honest default is the human's channel,
 * and every knob that moves away from it must be a knob and not a hardcoded exception.
 */
export interface PerceptionConfig {
  /** Multiplies every event's audible radius for this observer. 1 = the concept's table. */
  hearingScale: number;
  /** Localisation error grows with distance: sigma = perMeter · d, capped. */
  localizationSigmaPerMeter: number;
  localizationSigmaCap: number;
  /**
   * Angular precision of hearing, in degrees. Ears point well and range badly, so the error
   * cloud is a cigar lying along the line from the listener to the source, not a disc:
   * across-bearing sigma is `d · tan(bearingDeg)`, along-bearing sigma is `d ·
   * localizationSigmaPerMeter`.
   *
   * This is what makes triangulation a real mechanic rather than a cheat: two team-mates'
   * cigars crossing at an angle pin a position that neither of them has on its own, which is
   * the gameplay reason `teamShare` exists.
   */
  localizationBearingDeg: number;
  /** Strip `sourceId` from opponents' sounds (data association becomes the listener's problem). */
  anonymousSources: boolean;
  /** Delay between a sound happening and the observer receiving it. Humans need ~0.2–0.3 s. */
  reactionLatencySec: number;
  /**
   * Reserved cheat dial, 0..1: blends the true position into the reported one.
   * 0 = honest, 1 = telepathy. The simulation implements it; nothing uses it by default.
   */
  truthLeak: number;
  /** Team channel: teammates share what they heard (already noisy, tagged `relayed`). */
  teamShare: boolean;
  /**
   * Kinds heard with no localisation error at all. The concept says a ping is heard by the
   * whole pitch *with the pinger's exact position* — that is the price that makes the ping a
   * real decision, so it is spelled out here rather than hidden in the perception code.
   */
  exactKinds: SoundKind[];
  /**
   * The pure cheat dial, in hertz: how often this observer is simply *told* where every body is.
   * 0 = off, which is every honest configuration.
   *
   * It exists because the concept's headline test — "a telepath must beat an honest bot" — could
   * not be asked without it. `truthLeak` only removes the localisation error from sounds the
   * observer already heard, so it cannot help against the thing that actually hides a body in
   * this game, which is standing still and making none. Measured, `truthLeak = 1` on its own is
   * worth almost nothing, and reading that as "information is worthless" would have been reading
   * the instrument rather than the game.
   *
   * Delivered as a synthetic sonar return covering the whole pitch, because that channel already
   * carries exact positions AND the negative half ("nobody else is anywhere"), which is what
   * telepathy means. Nothing in the game turns it on.
   */
  xrayHz: number;
  /** Sound marks are drawn/decayed over this window — a renderer hint, kept here to stay tunable. */
  markerLifeSec: number;
  /**
   * Temporal correlation of a continuous emitter's localisation error, per tick, 0..1.
   * 0 = fresh independent noise every tick (which a listener could average away for free),
   * 1 = a constant offset that never changes. 0.97 at 60 Hz is an error that persists ~0.5 s.
   */
  emitterNoiseSmoothing: number;
}

/**
 * A bag the simulation never reads. It exists so the AI agent has a home for its own knobs
 * inside the one config object the whole project already passes around and serialises.
 */
export interface AiConfig {
  /** How fast a belief loses confidence with no evidence (1/s). */
  beliefDecay: number;
  /** How greedy the policy is: 0 = first acceptable action, 1 = full search. */
  decisionQuality: number;
  /**
   * How many past observations of a continuous emitter a bot is allowed to keep and average.
   * The simulation does not read it — it is reserved here because the research pass identified
   * unbounded averaging of the ball's hum as the one honesty hole that no perception knob can
   * close on its own (the correlated error above closes most of it, this bounds the rest).
   */
  observationMemory: number;
  /**
   * Free-form room for the rest. Everything the bot reads goes through here, which is what lets
   * a tournament sweep it (`npm run tune`) and a replay carry it. The keys in use today:
   *
   *   belief    `beliefCell` `mirrorCell` `beliefHz` `beliefFloor` `wStand` `wWalk` `wRun`
   *             `pDetectSonar` `sonarShrink` `pDetectHear` `dirHintLife`
   *   policy    `posMul` `safeMul` `quietMul` `infoMul` `deceiveMul` `positionDiscount`
   *             `shotRangeSpan`
   *
   * Their defaults live next to the code that reads them (`ai/belief.ts`, `ai/policy.ts`), so an
   * absent key always means "the default", never "zero".
   */
  [key: string]: number | boolean | string;
}


/**
 * The fight for the ball — added 2026-08-25, and it replaces the earlier decision that v1 would
 * have no contact at all.
 *
 * That decision was measured rather than argued about, and it failed: with no way to take the
 * ball off a carrier, knowing where an opponent is buys nothing you can act on, so a telepathic
 * bot played exactly as well as an honest one and never pinged in its life. Everything in this
 * block exists to give knowledge something to be spent on. Each mechanic is a separate switch
 * so the rule tournament (`npm run contest`) can price them one at a time.
 */
export interface StealConfig {
  enabled: boolean;
  /** An opponent inside this radius of the carrier is contesting the ball. */
  radius: number;
  /** Contiguous seconds of contest needed to take it. */
  holdSec: number;
  /** The thief must be pressing catch: a timed action rather than a walk-in. */
  requirePress: boolean;
  /** The thief must be moving at least this fast. 0 = standing next to him is enough. */
  minSpeed: number;
  /** The ball comes loose instead of changing hands. */
  knockLoose: boolean;
  /** Nobody can be robbed again for this long — otherwise a steal instantly bounces back. */
  graceSec: number;
}

export interface TackleConfig {
  /** A dive that passes close to a body knocks it down. Extends the existing `dive`. */
  enabled: boolean;
  /** Centre-to-centre distance at which a diving body catches an opponent. */
  radius: number;
  /** How long the victim lies there: noisy, helpless, and out of the play. */
  stunSec: number;
  /** A diver who hit nothing lies there for `dive.recoverySec * missPenalty`. */
  missPenalty: number;
  /** A tackled carrier loses the ball. */
  dropsBall: boolean;
}

export interface CollisionConfig {
  /** Bodies stop passing through each other. This is also what makes a screen a real thing. */
  enabled: boolean;
  restitution: number;
  /** Closing speed above which the bump rings out and staggers both bodies. */
  loudSpeed: number;
  /** Seconds of lost control after a hard bump. */
  staggerSec: number;
  /** A carrier in a hard collision loses the ball. */
  dropsBall: boolean;
}

/**
 * What happens when a ball nobody timed meets a body.
 *
 * `'always'` is the v1 rule and it is why two parked defenders were unbeatable: any contact
 * above `catching.contactFumbleMinSpeed` was a guaranteed fumble, so a body on the line was an
 * absolute wall. `'speed'` makes a hard shot likely to go straight past a defender who did not
 * time it — which turns blocking into an action instead of a piece of furniture.
 */
export interface BlockConfig {
  mode: 'always' | 'speed';
  /** Ball speed above `contactFumbleMinSpeed` at which stopping probability reaches `minStop`. */
  speedSpan: number;
  /** Floor of the stopping probability, however hard the shot. */
  minStop: number;
  /** A body pressing catch, or diving, stops anything it touches. Blocking as a decision. */
  activeAlwaysStops: boolean;
}

export interface ContestConfig {
  steal: StealConfig;
  tackle: TackleConfig;
  collision: CollisionConfig;
  block: BlockConfig;
}

export interface SimConfig {
  /** Fixed simulation step. Never read from a wall clock anywhere. */
  dt: number;
  /** Players per team. Ids 0..teamSize-1 are team 0, the rest team 1. */
  teamSize: number;
  field: FieldConfig;
  match: MatchConfig;
  player: PlayerConfig;
  ball: BallConfig;
  catching: CatchConfig;
  throwing: ThrowConfig;
  dive: DiveConfig;
  keeper: KeeperConfig;
  ping: PingConfig;
  /**
   * The loudness table — concept, "одна таблица на всю игру". Values are audible radii in
   * metres. The ordering is the law (ping loudest, standing still silent); the numbers are not.
   */
  loudness: Record<SoundKind, number>;
  perception: PerceptionConfig;
  /**
   * Per-team overrides of the perception knobs, indexed by team id. Absent = both teams share
   * `perception`, which is what every match used to do.
   *
   * It exists because the concept's headline test needs it: "does a telepath beat an honest
   * bot" is a question about ONE side's channel, and a single global `truthLeak` turns the dial
   * for both of them at once, which measures nothing. Only the keys present are overridden.
   */
  perceptionByTeam?: (Partial<PerceptionConfig> | null)[];
  contest: ContestConfig;
  ai: AiConfig;
}

/** The perception knobs one team actually plays with: the globals, with its own overrides on top. */
export function perceptionFor(cfg: SimConfig, team: number): PerceptionConfig {
  const over = cfg.perceptionByTeam?.[team];
  if (!over) return cfg.perception;
  return { ...cfg.perception, ...over, exactKinds: [...(over.exactKinds ?? cfg.perception.exactKinds)] };
}

/** The concept's table, verbatim. */
/**
 * The concept's table (v0.2). The numbers came down deliberately: the half-diagonal of a 24×14
 * pitch is 13.9 m, so the first pass (12/14/18/20 m) meant almost everything was audible from
 * almost everywhere and distance stopped being a dimension of the game at all.
 *
 * The two rows that ARE the whole pitch — the ball's hum and a ping — are that way on purpose.
 * Field size and this table are one tuning surface, not two, which is why the batch runner can
 * sweep them together (`npm run batch -- --sweep`).
 */
export const DEFAULT_LOUDNESS: Record<SoundKind, number> = {
  'step-walk': 3,
  'step-run': 9,
  brake: 11,
  dive: 11,
  catch: 5,
  fumble: 14,
  throw: 13,
  'ball-hum': 30,
  // The carried ball, at the top of its ramp. A man who has held it for five seconds is audible
  // from most of the pitch; a man who has just taken a pass is audible from nowhere. The row is
  // the ceiling — `ball.voice` says how fast he climbs it.
  'ball-carry': 22,
  'ball-wall': 14,
  // A ball whistling past a body that did not react. Quiet on purpose — it is feedback for the
  // man it went past, not an announcement to the pitch — but never silence: a mechanic that
  // punishes you without making a sound is invisible, and invisible punishment reads as a bug.
  'ball-near': 3.5,
  // A change of possession is always audible. It has to be: the ball is the one thing everybody
  // can hear, so a ball that changes hands in silence tells the whole pitch a lie.
  steal: 9,
  // A shout. Same radius as a run: loud enough to reach a team-mate across half the pitch, and
  // loud enough that asking for the ball tells the defence where you are asking from.
  call: 9,
  sonar: 40,
  whistle: 100,
};

/** The rows that are meant to cover the whole pitch whatever its size. Sweeps leave them alone. */
export const WHOLE_FIELD_KINDS: SoundKind[] = ['ball-hum', 'sonar', 'whistle'];

/**
 * Scales every distance-limited row of the loudness table. Used by the field/loudness sweep:
 * shrinking the pitch without shrinking the table changes nothing, so the two move together.
 */
export function scaleLoudness(cfg: SimConfig, factor: number): void {
  for (const key of Object.keys(cfg.loudness) as SoundKind[]) {
    if (WHOLE_FIELD_KINDS.includes(key)) continue;
    cfg.loudness[key] = cfg.loudness[key] * factor;
  }
}

/** Resizes the pitch, keeping the goal and crease in proportion to the short axis. */
export function resizeField(cfg: SimConfig, width: number, height: number): void {
  const k = height / cfg.field.height;
  cfg.field.goalWidth *= k;
  cfg.field.creaseRadius *= k;
  cfg.field.width = width;
  cfg.field.height = height;
}

export function defaultConfig(): SimConfig {
  return {
    dt: 1 / 60,
    teamSize: 2,
    field: {
      width: 24,
      height: 14,
      // The concept revised both of these after the first simulation pass and the config never
      // followed: a 3 m mouth in a 14 m wall was walk-in-and-place, and a 22 m/s release covered
      // eight metres in 0.36 s, which is less than anybody's reaction time — a shot that fast is
      // not a shot, it is a scoring button.
      // Widened from 2.5 m with the goalkeeper. It was narrowed *because* the mouth was empty by
      // rule — "тупейший бейзлайн забивал в пустые почти всегда" — and that reason is gone. At
      // 3.2 m the keeper's hands cover the middle and not the corners, which is the whole of
      // what makes goalkeeping a guess instead of a formality. Measured against 2.5 and 4.0 in
      // `npm run shape`: 2.5 m turns him into a wall (a goal every 40 s), 4.0 m makes the corner
      // free.
      goalWidth: 3.2,
      creaseRadius: 4,
      wallRestitution: 0.75,
      // Two seconds, not one: with a keeper in there, a ball parried into the crease is a
      // rebound he is supposed to go and pick up, and one second is not enough time to turn
      // round and do it. It stays as a rule because a ball resting where only one body may
      // stand is still a match that can stop.
      creaseBallTimeoutSec: 2,
    },
    match: {
      goalsToWin: 5,
      durationSec: 180,
      restartDelaySec: 1.2,
      spawnJitter: 0.75,
      kickoffTeam: 'fixed',
      // OFF. It was a rule that did the ball's job: "hold it too long and you lose it" is now
      // said by the ball itself, earlier, to both sides, and in a way you can act on. A big
      // number is kept as a safety net rather than as a mechanic — see the report's measurement
      // of how long anybody actually holds it once the beep is doing the work.
      carryTimeoutSec: 12,
    },
    player: {
      radius: 0.35,
      accel: 18,
      runSpeed: 5.5,
      walkSpeed: 2.5,
      strideLength: 1.5,
      brakeSpeedDrop: 3.2,
      brakeWindowSec: 0.2,
      brakeTurnCos: 0.1,
      brakeCooldownSec: 0.5,
      // Above a jog: a walker changing his mind is not an 11 m event, a runner cutting is. The
      // speed dips to about 3.9 m/s in the middle of a ninety-degree cut, so the floor has to sit
      // below that or the cut switches itself off halfway through.
      brakeTurnMinSpeed: 3.2,
      brakeTurnWindowSec: 0.5,
      callCooldownSec: 1.6,
    },
    ball: {
      radius: 0.12,
      friction: 1.6,
      restitution: 0.75,
      carryOffset: 0.5,
      humIntervalSec: 0.2,
      // Swept in `npm run shape` (rows v-*, 16 seeds × 90 s). Against a lazier ball (2 s of
      // quiet, a 7 s ramp) and against the old continuous hum, this rhythm produced clearly the
      // most passing — 0.77 passes per possession against 0.56 and 0.50 — at the same scoreline.
      // The quiet window is the reward for a pass, and it has to be long enough to be worth
      // having and short enough that walking the ball in is never the quiet option.
      voice: {
        quietSec: 0.8,
        intervalStart: 0.9,
        intervalMin: 0.3,
        rampSec: 3,
        startLoudFrac: 0.25,
      },
      inheritCarrierVelocity: false,
      restSpeed: 0.05,
    },
    catching: {
      // Widened from 1.2 with the reach model: at 16 m/s the ball crosses 1.6 m in 100 ms, which
      // is the size of the "too late" half of the timing. Any tighter and the late failure is a
      // coin toss rather than a mistake.
      radius: 1.6,
      auto: true,
      // 18 m/s of span puts a 12 m/s pass at 0.75 m of reach and a 16 m/s shot at 0.40 m — just
      // inside the body's own radius, which is what keeps the soft block alive: a shot that
      // grazes a defender goes past him rather than sticking to him.
      catchSpeedSpan: 18,
      // Below the body's own radius (0.47 m): otherwise a ball that touches a body is always
      // caught, and the soft block — a hard shot going past a defender who was not in front of
      // it — becomes unreachable.
      minReachFrac: 0.2,
      // Just under a full sprint: you can run to the ball, you cannot run *through* a hard pass.
      sprintSpeed: 4.6,
      sprintBallSpeed: 9,
      reachSec: 0.22,
      reachCooldownSec: 0.35,
      cooldownSec: 0.35,
      slowBallSpeed: 2.5,
      contactFumbleMinSpeed: 3,
      fumbleSpeed: 4,
      fumbleScatter: 0.6,
    },
    throwing: {
      minCharge: 0.15,
      maxCharge: 0.6,
      weakSpeed: 6,
      minSpeed: 12,
      maxSpeed: 16,
    },
    keeper: {
      enabled: true,
      switchMargin: 1.5,
      // The keeper is the specialist at the one thing that got hard when catching became
      // automatic: taking a ball that is moving fast. An ordinary body has 0.6 m of reach
      // against a 16 m/s shot, the keeper has 1.4 m — enough to own the middle of a 3.2 m mouth
      // and not enough to own the corners, which is exactly the shape goalkeeping should have.
      reachMul: 1.8,
      depth: 1,
      // Past the crease on purpose: walking out to here is what takes the gloves off him, so a
      // team that wins the ball is a team with two attackers a second and a half later.
      attackDepth: 5.5,
      diveCooldownMul: 0.3,
      diveRecoveryMul: 0.45,
    },
    dive: {
      durationSec: 0.4,
      recoverySec: 0.6,
      speed: 8,
      cooldownSec: 1.2,
    },
    ping: {
      // Rarer and stronger, measured rather than argued (`npm run contest`, rows ping-*). At
      // 1.5 s a ping was cheap rather than rare, so it was spent "just in case"; at 3 s, seeing
      // the whole pitch for two seconds, it is a decision — and it is the row where knowing
      // things is worth the most (a telepath's possession edge went from +12 to +19 points, and
      // the bot that may not ping finally loses measurably to the one that may).
      cooldownSec: 3,
      // The whole pitch. The concept says 14 m; this is a deliberate revision to be signed off,
      // and it is what makes one ping worth a three-second silence.
      range: 24,
      waveSpeed: 42,
      coneDeg: 360,
      wallSampleStep: 0.5,
      lifeSec: 2,
    },
    loudness: { ...DEFAULT_LOUDNESS },
    perception: {
      hearingScale: 1,
      localizationSigmaPerMeter: 0.06,
      localizationSigmaCap: 1.5,
      localizationBearingDeg: 1.5,
      anonymousSources: true,
      reactionLatencySec: 0,
      truthLeak: 0,
      teamShare: false,
      exactKinds: ['sonar', 'whistle'],
      xrayHz: 0,
      markerLifeSec: 2.5,
      emitterNoiseSmoothing: 0.97,
    },
    contest: {
      steal: {
        // OFF, by the человек's verdict after playing: "в целом сейчас чуваки в борьбу играют и
        // просто мяч перекрадывают, не очень". It measured worst of the four contest mechanics
        // anyway (+0.9 pp of possession to a telepath against the tackle's +6.6), and for a
        // reason that is now obvious: the carrier used to hum, so hunting him needed no
        // information at all. It produced a scrimmage that looked like play and was not.
        // The switch stays so the rule tournament can still price it.
        enabled: false,
        // Measured, not guessed: 1.5 m for half a second produced twenty-two steals a minute in
        // the rule tournament — a change of possession every 2.6 seconds, almost all of them
        // accidental, because two bots converging on a ball are inside 1.5 m of each other most
        // of the time anyway. A steal has to be something you *did*, so the radius came down
        // below the natural crowding distance and the hold went up past the time it takes to
        // run through somebody.
        // Final numbers from the rule tournament (`npm run contest`, row `chosen`). 1.5 m for
        // 0.5 s gave twenty-two steals a minute — a change of possession every 2.6 seconds,
        // almost all accidental, because two bots converging on a ball are inside 1.5 m of each
        // other most of the time anyway. At 1.0 m for a full second it is 2.2 a minute and every
        // one of them is something somebody did.
        radius: 1,
        holdSec: 1,
        requirePress: false,
        minSpeed: 0,
        knockLoose: false,
        graceSec: 1.5,
      },
      tackle: {
        enabled: true,
        radius: 0.9,
        stunSec: 1,
        missPenalty: 1,
        dropsBall: true,
      },
      collision: {
        enabled: true,
        restitution: 0.2,
        // Measured: with contact spilling the ball, the `collision` row of the rule tournament
        // produced sixteen fumbles a minute — one every four seconds — which is exactly the
        // "свалка" the concept's third test exists to catch. Body contact earns its place as a
        // SCREEN: a silent body in the corridor is a wall, and running into it is loud and costs
        // you your momentum. Costing you the ball as well was one punishment too many.
        loudSpeed: 4.5,
        staggerSec: 0.25,
        dropsBall: false,
      },
      block: {
        mode: 'speed',
        speedSpan: 12,
        minStop: 0.25,
        activeAlwaysStops: true,
      },
    },
    ai: {
      beliefDecay: 0.5,
      decisionQuality: 1,
      observationMemory: 12,
    },
  };
}

/** Named presets the playground and the batch runner can switch between by name. */
export const PRESETS: Record<string, () => SimConfig> = {
  /** The concept as written. */
  default: defaultConfig,

  /** The same, with the ping collapsed to an instant snapshot — the A/B of the wavefront. */
  'instant-ping': () => {
    const c = defaultConfig();
    c.ping.waveSpeed = Infinity;
    return c;
  },

  /** 1v1, for reading a mechanic without traffic. */
  duel: () => {
    const c = defaultConfig();
    c.teamSize = 1;
    return c;
  },

  /** 3v3 on the same pitch — the density stress test. */
  crowd: () => {
    const c = defaultConfig();
    c.teamSize = 3;
    return c;
  },

  /** Everything heard perfectly, no anonymity: for debugging a bot's decisions, never for play. */
  omniscient: () => {
    const c = defaultConfig();
    c.perception.localizationSigmaPerMeter = 0;
    c.perception.localizationBearingDeg = 0;
    c.perception.anonymousSources = false;
    c.perception.truthLeak = 1;
    c.perception.hearingScale = 10;
    c.perception.emitterNoiseSmoothing = 0;
    c.perception.xrayHz = 10;
    return c;
  },

  /** A human-shaped channel: latency and a team voice link. */
  human: () => {
    const c = defaultConfig();
    c.perception.reactionLatencySec = 0.25;
    c.perception.teamShare = true;
    return c;
  },

  /**
   * A bot that values information far above its price.
   *
   * Not a balance setting — a demonstration one. It dates from the version of the game that had
   * no tackle and no steal, where knowing an opponent's position bought nothing you could act
   * on and the bot pinged roughly once a match. The contest rules have moved that number up on
   * their own; the preset stays because forcing the question makes the mechanic easy to watch
   * in the playground.
   */
  curious: () => {
    const c = defaultConfig();
    c.ai.infoMul = 40;
    return c;
  },

  /**
   * The rules as they were before the fight for the ball existed — no steal, no tackle, no body
   * contact, and a body on the shot line as an absolute wall. Kept as the control group of the
   * rule tournament: every claim about contest mechanics is a claim relative to this row.
   */
  'no-contest': () => {
    const c = defaultConfig();
    c.contest.steal.enabled = false;
    c.contest.tackle.enabled = false;
    c.contest.collision.enabled = false;
    c.contest.block.mode = 'always';
    return c;
  },

  /** Short matches for batch runs — same physics, less waiting. */
  sprint: () => {
    const c = defaultConfig();
    c.match.durationSec = 60;
    c.match.goalsToWin = 3;
    return c;
  },
};

export function configFromPreset(name: string): SimConfig {
  const make = PRESETS[name];
  if (!make) throw new Error(`unknown config preset: ${name}`);
  return make();
}

/** Structural clone that keeps the type — used everywhere a config crosses a boundary. */
export function cloneConfig(c: SimConfig): SimConfig {
  return {
    ...c,
    field: { ...c.field },
    match: { ...c.match },
    player: { ...c.player },
    ball: { ...c.ball, voice: { ...c.ball.voice } },
    catching: { ...c.catching },
    throwing: { ...c.throwing },
    dive: { ...c.dive },
    keeper: { ...c.keeper },
    ping: { ...c.ping },
    loudness: { ...c.loudness },
    perception: { ...c.perception, exactKinds: [...c.perception.exactKinds] },
    perceptionByTeam: c.perceptionByTeam
      ? c.perceptionByTeam.map((o) => (o ? { ...o, ...(o.exactKinds ? { exactKinds: [...o.exactKinds] } : {}) } : null))
      : undefined,
    contest: {
      steal: { ...c.contest.steal },
      tackle: { ...c.contest.tackle },
      collision: { ...c.contest.collision },
      block: { ...c.contest.block },
    },
    ai: { ...c.ai },
  };
}
