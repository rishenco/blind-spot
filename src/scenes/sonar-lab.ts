/**
 * Lab scene 02 — the sonar lab.
 *
 * This is the game's identity: a dead industrial room with no lights, no fog and no ambient
 * anything, where the *only* thing ever drawn is the point cloud that sound paints (vision
 * §3). Walk and your footsteps light the floor ahead of you; press Q for a 12 m room read;
 * press E to ask a 25° question 40 m long. Everything you learn is bought with noise, and
 * everything you have learned cools from ice-white to a permanent navy memory skeleton.
 *
 * The meshes that make up the room exist only so the `L` key can turn the lights on for
 * comparison — collision and paint sampling both run against the `StaticWorld` box list, never
 * against the meshes. With the reveal group hidden the scene renders exactly one thing: points.
 *
 * Three looks are on 1/2/3 (§Variants in the batch brief). Switching one clears the cloud and
 * reseeds the sampler, because density and cell size are *sampling* parameters — the honest
 * comparison is the same events resampled, not the same blips restyled.
 */

import * as THREE from 'three';
import type GUI from 'lil-gui';
import { registerScene, type LabScene, type SceneCtx } from '../lab/registry';
import { StaticWorld, aabbFromBounds } from '../core/collision';
import {
  PlayerController,
  defaultBobTunables,
  defaultCameraFeelTunables,
  defaultCameraTunables,
  defaultMantleTunables,
  defaultMovementTunables,
  defaultThirdPersonTunables,
  type PlayerEvent,
} from '../player/controller';
import type { Input } from '../core/input';
import { LANDING_MIN_IMPACT, SoundBus, type SoundClass } from '../paint/soundEvents';
import { PaintSystem, defaultAgeRamp, defaultPaintTunables } from '../paint/paintSystem';

const SCENE_ID = 'sonar-lab';

// Room shell. Deliberately smaller than the movement playground's 45 x 30: vision §11 wants
// floors sized 30-40 % under what looks right on paper, because dark space reads bigger.
const HALF_X = 15;
const HALF_Z = 10;
const ROOM_H = 7;
const WALL_T = 0.5;

const SPAWN = new THREE.Vector3(-12.5, 0, 0);
/** -90 faces +X: down the long axis, through the doorway, at the tank. */
const SPAWN_YAW_DEG = -90;

/** Shared ping cooldown, seconds (§3.5). */
const PING_COOLDOWN = 0.75;
/** Where a ping is emitted from, metres above the feet. */
const Q_PING_HEIGHT = 1.15;
const E_PING_HEIGHT = 1.5;
/**
 * Where a footfall radiates from, metres above the contact point.
 *
 * Not zero, and that is a design decision rather than a fudge. A point source lying *on* the
 * floor plane meets that plane at 90° everywhere and paints a puddle a handspring wide however
 * many rays it is given — the returns all come back grazing. Vision §3.3 wants a walk step to
 * paint 4 m and a sprint step to light the path ~7 m ahead, so the sound has to leave the rig,
 * not the floor: the strike rings up through the chassis and radiates from about knee height.
 */
const STEP_HEIGHT = 0.65;

/** Debug-only paint clock multipliers, cycled with T. Ageing takes a minute; tests do not. */
const TIME_SCALES = [1, 10, 60];

const VARIANTS = ['Dust', 'Blips', 'Grain'];

/** The per-look numbers the Paint folder edits. All of them are plain numbers. */
type PaintKnob =
  | 'density'
  | 'cellSize'
  | 'sizeWorld'
  | 'minPixels'
  | 'maxPixels'
  | 'softness'
  | 'sizeJitter'
  | 'brightJitter'
  | 'brightness';
const PAINT_KNOBS: readonly PaintKnob[] = [
  'density',
  'cellSize',
  'sizeWorld',
  'minPixels',
  'maxPixels',
  'softness',
  'sizeJitter',
  'brightJitter',
  'brightness',
];

const HINT =
  'WASD move · Q ping · E beam · L reveal · 1-3 looks · T clock · V view · R respawn · H help';

