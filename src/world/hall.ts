/**
 * The hall — one big cluttered warehouse floor, generated from a seed.
 *
 * M1..M4 shipped an *authored* room: every rack, silo and column written down as a literal
 * number. That was right while the question was "does a lidar read a room at all". M5's question
 * is different — *can the player say "I have been here before" and be right?* — and a single
 * hand-made room cannot answer it, because after the third run the human has memorised it and
 * every judgement is contaminated. So the layout is now generated, and the debug tool
 * (`tools/world.mjs`) looks at ten seeds side by side.
 *
 * The concept demands two layers that work against each other on purpose:
 *
 *   0.0-1.2 m  loose clutter: crates, pallets, bins. Takes orientation away — near the floor
 *              every corner of the hall looks like every other corner.
 *   1.2-3.0 m  dividers and shelf rows: cut the hall into ROOMS you cannot see over. This is
 *              what makes the place a warehouse rather than a field with junk on it.
 *   3.0-9.0 m  landmarks: four or five things that stick out above everything else. They give
 *              orientation back — but only globally, and only if you point the lidar up.
 *
 * Two rules the generator is built around:
 *
 *  - **Not a maze.** The partition is a BSP tree, so the room graph is a tree with wide
 *    openings, never a warren of dead corridors. Loops appear only where a passage happens to
 *    line up with another; blind pockets are small and rare.
 *  - **Landmarks are unique.** Never two silos, never three identical columns — "три одинаковые
 *    колонны не ориентир, а ловушка". Each seed draws four distinct shapes from a palette and
 *    puts each one in a different room, so "the ziggurat room" is a sentence that means
 *    something. Difference is shape and place, never colour: there is no colour in this game.
 *
 * Mesh and collider are the same boxes, as before. What the lidar draws is exactly what you bump
 * into — there is no second, prettier version of the room, which is law 2 made structural.
 *
 * The plan (`Hall.plan`) is data, not decoration: rooms, passages and landmarks with names, so
 * the top-down debug view can label them and the HUD can say which landmark you are near.
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

/**
 * The shell is deliberately NOT generated. Its size, its spawn corner and its gate are fixed
 * points every other system was built against — the clutter layout, the pack's spawn spread and
 * a dozen existing keyframes all address this rectangle by coordinate. Generating the *inside*
 * answers M5's question; generating the outside would only invalidate everyone else's frames.
 */
export const HALL: HallLayout = {
  halfX: 34,
  halfZ: 24,
  height: 9,
  wallThickness: 0.5,
  spawn: new THREE.Vector3(-30, 0, -20),
  spawnYawDeg: 35,
};

/** Named places, for the HUD's "nearest landmark" line and for the top-down debug view. */
export interface Landmark {
  readonly name: string;
  readonly x: number;
  readonly z: number;
}

export type LandmarkKind =
  | 'gate'
  | 'spawn'
  | 'silo'
  | 'twin columns'
  | 'ziggurat'
  | 'high rack'
  | 'pipe stack'
  | 'buttress column';

export interface PlannedLandmark extends Landmark {
  readonly kind: LandmarkKind;
  /** How high it stands. Everything here clears the 3 m clutter line by design. */
  readonly top: number;
  /** Footprint radius, metres — also the radius clutter is kept out of. */
  readonly radius: number;
  /** Half-extents of the actual footprint, metres: some of these shapes are long. */
  readonly halfX: number;
  readonly halfZ: number;
  /** Which way the shape is elongated, for the ones that have a direction. */
  readonly axis: Axis;
  readonly room: number;
}

export type Axis = 'x' | 'z';

export type RoomCharacter = 'aisles' | 'crates' | 'pallets' | 'open' | 'pocket';

export interface Room {
  readonly id: number;
  readonly name: string;
  readonly character: RoomCharacter;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly cx: number;
  readonly cz: number;
  readonly area: number;
}

export interface Passage {
  /** The divider this gap is cut in runs at constant `axis`; the gap centre is (x, z). */
  readonly axis: Axis;
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly a: number;
  readonly b: number;
  readonly name: string;
}

export type DividerKind = 'rack' | 'stacks' | 'containers';

export interface Divider {
  readonly axis: Axis;
  /** Position on the split axis. */
  readonly at: number;
  /** Extent along the other axis. */
  readonly from: number;
  readonly to: number;
  readonly thickness: number;
  readonly kind: DividerKind;
  readonly height: number;
  readonly passages: Passage[];
}

/** Result of the walkability flood fill — the generator checking its own work. */
export interface Reachability {
  /** Can you walk from the spawn corner to the gate? */
  readonly gate: boolean;
  /** Rooms whose centre is reachable from the spawn, out of all rooms. */
  readonly roomsReached: number;
  readonly rooms: number;
  /** Fraction of open floor cells the flood fill got to. */
  readonly openFraction: number;
}

export type GateWall = 'west' | 'east' | 'north' | 'south';

/** A small roll-up exit cut into one outer wall of this particular hall. */
export interface PlannedGate {
  /** A clear standing point just inside the opening — this is the gameplay target. */
  readonly x: number;
  readonly z: number;
  /** Which outer wall contains the actual opening. */
  readonly wall: GateWall;
  /** Axis along the wall. */
  readonly axis: Axis;
  /** Centre of the opening on `axis` and its deliberately modest width. */
  readonly at: number;
  readonly opening: number;
  /** Room reached when walking in through the gate. */
  readonly room: number;
}

/**
 * True only for a continuous inside → outside crossing through the open part of the gate.
 *
 * This deliberately takes two positions rather than a distance-to-target. Standing in the
 * threshold is not an exit, and a debug teleport that begins outside cannot accidentally win.
 */
export function crossedGate(
  gate: PlannedGate,
  before: THREE.Vector3,
  after: THREE.Vector3,
  playerRadius: number,
): boolean {
  const wall = gate.wall === 'east' ? HALL.halfX : gate.wall === 'west' ? -HALL.halfX : gate.wall === 'south' ? HALL.halfZ : -HALL.halfZ;
  const normalX = gate.wall === 'east' ? 1 : gate.wall === 'west' ? -1 : 0;
  const normalZ = gate.wall === 'south' ? 1 : gate.wall === 'north' ? -1 : 0;
  const beforeDepth = normalX * (before.x - wall) + normalZ * (before.z - wall);
  const afterDepth = normalX * (after.x - wall) + normalZ * (after.z - wall);
  // `afterDepth > 0` means the body centre actually made it beyond the exterior wall plane.
  if (beforeDepth > 0 || afterDepth <= 0) return false;
  const t = beforeDepth === afterDepth ? 0 : beforeDepth / (beforeDepth - afterDepth);
  const along = gate.axis === 'x' ? before.x + (after.x - before.x) * t : before.z + (after.z - before.z) * t;
  // A capsule centre has to clear the jambs as well. This matches movement collision rather than
  // awarding a win for clipping a shoulder through the wall edge.
  return Math.abs(along - gate.at) <= gate.opening / 2 - playerRadius;
}

