/**
 * "Dock Approach" — the authored visual-test floor, per doc/sample-map.md.
 *
 * One floor whose only job is to exercise every visual system at parkour speed. The top-down
 * debug view (M) must read as the plan in sample-map.md §1.
 *
 * AUTHORING RULES (sample-map §0)
 * - x east 0..45, z south 0..30, y up. Interior floor top y=0, interior height 7,
 *   ceiling slab 7..7.4. Shell walls sit OUTSIDE the 45x30 interior.
 * - Interior partitions are 0.4 thick and CENTRED on the coordinate the plan names, so the
 *   plan's `z=2.2`, `x=24`, `z=26` … are wall centrelines and every zone rectangle in the doc
 *   is the nominal rectangle out to those centrelines.
 * - Doors are 1.6 wide, 2.4 tall. Walls are authored as explicit segments around openings
 *   (`wallRun` below emits the segments + lintels; it is authoring sugar, never CSG).
 *
 * DERIVATIONS forced by the doc (each one flagged inline where it happens):
 * 1. The mezzanine north run (x 0..10, z 2.2..3.8) crosses zone A's footprint (A is x 0..6,
 *    z 0..6 with full-height walls). A's east and south walls therefore carry mezzanine
 *    pass-through openings above y 3.2; A stays sealed at walking height.
 * 2. The doc's two catwalk runs (west z 6..26, north z 2.2..3.8) leave a 2.2 m hole at the
 *    corner. The west run is extended north to z 3.8 so the mezzanine is one continuous L —
 *    the only authored vertical access (the z=23 ladder) has to reach the gantry beam.
 * 3. The west run carries a 1 m hatch at the z=23 ladder so the climber arrives ON the catwalk
 *    instead of under it. The hatch is only as wide as the ladder's own x-footprint: the deck
 *    is authored as three pieces (north of the hatch, south of it, and a continuous strip on
 *    the +x side) so the climber, who faces +x, always steps off onto solid deck.
 * 4. Crate (41.8, z 7) is nudged to z 7.4 — the doc calls it "adjacent" to the 2.0 stack, and
 *    the verbatim z 7 would bury it 0.4 m inside the stack. At 7.4 its z-min (6.8) is exactly
 *    the stack's z-max. The mantle chain 1.2 -> 2.0 -> 3.3 is unaffected.
 * 5. The doc's §1 sketch draws a wall (a `║` column at x ~9) down through zone B. Nothing else
 *    in the doc supports it: §2 B describes one open machine hall, the door list gives B no
 *    door on such a wall, and dog 2's B-hall loop would be cut in half by it. It is a drafting
 *    artefact of the sketch's column spacing and is deliberately NOT built (recorded as an
 *    errata note in doc/sample-map.md §1).
 * 6. Dog 2's north leg is authored at z 11.5, not the doc's z 10: at z 10 the leg runs straight
 *    through the full-height columns at (12,10) and (18,10) — a patrol that cannot be walked.
 *    z 11.5 clears the columns (z-max 10.3) and stays well north of the tank (z-min 13), so the
 *    B-hall loop keeps its shape and every leg is now obstacle-free at dog height.
 */

import type {
  AirVolume,
  BoxSolid,
  CanProp,
  DogRouteDef,
  DoorDef,
  LadderDef,
  MapDef,
  MapMarker,
  PropDef,
  Solid,
  SolidKind,
} from './types.js';

// ------------------------------------------------------------------------------------------
// Dimensions
// ------------------------------------------------------------------------------------------

/** Interior extents. */
export const MAP_W = 45;
export const MAP_D = 30;
/** Interior height: floor top y=0 to ceiling underside y=7. */
export const MAP_H = 7;

/** Interior partition thickness (centred on the plan's coordinate). */
const T = 0.4;
const HT = T / 2;
/** Exterior shell thickness (sits outside the interior). */
const SHELL = 0.4;
/** Floor / ceiling slab thickness. */
const SLAB = 0.4;
/** Door opening height. */
const DOOR_H = 2.4;
/** Mezzanine catwalk: 0.25 slab with its top at y 3.5. */
const CATWALK_TOP = 3.5;
const CATWALK_THICK = 0.25;
/** Gantry beam: 0.3 slab with its top at y 4.2. */
const BEAM_TOP = 4.2;
const BEAM_THICK = 0.3;
/** Trench floor top (a 2.8 m drop from the corridor). */
const TRENCH_Y = -2.8;

const solids: Solid[] = [];
const doors: DoorDef[] = [];

// ------------------------------------------------------------------------------------------
// Authoring helpers
// ------------------------------------------------------------------------------------------

