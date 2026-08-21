// Minimal vector math shared by client & server (no three.js on the server).

export type Vec3 = { x: number; y: number; z: number };

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const dist2D = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

export function norm(a: Vec3): Vec3 {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number) => clamp(x, 0, 1);

/** Yaw/pitch (radians) -> unit direction. yaw 0 looks down -Z, matching three.js camera default. */
export function dirFromAngles(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Deterministic PRNG so client and server can agree on "random" scatter. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
