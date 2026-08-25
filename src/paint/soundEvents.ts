/**
 * The sound event bus — vision doc §3.1 and design laws 1 and 2.
 *
 * *Every* noise in the game goes through `SoundBus.emit`. There is deliberately no second
 * path: if a thing can be heard, it exists here, with a real origin and a real loudness, and
 * anything that listens (the paint system today; dog hearing, heat and the audio mixer later)
 * subscribes to the same stream. That is what makes law 2 — "the system never lies" —
 * enforceable rather than aspirational: geometry drawn with no event behind it is impossible
 * to produce.
 *
 * An event carries two radii, and they are not the same number:
 *  - `paintRadius`  — how much static geometry the sound reveals around its origin (§3.3,
 *                     left column). This is what the *player* gets out of the noise.
 *  - `hearingRadius`— how far away a listener can notice the event at all (§3.3, right
 *                     column). Nothing consumes it yet; the robo-dogs will.
 *
 * The bus itself is inert: it stamps, validates and fans out. All interpretation belongs to
 * subscribers. Two rules make that fan-out something a growing cast of emitters can rely on:
 *
 *  - **A listener must not emit.** Doing so throws. A sound is made by the simulation, never by
 *    another sound's delivery; anything that answers what it hears answers in its own tick phase,
 *    at most one tick (8 ms) later. See `emit`.
 *  - **An event's listeners are the ones that existed when it was emitted.** Fan-out walks a
 *    snapshot, so subscribing mid-delivery means "from the next event" and unsubscribing
 *    mid-delivery still receives this one — neither depends on registration order.
 *
 * Neither is a limit on how *much* can be emitted. The bus never drops, throttles or defers
 * anything: a sound the world made and did not paint is precisely what law 2 forbids. It only
 * counts (`emittedThisTick`, `maxEmittedPerTick`), so that an emitter firing per tick instead of
 * per contact shows up as a number rather than as a mystery.
 */

/**
 * Sound classes implemented so far. `slide`, `prop-knock`, dog gaits, `detonation` and the
 * carried-cell hum are additional rows in the same table of §3.3 and need no new machinery —
 * a class name, a profile entry, an emitter.
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
 * How fast each group's wavefront expands, m/s. The frozen default; the dev panel tunes a
 * simulation's own copy (`SoundTunables`), never this.
 *
 * Not the speed of sound: 343 m/s crosses a 30 m room in 90 ms, which at any frame rate is
 * an instant pop — the thing the wave engine exists to abolish. These are *readable* speeds,
 * chosen so a room read takes about half a second to sweep: the player watches the answer
 * arrive and can tell near from far by when it lit, which is information the pop never gave.
 * The beam is the faster of the two because a directed question should feel like a thrown
 * torch, not a released balloon.
 */
export const WAVE_SPEEDS: Readonly<Record<WaveGroup, number>> = Object.freeze({
  step: 25,
  ping: 25,
  beam: 45,
});

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
 *
 * **Frozen, and both tables are.** They are the *defaults* every simulation copies from, not
 * live state: a dev-panel slider bound straight into this object used to tune every `SoundBus`
 * in the process at once and to make a seeded run irreproducible after anyone had touched the
 * panel. `defaultSoundTunables()` below hands each run its own copy, and freezing these means
 * the old mistake throws instead of quietly coming back (module code is strict mode).
 */
export const SOUND_CLASSES: Readonly<Record<SoundClass, Readonly<SoundClassProfile>>> =
  Object.freeze({
    'crouch-step': Object.freeze({ paintRadius: 1.5, hearingRadius: 2, coneAngleDeg: 360, intensity: 0.7, wave: 'step' as const }),
    'walk-step': Object.freeze({ paintRadius: 4, hearingRadius: 11, coneAngleDeg: 360, intensity: 0.9, wave: 'step' as const }),
    'sprint-step': Object.freeze({ paintRadius: 7, hearingRadius: 24, coneAngleDeg: 360, intensity: 1.0, wave: 'step' as const }),
    landing: Object.freeze({ paintRadius: 8, hearingRadius: 28, coneAngleDeg: 360, intensity: 1.0, wave: 'step' as const }),
    'q-ping': Object.freeze({ paintRadius: 12, hearingRadius: 18, coneAngleDeg: 360, intensity: 1.05, wave: 'ping' as const }),
    'e-ping': Object.freeze({ paintRadius: 22, hearingRadius: 30, coneAngleDeg: 110, intensity: 1.15, wave: 'beam' as const }),
  });

