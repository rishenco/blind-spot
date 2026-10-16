import * as THREE from 'three';
import ramDef from '../models/ram';
import { Animator } from './animator';
import { distanceToEdgeAlong, edgeDistance } from './arena';
import { angleDiff } from './player';
import { GRAVITY, RAM } from './tuning';
import type { Game } from './game';

export type RamState =
  | 'intro'
  | 'turn'
  | 'paw'
  | 'charge'
  | 'skid'
  | 'teeter'
  | 'stunned'
  | 'recover'
  | 'kicked'
  | 'falling'
  | 'out'
  | 'gloat';

const tmp = new THREE.Vector3();

export class Ram {
  readonly anim = new Animator(ramDef, 'idle');
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly dir = new THREE.Vector3(0, 0, 1); // locked charge direction
  yaw = 0;
  state: RamState = 'intro';
  stateTime = 0;
  /** Charges done so far — drives escalation. */
  charges = 0;
  private missed = false;
  private stepTimer = 0;
  private windup = 1;
  private grounded = true;

  get root(): THREE.Object3D {
    return this.anim.root;
  }

  /** A stunned (or teetering) ram can be kicked away. */
  get kickable(): boolean {
    return this.state === 'stunned' || this.state === 'teeter';
  }

  /** Physically there to bump into. */
  get solid(): boolean {
    return this.state !== 'falling' && this.state !== 'out' && this.state !== 'kicked';
  }

  reset(x: number, z: number, yaw: number): void {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.charges = 0;
    this.grounded = true;
    this.root.visible = true;
    this.root.rotation.set(0, yaw, 0);
    this.set('intro');
  }

  set(state: RamState): void {
    this.state = state;
    this.stateTime = 0;
  }

  kicked(dir: THREE.Vector3, game: Game): void {
    this.vel.set(dir.x * RAM.kickH, RAM.kickV, dir.z * RAM.kickH);
    this.grounded = false;
    this.set('kicked');
    this.anim.play('thrown', 0.05);
    game.audio.kick();
    game.audio.bleat(1.3);
    game.fx.shake = 0.7;
    game.fx.dust(this.pos.clone().setY(0.8), 8, { speed: 3 });
    game.hitstop(0.1);
  }

  update(dt: number, game: Game): void {
    this.stateTime += dt;
    const player = game.player;
    tmp.subVectors(player.pos, this.pos).setY(0);
    const toPlayerYaw = Math.atan2(tmp.x, tmp.z);
    const fighting = game.phase === 'fight';
    const n = this.charges;

    switch (this.state) {
      case 'intro':
        this.anim.play('idle');
        if (fighting && this.stateTime > RAM.introTime) this.set('turn');
        break;
      case 'turn':
        this.anim.play('idle');
        this.turnTo(toPlayerYaw, RAM.turnSpeed, dt);
        if (Math.abs(angleDiff(toPlayerYaw, this.yaw)) < 0.12 || this.stateTime > 0.7) {
          this.set('paw');
          this.windup = RAM.windup(n);
          game.audio.snort();
          this.stepTimer = 0;
        }
        break;
      case 'paw':
        this.anim.play('paw', 0.1);
        this.turnTo(toPlayerYaw, 3.5, dt);
        this.stepTimer -= dt;
        if (this.stepTimer <= 0) {
          this.stepTimer = 0.5;
          game.audio.scrape();
          game.fx.dust(this.footPos(0.6), 2, { speed: 0.8, size: 0.2, up: 0.6 });
        }
        if (this.stateTime > this.windup) {
          this.dir.set(Math.sin(toPlayerYaw), 0, Math.cos(toPlayerYaw));
          this.yaw = toPlayerYaw;
          this.missed = false;
          this.set('charge');
          game.audio.bleat(0.9);
          game.audio.bpm = 118 + Math.min(40, n * 4);
        }
        break;
      case 'charge': {
        this.anim.play('charge', 0.08);
        const speed = Math.min(RAM.chargeSpeed(n), Math.hypot(this.vel.x, this.vel.z) + RAM.chargeAccel * dt);
        this.vel.set(this.dir.x * speed, 0, this.dir.z * speed);
        this.footsteps(dt, game, 0.17, 0.6);
        // Hit or miss?
        const along = tmp.dot(this.dir);
        const lat = Math.abs(tmp.x * this.dir.z - tmp.z * this.dir.x);
        const playerLow = player.pos.y < 1.4;
        if (!player.invulnerable && playerLow && along > -0.3 && along < RAM.hitReachAhead && lat < RAM.hitWidth) {
          tmp.copy(this.dir).multiplyScalar(0.85).addScaledVector(lateralSign(this.dir, player.pos, this.pos), 0.3).normalize();
          player.hit(tmp, game);
          this.missed = false;
          this.charges++;
          this.set('skid');
        } else if (this.stateTime > 0.25 && (along < -0.6 || lat > RAM.missLateral || player.state === 'out')) {
          // Lost the target: realize, brake. Too late near the edge = goes over.
          if (player.state === 'dodge' && lat < 2.5 && along > -2) game.slowmo(0.35, 0.3);
          this.missed = true;
          this.charges++;
          this.set('skid');
          game.audio.bleat(1.5);
        }
        break;
      }
      case 'skid': {
        this.anim.play('skid', 0.06);
        const v = Math.hypot(this.vel.x, this.vel.z);
        let decel = RAM.skidDecel;
        if (!this.missed) {
          // After a hit the ram brakes as hard as it needs to stay on the plateau.
          const room = distanceToEdgeAlong(this.pos.x, this.pos.z, this.dir.x, this.dir.z) - 0.9;
          if (room > 0.05) decel = Math.max(decel, (v * v) / (2 * room));
          else decel = 200;
        }
        const nv = Math.max(0, v - decel * dt);
        this.vel.set(this.dir.x * nv, 0, this.dir.z * nv);
        if (Math.random() < dt * 25) game.fx.dust(this.footPos(0.4), 1, { speed: 1.5, size: 0.3 });
        if (nv < 0.2) {
          this.vel.set(0, 0, 0);
          if (edgeDistance(this.pos.x, this.pos.z) < RAM.teeterZone) {
            this.set('teeter');
            game.audio.bleat(1.7);
          } else this.set(this.missed ? 'stunned' : 'recover');
        }
        break;
      }
      case 'teeter':
        this.anim.play('skid', 0.1);
        if (this.stateTime > RAM.teeterTime) this.set(this.missed ? 'stunned' : 'recover');
        break;
      case 'stunned':
        this.anim.play('stunned', 0.15);
        if (this.stateTime > RAM.stunTime(n)) this.set('recover');
        break;
      case 'recover':
        this.anim.play('idle', 0.2);
        this.turnTo(toPlayerYaw, RAM.turnSpeed * 0.6, dt);
        if (this.stateTime > RAM.recoverTime && fighting) this.set('turn');
        break;
      case 'kicked':
        if (this.grounded) {
          this.anim.play('skid', 0.1);
          const v = Math.hypot(this.vel.x, this.vel.z);
          const nv = Math.max(0, v - RAM.slideDecel * dt);
          if (v > 0) this.vel.multiplyScalar(nv / v);
          if (Math.random() < dt * 20) game.fx.dust(this.footPos(0.3), 1, { speed: 1.2, size: 0.3 });
          if (nv < 0.2) {
            this.vel.set(0, 0, 0);
            this.set('recover');
            game.audio.snort();
          }
        }
        break;
      case 'falling':
      case 'out':
        break;
      case 'gloat':
        this.anim.play('headbang', 0.2);
        this.turnTo(toPlayerYaw, 3, dt);
        break;
    }

    if (this.state !== 'out') this.integrate(dt, game);
    this.anim.update(dt);
  }

