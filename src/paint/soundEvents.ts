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

/**
 * Which wavefront speed a class travels at. Three groups rather than a number per class:
 * everything a body does to the floor propagates alike, the two pings are the two deliberate
 * acts, and three sliders are a tuning surface a playtest can actually hold in its head.
 */
export type WaveGroup = 'step' | 'ping' | 'beam';

/**
 * How fast each group's wavefront expands, m/s. Runtime-tunable from the lab GUI.
 *
 * Not the speed of sound: 343 m/s crosses a 30 m room in 90 ms, which at any frame rate is
 * an instant pop — the thing the wave engine exists to abolish. These are *readable* speeds,
 * chosen so a room read takes about half a second to sweep: the player watches the answer
 * arrive and can tell near from far by when it lit, which is information the pop never gave.
 * The beam is the faster of the two because a directed question should feel like a thrown
 * torch, not a released balloon.
 */
export const WAVE_SPEEDS: Record<WaveGroup, number> = {
  step: 25,
  ping: 25,
  beam: 45,
};

export interface SoundClassProfile {
  /** Paint radius at intensity 1, metres (§3.3). Tunable at runtime. */
  paintRadius: number;
  /** How far a dog hears it, metres (§3.3). Not consumed yet — the enemy arrives later. */
  hearingRadius: number;
  /** Full apex angle of the emission cone in degrees; 360 means omnidirectional. */
  coneAngleDeg: number;
  /** Loudness multiplier applied when the emitter does not name one. */
  intensity: number;
  /** Which entry of `WAVE_SPEEDS` this class's front travels at. */
  readonly wave: WaveGroup;
}

/**
 * §3.3, verbatim where the table gives a single number. `landing` is the one range in the
 * table (8-14 m); its emitter picks a point in that range from the impact speed, so the value
 * here is only the floor.
 *
 * **The E-ping deliberately deviates from §3.3/§3.5.** The doc specifies a 25° cone reaching
 * 40 m: a telescope. Played, that is a bad question — a 25° slit answers "what is exactly
 * where I am already looking", which the player mostly knows, and answers it about a room they
 * cannot reach before the paint has cooled. Batch 2.1 re-roles it as *look around*: a 110°
 * cone at 22 m, which is the width of a corridor plus both its walls and the depth of one
 * decision. Q stays the 360° behind-your-back read, so the two now differ in *shape* rather
 * than in reach, and the E-ping's price (§3.3 right column: dogs hear it at both ends of the
 * beam) is unchanged. The docs get updated when the design settles; until then this comment is
 * the record that the difference is a choice and not a drift.
 */
export const SOUND_CLASSES: Record<SoundClass, SoundClassProfile> = {
  'crouch-step': { paintRadius: 1.5, hearingRadius: 2, coneAngleDeg: 360, intensity: 0.7, wave: 'step' },
  'walk-step': { paintRadius: 4, hearingRadius: 11, coneAngleDeg: 360, intensity: 0.9, wave: 'step' },
  'sprint-step': { paintRadius: 7, hearingRadius: 24, coneAngleDeg: 360, intensity: 1.0, wave: 'step' },
  landing: { paintRadius: 8, hearingRadius: 28, coneAngleDeg: 360, intensity: 1.0, wave: 'step' },
  'q-ping': { paintRadius: 12, hearingRadius: 18, coneAngleDeg: 360, intensity: 1.05, wave: 'ping' },
  'e-ping': { paintRadius: 22, hearingRadius: 30, coneAngleDeg: 110, intensity: 1.15, wave: 'beam' },
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
  /**
   * How fast this event's wavefront expands, m/s. Nothing the event reveals exists before the
   * front has physically reached it: a blip's birth stamp is `time + distance / waveSpeed`.
   */
  readonly waveSpeed: number;
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
  /** Overrides the class's wave group speed (chips that change how a ping propagates). */
  waveSpeed?: number;
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
      waveSpeed: Math.max(0.5, spec.waveSpeed ?? WAVE_SPEEDS[profile.wave]),
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
