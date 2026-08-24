/**
 * The structured reveal backend — "Blueprint" (look 5).
 *
 * Looks 1-4 answer the world with a *stochastic* cloud: rays are fired, and wherever one lands
 * a patch of random blips is splatted. That is sonar as texture. Blueprint answers the same
 * events with the opposite representation: the geometry is known ahead of time, so a sound does
 * not *sample* a surface, it **unlocks** the part of the surface it reached. What the player sees
 * is therefore exact — a uniform lattice of dim dots across every revealed face, and a bright
 * contour along every revealed edge — and the only thing sound decides is *which* of it is
 * known and *when* it became known.
 *
 * Five properties carry the look:
 *
 *  1. **Precomputed, never resampled.** At scene build every collider box is turned into
 *     per-face dot lattices (snapped to one world-space grid, so coplanar faces line up) and
 *     ~0.2 m contour segments along its twelve edges. Faces and edges that are buried inside
 *     another box, or that face out of the level entirely, are dropped at build time — the
 *     outside of the room shell is not a place sound can ever reach.
 *
 *  2. **The same wave, the same two stamps, the same restamp policy.** An unlock writes
 *     `birth = event.time + distance / waveSpeed` and keeps the previous arrival in `prior`,
 *     exactly as the blip system does, and both shaders here branch on `prior` exactly as that
 *     one does: virgin geometry gets the whole front, known geometry refreshes *silently* — it
 *     does not ripple, does not re-ink, does not wait for the new front, it simply eases to its
 *     new age over `refreshSeconds`. So a first reveal is a front sweeping across the room, a
 *     second ping over ground you already have is a quiet brightening of it, and the CPU work
 *     can be amortised over as many frames as it likes without anyone being able to tell.
 *
 *  3. **One mask, one rule: a point is unlocked when the front actually reached *that point*.**
 *     There is no such thing as an object surfacing whole. Every dot and every contour piece —
 *     crate, shelf, column, wall, floor, ceiling, alike — is tested on its own against the
 *     event's radius, its cone, its own facing, and a real occlusion ray. Clipping the edge of a
 *     twenty-metre rack run therefore lights the edge and nothing else, and the back of a crate
 *     you can see the front of stays unknown until you walk round it.
 *
 *     This replaces the M1 rule ("hearing one face of a prop surfaces all of it"), which was
 *     found in playtest to be tactile telekinesis: one clipped corner handed you the shape of
 *     something you had never looked at. The check any frame must pass is *how does the player
 *     know that?* — and only a point the beam or the hand actually reached can answer it.
 *
 *  4. **One front, and the drawing happens at it.** As the front passes virgin lattice, a dot is
 *     pushed *off* its true position — radially outward, on a damped ring profile a metre or so
 *     wide — and drawn hot, swollen and white; a fifth of a ring width later it is already back
 *     exactly where it belongs, cooling into the dim cyan lattice. The contours ink themselves in
 *     segment by segment *at that same ring*, not behind it. Batch 2.2 ran the ink on a fixed
 *     delay (`phaseDelay`) with a warm wake (`probeWake`) bridging the gap, which gave the room a
 *     second, slower front chasing the first — read as a bug in playtest, and removed. The
 *     displacement is a *render-time* effect computed from the stored exact position: the data
 *     never lies (law 2), and once the ring has passed the picture is exact.
 *
 *  5. **Nothing is ever lost.** Both layers cool along the same age ramp as the blip cloud and
 *     settle at the skeleton alpha of §3.6. The map dims; it never dies.
 *
 *  6. **The hand writes to the same mask.** The tactile layer is not a second geometry system: it
 *     is a second *source* of unlocking over this one mask (`revealTouch`), marking the dots and
 *     contour pieces inside arm's reach. They draw grey — bright under the hand, a faint trail
 *     once you have moved on — and the instant a lidar front reaches one of them it is drawn in
 *     the lidar's colours instead. The lidar outranks the hand, because it knows more.
 *
 * A per-item accent channel (gold) is reserved and wired through both shaders for the traversal
 * holds of §5 ("dots are matter, lines are holds"). Nothing writes it yet.
 */

import * as THREE from 'three';
import type { StaticWorld } from '../core/collision';
import type { LidarPing } from './ping';
import { ACCENT_GOLD, MATTER_COLD, MATTER_FRESH, MATTER_MID, type AgeRamp } from './palette';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export interface StructuredTunables {
  /** Lattice pitch, metres. Snapped to a world grid so coplanar faces share one lattice. */
  spacing: number;
  /** Per-dot positional jitter, as a fraction of the spacing (0-0.3). */
  jitter: number;
  /** Length of one contour piece, metres — also the granularity of the ink-in. */
  segment: number;
  /** Radial displacement at the peak of the ring, metres. 0 leaves the ring as pure colour. */
  ripple: number;
  /** Width of the displaced ring behind the front, metres. */
  ringWidth: number;
  /** How long one contour segment takes to draw itself as the front reaches it, seconds. */
  inkSeconds: number;
  /** Contour gain. */
  contourBright: number;
  /** Lattice dot gain — deliberately well under the contours. */
  dotBright: number;
  /** Lattice dot diameter, world metres. */
  dotSize: number;
  /** Extra brightness of a dot inside the probing ring. */
  probeBright: number;
  /** How much a probed dot swells (multiplier on top of its size). */
  probeSize: number;
  /** Splat softness of a probed dot — this is the "blurred" of "hot blurred white". */
  probeSoftness: number;
  /** Splat softness behind the ring, where the lattice is exact. */
  dotSoftness: number;
  /** Screen-size ceiling for a lattice dot, drawing-buffer pixels. */
  pixelCap: number;
  /** Items one chunk of unlocking may test. */
  chunkItems: number;
  /** Wall-clock budget for one chunk, ms. */
  chunkMs: number;
}

export function defaultStructuredTunables(): StructuredTunables {
  return {
    spacing: 0.18,
    jitter: 0.1,
    segment: 0.2,
    ripple: 0.07,
    ringWidth: 1.2,
    inkSeconds: 0.06,
    contourBright: 1.25,
    dotBright: 0.46,
    dotSize: 0.05,
    probeBright: 2.4,
    probeSize: 1.8,
    probeSoftness: 0.95,
    dotSoftness: 0.35,
    pixelCap: 7,
    chunkItems: 4000,
    chunkMs: 4,
  };
}

// ---------------------------------------------------------------------------

/** The tactile grey. Deliberately colourless: the hand is not a sensor, it is a hand. */
export const TOUCH_GREY = 0x9fa6ab;

/** Cell size of the reach grids, metres. Comfortably above the largest arm's-reach radius. */
const REACH_CELL = 0.8;

/** Birth stamp meaning "nothing was ever known here". */
export const NEVER = -1e9;
/** How many recent events can still be rippling at once. */
export const WAVE_SLOTS = 8;
/** Slack for "strictly inside another box", metres. */
const EPS = 0.01;
/** Outward offset of a lattice dot from its face, metres — it should sit *on* the surface. */
const SURFACE_OFFSET = 0.012;
/** Face normals, indexed as axis * 2 + (sign > 0 ? 0 : 1). */
const NORMALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** mulberry32, local so this module has no runtime dependency on the blip system. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rawColor(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
}

/**
 * A (floor, feather) pair per item, set to "unbounded": reach any age, at full strength.
 *
 * What an item that has never been refreshed carries, and what a refresh landing dead centre
 * would write anyway — so the neutral value and the identity value are the same value.
 */
function unbounded(items: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(items * 2);
  for (let i = 0; i < items; i++) out[i * 2 + 1] = 1;
  return out;
}

/** The shader's smoothstep, so the CPU mirror of the ease cannot drift from the GPU's. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The displaced ring profile, in units of ring widths behind the front.
 *
 * A pressure pulse, not a bump: the surface is shoved outward as the front arrives, crosses back
 * through zero half a ring width later, undershoots by a few per cent and is gone. Duplicated
 * verbatim in the dot shader — the CPU copy exists so the diagnostics can report the actual
 * displacement on screen rather than restate the formula that produced it.
 */
function ringProfile(t: number): number {
  if (t < 0 || t > 2) return 0;
  return Math.exp(-2.6 * t) * Math.cos(Math.PI * t);
}

export const RING_GLSL = /* glsl */ `
  float ringProfile(float t) {
    if (t < 0.0 || t > 2.0) return 0.0;
    return exp(-2.6 * t) * cos(3.14159265 * t);
  }
`;

/** The age ramp, shared by both layers and identical in shape to the blip cloud's (§3.2). */
export const RAMP_GLSL = /* glsl */ `
  uniform vec3  uRampTimes;
  uniform float uSkeletonAlpha;
  uniform vec3  uFresh;
  uniform vec3  uMid;
  uniform vec3  uCold;

  void ageRamp(in float age, out vec3 col, out float alpha) {
    if (age < uRampTimes.x) {
      float t = age / max(0.001, uRampTimes.x);
      col = mix(uFresh, uMid, t * t);
      alpha = mix(1.0, 0.9, t);
    } else if (age < uRampTimes.y) {
      float t = (age - uRampTimes.x) / max(0.001, uRampTimes.y - uRampTimes.x);
      col = mix(uMid, uCold, t);
      alpha = mix(0.9, 0.42, t);
    } else {
      float t = clamp((age - uRampTimes.y) / max(0.001, uRampTimes.z - uRampTimes.y), 0.0, 1.0);
      col = uCold;
      alpha = mix(0.42, uSkeletonAlpha, t);
    }
  }
`;

/** Looks up the wave that unlocked this item, and proves it really was that one. */
export const WAVE_GLSL = /* glsl */ `
  uniform vec4 uWaveA[${WAVE_SLOTS}];   // origin.xyz, t0
  uniform vec4 uWaveB[${WAVE_SLOTS}];   // speed, live, -, -

  // Returns the metres this point sits behind that wave's front, or -1 when the slot has since
  // been recycled by a newer event (its arrival would no longer add up).
  float behindFront(in vec3 p, in float slot, in float birth, in float now, out vec3 outward) {
    vec3 origin = vec3(0.0);
    float t0 = 0.0;
    float speed = 0.0;
    float live = 0.0;
    for (int i = 0; i < ${WAVE_SLOTS}; i++) {
      if (abs(float(i) - slot) < 0.5) {
        origin = uWaveA[i].xyz;
        t0 = uWaveA[i].w;
        speed = uWaveB[i].x;
        live = uWaveB[i].y;
      }
    }
    outward = vec3(0.0);
    if (live < 0.5 || speed <= 0.0) return -1.0;
    vec3 d = p - origin;
    float dist = length(d);
    if (abs(t0 + dist / speed - birth) > 0.05) return -1.0;
    outward = d / max(dist, 1.0e-4);
    return (now - birth) * speed;
  }
`;

/**
 * Readability of a fact — the shading every mask point goes through before it is drawn.
 *
 * None of this is light. There is no source, no shadow, no falloff off a lamp; the inputs are
 * (a) which way the surface faces, which the mask has known since it was built, and (b) how far
 * away it is, which the camera knows for free. Both are properties of a fact the player has
 * already paid for, so law 1 is untouched: nothing here draws anything that was not scanned.
 *
 * It exists because the honest version was unreadable. A floor dot and a dot on a bottle standing
 * on that floor came out the same grey at the same size, so a pile of clutter rendered as a
 * uniform speckled fog: plenty of points, no objects. Three cheap terms fix it —
 *
 *   facing   the far side of a body is dimmed and, past grazing, dropped. One dot product, no
 *            raycast. Small props still show through a little, and that is accepted: cheap and
 *            readable beats exact and grey.
 *   tint     a vertical wall, an upward face and a downward face read as three different greys.
 *            This is what separates a crate from the floor it stands on.
 *   distance near is bright, far recedes. Without it two metres and twenty look identical and the
 *            frame has no depth at all.
 */
