/**
 * The room — one dead industrial floor, hand-built.
 *
 * This is the level the prototype runs in and the shape the eventual authored-room library
 * (vision §11) will be assembled out of: a rectangular shell with a chokepoint across it, a
 * side chamber whose only way in is a corner doorway, a stair flight, scattered cargo, one
 * large-silhouette landmark, and — around that landmark — the level's one routing choice, a
 * loud short way and a quiet long one (see `APRON_Z`). It is smaller than 45 × 30 on purpose —
 * §11 wants floors sized 30-40 % under what looks right on paper, because dark space reads
 * bigger.
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
import { MAT_CONCRETE, MAT_DUST, MAT_METAL, MAT_STONE } from '../paint/materials';
import { CAN_REACH, CAN_STACK_PITCH, type CanPose } from './cans';

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
 * The side-chamber partition's two faces. `z0` is the north lane's far wall — the pinch below is
 * measured against it, so naming it keeps the two from drifting apart. Written out rather than
 * derived as `z0 + thickness`, because 4.8 + 0.4 is 5.2000000000000005 and a collider that moves
 * by a float epsilon moves the room's golden hashes with it.
 */
const CHAMBER_Z0 = 4.8;
const CHAMBER_Z1 = 5.2;

/**
 * The far room's landmark, as an axis and a radius rather than as three call sites.
 *
 * Everything else in this room is placed against a wall, which is a line the level format will
 * always have. The tank is the one thing placed against *nothing*, and it is what the far room's
 * two lanes fork around — so it is the anchor the north lane's can stack is measured off, and
 * naming it is what makes "the day the tank moves, the stack moves with it" true rather than
 * hopeful. The numbers are the ones the tower was already built from; nothing about the collider
 * changed when they got a name.
 */
const TANK = { x: 8.5, z: -2.0, radius: 3.2 } as const;

/*
 * ---------------------------------------------------------------------------
 * The dust apron: the far room's quiet half, and the level's one routing choice
 * ---------------------------------------------------------------------------
 *
 * Vision §3.9 promises the player a decision: "crossing the steel walkway is loud and fast,
 * crossing the dusty slab is quiet and slow — a real routing choice ... priced in the same
 * currency as everything else." Until this apron there was no `MAT_DUST` collider anywhere in
 * the game, so the quiet end of the material table was a number with nothing under it: the
 * multiplier was unit-tested, the voice was synthesized, and no body could ever stand on it.
 *
 * **Where the choice is.** The tank at (8.5, -2) is 6.4 m across and 6 m tall — the only thing
 * in the room that cannot be gone over, only around. It leaves two ways east: a 3.6 m gap
 * between its north face and the side-chamber partition, and a 4.8 m one between its south face
 * and the -Z wall. Both leave the chokepoint doorway and both rejoin at the far room's east
 * end, which is what makes them routes rather than directions — and the tank is the room's
 * landmark, so "north of it or south of it" is a decision a player can hold in their head after
 * one ping.
 *
 * **What each costs.** Measured door-to-east-wall on a 0.25 m grid (`tests/room.test.ts` walks
 * both and pins them): north is 20.9 m and not one step of it is on dust; south is 24.0 m and
 * most of it is. So quiet is +15 % distance — and distance is the smaller half of the bill. The
 * north lane carries the steel bench, which is the invitation to sprint it and to vault rather
 * than round it: over the bench it is 19.1 m, and at 6 m/s the whole run is 3.2 s with every
 * footfall lighting 7 m of concrete ahead (10.5 m off the steel). The south lane at ×0.6 has to
 * be *walked*, because sprinting on dust still paints 4.2 m and carries 14.4 m to any ear —
 * quiet is a stance, and the surface only discounts it. Walked, a dust step paints 2.4 m instead
 * of 4: barely past your own feet, on the blind side of a 6 m tank, for 6.9 s. Twice the time
 * for a route you can hardly see, and buying the sight back costs a Q-ping, which is louder than
 * every footstep it saved. Law 1 collecting on both sides of the same decision.
 *
 * **Why the boundary is here.** §3.2 fixes painted geometry to the cyan band whatever it is made
 * of, so a ping can show you *that* the floor is jointed here and never *what* is on the far
 * side of the joint — the reveal draws a contour wherever two boxes meet, and a joint could be
 * anything. Learning that this one is the quiet surface still costs a footstep, which is the
 * shape law 1 wants: the question is free to ask and the answer is not.
 *
 * So the boundary wants to be a line the player can already point at. `APRON_Z` is the
 * chokepoint doorway's south jamb run due east: step out of the door, turn right, and a metre
 * later you are on it. `APRON_X` is the same wall's east face — which also buys the west seam
 * for nothing, because it hides under a wall the floor already creases against, leaving one new
 * line in the room instead of two. The apron is exactly "the far room, south of the door-line",
 * and the near room keeps its ordinary poured floor as the thing dust is quieter *than*.
 */
