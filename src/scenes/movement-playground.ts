/**
 * Lab scene 01 — lit graybox movement playground.
 *
 * Deliberately *not* the game's look: this is a well-lit reference room whose only job is to
 * make the movement read honestly (speed, height, step-ups, collision). The dark sound-painted
 * renderer arrives in a later batch; the geometry and collision built here are what it will
 * eventually paint.
 */

import * as THREE from 'three';
import { registerScene, type LabScene, type SceneCtx } from '../lab/registry';
import { StaticWorld, aabbFromBounds, type Aabb } from '../core/collision';
import {
  PlayerController,
  defaultBobTunables,
  defaultCameraTunables,
  defaultMantleTunables,
  defaultMovementTunables,
} from '../player/controller';
import type { Input } from '../core/input';

const SCENE_ID = 'movement-playground';

// Room shell (vision §11: floors are ~45 x 30 m, 6-8 m tall).
const FLOOR_X = 45;
const FLOOR_Z = 30;
const WALL_H = 7;
const WALL_T = 0.5;
const HALF_X = FLOOR_X / 2;
const HALF_Z = FLOOR_Z / 2;

const SPAWN = new THREE.Vector3(-20, 0, 0);
/** 0 faces -Z; -90 faces +X, which is down the room toward the stairs. */
const SPAWN_YAW_DEG = -90;

// Albedo values, not screen colours: MeshStandardMaterial multiplies `color` by `map`, and
// the ACES curve pulls the low end down hard, so the greys live much higher than they look.
const COLORS = {
  background: 0x121820,
  floor: 0xc9d1d8,
  wall: 0xd7dee4,
  crate: 0x9aa3ab,
  prop: 0x8b949c,
  accent: 0x1c5460,
  accentBright: 0x49b0c0,
};

const VARIANTS = ['Full Playground', 'Bare Room', 'Speed Lane', 'Mantle Lane'];

