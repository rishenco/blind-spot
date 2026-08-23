/**
 * THE EVENT LAYER, for the debug look: noise stains and the dog cloud (visual-brief §1.13, §2).
 *
 * Two objects, kept out of `index.ts` because they answer a different question from the matter
 * layer and must never be confused with it. Vision §3.2 splits the screen in two: the cyan-family
 * lattice says WHAT IS THERE, and this file says WHAT JUST HAPPENED. Geometry never takes a
 * source's colour, and nothing drawn here ever writes depth — a warm mark must not read as near
 * matter (vision §12).
 *
 * Both are ONE draw call each, and deliberately so. The dog field merges every pose that is
 * currently drawable — the live smear of every dog plus every cooling ghost — into a single
 * buffer, and the stain field is a fixed ring of billboards. Engine-plan §10 budgets the whole
 * world at a handful of calls, and the event layer is an annotation on it, not a second scene.
 *
 * WHAT IS LAW HERE rather than styling:
 *
 *   - The hard window (vision §3.6). A stain or a ghost outside 45 m, or off the ±1 floor band,
 *     is not drawn. The event layer does not get to see further than the matter layer does.
 *   - A stain sits at the origin the MATTER was painted from — the fuzzed one when the sound came
 *     through a wall (`deliveredOrigin`). Two answers to "where did that happen" is a lie.
 *   - Quality drives definition, not just brightness (visual-brief §1.13): a close, clean read is
 *     a small tight bright stain; a far or walled one is a wide dim smudge. The spread IS the
 *     positional vagueness, drawn from the event's own stable seed — never jitter.
 *   - A ghost is aged from `frozenAt` against the render clock, hot → rust over DOG_GHOST_LIFE
 *     and then dissolving over DOG_GHOST_DISSOLVE. Never interpolated, never predicted (§3.7).
 *   - Additive, never depth-writing, and always airy: a stain must not be mistakable for lattice
 *     geometry (visual-brief §2).
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

/** Per-frame projection state both fields need. Written once, read by both materials. */
export interface MarkFrame {
  readonly now: number;
  readonly camPos: readonly [number, number, number];
  /** Pixels per metre at one metre of depth (see `uProjScale` in index.ts). */
  readonly projScale: number;
  readonly pixelRatio: number;
  /** The dot cap in CSS px, shared with the matter layer so nothing here outgrows a splat. */
  readonly capPx: number;
  readonly floorCentre: number;
  readonly floorSpan: number;
}

// ---------------------------------------------------------------------------------------------
// Noise stains
// ---------------------------------------------------------------------------------------------

/**
 * How many stains may be alive at once. A ring, oldest overwritten first.
 *
 * The longest fade is 6 s (vision §3.2) and the loudest legal storm — a sprinting player, a
 * chain, a knocked can and two dogs trotting — is well under ten events a second, so this holds
 * the whole window with room to spare. It is a HARD pool with oldest-first eviction for the same
 * reason the surfel pool is (vision §12): a mark layer that can grow without bound is a way for
 * the screen to become porridge that no fence can see coming.
 */
const STAIN_CAP = 96;

/**
 * THE QUALITY MAPPING (visual-brief §1.13). `q` is the delivered `quality` — 1 at the source with
 * clear line-of-hearing, 0 at the edge of earshot, and multiplied by WALL1_QUALITY through a wall.
 *
 *   radius  R_HIGH → R_LOW   a confident read is a tight mark; a vague one spreads out
 *   alpha   A_LOW  → A_HIGH  and it is brighter
 *   profile exponent 1.2 → 3.4: how much of the disc is core rather than haze
 *
 * The alpha ceiling is low on purpose and is not a comfort concession: additive marks over a
 * lattice that already saturates at the moment of arrival are how the near field fuses into a
 * sheet, and a stain bright enough to do that has stopped being "airy and diffuse".
 */
const STAIN_R_LOW = 0.42;
const STAIN_R_HIGH = 2.1;
const STAIN_A_LOW = 0.07;
const STAIN_A_HIGH = 0.26;

/**
 * How long a stain takes to reach full strength, seconds — and the same in reduce-flashing mode.
 *
 * A stain has no strobe to remove, so vision §12's comfort law shows up here as the only abrupt
 * thing it does: appearing. The onset lengthens and the peak drops, which is a fade rather than a
 * flash without changing what the mark MEANS.
 */
const STAIN_ONSET = 0.07;
const STAIN_ONSET_CALM = 0.34;
const STAIN_CALM_ALPHA = 0.62;

/** Smallest a stain may draw, CSS px. Below this it is a shimmering sub-pixel (vision §12). */
const STAIN_MIN_PX = 3;

/**
 * Source hues, exactly vision §3.2's table. Hue is never the only carrier — the stain also
 * differs in size, definition and lifetime by quality — but the assignment itself is fixed
 * language shared with the top-down plan and the three authored looks.
 */