/** The far room's floor changes on this line: the chokepoint doorway's south jamb, run east. */
const APRON_Z = -1.9;
/** ...and starts at the chokepoint wall's east face, so the near room stays entirely concrete. */
const APRON_X = -3.8;
/*
 * The bands abut exactly — no overlap, no gap — and both halves of that matter.
 *
 * A gap is a hole to fall down. An overlap is worse than it looks: two coplanar tops both
 * survive the reveal's bury test (a face is culled only when it turns out of the level or sits
 * *strictly* inside a neighbour, and nothing is above a floor), so the strip where they cross
 * gets lattice twice and reads as a brighter line drawn exactly along the material change.
 * That is the matter layer answering a question it is not allowed to answer: §3.2 gives painted
 * geometry one hue band whatever it is made of, precisely so that what a surface is made of
 * costs a footstep to learn. Measured, a 0.2 m sink cost 184 dots more than a clean abutment
 * and put 51 of them in that strip.
 *
 * What abutting still costs is the vertical seams themselves, a metre tall and buried: their
 * lattice is culled row by row against the band next door except the bottom row, which lands on
 * the bury test's own slack. That is 206 dots a metre under the floor, on faces no probe can
 * reach unoccluded, so they are built and never unlocked — the same edge artifact every
 * abutment in this room already has, and the cheapest of the three ways to split a slab.
 */

