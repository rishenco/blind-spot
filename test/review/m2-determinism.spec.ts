/**
 * M2 ADVERSARIAL REVIEW — determinism, the property every later milestone borrows.
 *
 * Contract under test:
 *   vision §1.2   "The system never lies. Every blip and sound has a real physical source."
 *   vision §12    "sound events are tiny payloads (origin, intensity, class) — geometry is never
 *                 sent, always re-derived client-side." Two clients re-deriving the same geometry
 *                 from the same events is only true if the sim is a pure function of its inputs.
 *   math.ts:2     "No Math.random() anywhere in the engine — every stochastic thing is seeded."
 *   engine-plan §11  co-op needs a transport, not a rewrite — which is a determinism claim.
 *
 * Labels: PIN = passes today, pins verified-correct behaviour. BUG = fails today, on purpose.
 */

import { describe, expect, it } from 'vitest';
import { COYOTE_TIME, SIM_STEP } from '../../src/core/const.js';
import type { SoundEvent } from '../../src/core/events.js';
import { type MoveInput } from '../../src/core/movement.js';
import { Sim } from '../../src/core/sim.js';
import { sampleMap } from '../../src/core/map/sampleMap.js';

const NEUTRAL: MoveInput = {
  forward: 0,
  right: 0,
  jumpPressed: false,
  crouch: false,
  sprint: false,
  yawDelta: 0,
  pitchDelta: 0,
};

const steps = (s: number): number => Math.round(s / SIM_STEP);

/** A route with every verb in it: sprint, turn, jump, slide, crouch, drop. */
const SCRIPT: Array<[number, Partial<MoveInput>]> = [
  [1.2, { forward: 1, sprint: true }],
  [0.4, { forward: 1, sprint: true, yawDelta: 0.02 }],
  [0.6, { forward: 1, sprint: true, crouch: true }],
  [0.1, { forward: 1, sprint: true, jumpPressed: true }],
  [0.8, { forward: 1, right: 0.6, sprint: true }],
  [0.5, { forward: 1, crouch: true }],
  [0.9, { forward: 1 }],
  [0.3, { forward: -1, sprint: true }],
  [0.6, {}],
];

interface Trace {
  end: number[];
  events: Array<[number, string, number, number, number, number]>;
  counts: Record<string, number>;
}

function trace(): Trace {
  const sim = new Sim(sampleMap);
  const p = sim.player;
  // The shipped spawn, turned down the long open lane rather than into the near wall.
  p.x = sampleMap.spawn.pos[0];
  p.y = sampleMap.spawn.pos[1];
  p.z = sampleMap.spawn.pos[2];
  p.yaw = Math.PI / 2;
  p.grounded = true;
  sim.movement.apexY = 0;
  sim.movement.coyote = COYOTE_TIME;
  const events: Trace['events'] = [];
  sim.bus.on((e: SoundEvent) =>
    events.push([e.time, e.class, e.origin[0], e.origin[1], e.origin[2], e.fuzzSeed]),
  );
  for (const [secs, patch] of SCRIPT) {
    for (let i = 0; i < steps(secs); i++) {
      Object.assign(sim.input, NEUTRAL, patch);
      sim.step(SIM_STEP);
    }
  }
  return {
    end: [p.x, p.y, p.z, p.yaw, p.pitch, p.vx, p.vy, p.vz],
    events,
    counts: { ...sim.bus.counts } as unknown as Record<string, number>,
  };
}

// ==========================================================================================
// PIN — the sim is a pure function of (map, inputs)
// ==========================================================================================

