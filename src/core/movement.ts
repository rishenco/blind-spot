/**
 * First-person capsule controller + camera energy (vision §5, engine-plan §5).
 *
 * Law 5 governs every decision here: movement stays genuinely good. Speed is the fantasy,
 * information is the tension — so nothing in this file rations movement. No fall damage, no
 * encumbrance, no stamina; the only cost a landing carries is a 0.3 s stagger above 4 m, and
 * the only cost of speed is that speed is LOUD. Sprinting lights your path ~7 m ahead per
 * footfall (vision §3.3): moving fast *is* scanning, which is why the emitters below are the
 * other half of this module — you do not get to move without publishing where you are.
 *
 * Everything runs on the fixed 60 Hz step (sim.ts). One step, in order:
 *
 *   1. look           mouse deltas -> yaw/pitch (consumed, so a catch-up frame cannot double-apply)
 *   2. timers         stagger, coyote, jump buffer, approach latch
 *   3. exclusive      mantle glide / ladder climb own the step outright and return early
 *   4. stance         slide entry+decay+exit, crouch/stand gated on headroom
 *   5. verbs          mantle/vault trigger (BEFORE jump: a ledge you are facing wins) -> mantle
 *                     event; jump -> takeoff step event
 *   6. accelerate     ground accel or Source-style air accel, overspeed bleed, gravity
 *   7. move           collide-and-slide with step-up (map/build.ts owns the geometry)
 *   8. land           grounded transition -> landing event (+ stagger > 4 m)
 *   9. stride         distance accumulators -> footstep / slide events
 *
 * Emission order inside a step is therefore always: verb events (mantle, jump takeoff) first,
 * then landing, then stride/slide. Consumers may rely on that (M3 paint, audio). A takeoff and a
 * landing can never share a step: the jump sets vy = +JUMP_VELOCITY and gravity only takes
 * GRAVITY*dt off it, so the body is unambiguously airborne when phase 8 runs.
 */

import {
  ACCEL_AIR,
  ACCEL_GROUND,
  APPROACH_LATCH_TIME,
  EV,
  AIR_WISH_CAP,
  CAPSULE_RADIUS,
  COYOTE_TIME,
  EYE_CROUCH,
  EYE_SMOOTH,
  EYE_STAND,
  FOV_BASE,
  FOV_SMOOTH,
  FOV_SPRINT_KICK,
  FRICTION_GROUND,
  GLIDE_ARC_SAMPLES,
  GLIDE_XZ_START,
  GLIDE_Y_END,
  GRAVITY,
  GROUND_PROBE_FRAC,
  GROUND_SNAP,
  HEAD_BOB_MAX,
  HEIGHT_CROUCH,
  HEIGHT_STAND,
  JUMP_BUFFER,
  JUMP_VELOCITY,
  LADDER_ATTACH_DOT,
  LADDER_EXIT_REACH,
  LANDING_DIP_DECAY,
  LANDING_DIP_MAX,
  LANDING_MAX_FALL,
  LANDING_MIN_FALL,
  LANDING_STAGGER_FALL,
  LANDING_STAGGER_TIME,
  MANTLE_DURATION,
  MANTLE_MAX_HEIGHT,
  MANTLE_MIN_HEIGHT,
  MANTLE_SCAN_AHEAD,
  OVERSPEED_DECAY,
  PITCH_LIMIT,
  SLIDE_BOOST_SPEED,
  SLIDE_DECAY,
  SLIDE_ENTRY_SPEED,
  SLIDE_MIN_SPEED,
  SLIDE_STEER_RATE,
  SLIDE_STRIDE,
  SLIDE_TILT_DEG,
  SPEED_CROUCH,
  SPEED_LADDER,
  SPEED_SPRINT,
  SPEED_WALK,
  STEP_UP_MAX,
  STRIDE_CROUCH,
  STRIDE_SPRINT,
  STRIDE_WALK,
  TILT_SMOOTH,
  VAULT_DURATION,
  VAULT_MAX_HEIGHT,
} from './const.js';
import type { EventBus, SoundClass } from './events.js';
import { clamp, clamp01, damp, invLerp, lerp, smoothstep, yawToForward } from './math.js';
import {
  capsuleOverlaps,
  groundUnder,
  headroom,
  ladderAt,
  ledgeProbe,
  moveCapsule,
  resolvePenetration,
  type LadderVolume,
  type World,
} from './map/build.js';
import type { PlayerState } from './sim.js';

const PROBE_R = CAPSULE_RADIUS * GROUND_PROBE_FRAC;
const EPS = 1e-6;
/**
 * How far the eye sits below the crown of the capsule. Identical standing (1.70 - 1.62) and
 * crouched (1.10 - 1.02), which makes it the natural margin for holding the camera off a
 * ceiling: the eye keeps exactly the clearance from a duct that it keeps from your own head.
 */
const EYE_HEAD_GAP = HEIGHT_STAND - EYE_STAND;

export type Gait = 'crouch' | 'walk' | 'sprint';
/** Rig state for the hands (engine-plan §6 — M4 builds the rig; M2 provides the trigger). */
export type HandsState = 'none' | 'mantle' | 'vault' | 'ladder';

