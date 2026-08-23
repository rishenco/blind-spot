/**
 * M2 ADVERSARIAL REVIEW — the mantle/vault glide, which is authored rather than simulated.
 *
 * Contract under test:
 *   movement.ts:584  "The glide is authored, not simulated: rise first, then step in.
 *                    `ledgeProbe` already proved a standing body fits on the destination, so the
 *                    only collision work left is a safety de-penetration on arrival."
 *   vision §1.2      "The system never lies. Every blip and sound has a real physical source."
 *   vision §3.1      without sound you perceive only contact geometry — a shell within 2 m of
 *                    your body. Putting the body (and the eye) inside a solid is the one state
 *                    that shell cannot describe.
 *   vision §5        mantle ≤ 2.2 m; movement stays genuinely good (a vault keeps your speed).
 *
 * Labels: PIN = passes today, pins verified-correct behaviour. BUG = fails today, on purpose.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPSULE_RADIUS,
  COYOTE_TIME,
  EYE_STAND,
  HEIGHT_STAND,
  MANTLE_MAX_HEIGHT,
  MANTLE_MIN_HEIGHT,
  MANTLE_SCAN_AHEAD,
  SIM_STEP,
  SPEED_SPRINT,
  SPEED_WALK,
  VAULT_MAX_HEIGHT,
} from '../../src/core/const.js';
import { lerp, smoothstep } from '../../src/core/math.js';
import { buildWorld, capsuleOverlaps, ledgeProbe, type World } from '../../src/core/map/build.js';
import { sampleMap } from '../../src/core/map/sampleMap.js';
import type { MoveInput } from '../../src/core/movement.js';
import { Sim } from '../../src/core/sim.js';
import type { MapDef, Solid } from '../../src/core/map/types.js';

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
 * Synthetic gym: a 2 m ledge to mantle, an awning hanging over the APPROACH (not over the
 * destination — the destination is what ledgeProbe checks), a knee-high crate to vault, and a
 * 3 m wall that must refuse both.
 */
const gym: MapDef = {
  name: 'review glide gym',
  solids: [
    box('floor', 'floor', 0, -1, 0, 80, 0, 80),
    box('ledge', 'machine', 10, 0, 10, 13, 2.0, 16),
    box('awning', 'ceiling', 6, 2.5, 10, 10, 4.6, 16),
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

// ==========================================================================================
// BUG — nothing checks the PATH, only the destination
// ==========================================================================================

describe('BUG · the mantle glide sweeps the body through solid matter (vision §1.2)', () => {
  /**
   * movement.ts:589-608 interpolates position with `smoothstep` and writes it straight onto the
   * player: y leads (smoothstep(0, 0.65, t)) and xz lags (smoothstep(0.25, 1, t)), with no
   * collision test anywhere until `resolvePenetration` on arrival at :613. `ledgeProbe` proved
   * the DESTINATION is clear; it says nothing about the 0.45 s of travel to reach it.
   */
  it('expected: the body never enters a solid — actual: a low awning over the approach is ignored', () => {
    const sim = new Sim(gym);
    const world = sim.world;
    place(sim, 9.5, 0, 13, 0);
    const t = glideTrace(sim, world, { forward: 1, jumpPressed: true });
    expect(t.started, 'expected the mantle to trigger').toBe(true);
    expect(t.framesInside, `${t.framesInside}/${t.frames} glide frames inside a solid`).toBe(0);
  });

  it('expected: the shipped sample map never does it — actual: mantling the machinery row does', () => {
    // machinery-row is `box('machinery-row', 'machine', 4, 0, 24, 20, 2.2, 26)` — the top at
    // exactly the 2.2 m mantle limit that sample-map calls "the Lantern listening post", and the
    // same climb verify.mjs drives in its `script2` capture.
    const sim = new Sim(sampleMap);
    place(sim, 3.4, 0, 24.6, 0); // on the floor, facing +x into the machine's west face
    const t = glideTrace(sim, sim.world, { forward: 1, jumpPressed: true });
    expect(t.started, 'expected the mantle to trigger').toBe(true);
    expect(
      t.framesInside,
      `${t.framesInside}/${t.frames} glide frames inside, eye up to ${t.deepestEye.toFixed(2)} m in`,
    ).toBe(0);
  });

  it('expected: no legal mantle on the sample map penetrates — actual: ~44 % of them do', () => {
    // Replays movement.ts:589-607 exactly (same two smoothsteps, same lerp) for every mantle the
    // controller would accept, from every standable spot on every walkable top.
    const world = buildWorld(sampleMap);
    let legal = 0;
    let penetrating = 0;
    let worstFraction = 0;
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
            legal++;
            let inside = 0;
            for (let i = 1; i <= 40; i++) {
              const t = i / 40;
              const px = lerp(x, hit.x, smoothstep(0.25, 1, t));
              const py = lerp(w.y, hit.topY, smoothstep(0, 0.65, t));
              const pz = lerp(z, hit.z, smoothstep(0.25, 1, t));
              if (capsuleOverlaps(world, px, py, pz, CAPSULE_RADIUS, HEIGHT_STAND)) inside++;
            }
            if (inside > 0) {
              penetrating++;
              worstFraction = Math.max(worstFraction, inside / 40);
            }
          }
        }
      }
    }
    expect(legal).toBeGreaterThan(1000); // the sweep really did find mantles to test
    expect(
      penetrating,
      `${penetrating}/${legal} legal mantles clip; worst spends ${(worstFraction * 100).toFixed(0)} % of the glide inside`,
    ).toBe(0);
  });
});

