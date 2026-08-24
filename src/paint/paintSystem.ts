/**
 * The paint system — vision doc §3, and the reason the game exists.
 *
 * It subscribes to the sound bus and, for every event it can hear, casts rays from the
 * event's *origin* against the static AABB world; every ray that lands inside the event's
 * paint radius deposits a blip. Nothing else draws the world: the meshes are dark, the lights
 * are off, and this point cloud is the entire picture.
 *
 * Four properties are load-bearing:
 *
 *  1. **Rays answer visibility; splats carry density.** A ray is a cone, not a line: everything
 *     inside its share of the solid angle landed on the patch of surface it found, so it
 *     deposits blips across that whole footprint. Because the footprints tile the surface,
 *     asking each one for `targetDensity × footprintArea` blips yields exactly `targetDensity`
 *     blips per m² — at any distance, any incidence, and any height above the floor. The §3.1
 *     quadratic falloff is then applied to `targetDensity` explicitly, relative to the event's
 *     own radius, which is what makes a bigger radius read as *louder = denser* at a fixed
 *     point: a sprint step and a crouch step both cover their own radius, so at 1.5 m the
 *     sprint step is five times the density of the crouch step.
 *
 *  2. **Age is the only colour axis for matter (§3.2).** Blips are cyan-family regardless of
 *     what painted them: ice-white → cyan → dim navy → a permanent skeleton at alpha 0.22.
 *     The source's colour lives on the event layer, never on geometry.
 *
 *  3. **Ageing is free.** Points are written once, with a birth stamp, into a preallocated
 *     ring buffer; the shader derives everything from `now - birth`. No per-point CPU work
 *     ever runs per frame — only when an event actually paints.
 *
 *  4. **Re-hearing a surface refreshes it.** A blip is a voxel of knowledge, not a particle:
 *     a hit that lands in an already-occupied cell restamps that point instead of stacking a
 *     second one on top of it. That is what keeps repeat-scanned floors from blowing out into
 *     white mush, and it bounds the buffer by the surface area of the level rather than by how
 *     long the player has been walking around.
 *
 * Known v0 limits: when the ring wraps, the oldest blips are silently overwritten (at the
 * default cap and cell size that is several levels' worth of surface, so it is a theoretical
 * concern for now); propagation through walls (§3.4) is not modelled — a ray stops at the
 * first surface, so sound does not yet leak into the next room at reduced radius.
 */

import * as THREE from 'three';
import type { Aabb, StaticWorld } from '../core/collision';
import type { SoundClass, SoundEvent } from './soundEvents';

// ---------------------------------------------------------------------------
// Look profiles
// ---------------------------------------------------------------------------

/**
 * One "look" of the point cloud. The three shipped profiles are the same physics with
 * different sampling and splat parameters — the readability question they answer is whether
 * the dark reads better as fine dust, as sparse sonar blips, or as noisy grain.
 */
export interface PaintProfile {
  readonly name: string;
  /** Multiplies every class's ray budget. */
  density: number;
  /** Deduplication cell size, metres — effectively the cloud's spatial resolution. */
  cellSize: number;
  /** Blip diameter in world metres (before jitter). */
  sizeWorld: number;
  /** Screen-space clamp on the splat, in drawing-buffer pixels. */
  minPixels: number;
  maxPixels: number;
  /** 0 = crisp disc, 1 = fully feathered. */
  softness: number;
  /** ±fraction of per-point size jitter. */
  sizeJitter: number;
  /** ±fraction of per-point brightness jitter. */
  brightJitter: number;
  /** Overall output gain. */
  brightness: number;
}

export function paintProfiles(): PaintProfile[] {
  return [
    {
      // Scanner Sombre register: many small points, geometry read from density alone.
      name: 'Dust',
      density: 1.0,
      cellSize: 0.1,
      sizeWorld: 0.065,
      minPixels: 1.0,
      maxPixels: 18,
      softness: 0.3,
      sizeJitter: 0.15,
      brightJitter: 0.12,
      brightness: 1.0,
    },
    {
      // Sonar register: fewer, fatter, soft-edged returns. Reads at a glance, loses detail.
      name: 'Blips',
      density: 0.6,
      cellSize: 0.28,
      sizeWorld: 0.175,
      minPixels: 1.6,
      maxPixels: 40,
      softness: 0.92,
      sizeJitter: 0.3,
      brightJitter: 0.15,
      brightness: 0.95,
    },
    {
      // Textured register: mid density, heavy per-point jitter — noisy, filmic, less clinical.
      name: 'Grain',
      density: 0.8,
      cellSize: 0.16,
      sizeWorld: 0.115,
      minPixels: 1.2,
      maxPixels: 26,
      softness: 0.5,
      sizeJitter: 0.8,
      brightJitter: 0.55,
      brightness: 0.95,
    },
  ];
}

/**
 * Age ramp (§3.2 and §3.6). Times are seconds on the paint clock; the last stage never
 * completes — a surface cools into the permanent memory skeleton and stays there.
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

/**
 * Matter palette — cyan-family only, forever (§3.2).
 *
 * The cold end is a *rendered* navy, not a paint-chip navy: it is multiplied by the skeleton's
 * 0.22 alpha before it reaches the screen, so picking a colour that already looks like dim navy
 * on a swatch dims it twice and the memory skeleton disappears — which would quietly cost the
 * player the map §3.6 promises they keep.
 */
const MATTER_FRESH = 0xeaffff;
const MATTER_MID = 0x28c8e6;
const MATTER_COLD = 0x16536e;

