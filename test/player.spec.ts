/**
 * Player systems — the reactor, the two pings, the halo and the hands rig (engine-plan §6).
 *
 * Contract under test:
 *   vision §4    one bar, capacity 100, regen 6/s, E 18, Q 10, sprint drain 1/s. "Empty bar
 *                blocks pings and actives only; it never stops you from moving."
 *   vision §5    law 5, "movement stays genuinely good" — no encumbrance, no meaningful stamina
 *                tax. A flat reactor must not change a single metre per second of the body.
 *   vision §3.3  the ping rows: Q paints 12 m / heard 18; E is a 25° cone painting 40 m, heard 30
 *                "at **both ends** of the beam".
 *   vision §3.5  "Manual only… minimum 0.75 s between pings."
 *   vision §3.8  the Halo: "a ring whose brightness equals your current audible radius" — a
 *                smoothed max-hold over the last HALO_WINDOW of what you EMITTED.
 *   vision §1.1  every way of learning emits sound the world can hear: a ping is a sound on the
 *                same bus as a footstep, at the player's own position, with no private channel.
 *   engine-plan §6  the E far end is "a second virtual event at beam impact center, hear 30 m,
 *                once the front arrives; paints nothing extra".
 *   visual-brief §1.6  hands appear on mantles, vaults and ladder climbs; invisible in plain
 *                running.
 *
 * Everything here runs the real `Sim`, because the ordering inside a fixed step is part of the
 * contract: the bus clock is stamped, movement runs and emits, and only then do the player
 * systems act — so a ping leaves from the pose that step produced.
 */

import { describe, expect, it } from 'vitest';
import {
  COYOTE_TIME,
  ENERGY_EPING,
  ENERGY_MAX,
  ENERGY_QPING,
  ENERGY_REGEN,
  ENERGY_SPRINT_DRAIN,
  EPING_FAR_HEAR,
  EV,
  HALO_DECAY,
  HALO_WINDOW,
  PING_COOLDOWN,
  SIM_STEP,
  SPEED_SPRINT,
  WAVE_SPEED_E,
} from '../src/core/const.js';
import type { SoundEvent } from '../src/core/events.js';
import { inCone } from '../src/core/math.js';
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
 * A 60 m hall with one wall across it at x = 25 and a knee-high crate to mantle, so a beam fired
 * down the hall has a known impact centre and the hands rig has something to grab.
 */
const gym: MapDef = {
  name: 'player gym',
  solids: [
    box('floor', 'floor', 0, -1, 0, 60, 0, 20),
    box('wall', 'wall', 25, 0, 0, 25.4, 6, 20),
    box('ledge', 'machine', 6, 0, 12, 9, 2.0, 18),
  ],
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [5, 0, 5], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [60, 6, 20] }],
  markers: [],
  bounds: { min: [0, -1, 0], max: [60, 6, 20] },
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
  p.pitch = 0;
  p.vx = p.vy = p.vz = 0;
  p.grounded = true;
  p.stance = 'stand';
  sim.movement.apexY = y;
  sim.movement.coyote = COYOTE_TIME;
  sim.bus.reset();
}

/** Step with no input at all: nothing moves, nothing is emitted, only the systems tick. */
function idle(sim: Sim, seconds: number): void {
  for (let i = 0; i < steps(seconds); i++) {
    Object.assign(sim.input, NEUTRAL);
    sim.step(SIM_STEP);
  }
}

/** Every event the bus published during `body`, in emission order. */
function record(sim: Sim, body: () => void): SoundEvent[] {
  const seen: SoundEvent[] = [];
  const off = sim.bus.on((e) => seen.push(e));
  try {
    body();
  } finally {
    off();
  }
  return seen;
}

// ==========================================================================================
// Energy (vision §4)
// ==========================================================================================

