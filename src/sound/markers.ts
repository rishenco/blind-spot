/**
 * The sound layer — concept, "Звуковой слой — это НЕ свет".
 *
 * This is the law that gets misread most often, so it is worth restating at the top of the file
 * that implements it: a mark is drawn **at the point where the event happened, and nowhere
 * else.** It lights nothing. It casts nothing. It does not enter any lighting calculation,
 * because there is no lighting calculation. A can that clatters two metres from a wall leaves a
 * blob floating in the dark two metres from a wall, and the wall stays black unless the lidar or
 * your hand has been there. If you can tell what a room looks like from its sounds, this file is
 * broken. A soft blurred blob is a way of drawing the *fact* "a sound happened here" — it is not
 * a lamp, and nothing downstream may treat it as one.
 *
 * The visual language is a thermal imager: almost the whole frame is transparent, and there is
 * "heat" exactly where the sound was. Soft, blurred, hot in the middle and bleeding to nothing at
 * the edge. This is deliberately the opposite of the geometry layer, which is hard cold pixel-size
 * dots and thin contour lines. Matter is points; sound is a blob. At a glance you must never have
 * to work out which of the two you are looking at — one is sharp and cold, the other is soft and
 * warm, and they never rhyme.
 *
 * Marks outlive their sounds and fade slowly, so what you are really looking at is a decaying
 * heat-map of the last few seconds of the room. Your own footsteps are in it. They are drawn
 * under your own feet, they tell you nothing you did not know, and that is the joke the concept
 * is making — the cost is real and the information is zero.
 *
 * Implementation: one persistent GPU buffer used as a ring, one instanced quad per event,
 * expanded into a soft blob in the fragment shader. Nothing is rebuilt when a mark ages; the
 * shader derives everything from `now - birth`. Emitting an event writes a handful of floats into
 * a slot and uploads that slot's range, so a collapsing stack costs a few hundred bytes of
 * `bufferSubData` and no allocation at all.
 *
 * Two things about the geometry are load-bearing and were both bugs before this pass:
 *
 *  - **The blob is measured in reference pixels, not device pixels.** `uScale` and the radius
 *    clamps are quoted for a 720-pixel-tall drawing buffer and multiplied by the real buffer
 *    height at draw time. Without that, the same code drew a mark covering 30% of a 1280x720
 *    keyframe and 5% of the same view on a 1440p screen at devicePixelRatio 2 — which is exactly
 *    the "the generator shows a meteorite, my game shows little puffs" report. A perception
 *    channel cannot change meaning when the window is resized.
 *  - **Quads, not point sprites.** `gl_PointSize` is clamped by the driver (1024 px on plenty of
 *    hardware) and a point sprite is culled by its *centre*, so a big mark popped out of
 *    existence the moment its origin left the frustum — precisely when you turn to look back at
 *    your own trail. Instanced quads have neither problem and cost the same fill.
 */
import * as THREE from 'three';

import type { SoundEvent, SoundSource } from '../events/bus';
import { isSoundPerceivableAt, soundPerceptionRange } from '../events/perception';

/** One sprite per event. The blob is made in the fragment shader, not out of particles. */
const PER_MARKER = 1;

/**
 * Per-source hot-core colour and weight. Everything lives in the warm half of the spectrum on
 * purpose — the geometry layer owns cold white/grey, so warmth alone already says "this is the
 * other channel".
 *
 * The gains used to bias the player's own noise *down* (a step was 0.4 of a prop impact), which
 * fought the one thing this layer is for: the size and the glare of a mark are the bill for the
 * mistake you just made, and a sprinting player is the loudest thing in the hall until the rifle
 * goes off. Loudness alone decides how big and how hot a mark burns; the gain is now only a
 * small per-source character shift.
 */
/**
 * Who made the noise, in the only three categories the *look* has ever needed: it was you, it was
 * the world reacting to you, or it was something alive that is not you. Some styles ignore this
 * entirely; `echo` is built on it.
 */
const KIND_SELF = 0;
const KIND_WORLD = 1;
const KIND_ALIEN = 2;

const SOURCE_LOOK: Record<SoundSource, { color: number; gain: number; kind: number }> = {
  'player-step': { color: 0xff8438, gain: 1, kind: KIND_SELF },
  'player-land': { color: 0xff7a28, gain: 1.1, kind: KIND_SELF },
  'prop-impact': { color: 0xffc46a, gain: 1, kind: KIND_WORLD },
  gunshot: { color: 0xfff0c0, gain: 1.15, kind: KIND_SELF },
  'bullet-hit': { color: 0xffd890, gain: 1.3, kind: KIND_WORLD },
  // The magazine swap: your own noise, and small. Cooler than a muzzle blast on purpose — it is
  // metal handled, not powder burnt.
  reload: { color: 0xffb060, gain: 0.9, kind: KIND_SELF },
  spider: { color: 0xff9ec0, gain: 1, kind: KIND_ALIEN },
  // M7 hook — a minimal, required addition, not a design pass on this file: `radio` is a new
  // `SoundSource` (see `src/events/bus.ts`), and `SOURCE_LOOK` is a `Record<SoundSource, …>`, so
  // leaving it out would not compile. Cool white-blue, `KIND_WORLD`: it is an object making
  // noise in the hall, not the player's own body and not something alive.
  radio: { color: 0xbfe0ff, gain: 1, kind: KIND_WORLD },
};

