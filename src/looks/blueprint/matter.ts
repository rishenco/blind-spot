/**
 * BLUEPRINT — the matter layer. The drawing that plots itself.
 *
 * "Edges lead everything. On any paint event covering an edge, its line draws in FIRST (80 ms wipe
 * along the segment), dots hatch in behind." (doc/looks/blueprint.md)
 *
 * Six passes over the two SHARED geometries, in plot order:
 *
 *   dots      one Points over `surfelGeom` — the graph-paper lattice, delayed by EDGE_LEAD_MS
 *   skirt ±   two LineSegments over `edgeGeom` — the line's WEIGHT, offset a real perpendicular
 *   core      one LineSegments over `edgeGeom` — the stroke; white on a hold, ice-blue on an edge
 *   ticks ×2  two LineSegments over `edgeGeom` — the dimension terminals a hold gets and an edge does not
 *
 * SHARED-GEOMETRY DISCIPLINE (engine-plan §9). The line passes need two things the shared edge
 * buffer does not carry — the segment VECTOR (for the perpendicular that gives a line its weight,
 * and for the endpoint a tick sits on) and WHICH END a vertex is (the wipe parameter). Rather than
 * mutate core's geometry or copy 2.7 k vertices every frame, this file builds ONE look-owned
 * BufferGeometry that re-uses core's BufferAttribute INSTANCES for the five shared attributes and
 * adds `aTan` / `aEnd` of its own. The GPU buffer behind a BufferAttribute is keyed by the
 * attribute object, so the shared ones are uploaded once and read by both geometries — and
 * `dispose()` removes the shared attributes from this geometry BEFORE disposing it, so the
 * renderer frees `aTan` / `aEnd` and nothing that belongs to core.
 *
 * NO STREAKS. A vertex pushed to clip-space nowhere is fine for a POINT and quietly wrong for a
 * LINE: the segment from its live partner gets clipped at the frustum wall and draws a streak
 * across the frame. So the only cull in the line shader is one BOTH vertices reach the same
 * answer to — it is computed from the segment's MIDPOINT, which each end reconstructs from `aTan`.
 * Everything else ("not painted yet", "not a hold", "the pen has not reached this end") is
 * expressed as alpha 0 at the vertex's real position, which is also what core intends: "a segment
 * straddling the falloff edge fades along its own length in the shader" (core/paint.ts).
 */

import {
  BufferAttribute,
  BufferGeometry,
  LineSegments,
  Points,
  ShaderMaterial,
  type Scene,
} from 'three';
import type { CoreConstants } from '../../core/const.js';
import type { BlueprintFrame } from './frame.js';
import {
  DOT_CAP_FRAC,
  DOT_SKIRT,
  DOT_SNAP_MS,
  DOT_SUPERELLIPSE,
  EDGE_LEAD_MS,
  FLASH_S,
  LINE_W_FALLOFF_M,
  LINE_W_FAR,
  LINE_W_NEAR,
  PALETTE,
  RIM_EASE_CALM,
  RIM_EDGE_BOOST,
  RIM_MAX_S,
  RIM_MIN_FRAMES,
  RIM_ZONE_M,
  SKELETON_THIN,
  SLATE_AT,
  TICK_LEN,
  TICK_MIN_PX,
} from './params.js';

/** `paintTime` sentinel test. UNPAINTED is −1e9; anything below −1e8 has never been lit. */
const NEVER_PAINTED = -1.0e8;
const SENTINEL = NEVER_PAINTED.toExponential();

/** View-space nudge toward the camera for line vertices, metres — beats surfel z-fighting. */
const LINE_LIFT = 0.02;

/** Assumed frame time when widening the rim to something a frame can actually show, seconds. */
const FRAME_S = 1 / 60;

type Uniforms = Record<string, { value: unknown }>;

// ---------------------------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------------------------

