/**
 * Adversarial review probes for engine milestone 4 (pings, energy, halo, hands rig, dot cap).
 *
 * House style (M3 review round):
 *   PIN  — passes today. It pins a behaviour a fix must not break, or records a hazard exactly
 *          as it behaves now so a later change cannot move it silently.
 *   BUG  — FAILS today. The comment above it states the claim; the assertion is written for the
 *          CORRECT behaviour, so the fix round turns it green and migrates it into the topic spec.
 *
 * Run: `npx vitest run test/review`
 *
 * Browser-side evidence (screen-space ink, the `white < 5 %` fence, the verify re-baselines)
 * lives in `test/review/ink-vs-window.probe.mjs` — vitest does not collect it; run it by hand.
 *
 * Contracts cited by file:line so a reader can check them:
 *   doc/vision.md:20      law 1 — every way of learning emits sound the world can hear
 *   doc/vision.md:21      law 2 — "Every blip and sound has a real physical source"
 *   doc/vision.md:24      law 5 — movement is never rationed
 *   doc/vision.md:64      the E-ping row: paint 40 m, heard 30 m "at **both ends** of the beam"
 *   doc/vision.md:118     "Empty bar blocks pings and actives only"
 *   doc/vision.md:234     "Splats >=2-3 px and temporally stable"
 *   doc/engine-plan.md:237  the far end is "a second virtual event at beam impact center"
 *   doc/engine-plan.md:270  "All sounds trigger FROM SoundEvents (audio is a consumer of the
 *                           same bus — never a separate truth)"
 */

import { describe, expect, it } from 'vitest';
import lookSource from '../../src/looks/debug/index.ts?raw';
import mainSource from '../../src/main.ts?raw';
import { AudioEngine } from '../../src/core/audio.js';
import {
  CORE_CONSTANTS,
  COYOTE_TIME,
  ENERGY_EPING,
  ENERGY_MAX,
  ENERGY_QPING,
  EPING_FAR_HEAR,
  EV,
  HALO_DECAY,
  HALO_WINDOW,
  HEARING_BASE,
  PING_COOLDOWN,
  SIM_STEP,
  WAVE_SPEED_E,
} from '../../src/core/const.js';
import type { SoundEvent } from '../../src/core/events.js';
import { pointInSolid } from '../../src/core/map/build.js';
import type { MapDef, Solid } from '../../src/core/map/types.js';
import type { MoveInput } from '../../src/core/movement.js';
import { PaintPipeline } from '../../src/core/paint.js';
import { Sim } from '../../src/core/sim.js';
import { bakeSurfels } from '../../src/core/surfels.js';

// ==========================================================================================
// Fixtures — deliberately the same shape as test/player.spec.ts's `gym`, plus two halls that
// the M4 spec does not have: one with the impact surface beyond hearing, one with no surface.
// ==========================================================================================

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

const mapOf = (name: string, solids: Solid[], len: number): MapDef => ({
  name,
  solids,
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [5, 0, 5], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [len, 6, 20] }],
  markers: [],
  bounds: { min: [0, -1, 0], max: [len, 6, 20] },
});

/** The M4 gym: 60 m hall, wall across it at x = 25, a 2 m ledge to mantle. */
const gym = mapOf(
  'review gym',
  [
    box('floor', 'floor', 0, -1, 0, 60, 0, 20),
    box('wall', 'wall', 25, 0, 0, 25.4, 6, 20),
    box('ledge', 'machine', 6, 0, 12, 9, 2.0, 18),
  ],
  60,
);

/** A hall whose only wall is 39 m down it: the beam lands well outside your own 30 m hearing. */
const longHall = mapOf(
  'long hall',
  [box('floor', 'floor', 0, -1, 0, 50, 0, 20), box('far wall', 'wall', 40, 0, 0, 40.4, 6, 20)],
  50,
);

/** A hall with nothing in front of you at all: a horizontal beam hits no surface, ever. */
const openHall = mapOf('open hall', [box('floor', 'floor', 0, -1, 0, 60, 0, 20)], 60);

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

function idle(sim: Sim, seconds: number): void {
  for (let i = 0; i < steps(seconds); i++) {
    Object.assign(sim.input, NEUTRAL);
    sim.step(SIM_STEP);
  }
}

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

