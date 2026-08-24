/**
 * SIGNAL — the event layer: interference stains and the dog cloud with its dissolving ghosts.
 *
 * Vision §3.2 splits the screen in two. The cyan lattice says WHAT IS THERE; this file says WHAT
 * JUST HAPPENED. Geometry never takes a source's colour, and nothing drawn here writes depth — a
 * warm mark must never read as near matter (vision §12).
 *
 * THE COLOURBLIND LAW IS PAID HERE (vision §12, engine-plan §9). Every source carries a FORM, not
 * just a hue:
 *
 *   self         soft interference blob, no ornament
 *   dog          jagged sawtooth perimeter + one radial glitch dart along its real heading
 *   prop         a single square ripple, fired once
 *   objective    a coherence ring with a slow 4 s breath
 *   detonation   a white core with one expanding ring — the loudest mark in the game
 *   teammate     a steady square glyph pip at the centre (vision §3.2: "never hue alone")
 *
 * Two draw calls total. Ageing is entirely a shader job — what a frame changes is the clock, and
 * the clock is a uniform — so the CPU touches these buffers only when an event lands or a pose
 * set changes.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Matrix4,
  NormalBlending,
  Points,
  ShaderMaterial,
} from 'three';
import type { CoreConstants } from '../../core/const.js';
import type { DogView } from '../../core/dog.js';
import type { SoundEvent, SourceKind } from '../../core/events.js';
import { clamp01, lerp } from '../../core/math.js';
import { deliveredOrigin } from '../../core/paint.js';
import { CULL_POINT, HASH22, IGN, ROUND_BOX } from './glsl.js';
import * as P from './params.js';

/** Per-frame projection state both fields need. Written once, read by both materials. */
export interface MarkFrame {
  readonly now: number;
  readonly camPos: readonly [number, number, number];
  /** Pixels per metre at one metre of depth. */
  readonly projScale: number;
  readonly pixelRatio: number;
  /** Stain sprite ceiling and the dot cap, both in CSS px. */
  readonly stainCapPx: number;
  readonly dotCapPx: number;
  readonly viewport: readonly [number, number];
  readonly floorCentre: number;
  readonly floorSpan: number;
}

// ---------------------------------------------------------------------------------------------
// Interference stains
// ---------------------------------------------------------------------------------------------

/**
 * How many stains may be alive at once. A ring, oldest overwritten first.
 *
 * A HARD pool with oldest-first eviction for the same reason the surfel pool is (vision §12): a
 * mark layer that can grow without bound is a way for the screen to become porridge that no fence
 * can see coming. The longest fade is 6 s and the loudest legal storm is well under ten events a
 * second, so this holds the whole window with room to spare.
 */
const STAIN_CAP = 96;

/** Form ids, shared with the fragment shader below. */
const FORM: Record<SourceKind, number> = {
  self: 0,
  dog: 1,
  prop: 2,
  objective: 3,
  detonation: 4,
  teammate: 5,
};

