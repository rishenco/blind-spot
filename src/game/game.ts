import * as THREE from 'three';
import worldDef, { CLOUD_Y, cliffRadius, valleyHeight } from '../models/world';
import { setupLights } from '../style';
import { Audio } from './audio';
import { Fx } from './fx';
import { Hud } from './hud';
import { Input } from './input';
import { Player } from './player';
import { Ram } from './ram';
import { FALL } from './tuning';
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
    if (input.locked) {
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

/** Scripted fall: slow-mo at the lip, follow the faller down through the clouds, BOOM. */
class FallDirector {
  who: 'player' | 'ram' = 'player';
  t = 0;
  private angle = 0;
  private r = 0;
  private y = 0;
  private vy = 0;
  private boomT = -1;
  readonly pos = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly camStart = new THREE.Vector3();
  private frozen = false;
  private readonly out = new THREE.Vector3();

  start(who: 'player' | 'ram', from: THREE.Vector3, vy: number, cam: THREE.Camera): void {
    this.who = who;
    this.t = 0;
    this.angle = Math.atan2(from.z, from.x);
    this.r = Math.hypot(from.x, from.z);
    this.y = from.y;
    this.vy = Math.min(vy, 0);
    this.boomT = -1;
    this.camPos.copy(cam.position);
    this.camStart.copy(cam.position);
    this.frozen = false;
    this.out.set(Math.cos(this.angle), 0, Math.sin(this.angle));
  }

  get landed(): boolean {
    return this.boomT >= 0;
  }

  /** Returns true when finished. */
  update(realDt: number, game: Game): boolean {
    this.t += realDt;
    const faller = this.who === 'player' ? game.player : game.ram;
    const root = faller.root;

    if (this.boomT >= 0) {
      this.boomT += realDt;
      game.hud.setFlash(1 - this.boomT * 3);
      this.aimCamera(game, realDt, true);
      return this.boomT > FALL.boomHold;
    }

    const dts = realDt * (this.t < FALL.slowmoTime ? FALL.slowmo : 1);
    this.vy -= FALL.gravity * dts;
    this.y += this.vy * dts;
    const rMin = cliffRadius(this.y, this.angle) + 3;
    this.r += Math.max(0, rMin - this.r) * Math.min(1, dts * 5) + 2 * dts;
    this.pos.set(Math.cos(this.angle) * this.r, this.y, Math.sin(this.angle) * this.r);
    root.position.copy(this.pos);
    root.rotation.y += dts * 1.5;

    const ground = valleyHeight(this.pos.x, this.pos.z);
    if (this.y <= ground) {
      this.pos.y = ground;
      root.position.copy(this.pos);
      root.scale.set(1.5, 0.18, 1.5); // pancake
      root.rotation.set(0, root.rotation.y, 0);
      this.boomT = 0;
      game.audio.boom();
      game.fx.shake = 2.2;
      game.fx.dust(this.pos.clone().setY(ground + 1), 36, { speed: 26, size: 3.2, up: 6, life: 2.6 });
      game.fx.dust(this.pos.clone().setY(ground + 4), 14, { speed: 6, size: 5, up: 14, life: 3 });
    }
    this.aimCamera(game, realDt, false);
    return false;
  }

  private aimCamera(game: Game, dt: number, landed: boolean): void {
    const cam = game.camera;
    const ground = valleyHeight(this.pos.x, this.pos.z);
    // Close follow: just outside, beside and above the faller so they stay big in frame and the
    // cliff rushes past behind them. Near the ground the camera stops and watches the impact below.
    if (!this.frozen) {
      const side = new THREE.Vector3(-this.out.z, 0, this.out.x);
      const follow = new THREE.Vector3()
        .copy(this.pos)
        .addScaledVector(this.out, 6.5)
        .addScaledVector(side, 2.5)
        .add(new THREE.Vector3(0, 2.2, 0));
      // Ease in from the gameplay camera during the slow-mo.
      const b = THREE.MathUtils.smoothstep(this.t, 0, FALL.slowmoTime + 0.4);
      this.camPos.lerpVectors(this.camStart, follow, b);
      if (this.y < ground + 40) {
        this.frozen = true;
        this.camPos.y += 6;
      }
    }
    cam.position.copy(this.camPos).add(game.fx.shakeOffset(new THREE.Vector3()));
    cam.lookAt(this.pos.x, this.pos.y + (landed ? 1.5 : 0.5), this.pos.z);
    // Whiteout while the camera is inside the cloud layer.
    const inCloud = 1 - THREE.MathUtils.smoothstep(Math.abs(cam.position.y - CLOUD_Y + 4), 6, 18);
    game.hud.setWhiteout(inCloud * 0.9);
    void dt;
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
  private paused = false;
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
    this.fall.start(who, f.pos, f.vel.y, this.camera);
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
    this.player.reset(0, -5, 0);
    this.player.root.scale.set(1, 1, 1);
    this.ram.reset(0, 4, Math.PI);
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
        if (this.fall.who === 'player') {
          if (input.take('KeyF') || input.take('Space')) this.player.anim.play(this.player.anim.pose === 'flex' ? 'fall' : 'flex', 0.1);
        }
        const other = this.fall.who === 'player' ? this.ram : this.player;
        other.update(realDt, this);
        const faller = this.fall.who === 'player' ? this.player : this.ram;
        faller.anim.update(this.fall.landed ? 0 : realDt);
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
