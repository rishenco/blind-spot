/**
 * PHOSPHOR — the hands rig (visual-brief §1.6, doc/looks/phosphor.md "Hands, halo, HUD").
 *
 * "Dark forearms with #BFFFE9 outlines." That is not a stylistic flourish, it is the only way a
 * limb can be present in this world without breaking it: the world is a sparse lattice of grains
 * over absolute black, so a lit solid arm would be the brightest and densest object on screen by an
 * order of magnitude, and visual-brief §1.6 asks for FAINT machine hands. A dark body reads as an
 * occluder — you see it because the lattice stops behind it — and the phosphor-edge outline is what
 * tells you it is your own rig and not a hole in the world.
 *
 * Core owns the POSE: four bones in camera space, plus a smoothed `visibility` so releasing a
 * ladder withdraws the rig instead of deleting it mid-frame (looks/types.ts). This file owns only
 * what a hand is made of.
 */

import {
  BoxGeometry,
  BufferAttribute,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import type { BufferGeometry, PerspectiveCamera } from 'three';
import type { HandsView, RigArmView } from '../types.js';
import {
  FOREARM_EDGE_FADE_FROM,
  FOREARM_TAPER,
  FOREARM_THICK,
  HANDS_EDGE_ALPHA,
  HANDS_FILL,
  HANDS_FILL_ALPHA,
  HAND_LENGTH,
  HAND_THICK,
  PALETTE,
} from './params.js';

const rgb = (c: readonly [number, number, number]): number =>
  (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);

/**
 * How many pieces the forearm's long edges are cut into.
 *
 * Not detail — a straight edge needs none — but SAMPLES for the fade below. A vertex colour is
 * interpolated linearly between the two ends of a line segment, so on an undivided box the fade's
 * shape is discarded and only its endpoints survive: a curve that should have been gone by the
 * midpoint arrives there at three-quarters brightness. Twelve is enough to draw the curve and costs
 * 88 extra line segments in the only frames the rig is on screen at all.
 */
const FOREARM_SEGMENTS = 12;

/**
 * A box whose cross-section is scaled by `endScale` at its +z end — +z is elbow → wrist
 * (core/player.ts derives the bone's orientation from `hand − elbow`), so this tapers toward the
 * hand. A linear taper leaves every face planar, so the outline is still the box's twelve edges;
 * subdividing along z cuts the four long ones into pieces without adding any.
 */
const taperedBox = (thick: number, length: number, endScale: number, segments = 1): BoxGeometry => {
  const g = new BoxGeometry(thick, thick, length, 1, 1, segments);
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const t = p.getZ(i) / length + 0.5; // 0 at the elbow end, 1 at the wrist end
    const s = 1 + (endScale - 1) * t;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s, p.getZ(i));
  }
  p.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
};

/**
 * Bake the outline's brightness into the geometry as vertex colours: nothing before `from` along the
 * bone (0 = elbow, 1 = wrist), smoothstepping to full by the wrist. Baked rather than shaded because
 * it never changes — the fade belongs to the limb's shape, not to the frame — and a vertex attribute
 * costs nothing per frame.
 *
 * The stored value is the WANTED brightness raised to 2.2. Vertex colours are linear and the frame
 * is written out in sRGB, so a stored 0.05 arrives on screen at about 0.25 — a fade specified
 * straight would be three-quarters undone by the transfer curve, which is exactly how this limb
 * stayed a bright pole the first time.
 *
 * `from >= 1` means a flat, full-strength outline; every outline in the rig carries the attribute
 * even where it is flat, because they share one material and `vertexColors` reads it from all of
 * them.
 */
const shadeEdges = (edges: BufferGeometry, from: number, length: number): void => {
  const p = edges.attributes.position!;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, p.getZ(i) / length + 0.5));
    const u = from >= 1 ? 1 : Math.min(1, Math.max(0, (t - from) / (1 - from)));
    const k = (u * u * (3 - 2 * u)) ** 2.2;
    col[i * 3] = k;
    col[i * 3 + 1] = k;
    col[i * 3 + 2] = k;
  }
  edges.setAttribute('color', new BufferAttribute(col, 3));
};

/** One bone: a dark prism and its outline, posed together. */
interface Bone {
  readonly group: Group;
}

export class PhosphorHands {
  readonly group = new Group();

  private readonly forearmBox: BoxGeometry;
  private readonly handBox: BoxGeometry;
  private readonly forearmEdges: BufferGeometry;
  private readonly handEdges: BufferGeometry;
  private readonly fillMat: MeshBasicMaterial;
  private readonly edgeMat: LineBasicMaterial;
  /** [leftForearm, leftHand, rightForearm, rightHand]. */
  private readonly bones: Bone[];

