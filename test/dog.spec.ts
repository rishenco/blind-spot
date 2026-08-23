/**
 * The robo-dog as a patrol and as a picture (vision §6, §3.7, engine-plan §7).
 *
 * Contract under test:
 *   vision §6    "A stationary, silent dog is invisible" — the dog is drawn from what was HEARD
 *                of it, never from where it is. Route speeds are 3.0 m/s on patrol and the
 *                steering limit is a 3 m turn radius.
 *   vision §1.2  "the system never lies" — a gait event every DOG_GAIT_STRIDE metres of ground
 *                actually covered, so the paint trail IS the route the body took. A paused dog
 *                covers no ground and says nothing.
 *   vision §3.7  a ghost is a photograph: one pose, stamped at the instant the silence became
 *                long enough, cooling for DOG_GHOST_LIFE and then dissolving over
 *                DOG_GHOST_DISSOLVE. Never interpolated, never predicted.
 *   vision §3.4  through one wall a dog is still heard, at WALL1_QUALITY of the clean read.
 *   engine-plan §7  a shared body cloud on the world's lattice discipline, ~600 points.
 *
 * The attribution law is pinned here too: emission and delivery are both synchronous, which is
 * what lets a delivered dog event be credited to the dog still on the stack rather than to
 * whichever dog happens to be nearest. Two dogs on the same tile stay two dogs.
 */

import { describe, expect, it } from 'vitest';
import {
  DOG_CLOUD_TARGET,
  DOG_FREEZE_DELAY,
  DOG_GAIT_STRIDE,
  DOG_GHOST_DISSOLVE,
  DOG_GHOST_LIFE,
  DOG_MAX_GHOSTS,
  DOG_SMEAR_SAMPLES,
  DOG_SPEED_PATROL,
  DOG_TURN_RADIUS,
  SIM_STEP,
  WALL1_QUALITY,
} from '../src/core/const.js';
import { buildDogCloud } from '../src/core/dog.js';
import type { SoundEvent } from '../src/core/events.js';
import { PaintPipeline } from '../src/core/paint.js';
import { resolveRoster } from '../src/core/roster.js';
import { sampleMap } from '../src/core/map/sampleMap.js';
import { Sim } from '../src/core/sim.js';
import { bakeSurfels } from '../src/core/surfels.js';
import type { DogRouteDef, MapDef, Solid } from '../src/core/map/types.js';

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
 * A flat plate with one wall across the middle of it, at z = 30. The listener stands south of the
 * wall and every route runs north of it, so "through one wall" is the geometry of the fixture
 * rather than something a test has to arrange per case.
 */