const STAIN_VERT = /* glsl */ `
attribute vec3  aColor;
attribute vec3  aHeading;
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
uniform float uDetGain;
uniform float uDetFlash;
uniform vec2  uViewport;

varying vec3  vColor;
varying float vAlpha;
varying float vSharp;
varying float vForm;
varying float vSeed;
varying float vAge;
varying float vFade;
varying vec2  vDart;
varying float vHasDart;

${CULL_POINT}

void main() {
  // A dead slot has aFade 0 and is culled by the same test that retires a finished stain — the
  // ring never needs a separate "is this one real" flag.
  float age = uNow - aBorn;
  if (aFade <= 0.0 || age < 0.0 || age > aFade) CULL()
  if (distance(position, uCamPos) > uWindowRadius) CULL()
  if (abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // Squared tail: a stain leaves rather than switching off, which is what makes a repeating
  // source (a gait, a slide) read as a trail of marks of different ages instead of a flicker.
  float fall = 1.0 - age / aFade;
  vAlpha = aPeak * clamp(age / uOnset, 0.0, 1.0) * fall * fall;

  // THE FLASHBULB, and the one place this layer is allowed off its leash. Every other stain is
  // held under STAIN_A_HIGH so it stays an airy wash and never a surface, but that ceiling also
  // caps an additive white at about half brightness — which turns vision §3.2's "detonation =
  // white flash" into a grey smudge, and §6's "22 m flashbulb" into nothing in particular. The
  // gain is a short exponential rather than a raised ceiling, so what goes white is the CORE for
  // a moment; the mark then rejoins the ordinary wash and fades on its own tail. uDetGain is
  // lowered on the CPU under reduce-flashing, where this must resolve as a fade and not a strobe.
  if (aForm > 3.5 && aForm < 4.5) vAlpha *= 1.0 + (uDetGain - 1.0) * exp(-age / uDetFlash);

  if (vAlpha <= 0.004) CULL()

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // The glitch dart points along the dog's REAL heading, projected to the sprite's own pixel
  // space. Core hands over pose matrices; the heading is the difference between the two newest
  // ones (see SignalStains.headingFor). Nothing here is predicted — it is where the dog has just
  // been going, drawn at the origin the sound was delivered from.
  vHasDart = 0.0;
  vDart = vec2(1.0, 0.0);
  if (dot(aHeading, aHeading) > 1.0e-6) {
    vec4 c1 = projectionMatrix * (modelViewMatrix * vec4(position + aHeading, 1.0));
    if (c1.w > 1.0e-4 && gl_Position.w > 1.0e-4) {
      vec2 d = (c1.xy / c1.w - gl_Position.xy / gl_Position.w) * uViewport;
      if (dot(d, d) > 1.0e-8) {
        vDart = normalize(d);
        vHasDart = 1.0;
      }
    }
  }

  // The stain's radius is a real distance in the world, so it shrinks with range like everything
  // else — but it is capped, or a low-quality 2 m smudge heard from three metres away is most of
  // the frame. The cap is larger than a splat's because a FORM needs area to be a form.
  float px = uProjScale * (aRadius * 2.0) / max(0.05, -mv.z);
  gl_PointSize = clamp(px, uMinPx, max(uCapPx, uMinPx)) * uPixelRatio;

  vColor = aColor;
  vSharp = aSharp;
  vForm = aForm;
  vSeed = aSeed;
  vAge = age;
  vFade = aFade;
}
`;

