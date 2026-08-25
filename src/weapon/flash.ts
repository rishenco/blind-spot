/**
 * The muzzle flash — the one place in this game where light exists.
 *
 * concept.md, law 1: nothing is rendered "just because", there is no ambient light, unknown
 * space is black. concept.md, perception table: "Вспышка выстрела — единственный настоящий свет
 * в игре. Резкие тени, живёт единицы кадров." Those two together define this file exactly:
 *
 *  - **One** dynamic light, and it only exists for a few frames after a shot. There is no
 *    second light source anywhere in the shipping game (the hemisphere/key pair in `main.ts` is
 *    the `L` debug toggle and is not part of the game).
 *  - It casts **hard shadows**. A flash without shadows is a soft lamp, and the whole sensation
 *    the milestone is chasing — one frame in which the room is real, with black shapes thrown
 *    across it — comes from the shadows, not from the brightness.
 *  - It is fixed in space at the moment of the shot. A flash *is* an instant; the muzzle moving
 *    afterwards has nothing to do with it. That is also why one shadow-map update per shot is
 *    not an optimisation but the physically correct thing to do.
 *
 * What it lights is the truth geometry — the same instanced meshes the `L` debug view uses, the
 * same boxes the colliders are made of. There is no second, prettier version of the hall (see
 * `hall.ts`), so for those few frames you are seeing exactly what you would walk into.
 *
 * Everything about the timing is on the simulation clock and reproducible; the debug hold
 * (`bs.flashHold(true)`, or the `Y` key) freezes the envelope at full so a thing that lives for
 * three frames can actually be looked at.
 */
import * as THREE from 'three';

export interface FlashTunables {
  /**
   * Seconds the flash burns. The human asked for this to be a slider — "вынеси в настройки да,
   * тут надо прочувствовать" — because the difference between 2 and 6 frames is the difference
   * between "something blinked" and "I read the room". The default is ~3 frames at 60 Hz; the
   * GUI range is deliberately absurd at both ends (a single frame to half a second) so the
   * feel can be found by hand.
   */
  life: number;
  /** Peak luminous intensity, candela. Physical falloff, so this number is large. */
  intensity: number;
  /** Cut-off distance, metres. Past this the flash contributes nothing at all. */
  range: number;
  /** Shape of the decay: 1 is linear, higher snaps shut faster. */
  decay: number;
  /** Hard shadows on/off. Off is for measuring what they cost, not for playing. */
  shadows: boolean;
  /** Cube shadow map resolution per face. */
  shadowSize: number;
  /** Radius of the additive muzzle bloom, metres. Zero switches it off. */
  flareSize: number;
  /** How much the bloom is worth relative to the light. */
  flareGain: number;
}

export function defaultFlashTunables(): FlashTunables {
  return {
    life: 0.05,
    // Candela, physical inverse-square falloff. Tuned by measurement, not by taste: at 5200 the
    // hall came out flood-lit end to end (mean luminance 203 against 210 for the full debug
    // lighting) — a studio lamp, which is exactly what the milestone says this must not be. At
    // 160/30 the near geometry blows out, the shadows behind it are solid black, and past ~25 m
    // the room falls off into nothing. That contrast *is* the flash.
    intensity: 160,
    range: 30,
    decay: 2.2,
    shadows: true,
    shadowSize: 512,
    flareSize: 0.42,
    flareGain: 0.6,
  };
}

/** The additive bloom at the barrel. Not a texture — a two-triangle quad with a falloff in it. */
const FLARE_VERT = `
uniform float uSize;
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  // Camera-facing by construction: the quad is built in view space around the muzzle's
  // view-space position, so it never has to be re-oriented on the CPU.
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}`;

const FLARE_FRAG = `
uniform float uGain;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // A hot core with a short shoulder — a muzzle flash is mostly a point of white.
  float core = pow(max(0.0, 1.0 - r), 3.0);
  float halo = pow(max(0.0, 1.0 - r), 1.1) * 0.35;
  float a = (core + halo) * uGain;
  gl_FragColor = vec4(uColor * a, a);
}`;

export class MuzzleFlash {
  readonly tunables: FlashTunables;
  readonly object = new THREE.Group();
  readonly light: THREE.PointLight;
  private readonly flare: THREE.Mesh;
  private readonly flareMaterial: THREE.ShaderMaterial;

