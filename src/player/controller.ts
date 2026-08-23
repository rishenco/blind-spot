/**
 * Kinematic first-person controller (v0) — vision doc §5, The Finals-ish register:
 * responsive, momentum-preserving, no stamina and no fall damage.
 *
 * Everything that shapes feel lives in `MovementTunables` / `CameraTunables` so it can be
 * driven live from lil-gui. All smoothing is frame-rate independent (exponential with an
 * explicit rate in 1/s, applied as 1 - exp(-rate * dt)).
 */

import * as THREE from 'three';
import type { Input } from '../core/input';
import { canOccupyWorld, moveBody, type BodyShape, type StaticWorld } from '../core/collision';

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

export function defaultMovementTunables(): MovementTunables {
  return {
    crouchSpeed: 1.7,
    walkSpeed: 3.5,
    sprintSpeed: 6.0,
    groundAccel: 40,
    groundFriction: 30,
    airAccel: 12,
    jumpVelocity: 4.6,
    gravity: 16,
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

export type Stance = 'stand' | 'crouch';

export interface PlayerState {
  grounded: boolean;
  stance: Stance;
  sprinting: boolean;
  /** Horizontal speed, m/s. */
  speed: number;
}

const DEG2RAD = Math.PI / 180;

/** Frame-rate independent exponential approach factor. */
function smoothFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
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
  private lastLandingSpeed = 0;

  private spawnPosition = new THREE.Vector3();
  private spawnYaw = 0;
  /** Incremented on every respawn; lets tooling wait for the reset to actually land. */
  respawnCount = 0;

  private readonly wishDir = new THREE.Vector3();
  private readonly shape: BodyShape;

  constructor(
    private world: StaticWorld,
    readonly movement: MovementTunables,
    readonly camera: CameraTunables,
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
    this.currentFov = this.camera.fov;
  }

  get state(): PlayerState {
    return {
      grounded: this.grounded,
      stance: this.crouched ? 'crouch' : 'stand',
      sprinting: this.sprinting,
      speed: Math.hypot(this.velocity.x, this.velocity.z),
    };
  }

  get landingSpeed(): number {
    return this.lastLandingSpeed;
  }

  /** One fixed simulation tick. */
  update(dt: number, input: Input): void {
    this.prevPosition.copy(this.position);
    this.prevEyeHeight = this.eyeHeight;
    this.prevStepOffset = this.stepOffset;

    this.updateLook(input);

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

    if (this.grounded) {
      this.applyGroundFriction(wishSpeed, dt);
      this.accelerate(wishSpeed, m.groundAccel, dt);
    } else {
      this.accelerate(wishSpeed, m.airAccel, dt);
    }

    this.updateJump(input, dt);

    this.velocity.y -= m.gravity * dt;

    this.shape.radius = m.radius;
    this.shape.height = this.colliderHeight;
    this.shape.stepHeight = m.stepHeight;
    const wasGrounded = this.grounded;
    const res = moveBody(this.world, this.position, this.velocity, dt, this.shape, wasGrounded);

    this.grounded = res.grounded;
    if (res.landingSpeed > 0) this.lastLandingSpeed = res.landingSpeed;
    if (res.stepUp > 0) this.stepOffset += res.stepUp;

    if (this.grounded) this.coyoteTimer = m.coyoteTime;

    // Camera smoothing.
    const targetEye = this.crouched ? m.eyeCrouch : m.eyeStand;
    this.eyeHeight += (targetEye - this.eyeHeight) * smoothFactor(m.eyeSmoothRate, dt);
    this.stepOffset -= this.stepOffset * smoothFactor(m.stepSmoothRate, dt);
    if (Math.abs(this.stepOffset) < 1e-4) this.stepOffset = 0;

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const targetFov =
      this.camera.fov + (this.sprinting && horizontalSpeed > 0.5 ? this.camera.sprintFovBonus : 0);
    this.currentFov += (targetFov - this.currentFov) * smoothFactor(this.camera.fovSmoothRate, dt);
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
    const twoPi = Math.PI * 2;
    if (this.yaw > Math.PI) this.yaw -= twoPi;
    else if (this.yaw < -Math.PI) this.yaw += twoPi;
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
    if (input.wasPressed('jump')) this.bufferTimer = m.jumpBuffer;

    if (this.bufferTimer > 0 && this.coyoteTimer > 0) {
      this.velocity.y = m.jumpVelocity;
      this.grounded = false;
      this.bufferTimer = 0;
      this.coyoteTimer = 0;
    }

    if (this.bufferTimer > 0) this.bufferTimer -= dt;
    if (!this.grounded && this.coyoteTimer > 0) this.coyoteTimer -= dt;
  }

  /** Per-frame: places the camera, interpolating between the last two sim ticks. */
  applyToCamera(camera: THREE.PerspectiveCamera, alpha: number): void {
    const a = Math.min(1, Math.max(0, alpha));
    const x = this.prevPosition.x + (this.position.x - this.prevPosition.x) * a;
    const y = this.prevPosition.y + (this.position.y - this.prevPosition.y) * a;
    const z = this.prevPosition.z + (this.position.z - this.prevPosition.z) * a;
    const eye = this.prevEyeHeight + (this.eyeHeight - this.prevEyeHeight) * a;
    const step = this.prevStepOffset + (this.stepOffset - this.prevStepOffset) * a;

    camera.position.set(x, y + eye - step, z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (Math.abs(camera.fov - this.currentFov) > 1e-3) {
      camera.fov = this.currentFov;
      camera.updateProjectionMatrix();
    }
  }
}