/** Fire one E-ping from a standing start and let the whole beam (out + far end) resolve. */
function firePing(sim: Sim): SoundEvent[] {
  idle(sim, PING_COOLDOWN);
  return record(sim, () => {
    sim.playerSystems.intent.pingE = true;
    idle(sim, 1.0);
  });
}

/** The comparable fingerprint of one event: everything a consumer can act on. */
const trace = (e: SoundEvent): string =>
  [
    e.class,
    e.variant ?? '-',
    e.source,
    e.time.toFixed(9),
    e.origin[0].toFixed(9),
    e.origin[1].toFixed(9),
    e.origin[2].toFixed(9),
    e.paintRadius.toFixed(6),
    e.hearRadius.toFixed(6),
  ].join('|');

// ==========================================================================================
// 1. The far end: paint radius 0, placement, and determinism
// ==========================================================================================

describe('PIN — the E far end is hearable and paints nothing (engine-plan §6)', () => {
  it('is delivered to a listener standing on it, and still mutates no surfel and enqueues no patch', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    const far = firePing(sim).find((e) => e.variant === 'far');
    expect(far).toBeDefined();
    expect(far!.paintRadius).toBe(0);

    // A fresh field and a listener standing exactly on the far end — the most favourable case
    // there is for the event to paint something. Paint radius 0 must survive it.
    const field = bakeSurfels(sim.world);
    const pipe = new PaintPipeline(field, sim.world);
    pipe.setListener(far!.origin[0], far!.origin[1], far!.origin[2]);
    expect(field.paintedDots).toBe(0);

    const delivered = pipe.hear(far!);
    pipe.pump(far!.time + 10);

    expect(delivered).not.toBeNull(); // hearable…
    expect(pipe.heard).toBe(1);
    expect(pipe.missed).toBe(0);
    expect(field.paintedDots).toBe(0); // …and blind.
    expect(field.paintedEdgeVerts).toBe(0);
    expect(pipe.pendingPatches).toBe(0);
  });

  it('lands on the NEAR FACE of the surface it hit, never inside it', () => {
    // The backoff is a law with a reason, not a fudge: an origin buried in the slab is excluded
    // from its own wall count (`originSolids` in paint.ts) and would be heard through the wall
    // for free. src/core/player.ts documents 0.05 m; this pins the number and the consequence.
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    const far = firePing(sim).find((e) => e.variant === 'far')!;
    const [fx, fy, fz] = far.origin;

    expect(fx).toBeLessThan(25); // outside the slab, on your side of it
    expect(25 - fx).toBeCloseTo(0.05, 6); // EPING_FAR_BACKOFF
    for (const s of sim.world.solids) expect(pointInSolid(s, fx, fy, fz)).toBe(false);
  });
});

describe('PIN — the far end is deterministic across frame cadences', () => {
  it('produces an identical event trace whether the sim is stepped 1 or 3 fixed steps per call', () => {
    const PING_AT = 10;
    const TOTAL = 120;

    const a = new Sim(gym);
    place(a, 5, 0, 5, 0);
    const traceA = record(a, () => {
      for (let i = 1; i <= TOTAL; i++) {
        Object.assign(a.input, NEUTRAL, { forward: 1, sprint: true });
        if (i === PING_AT) a.playerSystems.intent.pingE = true;
        a.step(SIM_STEP);
      }
    }).map(trace);

    const b = new Sim(gym);
    place(b, 5, 0, 5, 0);
    const traceB = record(b, () => {
      while (b.steps < TOTAL) {
        Object.assign(b.input, NEUTRAL, { forward: 1, sprint: true });
        if (b.steps === PING_AT - 1) b.playerSystems.intent.pingE = true;
        b.advance(SIM_STEP * 3);
      }
    }).map(trace);

    // If this ever fails, the grouping assumption below broke before the determinism claim did.
    expect(b.steps).toBe(TOTAL);
    expect(a.time).toBeCloseTo(b.time, 12);
    expect(traceB).toEqual(traceA);
    // …and the run actually exercised what it claims to: a beam, its far end, and footsteps.
    expect(traceA.filter((t) => t.startsWith('ePing|far'))).toHaveLength(1);
    expect(traceA.filter((t) => t.startsWith('sprintStep')).length).toBeGreaterThan(0);
  });
});

// ==========================================================================================
// 2. Ping refusal and the intent latch (vision §3.5, §4)
// ==========================================================================================

