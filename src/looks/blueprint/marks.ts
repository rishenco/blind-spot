/**
 * BLUEPRINT — the event layer: graphite noise stains, and the dog with its silhouette line work.
 *
 * Vision §3.2 splits the screen in two. The ice-blue lattice says WHAT IS THERE; this file says
 * WHAT JUST HAPPENED, and the two must never be confusable — so a stain here is PENCIL: matte,
 * soft-edged, normal-blended (never additive, which is how a mark starts to glow like geometry),
 * and annotated with draftsman's marks that no piece of world geometry ever wears.
 *
 * THE COLOURBLIND LAW (vision §12, engine-plan §9) is paid in FORM, not hue. Every source gets a
 * mark you could read in greyscale:
 *
 *   self         smudge + containment circle + straight hatch strokes along its heading
 *   dog          smudge + containment circle + hatch strokes that JAG
 *   prop         smudge + a single containment ring that EXPANDS and fades — no hatch
 *   objective    smudge + containment circle + a small DIAMOND
 *   teammate     smudge + containment circle + a SQUARE pip (vision §3.2 asks for the pip by name)
 *   detonation   smudge + a fast expanding ring + a large lozenge
 *
 * ...and quality is the second, orthogonal channel — but it may only take away the mark that means
 * WHERE, never the marks that mean WHAT. A vague read loses its containment circle and becomes a
 * wide pale edgeless cloud (doc/looks/blueprint.md: "containment circle absent — an uncommitted
 * pencil smudge"); its hatch strokes and its glyph stay, because a dog heard through a wall is the
 * exact case the shape channel exists for. The brief's own acceptance moment says so — "Lantern
 * rig: pencil smudge sliding along the wall, hatch strokes pointing its heading" is a through-wall
 * read — and the colourblind law would otherwise be paid only when the player needs it least.
 *
 * WHAT IS LAW HERE rather than styling: the hard window (45 m, ±1 floor) applies to marks exactly
 * as it does to geometry; a stain sits at `deliveredOrigin` — the origin the MATTER was painted
 * from, fuzzed and all — because two answers to "where did that happen" is a lie; a ghost ages
 * from `frozenAt` on the render clock and is never interpolated or predicted (vision §3.7).
 *
 * Three draw calls total: one for every smudge, one for every draftsman's mark, one for every dog
 * pose and ghost alive.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  LineSegments,
  Matrix4,
  Points,
  ShaderMaterial,
  type Scene,
} from 'three';
import type { CoreConstants } from '../../core/const.js';
import type { DogView } from '../../core/dog.js';
import type { SoundEvent, SourceKind } from '../../core/events.js';
import { clamp01, lerp } from '../../core/math.js';
import { deliveredOrigin } from '../../core/paint.js';
import type { BlueprintFrame } from './frame.js';
import {
  DOG_BODY_ALPHA,
  DOG_SIL_ALPHA,
  DOG_SMEAR_DECAY,
  GHOST_COLLAPSE_S,
  PALETTE,
  SIL_EDGE,
  STAIN_A_HIGH,
  STAIN_A_LOW,
  STAIN_CALM_ALPHA,
  STAIN_CAP,
  STAIN_GLYPH_R,
  STAIN_HATCH_GAP,
  STAIN_HATCH_JAG,
  STAIN_HATCH_LEN,
  STAIN_MARK_Q,
  STAIN_MIN_PX,
  STAIN_ONSET,
  STAIN_ONSET_CALM,
  STAIN_R_HIGH,
  STAIN_R_LOW,
  STAIN_RING_ALPHA,
  STAIN_RING_EXPAND,
  type RGB,
} from './params.js';

/**
 * How far a mark may outgrow the near-field dot cap.
 *
 * There has to be a ceiling at all — a low-quality 2.2 m smudge two metres from the eye is most of
 * the frame without one. But holding a stain to the same ceiling as a single DOT is the wrong
 * ceiling by an order of magnitude: at a lantern's range that ceiling turns a ±2 m uncertainty
 * cloud into a twenty-pixel speck, and the width of a vague read IS the reading (visual-brief
 * §1.13). Half a dozen splats wide is a pencil smudge you can see slide along a wall — the brief's
 * acceptance moment 3 — and still nowhere near able to swallow the frame. Marks and smudge share
 * the multiple so the annotation never separates from the thing it annotates.
 */
const STAIN_CAP_MULT = 5.5;

const INK: Record<SourceKind, RGB> = {
  self: PALETTE.self,
  teammate: PALETTE.teammate,
  dog: PALETTE.dog,
  prop: PALETTE.prop,
  objective: PALETTE.objective,
  detonation: PALETTE.detonation,
};

