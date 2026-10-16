import * as THREE from 'three';
import type { ModelDef } from './types';
import { PALETTE, SUN_DIR } from '../style';

// ============================================================================
// RAMPAGE PEAK — the environment.
//
// The arena is the rocky summit (y = 0) of a ~300 m horn-shaped peak that rises out of
// a sea of clouds (y = CLOUD_Y, with holes showing the valley floor at y = VALLEY_Y),
// a huge snowy hero peak toward +Z, rings of mountains out to ~2.9 km, and a
// gradient sky dome with a sun disk.
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
// summit mountain shape (exported for gameplay & the fall cinematic)
// ---------------------------------------------------------------------------
// The plateau is the summit of a horn-shaped peak: four uneven ridges (buttresses) that
// spread wide toward the base, and steep faces between them. The faces are the "fall lanes":
// right under the rim they drop almost vertically, so a body that leaves the rim falls clear.

const RIDGES = [
  { a: 0.35, s: 1.05, w: 0.36 },
  { a: 2.05, s: 0.8, w: 0.3 },
  { a: 3.45, s: 1.25, w: 0.42 },
  { a: 4.95, s: 0.75, w: 0.32 },
];
const FACE_SLOPE = 0.3;
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** 0 on the faces .. ~1.2 on a ridge crest. */
function ridgeW(a: number): number {
  let s = 0;
  for (const r of RIDGES) {
    const d = angDiff(a, r.a) / r.w;
    s = Math.max(s, r.s * Math.exp(-d * d));
  }
  return s;
}
const slopeAt = (a: number) => FACE_SLOPE + ridgeW(a);
/** Horizontal spread vs depth: ~0 right under the rim, growing fast lower down. */
const spread = (d: number) => (d * d) / (d + 70);

/** Smooth mountain surface radius at (angle, y), y <= 0 (before crags/jitter). */
function mountainShape(a: number, y: number): number {
  const d = Math.max(0, -y);
  const top = edgeRadius(a) + lerp(0.5, -0.4, smooth(1, 8, d)); // lip, then a slight undercut
  const n = fbm(Math.cos(a) * 1.7 + 7.3 + d * 0.008, Math.sin(a) * 1.7 - 3.1 + d * 0.005, 3) - 0.5;
  return top + (FACE_SLOPE * spread(d) + (0.12 + ridgeW(a) * 0.5) * d * smooth(0, 5, d)) * (1 + 0.35 * n) + 4 * n * smooth(6, 40, d);
}

/**
 * Conservative radius of the mountain (incl. crags) at angle = atan2(z, x) and height y.
 * A falling body farther than this from the axis (at that angle) is clear of the rock.
 */
export function cliffRadiusAt(angle: number, y: number): number {
  if (y > 0) return 0;
  const d = -y;
  return mountainShape(angle, y) + (d < 6 ? 0.8 : 2.5 + d * 0.02);
}

/**
 * With an angle: same as cliffRadiusAt(angle, y). Without: the max over all angles
 * (ridges included — very wide low down, ~285 m at the foot).
 */
export function cliffRadius(y: number, angle?: number): number {
  if (angle !== undefined) return cliffRadiusAt(angle, y);
  let m = 0;
  for (let i = 0; i < 72; i++) m = Math.max(m, cliffRadiusAt((i / 72) * Math.PI * 2, y));
  return m;
}

/** Angles (atan2(z, x)) of the four steep faces between ridges — the cleanest lines for a fall. */
export const FALL_LANES: number[] = RIDGES.map((r, i) => {
  const n = RIDGES[(i + 1) % RIDGES.length];
  let b = n.a;
  if (b < r.a) b += Math.PI * 2;
  let best = r.a, bs = Infinity;
  for (let k = 1; k < 40; k++) {
    const a = r.a + ((b - r.a) * k) / 40;
    const s = slopeAt(a);
    if (s < bs) { bs = s; best = a; }
  }
  return Math.atan2(Math.sin(best), Math.cos(best));
});

const FLAT_R = 420; // valley floor is exactly VALLEY_Y inside this radius

