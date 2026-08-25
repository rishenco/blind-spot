/**
 * The player's body: health, bites, and the physical response to being bitten.
 *
 * Up to M4 the player was immortal — a spider reached him, screeched and bounced off, and
 * nothing at all happened. This is the smallest honest model that makes that contact matter,
 * and deliberately nothing more: one pool, one damage number, a very slow trickle back, no
 * medkits and no economy. Everything else in this file is *feedback*, not simulation.
 *
 * Three rules shape the feedback, and all three come from the concept:
 *
 * 1. **No red screen.** In a game whose default frame is black, a full-screen wash of anything
 *    is the brightest thing that has ever happened and it erases the lidar map, the marks and
 *    the flash all at once. So a hit is told through the *body* — the head is knocked, the aim
 *    is spoiled, the breath goes — and through the edge of the frame going darker, never
 *    brighter.
 * 2. **The HUD is a device, not magic.** Damage degrades the device: at low health the marks
 *    the tactical set draws start to stutter and drop out. Getting hurt costs you the one
 *    channel you had.
 * 3. **Determinism.** Everything here is driven by the simulation clock and by closed-form
 *    functions of it; there is no RNG in the damage path at all, so the keyframe generator
 *    reproduces a bite to the pixel.
 *
 * Split of responsibilities, mirroring the rifle: `viewPunch` is render-only (the body
 * flinching) and `consumeAimKick`/`tremor` are simulation (where you are actually pointing).
 * Keeping the two apart is what lets "it feels violent" be tuned without also tuning
 * "it is unaimable".
 */

export interface VitalsTunables {
  /** Full health. A number, not a unit: the player never sees it. */
  maxHealth: number;
  /** One spider bite. Seven of them, uninterrupted, put you down. */
  biteDamage: number;
  /** Seconds of immunity after a bite lands, so a pack pile-on cannot delete you in one tick. */
  graceSeconds: number;
  /** Seconds of not being bitten before the body starts closing the wounds. */
  regenDelay: number;
  /** Health per second once it starts. Deliberately slower than one bite per ten seconds. */
  regenRate: number;

  // --- the flinch (render only) -------------------------------------------
  /** Degrees the view is knocked when a bite lands. */
  punchPitchDeg: number;
  punchYawDeg: number;
  /** Degrees of roll — the shoulder going round. Reads as a body, not as a camera. */
  punchRollDeg: number;
  /** Exponential recovery rate of the flinch, 1/s. */
  punchDecay: number;

  // --- the spoiled aim (simulation) ---------------------------------------
  /** Degrees the *real* heading is shoved by a bite. Small: this is a cost, not a stun. */
  kickDeg: number;
  /** Peak degrees of tremor at zero health. Zero while healthy. */
  tremorDeg: number;
  /** Tremor frequency, Hz. */
  tremorHz: number;

  // --- the frame ----------------------------------------------------------
  /** Health fraction under which the tactical set starts failing. */
  lowHealth: number;
  /** Seconds the direction wedge stays on screen. */
  markLife: number;
  /** Seconds the edge of the frame stays clamped down after a bite. */
  flashSeconds: number;
}

export function defaultVitalsTunables(): VitalsTunables {
  return {
    maxHealth: 100,
    biteDamage: 14,
    graceSeconds: 0.35,
    regenDelay: 12,
    regenRate: 1.4,

    punchPitchDeg: 3.4,
    punchYawDeg: 2.2,
    punchRollDeg: 2.8,
    punchDecay: 7,

    kickDeg: 1.5,
    tremorDeg: 0.9,
    tremorHz: 0.55,

    lowHealth: 0.45,
    markLife: 2.2,
    flashSeconds: 0.55,
  };
}

/** One bite, remembered for as long as the frame is allowed to show it. */
export interface DamageMark {
  /** World bearing *towards* whatever bit you, radians, atan2(dx, dz) convention below. */
  bearing: number;
  /** Damage dealt, in health points — drives how hard the wedge is drawn. */
  amount: number;
  /** Simulation time of the bite. */
  at: number;
  /** Monotonic id, so the frame generator can talk about a particular bite. */
  seq: number;
}

