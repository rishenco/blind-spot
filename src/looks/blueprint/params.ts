/**
 * BLUEPRINT — the tuning surface (doc/looks/blueprint.md "Tuning surface").
 *
 * Everything an art pass wants to move lives here, and nothing that a LAW owns does. The laws
 * are in `src/core/const.ts` and are read through `ctx.constants`: aging bands, the skeleton
 * floor, the 45 m window, the splat px floors, the stain fade window. A number in this file may
 * be changed by a playtest; a number in const.ts may not be changed by a look at all
 * (engine-plan §9).
 *
 * The school in one line: LINES LEAD, dots hatch in behind, and what age leaves standing is the
 * drawing. Every constant below serves that or gets deleted.
 */

// ---------------------------------------------------------------------------------------------
// Palette (doc/looks/blueprint.md "Palette"). Linear-ish sRGB triples in 0..1 — the renderer runs
// without tone mapping, so what is written here is what lands on the screen.
// ---------------------------------------------------------------------------------------------

export type RGB = readonly [number, number, number];

const rgb = (hex: number): RGB => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];

export const PALETTE = {
  /** Matter, in age order. The ramp the matter layer walks as paint cools. */
  flash: rgb(0xf6fcff),
  hot: rgb(0xbbe7ff),
  mid: rgb(0x4fa8e0),
  /** The brief's "desaturates slightly toward slate before settling in navy". */
  slate: rgb(0x35708f),
  cool: rgb(0x1c4e78),
  skeleton: rgb(0x0c2b47),

  /** Line work. An edge is brighter than any dot of equal age — that is the school. */
  edge: rgb(0xdff3ff),
  holdCore: rgb(0xffffff),
  /** The plotter head. */
  rim: rgb(0xffffff),

  /** Contact-only geometry (vision §3.1): touched, never heard. Cooler than any painted dot. */
  contact: rgb(0x2b5f80),

  /** Event layer — vision §3.2's assignments, in this school's inks. */
  self: rgb(0xffb454),
  teammate: rgb(0x6fe89a),
  dog: rgb(0xff5a3a),
  prop: rgb(0xe6d97a),
  objective: rgb(0xffcf4d),
  detonation: rgb(0xffffff),

  /** A ghost's last stage before it is unplotted. */
  rust: rgb(0x7a3b2e),

  /** All UI is this one ink, hairline, nothing filled. */
  ui: rgb(0xdff3ff),
} as const;

export const UI_INK = '#DFF3FF';

// ---------------------------------------------------------------------------------------------
// Edges & dots — the plot order
// ---------------------------------------------------------------------------------------------

/**
 * How long a freshly painted edge takes to wipe along its own length, milliseconds — and, because
 * the two are the same promise, how long the dots behind it wait before they start hatching in.
 *
 * This is the whole school in one number. At a sprint (6 m/s) 80 ms is half a metre of lead: long
 * enough that the corridor's creases arrive visibly ahead of its surfaces, short enough that the
 * two never read as separate events.
 */
export const EDGE_LEAD_MS = 80;

/** Dot snap-in ease, milliseconds. Blueprint registers; it never flares, so there is no overshoot. */
export const DOT_SNAP_MS = 60;

/** Line weight in CSS px, near and far. Carried by a perpendicular skirt pass (see matter.ts). */
export const LINE_W_NEAR = 2.5;
export const LINE_W_FAR = 1.5;
/** Where the near weight has fully given way to the far one, metres. */
export const LINE_W_FALLOFF_M = 26;

/** Hold tick terminals: half-length in CSS px, and the px floor a tick may not shrink under. */
export const TICK_LEN = 4.4;
export const TICK_MIN_PX = 2.0;

/**
 * Dot size in px, as the multiplier on the core footprint floors, and the sprite's skirt.
 *
 * The brief asks for 2.5-3 px round-squares with a 1.2x skirt of minimal glow. The sprite is drawn
 * at `footprint * DOT_SKIRT` and the outer 1/DOT_SKIRT of it is the skirt, so the SOLID core keeps
 * the footprint the core constants demand and the glow costs nothing in coverage.
 */
