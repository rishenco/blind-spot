/**
 * SIGNAL — the tuning surface named by `doc/looks/signal.md` ("Tuning surface").
 *
 * Everything an art pass would want to move lives here: the palette table, the decode timings,
 * the fringe width, the posterize step count, the stain shimmer rate, the dash pattern and the
 * dot size ratios. Nothing in this folder hard-codes a colour or a duration.
 *
 * BOUNDARY (engine-plan §9): these are the LOOK's numbers. Anything that is simulation — radii,
 * aging thresholds, quality mapping, the rim WINDOW, the stain fade range — is read from
 * `ctx.constants` at runtime and never restated here. A number that appears in both places is a
 * bug waiting to drift.
 */

/** RGB in 0..1, straight from the brief's palette table. */
export type RGB = readonly [number, number, number];

const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/**
 * THE PALETTE (signal.md "Palette").
 *
 * The matter ramp is cyan-family end to end (vision §3.2), and it deliberately stops short of
 * white at `flash`: the rim is the only thing in the look allowed to be `#FFFFFF`, so the ramp
 * keeps headroom above its own hottest tone rather than saturating and losing the rim's read
 * (visual-brief §2 "art looks keep freshness inside their own ramp's headroom instead").
 */
export const PALETTE = {
  /** #F0FCFF — the decode frame, one step under the rim's white. */
  flash: hex(0xf0fcff),
  /** #6EE8FF */
  hot: hex(0x6ee8ff),
  /** #17B4E8 — the signature tone. */
  mid: hex(0x17b4e8),
  /** #0D5E85 */
  cool: hex(0x0d5e85),
  /** #082C40, floored at SKELETON_ALPHA — permanent (vision §3.6). */
  skeleton: hex(0x082c40),
  /** #C9F2FF */
  edge: hex(0xc9f2ff),
  /** #FFFFFF core. */
  hold: hex(0xffffff),
  /** #FFFFFF, the only permanently fringed element. */
  rim: hex(0xffffff),
  /** #83372A — a ghost being deallocated (vision §3.7). */
  rust: hex(0x83372a),
  /**
   * Contact-shell dots (vision §3.1). Cool but light-valued: the shell draws at alpha 0.05, and a
   * dark colour at that alpha rounds to black in 8 bits — an invisible shell is not a shell.
   */
  shell: hex(0xb9ddee),
} as const;

/** Event-layer hues, exactly vision §3.2 / signal.md. Hue is never the only carrier — see FORM. */
export const EVENT_RGB = {
  self: hex(0xffb454),
  dog: hex(0xff5433),
  prop: hex(0xe6d97a),
  objective: hex(0xffcf4d),
  detonation: hex(0xffffff),
  /** Vision §3.2's teammate green. Signal's table omits it; the law does not. */
  teammate: hex(0x57ff8c),
} as const;

/** UI ink (`#9FE8FF`). Events never recolour it. */
export const UI_INK = '#9FE8FF';

/**
 * The 1 px ground carried under every HUD stroke.
 *
 * Not decoration and not a colour — it is absence, so it adds no hue to a readout the brief pins
 * at one ink. It exists because the dial is DOM over a world that paints itself bright: measured
 * on the E-ping route, the annulus under the halo sits at mean luminance 134 one second after a
 * ping and is still at 120 six seconds later, while `audibleRadius` has already decayed to 0. In
 * that window the unlit stroke's own 0.06 ink moves the pixel by three levels out of 255 and the
 * dial simply is not there — and vision §3.8 calls this readout non-negotiable. The ground makes
 * the dial's SHAPE independent of what the world drew, so stroke COUNT stays the reading at every
 * brightness; the ink's alpha still carries the ramp exactly as before.
 */
export const UI_SHADE = 'rgba(0,0,0,0.86)';

// ---------------------------------------------------------------------------------------------
// Dots (signal.md "Dots")
// ---------------------------------------------------------------------------------------------

