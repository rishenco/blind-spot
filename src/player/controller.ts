/**
 * Kinematic first-person controller (v0) — vision doc §5, The Finals-ish register:
 * responsive, momentum-preserving, no stamina and no fall damage.
 *
 * Everything that shapes feel lives in `MovementTunables` / `CameraTunables` / `BobTunables` /
 * `MantleTunables` so it can be driven live from lil-gui. All smoothing is frame-rate
 * independent (exponential with an explicit rate in 1/s, applied as 1 - exp(-rate * dt)).
 *
 * Two layers are kept strictly apart:
 *  - simulation state (position, velocity, stance, stride phase) advances on the fixed tick;
 *  - view effects (head bob, landing dip) are *only* ever applied in `applyToCamera`, on top
 *    of the interpolated pose. Nothing the camera does can feed back into the physics.
 */

import * as THREE from 'three';
import type { Input } from '../core/input';
import {
  canOccupy,
  canOccupyWorld,
  circleOverlapsFootprint,
  moveBody,
  type Aabb,
  type BodyShape,
  type StaticWorld,
} from '../core/collision';

export interface MovementTunables {
  crouchSpeed: number;
  walkSpeed: number;
  sprintSpeed: number;
  /** Ground acceleration toward the wish velocity, m/s². */
  groundAccel: number;
  /** Ground deceleration applied to speed above the wish speed, m/s². */
  groundFriction: number;
  /** Air acceleration, m/s². No air friction — momentum is preserved. */
  airAccel: number;
  jumpVelocity: number;
  gravity: number;
  /** Gravity is multiplied by this while falling: a snappy fall without a floaty rise. */
  fallGravityMult: number;
  /** Releasing jump while still rising scales the upward velocity by this (tap = short hop). */
  jumpCutFactor: number;
  coyoteTime: number;
  jumpBuffer: number;
  radius: number;
  standHeight: number;
  crouchHeight: number;
  eyeStand: number;
  eyeCrouch: number;
  stepHeight: number;
  /** Exponential rate (1/s) for the eye-height transition when crouching. */
  eyeSmoothRate: number;
  /** Exponential rate (1/s) for absorbing step-ups so stairs don't jolt the camera. */
  stepSmoothRate: number;
  /** Minimum forward component of the move input required to sprint (1 = dead ahead). */
  sprintMinForward: number;
  /** Render-only camera dip on the hardest landing, metres. */
  landDipMax: number;
  /** Exponential rate (1/s) at which the landing dip recovers. */
  landDipRecovery: number;
}

export interface CameraTunables {
  fov: number;
  sprintFovBonus: number;
  /** Exponential rate (1/s) for the FOV transition. */
  fovSmoothRate: number;
  /** Degrees of rotation per pixel of mouse movement. */
  sensitivity: number;
  pitchClampDeg: number;
  invertY: boolean;
}

/**
 * Stride-synced view bob. One *cycle* is a full stride (two footfalls): the head dips twice
 * per cycle and sways side to side once, which is what makes a run read as a run.
 */
export interface BobTunables {
  enabled: boolean;
  /** Vertical amplitude at full sprint, metres (peak, so peak-to-peak is twice this). */
  vertAmp: number;
  /** Lateral amplitude at full sprint, metres. */
  latAmp: number;
  /** Roll amplitude at full sprint, degrees. */
  rollDeg: number;
  /** Stride cycles per second at sprint speed; slower speeds scale down with speed. */
  strideFreq: number;
  /** Amplitude multiplier while crouched. */
  crouchScale: number;
  /** Exponential rate (1/s) at which bob fades in/out (airborne, mantling, standing still). */
  blendRate: number;
}

/** Mantle / vault — "climbing" in playtest words. */
export interface MantleTunables {
  enabled: boolean;
  /** How far past the body surface the ledge probe reaches, metres. */
  reach: number;
  /**
   * Shortest ledge worth climbing, metres above the feet. Anything lower is walked up by the
   * step-up or cleared by an ordinary jump — without this, jumping on a staircase snaps you
   * two treads up instead of jumping.
   */
  minHeight: number;
  /** Tallest ledge that can be climbed, metres above the feet. */
  maxHeight: number;
  /** At or below this the climb is a fast vault; above it, a slower pull-up. */
  lowVaultMaxHeight: number;
  vaultTime: number;
  pullupTime: number;
}

