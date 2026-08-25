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
import type { PlayerInputSource } from '../core/inputSource';
import {
  canOccupy,
  canOccupyWorld,
  circleOverlapsFootprint,
  createMoveResult,
  moveBody,
  sweepSphereWorld,
  type Aabb,
  type BodyShape,
  type MoveResult,
  type StaticWorld,
} from '../core/collision';
import { MAT_CONCRETE } from '../paint/materials';

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

/**
 * The third-person boom. First person stays the primary mode; this is the "let me look at the
 * thing I am driving" camera, and it is held to gameplay standards: it never clips through
 * geometry, never pops, and never bobs (the animated body carries the physicality instead).
 */
export interface ThirdPersonTunables {
  /** Boom length behind the pivot when nothing is in the way, metres. */
  distance: number;
  /** Right-shoulder offset, metres. Positive puts the body left of centre. */
  shoulder: number;
  /** How far the camera rides above the pivot, metres. */
  height: number;
  /** Pivot height above the feet — the neck, metres. Follows the crouch. */
  pivotHeight: number;
  /** Radius of the sphere swept along the boom for wall avoidance, metres. */
  probeRadius: number;
  /** Clearance kept between the camera and whatever the boom hit, metres. */
  probeMargin: number;
  /** Shortest the boom is allowed to get, metres. */
  minDistance: number;
  /** Exponential rate (1/s) at which the boom grows back out of a squeeze. */
  growRate: number;
  /** Exponential rate (1/s) at which the boom pulls in — fast, so nothing ever clips. */
  shrinkRate: number;
  /** Seconds for the first-person <-> third-person transition. */
  transitionTime: number;
  /** Fraction of the first-person landing dip kept in third person. */
  landDipScale: number;
  /** Camera-to-pivot distance below which the body is hidden (never see inside the head). */
  hideDistance: number;
  /** Exponential rate (1/s) at which the body turns toward its velocity. */
  turnRate: number;
}

/**
 * Camera roll — the Finals-style lean. Two independent sources, summed then smoothed once:
 * how hard you are strafing, and how fast you are turning. Stride roll (§BobTunables) is a
 * third, separate contribution; all three are functions of the current state alone, never
 * integrated, so the total returns to exactly zero when you stand still.
 */
export interface CameraFeelTunables {
  /** Degrees of roll at a full-speed pure strafe. */
  strafeRollDeg: number;
  /** Degrees of roll at (or beyond) `turnRollRefRate`. */
  turnRollDeg: number;
  /** Yaw rate that earns the full `turnRollDeg`, rad/s. */
  turnRollRefRate: number;
  /** Exponential rate (1/s) at which the summed roll follows its target. */
  rollSmooth: number;
  /** Fraction of the lean kept in third person. */
  thirdPersonScale: number;
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

export function defaultThirdPersonTunables(): ThirdPersonTunables {
  return {
    distance: 3.2,
    shoulder: 0.4,
    height: 0.35,
    pivotHeight: 1.5,
    probeRadius: 0.2,
    probeMargin: 0.06,
    minDistance: 0.15,
    growRate: 10,
    shrinkRate: 45,
    transitionTime: 0.25,
    landDipScale: 0.3,
    hideDistance: 0.6,
    turnRate: 10,
  };
}

export function defaultCameraFeelTunables(): CameraFeelTunables {
  return {
    strafeRollDeg: 1.5,
    turnRollDeg: 1.0,
    turnRollRefRate: 2.5,
    rollSmooth: 8,
    thirdPersonScale: 0.3,
  };
}

export type Stance = 'stand' | 'crouch';
export type StepTier = 'crouch' | 'walk' | 'sprint';
export type ViewMode = 'first' | 'third';

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
  /**
   * What the foot was on — an index into `paint/materials`. §3.9 makes this a loudness: the
   * same stride is 1.5x on steel and 0.6x on dust, in paint and in hearing alike.
   *
   * It comes from the box the collision pass resolved against (`MoveResult.groundBox`), never
   * from a fresh probe. A downward raycast would be a second opinion about which surface the
   * foot is on, and the tick it disagrees is the tick the game reports a sound the physics did
   * not make.
   */
  readonly mat: number;
}

