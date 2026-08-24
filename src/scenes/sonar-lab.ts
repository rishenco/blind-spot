/**
 * Lab scene 02 — the sonar lab.
 *
 * This is the game's identity: a dead industrial room with no lights, no fog and no ambient
 * anything, where the *only* thing ever drawn is the point cloud that sound paints (vision
 * §3). Walk and your footsteps light the floor ahead of you; press Q for a 12 m room read;
 * press E to look around a 110° arc of the next 22 m. Everything you learn is bought with
 * noise, everything is learned at the speed the wavefront travels, and everything you have
 * learned cools from ice-white to a permanent navy memory skeleton.
 *
 * The meshes that make up the room exist only so the `L` key can turn the lights on for
 * comparison — collision and paint sampling both run against the `StaticWorld` box list, never
 * against the meshes. With the reveal group hidden the scene renders exactly one thing: points.
 * Every box carries a material class as well as a reveal colour, because a return off metal
 * and a return off concrete are not the same sound (see `paint/materials.ts`).
 *
 * Five looks are on 1-5. Switching one clears what is painted and reseeds the sampler, because
 * density and cell size are *sampling* parameters — the honest comparison is the same events
 * resampled, not the same blips restyled. Look 5 (Blueprint) is not a cloud at all: it answers
 * the same events by *unlocking* the room's known geometry as contours and a lattice
 * (`paint/structured.ts`), which is why the room now declares which of its boxes are the shell
 * and which are things standing in it.
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
import {
  LANDING_MIN_IMPACT,
  SOUND_CLASSES,
  SoundBus,
  WAVE_SPEEDS,
  type SoundClass,
} from '../paint/soundEvents';
import {
  PaintSystem,
  defaultAgeRamp,
  defaultPaintTunables,
  defaultWaveTunables,
  paintProfiles,
} from '../paint/paintSystem';
import { defaultStructuredTunables } from '../paint/structured';
import { MAT_CONCRETE, MAT_METAL, MAT_STONE } from '../paint/materials';
import { BloomChain, defaultBloomTunables, isSoftwareRenderer } from '../paint/post';

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

/** The lone 1 m cube in the near room — the whole-object reveal, in its simplest form. */
const TEST_CRATE = { x: -9.0, z: -3.2 };
/** West end of the side-chamber partition. Everything from here to the chokepoint is doorway. */
const CHAMBER_DOOR_X = -1.0;

/**
 * World boxes the screenshot driver counts known geometry inside (see `debugProbe`).
 *
 * They live here rather than in the driver because they are statements about *this room*: the
 * far side of the test crate, a slice of the side chamber that no straight line from the main
 * lane can reach, and the chamber crate that therefore has to stay black until someone walks in.
 */
const PROBE_REGIONS: Record<string, readonly [number, number, number, number, number, number]> = {
  // The +X face of the 1 m crate: the side the player cannot see when facing it from the spawn.
  crateBack: [TEST_CRATE.x + 0.45, 0, TEST_CRATE.z - 0.55, TEST_CRATE.x + 0.6, 1.0, TEST_CRATE.z + 0.55],
  // The -X face of the same crate: the side that is struck.
  crateFront: [TEST_CRATE.x - 0.6, 0, TEST_CRATE.z - 0.55, TEST_CRATE.x - 0.45, 1.0, TEST_CRATE.z + 0.55],
  // Deep inside the side chamber, past the doorway's line of sight from anywhere in the room.
  chamber: [4, 0, 5.6, 14, 7, 9.8],
  // The crate standing in it.
  chamberCrate: [5.1, 0, 6.6, 6.9, 1.7, 8.4],
  // The chokepoint's south doorjamb, 8.7 m from the spawn — where the ring is caught in flight.
  jamb: [-4.5, 0, -2.6, -3.5, 3.0, -1.4],
};

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

/**
 * Debug-only paint clock multipliers, cycled with T.
 *
 * ×10 and ×60 exist because ageing takes a minute and tests do not. ×0.1 exists for the
 * opposite reason: a wavefront crosses a room in half a second, which at software-GL frame
 * rates is three frames, and the only way to *look* at a front in flight — or to screenshot one
 * at a known fraction of its travel — is to slow the clock the wave rides on.
 */
const TIME_SCALES = [1, 0.1, 10, 60];

/** The looks, taken from the paint system itself so the two lists cannot drift apart. */
const VARIANTS = paintProfiles().map((p) => p.name);

