/**
 * The swarm, presented to the lidar as ordinary bodies.
 *
 * This adapter is the entire answer to «пауков должно быть можно сканить лидаром аналогично
 * мелким объектам»: one shared point cloud, one shared contour, and a transform per spider. The
 * lidar pass treats them exactly like clutter — same occlusion, same reveal, same age fade — and
 * has no idea they are alive.
 *
 * The capacity is fixed at construction because the paint pass sizes its GPU buffers once. It is
 * taken generously so a scenario can respawn a bigger pack without losing anyone from the scan.
 */
import type { PaintBodies } from '../lidar/bodies';
import type { EdgeSet, PointCloud } from '../props/shapes';
import { spiderCloud, spiderEdges } from './shape';
import type { Swarm } from './swarm';

export class SpiderBodies implements PaintBodies {
  readonly count: number;
  readonly pos: Float32Array;
  readonly quat: Float32Array;
  readonly moving: Uint8Array;
  readonly settleAt: Float32Array;
  private readonly cloud: PointCloud = spiderCloud();
  private readonly edges: EdgeSet = spiderEdges();

  constructor(
    private readonly swarm: Swarm,
    capacity = 48,
  ) {
    this.count = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.quat = new Float32Array(capacity * 4);
    this.moving = new Uint8Array(capacity);
    this.settleAt = new Float32Array(capacity);
    this.sync();
  }

  sync(): void {
    this.swarm.poseInto(this.pos, this.quat, this.moving, this.settleAt);
  }

  cloudOf(_i: number): PointCloud {
    return this.cloud;
  }

  edgesOf(_i: number): EdgeSet {
    return this.edges;
  }
}