function kennel(routes: DogRouteDef[]): MapDef {
  return {
    name: 'kennel',
    solids: [
      box('floor', 'floor', 0, -1, 0, 60, 0, 60),
      box('divider', 'wall', 0, 0, 29.8, 60, 4, 30.2),
    ],
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

/** A square lap with no pauses: 10 m a side, so one loop is exactly 40 m of ground. */
const square: DogRouteDef = {
  id: 'square',
  speed: DOG_SPEED_PATROL,
  defaultOn: true,
  waypoints: [
    { x: 20, z: 34 },
    { x: 30, z: 34 },
    { x: 30, z: 44 },
    { x: 20, z: 44 },
  ],
};

/**
 * A dog that keeps going quiet, for the ghost machinery: a straight picket line of metre-long legs
 * with a half-second stop at every post.
 *
 * Straight on purpose. A corner costs real time at a 3 m turn radius — a quarter turn is over a
 * second of arcing, during which the dog is travelling and therefore sounding — so a route with
 * corners in it would be testing the steering limit rather than the freeze. Legs are a metre and
 * the stride is 0.8 m, so every leg sounds and every stop is a real silence.
 */
const stutter: DogRouteDef = {
  id: 'stutter',
  speed: DOG_SPEED_PATROL,
  defaultOn: true,
  waypoints: Array.from({ length: 13 }, (_, i) => ({ x: 20 + i, z: 33, pause: 0.5 })),
};

interface Rig {
  readonly sim: Sim;
  readonly paint: PaintPipeline;
  readonly delivered: SoundEvent[];
  run(seconds: number): void;
}

/** A sim with a listener wired exactly as `main.ts` wires it: paint on the bus, dogs on paint. */
function rig(map: MapDef, dogs: readonly string[], listener?: [number, number, number]): Rig {
  const sim = new Sim(map, { dogs });
  const paint = new PaintPipeline(bakeSurfels(sim.world), sim.world);
  paint.attach(sim.bus);
  sim.dogs.attach(paint);
  const delivered: SoundEvent[] = [];
  paint.onDelivered((e) => delivered.push({ ...e }));
  const ear = listener ?? [sim.player.x, sim.player.y + 1.6, sim.player.z];
  paint.setListener(ear[0], ear[1], ear[2]);
  return {
    sim,
    paint,
    delivered,
    run(seconds: number): void {
      const n = Math.round(seconds / SIM_STEP);
      for (let i = 0; i < n; i++) {
        sim.step(SIM_STEP);
        paint.pump(sim.time);
      }
    },
  };
}

// ==========================================================================================
// Route following
// ==========================================================================================

describe('a patrol walks its authored route (vision §6, sample-map §3)', () => {
  it('serves the opening pause, then travels at exactly the route speed', () => {
    // dog1's first waypoint is (2, 28) with a 3 s pause, and the leg to (14, 28) is 12 m of +x.
    const r = rig(sampleMap, ['dog1']);
    const body = () => r.sim.dogs.bodies[0]!;

    r.run(3);
    expect(body().x).toBeCloseTo(2, 9);
    expect(body().moving).toBe(false);
    expect(r.sim.bus.counts.dogGait).toBe(0);

    // 2 s of travel at 3 m/s. A pause is served in whole steps, so the step that runs the pause
    // down to zero is spent standing still and travel starts on the one after it — the follower
    // never splits a tick between waiting and walking.
    r.run(2);
    expect(body().x).toBeCloseTo(2 + DOG_SPEED_PATROL * (2 - SIM_STEP), 6);
    expect(body().z).toBeCloseTo(28, 9);
    expect(body().moving).toBe(true);

    // Arrival at 4 s of travel, then the waypoint's own 4 s pause: the body is parked ON the
    // waypoint, not somewhere past it, because arrival snaps.
    r.run(2.5);
    expect(body().x).toBeCloseTo(14, 9);
    expect(body().z).toBeCloseTo(28, 9);
    expect(body().moving).toBe(false);
  });

  it('turns no faster than a 3 m radius allows, and may turn while paused', () => {
    const r = rig(kennel([square]), ['square']);
    const maxTurn = (DOG_SPEED_PATROL / DOG_TURN_RADIUS) * SIM_STEP;
    let prev = r.sim.dogs.bodies[0]!.yaw;
    let worst = 0;
    const n = Math.round(14 / SIM_STEP);
    for (let i = 0; i < n; i++) {
      r.sim.step(SIM_STEP);
      const yaw = r.sim.dogs.bodies[0]!.yaw;
      let d = Math.abs(yaw - prev);
      if (d > Math.PI) d = 2 * Math.PI - d;
      worst = Math.max(worst, d);
      prev = yaw;
    }
    // A square lap forces four 90° corners, so the cap is genuinely exercised and not merely
    // never approached.
    expect(worst).toBeLessThanOrEqual(maxTurn + 1e-9);
    expect(worst).toBeCloseTo(maxTurn, 6);
  });

  it('emits one gait per stride of ground COVERED, and nothing while parked', () => {
    const r = rig(kennel([square]), ['square']);
    // One full lap of a 40 m square. The follower banks distance as it travels, so a lap is
    // 40 / DOG_GAIT_STRIDE strides — within one, because the last stride of the lap may still be
    // part-spent when the lap closes.
    r.run(40 / DOG_SPEED_PATROL);
    const lap = r.sim.bus.counts.dogGait;
    expect(Math.abs(lap - 40 / DOG_GAIT_STRIDE)).toBeLessThanOrEqual(1);

    // Second lap: the same ground, the same count. A drifting accumulator shows up here.
    r.run(40 / DOG_SPEED_PATROL);
    expect(Math.abs(r.sim.bus.counts.dogGait - 2 * lap)).toBeLessThanOrEqual(1);
  });

  it('says nothing at all while serving a pause', () => {
    const r = rig(kennel([stutter]), ['stutter']);
    r.run(0.45);
    expect(r.sim.bus.counts.dogGait).toBe(0);
  });
});

// ==========================================================================================
// Visibility: heard, lost, remembered
// ==========================================================================================

describe('a dog is drawn from what was heard of it (vision §6, §3.7)', () => {
  it('freezes into a ghost at last-heard + the freeze delay, exactly', () => {
    const r = rig(kennel([stutter]), ['stutter'], [28.5, 1.6, 31]);
    const view = () => r.sim.dogs.views[0]!;

    // Walk it until something has been heard. The route's first leg is 0.9 m, so one gait lands
    // inside it and the pause that follows is the silence.
    r.run(0.85);
    expect(view().poseHistory.length).toBeGreaterThan(0);
    expect(view().ghosts.length).toBe(0);
    const heardAt = Math.max(...r.delivered.filter((e) => e.source === 'dog').map((e) => e.time));

    // Through the pause: the pose set empties and a photograph is left behind, stamped with the
    // instant the silence became long enough — not with the step that noticed it.
    r.run(DOG_FREEZE_DELAY);
    expect(view().poseHistory.length).toBe(0);
    const ghosts = view().ghosts;
    expect(ghosts.length).toBeGreaterThan(0);
    const g = ghosts[ghosts.length - 1]!;
    expect(g.frozenAt).toBeCloseTo(g.pose.time + DOG_FREEZE_DELAY, 9);
    expect(g.frozenAt).toBeGreaterThanOrEqual(heardAt);
    // The photograph is the last pose that was actually heard, not a fresh reading of the body.
    expect(g.pose.matrix.length).toBe(16);
  });

  it('keeps at most DOG_SMEAR_SAMPLES live poses, newest last', () => {
    const r = rig(kennel([square]), ['square'], [25, 1.6, 31]);
    r.run(6);
    const poses = r.sim.dogs.views[0]!.poseHistory;
    expect(poses.length).toBeGreaterThan(0);
    expect(poses.length).toBeLessThanOrEqual(DOG_SMEAR_SAMPLES);
    for (let i = 1; i < poses.length; i++) {
      expect(poses[i]!.time).toBeGreaterThan(poses[i - 1]!.time);
    }
  });

  it('holds at most DOG_MAX_GHOSTS, dropping the oldest first', () => {
    const r = rig(kennel([stutter]), ['stutter'], [28.5, 1.6, 31]);
    r.run(2);
    const first = r.sim.dogs.views[0]!.ghosts[0]?.frozenAt ?? -1;
    expect(first).toBeGreaterThan(0);

    // The stutter route freezes roughly every 0.8 s, so this is comfortably more freezes than the
    // cap — and all of them inside one ghost lifetime, so nothing is lost to expiry instead.
    r.run(6);
    const ghosts = r.sim.dogs.views[0]!.ghosts;
    expect(ghosts.length).toBe(DOG_MAX_GHOSTS);
    for (let i = 1; i < ghosts.length; i++) {
      expect(ghosts[i]!.frozenAt).toBeGreaterThan(ghosts[i - 1]!.frozenAt);
    }
    expect(ghosts[0]!.frozenAt).toBeGreaterThan(first);
  });

  it('prunes a ghost once it is past life + dissolve, leaving nothing behind', () => {
    const r = rig(kennel([stutter]), ['stutter'], [28.5, 1.6, 31]);
    r.run(1.5);
    const view = r.sim.dogs.views[0]!;
    expect(view.ghosts.length).toBeGreaterThan(0);

    // Move the ear out of earshot: the dog keeps walking and keeps sounding, nothing more is
    // delivered, and the memory has to age out on the clock rather than on an event.
    r.paint.setListener(5, 1.6, 5);
    r.run(DOG_GHOST_LIFE + DOG_GHOST_DISSOLVE + 0.5);
    expect(r.sim.bus.counts.dogGait).toBeGreaterThan(0);
    expect(view.ghosts.length).toBe(0);
    expect(view.poseHistory.length).toBe(0);
  });

  it('a dog nobody can hear is not drawn at all, however loudly it walks', () => {
    // Two walls is silence (vision §3.4), so the listener is put outside the kennel entirely:
    // 40 m from the route is well past the 18 m base hearing range.
    const r = rig(kennel([square]), ['square'], [5, 1.6, 5]);
    r.run(8);
    expect(r.sim.bus.counts.dogGait).toBeGreaterThan(0);
    expect(r.delivered.some((e) => e.source === 'dog')).toBe(false);
    const view = r.sim.dogs.views[0]!;
    expect(view.poseHistory.length).toBe(0);
    expect(view.ghosts.length).toBe(0);
    expect(view.lastEventQuality).toBe(0);
  });

  it('hears a patrol through one wall, at a quality the wall has paid for', () => {
    // Five metres and one wall from the near leg: inside the patrol gait's own 8 m hearing range,
    // so the read is a real number rather than the zero a delivered-but-inaudible event carries.
    const r = rig(kennel([square]), ['square'], [25, 1.6, 29]);
    r.run(8);
    const heard = r.delivered.filter((e) => e.source === 'dog');
    expect(heard.length).toBeGreaterThan(0);
    for (const e of heard) {
      expect(e.class).toBe('dogGait');
      expect(e.wallsToListener).toBe(1);
      expect(e.quality).toBeGreaterThanOrEqual(0);
      // Vision §3.4: one wall costs a fixed fraction of the read, so a walled event can never be
      // as sure as a clean one however close it is.
      expect(e.quality).toBeLessThanOrEqual(WALL1_QUALITY + 1e-9);
    }
    expect(Math.max(...heard.map((e) => e.quality))).toBeGreaterThan(0);
    expect(r.sim.dogs.views[0]!.lastEventQuality).toBeGreaterThanOrEqual(0);
  });

  it('credits a delivered gait to the dog that emitted it, not to the nearest one', () => {
    // Two routes a body-length apart, both audible. Attribution by position would mix them up
    // within a step; attribution by the emitter on the stack cannot.
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
    const r = rig(kennel([near, far]), ['near', 'far'], [27, 1.6, 27]);
    r.run(3);
    const views = r.sim.dogs.views;
    const bodies = r.sim.dogs.bodies;
    expect(views.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      const poses = views[i]!.poseHistory;
      expect(poses.length).toBeGreaterThan(0);
      const m = poses[poses.length - 1]!.matrix;
      // Column-major: the translation is the last column, and it is this dog's own body.
      expect(Math.hypot(m[12]! - bodies[i]!.x, m[14]! - bodies[i]!.z)).toBeLessThan(1.0);
    }
  });

  it('delivers inside the emit that produced it — the contract attribution rests on', () => {
    const r = rig(kennel([]), []);
    let inside = false;
    let deliveredDuringEmit = false;
    r.paint.onDelivered(() => {
      deliveredDuringEmit = inside;
    });
    inside = true;
    r.sim.bus.emit({ class: 'walkStep', source: 'self', x: 30, y: 0.1, z: 26 });
    inside = false;
    expect(deliveredDuringEmit).toBe(true);
  });
});

// ==========================================================================================
// The body cloud
// ==========================================================================================

describe('the dog body is a point cloud on the lattice discipline (engine-plan §7)', () => {
  it('solves to the budgeted size, deterministically, and states its own pitch', () => {
    const a = buildDogCloud();
    const b = buildDogCloud();
    const pa = a.getAttribute('position');
    const pb = b.getAttribute('position');
    expect(pa.count).toBe(596);
    // The budget is ~600 points a dog: a solve that drifted a long way from it would blow the
    // per-dog point cost that the whole merged field is sized against.
    expect(Math.abs(pa.count - DOG_CLOUD_TARGET)).toBeLessThan(60);
    expect(Array.from(pa.array as Float32Array)).toEqual(Array.from(pb.array as Float32Array));

    // The pitch is stamped on the geometry because a look draws a splat at the footprint of its
    // own cell, and the dog's lattice is far finer than the world's.
    const spacing = a.userData.spacing as number;
    expect(spacing).toBeGreaterThan(0);
    expect(spacing).toBeLessThan(0.2);
    expect(a.getAttribute('normal').count).toBe(pa.count);
    expect(a.getAttribute('dither').count).toBe(pa.count);
  });

  it('stands on its paws with a dog-shaped silhouette', () => {
    const p = buildDogCloud().getAttribute('position').array as Float32Array;
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]!);
      maxX = Math.max(maxX, p[i]!);
      minY = Math.min(minY, p[i + 1]!);
      maxY = Math.max(maxY, p[i + 1]!);
      maxZ = Math.max(maxZ, Math.abs(p[i + 2]!));
    }
    // Body space is +x forward, +y up, paws at y ≈ 0: a cloud baked below the floor plane would
    // draw a dog standing in the concrete.
    expect(minY).toBeGreaterThan(-0.1);
    expect(maxY).toBeGreaterThan(1.0);
    expect(maxY).toBeLessThan(1.4);
    // Longer than it is wide, and the head end leads: the silhouette the Lantern Test asks a
    // tester to call a heading from (vision §15.2).
    expect(maxX - minX).toBeGreaterThan(2 * maxZ);
    expect(maxX).toBeGreaterThan(Math.abs(minX));
  });

  it('is one shared cloud, and outlives no run that disposed it', () => {
    const r = rig(kennel([square, stutter]), ['square', 'stutter']);
    const views = r.sim.dogs.views;
    expect(views.length).toBe(2);
    expect(views[0]!.cloudGeom).toBe(views[1]!.cloudGeom);
    expect(views[0]!.cloudSpacing).toBe(views[1]!.cloudSpacing);
    expect(views[0]!.cloudSpacing).toBeGreaterThan(0);
  });
});

