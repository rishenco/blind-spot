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
 * same cyan band, which is the law. What *does* branch on it is loudness: §3.9 gives every
 * material a voice, and a voice is a multiplier on how far a contact sound carries.
 */

/**
 * Material classes the world knows about. Indexes into the table below.
 *
 * `MAT_CONCRETE` is 0 and stays 0: it is the default a box gets when nobody says otherwise, so
 * an unstated material is the ordinary one rather than an accidentally loud one.
 */
export const MAT_CONCRETE = 0;
export const MAT_METAL = 1;
export const MAT_STONE = 2;
/**
 * The quiet end (§3.9), and it exists to give "go slow and stay quiet" something to pay it.
 * Without a class *below* concrete every surface in the tower is normal-or-louder, and a
 * routing choice with no cheap side is not a choice.
 */
export const MAT_DUST = 3;

/**
 * One row per material: what it is called, and how loud it is.
 *
 * Deliberately a single table rather than a name array beside a multiplier array. A material
 * that has a name and no voice — or a voice under the wrong name — is exactly the drift this
 * shape makes unavailable: there is one place to add a material, and adding it there means
 * answering both questions at once.
 *
 * The multipliers are §3.9's first pass. They are loudness, so they scale *every* radius a
 * contact event carries (`SoundBus.emit` is the one place that happens): what the surface is
 * made of changes how far the noise paints and how far it is heard, by the same factor, because
 * those are two readings of one sound.
 */
const MATERIALS: readonly Readonly<{ name: string; loudness: number }>[] = Object.freeze([
  Object.freeze({ name: 'concrete', loudness: 1.0 }),
  Object.freeze({ name: 'metal', loudness: 1.5 }),
  Object.freeze({ name: 'stone', loudness: 1.15 }),
  Object.freeze({ name: 'dust', loudness: 0.6 }),
]);

/** Index → name, so a material read out of a collider box is legible in a debug print. */
export const MATERIAL_NAMES: readonly string[] = Object.freeze(MATERIALS.map((m) => m.name));

/**
 * The §3.9 voice of a material, as a multiplier on loudness.
 *
 * An index nothing recognises answers with concrete's 1.0 rather than throwing. A material id
 * that has fallen off the end of the table is a data bug, and the useful place to catch it is
 * the test that walks `MATERIAL_NAMES` — not a frame of gameplay, where the alternative to a
 * plausible number is a crash mid-stride.
 */
export function materialLoudness(mat: number): number {
  return MATERIALS[mat]?.loudness ?? 1;
}

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
