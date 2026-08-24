/**
 * PHOSPHOR — the matter layer: struck phosphor grains and hairline edge lines.
 *
 * This is the cyan band and nothing else lives in it (vision §3.2): the dots and lines here answer
 * "what is there", they take their colour from AGE and never from what painted them, and every
 * depth cue in the frame is inside this band (vision §12).
 *
 * WHAT IS LAW HERE rather than styling, and is therefore identical in all three schools:
 *
 *   - Absence is black. Nothing is drawn that sound has not reached, except the 2 m contact shell.
 *   - Aging: ice-white → family hue → dim → permanent skeleton at SKELETON_ALPHA, with the cloud
 *     thinning through each dot's own stable dither band so old areas decay cloud → line drawing.
 *     The thinning uses the dither and never a random draw: the same dots always drop first, so a
 *     re-scan refreshes in place and the image is temporally stable (vision §12, visual-brief §2).
 *   - The wavefront is real: a surfel whose paintTime is still in the future is not drawn.
 *   - The hard window: 45 m and ±1 floor, as a cut. Distance discipline: dots thin and dim past
 *     ~20 m so the far read biases to edges.
 *   - The rim is `now − paintTime < RIM_WINDOW`. A school styles its width, brightness and trail;
 *     it may not move its timing.
 *   - Dots are matter, lines are holds. The hold accent is brightness + a doubled stroke, never
 *     hue alone.
 *
 * WHAT IS PHOSPHOR'S: the green-leaning ramp, the gaussian soft-core splat with its 1.5× halo, the
 * strike overshoot, the once-only dying-grain flicker, the white-cored rim, and the hairline
 * 1.5 px edge weight built from an offset pass.
 *
 * SHARED GEOMETRY. The Points and LineSegments here are built over `ctx.surfelGeom` /
 * `ctx.edgeGeom`, which belong to the SurfelField and hold the run's paint. This file disposes its
 * materials and NOTHING else (engine-plan §9).
 */

import { LineSegments, Points, ShaderMaterial } from 'three';
import type { Object3D } from 'three';
import type { LookContext } from '../types.js';
import {
  AGE_EASE_HOT,
  AGE_EASE_MID,
  DOT_ALPHA_GAIN,
  DOT_CAP_FRAC,
  DYING_FLICKER,
  GRAIN_GLSL,
  DYING_FLICKER_WIDTH,
  HOLD_OFFSET_PX,
  LINE_LIFT,
  LINE_SOFT_ALPHA,
  LINE_SOFT_OFFSET_PX,
  PALETTE,
  RIM_DEPTH,
  RIM_E_ELONGATE,
  RIM_SIZE_GAIN,
  STRIKE_CALM_SCALE,
  STRIKE_CALM_STRETCH,
  STRIKE_MS,
  STRIKE_OVERSHOOT,
  f,
  v3,
} from './params.js';

/** `paintTime` sentinel. UNPAINTED is −1e9; anything below −1e8 has never been lit. */
const NEVER_PAINTED = -1.0e8;

/**
 * How much of the cloud survives at full skeleton age.
 *
 * The aging law says the cloud thins through the dither band as it cools ("dots drop out;
 * edge-lines are retained longest" — visual-brief §1.12). Thinning straight against the alpha
 * ramp would drop 78 % of the dots at SKELETON_ALPHA, which is a defensible reading of the law and
 * an indefensible reading of vision §3.6: you never lose the map, only the fine read, and a hall
 * you have to guess at is a lost map. The exponent bends the drop curve so the thinning is gentle
 * early (1.6 % at the end of the mid band, 20 % at the end of cool) and leaves ~52 % of the grains
 * standing under a full edge skeleton at 90 s. Amount is styling; the dither ORDER is the law.
 */
const AGE_THIN_POWER = 0.45;

/** Per-frame state both materials need, written once and read by all four. */
export interface MatterFrame {
  readonly now: number;
  readonly camPos: readonly number[];
  readonly feet: readonly number[];
  readonly projScale: number;
  readonly floorCentre: number;
  readonly floorSpan: number;
}

