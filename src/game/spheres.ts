/**
 * The sphere — M2's one verb, and the whole life of a throwable.
 *
 * Hold F to wind the arm, release to throw, and the sphere goes off against the first thing it
 * touches. That is the entire object: there is no flight to watch, no bounce, no roll, no
 * settle, nothing lying on the floor afterwards and nothing to walk back for. One arc, one
 * boom, gone.
 *
 * ## Why it is not a can
 *
 * The can that stood here first was a *thing in the world*: it landed, skipped, rolled, came to
 * rest, printed a cairn on the floor and waited to be picked up. Played, every one of those
 * words was a second sound the player had not asked for and could not place — the arrival, the
 * skip, the settle — and the loudest half of the verb happened after the moment the player was
 * reading. A throw is a *question asked from somewhere you are not*, and a question is one
 * event. So the sphere makes exactly one, at the point of contact, and then stops existing.
 *
 * What that buys, beyond the clarity: the rack is now a **rate** rather than an inventory. A can
 * had to be fetched, which made the verb a loop with a walk in it; a sphere is rebuilt by the
 * reactor on a timer, so the price of a throw is the wait for the next one, paid in the only
 * currency this game keeps — time in a dark room with something hunting you.
 *
 * ## Why the noises leave through the sim
 *
 * This class *describes* what it did — a queue of `SphereSound` records drained by
 * `game/sim.ts` — and never emits. That is the same seam `PlayerController` uses (`PlayerEvent`
 * → `GameSim.onPlayerEvent`) and it exists for the same reason: emit policy is one decision,
 * made once, in one file. Which class a contact becomes, who the emitter is, whether the Halo
 * should flare — every one of those is a rule about the *bus*, and a second emitter that
 * answered any of them slightly differently would be a §3.3 row that means two things.
 *
 * The queue is cleared at the top of `update`, `world.query`'s convention: drain it immediately
 * after the call or lose it. Records are pushed in the order they happened.
 *
 * ## A sphere is a point
 *
 * There is no sphere-shaped collider anywhere: `core/ballistics.ts` sweeps a point against
 * `raycastWorld`. `SPHERE_RADIUS` is the size of a sphere to everything *except* the solver —
 * the radius the browser layer draws it at, and the standoff `game/sim.ts` puts between the
 * boom and the face it went off against, because a point source lying exactly on a plane meets
 * that plane at 90° everywhere and paints nothing.
 */

import {
  BALLISTIC_GRAVITY,
  createBallisticContact,
  defaultBallisticTunables,
  stepBallistic,
  type BallisticBody,
  type BallisticContact,
  type BallisticTunables,
} from '../core/ballistics';
import { createRayHit, raycastWorld, type RayHit, type StaticWorld } from '../core/collision';
import type { PlayerInputSource } from '../core/inputSource';
import type { MovementTunables, Stance } from '../player/controller';

/**
 * How many spheres the rack holds, and how many it starts a run with.
 *
 * Four, because humans subitize up to four: a four-pip readout is *perceived*, not counted, and
 * the whole count fits in a player's head mid-chase without a number on screen. Three invites
 * hoarding — spend one and a third of the kit is gone, and an unthrown sphere is a mechanic that
 * does not exist. Five needs counting and invites spam.
 */
export const SPHERE_COUNT = 4;

/**
 * Seconds the reactor takes to rebuild one sphere.
 *
 * This is the price of the verb, and it is the only one: a sphere costs no energy (§4 — the arm
 * is a mechanism, not the reactor) and there is nothing to walk back for. What it costs is the
 * next twelve seconds of not having it, which is the same currency everything else in a chase is
 * priced in.
 *
 * Twelve is a first-pass number chosen against the two failure modes rather than off a curve. Far
 * shorter and the rack is effectively infinite, which turns a question you choose to ask into a
 * button you hold; far longer and a player who spends four early is verbless for a minute, which
 * teaches hoarding — and a hoarded sphere is worth exactly nothing. Four in the rack and one back
 * every twelve seconds means a run of the tower can afford to ask a question about every room and
 * cannot afford to ask two about most of them.
 *
 * The timer is **paused while the arm is winding** and **reset when a sphere is thrown**, both in
 * `advanceRecharge`. It is a dev-panel slider: 0 refills instantly (which is how you tune
 * anything else about the verb without the rack getting in the way) and a large value is the
 * off switch.
 */
