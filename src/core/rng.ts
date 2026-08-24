/**
 * The whole nondeterminism budget of the simulation, in one file.
 *
 * There is no `Math.random` and no `Date.now` anywhere in `src/` — the simulation's only
 * unpredictable inputs are the player's own hands and the two seeded streams below. That is a
 * property, not an accident: it is what lets `tests/determinism.test.ts` run the world twice and
 * compare it exactly, and what will one day let a run be reproduced from a link. Keeping the
 * generator and the seed policy here, rather than inlined at the two use sites, is what makes
 * that property auditable — every stream in the game is visible on this page.
 *
 * Seed policy:
 *  - No `?seed=` in the URL: each stream uses the constant it has always used, so the default
 *    run is byte-identical to every previous default run. Bit neutrality is the point.
 *  - `?seed=N`: every stream is derived from N through `deriveSeed`, which decorrelates the
 *    streams so two of them never walk the same sequence.
 */

/** A generator: successive calls return uniform values in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 — small, fast, seedable, and good enough for jitter and dust.
 *
 * Moved here verbatim from `paint/structured.ts` and `paint/paintSystem.ts`, which held two
 * character-for-character identical copies. `tests/rng.test.ts` pins its first outputs for both
 * historical seeds, so an "improvement" to this function cannot silently repaint the world.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stream ids. One per independent draw sequence; never renumber a live one. */
export const STREAM_LATTICE = 1;
export const STREAM_DUST = 2;

/**
 * The constants the two streams were born with, and what they still use when no seed is given.
 *
 * These are load-bearing: change either and every frame of the default run changes with it.
 */
export const DEFAULT_LATTICE_SEED = 0x51ded;
export const DEFAULT_DUST_SEED = 0xd0757;

/** What a stream falls back to when the run has no explicit seed. */
const HISTORICAL_SEEDS = new Map<number, number>([
  [STREAM_LATTICE, DEFAULT_LATTICE_SEED],
  [STREAM_DUST, DEFAULT_DUST_SEED],
]);

/**
 * Splits one run seed into a per-stream seed (murmur3 finaliser over a golden-ratio mix).
 *
 * The mixing matters more than the quality: seeding two streams with `base + 1` and `base + 2`
 * makes them near-copies of each other under mulberry32, whose state step is a plain addition.
 * Avalanche first, then seed.
 */
export function deriveSeed(base: number, stream: number): number {
  let h = ((base >>> 0) ^ Math.imul(stream >>> 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A run's seed, and whether the player actually asked for it.
 *
 * `explicit` is not cosmetic — it selects between "derive everything from `seed`" and "use the
 * historical constants", which are different worlds.
 */
export interface SeedConfig {
  readonly seed: number;
  readonly explicit: boolean;
}

/** The no-seed-given configuration: streams keep their historical constants. */
export const DEFAULT_SEED: SeedConfig = { seed: 0, explicit: false };

/**
 * Reads `?seed=` out of a `location.search` string.
 *
 * Accepts anything `Number` accepts, so `?seed=0x51ded` and `?seed=1e6` both work. Absent,
 * empty, or unparseable degrades to the default run rather than to `NaN`: a typo in a URL
 * should give you the game, not a world seeded with a non-number.
 */
export function parseSeed(search: string): SeedConfig {
  const raw = new URLSearchParams(search).get('seed');
  if (raw === null || raw.trim() === '') return DEFAULT_SEED;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_SEED;
  return { seed: Math.trunc(value) >>> 0, explicit: true };
}

/**
 * The seed one stream should actually run with — the single place the bit-neutrality rule
 * lives, so no caller has to remember it.
 */
export function streamSeed(config: SeedConfig, stream: number): number {
  if (config.explicit) return deriveSeed(config.seed, stream);
  const historical = HISTORICAL_SEEDS.get(stream);
  if (historical === undefined) throw new Error(`no historical seed for stream ${stream}`);
  return historical;
}
