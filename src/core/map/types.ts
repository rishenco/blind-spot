/** Map data types (sample-map §5). All geometry is axis-aligned boxes plus one cylinder. */

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

export type Facing = '+x' | '-x' | '+z' | '-z';

export interface LadderDef {
  readonly id: string;
  /** Centre of the ladder in the plane of the wall it is bolted to. */
  readonly x: number;
  readonly z: number;
  readonly yBase: number;
  readonly yTop: number;
  /** Direction the climbing face points (i.e. where the player stands). */
  readonly facing: Facing;
  readonly width: number;
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
  readonly defaultOn: boolean;
  readonly waypoints: readonly RouteWaypoint[];
}

export interface AirVolume {
  readonly min: V3;
  readonly max: V3;
}

export type MarkerKind = 'zone' | 'door' | 'poi';

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
  readonly dogRoutes: readonly DogRouteDef[];
  readonly spawn: { readonly pos: V3; readonly yaw: number };
  /**
   * Authored playable air. Everything outside these volumes is "outside the world" and is not
   * baked: this is what culls exterior wall faces, buried faces and floor undersides in one rule.
   * (Extension over sample-map §5 — see README "Spec deviations".)
   */
  readonly air: readonly AirVolume[];
  readonly markers: readonly MapMarker[];
  readonly bounds: { readonly min: V3; readonly max: V3 };
}