export const DOT_SKIRT = 1.2;
/** Superellipse exponent: 2 is a circle, infinity a square. 3.6 is a round-square that does not crawl. */
export const DOT_SUPERELLIPSE = 3.6;
/**
 * Near-field dot cap as a fraction of FRAME HEIGHT (visual-brief §2 "near field: dots stay dots";
 * the debug look documents the reasoning at length under its own SPLAT_CAP_FRAC).
 *
 * Blueprint caps HARDER than the debug look does, because its don'ts include "the graph-paper read
 * must never become a moiré": the lattice is the subject here, and a lattice whose cells touch is
 * a sheet of paper, not graph paper. At 1000 px tall this is 9 px against a ~12 px pitch at 9 m.
 */
export const DOT_CAP_FRAC = 0.009;

/**
 * How much of the lattice survives full age, as a fraction of the dither band.
 *
 * Vision §3.6 keeps every painted surface forever at the SKELETON_ALPHA floor; the brief spends
 * that permanence differently from the other schools — "dots thin out exactly per core semantics
 * but edges dim only to skeleton floor and never thin — an old room is a pure navy line drawing".
 * So age thins the CLOUD against each dot's own stable dither (never a random draw: the survivors
 * must be the same dots frame after frame) and leaves the line work standing at full density.
 */
export const SKELETON_THIN = 0.34;

/** Age at which the fresh flash has fully given way to the hot tone, seconds (brief: "first 0.3 s"). */
export const FLASH_S = 0.3;
/** Where the slate stop sits between AGE_MID and AGE_COOL, 0..1. */
export const SLATE_AT = 0.45;

// ---------------------------------------------------------------------------------------------
// Rim — the plotter head
// ---------------------------------------------------------------------------------------------

/**
 * The bright zone behind the wavefront, metres (brief: "a 0.15 m bright zone", no tail).
 *
 * Converted to a time window against the event's own wave speed, because that is the only thing
 * the shader can test: paint arrives stamped with WHEN the wave reached it, so a shell of constant
 * thickness is a window of constant duration for a given speed.
 */
export const RIM_ZONE_M = 0.15;
/**
 * ...but never thinner than this many frames' worth of wavefront travel. An E-ping's front covers
 * 1.4 m per frame at 85 m/s, so a literal 0.15 m shell is a sub-frame event that would strobe or
 * vanish entirely depending on where the frame landed. Widening it to the frame is the honest
 * reading of "the front you can actually see" and it is the difference between a plotter head and
 * a flicker.
 */
export const RIM_MIN_FRAMES = 1.6;
/** Longest the rim window may ever be, seconds — core's own fresh-flash window is the ceiling. */
export const RIM_MAX_S = 0.12;
/** Under reduce-flashing the edge highlight becomes this ease instead of a one-frame flash, seconds. */
export const RIM_EASE_CALM = 0.12;
/** How much brighter an edge goes as the rim crosses it. */
export const RIM_EDGE_BOOST = 0.85;

// ---------------------------------------------------------------------------------------------
// Noise stains — graphite
// ---------------------------------------------------------------------------------------------

/** How many stains may be alive at once; a ring, oldest overwritten first (vision §12 hard pools). */
export const STAIN_CAP = 64;

/**
 * The quality → mark mapping. High quality is a small dense smudge WITH its draftsman's marks; low
 * quality is a wide pale edgeless cloud with none of them. Definition is the reading, not brightness
 * alone (visual-brief §1.13).
 */
export const STAIN_R_LOW = 0.4;
export const STAIN_R_HIGH = 2.2;
/**
 * Peak ink, low quality → high. A vague read is PALE, not absent: at 0.06 a saturated hue lands on
 * black as three or four 8-bit levels, which is the same as not drawing the event layer at all —
 * and the event layer is half of what the player is reading (vision §3.2). The low end has to be
 * legible-but-uncommitted, and it earns its vagueness from radius and from the missing marks.
 */
