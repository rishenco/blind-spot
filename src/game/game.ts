import * as THREE from 'three';
import worldDef, { CLOUD_Y, VALLEY_Y, cliffRadiusAt, edgeRadius, valleyHeight } from '../models/world';
import { SUN_DIR, setupLights } from '../style';
import type { Animator } from './animator';
import { Audio } from './audio';
import { Fx } from './fx';
import { Hud } from './hud';
import { Input } from './input';
import { Player } from './player';
import { ObstacleMap } from './landing';
import { PLAYER_JOINTS, RAM_JOINTS, Ragdoll } from './ragdoll';
import { Ram } from './ram';
import { edgeDistance } from './arena';

export type Phase = 'title' | 'fight' | 'fall' | 'result';

/** Third-person orbit camera driven by the mouse. */
class CameraRig {
  yaw = 0;
  pitch = 0.33;
  dist = 6.5;
  readonly target = new THREE.Vector3();

  follow(dt: number, game: Game, cam: THREE.PerspectiveCamera): void {
    const input = game.input;
    if (!game.paused) {
      this.yaw -= input.mouseDX * 0.0025;
      this.pitch = THREE.MathUtils.clamp(this.pitch + input.mouseDY * 0.0022, -0.15, 1.15);
    }
    const p = game.player.pos;
    const kx = 1 - Math.exp(-14 * dt);
    const ky = 1 - Math.exp(-5 * dt);
    this.target.x += (p.x - this.target.x) * kx;
    this.target.z += (p.z - this.target.z) * kx;
    this.target.y += (Math.max(p.y, -2) * 0.6 + 1.5 - this.target.y) * ky;
    const cp = Math.cos(this.pitch);
    cam.position.set(
      this.target.x - Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z - Math.cos(this.yaw) * cp * this.dist,
    );
    // Over-the-shoulder: shift right so the player doesn't hide a ram charging straight at him.
    const sx = -Math.cos(this.yaw) * 0.8;
    const sz = Math.sin(this.yaw) * 0.8;
    cam.position.x += sx;
    cam.position.z += sz;
    if (cam.position.y < 0.4 && Math.hypot(cam.position.x, cam.position.z) < 11) cam.position.y = 0.4;
    cam.lookAt(this.target.x + Math.sin(this.yaw) * 1.5 + sx, this.target.y, this.target.z + Math.cos(this.yaw) * 1.5 + sz);
  }

  snapBehind(game: Game): void {
    this.target.copy(game.player.pos).add(new THREE.Vector3(0, 1.5, 0));
  }
}

/** Fall cinematic tuning (local to the presentation; gameplay tuning lives in tuning.ts). */
const FALL_CFG = {
  /** Real seconds of slow-mo right after leaving the lip, and its time scale. */
  slowmoTime: 0.6,
  slowmo: 0.3,
  gravity: 40,
  /** Bounce off rock: normal restitution, tangential friction, minimum outward speed after. */
  restitution: 0.5,
  friction: 0.7,
  minOut: 7,
  /** After this many impacts (or this much sim time / depth) the body is sent clear to the valley. */
  maxImpacts: 3,
  upperTime: 2.3,
  launchDepth: -100,
  boomHold: 1.6,
};

type Faller = { root: THREE.Object3D; pos: THREE.Vector3; vel: THREE.Vector3; anim: Animator };

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Physical fall: the faller keeps its momentum off the rim and falls under gravity, colliding with
 * the mountain (cliffRadiusAt). The 'fall' pose is held frozen until the first impact; from then on
 * the body tumbles as a rigid body and the limbs flop (Ragdoll). After a few bounces (or a time /
 * depth limit, or if it gets stuck) it is sent on a ballistic arc that clears the rock all the way
 * down through the clouds to the valley: BOOM.
 */