const STAIN_HUE: Record<SourceKind, readonly [number, number, number]> = {
  self: [1.0, 0.66, 0.2],
  teammate: [0.34, 1.0, 0.5],
  dog: [1.0, 0.36, 0.14],
  prop: [0.95, 0.93, 0.55],
  objective: [1.0, 0.8, 0.26],
  detonation: [1.0, 1.0, 1.0],
};

const CULL = /* glsl */ `
#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
`;

const STAIN_VERT = /* glsl */ `
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
${CULL}

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
  if (vAlpha <= 0.004) CULL()

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // The stain's radius is a real distance in the world, so it shrinks with range like everything
  // else — but it is capped at the same ceiling as a splat. Uncapped, a low-quality 2 m smudge
  // heard from three metres away is most of the frame.
  float px = uProjScale * (aRadius * 2.0) / max(0.05, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(px, uMinPx, max(uCapPx, uMinPx)) * uPixelRatio;
  vColor = aColor;
  vSharp = aSharp;
}
`;

const STAIN_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;
varying float vSharp;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  // Definition, not just brightness (visual-brief §1.13). A high exponent puts nearly all the
  // energy in a small core and leaves the rim at nothing — "almost-shaped". A low one spreads it
  // flat across the whole disc — a smudge whose edge you cannot place.
  float profile = pow(1.0 - r2, mix(1.2, 3.4, vSharp));
  gl_FragColor = vec4(vColor, vAlpha * profile);
}
`;

export class StainField {
  readonly points: Points;

  private readonly geom = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly born: Float32Array;
  private readonly fade: Float32Array;
  private readonly radius: Float32Array;
  private readonly peak: Float32Array;
  private readonly sharp: Float32Array;
  private write = 0;
  private readonly fadeMin: number;
  private readonly fadeMax: number;
  private readonly calm: boolean;

  constructor(constants: CoreConstants, reduceFlashing: boolean) {
    this.fadeMin = constants.STAIN_FADE_MIN;
    this.fadeMax = constants.STAIN_FADE_MAX;
    this.calm = reduceFlashing;

    this.position = new Float32Array(STAIN_CAP * 3);
    this.color = new Float32Array(STAIN_CAP * 3);
    this.born = new Float32Array(STAIN_CAP);
    this.fade = new Float32Array(STAIN_CAP);
    this.radius = new Float32Array(STAIN_CAP);
    this.peak = new Float32Array(STAIN_CAP);
    this.sharp = new Float32Array(STAIN_CAP);

    const attr = (a: Float32Array, size: number): BufferAttribute => {
      const b = new BufferAttribute(a, size);
      b.setUsage(DynamicDrawUsage);
      return b;
    };
    this.geom.setAttribute('position', attr(this.position, 3));
    this.geom.setAttribute('aColor', attr(this.color, 3));
    this.geom.setAttribute('aBorn', attr(this.born, 1));
    this.geom.setAttribute('aFade', attr(this.fade, 1));
    this.geom.setAttribute('aRadius', attr(this.radius, 1));
    this.geom.setAttribute('aPeak', attr(this.peak, 1));
    this.geom.setAttribute('aSharp', attr(this.sharp, 1));

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
   * Stamp one delivered event. The origin is the one PAINT used, so the mark and the geometry it
   * lit agree about where the sound was — including the ±2 m fuzz of a through-wall read, which
   * is drawn as spread rather than as a second position (vision §3.4, visual-brief §2).
   */
  stamp(e: SoundEvent): void {
    const q = clamp01(e.quality);
    const i = this.write;
    this.write = (this.write + 1) % STAIN_CAP;

    const o = deliveredOrigin(e);
    this.position[i * 3] = o[0];
    this.position[i * 3 + 1] = o[1];
    this.position[i * 3 + 2] = o[2];

    const hue = STAIN_HUE[e.source];
    this.color[i * 3] = hue[0];
    this.color[i * 3 + 1] = hue[1];
    this.color[i * 3 + 2] = hue[2];

    this.born[i] = e.time;
    // A confident read lingers; a vague one is gone before you can act on it (vision §3.2's
    // 2.5-6 s window, spent on the events that told you something).
    this.fade[i] = lerp(this.fadeMin, this.fadeMax, q);
    this.radius[i] = lerp(STAIN_R_HIGH, STAIN_R_LOW, q);
    this.peak[i] = lerp(STAIN_A_LOW, STAIN_A_HIGH, q) * (this.calm ? STAIN_CALM_ALPHA : 1);
    this.sharp[i] = q;
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

    for (const name of ['position', 'aColor', 'aBorn', 'aFade', 'aRadius', 'aPeak', 'aSharp']) {
      this.geom.getAttribute(name).needsUpdate = true;
    }
    const u = this.mat.uniforms;
    u.uNow!.value = f.now;
    u.uCamPos!.value = f.camPos;
    u.uFloorCentre!.value = f.floorCentre;
    u.uFloorSpan!.value = f.floorSpan;
    u.uProjScale!.value = f.projScale;
    u.uPixelRatio!.value = f.pixelRatio;
    u.uCapPx!.value = f.capPx;
  }

  /** Live stains right now — the F3 readout and the specs both count them from here. */
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

/** Alpha of the newest heard pose at quality 1. Lower reads are proportionally fainter. */
const DOG_ALPHA = 0.9;
/** How much fainter each older smear sample is than the one after it (vision §3.7: 0.3 s smear). */
const SMEAR_DECAY = 0.5;

const DOG_VERT = /* glsl */ `
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
uniform float uGhostLife;
uniform float uGhostDissolve;
uniform float uSmearDecay;
uniform float uAlpha;

