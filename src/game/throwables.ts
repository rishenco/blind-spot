/**
 * The hand — M2's one verb, and the whole life of a can.
 *
 * Hold F to wind the arm, release to throw; walk into a can to pick it up; sprint into one to
 * boot it across the room. The rack, the charge, the flight, the retrieval and the wake of a
 * toppled stack all live here, and none of them touch the sound bus.
 *
 * ## Why the noises leave through the sim
 *
 * This class *describes* what it did — a queue of `ThrowSound` records drained by `game/sim.ts`
 * — and never emits. That is the same seam `PlayerController` uses (`PlayerEvent` →
 * `GameSim.onPlayerEvent`) and it exists for the same reason: emit policy is one decision, made
 * once, in one file. Which class a contact becomes, who the emitter is, which material composes
 * with which, whether the Halo should flare — every one of those is a rule about the *bus*, and a
 * second emitter that answered any of them slightly differently would be a §3.3 row that means
 * two things.
 *
 * The queue is cleared at the top of `update`, `world.query`'s convention: drain it immediately
 * after the call or lose it. Records are pushed in the order they happened, so the sim replays a
 * tick's sounds in the order the world made them.
 *
 * ## The one ordering rule inside this file
 *
 * A settled can lays its **print** (`paint/prints.ts`) *before* the knock that announces it is
 * queued. Bus fan-out is synchronous: the instant the sim emits the settle knock, the paint
 * system is inside `RestingPrints.handle` deciding whether that sound reached the cairn. A print
 * laid afterwards would miss its own arrival by one whole event and the can would land in
 * silence, findable only by the next ping. The queue makes that ordering easy to hold — the
 * print is placed here, the emit happens after `update` returns — and it is why this file writes
 * to the print sink directly rather than letting the sim do that too.
 *
 * ## A can is a point
 *
 * There is no can-shaped collider anywhere (`world/cans.ts`), so cans do not collide with each
 * other and a stack is not held up by physics. A stack is held up by *this file*: authored cans
 * spawn asleep where the author put them, and the support rule below is what brings the column
 * down when you take the can underneath.
 */

import {
  defaultBallisticTunables,
  stepBallistic,
  wakeBallistic,
  type BallisticBody,
  type BallisticContact,
  type BallisticTunables,
} from '../core/ballistics';
import { createRayHit, raycastWorld, type RayHit, type StaticWorld } from '../core/collision';
import type { PlayerInputSource } from '../core/inputSource';
import { IMPACT_MIN_SPEED } from '../paint/soundEvents';
import type { MovementTunables, Stance } from '../player/controller';
import {
  CAN_CHARGE_SECONDS,
  CAN_LIFT_SPEED,
  CAN_MAT,
  CAN_MUZZLE_M,
  CAN_RACK_CAP,
  CAN_RADIUS,
  CAN_REACH,
  CAN_REARM_M,
  CAN_STACK_PITCH,
  CAN_THROW_MAX,
  CAN_THROW_MIN,
  type CanPose,
} from '../world/cans';

/** Anything with a position. `THREE.Vector3` satisfies it, and this file needs no more. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The body doing the throwing — the four things the hand asks of it.
 *
 * A structural interface rather than `PlayerController`, so a test can throw a can from an
 * arbitrary pose without standing a controller up, and so this file cannot reach for anything
 * else the body happens to expose.
 */
export interface Thrower {
  /** Feet, not eyes: the launch height is derived from the stance below. */
  readonly position: Vec3Like;
  readonly velocity: Vec3Like;
  readonly yaw: number;
  readonly pitch: number;
  readonly state: { readonly stance: Stance; readonly speed: number };
}

/**
 * Where a resting thing's geometry goes (`paint/prints.ts`).
 *
 * Named as a capability rather than imported as a class: the hand's business is knowing *when*
 * something is at rest, and the matter layer's is knowing what that looks like.
 */
export interface PrintSink {
  readonly capacity: number;
  place(id: number, x: number, y: number, z: number, radius: number): void;
  remove(id: number): void;
}

/**
 * One noise a can (or the arm about to throw one) made, for `game/sim.ts` to price and emit.
 *
 * Three kinds, because §3.3 has three rows for this verb: the wind-up the rig makes with its own
 * arm, the impact of a thing arriving somewhere fast, and the knock of a thing arriving somewhere
 * slowly — settling, being lifted, or touching down too softly to be an impact.
 */
