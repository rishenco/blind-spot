import * as THREE from 'three';
import { edgeRadius } from '../models/world';

/** Signed distance from (x, z) to the plateau rim: positive inside, negative past the edge. */
export function edgeDistance(x: number, z: number): number {
  return edgeRadius(Math.atan2(z, x)) - Math.hypot(x, z);
}

/** Distance along a horizontal unit direction from (x, z) until the rim (marched; plateau is star-shaped). */
export function distanceToEdgeAlong(x: number, z: number, dx: number, dz: number): number {
  let d = 0;
  for (; d < 30; d += 0.25) {
    if (edgeDistance(x + dx * d, z + dz * d) < 0) return d;
  }
  return d;
}

/** Unit vector pointing from the plateau center outward through (x, z). */
export function outward(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const r = Math.hypot(x, z) || 1;
  return out.set(x / r, 0, z / r);
}