/** Valley ground height at (x, z). Flat (= VALLEY_Y) around the mountain foot, rolling hills farther out. */
export function valleyHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const hills = (fbm(x * 0.005 + 11, z * 0.005 - 4, 3) - 0.35) * 80 + Math.pow(Math.max(0, r - FLAT_R) / 900, 2) * 260;
  return VALLEY_Y + Math.min(120, Math.max(0, hills)) * smooth(FLAT_R, FLAT_R + 300, r);
}

/** Main fall lane: the sunlit face (the landing meadow and a cloud hole sit below it). */
const SUN_AZ = Math.atan2(SUN_DIR.z, SUN_DIR.x);
export const MAIN_FALL_LANE = FALL_LANES.reduce((b, a) => (Math.abs(angDiff(a, SUN_AZ)) < Math.abs(angDiff(b, SUN_AZ)) ? a : b));
const LANE = MAIN_FALL_LANE;
const footR = (a: number) => mountainShape(a, VALLEY_Y);
/** A good BOOM landing point: open meadow at the foot of the main fall lane, visible through a cloud hole. */
export const LANDING_SPOT = new THREE.Vector3(
  Math.cos(LANE) * (footR(LANE) + 45),
  VALLEY_Y,
  Math.sin(LANE) * (footR(LANE) + 45),
);

/** Holes in the cloud sea (x, z, radius) — you can see the valley through them. */
export const CLOUD_HOLES: { x: number; z: number; r: number }[] = [
  // right next to the mountain, over the landing meadow (the fall lane passes through it)
  { x: Math.cos(LANE) * (mountainShape(LANE, CLOUD_Y) + 75), z: Math.sin(LANE) * (mountainShape(LANE, CLOUD_Y) + 75), r: 85 },
  // in the gameplay view, behind the ram, in front of the hero mountain
  { x: Math.cos(1.5) * 780, z: Math.sin(1.5) * 780, r: 270 },
  { x: Math.cos(0.4) * 580, z: Math.sin(0.4) * 580, r: 160 },
  { x: Math.cos(2.75) * 820, z: Math.sin(2.75) * 820, r: 210 },
  { x: Math.cos(4.1) * 500, z: Math.sin(4.1) * 500, r: 140 },
  { x: Math.cos(5.4) * 1200, z: Math.sin(5.4) * 1200, r: 300 },
  { x: Math.cos(2.05) * 1600, z: Math.sin(2.05) * 1600, r: 280 },
];
const inHole = (x: number, z: number, pad = 0) => CLOUD_HOLES.some((h) => Math.hypot(x - h.x, z - h.z) < h.r + pad);

const LAKE = { x: Math.cos(LANE - 0.5) * 360, z: Math.sin(LANE - 0.5) * 360, r: 38 };

/** Hero mountain: huge, snowy, toward +Z (behind the ram in the default gameplay view), lit by the sun. */
const HERO = { a: 1.68, d: 1450, top: 820 };

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

const HAZE_DENSITY = 0.0003;
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
  /** Optional face filter (by centroid). */
  keep: ((c: THREE.Vector3) => boolean) | null = null;
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
    if (this.keep && !this.keep(this.c)) return;
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
// summit + mountain
// ---------------------------------------------------------------------------
const SEG = 64;
const ANG = Array.from({ length: SEG }, (_, j) => (j / SEG) * Math.PI * 2);
const CSEG = 56;
const CANG = Array.from({ length: CSEG }, (_, j) => (j / CSEG) * Math.PI * 2);
const P = (a: number, r: number, y: number) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);

/** Gentle visual undulation of the summit top (|y| <= 0.08, 0 at the rim). */
function summitHeight(x: number, z: number): number {
  const rr = Math.hypot(x, z) / edgeRadius(Math.atan2(z, x));
  return 0.08 * (fbm(x * 0.13 + 5, z * 0.13 + 1, 2) * 2 - 1) * (1 - smooth(0.75, 1, rr));
}
/** Where the lip beyond the rim is raised into a little rocky crest (0..0.35 m). */
const lipRaise = (a: number) => Math.min(0.35, Math.max(0, (noise2(Math.cos(a) * 2.6 + 3, Math.sin(a) * 2.6 + 1) - 0.52) * 1.4));

interface Spot { x: number; y: number; z: number }