/** Event-layer palette (§3.2): self is amber, and the pings are the same self, brighter. */
const EVENT_COLORS: Record<SoundClass, number> = {
  'crouch-step': 0xd98a2b,
  'walk-step': 0xffa63c,
  'sprint-step': 0xffb95a,
  landing: 0xffd08a,
  'q-ping': 0xffe6b4,
  'e-ping': 0xfff0cc,
};

const CLASS_INDEX: Record<SoundClass, number> = {
  'crouch-step': 0,
  'walk-step': 1,
  'sprint-step': 2,
  landing: 3,
  'q-ping': 4,
  'e-ping': 5,
};

/**
 * Ray budget per event at profile density 1 and intensity 1.
 *
 * These set *angular resolution*, not density — the splat handles density. A budget of n rays
 * resolves features about `sqrt(4/n)` radians wide, so a walk step can tell a crate from a wall
 * and the E-ping can pick a railing out at 30 m. Rays are also the expensive half of painting
 * (a cast costs roughly four times a blip), which is why they are spent on the events whose
 * whole job is to answer a question.
 */
const CLASS_RAYS: Record<SoundClass, number> = {
  'crouch-step': 260,
  'walk-step': 760,
  'sprint-step': 1200,
  landing: 1900,
  'q-ping': 3600,
  'e-ping': 5600,
};

// ---------------------------------------------------------------------------
// Tunables that are not per-look
// ---------------------------------------------------------------------------

export interface PaintTunables {
  /** §3.1: paint is only received from events inside your own hearing range, metres. */
  hearingRange: number;
  /** §3.6: only blips within this radius of the listener are drawn, metres. */
  windowRadius: number;
  /** Fraction of the paint radius after which hits start thinning out to a soft rim. */
  featherStart: number;
  /** Dimming applied to a blip at the very edge of its event (1 = none). */
  rimDim: number;
  /** Distance past which E-ping returns start collapsing to silhouettes, metres (§3.5). */
  edgeStart: number;
  /** Distance at which that collapse is complete, metres. */
  edgeFull: number;
  /** How close to a face's border counts as an edge, metres. */
  edgeBand: number;
  /** Fraction of far, non-edge E-ping hits that survive. */
  farThin: number;
  /** Brightness multiplier on far edge hits — what turns the survivors into lines. */
  edgeBoost: number;
  /** Blips are floated this far off the surface so they read as sitting on it, metres. */
  surfaceOffset: number;
  /** Voxel dedup on/off. Off is the naive "one point per hit" behaviour. */
  dedupe: boolean;
  /** Most blips one ray may splat across its footprint — a safety valve, not a tuning knob. */
  splatCap: number;
  /** Peak blip density as a fraction of the dedup grid's saturation (1 = a blip per cell). */
  splatFill: number;
  /**
   * §3.1's quadratic falloff, in units of the event's own radius: density at distance t is
   * `peak / (1 + falloffK · (t/paintRadius)²)`. 0 would paint a hard-edged slab of uniform
   * density; higher values pull the paint in toward the origin.
   */
  falloffK: number;
  /**
   * Return at a grazing surface, relative to a head-on one (1 = no incidence dimming). Kept
   * mild: it is the cheapest shape cue the cloud has, but almost every floor you walk on is
   * grazing, so a hard incidence penalty just turns the ground grey.
   */
  grazeDim: number;
  /** Fraction of a cone's outer angle over which returns feather out. */
  coneFeather: number;
  /** Hard ceiling on blips deposited by one event, so no ping can stall a frame. */
  maxPerEvent: number;
}

export function defaultPaintTunables(): PaintTunables {
  return {
    hearingRange: 18,
    windowRadius: 45,
    featherStart: 0.72,
    rimDim: 0.6,
    edgeStart: 10,
    edgeFull: 26,
    edgeBand: 0.5,
    farThin: 0.3,
    edgeBoost: 2.4,
    surfaceOffset: 0.012,
    dedupe: true,
    splatCap: 128,
    splatFill: 0.9,
    falloffK: 4,
    grazeDim: 0.68,
    coneFeather: 0.32,
    maxPerEvent: 60_000,
  };
}

/** Default ring capacity. 500k blips × 28 B of attributes ≈ 14 MB on the GPU and again on the CPU. */
export const DEFAULT_CAPACITY = 500_000;
/** How many event-layer markers can be alive at once. */
const EVENT_CAPACITY = 512;
/** Event marker fade, seconds (§3.2 asks for 2.5-6 s). */
const EVENT_FADE = 2.5;
/** Event marker diameter, world metres. */
const EVENT_SIZE = 0.55;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/**
 * How far a grazing hit may stretch its footprint before the smear stops growing.
 *
 * The stretch is what keeps a floor covered — a surface met at 80° carries six times the area
 * per unit of solid angle that a wall met head-on does — but the flat ellipse the splat uses is
 * only a good stand-in for the real footprint while the whole patch sits at roughly one
 * distance. Past ~12 the ellipse would reach back behind the sound itself, so it is clamped and
 * that last sliver of grazing floor is allowed to thin out instead.
 */
const MAX_FOOTPRINT_STRETCH = 12;

/** mulberry32 — small, fast, and seedable so screenshots of different looks are comparable. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Colours are authored in sRGB and written straight to the framebuffer by the raw shader. */
function rawColor(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
}

// ---- ray / AABB -----------------------------------------------------------

/** Nearest-hit scratch, reused for every ray. */
const hit = {
  t: 0,
  axis: -1,
  box: null as Aabb | null,
};

/**
 * Per-event bounding spheres of the candidate boxes, in a flat array of (cx, cy, cz, r).
 * A ray-vs-sphere reject is about a third of the cost of the slab test and throws out most
 * of the room for most rays, which is where the ping's frame budget actually goes.
 */
const spheres: number[] = [];