/** Reveal-mode albedos. Never seen in the dark — this palette only exists for the L key. */
const REVEAL_COLORS = {
  background: 0x0d1216,
  floor: 0x8d959c,
  wall: 0x99a1a8,
  prop: 0x7d858c,
  accent: 0x2d6b78,
};

interface RevealMaterials {
  floor: THREE.Material;
  wall: THREE.Material;
  prop: THREE.Material;
  accent: THREE.Material;
}

/**
 * Adds a box to the collision/paint world and, in lockstep, a mesh for the reveal view.
 * Nothing may ever enter one without entering the other — the sonar would then be lying.
 */
class Builder {
  constructor(
    private readonly group: THREE.Group,
    private readonly world: StaticWorld,
    private readonly geometries: THREE.BufferGeometry[],
  ) {}

  /** Box by its XZ centre, its base Y and its full size. */
  box(
    cx: number,
    baseY: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    material: THREE.Material,
  ): void {
    this.bounds(
      cx - sx / 2,
      baseY,
      cz - sz / 2,
      cx + sx / 2,
      baseY + sy,
      cz + sz / 2,
      material,
    );
  }

  /** Box by its bounds. */
  bounds(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    material: THREE.Material,
  ): void {
    const sx = maxX - minX;
    const sy = maxY - minY;
    const sz = maxZ - minZ;
    const geometry = new THREE.BoxGeometry(sx, sy, sz);
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(minX + sx / 2, minY + sy / 2, minZ + sz / 2);
    this.group.add(mesh);
    this.world.add(aabbFromBounds(minX, minY, minZ, maxX, maxY, maxZ));
  }

  /**
   * A round tower approximated by axis-aligned strips — the mesh is built from exactly the
   * same boxes as the collider, so what the sonar returns is what is physically there. Nine
   * strips read as a ribbed industrial tank up close and as a cylinder at 20 m, which is the
   * range this landmark is meant to be identified from.
   */
  tower(
    cx: number,
    cz: number,
    radius: number,
    baseY: number,
    topY: number,
    strips: number,
    material: THREE.Material,
  ): void {
    const step = (radius * 2) / strips;
    for (let i = 0; i < strips; i++) {
      const zLo = cz - radius + step * i;
      const zMid = zLo + step / 2 - cz;
      const halfX = Math.sqrt(Math.max(0.01, radius * radius - zMid * zMid));
      this.bounds(cx - halfX, baseY, zLo, cx + halfX, topY, zLo + step, material);
    }
  }
}

export class SonarLab implements LabScene {
  readonly id = SCENE_ID;
  readonly title = 'Sonar Lab';
  readonly variants = VARIANTS;
  readonly hint = HINT;
  readonly help = [
    { keys: 'W A S D', action: 'move' },
    { keys: 'Shift / C', action: 'sprint / crouch — louder and quieter paint' },
    { keys: 'Space', action: 'jump — landings paint hard' },
    { keys: 'Q', action: 'spatial ping — 360°, 12 m' },
    { keys: 'E', action: 'directed ping — 25° cone, 40 m' },
    { keys: 'L', action: 'reveal — lights on, for comparison only' },
    { keys: '1 2 3', action: 'look: Dust / Blips / Grain' },
    { keys: 'T', action: 'paint clock speed (debug ageing)' },
    { keys: 'K', action: 'clear the painted map' },
    { keys: 'V / R', action: 'view / respawn' },
    { keys: 'H', action: 'toggle this help' },
  ];

  private ctx!: SceneCtx;
  private input!: Input;

  private readonly world = new StaticWorld();
  private readonly movement = defaultMovementTunables();
  private readonly cameraTunables = defaultCameraTunables();
  private readonly bobTunables = defaultBobTunables();
  private readonly mantleTunables = defaultMantleTunables();
  private readonly thirdPersonTunables = defaultThirdPersonTunables();
  private readonly feelTunables = defaultCameraFeelTunables();
  private player!: PlayerController;

  private readonly bus = new SoundBus();
  private paint!: PaintSystem;
  private unsubscribeBus: (() => void) | null = null;
  private unsubscribePlayer: (() => void) | null = null;