export type ThrowSound =
  | {
      readonly kind: 'windup';
      /** `start` is the arm moving; `full` is the click at maximum tension — the charge meter. */
      readonly stage: 'start' | 'full';
      readonly x: number;
      readonly y: number;
      readonly z: number;
    }
  | {
      readonly kind: 'impact';
      readonly can: number;
      readonly x: number;
      readonly y: number;
      readonly z: number;
      /** The struck face's normal — see `knock` below for why a contact sound carries one. */
      readonly nx: number;
      readonly ny: number;
      readonly nz: number;
      /** Approach speed, m/s — what §3.3's 8-12 m band is a function of. */
      readonly speed: number;
      /** The struck surface (§3.9). The can's own voice is `CAN_MAT` and the sim supplies it. */
      readonly mat: number;
    }
  | {
      readonly kind: 'knock';
      readonly can: number;
      readonly x: number;
      readonly y: number;
      readonly z: number;
      /**
       * The struck face's normal.
       *
       * Carried because a contact point lies exactly *on* a face, and a point source on a plane
       * grazes that plane at 90° everywhere: measured, an impact emitted from y = 0 on the floor
       * unlocks **zero** dots out of 33 880 rays, and the same impact one millimetre up unlocks
       * 39 362. `sim.ts` stands the sound off along this normal, which is the same job
       * `STEP_HEIGHT` does for a footfall — and it needs a direction, because unlike a footfall a
       * can strikes walls and ceilings too.
       */
      readonly nx: number;
      readonly ny: number;
      readonly nz: number;
      readonly mat: number;
    };

/**
 * Emitter ids for cans, well clear of `PLAYER_EMITTER_ID`.
 *
 * Load-bearing, not cosmetic. `GameSim.onOwnNoise` decides whether §3.8's Halo flares by
 * comparing `event.emitter` to the local player and nothing else, so a can that emitted as
 * emitter 0 would make the ring claim *you* were audible at 25 m the instant your can landed
 * across the room. The ring answers "how loud am I"; a can is not you the moment it leaves your
 * hand. The wind-up is the opposite case and does emit as the player: that noise is the rig's own
 * arm and it is exactly as much "you" as a footstep is.
 */
export const CAN_EMITTER_BASE = 1000;

/**
 * How much of the rig's momentum a boot gives a can, and how much of a hop.
 *
 * Above 1 because a kick is work done, not a transfer: you want the can to leave, and a can that
 * merely matched your speed would stay under your feet for the whole sprint, re-triggering the
 * contact rule every time the re-arm distance lapsed. The lift is small — a can skittering across
 * a floor, never a punted football (§13: no ragdoll comedy).
 */
const KICK_KEEP = 1.25;
const KICK_LIFT = 1.5;

/**
 * The support rule, in two distances — what "resting on" means when nothing is a collider.
 *
 * A can counts as held up by another can if it is above it, within `SUPPORT_ABOVE` vertically and
 * `SUPPORT_SPREAD` horizontally. Both are cut from `CAN_STACK_PITCH` because a stack is the only
 * thing this rule exists to describe: the spread is one whole pitch, which comfortably contains
 * the 2-4 cm of authored lean, and the reach is one and a half, so a column finds the can
 * directly above it and never the one two places up.
 */
const SUPPORT_SPREAD = CAN_STACK_PITCH;
const SUPPORT_ABOVE = CAN_STACK_PITCH * 1.5;

/**
 * How far down a freshly spawned can looks for the surface it is standing on, metres.
 *
 * Deliberately shorter than `CAN_STACK_PITCH`: a can placed on the floor finds the floor and
 * takes its material, and a can placed on top of another one finds nothing and falls back to
 * `CAN_MAT` — metal on metal, which is what it is actually resting on. Only the *lift* knock
 * reads this; every other material comes from a contact the physics resolved.
 */
const SUPPORT_PROBE = CAN_RADIUS;

/** Launch speed for a charge held `chargeSeconds`, m/s — `world/cans.ts`'s curve, evaluated. */
export function throwSpeed(chargeSeconds: number): number {
  const k = Math.min(1, Math.max(0, chargeSeconds / CAN_CHARGE_SECONDS));
  return CAN_THROW_MIN + (CAN_THROW_MAX - CAN_THROW_MIN) * k;
}

