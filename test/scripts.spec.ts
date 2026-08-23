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
import {
  ENERGY_EPING,
  ENERGY_MAX,
  ENERGY_QPING,
  EV,
  PING_COOLDOWN,
  SIM_STEP,
  SPEED_SPRINT,
  SLIDE_BOOST_SPEED,
} from '../src/core/const.js';
import { SCRIPTS, SCRIPT_ALIASES, ScriptedInput, type ScriptDef } from '../src/core/debug.js';
import { sampleMap } from '../src/core/map/sampleMap.js';
import { Sim } from '../src/core/sim.js';
import type { SoundEvent } from '../src/core/events.js';
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
  /** Every sound the route published, in emission order. */
  readonly events: readonly SoundEvent[];
  /** The reactor's low-water mark, and the loudest the halo ever read (vision §3.8, §4). */
  readonly minEnergy: number;
  readonly maxAudible: number;
}

/** Play a route to its end (plus a second of quiet) exactly as `main.ts` does. */
function play(def: ScriptDef): Run {
  const sim = new Sim(sampleMap);
  const script = new ScriptedInput(sim, def);
  const hands: HandsState[] = [];
  const stances = new Set<Stance>();
  const events: SoundEvent[] = [];
  sim.bus.on((e) => events.push(e));
  let minY = Infinity;
  let maxY = -Infinity;
  let maxSpeed = 0;
  let ladderEvents = 0;
  let minEnergy = Infinity;
  let maxAudible = 0;

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
    minEnergy = Math.min(minEnergy, sim.playerSystems.energy);
    maxAudible = Math.max(maxAudible, sim.playerSystems.audibleRadius);
    if (p.stance === 'ladder') ladderEvents += sim.bus.emitted - before;
  }
  return { sim, script, hands, stances, minY, maxY, maxSpeed, ladderEvents, events, minEnergy, maxAudible };
}

describe('the SCRIPTS table', () => {
  it('keeps its segments in time order and ends after the last one', () => {
    for (const def of Object.values(SCRIPTS)) {
      const times = def.segments.map((s) => s.at);
      expect(times, def.id).toEqual([...times].sort((a, b) => a - b));
      expect(def.end, def.id).toBeGreaterThan(times[times.length - 1]!);
    }
  });

  it('keeps the ping track in time order, inside the route, and above the cooldown', () => {
    // A route that presses faster than PING_COOLDOWN is not illegal — the step refuses it exactly
    // as it refuses a player (vision §3.5) — but as a fixture it would be measuring the refusal
    // path while claiming to measure the ping path, so the table is kept honest here instead.
    for (const def of Object.values(SCRIPTS)) {
      const times = (def.pings ?? []).map((p) => p.at);
      expect(times, def.id).toEqual([...times].sort((a, b) => a - b));
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!, def.id).toBeGreaterThan(PING_COOLDOWN);
      }
      if (times.length > 0) expect(def.end, def.id).toBeGreaterThan(times[times.length - 1]!);
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

describe('route "ping" — walk quiet · Q the room · E the tank', () => {
  const r = play(SCRIPTS.ping!);
  const pings = r.events.filter((e) => e.class === 'qPing' || e.class === 'ePing');

  it('ends standing still on the tank’s centre line', () => {
    expect(r.script.done).toBe(true);
    const p = r.sim.player;
    // The tank is a Ø6 cylinder centred (16, 16); x = 3 keeps the walk clear of the x = 6 columns.
    expect(p.x).toBeCloseTo(3, 2);
    expect(Math.abs(p.z - 16)).toBeLessThan(1);
    expect(r.sim.movement.speedXZ).toBeCloseTo(0, 6);
    expect(r.stances.has('air')).toBe(false);
  });

  it('presses both keys and has both accepted', () => {
    expect(r.script.pressed).toBe(2);
    // One Q, and an E that is TWO events: the outgoing cone and the far end it made at the wall
    // it landed on (vision §3.3 "heard 30 m at both ends", engine-plan §6).
    expect(r.sim.bus.counts.qPing).toBe(1);
    expect(r.sim.bus.counts.ePing).toBe(2);
    expect(pings.map((e) => e.class)).toEqual(['qPing', 'ePing', 'ePing']);
    expect(pings[1]!.variant).toBeUndefined();
    expect(pings[2]!.variant).toBe('far');
  });

  it('lands the far end on the tank itself — the beam has real geometry to answer it', () => {
    const far = pings[2]!;
    const p = r.sim.player;
    // The near face of a Ø6 cylinder at (16, 16), less the back-off that keeps the origin out of
    // the solid: |far − centre| is the radius, to within that back-off.
    const rad = Math.hypot(far.origin[0] - 16, far.origin[2] - 16);
    expect(rad).toBeGreaterThan(3);
    expect(rad).toBeLessThan(3.2);
    expect(far.origin[0]).toBeGreaterThan(p.x);
    expect(far.paintRadius).toBe(0);
    // …and it is close enough that the player hears their own return (vision §3.3: 30 m).
    expect(Math.hypot(far.origin[0] - p.x, far.origin[2] - p.z)).toBeLessThan(EV.ePing.hear);
  });

  it('pays for both pings out of the reactor and says so on the halo', () => {
    // The bar is full at the Q and has regenerated part of it back by the E, so the low-water mark
    // is the E's own price below the cap — not the sum. What is asserted is that both were CHARGED.
    expect(r.minEnergy).toBeLessThanOrEqual(ENERGY_MAX - ENERGY_EPING);
    expect(r.minEnergy).toBeGreaterThan(0);
    expect(r.sim.playerSystems.energy).toBeLessThan(ENERGY_MAX);
    expect(ENERGY_QPING).toBeLessThan(ENERGY_EPING);
    // The loudest thing this route does is the E-ping, and the halo is a readout of exactly that.
    expect(r.maxAudible).toBe(EV.ePing.hear);
  });

  it('goes quiet before it pings, so the ping’s paint is its own', () => {
    const firstPing = pings[0]!.time;
    const lastStep = r.events.filter((e) => e.class === 'walkStep').at(-1)!.time;
    // Movement classes are instant (waveSpeed Infinity), so a full second of silence is enough for
    // every footfall's paint to have landed before the first ping is emitted.
    expect(firstPing - lastStep).toBeGreaterThan(1);
    expect(r.sim.bus.counts.sprintStep).toBe(0);
    expect(r.sim.bus.counts.landing).toBe(0);
  });
});
