/**
 * PHOSPHOR — the event layer: noise stains and the dog cloud (vision §3.2, visual-brief §1.13).
 *
 * The matter layer says WHAT IS THERE. This file says WHAT JUST HAPPENED, and it is the layer that
 * pays the colourblind law (vision §12, engine-plan §9): **meaning is hue + shape + motion, never
 * hue alone**. Every source therefore carries a FORM as well as a colour, and the form is the part
 * that survives with no colour vision at all:
 *
 *   self        soft round breath                       — the quietest mark, because it is you
 *   dog         jagged rim + 2–3 darts along the travel  — angular, and it points where it went
 *   prop        a ring that expands outward, once        — a knock is an impact, and it spreads
 *   objective   a steady annulus breathing on 4 s        — the only mark that does not decay away
 *   detonation  white core + four-spike star + shock     — nothing else in the game has spikes
 *   teammate    a steady diamond glyph pip               — vision §3.2 names this one explicitly
 *
 * Two objects, one draw call each: a fixed ring of stain billboards, and every drawable dog pose
 * (live smear + cooling ghosts) merged into a single buffer.
 *
 * WHAT IS LAW HERE rather than styling:
 *
 *   - The hard window (vision §3.6). Outside 45 m or off the ±1 floor band, nothing is drawn. The
 *     event layer never sees further than the matter layer.
 *   - A stain sits at the origin the MATTER was painted from — `deliveredOrigin`, so the fuzzed
 *     through-wall position is the one both layers use. Two answers is a lie (vision §1.2).
 *   - Quality drives DEFINITION, not just brightness: a close clean read is small, tight and
 *     bright; a walled or distant one is a wide dim smudge whose spread IS the vagueness.
 *   - A ghost ages from `frozenAt` on core's clock: hot → rust over DOG_GHOST_LIFE, then a visible
 *     dissolve over DOG_GHOST_DISSOLVE. Never interpolated, never predicted (vision §3.7).
 *   - Nothing here writes depth. A warm mark must never read as near geometry (vision §12).
 *
 * WHAT IS PHOSPHOR'S: the gaussian smudges that never grow a hard edge, the jag and the darts, the
 * gait kick, the shock rings, and the dog's own cloud drawn in matter cyan — it is matter — wrapped
 * in the red-orange event marks rather than painted with them.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Matrix4,
  Points,
  ShaderMaterial,
} from 'three';
import type { CoreConstants } from '../../core/const.js';
import type { DogView } from '../../core/dog.js';
import type { SoundEvent, SourceKind } from '../../core/events.js';
import { deliveredOrigin } from '../../core/paint.js';
import { clamp01, lerp } from '../../core/math.js';
import {
  DOG_ALPHA,
  DOG_DART_COUNT,
  DOG_LINK_MAX_DT,
  DOG_LINK_RADIUS,
  DOG_SMEAR_DECAY,
  GHOST_HOLD,
  GRAIN_GLSL,
  PALETTE,
  STAIN_A_HIGH_Q,
  STAIN_A_LOW_Q,
  STAIN_BREATH_AMT,
  STAIN_BREATH_PERIOD,
  STAIN_CALM_ALPHA,
  STAIN_CAP,
  STAIN_CAP_MULT,
  STAIN_CAP_TIGHT,
  STAIN_DOG_PULSE,
  STAIN_DOG_PULSE_S,
  STAIN_MIN_PX,
  STAIN_NEAR_FADE_M,
  STAIN_ONSET,
  STAIN_ONSET_CALM,
  STAIN_Q_CURVE,
  STAIN_RING_GAIN,
  STAIN_RING_R,
  STAIN_RING_W,
  STAIN_R_HIGH_Q,
  STAIN_R_LOW_Q,
  f,
  v3,
  type RGB,
} from './params.js';

/** Per-frame projection state both fields need. Written once, read by both materials. */
export interface MarkFrame {
  readonly now: number;
  readonly camPos: readonly number[];
  /** Pixels per metre at one metre of depth — the matter layer's own `uProjScale`. */
  readonly projScale: number;
  readonly pixelRatio: number;
  /** The matter layer's dot cap in CSS px, so a mark is always measured against a splat. */
  readonly capPx: number;
  /** Drawing-buffer size in device px, for the screen-space dart direction. */
  readonly viewport: readonly number[];
  readonly floorCentre: number;
  readonly floorSpan: number;
}

