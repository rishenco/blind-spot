/**
 * The reveal layer for things that move — M2's central architectural decision.
 *
 * The static mask is a world-space lattice built once, at start, for a hall that cannot move.
 * That is right for the hall and impossible for the clutter: half of M2 is bodies that get
 * kicked, roll, and stop somewhere else. Rebuilding the world mask when something twitches is the
 * one thing the milestone forbids outright, and it would be absurd anyway — 220 ms per nudged can.
 *
 * So: **every prop carries its own little mask in its own local frame.** The mask is generated
 * with the body, is dense enough to draw the body's silhouette (its own pitch, not the world's),
 * and never changes again. Reveal stays exactly what it was — one birth stamp per point — because
 * the point never moves *relative to the thing it is on*. The body's world transform is uploaded
 * once per frame into a small float texture and applied in the vertex shader, so a barrel rolling
 * across the floor costs one texel of bandwidth, not one mask rebuild.
 *
 * The CPU side follows the same shape: a ping is answered by transforming the *front* into each
 * body's local frame and testing that body's points there. One quaternion conjugation per body,
 * then arithmetic identical to the static path.
 *
 * ### Why revealed points on a moving body die
 *
 * The human's ruling, not up for discussion: points on static geometry accumulate forever, points
 * on something that moved live seconds and fade. The reason is that lidar must not become a
 * tracking device — if what you saw of a rolling drum stayed lit, you would follow it in the dark,
 * and the game is about *not* being able to do that.
 *
 * The rule as implemented is one line in the shader and it hangs entirely off sleep:
 *
 *   a point is permanent  <=>  the body is asleep AND the point was revealed after it fell asleep
 *
 * Everything else — a point on an awake body, or a point learned before the body was last
 * disturbed — decays from its own birth over `decaySeconds` and is then garbage-collected back to
 * "never known" so it can be learned cleanly again. That makes sleep, which the physics needs
 * anyway, the single source of truth for "is this thing furniture or is it in play".
 */
import * as THREE from 'three';
import type { StaticWorld, Aabb } from '../core/collision';
import type { AgeRamp } from './palette';
import type { LidarPing } from './ping';
import {
  NEVER,
  RAMP_GLSL,
  RING_GLSL,
  SHADE_GLSL,
  TOUCH_GREY,
  WAVE_GLSL,
  rawColor,
  type StructuredTunables,
} from './structured';
import type { PaintBodies } from './bodies';