const DEG = Math.PI / 180;

export class PlayerVitals {
  readonly tunables: VitalsTunables;
  /** Master switch. Off = the M4 behaviour, immortal, for comparison shots. */
  enabled = true;
  /** Camera flinch and frame response. Off leaves the numbers running and the screen calm. */
  effects = true;

  health: number;
  alive = true;
  /** Bites taken, and damage taken, since the last reset. */
  bites = 0;
  damage = 0;
  /** Simulation time of the last bite, and of death. */
  hitAt = -999;
  diedAt = -999;

  readonly marks: DamageMark[] = [];
  /** Render-only flinch, radians. */
  readonly viewPunch = { pitch: 0, yaw: 0, roll: 0 };

  private time = 0;
  private seq = 0;
  private kickPitch = 0;
  private kickYaw = 0;
  /** How many marks the wedge layer keeps. A pack bites faster than the eye reads. */
  private readonly keep = 6;

  constructor(tunables: VitalsTunables = defaultVitalsTunables()) {
    this.tunables = tunables;
    this.health = tunables.maxHealth;
  }

  get healthFrac(): number {
    return Math.max(0, this.health) / this.tunables.maxHealth;
  }

  /**
   * How broken the tactical set is, 0..1. Zero while healthy, and it does not appear gradually
   * from the first scratch: the device is fine until you are in trouble, and then it is not.
   */
  get degrade(): number {
    if (!this.alive) return 1;
    const t = this.tunables;
    if (t.lowHealth <= 0) return 0;
    return clamp01((t.lowHealth - this.healthFrac) / t.lowHealth);
  }

  /** 0..1 kick that fades over `flashSeconds` — the edge of the frame clamping down. */
  get sting(): number {
    const age = this.time - this.hitAt;
    if (age < 0 || age > this.tunables.flashSeconds) return 0;
    return 1 - age / this.tunables.flashSeconds;
  }

  get lastHitAgo(): number {
    return this.hitAt < -100 ? Infinity : this.time - this.hitAt;
  }

  get now(): number {
    return this.time;
  }