export interface LandEvent {
  readonly type: 'land';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Downward speed at touchdown, m/s. */
  readonly impactSpeed: number;
  readonly stance: Stance;
  /** What was landed *on* — see `FootstepEvent.mat`. A 14 m/s landing on steel paints 21 m. */
  readonly mat: number;
}

export type PlayerEvent = FootstepEvent | LandEvent;
export type PlayerEventListener = (event: PlayerEvent) => void;

/**
 * Which of §3.3's three step classes a gait belongs to — the gait ladder, in one function.
 *
 * Exported and separate from the emitter because §3.8's Halo has to answer the same question
 * *between* footfalls: "how loud am I right now" is the class of the footfall the body is in the
 * middle of making, and the readout must be able to name it without waiting for the foot to land.
 * A second copy of the sprint threshold on the readout side would put the ring a gait behind the
 * sound on exactly the frames the player is deciding whether to commit.
 */
export function stepTierFor(speed: number, crouched: boolean, m: MovementTunables): StepTier {
  if (crouched) return 'crouch';
  return speed > (m.walkSpeed + m.sprintSpeed) / 2 ? 'sprint' : 'walk';
}

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Landings below this impact speed do not dip the camera at all, m/s. */
const LAND_DIP_MIN_SPEED = 3;
/** Impact speed that produces the full `landDipMax` dip, m/s. */
const LAND_DIP_FULL_SPEED = 13;
/** Exponential rate (1/s) at which the dip is taken up — fast in, slow out. */
const LAND_DIP_ATTACK = 50;
/** Below this horizontal speed the body keeps whatever heading it already had, m/s. */
const FACING_MIN_SPEED = 0.25;
/**
 * Below this horizontal speed the stride does not advance and no footfall is laid down, m/s.
 *
 * Named because two things read it now: the stride phase, and §3.8's Halo, which has to answer
 * "how loud am I" with *nothing* when the body is making no contact at all.
 */
const STRIDE_MIN_SPEED = 0.05;
/** Exponential rate (1/s) that de-spikes the raw yaw rate before it drives roll. */
const YAW_RATE_SMOOTH = 14;
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

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Wraps an angle difference into (-π, π]. */
function wrapAngle(a: number): number {
  let v = a % TWO_PI;
  if (v > Math.PI) v -= TWO_PI;
  else if (v <= -Math.PI) v += TWO_PI;
  return v;
}

/** Shortest-arc interpolation between two angles. */
function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** Camera-space axes in world space. Shared scratch — read it before calling again. */
interface CameraBasis {
  fx: number;
  fy: number;
  fz: number;
  rx: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
  /** Boom offset from the pivot at full length. */
  ox: number;
  oy: number;
  oz: number;
  /** Length of that offset. */
  length: number;
}

const basisScratch: CameraBasis = {
  fx: 0, fy: 0, fz: 0, rx: 0, rz: 0, ux: 0, uy: 0, uz: 0, ox: 0, oy: 0, oz: 0, length: 0,
};

/**
 * Builds the camera's world-space axes at the given look angles plus the third-person boom
 * offset hung off them. Both the collision sweep (sim tick) and the camera placement (render)
 * need exactly this, and they must not be allowed to drift apart.
 */
