/**
 * Vector helpers and the deterministic noise source.
 *
 * Two rules hold everywhere below the `sim/` roof:
 *   - no `Math.random()`, ever — every random number comes from a seeded stream;
 *   - no transcendentals in anything the physics depends on. `Math.sin`, `Math.cos`, `Math.exp`
 *     and friends are implementation-defined in ECMAScript: two engines may return values that
 *     differ in the last bit, and one last bit is enough to make two runs of the same match
 *     diverge. Everything here is +, -, *, / and `Math.sqrt`, all of which IEEE-754 pins down
 *     exactly. Trigonometry is allowed in renderers and in controller heuristics; it is banned
 *     in the simulation and in perception.
 */
import type { Vec2 } from './types';

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const clone2 = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
export const add2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale2 = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len2 = (a: Vec2): number => Math.sqrt(a.x * a.x + a.y * a.y);
export const dist2 = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};
export const distSq2 = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

/** Unit vector, or `fallback` when the input is degenerate. */
export function norm2(a: Vec2, fallback: Vec2 = { x: 1, y: 0 }): Vec2 {
  const l = len2(a);
  if (l < 1e-9) return clone2(fallback);
  return { x: a.x / l, y: a.y / l };
}

/** Shortens the vector to at most `max`, leaves it alone otherwise. */
export function clampLen2(a: Vec2, max: number): Vec2 {
  const l = len2(a);
  if (l <= max || l < 1e-9) return clone2(a);
  return { x: (a.x / l) * max, y: (a.y / l) * max };
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

/** Rotates by a precomputed (cos, sin) pair — the caller owns the trigonometry, not the sim. */
export function rotateBy(a: Vec2, cos: number, sin: number): Vec2 {
  return { x: a.x * cos - a.y * sin, y: a.x * sin + a.y * cos };
}

/**
 * Standard normal, built out of twelve uniforms (Irwin–Hall).
 *
 * Box–Muller would need `Math.log` and `Math.cos`; this needs nothing but addition, so it is
 * bit-identical on every engine. Mean 0, variance 1, tails cut at ±6 sigma — for a hearing
 * error whose whole point is to be modest and bounded, clipped tails are a feature.
 */
export function gauss(rng: () => number): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rng();
  return s - 6;
}

/** Point uniformly inside the unit disc, by rejection. No trigonometry. */
export function unitDisc(rng: () => number): Vec2 {
  for (let i = 0; i < 16; i++) {
    const x = rng() * 2 - 1;
    const y = rng() * 2 - 1;
    if (x * x + y * y <= 1) return { x, y };
  }
  return { x: 0, y: 0 };
}

/** Unit vector with a uniformly distributed direction. */
export function unitDir(rng: () => number): Vec2 {
  for (let i = 0; i < 16; i++) {
    const x = rng() * 2 - 1;
    const y = rng() * 2 - 1;
    const l2 = x * x + y * y;
    if (l2 > 1e-6 && l2 <= 1) {
      const l = Math.sqrt(l2);
      return { x: x / l, y: y / l };
    }
  }
  return { x: 1, y: 0 };
}

/**
 * Rotates `dir` by a small deterministic angle without trigonometry: nudges the vector
 * sideways by `amount` (radians, for small values) and renormalises.
 */
export function scatterDir(dir: Vec2, amount: number): Vec2 {
  const px = -dir.y;
  const py = dir.x;
  return norm2({ x: dir.x + px * amount, y: dir.y + py * amount }, dir);
}

/**
 * Time of closest approach of two bodies moving at constant velocity, in seconds from now.
 * Negative means the closest approach already happened. Returns 0 when they are not converging.
 */
export function timeOfClosestApproach(relPos: Vec2, relVel: Vec2): number {
  const vv = dot2(relVel, relVel);
  if (vv < 1e-9) return 0;
  return -dot2(relPos, relVel) / vv;
}
