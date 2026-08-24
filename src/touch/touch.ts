/**
 * The tactile layer — "серый «тактильный» контур в ~0.5 м от игрока".
 *
 * This is the channel of last resort: it costs nothing, makes no noise, and tells you almost
 * nothing. You get the outline of whatever is within arm's reach, and one further thing that
 * turns out to matter a lot in the dark — the outline of whatever you have already *bumped into*
 * stays, faintly, forever. Feeling your way along a shelf leaves a thread behind you.
 *
 * Implementation notes that are design decisions, not details:
 *
 *  - Contours only, never fill. A silhouette at 0.5 m is what a hand tells you; a surface is not.
 *  - The falloff is computed per *fragment*, from the interpolated world position, so a long edge
 *    that merely passes near you lights only the part you could actually touch. Doing it per
 *    vertex would make a 60 m floor edge either wholly visible or wholly absent.
 *  - The buffer is rebuilt only when the player has moved far enough to change what is in reach,
 *    from a spatial query rather than from the whole world — this runs every frame and the world
 *    has thousands of boxes.
 *  - Touch memory is a bounded ring. It is a trail, not a second map; the lidar owns the map.
 */
import * as THREE from 'three';
import type { Aabb, StaticWorld } from '../core/collision';

export interface TouchTunables {
  /** How far the "hand" reaches, metres. */
  range: number;
  /** Brightness of the contour right against you. */
  nearAlpha: number;
  /**
   * Brightness of a whole object you are in contact with. Same rule as the lidar: feeling one
   * face of a crate tells you a crate is there, so the crate outlines; feeling one patch of a
   * wall tells you nothing about the wall, so shell boxes never get this and light only under
   * the hand.
   */
  contactAlpha: number;
  /** Brightness a remembered contour keeps once you have walked away. */
  memoryAlpha: number;
  /** How many boxes the touch memory holds before the oldest is forgotten. */
  memorySize: number;
  /** Rebuild threshold: how far the player may drift before the near set is re-queried. */
  rebuildStep: number;
}

export function defaultTouchTunables(): TouchTunables {
  return {
    range: 0.55,
    nearAlpha: 0.55,
    contactAlpha: 0.5,
    memoryAlpha: 0.07,
    memorySize: 220,
    rebuildStep: 0.2,
  };
}

const TOUCH_COLOR = new THREE.Color(0x9fa6ab);
/** Edges of a unit box as pairs of corner indices. */
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const VERT = /* glsl */ `
attribute float aMemory;
attribute float aContact;
varying vec3 vWorld;
varying float vMemory;
varying float vContact;
void main() {
  vWorld = position;
  vMemory = aMemory;
  vContact = aContact;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uPlayer;
uniform vec3 uColor;
uniform float uRange;
uniform float uNearAlpha;
uniform float uContactAlpha;
uniform float uMemoryAlpha;
varying vec3 vWorld;
varying float vMemory;
varying float vContact;
void main() {
  float d = length(vWorld - uPlayer);
  float prox = 1.0 - smoothstep(uRange * 0.45, uRange, d);
  float a = max(max(prox * uNearAlpha, vContact * uContactAlpha), vMemory * uMemoryAlpha);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`;

export interface TouchStats {
  /** Boxes currently within reach. */
  near: number;
  /** Boxes held in touch memory. */
  remembered: number;
  /** Line segments uploaded this rebuild. */
  segments: number;
  rebuilds: number;
}

export class TouchLayer {
  readonly tunables: TouchTunables;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly lines: THREE.LineSegments;
  private readonly position: THREE.BufferAttribute;
  private readonly memory: THREE.BufferAttribute;
  private readonly contact: THREE.BufferAttribute;
  private readonly capacity: number;

  /** Ring of remembered boxes, oldest first. */
  private readonly remembered: Aabb[] = [];
  private readonly rememberedSet = new Set<Aabb>();
  private readonly nearby: Aabb[] = [];
  private readonly lastQuery = new THREE.Vector3(Number.NaN, 0, 0);
  private dirty = true;

  private stats: TouchStats = { near: 0, remembered: 0, segments: 0, rebuilds: 0 };