const STAIN_FRAG = /* glsl */ `
uniform float uNow;
uniform float uCalm;
uniform float uNoiseHz;
uniform float uNoiseAmt;
uniform float uCellsHigh;
uniform float uCellsLow;
uniform float uJagTeeth;
uniform float uJagDepth;
uniform float uDartLen;
uniform float uDartWidth;
uniform float uDartLife;
uniform float uRippleSpan;
uniform float uRippleWidth;
uniform float uBreath;
uniform float uDetSpan;
uniform float uPip;
uniform float uPipBar;
uniform float uDither;

varying vec3  vColor;
varying float vAlpha;
varying float vSharp;
varying float vForm;
varying float vSeed;
varying float vAge;
varying float vFade;
varying vec2  vDart;
varying float vHasDart;

${HASH22}
${IGN}

#define TAU 6.28318530718

void main() {
  // Sprite space: -1..1, y up, so the dart's screen direction and this agree.
  vec2 p = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y) * 2.0;
  float r = length(p);
  float form = vForm;

  // Perimeter. Only the dog's is broken: a jagged sawtooth, phase fixed by the event's own seed,
  // so a gait trail reads as a row of torn blobs rather than a row of discs.
  float edgeR = 1.0;
  if (form > 0.5 && form < 1.5) {
    float saw = fract(atan(p.y, p.x) * (uJagTeeth / TAU) + vSeed);
    edgeR = 1.0 - uJagDepth * saw;
  }
  float rn = r / max(0.25, edgeR);

  // Coherence breath (objective): the stain periodically almost resolves and lets go again. It
  // moves DEFINITION, never brightness — a 4 s luminance pulse is a strobe by another name.
  float sharp = vSharp;
  if (form > 2.5 && form < 3.5) {
    float breath = (uCalm > 0.5) ? 0.6 : 0.5 + 0.5 * sin(TAU * uNow / uBreath);
    sharp = mix(vSharp * 0.45, min(1.0, vSharp * 1.25), breath);
  }

  // The blob itself: definition, not just brightness (visual-brief §1.13). A high exponent puts
  // nearly all the energy in a small core and leaves the rim at nothing — "almost-shaped". A low
  // one spreads it flat across the whole disc — a smudge whose edge you cannot place.
  float body = pow(max(0.0, 1.0 - rn * rn), mix(1.2, 3.4, sharp));

  // Interference: a faint interior noise, chroma-stable, quantized in time so it steps at
  // uNoiseHz rather than crawling. High quality gives few large cells (coherent, almost a shape);
  // low quality gives many small ones (static you cannot lock onto). Frozen under reduce-flashing.
  float cells = mix(uCellsLow, uCellsHigh, sharp);
  float tq = (uCalm > 0.5) ? 0.0 : floor(uNow * uNoiseHz);
  float n = hash21(floor(p * cells * 0.5 + 0.5) + vec2(vSeed * 37.0, tq));
  body *= 1.0 - uNoiseAmt * mix(0.55, 1.0, sharp) * n;

  float extra = 0.0;

  // Dog: one radial glitch dart per gait tick, toward its heading. Motion, not flash — it stays
  // under reduce-flashing (signal.md "darts remain").
  if (form > 0.5 && form < 1.5 && vHasDart > 0.5) {
    float along = dot(p, vDart);
    float across = abs(p.x * -vDart.y + p.y * vDart.x);
    float env = clamp(1.0 - vAge / uDartLife, 0.0, 1.0);
    extra += step(0.0, along)
      * (1.0 - smoothstep(0.2, uDartLen, along))
      * (1.0 - smoothstep(uDartWidth * 0.4, uDartWidth, across))
      * env * 0.9;
  }

  // Prop: a single square ripple, fired once and gone. Square because the sample lattice is.
  if (form > 1.5 && form < 2.5) {
    float chev = max(abs(p.x), abs(p.y));
    float rr = clamp(vAge / max(1.0e-3, vFade * uRippleSpan), 0.0, 1.0);
    float d = (chev - rr) / uRippleWidth;
    extra += exp(-d * d) * (1.0 - rr) * 0.85;
  }

  // Objective: the coherence ring the breath is breathing.
  if (form > 2.5 && form < 3.5) {
    float d = (r - 0.72) / 0.1;
    extra += exp(-d * d) * 0.7;
  }

  // Detonation: white core plus one expanding ring — vision §6's flashbulb, and the only
  // sanctioned violence in the look.
  if (form > 3.5 && form < 4.5) {
    float rr = clamp(vAge / max(1.0e-3, vFade * uDetSpan), 0.0, 1.0);
    float d = (r - rr) / 0.09;
    extra += exp(-d * d) * (1.0 - rr) * 1.3;
    body *= mix(1.7, 1.0, rr);
  }

  // Teammate: a steady square glyph pip. Steady on purpose — vision §3.2 wants a pip you can find
  // at a glance for the whole life of the mark, not a shape that has to be caught.
  if (form > 4.5) {
    float bar = max(
      (1.0 - step(uPip, abs(p.x))) * (1.0 - step(uPipBar, abs(p.y))),
      (1.0 - step(uPip, abs(p.y))) * (1.0 - step(uPipBar, abs(p.x)))
    );
    extra += bar * 0.8;
  }

  float v = min(1.7, body + extra);
  if (v <= 0.002) discard;

  vec3 c = vColor + (ign(gl_FragCoord.xy) - 0.5) * uDither;
  gl_FragColor = vec4(c, vAlpha * v);
}
`;

export class SignalStains {
  readonly points: Points;

  private readonly geom = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly heading: Float32Array;
  private readonly born: Float32Array;
  private readonly fade: Float32Array;
  private readonly radius: Float32Array;
  private readonly peak: Float32Array;
  private readonly sharp: Float32Array;
  private readonly form: Float32Array;
  private readonly seed: Float32Array;
  private write = 0;
  /**
   * Set by `stamp`, cleared by `update`. The ring's contents are pure event history: every slot
   * holds a birth time and a decay the SHADER evaluates against `uNow`, so an unstamped frame has
   * nothing new to send. Without this the layer re-uploaded all ten attributes every frame that
   * any stain was alive — ten `bufferSubData` calls to write back bytes that had not changed.
   */
  private dirty = false;
  private readonly fadeMin: number;
  private readonly fadeMax: number;
  private readonly calm: boolean;