// ---------------------------------------------------------------------------------------------
// Noise stains
// ---------------------------------------------------------------------------------------------

/**
 * THE FORM CODES. The number is the shape, and the shape is what carries the meaning when the hue
 * cannot (vision §12). Order is arbitrary and private to this file's two shaders.
 */
const FORM: Record<SourceKind, number> = {
  self: 0,
  dog: 1,
  prop: 2,
  objective: 3,
  detonation: 4,
  teammate: 5,
};

const STAIN_COLOUR: Record<SourceKind, RGB> = {
  self: PALETTE.evSelf,
  dog: PALETTE.evDog,
  prop: PALETTE.evProp,
  objective: PALETTE.evObjective,
  detonation: PALETTE.evDetonation,
  teammate: PALETTE.evTeammate,
};

const STAIN_VERT = /* glsl */ `
attribute vec3  aColor;
attribute vec3  aDir;
attribute float aBorn;
attribute float aFade;
attribute float aRadius;
attribute float aPeak;
attribute float aSharp;
attribute float aForm;
attribute float aSeed;

uniform float uNow;
uniform vec3  uCamPos;
uniform float uFloorCentre;
uniform float uFloorSpan;
uniform float uWindowRadius;
uniform float uProjScale;
uniform float uPixelRatio;
uniform float uCapPx;
uniform float uMinPx;
uniform float uOnset;
uniform float uDogPulse;
uniform vec2  uViewport;

varying vec3  vColor;
varying float vAlpha;
varying float vSharp;
varying float vForm;
varying float vSeed;
varying float vLife;
varying vec2  vDir;
varying float vHasDir;

#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

void main() {
  // A dead slot has aFade 0 and is culled by the same test that retires a finished stain — the
  // ring never needs a separate "is this one real" flag.
  float age = uNow - aBorn;
  if (aFade <= 0.0 || age < 0.0 || age > aFade) CULL()
  if (distance(position, uCamPos) > uWindowRadius) CULL()
  if (abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // Squared tail: a stain LEAVES rather than switching off, which is what makes a repeating source
  // (a gait, a slide) read as a trail of marks of different ages instead of a flicker.
  float life = age / aFade;
  float fall = 1.0 - life;
  float a = aPeak * clamp(age / uOnset, 0.0, 1.0) * fall * fall;

  // The gait kick: one dog stain per gait tick, and each arrives with a kick before settling. It
  // is an onset shape, not a repeating pulse — nothing in this look strobes (vision §12).
  if (aForm > 0.5 && aForm < 1.5) {
    a *= 1.0 + uDogPulse * (1.0 - smoothstep(0.0, ${f(STAIN_DOG_PULSE_S)}, age));
  }

  // A mark you are standing inside is a veil, not a mark (STAIN_NEAR_FADE_M).
  a *= smoothstep(${f(STAIN_NEAR_FADE_M * 0.25)}, ${f(STAIN_NEAR_FADE_M)}, distance(position, uCamPos));
  if (a <= 0.004) CULL()

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 clip = projectionMatrix * mv;

  // THE DARTS' DIRECTION, projected here rather than guessed in the fragment stage: the world
  // travel vector is carried on the stain, and a second projected point one step along it gives
  // the screen direction the sprite has to draw its darts in. aDir is the zero vector when nothing
  // was close enough to link to, and then no darts are drawn at all.
  vHasDir = step(0.5, dot(aDir, aDir));
  vDir = vec2(0.0, 0.0);
  if (vHasDir > 0.5) {
    vec3 dv = mat3(modelViewMatrix) * aDir;
    vec4 clipB = projectionMatrix * vec4(mv.xyz + dv * 0.25, 1.0);
    if (clip.w > 0.001 && clipB.w > 0.001) {
      // gl_PointCoord's y runs DOWN the sprite while clip y runs up, hence the negation.
      vec2 d = vec2(
        (clipB.x / clipB.w - clip.x / clip.w) * uViewport.x,
        -(clipB.y / clipB.w - clip.y / clip.w) * uViewport.y);
      float len = length(d);
      if (len > 1.0e-5) vDir = d / len; else vHasDir = 0.0;
    } else {
      vHasDir = 0.0;
    }
  }

  // The stain's radius is a real distance in the world, so it shrinks with range like everything
  // else — but it is bounded against the matter layer's own dot cap. Uncapped, a low-quality 3 m
  // smudge heard from arm's length is most of the frame.
  float px = uProjScale * (aRadius * 2.0) / max(0.05, -mv.z);
  // The ceiling scales with the stain's vagueness, or the cap — which is what a stain's size
  // actually is at any audible range — would flatten every quality to one blob (STAIN_CAP_TIGHT).
  float capPx = max(uCapPx * ${f(STAIN_CAP_MULT)} * mix(1.0, ${f(STAIN_CAP_TIGHT)}, aSharp), uMinPx);
  gl_Position = clip;
  gl_PointSize = clamp(px, uMinPx, capPx) * uPixelRatio;

  vColor = aColor;
  vAlpha = a;
  vSharp = aSharp;
  vForm = aForm;
  vSeed = aSeed;
  vLife = life;
}
`;

