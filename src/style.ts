import * as THREE from 'three';

// Shared look: flat-shaded low poly. All models build materials through mat() so the
// whole game reads as one style.
export const PALETTE = {
  skin: 0xe0a070,
  skinShade: 0xb87a50,
  hair: 0x2a1a10,
  headband: 0xd8283a,
  shorts: 0x2546c8,
  shoe: 0xf2f2f2,
  wool: 0xf1ead8,
  woolShade: 0xd6cbb0,
  ramFace: 0x5a4636,
  horn: 0xc9b48a,
  hoof: 0x2a2220,
  eyeRage: 0xff2a10,
  rock: 0x8a8580,
  rockDark: 0x5f5a58,
  grass: 0x7fae4a,
  snow: 0xf4f6fb,
  cloud: 0xffffff,
  skyTop: 0x4d8fe0,
  skyHorizon: 0xffd2a0,
} as const;

const cache = new Map<string, THREE.Material>();

export function mat(color: number, opts: { emissive?: number; key?: string } = {}): THREE.Material {
  const k = `${color}-${opts.emissive ?? 0}-${opts.key ?? ''}`;
  let m = cache.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      flatShading: true,
      roughness: 0.9,
      metalness: 0,
      emissive: opts.emissive ?? 0x000000,
    });
    cache.set(k, m);
  }
  return m;
}

// Default scene lighting: warm low sun + sky/ground fill. Used by the game and the viewer.
export function setupLights(scene: THREE.Scene): THREE.DirectionalLight {
  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x6b5a48, 1.1));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
  sun.position.set(30, 40, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 25;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 150 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  return sun;
}
