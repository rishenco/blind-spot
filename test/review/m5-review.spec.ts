/**
 * Milestone-5 adversarial review probes (dog + ghosts + props + beacon + stains).
 *
 * House style from the M3/M4 rounds:
 *   PIN — passes today; pins behaviour a fix must not break.
 *   BUG — FAILS today; the assertion states the CORRECT behaviour, so the fix round turns it
 *         green and migrates it into the topic specs. Marked `// BUG(<id>): <claim>`.
 *
 * Contracts cited by doc + line:
 *   doc/vision.md:127  §3.4 "Through one wall: radius -60 %, origin fuzzed +-2 m, dimmer paint"
 *   doc/vision.md:150  §3.7 "Never interpolated, never predicted by the renderer — a ghost is a
 *                      photograph"
 *   doc/vision.md:170  §5 law 5 movement is never taxed
 *   doc/vision.md:194  §6 "A stationary, silent dog is invisible"
 *   doc/vision.md:212  §8 "authored sound-traps, never physics clutter … each with a crisp
 *                      single audio signature"
 *   src/core/paint.ts header — due-gated commutative store, sim time only
 *   src/core/paint.ts:200 deliveredOrigin: "The event layer has to agree with the matter layer"
 */

import { describe, expect, it } from 'vitest';
import {
  BEACON_PERIOD,
  DOG_FREEZE_DELAY,
  DOG_SPEED_PATROL,
  EV,
  EYE_STAND,
  SIM_STEP,
} from '../../src/core/const.js';
import { SCRIPTS, ScriptedInput } from '../../src/core/debug.js';
import type { SoundEvent } from '../../src/core/events.js';
import { deliveredOrigin, PaintPipeline } from '../../src/core/paint.js';
import { resolveRoster } from '../../src/core/roster.js';
import { sampleMap } from '../../src/core/map/sampleMap.js';
import { Sim } from '../../src/core/sim.js';
import { bakeSurfels } from '../../src/core/surfels.js';
import type { DogRouteDef, MapDef, Solid } from '../../src/core/map/types.js';

const box = (
  id: string,
  kind: Solid['kind'],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): Solid => ({ type: 'box', id, kind, min: [x0, y0, z0], max: [x1, y1, z1] });

interface Rig {
  sim: Sim;
  paint: PaintPipeline;
  delivered: SoundEvent[];
  run(seconds: number, sub?: number): void;
}

function rig(
  map: MapDef,
  opts: { dogs?: readonly string[]; props?: readonly string[] } = {},
  listener?: [number, number, number],
): Rig {
  const sim = new Sim(map, opts);
  const paint = new PaintPipeline(bakeSurfels(sim.world), sim.world);
  paint.attach(sim.bus);
  sim.dogs.attach(paint);
  const delivered: SoundEvent[] = [];
  paint.onDelivered((e) => delivered.push({ ...e, origin: [...e.origin] as [number, number, number] }));
  const ear = listener ?? [sim.player.x, sim.player.y + EYE_STAND, sim.player.z];
  paint.setListener(ear[0], ear[1], ear[2]);
  return {
    sim,
    paint,
    delivered,
    run(seconds: number, sub = 1): void {
      const n = Math.round(seconds / SIM_STEP);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < sub; k++) sim.step(SIM_STEP / sub);
        paint.pump(sim.time);
      }
    },
  };
}

/** A flat plate with one wall at z = 30; the ear sits south of it, routes run north. */
function kennel(routes: DogRouteDef[]): MapDef {
  return {
    name: 'kennel',
    solids: [box('floor', 'floor', 0, -1, 0, 60, 0, 60), box('divider', 'wall', 0, 0, 29.8, 60, 4, 30.2)],
    ladders: [],
    props: [],
    doors: [],
    dogRoutes: routes,
    spawn: { pos: [30, 0, 26], yaw: 0 },
    air: [{ min: [0, 0, 0], max: [60, 8, 60] }],
    markers: [],
    bounds: { min: [0, -1, 0], max: [60, 8, 60] },
  };
}

