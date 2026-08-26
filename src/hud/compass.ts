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
import { isSoundPerceivableAt } from '../events/perception';

/** Sources the compass refuses to report, because they are always at the player himself. */
const SELF: ReadonlySet<SoundSource> = new Set<SoundSource>(['player-step', 'player-land', 'gunshot', 'reload']);

/**
 * Colour is identity, not quantity — the one rule this palette has.
 *
 * The channel used to be colourless on principle ("в игре нет цвета"), and the compass paid for
 * it: six near-identical warm hues that said nothing, because they were all shades of the same
 * "a noise happened". The human's call of 2026-08-25 changes what colour is *for*: it now
 * answers "who made that", and nothing else. Never how loud, never how far — those are already
 * brightness, and a second encoding of them would only make the ring harder to read.
 *
 * So the palette is two entries wide and stays that way:
 *
 *  - **alien** — something alive that is not you: red, and it is the only red on the ring.
 *  - **neutral** — everything else the world does: a cold bone grey with no hue worth the name.
 *
 * That is the same law "echo" already draws marks by (`src/sound/markers.ts`), which is the
 * point: one glance at the ring and one glance at a mark have to agree about who is out there.
 * Do not add a third colour without a reason as strong as "it is alive".
 *
 * Loudness still sets brightness, so a loud neutral event is a bright grey notch and a faint
 * spider is a dim red one — you can always tell the two apart by hue at any brightness.
 */
const ALIEN: readonly [number, number, number] = [255, 62, 46];
const NEUTRAL: readonly [number, number, number] = [214, 222, 216];

/** Sources that are something alive and not you. Extended, never guessed at by hue. */
const ALIVE: ReadonlySet<SoundSource> = new Set<SoundSource>(['spider']);

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
  /**
   * On by default since 2026-08-25. It shipped off because it looked too strong on paper; the
   * human played with it and decided the opposite — without it the half of the room behind your
   * head is simply not in the game. `O` still switches it off, which is how the with/without
   * comparison is made now.
   */
  enabled = true;

  private readonly blips: Blip[] = [];
  private readonly unsubscribe: () => void;
  private time = 0;
  private readonly capacity: number;
  private listenerX = 0;
  private listenerY = 0;
  private listenerZ = 0;

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
    if (!this.accepts(event)) return;
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

  setListener(x: number, y: number, z: number): void {
    this.listenerX = x;
    this.listenerY = y;
    this.listenerZ = z;
  }

  /** Distance admission only; source/min-loudness policy remains the compass's own concern. */
  accepts(event: SoundEvent): boolean {
    return isSoundPerceivableAt(event, this.listenerX, this.listenerY, this.listenerZ);
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

  /** True when the noise was made by something alive that is not the player. */
  static alien(source: SoundSource): boolean {
    return ALIVE.has(source);
  }

  /** Stroke colour for a source, as an `rgb` triple. Two entries wide, on purpose — see above. */
  static color(source: SoundSource): [number, number, number] {
    const c = ALIVE.has(source) ? ALIEN : NEUTRAL;
    return [c[0], c[1], c[2]];
  }

  clear(): void {
    this.blips.length = 0;
  }

  dispose(): void {
    this.unsubscribe();
  }
}
