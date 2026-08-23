/**
 * BLUEPRINT — the hands. Pure line-work.
 *
 * "Hands: pure line-work — wireframe robot hands, no fill, `#DFF3FF`, with one dimension tick at
 * the grip point during mantles." (doc/looks/blueprint.md)
 *
 * Every other school can afford a filled hand because it has a material language to make one
 * faint. This one does not: a solid prism at 0.3 m from the eye is the single loudest object the
 * frame will ever contain (see the debug look's note on why a rig is tiny in metres), and a filled
 * anything would break the school's own order — holds > edges > dots, with no fourth tier for a
 * body part. So the rig is exactly what the world is at its brightest: edges.
 *
 * Core owns the POSE (looks/types.ts): four bones in CAMERA space, long axis local +z, Euler
 * 'YXZ', plus a `visibility` fade. This file owns nothing but what a hand is made of.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import type { HandsView, RigArmView } from '../types.js';
import {
  FOREARM_ALPHA,
  FOREARM_THICK,
  GRIP_TICK_LEN,
  HAND_ALPHA,
  HAND_LENGTH,
  HAND_THICK,
  UI_INK,
} from './params.js';

/** The tick's end serifs, as a fraction of its half-length. */
const SERIF = 0.34;

/**
 * A draftsman's dimension terminator, in the hand bone's local space: one span with a serif across
 * each end. It is drawn across the grip's WIDTH (local x), because what a mantle is measuring is
 * the ledge — the one dimension the player is about to commit their whole body to.
 */
function tickGeometry(): BufferGeometry {
  const L = GRIP_TICK_LEN;
  const s = L * SERIF;
  const v = new Float32Array([
    // the span
    -L, 0, 0, L, 0, 0,
    // serif, near end
    -L, -s, 0, -L, s, 0,
    // serif, far end
    L, -s, 0, L, s, 0,
  ]);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(v, 3));
  return g;
}

/** Edges of a box, with the box itself thrown away — `EdgesGeometry` keeps its own positions. */
function boxEdges(w: number, h: number, d: number, shiftZ = 0): BufferGeometry {
  const box = new BoxGeometry(w, h, d);
  if (shiftZ !== 0) box.translate(0, 0, shiftZ);
  const edges = new EdgesGeometry(box);
  box.dispose();
  return edges;
}

export class HandsRig {
  /** The group's transform IS the camera's, so camera-space bones can be written in unchanged. */
  private readonly group = new Group();
  private readonly geoms: BufferGeometry[] = [];
  private readonly forearmMat: LineBasicMaterial;
  private readonly handMat: LineBasicMaterial;
  private readonly tickMat: LineBasicMaterial;
  /** [left forearm, left hand, right forearm, right hand]. */
  private readonly bones: LineSegments[] = [];
  private readonly tick: LineSegments;

  constructor(scene: Scene) {
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;

    // The rig is the one thing in the frame that is never depth-tested: it is bolted to the eye,
    // and an unpainted wall must not be able to swallow it — in this world absence is black, not
    // opaque, so there is nothing in front of the hands to be behind (vision §1.3).
    // `set(css)` and not `setRGB`: a built-in material runs three's colour management, which reads
    // a CSS/hex value as sRGB and hands back exactly it — the custom shaders elsewhere in this look
    // write their palette raw, and this is how the rig ends up the same ink as the edges it draws.
    const mat = (): LineBasicMaterial => {
      const m = new LineBasicMaterial({
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      });
      m.color.set(UI_INK);
      return m;
    };
    this.forearmMat = mat();
    this.handMat = mat();
    this.tickMat = mat();

    const forearmGeom = boxEdges(FOREARM_THICK, FOREARM_THICK, 1);
    const handGeom = boxEdges(HAND_THICK, HAND_THICK * 0.72, HAND_LENGTH, HAND_LENGTH * 0.5);
    const tickGeom = tickGeometry();
    this.geoms.push(forearmGeom, handGeom, tickGeom);

    for (const [geom, m] of [
      [forearmGeom, this.forearmMat],
      [handGeom, this.handMat],
      [forearmGeom, this.forearmMat],
      [handGeom, this.handMat],
    ] as const) {
      const o = new LineSegments(geom, m);
      o.frustumCulled = false;
      o.renderOrder = 20;
      this.bones.push(o);
      this.group.add(o);
    }

    this.tick = new LineSegments(tickGeom, this.tickMat);
    this.tick.frustumCulled = false;
    this.tick.renderOrder = 21;
    this.tick.visible = false;
    this.group.add(this.tick);

    this.group.visible = false;
    scene.add(this.group);
  }

  /**
   * Write one arm's two bones. The forearm's LENGTH is recovered rather than given: core puts the
   * forearm bone at the elbow-wrist midpoint and the hand bone at the wrist, so the half-length is
   * the distance between them — the rig is authored, not solved, and two definitions of "how long
   * is this arm" must not be able to disagree.
   */
  private static poseArm(a: RigArmView, forearm: LineSegments, hand: LineSegments): void {
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

  update(hands: HandsView, cam: PerspectiveCamera): void {
    const vis = hands.visibility;
    this.group.visible = vis > 0.01;
    if (!this.group.visible) return;

    cam.updateMatrixWorld();
    this.group.matrix.copy(cam.matrixWorld);
    this.group.matrixWorldNeedsUpdate = true;

    HandsRig.poseArm(hands.left, this.bones[0]!, this.bones[1]!);
    HandsRig.poseArm(hands.right, this.bones[2]!, this.bones[3]!);
    this.forearmMat.opacity = FOREARM_ALPHA * vis;
    this.handMat.opacity = HAND_ALPHA * vis;

    // ONE tick, on the leading hand, only while a hold is actually being taken. A ladder rung is
    // not a measurement — it is a repeat — so the mark stays for the verbs that commit: mantle and
    // vault. It rides the hand bone exactly, which is what makes it read as a dimension ON the
    // grip rather than a marker floating near it.
    const measuring = hands.state === 'mantle' || hands.state === 'vault';
    this.tick.visible = measuring;
    if (measuring) {
      const h = hands.right.hand;
      this.tick.position.set(h.pos[0], h.pos[1], h.pos[2]);
      this.tick.rotation.set(h.rot[0], h.rot[1], h.rot[2], 'YXZ');
      this.tickMat.opacity = vis;
    }
  }

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    this.geoms.length = 0;
    this.forearmMat.dispose();
    this.handMat.dispose();
    this.tickMat.dispose();
    this.group.clear();
    this.group.visible = false;
  }
}
