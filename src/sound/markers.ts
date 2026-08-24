/**
 * The sound layer — concept, "Звуковой слой — это НЕ свет".
 *
 * This is the law that gets misread most often, so it is worth restating at the top of the file
 * that implements it: a marker is drawn **at the point where the event happened, and nowhere
 * else.** It lights nothing. It casts nothing. It does not enter any lighting calculation,
 * because there is no lighting calculation. A can that clatters two metres from a wall leaves a
 * marker floating in the dark two metres from a wall, and the wall stays black unless the lidar
 * or your hand has been there. If you can tell what a room looks like from its sounds, this file
 * is broken.
 *
 * By the fiction, the player wears a tactical HUD that hears, localises and *annotates*. That is
 * why the visual language is a software marker and not a wave or a puff: a hard little bracket
 * of stipples, dead-sterile, that twitches once or twice as the HUD re-solves the position, and
 * then bleeds away. It is the machine telling you a fact, not the world glowing.
 *
 * Markers outlive their sounds and fade slowly, so what you are really looking at is a decaying
 * heat-map of the last few seconds of the room. Your own footsteps are in it. They are drawn
 * under your own feet, they tell you nothing you did not know, and that is the joke the concept
 * is making — the cost is real and the information is zero.
 *
 * Implementation: one persistent GPU point buffer used as a ring. Nothing is rebuilt when a
 * marker ages; the shader derives everything from `now - birth`. Emitting an event writes a
 * handful of floats into a slot and uploads that slot's range, so a collapsing stack costs a few
 * kilobytes of `bufferSubData` and no allocation at all.
 */
import * as THREE from 'three';

import type { SoundEvent, SoundSource } from '../events/bus';

/** Stipples per marker. The bracket is a fixed screen-space figure, so this is a constant. */
const PER_MARKER = 16;

/**
 * The figure itself, in units of the marker's screen radius: four corner brackets and a centre
 * pip. Deliberately not a circle — a circle reads as a radius, i.e. as a claim about how far the
 * sound carries, which is a debug question and gets its own overlay below.
 */
const FIGURE: Array<[number, number]> = (() => {
  const pts: Array<[number, number]> = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    pts.push([sx * 1.0, sy * 1.0]);
    pts.push([sx * 0.45, sy * 1.0]);
    pts.push([sx * 1.0, sy * 0.45]);
  }
  pts.push([0, 0]);
  pts.push([0, -0.28]);
  pts.push([0, 0.28]);
  pts.push([-0.28, 0]);
  return pts;
})();

/** Per-source colour and weight. Yours are dim; other people's things are what you care about. */
const SOURCE_LOOK: Record<SoundSource, { color: number; gain: number }> = {
  'player-step': { color: 0x5d6b74, gain: 0.55 },
  'player-land': { color: 0x6d7a82, gain: 0.7 },
  'prop-impact': { color: 0xd8f2ff, gain: 1 },
  gunshot: { color: 0xffd9a8, gain: 1 },
  'bullet-hit': { color: 0xffe6c0, gain: 1 },
  spider: { color: 0xffb0c4, gain: 1 },
};

export interface MarkerTunables {
  /** How long a marker survives, seconds. Far longer than the sound — that is the point. */
  life: number;
  /** Screen radius of a marker at one metre, pixels — before the loudness term. */
  pixelsAtOneMetre: number;
  /** Smallest and largest on-screen radius, pixels. */
  minRadius: number;
  maxRadius: number;
  /** Stipple size, pixels. */
  dotPixels: number;
  brightness: number;
  /** Seconds the HUD spends "re-solving" — the window in which the figure twitches. */
  glitchSeconds: number;
}

