/**
 * Debug: where the hitscans actually went.
 *
 * The milestone's own rule — "феча приносит свой дебаг-инструмент" — and for a gun in the dark
 * this is the tool without which nothing can be checked. A bullet is instantaneous, invisible
 * and lands in unlit space; if it misses by a metre the frame looks exactly the same as if it
 * had hit. So the tool draws the two facts the shot has: the line the trace took, and a cross
 * at whatever it stopped against.
 *
 * It is emphatically NOT a game visual. Concept law 1 says nothing renders "just because", and
 * a permanent tracer line would be free vision down the barrel — the exact opposite of what the
 * game is about. It is off by default, bound to a key, and drawn on top of everything (no depth
 * test) so it can be read against a black screen.
 */
import * as THREE from 'three';
import type { Shot } from './rifle';

/** Line, then three cross arms at the impact: four segments, eight vertices per shot. */
const VERTS_PER_SHOT = 8;
const CROSS = 0.16;

export class ShotTracers {
  readonly object: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly capacity: number;
  private cursor = 0;
  private filled = 0;

  constructor(capacity = 64) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * VERTS_PER_SHOT * 3);
    this.colors = new Float32Array(capacity * VERTS_PER_SHOT * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.object = new THREE.LineSegments(
      this.geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.visible = false;
  }

  get visible(): boolean {
    return this.object.visible;
  }

  setVisible(on: boolean): void {
    this.object.visible = on;
  }

  get count(): number {
    return this.filled;
  }

  /** Records one trace. Cheap enough to call even while the overlay is hidden. */
  add(shot: Shot): void {
    const base = this.cursor * VERTS_PER_SHOT * 3;
    // Muzzle → impact. Cold at the muzzle, hot at the far end, so direction reads at a glance.
    this.put(base + 0, shot.ox, shot.oy, shot.oz, 0.15, 0.35, 0.5);
    this.put(base + 3, shot.ex, shot.ey, shot.ez, 0.35, 0.9, 1.0);
    // The cross. Green when it bit something, red when the round went into the dark: a miss at
    // 40 m and a hit at 40 m are otherwise the same picture.
    const r = shot.hit ? 0.3 : 1.0;
    const g = shot.hit ? 1.0 : 0.25;
    const b = shot.hit ? 0.4 : 0.2;
    const s = shot.hit ? CROSS : CROSS * 0.6;
    this.put(base + 6, shot.ex - s, shot.ey, shot.ez, r, g, b);
    this.put(base + 9, shot.ex + s, shot.ey, shot.ez, r, g, b);
    this.put(base + 12, shot.ex, shot.ey - s, shot.ez, r, g, b);
    this.put(base + 15, shot.ex, shot.ey + s, shot.ez, r, g, b);
    this.put(base + 18, shot.ex, shot.ey, shot.ez - s, r, g, b);
    this.put(base + 21, shot.ex, shot.ey, shot.ez + s, r, g, b);
    this.cursor = (this.cursor + 1) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + 1);
    this.geometry.setDrawRange(0, this.filled * VERTS_PER_SHOT);
    this.geometry.attributes.position!.needsUpdate = true;
    this.geometry.attributes.color!.needsUpdate = true;
  }

  private put(i: number, x: number, y: number, z: number, r: number, g: number, b: number): void {
    this.positions[i] = x;
    this.positions[i + 1] = y;
    this.positions[i + 2] = z;
    this.colors[i] = r;
    this.colors[i + 1] = g;
    this.colors[i + 2] = b;
  }

  clear(): void {
    this.cursor = 0;
    this.filled = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}
