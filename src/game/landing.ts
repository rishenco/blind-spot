import * as THREE from 'three';
import { valleyHeight } from '../models/world';

const CELL = 8;
const HALF = 1000;
const N = Math.ceil((HALF * 2) / CELL);

/**
 * Coarse height map of everything that sticks up out of the valley floor (the peak, the foothill /
 * mountain rings, trees), built once from the scene. Lets the fall pick a clean landing meadow and a
 * clear camera spot without raycasting heavy meshes mid-fall.
 */
export class ObstacleMap {
  private readonly top = new Float32Array(N * N).fill(-Infinity);

  static of(scene: THREE.Object3D): ObstacleMap {
    let m = scene.userData.obstacleMap as ObstacleMap | undefined;
    if (!m) {
      m = new ObstacleMap(scene);
      scene.userData.obstacleMap = m;
    }
    return m;
  }

  private constructor(scene: THREE.Object3D) {
    scene.updateMatrixWorld(true);
    for (const name of ['mountain', 'mountains']) {
      const mesh = scene.getObjectByName(name) as THREE.Mesh | undefined;
      if (mesh?.geometry) this.addMesh(mesh);
    }
    const trees = scene.getObjectByName('trees');
    trees?.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) this.addInstances(o as THREE.InstancedMesh);
    });
  }

  private cell(v: number): number {
    return Math.floor((v + HALF) / CELL);
  }

  private raise(x0: number, x1: number, z0: number, z1: number, y: number): void {
    const i0 = Math.max(0, this.cell(x0)), i1 = Math.min(N - 1, this.cell(x1));
    const j0 = Math.max(0, this.cell(z0)), j1 = Math.min(N - 1, this.cell(z1));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        if (y > this.top[k]) this.top[k] = y;
      }
    }
  }

  private addMesh(mesh: THREE.Mesh): void {
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const count = idx ? idx.count : pos.count;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const m = mesh.matrixWorld;
    for (let t = 0; t < count; t += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(t) : t).applyMatrix4(m);
      b.fromBufferAttribute(pos, idx ? idx.getX(t + 1) : t + 1).applyMatrix4(m);
      c.fromBufferAttribute(pos, idx ? idx.getX(t + 2) : t + 2).applyMatrix4(m);
      const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x);
      const z0 = Math.min(a.z, b.z, c.z), z1 = Math.max(a.z, b.z, c.z);
      if (x1 < -HALF || x0 > HALF || z1 < -HALF || z0 > HALF) continue;
      // Sample the triangle densely (big slanted faces would otherwise claim their whole bbox).
      const n = Math.min(80, Math.ceil(Math.max(x1 - x0, z1 - z0) / (CELL / 2)) + 1);
      for (let u = 0; u <= n; u++) {
        for (let v = 0; v <= n - u; v++) {
          const wu = u / n, wv = v / n, ww = 1 - wu - wv;
          const x = a.x * ww + b.x * wu + c.x * wv;
          const z = a.z * ww + b.z * wu + c.z * wv;
          const y = a.y * ww + b.y * wu + c.y * wv;
          const i = this.cell(x), j = this.cell(z);
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const k = j * N + i;
          if (y > this.top[k]) this.top[k] = y;
        }
      }
    }
  }

  private addInstances(im: THREE.InstancedMesh): void {
    im.geometry.computeBoundingBox();
    const bb = im.geometry.boundingBox!;
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const rXZ = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.z), Math.abs(bb.max.z));
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      m.premultiply(im.matrixWorld).decompose(p, q, s);
      const r = rXZ * Math.max(s.x, s.z) + 1;
      this.raise(p.x - r, p.x + r, p.z - r, p.z + r, p.y + bb.max.y * s.y);
    }
  }

  /** Height of the highest thing at (x, z): obstacle or valley floor. */
  height(x: number, z: number): number {
    const i = this.cell(x), j = this.cell(z);
    const o = i >= 0 && j >= 0 && i < N && j < N ? this.top[j * N + i] : -Infinity;
    return Math.max(o, valleyHeight(x, z));
  }

  /** Open, flat valley floor (no rock, foothill or tree) within `pad` meters of (x, z). */
  isMeadow(x: number, z: number, pad = 8): boolean {
    const g = valleyHeight(x, z);
    for (let dz = -pad; dz <= pad; dz += CELL / 2) {
      for (let dx = -pad; dx <= pad; dx += CELL / 2) {
        if (this.height(x + dx, z + dz) > g + 0.6) return false;
      }
    }
    return true;
  }

  /** Distance along a → b (meters) that is clear of everything (b's distance if fully clear). */
  clearDistance(a: THREE.Vector3, b: THREE.Vector3): number {
    const d = a.distanceTo(b);
    const p = new THREE.Vector3();
    for (let s = 1; s <= d; s += 1.5) {
      p.lerpVectors(a, b, s / d);
      if (p.y < this.height(p.x, p.z) + 0.5) return s;
    }
    return d;
  }
}