// ---------------------------------------------------------------------------------------------
// Smudges
// ---------------------------------------------------------------------------------------------

const SMUDGE_VERT = /* glsl */ `
attribute vec3  aColor;
attribute float aBorn;
attribute float aFade;
attribute float aRadius;
attribute float aPeak;
attribute float aSharp;

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

varying vec3  vColor;
varying float vAlpha;
varying float vSharp;

#define CULL() { vColor = vec3(0.0); vAlpha = 0.0; vSharp = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

void main() {
  // A dead slot has aFade 0 and is culled by the same test that retires a finished stain.
  float age = uNow - aBorn;
  if (aFade <= 0.0 || age < 0.0 || age > aFade) CULL()
  if (distance(position, uCamPos) > uWindowRadius) CULL()
  if (abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // Squared tail: a stain LEAVES rather than switching off, which is what makes a repeating source
  // (a gait, a slide) read as a trail of marks of different ages instead of a flicker.
  float fall = 1.0 - age / aFade;
  vAlpha = aPeak * clamp(age / uOnset, 0.0, 1.0) * fall * fall;
  if (vAlpha <= 0.004) CULL()

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float px = uProjScale * (aRadius * 2.0) / max(0.05, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(px, uMinPx, max(uCapPx, uMinPx)) * uPixelRatio;
  vColor = aColor;
  vSharp = aSharp;
}
`;

const SMUDGE_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;
varying float vSharp;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  // Graphite, not light. A high exponent puts most of the ink in a small dense core; a low one
  // spreads it flat across the whole disc — a cloud whose edge you cannot place. Neither exponent
  // ever produces a boundary: "stains must never gain sharp boundaries" is one of the brief's
  // don'ts, and the containment CIRCLE is where a confident read gets its edge instead.
  float profile = pow(1.0 - r2, mix(1.1, 2.6, vSharp));
  gl_FragColor = vec4(vColor, vAlpha * profile);
}
`;

// ---------------------------------------------------------------------------------------------
// Draftsman's marks
// ---------------------------------------------------------------------------------------------

/** Segments in a containment circle. 16 is round at the sizes a mark is allowed to reach. */
const RING_N = 16;
const RING_VERTS = RING_N * 2;
/** Two strokes of three segments each: the middle joints are where a dog's jag lives. */
const HATCH_VERTS = 2 * 3 * 2;
const GLYPH_VERTS = 4 * 2;
const MARK_VERTS = RING_VERTS + HATCH_VERTS + GLYPH_VERTS;

const ROLE_RING = 0;
const ROLE_HATCH = 1;
const ROLE_GLYPH = 2;

const MARK_VERT = /* glsl */ `
attribute vec2  aLocal;
attribute vec2  aJag;
attribute float aRole;
attribute vec3  aColor;
attribute float aBorn;
attribute float aFade;
attribute float aRadius;
attribute float aPeak;
attribute vec3  aShow;
attribute vec3  aHeading;
attribute vec4  aShape;

uniform float uNow;
uniform vec3  uCamPos;
uniform float uFloorCentre;
uniform float uFloorSpan;
uniform float uWindowRadius;
uniform float uProjScale;
uniform float uCapPx;
uniform float uOnset;
uniform float uRingGain;

varying vec3  vColor;
varying float vAlpha;

#define CULL() { vColor = vec3(0.0); vAlpha = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

vec2 rot2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