export const STAIN_A_LOW = 0.18;
export const STAIN_A_HIGH = 0.55;
/** Below this delivered quality the containment circle and the hatch strokes are simply absent. */
export const STAIN_MARK_Q = 0.42;
/** Smallest a smudge may draw, CSS px — under this it is a shimmering sub-pixel (vision §12). */
export const STAIN_MIN_PX = 4;

/** Hatch stroke length, in stain radii, and how far outside the smudge it starts. */
export const STAIN_HATCH_LEN = 1.15;
export const STAIN_HATCH_GAP = 1.05;
/** Jag amplitude of a dog's hatch strokes, in stain radii. Every other source hatches straight. */
export const STAIN_HATCH_JAG = 0.26;
/** The containment circle's ink, relative to the smudge's peak. A hairline needs the lift. */
export const STAIN_RING_ALPHA = 1.35;
/** A prop's ring expands by this many radii over its life; every other ring holds still. */
export const STAIN_RING_EXPAND = 1.5;
/** Glyph size, in stain radii (objective diamond, teammate square). */
export const STAIN_GLYPH_R = 0.3;

/** Stain onset, seconds — and the longer one reduce-flashing swaps in, with a lower peak. */
export const STAIN_ONSET = 0.07;
export const STAIN_ONSET_CALM = 0.34;
export const STAIN_CALM_ALPHA = 0.62;

// ---------------------------------------------------------------------------------------------
// Dog & ghosts
// ---------------------------------------------------------------------------------------------

/** |n·v| under this is silhouette: the depth-edge of the cloud, drawn as the brief's fine line. */
export const SIL_EDGE = 0.42;
/**
 * Alpha of the cloud's INTERIOR against its silhouette. The drawing convention, applied to a dog.
 * The interior is deliberately weak: several heard poses overlap in the same volume, so an interior
 * that reads well for ONE sample reads as a solid lozenge for five and the outline is lost.
 */
export const DOG_BODY_ALPHA = 0.22;
export const DOG_SIL_ALPHA = 0.95;
/** How much fainter each older motion-smear sample is than the one after it (vision §3.7). */
export const DOG_SMEAR_DECAY = 0.5;
/** How long a frozen ghost takes to collapse from a cloud to pure outline, seconds. */
export const GHOST_COLLAPSE_S = 1.0;

// ---------------------------------------------------------------------------------------------
// Hands & HUD
// ---------------------------------------------------------------------------------------------

/** Wireframe hand box dimensions, metres (see the debug look for why a rig is small in metres). */
export const FOREARM_THICK = 0.072;
export const HAND_THICK = 0.088;
export const HAND_LENGTH = 0.15;
export const FOREARM_ALPHA = 0.4;
export const HAND_ALPHA = 0.6;
/** The dimension tick drawn at the grip during a mantle or vault, metres. */
export const GRIP_TICK_LEN = 0.075;

/** Halo ring radius in CSS px, and the compass tick length. */
export const HALO_R = 30;
export const HALO_TICK = 5;
/**
 * The energy arc sits outside the ring; 10 graduation marks, empty ones vanish. The radius clears
 * the halo by more than a mark is long: the two are different readings and a graduation touching
 * the loudness ring would read as one instrument with a burr on it.
 */
export const ENERGY_R = 47;
export const ENERGY_MARKS = 10;
export const ENERGY_MARK_LEN = 6;
/** The arc spans this many degrees, centred on straight down. */
export const ENERGY_ARC_DEG = 120;
/** Reticle: a 3 px gap, then a 4 px stroke on each of the four arms. */
export const RETICLE_GAP = 3;
export const RETICLE_ARM = 4;
/** How long the ping rim answer lives on the HUD, seconds. */
export const HUD_RIM_S = 0.4;
/** How long a refused ping's reason stays printed, seconds. */
export const REFUSAL_SHOW = 0.6;
