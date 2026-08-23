/**
 * Sound events — the one source of truth for perception (engine-plan §4).
 *
 * Vision §1 law 1: every way of learning emits sound the world can hear. So every emitter
 * (movement, pings, dogs, props) publishes here, and every consumer (paint, stains, audio,
 * debug) subscribes here. Nothing may derive perception by reading the world directly — that
 * is what "event-sourced from day one" means (vision §16): the solo prototype needs a
 * transport for co-op, not a rewrite.
 *
 * MILESTONE SEAM. M2 owns emission (movement's strides, landings, slides) and the bus.
 * `wallsToListener` / `distToListener` / `quality` are *delivery* fields: they are per-listener
 * and belong to M3's propagation pass, which walks the ring and fills them in (or, more likely,
 * produces per-listener delivery records from them). They are declared and settable here — with
 * the neutral "heard perfectly at the source" values — and are deliberately NOT computed:
 * `eventQuality()` in core/math.ts is the formula waiting for that pass, and the delivery gate
 * (`d <= max(HEARING_BASE, hearRadius)`) belongs to the bus's delivery API, not to emission.
 */

import { EV, EVENT_RING } from './const.js';
import { hash1 } from './math.js';
import type { V3 } from './map/types.js';

/** Declared as a tuple so the class list, the type and the per-class tally cannot drift apart. */
export const SOUND_CLASSES = [
  'crouchStep',
  'walkStep',
  'sprintStep',
  'landing',
  'slide',
  'mantle',
  'propKnock',
  'chainRattle',
  'qPing',
  'ePing',
  'dogGait',
  'detonation',
  'beaconHum',
] as const;
export type SoundClass = (typeof SOUND_CLASSES)[number];