const STAIN_FRAG = /* glsl */ `
uniform float uNow;
uniform float uBreathAmt;

varying vec3  vColor;
varying float vAlpha;
varying float vSharp;
varying float vForm;
varying float vSeed;
varying float vLife;
varying vec2  vDir;
varying float vHasDir;

const float TAU = 6.2831853;

float gauss(float x, float s) {
  float q = x / max(1.0e-4, s);
  return exp(-0.5 * q * q);
}

void main() {
  vec2 d = (gl_PointCoord - vec2(0.5)) * 2.0;
  float r = length(d);
  if (r > 1.0) discard;

  // NO STAIN EVER GROWS A HARD EDGE (the brief). Whatever a form builds, this window takes it to
  // zero before the sprite's own boundary, so the discard above can never become a visible disc.
  float window = 1.0 - smoothstep(0.62, 1.0, r);

  // The shared body: quality is DEFINITION. A confident read is a tight bright core with a faint
  // concentric ring around it; a vague one is a wide flat breath with no core at all.
  float sig = mix(0.62, 0.21, vSharp);
  float base = gauss(r, sig);
  float ring = ${f(STAIN_RING_GAIN)} * vSharp * gauss(r - ${f(STAIN_RING_R)}, ${f(STAIN_RING_W)});

  float p = base + ring;
  vec3 c = vColor;

  if (vForm < 0.5) {
    // SELF — a soft round breath and nothing else, so the shared concentric ring is dropped here.
    // Your own footfall is the most common mark on the screen: it must never compete with anything,
    // and it must not wear a ring, because a ring is what a PROP knock means (form 2). Quality still
    // reads on this mark through the core's tightness, its alpha and how long it lingers.
    p = base;
  } else if (vForm < 1.5) {
    // DOG — jagged, and pointing where it went. The rim is modulated by two angular harmonics
    // phased off the event's own stable seed, so no two gait ticks have the same silhouette and
    // none of them is a circle.
    float ang = atan(d.y, d.x);
    float jag = 1.0 + 0.26 * sin(ang * 5.0 + vSeed * TAU) + 0.13 * sin(ang * 9.0 - vSeed * 3.7);
    p = gauss(r * jag, sig) + ring;
    if (vHasDir > 0.5) {
      vec2 u = vDir;
      float darts = 0.0;
      for (int k = 0; k < ${DOG_DART_COUNT}; k++) {
        float fk = float(k) - ${f((DOG_DART_COUNT - 1) / 2)};
        // A fan, not a bundle: the outer darts splay and are shorter, which is what stops three
        // parallel lines from reading as one thick arrow.
        float phi = fk * 0.44;
        vec2 uk = vec2(u.x * cos(phi) - u.y * sin(phi), u.x * sin(phi) + u.y * cos(phi));
        float along = dot(d, uk);
        float across = dot(d, vec2(-uk.y, uk.x));
        float len = 0.95 - 0.22 * abs(fk);
        float w = 0.075 * (1.0 - 0.75 * clamp(along / len, 0.0, 1.0));
        float shaft = gauss(across, w);
        shaft *= smoothstep(0.0, 0.16, along) * (1.0 - smoothstep(len * 0.65, len, along));
        darts = max(darts, shaft);
      }
      p += darts * 0.85;
    }
  } else if (vForm < 2.5) {
    // PROP — a knock spreads. The ring expands outward ONCE over the first part of the stain's
    // life and thickens as it goes, leaving the faint core behind it.
    float t = smoothstep(0.0, 0.45, vLife);
    float rr = mix(0.12, 0.92, t);
    float w = mix(0.09, 0.26, t);
    p = base * 0.4 + gauss(r - rr, w) * (1.0 - t * 0.35);
  } else if (vForm < 3.5) {
    // OBJECTIVE — the one mark that is an instrument rather than an echo: a steady annulus, a
    // centre pip, and a slow 4 s breath. Gold is reserved (vision §3.2) and so is this shape.
    float breath = 1.0 + uBreathAmt * sin(TAU * uNow / ${f(STAIN_BREATH_PERIOD)});
    p = (gauss(r - 0.58, 0.10) + gauss(r, 0.12) * 0.7) * breath;
  } else if (vForm < 4.5) {
    // DETONATION — the loudest thing in the game, and the only thing with spikes: a white core, a
    // four-spike star, and a shock ring racing out through the mark's first quarter.
    float t = smoothstep(0.0, 0.28, vLife);
    vec2 a2 = abs(d);
    // Spike width in sprite radii, not pixels: at the cap a sharp mark is ~34 px across, so 0.085
    // is a ~3 px arm — the minimum that survives a stream compressor (vision §12).
    float star = gauss(a2.y, 0.085) + gauss(a2.x, 0.085);
    star *= 1.0 - smoothstep(0.2, 1.0, r);
    float shock = gauss(r - mix(0.1, 0.95, t), mix(0.07, 0.2, t)) * (1.0 - t * 0.5);
    p = base + star * 0.8 + shock;
  } else {
    // TEAMMATE — a steady glyph pip (vision §3.2 names it), drawn as a soft diamond outline over
    // a faint body. A glyph, so it is identical at every age: it says WHO, not when.
    float manh = abs(d.x) + abs(d.y);
    p = base * 0.35 + gauss(manh - 0.62, 0.10);
  }

  float alpha = vAlpha * p * window;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(c, alpha);
}
`;