/**
 * The BRIGHT SAMPLE's screen-space cap, as a fraction of frame HEIGHT.
 *
 * Relative for the reason the debug look's cap is relative: the only scale that matters is the
 * lattice's screen PITCH, and both the pitch and a splat's footprint scale with frame height.
 *
 * WHY NOT THE BRIEF'S LITERAL "3 px near": visual-brief §2's near-field ruling is binding on all
 * three schools and puts the cap at "order 8-14 px at 1080p, each school tunes inside its own
 * brief's stated dot sizes". At 1080p this is 9.5 px of bright square — the low end of that band,
 * which is where Signal belongs, and a square carries ~1.27x the ink of a disc of the same width
 * so it reads heavier than the number suggests. A literal 3 px cap would bind from ~35 m inward
 * and turn the entire mid field into a starfield, which is the failure visual-brief §2 was
 * written to prevent. The brief's "3 px" survives as the FAR read: the floor a distant sample
 * relaxes to is core's SPLAT_MIN_PX (2.2 px), and most of the far field sits just above it.
 */
export const DOT_SAMPLE_CAP_FRAC = 0.0088;

/** The dark-cyan underlay square, as a multiple of the bright sample (signal.md: 1.6x behind). */
export const DOT_UNDERLAY_SCALE = 1.6;
/** Underlay colour = sample colour x this. Reads as a sensor cell, not as bloom. */
export const DOT_UNDERLAY_TINT = 0.3;
/** Underlay alpha = sample alpha x this. */
export const DOT_UNDERLAY_ALPHA = 0.5;
/** Superellipse corner rounding as a fraction of half-width (signal.md "Don'ts": ~15 %). */
export const DOT_CORNER = 0.15;
/** The "1-px soft rim" of an otherwise hard-edged square, in CSS px. */
export const DOT_SOFT_PX = 1.0;

// ---------------------------------------------------------------------------------------------
// Decode resolve (signal.md "Dots")
// ---------------------------------------------------------------------------------------------

/** Total resolve time, ms: "fresh paint appears in two steps inside 100 ms". */
export const DECODE_MS = 100;
/** Fraction of DECODE_MS spent in the preview step before the full lattice locks in. */
export const DECODE_PREVIEW_FRAC = 0.35;
/** Preview samples draw at this multiple of true size. */
export const DECODE_PREVIEW_SCALE = 2.0;
/**
 * Preview density: a quarter of the lattice, chosen by each dot's own stable `dither` so the
 * preview is an ORDERED subset and the same dots always lead the decode (visual-brief §2).
 * Quarter density at double size is equal coverage — the preview is a coarser read, not a dimmer
 * one.
 */
export const DECODE_PREVIEW_DENSITY = 0.25;

// ---------------------------------------------------------------------------------------------
// Rim (signal.md "Rim (racing rim)")
// ---------------------------------------------------------------------------------------------

/** Chroma split on the rim's leading edge, CSS px (the "+/-1 px RGB split"). */
export const RIM_FRINGE_PX = 1.0;
/** How much of RIM_WINDOW carries the fringe — "its leading edge only". */
export const RIM_FRINGE_FRAC = 0.3;
/** Strength of the chroma offset. Chroma only: red and blue move against each other, luma does not. */
export const RIM_FRINGE_AMT = 0.55;
/**
 * Preview-density gain inside a live E-ping cone — "the rim band is slightly denser along the
 * cone axis". The beam reads directional without the renderer inventing anything: the test is the
 * real cone of the real event, against dots the real wavefront has just reached.
 */
export const RIM_CONE_DENSITY = 1.8;

// ---------------------------------------------------------------------------------------------
// Aging (signal.md "Edges & aging")
// ---------------------------------------------------------------------------------------------

/** Visible steps in the hot -> mid transition. Data losing precision; subtle by construction. */
export const POSTERIZE_STEPS = 4;
/**
 * Fraction of dots dropped by the time paint has cooled to skeleton — "old areas read as
 * low-bitrate memory: sparse squares + intact edges". Dropped in stable `dither` order, so a
 * rescan refreshes in place (vision §12) and the memory skeleton never moves.
 */
export const AGE_THIN_MAX = 0.55;

// ---------------------------------------------------------------------------------------------
// Edges and holds
// ---------------------------------------------------------------------------------------------

