/**
 * The room — one dead industrial floor, hand-built.
 *
 * This is the level the prototype runs in and the shape the eventual authored-room library
 * (vision §11) will be assembled out of: a rectangular shell with a chokepoint across it, a
 * side chamber whose only way in is a corner doorway, a stair flight, scattered cargo and one
 * large-silhouette landmark. It is smaller than 45 × 30 on purpose — §11 wants floors sized
 * 30-40 % under what looks right on paper, because dark space reads bigger.
 *
 * Two rules govern everything here:
 *
 *  - **The colliders are the world.** Every box goes into the `StaticWorld`, and both movement
 *    and the reveal run against that list, never against the meshes. The meshes exist for one
 *    reason: the `L` debug reveal, which turns the lights on so a human can check that what
 *    sound drew is what is actually there. Nothing may enter one list without entering the
 *    other, or the sonar would be lying (law 2).
 *
 *  - **Every box declares what it is.** Its material class, because a return off metal and a
 *    return off concrete are not the same sound, and whether it is *shell* — floor, ceiling,
 *    outer wall, partition — as opposed to a thing standing in the room. The reveal treats the
 *    two differently: a prop you hear at all surfaces whole, a wall answers only where it was
 *    actually struck.
 */

import * as THREE from 'three';
import { StaticWorld, aabbFromBounds } from '../core/collision';
import { MAT_CONCRETE, MAT_METAL, MAT_STONE } from '../paint/materials';

// Room shell.
const HALF_X = 15;
const HALF_Z = 10;
const ROOM_H = 7;
const WALL_T = 0.5;

export const SPAWN = new THREE.Vector3(-12.5, 0, 0);
/** -90 faces +X: down the long axis, through the doorway, at the tank. */
export const SPAWN_YAW_DEG = -90;

/** The lone 1 m cube in the near room — the whole-object reveal, in its simplest form. */
const TEST_CRATE = { x: -9.0, z: -3.2 };
/** West end of the side-chamber partition. Everything from here to the chokepoint is doorway. */
const CHAMBER_DOOR_X = -1.0;

/**
 * World boxes tooling counts known geometry inside (see `Game.debugProbe`).
 *
 * They live here rather than in the driver because they are statements about *this room*: the
 * far side of the test crate, a slice of the side chamber that no straight line from the main
 * lane can reach, and the chamber crate that therefore has to stay black until someone walks in.
 */
export const PROBE_REGIONS: Record<string, readonly [number, number, number, number, number, number]> = {
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

/** Reveal-mode albedos. Never seen in the dark — this palette only exists for the L key. */
export const REVEAL_BACKGROUND = 0x0d1216;
const REVEAL_COLORS = {
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
 * Adds a box to the collision/reveal world and, in lockstep, a mesh for the debug lights.
 *
 * The `mat` argument is what the *sonar* hears; the material argument is what the lit view
 * shows. They are independent on purpose: the dark must not be able to borrow the lit view's
 * art direction.
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

  /** Box by its bounds. `shell` marks the boxes that *are* the room. */
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

/** The built room: colliders are already in the world, meshes hang off `reveal`. */
export interface Room {
  /** Lit geometry and its lights, hidden unless the debug reveal is on. */
  readonly reveal: THREE.Group;
  dispose(): void;
}

export function buildRoom(world: StaticWorld): Room {
  const reveal = new THREE.Group();
  reveal.visible = false;
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const make = (color: number, roughness: number): THREE.Material => {
    const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
    materials.push(mat);
    return mat;
  };

  const mats: RevealMaterials = {
    floor: make(REVEAL_COLORS.floor, 0.95),
    wall: make(REVEAL_COLORS.wall, 0.98),
    prop: make(REVEAL_COLORS.prop, 0.9),
    accent: make(REVEAL_COLORS.accent, 0.85),
    tank: make(REVEAL_COLORS.tank, 0.55),
  };

  const b = new Builder(reveal, world, geometries);

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
   * lane. It is here to be *one object*: the reveal's rule is that a prop you hear at all
   * surfaces whole, and the cleanest way to see — and to assert — that its far side comes back
   * with its near side is to have a thing with an unambiguous far side and nothing behind it.
   */
  b.box(TEST_CRATE.x, 0, TEST_CRATE.z, 1.0, 1.0, 1.0, mats.prop, MAT_METAL);

  // --- the chokepoint: a full-height partition with a 3.8 m doorway on the spawn axis.
  // At 110° the beam does not squeeze through the door — it lights the whole wall and both
  // jambs, and the doorway reads as the hole in the answer.
  b.bounds(-4.2, 0, -HALF_Z, -3.8, ROOM_H, -1.9, mats.wall, MAT_CONCRETE, true);
  b.bounds(-4.2, 0, 1.9, -3.8, ROOM_H, HALF_Z, mats.wall, MAT_CONCRETE, true);

  /*
   * --- the side chamber: a second partition, along the room's long axis this time, closing
   * off the +Z third of the far room. Its only way in is the gap between its west end and the
   * chokepoint wall — a real doorway, on a corner, so that no straight line from the main lane
   * reaches the inside of the chamber.
   *
   * It exists for the propagation law of §3.4: sound with no path into a space reveals nothing
   * of it. Stand in the main room and ping and the chamber stays black however loud you are;
   * walk through the doorway and one ping hands you the whole of it. Vision §7 calls this a
   * side-vault, and this is the shape of one.
   */
  b.bounds(CHAMBER_DOOR_X, 0, 4.8, HALF_X, ROOM_H, 5.2, mats.wall, MAT_CONCRETE, true);
  b.box(6.0, 0, 7.5, 1.6, 1.6, 1.6, mats.prop, MAT_METAL);
  b.box(9.6, 0, 8.3, 1.2, 1.0, 1.2, mats.prop, MAT_METAL);

  // --- far room: the landmark. A 6.4 m wide, 6 m tall tank with a collar and a neck —
  // vision §11 wants one large silhouette per floor, because a point cloud transmits mass
  // long before it transmits detail.
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
  // entire debug view — geometry and light — on and off together.
  const hemi = new THREE.HemisphereLight(0x9db4c4, 0x1a1e22, 1.4);
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(10, 20, 8);
  const fill = new THREE.DirectionalLight(0x8fa6bb, 0.6);
  fill.position.set(-12, 9, -10);
  reveal.add(hemi, key, key.target, fill);

  return {
    reveal,
    dispose(): void {
      reveal.clear();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