export const SPHERE_RECHARGE_SECONDS = 12;

/**
 * Metres, the sphere's size to everything except the solver.
 *
 * The radius the mesh is drawn at, and the distance `game/sim.ts` stands the boom off the face
 * it went off against: a sphere whose centre touches a plane has its centre one radius off it.
 * The solver treats it as a point (`core/ballistics.ts`) and perception treats it as a 6 cm
 * object; both are right about their own half.
 */
export const SPHERE_RADIUS = 0.06;

/** Seconds from wind-up start to full tension. */
export const SPHERE_CHARGE_SECONDS = 0.9;

/**
 * Metres per second, the charge curve's ends: `v(t) = MIN + (MAX - MIN) · clamp01(t /
 * SPHERE_CHARGE_SECONDS)`, held at the cap indefinitely.
 *
 * Linear in speed is quadratic in range, which puts the fine control at short range — the
 * feed-the-gap tosses, where a metre matters — and the coarse control at long range, where the
 * landing zone is a room rather than a spot. A tap carries ~2.5-4 m level; a full charge ~8 m
 * level and ~20 m lofted, which clears the E-ping's 22 m only by aiming up.
 */
export const SPHERE_THROW_MIN = 6;
export const SPHERE_THROW_MAX = 18;

/**
 * Metres in front of the eye that a released sphere appears, along the aim.
 *
 * The launch point is the *eye at the current stance height*, not a fixed height: a crouched rig
 * throws from where a crouched rig's hand is. This deliberately does not inherit the E-beam's
 * recorded law-2 debt (`doc/known-issues.md`: the beam leaves from 30 cm above a crouched head).
 * New emitters do not inherit old bugs.
 */
export const SPHERE_MUZZLE_M = 0.35;

/**
 * Emitter ids for spheres, well clear of `PLAYER_EMITTER_ID`.
 *
 * Load-bearing, not cosmetic. `GameSim.onOwnNoise` decides whether §3.8's Halo flares by
 * comparing `event.emitter` to the local player and nothing else, so a sphere that emitted as
 * emitter 0 would make the ring claim *you* were audible at 32 m the instant your sphere went
 * off across the room. The ring answers "how loud am I"; a sphere is not you the moment it
 * leaves your hand. The wind-up is the opposite case and does emit as the player: that noise is
 * the rig's own arm and it is exactly as much "you" as a footstep is.
 */
export const SPHERE_EMITTER_BASE = 1000;

/** Anything with a position. `THREE.Vector3` satisfies it, and this file needs no more. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The body doing the throwing — the three things the hand asks of it.
 *
 * A structural interface rather than `PlayerController`, so a test can throw from an arbitrary
 * pose without standing a controller up, and so this file cannot reach for anything else the
 * body happens to expose.
 */
export interface Thrower {
  /** Feet, not eyes: the launch height is derived from the stance below. */
  readonly position: Vec3Like;
  readonly yaw: number;
  readonly pitch: number;
  readonly state: { readonly stance: Stance };
}

/**
 * One noise the arm or a sphere made, for `game/sim.ts` to price and emit.
 *
 * Two kinds, which is the whole verb: the rig winding its own arm, and a sphere going off. There
 * is deliberately no third — no landing, no settle, no lift — because there is nothing left after
 * the boom to make one.
 */
export type SphereSound =
  | {
      readonly kind: 'windup';
      /** `start` is the arm moving; `full` is the click at maximum tension — the charge meter. */
      readonly stage: 'start' | 'full';
      readonly x: number;
      readonly y: number;
      readonly z: number;
    }
  | {
      readonly kind: 'boom';
      readonly sphere: number;
      readonly x: number;
      readonly y: number;
      readonly z: number;
      /**
       * The struck face's normal.
       *
       * Carried because a contact point lies exactly *on* a face, and a point source on a plane
       * grazes that plane at 90° everywhere: measured, a prop sound emitted from y = 0 on the
       * floor unlocks **zero** dots out of 33 880 rays, and the same sound one millimetre up
       * unlocks 39 362. `sim.ts` stands the boom off along this normal, which is the same job
       * `STEP_HEIGHT` does for a footfall — and it needs a direction, because unlike a footfall
       * a sphere goes off against walls and ceilings too.
       */
      readonly nx: number;
      readonly ny: number;
      readonly nz: number;
    };