/** One entry in the short memory of recent dog stains that gives the darts their direction. */
interface DogTrace {
  x: number;
  y: number;
  z: number;
  t: number;
}

export class PhosphorStains {
  readonly points: Points;

  private readonly geom = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private readonly position = new Float32Array(STAIN_CAP * 3);
  private readonly colour = new Float32Array(STAIN_CAP * 3);
  private readonly dir = new Float32Array(STAIN_CAP * 3);
  private readonly born = new Float32Array(STAIN_CAP);
  private readonly fade = new Float32Array(STAIN_CAP);
  private readonly radius = new Float32Array(STAIN_CAP);
  private readonly peak = new Float32Array(STAIN_CAP);
  private readonly sharp = new Float32Array(STAIN_CAP);
  private readonly form = new Float32Array(STAIN_CAP);
  private readonly seed = new Float32Array(STAIN_CAP);
  private write = 0;

  private readonly fadeMin: number;
  private readonly fadeMax: number;
  private readonly calm: boolean;
  /** Recent dog gait origins, newest last. Bounded and tiny — this is a direction, not a history. */
  private readonly trace: DogTrace[] = [];
  /**
   * Every attribute above, in creation order, held so the per-frame upload flag can be set by
   * walking a list that already exists. Naming them again each frame would allocate an array and
   * pay ten string lookups on the geometry — engine-plan §10 asks the frame path to allocate
   * nothing, and this layer runs on every frame a stain is alive.
   */
  private readonly attrs: BufferAttribute[] = [];

