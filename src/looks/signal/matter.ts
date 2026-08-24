/**
 * SIGNAL — the matter layer: the lattice of square samples, the edge lines and the dashed holds.
 *
 * The world as a transmission being decoded (signal.md "Fantasy"). Three objects over the two
 * SHARED geometries, four materials, and no allocation after construction.
 *
 * WHAT IS LAW HERE rather than styling (engine-plan §9, vision §3, §12):
 *
 *   - Absence is black. Nothing is drawn that sound has not reached, except the 2 m contact shell.
 *   - Age is temperature and the ramp is cyan-family end to end. Depth cues live only in that band.
 *   - The hard window is a CUT at 45 m and +/-1 floor, never a fade.
 *   - Distance discipline: dots thin and dim past ~20 m, lines keep far more of their strength, so
 *     the far read biases to edges — "distance reads as a drawing, nearby as a cloud".
 *   - Dots are matter, lines are holds. The hold accent is brightness + a second stroke + the dash
 *     pattern: shape and weight, never hue alone.
 *   - Thinning is ordered by each element's own stable `dither`, never by a random draw, so the
 *     survivors do not flicker and a rescan refreshes in place.
 *
 * SIGNAL'S OWN DRESSING on top of that: square samples with a dark-cyan underlay cell, the two-step
 * decode resolve, the posterized hot -> mid cooling, age thinning into "low-bitrate memory", the
 * white rim with a chroma-only fringe on its leading edge, and the 6/2 px screen-space dash on
 * holds. Every one of those is switchable or dropped under reduce-flashing (vision §12).
 */

import { LineSegments, Points, ShaderMaterial } from 'three';
import type { LookContext } from '../types.js';
import { BODY_SHELL, CULL_LINE, CULL_POINT, IGN, MATTER_RAMP, NEVER_PAINTED, ROUND_BOX } from './glsl.js';
import * as P from './params.js';

export interface MatterFrame {
  readonly now: number;
  readonly camPos: readonly [number, number, number];
  readonly bodyFeet: readonly [number, number, number];
  readonly projScale: number;
  readonly pixelRatio: number;
  readonly floorCentre: number;
  readonly floorSpan: number;
}

/** The live E-ping cone, for the rim's directional density. Zeroed when no beam is in flight. */
export interface ConeState {
  readonly origin: readonly [number, number, number];
  readonly dir: readonly [number, number, number];
  /** cos of the HALF angle. */
  readonly cosHalf: number;
  /** Emission time, and the instant the wavefront has left the cone's far end. */
  readonly from: number;
  readonly until: number;
}

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
uniform float uSkeletonAlpha;
uniform float uRimWindow;
uniform float uAgeThin;
uniform float uSpacing;
uniform float uProjScale;
uniform float uPixelRatio;
uniform float uSplatMin;
uniform float uSplatNear;
uniform float uSampleCap;
uniform float uUnderlayScale;
uniform float uCalm;
uniform float uDecode;
uniform float uPreviewFrac;
uniform float uPreviewScale;
uniform float uPreviewDensity;
uniform float uFringeFrac;
uniform vec3  uRimColor;
uniform vec3  uShellColor;
uniform vec3  uConeOrigin;
uniform vec3  uConeDir;
uniform float uConeCos;
uniform float uConeFrom;
uniform float uConeUntil;
uniform float uConeDensity;

varying vec3  vColor;
varying float vAlpha;
varying float vSizePx;
varying float vFringe;

${CULL_POINT}
${MATTER_RAMP}
${BODY_SHELL}