export const SOURCE_KINDS = ['self', 'dog', 'prop', 'objective', 'detonation', 'teammate'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Variants of a class that share its identity but not its numbers (vision §3.3 lists them as
 * separate rows): the dog's three gaits, and the chain curtain's loud/quiet pass. Kept off
 * `SoundClass` on purpose — a consumer switching on "it's a dog gait" must not have to know
 * which gait, and the colour/shape language is per class.
 *
 * `far` is the E-ping's other end: vision §3.3 gives the row one class heard "at **both ends**
 * of the beam", so the arrival at the beam's impact centre is the same ePing with its own
 * numbers (hear 30, paints nothing — the near end already painted the cone).
 */
export type SoundVariant = 'patrol' | 'investigate' | 'chase' | 'loud' | 'quiet' | 'far';

export interface SoundCone {
  /** Aim direction; need not be normalised (see `inCone` in core/math.ts). */
  readonly dir: V3;
  /** FULL cone angle in degrees — 25 means ±12.5 around `dir`. */
  readonly angleDeg: number;
}

export interface SoundEvent {
  readonly id: number;
  /** Sim time at emission. */
  readonly time: number;
  readonly origin: V3;
  readonly class: SoundClass;
  readonly source: SourceKind;
  /**
   * Carried on the event, not just used to look the numbers up: a consumer that styles or
   * synthesises per variant (the E-ping's return, the dog's three gaits, the chain's two passes)
   * cannot recover it from the radii, and guessing it from them would be a second, wrong truth.
   */
  readonly variant?: SoundVariant;
  /** 0..1 — scales paint density (engine-plan §3 step 3). */
  readonly intensity: number;
  /** Paint radius at the origin, in metres (vision §3.3). */
  readonly paintRadius: number;
  /** How far this event can be heard, in metres. */
  readonly hearRadius: number;
  /** E-ping only. */
  readonly cone?: SoundCone;
  /** m/s; `Infinity` for the instant classes. */
  readonly waveSpeed: number;
  /** Stable [0,1) per-event value for fuzzed origins and audio jitter — never Math.random(). */
  readonly fuzzSeed: number;

  // --- delivery (M3 fills these per listener; see the milestone seam note above) ------------
  wallsToListener: 0 | 1 | 2;
  distToListener: number;
  quality: number;
}

export interface ClassDefaults {
  readonly paint: number;
  /** Present on classes whose paint radius scales (landing by fall height, prop by impulse). */
  readonly paintMax?: number;
  readonly hear: number;
  readonly intensity: number;
  readonly wave: number;
  readonly coneDeg?: number;
}

/**
 * The vision §3.3 row for a class (+ variant). Emitters read this instead of hard-coding
 * numbers, so the table in const.ts stays the only place tuning lives.
 */
export function classDefaults(cls: SoundClass, variant?: SoundVariant): ClassDefaults {
  switch (cls) {
    case 'crouchStep':
      return EV.crouchStep;
    case 'walkStep':
      return EV.walkStep;
    case 'sprintStep':
      return EV.sprintStep;
    case 'landing':
      return EV.landing;
    case 'slide':
      return EV.slide;
    case 'mantle':
      return EV.mantle;
    case 'propKnock':
      return EV.propKnock;
    case 'chainRattle':
      return variant === 'quiet' ? EV.chainRattleQuiet : EV.chainRattleLoud;
    case 'qPing':
      return EV.qPing;
    case 'ePing':
      return EV.ePing;
    case 'dogGait':
      return variant === 'chase'
        ? EV.dogGaitChase
        : variant === 'investigate'
          ? EV.dogGaitInvestigate
          : EV.dogGaitPatrol;
    case 'detonation':
      return EV.detonation;
    case 'beaconHum':
      return EV.beaconHum;
  }
}

/** What an emitter hands the bus. Anything omitted comes from the class row. */
export interface EmitSpec {
  readonly class: SoundClass;
  readonly source: SourceKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly variant?: SoundVariant;
  readonly intensity?: number;
  readonly paintRadius?: number;
  readonly hearRadius?: number;
  readonly cone?: SoundCone;
  readonly waveSpeed?: number;
}

export type SoundListener = (e: SoundEvent) => void;

const zeroCounts = (): Record<SoundClass, number> => {
  const c = {} as Record<SoundClass, number>;
  for (const k of SOUND_CLASSES) c[k] = 0;
  return c;
};

/**
 * The bus the sim owns. Emission is synchronous: listeners run inside the emitting fixed step,
 * so audio and paint see events in exactly the order they happened, with the sim's own clock.
 *
 * Deliberately not an EventTarget: no DOM, no strings, no allocation per dispatch — this runs
 * inside the 60 Hz step and must stay boring.
 */
export class EventBus {
  /**
   * The sim writes this at the top of every fixed step; emitters never pass a timestamp, so an
   * event can never be stamped with a clock that disagrees with the step that produced it.
   */
  now = 0;

  /** Monotonic, never reused — `fuzzSeed` and stain identity both hang off it. */
  private nextId = 1;
  private readonly ring: (SoundEvent | null)[] = new Array<SoundEvent | null>(EVENT_RING).fill(null);
  /** Index of the next write. */
  private head = 0;
  private stored = 0;
  private readonly listeners = new Set<SoundListener>();

  /** Lifetime totals — the F3 overlay and the verify script read these. */
  emitted = 0;
  readonly counts: Record<SoundClass, number> = zeroCounts();
  last: SoundEvent | null = null;

  emit(spec: EmitSpec): SoundEvent {
    const d = classDefaults(spec.class, spec.variant);
    const id = this.nextId++;
    const e: SoundEvent = {
      id,
      time: this.now,
      origin: [spec.x, spec.y, spec.z],
      class: spec.class,
      source: spec.source,
      ...(spec.variant ? { variant: spec.variant } : {}),
      intensity: spec.intensity ?? d.intensity,
      paintRadius: spec.paintRadius ?? d.paint,
      hearRadius: spec.hearRadius ?? d.hear,
      ...(spec.cone ? { cone: spec.cone } : {}),
      waveSpeed: spec.waveSpeed ?? d.wave,
      fuzzSeed: hash1(id),
      // Neutral delivery: heard at the source, through nothing. M3 overwrites per listener.
      wallsToListener: 0,
      distToListener: 0,
      quality: 1,
    };

    this.ring[this.head] = e;
    this.head = (this.head + 1) % this.ring.length;
    if (this.stored < this.ring.length) this.stored++;
    this.emitted++;
    this.counts[e.class]++;
    this.last = e;

    for (const fn of this.listeners) fn(e);
    return e;
  }

  /** Subscribe. Returns the unsubscribe. */
  on(fn: SoundListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** How many events the ring currently holds (≤ EVENT_RING). */
  get size(): number {
    return this.stored;
  }

  /** `at(0)` is the newest event, `at(1)` the one before it. Null past the end. */
  at(i: number): SoundEvent | null {
    if (i < 0 || i >= this.stored) return null;
    return this.ring[(this.head - 1 - i + this.ring.length * 2) % this.ring.length] ?? null;
  }

  /** Newest first. Allocates; for per-frame consumers prefer `at()`. */
  recent(limit = this.stored): SoundEvent[] {
    const out: SoundEvent[] = [];
    const n = Math.min(limit, this.stored);
    for (let i = 0; i < n; i++) {
      const e = this.at(i);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * Drops history and tallies; listeners stay subscribed. Used by specs and by run restarts.
   *
   * `nextId` deliberately does NOT reset: ids stay monotonic for the life of the bus. A consumer
   * that keeps derived state keyed by event id (M3 paint splats, the M4 stain layer) would
   * otherwise see a post-reset event collide with a pre-reset one it is still holding, and
   * `fuzzSeed = hash1(id)` would replay the same jitter — the same footstep landing in the same
   * fuzzed place twice, which is vision §1.2's "the system never lies" quietly failing.
   */
  reset(): void {
    this.ring.fill(null);
    this.head = 0;
    this.stored = 0;
    this.emitted = 0;
    this.last = null;
    for (const k of SOUND_CLASSES) this.counts[k] = 0;
  }
}
