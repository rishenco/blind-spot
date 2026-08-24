/**
 * The sound event bus — vision doc §3.1 and design laws 1 and 2.
 *
 * *Every* noise in the game goes through `SoundBus.emit`. There is deliberately no second
 * path: if a thing can be heard, it exists here, with a real origin and a real loudness, and
 * anything that listens (the paint system today; dog hearing, heat and the audio mixer later)
 * subscribes to the same stream. That is what makes law 2 — "the system never lies" —
 * enforceable rather than aspirational: a blip with no event behind it is impossible to
 * produce.
 *
 * An event carries two radii, and they are not the same number:
 *  - `paintRadius`  — how much static geometry the sound reveals around its origin (§3.3,
 *                     left column). This is what the *player* gets out of the noise.
 *  - `hearingRadius`— how far away a listener can notice the event at all (§3.3, right
 *                     column). Nothing consumes it yet; the robo-dogs will.
 *
 * The bus itself is inert: it stamps, validates and fans out. All interpretation belongs to
 * subscribers.
 */

/**
 * Sound classes implemented so far. The table below is the whole of §3.3 that batch 2 needs;
 * `slide`, `prop-knock`, dog gaits, `detonation` and the carried-cell hum are additional rows
 * in the same table and need no new machinery — a class name, a profile entry, an emitter.
 */
export type SoundClass =
  | 'crouch-step'
  | 'walk-step'
  | 'sprint-step'
  | 'landing'
  | 'q-ping'
  | 'e-ping';

export interface SoundClassProfile {
  /** Paint radius at intensity 1, metres (§3.3). */
  readonly paintRadius: number;
  /** How far a dog hears it, metres (§3.3). Not consumed yet — the enemy arrives later. */
  readonly hearingRadius: number;
  /** Full apex angle of the emission cone in degrees; 360 means omnidirectional. */
  readonly coneAngleDeg: number;
  /** Loudness multiplier applied when the emitter does not name one. */
  readonly intensity: number;
}

/**
 * §3.3, verbatim where the table gives a single number. `landing` is the one range in the
 * table (8-14 m); its emitter picks a point in that range from the impact speed, so the value
 * here is only the floor.
 */
export const SOUND_CLASSES: Record<SoundClass, SoundClassProfile> = {
  'crouch-step': { paintRadius: 1.5, hearingRadius: 2, coneAngleDeg: 360, intensity: 0.7 },
  'walk-step': { paintRadius: 4, hearingRadius: 11, coneAngleDeg: 360, intensity: 0.9 },
  'sprint-step': { paintRadius: 7, hearingRadius: 24, coneAngleDeg: 360, intensity: 1.0 },
  landing: { paintRadius: 8, hearingRadius: 28, coneAngleDeg: 360, intensity: 1.0 },
  'q-ping': { paintRadius: 12, hearingRadius: 18, coneAngleDeg: 360, intensity: 1.05 },
  'e-ping': { paintRadius: 40, hearingRadius: 30, coneAngleDeg: 25, intensity: 1.15 },
};

/** Softest landing that rings out at all, m/s — roughly a 0.8 m drop at the default gravity. */
export const LANDING_MIN_IMPACT = 5;
/** Impact speed that earns the top of the 8-14 m landing band, m/s (~a 6 m drop). */
export const LANDING_FULL_IMPACT = 14;
/** Top of the landing paint band, metres (§3.3). */
export const LANDING_MAX_RADIUS = 14;

export interface SoundEvent {
  readonly class: SoundClass;
  /** Origin — the place the sound was made, which is what the paint spreads from. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly paintRadius: number;
  readonly hearingRadius: number;
  /** Loudness, ~1 = the class's nominal value. Scales blip density and brightness. */
  readonly intensity: number;
  /** Unit aim vector; (0, 0, 0) for an omnidirectional event. */
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  /** Full apex angle in degrees; 360 for omnidirectional. */
  readonly coneAngleDeg: number;
  /** Scene clock at emission, seconds. */
  readonly time: number;
  /** Monotonic counter — a stable identity for tooling and for seeding per-event sampling. */
  readonly seq: number;
}

export interface SoundEmitSpec {
  class: SoundClass;
  x: number;
  y: number;
  z: number;
  /** Overrides the class profile (landings, and chip-modified pings later). */
  paintRadius?: number;
  hearingRadius?: number;
  intensity?: number;
  /** Aim for a directional class. Normalised here; ignored by omnidirectional classes. */
  dirX?: number;
  dirY?: number;
  dirZ?: number;
  coneAngleDeg?: number;
}

export type SoundListener = (event: SoundEvent) => void;

export class SoundBus {
  private readonly listeners = new Set<SoundListener>();
  private seq = 0;
  private now = 0;
  private last: SoundEvent | null = null;

  /** Scene clock, in seconds. Set once per tick before anything emits. */
  setTime(seconds: number): void {
    this.now = seconds;
  }

  get time(): number {
    return this.now;
  }

  /** The most recent event, for HUD readouts and tooling. */
  get lastEvent(): SoundEvent | null {
    return this.last;
  }

  /** Events emitted since construction. */
  get emitted(): number {
    return this.seq;
  }

  subscribe(listener: SoundListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(spec: SoundEmitSpec): SoundEvent {
    const profile = SOUND_CLASSES[spec.class];
    let dx = spec.dirX ?? 0;
    let dy = spec.dirY ?? 0;
    let dz = spec.dirZ ?? 0;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) {
      dx /= len;
      dy /= len;
      dz /= len;
    } else {
      dx = 0;
      dy = 0;
      dz = 0;
    }
    const cone = spec.coneAngleDeg ?? profile.coneAngleDeg;
    const event: SoundEvent = {
      class: spec.class,
      x: spec.x,
      y: spec.y,
      z: spec.z,
      paintRadius: spec.paintRadius ?? profile.paintRadius,
      hearingRadius: spec.hearingRadius ?? profile.hearingRadius,
      intensity: spec.intensity ?? profile.intensity,
      // A cone with no aim is a contradiction; fall back to omni rather than paint a slit.
      dirX: dx,
      dirY: dy,
      dirZ: dz,
      coneAngleDeg: len > 1e-6 ? cone : 360,
      time: this.now,
      seq: this.seq++,
    };
    this.last = event;
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Landing paint radius from touchdown speed — the 8-14 m band of §3.3. */
  static landingRadius(impactSpeed: number): number {
    const t =
      (impactSpeed - LANDING_MIN_IMPACT) / (LANDING_FULL_IMPACT - LANDING_MIN_IMPACT);
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    const base = SOUND_CLASSES.landing.paintRadius;
    return base + (LANDING_MAX_RADIUS - base) * clamped;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
