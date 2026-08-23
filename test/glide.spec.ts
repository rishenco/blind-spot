/**
 * The mantle / vault glide, which is authored rather than simulated.
 *
 * Contract under test:
 *   movement.ts  "The glide is authored, not simulated: rise first, THEN step in… Nothing
 *                simulates this path, so its shape IS its collision model; the verb additionally
 *                validates the whole arc up front (`arcClear`) before committing to it."
 *   vision §1.2  "The system never lies. Every blip and sound has a real physical source."
 *   vision §3.1  without sound you perceive only contact geometry — a shell within 2 m of your
 *                body. Putting the body (and the eye) inside a solid is the one state that shell
 *                cannot describe.
 *   vision §5    mantle ≤ 2.2 m; movement stays genuinely good (a vault keeps your speed).
 *
 * Review finding B4. The old curve started translating forward at t 0.25 while the body was only
 * ~28 % of the way up, which swept the capsule through the face of the very ledge it was climbing
 * on 700 of the sample map's 1595 legal mantles (worst case: 48 % of the glide spent inside
 * matter). The ruled fix has two halves and both are pinned below:
 *   1. reshape — the ascent finishes before the translation begins (GLIDE_Y_END 0.5,
 *      GLIDE_XZ_START 0.5), which alone takes 700 clips down to 56;
 *   2. pre-validate — `arcClear` samples the WHOLE arc before the verb commits, and a blocked arc
 *      is REFUSED outright rather than aborted mid-glide, which takes the remaining 56 to 0.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPSULE_RADIUS,
  COYOTE_TIME,
  EYE_STAND,
  GLIDE_ARC_SAMPLES,
  GLIDE_XZ_START,
  GLIDE_Y_END,
  HEIGHT_STAND,
  MANTLE_MAX_HEIGHT,
  MANTLE_MIN_HEIGHT,
  MANTLE_SCAN_AHEAD,
  SIM_STEP,
  SPEED_SPRINT,
  SPEED_WALK,
  VAULT_MAX_HEIGHT,
} from '../src/core/const.js';
import { lerp, smoothstep } from '../src/core/math.js';
import { buildWorld, capsuleOverlaps, ledgeProbe, type World } from '../src/core/map/build.js';
import { sampleMap } from '../src/core/map/sampleMap.js';
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
 * Synthetic gym, west to east:
 *   x 10..13  ledge   2 m, with an awning hanging over its APPROACH (not over its top — the top
 *                     is what `ledgeProbe` checks, and it is clear). The refusal case.
 *   x 20..23  clean   the same 2 m ledge with nothing overhead. The acceptance case.
 *   x 30..32  crate   1 m, knee-high: the automatic vault.
 *   x 50..53  toohigh 4.5 m: out of reach even at the top of a jump.
 */
const gym: MapDef = {
  name: 'glide gym',
  solids: [
    box('floor', 'floor', 0, -1, 0, 80, 0, 80),
    box('ledge', 'machine', 10, 0, 10, 13, 2.0, 16),
    box('awning', 'ceiling', 6, 2.5, 10, 10, 4.6, 16),
    box('clean', 'machine', 20, 0, 10, 23, 2.0, 16),
    box('crate', 'crate', 30, 0, 10, 32, 1.0, 16),
    box('toohigh', 'wall', 50, 0, 10, 53, 4.5, 16),
  ],
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [2, 0, 13], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [80, 16, 80] }],
  markers: [],
  bounds: { min: [0, -1, 0], max: [80, 16, 80] },
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

const steps = (s: number): number => Math.round(s / SIM_STEP);

function place(sim: Sim, x: number, y: number, z: number, yaw = 0): void {
  const p = sim.player;
  p.x = x;
  p.y = y;
  p.z = z;
  p.yaw = yaw;
  p.vx = p.vy = p.vz = 0;
  p.grounded = true;
  p.stance = 'stand';
  sim.movement.apexY = y;
  sim.movement.coyote = COYOTE_TIME;
  sim.bus.reset();
}

