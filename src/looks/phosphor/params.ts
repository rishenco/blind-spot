/**
 * PHOSPHOR — the tuning surface (doc/looks/phosphor.md "Tuning surface").
 *
 * Everything a playtest would reach for lives here: the palette table, the persistence mix, the
 * strike, the rim, the post-chain amounts, the quality curve and the dot geometry. Nothing in this
 * file is a law — the laws are in the shaders that read it (aging semantics, event-colour meanings,
 * the quality→stain mapping, distance discipline) and in `core/const.ts`, which a look may read and
 * may never re-tune (engine-plan §9).
 *
 * Colours are authored as hex, exactly as the brief tables them, and converted once. They are
 * written straight to `gl_FragColor` with no colour-space conversion — the same convention the rest
 * of the renderer uses — so a hex here is the hex that lands on the glass.
 */

export type RGB = readonly [number, number, number];

const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/**
 * THE PALETTE (doc/looks/phosphor.md "Palette").
 *
 * Matter stays cyan-family and age is temperature (vision §3.2, visual-brief §2): the school picks
 * the exact ramp inside the family and nothing else. Phosphor's is green-leaning — the warmest of
 * the three machine looks — and it never leaves the family for pure scope green.
 *
 * Two parallel ramps, not one: an edge line is "slightly brighter than dots of the same age" (the
 * brief), which is what turns an old area from a cloud into a line drawing (visual-brief §1.12)
 * without ever giving edges a hue of their own.
 */
export const PALETTE = {
  /** Matter: the strike, the first 0.4 s. */
  fresh: hex(0xeffff8),
  /** Matter: hot. */
  hot: hex(0x7dffd4),
  /** Matter: mid — the look's signature tone. */
  mid: hex(0x1fd4a8),
  /** Matter: cool. */
  cool: hex(0x0e6b5b),
  /** Matter: the permanent memory skeleton, drawn at SKELETON_ALPHA (vision §3.6). */
  skeleton: hex(0x07332c),

  /** Edge lines, same five ages, each a notch brighter than the dot of that age. */
  edgeFresh: hex(0xeffff8),
  edgeHot: hex(0xbfffe9),
  edgeMid: hex(0x6febcb),
  edgeCool: hex(0x1b8c77),
  edgeSkeleton: hex(0x0e5b4e),
  /** Holds: "dots are matter, lines are holds" (vision §5) — brighter AND wider. */
  hold: hex(0xe4fff4),

  /** The racing rim: white core, hot-cyan skirt. */
  rimCore: hex(0xffffff),
  rimSkirt: hex(0x7dffd4),

  /**
   * Contact-shell-only geometry (vision §3.1): surfaces you are touching but have not heard. Kept
   * inside the family and clearly cooler than any painted age, so "I can feel this" and "I heard
   * this" are never the same pixel. Its dimness is carried by ALPHA — a colour dark enough to read
   * as faint would round to black in 8 bits and the shell would simply not exist.
   */
  shell: hex(0x2e6d63),

  /** Event layer (vision §3.2's table). Meaning is hue + FORM + motion — see marks.ts. */
  evSelf: hex(0xffb454),
  evDog: hex(0xff5a3a),
  evProp: hex(0xe6d97a),
  evObjective: hex(0xffcf4d),
  evDetonation: hex(0xffffff),
  /**
   * Teammate green. Not in phosphor's own table because this prototype is solo; the colour is
   * vision §3.2's and the steady glyph pip that must accompany it is implemented, so the co-op
   * milestone inherits a layer that already obeys the colourblind law rather than one that owes it.
   */
  evTeammate: hex(0x4dff8c),

  /** A dog's ghost: hot at the freeze, rusting as the belief goes stale (vision §3.7). */
  ghostHot: hex(0xff5a3a),
  ghostRust: hex(0x8a3b2a),

  /** HUD: the graticule, the energy arc, the reticle. Events never recolour any of it. */
  hud: hex(0x9fffe0),
} as const;