/** Texels per body in the transform texture: translation+settle, rotation, state. */
const TEXELS = 3;
/** Width of the transform texture, in texels. */
const TEX_W = 256;

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uProjScale;
  uniform float uWindowRadius;
  uniform float uSizeWorld;
  uniform float uPixelCap;
  uniform float uRipple;
  uniform float uRingWidth;
  uniform float uRefreshSeconds;
  uniform float uDotBright;
  uniform float uProbeBright;
  uniform float uProbeSize;
  uniform float uProbeSoft;
  uniform float uDotSoft;
  uniform float uSkeletonSize;
  uniform float uDecaySeconds;
  uniform vec3  uListener;
  uniform vec3  uHand;
  uniform float uHandSpan;
  uniform vec3  uTouchColor;
  uniform float uTouchRange;
  uniform float uTouchNear;
  uniform float uTouchMemory;
  uniform float uTouchOn;
  uniform sampler2D uBodies;
  uniform vec2  uBodyTex;

  attribute float aBody;
  attribute float aBirth;
  attribute float aPrior;
  attribute float aWave;
  attribute float aSeed;
  /**
   * This point's share of its own object's lattice, relative to the hall's.
   *
   * A prop is sampled at 0.02-0.06 m where the hall is sampled at 0.18, so a prop dot drawn at
   * the hall's world size would be six times wider than its own spacing: every barrel would
   * render as a saturated white blob and the silhouette the dense sampling bought would be
   * thrown away again. Scaling the dot to its own pitch keeps a prop the same *brightness per
   * square metre* as the floor it stands on, and lets the shape read.
   */
  attribute float aScale;
  /** The point's normal in the body's own frame — rotated to world with the body. */
  attribute vec3  aNormal;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vSoft;

  ${RAMP_GLSL}
  ${RING_GLSL}
  ${WAVE_GLSL}
  ${SHADE_GLSL}

  vec4 bodyTexel(float body, float slot) {
    float idx = body * ${TEXELS}.0 + slot;
    float col = mod(idx, uBodyTex.x);
    float row = floor(idx / uBodyTex.x);
    return texture2D(uBodies, vec2((col + 0.5) / uBodyTex.x, (row + 0.5) / uBodyTex.y));
  }

  vec3 qrot(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  void main() {
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vSoft = uDotSoft;

    vec4 t0 = bodyTexel(aBody, 0.0);
    vec4 t1 = bodyTexel(aBody, 1.0);
    vec4 t2 = bodyTexel(aBody, 2.0);
    vec3 world = qrot(t1, position) + t0.xyz;
    float settleAt = t2.x;
    float awake = t2.y;

    if (distance(world, uListener) > uWindowRadius) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    if (aBirth <= -1.0e8) {
      // Felt, not scanned. Same grey, same rule, same reach column as the static mask — the hand
      // does not care whether what it is touching can be knocked over.
      if (uTouchOn < 0.5) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      vec3 hd = world - uHand;
      hd.y -= clamp(hd.y, 0.0, uHandSpan);
      float prox = 1.0 - smoothstep(uTouchRange * 0.8, uTouchRange * 1.25, length(hd));
      float ta = prox * uTouchNear;
      if (ta < 0.004) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      vec4 tmv = modelViewMatrix * vec4(world, 1.0);
      vColor = uTouchColor * ta;
      vAlpha = 1.0;
      vSoft = uDotSoft * 0.6;
      gl_PointSize = clamp(uSizeWorld * aScale * uSkeletonSize * uProjScale / max(0.001, -tmv.z), 2.0, 8.0);
      gl_Position = projectionMatrix * tmv;
      return;
    }

    /*
     * The one rule that separates furniture from things in play. Permanent only if the body is
     * asleep and this point was learned after it went to sleep; anything else is a sighting of
     * something in motion, and a sighting of something in motion is worth a couple of seconds.
     */
    float permanent = (awake < 0.5 && aBirth >= settleAt) ? 1.0 : 0.0;
    float fade = mix(1.0 - clamp((uTime - aBirth) / max(0.2, uDecaySeconds), 0.0, 1.0), 1.0, permanent);
    if (fade <= 0.002) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec3 p = world;
    float ageNew = uTime - aBirth;
    float age;
    float hot = 0.0;
    float appear = 1.0;

    if (aPrior <= -1.0e8) {
      if (ageNew < 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      age = ageNew;
      vec3 outward;
      // A body that has moved since it was scanned no longer agrees with the front that scanned
      // it, so behindFront returns -1 and it simply does not ripple. That is the honest answer:
      // the crest passed through where the thing *was*.
      float behind = behindFront(world, aWave, aBirth, uTime, outward);
      if (behind >= 0.0) {
        float ringN = behind / max(0.05, uRingWidth);
        p += outward * uRipple * ringProfile(ringN);
        hot = 1.0 - smoothstep(0.0, 1.0, ringN);
        appear = smoothstep(0.0, 0.35, ringN);
      }
    } else {
      float ageOld = uTime - aPrior;
      if (ageOld < 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      float s = smoothstep(0.0, max(0.001, uRefreshSeconds), ageNew);
      age = mix(ageOld, min(ageOld, ageNew), s);
    }

    vec3 col;
    float alpha;
    ageRamp(age, col, alpha);
    col = mix(col, vec3(1.0), hot * 0.92);
    alpha = mix(alpha, 1.0, hot);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float depth = max(0.001, -mv.z);
    float cooled = clamp(age / max(0.001, uRampTimes.z), 0.0, 1.0);
    float want = uSizeWorld * aScale * mix(1.0, uSkeletonSize, cooled) * (1.0 + hot * uProbeSize)
      * uProjScale / depth;
    float q = want / max(0.5, uPixelCap);
    float px = want / pow(1.0 + q * q * q, 0.33333334);
    px = clamp(px, 1.0, 14.0);
    float coverage = min(1.0, (want * want) / (px * px));

    // The same readability pass as the hall's mask (SHADE_GLSL), and it matters far more here:
    // this is what stops a barrel from being a grey smudge on a grey floor.
    vec3 nWorld = qrot(t1, aNormal);
    float f = faceToEye(p, nWorld);
    if (f < -0.22 && hot < 0.01) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float shade = mix(facingGain(f) * depthCue(depth, uWindowRadius), 1.0, hot);
    col *= mix(faceTint(nWorld), vec3(1.0), hot);

    vColor = col * uDotBright * coverage * (1.0 + hot * uProbeBright) * (0.88 + 0.24 * aSeed)
      * appear * fade * shade;
    vAlpha = alpha;
    vSoft = mix(uDotSoft, uProbeSoft, hot);
    gl_PointSize = px;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3  vColor;
  varying float vAlpha;
  varying float vSoft;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float inner = 1.0 - clamp(vSoft, 0.0, 0.999);
    float shape = 1.0 - smoothstep(inner, 1.0, r);
    if (shape <= 0.002) discard;
    gl_FragColor = vec4(vColor, shape * vAlpha);
  }
`;

/**
 * The prop contour — the line pass that turns a hundred correct dots into a barrel.
 *
 * One birth stamp per *body*, not per vertex: a contour is the shape's outline, and an outline of
 * half a barrel is not a fact anyone can use. The stamp rides in the body texture that is uploaded
 * every frame anyway, so the whole pass costs one draw call and no extra bandwidth. Fading the
 * half of a ring that faces away is what keeps a cylinder from reading as a wire cage — and it is
 * per-vertex arithmetic, no raycast.
 */
const EDGE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uWindowRadius;
  uniform float uBright;
  uniform float uDecaySeconds;
  uniform vec3  uListener;
  uniform sampler2D uBodies;
  uniform vec2  uBodyTex;

  attribute float aBody;
  attribute vec3  aNormal;
  /** Scales a small object's contour down, so a jar does not shout as loudly as a barrel. */
  attribute float aWeight;

  varying vec3  vColor;
  varying float vAlpha;

  ${RAMP_GLSL}
  ${SHADE_GLSL}

  vec4 bodyTexel(float body, float slot) {
    float idx = body * ${TEXELS}.0 + slot;
    float col = mod(idx, uBodyTex.x);
    float row = floor(idx / uBodyTex.x);
    return texture2D(uBodies, vec2((col + 0.5) / uBodyTex.x, (row + 0.5) / uBodyTex.y));
  }

  vec3 qrot(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  void main() {
    vColor = vec3(0.0);
    vAlpha = 0.0;

    vec4 t0 = bodyTexel(aBody, 0.0);
    vec4 t1 = bodyTexel(aBody, 1.0);
    vec4 t2 = bodyTexel(aBody, 2.0);
    float birth = t2.z;
    vec3 world = qrot(t1, position) + t0.xyz;

    if (birth <= -1.0e8 || distance(world, uListener) > uWindowRadius) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float permanent = (t2.y < 0.5 && birth >= t2.x) ? 1.0 : 0.0;
    float age = uTime - birth;
    if (age < 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float fade = mix(1.0 - clamp(age / max(0.2, uDecaySeconds), 0.0, 1.0), 1.0, permanent);

    vec3 col;
    float alpha;
    ageRamp(age, col, alpha);

    vec3 n = qrot(t1, aNormal);
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    float depth = max(0.001, -mv.z);
    float f = faceToEye(world, n);
    vColor = col * uBright * aWeight * facingGain(f) * depthCue(depth, uWindowRadius) * fade;
    // Past the silhouette the line is gone rather than dim: a ring that wrapped all the way round
    // reads as a cage, and a cage is the one thing a pile of clutter must not look like.
    vAlpha = alpha * smoothstep(-0.18, 0.06, f);
    gl_Position = projectionMatrix * mv;
  }
`;

const EDGE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3  vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.01) discard;
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

export interface DynamicStats {
  /** Mask points across all props. */
  points: number;
  /** Points a front or the hand has ever reached and that have not yet decayed. */
  revealed: number;
  /** Bodies the last ping actually tested, after range/cone/occlusion rejection. */
  tested: number;
  /** Bodies still queued for the current ping. */
  pending: number;
  /** Points garbage-collected because the thing they were on moved. */
  forgotten: number;
  /** Contour segments across all props — one draw call, drawn only where a body is revealed. */
  segments: number;
  unlockMs: number;
}

interface Job {
  ox: number;
  oy: number;
  oz: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  cos: number;
  omni: boolean;
  radius: number;
  speed: number;
  t0: number;
  slot: number;
  bodies: number[];
  cursor: number;
}

/** Coarse XZ grid over the static boxes, so an occlusion ray does not scan the whole hall. */
class RayGrid {
  private readonly cell = 4;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly cells: number[][];

  constructor(private readonly boxes: readonly Aabb[]) {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b.minX);
      minZ = Math.min(minZ, b.minZ);
      maxX = Math.max(maxX, b.maxX);
      maxZ = Math.max(maxZ, b.maxZ);
    }
    this.minX = minX;
    this.minZ = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / this.cell));
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / this.cell));
    this.cells = Array.from({ length: this.nx * this.nz }, () => [] as number[]);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const x0 = this.clampX(Math.floor((b.minX - minX) / this.cell));
      const x1 = this.clampX(Math.floor((b.maxX - minX) / this.cell));
      const z0 = this.clampZ(Math.floor((b.minZ - minZ) / this.cell));
      const z1 = this.clampZ(Math.floor((b.maxZ - minZ) / this.cell));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.cells[z * this.nx + x]!.push(i);
    }
  }

  private clampX(v: number): number {
    return Math.min(this.nx - 1, Math.max(0, v));
  }

  private clampZ(v: number): number {
    return Math.min(this.nz - 1, Math.max(0, v));
  }

  /** True when a static box stands between the two points. Grid-walked along XZ. */
  blocked(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number, skin: number): boolean {
    const dx = tx - ox;
    const dy = ty - oy;
    const dz = tz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return false;
    const maxT = len - skin;
    if (maxT <= 0) return false;
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    const steps = Math.max(1, Math.ceil(len / this.cell) + 1);
    let seen = -1;
    for (let s = 0; s < steps; s++) {
      const t = (s / steps) * len;
      const cx = this.clampX(Math.floor((ox + ux * t - this.minX) / this.cell));
      const cz = this.clampZ(Math.floor((oz + uz * t - this.minZ) / this.cell));
      const key = cz * this.nx + cx;
      if (key === seen) continue;
      seen = key;
      for (const i of this.cells[key]!) {
        if (this.hits(this.boxes[i]!, ox, oy, oz, ux, uy, uz, maxT)) return true;
      }
    }
    return false;
  }

  private hits(
    b: Aabb, ox: number, oy: number, oz: number, ux: number, uy: number, uz: number, maxT: number,
  ): boolean {
    let near = 0;
    let far = maxT;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? ox : a === 1 ? oy : oz;
      const d = a === 0 ? ux : a === 1 ? uy : uz;
      const lo = a === 0 ? b.minX : a === 1 ? b.minY : b.minZ;
      const hi = a === 0 ? b.maxX : a === 1 ? b.maxY : b.maxZ;
      if (Math.abs(d) < 1e-8) {
        if (o < lo || o > hi) return false;
        continue;
      }
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > near) near = t1;
      if (t2 < far) far = t2;
      if (near > far) return false;
    }
    return near <= far && far > 0;
  }
}