/** Launch speed for a charge held `chargeSeconds`, m/s — the curve above, evaluated. */
export function throwSpeed(chargeSeconds: number): number {
  const k = Math.min(1, Math.max(0, chargeSeconds / SPHERE_CHARGE_SECONDS));
  return SPHERE_THROW_MIN + (SPHERE_THROW_MAX - SPHERE_THROW_MIN) * k;
}

/**
 * Where a sphere thrown from here at this speed would be on each of the next `count` ticks —
 * the arc the browser layer draws while the arm is wound.
 *
 * **The discrete sum, not the parabola, and that is law 2 rather than pedantry.** The integrator
 * is semi-implicit Euler (`core/ballistics.ts`): gravity goes into the velocity first and the
 * body then moves at the *new* velocity, so after `n` ticks it is at
 *
 *     p_n = p_0 + n·dt·v_0 + g·dt²·n(n+1)/2
 *
 * which is the closed-form parabola `p_0 + t·v_0 + ½·g·t²` plus half a tick of extra fall. At
 * 120 Hz and two seconds of flight that is 13 cm — a hand's breadth of daylight between the line
 * the game draws and the place the sphere actually goes. An aiming aid that disagrees with the
 * physics is the system lying about where a sound will come from, which is the one thing the
 * paint layer exists not to do, so the preview is generated from the integrator's own
 * accumulation and there is one function for it.
 *
 * Pure, and deliberately takes numbers rather than a `Spheres` instance: the arc has to be
 * drawable for a throw nobody has made yet, from a pose the caller is free to invent.
 *
 * `out` is filled and returned when it is long enough, so the browser layer can hold one buffer
 * and refill it every frame the arm is back.
 */
export function arcPoints(
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  speed: number,
  dt: number,
  count: number,
  out?: Float32Array,
  gravity: number = BALLISTIC_GRAVITY,
): Float32Array {
  const n = count > 0 ? Math.floor(count) : 0;
  const points = out !== undefined && out.length >= n * 3 ? out : new Float32Array(n * 3);
  const vx = dirX * speed;
  const vy = dirY * speed;
  const vz = dirZ * speed;
  for (let i = 0; i < n; i++) {
    // n(n+1)/2 — the running total of the whole ticks of gravity already folded into the
    // velocity by the time this step is taken. The first point is the muzzle itself, i = 0.
    const fall = (gravity * dt * dt * i * (i + 1)) / 2;
    points[i * 3] = originX + i * dt * vx;
    points[i * 3 + 1] = originY + i * dt * vy - fall;
    points[i * 3 + 2] = originZ + i * dt * vz;
  }
  return points;
}

interface Sphere {
  readonly body: BallisticBody;
  /** In the world at all. A slot that is not live is in the rack or has already gone off. */
  live: boolean;
}

function makeSphere(): Sphere {
  return { body: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, live: false };
}

/** A live sphere's pose, for `debugState` and for whatever draws it. */
export interface SphereReadout {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export class Spheres {
  /** Every noise made during the last `update`, oldest first. Cleared at the top of each one. */
  readonly sounds: SphereSound[] = [];

  readonly tunables: BallisticTunables = defaultBallisticTunables();

  /**
   * Seconds to rebuild one sphere — `SPHERE_RECHARGE_SECONDS`, on the instance so the dev panel
   * can drag it without every simulation in the process agreeing to the change (the same reason
   * `SoundTunables` is a per-run copy). Zero refills the rack instantly.
   */
  rechargeSeconds = SPHERE_RECHARGE_SECONDS;

  private readonly world: StaticWorld;
  private readonly thrower: Thrower;
  private readonly movement: MovementTunables;