/**
 * The shared preamble: the window cut, the wavefront gate, the age ramp and the contact shell.
 * Injected into both shaders so the two layers cannot drift apart on any of them.
 */
const COMMON = /* glsl */ `
uniform float uNow;
uniform vec3  uCamPos;
uniform float uFloorCentre;
uniform float uFloorSpan;
uniform float uWindowRadius;
uniform float uFarBias;
uniform float uAgeFlash;
uniform float uAgeHot;
uniform float uAgeMid;
uniform float uAgeCool;
uniform float uAgeSkeleton;
uniform float uSkeletonAlpha;
uniform float uShellRadius;
uniform float uShellAlpha;
uniform vec3  uBodyFeet;
uniform vec3  uBodyHead;
uniform float uRimWindow;
uniform float uRimTail;
uniform float uStrike;
uniform float uStrikeS;
uniform float uFlicker;

// Clip-space nowhere: one rasteriser reject, no discard, no branch in the fragment stage.
#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

// Vision §3.1 measures the contact shell from the BODY, not the eye — standing still, the nearest
// floor the camera can see is 2.2 m from the eye and 1.6 m from the capsule, so an eye-measured
// shell is an invisible shell. Distance to the feet-head segment.
float bodyDist(vec3 p) {
  vec3 ab = uBodyHead - uBodyFeet;
  float t = clamp(dot(p - uBodyFeet, ab) / max(1.0e-5, dot(ab, ab)), 0.0, 1.0);
  return distance(p, uBodyFeet + ab * t);
}

float shellAlpha(vec3 p) {
  return uShellAlpha * (1.0 - smoothstep(uShellRadius * 0.9, uShellRadius, bodyDist(p)));
}

// AGE IS TEMPERATURE (vision §3.2). Five stops on core's own five constants, so the school picks
// the tones and core keeps the clock. Chained mixes rather than branches: every dot walks the same
// instruction path whatever its age, which is what keeps a 300 k-point draw predictable.
//
// The first two legs are FRONT-LOADED (AGE_EASE_HOT / AGE_EASE_MID — see params for why). The stops
// and their times are core's and are untouched; only the approach between them is eased, so the eye
// is let into the colour family early enough to see it while the player is moving. Age still moves
// one way only, and a dot is still exactly c0 at the instant it is struck.
vec3 ageRamp(float age, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4) {
  float t1 = clamp((age - uAgeFlash) / max(1.0e-4, uAgeHot - uAgeFlash), 0.0, 1.0);
  float t2 = clamp((age - uAgeHot) / max(1.0e-4, uAgeMid - uAgeHot), 0.0, 1.0);
  vec3 c = mix(c0, c1, pow(t1, ${f(AGE_EASE_HOT)}));
  c = mix(c, c2, pow(t2, ${f(AGE_EASE_MID)}));
  c = mix(c, c3, clamp((age - uAgeMid) / max(1.0e-4, uAgeCool - uAgeMid), 0.0, 1.0));
  c = mix(c, c4, clamp((age - uAgeCool) / max(1.0e-4, uAgeSkeleton - uAgeCool), 0.0, 1.0));
  return c;
}

// THE STRIKE. A struck grain overshoots and settles; the colour walk to the hot tone and the
// brightness overshoot share one envelope so they cannot disagree about when the strike is over.
// Reduce-flashing scales the amplitude down and stretches the fall (uStrike / uStrikeS), which
// turns a spike into a plain ease without changing what freshness MEANS (vision §12).
float strikeEnvelope(float age) {
  return 1.0 - smoothstep(0.0, uStrikeS, max(0.0, age));
}

// THE RIM (visual-brief §1.11). Timing is core's: the band is age < RIM_WINDOW, and its depth in
// seconds is the look's metres-per-wavefront converted by whichever wave is in flight (uRimTail).
float rimEnvelope(float age) {
  return (1.0 - smoothstep(0.0, min(uRimTail, uRimWindow), max(0.0, age)));
}

// The once-only dying grain: a ±uFlicker luminance wobble as a dot crosses cool → skeleton, fired
// at a phase given by the dot's own stable dither so the field scintillates instead of blinking in
// unison, and never fired twice. Zero under reduce-flashing.
float dyingGrain(float age, float dither) {
  float t = (age - uAgeCool) / max(1.0e-4, uAgeSkeleton - uAgeCool);
  float q = (t - dither) / ${f(DYING_FLICKER_WIDTH)};
  float bump = exp(-q * q);
  float sgn = fract(dither * 37.0) < 0.5 ? -1.0 : 1.0;
  return 1.0 + uFlicker * sgn * bump;
}
`;

