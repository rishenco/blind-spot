/**
 * The sound event bus — concept §"звук порождается физикой, а не скриптами".
 *
 * Every noise in the game goes through `SoundBus.emit`, and there is deliberately no second
 * path. Three subsystems will consume this stream and none of them will know about each other:
 * procedural audio (M3), the sound-marker layer (M2), and spider hearing (M4). In M1 only the
 * debug overlay listens, and the only emitter is the player's own body — which is exactly the
 * concept's joke: your own footsteps are pure cost, they tell you nothing you did not know.
 *
 * The bus is inert. It stamps, normalises and fans out; all interpretation belongs to
 * subscribers. Loudness is a physical quantity (impulse-derived once props move in M2), not a
 * per-class magic number, so `emit` takes it rather than looking it up.
 *
 * The lidar is *not* on this bus. Spiders do not hear it; putting it here would eventually let
 * some future listener hear it by accident.
 */

/** Where a noise came from. Extended, never re-purposed, as the game grows. */
export type SoundSource =
  | 'player-step'
  | 'player-land'
  | 'prop-impact'
  | 'gunshot'
  | 'bullet-hit'
  /**
   * A magazine swap (M6a). Added because the reload is a *moment*, not a pause: the player is
   * blind, useless and — now — audible, at a fraction of a gunshot's reach. It is a separate
   * source rather than a quiet 'gunshot' so the mixer and the marker layer can give it its own
   * character without having to guess from loudness.
   */
  | 'reload'
  | 'spider';

/**
 * What a spider noise *is*, when the emitter is a spider.
 *
 * Added because the audio side was telling clicks from bites by their loudness, which stops
 * working the moment the pack's chatter is tuned — and it is about to be. Only the swarm sets
 * it; every consumer must still work when it is absent, like `material`.
 */
export type SpiderSoundKind = 'chatter' | 'step' | 'bite' | 'death';

export interface SoundEvent {
  readonly source: SoundSource;
  /** Origin — the place the noise was made. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * Loudness in metres: how far away this noise can be noticed at all. One unit for the whole
   * game so the M2 marker radius, the M3 mixer gain and the M4 hearing check all read the same
   * number instead of each inventing a scale.
   */
  readonly loudness: number;
  /** Scene clock at emission, seconds. */
  readonly time: number;
  /** Monotonic counter — stable identity for tooling and for seeding per-event sampling. */
  readonly seq: number;
  /**
   * What made the noise, materially: 'glass', 'tin', 'steel', 'wood', 'plastic', or absent when
   * the emitter has nothing useful to say (a footstep, for now).
   *
   * Added in M2 for the audio synth, which has no sample library and must derive a bottle's ring
   * from *something*. It is a hint, not a contract: every consumer has to work without it, which
   * is why it is optional rather than a required field with a meaningless default.
   */
  readonly material?: string;
  /**
   * For `source: 'spider'` only: which of the animal's noises this is. The swarm makes four
   * quite different sounds and they used to be told apart downstream by loudness alone, which
   * was a guess that broke the moment the chatter was made louder. Optional, and every consumer
   * must still work without it — the swarm and the mixer land in separate commits.
   */
  readonly kind?: SpiderSoundKind;
}

/** The four noises a spider makes. Nothing else on the bus uses this. */
export type SpiderKind = 'chatter' | 'step' | 'bite' | 'death';

export interface SoundEmitSpec {
  source: SoundSource;
  x: number;
  y: number;
  z: number;
  loudness: number;
  material?: string;
  kind?: SpiderSoundKind;
}

export type SoundListener = (event: SoundEvent) => void;

export class SoundBus {
  private readonly listeners = new Set<SoundListener>();
  private seq = 0;
  private now = 0;
  private last: SoundEvent | null = null;
  private readonly recent: SoundEvent[] = [];
  private readonly totals = new Map<SoundSource, number>();
  /** How many events the ring buffer keeps for the debug overlay. */
  private readonly keep = 32;

  /** Scene clock, seconds. Set once per tick, before anything emits. */
  setTime(seconds: number): void {
    this.now = seconds;
  }

  get time(): number {
    return this.now;
  }

  get lastEvent(): SoundEvent | null {
    return this.last;
  }

  /** Events emitted since construction. */
  get emitted(): number {
    return this.seq;
  }

  /** Newest-last window of recent events, for the debug overlay. */
  get recentEvents(): readonly SoundEvent[] {
    return this.recent;
  }

  subscribe(listener: SoundListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(spec: SoundEmitSpec): SoundEvent {
    const event: SoundEvent = {
      source: spec.source,
      x: spec.x,
      y: spec.y,
      z: spec.z,
      loudness: Math.max(0, spec.loudness),
      material: spec.material,
      kind: spec.kind,
      time: this.now,
      seq: this.seq++,
    };
    this.last = event;
    this.totals.set(spec.source, (this.totals.get(spec.source) ?? 0) + 1);
    this.recent.push(event);
    if (this.recent.length > this.keep) this.recent.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /**
   * Lifetime per-source totals. It used to count the 32-event `recent` window instead, which
   * made the overlay's "step N · prop M" read as totals while quietly being a sample: walk
   * through a pile and the step counter goes *down*. Totals are what both the overlay and the
   * keyframe scenarios actually want.
   */
  countsBySource(): Map<SoundSource, number> {
    return this.totals;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