  constructor() {
    // A bone's long axis is its local +z (core/player.ts RigBone), so both prisms are built along
    // +z: the forearm is a unit-length tapered box scaled to the bone, the hand a fixed stub pushed
    // forward off the wrist rather than straddling it.
    this.forearmBox = taperedBox(FOREARM_THICK, 1, FOREARM_TAPER, FOREARM_SEGMENTS);
    this.handBox = new BoxGeometry(HAND_THICK, HAND_THICK * 0.62, HAND_LENGTH);
    this.handBox.translate(0, 0, HAND_LENGTH * 0.5);
    this.forearmEdges = new EdgesGeometry(this.forearmBox);
    this.handEdges = new EdgesGeometry(this.handBox);
    // The forearm's outline dies away toward the elbow; the hand's is flat and full strength — it is
    // the end of the limb the player is actually reading.
    shadeEdges(this.forearmEdges, FOREARM_EDGE_FADE_FROM, 1);
    shadeEdges(this.handEdges, 1, HAND_LENGTH);

    // Nearly void, and it WRITES DEPTH: the rig is an occluder, which is the whole read. The
    // outline is the only lit part, and it is the palette's edge tone — the same one a hold uses,
    // because a hand on a rung and the rung it is on belong to the same language.
    this.fillMat = new MeshBasicMaterial({
      color: rgb(HANDS_FILL),
      transparent: true,
      opacity: 0,
      depthWrite: true,
    });
    this.edgeMat = new LineBasicMaterial({
      color: rgb(PALETTE.edgeHot),
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });

    const bone = (box: BoxGeometry, edges: BufferGeometry): Bone => {
      const g = new Group();
      const mesh = new Mesh(box, this.fillMat);
      const line = new LineSegments(edges, this.edgeMat);
      mesh.frustumCulled = false;
      line.frustumCulled = false;
      // Drawn after the world: the rig is in front of everything, always.
      mesh.renderOrder = 8;
      line.renderOrder = 9;
      g.add(mesh, line);
      this.group.add(g);
      return { group: g };
    };
    this.bones = [
      bone(this.forearmBox, this.forearmEdges),
      bone(this.handBox, this.handEdges),
      bone(this.forearmBox, this.forearmEdges),
      bone(this.handBox, this.handEdges),
    ];

    // The group's transform IS the camera's, so camera-space bones can be written into it
    // unchanged — no per-frame world-space conversion, and the rig cannot drift from the eye it
    // hangs off.
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;
    this.group.visible = false;
  }

  update(hands: HandsView, camera: PerspectiveCamera): void {
    const vis = hands.visibility;
    this.group.visible = vis > 0.01;
    if (!this.group.visible) return;

    camera.updateMatrixWorld();
    this.group.matrix.copy(camera.matrixWorld);
    this.group.matrixWorldNeedsUpdate = true;

    this.poseArm(hands.left, 0);
    this.poseArm(hands.right, 2);
    this.fillMat.opacity = HANDS_FILL_ALPHA * vis;
    this.edgeMat.opacity = HANDS_EDGE_ALPHA * vis;
  }

  /**
   * The forearm's LENGTH is recovered rather than given: core puts the forearm bone at the
   * elbow-wrist midpoint and the hand bone at the wrist, so the half-length is the distance between
   * them. This keeps the two definitions of "how long is this arm" from being able to disagree.
   */
  private poseArm(a: RigArmView, base: number): void {
    const forearm = this.bones[base]!.group;
    const hand = this.bones[base + 1]!.group;
    const half = Math.hypot(
      a.hand.pos[0] - a.forearm.pos[0],
      a.hand.pos[1] - a.forearm.pos[1],
      a.hand.pos[2] - a.forearm.pos[2],
    );
    forearm.position.set(a.forearm.pos[0], a.forearm.pos[1], a.forearm.pos[2]);
    forearm.rotation.set(a.forearm.rot[0], a.forearm.rot[1], a.forearm.rot[2], 'YXZ');
    forearm.scale.set(1, 1, Math.max(0.02, half * 2));
    hand.position.set(a.hand.pos[0], a.hand.pos[1], a.hand.pos[2]);
    hand.rotation.set(a.hand.rot[0], a.hand.rot[1], a.hand.rot[2], 'YXZ');
  }

  dispose(): void {
    this.group.clear();
    for (const b of this.bones) b.group.clear();
    this.forearmBox.dispose();
    this.handBox.dispose();
    this.forearmEdges.dispose();
    this.handEdges.dispose();
    this.fillMat.dispose();
    this.edgeMat.dispose();
  }
}
