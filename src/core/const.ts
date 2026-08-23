/**
 * BLIND SPOT — ALL tuning constants live here (engine-plan §2).
 *
 * Laws (vision.md §1) are encoded in behaviour, not numbers. Numbers below are first-pass
 * tuning values: playtests change numbers, never laws. Looks may READ these; looks may never
 * re-tune them (engine-plan §9).
 */

// ---------------------------------------------------------------------------------------------
// Surfels / lattice (visual-brief §2, engine-plan §3)
// ---------------------------------------------------------------------------------------------

/** Fixed world-axis lattice spacing. Structural: same world position => same dot, forever. */
export const SURFEL_SPACING = 0.22;
/** Patch clustering size for patch-level line-of-sight (one raycast per patch). */
export const PATCH_SIZE = 1.0;
/** Spatial hash cell for patch lookup. */
export const HASH_CELL = 2.0;
/** Edge segments are subdivided to at most this length. */
export const EDGE_SEG_MAX = 0.5;
/** Probe distance used by the 4-quadrant crease detector when baking edges. */
export const CREASE_PROBE = 0.05;
/** Outward probe used to decide whether a lattice face sample is exposed to air. */
export const FACE_PROBE = 0.05;
/** A surfel is lit by an event iff intensity >= dither * DITHER_GAIN (coverage == density). */
export const DITHER_GAIN = 1.0;
/** Shader-side age thinning gain: dots drop out as ageAlpha*intensity falls under dither. */
export const THIN_GAIN = 1.0;
/** A hold must sit at least this far above/below the adjacent standing surface. */
export const HOLD_MIN_STEP = 0.7;
/**
 * …and no further than this: above the mantle limit (MANTLE_MAX_HEIGHT 2.2) plus a reach margin
 * a lip is scenery, not a hold, and drawing it as a bright micro-line would promise a traversal
 * the movement code will refuse (vision §5 "dots are matter, lines are holds").
 */
export const HOLD_MAX_STEP = 2.6;
/** Overhead lips (duct undersides) need at least this much clearance to count as holds. */
export const HOLD_MIN_CLEARANCE = 0.6;

// ---------------------------------------------------------------------------------------------
// Aging (visual-brief §2 "age is temperature"; vision §3.6)
// ---------------------------------------------------------------------------------------------

/** now - paintTime below this is the racing rim / fresh flash window. */
export const RIM_WINDOW = 0.12;
/** Ice-white flash duration. */
export const AGE_FLASH = 0.35;
/** End of the "hot" band. */
export const AGE_HOT = 2.5;
/** End of the "mid" band (the school's signature tone). */
export const AGE_MID = 12.0;
/** End of the "cool" band. */
export const AGE_COOL = 45.0;
/** Age at which paint has fully cooled into the permanent memory skeleton. */
export const AGE_SKELETON = 90.0;
/** Permanent memory-skeleton alpha floor (vision §3.6). */
export const SKELETON_ALPHA = 0.22;
/** Edge lines keep a higher floor: aging decays cloud -> line drawing (visual-brief §1.12). */
export const SKELETON_ALPHA_EDGE = 0.34;

// ---------------------------------------------------------------------------------------------
// Render window (vision §3.6, §12)
// ---------------------------------------------------------------------------------------------

/** Hard render cut. Data outside persists and reappears as you approach. */
export const WINDOW_RADIUS = 45.0;
/** Beyond this, bias to edges and thin dots harder ("far reads as a drawing"). */
export const FAR_BIAS_START = 20.0;
/** Contact shell: faint always-on shell within 2 m of the body (vision §3.1). */
export const CONTACT_SHELL_RADIUS = 2.0;
export const CONTACT_SHELL_ALPHA = 0.05;
/** Minimum splat size in pixels (visual-brief §2: splats >= 2-3 px, temporally stable). */
export const SPLAT_MIN_PX = 2.2;
export const SPLAT_NEAR_PX = 4.0;

// ---------------------------------------------------------------------------------------------
// Hearing / propagation (vision §3.1, §3.4)
// ---------------------------------------------------------------------------------------------

/** Base hearing range. You receive an event's paint only if you can hear the event. */
export const HEARING_BASE = 18.0;
/** Through one wall: radius x this, intensity x WALL1_INTENSITY, origin fuzzed +-WALL_FUZZ. */
export const WALL1_RADIUS = 0.4;
export const WALL1_INTENSITY = 0.5;
export const WALL_FUZZ = 2.0;
/** Signal-quality multiplier when the event reaches the listener through one wall. */
export const WALL1_QUALITY = 0.45;
/** Two or more walls: nothing. Ever. */
export const WALL_MAX = 2;
/** Minimum segment length inside an occluder for it to count as a wall (anti-grazing). */
export const OCCLUDER_MIN_CHORD = 0.06;