export const SHADE_GLSL = /* glsl */ `
  vec3 faceTint(vec3 n) {
    float up = clamp(n.y, 0.0, 1.0);
    float down = clamp(-n.y, 0.0, 1.0);
    vec3 t = mix(vec3(1.22, 1.16, 1.02), vec3(0.60, 0.72, 0.86), up * up);
    return mix(t, vec3(0.40, 0.46, 0.56), down);
  }

  /** > 0 faces the eye. Used to dim and, past the silhouette, to drop the point. */
  float faceToEye(vec3 world, vec3 n) {
    vec3 toEye = cameraPosition - world;
    float len = length(toEye);
    return len < 1e-4 ? 1.0 : dot(n, toEye / len);
  }

  float facingGain(float f) {
    return 0.30 + 0.70 * smoothstep(-0.05, 0.55, f);
  }

  float depthCue(float depth, float window) {
    return mix(1.0, 0.20, pow(clamp(depth / max(2.0, window * 0.8), 0.0, 1.0), 0.75));
  }
`;

const DOT_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uProjScale;
  uniform float uWindowRadius;
  uniform float uSizeWorld;
  uniform float uPixelCap;
  uniform float uMinPixels;
  uniform float uMaxPixels;
  uniform float uRipple;
  uniform float uRingWidth;
  uniform float uRefreshSeconds;
  uniform float uDotBright;
  uniform float uProbeBright;
  uniform float uProbeSize;
  uniform float uProbeSoft;
  uniform float uDotSoft;
  uniform float uSkeletonSize;
  uniform vec3  uListener;
  uniform vec3  uAccent;
  // The hand: where the tactile reach is centred, how far it goes, and how bright a point is
  // under it versus once it has become a memory. uTouchOn is the debug toggle, nothing more.
  uniform vec3  uHand;
  /** Upward length of the reach column, metres — the hand is a body-height segment, not a point. */
  uniform float uHandSpan;
  uniform vec3  uTouchColor;
  uniform float uTouchRange;
  uniform float uTouchNear;
  uniform float uTouchMemory;
  uniform float uTouchOn;

  attribute float aBirth;
  attribute float aPrior;
  attribute float aWave;
  attribute float aSeed;
  attribute float aAccent;
  /** Face normal, world space. The mask has always known it; until M2 nothing looked at it. */
  attribute vec3  aNormal;
  /** 1 when the hand has ever reached this point. The lidar overrides it wherever both hold. */
  attribute float aTouch;
  // x = the youngest age the newest refresh may reach here, y = how much of it this dot gets.
  attribute vec2  aRefresh;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vSoft;

  ${RAMP_GLSL}
  ${RING_GLSL}
  ${WAVE_GLSL}
  ${SHADE_GLSL}

  void main() {
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vSoft = uDotSoft;

    /*
     * Law 3, and the first thing this shader has to get right: the lattice for the *whole* level
     * is resident from the first frame, and all of it but the heard part must be nowhere. A
     * never-stamp is a large negative number rather than a flag, so an unheard dot's "age" is
     * about a billion seconds — which the ramp below would happily cool to skeleton alpha and
     * draw. Reject it explicitly, first, before anything else costs anything.
     */
    if (aBirth <= -1.0e8) {
      /*
       * No front has ever arrived here. The hand may still have found it — same mask, other
       * source — and that is the *only* other way a point may be on screen. Grey, bright under
       * the hand and a faint trail behind it, and never anything more than the point itself.
       */
      if (aTouch <= -1.0e8 || uTouchOn < 0.5 || distance(position, uListener) > uWindowRadius) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      // Distance to the reach *column*, not to a point at eye level. A crate at your shins is
      // as reachable as a shelf at your shoulder, which is the whole difference between
      // "I felt something" and "I felt nothing at all".
      vec3 hd = position - uHand;
      hd.y -= clamp(hd.y, 0.0, uHandSpan);
      float td = length(hd);
      // Flat over most of the reach, fading only at its rim. The earlier curve started dimming
      // at 45% of the range, which made a felt patch read as three bright dots and a smudge —
      // technically honest, visually unreadable.
      float prox = 1.0 - smoothstep(uTouchRange * 0.8, uTouchRange * 1.25, td);
      /*
       * The trail behind the hand fades on the same ramp as the lidar map — m2 §6, "упрощаем
       * там, где нет резона делать сложно". It used to be a flat constant, which meant a wall
       * you brushed an hour ago was exactly as present as one you are touching now: the one
       * channel in the game that never forgot anything.
       */
      vec3 memCol;
      float memAlpha;
      ageRamp(uTime - aTouch, memCol, memAlpha);
      float ta = max(prox * uTouchNear, uTouchMemory * memAlpha);
      if (ta < 0.004) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      /*
       * A felt point is drawn as a small hard stipple, not as the lidar's energy-conserving
       * blob: at arm's length the world-size rule would swell one dot to twenty pixels and then
       * dim it to nothing to keep the energy, which is exactly the wrong answer for the one
       * channel that only ever draws things 60 cm away. Fixed small size, honest brightness.
       */
      vec4 tmv = modelViewMatrix * vec4(position, 1.0);
      float tpx = clamp(uSizeWorld * uSkeletonSize * uProjScale / max(0.001, -tmv.z), 5.0, 9.0);
      vColor = uTouchColor * ta;
      vAlpha = 1.0;
      // Harder-edged than a lidar dot: a felt point is a fingertip, not a return.
      vSoft = uDotSoft * 0.6;
      gl_PointSize = tpx;
      gl_Position = projectionMatrix * tmv;
      return;
    }

    // §3.6: the data persists, the rendering is windowed.
    if (distance(position, uListener) > uWindowRadius) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec3 p = position;
    float ageNew = uTime - aBirth;
    float age;
    float hot = 0.0;
    float appear = 1.0;

    /*
     * The restamp policy, identical to the blip cloud's (paintSystem.ts) because it is one
     * policy and not two. No prior means nobody has ever heard this dot: it waits for the front,
     * and the front visibly passes through it — displaced, hot, swollen. A prior means known
     * ground, and a refresh over known ground is *silent*: no ring, no displacement, no gate, the
     * age just eases to its new value. That is what stops a second ping from re-surveying a room
     * the player has already bought.
     */
    if (aPrior <= -1.0e8) {
      if (ageNew < 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      age = ageNew;
      vec3 outward;
      float behind = behindFront(position, aWave, aBirth, uTime, outward);
      if (behind >= 0.0) {
        // The pressure pushes the surface off its true position as it goes by, and the dot is
        // white and swollen for exactly as long as it is being pushed. One band, one front.
        float ringN = behind / max(0.05, uRingWidth);
        p += outward * uRipple * ringProfile(ringN);
        hot = 1.0 - smoothstep(0.0, 1.0, ringN);
        // A soft leading edge on the ring, a third of a ring width deep — the distance analogue
        // of the blip cloud's arrival ramp, and for the same reason: nothing pops on.
        appear = smoothstep(0.0, 0.35, ringN);
      }
    } else {
      float ageOld = uTime - aPrior;
      if (ageOld < 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      // Bounded exactly as the blip cloud bounds it, because it is one policy: a footfall may
      // only walk the age back to the end of the white band, and only fully in the middle of its
      // own radius. The min against the old age keeps the floor a floor.
      float target = min(ageOld, max(ageNew, aRefresh.x));
      float s = smoothstep(0.0, max(0.001, uRefreshSeconds), ageNew) * aRefresh.y;
      age = mix(ageOld, target, s);
    }

    vec3 col;
    float alpha;
    ageRamp(age, col, alpha);
    col = mix(col, uAccent, aAccent);
    // At the ring the dot is white and certain of nothing; behind it, cyan and exact.
    col = mix(col, vec3(1.0), hot * 0.92);
    alpha = mix(alpha, 1.0, hot);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float depth = max(0.001, -mv.z);
    float cooled = clamp(age / max(0.001, uRampTimes.z), 0.0, 1.0);
    float want = uSizeWorld * mix(1.0, uSkeletonSize, cooled) * (1.0 + hot * uProbeSize)
      * uProjScale / depth;
    float q = want / max(0.5, uPixelCap);
    float px = want / pow(1.0 + q * q * q, 0.33333334);
    px = clamp(px, uMinPixels, uMaxPixels);
    float coverage = min(1.0, (want * want) / (px * px));

    // Readability pass — see SHADE_GLSL. The hot band skips it: a crest is the one thing that
    // is allowed to be pure white wherever it is.
    float f = faceToEye(p, aNormal);
    if (f < -0.22 && hot < 0.01) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float shade = mix(facingGain(f) * depthCue(depth, uWindowRadius), 1.0, hot);
    col *= mix(faceTint(aNormal), vec3(1.0), hot);

    vColor = col * uDotBright * coverage * (1.0 + hot * uProbeBright)
      * (0.88 + 0.24 * aSeed) * appear * shade;
    vAlpha = alpha;
    vSoft = mix(uDotSoft, uProbeSoft, hot);
    gl_PointSize = px;
    gl_Position = projectionMatrix * mv;
  }
`;

const DOT_FRAGMENT = /* glsl */ `
  precision highp float;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vSoft;

  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float inner = 1.0 - clamp(vSoft, 0.0, 0.999);
    float shape = 1.0 - smoothstep(inner, 1.0, r);
    if (shape <= 0.002) discard;
    gl_FragColor = vec4(vColor, shape * vAlpha);
  }
`;

const EDGE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uWindowRadius;
  uniform float uRefreshSeconds;
  uniform float uInkSeconds;
  uniform float uContourBright;
  uniform vec3  uListener;
  uniform vec3  uAccent;
  uniform vec3  uHand;
  /** Upward length of the reach column, metres — the hand is a body-height segment, not a point. */
  uniform float uHandSpan;
  uniform vec3  uTouchColor;
  uniform float uTouchRange;
  uniform float uTouchNear;
  uniform float uTouchMemory;
  uniform float uTouchOn;
  /** How much of a felt point's brightness a felt *line* gets. A line covers far more pixels. */
  uniform float uTouchEdge;

  attribute float aBirth;
  attribute float aPrior;
  attribute float aT;
  attribute float aAccent;
  /** When *this end* of the piece was felt. Per vertex, not per piece — see the hand branch. */
  attribute float aTouch;
  // The same two bounds a lattice dot carries, on the line the dot's face is bordered by.
  attribute vec2  aRefresh;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vInk;
  varying float vT;
  /*
   * 1 only when *this* vertex is drawable. A line is two vertices, and a vertex that is culled
   * by being shoved outside the clip volume does not remove the line: the segment is clipped at
   * the frustum instead, and what is left is a long streak from the surviving end toward the
   * dead one. That is where the "bright wireframe of a whole crate" came from — a 20 cm contour
   * piece whose far end failed one test drew as a line across the screen. So liveness is carried
   * into the fragment stage and both ends have to agree, or nothing is drawn.
   */
  varying float vLive;

  ${RAMP_GLSL}

  void main() {
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vInk = -1.0;
    vT = aT;
    vLive = 0.0;

    /*
     * The hand draws contours — concept.md says touch gives a grey tactile *contour*, and in the
     * dark an edge is worth ten points for working out which way a crate is turned.
     *
     * What the M1 audit actually caught was narrower: a crate came back as a full white
     * wireframe, far top edge included, when the hand had been against one face. Two separate
     * causes, both fixed here. The first was drawing: a piece whose far end failed a test was
     * culled by shoving that vertex outside the clip volume, which does not remove the line —
     * it clips it at the frustum and leaves a streak running off toward the dead end. Liveness
     * is a varying now (vLive) and both ends have to agree. The second is the rule itself:
     * a touch stamp is per *vertex*, so a piece is only ever drawn when both of its ends were
     * inside the reach column. You reveal the piece of the edge you ran your hand along, and
     * the edge stops where your hand stopped.
     *
     * Dimmer than a felt point, deliberately. One 20 cm piece at arm's length is several
     * hundred pixels against a stipple's nine, so equal brightness is not equal presence.
     */
    if (aBirth <= -1.0e8) {
      if (aTouch <= -1.0e8 || uTouchOn < 0.5 || distance(position, uListener) > uWindowRadius) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      // Distance to the reach column, exactly as the dot shader measures it.
      vec3 hd = position - uHand;
      hd.y -= clamp(hd.y, 0.0, uHandSpan);
      float td = length(hd);
      float prox = 1.0 - smoothstep(uTouchRange * 0.8, uTouchRange * 1.25, td);
      vec3 memCol;
      float memAlpha;
      ageRamp(uTime - aTouch, memCol, memAlpha);
      float ta = max(prox * uTouchNear, uTouchMemory * memAlpha) * uTouchEdge;
      if (ta < 0.004) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      vColor = uTouchColor * ta;
      vAlpha = 1.0;
      vInk = 10.0;
      vLive = 1.0;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      return;
    }

    if (distance(position, uListener) > uWindowRadius) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    /*
     * A line inks *at* the front, not behind it: the instant the wave reaches this piece it
     * starts drawing itself from one end, and inkSeconds later it is whole. The same restamp
     * policy as everywhere else decides which of those two things is happening — a line with a
     * prior has already been drawn once and is simply refreshed, silently and already whole, so
     * a second ping never re-inks a drawing the player owns.
     */
    float ageNew = uTime - aBirth;
    float age;
    float flash = 0.0;
    if (aPrior <= -1.0e8) {
      if (ageNew < 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      age = ageNew;
      vInk = ageNew / max(0.001, uInkSeconds);
      // The moment of inking is the brightest a line ever is.
      flash = exp(-ageNew * 6.0);
    } else {
      float ageOld = uTime - aPrior;
      if (ageOld < 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      float target = min(ageOld, max(ageNew, aRefresh.x));
      float s = smoothstep(0.0, max(0.001, uRefreshSeconds), ageNew) * aRefresh.y;
      age = mix(ageOld, target, s);
      // A line that has been drawn once is whole for ever: the bounds shape how young a refresh
      // may make it, never whether it is there.
      vInk = 10.0;
    }

    vec3 col;
    float alpha;
    ageRamp(age, col, alpha);
    col = mix(col, uAccent, aAccent);
    vColor = col * uContourBright * (1.0 + 0.9 * flash);
    vAlpha = alpha;
    vLive = 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EDGE_FRAGMENT = /* glsl */ `
  precision highp float;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vInk;
  varying float vT;
  varying float vLive;

  void main() {
    // Both ends of the piece have to be drawable, or the piece is not drawn at all. On a line
    // with one live end the interpolant is 1 only exactly at that vertex, so the whole segment
    // goes; on a fully live line it is 1 everywhere.
    if (vLive < 0.999) discard;
    // The line draws itself from one end: everything past the ink head is not there yet.
    if (vInk < 0.0 || vT > vInk) discard;
    if (vAlpha <= 0.002) discard;
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

// ---------------------------------------------------------------------------


/**
 * A uniform grid over a set of points, so "what is within arm's reach" is a handful of cells
 * instead of a third of a million distance tests.
 *
 * Built once with the lattice and never touched again — the world is static and so are the
 * points. Counting sort into two typed arrays: `start` indexes cells, `items` holds point
 * indices grouped by cell. No allocation at query time.
 */
class PointGrid {
  private readonly cell: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;

  constructor(pos: Float32Array, count: number, cell: number) {
    this.cell = cell;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3]!;
      const y = pos[i * 3 + 1]!;
      const z = pos[i * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    if (count === 0) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 0;
    }
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    this.ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);

    const cells = this.nx * this.ny * this.nz;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const c = this.index(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
      cellOf[i] = c;
      counts[c + 1] = counts[c + 1]! + 1;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] = counts[c + 1]! + counts[c]!;
    this.start = counts;
    this.items = new Int32Array(count);
    const cursor = new Int32Array(cells);
    for (let i = 0; i < count; i++) {
      const c = cellOf[i]!;
      this.items[this.start[c]! + cursor[c]!] = i;
      cursor[c] = cursor[c]! + 1;
    }
  }

  /** Bytes held, for the memory line in the stats. */
  get bytes(): number {
    return this.start.byteLength + this.items.byteLength;
  }

  private index(x: number, y: number, z: number): number {
    const ix = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const iy = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
    const iz = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / this.cell)));
    return (iz * this.ny + iy) * this.nx + ix;
  }

  /** Appends every point index whose cell could hold something within `r` of (x, y, z). */
  candidates(x: number, y: number, z: number, r: number, out: number[]): void {
    out.length = 0;
    const lo = (v: number, min: number, n: number): number =>
      Math.min(n - 1, Math.max(0, Math.floor((v - r - min) / this.cell)));
    const hi = (v: number, min: number, n: number): number =>
      Math.min(n - 1, Math.max(0, Math.floor((v + r - min) / this.cell)));
    const x0 = lo(x, this.minX, this.nx);
    const x1 = hi(x, this.minX, this.nx);
    const y0 = lo(y, this.minY, this.ny);
    const y1 = hi(y, this.minY, this.ny);
    const z0 = lo(z, this.minZ, this.nz);
    const z1 = hi(z, this.minZ, this.nz);
    for (let iz = z0; iz <= z1; iz++) {
      for (let iy = y0; iy <= y1; iy++) {
        const row = (iz * this.ny + iy) * this.nx;
        const from = this.start[row + x0]!;
        const to = this.start[row + x1 + 1]!;
        for (let k = from; k < to; k++) out.push(this.items[k]!);
      }
    }
  }
}