  constructor(constants: CoreConstants, reduceFlashing: boolean) {
    this.fadeMin = constants.STAIN_FADE_MIN;
    this.fadeMax = constants.STAIN_FADE_MAX;
    this.calm = reduceFlashing;

    const attr = (a: Float32Array, size: number): BufferAttribute => {
      const b = new BufferAttribute(a, size);
      b.setUsage(DynamicDrawUsage);
      this.attrs.push(b);
      return b;
    };
    this.geom.setAttribute('position', attr(this.position, 3));
    this.geom.setAttribute('aColor', attr(this.colour, 3));
    this.geom.setAttribute('aDir', attr(this.dir, 3));
    this.geom.setAttribute('aBorn', attr(this.born, 1));
    this.geom.setAttribute('aFade', attr(this.fade, 1));
    this.geom.setAttribute('aRadius', attr(this.radius, 1));
    this.geom.setAttribute('aPeak', attr(this.peak, 1));
    this.geom.setAttribute('aSharp', attr(this.sharp, 1));
    this.geom.setAttribute('aForm', attr(this.form, 1));
    this.geom.setAttribute('aSeed', attr(this.seed, 1));

    this.mat = new ShaderMaterial({
      uniforms: {
        uNow: { value: 0 },
        uCamPos: { value: [0, 0, 0] },
        uFloorCentre: { value: 0 },
        uFloorSpan: { value: 0 },
        uWindowRadius: { value: constants.WINDOW_RADIUS },
        uProjScale: { value: 500 },
        uPixelRatio: { value: 1 },
        uCapPx: { value: 12 },
        uMinPx: { value: STAIN_MIN_PX },
        uOnset: { value: reduceFlashing ? STAIN_ONSET_CALM : STAIN_ONSET },
        // The kick is a pulse, so comfort mode removes it; the mark still arrives, just evenly.
        uDogPulse: { value: reduceFlashing ? 0 : STAIN_DOG_PULSE },
        // The breath is a fade rather than a flash, so it is halved rather than removed.
        uBreathAmt: { value: STAIN_BREATH_AMT * (reduceFlashing ? 0.5 : 1) },
        uViewport: { value: [1, 1] },
      },
      vertexShader: STAIN_VERT,
      fragmentShader: STAIN_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: true,
      // The event layer annotates the matter layer; it never hides it and never reads as near
      // geometry (vision §12).
      depthWrite: false,
    });

    this.points = new Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.visible = false;
  }

  /**
   * Stamp one delivered event.
   *
   * The origin is the one PAINT used, so the mark and the geometry it lit agree about where the
   * sound was — including the ±2 m fuzz of a through-wall read, which is drawn as SPREAD and never
   * as a second position (vision §3.4).
   */
  stamp(e: SoundEvent): void {
    const q = Math.pow(clamp01(e.quality), STAIN_Q_CURVE);
    const i = this.write;
    this.write = (this.write + 1) % STAIN_CAP;

    const o = deliveredOrigin(e);
    this.position[i * 3] = o[0];
    this.position[i * 3 + 1] = o[1];
    this.position[i * 3 + 2] = o[2];

    const hue = STAIN_COLOUR[e.source];
    this.colour[i * 3] = hue[0];
    this.colour[i * 3 + 1] = hue[1];
    this.colour[i * 3 + 2] = hue[2];

    this.born[i] = e.time;
    // A confident read lingers; a vague one is gone before you can act on it (vision §3.2's
    // 2.5–6 s window, spent on the events that actually told you something).
    this.fade[i] = lerp(this.fadeMin, this.fadeMax, q);
    this.radius[i] = lerp(STAIN_R_LOW_Q, STAIN_R_HIGH_Q, q);
    this.peak[i] = lerp(STAIN_A_LOW_Q, STAIN_A_HIGH_Q, q) * (this.calm ? STAIN_CALM_ALPHA : 1);
    this.sharp[i] = q;
    this.form[i] = FORM[e.source];
    this.seed[i] = e.fuzzSeed;

    // Darts point along the travel this event and the previous gait tick actually describe. When
    // nothing is close enough in space AND time, the stain carries no direction and draws no
    // darts: a heading the data does not contain is never invented (vision §1.2).
    let dx = 0;
    let dy = 0;
    let dz = 0;
    if (e.source === 'dog') {
      const prev = this.nearestTrace(o[0], o[1], o[2], e.time);
      if (prev) {
        const vx = o[0] - prev.x;
        const vy = o[1] - prev.y;
        const vz = o[2] - prev.z;
        const len = Math.hypot(vx, vy, vz);
        if (len > 0.05) {
          dx = vx / len;
          dy = vy / len;
          dz = vz / len;
        }
      }
      this.pushTrace(o[0], o[1], o[2], e.time);
    }
    this.dir[i * 3] = dx;
    this.dir[i * 3 + 1] = dy;
    this.dir[i * 3 + 2] = dz;
  }

