/**
 * Small deterministic math helpers. No Math.random() anywhere in the engine — every stochastic
 * value is a stable hash of something structural (lattice coords, event id), so re-scans refresh
 * in place and `?autotest` is reproducible (visual-brief §2, engine-plan §10).
 */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential approach. `rate` is "how fast", in 1/s. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  b + (a - b) * Math.exp(-rate * dt);

/** Quadratic falloff to exactly zero at radius R (engine-plan §3 paint step 3). */
export const falloff = (dist: number, radius: number): number => {
  if (radius <= 0) return 0;
  const t = dist / radius;
  if (t >= 1) return 0;
  return 1 - t * t;
};

/** 32-bit integer hash (finalizer of murmur3). Stable across platforms. */
export function hash3i(x: number, y: number, z: number): number {
  let h = (x | 0) * 0x8da6b343 + (y | 0) * 0xd8163841 + (z | 0) * 0xcb1ab31f;
  h = h ^ (h >>> 15);
  h = Math.imul(h, 0x2c1b3c6d);
  h = h ^ (h >>> 12);
  h = Math.imul(h, 0x297a2d39);
  h = h ^ (h >>> 15);
  return h >>> 0;
}

/** Stable [0,1) dither value for a lattice cell. Same cell => same value, always. */
export const dither3i = (x: number, y: number, z: number): number => hash3i(x, y, z) / 4294967296;

/** Stable [0,1) value from a single integer (used for per-event fuzz seeds). */
export function hash1(n: number): number {
  let h = (n | 0) * 0x9e3779b1;
  h = h ^ (h >>> 16);
  h = Math.imul(h, 0x85ebca6b);
  h = h ^ (h >>> 13);
  h = Math.imul(h, 0xc2b2ae35);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Deterministic 32-bit PRNG (mulberry32) — used only where a stream of values is needed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** World coordinate of lattice cell centre `i` along one axis. */
export const latticeCentre = (i: number, spacing: number): number => (i + 0.5) * spacing;
/** Lattice cell index containing world coordinate `w`. */
export const latticeIndex = (w: number, spacing: number): number => Math.floor(w / spacing);
/** Lattice index of the first cell centre >= `w`. */
export const latticeFirstAtOrAfter = (w: number, spacing: number): number =>
  Math.ceil(w / spacing - 0.5);

/**
 * Yaw convention (engine-wide): yaw 0 looks along +x and yaw increases toward +z.
 * The sample map's spawn ("facing +x") is therefore yaw 0.
 */
export const yawToForward = (yaw: number): [number, number, number] => [Math.cos(yaw), 0, Math.sin(yaw)];

/**
 * Three.js Object3D.rotation.y that makes a default camera (looking down local -z) face our
 * yaw. Derived once here so the movement/camera code never re-derives it.
 */
export const yawToThreeRotationY = (yaw: number): number => -yaw - Math.PI / 2;

/** Signed angle helper: shortest difference between two yaw angles, in (-pi, pi]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Cone membership for the E-ping. `angleDeg` is the FULL cone angle (engine-plan §3 step 1
 * resolves the ambiguity: 25 deg cone means +-12.5 deg around the aim direction).
 */
export function inCone(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  px: number,
  py: number,
  pz: number,
  angleDeg: number,
): boolean {
  const vx = px - ox;
  const vy = py - oy;
  const vz = pz - oz;
  const len = Math.hypot(vx, vy, vz);
  if (len < 1e-6) return true;
  const c = (vx * dx + vy * dy + vz * dz) / len;
  return c >= Math.cos((angleDeg * 0.5 * Math.PI) / 180);
}

/** Signal quality delivered to the listener (engine-plan §4). */
export function eventQuality(dist: number, hearRadius: number, walls: number, hearingBase: number, wall1Quality: number): number {
  if (walls >= 2) return 0;
  const range = Math.max(hearRadius, hearingBase);
  const q = clamp01(1 - dist / range);
  return q * (walls === 0 ? 1 : wall1Quality);
}