/**
 * How loud a body moving at `speed` is, per the vision §5 speed bands (1.7 / 3.5 / 6.0 m/s).
 *
 * The KEYS choose your target speed; the BODY chooses your volume. Those are not the same thing
 * and deriving the event class from the keys is a lie the moment they disagree — inherited
 * overspeed (a slide-jump landing at 7.4 m/s with no sprint key held) would whisper walk-step
 * paint while travelling faster than a sprint, and a sprint key held against a wall at 0.2 m/s
 * would shout. Vision §1.2: the system never lies. Vision §3.8 makes this load-bearing rather
 * than pedantic — the M4 Halo IS "brightness = your current audible radius", so the class the
 * emitter picks has to be true of the body by construction, not by intent.
 *
 * A crouched STANCE still forces the crouch row: sneaking is a posture, and a crouched body
 * never publishes more than crouch-step paint however fast something else made it travel.
 */
export function gaitForSpeed(speed: number, crouched: boolean): Gait {
  if (crouched) return 'crouch';
  if (speed <= SPEED_CROUCH + EPS) return 'crouch';
  if (speed <= SPEED_WALK + EPS) return 'walk';
  return 'sprint';
}

/** The vision §3.3 footstep row for a gait. */
export const stepClass = (gait: Gait): SoundClass =>
  gait === 'crouch' ? 'crouchStep' : gait === 'sprint' ? 'sprintStep' : 'walkStep';

/**
 * One frame of intent. `jumpPressed` and the look deltas are EDGE values: the controller
 * consumes (zeroes) them, so an input collected between two fixed steps is applied exactly once
 * no matter how many steps the frame ends up running.
 */
export interface MoveInput {
  /** -1..1, +1 = the way you are looking. */
  forward: number;
  /** -1..1, +1 = your right hand. */
  right: number;
  jumpPressed: boolean;
  crouch: boolean;
  sprint: boolean;
  yawDelta: number;
  pitchDelta: number;
}

export const makeInput = (): MoveInput => ({
  forward: 0,
  right: 0,
  jumpPressed: false,
  crouch: false,
  sprint: false,
  yawDelta: 0,
  pitchDelta: 0,
});

interface Glide {
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
  t: number;
  dur: number;
  /** Speed to hand back on arrival — a vault must not cost you your run. */
  exitSpeed: number;
}

export class MovementController {
  readonly world: World;
  readonly player: PlayerState;
  readonly bus: EventBus;

  /** Current capsule height — HEIGHT_STAND or HEIGHT_CROUCH. Feet stay put across a change. */
  height = HEIGHT_STAND;
  /** Posture intent, separate from `player.stance` (which also reports air/ladder). */
  crouched = false;
  sliding = false;
  gait: Gait = 'walk';
  speedXZ = 0;

  /** Distance banked toward the next footstep / slide event. */
  strideAccum = 0;
  slideAccum = 0;

  coyote = 0;
  jumpBuffer = 0;
  staggerTime = 0;
  slideSpeed = 0;
  /** Highest point since leaving the ground — the fall height's origin. */
  apexY = 0;
  /** Fall height of the most recent landing (metres). 0 until you land. */
  lastFall = 0;
  /** 0..1 landing severity, produced on landing and consumed by the camera rig. */
  landingImpulse = 0;

  hands: HandsState = 'none';
  /** 0..1 through the current hands animation. */
  handsPhase = 0;

  ladder: LadderVolume | null = null;
  private glide: Glide | null = null;
  /** A wall stopped us while we were pushing into it — the auto-vault trigger. */
  private blockedForward = false;
  /**
   * The speed we were carrying into that wall, sampled BEFORE the collision response zeroed it.
   * A vault triggers on the step after the block, by which time the run is already gone from the
   * velocity — handing this back on exit is what stops a knee-high crate from confiscating a
   * sprint (law 5).
   *
   * LATCHED, not sampled: it is held for APPROACH_LATCH_TIME after contact rather than being
   * dropped the instant `blockedForward` goes false. A mantle is triggered by a jump PRESS, and
   * the press lands wherever the player's hand lands — one frame late and the un-latched version
   * handed back whatever the wall had left of your run (measured: 0.667 m/s instead of 3.5). The
   * window matches the jump buffer's forgiveness on the other side of the same input.
   */
  private approachSpeed = 0;
  private approachLatch = 0;

  constructor(world: World, player: PlayerState, bus: EventBus) {
    this.world = world;
    this.player = player;
    this.bus = bus;
    this.apexY = player.y;
  }

  get mantling(): boolean {
    return this.glide !== null;
  }

  /** Eye offset above the feet for the current posture (the rig smooths toward this). */
  get eyeTarget(): number {
    return this.crouched || this.sliding ? EYE_CROUCH : EYE_STAND;
  }

  /**
   * Ceiling clearance above the feet, in metres, saturating just above a standing body — the
   * same probe the stand-up gate uses. The camera rig clamps the eye against it so a smoothed
   * eye height can never lag its way through a duct the capsule has already ducked under.
   */
  get clearance(): number {
    const p = this.player;
    return headroom(this.world, p.x, p.z, p.y, CAPSULE_RADIUS, HEIGHT_STAND + 0.05);
  }

  /** Metres between footstep events at the current gait (vision §3.3 / engine-plan §5). */
  get strideLength(): number {
    return this.gait === 'crouch' ? STRIDE_CROUCH : this.gait === 'sprint' ? STRIDE_SPRINT : STRIDE_WALK;
  }