describe('the reactor is one bar that gates pings and nothing else (vision §4)', () => {
  it('starts full and regenerates at ENERGY_REGEN up to the cap, never past it', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    expect(sim.playerSystems.energy).toBe(ENERGY_MAX);
    expect(sim.playerSystems.energyMax).toBe(ENERGY_MAX);

    sim.playerSystems.energy = 40;
    idle(sim, 1);
    expect(sim.playerSystems.energy).toBeCloseTo(40 + ENERGY_REGEN, 3);

    // The cap is a clamp, not a target it approaches: ten seconds of regen from full is still full.
    idle(sim, 10);
    expect(sim.playerSystems.energy).toBe(ENERGY_MAX);
  });

  it('spends exactly the vision §4 price per ping', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    sim.bus.now = 100; // past the cooldown of a fresh systems object
    sim.playerSystems.ping('e');
    expect(sim.playerSystems.energy).toBeCloseTo(ENERGY_MAX - ENERGY_EPING, 6);

    const sim2 = new Sim(gym);
    place(sim2, 5, 0, 5);
    sim2.bus.now = 100;
    sim2.playerSystems.ping('q');
    expect(sim2.playerSystems.energy).toBeCloseTo(ENERGY_MAX - ENERGY_QPING, 6);
  });

  it('REFUSES a ping it cannot pay for, and refuses it rather than queuing it', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    sim.bus.now = 100;
    sim.playerSystems.energy = ENERGY_EPING - 0.01;

    const events = record(sim, () => {
      const r = sim.playerSystems.ping('e');
      expect(r.refused).toBe('energy');
      expect(r.event).toBeNull();
    });
    expect(events).toHaveLength(0);
    // Refused, not deducted: a ping you did not fire is a ping you did not pay for.
    expect(sim.playerSystems.energy).toBeCloseTo(ENERGY_EPING - 0.01, 6);
    // …and it does NOT fire later once the bar refills. There is no queue.
    idle(sim, 2);
    expect(sim.bus.counts.ePing).toBe(0);
  });

  it('lets the cheaper ping through while the dearer one is refused', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    sim.bus.now = 100;
    sim.playerSystems.energy = ENERGY_QPING + 1;
    expect(sim.playerSystems.ping('e').refused).toBe('energy');
    expect(sim.playerSystems.ping('q').refused).toBeNull();
  });

  it('drains ENERGY_SPRINT_DRAIN while sprinting — and still regenerates through it', () => {
    // Vision §4 calls the drain "a light tax": regen and drain run TOGETHER, so a sprinting
    // reactor still recharges. Suppressing regen would make a long run cost you your pings, and
    // rationing movement against information is exactly what law 5 forbids.
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    sim.playerSystems.energy = 50;
    // The drain follows the gait the step just produced — and the gait is read off the BODY, not
    // off the sprint key (movement.gaitForSpeed), so a standing start pays nothing until it is
    // actually moving at sprint speed. Counting the steps that were charged is the whole point.
    let sprintSteps = 0;
    for (let i = 0; i < steps(2); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true });
      sim.step(SIM_STEP);
      if (sim.movement.gait === 'sprint') sprintSteps++;
    }
    expect(sim.movement.gait).toBe('sprint');
    expect(sprintSteps).toBeGreaterThan(0);
    expect(sprintSteps).toBeLessThan(steps(2)); // the ramp is real
    const gained = ENERGY_REGEN * 2 - ENERGY_SPRINT_DRAIN * sprintSteps * SIM_STEP;
    expect(sim.playerSystems.energy).toBeCloseTo(50 + gained, 6);
    expect(gained).toBeGreaterThan(0);
    expect(ENERGY_SPRINT_DRAIN).toBeLessThan(ENERGY_REGEN); // the tax can never win
  });

  it('floors at 0 and NEVER slows the body — an empty reactor is not a stamina bar (law 5)', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    sim.playerSystems.energy = 0;
    // Rig the bar empty every step, so the drain has to try to push it negative all run.
    let minEnergy = Infinity;
    for (let i = 0; i < steps(3); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true });
      sim.playerSystems.energy = 0;
      sim.step(SIM_STEP);
      minEnergy = Math.min(minEnergy, sim.playerSystems.energy);
    }
    expect(minEnergy).toBeGreaterThanOrEqual(0);
    expect(sim.movement.speedXZ).toBeCloseTo(SPEED_SPRINT, 2);

    // The same run with a full bar reaches the same place, to the millimetre.
    const full = new Sim(gym);
    place(full, 5, 0, 5);
    for (let i = 0; i < steps(3); i++) {
      Object.assign(full.input, NEUTRAL, { forward: 1, sprint: true });
      full.step(SIM_STEP);
    }
    expect(sim.player.x).toBeCloseTo(full.player.x, 9);
    expect(sim.player.z).toBeCloseTo(full.player.z, 9);
  });
});

// ==========================================================================================
// Pings: cooldown, the bus, the cone (vision §3.3, §3.5, §1.1)
// ==========================================================================================

