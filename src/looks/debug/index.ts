/**
 * THE DEBUG LOOK (engine-plan §9 "Debug look (engine milestone)").
 *
 * "flat white-ish dots (age → gray), plain cyan lines, red dog cloud, plain circle halo +
 * printed audibleRadius/energy, no post."
 *
 * This is the engine's own read of its data, not an art direction. Its job is to make every
 * failure legible: if a dot is in the wrong place it is a white dot in the wrong place, with no
 * bloom, no hue ramp and no depth trick to hide behind. The three authored looks (phosphor,
 * blueprint, signal) will be judged against what this one shows, so it stays deliberately ugly
 * and deliberately literal.
 *
 * WHAT IS STILL LAW HERE, because these are vision laws and not styling (vision §3, §12):
 *
 *   - Absence is black. Nothing is drawn that sound has not reached, except the 2 m contact
 *     shell of vision §3.1. No ambient light, no fog, no outlines, no grid.
 *   - Age is a color. Fresh reads white, old cools to gray, and a painted surfel NEVER falls
 *     below the SKELETON_ALPHA floor: you lose the fine read, never the map (vision §3.6).
 *   - The wavefront is real. A surfel whose `paintTime` is still in the future is not drawn, so
 *     a detonation's paint arrives outward over d/waveSpeed seconds rather than all at once.
 *   - Hard window: 45 m radius and ±1 floor, as a cut and not a fade (vision §3.6, §12).
 *   - Distance discipline: dots thin and dim past ~20 m so the far read biases to edges —
 *     "distance reads as a drawing, nearby as a cloud" (vision §12).
 *   - Dots are matter, lines are holds (vision §5). One encoding, everywhere, forever.
 *   - Colorblind-safe by construction: the dot/line distinction is SHAPE, and the hold accent is
 *     brightness + a doubled stroke, never hue alone (vision §12).
 *
 * The thinning is done with the surfel's own stable `dither`, never with a random draw, so the
 * same dots survive from frame to frame: a cloud that reshuffles every frame is unreadable at
 * parkour speed and unsurvivable through stream compression (vision §12 "temporally stable").
 *
 * Shared-geometry discipline (engine-plan §9): this look creates materials, a scene and HUD
 * nodes, and disposes exactly those. The two BufferGeometries belong to the SurfelField and hold
 * the paint — which is what lets you flip looks mid-run and compare the same painted world.
 */

import { BoxGeometry, Group, LineSegments, Mesh, MeshBasicMaterial, Points, Scene, ShaderMaterial } from 'three';
import type { SoundEvent } from '../../core/events.js';
import type { Look, LookContext, RigArmView } from '../types.js';

/** `paintTime` sentinel test. UNPAINTED is −1e9; anything below −1e8 has never been lit. */
const NEVER_PAINTED = -1.0e8;

/** How long the reticle rim takes to race out and fade after a ping, seconds. */
const RIM_PULSE = 0.4;

/**
 * How long a REFUSED ping's reason stays on the printed readout, seconds.
 *
 * A refusal emits nothing — no event, no chirp, no rim (vision §3.5: refused, never queued) — so
 * it is the one press in the game whose answer is silence, and silence is indistinguishable from
 * a dead key. Long enough to read after a mistimed double-tap, short enough that it is gone before
 * the next honest ping. Text, not a symbol: this look's job is to be literal.
 */
const REFUSAL_SHOW = 0.6;

/**
 * Cross-section of the rig's prisms, metres. The hand is stubbier and slightly wider.
 *
 * These are small because of where the elbow ends up, not because a robot's arm is thin. The rig
 * is posed in camera space with the wrist ~0.55 m out and the elbow ~0.3 m out, and at the FOV
 * this game runs (80-110, vision §12) a 0.3 m depth magnifies a cross-section by ~1600x: every
 * centimetre of prism is another 16 px of solid slab across the frame. A limb that is honest in
 * metres is still the loudest object on screen, which is the opposite of visual-brief §1.6.
 */