  update(dt: number, input: MoveInput): void {
    const p = this.player;

    // 1. look ------------------------------------------------------------------------------
    if (input.yawDelta !== 0 || input.pitchDelta !== 0) {
      p.yaw = wrapAngle(p.yaw + input.yawDelta);
      p.pitch = clamp(p.pitch + input.pitchDelta, -PITCH_LIMIT, PITCH_LIMIT);
      input.yawDelta = 0;
      input.pitchDelta = 0;
    }

    // 2. timers ----------------------------------------------------------------------------
    this.staggerTime = Math.max(0, this.staggerTime - dt);
    this.approachLatch = Math.max(0, this.approachLatch - dt);
    if (this.approachLatch <= 0) this.approachSpeed = 0;
    if (input.jumpPressed) {
      this.jumpBuffer = JUMP_BUFFER;
      input.jumpPressed = false;
    } else {
      this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    }

    // 3. exclusive states ------------------------------------------------------------------
    if (this.glide) {
      this.stepGlide(dt);
      return;
    }
    if (this.ladder) {
      this.stepLadder(dt, input);
      return;
    }

    this.stepGround(dt, input);
  }

  // ----------------------------------------------------------------------------------------
  // Ground / air
  // ----------------------------------------------------------------------------------------

  private stepGround(dt: number, input: MoveInput): void {
    const p = this.player;
    const wasGrounded = p.grounded;

    // --- wish direction -------------------------------------------------------------------
    const [fx, , fz] = yawToForward(p.yaw);
    // Facing +x with +y up, your right hand points +z: right = (-fz, 0, fx).
    let wx = fx * input.forward - fz * input.right;
    let wz = fz * input.forward + fx * input.right;
    const wLen = Math.hypot(wx, wz);
    const wishMag = Math.min(1, wLen);
    if (wLen > EPS) {
      wx /= wLen;
      wz /= wLen;
    }

    // --- stance ---------------------------------------------------------------------------
    const speed0 = Math.hypot(p.vx, p.vz);
    const staggered = this.staggerTime > 0;

    if (
      !this.sliding &&
      input.crouch &&
      p.grounded &&
      !staggered &&
      speed0 >= SLIDE_ENTRY_SPEED &&
      this.canFit(p.x, p.y, p.z, HEIGHT_CROUCH)
    ) {
      this.sliding = true;
      this.crouched = true;
      this.height = HEIGHT_CROUCH;
      this.slideSpeed = Math.max(SLIDE_BOOST_SPEED, speed0);
      this.slideAccum = 0;
      const inv = speed0 > EPS ? this.slideSpeed / speed0 : 0;
      p.vx *= inv;
      p.vz *= inv;
    }

    if (this.sliding) {
      this.slideSpeed = Math.max(0, this.slideSpeed - SLIDE_DECAY * dt);
      if (!input.crouch || !p.grounded || this.slideSpeed <= SLIDE_MIN_SPEED) {
        this.sliding = false;
      }
    }

    if (!this.sliding) {
      if (input.crouch) {
        this.crouched = true;
        this.height = HEIGHT_CROUCH;
      } else if (this.crouched) {
        // Standing up is gated on headroom: under the duct you simply stay crouched.
        const clear = headroom(this.world, p.x, p.z, p.y, CAPSULE_RADIUS, HEIGHT_STAND + 0.05);
        if (clear >= HEIGHT_STAND - 1e-3) {
          this.crouched = false;
          this.height = HEIGHT_STAND;
        }
      }
    }

    // --- verbs ----------------------------------------------------------------------------
    // Mantle is checked BEFORE the jump: pressing jump at a ledge you are facing climbs it
    // rather than bouncing you off it (The Finals register).
    if (!this.sliding && !staggered && wishMag > 0.1 && this.tryMantle(wx, wz)) return;

    if (
      this.jumpBuffer > 0 &&
      !staggered &&
      (p.grounded || this.coyote > 0) &&
      this.canFit(p.x, p.y + 0.02, p.z, this.height)
    ) {
      // A jump is a shove against the floor, so law 1 applies: it costs a sound. It is emitted at
      // TAKEOFF — the shove is the noise, the airborne body is silent, and the landing has its
      // own row. Class comes from the body's speed as the feet leave (the same §5 bands the
      // stride emitter uses), FLOORED AT WALK: a standing vertical hop is still a forceful push
      // off the plates and is never crouch-quiet. No new §3.3 row — it reuses the step rows.
      // (See doc/engine-plan.md §5; vision §3.3 addendum pending playtest.)
      const takeoff = gaitForSpeed(Math.hypot(p.vx, p.vz), false);
      this.emit(takeoff === 'sprint' ? 'sprintStep' : 'walkStep');
      p.vy = JUMP_VELOCITY;
      p.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      // Jumping out of a slide keeps the boosted speed — momentum is never confiscated.
      this.sliding = false;
      this.apexY = p.y;
    }

    // --- accelerate -----------------------------------------------------------------------
    if (this.sliding) {
      // A slide runs its own decay law (SLIDE_DECAY, steerSlide) and is deliberately allowed
      // above every gait cap — the bleed below would double-decay it.
      this.steerSlide(dt, wx, wz, wishMag);
    } else {
      // Choosing a gait needs traction, so the cap is a GROUND concept. In the air there is no
      // gait to pick and the cap is simply the fastest one: air control may redirect velocity
      // freely (that is the whole point of air-strafing) but it may never ADD net speed past
      // SPEED_SPRINT. Without that ceiling the projection trick that the ground branch already
      // defends against works unopposed in the air — measured 19.4 m/s after 10 s of circle
      // strafing, 30.8 m/s after 30 s, from a 6.0 m/s sprint.
      const cap = !p.grounded
        ? SPEED_SPRINT
        : staggered || this.crouched
          ? SPEED_CROUCH
          : input.sprint && input.forward > 0
            ? SPEED_SPRINT
            : SPEED_WALK;
      const before = Math.hypot(p.vx, p.vz);
      const wishSpeed = cap * wishMag;
      if (p.grounded && wishSpeed > 0.01) {
        accelerate(p, wx, wz, wishSpeed, ACCEL_GROUND * dt);
        // `accelerate` only measures your speed ALONG wishdir, so any velocity across it is
        // invisible to the cap. Rub a wall at angle t and the projection equilibrates at
        // cap / cos(t) — 11 m/s against a 6 m/s sprint. Accel may therefore never RAISE your
        // speed past the cap; overspeed can only be inherited (a slide, a landing, a boost)
        // and, per the bleed below, only ever decays.
        clampSpeed(p, Math.max(cap, before));
      } else if (p.grounded) {
        const s = Math.hypot(p.vx, p.vz);
        if (s > EPS) {
          const ns = Math.max(0, s - FRICTION_GROUND * dt);
          p.vx *= ns / s;
          p.vz *= ns / s;
        }
      } else if (wishMag > 0.01) {
        // Source-style air control: you may only add speed along wishdir until your velocity
        // along it reaches AIR_WISH_CAP. Strafing turns you; holding forward does nothing.
        accelerate(p, wx, wz, Math.min(SPEED_SPRINT * wishMag, AIR_WISH_CAP), ACCEL_AIR * dt);
        clampSpeed(p, Math.max(cap, before));
      }
      // Excess speed bleeds instead of being clamped (const.ts OVERSPEED_DECAY) — and it bleeds
      // IN THE AIR TOO. This runs after the jump verb has already set `grounded = false`, so the
      // take-off frame of a bunny hop is bled like any other: inherited overspeed decays whether
      // or not your feet are down, and hopping can no longer freeze a 7.46 m/s slide boost.
      const s = Math.hypot(p.vx, p.vz);
      if (s > cap + EPS) {
        const ns = Math.max(cap, s - OVERSPEED_DECAY * dt);
        p.vx *= ns / s;
        p.vz *= ns / s;
      }
    }

    p.vy -= GRAVITY * dt;

    // --- move -----------------------------------------------------------------------------
    const x0 = p.x;
    const z0 = p.z;
    const approach = Math.hypot(p.vx, p.vz);
    const res = moveCapsule(
      this.world,
      p.x,
      p.y,
      p.z,
      p.vx * dt,
      p.vy * dt,
      p.vz * dt,
      CAPSULE_RADIUS,
      this.height,
      { stepUp: p.grounded ? STEP_UP_MAX : 0 },
    );
    p.x = res.x;
    p.y = res.y;
    p.z = res.z;

    if (res.hitWall) {
      const vn = p.vx * res.wallNX + p.vz * res.wallNZ;
      if (vn < 0) {
        p.vx -= res.wallNX * vn;
        p.vz -= res.wallNZ * vn;
      }
      if (this.sliding) this.slideSpeed = Math.min(this.slideSpeed, Math.hypot(p.vx, p.vz));
    }
    this.blockedForward =
      res.hitWall && wishMag > 0.1 && res.travelXZ < res.requestedXZ - 1e-3 && wx * res.wallNX + wz * res.wallNZ < 0;
    if (this.blockedForward) {
      // Latch, don't sample: hold the pre-collision approach speed for a window (the timer at
      // phase 2 expires it) so a mantle pressed a few frames after contact still exits running.
      this.approachSpeed = Math.max(this.approachSpeed, approach);
      this.approachLatch = APPROACH_LATCH_TIME;
    }

    if (res.hitCeiling && p.vy > 0) p.vy = 0;

    // --- ground state ---------------------------------------------------------------------
    let grounded = res.hitGround && p.vy <= EPS;
    if (grounded) p.vy = 0;
    if (!grounded && wasGrounded && p.vy <= 0) {
      // Walking off a step: snap down rather than launching into a 2 cm ballistic arc.
      const g = groundUnder(this.world, p.x, p.z, p.y, PROBE_R, GROUND_SNAP);
      if (g && g.y <= p.y + 0.02) {
        p.y = g.y;
        p.vy = 0;
        grounded = true;
      }
    }

    this.coyote = grounded ? COYOTE_TIME : Math.max(0, this.coyote - dt);
    if (!grounded) this.apexY = Math.max(this.apexY, p.y);

    // --- land -----------------------------------------------------------------------------
    if (grounded && !wasGrounded) {
      this.land(p.y);
    } else if (grounded) {
      this.apexY = p.y;
    }

    p.grounded = grounded;
    if (!grounded) this.sliding = false;
    p.stance = !grounded ? 'air' : this.sliding ? 'slide' : this.crouched ? 'crouch' : 'stand';

    // --- gait + emitters ------------------------------------------------------------------
    // The gait — and therefore both the event class and the stride length — is read off the
    // BODY, not off the keyboard (see `gaitForSpeed`). The keys still choose the target speed
    // above; they just no longer get to declare how loud the result was.
    this.speedXZ = Math.hypot(p.vx, p.vz);
    this.gait = gaitForSpeed(this.speedXZ, this.crouched);

    const moved = Math.hypot(p.x - x0, p.z - z0);
    if (this.sliding) {
      this.slideAccum += moved;
      while (this.slideAccum >= SLIDE_STRIDE) {
        this.slideAccum -= SLIDE_STRIDE;
        this.emit('slide');
      }
    } else if (grounded) {
      this.strideAccum += moved;
      let len = this.strideLength;
      while (this.strideAccum >= len) {
        this.strideAccum -= len;
        this.emit(stepClass(this.gait));
        len = this.strideLength;
      }
    }

    // Ladders are grabbed from the ground or from the air, but only deliberately: you have to
    // be pushing into the plane (vision §5 — ascending is the slow, quiet, chosen route).
    if (wishMag > 0.1) this.tryLadder(wx, wz);
  }