// ---------------------------------------------------------------------------------------------
// Persistence — THE school signature
// ---------------------------------------------------------------------------------------------

/**
 * Accumulation mix, quoted per frame at 60 Hz (the brief's number).
 *
 * The compositor does not use it as a per-frame constant, because a per-frame constant is a
 * different afterglow on every machine: at 144 Hz it would decay 2.4× faster in wall time, and the
 * one thing this look is about would be refresh-rate dependent. It is converted once into a TIME
 * CONSTANT (`accumTau`) and re-derived per frame from the real elapsed time, so the trail is the
 * same length in seconds everywhere.
 */
export const ACCUM_MIX = 0.9;
/** The brief's hard ceiling: "afterglow mix never above 0.92 (porridge risk)", as a time constant. */
export const ACCUM_MIX_MAX = 0.92;

const tauOf = (mix: number): number => -1 / (60 * Math.log(mix));

/** Persistence half-life, seconds. ~0.158 s at the brief's 0.90, capped at the 0.92 equivalent. */
export const ACCUM_TAU = Math.min(tauOf(ACCUM_MIX), tauOf(ACCUM_MIX_MAX));

/** Per-frame mix for a frame that took `dt` seconds. Exported for the compositor and for reading. */
export const accumMix = (dt: number): number => Math.exp(-Math.max(0, dt) / ACCUM_TAU);

// ---------------------------------------------------------------------------------------------
// The age ramp's approach
// ---------------------------------------------------------------------------------------------

/**
 * How fast the walk between the age stops is FRONT-LOADED. Core owns the clock (AGE_FLASH, AGE_HOT,
 * AGE_MID, AGE_COOL); this owns only how quickly the eye is let into the colour family between two
 * stops, and 1.0 would be the plain linear walk.
 *
 * It is below 1 because a linear walk makes the school's own signature tone unreachable during
 * play. AGE_FLASH is 0.35 s and AGE_HOT is 2.5 s, so linearly, paint 0.7 s old is 16 % of the way
 * from ice-white to the hot mint — still, to the eye, white. A sprint footfall repaints a 7 m
 * radius every ~0.35 s, so while the player is MOVING every dot in the frame is under a second old,
 * and the whole field reads as white grain. The green-leaning cyan the brief calls "the look's
 * signature tone" would then exist only in rooms nobody is moving through — the look would be
 * absent exactly when the game is being played.
 *
 * Front-loading the approach fixes that without touching the clock: the stops are the same tones at
 * the same times, age still only ever moves one way, and a fresh dot is still ice-white at the
 * instant it is struck. It just stops being white for a second and a half afterwards.
 */
export const AGE_EASE_HOT = 0.42;
/** The same, for the hot → mid leg, which is the one that carries the signature tone. */
export const AGE_EASE_MID = 0.6;

// ---------------------------------------------------------------------------------------------
// The strike, the dying grain, the rim
// ---------------------------------------------------------------------------------------------

/** Fresh dots overshoot this much brightness at the instant of the strike, then settle. */
export const STRIKE_OVERSHOOT = 0.35;
/** …over this long, in milliseconds (the brief's 0.4 s). */
export const STRIKE_MS = 400;
/** Reduce-flashing (vision §12): the overshoot becomes a plain ease — smaller, and slower. */
export const STRIKE_CALM_SCALE = 0.35;
export const STRIKE_CALM_STRETCH = 1.6;

/**
 * The dying grain: ±3 % luminance, ONCE, as a dot crosses cool → skeleton, never repeating.
 *
 * Staggered by each dot's own stable dither, so the field does not blink in unison — it is the
 * slow scintillation of a scope trace giving up, spread over the 45 s the transition takes. Zero
 * under reduce-flashing.
 */
export const DYING_FLICKER = 0.03;
/** Width of one dot's flicker, as a fraction of the cool→skeleton band. 0.03 × 45 s ≈ 1.4 s. */
export const DYING_FLICKER_WIDTH = 0.03;