const DOT_VERT = /* glsl */ `
attribute float dither;
attribute float paintTime;
attribute float paintIntensity;

uniform float uSpacing;
uniform float uProjScale;
uniform float uPixelRatio;
uniform float uSplatMin;
uniform float uSplatNear;
uniform float uSplatCap;
uniform float uThinGain;

varying vec3  vColor;
varying float vAlpha;
varying float vRim;
varying float vSize;

${COMMON}

void main() {
  float camDist = distance(position, uCamPos);

  // The hard window (vision §3.6). A cut, not a fade: outside it there is no world.
  if (camDist > uWindowRadius || abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // Core paints a surfel when the sound REACHES it and never before, so this gate should never
  // fire — it is kept as the assertion that the invariant holds, because a future paintTime would
  // blank a surface the player already bought and a silent hole is the hardest bug to see.
  float age = uNow - paintTime;
  float lit = (paintTime > ${NEVER_PAINTED.toExponential()} && age >= 0.0) ? 1.0 : 0.0;

  float strike = strikeEnvelope(age);
  float rim = lit * rimEnvelope(age);

  // Colour: ice-white for the flash, then the family ramp. The strike keeps the fresh tone alive
  // through its own envelope so a dot does not change colour and brightness on two different clocks.
  vec3 c = ageRamp(age, ${v3(PALETTE.fresh)}, ${v3(PALETTE.hot)}, ${v3(PALETTE.mid)}, ${v3(PALETTE.cool)}, ${v3(PALETTE.skeleton)});
  c = mix(c, ${v3(PALETTE.fresh)}, strike);

  // Alpha: the age ramp with the permanent memory-skeleton floor under it (vision §3.6).
  float cool = smoothstep(0.0, 1.0, clamp((age - uAgeFlash) / max(1.0e-4, uAgeSkeleton - uAgeFlash), 0.0, 1.0));
  float aged = mix(1.0, uSkeletonAlpha, cool);
  float body = aged * mix(0.55, 1.0, paintIntensity);
  float alpha = lit * max(uSkeletonAlpha, body) * ${f(DOT_ALPHA_GAIN)};

  // AGE THINNING through the dither band: as paint cools the cloud drops grains, oldest-first and
  // always the SAME grains (visual-brief §1.12, §2). See AGE_THIN_POWER for why the curve bends.
  float keep = pow(clamp(max(uSkeletonAlpha, body), 0.0, 1.0), ${f(AGE_THIN_POWER)});
  if (lit > 0.5 && dither * uThinGain > keep) alpha = 0.0;

  // The strike's brightness overshoot, and the one dying wobble on the way out.
  alpha *= 1.0 + uStrike * strike;
  alpha *= dyingGrain(age, dither);

  // Distance discipline (vision §12): dots dim and the cloud thins against each dot's own stable
  // dither, so the survivors never flicker and the far read biases to the edge buffer.
  float far = smoothstep(uFarBias, uWindowRadius, camDist);
  if (dither > 1.0 - far) alpha = 0.0;
  alpha *= 1.0 - 0.6 * far;

  // The splat is the projected footprint of the lattice cell, capped (visual-brief §2 "dots stay
  // dots"): past the cap a near field of soft discs replaces the crisp sparse lattice the whole
  // look is built on. The floors are raised OVER the cap rather than assumed to sit under it —
  // GLSL leaves clamp undefined when its low bound exceeds its high one, and the two are owned by
  // different modules. Foreshortening uses the equal-area radius of the cell's projected ellipse,
  // without which every grazing surface overlaps itself into a sheet.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 toCam = normalize(uCamPos - position);
  float foot = uProjScale * uSpacing / max(0.05, -mv.z);
  foot *= sqrt(clamp(abs(dot(normal, toCam)), 0.15, 1.0));
  foot *= 1.0 + ${f(RIM_SIZE_GAIN)} * rim;
  float floorPx = mix(uSplatNear, uSplatMin, far);
  float capPx = uSplatCap * (1.0 + ${f(RIM_SIZE_GAIN)} * rim);
  float size = clamp(foot, floorPx, max(capPx, floorPx));

  // The contact shell (vision §3.1): the only geometry visible without sound.
  float shell = shellAlpha(position);
  if (lit < 0.5) c = ${v3(PALETTE.shell)};
  alpha = max(alpha, shell);
  if (alpha <= 0.003) CULL()

  vColor = c;
  vAlpha = alpha;
  vRim = rim;
  vSize = size;

  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * uPixelRatio;
}
`;