void main() {
  float camDist = distance(position, uCamPos);

  // The hard window (vision §3.6). A cut, not a fade: outside it there is no world.
  if (camDist > uWindowRadius || abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // The wavefront is WRITE-timed: core paints a surfel when the sound reaches it and never
  // before, so a ping resolves outward because the dots ARRIVE over ten frames. The age test is
  // the assertion that the invariant holds — a future paintTime would blank a surface the player
  // already owned, and a silent hole is the hardest kind of bug to see.
  float age = uNow - paintTime;
  float lit = (paintTime > ${NEVER_PAINTED.toExponential()} && age >= 0.0) ? 1.0 : 0.0;

  // --- decode resolve (signal.md "Dots") -------------------------------------------------------
  // Two steps inside uDecode: an ordered quarter-density preview at double size, then the full
  // lattice at true size. The preview is chosen by each dot's own stable dither, so the same
  // samples always lead the decode and the burst is a coarse READ rather than a random sparkle.
  // Quarter density at double size is equal coverage — coarser, not dimmer.
  //
  // The dots the preview does not carry are NOT hidden: they draw at the memory-skeleton floor
  // for those few milliseconds and then lock in. Hiding them would blink an already-owned surface
  // to nothing every time it was rescanned, which is exactly the "glitch at rest" the brief bans.
  float sizeGain = 1.0;
  float calmEase = 1.0;
  float holdBack = -1.0; // >= 0: this dot is still waiting for the lattice to lock in
  if (lit > 0.5 && age < uDecode) {
    if (uCalm > 0.5) {
      calmEase = clamp(age / max(1.0e-4, uDecode), 0.0, 1.0); // plain ease, true size
    } else if (age < uDecode * uPreviewFrac) {
      float dens = uPreviewDensity;
      // Denser along a live E-ping's axis — the beam reads directional. The test is the real cone
      // of the real event against dots the real wavefront has just reached; nothing is invented.
      if (uConeUntil > uConeFrom && uNow <= uConeUntil && paintTime >= uConeFrom) {
        vec3 toP = position - uConeOrigin;
        float l = length(toP);
        if (l > 1.0e-3 && dot(toP / l, uConeDir) > uConeCos) dens *= uConeDensity;
      }
      if (dither <= dens) sizeGain = uPreviewScale;
      else holdBack = uSkeletonAlpha * 0.75;
    }
  }

  // Age -> alpha, with the permanent memory-skeleton floor under it (vision §3.6).
  float cool = smoothstep(uAgeFlash, uAgeSkeleton, age);
  float aged = mix(1.0, uSkeletonAlpha, cool);
  float alpha = lit * max(uSkeletonAlpha, aged * mix(0.55, 1.0, paintIntensity));

  // Distance discipline plus Signal's age thinning ("low-bitrate memory: sparse squares + intact
  // edges"). Both drop dots in the SAME stable dither order, so an old far surface thins once
  // rather than twice and the survivors are the same dots at every range.
  float far = smoothstep(uFarBias, uWindowRadius, camDist);
  float thin = uAgeThin * smoothstep(uAgeMid, uAgeSkeleton, age);
  float keep = (1.0 - far) * (1.0 - thin);
  float survives = dither > keep ? 0.0 : 1.0;
  alpha *= survives * (1.0 - 0.6 * far);

  // --- colour ----------------------------------------------------------------------------------
  vec3 c = matterRamp(age);
  // The racing rim (visual-brief §1.11): the one element allowed to be pure white. The ramp tops
  // out a step under it, so "2x brightness" is real headroom and not a saturated clip. The boost
  // only reaches dots that survived thinning — a rim that resurrects culled dots would make the
  // far field flash to full density every time a sound arrived.
  float rim = lit * (1.0 - smoothstep(0.0, uRimWindow, max(age, 0.0)));
  c = mix(c, uRimColor, rim * rim);
  alpha = max(alpha, lit * rim * survives * (1.0 - far));

  if (holdBack >= 0.0) alpha = min(alpha, holdBack);
  alpha *= calmEase;

  // Contact shell (vision §3.1): the only geometry visible without sound. Faint, 2 m, always on.
  float shell = shellAlpha(position);
  if (shell > alpha) {
    alpha = shell;
    c = uShellColor;
    rim = 0.0;
  }
  if (alpha <= 0.003) CULL()

  // The chroma fringe lives on the rim's LEADING edge only, is chroma-only, and drops entirely
  // under reduce-flashing (signal.md "Rim", vision §12).
  vFringe = (uCalm > 0.5) ? 0.0
    : lit * (1.0 - smoothstep(0.0, max(1.0e-4, uRimWindow * uFringeFrac), max(age, 0.0)));

  // A splat is drawn at the projected footprint of its lattice cell, bounded above by uSampleCap
  // (visual-brief §2 "Near field: dots stay dots"). The px constants are FLOORS on the same
  // footprint — a sub-pixel dot dies in stream compression. The floor is raised OVER the cap
  // rather than assumed to sit under it: GLSL leaves clamp undefined when lo > hi, and the two
  // operands are owned by different modules.
  //
  // Foreshortening: the cell is a square in the SURFACE, so it covers an ellipse on screen. A
  // square sprite cannot be that ellipse, so it is drawn at the equal-area size, a*sqrt(|n.v|).
  // Without this every grazing surface overlaps itself into a solid sheet.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 toCam = normalize(uCamPos - position);
  float foot = uProjScale * uSpacing / max(0.05, -mv.z);
  foot *= sqrt(clamp(abs(dot(normal, toCam)), 0.15, 1.0));
  float floorPx = mix(uSplatNear, uSplatMin, far);
  float samplePx = clamp(foot, floorPx, max(uSampleCap, floorPx)) * sizeGain;

  vColor = c;
  vAlpha = alpha;
  vSizePx = samplePx * uUnderlayScale * uPixelRatio;

  gl_Position = projectionMatrix * mv;
  gl_PointSize = vSizePx;
}
`;

const DOT_FRAG = /* glsl */ `
uniform float uCorner;
uniform float uSoftPx;
uniform float uUnderTint;
uniform float uUnderAlpha;
uniform float uSampleHalf;
uniform float uFringePx;
uniform float uFringeAmt;
uniform float uDither;
uniform float uPixelRatio;

varying vec3  vColor;
varying float vAlpha;
varying float vSizePx;
varying float vFringe;

${ROUND_BOX}
${IGN}

void main() {
  // Sprite space: -1..1 across the UNDERLAY square, y up so the fringe axis matches the screen.
  vec2 p = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y) * 2.0;

  // "hard-ish edge, 1-px soft rim" — the softness is a fixed pixel width, so a sample looks the
  // same whether it is drawn at 3 px or at the cap.
  float aa = max(0.02, 2.0 * uSoftPx * uPixelRatio / max(2.0, vSizePx));
  float sh = uSampleHalf;

  float mU = 1.0 - smoothstep(-aa, aa, roundBox(p, 1.0, uCorner));
  if (mU <= 0.004) discard;
  float mS = 1.0 - smoothstep(-aa, aa, roundBox(p, sh, uCorner * sh));

  vec3 c = mix(vColor * uUnderTint, vColor, mS);
  float a = vAlpha * mix(uUnderAlpha, 1.0, mS) * mU;

  // Chroma-only fringe: red and blue are RESOLVED from masks a pixel either side of the sample's
  // own edge, so the split shows as colour at the boundary and never as a luminance pulse
  // (vision §12 "chroma-not-luminance pulses").
  //
  // Rebuilding the colour per channel is what makes that true, and adding a delta would not. The
  // fringe only ever runs on the rim, and the rim is #FFFFFF: a delta pushes one channel above 1
  // and the hardware clips it, so half the split lands as a BRIGHTER pixel and the other half is a
  // couple of counts of chroma nobody can see. Resolving each channel against its own offset mask
  // keeps every value inside the range that is already there — the leading edge LOSES a channel
  // instead of gaining one — so the boundary reads cool on one side and warm on the other at equal
  // brightness. Alpha stays on the un-offset mask: the fringe colours the sample, never reshapes it.
  if (vFringe > 0.0) {
    float f = uFringePx * uPixelRatio * 2.0 / max(2.0, vSizePx);
    float mR = 1.0 - smoothstep(-aa, aa, roundBox(p - vec2(f, 0.0), sh, uCorner * sh));
    float mB = 1.0 - smoothstep(-aa, aa, roundBox(p + vec2(f, 0.0), sh, uCorner * sh));
    vec3 split = vec3(
      mix(vColor.r * uUnderTint, vColor.r, mR),
      c.g,
      mix(vColor.b * uUnderTint, vColor.b, mB));
    c = mix(c, split, vFringe * uFringeAmt);
  }

  // Signed frame dither (see params.FRAME_DITHER): kills banding on the cooling ramp, and is
  // exactly zero where nothing is drawn, so the void stays #000000.
  c += (ign(gl_FragCoord.xy) - 0.5) * uDither;

  gl_FragColor = vec4(c, a);
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
uniform float uSkeletonAlpha;
uniform float uSkeletonAlphaEdge;
uniform float uRimWindow;
uniform float uHoldMode;
uniform vec2  uOffsetPx;
uniform vec2  uViewport;
uniform float uLift;
uniform float uCalm;
uniform float uDecode;
uniform vec3  uRimColor;
uniform vec3  uInk;
uniform vec3  uShellColor;

varying vec3  vColor;
varying float vAlpha;
varying float vT;

${CULL_LINE}
${MATTER_RAMP}
${BODY_SHELL}

void main() {
  // Holds and plain edges are drawn by separate passes so each can carry its own ink, weight and
  // pattern. uHoldMode 1 keeps holds, 0 keeps everything else.
  float hold = step(0.5, flagsHold);
  if (hold != uHoldMode) CULL()

  float camDist = distance(position, uCamPos);
  if (camDist > uWindowRadius || abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  float age = uNow - paintTime;
  float lit = (paintTime > ${NEVER_PAINTED.toExponential()} && age >= 0.0) ? 1.0 : 0.0;

  float cool = smoothstep(uAgeFlash, uAgeSkeleton, age);
  float floorA = mix(uSkeletonAlpha, uSkeletonAlphaEdge, hold);
  float alpha = lit * max(floorA, mix(1.0, floorA, cool) * mix(0.6, 1.0, paintIntensity));

  // Edge-biased retention (vision §12): lines keep far more of their strength at range than dots
  // do, which is what turns the far field into a drawing. Signal leans on this hard — its old
  // areas are meant to read as sparse squares over INTACT edges.
  alpha *= 1.0 - 0.3 * smoothstep(uFarBias, uWindowRadius, camDist);

  // Lines carry the same posterized cooling as the lattice, but in their OWN ink: a hold and a
  // crease must never be the same value at the same age. Brightness steps down over hot -> mid,
  // then slides continuously into the dim navy skeleton.
  float pt = clamp((age - uAgeHot) / max(1.0e-4, uAgeMid - uAgeHot), 0.0, 1.0);
  float pq = min(1.0, floor(pt * uPosterize) / max(1.0, uPosterize - 1.0));
  vec3 c = mix(uInk, uInk * 0.55, pq);
  c = mix(c, uSkel * 2.2, smoothstep(uAgeMid, uAgeSkeleton, age));
  float rim = lit * (1.0 - smoothstep(0.0, uRimWindow, max(age, 0.0)));
  c = mix(c, uRimColor, rim * rim);
  alpha = max(alpha, lit * rim);

  // Reduce-flashing turns the decode's step into a plain ease here too; lines never previewed.
  if (uCalm > 0.5 && lit > 0.5 && age < uDecode) alpha *= clamp(age / max(1.0e-4, uDecode), 0.0, 1.0);

  // The contact shell reaches holds too: a rail 1 m from your body is contact geometry.
  float shell = shellAlpha(position);
  if (shell > alpha) {
    alpha = shell;
    c = uShellColor;
  }
  if (alpha <= 0.003) CULL()

  vColor = c;
  vAlpha = alpha;
  // 0 at one end of the segment, 1 at the other. The geometry is a non-indexed LineSegments list,
  // so vertex parity IS segment parametrisation — and vT / fwidth(vT) in the fragment stage is
  // then the exact number of PIXELS from the segment's start. That is what lets the dash be
  // measured in screen space without writing a byte into the shared edge geometry.
  vT = float(gl_VertexID & 1);

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.z += uLift; // toward the camera: a crease line sits ON the surfels it creases
  gl_Position = projectionMatrix * mv;
  // gl_LineWidth is fixed at 1 in WebGL, so "thicker" is a second offset pass over the same
  // geometry. The offset is screen-space, so it holds at every distance.
  gl_Position.xy += uOffsetPx * (2.0 / uViewport) * gl_Position.w;
}
`;

const LINE_FRAG = /* glsl */ `
uniform float uDashOn;
uniform float uDashOff;
uniform float uDither;
uniform float uPixelRatio;

varying vec3  vColor;
varying float vAlpha;
varying float vT;

${IGN}

void main() {
  float a = vAlpha;

  // Screen-space dash (signal.md: 6 px lit, 2 px gap) — "makes grabbable lips read as active
  // without animation". Measured in real pixels: fwidth(vT) is 1/segmentLengthInPixels, so
  // vT/fwidth(vT) is the pixel distance along the segment. A segment shorter than one period
  // degenerates to a solid stroke, which is the correct answer for a lip a metre away.
  if (uDashOn > 0.0) {
    float w = fwidth(vT);
    if (w > 1.0e-6) {
      float px = (vT / w) / uPixelRatio;
      float period = uDashOn + uDashOff;
      float phase = mod(px, period);
      // Half a pixel of feather on the trailing edge: a hard step here crawls as the line swings.
      a *= smoothstep(-0.5, 0.5, uDashOn - phase);
    }
  }
  if (a <= 0.003) discard;

  vec3 c = vColor + (ign(gl_FragCoord.xy) - 0.5) * uDither;
  gl_FragColor = vec4(c, a);
}
`;

type Uniforms = Record<string, { value: unknown }>;

/** The palette as plain arrays, allocated once — a uniform upload must not allocate per frame. */
const PALETTE_ARR = {
  flash: [...P.PALETTE.flash],
  hot: [...P.PALETTE.hot],
  mid: [...P.PALETTE.mid],
  cool: [...P.PALETTE.cool],
  skeleton: [...P.PALETTE.skeleton],
  edge: [...P.PALETTE.edge],
  hold: [...P.PALETTE.hold],
  rim: [...P.PALETTE.rim],
  shell: [...P.PALETTE.shell],
} as const;

const NO_CONE: ConeState = {
  origin: [0, 0, 0],
  dir: [0, 0, 1],
  cosHalf: 2,
  from: 0,
  until: -1,
};

/**
 * The three matter passes. One Points over the surfel geometry and three LineSegments over the
 * edge geometry (plain edges once, holds twice at opposite sub-pixel offsets for weight).
 *
 * Shared-geometry discipline: this class creates materials and objects and disposes exactly
 * those. `ctx.surfelGeom` / `ctx.edgeGeom` hold the run's paint and belong to core.
 */
export class MatterLayer {
  readonly dots: Points;
  readonly edges: LineSegments;
  readonly holdsA: LineSegments;
  readonly holdsB: LineSegments;

  private readonly dotMat: ShaderMaterial;
  private readonly lineMats: ShaderMaterial[] = [];
  private readonly allMats: ShaderMaterial[] = [];
  private readonly camPos: [number, number, number] = [0, 0, 0];
  private readonly feet: [number, number, number] = [0, 0, 0];
  private readonly coneOrigin: [number, number, number] = [0, 0, 0];
  private readonly coneDir: [number, number, number] = [0, 0, 1];
  private readonly viewport: [number, number] = [1, 1];
  private cone: ConeState = NO_CONE;
  private viewH = 1;

  constructor(ctx: LookContext) {
    const k = ctx.constants;
    const calm = ctx.reduceFlashing();

    const ramp = (): Uniforms => ({
      uFlash: { value: PALETTE_ARR.flash },
      uHot: { value: PALETTE_ARR.hot },
      uMid: { value: PALETTE_ARR.mid },
      uCool: { value: PALETTE_ARR.cool },
      uSkel: { value: PALETTE_ARR.skeleton },
      uAgeFlash: { value: k.AGE_FLASH },
      uAgeHot: { value: k.AGE_HOT },
      uAgeMid: { value: k.AGE_MID },
      uAgeCool: { value: k.AGE_COOL },
      uAgeSkeleton: { value: k.AGE_SKELETON },
      uPosterize: { value: P.POSTERIZE_STEPS },
    });

    const shared = (): Uniforms => ({
      ...ramp(),
      uNow: { value: 0 },
      uCamPos: { value: this.camPos },
      uFloorCentre: { value: ctx.floorCentre },
      uFloorSpan: { value: ctx.floorSpan },
      uWindowRadius: { value: k.WINDOW_RADIUS },
      uFarBias: { value: k.FAR_BIAS_START },
      uSkeletonAlpha: { value: k.SKELETON_ALPHA },
      uRimWindow: { value: k.RIM_WINDOW },
      uShellRadius: { value: k.CONTACT_SHELL_RADIUS },
      uShellAlpha: { value: k.CONTACT_SHELL_ALPHA },
      uBodyFeet: { value: this.feet },
      uBodyHead: { value: this.camPos },
      uRimColor: { value: PALETTE_ARR.rim },
      uShellColor: { value: PALETTE_ARR.shell },
      uCalm: { value: calm ? 1 : 0 },
      uDecode: { value: P.DECODE_MS / 1000 },
      uDither: { value: P.FRAME_DITHER },
      uPixelRatio: { value: 1 },
    });

    this.dotMat = new ShaderMaterial({
      uniforms: {
        ...shared(),
        uAgeThin: { value: P.AGE_THIN_MAX },
        uSpacing: { value: k.SURFEL_SPACING },
        uProjScale: { value: 500 },
        uSplatMin: { value: k.SPLAT_MIN_PX },
        uSplatNear: { value: k.SPLAT_NEAR_PX },
        uSampleCap: { value: P.DOT_SAMPLE_CAP_FRAC * this.viewH },
        uUnderlayScale: { value: P.DOT_UNDERLAY_SCALE },
        uPreviewFrac: { value: P.DECODE_PREVIEW_FRAC },
        uPreviewScale: { value: P.DECODE_PREVIEW_SCALE },
        uPreviewDensity: { value: P.DECODE_PREVIEW_DENSITY },
        uFringeFrac: { value: P.RIM_FRINGE_FRAC },
        uConeOrigin: { value: this.coneOrigin },
        uConeDir: { value: this.coneDir },
        uConeCos: { value: 2 },
        uConeFrom: { value: 0 },
        uConeUntil: { value: -1 },
        uConeDensity: { value: P.RIM_CONE_DENSITY },
        uCorner: { value: P.DOT_CORNER },
        uSoftPx: { value: P.DOT_SOFT_PX },
        uUnderTint: { value: P.DOT_UNDERLAY_TINT },
        uUnderAlpha: { value: P.DOT_UNDERLAY_ALPHA },
        uSampleHalf: { value: 1 / P.DOT_UNDERLAY_SCALE },
        uFringePx: { value: P.RIM_FRINGE_PX },
        uFringeAmt: { value: P.RIM_FRINGE_AMT },
      },
      vertexShader: DOT_VERT,
      fragmentShader: DOT_FRAG,
      transparent: true,
      depthTest: true,
      // NOTHING in this look writes depth, and the reason is a design law rather than a style
      // choice. The Lantern Test (vision §15.2) is "track an unseen dog THROUGH one wall by its
      // sound-paint", and vision §3.4 makes a through-wall read a first-class picture — so the
      // painted wall in front of a dog, a stain or a ghost must not be allowed to hide it. A
      // depth-writing splat cloud also cannot be ordered: the samples inside one Points object
      // rasterise in buffer order, so a transparent dot that wrote depth would punch holes in
      // whatever happened to be drawn after it.
      depthWrite: false,
    });

    const lineMat = (holdMode: 0 | 1, offset: readonly [number, number]): ShaderMaterial => {
      const m = new ShaderMaterial({
        uniforms: {
          ...shared(),
          uSkeletonAlphaEdge: { value: k.SKELETON_ALPHA_EDGE },
          uHoldMode: { value: holdMode },
          uOffsetPx: { value: [offset[0], offset[1]] },
          uViewport: { value: this.viewport },
          uLift: { value: P.LINE_LIFT },
          uInk: { value: holdMode ? PALETTE_ARR.hold : PALETTE_ARR.edge },
          uDashOn: { value: holdMode ? P.DASH_PATTERN[0] : 0 },
          uDashOff: { value: holdMode ? P.DASH_PATTERN[1] : 0 },
        },
        vertexShader: LINE_VERT,
        fragmentShader: LINE_FRAG,
        transparent: true,
        depthTest: true,
        // Lines never occlude the cloud they annotate; they are read THROUGH.
        depthWrite: false,
      });
      this.lineMats.push(m);
      return m;
    };

    const edgeMat = lineMat(0, [0, 0]);
    const holdMatA = lineMat(1, [0, 0]);
    const holdMatB = lineMat(1, [P.HOLD_OFFSET_PX, P.HOLD_OFFSET_PX]);
    this.allMats = [this.dotMat, ...this.lineMats];

    this.dots = new Points(ctx.surfelGeom, this.dotMat);
    this.dots.frustumCulled = false; // one object holds the whole floor; the shader culls
    this.edges = new LineSegments(ctx.edgeGeom, edgeMat);
    this.edges.frustumCulled = false;
    this.edges.renderOrder = 1;
    this.holdsA = new LineSegments(ctx.edgeGeom, holdMatA);
    this.holdsA.frustumCulled = false;
    this.holdsA.renderOrder = 2;
    this.holdsB = new LineSegments(ctx.edgeGeom, holdMatB);
    this.holdsB.frustumCulled = false;
    this.holdsB.renderOrder = 2;
  }

  /** Remember the beam a live E-ping is still travelling down (see `uConeDensity`). */
  setCone(c: ConeState | null): void {
    this.cone = c ?? NO_CONE;
    this.coneOrigin[0] = this.cone.origin[0];
    this.coneOrigin[1] = this.cone.origin[1];
    this.coneOrigin[2] = this.cone.origin[2];
    this.coneDir[0] = this.cone.dir[0];
    this.coneDir[1] = this.cone.dir[1];
    this.coneDir[2] = this.cone.dir[2];
    const u = this.dotMat.uniforms;
    u.uConeCos!.value = this.cone.cosHalf;
    u.uConeFrom!.value = this.cone.from;
    u.uConeUntil!.value = this.cone.until;
  }

  update(f: MatterFrame): void {
    this.camPos[0] = f.camPos[0];
    this.camPos[1] = f.camPos[1];
    this.camPos[2] = f.camPos[2];
    this.feet[0] = f.bodyFeet[0];
    this.feet[1] = f.bodyFeet[1];
    this.feet[2] = f.bodyFeet[2];
    for (const m of this.allMats) {
      const u = m.uniforms;
      u.uNow!.value = f.now;
      u.uFloorCentre!.value = f.floorCentre;
      u.uFloorSpan!.value = f.floorSpan;
      u.uPixelRatio!.value = f.pixelRatio;
    }
    this.dotMat.uniforms.uProjScale!.value = f.projScale;
  }

  resize(w: number, h: number, pixelRatio: number): void {
    this.viewH = Math.max(1, h);
    this.dotMat.uniforms.uSampleCap!.value = P.DOT_SAMPLE_CAP_FRAC * this.viewH;
    this.viewport[0] = Math.max(1, w) * pixelRatio;
    this.viewport[1] = this.viewH * pixelRatio;
  }

  dispose(): void {
    for (const m of this.allMats) m.dispose();
    this.lineMats.length = 0;
    // NOT disposed, on purpose: ctx.surfelGeom / ctx.edgeGeom are the SurfelField's and hold the
    // run's paint. Disposing them here would black the world on every look switch.
  }
}