interface StructFace {
  box: number;
  axis: number;
  sign: number;
  plane: number;
  /** Bounding sphere, for the per-event range and cone rejects. */
  cx: number;
  cy: number;
  cz: number;
  r: number;
  dot0: number;
  dotN: number;
}

interface StructBox {
  face0: number;
  faceN: number;
  dot0: number;
  dotN: number;
  edge0: number;
  edgeN: number;
  cx: number;
  cy: number;
  cz: number;
  r: number;
}

export interface StructuredStats {
  built: boolean;
  buildMs: number;
  dots: number;
  edges: number;
  /** Attribute bytes held on the CPU (and the same again on the GPU). */
  bytes: number;
  unlockedDots: number;
  unlockedEdges: number;
  lastDots: number;
  lastEdges: number;
  lastRays: number;
  lastMs: number;
  lastChunkMs: number;
  lastChunks: number;
  /** Items the outstanding unlock job has still to look at. */
  pending: number;
  /** Of `lastDots`, the ones that were already known — the refreshes rather than the reveals. */
  lastRefreshed: number;
  /** The age floor the last event carried, seconds — zero for anything but a footstep. */
  lastFloor: number;
  /** Mean spatial feather over the dots it refreshed (1 = all of them dead centre). */
  lastFeatherMean: number;
  /** Refreshed dots the floor genuinely held back — older than the floor when it landed. */
  lastFloored: number;
  /**
   * Worst age discontinuity the last event's refreshes put on screen, seconds.
   *
   * The blip cloud's invariant, measured the same way here: the displayed age is evaluated under
   * the old stamps and again under the new ones at the same instant, and the effective-stamp
   * construction makes the difference zero. One policy, one number, two backends.
   *
   * Refreshes the front had already passed before the unlock job reached them are counted in
   * `lastLate` instead, for the reason given there.
   */
  lastJump: number;
  /**
   * Refreshes the event's own front had already swept past when the unlock job got to them.
   *
   * Unlocking is amortised over frames exactly as ray sampling is, so on a slow frame a dot can
   * be reached after its arrival has gone by: no ease is left to run and it takes its new age in
   * one step. Lateness in the job, not a hole in the policy — and the floor still decides where
   * that step lands, which is why it lands out of the white.
   */
  lastLate: number;
  /** Worst age step those late refreshes took, seconds — reported, not asserted on. */
  lastLateStep: number;
  /** Mask dots the hand has ever been within reach of. */
  touchedDots: number;
  /** Contour piece *ends* the hand has ever been within reach of. */
  touchedEdges: number;
  /** Dots the last `revealTouch` call newly reached. */
  lastTouchedDots: number;
  /** Mask items the last `revealTouch` call had to look at. */
  lastTouchTests: number;
}

export interface StructuredDiagnostics {
  /** Lattice dots a viewer could see this instant. */
  drawnDots: number;
  /** Contour segments that have finished drawing themselves. */
  inkedEdges: number;
  /** Segments unlocked by an event whose front has not finished inking them yet. */
  pendingEdges: number;
  /** Dots currently displaced by more than a millimetre. */
  rippling: number;
  /** The largest displacement on screen right now, metres. */
  rippleMax: number;
}

/** What a probe of one world-space box found. Used by the screenshot driver. */
export interface RegionStats {
  dots: number;
  unlocked: number;
  drawn: number;
  rippling: number;
  edges: number;
  edgesUnlocked: number;
  edgesInked: number;
  /** Of `dots`, the ones the hand has reached. */
  touched: number;
  /** Of `edges`, the pieces the hand has reached *both ends* of — the ones it may draw. */
  edgesTouched: number;
}

interface UnlockJob {
  ox: number;
  oy: number;
  oz: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  cosHalf: number;
  radius: number;
  t0: number;
  invSpeed: number;
  slot: number;
  /** Youngest age this event's refreshes may reach, and where they start fading out (metres). */
  floor: number;
  featherFrom: number;
  /** Cursors into the mask: faces, then the dots of the face being walked, then contour pieces. */
  faceCursor: number;
  dotCursor: number;
  edgeCursor: number;
  planned: boolean;
}

export class StructuredPaint {
  readonly tunables: StructuredTunables;

  private readonly root = new THREE.Group();
  private readonly dotGeometry = new THREE.BufferGeometry();
  private readonly edgeGeometry = new THREE.BufferGeometry();
  private readonly dotMaterial: THREE.ShaderMaterial;
  private readonly edgeMaterial: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private readonly lines: THREE.LineSegments;

  // ---- static geometry -----------------------------------------------------
  private boxes: StructBox[] = [];
  private faces: StructFace[] = [];
  private spheres = new Float32Array(0);
  private dotPos = new Float32Array(0);
  private dotBirth = new Float32Array(0);
  private dotPrior = new Float32Array(0);
  private dotWave = new Float32Array(0);
  private dotSeed = new Float32Array(0);
  private dotAccent = new Float32Array(0);
  private dotNormal = new Float32Array(0);
  /** (floor age, feather) per dot, interleaved — the bounds on its newest refresh. */
  private dotRefresh = new Float32Array(0);
  /** The hand's channel into the same mask: 1 once a dot has been within arm's reach. */
  private dotTouch = new Float32Array(0);
  private edgePos = new Float32Array(0);
  private edgeBirth = new Float32Array(0);
  private edgePrior = new Float32Array(0);
  private edgeT = new Float32Array(0);
  private edgeAccent = new Float32Array(0);
  /** The same pair per contour vertex, written to both ends of a piece at once. */
  private edgeRefresh = new Float32Array(0);
  private edgeBox = new Int32Array(0);
  /** The two face normals an edge piece belongs to, as indices into `NORMALS`. */
  private edgeNa = new Uint8Array(0);
  private edgeNb = new Uint8Array(0);
  private edgeMid = new Float32Array(0);
  /** The same birth-time channel as `dotTouch`, but per contour *vertex*: both ends must agree. */
  private edgeTouch = new Float32Array(0);
  /** The same channel per contour vertex, written to both ends of a piece at once. */
  /** Uniform grids over the mask, so a reach query costs a handful of cells, not the world. */
  private dotGrid: PointGrid | null = null;
  private edgeGrid: PointGrid | null = null;
  private readonly reachScratch: number[] = [];
  private pieces = 0;
  private accept = new Uint8Array(0);

