/**
 * Being concussed, on screen.
 *
 * The verdict this exists to answer: «сейчас звон есть, но он от детской игрушки, а не от
 * контузии… мб просто применять эффект звука ко всему экрану». The audio half of it lives in
 * `src/audio/deafen.ts`; this is the other half, and the reason there is a visual half at all is
 * that a concussion is a *state*, not a sound. If the only evidence is in your ears, the player
 * files it as an audio effect and stops noticing it. If the frame itself is unwell for the same
 * five seconds, the ringing is something happening to *him*.
 *
 * ## The laws it has to obey
 *
 * `doc/proto/concept.md` §1: nothing renders "just because", and unknown space is black. So this
 * pass is allowed to **take light away and move it around, and never to add any**. Every
 * operation here is either a resampling of the frame (a warp, which cannot create energy) or a
 * multiplication by something ≤ 1 (grain dropout, the closing vignette). There is no bloom, no
 * glow, no flash, no added colour. Shoot in a black hall while concussed and the screen stays
 * black — it just stops being *still*.
 *
 * It is also not information. It tells the player nothing about the world that he did not have a
 * frame earlier; it only makes what he does have harder to read. That is the price the concept
 * keeps asking for, paid in perception. (The rejected alternative was "the HUD lies" — marks
 * drifting, the compass losing its target. That is a different mechanic, not a feeling, and the
 * human said no to it explicitly.)
 *
 * ## What it actually does
 *
 * Four things, in one pass over the frame:
 *
 *   - **a swim**: a slow low-frequency warp, plus a squeeze that throbs at the same few hertz
 *     the ring in your ears wobbles at. The frame breathes. It is the layer you feel rather than
 *     see, and it is what makes the picture read as a *head* rather than as a camera.
 *   - **tearing**: sparse horizontal bands slip sideways for a few frames at a time. This is the
 *     "сыпется" part; on a point cloud it reads as the picture coming apart in strips. This is the
 *     layer the human kept — «мне нравится эффект лагов» — and the only one that got *stronger*.
 *   - **the dark closing in**: grain that punches holes in the dimmer points, and a vignette that
 *     eats the periphery. Tunnel vision, and the only channel it can act on is subtraction. Both
 *     are now a hint rather than a wall; see the note on the defaults.
 *   - **double vision** (`ghost`, off by default): the frame sampled twice, at two strengths of the
 *     same warp, mixed with weights that sum to one. Kept as code and as a slider, but zeroed —
 *     it is the layer the verdict below threw out.
 *
 * ## What the first version got wrong
 *
 * «контузия слишком жесткая, ничего не видно совсем. мне нравится эффект лагов, но второй это
 * слишком.» The *second image* — double vision — was doing the blinding. On a point cloud with no
 * fill, splitting every line into two half-brightness copies does not read as "my eyes are off",
 * it reads as "the lidar failed": each line loses half its contrast against a black background
 * where contrast is the *only* thing carrying the geometry. The vignette and the grain finished
 * the job, one crushing the periphery and the other eating the dimmer points that were already at
 * the edge of visible. So `ghost` is zero, the vignette and the grain drop to roughly a quarter and
 * a third of what they were, and the swim is halved; the tearing — the part he liked — goes up.
 * The rule this settled on: **a concussed player must still be able to play**. Anything that
 * removes geometry rather than disturbing it is the wrong kind of cost.
 *
 * ## Determinism and cost
 *
 * Everything is driven by *scene* time — the same clock the keyframe generator steps by hand —
 * so `tools/concussion.mjs` renders the same frames every run. `Math.random()` appears nowhere;
 * the grain and the tearing come from a hash of position and of a quantised time slot.
 *
 * While nothing is ringing the class is a straight pass-through: `render()` calls
 * `renderer.render(scene, camera)` exactly as `main.ts` used to and allocates nothing. The render
 * target is created on the first shot and resized only when the drawing buffer changes, so the
 * cost is one full-screen resample per frame *while concussed* and zero otherwise.
 */