/**
 * One simulation's own copy of the two tables above.
 *
 * The dev panel writes *here*, which is what makes two `GameSim`s in one process independent and
 * a seeded run reproducible regardless of what anybody dragged. `SoundBus` reads it on every
 * emit, so a slider takes effect on the next sound and never retroactively.
 */
export interface SoundTunables {
  readonly classes: Record<SoundClass, SoundClassProfile>;
  readonly waveSpeeds: Record<WaveGroup, number>;
}

/** A fresh, independent, mutable copy of the frozen defaults. */
export function defaultSoundTunables(): SoundTunables {
  const classes = {} as Record<SoundClass, SoundClassProfile>;
  for (const key of Object.keys(SOUND_CLASSES) as SoundClass[]) {
    classes[key] = { ...SOUND_CLASSES[key] };
  }
  return { classes, waveSpeeds: { ...WAVE_SPEEDS } };
}

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
  /** Loudness, ~1 = the class's nominal value. Scales how much the event reveals. */
  readonly intensity: number;
  /** Unit aim vector; (0, 0, 0) for an omnidirectional event. */
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  /** Full apex angle in degrees; 360 for omnidirectional. */
  readonly coneAngleDeg: number;
  /**
   * How fast this event's wavefront expands, m/s. Nothing the event reveals exists before the
   * front has physically reached it: a surface's birth stamp is `time + distance / waveSpeed`.
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

/**
 * The fan-out buffer, and the flag that makes one buffer enough.
 *
 * Both are module-level and they are a pair — the same scope on purpose. `src/core/collision.ts`
 * documents the convention: a module-level scratch is correct exactly as long as calls happen
 * sequentially on one thread, and the one thing that breaks it is reentrancy. Collision can rely
 * on that for free because nothing there takes a callback. A bus is nothing *but* callbacks, so
 * it has to enforce the property instead of assuming it, and `fanningOut` is that enforcement.
 *
 * Which is why the flag cannot be per-instance while the buffer is shared: bus A mid-fan-out
 * while a listener emits on bus B would leave B's copy sitting in the array A is still walking.
 * One flag over one buffer means the only way to reach the buffer twice at once now throws.
 */
const fanoutScratch: SoundListener[] = [];
let fanningOut = false;

export class SoundBus {
  /**
   * This bus's sound table. Owned by whoever constructed it (the simulation), never shared with
   * another bus unless a caller deliberately hands the same object to both.
   */
  readonly tunables: SoundTunables;

  private readonly listeners = new Set<SoundListener>();
  private seq = 0;
  private now = 0;
  private last: SoundEvent | null = null;
  private tickCount = 0;
  private tickPeak = 0;

  constructor(tunables: SoundTunables = defaultSoundTunables()) {
    this.tunables = tunables;
  }