function buildMountain(rng: () => number): { mesh: THREE.Mesh; slopeSpots: Spot[] } {
  const F = new Faces();
  const crng = mulberry32(77);

  // --- summit top: big calm facets; color comes from the meadow patches laid on top ---
  const topRings: THREE.Vector3[][] = [[new THREE.Vector3(0, summitHeight(0, 0), 0)]];
  for (const [f, n] of [[0.3, 8], [0.58, 14], [0.8, 22], [0.93, 36]] as const) {
    const a0 = rng() * 0.3;
    topRings.push(Array.from({ length: n }, (_, k) => {
      const a = a0 + ((k + (rng() - 0.5) * 0.35) / n) * Math.PI * 2;
      const p = P(a, edgeRadius(a) * f * (1 + (rng() - 0.5) * 0.05), 0);
      p.y = summitHeight(p.x, p.z);
      return p;
    }));
  }
  const rim = ANG.map((a) => P(a, edgeRadius(a), 0)); // the walkable edge
  topRings.push(rim);

  // --- lip: a broken rocky crest in places, then the drop ---
  const upper: THREE.Vector3[][] = [rim];
  upper.push(ANG.map((a) => { const h = lipRaise(a); return P(a, edgeRadius(a) + 0.3 + rng() * 0.12, h > 0 ? h + rng() * 0.08 : -0.2 - rng() * 0.1); }));
  upper.push(ANG.map((a) => P(a, edgeRadius(a) + 0.5 + rng() * 0.2, lipRaise(a) * 0.5 - 0.9 - rng() * 0.4)));

  // --- mountain body ---
  const depths = [2.6, 5, 9, 14, 20, 28, 38, 50, 64, 80, 98, 118, 140, 165, 192, 222, 255, 285];
  const rings: THREE.Vector3[][] = [];
  depths.forEach((d, i) => {
    const step = (depths[i + 1] ?? 300) - d;
    rings.push(CANG.map((a) => {
      const aj = a + (rng() - 0.5) * 0.4 * (Math.PI * 2 / CSEG);
      const dj = d + (d > 8 ? (rng() - 0.5) * Math.min(step * 0.5, 10) : (rng() - 0.5) * 0.6);
      return P(aj, mountainShape(aj, -dj) + (rng() - 0.5) * (0.5 + dj * 0.04), -dj);
    }));
  });
  rings.push(CANG.map((a) => P(a, mountainShape(a, VALLEY_Y), VALLEY_Y + 0.2)));
  rings.push(CANG.map((a) => P(a, mountainShape(a, VALLEY_Y) + 14 + rng() * 8, VALLEY_Y - 1.5)));

  const summitShade: Shade = (c) => jitter(fbm(c.x * 0.3 + 2, c.z * 0.3, 2) > 0.55 ? PALETTE.rimRock : PALETTE.summitRock, crng, 0.04);
  const mountainShade: Shade = (c, n) => {
    if (c.y > -1.3) return jitter(PALETTE.rimRock, crng, 0.05);
    if (n.y > 0.5) {
      if (c.y < CLOUD_Y - 15) return jitter(n.y > 0.75 ? PALETTE.valleyGrass : PALETTE.moss, crng, 0.06);
      if (c.y < -18 && noise2(c.x * 0.08, c.z * 0.08 + c.y * 0.03) > 0.45) return jitter(PALETTE.snow, crng, 0.025);
      return jitter(PALETTE.moss, crng, 0.06);
    }
    const ang = Math.atan2(c.z, c.x);
    const t = fbm(Math.cos(ang) * 2 + 4 + c.y * 0.004, Math.sin(ang) * 2 + c.y * 0.009, 2);
    const base = t < 0.42 ? PALETTE.cliffB : t < 0.6 ? PALETTE.cliffA : PALETTE.cliffC;
    return jitter(base, crng, 0.05);
  };
  for (let i = 0; i < topRings.length - 1; i++) F.stitch(topRings[i], topRings[i + 1], summitShade);
  F.rings(upper, mountainShade);
  F.stitch(upper[upper.length - 1], rings[0], mountainShade);
  F.rings(rings, mountainShade);

  // --- crags along the ridges (big angular buttress blocks) ---
  const ico = new THREE.IcosahedronGeometry(1, 0);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const cragShade: Shade = () => jitter(crng() < 0.5 ? PALETTE.cliffB : PALETTE.cliffA, crng, 0.05);
  for (let i = 0; i < 12; i++) {
    const R = RIDGES[i % RIDGES.length];
    const d = 18 + Math.pow(rng(), 0.9) * 110;
    const a = R.a + (rng() - 0.5) * R.w * 0.5;
    const s = 3 + d * 0.05 + rng() * 3;
    const r = mountainShape(a, -d) - s * 0.35;
    e.set((rng() - 0.5) * 0.5, a, (rng() - 0.5) * 0.5);
    q.setFromEuler(e);
    m4.compose(P(a, r, -d + s * 0.3), q, new THREE.Vector3(s * (0.8 + rng() * 0.5), s * (1.4 + rng() * 1.2), s * (0.7 + rng() * 0.5)));
    F.geometry(ico, m4, cragShade);
  }

  // spots for pines on the gentle lower ridges (below the clouds)
  const slopeSpots: Spot[] = [];
  for (let i = 0; i < 2000 && slopeSpots.length < 260; i++) {
    const a = rng() * Math.PI * 2;
    if (ridgeW(a) < 0.35) continue;
    const d = 150 + rng() * 145;
    const r = mountainShape(a, -d) - 1.5;
    if (fbm(Math.cos(a) * 6, Math.sin(a) * 6 + d * 0.02, 2) < 0.45) continue;
    slopeSpots.push({ x: Math.cos(a) * r, y: -d, z: Math.sin(a) * r });
  }

  const mesh = new THREE.Mesh(F.build(), vcMat('rock'));
  mesh.name = 'mountain';
  return { mesh, slopeSpots };
}