describe('PIN · the sim is reproducible bit-for-bit', () => {
  it('two Sims running one script in one process end in byte-identical states', () => {
    const a = trace();
    const b = trace();
    expect(b.end).toEqual(a.end);
    expect(b.counts).toEqual(a.counts);
    expect(b.events.length).toBe(a.events.length);
    expect(b.events).toEqual(a.events);
    expect(a.events.length, 'the script really did make noise').toBeGreaterThan(10);
  });

  it('a replayed script reproduces the same fuzzSeeds, so M3 paint will land in the same place', () => {
    const a = trace();
    const b = trace();
    const seeds = (t: Trace): number[] => t.events.map((e) => e[5]);
    expect(seeds(b)).toEqual(seeds(a));
    expect(new Set(seeds(a)).size, 'and the seeds are not all one value').toBeGreaterThan(5);
  });

  it('no wall clock and no unseeded randomness anywhere the sim can reach', () => {
    // Stronger than grepping the source: take the global clocks and the RNG away and watch. The
    // whole trace is synchronous, so nothing but the sim runs between the swap and the restore.
    const realRandom = Math.random;
    const realDateNow = Date.now;
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    const realPerfNow = perf?.now;
    let random = 0;
    let dateNow = 0;
    let perfNow = 0;
    try {
      Math.random = () => {
        random++;
        return 0.5;
      };
      Date.now = () => {
        dateNow++;
        return 0;
      };
      if (perf && realPerfNow) {
        perf.now = () => {
          perfNow++;
          return 0;
        };
      }
      trace();
    } finally {
      Math.random = realRandom;
      Date.now = realDateNow;
      if (perf && realPerfNow) perf.now = realPerfNow;
    }
    expect(
      [random, dateNow, perfNow],
      `Math.random x${random}, Date.now x${dateNow}, performance.now x${perfNow}`,
    ).toEqual([0, 0, 0]);
  });
});

// ==========================================================================================
// BUG (minor) — the map definition is a shared mutable singleton
// ==========================================================================================

describe('BUG (minor) · `sampleMap` is a live module singleton every Sim writes through', () => {
  /**
   * `new Sim(sampleMap)` stores the caller's object by reference (sim.ts: `readonly map: MapDef`),
   * so `sim.map` IS the module-level `sampleMap`, sharing the same `dogRoutes` array and the same
   * route objects. debug.ts:171-174 (`toggleDog2`, bound to F6 at main.ts:127) does
   * `route.defaultOn = !route.defaultOn` on it. Today that flips a debug flag; the moment M5's
   * per-run randomisation ("dog patrols, cell placement, cache and trap arming randomized per
   * run" — vision §11) writes anything into the map def, the second run of a session starts from
   * the first run's leftovers, and vision §1.2's "the system never lies" becomes a coin flip.
   *
   * Severity: NIT today — nothing in the shipped M2 sim path writes to the map, only the debug
   * overlay does, and one browser tab holds one run. Listed because the fix is one line
   * (structuredClone the def in the Sim constructor, or freeze it) and it gets much more
   * expensive after M5 exists.
   *
   * NOT proven mechanically end-to-end: `toggleDog2` lives on DebugOverlay, which needs a DOM
   * (`document`) at construction, and no jsdom/happy-dom is installed in this repo — the probe
   * therefore pins the aliasing itself, which is the actual defect.
   */
  it('expected: each Sim owns its map — actual: they share one object graph', () => {
    const a = new Sim(sampleMap);
    const b = new Sim(sampleMap);
    expect(a.map).not.toBe(sampleMap);
    expect(b.map.dogRoutes).not.toBe(a.map.dogRoutes);
    expect(b.map.dogRoutes[0]).not.toBe(a.map.dogRoutes[0]);
  });

  it('expected: the map def is immutable — actual: a write through one Sim is visible in the next', () => {
    // This is exactly the write debug.ts:174 performs, done here because DebugOverlay cannot be
    // constructed without a DOM.
    const a = new Sim(sampleMap);
    const route = a.map.dogRoutes.find((r) => r.id === 'dog2');
    expect(route, 'sampleMap still has a dog2 route').toBeDefined();
    const original = route!.defaultOn;
    try {
      route!.defaultOn = !original;
      const b = new Sim(sampleMap);
      const seen = b.map.dogRoutes.find((r) => r.id === 'dog2')!.defaultOn;
      expect(seen, 'a freshly constructed Sim inherited the previous run’s flip').toBe(original);
    } finally {
      route!.defaultOn = original; // leave the module singleton as found, for every other spec
    }
  });
});