// ==========================================================================================
// P1 — the authorised bake re-baseline (brief: chain curtains become matter)
// ==========================================================================================

function routePaint(map: MapDef, id: string): { dots: number; edges: number; surfels: number } {
  const sim = new Sim(map);
  const field = bakeSurfels(sim.world);
  const paint = new PaintPipeline(field, sim.world);
  paint.attach(sim.bus);
  const def = SCRIPTS[id]!;
  const script = new ScriptedInput(sim, def);
  const n = Math.round((def.end + 1) / SIM_STEP);
  for (let i = 0; i < n; i++) {
    script.sync();
    paint.setListener(sim.player.x, sim.player.y + EYE_STAND, sim.player.z);
    sim.step(SIM_STEP);
    paint.pump(sim.time);
  }
  paint.settle(Infinity);
  return { dots: field.paintedDots, edges: field.paintedEdgeVerts, surfels: field.counts.surfels };
}

const noChain: MapDef = { ...sampleMap, props: sampleMap.props.filter((p) => p.type !== 'chain') };

describe('P1 the chain-curtain bake re-baseline is exactly what was authorised', () => {
  it('PIN adds 88 surfels and changes nothing else about the field', () => {
    const withChain = bakeSurfels(new Sim(sampleMap).world);
    const without = bakeSurfels(new Sim(noChain).world);
    expect(withChain.counts.surfels - without.counts.surfels).toBe(88);
    expect(withChain.counts.edges).toBe(without.counts.edges);
    expect(withChain.counts.holds).toBe(without.counts.holds);
    expect(withChain.counts.patches).toBe(without.counts.patches);
  });

  it('PIN the corridor route gains exactly 40 dots and no hold verts; the mantle route is untouched', () => {
    const c1 = routePaint(sampleMap, 'corridor');
    const c0 = routePaint(noChain, 'corridor');
    expect(c1.dots - c0.dots).toBe(40);
    // Curtain surfels carry no hold/edge flags: the traversal encoding (vision §5 "dots are
    // matter, lines are holds") must not gain a hold you cannot grab.
    expect(c1.edges).toBe(c0.edges);

    const m1 = routePaint(sampleMap, 'mantle');
    const m0 = routePaint(noChain, 'mantle');
    expect(m1.dots).toBe(m0.dots);
    expect(m1.edges).toBe(m0.edges);
  });

  it('PIN the curtain is matter but never collision — walking the corridor is bit-identical', () => {
    const walk = (map: MapDef): number[] => {
      const sim = new Sim(map);
      const def = SCRIPTS['corridor']!;
      const script = new ScriptedInput(sim, def);
      const n = Math.round((def.end + 1) / SIM_STEP);
      for (let i = 0; i < n; i++) {
        script.sync();
        sim.step(SIM_STEP);
      }
      return [sim.player.x, sim.player.y, sim.player.z];
    };
    expect(walk(sampleMap)).toEqual(walk(noChain));
  });

  it('PIN the curtain is baked whether or not the prop roster is live', () => {
    // bakeSurfels is not roster-gated: `?props=none` still produces the 88 surfels. This is the
    // world every pinned capture number lives in, so it is pinned rather than argued.
    const off = new Sim(sampleMap, { props: [] });
    const on = new Sim(sampleMap, { props: ['chain-c'] });
    expect(bakeSurfels(off.world).counts.surfels).toBe(bakeSurfels(on.world).counts.surfels);
    expect(off.props.chains.length).toBe(0);
    expect(on.props.chains.length).toBe(1);
  });
});

// ==========================================================================================
// P2 — a ghost is a photograph (vision §3.7)
// ==========================================================================================

const straight: DogRouteDef = {
  id: 'straight',
  speed: DOG_SPEED_PATROL,
  defaultOn: true,
  waypoints: [
    { x: 4, z: 34 },
    { x: 56, z: 34 },
  ],
};