/** Run a glide to completion, sampling whether the body is inside matter on every frame. */
function glideTrace(
  sim: Sim,
  world: World,
  patch: Partial<MoveInput>,
  maxSeconds = 2,
): { started: boolean; framesInside: number; deepestEye: number; frames: number } {
  const p = sim.player;
  let started = false;
  let framesInside = 0;
  let deepestEye = 0;
  let frames = 0;
  for (let i = 0; i < steps(maxSeconds); i++) {
    Object.assign(sim.input, NEUTRAL, patch);
    sim.step(SIM_STEP);
    if (sim.movement.mantling) {
      started = true;
      frames++;
      if (capsuleOverlaps(world, p.x, p.y, p.z, CAPSULE_RADIUS, HEIGHT_STAND)) {
        framesInside++;
        deepestEye = Math.max(deepestEye, eyeDepth(world, p.x, p.y + EYE_STAND, p.z));
      }
    } else if (started) {
      break;
    }
  }
  return { started, framesInside, deepestEye, frames };
}

/** How far below a solid's top face the eye point sits, 0 if the eye is in open air. */
function eyeDepth(world: World, x: number, y: number, z: number): number {
  let worst = 0;
  for (const s of world.solids) {
    if (y <= s.minY || y >= s.maxY) continue;
    const inside =
      s.shape === 'cyl'
        ? Math.hypot(x - s.cx, z - s.cz) < s.r
        : x > s.minX && x < s.maxX && z > s.minZ && z < s.maxZ;
    if (inside) worst = Math.max(worst, Math.min(y - s.minY, s.maxY - y));
  }
  return worst;
}

/**
 * The authored arc, sampled `n` times — the same two smoothsteps `stepGlide` walks, read from the
 * same const.ts knobs, so a curve change cannot silently drift away from this file. At
 * n = GLIDE_ARC_SAMPLES this is exactly what `arcClear` computes.
 */
function arcFramesInside(
  world: World,
  fx: number,
  fy: number,
  fz: number,
  tx: number,
  ty: number,
  tz: number,
  n: number,
): number {
  let inside = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const txz = smoothstep(GLIDE_XZ_START, 1, t);
    const tyy = smoothstep(0, GLIDE_Y_END, t);
    const x = lerp(fx, tx, txz);
    const y = lerp(fy, ty, tyy);
    const z = lerp(fz, tz, txz);
    if (capsuleOverlaps(world, x, y, z, CAPSULE_RADIUS, HEIGHT_STAND)) inside++;
  }
  return inside;
}

interface SweepRow {
  legal: number;
  accepted: number;
  refused: number;
  /** Accepted by the 16-sample `arcClear` but caught by a 200-sample replay. */
  acceptedButDirty: number;
  worstAcceptedFraction: number;
  byAffordance: Map<string, { accepted: number; refused: number }>;
}

/**
 * Every mantle the controller would accept, from every standable spot on every walkable top of
 * `map`, at 12 headings — the reviewer's sweep, replayed against the shipped curve and the
 * shipped acceptance test.
 */
function sweep(map: MapDef): SweepRow {
  const world = buildWorld(map);
  const row: SweepRow = {
    legal: 0,
    accepted: 0,
    refused: 0,
    acceptedButDirty: 0,
    worstAcceptedFraction: 0,
    byAffordance: new Map(),
  };
  for (const w of world.walkables) {
    for (let x = w.minX + 0.2; x <= w.maxX - 0.2; x += 0.4) {
      for (let z = w.minZ + 0.2; z <= w.maxZ - 0.2; z += 0.4) {
        if (capsuleOverlaps(world, x, w.y + 1e-3, z, CAPSULE_RADIUS, HEIGHT_STAND)) continue;
        for (let a = 0; a < 12; a++) {
          const yaw = (a / 12) * Math.PI * 2;
          const hit = ledgeProbe(
            world,
            x,
            w.y,
            z,
            Math.cos(yaw),
            Math.sin(yaw),
            CAPSULE_RADIUS,
            HEIGHT_STAND,
            { ahead: MANTLE_SCAN_AHEAD, minHeight: MANTLE_MIN_HEIGHT, maxHeight: MANTLE_MAX_HEIGHT },
          );
          if (!hit) continue;
          row.legal++;
          const tally = row.byAffordance.get(hit.solid.id) ?? { accepted: 0, refused: 0 };
          row.byAffordance.set(hit.solid.id, tally);
          // What the verb itself decides: GLIDE_ARC_SAMPLES points along the arc.
          const cheap = arcFramesInside(world, x, w.y, z, hit.x, hit.topY, hit.z, GLIDE_ARC_SAMPLES);
          if (cheap > 0) {
            row.refused++;
            tally.refused++;
            continue;
          }
          row.accepted++;
          tally.accepted++;
          // …and what a 200-sample replay of the same arc says about the ones it let through.
          const fine = arcFramesInside(world, x, w.y, z, hit.x, hit.topY, hit.z, 200);
          if (fine > 0) {
            row.acceptedButDirty++;
            row.worstAcceptedFraction = Math.max(row.worstAcceptedFraction, fine / 200);
          }
        }
      }
    }
  }
  return row;
}