  private readonly spheres: Sphere[] = [];
  private readonly contact: BallisticContact = createBallisticContact();
  private readonly hit: RayHit = createRayHit();

  private rack = SPHERE_COUNT;
  /** Seconds accumulated toward the next rebuilt sphere. */
  private rebuild = 0;
  private winding = false;
  private chargeSeconds = 0;
  private atFullTension = false;
  /** F pressed with an empty rack. Nothing happens in the world; this is the only witness. */
  private refusals = 0;
  private thrownCount = 0;

  /** The stance the tick started with, read once (the getter allocates). */
  private stance: Stance = 'stand';

  constructor(options: { world: StaticWorld; thrower: Thrower; movement: MovementTunables }) {
    this.world = options.world;
    this.thrower = options.thrower;
    this.movement = options.movement;
    // A full rack's worth of slots up front, so the common case never allocates mid-tick.
    // `freeSlot` grows the pool past it, which only happens when the recharge has put more
    // spheres in the air at once than the rack holds — a long loft plus a fresh rebuild.
    for (let i = 0; i < SPHERE_COUNT; i++) this.spheres.push(makeSphere());
  }

  // ---- readouts -------------------------------------------------------------

  /** Spheres in the rack. Satisfies `RackSample.carried` (`ui/hud.ts`). */
  get carried(): number {
    return this.rack;
  }

  /** Seconds the arm has been winding, 0 when it is not. */
  get charge(): number {
    return this.chargeSeconds;
  }

  get charging(): boolean {
    return this.winding;
  }

  /** 0-1 along the charge curve, held at 1 past full tension. */
  get chargeFraction(): number {
    return Math.min(1, this.chargeSeconds / SPHERE_CHARGE_SECONDS);
  }

  /** What a release right now would launch at, m/s. Zero while the arm is still. */
  get pendingSpeed(): number {
    return this.winding ? throwSpeed(this.chargeSeconds) : 0;
  }

  /** Spheres in the air. Never anything else — a sphere that has landed does not exist. */
  get inWorld(): number {
    let n = 0;
    for (const s of this.spheres) if (s.live) n++;
    return n;
  }

  get thrown(): number {
    return this.thrownCount;
  }

  /** Times F was pressed with an empty rack — a refusal leaves no other trace, by design. */
  get refused(): number {
    return this.refusals;
  }

  /** 0-1 toward the next rebuilt sphere; 1 when the rack is already full. */
  get rebuildFraction(): number {
    if (this.rack >= SPHERE_COUNT) return 1;
    if (!(this.rechargeSeconds > 0)) return 1;
    return Math.min(1, this.rebuild / this.rechargeSeconds);
  }

  spheresSnapshot(): SphereReadout[] {
    const out: SphereReadout[] = [];
    for (let id = 0; id < this.spheres.length; id++) {
      const s = this.spheres[id]!;
      if (!s.live) continue;
      out.push({ id, x: s.body.x, y: s.body.y, z: s.body.z });
    }
    return out;
  }

  /** The live body behind a slot, or `null`. For tests and tooling; never mutate it. */
  sphereAt(id: number): BallisticBody | null {
    const s = this.spheres[id];
    return s !== undefined && s.live ? s.body : null;
  }

  // ---- the tick -------------------------------------------------------------

  /**
   * One fixed tick of the hand: charge (which may launch), rebuild, then fly.
   *
   * Called from `GameSim.tick` *before* `player.update`, on the body the tick started with — the
   * same rule the pings follow, and for the same reason: a throw is aimed at what the player was
   * looking at when they let go, not at where the next tick's look put them.
   */
  update(dt: number, input: PlayerInputSource): void {
    this.sounds.length = 0;
    this.stance = this.thrower.state.stance;
    this.advanceCharge(dt, input);
    this.advanceRecharge(dt);
    this.integrate(dt);
  }

  /** Back to the start of a run: nothing in the air, a full rack, the arm down. */
  reset(): void {
    for (const s of this.spheres) s.live = false;
    this.rack = SPHERE_COUNT;
    this.rebuild = 0;
    this.winding = false;
    this.chargeSeconds = 0;
    this.atFullTension = false;
    this.sounds.length = 0;
  }