describe('pings are sounds on the ordinary bus (vision §1.1, §3.3)', () => {
  it('emits a Q-ping at the EYE with the vision §3.3 row and no cone', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    sim.bus.now = 100;
    const [e] = record(sim, () => sim.playerSystems.ping('q'));
    expect(e).toBeDefined();
    expect(e!.class).toBe('qPing');
    expect(e!.source).toBe('self');
    expect(e!.paintRadius).toBe(EV.qPing.paint);
    expect(e!.hearRadius).toBe(EV.qPing.hear);
    expect(e!.cone).toBeUndefined();
    // Ears are in the head, not the feet: the sonar fires from the eye.
    expect(e!.origin[0]).toBeCloseTo(5, 6);
    expect(e!.origin[2]).toBeCloseTo(5, 6);
    expect(e!.origin[1]).toBeCloseTo(sim.movement.eyeTarget, 6);
  });

  it('emits an E-ping as a 25° cone along the camera forward', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, Math.PI / 2); // facing +z
    sim.bus.now = 100;
    const [e] = record(sim, () => sim.playerSystems.ping('e'));
    expect(e!.class).toBe('ePing');
    expect(e!.paintRadius).toBe(EV.ePing.paint);
    expect(e!.hearRadius).toBe(EV.ePing.hear);
    expect(e!.cone?.angleDeg).toBe(EV.ePing.coneDeg);
    const [ox, oy, oz] = e!.origin;
    const [dx, dy, dz] = e!.cone!.dir;
    expect(dx).toBeCloseTo(0, 6);
    expect(dy).toBeCloseTo(0, 6);
    expect(dz).toBeCloseTo(1, 6);
    // A point straight ahead is in the beam; one 20° off it is outside, because 25° is the FULL
    // angle (±12.5°) — the reading the paint pass uses, so the test must use the same one.
    const beam = (px: number, pz: number): boolean =>
      inCone(ox, oy, oz, dx, dy, dz, px, oy, pz, e!.cone!.angleDeg);
    expect(beam(5, 15)).toBe(true);
    expect(beam(5 + 10 * Math.sin(0.35), 5 + 10 * Math.cos(0.35))).toBe(false);
  });

  it('aims the beam with the pitch as well as the yaw', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0); // facing +x
    sim.player.pitch = 0.5;
    sim.bus.now = 100;
    const [e] = record(sim, () => sim.playerSystems.ping('e'));
    expect(e!.cone!.dir[1]).toBeCloseTo(Math.sin(0.5), 6);
    expect(e!.cone!.dir[0]).toBeCloseTo(Math.cos(0.5), 6);
  });

  it('holds ONE cooldown across both modes (vision §3.5, §12: ping spacing ≥ 0.75 s)', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    sim.bus.now = 100;
    expect(sim.playerSystems.ping('e').refused).toBeNull();
    // The cooldown is shared, so the other mode is refused too — and it is refused for the
    // COOLDOWN, not for energy, even though the E-ping just took 18.
    expect(sim.playerSystems.ping('q').refused).toBe('cooldown');
    sim.bus.now = 100 + PING_COOLDOWN - 1e-6;
    expect(sim.playerSystems.ping('q').refused).toBe('cooldown');
    sim.bus.now = 100 + PING_COOLDOWN;
    expect(sim.playerSystems.ping('q').refused).toBeNull();
  });

  it('fires from the INTENT inside a step, exactly once per press', () => {
    // The keyboard latches an intent; the step consumes it. A press collected between two steps
    // must fire once, inside a step, with that step's clock — never twice, never from a pose the
    // player has already left.
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    idle(sim, PING_COOLDOWN + 0.1);
    sim.playerSystems.intent.pingQ = true;
    const first = record(sim, () => idle(sim, SIM_STEP));
    expect(first.filter((e) => e.class === 'qPing')).toHaveLength(1);
    expect(sim.playerSystems.intent.pingQ).toBe(false);
    const rest = record(sim, () => idle(sim, 1));
    expect(rest.filter((e) => e.class === 'qPing')).toHaveLength(0);
  });

  it('stamps a ping with the time of the step that fired it, never the previous one', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    idle(sim, PING_COOLDOWN + 0.1);
    sim.playerSystems.intent.pingE = true;
    const before = sim.time;
    const seen = record(sim, () => idle(sim, SIM_STEP));
    const ping = seen.find((e) => e.class === 'ePing')!;
    expect(ping.time).toBeCloseTo(before + SIM_STEP, 9);
  });
});

