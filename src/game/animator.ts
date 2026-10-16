import * as THREE from 'three';
import type { ModelDef } from '../models/types';

/**
 * Plays a model's named poses and cross-fades between them: on a pose switch it snapshots every
 * animated node, applies the new pose, then blends from the snapshot for `blend` seconds.
 */
export class Animator {
  readonly root: THREE.Object3D;
  pose = '';
  time = 0;
  private nodes: THREE.Object3D[] = [];
  private fromQ: THREE.Quaternion[] = [];
  private fromP: THREE.Vector3[] = [];
  private fromS: THREE.Vector3[] = [];
  private blendLeft = 0;
  private blendTotal = 0;

  constructor(
    private def: ModelDef,
    initialPose: string,
  ) {
    this.root = def.build();
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
      if (o !== this.root) this.nodes.push(o);
    });
    for (const _ of this.nodes) {
      this.fromQ.push(new THREE.Quaternion());
      this.fromP.push(new THREE.Vector3());
      this.fromS.push(new THREE.Vector3());
    }
    this.play(initialPose, 0);
  }

  /** Switch pose (no-op if already playing it, unless restart). */
  play(pose: string, blend = 0.12, restart = false): void {
    if (pose === this.pose && !restart) return;
    if (blend > 0) {
      this.nodes.forEach((n, i) => {
        this.fromQ[i].copy(n.quaternion);
        this.fromP[i].copy(n.position);
        this.fromS[i].copy(n.scale);
      });
    }
    this.pose = pose;
    this.time = 0;
    this.blendLeft = this.blendTotal = blend;
  }

  update(dt: number): void {
    this.time += dt;
    this.def.poses[this.pose]?.(this.root, this.time);
    if (this.blendLeft > 0) {
      this.blendLeft = Math.max(0, this.blendLeft - dt);
      const k = this.blendLeft / this.blendTotal; // 1 = all snapshot, 0 = all new pose
      this.nodes.forEach((n, i) => {
        n.quaternion.slerp(this.fromQ[i], k);
        n.position.lerp(this.fromP[i], k);
        n.scale.lerp(this.fromS[i], k);
      });
    }
  }
}