/*
 * ---------------------------------------------------------------------------
 * The can stack: what the loud lane charges for being run blind
 * ---------------------------------------------------------------------------
 *
 * Vision §8 wants props that are "authored sound-traps, never physics clutter: sparse,
 * deliberate placements ... at chokepoints" — read-and-route puzzles rather than obstacles.
 * This is the room's first one, and it is placed to sharpen the fork the apron already built
 * rather than to open a second one. North was short and loud; with a column of cans in its
 * pinch it is short, loud, and it bites if you run it blind (`world/cans.ts`, `CAN_LIFT_SPEED`:
 * walk into the stack and you lift a can off it, sprint into it and you boot it across the
 * floor). South is untouched — quiet still costs exactly what it cost before, which is distance.
 *
 * **A stack is data, not geometry.** Nothing below enters the `StaticWorld`, and that is a rule
 * rather than an implementation note: a static box under a dynamic prop would go on painting
 * lattice at a place the can has since rolled away from, which is law 2 lying, and the reveal
 * has no cheap way to retract a surface it has already drawn. The placement is authored here
 * because placements belong to the room; what happens to a can afterwards belongs to the sim.
 *
 * **Where.** The pinch is the 3.6 m between the tank's north shoulder (`TANK.z + TANK.radius`)
 * and the side-chamber partition (`CHAMBER_Z0`), and the fast line through it is the
 * tank-hugging one — the inside of the only corner the lane has. So the column stands exactly
 * one `CAN_REACH` off the tank's north face, dead centre of the shoulder, and both halves of
 * what that buys are structural rather than lucky:
 *
 *  - **The inside of the corner is closed.** The gap between column and tank is `CAN_REACH`,
 *    and a body needs its own radius *plus* `CAN_REACH` to pass without touching a can. Nothing
 *    with a radius above zero fits, so the trap cannot be dodged by cutting the corner tighter.
 *  - **The racing line runs into it.** A body hugging the tank rides its own radius off the
 *    face, which leaves it `CAN_REACH − radius` from the column: inside reach for any radius at
 *    all. Measured on the shipped collider, the shortest north route passes it at 0.12 m.
 *
 * Neither statement names 0.35 m, which is the point — both survive the next change to the
 * player's collider. What the player gets in exchange is 1.95 m of threadable lane on the
 * partition side: a decision, not a needle.
 *
 * **What it costs, and what it does not.** Going round costs almost nothing in distance — 0.2 m
 * on the test's grid, because the lane has to climb north for the steel bench anyway. The price
 * is commitment: the wide line has to be taken *before* the cans can be seen. Walking in from
 * the doorway the column is inside a walk-step's 4 m paint for the last 3.7 m of the approach,
 * which is two footfalls whatever the stance, the stride being distance-based at 1.58 m. Two
 * footfalls is the whole warning, and that is the trade §8 asks for: read it and route, or pay
 * in the currency this lane is already priced in — a can is `MAT_METAL`, the ×1.5 voice, going
 * off in the middle of the room beside the landmark everything else navigates by.
 *
 * **The column.** Six cans on `CAN_STACK_PITCH`, which is one can tall each, so the bar is
 * 0.72 m and every can's centre sits in the middle of its own slot. Six is deliberately more
 * than the rack holds (`CAN_RACK_CAP` is 4): a stack is a place you take *from*, at the price
 * of standing next to it, and never a pile you pocket in passing.
 *
 * The lean is 3.5 cm of drift at the top, accumulating as the running total 1+2+3+4+5 — each
 * can set down a little further off than the one below it, which is how a hand-stacked column
 * actually fails, and why the bottom of this one is nearly plumb and the top is not. It runs
 * *toward the tank*, for two reasons that are not aesthetic: that is the only direction that
 * cannot eat into the side the player has to thread, so the clearance measured at the base is
 * the clearance for the whole column; and it is lateral to the approach, so the tilt is at its
 * most visible from the one direction anybody ever sees this thing from. Authored, never
 * random — a seeded run has to be reproducible.
 */
/** Cans in the column. */
const CAN_STACK_COUNT = 6;
/** Metres of horizontal drift at the top can. Under `CAN_RADIUS`, so it is still a column. */
const CAN_STACK_LEAN = 0.035;

function stackedCans(): readonly CanPose[] {
  // One CAN_REACH off the tank's north face, on the shoulder's own centre line.
  const baseZ = TANK.z + TANK.radius + CAN_REACH;
  const poses: CanPose[] = [];
  for (let i = 0; i < CAN_STACK_COUNT; i++) {
    // The floor's top is y = 0 here and a can owns a slot one pitch tall, so a can's centre sits
    // half a pitch into its own slot. The drift is the running total 1+2+...+i of a mis-stack
    // that grows by a constant each can, normalised so the top of the column is CAN_STACK_LEAN.
    const drift = (CAN_STACK_LEAN * i * (i + 1)) / (CAN_STACK_COUNT * (CAN_STACK_COUNT - 1));
    poses.push(Object.freeze({ x: TANK.x, y: (i + 0.5) * CAN_STACK_PITCH, z: baseZ - drift }));
  }
  return Object.freeze(poses);
}

/** The room's one authored stack, bottom can first. Data: no box of it is in the world. */
export const CAN_STACK: readonly CanPose[] = stackedCans();

/**
 * World boxes tooling counts known geometry inside (see `Game.debugProbe`).
 *
 * They live here rather than in the driver because they are statements about *this room*: the
 * far side of the test crate, a slice of the side chamber that no straight line from the main
 * lane can reach, and the chamber crate that therefore has to stay black until someone walks in.
 */
export const PROBE_REGIONS: Readonly<
  Record<string, readonly [number, number, number, number, number, number]>