/** The per-look numbers the Paint folder edits. */
type PaintKnob =
  | 'density'
  | 'cellSize'
  | 'sizeWorld'
  | 'minPixels'
  | 'maxPixels'
  | 'depthExp'
  | 'softness'
  | 'sizeJitter'
  | 'brightJitter'
  | 'brightness'
  | 'materialMix'
  | 'dissolve';
const PAINT_KNOBS: readonly PaintKnob[] = [
  'density',
  'cellSize',
  'sizeWorld',
  'minPixels',
  'maxPixels',
  'depthExp',
  'softness',
  'sizeJitter',
  'brightJitter',
  'brightness',
  'materialMix',
  'dissolve',
];

const HINT =
  'WASD move · Q ping · E beam · L reveal · 1-5 looks · B bloom · T clock · K clear · V view · R respawn · H help';

/** Reveal-mode albedos. Never seen in the dark — this palette only exists for the L key. */
const REVEAL_COLORS = {
  background: 0x0d1216,
  floor: 0x8d959c,
  wall: 0x99a1a8,
  prop: 0x7d858c,
  accent: 0x2d6b78,
  tank: 0x6b6558,
};

interface RevealMaterials {
  floor: THREE.Material;
  wall: THREE.Material;
  prop: THREE.Material;
  accent: THREE.Material;
  tank: THREE.Material;
}