// ---------------------------------------------------------------------------------------------
// Sound event classes (vision §3.3 verbatim; engine-plan §4 wave speeds)
// ---------------------------------------------------------------------------------------------

export const WAVE_SPEED_Q = 45;
export const WAVE_SPEED_E = 85;
export const WAVE_SPEED_DETONATION = 140;

export const EV = {
  crouchStep: { paint: 1.5, hear: 2, intensity: 0.35, wave: Infinity },
  walkStep: { paint: 4, hear: 11, intensity: 0.6, wave: Infinity },
  sprintStep: { paint: 7, hear: 24, intensity: 0.9, wave: Infinity },
  /** landing paint 8..14 by fall height; hear 28 */
  landing: { paint: 8, paintMax: 14, hear: 28, intensity: 1.0, wave: Infinity },
  slide: { paint: 5, hear: 16, intensity: 0.7, wave: Infinity },
  /** prop paint 8..12 by impulse; hear 25 */
  propKnock: { paint: 8, paintMax: 12, hear: 25, intensity: 0.85, wave: Infinity },
  chainRattleLoud: { paint: 10, hear: 25, intensity: 0.8, wave: Infinity },
  chainRattleQuiet: { paint: 4, hear: 8, intensity: 0.4, wave: Infinity },
  qPing: { paint: 12, hear: 18, intensity: 1.0, wave: WAVE_SPEED_Q },
  ePing: { paint: 40, hear: 30, intensity: 1.0, wave: WAVE_SPEED_E, coneDeg: 25 },
  dogGaitPatrol: { paint: 2, hear: 8, intensity: 0.5, wave: Infinity },
  dogGaitInvestigate: { paint: 4, hear: 12, intensity: 0.65, wave: Infinity },
  dogGaitChase: { paint: 8, hear: 24, intensity: 0.9, wave: Infinity },
  detonation: { paint: 22, hear: 60, intensity: 1.0, wave: WAVE_SPEED_DETONATION },
  beaconHum: { paint: 3, hear: 12, intensity: 0.5, wave: Infinity },
} as const;

/** Event-layer marker fade window (vision §3.2: 2.5-6 s). */
export const STAIN_FADE_MIN = 2.5;
export const STAIN_FADE_MAX = 6.0;

// ---------------------------------------------------------------------------------------------
// Movement (vision §5, engine-plan §5)
// ---------------------------------------------------------------------------------------------

export const SPEED_CROUCH = 1.7;
export const SPEED_WALK = 3.5;
export const SPEED_SPRINT = 6.0;
export const SPEED_LADDER = 2.5;

export const ACCEL_GROUND = 40;
export const ACCEL_AIR = 10;
/** Source-style air-strafe cap: how much speed a single air-accel tick may add along wishdir. */
export const AIR_WISH_CAP = 1.6;
export const FRICTION_GROUND = 52;
export const GRAVITY = 22;
export const JUMP_VELOCITY = 7.0;
export const COYOTE_TIME = 0.12;
export const JUMP_BUFFER = 0.15;

export const CAPSULE_RADIUS = 0.35;
export const HEIGHT_STAND = 1.7;
export const HEIGHT_CROUCH = 1.1;
export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.02;
/** Ground probe ring radius (fraction of capsule radius) — how far you may stand over a lip. */
export const GROUND_PROBE_FRAC = 0.7;
export const STEP_UP_MAX = 0.35;
export const GROUND_SNAP = 0.28;

export const SLIDE_ENTRY_SPEED = 5.5;
export const SLIDE_BOOST_SPEED = 7.5;
export const SLIDE_DECAY = 2.2;
export const SLIDE_MIN_SPEED = SPEED_CROUCH;
export const SLIDE_TILT_DEG = 4.0;
export const SLIDE_STRIDE = 0.5;

export const MANTLE_SCAN_AHEAD = 1.0;
export const MANTLE_MAX_HEIGHT = 2.2;
export const MANTLE_MIN_HEIGHT = 0.4;
export const MANTLE_DURATION = 0.45;

export const STRIDE_CROUCH = 1.3;
export const STRIDE_WALK = 1.9;
export const STRIDE_SPRINT = 2.6;

/** Fall height above which a landing event fires. */
export const LANDING_MIN_FALL = 2.0;
/** Fall height that produces the maximum landing paint. */
export const LANDING_MAX_FALL = 8.0;
/** Fall height above which the landing costs a stagger (no damage — vision §5). */
export const LANDING_STAGGER_FALL = 4.0;
export const LANDING_STAGGER_TIME = 0.3;

// ---------------------------------------------------------------------------------------------
// Camera energy (visual-brief §1.8)
// ---------------------------------------------------------------------------------------------