function buildSpheres(candidates: readonly Aabb[]): void {
  spheres.length = candidates.length * 4;
  for (let i = 0; i < candidates.length; i++) {
    const b = candidates[i]!;
    const hx = (b.maxX - b.minX) / 2;
    const hy = (b.maxY - b.minY) / 2;
    const hz = (b.maxZ - b.minZ) / 2;
    const o = i * 4;
    spheres[o] = b.minX + hx;
    spheres[o + 1] = b.minY + hy;
    spheres[o + 2] = b.minZ + hz;
    spheres[o + 3] = Math.sqrt(hx * hx + hy * hy + hz * hz);
  }
}

/**
 * Nearest intersection of a ray with a candidate list, using the slab test.
 * Returns false when nothing was hit inside `maxT`. Boxes the origin is already inside are
 * skipped: a sound made *inside* a wall is not a thing the game can produce.
 */
function castRay(
  candidates: readonly Aabb[],
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
): boolean {
  let nearest = maxT;
  let nearestAxis = -1;
  let nearestBox: Aabb | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const o4 = i * 4;
    const r = spheres[o4 + 3]!;
    const ex = spheres[o4]! - ox;
    const ey = spheres[o4 + 1]! - oy;
    const ez = spheres[o4 + 2]! - oz;
    const proj = ex * dx + ey * dy + ez * dz;
    if (proj - r > nearest) continue; // entirely past the closest hit so far
    if (proj < -r) continue; // entirely behind the ray
    const perp = ex * ex + ey * ey + ez * ez - proj * proj;
    if (perp > r * r) continue; // the ray line misses the bounding sphere

    const b = candidates[i]!;
    let tmin = 0;
    let tmax = nearest;
    let axis = -1;
    let miss = false;

    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? ox : a === 1 ? oy : oz;
      const d = a === 0 ? dx : a === 1 ? dy : dz;
      const lo = a === 0 ? b.minX : a === 1 ? b.minY : b.minZ;
      const hi = a === 0 ? b.maxX : a === 1 ? b.maxY : b.maxZ;
      if (d > -1e-9 && d < 1e-9) {
        if (o < lo || o > hi) {
          miss = true;
          break;
        }
        continue;
      }
      const inv = 1 / d;
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = a;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) {
        miss = true;
        break;
      }
    }
    // axis < 0 means the origin started inside this box on every slab — not a surface hit.
    if (miss || axis < 0 || tmin >= nearest) continue;
    nearest = tmin;
    nearestAxis = axis;
    nearestBox = b;
  }

  if (nearestBox === null) return false;
  hit.t = nearest;
  hit.axis = nearestAxis;
  hit.box = nearestBox;
  return true;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const MATTER_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSizeWorld;
  uniform float uProjScale;
  uniform float uMinPixels;
  uniform float uMaxPixels;
  uniform float uSizeJitter;
  uniform float uWindowRadius;
  uniform vec3  uListener;
  uniform vec3  uRampTimes;      // fresh, cool, cold
  uniform float uSkeletonSize;

  attribute float aBirth;
  attribute float aIntensity;
  attribute float aSeed;

  varying float vAge;
  varying float vIntensity;
  varying float vSeed;
  varying float vCoverage;

  void main() {
    vAge = max(0.0, uTime - aBirth);
    vIntensity = aIntensity;
    vSeed = aSeed;
    vCoverage = 1.0;

    // §3.6: the map persists, the *rendering* is windowed. Outside the window, drop the vertex.
    if (distance(position, uListener) > uWindowRadius) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float depth = max(0.001, -mv.z);

    float cooled = clamp(vAge / max(0.001, uRampTimes.z), 0.0, 1.0);
    float jitter = 1.0 + uSizeJitter * (aSeed - 0.5) * 2.0;
    float shrink = mix(1.0, uSkeletonSize, cooled);
    float want = uSizeWorld * jitter * shrink * uProjScale / depth;
    float px = clamp(want, uMinPixels, uMaxPixels);
    // Below the minimum splat size the blip covers more screen than it should; give back the
    // difference in brightness so distant clouds fade out instead of aliasing into a bright wash.
    vCoverage = min(1.0, (want * want) / (px * px));

    gl_PointSize = px;
    gl_Position = projectionMatrix * mv;
  }
`;

const MATTER_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform vec3  uFresh;
  uniform vec3  uMid;
  uniform vec3  uCold;
  uniform vec3  uRampTimes;      // fresh, cool, cold
  uniform float uSkeletonAlpha;
  uniform float uBrightness;
  uniform float uSoftness;
  uniform float uBrightJitter;

  varying float vAge;
  varying float vIntensity;
  varying float vSeed;
  varying float vCoverage;

  void main() {
    vec2 pc = gl_PointCoord - 0.5;
    float r = length(pc) * 2.0;
    float inner = 1.0 - clamp(uSoftness, 0.0, 0.999);
    float shape = 1.0 - smoothstep(inner, 1.0, r);
    if (shape <= 0.002) discard;

    // Matter is cyan-family always; only *age* moves along the band (§3.2).
    vec3 col;
    float alpha;
    if (vAge < uRampTimes.x) {
      float t = vAge / max(0.001, uRampTimes.x);
      col = mix(uFresh, uMid, t * t);
      alpha = mix(1.0, 0.9, t);
    } else if (vAge < uRampTimes.y) {
      float t = (vAge - uRampTimes.x) / max(0.001, uRampTimes.y - uRampTimes.x);
      col = mix(uMid, uCold, t);
      alpha = mix(0.9, 0.42, t);
    } else {
      float t = clamp((vAge - uRampTimes.y) / max(0.001, uRampTimes.z - uRampTimes.y), 0.0, 1.0);
      col = uCold;
      alpha = mix(0.42, uSkeletonAlpha, t);
    }

    float bright = uBrightness * vIntensity * vCoverage
      * (1.0 + uBrightJitter * (fract(vSeed * 37.13) - 0.5) * 2.0);

    gl_FragColor = vec4(col * max(0.0, bright), shape * alpha);
  }
`;