describe('PIN — a refused ping costs nothing and starts nothing', () => {
  it('refuses for energy without spending, without emitting, and without arming the cooldown', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    sim.bus.now = 100;
    sim.playerSystems.energy = ENERGY_EPING - 0.01;

    const seen = record(sim, () => {
      expect(sim.playerSystems.ping('e').refused).toBe('energy');
    });
    expect(seen).toHaveLength(0);
    expect(sim.playerSystems.energy).toBeCloseTo(ENERGY_EPING - 0.01, 9);

    // The cooldown must NOT have been armed by the refusal: pay the bar back and the very next
    // call fires. A refusal that started the cooldown would silently halve your ping rate
    // whenever the bar dipped.
    sim.playerSystems.energy = ENERGY_MAX;
    expect(sim.playerSystems.ping('e').refused).toBeNull();
  });

  it('reports the cooldown, not the empty bar, when both are true', () => {
    // Documented choice in src/core/player.ts: the cooldown has a known expiry, the bar may
    // resolve at any moment, so the caller is told the deterministic reason.
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    sim.bus.now = 100;
    expect(sim.playerSystems.ping('q').refused).toBeNull();
    sim.playerSystems.energy = 0;
    expect(sim.playerSystems.ping('q').refused).toBe('cooldown');
    expect(sim.playerSystems.ping('e').refused).toBe('cooldown');
  });

  it('drops a press made during the cooldown instead of queuing it', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    const seen = record(sim, () => {
      sim.playerSystems.intent.pingQ = true;
      idle(sim, 0.1);
      sim.playerSystems.intent.pingQ = true; // inside the 0.75 s cooldown: refused, not queued
      idle(sim, 2.0);
    });
    expect(seen.filter((e) => e.class === 'qPing')).toHaveLength(1);
    expect(sim.playerSystems.intent.pingQ).toBe(false); // and the latch was cleared either way
  });

  it('holds the key-repeat guard in the boot layer, so a held key is not autofire', () => {
    // The core latch fires once per SET intent; nothing in core stops a keydown handler from
    // setting it 30 times a second. The guard is `if (e.repeat) return;` in main.ts's keydown,
    // and it is the only thing between a held E and a ping every 0.75 s forever.
    const at = mainSource.indexOf("window.addEventListener('keydown'");
    expect(at).toBeGreaterThanOrEqual(0);
    const keydown = mainSource.slice(at);
    const guard = keydown.indexOf('if (e.repeat) return;');
    const setsPing = keydown.indexOf('intent.pingE');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(setsPing).toBeGreaterThan(guard);
  });
});

// ==========================================================================================
// 3. Energy (vision §4, law 5)
// ==========================================================================================

describe('PIN — an empty reactor changes not one metre of movement (vision §4:118, law 5:24)', () => {
  it('produces bit-identical motion and an identical sound trace at 0 energy and at full', () => {
    const run = (energy: number): { pos: [number, number, number]; events: string[] } => {
      const sim = new Sim(gym);
      place(sim, 5, 0, 5, 0);
      sim.playerSystems.energy = energy;
      const events = record(sim, () => {
        for (let i = 0; i < steps(2); i++) {
          Object.assign(sim.input, NEUTRAL, { forward: 1, sprint: true, jumpPressed: i === 60 });
          sim.step(SIM_STEP);
        }
      }).map(trace);
      return { pos: [sim.player.x, sim.player.y, sim.player.z], events };
    };

    const flat = run(0);
    const full = run(ENERGY_MAX);
    expect(flat.pos).toEqual(full.pos);
    expect(flat.events).toEqual(full.events);
    expect(flat.events.filter((t) => t.startsWith('sprintStep')).length).toBeGreaterThan(2);
  });

  it('never lets the bar go negative, and still charges the cheaper ping from a floored bar', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    sim.playerSystems.energy = 0;
    idle(sim, 0.5); // regen 6/s: 3 units, not enough for a Q
    expect(sim.playerSystems.energy).toBeGreaterThan(0);
    expect(sim.playerSystems.energy).toBeLessThan(ENERGY_QPING);
    expect(sim.playerSystems.ping('q').refused).toBe('energy');
    idle(sim, 2);
    expect(sim.playerSystems.ping('q').refused).toBeNull();
    expect(sim.playerSystems.energy).toBeGreaterThanOrEqual(0);
  });
});

// ==========================================================================================
// 4. The halo (vision §3.8) — the model moved from main.ts to player.ts in M4
// ==========================================================================================