/** Runs until the dog has frozen, returning the freeze snapshot and the body's true pose. */
function freezeRun(sub: number): { frozenAt: number; ghostX: number; bodyX: number; lastHeard: number } {
  // The ear is far enough that the dog walks out of hearing mid-route and the silence freezes it.
  const r = rig(kennel([straight]), { dogs: ['straight'] }, [6, 1.6, 26]);
  const view = () => r.sim.dogs.views[0]!;
  for (let i = 0; i < Math.round(30 / SIM_STEP); i++) {
    for (let k = 0; k < sub; k++) r.sim.step(SIM_STEP / sub);
    r.paint.pump(r.sim.time);
    if (view().ghosts.length > 0) break;
  }
  const g = view().ghosts[0]!;
  const dogEvents = r.delivered.filter((e) => e.source === 'dog');
  return {
    frozenAt: g.frozenAt,
    ghostX: g.pose.matrix[12]!,
    bodyX: r.sim.dogs.bodies[0]!.x,
    lastHeard: dogEvents[dogEvents.length - 1]!.time,
  };
}

describe('P2 ghosts are photographs, not predictions (vision §3.7)', () => {
  it('PIN freezes at exactly lastHeardAt + DOG_FREEZE_DELAY and keeps the LAST HEARD pose', () => {
    const a = freezeRun(1);
    expect(a.frozenAt).toBeCloseTo(a.lastHeard + DOG_FREEZE_DELAY, 9);
    // The dog kept walking through the 0.4 s of silence. A snapshot of the live matrix would put
    // the ghost where the dog IS; the photograph puts it where the dog was last HEARD.
    // The gap is the ground the dog covered while it was not being heard: one gait interval plus
    // the freeze delay, at patrol speed. Measured 1.250 m.
    expect(Math.abs(a.ghostX - a.bodyX)).toBeGreaterThan(DOG_SPEED_PATROL * DOG_FREEZE_DELAY);
    expect(Math.abs(a.ghostX - a.bodyX)).toBeLessThan(DOG_SPEED_PATROL * (DOG_FREEZE_DELAY + SIM_STEP * 2));
  });

  it('PIN the freeze instant is invariant to step grouping (paint.ts: sim time only)', () => {
    const a = freezeRun(1);
    const b = freezeRun(3);
    expect(b.frozenAt).toBeCloseTo(a.frozenAt, 9);
    expect(b.ghostX).toBeCloseTo(a.ghostX, 6);
  });
});

// ==========================================================================================
// P3 — attribution: does the existing spec discriminate?
// ==========================================================================================

describe('P3 gait attribution', () => {
  it('PIN delivery happens inside bus.emit, so the emitting dog is genuinely on the stack', () => {
    const r = rig(kennel([]), {});
    let inside = false;
    let during = false;
    r.paint.onDelivered(() => {
      during = inside;
    });
    inside = true;
    r.sim.bus.emit({ class: 'walkStep', source: 'self', x: 30, y: 0.1, z: 26 });
    inside = false;
    expect(during).toBe(true);
  });

  it('PIN the emitting dog is ALSO always the nearest dog to the origin — so the "not the nearest one" spec discriminates nothing', () => {
    // test/dog.spec.ts:315 claims to rule out nearest-dog attribution. A gait event is emitted at
    // the emitter's own position, so nearest-to-origin and emitter-on-the-stack agree on every
    // event that fixture produces: the spec would pass unchanged against the rule it names as the
    // wrong one. Recorded as evidence, not as a defect in the mechanism.
    const near: DogRouteDef = {
      id: 'near',
      speed: DOG_SPEED_PATROL,
      defaultOn: true,
      waypoints: [
        { x: 20, z: 34 },
        { x: 34, z: 34 },
      ],
    };
    const far: DogRouteDef = {
      id: 'far',
      speed: DOG_SPEED_PATROL,
      defaultOn: true,
      waypoints: [
        { x: 34, z: 35 },
        { x: 20, z: 35 },
      ],
    };
    const r = rig(kennel([near, far]), { dogs: ['near', 'far'] }, [27, 1.6, 27]);
    let events = 0;
    let emitterWasNearest = 0;
    r.paint.onDelivered((e) => {
      if (e.source !== 'dog') return;
      events++;
      const ranked = r.sim.dogs.bodies
        .map((d) => ({ d, dist: Math.hypot(d.x - e.origin[0], d.z - e.origin[2]) }))
        .sort((p, q) => p.dist - q.dist);
      if (ranked[0]!.dist < 1e-6) emitterWasNearest++;
    });
    r.run(3);
    expect(events).toBeGreaterThan(4);
    expect(emitterWasNearest).toBe(events);
  });
});

