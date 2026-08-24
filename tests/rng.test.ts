/**
 * The nondeterminism budget, pinned.
 *
 * `src/core/rng.ts` collapsed two character-for-character identical copies of mulberry32 (one in
 * `paint/structured.ts`, one in `paint/paintSystem.ts`) into one generator, and put the seed
 * policy behind `parseSeed`/`streamSeed`. The move had to be bit-neutral: an unseeded run must
 * produce the world it has always produced, down to the dot.
 *
 * Three layers of proof here, cheapest first:
 *  1. golden outputs — the generator itself, for both historical seeds;
 *  2. seed parsing and stream derivation — the policy around it;
 *  3. the lattice dot count off a real `buildRoom` world — the end-to-end check. That number is
 *     a pure function of the lattice stream and moves if the stream shifts by a single draw, so
 *     it catches a plumbing mistake that the golden constants alone cannot: a seed that never
 *     reaches the generator, or one that reaches it when it should not have.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUST_SEED,
  DEFAULT_LATTICE_SEED,
  STREAM_DUST,
  STREAM_LATTICE,
  deriveSeed,
  makeRng,
  parseSeed,
  streamSeed,
} from '../src/core/rng';
import { StaticWorld } from '../src/core/collision';
import { PaintSystem } from '../src/paint/paintSystem';
import { buildRoom } from '../src/world/room';

/**
 * The first eight draws of each historical stream, measured from the pre-move code.
 *
 * These are the witnesses that the generator moved verbatim. If a change to `makeRng` makes one
 * of these fail, the world it paints has already changed — do not re-record them.
 */
const GOLDEN_LATTICE = [
  0.7664916012436152, 0.25428368779830635, 0.8572775018401444, 0.44847786147147417,
  0.12815626640804112, 0.44009312498383224, 0.9891176181845367, 0.9630778154823929,
];
const GOLDEN_DUST = [
  0.2884542921092361, 0.13095843675546348, 0.745248744264245, 0.0327394048217684,
  0.35799544281326234, 0.9315174783114344, 0.8506920479703695, 0.635215119458735,
];

/**
 * The lattice dot count of the shipped room on the default path. A real measurement, not a
 * guess: it is what `structDots` has always reported, and the whole point of pinning it is that
 * it moves the moment the lattice jitter stream does.
 */
const ROOM_DOTS_DEFAULT = 95055;

function draw(seed: number, count: number): number[] {
  const rng = makeRng(seed);
  return Array.from({ length: count }, () => rng());
}

function roomDots(options?: { latticeSeed?: number }): number {
  const world = new StaticWorld();
  buildRoom(world);
  const paint = new PaintSystem(world, options);
  return paint.structured.getStats().dots;
}