const FOREARM_THICK = 0.042;
const HAND_THICK = 0.056;
const HAND_LENGTH = 0.12;

/**
 * Rig opacity at full visibility. Visual-brief §1.6 asks for FAINT machine hands, and faint here
 * is measured against the world and not against black: the world is a sparse lattice of 12 px
 * dots, so a filled prism reads as loud at a fraction of the alpha a solid surface would need.
 * The hand leads the forearm because the hand is the part carrying the verb — where it is planted
 * is the information; the forearm only has to say which way the arm came from.
 */
const FOREARM_ALPHA = 0.22;
const HAND_ALPHA = 0.36;

/** View-space nudge toward the camera for line vertices, metres — beats surfel z-fighting. */
const LINE_LIFT = 0.02;

/**
 * THE DOT CAP, as a fraction of FRAME HEIGHT. Visual-brief §2 "Near field: dots stay dots".
 *
 * A splat is drawn at its projected footprint only up to this ceiling. Vision §12's "splats sized
 * to voxel footprint" is a CEILING — a dot never grows past its own cell — and not a mandate to
 * fill that cell at any range: uncapped, a surfel at arm's length draws as a ~110 px disc, and a
 * field of soft discs is not the "structural dense distance-faded dot lattice" the whole look is
 * built on. The near field reads as a crisp sparse lattice over black, with the 2 m contact shell
 * under it; "nearby reads as a cloud" is bought with density and brightness, never with disc size.
 *
 * RELATIVE, not absolute, because the only scale that matters here is the lattice's own SCREEN
 * PITCH, and that is set by the frame's height: the footprint is `uProjScale * spacing / depth`
 * and `uProjScale` is `viewH/2 / tan(fov/2)`, so both the pitch and the footprint scale with
 * height and the cap has to scale with them or it means something different in every window. At
 * 1000 px tall this is 12 px, which is where it was tuned: with FOV 92 a neighbouring surfel sits
 * `483 * 0.22 / depth` px away, so the cap binds from 8.9 m inward (face-on; sooner at grazing
 * angles, where the equal-area radius is smaller). At 9 m dots are ~12 px at a ~12 px pitch —
 * still a continuous surface — and they open out into visibly separate dots as you close. Below
 * ~0.008 of height the mid-field breaks into a starfield; above ~0.014 the discs return.
 *
 * CONSEQUENCE, recorded rather than fixed: below ~250 px of frame height the cap falls under the
 * absolute SPLAT_NEAR_PX/SPLAT_MIN_PX floors and the floors win, so a very small window can flood
 * again. That is vision §12's own floor law ("splats >= 2-3 px and temporally stable" — a
 * sub-pixel dot dies in stream compression) being paid for, not a defect in this cap: the two
 * laws genuinely conflict at postage-stamp sizes and the floor is the one that must hold.
 *
 * The cap also removes an artifact for free: WebGL culls a point whose CENTRE leaves the viewport,
 * so a huge splat popped out at the frame edge while half of it was still on screen.
 */
const SPLAT_CAP_FRAC = 0.012;