/** Screen-space dash: 6 px lit, 2 px dark (signal.md "Edges & aging"). */
export const DASH_PATTERN: readonly [number, number] = [6, 2];
/** Second stroke offset for holds, CSS px. Weight is stroke count, never hue (vision §12). */
export const HOLD_OFFSET_PX = 0.7;
/** View-space nudge toward the camera for line vertices, metres — beats surfel z-fighting. */
export const LINE_LIFT = 0.02;

// ---------------------------------------------------------------------------------------------
// Noise stains (signal.md "Noise stains")
// ---------------------------------------------------------------------------------------------

/** Interior shimmer rate, Hz. Frozen entirely under reduce-flashing. */
export const STAIN_NOISE_HZ = 2.5;
/** Peak amplitude of the interior noise, as a fraction of the stain's own alpha. */
export const STAIN_NOISE_AMT = 0.55;
/** Noise cell counts across the stain: coherent when the read is good, static when it is not. */
export const STAIN_NOISE_CELLS_HIGH = 4.0;
export const STAIN_NOISE_CELLS_LOW = 16.0;

/** Quality -> geometry, the visual-brief §1.13 mapping. Radius in metres, alpha at peak. */
export const STAIN_R_LOW = 0.46;
export const STAIN_R_HIGH = 2.2;
export const STAIN_A_LOW = 0.08;
export const STAIN_A_HIGH = 0.3;

/**
 * Per-form radius gain. The quality mapping sets how DEFINED a stain is; this sets how big the
 * mark's own language needs to be to read at all. A detonation is vision §6's "22 m flashbulb"
 * and the loudest mark in the game; a footstep is a footstep.
 */
export const STAIN_RADIUS_GAIN = {
  self: 1.0,
  dog: 1.15,
  prop: 1.1,
  objective: 1.1,
  detonation: 3.0,
  teammate: 1.0,
} as const;

/**
 * Stain sprite ceiling, as a fraction of frame height, and its floor in CSS px.
 *
 * Larger than the dot cap, and that is the point: a stain carries a per-source FORM (jagged
 * perimeter, glitch dart, square ripple, ring, glyph pip) and a form needs area to be a form.
 * The colourblind law (vision §12) is paid in shape, and shape under ~20 px is hue with extra
 * steps. Kept airy instead by a low alpha ceiling (STAIN_A_HIGH) and additive blending, so a
 * large stain is a wash and never a surface (visual-brief §2).
 */
export const STAIN_CAP_FRAC = 0.085;
export const STAIN_MIN_PX = 4;

/** Onset, and the longer/dimmer onset comfort mode uses instead (vision §12). */
export const STAIN_ONSET = 0.07;
export const STAIN_ONSET_CALM = 0.34;
export const STAIN_CALM_ALPHA = 0.62;

/** Jagged perimeter (dog): teeth count and depth as a fraction of the radius. */
export const DOG_JAG_TEETH = 11.0;
export const DOG_JAG_DEPTH = 0.3;
/** The radial glitch dart: length in stain radii, half-width, and how long it lives, seconds. */
export const DOG_DART_LEN = 1.55;
export const DOG_DART_WIDTH = 0.1;
export const DOG_DART_LIFE = 0.5;
/** Largest step between two consecutive gait stamps that still counts as the same dog, metres. */
export const DOG_MATCH_RADIUS = 4.0;

/** Prop: one square ripple, expanding once over this fraction of the stain's life. */
export const PROP_RIPPLE_SPAN = 0.45;
export const PROP_RIPPLE_WIDTH = 0.16;

/** Objective: coherence breath period, seconds (signal.md: "a slow 4 s coherence breath"). */
export const OBJECTIVE_BREATH_S = 4.0;

/** Detonation: the white burst's ring travel, as a fraction of life. */
export const DETONATION_RING_SPAN = 0.3;
/**
 * The flashbulb's alpha gain over the ordinary stain ceiling, and its decay constant in seconds.
 *
 * The gain is what lets vision §3.2's "white flash" actually reach white through additive
 * blending; the time constant is what keeps it a FLASH rather than a lamp. It is set against the
 * FRAME RATE, not against taste: the core has to stay over the white threshold long enough to be
 * seen at all, and a decay this side of a fifth of a second puts the whole flash inside three or
 * four frames at 60 fps — a single-frame pop that reads as a glitch instead of a flashbulb. At
 * 0.3 s the core holds white for something like a sixth of a second and is spent well inside one,
 * which is a blink and still legible. The comfort value is the same event without the blowout,
 * for reduce-flashing (vision §12) — dimmer, never a strobe.
 */