export interface HallPlan {
  readonly seed: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly rooms: Room[];
  readonly dividers: Divider[];
  readonly passages: Passage[];
  readonly landmarks: PlannedLandmark[];
  readonly spawn: { x: number; z: number };
  readonly gate: PlannedGate;
  reach: Reachability;
}

/**
 * Live view of the current hall's landmarks. `buildHall` rewrites it in place, so importers
 * (the HUD's "nearest landmark" line) keep working without knowing the hall is generated.
 */
export const LANDMARKS: Landmark[] = [];

interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

// --- generation constants ---------------------------------------------------
/** Smallest room side. Below ~9 m a "room" stops reading as a room and becomes a corridor. */
const MIN_ROOM = 11;
/** Smallest extent across a split, so no room comes out as a slot. */
const MIN_OTHER = 10;
/** How thick a dividing run of racking is. */
const DIVIDER_T = 1.3;
/** Longest room side tolerated. Past this a room reads as a corridor, not a room. */
const MAX_SIDE = 30;
/**
 * The middle of the hall is floor in every seed.
 *
 * Not a design flourish — a contract. Every scenario that is not about the layout (the bite
 * frames in `tools/hud.mjs`, the props scenes, anything that just needs a place to stand) puts
 * the player near the origin and paces him about. One seed that happened to drop a rack run
 * across 2, 2 left him wedged inside static geometry, and a keyframe run three milestones old
 * started failing for a reason that had nothing to do with what it was testing. Eight metres of
 * guaranteed floor in the centre costs one clutter pocket and removes a whole class of that.
 */
const MIDDLE: Rect = { minX: -4, maxX: 4, minZ: -4, maxZ: 4 };

/** Half-length of the clear approach kept either side of every passage. */
const PASSAGE_APPROACH = 3.4;

// ---------------------------------------------------------------------------
// Phase A — the plan. Pure data, no geometry, no THREE. This is what the debug
// view labels and what the report argues about.
// ---------------------------------------------------------------------------

export function generatePlan(seed: number): HallPlan {
  const rng = makeRng((seed ^ 0x5eed12) >>> 0);
  const { halfX, halfZ } = HALL;

  const interior: Rect = { minX: -halfX + 0.4, minZ: -halfZ + 0.4, maxX: halfX - 0.4, maxZ: halfZ - 0.4 };

  interface Leaf {
    rect: Rect;
    dead: boolean;
  }
  const leaves: Leaf[] = [{ rect: interior, dead: false }];
  const dividers: MutableDivider[] = [];
  const target = rangeInt(rng, 6, 9);

  /**
   * Splitting stops at the room target — except for stripes. A leaf 45 m long and 10 m wide is
   * not a room, it is a corridor with the lights off, and a hall made of those answers the
   * milestone's question with "no, everywhere looks the same". So a second pass keeps cutting
   * anything whose long side is over `MAX_SIDE`, target or no target.
   */
  while (leaves.length < target || leaves.some((l) => !l.dead && longSide(l.rect) > MAX_SIDE)) {
    const live = leaves.filter(
      (l) => !l.dead && (leaves.length < target || longSide(l.rect) > MAX_SIDE),
    );
    if (live.length === 0) break;
    // Weighted by area, so the big empty half gets carved before a corner gets carved twice.
    let total = 0;
    for (const l of live) total += area(l.rect);
    let pickV = rng() * total;
    let leaf = live[live.length - 1]!;
    for (const l of live) {
      pickV -= area(l.rect);
      if (pickV <= 0) {
        leaf = l;
        break;
      }
    }
    const split = trySplit(leaf.rect, rng, dividers.length);
    if (split === null) {
      leaf.dead = true;
      continue;
    }
    const index = leaves.indexOf(leaf);
    leaves.splice(index, 1, { rect: split.a, dead: false }, { rect: split.b, dead: false });
    dividers.push(split.divider);
  }

  // --- rooms -------------------------------------------------------------
  const characters = assignCharacters(leaves.map((l) => l.rect), rng);
  const rooms: Room[] = leaves.map((l, i) => ({
    id: i,
    name: '',
    character: characters[i]!,
    minX: l.rect.minX,
    minZ: l.rect.minZ,
    maxX: l.rect.maxX,
    maxZ: l.rect.maxZ,
    cx: (l.rect.minX + l.rect.maxX) / 2,
    cz: (l.rect.minZ + l.rect.maxZ) / 2,
    area: area(l.rect),
  }));
  nameRooms(rooms);

  // --- passages ----------------------------------------------------------
  // Cut after every split is known, so both sides can be named by the rooms that actually
  // ended up there rather than by the halves they were cut from.
  const passages: Passage[] = [];
  for (const d of dividers) {
    for (const gap of cutGaps(d, rng)) {
      const probe = 0.9 + d.thickness / 2;
      const ax = d.axis === 'x' ? d.at - probe : gap;
      const az = d.axis === 'x' ? gap : d.at - probe;
      const bx = d.axis === 'x' ? d.at + probe : gap;
      const bz = d.axis === 'x' ? gap : d.at + probe;
      const a = roomAt(rooms, ax, az);
      const b = roomAt(rooms, bx, bz);
      const p: Passage = {
        axis: d.axis,
        x: d.axis === 'x' ? d.at : gap,
        z: d.axis === 'x' ? gap : d.at,
        width: d.gapWidth,
        a,
        b,
        name: `${short(rooms[a])} – ${short(rooms[b])}`,
      };
      d.passages.push(p);
      passages.push(p);
    }
  }

  // --- landmarks ---------------------------------------------------------
  const gate = placeGate(rooms, dividers, rng);
  const landmarks = placeLandmarks(rooms, passages, gate, rng);

  return {
    seed,
    halfX,
    halfZ,
    rooms,
    dividers,
    passages,
    landmarks,
    spawn: { x: HALL.spawn.x, z: HALL.spawn.z },
    gate,
    reach: { gate: false, roomsReached: 0, rooms: rooms.length, openFraction: 0 },
  };
}

function area(r: Rect): number {
  return (r.maxX - r.minX) * (r.maxZ - r.minZ);
}

function longSide(r: Rect): number {
  return Math.max(r.maxX - r.minX, r.maxZ - r.minZ);
}