const DOT_VERT = /* glsl */ `
attribute float dither;
attribute float paintTime;
attribute float paintIntensity;

uniform float uNow;
uniform vec3  uCamPos;
uniform float uFloorCentre;
uniform float uFloorSpan;
uniform float uWindowRadius;
uniform float uFarBias;
uniform float uAgeFlash;
uniform float uAgeSkeleton;
uniform float uSkeletonAlpha;
uniform float uShellRadius;
uniform float uShellAlpha;
uniform vec3  uBodyFeet;
uniform vec3  uBodyHead;
uniform float uSpacing;
uniform float uProjScale;
uniform float uPixelRatio;
uniform float uSplatMin;
uniform float uSplatNear;
uniform float uSplatCap;

varying float vAlpha;
varying float vAge;

// Clip-space nowhere. A vertex pushed outside the volume with zero size costs one rasteriser
// reject and nothing else — cheaper and more portable than a discard in the fragment stage.
#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

// Vision §3.1 measures the contact shell from your BODY, not your eye — and it has to be the
// body, or the shell is invisible: standing still, the nearest floor the camera can actually see
// is 2.2 m from the eye and only 1.6 m from the capsule. Distance to the feet-head segment.
float bodyDist(vec3 p) {
  vec3 ab = uBodyHead - uBodyFeet;
  float t = clamp(dot(p - uBodyFeet, ab) / max(1.0e-5, dot(ab, ab)), 0.0, 1.0);
  return distance(p, uBodyFeet + ab * t);
}

// Faint but not imaginary: flat across the reachable part of the shell, feathered only at its
// edge. A linear falloff from the body centre puts everything real at a quarter of uShellAlpha,
// which rounds to nothing in 8 bits — an invisible shell is not a shell.
float shellAlpha(vec3 p) {
  return uShellAlpha * (1.0 - smoothstep(uShellRadius * 0.9, uShellRadius, bodyDist(p)));
}

void main() {
  float camDist = distance(position, uCamPos);

  // The hard window (vision §3.6). A cut, not a fade: outside it there is no world.
  if (camDist > uWindowRadius || abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // The wavefront is WRITE-timed, not gate-timed: core paints a surfel when the sound reaches it
  // and never before (see PaintJob in core/paint.ts), so a detonation blooms outward because the
  // dots arrive over ten frames, not because the shader is hiding them. The age test below is
  // therefore a guard that should never fire — it is kept as the assertion that the invariant
  // holds, because a future paintTime would BLANK a surface the player already owned (vision
  // §3.6), and a silent hole is the hardest kind of bug to see.
  float age = uNow - paintTime;
  float lit = (paintTime > ${NEVER_PAINTED.toExponential()} && age >= 0.0) ? 1.0 : 0.0;

  // Age -> alpha, with the permanent memory-skeleton floor under it.
  float cool = smoothstep(uAgeFlash, uAgeSkeleton, age);
  float aged = mix(1.0, uSkeletonAlpha, cool);
  float alpha = lit * max(uSkeletonAlpha, aged * mix(0.55, 1.0, paintIntensity));

  // Distance discipline. "far" is 0 inside uFarBias and 1 at the cut; dots dim, and the cloud
  // thins against each dot's own stable dither so the survivors never flicker.
  float far = smoothstep(uFarBias, uWindowRadius, camDist);
  if (dither > 1.0 - far) alpha = 0.0;
  alpha *= 1.0 - 0.6 * far;

  // A splat is drawn at the projected footprint of its lattice cell, BOUNDED ABOVE by uSplatCap
  // (visual-brief §2 "Near field: dots stay dots"). Footprint growth is what makes the mid field
  // a surface rather than a starfield — the lattice is fixed in WORLD space, so as you approach
  // you see fewer dots covering more solid angle and they have to grow to keep the surface
  // continuous. Past the cap that stops being true and starts being a screenful of soft discs, so
  // the cap holds them at a dot and lets density and brightness carry the near read instead.
  //
  // The two px constants are FLOORS on the same footprint (visual-brief §2 "splats >= 2-3 px and
  // temporally stable" — a sub-pixel dot dies in stream compression and shimmers). The floor
  // relaxes with distance because the far field is meant to thin toward a drawing: near dots hold
  // uSplatNear, far dots may go down to uSplatMin.
  //
  // The floor is raised over the cap rather than assumed to sit under it. GLSL leaves clamp
  // UNDEFINED when its low bound exceeds its high one, and the two operands are owned by different
  // modules — the floors are core constants, the cap is private to this look and now scales with
  // the window — so "they cannot cross" is not something this shader is allowed to believe. Where
  // they do cross, the floor wins (see SPLAT_CAP_FRAC).
  //
  // Foreshortening: the cell is a square in the SURFACE, so what it covers on screen is an ellipse
  // with semi-axes a and a*|n.v| — a floor seen edge-on covers a fraction of what the same cell
  // covers face-on. A round sprite cannot be that ellipse, so it is drawn at the equal-area
  // radius, a*sqrt(|n.v|). Without this, every grazing surface (which is most of a corridor)
  // overlaps itself into a solid sheet and the cloud stops being a cloud.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 toCam = normalize(uCamPos - position);
  float foot = uProjScale * uSpacing / max(0.05, -mv.z);
  foot *= sqrt(clamp(abs(dot(normal, toCam)), 0.15, 1.0));
  float floorPx = mix(uSplatNear, uSplatMin, far);
  float size = clamp(foot, floorPx, max(uSplatCap, floorPx));

  // Contact shell (vision §3.1): the only geometry visible without sound. Faint, 2 m, always on.
  alpha = max(alpha, shellAlpha(position));
  if (alpha <= 0.003) CULL()

  vAlpha = alpha;
  vAge = lit > 0.5 ? age : -1.0;

  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * uPixelRatio;
}
`;