class FallDirector {
  who: 'player' | 'ram' = 'player';
  t = 0;
  /** Center of mass of the faller (world). */
  readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly angVel = new THREE.Vector3();
  private com = 1;
  private simT = 0;
  private impacts = 0;
  private lastImpact = -1;
  private slowContact = 0;
  private launched = false;
  private gravity = FALL_CFG.gravity;
  /** Landing ground height (valid once launched). */
  private groundY = VALLEY_Y;
  private landX = 0;
  private landZ = 0;
  private hitstop = 0;
  private boomT = -1;
  private ragdoll: Ragdoll | null = null;
  private readonly ragdolls = new Map<THREE.Object3D, Ragdoll>();
  // camera
  private readonly camOff = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private camSide = 1;
  private frozen = false;

  start(who: 'player' | 'ram', f: Faller, cam: THREE.Camera): void {
    this.who = who;
    this.t = 0;
    this.simT = 0;
    this.impacts = 0;
    this.lastImpact = -1;
    this.slowContact = 0;
    this.launched = false;
    this.gravity = FALL_CFG.gravity;
    this.groundY = VALLEY_Y;
    this.hitstop = 0;
    this.boomT = -1;
    this.frozen = false;
    this.com = who === 'player' ? 1.0 : 0.75;

    this.pos.copy(f.pos).setY(f.pos.y + this.com);
    this.quat.copy(f.root.quaternion);
    // Keep the momentum off the rim (capped), but make sure it actually goes outward.
    const out = this.outward(_v);
    this.vel.copy(f.vel);
    this.vel.y = Math.min(this.vel.y, 0);
    const h = Math.hypot(this.vel.x, this.vel.z);
    if (h > 6) {
      this.vel.x *= 6 / h;
      this.vel.z *= 6 / h;
    }
    const vo = this.vel.x * out.x + this.vel.z * out.z;
    if (vo < 1.5) this.vel.addScaledVector(out, 1.5 - vo);
    // A slow topple outward (the pose itself is frozen).
    this.angVel.crossVectors(UP, out).multiplyScalar(0.9);
    this.angVel.y = (Math.random() - 0.5) * 0.6;

    let rd = this.ragdolls.get(f.root);
    if (!rd) {
      rd = new Ragdoll(f.root, who === 'player' ? PLAYER_JOINTS : RAM_JOINTS);
      this.ragdolls.set(f.root, rd);
    }
    rd.stop();
    this.ragdoll = rd;
    ObstacleMap.of(f.root.parent ?? f.root); // build once, during the slow-mo

    void cam;
    // Pick the side that keeps the sun behind the camera (faller lit), looking out from the mountain.
    const sun = new THREE.Vector3(SUN_DIR.x, 0, SUN_DIR.z).normalize();
    this.camSide = this.viewDir(1, _v).dot(sun) < this.viewDir(-1, new THREE.Vector3()).dot(sun) ? 1 : -1;
    // Hard cut to the fall camera (blending from the gameplay camera drags it through the rim crags).
    this.camOff.copy(this.viewDir(this.camSide, _v)).multiplyScalar(-5.4 * (who === 'ram' ? 1.1 : 1)).setY(-2.2);
  }

  get landed(): boolean {
    return this.boomT >= 0;
  }

  private outward(out: THREE.Vector3, p = this.pos): THREE.Vector3 {
    const r = Math.hypot(p.x, p.z) || 1;
    return out.set(p.x / r, 0, p.z / r);
  }

  /** Horizontal camera view direction: mostly outward from the mountain, angled to one side. */
  private viewDir(side: number, out: THREE.Vector3, th = 0.95): THREE.Vector3 {
    // th: angle off the outward direction (~55° while near the rock, less once clear of it)
    const a = Math.atan2(this.pos.z, this.pos.x);
    return out.set(
      Math.cos(a) * Math.cos(th) - Math.sin(a) * side * Math.sin(th),
      0,
      Math.sin(a) * Math.cos(th) + Math.cos(a) * side * Math.sin(th),
    );
  }

