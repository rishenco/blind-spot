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
  /** Whether a throw adds the carrier's velocity. Off: a throw is a throw, not a slingshot. */
  inheritCarrierVelocity: boolean;
  /** Below this speed a loose ball is considered stopped. */
  restSpeed: number;
}

export interface CatchConfig {
  /** The ball must be within this distance of the body centre when the button goes down. */
  radius: number;
  /** ± window around the moment of closest approach, seconds. */
  windowSec: number;
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
  'ball-wall': 14,
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
      goalWidth: 3,
      creaseRadius: 4,
      wallRestitution: 0.75,
      creaseBallTimeoutSec: 1,
    },
    match: {
      goalsToWin: 5,
      durationSec: 180,
      restartDelaySec: 1.2,
      spawnJitter: 0.75,
      kickoffTeam: 'fixed',
      carryTimeoutSec: 5,
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
    },
    ball: {
      radius: 0.12,
      friction: 1.6,
      restitution: 0.75,
      carryOffset: 0.5,
      humIntervalSec: 0.2,
      inheritCarrierVelocity: false,
      restSpeed: 0.05,
    },
    catching: {
      radius: 1.2,
      windowSec: 0.18,
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
      maxSpeed: 22,
    },
    dive: {
      durationSec: 0.4,
      recoverySec: 0.6,
      speed: 8,
      cooldownSec: 1.2,
    },
    ping: {
      cooldownSec: 1.5,
      range: 14,
      waveSpeed: 42,
      coneDeg: 360,
      wallSampleStep: 0.5,
      lifeSec: 1,
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
        enabled: true,
        // Measured, not guessed: 1.5 m for half a second produced twenty-two steals a minute in
        // the rule tournament — a change of possession every 2.6 seconds, almost all of them
        // accidental, because two bots converging on a ball are inside 1.5 m of each other most
        // of the time anyway. A steal has to be something you *did*, so the radius came down
        // below the natural crowding distance and the hold went up past the time it takes to
        // run through somebody.
        radius: 1.1,
        holdSec: 0.7,
        requirePress: false,
        minSpeed: 0,
        knockLoose: false,
        graceSec: 1,
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
        loudSpeed: 3.2,
        staggerSec: 0.25,
        dropsBall: true,
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
    ball: { ...c.ball },
    catching: { ...c.catching },
    throwing: { ...c.throwing },
    dive: { ...c.dive },
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