  // ---- live state ----------------------------------------------------------
  private built = false;
  private time = 0;
  private readonly listener = new THREE.Vector3();
  private job: UnlockJob | null = null;
  private slotCursor = 0;
  private readonly waveOrigin = new Float32Array(WAVE_SLOTS * 4);
  private readonly waveMeta = new Float32Array(WAVE_SLOTS * 2);
  private lastBlocker = -1;
  /**
   * Boxes that could possibly block anything on the surface being walked right now.
   *
   * Per-point occlusion is the whole point of this pass, and it is also its whole cost: every
   * dot of every face wants a shadow ray. Testing all 240 boxes per ray is what made the worst
   * ping frame spike. So before a face is walked, the cone from the sound to that face's
   * bounding sphere is intersected against every box sphere once, and the rays of that face then
   * see only the survivors — typically a handful. Conservative by construction: a ray from the
   * origin to any point of the face's sphere never leaves the capsule this tests against.
   */
  private candList = new Int32Array(0);
  private candCount = 0;
  private candBox = -1;
  private lastChunkAt = 0;
  /**
   * The two numbers the wave tunables own: how long a refresh eases for, and where it starts
   * fading out across the event's radius. Pushed in by `applyLook` rather than duplicated as
   * tunables of this module, for the same reason the ease itself is — one policy, one source.
   */
  private refreshSeconds = 0.3;
  private featherStart = 0.55;
  /** Running feather sum behind `lastFeatherMean`, reset with the other per-event stats. */
  private featherSum = 0;

  private dotDirtyMin = Infinity;
  private dotDirtyMax = -Infinity;
  private edgeDirtyMin = Infinity;
  private edgeDirtyMax = -Infinity;
  /** The hand writes to its own attribute, so it carries its own upload window. */
  private touchDotDirtyMin = Infinity;
  private touchDotDirtyMax = -Infinity;
  private touchEdgeDirtyMin = Infinity;
  private touchEdgeDirtyMax = -Infinity;

  private stats: StructuredStats = {
    built: false,
    buildMs: 0,
    dots: 0,
    edges: 0,
    bytes: 0,
    unlockedDots: 0,
    unlockedEdges: 0,
    lastDots: 0,
    lastEdges: 0,
    lastRays: 0,
    lastMs: 0,
    lastChunkMs: 0,
    lastChunks: 0,
    pending: 0,
    lastRefreshed: 0,
    lastFloor: 0,
    lastFeatherMean: 0,
    lastFloored: 0,
    lastJump: 0,
    lastLate: 0,
    lastLateStep: 0,
    touchedDots: 0,
    touchedEdges: 0,
    lastTouchedDots: 0,
    lastTouchTests: 0,
  };

  private diag: StructuredDiagnostics = {
    drawnDots: 0,
    inkedEdges: 0,
    pendingEdges: 0,
    rippling: 0,
    rippleMax: 0,
  };
  private diagTime = Number.NaN;