describe('PIN — the halo is a sim-time max-hold over what YOU emitted', () => {
  it('holds the loudest self event for HALO_WINDOW, then bleeds at HALO_DECAY, and ignores others', () => {
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    const ps = sim.playerSystems;

    ps.intent.pingQ = true;
    sim.step(SIM_STEP);
    expect(ps.audibleRadius).toBe(EV.qPing.hear); // 18 m

    // A quieter self sound inside the window must not LOWER the readout — you are still as loud
    // as the loudest thing you just did.
    sim.bus.emit({ class: 'crouchStep', source: 'self', x: sim.player.x, y: sim.player.y, z: sim.player.z });
    expect(ps.audibleRadius).toBe(EV.qPing.hear);

    // Somebody else's noise is not your loudness, however close it is.
    sim.bus.emit({ class: 'dogGait', source: 'dog', variant: 'chase', x: sim.player.x, y: sim.player.y, z: sim.player.z });
    expect(ps.audibleRadius).toBe(EV.qPing.hear);

    // Held for the window…
    idle(sim, HALO_WINDOW - 0.1);
    expect(ps.audibleRadius).toBe(EV.qPing.hear);
    // …then bled away, and floored at 0 rather than going negative.
    idle(sim, 0.2);
    expect(ps.audibleRadius).toBeLessThan(EV.qPing.hear);
    idle(sim, EV.qPing.hear / HALO_DECAY + 0.2);
    expect(ps.audibleRadius).toBe(0);
  });

  it('runs on sim seconds only: the same steps grouped differently give the same readout', () => {
    // 102 is a multiple of 3, so both cadences stop on exactly the same step and the comparison
    // is of the halo model, not of how far past the finish line each loop ran.
    const run = (perCall: number): { r: number; steps: number } => {
      const sim = new Sim(gym);
      place(sim, 5, 0, 5, 0);
      sim.playerSystems.intent.pingQ = true;
      while (sim.steps < 102) sim.advance(SIM_STEP * perCall);
      return { r: sim.playerSystems.audibleRadius, steps: sim.steps };
    };
    const grouped = run(3);
    const single = run(1);
    expect(grouped.steps).toBe(single.steps);
    expect(grouped.r).toBeCloseTo(single.r, 12);
    expect(single.r).toBeLessThan(EV.qPing.hear); // it really was decaying by now
  });

  it('DOCUMENTS: the far end refreshes the hold, so a long beam keeps you "loud" past the ping', () => {
    // Recorded, not endorsed — see the review's advisory on the halo's new bus source. Under the
    // pre-M4 model the halo followed events DELIVERED to you; it now follows everything you
    // emit, and the far end of a 20 m beam lands 0.235 s after the ping, extending the 1.2 s
    // max-hold by that much. If a fix changes this, it should change this assertion knowingly.
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, 0);
    idle(sim, PING_COOLDOWN);
    sim.playerSystems.intent.pingE = true;
    const flight = 19.95 / WAVE_SPEED_E;
    idle(sim, HALO_WINDOW + flight - 4 * SIM_STEP);
    // More than HALO_WINDOW after the ping itself, yet still pinned at full loudness.
    expect(sim.playerSystems.audibleRadius).toBe(EV.ePing.hear);
  });
});

// ==========================================================================================
// 5. The hands rig (visual-brief §1.6) — the pin the M4 report claims exists
// ==========================================================================================

