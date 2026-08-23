/**
 * Authored sound-traps (vision §8, engine-plan §8).
 *
 * Vision §8 is explicit that these are "authored sound-traps, never physics clutter": sparse,
 * deliberate placements with one crisp audio signature each, read-and-route puzzles rather than
 * simulation. Two consequences are laws here, not preferences:
 *
 *   - A prop NEVER acts on the player. A can is kicked by a body passing through it and takes
 *     momentum from that body's velocity, but nothing here writes to `PlayerState` or to the
 *     movement controller. Vision §5 law: nothing may turn movement into rationing, and a can
 *     that trips you is exactly that. "No ragdoll comedy anywhere" (vision §8) is the same rule
 *     seen from the art side.
 *   - A prop's whole output is sound. There is no damage, no state the player must clear, no
 *     score. It paints, it is heard by dogs at 25 m, and that is the entire mechanism.
 *
 * The can is the only thing in the engine that integrates its own motion, and it is kept as
 * small as it can be while still being honest (vision §1.2: the system never lies — a can you
 * hear bounce twice bounced twice). Impacts are capped at `CAN_MAX_BOUNCES` so one kick is a
 * bounded burst of paint, not a rattling tail that keeps repainting a room for four seconds.
 *
 * The chain curtain emits on the CROSSING, detected as a sign flip of the body's offset from the
 * curtain plane while inside the doorway — not on overlap, which would re-fire every step a
 * player stood in the doorway. Its two rows (vision §3.3: loud 10/25, quiet 4/8) are chosen from
 * the gait the body is actually travelling at, via the same `gaitForSpeed` law the footstep
 * emitter uses, so "crouch through it" is a real answer and holding the crouch key while moving
 * at sprint speed is not.
 *
 * The beacon is a clock, not a reaction: vision §7 gives the objective a hum on a fixed period,
 * audible whether or not anyone is there. It is the one emitter in the game with no cause.
 */

import {
  BEACON_PERIOD,
  CAN_FRICTION,
  CAN_HEIGHT,
  CAN_KICK_SPEED,
  CAN_MAX_BOUNCES,
  CAN_RADIUS,
  CAN_RESTITUTION,
  CAPSULE_RADIUS,
  CHAIN_SWAY_TIME,
  EV,
  GRAVITY,
  SPEED_SPRINT,
} from './const.js';
import type { EventBus } from './events.js';
import { clamp, clamp01, lerp } from './math.js';
import { groundUnder, raycast, type World } from './map/build.js';
import type { BeaconProp, CanProp, ChainProp } from './map/types.js';
import { gaitForSpeed, type MovementController } from './movement.js';
import type { PlayerState } from './sim.js';

/** How far the body may sit from the curtain plane and still count as "in the doorway". */
const CHAIN_ENGAGE_BAND = 1.0;
/**
 * How far past the plane the body must get before the latch believes the side changed.
 *
 * The rattle is one crisp signature per crossing (vision §8), so what the latch must not do is
 * fire on the sign of a float. Real traversal clears six centimetres in two frames and never
 * notices the deadband; a body parked on the plane, or shoved back and forth across it by a
 * future knockback, cannot machine-gun a 25 m event at step rate.
 */
const CHAIN_DEADBAND = 0.06;
/** Below this the can is at rest: one step at 60 Hz moves it under a millimetre. */
const CAN_REST_SPEED = 0.05;
/** A landing slower than this is a settle, not a bounce — it gets no event. */
const CAN_BOUNCE_MIN_SPEED = 0.8;
/** The body must be going at least this fast to knock anything; leaning on a can is silent. */
const CAN_KICK_MIN_SPEED = 0.05;
/**
 * How far clear of the can the body must get before the can may be kicked again.
 *
 * Standing on or inside a resting can stays silent for as long as you stand there — the can is a
 * trap you have already sprung, and law 5 keeps it out of the movement's way. What the margin
 * fixes is the boundary case: a body resting exactly at contact range could otherwise flicker in
 * and out of contact and either re-fire or stay disarmed forever on the sign of a float. Walking
 * away and coming back must always re-arm, and fifteen centimetres is one frame of a walk.
 */
const CAN_REARM_MARGIN = 0.15;
/** Impact speed that reads as a full-strength knock (vision §3.3's 12 m paint row). */
const CAN_LOUD_SPEED = 3.0;

export interface CanBody {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly resting: boolean;
}

export interface ChainBody {
  readonly id: string;
  /** Seconds of sway left, `CHAIN_SWAY_TIME` down to 0. Dressing only — nothing reads it to emit. */
  readonly sway: number;
}

interface Can extends CanBody {
  readonly def: CanProp;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  resting: boolean;
  /** Impacts spent on the current flight, capped at `CAN_MAX_BOUNCES`. */
  impacts: number;
  /**
   * False from the moment a can is kicked until it has come to rest AND the body has stepped out
   * of contact. Without it, a sprint that outruns a can re-kicks it every step it overlaps and
   * one collision becomes twenty events.
   */
  armed: boolean;
}

