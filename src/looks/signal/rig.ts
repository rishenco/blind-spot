/**
 * SIGNAL — the hands rig (signal.md "Hands, halo, HUD", visual-brief §1.6, engine-plan §6).
 *
 * "Filled matte dark panels with `#C9F2FF` edge seams; on grab, the contact edge runs its dash
 * pattern once."
 *
 * A panel this dark over a black world is almost entirely OCCLUSION: what you actually see is the
 * seam, and the shape of the hole the panel punches in the lattice behind it. That is the whole
 * design — the rig says "you are climbing" with two bright outlines and a silhouette, and never
 * competes with the world for brightness (visual-brief §1.6 "faint machine hands").
 *
 * Core owns the POSE — four bones in CAMERA space (core/player.ts `RigBone`) — and this file owns
 * what a hand is made of. The group wears the camera's world matrix, so the camera-space bones can
 * be written into it unchanged and the rig cannot drift from the eye it hangs off.
 */

import {
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  SRGBColorSpace,
  type PerspectiveCamera,
} from 'three';
import type { HandsView, RigArmView } from '../types.js';
import * as P from './params.js';

const SEAM_VERT = /* glsl */ `
uniform float uZMin;
uniform float uZSpan;

varying float vT;

void main() {
  // 0 at the wrist end of the bone, 1 at its tip. The run travels along this, so it travels along
  // the ARM — the direction the grab is happening in — and not along whatever axis the box was
  // authored on.
  vT = clamp((position.z - uZMin) / uZSpan, 0.0, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SEAM_FRAG = /* glsl */ `
uniform vec3  uColor;
uniform float uAlpha;
uniform float uRun;
uniform float uGain;
uniform float uDashOn;
uniform float uDashOff;
uniform float uPixelRatio;

varying float vT;

