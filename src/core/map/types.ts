/**
 * Map data types (sample-map §5).
 *
 * All geometry is axis-aligned boxes plus one cylinder (the tank). Walls are authored as
 * explicit segments around openings — never CSG (sample-map §0).
 *
 * Conventions (sample-map §0):
 *   x east 0..45 · z south 0..30 · y up. Interior floor top at y=0, interior height 7.
 *   Exterior shell walls sit OUTSIDE the 45x30 interior; interior partitions are 0.4 thick and
 *   occupy interior space, CENTRED on the coordinate the plan names (so `z=2.2` means the band
 *   z 2.0..2.4 and the plan's numbers are the wall centrelines).
 *
 * Yaw convention (engine-wide): yaw 0 looks along +x, yaw increases toward +z.
 *   forward = (cos yaw, 0, sin yaw). See `yawToForward` / `yawToThreeRotationY` in core/math.ts.
 */

export type V3 = readonly [number, number, number];

export type SolidKind =
  | 'wall'
  | 'floor'
  | 'ceiling'
  | 'machine'
  | 'crate'
  | 'catwalk'
  | 'beam'
  | 'tank'
  | 'pedestal';

export interface BoxSolid {
  readonly type: 'box';
  readonly id: string;
  readonly kind: SolidKind;
  readonly min: V3;
  readonly max: V3;
}

export interface CylSolid {
  readonly type: 'cyl';
  readonly id: string;
  readonly kind: SolidKind;
  /** centre in XZ */
  readonly cx: number;
  readonly cz: number;
  readonly r: number;
  readonly yMin: number;
  readonly yMax: number;
}

export type Solid = BoxSolid | CylSolid;

/** Direction a mounted feature faces, i.e. which way the player stands relative to it. */
export type Facing = '+x' | '-x' | '+z' | '-z';

export interface LadderDef {
  readonly id: string;
  /** Centre of the ladder's climbing plane (the face the player hugs), in world XZ. */
  readonly x: number;
  readonly z: number;
  readonly yBase: number;
  /** The level the climber arrives at (the walkable surface at the top of the run). */
  readonly yTop: number;
  /** Direction from the ladder plane toward the climbing player. */
  readonly facing: Facing;
  /** Rung width — extent perpendicular to `facing`. */
  readonly width: number;
  /** How far in front of the plane the grab volume reaches. */
  readonly depth: number;
}

export interface CanProp {
  readonly type: 'can';
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ChainProp {
  readonly type: 'chain';
  readonly id: string;
  /** Door opening the curtain fills. */
  readonly min: V3;
  readonly max: V3;
  /** Axis the curtain plane is thin along. */
  readonly thinAxis: 'x' | 'z';
}

export interface BeaconProp {
  readonly type: 'beacon';
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type PropDef = CanProp | ChainProp | BeaconProp;

export interface RouteWaypoint {
  readonly x: number;
  readonly z: number;
  /** Stop-and-listen pause in seconds (dog goes silent -> vanishes -> ghost). */
  readonly pause?: number;
}

export interface DogRouteDef {
  readonly id: string;
  readonly speed: number;
  /**
   * Whether this route is live. Mutable on purpose: the debug view's F6 toggle flips it so the
   * second patrol can be read on and off the plan, and M5's spawner will read the same field.
   */
  defaultOn: boolean;
  /** Cyclic: the follower loops from the last waypoint back to the first. */
  readonly waypoints: readonly RouteWaypoint[];
}

/**
 * A door opening, kept as data (an extension over sample-map §5) so that the top-down view can
 * label it and the map-sanity specs can prove it is actually open. The wall segments around it
 * are still authored explicitly in `solids` — this array only describes the hole.
 */
export interface DoorDef {
  readonly id: string;
  /** Which axis the wall is perpendicular to: 'z' = a wall running along x, and vice versa. */
  readonly axis: 'x' | 'z';
  /** Centreline of the wall on `axis`. */
  readonly at: number;
  /** Opening span along the wall's run (x for axis 'z', z for axis 'x'). */
  readonly from: number;
  readonly to: number;
  /** Opening height range. */
  readonly yBottom: number;
  readonly yTop: number;
  /** Rooms the opening connects, for readability and debug labels. */
  readonly connects: readonly [string, string];
  /** Mezzanine pass-throughs are openings a walker cannot use — excluded from door specs. */
  readonly walkable: boolean;
}

export interface AirVolume {
  readonly min: V3;
  readonly max: V3;
}

export type MarkerKind = 'zone' | 'poi';

export interface MapMarker {
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly kind: MarkerKind;
}

export interface MapDef {
  readonly name: string;
  readonly solids: readonly Solid[];
  readonly ladders: readonly LadderDef[];
  readonly props: readonly PropDef[];
  readonly doors: readonly DoorDef[];
  readonly dogRoutes: readonly DogRouteDef[];
  readonly spawn: { readonly pos: V3; readonly yaw: number };
  /**
   * Authored playable air. Everything outside these volumes is "outside the world" and is not
   * baked: this is what culls exterior wall faces and floor undersides in one rule.
   * (Extension over sample-map §5, for the surfel bake.)
   */
  readonly air: readonly AirVolume[];
  readonly markers: readonly MapMarker[];
  readonly bounds: { readonly min: V3; readonly max: V3 };
}
