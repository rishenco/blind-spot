/**
 * Material classes — what a surface *is*, as far as sound is concerned.
 *
 * Vision §3.2 fixes the matter layer to the cyan family: age is the only axis the renderer
 * spends hue on, forever. So a material is not a colour here. It is a classification the world
 * carries on every collider box (`Aabb.mat`) and that the rest of the game reads: a return off
 * metal and a return off concrete are not the same sound, a footfall on cut stone is not the
 * same footfall, and a staircase should be identifiable by ear before it has been touched.
 *
 * Nothing in the renderer branches on it yet — the Blueprint reveal draws every surface in the
 * same cyan band, which is the law. The classes are here because the world tags itself with
 * them at build time, and losing that tagging is far more expensive than keeping it.
 */

/** Material classes the world knows about. Indexes into `MATERIAL_NAMES`. */
export const MAT_CONCRETE = 0;
export const MAT_METAL = 1;
export const MAT_STONE = 2;

/** Index → name, so a material read out of a collider box is legible in a debug print. */
export const MATERIAL_NAMES: readonly string[] = ['concrete', 'metal', 'stone'];

/**
 * The matter palette of §3.2 — cyan-family only, forever.
 *
 * The cold end is a *rendered* navy, not a paint-chip navy: it is multiplied by the skeleton's
 * 0.22 alpha before it reaches the screen, so picking a colour that already looks like dim navy
 * on a swatch dims it twice and the memory skeleton disappears — which would quietly cost the
 * player the map §3.6 promises they keep.
 */
export const MATTER_FRESH = 0xeaffff;
export const MATTER_MID = 0x28c8e6;
export const MATTER_COLD = 0x16536e;

/**
 * Reserved accent for traversal holds (§5: "dots are matter, lines are holds"). The structured
 * backend carries a per-item channel for it so ledges, rails and rungs can be lifted out of the
 * cyan band the day the movement verbs are wired to it; nothing writes it yet.
 */
export const ACCENT_GOLD = 0xffc879;