export class DynamicPaint {
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private readonly edgeGeometry = new THREE.BufferGeometry();
  private readonly edgeMaterial: THREE.ShaderMaterial;
  private readonly lines: THREE.LineSegments;
  private readonly group = new THREE.Group();
  /** Per body: when its contour was first drawn. Lives in the body texture, texel 2 z. */
  private readonly contourBirth: Float32Array;

  /** Per-point: which body, local position, outward normal (CPU only), stamps (GPU). */
  private readonly bodyOf: Int32Array;
  private readonly local: Float32Array;
  private readonly normal: Float32Array;
  private readonly birth: Float32Array;
  private readonly prior: Float32Array;
  private readonly wave: Float32Array;
  /** First point index of each body, plus a terminator. */
  private readonly start: Int32Array;

  private readonly tex: THREE.DataTexture;
  private readonly texData: Float32Array;

  private job: Job | null = null;
  private dirtyMin = Infinity;
  private dirtyMax = -Infinity;
  private time = 0;
  /** Per body: how many of its points are currently stamped. Cheap "is there anything to GC". */
  private readonly liveCount: Int32Array;
  private readonly gcAt: Float32Array;
  private readonly grid: RayGrid;
  private stats: DynamicStats = {
    points: 0, revealed: 0, tested: 0, pending: 0, forgotten: 0, segments: 0, unlockMs: 0,
  };

