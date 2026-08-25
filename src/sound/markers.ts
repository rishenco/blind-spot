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
 * Implementation: one persistent GPU point buffer used as a ring, one point per event, expanded
 * to a soft sprite in the fragment shader. Nothing is rebuilt when a mark ages; the shader
 * derives everything from `now - birth`. Emitting an event writes a handful of floats into a slot
 * and uploads that slot's range, so a collapsing stack costs a few hundred bytes of
 * `bufferSubData` and no allocation at all.
 */
import * as THREE from 'three';

import type { SoundEvent, SoundSource } from '../events/bus';

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
const SOURCE_LOOK: Record<SoundSource, { color: number; gain: number }> = {
  'player-step': { color: 0xff8438, gain: 1 },
  'player-land': { color: 0xff7a28, gain: 1.1 },
  'prop-impact': { color: 0xffc46a, gain: 1 },
  gunshot: { color: 0xfff0c0, gain: 1.15 },
  'bullet-hit': { color: 0xffd890, gain: 1 },
  spider: { color: 0xff9ec0, gain: 1 },
};

/**
 * The four looks. The human's verdict on the first one was "conveys the information, but it is
 * not great — maybe the epicentre is too small and the halo around it too big", and he was not
 * sure of his own diagnosis. So this is deliberately four *different* answers rather than one
 * polished one, switchable at runtime (GUI → sound marks → style, or `bs.markerStyle(name)`),
 * and the frame set shoots the same moment through each of them.
 *
 *  - `ember`  the original language, recalibrated: white-hot pinpoint core, amber body, a rim
 *             that bleeds into deep red. Hue says *who* made the noise.
 *  - `iso`    an isotherm palette, like a real thermal camera: colour is temperature, so it is
 *             loudness that walks the blob up violet → red → orange → yellow → white, with faint
 *             iso-bands in the falloff. A quiet noise physically cannot go yellow.
 *  - `coal`   the answer to the human's own hypothesis: a big flat hot centre and a short
 *             shoulder, so the blob is mostly epicentre and barely any aura.
 *  - `bloom`  the opposite extreme: no core at all, one soft monochrome haze. Kept as the
 *             control — it is what "too much aura" actually looks like.
 */
export type MarkerStyle = 'ember' | 'iso' | 'coal' | 'bloom';

export const MARKER_STYLES: readonly MarkerStyle[] = ['ember', 'iso', 'coal', 'bloom'];

const STYLE_INDEX: Record<MarkerStyle, number> = { ember: 0, iso: 1, coal: 2, bloom: 3 };

export interface MarkerTunables {
  /** How long a mark survives, seconds. Far longer than the sound — that is the point. */
  life: number;
  /**
   * Pixel radius of a reference-loud mark seen at one metre, before the distance falloff. This
   * is the master knob of the whole scale.
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
  /** Smallest and largest on-screen radius, pixels. */
  minRadius: number;
  maxRadius: number;
  /**
   * Radius, in pixels, above which a blob starts paying for the screen it covers. It exists so a
   * can dropped at your boot does not become a white sun — but it used to be set at 38 px, which
   * meant *everything* interesting was being dimmed and the whole loudness scale collapsed into
   * the quiet end. It is now far out of the way of ordinary marks.
   */
  spread: number;
  /** Falloff exponent of the blob. Low = wide woolly haze, high = tight core. */
  softness: number;
  brightness: number;
  style: MarkerStyle;
}