/** A divider under construction carries the gap width its passages will be cut at. */
interface MutableDivider extends Divider {
  gapWidth: number;
}

function trySplit(
  rect: Rect,
  rng: Rng,
  index: number,
): { a: Rect; b: Rect; divider: MutableDivider } | null {
  const w = rect.maxX - rect.minX;
  const d = rect.maxZ - rect.minZ;
  let axes: Axis[] = w >= d ? ['x', 'z'] : ['z', 'x'];
  // Occasionally split the short way, so the hall does not come out as a stack of stripes.
  if (rng() < 0.22) axes = [axes[1]!, axes[0]!];

  for (const axis of axes) {
    const lo = axis === 'x' ? rect.minX : rect.minZ;
    const hi = axis === 'x' ? rect.maxX : rect.maxZ;
    const other = axis === 'x' ? d : w;
    const span = hi - lo;
    if (other < MIN_OTHER) continue;
    const loCut = lo + MIN_ROOM + DIVIDER_T / 2;
    const hiCut = hi - MIN_ROOM - DIVIDER_T / 2;
    if (hiCut - loCut < 0.5) continue;
    const at = Math.round(range(rng, loCut, hiCut) * 4) / 4;
    const a: Rect = { ...rect };
    const b: Rect = { ...rect };
    if (axis === 'x') {
      a.maxX = at - DIVIDER_T / 2;
      b.minX = at + DIVIDER_T / 2;
    } else {
      a.maxZ = at - DIVIDER_T / 2;
      b.minZ = at + DIVIDER_T / 2;
    }
    const kinds: DividerKind[] = ['rack', 'stacks', 'containers'];
    const kind = kinds[(index + (rng() < 0.4 ? 1 : 0)) % kinds.length]!;
    const divider: MutableDivider = {
      axis,
      at,
      from: axis === 'x' ? rect.minZ : rect.minX,
      to: axis === 'x' ? rect.maxZ : rect.maxX,
      thickness: DIVIDER_T,
      kind,
      height: kind === 'rack' ? range(rng, 2.6, 3.0) : kind === 'containers' ? range(rng, 2.3, 2.6) : range(rng, 1.9, 2.4),
      gapWidth: 0,
      passages: [],
    };
    // Span is unused after this point, but a zero-length divider would mean a split that did
    // not divide anything, which is a bug worth failing loudly on.
    if (divider.to - divider.from < 2 || span <= 0) continue;
    return { a, b, divider };
  }
  return null;
}

/** Where a divider is opened. One or two wide gaps — a warehouse, not a maze. */
function cutGaps(d: MutableDivider, rng: Rng): number[] {
  const length = d.to - d.from;
  const n = length > 26 ? (rng() < 0.7 ? 3 : 2) : length > 15 ? 2 : 1;
  d.gapWidth = Math.round(range(rng, 2.8, 3.8) * 10) / 10;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = d.from + (length * i) / n;
    const hi = d.from + (length * (i + 1)) / n;
    let c = range(rng, lo + d.gapWidth, hi - d.gapWidth);
    c = Math.min(d.to - d.gapWidth / 2 - 1.2, Math.max(d.from + d.gapWidth / 2 + 1.2, c));
    out.push(Math.round(c * 4) / 4);
  }
  return out;
}

function roomAt(rooms: Room[], x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (const r of rooms) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return r.id;
    const dx = Math.max(r.minX - x, 0, x - r.maxX);
    const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
    const dist = Math.hypot(dx, dz);
    if (dist < bestD) {
      bestD = dist;
      best = r.id;
    }
  }
  return best;
}

function assignCharacters(rects: Rect[], rng: Rng): RoomCharacter[] {
  const order = rects.map((r, i) => ({ i, a: area(r), short: Math.min(r.maxX - r.minX, r.maxZ - r.minZ) }));
  order.sort((p, q) => q.a - p.a);
  const out: RoomCharacter[] = new Array(rects.length).fill('crates');
  let aisles = 0;
  let open = 0;
  for (let k = 0; k < order.length; k++) {
    const e = order[k]!;
    if (e.a < 150 || e.short < 11) {
      out[e.i] = 'pocket';
      continue;
    }
    // The two biggest rooms carry the corridor feel; exactly one room is left nearly empty,
    // because a room with nothing in it is information too — it is the only place a scan comes
    // back with a flat far wall and nothing between.
    if (aisles < 2 && k < 3) {
      out[e.i] = 'aisles';
      aisles++;
      continue;
    }
    if (open === 0 && k >= 1 && rng() < 0.55) {
      out[e.i] = 'open';
      open++;
      continue;
    }
    out[e.i] = rng() < 0.45 ? 'pallets' : rng() < 0.7 ? 'crates' : 'aisles';
  }
  if (open === 0) out[order[order.length - 1]!.i] = 'open';
  return out;
}

const NOUNS: Record<RoomCharacter, string> = {
  aisles: 'aisles',
  crates: 'crate field',
  pallets: 'pallet floor',
  open: 'open floor',
  pocket: 'pocket',
};

function compass(x: number, z: number): string {
  const ns = z < -8 ? 'north' : z > 8 ? 'south' : '';
  const ew = x < -10 ? 'west' : x > 10 ? 'east' : '';
  if (ns === '' && ew === '') return 'central';
  return [ns, ew].filter((s) => s !== '').join('-');
}