  /** A slide is a heavy carve, not a rail: direction turns at SLIDE_STEER_RATE, speed only decays. */
  private steerSlide(dt: number, wx: number, wz: number, wishMag: number): void {
    const p = this.player;
    let dx = p.vx;
    let dz = p.vz;
    const len = Math.hypot(dx, dz);
    if (len > EPS) {
      dx /= len;
      dz /= len;
    } else {
      const [fx, , fz] = yawToForward(p.yaw);
      dx = fx;
      dz = fz;
    }
    if (wishMag > 0.1) {
      const cur = Math.atan2(dz, dx);
      const want = Math.atan2(wz, wx);
      let diff = wrapAngle(want - cur);
      const max = SLIDE_STEER_RATE * dt;
      diff = clamp(diff, -max, max);
      const a = cur + diff;
      dx = Math.cos(a);
      dz = Math.sin(a);
    }
    p.vx = dx * this.slideSpeed;
    p.vz = dz * this.slideSpeed;
  }

  private land(y: number): void {
    const fall = Math.max(0, this.apexY - y);
    this.apexY = y;
    this.lastFall = fall;
    if (fall <= LANDING_MIN_FALL) return;
    // Below the landing threshold nothing happened worth hearing, so nothing is spent either:
    // the banked stride survives. Clearing it here made every step-down, kerb, ramp lip and
    // 1-frame ground-snap swallow the distance already walked toward the next footstep —
    // measured 0 events over 300 m of stepped corridor, a silent sprint, which is law 1
    // ("no free intel") failing in the player's favour. Only a real landing spends the bank,
    // and it spends it by replacing it with a louder event.
    this.strideAccum = 0;

    // vision §5: NO fall damage, ever. A big drop costs a 0.3 s stagger and a loud flash.
    const t = clamp01(invLerp(LANDING_MIN_FALL, LANDING_MAX_FALL, fall));
    this.landingImpulse = t;
    if (fall > LANDING_STAGGER_FALL) this.staggerTime = LANDING_STAGGER_TIME;
    this.emit('landing', lerp(EV.landing.paint, EV.landing.paintMax, t));
  }

