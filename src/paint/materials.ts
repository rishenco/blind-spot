/**
 * Material voices — what a surface *sounds like* when the wave comes back off it.
 *
 * Vision §3.2 fixes the matter layer to the cyan family: age is the only axis, forever. That
 * law owns looks 1-3 and it is not up for negotiation. Look 4 ("Afterimage") is a candidate
 * that asks the opposite question — what if the return told you what the surface is *made of*,
 * and age were carried by brightness and a violet drift instead of by hue alone? The two live
 * side by side behind one `materialMix` knob so a playtest can decide, rather than an argument.
 *
 * The numbers below are the reference game's, taken as *values* (a palette is a set of
 * measurements, and re-deriving hand-tuned hues from scratch would only be worse): its
 * concrete/metal/stone hot and cool colours, its violet drift target, the ratio of its
 * per-material reflectivities and its per-material surface roughness. Everything that *uses*
 * them here — the ramp, the splat, the deposit path — is ours.
 *
 * Two deliberate departures:
 *
 *  - Reflectivity is stored **normalised around 1**, not absolute. The reference's absolute
 *    values (0.72 / 1.00 / 0.62) are a return *probability* in its GPU sampler; ours is a
 *    brightness multiplier on a ray that has already been cast, so using them raw would just
 *    dim the whole cloud by a quarter and change every look at once. The ratios — metal reads
 *    hotter than concrete, stone duller than both — are what carries the character.
 *
 *  - There is no `DEAD` colour. The reference dissolves old returns to nothing; ours cool into
 *    the permanent memory skeleton of §3.6 and stay there. The violet happens on the way down.
 */

/** Material classes the paint system knows about. Indexes into `MATERIAL_VOICES`. */
export const MAT_CONCRETE = 0;
export const MAT_METAL = 1;
export const MAT_STONE = 2;
export const MATERIAL_COUNT = 3;

export type MaterialClass = 0 | 1 | 2;

export interface MaterialVoice {
  readonly name: string;
  /** Colour at the instant of return, linear RGB. */
  readonly hot: readonly [number, number, number];
  /** Colour once settled, linear RGB. */
  readonly cool: readonly [number, number, number];
  /** Return strength relative to the average surface (1 = neutral). */
  readonly refl: number;
  /** Splat size relative to the look's nominal blip. */
  readonly sizeBias: number;
  /** Micro-relief the deposit is displaced along the surface normal by, metres. */
  readonly rough: number;
}

export const MATERIAL_VOICES: readonly MaterialVoice[] = [
  {
    name: 'concrete',
    hot: [0.78, 0.94, 1.0],
    cool: [0.3, 0.62, 0.78],
    refl: 0.95,
    sizeBias: 1.0,
    rough: 0.016,
  },
  {
    name: 'metal',
    hot: [1.0, 0.86, 0.55],
    cool: [0.72, 0.48, 0.16],
    refl: 1.3,
    sizeBias: 0.9,
    rough: 0.006,
  },
  {
    name: 'stone',
    hot: [0.95, 0.92, 0.84],
    cool: [0.46, 0.44, 0.52],
    refl: 0.82,
    sizeBias: 1.15,
    rough: 0.03,
  },
];

/** Where old returns drift before they settle into the skeleton. */
export const VIOLET: readonly [number, number, number] = [0.42, 0.2, 0.66];

/**
 * The matter palette of §3.2 — cyan-family only, forever, and shared by every look that obeys
 * the law (the blip cloud of looks 1-3 and the Blueprint lattice and contours of look 5).
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
 * cyan band the day the movement verbs arrive; nothing writes it yet.
 */
export const ACCENT_GOLD = 0xffc879;
