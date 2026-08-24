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
  | 'spider';

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
}

export interface SoundEmitSpec {
  source: SoundSource;
  x: number;
  y: number;
  z: number;
  loudness: number;
}

export type SoundListener = (event: SoundEvent) => void;

export class SoundBus {
  private readonly listeners = new Set<SoundListener>();
  private seq = 0;
  private now = 0;
  private last: SoundEvent | null = null;
  private readonly recent: SoundEvent[] = [];
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
      time: this.now,
      seq: this.seq++,
    };
    this.last = event;
    this.recent.push(event);
    if (this.recent.length > this.keep) this.recent.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Per-source counters, for the overlay's "events flowing" readout. */
  countsBySource(): Map<SoundSource, number> {
    const out = new Map<SoundSource, number>();
    for (const e of this.recent) out.set(e.source, (out.get(e.source) ?? 0) + 1);
    return out;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
