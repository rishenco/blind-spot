/**
 * The lights-on view of the clutter — debug only, and only ever debug.
 *
 * Nothing in the dark game renders a prop as a surface: the concept's first law says unknown
 * space is black, and the lidar draws points. But `process.md` demands every keyframe exist in
 * two variants, "as the player sees it" and "as it really is", and the second one is worthless
 * if the hall is furnished with invisible objects. So this file builds the *truth* mesh: the
 * same primitive list the colliders and the point cloud come from, drawn as solid geometry, and
 * switched on by exactly the same L key that already lights the hall.
 *
 * One instanced mesh per (archetype, part), so the whole catalogue is ~40 draw calls in a view
 * that is not the game. In the dark — the only case whose frame budget matters — the group is
 * invisible and costs nothing.
 */
import * as THREE from 'three';

import { ARCHETYPES } from './shapes';
import type { PropWorld } from './props';

export class PropReveal {
  readonly object = new THREE.Group();
  private readonly meshes: Array<{ mesh: THREE.InstancedMesh; local: THREE.Matrix4 }> = [];
  /** Prop indices per archetype, so an instanced mesh knows which bodies it is drawing. */
  private readonly members: number[][];
  private readonly slot: Int32Array;

  constructor(private readonly props: PropWorld) {
    this.members = ARCHETYPES.map(() => [] as number[]);
    this.slot = new Int32Array(props.count);
    for (let i = 0; i < props.count; i++) {
      const a = props.arch[i]!;
      this.slot[i] = this.members[a]!.length;
      this.members[a]!.push(i);
    }

    for (let a = 0; a < ARCHETYPES.length; a++) {
      const n = this.members[a]!.length;
      if (n === 0) continue;
      const arch = ARCHETYPES[a]!;
      // Flat grey; a colour per archetype would be a material, which the concept does not have.
      const material = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
      for (const part of arch.parts) {
        let geo: THREE.BufferGeometry;
        const local = new THREE.Matrix4();
        if (part.kind === 'box') {
          geo = new THREE.BoxGeometry(part.hx * 2, part.hy * 2, part.hz * 2);
          local.makeTranslation(part.cx, part.cy, part.cz);
        } else if (part.kind === 'ball') {
          geo = new THREE.SphereGeometry(part.r, 10, 7);
          local.makeTranslation(0, part.cy, 0);
        } else {
          const r1 = part.r1 ?? part.r0;
          geo = new THREE.CylinderGeometry(r1, part.r0, Math.max(0.005, part.y1 - part.y0), 12, 1);
          local.makeTranslation(0, (part.y0 + part.y1) / 2, 0);
        }
        const mesh = new THREE.InstancedMesh(geo, material, n);
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.object.add(mesh);
        this.meshes.push({ mesh, local });
      }
    }
    this.object.visible = false;
    this.sync();
  }

  setVisible(on: boolean): void {
    this.object.visible = on;
  }

  /** Pushes the current body transforms into the instance matrices. Only called while visible. */
  sync(): void {
    const p = this.props;
    const m = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const t = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    let cursor = 0;
    for (let a = 0; a < ARCHETYPES.length; a++) {
      const list = this.members[a]!;
      if (list.length === 0) continue;
      const parts = ARCHETYPES[a]!.parts.length;
      for (let k = 0; k < parts; k++) {
        const entry = this.meshes[cursor + k]!;
        for (let s = 0; s < list.length; s++) {
          const i = list[s]!;
          t.set(p.pos[i * 3]!, p.pos[i * 3 + 1]!, p.pos[i * 3 + 2]!);
          q.set(p.quat[i * 4]!, p.quat[i * 4 + 1]!, p.quat[i * 4 + 2]!, p.quat[i * 4 + 3]!);
          world.compose(t, q, one);
          m.multiplyMatrices(world, entry.local);
          entry.mesh.setMatrixAt(s, m);
        }
        entry.mesh.instanceMatrix.needsUpdate = true;
      }
      cursor += parts;
    }
  }

  dispose(): void {
    for (const { mesh } of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
  }
}
