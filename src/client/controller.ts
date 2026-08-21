// First-person controller. Owns position/look and resolves movement against the world.

import { movePlayer, PLAYER_HEIGHT } from '../shared/collide.ts';
import type { World } from '../shared/world.ts';
import type { Vec3 } from '../shared/math.ts';
import { clamp } from '../shared/math.ts';

export const EYE = 1.58;
export const CROUCH_HEIGHT = 1.05;
export const CROUCH_EYE = 0.95;

export interface MoveTuning {
  walk: number;
  sprint: number;
  crouch: number;
  accel: number;
  friction: number;
  gravity: number;
}

export const DEFAULT_TUNING: MoveTuning = {
  walk: 4.1, sprint: 6.7, crouch: 1.9,
  accel: 15, friction: 13, gravity: 22,
};

export class Controller {
  pos: Vec3;
  yaw: number;
  pitch = 0;
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  grounded = true;
  crouching = false;
  sprinting = false;
  /** Metres travelled on foot since last reset — drives footstep emission. */
  strideAccum = 0;
  /** 0..1 how much noise the player is currently making. */
  noise = 0;
  tuning: MoveTuning = { ...DEFAULT_TUNING };
  keys = new Set<string>();
  /** Set by gameplay to temporarily slow the player (e.g. carrying the artifact). */
  speedMul = 1;
  canSprint = true;

  constructor(spawn: { x: number; y: number; z: number; yaw: number }, private world: World) {
    this.pos = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.yaw = spawn.yaw;
  }

  get height() { return this.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT; }
  get eyeY() { return this.pos.y + (this.crouching ? CROUCH_EYE : EYE); }

  look(dx: number, dy: number, sens: number) {
    this.yaw -= dx * sens;
    this.pitch = clamp(this.pitch - dy * sens, -1.5, 1.5);
  }

  step(dt: number) {
    const k = this.keys;
    let fx = 0, fz = 0;
    if (k.has('KeyW')) fz -= 1;
    if (k.has('KeyS')) fz += 1;
    if (k.has('KeyA')) fx -= 1;
    if (k.has('KeyD')) fx += 1;
    const l = Math.hypot(fx, fz);
    if (l > 0) { fx /= l; fz /= l; }

    this.crouching = k.has('ControlLeft') || k.has('KeyC');
    this.sprinting = this.canSprint && k.has('ShiftLeft') && !this.crouching && l > 0;

    // Crouch must not clip us into a ceiling when standing back up.
    if (!this.crouching) {
      const probe = movePlayer(this.world, this.pos, 0, 0, 0, PLAYER_HEIGHT);
      if (Math.abs(probe.pos.y - this.pos.y) > 0.01) this.crouching = true;
    }

    const speed = (this.crouching ? this.tuning.crouch : this.sprinting ? this.tuning.sprint : this.tuning.walk) * this.speedMul;

    // Camera-relative wish direction.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const wx = (fx * cy - fz * sy) * speed;
    const wz = (-fx * sy - fz * cy) * speed;

    // Exponential approach to the wish velocity: snappy but not instant.
    const t = 1 - Math.exp(-(l > 0 ? this.tuning.accel : this.tuning.friction) * dt);
    this.vel.x += (wx - this.vel.x) * t;
    this.vel.z += (wz - this.vel.z) * t;

    this.vel.y -= this.tuning.gravity * dt;

    const before = { ...this.pos };
    const r = movePlayer(this.world, this.pos, this.vel.x * dt, this.vel.y * dt, this.vel.z * dt, this.height);
    this.pos = r.pos;
    this.grounded = r.grounded;
    if (this.grounded && this.vel.y < 0) this.vel.y = 0;

    const moved = Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
    this.strideAccum += moved;
    // Noise scales with actual speed and is near-silent while crouched.
    const spd = moved / Math.max(dt, 1e-4);
    this.noise = this.crouching ? spd * 0.06 : this.sprinting ? spd * 0.22 : spd * 0.12;
  }

  teleport(p: { x: number; y: number; z: number }, yaw?: number) {
    this.pos = { x: p.x, y: p.y, z: p.z };
    this.vel = { x: 0, y: 0, z: 0 };
    if (yaw !== undefined) this.yaw = yaw;
  }
}
