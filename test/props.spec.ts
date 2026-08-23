/**
 * Authored sound-traps (vision §8, engine-plan §8): the can, the chain curtain and the beacon.
 *
 * Contract under test:
 *   vision §8    props are "authored sound-traps, never physics clutter" — read-and-route puzzles
 *                with one crisp signature each, and "no ragdoll comedy anywhere".
 *   vision §5    nothing may turn movement into rationing. A can is knocked BY a body and never
 *                acts on one: no slow, no push, no stagger, not a millimetre of deflection.
 *   vision §3.3  prop knock paints 8–12 m and is heard by dogs at 25 m; the chain has a loud row
 *                and a quiet one, and which you get is the gait you are actually travelling at.
 *   vision §1.2  the system never lies — a can you hear bounce twice bounced twice, and the sound
 *                comes from where the tin actually is, including the second time you kick it.
 *   vision §7    the objective hums on a fixed period whether or not anyone is there.
 */

import { describe, expect, it } from 'vitest';
import {
  BEACON_PERIOD,
  CAN_MAX_BOUNCES,
  CAN_RADIUS,
  CAPSULE_RADIUS,
  EV,
  SIM_STEP,
  SPEED_SPRINT,
} from '../src/core/const.js';
import type { SoundEvent } from '../src/core/events.js';
import type { MoveInput } from '../src/core/movement.js';
import { Sim } from '../src/core/sim.js';
import type { MapDef, Solid } from '../src/core/map/types.js';

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

/**
 * One plate, one can in the open, one chain curtain in a clear doorway and one beacon. Everything
 * is far enough apart that a test of any one of them cannot be hearing another.
 */
const yard: MapDef = {
  name: 'prop yard',
  solids: [box('floor', 'floor', 0, -1, 0, 80, 0, 80)],
  ladders: [],
  props: [
    { type: 'can', id: 'can', x: 12, y: 0, z: 10 },
    {
      type: 'chain',
      id: 'chain',
      min: [40, 0, 20],
      max: [41.6, 2.2, 20.4],
      thinAxis: 'z',
    },
    { type: 'beacon', id: 'beacon', x: 70, y: 1, z: 70 },
  ],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [10, 0, 10], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [80, 8, 80] }],
  markers: [],
  bounds: { min: [0, -1, 0], max: [80, 8, 80] },
};

const NEUTRAL: MoveInput = {
  forward: 0,
  right: 0,
  jumpPressed: false,
  crouch: false,
  sprint: false,
  yawDelta: 0,
  pitchDelta: 0,
};

interface Run {
  readonly sim: Sim;
  readonly events: SoundEvent[];
  drive(seconds: number, patch?: Partial<MoveInput>): void;
}

function yardRun(props: readonly string[]): Run {
  const sim = new Sim(yard, { props });
  const events: SoundEvent[] = [];
  sim.bus.on((e) => events.push(e));
  return {
    sim,
    events,
    drive(seconds: number, patch: Partial<MoveInput> = {}): void {
      const n = Math.round(seconds / SIM_STEP);
      for (let i = 0; i < n; i++) {
        Object.assign(sim.input, NEUTRAL, patch);
        sim.step(SIM_STEP);
      }
    },
  };
}

const knocks = (r: Run): SoundEvent[] => r.events.filter((e) => e.class === 'propKnock');

// ==========================================================================================
// Cans
// ==========================================================================================

