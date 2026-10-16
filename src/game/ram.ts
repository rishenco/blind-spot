import * as THREE from 'three';
import ramDef from '../models/ram';
import { Animator } from './animator';
import { distanceToEdgeAlong, edgeDistance, outward } from './arena';
import { angleDiff } from './player';
import { GRAVITY, RAM } from './tuning';
import type { Game } from './game';

/**
 * The ram is smart: it knows where the rim is and never goes near it on its own. It circles you,
 * trying to get you between itself and the drop, then charges in a straight line. While charging it
 * is locked on — it plans to stop on you, not before the edge. Leave its line at the last moment and
 * it notices too late to brake. Leave it early and it stops safely and punishes you.
 */
export type RamState =
  | 'intro'
  | 'stalk'
  | 'paw'
  | 'charge'
  | 'brake'
  | 'teeter'
  | 'taunt'
  | 'recover'
  | 'falling'
  | 'out'
  | 'gloat';

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

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
  private stepTimer = 0;
  private windup = 1;
  private grounded = true;
  private orbitSign = 1;
  private stalkFor = 2;
  // current charge
  private feint = false;
  private noFeint = false;
  private traveled = 0;
  private playerDodged = false;
  private noticeTimer = -1;
  private seenEarly = false;
  // current brake
  private brakeKind: 'hit' | 'miss' | 'feint' = 'miss';

  get root(): THREE.Object3D {
    return this.anim.root;
  }

  /** Physically there to bump into. */
  get solid(): boolean {
    return this.state !== 'falling' && this.state !== 'out';
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

  /** Stop in place (used when the player's fall starts). */
  freeze(): void {
    this.vel.set(0, this.grounded ? 0 : this.vel.y, 0);
    if (this.grounded && this.state !== 'out') this.set('recover');
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
        if (fighting && this.stateTime > RAM.introTime) this.startStalk();
        break;
      case 'stalk':
        if (!fighting) {
          this.vel.set(0, 0, 0);
          this.anim.play('idle', 0.2);
          break;
        }
        this.stalk(dt, game, toPlayerYaw);
        break;
      case 'paw':
        this.vel.set(0, 0, 0);
        this.anim.play('paw', 0.1);
        this.turnTo(toPlayerYaw, 5, dt);
        this.stepTimer -= dt;
        if (this.stepTimer <= 0) {
          this.stepTimer = 0.5;
          game.audio.scrape();
          game.fx.dust(this.footPos(0.6), 2, { speed: 0.8, size: 0.2, up: 0.6 });
        }
        if (this.stateTime > this.windup && fighting) this.startCharge(game, toPlayerYaw);
        break;
      case 'charge':
        this.charge(dt, game);
        break;
      case 'brake':
        this.brake(dt, game);
        break;
      case 'teeter':
        this.vel.set(0, 0, 0);
        this.anim.play('teeter', 0.08);
        if (this.stateTime > RAM.teeterTime) {
          game.audio.snort();
          this.set('recover');
        }
        break;
      case 'taunt':
        this.vel.set(0, 0, 0);
        this.anim.play('headbang', 0.15);
        if (this.stateTime > RAM.gloatTime) this.set('recover');
        break;
      case 'recover':
        this.vel.set(0, 0, 0);
        this.anim.play('idle', 0.2);
        this.turnTo(toPlayerYaw, RAM.turnSpeed * 0.6, dt);
        if (this.stateTime > RAM.recoverTime && fighting) this.startStalk();
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

  // ------------------------------------------------------------------ stalking

  private startStalk(): void {
    this.set('stalk');
    this.stalkFor = RAM.stalkTime(this.charges) * (0.8 + Math.random() * 0.5);
    if (Math.random() < 0.5) this.orbitSign *= -1;
  }

  /** Circle the player, working toward the side opposite their nearest rim. */
  private stalk(dt: number, game: Game, toPlayerYaw: number): void {
    const P = game.player.pos;
    // Where the ram wants to stand: on the far side of the player from the nearest edge.
    const out = outward(P.x, P.z, tmp2);
    const cur = Math.atan2(this.pos.z - P.z, this.pos.x - P.x);
    let want = Math.hypot(P.x, P.z) > 0.8 ? Math.atan2(-out.z, -out.x) : cur + this.orbitSign;
    let diff = angleDiff(want, cur);
    // Keep circling even when lined up, so the player has to keep turning.
    const aligned = Math.abs(diff) < 0.35;
    if (aligned) diff = this.orbitSign * 0.6;
    else this.orbitSign = Math.sign(diff) || 1;

    // Step around the circle; shrink the radius or reverse if the spot is too close to the rim.
    const dist = Math.hypot(this.pos.x - P.x, this.pos.z - P.z);
    const step = Math.max(-0.5, Math.min(0.5, diff));
    let tx = 0, tz = 0, ok = false;
    for (const sgn of [1, -1]) {
      for (let r = RAM.stalkDist; r >= 2.4; r -= 0.4) {
        const a = cur + step * sgn;
        tx = P.x + Math.cos(a) * r;
        tz = P.z + Math.sin(a) * r;
        if (edgeDistance(tx, tz) > RAM.safeEdge) {
          ok = true;
          break;
        }
      }
      if (ok) {
        if (sgn < 0) this.orbitSign *= -1;
        break;
      }
    }
    if (!ok) {
      // Cornered against the rim: walk toward the middle.
      tx = this.pos.x * 0.5;
      tz = this.pos.z * 0.5;
    }
    tmp2.set(tx - this.pos.x, 0, tz - this.pos.z);
    const d = tmp2.length();
    const speed = Math.min(RAM.stalkSpeed, d * 3);
    if (d > 0.01) tmp2.multiplyScalar(speed / d);
    this.vel.x += (tmp2.x - this.vel.x) * Math.min(1, 8 * dt);
    this.vel.z += (tmp2.z - this.vel.z) * Math.min(1, 8 * dt);
    this.turnTo(toPlayerYaw, RAM.turnSpeed, dt);
    this.anim.play(Math.hypot(this.vel.x, this.vel.z) > 0.5 ? 'stalk' : 'idle', 0.2);
    this.footsteps(dt, game, 0.33, 0.25);

    const inRange = dist > 2.6 && dist < 8.5;
    if (inRange && ((aligned && this.stateTime > this.stalkFor) || this.stateTime > RAM.stalkMaxTime)) {
      this.startPaw(game, RAM.windup(this.charges));
    }
  }

  private startPaw(game: Game, windup: number): void {
    this.set('paw');
    this.windup = windup;
    this.stepTimer = 0;
    game.audio.snort();
  }

  // ------------------------------------------------------------------ charging

  private startCharge(game: Game, toPlayerYaw: number): void {
    this.dir.set(Math.sin(toPlayerYaw), 0, Math.cos(toPlayerYaw));
    this.yaw = toPlayerYaw;
    this.feint = !this.noFeint && Math.random() < RAM.feintChance(this.charges);
    this.noFeint = false;
    this.traveled = 0;
    this.playerDodged = false;
    this.noticeTimer = -1;
    this.seenEarly = false;
    this.set('charge');
    game.audio.chargeStart();
    game.audio.bpm = 118 + Math.min(40, this.charges * 4);
  }

  private charge(dt: number, game: Game): void {
    const player = game.player;
    this.anim.play('charge', 0.08);
    const speed = Math.min(RAM.chargeSpeed(this.charges), Math.hypot(this.vel.x, this.vel.z) + RAM.chargeAccel * dt);
    this.vel.set(this.dir.x * speed, 0, this.dir.z * speed);
    this.traveled += speed * dt;
    this.footsteps(dt, game, 0.17, 0.6);
    if (player.state === 'dodge') this.playerDodged = true;

    const along = tmp.dot(this.dir);
    const lat = Math.abs(tmp.x * this.dir.z - tmp.z * this.dir.x);
    const playerLow = player.pos.y < 1.4;
    if (!player.invulnerable && playerLow && along > -0.3 && along < RAM.hitReachAhead && lat < RAM.hitWidth) {
      tmp2.copy(this.dir).multiplyScalar(0.85).addScaledVector(lateralSign(this.dir, player.pos, this.pos), 0.3).normalize();
      player.hit(tmp2, game);
      this.charges++;
      this.startBrake('hit');
      return;
    }
    // Feint: stop short on purpose, to bait an early dodge.
    if (this.feint && this.noticeTimer < 0 && this.traveled > RAM.feintDistance && along > 2.6) {
      this.charges++;
      this.startBrake('feint');
      game.audio.skid();
      return;
    }
    // Out of the line? It notices after its reaction time, then brakes as hard as it can.
    const lost = lat > RAM.missLateral || along < -0.6 || player.state === 'falling' || player.state === 'out' || player.state === 'launched';
    if (lost && this.noticeTimer < 0) {
      this.noticeTimer = RAM.reaction;
      this.seenEarly = along > RAM.earlySeen;
    }
    if (this.noticeTimer >= 0) {
      this.noticeTimer -= dt;
      if (this.noticeTimer <= 0) {
        // A close call on a dodge: slow the world down for a beat.
        if (!this.seenEarly && player.state === 'dodge' && along > -2.5) game.slowmo(0.35, 0.3);
        this.charges++;
        this.startBrake('miss');
        game.audio.skid();
        game.audio.bleat(1.5);
      }
    }
    if (this.stateTime > 2.5) {
      this.charges++;
      this.startBrake('miss');
    }
  }

  private startBrake(kind: 'hit' | 'miss' | 'feint'): void {
    this.brakeKind = kind;
    this.set('brake');
  }

  private brake(dt: number, game: Game): void {
    this.anim.play('skid', 0.06);
    const v = Math.hypot(this.vel.x, this.vel.z);
    let decel = this.brakeKind === 'feint' ? RAM.feintDecel : RAM.brakeDecel;
    if (this.brakeKind !== 'miss' || this.seenEarly) {
      // It planned this stop (or saw you leave in time): brakes as hard as it needs to stay on the plateau.
      const room = distanceToEdgeAlong(this.pos.x, this.pos.z, this.dir.x, this.dir.z) - RAM.safeEdge * 0.6;
      decel = room > 0.05 ? Math.max(decel, (v * v) / (2 * room)) : 200;
    }
    const nv = Math.max(0, v - decel * dt);
    this.vel.set(this.dir.x * nv, 0, this.dir.z * nv);
    if (Math.random() < dt * 25) game.fx.dust(this.footPos(0.4), 1, { speed: 1.5, size: 0.3 });
    if (nv > 0.2 || !this.grounded) return;

    this.vel.set(0, 0, 0);
    const player = game.player;
    if (edgeDistance(this.pos.x, this.pos.z) < RAM.teeterZone) {
      this.set('teeter');
      game.audio.bleat(1.7);
    } else if (this.brakeKind === 'feint') {
      // Took the bait? Immediate real charge. Didn't? A short paw, then the real one.
      this.noFeint = true;
      this.startPaw(game, this.playerDodged ? RAM.punishWindup : RAM.pawAfterFeint);
    } else if (this.brakeKind === 'miss' && this.seenEarly && player.state !== 'falling' && player.state !== 'out') {
      // Saw you dodge from far off: it just turns and goes again.
      this.noFeint = true;
      this.startPaw(game, RAM.punishWindup);
    } else if (this.brakeKind === 'hit') {
      this.set('taunt');
      game.audio.bleat(1.1);
    } else {
      this.set('recover');
      game.audio.snort();
    }
  }

  // ------------------------------------------------------------------ physics

  private integrate(dt: number, game: Game): void {
    const p = this.pos;
    p.x += this.vel.x * dt;
    p.z += this.vel.z * dt;
    const inside = edgeDistance(p.x, p.z) > -0.15;
    if (this.grounded && !inside) {
      this.grounded = false;
      this.vel.y = 0;
      this.set('falling');
      this.anim.play('fall', 0.15);
      game.audio.bleat(1.9);
    }
    if (!this.grounded) {
      this.vel.y -= GRAVITY * dt;
      p.y += this.vel.y * dt;
      if (p.y < -1.0 && this.vel.y < 0) game.startFall('ram');
    }
    // Simple push-apart with the player when both are on the ground.
    const pl = game.player;
    if (this.solid && this.state !== 'charge' && pl.grounded && this.grounded && pl.state !== 'dodge') {
      tmp2.subVectors(pl.pos, p).setY(0);
      const d = tmp2.length();
      const min = 1.15;
      if (d < min && d > 0.001) pl.pos.addScaledVector(tmp2, (min - d) / d);
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
