/**
 * The lidar — the only channel that gives you real geometry, and the only one that costs you
 * time instead of blood.
 *
 * Concept, perception table: "точная геометрия: конус вперёд + небольшой радиус вокруг.
 * Накопленная карта остаётся. Цена — долгая перезарядка. Пауки его НЕ слышат."
 *
 * So this device does three things and nothing else:
 *
 *   1. It fires *two* wavefronts, not one: a long forward cone (what you aimed at) and a short
 *      omnidirectional halo (the floor under your feet, the shelf at your shoulder). The halo is
 *      what stops a scan from being a torch — you always learn a little about all sides and a
 *      lot about one.
 *   2. It recharges slowly, on the simulation clock, so the cost is paid in seconds of standing
 *      in the dark rather than in ammunition.
 *   3. It is not connected to the sound bus. Not "connected but muted" — not connected. A future
 *      spider that subscribes to the bus therefore *cannot* hear it by accident.
 *
 * The two fronts are emitted one at a time, through a queue. `StructuredPaint.handle` drains any
 * outstanding unlock job synchronously before starting a new one, so pushing both into the same
 * frame would force the cone's amortised unlocking to complete in a single frame — precisely the
 * hitch the amortisation exists to avoid. Instead the halo waits, at most a frame or two, until
 * the cone's job has finished. Nobody can see the difference; the frame timer can.
 */
import type * as THREE from 'three';
import type { LidarPing } from './ping';

export interface LidarTunables {
  /** Full apex angle of the forward cone, degrees. */
  coneAngleDeg: number;
  /** How far the cone reaches, metres. */
  coneRange: number;
  /** Radius of the omnidirectional halo around the player, metres. */
  haloRange: number;
  /** Front expansion speed, m/s — readable rather than physical. */
  waveSpeed: number;
  /** Seconds from empty to a full charge. */
  rechargeSeconds: number;
  /** Charges the device can hold. Fractional charge is spent, so this is also the burst size. */
  charges: number;
}

export function defaultLidarTunables(): LidarTunables {
  return {
    coneAngleDeg: 62,
    coneRange: 34,
    haloRange: 5.5,
    waveSpeed: 42,
    rechargeSeconds: 5,
    charges: 2,
  };
}

export interface LidarState {
  /** Charges available, fractional. */
  charge: number;
  /** 0..1 progress towards the next whole charge. */
  progress: number;
  ready: boolean;
  /** Pings emitted since boot. */
  fired: number;
  /** Fronts still waiting for the renderer to be free. */
  queued: number;
}

export type PingSink = (ping: LidarPing) => void;

export class Lidar {
  readonly tunables: LidarTunables;
  private charge: number;
  private seq = 0;
  private fired = 0;
  private readonly queue: LidarPing[] = [];

  constructor(tunables: LidarTunables = defaultLidarTunables()) {
    this.tunables = tunables;
    this.charge = tunables.charges;
  }

  get state(): LidarState {
    const t = this.tunables;
    return {
      charge: this.charge,
      progress: this.charge >= t.charges ? 1 : this.charge - Math.floor(this.charge),
      ready: this.charge >= 1,
      fired: this.fired,
      queued: this.queue.length,
    };
  }

  /** Refills on the simulation clock. Called once per fixed tick. */
  update(dt: number): void {
    const t = this.tunables;
    if (this.charge >= t.charges) return;
    this.charge = Math.min(t.charges, this.charge + dt / Math.max(0.01, t.rechargeSeconds));
  }

  /**
   * Spends a charge and queues the two fronts. Returns false (and costs nothing) when empty.
   * `origin` is the emitter — eye height, not floor — and `forward` is the aim.
   */
  fire(origin: THREE.Vector3, forward: THREE.Vector3, time: number): boolean {
    if (this.charge < 1) return false;
    this.charge -= 1;
    const t = this.tunables;
    const len = Math.hypot(forward.x, forward.y, forward.z) || 1;
    const dirX = forward.x / len;
    const dirY = forward.y / len;
    const dirZ = forward.z / len;
    this.queue.push({
      x: origin.x, y: origin.y, z: origin.z,
      dirX, dirY, dirZ,
      coneAngleDeg: t.coneAngleDeg,
      paintRadius: t.coneRange,
      waveSpeed: t.waveSpeed,
      time,
      seq: this.seq++,
    });
    this.queue.push({
      x: origin.x, y: origin.y, z: origin.z,
      dirX: 0, dirY: 1, dirZ: 0,
      coneAngleDeg: 360,
      paintRadius: t.haloRange,
      waveSpeed: t.waveSpeed,
      time,
      seq: this.seq++,
    });
    return true;
  }

  /**
   * Hands the renderer at most one front, and only when it has nothing outstanding.
   * `busy` is the renderer's own answer to "have you still got work from the last one".
   */
  pump(busy: boolean, sink: PingSink): void {
    if (busy) return;
    const ping = this.queue.shift();
    if (ping === undefined) return;
    this.fired++;
    sink(ping);
  }

  /**
   * Drops every front that has not been handed to the renderer yet.
   *
   * "Forget the map" has to mean the screen goes black and stays black. Without this it did not:
   * a ping fired a moment earlier is two fronts sitting in this queue, the renderer takes them
   * one at a time, and they were still handed over *after* the clear — so the hall wiped itself
   * and then quietly painted several thousand dots back in over the next two frames. Costs no
   * charge back, deliberately: the shot was fired, the noise was made.
   */
  flush(): void {
    this.queue.length = 0;
  }

  /** Debug affordance only: refills without waiting. */
  refill(): void {
    this.charge = this.tunables.charges;
  }
}
