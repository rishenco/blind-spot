import type * as THREE from 'three';

/**
 * Every model module default-exports a ModelDef.
 * - build(): returns the root Object3D. Parts that animate must be named children (pivot groups).
 * - poses: named pose/animation functions. t = seconds since the pose started (loop if cyclic).
 *   Each pose fully sets every animated part it uses, so switching poses never leaves leftovers.
 */
export interface ModelDef {
  name: string;
  build(): THREE.Object3D;
  poses: Record<string, (root: THREE.Object3D, t: number) => void>;
  /** Suggested viewer camera distance. */
  viewDistance?: number;
}