  constructor(constants: CoreConstants, reduceFlashing: boolean) {
    this.fadeMin = constants.STAIN_FADE_MIN;
    this.fadeMax = constants.STAIN_FADE_MAX;
    this.calm = reduceFlashing;

    this.position = new Float32Array(STAIN_CAP * 3);
    this.color = new Float32Array(STAIN_CAP * 3);
    this.heading = new Float32Array(STAIN_CAP * 3);
    this.born = new Float32Array(STAIN_CAP);
    this.fade = new Float32Array(STAIN_CAP);
    this.radius = new Float32Array(STAIN_CAP);
    this.peak = new Float32Array(STAIN_CAP);
    this.sharp = new Float32Array(STAIN_CAP);
    this.form = new Float32Array(STAIN_CAP);
    this.seed = new Float32Array(STAIN_CAP);

    const attr = (a: Float32Array, size: number): BufferAttribute => {
      const b = new BufferAttribute(a, size);
      b.setUsage(DynamicDrawUsage);
      return b;
    };
    this.geom.setAttribute('position', attr(this.position, 3));
    this.geom.setAttribute('aColor', attr(this.color, 3));
    this.geom.setAttribute('aHeading', attr(this.heading, 3));
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
        uCapPx: { value: 64 },
        uMinPx: { value: P.STAIN_MIN_PX },
        uOnset: { value: reduceFlashing ? P.STAIN_ONSET_CALM : P.STAIN_ONSET },
        uDetGain: { value: reduceFlashing ? P.DETONATION_FLASH_GAIN_CALM : P.DETONATION_FLASH_GAIN },
        uDetFlash: { value: P.DETONATION_FLASH_S },
        uViewport: { value: [1, 1] },
        uCalm: { value: reduceFlashing ? 1 : 0 },
        uNoiseHz: { value: P.STAIN_NOISE_HZ },
        uNoiseAmt: { value: P.STAIN_NOISE_AMT },
        uCellsHigh: { value: P.STAIN_NOISE_CELLS_HIGH },
        uCellsLow: { value: P.STAIN_NOISE_CELLS_LOW },
        uJagTeeth: { value: P.DOG_JAG_TEETH },
        uJagDepth: { value: P.DOG_JAG_DEPTH },
        uDartLen: { value: P.DOG_DART_LEN },
        uDartWidth: { value: P.DOG_DART_WIDTH },
        uDartLife: { value: P.DOG_DART_LIFE },
        uRippleSpan: { value: P.PROP_RIPPLE_SPAN },
        uRippleWidth: { value: P.PROP_RIPPLE_WIDTH },
        uBreath: { value: P.OBJECTIVE_BREATH_S },
        uDetSpan: { value: P.DETONATION_RING_SPAN },
        uPip: { value: P.TEAMMATE_PIP },
        uPipBar: { value: P.TEAMMATE_PIP_BAR },
        uDither: { value: P.FRAME_DITHER },
      },
      vertexShader: STAIN_VERT,
      fragmentShader: STAIN_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: true,
      // The event layer annotates the matter layer; it never hides it.
      depthWrite: false,
    });

    this.points = new Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = false;
  }

  /**
   * Stamp one delivered event.
   *
   * The origin is the one PAINT used, so the mark and the geometry it lit agree about where the
   * sound was — including the +/-2 m fuzz of a through-wall read, which is drawn as SPREAD rather
   * than as a second position (vision §3.4, visual-brief §2). `heading` is the dog's real recent
   * motion or null; a dart is never drawn without one.
   */
  stamp(e: SoundEvent, heading: readonly [number, number, number] | null): void {
    const q = clamp01(e.quality);
    const i = this.write;
    this.write = (this.write + 1) % STAIN_CAP;
    this.dirty = true;

    const o = deliveredOrigin(e);
    this.position[i * 3] = o[0];
    this.position[i * 3 + 1] = o[1];
    this.position[i * 3 + 2] = o[2];

    const hue = P.EVENT_RGB[e.source];
    this.color[i * 3] = hue[0];
    this.color[i * 3 + 1] = hue[1];
    this.color[i * 3 + 2] = hue[2];

    this.heading[i * 3] = heading ? heading[0] : 0;
    this.heading[i * 3 + 1] = heading ? heading[1] : 0;
    this.heading[i * 3 + 2] = heading ? heading[2] : 0;

    this.born[i] = e.time;
    // A confident read lingers; a vague one is gone before you can act on it (vision §3.2's
    // 2.5-6 s window, spent on the events that told you something).
    this.fade[i] = lerp(this.fadeMin, this.fadeMax, q);
    this.radius[i] = lerp(P.STAIN_R_HIGH, P.STAIN_R_LOW, q) * P.STAIN_RADIUS_GAIN[e.source];
    this.peak[i] = lerp(P.STAIN_A_LOW, P.STAIN_A_HIGH, q) * (this.calm ? P.STAIN_CALM_ALPHA : 1);
    this.sharp[i] = q;
    this.form[i] = FORM[e.source];
    this.seed[i] = e.fuzzSeed;
  }

  update(f: MarkFrame): void {
    // A stain layer with nothing in it is not drawn at all: vision §1.3's black world has to
    // survive an empty ring, and a draw call that renders nothing is still a draw call.
    let live = 0;
    for (let i = 0; i < STAIN_CAP; i++) {
      const fade = this.fade[i]!;
      if (fade > 0 && f.now - this.born[i]! <= fade) live++;
    }
    this.points.visible = live > 0;
    if (!this.points.visible) return;

    if (this.dirty) {
      for (const name of ATTR_NAMES) this.geom.getAttribute(name).needsUpdate = true;
      this.dirty = false;
    }
    const u = this.mat.uniforms;
    u.uNow!.value = f.now;
    u.uCamPos!.value = f.camPos;
    u.uFloorCentre!.value = f.floorCentre;
    u.uFloorSpan!.value = f.floorSpan;
    u.uProjScale!.value = f.projScale;
    u.uPixelRatio!.value = f.pixelRatio;
    u.uCapPx!.value = f.stainCapPx;
    u.uViewport!.value = f.viewport;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
    this.points.visible = false;
  }
}