export function defaultMarkerTunables(): MarkerTunables {
  return {
    life: 7,
    scale: 210,
    loudRef: 9,
    loudPower: 1.25,
    minRadius: 7,
    maxRadius: 460,
    spread: 150,
    softness: 1.5,
    brightness: 1,
    style: 'iso',
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

  attribute float aBirth;
  attribute float aLoud;
  attribute float aSeed;
  attribute float aGain;
  attribute vec3  aTint;

  varying vec3  vColor;
  varying float vFade;
  varying float vSeed;
  varying float vHeat;

  void main() {
    float age = uTime - aBirth;
    if (aBirth <= -1.0e8 || age < 0.0 || age > uLife) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec4 clip = projectionMatrix * mv;
    if (clip.w <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    /*
     * Size is loudness. The scale has to be *wide*: a spider's foot and a barrel going over are
     * a factor of ten apart in metres of notice, and on screen they have to be a factor of ten
     * apart too — small smudge versus a crater you cannot miss. The previous curve was
     * 0.42 + loud * 0.12, a range of four and a half, and then it clamped at 96 px, so in
     * practice everything from a can to a barrel came out the same size. That is the bug this
     * whole pass exists to fix.
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
     * китайский новый год должен начаться". The old code dimmed strictly by area, which made
     * every big mark pale and put the whole scale back in the quiet end.
     */
    float loudGain = clamp(pow(norm, 0.7), 0.26, 1.6) * aGain;
    // Some anti-glare is still wanted: a mark that covers a third of the screen would otherwise
    // wash the frame out. It bites only well past the size of an ordinary mark, and it is capped
    // so even a crater keeps half its punch.
    vFade = decay * loudGain * clamp(uSpread / radius, 0.5, 1.0);
    vColor = aTint;
    vSeed = aSeed;
    // How far up the thermal ramp this event is entitled to climb. Quiet noises stay red.
    vHeat = clamp(pow(norm, 0.55) * 0.62, 0.16, 1.0);
    gl_PointSize = radius * 2.0;
    gl_Position = clip;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uSoftness;
  uniform float uBright;
  uniform float uStyle;
  varying vec3  vColor;
  varying float vFade;
  varying float vSeed;
  varying float vHeat;

  /** The isotherm ramp: violet embers, red, orange, yellow, white. Temperature is loudness. */
  vec3 isoRamp(float v) {
    vec3 c = mix(vec3(0.16, 0.03, 0.30), vec3(0.72, 0.06, 0.14), smoothstep(0.00, 0.30, v));
    c = mix(c, vec3(1.00, 0.32, 0.04), smoothstep(0.26, 0.56, v));
    c = mix(c, vec3(1.00, 0.80, 0.16), smoothstep(0.54, 0.82, v));
    c = mix(c, vec3(1.00, 0.99, 0.92), smoothstep(0.80, 1.00, v));
    return c;
  }

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float ang = atan(d.y, d.x);
    /*
     * A silhouette, not a disc. The radius is warped by two low-frequency lobes seeded per mark,
     * so every blob has its own lopsided shape — a smear of heat rather than a UI circle. The
     * warp is small: it must never read as a shape claim about the object that made the noise.
     */
    float warp = 1.0 + 0.18 * sin(ang * 2.0 + vSeed) + 0.11 * sin(ang * 3.0 - vSeed * 2.3);
    /*
     * The warp stretches the silhouette outwards, which can push the shape past the edge of the
     * point sprite's own quad — and a quad has corners, so a fat style (coal) came out with
     * visible axis-aligned bites taken out of it. The second factor fades whatever survives to
     * nothing over the outermost fifth of the quad, so the cut always happens where the blob is
     * already black.
     */
    float rr = length(d) * 2.0;
    float r = rr / warp;
    if (r > 1.0) discard;
    float k = (1.0 - r) * smoothstep(1.0, 0.82, rr);

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
      // iso — a thermal camera's isotherm palette. Colour *is* loudness: the falloff is read as
      // temperature and clipped at what this event is hot enough to reach, so a quiet noise
      // physically cannot produce yellow and a barrel cannot help producing white.
      float v = pow(k, uSoftness * 0.85) * vHeat;
      a = pow(k, uSoftness * 1.15) * (0.86 + 0.14 * sin(v * 26.0));
      c = isoRamp(v) * (0.45 + 0.55 * vHeat);
    } else if (uStyle < 2.5) {
      // coal — the human's own hypothesis taken seriously: nearly all epicentre and almost no
      // aura. A hot slug with a soft rim over its outer quarter, so it stays a silhouette and
      // never a UI disc, but what you read is the *area* of the thing rather than a halo.
      float slug = smoothstep(0.0, 0.30, k);
      float ember = pow(k, uSoftness * 2.2);
      a = slug * 0.62 + ember * 0.22;
      vec3 cold = vec3(0.55, 0.05, 0.01);
      vec3 hot = vec3(1.0, 0.58, 0.10);
      vec3 base = mix(cold, hot, vHeat);
      c = mix(base * 0.7, base, slug) + vec3(0.9, 0.75, 0.5) * ember * vHeat * 0.5;
    } else {
      // bloom — the far pole: no epicentre at all, one soft monochrome cloud. Included because
      // the complaint might be the other way round from the hypothesis, and this is what "all
      // aura" honestly looks like when nothing is competing with it.
      // The plateau is the whole point: alpha climbs fast and then flattens, so there is no
      // pinpoint anywhere and the colour does not vary across the blob at all. Only the alpha
      // carries shape, which is as close to "all aura, no epicentre" as this layer can get.
      float haze = 1.0 - pow(1.0 - k, 2.4);
      a = haze * 0.80;
      vec3 pale = mix(vColor, vec3(1.0, 0.88, 0.74), 0.35);
      c = pale * (0.5 + 0.5 * vHeat);
    }

    a *= vFade * uBright;
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
    // The audibility radius is the loudness, in metres — one scale for the whole game, and in
    // M4 this exact circle is the test a spider runs.
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
  capacity: number;
}

export class SoundMarkers {
  readonly tunables: MarkerTunables;
  readonly object = new THREE.Group();

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly ringGeometry = new THREE.BufferGeometry();
  private readonly ringMaterial: THREE.ShaderMaterial;
  private readonly ringPoints: THREE.Points;

  private readonly pos: Float32Array;
  private readonly birth: Float32Array;
  private readonly loud: Float32Array;
  private readonly seed: Float32Array;
  private readonly gain: Float32Array;
  private readonly tint: Float32Array;

  private readonly ringPos: Float32Array;
  private readonly ringBirth: Float32Array;
  private readonly ringLoud: Float32Array;
  private readonly ringTint: Float32Array;

  private cursor = 0;
  private written = 0;
  private time = 0;
  private radiusOn = false;

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
    this.tint = new Float32Array(n * 3);

    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    g.setAttribute('aLoud', new THREE.BufferAttribute(this.loud, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    g.setAttribute('aGain', new THREE.BufferAttribute(this.gain, 1));
    g.setAttribute('aTint', new THREE.BufferAttribute(this.tint, 3));
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
        uSoftness: { value: tunables.softness },
        uBright: { value: tunables.brightness },
        uStyle: { value: STYLE_INDEX[tunables.style] },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(this.geometry, this.material);
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.object.add(points);

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

  setViewport(_w: number, _h: number): void {
    // The blob is sized in pixels straight out of `gl_PointSize`, so the viewport no longer enters
    // the shader. Kept so the caller does not have to know that.
  }

  setProjScale(v: number): void {
    this.ringMaterial.uniforms.uProjScale!.value = v;
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
    u.uStyle!.value = STYLE_INDEX[t.style] ?? 0;
    this.ringMaterial.uniforms.uLife!.value = t.life;
  }

  /** The bus subscriber. One event, one slot in the ring. No allocation. */
  handle(event: SoundEvent): void {
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
    this.tint[i * 3] = r;
    this.tint[i * 3 + 1] = g;
    this.tint[i * 3 + 2] = b;

    upload(this.geometry, 'position', i * 3, PER_MARKER * 3);
    upload(this.geometry, 'aBirth', i, PER_MARKER);
    upload(this.geometry, 'aLoud', i, PER_MARKER);
    upload(this.geometry, 'aSeed', i, PER_MARKER);
    upload(this.geometry, 'aGain', i, PER_MARKER);
    upload(this.geometry, 'aTint', i * 3, PER_MARKER * 3);

    if (this.radiusOn) {
      const rb = slot * RING_POINTS;
      for (let k = 0; k < RING_POINTS; k++) {
        const j = rb + k;
        this.ringPos[j * 3] = event.x;
        this.ringPos[j * 3 + 1] = event.y + 0.03;
        this.ringPos[j * 3 + 2] = event.z;
        this.ringBirth[j] = event.time;
        this.ringLoud[j] = event.loudness;
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

  getStats(): MarkerStats {
    let alive = 0;
    for (let s = 0; s < this.capacity; s++) {
      const b = this.birth[s * PER_MARKER]!;
      if (b > NEVER && this.time - b <= this.tunables.life) alive++;
    }
    return { alive, written: this.written, capacity: this.capacity };
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