const EVENT_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uFade;
  uniform float uProjScale;
  uniform float uSizeWorld;

  attribute float aBirth;
  attribute float aScale;
  attribute vec3  aColor;

  varying float vT;
  varying vec3  vColor;

  void main() {
    vT = (uTime - aBirth) / max(0.001, uFade);
    vColor = aColor;
    if (vT < 0.0 || vT >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float grow = 0.6 + 0.55 * smoothstep(0.0, 0.4, vT);
    gl_PointSize = clamp(uSizeWorld * aScale * grow * uProjScale / max(0.001, -mv.z), 4.0, 72.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const EVENT_FRAGMENT = /* glsl */ `
  precision highp float;
  varying float vT;
  varying vec3  vColor;

  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    float core = 1.0 - smoothstep(0.0, 0.4, r);
    float glow = pow(1.0 - r, 2.5);
    float fade = 1.0 - vT;
    float a = (core * 0.85 + glow * 0.5) * fade * fade;
    gl_FragColor = vec4(vColor * (0.55 + 0.6 * core), a);
  }
`;

// ---------------------------------------------------------------------------

export interface PaintStats {
  /** Blips currently in the buffer. */
  points: number;
  capacity: number;
  /** True once the ring has wrapped and started overwriting the oldest blips. */
  wrapped: boolean;
  /** Rays cast by the most recent event. */
  lastRays: number;
  /** Blips deposited by the most recent event. */
  lastDeposited: number;
  /** Existing blips restamped by the most recent event. */
  lastRefreshed: number;
  /** Wall-clock cost of the most recent event's sampling, ms. */
  lastPaintMs: number;
  /** Distance of the most distant blip the last event produced, metres. */
  lastMaxRange: number;
  /** How many of the last event's blips landed beyond `FAR_RANGE`. */
  lastFar20: number;
}

/** Reporting threshold for "this event reached across the room", metres. */
const FAR_RANGE = 20;

export class PaintSystem {
  readonly tunables: PaintTunables;
  readonly ramp: AgeRamp;
  readonly profiles = paintProfiles();

  private profileIndex = 0;
  private readonly capacity: number;

  // ---- matter layer ring buffer -------------------------------------------
  private readonly positions: Float32Array;
  private readonly births: Float32Array;
  private readonly intensities: Float32Array;
  private readonly seeds: Float32Array;
  private readonly classes: Float32Array;
  /** Dedup cell key currently held by each slot, or -1. Lets a ring wrap unmap cleanly. */
  private readonly slotKeys: Float64Array;
  private readonly cells = new Map<number, number>();
  private writeIndex = 0;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly points: THREE.Points;

  // ---- event layer ---------------------------------------------------------
  private readonly eventPositions = new Float32Array(EVENT_CAPACITY * 3);
  private readonly eventColors = new Float32Array(EVENT_CAPACITY * 3);
  private readonly eventBirths = new Float32Array(EVENT_CAPACITY);
  private readonly eventScales = new Float32Array(EVENT_CAPACITY);
  private eventIndex = 0;
  private readonly eventGeometry = new THREE.BufferGeometry();
  private readonly eventMaterial: THREE.ShaderMaterial;
  private readonly eventPoints: THREE.Points;

  private readonly root = new THREE.Group();

  private time = 0;
  private rng = makeRng(0x5eed);
  private seed = 0x5eed;
  /** Angular radius of one ray's share of the current event's solid angle, radians. */
  private spread = 0.03;
  /** Peak blips per m² for the current event, before the distance falloff. */
  private targetDensity = 90;
  /** Blips the current event may still deposit. */
  private budget = 0;
  private readonly candidates: Aabb[] = [];
  private readonly listener = new THREE.Vector3();
  private readonly viewportSize = new THREE.Vector2();
  private readonly scratchColor = new THREE.Color();

  // Dirty tracking: appended blips are contiguous, restamped ones are scattered, so the two
  // get separate ranges — a ping in a well-scanned room must not re-upload the whole buffer.
  private appendMin = Infinity;
  private appendMax = -Infinity;
  private touchMin = Infinity;
  private touchMax = -Infinity;

  private stats: PaintStats = {
    points: 0,
    capacity: 0,
    wrapped: false,
    lastRays: 0,
    lastDeposited: 0,
    lastRefreshed: 0,
    lastPaintMs: 0,
    lastMaxRange: 0,
    lastFar20: 0,
  };

  constructor(
    private readonly world: StaticWorld,
    options: { capacity?: number; tunables?: PaintTunables; ramp?: AgeRamp } = {},
  ) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.tunables = options.tunables ?? defaultPaintTunables();
    this.ramp = options.ramp ?? defaultAgeRamp();
    this.stats.capacity = this.capacity;

    this.positions = new Float32Array(this.capacity * 3);
    this.births = new Float32Array(this.capacity);
    this.intensities = new Float32Array(this.capacity);
    this.seeds = new Float32Array(this.capacity);
    this.classes = new Float32Array(this.capacity);
    this.slotKeys = new Float64Array(this.capacity).fill(-1);

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aBirth', new THREE.BufferAttribute(this.births, 1));
    this.geometry.setAttribute('aIntensity', new THREE.BufferAttribute(this.intensities, 1));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seeds, 1));
    // Reserved: the source class travels with every blip so a later batch can tint the *event*
    // layer (or debug-colour by source) without a second pass over the buffer. Matter itself
    // must never read it — §3.2.
    this.geometry.setAttribute('aClass', new THREE.BufferAttribute(this.classes, 1));
    this.geometry.setDrawRange(0, 0);

    const p = this.profiles[0]!;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSizeWorld: { value: p.sizeWorld },
        uProjScale: { value: 500 },
        uMinPixels: { value: p.minPixels },
        uMaxPixels: { value: p.maxPixels },
        uSizeJitter: { value: p.sizeJitter },
        uBrightJitter: { value: p.brightJitter },
        uBrightness: { value: p.brightness },
        uSoftness: { value: p.softness },
        uWindowRadius: { value: this.tunables.windowRadius },
        uListener: { value: new THREE.Vector3() },
        uRampTimes: {
          value: new THREE.Vector3(
            this.ramp.freshSeconds,
            this.ramp.coolSeconds,
            this.ramp.coldSeconds,
          ),
        },
        uSkeletonAlpha: { value: this.ramp.skeletonAlpha },
        uSkeletonSize: { value: this.ramp.skeletonSize },
        uFresh: { value: rawColor(MATTER_FRESH) },
        uMid: { value: rawColor(MATTER_MID) },
        uCold: { value: rawColor(MATTER_COLD) },
      },
      vertexShader: MATTER_VERTEX,
      fragmentShader: MATTER_FRAGMENT,
      transparent: true,
      // The cloud is memory, not line of sight (§3.6): it draws through walls, and nothing
      // else in this scene writes depth anyway.
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;

    this.eventGeometry.setAttribute('position', new THREE.BufferAttribute(this.eventPositions, 3));
    this.eventGeometry.setAttribute('aColor', new THREE.BufferAttribute(this.eventColors, 3));
    this.eventGeometry.setAttribute('aBirth', new THREE.BufferAttribute(this.eventBirths, 1));
    this.eventGeometry.setAttribute('aScale', new THREE.BufferAttribute(this.eventScales, 1));
    this.eventGeometry.setDrawRange(0, 0);
    this.eventBirths.fill(-1e9);

    this.eventMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: EVENT_FADE },
        uProjScale: { value: 500 },
        uSizeWorld: { value: EVENT_SIZE },
      },
      vertexShader: EVENT_VERTEX,
      fragmentShader: EVENT_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.eventPoints = new THREE.Points(this.eventGeometry, this.eventMaterial);
    this.eventPoints.frustumCulled = false;
    this.eventPoints.renderOrder = 2;

    this.root.add(this.points, this.eventPoints);
  }

  /** The object to add to the scene. */
  get object(): THREE.Object3D {
    return this.root;
  }

  get profile(): PaintProfile {
    return this.profiles[this.profileIndex]!;
  }

  get profileName(): string {
    return this.profile.name;
  }

  getStats(): PaintStats {
    this.stats.points = Math.min(this.writeIndex, this.capacity);
    this.stats.wrapped = this.writeIndex >= this.capacity;
    return this.stats;
  }

  /**
   * Switches look. Repainting is deliberate rather than optional: density and cell size are
   * *sampling* parameters, so the honest comparison is the same events resampled, not the same
   * blips restyled. Reseeding keeps the three shots comparable.
   */
  setProfile(index: number): void {
    if (index < 0 || index >= this.profiles.length) return;
    this.profileIndex = index;
    this.applyProfile();
    this.clear();
  }

  applyProfile(): void {
    const p = this.profile;
    const u = this.material.uniforms;
    u.uSizeWorld!.value = p.sizeWorld;
    u.uMinPixels!.value = p.minPixels;
    u.uMaxPixels!.value = p.maxPixels;
    u.uSizeJitter!.value = p.sizeJitter;
    u.uBrightJitter!.value = p.brightJitter;
    u.uBrightness!.value = p.brightness;
    u.uSoftness!.value = p.softness;
  }

  /** Pushes ramp/window edits from the GUI into the shader. */
  applyTunables(): void {
    const u = this.material.uniforms;
    (u.uRampTimes!.value as THREE.Vector3).set(
      this.ramp.freshSeconds,
      this.ramp.coolSeconds,
      this.ramp.coldSeconds,
    );
    u.uSkeletonAlpha!.value = this.ramp.skeletonAlpha;
    u.uSkeletonSize!.value = this.ramp.skeletonSize;
    u.uWindowRadius!.value = this.tunables.windowRadius;
  }

  /** Paint clock, in seconds. The scene owns it so it can be scaled for ageing tests. */
  setTime(seconds: number): void {
    this.time = seconds;
    this.material.uniforms.uTime!.value = seconds;
    this.eventMaterial.uniforms.uTime!.value = seconds;
  }

  get clock(): number {
    return this.time;
  }

  /** Where the ears are: gates which events are heard and which blips are drawn. */
  setListener(x: number, y: number, z: number): void {
    this.listener.set(x, y, z);
    (this.material.uniforms.uListener!.value as THREE.Vector3).set(x, y, z);
  }

  /**
   * Recomputes the world-units-to-pixels factor for `gl_PointSize`. Depends on the vertical
   * FOV and the drawing buffer height, so it is refreshed every frame rather than cached.
   */
  updateView(camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.viewportSize);
    const projScale = (camera.projectionMatrix.elements[5] ?? 1) * this.viewportSize.y * 0.5;
    this.material.uniforms.uProjScale!.value = projScale;
    this.eventMaterial.uniforms.uProjScale!.value = projScale;
  }

  /** Discards every blip and reseeds the sampler. */
  clear(): void {
    this.writeIndex = 0;
    this.cells.clear();
    this.slotKeys.fill(-1);
    this.births.fill(-1e9);
    this.eventIndex = 0;
    this.eventBirths.fill(-1e9);
    this.rng = makeRng(this.seed);
    // Nothing needs re-uploading: the draw range is zero, so whatever stale bytes the GPU
    // still holds beyond it are never read, and the next event overwrites from slot 0 up.
    this.geometry.setDrawRange(0, 0);
    this.eventGeometry.setDrawRange(0, 0);
    this.appendMin = Infinity;
    this.appendMax = -Infinity;
    this.touchMin = Infinity;
    this.touchMax = -Infinity;
    this.stats.lastRays = 0;
    this.stats.lastDeposited = 0;
    this.stats.lastRefreshed = 0;
    this.stats.lastPaintMs = 0;
    this.stats.lastMaxRange = 0;
    this.stats.lastFar20 = 0;
    this.flushEvents();
  }

  /** Fixes the sampling seed — tooling uses it to make variant screenshots comparable. */
  setSeed(seed: number): void {
    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed);
  }

  // ---- the hook the bus calls ---------------------------------------------

  handle = (event: SoundEvent): void => {
    const t0 = performance.now();
    this.stats.lastRays = 0;
    this.stats.lastDeposited = 0;
    this.stats.lastRefreshed = 0;
    this.stats.lastMaxRange = 0;
    this.stats.lastFar20 = 0;

    // §3.1: no free intel. An event you cannot hear paints you nothing.
    const heard = Math.hypot(
      event.x - this.listener.x,
      event.y - this.listener.y,
      event.z - this.listener.z,
    );
    if (heard <= this.tunables.hearingRange) {
      // Saturating the dedup grid is the densest a look can usefully be: past that every extra
      // blip lands in a cell that already has one and only restamps it.
      const cell = this.profile.cellSize;
      this.targetDensity = this.tunables.splatFill / (cell * cell);
      this.addEventMarker(event);
      if (event.coneAngleDeg >= 359.9) this.paintOmni(event);
      else this.paintCone(event);
    }
    this.stats.lastPaintMs = performance.now() - t0;
    this.flush();
  };

  // ---- sampling -----------------------------------------------------------

  private rayBudget(event: SoundEvent): number {
    const base = CLASS_RAYS[event.class];
    return Math.max(16, Math.round(base * this.profile.density * event.intensity));
  }

  private paintOmni(event: SoundEvent): void {
    const r = event.paintRadius;
    const candidates = this.world.query(
      event.x - r,
      event.y - r,
      event.z - r,
      event.x + r,
      event.y + r,
      event.z + r,
      this.candidates,
    );
    if (candidates.length === 0) return;
    buildSpheres(candidates);

    const n = this.rayBudget(event);
    this.stats.lastRays = n;
    // Angular radius of one ray's share of the sphere. Everything within it is what that ray
    // actually "heard", so that is the patch its return gets splatted over.
    this.spread = Math.sqrt(4 / n);
    this.budget = this.tunables.maxPerEvent;

    // A jittered Fibonacci sphere: even coverage without the visible spiral of the pure form.
    // Both jitters earn their keep. Stratifying `y` spaces the rays evenly in polar angle, and
    // scattering `phi` by one footprint's worth of arc breaks up the lattice's spiral arms —
    // which otherwise project onto a floor as concentric rings centred on the player, the most
    // obvious "this is a sampling pattern, not a room" tell the cloud can produce.
    const phi0 = this.rng() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + this.rng())) / n;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * GOLDEN_ANGLE + phi0 + (this.rng() - 0.5) * (this.spread / Math.max(0.15, rr));
      this.shoot(event, candidates, Math.cos(phi) * rr, y, Math.sin(phi) * rr, false, 0);
      if (this.budget <= 0) return;
    }
  }

  private paintCone(event: SoundEvent): void {
    const r = event.paintRadius;
    const half = (event.coneAngleDeg * Math.PI) / 360;
    const cosMax = Math.cos(half);
    const capRadius = r * Math.tan(half);

    // Conservative AABB of the cone: the apex plus the far cap's bounding cube.
    const cx = event.x + event.dirX * r;
    const cy = event.y + event.dirY * r;
    const cz = event.z + event.dirZ * r;
    const candidates = this.world.query(
      Math.min(event.x, cx - capRadius),
      Math.min(event.y, cy - capRadius),
      Math.min(event.z, cz - capRadius),
      Math.max(event.x, cx + capRadius),
      Math.max(event.y, cy + capRadius),
      Math.max(event.z, cz + capRadius),
      this.candidates,
    );
    if (candidates.length === 0) return;
    buildSpheres(candidates);

    // Orthonormal basis around the aim.
    const ax = Math.abs(event.dirY) < 0.9 ? 0 : 1;
    let tx = ax === 0 ? 0 : 1;
    let ty = ax === 0 ? 1 : 0;
    let tz = 0;
    // u = normalize(up x dir)
    let ux = ty * event.dirZ - tz * event.dirY;
    let uy = tz * event.dirX - tx * event.dirZ;
    let uz = tx * event.dirY - ty * event.dirX;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    // t = dir x u
    tx = event.dirY * uz - event.dirZ * uy;
    ty = event.dirZ * ux - event.dirX * uz;
    tz = event.dirX * uy - event.dirY * ux;

    const n = this.rayBudget(event);
    this.stats.lastRays = n;
    const solidAngle = 2 * Math.PI * (1 - cosMax);
    this.spread = Math.sqrt(solidAngle / (Math.PI * n));
    this.budget = this.tunables.maxPerEvent;

    const feather = this.tunables.coneFeather;
    const phi0 = this.rng() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      // Stratified in solid angle: `u` is the fraction of the cap's area, so it is also how
      // far out toward the rim this ray sits — which is exactly what the edge feather wants.
      const u = (i + this.rng()) / n;
      const cosT = 1 - u * (1 - cosMax);
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const phi = i * GOLDEN_ANGLE + phi0 + (this.rng() - 0.5) * (this.spread / Math.max(0.06, sinT));
      const cp = Math.cos(phi) * sinT;
      const sp = Math.sin(phi) * sinT;
      // A beam with a stencilled edge reads as a projected disc, not as a beam.
      let rim = 0;
      if (u > 1 - feather) {
        rim = (u - (1 - feather)) / feather;
        if (this.rng() < rim * rim) continue;
      }
      this.shoot(
        event,
        candidates,
        ux * cp + tx * sp + event.dirX * cosT,
        uy * cp + ty * sp + event.dirY * cosT,
        uz * cp + tz * sp + event.dirZ * cosT,
        true,
        rim,
      );
      if (this.budget <= 0) return;
    }
  }

  /** Casts one ray and, if it lands, splats its footprint onto the surface it found. */
  private shoot(
    event: SoundEvent,
    candidates: readonly Aabb[],
    dx: number,
    dy: number,
    dz: number,
    edgeBias: boolean,
    rim: number,
  ): void {
    const r = event.paintRadius;
    if (!castRay(candidates, event.x, event.y, event.z, dx, dy, dz, r)) return;

    const t = hit.t;
    const box = hit.box!;
    const axis = hit.axis;
    const rel = t / r;
    const tun = this.tunables;

    // Soft rim: hits thin out over the last stretch of the radius instead of stopping dead at
    // a perfect sphere, which would read as a drawn circle on every flat floor.
    if (rel > tun.featherStart) {
      const fade = (1 - rel) / (1 - tun.featherStart);
      if (this.rng() > fade) return;
    }

    const dAxis = axis === 0 ? dx : axis === 1 ? dy : dz;
    const normal = dAxis > 0 ? -1 : 1;
    const off = tun.surfaceOffset * normal;
    const px = event.x + dx * t + (axis === 0 ? off : 0);
    const py = event.y + dy * t + (axis === 1 ? off : 0);
    const pz = event.z + dz * t + (axis === 2 ? off : 0);

    // Distance dim, rim dim, and grazing return: a surface met edge-on sends less back, which
    // is both true of sound and the cheapest shape cue the cloud has.
    let intensity =
      event.intensity *
      (tun.rimDim + (1 - tun.rimDim) * (1 - rel)) *
      (tun.grazeDim + (1 - tun.grazeDim) * Math.abs(dAxis)) *
      (1 - 0.55 * rim);

    if (edgeBias && t > tun.edgeStart) {
      // §3.5: at range the E-ping returns silhouettes, not fog. Distance from the hit to the
      // border of the face it landed on stands in for "is this an edge" — cheap, and exactly
      // right for a world made of boxes.
      const eu =
        axis === 0
          ? Math.min(py - box.minY, box.maxY - py)
          : Math.min(px - box.minX, box.maxX - px);
      const ev =
        axis === 2
          ? Math.min(px - box.minX, box.maxX - px)
          : Math.min(pz - box.minZ, box.maxZ - pz);
      const edgeDist = Math.min(eu, ev);
      const edgeW = Math.max(0, 1 - edgeDist / tun.edgeBand);
      const farT = Math.min(1, (t - tun.edgeStart) / Math.max(0.001, tun.edgeFull - tun.edgeStart));
      const keep = 1 + farT * (tun.farThin + (1 - tun.farThin) * edgeW - 1);
      if (this.rng() > keep) return;
      intensity *= 1 + (tun.edgeBoost - 1) * edgeW * farT;
    }

    if (t > this.stats.lastMaxRange) this.stats.lastMaxRange = t;
    const far = t >= FAR_RANGE;
    const cls = CLASS_INDEX[event.class];

    /*
     * A ray heard a *patch*, not a point, so its return is spread over the footprint it
     * actually covers on this face. That footprint is an ellipse, not a disc: a surface met
     * at a grazing angle stretches the same solid angle into a long smear along the line of
     * range, which is why point-cloud floors streak away from you. Splatting a disc instead
     * left gaps between consecutive rays on every floor — the single biggest legibility bug
     * in the first pass of this system.
     *
     * Samples that fall off the face are dropped rather than clamped, so a box's silhouette
     * stays exactly as crisp as the geometry is.
     */
    const footprint = t * this.spread;
    const cosInc = Math.max(0.001, Math.abs(dAxis));
    const stretch = Math.min(MAX_FOOTPRINT_STRETCH, 1 / cosInc);
    // In-face direction of the range axis (the ray's projection onto the face).
    let fu = axis === 0 ? dy : dx;
    let fv = axis === 2 ? dy : dz;
    const fl = Math.hypot(fu, fv);
    if (fl > 1e-6) {
      fu /= fl;
      fv /= fl;
    } else {
      fu = 1;
      fv = 0;
    }

    // Blips per m² this event wants on the surface it just found: the grid's saturation
    // density, thinned quadratically with distance (§3.1). Multiplying by the footprint's area
    // is what turns a target *density* into a per-ray *count*.
    const area = Math.PI * footprint * footprint * stretch;
    const wanted = Math.round(area * this.targetDensity * (1 / (1 + tun.falloffK * rel * rel)));
    const splats = Math.max(1, Math.min(tun.splatCap, wanted));

    for (let s = 0; s < splats; s++) {
      let qx = px;
      let qy = py;
      let qz = pz;
      if (s > 0) {
        const ang = this.rng() * Math.PI * 2;
        const rad = Math.sqrt(this.rng());
        const along = Math.cos(ang) * rad * footprint * stretch;
        const across = Math.sin(ang) * rad * footprint;
        const du = along * fu - across * fv;
        const dv = along * fv + across * fu;
        // Offset within the hit face — the two axes that are not the surface normal.
        if (axis === 0) {
          qy = py + du;
          qz = pz + dv;
        } else if (axis === 1) {
          qx = px + du;
          qz = pz + dv;
        } else {
          qx = px + du;
          qy = py + dv;
        }
        if (axis !== 0 && (qx <= box.minX || qx >= box.maxX)) continue;
        if (axis !== 1 && (qy <= box.minY || qy >= box.maxY)) continue;
        if (axis !== 2 && (qz <= box.minZ || qz >= box.maxZ)) continue;
      }
      if (far) this.stats.lastFar20++;
      this.deposit(qx, qy, qz, intensity, cls);
      if (--this.budget <= 0) return;
    }
  }

  // ---- ring buffer ---------------------------------------------------------

  private cellKey(x: number, y: number, z: number): number {
    const c = this.profile.cellSize;
    const ix = Math.floor(x / c) + 32768;
    const iy = Math.floor(y / c) + 32768;
    const iz = Math.floor(z / c) + 32768;
    return (ix * 65536 + iy) * 65536 + iz;
  }

  private deposit(x: number, y: number, z: number, intensity: number, cls: number): void {
    if (this.tunables.dedupe) {
      const key = this.cellKey(x, y, z);
      const existing = this.cells.get(key);
      if (existing !== undefined) {
        // Already known ground: restamp it rather than pile a second blip on the same voxel.
        this.births[existing] = this.time;
        if (intensity > this.intensities[existing]!) this.intensities[existing] = intensity;
        this.markTouched(existing, existing);
        this.stats.lastRefreshed++;
        return;
      }
      const slot = this.writeIndex % this.capacity;
      const stale = this.slotKeys[slot]!;
      if (stale >= 0) this.cells.delete(stale);
      this.slotKeys[slot] = key;
      this.cells.set(key, slot);
      this.writeSlot(slot, x, y, z, intensity, cls);
      return;
    }
    this.writeSlot(this.writeIndex % this.capacity, x, y, z, intensity, cls);
  }

  private writeSlot(
    slot: number,
    x: number,
    y: number,
    z: number,
    intensity: number,
    cls: number,
  ): void {
    const i3 = slot * 3;
    this.positions[i3] = x;
    this.positions[i3 + 1] = y;
    this.positions[i3 + 2] = z;
    this.births[slot] = this.time;
    this.intensities[slot] = intensity;
    this.seeds[slot] = this.rng();
    this.classes[slot] = cls;
    this.markAppended(slot, slot);
    this.markTouched(slot, slot);
    this.writeIndex++;
    this.stats.lastDeposited++;
  }

  private markAppended(lo: number, hi: number): void {
    if (lo < this.appendMin) this.appendMin = lo;
    if (hi > this.appendMax) this.appendMax = hi;
  }

  private markTouched(lo: number, hi: number): void {
    if (lo < this.touchMin) this.touchMin = lo;
    if (hi > this.touchMax) this.touchMax = hi;
  }

  /** Uploads only the slots this event actually changed. */
  private flush(): void {
    const drawn = Math.min(this.writeIndex, this.capacity);
    this.geometry.setDrawRange(0, drawn);

    if (this.appendMax >= this.appendMin) {
      const start = this.appendMin;
      const count = this.appendMax - this.appendMin + 1;
      this.uploadRange('position', start * 3, count * 3);
      this.uploadRange('aSeed', start, count);
      this.uploadRange('aClass', start, count);
      this.appendMin = Infinity;
      this.appendMax = -Infinity;
    }
    if (this.touchMax >= this.touchMin) {
      const start = this.touchMin;
      const count = this.touchMax - this.touchMin + 1;
      this.uploadRange('aBirth', start, count);
      this.uploadRange('aIntensity', start, count);
      this.touchMin = Infinity;
      this.touchMax = -Infinity;
    }
  }

  /**
   * Queues one sub-range for upload. Ranges are *accumulated*, never cleared here: three
   * merges and clears them itself after the next draw, so several events landing between two
   * frames all survive.
   */
  private uploadRange(name: string, start: number, count: number): void {
    const attr = this.geometry.getAttribute(name) as THREE.BufferAttribute;
    attr.addUpdateRange(start, count);
    attr.needsUpdate = true;
  }

  // ---- event layer ---------------------------------------------------------

  private addEventMarker(event: SoundEvent): void {
    const slot = this.eventIndex % EVENT_CAPACITY;
    const i3 = slot * 3;
    this.eventPositions[i3] = event.x;
    this.eventPositions[i3 + 1] = event.y;
    this.eventPositions[i3 + 2] = event.z;
    this.scratchColor.setHex(EVENT_COLORS[event.class], THREE.LinearSRGBColorSpace);
    this.eventColors[i3] = this.scratchColor.r;
    this.eventColors[i3 + 1] = this.scratchColor.g;
    this.eventColors[i3 + 2] = this.scratchColor.b;
    this.eventBirths[slot] = this.time;
    this.eventScales[slot] = Math.min(2.2, 0.6 + event.paintRadius * 0.09);
    this.eventIndex++;
    this.flushEvents();
  }

  private flushEvents(): void {
    this.eventGeometry.setDrawRange(0, Math.min(this.eventIndex, EVENT_CAPACITY));
    for (const name of ['position', 'aColor', 'aBirth', 'aScale']) {
      (this.eventGeometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.eventGeometry.dispose();
    this.eventMaterial.dispose();
    this.root.clear();
  }
}
