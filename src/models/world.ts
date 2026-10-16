import * as THREE from 'three';
import type { ModelDef } from './types';
import { PALETTE, SUN_DIR } from '../style';

// ============================================================================
// RAMPAGE PEAK — the environment.
//
// A flat plateau (y = 0) on top of a ~300 m rock spire, a sea of clouds around
// y = CLOUD_Y, a valley floor at y = VALLEY_Y, rings of snow-capped mountains
// out to ~2.6 km and a gradient sky dome with a sun disk.
//
// Angles: angle = Math.atan2(z, x)  (a point on the rim is (cos a * r, 0, sin a * r)).
// Atmospheric haze is baked into every world material (a per-direction fog that
// fades to the exact sky color), so no scene.fog is needed.
// ============================================================================

export const PLATEAU_TOP_Y = 0;
export const CLOUD_Y = -120;
export const VALLEY_Y = -300;
/** Nominal plateau radius (the real rim is edgeRadius(angle), between ~8.0 and ~10.0). */
export const PLATEAU_RADIUS = 9;

const EDGE_TERMS: [number, number, number][] = [
  [2, 0.32, 0.6],
  [3, 0.38, 1.3],
  [5, 0.24, 4.1],
  [7, 0.13, 2.2],
  [11, 0.07, 5.5],
];

/** Walkable rim radius (m from the plateau center) at angle = atan2(z, x). */
export function edgeRadius(angle: number): number {
  let r = PLATEAU_RADIUS;
  for (const [k, a, p] of EDGE_TERMS) r += a * Math.sin(k * angle + p);
  return r;
}

/** True if (x, z) is on the walkable plateau top. */
export function onPlateau(x: number, z: number): boolean {
  return Math.hypot(x, z) <= edgeRadius(Math.atan2(z, x));
}

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x: number, y: number, oct = 3): number {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += noise2(x * f, y * f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}
const smooth = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = THREE.MathUtils.lerp;

// ---------------------------------------------------------------------------
// cliff / valley shape (exported for gameplay & the fall cinematic)
// ---------------------------------------------------------------------------

/** Average spire radius at height y (y <= 0), before ledges/outcrops. */
function cliffBase(y: number): number {
  const d = Math.max(0, -y);
  return 8.6 + 0.05 * d + 0.00007 * d * d;
}

/** Smooth spire surface radius at (angle, y). */
function cliffShape(a: number, y: number): number {
  const d = -y;
  const top = edgeRadius(a);
  // Near the top the outline follows the rim with an undercut (overhang) a few m down.
  const nearTop = top + lerp(0.35, -0.9, smooth(1, 12, d));
  const n = fbm(Math.cos(a) * 1.6 + 7.3 + d * 0.012, Math.sin(a) * 1.6 - 3.1 + d * 0.004, 3) - 0.5;
  const deep = cliffBase(y) * (1 + 0.32 * n) + (top - PLATEAU_RADIUS) * (1 - smooth(20, 120, d));
  return lerp(nearTop, deep, smooth(8, 40, d));
}

/**
 * Conservative outer radius of the spire (incl. ledges and outcrops) at height y.
 * Keep a falling body farther than this from the spire axis to avoid clipping the cliff.
 */
export function cliffRadius(y: number): number {
  if (y > 0) return 0;
  let m = 0;
  for (let i = 0; i < 48; i++) m = Math.max(m, cliffShape((i / 48) * Math.PI * 2, y));
  return m + (y < -14 ? 6 : 1.2);
}

const FLAT_R = 190; // valley floor is exactly VALLEY_Y inside this radius
const LAKE = { x: 120, z: -95, r: 34 };

/** Valley ground height at (x, z). Flat (= VALLEY_Y) near the spire foot, rolling hills farther out. */
export function valleyHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const hills = (fbm(x * 0.006 + 11, z * 0.006 - 4, 3) - 0.35) * 70 + Math.pow(Math.max(0, r - FLAT_R) / 900, 2) * 260;
  return VALLEY_Y + Math.min(110, Math.max(0, hills)) * smooth(FLAT_R, FLAT_R + 260, r);
}

/** A good BOOM landing point: open meadow at the spire foot (fallers off the rim land around here). */
export const LANDING_SPOT = new THREE.Vector3(0, VALLEY_Y, 0); // use any (x,z) with 50 < r < 110 for a clean meadow

// ---------------------------------------------------------------------------
// sky + haze (shared GLSL so distant geometry fades to exactly the sky color)
// ---------------------------------------------------------------------------
const lin = (hex: number) => new THREE.Color(hex); // THREE.Color stores linear values
const v3 = (c: THREE.Color) => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;
const SUN = SUN_DIR.clone().normalize();