> = Object.freeze({
  // The +X face of the 1 m crate: the side the player cannot see when facing it from the spawn.
  // Floored at 4 cm so the box named here is the crate's face and nothing else: the reveal puts
  // floor dots 1.2 cm up (`SURFACE_OFFSET`) and the crate's lowest lattice row at 7 cm, and a
  // region that reaches y = 0 quietly counts the slab in the crate's own shadow as part of the
  // crate — which is a dot that will never unlock with it, because it is not part of it.
  crateBack: [TEST_CRATE.x + 0.45, 0.04, TEST_CRATE.z - 0.55, TEST_CRATE.x + 0.6, 1.0, TEST_CRATE.z + 0.55],
  // The -X face of the same crate: the side that is struck.
  crateFront: [TEST_CRATE.x - 0.6, 0.04, TEST_CRATE.z - 0.55, TEST_CRATE.x - 0.45, 1.0, TEST_CRATE.z + 0.55],
  // Deep inside the side chamber, past the doorway's line of sight from anywhere in the room.
  chamber: [4, 0, 5.6, 14, 7, 9.8],
  // The crate standing in it.
  chamberCrate: [5.1, 0, 6.6, 6.9, 1.7, 8.4],
  // The chokepoint's south doorjamb, 8.7 m from the spawn — where the ring is caught in flight.
  jamb: [-4.5, 0, -2.6, -3.5, 3.0, -1.4],
});

/** Reveal-mode albedos. Never seen in the dark — this palette only exists for the L key. */
export const REVEAL_BACKGROUND = 0x0d1216;
const REVEAL_COLORS = {
  floor: 0x8d959c,
  // The apron, so a human holding L can see where the quiet half of the far room begins. The
  // dark cannot borrow this: §3.2 gives painted geometry one hue band whatever it is made of,
  // and the only way to learn a surface in play is still to stand on it.
  dust: 0x6f685c,
  wall: 0x99a1a8,
  prop: 0x7d858c,
  accent: 0x2d6b78,
  tank: 0x6b6558,
};

interface RevealMaterials {
  floor: THREE.Material;
  dust: THREE.Material;
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
    dust: make(REVEAL_COLORS.dust, 1.0),
    wall: make(REVEAL_COLORS.wall, 0.98),
    prop: make(REVEAL_COLORS.prop, 0.9),
    accent: make(REVEAL_COLORS.accent, 0.85),
    tank: make(REVEAL_COLORS.tank, 0.55),
  };

  const b = new Builder(reveal, world, geometries);

  // --- shell: floor, ceiling and four walls. A closed box, so every ping has something
  // to come back from in every direction.
  //
  // The floor is one slab in three material bands, not three floors: same plane, same top at
  // y = 0, one continuous walking surface. The apron is laid first because `moveBody` resolves
  // ties on `maxY` in favour of the first box the broadphase yields and all three tops are at
  // y = 0 — so a foot whose circle reaches the door-line at all is standing on dust, rather
  // than the body having to clear the line by its own radius before the floor admits what it
  // is made of.
  b.bounds(APRON_X, -1, -HALF_Z, HALF_X, 0, APRON_Z, mats.dust, MAT_DUST, true);
  b.bounds(-HALF_X, -1, -HALF_Z, APRON_X, 0, APRON_Z, mats.floor, MAT_CONCRETE, true);
  b.bounds(-HALF_X, -1, APRON_Z, HALF_X, 0, HALF_Z, mats.floor, MAT_CONCRETE, true);
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
  b.bounds(CHAMBER_DOOR_X, 0, CHAMBER_Z0, HALF_X, ROOM_H, CHAMBER_Z1, mats.wall, MAT_CONCRETE, true);
  b.box(6.0, 0, 7.5, 1.6, 1.6, 1.6, mats.prop, MAT_METAL);
  b.box(9.6, 0, 8.3, 1.2, 1.0, 1.2, mats.prop, MAT_METAL);

  // --- far room: the landmark. A 6.4 m wide, 6 m tall tank with a collar and a neck —
  // vision §11 wants one large silhouette per floor, because a point cloud transmits mass
  // long before it transmits detail.
  b.tower(TANK.x, TANK.z, TANK.radius, 0, 6.0, 9, mats.tank, MAT_METAL);
  b.tower(TANK.x, TANK.z, 3.6, 5.5, 5.85, 9, mats.tank, MAT_METAL);
  b.box(TANK.x, 6.0, TANK.z, 2.6, 0.9, 2.6, mats.tank, MAT_METAL);

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