  constructor(
    private readonly world: StaticWorld,
    tunables: TouchTunables = defaultTouchTunables(),
    capacityBoxes = 512,
  ) {
    this.tunables = tunables;
    this.capacity = capacityBoxes * EDGES.length * 2;
    this.position = new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.memory = new THREE.BufferAttribute(new Float32Array(this.capacity), 1);
    this.contact = new THREE.BufferAttribute(new Float32Array(this.capacity), 1);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.memory.setUsage(THREE.DynamicDrawUsage);
    this.contact.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('aMemory', this.memory);
    this.geometry.setAttribute('aContact', this.contact);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPlayer: { value: new THREE.Vector3() },
        uColor: { value: new THREE.Vector3(TOUCH_COLOR.r, TOUCH_COLOR.g, TOUCH_COLOR.b) },
        uRange: { value: tunables.range },
        uNearAlpha: { value: tunables.nearAlpha },
        uContactAlpha: { value: tunables.contactAlpha },
        uMemoryAlpha: { value: tunables.memoryAlpha },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
  }

  get object(): THREE.Object3D {
    return this.lines;
  }

  get visible(): boolean {
    return this.lines.visible;
  }

  setVisible(on: boolean): void {
    this.lines.visible = on;
  }

  getStats(): TouchStats {
    return this.stats;
  }

  clear(): void {
    this.remembered.length = 0;
    this.rememberedSet.clear();
    this.dirty = true;
  }

  /**
   * One tick of feeling around. `x/y/z` is the hand — the eye, in practice; the reach is a
   * sphere about it, and everything the sphere intersects is both drawn and remembered.
   */
  update(x: number, y: number, z: number): void {
    const t = this.tunables;
    const u = this.material.uniforms;
    (u.uPlayer!.value as THREE.Vector3).set(x, y, z);
    u.uRange!.value = t.range;
    u.uNearAlpha!.value = t.nearAlpha;
    u.uContactAlpha!.value = t.contactAlpha;
    u.uMemoryAlpha!.value = t.memoryAlpha;

    const moved = Math.hypot(x - this.lastQuery.x, y - this.lastQuery.y, z - this.lastQuery.z);
    if (!this.dirty && moved < t.rebuildStep) return;
    this.lastQuery.set(x, y, z);
    this.dirty = false;

    // A generous query box: the draw window has to cover the reach plus the drift allowance,
    // or a contour would pop in a rebuild late.
    const r = t.range + t.rebuildStep + 0.05;
    this.world.query(x - r, y - r, z - r, x + r, y + r, z + r, this.nearby);
    for (const box of this.nearby) this.remember(box);
    this.rebuild();
  }

  private remember(box: Aabb): void {
    if (this.rememberedSet.has(box)) return;
    this.rememberedSet.add(box);
    this.remembered.push(box);
    while (this.remembered.length > this.tunables.memorySize) {
      const dropped = this.remembered.shift();
      if (dropped !== undefined) this.rememberedSet.delete(dropped);
    }
  }

  private rebuild(): void {
    const pos = this.position.array as Float32Array;
    const mem = this.memory.array as Float32Array;
    const con = this.contact.array as Float32Array;
    let v = 0;
    const near = new Set(this.nearby);

    const push = (box: Aabb, memory: number, contact: number): void => {
      const cx = [box.minX, box.maxX];
      const cy = [box.minY, box.maxY];
      const cz = [box.minZ, box.maxZ];
      for (const [a, b] of EDGES) {
        if (v + 2 > this.capacity) return;
        for (const corner of [a, b]) {
          pos[v * 3] = cx[corner & 1]!;
          pos[v * 3 + 1] = cy[(corner >> 1) & 1]!;
          pos[v * 3 + 2] = cz[(corner >> 2) & 1]!;
          mem[v] = memory;
          con[v] = contact;
          v++;
        }
      }
    };

    // In reach: a prop outlines whole, a wall does not (see `contactAlpha`).
    for (const box of this.nearby) push(box, 1, box.shell === true ? 0 : 1);
    for (const box of this.remembered) {
      if (near.has(box)) continue;
      push(box, 1, 0);
    }

    this.position.addUpdateRange(0, v * 3);
    this.memory.addUpdateRange(0, v);
    this.contact.addUpdateRange(0, v);
    this.position.needsUpdate = true;
    this.memory.needsUpdate = true;
    this.contact.needsUpdate = true;
    this.geometry.setDrawRange(0, v);

    this.stats = {
      near: this.nearby.length,
      remembered: this.remembered.length,
      segments: v / 2,
      rebuilds: this.stats.rebuilds + 1,
    };
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
