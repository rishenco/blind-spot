/**
 * What the thing in your left hand looks like.
 *
 * The spec's line is short and it is a law about channels, not about polish: «предмет в левой
 * руке рисуется тем же языком касания, что и винтовка (контур), — он у тебя в руках, ты его
 * щупаешь». Without this file a carried can was drawn by the props' own tactile channel, which
 * answers a different question: it stipples the handful of cloud points that happen to fall
 * inside the reach sphere, so a tin in your fist read as four or five grey specks drifting in
 * front of the camera — indistinguishable from a shelf you brushed past, and not recognisably
 * an object at all.
 *
 * So the held prop is drawn the way the rifle is drawn, by the same rules and the same shader:
 *
 *  - a grey contour (`TOUCH_GREY`) along the creases of its own primitives, in `EDGE_FRAG`,
 *    which has no lighting model in it whatsoever — a felt thing is not a lit thing;
 *  - a colour-less depth copy in front of it, so the far side of a bucket does not show through
 *    the near side and the silhouette stays a silhouette;
 *  - visible only while the tactile channel is on, at the tactile channel's own near-hand alpha.
 *    Nothing renders just because (law 1); the hand is what is making this visible.
 *
 * It draws in **world space**, not in camera space like the viewmodel. The held body really is a
 * body in the hall — kinematic, on its leash, about to be thrown — and drawing it where it
 * actually is means the contour and the point cloud and the collider can never drift apart, and
 * the frame in which it leaves the hand needs no handover at all: the object simply stops being
 * held, and the next tick draws nothing.
 *
 * Geometry is built lazily, once per archetype ever picked up, and cached. Picking up your
 * fifteenth can costs nothing.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { TOUCH_GREY } from '../lidar/structured';
import { ARCHETYPES } from '../props/shapes';
import type { TouchSink } from '../touch/touch';

/** The slice of the prop world this view reads. `PropWorld` satisfies it. */
export interface HeldViewWorld {
  readonly arch: Int32Array;
  readonly pos: Float32Array;
  readonly quat: Float32Array;
}