/** The window, the body shell, the age ramp and the rim — identical in both shaders, declared once. */
const COMMON = /* glsl */ `
uniform float uNow;
uniform vec3  uCamPos;
uniform float uFloorCentre;
uniform float uFloorSpan;
uniform float uWindowRadius;
uniform float uFarBias;
uniform float uAgeHot;
uniform float uAgeMid;
uniform float uAgeCool;
uniform float uAgeSkeleton;
uniform float uSkeletonAlpha;
uniform float uShellRadius;
uniform float uShellAlpha;
uniform vec3  uBodyFeet;
uniform vec3  uBodyHead;
uniform float uFlashS;
uniform float uSlateAt;
uniform float uRimWindow;
uniform float uRimEase;
uniform float uCalm;
uniform float uProjScale;

uniform vec3 uCFlash;
uniform vec3 uCHot;
uniform vec3 uCMid;
uniform vec3 uCSlate;
uniform vec3 uCCool;
uniform vec3 uCSkel;
uniform vec3 uCRim;
uniform vec3 uCContact;

// Vision §3.1 measures the contact shell from the BODY, not the eye: standing still, the nearest
// floor the camera can see is 2.2 m from the eye and 1.6 m from the capsule.
float bodyDist(vec3 p) {
  vec3 ab = uBodyHead - uBodyFeet;
  float t = clamp(dot(p - uBodyFeet, ab) / max(1.0e-5, dot(ab, ab)), 0.0, 1.0);
  return distance(p, uBodyFeet + ab * t);
}

float shellAlpha(vec3 p) {
  return uShellAlpha * (1.0 - smoothstep(uShellRadius * 0.9, uShellRadius, bodyDist(p)));
}

// THE AGE RAMP (doc/looks/blueprint.md "Palette"). Ice-white flash, hot, the signature mid, a
// slate desaturation, navy, and the permanent skeleton tone under it all. Written as sequential
// mixes because the bands are disjoint: every stage has saturated before the next one opens.
//
// The core age constants are BAND EDGES, not the instants a tone is reached: AGE_FLASH closes the
// flash, AGE_HOT closes the hot band, AGE_MID closes the signature band. So each tone has to be
// standing by the time its band OPENS — the signature mid arrives at AGE_HOT and then holds for
// the nine seconds that are the band named after it. A ramp that only reached mid at AGE_MID would
// spend the whole readable life of a ping in ice-white, and Blueprint would have no blue in it.
float slateOf(float mid, float cool) { return mix(mid, cool, uSlateAt); }

vec3 ageInk(float age) {
  float slateAge = slateOf(uAgeMid, uAgeCool);
  vec3 c = uCFlash;
  c = mix(c, uCHot,   smoothstep(0.0,      uFlashS,      age));
  c = mix(c, uCMid,   smoothstep(uFlashS,  uAgeHot,      age));
  c = mix(c, uCSlate, smoothstep(uAgeMid,  slateAge,     age));
  c = mix(c, uCCool,  smoothstep(slateAge, uAgeCool,     age));
  c = mix(c, uCSkel,  smoothstep(uAgeCool, uAgeSkeleton, age));
  return c;
}

// The line work walks the SAME ramp a beat behind, and stops one stop short of the bottom: an old
// room is "a pure navy line drawing" (doc/looks/blueprint.md), not an invisible one. A hold's cold
// end is the slate rather than the navy, so the order holds > edges > dots survives every age —
// and it survives it in weight and terminals too, never in hue alone (vision §12).
vec3 lineInk(vec3 base, float hold, float age) {
  float slateAge = slateOf(uAgeMid, uAgeCool);
  vec3 c = base;
  c = mix(c, uCMid,   smoothstep(uAgeHot, uAgeMid,  age));
  c = mix(c, uCSlate, smoothstep(uAgeMid, slateAge, age));
  c = mix(c, mix(uCCool, uCSlate, hold), smoothstep(slateAge, uAgeCool, age));
  return c;
}

// The plotter head (doc/looks/blueprint.md "Rim"): a hairline front with NO tail. Under
// reduce-flashing the same information arrives as a 120 ms ease instead of a crisp front, so the
// mark still exists for a player who cannot take the flash (vision §12).
float rimFront(float age) {
  float hard = 1.0 - smoothstep(uRimWindow * 0.55, uRimWindow, age);
  float soft = 1.0 - smoothstep(0.0, uRimEase, age);
  return mix(hard, soft, uCalm);
}
`;

// ---------------------------------------------------------------------------------------------
// Dots — fine graph paper wrapped over surfaces
// ---------------------------------------------------------------------------------------------

