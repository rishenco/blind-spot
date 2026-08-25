/**
 * What the dynamic lidar pass is allowed to know about a body.
 *
 * `DynamicPaint` used to take a `PropWorld` directly, which quietly said "only clutter is
 * matter". Spiders are matter too — concept: точки это материя — and the human asked for them to
 * be scanned «аналогично мелким объектам, тем же облаком точек, той же механикой». Rather than
 * bolting a spider renderer onto the lidar, the pass now takes this narrow interface, and the
 * props and the swarm are two sources joined by `BodyUnion`. Neither knows about the other, and
 * a third source (a door, a corpse pile) costs one more adapter.
 */
import type { EdgeSet, PointCloud } from '../props/shapes';

export interface PaintBodies {
  /** Fixed for the lifetime of the paint pass — the GPU buffers are sized from it once. */
  readonly count: number;
  /** World position, 3 floats per body. */
  readonly pos: Float32Array;
  /** World orientation, 4 floats per body (x,y,z,w). */
  readonly quat: Float32Array;
  /** 1 while the body is in motion: its revealed points fade instead of sticking. */
  readonly moving: Uint8Array;
  /** Scene time the body last came to rest. Points stamped after it become permanent. */
  readonly settleAt: Float32Array;
  cloudOf(i: number): PointCloud;
  edgesOf(i: number): EdgeSet;
  /** Optional: refresh the arrays above. Called once per frame, before anything reads them. */
  sync?(): void;
}

/**
 * Two body sources presented as one flat index space: `a` first, then `b`. The transform arrays
 * are copied rather than aliased — a few thousand floats a frame, against the alternative of
 * threading a per-source indirection through every hot loop in `dynamic.ts`.
 */
export class BodyUnion implements PaintBodies {
  readonly count: number;
  readonly pos: Float32Array;
  readonly quat: Float32Array;
  readonly moving: Uint8Array;
  readonly settleAt: Float32Array;
  private readonly split: number;

  constructor(
    private readonly a: PaintBodies,
    private readonly b: PaintBodies,
  ) {
    this.split = a.count;
    this.count = a.count + b.count;
    this.pos = new Float32Array(this.count * 3);
    this.quat = new Float32Array(this.count * 4);
    this.moving = new Uint8Array(this.count);
    this.settleAt = new Float32Array(this.count);
    this.sync();
  }

  sync(): void {
    this.a.sync?.();
    this.b.sync?.();
    this.pos.set(this.a.pos, 0);
    this.pos.set(this.b.pos, this.split * 3);
    this.quat.set(this.a.quat, 0);
    this.quat.set(this.b.quat, this.split * 4);
    this.moving.set(this.a.moving, 0);
    this.moving.set(this.b.moving, this.split);
    this.settleAt.set(this.a.settleAt, 0);
    this.settleAt.set(this.b.settleAt, this.split);
  }

  cloudOf(i: number): PointCloud {
    return i < this.split ? this.a.cloudOf(i) : this.b.cloudOf(i - this.split);
  }

  edgesOf(i: number): EdgeSet {
    return i < this.split ? this.a.edgesOf(i) : this.b.edgesOf(i - this.split);
  }

  /** Where source `b`'s bodies start in the joined index space. Debug/tooling. */
  get offset(): number {
    return this.split;
  }
}