// ==========================================================================================
// The E-ping's far end (engine-plan §6)
// ==========================================================================================

describe('the E-ping is heard at both ends of the beam (vision §3.3, engine-plan §6)', () => {
  /** Fire down the hall at the x = 25 wall and collect everything the bus published. */
  const fireAtWall = (sim: Sim): SoundEvent[] =>
    record(sim, () => {
      sim.playerSystems.intent.pingE = true;
      idle(sim, 1.0);
    });

  it('lands the far end at the beam impact centre, not at the 40 m point', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0); // facing +x, wall at 25
    idle(sim, PING_COOLDOWN);
    const far = fireAtWall(sim).find((e) => e.variant === 'far');
    expect(far).toBeDefined();
    expect(far!.class).toBe('ePing');
    expect(far!.source).toBe('self');
    // 20 m of hall, minus the small back-off that keeps the origin OUT of the slab (an origin
    // buried in a wall is excluded from its own wall count and would leak into the next room).
    expect(far!.origin[0]).toBeGreaterThan(24.5);
    expect(far!.origin[0]).toBeLessThan(25.0);
    expect(far!.origin[2]).toBeCloseTo(5, 6);
  });

  it('is heard EPING_FAR_HEAR and paints nothing at all', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    idle(sim, PING_COOLDOWN);
    const far = fireAtWall(sim).find((e) => e.variant === 'far')!;
    expect(far.hearRadius).toBe(EPING_FAR_HEAR);
    // The cone already painted everything the beam swept; a sphere at the far end would hand the
    // player geometry around a corner they never illuminated.
    expect(far.paintRadius).toBe(0);
    expect(far.cone).toBeUndefined();
  });

  it('arrives when the WAVEFRONT does — never early, never backdated', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    idle(sim, PING_COOLDOWN);
    let outTime = 0;
    let farTime = 0;
    let farDist = 0;
    record(sim, () => {
      sim.playerSystems.intent.pingE = true;
      idle(sim, 1.0);
    }).forEach((e) => {
      if (e.class !== 'ePing') return;
      if (e.variant === 'far') {
        farTime = e.time;
        farDist = Math.hypot(e.origin[0] - 5, e.origin[2] - 5);
      } else {
        outTime = e.time;
      }
    });
    const flight = farDist / WAVE_SPEED_E;
    expect(farTime).toBeGreaterThan(outTime);
    // Never early is absolute; late is bounded by one fixed step, the same bound `pump` works to.
    expect(farTime).toBeGreaterThanOrEqual(outTime + flight - 1e-9);
    expect(farTime).toBeLessThan(outTime + flight + SIM_STEP + 1e-9);
  });

  it('sits at the full 40 m when the beam hits nothing', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, Math.PI / 2); // facing +z, down 15 m of open hall… and out of the map
    // Aim along the long clear axis instead: back down the hall, away from the wall.
    sim.player.yaw = Math.PI;
    idle(sim, PING_COOLDOWN);
    const seen = record(sim, () => {
      sim.playerSystems.intent.pingE = true;
      idle(sim, 1.0);
    });
    const far = seen.find((e) => e.variant === 'far')!;
    // Nothing solid within 40 m in −x from x = 5 except the world's edge, which is not a solid.
    expect(Math.hypot(far.origin[0] - 5, far.origin[2] - 5)).toBeCloseTo(EV.ePing.paint, 3);
  });

  it('emits exactly one far end per E-ping, and a Q-ping has none', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    idle(sim, PING_COOLDOWN);
    const seen = record(sim, () => {
      sim.playerSystems.intent.pingE = true;
      idle(sim, 1.0);
      sim.playerSystems.intent.pingQ = true;
      idle(sim, 1.0);
    });
    expect(seen.filter((e) => e.variant === 'far')).toHaveLength(1);
    expect(seen.filter((e) => e.class === 'ePing')).toHaveLength(2); // out + far
    expect(seen.filter((e) => e.class === 'qPing')).toHaveLength(1);
  });

  it('always delivers the pending far end before the next E-ping can be fired', () => {
    // One pending slot is enough BY CONSTRUCTION: the longest beam's flight is 40/85 = 0.47 s and
    // PING_COOLDOWN is 0.75 s. If that ever stops being true this test is the alarm.
    expect(EV.ePing.paint / WAVE_SPEED_E).toBeLessThan(PING_COOLDOWN);
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, Math.PI); // the open direction: the longest possible beam
    idle(sim, PING_COOLDOWN);
    const seen = record(sim, () => {
      for (let i = 0; i < 4; i++) {
        sim.playerSystems.intent.pingE = true;
        idle(sim, PING_COOLDOWN + SIM_STEP);
      }
    });
    expect(seen.filter((e) => e.class === 'ePing' && e.variant !== 'far')).toHaveLength(4);
    expect(seen.filter((e) => e.variant === 'far')).toHaveLength(4);
  });
});