describe('a kicked can (vision §8, §3.3)', () => {
  it('sounds where the tin is, paints inside its own row, and stops bouncing', () => {
    const r = yardRun(['can']);
    // Sprinting into it: a walk launches the tin too gently to clear the settle threshold, and
    // the point of this one is the bounce budget.
    r.drive(3, { forward: 1, sprint: true });
    const hits = knocks(r);
    expect(hits.length).toBeGreaterThan(1);

    for (const e of hits) {
      expect(e.source).toBe('prop');
      // Vision §3.3: prop knock is an 8–12 m paint, scaled by how hard it was hit. Nothing a can
      // does may take it outside the row it was authored with.
      expect(e.paintRadius).toBeGreaterThanOrEqual(EV.propKnock.paint - 1e-9);
      expect(e.paintRadius).toBeLessThanOrEqual(EV.propKnock.paintMax + 1e-9);
      expect(e.hearRadius).toBe(EV.propKnock.hear);
      // Off the floor plane, at the can's waist: an origin ON the plane paints neither side of it.
      expect(e.origin[1]).toBeGreaterThan(0);
    }

    // The kick plus at most CAN_MAX_BOUNCES landings — one kick is a bounded burst of paint, not
    // a rattling tail that keeps repainting the room.
    expect(hits.length).toBeLessThanOrEqual(1 + CAN_MAX_BOUNCES + 2);

    const can = r.sim.props.cans[0]!;
    expect(can.resting).toBe(true);
    // It went where the leg that hit it was going, and it is still on the floor.
    expect(can.x).toBeGreaterThan(12);
    expect(can.y).toBeCloseTo(0, 6);
  });

  it('is the same kick every time, and a harder one is a louder one', () => {
    const walk = yardRun(['can']);
    walk.drive(3, { forward: 1 });
    const again = yardRun(['can']);
    again.drive(3, { forward: 1 });
    const trace = (r: Run): string =>
      knocks(r)
        .map(
          (e) =>
            `${e.time.toFixed(6)}@${e.origin.map((v) => v.toFixed(6)).join(',')}:${e.paintRadius.toFixed(6)}`,
        )
        .join('|');
    expect(trace(again)).toBe(trace(walk));

    const sprint = yardRun(['can']);
    sprint.drive(3, { forward: 1, sprint: true });
    expect(sprint.sim.movement.speedXZ).toBeGreaterThan(0);
    // The first knock is the kick itself, and its paint is scaled by the impulse the body carried.
    const soft = knocks(walk)[0]!;
    const hard = knocks(sprint)[0]!;
    expect(hard.paintRadius).toBeGreaterThan(soft.paintRadius);
    expect(hard.intensity).toBeGreaterThan(soft.intensity);
    // A sprint is the top of the scale (SPEED_SPRINT), so the kick is the loud end of the row.
    expect(hard.paintRadius).toBeCloseTo(EV.propKnock.paintMax, 6);
    expect(SPEED_SPRINT).toBeGreaterThan(0);

    // And it travels further for it.
    expect(sprint.sim.props.cans[0]!.x).toBeGreaterThan(walk.sim.props.cans[0]!.x);
  });

  it('can be kicked again, from wherever it came to rest', () => {
    const r = yardRun(['can']);
    r.drive(3, { forward: 1 });
    const first = knocks(r).length;
    const restedAt = r.sim.props.cans[0]!.x;
    expect(r.sim.props.cans[0]!.resting).toBe(true);
    expect(restedAt).toBeGreaterThan(12);

    // Walk back up on it. The body has long since overtaken the tin, which is the whole reason a
    // kicked can re-arms only once nothing is touching it — a sprint that outruns a can must not
    // re-kick it every step it overlaps.
    r.sim.player.x = restedAt - 1.5;
    r.sim.player.z = r.sim.props.cans[0]!.z;
    r.sim.player.yaw = 0;
    r.drive(3, { forward: 1 });
    const second = knocks(r);
    expect(second.length).toBeGreaterThan(first);
    // The second kick came from where the tin actually was, not from where the map authored it.
    const reKick = second[first]!;
    expect(reKick.origin[0]).toBeGreaterThan(restedAt - 0.5);
    expect(r.sim.props.cans[0]!.x).toBeGreaterThan(restedAt);
  });

  it('stays silent for a body standing on it, and re-arms once that body is clear', () => {
    // Standing inside a can is silent by law, not by accident: the tin has no collision (vision §5
    // law 5 — nothing may tax movement) and a trap you are already standing in has nothing left to
    // tell anyone. What must never happen is a can staying disarmed forever because the body
    // lingered exactly on the contact boundary, so the re-arm is a margin rather than a boundary.
    const r = yardRun(['can']);
    const can = r.sim.props.cans[0]!;
    r.sim.player.x = can.x;
    r.sim.player.z = can.z;
    r.drive(1);
    expect(knocks(r).length).toBe(0);

    // The body is unmoved by the tin it is standing in — compared against a run with no can at all.
    const bare = yardRun([]);
    bare.sim.player.x = can.x;
    bare.sim.player.z = can.z;
    bare.drive(1);
    expect([r.sim.player.x, r.sim.player.y, r.sim.player.z]).toEqual([
      bare.sim.player.x,
      bare.sim.player.y,
      bare.sim.player.z,
    ]);

    // Walk away and come back: clear of the margin, the can is armed again and sounds.
    r.sim.player.x = can.x - 2;
    r.sim.player.z = can.z;
    r.sim.player.yaw = 0;
    r.drive(2, { forward: 1 });
    expect(knocks(r).length).toBeGreaterThan(0);
  });

  it('re-arms on a margin, never on the contact boundary itself', () => {
    // The latch is what makes a can one trap rather than a rattle: it disarms on the kick and may
    // only come back once the body is properly clear. Re-arming exactly at contact range would let
    // a body loitering on that boundary flicker the latch on the sign of a float. The latch itself
    // is internal — nothing outside props.ts may act on it — so it is read here directly.
    const r = yardRun(['can']);
    const can = r.sim.props.cans[0]!;
    const latch = can as unknown as { armed: boolean };
    const reach = CAPSULE_RADIUS + CAN_RADIUS;

    // Kick it, then stop the clock the instant the tin settles: a can in flight has no latch to
    // read, and the first resting step is the one that decides.
    r.sim.player.x = can.x - 1.2;
    r.sim.player.z = can.z;
    r.sim.player.yaw = 0;
    for (let i = 0; i < Math.round(4 / SIM_STEP) && !(knocks(r).length > 0 && can.resting); i++) {
      r.drive(SIM_STEP, { forward: 1 });
    }
    expect(knocks(r).length).toBeGreaterThan(0);
    expect(latch.armed).toBe(false);

    // Standing a hair outside contact is not clear: the latch holds.
    r.sim.player.x = can.x - (reach + 0.05);
    r.sim.player.z = can.z;
    r.drive(SIM_STEP);
    expect(latch.armed).toBe(false);

    // A step further and the body is genuinely away from the tin, so the trap is set again.
    r.sim.player.x = can.x - (reach + 0.5);
    r.drive(SIM_STEP);
    expect(latch.armed).toBe(true);
  });

  it('never touches the body that kicked it (vision §5)', () => {
    const withCan = yardRun(['can']);
    const without = yardRun([]);
    const pose = (r: Run): string => {
      const p = r.sim.player;
      return [p.x, p.y, p.z, p.vx, p.vy, p.vz].map((v) => v.toFixed(9)).join(',');
    };
    for (let i = 0; i < Math.round(3 / SIM_STEP); i++) {
      withCan.drive(SIM_STEP, { forward: 1, sprint: true });
      without.drive(SIM_STEP, { forward: 1, sprint: true });
      // Step by step, not just at the end: a nudge that cancelled itself out would still be a
      // nudge, and vision §5 does not allow one.
      expect(pose(withCan)).toBe(pose(without));
    }
    expect(knocks(withCan).length).toBeGreaterThan(0);
    expect(withCan.sim.player.stance).toBe(without.sim.player.stance);
  });

  it('a can nobody asked for is not in the world at all', () => {
    const r = yardRun([]);
    expect(r.sim.props.cans.length).toBe(0);
    r.drive(3, { forward: 1 });
    expect(knocks(r).length).toBe(0);
  });
});