  /**
   * Scene clock, in seconds. Set once per tick before anything emits — which is what makes it
   * the tick boundary, and therefore the place the per-tick emission counter resets.
   */
  setTime(seconds: number): void {
    this.now = seconds;
    this.tickCount = 0;
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

  /**
   * Events emitted since the last `setTime` — this tick's total.
   *
   * Observability, never a gate. The bus does not drop, throttle or defer anything however high
   * this climbs: a dropped event is a sound with no paint, which is the one thing design law 2
   * forbids the system to produce. A flood is a bug in whatever is emitting, and the only useful
   * thing the bus can do about it is make the number impossible to miss. Today one player emits
   * at most a handful a tick; M2 adds twenty throwables and M4 adds spiders, and the day one of
   * them emits per-tick instead of per-contact this is what says so.
   */
  get emittedThisTick(): number {
    return this.tickCount;
  }

  /** The worst tick so far, by `emittedThisTick`. Never reset; a high-water mark. */
  get maxEmittedPerTick(): number {
    return this.tickPeak;
  }

  subscribe(listener: SoundListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(spec: SoundEmitSpec): SoundEvent {
    /*
     * A sound is made by the simulation, never by another sound's delivery.
     *
     * Something that reacts audibly to what it hears — a spider that skitters when a ping lands,
     * a prop that rattles when something loud goes past — emits in its *own* tick phase, one tick
     * later at most: 8 ms at 120 Hz, which no player can perceive. Queuing the reentrant emit
     * instead would work, and that is the problem: it would bury a real ordering decision inside
     * the bus, where nobody making a game-design choice would ever look for it. Whether the
     * spider's answer is heard before or after the rest of this tick's sounds would then depend
     * on which listener happened to be registered first, which is exactly the "who heard what
     * first" ambiguity determinism exists to kill.
     *
     * Thrown before the sequence number is taken, so a rejected emit leaves no trace on the bus.
     */
    if (fanningOut) {
      throw new Error(
        `SoundBus.emit('${spec.class}') was called from inside another event's fan-out. ` +
          'A listener must not emit: emit from the emitter\'s own tick phase instead.',
      );
    }
    const profile = this.tunables.classes[spec.class];
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
      waveSpeed: Math.max(0.5, spec.waveSpeed ?? this.tunables.waveSpeeds[profile.wave]),
      time: this.now,
      seq: this.seq++,
    };
    this.last = event;
    this.tickCount++;
    if (this.tickCount > this.tickPeak) this.tickPeak = this.tickCount;

    /*
     * Fan out over a snapshot, not over the live set.
     *
     * A JS `Set` iterated with for-of visits entries added *during* the iteration, so a listener
     * that subscribes while an event is being delivered would receive that same event — and one
     * that unsubscribes would or would not, depending on where in the set it sat. Both make
     * delivery depend on registration order rather than on subscription time. The snapshot fixes
     * the answer in one direction for both: the set of listeners for an event is the set that
     * existed when it was emitted. Subscribing during fan-out means "from the next event";
     * unsubscribing during fan-out still receives this one.
     */
    fanoutScratch.length = 0;
    for (const listener of this.listeners) fanoutScratch.push(listener);
    fanningOut = true;
    try {
      for (let i = 0; i < fanoutScratch.length; i++) fanoutScratch[i]!(event);
    } finally {
      // `finally`, so a listener that throws does not wedge the bus shut for the rest of the
      // run. The throw itself still propagates — the bus does not swallow other people's errors.
      fanningOut = false;
      fanoutScratch.length = 0;
    }
    return event;
  }

  /**
   * Landing paint radius from touchdown speed — the 8-14 m band of §3.3.
   *
   * Static, and reads the frozen default rather than a bus's own table, because the landing band
   * is not on the dev panel: nothing can tune it, so nothing can make two buses disagree. Give it
   * a slider one day and it moves onto the instance with the rest of them.
   */
  static landingRadius(impactSpeed: number): number {
    const t =
      (impactSpeed - LANDING_MIN_IMPACT) / (LANDING_FULL_IMPACT - LANDING_MIN_IMPACT);
    /*
     * NaN is answered with the floor of the band, not passed through.
     *
     * `t < 0 ? 0 : t > 1 ? 1 : t` is a correct clamp for every number and a trapdoor for the
     * one value that is not one: NaN fails both comparisons and falls out the bottom unchanged,
     * so a NaN impact speed used to produce a NaN paint radius. That does not throw. It paints
     * nothing — every distance comparison downstream is false — and a silent landing is a law-2
     * lie: the event was emitted, the sound was made, and the world drew none of it.
     *
     * So a landing whose speed we cannot measure is still a landing, and it rings out at the
     * quietest thing a landing can be. The order matters: the NaN test has to come first, or the
     * comparisons it is protecting against have already run.
     *
     * ±Infinity needs no guard and deliberately does not get one — they are not degenerate, they
     * are the ends of the band. -Infinity clamps to 0 and +Infinity to 1, which is the loudest
     * possible landing answering with the loudest radius in §3.3. Every input now lands inside
     * the 8-14 m band.
     */
    const clamped = Number.isNaN(t) || t < 0 ? 0 : t > 1 ? 1 : t;
    const base = SOUND_CLASSES.landing.paintRadius;
    return base + (LANDING_MAX_RADIUS - base) * clamped;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