// ==========================================================================================
// P4 — the chain curtain (vision §8: one crisp signature per trap)
// ==========================================================================================

function chainMap(): MapDef {
  return {
    name: 'chain-rig',
    solids: [box('floor', 'floor', 0, -1, 0, 40, 0, 40)],
    ladders: [],
    props: [{ type: 'chain', id: 'c', min: [18, 0, 19.9], max: [22, 2.2, 20.1], thinAxis: 'z' }],
    doors: [],
    dogRoutes: [],
    spawn: { pos: [20, 0, 20], yaw: 0 },
    air: [{ min: [0, 0, 0], max: [40, 8, 40] }],
    markers: [],
    bounds: { min: [0, -1, 0], max: [40, 8, 40] },
  };
}

describe('P4 the chain curtain emits once per crossing (vision §8)', () => {
  it('PIN a walk through and back is exactly two rattles, on the curtain plane', () => {
    const r = rig(chainMap(), { props: ['c'] }, [20, 1.6, 25]);
    r.sim.player.z = 22;
    r.sim.input.forward = 1;
    r.sim.player.yaw = -Math.PI / 2; // yawToForward: -z
    r.run(2);
    r.sim.player.yaw = Math.PI / 2; // back again, +z
    r.run(2);
    const rattles = r.sim.bus.counts.chainRattle;
    expect(rattles).toBe(2);
    for (const e of r.delivered.filter((e) => e.class === 'chainRattle')) {
      expect(e.origin[2]).toBeCloseTo(20, 6);
      expect(e.source).toBe('prop');
    }
  });

  it('PIN the latch has no deadband, but it is exactly one event per REAL crossing', () => {
    // The sign-flip latch carries no hysteresis and no minimum re-fire interval, so the worry is
    // a body dithering on the plane machine-gunning a 25 m event at step rate. Driven through the
    // real movement controller it cannot: a reversal costs acceleration, so every flip of the
    // sign is a metre-scale traversal. Pinned as a law rather than a count — rattles equal
    // crossings, whatever the route.
    const r = rig(chainMap(), { props: ['c'] }, [20, 1.6, 25]);
    r.sim.player.z = 21.5;
    r.sim.input.forward = 1;
    let prev = Math.sign(r.sim.player.z - 20);
    let crossings = 0;
    for (let i = 0; i < Math.round(6 / SIM_STEP); i++) {
      // Reverse every 0.75 s: four honest passes through the doorway.
      r.sim.player.yaw = Math.floor(i / Math.round(0.75 / SIM_STEP)) % 2 === 0 ? -Math.PI / 2 : Math.PI / 2;
      r.sim.step(SIM_STEP);
      r.paint.pump(r.sim.time);
      const side = Math.sign(r.sim.player.z - 20);
      if (side !== 0 && side !== prev) crossings++;
      prev = side;
    }
    expect(crossings).toBeGreaterThan(2);
    expect(r.sim.bus.counts.chainRattle).toBe(crossings);
  });

  it('PIN the rattle variant is the MEASURED gait, not the crouch key', () => {
    const pass = (crouch: boolean, sprint: boolean): string | undefined => {
      const r = rig(chainMap(), { props: ['c'] }, [20, 1.6, 25]);
      r.sim.player.z = 22;
      r.sim.player.yaw = -Math.PI / 2;
      r.sim.input.forward = 1;
      r.sim.input.crouch = crouch;
      r.sim.input.sprint = sprint;
      r.run(3);
      return r.delivered.find((e) => e.class === 'chainRattle')?.variant;
    };
    expect(pass(true, false)).toBe('quiet');
    expect(pass(false, false)).toBe('loud');
    expect(pass(false, true)).toBe('loud');
    // Note: crouch+sprint reads 'quiet' because the controller holds the body at crouch SPEED —
    // the gait is measured, not asserted, which is the intended law. A fast crouched body (a
    // slide) is the case that must stay loud.
  });
});