interface Can {
  readonly body: BallisticBody;
  /** In the world at all. A slot that is not live is in the rack or has never been used. */
  live: boolean;
  /** Past the re-arm distance since it was released, and therefore touchable. */
  armed: boolean;
  /** Settled, with a print laid at its pose. */
  settled: boolean;
  /** One settle sound per flight — see `onContact`. */
  settleLatched: boolean;
  /** The surface it came to rest on, for the knock it makes when picked up off it (§3.9). */
  restMat: number;
}

function makeCan(): Can {
  return {
    body: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false, asleep: true },
    live: false,
    armed: false,
    settled: false,
    settleLatched: false,
    restMat: CAN_MAT,
  };
}

/** A can's pose and status, for `debugState` and for the browser suite's screen projection. */
export interface CanReadout {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly armed: boolean;
  readonly asleep: boolean;
  readonly settled: boolean;
}

export class Throwables {
  /** Every noise made during the last `update`, oldest first. Cleared at the top of each one. */
  readonly sounds: ThrowSound[] = [];

  readonly tunables: BallisticTunables = defaultBallisticTunables();

  private readonly world: StaticWorld;
  private readonly thrower: Thrower;
  private readonly movement: MovementTunables;
  private readonly prints: PrintSink;
  /** The authored cans this world starts (and restarts) with. */
  private readonly boot: readonly CanPose[];

  private readonly cans: Can[] = [];
  private readonly contacts: BallisticContact[] = [];
  private readonly wakeStack: number[] = [];
  private readonly hit: RayHit = createRayHit();

  private rack = CAN_RACK_CAP;
  private winding = false;
  private chargeSeconds = 0;
  private atFullTension = false;
  /** F pressed with an empty rack. Nothing happens in the world; this is the only witness. */
  private refusals = 0;
  private thrownCount = 0;

  /** The stance and ground speed the tick started with, read once (the getter allocates). */
  private stance: Stance = 'stand';
  private groundSpeed = 0;

  constructor(options: {
    world: StaticWorld;
    thrower: Thrower;
    movement: MovementTunables;
    prints: PrintSink;
    boot?: readonly CanPose[];
  }) {
    this.world = options.world;
    this.thrower = options.thrower;
    this.movement = options.movement;
    this.prints = options.prints;
    this.boot = options.boot ?? [];

    /*
     * Enough slots for the world as booted — every authored can, plus a full rack — allocated
     * up front so the common case never allocates mid-tick. `spawnAt` can push past it (a room
     * that grew a second stack, a test building its own), and `freeSlot` grows the pool for it;
     * the real ceiling is the print layer's, because a can past that capacity would rest
     * somewhere and lay no cairn, which is a can that exists and can never be perceived.
     */
    const pool = this.boot.length + CAN_RACK_CAP;
    for (let i = 0; i < pool; i++) this.cans.push(makeCan());
    if (pool > this.prints.capacity) {
      throw new Error(
        `Throwables: ${pool} can slots but the print layer holds ${this.prints.capacity}. ` +
          'Cans past the capacity would be silently invisible — raise RestingPrints capacity.',
      );
    }
    this.spawnBoot();
  }

  // ---- readouts -------------------------------------------------------------