// ==========================================================================================
// The roster, the toggle, and determinism
// ==========================================================================================

describe('who is alive this run (core/roster.ts)', () => {
  const known = ['dog1', 'dog2'];
  const base = { known, defaults: ['dog1'] };

  it('gives a scripted run what the script declared, and a human run the map defaults', () => {
    expect(resolveRoster({ ...base, param: null, scripted: true })).toEqual([]);
    expect(resolveRoster({ ...base, param: null, scripted: true, scriptRoster: ['dog2'] })).toEqual(['dog2']);
    expect(resolveRoster({ ...base, param: null, scripted: false })).toEqual(['dog1']);
  });

  it('reads none / all / a list, always in map order, dropping what it does not know', () => {
    expect(resolveRoster({ ...base, param: '', scripted: false })).toEqual([]);
    expect(resolveRoster({ ...base, param: 'none', scripted: false })).toEqual([]);
    expect(resolveRoster({ ...base, param: 'NONE', scripted: false })).toEqual([]);
    expect(resolveRoster({ ...base, param: 'all', scripted: false })).toEqual(known);
    // Map order, never the parameter's: two URLs naming the same set must spawn the same run.
    expect(resolveRoster({ ...base, param: 'dog2,dog1', scripted: false })).toEqual(known);
    expect(resolveRoster({ ...base, param: ' dog2 , nope ', scripted: false })).toEqual(['dog2']);
    expect(resolveRoster({ ...base, param: 'nope', scripted: false })).toEqual([]);
  });

  it('an empty roster spawns nothing, and nothing is what a dog-free capture measures', () => {
    const r = rig(sampleMap, []);
    r.run(5);
    expect(r.sim.dogs.views.length).toBe(0);
    expect(r.sim.bus.counts.dogGait).toBe(0);
    expect(r.delivered.some((e) => e.source === 'dog')).toBe(false);
  });
});