  private nearestTrace(x: number, y: number, z: number, t: number): DogTrace | null {
    let best: DogTrace | null = null;
    let bestD = DOG_LINK_RADIUS;
    for (const p of this.trace) {
      const dt = t - p.t;
      if (dt < 0 || dt > DOG_LINK_MAX_DT) continue;
      const d = Math.hypot(x - p.x, y - p.y, z - p.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private pushTrace(x: number, y: number, z: number, t: number): void {
    // A fixed, tiny ring: enough to hold every dog audible at once for one link window, and small
    // enough that the scan above is free. Reused in place — no allocation on the event path.
    const slot = this.trace.length < 8 ? null : this.trace.shift();
    if (slot) {
      slot.x = x;
      slot.y = y;
      slot.z = z;
      slot.t = t;
      this.trace.push(slot);
    } else {
      this.trace.push({ x, y, z, t });
    }
  }

  update(fr: MarkFrame): void {
    // A stain layer with nothing in it is not drawn at all: the black world has to survive an empty
    // ring, and a draw call that renders nothing is still a draw call.
    if (this.count(fr.now) === 0) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;

    for (let i = 0; i < this.attrs.length; i++) this.attrs[i]!.needsUpdate = true;
    const u = this.mat.uniforms;
    u.uNow!.value = fr.now;
    u.uCamPos!.value = fr.camPos;
    u.uFloorCentre!.value = fr.floorCentre;
    u.uFloorSpan!.value = fr.floorSpan;
    u.uProjScale!.value = fr.projScale;
    u.uPixelRatio!.value = fr.pixelRatio;
    u.uCapPx!.value = fr.capPx;
    u.uViewport!.value = fr.viewport;
  }

  /** Live stains right now. */
  count(now: number): number {
    let n = 0;
    for (let i = 0; i < STAIN_CAP; i++) {
      const fade = this.fade[i]!;
      if (fade > 0 && now - this.born[i]! <= fade) n++;
    }
    return n;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
    this.points.visible = false;
  }
}

// ---------------------------------------------------------------------------------------------
// The dog cloud and its ghosts
// ---------------------------------------------------------------------------------------------

const DOG_VERT = /* glsl */ `
attribute float dither;
attribute float aBorn;
attribute float aKind;
attribute float aRank;
attribute float aQuality;

uniform float uNow;
uniform vec3  uCamPos;
uniform float uFloorCentre;
uniform float uFloorSpan;
uniform float uWindowRadius;
uniform float uProjScale;
uniform float uPixelRatio;
uniform float uCapPx;
uniform float uMinPx;
uniform float uSpacing;
uniform float uAgeFlash;
uniform float uGhostLife;
uniform float uGhostDissolve;
uniform float uSmearDecay;
uniform float uAlpha;

varying vec3  vColor;
varying float vAlpha;
varying float vSize;

#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

void main() {
  if (distance(position, uCamPos) > uWindowRadius) CULL()
  if (abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  float a = uAlpha * aQuality;

  if (aKind < 0.5) {
    // THE LIVE SMEAR IS MATTER (vision §3.2): a dog's own cloud is geometry you heard, so it is
    // drawn in the cyan band like every other surface, and the red-orange lives in the stain
    // wrapped around it. Every sample is a real photograph, the older ones fainter — not a blur:
    // the renderer may not invent the frames between two things it was told (vision §3.7).
    float age = max(0.0, uNow - aBorn);
    vColor = mix(${v3(PALETTE.fresh)}, ${v3(PALETTE.hot)}, smoothstep(0.0, uAgeFlash, age));
    a *= pow(uSmearDecay, aRank);
  } else {
    // A GHOST IS A BELIEF GOING STALE, and it leaves the cyan band to say so. It holds its heat
    // for its first second (it visibly stops), then rusts across the rest of core's ten seconds,
    // then dissolves DOT BY DOT in dither order — the same order the matter layer thins in, so a
    // dissolving ghost reads as the same kind of forgetting as an old wall.
    float age = max(0.0, uNow - aBorn);
    float cool = smoothstep(${f(GHOST_HOLD)}, uGhostLife, age);
    vColor = mix(${v3(PALETTE.ghostHot)}, ${v3(PALETTE.ghostRust)}, cool);
    float diss = clamp((age - uGhostLife) / uGhostDissolve, 0.0, 1.0);
    if (dither < diss) CULL()
    // The survivors dim a little as well, so the last few grains do not sit at full brightness.
    a *= 1.0 - 0.45 * diss;
  }
  if (a <= 0.004) CULL()
  vAlpha = a;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Same footprint law as the world lattice, against the DOG'S own pitch: its body is sampled
  // about three times finer than the map, so borrowing SURFEL_SPACING here would draw the dog as
  // a solid slab at any range you could actually hear it from.
  float px = uProjScale * uSpacing / max(0.05, -mv.z);
  float size = clamp(px, uMinPx, max(uCapPx, uMinPx));
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * uPixelRatio;
  vSize = size;
}
`;

const DOG_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;
varying float vSize;

${GRAIN_GLSL}

void main() {
  // The same phosphor grain as the matter layer, from the same definition: a dog is made of the
  // stuff the world is made of, not of a different, harder dot.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(vColor, vAlpha * grain(r, vSize));
}
`;

export class PhosphorDogs {
  readonly points: Points;

  private readonly geom = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private position = new Float32Array(0);
  private dither = new Float32Array(0);
  private born = new Float32Array(0);
  private kind = new Float32Array(0);
  private rank = new Float32Array(0);
  private quality = new Float32Array(0);
  private capacity = 0;
  private drawn = 0;
  /** The live attributes, in creation order, so a rebuild flags them without naming them again. */
  private readonly attrs: BufferAttribute[] = [];
  /**
   * Signature of the pose set currently in the buffer — rebuilt only when it changes.
   *
   * The pose set's fingerprint, as exact numbers rather than a string.
   *
   * This runs every frame purely to answer "did the pose set change?", so it must not allocate to
   * ask (engine-plan §10). Both buffers hold the same fields in the same order — id, pose count,
   * ghost count, newest pose time, each ghost's freeze time — so the comparison is exact and a
   * collision is impossible, which a hash could not promise. `sigPrevLen` is the live prefix of
   * what was last built (-1 = nothing yet); the buffers only ever grow.
   */
  private sig = new Float64Array(32);
  private sigPrev = new Float64Array(32);
  private sigPrevLen = -1;
  private readonly m = new Matrix4();

  constructor(constants: CoreConstants) {
    this.mat = new ShaderMaterial({
      uniforms: {
        uNow: { value: 0 },
        uCamPos: { value: [0, 0, 0] },
        uFloorCentre: { value: 0 },
        uFloorSpan: { value: 0 },
        uWindowRadius: { value: constants.WINDOW_RADIUS },
        uProjScale: { value: 500 },
        uPixelRatio: { value: 1 },
        uCapPx: { value: 12 },
        uMinPx: { value: constants.SPLAT_MIN_PX },
        uSpacing: { value: constants.SURFEL_SPACING },
        uAgeFlash: { value: constants.AGE_FLASH },
        uGhostLife: { value: constants.DOG_GHOST_LIFE },
        uGhostDissolve: { value: constants.DOG_GHOST_DISSOLVE },
        uSmearDecay: { value: DOG_SMEAR_DECAY },
        uAlpha: { value: DOG_ALPHA },
      },
      vertexShader: DOG_VERT,
      fragmentShader: DOG_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: true,
      // A dog is a read, not a surface: it must not occlude the geometry it is standing on.
      depthWrite: false,
    });
    this.points = new Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.visible = false;
  }

  /**
   * Merge every drawable pose of every dog into the one buffer.
   *
   * Rebuilt only when the pose SET changes — on a heard event, a freeze or a ghost expiring, never
   * per frame — because ageing is entirely a shader job: what a frame changes is the clock, and
   * the clock is a uniform.
   */
  update(dogs: readonly DogView[], fr: MarkFrame): void {
    let want = 0;
    for (const d of dogs) want += 4 + d.ghosts.length;
    if (want > this.sig.length) {
      // Amortised, like the pose buffers below: dog counts are capped per floor (vision §6).
      this.sig = new Float64Array(want);
      this.sigPrev = new Float64Array(want);
      this.sigPrevLen = -1;
    }

    const sig = this.sig;
    let need = 0;
    let spacing = 0;
    let len = 0;
    for (const d of dogs) {
      spacing = d.cloudSpacing;
      need += d.cloudGeom.getAttribute('position').count * (d.poseHistory.length + d.ghosts.length);
      sig[len++] = d.id;
      sig[len++] = d.poseHistory.length;
      sig[len++] = d.ghosts.length;
      const newest = d.poseHistory[d.poseHistory.length - 1];
      // A dog that has never sounded has no newest pose; a sentinel keeps the slot's meaning fixed.
      sig[len++] = newest ? newest.time : Number.NEGATIVE_INFINITY;
      for (const g of d.ghosts) sig[len++] = g.frozenAt;
    }

    const prev = this.sigPrev;
    let changed = len !== this.sigPrevLen;
    if (!changed) {
      for (let i = 0; i < len; i++) {
        if (sig[i] !== prev[i]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      for (let i = 0; i < len; i++) prev[i] = sig[i]!;
      this.sigPrevLen = len;
      this.rebuild(dogs, need);
    }

    this.points.visible = this.drawn > 0;
    if (!this.points.visible) return;

    const u = this.mat.uniforms;
    u.uNow!.value = fr.now;
    u.uCamPos!.value = fr.camPos;
    u.uFloorCentre!.value = fr.floorCentre;
    u.uFloorSpan!.value = fr.floorSpan;
    u.uProjScale!.value = fr.projScale;
    u.uPixelRatio!.value = fr.pixelRatio;
    u.uCapPx!.value = fr.capPx;
    if (spacing > 0) u.uSpacing!.value = spacing;
  }

  private rebuild(dogs: readonly DogView[], need: number): void {
    if (need > this.capacity) {
      // Grow in one step to what is asked for: the pose set is bounded by the ghost cap plus the
      // smear samples per dog, so this settles after the first busy moment of a run.
      this.capacity = need;
      this.position = new Float32Array(need * 3);
      this.dither = new Float32Array(need);
      this.born = new Float32Array(need);
      this.kind = new Float32Array(need);
      this.rank = new Float32Array(need);
      this.quality = new Float32Array(need);
      this.attrs.length = 0;
      const set = (name: string, a: Float32Array, size: number): void => {
        const b = new BufferAttribute(a, size);
        this.geom.setAttribute(name, b);
        this.attrs.push(b);
      };
      set('position', this.position, 3);
      set('dither', this.dither, 1);
      set('aBorn', this.born, 1);
      set('aKind', this.kind, 1);
      set('aRank', this.rank, 1);
      set('aQuality', this.quality, 1);
    }

    let w = 0;
    for (const d of dogs) {
      const pos = d.cloudGeom.getAttribute('position');
      const dit = d.cloudGeom.getAttribute('dither');
      const src = pos.array as ArrayLike<number>;
      const srcDither = dit.array as ArrayLike<number>;
      const n = pos.count;
      const poses = d.poseHistory;
      for (let p = 0; p < poses.length; p++) {
        // Rank 0 is the NEWEST sample: the smear fades backwards in time from the last thing
        // actually heard, so a dog that has just gone quiet still shows its freshest read at full.
        const sample = poses[p]!;
        w = this.writePose(src, srcDither, n, sample.matrix, sample.time, 0, poses.length - 1 - p, d.lastEventQuality, w);
      }
      for (const g of d.ghosts) {
        w = this.writePose(src, srcDither, n, g.pose.matrix, g.frozenAt, 1, 0, g.quality, w);
      }
    }
    this.drawn = w;
    this.geom.setDrawRange(0, w);
    for (let i = 0; i < this.attrs.length; i++) this.attrs[i]!.needsUpdate = true;
  }

  private writePose(
    src: ArrayLike<number>,
    srcDither: ArrayLike<number>,
    n: number,
    matrix: readonly number[],
    born: number,
    kind: number,
    rank: number,
    quality: number,
    w: number,
  ): number {
    this.m.fromArray(matrix as number[]);
    const e = this.m.elements;
    for (let i = 0; i < n; i++) {
      const x = src[i * 3]!;
      const y = src[i * 3 + 1]!;
      const z = src[i * 3 + 2]!;
      this.position[w * 3] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
      this.position[w * 3 + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
      this.position[w * 3 + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
      this.dither[w] = srcDither[i]!;
      this.born[w] = born;
      this.kind[w] = kind;
      this.rank[w] = rank;
      this.quality[w] = quality;
      w++;
    }
    return w;
  }

  dispose(): void {
    // The dog's own cloudGeom belongs to core (looks/types.ts) and is NOT touched here: this
    // geometry is the merged world-space copy, which is this look's own.
    this.geom.dispose();
    this.mat.dispose();
    this.points.visible = false;
  }
}