// ==========================================================================================
// The Halo (vision §3.8)
// ==========================================================================================

describe('the halo says exactly how loud you are (vision §3.8)', () => {
  it('takes the MAX of what you emitted, so a quiet step never hides a loud one', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    sim.bus.now = 100;
    sim.bus.emit({ class: 'sprintStep', source: 'self', x: 5, y: 0, z: 5 });
    expect(sim.playerSystems.audibleRadius).toBe(EV.sprintStep.hear);
    sim.bus.emit({ class: 'crouchStep', source: 'self', x: 5, y: 0, z: 5 });
    expect(sim.playerSystems.audibleRadius).toBe(EV.sprintStep.hear);
  });

  it('holds for HALO_WINDOW and then bleeds at HALO_DECAY', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    idle(sim, 1);
    sim.bus.emit({ class: 'sprintStep', source: 'self', x: 5, y: 0, z: 5 });
    const held = sim.playerSystems.audibleRadius;
    expect(held).toBe(EV.sprintStep.hear);

    // Inside the window: untouched. A readout that dropped to zero between two footfalls would
    // say you are silent while you are sprinting.
    idle(sim, HALO_WINDOW - 0.1);
    expect(sim.playerSystems.audibleRadius).toBe(held);

    // Past it: a linear bleed at HALO_DECAY m/s of world time.
    idle(sim, 0.5);
    const bled = sim.playerSystems.audibleRadius;
    expect(bled).toBeLessThan(held);
    expect(bled).toBeGreaterThan(held - HALO_DECAY * 0.5 - 0.3);
    idle(sim, 10);
    expect(sim.playerSystems.audibleRadius).toBe(0);
  });

  it('re-arms on a quieter sound once the window has lapsed', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    idle(sim, 1);
    sim.bus.emit({ class: 'sprintStep', source: 'self', x: 5, y: 0, z: 5 });
    idle(sim, 10);
    expect(sim.playerSystems.audibleRadius).toBe(0);
    sim.bus.emit({ class: 'crouchStep', source: 'self', x: 5, y: 0, z: 5 });
    expect(sim.playerSystems.audibleRadius).toBe(EV.crouchStep.hear);
  });

  it('ignores sounds that are not yours — the halo is a readout of YOU', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    idle(sim, 1);
    sim.bus.emit({ class: 'detonation', source: 'detonation', x: 5, y: 0, z: 5 });
    expect(sim.playerSystems.audibleRadius).toBe(0);
  });

  it('flares on a ping: an E-ping makes you loud, and the halo says so', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5);
    idle(sim, PING_COOLDOWN);
    expect(sim.playerSystems.audibleRadius).toBe(0);
    sim.playerSystems.intent.pingE = true;
    idle(sim, SIM_STEP);
    expect(sim.playerSystems.audibleRadius).toBe(EV.ePing.hear);
  });

  it('rises with the gait as you actually run, without anybody setting it', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, Math.PI / 2);
    let walkMax = 0;
    for (let i = 0; i < steps(2); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1 });
      sim.step(SIM_STEP);
      walkMax = Math.max(walkMax, sim.playerSystems.audibleRadius);
    }
    let sprintMax = 0;
    for (let i = 0; i < steps(2); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true });
      sim.step(SIM_STEP);
      sprintMax = Math.max(sprintMax, sim.playerSystems.audibleRadius);
    }
    expect(walkMax).toBe(EV.walkStep.hear);
    expect(sprintMax).toBe(EV.sprintStep.hear);
  });
});

// ==========================================================================================
// The hands rig (engine-plan §6, visual-brief §1.6)
// ==========================================================================================

