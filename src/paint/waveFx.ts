/**
 * The two things that make a wavefront visible in the *air* rather than only on surfaces.
 *
 * The reveal already shows a wave arriving — the ring displaces and burns the lattice at the
 * instant the front reaches it, so a ping sweeps outward across the geometry. What it cannot
 * show is the front crossing a space that has nothing in it, and it cannot show the moment of
 * firing at all. Those two gaps are what this file fills:
 *
 *  - `TracerStreaks` — the cause. A dim streak leaves the rig along the aim when the E-ping
 *    fires and burns down tip-first inside a quarter of a second. It is not a laser and must
 *    never read as one: the player is asking a question, not shooting.
 *
 *  - `WaveDust` — the front itself. Motes of suspended particulate drift in a volume that
 *    wraps around the listener; a passing wave lights them and they fade behind it. Ambient
 *    brightness is exactly zero, which is what keeps this on the right side of law 3: unlit
 *    air is not rendered, and a mote is only ever visible because a real event is physically
 *    passing through it. Idle, the whole field is `visible = false` and costs nothing.
 *
 * Both are driven by the same `LiveWave` list the paint system keeps, so nothing here can draw
 * a front that no real sound produced (law 2).
 */

import * as THREE from 'three';

/** A wavefront still expanding. The paint system owns the list; these effects only read it. */
export interface LiveWave {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  /** cos of the half apex angle; -1 for omnidirectional. */
  readonly cosHalf: number;
  /** Emission time on the paint clock. */
  readonly t0: number;
  readonly speed: number;
  readonly radius: number;
  readonly intensity: number;
}

/** How many fronts may be alive at once. Four is more than the fire rate can produce. */
export const MAX_LIVE_WAVES = 4;

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

/**
 * How many streaks one firing lays down, and how far off the aim axis they sit.
 *
 * Getting this to read at all took three tries, and the reason is worth writing down. A streak
 * drawn straight down the view axis projects to a dot at the reticle. Angling several of them
 * outward from the eye does not help either: a ray through the camera has a *constant* angular
 * offset, so it projects to a line running from off-screen up to a fixed point — eight of them
 * come out as a row of parallel bars, which reads as a rendering fault.
 *
 * What works is a bundle of streaks *parallel* to the aim, offset sideways from it and living
 * over a bounded stretch of depth. Perspective then turns each one into a short radial dash
 * pointing at the reticle, and the eight together into a starburst around it: unmistakably
 * something leaving the rig, gone before it can be mistaken for a sight.
 */
const TRACER_STREAKS = 8;
const TRACER_SEGMENTS = 12;
/** Sideways offset of a streak from the aim axis, metres. */
const TRACER_OFFSET = 0.34;

const TRACER_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uLife;
  uniform float uBright;

  attribute float aBirth;
  attribute float aS;

  varying float vAlpha;

  void main() {
    float t = (uTime - aBirth) / max(0.001, uLife);
    if (t < 0.0 || t >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vAlpha = 0.0;
      return;
    }
    // The streak burns down from the tip: everything past the head has already gone.
    float head = 1.0 - t;
    float keep = 1.0 - smoothstep(head - 0.3, head, aS);
    vAlpha = keep * (1.0 - t) * uBright;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRACER_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.002) discard;
    gl_FragColor = vec4(uColor * vAlpha, vAlpha);
  }