  /** Cans in the rack (§9's readout is a later job; this is the number behind it). */
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
    return Math.min(1, this.chargeSeconds / CAN_CHARGE_SECONDS);
  }

  /** What a release right now would launch at, m/s. Zero while the arm is still. */
  get pendingSpeed(): number {
    return this.winding ? throwSpeed(this.chargeSeconds) : 0;
  }

  get inWorld(): number {
    let n = 0;
    for (const can of this.cans) if (can.live) n++;
    return n;
  }

  get thrown(): number {
    return this.thrownCount;
  }

  /** Times F was pressed with an empty rack — a refusal leaves no other trace, by design. */
  get refused(): number {
    return this.refusals;
  }

  cansSnapshot(): CanReadout[] {
    const out: CanReadout[] = [];
    for (let id = 0; id < this.cans.length; id++) {
      const can = this.cans[id]!;
      if (!can.live) continue;
      out.push({
        id,
        x: can.body.x,
        y: can.body.y,
        z: can.body.z,
        armed: can.armed,
        asleep: can.body.asleep,
        settled: can.settled,
      });
    }
    return out;
  }

  /** The live body behind a slot, or `null`. For tests and tooling; never mutate it. */
  canAt(id: number): BallisticBody | null {
    const can = this.cans[id];
    return can !== undefined && can.live ? can.body : null;
  }

  // ---- the tick -------------------------------------------------------------

  /**
   * One fixed tick of the hand: charge (which may launch), fly, then retrieve.
   *
   * Called from `GameSim.tick` *before* `player.update`, on the body the tick started with — the
   * same rule the pings follow, and for the same reason: a throw is aimed at what the player was
   * looking at when they let go, not at where the next tick's look put them.
   *
   * Flight before retrieval, so a can rolling into your feet is picked up on the tick it arrives
   * rather than the one after.
   */
  update(dt: number, input: PlayerInputSource): void {
    this.sounds.length = 0;
    const st = this.thrower.state;
    this.stance = st.stance;
    this.groundSpeed = st.speed;
    this.advanceCharge(dt, input);
    this.integrate(dt);
    this.retrieve();
  }

  /**
   * Back to the start of a run: every can in the world despawns, the authored ones come back
   * where the author put them, the rack refills and the arm drops.
   *
   * The authored stack is restored rather than left cleared because R is a *respawn* — the
   * situation is being re-run, and a tower whose props evaporated the first time you died would
   * make the reset destructive. What is deliberately not restored is knowledge: a restored can
   * lays an unstamped print, so you no longer know where the stack is until something is loud
   * enough to tell you again. The cans really are new objects at new places; pretending you
   * remembered them would be the reveal drawing geometry no sound has bought (law 1).
   */
  reset(): void {
    for (let id = 0; id < this.cans.length; id++) {
      if (this.cans[id]!.live) this.despawn(id);
    }
    this.rack = CAN_RACK_CAP;
    this.winding = false;
    this.chargeSeconds = 0;
    this.atFullTension = false;
    this.sounds.length = 0;
    this.spawnBoot();
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
         * happen.
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
      if (!this.atFullTension && this.chargeSeconds >= CAN_CHARGE_SECONDS) {
        this.atFullTension = true;
        /*
         * The charge meter, and the whole of it. There is no bar: charging is audible exactly
         * twice — the arm starting, and the click at maximum tension — and between them the
         * player estimates, which is the same skill the throw itself is. A continuous readout
         * would price the estimate out of the verb; a continuous *sound* would also be a
         * continuous paint source at the thrower's own feet, which is the one thing
         * `world/cans.ts` says a throw must never be.
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
   * Lets one go: origin at the eye, `CAN_MUZZLE_M` along the aim, at the charged speed.
   *
   * **A throw is never refused and never quietly downgraded.** Release with a wall 30 cm away and
   * the sweep below spawns the can at whatever clearance actually exists — flush against the
   * wall if that is all there is — and it still leaves the hand at full charged speed, so it
   * still makes the full impact, the full paint and the full hearing radius, on you. That is the
   * price of throwing into a wall and it is a price the player can learn. A refusal would be the
   * game silently declining an input, which teaches nothing.
   *
   * The can takes none of the rig's own velocity, and that is a design choice rather than an
   * omission: the charge curve is the entire contract between the player and the range, and it is
   * read *by ear* — you learn a full charge from where the clang lands. Adding 6 m/s of sprint to
   * an 18 m/s throw would move that landing point by three quarters of a room with no readout for
   * it, and there is no arc preview to fall back on. If playtests want a running throw to carry,
   * the honest version is a fraction of the forward component with the Halo-style readout to
   * match, not a silent addition.
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
    // and spends its first ticks walking out of the wall.
    const blocked = raycastWorld(this.world, ox, oy, oz, ax, ay, az, CAN_MUZZLE_M, this.hit);
    const reach = blocked === null ? CAN_MUZZLE_M : Math.max(0, blocked.t - this.tunables.skin);
    const speed = throwSpeed(this.chargeSeconds);

    const id = this.freeSlot();
    const can = this.cans[id]!;
    const b = can.body;
    b.x = ox + ax * reach;
    b.y = oy + ay * reach;
    b.z = oz + az * reach;
    b.grounded = false;
    can.live = true;
    // Inert until it has been `CAN_REARM_M` away at least once: without it, a can released at
    // your feet is re-collected on the next tick and the throw-cancel becomes a stutter.
    can.armed = false;
    can.settled = false;
    can.settleLatched = false;
    can.restMat = CAN_MAT;
    this.prints.remove(id);
    wakeBallistic(b, ax * speed, ay * speed, az * speed);
    this.rack--;
    this.thrownCount++;
  }

  // ---- flight ---------------------------------------------------------------

  private integrate(dt: number): void {
    for (let id = 0; id < this.cans.length; id++) {
      const can = this.cans[id]!;
      if (!can.live || can.body.asleep) continue;
      stepBallistic(this.world, can.body, dt, this.contacts, this.tunables);
      for (const c of this.contacts) this.onContact(id, can, c);
    }
  }

  /**
   * One contact, priced.
   *
   * **Flight itself is silent.** There is no row here for "in the air": between the tick a can is
   * launched and the tick it first touches something, this function is not called and the bus
   * does not move. A thrown can is invisible in flight to everyone including the thrower, which
   * is what makes the landing point information rather than a trail.
   */
  private onContact(id: number, can: Can, c: BallisticContact): void {
    // §3.3 prices contacts, and a graze is not one: `ballistics.ts` records it for observability
    // at exactly the moments nothing struck anything — a body separated from a face it was
    // already touching, or a slide along a wall it never approached. Voicing it would put a sound
    // in the world with no impact behind it (law 2).
    if (c.kind === 'graze') return;

    if (c.kind === 'rest') {
      /*
       * **Exactly one settle per flight, latched here.**
       *
       * `stepBallistic` fires `rest` once and sleeps the body on the same line, so today the
       * latch never fires. It is not redundant: "once" is currently a property of code this file
       * does not own, and the whole retrieval promise — a can that is somewhere you can go and
       * get it — rests on a print being laid once at one pose. A future integrator that settles,
       * micro-rolls and re-settles would otherwise pay a knock per settle, relay the print each
       * time, and turn a quiet arrival into a stutter of clinks. One flight, one arrival.
       */
      if (can.settleLatched) return;
      can.settleLatched = true;
      can.settled = true;
      can.restMat = c.box.mat;
      /*
       * The print goes down in the tick the can arrives, and that is load-bearing: `sim.ts`
       * drains this queue onto the bus at the end of the same tick, bus fan-out is synchronous,
       * and `RestingPrints.handle` decides right then whether the settle knock reached this
       * cairn. Lay it a tick later and the can misses its own arrival and lands dark.
       *
       * The order *within* this function is not what protects that — the queue is — and this
       * comment used to claim otherwise. `tests/throwables.test.ts` pins the claim that is real:
       * a can that lands within `prop-knock`'s carry lights its own cairn, with no ping.
       */
      this.prints.place(id, c.x, c.y, c.z, CAN_RADIUS);
      this.sounds.push({
        kind: 'knock',
        can: id,
        x: c.x,
        y: c.y,
        z: c.z,
        nx: c.nx,
        ny: c.ny,
        nz: c.nz,
        mat: c.box.mat,
      });
      return;
    }

    /*
     * A bounce or a touchdown. §3.3's `prop-impact` band starts at `IMPACT_MIN_SPEED` and
     * `SoundBus.impactRadius` expects its caller to have gated there — "under it there is no
     * event at all, which is the quiet set-down".
     *
     * `ballistics.ts` asks for the opposite and has a measurement behind it: touchdowns are
     * recorded "unconditionally, however soft, and the emitter is expected to voice every one of
     * them", because a loudness gate left a can 2.56 m from the last thing that painted it. Both
     * are right about different things — one about not firing an 8 m flashbulb for a can set
     * gently on the floor, the other about never losing a can in the dark.
     *
     * They reconcile in the table rather than in a threshold: below the impact band a contact is
     * still voiced, as a `prop-knock` — §3.3's quiet contact row, 1.5 m of paint, the same class
     * a settle makes. Every touchdown is heard, nothing under the band is a flashbulb, and
     * neither file's contract is bent.
     */
    if (c.speed >= IMPACT_MIN_SPEED) {
      this.sounds.push({
        kind: 'impact',
        can: id,
        x: c.x,
        y: c.y,
        z: c.z,
        nx: c.nx,
        ny: c.ny,
        nz: c.nz,
        speed: c.speed,
        mat: c.box.mat,
      });
      return;
    }
    this.sounds.push({
      kind: 'knock',
      can: id,
      x: c.x,
      y: c.y,
      z: c.z,
      nx: c.nx,
      ny: c.ny,
      nz: c.nz,
      mat: c.box.mat,
    });
  }

  // ---- retrieval ------------------------------------------------------------

  /**
   * The body meeting a can, and the one number that decides what happens.
   *
   * There is no pickup key (`world/cans.ts`): a key implies a prompt and a prompt implies the
   * game telling you a can is there, which the cairn already did. What decides lift-or-kick is
   * the rig's own ground speed against `CAN_LIFT_SPEED` — walk into your can and you collect it,
   * sprint into it and you boot it, and the same number brings a stack down on someone who runs
   * the lane blind.
   *
   * The **highest** can in reach is the target, so lifting from a column takes it off the top and
   * the support rule has nothing to wake. Take one from underneath and everything above it comes
   * down, which is the point of stacking them — and which is why the reach below is a cylinder
   * rather than a ball, since a ball made "underneath" the only thing you could ever reach.
   */
  private retrieve(): void {
    const p = this.thrower.position;
    let best = -1;
    let bestY = -Infinity;
    for (let id = 0; id < this.cans.length; id++) {
      const can = this.cans[id]!;
      if (!can.live) continue;
      const b = can.body;
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const dz = b.z - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (!can.armed) {
        if (d2 > CAN_REARM_M * CAN_REARM_M) can.armed = true;
        continue;
      }
      /*
       * Reach is a **cylinder** around the feet, not a ball: `CAN_REACH` sideways and
       * `CAN_REACH` up, tested separately.
       *
       * From the feet, because that is where `position` is and because measuring from a
       * mid-body point would put a can on the floor out of reach of a rig standing on top of
       * it. But a ball couples the two axes, and that coupling had a consequence nobody
       * intended: walking up to the authored column, the *nearest* can is always the bottom
       * one — at 0.6 m out the sphere has no height left for anything else — so the rule below
       * handed you the bottom of the stack and everything above it came down. Measured, before
       * this was a cylinder: four lifts bottom-upward and a `prop-impact` as the last can hit
       * the floor. The column was unmineable by design and collapsible by accident.
       *
       * A cylinder is also the honest shape. What a rig can reach vertically is how far it
       * stoops and how high it raises, and neither of those shrinks because it took a step
       * sideways. With the axes uncoupled, approaching the column puts every can in reach at
       * once and the highest-first rule below finally means what it says.
       */
      if (Math.abs(dy) > CAN_REACH) continue;
      if (dx * dx + dz * dz > CAN_REACH * CAN_REACH) continue;
      if (b.y > bestY) {
        bestY = b.y;
        best = id;
      }
    }
    if (best < 0) return;
    if (this.groundSpeed < CAN_LIFT_SPEED) this.lift(best);
    else this.kick(best);
  }

  /**
   * Into the rack. A full rack cannot lift — and does not need to say so, because the can is
   * still there and the player is still walking over it. It can still be kicked.
   */
  private lift(id: number): void {
    if (this.rack >= CAN_RACK_CAP) return;
    const can = this.cans[id]!;
    const b = can.body;
    this.rack++;
    // Picking up emits. A can leaving a surface is a contact like any other, and the material is
    // the surface it left — the reason your own retrieval is audible, and priced.
    // Straight up: a can is lifted off whatever it was lying on, and there is no contact record
    // to take a normal from because nothing struck anything.
    this.sounds.push({
      kind: 'knock',
      can: id,
      x: b.x,
      y: b.y,
      z: b.z,
      nx: 0,
      ny: 1,
      nz: 0,
      mat: can.restMat,
    });
    const x = b.x;
    const y = b.y;
    const z = b.z;
    this.despawn(id);
    this.wakeSupported(x, y, z);
  }

  /** Booted: the can takes the rig's momentum and a small hop, loudly, and disarms itself. */
  private kick(id: number): void {
    const can = this.cans[id]!;
    const b = can.body;
    const v = this.thrower.velocity;
    this.prints.remove(id);
    can.settled = false;
    can.settleLatched = false;
    // Disarmed, or a sprint that keeps pace with the can it just kicked re-kicks it every tick
    // the contact test passes. The re-arm distance is already the rule for "you let go of this";
    // a boot is letting go of it hard.
    can.armed = false;
    b.grounded = false;
    wakeBallistic(b, v.x * KICK_KEEP, KICK_LIFT, v.z * KICK_KEEP);
    this.sounds.push({
      kind: 'impact',
      can: id,
      x: b.x,
      y: b.y,
      z: b.z,
      nx: 0,
      ny: 1,
      nz: 0,
      // The approach speed is the rig's, because the can was not going anywhere: the same band a
      // thrown can's landing is priced in, read from the other side of the contact.
      speed: this.groundSpeed,
      mat: can.restMat,
    });
    this.wakeSupported(b.x, b.y, b.z);
  }

  /**
   * Whatever was resting on the pose that just emptied, and whatever was resting on *that*.
   *
   * Cans are points and hold nothing up physically, so a column is only a column because every
   * can in it is asleep. Take one out and the ones above it have to be told; the cascade is
   * iterative rather than recursive so a tall stack cannot put a depth of frames on the stack,
   * and the `asleep` re-test on pop makes a can pushed twice a no-op rather than a loop.
   *
   * They are woken at rest, with no impulse: what brings a stack down is gravity, and the noise
   * it makes is the noise of each can hitting whatever it hits. Nothing here decides how loud a
   * collapse is — the drop does.
   */
  private wakeSupported(x: number, y: number, z: number): void {
    this.wakeStack.length = 0;
    this.collectSupported(x, y, z);
    while (this.wakeStack.length > 0) {
      const id = this.wakeStack.pop()!;
      const can = this.cans[id]!;
      if (!can.live || !can.body.asleep) continue;
      const b = can.body;
      this.prints.remove(id);
      can.settled = false;
      can.settleLatched = false;
      b.grounded = false;
      wakeBallistic(b, 0, 0, 0);
      this.collectSupported(b.x, b.y, b.z);
    }
  }

  private collectSupported(x: number, y: number, z: number): void {
    for (let id = 0; id < this.cans.length; id++) {
      const can = this.cans[id]!;
      if (!can.live || !can.body.asleep) continue;
      const b = can.body;
      const dy = b.y - y;
      if (dy <= 0 || dy > SUPPORT_ABOVE) continue;
      if (Math.abs(b.x - x) > SUPPORT_SPREAD) continue;
      if (Math.abs(b.z - z) > SUPPORT_SPREAD) continue;
      this.wakeStack.push(id);
    }
  }

  // ---- pool -----------------------------------------------------------------

  /**
   * Puts a can in the world asleep at a pose, already at rest, with its print laid but unheard.
   *
   * Public because a test spawns its own stacks: the authored one belongs to `world/room.ts` and
   * this file is deliberately not wired to it, so the stack rules are proved against cans the
   * test placed rather than against a room that is still being written.
   */
  spawnAt(x: number, y: number, z: number): number {
    const id = this.freeSlot();
    const can = this.cans[id]!;
    const b = can.body;
    b.x = x;
    b.y = y;
    b.z = z;
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    b.grounded = true;
    b.asleep = true;
    can.live = true;
    // Authored cans are touchable immediately: the re-arm rule is about things *you* let go of.
    can.armed = true;
    can.settled = true;
    can.settleLatched = true;
    const support = raycastWorld(this.world, x, y, z, 0, -1, 0, SUPPORT_PROBE, this.hit);
    can.restMat = support === null ? CAN_MAT : support.box.mat;
    // Laying a print stamps nothing (`paint/prints.ts`), so a room full of authored cans is a
    // room full of things you have not heard. Law 1 pays for each of them or none of them exist.
    this.prints.place(id, x, y, z, CAN_RADIUS);
    return id;
  }

  private spawnBoot(): void {
    for (const pose of this.boot) this.spawnAt(pose.x, pose.y, pose.z);
  }

  private despawn(id: number): void {
    const can = this.cans[id]!;
    can.live = false;
    can.settled = false;
    can.settleLatched = false;
    can.armed = false;
    can.body.asleep = true;
    this.prints.remove(id);
  }

  private freeSlot(): number {
    for (let id = 0; id < this.cans.length; id++) if (!this.cans[id]!.live) return id;
    // Grow rather than refuse: a throw that silently did nothing is the worst failure this verb
    // has. The one hard stop is the print layer — past its capacity a can would come to rest and
    // lay no cairn, and a thing that exists and cannot be perceived is worse than a crash.
    if (this.cans.length >= this.prints.capacity) {
      throw new Error(
        `Throwables: ${this.cans.length} cans is the print layer's whole capacity. ` +
          'One more would rest somewhere and never be drawn — raise RestingPrints capacity.',
      );
    }
    this.cans.push(makeCan());
    return this.cans.length - 1;
  }
}