  // ----------------------------------------------------------------------------------------
  // Mantle / vault / ledge-grab
  // ----------------------------------------------------------------------------------------

  /**
   * One probe answers all three verbs — they differ only in what triggers them:
   *   vault   (<= VAULT_MAX_HEIGHT)  automatic when you run into it, fast, keeps your speed
   *   mantle  (<= MANTLE_MAX_HEIGHT) needs a jump press
   *   ledge-grab                     the airborne case: falling past a lip catches it
   */
  private tryMantle(wx: number, wz: number): boolean {
    const p = this.player;
    const falling = !p.grounded && p.vy <= 0;
    const wantsJump = this.jumpBuffer > 0;
    if (!wantsJump && !this.blockedForward && !falling) return false;
    // Crouched under something with no room to stand: the pull-up has nowhere to put you.
    if (this.height !== HEIGHT_STAND && !this.canStand()) return false;

    const hit = ledgeProbe(this.world, p.x, p.y, p.z, wx, wz, CAPSULE_RADIUS, HEIGHT_STAND, {
      ahead: MANTLE_SCAN_AHEAD,
      minHeight: MANTLE_MIN_HEIGHT,
      maxHeight: MANTLE_MAX_HEIGHT,
    });
    if (!hit) return false;

    const vault = hit.height <= VAULT_MAX_HEIGHT;
    // Tall ledges are never automatic — running past a 2 m machine must not climb it.
    if (!vault && !wantsJump && !falling) return false;

    // The whole arc has to be clear, not just its endpoint. `ledgeProbe` proves a standing body
    // FITS ON TOP; it says nothing about the path taken to get there, and the glide is authored
    // rather than simulated, so nothing downstream will catch a body that sweeps through a slab
    // on the way up. Decide here and never abort mid-glide: a refused mantle leaves you standing
    // at the wall with your run intact, a cancelled one drops you out of an animation.
    if (!this.arcClear(p.x, p.y, p.z, hit.x, hit.topY, hit.z)) return false;

    this.jumpBuffer = 0;
    this.crouched = false;
    this.height = HEIGHT_STAND;
    const speed = Math.max(Math.hypot(p.vx, p.vz), this.approachSpeed);
    // A braced heave onto a ledge is a real, audible act (law 1). Emitted HERE rather than in
    // `startGlide` because `startGlide` is also the ladder top-out, and a ladder is silent from
    // end to end (vision §5). See const.ts EV.mantle — proposed §3.3 addendum, pending playtest.
    this.emit('mantle');
    this.startGlide(
      hit.x,
      hit.topY,
      hit.z,
      vault ? VAULT_DURATION : MANTLE_DURATION,
      vault ? 'vault' : 'mantle',
      vault ? speed : Math.min(speed, SPEED_WALK),
    );
    return true;
  }