const SKY_GLSL = /* glsl */ `
vec3 rpSkyColor(vec3 d) {
  const vec3 zenith = ${v3(lin(PALETTE.skyZenith))};
  const vec3 mid = ${v3(lin(PALETTE.skyMid))};
  const vec3 warm = ${v3(lin(PALETTE.skyHorizon))};
  const vec3 cool = ${v3(lin(PALETTE.skyHorizonCool))};
  const vec3 sunDir = vec3(${SUN.x.toFixed(5)}, ${SUN.y.toFixed(5)}, ${SUN.z.toFixed(5)});
  float h = d.y;
  vec2 hz = normalize(d.xz + vec2(1e-5));
  float toward = dot(hz, normalize(sunDir.xz)) * 0.5 + 0.5;
  vec3 horizon = mix(cool, warm, pow(toward, 1.6));
  float hp = max(h, 0.0);
  vec3 col = mix(horizon, mid, smoothstep(0.0, 0.28, hp));
  col = mix(col, zenith, smoothstep(0.22, 0.95, hp));
  // below the horizon: hazy horizon color
  col = mix(col, horizon * 0.96, smoothstep(0.0, -0.25, h));
  return col;
}
`;

const HAZE_DENSITY = 0.00042;
const HAZE_START = 180;

function hazed<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRpWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 rpw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  rpw = instanceMatrix * rpw;
  #endif
  vRpWorld = (modelMatrix * rpw).xyz;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRpWorld;\n${SKY_GLSL}`)
      .replace(
        '#include <tonemapping_fragment>',
        `{
  vec3 rpd = vRpWorld - cameraPosition;
  float rpDist = length(rpd);
  float rpF = 1.0 - exp(-max(rpDist - ${HAZE_START.toFixed(1)}, 0.0) * ${HAZE_DENSITY.toFixed(6)});
  vec3 rpDir = rpd / max(rpDist, 1e-3);
  rpDir.y = clamp(rpDir.y, -0.25, 0.12);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, rpSkyColor(normalize(rpDir)), clamp(rpF, 0.0, 0.97));
}
#include <tonemapping_fragment>`,
      );
  };
  m.customProgramCacheKey = () => 'rp-haze-v1';
  return m;
}

function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(100, 48, 24);
  const sunCol = lin(PALETTE.sunDisk);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    vertexShader: /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
  gl_Position.z = gl_Position.w * 0.99999;
}`,
    fragmentShader: /* glsl */ `