// alpine-meadow patches on the summit + rim boulders (no gameplay collision intended)
function buildSummitDetail(rng: () => number): THREE.Mesh {
  const F = new Faces();
  const drng = mulberry32(5);

  // meadow patches: organic blobs a few cm above the rock, kept away from the rim
  const patches: [number, number, number, number][] = [
    // x, z, radius, color
    [-1.6, 1.2, 4.3, PALETTE.grassLight],
    [2.6, -1.4, 3.6, PALETTE.grassLight],
    [1.4, 4.4, 2.4, PALETTE.grass],
    [-4.4, -3.6, 2.1, PALETTE.grass],
    [5.4, 3.0, 1.5, PALETTE.grass],
    [-1.0, -5.2, 1.4, PALETTE.grassLight],
    [-6.2, 2.4, 1.1, PALETTE.grass],
  ];
  patches.forEach(([px, pz, pr, col], i) => {
    const n = 18;
    const ph = rng() * 10;
    const lift = 0.045 + i * 0.006;
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (rng() - 0.5) * 0.25;
      let r = pr * (0.62 + 0.6 * fbm(Math.cos(a) * 1.3 + ph, Math.sin(a) * 1.3 + ph, 2) + (rng() - 0.5) * 0.08);
      // never closer than 0.9 m to the rim
      const x0 = px + Math.cos(a) * r, z0 = pz + Math.sin(a) * r;
      const lim = edgeRadius(Math.atan2(z0, x0)) - 0.9;
      const rr = Math.hypot(x0, z0);
      if (rr > lim) r *= Math.max(0.2, 1 - (rr - lim) / r);
      const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
      ring.push(new THREE.Vector3(x, summitHeight(x, z) + lift, z));
    }
    const c = new THREE.Vector3(px, summitHeight(px, pz) + lift, pz);
    F.rings([ring.map(() => c), ring], () => jitter(col, drng, 0.03));
  });

  const rock = new THREE.DodecahedronGeometry(1, 0);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const rockShade: Shade = (_c, n) => jitter(n.y > 0.6 ? PALETTE.rimRock : PALETTE.rock, drng, 0.06);
  const place = (a: number, r: number, s: number, sy: number, sink: number) => {
    e.set(rng() * 0.5, rng() * 3, rng() * 0.5);
    q.setFromEuler(e);
    m4.compose(P(a, r, s * sy * 0.5 - sink), q, new THREE.Vector3(s * (1 + rng() * 0.4), s * sy, s * (0.8 + rng() * 0.3)));
    F.geometry(rock, m4, rockShade);
  };
  // boulders sitting on the lip, just beyond the walkable edge
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rng() * 0.5;
    if (Math.abs(angDiff(a, LANE)) < 0.35) continue; // keep the main fall lane clean
    place(a, edgeRadius(a) + 0.55 + rng() * 0.35, 0.45 + rng() * 0.45, 0.75, 0.25);
  }
  // a few small stones just inside the rim
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2;
    place(a, edgeRadius(a) - 0.3 - rng() * 0.6, 0.12 + rng() * 0.1, 0.6, 0.03);
  }
  // little summit cairn at the rim
  {
    const a = 2.35;
    const r = edgeRadius(a) - 0.4;
    let yy = 0;
    for (let k = 0; k < 4; k++) {
      const s = 0.26 - k * 0.05;
      e.set(0, rng() * 3, 0);
      q.setFromEuler(e);
      m4.compose(P(a, r, yy + s * 0.45), q, new THREE.Vector3(s * 1.2, s * 0.55, s));
      F.geometry(rock, m4, rockShade);
      yy += s * 0.9;
    }
  }
  const mesh = new THREE.Mesh(F.build(), vcMat('rock'));
  mesh.name = 'summitDetail';
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