const EDGE_VERT = `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const EDGE_FRAG = `
uniform vec3 uColor;
uniform float uBright;
void main() {
  gl_FragColor = vec4(uColor * uBright, 1.0);
}`;

export interface HeldViewTunables {
  /**
   * Contour brightness as a multiple of the touch layer's near-hand alpha. The rifle's own
   * edges land at `feel * feelEdge * 0.34` ≈ 0.8; a can is smaller and further from the eye
   * than the receiver is, so it gets a touch more to read at the same weight.
   */
  bright: number;
  /** Master switch, for measuring what the contour costs. */
  visible: boolean;
}

export function defaultHeldViewTunables(): HeldViewTunables {
  return { bright: 1.0, visible: true };
}

/** Solid geometry for one archetype, in its own local frame — same primitives as everything else. */
function buildArchGeometry(archIndex: number): THREE.BufferGeometry {
  const arch = ARCHETYPES[archIndex]!;
  const parts: THREE.BufferGeometry[] = [];
  for (const part of arch.parts) {
    let g: THREE.BufferGeometry;
    if (part.kind === 'box') {
      g = new THREE.BoxGeometry(part.hx * 2, part.hy * 2, part.hz * 2);
      g.translate(part.cx, part.cy, part.cz);
    } else if (part.kind === 'ball') {
      g = new THREE.SphereGeometry(part.r, 12, 8);
      g.translate(0, part.cy, 0);
    } else {
      const r1 = part.r1 ?? part.r0;
      // Eight sides, not the reveal mesh's twelve. A contour has no view-dependent silhouette:
      // it draws the creases the model actually has, so a tube's roundness has to come from the
      // creases themselves. Eight gives 45-degree seams — well clear of the edge threshold, so
      // the few of them facing the eye draw and the tin reads as a closed, faceted body instead
      // of two floating ellipses.
      g = new THREE.CylinderGeometry(r1, part.r0, Math.max(0.005, part.y1 - part.y0), 8, 1);
      g.translate(0, (part.y0 + part.y1) / 2, 0);
    }
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) throw new Error(`held view: merge failed for ${arch.name}`);
  return merged;
}

export class HeldView implements TouchSink {
  readonly tunables: HeldViewTunables;
  readonly object = new THREE.Group();

  private readonly contour: THREE.LineSegments;
  private readonly occluder: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  /** Per-archetype geometry, built on first use. Index -> { solid, edges }. */
  private readonly cache = new Map<number, { solid: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
  private shown = -1;
  private feltOn = false;
  private feltAlpha = 0;

  constructor(private readonly world: HeldViewWorld, tunables: HeldViewTunables = defaultHeldViewTunables()) {
    this.tunables = tunables;
    this.material = new THREE.ShaderMaterial({
      vertexShader: EDGE_VERT,
      fragmentShader: EDGE_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(TOUCH_GREY) },
        uBright: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const empty = new THREE.BufferGeometry();
    this.contour = new THREE.LineSegments(empty, this.material);
    this.contour.frustumCulled = false;
    this.occluder = new THREE.Mesh(empty, new THREE.MeshBasicMaterial({
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 2,
    }));
    this.occluder.frustumCulled = false;
    this.occluder.renderOrder = -1;
    this.object.add(this.occluder, this.contour);
    this.object.visible = false;
  }

  /** Which prop the contour is currently drawing, or -1. The keyframe generator asserts on it. */
  get drawing(): number {
    return this.object.visible ? this.shown : -1;
  }

  // --- TouchSink ------------------------------------------------------------
  // Same three questions the rifle is asked, same two answers: the hand's state drives the
  // brightness, and nothing is ever *discovered* here — you know what you picked up.

  setTouchVisible(on: boolean): void {
    this.feltOn = on;
  }

  setHand(_x: number, _y: number, _z: number, _span: number, _range: number, near: number): void {
    this.feltAlpha = near;
  }

  revealTouch(): number {
    return 0;
  }

  private geometryFor(archIndex: number): { solid: THREE.BufferGeometry; edges: THREE.BufferGeometry } {
    const hit = this.cache.get(archIndex);
    if (hit !== undefined) return hit;
    const solid = buildArchGeometry(archIndex);
    // 25 degrees, exactly as the rifle: every crease of a box and the rim of every cylinder.
    const edges = new THREE.EdgesGeometry(solid, 25);
    const made = { solid, edges };
    this.cache.set(archIndex, made);
    return made;
  }

  /**
   * One frame. `held` is the prop index in hand or -1; `inView` is false in the top and free
   * cameras, where a contour hanging in mid-air would be a prop and not a pair of hands.
   */
  update(held: number, inView: boolean): void {
    const on = held >= 0 && inView && this.feltOn && this.tunables.visible && this.feltAlpha > 0;
    this.object.visible = on;
    if (!on) return;
    if (held !== this.shown) {
      const geo = this.geometryFor(this.world.arch[held]!);
      this.contour.geometry = geo.edges;
      this.occluder.geometry = geo.solid;
      this.shown = held;
    }
    this.object.position.set(this.world.pos[held * 3]!, this.world.pos[held * 3 + 1]!, this.world.pos[held * 3 + 2]!);
    this.object.quaternion.set(
      this.world.quat[held * 4]!, this.world.quat[held * 4 + 1]!,
      this.world.quat[held * 4 + 2]!, this.world.quat[held * 4 + 3]!,
    );
    this.material.uniforms.uBright!.value = this.feltAlpha * this.tunables.bright;
  }

  dispose(): void {
    for (const { solid, edges } of this.cache.values()) {
      solid.dispose();
      edges.dispose();
    }
    this.cache.clear();
    this.material.dispose();
    (this.occluder.material as THREE.Material).dispose();
  }
}