  /**
   * A bite. `fromX/fromZ` is where it came from and `px/pz` is where the player was; the
   * bearing is stored in world space, so turning your head moves the wedge — which is the
   * entire point of a directional indicator.
   *
   * Returns false when the bite was refused (grace window, already down, damage switched off),
   * so the caller can tell a landed hit from a swallowed one.
   */
  bite(fromX: number, fromZ: number, px: number, pz: number, yaw: number, amount?: number): boolean {
    const t = this.tunables;
    if (!this.enabled || !this.alive) return false;
    if (this.time - this.hitAt < t.graceSeconds) return false;

    const dx = fromX - px;
    const dz = fromZ - pz;
    // atan2(dx, dz) with the camera convention (forward is -Z at yaw 0) gives a bearing that
    // can be compared with `yaw` directly, without a second sign convention to get wrong.
    const bearing = Math.atan2(dx, dz);
    const dealt = amount ?? t.biteDamage;

    this.health -= dealt;
    this.bites++;
    this.damage += dealt;
    this.hitAt = this.time;
    this.marks.push({ bearing, amount: dealt, at: this.time, seq: this.seq++ });
    if (this.marks.length > this.keep) this.marks.shift();

    // Which side of the face it came from, in view space. Straight ahead or straight behind is
    // a coin toss the sim must not flip randomly, so it resolves to a right-hand shove.
    const rel = wrap(bearing - yaw + Math.PI);
    const side = rel >= 0 ? 1 : -1;
    const bias = Math.min(1, Math.abs(Math.sin(rel)) + 0.35);

    if (this.effects) {
      this.viewPunch.pitch += t.punchPitchDeg * DEG * bias;
      this.viewPunch.yaw += -side * t.punchYawDeg * DEG * bias;
      this.viewPunch.roll += side * t.punchRollDeg * DEG * bias;
    }
    // The aim kick is *not* behind `effects`: being bitten spoils your aim whether or not the
    // camera is allowed to shake about it. It is half of what the flinch looks like.
    this.kickPitch += t.kickDeg * DEG * 0.6 * bias;
    this.kickYaw += -side * t.kickDeg * DEG * bias;

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.diedAt = this.time;
    }
    return true;
  }

  /** Simulation tick. Recovery, flinch decay, and nothing that touches the RNG. */
  update(dt: number, now: number): void {
    this.time = now;
    const t = this.tunables;

    if (this.alive && this.enabled && this.health < t.maxHealth) {
      if (this.time - this.hitAt >= t.regenDelay) {
        this.health = Math.min(t.maxHealth, this.health + t.regenRate * dt);
      }
    }

    const k = Math.exp(-t.punchDecay * dt);
    this.viewPunch.pitch *= k;
    this.viewPunch.yaw *= k;
    this.viewPunch.roll *= k;
    if (Math.abs(this.viewPunch.pitch) < 1e-5) this.viewPunch.pitch = 0;
    if (Math.abs(this.viewPunch.yaw) < 1e-5) this.viewPunch.yaw = 0;
    if (Math.abs(this.viewPunch.roll) < 1e-5) this.viewPunch.roll = 0;
  }

  /** The sim-side shove from bites since the last call. Radians, applied to the real heading. */
  consumeAimKick(): { pitch: number; yaw: number } {
    const out = { pitch: this.kickPitch, yaw: this.kickYaw };
    this.kickPitch = 0;
    this.kickYaw = 0;
    return out;
  }

  /**
   * The breath. A hurt man cannot hold a rifle still, so at low health the *real* heading
   * wanders — this is the "испорченное прицеливание" of the spec and it is simulation, not
   * decoration. Written as the derivative of a sine so it wanders and comes back instead of
   * integrating into a drift, which a naive `yaw += sin(t)` would do.
   */
  tremor(dt: number): { pitch: number; yaw: number } {
    const t = this.tunables;
    const amp = t.tremorDeg * DEG * this.degrade;
    if (amp <= 0 || !this.enabled) return ZERO;
    const w = 2 * Math.PI * t.tremorHz;
    return {
      yaw: Math.cos(w * this.time) * amp * w * dt,
      // Half the rate and half the throw: the vertical component of a breath, not a second shake.
      pitch: Math.cos(w * 0.5 * this.time + 1.1) * amp * 0.5 * (w * 0.5) * dt,
    };
  }

  /** Debug/keyframes: put the health where the scenario needs it, without faking a bite. */
  setHealth(value: number): void {
    this.health = Math.max(0, Math.min(this.tunables.maxHealth, value));
    this.alive = this.health > 0;
    if (!this.alive && this.diedAt < -100) this.diedAt = this.time;
  }

  /** Back on your feet: called by respawn, and by the frame generator between scenarios. */
  reset(): void {
    this.health = this.tunables.maxHealth;
    this.alive = true;
    this.bites = 0;
    this.damage = 0;
    this.hitAt = -999;
    this.diedAt = -999;
    this.marks.length = 0;
    this.viewPunch.pitch = 0;
    this.viewPunch.yaw = 0;
    this.viewPunch.roll = 0;
    this.kickPitch = 0;
    this.kickYaw = 0;
  }

  /** Marks still inside their life, newest last. Allocation-free: filtered in place by age. */
  liveMarks(out: DamageMark[]): DamageMark[] {
    out.length = 0;
    const cut = this.time - this.tunables.markLife;
    for (const m of this.marks) if (m.at >= cut) out.push(m);
    return out;
  }
}

const ZERO = { pitch: 0, yaw: 0 };

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Wraps to (-π, π]. */
function wrap(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}