  /** Scene time the last shot went off, or -1 when there has never been one. */
  private firedAt = -1;
  private held = false;
  /** Set on the frame a shot lands, cleared once the renderer has re-shadowed. */
  private shadowDirty = false;
  private lastEnvelope = 0;
  private flashes = 0;

  constructor(tunables: FlashTunables = defaultFlashTunables()) {
    this.tunables = tunables;

    // Slightly warm white — burnt powder, not a studio lamp.
    this.light = new THREE.PointLight(0xfff1d0, 0, tunables.range, 2);
    this.light.castShadow = tunables.shadows;
    this.light.shadow.mapSize.set(tunables.shadowSize, tunables.shadowSize);
    this.light.shadow.camera.near = 0.12;
    this.light.shadow.camera.far = tunables.range;
    // The muzzle is half a metre from the eye and everything is a box: without a bias the
    // player's own view fills with acne, and with too much it detaches every shadow from its
    // object. These two are tuned against the crate field, which is the worst case in the hall.
    this.light.shadow.bias = -0.0016;
    this.light.shadow.normalBias = 0.02;
    this.object.add(this.light);

    this.flareMaterial = new THREE.ShaderMaterial({
      vertexShader: FLARE_VERT,
      fragmentShader: FLARE_FRAG,
      uniforms: {
        uSize: { value: tunables.flareSize },
        uGain: { value: 0 },
        uColor: { value: new THREE.Color(0xfff6df) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.flare = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.flareMaterial);
    this.flare.frustumCulled = false;
    this.object.add(this.flare);

    this.object.visible = false;
  }

  get lit(): boolean {
    return this.object.visible;
  }

  get envelope(): number {
    return this.lastEnvelope;
  }

  get count(): number {
    return this.flashes;
  }

  /** Debug: hold the last flash open so a three-frame event can be looked at. */
  setHold(on: boolean): void {
    this.held = on;
    if (on) this.shadowDirty = true;
  }

  get holding(): boolean {
    return this.held;
  }

  /** A shot went off here, now. The light is pinned to this point for the whole flash. */
  trigger(x: number, y: number, z: number, time: number): void {
    this.light.position.set(x, y, z);
    this.flare.position.set(x, y, z);
    this.firedAt = time;
    this.shadowDirty = true;
    this.flashes++;
  }

  /**
   * Called once per rendered frame with the interpolated scene time. Returns the 0..1 envelope,
   * and leaves the light and the bloom set up for this frame.
   */
  sample(now: number): number {
    const t = this.tunables;
    let e: number;
    if (this.firedAt < 0) e = 0;
    else if (this.held) e = 1;
    else {
      const age = (now - this.firedAt) / Math.max(1e-4, t.life);
      e = age < 0 || age > 1 ? 0 : Math.pow(1 - age, t.decay);
    }
    this.lastEnvelope = e;

    const on = e > 0.002;
    this.object.visible = on;
    if (!on) {
      this.light.intensity = 0;
      return 0;
    }
    this.light.intensity = t.intensity * e;
    this.light.distance = t.range;
    this.light.castShadow = t.shadows;
    this.flareMaterial.uniforms.uSize!.value = t.flareSize;
    this.flareMaterial.uniforms.uGain!.value = t.flareGain * e;
    this.flare.visible = t.flareSize > 0 && t.flareGain > 0;
    return e;
  }

  /**
   * True on the first rendered frame of a flash — and only then. A pinned light over a hall
   * that is not moving has one correct shadow map per shot, so this is what keeps six cube
   * faces off the other frames' bill.
   */
  takeShadowUpdate(): boolean {
    if (!this.shadowDirty) return false;
    this.shadowDirty = false;
    return true;
  }

  applyShadowSize(): void {
    this.light.shadow.mapSize.set(this.tunables.shadowSize, this.tunables.shadowSize);
    this.light.shadow.map?.dispose();
    this.light.shadow.map = null;
    this.shadowDirty = true;
  }

  dispose(): void {
    this.flare.geometry.dispose();
    this.flareMaterial.dispose();
    this.light.dispose();
  }
}