// ==========================================================================================
// P5 — the can (vision §5 law 5, §3.3 prop-knock row)
// ==========================================================================================

function canMap(): MapDef {
  return {
    name: 'can-rig',
    solids: [box('floor', 'floor', 0, -1, 0, 40, 0, 40)],
    ladders: [],
    props: [{ type: 'can', id: 'k', x: 20, y: 0, z: 20 }],
    doors: [],
    dogRoutes: [],
    spawn: { pos: [20, 0, 24], yaw: 0 },
    air: [{ min: [0, 0, 0], max: [40, 8, 40] }],
    markers: [],
    bounds: { min: [0, -1, 0], max: [40, 8, 40] },
  };
}

describe('P5 the can is sound only (vision §5 law 5, §3.3)', () => {
  it('PIN standing inside a can is silent and the body is unmoved by it', () => {
    const a = rig(canMap(), { props: ['k'] });
    a.sim.player.x = 20;
    a.sim.player.z = 20;
    a.run(1);
    const b = rig(canMap(), { props: [] });
    b.sim.player.x = 20;
    b.sim.player.z = 20;
    b.run(1);
    expect(a.sim.bus.counts.propKnock).toBe(0);
    expect([a.sim.player.x, a.sim.player.y, a.sim.player.z]).toEqual([
      b.sim.player.x,
      b.sim.player.y,
      b.sim.player.z,
    ]);
  });

  it('PIN a knock scales its paint radius monotonically inside the authored [8, 12] row', () => {
    const seen: number[] = [];
    const r = rig(canMap(), { props: ['k'] }, [20, 1.6, 24]);
    r.sim.player.yaw = -Math.PI / 2;
    r.sim.input.forward = 1;
    r.sim.input.sprint = true;
    r.run(3);
    for (const e of r.delivered.filter((e) => e.class === 'propKnock')) seen.push(e.paintRadius);
    expect(seen.length).toBeGreaterThan(0);
    for (const rad of seen) {
      expect(rad).toBeGreaterThanOrEqual(EV.propKnock.paint - 1e-9);
      expect(rad).toBeLessThanOrEqual(EV.propKnock.paintMax + 1e-9);
    }
    // The first impact is the kick itself: the loudest of the burst.
    expect(seen[0]).toBe(Math.max(...seen));
  });
});

// ==========================================================================================
// P6 — the beacon (vision §7)
// ==========================================================================================

function beaconMap(): MapDef {
  return {
    name: 'beacon-rig',
    solids: [box('floor', 'floor', 0, -1, 0, 40, 0, 40)],
    ladders: [],
    props: [{ type: 'beacon', id: 'b', x: 20, y: 1, z: 20 }],
    doors: [],
    dogRoutes: [],
    spawn: { pos: [20, 0, 24], yaw: 0 },
    air: [{ min: [0, 0, 0], max: [40, 8, 40] }],
    markers: [],
    bounds: { min: [0, -1, 0], max: [40, 8, 40] },
  };
}