/**
 * The looks. The human has now rejected two rounds of these, so this is not a palette exercise:
 * it is three *different theories* of what the sound channel is, plus the four earlier answers
 * kept for comparison. Switchable at runtime (GUI → sound markers → style, or
 * `bs.markerStyle(name)`), and the frame set shoots one identical moment through every one.
 *
 * What other games did with the same problem, and what was taken from each:
 *
 *  - **Dark Echo** draws sound as white lines and nothing else — until the sound belongs to the
 *    thing hunting you, and then it is red. Two colours in the whole game, and neither of them
 *    means "how loud"; loudness is length and count. The lesson: a perception channel is easier
 *    to read when hue means *who*, and everything else is carried by size and brightness. That
 *    is `echo`.
 *  - **Alien: Isolation**'s motion tracker never pretends to show the room. It is an instrument
 *    with a sweep and a ping, and its readings are events in time, not lights in space. The
 *    lesson: make the mark *behave* like a reading — bloom outward from the epicentre and settle —
 *    so it can never be mistaken for illumination. That is `pulse`.
 *  - **Perception** and **Stifled** render echolocation as a cold monochrome wash and reserve
 *    every warm/saturated colour for danger, because warm light in a dark game reads as fire and
 *    the brain files it under "illumination". Our muzzle flash is the only real light in the game
 *    and it is amber, so a warm sound layer competes with it. The lesson: put the sound channel on
 *    the cold-magenta side of the wheel, where neither the amber flash nor the cyan lidar lives.
 *    That is `bruise`.
 *  - **Scanner Sombre** is the counter-example worth naming: its distance-coded rainbow point
 *    cloud is exactly what our *geometry* layer is, and it is why the sound layer must not use a
 *    long many-hue ramp — two rainbow channels on one screen stop being two channels. That is the
 *    case against `iso`.
 *
 *  - `echo`   Dark Echo's rule. One bone-white blob for everything in the world, red only for
 *             something alive that is not you. Loudness is size and brightness alone — no hue
 *             ramp at all, so a crowd of marks never turns into a colour salad.
 *  - `pulse`  the instrument reading, and the only style in the set with a **hollow** middle.
 *             Three thin shells leave the epicentre, cross the mark in about half a second and
 *             dissolve at the rim, leaving a hard pinpoint and nothing else. Light fills; a
 *             reading rings — so a hollow expanding circle is the strongest available statement
 *             that this is not a lamp. Round one of it (one fat shell over a filled core) is
 *             kept as `pulse-v1` for the before/after.
 *  - `bruise` cold-side thermal: deep indigo body, magenta mid, hot pink core. Occupies the one
 *             part of the colour wheel neither the lidar (cyan) nor the muzzle flash (amber) uses,
 *             so it can never be mistaken for either.
 *  - `ember`  round one: white-hot pinpoint core, amber body, deep-red rim.
 *  - `iso`    round one: a thermal camera's isotherms, violet → red → orange → yellow → white.
 *  - `coal`   round one: nearly all epicentre, almost no aura.
 *  - `bloom`  round one: no core at all, one soft monochrome haze. It was the default only
 *             because it was what he happened to be tuning with by hand.
 *  - `pulse-v1` the first answer to `pulse`, kept purely as the control for the before/after.
 *
 * `echo` is the default: it is the one he picked out of the seven by eye.
 */
export type MarkerStyle =
  | 'ember'
  | 'iso'
  | 'coal'
  | 'bloom'
  | 'echo'
  | 'pulse'
  | 'bruise'
  | 'pulse-v1';

export const MARKER_STYLES: readonly MarkerStyle[] = [
  'echo',
  'pulse',
  'bruise',
  'ember',
  'iso',
  'coal',
  'bloom',
  'pulse-v1',
];

const STYLE_INDEX: Record<MarkerStyle, number> = {
  ember: 0,
  iso: 1,
  coal: 2,
  bloom: 3,
  echo: 4,
  pulse: 5,
  bruise: 6,
  'pulse-v1': 7,
};

export interface MarkerTunables {
  /** How long a mark survives, seconds. Far longer than the sound — that is the point. */
  life: number;
  /**
   * Radius of a reference-loud mark seen at one metre, before the distance falloff, in
   * **reference pixels**: pixels on a 720-pixel-tall drawing buffer. Every radius knob in this
   * struct is in that unit, and the shader multiplies by (real buffer height / 720). Quoting them
   * in raw device pixels is what made the keyframes and the live game disagree — see the file
   * header. This is the master knob of the whole scale.
   */
  scale: number;
  /** The loudness, in metres of notice, that `scale` is quoted for. A walking footstep is 9. */
  loudRef: number;
  /**
   * How hard loudness bites. Above 1 the scale is stretched: the gap between a can ticking and a
   * barrel going over grows faster than the gap in the physics. That stretch is the point — the
   * mark is an error indicator, and the eye has to read "how badly did I just give myself away"
   * in one glance, not by comparing two blobs.
   */
  loudPower: number;
  /** Smallest and largest on-screen radius, reference pixels. */
  minRadius: number;
  maxRadius: number;
  /**
   * Radius, in reference pixels, above which a blob starts paying for the screen it covers. It exists so a
   * can dropped at your boot does not become a white sun — but it used to be set at 38 px, which
   * meant *everything* interesting was being dimmed and the whole loudness scale collapsed into
   * the quiet end. It is now far out of the way of ordinary marks.
   */
  spread: number;
  /** Falloff exponent of the blob. Low = wide woolly haze, high = tight core. */
  softness: number;
  brightness: number;
  /**
   * The ceiling the channel is allowed to reach, 0..1 — M6a, and the human's own reasoning:
   * "если фон и так белый, вспышке нечем светить". A big mark used to saturate its centre to
   * pure white, and once a corner of the frame is white the muzzle flash — the only real light
   * in the game, and the thing the whole shot is paid for — has nothing left to add. So the
   * layer stops a shade below white and stays a *readout* rather than a light source.
   */
  peak: number;
  /**
   * Whether overlapping marks are capped as well as single ones.
   *
   * Clamping one fragment is not enough on its own: under additive blending five marks at 0.7
   * still sum to white, and "big areas of noise" are exactly where several marks pile up. With
   * this on, the layer composites with `max` instead of `+` — the brightest mark at a pixel wins
   * and nothing ever accumulates past `peak`. Off restores the old additive sum, kept because
   * the two are worth comparing on the same frame rather than argued about.
   */
  capOverlap: boolean;
  style: MarkerStyle;
}