interface Chain extends ChainBody {
  readonly def: ChainProp;
  /** Which side of the plane the body was last seen on: -1, +1, or 0 for "not in the doorway". */
  side: number;
  sway: number;
}

interface Beacon {
  readonly def: BeaconProp;
  /** Sim time of the next hum. Starts one full period in: a run does not open with a beat. */
  next: number;
}

export class PropSystem {
  private readonly world: World;
  private readonly player: PlayerState;
  private readonly movement: MovementController;
  private readonly bus: EventBus;
  private readonly cansList: Can[] = [];
  private readonly chainsList: Chain[] = [];
  private readonly beacons: Beacon[] = [];

  /** `roster` is the resolved id list (core/roster.ts); props outside it do not exist this run. */
  constructor(
    world: World,
    player: PlayerState,
    movement: MovementController,
    bus: EventBus,
    roster: readonly string[],
  ) {
    this.world = world;
    this.player = player;
    this.movement = movement;
    this.bus = bus;
    const live = new Set(roster);
    for (const p of world.map.props) {
      if (!live.has(p.id)) continue;
      if (p.type === 'can') {
        const ground = groundUnder(world, p.x, p.z, p.y + 0.05, CAN_RADIUS, 4);
        this.cansList.push({
          def: p,
          id: p.id,
          x: p.x,
          y: ground ? ground.y : p.y,
          z: p.z,
          vx: 0,
          vy: 0,
          vz: 0,
          resting: true,
          impacts: 0,
          armed: true,
        });
      } else if (p.type === 'chain') {
        this.chainsList.push({ def: p, id: p.id, side: 0, sway: 0 });
      } else {
        this.beacons.push({ def: p, next: BEACON_PERIOD });
      }
    }
  }

  get cans(): readonly CanBody[] {
    return this.cansList;
  }

  get chains(): readonly ChainBody[] {
    return this.chainsList;
  }

  update(dt: number): void {
    for (const c of this.cansList) this.stepCan(c, dt);
    for (const c of this.chainsList) this.stepChain(c, dt);
    // The hum is a clock, so it is driven by the bus's own step time rather than an accumulator:
    // a beat is owed at t = 4, 8, 12 … whatever step boundaries the frame rate produced, and a
    // `while` rather than an `if` keeps that true even if a step ever spans more than one period.
    for (const b of this.beacons) {
      while (this.bus.now >= b.next) {
        this.bus.emit({ class: 'beaconHum', source: 'objective', x: b.def.x, y: b.def.y, z: b.def.z });
        b.next += BEACON_PERIOD;
      }
    }
  }

  // ----------------------------------------------------------------------------------------
  // Cans
  // ----------------------------------------------------------------------------------------

  private stepCan(c: Can, dt: number): void {
    if (c.resting) {
      if (!this.contacts(c)) {
        // Re-arm only once the body is clear by a margin, never on the contact boundary itself.
        if (!this.contacts(c, CAN_REARM_MARGIN)) c.armed = true;
        return;
      }
      if (!c.armed) return;
      const speed = this.movement.speedXZ;
      if (speed < CAN_KICK_MIN_SPEED) return;
      this.kick(c, speed);
      return;
    }

    // --- flight ---------------------------------------------------------------------------
    c.vy -= GRAVITY * dt;
    const horiz = Math.hypot(c.vx, c.vz);
    if (horiz > 1e-6) {
      const step = horiz * dt;
      // Swept against the world at the can's waist. A can is 0.3 m of tin: it has no shape worth
      // resolving, only a place it stops and a noise it makes when it gets there.
      const hit = raycast(this.world, c.x, c.y + CAN_HEIGHT * 0.5, c.z, c.vx, 0, c.vz, step + CAN_RADIUS);
      if (hit && !hit.inside && hit.t <= step + CAN_RADIUS) {
        const travel = Math.max(0, hit.t - CAN_RADIUS);
        c.x += (c.vx / horiz) * travel;
        c.z += (c.vz / horiz) * travel;
        const dot = c.vx * hit.nx + c.vz * hit.nz;
        c.vx = (c.vx - 2 * dot * hit.nx) * CAN_RESTITUTION;
        c.vz = (c.vz - 2 * dot * hit.nz) * CAN_RESTITUTION;
        this.knock(c, horiz);
      } else {
        c.x += c.vx * dt;
        c.z += c.vz * dt;
      }
    }

    const nextY = c.y + c.vy * dt;
    const ground = groundUnder(this.world, c.x, c.z, Math.max(c.y, nextY) + 0.02, CAN_RADIUS, 8);
    if (ground && nextY <= ground.y) {
      c.y = ground.y;
      const impact = -c.vy;
      if (impact > CAN_BOUNCE_MIN_SPEED && c.impacts < CAN_MAX_BOUNCES) {
        c.vy = impact * CAN_RESTITUTION;
        this.knock(c, impact);
      } else {
        c.vy = 0;
      }
      // Ground friction is a flat deceleration, not a multiplier: a can slows to a stop in a
      // predictable metre or so rather than sliding forever with an ever-smaller velocity.
      const speed = Math.hypot(c.vx, c.vz);
      if (speed > 1e-6) {
        const kept = Math.max(0, speed - CAN_FRICTION * dt) / speed;
        c.vx *= kept;
        c.vz *= kept;
      }
      if (c.vy === 0 && Math.hypot(c.vx, c.vz) < CAN_REST_SPEED) {
        c.vx = 0;
        c.vz = 0;
        c.resting = true;
        c.impacts = 0;
      }
    } else {
      c.y = nextY;
      // A can kicked into the corridor pit has somewhere real to land; a can kicked out of the
      // map does not, and a body falling forever is a leak. Park it at the floor of the world.
      if (c.y < this.world.map.bounds.min[1] - 2) {
        c.y = this.world.map.bounds.min[1] - 2;
        c.vx = 0;
        c.vy = 0;
        c.vz = 0;
        c.resting = true;
        c.impacts = 0;
      }
    }
  }

