/**
 * The noise compass: the fourth channel's blind spot, patched by the same instrument.
 *
 * Why it exists. The sound layer draws a mark *at the point the noise happened* — that is a law
 * and it is not negotiable. The consequence is that everything that happens behind you is drawn
 * behind you, i.e. nowhere, and the one channel that was supposed to tell you a spider moved is
 * silent about the half of the room you are not looking at. The alternatives are all worse: the
 * player spins on the spot every two seconds (and knocks the room over with the rifle barrel he
 * is swinging), or he simply never learns the thing the channel exists to teach.
 *
 * What it is allowed to be, from the spec, and every one of these is a restriction rather than
 * a feature:
 *
 *  - **off-screen only.** A noise whose mark is already in frame is not repeated on the ring.
 *    The compass never *adds* information, it only refuses to lose it.
 *  - **direction, never distance.** A notch on a ring. Loudness sets how bright it is, because
 *    the instrument can honestly tell a bang from a scratch, and nothing sets how far away it
 *    is, because it cannot.
 *  - **shorter-lived than the mark itself.** This is "something was behind you just now", not a
 *    threat list that accumulates.
 *  - **your own noise is not on it.** Steps, landings and the muzzle are all at your own feet;
 *    the concept's joke is that they tell you nothing, and a compass that pointed at yourself
 *    would be the exact opposite of the joke. Bullet impacts *are* on it — they happen where the
 *    round landed, which may well be behind you after a ricochet off a rack.
 *
 * Determinism: it is a plain ring buffer keyed on the simulation clock; the only stochastic
 * looking thing in the whole file is the low-health flicker, which is a hash of the event id and
 * the frame's own time, so it replays identically.
 */
import type { SoundBus, SoundEvent, SoundSource } from '../events/bus';

/** Sources the compass refuses to report, because they are always at the player himself. */
const SELF: ReadonlySet<SoundSource> = new Set<SoundSource>(['player-step', 'player-land', 'gunshot']);

/**
 * Stroke colour per source. A deliberate near-echo of the marker layer's thermal palette — same
 * instrument, same warm language — but the compass draws thin cold-struck notches rather than
 * blobs, so the two can never be mistaken for each other. Local numbers on purpose: the marker
 * layer is free to re-style itself without dragging the compass with it.
 */
const LOOK: Record<SoundSource, [number, number, number]> = {
  'player-step': [255, 132, 56],
  'player-land': [255, 122, 40],
  'prop-impact': [255, 196, 106],
  gunshot: [255, 240, 192],
  'bullet-hit': [255, 216, 144],
  spider: [255, 158, 192],
};

export interface CompassTunables {
  /** Seconds a notch lives. Must stay well under the marker layer's own life. */
  life: number;
  /** Loudness, in metres of notice, that reads as full brightness. */
  loudRef: number;
  /** Quietest event worth a notch at all. Below this the instrument heard nothing useful. */
  minLoudness: number;
  /** Angular width of a notch, degrees. Coarse on purpose: a bearing, not a fix. */
  widthDeg: number;
  /** Ring radius as a fraction of half the shorter screen axis. */
  radius: number;
  /** Notch thickness in CSS pixels. */
  thickness: number;
  /** Overall opacity. */
  brightness: number;
  /** Debug: draw notches for on-screen noises too, so the filter itself can be seen working. */
  offscreenOnly: boolean;
}

export function defaultCompassTunables(): CompassTunables {
  return {
    life: 1.6,
    loudRef: 14,
    minLoudness: 1.5,
    widthDeg: 11,
    radius: 0.74,
    thickness: 3,
    brightness: 1,
    offscreenOnly: true,
  };
}

export interface Blip {
  x: number;
  y: number;
  z: number;
  loudness: number;
  at: number;
  seq: number;
  source: SoundSource;
  /** Filled in by the renderer each frame: true when its mark is already visible in frame. */
  onScreen: boolean;
}

export class NoiseCompass {
  readonly tunables: CompassTunables;
  /** Off by default — law 1, and because the whole point is comparing with and without it. */
  enabled = false;

  private readonly blips: Blip[] = [];
  private readonly unsubscribe: () => void;
  private time = 0;
  private readonly capacity: number;

  constructor(bus: SoundBus, tunables: CompassTunables = defaultCompassTunables(), capacity = 64) {
    this.tunables = tunables;
    this.capacity = capacity;
    // A fourth, entirely independent bus subscriber. It learns exactly what the marker layer and
    // the spiders learn — there is no private line to the AI and it cannot report a spider that
    // did not make a noise.
    this.unsubscribe = bus.subscribe((e) => this.handle(e));
  }

  private handle(event: SoundEvent): void {
    if (SELF.has(event.source)) return;
    if (event.loudness < this.tunables.minLoudness) return;
    this.blips.push({
      x: event.x,
      y: event.y,
      z: event.z,
      loudness: event.loudness,
      at: event.time,
      seq: event.seq,
      source: event.source,
      onScreen: false,
    });
    if (this.blips.length > this.capacity) this.blips.shift();
  }

  setTime(now: number): void {
    this.time = now;
    const cut = now - this.tunables.life;
    while (this.blips.length > 0 && this.blips[0]!.at < cut) this.blips.shift();
  }

  /** Live notches, oldest first. The array is the live one — read it, do not keep it. */
  get live(): readonly Blip[] {
    return this.blips;
  }

  get count(): number {
    return this.blips.length;
  }

  /** 0..1 fade of a blip. */
  age(b: Blip): number {
    return 1 - Math.min(1, Math.max(0, (this.time - b.at) / this.tunables.life));
  }

  /** Stroke colour for a source, as an `rgb` triple. */
  static color(source: SoundSource): [number, number, number] {
    return LOOK[source] ?? [255, 200, 150];
  }

  clear(): void {
    this.blips.length = 0;
  }

  dispose(): void {
    this.unsubscribe();
  }
}