/**
 * Rim depth in metres (the brief's "~0.6 m deep band").
 *
 * A look may style the rim's width, brightness and trail but may NOT change its timing
 * (visual-brief §2): the rim is `now − paintTime < RIM_WINDOW` and that stays. Depth is a width,
 * and a width in metres becomes a width in seconds only against the wavefront that is sweeping —
 * so the look converts it with the wave speed of the travelling event currently in flight, and
 * clamps the result inside RIM_WINDOW. Instant classes never touch it: they have no wavefront to
 * be a band on, and their flash is the strike.
 */
export const RIM_DEPTH = 0.6;
/** "E-ping rim slightly elongated along the beam direction" — the sweep axis IS the beam axis. */
export const RIM_E_ELONGATE = 1.7;
/** Extra splat size inside the rim, so the band reads as a band and not only as a brightening. */
export const RIM_SIZE_GAIN = 0.15;
/**
 * The visible drag behind the rim, seconds. Not a separate effect: it is the persistence buffer,
 * and this is the number ACCUM_TAU is chosen to deliver (0.158 s ≈ the brief's 0.2 s tail).
 */
export const RIM_TAIL = ACCUM_TAU;

// ---------------------------------------------------------------------------------------------
// Dots (visual-brief §2 "Near field: dots stay dots")
// ---------------------------------------------------------------------------------------------

/**
 * THE DOT CAP, as a fraction of frame HEIGHT — the ceiling on a splat's projected footprint.
 *
 * RECONCILING TWO NUMBERS. Visual-brief §2 fixes the cap at "order 8–14 px at 1080p" and phosphor's
 * own brief asks for "3–4 px at 1080p near". They are not the same measurement: the brief's 3–4 px
 * is the SPRITE'S BRIGHT CORE — the grain you perceive — and the cap is the whole sprite, most of
 * which is the gaussian skirt and the 1.5× halo that make the core read soft rather than hard. So
 * the sprite is capped at 0.0085 × height (9.2 px at 1080p, the bottom of §2's band, which suits
 * the tightest of the three looks) and DOT_CORE_SIGMA is set so the lit core inside it is ~3.7 px.
 * Both numbers are honoured, and neither is quietly reinterpreted.
 *
 * Relative to height for the same reason the debug look's is: the only scale that matters is the
 * lattice's screen PITCH, which is set by frame height, so a cap in absolute pixels would mean a
 * different thing in every window.
 */
export const DOT_CAP_FRAC = 0.0085;
/**
 * Gaussian core sigma, in sprite RADII — `r` runs 0 at the centre to 1 at the sprite's edge, so a
 * gaussian's full width at half maximum is 2 × 1.177σ radii, which is 1.177σ of the DIAMETER.
 * At σ = 0.34 that is a lit core of 0.4 × 9.2 ≈ 3.7 px at 1080p: the brief's number, measured.
 */
export const DOT_CORE_SIGMA = 0.34;
/** The micro-glow: a tight 1.5× halo baked into the sprite. No bloom pass, ever (the brief). */
export const DOT_HALO_SIGMA = DOT_CORE_SIGMA * 1.5;
export const DOT_HALO_GAIN = 0.22;
/**
 * Sigma for a splat sitting on its pixel floor. The core sigma on a 3 px sprite is a sub-pixel
 * spark, so the profile FLATTENS as the sprite shrinks — at 0.62 radii a floor-sized sprite is lit
 * almost edge to edge. The far field must keep its "≥2–3 px and temporally stable" dots (vision
 * §12), not merely allocate them the point size and then draw a spark inside it.
 */
export const DOT_SMALL_SIGMA = 0.62;
/** Sprite sizes below this use the flat profile, above DOT_LARGE_PX the tight core, between: mixed. */
export const DOT_SMALL_PX = 4.0;
export const DOT_LARGE_PX = 8.0;
/** Compensates the energy a gaussian profile loses against the hard disc the floors assume. */
export const DOT_ALPHA_GAIN = 1.18;

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