/** Builds a tiling grid/checker texture procedurally — no asset files anywhere. */
function makeGridTexture(
  pixels: number,
  base: string,
  checker: string,
  line: string,
  cells: number,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = pixels;
  canvas.height = pixels;
  const g = canvas.getContext('2d');
  if (g === null) throw new Error('2D canvas context unavailable');
  const cell = pixels / cells;

  g.fillStyle = base;
  g.fillRect(0, 0, pixels, pixels);
  g.fillStyle = checker;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if ((x + y) % 2 === 0) g.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  g.strokeStyle = line;
  g.lineWidth = Math.max(1, pixels / 256);
  for (let i = 0; i <= cells; i++) {
    const p = Math.min(pixels - g.lineWidth / 2, i * cell);
    g.beginPath();
    g.moveTo(p, 0);
    g.lineTo(p, pixels);
    g.moveTo(0, p);
    g.lineTo(pixels, p);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Collects meshes and their matching collision boxes in lockstep. */
class Builder {
  constructor(
    readonly group: THREE.Group,
    readonly world: StaticWorld,
  ) {}

  /** Box given by its XZ centre, its base Y and its full size. */
  box(
    cx: number,
    baseY: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    material: THREE.Material,
    options: { collide?: boolean; textureScale?: number } = {},
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(sx, sy, sz);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx, baseY + sy / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    if (options.collide !== false) {
      this.world.add(
        aabbFromBounds(cx - sx / 2, baseY, cz - sz / 2, cx + sx / 2, baseY + sy, cz + sz / 2),
      );
    }
    return mesh;
  }

  /** Collision-only box (used where the visual is a different shape, e.g. the ramp). */
  collider(box: Aabb): void {
    this.world.add(box);
  }

  add(object: THREE.Object3D): void {
    this.group.add(object);
  }
}

export class MovementPlayground implements LabScene {
  readonly id = SCENE_ID;
  readonly title = 'Movement Playground';
  readonly variants = VARIANTS;

  private ctx!: SceneCtx;
  private input!: Input;
  private readonly world = new StaticWorld();
  private readonly movement = defaultMovementTunables();
  private readonly cameraTunables = defaultCameraTunables();
  private readonly bobTunables = defaultBobTunables();
  private readonly mantleTunables = defaultMantleTunables();
  private player!: PlayerController;

  private content = new THREE.Group();
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private variantIndex = 0;
  private hudTimer = 0;

  init(ctx: SceneCtx): void {
    this.ctx = ctx;
    this.input = ctx.input;

    ctx.scene.background = new THREE.Color(COLORS.background);
    ctx.scene.fog = new THREE.Fog(COLORS.background, 25, 95);

    this.addLights();

    this.player = new PlayerController(
      this.world,
      this.movement,
      this.cameraTunables,
      this.bobTunables,
      this.mantleTunables,
    );
    this.player.setSpawn(SPAWN, SPAWN_YAW_DEG);

    ctx.scene.add(this.content);
    this.build(0);
    this.buildGui();
  }

  private addLights(): void {
    const hemi = new THREE.HemisphereLight(0x9db4c4, 0x1a1e22, 1.5);
    this.ctx.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(14, 26, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const cam = key.shadow.camera;
    cam.left = -30;
    cam.right = 30;
    cam.top = 26;
    cam.bottom = -26;
    cam.near = 1;
    cam.far = 90;
    key.shadow.bias = -0.0005;
    // Generous normal bias: the shadow map covers the whole 45x30 room, so texels are ~6 cm
    // and thin acne shows up on every stair tread without it.
    key.shadow.normalBias = 0.08;
    this.ctx.scene.add(key);
    this.ctx.scene.add(key.target);

    // Keeps surfaces facing away from the key readable instead of crushed to black.
    const fill = new THREE.DirectionalLight(0x8fa6bb, 0.8);
    fill.position.set(-16, 12, -14);
    this.ctx.scene.add(fill);
  }

  private makeMaterial(color: number, map: THREE.Texture | null, roughness = 0.95): THREE.Material {
    const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
    if (map !== null) mat.map = map;
    this.materials.push(mat);
    return mat;
  }

  private track(tex: THREE.Texture): THREE.Texture {
    this.textures.push(tex);
    return tex;
  }

  // ---- world construction --------------------------------------------------

  private build(variantIndex: number): void {
    this.clearContent();
    this.variantIndex = variantIndex;

    const floorTex = this.track(makeGridTexture(512, '#8a929a', '#7e868e', '#aab6bf', 4));
    floorTex.repeat.set(FLOOR_X / 4, FLOOR_Z / 4);
    const wallTex = this.track(makeGridTexture(256, '#8f979e', '#878f96', '#9fa9b1', 2));
    wallTex.repeat.set(FLOOR_X / 4, WALL_H / 4);

    const floorMat = this.makeMaterial(COLORS.floor, floorTex);
    const wallMat = this.makeMaterial(COLORS.wall, wallTex, 0.98);
    const crateMat = this.makeMaterial(COLORS.crate, null, 0.85);
    const propMat = this.makeMaterial(COLORS.prop, null, 0.9);
    const accentMat = this.makeMaterial(COLORS.accent, null, 0.8);
    const accentTopMat = this.makeMaterial(COLORS.accentBright, null, 0.7);

    const b = new Builder(this.content, this.world);

    // Shell: floor slab and four walls. Falling out of the room is impossible.
    b.box(0, -1, 0, FLOOR_X, 1, FLOOR_Z, floorMat);
    b.box(-HALF_X - WALL_T / 2, 0, 0, WALL_T, WALL_H, FLOOR_Z + WALL_T * 2, wallMat);
    b.box(HALF_X + WALL_T / 2, 0, 0, WALL_T, WALL_H, FLOOR_Z + WALL_T * 2, wallMat);
    b.box(0, 0, -HALF_Z - WALL_T / 2, FLOOR_X + WALL_T * 2, WALL_H, WALL_T, wallMat);
    b.box(0, 0, HALF_Z + WALL_T / 2, FLOOR_X + WALL_T * 2, WALL_H, WALL_T, wallMat);

    // Spawn plate: a visual-only marker so screenshots and playtests share a reference point.
    const plate = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.75, 32),
      new THREE.MeshBasicMaterial({ color: COLORS.accentBright, transparent: true, opacity: 0.5 }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(SPAWN.x, 0.02, SPAWN.z);
    this.materials.push(plate.material as THREE.Material);
    b.add(plate);

    if (this.variantIndex === 0) {
      this.buildFullPlayground(b, { crateMat, propMat, accentMat, accentTopMat });
    } else if (this.variantIndex === 2) {
      this.buildSpeedLane(b, { propMat, accentTopMat });
    } else if (this.variantIndex === 3) {
      this.buildMantleLane(b, { crateMat, accentTopMat });
    }

    this.player.respawn();
  }

  private buildFullPlayground(
    b: Builder,
    mats: {
      crateMat: THREE.Material;
      propMat: THREE.Material;
      accentMat: THREE.Material;
      accentTopMat: THREE.Material;
    },
  ): void {
    const { crateMat, propMat, accentMat, accentTopMat } = mats;

    // --- the accent block: platform + stairs + ramp (vision §11, one palette accent).
    const PLATFORM_TOP = 3;
    b.box(-1, 0, 0, 10, PLATFORM_TOP, 10, accentMat); // x -6..4, z -5..5
    // Edge trim only, never a full bright deck: a lit line reads as "this is the lip you can
    // stand on / drop from" and keeps the accent to a single stripe instead of a cyan carpet.
    // Visual only — a 4 cm lip would otherwise be a pointless collision edge.
    const TRIM_W = 0.2;
    const trims: [number, number, number, number][] = [
      [-1, -5 + TRIM_W / 2, 10, TRIM_W],
      [-1, 5 - TRIM_W / 2, 10, TRIM_W],
      [-6 + TRIM_W / 2, 0, TRIM_W, 10],
      [4 - TRIM_W / 2, 0, TRIM_W, 10],
    ];
    for (const [cx, cz, sx, sz] of trims) {
      const trim = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.04, sz), accentTopMat);
      trim.position.set(cx, PLATFORM_TOP, cz);
      trim.receiveShadow = true;
      b.add(trim);
    }

    // Stair flight, 12 x 0.25 m risers, straight ahead of the spawn. Deliberately wide
    // (z -8..8): the step-up has to hold up when the flight is taken diagonally, and a 60 deg
    // approach drifts ~11 m sideways over the 6 m run — a narrower bank would send the test
    // off the side of the stairs instead of measuring the step-up.
    const RISER = 0.25;
    const TREAD = 0.5;
    const STAIR_W = 16;
    for (let i = 0; i < 12; i++) {
      const top = RISER * (i + 1);
      const cx = -12 + TREAD * i + TREAD / 2;
      b.box(cx, 0, 0, TREAD, top, STAIR_W, accentMat);
    }

    // Ramp: a real wedge visual over a finely stair-stepped collider (0.1 m steps, well
    // under the 0.3 m step tolerance, so it walks like a smooth slope).
    this.buildRamp(b, accentMat, {
      xMin: -4,
      width: 4,
      zBottom: 13,
      run: 8,
      rise: PLATFORM_TOP,
      steps: 30,
    });

    // --- crates. Heights 0.5 / 1.0 / 1.5 / 2.2 m: future mantle targets, obstacles today.
    b.box(-20, 0, 6, 2, 2.2, 2, crateMat);
    b.box(-17.5, 0, 8.5, 1.6, 1.5, 1.6, crateMat);
    b.box(-20.5, 0, 10.5, 1.4, 1.0, 1.4, crateMat);
    b.box(-17, 0, 11.5, 1.2, 0.5, 1.2, crateMat);
    // A rising stack on the other flank — a mantle staircase for a later batch.
    b.box(-18, 0, -6, 1.2, 0.5, 1.2, crateMat);
    b.box(-16, 0, -7.5, 1.4, 1.0, 1.4, crateMat);
    b.box(-13.5, 0, -9, 1.6, 1.5, 1.6, crateMat);
    b.box(-10.5, 0, -11, 2.0, 2.2, 2.0, crateMat);

    // --- pillars, 1 x 1 x 7 m.
    for (const [x, z] of [
      [9, 11],
      [15, 0],
      [20.5, 6],
      [20.5, -3],
      [5, 12.5],
    ] as const) {
      b.box(x, 0, z, 1, WALL_H, 1, propMat);
    }

    // --- chokepoint: a 1.2 m gap between two blocks.
    b.box(10, 0, -5.9, 8, 2.5, 3, propMat); // z -7.4..-4.4
    b.box(10, 0, -10.1, 8, 2.5, 3, propMat); // z -11.6..-8.6

    // --- vault bars: 1 m tall, 0.6 m deep.
    b.box(8, 0, 6, 3, 1, 0.6, propMat);
    b.box(13, 0, 10, 3, 1, 0.6, propMat);
    b.box(13, 0, -2, 0.6, 1, 3, propMat);

    // --- low overhang: 1.35 m of clearance, passable crouched only.
    const OVERHANG_BOTTOM = 1.35;
    b.box(18, 0, -12.8, 4, 1.75, 0.4, propMat);
    b.box(18, 0, -10.2, 4, 1.75, 0.4, propMat);
    b.box(18, OVERHANG_BOTTOM, -11.5, 4, 0.4, 3, accentTopMat);
  }

  private buildRamp(
    b: Builder,
    material: THREE.Material,
    spec: { xMin: number; width: number; zBottom: number; run: number; rise: number; steps: number },
  ): void {
    const { xMin, width, zBottom, run, rise, steps } = spec;

    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(run, 0);
    shape.lineTo(run, rise);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
    const mesh = new THREE.Mesh(geometry, material);
    // Extrusion runs along +Z in shape space; rotate so the run climbs toward -Z.
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(xMin, 0, zBottom);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    b.add(mesh);

    const stepRun = run / steps;
    for (let i = 0; i < steps; i++) {
      const top = (rise * (i + 1)) / steps;
      const zFar = zBottom - stepRun * (i + 1);
      const zNear = zBottom - stepRun * i;
      b.collider(aabbFromBounds(xMin, 0, zFar, xMin + width, top, zNear));
    }
  }

  private buildSpeedLane(
    b: Builder,
    mats: { propMat: THREE.Material; accentTopMat: THREE.Material },
  ): void {
    // A clean straight for reading acceleration and top speed, marked every 5 m.
    for (let x = -20; x <= 20; x += 5) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.02, 8),
        mats.accentTopMat,
      );
      stripe.position.set(x, 0.01, 0);
      stripe.receiveShadow = true;
      b.add(stripe);
    }
    b.box(0, 0, -4.3, 44, 0.6, 0.6, mats.propMat);
    b.box(0, 0, 4.3, 44, 0.6, 0.6, mats.propMat);
    // Hurdles at 0.5 m: jumpable at the default 5.4 m/s jump velocity (0.91 m apex), and
    // deliberately just under the mantle's 0.5 m floor so they stay a jump, not a climb.
    for (const x of [-6, 2, 10]) b.box(x, 0, 0, 0.5, 0.5, 7, mats.propMat);
  }

  /**
   * Two clear approach lanes off the spawn, one per climb class, so a mantle can be tested
   * (and felt) without threading between the full playground's props.
   *
   *  - +X (the spawn heading): a 1.0 m ledge 8 m out — a sprint-through vault.
   *  - -Z (a 90 deg turn):     a 2.2 m block 6 m out — the tallest legal pull-up.
   */
  private buildMantleLane(
    b: Builder,
    mats: { crateMat: THREE.Material; accentTopMat: THREE.Material },
  ): void {
    const { crateMat, accentTopMat } = mats;

    // --- vault lane, straight ahead of the spawn. Wide and deep enough that the landing
    // scan always finds room on top no matter how the approach drifts, and that the deck is a
    // real runway (6 m ~ 1 s at a sprint) rather than a lip you are off again before you can
    // feel — vaulting is supposed to end in speed, not in a second drop.
    b.box(-10.25, 0, 0, 6, 1.0, 8, crateMat);
    // A second, taller ledge further down the same lane: a pull-up at the end of a sprint.
    b.box(-4, 0, 0, 2.5, 1.6, 8, crateMat);

    // --- pull-up lane, 90 deg to the left of the spawn heading. Exactly maxHeight tall.
    b.box(-20, 0, -6, 5, 2.2, 3, crateMat);

    // Lane markers (visual only) so the screenshots read as "these are the two lanes".
    for (const [x, z, sx, sz] of [
      [-16, 0, 0.12, 6],
      [-20, -2.5, 6, 0.12],
    ] as const) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.02, sz), accentTopMat);
      stripe.position.set(x, 0.01, z);
      stripe.receiveShadow = true;
      b.add(stripe);
    }
  }

  private clearContent(): void {
    // Variant switches happen many times per session, so release GPU resources eagerly
    // instead of leaving it to the harness's scene teardown.
    this.content.traverse((obj) => {
      const mesh = obj as Partial<THREE.Mesh>;
      mesh.geometry?.dispose();
    });
    this.content.clear();
    for (const mat of this.materials) mat.dispose();
    for (const tex of this.textures) tex.dispose();
    this.materials = [];
    this.textures = [];
    this.world.clear();
  }

  // ---- gui -----------------------------------------------------------------

  private buildGui(): void {
    const gui = this.ctx.gui;
    const m = gui.addFolder('Movement');
    m.add(this.movement, 'crouchSpeed', 0.5, 6, 0.1);
    m.add(this.movement, 'walkSpeed', 1, 10, 0.1);
    m.add(this.movement, 'sprintSpeed', 1, 14, 0.1);
    m.add(this.movement, 'groundAccel', 5, 120, 1);
    m.add(this.movement, 'groundFriction', 1, 120, 1);
    m.add(this.movement, 'airAccel', 0, 60, 1);
    m.add(this.movement, 'jumpVelocity', 1, 12, 0.1);
    m.add(this.movement, 'gravity', 5, 40, 0.5);
    m.add(this.movement, 'coyoteTime', 0, 0.4, 0.01);
    m.add(this.movement, 'jumpBuffer', 0, 0.4, 0.01);
    m.add(this.movement, 'radius', 0.15, 0.8, 0.01);
    m.add(this.movement, 'standHeight', 1.0, 2.4, 0.01);
    m.add(this.movement, 'crouchHeight', 0.6, 2.0, 0.01);
    m.add(this.movement, 'eyeStand', 0.8, 2.3, 0.01);
    m.add(this.movement, 'eyeCrouch', 0.5, 1.8, 0.01);
    m.add(this.movement, 'stepHeight', 0, 0.8, 0.01);
    m.add(this.movement, 'eyeSmoothRate', 1, 30, 0.5).name('eyeSmooth (1/s)');
    m.add(this.movement, 'stepSmoothRate', 1, 40, 0.5).name('stepSmooth (1/s)');
    m.add(this.movement, 'sprintMinForward', 0, 1, 0.05);

    const j = gui.addFolder('Jump feel');
    j.add(this.movement, 'fallGravityMult', 1, 3, 0.05);
    j.add(this.movement, 'jumpCutFactor', 0, 1, 0.05);
    j.add(this.movement, 'landDipMax', 0, 0.4, 0.005);
    j.add(this.movement, 'landDipRecovery', 1, 20, 0.5).name('landDipRec (1/s)');

    const v = gui.addFolder('View bob');
    v.add(this.bobTunables, 'enabled');
    v.add(this.bobTunables, 'vertAmp', 0, 0.15, 0.001);
    v.add(this.bobTunables, 'latAmp', 0, 0.15, 0.001);
    v.add(this.bobTunables, 'rollDeg', 0, 3, 0.05);
    v.add(this.bobTunables, 'strideFreq', 0.5, 4, 0.05).name('strideFreq (Hz @ sprint)');
    v.add(this.bobTunables, 'crouchScale', 0, 1, 0.05);
    v.add(this.bobTunables, 'blendRate', 1, 20, 0.5).name('blend (1/s)');

    const mt = gui.addFolder('Mantle');
    mt.add(this.mantleTunables, 'enabled');
    mt.add(this.mantleTunables, 'reach', 0.2, 1.5, 0.05);
    mt.add(this.mantleTunables, 'minHeight', 0.1, 1.5, 0.05);
    mt.add(this.mantleTunables, 'maxHeight', 0.5, 3.5, 0.05);
    mt.add(this.mantleTunables, 'lowVaultMaxHeight', 0.3, 2.5, 0.05);
    mt.add(this.mantleTunables, 'vaultTime', 0.05, 1, 0.01);
    mt.add(this.mantleTunables, 'pullupTime', 0.1, 1.5, 0.01);

    const c = gui.addFolder('Camera');
    c.add(this.cameraTunables, 'fov', 60, 120, 1);
    c.add(this.cameraTunables, 'sprintFovBonus', 0, 25, 0.5);
    c.add(this.cameraTunables, 'fovSmoothRate', 0.5, 20, 0.5).name('fovSmooth (1/s)');
    c.add(this.cameraTunables, 'sensitivity', 0.01, 0.6, 0.005).name('sens (deg/px)');
    c.add(this.cameraTunables, 'pitchClampDeg', 45, 89.9, 0.1);
    c.add(this.cameraTunables, 'invertY');

    const s = gui.addFolder('Scene');
    s.add({ respawn: () => this.player.respawn() }, 'respawn').name('Respawn (R)');
    s.add(
      {
        variant: () => this.setVariant((this.variantIndex + 1) % VARIANTS.length),
      },
      'variant',
    ).name('Next variant (1-4)');
  }

  // ---- lifecycle -----------------------------------------------------------

  setVariant(index: number): void {
    if (index === this.variantIndex || index < 0 || index >= VARIANTS.length) return;
    this.build(index);
    this.ctx.hud.setSceneLabel(this.title, VARIANTS[index] ?? null);
  }

  update(dt: number): void {
    if (this.input.wasKeyPressed('KeyR')) this.player.respawn();
    this.player.update(dt, this.input);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.publishHud();
    }
  }

  private publishHud(): void {
    const s = this.player.state;
    const p = this.player.position;
    const mode = s.mantling
      ? 'mantle'
      : s.grounded
        ? s.stance === 'crouch'
          ? 'crouch'
          : s.sprinting
            ? 'sprint'
            : 'ground'
        : 'air';
    this.ctx.hud.setDebug([
      ['speed', `${s.speed.toFixed(2)} m/s`],
      ['state', `${mode}${s.stance === 'crouch' && !s.grounded ? ' (crouch)' : ''}`],
      ['pos', `${p.x.toFixed(1)} ${p.y.toFixed(2)} ${p.z.toFixed(1)}`],
      ['steps', `${this.player.stepCount}`],
    ]);
  }

  render(alpha: number): void {
    this.player.applyToCamera(this.ctx.camera, alpha);
  }

  debugState(): Record<string, unknown> {
    const s = this.player.state;
    return {
      x: this.player.position.x,
      y: this.player.position.y,
      z: this.player.position.z,
      speed: s.speed,
      grounded: s.grounded,
      stance: s.stance,
      sprinting: s.sprinting,
      mantling: s.mantling,
      yawDeg: (this.player.yaw * 180) / Math.PI,
      pitchDeg: (this.player.pitch * 180) / Math.PI,
      sensitivity: this.cameraTunables.sensitivity,
      respawnCount: this.player.respawnCount,
      variant: VARIANTS[this.variantIndex],
      // Render-layer readouts: what the *camera* is actually doing, which is where head bob
      // and the landing dip live. Read-only — tooling still drives the game through input.
      camY: this.ctx.camera.position.y,
      camRoll: (this.ctx.camera.rotation.z * 180) / Math.PI,
      steps: this.player.stepCount,
      landDip: this.player.landDipOffset,
    };
  }

  dispose(): void {
    this.clearContent();
    this.ctx.scene.remove(this.content);
    this.ctx.scene.fog = null;
  }
}

registerScene({
  id: SCENE_ID,
  title: 'Movement Playground',
  create: () => new MovementPlayground(),
});