varying vec3 vDir;
${SKY_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = rpSkyColor(d);
  const vec3 sunDir = vec3(${SUN.x.toFixed(5)}, ${SUN.y.toFixed(5)}, ${SUN.z.toFixed(5)});
  float s = max(dot(d, sunDir), 0.0);
  vec3 sunCol = ${v3(sunCol)};
  col += vec3(1.0, 0.62, 0.32) * (pow(s, 6.0) * 0.22 + pow(s, 48.0) * 0.35);
  float disk = smoothstep(0.99935, 0.99950, s);
  col = mix(col, sunCol * 1.15, disk);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`,
  });
  const m = new THREE.Mesh(geo, material);
  m.name = 'sky';
  m.frustumCulled = false;
  m.renderOrder = -1000;
  return m;
}

// ---------------------------------------------------------------------------
// faceted geometry builder (non-indexed, per-face vertex colors)
// ---------------------------------------------------------------------------
type Shade = (c: THREE.Vector3, n: THREE.Vector3) => THREE.Color;

class Faces {
  pos: number[] = [];
  col: number[] = [];
  private e1 = new THREE.Vector3();
  private e2 = new THREE.Vector3();
  private n = new THREE.Vector3();
  private c = new THREE.Vector3();

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, shade: Shade) {
    this.e1.subVectors(b, a);
    this.e2.subVectors(c, a);
    this.n.crossVectors(this.e1, this.e2);
    const len = this.n.length();
    if (len < 1e-6) return;
    this.n.divideScalar(len);
    this.c.set((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
    const col = shade(this.c, this.n);
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) this.col.push(col.r, col.g, col.b);
  }

  /** Rings ordered from the top/center outward & downward, each with the same vertex count. */
  rings(rings: THREE.Vector3[][], shade: Shade) {
    for (let i = 0; i < rings.length - 1; i++) {
      const A = rings[i], B = rings[i + 1], N = A.length;
      for (let j = 0; j < N; j++) {
        const j2 = (j + 1) % N;
        this.tri(A[j], A[j2], B[j], shade);
        this.tri(A[j2], B[j2], B[j], shade);
      }
    }
  }

  /** Stitch two closed rings with different vertex counts (each ordered by increasing angle from ~0). */
  stitch(A: THREE.Vector3[], B: THREE.Vector3[], shade: Shade) {
    const na = A.length, nb = B.length;
    const ang = (R: THREE.Vector3[], k: number) => {
      const p = R[k % R.length];
      let a = Math.atan2(p.z, p.x);
      if (a < -1e-3) a += Math.PI * 2;
      if (R.length === 1) a = 0;
      return a + Math.PI * 2 * Math.floor(k / R.length);
    };
    let i = 0, j = 0;
    while (i < na || j < nb) {
      const advA = j >= nb || (i < na && ang(A, i + 1) < ang(B, j + 1));
      if (advA) {
        this.tri(A[i % na], A[(i + 1) % na], B[j % nb], shade);
        i++;
      } else {
        this.tri(A[i % na], B[(j + 1) % nb], B[j % nb], shade);
        j++;
      }
    }
  }

  /** Add a three.js primitive (transformed by m), keeping its winding. */
  geometry(g: THREE.BufferGeometry, m: THREE.Matrix4, shade: Shade) {
    const ng = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
    const p = ng.getAttribute('position');
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i);
      b.fromBufferAttribute(p, i + 1);
      c.fromBufferAttribute(p, i + 2);
      this.tri(a, b, c, shade);
    }
    ng.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const vcMatCache = new Map<string, THREE.Material>();
function vcMat(key: string, opts: THREE.MeshStandardMaterialParameters = {}): THREE.Material {
  let m = vcMatCache.get(key);
  if (!m) {
    m = hazed(
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0, ...opts }),
    );
    vcMatCache.set(key, m);
  }
  return m;
}

/** Far scenery never casts shadows (the sun's shadow box only covers the plateau anyway). */
function noShadowCast(o: THREE.Object3D) {
  Object.defineProperty(o, 'castShadow', { get: () => false, set: () => {}, configurable: true });
}

const tmpCol = new THREE.Color();
function jitter(hex: number, rng: () => number, amt = 0.06): THREE.Color {
  return tmpCol.set(hex).multiplyScalar(1 + (rng() - 0.5) * 2 * amt);
}

// ---------------------------------------------------------------------------
// plateau + spire
// ---------------------------------------------------------------------------
const SEG = 64;
const ANG = Array.from({ length: SEG }, (_, j) => (j / SEG) * Math.PI * 2);
const CSEG = 26;
const CANG = Array.from({ length: CSEG }, (_, j) => (j / CSEG) * Math.PI * 2);
const LEDGES = [-16, -31, -52, -74, -97, -141, -168, -197, -226, -258];

interface LedgeSpot { a: number; y: number; r: number; w: number }

function buildSpire(rng: () => number): { mesh: THREE.Mesh; ledgeSpots: LedgeSpot[] } {
  const F = new Faces();
  const rings: THREE.Vector3[][] = [];
  const P = (a: number, r: number, y: number) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);

  // --- flat top (y = 0 exactly): few big calm facets, stitched to the 64-seg rim ---
  const topRings: THREE.Vector3[][] = [[new THREE.Vector3(0, 0, 0)]];
  for (const [f, n] of [[0.4, 7], [0.78, 13], [0.9, 24]] as const) {
    const a0 = rng() * 0.3;
    topRings.push(Array.from({ length: n }, (_, k) => {
      const a = a0 + ((k + (rng() - 0.5) * 0.3) / n) * Math.PI * 2;
      return P(a, edgeRadius(a) * f, 0);
    }));
  }
  const rim = ANG.map((a) => P(a, edgeRadius(a), 0)); // the rim (walkable edge)
  topRings.push(rim);
  rings.push(rim);
  // --- lip: rounded break, then the drop ---
  rings.push(ANG.map((a) => P(a, edgeRadius(a) + 0.32 + rng() * 0.1, -0.28 - rng() * 0.08)));
  rings.push(ANG.map((a) => P(a, edgeRadius(a) + 0.42 + rng() * 0.15, -1.1 - rng() * 0.3)));
  const upper = rings.splice(0, rings.length);

  // --- cliff rings with ledges ---
  const ledgeSpots: LedgeSpot[] = [];
  let y = -2.6;
  const ys: number[] = [];
  while (y > -282) {
    ys.push(y);
    y -= y > -20 ? 3 + rng() * 3 : 8 + rng() * 9;
  }
  for (const ly of LEDGES) ys.push(ly);
  ys.sort((a, b) => b - a);
  for (const yy of ys) {
    const isLedge = LEDGES.includes(yy);
    const seed = rng() * 100;
    const ring = CANG.map((a) => {
      const aj = a + (rng() - 0.5) * 0.4 * (Math.PI * 2 / CSEG);
      const rj = (rng() - 0.5) * (yy > -12 ? 0.3 : 0.9);
      return P(aj, cliffShape(aj, yy) + rj, yy + (isLedge ? 0 : (rng() - 0.5) * (yy > -12 ? 0.6 : 2.4)));
    });
    rings.push(ring);
    if (isLedge) {
      // a partial shelf sticking out: same height, larger radius where noise says so
      const out = ring.map((p, j) => {
        const a = CANG[j];
        const e = Math.max(0, (noise2(Math.cos(a) * 2.2 + seed, Math.sin(a) * 2.2) - 0.42) * 11);
        const r = Math.hypot(p.x, p.z) + e;
        if (e > 2.2 && j % 2 === 0) ledgeSpots.push({ a, y: yy, r: r - e * 0.5, w: e });
        return P(Math.atan2(p.z, p.x), r, yy);
      });
      rings.push(out);
      rings.push(out.map((p) => {
        const r = Math.hypot(p.x, p.z);
        return P(Math.atan2(p.z, p.x), r - 0.3, yy - 1.4);
      }));
    }
  }
  // --- foot: flare into a scree skirt on the valley floor ---
  const base = rings[rings.length - 1];
  for (const [dy, dr] of [[-293, 4], [-298, 13], [-300.6, 26]] as const) {
    rings.push(base.map((p, j) => {
      const a = CANG[j];
      const r = Math.hypot(p.x, p.z) + dr * (0.8 + 0.4 * noise2(Math.cos(a) * 3, Math.sin(a) * 3 + dr));
      return P(Math.atan2(p.z, p.x) + (rng() - 0.5) * 0.04, r, dy + (rng() - 0.5) * 0.6);
    }));
  }

  const crng = mulberry32(77);
  const cliffShade: Shade = (c, n) => {
    if (c.y > -0.02 && n.y > 0.97) {
      // plateau top
      const ang = Math.atan2(c.z, c.x);
      const rr = Math.hypot(c.x, c.z) / edgeRadius(ang);
      if (rr > 0.895) return jitter(PALETTE.rimRock, crng, 0.025);
      return jitter(PALETTE.grassLight, crng, 0.025);
    }
    if (c.y > -1.6) return jitter(PALETTE.rimRock, crng, 0.06);
    if (c.y < -290) return n.y > 0.75 ? jitter(PALETTE.valleyGrass, crng, 0.05) : jitter(PALETTE.scree, crng, 0.06);
    if (n.y > 0.6) return jitter(c.y < -6 ? PALETTE.moss : PALETTE.grass, crng, 0.08);
    const ang = Math.atan2(c.z, c.x);
    const band = Math.floor((c.y + 9 * Math.sin(ang * 2 + c.y * 0.01)) / 24);
    const strata = [PALETTE.cliffA, PALETTE.cliffB, PALETTE.cliffC, PALETTE.cliffA, PALETTE.cliffB][((band % 5) + 5) % 5];
    return jitter(strata, crng, 0.06);
  };
  for (let i = 0; i < topRings.length - 1; i++) F.stitch(topRings[i], topRings[i + 1], cliffShade);
  F.rings(upper, cliffShade);
  F.stitch(upper[upper.length - 1], rings[0], cliffShade);
  F.rings(rings, cliffShade);

  // --- outcrops: chunky rocks sticking out of the face (things to rush past in the fall) ---
  const ico = new THREE.IcosahedronGeometry(1, 0);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < 20; i++) {
    const oy = -6 - Math.pow(rng(), 0.8) * 270;
    const a = rng() * Math.PI * 2;
    const s = 1.6 + rng() * 3.5 + -oy * 0.012;
    const r = cliffShape(a, oy) + s * (0.15 + rng() * 0.35);
    e.set(rng() * 0.6, rng() * Math.PI, rng() * 0.6);
    q.setFromEuler(e);
    m4.compose(
      new THREE.Vector3(Math.cos(a) * r, oy, Math.sin(a) * r),
      q,
      new THREE.Vector3(s * (0.8 + rng() * 0.6), s * (1.2 + rng() * 1.6), s * (0.8 + rng() * 0.6)),
    );
    F.geometry(rng() < 0.6 ? ico : box, m4, cliffShade);
  }

  const mesh = new THREE.Mesh(F.build(), vcMat('rock'));
  mesh.name = 'spire';
  return { mesh, ledgeSpots };
}

// small stuff on the plateau rim (no gameplay collision intended — all < 0.5 m)
function buildRimDecor(rng: () => number): THREE.Mesh {
  const F = new Faces();
  const rock = new THREE.DodecahedronGeometry(1, 0);
  const blade = new THREE.ConeGeometry(0.07, 0.42, 3);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const drng = mulberry32(5);
  const rockShade: Shade = (_c, n) => jitter(n.y > 0.7 ? PALETTE.rimRock : PALETTE.rock, drng, 0.07);
  const tuftShade: Shade = () => jitter(drng() < 0.5 ? PALETTE.grassDark : PALETTE.grass, drng, 0.06);

  // pebbles & small rocks hugging the rim
  for (let i = 0; i < 9; i++) {
    const a = rng() * Math.PI * 2;
    const big = i < 5;
    const s = big ? 0.3 + rng() * 0.25 : 0.1 + rng() * 0.14;
    const r = edgeRadius(a) + (big ? 0.15 + rng() * 0.2 : -0.15 - rng() * 0.5);
    e.set(rng() * 3, rng() * 3, rng() * 3);
    q.setFromEuler(e);
    m4.compose(new THREE.Vector3(Math.cos(a) * r, s * 0.25 - (big ? 0.12 : 0), Math.sin(a) * r), q,
      new THREE.Vector3(s * 1.3, s * 0.7, s));
    F.geometry(rock, m4, rockShade);
  }
  // grass tufts
  for (let i = 0; i < 0; i++) {
    const a = rng() * Math.PI * 2;
    const r = edgeRadius(a) * (0.35 + rng() * 0.52);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const n = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      e.set((rng() - 0.5) * 0.7, 0, (rng() - 0.5) * 0.7);
      q.setFromEuler(e);
      const h = 0.7 + rng() * 0.7;
      m4.compose(new THREE.Vector3(cx + (rng() - 0.5) * 0.25, 0.18 * h, cz + (rng() - 0.5) * 0.25), q,
        new THREE.Vector3(1, h, 1));
      F.geometry(blade, m4, tuftShade);
    }
  }
  // a little summit cairn right at the rim
  {
    const a = 2.35;
    const r = edgeRadius(a) - 0.35;
    let yy = 0;
    for (let k = 0; k < 4; k++) {
      const s = 0.26 - k * 0.05;
      e.set(0, rng() * 3, 0);
      q.setFromEuler(e);
      m4.compose(new THREE.Vector3(Math.cos(a) * r, yy + s * 0.45, Math.sin(a) * r), q, new THREE.Vector3(s * 1.2, s * 0.55, s));
      F.geometry(rock, m4, rockShade);
      yy += s * 0.9;
    }
  }
  const mesh = new THREE.Mesh(F.build(), vcMat('rock'));
  mesh.name = 'rimDecor';
  return mesh;
}

// ---------------------------------------------------------------------------
// trees (instanced)
// ---------------------------------------------------------------------------
function pineGeometry(): THREE.BufferGeometry {
  const F = new Faces();
  const trng = mulberry32(9);
  const m4 = new THREE.Matrix4();
  F.geometry(new THREE.CylinderGeometry(0.18, 0.26, 1.6, 5), m4.makeTranslation(0, 0.8, 0), () => tmpCol.set(PALETTE.trunk));
  const leaf = (hex: number): Shade => (_c, n) => jitter(hex, trng, 0.05).multiplyScalar(n.y > 0.3 ? 1.08 : 1);
  F.geometry(new THREE.ConeGeometry(1.6, 2.8, 7), m4.makeTranslation(0, 2.6, 0), leaf(PALETTE.pineDark));
  F.geometry(new THREE.ConeGeometry(1.2, 2.4, 7), m4.makeTranslation(0, 3.8, 0), leaf(PALETTE.pine));
  F.geometry(new THREE.ConeGeometry(0.75, 1.8, 6), m4.makeTranslation(0, 4.9, 0), leaf(PALETTE.pine));
  return F.build();
}

function buildTrees(rng: () => number, ledgeSpots: LedgeSpot[]): THREE.InstancedMesh {
  const spots: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const add = (x: number, y: number, z: number, s: number) => {
    q.setFromAxisAngle(up, rng() * Math.PI * 2);
    spots.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.3 * s, z), q,
      new THREE.Vector3(s * (0.85 + rng() * 0.3), s, s * (0.85 + rng() * 0.3))));
    const k = 0.85 + rng() * 0.3;
    cols.push(new THREE.Color(k, k * (0.95 + rng() * 0.1), k));
  };
  // forests in the valley (clustered by noise), keeping a clear meadow around the spire foot
  let tries = 0;
  while (spots.length < 1100 && tries++ < 20000) {
    const a = rng() * Math.PI * 2;
    const r = 80 + Math.pow(rng(), 0.7) * 1100;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 8) continue;
    const f = fbm(x * 0.012 + 50, z * 0.012, 2);
    if (f < 0.5 - Math.min(0.12, (r - 80) / 2000)) continue;
    add(x, valleyHeight(x, z), z, 2.2 + rng() * 1.8);
  }
  // a few hardy pines on the cliff ledges
  for (const l of ledgeSpots.slice(0, 18)) add(Math.cos(l.a) * l.r, l.y, Math.sin(l.a) * l.r, 0.8 + rng() * 0.7);

  const im = new THREE.InstancedMesh(pineGeometry(), vcMat('tree'), spots.length);
  spots.forEach((m, i) => {
    im.setMatrixAt(i, m);
    im.setColorAt(i, cols[i]);
  });
  im.computeBoundingSphere();
  im.name = 'trees';
  noShadowCast(im);
  return im;
}

// ---------------------------------------------------------------------------
// valley floor
// ---------------------------------------------------------------------------
function buildValley(rng: () => number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'valley';
  const F = new Faces();
  const N = 96;
  const radii = [0];
  let r = 30;
  while (r < 2300) {
    radii.push(r);
    r *= r < 300 ? 1.25 : 1.13;
  }
  const rings = radii.map((rr, i) => {
    const out: THREE.Vector3[] = [];
    for (let j = 0; j < N; j++) {
      const a = (j / N) * Math.PI * 2 + (i > 0 ? (rng() - 0.5) * 0.4 * (Math.PI * 2 / N) : 0);
      const r2 = rr * (i > 0 ? 1 + (rng() - 0.5) * 0.08 : 1);
      const x = Math.cos(a) * r2, z = Math.sin(a) * r2;
      out.push(new THREE.Vector3(x, valleyHeight(x, z), z));
    }
    return out;
  });
  const vrng = mulberry32(31);
  F.rings(rings, (c, n) => {
    if (n.y < 0.82) return jitter(PALETTE.rock, vrng, 0.06);
    const f = fbm(c.x * 0.012 + 50, c.z * 0.012, 2);
    if (f > 0.52) return jitter(PALETTE.valleyDark, vrng, 0.05);
    return jitter(vrng() < 0.5 ? PALETTE.valleyGrass : 0x93c25c, vrng, 0.04);
  });
  const ground = new THREE.Mesh(F.build(), vcMat('ground'));
  ground.name = 'valleyGround';
  noShadowCast(ground);
  g.add(ground);

  // a small lake in the meadow
  const LF = new Faces();
  const lr = LAKE.r;
  const lring = Array.from({ length: 14 }, (_, j) => {
    const a = (j / 14) * Math.PI * 2;
    const rr = lr * (0.75 + 0.45 * noise2(Math.cos(a) * 1.5 + 3, Math.sin(a) * 1.5));
    return new THREE.Vector3(LAKE.x + Math.cos(a) * rr, VALLEY_Y + 0.25, LAKE.z + Math.sin(a) * rr);
  });
  const lc = new THREE.Vector3(LAKE.x, VALLEY_Y + 0.25, LAKE.z);
  LF.rings([lring.map(() => lc), lring], () => tmpCol.set(PALETTE.lake));
  const lake = new THREE.Mesh(LF.build(), vcMat('lake', { roughness: 0.35 }));
  lake.name = 'lake';
  noShadowCast(lake);
  g.add(lake);
  return g;
}

// ---------------------------------------------------------------------------
// background mountains
// ---------------------------------------------------------------------------
function peakRings(rng: () => number, cx: number, cz: number, baseY: number, h: number, rad: number): THREE.Vector3[][] {
  const S = 9 + Math.floor(rng() * 4);
  const K = 7;
  const apex = new THREE.Vector3(cx + (rng() - 0.5) * rad * 0.1, baseY + h, cz + (rng() - 0.5) * rad * 0.1);
  const rings: THREE.Vector3[][] = [Array.from({ length: S }, () => apex)];
  const ridge = Array.from({ length: S }, () => 0.55 + rng() * 0.75);
  const a0 = rng() * Math.PI * 2;
  for (let k = 1; k <= K; k++) {
    const f = k / K; // 0 at apex .. 1 at base
    const y = baseY + h * Math.pow(1 - f, 1.5) + (k < K ? (rng() - 0.5) * h * 0.03 : 0);
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j < S; j++) {
      const a = a0 + (j / S) * Math.PI * 2 + (rng() - 0.5) * 0.35;
      const rr = rad * Math.pow(f, 0.9) * lerp(1, ridge[j], 0.85) * (0.85 + rng() * 0.3);
      ring.push(new THREE.Vector3(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr));
    }
    rings.push(ring);
  }
  return rings;
}

function buildMountains(rng: () => number): THREE.Mesh {
  const F = new Faces();
  const mrng = mulberry32(123);
  const ringsDef = [
    // dist range, count, summit range (y), rock color, snowline
    { d: [560, 820], n: 14, top: [-95, 30], rock: PALETTE.mountainRock, snow: -40 },
    { d: [1000, 1450], n: 18, top: [0, 220], rock: PALETTE.mountainRock, snow: 40 },
    { d: [1800, 2700], n: 22, top: [180, 600], rock: PALETTE.mountainRockFar, snow: 160 },
  ];
  const baseY = VALLEY_Y - 40;
  for (const R of ringsDef) {
    const off = rng() * Math.PI * 2;
    for (let i = 0; i < R.n; i++) {
      const a = off + (i / R.n) * Math.PI * 2 + (rng() - 0.5) * (Math.PI * 2 / R.n) * 0.7;
      const d = lerp(R.d[0], R.d[1], rng());
      const top = lerp(R.top[0], R.top[1], Math.pow(rng(), 0.8));
      const h = top - baseY;
      const rad = h * (1.0 + rng() * 0.6);
      const cx = Math.cos(a) * d, cz = Math.sin(a) * d;
      const snowY = R.snow + (top - R.snow) * 0.15;
      const shade: Shade = (c, n) => {
        const sn = snowY + (noise2(c.x * 0.02, c.z * 0.02) - 0.5) * h * 0.25;
        if (c.y > sn && n.y > 0.28) return jitter(PALETTE.snow, mrng, 0.03);
        if (c.y > sn - h * 0.06 && n.y > 0.55) return jitter(PALETTE.snow, mrng, 0.03);
        return jitter(R.rock, mrng, 0.07);
      };
      F.rings(peakRings(rng, cx, cz, baseY, h, rad), shade);
      // shoulder peaks for a ranged silhouette
      const sh = 1 + Math.floor(rng() * 2);
      for (let s = 0; s < sh; s++) {
        const sa = a + (rng() < 0.5 ? -1 : 1) * (0.04 + rng() * 0.08) * (900 / d);
        const sd = d + (rng() - 0.5) * 120;
        const h2 = h * (0.55 + rng() * 0.3);
        F.rings(peakRings(rng, Math.cos(sa) * sd, Math.sin(sa) * sd, baseY, h2, h2 * (0.8 + rng() * 0.4)), shade);
      }
    }
  }
  const mesh = new THREE.Mesh(F.build(), vcMat('mountain', { roughness: 1 }));
  mesh.name = 'mountains';
  noShadowCast(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// clouds (instanced puffs) — the cloud sea and a few high clouds
// ---------------------------------------------------------------------------
const cloudMat = () =>
  hazed(new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, metalness: 0, emissive: 0x6a6e86 }));

interface Puff { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number; tint: number }

function puffMesh(puffs: Puff[], detail: number, name: string, material: THREE.Material): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, detail), material, puffs.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  const warm = new THREE.Color(0xfff1e4), cool = new THREE.Color(0xe9eefb);
  puffs.forEach((p, i) => {
    q.setFromAxisAngle(up, p.ry);
    m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.sx, p.sy, p.sz));
    im.setMatrixAt(i, m4);
    im.setColorAt(i, c.copy(cool).lerp(warm, p.tint));
  });
  im.computeBoundingSphere();
  im.name = name;
  noShadowCast(im);
  return im;
}

/** A mound of puffs: big in the middle, smaller around, flattened. */
function cluster(out: Puff[], rng: () => number, x: number, y: number, z: number, size: number, n: number) {
  for (let k = 0; k < n; k++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * size * 1.1;
    const fall = 1 - rr / (size * 1.3);
    const s = size * (0.45 + 0.55 * fall) * (0.7 + rng() * 0.5);
    out.push({
      x: x + Math.cos(a) * rr,
      y: y + s * 0.25 * fall + (rng() - 0.5) * size * 0.1,
      z: z + Math.sin(a) * rr,
      sx: s * (1 + rng() * 0.3),
      sy: s * (0.38 + rng() * 0.14),
      sz: s * (1 + rng() * 0.3),
      ry: rng() * Math.PI * 2,
      tint: rng(),
    });
  }
}

function buildClouds(rng: () => number): { sea: THREE.Group; high: THREE.Group } {
  const near: Puff[] = [];
  const far: Puff[] = [];
  // rings of clusters from hugging the spire out to the horizon
  let r = cliffBase(CLOUD_Y) + 10;
  while (r < 3600) {
    const spacing = 14 + r * 0.075;
    const n = Math.max(6, Math.floor((Math.PI * 2 * r) / spacing));
    const off = rng() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.5 * (Math.PI * 2 / n);
      const rr = r + (rng() - 0.5) * spacing * 0.6;
      const size = spacing * (0.95 + rng() * 0.5);
      const y = CLOUD_Y + (fbm(Math.cos(a) * rr * 0.004 + 9, Math.sin(a) * rr * 0.004, 2) - 0.5) * 22;
      cluster(rr < 700 ? near : far, rng, Math.cos(a) * rr, y, Math.sin(a) * rr, size, rr < 700 ? 5 : 3);
    }
    r += spacing * 0.85;
  }
  const material = cloudMat();
  const sea = new THREE.Group();
  sea.name = 'cloudSea';
  sea.add(puffMesh(near, 1, 'cloudsNear', material));
  sea.add(puffMesh(far, 0, 'cloudsFar', material));

  // a soft cloud "floor" just under the puffs so the sea never shows holes
  const F = new Faces();
  const fr = mulberry32(99);
  const radii = [60, 90, 130, 190, 270, 380, 520, 720, 1000, 1400, 1900, 2600, 3600, 4400];
  const N = 72;
  const rings = radii.map((rr) => Array.from({ length: N }, (_, j) => {
    const a = (j / N) * Math.PI * 2 + (fr() - 0.5) * 0.03;
    return new THREE.Vector3(Math.cos(a) * rr, CLOUD_Y - 9 + (fr() - 0.5) * 6, Math.sin(a) * rr);
  }));
  // ring order is center→out, so faces point up (top of the sea); render both sides (seen from below too)
  F.rings(rings, () => jitter(0xf2f2fa, fr, 0.03));
  const floor = new THREE.Mesh(F.build(), vcMat('cloudFloor', { side: THREE.DoubleSide, emissive: 0x6a6e86, roughness: 1 }));
  floor.name = 'cloudFloor';
  noShadowCast(floor);
  sea.add(floor);

  // higher clouds at/above plateau level for depth
  const hi: Puff[] = [];
  const spots: [number, number, number, number][] = [
    // angle, dist, y, size
    [0.6, 140, -28, 14],
    [2.2, 210, 14, 18],
    [3.5, 110, -48, 10],
    [4.4, 300, 40, 26],
    [5.4, 180, -12, 15],
    [1.4, 420, 70, 34],
    [2.9, 520, 95, 40],
    [5.0, 650, 120, 50],
    [0.2, 760, 60, 46],
    [3.9, 900, 150, 60],
  ];
  for (const [a, d, y, s] of spots) {
    cluster(hi, rng, Math.cos(a) * d, y, Math.sin(a) * d, s, 6 + Math.floor(rng() * 4));
  }
  const high = new THREE.Group();
  high.name = 'cloudsHigh';
  high.add(puffMesh(hi, 1, 'cloudsHighPuffs', material));
  return { sea, high };
}

// ---------------------------------------------------------------------------
const def: ModelDef = {
  name: 'world',
  viewDistance: 14,
  build() {
    const rng = mulberry32(20240611);
    const root = new THREE.Group();
    root.name = 'world';
    root.add(buildSky());
    const { mesh: spire, ledgeSpots } = buildSpire(rng);
    root.add(spire);
    root.add(buildRimDecor(rng));
    root.add(buildValley(rng));
    root.add(buildTrees(rng, ledgeSpots));
    root.add(buildMountains(rng));
    const { sea, high } = buildClouds(rng);
    root.add(sea, high);
    return root;
  },
  poses: {
    idle(root, t) {
      const sea = root.getObjectByName('cloudSea');
      const high = root.getObjectByName('cloudsHigh');
      if (sea) {
        sea.rotation.y = t * 0.0025;
        sea.position.y = Math.sin(t * 0.25) * 0.8;
      }
      if (high) high.rotation.y = t * 0.012;
    },
  },
};
export default def;