  private readonly reveal = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private revealOn = false;
  private rigMarker!: THREE.Mesh;

  private paintTime = 0;
  private timeScaleIndex = 0;
  private pingCooldown = 0;
  private variantIndex = 0;
  private hudTimer = 0;
  private paintFolder: GUI | null = null;

  private readonly aim = new THREE.Vector3();
  private readonly paintKnobs = this.makePaintKnobs();

  /**
   * A stable stand-in for "whichever look is active", so the Paint folder can be built once.
   * Every property forwards to the live profile, which is what lets `updateDisplay()` pick up
   * a variant switch without the folder being torn down.
   */
  private makePaintKnobs(): Record<PaintKnob | 'look', number | string> {
    const knobs = {} as Record<PaintKnob | 'look', number | string>;
    for (const key of PAINT_KNOBS) {
      Object.defineProperty(knobs, key, {
        enumerable: true,
        get: () => this.paint.profile[key],
        set: (value: number) => {
          this.paint.profile[key] = value;
        },
      });
    }
    Object.defineProperty(knobs, 'look', { enumerable: true, get: () => this.paint.profileName });
    return knobs;
  }

  init(ctx: SceneCtx): void {
    this.ctx = ctx;
    this.input = ctx.input;

    // Law 3: absence is black. No ambient light, no fog, no helpful outlines — ever.
    ctx.scene.background = new THREE.Color(0x000000);
    ctx.scene.fog = null;

    this.buildRoom();
    this.reveal.visible = false;
    ctx.scene.add(this.reveal);

    this.player = new PlayerController(
      this.world,
      this.movement,
      this.cameraTunables,
      this.bobTunables,
      this.mantleTunables,
      this.thirdPersonTunables,
      this.feelTunables,
    );
    this.player.setSpawn(SPAWN, SPAWN_YAW_DEG);

    this.paint = new PaintSystem(this.world, {
      tunables: defaultPaintTunables(),
      ramp: defaultAgeRamp(),
    });
    ctx.scene.add(this.paint.object);
    this.unsubscribeBus = this.bus.subscribe(this.paint.handle);
    this.unsubscribePlayer = this.player.onEvent(this.onPlayerEvent);

    // The only thing drawn that sound did not paint: your own reactor, and only from outside
    // your own head. Without it the third-person view has no anchor at all in the dark.
    const rigGeometry = new THREE.SphereGeometry(0.1, 10, 8);
    this.geometries.push(rigGeometry);
    const rigMaterial = new THREE.MeshBasicMaterial({ color: 0xffa63c });
    this.materials.push(rigMaterial);
    this.rigMarker = new THREE.Mesh(rigGeometry, rigMaterial);
    this.rigMarker.visible = false;
    ctx.scene.add(this.rigMarker);

    this.syncListener();
    this.buildGui();
  }

  // ---- world construction --------------------------------------------------

  private makeMaterial(color: number, roughness: number): THREE.Material {
    const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
    this.materials.push(mat);
    return mat;
  }