function buildTrees(rng: () => number, slopeSpots: Spot[]): THREE.InstancedMesh {
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
  // forests in the valley (clustered by noise), keeping the meadow at the mountain foot open
  let tries = 0;
  while (spots.length < 1300 && tries++ < 30000) {
    const a = rng() * Math.PI * 2;
    const r = 60 + Math.pow(rng(), 0.7) * 1300;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (r < footR(a) + 25) continue;
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 8) continue;
    if (Math.hypot(x - LANDING_SPOT.x, z - LANDING_SPOT.z) < 55) continue;
    const f = fbm(x * 0.011 + 50, z * 0.011, 2);
    if (f < 0.48) continue;
    add(x, valleyHeight(x, z), z, 2.4 + rng() * 2);
  }
  for (const s of slopeSpots) add(s.x, s.y, s.z, 2.2 + rng() * 1.6);

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
  let r = 40;
  while (r < 2400) {
    radii.push(r);
    r *= r < 400 ? 1.22 : 1.12;
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
    if (n.y < 0.82) return jitter(PALETTE.rock, vrng, 0.05);
    const f = fbm(c.x * 0.011 + 50, c.z * 0.011, 2);
    if (f > 0.5) return jitter(PALETTE.valleyDark, vrng, 0.03);
    return jitter(PALETTE.valleyGrass, vrng, 0.03);
  });
  const ground = new THREE.Mesh(F.build(), vcMat('ground'));
  ground.name = 'valleyGround';
  noShadowCast(ground);
  g.add(ground);

  // a small lake in the meadow
  const LF = new Faces();
  const lring = Array.from({ length: 14 }, (_, j) => {
    const a = (j / 14) * Math.PI * 2;
    const rr = LAKE.r * (0.75 + 0.45 * noise2(Math.cos(a) * 1.5 + 3, Math.sin(a) * 1.5));
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
// background mountains (+ the hero peak)
// ---------------------------------------------------------------------------
function peakRings(
  rng: () => number, cx: number, cz: number, baseY: number, h: number, rad: number,
  S = 9 + Math.floor(rng() * 4), K = 7, ridgeAmt = 0.85,
): THREE.Vector3[][] {
  const apex = new THREE.Vector3(cx + (rng() - 0.5) * rad * 0.3, baseY + h, cz + (rng() - 0.5) * rad * 0.3);
  const rings: THREE.Vector3[][] = [Array.from({ length: S }, () => apex)];
  const ridge = Array.from({ length: S }, () => 0.5 + rng() * 0.8);
  const a0 = rng() * Math.PI * 2;
  for (let k = 1; k <= K; k++) {
    const f = k / K; // 0 at apex .. 1 at base
    const y = baseY + h * Math.pow(1 - f, 1.5) + (k < K ? (rng() - 0.5) * h * 0.03 : 0);
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j < S; j++) {
      const a = a0 + (j / S) * Math.PI * 2 + (rng() - 0.5) * 0.3;
      const rr = rad * Math.pow(f, 0.9) * lerp(1, ridge[j], ridgeAmt) * (0.75 + rng() * 0.5);
      ring.push(new THREE.Vector3(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr));
    }
    rings.push(ring);
  }
  return rings;
}

function buildMountains(rng: () => number): THREE.Mesh {
  const F = new Faces();
  const mrng = mulberry32(123);
  const baseY = VALLEY_Y - 40;
  const snowShade = (snowY: number, h: number, rock: number): Shade => (c, n) => {
    const sn = snowY + (noise2(c.x * 0.02, c.z * 0.02) - 0.5) * h * 0.22;
    if (c.y > sn && n.y > 0.22) return jitter(PALETTE.snow, mrng, 0.03);
    if (c.y > sn - h * 0.08 && n.y > 0.55) return jitter(PALETTE.snow, mrng, 0.03);
    return jitter(rock, mrng, 0.06);
  };

  // the hero peak: towering, snowy, broad
  {
    const cx = Math.cos(HERO.a) * HERO.d, cz = Math.sin(HERO.a) * HERO.d;
    const h = HERO.top - baseY;
    const shade = snowShade(HERO.top - h * 0.42, h, PALETTE.mountainRock);
    F.rings(peakRings(rng, cx, cz, baseY, h, h * 0.62, 16, 11, 0.9), shade);
    // shoulders and a sub-summit for a ranged, asymmetric silhouette
    const sh: [number, number, number][] = [[-0.16, 120, 0.68], [0.13, -60, 0.55], [0.26, 160, 0.42], [-0.3, 220, 0.38]];
    for (const [da, dd, k] of sh) {
      const a = HERO.a + da, d = HERO.d + dd;
      F.rings(peakRings(rng, Math.cos(a) * d, Math.sin(a) * d, baseY, h * k, h * k * 0.75, 12, 8), shade);
    }
  }

  const ringsDef = [
    // dist range, count, summit range (y), rock color
    { d: [650, 950], n: 13, top: [-40, 150], rock: PALETTE.mountainRock },
    { d: [1150, 1700], n: 17, top: [80, 380], rock: PALETTE.mountainRock },
    { d: [2100, 2900], n: 22, top: [250, 700], rock: PALETTE.mountainRockFar },
  ];
  for (const R of ringsDef) {
    const off = rng() * Math.PI * 2;
    for (let i = 0; i < R.n; i++) {
      const a = off + (i / R.n) * Math.PI * 2 + (rng() - 0.5) * (Math.PI * 2 / R.n) * 0.7;
      const d = lerp(R.d[0], R.d[1], rng());
      const top = lerp(R.top[0], R.top[1], Math.pow(rng(), 0.8));
      if (R.d[0] < 2000 && Math.abs(angDiff(a, HERO.a)) < 0.4) continue; // keep the hero peak clear
      const h = top - baseY;
      const rad = h * (0.75 + Math.pow(rng(), 2) * 0.9);
      const cx = Math.cos(a) * d, cz = Math.sin(a) * d;
      const shade = snowShade(top - h * 0.3, h, R.rock);
      F.rings(peakRings(rng, cx, cz, baseY, h, rad), shade);
      const nsh = 1 + Math.floor(rng() * 2);
      for (let s = 0; s < nsh; s++) {
        const sa = a + (rng() < 0.5 ? -1 : 1) * (0.04 + rng() * 0.08) * (900 / d);
        const sd = d + (rng() - 0.5) * 120;
        const h2 = h * (0.5 + rng() * 0.3);
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
// clouds (instanced puffs) — the cloud sea with holes, and a few high clouds
// ---------------------------------------------------------------------------
const cloudMat = () =>
  hazed(new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: false, roughness: 1, metalness: 0, emissive: 0x6a6e86 }));

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

/** A mound of puffs: big in the middle, smaller around, flattened. Puffs never poke into a hole. */
function cluster(out: Puff[], rng: () => number, x: number, y: number, z: number, size: number, n: number) {
  for (let k = 0; k < n; k++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * size * 1.1;
    const fall = 1 - rr / (size * 1.3);
    const s = size * (0.45 + 0.55 * fall) * (0.7 + rng() * 0.5);
    const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
    if (inHole(px, pz, s * 1.15)) continue;
    out.push({
      x: px,
      y: y + s * 0.25 * fall + (rng() - 0.5) * size * 0.1,
      z: pz,
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
  const seaY = (x: number, z: number) => CLOUD_Y + (fbm(x * 0.004 + 9, z * 0.004, 2) - 0.5) * 22;
  const put = (x: number, z: number, size: number, r: number) => {
    const a = Math.atan2(z, x);
    if (r < mountainShape(a, CLOUD_Y) + size * 0.4) return; // don't bury the mountain
    cluster(r < 420 ? near : far, rng, x, seaY(x, z), z, size, r < 420 ? 5 : 2);
  };
  // rings of clusters from hugging the mountain out to the horizon
  let r = 24;
  while (r < 3600) {
    const spacing = r < 420 ? 20 + r * 0.08 : r * 0.13;
    const n = Math.max(6, Math.floor((Math.PI * 2 * r) / spacing));
    const off = rng() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.5 * (Math.PI * 2 / n);
      const rr = r + (rng() - 0.5) * spacing * 0.6;
      put(Math.cos(a) * rr, Math.sin(a) * rr, spacing * (0.95 + rng() * 0.5), rr);
    }
    r += spacing * 0.85;
  }
  // soft walls around each hole (bigger, puffier banks)
  for (const h of CLOUD_HOLES) {
    const size = Math.min(70, Math.max(18, h.r * 0.3));
    const n = Math.max(8, Math.floor((Math.PI * 2 * h.r) / (size * 1.1)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.2;
      const rr = h.r + size * (1.2 + rng() * 0.3);
      const x = h.x + Math.cos(a) * rr, z = h.z + Math.sin(a) * rr;
      put(x, z, size * (0.9 + rng() * 0.4), Math.hypot(x, z));
    }
  }
  const material = cloudMat();
  const sea = new THREE.Group();
  sea.name = 'cloudSea';
  sea.add(puffMesh(near, 1, 'cloudsNear', material));
  sea.add(puffMesh(far, 1, 'cloudsFar', material));

  // a flat cloud "floor" under the puffs so the sea has no accidental gaps (cut at the holes)
  const F = new Faces();
  const fr = mulberry32(99);
  const radii: number[] = [];
  for (let rr = 30; rr < 4400; rr *= 1.07) radii.push(rr);
  const N = 150;
  const rings = radii.map((rr) => Array.from({ length: N }, (_, j) => {
    const a = (j / N) * Math.PI * 2 + (fr() - 0.5) * 0.01;
    return new THREE.Vector3(Math.cos(a) * rr, CLOUD_Y - 8, Math.sin(a) * rr);
  }));
  F.keep = (c) => !inHole(c.x, c.z, 4) && Math.hypot(c.x, c.z) > mountainShape(Math.atan2(c.z, c.x), CLOUD_Y - 8) - 2;
  F.rings(rings, () => jitter(0xf2f2fa, fr, 0.02));
  const floor = new THREE.Mesh(F.build(), vcMat('cloudFloor', { side: THREE.DoubleSide, emissive: 0x9a9eb4, roughness: 1 }));
  floor.name = 'cloudFloor';
  noShadowCast(floor);
  sea.add(floor);

  // higher clouds at/above plateau level for depth
  const hi: Puff[] = [];
  const spots: [number, number, number, number][] = [
    // angle, dist, y, size
    [0.6, 140, -28, 14],
    [2.4, 210, 14, 18],
    [3.5, 110, -48, 10],
    [4.4, 300, 40, 26],
    [5.4, 180, -12, 15],
    [0.9, 420, 70, 34],
    [2.9, 520, 95, 40],
    [5.0, 650, 120, 50],
    [0.2, 760, 60, 46],
    [3.9, 900, 150, 60],
    [1.95, 1050, 260, 70], // drifting across the hero peak
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
    const { mesh: mountain, slopeSpots } = buildMountain(rng);
    root.add(mountain);
    root.add(buildSummitDetail(rng));
    root.add(buildValley(rng));
    root.add(buildTrees(rng, slopeSpots));
    root.add(buildMountains(rng));
    const { sea, high } = buildClouds(rng);
    root.add(sea, high);
    return root;
  },
  poses: {
    idle(root, t) {
      // the sea only breathes (holes stay put over the valley); the high clouds drift
      const sea = root.getObjectByName('cloudSea');
      const high = root.getObjectByName('cloudsHigh');
      if (sea) sea.position.y = Math.sin(t * 0.25) * 0.8;
      if (high) high.rotation.y = t * 0.012;
    },
  },
};
export default def;
