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
   * opponent. 0 turns it off, which is the concept as written.
   *
   * It is off by default because it is an invention, but it exists because there is currently
   * no way to take the ball off a body — no contact, no tackle — so a strategy that simply
   * stands still holding the ball cannot be punished. `striker` versus `statue` is decided by
   * one goal and then stands still for 170 seconds, which makes that pairing useless as a
   * measurement. Turn it on when you want a benchmark rather than a faithful match.
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
  /** A speed drop bigger than this within `brakeWindowSec` counts as an audible stop. */
  brakeSpeedDrop: number;
  brakeWindowSec: number;
  /** cos of the turn angle that counts as an audible direction change (0 = 90°). */
  brakeTurnCos: number;
  /** Minimum gap between two brake sounds from the same body. */
  brakeCooldownSec: number;
  /**
   * v1 has no body-to-body contact — players pass through each other (concept, "решено").
   * The mechanic is expected later, so the switch exists and the code path behind it is real.
   */
  bodyCollision: boolean;
  /** Restitution used when `bodyCollision` is on. */
  bodyRestitution: number;
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
  /** Free-form room for whatever the belief layer turns out to need. */
  [key: string]: number | boolean | string;
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
  ai: AiConfig;
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
      carryTimeoutSec: 0,
    },
    player: {
      radius: 0.35,
      accel: 18,
      runSpeed: 5.5,
      walkSpeed: 2.5,
      strideLength: 1.5,
      brakeSpeedDrop: 2.5,
      brakeWindowSec: 0.2,
      brakeTurnCos: 0.1,
      brakeCooldownSec: 0.5,
      bodyCollision: false,
      bodyRestitution: 0.2,
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
      markerLifeSec: 2.5,
      emitterNoiseSmoothing: 0.97,
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
    return c;
  },

  /** A human-shaped channel: latency and a team voice link. */
  human: () => {
    const c = defaultConfig();
    c.perception.reactionLatencySec = 0.25;
    c.perception.teamShare = true;
    return c;
  },

  /** Short matches for batch runs — same physics, less waiting. */
  sprint: () => {
    const c = defaultConfig();
    c.match.durationSec = 60;
    c.match.goalsToWin = 3;
    c.match.carryTimeoutSec = 8;
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
    ai: { ...c.ai },
  };
}