varying vec3  vColor;
varying float vAlpha;
${CULL}

void main() {
  if (distance(position, uCamPos) > uWindowRadius) CULL()
  if (abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // Hot at the instant it was heard, rusting as the belief goes stale, then visibly dissolving —
  // the three stages of vision §3.7, read off frozenAt and nothing else.
  vec3 hot  = vec3(1.0, 0.48, 0.20);
  vec3 rust = vec3(0.42, 0.15, 0.06);

  float a = uAlpha * aQuality;
  if (aKind < 0.5) {
    // Live smear: every pose is a real photograph, the older ones fainter. Not a blur — the
    // renderer may not invent the frames between two things it was told.
    vColor = hot;
    a *= pow(uSmearDecay, aRank);
  } else {
    float age = max(0.0, uNow - aBorn);
    float cool = clamp(age / uGhostLife, 0.0, 1.0);
    vColor = mix(hot, rust, cool);
    a *= 1.0 - clamp((age - uGhostLife) / uGhostDissolve, 0.0, 1.0);
  }
  if (a <= 0.004) CULL()
  vAlpha = a;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Same footprint law as the world lattice (visual-brief §2), against the dog's own pitch: the
  // body is sampled about three times finer than the map, so borrowing SURFEL_SPACING here would
  // draw the dog as a solid orange slab at any range you could actually hear it from.
  float px = uProjScale * uSpacing / max(0.05, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(px, uMinPx, max(uCapPx, uMinPx)) * uPixelRatio;
}
`;

const DOG_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

export class DogField {
  readonly points: Points;

  private readonly geom = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private position = new Float32Array(0);
  private born = new Float32Array(0);
  private kind = new Float32Array(0);
  private rank = new Float32Array(0);
  private quality = new Float32Array(0);
  private capacity = 0;
  private drawn = 0;
  /** Signature of the pose set currently in the buffer — rebuilt only when it changes. */
  private signature = '';
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
        uGhostLife: { value: constants.DOG_GHOST_LIFE },
        uGhostDissolve: { value: constants.DOG_GHOST_DISSOLVE },
        uSmearDecay: { value: SMEAR_DECAY },
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
    this.points.renderOrder = 4;
    this.points.visible = false;
  }

  /**
   * Merge every drawable pose of every dog into the one buffer.
   *
   * Rebuilt only when the pose SET changes — which is on a heard event, a freeze or a ghost
   * expiring, never per frame — because ageing is entirely a shader job: what a frame changes is
   * the clock, and the clock is a uniform.
   */
  update(dogs: readonly DogView[], f: MarkFrame): void {
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

  private rebuild(dogs: readonly DogView[], need: number): void {
    if (need > this.capacity) {
      // Grow in one step to what is asked for: the pose set is bounded by DOG_MAX_GHOSTS plus
      // DOG_SMEAR_SAMPLES per dog, so this settles after the first busy moment of a run.
      this.capacity = need;
      this.position = new Float32Array(need * 3);
      this.born = new Float32Array(need);
      this.kind = new Float32Array(need);
      this.rank = new Float32Array(need);
      this.quality = new Float32Array(need);
      this.geom.setAttribute('position', new BufferAttribute(this.position, 3));
      this.geom.setAttribute('aBorn', new BufferAttribute(this.born, 1));
      this.geom.setAttribute('aKind', new BufferAttribute(this.kind, 1));
      this.geom.setAttribute('aRank', new BufferAttribute(this.rank, 1));
      this.geom.setAttribute('aQuality', new BufferAttribute(this.quality, 1));
    }

    let w = 0;
    for (const d of dogs) {
      const src = d.cloudGeom.getAttribute('position').array as ArrayLike<number>;
      const n = d.cloudGeom.getAttribute('position').count;
      const poses = d.poseHistory;
      for (let p = 0; p < poses.length; p++) {
        // Rank 0 is the NEWEST sample. The smear fades backwards in time from the last thing
        // actually heard, so a dog that has just gone quiet still shows its freshest read at full.
        w = this.writePose(src, n, poses[p]!.matrix, poses[p]!.time, 0, poses.length - 1 - p, d.lastEventQuality, w);
      }
      for (const g of d.ghosts) {
        w = this.writePose(src, n, g.pose.matrix, g.frozenAt, 1, 0, g.quality, w);
      }
    }
    this.drawn = w;
    this.geom.setDrawRange(0, w);
    if (this.capacity > 0) {
      for (const name of ['position', 'aBorn', 'aKind', 'aRank', 'aQuality']) {
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