void main() {
  float a = uAlpha;

  // The one-shot run (signal.md: "on grab, the contact edge runs its dash pattern once"). A
  // travelling window, and inside it the seam breaks into the same 6/2 px screen-space dash the
  // holds carry — one dash language, two places. uRun is < 0 whenever no grab is running, so a
  // rig at rest is a perfectly steady pair of outlines: Signal's glitch lives in births and
  // deaths of information, never idle.
  if (uRun >= 0.0) {
    float d = (vT - uRun) * 3.2;
    float band = exp(-d * d);
    float dash = 1.0;
    float w = fwidth(vT);
    if (w > 1.0e-6 && uDashOn > 0.0) {
      float px = (vT / w) / uPixelRatio;
      float period = uDashOn + uDashOff;
      dash = smoothstep(-0.5, 0.5, uDashOn - mod(px, period));
    }
    a *= 1.0 + uGain * band * dash;
  }
  if (a <= 0.003) discard;

  gl_FragColor = vec4(uColor, a);
}
`;

/**
 * The hands, as four prisms and four outlines.
 *
 * Two panel materials and two seam materials, shared left/right — the two arms differ only in
 * their pose, so they have nothing to disagree about but their transforms.
 */
export class SignalRig {
  readonly group = new Group();

  private readonly forearmGeom: BoxGeometry;
  private readonly handGeom: BoxGeometry;
  private readonly forearmEdges: EdgesGeometry;
  private readonly handEdges: EdgesGeometry;
  private readonly panelMat: MeshBasicMaterial;
  private readonly seamMats: ShaderMaterial[] = [];
  /** [left forearm, left hand, right forearm, right hand]. */
  private readonly limbs: Mesh[] = [];
  private readonly seams: LineSegments[] = [];

  /** Sim time the current seam run started; < 0 when nothing is running. */
  private runAt = -1;
  /** The grab that is already running, so one verb cannot retrigger itself every frame. */
  private lastState = '';
  private lastCycle = -1;

  constructor() {
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;

    // A bone's long axis is its local +z (core/player.ts `RigBone`), so both prisms are built
    // along +z: the forearm is a unit-length box scaled to the bone, the hand a fixed stub pushed
    // forward off the wrist rather than straddling it.
    this.forearmGeom = new BoxGeometry(P.FOREARM_THICK, P.FOREARM_THICK, 1);
    this.handGeom = new BoxGeometry(P.HAND_THICK, P.HAND_THICK * 0.72, P.HAND_LENGTH);
    this.handGeom.translate(0, 0, P.HAND_LENGTH * 0.5);
    this.forearmEdges = new EdgesGeometry(this.forearmGeom);
    this.handEdges = new EdgesGeometry(this.handGeom);

    // The panel is the one thing in this look drawn with a stock three material, so it is the one
    // colour that goes through colour management: `SRGBColorSpace` says the palette entry is the
    // hex from the brief, not a linear triple, and the renderer converts it back on output. The
    // custom shaders elsewhere emit their palette values unconverted, which is the same pixel.
    this.panelMat = new MeshBasicMaterial({ transparent: true, opacity: 0 });
    this.panelMat.color.setRGB(P.PANEL_RGB[0], P.PANEL_RGB[1], P.PANEL_RGB[2], SRGBColorSpace);

    const seamMat = (zMin: number, zSpan: number): ShaderMaterial => {
      const m = new ShaderMaterial({
        uniforms: {
          uColor: { value: [...P.PALETTE.edge] },
          uAlpha: { value: 0 },
          uRun: { value: -1 },
          uGain: { value: P.SEAM_RUN_GAIN },
          uDashOn: { value: P.DASH_PATTERN[0] },
          uDashOff: { value: P.DASH_PATTERN[1] },
          uZMin: { value: zMin },
          uZSpan: { value: zSpan },
          uPixelRatio: { value: 1 },
        },
        vertexShader: SEAM_VERT,
        fragmentShader: SEAM_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
      });
      this.seamMats.push(m);
      return m;
    };
    // The forearm box is authored unit-length and SCALED to the bone, so its local z stays -0.5..0.5
    // whatever the arm's length is; the hand stub was translated forward off the wrist.
    const forearmSeamMat = seamMat(-0.5, 1);
    const handSeamMat = seamMat(0, P.HAND_LENGTH);

    for (let i = 0; i < 4; i++) {
      const isHand = (i & 1) === 1;
      const mesh = new Mesh(isHand ? this.handGeom : this.forearmGeom, this.panelMat);
      mesh.frustumCulled = false;
      const seam = new LineSegments(isHand ? this.handEdges : this.forearmEdges, isHand ? handSeamMat : forearmSeamMat);
      seam.frustumCulled = false;
      seam.renderOrder = 6;
      this.limbs.push(mesh);
      this.seams.push(seam);
      this.group.add(mesh, seam);
    }
    this.group.visible = false;
  }

  setPixelRatio(dpr: number): void {
    for (const m of this.seamMats) m.uniforms.uPixelRatio!.value = dpr;
  }

  /**
   * Pose and light the rig for this frame.
   *
   * `visibility` is core's fade, so letting go of a ladder withdraws the rig instead of deleting
   * it mid-frame. A ladder's `phase` wraps once per grab CYCLE, which is exactly one contact per
   * wrap — so the run retriggers on the wrap and the rig ticks with the climb.
   */
  update(hands: HandsView, camera: PerspectiveCamera, now: number): void {
    const vis = hands.visibility;
    this.group.visible = vis > 0.01;
    if (!this.group.visible) {
      this.lastState = '';
      this.lastCycle = -1;
      return;
    }

    camera.updateMatrixWorld();
    this.group.matrix.copy(camera.matrixWorld);
    this.group.matrixWorldNeedsUpdate = true;

    this.poseArm(hands.left, this.limbs[0]!, this.limbs[1]!);
    this.poseArm(hands.left, this.seams[0]!, this.seams[1]!);
    this.poseArm(hands.right, this.limbs[2]!, this.limbs[3]!);
    this.poseArm(hands.right, this.seams[2]!, this.seams[3]!);

    // A new verb, or a ladder cycle rolling over, is a new contact — and a contact is the only
    // thing in this rig allowed to move on its own.
    const cycle = hands.state === 'ladder' ? Math.floor(hands.phase * 2) : 0;
    if (hands.state !== 'none' && (hands.state !== this.lastState || cycle !== this.lastCycle)) {
      this.runAt = now;
    }
    this.lastState = hands.state;
    this.lastCycle = cycle;

    const run = this.runAt < 0 ? -1 : (now - this.runAt) / P.SEAM_RUN_S;
    if (run > 1) this.runAt = -1;

    this.panelMat.opacity = P.PANEL_ALPHA * vis;
    for (const m of this.seamMats) {
      m.uniforms.uAlpha!.value = P.SEAM_ALPHA * vis;
      m.uniforms.uRun!.value = run >= 0 && run <= 1 ? run : -1;
    }
  }

  /**
   * Write one arm's two bones onto a pair of objects. The forearm's LENGTH is recovered rather
   * than given: core puts the forearm bone at the elbow-wrist midpoint and the hand bone at the
   * wrist, so the half-length is the distance between them. That keeps the two definitions of
   * "how long is this arm" from being able to disagree.
   */
  private poseArm(a: RigArmView, forearm: Mesh | LineSegments, hand: Mesh | LineSegments): void {
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
    this.forearmGeom.dispose();
    this.handGeom.dispose();
    this.forearmEdges.dispose();
    this.handEdges.dispose();
    this.panelMat.dispose();
    for (const m of this.seamMats) m.dispose();
    this.seamMats.length = 0;
    this.limbs.length = 0;
    this.seams.length = 0;
  }
}