const DOT_VERT = /* glsl */ `
attribute float dither;
attribute float paintTime;
attribute float paintIntensity;

uniform float uSpacing;
uniform float uPixelRatio;
uniform float uSplatMin;
uniform float uSplatNear;
uniform float uSplatCap;
uniform float uLead;
uniform float uSnap;
uniform float uSkelThin;
uniform float uSkirt;

varying vec3  vColor;
varying float vAlpha;

${COMMON}

// Clip-space nowhere. Safe for a POINT: one rasteriser reject and nothing else.
#define CULL() { vColor = vec3(0.0); vAlpha = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

void main() {
  float camDist = distance(position, uCamPos);
  // The hard window (vision §3.6). A cut, not a fade: outside it there is no world.
  if (camDist > uWindowRadius || abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  float shell = shellAlpha(position);
  float age = uNow - paintTime;

  // LINES LEAD. A dot does not exist until the plot has moved past it — the whole school in one
  // subtraction. The wavefront under it is already real: core writes a surfel's paintTime as the
  // sound REACHES it, so a detonation blooms outward because the dots arrive over ten frames.
  float dotAge = age - uLead;
  float lit = (paintTime > ${SENTINEL} && dotAge >= 0.0) ? 1.0 : 0.0;
  if (lit < 0.5 && shell <= 0.003) CULL()

  // ...and it registers rather than flares: a 60 ms ease in alpha and size, and no overshoot.
  float snap = lit > 0.5 ? smoothstep(0.0, 1.0, clamp(dotAge / uSnap, 0.0, 1.0)) : 1.0;

  float cool = smoothstep(uFlashS, uAgeSkeleton, age);
  float body = mix(0.55, 1.0, paintIntensity);
  float alpha = lit * max(uSkeletonAlpha, mix(1.0, uSkeletonAlpha, cool) * body) * snap;

  // AGE THINS THE CLOUD; edges never thin (doc/looks/blueprint.md "Edges & aging"). Tested against
  // each dot's own STABLE dither, so the survivors are the same dots frame after frame — a lattice
  // that reshuffles is unreadable at 6 m/s and does not survive stream compression (vision §12).
  // What is left when a room has fully cooled is its line work: a navy architectural drawing.
  if (lit > 0.5 && dither > mix(1.0, uSkelThin, cool) * body) alpha = 0.0;

  // Distance discipline (vision §12): dots dim and thin toward the cut, so the far read is a
  // drawing and the near read is a cloud.
  float far = smoothstep(uFarBias, uWindowRadius, camDist);
  if (dither > 1.0 - far) alpha = 0.0;
  alpha *= 1.0 - 0.6 * far;

  vec3 ink = uCContact;
  if (lit > 0.5) {
    ink = ageInk(age);
    float rim = rimFront(age);
    ink = mix(ink, uCRim, rim);
    alpha = max(alpha, rim * 0.9);
  }

  // Contact geometry (vision §3.1): the only thing visible without sound. Its DIMNESS is carried
  // by alpha — at 0.05 a dark ink rounds to black in 8 bits and the shell disappears entirely.
  if (shell > alpha) { alpha = shell; ink = uCContact; }
  if (alpha <= 0.003) CULL()

  // The splat is the projected footprint of the dot's lattice cell, floored so it survives stream
  // compression and capped so the near field stays graph paper instead of a sheet of touching
  // discs (visual-brief §2; that moiré is one of this brief's explicit don'ts). Foreshortening:
  // the cell is a square in the SURFACE, so on screen it covers an ellipse; a round sprite is drawn
  // at the equal-area radius or every grazing wall fuses into a solid.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 toCam = normalize(uCamPos - position);
  float foot = uProjScale * uSpacing / max(0.05, -mv.z);
  foot *= sqrt(clamp(abs(dot(normal, toCam)), 0.15, 1.0));
  float floorPx = mix(uSplatNear, uSplatMin, far);
  float size = clamp(foot, floorPx, max(uSplatCap, floorPx)) * mix(0.74, 1.0, snap);

  vColor = ink;
  vAlpha = alpha;
  gl_Position = projectionMatrix * mv;
  // Drawn at the skirt's size; the fragment keeps the SOLID core at the footprint the floors ask
  // for and spends only the outer ring on the brief's "1.2x skirt of minimal glow".
  gl_PointSize = size * uSkirt * uPixelRatio;
}
`;

