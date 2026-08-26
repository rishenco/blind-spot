/**
 * Pick the first view from the geometry that was actually generated.
 *
 * The spawn position is fixed, while the dividers and clutter beyond its keep-out vary by seed.
 * A fixed yaw therefore cannot express "face the room": it used to point into the south-west
 * shell on every seed. This planner measures the horizontal slice of the real lidar cone at eye
 * height. Each ray stops at the first static box, and the polar wedges between the rays sum to
 * the visible floor area. Maximising that area favours an open room or passage without changing
 * the lidar's range or giving the player information the first ping could not reveal.
 */
import { sweepSphereWorld, type StaticWorld } from '../core/collision';

export interface SpawnHeading {
  readonly yawDeg: number;
  /** Approximate visible floor sector at eye height, square metres. */
  readonly visibleArea: number;
  /** Distance from the eye to the first solid straight ahead, metres. */
  readonly forwardClearance: number;
  /** Selected candidate divided by the best candidate. */
  readonly quality: number;
  readonly candidates: number;
  readonly raysPerCandidate: number;
  readonly planningMs: number;
}

export interface SpawnHeadingOptions {
  readonly eyeY: number;
  readonly coneAngleDeg: number;
  readonly range: number;
  readonly candidateStepDeg?: number;
  readonly rayStepDeg?: number;
}

interface Candidate {
  yawDeg: number;
  visibleArea: number;
  forwardClearance: number;
}

const DEG = Math.PI / 180;

/** Camera convention shared with PlayerController: yaw 0 faces -Z. */
function direction(yawDeg: number): readonly [number, number] {
  const yaw = yawDeg * DEG;
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

function clearance(
  world: StaticWorld,
  x: number,
  y: number,
  z: number,
  yawDeg: number,
  range: number,
): number {
  const [dx, dz] = direction(yawDeg);
  return sweepSphereWorld(world, x, y, z, dx, 0, dz, range, 0);
}

function measure(
  world: StaticWorld,
  x: number,
  z: number,
  yawDeg: number,
  options: Required<SpawnHeadingOptions>,
): Candidate {
  const half = options.coneAngleDeg / 2;
  const intervals = Math.max(2, Math.ceil(options.coneAngleDeg / options.rayStepDeg));
  const actualStep = options.coneAngleDeg / intervals;
  let squared = 0;
  for (let i = 0; i <= intervals; i++) {
    const d = clearance(world, x, options.eyeY, z, yawDeg - half + actualStep * i, options.range);
    // Trapezoidal integration of 1/2 r² dθ: visible area of a polar sector.
    squared += d * d * (i === 0 || i === intervals ? 0.5 : 1);
  }
  return {
    yawDeg,
    visibleArea: 0.5 * squared * actualStep * DEG,
    forwardClearance: clearance(world, x, options.eyeY, z, yawDeg, options.range),
  };
}

export function chooseSpawnHeading(
  world: StaticWorld,
  x: number,
  z: number,
  options: SpawnHeadingOptions,
): SpawnHeading {
  const t0 = performance.now();
  const full: Required<SpawnHeadingOptions> = {
    ...options,
    candidateStepDeg: options.candidateStepDeg ?? 5,
    rayStepDeg: options.rayStepDeg ?? 2,
  };
  const candidates = Math.max(8, Math.round(360 / full.candidateStepDeg));
  let best: Candidate | null = null;
  for (let i = 0; i < candidates; i++) {
    // [-180, 180) keeps the value comparable with the controller/debug HUD.
    const candidate = measure(world, x, z, -180 + (360 * i) / candidates, full);
    if (
      best === null ||
      candidate.visibleArea > best.visibleArea + 1e-6 ||
      (Math.abs(candidate.visibleArea - best.visibleArea) <= 1e-6 && candidate.forwardClearance > best.forwardClearance)
    ) {
      best = candidate;
    }
  }
  const selected = best!;
  return {
    ...selected,
    quality: 1,
    candidates,
    raysPerCandidate: Math.max(2, Math.ceil(full.coneAngleDeg / full.rayStepDeg)) + 1,
    planningMs: performance.now() - t0,
  };
}