  // ---- the arm --------------------------------------------------------------

  private advanceCharge(dt: number, input: PlayerInputSource): void {
    if (input.wasPressed('throw') && !this.winding) {
      if (this.rack <= 0) {
        /*
         * §1: an empty rack refuses *before the arm moves*. No motion, no world sound, nothing on
         * the bus — and deliberately no off-bus click either. The one sound in this game that
         * paints nothing is §3.8's Halo hum, and that carve-out is exclusive to it: the hum has
         * no position, no emitter and nothing in the world can hear it. A refusal click would be
         * a noise the rig makes at a place in the world that paints nothing, which is the "one
         * bus, two senses" commitment broken in exactly the way it forbids. The player learns
         * the rack is empty the way they learn everything else: the throw they expected did not
         * happen — and `ui/hud.ts`'s rack row, which is not a sound, says why.
         */
        this.refusals++;
      } else {
        this.winding = true;
        this.chargeSeconds = 0;
        this.atFullTension = false;
        this.pushWindup('start');
      }
    }
    if (!this.winding) return;

    if (input.isDown('throw')) {
      this.chargeSeconds += dt;
      if (!this.atFullTension && this.chargeSeconds >= SPHERE_CHARGE_SECONDS) {
        this.atFullTension = true;
        /*
         * The charge meter, and the whole of it. There is no bar: charging is audible exactly
         * twice — the arm starting, and the click at maximum tension — and between them the
         * player estimates, which is the same skill the throw itself is. A continuous readout
         * would price the estimate out of the verb; a continuous *sound* would also be a
         * continuous paint source at the thrower's own feet, which is the one thing a throw must
         * never be.
         */
        this.pushWindup('full');
      }
      return;
    }

    this.launch();
    this.winding = false;
    this.chargeSeconds = 0;
    this.atFullTension = false;
  }

  /**
   * The reactor rebuilding what the arm spent.
   *
   * **Paused while the arm is wound**, which is the one rule here that is a design decision
   * rather than bookkeeping. Holding F is already free in energy and free in time; letting the
   * rack fill while it is held would make "wind the arm and wait" the optimal way to carry a
   * full rack into a room, and the wind-up is a sound the world can hear (§3.3, 2.5 m). A verb
   * whose best line is to stand still making a noise is a verb pointing the wrong way.
   *
   * A `while` rather than an `if` so a paused simulation, a dev-panel time scale or a slider
   * dragged to a very small value rebuilds every sphere it owes rather than one a tick.
   */
  private advanceRecharge(dt: number): void {
    if (this.rack >= SPHERE_COUNT) {
      this.rebuild = 0;
      return;
    }
    if (this.winding) return;
    if (!(this.rechargeSeconds > 0)) {
      // Zero (and any nonsense a slider could produce) means instant: the tuning setting where
      // the rack is not the thing under test.
      this.rack = SPHERE_COUNT;
      this.rebuild = 0;
      return;
    }
    this.rebuild += dt > 0 ? dt : 0;
    while (this.rebuild >= this.rechargeSeconds && this.rack < SPHERE_COUNT) {
      this.rebuild -= this.rechargeSeconds;
      this.rack++;
    }
    if (this.rack >= SPHERE_COUNT) this.rebuild = 0;
  }

  private pushWindup(stage: 'start' | 'full'): void {
    const p = this.thrower.position;
    this.sounds.push({ kind: 'windup', stage, x: p.x, y: p.y + this.eyeHeight(), z: p.z });
  }

  /**
   * Where the hand is, metres above the feet.
   *
   * The stance's *target* eye height, not the controller's smoothed one, because
   * `PlayerController.eyeHeight` is private and this file may not widen it. The two differ only
   * during the ~0.2 s crouch transition and by at most the 0.5 m between the two stances; a throw
   * released mid-crouch leaves from where the eye is heading rather than where it is. Recorded in
   * the report rather than papered over: the fix is a getter on the controller, not a second
   * smoother here, because two eye heights that can disagree is exactly the bug this height
   * exists to avoid.
   */
  private eyeHeight(): number {
    return this.stance === 'crouch' ? this.movement.eyeCrouch : this.movement.eyeStand;
  }