const DOT_FRAG = /* glsl */ `
uniform float uSE;
uniform float uInvSE;
uniform float uCoreFrac;

varying vec3  vColor;
varying float vAlpha;

void main() {
  // Round-square: a superellipse, never a hard square. A square lattice of square dots is a screen
  // door and it crawls; a circle loses the grid read the school is built on. |x|^n + |y|^n = 1.
  vec2 d = (gl_PointCoord - vec2(0.5)) * 2.0;
  float e = pow(pow(abs(d.x), uSE) + pow(abs(d.y), uSE), uInvSE);
  if (e > 1.0) discard;

  // Solid core, then a faint skirt out to the sprite edge. Blueprint never flares: the skirt is
  // 22 % ink and it is the entire glow budget of the look.
  float core = 1.0 - smoothstep(uCoreFrac * 0.78, uCoreFrac, e);
  float skirt = 1.0 - smoothstep(uCoreFrac, 1.0, e);
  float a = vAlpha * max(core, skirt * 0.22);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

// ---------------------------------------------------------------------------------------------
// Lines — the school's core
// ---------------------------------------------------------------------------------------------

/**
 * `uMode` picks which of the three line jobs a pass is doing, so one program serves all five
 * LineSegments:
 *
 *   0  CORE   the stroke itself, on the segment; white on a hold, ice-blue on an edge
 *   1  SKIRT  the same stroke offset a real screen-space perpendicular — this is line WEIGHT
 *   2  TICK   a dimension terminal across one end of a hold
 */
const LINE_VERT = /* glsl */ `
attribute float flagsHold;
attribute float paintTime;
attribute float paintIntensity;
attribute vec3  aTan;
attribute float aEnd;

uniform float uSkeletonAlphaEdge;
uniform float uMode;
uniform float uSide;
uniform float uTickEnd;
uniform float uTickLen;
uniform float uTickMinPx;
uniform float uWNear;
uniform float uWFar;
uniform float uWFalloff;
uniform float uLead;
uniform float uLift;
uniform float uRimBoost;
uniform vec3  uCEdge;
uniform vec3  uCHold;

varying vec3  vColor;
varying float vAlpha;
varying float vT;
varying float vWipe;

${COMMON}

// The ONLY cull in this shader, and it is deliberately one both vertices of a segment compute
// identically (see the file header on streaks).
#define CULL() { vColor = vec3(0.0); vAlpha = 0.0; vT = 0.0; vWipe = 1.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