const ATTR_NAMES = [
  'position',
  'aColor',
  'aHeading',
  'aBorn',
  'aFade',
  'aRadius',
  'aPeak',
  'aSharp',
  'aForm',
  'aSeed',
] as const;

// ---------------------------------------------------------------------------------------------
// The dog cloud and its Bayer-dissolving ghosts
// ---------------------------------------------------------------------------------------------

/** A 4x4 ordered (Bayer) matrix, flattened. The wink-out order of a ghost's samples. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

const DOG_VERT = /* glsl */ `
attribute float aBorn;
attribute float aKind;
attribute float aRank;
attribute float aQuality;
attribute float aBayer;

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
uniform float uGhostLife;
uniform float uGhostDissolve;
uniform float uDissolveStart;
uniform float uSmearDecay;
uniform float uAlpha;
uniform vec3  uHot;
uniform vec3  uMid;
uniform vec3  uRust;

varying vec3  vColor;
varying float vAlpha;
varying float vSizePx;

${CULL_POINT}

void main() {
  if (distance(position, uCamPos) > uWindowRadius) CULL()
  if (abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  float a = uAlpha * aQuality;
  if (aKind < 0.5) {
    // Live smear: every pose is a real photograph, the older ones fainter. Not a blur — the
    // renderer may not invent the frames between two things it was told (vision §3.7). The cloud
    // stays in the matter band (signal.md: the decoder prioritises terrain over threats; the
    // red-orange stain does the threat-shouting).
    //
    // Flat uHot, with NO birth flash on the pose. A trotting dog emits its gait every 0.8 m, which
    // at patrol speed is a fresh stamp roughly every 0.27 s, so any onset flash longer than that
    // never resolves — the newest pose sits permanently at the flash colour and the cloud reads
    // white instead of the cyan the law asks for, wearing the one value this look reserves for a
    // detonation. Signal's glitch belongs to births and deaths of information; a dog being heard
    // again is neither, so the live cloud holds one steady colour and lets the RANK decay carry
    // the smear.
    vColor = uHot;
    a *= pow(uSmearDecay, aRank);
  } else {
    // A ghost: freeze, cool, then visibly deallocate. Samples wink out in Bayer order rather than
    // fading as a sheet, so the dissolve reads as data being freed and never as a dimmer.
    float age = max(0.0, uNow - aBorn);
    float t = clamp(age / uGhostLife, 0.0, 1.0);
    // Cooling has to be MONOTONE in brightness or age stops being readable in the middle of the
    // ramp. The waypoint is the mid cyan, not the dark cool navy: routing hot -> cool -> rust
    // dives to the navy's luminance by half-life and then flattens, so every ghost between ~4 s
    // and ~10 s looks the same dim smudge. Through the mid cyan the run falls steadily from ice
    // to rust, which is what vision §3.7's "hot -> rust" is for — age as temperature, one
    // direction, no dead zone.
    vColor = t < 0.5 ? mix(uHot, uMid, t / 0.5) : mix(uMid, uRust, (t - 0.5) / 0.5);
    float span = uGhostLife * (1.0 - uDissolveStart) + uGhostDissolve;
    float d = clamp((age - uGhostLife * uDissolveStart) / max(1.0e-4, span), 0.0, 1.0);
    if (aBayer < d) CULL()
  }
  if (a <= 0.004) CULL()
  vAlpha = a;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Same footprint law as the world lattice, against the dog's own pitch widened by one step:
  // fewer, larger samples than the terrain around it.
  float px = uProjScale * uSpacing / max(0.05, -mv.z);
  gl_Position = projectionMatrix * mv;
  vSizePx = clamp(px, uMinPx, max(uCapPx, uMinPx)) * uPixelRatio;
  gl_PointSize = vSizePx;
}
`;