describe('PIN — the forearm bone sits at the elbow-wrist MIDPOINT', () => {
  it('writes the exact midpoint of the REST keyframe, mirrored in x for the left arm', () => {
    // test/player.spec.ts:580 only bounds half-length in (0.05, 0.6) — moving `forearm.pos` onto
    // the elbow would pass it while the look drew a double-length forearm out of the frame. These
    // are the REST key's own numbers: wrist [0.24, -0.92, -0.3], elbow [0.32, -1.22, -0.16].
    const sim = new Sim(gym);
    const h = sim.playerSystems.hands;
    expect(h.visibility).toBe(0);

    expect(h.right.hand.pos[0]).toBeCloseTo(0.24, 9);
    expect(h.right.hand.pos[1]).toBeCloseTo(-0.92, 9);
    expect(h.right.hand.pos[2]).toBeCloseTo(-0.3, 9);
    expect(h.right.forearm.pos[0]).toBeCloseTo(0.28, 9);
    expect(h.right.forearm.pos[1]).toBeCloseTo(-1.07, 9);
    expect(h.right.forearm.pos[2]).toBeCloseTo(-0.23, 9);

    expect(h.left.hand.pos[0]).toBeCloseTo(-0.24, 9);
    expect(h.left.forearm.pos[0]).toBeCloseTo(-0.28, 9);
    expect(h.left.forearm.pos[1]).toBeCloseTo(-1.07, 9);

    // The look recovers the bone's length as 2 x |forearm - hand| (looks/debug `poseArm`). That
    // is only the real elbow->wrist length while the midpoint law above holds.
    const half = Math.hypot(
      h.right.forearm.pos[0] - h.right.hand.pos[0],
      h.right.forearm.pos[1] - h.right.hand.pos[1],
      h.right.forearm.pos[2] - h.right.hand.pos[2],
    );
    expect(half * 2).toBeCloseTo(Math.hypot(0.32 - 0.24, -1.22 + 0.92, -0.16 + 0.3), 9);
    expect(lookSource).toContain('half * 2');
  });

  it('keeps both bones on one axis, and both arms mirrored about the eye', () => {
    const sim = new Sim(gym);
    const h = sim.playerSystems.hands;
    expect(h.right.forearm.rot).toEqual(h.right.hand.rot);
    expect(h.left.forearm.rot).toEqual(h.left.hand.rot);
    expect(h.left.hand.pos[0]).toBeCloseTo(-h.right.hand.pos[0], 12);
    expect(h.left.hand.pos[1]).toBeCloseTo(h.right.hand.pos[1], 12);
  });
});

// ==========================================================================================
// 6. The near-field dot cap (visual-brief §2, vision §12:234)
// ==========================================================================================

describe('PIN — the splat clamp cannot invert', () => {
  it('keeps every core-owned splat floor at or below the look-private cap', () => {
    // `size = clamp(foot, mix(uSplatNear, uSplatMin, far), uSplatCap)`. GLSL leaves clamp
    // UNDEFINED when minVal > maxVal, and the two operands are owned by different modules:
    // SPLAT_NEAR_PX / SPLAT_MIN_PX are core constants a tuning pass may raise, SPLAT_CAP_PX is
    // private to the debug look. Today only a source comment defends the ordering.
    const m = /const SPLAT_CAP_PX = ([0-9.]+)/.exec(lookSource);
    expect(m).not.toBeNull();
    const cap = Number(m![1]);
    expect(Number.isFinite(cap)).toBe(true);
    expect(lookSource).toContain('uSplatCap: { value: SPLAT_CAP_PX }');
    expect(lookSource).toContain('clamp(foot, mix(uSplatNear, uSplatMin, far), uSplatCap)');

    expect(CORE_CONSTANTS.SPLAT_NEAR_PX).toBeLessThanOrEqual(cap);
    expect(CORE_CONSTANTS.SPLAT_MIN_PX).toBeLessThanOrEqual(cap);
    // Vision §12:234 — "Splats >=2-3 px and temporally stable".
    expect(CORE_CONSTANTS.SPLAT_MIN_PX).toBeGreaterThanOrEqual(2);
  });

  it('leaves no half-removed ink machinery behind', () => {
    expect(lookSource).not.toContain('uSplatInk');
    expect(lookSource).not.toContain('SPLAT_INK');
  });
});

// ==========================================================================================
// 7. BUGS
// ==========================================================================================

describe('BUG — a beam that hits nothing must not make a sound', () => {
  // BUG(far-end-no-impact): an E-ping fired into open space still emits a 30 m hearable event at
  // the 40 m point, in mid-air, where the beam hit nothing. engine-plan §6:237 specifies "a
  // second virtual event at beam impact center"; with no impact there is no impact centre, and
  // vision law 2 (doc/vision.md:21) says "Every blip and sound has a real physical source".
  // Today: one `variant: 'far'` event at (45, eye, 5), hearRadius 30. Once dogs exist (M5) that
  // is an alarm from thin air — the opposite of "the E-ping wakes the room it looks into".
  it('emits no far end when nothing is within the beam\'s 40 m reach', () => {
    const sim = new Sim(openHall);
    place(sim, 5, 0, 5, 0); // +x down 55 m of empty hall; pitch 0, so the floor is never crossed
    const seen = firePing(sim);
    expect(seen.filter((e) => e.class === 'ePing' && e.variant !== 'far')).toHaveLength(1);
    expect(seen.filter((e) => e.variant === 'far')).toHaveLength(0);
  });

  it('emits no far end OUTSIDE the map when the open direction runs off the edge', () => {
    // Same defect, sharper: from x = 5 facing −x the far end is published at x = −35, which is
    // 35 m outside `bounds.min` — a hearable sound in the void. test/player.spec.ts:402 currently
    // pins this as correct ("sits at the full 40 m when the beam hits nothing"); that spec is
    // part of what has to change.
    const sim = new Sim(gym);
    place(sim, 5, 0, 5, Math.PI);
    const far = firePing(sim).find((e) => e.variant === 'far');
    if (far) {
      expect(far.origin[0]).toBeGreaterThanOrEqual(sim.map.bounds.min[0]);
    }
    expect(far).toBeUndefined();
  });
});

