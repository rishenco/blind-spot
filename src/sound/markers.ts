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
 * other channel". Your own noise is dull ember; other people's things burn.
 */
const SOURCE_LOOK: Record<SoundSource, { color: number; gain: number }> = {
  'player-step': { color: 0xff7a3c, gain: 0.4 },
  'player-land': { color: 0xff8a44, gain: 0.55 },
  'prop-impact': { color: 0xffc46a, gain: 1 },
  gunshot: { color: 0xfff0c0, gain: 1.15 },
  'bullet-hit': { color: 0xffd890, gain: 1 },
  spider: { color: 0xff9ec0, gain: 1 },
};

export interface MarkerTunables {
  /** How long a mark survives, seconds. Far longer than the sound — that is the point. */
  life: number;
  /** Blob radius at one metre, pixels — before the loudness term and the distance falloff. */
  pixelsAtOneMetre: number;
  /** Smallest and largest on-screen radius, pixels. */
  minRadius: number;
  maxRadius: number;
  /** Falloff exponent of the blob. Low = wide woolly haze, high = tight core. */
  softness: number;
  brightness: number;
}

export function defaultMarkerTunables(): MarkerTunables {
  return {
    life: 7,
    pixelsAtOneMetre: 120,
    minRadius: 13,
    maxRadius: 96,
    softness: 1.5,
    brightness: 1,
  };
}

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uLife;
  uniform float uPixelsAtOneMetre;
  uniform float uMinRadius;
  uniform float uMaxRadius;

  attribute float aBirth;
  attribute float aLoud;
  attribute float aSeed;
  attribute vec3  aTint;

  varying vec3  vColor;
  varying float vFade;
  varying float vSeed;

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
     * Size is loudness, softened by distance. Not pure screen space: a barrel going over at the
     * far wall would then paint the same crater as one going over at your feet, and the frame
     * turns into a flare. Not honest perspective either: a far-off sound would shrink to a pixel
     * and start passing for geometry, which is the one thing this layer must never do. So the
     * blob falls off slower than perspective (d^0.65) and never gets smaller than uMinRadius
     * — far noises stay small, soft smudges you can still tell from a dot.
     */
    float dist = max(1.0, -mv.z);
    float radius = clamp(uPixelsAtOneMetre * (0.42 + aLoud * 0.12) / pow(dist, 0.65),
                         uMinRadius, uMaxRadius);
    // A blob swells for a moment as the sound registers, then settles back. Cheap, and it is the
    // difference between "heat bloomed here" and "a circle switched on".
    float t = age / uLife;
    radius *= 0.72 + 0.38 * (1.0 - exp(-age * 9.0)) - 0.10 * t;

    // Fade: bright while the noise is news, then a long shallow tail. Written in *seconds*, not
    // in fractions of the lifetime, because what the eye reads is "that happened a moment ago" —
    // an earlier version dropped to 40% inside a second and the mark of a barrel going over was
    // already a smudge by the time you turned to look at it.
    vFade = pow(1.0 - t, 1.5) * (0.55 + 0.45 * exp(-age * 1.2));
    // Spread, not gain: a blob that covers four times the screen is not four times the event, so
    // the closer and wider it gets the thinner it is painted. Without this a can dropped at your
    // feet burns a white disc in the middle of the frame and starts looking like a light.
    vFade *= clamp(38.0 / radius, 0.4, 1.0);
    vColor = aTint;
    vSeed = aSeed;
    gl_PointSize = radius * 2.0;
    gl_Position = clip;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uSoftness;
  uniform float uBright;
  varying vec3  vColor;
  varying float vFade;
  varying float vSeed;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float ang = atan(d.y, d.x);
    /*
     * A silhouette, not a disc. The radius is warped by two low-frequency lobes seeded per mark,
     * so every blob has its own lopsided shape — a smear of heat rather than a UI circle. The
     * warp is small: it must never read as a shape claim about the object that made the noise.
     */
    float warp = 1.0 + 0.18 * sin(ang * 2.0 + vSeed) + 0.11 * sin(ang * 3.0 - vSeed * 2.3);
    float r = length(d) * 2.0 / warp;
    if (r > 1.0) discard;

    // Thermal falloff: hot core, wide soft shoulder, nothing at the rim. Almost the whole sprite
    // is nearly transparent — that is what makes it read as heat and not as a dot.
    float body = pow(max(0.0, 1.0 - r), uSoftness);
    float core = pow(max(0.0, 1.0 - r), uSoftness * 2.8);
    float a = (body * 0.85 + core * 0.55) * vFade * uBright;
    if (a <= 0.002) discard;

    // Colour ramp along the falloff, like a thermal palette: the middle whitens out, the shoulder
    // keeps the source's hue, the rim bleeds into deep red before it vanishes.
    vec3 rim = vColor * vec3(0.75, 0.18, 0.06);
    vec3 c = mix(rim, vColor, smoothstep(0.0, 0.55, body));
    c = mix(c, vec3(1.0, 0.94, 0.86), core * 0.5);
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
    this.tint = new Float32Array(n * 3);

    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    g.setAttribute('aLoud', new THREE.BufferAttribute(this.loud, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    g.setAttribute('aTint', new THREE.BufferAttribute(this.tint, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: tunables.life },
        uPixelsAtOneMetre: { value: tunables.pixelsAtOneMetre },
        uMinRadius: { value: tunables.minRadius },
        uMaxRadius: { value: tunables.maxRadius },
        uSoftness: { value: tunables.softness },
        uBright: { value: tunables.brightness },
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
    u.uPixelsAtOneMetre!.value = t.pixelsAtOneMetre;
    u.uMinRadius!.value = t.minRadius;
    u.uMaxRadius!.value = t.maxRadius;
    u.uSoftness!.value = t.softness;
    u.uBright!.value = t.brightness;
    this.ringMaterial.uniforms.uLife!.value = t.life;
  }

  /** The bus subscriber. One event, one slot in the ring. No allocation. */
  handle(event: SoundEvent): void {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.written++;

    const look = SOURCE_LOOK[event.source] ?? SOURCE_LOOK['prop-impact'];
    const c = new THREE.Color(look.color);
    const r = c.r * look.gain;
    const g = c.g * look.gain;
    const b = c.b * look.gain;
    const s = ((this.written * 0.6180339887) % 1) * 6.283;

    const i = slot * PER_MARKER;
    this.pos[i * 3] = event.x;
    this.pos[i * 3 + 1] = event.y;
    this.pos[i * 3 + 2] = event.z;
    this.birth[i] = event.time;
    this.loud[i] = event.loudness;
    this.seed[i] = s;
    this.tint[i * 3] = r;
    this.tint[i * 3 + 1] = g;
    this.tint[i * 3 + 2] = b;

    upload(this.geometry, 'position', i * 3, PER_MARKER * 3);
    upload(this.geometry, 'aBirth', i, PER_MARKER);
    upload(this.geometry, 'aLoud', i, PER_MARKER);
    upload(this.geometry, 'aSeed', i, PER_MARKER);
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
function upload(g: THREE.BufferGeometry, name: string, offset: number, count: number): void {
  const attr = g.getAttribute(name) as THREE.BufferAttribute;
  attr.clearUpdateRanges();
  attr.addUpdateRange(offset, count);
  attr.needsUpdate = true;
}
