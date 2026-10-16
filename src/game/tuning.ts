// All gameplay numbers in one place (meters, seconds).

export const GRAVITY = 24;

export const PLAYER = {
  radius: 0.45,
  runSpeed: 7,
  groundAccel: 45,
  dodgeSpeed: 12,
  dodgeTime: 0.28,
  /** Long enough that a wasted (early) dodge leaves you exposed to the ram's follow-up. */
  dodgeCooldown: 0.45,
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
  introTime: 1.2,
  // --- stalking: circle the player, trying to put them between itself and the rim
  stalkSpeed: 3.2,
  stalkDist: 4.6,
  /** Ram keeps at least this far from the rim while not locked on. */
  safeEdge: 1.1,
  /** Escalation by number of charges done (n). */
  stalkTime: (n: number) => Math.max(0.9, 2.2 - 0.12 * n),
  stalkMaxTime: 4.5,
  windup: (n: number) => Math.max(0.45, 0.9 - 0.05 * n),
  chargeSpeed: (n: number) => Math.min(15.5, 11.5 + 0.4 * n),
  chargeAccel: 40,
  /** Chance a charge is a feint (stops short to bait an early dodge). */
  feintChance: (n: number) => (n < 2 ? 0 : Math.min(0.45, 0.2 + 0.05 * n)),
  feintDistance: 1.4,
  feintDecel: 45,
  /** Locked on: notices you left its line after this delay, then brakes as hard as it can. */
  reaction: 0.1,
  brakeDecel: 25,
  hitReachAhead: 1.5,
  hitWidth: 1.0,
  /** You're this far sideways (or behind) = out of the line. */
  missLateral: 1.3,
  /** Noticed you dodging while still this far away = it saw it coming → quick punish charge. */
  earlySeen: 3.0,
  punishWindup: 0.15,
  pawAfterFeint: 0.5,
  teeterZone: 1.0,
  teeterTime: 1.2,
  recoverTime: 0.6,
  gloatTime: 0.9,
};

export const FALL = {
  slowmoTime: 0.9,
  slowmo: 0.3,
  gravity: 42,
  boomHold: 1.6,
};