/**
 * WebGL fixes `gl_LineWidth` at 1, so every width in this look is built from offset passes over
 * the same geometry (the debug look does the same for its holds). Hairline 1.5 px = the base pass
 * plus a dimmer half-pixel-offset pass; a hold's +20 % is a third, brighter, wider-offset pass.
 */
export const LINE_SOFT_OFFSET_PX = 0.55;
export const LINE_SOFT_ALPHA = 0.5;
export const HOLD_OFFSET_PX = 1.0;
/** View-space nudge toward the camera, metres — a crease line sits ON the surfels it creases. */
export const LINE_LIFT = 0.02;

// ---------------------------------------------------------------------------------------------
// Noise stains (visual-brief §1.13, §2 — the quality mapping is FIXED, the styling is not)
// ---------------------------------------------------------------------------------------------

/**
 * THE QUALITY CURVE. `q` is the delivered quality; this gamma is the one tuning knob on the
 * mapping's *shape*, never on its direction: a confident read is always tighter, brighter and
 * better defined than a vague one (visual-brief §1.13). Below 1 it spends more of the range on the
 * good reads, which is where a player's attention actually goes.
 */
export const STAIN_Q_CURVE = 0.8;
/**
 * High quality: tight, 0.5–1 m, with a bright core. Low quality: 2.5–4 m at the brief's 20 % alpha
 * and no core — pure breath. The peak is ADDITIVE over the void, so it is the light the stain adds
 * at its own centre, not a coverage: 0.55 of `#FF5A3A` is a legible ember, not a lit shape.
 */
export const STAIN_R_HIGH_Q = 0.75;
export const STAIN_R_LOW_Q = 3.2;
export const STAIN_A_HIGH_Q = 0.55;
export const STAIN_A_LOW_Q = 0.2;
/** The faint concentric ring a high-quality stain carries, as a fraction of its radius. */
export const STAIN_RING_R = 0.62;
export const STAIN_RING_W = 0.12;
export const STAIN_RING_GAIN = 0.45;
/** Onset, seconds — a stain has no strobe, so comfort mode shows up as a longer, softer arrival. */
export const STAIN_ONSET = 0.07;
export const STAIN_ONSET_CALM = 0.34;
export const STAIN_CALM_ALPHA = 0.62;
/** Smallest a stain may draw, CSS px: below this it is a shimmering sub-pixel (vision §12). */
export const STAIN_MIN_PX = 3;
/**
 * How much larger than a splat a stain may draw. A stain is an airy annotation, so it is allowed
 * to be bigger than the grain it annotates — but not unbounded: at 10× the cap a 3 m smudge heard
 * from arm's length is ~8 % of frame height instead of most of the frame.
 *
 * The cap is reached at any range you can actually hear something from, so it — not the projection
 * — is what sets a stain's size on screen most of the time. A single cap would therefore erase the
 * quality read the radius exists to carry, so the ceiling itself scales with the stain's vagueness:
 * a confident mark is allowed 40 % of it, a pure breath all of it (visual-brief §1.13).
 *
 * The floor of that range is what sets the number: a confident mark gets 40 % of the cap, and it
 * has to be big enough to draw a FORM in — a four-spike star or a dart fan inside 20 px is a dot,
 * and the form is how this look pays the colourblind law (vision §12).
 */
export const STAIN_CAP_MULT = 10.0;
export const STAIN_CAP_TIGHT = 0.4;
/**
 * A stain closer than this to the eye fades out, and it is gone entirely at a quarter of it.
 *
 * Not a softening of the law — the event happened and its paint is on the walls. It is that a
 * gaussian smudge centred ON the eye is a veil over the whole frame rather than a mark at a place,
 * and your own noise is already reported exactly, continuously, by the halo (vision §3.8). Your
 * footfalls are 1.7 m below the eye and land outside this, so the amber pools the brief asks for
 * are untouched; what it removes is the blob that would otherwise sit on the reticle after a ping.
 */