void main() {
  vec3 mid = position + aTan * (0.5 - aEnd);
  float camDist = distance(mid, uCamPos);
  if (camDist > uWindowRadius || abs(mid.y - uFloorCentre) > uFloorSpan) CULL()

  float hold = step(0.5, flagsHold);
  float age = uNow - paintTime;
  float lit = (paintTime > ${SENTINEL} && age >= 0.0) ? 1.0 : 0.0;

  // EDGES DIM, THEY NEVER THIN. There is no dither test in this shader on purpose: what survives a
  // cold room is its complete line work at the skeleton floor (doc/looks/blueprint.md).
  float cool = smoothstep(uFlashS, uAgeSkeleton, age);
  float floorA = mix(uSkeletonAlpha, uSkeletonAlphaEdge, hold);
  float alpha = lit * max(floorA, mix(1.0, floorA, cool) * mix(0.6, 1.0, paintIntensity));

  // Edge-biased retention (vision §12): a line keeps far more of its strength at range than a dot
  // does, which is what turns the far field into a drawing rather than a haze.
  alpha *= 1.0 - 0.25 * smoothstep(uFarBias, uWindowRadius, camDist);
  // The contact shell reaches holds too: a rail a metre from your body is contact geometry.
  alpha = max(alpha, shellAlpha(position));

  // An edge is brighter than any dot of equal age; a hold is brighter still and takes the white
  // core. A skirt is ALWAYS the edge ink, so a hold reads as a white line in an ice-blue skirt —
  // brightness plus stroke plus terminals, never hue alone (vision §12).
  vec3 ink = lineInk(uMode < 0.5 ? mix(uCEdge, uCHold, hold) : uCEdge, hold, age);
  float rim = lit * rimFront(age);
  ink = mix(ink, uCRim, rim);
  alpha = min(1.0, alpha * (1.0 + uRimBoost * rim));

  // Weight: hairline far, heavier near, and a hold heavier than an edge. A skirt pass only earns
  // the ink that the weight above one pixel asks for, so a far hairline has almost no skirt.
  float nearT = clamp(camDist / uWFalloff, 0.0, 1.0);
  float w = mix(uWNear, uWFar, nearT) * mix(1.0, 1.3, hold);
  if (uMode > 0.5 && uMode < 1.5) alpha *= clamp(w * 0.5 - 0.5, 0.0, 1.0) * 0.85;

  // The screen-space perpendicular, done in VIEW space: a metre at this depth is
  // -mv.z / uProjScale pixels wide, so an offset in metres is an exact offset in pixels and needs
  // no divide by w and no viewport round-trip.
  float tl = length(aTan);
  vec3 tv = tl > 1.0e-6 ? normalize(mat3(modelViewMatrix) * aTan) : vec3(1.0, 0.0, 0.0);
  float wipe = clamp(age / uLead, 0.0, 1.0);

  vec4 mv;
  if (uMode > 1.5) {
    // A dimension terminal: both vertices of the segment collapse onto ONE of its ends and step out
    // either side of the line. It lands as the pen reaches that end, not before — and "not yet",
    // "not a hold" and "never painted" are all alpha, never a cull, so a tick can never streak.
    mv = modelViewMatrix * vec4(position + aTan * (uTickEnd - aEnd), 1.0);
    if (hold < 0.5 || lit < 0.5 || wipe < uTickEnd * 0.97 + 0.02) alpha = 0.0;
    vec3 cr = cross(tv, normalize(-mv.xyz));
    float cl = length(cr);
    vec3 perp = cl > 1.0e-4 ? cr / cl : vec3(1.0, 0.0, 0.0);
    float tick = max(uTickMinPx, uTickLen * mix(1.0, 0.62, nearT));
    mv.xyz += perp * (aEnd < 0.5 ? -1.0 : 1.0) * tick * (max(0.05, -mv.z) / max(1.0, uProjScale));
    vT = 0.0;
    vWipe = 1.0;
  } else {
    mv = modelViewMatrix * vec4(position, 1.0);
    if (uMode > 0.5) {
      vec3 cr = cross(tv, normalize(-mv.xyz));
      float cl = length(cr);
      vec3 perp = cl > 1.0e-4 ? cr / cl : vec3(1.0, 0.0, 0.0);
      mv.xyz += perp * uSide * (w * 0.5) * (max(0.05, -mv.z) / max(1.0, uProjScale));
    }
    // THE WIPE. vT runs 0 → 1 along the segment and the fragment keeps only what the plot has
    // already reached, so a freshly painted line draws itself along its own length in EDGE_LEAD_MS.
    vT = aEnd;
    vWipe = wipe;
  }

  mv.z += uLift; // toward the camera: a crease line sits ON the surfels it creases
  vColor = ink;
  vAlpha = alpha;
  gl_Position = projectionMatrix * mv;
}
`;

const LINE_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;
varying float vT;
varying float vWipe;

void main() {
  if (vAlpha <= 0.004) discard;
  if (vT > vWipe) discard;
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

// ---------------------------------------------------------------------------------------------

/** One uniform block. Every material gets its own copy — uniforms are per material in three. */
const commonUniforms = (k: CoreConstants, calm: boolean): Uniforms => ({
  uNow: { value: 0 },
  uCamPos: { value: [0, 0, 0] },
  uFloorCentre: { value: 0 },
  uFloorSpan: { value: 0 },
  uWindowRadius: { value: k.WINDOW_RADIUS },
  uFarBias: { value: k.FAR_BIAS_START },
  uAgeHot: { value: k.AGE_HOT },
  uAgeMid: { value: k.AGE_MID },
  uAgeCool: { value: k.AGE_COOL },
  uAgeSkeleton: { value: k.AGE_SKELETON },
  uSkeletonAlpha: { value: k.SKELETON_ALPHA },
  uShellRadius: { value: k.CONTACT_SHELL_RADIUS },
  uShellAlpha: { value: k.CONTACT_SHELL_ALPHA },
  uBodyFeet: { value: [0, 0, 0] },
  uBodyHead: { value: [0, 0, 0] },
  uFlashS: { value: Math.min(FLASH_S, k.AGE_FLASH) },
  uSlateAt: { value: SLATE_AT },
  uRimWindow: { value: k.RIM_WINDOW },
  uRimEase: { value: RIM_EASE_CALM },
  uCalm: { value: calm ? 1 : 0 },
  uProjScale: { value: 500 },
  uCFlash: { value: PALETTE.flash },
  uCHot: { value: PALETTE.hot },
  uCMid: { value: PALETTE.mid },
  uCSlate: { value: PALETTE.slate },
  uCCool: { value: PALETTE.cool },
  uCSkel: { value: PALETTE.skeleton },
  uCRim: { value: PALETTE.rim },
  uCContact: { value: PALETTE.contact },
});

const setU = (m: ShaderMaterial, name: string, v: unknown): void => {
  const u = m.uniforms[name];
  if (u) u.value = v;
};

/** The five attributes this look BORROWS from `edgeGeom` and must never dispose. */
const BORROWED = ['position', 'dither', 'flagsHold', 'paintTime', 'paintIntensity'] as const;

export class MatterLayer {
  private readonly dotMat: ShaderMaterial;
  private readonly mats: ShaderMaterial[] = [];
  private readonly objects: (Points | LineSegments)[] = [];
  /** Look-owned: shares core's attribute instances, adds `aTan` / `aEnd`. */
  private readonly lineGeom = new BufferGeometry();
  private waveSpeed = Infinity;
  private viewH = 1000;

  constructor(
    scene: Scene,
    surfelGeom: BufferGeometry,
    edgeGeom: BufferGeometry,
    k: CoreConstants,
    calm: boolean,
  ) {
    // --- dots -----------------------------------------------------------------------------------
    this.dotMat = new ShaderMaterial({
      uniforms: {
        ...commonUniforms(k, calm),
        uSpacing: { value: k.SURFEL_SPACING },
        uPixelRatio: { value: 1 },
        uSplatMin: { value: k.SPLAT_MIN_PX },
        uSplatNear: { value: k.SPLAT_NEAR_PX },
        uSplatCap: { value: DOT_CAP_FRAC * this.viewH },
        uLead: { value: EDGE_LEAD_MS / 1000 },
        uSnap: { value: DOT_SNAP_MS / 1000 },
        uSkelThin: { value: SKELETON_THIN },
        uSkirt: { value: DOT_SKIRT },
        uSE: { value: DOT_SUPERELLIPSE },
        uInvSE: { value: 1 / DOT_SUPERELLIPSE },
        uCoreFrac: { value: 1 / DOT_SKIRT },
      },
      vertexShader: DOT_VERT,
      fragmentShader: DOT_FRAG,
      transparent: true,
      depthTest: true,
      // Dots DO write depth: a near surface must hide the room behind it, or the memory skeleton of
      // the next room reads as if it were in this one.
      depthWrite: true,
    });
    this.mats.push(this.dotMat);
    const dots = new Points(surfelGeom, this.dotMat);
    dots.frustumCulled = false; // one object holds the whole floor; the shader does the culling
    this.objects.push(dots);

    // --- the look-owned edge geometry -------------------------------------------------------------
    for (const name of BORROWED) this.lineGeom.setAttribute(name, edgeGeom.getAttribute(name));
    const verts = edgeGeom.getAttribute('position').count;
    const segs = Math.floor(verts / 2);
    const tan = new Float32Array(verts * 3);
    const end = new Float32Array(verts);
    const pos = edgeGeom.getAttribute('position').array as ArrayLike<number>;
    for (let s = 0; s < segs; s++) {
      const a = s * 6;
      // The FULL segment vector, written on BOTH of its vertices: each end can then reconstruct the
      // other end, the midpoint (a cull both agree on) and the direction (the perpendicular).
      const dx = pos[a + 3]! - pos[a]!;
      const dy = pos[a + 4]! - pos[a + 1]!;
      const dz = pos[a + 5]! - pos[a + 2]!;
      tan[a] = dx;
      tan[a + 1] = dy;
      tan[a + 2] = dz;
      tan[a + 3] = dx;
      tan[a + 4] = dy;
      tan[a + 5] = dz;
      end[s * 2] = 0;
      end[s * 2 + 1] = 1;
    }
    this.lineGeom.setAttribute('aTan', new BufferAttribute(tan, 3));
    this.lineGeom.setAttribute('aEnd', new BufferAttribute(end, 1));
    this.lineGeom.setDrawRange(0, verts);

    // --- the line passes, in plot order ------------------------------------------------------------
    const pass = (mode: number, side: number, tickEnd: number, order: number): void => {
      const m = new ShaderMaterial({
        uniforms: {
          ...commonUniforms(k, calm),
          uSkeletonAlphaEdge: { value: k.SKELETON_ALPHA_EDGE },
          uMode: { value: mode },
          uSide: { value: side },
          uTickEnd: { value: tickEnd },
          uTickLen: { value: TICK_LEN },
          uTickMinPx: { value: TICK_MIN_PX },
          uWNear: { value: LINE_W_NEAR },
          uWFar: { value: LINE_W_FAR },
          uWFalloff: { value: LINE_W_FALLOFF_M },
          uLead: { value: EDGE_LEAD_MS / 1000 },
          uLift: { value: LINE_LIFT },
          uRimBoost: { value: RIM_EDGE_BOOST },
          uCEdge: { value: PALETTE.edge },
          uCHold: { value: PALETTE.holdCore },
        },
        vertexShader: LINE_VERT,
        fragmentShader: LINE_FRAG,
        transparent: true,
        depthTest: true,
        // Line work never occludes the cloud it annotates; it is read THROUGH.
        depthWrite: false,
      });
      const o = new LineSegments(this.lineGeom, m);
      o.frustumCulled = false;
      o.renderOrder = order;
      this.mats.push(m);
      this.objects.push(o);
    };
    pass(1, +1, 0, 1); // skirt, one side
    pass(1, -1, 0, 1); // skirt, the other
    pass(0, 0, 0, 2); // the core stroke, over its own skirt
    pass(2, 0, 0, 3); // dimension terminal at the segment's start
    pass(2, 0, 1, 3); // ...and at its end

    for (const o of this.objects) scene.add(o);
  }

  /**
   * The rim is a shell of constant THICKNESS behind the wavefront, and the only thing a shader can
   * test is arrival TIME — so the metres become seconds against the speed of the wave in flight.
   */
  setWaveSpeed(speed: number): void {
    this.waveSpeed = speed;
  }

  update(f: BlueprintFrame, feet: number[]): void {
    const rimWindow = Number.isFinite(this.waveSpeed)
      ? Math.min(RIM_MAX_S, Math.max(RIM_ZONE_M / this.waveSpeed, FRAME_S * RIM_MIN_FRAMES))
      : Math.min(RIM_MAX_S, FRAME_S * RIM_MIN_FRAMES);

    for (const m of this.mats) {
      setU(m, 'uNow', f.now);
      setU(m, 'uCamPos', f.camPos);
      setU(m, 'uBodyFeet', feet);
      setU(m, 'uBodyHead', f.camPos);
      setU(m, 'uFloorCentre', f.floorCentre);
      setU(m, 'uFloorSpan', f.floorSpan);
      setU(m, 'uProjScale', f.projScale);
      setU(m, 'uRimWindow', rimWindow);
    }
  }

  resize(h: number, pixelRatio: number): void {
    this.viewH = Math.max(1, h);
    setU(this.dotMat, 'uPixelRatio', pixelRatio);
    // CSS px, like every other term in the size math — the DPR multiply happens once, in the shader.
    setU(this.dotMat, 'uSplatCap', this.capPx);
  }

  /** The dot cap in CSS px, so the event layer can hold its marks to the same ceiling. */
  get capPx(): number {
    return DOT_CAP_FRAC * this.viewH;
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    this.mats.length = 0;
    // The five BORROWED attributes are core's and hold the run's paint. three frees a geometry's
    // GPU buffers by walking `geometry.attributes`, so they are removed from this geometry FIRST
    // and only `aTan` / `aEnd` are actually released here.
    for (const name of BORROWED) this.lineGeom.deleteAttribute(name);
    this.lineGeom.dispose();
    this.objects.length = 0;
  }
}