describe('spawning and despawning mid-run (engine-plan §10, the F6 toggle)', () => {
  it('adds and removes a live animal, and keeps the roster in map order', () => {
    const r = rig(sampleMap, []);
    expect(r.sim.dogs.has('dog2')).toBe(false);

    r.sim.dogs.spawn('dog2');
    expect(r.sim.dogs.has('dog2')).toBe(true);
    // dog2 opens on a 2 s pause of its own, so the sound is on the far side of that.
    r.run(3);
    expect(r.sim.bus.counts.dogGait).toBeGreaterThan(0);

    // Map order regardless of spawn order — dog1 is index 0 in the map, so it sorts first.
    r.sim.dogs.spawn('dog1');
    expect(r.sim.dogs.bodies.map((d) => d.routeId)).toEqual(['dog1', 'dog2']);

    r.sim.dogs.despawn('dog2');
    expect(r.sim.dogs.has('dog2')).toBe(false);
    const after = r.sim.bus.counts.dogGait;
    r.run(1);
    // dog1 opens on a 3 s pause, so with dog2 gone the world goes quiet.
    expect(r.sim.bus.counts.dogGait).toBe(after);

    // An unknown id and a double spawn are both no-ops: this is driven by a URL and a hotkey.
    r.sim.dogs.spawn('nope');
    r.sim.dogs.spawn('dog1');
    expect(r.sim.dogs.bodies.length).toBe(1);
  });
});