  private buildRoom(): void {
    const mats: RevealMaterials = {
      floor: this.makeMaterial(REVEAL_COLORS.floor, 0.95),
      wall: this.makeMaterial(REVEAL_COLORS.wall, 0.98),
      prop: this.makeMaterial(REVEAL_COLORS.prop, 0.9),
      accent: this.makeMaterial(REVEAL_COLORS.accent, 0.85),
    };

    const b = new Builder(this.reveal, this.world, this.geometries);

    // --- shell: floor, ceiling and four walls. A closed box, so every ping has something
    // to come back from in every direction.
    b.bounds(-HALF_X, -1, -HALF_Z, HALF_X, 0, HALF_Z, mats.floor);
    b.bounds(-HALF_X, ROOM_H, -HALF_Z, HALF_X, ROOM_H + 0.5, HALF_Z, mats.wall);
    b.bounds(-HALF_X - WALL_T, 0, -HALF_Z - WALL_T, -HALF_X, ROOM_H, HALF_Z + WALL_T, mats.wall);
    b.bounds(HALF_X, 0, -HALF_Z - WALL_T, HALF_X + WALL_T, ROOM_H, HALF_Z + WALL_T, mats.wall);
    b.bounds(-HALF_X, 0, -HALF_Z - WALL_T, HALF_X, ROOM_H, -HALF_Z, mats.wall);
    b.bounds(-HALF_X, 0, HALF_Z, HALF_X, ROOM_H, HALF_Z + WALL_T, mats.wall);

    // --- near room: the stair flight and its deck, hard against the -Z wall.
    const RISER = 0.28;
    const TREAD = 0.55;
    const STEPS = 9;
    const STAIR_X0 = -13.8;
    const DECK_TOP = RISER * STEPS; // 2.52
    for (let i = 0; i < STEPS; i++) {
      const x0 = STAIR_X0 + TREAD * i;
      b.bounds(x0, 0, -9.4, x0 + TREAD, RISER * (i + 1), -5.8, mats.accent);
    }
    const deckX0 = STAIR_X0 + TREAD * STEPS;
    b.bounds(deckX0, DECK_TOP - 0.3, -9.4, -5.2, DECK_TOP, -5.8, mats.accent);
    // Legs, not a solid block: the space *under* the deck is a real place a ping can find.
    for (const [lx, lz] of [
      [deckX0 + 0.3, -9.1],
      [deckX0 + 0.3, -6.1],
      [-5.5, -9.1],
      [-5.5, -6.1],
    ] as const) {
      b.box(lx, 0, lz, 0.3, DECK_TOP - 0.3, 0.3, mats.accent);
    }

    // --- near room: pillars and crates flanking the spawn lane (z ~ 0).
    for (const [x, z] of [
      [-9.5, 6.5],
      [-6.0, 3.0],
    ] as const) {
      b.box(x, 0, z, 0.9, ROOM_H, 0.9, mats.prop);
    }
    b.box(-9.0, 0, 2.2, 1.8, 1.8, 1.8, mats.prop);
    b.box(-6.8, 0, 4.4, 1.2, 1.0, 1.2, mats.prop);
    b.box(-10.6, 0, 5.6, 1.4, 2.2, 1.4, mats.prop);
    b.box(-7.6, 0, -2.0, 1.0, 0.6, 1.0, mats.prop);
    b.box(-11.5, 0, -3.5, 2.0, 1.2, 1.2, mats.prop);

    // --- the chokepoint: a full-height partition with a 3.8 m doorway on the spawn axis.
    // The E-ping cone is 1.88 m wide by the time it gets here, so it squeezes through with
    // just enough overspill to light the jambs — a beam through a door, which is the shot.
    b.bounds(-4.2, 0, -HALF_Z, -3.8, ROOM_H, -1.9, mats.wall);
    b.bounds(-4.2, 0, 1.9, -3.8, ROOM_H, HALF_Z, mats.wall);

    // --- far room: the landmark. A 6.4 m wide, 6 m tall tank with a collar and a neck —
    // vision §11 wants one large silhouette per floor, because a point cloud transmits mass
    // long before it transmits detail.
    b.tower(8.5, -2.0, 3.2, 0, 6.0, 9, mats.accent);
    b.tower(8.5, -2.0, 3.6, 5.5, 5.85, 9, mats.accent);
    b.box(8.5, 6.0, -2.0, 2.6, 0.9, 2.6, mats.accent);

    for (const [x, z] of [
      [0.5, 7.0],
      [0.5, -7.0],
      [13.0, 6.0],
      [13.0, -7.5],
    ] as const) {
      b.box(x, 0, z, 0.9, ROOM_H, 0.9, mats.prop);
    }
    b.box(2.5, 0, 2.0, 1.6, 1.6, 1.6, mats.prop);
    b.box(4.2, 0, 3.4, 1.1, 0.9, 1.1, mats.prop);
    b.box(1.5, 0, -4.5, 2.2, 2.4, 1.6, mats.prop);
    b.box(12.0, 0, 1.5, 4.0, 0.9, 1.0, mats.prop);

    // Reveal-only lighting. Parented to the reveal group so a single `visible` flag turns the
    // entire comparison view — geometry and light — on and off together.
    const hemi = new THREE.HemisphereLight(0x9db4c4, 0x1a1e22, 1.4);
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(10, 20, 8);
    const fill = new THREE.DirectionalLight(0x8fa6bb, 0.6);
    fill.position.set(-12, 9, -10);
    this.reveal.add(hemi, key, key.target, fill);
  }