/**
 * Adds a box to the collision/paint world and, in lockstep, a mesh for the reveal view.
 * Nothing may ever enter one without entering the other — the sonar would then be lying.
 *
 * The `mat` argument is what the *sonar* hears; the material argument is what the debug lights
 * show. They are independent on purpose: a look that spends hue on material must not be able to
 * borrow the reveal view's art direction.
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
    mat: number,
    shell = false,
  ): void {
    this.bounds(
      cx - sx / 2,
      baseY,
      cz - sz / 2,
      cx + sx / 2,
      baseY + sy,
      cz + sz / 2,
      material,
      mat,
      shell,
    );
  }

  /**
   * Box by its bounds. `shell` marks the boxes that *are* the room — floor, ceiling, outer walls,
   * partitions — as opposed to the things standing in it. Look 5 treats the two differently
   * (see `paint/structured.ts`): a prop you hear at all surfaces whole, a wall answers only where
   * it was actually struck.
   */
  bounds(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    material: THREE.Material,
    mat: number,
    shell = false,
  ): void {
    const sx = maxX - minX;
    const sy = maxY - minY;
    const sz = maxZ - minZ;
    const geometry = new THREE.BoxGeometry(sx, sy, sz);
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(minX + sx / 2, minY + sy / 2, minZ + sz / 2);
    this.group.add(mesh);
    this.world.add(aabbFromBounds(minX, minY, minZ, maxX, maxY, maxZ, mat, shell));
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
    mat: number,
  ): void {
    const step = (radius * 2) / strips;
    for (let i = 0; i < strips; i++) {
      const zLo = cz - radius + step * i;
      const zMid = zLo + step / 2 - cz;
      const halfX = Math.sqrt(Math.max(0.01, radius * radius - zMid * zMid));
      this.bounds(cx - halfX, baseY, zLo, cx + halfX, topY, zLo + step, material, mat);
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
    { keys: 'Q', action: 'spatial ping — 360°, 12 m, the room read' },
    { keys: 'E', action: 'directed ping — 110°, 22 m, the look-around' },
    { keys: 'L', action: 'reveal — lights on, for comparison only' },
    { keys: '1 2 3 4 5', action: 'look: Dust / Blips / Grain / Afterimage / Blueprint' },
    { keys: 'B', action: 'bloom on / off' },
    { keys: 'T', action: 'paint clock speed — x1, x0.1 (watch a wave), x10, x60' },
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

  private readonly bloomTunables = defaultBloomTunables();
  private bloomChain: BloomChain | null = null;
  private bloomOn = false;
  private softwareGl = false;

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
  private makePaintKnobs(): Record<PaintKnob | 'look' | 'bloom', number | string | boolean> {
    const knobs = {} as Record<PaintKnob | 'look' | 'bloom', number | string | boolean>;
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
    Object.defineProperty(knobs, 'bloom', {
      enumerable: true,
      get: () => this.bloomOn,
      set: (value: boolean) => {
        this.paint.profile.bloom = value;
        this.bloomOn = value;
      },
    });
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
      wave: defaultWaveTunables(),
      structured: defaultStructuredTunables(),
    });
    ctx.scene.add(this.paint.object);
    this.unsubscribeBus = this.bus.subscribe(this.paint.handle);
    this.unsubscribePlayer = this.player.onEvent(this.onPlayerEvent);

    /*
     * Bloom is what makes look 4 read the way the reference does, and it is also five mip
     * levels of separable gaussian — which a CPU rasteriser will not give away. Under software
     * GL it is off by default and the pass runs at half resolution when it is turned on, so
     * the headless driver can still take an on/off pair without the frame rate collapsing.
     */
    this.softwareGl = isSoftwareRenderer(ctx.renderer);
    this.bloomOn = this.paint.profile.bloom && !this.softwareGl;

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
      tank: this.makeMaterial(REVEAL_COLORS.tank, 0.55),
    };

    const b = new Builder(this.reveal, this.world, this.geometries);

    // --- shell: floor, ceiling and four walls. A closed box, so every ping has something
    // to come back from in every direction. All of it poured concrete.
    b.bounds(-HALF_X, -1, -HALF_Z, HALF_X, 0, HALF_Z, mats.floor, MAT_CONCRETE, true);
    b.bounds(-HALF_X, ROOM_H, -HALF_Z, HALF_X, ROOM_H + 0.5, HALF_Z, mats.wall, MAT_CONCRETE, true);
    b.bounds(-HALF_X - WALL_T, 0, -HALF_Z - WALL_T, -HALF_X, ROOM_H, HALF_Z + WALL_T, mats.wall, MAT_CONCRETE, true);
    b.bounds(HALF_X, 0, -HALF_Z - WALL_T, HALF_X + WALL_T, ROOM_H, HALF_Z + WALL_T, mats.wall, MAT_CONCRETE, true);
    b.bounds(-HALF_X, 0, -HALF_Z - WALL_T, HALF_X, ROOM_H, -HALF_Z, mats.wall, MAT_CONCRETE, true);
    b.bounds(-HALF_X, 0, HALF_Z, HALF_X, ROOM_H, HALF_Z + WALL_T, mats.wall, MAT_CONCRETE, true);

    // --- near room: the stair flight and its deck, hard against the -Z wall. Cut stone: the
    // third voice, so a staircase is identifiable by sound alone before you have touched it.
    const RISER = 0.28;
    const TREAD = 0.55;
    const STEPS = 9;
    const STAIR_X0 = -13.8;
    const DECK_TOP = RISER * STEPS; // 2.52
    for (let i = 0; i < STEPS; i++) {
      const x0 = STAIR_X0 + TREAD * i;
      b.bounds(x0, 0, -9.4, x0 + TREAD, RISER * (i + 1), -5.8, mats.accent, MAT_STONE);
    }
    const deckX0 = STAIR_X0 + TREAD * STEPS;
    b.bounds(deckX0, DECK_TOP - 0.3, -9.4, -5.2, DECK_TOP, -5.8, mats.accent, MAT_STONE);
    // Legs, not a solid block: the space *under* the deck is a real place a ping can find.
    for (const [lx, lz] of [
      [deckX0 + 0.3, -9.1],
      [deckX0 + 0.3, -6.1],
      [-5.5, -9.1],
      [-5.5, -6.1],
    ] as const) {
      b.box(lx, 0, lz, 0.3, DECK_TOP - 0.3, 0.3, mats.accent, MAT_STONE);
    }

    // --- near room: pillars and crates flanking the spawn lane (z ~ 0). Crates and stanchions
    // are metal — the hot voice, and the one that tells you which shapes are cargo.
    for (const [x, z] of [
      [-9.5, 6.5],
      [-6.0, 3.0],
    ] as const) {
      b.box(x, 0, z, 0.9, ROOM_H, 0.9, mats.prop, MAT_METAL);
    }
    b.box(-9.0, 0, 2.2, 1.8, 1.8, 1.8, mats.prop, MAT_METAL);
    b.box(-6.8, 0, 4.4, 1.2, 1.0, 1.2, mats.prop, MAT_METAL);
    b.box(-10.6, 0, 5.6, 1.4, 2.2, 1.4, mats.prop, MAT_METAL);
    b.box(-7.6, 0, -2.0, 1.0, 0.6, 1.0, mats.prop, MAT_METAL);
    b.box(-11.5, 0, -3.5, 2.0, 1.2, 1.2, mats.prop, MAT_METAL);
    /*
     * A plain 1 m cube, alone in open floor 4.7 m off the spawn and well clear of the walking
     * lane. It is here to be *one object*: look 5's rule is that a prop you hear at all surfaces
     * whole, and the cleanest way to see — and to assert — that its far side comes back with its
     * near side is to have a thing with an unambiguous far side and nothing behind it.
     */
    b.box(TEST_CRATE.x, 0, TEST_CRATE.z, 1.0, 1.0, 1.0, mats.prop, MAT_METAL);

    // --- the chokepoint: a full-height partition with a 3.8 m doorway on the spawn axis.
    // At 110° the beam no longer squeezes through the door — it lights the whole wall and both
    // jambs, and the doorway reads as the hole in the answer. That is the shot now.
    b.bounds(-4.2, 0, -HALF_Z, -3.8, ROOM_H, -1.9, mats.wall, MAT_CONCRETE, true);
    b.bounds(-4.2, 0, 1.9, -3.8, ROOM_H, HALF_Z, mats.wall, MAT_CONCRETE, true);

    /*
     * --- the side chamber: a second partition, along the room's long axis this time, closing
     * off the +Z third of the far room. Its only way in is the gap between its west end and the
     * chokepoint wall — a real doorway, on a corner, so that no straight line from the main lane
     * reaches the inside of the chamber.
     *
     * It exists for the propagation law of §3.4 and of look 5: sound with no path into a space
     * reveals nothing of it. Stand in the main room and ping and the chamber stays black however
     * loud you are; walk through the doorway and one ping hands you the whole of it. Vision §7
     * calls this a side-vault, and this is the shape of one.
     */
    b.bounds(CHAMBER_DOOR_X, 0, 4.8, HALF_X, ROOM_H, 5.2, mats.wall, MAT_CONCRETE, true);
    b.box(6.0, 0, 7.5, 1.6, 1.6, 1.6, mats.prop, MAT_METAL);
    b.box(9.6, 0, 8.3, 1.2, 1.0, 1.2, mats.prop, MAT_METAL);

    // --- far room: the landmark. A 6.4 m wide, 6 m tall tank with a collar and a neck —
    // vision §11 wants one large silhouette per floor, because a point cloud transmits mass
    // long before it transmits detail. Steel, so it announces itself in gold.
    b.tower(8.5, -2.0, 3.2, 0, 6.0, 9, mats.tank, MAT_METAL);
    b.tower(8.5, -2.0, 3.6, 5.5, 5.85, 9, mats.tank, MAT_METAL);
    b.box(8.5, 6.0, -2.0, 2.6, 0.9, 2.6, mats.tank, MAT_METAL);

    for (const [x, z] of [
      [0.5, 7.0],
      [0.5, -7.0],
      [13.0, 6.0],
      [13.0, -7.5],
    ] as const) {
      b.box(x, 0, z, 0.9, ROOM_H, 0.9, mats.prop, MAT_METAL);
    }
    b.box(2.5, 0, 2.0, 1.6, 1.6, 1.6, mats.prop, MAT_METAL);
    b.box(4.2, 0, 3.4, 1.1, 0.9, 1.1, mats.prop, MAT_METAL);
    b.box(1.5, 0, -4.5, 2.2, 2.4, 1.6, mats.prop, MAT_METAL);
    b.box(12.0, 0, 1.5, 4.0, 0.9, 1.0, mats.prop, MAT_METAL);

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
    s.add({ beam: () => this.firePing('e-ping') }, 'beam').name('E beam (110°, 22 m)');
    s.add({ clear: () => this.paint.clear() }, 'clear').name('Clear paint (K)');
    s.add({ toggle: () => this.setReveal(!this.revealOn) }, 'toggle').name('Reveal lights (L)');
    s.add({ view: () => this.player.toggleView() }, 'view').name('Toggle view (V)');

    this.buildPaintGui();
    this.buildBlueprintGui();
    this.buildWaveGui();

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
    t.add(tun, 'pixelCap', 2, 40, 0.5).name('blip px cap').onChange(push);
    t.add(tun, 'rayCap', 500, 20000, 100).name('ray cap / event');
    t.add(tun, 'roughness', 0, 3, 0.05).name('micro-relief ×');
    t.add(tun, 'splatFill', 0.1, 2, 0.05).name('peak density ×grid');
    t.add(tun, 'falloffK', 0, 24, 0.5).name('quadratic falloff');
    t.add(tun, 'featherStart', 0.1, 1, 0.02).name('rim feather');
    t.add(tun, 'rimDim', 0, 1, 0.02).name('rim dim');
    t.add(tun, 'grazeDim', 0, 1, 0.02).name('grazing return');
    t.add(tun, 'coneFeather', 0, 0.9, 0.02).name('cone edge feather');
    t.add(tun, 'edgeStart', 1, 40, 0.5).name('E edge start (m)');
    t.add(tun, 'edgeFull', 2, 60, 0.5).name('E edge full (m)');
    t.add(tun, 'edgeBand', 0.05, 1.5, 0.05).name('E edge band (m)');
    t.add(tun, 'farThin', 0.01, 1, 0.01).name('E far thinning');
    t.add(tun, 'edgeBoost', 1, 4, 0.05).name('E edge boost');
    t.add(tun, 'dedupe').name('voxel dedupe');

    const beam = gui.addFolder('Ping shape');
    beam
      .add(SOUND_CLASSES['e-ping'], 'coneAngleDeg', 10, 180, 1)
      .name('E cone (°)');
    beam.add(SOUND_CLASSES['e-ping'], 'paintRadius', 5, 60, 1).name('E range (m)');
    beam.add(SOUND_CLASSES['q-ping'], 'paintRadius', 3, 30, 1).name('Q range (m)');

    const bl = gui.addFolder('Bloom');
    bl.add(this.paintKnobs, 'bloom').name('bloom (B)').listen();
    bl.add(this.bloomTunables, 'strength', 0, 2, 0.02).name('strength');
    bl.add(this.bloomTunables, 'radius', 0, 1, 0.02).name('radius');
    bl.add(this.bloomTunables, 'threshold', 0, 1, 0.01).name('threshold');
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
    folder.add(p, 'look').name('look (1-5)').disable();
    // Sampling parameters: they change what the *next* event deposits, not what is on screen.
    folder.add(p, 'density', 0.05, 3, 0.05).name('density ×(next paint)');
    folder.add(p, 'cellSize', 0.02, 0.6, 0.005).name('cell size m (next paint)');
    folder.add(p, 'sizeWorld', 0.005, 0.4, 0.005).name('blip size (m)').onChange(apply);
    folder.add(p, 'minPixels', 0.5, 6, 0.1).name('min px').onChange(apply);
    folder.add(p, 'maxPixels', 1, 40, 0.5).name('max px').onChange(apply);
    folder.add(p, 'depthExp', 0.5, 1.2, 0.01).name('depth exponent').onChange(apply);
    folder.add(p, 'softness', 0, 1, 0.02).name('softness').onChange(apply);
    folder.add(p, 'sizeJitter', 0, 1.5, 0.05).name('size jitter').onChange(apply);
    folder.add(p, 'brightJitter', 0, 1, 0.02).name('bright jitter').onChange(apply);
    folder.add(p, 'brightness', 0.1, 3, 0.05).name('brightness').onChange(apply);
    folder.add(p, 'materialMix', 0, 1, 0.05).name('material voice').onChange(apply);
    folder.add(p, 'dissolve', 0, 1, 0.02).name('grain dissolve').onChange(apply);
    folder.add({ repaint: () => this.paint.clear() }, 'repaint').name('Clear (resample)');
  }

  /**
   * Look 5's own numbers.
   *
   * Two of them — spacing and jitter — are *build* parameters: they change the lattice itself,
   * so they rebuild it and drop whatever was known, which is why they are on `onFinishChange`
   * (a rebuild per mouse-move would be a slideshow). Everything else is a uniform and is live.
   *
   * Batch 2.3 removed two rows: the confirmation delay and the probe wake. They were the second
   * front, and the second front was the bug.
   */
  private buildBlueprintGui(): void {
    const folder = this.ctx.gui.addFolder('Blueprint (5)');
    const s = this.paint.structured.tunables;
    const push = (): void => this.paint.applyTunables();
    const rebuild = (): void => {
      this.paint.structured.rebuild();
      this.paint.clear();
    };
    folder.add(s, 'spacing', 0.08, 0.5, 0.01).name('lattice spacing (m)').onFinishChange(rebuild);
    folder.add(s, 'jitter', 0, 0.3, 0.01).name('lattice jitter ×spacing').onFinishChange(rebuild);
    folder.add(s, 'segment', 0.1, 1, 0.05).name('contour piece (m)').onFinishChange(rebuild);
    folder.add(s, 'ripple', 0, 0.15, 0.005).name('ripple amplitude (m)').onChange(push);
    folder.add(s, 'ringWidth', 0.2, 4, 0.1).name('ring width (m)').onChange(push);
    folder.add(s, 'inkSeconds', 0.01, 0.5, 0.01).name('ink-in (s)').onChange(push);
    folder.add(s, 'contourBright', 0, 3, 0.05).name('contour brightness').onChange(push);
    folder.add(s, 'dotBright', 0, 2, 0.02).name('lattice brightness').onChange(push);
    folder.add(s, 'dotSize', 0.01, 0.2, 0.005).name('lattice dot (m)').onChange(push);
    folder.add(s, 'probeBright', 0, 6, 0.1).name('probe boost ×').onChange(push);
    folder.add(s, 'probeSize', 0, 5, 0.1).name('probe swell ×').onChange(push);
    folder.add(s, 'probeSoftness', 0, 1, 0.02).name('probe blur').onChange(push);
    folder.add(s, 'dotSoftness', 0, 1, 0.02).name('lattice blur').onChange(push);
    folder.add(s, 'pixelCap', 2, 20, 0.5).name('dot px cap').onChange(push);
  }

  /** How the wave announces itself: speed, arrival flash, the firing streak, the lit air. */
  private buildWaveGui(): void {
    const folder = this.ctx.gui.addFolder('Wave');
    const w = this.paint.wave;
    const push = (): void => this.paint.applyTunables();
    folder.add(WAVE_SPEEDS, 'step', 4, 120, 1).name('speed: steps (m/s)');
    folder.add(WAVE_SPEEDS, 'ping', 4, 120, 1).name('speed: Q ping (m/s)');
    folder.add(WAVE_SPEEDS, 'beam', 4, 200, 1).name('speed: E beam (m/s)');
    folder.add(w, 'rimSeconds', 0.05, 1.5, 0.01).name('arrival flash (s)').onChange(push);
    folder.add(w, 'rimBoost', 0, 6, 0.1).name('arrival boost ×').onChange(push);
    folder.add(w, 'rimSize', 0, 4, 0.05).name('arrival swell ×').onChange(push);
    folder.add(w, 'arriveSeconds', 0, 0.4, 0.01).name('arrival ramp (s)').onChange(push);
    folder.add(w, 'refreshSeconds', 0.02, 1, 0.01).name('refresh ease (s)').onChange(push);
    folder.add(w, 'stepRim', 0, 1, 0.05).name('step flash ×').onChange(push);
    // The two bounds on a refresh (batch 2.3.1, playtest: sprinting over aged floor stamped
    // white footprints onto it). 0 on either restores exactly what the complaint was about.
    folder.add(w, 'stepFloor', 0, 2, 0.05).name('step age floor (bands)').onChange(push);
    folder.add(w, 'featherStart', 0, 1, 0.05).name('refresh feather').onChange(push);
    folder.add(w, 'tracerSeconds', 0.05, 1, 0.01).name('tracer life (s)').onChange(push);
    folder.add(w, 'tracerStart', 0, 4, 0.05).name('tracer start (m)');
    folder.add(w, 'tracerLength', 1, 22, 0.5).name('tracer length (m)');
    folder.add(w, 'tracerDrop', 0, 1.2, 0.05).name('tracer drop (m)');
    folder.add(w, 'tracerBrightness', 0, 2, 0.05).name('tracer brightness').onChange(push);
    folder.add(w, 'dust').name('front dust');
    folder.add(w, 'dustGain', 0, 4, 0.05).name('dust gain').onChange(push);
    folder.add(w, 'dustSize', 0.002, 0.05, 0.001).name('dust size (m)').onChange(push);
    folder.add(w, 'dustShell', 0.2, 6, 0.1).name('dust shell (m)').onChange(push);
  }

  // ---- lifecycle -----------------------------------------------------------

  setVariant(index: number): void {
    if (index < 0 || index >= VARIANTS.length) return;
    this.variantIndex = index;
    this.paint.setProfile(index);
    // Each look states whether it wants bloom; software GL vetoes it until B says otherwise.
    this.bloomOn = this.paint.profile.bloom && !this.softwareGl;
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
    this.syncListener();
    this.paint.advance(this.paintTime);

    if (this.input.wasKeyPressed('KeyR')) this.player.respawn();
    if (this.input.wasKeyPressed('KeyV')) this.player.toggleView();
    if (this.input.wasKeyPressed('KeyL')) this.setReveal(!this.revealOn);
    if (this.input.wasKeyPressed('KeyB')) this.bloomOn = !this.bloomOn;
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
    const diag = this.paint.diagnostics();
    this.ctx.hud.setDebug([
      [
        'look',
        `${this.paint.profileName}${this.bloomOn ? ' +bloom' : ''}${this.revealOn ? ' · REVEAL' : ''}`,
      ],
      this.paint.profile.structured
        ? [
            'known',
            (() => {
              const s = this.paint.structured.getStats();
              return `${s.unlockedDots.toLocaleString('en-US')} / ${s.dots.toLocaleString(
                'en-US',
              )} dots · ${s.unlockedEdges.toLocaleString('en-US')} / ${s.edges.toLocaleString(
                'en-US',
              )} lines`;
            })(),
          ]
        : [
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
          : this.paint.profile.structured
            ? (() => {
                const s = this.paint.structured.getStats();
                return `${last.class} · ${s.lastRays} rays · ${s.lastDots} dots / ${s.lastEdges} lines`;
              })()
            : `${last.class} · ${stats.lastRays} rays · +${stats.lastDeposited}/~${stats.lastRefreshed}`,
      ],
      [
        'wave',
        diag.waveLive
          ? `${diag.waveFront.toFixed(1)} / ${diag.waveRange.toFixed(0)} m · ${(
              diag.waveProgress * 100
            ).toFixed(0)}%`
          : 'settled',
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

  /**
   * Bloom is the only reason this scene draws itself. Off — which is every look but 4, and
   * every look under software GL until B says otherwise — this returns false immediately and
   * the frame takes the harness's direct path at zero cost. The reveal view is excluded
   * because its lit materials are graded by the renderer, and a composer without an output
   * pass would hand them to the screen ungraded.
   */
  renderFrame(scene: THREE.Scene, camera: THREE.PerspectiveCamera): boolean {
    if (!this.bloomOn || this.revealOn) return false;
    this.bloomChain ??= new BloomChain(
      this.ctx.renderer,
      this.bloomTunables,
      this.softwareGl ? 0.5 : 1,
    );
    this.bloomChain.render(scene, camera);
    return true;
  }

  debugState(): Record<string, unknown> {
    const stats = this.paint.getStats();
    const s = this.player.state;
    const cam = this.ctx.camera;
    const last = this.bus.lastEvent;
    const diag = this.paint.diagnostics();
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
      lastEventTime: last?.time ?? -1,
      lastEventSpeed: last?.waveSpeed ?? 0,
      lastRays: stats.lastRays,
      lastDeposited: stats.lastDeposited,
      lastRefreshed: stats.lastRefreshed,
      // Batch 2.3.1: what the last event's refreshes were allowed to do, and what they did.
      // `lastRestampJump` is the continuity invariant itself — the worst age step any of those
      // restamps put on screen, which the effective-stamp construction holds at zero.
      lastRefreshFloor: stats.lastRefreshFloor,
      lastFeatherMean: stats.lastFeatherMean,
      lastFloored: stats.lastFloored,
      lastRestampJump: stats.lastRestampJump,
      // Restamps the sampler reached after their own front had gone by — a slow-frame artefact,
      // reported next to the invariant so the two are never read as one number.
      lastRestampLate: stats.lastRestampLate,
      lastLateStep: stats.lastLateStep,
      // Total CPU spent sampling the last event, and the worst single frame's share of it —
      // the second is the one that can be felt, so it is the one the driver asserts on.
      lastPaintMs: stats.lastPaintMs,
      lastChunkMs: stats.lastChunkMs,
      lastChunks: stats.lastChunks,
      pendingRays: stats.pendingRays,
      lastMaxRange: stats.lastMaxRange,
      lastFar20: stats.lastFar20,
      lastSpanDeg: stats.lastSpanDeg,
      lastLateral: stats.lastLateral,
      soundEvents: this.bus.emitted,
      pingCooldown: Math.max(0, this.pingCooldown),
      paintTime: this.paintTime,
      paintTimeScale: TIME_SCALES[this.timeScaleIndex],
      reveal: this.revealOn,
      // --- wave readouts
      waveLive: diag.waveLive,
      waveFront: diag.waveFront,
      waveRange: diag.waveRange,
      waveProgress: diag.waveProgress,
      arrivedMax: diag.arrivedMax,
      pendingMin: Number.isFinite(diag.pendingMin) ? diag.pendingMin : -1,
      visiblePoints: diag.visible,
      // Batch 2.3's two branches, counted: blips easing in for the first time, and known blips
      // whose age is easing over after a silent refresh.
      rampingPoints: diag.ramping,
      refreshingPoints: diag.refreshing,
      // The ground under the player's feet, under both age curves — the shipped eased one and
      // the pre-2.3 stepped one. The pair is what makes the flicker fix measurable at frame rate.
      nearBlips: diag.nearBlips,
      nearAgeEased: diag.nearAgeEased,
      nearAgeStep: diag.nearAgeStep,
      maxBlipPixels: diag.maxBlipPixels,
      maxBlipWant: diag.maxBlipWant,
      pixelCap: this.paint.tunables.pixelCap,
      dustLit: this.paint.dustLit,
      // Batch 2.3: the front dust ships off. `dustEnabled` is the switch's own state, `dustLit`
      // is whether the field is actually drawing this frame — off means it never draws.
      dustEnabled: this.paint.wave.dust,
      arriveSeconds: this.paint.wave.arriveSeconds,
      refreshSeconds: this.paint.wave.refreshSeconds,
      stepRim: this.paint.wave.stepRim,
      stepFloor: this.paint.wave.stepFloor,
      refreshFeatherStart: this.paint.wave.featherStart,
      coolRate: this.paint.profile.coolRate,
      tracerAlive: this.paint.tracerAlive,
      tracerAge: this.paint.tracerAge,
      // --- look readouts
      bloom: this.bloomOn,
      /** What the *look* asks for, before software GL gets its veto. */
      bloomWanted: this.paint.profile.bloom,
      softwareGl: this.softwareGl,
      materialMix: this.paint.profile.materialMix,
      eConeDeg: SOUND_CLASSES['e-ping'].coneAngleDeg,
      eRange: SOUND_CLASSES['e-ping'].paintRadius,
      // --- look 5: the structured reveal
      ...this.structuredState(),
    };
  }

  /** Look 5's readouts. Cheap and constant-shaped whether or not the backend has ever run. */
  private structuredState(): Record<string, unknown> {
    const s = this.paint.structured.getStats();
    const d = this.paint.structured.diagnostics();
    const t = this.paint.structured.tunables;
    return {
      structured: this.paint.profile.structured,
      structBuilt: s.built,
      structBuildMs: s.buildMs,
      structDots: s.dots,
      structEdges: s.edges,
      structBytes: s.bytes,
      structUnlockedDots: s.unlockedDots,
      structUnlockedEdges: s.unlockedEdges,
      structLastDots: s.lastDots,
      structLastEdges: s.lastEdges,
      structLastRays: s.lastRays,
      structLastRefreshed: s.lastRefreshed,
      // The same four readouts the blip cloud publishes, off the other backend's arrays: one
      // policy is only one policy if both halves of it can be measured the same way.
      structLastFloor: s.lastFloor,
      structLastFeatherMean: s.lastFeatherMean,
      structLastFloored: s.lastFloored,
      structLastJump: s.lastJump,
      structLastLate: s.lastLate,
      structLastLateStep: s.lastLateStep,
      structLastMs: s.lastMs,
      structLastChunkMs: s.lastChunkMs,
      structLastChunks: s.lastChunks,
      structPending: s.pending,
      structDrawnDots: d.drawnDots,
      structInkedEdges: d.inkedEdges,
      structPendingEdges: d.pendingEdges,
      structRippling: d.rippling,
      structRippleMax: d.rippleMax,
      structInkSeconds: t.inkSeconds,
      structRipple: t.ripple,
      structRingWidth: t.ringWidth,
      structSpacing: t.spacing,
      probeRegions: PROBE_REGIONS,
    };
  }

  /**
   * Named world-box queries for tooling: how much of the geometry inside a region is known, and
   * how much of it is drawn right now. This is the only way to prove the propagation rules from
   * outside the renderer — that a crate's far side answered with its near side, and that the room
   * behind a wall did not answer at all.
   */
  debugProbe(name: string, args?: Record<string, unknown>): unknown {
    /*
     * How the newest event's refresh landed, per blip and per shell of its radius.
     *
     * The floor and the feather are decided in the deposit loop and thereafter only ever read by
     * the GPU, so without this the whole policy would be a matter of taking the shader's word for
     * it. The sample defaults to a small sphere around the player, which is where a footfall's
     * refresh actually happens.
     */
    if (name === 'refresh') {
      const p = this.player.position;
      const num = (key: string, fallback: number): number =>
        typeof args?.[key] === 'number' ? (args[key] as number) : fallback;
      return this.paint.refreshProbe(
        num('x', p.x),
        num('y', p.y + 0.1),
        num('z', p.z),
        num('radius', 3),
        num('rows', 24),
        num('bands', 5),
      );
    }
    if (name !== 'region') return null;
    const key = typeof args?.region === 'string' ? args.region : null;
    const box = key !== null ? PROBE_REGIONS[key] : null;
    const raw = Array.isArray(args?.box) ? (args.box as number[]) : null;
    const b = box ?? raw;
    if (b === null || b === undefined || b.length < 6) return null;
    return {
      region: key ?? 'custom',
      box: b,
      ...this.paint.structured.regionStats(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!),
    };
  }

  dispose(): void {
    this.unsubscribeBus?.();
    this.unsubscribePlayer?.();
    this.bus.dispose();
    this.paint.dispose();
    this.bloomChain?.dispose();
    this.bloomChain = null;
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