  private integrate(dt: number, game: Game): void {
    const p = this.pos;
    p.x += this.vel.x * dt;
    p.z += this.vel.z * dt;
    const inside = edgeDistance(p.x, p.z) > -0.15;
    if (this.grounded && !inside) {
      this.grounded = false;
      this.vel.y = 0;
      if (this.state !== 'kicked') {
        this.set('falling');
        this.anim.play('fall', 0.15);
        game.audio.bleat(1.9);
      }
    }
    if (!this.grounded) {
      this.vel.y -= GRAVITY * dt;
      p.y += this.vel.y * dt;
      if (p.y <= 0 && this.vel.y < 0) {
        if (inside && p.y > -0.6) {
          p.y = 0;
          this.vel.y = 0;
          this.grounded = true;
          game.fx.dust(p.clone(), 8, { speed: 3 });
          game.audio.hoof(0.9);
          game.fx.shake = Math.max(game.fx.shake, 0.3);
        } else if (p.y < -1.0) {
          game.startFall('ram');
        }
      }
    }
    // Simple push-apart with the player when both are on the ground.
    const pl = game.player;
    if (this.solid && this.state !== 'charge' && pl.grounded && this.grounded && pl.state !== 'dodge') {
      tmp.subVectors(pl.pos, p).setY(0);
      const d = tmp.length();
      const min = 1.15;
      if (d < min && d > 0.001) pl.pos.addScaledVector(tmp, (min - d) / d);
    }
    this.root.position.copy(p);
    this.root.rotation.y = this.yaw;
  }

  private turnTo(target: number, rate: number, dt: number): void {
    this.yaw += angleDiff(target, this.yaw) * Math.min(1, rate * dt);
  }

  private footsteps(dt: number, game: Game, interval: number, loud: number): void {
    this.stepTimer -= dt;
    if (this.stepTimer <= 0) {
      this.stepTimer = interval;
      game.audio.hoof(loud);
      game.fx.dust(this.footPos(-0.4), 1, { speed: 1, size: 0.25, up: 0.5 });
    }
  }

  private footPos(forward: number): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.yaw) * forward, 0.1, Math.cos(this.yaw) * forward).add(this.pos);
  }
}

/** Unit vector perpendicular to dir, pointing to the side `target` is on (so hits glance sideways). */
function lateralSign(dir: THREE.Vector3, target: THREE.Vector3, origin: THREE.Vector3): THREE.Vector3 {
  const cross = (target.x - origin.x) * dir.z - (target.z - origin.z) * dir.x;
  const s = cross >= 0 ? 1 : -1;
  return new THREE.Vector3(dir.z * s, 0, -dir.x * s);
}
