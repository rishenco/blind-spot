/**
 * The tactile layer — "серый «тактильный» контур в ~0.5 м от игрока".
 *
 * This is the channel of last resort: it costs nothing, makes no noise, and tells you almost
 * nothing. You get whatever is within arm's reach and nothing else — and one further thing that
 * turns out to matter a lot in the dark: what you have already felt stays, faintly. Feeling your
 * way along a shelf leaves a thread behind you.
 *
 * It is **not a geometry system.** Batch M1 gave it its own wireframe buffer, and that is exactly
 * where the "tactile telekinesis" came from: the smallest thing it could draw was a whole box, so
 * brushing one corner of a crate handed you the crate, and a flat wall — whose only edges are
 * sixty metres away in the dark — appeared not to react at all.
 *
 * So this file now owns no vertices. It is a *driver* over the one shared mask in
 * `StructuredPaint`: every frame it asks the paint to mark the lattice dots and contour pieces
 * inside the reach sphere as touched (`revealTouch`), and the paint draws exactly those, grey,
 * bright under the hand and faint once you have moved on. A wall reacts because a wall has
 * lattice dots like everything else; a crate does not give itself away, because a dot two metres
 * up its far side was never within reach.
 *
 * What is left here is policy: where the hand is, how far it reaches, how often to re-query, and
 * the numbers the look needs.
 */
import type { StructuredPaint } from '../lidar/structured';

export interface TouchTunables {
  /** How far the "hand" reaches, metres. */
  range: number;
  /** Brightness of a point right against you. */
  nearAlpha: number;
  /** Brightness a felt point keeps once you have walked away. */
  memoryAlpha: number;
  /** Re-query threshold: how far the hand may drift before the mask is written again. */
  rebuildStep: number;
}

export function defaultTouchTunables(): TouchTunables {
  return {
    range: 0.55,
    nearAlpha: 0.8,
    memoryAlpha: 0.07,
    rebuildStep: 0.08,
  };
}

export interface TouchStats {
  /** Mask points the last write newly reached. */
  near: number;
  /** Mask points felt since the last clear. */
  remembered: number;
  /** Contour pieces felt since the last clear. */
  segments: number;
  /** Writes into the mask so far. */
  rebuilds: number;
}

export class TouchLayer {
  readonly tunables: TouchTunables;

  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private lastZ = Number.NaN;
  private on = true;
  private dirty = true;
  private stats: TouchStats = { near: 0, remembered: 0, segments: 0, rebuilds: 0 };

  constructor(
    private readonly paint: StructuredPaint,
    tunables: TouchTunables = defaultTouchTunables(),
  ) {
    this.tunables = tunables;
  }

  get visible(): boolean {
    return this.on;
  }

  setVisible(value: boolean): void {
    this.on = value;
    this.paint.setTouchVisible(value);
  }

  getStats(): TouchStats {
    return this.stats;
  }

  /** Forgets the trail. The mask itself is cleared by the paint, which owns it. */
  clear(): void {
    this.lastX = Number.NaN;
    this.dirty = true;
    this.stats = { near: 0, remembered: 0, segments: 0, rebuilds: 0 };
  }

  /**
   * One tick of feeling around. `x/y/z` is the hand — the eye, in practice. The reach is a
   * sphere about it; everything inside it is revealed in the shared mask, and nothing outside.
   *
   * No occlusion test is run, and that is deliberate rather than sloppy: the player's own body
   * radius plus the thinnest partition in the hall is wider than the reach, so there is no pose
   * from which the hand could reach through a wall.
   */
  update(x: number, y: number, z: number): void {
    const t = this.tunables;
    this.paint.setHand(x, y, z);
    this.paint.setTouchLook(t.range, t.nearAlpha, t.memoryAlpha);

    const moved = Math.hypot(x - this.lastX, y - this.lastY, z - this.lastZ);
    if (!this.dirty && moved < t.rebuildStep) return;
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    this.dirty = false;

    // The write has to cover the reach plus the drift allowance, or a point would be felt a
    // re-query late and pop in behind the hand.
    const fresh = this.paint.revealTouch(x, y, z, t.range + t.rebuildStep);
    const s = this.paint.getStats();
    this.stats = {
      near: fresh,
      remembered: s.touchedDots,
      segments: s.touchedEdges,
      rebuilds: this.stats.rebuilds + 1,
    };
  }

  dispose(): void {
    /* Nothing owned. */
  }
}
