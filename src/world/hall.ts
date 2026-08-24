/**
 * The hall — one big cluttered warehouse floor, built once, never moved (M1 has no prop
 * physics; that is M2).
 *
 * The layout is **authored, not generated**: the aisles, the landmark positions, the zone
 * boundaries and the shelf rows are written down here as explicit numbers, because M1's whole
 * question is "can a person navigate this by lidar", and a room that reshuffles between runs
 * cannot answer it. A seeded RNG is used only to jitter clutter *inside* authored zones — crate
 * sizes, stack heights, small offsets — so the floor looks like a warehouse instead of a
 * spreadsheet, while every run and every keyframe gets the identical room.
 *
 * The navigation contract the concept demands: local blindness from clutter, global fixation
 * from landmarks. So the hall is layered by height —
 *
 *   0.0-1.2 m  loose clutter: crates, pallets, bins. Trips you, hides the floor plan.
 *   1.2-3.0 m  shelf rows and stacks: divide the hall into "rooms" you can't see over.
 *   3.0-9.0 m  landmarks: six concrete columns, two silos, the gate wall, one tall rack run.
 *              These stick out above everything and are how you know where you are.
 *
 * Mesh and collider are the same boxes. What the lidar draws is exactly what you bump into —
 * there is no second, prettier version of the room, which is law 2 made structural.
 */

import * as THREE from 'three';
import { StaticWorld, aabbFromBounds } from '../core/collision';
import { makeRng, range, rangeInt, type Rng } from '../core/rng';
import { REVEAL_COLORS } from '../lidar/palette';

export interface HallLayout {
  readonly halfX: number;
  readonly halfZ: number;
  readonly height: number;
  readonly wallThickness: number;
  /** Where the player starts, on the floor. */
  readonly spawn: THREE.Vector3;
  /** Yaw the player starts facing, degrees. */
  readonly spawnYawDeg: number;
}

export const HALL: HallLayout = {
  halfX: 34,
  halfZ: 24,
  height: 9,
  wallThickness: 0.5,
  spawn: new THREE.Vector3(-30, 0, -20),
  spawnYawDeg: 35,
};

/** Named places, for the debug camera and for the A→B navigation gate. */
export interface Landmark {
  readonly name: string;
  readonly x: number;
  readonly z: number;
}

export const LANDMARKS: readonly Landmark[] = [
  { name: 'spawn corner', x: -30, z: -20 },
  { name: 'column A1', x: -18, z: -12 },
  { name: 'column A2', x: -18, z: 12 },
  { name: 'column B1', x: 0, z: -12 },
  { name: 'column B2', x: 0, z: 12 },
  { name: 'column C1', x: 18, z: -12 },
  { name: 'column C2', x: 18, z: 12 },
  { name: 'silo north', x: -8, z: -19 },
  { name: 'silo south', x: 10, z: 18 },
  { name: 'gate', x: 33, z: 0 },
];

/** Where the readability gate walks to: the far gate, diagonally across the whole hall. */
export const GATE_TARGET = new THREE.Vector3(29, 0, 0);

interface BuiltMaterials {
  shell: THREE.Material;
  /**
   * The ceiling slab, kept apart from the rest of the shell for one reason: the top-down debug
   * camera is above it. Seen from up there a lit hall is a flat grey rectangle and nothing else,
   * which is the least useful debug view imaginable. So the roof is its own draw, and the
   * top view hides it.
   */
  roof: THREE.Material;
  prop: THREE.Material;
  landmark: THREE.Material;
}

/**
 * Builds meshes and colliders from the same boxes, in one pass.
 *
 * The meshes only ever appear under the "lights on" debug toggle — in play the scene renders
 * nothing but the lidar lattice and the touch layer. They still have to exist, because the
 * whole point of the debug view is to compare what you inferred with what is actually there.
 */