import * as THREE from 'three';

export interface ConcussionTunables {
  /** Master switch. Off is a plain pass-through. */
  enabled: boolean;
  /** How long one round keeps the frame unwell, seconds. Matched to the ring in the ears. */
  seconds: number;
  /** Overall depth, 0..1. Everything below scales by this. */
  strength: number;
  /** Amplitude of the swim and the throb, in fractions of the frame. */
  wobble: number;
  /** How far a torn band slides sideways, in fractions of the frame. */
  tear: number;
  /** Share of rows that tear at any moment, 0..1. */
  tearRows: number;
  /** How much of the picture the grain eats, 0..1. */
  grain: number;
  /** How hard the dark closes in from the edges, 0..1. */
  vignette: number;
  /** The throb, Hz. Slow enough to be a body and not a strobe. */
  pulse: number;
  /** Weight of the second, more warped copy of the frame, 0..0.5. Double vision. */
  ghost: number;
}

/**
 * Tuned against the verdict quoted in the header: the hall has to stay readable *through* the
 * effect. Everything subtractive is a hint; the tearing carries the feeling.
 */
export function defaultConcussionTunables(): ConcussionTunables {
  return {
    enabled: true,
    seconds: 5.5,
    strength: 1,
    wobble: 0.012,
    tear: 0.05,
    tearRows: 0.22,
    grain: 0.16,
    vignette: 0.12,
    pulse: 2.6,
    // Off by default. This was the layer the human threw out — see the note above the defaults.
    ghost: 0,
  };
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform float uAmt;
uniform float uTime;
uniform float uAspect;
uniform float uWobble;
uniform float uTear;
uniform float uTearRows;
uniform float uGrain;
uniform float uVignette;
uniform float uPulse;
uniform float uGhost;

// Deterministic hash: the grain and the tearing must be identical for the same scene time on
// every machine, or the keyframe generator is measuring the driver instead of the game.
float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 42.13);
  return fract(p.x * p.y * 95.437);
}

/** The swim: a throb about the centre plus a slow drift. k scales the whole thing. */
vec2 warp(vec2 uv, float k) {
  vec2 c = uv - 0.5;
  c.x *= uAspect;
  float r = length(c);
  float w = uTime * 6.2831853 * uPulse;
  float pulse = sin(w) * 0.6 + sin(w * 0.37 + 1.3) * 0.4;
  // Stronger at the edges than in the middle: the periphery is what goes first.
  c *= 1.0 + k * uWobble * pulse * (0.5 + 2.2 * r * r);
  c += k * uWobble * vec2(sin(uTime * 2.3 + 1.7), cos(uTime * 1.73)) * 0.6;
  c.x /= uAspect;
  return c + 0.5;
}