function cameraBasis(yaw: number, pitch: number, tp: ThirdPersonTunables): CameraBasis {
  const b = basisScratch;
  const cp = Math.cos(pitch);
  b.fx = -Math.sin(yaw) * cp;
  b.fy = Math.sin(pitch);
  b.fz = -Math.cos(yaw) * cp;
  b.rx = Math.cos(yaw);
  b.rz = -Math.sin(yaw);
  // up = right x forward (right has no Y component, so two terms drop out).
  b.ux = -b.rz * b.fy;
  b.uy = b.rz * b.fx - b.rx * b.fz;
  b.uz = b.rx * b.fy;
  b.ox = -b.fx * tp.distance + b.ux * tp.height + b.rx * tp.shoulder;
  b.oy = -b.fy * tp.distance + b.uy * tp.height;
  b.oz = -b.fz * tp.distance + b.uz * tp.height + b.rz * tp.shoulder;
  b.length = Math.hypot(b.ox, b.oy, b.oz);
  return b;
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
  /**
   * Largest dip since the last respawn. The dip peaks and decays inside a few fixed ticks, and
   * an observer outside the loop only ever sees the value the *last* tick of a rendered frame
   * happened to leave behind — on a slow host that is reliably past the peak. Held here so that
   * "landing dips the camera" can be measured at simulation rate rather than at frame rate.
   */
  private landDipPeak = 0;
  private prevLandDip = 0;
  private landDipTarget = 0;
  /** Footfalls emitted since boot — HUD readout and a hook for the sound layer. */
  stepCount = 0;

  // ---- body heading (render-only; the body never steers the physics) ---------
  private facingYaw = 0;
  private prevFacingYaw = 0;

  // ---- camera lean ----------------------------------------------------------
  /** Smoothed yaw rate, rad/s. */
  private yawRate = 0;
  /** Smoothed strafe + turn roll, radians. Stride roll is added on top at render time. */
  private feelRoll = 0;
  private prevFeelRoll = 0;

  // ---- third-person boom ----------------------------------------------------
  private viewTarget: ViewMode = 'first';
  /** 0 = first person, 1 = third person; the transition drives it linearly. */
  private viewBlendRaw = 0;
  private prevViewBlendRaw = 0;
  /** Current boom length along the desired offset direction, metres. */
  private boom = 0;
  private prevBoom = 0;
  private boomTargetLength = 0;
  /** Full boom length with nothing in the way — the reference the squeeze is measured against. */
  private boomRestLength = 0;

  /** Where the body should be drawn this frame; written by `applyToCamera`. */
  readonly renderPosition = new THREE.Vector3();
  private renderFacing = 0;
  private renderBodyVisible = false;

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
  /**
   * This controller's own `moveBody` output, allocated once. Not per tick, and not the module
   * default: once other bodies (thrown props, spiders) move in the same fixed update, the shared
   * instance is whoever moved last, and this one is read after `moveBody` returns.
   */
  private readonly moveResult: MoveResult = createMoveResult();
  /**
   * What the feet are currently standing on (§3.9), carried on every footfall and landing.
   *
   * Held on the controller rather than read out of `moveResult` at the emit site, because the
   * two are not always in step: `advanceMantle` finishes a climb by setting `grounded` itself
   * without calling `moveBody` at all, so on that one tick the move result still describes the
   * airborne body and its `groundBox` is null — and that tick can emit a footfall, because the
   * exit speed of a vault is enough to advance the stride. So this is updated wherever the body
   * genuinely arrives somewhere: from `groundBox` after every move, and from the ledge itself
   * when a climb completes.
   *
   * It deliberately keeps its last value while airborne. A landing is emitted on the tick the
   * feet touch down, by which point the new surface has already been written here — and if
   * anything ever emits a contact sound in mid-air, the surface it left is a better answer than
   * concrete-by-default.
   */
  private groundMat: number = MAT_CONCRETE;
  /** The material of the ledge the current climb is heading for — see `groundMat`. */
  private mantleMat: number = MAT_CONCRETE;
  private readonly probeScratch: Aabb[] = [];
  private readonly listeners = new Set<PlayerEventListener>();

  constructor(
    private world: StaticWorld,
    readonly movement: MovementTunables,
    readonly camera: CameraTunables,
    readonly bob: BobTunables = defaultBobTunables(),
    readonly mantle: MantleTunables = defaultMantleTunables(),
    readonly thirdPerson: ThirdPersonTunables = defaultThirdPersonTunables(),
    readonly feel: CameraFeelTunables = defaultCameraFeelTunables(),
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
    // A respawned body has not touched anything yet, so the surface it *used* to be on is not an
    // answer about where it is now. The first grounded tick overwrites this.
    this.groundMat = MAT_CONCRETE;
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
    this.landDipPeak = 0;
    this.facingYaw = this.yaw;
    this.prevFacingYaw = this.yaw;
    this.yawRate = 0;
    this.feelRoll = 0;
    this.prevFeelRoll = 0;
    // The view mode itself survives a respawn (it is a preference, not sim state); only the
    // boom is re-seated so it does not sweep across the room from wherever the player died.
    this.boom = this.thirdPerson.distance;
    this.prevBoom = this.boom;
    this.boomTargetLength = this.boom;
    this.boomRestLength = this.boom;
  }

  // ---- view mode -----------------------------------------------------------

  /** The mode the camera is heading for; `viewBlend` says how far along it is. */
  get viewMode(): ViewMode {
    return this.viewTarget;
  }

  /** 0 = fully first person, 1 = fully third person. */
  get viewBlend(): number {
    return this.viewBlendRaw;
  }

  toggleView(): void {
    this.viewTarget = this.viewTarget === 'first' ? 'third' : 'first';
  }

  setViewMode(mode: ViewMode): void {
    this.viewTarget = mode;
  }

  /** Current boom length, metres — shrinks when a wall is behind the player. */
  get boomLength(): number {
    return this.boom;
  }

  /** Boom length the camera would use with nothing in the way, metres. */
  get boomRest(): number {
    return this.boomRestLength;
  }

  /** Length the wall sweep asked for this tick, before smoothing — metres. */
  get boomTarget(): number {
    return this.boomTargetLength;
  }

  /** Smoothed body heading, radians, same convention as `yaw`. */
  get bodyFacing(): number {
    return this.renderFacing;
  }

  /** False whenever the camera is close enough to the head that the body must not be drawn. */
  get bodyVisible(): boolean {
    return this.renderBodyVisible;
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

  /**
   * True while the body is actually laying down footfalls: grounded, not mid-climb, and moving.
   *
   * The stride advance reads it, and so does the Halo — which is why it is a getter rather than
   * three conditions repeated at two call sites. A body that is standing still, in the air, or
   * being carried through a mantle is making no contact noise, and §3.8's readout has to say so.
   */
  get striding(): boolean {
    return (
      this.grounded &&
      !this.mantleActive &&
      Math.hypot(this.velocity.x, this.velocity.z) > STRIDE_MIN_SPEED
    );
  }

  /**
   * The step class the body is laying down right now, or `null` while it is laying down none.
   *
   * §3.8's Halo is the caller: this plus `groundMaterial` is everything the readout needs to ask
   * the bus how far the body currently carries.
   */
  get stepTier(): StepTier | null {
    if (!this.striding) return null;
    return stepTierFor(
      Math.hypot(this.velocity.x, this.velocity.z),
      this.crouched,
      this.movement,
    );
  }

  /**
   * What the feet are on — an index into `paint/materials` (§3.9). See `groundMat` for why it is
   * the collision pass's answer and never a fresh probe.
   */
  get groundMaterial(): number {
    return this.groundMat;
  }

  /** Current render-only landing dip, metres (0 when settled). Exposed for tooling/HUD. */
  get landDipOffset(): number {
    return this.landDip;
  }

  /** Deepest dip since the last respawn, metres. Tooling only — see `landDipPeak`. */
  get landDipPeakOffset(): number {
    return this.landDipPeak;
  }

  get mantling(): boolean {
    return this.mantleActive;
  }

  /** One fixed simulation tick. */
  update(dt: number, input: PlayerInputSource): void {
    this.prevPosition.copy(this.position);
    this.prevEyeHeight = this.eyeHeight;
    this.prevStepOffset = this.stepOffset;
    this.prevStridePhase = this.stridePhase;
    this.prevBobGain = this.bobGain;
    this.prevLandDip = this.landDip;
    this.prevFacingYaw = this.facingYaw;
    this.prevFeelRoll = this.feelRoll;
    this.prevBoom = this.boom;
    this.prevViewBlendRaw = this.viewBlendRaw;

    const yawBefore = this.yaw;
    this.updateLook(input);
    const rawYawRate = dt > 0 ? wrapAngle(this.yaw - yawBefore) / dt : 0;

    if (this.mantleActive) this.advanceMantle(dt);
    else this.simulate(dt, input);

    this.updateViewEffects(dt);
    this.updateFacing(dt);
    this.updateRoll(dt, rawYawRate);
    this.updateBoom(dt);
    this.updateViewBlend(dt);
  }

  /** The ordinary (non-mantling) movement tick. */
  private simulate(dt: number, input: PlayerInputSource): void {
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
    const res = moveBody(
      this.world,
      this.position,
      this.velocity,
      dt,
      this.shape,
      wasGrounded,
      this.moveResult,
    );

    this.grounded = res.grounded;
    // Before the landing is emitted, so a touchdown reports the surface it struck rather than
    // the one it jumped from.
    if (res.groundBox !== null) this.groundMat = res.groundBox.mat;
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
      mat: this.groundMat,
    });
    const over = (impactSpeed - LAND_DIP_MIN_SPEED) / (LAND_DIP_FULL_SPEED - LAND_DIP_MIN_SPEED);
    if (over <= 0) return;
    const dip = this.movement.landDipMax * clamp01(over);
    if (dip > this.landDipTarget) this.landDipTarget = dip;
  }

  private updateLook(input: PlayerInputSource): void {
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

  private updateStance(input: PlayerInputSource, forwardAxis: number): void {
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

  private updateJump(input: PlayerInputSource, dt: number): void {
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
  private tryMantle(input: PlayerInputSource, wishSpeed: number): boolean {
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
    let landMat = MAT_CONCRETE;
    let endCrouched = false;
    let found = false;
    for (let t = hitT; t <= scanFar + 1e-6; t += MANTLE_PROBE_STEP) {
      const px = this.position.x + dirX * t;
      const pz = this.position.z + dirZ * t;
      const ledge = this.ledgeUnder(candidates, px, pz, ledgeY);
      if (ledge === null) continue;
      landMat = ledge.mat;
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
    this.mantleMat = landMat;
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

  /**
   * The surface (x, z) sits properly *on* — top at the ledge height, not merely near it — or
   * `null`. Answers with the box rather than with `true` because the climb has to record what
   * the ledge is made of: it is the surface the feet will be on when the climb ends, and
   * `moveBody` never runs on that tick to say so (see `groundMat`).
   */
  private ledgeUnder(
    candidates: readonly Aabb[],
    x: number,
    z: number,
    ledgeY: number,
  ): Aabb | null {
    for (const b of candidates) {
      if (Math.abs(b.maxY - ledgeY) > 1e-3) continue;
      if (x < b.minX + MANTLE_LANDING_MARGIN || x > b.maxX - MANTLE_LANDING_MARGIN) continue;
      if (z < b.minZ + MANTLE_LANDING_MARGIN || z > b.maxZ - MANTLE_LANDING_MARGIN) continue;
      return b;
    }
    return null;
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
    // The climb, not `moveBody`, is what put the feet up here, so it is also what says what they
    // are on. Without this the first footfall off a vault carries whatever was under the body
    // before the climb — the floor, when you are now standing on a steel crate.
    this.groundMat = this.mantleMat;
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
    // The bob envelope fades in from a standstill, so it is on its feet the moment the body is
    // grounded — one condition short of `striding`, which also asks whether it is moving.
    const onItsFeet = this.grounded && !this.mantleActive;

    const speedScale = clamp01(speed / Math.max(0.01, m.sprintSpeed));
    const target = onItsFeet ? speedScale * (this.crouched ? b.crouchScale : 1) : 0;
    this.bobGain += (target - this.bobGain) * smoothFactor(b.blendRate, dt);
    if (this.bobGain < 1e-4 && target === 0) this.bobGain = 0;

    if (this.striding) {
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
    if (this.landDip > this.landDipPeak) this.landDipPeak = this.landDip;

    const targetEye = this.crouched ? m.eyeCrouch : m.eyeStand;
    this.eyeHeight += (targetEye - this.eyeHeight) * smoothFactor(m.eyeSmoothRate, dt);
    this.stepOffset -= this.stepOffset * smoothFactor(m.stepSmoothRate, dt);
    if (Math.abs(this.stepOffset) < 1e-4) this.stepOffset = 0;

    const targetFov =
      this.camera.fov + (this.sprinting && speed > 0.5 ? this.camera.sprintFovBonus : 0);
    this.currentFov += (targetFov - this.currentFov) * smoothFactor(this.camera.fovSmoothRate, dt);
  }

  /**
   * The body faces where it is *going*, not where the camera is pointing: there are no strafe
   * clips, so a movement-facing rig is the one that reads correctly. Standing still keeps the
   * last heading rather than snapping to the camera.
   */
  private updateFacing(dt: number): void {
    let dirX: number;
    let dirZ: number;
    if (this.mantleActive) {
      dirX = this.mantleDirX;
      dirZ = this.mantleDirZ;
    } else {
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      if (speed < FACING_MIN_SPEED) return;
      dirX = this.velocity.x / speed;
      dirZ = this.velocity.z / speed;
    }
    if (Math.abs(dirX) + Math.abs(dirZ) < 1e-6) return;
    // Inverse of "forward at yaw f is (-sin f, 0, -cos f)".
    const target = Math.atan2(-dirX, -dirZ);
    this.facingYaw = wrapAngle(
      lerpAngle(this.facingYaw, target, smoothFactor(this.thirdPerson.turnRate, dt)),
    );
  }

  /** Strafe lean + turn lean, summed then smoothed once. Never integrated, so never drifts. */
  private updateRoll(dt: number, rawYawRate: number): void {
    const f = this.feel;
    // Lateral speed measured against the camera's right, which is what the player feels.
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    const lateral = this.velocity.x * rightX + this.velocity.z * rightZ;
    const latNorm = clampUnit(lateral / Math.max(0.1, this.movement.walkSpeed));

    // Raw look deltas arrive in lumps (one mouse event per several ticks, or a whole frame's
    // worth on the first tick of a slow frame), so the rate is de-spiked before it is used.
    this.yawRate += (rawYawRate - this.yawRate) * smoothFactor(YAW_RATE_SMOOTH, dt);
    const turnNorm = clampUnit(this.yawRate / Math.max(0.05, f.turnRollRefRate));

    // Strafing right and turning right both bank right, which is a negative roll about the
    // camera's forward axis.
    const target = (-f.strafeRollDeg * latNorm + f.turnRollDeg * turnNorm) * DEG2RAD;
    this.feelRoll += (target - this.feelRoll) * smoothFactor(f.rollSmooth, dt);
    if (Math.abs(this.feelRoll) < 1e-7 && Math.abs(target) < 1e-7) this.feelRoll = 0;
  }

  /**
   * Keeps the third-person boom out of the walls. The sweep runs every tick regardless of the
   * current mode so that toggling into third person never starts from a stale length.
   */
  private updateBoom(dt: number): void {
    const tp = this.thirdPerson;
    const pivotY = this.position.y + tp.pivotHeight + (this.eyeHeight - this.movement.eyeStand);

    // The boom orbits with the look angles, so its direction is rebuilt every tick.
    const basis = cameraBasis(this.yaw, this.pitch, tp);
    const rest = basis.length;
    this.boomRestLength = rest;
    if (rest < 1e-4) {
      this.boom = 0;
      this.boomTargetLength = 0;
      return;
    }

    const hit = sweepSphereWorld(
      this.world,
      this.position.x,
      pivotY,
      this.position.z,
      basis.ox / rest,
      basis.oy / rest,
      basis.oz / rest,
      rest,
      tp.probeRadius,
    );
    const target =
      hit >= rest
        ? rest
        : Math.min(rest, Math.max(tp.minDistance, hit - tp.probeMargin));
    this.boomTargetLength = target;

    // Pull in fast, ease back out: the reverse pops, and popping is the whole failure mode.
    const rate = target < this.boom ? tp.shrinkRate : tp.growRate;
    this.boom += (target - this.boom) * smoothFactor(rate, dt);
  }

  /** Linear ramp between the two camera modes; `applyToCamera` eases it. */
  private updateViewBlend(dt: number): void {
    const time = this.thirdPerson.transitionTime;
    const step = time > 0 ? dt / time : 1;
    this.viewBlendRaw = clamp01(this.viewBlendRaw + (this.viewTarget === 'third' ? step : -step));
  }

  private emitFootstep(halfCycle: number, speed: number): void {
    this.stepCount++;
    const tier = stepTierFor(speed, this.crouched, this.movement);
    this.emit({
      type: 'footstep',
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      speed,
      tier,
      foot: (((halfCycle % 2) + 2) % 2) === 0 ? 'left' : 'right',
      mat: this.groundMat,
    });
  }

  /**
   * Per-frame: places the camera, interpolating between the last two sim ticks.
   *
   * Both camera modes are evaluated and then blended by position, which is what makes the
   * V toggle a 0.25 s move rather than a cut. Stride bob belongs to the first-person eye only
   * — on a boom it just reads as a wobbly camera — while the landing dip survives at
   * `landDipScale`.
   *
   * This is also where the body's render pose is published (`renderPosition`, `bodyFacing`,
   * `bodyVisible`): whatever draws the body reads those and never touches the simulation.
   */
  applyToCamera(camera: THREE.PerspectiveCamera, alpha: number): void {
    const a = clamp01(alpha);
    const x = this.prevPosition.x + (this.position.x - this.prevPosition.x) * a;
    const y = this.prevPosition.y + (this.position.y - this.prevPosition.y) * a;
    const z = this.prevPosition.z + (this.position.z - this.prevPosition.z) * a;
    const eye = this.prevEyeHeight + (this.eyeHeight - this.prevEyeHeight) * a;
    const step = this.prevStepOffset + (this.stepOffset - this.prevStepOffset) * a;
    const dip = this.prevLandDip + (this.landDip - this.prevLandDip) * a;
    const tp = this.thirdPerson;
    const blend = smoothstep(
      this.prevViewBlendRaw + (this.viewBlendRaw - this.prevViewBlendRaw) * a,
    );

    this.renderPosition.set(x, y, z);
    this.renderFacing = lerpAngle(this.prevFacingYaw, this.facingYaw, a);

    let bobUp = 0;
    let bobSide = 0;
    let bobRoll = 0;
    const gain = this.prevBobGain + (this.bobGain - this.prevBobGain) * a;
    if (this.bob.enabled && gain > 1e-4) {
      const phase = this.prevStridePhase + (this.stridePhase - this.prevStridePhase) * a;
      const sway = Math.sin(phase);
      // Two dips per cycle (one per footfall), one full sway, roll riding the sway.
      bobUp = this.bob.vertAmp * gain * Math.cos(2 * phase);
      bobSide = this.bob.latAmp * gain * sway;
      bobRoll = this.bob.rollDeg * DEG2RAD * gain * sway;
    }
    const basis = cameraBasis(this.yaw, this.pitch, tp);

    // First person: the eye, with the full bob and the full landing dip.
    const eyeX = x + basis.rx * bobSide * (1 - blend);
    const eyeY = y + eye - step + bobUp * (1 - blend) - dip;
    const eyeZ = z + basis.rz * bobSide * (1 - blend);

    let camX = eyeX;
    let camY = eyeY;
    let camZ = eyeZ;
    let pivotDistance = 0;

    if (blend > 0) {
      // Third person: the boom, hung off the neck, already shortened by `updateBoom`.
      const pivotX = x;
      const pivotY = y + tp.pivotHeight + (eye - this.movement.eyeStand) - dip * tp.landDipScale;
      const pivotZ = z;
      const boom = this.prevBoom + (this.boom - this.prevBoom) * a;
      const k = basis.length > 1e-4 ? boom / basis.length : 0;
      const bx = pivotX + basis.ox * k;
      const by = pivotY + basis.oy * k;
      const bz = pivotZ + basis.oz * k;

      camX = eyeX + (bx - eyeX) * blend;
      camY = eyeY + (by - eyeY) * blend;
      camZ = eyeZ + (bz - eyeZ) * blend;
      pivotDistance = Math.hypot(camX - pivotX, camY - pivotY, camZ - pivotZ);
    }

    // One rule covers both "mid-transition" and "squeezed against a wall": if the lens is
    // inside the head, there is no body to draw.
    this.renderBodyVisible = blend > 0 && pivotDistance > tp.hideDistance;

    const feelRoll = this.prevFeelRoll + (this.feelRoll - this.prevFeelRoll) * a;
    const leanScale = 1 + (this.feel.thirdPersonScale - 1) * blend;
    const roll = bobRoll * (1 - blend) + feelRoll * leanScale;

    camera.position.set(camX, camY, camZ);
    camera.rotation.set(this.pitch, this.yaw, roll, 'YXZ');
    if (Math.abs(camera.fov - this.currentFov) > 1e-3) {
      camera.fov = this.currentFov;
      camera.updateProjectionMatrix();
    }
  }
}
