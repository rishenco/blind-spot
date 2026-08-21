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
  Beacon = 6,   // the extraction pillar: a landmark for looking at from across the map
}

const VERT = /* glsl */ `
  uniform float uNow;
  uniform float uPointScale;
  uniform float uFlashDur;
  uniform float uDpr;
  uniform float uVoxProj;   // screen px subtended by one voxel at 1m
  uniform float uLifeTransient;
  uniform float uAgeStructFresh;
  uniform float uAgeStructMemory;
  uniform float uAgeEntity;

  attribute float aBirth;   // time the wavefront reaches this point
  attribute float aDepth;   // 0..1 measured distance at capture (structural depth cue)
  attribute float aInt;     // 0..1 return strength (material x incidence)
  attribute float aKind;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vFlash;
  varying float vKind;

  // ── The Three-Color Law ─────────────────────────────────────────────
  // Architecture is cyan->blue and cools to navy. Life is orange and cools to rust.
  // Sound is amber and dies. The objective is gold. Nothing else has a colour.
  const vec3 C_FRESH_NEAR = vec3(0.714, 0.941, 1.000); // #B6F0FF — pale, not white
  const vec3 C_FRESH_FAR  = vec3(0.243, 0.624, 0.878); // #3E9FE0 — depth reads as blue
  const vec3 C_COOL_NEAR  = vec3(0.388, 0.722, 0.863); // #63B8DC
  const vec3 C_COOL_FAR   = vec3(0.180, 0.435, 0.659); // #2E6FA8
  const vec3 C_MEM_NEAR   = vec3(0.220, 0.420, 0.690); // memory keeps a hint of depth,
const vec3 C_MEM_FAR    = vec3(0.130, 0.270, 0.520); // otherwise the map you built stops reading
  const vec3 C_LIFE       = vec3(1.000, 0.353, 0.176); // #FF5A2D
  const vec3 C_LIFE_COOL  = vec3(0.690, 0.251, 0.122); // #B0401F
  const vec3 C_LIFE_HOLD  = vec3(0.431, 0.165, 0.094); // #6E2A18
  const vec3 C_SOUND      = vec3(1.000, 0.702, 0.278); // #FFB347
  const vec3 C_GOLD       = vec3(1.000, 0.827, 0.302); // #FFD34D

  void main() {
    float age = uNow - aBirth;
    int kind = int(aKind + 0.5);
    vKind = aKind;

    // Before the wavefront arrives, the point does not exist yet.
    if (age < 0.0) { gl_Position = vec4(2.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); vFlash = 0.0; return; }

    float flash = 1.0 - clamp(age / uFlashDur, 0.0, 1.0);
    flash = flash * flash;
    vFlash = flash;

    vec3 col; float alpha; float px;
    // Splat ceiling. Structural points may legitimately grow large up close — that is what
    // makes a near wall read as a wall. Everything else stands for a *feature*, not a patch
    // of surface, and must not balloon into screen-filling blobs when you walk up to it.
    float maxPx = 24.0;

    if (kind == 1 || kind == 4) {
      // ── LIFE: an entity contact. Cools for 10s, then holds forever. A ghost is
      // never forgotten — it is only ever *replaced* by a newer sighting.
      float t = clamp(age / uAgeEntity, 0.0, 1.0);
      col   = t < 1.0 ? mix(C_LIFE, C_LIFE_COOL, t) : C_LIFE_HOLD;
      col   = mix(col, C_LIFE_HOLD, smoothstep(0.8, 1.0, t));
      // Deliberately below full alpha: 560 overlapping additive points otherwise sum to
      // white and the silhouette loses the one colour that says "this is a person".
      alpha = mix(0.78, 0.30, t);
      px    = 3.1;   // a ghost's 560 points stand in for a much coarser sampling of a body
      maxPx = 13.0;
    } else if (kind == 2) {
      // ── SOUND / IMPACT: transient. Dies completely, leaving no memory.
      float t = clamp(age / uLifeTransient, 0.0, 1.0);
      if (t >= 1.0) { gl_Position = vec4(2.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); vFlash = 0.0; return; }
      col   = C_SOUND;
      alpha = 0.95 * (1.0 - t) * (1.0 - t);
      px    = mix(4.2, 1.6, t);
      maxPx = 10.0;
    } else if (kind == 3) {
      // ── OBJECTIVE: gold, dims but never dies.
      float t = clamp(age / uAgeStructMemory, 0.0, 1.0);
      col   = mix(C_GOLD, C_GOLD * 0.45, t);
      alpha = mix(0.95, 0.46, t);
      px    = 2.6;
      maxPx = 9.0;
    } else if (kind == 6) {
      // ── BEACON: a pillar of light meant to be read from across the map. It fades out as
      // you approach, because the carrier has to stand inside it to win and must still be
      // able to see the person coming to stop them.
      col   = C_GOLD;
      alpha = 0.95;
      px    = 2.4;
      maxPx = 9.0;
    } else if (kind == 5) {
      // ── DEVICE: a faint glint. Reads as matter, but colder and smaller.
      float t = clamp(age / uAgeStructMemory, 0.0, 1.0);
      col   = mix(C_COOL_NEAR, C_MEM_FAR, t);
      alpha = mix(0.85, 0.34, t);
      px    = 1.8;
      maxPx = 8.0;
    } else {
      // ── MATTER: fresh -> cool -> permanent navy memory. Never culled by age;
      // only ring-buffer pressure evicts structure, so the map you have walked
      // stays with you for the whole match.
      float t1 = clamp(age / uAgeStructFresh, 0.0, 1.0);
      float t2 = clamp((age - uAgeStructFresh) / max(uAgeStructMemory - uAgeStructFresh, 0.001), 0.0, 1.0);
      vec3 fresh = mix(C_FRESH_NEAR, C_FRESH_FAR, aDepth);
      vec3 cool  = mix(C_COOL_NEAR,  C_COOL_FAR,  aDepth);
      vec3 memory = mix(C_MEM_NEAR, C_MEM_FAR, aDepth);
      col   = mix(mix(fresh, cool, t1), memory, t2);
      // The memory floor is deliberately generous. This dim blue wireframe IS the player's
      // map; if it fades to nothing, the game stops being about navigating from memory and
      // becomes a game about whatever you scanned in the last four seconds.
      alpha = mix(mix(1.0, 0.62, t1), 0.42, t2);
      px    = mix(1.0, 0.86, t2);
    }

    // Return strength modulates presence: a grazing hit on cloth is a whisper of a point.
    alpha *= mix(0.5, 1.0, aInt);
    col = mix(col, vec3(1.0, 0.98, 0.94), flash * 0.8);
    vColor = col;
    vAlpha = alpha;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    if (kind == 6) alpha *= smoothstep(0.4, 2.6, dist);
    // Deliberately flatter than 1/d perspective: near returns must not blow out into
    // white slabs, and distant ones must stay legible. Depth is carried by density
    // and hue, not by sprite size.
    // ── Surface splatting ──────────────────────────────────────────────
    // A structural point is not a dot; it is a measurement standing in for one voxel of
    // real surface. Sizing it to the screen footprint of that voxel is what makes a wall
    // three metres away read as a WALL and the same wall at twenty metres read as grain.
    // Density is already capped by voxel dedup, so this cannot blow out: total coverage is
    // bounded by the surface area actually in view.
    float sv = fract(sin(dot(position.xz + position.y, vec2(12.9898, 78.233))) * 43758.5453);
    float splat = uVoxProj / max(dist, 0.30);
    float sz = px * splat * uPointScale * (0.76 + 0.48 * sv);
    sz = clamp(sz * (1.0 + flash * 0.7), 1.05 * uDpr, maxPx * uDpr);
    gl_PointSize = sz;
    // Energy conservation: a big near splat spreads the same return over more pixels, so
    // it must be correspondingly dimmer or close geometry burns out to white.
    vAlpha = vAlpha * clamp(3.1 / max(sz / uDpr, 1.0), 0.30, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec3  vColor;
  varying float vAlpha;
  varying float vFlash;
  varying float vKind;

  void main() {
    if (vAlpha <= 0.003) discard;
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    // Wide bright plateau with a soft rim: at 1-3px a sharp falloff eats the whole sprite.
    float falloff = 1.0 - smoothstep(0.055, 0.25, r2);
    float core = 1.0 - smoothstep(0.0, 0.09, r2);
    // Life points get no hot core: their colour IS the information.
    float boost = ((vKind > 0.5 && vKind < 1.5) || (vKind > 3.5 && vKind < 4.5)) ? 0.12 : 0.45;
    vec3 col = vColor * (1.0 + core * boost) + vec3(vFlash) * core * 0.5;
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
  private depth: THREE.BufferAttribute;
  private inten: THREE.BufferAttribute;
  private kind: THREE.BufferAttribute;
  private mat: THREE.ShaderMaterial;
  private dirtyLo = Infinity;
  private dirtyHi = -Infinity;
  private wrapped = false;
  /** voxel key -> point index, so rescanning a wall refreshes it rather than duplicating it. */
  private vox = new Map<number, number>();
  private voxOf: Float64Array;
  /**
   * Voxel size for structural dedup. This is the single most important number in the
   * renderer: it is the resolution ceiling on close surfaces. At 0.09m a wall four metres
   * away resolves to points ~20px apart, which reads as scattered dots rather than as a
   * wall. At 0.045m it reads as a surface. The cost is that the whole map no longer fits
   * in the pool — which is correct: memory is finite, and the oldest space you scanned
   * should be the first to fade.
   */
  private static readonly VOX = 0.045;

  constructor(capacity: number, ages?: Partial<{ transient: number; structFresh: number; structMemory: number; entity: number }>) {
    this.capacity = capacity;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(capacity).fill(-1e9), 1);
    this.depth = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    this.inten = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    this.kind = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    this.voxOf = new Float64Array(capacity).fill(-1);
    for (const a of [this.pos, this.birth, this.depth, this.inten, this.kind]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aBirth', this.birth);
    g.setAttribute('aDepth', this.depth);
    g.setAttribute('aInt', this.inten);
    g.setAttribute('aKind', this.kind);
    g.setDrawRange(0, 0);
    // The field is world-spanning; never let frustum culling drop it.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geom = g;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uNow: { value: 0 },
        uPointScale: { value: 0.70 },
        uVoxProj: { value: 40 },
        uDpr: { value: 1 },
        uFlashDur: { value: 0.45 },
        uLifeTransient: { value: 4.0 },
        uAgeStructFresh: { value: 4.0 },
        uAgeStructMemory: { value: 30.0 },
        uAgeEntity: { value: 10.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    if (ages) this.setAges(ages);
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }

  get material(): THREE.ShaderMaterial { return this.mat; }
  set pointScale(v: number) { this.mat.uniforms.uPointScale!.value = v; }
  set dpr(v: number) { this.mat.uniforms.uDpr!.value = v; }
  /**
   * Tell the shader how many screen pixels one voxel of surface subtends at one metre.
   * Must be refreshed whenever the viewport or field of view changes.
   */
  setProjection(physicalHeightPx: number, fovYRad: number) {
    this.mat.uniforms.uVoxProj!.value = PointField.VOX * (physicalHeightPx / (2 * Math.tan(fovYRad / 2)));
  }
  static get voxelSize() { return PointField.VOX; }
  setAges(a: Partial<{ transient: number; structFresh: number; structMemory: number; entity: number }>) {
    const u = this.mat.uniforms;
    if (a.transient !== undefined) u.uLifeTransient!.value = a.transient;
    if (a.structFresh !== undefined) u.uAgeStructFresh!.value = a.structFresh;
    if (a.structMemory !== undefined) u.uAgeStructMemory!.value = a.structMemory;
    if (a.entity !== undefined) u.uAgeEntity!.value = a.entity;
  }

  /** Append one measurement. `birth` may be in the future to stagger a propagating wavefront.
   *  `depth` is the normalised capture distance, used only as a structural depth cue. */
  push(x: number, y: number, z: number, birth: number, depth: number, intensity: number, kind: PKind) {
    // Structural memory is deduplicated on a voxel grid. Re-measuring a surface you already
    // hold updates *that* measurement's timestamp — you refresh a memory, you do not stack
    // a second copy of the same wall. This is what lets a 240k pool hold the whole map.
    if (kind === PKind.Static) {
      const V = PointField.VOX;
      const kx = Math.floor(x / V), ky = Math.floor(y / V), kz = Math.floor(z / V);
      const key = (kx + 1024) + (ky + 128) * 2048 + (kz + 1024) * 2048 * 256;
      const prev = this.vox.get(key);
      if (prev !== undefined && this.voxOf[prev] === key) {
        this.writeAt(prev, this.pos.array[prev * 3]!, this.pos.array[prev * 3 + 1]!, this.pos.array[prev * 3 + 2]!, birth, depth, intensity, kind);
        return;
      }
      // The position of the first observation is kept verbatim (a re-scan writes into the
      // existing index above), so the cloud is stable without snapping to a visible grid.
      const i0 = this.head;
      const stale = this.voxOf[i0]!;
      if (stale >= 0 && this.vox.get(stale) === i0) this.vox.delete(stale);
      this.voxOf[i0] = key;
      this.vox.set(key, i0);
    } else if (this.voxOf[this.head]! >= 0) {
      const stale = this.voxOf[this.head]!;
      if (this.vox.get(stale) === this.head) this.vox.delete(stale);
      this.voxOf[this.head] = -1;
    }
    const i = this.head;
    this.pos.array[i * 3] = x;
    this.pos.array[i * 3 + 1] = y;
    this.pos.array[i * 3 + 2] = z;
    (this.birth.array as Float32Array)[i] = birth;
    (this.depth.array as Float32Array)[i] = depth;
    (this.inten.array as Float32Array)[i] = intensity;
    (this.kind.array as Float32Array)[i] = kind;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    this.head = i + 1;
    if (this.head >= this.capacity) { this.head = 0; this.wrapped = true; }
  }

  private writeAt(i: number, x: number, y: number, z: number, birth: number, depth: number, intensity: number, kind: PKind) {
    this.pos.array[i * 3] = x; this.pos.array[i * 3 + 1] = y; this.pos.array[i * 3 + 2] = z;
    (this.birth.array as Float32Array)[i] = birth;
    (this.depth.array as Float32Array)[i] = depth;
    (this.inten.array as Float32Array)[i] = intensity;
    (this.kind.array as Float32Array)[i] = kind;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
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
    this.vox.clear(); this.voxOf.fill(-1);
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
      this.depth.addUpdateRange(lo, n); this.depth.needsUpdate = true;
      this.inten.addUpdateRange(lo, n); this.inten.needsUpdate = true;
      this.kind.addUpdateRange(lo, n); this.kind.needsUpdate = true;
      this.dirtyLo = Infinity; this.dirtyHi = -Infinity;
    }
  }

  get used(): number { return this.wrapped ? this.capacity : this.head; }
}