class Builder {
  readonly group = new THREE.Group();
  /**
   * Every solid in the hall is a box, so the lights-on view is three instanced draws rather than
   * ~1500 meshes. The debug view is not allowed to be the slow one: it is what you flip to when
   * the frame timer already looks wrong.
   */
  private readonly instances: Record<keyof BuiltMaterials, number[]> = {
    shell: [],
    roof: [],
    prop: [],
    landmark: [],
  };
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly meshes: THREE.InstancedMesh[] = [];
  roof: THREE.InstancedMesh | null = null;
  boxCount = 0;

  constructor(
    private readonly world: StaticWorld,
    private readonly materials: BuiltMaterials,
  ) {}

  bounds(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    kind: keyof BuiltMaterials = 'prop',
  ): void {
    const sx = maxX - minX;
    const sy = maxY - minY;
    const sz = maxZ - minZ;
    if (sx <= 0 || sy <= 0 || sz <= 0) return;
    this.instances[kind].push(minX + sx / 2, minY + sy / 2, minZ + sz / 2, sx, sy, sz);
    this.world.add(aabbFromBounds(minX, minY, minZ, maxX, maxY, maxZ));
    this.boxCount++;
  }

  /** Box by XZ centre, base Y and full size. */
  box(
    cx: number,
    baseY: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    kind: keyof BuiltMaterials = 'prop',
  ): void {
    this.bounds(cx - sx / 2, baseY, cz - sz / 2, cx + sx / 2, baseY + sy, cz + sz / 2, kind);
  }

  /**
   * A round silo approximated by axis-aligned strips, so mesh and collider stay the same boxes.
   * Nine strips read as a ribbed tank up close and as a cylinder at 20 m, which is the range
   * this landmark has to be identifiable from.
   */
  silo(cx: number, cz: number, radius: number, baseY: number, topY: number, strips: number): void {
    const step = (radius * 2) / strips;
    for (let i = 0; i < strips; i++) {
      const zLo = cz - radius + step * i;
      const zMid = zLo + step / 2 - cz;
      const halfX = Math.sqrt(Math.max(0.04, radius * radius - zMid * zMid));
      this.bounds(cx - halfX, baseY, zLo, cx + halfX, topY, zLo + step, 'landmark');
    }
  }