  // ---- sound -------------------------------------------------------------

  private onPlayerEvent = (event: PlayerEvent): void => {
    if (event.type === 'footstep') {
      const cls: SoundClass =
        event.tier === 'crouch' ? 'crouch-step' : event.tier === 'sprint' ? 'sprint-step' : 'walk-step';
      this.bus.emit({ class: cls, x: event.x, y: event.y + STEP_HEIGHT, z: event.z });
      return;
    }
    // §3.3 only gives landings above a 2 m drop a paint radius; stepping off a kerb is not a
    // flashbulb, and a respawn settling onto the floor certainly is not.
    if (event.impactSpeed < LANDING_MIN_IMPACT) return;
    const radius = SoundBus.landingRadius(event.impactSpeed);
    this.bus.emit({
      class: 'landing',
      x: event.x,
      y: event.y + STEP_HEIGHT,
      z: event.z,
      paintRadius: radius,
      intensity: 0.95 + 0.35 * ((radius - 8) / 6),
    });
  };

  private firePing(kind: 'q-ping' | 'e-ping'): void {
    const p = this.player.position;
    if (kind === 'q-ping') {
      this.bus.emit({ class: 'q-ping', x: p.x, y: p.y + Q_PING_HEIGHT, z: p.z });
    } else {
      const cp = Math.cos(this.player.pitch);
      this.aim.set(
        -Math.sin(this.player.yaw) * cp,
        Math.sin(this.player.pitch),
        -Math.cos(this.player.yaw) * cp,
      );
      this.bus.emit({
        class: 'e-ping',
        x: p.x,
        y: p.y + E_PING_HEIGHT,
        z: p.z,
        dirX: this.aim.x,
        dirY: this.aim.y,
        dirZ: this.aim.z,
      });
    }
    this.pingCooldown = PING_COOLDOWN;
  }

  private syncListener(): void {
    const p = this.player.position;
    this.paint.setListener(p.x, p.y + E_PING_HEIGHT, p.z);
  }

  // ---- gui -----------------------------------------------------------------

  private buildGui(): void {
    const gui = this.ctx.gui;

    const s = gui.addFolder('Scene');
    s.add({ respawn: () => this.player.respawn() }, 'respawn').name('Respawn (R)');
    s.add({ ping: () => this.firePing('q-ping') }, 'ping').name('Q ping (360°, 12 m)');
    s.add({ beam: () => this.firePing('e-ping') }, 'beam').name('E beam (25°, 40 m)');
    s.add({ clear: () => this.paint.clear() }, 'clear').name('Clear paint');
    s.add({ toggle: () => this.setReveal(!this.revealOn) }, 'toggle').name('Reveal lights (L)');
    s.add({ view: () => this.player.toggleView() }, 'view').name('Toggle view (V)');

    this.buildPaintGui();

    const r = gui.addFolder('Age ramp');
    const ramp = this.paint.ramp;
    const push = (): void => this.paint.applyTunables();
    r.add(ramp, 'freshSeconds', 0.2, 10, 0.1).name('white→cyan (s)').onChange(push);
    r.add(ramp, 'coolSeconds', 1, 60, 0.5).name('cyan→navy (s)').onChange(push);
    r.add(ramp, 'coldSeconds', 5, 240, 1).name('navy→skeleton (s)').onChange(push);
    r.add(ramp, 'skeletonAlpha', 0, 1, 0.01).name('skeleton alpha').onChange(push);
    r.add(ramp, 'skeletonSize', 0.2, 1, 0.05).name('skeleton size').onChange(push);

    const t = gui.addFolder('Perception');
    const tun = this.paint.tunables;
    t.add(tun, 'hearingRange', 2, 60, 1).name('hearing (m)');
    t.add(tun, 'windowRadius', 5, 120, 1).name('draw window (m)').onChange(push);
    t.add(tun, 'splatFill', 0.1, 2, 0.05).name('peak density ×grid');
    t.add(tun, 'falloffK', 0, 24, 0.5).name('quadratic falloff');
    t.add(tun, 'featherStart', 0.1, 1, 0.02).name('rim feather');
    t.add(tun, 'rimDim', 0, 1, 0.02).name('rim dim');
    t.add(tun, 'grazeDim', 0, 1, 0.02).name('grazing return');
    t.add(tun, 'edgeStart', 1, 40, 0.5).name('E edge start (m)');
    t.add(tun, 'edgeFull', 2, 60, 0.5).name('E edge full (m)');
    t.add(tun, 'edgeBand', 0.05, 1.5, 0.05).name('E edge band (m)');
    t.add(tun, 'farThin', 0.01, 1, 0.01).name('E far thinning');
    t.add(tun, 'edgeBoost', 1, 4, 0.05).name('E edge boost');
    t.add(tun, 'dedupe').name('voxel dedupe');
  }