void main() {
  float age = uNow - aBorn;
  if (aFade <= 0.0 || age < 0.0 || age > aFade) CULL()
  // Absence is honest: a mark whose evidence does not exist is simply not drawn. A vague read has
  // no containment circle and no hatch, and a source with only one heard position has no heading.
  float show = aRole < 0.5 ? aShow.x : (aRole < 1.5 ? aShow.y : aShow.z);
  if (show < 0.5) CULL()
  if (distance(position, uCamPos) > uWindowRadius) CULL()
  if (abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  float t = age / aFade;
  float fall = 1.0 - t;
  vAlpha = aPeak * uRingGain * clamp(age / uOnset, 0.0, 1.0) * fall * fall;
  if (vAlpha <= 0.004) CULL()

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(0.05, -mv.z);
  // The same ceiling the smudge is held to, expressed as a world radius so the annotation and the
  // thing it annotates can never drift apart.
  float r = min(aRadius, uCapPx * 0.5 * depth / max(1.0, uProjScale));

  vec2 local = aLocal + aJag * aShape.x;
  if (aRole < 0.5) local *= 1.0 + aShape.y * t;                  // a prop's ring expands and fades
  else if (aRole < 1.5) {
    // Hatch strokes point along the source's HEADING — projected into the camera plane, because a
    // billboard is where a mark lives. The heading itself is evidence, never a guess: it is the
    // aim of a ping's cone, or the line between two positions the player actually heard.
    vec3 h = mat3(viewMatrix) * aHeading;
    local = rot2(local, atan(h.y, h.x));
  } else local = rot2(local * aShape.w, aShape.z);               // diamond / square pip / lozenge

  mv.xy += local * r;
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
}
`;

const MARK_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;

void main() {
  if (vAlpha <= 0.004) discard;
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

/** The per-source form table. Everything a mark IS, decided once, off the event alone. */
interface Form {
  /** Ring / hatch / glyph visibility, before the quality gate. */
  readonly ring: boolean;
  readonly hatch: boolean;
  readonly glyph: boolean;
  /** Ring visible even at low quality — the mark IS the reading for these sources. */
  readonly ringAlways: boolean;
  readonly jag: number;
  readonly expand: number;
  readonly glyphRot: number;
  readonly glyphScale: number;
}

const FORMS: Record<SourceKind, Form> = {
  self: { ring: true, hatch: true, glyph: false, ringAlways: false, jag: 0, expand: 0, glyphRot: 0, glyphScale: 1 },
  teammate: { ring: true, hatch: false, glyph: true, ringAlways: false, jag: 0, expand: 0, glyphRot: Math.PI / 4, glyphScale: 1 },
  dog: { ring: true, hatch: true, glyph: false, ringAlways: false, jag: STAIN_HATCH_JAG, expand: 0, glyphRot: 0, glyphScale: 1 },
  prop: { ring: true, hatch: false, glyph: false, ringAlways: true, jag: 0, expand: STAIN_RING_EXPAND, glyphRot: 0, glyphScale: 1 },
  objective: { ring: true, hatch: false, glyph: true, ringAlways: false, jag: 0, expand: 0, glyphRot: 0, glyphScale: 1 },
  detonation: { ring: true, hatch: false, glyph: true, ringAlways: true, jag: 0, expand: STAIN_RING_EXPAND * 1.6, glyphRot: 0, glyphScale: 2.2 },
};

/** Builds the static local-space template every stain slot wears. */
function markTemplate(): { local: Float32Array; jag: Float32Array; role: Float32Array } {
  const local = new Float32Array(MARK_VERTS * 2);
  const jag = new Float32Array(MARK_VERTS * 2);
  const role = new Float32Array(MARK_VERTS);
  let w = 0;
  const put = (x: number, y: number, jx: number, jy: number, r: number): void => {
    local[w * 2] = x;
    local[w * 2 + 1] = y;
    jag[w * 2] = jx;
    jag[w * 2 + 1] = jy;
    role[w] = r;
    w++;
  };

  for (let i = 0; i < RING_N; i++) {
    const a = (i / RING_N) * Math.PI * 2;
    const b = ((i + 1) / RING_N) * Math.PI * 2;
    put(Math.cos(a), Math.sin(a), 0, 0, ROLE_RING);
    put(Math.cos(b), Math.sin(b), 0, 0, ROLE_RING);
  }

  // Two strokes just outside the smudge, each three segments long so a dog's can jag at its joints.
  for (const side of [0.34, -0.34]) {
    const px: number[] = [];
    for (let i = 0; i <= 3; i++) px.push(STAIN_HATCH_GAP + (STAIN_HATCH_LEN * i) / 3);
    for (let i = 0; i < 3; i++) {
      // Interior joints carry the jag; the two ends of a stroke stay on the line.
      const j0 = i === 0 ? 0 : i % 2 === 0 ? 1 : -1;
      const j1 = i === 2 ? 0 : (i + 1) % 2 === 0 ? 1 : -1;
      put(px[i]!, side, 0, j0, ROLE_HATCH);
      put(px[i + 1]!, side, 0, j1, ROLE_HATCH);
    }
  }

  const g = STAIN_GLYPH_R;
  const pts: ReadonlyArray<readonly [number, number]> = [
    [g, 0],
    [0, g],
    [-g, 0],
    [0, -g],
  ];
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % 4]!;
    put(a[0], a[1], 0, 0, ROLE_GLYPH);
    put(b[0], b[1], 0, 0, ROLE_GLYPH);
  }
  return { local, jag, role };
}

/**
 * Noise stains: the smudge and its marks, kept in one class because they are one mark — every slot
 * writes both, and a smudge without its circle would be a different reading of the same sound.
 */
export class StainField {
  private readonly smudgeGeom = new BufferGeometry();
  private readonly markGeom = new BufferGeometry();
  private readonly smudgeMat: ShaderMaterial;
  private readonly markMat: ShaderMaterial;
  private readonly smudge: Points;
  private readonly marks: LineSegments;

  private readonly sPos = new Float32Array(STAIN_CAP * 3);
  private readonly sCol = new Float32Array(STAIN_CAP * 3);
  private readonly sBorn = new Float32Array(STAIN_CAP);
  private readonly sFade = new Float32Array(STAIN_CAP);
  private readonly sRad = new Float32Array(STAIN_CAP);
  private readonly sPeak = new Float32Array(STAIN_CAP);
  private readonly sSharp = new Float32Array(STAIN_CAP);

  private readonly mPos = new Float32Array(STAIN_CAP * MARK_VERTS * 3);
  private readonly mCol = new Float32Array(STAIN_CAP * MARK_VERTS * 3);
  private readonly mBorn = new Float32Array(STAIN_CAP * MARK_VERTS);
  private readonly mFade = new Float32Array(STAIN_CAP * MARK_VERTS);
  private readonly mRad = new Float32Array(STAIN_CAP * MARK_VERTS);
  private readonly mPeak = new Float32Array(STAIN_CAP * MARK_VERTS);
  private readonly mShow = new Float32Array(STAIN_CAP * MARK_VERTS * 3);
  private readonly mHead = new Float32Array(STAIN_CAP * MARK_VERTS * 3);
  private readonly mShape = new Float32Array(STAIN_CAP * MARK_VERTS * 4);

  /** Every attribute a stamp writes into, so a re-upload is one flat loop and never a name lookup. */
  private readonly dyn: BufferAttribute[] = [];
  private write = 0;
  private dirty = false;
  private readonly fadeMin: number;
  private readonly fadeMax: number;
  private readonly calm: boolean;

  /**
   * The last delivered origin per source, so a second sound from the same source can give the mark
   * a HEADING. This is evidence, not prediction: the direction between two places the player
   * actually heard the thing (vision §1's "the system never lies").
   */
  private readonly lastAt = new Map<SourceKind, [number, number, number, number]>();

  constructor(scene: Scene, k: CoreConstants, calm: boolean) {
    this.fadeMin = k.STAIN_FADE_MIN;
    this.fadeMax = k.STAIN_FADE_MAX;
    this.calm = calm;

    const dyn = (a: Float32Array, size: number): BufferAttribute => {
      const b = new BufferAttribute(a, size);
      b.setUsage(DynamicDrawUsage);
      this.dyn.push(b);
      return b;
    };

    this.smudgeGeom.setAttribute('position', dyn(this.sPos, 3));
    this.smudgeGeom.setAttribute('aColor', dyn(this.sCol, 3));
    this.smudgeGeom.setAttribute('aBorn', dyn(this.sBorn, 1));
    this.smudgeGeom.setAttribute('aFade', dyn(this.sFade, 1));
    this.smudgeGeom.setAttribute('aRadius', dyn(this.sRad, 1));
    this.smudgeGeom.setAttribute('aPeak', dyn(this.sPeak, 1));
    this.smudgeGeom.setAttribute('aSharp', dyn(this.sSharp, 1));

    const tpl = markTemplate();
    const local = new Float32Array(STAIN_CAP * MARK_VERTS * 2);
    const jag = new Float32Array(STAIN_CAP * MARK_VERTS * 2);
    const role = new Float32Array(STAIN_CAP * MARK_VERTS);
    for (let s = 0; s < STAIN_CAP; s++) {
      local.set(tpl.local, s * MARK_VERTS * 2);
      jag.set(tpl.jag, s * MARK_VERTS * 2);
      role.set(tpl.role, s * MARK_VERTS);
    }
    this.markGeom.setAttribute('aLocal', new BufferAttribute(local, 2));
    this.markGeom.setAttribute('aJag', new BufferAttribute(jag, 2));
    this.markGeom.setAttribute('aRole', new BufferAttribute(role, 1));
    this.markGeom.setAttribute('position', dyn(this.mPos, 3));
    this.markGeom.setAttribute('aColor', dyn(this.mCol, 3));
    this.markGeom.setAttribute('aBorn', dyn(this.mBorn, 1));
    this.markGeom.setAttribute('aFade', dyn(this.mFade, 1));
    this.markGeom.setAttribute('aRadius', dyn(this.mRad, 1));
    this.markGeom.setAttribute('aPeak', dyn(this.mPeak, 1));
    this.markGeom.setAttribute('aShow', dyn(this.mShow, 3));
    this.markGeom.setAttribute('aHeading', dyn(this.mHead, 3));
    this.markGeom.setAttribute('aShape', dyn(this.mShape, 4));

    const onset = calm ? STAIN_ONSET_CALM : STAIN_ONSET;
    this.smudgeMat = new ShaderMaterial({
      uniforms: {
        uNow: { value: 0 },
        uCamPos: { value: [0, 0, 0] },
        uFloorCentre: { value: 0 },
        uFloorSpan: { value: 0 },
        uWindowRadius: { value: k.WINDOW_RADIUS },
        uProjScale: { value: 500 },
        uPixelRatio: { value: 1 },
        uCapPx: { value: 24 },
        uMinPx: { value: STAIN_MIN_PX },
        uOnset: { value: onset },
      },
      vertexShader: SMUDGE_VERT,
      fragmentShader: SMUDGE_FRAG,
      transparent: true,
      // NOT additive. Graphite is matte; additive ink is the first step toward a mark that reads
      // as light, and light is what geometry is made of in this game.
      depthTest: true,
      depthWrite: false,
    });
    this.markMat = new ShaderMaterial({
      uniforms: {
        uNow: { value: 0 },
        uCamPos: { value: [0, 0, 0] },
        uFloorCentre: { value: 0 },
        uFloorSpan: { value: 0 },
        uWindowRadius: { value: k.WINDOW_RADIUS },
        uProjScale: { value: 500 },
        uCapPx: { value: 24 },
        uOnset: { value: onset },
        uRingGain: { value: STAIN_RING_ALPHA },
      },
      vertexShader: MARK_VERT,
      fragmentShader: MARK_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    this.smudge = new Points(this.smudgeGeom, this.smudgeMat);
    this.smudge.frustumCulled = false;
    this.smudge.renderOrder = 4;
    this.smudge.visible = false;
    this.marks = new LineSegments(this.markGeom, this.markMat);
    this.marks.frustumCulled = false;
    this.marks.renderOrder = 5;
    this.marks.visible = false;
    scene.add(this.smudge, this.marks);
  }

  /**
   * Stamp one delivered event. The origin is the one PAINT used — including the ±2 m fuzz of a
   * through-wall read, drawn as spread rather than as a second position (vision §3.4).
   */
  stamp(e: SoundEvent): void {
    const q = clamp01(e.quality);
    const i = this.write;
    this.write = (this.write + 1) % STAIN_CAP;
    this.dirty = true;

    const o = deliveredOrigin(e);
    const ox = o[0]!;
    const oy = o[1]!;
    const oz = o[2]!;

    // Heading: a ping aims, so its cone IS the heading. Anything else has one only if the player
    // has heard it twice recently and it moved a plausible distance in between.
    let hx = 0;
    let hy = 0;
    let hz = 0;
    if (e.cone) {
      hx = e.cone.dir[0];
      hy = e.cone.dir[1];
      hz = e.cone.dir[2];
    } else {
      const prev = this.lastAt.get(e.source);
      if (prev && e.time - prev[3] < 2.5) {
        const dx = ox - prev[0];
        const dy = oy - prev[1];
        const dz = oz - prev[2];
        const d = Math.hypot(dx, dy, dz);
        if (d > 0.15 && d < 6) {
          hx = dx / d;
          hy = dy / d;
          hz = dz / d;
        }
      }
    }
    this.lastAt.set(e.source, [ox, oy, oz, e.time]);
    const hasHeading = hx !== 0 || hy !== 0 || hz !== 0 ? 1 : 0;

    const ink = INK[e.source];
    const fade = lerp(this.fadeMin, this.fadeMax, q);
    const radius = lerp(STAIN_R_HIGH, STAIN_R_LOW, q);
    const peak = lerp(STAIN_A_LOW, STAIN_A_HIGH, q) * (this.calm ? STAIN_CALM_ALPHA : 1);
    const form = FORMS[e.source];
    const committed = q >= STAIN_MARK_Q ? 1 : 0;

    this.sPos[i * 3] = ox;
    this.sPos[i * 3 + 1] = oy;
    this.sPos[i * 3 + 2] = oz;
    this.sCol[i * 3] = ink[0];
    this.sCol[i * 3 + 1] = ink[1];
    this.sCol[i * 3 + 2] = ink[2];
    this.sBorn[i] = e.time;
    this.sFade[i] = fade;
    this.sRad[i] = radius;
    this.sPeak[i] = peak;
    this.sSharp[i] = q;

    // Quality gates the containment circle and nothing else. The hatch needs only a heading it
    // actually has; the glyph needs only the source to be one that wears one.
    const showRing = form.ring && (form.ringAlways || committed === 1) ? 1 : 0;
    const showHatch = form.hatch && hasHeading === 1 ? 1 : 0;
    const showGlyph = form.glyph ? 1 : 0;
    const base = i * MARK_VERTS;
    for (let v = 0; v < MARK_VERTS; v++) {
      const n = base + v;
      this.mPos[n * 3] = ox;
      this.mPos[n * 3 + 1] = oy;
      this.mPos[n * 3 + 2] = oz;
      this.mCol[n * 3] = ink[0];
      this.mCol[n * 3 + 1] = ink[1];
      this.mCol[n * 3 + 2] = ink[2];
      this.mBorn[n] = e.time;
      this.mFade[n] = fade;
      this.mRad[n] = radius;
      this.mPeak[n] = peak;
      this.mShow[n * 3] = showRing;
      this.mShow[n * 3 + 1] = showHatch;
      this.mShow[n * 3 + 2] = showGlyph;
      this.mHead[n * 3] = hx;
      this.mHead[n * 3 + 1] = hy;
      this.mHead[n * 3 + 2] = hz;
      this.mShape[n * 4] = form.jag;
      this.mShape[n * 4 + 1] = form.expand;
      this.mShape[n * 4 + 2] = form.glyphRot;
      this.mShape[n * 4 + 3] = form.glyphScale;
    }
  }

  update(f: BlueprintFrame): void {
    // A layer with nothing in it is not drawn at all: vision §1.3's black world has to survive an
    // empty ring, and a draw call that renders nothing is still a draw call.
    let live = 0;
    for (let i = 0; i < STAIN_CAP; i++) {
      const fade = this.sFade[i]!;
      if (fade > 0 && f.now - this.sBorn[i]! <= fade) live++;
    }
    const on = live > 0;
    this.smudge.visible = on;
    this.marks.visible = on;
    if (!on) return;

    if (this.dirty) {
      this.dirty = false;
      // Only the attributes a stamp actually writes: the mark TEMPLATE (local shape, jag, role) is
      // static for the life of the field and re-uploading it every stamp would be the largest
      // needless transfer in the look.
      for (const a of this.dyn) a.needsUpdate = true;
    }

    const cap = f.capPx * STAIN_CAP_MULT;
    const s = this.smudgeMat.uniforms;
    s.uNow!.value = f.now;
    s.uCamPos!.value = f.camPos;
    s.uFloorCentre!.value = f.floorCentre;
    s.uFloorSpan!.value = f.floorSpan;
    s.uProjScale!.value = f.projScale;
    s.uPixelRatio!.value = f.pixelRatio;
    s.uCapPx!.value = cap;
    const m = this.markMat.uniforms;
    m.uNow!.value = f.now;
    m.uCamPos!.value = f.camPos;
    m.uFloorCentre!.value = f.floorCentre;
    m.uFloorSpan!.value = f.floorSpan;
    m.uProjScale!.value = f.projScale;
    m.uCapPx!.value = cap;
  }

  dispose(): void {
    this.smudgeGeom.dispose();
    this.markGeom.dispose();
    this.smudgeMat.dispose();
    this.markMat.dispose();
    this.smudge.visible = false;
    this.marks.visible = false;
    this.lastAt.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// The dog cloud, its silhouette and its ghosts
// ---------------------------------------------------------------------------------------------

const DOG_VERT = /* glsl */ `
attribute vec3  aNormal;
attribute float aBorn;
attribute float aKind;
attribute float aRank;
attribute float aQuality;
attribute float aArc;

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
uniform float uCollapse;
uniform float uSmearDecay;
uniform float uSilEdge;
uniform float uBodyAlpha;
uniform float uSilAlpha;
uniform vec3  uCBody;
uniform vec3  uCLine;
uniform vec3  uCRust;

varying vec3  vColor;
varying float vAlpha;

#define CULL() { vColor = vec3(0.0); vAlpha = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

void main() {
  if (distance(position, uCamPos) > uWindowRadius) CULL()
  if (abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // THE DRAWING CONVENTION, APPLIED TO THE ENEMY (doc/looks/blueprint.md "Dog & ghosts"). A point
  // whose normal is perpendicular to the view ray is on the depth-edge of the cloud: that band IS
  // the silhouette, and it is drawn as line work while the interior stays a faint matter-toned
  // cloud. No render target, no edge-detect pass — Blueprint has no post chain to hide in.
  vec3 toCam = normalize(uCamPos - position);
  float sil = 1.0 - smoothstep(0.0, uSilEdge, abs(dot(normalize(aNormal), toCam)));

  float a = aQuality;
  vec3 ink;
  if (aKind < 0.5) {
    // Live smear: every pose is a real photograph, the older ones fainter. Not a blur — the
    // renderer may not invent the frames between two things it was told (vision §3.7).
    ink = mix(uCBody, uCLine, sil);
    a *= pow(uSmearDecay, aRank) * mix(uBodyAlpha, uSilAlpha, sil);
  } else {
    // A ghost is onion-skin: within a second the frozen pose has collapsed to its outline, the
    // outline cools to rust, and over the last two seconds it is UNPLOTTED along its own length.
    float age = max(0.0, uNow - aBorn);
    float collapse = clamp(age / uCollapse, 0.0, 1.0);
    float cool = clamp(age / uGhostLife, 0.0, 1.0);
    ink = mix(mix(uCBody, uCLine, sil), uCRust, cool);
    a *= mix(uBodyAlpha * (1.0 - collapse), uSilAlpha, sil);
    float diss = clamp((age - uGhostLife) / uGhostDissolve, 0.0, 1.0);
    if (aArc < diss) a = 0.0;
  }
  if (a <= 0.004) CULL()
  vAlpha = a;
  vColor = ink;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // The dog's own pitch, never the map's: the body is sampled about three times finer, so
  // borrowing SURFEL_SPACING here would draw it as a solid slab at any range you could hear it.
  float px = uProjScale * uSpacing / max(0.05, -mv.z);
  gl_Position = projectionMatrix * mv;
  // The silhouette draws finer than the body — a line, not a rim of fat dots.
  gl_PointSize = clamp(px, uMinPx, max(uCapPx, uMinPx)) * mix(1.0, 0.82, sil) * uPixelRatio;
}
`;

const DOG_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  float a = vAlpha * (1.0 - smoothstep(0.72, 1.0, r2));
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

export class DogField {
  private readonly geom = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private readonly points: Points;

  private position = new Float32Array(0);
  private normal = new Float32Array(0);
  private born = new Float32Array(0);
  private kind = new Float32Array(0);
  private rank = new Float32Array(0);
  private quality = new Float32Array(0);
  private arc = new Float32Array(0);
  private capacity = 0;
  private drawn = 0;
  private signature = '';
  private readonly m = new Matrix4();
  /**
   * Per-dog arc parameter, cached: where each cloud point sits around the body's sagittal profile,
   * 0..1. Static per dog (it is a property of the body, not of a pose), and it is what lets a
   * ghost's outline erase ALONG its length rather than fading everywhere at once.
   */
  private readonly arcCache = new Map<number, Float32Array>();

  constructor(scene: Scene, k: CoreConstants) {
    this.mat = new ShaderMaterial({
      uniforms: {
        uNow: { value: 0 },
        uCamPos: { value: [0, 0, 0] },
        uFloorCentre: { value: 0 },
        uFloorSpan: { value: 0 },
        uWindowRadius: { value: k.WINDOW_RADIUS },
        uProjScale: { value: 500 },
        uPixelRatio: { value: 1 },
        uCapPx: { value: 12 },
        uMinPx: { value: k.SPLAT_MIN_PX },
        uSpacing: { value: k.SURFEL_SPACING },
        uGhostLife: { value: k.DOG_GHOST_LIFE },
        uGhostDissolve: { value: k.DOG_GHOST_DISSOLVE },
        uCollapse: { value: GHOST_COLLAPSE_S },
        uSmearDecay: { value: DOG_SMEAR_DECAY },
        uSilEdge: { value: SIL_EDGE },
        uBodyAlpha: { value: DOG_BODY_ALPHA },
        uSilAlpha: { value: DOG_SIL_ALPHA },
        uCBody: { value: PALETTE.mid },
        uCLine: { value: PALETTE.edge },
        uCRust: { value: PALETTE.rust },
      },
      vertexShader: DOG_VERT,
      fragmentShader: DOG_FRAG,
      transparent: true,
      depthTest: true,
      // A dog is a read, not a surface: it must not occlude the geometry it is standing on.
      depthWrite: false,
    });
    this.points = new Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.visible = false;
    scene.add(this.points);
  }

  /**
   * Merge every drawable pose of every dog into the one buffer. Rebuilt only when the pose SET
   * changes — on a heard event, a freeze or a ghost expiring, never per frame — because ageing is
   * entirely a shader job: what a frame changes is the clock, and the clock is a uniform.
   */
  update(dogs: readonly DogView[], f: BlueprintFrame): void {
    let sig = '';
    let need = 0;
    let spacing = 0;
    for (const d of dogs) {
      const n = d.cloudGeom.getAttribute('position').count;
      spacing = d.cloudSpacing;
      need += n * (d.poseHistory.length + d.ghosts.length);
      sig += `${d.id}:${d.poseHistory.length}/${d.ghosts.length}`;
      const newest = d.poseHistory[d.poseHistory.length - 1];
      if (newest) sig += `@${newest.time}`;
      for (const g of d.ghosts) sig += `#${g.frozenAt}`;
      sig += ';';
    }

    if (sig !== this.signature) {
      this.signature = sig;
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
    u.uCapPx!.value = f.capPx;
    if (spacing > 0) u.uSpacing!.value = spacing;
  }

  /** Where a cloud point sits around the body's profile, 0..1. Computed once per dog. */
  private arcOf(d: DogView): Float32Array {
    const cached = this.arcCache.get(d.id);
    if (cached) return cached;
    const p = d.cloudGeom.getAttribute('position').array as ArrayLike<number>;
    const n = d.cloudGeom.getAttribute('position').count;
    let cy = 0;
    for (let i = 0; i < n; i++) cy += p[i * 3 + 1]!;
    cy = n > 0 ? cy / n : 0;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // The SAGITTAL angle: nose → back → tail → belly. The one parameter that traces a dog's
      // outline in the view the player usually has of it (a lantern seen side-on through a wall).
      out[i] = (Math.atan2(p[i * 3 + 1]! - cy, p[i * 3]!) + Math.PI) / (Math.PI * 2);
    }
    this.arcCache.set(d.id, out);
    return out;
  }

  private rebuild(dogs: readonly DogView[], need: number): void {
    if (need > this.capacity) {
      this.capacity = need;
      this.position = new Float32Array(need * 3);
      this.normal = new Float32Array(need * 3);
      this.born = new Float32Array(need);
      this.kind = new Float32Array(need);
      this.rank = new Float32Array(need);
      this.quality = new Float32Array(need);
      this.arc = new Float32Array(need);
      this.geom.setAttribute('position', new BufferAttribute(this.position, 3));
      this.geom.setAttribute('aNormal', new BufferAttribute(this.normal, 3));
      this.geom.setAttribute('aBorn', new BufferAttribute(this.born, 1));
      this.geom.setAttribute('aKind', new BufferAttribute(this.kind, 1));
      this.geom.setAttribute('aRank', new BufferAttribute(this.rank, 1));
      this.geom.setAttribute('aQuality', new BufferAttribute(this.quality, 1));
      this.geom.setAttribute('aArc', new BufferAttribute(this.arc, 1));
    }

    let w = 0;
    for (const d of dogs) {
      const pos = d.cloudGeom.getAttribute('position').array as ArrayLike<number>;
      const nrm = d.cloudGeom.getAttribute('normal').array as ArrayLike<number>;
      const n = d.cloudGeom.getAttribute('position').count;
      const arc = this.arcOf(d);
      const poses = d.poseHistory;
      for (let p = 0; p < poses.length; p++) {
        // Rank 0 is the NEWEST sample: the smear fades backwards from the last thing actually
        // heard, so a dog that has just gone quiet still shows its freshest read at full strength.
        const s = poses[p]!;
        w = this.writePose(pos, nrm, arc, n, s.matrix, s.time, 0, poses.length - 1 - p, d.lastEventQuality, w);
      }
      for (const g of d.ghosts) {
        w = this.writePose(pos, nrm, arc, n, g.pose.matrix, g.frozenAt, 1, 0, g.quality, w);
      }
    }
    this.drawn = w;
    this.geom.setDrawRange(0, w);
    if (this.capacity > 0) {
      for (const name in this.geom.attributes) this.geom.attributes[name]!.needsUpdate = true;
    }
  }

  private writePose(
    src: ArrayLike<number>,
    srcN: ArrayLike<number>,
    arc: Float32Array,
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
      // A pose is a rigid transform, so the normal rotates with the same basis and no inverse
      // transpose is needed. It is not renormalised here — the shader does that anyway.
      const nx = srcN[i * 3]!;
      const ny = srcN[i * 3 + 1]!;
      const nz = srcN[i * 3 + 2]!;
      this.normal[w * 3] = e[0]! * nx + e[4]! * ny + e[8]! * nz;
      this.normal[w * 3 + 1] = e[1]! * nx + e[5]! * ny + e[9]! * nz;
      this.normal[w * 3 + 2] = e[2]! * nx + e[6]! * ny + e[10]! * nz;
      this.born[w] = born;
      this.kind[w] = kind;
      this.rank[w] = rank;
      this.quality[w] = quality;
      this.arc[w] = arc[i]!;
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
    this.arcCache.clear();
  }
}