  /** Is every point of the authored arc from here to (tx,ty,tz) free for a standing capsule? */
  private arcClear(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): boolean {
    for (let i = 1; i <= GLIDE_ARC_SAMPLES; i++) {
      const t = i / GLIDE_ARC_SAMPLES;
      const txz = smoothstep(GLIDE_XZ_START, 1, t);
      const tyy = smoothstep(0, GLIDE_Y_END, t);
      const x = lerp(fx, tx, txz);
      const y = lerp(fy, ty, tyy);
      const z = lerp(fz, tz, txz);
      if (capsuleOverlaps(this.world, x, y, z, CAPSULE_RADIUS, HEIGHT_STAND)) return false;
    }
    return true;
  }

  private startGlide(
    toX: number,
    toY: number,
    toZ: number,
    dur: number,
    hands: 'mantle' | 'vault',
    exitSpeed = 0,
  ): void {
    const p = this.player;
    this.glide = {
      fromX: p.x,
      fromY: p.y,
      fromZ: p.z,
      toX,
      toY,
      toZ,
      t: 0,
      dur,
      exitSpeed,
    };
    this.ladder = null;
    this.sliding = false;
    this.blockedForward = false;
    this.approachSpeed = 0;
    this.hands = hands;
    this.handsPhase = 0;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.grounded = false;
    p.stance = 'air';
  }

  /**
   * The glide is authored, not simulated: rise first, THEN step in — the two curves no longer
   * overlap (const.ts GLIDE_Y_END / GLIDE_XZ_START). With the old shape the body began moving
   * forward at t 0.25 while it was still only ~28 % of the way up, which drove the capsule
   * straight through the face of the very ledge it was climbing on 44 % of the sample map's
   * legal mantles. Nothing simulates this path, so its shape IS its collision model; the verb
   * additionally validates the whole arc up front (`arcClear`) before committing to it.
   */
  private stepGlide(dt: number): void {
    const p = this.player;
    const g = this.glide!;
    g.t += dt;
    const t = clamp01(g.t / g.dur);
    const ty = smoothstep(0, GLIDE_Y_END, t);
    const txz = smoothstep(GLIDE_XZ_START, 1, t);
    const nx = lerp(g.fromX, g.toX, txz);
    const ny = lerp(g.fromY, g.toY, ty);
    const nz = lerp(g.fromZ, g.toZ, txz);
    p.vx = (nx - p.x) / dt;
    p.vy = (ny - p.y) / dt;
    p.vz = (nz - p.z) / dt;
    p.x = nx;
    p.y = ny;
    p.z = nz;
    // The readout reports the speed you will LEAVE with, for the whole glide and not just its
    // last frame (see the exit below, which has always done this). `p.vx/p.vz` still carry the
    // authored curve's true instantaneous velocity for anyone who wants it, but `speedXZ` means
    // "how fast is this body travelling as a body" — it is what the gait derivation, the FOV
    // kick and the F3 line read, and a shaped interpolation spikes to ~3x its own average
    // (6.65 m/s across a 1 m step-in) without the body having gained any speed at all.
    this.speedXZ = g.exitSpeed;
    this.handsPhase = t;

    if (t < 1) return;

    p.x = g.toX;
    p.y = g.toY;
    p.z = g.toZ;
    const fixed = resolvePenetration(this.world, p.x, p.y, p.z, CAPSULE_RADIUS, this.height);
    p.x = fixed.x;
    p.y = fixed.y;
    p.z = fixed.z;

    let dx = g.toX - g.fromX;
    let dz = g.toZ - g.fromZ;
    const len = Math.hypot(dx, dz);
    if (len > EPS) {
      dx /= len;
      dz /= len;
    } else {
      const [fx, , fz] = yawToForward(p.yaw);
      dx = fx;
      dz = fz;
    }
    p.vx = dx * g.exitSpeed;
    p.vz = dz * g.exitSpeed;
    p.vy = 0;
    // The readout must report the speed you LEAVE with, not the glide's own last interpolation
    // velocity — the camera rig, the F3 line and the gait test all read this.
    this.speedXZ = g.exitSpeed;

    this.glide = null;
    this.hands = 'none';
    this.handsPhase = 0;
    this.apexY = p.y;
    const ground = groundUnder(this.world, p.x, p.z, p.y + 0.05, PROBE_R, 0.2);
    p.grounded = Boolean(ground);
    if (ground) p.y = ground.y;
    p.stance = p.grounded ? (this.crouched ? 'crouch' : 'stand') : 'air';
    this.coyote = p.grounded ? COYOTE_TIME : 0;
  }