export function defaultMarkerTunables(): MarkerTunables {
  return {
    life: 7,
    pixelsAtOneMetre: 26,
    minRadius: 5,
    maxRadius: 46,
    dotPixels: 2.4,
    brightness: 1,
    glitchSeconds: 0.35,
  };
}

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uLife;
  uniform float uPixelsAtOneMetre;
  uniform float uMinRadius;
  uniform float uMaxRadius;
  uniform float uDotPixels;
  uniform float uBright;
  uniform float uGlitch;
  uniform vec2  uViewport;

  attribute vec2  aFigure;
  attribute float aBirth;
  attribute float aLoud;
  attribute float aSeed;
  attribute vec3  aTint;

  varying vec3  vColor;
  varying float vAlpha;

  float hash(float n) { return fract(sin(n) * 43758.5453123); }

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
     * Screen-space, on purpose. The marker is a HUD annotation, not an object in the room: it
     * has to stay legible at forty metres, and a world-space bracket would be one pixel wide.
     * Loudness sets the size, so a barrel going over reads as louder than a can from across
     * the hall even when both are far away — the *radius* is the HUD's confidence display, not
     * a distance.
     */
    float radius = clamp(uPixelsAtOneMetre * (0.35 + aLoud * 0.09), uMinRadius, uMaxRadius);

    // The HUD re-solving: for the first fraction of a second the figure snaps between two or
    // three offsets, then settles. One hash per marker, so all sixteen stipples agree.
    float g = 1.0 - clamp(age / max(0.01, uGlitch), 0.0, 1.0);
    float step0 = floor(age * 24.0);
    vec2 jitter = vec2(hash(aSeed + step0) - 0.5, hash(aSeed + step0 + 7.3) - 0.5) * g * radius * 0.5;
    // A late second-guess: one brief re-solve halfway through the life, so a settled marker is
    // not perfectly dead. Cheap, and it is what sells "software" over "glow".
    float late = step(0.5, hash(aSeed + 3.1)) * (1.0 - smoothstep(0.0, 0.12, abs(age - uLife * 0.35)));
    jitter += vec2(hash(aSeed + 11.0) - 0.5, hash(aSeed + 13.0) - 0.5) * late * radius * 0.35;

    vec2 offset = (aFigure * radius + jitter) / uViewport * 2.0 * clip.w;
    clip.xy += offset;

    // Fade: fast off the peak, then a long shallow tail. A hitmap of the last few seconds, not
    // a set of lamps that switch off.
    float t = age / uLife;
    float fade = (1.0 - t) * (1.0 - t) * (0.35 + 0.65 * (1.0 - smoothstep(0.0, 0.15, t)));

    vColor = aTint * uBright * fade * (0.75 + 0.5 * hash(aSeed + aFigure.x * 3.7));
    vAlpha = 1.0;
    gl_PointSize = uDotPixels;
    gl_Position = clip;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3  vColor;
  varying float vAlpha;
  void main() {
    // Square stipples. A round dot reads as organic; this thing is software.
    gl_FragColor = vec4(vColor, vAlpha);
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
  /** Markers currently inside their lifetime. */
  alive: number;
  /** Markers written since the start. */
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
    const figure = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const f = FIGURE[i % PER_MARKER]!;
      figure[i * 2] = f[0];
      figure[i * 2 + 1] = f[1];
    }

    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aFigure', new THREE.BufferAttribute(figure, 2));
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
        uDotPixels: { value: tunables.dotPixels },
        uBright: { value: tunables.brightness },
        uGlitch: { value: tunables.glitchSeconds },
        uViewport: { value: new THREE.Vector2(1280, 720) },
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

  setViewport(w: number, h: number): void {
    (this.material.uniforms.uViewport!.value as THREE.Vector2).set(w, h);
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
    u.uDotPixels!.value = t.dotPixels;
    u.uBright!.value = t.brightness;
    u.uGlitch!.value = t.glitchSeconds;
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
    const s = (this.written * 0.6180339887) % 1;

    const base = slot * PER_MARKER;
    for (let k = 0; k < PER_MARKER; k++) {
      const i = base + k;
      this.pos[i * 3] = event.x;
      this.pos[i * 3 + 1] = event.y;
      this.pos[i * 3 + 2] = event.z;
      this.birth[i] = event.time;
      this.loud[i] = event.loudness;
      this.seed[i] = s * 100 + k * 0.37;
      this.tint[i * 3] = r;
      this.tint[i * 3 + 1] = g;
      this.tint[i * 3 + 2] = b;
    }
    upload(this.geometry, 'position', base * 3, PER_MARKER * 3);
    upload(this.geometry, 'aBirth', base, PER_MARKER);
    upload(this.geometry, 'aLoud', base, PER_MARKER);
    upload(this.geometry, 'aSeed', base, PER_MARKER);
    upload(this.geometry, 'aTint', base * 3, PER_MARKER * 3);

    if (this.radiusOn) {
      const rb = slot * RING_POINTS;
      for (let k = 0; k < RING_POINTS; k++) {
        const i = rb + k;
        this.ringPos[i * 3] = event.x;
        this.ringPos[i * 3 + 1] = event.y + 0.03;
        this.ringPos[i * 3 + 2] = event.z;
        this.ringBirth[i] = event.time;
        this.ringLoud[i] = event.loudness;
        this.ringTint[i * 3] = r;
        this.ringTint[i * 3 + 1] = g;
        this.ringTint[i * 3 + 2] = b;
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
