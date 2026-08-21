import * as THREE from 'three';

/**
 * PointField — the player's spatial memory, rendered.
 *
 * A fixed-capacity ring buffer of measurement points. Each point carries the wall-clock
 * time at which the pulse wavefront *reaches* it, so a whole scan can be written to the
 * GPU in one go and still appear to propagate outward: the shader simply hides any point
 * whose reveal time is in the future. Aging (fade, shrink, desaturate) is likewise pure
 * shader work driven by a single uNow uniform — zero per-frame CPU cost.
 */

export const enum PKind {
  Static = 0,   // world geometry
  Ghost = 1,    // a dynamic contact: enemy silhouette frozen at observation time
  Impact = 2,   // bullet / explosion fragment
  Objective = 3,// artifact returns
  Phantom = 4,  // decoy-generated false contact (looks like Ghost to the observer)
  Device = 5,   // deployed gadget returns
}

const VERT = /* glsl */ `
  uniform float uNow;
  uniform float uLifetime;
  uniform float uPointScale;
  uniform float uFlashDur;

  attribute float aBirth;     // time the wavefront reaches this point
  attribute float aHue;       // 0..1 hue, normally encoding measured distance
  attribute float aInt;       // 0..1 return strength (material / incidence)
  attribute float aKind;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vKind;
  varying float vFlash;

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    float age = uNow - aBirth;
    vKind = aKind;

    // Not yet reached by the wavefront, or evicted from memory: cull.
    if (age < 0.0 || age > uLifetime) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }

    float ageN = clamp(age / uLifetime, 0.0, 1.0);

    // Freshness flash: the leading edge of the wavefront burns white-hot, then settles.
    float flash = 1.0 - clamp(age / uFlashDur, 0.0, 1.0);
    flash = flash * flash;
    vFlash = flash;

    // Memory decay: saturation and value fall away, hue drifts toward cold blue.
    float decay = pow(ageN, 0.55);
    float hue = mix(aHue, 0.62, decay * 0.55);
    float sat = mix(0.95, 0.18, decay);
    float val = mix(1.0, 0.20, decay) * mix(0.55, 1.0, aInt);

    vec3 col = hsv2rgb(vec3(hue, sat, val));
    col = mix(col, vec3(1.0, 0.97, 0.9), flash * 0.85);
    vColor = col;

    // Old memories thin out but never vanish entirely before eviction: the mechanic must stay readable.
    vAlpha = mix(1.0, 0.30, decay) * mix(0.45, 1.0, aInt);

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    float dist = -mv.z;
    float shrink = mix(1.0, 0.62, decay);
    // Perspective-correct sizing with a floor so distant returns stay legible.
    float size = uPointScale * shrink * (1.0 + flash * 1.6) / max(dist, 0.6);
    gl_PointSize = clamp(size, 1.0, 14.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec3  vColor;
  varying float vAlpha;
  varying float vKind;
  varying float vFlash;

  void main() {
    if (vAlpha <= 0.001) discard;
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;

    // Soft round sprite with a hot core.
    float falloff = 1.0 - smoothstep(0.02, 0.25, r2);
    float core = 1.0 - smoothstep(0.0, 0.06, r2);

    vec3 col = vColor + vColor * core * 0.9 + vec3(vFlash) * core * 0.5;
    gl_FragColor = vec4(col, vAlpha * falloff);
  }
`;

export class PointField {
  readonly points: THREE.Points;
  readonly capacity: number;
  private head = 0;
  private geom: THREE.BufferGeometry;
  private pos: THREE.BufferAttribute;
  private birth: THREE.BufferAttribute;
  private hue: THREE.BufferAttribute;
  private inten: THREE.BufferAttribute;
  private kind: THREE.BufferAttribute;
  private mat: THREE.ShaderMaterial;
  private dirtyLo = Infinity;
  private dirtyHi = -Infinity;
  private wrapped = false;

  constructor(capacity: number, lifetime: number) {
    this.capacity = capacity;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(capacity).fill(-1e9), 1);
    this.hue = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    this.inten = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    this.kind = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.pos, this.birth, this.hue, this.inten, this.kind]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aBirth', this.birth);
    g.setAttribute('aHue', this.hue);
    g.setAttribute('aInt', this.inten);
    g.setAttribute('aKind', this.kind);
    g.setDrawRange(0, 0);
    // The field is world-spanning; never let frustum culling drop it.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geom = g;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uNow: { value: 0 },
        uLifetime: { value: lifetime },
        uPointScale: { value: 26 },
        uFlashDur: { value: 0.45 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }

  get lifetime(): number { return this.mat.uniforms.uLifetime!.value as number; }
  set lifetime(v: number) { this.mat.uniforms.uLifetime!.value = v; }
  set pointScale(v: number) { this.mat.uniforms.uPointScale!.value = v; }

  /** Append one measurement. `birth` may be in the future to stagger a propagating wavefront. */
  push(x: number, y: number, z: number, birth: number, hue: number, intensity: number, kind: PKind) {
    const i = this.head;
    this.pos.array[i * 3] = x;
    this.pos.array[i * 3 + 1] = y;
    this.pos.array[i * 3 + 2] = z;
    (this.birth.array as Float32Array)[i] = birth;
    (this.hue.array as Float32Array)[i] = hue;
    (this.inten.array as Float32Array)[i] = intensity;
    (this.kind.array as Float32Array)[i] = kind;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    this.head = i + 1;
    if (this.head >= this.capacity) { this.head = 0; this.wrapped = true; }
  }

  /** Erase every point of a kind (used when a decoy is debunked, a device dies, etc.). */
  clearKind(kind: PKind) {
    const k = this.kind.array as Float32Array;
    const b = this.birth.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) {
      if (k[i] === kind) { b[i] = -1e9; if (i < this.dirtyLo) this.dirtyLo = i; if (i > this.dirtyHi) this.dirtyHi = i; }
    }
  }

  clearAll() {
    (this.birth.array as Float32Array).fill(-1e9);
    this.dirtyLo = 0; this.dirtyHi = this.capacity - 1;
    this.head = 0; this.wrapped = false;
  }

  /** Upload dirty spans and advance the clock. Call once per frame. */
  update(now: number) {
    this.mat.uniforms.uNow!.value = now;
    const count = this.wrapped ? this.capacity : this.head;
    this.geom.setDrawRange(0, count);
    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo, n = this.dirtyHi - lo + 1;
      this.pos.addUpdateRange(lo * 3, n * 3); this.pos.needsUpdate = true;
      this.birth.addUpdateRange(lo, n); this.birth.needsUpdate = true;
      this.hue.addUpdateRange(lo, n); this.hue.needsUpdate = true;
      this.inten.addUpdateRange(lo, n); this.inten.needsUpdate = true;
      this.kind.addUpdateRange(lo, n); this.kind.needsUpdate = true;
      this.dirtyLo = Infinity; this.dirtyHi = -Infinity;
    }
  }

  get used(): number { return this.wrapped ? this.capacity : this.head; }
}