// ==========================================================================================
// The arc is checked, not just its endpoint (review finding B4)
// ==========================================================================================

describe('the mantle glide never sweeps the body through solid matter (vision §1.2)', () => {
  it('refuses a ledge whose approach is roofed, and leaves the player standing where they were', () => {
    // The awning hangs at 2.5 m over the floor west of the 2 m `ledge`: a standing body fits on
    // TOP of the ledge (which is all `ledgeProbe` ever promised), but not in the airspace the
    // ascent has to pass through. B4 says refuse it, and refuse it BEFORE committing.
    const sim = new Sim(gym);
    place(sim, 9.5, 0, 13, 0);
    let everMantled = false;
    let everInside = false;
    let topY = 0;
    for (let i = 0; i < steps(2); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, jumpPressed: true });
      sim.step(SIM_STEP);
      const p = sim.player;
      everMantled ||= sim.movement.mantling;
      everInside ||= capsuleOverlaps(sim.world, p.x, p.y, p.z, CAPSULE_RADIUS, sim.movement.height);
      topY = Math.max(topY, p.y);
    }
    expect(everMantled, 'a roofed approach must not start a glide at all').toBe(false);
    expect(everInside, 'and refusing must not put the body in the awning either').toBe(false);
    expect(topY, 'never got up onto the ledge').toBeLessThan(2);
    // Refused, not aborted: the player is standing at the wall with the verb idle, free to jump,
    // back off or go around — not dropped out of a half-played animation.
    expect(sim.movement.hands).toBe('none');
    expect(sim.player.x).toBeLessThan(10);
  });

  it('accepts the same ledge with clear air above it, and never enters a solid on the way', () => {
    const sim = new Sim(gym);
    place(sim, 19.5, 0, 13, 0);
    const t = glideTrace(sim, sim.world, { forward: 1, jumpPressed: true });
    expect(t.started, 'expected the mantle to trigger').toBe(true);
    expect(t.frames).toBeGreaterThan(10); // a real glide, not a one-frame teleport
    expect(t.framesInside, `${t.framesInside}/${t.frames} glide frames inside a solid`).toBe(0);
    expect(sim.player.y).toBeCloseTo(2.0, 2);
  });

  it('climbs the sample map machinery row cleanly (the Lantern listening post)', () => {
    // machinery-row is `box('machinery-row', 'machine', 4, 0, 24, 20, 2.2, 26)` — the top at
    // exactly the 2.2 m mantle limit, and the same climb verify.mjs drives in its `script2`
    // capture. It used to put the eye up to 0.6 m inside the machine.
    const sim = new Sim(sampleMap);
    place(sim, 3.4, 0, 24.6, 0); // on the floor, facing +x into the machine's west face
    const t = glideTrace(sim, sim.world, { forward: 1, jumpPressed: true });
    expect(t.started, 'expected the mantle to trigger').toBe(true);
    expect(
      t.framesInside,
      `${t.framesInside}/${t.frames} glide frames inside, eye up to ${t.deepestEye.toFixed(2)} m in`,
    ).toBe(0);
  });

  it('no accepted mantle anywhere on the sample map penetrates (1595-candidate sweep)', () => {
    const row = sweep(sampleMap);
    expect(row.legal, 'the sweep really did find mantles to test').toBeGreaterThan(1000);
    // The headline: nothing the verb commits to ever touches matter.
    expect(
      row.acceptedButDirty,
      `${row.acceptedButDirty}/${row.accepted} accepted mantles clip; ` +
        `worst spends ${(row.worstAcceptedFraction * 100).toFixed(0)} % of the glide inside`,
    ).toBe(0);
    // …and the price of that is small: the refusals are genuine low awnings, not a broken verb.
    expect(row.refused / row.legal, `${row.refused}/${row.legal} refused`).toBeLessThan(0.05);
  });

  it('the 16-sample arcClear is as strong as a 200-sample replay on the sample map', () => {
    // `arcClear` is run inside the verb, on the frame the player presses jump, so its sample count
    // is a budget decision. This pins that GLIDE_ARC_SAMPLES is not too coarse for the shipped
    // geometry: every arc the cheap test accepts survives a 12x finer replay.
    const row = sweep(sampleMap);
    expect(row.acceptedButDirty).toBe(0);
    expect(GLIDE_ARC_SAMPLES).toBeGreaterThanOrEqual(16);
  });

  it('every named affordance on the sample map is still mantle-able', () => {
    // A refusal test that refuses everything would also pass the sweep above. These are the
    // affordances the map is built around, and each must still accept mantles from real ground.
    const row = sweep(sampleMap);
    for (const id of ['machinery-row', 'crate-stack', 'beacon-pedestal', 'gantry-beam', 'high-shelf']) {
      const tally = row.byAffordance.get(id);
      expect(tally, `${id} was never a mantle target at all`).toBeDefined();
      expect(tally!.accepted, `${id}: ${tally!.accepted} accepted / ${tally!.refused} refused`).toBeGreaterThan(0);
    }
    // The 2.2 m row and the crate stack carry the two headline climbs, so they get a floor.
    expect(row.byAffordance.get('machinery-row')!.accepted).toBeGreaterThan(100);
    expect(row.byAffordance.get('machinery-row')!.refused).toBe(0);
    expect(row.byAffordance.get('crate-stack')!.accepted).toBeGreaterThan(100);
  });
});