const DOT_FRAG = /* glsl */ `
uniform float uAgeCool;

varying float vAlpha;
varying float vAge;

void main() {
  // Round splat: a square lattice of square dots reads as a screen door, not as a surface.
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;

  // Flat white aging to gray. No hue: in the debug look the matter layer carries no colour at
  // all, so anything coloured on screen is provably an event marker and not geometry.
  float grey = mix(1.0, 0.42, clamp(vAge / uAgeCool, 0.0, 1.0));
  vec3 c = vec3(grey);
  // Shell-only dots read cool rather than neutral, so "I am touching this" and "I heard this"
  // are never the same pixel. The DIMNESS is carried by alpha, not by the colour: at 0.05 alpha
  // a dark colour rounds to black in 8 bits and the shell disappears entirely.
  if (vAge < 0.0) c = vec3(0.66, 0.78, 0.88);
  gl_FragColor = vec4(c, vAlpha);
}
`;

const LINE_VERT = /* glsl */ `
attribute float dither;
attribute float flagsHold;
attribute float paintTime;
attribute float paintIntensity;

uniform float uNow;
uniform vec3  uCamPos;
uniform float uFloorCentre;
uniform float uFloorSpan;
uniform float uWindowRadius;
uniform float uFarBias;
uniform float uAgeFlash;
uniform float uAgeSkeleton;
uniform float uSkeletonAlpha;
uniform float uSkeletonAlphaEdge;
uniform float uShellRadius;
uniform float uShellAlpha;
uniform vec3  uBodyFeet;
uniform vec3  uBodyHead;
uniform float uHoldOnly;
uniform vec2  uOffsetPx;
uniform vec2  uViewport;
uniform float uLift;

varying float vAlpha;
varying float vHold;
varying float vAge;

#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

float bodyDist(vec3 p) {
  vec3 ab = uBodyHead - uBodyFeet;
  float t = clamp(dot(p - uBodyFeet, ab) / max(1.0e-5, dot(ab, ab)), 0.0, 1.0);
  return distance(p, uBodyFeet + ab * t);
}

float shellAlpha(vec3 p) {
  return uShellAlpha * (1.0 - smoothstep(uShellRadius * 0.9, uShellRadius, bodyDist(p)));
}

void main() {
  float hold = step(0.5, flagsHold);
  if (uHoldOnly > 0.5 && hold < 0.5) CULL()

  float camDist = distance(position, uCamPos);
  if (camDist > uWindowRadius || abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // Same gate as the dot shader, same never-fires reasoning: see DOT_VERT.
  float age = uNow - paintTime;
  float lit = (paintTime > ${NEVER_PAINTED.toExponential()} && age >= 0.0) ? 1.0 : 0.0;

  float cool = smoothstep(uAgeFlash, uAgeSkeleton, age);
  float floorA = mix(uSkeletonAlpha, uSkeletonAlphaEdge, hold);
  float alpha = lit * max(floorA, mix(1.0, floorA, cool) * mix(0.6, 1.0, paintIntensity));

  // Edge-biased retention (vision §12): lines keep far more of their strength at range than
  // dots do, which is what turns the far field into a drawing.
  alpha *= 1.0 - 0.35 * smoothstep(uFarBias, uWindowRadius, camDist);

  // The contact shell reaches holds too: a rail 1 m from your body is contact geometry.
  alpha = max(alpha, shellAlpha(position));
  if (alpha <= 0.003) CULL()

  vAlpha = alpha;
  vHold = hold;
  vAge = lit > 0.5 ? age : -1.0;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.z += uLift; // toward the camera: a crease line sits ON the surfels it creases
  gl_Position = projectionMatrix * mv;
  // gl_LineWidth is fixed at 1 in WebGL, so "thicker" is a second offset pass over the same
  // geometry (see makeLineMaterial). The offset is screen-space, so it holds at every distance.
  gl_Position.xy += uOffsetPx * (2.0 / uViewport) * gl_Position.w;
}
`;