export function defaultMarkerTunables(): MarkerTunables {
  /*
   * The human tuned these by hand in the live game and asked for his set to become the baseline:
   *   style bloom, life 7, scale 375, loudRef 9, loudPower 0.9,
   *   minRadius 35, maxRadius 720, spread 150, softness 1.5, brightness 1
   *
   * Everything that describes the *shape* of the response is his, verbatim: life, loudRef,
   * loudPower, softness, brightness and the style. Those are the numbers he was actually judging.
   *
   * The four radius knobs are not his, and this is the one place where following the spec to the
   * letter would have been wrong. He was tuning against the resolution bug: on his screen every
   * mark was drawn a factor of two-ish smaller than the same code drew it in the keyframes, so he
   * turned the radii up until they looked right *through that shrinking*. With the bug fixed the
   * shrinking is gone, and his numbers, applied honestly, do not produce a trail — they produce a
   * white screen. That is not a guess: the sprint scenario at scale 375-equivalent covers 100% of
   * the trail window and 92% of the hall beside it, and the picture is one featureless plume with
   * no footfalls in it at all.
   *
   * So the radii are set from the frame instead, at the value where the sprint reads as what it
   * is meant to be — a line of separate burning footfalls receding into the dark, unmissable but
   * still a trail. That lands near a third of his figure in the new unit. Measured over the same
   * scenario: scale 260 -> 58% of the frame lit, one plume; 170 -> 37%, footfalls just merging;
   * 130 -> 27%, the trail readable end to end; 85 -> 18%, honest but no longer alarming.
   *
   * If he wants it louder, the knob to reach for is `brightness`, not `scale`: past ~170 the
   * marks stop being events and start being a floodlight, which is the one thing law 2 forbids.
   */
  /*
   * `minRadius` is the floor for far and quiet events, and it is set by the bullet impacts. A
   * round landing 50 m away is the second honest use of shooting — "очередь в темноту рисует
   * россыпь меток там, куда попала" — and at the old floor of 12 reference px that scatter came
   * out as a handful of dots on the edge of noticeability. 22 keeps them small next to anything
   * nearby, but they read as marks rather than as speckle.
   */
  return {
    life: 7,
    scale: 130,
    loudRef: 9,
    loudPower: 0.9,
    minRadius: 22,
    maxRadius: 240,
    spread: 110,
    softness: 1.5,
    brightness: 1,
    /*
     * 0.68. Chosen against the one thing the ceiling is for: the muzzle flash's own frame. The
     * flash lifts what it hits to nearly full white, so the noise layer has to sit far enough
     * below that for the difference to still read as *light arriving*. Two thirds is that
     * distance by eye on the shot keyframe; higher and the flash lands on a bright background,
     * lower and the loud end of the loudness scale stops being loud.
     */
    peak: 0.68,
    capOverlap: true,
    /*
     * `echo` is the human's pick out of the seven, made in the live game: "ехо визуал мне нрав".
     * It is therefore the baseline now, and `bloom` — which was the baseline only because it was
     * what he happened to be tuning with by hand — is one of the alternatives again.
     */
    style: 'echo',
  };
}

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uLife;
  uniform float uScale;
  uniform float uLoudRef;
  uniform float uLoudPower;
  uniform float uMinRadius;
  uniform float uMaxRadius;
  uniform float uSpread;
  /** Drawing-buffer size in device pixels. Both halves of the resolution fix live here. */
  uniform vec2  uViewport;

  attribute vec3  iPos;
  attribute float aBirth;
  attribute float aLoud;
  attribute float aSeed;
  attribute float aGain;
  attribute float aKind;
  attribute vec3  aTint;

  varying vec3  vColor;
  varying float vFade;
  varying float vSeed;
  varying float vHeat;
  varying float vAge;
  varying float vKind;
  varying float vBurn;
  varying vec2  vQuad;

  void main() {
    float age = uTime - aBirth;
    if (aBirth <= -1.0e8 || age < 0.0 || age > uLife) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    vec4 clip = projectionMatrix * mv;
    if (clip.w <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    /*
     * Size is loudness. The scale has to be *wide*: a spider's foot and a barrel going over are
     * a factor of ten apart in metres of notice, and on screen they have to be a factor of ten
     * apart too — small smudge versus a crater you cannot miss.
     *
     * Distance falls off slower than perspective (d^0.8). Not honest perspective: a far-off
     * sound would shrink to a pixel and start passing for geometry, which is the one thing this
     * layer must never do. Not screen-space either: a barrel at the far wall must not paint the
     * same crater as one at your feet.
     */
    float dist = max(0.8, -mv.z);
    float loud = max(0.4, aLoud);
    float norm = loud / max(0.5, uLoudRef);
    float radius = uScale * pow(norm, uLoudPower) / pow(dist, 0.8);
    radius = clamp(radius, uMinRadius, uMaxRadius);

    // A blob swells for a moment as the sound registers, then settles back. Cheap, and it is the
    // difference between "heat bloomed here" and "a circle switched on".
    float t = age / uLife;
    radius *= 0.62 + 0.42 * (1.0 - exp(-age * 11.0)) - 0.08 * t;

    // Fade: bright while the noise is news, then a long shallow tail.
    float decay = pow(1.0 - t, 1.4) * (0.74 + 0.26 * exp(-age * 1.6));
    /*
     * Loudness drives brightness as well as size, and it is allowed to win. A loud thing has to
     * look loud even when it is close enough to fill the frame — "если я как слон, то тут
     * китайский новый год должен начаться".
     */
    float loudGain = clamp(pow(norm, 0.7), 0.26, 1.6) * aGain;
    /*
     * The top of the loudness scale burns out. A rifle is 90 m of notice against 34 for the
     * loudest thing a prop can do and 16 for a sprinting footstep, and a burst puts five to eight
     * of those marks almost on top of each other; added together they clip to a flat white disc
     * with a yellow rim and say nothing except "you fired". vBurn is how far into that top end
     * an event is: nothing below ~3x the reference loudness is touched (a sprint step is 0, the
     * loudest prop impact barely 0.2), a gunshot is all the way at 1.
     */
    vBurn = smoothstep(2.6, 7.0, norm);
    // Some anti-glare is still wanted: a mark that covers a third of the screen would otherwise
    // wash the frame out. It bites only well past the size of an ordinary mark, is measured in
    // the same reference pixels as the radius, and is capped so even a crater keeps half its
    // punch — except for the burning end of the scale, which is allowed to be pulled down harder
    // because it is the one that clips.
    vFade = decay * loudGain * clamp(uSpread / radius, mix(0.5, 0.24, vBurn), 1.0);
    vColor = aTint;
    vSeed = aSeed;
    vAge = age;
    vKind = aKind;
    // How far up the thermal ramp this event is entitled to climb. Quiet noises stay red.
    vHeat = clamp(pow(norm, 0.55) * 0.62, 0.16, 1.0);

    /*
     * Reference pixels → device pixels. The radius above is quoted for a 720-tall buffer; on a
     * 1440p screen at devicePixelRatio 2 the buffer is 2880 tall and the same mark has to be four
     * times as many pixels across to mean the same thing to the eye. Without this line the
     * keyframe generator and the game disagree by exactly that factor.
     */
    float px = radius * max(1.0, uViewport.y) / 720.0;
    // The quad is a billboard in clip space: no gl_PointSize cap, and no centre-based culling
    // that would pop a big mark out of the frame as its origin crosses the edge.
    clip.xy += position.xy * px * 2.0 / uViewport * clip.w;
    vQuad = position.xy;
    gl_Position = clip;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uSoftness;
  uniform float uBright;
  uniform float uPeak;
  uniform float uStyle;
  varying vec3  vColor;
  varying float vFade;
  varying float vSeed;
  varying float vHeat;
  varying float vAge;
  varying float vKind;
  varying float vBurn;
  varying vec2  vQuad;

  /** The isotherm ramp: violet embers, red, orange, yellow, white. Temperature is loudness. */
  vec3 isoRamp(float v) {
    vec3 c = mix(vec3(0.16, 0.03, 0.30), vec3(0.72, 0.06, 0.14), smoothstep(0.00, 0.30, v));
    c = mix(c, vec3(1.00, 0.32, 0.04), smoothstep(0.26, 0.56, v));
    c = mix(c, vec3(1.00, 0.80, 0.16), smoothstep(0.54, 0.82, v));
    c = mix(c, vec3(1.00, 0.99, 0.92), smoothstep(0.80, 1.00, v));
    return c;
  }

  /**
   * One expanding shell of "pulse". "t" is where its front is, in units of the mark's radius;
   * it is invisible before it launches and gone once it has crossed the rim. The front smears
   * as it travels, the way a real reading loses confidence with distance.
   */
  float shell(float rr, float t, float gain) {
    if (t <= 0.0 || t > 1.25) return 0.0;
    float w = 0.055 + 0.075 * t;
    float ring = exp(-pow((rr - t) / w, 2.0));
    return ring * gain * (1.0 - smoothstep(0.80, 1.20, t));
  }

  void main() {
    vec2 d = vQuad * 0.5;
    float ang = atan(d.y, d.x);
    /*
     * A silhouette, not a disc. The radius is warped by two low-frequency lobes seeded per mark,
     * so every blob has its own lopsided shape — a smear of heat rather than a UI circle. The
     * warp is small: it must never read as a shape claim about the object that made the noise.
     */
    float warp = 1.0 + 0.18 * sin(ang * 2.0 + vSeed) + 0.11 * sin(ang * 3.0 - vSeed * 2.3);
    /*
     * The warp stretches the silhouette outwards, which can push the shape past the edge of the
     * quad — and a quad has corners, so a fat style came out with visible axis-aligned bites
     * taken out of it. The second factor fades whatever survives to nothing over the outermost
     * fifth of the quad, so the cut always happens where the blob is already black.
     */
    float rr = length(d) * 2.0;
    float r = rr / warp;
    /*
     * The cut is on the *unwarped* radius, so every style has the whole disc of the quad to draw
     * in and "pulse" can run a shell all the way out to the rim without the warp biting a lobe
     * out of it. The blob styles are unaffected: their "k" is clamped at zero from r >= 1
     * outwards, which is exactly where the discard used to be.
     */
    if (rr > 1.0) discard;
    float k = max(0.0, 1.0 - r) * smoothstep(1.0, 0.82, rr);

    float a;
    vec3 c;
    if (uStyle < 0.5) {
      // ember — pinpoint white core, amber body, deep-red rim.
      float body = pow(k, uSoftness);
      float core = pow(k, uSoftness * 2.8);
      a = body * 0.85 + core * 0.55;
      vec3 rim = vColor * vec3(0.72, 0.16, 0.05);
      c = mix(rim, vColor, smoothstep(0.0, 0.55, body));
      c = mix(c, vec3(1.0, 0.94, 0.86), core * 0.5 * vHeat);
    } else if (uStyle < 1.5) {
      // iso — a thermal camera's isotherm palette. Colour *is* loudness.
      float v = pow(k, uSoftness * 0.85) * vHeat;
      a = pow(k, uSoftness * 1.15) * (0.86 + 0.14 * sin(v * 26.0));
      c = isoRamp(v) * (0.45 + 0.55 * vHeat);
    } else if (uStyle < 2.5) {
      // coal — nearly all epicentre and almost no aura.
      float slug = smoothstep(0.0, 0.30, k);
      float ember = pow(k, uSoftness * 2.2);
      a = slug * 0.62 + ember * 0.22;
      vec3 cold = vec3(0.55, 0.05, 0.01);
      vec3 hot = vec3(1.0, 0.58, 0.10);
      vec3 base = mix(cold, hot, vHeat);
      c = mix(base * 0.7, base, slug) + vec3(0.9, 0.75, 0.5) * ember * vHeat * 0.5;
    } else if (uStyle < 3.5) {
      // bloom — no epicentre at all, one soft monochrome cloud. Alpha carries all the shape.
      float haze = 1.0 - pow(1.0 - k, 2.4);
      a = haze * 0.80;
      vec3 pale = mix(vColor, vec3(1.0, 0.88, 0.74), 0.35);
      c = pale * (0.5 + 0.5 * vHeat);
    } else if (uStyle < 4.5) {
      /*
       * echo — Dark Echo's rule, and the argument against every ramp in this shader: hue is not
       * a quantity, it is an identity. Everything the world does is one bone-white; a living
       * thing that is not you is red; and that is the entire palette. Loudness lives where the
       * eye reads it fastest anyway — in the size of the blob and in how hard it burns — so a
       * dozen overlapping marks stay one legible colour field instead of a smear of five hues.
       * The tint stays warm rather than pure white so it never rhymes with the ice-white the
       * lidar uses for a fresh return.
       */
      float body = 1.0 - pow(1.0 - k, 2.2);
      float core = pow(k, uSoftness * 1.7);
      a = (body * 0.58 + core * 0.42) * (0.55 + 0.65 * vHeat);
      vec3 bone = vec3(1.00, 0.90, 0.76);
      vec3 alien = vec3(1.00, 0.28, 0.22);
      c = mix(bone, alien, step(1.5, vKind));
      c = mix(c * 0.72, c, core);
    } else if (uStyle < 5.5) {
      /*
       * pulse — the mark as an instrument *reading*, and the one style in the set that is not a
       * blob at all.
       *
       * Round one of this style was "a shell races out and leaves a core behind", and the human
       * called it близко, но тюнить надо. Looking at it next to "echo", the reason it was only
       * close is structural rather than a matter of numbers: the shell lived 0.34 s out of a
       * seven-second mark, so for 95% of its life the thing on screen was a soft filled disc —
       * i.e. a dimmer "echo". It is kept as "pulse-v1" for the before/after, and this is the
       * finished one.
       *
       * What it is now: **hollow**. Three thin shells leave the epicentre 0.19 s apart, cross
       * the mark in a little over half a second and dissolve at the rim; behind them nothing is
       * left but a hard pinpoint at the exact point of the event. No style in this file has a
       * hollow interior, so a pulse mark cannot be mistaken for any of the others at any age,
       * and — the part that matters for law 2 — a hollow ring can never be read as something
       * glowing: light fills, a reading rings.
       *
       * The shells are true circles while every blob style is a lopsided silhouette, which is
       * the same argument from the other side: a device draws circles, matter does not.
       */
      /*
       * The shells run on a *lightly* warped radius — a third of the lopsidedness the blob
       * styles get. Perfectly concentric circles with a dot in the middle stop reading as a
       * reading and start reading as a gunsight, which is the one association this game cannot
       * afford; a few percent of wobble is enough to break it while the shape stays a circle.
       */
      float rw = rr / (1.0 + (warp - 1.0) * 0.34);
      float travel = vAge / 0.56;
      float shells =
          shell(rw, travel, 1.00) +
          shell(rw, travel - 0.34, 0.62) +
          shell(rw, travel - 0.68, 0.38);
      /*
       * The residue. The layer is a decaying hit-map of the last few seconds, so a pulse mark
       * still has to say "something happened *here*" long after it has stopped ringing — but as
       * a pinpoint, not as an area, because an area is the thing that reads as illumination.
       */
      float pip = exp(-pow(rr / 0.085, 2.0)) * (0.24 + 0.48 * vHeat);
      a = shells * (0.70 + 0.55 * vHeat) + pip;
      /*
       * Near-monochrome, faintly cold, and deliberately not on the source hue ramp: the whole
       * point of the style is that it is an instrument's opinion, and an instrument does not
       * change colour according to what it heard. The one distinction it keeps is "echo"'s:
       * something alive that is not you comes back on the red side.
       */
      vec3 read = vec3(0.84, 0.94, 0.90);
      vec3 alien = vec3(1.00, 0.52, 0.46);
      c = mix(read, alien, step(1.5, vKind));
    } else if (uStyle < 6.5) {
      /*
       * bruise — the cold side of the wheel. The muzzle flash is the only real light in this game
       * and it is amber; the lidar owns cyan. Anything warm the sound layer draws is competing
       * with actual illumination for the same corner of the player's head, which is the failure
       * mode Perception and Stifled avoid by keeping echolocation cold. Indigo body, magenta
       * shoulder, a hot pink core that only a loud event can reach: nothing in the hall can emit
       * this colour, so it can only ever be read as an instrument.
       */
      float body = pow(k, uSoftness * 0.85);
      float core = pow(k, uSoftness * 2.6);
      vec3 deep = vec3(0.16, 0.05, 0.44);
      vec3 mid = vec3(0.62, 0.09, 0.66);
      vec3 hot = vec3(1.00, 0.66, 0.92);
      a = body * 0.68 + core * 0.52 * vHeat;
      c = mix(deep, mid, smoothstep(0.0, 0.5, body));
      c = mix(c, hot, core * vHeat);
    } else {
      /*
       * pulse-v1 — round one of "pulse", kept only so the before/after can be looked at in the
       * live game as well as in the keyframes. One fat shell over the first third of a second
       * and a filled core for the remaining six and a half.
       */
      float t1 = clamp(vAge / 0.34, 0.0, 1.0);
      float shellOld = exp(-pow((rr - t1) / 0.30, 2.0)) * (1.0 - t1) * smoothstep(1.05, 0.9, rr);
      float coreOld = pow(k, uSoftness * 1.4);
      a = shellOld * 0.85 + coreOld * (0.30 + 0.35 * vHeat);
      vec3 warm = mix(vColor, vec3(1.0, 0.86, 0.70), 0.4);
      c = mix(warm * 0.75, vec3(1.0, 0.95, 0.88), shellOld * 0.8);
    }

    /*
     * Very loud does not mean "more fill". Past the top of the scale the interior of the mark is
     * dimmed on a long gradient, so the peak sits in a broad shoulder and the centre stays below
     * clipping:
     * a burst of near-coincident gunshot marks then sums into overlapping rings — an event with
     * structure you can read — instead of one saturated hole in the frame. Below that end of the
     * scale (vBurn == 0.0) this line does nothing at all.
     */
    a *= mix(1.0, 0.45 + 0.55 * smoothstep(0.0, 0.78, r), vBurn);

    a *= vFade * uBright;
    // The ceiling. Applied to alpha rather than to the colour, so the hue of the mark is exactly
    // what it was and only its energy is limited — a clamp on the premultiplied RGB would drag
    // every bright mark towards grey as it approached the cap.
    a = min(a, uPeak);
    if (a <= 0.002) discard;
    gl_FragColor = vec4(c * a, a);
  }
`;

/** The debug overlay: where a sound was, how loud, and how far it can be noticed at all. */
const RING_POINTS = 72;

const RING_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uLife;
  uniform float uProjScale;
  attribute float aBirth;
  attribute float aLoud;
  attribute vec3  aTint;
  attribute float aPhase;
  varying vec3  vColor;
  void main() {
    float age = uTime - aBirth;
    if (aBirth <= -1.0e8 || age < 0.0 || age > uLife) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    // aLoud holds the shared player-perception radius in metres. It starts from event loudness,
    // then includes the same source carry and final rolloff margin as the audio/marker admission.
    vec3 p = position + vec3(cos(aPhase), 0.0, sin(aPhase)) * aLoud;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vColor = aTint * (1.0 - age / uLife) * 0.9;
    gl_PointSize = clamp(uProjScale * 0.02 / max(0.001, -mv.z), 1.0, 3.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const RING_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  void main() { gl_FragColor = vec4(vColor, 1.0); }
`;

const NEVER = -1e9;

export interface MarkerStats {
  /** Marks currently inside their lifetime. */
  alive: number;
  /** Marks written since the start. */
  written: number;
  /** Events correctly rejected because the tactical ear was outside their notice radius. */
  outOfRange: number;
  capacity: number;
}

export class SoundMarkers {
  readonly tunables: MarkerTunables;
  readonly object = new THREE.Group();

  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly ringGeometry = new THREE.BufferGeometry();
  private readonly ringMaterial: THREE.ShaderMaterial;
  private readonly ringPoints: THREE.Points;

  private readonly pos: Float32Array;
  private readonly birth: Float32Array;
  private readonly loud: Float32Array;
  private readonly seed: Float32Array;
  private readonly gain: Float32Array;
  private readonly kind: Float32Array;
  private readonly tint: Float32Array;

  private readonly ringPos: Float32Array;
  private readonly ringBirth: Float32Array;
  private readonly ringLoud: Float32Array;
  private readonly ringTint: Float32Array;

  private cursor = 0;
  private written = 0;
  private outOfRange = 0;
  private time = 0;
  private radiusOn = false;
  /** Last rendered ear position. Marks are a tactical hearing readout, not an omniscient feed. */
  private listenerX = 0;
  private listenerY = 0;
  private listenerZ = 0;

  constructor(
    readonly capacity = 3072,
    tunables: MarkerTunables = defaultMarkerTunables(),
  ) {
    this.tunables = tunables;
    const n = capacity * PER_MARKER;
    this.pos = new Float32Array(n * 3);
    this.birth = new Float32Array(n).fill(NEVER);
    this.loud = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.gain = new Float32Array(n);
    this.kind = new Float32Array(n);
    this.tint = new Float32Array(n * 3);

    const g = this.geometry;
    // Two triangles in -1..1, shared by every instance; the corner is billboarded in clip space.
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]),
        3,
      ),
    );
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3));
    g.setAttribute('aBirth', new THREE.InstancedBufferAttribute(this.birth, 1));
    g.setAttribute('aLoud', new THREE.InstancedBufferAttribute(this.loud, 1));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.seed, 1));
    g.setAttribute('aGain', new THREE.InstancedBufferAttribute(this.gain, 1));
    g.setAttribute('aKind', new THREE.InstancedBufferAttribute(this.kind, 1));
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.tint, 3));
    g.instanceCount = capacity;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: tunables.life },
        uScale: { value: tunables.scale },
        uLoudRef: { value: tunables.loudRef },
        uLoudPower: { value: tunables.loudPower },
        uMinRadius: { value: tunables.minRadius },
        uMaxRadius: { value: tunables.maxRadius },
        uSpread: { value: tunables.spread },
        uViewport: { value: new THREE.Vector2(1280, 720) },
        uSoftness: { value: tunables.softness },
        uBright: { value: tunables.brightness },
        uPeak: { value: tunables.peak },
        uStyle: { value: STYLE_INDEX[tunables.style] },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Set properly a line below; see `applyBlend`.
      blending: THREE.AdditiveBlending,
    });
    this.applyBlend();

    const blobs = new THREE.Mesh(this.geometry, this.material);
    blobs.frustumCulled = false;
    blobs.renderOrder = 3;
    this.object.add(blobs);

    // --- debug ring ------------------------------------------------------
    const rn = capacity * RING_POINTS;
    this.ringPos = new Float32Array(rn * 3);
    this.ringBirth = new Float32Array(rn).fill(NEVER);
    this.ringLoud = new Float32Array(rn);
    this.ringTint = new Float32Array(rn * 3);
    const phase = new Float32Array(rn);
    for (let i = 0; i < rn; i++) phase[i] = ((i % RING_POINTS) / RING_POINTS) * Math.PI * 2;
    const rg = this.ringGeometry;
    rg.setAttribute('position', new THREE.BufferAttribute(this.ringPos, 3));
    rg.setAttribute('aBirth', new THREE.BufferAttribute(this.ringBirth, 1));
    rg.setAttribute('aLoud', new THREE.BufferAttribute(this.ringLoud, 1));
    rg.setAttribute('aTint', new THREE.BufferAttribute(this.ringTint, 3));
    rg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    rg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.ringMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: tunables.life },
        uProjScale: { value: 500 },
      },
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ringPoints = new THREE.Points(this.ringGeometry, this.ringMaterial);
    this.ringPoints.frustumCulled = false;
    this.ringPoints.renderOrder = 4;
    this.ringPoints.visible = false;
    this.object.add(this.ringPoints);
  }

  setVisible(on: boolean): void {
    this.object.visible = on;
  }

  get visible(): boolean {
    return this.object.visible;
  }

  /** M2's mandatory debug tool: draw each event's audibility radius on the floor it happened on. */
  setRadiusVisible(on: boolean): void {
    this.radiusOn = on;
    this.ringPoints.visible = on;
  }

  get radiusVisible(): boolean {
    return this.radiusOn;
  }

  /** Switch the look. Free — one uniform; nothing in the ring buffer depends on the style. */
  setStyle(style: MarkerStyle): void {
    this.tunables.style = style;
    this.material.uniforms.uStyle!.value = STYLE_INDEX[style] ?? 0;
  }

  get style(): MarkerStyle {
    return this.tunables.style;
  }

  setTime(seconds: number): void {
    this.time = seconds;
    this.material.uniforms.uTime!.value = seconds;
    this.ringMaterial.uniforms.uTime!.value = seconds;
  }

  /**
   * The drawing-buffer size in device pixels. Load-bearing twice over: the quad is billboarded
   * through it, and the reference-pixel radius is scaled by its height. Feed it the drawing
   * buffer, never the CSS size — on a devicePixelRatio-2 screen those differ by the exact factor
   * that made the keyframes lie.
   */
  setViewport(w: number, h: number): void {
    const v = this.material.uniforms.uViewport!.value as THREE.Vector2;
    v.set(Math.max(1, w), Math.max(1, h));
  }

  setProjScale(v: number): void {
    this.ringMaterial.uniforms.uProjScale!.value = v;
  }

  /** The same ear position used by the spatial mixer. No orientation is needed for range. */
  setListener(x: number, y: number, z: number): void {
    this.listenerX = x;
    this.listenerY = y;
    this.listenerZ = z;
  }

  applyLook(): void {
    const t = this.tunables;
    const u = this.material.uniforms;
    u.uLife!.value = t.life;
    u.uScale!.value = t.scale;
    u.uLoudRef!.value = t.loudRef;
    u.uLoudPower!.value = t.loudPower;
    u.uMinRadius!.value = t.minRadius;
    u.uMaxRadius!.value = t.maxRadius;
    u.uSpread!.value = t.spread;
    u.uSoftness!.value = t.softness;
    u.uBright!.value = t.brightness;
    u.uPeak!.value = t.peak;
    u.uStyle!.value = STYLE_INDEX[t.style] ?? 0;
    this.applyBlend();
    this.ringMaterial.uniforms.uLife!.value = t.life;
  }

  /**
   * `max` or `+`. Under `max` a pixel takes the brightest mark covering it and stops there, which
   * is the only way a *ceiling* survives ten marks landing on the same spot. It also means the
   * sound layer no longer washes out the lidar's dots underneath it — a welcome second effect,
   * and the reason the flash still has somewhere to go.
   */
  private applyBlend(): void {
    const m = this.material;
    if (this.tunables.capOverlap) {
      m.blending = THREE.CustomBlending;
      m.blendEquation = THREE.MaxEquation;
      m.blendSrc = THREE.OneFactor;
      m.blendDst = THREE.OneFactor;
      m.blendEquationAlpha = THREE.MaxEquation;
      m.blendSrcAlpha = THREE.OneFactor;
      m.blendDstAlpha = THREE.OneFactor;
    } else {
      m.blending = THREE.AdditiveBlending;
    }
    m.needsUpdate = true;
  }

  /** The bus subscriber. One event, one slot in the ring. No allocation. */
  handle(event: SoundEvent): void {
    // The HUD localises what the player could hear. Previously every event in the whole hall was
    // written, so the 22 px minimum radius turned inaudible spider footfalls into distant red
    // beacons. A rejected event never claims a ring-buffer slot and cannot appear years later.
    if (!this.accepts(event)) {
      this.outOfRange++;
      return;
    }
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.written++;

    const look = SOURCE_LOOK[event.source] ?? SOURCE_LOOK['prop-impact'];
    const c = new THREE.Color(look.color);
    const r = c.r;
    const g = c.g;
    const b = c.b;
    const s = ((this.written * 0.6180339887) % 1) * 6.283;

    const i = slot * PER_MARKER;
    this.pos[i * 3] = event.x;
    this.pos[i * 3 + 1] = event.y;
    this.pos[i * 3 + 2] = event.z;
    this.birth[i] = event.time;
    this.loud[i] = event.loudness;
    this.seed[i] = s;
    this.gain[i] = look.gain;
    this.kind[i] = look.kind;
    this.tint[i * 3] = r;
    this.tint[i * 3 + 1] = g;
    this.tint[i * 3 + 2] = b;

    upload(this.geometry, 'iPos', i * 3, PER_MARKER * 3);
    upload(this.geometry, 'aBirth', i, PER_MARKER);
    upload(this.geometry, 'aLoud', i, PER_MARKER);
    upload(this.geometry, 'aSeed', i, PER_MARKER);
    upload(this.geometry, 'aGain', i, PER_MARKER);
    upload(this.geometry, 'aKind', i, PER_MARKER);
    upload(this.geometry, 'aTint', i * 3, PER_MARKER * 3);

    if (this.radiusOn) {
      const rb = slot * RING_POINTS;
      for (let k = 0; k < RING_POINTS; k++) {
        const j = rb + k;
        this.ringPos[j * 3] = event.x;
        this.ringPos[j * 3 + 1] = event.y + 0.03;
        this.ringPos[j * 3 + 2] = event.z;
        this.ringBirth[j] = event.time;
        // The mandatory debug ring shows the same admission edge the ear, marks and compass use,
        // including chatter's physical carry and the mixer's final inverse-rolloff margin.
        this.ringLoud[j] = soundPerceptionRange(event);
        this.ringTint[j * 3] = r;
        this.ringTint[j * 3 + 1] = g;
        this.ringTint[j * 3 + 2] = b;
      }
      upload(this.ringGeometry, 'position', rb * 3, RING_POINTS * 3);
      upload(this.ringGeometry, 'aBirth', rb, RING_POINTS);
      upload(this.ringGeometry, 'aLoud', rb, RING_POINTS);
      upload(this.ringGeometry, 'aTint', rb * 3, RING_POINTS * 3);
    }
  }

  /** Pure distance decision shared with audio and the off-screen compass. */
  accepts(event: SoundEvent): boolean {
    return isSoundPerceivableAt(event, this.listenerX, this.listenerY, this.listenerZ);
  }

  getStats(): MarkerStats {
    let alive = 0;
    for (let s = 0; s < this.capacity; s++) {
      const b = this.birth[s * PER_MARKER]!;
      if (b > NEVER && this.time - b <= this.tunables.life) alive++;
    }
    return { alive, written: this.written, outOfRange: this.outOfRange, capacity: this.capacity };
  }

  /**
   * Debug: every mark still alive, as [x, y, z, loudness, age]. The counters in `getStats` say
   * how many marks exist; this says *where* they are and how loud, which is the only way to tell
   * "the layer drew nothing" from "the layer drew it off-screen".
   */
  list(): Array<[number, number, number, number, number]> {
    const out: Array<[number, number, number, number, number]> = [];
    for (let s = 0; s < this.capacity; s++) {
      const i = s * PER_MARKER;
      const b = this.birth[i]!;
      if (b <= NEVER || this.time - b > this.tunables.life) continue;
      out.push([this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!, this.loud[i]!, this.time - b]);
    }
    return out;
  }

  clear(): void {
    this.birth.fill(NEVER);
    this.ringBirth.fill(NEVER);
    upload(this.geometry, 'aBirth', 0, this.birth.length);
    upload(this.ringGeometry, 'aBirth', 0, this.ringBirth.length);
    this.cursor = 0;
    this.written = 0;
    this.outOfRange = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
  }
}

/** Marks one slice of one attribute dirty. Whole-buffer re-uploads are what a ring exists to avoid. */
/*
 * Queue one slot of one attribute for the next `bufferSubData`.
 *
 * This used to call `clearUpdateRanges()` first, and that was the bug behind "I sprint, I look
 * back, and there is a trickle of ten pixels behind me". Several sound events routinely land
 * between two renders (a stride, the two props the knee just clipped, a whole pile collapsing);
 * every one of them called this, and each call threw away the ranges queued by the events before
 * it in the same frame. Only the *last* event of a frame ever reached the GPU — the rest sat in
 * the CPU array with their slots still holding whatever the previous owner of the slot wrote, so
 * they drew stale or drew nothing. Three clears the ranges itself once it has uploaded them
 * (WebGLAttributes.update), and it sorts and merges them first, so simply accumulating is both
 * correct and cheap.
 */
function upload(g: THREE.BufferGeometry, name: string, offset: number, count: number): void {
  const attr = g.getAttribute(name) as THREE.BufferAttribute;
  attr.addUpdateRange(offset, count);
  attr.needsUpdate = true;
}