  /** How long a sighting of something in motion survives, seconds. */
  decaySeconds = 3.2;

  constructor(
    private readonly props: PaintBodies,
    statics: StaticWorld,
    ramp: AgeRamp,
    tunables: StructuredTunables,
    waves: { a: THREE.Vector4[]; b: THREE.Vector4[] },
  ) {
    this.grid = new RayGrid(statics.boxes);
    const n = props.count;
    this.start = new Int32Array(n + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      this.start[i] = total;
      total += props.cloudOf(i).count;
    }
    this.start[n] = total;

    this.bodyOf = new Int32Array(total);
    this.local = new Float32Array(total * 3);
    this.normal = new Float32Array(total * 3);
    this.birth = new Float32Array(total).fill(NEVER);
    this.prior = new Float32Array(total).fill(NEVER);
    this.wave = new Float32Array(total);
    this.liveCount = new Int32Array(n);
    this.gcAt = new Float32Array(n).fill(Infinity);
    const seed = new Float32Array(total);
    const scale = new Float32Array(total);

    for (let i = 0; i < n; i++) {
      const cloud = props.cloudOf(i);
      const at = this.start[i]!;
      for (let k = 0; k < cloud.count; k++) {
        const o = (at + k) * 3;
        this.local[o] = cloud.pos[k * 3]!;
        this.local[o + 1] = cloud.pos[k * 3 + 1]!;
        this.local[o + 2] = cloud.pos[k * 3 + 2]!;
        this.normal[o] = cloud.nrm[k * 3]!;
        this.normal[o + 1] = cloud.nrm[k * 3 + 1]!;
        this.normal[o + 2] = cloud.nrm[k * 3 + 2]!;
        this.bodyOf[at + k] = i;
        seed[at + k] = ((at + k) * 0.6180339887) % 1;
        scale[at + k] = cloud.pitch / tunables.spacing;
      }
    }
    this.stats.points = total;

    /*
     * The contour buffer. Built flat, once, exactly like the points: a body's outline never
     * changes in its own frame either. Small things get a dimmer line — a floor of jars each
     * shouting as loudly as a barrel is the "каша из линий" this pass exists to avoid.
     */
    this.contourBirth = new Float32Array(n).fill(NEVER);
    let segs = 0;
    for (let i = 0; i < n; i++) segs += props.edgesOf(i).segments;
    const epos = new Float32Array(segs * 6);
    const enrm = new Float32Array(segs * 6);
    const ebody = new Float32Array(segs * 2);
    const eweight = new Float32Array(segs * 2);
    let eAt = 0;
    for (let i = 0; i < n; i++) {
      const e = props.edgesOf(i);
      const span = props.cloudOf(i).radius;
      const weight = 0.4 + 0.6 * Math.min(1, span / 0.45);
      for (let k = 0; k < e.segments * 2; k++) {
        epos[(eAt + k) * 3] = e.pos[k * 3]!;
        epos[(eAt + k) * 3 + 1] = e.pos[k * 3 + 1]!;
        epos[(eAt + k) * 3 + 2] = e.pos[k * 3 + 2]!;
        enrm[(eAt + k) * 3] = e.nrm[k * 3]!;
        enrm[(eAt + k) * 3 + 1] = e.nrm[k * 3 + 1]!;
        enrm[(eAt + k) * 3 + 2] = e.nrm[k * 3 + 2]!;
        ebody[eAt + k] = i;
        eweight[eAt + k] = weight;
      }
      eAt += e.segments * 2;
    }
    this.stats.segments = segs;
    const eg = this.edgeGeometry;
    eg.setAttribute('position', new THREE.BufferAttribute(epos, 3));
    eg.setAttribute('aNormal', new THREE.BufferAttribute(enrm, 3));
    eg.setAttribute('aBody', new THREE.BufferAttribute(ebody, 1));
    eg.setAttribute('aWeight', new THREE.BufferAttribute(eweight, 1));
    eg.setDrawRange(0, segs * 2);
    eg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const rows = Math.max(1, Math.ceil((n * TEXELS) / TEX_W));
    this.texData = new Float32Array(TEX_W * rows * 4);
    this.tex = new THREE.DataTexture(this.texData, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;

    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(this.local, 3));
    g.setAttribute('aBody', new THREE.BufferAttribute(Float32Array.from(this.bodyOf), 1));
    g.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    g.setAttribute('aPrior', new THREE.BufferAttribute(this.prior, 1));
    g.setAttribute('aWave', new THREE.BufferAttribute(this.wave, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    g.setAttribute('aNormal', new THREE.BufferAttribute(this.normal, 3));
    g.setDrawRange(0, total);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProjScale: { value: 500 },
        uWindowRadius: { value: 45 },
        uSizeWorld: { value: tunables.dotSize },
        uPixelCap: { value: tunables.pixelCap },
        uRipple: { value: tunables.ripple },
        uRingWidth: { value: tunables.ringWidth },
        uRefreshSeconds: { value: 0.3 },
        uDotBright: { value: tunables.dotBright },
        uProbeBright: { value: tunables.probeBright },
        uProbeSize: { value: tunables.probeSize },
        uProbeSoft: { value: tunables.probeSoftness },
        uDotSoft: { value: tunables.dotSoftness },
        uSkeletonSize: { value: ramp.skeletonSize },
        uDecaySeconds: { value: this.decaySeconds },
        uRampTimes: { value: new THREE.Vector3(ramp.freshSeconds, ramp.coolSeconds, ramp.coldSeconds) },
        uSkeletonAlpha: { value: ramp.skeletonAlpha },
        uFresh: { value: rawColor(0xeaffff) },
        uMid: { value: rawColor(0x28c8e6) },
        uCold: { value: rawColor(0x16536e) },
        uListener: { value: new THREE.Vector3() },
        uHand: { value: new THREE.Vector3(0, -1e5, 0) },
        uHandSpan: { value: 1.2 },
        uTouchColor: { value: rawColor(TOUCH_GREY) },
        uTouchRange: { value: 0.55 },
        uTouchNear: { value: 1 },
        uTouchMemory: { value: 0 },
        uTouchOn: { value: 1 },
        uBodies: { value: this.tex },
        uBodyTex: { value: new THREE.Vector2(TEX_W, rows) },
        uWaveA: { value: waves.a },
        uWaveB: { value: waves.b },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.edgeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uWindowRadius: { value: 45 },
        uBright: { value: tunables.contourBright * 0.62 },
        uDecaySeconds: { value: this.decaySeconds },
        uListener: { value: new THREE.Vector3() },
        uRampTimes: { value: new THREE.Vector3(ramp.freshSeconds, ramp.coolSeconds, ramp.coldSeconds) },
        uSkeletonAlpha: { value: ramp.skeletonAlpha },
        uFresh: { value: rawColor(0xeaffff) },
        uMid: { value: rawColor(0x28c8e6) },
        uCold: { value: rawColor(0x16536e) },
        uBodies: { value: this.tex },
        uBodyTex: { value: new THREE.Vector2(TEX_W, rows) },
      },
      vertexShader: EDGE_VERTEX,
      fragmentShader: EDGE_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    this.lines = new THREE.LineSegments(this.edgeGeometry, this.edgeMaterial);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;
    this.group.add(this.points, this.lines);
    this.group.visible = false;
  }

  get object(): THREE.Object3D {
    return this.group;
  }

  setActive(on: boolean): void {
    this.group.visible = on;
  }

  getStats(): DynamicStats {
    this.stats.pending = this.job === null ? 0 : this.job.bodies.length - this.job.cursor;
    return this.stats;
  }

  setListener(x: number, y: number, z: number): void {
    (this.material.uniforms.uListener!.value as THREE.Vector3).set(x, y, z);
    (this.edgeMaterial.uniforms.uListener!.value as THREE.Vector3).set(x, y, z);
  }

  setProjScale(v: number): void {
    this.material.uniforms.uProjScale!.value = v;
  }

  setWindow(radius: number, refreshSeconds: number): void {
    this.edgeMaterial.uniforms.uWindowRadius!.value = radius;
    this.material.uniforms.uWindowRadius!.value = radius;
    this.material.uniforms.uRefreshSeconds!.value = refreshSeconds;
  }

  setHand(x: number, y: number, z: number, span: number, range: number, near: number): void {
    (this.material.uniforms.uHand!.value as THREE.Vector3).set(x, y, z);
    this.material.uniforms.uHandSpan!.value = span;
    this.material.uniforms.uTouchRange!.value = range;
    this.material.uniforms.uTouchNear!.value = near;
  }

  setTouchVisible(on: boolean): void {
    this.material.uniforms.uTouchOn!.value = on ? 1 : 0;
  }

  /** Wipes every stamp. The debug "forget the map" key, and nothing else. */
  clear(): void {
    this.contourBirth.fill(NEVER);
    this.birth.fill(NEVER);
    this.prior.fill(NEVER);
    this.liveCount.fill(0);
    this.gcAt.fill(Infinity);
    this.job = null;
    this.stats.revealed = 0;
    this.mark(0, this.birth.length - 1);
  }

  /**
   * Pushes body transforms to the GPU and expires whatever the movement invalidated. Once per
   * frame; a sleeping body writes the same three texels it wrote last time, which is the cheapest
   * correct thing to do and keeps the upload one contiguous block.
   */
  update(now: number): void {
    this.time = now;
    // The body source refreshes itself here, once, before any consumer reads a transform.
    this.props.sync?.();
    this.material.uniforms.uTime!.value = now;
    this.material.uniforms.uDecaySeconds!.value = this.decaySeconds;
    this.edgeMaterial.uniforms.uTime!.value = now;
    this.edgeMaterial.uniforms.uDecaySeconds!.value = this.decaySeconds;
    const p = this.props;
    const d = this.texData;
    for (let i = 0; i < p.count; i++) {
      const o = i * TEXELS * 4;
      d[o] = p.pos[i * 3]!;
      d[o + 1] = p.pos[i * 3 + 1]!;
      d[o + 2] = p.pos[i * 3 + 2]!;
      d[o + 3] = 0;
      d[o + 4] = p.quat[i * 4]!;
      d[o + 5] = p.quat[i * 4 + 1]!;
      d[o + 6] = p.quat[i * 4 + 2]!;
      d[o + 7] = p.quat[i * 4 + 3]!;
      d[o + 8] = p.settleAt[i]!;
      d[o + 9] = p.moving[i]!;
      d[o + 10] = this.contourBirth[i]!;
      // Anything not permanent has an expiry; run the sweep once, a moment after it is invisible.
      if (this.liveCount[i]! > 0 && (p.moving[i] === 1 || this.gcAt[i]! < Infinity)) {
        if (p.moving[i] === 1) this.gcAt[i] = now + this.decaySeconds + 0.2;
        else if (now > this.gcAt[i]!) this.expire(i);
      }
    }
    this.tex.needsUpdate = true;
    this.upload();
  }

  /** Drops every non-permanent stamp on body `i` back to "never known". */
  private expire(i: number): void {
    const settle = this.props.settleAt[i]!;
    const from = this.start[i]!;
    const to = this.start[i + 1]!;
    let live = 0;
    let killed = 0;
    for (let k = from; k < to; k++) {
      if (this.birth[k]! <= NEVER * 0.5) continue;
      if (this.birth[k]! >= settle && this.props.moving[i] === 0) {
        live++;
        continue;
      }
      this.birth[k] = NEVER;
      this.prior[k] = NEVER;
      killed++;
    }
    if (killed > 0) {
      this.mark(from, to - 1);
      this.stats.revealed -= killed;
      this.stats.forgotten += killed;
    }
    this.liveCount[i] = live;
    this.gcAt[i] = Infinity;
    // The outline goes with the points: a body that moved is no longer where its contour says.
    if (live === 0) this.contourBirth[i] = NEVER;
    else if (this.contourBirth[i]! < settle) this.contourBirth[i] = settle;
  }

  // -- reveal ---------------------------------------------------------------

  /** Queues the bodies a front could possibly reach. Cheap: one sphere test per prop. */
  handle(event: LidarPing, slot: number): void {
    const p = this.props;
    const half = (Math.min(360, event.coneAngleDeg) / 2) * (Math.PI / 180);
    const bodies: number[] = [];
    const omni = event.coneAngleDeg >= 359.9;
    for (let i = 0; i < p.count; i++) {
      const r = p.cloudOf(i).radius;
      const dx = p.pos[i * 3]! - event.x;
      const dy = p.pos[i * 3 + 1]! - event.y;
      const dz = p.pos[i * 3 + 2]! - event.z;
      const d = Math.hypot(dx, dy, dz);
      if (d - r > event.paintRadius) continue;
      if (!omni && d > r) {
        const cosA = (dx * event.dirX + dy * event.dirY + dz * event.dirZ) / d;
        const angle = Math.acos(Math.min(1, Math.max(-1, cosA)));
        if (angle - Math.asin(Math.min(1, r / d)) > half) continue;
      }
      bodies.push(i);
    }
    this.job = {
      ox: event.x, oy: event.y, oz: event.z,
      dirX: event.dirX, dirY: event.dirY, dirZ: event.dirZ,
      cos: Math.cos(half), omni,
      radius: event.paintRadius, speed: event.waveSpeed, t0: event.time,
      slot, bodies, cursor: 0,
    };
    this.stats.tested = 0;
  }

  /** Unlocks queued bodies until the budget runs out. Whole bodies: a prop is a few hundred points. */
  advance(budgetMs: number): void {
    const job = this.job;
    if (job === null) return;
    const t0 = performance.now();
    while (job.cursor < job.bodies.length) {
      this.unlockBody(job, job.bodies[job.cursor++]!);
      if (performance.now() - t0 > budgetMs) break;
    }
    if (job.cursor >= job.bodies.length) this.job = null;
    this.stats.unlockMs = performance.now() - t0;
  }

  /** Runs the whole queue now. Harness only — a screenshot must never catch a half-drawn front. */
  drain(): void {
    while (this.job !== null) this.advance(1e6);
  }

  private unlockBody(job: Job, i: number): void {
    const p = this.props;
    const px = p.pos[i * 3]!;
    const py = p.pos[i * 3 + 1]!;
    const pz = p.pos[i * 3 + 2]!;
    // One occlusion ray per body, to its centre, against the static hall. Props do not shadow
    // each other: at a 4 cm point pitch that would cost more than the whole rest of the reveal,
    // and the facing test already hides the far side of every individual thing.
    if (this.grid.blocked(job.ox, job.oy, job.oz, px, py, pz, p.cloudOf(i).radius + 0.05)) return;
    this.stats.tested++;

    // The front, in the body's frame. From here on the arithmetic is the static path's.
    const qx = -p.quat[i * 4]!;
    const qy = -p.quat[i * 4 + 1]!;
    const qz = -p.quat[i * 4 + 2]!;
    const qw = p.quat[i * 4 + 3]!;
    const rot = (vx: number, vy: number, vz: number, out: number[]): void => {
      const tx = 2 * (qy * vz - qz * vy);
      const ty = 2 * (qz * vx - qx * vz);
      const tz = 2 * (qx * vy - qy * vx);
      out[0] = vx + qw * tx + (qy * tz - qz * ty);
      out[1] = vy + qw * ty + (qz * tx - qx * tz);
      out[2] = vz + qw * tz + (qx * ty - qy * tx);
    };
    const o: number[] = [0, 0, 0];
    rot(job.ox - px, job.oy - py, job.oz - pz, o);
    const d: number[] = [0, 0, 0];
    rot(job.dirX, job.dirY, job.dirZ, d);
    const ox = o[0]!;
    const oy = o[1]!;
    const oz = o[2]!;

    const from = this.start[i]!;
    const to = this.start[i + 1]!;
    const r2 = job.radius * job.radius;
    let live = this.liveCount[i]!;
    let touched = false;
    for (let k = from; k < to; k++) {
      const k3 = k * 3;
      const dx = this.local[k3]! - ox;
      const dy = this.local[k3 + 1]! - oy;
      const dz = this.local[k3 + 2]! - oz;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 > r2) continue;
      const dist = Math.sqrt(dist2);
      const inv = dist > 1e-5 ? 1 / dist : 0;
      // Facing: a return only comes off a surface pointed at the source.
      if ((dx * this.normal[k3]! + dy * this.normal[k3 + 1]! + dz * this.normal[k3 + 2]!) * inv > -0.06) continue;
      if (!job.omni && dist > 1e-5) {
        if ((dx * d[0]! + dy * d[1]! + dz * d[2]!) * inv < job.cos) continue;
      }
      const arrival = job.t0 + dist / job.speed;
      const was = this.birth[k]!;
      if (was <= NEVER * 0.5) live++;
      else this.prior[k] = was;
      this.birth[k] = arrival;
      this.wave[k] = job.slot;
      touched = true;
    }
    if (!touched) return;
    // The contour is stamped once per body, at the arrival time at its centre: an outline is a
    // statement about the whole shape, so half of one would be a lie either way.
    const cd = Math.hypot(job.ox - px, job.oy - py, job.oz - pz);
    const at = job.t0 + cd / job.speed;
    if (this.contourBirth[i]! <= NEVER * 0.5 || at < this.contourBirth[i]!) this.contourBirth[i] = at;
    this.stats.revealed += live - this.liveCount[i]!;
    this.liveCount[i] = live;
    this.mark(from, to - 1);
    if (this.props.moving[i] === 1) this.gcAt[i] = this.time + this.decaySeconds + 0.2;
  }

