/**
 * The age ramp (§3.2 and §3.6) — the one axis every drawn thing in this game is a function of.
 *
 * Nothing in the world is drawn because it is *there*; it is drawn because it was *heard*, and
 * how it looks is decided entirely by how long ago that was. The ramp lives in its own module
 * because both halves of the renderer read it — the lattice and the contours — and neither owns
 * it. Times are seconds on the paint clock; the last stage never completes, so a surface cools
 * into the permanent memory skeleton and stays there.
 */

export interface AgeRamp {
  /** Ice-white → cyan. */
  freshSeconds: number;
  /** Cyan → dim navy. */
  coolSeconds: number;
  /** Navy → memory skeleton. */
  coldSeconds: number;
  /** Alpha floor of the skeleton (§3.6 asks for ~0.22). */
  skeletonAlpha: number;
  /** Size multiplier once fully cooled — the skeleton is thinner as well as dimmer. */
  skeletonSize: number;
}

export function defaultAgeRamp(): AgeRamp {
  return {
    freshSeconds: 2,
    coolSeconds: 20,
    coldSeconds: 60,
    skeletonAlpha: 0.22,
    skeletonSize: 0.7,
  };
}