  /**
   * The active look's numbers, live.
   *
   * The folder is built once, over a façade whose accessors forward to whichever profile is
   * active, rather than being destroyed and rebuilt per look — a rebuilt folder is appended to
   * the end of the panel, so switching looks would shuffle the panel around under the cursor.
   */
  private buildPaintGui(): void {
    const folder = this.ctx.gui.addFolder('Paint');
    this.paintFolder = folder;
    const p = this.paintKnobs;
    const apply = (): void => this.paint.applyProfile();
    folder.add(p, 'look').name('look (1-3)').disable();
    // Sampling parameters: they change what the *next* event deposits, not what is on screen.
    folder.add(p, 'density', 0.05, 3, 0.05).name('density ×(next paint)');
    folder.add(p, 'cellSize', 0.02, 0.6, 0.01).name('cell size m (next paint)');
    folder.add(p, 'sizeWorld', 0.005, 0.4, 0.005).name('blip size (m)').onChange(apply);
    folder.add(p, 'minPixels', 0.5, 6, 0.1).name('min px').onChange(apply);
    folder.add(p, 'maxPixels', 1, 40, 0.5).name('max px').onChange(apply);
    folder.add(p, 'softness', 0, 1, 0.02).name('softness').onChange(apply);
    folder.add(p, 'sizeJitter', 0, 1.5, 0.05).name('size jitter').onChange(apply);
    folder.add(p, 'brightJitter', 0, 1, 0.02).name('bright jitter').onChange(apply);
    folder.add(p, 'brightness', 0.1, 3, 0.05).name('brightness').onChange(apply);
    folder.add({ repaint: () => this.paint.clear() }, 'repaint').name('Clear (resample)');
  }

  // ---- lifecycle -----------------------------------------------------------

  setVariant(index: number): void {
    if (index < 0 || index >= VARIANTS.length) return;
    this.variantIndex = index;
    this.paint.setProfile(index);
    for (const c of this.paintFolder?.controllers ?? []) c.updateDisplay();
    this.ctx.hud.setSceneLabel(this.title, VARIANTS[index] ?? null);
  }

  private setReveal(on: boolean): void {
    this.revealOn = on;
    this.reveal.visible = on;
    (this.ctx.scene.background as THREE.Color).setHex(on ? REVEAL_COLORS.background : 0x000000);
  }