describe('makeRng', () => {
  it('reproduces the historical lattice stream exactly', () => {
    expect(draw(DEFAULT_LATTICE_SEED, GOLDEN_LATTICE.length)).toEqual(GOLDEN_LATTICE);
  });

  it('reproduces the historical dust stream exactly', () => {
    expect(draw(DEFAULT_DUST_SEED, GOLDEN_DUST.length)).toEqual(GOLDEN_DUST);
  });

  it('keeps the historical seed constants', () => {
    expect(DEFAULT_LATTICE_SEED).toBe(0x51ded);
    expect(DEFAULT_DUST_SEED).toBe(0xd0757);
  });

  it('is a pure function of its seed — two generators walk the same sequence', () => {
    expect(draw(12345, 16)).toEqual(draw(12345, 16));
  });

  it('stays inside [0, 1) over a long run', () => {
    const rng = makeRng(0xbadf00d);
    for (let i = 0; i < 10_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('treats the seed as uint32, so a negative seed is not a different world', () => {
    expect(draw(-1, 4)).toEqual(draw(0xffffffff, 4));
  });
});

describe('deriveSeed', () => {
  it('gives the two streams different seeds from one base', () => {
    const lattice = deriveSeed(7, STREAM_LATTICE);
    const dust = deriveSeed(7, STREAM_DUST);
    expect(lattice).not.toBe(dust);
    // And not merely different — decorrelated. Adjacent mulberry32 seeds walk near-identical
    // sequences, which is exactly the bug an unmixed `base + stream` split ships.
    expect(Math.abs(lattice - dust)).toBeGreaterThan(1024);
    expect(draw(lattice, 4)).not.toEqual(draw(dust, 4));
  });

  it('gives different seeds for different bases on the same stream', () => {
    expect(deriveSeed(1, STREAM_LATTICE)).not.toBe(deriveSeed(2, STREAM_LATTICE));
  });

  it('is deterministic and unsigned', () => {
    for (const base of [0, 1, 123, 0xffffffff, -5]) {
      const value = deriveSeed(base, STREAM_DUST);
      expect(value).toBe(deriveSeed(base, STREAM_DUST));
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('parseSeed', () => {
  it('reports no explicit seed when the query string is empty', () => {
    expect(parseSeed('')).toEqual({ seed: 0, explicit: false });
    expect(parseSeed('?')).toEqual({ seed: 0, explicit: false });
    expect(parseSeed('?look=drag')).toEqual({ seed: 0, explicit: false });
  });

  it('reads ?seed=123', () => {
    expect(parseSeed('?seed=123')).toEqual({ seed: 123, explicit: true });
    expect(parseSeed('seed=123')).toEqual({ seed: 123, explicit: true });
    expect(parseSeed('?look=drag&seed=123')).toEqual({ seed: 123, explicit: true });
  });

  it('accepts anything Number accepts, including hex', () => {
    expect(parseSeed('?seed=0x51ded')).toEqual({ seed: 0x51ded, explicit: true });
    expect(parseSeed('?seed=1e3')).toEqual({ seed: 1000, explicit: true });
  });

  it('degrades garbage to the default run rather than to NaN', () => {
    for (const search of ['?seed=', '?seed=abc', '?seed=%20', '?seed=NaN', '?seed=Infinity']) {
      const config = parseSeed(search);
      expect(Number.isNaN(config.seed)).toBe(false);
      expect(config).toEqual({ seed: 0, explicit: false });
    }
  });

  it('normalises a seed to uint32 instead of carrying a float or a sign', () => {
    expect(parseSeed('?seed=12.7')).toEqual({ seed: 12, explicit: true });
    expect(parseSeed('?seed=-1')).toEqual({ seed: 0xffffffff, explicit: true });
    expect(Number.isInteger(parseSeed('?seed=1e30').seed)).toBe(true);
  });
});

describe('streamSeed', () => {
  it('hands back the historical constants when no seed was given', () => {
    const config = parseSeed('');
    expect(streamSeed(config, STREAM_LATTICE)).toBe(0x51ded);
    expect(streamSeed(config, STREAM_DUST)).toBe(0xd0757);
  });

  it('derives both streams when a seed was given', () => {
    const config = parseSeed('?seed=123');
    expect(streamSeed(config, STREAM_LATTICE)).toBe(deriveSeed(123, STREAM_LATTICE));
    expect(streamSeed(config, STREAM_DUST)).toBe(deriveSeed(123, STREAM_DUST));
    expect(streamSeed(config, STREAM_LATTICE)).not.toBe(0x51ded);
  });

  it('refuses a stream it has no historical constant for', () => {
    expect(() => streamSeed({ seed: 0, explicit: false }, 99)).toThrow();
  });
});

describe('the lattice stream, end to end', () => {
  it('paints the shipped room with exactly the dots it always has', () => {
    expect(roomDots()).toBe(ROOM_DOTS_DEFAULT);
  });

  it('is unchanged when the default seed is passed explicitly', () => {
    expect(roomDots({ latticeSeed: DEFAULT_LATTICE_SEED })).toBe(ROOM_DOTS_DEFAULT);
  });

  it('actually moves when a derived seed is supplied', () => {
    // The half that proves the seed reaches the generator instead of being quietly dropped.
    const seeded = roomDots({ latticeSeed: deriveSeed(123, STREAM_LATTICE) });
    expect(seeded).not.toBe(ROOM_DOTS_DEFAULT);
    // Still the same room, though: jitter nudges which samples survive the cull, it does not
    // rebuild the level.
    expect(seeded).toBeGreaterThan(ROOM_DOTS_DEFAULT * 0.98);
    expect(seeded).toBeLessThan(ROOM_DOTS_DEFAULT * 1.02);
  });

  it('is reproducible for a given seed', () => {
    const seed = deriveSeed(999, STREAM_LATTICE);
    expect(roomDots({ latticeSeed: seed })).toBe(roomDots({ latticeSeed: seed }));
  });
});