  /** True when the body's capsule overlaps the can's 0.3 m cylinder, grown by `margin`. */
  private contacts(c: Can, margin = 0): boolean {
    const p = this.player;
    const reach = CAPSULE_RADIUS + CAN_RADIUS + margin;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    if (dx * dx + dz * dz > reach * reach) return false;
    return p.y < c.y + CAN_HEIGHT && p.y + this.movement.height > c.y;
  }

  private kick(c: Can, speed: number): void {
    const p = this.player;
    // Direction from the body's own velocity — a can goes where the leg that hit it was going.
    // The fallback (a body drifting at barely more than the arming speed) pushes it away from
    // the body instead, which is the only direction that cannot leave it stuck inside the
    // capsule and re-firing next step.
    let dx = p.vx;
    let dz = p.vz;
    let len = Math.hypot(dx, dz);
    if (len < 0.2) {
      dx = c.x - p.x;
      dz = c.z - p.z;
      len = Math.hypot(dx, dz);
      if (len < 1e-6) {
        dx = 1;
        dz = 0;
        len = 1;
      }
    }
    const impulse = clamp01(speed / SPEED_SPRINT);
    const launch = CAN_KICK_SPEED * (0.35 + 0.65 * impulse);
    c.vx = (dx / len) * launch;
    c.vz = (dz / len) * launch;
    c.vy = launch * 0.3;
    c.resting = false;
    c.armed = false;
    c.impacts = 0;
    this.knock(c, launch);
  }

  /** One `propKnock`, its paint radius scaled 8..12 m by impact speed (vision §3.3). */
  private knock(c: Can, impact: number): void {
    c.impacts++;
    const t = clamp01(impact / CAN_LOUD_SPEED);
    const row = EV.propKnock;
    this.bus.emit({
      class: 'propKnock',
      source: 'prop',
      x: c.x,
      y: c.y + CAN_HEIGHT * 0.5,
      z: c.z,
      paintRadius: lerp(row.paint, row.paintMax, t),
      intensity: row.intensity * lerp(0.6, 1, t),
    });
  }

  // ----------------------------------------------------------------------------------------
  // Chain curtains
  // ----------------------------------------------------------------------------------------

  private stepChain(c: Chain, dt: number): void {
    if (c.sway > 0) c.sway = Math.max(0, c.sway - dt);
    const p = this.player;
    const d = c.def;
    const thinZ = d.thinAxis === 'z';
    const mid = thinZ ? (d.min[2] + d.max[2]) / 2 : (d.min[0] + d.max[0]) / 2;
    const across = thinZ ? p.z - mid : p.x - mid;
    const along = thinZ ? p.x : p.z;
    const lo = thinZ ? d.min[0] : d.min[2];
    const hi = thinZ ? d.max[0] : d.max[2];

    const inDoorway =
      Math.abs(across) <= CHAIN_ENGAGE_BAND &&
      along >= lo - CAPSULE_RADIUS &&
      along <= hi + CAPSULE_RADIUS &&
      p.y < d.max[1] &&
      p.y + this.movement.height > d.min[1];

    if (!inDoorway) {
      c.side = 0;
      return;
    }
    // Inside the deadband the latch holds whatever it last believed: neither a rattle nor a
    // re-arm happens while the body straddles the plane.
    if (Math.abs(across) < CHAIN_DEADBAND) return;
    const side = across >= 0 ? 1 : -1;
    if (c.side !== 0 && side !== c.side) {
      const quiet = gaitForSpeed(this.movement.speedXZ, this.movement.crouched) === 'crouch';
      this.bus.emit({
        class: 'chainRattle',
        source: 'prop',
        variant: quiet ? 'quiet' : 'loud',
        x: thinZ ? clamp(p.x, lo, hi) : mid,
        y: clamp(p.y + this.movement.height * 0.5, d.min[1], d.max[1]),
        z: thinZ ? mid : clamp(p.z, lo, hi),
      });
      c.sway = CHAIN_SWAY_TIME;
    }
    c.side = side;
  }
}
