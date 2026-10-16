// All gameplay numbers in one place (meters, seconds).

export const GRAVITY = 24;

export const PLAYER = {
  radius: 0.45,
  runSpeed: 7,
  groundAccel: 45,
  dodgeSpeed: 15,
  dodgeTime: 0.3,
  dodgeCooldown: 0.25,
  kickTime: 0.35,
  kickActive: [0.06, 0.2] as const,
  kickRange: 2.0,
  kickAssistRange: 3.2,
  bounceTime: 0.45,
  bounceSpeed: 5,
  hitstun: 0.4,
  airAccel: 14,
  airMaxSpeed: 8,
  landTime: 0.3,
  /** Launch when the ram connects: horizontal, vertical speed. */
  launchH: 7.5,
  launchV: 7.5,
};

export const RAM = {
  radius: 0.8,
  turnSpeed: 7,
  introTime: 1.4,
  /** Escalation by number of charges done (n). */
  windup: (n: number) => Math.max(0.5, 1.2 - 0.08 * n),
  chargeSpeed: (n: number) => Math.min(17, 10.5 + 0.7 * n),
  stunTime: (n: number) => Math.max(1.0, 1.7 - 0.06 * n),
  chargeAccel: 40,
  skidDecel: 15,
  hitReachAhead: 1.5,
  hitWidth: 1.0,
  /** Player this far sideways (or behind) = the ram realizes it missed and brakes. */
  missLateral: 2.0,
  teeterZone: 1.6,
  teeterTime: 1.0,
  recoverTime: 0.55,
  kickH: 10,
  kickV: 5,
  slideDecel: 22,
};

export const FALL = {
  slowmoTime: 0.9,
  slowmo: 0.3,
  gravity: 42,
  boomHold: 1.6,
};