function nameRooms(rooms: Room[]): void {
  const used = new Map<string, number>();
  for (const r of rooms) {
    const base = `${compass(r.cx, r.cz)} ${NOUNS[r.character]}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    (r as { name: string }).name = n === 1 ? base : `${base} ${'I'.repeat(n)}`;
  }
}

function short(r: Room | undefined): string {
  if (r === undefined) return '?';
  return r.name.split(' ')[0]!;
}

/**
 * Pick an outer-wall exit after the partition is known.  A gate is intentionally not a fixed
 * compass landmark: it moves from run to run, is only a 3.2 m opening, and has to sit behind at
 * least one uninterrupted divider from the spawn corner.  The latter is checked in plan space,
 * before clutter is generated, so a lucky sparse room cannot turn the exit into the first ping's
 * obvious answer.
 */
function placeGate(rooms: Room[], dividers: Divider[], rng: Rng): PlannedGate {
  const opening = 3.2;
  const inset = 1.25;
  const candidates: PlannedGate[] = [];
  const add = (wall: GateWall, at: number): void => {
    const axis: Axis = wall === 'west' || wall === 'east' ? 'z' : 'x';
    const wallX = wall === 'west' ? -HALL.halfX : wall === 'east' ? HALL.halfX : at;
    const wallZ = wall === 'north' ? -HALL.halfZ : wall === 'south' ? HALL.halfZ : at;
    const x = wall === 'west' ? wallX + inset : wall === 'east' ? wallX - inset : at;
    const z = wall === 'north' ? wallZ + inset : wall === 'south' ? wallZ - inset : at;
    if (Math.hypot(x - HALL.spawn.x, z - HALL.spawn.z) < 30) return;
    if (!dividerBlocksSpawn(HALL.spawn.x, HALL.spawn.z, x, z, dividers)) return;
    candidates.push({ x, z, wall, axis, at, opening, room: roomAt(rooms, x, z) });
  };

  // Several points per far wall give the seed a meaningful choice while preserving generous
  // jamb clearance at the corners. East/north are deliberately favoured: the start is southwest.
  for (const at of [-15, -7.5, 0, 7.5, 15]) add('east', at);
  for (const at of [-24, -12, 0, 12, 24]) add('north', at);
  for (const at of [-15, -7.5, 0, 7.5, 15]) add('south', at);
  for (const at of [-12, 0, 12]) add('west', at);

  // Every practical seed has an occluded candidate. Keep this fallback deterministic and still
  // far from spawn should a future partition algorithm temporarily fail that stronger contract.
  if (candidates.length === 0) {
    return { x: HALL.halfX - inset, z: 12, wall: 'east', axis: 'z', at: 12, opening, room: roomAt(rooms, HALL.halfX - inset, 12) };
  }
  return candidates[Math.floor(rng() * candidates.length)]!;
}

/** True when the spawn-to-target segment crosses solid divider material rather than one of its gaps. */
function dividerBlocksSpawn(sx: number, sz: number, tx: number, tz: number, dividers: Divider[]): boolean {
  for (const d of dividers) {
    const delta = d.axis === 'x' ? tx - sx : tz - sz;
    if (Math.abs(delta) < 0.001) continue;
    const t = (d.at - (d.axis === 'x' ? sx : sz)) / delta;
    if (t <= 0.04 || t >= 0.96) continue;
    const along = d.axis === 'x' ? sz + (tz - sz) * t : sx + (tx - sx) * t;
    if (along < d.from || along > d.to) continue;
    if (d.passages.some((p) => Math.abs((d.axis === 'x' ? p.z : p.x) - along) <= p.width / 2)) continue;
    return true;
  }
  return false;
}

/**
 * Four distinct shapes, four different rooms, spread apart.
 *
 * Uniqueness is the whole point: with two silos in one hall, "I am at the silo" stops being a
 * fact about where you are. The palette is shuffled per seed, so which shapes a hall has is
 * itself part of that hall's identity.
 */
function placeLandmarks(rooms: Room[], passages: Passage[], gate: PlannedGate, rng: Rng): PlannedLandmark[] {
  const palette: LandmarkKind[] = ['silo', 'twin columns', 'ziggurat', 'high rack', 'pipe stack', 'buttress column'];
  // Fisher-Yates on a copy: seeded, so which shapes this hall has is part of its identity.
  for (let i = palette.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = palette[i]!;
    palette[i] = palette[j]!;
    palette[j] = t;
  }

  /** Footprint of each shape as half-extents along and across its own long axis. */
  const spec: Record<LandmarkKind, { top: number; long: number; across: number }> = {
    gate: { top: 9, long: 1.4, across: 1.2 },
    spawn: { top: 0, long: 0, across: 0 },
    silo: { top: 6.6, long: 3.4, across: 3.4 },
    'twin columns': { top: 9, long: 3.3, across: 1.3 },
    ziggurat: { top: 6.2, long: 3.2, across: 3.2 },
    'high rack': { top: 6, long: 7.8, across: 1.8 },
    'pipe stack': { top: 5.6, long: 4.3, across: 2.0 },
    'buttress column': { top: 9, long: 4.1, across: 1.6 },
  };

  // Places nothing tall may stand: the spawn corner, the gate run, and every passage approach.
  // A 15 m rack run dropped across a doorway would seal a room, and the flood fill would only
  // tell us afterwards.
  const reserved: Rect[] = [
    { minX: HALL.spawn.x - 6, maxX: HALL.spawn.x + 6, minZ: HALL.spawn.z - 6, maxZ: HALL.spawn.z + 6 },
    gate.axis === 'z'
      ? { minX: gate.x - 5, maxX: gate.x + 2, minZ: gate.at - gate.opening, maxZ: gate.at + gate.opening }
      : { minX: gate.at - gate.opening, maxX: gate.at + gate.opening, minZ: gate.z - 5, maxZ: gate.z + 2 },
    MIDDLE,
  ];
  for (const p of passages) {
    const half = p.width / 2 + 1.2;
    reserved.push(
      p.axis === 'x'
        ? { minX: p.x - PASSAGE_APPROACH, maxX: p.x + PASSAGE_APPROACH, minZ: p.z - half, maxZ: p.z + half }
        : { minX: p.x - half, maxX: p.x + half, minZ: p.z - PASSAGE_APPROACH, maxZ: p.z + PASSAGE_APPROACH },
    );
  }
  const clashes = (r: Rect): boolean =>
    reserved.some((k) => r.minX < k.maxX && r.maxX > k.minX && r.minZ < k.maxZ && r.maxZ > k.minZ);

  const out: PlannedLandmark[] = [];
  const candidates = rooms.filter((r) => Math.min(r.maxX - r.minX, r.maxZ - r.minZ) >= 9).sort((a, b) => b.area - a.area);
  let cursor = 0;
  for (const room of candidates) {
    if (out.length >= 4) break;
    // Never on the spawn corner: the first thing the player must do is walk somewhere to find a
    // landmark, not trip over one on the way out of bed.
    if (Math.hypot(room.cx - HALL.spawn.x, room.cz - HALL.spawn.z) < 12) continue;
    if (out.some((l) => Math.hypot(l.x - room.cx, l.z - room.cz) < 15)) continue;

    const axis: Axis = room.maxX - room.minX >= room.maxZ - room.minZ ? 'x' : 'z';
    // Try the kinds in shuffled order until one both fits the room and misses everything
    // reserved; a room that can take nothing is simply left without a landmark.
    let placed: PlannedLandmark | null = null;
    for (let k = 0; k < palette.length && placed === null; k++) {
      const kind = palette[(cursor + k) % palette.length]!;
      // Never the same shape twice in one hall: two identical ziggurats are worse than one,
      // because the player who recognises the second one is now confidently in the wrong room.
      if (out.some((l) => l.kind === kind)) continue;
      const s = spec[kind]!;
      const hx = axis === 'x' ? s.long : s.across;
      const hz = axis === 'x' ? s.across : s.long;
      const roomX = (room.maxX - room.minX) / 2 - hx - 1.5;
      const roomZ = (room.maxZ - room.minZ) / 2 - hz - 1.5;
      if (roomX < 0 || roomZ < 0) continue;
      for (let attempt = 0; attempt < 10 && placed === null; attempt++) {
        const shrink = 1 - attempt / 12;
        const x = Math.round((room.cx + range(rng, -roomX, roomX) * shrink) * 4) / 4;
        const z = Math.round((room.cz + range(rng, -roomZ, roomZ) * shrink) * 4) / 4;
        const foot: Rect = { minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz };
        if (clashes(foot)) continue;
        placed = {
          name: `${kind} (${compass(x, z)})`,
          kind,
          x,
          z,
          top: s.top,
          radius: Math.max(hx, hz),
          halfX: hx,
          halfZ: hz,
          axis,
          room: room.id,
        };
        cursor += k + 1;
      }
    }
    if (placed !== null) out.push(placed);
  }

  out.push({
    name: 'the gate',
    kind: 'gate',
    x: gate.x,
    z: gate.z,
    // It is a small roll-up door, not a ninth-metre beacon: lidar can catch its frame nearby,
    // but cannot use it as a global landmark.
    top: 4.8,
    radius: gate.opening / 2,
    halfX: gate.axis === 'x' ? gate.opening / 2 : 0.45,
    halfZ: gate.axis === 'z' ? gate.opening / 2 : 0.45,
    axis: gate.axis,
    room: gate.room,
  });
  out.push({
    name: 'spawn corner',
    kind: 'spawn',
    x: HALL.spawn.x,
    z: HALL.spawn.z,
    top: 0,
    radius: 0,
    halfX: 0,
    halfZ: 0,
    axis: 'x',
    room: roomAt(rooms, HALL.spawn.x, HALL.spawn.z),
  });
  return out;
}

// ---------------------------------------------------------------------------
// Phase B — geometry. Every solid is a box; mesh and collider are the same box.
// ---------------------------------------------------------------------------

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

class Builder {
  readonly group = new THREE.Group();
  /**
   * Every solid in the hall is a box, so the lights-on view is four instanced draws rather than
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
  /** Rooms, passages and landmarks with names — what the top-down debug view labels. */
  readonly plan: HallPlan;
  /** Debug only: drop the ceiling so the top-down camera can see the floor plan. */
  setRoofVisible(on: boolean): void;
  dispose(): void;
}

/** Rectangles nothing may be built in: passage approaches, the spawn corner, the gate run. */
interface KeepOut extends Rect {
  readonly why: string;
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
  const plan = generatePlan(seed);
  const rng = makeRng((seed ^ 0x1f0b) >>> 0);

  const { halfX, halfZ, height, wallThickness: t } = HALL;

  // --- shell -------------------------------------------------------------
  b.bounds(-halfX - t, -1, -halfZ - t, halfX + t, 0, halfZ + t, 'shell');
  b.bounds(-halfX - t, height, -halfZ - t, halfX + t, height + t, halfZ + t, 'roof');
  buildShellWithGate(b, plan.gate, halfX, halfZ, height, t);

  // --- keep-outs ---------------------------------------------------------
  const keep: KeepOut[] = [];
  for (const p of plan.passages) {
    const half = p.width / 2 + 0.4;
    if (p.axis === 'x') {
      keep.push({ minX: p.x - PASSAGE_APPROACH, maxX: p.x + PASSAGE_APPROACH, minZ: p.z - half, maxZ: p.z + half, why: 'passage' });
    } else {
      keep.push({ minX: p.x - half, maxX: p.x + half, minZ: p.z - PASSAGE_APPROACH, maxZ: p.z + PASSAGE_APPROACH, why: 'passage' });
    }
  }
  // The spawn corner: the player must not wake up inside a shelf.
  keep.push({ minX: HALL.spawn.x - 4, maxX: HALL.spawn.x + 4, minZ: HALL.spawn.z - 4, maxZ: HALL.spawn.z + 4, why: 'spawn' });
  // The middle of the hall: floor, in every seed. See MIDDLE.
  keep.push({ ...MIDDLE, why: 'middle' });
  // The gate approach, so the generated exit stays walkable-to from its room.
  keep.push(gateKeepOut(plan.gate));
  for (const l of plan.landmarks) {
    if (l.radius <= 0) continue;
    keep.push({
      minX: l.x - l.halfX - 0.8,
      maxX: l.x + l.halfX + 0.8,
      minZ: l.z - l.halfZ - 0.8,
      maxZ: l.z + l.halfZ + 0.8,
      why: 'landmark',
    });
  }

  const blocked = (x: number, z: number, r = 0): boolean =>
    keep.some((k) => x + r > k.minX && x - r < k.maxX && z + r > k.minZ && z - r < k.maxZ);

  // --- dividers ----------------------------------------------------------
  for (const d of plan.dividers) buildDivider(b, rng, d, keep);

  // --- rooms -------------------------------------------------------------
  for (const room of plan.rooms) fillRoom(b, rng, room, blocked);

  // --- landmarks ---------------------------------------------------------
  for (const l of plan.landmarks) buildLandmark(b, rng, l);

  b.finish();

  plan.reach = walkability(world, plan);

  LANDMARKS.length = 0;
  for (const l of plan.landmarks) LANDMARKS.push({ name: l.name, x: l.x, z: l.z });

  return {
    reveal: b.group,
    setRoofVisible: (on: boolean) => {
      if (b.roof !== null) b.roof.visible = on;
    },
    world,
    layout: HALL,
    boxCount: b.boxCount,
    plan,
    dispose(): void {
      b.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
  };
}

/** A wall with one genuine opening; its collider and lidar mesh are built from the same boxes. */
function buildShellWithGate(
  b: Builder,
  gate: PlannedGate,
  halfX: number,
  halfZ: number,
  height: number,
  thickness: number,
): void {
  const wall = (which: GateWall): void => {
    const isGate = which === gate.wall;
    const axis: Axis = which === 'west' || which === 'east' ? 'z' : 'x';
    const fixed = which === 'west' ? -halfX : which === 'east' ? halfX : which === 'north' ? -halfZ : halfZ;
    const from = axis === 'z' ? -halfZ - thickness : -halfX;
    const to = axis === 'z' ? halfZ + thickness : halfX;
    const openingLo = gate.at - gate.opening / 2;
    const openingHi = gate.at + gate.opening / 2;
    const segment = (lo: number, hi: number, minY = 0, maxY = height): void => {
      if (hi <= lo) return;
      if (axis === 'z') b.bounds(fixed, minY, lo, fixed + thickness, maxY, hi, 'shell');
      else b.bounds(lo, minY, fixed, hi, maxY, fixed + thickness, 'shell');
    };
    if (!isGate) {
      segment(from, to);
      return;
    }
    // Narrow opening and a low lintel: it reads only once you are in its room, instead of
    // becoming the hall's tallest, easiest lidar landmark.
    segment(from, openingLo);
    segment(openingHi, to);
    segment(openingLo, openingHi, 3.35, height);
  };
  wall('west');
  wall('east');
  wall('north');
  wall('south');
}

function gateKeepOut(gate: PlannedGate): KeepOut {
  return gate.axis === 'z'
    ? { minX: gate.x - 5, maxX: gate.x + 2, minZ: gate.at - gate.opening / 2 - 1.2, maxZ: gate.at + gate.opening / 2 + 1.2, why: 'gate' }
    : { minX: gate.at - gate.opening / 2 - 1.2, maxX: gate.at + gate.opening / 2 + 1.2, minZ: gate.z - 5, maxZ: gate.z + 2, why: 'gate' };
}

/** Intervals of `[from, to]` left over once every keep-out crossing the run is subtracted. */
function openSegments(
  from: number,
  to: number,
  cuts: Array<[number, number]>,
  minLength = 1.2,
): Array<[number, number]> {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  let cursor = from;
  for (const [lo, hi] of sorted) {
    if (hi <= cursor) continue;
    if (lo > cursor && lo - cursor >= minLength) out.push([cursor, Math.min(lo, to)]);
    cursor = Math.max(cursor, hi);
    if (cursor >= to) break;
  }
  if (to - cursor >= minLength) out.push([cursor, to]);
  return out.filter(([lo, hi]) => hi - lo >= minLength);
}

/** Keep-outs that cross a run of thickness `th` at `at`, as intervals on the run's own axis. */
function cutsAcross(keep: KeepOut[], axis: Axis, at: number, th: number): Array<[number, number]> {
  const half = th / 2 + 0.35;
  const out: Array<[number, number]> = [];
  for (const k of keep) {
    if (axis === 'x') {
      if (at + half > k.minX && at - half < k.maxX) out.push([k.minZ, k.maxZ]);
    } else {
      if (at + half > k.minZ && at - half < k.maxZ) out.push([k.minX, k.maxX]);
    }
  }
  return out;
}

/**
 * A dividing run: the thing that turns "a field with junk in it" into rooms. It has to be tall
 * enough that you cannot see over it with the lidar (>= 1.9 m) and solid enough that you cannot
 * see through it, otherwise the hall reads as one space again and the whole milestone is moot.
 */
function buildDivider(b: Builder, rng: Rng, d: Divider, keep: KeepOut[]): void {
  const cuts = cutsAcross(keep, d.axis, d.at, d.thickness);
  for (const p of d.passages) {
    const c = d.axis === 'x' ? p.z : p.x;
    cuts.push([c - p.width / 2, c + p.width / 2]);
  }
  for (const [lo, hi] of openSegments(d.from, d.to, cuts, 1.4)) {
    if (d.kind === 'rack') rackRun(b, rng, d.axis, d.at, lo, hi, d.height, d.thickness);
    else if (d.kind === 'containers') containerRun(b, rng, d.axis, d.at, lo, hi, d.height, d.thickness);
    else stackRun(b, rng, d.axis, d.at, lo, hi, d.height, d.thickness);
  }
}

/** Axis-generic box: `at` on the split axis, `c` along the run. */
function along(
  b: Builder,
  axis: Axis,
  at: number,
  c: number,
  baseY: number,
  th: number,
  sy: number,
  len: number,
  kind: 'prop' | 'landmark' | 'shell' = 'prop',
): void {
  if (axis === 'x') b.box(at, baseY, c, th, sy, len, kind);
  else b.box(c, baseY, at, len, sy, th, kind);
}

/** A shelf run: uprights every bay plus three decks. Opaque enough to hide behind. */
function rackRun(
  b: Builder,
  rng: Rng,
  axis: Axis,
  at: number,
  from: number,
  to: number,
  height: number,
  depth: number,
): void {
  const length = to - from;
  const bays = Math.max(1, Math.round(length / 2.6));
  const bay = length / bays;
  for (let i = 0; i <= bays; i++) {
    along(b, axis, at, from + i * bay, 0, depth, height, 0.2);
  }
  for (const deck of [0.3, height * 0.55, height - 0.25]) {
    along(b, axis, at, (from + to) / 2, deck, depth, 0.12, length);
  }
  // Half the bays carry a crate, so the run is not a perfect repeat and you can tell one
  // stretch of aisle from another.
  for (let i = 0; i < bays; i++) {
    if (rng() < 0.5) continue;
    const c = from + (i + 0.5) * bay;
    const sy = range(rng, 0.5, 0.9);
    const deck = rng() < 0.5 ? 0.42 : height * 0.55 + 0.12;
    const w = range(rng, 0.6, 0.95);
    if (axis === 'x') b.box(at + range(rng, -0.15, 0.15), deck, c, w, sy, w);
    else b.box(c, deck, at + range(rng, -0.15, 0.15), w, sy, w);
  }
}

/** A row of shipping containers: long solid blocks with narrow slots between them. */
function containerRun(
  b: Builder,
  rng: Rng,
  axis: Axis,
  at: number,
  from: number,
  to: number,
  height: number,
  depth: number,
): void {
  let c = from;
  while (to - c > 1.6) {
    const len = Math.min(to - c, range(rng, 2.4, 5.2));
    const h = height * range(rng, 0.85, 1.05);
    along(b, axis, at, c + len / 2, 0, depth, h, len);
    // Every so often one is double-stacked: a silhouette you can pick out from across the hall.
    if (rng() < 0.22) along(b, axis, at, c + len / 2, h, depth * 0.9, h * 0.85, len * 0.9);
    c += len + range(rng, 0.15, 0.5);
  }
}

/** A bank of pallet stacks: lumpier than racking, same job — you cannot see over it. */
function stackRun(
  b: Builder,
  rng: Rng,
  axis: Axis,
  at: number,
  from: number,
  to: number,
  height: number,
  depth: number,
): void {
  let c = from;
  while (to - c > 1.0) {
    const len = Math.min(to - c, range(rng, 1.1, 2.0));
    let y = 0;
    let w = depth;
    while (y < height) {
      const h = range(rng, 0.45, 0.8);
      along(b, axis, at + range(rng, -0.1, 0.1), c + len / 2, y, w, h, len * range(rng, 0.85, 1));
      y += h;
      w *= range(rng, 0.86, 1);
    }
    c += len + range(rng, 0.05, 0.35);
  }
}

/**
 * What is inside a room. The character is the whole reason a room is recognisable: an aisle
 * room and a pallet floor feel different on the lidar within one ping, and that difference is
 * what "I have been here before" is actually made of.
 */
function fillRoom(
  b: Builder,
  rng: Rng,
  room: Room,
  blocked: (x: number, z: number, r?: number) => boolean,
): void {
  const w = room.maxX - room.minX;
  const d = room.maxZ - room.minZ;
  const inset = 1.2;
  switch (room.character) {
    case 'aisles': {
      // Rows along the room's long axis, with a cross-aisle left at one end.
      const axis: Axis = w >= d ? 'z' : 'x'; // rows are walls at constant z (running along x) …
      const acrossLo = (axis === 'x' ? room.minX : room.minZ) + inset + 1.5;
      const acrossHi = (axis === 'x' ? room.maxX : room.maxZ) - inset - 1.5;
      const runLo = (axis === 'x' ? room.minZ : room.minX) + inset;
      const runHi = (axis === 'x' ? room.maxZ : room.maxX) - inset;
      const spacing = range(rng, 3.3, 4.0);
      const rows = Math.max(1, Math.floor((acrossHi - acrossLo) / spacing));
      const start = acrossLo + ((acrossHi - acrossLo) - (rows - 1) * spacing) / 2;
      for (let i = 0; i < rows; i++) {
        const at = Math.round((start + i * spacing) * 4) / 4;
        // Every row is shortened at one end, alternating sides: that is the cross aisle, and it
        // is what stops the room being a set of sealed slots.
        const trim = range(rng, 2.5, 5.5);
        const lo = i % 2 === 0 ? runLo : runLo + trim;
        const hi = i % 2 === 0 ? runHi - trim : runHi;
        const cuts: Array<[number, number]> = [];
        // Rows respect the same keep-outs everything else does, by sampling the run.
        for (let s = lo; s <= hi; s += 0.5) {
          const x = axis === 'x' ? at : s;
          const z = axis === 'x' ? s : at;
          if (blocked(x, z, 0.7)) cuts.push([s - 0.6, s + 0.6]);
        }
        for (const [segLo, segHi] of openSegments(lo, hi, cuts, 2.0)) {
          rackRun(b, rng, axis, at, segLo, segHi, range(rng, 2.2, 2.7), 1.0);
        }
      }
      break;
    }
    case 'crates':
      scatterCrates(b, rng, room, blocked, Math.round(area(room) / 5.5), 0.35, 0.85);
      break;
    case 'pallets':
      scatterCrates(b, rng, room, blocked, Math.round(area(room) / 7), 0.3, 0.55);
      break;
    case 'pocket': {
      // A dead-end pocket with one big pile in it: small, memorable, and a bad place to be.
      const cx = room.cx + range(rng, -1.5, 1.5);
      const cz = room.cz + range(rng, -1.5, 1.5);
      if (!blocked(cx, cz, 2.2)) {
        let y = 0;
        let s = range(rng, 2.4, 3.2);
        while (y < 2.6) {
          const h = range(rng, 0.6, 0.9);
          b.box(cx, y, cz, s, h, s * range(rng, 0.8, 1.1));
          y += h;
          s *= range(rng, 0.75, 0.92);
        }
      }
      scatterCrates(b, rng, room, blocked, Math.round(area(room) / 9), 0.35, 0.8);
      break;
    }
    case 'open':
      // Deliberately almost empty. A room with nothing in it is information too.
      scatterCrates(b, rng, room, blocked, Math.round(area(room) / 26), 0.4, 1.0);
      break;
  }
}

/**
 * Loose clutter inside a room. Rejection-sampled against what is already claimed, so crates do
 * not interpenetrate — the lidar unlocks every face of a solid it hears, and boxes buried inside
 * each other would surface geometry that is not visible from anywhere.
 */
function scatterCrates(
  b: Builder,
  rng: Rng,
  room: Room,
  blocked: (x: number, z: number, r?: number) => boolean,
  attempts: number,
  hMin: number,
  hMax: number,
): void {
  const taken: Array<[number, number, number, number]> = [];
  const inset = 1.0;
  for (let n = 0; n < attempts; n++) {
    const w = range(rng, 0.5, 1.4);
    const d = range(rng, 0.5, 1.4);
    const x = range(rng, room.minX + inset + w, room.maxX - inset - w);
    const z = range(rng, room.minZ + inset + d, room.maxZ - inset - d);
    if (blocked(x, z, Math.max(w, d) / 2 + 0.3)) continue;
    let clash = false;
    for (const [tx, tz, tw, td] of taken) {
      if (Math.abs(x - tx) < (w + tw) / 2 + 0.35 && Math.abs(z - tz) < (d + td) / 2 + 0.35) {
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
      const h = range(rng, hMin, hMax);
      b.box(x, y, z, sw, h, sd);
      y += h;
      sw *= range(rng, 0.7, 0.95);
      sd *= range(rng, 0.7, 0.95);
      if (rng() < 0.35) break;
    }
  }
}

/** The things that stick out above the clutter. Each shape appears at most once per hall. */
function buildLandmark(b: Builder, rng: Rng, l: PlannedLandmark): void {
  const long: Axis = l.axis;
  switch (l.kind) {
    case 'silo':
      b.silo(l.x, l.z, l.radius - 0.2, 0, l.top, 9);
      // A skirt at the base: what the hand and the low lidar cone meet first.
      b.box(l.x, 0, l.z, l.radius * 2 + 0.6, 0.4, l.radius * 2 + 0.6, 'landmark');
      break;
    case 'twin columns': {
      // Two full-height columns with a lintel across: a gateway shape, unmistakable in profile.
      const off = 2.2;
      for (const s of [-1, 1]) {
        const x = long === 'x' ? l.x + s * off : l.x;
        const z = long === 'x' ? l.z : l.z + s * off;
        b.box(x, 0, z, 1.4, HALL.height, 1.4, 'landmark');
        b.box(x, 0, z, 2.2, 0.5, 2.2, 'landmark');
      }
      along(b, long, long === 'x' ? l.z : l.x, l.x === 0 ? 0 : long === 'x' ? l.x : l.z, 4.6, 1.0, 0.9, off * 2 + 1.4, 'landmark');
      break;
    }
    case 'ziggurat': {
      // A stepped tower. Reads as steps from the side and as concentric squares from above —
      // the one landmark you can identify from a single ping straight up the middle of it.
      let y = 0;
      let s = l.radius * 2;
      for (let i = 0; i < 5; i++) {
        const h = 1.25;
        b.box(l.x, y, l.z, s, h, s, 'landmark');
        y += h;
        s *= 0.78;
      }
      break;
    }
    case 'high rack': {
      // A single 6 m rack run: a landmark that is also a wall.
      const len = 15;
      const c = long === 'x' ? l.x : l.z;
      const at = long === 'x' ? l.z : l.x;
      along(b, long === 'x' ? 'z' : 'x', at, c, 0, 1.4, 6, len, 'landmark');
      for (let k = -len / 2 + 1.5; k < len / 2; k += 3.2) {
        for (const deck of [0, 2.2, 4.3]) {
          if (long === 'x') b.box(l.x + k, deck, l.z, 2.4, 0.35, 3.0);
          else b.box(l.x, deck, l.z + k, 3.0, 0.35, 2.4);
        }
      }
      break;
    }
    case 'pipe stack': {
      // A pyramid of pipes on a cradle. Low and long where everything else is tall and thin.
      const len = 8;
      // The cradle is chest-high on purpose: the pipes themselves are the low, long silhouette,
      // but the whole thing still has to clear the clutter or it is not a landmark.
      const cradle = 2.4;
      b.box(l.x, 0, l.z, long === 'x' ? len : 3.4, cradle, long === 'x' ? 3.4 : len, 'landmark');
      let y = cradle;
      for (let row = 4; row >= 1; row--) {
        for (let i = 0; i < row; i++) {
          const off = (i - (row - 1) / 2) * 0.9;
          const x = long === 'x' ? l.x : l.x + off;
          const z = long === 'x' ? l.z + off : l.z;
          b.box(x, y, z, long === 'x' ? len : 0.8, 0.8, long === 'x' ? 0.8 : len, 'landmark');
        }
        y += 0.8;
      }
      break;
    }
    case 'buttress column': {
      // One column with a wing: asymmetric, so it tells you which way you are facing.
      b.box(l.x, 0, l.z, 1.6, HALL.height, 1.6, 'landmark');
      b.box(l.x, 4.2, l.z, 2.8, 0.7, 2.8, 'landmark'); // flared cap, well above the clutter
      const dir = rng() < 0.5 ? -1 : 1;
      if (long === 'x') b.box(l.x + dir * 2.2, 0, l.z, 3.2, 2.4, 0.9, 'landmark');
      else b.box(l.x, 0, l.z + dir * 2.2, 0.9, 2.4, 3.2, 'landmark');
      break;
    }
    default:
      break; // the gate is part of the shell; the spawn corner is a name, not a thing
  }
}

/**
 * The generator checking its own work: can you actually walk this hall?
 *
 * A layout that looks like a warehouse from above and seals a room off behind a rack is worse
 * than no generator at all — the human would spend an evening deciding the lidar was at fault.
 * So the floor is rasterised at 25 cm, everything knee-high and above is an obstacle, and the
 * flood fill starts at the spawn corner. Cheap (about 50k cells) and run at build time.
 */
function walkability(world: StaticWorld, plan: HallPlan): Reachability {
  const cell = 0.25;
  const { halfX, halfZ } = HALL;
  const nx = Math.ceil((halfX * 2) / cell);
  const nz = Math.ceil((halfZ * 2) / cell);
  const solid = new Uint8Array(nx * nz);
  const toI = (x: number) => Math.floor((x + halfX) / cell);
  const toK = (z: number) => Math.floor((z + halfZ) / cell);

  for (const box of world.boxes) {
    // Anything you can step over (a 0.4 m riser) does not stop you; anything starting above head
    // height does not either — a shelf deck at 2.5 m is walked under.
    if (box.maxY <= 0.42 || box.minY > 1.7) continue;
    const i0 = Math.max(0, toI(box.minX));
    const i1 = Math.min(nx - 1, toI(box.maxX));
    const k0 = Math.max(0, toK(box.minZ));
    const k1 = Math.min(nz - 1, toK(box.maxZ));
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) solid[k * nx + i] = 1;
    }
  }

  const seen = new Uint8Array(nx * nz);
  const stack: number[] = [];
  const start = toK(plan.spawn.z) * nx + toI(plan.spawn.x);
  if (solid[start] === 0) {
    stack.push(start);
    seen[start] = 1;
  }
  let reached = 0;
  while (stack.length > 0) {
    const c = stack.pop()!;
    reached++;
    const i = c % nx;
    const k = (c - i) / nx;
    const neighbours = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, k > 0 ? c - nx : -1, k < nz - 1 ? c + nx : -1];
    for (const n of neighbours) {
      if (n < 0 || seen[n] === 1 || solid[n] === 1) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }

  let open = 0;
  for (let c = 0; c < solid.length; c++) if (solid[c] === 0) open++;

  const at = (x: number, z: number): boolean => {
    // A landmark or a pile may sit on the exact point asked about; accept anything reachable
    // within two metres of it — the question is "can you stand there", not "is this cell free".
    for (let dz = -8; dz <= 8; dz++) {
      for (let dx = -8; dx <= 8; dx++) {
        const i = toI(x) + dx;
        const k = toK(z) + dz;
        if (i < 0 || k < 0 || i >= nx || k >= nz) continue;
        if (seen[k * nx + i] === 1) return true;
      }
    }
    return false;
  };

  /**
   * A room counts as reached when nearly all of its own walkable floor is reachable from spawn.
   * Testing the centre alone is the wrong question — a landmark legitimately stands on some room
   * centres — while "is this room's floor connected to the rest of the hall" is exactly the
   * failure this check exists to catch.
   */
  let roomsReached = 0;
  for (const r of plan.rooms) {
    let roomOpen = 0;
    let roomSeen = 0;
    const i0 = Math.max(0, toI(r.minX));
    const i1 = Math.min(nx - 1, toI(r.maxX));
    const k0 = Math.max(0, toK(r.minZ));
    const k1 = Math.min(nz - 1, toK(r.maxZ));
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const c = k * nx + i;
        if (solid[c] === 1) continue;
        roomOpen++;
        if (seen[c] === 1) roomSeen++;
      }
    }
    if (roomOpen > 0 && roomSeen / roomOpen >= 0.9) roomsReached++;
  }

  return {
    gate: at(plan.gate.x, plan.gate.z),
    roomsReached,
    rooms: plan.rooms.length,
    openFraction: open === 0 ? 0 : reached / open,
  };
}