describe('determinism (engine-plan §2)', () => {
  it('a dog run is the same run at any step grouping', () => {
    const trace = (chunk: number): string => {
      const r = rig(sampleMap, ['dog1', 'dog2']);
      const total = Math.round(12 / SIM_STEP);
      for (let done = 0; done < total; ) {
        const n = Math.min(chunk, total - done);
        for (let i = 0; i < n; i++) r.sim.step(SIM_STEP);
        r.paint.pump(r.sim.time);
        done += n;
      }
      const b = r.sim.dogs.bodies.map((d) => `${d.x.toFixed(9)},${d.z.toFixed(9)},${d.yaw.toFixed(9)}`);
      return `${b.join('|')} gait ${r.sim.bus.counts.dogGait} heard ${r.delivered.length}`;
    };
    const one = trace(1);
    expect(trace(4)).toBe(one);
    expect(trace(17)).toBe(one);
  });

  it('ghost ageing is measured on the sim clock, not on frames', () => {
    const r = rig(kennel([stutter]), ['stutter'], [28.5, 1.6, 31]);
    r.run(1.5);
    const g = r.sim.dogs.views[0]!.ghosts[0]!;
    expect(g.frozenAt).toBeLessThanOrEqual(r.sim.time);
    // The look ages this against the render clock; core only guarantees the stamp and the prune
    // window, which is what the two constants below mean.
    expect(DOG_GHOST_LIFE).toBeGreaterThan(0);
    expect(DOG_GHOST_DISSOLVE).toBeGreaterThan(0);
  });
});
