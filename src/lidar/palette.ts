/**
 * The one palette the lidar draws in, and the age ramp that walks along it.
 *
 * Law 1 of the concept ("nothing renders just because") means every colour here is on screen
 * only because a scan put it there. Age is the only axis: ice-white at the instant the return
 * lands, cyan while it is current, dim navy as it goes stale, and then a permanent skeleton
 * floor — the accumulated map dims, it never dies.
 *
 * The cold end is a *rendered* navy, not a paint-chip navy: it is multiplied by the skeleton
 * alpha before it reaches the screen, so a colour that already looks dim on a swatch dims twice
 * and the memory map disappears.
 */

export const MATTER_FRESH = 0xeaffff;
export const MATTER_MID = 0x28c8e6;
export const MATTER_COLD = 0x16536e;

/** Reserved accent channel, wired through both shaders. Nothing writes it in M1. */
export const ACCENT_GOLD = 0xffc879;

/** Colours the "lights on" debug view paints the hall with. Never used in normal play. */
export const REVEAL_COLORS = {
  shell: 0x8d959c,
  prop: 0x7d858c,
  landmark: 0x6b6558,
} as const;

export interface AgeRamp {
  /** Ice-white → cyan, seconds. */
  freshSeconds: number;
  /** Cyan → dim navy, seconds. */
  coolSeconds: number;
  /** Navy → memory skeleton, seconds. */
  coldSeconds: number;
  /** Alpha floor of the skeleton: what the map keeps forever. */
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
