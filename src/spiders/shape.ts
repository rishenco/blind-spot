/**
 * The spider, as matter.
 *
 * Concept law: точки — это материя. A spider is a body in the hall like a barrel is, so it is
 * described the same way — a compound of primitives from `props/shapes` — and the lidar samples
 * it with the same `sampleShape`/`shapeEdges` it uses on the clutter. There is deliberately no
 * spider-specific renderer and no spider-specific point path: if the outline reads badly, the
 * fix belongs in these numbers, not in a special case somewhere in the lidar.
 *
 * The silhouette is built to be recognisable at the pitch it is sampled at: a low fat abdomen,
 * a smaller head lump in front, and eight thin limbs standing clear of the body so that the
 * cloud has legs even when only a dozen points land on it. The primitive vocabulary is
 * axis-aligned (a box cannot be tilted), so the legs are straight spars rather than jointed
 * ones; at 3 cm point pitch on a 60 cm animal that difference does not survive to the screen,
 * and the thing that does survive — "low, wide, spindly, not a crate" — is the point.
 */
import { sampleShape, shapeEdges, type EdgeSet, type Part, type PointCloud } from '../props/shapes';

const box = (
  cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
): Part => ({ kind: 'box', cx, cy, cz, hx, hy, hz });

/** Body-local, +X is the way it is facing, origin between the feet. */
export const SPIDER_PARTS: readonly Part[] = [
  { kind: 'ball', cy: 0.17, r: 0.135 },
  box(0.17, 0.155, 0, 0.075, 0.055, 0.06),
  // Eight spars: four reaching along X, four along Z, all a little splayed and a little raised.
  box(0.26, 0.11, 0.1, 0.15, 0.019, 0.019),
  box(0.26, 0.11, -0.1, 0.15, 0.019, 0.019),
  box(-0.26, 0.11, 0.1, 0.15, 0.019, 0.019),
  box(-0.26, 0.11, -0.1, 0.15, 0.019, 0.019),
  box(0.1, 0.11, 0.26, 0.019, 0.019, 0.15),
  box(-0.1, 0.11, 0.26, 0.019, 0.019, 0.15),
  box(0.1, 0.11, -0.26, 0.019, 0.019, 0.15),
  box(-0.1, 0.11, -0.26, 0.019, 0.019, 0.15),
];

/**
 * Point pitch, metres. Tighter than the small clutter (a jar is 0.047): a spider is what the
 * scan is *for*, and at the ranges it matters — five to fifteen metres — a coarser pitch turns
 * it into four indistinguishable dots.
 */
export const SPIDER_PITCH = 0.032;

let cloud: PointCloud | null = null;
let edges: EdgeSet | null = null;

/** The one shared spider cloud. Every spider is the same body at a different transform. */
export function spiderCloud(): PointCloud {
  cloud ??= sampleShape(SPIDER_PARTS, SPIDER_PITCH, 0x5b1d);
  return cloud;
}

export function spiderEdges(): EdgeSet {
  edges ??= shapeEdges(SPIDER_PARTS);
  return edges;
}
