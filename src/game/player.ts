import * as THREE from 'three';
import playerDef from '../models/player';
import { Animator } from './animator';
import { edgeDistance, outward } from './arena';
import { GRAVITY, PLAYER } from './tuning';
import type { Game } from './game';

export type PlayerState = 'move' | 'dodge' | 'kick' | 'bounce' | 'launched' | 'land' | 'flex' | 'falling' | 'out';

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

export class Player {
  readonly anim = new Animator(playerDef, 'idle');
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0; // facing; forward = (sin yaw, 0, cos yaw)
  state: PlayerState = 'move';
  stateTime = 0;
  grounded = true;
  private dodgeCooldown = 0;
  private kickDone = false;
  private dodgeDir = new THREE.Vector3();

  get root(): THREE.Object3D {
    return this.anim.root;
  }

  get invulnerable(): boolean {
    return this.state === 'dodge' || this.state === 'launched' || this.state === 'falling' || this.state === 'out';
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  reset(x: number, z: number, yaw: number): void {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.grounded = true;
    this.dodgeCooldown = 0;
    this.root.visible = true;
    this.root.rotation.set(0, yaw, 0);
    this.set('move');
  }

  set(state: PlayerState): void {
    this.state = state;
    this.stateTime = 0;
  }

  /** Stop in place on the plateau (used when the other character's fall starts). */
  freeze(): void {
    this.vel.set(0, this.grounded ? 0 : this.vel.y, 0);
    if (this.grounded && this.state !== 'out') this.set('move');
  }

  /** Called by the ram when it connects. */
  hit(dir: THREE.Vector3, game: Game): void {
    this.vel.set(dir.x * PLAYER.launchH, PLAYER.launchV, dir.z * PLAYER.launchH);
    this.grounded = false;
    this.yaw = Math.atan2(-dir.x, -dir.z); // face the ram while flying backwards
    this.set('launched');
    this.anim.play('tumble', 0.05);
    game.audio.smack();
    game.audio.grunt();
    game.fx.shake = 1;
    game.fx.dust(this.pos.clone().setY(0.8), 10, { speed: 4, size: 0.3 });
    game.hitstop(0.09);
  }

  update(dt: number, game: Game): void {
    const input = game.input;
    this.stateTime += dt;
    this.dodgeCooldown -= dt;
    const controllable = game.phase === 'fight';

    // Camera-relative wish direction.
    const ax = controllable ? input.axes() : { x: 0, y: 0 };
    const camYaw = game.cam.yaw;
    const wish = tmp.set(
      Math.sin(camYaw) * ax.y - Math.cos(camYaw) * ax.x,
      0,
      Math.cos(camYaw) * ax.y + Math.sin(camYaw) * ax.x,
    );
    if (wish.lengthSq() > 1) wish.normalize();

    switch (this.state) {
      case 'move':
      case 'flex': {
        if (this.state === 'flex' && (wish.lengthSq() > 0 || this.stateTime > 4)) this.set('move');
        this.groundMove(wish, this.state === 'flex' ? 0 : PLAYER.runSpeed, dt);
        if (wish.lengthSq() > 0.01) this.turnTo(Math.atan2(wish.x, wish.z), 14, dt);
        if (!controllable) break;
        if (input.take('Space') && this.dodgeCooldown <= 0 && this.grounded) {
          this.dodgeDir.copy(wish.lengthSq() > 0.01 ? wish : this.forward).normalize();
          this.yaw = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
          this.set('dodge');
          game.audio.whoosh();
        } else if (input.take('Mouse0') && this.grounded) {
          this.startKick(game);
        } else if (input.take('KeyF') && this.state !== 'flex' && this.grounded) {
          this.set('flex');
        }
        break;
      }
      case 'dodge': {
        const k = this.stateTime / PLAYER.dodgeTime;
        const speed = PLAYER.dodgeSpeed * (1 - 0.6 * k);
        this.vel.x = this.dodgeDir.x * speed;
        this.vel.z = this.dodgeDir.z * speed;
        if (this.stateTime > PLAYER.dodgeTime) {
          this.vel.x *= 0.35;
          this.vel.z *= 0.35;
          this.dodgeCooldown = PLAYER.dodgeCooldown;
          if (this.grounded) this.set('move');
          else {
            this.set('launched'); // dodged off the edge: keep air steering
            this.stateTime = PLAYER.hitstun;
          }
        }
        break;
      }
      case 'kick': {
        this.groundMove(wish, 0, dt);
        const [a, b] = PLAYER.kickActive;
        if (!this.kickDone && this.stateTime >= a && this.stateTime <= b) this.tryKickHit(game);
        if (this.stateTime > PLAYER.kickTime) this.set('move');
        break;
      }
      case 'bounce':
        this.groundMove(wish, 0, dt, 8);
        if (this.stateTime > PLAYER.bounceTime) this.set('move');
        break;
      case 'land':
        this.groundMove(wish, 0, dt, 18);
        if (this.stateTime > PLAYER.landTime) this.set('move');
        break;
      case 'launched':
        if (this.stateTime > PLAYER.hitstun && controllable) {
          // Air steering.
          this.vel.x += wish.x * PLAYER.airAccel * dt;
          this.vel.z += wish.z * PLAYER.airAccel * dt;
          const h = Math.hypot(this.vel.x, this.vel.z);
          if (h > PLAYER.airMaxSpeed + 2) {
            this.vel.x *= (PLAYER.airMaxSpeed + 2) / h;
            this.vel.z *= (PLAYER.airMaxSpeed + 2) / h;
          }
        }
        break;
      case 'falling':
      case 'out':
        break;
    }

    if (this.state !== 'out') this.integrate(dt, game);
    this.updatePose(dt);
  }

  private startKick(game: Game): void {
    // Aim assist: snap toward the ram if it's roughly in front and close.
    const ram = game.ram;
    tmp2.subVectors(ram.pos, this.pos).setY(0);
    const d = tmp2.length();
    if (d < PLAYER.kickAssistRange) {
      const toRam = Math.atan2(tmp2.x, tmp2.z);
      const diff = Math.abs(angleDiff(toRam, this.yaw));
      if (diff < Math.PI * 0.6) this.yaw = toRam;
    } else {
      this.yaw = game.cam.yaw;
    }
    this.kickDone = false;
    this.set('kick');
    this.anim.play('kick', 0.05, true);
    game.audio.whoosh();
  }

  private tryKickHit(game: Game): void {
    const ram = game.ram;
    tmp2.subVectors(ram.pos, this.pos).setY(0);
    const d = tmp2.length();
    if (d > PLAYER.kickRange || Math.abs(ram.pos.y - this.pos.y) > 1.2) return;
    const diff = Math.abs(angleDiff(Math.atan2(tmp2.x, tmp2.z), this.yaw));
    if (diff > Math.PI * 0.45) return;
    this.kickDone = true;
    const dir = this.forward; // the ram flies the way you face (aim assist already turned you)
    if (ram.kickable) {
      ram.kicked(dir, game);
    } else if (ram.solid) {
      // Ram doesn't budge — bounce off it.
      this.vel.set(-dir.x * PLAYER.bounceSpeed, 0, -dir.z * PLAYER.bounceSpeed);
      this.set('bounce');
      game.audio.bonk();
      game.fx.shake = Math.max(game.fx.shake, 0.4);
    }
  }

  private groundMove(wish: THREE.Vector3, speed: number, dt: number, accel = PLAYER.groundAccel): void {
    if (!this.grounded) return;
    const tx = wish.x * speed;
    const tz = wish.z * speed;
    const k = Math.min(1, accel * dt / Math.max(0.001, Math.hypot(tx - this.vel.x, tz - this.vel.z)));
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.z += (tz - this.vel.z) * k;
  }

  private turnTo(target: number, rate: number, dt: number): void {
    this.yaw += angleDiff(target, this.yaw) * Math.min(1, rate * dt);
  }

  private integrate(dt: number, game: Game): void {
    const p = this.pos;
    p.x += this.vel.x * dt;
    p.z += this.vel.z * dt;
    const inside = edgeDistance(p.x, p.z) > 0;

    if (this.grounded && !inside) {
      this.grounded = false; // walked / dodged / slid off the edge
      this.vel.y = 0;
      if (this.state === 'move' || this.state === 'flex' || this.state === 'land' || this.state === 'kick' || this.state === 'bounce') {
        this.set('launched');
        this.stateTime = PLAYER.hitstun; // can still steer
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
          if (this.state === 'launched') {
            this.set('land');
            this.anim.play('bounce', 0.08, true);
            game.fx.dust(p.clone(), 6, { speed: 2.5 });
            game.audio.hoof(0.7);
          }
        } else if (p.y < 0) {
          // Below the lip: never re-enter the rock, slide outward.
          const ed = edgeDistance(p.x, p.z);
          if (ed > -0.4) {
            const o = outward(p.x, p.z, tmp2);
            p.addScaledVector(o, ed + 0.4);
          }
          if (p.y < -1.2) game.startFall('player');
        }
      }
    }
    this.root.position.copy(p);
    this.root.rotation.y = this.yaw;
  }

  private updatePose(dt: number): void {
    const a = this.anim;
    switch (this.state) {
      case 'move': {
        const sp = Math.hypot(this.vel.x, this.vel.z);
        if (!this.grounded) a.play('tumble');
        else a.play(sp > 1 ? 'run' : 'idle', 0.15);
        break;
      }
      case 'dodge':
        a.play('dodge', 0.04);
        break;
      case 'kick':
        break; // started in startKick
      case 'bounce':
        a.play('bounce', 0.05);
        break;
      case 'land':
        break;
      case 'launched':
        a.play('tumble', 0.08);
        break;
      case 'flex':
        a.play('flex', 0.2);
        break;
      case 'falling':
        break;
      case 'out':
        break;
    }
    a.update(dt);
  }
}

export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