describe('P6 the beacon is a clock on sim time (vision §7)', () => {
  it('PIN class beaconHum / source objective, no beat at t=0, period exact and drift-free', () => {
    const r0 = rig(beaconMap(), { props: ['b'] });
    r0.run(13);
    const beats = r0.delivered.filter((e) => e.class === 'beaconHum').map((e) => e.time);
    expect(beats.length).toBe(3);
    // A beat is owed at t = 4, 8, 12 and is served on the first step at or after it. `next` is
    // advanced by += PERIOD, so the quantisation never accumulates.
    for (let i = 0; i < beats.length; i++) {
      const owed = BEACON_PERIOD * (i + 1);
      expect(beats[i]!).toBeGreaterThanOrEqual(owed);
      expect(beats[i]! - owed).toBeLessThan(SIM_STEP + 1e-9);
    }
    expect(Math.abs(beats[2]! - beats[0]! - 2 * BEACON_PERIOD)).toBeLessThan(SIM_STEP + 1e-9);

    const r = rig(beaconMap(), { props: ['b'] });
    r.run(5);
    const one = r.delivered.find((e) => e.class === 'beaconHum')!;
    expect(one.source).toBe('objective');
    expect(one.origin).toEqual([20, 1, 20]);
  });
});

// ==========================================================================================
// P7 — the roster
// ==========================================================================================

describe('P7 roster resolution (core/roster.ts)', () => {
  const known = ['dog1', 'dog2'];
  const defaults = ['dog1'];
  const base = { known, defaults };

  it('PIN a URL param always beats a script declaration, in map order, dropping unknowns', () => {
    expect(resolveRoster({ ...base, param: 'none', scripted: true, scriptRoster: ['dog1'] })).toEqual([]);
    expect(resolveRoster({ ...base, param: 'all', scripted: true, scriptRoster: [] })).toEqual(known);
    expect(resolveRoster({ ...base, param: 'dog2,dog2,dog1', scripted: false })).toEqual(known);
    expect(resolveRoster({ ...base, param: 'nope', scripted: false })).toEqual([]);
    // Absent param: a scripted run takes the script's declaration, a human run the map defaults.
    expect(resolveRoster({ ...base, param: null, scripted: true, scriptRoster: ['dog2'] })).toEqual(['dog2']);
    expect(resolveRoster({ ...base, param: null, scripted: true })).toEqual([]);
    expect(resolveRoster({ ...base, param: null, scripted: false })).toEqual(defaults);
  });
});

// ==========================================================================================
// P8 — the event layer vs the matter layer (paint.ts:200)
// ==========================================================================================

describe('P8 deliveredOrigin', () => {
  it('PIN is stable across calls and only displaces one-wall events', () => {
    const r = rig(kennel([straight]), { dogs: ['straight'] }, [6, 1.6, 26]);
    r.run(4);
    const dogEvents = r.delivered.filter((e) => e.source === 'dog');
    expect(dogEvents.length).toBeGreaterThan(0);
    for (const e of dogEvents) {
      const a = [...deliveredOrigin(e)];
      const b = [...deliveredOrigin(e)];
      expect(b).toEqual(a);
      const moved = Math.hypot(a[0]! - e.origin[0], a[1]! - e.origin[1], a[2]! - e.origin[2]);
      if (e.wallsToListener === 1) expect(moved).toBeGreaterThan(0);
      else expect(moved).toBe(0);
    }
  });

  // BUG(B-STAIN-DRIFT): paint fuzzes an event's origin per SURFEL (walls between origin and
  // surface), deliveredOrigin fuzzes it per LISTENER (walls between origin and ear). For the
  // ordinary through-wall dog they disagree: every dot in the dog's OWN room is painted from the
  // true origin, while the stain the look draws sits up to 2 m away — the exact "two answers to
  // where did that happen" the function's own header (src/core/paint.ts:200-208) forbids.
  it('BUG(B-STAIN-DRIFT): the stain must sit on the cluster its own event painted', () => {
    const r = rig(kennel([straight]), { dogs: ['straight'] }, [6, 1.6, 26]);
    r.run(4);
    const e = r.delivered.find((ev) => ev.source === 'dog' && ev.wallsToListener === 1)!;
    expect(e).toBeTruthy();
    // Surfels around the dog are on the dog's own side of the divider: zero walls from the
    // origin, so paint puts them on the TRUE origin, unfuzzed.
    const o = deliveredOrigin(e);
    const drift = Math.hypot(o[0] - e.origin[0], o[1] - e.origin[1], o[2] - e.origin[2]);
    expect(drift).toBeLessThan(0.05);
  });
});