function box(id: string, kind: SolidKind, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BoxSolid {
  return { type: 'box', id, kind, min: [x0, y0, z0], max: [x1, y1, z1] };
}

function push(s: Solid): void {
  solids.push(s);
}

interface Opening {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly yBottom?: number;
  readonly yTop?: number;
  readonly connects: readonly [string, string];
  /** false for mezzanine pass-throughs — a walker cannot use them. */
  readonly walkable?: boolean;
}

interface WallRun {
  readonly id: string;
  /** Axis the wall is perpendicular to. 'z' = a wall running along x. */
  readonly axis: 'x' | 'z';
  /** Centreline on `axis`. */
  readonly at: number;
  /** Span along the run. */
  readonly from: number;
  readonly to: number;
  readonly y0?: number;
  readonly y1?: number;
  readonly thickness?: number;
  readonly kind?: SolidKind;
  readonly openings?: readonly Opening[];
}

/**
 * Emit a wall as explicit segments around its openings, plus a lintel over (and a sill under)
 * each opening. No CSG anywhere — every piece below is a real authored box.
 */
function wallRun(spec: WallRun): void {
  const y0 = spec.y0 ?? 0;
  const y1 = spec.y1 ?? MAP_H;
  const half = (spec.thickness ?? T) / 2;
  const kind = spec.kind ?? 'wall';
  const a = spec.at - half;
  const b = spec.at + half;

  const emit = (segFrom: number, segTo: number, ya: number, yb: number, tag: string): void => {
    if (segTo - segFrom < 1e-6 || yb - ya < 1e-6) return;
    const id = `${spec.id}:${tag}`;
    if (spec.axis === 'z') push(box(id, kind, segFrom, ya, a, segTo, yb, b));
    else push(box(id, kind, a, ya, segFrom, b, yb, segTo));
  };

  const openings = [...(spec.openings ?? [])].sort((p, q) => p.from - q.from);
  let cursor = spec.from;
  for (const o of openings) {
    const ob = o.yBottom ?? y0;
    const ot = o.yTop ?? y0 + DOOR_H;
    emit(cursor, o.from, y0, y1, `pre-${o.id}`);
    emit(o.from, o.to, y0, ob, `sill-${o.id}`);
    emit(o.from, o.to, ot, y1, `lintel-${o.id}`);
    cursor = o.to;
    doors.push({
      id: o.id,
      axis: spec.axis,
      at: spec.at,
      from: o.from,
      to: o.to,
      yBottom: ob,
      yTop: ot,
      connects: o.connects,
      walkable: o.walkable ?? true,
    });
  }
  emit(cursor, spec.to, y0, y1, 'end');
}

// ------------------------------------------------------------------------------------------
// Shell, floor, ceiling
// ------------------------------------------------------------------------------------------

push(box('shell-w', 'wall', -SHELL, 0, -SHELL, 0, MAP_H, MAP_D + SHELL));
push(box('shell-e', 'wall', MAP_W, 0, -SHELL, MAP_W + SHELL, MAP_H, MAP_D + SHELL));
push(box('shell-n', 'wall', 0, 0, -SHELL, MAP_W, MAP_H, 0));
push(box('shell-s', 'wall', 0, 0, MAP_D, MAP_W, MAP_H, MAP_D + SHELL));

/**
 * Floor slab, authored as three pieces around the corridor pit (sample-map §2 C: pit x 31..35,
 * full corridor width). The corridor's clear width runs to the z=2.2 wall's near face (z 2.0),
 * so the pit opening is x 31..35, z <=2.0.
 */
push(box('floor-w', 'floor', -SHELL, -SLAB, -SHELL, 31, 0, MAP_D + SHELL));
push(box('floor-pit-s', 'floor', 31, -SLAB, 2.0, 35, 0, MAP_D + SHELL));
push(box('floor-e', 'floor', 35, -SLAB, -SHELL, MAP_W + SHELL, 0, MAP_D + SHELL));

push(box('ceiling', 'ceiling', -SHELL, MAP_H, -SHELL, MAP_W + SHELL, MAP_H + SLAB, MAP_D + SHELL));

// ------------------------------------------------------------------------------------------
// Trench — dead-end service pit under corridor C (sample-map §2)
// ------------------------------------------------------------------------------------------

push(box('trench-floor', 'floor', 30.6, TRENCH_Y - SLAB, -SHELL, 35.4, TRENCH_Y, 2.6));
push(box('trench-w', 'wall', 30.6, TRENCH_Y, -SHELL, 31, -SLAB, 2.6));
push(box('trench-e', 'wall', 35, TRENCH_Y, -SHELL, 35.4, -SLAB, 2.6));
push(box('trench-n', 'wall', 31, TRENCH_Y, -SHELL, 35, -SLAB, 0));
push(box('trench-s', 'wall', 31, TRENCH_Y, 2.0, 35, -SLAB, 2.6));

// ------------------------------------------------------------------------------------------
// Partition walls
// ------------------------------------------------------------------------------------------

/** C's south wall: the corridor's whole length, with [b] into B and [c] into D1. */
wallRun({
  id: 'w-c-south',
  axis: 'z',
  at: 2.2,
  from: 6 - HT,
  to: MAP_W,
  openings: [
    { id: 'b', from: 10, to: 11.6, connects: ['C', 'B'] },
    { id: 'c', from: 30, to: 31.6, connects: ['C', 'D1'] },
  ],
});

/**
 * A's east wall (A|C above z 2.2, A|B below). The opening at y 3.2..7 over z 2.2..3.8 is
 * derivation 1: the mezzanine north run crosses here.
 */
wallRun({
  id: 'w-a-east',
  axis: 'x',
  at: 6,
  from: 0,
  to: 6 - HT,
  openings: [
    { id: 'a', from: 0.3, to: 1.9, connects: ['A', 'C'] },
    { id: 'mez-e', from: 2.2, to: 3.8, yBottom: 3.2, yTop: MAP_H, connects: ['A', 'B'], walkable: false },
  ],
});

/** A's south wall, with [d] into B and the second mezzanine pass-through at x 0..1.6. */
wallRun({
  id: 'w-a-south',
  axis: 'z',
  at: 6,
  from: 0,
  to: 6 + HT,
  openings: [
    { id: 'mez-s', from: 0, to: 1.6, yBottom: 3.2, yTop: MAP_H, connects: ['A', 'B'], walkable: false },
    { id: 'd', from: 2.5, to: 4.1, connects: ['A', 'B'] },
  ],
});

/** B|D1 wall, with [e]. Below z 16 the solid mass block takes over as the separator. */
wallRun({
  id: 'w-b-d1',
  axis: 'x',
  at: 24,
  from: 2.2 - HT,
  to: 16 + HT,
  openings: [{ id: 'e', from: 10, to: 11.6, connects: ['B', 'D1'] }],
});

/** D1|D2 wall, with [f] (the can-field door). */
wallRun({
  id: 'w-d1-d2',
  axis: 'z',
  at: 16,
  from: 26,
  to: MAP_W,
  openings: [{ id: 'f', from: 40, to: 41.6, connects: ['D1', 'D2'] }],
});

/** The listening wall — the Lantern rig's body — with [g] at its west end. */
wallRun({
  id: 'w-listening',
  axis: 'z',
  at: 26,
  from: 0,
  to: 26 + HT,
  openings: [{ id: 'g', from: 0.3, to: 1.9, connects: ['B', 'E'] }],
});

/** E|D2 wall, with [h]. */
wallRun({
  id: 'w-e-d2',
  axis: 'x',
  at: 26,
  from: 26 - HT,
  to: MAP_D,
  openings: [{ id: 'h', from: 27, to: 28.6, connects: ['E', 'D2'] }],
});

// ------------------------------------------------------------------------------------------
// C — North Corridor (x 6..45, z 0..2.2)
// ------------------------------------------------------------------------------------------

/** Slide duct at x 24: solid from y 1.2 to the ceiling, 0.8 thick in x, spans the corridor. */
push(box('duct', 'machine', 23.6, 1.2, -SHELL, 24.4, MAP_H, 2.0));

// ------------------------------------------------------------------------------------------
// B — Machine Hall (x 0..24, z 2.2..26, minus A)
// ------------------------------------------------------------------------------------------

/** Tank landmark: cylinder Ø6, h 6.5, centre (16, 16). Mass must read from a single ping. */
push({ type: 'cyl', id: 'tank', kind: 'tank', cx: 16, cz: 16, r: 3, yMin: 0, yMax: 6.5 });

/** Columns 0.6², full height — rhythm for pings to reveal. None overlap the tank. */
for (const cx of [6, 12, 18]) {
  for (const cz of [10, 20]) {
    push(box(`column-${cx}-${cz}`, 'wall', cx - 0.3, 0, cz - 0.3, cx + 0.3, MAP_H, cz + 0.3));
  }
}

/** Machinery row: climbable top at exactly the 2.2 mantle limit; the Lantern listening post. */
push(box('machinery-row', 'machine', 4, 0, 24, 20, 2.2, 26));

/**
 * Mezzanine catwalk (derivations 2 and 3): west run extended north to z 3.8 to join the north
 * run, and pierced by a 1 m hatch at the z=23 ladder. The hatch is only as wide as the ladder's
 * own x-footprint (x 0..0.9), so the three pieces below are: deck north of the hatch, deck south
 * of it, and a continuous +x strip (x 0.9..1.6) the climber steps off onto.
 */
const CW_Y0 = CATWALK_TOP - CATWALK_THICK;
push(box('catwalk-west-w-n', 'catwalk', 0, CW_Y0, 3.8, 0.9, CATWALK_TOP, 22.5));
push(box('catwalk-west-w-s', 'catwalk', 0, CW_Y0, 23.5, 0.9, CATWALK_TOP, 26));
push(box('catwalk-west-e', 'catwalk', 0.9, CW_Y0, 3.8, 1.6, CATWALK_TOP, 26));
push(box('catwalk-north', 'catwalk', 0, CW_Y0, 2.2, 10, CATWALK_TOP, 3.8));

/** Gantry beam: 0.7 mantle up from the north catwalk run; its south end is a 4.2 m free drop. */
push(box('gantry-beam', 'beam', 9.2, BEAM_TOP - BEAM_THICK, 3.8, 10, BEAM_TOP, 20));

// ------------------------------------------------------------------------------------------
// D1 — Storage (x 24..45, z 2.2..16): the crate parkour field
// ------------------------------------------------------------------------------------------

const CRATE = 1.2;
for (const [cx, cz] of [
  [27, 6],
  [30, 12],
  [34, 5],
  [38, 9],
  [28, 14],
  // Derivation 4: nudged from the doc's z 7 to z 7.4 so it sits flush against the 2.0 stack
  // (crate z-min 6.8 == stack z-max 6.8) instead of 0.4 m inside it.
  [41.8, 7.4],
] as const) {
  push(box(`crate-${cx}-${cz}`, 'crate', cx - CRATE / 2, 0, cz - CRATE / 2, cx + CRATE / 2, CRATE, cz + CRATE / 2));
}

/** 2.0-high stack on a 1.6x1.6 base — the middle step of the shelf mantle chain. */
push(box('crate-stack', 'crate', 41.2, 0, 5.2, 42.8, 2.0, 6.8));

/** High shelf: the survey platform overlooking D1. */
push(box('high-shelf', 'catwalk', 43.4, 3.3 - 0.25, 4, MAP_W, 3.3, 10));

// ------------------------------------------------------------------------------------------
// D2 — Quiet Room (x 26..45, z 16..30)
// ------------------------------------------------------------------------------------------

/** Solid mass block: the D1/D2 <-> E separator and the "two or more walls = nothing" test body. */
push(box('mass-block', 'machine', 24, 0, 16, 26, MAP_H, 26));

/** Beacon pedestal: 0.5² h 1.0 carrying the gold objective hum. */
push(box('beacon-pedestal', 'pedestal', 34.75, 0, 22.75, 35.25, 1.0, 23.25));

// ------------------------------------------------------------------------------------------
// Ladders (climbable volumes, not solids)
// ------------------------------------------------------------------------------------------

const ladders: LadderDef[] = [
  // B: floor -> mezzanine, bolted to the west shell wall, arriving through the catwalk hatch.
  { id: 'ladder-mezzanine', x: 0.12, z: 23, yBase: 0, yTop: CATWALK_TOP, facing: '+x', width: 0.6, depth: 0.7 },
  // Trench: the silent ascent back to corridor level, on the pit's east face.
  { id: 'ladder-trench', x: 34.6, z: 1.0, yBase: TRENCH_Y, yTop: 0, facing: '-x', width: 0.6, depth: 0.7 },
];

// ------------------------------------------------------------------------------------------
// Props (sound traps — authored, sparse, at chokepoints)
// ------------------------------------------------------------------------------------------

const can = (id: string, x: number, z: number): CanProp => ({ type: 'can', id, x, y: 0, z });

const props: PropDef[] = [
  // C: two loose cans against the north wall near x 20 — the early, avoidable trap lesson.
  can('can-c-1', 19.7, 0.35),
  can('can-c-2', 20.4, 0.55),
  // [f]: the can field. Six cans with an authored crouch line at x ~40.5..41.4.
  can('can-field-1', 39.7, 15.3),
  can('can-field-2', 40.35, 15.85),
  can('can-field-3', 41.55, 15.4),
  can('can-field-4', 40.3, 16.6),
  can('can-field-5', 39.6, 17.1),
  can('can-field-6', 41.5, 16.95),
  // [c]: the chain curtain — loud on a pass, soft when crouched.
  { type: 'chain', id: 'chain-c', min: [30, 0, 2.0], max: [31.6, DOOR_H, 2.4], thinAxis: 'z' },
  // D2: the gold objective hum, on top of its pedestal.
  { type: 'beacon', id: 'beacon', x: 35, y: 1.0, z: 23 },
];

// ------------------------------------------------------------------------------------------
// Dog routes (sample-map §3)
// ------------------------------------------------------------------------------------------

const dogRoutes: DogRouteDef[] = [
  {
    id: 'dog1',
    speed: 3.0,
    defaultOn: true,
    // Cyclic; the doc's trailing "(2, 28) pause 3 -> loop" is this list's first waypoint.
    waypoints: [
      { x: 2, z: 28, pause: 3 },
      { x: 14, z: 28, pause: 4 },
      { x: 24.5, z: 28 },
      { x: 30, z: 27.5 }, // through [h]
      { x: 32, z: 21, pause: 6 },
      { x: 30, z: 27.5 },
      { x: 14, z: 28 },
    ],
  },
  {
    id: 'dog2',
    speed: 3.0,
    defaultOn: false,
    // Derivation 6: the doc's north leg (z 10) runs straight through the columns at (12,10)
    // and (18,10), so it is authored at z 11.5 instead. The other three legs are clear as
    // drawn — x 22 and x 10 both miss the column rows (x 5.7..6.3 / 11.7..12.3 / 17.7..18.3)
    // and the tank (x 13..19), and the south leg at z 22 misses the z=20 column row and the
    // machinery row (z 24..26). Every leg is straight-line walkable at dog height.
    waypoints: [
      { x: 10, z: 11.5, pause: 2 },
      { x: 22, z: 11.5, pause: 2 },
      { x: 22, z: 22, pause: 2 },
      { x: 10, z: 22, pause: 2 },
    ],
  },
];

// ------------------------------------------------------------------------------------------
// Debug markers, air volumes
// ------------------------------------------------------------------------------------------

const markers: MapMarker[] = [
  { kind: 'zone', label: 'A · SPAWN DOCK', x: 3, z: 3.4 },
  { kind: 'zone', label: 'B · MACHINE HALL', x: 7.6, z: 13 },
  { kind: 'zone', label: 'C · NORTH CORRIDOR', x: 15, z: 1.0 },
  { kind: 'zone', label: 'D1 · STORAGE', x: 31.5, z: 3.4 },
  { kind: 'zone', label: 'D2 · QUIET ROOM', x: 33, z: 19.5 },
  { kind: 'zone', label: 'E · SOUTH GALLERY', x: 11, z: 28.4 },
  { kind: 'poi', label: 'TANK Ø6 h6.5', x: 16, z: 16 },
  { kind: 'poi', label: 'MACHINERY ROW h2.2', x: 12, z: 25 },
  { kind: 'poi', label: 'MASS BLOCK', x: 25, z: 21 },
  { kind: 'poi', label: 'HIGH SHELF y3.3', x: 43.6, z: 11.4 },
  { kind: 'poi', label: 'GANTRY BEAM y4.2', x: 9.6, z: 21.2 },
  { kind: 'poi', label: 'CATWALK y3.5', x: 1.8, z: 9 },
  { kind: 'poi', label: 'SLIDE DUCT y1.2', x: 24, z: 1.0 },
  { kind: 'poi', label: 'PIT → TRENCH y−2.8', x: 33, z: 1.0 },
  { kind: 'poi', label: 'CAN FIELD', x: 38.4, z: 17.4 },
  { kind: 'poi', label: 'LISTENING WALL', x: 14, z: 26 },
];

const air: AirVolume[] = [
  { min: [0, 0, 0], max: [MAP_W, MAP_H, MAP_D] },
  { min: [31, TRENCH_Y, 0], max: [35, 0, 2.0] },
];

// ------------------------------------------------------------------------------------------

export const sampleMap: MapDef = {
  name: 'Dock Approach',
  solids,
  ladders,
  props,
  doors,
  dogRoutes,
  // Spawn at (3, 0, 3) facing +x (yaw 0 == +x, see map/types.ts).
  spawn: { pos: [3, 0, 3], yaw: 0 },
  air,
  markers,
  bounds: {
    min: [-SHELL, TRENCH_Y - SLAB, -SHELL],
    max: [MAP_W + SHELL, MAP_H + SLAB, MAP_D + SHELL],
  },
};

export default sampleMap;