export const STAIN_NEAR_FADE_M = 1.6;
/** One gait tick's pulse: the dog stain arrives with a kick (the brief). Off under reduce-flashing. */
export const STAIN_DOG_PULSE = 0.25;
export const STAIN_DOG_PULSE_S = 0.12;
/** The objective's 4 s breath. Halved rather than removed under reduce-flashing — it is a fade. */
export const STAIN_BREATH_PERIOD = 4.0;
export const STAIN_BREATH_AMT = 0.1;
/** How many stains may be alive at once. A hard ring, oldest overwritten (vision §12). */
export const STAIN_CAP = 96;
/**
 * How near a previous dog stain has to be for this one to count as the same animal moving.
 * A gait tick every 0.8 m (DOG_GAIT_STRIDE), so 3 m is a generous three strides — and when nothing
 * is that close the stain simply carries NO darts. A direction the data does not contain is not
 * invented (vision §1 law 2).
 */
export const DOG_LINK_RADIUS = 3.0;
/**
 * …and how recently it must have happened. An event carries no emitter id, so "the same animal
 * moving" is inferred from proximity in space AND in time. A gait tick is every 0.8 m, which is
 * 0.27 s at patrol and 0.11 s at chase, so this is a loose bound on one stride and a tight bound
 * against two different dogs three metres apart being welded into one direction.
 */
export const DOG_LINK_MAX_DT = 0.9;
export const DOG_DART_COUNT = 3;

// ---------------------------------------------------------------------------------------------
// The dog cloud and its ghosts
// ---------------------------------------------------------------------------------------------

/** Alpha of the newest heard pose at quality 1. */
export const DOG_ALPHA = 0.9;
/** How much fainter each older smear sample is (vision §3.7's 0.3 s of motion smear). */
export const DOG_SMEAR_DECAY = 0.5;
/**
 * How long a fresh ghost holds its heat before it starts to rust, seconds.
 *
 * "The frozen pose keeps afterglow for its first second (it visibly stops)" — a plateau INSIDE the
 * ten seconds core gives the ghost, never an extension of them. The dissolve still begins at
 * DOG_GHOST_LIFE and ends at DOG_GHOST_DISSOLVE later: styling may not move core's clock.
 */
export const GHOST_HOLD = 1.0;

// ---------------------------------------------------------------------------------------------
// Post chain (the brief's numbered list)
// ---------------------------------------------------------------------------------------------

/**
 * Scope-glass grain: 1 % luminance, chroma-free, and MULTIPLICATIVE.
 *
 * Additive grain would lift the void off #000000, and the void is absolute (visual-brief §1.7):
 * unknown space is nothing, not a very dark something. Multiplying leaves black exactly black and
 * puts the 1 % where there is already light, which is where glass grain lives anyway.
 */
export const GRAIN_AMT = 0.01;
/** The static horizontal line pattern, 4 %, one CSS pixel, no roll. Multiplicative, same reason. */
export const SCANLINE_AMT = 0.04;

// ---------------------------------------------------------------------------------------------
// HUD (the brief's "Hands, halo, HUD")
// ---------------------------------------------------------------------------------------------

/** Graticule radius in CSS px, and the tick spacing. One glance point (visual-brief §1.10). */
export const HALO_RADIUS_PX = 34;
export const HALO_TICK_DEG = 30;
export const HALO_TICK_PX = 4;
/** The energy arc sits inside the ring, thinner. */
export const HALO_ENERGY_INSET_PX = 6;
/** Ring brightness floor, so the instrument is findable in total silence. The reading is the ramp. */
export const HALO_MIN_ALPHA = 0.06;
export const HALO_MAX_ALPHA = 0.68;
/** How long the ping acknowledgement ring takes to race out and fade, seconds. */
export const RIM_PULSE = 0.4;
/** How long a refused ping's cue stays up, seconds — silence is the one answer that needs saying. */
export const REFUSAL_SHOW = 0.6;

// ---------------------------------------------------------------------------------------------
// Hands (visual-brief §1.6: faint machine hands, only on interaction)
// ---------------------------------------------------------------------------------------------