export const FOV_BASE = 92;
export const FOV_SPRINT_KICK = 8;
export const FOV_SMOOTH = 6.0;
export const HEAD_BOB_MAX = 0.035;
export const LANDING_DIP_MAX = 0.16;
export const LANDING_DIP_DECAY = 7.0;
export const PITCH_LIMIT = Math.PI * 0.5 - 0.02;
export const MOUSE_SENSITIVITY = 0.0022;

// ---------------------------------------------------------------------------------------------
// Player systems (vision §4, engine-plan §6)
// ---------------------------------------------------------------------------------------------

export const ENERGY_MAX = 100;
export const ENERGY_REGEN = 6;
export const ENERGY_EPING = 18;
export const ENERGY_QPING = 10;
export const ENERGY_SPRINT_DRAIN = 1;
export const PING_COOLDOWN = 0.75;
/** E-ping's far end is heard too: a virtual hearable-only event at the beam impact centre. */
export const EPING_FAR_HEAR = 30;
/** Halo: smoothed max of self-emitted hearRadius over this window. */
export const HALO_WINDOW = 1.2;
export const HALO_DECAY = 9.0;

// ---------------------------------------------------------------------------------------------
// Dog (vision §6, engine-plan §7)
// ---------------------------------------------------------------------------------------------

export const DOG_SPEED_PATROL = 3.0;
export const DOG_SPEED_INVESTIGATE = 4.5;
export const DOG_SPEED_CHASE = 7.0;
/**
 * Vision §6 states the dog's steering limit as a 3 m TURN RADIUS, not an angular rate: "its 3 m
 * turn radius means corners and verticality beat it". Radius is the invariant — the angular rate
 * follows from the gait in use and is derived at the point of use as `speed / DOG_TURN_RADIUS`
 * rad/s (7.0 m/s chase => 2.33 rad/s; 3.0 m/s patrol => 1.0 rad/s). Storing a single rate would
 * silently give the chase gait a tighter radius than the design allows.
 */
export const DOG_TURN_RADIUS = 3.0;
/** A gait event every this many metres travelled. */
export const DOG_GAIT_STRIDE = 0.8;
/** Silence for this long turns the frozen cloud into a cooling ghost (vision §3.7). */
export const DOG_FREEZE_DELAY = 0.4;
/** Ghost cools hot -> rust over this long, then visibly dissolves. */
export const DOG_GHOST_LIFE = 10.0;
export const DOG_GHOST_DISSOLVE = 2.0;
export const DOG_MAX_GHOSTS = 6;
/** Motion-smear pose history window. */
export const DOG_SMEAR_WINDOW = 0.3;
export const DOG_SMEAR_SAMPLES = 5;
/** Local body-lattice sample budget (engine-plan §7: ~600 points). */
export const DOG_CLOUD_TARGET = 600;

// ---------------------------------------------------------------------------------------------
// Props (engine-plan §8)
// ---------------------------------------------------------------------------------------------

export const CAN_RADIUS = 0.12;
export const CAN_HEIGHT = 0.3;
export const CAN_KICK_SPEED = 3.4;
export const CAN_RESTITUTION = 0.42;
export const CAN_FRICTION = 3.2;
export const CAN_MAX_BOUNCES = 2;
export const CHAIN_SWAY_TIME = 1.5;
export const BEACON_PERIOD = 4.0;

// ---------------------------------------------------------------------------------------------
// Audio (engine-plan §8)
// ---------------------------------------------------------------------------------------------

export const AUDIO_MASTER_GAIN = 0.6;

// ---------------------------------------------------------------------------------------------
// Sim
// ---------------------------------------------------------------------------------------------

/** Fixed simulation step. */
export const SIM_STEP = 1 / 60;
export const SIM_MAX_STEPS = 5;
/** Recent-event ring buffer length (looks read this for stains). */
export const EVENT_RING = 96;

/** The flat object handed to looks as `ctx.constants`. */
export const CORE_CONSTANTS = {
  SURFEL_SPACING,
  PATCH_SIZE,
  DITHER_GAIN,
  THIN_GAIN,
  RIM_WINDOW,
  AGE_FLASH,
  AGE_HOT,
  AGE_MID,
  AGE_COOL,
  AGE_SKELETON,
  SKELETON_ALPHA,
  SKELETON_ALPHA_EDGE,
  WINDOW_RADIUS,
  FAR_BIAS_START,
  CONTACT_SHELL_RADIUS,
  CONTACT_SHELL_ALPHA,
  SPLAT_MIN_PX,
  SPLAT_NEAR_PX,
  HEARING_BASE,
  WALL_FUZZ,
  WALL1_QUALITY,
  STAIN_FADE_MIN,
  STAIN_FADE_MAX,
  ENERGY_MAX,
  PING_COOLDOWN,
  FOV_BASE,
  FOV_SPRINT_KICK,
  DOG_GHOST_LIFE,
  DOG_GHOST_DISSOLVE,
  DOG_SMEAR_WINDOW,
} as const;

export type CoreConstants = typeof CORE_CONSTANTS;