  update(dt: number): void {
    this.paintTime += dt * TIME_SCALES[this.timeScaleIndex]!;
    this.bus.setTime(this.paintTime);
    this.paint.setTime(this.paintTime);
    this.syncListener();

    if (this.input.wasKeyPressed('KeyR')) this.player.respawn();
    if (this.input.wasKeyPressed('KeyV')) this.player.toggleView();
    if (this.input.wasKeyPressed('KeyL')) this.setReveal(!this.revealOn);
    if (this.input.wasKeyPressed('KeyT')) {
      this.timeScaleIndex = (this.timeScaleIndex + 1) % TIME_SCALES.length;
    }
    if (this.input.wasKeyPressed('KeyK')) this.paint.clear();

    if (this.pingCooldown > 0) this.pingCooldown -= dt;
    if (this.pingCooldown <= 0) {
      if (this.input.wasKeyPressed('KeyQ')) this.firePing('q-ping');
      else if (this.input.wasKeyPressed('KeyE')) this.firePing('e-ping');
    }

    this.player.update(dt, this.input);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.publishHud();
    }
  }

  private publishHud(): void {
    const stats = this.paint.getStats();
    const last = this.bus.lastEvent;
    const scale = TIME_SCALES[this.timeScaleIndex]!;
    const s = this.player.state;
    this.ctx.hud.setDebug([
      ['look', `${this.paint.profileName}${this.revealOn ? ' · REVEAL' : ''}`],
      [
        'points',
        `${stats.points.toLocaleString('en-US')} / ${(stats.capacity / 1000).toFixed(0)}k · ${(
          (stats.points / stats.capacity) *
          100
        ).toFixed(1)}%${stats.wrapped ? ' WRAP' : ''}`,
      ],
      [
        'event',
        last === null
          ? '—'
          : `${last.class} · ${stats.lastRays} rays · +${stats.lastDeposited}/~${stats.lastRefreshed}`,
      ],
      [
        'ping',
        this.pingCooldown > 0 ? `cooling ${this.pingCooldown.toFixed(2)} s` : 'ready  Q · E',
      ],
      ['clock', `${this.paintTime.toFixed(1)} s ×${scale}`],
      ['speed', `${s.speed.toFixed(2)} m/s · ${s.stance}${s.grounded ? '' : ' · air'}`],
    ]);
  }

  render(alpha: number): void {
    this.player.applyToCamera(this.ctx.camera, alpha);
    this.paint.updateView(this.ctx.camera, this.ctx.renderer);
    const p = this.player.renderPosition;
    this.rigMarker.position.set(p.x, p.y + 1.15, p.z);
    this.rigMarker.visible = this.player.viewBlend > 0.05;
  }

  debugState(): Record<string, unknown> {
    const stats = this.paint.getStats();
    const s = this.player.state;
    const cam = this.ctx.camera;
    const last = this.bus.lastEvent;
    return {
      variant: VARIANTS[this.variantIndex],
      variantIndex: this.variantIndex,
      x: this.player.position.x,
      y: this.player.position.y,
      z: this.player.position.z,
      yawDeg: (this.player.yaw * 180) / Math.PI,
      pitchDeg: (this.player.pitch * 180) / Math.PI,
      speed: s.speed,
      grounded: s.grounded,
      stance: s.stance,
      sprinting: s.sprinting,
      respawnCount: this.player.respawnCount,
      sensitivity: this.cameraTunables.sensitivity,
      view: this.player.viewMode,
      viewBlend: this.player.viewBlend,
      camX: cam.position.x,
      camY: cam.position.y,
      camZ: cam.position.z,
      // --- paint readouts
      points: stats.points,
      capacity: stats.capacity,
      wrapped: stats.wrapped,
      lastEvent: last?.class ?? null,
      lastEventSeq: last?.seq ?? -1,
      lastRays: stats.lastRays,
      lastDeposited: stats.lastDeposited,
      lastRefreshed: stats.lastRefreshed,
      lastPaintMs: stats.lastPaintMs,
      lastMaxRange: stats.lastMaxRange,
      lastFar20: stats.lastFar20,
      soundEvents: this.bus.emitted,
      pingCooldown: Math.max(0, this.pingCooldown),
      paintTime: this.paintTime,
      paintTimeScale: TIME_SCALES[this.timeScaleIndex],
      reveal: this.revealOn,
    };
  }

  dispose(): void {
    this.unsubscribeBus?.();
    this.unsubscribePlayer?.();
    this.bus.dispose();
    this.paint.dispose();
    this.ctx.scene.remove(this.paint.object);
    this.ctx.scene.remove(this.reveal);
    this.ctx.scene.remove(this.rigMarker);
    this.reveal.clear();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.world.clear();
  }
}

registerScene({
  id: SCENE_ID,
  title: 'Sonar Lab',
  create: () => new SonarLab(),
});