export function defaultMovementTunables(): MovementTunables {
  return {
    crouchSpeed: 1.7,
    walkSpeed: 3.5,
    sprintSpeed: 6.0,
    groundAccel: 40,
    groundFriction: 30,
    airAccel: 12,
    jumpVelocity: 5.4,
    gravity: 16,
    fallGravityMult: 1.6,
    jumpCutFactor: 0.5,
    coyoteTime: 0.12,
    jumpBuffer: 0.12,
    radius: 0.35,
    standHeight: 1.7,
    crouchHeight: 1.2,
    eyeStand: 1.62,
    eyeCrouch: 1.12,
    stepHeight: 0.3,
    eyeSmoothRate: 8,
    stepSmoothRate: 14,
    sprintMinForward: 0.5,
    landDipMax: 0.12,
    landDipRecovery: 7,
  };
}

export function defaultCameraTunables(): CameraTunables {
  return {
    fov: 90,
    sprintFovBonus: 6,
    fovSmoothRate: 4,
    sensitivity: 0.12,
    pitchClampDeg: 89,
    invertY: false,
  };
}

export function defaultBobTunables(): BobTunables {
  return {
    enabled: true,
    vertAmp: 0.035,
    latAmp: 0.03,
    rollDeg: 0.25,
    strideFreq: 1.9,
    crouchScale: 0.5,
    blendRate: 6,
  };
}

export function defaultMantleTunables(): MantleTunables {
  return {
    enabled: true,
    reach: 0.65,
    minHeight: 0.5,
    maxHeight: 2.2,
    lowVaultMaxHeight: 1.2,
    vaultTime: 0.25,
    pullupTime: 0.45,
  };
}

export type Stance = 'stand' | 'crouch';
export type StepTier = 'crouch' | 'walk' | 'sprint';

export interface PlayerState {
  grounded: boolean;
  stance: Stance;
  sprinting: boolean;
  /** True while a scripted mantle/vault is playing out. */
  mantling: boolean;
  /** Horizontal speed, m/s. */
  speed: number;
}

/**
 * Sound-relevant things the body does. Batch 2 hangs the paint/emission system off this:
 * every event already carries where it happened and how loud the gait was.
 */
export interface FootstepEvent {
  readonly type: 'footstep';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Horizontal speed at the moment the foot landed, m/s. */
  readonly speed: number;
  readonly tier: StepTier;
  readonly foot: 'left' | 'right';
}

export interface LandEvent {
  readonly type: 'land';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Downward speed at touchdown, m/s. */
  readonly impactSpeed: number;
  readonly stance: Stance;
}

export type PlayerEvent = FootstepEvent | LandEvent;
export type PlayerEventListener = (event: PlayerEvent) => void;

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Landings below this impact speed do not dip the camera at all, m/s. */
const LAND_DIP_MIN_SPEED = 3;
/** Impact speed that produces the full `landDipMax` dip, m/s. */
const LAND_DIP_FULL_SPEED = 13;
/** Exponential rate (1/s) at which the dip is taken up — fast in, slow out. */
const LAND_DIP_ATTACK = 50;
/** Spacing between ledge probes while airborne with jump held, seconds. */
const MANTLE_PROBE_INTERVAL = 0.06;
/** Probe sampling step along the forward ray, metres. */
const MANTLE_PROBE_STEP = 0.1;
/** How far inside a ledge's footprint the landing point must sit, metres. */
const MANTLE_LANDING_MARGIN = 0.1;