const LINE_FRAG = /* glsl */ `
varying float vAlpha;
varying float vHold;
varying float vAge;

void main() {
  // Plain cyan. Holds read brighter AND doubled (the offset pass) — brightness plus stroke, so
  // the hold/edge distinction survives any colour vision (vision §12).
  vec3 c = mix(vec3(0.20, 0.68, 0.80), vec3(0.62, 0.97, 1.0), vHold);
  if (vAge < 0.0) c = vec3(0.45, 0.72, 0.82); // shell-only: dimmed by alpha, not by colour
  gl_FragColor = vec4(c, vAlpha);
}
`;

type Uniforms = Record<string, { value: unknown }>;

export function createDebugLook(id = 'debug', title = 'debug', note = ''): Look {
  let ctx: LookContext | null = null;
  const scene = new Scene();

  let dotMat: ShaderMaterial | null = null;
  let lineMat: ShaderMaterial | null = null;
  let holdMat: ShaderMaterial | null = null;
  let dots: Points | null = null;
  let lines: LineSegments | null = null;
  let holds: LineSegments | null = null;

  let hudRoot: HTMLDivElement | null = null;
  let halo: HTMLDivElement | null = null;
  let rim: HTMLDivElement | null = null;
  let readout: HTMLDivElement | null = null;
  let readoutAcc = 0;
  /** Sim time of the last outgoing ping, for the rim pulse. −1 = none this session. */
  let lastPingAt = -1;

  /**
   * The hands rig (engine-plan §6, visual-brief §1.6). Core hands over four bone poses in CAMERA
   * space; this look owns what they are made of. The group's transform IS the camera's, so the
   * bones can be written into it unchanged — no per-frame world-space conversion, and the rig
   * cannot drift from the eye it hangs off.
   */
  const handsGroup = new Group();
  handsGroup.matrixAutoUpdate = false;
  handsGroup.frustumCulled = false;
  let forearmGeom: BoxGeometry | null = null;
  let handGeom: BoxGeometry | null = null;
  let forearmMat: MeshBasicMaterial | null = null;
  let handMat: MeshBasicMaterial | null = null;
  /** [left, right] × [forearm, hand]. */
  let handMeshes: Mesh[] = [];

  let viewW = 1;
  let viewH = 1;

  const shared = (c: LookContext): Uniforms => ({
    uNow: { value: 0 },
    uCamPos: { value: [0, 0, 0] },
    uFloorCentre: { value: c.floorCentre },
    uFloorSpan: { value: c.floorSpan },
    uWindowRadius: { value: c.constants.WINDOW_RADIUS },
    uFarBias: { value: c.constants.FAR_BIAS_START },
    uAgeFlash: { value: c.constants.AGE_FLASH },
    uAgeSkeleton: { value: c.constants.AGE_SKELETON },
    uSkeletonAlpha: { value: c.constants.SKELETON_ALPHA },
    uShellRadius: { value: c.constants.CONTACT_SHELL_RADIUS },
    uShellAlpha: { value: c.constants.CONTACT_SHELL_ALPHA },
    uBodyFeet: { value: [0, 0, 0] },
    uBodyHead: { value: [0, 0, 0] },
  });

  const makeLineMaterial = (c: LookContext, holdOnly: boolean): ShaderMaterial =>
    new ShaderMaterial({
      uniforms: {
        ...shared(c),
        uSkeletonAlphaEdge: { value: c.constants.SKELETON_ALPHA_EDGE },
        uHoldOnly: { value: holdOnly ? 1 : 0 },
        uOffsetPx: { value: holdOnly ? [0.85, 0.85] : [0, 0] },
        uViewport: { value: [1, 1] },
        uLift: { value: LINE_LIFT },
      },
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthTest: true,
      // Lines never occlude the cloud they annotate; they are read THROUGH.
      depthWrite: false,
    });

  const setUniform = (m: ShaderMaterial | null, name: string, v: unknown): void => {
    const u = m?.uniforms[name];
    if (u) u.value = v;
  };

  /**
   * Write one arm's two bones onto their meshes. The forearm's LENGTH is recovered rather than
   * given: core puts the forearm bone at the elbow-wrist midpoint and the hand bone at the wrist,
   * so the half-length is the distance between them. The rig is authored, not solved, and this
   * keeps the two definitions of "how long is this arm" from being able to disagree.
   */
  const poseArm = (a: RigArmView, forearm: Mesh, hand: Mesh): void => {
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
  };

  return {
    id,
    title,

    init(c: LookContext): void {
      ctx = c;

      dotMat = new ShaderMaterial({
        uniforms: {
          ...shared(c),
          uAgeCool: { value: c.constants.AGE_COOL },
          uSpacing: { value: c.constants.SURFEL_SPACING },
          uProjScale: { value: 500 },
          uPixelRatio: { value: 1 },
          uSplatMin: { value: c.constants.SPLAT_MIN_PX },
          uSplatNear: { value: c.constants.SPLAT_NEAR_PX },
          uSplatCap: { value: SPLAT_CAP_FRAC * viewH },
        },
        vertexShader: DOT_VERT,
        fragmentShader: DOT_FRAG,
        transparent: true,
        depthTest: true,
        // Dots DO write depth: a near surface must hide the room behind it, or the memory
        // skeleton of the next room reads as if it were in this one.
        depthWrite: true,
      });
      lineMat = makeLineMaterial(c, false);
      holdMat = makeLineMaterial(c, true);

      dots = new Points(c.surfelGeom, dotMat);
      dots.frustumCulled = false; // one object holds the whole floor; the shader does the culling
      lines = new LineSegments(c.edgeGeom, lineMat);
      lines.frustumCulled = false;
      lines.renderOrder = 1;
      holds = new LineSegments(c.edgeGeom, holdMat);
      holds.frustumCulled = false;
      holds.renderOrder = 2;
      scene.add(dots, lines, holds);

      // A bone's long axis is its local +z (core/player.ts RigBone), so both prisms are built
      // along +z: the forearm is a unit-length box scaled to the bone, the hand a fixed stub
      // pushed forward off the wrist rather than straddling it.
      forearmGeom = new BoxGeometry(FOREARM_THICK, FOREARM_THICK, 1);
      handGeom = new BoxGeometry(HAND_THICK, HAND_THICK * 0.72, HAND_LENGTH);
      handGeom.translate(0, 0, HAND_LENGTH * 0.5);
      forearmMat = new MeshBasicMaterial({ color: 0x8fa6b4, transparent: true, opacity: 0 });
      handMat = new MeshBasicMaterial({ color: 0xc6d8e4, transparent: true, opacity: 0 });
      handMeshes = [
        new Mesh(forearmGeom, forearmMat),
        new Mesh(handGeom, handMat),
        new Mesh(forearmGeom, forearmMat),
        new Mesh(handGeom, handMat),
      ];
      for (const m of handMeshes) {
        m.frustumCulled = false;
        handsGroup.add(m);
      }
      handsGroup.visible = false;
      scene.add(handsGroup);

      // --- HUD: reticle, halo ring, printed readout (engine-plan §9) ----------------------
      hudRoot = document.createElement('div');
      hudRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

      const reticle = document.createElement('div');
      reticle.style.cssText =
        'position:absolute;left:50%;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;' +
        'border-radius:50%;background:rgba(235,245,255,0.75);';
      hudRoot.appendChild(reticle);

      halo = document.createElement('div');
      halo.style.cssText =
        'position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;' +
        'border-radius:50%;border:1px solid rgba(235,245,255,0);';
      hudRoot.appendChild(halo);

      // Visual-brief §1.11 "racing rim": a ping needs an answer before its paint can possibly
      // arrive, so the rim leaves the reticle the instant the event does. A SEPARATE ring from the
      // halo on purpose — the halo's brightness means loudness and nothing else, and borrowing it
      // for a moment of feedback would make the one honest readout lie twice a second.
      rim = document.createElement('div');
      rim.style.cssText =
        'position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;' +
        'border-radius:50%;border:1px solid rgba(235,245,255,0);opacity:0;';
      hudRoot.appendChild(rim);

      readout = document.createElement('div');
      readout.style.cssText =
        'position:absolute;left:50%;top:50%;margin:38px 0 0 -110px;width:220px;text-align:center;' +
        'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(190,205,215,0.72);' +
        'white-space:pre;text-shadow:0 0 6px #000;';
      hudRoot.appendChild(readout);

      if (note) {
        const banner = document.createElement('div');
        banner.style.cssText =
          'position:absolute;left:0;right:0;top:12px;text-align:center;' +
          'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(190,205,215,0.55);';
        banner.textContent = note;
        hudRoot.appendChild(banner);
      }

      c.hud.appendChild(hudRoot);
      this.resize(viewW, viewH);
    },

    /**
     * The debug look draws no event decoration — no stains, no markers. The one exception is the
     * rim, and it is not decoration: it is the acknowledgement that the ping you pressed happened,
     * which the paint alone cannot give you until the wavefront gets somewhere. The far end is
     * skipped: it is the same ping arriving, not a second press.
     */
    onEvent(e: SoundEvent): void {
      if (e.source !== 'self' || e.variant === 'far') return;
      if (e.class === 'ePing' || e.class === 'qPing') lastPingAt = e.time;
    },

    update(now: number, dt: number): void {
      const c = ctx;
      if (!c) return;

      const cam = c.camera;
      const camPos = [cam.position.x, cam.position.y, cam.position.z];
      // The shell is measured off the body: feet from the interpolated player pose, head at the
      // eye. Both are picture-side values (engine-plan §11.1) — they must not swim at 144 Hz.
      const feet = [c.player.pos[0], c.player.pos[1], c.player.pos[2]];
      for (const m of [dotMat, lineMat, holdMat]) {
        setUniform(m, 'uNow', now);
        setUniform(m, 'uCamPos', camPos);
        setUniform(m, 'uBodyFeet', feet);
        setUniform(m, 'uBodyHead', camPos);
        setUniform(m, 'uFloorCentre', c.floorCentre);
        setUniform(m, 'uFloorSpan', c.floorSpan);
      }

      // Pixels per metre at one metre of depth. Recomputed every frame because the FOV moves
      // with the sprint kick — a splat that ignored that would swell as you accelerate.
      const projScale = (viewH * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
      setUniform(dotMat, 'uProjScale', projScale);

      const p = c.player;

      // The hands rig rides the camera exactly (see handsGroup): the bones are already camera-
      // space, so the group simply wears the camera's world matrix. `visibility` is core's fade,
      // so letting go of a ladder withdraws the rig instead of deleting it mid-frame.
      const vis = p.hands.visibility;
      handsGroup.visible = vis > 0.01;
      if (handsGroup.visible) {
        cam.updateMatrixWorld();
        handsGroup.matrix.copy(cam.matrixWorld);
        handsGroup.matrixWorldNeedsUpdate = true;
        poseArm(p.hands.left, handMeshes[0]!, handMeshes[1]!);
        poseArm(p.hands.right, handMeshes[2]!, handMeshes[3]!);
        if (forearmMat) forearmMat.opacity = FOREARM_ALPHA * vis;
        if (handMat) handMat.opacity = HAND_ALPHA * vis;
      }

      if (!halo || !rim || !readout) return;

      // Vision §3.8: ring brightness IS the audible radius. Linear in `loud`, with a floor that
      // exists so the ring is still findable at silence — the reading is the ramp, not the floor.
      const loud = Math.min(1, p.audibleRadius / c.constants.HALO_FULL_M);
      halo.style.borderColor = `rgba(235,245,255,${(0.06 + 0.62 * loud).toFixed(3)})`;

      const pingAge = lastPingAt < 0 ? Infinity : now - lastPingAt;
      if (pingAge >= 0 && pingAge < RIM_PULSE) {
        const u = pingAge / RIM_PULSE;
        // Reduce-flashing (vision §12): the ring still answers, it just fades in place instead of
        // racing. No school may depend on the motion, so neither may the instrument.
        const scale = c.reduceFlashing() ? 1 : 1 + 1.1 * u;
        rim.style.opacity = (1 - u).toFixed(3);
        rim.style.transform = `scale(${scale.toFixed(3)})`;
        rim.style.borderColor = 'rgba(235,245,255,0.8)';
      } else if (rim.style.opacity !== '0') {
        rim.style.opacity = '0';
      }

      readoutAcc += dt;
      if (readoutAcc >= 0.1) {
        readoutAcc = 0;
        // Core resolved the press and stamped it; the look only decides how long to show it.
        const lp = p.lastPing;
        const refusal = lp && lp.refused && now - lp.at < REFUSAL_SHOW ? ` · ${lp.refused}` : '';
        readout.textContent =
          `audible ${p.audibleRadius.toFixed(1).padStart(5)} m    ` +
          `⚡ ${p.energy.toFixed(0).padStart(3)}/${p.energyMax}${refusal}`;
      }
    },

    render(): void {
      const c = ctx;
      if (!c) return;
      c.renderer.render(scene, c.camera);
    },

    resize(w: number, h: number): void {
      viewW = Math.max(1, w);
      viewH = Math.max(1, h);
      const dpr = ctx ? ctx.renderer.getPixelRatio() : 1;
      setUniform(dotMat, 'uPixelRatio', dpr);
      // CSS px, like every other term in the size math — the DPR multiply happens once, in the
      // shader, and applying it here as well would square it.
      setUniform(dotMat, 'uSplatCap', SPLAT_CAP_FRAC * viewH);
      const vp = [viewW * dpr, viewH * dpr];
      setUniform(lineMat, 'uViewport', vp);
      setUniform(holdMat, 'uViewport', vp);
    },

    dispose(): void {
      scene.clear();
      handsGroup.clear();
      dotMat?.dispose();
      lineMat?.dispose();
      holdMat?.dispose();
      forearmGeom?.dispose();
      handGeom?.dispose();
      forearmMat?.dispose();
      handMat?.dispose();
      dotMat = lineMat = holdMat = null;
      forearmGeom = handGeom = null;
      forearmMat = handMat = null;
      handMeshes = [];
      dots = lines = holds = null;
      hudRoot?.remove();
      hudRoot = null;
      halo = null;
      rim = null;
      readout = null;
      lastPingAt = -1;
      ctx = null;
      // NOT disposed, on purpose: ctx.surfelGeom / ctx.edgeGeom are the SurfelField's, and they
      // hold the run's paint. Disposing them here would black the world on every look switch.
    },
  };
}