  constructor(
    private readonly world: StaticWorld,
    private readonly ramp: AgeRamp,
    tunables?: StructuredTunables,
  ) {
    this.tunables = tunables ?? defaultStructuredTunables();

    const waveA = Array.from({ length: WAVE_SLOTS }, () => new THREE.Vector4());
    const waveB = Array.from({ length: WAVE_SLOTS }, () => new THREE.Vector4());

    const shared = (): Record<string, THREE.IUniform> => ({
      uTime: { value: 0 },
      uWindowRadius: { value: 45 },
      uListener: { value: new THREE.Vector3() },
      // The silent-refresh ease, pushed in from the wave tunables by `applyLook`: one policy for
      // both backends, owned by the wave, never duplicated here.
      uRefreshSeconds: { value: 0.3 },
      uRampTimes: {
        value: new THREE.Vector3(ramp.freshSeconds, ramp.coolSeconds, ramp.coldSeconds),
      },
      uSkeletonAlpha: { value: ramp.skeletonAlpha },
      uFresh: { value: rawColor(MATTER_FRESH) },
      uMid: { value: rawColor(MATTER_MID) },
      uCold: { value: rawColor(MATTER_COLD) },
      uAccent: { value: rawColor(ACCENT_GOLD) },
      uHand: { value: new THREE.Vector3(0, -1e5, 0) },
      uHandSpan: { value: 1.2 },
      uTouchColor: { value: rawColor(TOUCH_GREY) },
      uTouchRange: { value: 0.55 },
      uTouchNear: { value: 0.8 },
      uTouchMemory: { value: 0.07 },
      uTouchOn: { value: 1 },
      uTouchEdge: { value: 0.42 },
    });

    this.dotMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...shared(),
        uProjScale: { value: 500 },
        uSizeWorld: { value: this.tunables.dotSize },
        uPixelCap: { value: this.tunables.pixelCap },
        uMinPixels: { value: 1 },
        uMaxPixels: { value: 14 },
        uRipple: { value: this.tunables.ripple },
        uRingWidth: { value: this.tunables.ringWidth },
        uDotBright: { value: this.tunables.dotBright },
        uProbeBright: { value: this.tunables.probeBright },
        uProbeSize: { value: this.tunables.probeSize },
        uProbeSoft: { value: this.tunables.probeSoftness },
        uDotSoft: { value: this.tunables.dotSoftness },
        uSkeletonSize: { value: ramp.skeletonSize },
        uWaveA: { value: waveA },
        uWaveB: { value: waveB },
      },
      vertexShader: DOT_VERTEX,
      fragmentShader: DOT_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.edgeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...shared(),
        uInkSeconds: { value: this.tunables.inkSeconds },
        uContourBright: { value: this.tunables.contourBright },
      },
      vertexShader: EDGE_VERTEX,
      fragmentShader: EDGE_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.dotGeometry, this.dotMaterial);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    this.lines = new THREE.LineSegments(this.edgeGeometry, this.edgeMaterial);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;
    this.dotGeometry.setDrawRange(0, 0);
    this.edgeGeometry.setDrawRange(0, 0);
    this.root.add(this.points, this.lines);
    this.root.visible = false;
  }

  get object(): THREE.Object3D {
    return this.root;
  }

  /**
   * The wave-slot uniform arrays, shared by reference.
   *
   * A second reveal layer (the props' local masks) has to ripple on the *same* fronts as this
   * one, or the crest would visibly stop at every crate. Handing out the arrays rather than
   * copying them means there is one set of live fronts in the process and no way for the two
   * layers to disagree about them.
   */
  waveUniforms(): { a: THREE.Vector4[]; b: THREE.Vector4[] } {
    return {
      a: this.dotMaterial.uniforms.uWaveA!.value as THREE.Vector4[],
      b: this.dotMaterial.uniforms.uWaveB!.value as THREE.Vector4[],
    };
  }

  /** The slot the most recent `handle` claimed — what a second layer must stamp its points with. */
  get lastWaveSlot(): number {
    return (this.slotCursor - 1 + WAVE_SLOTS) % WAVE_SLOTS;
  }

  get active(): boolean {
    return this.root.visible;
  }

  /** Turns the layer on (building it the first time) or off. */
  setActive(on: boolean): void {
    if (on) this.ensureBuilt();
    this.root.visible = on && this.built;
  }

  getStats(): StructuredStats {
    this.stats.pending =
      this.job === null
        ? 0
        : Math.max(0, this.faces.length - this.job.faceCursor) +
          Math.max(0, this.pieces - this.job.edgeCursor);
    return this.stats;
  }

  // ---- build ---------------------------------------------------------------

  ensureBuilt(): void {
    if (this.built) return;
    this.build();
  }

  /** Regenerates the lattice — the spacing and jitter sliders are the only callers. */
  rebuild(): void {
    this.built = false;
    this.build();
  }

  private build(): void {
    const t0 = performance.now();
    const boxes = this.world.boxes;
    const n = boxes.length;
    const spacing = Math.max(0.05, this.tunables.spacing);
    const jitter = Math.min(0.3, Math.max(0, this.tunables.jitter));
    const segment = Math.max(0.05, this.tunables.segment);
    const rng = makeRng(0x51ded);

    // Bounding spheres (static: the world never changes after scene build) and the union AABB.
    // The union is exactly the outside of the room shell, which is what makes "a sample point
    // outside it can never be reached by sound" a safe face cull.
    this.spheres = new Float32Array(n * 4);
    let uMinX = Infinity;
    let uMinY = Infinity;
    let uMinZ = Infinity;
    let uMaxX = -Infinity;
    let uMaxY = -Infinity;
    let uMaxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const b = boxes[i]!;
      const hx = (b.maxX - b.minX) / 2;
      const hy = (b.maxY - b.minY) / 2;
      const hz = (b.maxZ - b.minZ) / 2;
      this.spheres[i * 4] = b.minX + hx;
      this.spheres[i * 4 + 1] = b.minY + hy;
      this.spheres[i * 4 + 2] = b.minZ + hz;
      this.spheres[i * 4 + 3] = Math.sqrt(hx * hx + hy * hy + hz * hz);
      if (b.minX < uMinX) uMinX = b.minX;
      if (b.minY < uMinY) uMinY = b.minY;
      if (b.minZ < uMinZ) uMinZ = b.minZ;
      if (b.maxX > uMaxX) uMaxX = b.maxX;
      if (b.maxY > uMaxY) uMaxY = b.maxY;
      if (b.maxZ > uMaxZ) uMaxZ = b.maxZ;
    }

    const inWorld = (x: number, y: number, z: number): boolean =>
      x >= uMinX && x <= uMaxX && y >= uMinY && y <= uMaxY && z >= uMinZ && z <= uMaxZ;

    const pos: number[] = [];
    const seeds: number[] = [];
    // Parallel to `seeds`: the face normal each dot sits on, for the readability shading.
    const nrms: number[] = [];
    const epos: number[] = [];
    const emid: number[] = [];
    const ebox: number[] = [];
    const ena: number[] = [];
    const enb: number[] = [];
    const faces: StructFace[] = [];
    const recs: StructBox[] = [];
    /**
     * Bounds of the neighbours that could bury part of the box being built, already shrunk by
     * the slack and packed flat. This test runs a quarter of a million times per build, so it
     * gets a typed array and an index loop rather than an object walk and an iterator.
     */
    let nearBounds = new Float64Array(64 * 6);
    let nearCount = 0;

    /** Neighbours that survive the current lattice row's prefilter, as offsets into the above. */
    let rowList = new Int32Array(64);
    let rowCount = 0;

    /** `open`, restricted to the row prefilter — the hot path of the whole build. */
    const openRow = (x: number, y: number, z: number): boolean => {
      if (!inWorld(x, y, z)) return false;
      for (let k = 0; k < rowCount; k++) {
        const o = rowList[k]!;
        if (
          x > nearBounds[o]! &&
          x < nearBounds[o + 3]! &&
          y > nearBounds[o + 1]! &&
          y < nearBounds[o + 4]! &&
          z > nearBounds[o + 2]! &&
          z < nearBounds[o + 5]!
        ) {
          return false;
        }
      }
      return true;
    };

    /** True when this sample sits in open air: inside the level and not buried in another box. */
    const open = (x: number, y: number, z: number): boolean => {
      if (!inWorld(x, y, z)) return false;
      for (let k = 0; k < nearCount; k++) {
        const o = k * 6;
        if (
          x > nearBounds[o]! &&
          x < nearBounds[o + 3]! &&
          y > nearBounds[o + 1]! &&
          y < nearBounds[o + 4]! &&
          z > nearBounds[o + 2]! &&
          z < nearBounds[o + 5]!
        ) {
          return false;
        }
      }
      return true;
    };

    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      const face0 = faces.length;
      const dot0 = pos.length / 3;
      const edge0 = ebox.length;

      // Neighbours that could bury part of this box's surface.
      nearCount = 0;
      for (let j = 0; j < n; j++) {
        if (j === bi) continue;
        const o = boxes[j]!;
        if (o.maxX < b.minX - 0.1 || o.minX > b.maxX + 0.1) continue;
        if (o.maxY < b.minY - 0.1 || o.minY > b.maxY + 0.1) continue;
        if (o.maxZ < b.minZ - 0.1 || o.minZ > b.maxZ + 0.1) continue;
        if ((nearCount + 1) * 6 > nearBounds.length) {
          const grown = new Float64Array(nearBounds.length * 2);
          grown.set(nearBounds);
          nearBounds = grown;
        }
        const w = nearCount * 6;
        nearBounds[w] = o.minX + EPS;
        nearBounds[w + 1] = o.minY + EPS;
        nearBounds[w + 2] = o.minZ + EPS;
        nearBounds[w + 3] = o.maxX - EPS;
        nearBounds[w + 4] = o.maxY - EPS;
        nearBounds[w + 5] = o.maxZ - EPS;
        nearCount++;
      }
      if (rowList.length < nearCount) rowList = new Int32Array(nearCount);

      const lo = [b.minX, b.minY, b.minZ];
      const hi = [b.maxX, b.maxY, b.maxZ];

      // ---- faces
      for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        for (const sign of [-1, 1] as const) {
          const plane = sign > 0 ? hi[axis]! : lo[axis]!;
          const nIdx = axis * 2 + (sign > 0 ? 0 : 1);
          const nrm = NORMALS[nIdx]!;
          const faceDot0 = pos.length / 3;
          const p = [0, 0, 0];
          // The whole face turns out of the level: the outside of the shell is not a place any
          // sound can ever reach, and skipping it here is what keeps the build off the four
          // biggest grids in the room.
          if (sign > 0 && plane >= (axis === 0 ? uMaxX : axis === 1 ? uMaxY : uMaxZ) - 1e-6) continue;
          if (sign < 0 && plane <= (axis === 0 ? uMinX : axis === 1 ? uMinY : uMinZ) + 1e-6) continue;

          const minU = lo[u]!;
          const maxU = hi[u]!;
          const minV = lo[v]!;
          const maxV = hi[v]!;
          const margin = jitter * spacing + 0.05;
          for (let gu = Math.floor(minU / spacing); (gu + 0.5) * spacing < maxU; gu++) {
            const baseU = (gu + 0.5) * spacing;
            if (baseU <= minU) continue;
            /*
             * Row prefilter. A face of the floor is twenty thousand dots and the floor touches
             * every prop in the room, so testing each dot against all of them is the single
             * most expensive thing the build does. Only the neighbours whose footprint crosses
             * *this row* can bury anything in it, and on a floor that is two or three of them
             * instead of forty-five.
             */
            rowCount = 0;
            for (let k = 0; k < nearCount; k++) {
              const o = k * 6;
              if (baseU + margin < nearBounds[o + u]! || baseU - margin > nearBounds[o + 3 + u]!) {
                continue;
              }
              rowList[rowCount++] = o;
            }
            for (let gv = Math.floor(minV / spacing); (gv + 0.5) * spacing < maxV; gv++) {
              const baseV = (gv + 0.5) * spacing;
              if (baseV <= minV) continue;
              const uu = Math.min(
                maxU - 0.004,
                Math.max(minU + 0.004, baseU + (rng() - 0.5) * 2 * jitter * spacing),
              );
              const vv = Math.min(
                maxV - 0.004,
                Math.max(minV + 0.004, baseV + (rng() - 0.5) * 2 * jitter * spacing),
              );
              p[axis] = plane;
              p[u] = uu;
              p[v] = vv;
              // A face buried against another box is not a surface sound can ever reach.
              if (!openRow(p[0]! + nrm[0] * 0.03, p[1]! + nrm[1] * 0.03, p[2]! + nrm[2] * 0.03)) {
                continue;
              }
              pos.push(
                p[0]! + nrm[0] * SURFACE_OFFSET,
                p[1]! + nrm[1] * SURFACE_OFFSET,
                p[2]! + nrm[2] * SURFACE_OFFSET,
              );
              seeds.push(rng());
              nrms.push(nrm[0], nrm[1], nrm[2]);
            }
          }

          /*
           * Minimum density, one point per face, whatever its size.
           *
           * The lattice is snapped to a single world grid so that coplanar faces line up. The
           * price is that a face thinner than the pitch can fall entirely between two grid
           * lines and come out with no points at all — and a surface with no points is a
           * surface that cannot be felt or scanned. That is how a knee-high crate stayed
           * silent under the hand while the wall behind it answered normally. So a face that
           * the world grid missed gets its own centred grid instead, sized to at least one
           * cell. Alignment is lost on exactly those faces that were too small to align with
           * anything anyway.
           */
          if (pos.length / 3 === faceDot0) {
            const nu = Math.max(1, Math.round((maxU - minU) / spacing));
            const nv = Math.max(1, Math.round((maxV - minV) / spacing));
            for (let iu = 0; iu < nu; iu++) {
              for (let iv = 0; iv < nv; iv++) {
                p[axis] = plane;
                p[u] = minU + ((iu + 0.5) * (maxU - minU)) / nu;
                p[v] = minV + ((iv + 0.5) * (maxV - minV)) / nv;
                if (!open(p[0]! + nrm[0] * 0.03, p[1]! + nrm[1] * 0.03, p[2]! + nrm[2] * 0.03)) {
                  continue;
                }
                pos.push(
                  p[0]! + nrm[0] * SURFACE_OFFSET,
                  p[1]! + nrm[1] * SURFACE_OFFSET,
                  p[2]! + nrm[2] * SURFACE_OFFSET,
                );
                seeds.push(rng());
                nrms.push(nrm[0], nrm[1], nrm[2]);
              }
            }
          }

          const dotN = pos.length / 3 - faceDot0;
          if (dotN === 0) continue;
          const c = [0, 0, 0];
          c[axis] = plane;
          c[u] = (minU + maxU) / 2;
          c[v] = (minV + maxV) / 2;
          faces.push({
            box: bi,
            axis,
            sign,
            plane,
            cx: c[0]!,
            cy: c[1]!,
            cz: c[2]!,
            r: 0.5 * Math.hypot(maxU - minU, maxV - minV),
            dot0: faceDot0,
            dotN,
          });
        }
      }

      // ---- edges: the twelve creases, cut into ~`segment` pieces.
      for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        const length = hi[axis]! - lo[axis]!;
        const count = Math.max(1, Math.round(length / segment));
        const step = length / count;
        for (const su of [-1, 1] as const) {
          for (const sv of [-1, 1] as const) {
            const naIdx = u * 2 + (su > 0 ? 0 : 1);
            const nbIdx = v * 2 + (sv > 0 ? 0 : 1);
            const na = NORMALS[naIdx]!;
            const nb = NORMALS[nbIdx]!;
            const uu = su > 0 ? hi[u]! : lo[u]!;
            const vv = sv > 0 ? hi[v]! : lo[v]!;
            // Proud of both faces by a hair, so the line is never z-fighting its own lattice.
            const ox = (na[0] + nb[0]) * SURFACE_OFFSET;
            const oy = (na[1] + nb[1]) * SURFACE_OFFSET;
            const oz = (na[2] + nb[2]) * SURFACE_OFFSET;
            for (let k = 0; k < count; k++) {
              const a = [0, 0, 0];
              const c = [0, 0, 0];
              a[axis] = lo[axis]! + step * k;
              c[axis] = lo[axis]! + step * (k + 1);
              a[u] = uu;
              c[u] = uu;
              a[v] = vv;
              c[v] = vv;
              const mx = (a[0]! + c[0]!) / 2;
              const my = (a[1]! + c[1]!) / 2;
              const mz = (a[2]! + c[2]!) / 2;
              // Kept when *either* adjoining face is open there: a crease between a live face
              // and a buried one is still a crease.
              const openA = open(mx + na[0] * 0.03, my + na[1] * 0.03, mz + na[2] * 0.03);
              const openB = open(mx + nb[0] * 0.03, my + nb[1] * 0.03, mz + nb[2] * 0.03);
              if (!openA && !openB) continue;
              epos.push(a[0]! + ox, a[1]! + oy, a[2]! + oz, c[0]! + ox, c[1]! + oy, c[2]! + oz);
              emid.push(mx + ox, my + oy, mz + oz);
              ebox.push(bi);
              ena.push(naIdx);
              enb.push(nbIdx);
            }
          }
        }
      }

      recs.push({
        face0,
        faceN: faces.length - face0,
        dot0,
        dotN: pos.length / 3 - dot0,
        edge0,
        edgeN: ebox.length - edge0,
        cx: this.spheres[bi * 4]!,
        cy: this.spheres[bi * 4 + 1]!,
        cz: this.spheres[bi * 4 + 2]!,
        r: this.spheres[bi * 4 + 3]!,
      });
    }

    const dots = pos.length / 3;
    this.pieces = ebox.length;
    this.boxes = recs;
    this.faces = faces;
    this.accept = new Uint8Array(n);
    this.candList = new Int32Array(n);

    this.dotPos = new Float32Array(pos);
    this.dotSeed = new Float32Array(seeds);
    this.dotNormal = new Float32Array(nrms);
    this.dotBirth = new Float32Array(dots).fill(NEVER);
    this.dotPrior = new Float32Array(dots).fill(NEVER);
    this.dotWave = new Float32Array(dots);
    this.dotAccent = new Float32Array(dots);
    this.dotRefresh = unbounded(dots);
    this.dotTouch = new Float32Array(dots).fill(NEVER);

    const verts = this.pieces * 2;
    this.edgePos = new Float32Array(epos);
    this.edgeMid = new Float32Array(emid);
    this.edgeBox = new Int32Array(ebox);
    this.edgeNa = new Uint8Array(ena);
    this.edgeNb = new Uint8Array(enb);
    this.edgeBirth = new Float32Array(verts).fill(NEVER);
    this.edgePrior = new Float32Array(verts).fill(NEVER);
    this.edgeAccent = new Float32Array(verts);
    this.edgeRefresh = unbounded(verts);
    this.edgeT = new Float32Array(verts);
    this.edgeTouch = new Float32Array(verts).fill(NEVER);
    for (let i = 0; i < this.pieces; i++) {
      this.edgeT[i * 2] = 0;
      this.edgeT[i * 2 + 1] = 1;
    }

    this.dotGeometry.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3));
    this.dotGeometry.setAttribute('aBirth', new THREE.BufferAttribute(this.dotBirth, 1));
    this.dotGeometry.setAttribute('aPrior', new THREE.BufferAttribute(this.dotPrior, 1));
    this.dotGeometry.setAttribute('aWave', new THREE.BufferAttribute(this.dotWave, 1));
    this.dotGeometry.setAttribute('aSeed', new THREE.BufferAttribute(this.dotSeed, 1));
    this.dotGeometry.setAttribute('aNormal', new THREE.BufferAttribute(this.dotNormal, 3));
    this.dotGeometry.setAttribute('aAccent', new THREE.BufferAttribute(this.dotAccent, 1));
    this.dotGeometry.setAttribute('aRefresh', new THREE.BufferAttribute(this.dotRefresh, 2));
    this.dotGeometry.setAttribute('aTouch', new THREE.BufferAttribute(this.dotTouch, 1));
    this.dotGeometry.setDrawRange(0, dots);
    this.dotGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.edgeGeometry.setAttribute('position', new THREE.BufferAttribute(this.edgePos, 3));
    this.edgeGeometry.setAttribute('aBirth', new THREE.BufferAttribute(this.edgeBirth, 1));
    this.edgeGeometry.setAttribute('aPrior', new THREE.BufferAttribute(this.edgePrior, 1));
    this.edgeGeometry.setAttribute('aT', new THREE.BufferAttribute(this.edgeT, 1));
    this.edgeGeometry.setAttribute('aAccent', new THREE.BufferAttribute(this.edgeAccent, 1));
    this.edgeGeometry.setAttribute('aRefresh', new THREE.BufferAttribute(this.edgeRefresh, 2));
    this.edgeGeometry.setAttribute('aTouch', new THREE.BufferAttribute(this.edgeTouch, 1));
    this.edgeGeometry.setDrawRange(0, verts);
    this.edgeGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    // One grid over the dots and one over the contour midpoints: the hand asks "what is within
    // half a metre of me" sixty times a second, and the floor alone is a single box with tens of
    // thousands of dots, so a per-box range is not a usable answer. Counting sort, built once.
    this.dotGrid = new PointGrid(this.dotPos, dots, REACH_CELL);
    this.edgeGrid = new PointGrid(this.edgeMid, this.pieces, REACH_CELL);

    this.built = true;
    this.stats.built = true;
    this.stats.buildMs = performance.now() - t0;
    this.stats.dots = dots;
    this.stats.edges = this.pieces;
    // Per dot: position(3) + birth + prior + wave + seed + accent + refresh(2) + touch, all f32.
    // Per contour vertex: position(3) + birth + prior + t + accent + refresh(2) + touch, all f32.
    // Per contour piece, CPU-side only: midpoint(3) f32 + box index i32 + two normal indices u8.
    this.stats.bytes =
      dots * 11 * 4 + verts * 10 * 4 + this.pieces * (3 * 4 + 4 + 2) +
      this.dotGrid.bytes + this.edgeGrid.bytes;
    this.stats.unlockedDots = 0;
    this.stats.unlockedEdges = 0;
    this.stats.touchedDots = 0;
  }

  // ---- look ----------------------------------------------------------------

  /**
   * Pushes the tunables and the shared age ramp into both shaders. `refreshSeconds` and
   * `featherStart` come from the wave tunables rather than from this module's own: the silent
   * refresh and the bounds on it are one policy across both paint backends, so each has exactly
   * one number behind it. (The floor is per *event* rather than per look, so it arrives with the
   * event, in `handle`.)
   */
  applyLook(windowRadius: number, refreshSeconds: number, featherStart: number): void {
    this.refreshSeconds = refreshSeconds;
    this.featherStart = featherStart;
    const t = this.tunables;
    const d = this.dotMaterial.uniforms;
    const e = this.edgeMaterial.uniforms;
    d.uSizeWorld!.value = t.dotSize;
    d.uPixelCap!.value = t.pixelCap;
    d.uRipple!.value = t.ripple;
    d.uRingWidth!.value = t.ringWidth;
    d.uDotBright!.value = t.dotBright;
    d.uProbeBright!.value = t.probeBright;
    d.uProbeSize!.value = t.probeSize;
    d.uProbeSoft!.value = t.probeSoftness;
    d.uDotSoft!.value = t.dotSoftness;
    d.uSkeletonSize!.value = this.ramp.skeletonSize;
    e.uInkSeconds!.value = t.inkSeconds;
    e.uContourBright!.value = t.contourBright;
    for (const u of [d, e]) {
      u.uRefreshSeconds!.value = refreshSeconds;
      u.uWindowRadius!.value = windowRadius;
      (u.uRampTimes!.value as THREE.Vector3).set(
        this.ramp.freshSeconds,
        this.ramp.coolSeconds,
        this.ramp.coldSeconds,
      );
      u.uSkeletonAlpha!.value = this.ramp.skeletonAlpha;
    }
  }

  setTime(seconds: number): void {
    this.time = seconds;
    this.dotMaterial.uniforms.uTime!.value = seconds;
    this.edgeMaterial.uniforms.uTime!.value = seconds;
  }

  setListener(x: number, y: number, z: number): void {
    this.listener.set(x, y, z);
    (this.dotMaterial.uniforms.uListener!.value as THREE.Vector3).set(x, y, z);
    (this.edgeMaterial.uniforms.uListener!.value as THREE.Vector3).set(x, y, z);
  }

  setProjScale(scale: number): void {
    this.dotMaterial.uniforms.uProjScale!.value = scale;
  }

  /**
   * Where the hand is. `y` is the *bottom* of the reach column and `span` its height, because
   * the player feels with a body, not with an eyeball: the reach is a vertical segment from
   * about the shins to the head, and the sphere of `range` is swept along it.
   */
  setHand(x: number, y: number, z: number, span: number): void {
    (this.dotMaterial.uniforms.uHand!.value as THREE.Vector3).set(x, y, z);
    (this.edgeMaterial.uniforms.uHand!.value as THREE.Vector3).set(x, y, z);
    this.dotMaterial.uniforms.uHandSpan!.value = span;
    this.edgeMaterial.uniforms.uHandSpan!.value = span;
  }

  /** The hand's three numbers: how far it reaches, how bright it is there, what it leaves behind. */
  setTouchLook(range: number, near: number, memory: number): void {
    for (const u of [this.dotMaterial.uniforms, this.edgeMaterial.uniforms]) {
      u.uTouchRange!.value = range;
      u.uTouchNear!.value = near;
      u.uTouchMemory!.value = memory;
    }
  }

  setTouchVisible(on: boolean): void {
    const v = on ? 1 : 0;
    this.dotMaterial.uniforms.uTouchOn!.value = v;
    this.edgeMaterial.uniforms.uTouchOn!.value = v;
  }

  /**
   * The hand's write into the shared mask: every dot and contour piece within `radius` of the
   * reach column (the vertical segment from (x, y, z) up by `span`) is marked touched, and
   * nothing else is. No object-level shortcut and no occlusion ray — the player's own body
   * radius plus the thinnest partition in the hall is wider than the reach, so there is
   * nothing to reach through.
   *
   * Returns the number of dots this call newly reached.
   */
  revealTouch(x: number, y: number, z: number, span: number, radius: number): number {
    this.ensureBuilt();
    if (this.dotGrid === null || this.edgeGrid === null) return 0;
    const r2 = radius * radius;
    const out = this.reachScratch;
    let fresh = 0;
    let tests = 0;
    // The broadphase is still one sphere: the column's midpoint, grown by half its height.
    const midY = y + span / 2;
    const query = radius + span / 2;
    /** Distance to the vertical segment [y, y + span] at (x, z), squared. */
    const near2 = (px: number, py: number, pz: number): number => {
      const dx = px - x;
      const dz = pz - z;
      const dy = py < y ? py - y : py > y + span ? py - (y + span) : 0;
      return dx * dx + dy * dy + dz * dz;
    };

    this.dotGrid.candidates(x, midY, z, query, out);
    tests += out.length;
    for (let n = 0; n < out.length; n++) {
      const i = out[n]!;
      if (this.dotTouch[i]! > NEVER) continue;
      const i3 = i * 3;
      if (near2(this.dotPos[i3]!, this.dotPos[i3 + 1]!, this.dotPos[i3 + 2]!) > r2) continue;
      // The *time* it was felt, not a flag: the trail has to age like everything else.
      this.dotTouch[i] = this.time;
      this.markTouchDots(i, i);
      fresh++;
    }

    /*
     * And the same over the contour pieces, but stamped per *end*. A piece is drawn only when
     * both of its vertices were reached (the shader ANDs them), so the hand reveals the length
     * of edge it actually ran along and no more: the far top edge of a crate stays dark while
     * you are holding its near face.
     */
    this.edgeGrid.candidates(x, midY, z, query, out);
    tests += out.length;
    let freshEnds = 0;
    for (let n = 0; n < out.length; n++) {
      const k = out[n]!;
      for (let e = 0; e < 2; e++) {
        const v = k * 2 + e;
        if (this.edgeTouch[v]! > NEVER) continue;
        const v3 = v * 3;
        if (near2(this.edgePos[v3]!, this.edgePos[v3 + 1]!, this.edgePos[v3 + 2]!) > r2) continue;
        this.edgeTouch[v] = this.time;
        this.markTouchEdges(v, v);
        freshEnds++;
      }
    }

    this.stats.touchedDots += fresh;
    this.stats.touchedEdges += freshEnds;
    this.stats.lastTouchedDots = fresh;
    this.stats.lastTouchTests = tests;
    if (fresh > 0 || freshEnds > 0) this.upload();
    return fresh;
  }

  clear(): void {
    this.job = null;
    if (!this.built) return;
    this.dotBirth.fill(NEVER);
    this.dotPrior.fill(NEVER);
    this.dotWave.fill(0);
    this.dotRefresh.set(unbounded(this.dotRefresh.length / 2));
    this.edgeBirth.fill(NEVER);
    this.edgePrior.fill(NEVER);
    this.edgeRefresh.set(unbounded(this.edgeRefresh.length / 2));
    this.waveMeta.fill(0);
    this.dotTouch.fill(NEVER);
    this.markTouchDots(0, this.dotTouch.length - 1);
    this.edgeTouch.fill(NEVER);
    this.markTouchEdges(0, this.edgeTouch.length - 1);
    this.stats.unlockedDots = 0;
    this.stats.unlockedEdges = 0;
    this.stats.touchedDots = 0;
    this.stats.touchedEdges = 0;
    this.stats.lastTouchedDots = 0;
    this.stats.lastTouchTests = 0;
    this.stats.lastDots = 0;
    this.stats.lastEdges = 0;
    this.stats.lastRays = 0;
    this.stats.lastMs = 0;
    this.stats.lastChunkMs = 0;
    this.stats.lastChunks = 0;
    this.stats.lastRefreshed = 0;
    this.stats.lastFloor = 0;
    this.stats.lastFeatherMean = 0;
    this.stats.lastFloored = 0;
    this.stats.lastJump = 0;
    this.stats.lastLate = 0;
    this.stats.lastLateStep = 0;
    this.featherSum = 0;
    this.markDots(0, this.dotBirth.length - 1);
    this.markEdges(0, this.edgeBirth.length - 1);
    this.upload();
    this.diagTime = Number.NaN;
  }

  // ---- unlocking -----------------------------------------------------------

  /**
   * Plans the unlock pass for one event and runs its first chunk immediately.
   *
   * The plan is cheap and bounded: one range/cone reject per box, plus a handful of probe rays
   * for each prop that survives it. Everything expensive — the per-dot occlusion tests on the
   * room shell — is left to the chunks, which is safe precisely because an item's arrival stamp
   * is a function of the event's own time and the distance to it (§the wave engine): a dot
   * unlocked three frames late still lights at exactly the instant the front reached it.
   */
  handle(event: LidarPing, now: number, floorAge = 0): void {
    this.ensureBuilt();
    this.drain();

    this.stats.lastDots = 0;
    this.stats.lastEdges = 0;
    this.stats.lastRays = 0;
    this.stats.lastMs = 0;
    this.stats.lastChunkMs = 0;
    this.stats.lastChunks = 0;
    this.stats.lastRefreshed = 0;
    this.stats.lastFloor = floorAge;
    this.stats.lastFeatherMean = 0;
    this.stats.lastFloored = 0;
    this.stats.lastJump = 0;
    this.stats.lastLate = 0;
    this.stats.lastLateStep = 0;
    this.featherSum = 0;

    const slot = this.slotCursor++ % WAVE_SLOTS;
    this.waveOrigin[slot * 4] = event.x;
    this.waveOrigin[slot * 4 + 1] = event.y;
    this.waveOrigin[slot * 4 + 2] = event.z;
    this.waveOrigin[slot * 4 + 3] = event.time;
    this.waveMeta[slot * 2] = event.waveSpeed;
    this.waveMeta[slot * 2 + 1] = 1;
    this.pushWaves();

    const omni = event.coneAngleDeg >= 359.9;
    const job: UnlockJob = {
      ox: event.x,
      oy: event.y,
      oz: event.z,
      dirX: event.dirX,
      dirY: event.dirY,
      dirZ: event.dirZ,
      cosHalf: omni ? -1 : Math.cos((event.coneAngleDeg * Math.PI) / 360),
      radius: event.paintRadius,
      t0: event.time,
      invSpeed: 1 / event.waveSpeed,
      slot,
      floor: floorAge,
      featherFrom: event.paintRadius * Math.min(0.999, Math.max(0, this.featherStart)),
      faceCursor: 0,
      dotCursor: 0,
      edgeCursor: 0,
      planned: false,
    };
    this.job = job;
    this.plan(job);
    this.runChunk(this.tunables.chunkItems, this.tunables.chunkMs, now);
  }

  /**
   * The only per-box decision left: could this box hold *any* point the event can reach? A
   * range and cone reject on its bounding sphere, and nothing else — what actually unlocks is
   * decided one point at a time in `runChunk` (§the header, rule 3).
   */
  private plan(job: UnlockJob): void {
    const t0 = performance.now();
    const boxes = this.world.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const rec = this.boxes[i]!;
      this.accept[i] = 0;
      const dx = rec.cx - job.ox;
      const dy = rec.cy - job.oy;
      const dz = rec.cz - job.oz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d - rec.r > job.radius) continue;
      if (job.cosHalf > -1 && d > rec.r) {
        // Cone reject on the bounding sphere, exactly as the blip sampler culls candidates.
        const cosA = (dx * job.dirX + dy * job.dirY + dz * job.dirZ) / d;
        const angle = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
        if (angle - Math.asin(Math.min(1, rec.r / d)) > Math.acos(job.cosHalf)) continue;
      }
      this.accept[i] = 1;
    }
    job.planned = true;
    this.stats.lastMs += performance.now() - t0;
    this.diagTime = Number.NaN;
  }

  /** Finishes the outstanding unlock pass immediately, whatever it costs. */
  drain(): void {
    let guard = 0;
    while (this.job !== null && guard++ < 512) {
      this.runChunk(Infinity, Infinity, this.time);
    }
    this.job = null;
  }

  /** One chunk of unlocking per frame, gated on wall clock like the blip sampler. */
  advance(now: number, gapMs: number): void {
    this.setTime(now);
    if (this.job === null) return;
    if (performance.now() - this.lastChunkAt < gapMs) return;
    this.runChunk(this.tunables.chunkItems, this.tunables.chunkMs, now);
  }

  private runChunk(maxItems: number, budgetMs: number, now: number): void {
    const job = this.job;
    if (job === null) return;
    const start = performance.now();
    let items = 0;

    const r2 = job.radius * job.radius;
    const faces = this.faces;

    while (job.faceCursor < faces.length) {
      const face = faces[job.faceCursor]!;
      if (this.accept[face.box]! === 0) {
        job.faceCursor++;
        job.dotCursor = 0;
        continue;
      }
      if (job.dotCursor === 0) {
        if (!this.faceInReach(face, job)) {
          job.faceCursor++;
          continue;
        }
        this.buildCands(job, face.cx, face.cy, face.cz, face.r);
        this.candBox = -1;
      }
      const end = face.dot0 + face.dotN;
      let i = face.dot0 + job.dotCursor;
      for (; i < end; i++) {
        if (items >= maxItems) break;
        // Polled inside the face, not just between faces: one face of the floor is twenty
        // thousand dots, and a chunk that could only stop at a face boundary would blow its
        // millisecond budget by a factor of two (measured).
        if ((items & 511) === 0 && performance.now() - start >= budgetMs) break;
        items++;
        const i3 = i * 3;
        const px = this.dotPos[i3]!;
        const py = this.dotPos[i3 + 1]!;
        const pz = this.dotPos[i3 + 2]!;
        const dx = px - job.ox;
        const dy = py - job.oy;
        const dz = pz - job.oz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const dist = Math.sqrt(d2);
        // Every surface in the world answers only where it was actually struck — the wall, the
        // floor and the crate on the same terms.
        if (job.cosHalf > -1 && dist > 1e-4) {
          if ((dx * job.dirX + dy * job.dirY + dz * job.dirZ) / dist < job.cosHalf) continue;
        }
        this.stats.lastRays++;
        if (this.blocked(job.ox, job.oy, job.oz, px, py, pz, face.box)) continue;
        this.unlockDot(
          i,
          job.t0 + dist * job.invSpeed,
          now,
          job.slot,
          job.floor,
          1 - smoothstep(job.featherFrom, job.radius, dist),
        );
      }
      job.dotCursor = i - face.dot0;
      if (i < end) {
        this.endChunk(start);
        return;
      }
      job.faceCursor++;
      job.dotCursor = 0;
      if (items >= maxItems || performance.now() - start >= budgetMs) {
        this.endChunk(start);
        return;
      }
    }

    while (job.edgeCursor < this.pieces) {
      const k = job.edgeCursor;
      const kbox = this.edgeBox[k]!;
      if (this.accept[kbox]! === 0) {
        job.edgeCursor++;
        continue;
      }
      // Contour pieces come in box order, so the candidate set is rebuilt once per box.
      if (kbox !== this.candBox) {
        const rec = this.boxes[kbox]!;
        this.buildCands(job, rec.cx, rec.cy, rec.cz, rec.r);
        this.candBox = kbox;
      }
      items++;
      const k3 = k * 3;
      const mx = this.edgeMid[k3]!;
      const my = this.edgeMid[k3 + 1]!;
      const mz = this.edgeMid[k3 + 2]!;
      const dx = mx - job.ox;
      const dy = my - job.oy;
      const dz = mz - job.oz;
      const d2 = dx * dx + dy * dy + dz * dz;
      job.edgeCursor++;
      if (d2 > r2) continue;
      const dist = Math.sqrt(d2);
      if (job.cosHalf > -1 && dist > 1e-4) {
        if ((dx * job.dirX + dy * job.dirY + dz * job.dirZ) / dist < job.cosHalf) continue;
      }
      // A crease is directly heard when one of the two faces it belongs to is, so the test is
      // run just off whichever of them is turned toward the sound.
      if (!this.creaseHeard(k, mx, my, mz, job)) continue;
      this.unlockEdge(
        k,
        job.t0 + dist * job.invSpeed,
        now,
        job.slot,
        job.floor,
        1 - smoothstep(job.featherFrom, job.radius, dist),
      );
      if (items >= maxItems || performance.now() - start >= budgetMs) {
        this.endChunk(start);
        return;
      }
    }

    this.job = null;
    this.endChunk(start);
  }

  private endChunk(start: number): void {
    const ms = performance.now() - start;
    this.lastChunkAt = performance.now();
    this.stats.lastMs += ms;
    if (ms > this.stats.lastChunkMs) this.stats.lastChunkMs = ms;
    this.stats.lastChunks++;
    this.upload();
    this.diagTime = Number.NaN;
  }

  /** Face-level rejects: out of range, out of the cone, or turned away from the sound. */
  private faceInReach(face: StructFace, job: UnlockJob): boolean {
    const dx = face.cx - job.ox;
    const dy = face.cy - job.oy;
    const dz = face.cz - job.oz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d - face.r > job.radius) return false;
    const origin = face.axis === 0 ? job.ox : face.axis === 1 ? job.oy : job.oz;
    if ((origin - face.plane) * face.sign <= 0) return false;
    if (job.cosHalf > -1 && d > face.r) {
      const cosA = (dx * job.dirX + dy * job.dirY + dz * job.dirZ) / d;
      const angle = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
      if (angle - Math.asin(Math.min(1, face.r / d)) > Math.acos(job.cosHalf)) return false;
    }
    return true;
  }

  private creaseHeard(k: number, mx: number, my: number, mz: number, job: UnlockJob): boolean {
    const box = this.edgeBox[k]!;
    for (const idx of [this.edgeNa[k]!, this.edgeNb[k]!]) {
      const n = NORMALS[idx]!;
      const axis = idx >> 1;
      const plane = axis === 0 ? mx : axis === 1 ? my : mz;
      const origin = axis === 0 ? job.ox : axis === 1 ? job.oy : job.oz;
      if ((origin - plane) * n[axis]! <= 0) continue;
      this.stats.lastRays++;
      if (!this.blocked(job.ox, job.oy, job.oz, mx + n[0] * 0.03, my + n[1] * 0.03, mz + n[2] * 0.03, box)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Is the straight path from the sound to this point interrupted?
   *
   * The last box that blocked anything is tried first: shadows are contiguous, so on a wall in
   * shadow this turns a sixty-box loop into one slab test. `skip` is the surface's own box — a
   * convex box never occludes a point on its own front-facing side, and its back faces are
   * rejected before they ever get here.
   */
  private blocked(
    ox: number,
    oy: number,
    oz: number,
    tx: number,
    ty: number,
    tz: number,
    skip: number,
  ): boolean {
    const dx = tx - ox;
    const dy = ty - oy;
    const dz = tz - oz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return false;
    const inv = 1 / len;
    const ux = dx * inv;
    const uy = dy * inv;
    const uz = dz * inv;
    const maxT = len - Math.min(0.05, len * 0.25);
    const boxes = this.world.boxes;

    const last = this.lastBlocker;
    if (last >= 0 && last !== skip && last < boxes.length) {
      if (this.hits(last, ox, oy, oz, ux, uy, uz, maxT)) return true;
    }
    for (let c = 0; c < this.candCount; c++) {
      const i = this.candList[c]!;
      if (i === skip || i === last) continue;
      if (this.hits(i, ox, oy, oz, ux, uy, uz, maxT)) {
        this.lastBlocker = i;
        return true;
      }
    }
    return false;
  }

  /**
   * Narrows the world to the boxes that could shadow a sphere of radius `r` about (cx, cy, cz)
   * as seen from the sound. One pass over the box spheres; the rays that follow are then cheap.
   */
  private buildCands(job: UnlockJob, cx: number, cy: number, cz: number, r: number): void {
    const boxes = this.world.boxes;
    const vx = cx - job.ox;
    const vy = cy - job.oy;
    const vz = cz - job.oz;
    const vv = vx * vx + vy * vy + vz * vz;
    let count = 0;
    for (let i = 0; i < boxes.length; i++) {
      const o4 = i * 4;
      const sx = this.spheres[o4]! - job.ox;
      const sy = this.spheres[o4 + 1]! - job.oy;
      const sz = this.spheres[o4 + 2]! - job.oz;
      let t = vv > 1e-9 ? (sx * vx + sy * vy + sz * vz) / vv : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = sx - vx * t;
      const dy = sy - vy * t;
      const dz = sz - vz * t;
      const reach = this.spheres[o4 + 3]! + r + 0.1;
      if (dx * dx + dy * dy + dz * dz <= reach * reach) this.candList[count++] = i;
    }
    this.candCount = count;
  }

  /** Bounding-sphere reject, then the slab test. */
  private hits(
    i: number,
    ox: number,
    oy: number,
    oz: number,
    ux: number,
    uy: number,
    uz: number,
    maxT: number,
  ): boolean {
    const o4 = i * 4;
    const r = this.spheres[o4 + 3]!;
    const ex = this.spheres[o4]! - ox;
    const ey = this.spheres[o4 + 1]! - oy;
    const ez = this.spheres[o4 + 2]! - oz;
    const proj = ex * ux + ey * uy + ez * uz;
    if (proj - r > maxT) return false;
    if (proj < -r) return false;
    if (ex * ex + ey * ey + ez * ez - proj * proj > r * r) return false;

    const b = this.world.boxes[i]!;
    let tmin = 0;
    let tmax = maxT;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? ox : a === 1 ? oy : oz;
      const d = a === 0 ? ux : a === 1 ? uy : uz;
      const lo = a === 0 ? b.minX : a === 1 ? b.minY : b.minZ;
      const hi = a === 0 ? b.maxX : a === 1 ? b.maxY : b.maxZ;
      if (d > -1e-9 && d < 1e-9) {
        if (o < lo || o > hi) return false;
        continue;
      }
      const invD = 1 / d;
      let t1 = (lo - o) * invD;
      let t2 = (hi - o) * invD;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    return true;
  }

  /**
   * The age an item is displaying this instant, under the exact curve its shader runs.
   *
   * The blip cloud's `displayedAge`, over this module's arrays. It exists for the same reason:
   * an item bounded by a floor and a feather sits *between* its two stamps, so the only stamp
   * that can be written back without moving the picture is the one that reproduces what is on
   * screen now.
   */
  private displayedAge(
    birth: number,
    prior: number,
    floor: number,
    feather: number,
    now: number,
  ): number {
    const ageNew = now - birth;
    if (prior <= -1e8) return ageNew;
    const ageOld = now - prior;
    const target = Math.min(ageOld, Math.max(ageNew, floor));
    const s = smoothstep(0, Math.max(0.001, this.refreshSeconds), ageNew) * feather;
    return ageOld + (target - ageOld) * s;
  }

  /**
   * Restamps one item. The dual stamp is the blip system's, verbatim: only an arrival that has
   * genuinely landed may become the fallback, so a point restamped twice in flight never falls
   * back to a stamp that never happened — and what lands there is the *effective* stamp, the one
   * that reproduces the age on screen, so a bounded refresh has no baseline to snap.
   */
  private unlockDot(
    i: number,
    arrival: number,
    now: number,
    slot: number,
    floor: number,
    feather: number,
  ): void {
    const old = this.dotBirth[i]!;
    if (old <= -1e8) this.stats.unlockedDots++;
    const prior = this.dotPrior[i]!;
    const before = this.displayedAge(
      old,
      prior,
      this.dotRefresh[i * 2]!,
      this.dotRefresh[i * 2 + 1]!,
      now,
    );
    if (old <= now) this.dotPrior[i] = now - before;
    this.dotBirth[i] = arrival;
    this.dotWave[i] = slot;
    this.dotRefresh[i * 2] = floor;
    this.dotRefresh[i * 2 + 1] = feather;
    // "Refreshed" is the blip cloud's sense of it: this item was already known, whether it was
    // known from one event or from ten, so the bounds are what decides how it answers this one.
    if (old > -1e8) {
      this.stats.lastRefreshed++;
      this.featherSum += feather;
      this.stats.lastFeatherMean = this.featherSum / this.stats.lastRefreshed;
      if (floor > 0 && before > floor) this.stats.lastFloored++;
    }
    /*
     * Only where there is a picture to disturb, and split the same way the cloud splits it: a dot
     * nobody has unlocked yet has no age on screen to step (it carries the never sentinel, which
     * is not a number this measurement means anything about), and one the front has already swept
     * past has no ease left to run and takes its new age at once. The claim is about the case in
     * between, which is every case at a frame rate the player would accept.
     */
    if (old > -1e8 && old <= now) {
      const jump = Math.abs(
        this.displayedAge(arrival, this.dotPrior[i]!, floor, feather, now) - before,
      );
      if (arrival > now) {
        if (jump > this.stats.lastJump) this.stats.lastJump = jump;
      } else {
        this.stats.lastLate++;
        if (jump > this.stats.lastLateStep) this.stats.lastLateStep = jump;
      }
    }
    this.stats.lastDots++;
    this.markDots(i, i);
  }

  private unlockEdge(
    k: number,
    arrival: number,
    now: number,
    slot: number,
    floor: number,
    feather: number,
  ): void {
    const v = k * 2;
    const old = this.edgeBirth[v]!;
    if (old <= -1e8) this.stats.unlockedEdges++;
    const shown = this.displayedAge(
      old,
      this.edgePrior[v]!,
      this.edgeRefresh[v * 2]!,
      this.edgeRefresh[v * 2 + 1]!,
      now,
    );
    const prior = old <= now ? now - shown : this.edgePrior[v]!;
    this.edgeBirth[v] = arrival;
    this.edgeBirth[v + 1] = arrival;
    this.edgePrior[v] = prior;
    this.edgePrior[v + 1] = prior;
    this.edgeRefresh[v * 2] = floor;
    this.edgeRefresh[v * 2 + 1] = feather;
    this.edgeRefresh[(v + 1) * 2] = floor;
    this.edgeRefresh[(v + 1) * 2 + 1] = feather;
    this.stats.lastEdges++;
    this.markEdges(v, v + 1);
    void slot;
  }

  private markDots(lo: number, hi: number): void {
    if (lo < this.dotDirtyMin) this.dotDirtyMin = lo;
    if (hi > this.dotDirtyMax) this.dotDirtyMax = hi;
  }

  private markEdges(lo: number, hi: number): void {
    if (lo < this.edgeDirtyMin) this.edgeDirtyMin = lo;
    if (hi > this.edgeDirtyMax) this.edgeDirtyMax = hi;
  }

  private markTouchDots(lo: number, hi: number): void {
    if (lo < this.touchDotDirtyMin) this.touchDotDirtyMin = lo;
    if (hi > this.touchDotDirtyMax) this.touchDotDirtyMax = hi;
  }

  private markTouchEdges(lo: number, hi: number): void {
    if (lo < this.touchEdgeDirtyMin) this.touchEdgeDirtyMin = lo;
    if (hi > this.touchEdgeDirtyMax) this.touchEdgeDirtyMax = hi;
  }

  private upload(): void {
    if (this.dotDirtyMax >= this.dotDirtyMin) {
      const start = this.dotDirtyMin;
      const count = this.dotDirtyMax - start + 1;
      for (const name of ['aBirth', 'aPrior', 'aWave']) {
        const attr = this.dotGeometry.getAttribute(name) as THREE.BufferAttribute;
        attr.addUpdateRange(start, count);
        attr.needsUpdate = true;
      }
      // Two floats an item, so its range is the same window in twice the units.
      const refresh = this.dotGeometry.getAttribute('aRefresh') as THREE.BufferAttribute;
      refresh.addUpdateRange(start * 2, count * 2);
      refresh.needsUpdate = true;
      this.dotDirtyMin = Infinity;
      this.dotDirtyMax = -Infinity;
    }
    if (this.edgeDirtyMax >= this.edgeDirtyMin) {
      const start = this.edgeDirtyMin;
      const count = this.edgeDirtyMax - start + 1;
      for (const name of ['aBirth', 'aPrior']) {
        const attr = this.edgeGeometry.getAttribute(name) as THREE.BufferAttribute;
        attr.addUpdateRange(start, count);
        attr.needsUpdate = true;
      }
      const refresh = this.edgeGeometry.getAttribute('aRefresh') as THREE.BufferAttribute;
      refresh.addUpdateRange(start * 2, count * 2);
      refresh.needsUpdate = true;
      this.edgeDirtyMin = Infinity;
      this.edgeDirtyMax = -Infinity;
    }
    if (this.touchDotDirtyMax >= this.touchDotDirtyMin) {
      const attr = this.dotGeometry.getAttribute('aTouch') as THREE.BufferAttribute;
      attr.addUpdateRange(this.touchDotDirtyMin, this.touchDotDirtyMax - this.touchDotDirtyMin + 1);
      attr.needsUpdate = true;
      this.touchDotDirtyMin = Infinity;
      this.touchDotDirtyMax = -Infinity;
    }
    if (this.touchEdgeDirtyMax >= this.touchEdgeDirtyMin) {
      const attr = this.edgeGeometry.getAttribute('aTouch') as THREE.BufferAttribute;
      attr.addUpdateRange(
        this.touchEdgeDirtyMin,
        this.touchEdgeDirtyMax - this.touchEdgeDirtyMin + 1,
      );
      attr.needsUpdate = true;
      this.touchEdgeDirtyMin = Infinity;
      this.touchEdgeDirtyMax = -Infinity;
    }
  }

  private pushWaves(): void {
    for (const material of [this.dotMaterial]) {
      const a = material.uniforms.uWaveA!.value as THREE.Vector4[];
      const b = material.uniforms.uWaveB!.value as THREE.Vector4[];
      for (let i = 0; i < WAVE_SLOTS; i++) {
        a[i]!.set(
          this.waveOrigin[i * 4]!,
          this.waveOrigin[i * 4 + 1]!,
          this.waveOrigin[i * 4 + 2]!,
          this.waveOrigin[i * 4 + 3]!,
        );
        b[i]!.set(this.waveMeta[i * 2]!, this.waveMeta[i * 2 + 1]!, 0, 0);
      }
    }
  }

  // ---- diagnostics ---------------------------------------------------------

  /**
   * What a viewer could actually see this instant, re-derived from the stored stamps with the
   * same rules the shaders use — a measurement, not a restatement of the formula that produced
   * it. Cached per clock value, because tooling polls far faster than the sim ticks.
   */
  diagnostics(): StructuredDiagnostics {
    const d = this.diag;
    if (this.diagTime === this.time || !this.built) return d;
    this.diagTime = this.time;
    const now = this.time;
    const ink = Math.max(0.001, this.tunables.inkSeconds);

    let drawn = 0;
    let rippling = 0;
    let rippleMax = 0;
    for (let i = 0; i < this.dotBirth.length; i++) {
      const birth = this.dotBirth[i]!;
      if (birth <= -1e8) continue;
      const prior = this.dotPrior[i]!;
      const age = now - birth;
      // Known ground refreshes silently: it is drawn whatever the new front is doing, and it
      // never rides the ring. Only virgin lattice can be displaced.
      if (prior > -1e8) {
        drawn++;
        continue;
      }
      if (age < 0) continue;
      drawn++;
      const slot = this.dotWave[i]!;
      const speed = this.waveMeta[slot * 2]!;
      if (this.waveMeta[slot * 2 + 1]! < 0.5 || speed <= 0) continue;
      const disp = Math.abs(this.tunables.ripple * ringProfile((age * speed) / Math.max(0.05, this.tunables.ringWidth)));
      if (disp > 0.001) {
        rippling++;
        if (disp > rippleMax) rippleMax = disp;
      }
    }

    /*
     * A segment counts as inked once it has finished drawing itself — which now happens at the
     * front, so "pending" means "unlocked, but its front has not finished passing", and it is
     * the only wait left in the look. (Before batch 2.3 it also covered a fixed confirmation
     * delay; there is no such delay any more.)
     */
    let inked = 0;
    let pending = 0;
    for (let k = 0; k < this.pieces; k++) {
      const birth = this.edgeBirth[k * 2]!;
      if (birth <= -1e8) continue;
      if (this.edgePrior[k * 2]! > -1e8 || now - birth >= ink) inked++;
      else pending++;
    }

    d.drawnDots = drawn;
    d.inkedEdges = inked;
    d.pendingEdges = pending;
    d.rippling = rippling;
    d.rippleMax = rippleMax;
    return d;
  }

  /**
   * Counts what is known inside one world-space box. This is how the driver proves the
   * propagation rules from outside: that a crate's *back* face lit up when its front was struck,
   * and that the room on the far side of a partition did not.
   */
  regionStats(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): RegionStats {
    const out: RegionStats = {
      dots: 0,
      unlocked: 0,
      drawn: 0,
      rippling: 0,
      edges: 0,
      edgesUnlocked: 0,
      edgesInked: 0,
      touched: 0,
      edgesTouched: 0,
    };
    if (!this.built) return out;
    const now = this.time;
    const ink = Math.max(0.001, this.tunables.inkSeconds);
    const ring = Math.max(0.05, this.tunables.ringWidth);
    const amp = this.tunables.ripple;

    for (let i = 0; i < this.dotBirth.length; i++) {
      const i3 = i * 3;
      const x = this.dotPos[i3]!;
      const y = this.dotPos[i3 + 1]!;
      const z = this.dotPos[i3 + 2]!;
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) continue;
      out.dots++;
      if (this.dotTouch[i]! > NEVER) out.touched++;
      const birth = this.dotBirth[i]!;
      if (birth <= -1e8) continue;
      out.unlocked++;
      // Same two cases as the shader: known ground is drawn and never rides the ring; virgin
      // ground waits for its front and is displaced by it.
      if (this.dotPrior[i]! > -1e8) {
        out.drawn++;
        continue;
      }
      const age = now - birth;
      if (age < 0) continue;
      out.drawn++;
      const slot = this.dotWave[i]!;
      const speed = this.waveMeta[slot * 2]!;
      if (this.waveMeta[slot * 2 + 1]! >= 0.5 && speed > 0) {
        if (Math.abs(amp * ringProfile((age * speed) / ring)) > 0.001) out.rippling++;
      }
    }

    for (let k = 0; k < this.pieces; k++) {
      const k3 = k * 3;
      const x = this.edgeMid[k3]!;
      const y = this.edgeMid[k3 + 1]!;
      const z = this.edgeMid[k3 + 2]!;
      if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) continue;
      out.edges++;
      if (this.edgeTouch[k * 2]! > NEVER && this.edgeTouch[k * 2 + 1]! > NEVER) out.edgesTouched++;
      const birth = this.edgeBirth[k * 2]!;
      if (birth <= -1e8) continue;
      out.edgesUnlocked++;
      if (this.edgePrior[k * 2]! > -1e8 || now - birth >= ink) out.edgesInked++;
    }
    return out;
  }

  dispose(): void {
    this.dotGeometry.dispose();
    this.edgeGeometry.dispose();
    this.dotMaterial.dispose();
    this.edgeMaterial.dispose();
    this.root.clear();
  }
}