/** Frame-rate independent exponential approach factor. */
function smoothFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export class PlayerController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  /** Previous tick's position, for render interpolation. */
  private readonly prevPosition = new THREE.Vector3();

  yaw = 0;
  pitch = 0;

  private colliderHeight: number;
  private eyeHeight: number;
  private prevEyeHeight: number;
  /** Vertical offset absorbing a step-up, decayed to zero for a smooth camera. */
  private stepOffset = 0;
  private prevStepOffset = 0;
  private currentFov: number;

  private grounded = false;
  private sprinting = false;
  private crouched = false;
  private coyoteTimer = 0;
  private bufferTimer = 0;
  private jumpCutArmed = false;
  private lastLandingSpeed = 0;

  // ---- view effects (render-only; never read back by the simulation) --------
  /** Unwrapped stride phase in radians; a full stride cycle is 2π (two footfalls). */
  private stridePhase = 0;
  private prevStridePhase = 0;
  /** 0..1 amplitude envelope: speed, stance and "are we even running" folded together. */
  private bobGain = 0;
  private prevBobGain = 0;
  private landDip = 0;
  private prevLandDip = 0;
  private landDipTarget = 0;
  /** Footfalls emitted since boot — HUD readout and a hook for the sound layer. */
  stepCount = 0;

  // ---- mantle --------------------------------------------------------------
  private mantleActive = false;
  private mantleIsVault = true;
  private mantleTimer = 0;
  private mantleDuration = 0;
  private readonly mantleFrom = new THREE.Vector3();
  private readonly mantleTo = new THREE.Vector3();
  private mantleDirX = 0;
  private mantleDirZ = 0;
  private mantleExitSpeed = 0;
  private mantleProbeTimer = 0;

  private spawnPosition = new THREE.Vector3();
  private spawnYaw = 0;
  /** Incremented on every respawn; lets tooling wait for the reset to actually land. */
  respawnCount = 0;

  private readonly wishDir = new THREE.Vector3();
  private readonly shape: BodyShape;
  private readonly probeScratch: Aabb[] = [];
  private readonly listeners = new Set<PlayerEventListener>();

  constructor(
    private world: StaticWorld,
    readonly movement: MovementTunables,
    readonly camera: CameraTunables,
    readonly bob: BobTunables = defaultBobTunables(),
    readonly mantle: MantleTunables = defaultMantleTunables(),
  ) {
    this.colliderHeight = movement.standHeight;
    this.eyeHeight = movement.eyeStand;
    this.prevEyeHeight = this.eyeHeight;
    this.currentFov = camera.fov;
    this.shape = {
      radius: movement.radius,
      height: movement.standHeight,
      stepHeight: movement.stepHeight,
    };
  }

  setWorld(world: StaticWorld): void {
    this.world = world;
  }

  /**
   * Subscribes to the body's sound-relevant events. Returns an unsubscribe function.
   * Listeners are called synchronously inside the fixed tick that produced the event.
   */
  onEvent(listener: PlayerEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: PlayerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Defines (and moves to) the respawn pose. `yawDeg` is a compass-style heading. */
  setSpawn(position: THREE.Vector3, yawDeg: number): void {
    this.spawnPosition.copy(position);
    this.spawnYaw = yawDeg * DEG2RAD;
    this.respawn();
  }

  respawn(): void {
    this.respawnCount++;
    this.position.copy(this.spawnPosition);
    this.prevPosition.copy(this.spawnPosition);
    this.velocity.set(0, 0, 0);
    this.yaw = this.spawnYaw;
    this.pitch = 0;
    this.crouched = false;
    this.sprinting = false;
    this.grounded = false;
    this.colliderHeight = this.movement.standHeight;
    this.eyeHeight = this.movement.eyeStand;
    this.prevEyeHeight = this.eyeHeight;
    this.stepOffset = 0;
    this.prevStepOffset = 0;
    this.coyoteTimer = 0;
    this.bufferTimer = 0;
    this.jumpCutArmed = false;
    this.currentFov = this.camera.fov;
    // A respawn cancels a climb outright — no half-played scripted motion survives it.
    this.mantleActive = false;
    this.mantleProbeTimer = 0;
    this.stridePhase = 0;
    this.prevStridePhase = 0;
    this.bobGain = 0;
    this.prevBobGain = 0;
    this.landDip = 0;
    this.prevLandDip = 0;
    this.landDipTarget = 0;
  }

  get state(): PlayerState {
    return {
      grounded: this.grounded,
      stance: this.crouched ? 'crouch' : 'stand',
      sprinting: this.sprinting,
      mantling: this.mantleActive,
      speed: Math.hypot(this.velocity.x, this.velocity.z),
    };
  }

  get landingSpeed(): number {
    return this.lastLandingSpeed;
  }

  /** Current render-only landing dip, metres (0 when settled). Exposed for tooling/HUD. */
  get landDipOffset(): number {
    return this.landDip;
  }

  get mantling(): boolean {
    return this.mantleActive;
  }

  /** One fixed simulation tick. */
  update(dt: number, input: Input): void {
    this.prevPosition.copy(this.position);
    this.prevEyeHeight = this.eyeHeight;
    this.prevStepOffset = this.stepOffset;
    this.prevStridePhase = this.stridePhase;
    this.prevBobGain = this.bobGain;
    this.prevLandDip = this.landDip;

    this.updateLook(input);

    if (this.mantleActive) this.advanceMantle(dt);
    else this.simulate(dt, input);

    this.updateViewEffects(dt);
  }

  /** The ordinary (non-mantling) movement tick. */
  private simulate(dt: number, input: Input): void {
    const m = this.movement;
    const axes = input.moveAxes();
    const hasInput = axes.x !== 0 || axes.y !== 0;

    this.updateStance(input, axes.y);

    // Wish direction in world space from yaw-relative input.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Camera forward at yaw=0 is -Z; right is +X.
    this.wishDir.set(axes.x * cos - axes.y * sin, 0, -axes.x * sin - axes.y * cos);
    const wishLen = Math.hypot(this.wishDir.x, this.wishDir.z);
    if (wishLen > 1e-6) {
      this.wishDir.x /= wishLen;
      this.wishDir.z /= wishLen;
    }

    const maxSpeed = this.crouched ? m.crouchSpeed : this.sprinting ? m.sprintSpeed : m.walkSpeed;
    const wishSpeed = hasInput ? maxSpeed * Math.min(1, wishLen) : 0;

    if (this.mantleProbeTimer > 0) this.mantleProbeTimer -= dt;
    if (this.tryMantle(input, wishSpeed)) {
      this.bufferTimer = 0;
      this.coyoteTimer = 0;
      return;
    }

    if (this.grounded) {
      this.applyGroundFriction(wishSpeed, dt);
      this.accelerate(wishSpeed, m.groundAccel, dt);
    } else {
      this.accelerate(wishSpeed, m.airAccel, dt);
    }

    this.updateJump(input, dt);

    // Falling harder than rising is the cheapest way to make a jump feel like it has weight.
    const gravity = this.velocity.y < 0 ? m.gravity * m.fallGravityMult : m.gravity;
    this.velocity.y -= gravity * dt;

    this.shape.radius = m.radius;
    this.shape.height = this.colliderHeight;
    this.shape.stepHeight = m.stepHeight;
    const wasGrounded = this.grounded;
    const res = moveBody(this.world, this.position, this.velocity, dt, this.shape, wasGrounded);

    this.grounded = res.grounded;
    if (res.landingSpeed > 0) {
      this.lastLandingSpeed = res.landingSpeed;
      this.onLanded(res.landingSpeed);
    }
    if (res.stepUp > 0) this.stepOffset += res.stepUp;

    if (this.grounded) this.coyoteTimer = m.coyoteTime;
  }

  private onLanded(impactSpeed: number): void {
    this.emit({
      type: 'land',
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      impactSpeed,
      stance: this.crouched ? 'crouch' : 'stand',
    });
    const over = (impactSpeed - LAND_DIP_MIN_SPEED) / (LAND_DIP_FULL_SPEED - LAND_DIP_MIN_SPEED);
    if (over <= 0) return;
    const dip = this.movement.landDipMax * clamp01(over);
    if (dip > this.landDipTarget) this.landDipTarget = dip;
  }

  private updateLook(input: Input): void {
    const { dx, dy } = input.consumeLook();
    if (dx === 0 && dy === 0) return;
    const sens = this.camera.sensitivity * DEG2RAD;
    this.yaw -= dx * sens;
    this.pitch += (this.camera.invertY ? dy : -dy) * sens;
    const clamp = this.camera.pitchClampDeg * DEG2RAD;
    if (this.pitch > clamp) this.pitch = clamp;
    if (this.pitch < -clamp) this.pitch = -clamp;
    // Keep yaw bounded so it never loses float precision on long sessions.
    if (this.yaw > Math.PI) this.yaw -= TWO_PI;
    else if (this.yaw < -Math.PI) this.yaw += TWO_PI;
  }

  private updateStance(input: Input, forwardAxis: number): void {
    const m = this.movement;
    const wantsCrouch = input.isDown('crouch');
    if (wantsCrouch && !this.crouched) {
      this.crouched = true;
      this.colliderHeight = m.crouchHeight;
    } else if (!wantsCrouch && this.crouched) {
      // Only stand up when there is room for the full collider.
      const canStand = canOccupyWorld(
        this.world,
        this.position.x,
        this.position.y,
        this.position.z,
        m.radius,
        m.standHeight,
      );
      if (canStand) {
        this.crouched = false;
        this.colliderHeight = m.standHeight;
      }
    }

    this.sprinting =
      !this.crouched && input.isDown('sprint') && forwardAxis >= m.sprintMinForward;
  }

  /** Bleeds speed above `targetSpeed` at a constant rate; direction is preserved. */
  private applyGroundFriction(targetSpeed: number, dt: number): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed <= targetSpeed || speed < 1e-6) return;
    const next = Math.max(targetSpeed, speed - this.movement.groundFriction * dt);
    const scale = next / speed;
    this.velocity.x *= scale;
    this.velocity.z *= scale;
  }

  /**
   * Quake-style acceleration: only ever *adds* speed along the wish direction, and only up
   * to `wishSpeed` measured along that direction. Speed above the cap from any other source
   * (a future slide or dash) is never clamped away here — friction handles it.
   */
  private accelerate(wishSpeed: number, accel: number, dt: number): void {
    if (wishSpeed <= 0) return;
    const current = this.velocity.x * this.wishDir.x + this.velocity.z * this.wishDir.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const delta = Math.min(accel * dt, add);
    this.velocity.x += this.wishDir.x * delta;
    this.velocity.z += this.wishDir.z * delta;
  }

  private updateJump(input: Input, dt: number): void {
    const m = this.movement;
    if (input.wasPressed('jump')) {
      this.bufferTimer = m.jumpBuffer;
      this.jumpCutArmed = false;
    }

    if (this.bufferTimer > 0 && this.coyoteTimer > 0) {
      this.velocity.y = m.jumpVelocity;
      this.grounded = false;
      this.bufferTimer = 0;
      this.coyoteTimer = 0;
      this.jumpCutArmed = true;
    }

    // Release-to-cut: let go while still rising and the rest of the arc is traded away.
    // Tap = short hop, hold = full jump; the same press length always gives the same height.
    if (this.jumpCutArmed) {
      if (this.velocity.y <= 0) this.jumpCutArmed = false;
      else if (!input.isDown('jump')) {
        this.velocity.y *= m.jumpCutFactor;
        this.jumpCutArmed = false;
      }
    }

    if (this.bufferTimer > 0) this.bufferTimer -= dt;
    if (!this.grounded && this.coyoteTimer > 0) this.coyoteTimer -= dt;
  }

  // ---- mantle --------------------------------------------------------------

  /**
   * Starts a climb if the player asked for one and there is a ledge to take. Jump is the
   * verb: pressing it starts a climb from the ground, and holding it while airborne keeps
   * looking for a ledge so a jump that comes up short still catches the lip.
   */
  private tryMantle(input: Input, wishSpeed: number): boolean {
    if (!this.mantle.enabled) return false;
    const pressed = input.wasPressed('jump');
    const searching = !this.grounded && input.isDown('jump') && this.mantleProbeTimer <= 0;
    if (!pressed && !searching) return false;
    this.mantleProbeTimer = MANTLE_PROBE_INTERVAL;
    return this.startMantle(wishSpeed);
  }

  private startMantle(wishSpeed: number): boolean {
    const m = this.movement;
    const mt = this.mantle;

    // Climb where the player is asking to go; fall back to where they are looking.
    let dirX = this.wishDir.x;
    let dirZ = this.wishDir.z;
    if (Math.abs(dirX) + Math.abs(dirZ) < 1e-6) {
      dirX = -Math.sin(this.yaw);
      dirZ = -Math.cos(this.yaw);
    }
    const dirLen = Math.hypot(dirX, dirZ);
    if (dirLen < 1e-6) return false;
    dirX /= dirLen;
    dirZ /= dirLen;

    const radius = m.radius;
    const feetY = this.position.y;
    // Anything at or under this is the step-up's or the jump's job, never the climb's.
    const minLedge = feetY + Math.max(m.stepHeight, mt.minHeight);
    const maxLedge = feetY + mt.maxHeight;
    // Past the wall we still need room for the body to land on top of it.
    const scanFar = mt.reach + radius * 2 + 0.5;
    const farX = this.position.x + dirX * scanFar;
    const farZ = this.position.z + dirZ * scanFar;

    const candidates = this.world.query(
      Math.min(this.position.x, farX) - radius - 0.05,
      feetY - 0.05,
      Math.min(this.position.z, farZ) - radius - 0.05,
      Math.max(this.position.x, farX) + radius + 0.05,
      maxLedge + m.standHeight + 0.05,
      Math.max(this.position.z, farZ) + radius + 0.05,
      this.probeScratch,
    );
    if (candidates.length === 0) return false;

    // 1. Walk the probe forward until something that is not just a step is in the way.
    let ledgeY = -Infinity;
    let hitT = -1;
    for (let t = MANTLE_PROBE_STEP; t <= mt.reach + 1e-6; t += MANTLE_PROBE_STEP) {
      const px = this.position.x + dirX * t;
      const pz = this.position.z + dirZ * t;
      let top = -Infinity;
      for (const b of candidates) {
        if (b.maxY <= minLedge) continue; // walkable or jumpable, not a climb
        if (b.minY >= feetY + this.colliderHeight) continue; // overhead, not a face we can grab
        if (!circleOverlapsFootprint(px, pz, radius, b)) continue;
        if (b.maxY > top) top = b.maxY;
      }
      if (top === -Infinity) continue;
      // Stacked boxes: climb the column to its real top before judging the height.
      for (let pass = 0; pass < 4; pass++) {
        let grew = false;
        for (const b of candidates) {
          if (b.maxY <= top || b.minY > top + 1e-3) continue;
          if (!circleOverlapsFootprint(px, pz, radius, b)) continue;
          top = b.maxY;
          grew = true;
        }
        if (!grew) break;
      }
      ledgeY = top;
      hitT = t;
      break;
    }
    if (hitT < 0 || ledgeY > maxLedge + 1e-3) return false;

    // 2. Find the first spot on top that actually holds the body.
    const standHeight = this.crouched ? m.crouchHeight : m.standHeight;
    let landX = 0;
    let landZ = 0;
    let endCrouched = false;
    let found = false;
    for (let t = hitT; t <= scanFar + 1e-6; t += MANTLE_PROBE_STEP) {
      const px = this.position.x + dirX * t;
      const pz = this.position.z + dirZ * t;
      if (!this.isOnLedge(candidates, px, pz, ledgeY)) continue;
      if (canOccupy(candidates, px, ledgeY, pz, radius, standHeight)) {
        landX = px;
        landZ = pz;
        found = true;
        break;
      }
      // A ledge with a low roof over it is still climbable — you just arrive folded up.
      if (
        standHeight !== m.crouchHeight &&
        canOccupy(candidates, px, ledgeY, pz, radius, m.crouchHeight)
      ) {
        landX = px;
        landZ = pz;
        endCrouched = true;
        found = true;
        break;
      }
    }
    if (!found) return false;

    // 3. Never climb into a ceiling: the head has to be able to rise from here to up there.
    const head = feetY + this.colliderHeight;
    const newHead = ledgeY + (endCrouched ? m.crouchHeight : standHeight);
    for (const b of candidates) {
      if (b.maxY <= head + 1e-3 || b.minY >= newHead - 1e-3) continue;
      if (circleOverlapsFootprint(this.position.x, this.position.z, radius, b)) return false;
    }

    const rise = ledgeY - feetY;
    const entrySpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.mantleActive = true;
    this.mantleIsVault = rise <= mt.lowVaultMaxHeight + 1e-3;
    this.mantleTimer = 0;
    this.mantleDuration = this.mantleIsVault ? mt.vaultTime : mt.pullupTime;
    this.mantleFrom.copy(this.position);
    this.mantleTo.set(landX, ledgeY, landZ);
    this.mantleDirX = dirX;
    this.mantleDirZ = dirZ;
    // A vault never costs momentum (sprint chains over crates); a pull-up is a committal
    // move and puts you on top at walking pace.
    this.mantleExitSpeed = this.mantleIsVault
      ? Math.max(entrySpeed, wishSpeed)
      : Math.min(Math.max(entrySpeed, wishSpeed), m.walkSpeed);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.jumpCutArmed = false;
    if (endCrouched) {
      this.crouched = true;
      this.colliderHeight = m.crouchHeight;
    }
    return true;
  }

  /** True when (x, z) sits properly *on* a surface whose top is the ledge, not just near it. */
  private isOnLedge(candidates: readonly Aabb[], x: number, z: number, ledgeY: number): boolean {
    for (const b of candidates) {
      if (Math.abs(b.maxY - ledgeY) > 1e-3) continue;
      if (x < b.minX + MANTLE_LANDING_MARGIN || x > b.maxX - MANTLE_LANDING_MARGIN) continue;
      if (z < b.minZ + MANTLE_LANDING_MARGIN || z > b.maxZ - MANTLE_LANDING_MARGIN) continue;
      return true;
    }
    return false;
  }

  /** Scripted climb motion: input-locked, gravity-free, but the head stays free to look. */
  private advanceMantle(dt: number): void {
    this.mantleTimer += dt;
    const u = this.mantleDuration > 0 ? clamp01(this.mantleTimer / this.mantleDuration) : 1;
    // Rise leads, translation follows: a vault overlaps them heavily and reads as one motion,
    // a pull-up separates them into "up" then "over".
    const upSpan = this.mantleIsVault ? 0.6 : 0.65;
    const overStart = this.mantleIsVault ? 0.15 : 0.5;
    const up = smoothstep(clamp01(u / upSpan));
    const over = smoothstep(clamp01((u - overStart) / (1 - overStart)));

    this.position.set(
      this.mantleFrom.x + (this.mantleTo.x - this.mantleFrom.x) * over,
      this.mantleFrom.y + (this.mantleTo.y - this.mantleFrom.y) * up,
      this.mantleFrom.z + (this.mantleTo.z - this.mantleFrom.z) * over,
    );
    this.velocity.set(0, 0, 0);

    if (u < 1) return;

    this.mantleActive = false;
    this.position.copy(this.mantleTo);
    this.velocity.set(this.mantleDirX * this.mantleExitSpeed, 0, this.mantleDirZ * this.mantleExitSpeed);
    this.grounded = true;
    this.coyoteTimer = this.movement.coyoteTime;
    this.bufferTimer = 0;
    this.mantleProbeTimer = MANTLE_PROBE_INTERVAL;
  }

  // ---- view effects --------------------------------------------------------

  /**
   * Advances everything the camera reads and nothing the body does: stride phase (and the
   * footfalls that fall out of it), the bob envelope, the landing dip, and the existing
   * eye/step/FOV smoothing.
   */
  private updateViewEffects(dt: number): void {
    const m = this.movement;
    const b = this.bob;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const striding = this.grounded && !this.mantleActive;

    const speedScale = clamp01(speed / Math.max(0.01, m.sprintSpeed));
    const target = striding ? speedScale * (this.crouched ? b.crouchScale : 1) : 0;
    this.bobGain += (target - this.bobGain) * smoothFactor(b.blendRate, dt);
    if (this.bobGain < 1e-4 && target === 0) this.bobGain = 0;

    if (striding && speed > 0.05) {
      // Distance-based, so the stride tracks speed continuously instead of snapping between
      // gaits: `strideFreq` names the cycle rate at sprint and the stride length follows.
      const strideLength = m.sprintSpeed / Math.max(0.05, b.strideFreq);
      this.stridePhase += ((speed * dt) / strideLength) * TWO_PI;
      // Footfalls are the two dip bottoms of the cycle: phase = π/2 and 3π/2.
      const before = Math.floor((this.prevStridePhase - HALF_PI) / Math.PI);
      const after = Math.floor((this.stridePhase - HALF_PI) / Math.PI);
      for (let k = before + 1; k <= after; k++) this.emitFootstep(k, speed);
    }

    this.landDipTarget -= this.landDipTarget * smoothFactor(m.landDipRecovery, dt);
    this.landDip += (this.landDipTarget - this.landDip) * smoothFactor(LAND_DIP_ATTACK, dt);
    if (this.landDip < 1e-4 && this.landDipTarget < 1e-4) {
      this.landDip = 0;
      this.landDipTarget = 0;
    }

    const targetEye = this.crouched ? m.eyeCrouch : m.eyeStand;
    this.eyeHeight += (targetEye - this.eyeHeight) * smoothFactor(m.eyeSmoothRate, dt);
    this.stepOffset -= this.stepOffset * smoothFactor(m.stepSmoothRate, dt);
    if (Math.abs(this.stepOffset) < 1e-4) this.stepOffset = 0;

    const targetFov =
      this.camera.fov + (this.sprinting && speed > 0.5 ? this.camera.sprintFovBonus : 0);
    this.currentFov += (targetFov - this.currentFov) * smoothFactor(this.camera.fovSmoothRate, dt);
  }

  private emitFootstep(halfCycle: number, speed: number): void {
    const m = this.movement;
    this.stepCount++;
    const tier: StepTier = this.crouched
      ? 'crouch'
      : speed > (m.walkSpeed + m.sprintSpeed) / 2
        ? 'sprint'
        : 'walk';
    this.emit({
      type: 'footstep',
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      speed,
      tier,
      foot: (((halfCycle % 2) + 2) % 2) === 0 ? 'left' : 'right',
    });
  }

  /** Per-frame: places the camera, interpolating between the last two sim ticks. */
  applyToCamera(camera: THREE.PerspectiveCamera, alpha: number): void {
    const a = clamp01(alpha);
    const x = this.prevPosition.x + (this.position.x - this.prevPosition.x) * a;
    const y = this.prevPosition.y + (this.position.y - this.prevPosition.y) * a;
    const z = this.prevPosition.z + (this.position.z - this.prevPosition.z) * a;
    const eye = this.prevEyeHeight + (this.eyeHeight - this.prevEyeHeight) * a;
    const step = this.prevStepOffset + (this.stepOffset - this.prevStepOffset) * a;
    const dip = this.prevLandDip + (this.landDip - this.prevLandDip) * a;

    let bobUp = 0;
    let bobSide = 0;
    let roll = 0;
    const gain = this.prevBobGain + (this.bobGain - this.prevBobGain) * a;
    if (this.bob.enabled && gain > 1e-4) {
      const phase = this.prevStridePhase + (this.stridePhase - this.prevStridePhase) * a;
      const sway = Math.sin(phase);
      // Two dips per cycle (one per footfall), one full sway, roll riding the sway.
      bobUp = this.bob.vertAmp * gain * Math.cos(2 * phase);
      bobSide = this.bob.latAmp * gain * sway;
      roll = this.bob.rollDeg * DEG2RAD * gain * sway;
    }
    // Camera right at this yaw (forward is (-sin, 0, -cos)).
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);

    camera.position.set(
      x + rightX * bobSide,
      y + eye - step + bobUp - dip,
      z + rightZ * bobSide,
    );
    camera.rotation.set(this.pitch, this.yaw, roll, 'YXZ');
    if (Math.abs(camera.fov - this.currentFov) > 1e-3) {
      camera.fov = this.currentFov;
      camera.updateProjectionMatrix();
    }
  }
}