void main() {
  float k = uAmt;
  vec2 uv = vUv;

  // Tearing: bands of rows slip sideways, re-diced twenty times a second. Sparse on purpose —
  // a frame that tears everywhere is a broken video codec, not a head injury.
  float band = floor(uv.y * 96.0);
  float slot = floor(uTime * 19.0);
  float pick = hash21(vec2(band, slot));
  float torn = step(1.0 - uTearRows * k, pick);
  uv.x += torn * (hash21(vec2(slot, band)) - 0.5) * uTear * k;

  vec2 a = clamp(warp(uv, k), 0.0, 1.0);
  vec2 b = clamp(warp(uv, k * 2.1), 0.0, 1.0);
  float gw = uGhost * k;
  // Weights sum to exactly one: double vision moves light about, it never makes more of it.
  vec3 col = texture2D(tMap, a).rgb * (1.0 - gw) + texture2D(tMap, b).rgb * gw;

  // Grain: holes punched in the picture. Multiplicative and ≤ 1, so it can only take away.
  float g = hash21(uv * vec2(1249.0, 733.0) + slot * 7.31);
  col *= 1.0 - uGrain * k * g;

  // And the dark closing in.
  vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
  float rn = length(c) / 0.62;
  col *= 1.0 - uVignette * k * smoothstep(0.35, 1.25, rn);

  gl_FragColor = vec4(col, 1.0);
}
`;

export class Concussion {
  readonly tunables: ConcussionTunables;
  /** 0..~1.4. One round adds 1; the frame shows `min(1, level)`. */
  private level = 0;
  /** Scene time the level was last advanced to. */
  private clock = 0;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();
  /** Frames rendered through the effect since boot — the overlay's proof that it ran. */
  private frames = 0;

  constructor(tunables: ConcussionTunables) {
    this.tunables = tunables;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tMap: { value: null },
        uAmt: { value: 0 },
        uTime: { value: 0 },
        uAspect: { value: 1 },
        uWobble: { value: tunables.wobble },
        uTear: { value: tunables.tear },
        uTearRows: { value: tunables.tearRows },
        uGrain: { value: tunables.grain },
        uVignette: { value: tunables.vignette },
        uPulse: { value: tunables.pulse },
        uGhost: { value: tunables.ghost },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /**
   * A round went off. Called from the bus, so *any* gunshot does it — there is no second path and
   * no scripted trigger, exactly like every other consumer of the bus.
   *
   * Rounds stack rather than restart: a burst leaves you worse off than a single shot, capped so
   * that emptying a magazine cannot make the screen more than fully unwell.
   */
  hit(time: number): void {
    this.advance(time);
    this.level = Math.min(1.45, this.level + 1);
  }

  /** The current depth, 0..1 — what the shader is fed and what the debug overlay prints. */
  amount(time: number): number {
    this.advance(time);
    if (!this.tunables.enabled) return 0;
    // ^0.75 so the tail lingers as something visible rather than fading out in the first second:
    // the complaint about the audio version was that it did not last, and this must not repeat it.
    return Math.min(1, this.level) ** 0.75 * Math.max(0, Math.min(1, this.tunables.strength));
  }

  get charge(): number {
    return this.level;
  }

  get rendered(): number {
    return this.frames;
  }

  /**
   * Draws the scene, through the effect when there is anything to show and straight to the canvas
   * when there is not. `main.ts` calls this instead of `renderer.render(scene, camera)`; that one
   * line is the entire integration.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    time: number,
  ): void {
    const amt = this.amount(time);
    if (amt <= 0.004) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x));
    const h = Math.max(1, Math.floor(this.size.y));
    if (this.target === null) {
      this.target = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: true,
        stencilBuffer: false,
        // No filtering games and no mipmaps: this is a one-to-one resample of the frame, and a
        // blurred copy of a point cloud is a smear of grey where there used to be geometry.
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    } else if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }

    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    const u = this.material.uniforms;
    const t = this.tunables;
    u.tMap!.value = this.target.texture;
    u.uAmt!.value = amt;
    u.uTime!.value = time;
    u.uAspect!.value = w / h;
    u.uWobble!.value = t.wobble;
    u.uTear!.value = t.tear;
    u.uTearRows!.value = t.tearRows;
    u.uGrain!.value = t.grain;
    u.uVignette!.value = t.vignette;
    u.uPulse!.value = t.pulse;
    u.uGhost!.value = t.ghost;
    renderer.render(this.quadScene, this.quadCamera);
    this.frames++;
  }

  /** Debug/keyframes: put the effect at a chosen depth and hold it there. */
  setLevel(level: number, time: number): void {
    this.clock = time;
    this.level = Math.max(0, level);
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.material.dispose();
  }

  /**
   * Decay, driven by scene time. `seconds` is the time to fall to a twentieth of full, so the
   * slider means what it says: a five-second concussion is visible for about five seconds.
   */
  private advance(time: number): void {
    const dt = time - this.clock;
    this.clock = time;
    if (dt <= 0 || this.level <= 0) return;
    const tau = Math.max(0.05, this.tunables.seconds) / 3;
    this.level *= Math.exp(-dt / tau);
    if (this.level < 0.002) this.level = 0;
  }
}