const DOT_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;
varying float vRim;
varying float vSize;

${GRAIN_GLSL}

void main() {
  // Round soft-core splat: a gaussian core with a tight 1.5× halo baked into the sprite. No bloom
  // pass anywhere in this look — the micro-glow is per grain, which is what keeps a bright frame
  // from fusing into porridge (vision §12).
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float profile = grain(r, vSize);

  // The rim's white core with its hot-cyan skirt (the brief's palette). Depth cues stay inside the
  // cyan band: the white lives only in the 0.12 s the wavefront is actually on this surfel.
  vec3 c = mix(vColor, mix(${v3(PALETTE.rimSkirt)}, ${v3(PALETTE.rimCore)}, profile), vRim);
  gl_FragColor = vec4(c, vAlpha * profile);
}
`;

const LINE_VERT = /* glsl */ `
attribute float dither;
attribute float flagsHold;
attribute float paintTime;
attribute float paintIntensity;

uniform float uSkeletonAlphaEdge;
uniform float uHoldOnly;
uniform float uWeight;
uniform vec2  uOffsetPx;
uniform vec2  uViewport;
uniform float uLift;

varying vec3  vColor;
varying float vAlpha;
varying float vRim;

${COMMON}

void main() {
  float hold = step(0.5, flagsHold);
  if (uHoldOnly > 0.5 && hold < 0.5) CULL()

  float camDist = distance(position, uCamPos);
  if (camDist > uWindowRadius || abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  float age = uNow - paintTime;
  float lit = (paintTime > ${NEVER_PAINTED.toExponential()} && age >= 0.0) ? 1.0 : 0.0;

  float strike = strikeEnvelope(age);
  float rim = lit * rimEnvelope(age);

  vec3 c = ageRamp(age, ${v3(PALETTE.edgeFresh)}, ${v3(PALETTE.edgeHot)}, ${v3(PALETTE.edgeMid)}, ${v3(PALETTE.edgeCool)}, ${v3(PALETTE.edgeSkeleton)});
  c = mix(c, ${v3(PALETTE.edgeFresh)}, strike);
  // A hold is brighter AND doubled (the offset pass): brightness plus stroke, so the hold/edge
  // distinction survives any colour vision (vision §12).
  c = mix(c, ${v3(PALETTE.hold)}, hold * 0.6);

  float cool = smoothstep(0.0, 1.0, clamp((age - uAgeFlash) / max(1.0e-4, uAgeSkeleton - uAgeFlash), 0.0, 1.0));
  float floorA = mix(uSkeletonAlpha, uSkeletonAlphaEdge, hold);
  float alpha = lit * max(floorA, mix(1.0, floorA, cool) * mix(0.6, 1.0, paintIntensity));
  alpha *= 1.0 + uStrike * strike;
  alpha *= dyingGrain(age, dither);

  // Edge-biased retention (vision §12): lines keep far more of their strength at range than dots
  // do, which is what turns the far field into a drawing rather than a haze.
  alpha *= 1.0 - 0.35 * smoothstep(uFarBias, uWindowRadius, camDist);

  // The shell reaches holds too: a rail a metre from your body is contact geometry.
  float shell = shellAlpha(position);
  if (lit < 0.5) c = ${v3(PALETTE.shell)};
  alpha = max(alpha, shell) * uWeight;
  if (alpha <= 0.003) CULL()

  vColor = mix(c, ${v3(PALETTE.rimCore)}, rim * 0.75);
  vAlpha = alpha;
  vRim = rim;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.z += uLift; // toward the camera: a crease sits ON the surfels it creases
  gl_Position = projectionMatrix * mv;
  // gl_LineWidth is fixed at 1 in WebGL, so width is built from screen-space offset passes; the
  // offset is in pixels, so a hairline holds its weight at every distance.
  gl_Position.xy += uOffsetPx * (2.0 / uViewport) * gl_Position.w;
}
`;

const LINE_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;
varying float vRim;

void main() {
  gl_FragColor = vec4(vColor, vAlpha * (1.0 + 0.35 * vRim));
}
`;

type Uniforms = Record<string, { value: unknown }>;

const setU = (m: ShaderMaterial | null, name: string, v: unknown): void => {
  const u = m?.uniforms[name];
  if (u) u.value = v;
};

/**
 * The four draws of the matter layer: the dot cloud, the hairline edge pass, its half-pixel
 * softening pass, and the holds.
 */
export class MatterField {
  readonly objects: readonly Object3D[];

  private readonly dotMat: ShaderMaterial;
  private readonly lineMats: ShaderMaterial[];
  private readonly all: ShaderMaterial[];
  private viewH = 1;

  constructor(ctx: LookContext) {
    const c = ctx.constants;
    const calm = ctx.reduceFlashing();

    const shared = (): Uniforms => ({
      uNow: { value: 0 },
      uCamPos: { value: [0, 0, 0] },
      uFloorCentre: { value: ctx.floorCentre },
      uFloorSpan: { value: ctx.floorSpan },
      uWindowRadius: { value: c.WINDOW_RADIUS },
      uFarBias: { value: c.FAR_BIAS_START },
      uAgeFlash: { value: c.AGE_FLASH },
      uAgeHot: { value: c.AGE_HOT },
      uAgeMid: { value: c.AGE_MID },
      uAgeCool: { value: c.AGE_COOL },
      uAgeSkeleton: { value: c.AGE_SKELETON },
      uSkeletonAlpha: { value: c.SKELETON_ALPHA },
      uShellRadius: { value: c.CONTACT_SHELL_RADIUS },
      uShellAlpha: { value: c.CONTACT_SHELL_ALPHA },
      uBodyFeet: { value: [0, 0, 0] },
      uBodyHead: { value: [0, 0, 0] },
      uRimWindow: { value: c.RIM_WINDOW },
      // Until a travelling wave is in flight the band is the whole window; instant classes flash
      // whole and have no front to be a band on.
      uRimTail: { value: c.RIM_WINDOW },
      uStrike: { value: calm ? STRIKE_OVERSHOOT * STRIKE_CALM_SCALE : STRIKE_OVERSHOOT },
      uStrikeS: { value: (STRIKE_MS / 1000) * (calm ? STRIKE_CALM_STRETCH : 1) },
      uFlicker: { value: calm ? 0 : DYING_FLICKER },
    });

    this.dotMat = new ShaderMaterial({
      uniforms: {
        ...shared(),
        uSpacing: { value: c.SURFEL_SPACING },
        uProjScale: { value: 500 },
        uPixelRatio: { value: 1 },
        uSplatMin: { value: c.SPLAT_MIN_PX },
        uSplatNear: { value: c.SPLAT_NEAR_PX },
        uSplatCap: { value: DOT_CAP_FRAC * this.viewH },
        uThinGain: { value: c.THIN_GAIN },
      },
      vertexShader: DOT_VERT,
      fragmentShader: DOT_FRAG,
      transparent: true,
      depthTest: true,
      // Dots DO write depth: a near surface must hide the room behind it, or the memory skeleton
      // of the next room reads as if it were in this one.
      depthWrite: true,
    });

    const lineMat = (holdOnly: boolean, offset: number, weight: number): ShaderMaterial =>
      new ShaderMaterial({
        uniforms: {
          ...shared(),
          uSkeletonAlphaEdge: { value: c.SKELETON_ALPHA_EDGE },
          uHoldOnly: { value: holdOnly ? 1 : 0 },
          uWeight: { value: weight },
          uOffsetPx: { value: [offset, offset] },
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

    // Hairline 1.5 px = the base stroke plus a dimmer half-pixel companion; a hold is the same
    // line again at +20 % width and full brightness.
    this.lineMats = [
      lineMat(false, 0, 1),
      lineMat(false, LINE_SOFT_OFFSET_PX, LINE_SOFT_ALPHA),
      lineMat(true, HOLD_OFFSET_PX, 1),
    ];
    this.all = [this.dotMat, ...this.lineMats];

    const dots = new Points(ctx.surfelGeom, this.dotMat);
    dots.frustumCulled = false; // one object holds the whole floor; the shader does the culling
    const objects: Object3D[] = [dots];
    this.lineMats.forEach((m, i) => {
      const seg = new LineSegments(ctx.edgeGeom, m);
      seg.frustumCulled = false;
      seg.renderOrder = 1 + i;
      objects.push(seg);
    });
    this.objects = objects;
  }

  /**
   * The rim's depth in metres becomes a depth in seconds against the wavefront that is sweeping.
   * Only travelling classes call this — an instant class has no front, and its arrival is the
   * strike. The E-ping's band is elongated along the beam, which is its own sweep axis.
   */
  setRimWave(waveSpeed: number, isEPing: boolean): void {
    if (!Number.isFinite(waveSpeed) || waveSpeed <= 0) return;
    const depth = RIM_DEPTH * (isEPing ? RIM_E_ELONGATE : 1);
    const window = this.dotMat.uniforms.uRimWindow!.value as number;
    const tail = Math.min(window, Math.max(0.015, depth / waveSpeed));
    for (const m of this.all) setU(m, 'uRimTail', tail);
  }

  update(fr: MatterFrame): void {
    for (const m of this.all) {
      const u = m.uniforms;
      u.uNow!.value = fr.now;
      u.uCamPos!.value = fr.camPos;
      u.uBodyFeet!.value = fr.feet;
      u.uBodyHead!.value = fr.camPos;
      u.uFloorCentre!.value = fr.floorCentre;
      u.uFloorSpan!.value = fr.floorSpan;
    }
    setU(this.dotMat, 'uProjScale', fr.projScale);
  }

  resize(w: number, h: number, dpr: number): void {
    this.viewH = Math.max(1, h);
    setU(this.dotMat, 'uPixelRatio', dpr);
    // CSS px, like every other term in the size math — the DPR multiply happens once, in the
    // shader, and applying it here as well would square it.
    setU(this.dotMat, 'uSplatCap', DOT_CAP_FRAC * this.viewH);
    const vp = [Math.max(1, w) * dpr, this.viewH * dpr];
    for (const m of this.lineMats) setU(m, 'uViewport', vp);
  }

  /** The dot cap in CSS px — the event layer borrows it so no mark can outgrow a splat. */
  get capPx(): number {
    return DOT_CAP_FRAC * this.viewH;
  }

  dispose(): void {
    for (const m of this.all) m.dispose();
    // ctx.surfelGeom / ctx.edgeGeom are the SurfelField's and hold the run's paint: NOT disposed.
  }
}
