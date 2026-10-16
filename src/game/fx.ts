import * as THREE from 'three';

interface Puff {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
}

/** Dust puffs (pooled low-poly blobs that grow and fade) and camera shake. */
export class Fx {
  private pool: Puff[] = [];
  private geo = new THREE.IcosahedronGeometry(1, 0);
  shake = 0;

  constructor(private scene: THREE.Scene) {}

  dust(pos: THREE.Vector3, count: number, opts: { speed?: number; size?: number; up?: number; color?: number; life?: number } = {}): void {
    const { speed = 2, size = 0.35, up = 1, color = 0xd9cbb4, life = 0.8 } = opts;
    for (let i = 0; i < count; i++) {
      let p = this.pool.find((q) => q.life <= 0);
      if (!p) {
        const m = new THREE.Mesh(
          this.geo,
          new THREE.MeshStandardMaterial({ color, flatShading: true, transparent: true, roughness: 1, depthWrite: false }),
        );
        p = { mesh: m, vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 1 };
        this.pool.push(p);
        this.scene.add(m);
      }
      (p.mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      p.vel.set(Math.cos(a) * s, up * (0.3 + Math.random()), Math.sin(a) * s);
      p.mesh.position.copy(pos).addScaledVector(p.vel, 0.05);
      p.mesh.rotation.set(Math.random() * 6, Math.random() * 6, 0);
      p.life = p.maxLife = life * (0.7 + Math.random() * 0.6);
      p.size = size * (0.6 + Math.random() * 0.8);
      p.mesh.visible = true;
    }
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        continue;
      }
      const k = 1 - p.life / p.maxLife;
      p.vel.multiplyScalar(Math.exp(-3 * dt));
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.setScalar(p.size * (0.4 + k * 1.4));
      (p.mesh.material as THREE.MeshStandardMaterial).opacity = 0.85 * (1 - k);
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }

  /** Random camera offset for the current shake level. */
  shakeOffset(out: THREE.Vector3): THREE.Vector3 {
    const s = this.shake * this.shake * 0.6;
    return out.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
  }

  clear(): void {
    for (const p of this.pool) {
      p.life = 0;
      p.mesh.visible = false;
    }
    this.shake = 0;
  }
}