  /**
   * Lets one go: origin at the eye, `SPHERE_MUZZLE_M` along the aim, at the charged speed.
   *
   * **A throw is never refused and never quietly downgraded.** Release with a wall 30 cm away and
   * the sweep below spawns the sphere at whatever clearance actually exists — flush against the
   * wall if that is all there is — and it still leaves the hand at full charged speed, so the
   * boom it makes half a tick later is the full boom, on you. That is the price of throwing into
   * a wall and it is a price the player can learn. A refusal would be the game silently declining
   * an input, which teaches nothing.
   *
   * The sphere takes none of the rig's own velocity, and that is a design choice rather than an
   * omission: the charge curve is the entire contract between the player and the range, and it is
   * read *by ear* — you learn a full charge from where the boom lands. Adding 6 m/s of sprint to
   * an 18 m/s throw would move that point by three quarters of a room with no readout for it.
   */
  private launch(): void {
    const p = this.thrower.position;
    const ox = p.x;
    const oy = p.y + this.eyeHeight();
    const oz = p.z;
    const cp = Math.cos(this.thrower.pitch);
    const ax = -Math.sin(this.thrower.yaw) * cp;
    const ay = Math.sin(this.thrower.pitch);
    const az = -Math.cos(this.thrower.yaw) * cp;

    // `ballistics.ts`'s spawn contract: `min(handDist, hit.t - skin)` along the aim, never on a
    // face. A body spawned exactly on a face gets a sideways exit normal out of `raycastWorld`
    // and would go off against a wall it is nowhere near.
    const blocked = raycastWorld(this.world, ox, oy, oz, ax, ay, az, SPHERE_MUZZLE_M, this.hit);
    const reach = blocked === null ? SPHERE_MUZZLE_M : Math.max(0, blocked.t - this.tunables.skin);
    const speed = throwSpeed(this.chargeSeconds);

    const id = this.freeSlot();
    const s = this.spheres[id]!;
    const b = s.body;
    b.x = ox + ax * reach;
    b.y = oy + ay * reach;
    b.z = oz + az * reach;
    b.vx = ax * speed;
    b.vy = ay * speed;
    b.vz = az * speed;
    s.live = true;
    this.rack--;
    // The rebuild clock starts at the throw, not at whatever it had accumulated before it: the
    // wait a player is learning to feel is "twelve seconds since I last spent one".
    this.rebuild = 0;
    this.thrownCount++;
  }

  // ---- flight ---------------------------------------------------------------

  /**
   * **Flight is silent, and it ends at the first thing the sphere touches.**
   *
   * Between the tick a sphere is launched and the tick it goes off, nothing is on the bus: a
   * thrown sphere is invisible in flight to everyone including the thrower, which is what makes
   * the boom's position information rather than a trail. And there is exactly one contact — the
   * sphere is removed on the same line it is voiced — so there is no second sound to attribute,
   * no settle, and nothing left over to walk into later.
   */
  private integrate(dt: number): void {
    for (let id = 0; id < this.spheres.length; id++) {
      const s = this.spheres[id]!;
      if (!s.live) continue;
      const c = stepBallistic(this.world, s.body, dt, this.tunables, this.contact);
      if (c === null) continue;
      s.live = false;
      this.sounds.push({
        kind: 'boom',
        sphere: id,
        x: c.x,
        y: c.y,
        z: c.z,
        nx: c.nx,
        ny: c.ny,
        nz: c.nz,
      });
    }
  }

  private freeSlot(): number {
    for (let id = 0; id < this.spheres.length; id++) if (!this.spheres[id]!.live) return id;
    // Grow rather than refuse: a throw that silently did nothing is the worst failure this verb
    // has. There is no ceiling to guard, because a sphere in the air is a thing that removes
    // itself — the pool only has to be as big as the most that were ever airborne at once.
    this.spheres.push(makeSphere());
    return this.spheres.length - 1;
  }
}