// ==========================================================================================
// Chain curtains
// ==========================================================================================

describe('a chain curtain (vision §8, §3.3)', () => {
  /** Walk the body through the curtain at (40.8, 20.2) from the south. */
  function cross(patch: Partial<MoveInput>, seconds = 3): Run {
    const r = yardRun(['chain']);
    const p = r.sim.player;
    p.x = 40.8;
    p.z = 17.5;
    p.yaw = Math.PI / 2;
    r.drive(seconds, { forward: 1, ...patch });
    return r;
  }
  const rattles = (r: Run): SoundEvent[] => r.events.filter((e) => e.class === 'chainRattle');

  it('rattles once per crossing — not once per step spent in the doorway', () => {
    const r = cross({});
    expect(rattles(r).length).toBe(1);
    expect(r.sim.player.z).toBeGreaterThan(20.4);
  });

  it('rattles again on the way back — one crisp signature per crossing, whatever the route', () => {
    // Vision §8: one trap, one signature. Through and back is two events, both on the curtain
    // plane and both from the prop rather than from the body.
    const r = yardRun(['chain']);
    const p = r.sim.player;
    p.x = 40.8;
    p.z = 17.5;
    p.yaw = Math.PI / 2;
    r.drive(2, { forward: 1 });
    p.yaw = -Math.PI / 2;
    r.drive(2, { forward: 1 });
    expect(rattles(r).length).toBe(2);
    for (const e of rattles(r)) {
      expect(e.origin[2]).toBeCloseTo(20.2, 6);
      expect(e.source).toBe('prop');
    }

    // …and it stays one-per-crossing under a route that keeps reversing through the doorway. The
    // count is not a tuning value: rattles equal committed crossings, however the body arrives.
    const w = yardRun(['chain']);
    w.sim.player.x = 40.8;
    w.sim.player.z = 21.7;
    let prev = 1;
    let crossings = 0;
    for (let i = 0; i < Math.round(6 / SIM_STEP); i++) {
      w.sim.player.yaw = Math.floor(i / Math.round(0.75 / SIM_STEP)) % 2 === 0 ? -Math.PI / 2 : Math.PI / 2;
      w.drive(SIM_STEP, { forward: 1 });
      const across = w.sim.player.z - 20.2;
      // Committed: measured well clear of the latch's deadband, so this counts traversals and
      // not float noise on the plane.
      if (Math.abs(across) < 0.3) continue;
      const side = across > 0 ? 1 : -1;
      if (side !== prev) crossings++;
      prev = side;
    }
    expect(crossings).toBeGreaterThan(2);
    expect(rattles(w).length).toBe(crossings);
  });

  it('holds its latch while the body straddles the plane, and never machine-guns', () => {
    // The rattle carries 25 m (vision §3.3), so what the latch must not do is fire on the sign of
    // a float. A body dithering across the plane by less than the deadband is the case a future
    // knockback or a teleport can produce; today's movement cannot, which is why it is pinned.
    const r = yardRun(['chain']);
    const p = r.sim.player;
    p.x = 40.8;
    for (let i = 0; i < 60; i++) {
      p.z = 20.2 + (i % 2 === 0 ? 0.03 : -0.03);
      r.drive(SIM_STEP);
    }
    expect(rattles(r).length).toBe(0);

    // A committed crossing through the same doorway still sounds exactly once.
    p.z = 20.9;
    r.drive(SIM_STEP);
    p.z = 19.5;
    r.drive(SIM_STEP);
    expect(rattles(r).length).toBe(1);
  });

  it('answers to the gait you are actually travelling at, not to the key you are holding', () => {
    expect(rattles(cross({})).length).toBe(1);
    expect(rattles(cross({}))[0]!.variant).toBe('loud');
    expect(rattles(cross({ sprint: true }))[0]!.variant).toBe('loud');
    // Crouching through is the authored answer, and it is a different row of the §3.3 table.
    const quiet = rattles(cross({ crouch: true }, 5))[0]!;
    expect(quiet.variant).toBe('quiet');
    expect(quiet.paintRadius).toBe(EV.chainRattleQuiet.paint);
    expect(quiet.hearRadius).toBe(EV.chainRattleQuiet.hear);
    expect(rattles(cross({}))[0]!.paintRadius).toBe(EV.chainRattleLoud.paint);
  });

  it('sounds in the doorway it hangs in, and sways for having been touched', () => {
    // Short run: the sway is 1.5 s of dressing and it is read while it is still there.
    const r = cross({}, 1.2);
    const e = rattles(r)[0]!;
    // The origin is on the curtain plane, at body height inside the opening — never at the body.
    expect(e.origin[2]).toBeCloseTo(20.2, 6);
    expect(e.origin[0]).toBeGreaterThanOrEqual(40);
    expect(e.origin[0]).toBeLessThanOrEqual(41.6);
    expect(e.origin[1]).toBeGreaterThan(0);
    expect(e.origin[1]).toBeLessThanOrEqual(2.2);
    expect(r.sim.props.chains[0]!.sway).toBeGreaterThan(0);
  });

  it('says nothing for a body that walks past the opening instead of through it', () => {
    const r = yardRun(['chain']);
    const p = r.sim.player;
    p.x = 44;
    p.z = 17.5;
    p.yaw = Math.PI / 2;
    r.drive(3, { forward: 1 });
    expect(p.z).toBeGreaterThan(20.4);
    expect(rattles(r).length).toBe(0);
  });
});