describe('the hands rig poses the verb movement is running (visual-brief §1.6)', () => {
  it('is out of view in plain running, and stays out of view', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, Math.PI / 2);
    for (let i = 0; i < steps(2); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true });
      sim.step(SIM_STEP);
      expect(sim.playerSystems.hands.state).toBe('none');
      expect(sim.playerSystems.hands.visibility).toBeLessThan(0.01);
    }
  });

  it('mirrors movement’s state and phase, and animates monotonically through a mantle', () => {
    const sim = new Sim(gym);
    place(sim, 5.2, 0, 15, 0); // facing +x at the 2 m ledge
    const phases: number[] = [];
    const heights: number[] = [];
    let sawVisible = false;
    for (let i = 0; i < steps(3); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, jumpPressed: sim.movement.hands === 'none' });
      sim.step(SIM_STEP);
      const h = sim.playerSystems.hands;
      if (h.state === 'mantle') {
        expect(h.phase).toBeCloseTo(sim.movement.handsPhase, 9);
        phases.push(h.phase);
        heights.push(h.right.hand.pos[1]);
        if (h.visibility > 0.5) sawVisible = true;
      } else if (phases.length > 0) {
        break;
      }
    }
    expect(phases.length, 'expected the mantle to run').toBeGreaterThan(10);
    expect(sawVisible, 'the rig must come into view during a mantle').toBe(true);
    // The phase is a clock: it only ever moves forward through the verb.
    for (let i = 1; i < phases.length; i++) expect(phases[i]!).toBeGreaterThanOrEqual(phases[i - 1]!);
    // …and the authored curve reaches up and comes back down (reach → plant → push).
    expect(Math.max(...heights)).toBeGreaterThan(heights[0]!);
    expect(heights[heights.length - 1]!).toBeLessThan(Math.max(...heights));
  });

  it('keeps both arms attached to their own bones, always', () => {
    // The forearm bone is the elbow-wrist MIDPOINT and the hand bone is the wrist, so a look can
    // recover the arm's length as twice the distance between them. A pose that broke that would
    // draw a forearm that fails to reach its own hand.
    const sim = new Sim(gym);
    place(sim, 5.2, 0, 15, 0);
    for (let i = 0; i < steps(3); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, jumpPressed: sim.movement.hands === 'none' });
      sim.step(SIM_STEP);
      for (const arm of [sim.playerSystems.hands.left, sim.playerSystems.hands.right]) {
        const half = Math.hypot(
          arm.hand.pos[0] - arm.forearm.pos[0],
          arm.hand.pos[1] - arm.forearm.pos[1],
          arm.hand.pos[2] - arm.forearm.pos[2],
        );
        expect(half).toBeGreaterThan(0.05);
        expect(half).toBeLessThan(0.6);
        // A hand continues its forearm: one orientation per arm, no invented wrist joint.
        expect(arm.hand.rot[0]).toBeCloseTo(arm.forearm.rot[0], 9);
        expect(arm.hand.rot[1]).toBeCloseTo(arm.forearm.rot[1], 9);
      }
    }
  });

  it('mirrors the two arms across the centre line', () => {
    const sim = new Sim(gym);
    place(sim, 5.2, 0, 15, 0);
    let checked = 0;
    for (let i = 0; i < steps(3); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, jumpPressed: sim.movement.hands === 'none' });
      sim.step(SIM_STEP);
      const h = sim.playerSystems.hands;
      if (h.state !== 'mantle') continue;
      expect(h.left.hand.pos[0]).toBeCloseTo(-h.right.hand.pos[0], 9);
      expect(h.left.hand.pos[1]).toBeCloseTo(h.right.hand.pos[1], 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('retracts rather than popping when the verb ends', () => {
    const sim = new Sim(gym);
    place(sim, 5.2, 0, 15, 0);
    let peak = 0;
    for (let i = 0; i < steps(3); i++) {
      Object.assign(sim.input, NEUTRAL, { forward: 1, jumpPressed: sim.movement.hands === 'none' });
      sim.step(SIM_STEP);
      peak = Math.max(peak, sim.playerSystems.hands.visibility);
      if (peak > 0.6 && sim.movement.hands === 'none') break;
    }
    expect(peak).toBeGreaterThan(0.6);
    // One step after the verb ends the rig is still partly there: it withdraws over a few frames.
    Object.assign(sim.input, NEUTRAL);
    sim.step(SIM_STEP);
    expect(sim.playerSystems.hands.visibility).toBeGreaterThan(0);
    idle(sim, 1);
    expect(sim.playerSystems.hands.visibility).toBeLessThan(0.01);
  });
});