// ==========================================================================================
// What the verb guarantees once it has committed
// ==========================================================================================

describe('the guarantees ledgeProbe and the glide really do provide', () => {
  it('always lands on a pose that is clear, on the sample map and in the gym', () => {
    for (const [map, start] of [
      [gym, [19.5, 0, 13]],
      [sampleMap, [3.4, 0, 24.6]],
    ] as Array<[MapDef, [number, number, number]]>) {
      const sim = new Sim(map);
      const world = sim.world;
      place(sim, start[0], start[1], start[2], 0);
      glideTrace(sim, world, { forward: 1, jumpPressed: true });
      const p = sim.player;
      expect(sim.movement.mantling).toBe(false);
      expect(capsuleOverlaps(world, p.x, p.y, p.z, CAPSULE_RADIUS, sim.movement.height), map.name).toBe(
        false,
      );
      expect(p.grounded, map.name).toBe(true);
    }
  });

  it('refuses a ledge above MANTLE_MAX_HEIGHT, even at the top of a jump (vision §5)', () => {
    // 4.5 m: out of reach from the floor (4.5 m) AND from the jump apex (~3.4 m above the feet).
    const sim = new Sim(gym);
    place(sim, 48.5, 0, 13, 0);
    for (let i = 0; i < steps(3); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true, jumpPressed: true });
      sim.step(SIM_STEP);
      expect(sim.movement.mantling, `frame ${i}`).toBe(false);
    }
    expect(sim.player.x).toBeLessThan(50); // still on the near side of the wall
  });

  it('vaults a knee-high crate automatically, and needs a jump for the 2 m ledge', () => {
    const auto = new Sim(gym);
    place(auto, 28.5, 0, 13, 0);
    let vaulted = false;
    let onTop = 0;
    let exitSpeed = 0;
    for (let i = 0; i < steps(2); i++) {
      Object.assign(auto.input, NEUTRAL, { forward: 1, sprint: true }); // no jump at all
      const wasVaulting = auto.movement.hands === 'vault';
      auto.step(SIM_STEP);
      if (auto.movement.hands === 'vault') vaulted = true;
      if (wasVaulting && auto.movement.hands === 'none') exitSpeed = auto.movement.speedXZ;
      onTop = Math.max(onTop, auto.player.y);
    }
    expect(vaulted, 'a <=1.2 m ledge is automatic').toBe(true);
    expect(onTop).toBeGreaterThan(VAULT_MAX_HEIGHT - 0.3); // it really did put us on the 1.0 m top
    // Law 5: a knee-high crate must not confiscate a sprint.
    expect(exitSpeed).toBeGreaterThan(SPEED_SPRINT * 0.8);

    const manual = new Sim(gym);
    place(manual, 19.5, 0, 13, 0);
    for (let i = 0; i < steps(2); i++) {
      Object.assign(manual.input, NEUTRAL, { forward: 1, sprint: true }); // no jump
      manual.step(SIM_STEP);
      expect(manual.movement.hands).not.toBe('mantle');
    }
    expect(manual.player.y).toBeLessThan(0.01); // ran into it and stopped, as designed
  });

  it('a mantle taken on the run exits at exactly SPEED_WALK', () => {
    const sim = new Sim(gym);
    place(sim, 16.5, 0, 13, 0);
    // Sprint at the ledge and press jump on the frame the probe can first see it — the way the
    // verb is meant to be used. `speed` is then the live sprint, capped to a walk on exit.
    for (let i = 0; i < steps(2); i++) {
      Object.assign(sim.input, NEUTRAL, {
        forward: 1,
        sprint: true,
        jumpPressed: sim.player.x > 18.7,
      });
      sim.step(SIM_STEP);
      if (sim.movement.hands === 'mantle') break;
    }
    expect(sim.movement.mantling).toBe(true);
    glideTrace(sim, sim.world, { forward: 1, sprint: true });
    expect(sim.player.y).toBeCloseTo(2.0, 2); // stood on the 2 m ledge
    expect(sim.movement.speedXZ).toBeCloseTo(SPEED_WALK, 3);
    expect(SPEED_SPRINT).toBeGreaterThan(SPEED_WALK); // so the cap really is a tax
  });

  it('a mantle taken LATE still exits at SPEED_WALK (review finding S5: the approach latch)', () => {
    // `approachSpeed` used to be `blockedForward ? approach : 0`, re-sampled every frame, so one
    // frame after contact the wall had already eaten the run and `approach` was a single tick of
    // ground accel: a player who ran into a crate and THEN decided to climb it was put on top at
    // 0.67 m/s, a fifth of a walk. S5 latches the approach for APPROACH_LATCH_TIME after contact,
    // and the latch refreshes while you keep pushing — so hesitating costs nothing.
    for (const lateFrames of [1, 2, 5, 11, 12, 13, 20]) {
      const sim = new Sim(gym);
      place(sim, 16.5, 0, 13, 0);
      // Run in without jumping until the wall stops the body…
      for (let i = 0; i < steps(1); i++) {
        Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true });
        sim.step(SIM_STEP);
      }
      expect(sim.player.x, `${lateFrames} frames late`).toBeGreaterThan(19.5); // pressed against the face
      // …then hesitate, still leaning on it, before deciding to climb.
      for (let i = 0; i < lateFrames; i++) {
        Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true });
        sim.step(SIM_STEP);
      }
      glideTrace(sim, sim.world, { forward: 1, sprint: true, jumpPressed: true });
      expect(sim.player.y, `${lateFrames} frames late`).toBeCloseTo(2.0, 2);
      expect(sim.movement.speedXZ, `${lateFrames} frames late`).toBeCloseTo(SPEED_WALK, 3);
    }
  });
});