  /** Returns true when finished. */
  update(realDt: number, game: Game): boolean {
    this.t += realDt;
    const faller: Faller = this.who === 'player' ? game.player : game.ram;
    const root = faller.root;
    const rd = this.ragdoll!;

    if (this.boomT >= 0) {
      this.boomT += realDt;
      game.hud.setFlash(1 - this.boomT * 3);
      this.aimCamera(game, realDt);
      return this.boomT > FALL_CFG.boomHold;
    }

    let scale = this.t < FALL_CFG.slowmoTime ? FALL_CFG.slowmo : 1;
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      scale = 0;
    }
    const dts = realDt * scale;

    // Pose: hold the 'fall' pose frozen (only let its blend-in finish) until the first impact.
    if (!rd.active) {
      if (faller.anim.time < 0.2) faller.anim.update(realDt);
    } else rd.update(dts, 0.12);

    const n = 4;
    for (let i = 0; i < n && this.boomT < 0; i++) this.step(dts / n, game);

    if (this.boomT < 0) {
      root.quaternion.copy(this.quat);
      root.position.copy(this.pos).sub(_v.set(0, this.com, 0).applyQuaternion(this.quat));
    }
    this.aimCamera(game, realDt);
    return false;
  }

  private step(dt: number, game: Game): void {
    if (dt <= 0) return;
    this.simT += dt;
    this.vel.y -= this.gravity * dt;
    if (!this.launched && this.impacts === 0) {
      const drag = Math.exp(-0.9 * dt);
      this.vel.x *= drag;
      this.vel.z *= drag;
    }
    this.pos.addScaledVector(this.vel, dt);
    const w = this.angVel.length();
    if (w > 1e-4) {
      _q.setFromAxisAngle(_v.copy(this.angVel).divideScalar(w), w * dt);
      this.quat.premultiply(_q).normalize();
    }

    this.collide(dt, game);

    if (!this.launched && (this.simT > FALL_CFG.upperTime + (this.impacts ? 0 : 0.6) || this.pos.y < FALL_CFG.launchDepth || this.slowContact > 0.3)) {
      this.launch(game);
    }

    const ground = this.launched ? this.groundY : valleyHeight(this.pos.x, this.pos.z);
    if (this.pos.y - this.com * 0.5 <= ground) this.boom(game, ground);
  }

  private collide(dt: number, game: Game): void {
    const p = this.pos;
    if (p.y > -0.05) return;
    const a = Math.atan2(p.z, p.x);
    const r = Math.hypot(p.x, p.z);
    const pad = 0.15;
    const R = cliffRadiusAt(a, p.y) + pad;
    // Skimming down the face without really hitting it reads badly: count it like a scrape.
    if (r < R + 2.5 && this.simT > 0.3) this.slowContact += dt * 0.7;
    if (r >= R) return;
    const rh = this.outward(new THREE.Vector3());
    // Grace period at the lip: ease out over the conservative lip radius instead of "hitting" it.
    if (this.simT < 0.3 && !this.launched) {
      p.addScaledVector(rh, (R - r) * Math.min(1, dt * 12));
      return;
    }
    // Surface normal of r = R(angle, y) by finite differences.
    const hy = 1.5;
    const dRdy = (cliffRadiusAt(a, Math.min(-0.01, p.y + hy)) - cliffRadiusAt(a, p.y - hy)) / (Math.min(-0.01, p.y + hy) - (p.y - hy));
    const dRda = (cliffRadiusAt(a + 0.02, p.y) - cliffRadiusAt(a - 0.02, p.y)) / 0.04;
    const th = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
    const nrm = new THREE.Vector3().copy(rh).addScaledVector(UP, -dRdy).addScaledVector(th, -dRda / Math.max(1, r)).normalize();
    p.addScaledVector(rh, R - r);

    const vn = this.vel.dot(nrm);
    if (this.launched) {
      // Safety only: never pass into the rock, no more bounces.
      if (vn < 0) this.vel.addScaledVector(nrm, -vn);
      const vo = this.vel.dot(rh);
      if (vo < 6) this.vel.addScaledVector(rh, 6 - vo);
      return;
    }
    // Scraping along the rock (or stuck on a ledge) for a while: send it off.
    this.slowContact += this.vel.length() < 5 ? dt * 2 : dt;
    if (vn >= 0) return;
    // Bounce: reflect the normal part, scrub the tangential part, and always pop outward.
    const vt = _v.copy(this.vel).addScaledVector(nrm, -vn);
    this.vel.copy(vt).multiplyScalar(FALL_CFG.friction).addScaledVector(nrm, -vn * FALL_CFG.restitution);
    const vo = this.vel.dot(rh);
    // Out faster than the face spreads at this fall speed, so it really leaves the rock.
    const minOut = Math.max(FALL_CFG.minOut + this.impacts * 2, -dRdy * Math.max(0, -this.vel.y) + 9);
    if (vo < minOut) this.vel.addScaledVector(rh, minOut - vo);
    if (-vn > 2.5 && this.simT - this.lastImpact > 0.15) this.impact(game, nrm, -vn);
  }

  private impact(game: Game, nrm: THREE.Vector3, speed: number): void {
    this.impacts++;
    this.lastImpact = this.simT;
    const s = THREE.MathUtils.clamp(speed / 22, 0.25, 1);
    const rd = this.ragdoll!;
    if (!rd.active) rd.begin();
    rd.impulse(s);
    // Tumble: random spin plus a cartwheel away from the wall.
    const rnd = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.angVel.addScaledVector(rnd, 3 + 6 * s).add(_v.crossVectors(nrm, UP).multiplyScalar(-(2 + 4 * s)));
    if (this.angVel.length() > 13) this.angVel.setLength(13);

    game.audio.thud(s);
    if (this.who === 'ram') {
      if (this.impacts === 1 || Math.random() < 0.6) game.audio.bleat(1.5 + Math.random() * 0.6);
    } else {
      game.audio.grunt();
    }
    const contact = this.pos.clone().addScaledVector(nrm, -0.6);
    game.fx.dust(contact, Math.round(10 + 14 * s), { speed: 4 + 6 * s, size: 0.5 + 0.7 * s, up: 2.5, life: 1.1, color: 0xc9b9a0 });
    game.fx.shake = Math.max(game.fx.shake, 0.5 + 0.9 * s);
    this.hitstop = 0.04 + 0.06 * s;
    if (this.impacts >= FALL_CFG.maxImpacts) this.launch(game);
  }

  /**
   * Final drop: a ballistic arc (stronger gravity, so it's snappy) to a landing spot on open valley
   * floor (checked with a raycast: no trees, foothills or scree), chosen so the path clears the rock
   * all the way down through the clouds.
   */
  private launch(game: Game): void {
    if (this.launched) return;
    this.launched = true;
    this.slowContact = 0;
    const p = this.pos;
    const a = Math.atan2(p.z, p.x);
    const vy = Math.min(this.vel.y, 4);
    const map = ObstacleMap.of(game.scene);
    const foot = cliffRadiusAt(a, VALLEY_Y + 1);

    // Ballistic solution to (x, z, groundY); null if the path would hit the rock.
    const solve = (x: number, z: number, groundY: number, strict: boolean) => {
      const h = Math.max(1, p.y - (groundY + this.com * 0.5));
      const T = 0.9 + h / 230; // ~2.1 s from the top
      const g = Math.max(FALL_CFG.gravity, (2 * (h + vy * T)) / (T * T));
      const Tact = (vy + Math.sqrt(vy * vy + 2 * g * h)) / g;
      const vx = (x - p.x) / Tact;
      const vz = (z - p.z) / Tact;
      for (let i = 1; i <= 24; i++) {
        const ti = (Tact * i) / 24;
        const xi = p.x + vx * ti, zi = p.z + vz * ti;
        const yi = p.y + vy * ti - 0.5 * g * ti * ti;
        if (Math.hypot(xi, zi) < cliffRadiusAt(Math.atan2(zi, xi), Math.min(-0.01, yi)) + (i < 3 ? 2 : 14)) return null;
        if (strict && i < 24 && yi < map.height(xi, zi) + 4) return null; // foothills / trees on the way
      }
      return { g, vx, vz, groundY, x, z };
    };

    let sol: ReturnType<typeof solve> = null;
    // Nearest open meadow (no rock, foothill or trees) roughly below, whose arc clears everything;
    // then relax the foothill check; last resort: straight out onto whatever is there.
    search: for (const strict of [true, false]) {
      for (const da of [0, 0.08, -0.08, 0.16, -0.16, 0.25, -0.25, 0.35, -0.35, 0.5, -0.5, 0.65, -0.65, 0.8, -0.8]) {
        for (let k = 0; k < 20; k++) {
          const la = a + da;
          const rr = Math.max(foot, cliffRadiusAt(la, VALLEY_Y + 1)) + 45 + k * 16;
          const x = Math.cos(la) * rr, z = Math.sin(la) * rr;
          if (!map.isMeadow(x, z)) continue;
          sol = solve(x, z, valleyHeight(x, z), strict);
          if (sol) break search;
        }
      }
    }
    for (let rr = foot + 60; !sol && rr < 900; rr += 40) {
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      sol = solve(x, z, map.height(x, z), false);
    }
    if (!sol) {
      const x = Math.cos(a) * 900, z = Math.sin(a) * 900;
      sol = { g: FALL_CFG.gravity * 2, vx: (x - p.x) / 2.5, vz: (z - p.z) / 2.5, groundY: map.height(x, z), x, z };
    }
    this.gravity = sol.g;
    this.groundY = sol.groundY;
    this.landX = sol.x;
    this.landZ = sol.z;
    this.vel.set(sol.vx, vy, sol.vz);
  }

  private boom(game: Game, ground: number): void {
    const faller: Faller = this.who === 'player' ? game.player : game.ram;
    const root = faller.root;
    this.pos.y = ground;
    this.boomT = 0;
    this.ragdoll?.stop();
    // Pancake, flat on the ground, keeping only the heading.
    const e = new THREE.Euler().setFromQuaternion(this.quat, 'YXZ');
    root.rotation.set(0, e.y, 0);
    root.position.set(this.pos.x, ground, this.pos.z);
    root.scale.set(1.5, 0.18, 1.5);
    game.audio.boom();
    game.fx.shake = 2.2;
    game.fx.dust(this.pos.clone().setY(ground + 1), 36, { speed: 26, size: 3.2, up: 6, life: 2.6 });
    game.fx.dust(this.pos.clone().setY(ground + 4), 14, { speed: 6, size: 5, up: 14, life: 3 });
  }

  /** Fixed camera over the landing spot: try a few bearings, keep the first with a clear view. */
  private placeLandingCamera(game: Game, ground: number): void {
    const map = ObstacleMap.of(game.scene);
    const land = new THREE.Vector3(this.landX, ground + 1, this.landZ);
    const base = this.viewDir(this.camSide, new THREE.Vector3()).negate();
    const dist = 26;
    const end = new THREE.Vector3();
    let best = -1;
    search: for (const elev of [1.0, 1.3, 0.7]) {
      for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
        const dir = base.clone().applyAxisAngle(UP, turn).multiplyScalar(Math.cos(elev)).setY(Math.sin(elev)).normalize();
        const free = map.clearDistance(land, end.copy(land).addScaledVector(dir, dist)) - 2;
        if (free > best) {
          best = free;
          this.camPos.copy(land).addScaledVector(dir, Math.max(6, free));
        }
        if (free >= dist - 2) break search;
      }
    }
  }

  private aimCamera(game: Game, dt: number): void {
    const cam = game.camera;
    const landed = this.boomT >= 0;
    const ground = this.launched ? this.groundY : valleyHeight(this.pos.x, this.pos.z);
    if (!this.frozen) {
      // Beside the faller, a bit closer to the mountain, looking OUT past them: the background is sky,
      // the cloud sea and distant peaks, never the rock face. Slightly below while bouncing (sky behind),
      // above on the final drop (the cloud sea rushing up).
      const big = this.who === 'ram' ? 1.1 : 1;
      const below = THREE.MathUtils.smoothstep(CLOUD_Y - 10 - this.pos.y, 0, 40);
      const dist = (this.launched ? 7.5 - 2 * below : 5.4) * big;
      // Below the clouds (no sky left), look steeply down onto the valley floor, not at the foothills.
      const hgt = this.launched ? 2.6 + 16 * below : -3.6;
      const desired = this.viewDir(this.camSide, new THREE.Vector3(), this.launched ? 0.4 : 0.95).multiplyScalar(-dist).setY(hgt);
      this.camOff.lerp(desired, 1 - Math.exp(-4 * dt));
      this.camPos.copy(this.pos).add(this.camOff);
      // Never inside (or tucked behind the crags of) the mountain, and never farther in than the faller,
      // so the line of sight runs outside the rock.
      const ca = Math.atan2(this.camPos.z, this.camPos.x);
      const cr = Math.hypot(this.camPos.x, this.camPos.z);
      if (this.camPos.y < 1 || cr > edgeRadius(ca) - 0.5) {
        const cy = Math.min(-0.01, this.camPos.y);
        let min = cliffRadiusAt(ca, cy) + (cy > -15 ? 3 : 1.5);
        if (!this.launched) min = Math.max(min, Math.hypot(this.pos.x, this.pos.z) + 1.2);
        if (cr < min) {
          const k = this.t < 0.05 ? 1 : Math.min(1, 14 * dt);
          const nr = cr + (min - cr) * k;
          this.camPos.x *= nr / cr;
          this.camPos.z *= nr / cr;
          // hard floor: the rock itself
          const hard = cliffRadiusAt(ca, cy) + 1;
          if (nr < hard) {
            this.camPos.x *= hard / nr;
            this.camPos.z *= hard / nr;
          }
          this.camOff.copy(this.camPos).sub(this.pos);
        }
      }
      // Above the foothills and trees down in the valley.
      if (this.camPos.y < CLOUD_Y) {
        const floor = ObstacleMap.of(game.scene).height(this.camPos.x, this.camPos.z) + 3;
        if (this.camPos.y < floor) {
          this.camPos.y = floor;
          this.camOff.copy(this.camPos).sub(this.pos);
        }
      }
      // Near the valley the camera stops and watches the impact from above, with a clear view.
      if (this.pos.y < ground + 32) {
        this.frozen = true;
        this.placeLandingCamera(game, ground);
      }
    }
    cam.position.copy(this.camPos).add(game.fx.shakeOffset(new THREE.Vector3()));
    // While bouncing, aim a little outward of the faller: more sky, less rock in frame.
    const lead = this.launched || this.frozen ? 0 : 2.5;
    const out = this.outward(new THREE.Vector3());
    cam.lookAt(this.pos.x + out.x * lead, this.pos.y + (landed ? 1.0 : 0.1), this.pos.z + out.z * lead);
    // Whiteout while the camera is inside the cloud layer.
    const inCloud = 1 - THREE.MathUtils.smoothstep(Math.abs(cam.position.y - CLOUD_Y + 4), 6, 18);
    game.hud.setWhiteout(inCloud * 0.9);
  }
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 8000);
  readonly input: Input;
  readonly audio = new Audio();
  readonly fx: Fx;
  readonly hud = new Hud();
  readonly player = new Player();
  readonly ram = new Ram();
  readonly cam = new CameraRig();
  private readonly fall = new FallDirector();
  private readonly world: THREE.Object3D;
  private readonly sun: THREE.DirectionalLight;
  phase: Phase = 'title';
  private phaseTime = 0;
  paused = false;
  private timeScale = 1;
  private slowmoLeft = 0;
  private hitstopLeft = 0;
  private timer = new THREE.Timer();
  private elapsed = 0;
  private titleAngle = 0;
  private fights = 0;
  private readonly sunOffset = new THREE.Vector3();

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    document.body.appendChild(this.renderer.domElement);
    this.input = new Input(this.renderer.domElement);
    this.fx = new Fx(this.scene);

    this.sun = setupLights(this.scene);
    this.sunOffset.copy(this.sun.position).sub(this.sun.target.position);
    this.world = worldDef.build();
    this.scene.add(this.world, this.player.root, this.ram.root);

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.phase !== 'fight') return;
      if (!this.input.locked) this.setPaused(true);
      else if (this.paused) this.setPaused(false);
    });
    this.input.onGesture = () => {
      this.audio.start();
      if (this.phase !== 'fall') {
        void this.input.lock().then((ok) => {
          // Pointer lock refused (or unsupported): don't leave the player stuck on the pause screen.
          if (!ok && this.paused) this.setPaused(false);
        });
      }
    };

    this.resetFight();
    this.hud.showTitle(true);
    // ?test: no realtime loop; scripts drive the game with advance().
    if (!new URLSearchParams(location.search).has('test')) this.renderer.setAnimationLoop(() => this.frame());
  }

  hitstop(t: number): void {
    this.hitstopLeft = Math.max(this.hitstopLeft, t);
  }

  slowmo(scale: number, realDuration: number): void {
    this.timeScale = scale;
    this.slowmoLeft = realDuration;
  }

  startFall(who: 'player' | 'ram'): void {
    if (this.phase !== 'fight') return;
    this.setPhase('fall');
    const f = who === 'player' ? this.player : this.ram;
    this.fall.start(who, f, this.camera);
    f.set('out');
    f.anim.play('fall', 0.15);
    (who === 'player' ? this.ram : this.player).freeze();
    this.audio.scream();
    this.audio.musicOn = false;
    if (who === 'ram') this.audio.bleat(2);
    this.hud.showControls(false);
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseTime = 0;
  }

  private setPaused(on: boolean): void {
    this.paused = on;
    this.hud.showPause(on);
    if (on) this.audio.musicOn = false;
    else if (this.phase === 'fight') this.audio.musicOn = true;
  }

  private resetFight(): void {
    this.player.reset(0, -2.5, 0);
    this.player.root.scale.set(1, 1, 1);
    this.ram.reset(0, 3, Math.PI);
    this.ram.root.scale.set(1, 1, 1);
    this.cam.yaw = 0;
    this.cam.pitch = 0.33;
    this.cam.snapBehind(this);
    this.fx.clear();
    this.timeScale = 1;
    this.slowmoLeft = 0;
    this.hud.setWhiteout(0);
    this.hud.setFlash(0);
    this.audio.bpm = 118;
  }

  private beginFight(): void {
    this.input.take('Mouse0'); // the click that starts the fight isn't a kick
    if (this.phase !== 'title') this.resetFight();
    this.setPhase('fight');
    this.ram.set('intro');
    this.audio.bleat();
    this.audio.musicOn = true;
    this.hud.showTitle(false);
    this.hud.showResult(null);
    this.hud.showControls(this.fights++ < 2);
  }

  /** Test hook: run the simulation for `seconds` at 60 Hz without rendering, then render once. */
  advance(seconds: number, render = true): void {
    for (let i = 0; i < Math.round(seconds * 60); i++) this.frame(1 / 60, false);
    if (render) this.renderer.render(this.scene, this.camera);
  }

  private frame(fixedDt?: number, render = true): void {
    this.timer.update();
    const realDt = fixedDt ?? Math.min(this.timer.getDelta(), 0.05);
    this.elapsed += realDt;
    this.phaseTime += realDt;
    const input = this.input;
    this.audio.update();

    // Clicks drive the flow.
    const click = input.take('AnyClick');
    const key = input.take('AnyKey');
    if (this.phase === 'title' && (click || key)) this.beginFight();
    else if (this.phase === 'result' && (click || key) && this.phaseTime > 0.8) this.beginFight();
    else if (this.phase === 'fight' && this.paused) {
      // Resuming happens on pointerlockchange; swallow everything pressed meanwhile.
      input.endFrame();
    }
    if (this.phase === 'fight' && this.phaseTime > 6) this.hud.showControls(false);

    // Time: hitstop freezes, slow-mo scales.
    let dt = realDt;
    if (this.slowmoLeft > 0) {
      this.slowmoLeft -= realDt;
      if (this.slowmoLeft <= 0) this.timeScale = 1;
    }
    dt *= this.timeScale;
    if (this.hitstopLeft > 0) {
      this.hitstopLeft -= realDt;
      dt = 0;
    }
    if (this.paused) dt = 0;

    worldDef.poses.idle?.(this.world, this.elapsed);

    switch (this.phase) {
      case 'title':
        this.player.update(dt, this);
        this.ram.update(dt, this);
        this.titleCamera(realDt);
        break;
      case 'fight':
        if (!this.paused) {
          this.player.update(dt, this);
          this.ram.update(dt, this);
        }
        if (this.phase === 'fight') {
          this.cam.follow(realDt, this, this.camera);
          if (!this.paused) this.camera.position.add(this.fx.shakeOffset(new THREE.Vector3()));
        }
        break;
      case 'fall': {
        const other = this.fall.who === 'player' ? this.ram : this.player;
        other.update(realDt, this);
        const skip = click && this.phaseTime > 1 && !this.fall.landed;
        if (this.fall.update(realDt, this) || skip) this.showResult();
        break;
      }
      case 'result':
        this.player.update(realDt, this);
        this.ram.update(realDt, this);
        this.resultCamera(realDt);
        break;
    }

    this.fx.update(this.phase === 'fight' ? dt : realDt);
    // Keep the shadow camera on the action (plateau or the fall).
    const focus = this.phase === 'fall' ? this.fall.pos : this.player.pos;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).add(this.sunOffset);
    this.sun.target.updateMatrixWorld();
    this.audio.setWind(this.phase === 'fall' ? 0.5 : 0.08);
    if (render) this.renderer.render(this.scene, this.camera);
    input.endFrame();
  }

  private showResult(): void {
    const ramWon = this.fall.who === 'player';
    this.setPhase('result');
    this.hud.setWhiteout(0);
    this.hud.setFlash(0);
    const faller = ramWon ? this.player : this.ram;
    faller.root.visible = false;
    faller.root.scale.set(1, 1, 1);
    // Make sure the winner stands on the plateau for the victory shot.
    const winner = ramWon ? this.ram : this.player;
    winner.vel.set(0, 0, 0);
    winner.pos.y = 0;
    const ed = edgeDistance(winner.pos.x, winner.pos.z);
    if (ed < 1) {
      const r = Math.hypot(winner.pos.x, winner.pos.z) || 1;
      winner.pos.multiplyScalar(Math.max(0, r - (1 - ed)) / r);
      winner.pos.y = 0;
    }
    winner.root.position.copy(winner.pos);
    if (ramWon) {
      this.ram.set('gloat');
      this.audio.bleat(1.2);
    } else {
      this.player.set('out');
      this.player.anim.play('flex', 0.2);
      this.player.root.position.copy(this.player.pos);
    }
    this.hud.showResult(ramWon ? 'BAAAH!' : 'VICTORY!');
    this.titleAngle = (ramWon ? this.ram.yaw : this.player.yaw) + 0.6;
  }

  private titleCamera(dt: number): void {
    ObstacleMap.of(this.scene); // one-off ~50 ms build for the fall, done while nothing moves
    this.titleAngle += dt * 0.12;
    const r = 15;
    this.camera.position.set(Math.sin(this.titleAngle) * r, 6, Math.cos(this.titleAngle) * r - 1);
    this.camera.lookAt(0, 0.5, 0);
  }

  private resultCamera(dt: number): void {
    const ramWon = this.fall.who === 'player';
    const w = ramWon ? this.ram.pos : this.player.pos;
    this.titleAngle += dt * 0.25;
    const r = 4.8;
    this.camera.position.set(w.x + Math.sin(this.titleAngle) * r, w.y + 1.9, w.z + Math.cos(this.titleAngle) * r);
    this.camera.lookAt(w.x, w.y + (ramWon ? 0.9 : 1.2), w.z);
  }
}
