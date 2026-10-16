import * as THREE from 'three';

/**
 * Cheap procedural ragdoll for the fall: the body itself is a tumbling rigid body (handled by the
 * fall director); this flops the limbs. Each joint gets an angular offset on top of the pose it had
 * when the ragdoll took over, driven by a soft damped spring, random kicks on every impact and a bit
 * of wind flutter.
 */
export interface JointSpec {
  name: string;
  /** Max offset (rad) per axis; 0 = axis locked. */
  x?: number;
  y?: number;
  z?: number;
  /** Rest offset the limb drifts to while limp (rad). */
  bias?: [number, number, number];
}

interface Joint {
  o: THREE.Object3D;
  base: THREE.Euler;
  amp: THREE.Vector3;
  bias: THREE.Vector3;
  off: THREE.Vector3;
  vel: THREE.Vector3;
}

const STIFF = 38;
const DAMP = 4.5;

export class Ragdoll {
  private joints: Joint[] = [];
  active = false;

  constructor(root: THREE.Object3D, specs: JointSpec[]) {
    for (const s of specs) {
      const o = root.getObjectByName(s.name);
      if (!o) continue;
      this.joints.push({
        o,
        base: new THREE.Euler(),
        amp: new THREE.Vector3(s.x ?? 0, s.y ?? 0, s.z ?? 0),
        bias: new THREE.Vector3(...(s.bias ?? [0, 0, 0])),
        off: new THREE.Vector3(),
        vel: new THREE.Vector3(),
      });
    }
  }

  /** Take over from the animator, keeping the current pose as the base. */
  begin(): void {
    this.active = true;
    for (const j of this.joints) {
      j.base.copy(j.o.rotation);
      j.off.set(0, 0, 0);
      j.vel.set(0, 0, 0);
    }
  }

  stop(): void {
    this.active = false;
  }

  /** Random limb kicks, strength ~0..1. */
  impulse(strength: number): void {
    const s = 9 + 16 * Math.min(1, strength);
    for (const j of this.joints) {
      j.vel.x += (Math.random() * 2 - 1) * s * Math.sign(j.amp.x);
      j.vel.y += (Math.random() * 2 - 1) * s * Math.sign(j.amp.y);
      j.vel.z += (Math.random() * 2 - 1) * s * Math.sign(j.amp.z);
    }
  }

  update(dt: number, flutter = 0): void {
    if (!this.active || dt <= 0) return;
    for (const j of this.joints) {
      for (const ax of ['x', 'y', 'z'] as const) {
        const amp = j.amp[ax];
        if (!amp) continue;
        const target = j.bias[ax];
        let v = j.vel[ax];
        let o = j.off[ax];
        v += (-STIFF * (o - target) - DAMP * v + (Math.random() * 2 - 1) * flutter * 60) * dt;
        o += v * dt;
        // Soft joint limits: bounce back off the stop.
        if (o > amp) {
          o = amp;
          v = -Math.abs(v) * 0.4;
        } else if (o < -amp) {
          o = -amp;
          v = Math.abs(v) * 0.4;
        }
        j.vel[ax] = v;
        j.off[ax] = o;
      }
      j.o.rotation.set(j.base.x + j.off.x, j.base.y + j.off.y, j.base.z + j.off.z);
    }
  }
}

export const PLAYER_JOINTS: JointSpec[] = [
  { name: 'armL', x: 1.6, z: 1.2, bias: [-0.4, 0, 0.5] },
  { name: 'armR', x: 1.6, z: 1.2, bias: [-0.4, 0, -0.5] },
  { name: 'forearmL', x: 1.3, bias: [-0.5, 0, 0] },
  { name: 'forearmR', x: 1.3, bias: [-0.5, 0, 0] },
  { name: 'legL', x: 1.2, z: 0.6, bias: [-0.3, 0, 0.2] },
  { name: 'legR', x: 1.2, z: 0.6, bias: [-0.3, 0, -0.2] },
  { name: 'shinL', x: 1.1, bias: [0.6, 0, 0] },
  { name: 'shinR', x: 1.1, bias: [0.6, 0, 0] },
  { name: 'torso', x: 0.45, y: 0.4, z: 0.3 },
  { name: 'head', x: 0.7, y: 0.6, z: 0.5 },
  { name: 'bandTail', x: 1.2 },
];

export const RAM_JOINTS: JointSpec[] = [
  { name: 'legFL', x: 1.3, z: 0.7 },
  { name: 'legFR', x: 1.3, z: 0.7 },
  { name: 'legBL', x: 1.3, z: 0.7 },
  { name: 'legBR', x: 1.3, z: 0.7 },
  { name: 'legFL_low', x: 1.0, bias: [0.4, 0, 0] },
  { name: 'legFR_low', x: 1.0, bias: [0.4, 0, 0] },
  { name: 'legBL_low', x: 1.0, bias: [-0.4, 0, 0] },
  { name: 'legBR_low', x: 1.0, bias: [-0.4, 0, 0] },
  { name: 'neck', x: 0.8, y: 0.6 },
  { name: 'head', x: 0.5, z: 0.5 },
  { name: 'jaw', x: 0.4, bias: [0.15, 0, 0] },
  { name: 'tail', x: 1.2, y: 0.6 },
];