export const DETONATION_FLASH_GAIN = 4.2;
export const DETONATION_FLASH_S = 0.3;
export const DETONATION_FLASH_GAIN_CALM = 1.5;

/** Teammate: glyph pip half-size in stain radii, and its stroke thickness. */
export const TEAMMATE_PIP = 0.3;
export const TEAMMATE_PIP_BAR = 0.09;

// ---------------------------------------------------------------------------------------------
// Dog cloud and ghosts (signal.md "Dog & ghosts")
// ---------------------------------------------------------------------------------------------

/** "sampled one lattice step coarser than the world": bigger samples, fewer of them. */
export const DOG_COARSE_SCALE = 1.5;
export const DOG_COARSE_KEEP = 0.5;
/** Alpha of the newest heard pose at quality 1. */
export const DOG_ALPHA = 0.92;
/** "2-3 offset coarse copies at decreasing alpha" — a dropped-frame trail, never a blur. */
export const DOG_SMEAR_COPIES = 3;
export const DOG_SMEAR_DECAY = 0.45;
/** Fraction of DOG_GHOST_LIFE that passes before the Bayer wink-out starts. */
export const GHOST_DISSOLVE_START = 0.6;

// ---------------------------------------------------------------------------------------------
// Hands (signal.md "Hands, halo, HUD")
// ---------------------------------------------------------------------------------------------

/** Prism cross-sections, metres. See the debug look for why a rig honest in metres is too loud. */
export const FOREARM_THICK = 0.042;
export const HAND_THICK = 0.056;
export const HAND_LENGTH = 0.12;
/** Matte dark panel fill, and the `#C9F2FF` seam over it. */
export const PANEL_RGB = hex(0x0a1a22);
export const PANEL_ALPHA = 0.62;
export const SEAM_ALPHA = 0.5;
/** The one-shot run of the seam pattern on grab: duration in seconds and band sharpness. */
export const SEAM_RUN_S = 0.42;
export const SEAM_RUN_GAIN = 1.6;

// ---------------------------------------------------------------------------------------------
// HUD (signal.md "Hands, halo, HUD")
// ---------------------------------------------------------------------------------------------

/** Halo: a signal-strength dial of 24 short strokes. */
export const HALO_SEGMENTS = 24;
export const HALO_RADIUS_PX = 31;
export const HALO_STROKE_PX = 7;
/** Energy: an inner bar-ring draining counterclockwise in quanta of ~4 energy. */
export const ENERGY_QUANTUM = 4;
export const ENERGY_RADIUS_PX = 21;
export const ENERGY_STROKE_PX = 4;
/** Ping acknowledgement: a square decode window that runs out once and fades. */
export const ACK_MS = 420;
export const ACK_SIZE_PX = 26;
/** How long a REFUSED ping's reason stays legible, seconds — a refusal makes no sound at all. */
export const REFUSAL_SHOW = 0.7;

// ---------------------------------------------------------------------------------------------
// Post (signal.md "Post chain")
// ---------------------------------------------------------------------------------------------

/**
 * The 0.75 % dither, applied INSIDE each layer's fragment shader rather than as a full-screen
 * pass, and signed so it cannot lift the void.
 *
 * The brief asks for "a 0.75 % static blue-noise dither over the final frame". A full-screen pass
 * cannot be that: over #000000 an additive dither turns absolute black into salt-and-pepper at
 * ~2/255, which breaks vision §1.3 ("absence is black") and violates signal.md's own "never
 * glitch at rest". Applied per layer and scaled by the fragment's own coverage, it does the job
 * the brief wants it for — killing banding on stain gradients and on the cooling ramp — and is
 * exactly zero wherever nothing is drawn.
 */
export const FRAME_DITHER = 0.0075;