  // ----------------------------------------------------------------------------------------
  // Ladders — 2.5 m/s and SILENT (vision §5): descending is fast and loud, ascending is the
  // slow quiet commitment. No events are emitted anywhere in this section on purpose.
  // ----------------------------------------------------------------------------------------

  private tryLadder(wx: number, wz: number): void {
    const p = this.player;
    const l = ladderAt(this.world, p.x, p.y, p.z, CAPSULE_RADIUS, this.height);
    if (!l) return;
    // Pushing INTO the plane, i.e. against the direction the climber faces out from it.
    if (wx * -l.outX + wz * -l.outZ < LADDER_ATTACH_DOT) return;

    const hugX = l.def.x + l.outX * (CAPSULE_RADIUS + 0.05);
    const hugZ = l.def.z + l.outZ * (CAPSULE_RADIUS + 0.05);
    const y = clamp(p.y, l.yBase, l.yTop);
    if (capsuleOverlaps(this.world, hugX, y, hugZ, CAPSULE_RADIUS, this.height)) return;

    this.ladder = l;
    this.blockedForward = false;
    this.approachSpeed = 0;
    p.x = hugX;
    p.z = hugZ;
    p.y = y;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.grounded = false;
    p.stance = 'ladder';
    this.sliding = false;
    this.hands = 'ladder';
    this.handsPhase = 0;
    this.apexY = p.y;
    this.strideAccum = 0;
  }

  private detachLadder(): void {
    this.ladder = null;
    this.hands = 'none';
    this.handsPhase = 0;
    this.apexY = this.player.y;
  }

  private stepLadder(dt: number, input: MoveInput): void {
    const p = this.player;
    const l = this.ladder!;

    if (this.jumpBuffer > 0) {
      this.jumpBuffer = 0;
      this.detachLadder();
      p.vy = JUMP_VELOCITY;
      p.vx = l.outX * SPEED_WALK;
      p.vz = l.outZ * SPEED_WALK;
      p.stance = 'air';
      return;
    }
    if (input.crouch) {
      this.detachLadder();
      p.stance = 'air';
      return;
    }

    const climb = clamp(input.forward, -1, 1);
    p.vx = 0;
    p.vz = 0;
    p.vy = climb * SPEED_LADDER;
    let y = p.y + p.vy * dt;

    if (climb > 0 && y >= l.yTop - 1e-4) {
      p.y = l.yTop;
      if (this.topOut(l)) return;
      // Nowhere to step off: hold at the top rung rather than teleporting into geometry.
      p.y = l.yTop;
      p.vy = 0;
    } else if (climb < 0 && y <= l.yBase + 1e-4) {
      y = l.yBase;
      p.y = y;
      const g = groundUnder(this.world, p.x, p.z, y + 0.05, PROBE_R, 0.4);
      this.detachLadder();
      if (g) p.y = g.y;
      p.vy = 0;
      p.grounded = Boolean(g);
      p.stance = p.grounded ? (this.crouched ? 'crouch' : 'stand') : 'air';
      return;
    } else {
      p.y = clamp(y, l.yBase, l.yTop);
    }

    p.x = l.def.x + l.outX * (CAPSULE_RADIUS + 0.05);
    p.z = l.def.z + l.outZ * (CAPSULE_RADIUS + 0.05);
    p.grounded = false;
    p.stance = 'ladder';
    this.speedXZ = 0;
    this.apexY = p.y;
    this.handsPhase = (this.handsPhase + Math.abs(p.vy) * dt) % 1;
  }

