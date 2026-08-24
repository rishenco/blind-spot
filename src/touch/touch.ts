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
 * `StructuredPaint`: every frame it asks the paint to mark the lattice dots and contour-piece
 * ends inside the reach column as touched (`revealTouch`), and the paint draws exactly those, grey,
 * bright under the hand and faint once you have moved on. A wall reacts because a wall has
 * lattice dots like everything else; a crate does not give itself away, because a dot two metres
 * up its far side was never within reach.
 *
 * What is left here is policy: where the hand is, how far it reaches, how often to re-query, and
 * the numbers the look needs.
 */
import type { StructuredPaint } from '../lidar/structured';

/**
 * A second mask the hand also writes into. The props are a separate buffer from the hall (they
 * move; the hall does not), but feeling around is one gesture and must not know the difference:
 * put your hand on a barrel and you feel the barrel, not "the dynamic layer".
 */
export interface TouchSink {
  setHand(x: number, y: number, z: number, span: number, range: number, near: number): void;
  setTouchVisible(on: boolean): void;
  revealTouch(x: number, y: number, z: number, span: number, radius: number): number;
}

export interface TouchTunables {
  /** How far the "hand" reaches, metres. */
  range: number;
  /**
   * How far *below* the eye the reach column starts, metres. The player feels with a body, not
   * with an eyeball: a sphere at eye height cannot reach a knee-high crate you are standing
   * against, which is exactly the thing you most want to identify by feel. The column runs from
   * `eye - drop` up to the eye, and the reach sphere is swept along it.
   */
  drop: number;
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
    drop: 1.5,
    nearAlpha: 1,
    memoryAlpha: 0.22,
    rebuildStep: 0.08,
  };
}

export interface TouchStats {
  /** Mask points the last write newly reached. */
  near: number;
  /** Mask points felt since the last clear. */
  remembered: number;
  /** Contour piece ends felt since the last clear. */
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
  private extra: TouchSink | null = null;

  constructor(
    private readonly paint: StructuredPaint,
    tunables: TouchTunables = defaultTouchTunables(),
  ) {
    this.tunables = tunables;
  }

  /** Adds the prop mask to what the hand can feel. Called once, after the props exist. */
  attach(sink: TouchSink): void {
    this.extra = sink;
    sink.setTouchVisible(this.on);
  }

  get visible(): boolean {
    return this.on;
  }

  setVisible(value: boolean): void {
    this.on = value;
    this.paint.setTouchVisible(value);
    this.extra?.setTouchVisible(value);
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
   * One tick of feeling around. `x/y/z` is the head — the eye, in practice. The reach is a
   * capsule: a vertical column from the shins to the eye, grown by `range`. Everything inside
   * it is revealed in the shared mask, and nothing outside.
   *
   * No occlusion test is run, and that is deliberate rather than sloppy: the player's own body
   * radius plus the thinnest partition in the hall is wider than the reach, so there is no pose
   * from which the hand could reach through a wall.
   */
  update(x: number, y: number, z: number): void {
    const t = this.tunables;
    // The column bottom never goes below the floor plane: feeling the ground you stand on is
    // honest, feeling through it is not.
    const foot = Math.max(0.02, y - t.drop);
    const span = Math.max(0, y - foot);
    this.paint.setHand(x, foot, z, span);
    this.paint.setTouchLook(t.range, t.nearAlpha, t.memoryAlpha);
    this.extra?.setHand(x, foot, z, span, t.range, t.nearAlpha);

    const moved = Math.hypot(x - this.lastX, y - this.lastY, z - this.lastZ);
    if (!this.dirty && moved < t.rebuildStep) return;
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    this.dirty = false;

    // The write has to cover the reach plus the drift allowance, or a point would be felt a
    // re-query late and pop in behind the hand.
    let fresh = this.paint.revealTouch(x, foot, z, span, t.range + t.rebuildStep);
    fresh += this.extra?.revealTouch(x, foot, z, span, t.range + t.rebuildStep) ?? 0;
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