/**
 * Cross-section of the forearm prism at the ELBOW end, metres, and the multiplier at the wrist.
 *
 * Core's rig puts the elbow ~0.36 m in front of the eye and the wrist ~0.62 m, so a forearm bone is
 * about 0.6 m long. A constant 0.042 m box across that length is a 14:1 stick, and at a 95° FOV it
 * photographs as two scaffolding poles running off the bottom of the frame — a hollow girder, not a
 * limb. 0.078 → 0.052 is 8:1 at the elbow closing to 12:1 at the wrist, which is a machine forearm:
 * the taper alone tells the eye which end is the hand before the hand itself is read.
 */
export const FOREARM_THICK = 0.078;
export const FOREARM_TAPER = 0.66;
/**
 * Where along the forearm its outline starts to exist: 0 is the elbow, 1 the wrist.
 *
 * The rig has no shoulder and never will — core's bone starts 0.36 m in front of the eye and runs
 * 0.6 m, so at a 95° FOV the elbow end is off-frame and enormous, and an outline carried all the way
 * there hits the frame edge at full strength and reads as a scaffolding pole of unknown length. Only
 * the wrist-most ~55 % is drawn; behind that the limb dissolves into the dark, which is both what
 * "faint machine hands" (visual-brief §1.6) asks for and the only honest thing to do with a bone
 * that has no visible root.
 *
 * The FILL keeps its full length regardless: it is the occluder, and a gap in it would show the room
 * through the arm.
 */
export const FOREARM_EDGE_FADE_FROM = 0.45;
/** The hand: wider than the wrist it continues and flattened, so it reads as a paddle, not more arm. */
export const HAND_THICK = 0.072;
export const HAND_LENGTH = 0.15;
/** Dark bodies with phosphor-edge outlines: the fill is nearly void, the outline carries the read. */
export const HANDS_FILL = hex(0x04100e);
export const HANDS_FILL_ALPHA = 0.55;
export const HANDS_EDGE_ALPHA = 0.62;

// ---------------------------------------------------------------------------------------------
// GLSL helpers
// ---------------------------------------------------------------------------------------------

/** A float literal GLSL will accept — `1` is an int in GLSL and will not compile as a float. */
export const f = (v: number, digits = 4): string => {
  const s = v.toFixed(digits);
  return s.includes('.') ? s : `${s}.0`;
};

/** A palette entry as a GLSL constructor, inlined at shader-build time (no uniform, no upload). */
export const v3 = (c: RGB): string => `vec3(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;

/**
 * THE GRAIN, as GLSL: `grain(r, sizePx)` for `r` running 0 at the sprite's centre to 1 at its edge.
 *
 * One definition, used by the world lattice and by the dog cloud, because a dog is matter and must
 * be made of the same stuff the walls are — two profiles would make a dog a different KIND of dot
 * and put a tell in the image that the fiction does not have.
 */
export const GRAIN_GLSL = /* glsl */ `
float grain(float r, float sizePx) {
  // The core tightens as the sprite grows: a floor-sized sprite is lit almost edge to edge (or it
  // is a sub-pixel spark), a near one carries the brief's 3–4 px core inside a soft skirt.
  float sig = mix(${f(DOT_SMALL_SIGMA)}, ${f(DOT_CORE_SIGMA)}, smoothstep(${f(DOT_SMALL_PX)}, ${f(DOT_LARGE_PX)}, sizePx));
  float sigH = sig * ${f(DOT_HALO_SIGMA / DOT_CORE_SIGMA)};
  float rr = r * r;
  float core = exp(-rr / (2.0 * sig * sig));
  float halo = exp(-rr / (2.0 * sigH * sigH)) * ${f(DOT_HALO_GAIN)};
  // The halo still carries light at the sprite's edge and the edge is a hard discard: without this
  // window every grain would wear a faint circular cut, the one shape a soft-core splat cannot have.
  return min(1.0, core + halo) * (1.0 - smoothstep(0.72, 1.0, r));
}
`;