  /** Turns the collected boxes into one instanced mesh per material. Call once, at the end. */
  finish(): void {
    const m = new THREE.Matrix4();
    for (const kind of ['shell', 'roof', 'prop', 'landmark'] as const) {
      const data = this.instances[kind];
      const count = data.length / 6;
      if (count === 0) continue;
      const mesh = new THREE.InstancedMesh(this.geometry, this.materials[kind], count);
      for (let i = 0; i < count; i++) {
        const o = i * 6;
        m.makeScale(data[o + 3]!, data[o + 4]!, data[o + 5]!);
        m.setPosition(data[o]!, data[o + 1]!, data[o + 2]!);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      if (kind === 'roof') this.roof = mesh;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const mesh of this.meshes) mesh.dispose();
    this.meshes.length = 0;
  }
}

export interface Hall {
  /** Lights-on meshes. Hidden unless the darkness toggle is off. */
  readonly reveal: THREE.Group;
  readonly world: StaticWorld;
  readonly layout: HallLayout;
  readonly boxCount: number;
  /** Debug only: drop the ceiling so the top-down camera can see the floor plan. */
  setRoofVisible(on: boolean): void;
  dispose(): void;
}

export function buildHall(seed = 20260824): Hall {
  const world = new StaticWorld();
  const materials: BuiltMaterials = {
    shell: new THREE.MeshLambertMaterial({ color: REVEAL_COLORS.shell }),
    roof: new THREE.MeshLambertMaterial({ color: REVEAL_COLORS.shell }),
    prop: new THREE.MeshLambertMaterial({ color: REVEAL_COLORS.prop }),
    landmark: new THREE.MeshLambertMaterial({ color: REVEAL_COLORS.landmark }),
  };
  const b = new Builder(world, materials);
  const rng = makeRng(seed);

  const { halfX, halfZ, height, wallThickness: t } = HALL;

  // --- shell -------------------------------------------------------------
  b.bounds(-halfX - t, -1, -halfZ - t, halfX + t, 0, halfZ + t, 'shell');
  b.bounds(-halfX - t, height, -halfZ - t, halfX + t, height + t, halfZ + t, 'roof');
  b.bounds(-halfX - t, 0, -halfZ - t, -halfX, height, halfZ + t, 'shell');
  b.bounds(halfX, 0, -halfZ - t, halfX + t, height, halfZ + t, 'shell');
  b.bounds(-halfX, 0, -halfZ - t, halfX, height, -halfZ, 'shell');
  b.bounds(-halfX, 0, halfZ, halfX, height, halfZ + t, 'shell');

  // The gate: a break in the east wall with a heavy lintel and two jambs. The one part of the
  // shell with a silhouette, so it reads as "the way out" from across the hall.
  b.bounds(halfX - 0.6, 0, -4.5, halfX + t, height, -3.5, 'landmark');
  b.bounds(halfX - 0.6, 0, 3.5, halfX + t, height, 4.5, 'landmark');
  b.bounds(halfX - 0.6, 5.5, -4.5, halfX + t, 6.5, 4.5, 'landmark');

  // --- landmarks ---------------------------------------------------------
  // Six structural columns on a 18 x 24 m grid. Full height, so they are visible over
  // everything and give the hall a coordinate system.
  for (const cx of [-18, 0, 18]) {
    for (const cz of [-12, 12]) {
      b.box(cx, 0, cz, 1.4, height, 1.4, 'landmark');
      // A wider footing, which is what you actually bump into and feel first.
      b.box(cx, 0, cz, 2.2, 0.5, 2.2, 'landmark');
    }
  }
  b.silo(-8, -19, 3.2, 0, 6.4, 9);
  b.silo(10, 18, 2.6, 0, 5.2, 9);

  // --- zone 1: west shelf rows (aisles running north-south) ---------------
  // Regular, tall, opaque: this is the part of the hall that feels like corridors, and the
  // part where you lose track of which aisle you are in.
  for (let i = 0; i < 4; i++) {
    const x = -28 + i * 5;
    buildRack(b, rng, x, -21, 6, 2.8, 1.1);
    buildRack(b, rng, x, 4, 17, 2.8, 1.1);
  }

  // --- zone 2: central crate field ---------------------------------------
  // Irregular, waist-to-chest high: locally confusing, globally transparent — the columns
  // still show over it. The contrast with zone 1 is the point.
  scatterCrates(b, rng, -12, -8, 12, 8, 90);

  // --- zone 3: east heavy racking (one very tall run) ---------------------
  // A single 6 m rack run: a landmark that is also a wall. Splits the east end in two.
  b.bounds(22, 0, -18, 23.4, 6, 6, 'landmark');
  for (let z = -17; z < 5; z += 3.2) {
    b.bounds(21.2, 0, z, 24.2, 0.35, z + 2.4, 'prop');
    b.bounds(21.2, 2.2, z, 24.2, 2.5, z + 2.4, 'prop');
    b.bounds(21.2, 4.3, z, 24.2, 4.6, z + 2.4, 'prop');
  }

  // --- zone 4: north-east open floor with debris -------------------------
  // Deliberately almost empty. A room with nothing in it is information too: it is the only
  // place a scan comes back with a flat far wall and nothing between.
  scatterCrates(b, rng, 6, 12, 12, 8, 14);

  // --- zone 5: south-west spill: pallets and low stacks -------------------
  scatterCrates(b, rng, -24, 14, 10, 7, 40);

  // --- loose partitions: half-height walls that break sightlines ----------
  b.bounds(-6, 0, -14, -5.4, 2.4, -4, 'shell');
  b.bounds(4, 0, 6, 14, 2.4, 4.6, 'shell');
  b.bounds(-14, 0, 16, -4, 2.0, 16.6, 'shell');

  // --- a few oddities, so places are telling apart from each other --------
  b.box(28, 0, -20, 3, 1.2, 3, 'prop'); // squat block in the NE corner
  b.box(-31, 0, 6, 1.6, 3.6, 1.6, 'prop'); // lone tall crate against the west wall
  b.box(14, 0, -6, 6, 0.9, 2.4, 'prop'); // long low bench mid-floor
  b.box(2, 0.9, -6, 2, 1.1, 2, 'prop'); //   with something stacked on it

  b.finish();

  return {
    reveal: b.group,
    setRoofVisible: (on: boolean) => {
      if (b.roof !== null) b.roof.visible = on;
    },
    world,
    layout: HALL,
    boxCount: b.boxCount,
    dispose(): void {
      b.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
  };
}

/** A shelf run: two uprights per bay plus three shelf decks. Opaque enough to hide behind. */
function buildRack(
  b: Builder,
  rng: Rng,
  x: number,
  z0: number,
  length: number,
  height: number,
  depth: number,
): void {
  const bays = Math.max(1, Math.round(length / 2.6));
  const bay = length / bays;
  for (let i = 0; i <= bays; i++) {
    const z = z0 + i * bay;
    b.bounds(x - depth / 2, 0, z - 0.1, x + depth / 2, height, z + 0.1, 'prop');
  }
  for (const deck of [0.3, height * 0.55, height - 0.25]) {
    b.bounds(x - depth / 2, deck, z0, x + depth / 2, deck + 0.12, z0 + length, 'prop');
  }
  // Half the bays carry a crate, so the run is not a perfect repeat and you can tell one
  // stretch of aisle from another.
  for (let i = 0; i < bays; i++) {
    if (rng() < 0.55) continue;
    const z = z0 + (i + 0.5) * bay;
    const sy = range(rng, 0.5, 0.9);
    const deck = rng() < 0.5 ? 0.42 : height * 0.55 + 0.12;
    b.box(x + range(rng, -0.15, 0.15), deck, z, range(rng, 0.6, 0.95), sy, range(rng, 0.6, 0.95));
  }
}

/**
 * Loose clutter inside an authored rectangle. Rejection-sampled against a coarse occupancy grid
 * so crates do not interpenetrate — which matters, because the lidar unlocks every face of a
 * prop it hears, and boxes buried inside each other would surface geometry that is not really
 * visible from anywhere.
 */
function scatterCrates(
  b: Builder,
  rng: Rng,
  cx: number,
  cz: number,
  sizeX: number,
  sizeZ: number,
  attempts: number,
): void {
  const taken: Array<[number, number, number, number]> = [];
  for (let n = 0; n < attempts; n++) {
    const w = range(rng, 0.5, 1.4);
    const d = range(rng, 0.5, 1.4);
    const x = cx + range(rng, -sizeX / 2 + w, sizeX / 2 - w);
    const z = cz + range(rng, -sizeZ / 2 + d, sizeZ / 2 - d);
    let clash = false;
    for (const [tx, tz, tw, td] of taken) {
      if (Math.abs(x - tx) < (w + tw) / 2 + 0.25 && Math.abs(z - tz) < (d + td) / 2 + 0.25) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    taken.push([x, z, w, d]);
    // Stacks of one to three, each a bit smaller than the one under it.
    const stack = rangeInt(rng, 1, 3);
    let y = 0;
    let sw = w;
    let sd = d;
    for (let s = 0; s < stack; s++) {
      const h = range(rng, 0.35, 0.8);
      b.box(x, y, z, sw, h, sd);
      y += h;
      sw *= range(rng, 0.7, 0.95);
      sd *= range(rng, 0.7, 0.95);
      if (rng() < 0.35) break;
    }
  }
}