  /**
   * Step off the top. Tries the climber's side first, then through the plane — the trench
   * ladder tops out over the pit it climbs out of, so the only supported side is the far one.
   */
  private topOut(l: LadderVolume): boolean {
    const p = this.player;
    for (const s of [1, -1]) {
      const cx = p.x + l.outX * LADDER_EXIT_REACH * s;
      const cz = p.z + l.outZ * LADDER_EXIT_REACH * s;
      const g = groundUnder(this.world, cx, cz, l.yTop + 0.15, PROBE_R, 0.45);
      if (!g) continue;
      if (capsuleOverlaps(this.world, cx, g.y + 1e-3, cz, CAPSULE_RADIUS, HEIGHT_STAND)) continue;
      this.detachLadder();
      this.crouched = false;
      this.height = HEIGHT_STAND;
      this.startGlide(cx, g.y, cz, MANTLE_DURATION, 'mantle');
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------------------------------------

  private canStand(): boolean {
    const p = this.player;
    return headroom(this.world, p.x, p.z, p.y, CAPSULE_RADIUS, HEIGHT_STAND + 0.05) >= HEIGHT_STAND - 1e-3;
  }

  private canFit(x: number, y: number, z: number, h: number): boolean {
    return !capsuleOverlaps(this.world, x, y, z, CAPSULE_RADIUS, h);
  }

  /** Publish. Origin is the feet — a footstep happens where the foot is (engine-plan §4). */
  private emit(cls: SoundClass, paintRadius?: number): void {
    const p = this.player;
    this.bus.emit({
      class: cls,
      source: 'self',
      x: p.x,
      y: p.y,
      z: p.z,
      ...(paintRadius === undefined ? {} : { paintRadius }),
    });
  }
}

/** Quake-style: only ever ADDS speed along wishdir, so turning never costs you your run. */
function accelerate(p: PlayerState, wx: number, wz: number, wishSpeed: number, maxAdd: number): void {
  const current = p.vx * wx + p.vz * wz;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const a = Math.min(maxAdd, add);
  p.vx += wx * a;
  p.vz += wz * a;
}

/** Scale horizontal velocity down to `ceiling` if it exceeds it. Direction is preserved. */
function clampSpeed(p: PlayerState, ceiling: number): void {
  const s = Math.hypot(p.vx, p.vz);
  if (s > ceiling + EPS) {
    p.vx *= ceiling / s;
    p.vz *= ceiling / s;
  }
}

function wrapAngle(a: number): number {
  let v = (a + Math.PI) % (Math.PI * 2);
  if (v < 0) v += Math.PI * 2;
  return v - Math.PI;
}

// ------------------------------------------------------------------------------------------
// Camera energy (visual-brief §1.8)
// ------------------------------------------------------------------------------------------

/**
 * "Speed: camera energy. FOV widens on sprint, head cadence locks to footfall audio, landings
 * dip, slides tilt. No motion blur." — visual-brief §1.8.
 *
 * Comfort laws (vision §12) are structural here: FOV stays inside 80–110, bob is capped at
 * HEAD_BOB_MAX, nothing flashes, and ONE switch (`motionEffects`, bound to KeyB and ?nobob)
 * turns off every uncommanded camera motion — bob, landing dip and slide roll together. Vision
 * §12 says "toggleable bob/shake", not "toggleable bob"; a player who needs the switch needs all
 * of it, and a half-off comfort mode is the worst of both. The cost is real and accepted: with
 * effects off, the slide's direction cue (below) goes with them. Comfort wins.
 */
export class CameraRig {
  eyeY = EYE_STAND;
  fov = FOV_BASE;
  /** Radians. Positive = rolled toward your right. */
  roll = 0;
  /** Downward eye offset from a landing, metres. */
  dip = 0;
  bobY = 0;
  /** The single comfort switch: bob + landing dip + slide roll. */
  motionEffects = true;

  update(dt: number, m: MovementController): void {
    // The eye may never rise above what the body's own ceiling allows. Crouching under a duct
    // moves the capsule instantly but the eye only DAMPS down, so for a few frames the camera
    // was inside the duct (measured 1.495 m of eye under 1.30 m of clearance) — the one place
    // this renderer can show you the inside of a solid, which vision §1.2 does not permit.
    // EYE_HEAD_GAP is how far the eye sits below the crown of the capsule in both stances.
    const lid = Math.max(EYE_CROUCH, m.clearance - EYE_HEAD_GAP);
    this.eyeY = Math.min(damp(this.eyeY, m.eyeTarget, EYE_SMOOTH, dt), lid);

    const fast = clamp01(invLerp(SPEED_WALK, SPEED_SPRINT, m.speedXZ));
    this.fov = damp(this.fov, FOV_BASE + FOV_SPRINT_KICK * fast, FOV_SMOOTH, dt);

    // Slide tilt: signed and symmetric, so the roll IS the carve. A straight slide reads exactly
    // level, a left carve mirrors a right one, and the tilt is therefore readable as direction
    // rather than as "a slide is happening" — which the halo, the FOV and the scrape all say
    // already. (The old base lean tilted a straight slide to one side for no physical reason,
    // and left/right differed by 40x: 3.28° against -0.08°.)
    let rollTarget = 0;
    if (m.sliding && this.motionEffects) {
      const p = m.player;
      const s = Math.hypot(p.vx, p.vz);
      const [fx, , fz] = yawToForward(p.yaw);
      const lateral = s > EPS ? clamp((p.vx * -fz + p.vz * fx) / s, -1, 1) : 0;
      rollTarget = (SLIDE_TILT_DEG * lateral * Math.PI) / 180;
    }
    this.roll = damp(this.roll, rollTarget, TILT_SMOOTH, dt);

    // The impulse is consumed either way — a comfort user must not accumulate a dip that fires
    // the moment they switch effects back on.
    if (m.landingImpulse > 0) {
      if (this.motionEffects) this.dip = Math.max(this.dip, LANDING_DIP_MAX * m.landingImpulse);
      m.landingImpulse = 0;
    }
    this.dip = damp(this.dip, 0, LANDING_DIP_DECAY, dt);

    // Head cadence locked to the footfall emitter: the bob and the step sound share one phase.
    if (this.motionEffects && m.player.grounded && !m.sliding) {
      const phase = (m.strideAccum / m.strideLength) * Math.PI * 2;
      const amp = HEAD_BOB_MAX * clamp01(m.speedXZ / SPEED_SPRINT);
      this.bobY = damp(this.bobY, -Math.abs(Math.sin(phase)) * amp, EYE_SMOOTH, dt);
    } else {
      this.bobY = damp(this.bobY, 0, EYE_SMOOTH, dt);
    }
  }

  /** Eye height above the feet, everything folded in. */
  get eyeOffset(): number {
    return this.eyeY - this.dip + this.bobY;
  }
}