const DOG_FRAG = /* glsl */ `
uniform float uCorner;
uniform float uSoftPx;
uniform float uPixelRatio;
uniform float uDither;

varying vec3  vColor;
varying float vAlpha;
varying float vSizePx;

${ROUND_BOX}
${IGN}

void main() {
  vec2 p = (gl_PointCoord - 0.5) * 2.0;
  float aa = max(0.02, 2.0 * uSoftPx * uPixelRatio / max(2.0, vSizePx));
  float m = 1.0 - smoothstep(-aa, aa, roundBox(p, 1.0, uCorner));
  if (m <= 0.004) discard;
  vec3 c = vColor + (ign(gl_FragCoord.xy) - 0.5) * uDither;
  gl_FragColor = vec4(c, vAlpha * m);
}
`;

export class SignalDogs {
  readonly points: Points;

  private readonly geom = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private position = new Float32Array(0);
  private born = new Float32Array(0);
  private kind = new Float32Array(0);
  private rank = new Float32Array(0);
  private quality = new Float32Array(0);
  private bayer = new Float32Array(0);
  private capacity = 0;
  private drawn = 0;
  /**
   * Exact key of the pose set currently in the buffer — the buffer is rebuilt only when it changes.
   *
   * Every field is a number, so the key is a flat array compared element by element: not a hash,
   * because a collision here would hold a stale pose on screen and the whole Lantern Test rests on
   * a dog's cloud being where it was last heard. Each dog contributes a fixed four fields plus one
   * per ghost, and the ghost count is one of the four, so the encoding is unambiguous. `keyLen`
   * starts negative so the first frame always rebuilds.
   */
  private key = new Float64Array(0);
  private nextKey = new Float64Array(0);
  private keyLen = -1;
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
        uCapPx: { value: 14 },
        uMinPx: { value: constants.SPLAT_MIN_PX },
        uSpacing: { value: constants.SURFEL_SPACING },
        uGhostLife: { value: constants.DOG_GHOST_LIFE },
        uGhostDissolve: { value: constants.DOG_GHOST_DISSOLVE },
        uDissolveStart: { value: P.GHOST_DISSOLVE_START },
        uSmearDecay: { value: P.DOG_SMEAR_DECAY },
        uAlpha: { value: P.DOG_ALPHA },
        uHot: { value: [...P.PALETTE.hot] },
        uMid: { value: [...P.PALETTE.mid] },
        uRust: { value: [...P.PALETTE.rust] },
        uCorner: { value: P.DOT_CORNER },
        uSoftPx: { value: P.DOT_SOFT_PX },
        uDither: { value: P.FRAME_DITHER },
      },
      vertexShader: DOG_VERT,
      fragmentShader: DOG_FRAG,
      transparent: true,
      // NOT additive, unlike the stain layer, and the brief is what decides it: "Dog cloud in
      // matter cyan (law)" puts this cloud in the matter band, and the matter band is blended
      // normally. The difference is not stylistic. A dog is drawn as up to DOG_SMEAR_COPIES
      // overlapping poses plus any still-cooling ghosts in the same place, and summing four
      // layers of #6EE8FF at DOG_ALPHA clips every channel to 1 — the cloud turns into a white
      // mass, which loses the cyan the law asks for, loses the ghost's rust cooling underneath
      // it, and reads as the one colour reserved for a detonation flash. Normal blending keeps
      // a stack of samples the same hue as one sample, so density reads as density and age
      // stays legible. The red-orange stain and its darts stay additive: that layer is a wash
      // over the world and is what shouts "threat" (signal.md "Dog & ghosts").
      blending: NormalBlending,
      depthTest: true,
      // A dog is a read, not a surface: it must not occlude the geometry it is standing on.
      depthWrite: false,
    });
    this.points = new Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.visible = false;
  }

  /**
   * Merge every drawable pose of every dog into the one buffer.
   *
   * Rebuilt only when the pose SET changes — on a heard event, a freeze or a ghost expiring, never
   * per frame — because ageing is entirely a shader job.
   */
  update(dogs: readonly DogView[], f: MarkFrame): void {
    // Size the key first, from counts alone — no geometry is touched, so this pre-pass is a walk
    // over a handful of small arrays and it lets the write loop below run without bounds checks.
    let keyLen = dogs.length * 4;
    for (const d of dogs) keyLen += d.ghosts.length;
    if (keyLen > this.nextKey.length) this.nextKey = new Float64Array(keyLen);
    const key = this.nextKey;

    let k = 0;
    let need = 0;
    let spacing = 0;
    for (const d of dogs) {
      const n = d.cloudGeom.getAttribute('position').count;
      spacing = d.cloudSpacing;
      const smear = Math.min(d.poseHistory.length, P.DOG_SMEAR_COPIES);
      need += n * (smear + d.ghosts.length);
      const newest = d.poseHistory[d.poseHistory.length - 1];
      key[k++] = d.id;
      key[k++] = smear;
      key[k++] = d.ghosts.length;
      // Sim time is never negative, so -1 is an unambiguous "this dog has made no sound yet".
      key[k++] = newest ? newest.time : -1;
      for (const g of d.ghosts) key[k++] = g.frozenAt;
    }

    let changed = keyLen !== this.keyLen;
    if (!changed) {
      for (let i = 0; i < keyLen; i++) {
        if (this.key[i] !== key[i]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      // Swap rather than copy: both arrays are owned here, and next frame's pre-pass regrows
      // whichever one ends up on the scratch side if it is short.
      this.nextKey = this.key;
      this.key = key;
      this.keyLen = keyLen;
      this.rebuild(dogs, need);
    }

    this.points.visible = this.drawn > 0;
    if (!this.points.visible) return;

    const u = this.mat.uniforms;
    u.uNow!.value = f.now;
    u.uCamPos!.value = f.camPos;
    u.uFloorCentre!.value = f.floorCentre;
    u.uFloorSpan!.value = f.floorSpan;
    u.uProjScale!.value = f.projScale;
    u.uPixelRatio!.value = f.pixelRatio;
    u.uCapPx!.value = f.dotCapPx * P.DOG_COARSE_SCALE;
    if (spacing > 0) u.uSpacing!.value = spacing * P.DOG_COARSE_SCALE;
  }

  private rebuild(dogs: readonly DogView[], need: number): void {
    if (need > this.capacity) {
      // Grow in one step to what is asked for: the pose set is bounded by DOG_MAX_GHOSTS plus the
      // smear copies per dog, so this settles after the first busy moment of a run. The buffer is
      // sized for the un-decimated worst case; the draw range is what shrinks.
      this.capacity = need;
      this.position = new Float32Array(need * 3);
      this.born = new Float32Array(need);
      this.kind = new Float32Array(need);
      this.rank = new Float32Array(need);
      this.quality = new Float32Array(need);
      this.bayer = new Float32Array(need);
      this.geom.setAttribute('position', new BufferAttribute(this.position, 3));
      this.geom.setAttribute('aBorn', new BufferAttribute(this.born, 1));
      this.geom.setAttribute('aKind', new BufferAttribute(this.kind, 1));
      this.geom.setAttribute('aRank', new BufferAttribute(this.rank, 1));
      this.geom.setAttribute('aQuality', new BufferAttribute(this.quality, 1));
      this.geom.setAttribute('aBayer', new BufferAttribute(this.bayer, 1));
    }

    let w = 0;
    for (const d of dogs) {
      const src = d.cloudGeom.getAttribute('position').array as ArrayLike<number>;
      const n = d.cloudGeom.getAttribute('position').count;
      const poses = d.poseHistory;
      const first = Math.max(0, poses.length - P.DOG_SMEAR_COPIES);
      // WRITE ORDER IS PAINT ORDER, and it runs oldest-to-newest on purpose. The samples in one
      // Points object rasterise in buffer order, and this layer blends normally without writing
      // depth, so whatever is written last sits on top. The freshest read must be the one that
      // wins: ghosts (a memory) go down first, oldest first so a newer freeze covers an older
      // one, and the live smear goes over them, ending on rank 0 — the last thing actually
      // heard. Reversed, a stale ghost would paint over the dog's current position.
      for (const g of d.ghosts) {
        w = this.writePose(src, n, g.pose.matrix, g.frozenAt, 1, 0, g.quality, w);
      }
      for (let p = first; p < poses.length; p++) {
        // Rank 0 is the NEWEST sample. The smear fades backwards in time from the last thing
        // actually heard, so a dog that has just gone quiet still shows its freshest read at full.
        const pose = poses[p]!;
        w = this.writePose(src, n, pose.matrix, pose.time, 0, poses.length - 1 - p, d.lastEventQuality, w);
      }
    }
    this.drawn = w;
    this.geom.setDrawRange(0, w);
    if (this.capacity > 0) {
      for (const name of ['position', 'aBorn', 'aKind', 'aRank', 'aQuality', 'aBayer']) {
        this.geom.getAttribute(name).needsUpdate = true;
      }
    }
  }

  private writePose(
    src: ArrayLike<number>,
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
      // "sampled one lattice step coarser than the world" — half the samples, each drawn wider.
      // Decimated in ORDERED Bayer order off the sample's own index, so the same samples survive
      // in every pose and every frame: a cloud that reshuffles is unreadable at parkour speed.
      const b = BAYER4[(i & 3) + 4 * ((i >> 2) & 3)]! / 16;
      if (b >= P.DOG_COARSE_KEEP) continue;
      const x = src[i * 3]!;
      const y = src[i * 3 + 1]!;
      const z = src[i * 3 + 2]!;
      this.position[w * 3] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
      this.position[w * 3 + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
      this.position[w * 3 + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
      this.born[w] = born;
      this.kind[w] = kind;
      this.rank[w] = rank;
      this.quality[w] = quality;
      this.bayer[w] = b / P.DOG_COARSE_KEEP;
      w++;
    }
    return w;
  }

  dispose(): void {
    // The dog's own cloudGeom belongs to core and is NOT touched here (looks/types.ts): this
    // geometry is the merged world-space copy, which is this look's own.
    this.geom.dispose();
    this.mat.dispose();
    this.points.visible = false;
  }
}
