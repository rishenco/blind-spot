// BLIND SPOT — all tunable constants in one place. See DESIGN.md for rationale.

export const TICK_HZ = 20;
export const TICK_DT = 1 / TICK_HZ;

export const MATCH = {
  hardCapS: 480,
  overdriveS: 360,
  warmupS: 3,
};

export const PLAYER = {
  maxHp: 100,
  regenPerS: 10,
  regenDelayS: 8,
  respawnS: 4,
  // Slightly above the design table because our map is 57x53m rather than 44x44m.
  crouchSpeed: 1.8,
  walkSpeed: 3.7,
  sprintSpeed: 5.9,
  carrierMaxSpeed: 3.7, // no sprint while carrying
};

/** Sound-driven reveals. Radii are through-wall audibility, not line of sight. */
export const SOUND = {
  stepWalkRadius: 9,
  stepSprintRadius: 18,
  stepCrouchRadius: 0,
  stepWalkCadence: 0.45,
  stepSprintCadence: 0.35,
};

export const PULSE = {
  halfAngleDeg: 35,      // 70 degree cone
  range: 28,
  cooldownS: 4.0,
  waveSpeed: 60,         // metres/sec reveal propagation
  rays: 46000,
  flashRadius: 35,       // enemy learns you pulsed within this radius
};

export const TOUCH = {
  radius: 2.5,
  rays: 240,
  intervalS: 0.22,
};

export const JUDGE = {
  damage: 50,
  intervalS: 1.1,
  mag: 5,
  reloadS: 2.4,
  bloomRadius: 40,     // enemy hears the shot from this far, through walls
  impactReveal: 3.0,   // geometry sphere at impact, visible to BOTH
  spreadRad: 0,
  tracerToEnemy: true,
  range: 90,
};

export const WHISPER = {
  damage: 16,
  falloffDamage: 8,
  falloffRange: 14,
  intervalS: 0.12,
  mag: 24,
  reloadS: 1.8,
  bloomRadius: 6,
  impactReveal: 0.75,  // shooter-only
  spreadRad: (1.5 * Math.PI) / 180,
  tracerToEnemy: false,
  range: 60,
};

export type WeaponId = 'judge' | 'whisper';
export const WEAPONS = { judge: JUDGE, whisper: WHISPER } as const;

export const SPIKE = { charges: 2, armS: 1.0, triggerRadius: 6, reach: 3.0 };
export const DECOY = { charges: 2, delayS: 1.0, durationS: 12, wander: 1.5, audibleRadius: 9, throwSpeed: 12 };
export const ECHO = { charges: 2, spacingS: 25, revealRadius: 10, bloomRadius: 30, throwSpeed: 14, rays: 4200 };

export const RELIC = {
  heartbeatS: 20,
  heartbeatDroppedS: 10,
  heartbeatRadius: 6,
  heartbeatRadiusOverdrive: 12,
  singS: 5,
  singOverdriveS: 2.5,
  channelS: 3.5,
  ringRadius: 2.0,
};

export const XP = {
  firstPaint: 25,
  firstPaintLockoutS: 15,
  perDamage: 1 / 4,
  kill: 100,
  pickup: 60,
  decoyShattered: 40,
  relicHeartbeatSeen: 0,
  levels: [0, 100, 250, 450],
};

/** Observation resolutions. Everything the enemy learns arrives at one of these. */
export const enum Res { Trace = 0, Coarse = 1, Full = 2 }

export const RESOLUTION_POINTS = { [Res.Trace]: 18, [Res.Coarse]: 80, [Res.Full]: 560 };

/** Ghost lifetimes: entity contacts cool but never vanish until replaced. */
export const AGE = {
  structuralFresh: 4,
  structuralMemory: 30,
  entityCool: 10,
  transient: 4,
  footstep: 2.5,
};

export const POOL = {
  structural: 260_000,
  transient: 30_000,
  entity: 12_000,
};

/**
 * The Three-Color Law. Architecture is cyan/blue, life is orange, the objective is gold.
 * Depth is encoded *within* the cyan band (pale-near -> deep-blue-far) so a warm silhouette
 * can never be mistaken for nearby geometry.
 */
export const HUE = {
  matterNear: 0.505,
  matterFar: 0.605,
  life: 0.045,
  objective: 0.125,
  sound: 0.085,
  phantom: 0.045, // decoys must be indistinguishable from real life
};