`;

/**
 * A small ring of fading streaks. Positions are written once per fire and never touched again:
 * the burn-down is entirely a function of `uTime - aBirth` in the shader, like everything else
 * in this system.
 */
export class TracerStreaks {
  readonly object: THREE.LineSegments;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly positions = new Float32Array(TRACER_STREAKS * TRACER_SEGMENTS * 2 * 3);
  private readonly births = new Float32Array(TRACER_STREAKS * TRACER_SEGMENTS * 2);
  private readonly params = new Float32Array(TRACER_STREAKS * TRACER_SEGMENTS * 2);
  private index = 0;
  private lastBirth = -1e9;
  private life = 0.25;

  constructor(color: THREE.Color) {
    this.births.fill(-1e9);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aBirth', new THREE.BufferAttribute(this.births, 1));
    this.geometry.setAttribute('aS', new THREE.BufferAttribute(this.params, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: this.life },
        uBright: { value: 0.5 },
        uColor: { value: color },
      },
      vertexShader: TRACER_VERTEX,
      fragmentShader: TRACER_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 3;
  }

  setTime(seconds: number): void {
    this.material.uniforms.uTime!.value = seconds;
  }

  setLook(life: number, brightness: number): void {
    this.life = life;
    this.material.uniforms.uLife!.value = life;
    this.material.uniforms.uBright!.value = brightness;
  }

  /** True while the most recent streak is still burning — the driver asserts on this. */
  alive(now: number): boolean {
    return now - this.lastBirth < this.life;
  }

  get lastFired(): number {
    return this.lastBirth;
  }

  /** Lays down the whole fan. One firing replaces the last: the cooldown outlives the streaks. */
  fire(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    start: number,
    length: number,
    now: number,
  ): void {
    this.index++;
    this.lastBirth = now;

    // Orthonormal basis around the aim, so the fan is rolled about the beam rather than about
    // some world axis — otherwise the burst collapses to a line whenever the player looks up.
    const ax = Math.abs(dy) < 0.9 ? 0 : 1;
    let bx = ax === 0 ? 0 : 1;
    let by = ax === 0 ? 1 : 0;
    let bz = 0;
    let ux = by * dz - bz * dy;
    let uy = bz * dx - bx * dz;
    let uz = bx * dy - by * dx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    bx = dy * uz - dz * uy;
    by = dz * ux - dx * uz;
    bz = dx * uy - dy * ux;

    for (let k = 0; k < TRACER_STREAKS; k++) {
      const roll = (k / TRACER_STREAKS) * Math.PI * 2 + this.index * 0.37;
      // Two radii, so the burst has some depth to it instead of being one flat ring of spokes.
      const radius = TRACER_OFFSET * (k % 2 === 0 ? 1 : 0.62);
      const ox = (ux * Math.cos(roll) + bx * Math.sin(roll)) * radius;
      const oy = (uy * Math.cos(roll) + by * Math.sin(roll)) * radius;
      const oz = (uz * Math.cos(roll) + bz * Math.sin(roll)) * radius;
      const reach = length * (k % 2 === 0 ? 1 : 0.72);
      const base = k * TRACER_SEGMENTS * 2;
      for (let s = 0; s < TRACER_SEGMENTS; s++) {
        const t0 = s / TRACER_SEGMENTS;
        const t1 = (s + 1) / TRACER_SEGMENTS;
        for (const [j, t] of [
          [0, t0],
          [1, t1],
        ] as const) {
          const v = base + s * 2 + j;
          // Bounded away from the eye at both ends: the near end sets how far out from the
          // reticle the dash starts, the far end how close to it the dash finishes.
          const d = start + t * reach;
          this.positions[v * 3] = x + ox + dx * d;
          this.positions[v * 3 + 1] = y + oy + dy * d;
          this.positions[v * 3 + 2] = z + oz + dz * d;
          this.births[v] = now;
          this.params[v] = t;
        }
      }
    }

    for (const name of ['position', 'aBirth', 'aS']) {
      (this.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  clear(): void {
    this.births.fill(-1e9);
    this.lastBirth = -1e9;
    (this.geometry.getAttribute('aBirth') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Dust
// ---------------------------------------------------------------------------

const DUST_VERTEX = /* glsl */ `
  uniform vec3  uCenter;
  uniform float uExtent;
  uniform float uTime;
  uniform float uProjScale;
  uniform float uGain;
  uniform float uSize;
  uniform float uShell;
  uniform vec4  uWA[${MAX_LIVE_WAVES}];   // origin.xyz, t0
  uniform vec4  uWB[${MAX_LIVE_WAVES}];   // dir.xyz, cosHalf
  uniform vec4  uWC[${MAX_LIVE_WAVES}];   // speed, radius, gain, spare

  attribute vec3 aDrift;
  attribute vec2 aRandom;

  varying float vBright;
  varying float vTint;

  void main() {
    // The field is a cube that follows the listener and wraps: motes never run out and the
    // buffer never has to be rewritten.
    vec3 drifted = position + aDrift * uTime;
    vec3 rel = mod(drifted - uCenter + uExtent * 0.5, uExtent) - uExtent * 0.5;
    vec3 p = uCenter + rel;

    // Law 3: absence is black. Unlit air contributes exactly nothing.
    float b = 0.0;
    for (int i = 0; i < ${MAX_LIVE_WAVES}; i++) {
      float gain = uWC[i].z;
      if (gain <= 0.0) continue;
      vec3 d = p - uWA[i].xyz;
      float dist = length(d);
      float radius = uWC[i].y;
      if (dist > radius || dist < 0.05) continue;
      float front = (uTime - uWA[i].w) * uWC[i].x;
      if (front < dist) continue;                       // the wave has not got here yet
      float ca = dot(d / dist, uWB[i].xyz);
      float cosHalf = uWB[i].w;
      if (ca < cosHalf) continue;
      float mask = smoothstep(cosHalf, mix(cosHalf, 1.0, 0.4), ca);
      // Behind the front in *metres*, not seconds: the shell has to be the same thickness at
      // 25 m/s and at 45 m/s, or the fast beam smears into a filled cone and stops reading as
      // something travelling.
      float behind = front - dist;
      b += exp(-behind / uShell) * mask * (1.0 - dist / radius) * (0.5 + 0.9 * aRandom.y) * gain;
    }

    // The field is a finite cube, and a cube's corners would cut a visible straight edge across
    // a round front. Fading the motes out well inside the wrap boundary keeps the effect
    // spherical, so what the air shows is always a piece of a real front and never a box.
    float reach = uExtent * 0.5;
    float fade = 1.0 - smoothstep(reach * 0.62, reach * 0.98, length(p - uCenter));

    vBright = b * uGain * fade;
    vTint = aRandom.x;
    if (vBright <= 0.0015) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * (0.4 + aRandom.y) * uProjScale / max(0.05, -mv.z), 0.6, 3.0);
  }