// ==========================================================================================
// PIN — what the glide does get right
// ==========================================================================================

describe('PIN · the guarantees ledgeProbe really does provide', () => {
  it('always lands on a pose that is clear, on the sample map and in the gym', () => {
    for (const map of [gym, sampleMap]) {
      const sim = new Sim(map);
      const world = sim.world;
      const start = map === gym ? ([9.5, 0, 13] as const) : ([3.4, 0, 24.6] as const);
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
    place(manual, 9.5, 0, 13, 0);
    for (let i = 0; i < steps(2); i++) {
      Object.assign(manual.input, NEUTRAL, { forward: 1, sprint: true }); // no jump
      manual.step(SIM_STEP);
      expect(manual.movement.hands).not.toBe('mantle');
    }
    expect(manual.player.y).toBeLessThan(0.01); // ran into it and stopped, as designed
  });

  it('a mantle taken on the run exits at exactly SPEED_WALK (movement.ts:546)', () => {
    const sim = new Sim(gym);
    place(sim, 6.5, 0, 13, 0);
    // Sprint at the ledge and press jump on the frame the probe can first see it — the way the
    // verb is meant to be used. `speed` is then the live sprint, capped to a walk on exit.
    for (let i = 0; i < steps(2); i++) {
      Object.assign(sim.input, NEUTRAL, {
        forward: 1,
        sprint: true,
        jumpPressed: sim.player.x > 8.7,
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

  it('NOTE · the same mantle taken a frame late exits at 0.67 m/s (approachSpeed decays in 1 tick)', () => {
    // movement.ts:404 — `approachSpeed = blockedForward ? approach : 0`, and `approach` is
    // re-sampled every frame. One frame after contact the wall has already eaten the run, so
    // `approach` is a single tick of ground accel. Recorded, not asserted as desirable: a player
    // who runs into a crate and THEN decides to climb it is put on top at a fifth of a walk.
    const sim = new Sim(gym);
    place(sim, 6.5, 0, 13, 0);
    for (let i = 0; i < steps(1); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true }); // run in, do not jump
      sim.step(SIM_STEP);
    }
    expect(sim.player.x).toBeGreaterThan(9.5); // pressed against the face
    glideTrace(sim, sim.world, { forward: 1, sprint: true, jumpPressed: true });
    expect(sim.player.y).toBeCloseTo(2.0, 2);
    expect(sim.movement.speedXZ).toBeLessThan(SPEED_WALK / 4);
  });
});
