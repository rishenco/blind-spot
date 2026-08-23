/**
 * The scripted movement routes (engine-plan §10) run against the real Dock Approach map.
 *
 * `npm run verify` plays these same two routes in a browser and screenshots the top-down trail;
 * this spec plays them headlessly and asserts the choreography they are named for. Both read the
 * same `SCRIPTS` table, so a route that stops doing what it says fails here — in seconds, with a
 * position — instead of failing as a picture nobody looks at.
 *
 * These are also the strongest end-to-end pins on the controller: every verb in vision §5 is
 * exercised through the authored geometry rather than through the synthetic gym.
 */

import { describe, expect, it } from 'vitest';
import { SIM_STEP, SPEED_SPRINT, SLIDE_BOOST_SPEED } from '../src/core/const.js';
import { SCRIPTS, SCRIPT_ALIASES, ScriptedInput, type ScriptDef } from '../src/core/debug.js';
import { sampleMap } from '../src/core/map/sampleMap.js';
import { Sim } from '../src/core/sim.js';
import type { HandsState } from '../src/core/movement.js';
import type { Stance } from '../src/core/sim.js';

interface Run {
  readonly sim: Sim;
  readonly script: ScriptedInput;
  /** Distinct values `hands` took, in order — the verb log of the route. */
  readonly hands: HandsState[];
  readonly stances: Set<Stance>;
  readonly minY: number;
  readonly maxY: number;
  readonly maxSpeed: number;
  /** Events emitted while on the ladder — vision §5 says a climb is silent. */
  readonly ladderEvents: number;
}

/** Play a route to its end (plus a second of quiet) exactly as `main.ts` does. */
function play(def: ScriptDef): Run {
  const sim = new Sim(sampleMap);
  const script = new ScriptedInput(sim, def);
  const hands: HandsState[] = [];
  const stances = new Set<Stance>();
  let minY = Infinity;
  let maxY = -Infinity;
  let maxSpeed = 0;
  let ladderEvents = 0;

  for (let i = 0; i < Math.round((def.end + 1) / SIM_STEP); i++) {
    script.sync();
    const before = sim.bus.emitted;
    sim.step(SIM_STEP);
    const p = sim.player;
    const m = sim.movement;
    if (hands[hands.length - 1] !== m.hands) hands.push(m.hands);
    stances.add(p.stance);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    maxSpeed = Math.max(maxSpeed, m.speedXZ);
    if (p.stance === 'ladder') ladderEvents += sim.bus.emitted - before;
  }
  return { sim, script, hands, stances, minY, maxY, maxSpeed, ladderEvents };
}

describe('the SCRIPTS table', () => {
  it('keeps its segments in time order and ends after the last one', () => {
    for (const def of Object.values(SCRIPTS)) {
      const times = def.segments.map((s) => s.at);
      expect(times, def.id).toEqual([...times].sort((a, b) => a - b));
      expect(def.end, def.id).toBeGreaterThan(times[times.length - 1]!);
    }
  });

  it('resolves every `?sim=` alias to a real route', () => {
    for (const [alias, id] of Object.entries(SCRIPT_ALIASES)) {
      expect(SCRIPTS[id], alias).toBeDefined();
    }
  });
});

describe('route "corridor" — sprint · slide · jump · drop · ladder', () => {
  const r = play(SCRIPTS.corridor!);

  it('finishes the route it was written for', () => {
    expect(r.script.done).toBe(true);
    // Out of the trench and back on corridor C's floor, well east of the pit (x 31..35).
    expect(r.sim.player.y).toBeCloseTo(0, 4);
    expect(r.sim.player.x).toBeGreaterThan(40);
    expect(r.sim.player.z).toBeGreaterThan(0.4);
    expect(r.sim.player.z).toBeLessThan(1.9);
  });

  it('uses every verb the title claims', () => {
    // Slide under the duct, fall into the trench, climb out: the three stances that are not walking.
    expect(r.stances.has('slide')).toBe(true);
    expect(r.stances.has('air')).toBe(true);
    expect(r.stances.has('ladder')).toBe(true);
    expect(r.stances.has('crouch')).toBe(true);
    // Empty hands, then the rungs, then the pull-up off the top of them.
    expect(r.hands).toEqual(['none', 'ladder', 'mantle', 'none']);
    expect(r.minY).toBeCloseTo(-2.8, 2);
  });

  it('lands in the trench instead of catching the rungs in mid-air', () => {
    // The whole reason the route brakes at the lip: carry the sprint over and you fly the gap,
    // grab the ladder while still falling, and the descent paints nothing.
    expect(r.sim.bus.counts.landing).toBe(1);
    expect(r.sim.movement.lastFall).toBeCloseTo(2.8, 2);
  });

  it('paints the corridor with every movement class it should', () => {
    const c = r.sim.bus.counts;
    expect(c.sprintStep).toBeGreaterThan(3);
    expect(c.walkStep).toBeGreaterThanOrEqual(3);
    expect(c.crouchStep).toBeGreaterThan(0);
    expect(c.slide).toBeGreaterThan(5);
  });

  it('climbs silently (vision §5)', () => {
    expect(r.ladderEvents).toBe(0);
  });

  it('tops out off the rungs without a scuff (vision §5: the climb is silent, end to end)', () => {
    // `hands` goes through 'mantle' here — the pull-up off the top rung uses the same glide as a
    // ledge mantle — but the new 'mantle' sound class is deliberately NOT emitted for it. The
    // ladder is the one traversal the vision buys silence for, and that has to include getting
    // off it; otherwise the quiet way up ends in the loudest note of the route.
    expect(r.hands).toContain('mantle');
    expect(r.sim.bus.counts.mantle).toBe(0);
  });

  it('never goes faster than the slide that fed it', () => {
    expect(r.maxSpeed).toBeLessThanOrEqual(SLIDE_BOOST_SPEED + 1e-6);
  });
});

describe('route "mantle" — cross the machine hall, climb the machinery row', () => {
  const r = play(SCRIPTS.mantle!);

  it('ends standing on the row at the listening post', () => {
    expect(r.script.done).toBe(true);
    const p = r.sim.player;
    // The machinery row is x 4..20, z 24..26, top at exactly MANTLE_MAX_HEIGHT.
    expect(p.y).toBeCloseTo(2.2, 4);
    expect(p.x).toBeGreaterThan(4);
    expect(p.x).toBeLessThan(20);
    expect(p.z).toBeGreaterThan(24);
    expect(p.z).toBeLessThan(26);
  });

  it('gets up there by mantling, not by falling onto it', () => {
    expect(r.hands).toEqual(['none', 'mantle', 'none']);
    expect(r.minY).toBeCloseTo(0, 4);
    expect(r.sim.bus.counts.landing).toBe(0);
    // …and the climb is heard exactly once. A mantle is a real physical scuff, so it publishes a
    // real event (a proposed §3.3 addendum — see doc/engine-plan.md); one climb, one event.
    expect(r.sim.bus.counts.mantle).toBe(1);
  });

  it('crosses the hall at a sprint and never faster', () => {
    // This route is what caught ground accel manufacturing 11 m/s against the row's face: the
    // Quake projection is blind to speed across wishdir, so rubbing a wall paid out cap/cos.
    expect(r.sim.bus.counts.sprintStep).toBeGreaterThan(3);
    expect(r.maxSpeed).toBeLessThanOrEqual(SPEED_SPRINT + 1e-6);
  });
});