`;

const DUST_FRAGMENT = /* glsl */ `
  precision highp float;
  varying float vBright;
  varying float vTint;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;
    float a = exp(-r2 * 9.0) * vBright;
    if (a < 0.0018) discard;
    vec3 col = mix(vec3(0.55, 0.82, 1.0), vec3(0.85, 0.9, 1.0), vTint);
    gl_FragColor = vec4(col * a, a);
  }
`;

/**
 * Suspended particulate, lit only by a passing front.
 *
 * The mote positions are static in the buffer; the shader wraps them around the listener and
 * drifts them with the clock, so a small field covers unbounded travel. Nothing here is
 * simulated on the CPU per frame — the only per-frame work is copying at most four wavefronts
 * into uniforms, and even that is skipped when no wave is alive.
 */
export class WaveDust {
  readonly object: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;

  constructor(count: number, extent: number, random: () => number) {
    const positions = new Float32Array(count * 3);
    const drift = new Float32Array(count * 3);
    const rnd = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = random() * extent;
      positions[i * 3 + 1] = random() * extent;
      positions[i * 3 + 2] = random() * extent;
      const lateral = 0.06 + random() * 0.1;
      drift[i * 3] = (random() - 0.5) * lateral;
      drift[i * 3 + 1] = -0.02 - random() * 0.05;
      drift[i * 3 + 2] = (random() - 0.5) * lateral;
      rnd[i * 2] = random();
      rnd[i * 2 + 1] = random();
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aDrift', new THREE.BufferAttribute(drift, 3));
    this.geometry.setAttribute('aRandom', new THREE.BufferAttribute(rnd, 2));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uExtent: { value: extent },
        uTime: { value: 0 },
        uProjScale: { value: 500 },
        uGain: { value: 1 },
        uSize: { value: 0.01 },
        uShell: { value: 1.2 },
        uWA: { value: Array.from({ length: MAX_LIVE_WAVES }, () => new THREE.Vector4()) },
        uWB: { value: Array.from({ length: MAX_LIVE_WAVES }, () => new THREE.Vector4()) },
        uWC: { value: Array.from({ length: MAX_LIVE_WAVES }, () => new THREE.Vector4()) },
      },
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
    this.object.visible = false;
  }

  setProjScale(scale: number): void {
    this.material.uniforms.uProjScale!.value = scale;
  }

  setLook(gain: number, size: number, shell: number): void {
    this.material.uniforms.uGain!.value = gain;
    this.material.uniforms.uSize!.value = size;
    this.material.uniforms.uShell!.value = Math.max(0.05, shell);
  }

  /** Points the field at the listener and hands it whatever fronts are still expanding. */
  update(time: number, listener: THREE.Vector3, waves: readonly LiveWave[], enabled: boolean): void {
    const live = enabled ? Math.min(waves.length, MAX_LIVE_WAVES) : 0;
    this.object.visible = live > 0;
    if (live === 0) return;
    const u = this.material.uniforms;
    u.uTime!.value = time;
    (u.uCenter!.value as THREE.Vector3).copy(listener);
    const wa = u.uWA!.value as THREE.Vector4[];
    const wb = u.uWB!.value as THREE.Vector4[];
    const wc = u.uWC!.value as THREE.Vector4[];
    for (let i = 0; i < MAX_LIVE_WAVES; i++) {
      const w = i < live ? waves[waves.length - 1 - i] : undefined;
      if (w === undefined) {
        wc[i]!.set(1, 1, 0, 0);
        continue;
      }
      wa[i]!.set(w.x, w.y, w.z, w.t0);
      wb[i]!.set(w.dirX, w.dirY, w.dirZ, w.cosHalf);
      wc[i]!.set(w.speed, w.radius, w.intensity, 0);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