  /**
   * The hand, on things that can be knocked over. Same reach column as the static mask, and the
   * same silence: feeling a can tells you a can is there, not what is behind it.
   */
  revealTouch(x: number, y: number, z: number, span: number, radius: number): number {
    const p = this.props;
    let found = 0;
    const midY = y + span / 2;
    const reach = radius + span / 2;
    for (let i = 0; i < p.count; i++) {
      const cr = p.cloudOf(i).radius;
      const dx = p.pos[i * 3]! - x;
      const dy = p.pos[i * 3 + 1]! - midY;
      const dz = p.pos[i * 3 + 2]! - z;
      if (dx * dx + dy * dy + dz * dz > (reach + cr) * (reach + cr)) continue;
      const qx = -p.quat[i * 4]!;
      const qy = -p.quat[i * 4 + 1]!;
      const qz = -p.quat[i * 4 + 2]!;
      const qw = p.quat[i * 4 + 3]!;
      // The reach column, in the body's frame: two endpoints, and the segment between them.
      const a: number[] = [0, 0, 0];
      const b: number[] = [0, 0, 0];
      const rot = (vx: number, vy: number, vz: number, out: number[]): void => {
        const tx = 2 * (qy * vz - qz * vy);
        const ty = 2 * (qz * vx - qx * vz);
        const tz = 2 * (qx * vy - qy * vx);
        out[0] = vx + qw * tx + (qy * tz - qz * ty);
        out[1] = vy + qw * ty + (qz * tx - qx * tz);
        out[2] = vz + qw * tz + (qx * ty - qy * tx);
      };
      rot(x - p.pos[i * 3]!, y - p.pos[i * 3 + 1]!, z - p.pos[i * 3 + 2]!, a);
      rot(x - p.pos[i * 3]!, y + span - p.pos[i * 3 + 1]!, z - p.pos[i * 3 + 2]!, b);
      const ex = b[0]! - a[0]!;
      const ey = b[1]! - a[1]!;
      const ez = b[2]! - a[2]!;
      const ee = Math.max(1e-6, ex * ex + ey * ey + ez * ez);
      const from = this.start[i]!;
      const to = this.start[i + 1]!;
      let live = this.liveCount[i]!;
      let hit = false;
      for (let k = from; k < to; k++) {
        const k3 = k * 3;
        const rx = this.local[k3]! - a[0]!;
        const ry = this.local[k3 + 1]! - a[1]!;
        const rz = this.local[k3 + 2]! - a[2]!;
        const t = Math.min(1, Math.max(0, (rx * ex + ry * ey + rz * ez) / ee));
        const cx = rx - ex * t;
        const cy = ry - ey * t;
        const cz = rz - ez * t;
        if (cx * cx + cy * cy + cz * cz > radius * radius) continue;
        // Felt, not scanned: the point becomes drawable but carries no birth stamp, exactly as
        // in the static mask. `aBirth == NEVER` *is* "the hand found this".
        if (this.birth[k]! <= NEVER * 0.5) {
          found++;
          hit = true;
        }
      }
      if (hit) {
        this.liveCount[i] = live;
      }
    }
    return found;
  }

  private mark(lo: number, hi: number): void {
    if (lo < this.dirtyMin) this.dirtyMin = lo;
    if (hi > this.dirtyMax) this.dirtyMax = hi;
  }

  private upload(): void {
    if (this.dirtyMax < this.dirtyMin) return;
    const start = this.dirtyMin;
    const count = this.dirtyMax - start + 1;
    for (const name of ['aBirth', 'aPrior', 'aWave']) {
      const attr = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(start, count);
      attr.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -Infinity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.tex.dispose();
  }
}