describe('BUG — audio must not sound what the listener could not hear', () => {
  // BUG(inaudible-far-chirp): `AudioEngine.play` short-circuits on `e.source === 'self'` with no
  // audibility test. That was sound while every self event originated AT the player. M4 broke
  // it: the far end is a self event that can be up to 40 m away, and the delivery gate
  // (`d <= max(HEARING_BASE, hearRadius)`) rejects it past 30 m. Below, the player's own paint
  // pipeline scores the far end as MISSED while audio plays a chirp for it — the ears and the
  // dots disagree, which is exactly what engine-plan §8:270 and the audio.ts header forbid
  // ("audio is a consumer of the same bus — never a separate truth").
  it('plays the outgoing ping but not a far end 38.95 m away that it never received', () => {
    const rec: string[] = [];
    const g = globalThis as { AudioContext?: unknown };
    const had = 'AudioContext' in g;
    const prev = g.AudioContext;
    g.AudioContext = makeStubCtx(rec);
    const audio = new AudioEngine();
    try {
      const sim = new Sim(longHall);
      place(sim, 1, 0, 5, 0); // wall face at x = 40 → beam 39 m → far end 38.95 m away
      const field = bakeSurfels(sim.world);
      const paint = new PaintPipeline(field, sim.world);
      paint.attach(sim.bus);
      audio.resume();
      audio.attach(sim.bus);
      const before = audio.played;

      const seen = record(sim, () => {
        paint.setListener(sim.player.x, sim.player.y + sim.movement.eyeTarget, sim.player.z);
        sim.playerSystems.intent.pingE = true;
        idle(sim, 1.0);
      });

      const far = seen.find((e) => e.variant === 'far')!;
      const d = Math.hypot(far.origin[0] - sim.player.x, far.origin[2] - sim.player.z);
      // The premise, asserted rather than assumed: the far end really is out of earshot.
      expect(d).toBeGreaterThan(Math.max(HEARING_BASE, EPING_FAR_HEAR));
      expect(paint.missed).toBe(1);

      // …so exactly one ping was audible: the one that left your own head.
      expect(audio.played - before).toBe(1);
    } finally {
      audio.dispose();
      if (had) g.AudioContext = prev;
      else delete g.AudioContext;
    }
  });
});

/** The smallest WebAudio surface `AudioEngine` needs; records nothing but node creation. */
function makeStubCtx(rec: string[]): new () => AudioContext {
  const param = () => ({
    value: 0,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
    exponentialRampToValueAtTime: () => undefined,
    setTargetAtTime: () => undefined,
  });
  const connectable = <T extends object>(o: T): T => Object.assign(o, { connect: (d: unknown) => d });
  class StubCtx {
    state = 'running';
    currentTime = 0;
    sampleRate = 48000;
    destination = {};
    createGain() {
      rec.push('gain');
      return connectable({ gain: param() });
    }
    createBufferSource() {
      rec.push('src');
      return connectable({
        buffer: null as unknown,
        playbackRate: param(),
        start: () => undefined,
        stop: () => undefined,
      });
    }
    createBiquadFilter() {
      rec.push('biquad');
      return connectable({ type: '', frequency: param(), Q: param() });
    }
    createOscillator() {
      rec.push('osc');
      return connectable({ type: '', frequency: param(), start: () => undefined, stop: () => undefined });
    }
    createBuffer(_ch: number, len: number) {
      return { getChannelData: () => new Float32Array(len) };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  return StubCtx as unknown as new () => AudioContext;
}