// ==========================================================================================
// The beacon
// ==========================================================================================

describe('the objective hum (vision §7)', () => {
  it('beats on the period, on sim time, with no beat at zero', () => {
    const r = yardRun(['beacon']);
    r.drive(BEACON_PERIOD - 2 * SIM_STEP);
    expect(r.sim.bus.counts.beaconHum).toBe(0);

    r.drive(3 * BEACON_PERIOD);
    const hums = r.events.filter((e) => e.class === 'beaconHum');
    expect(hums.length).toBe(3);
    for (let i = 0; i < hums.length; i++) {
      // The clock is the bus's, so a beat lands on the first step at or past its own instant.
      expect(hums[i]!.time).toBeGreaterThanOrEqual(BEACON_PERIOD * (i + 1));
      expect(hums[i]!.time).toBeLessThan(BEACON_PERIOD * (i + 1) + SIM_STEP + 1e-9);
      expect(hums[i]!.source).toBe('objective');
      expect(hums[i]!.origin).toEqual([70, 1, 70]);
    }
    // The clock advances by += PERIOD rather than from "now", so the step quantisation never
    // accumulates: three beats apart is exactly two periods apart, not two periods plus drift.
    expect(Math.abs(hums[2]!.time - hums[0]!.time - 2 * BEACON_PERIOD)).toBeLessThan(SIM_STEP + 1e-9);
  });

  it('hums whether or not anyone is there, and not at all when it is not in the roster', () => {
    const on = yardRun(['beacon']);
    on.drive(BEACON_PERIOD + SIM_STEP);
    expect(on.sim.bus.counts.beaconHum).toBe(1);
    // Nothing moved, nobody listened, and it beat anyway: it is the one emitter with no cause.
    expect(on.sim.player.x).toBeCloseTo(10, 9);

    const off = yardRun([]);
    off.drive(3 * BEACON_PERIOD);
    expect(off.sim.bus.counts.beaconHum).toBe(0);
  });
});
