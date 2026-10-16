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
  // --- world / environment ---
  grassLight: 0x9cc75a,
  grassDark: 0x6f9f40,
  rimRock: 0xc2b6a6,
  summitRock: 0xbcae9a,
  cliffA: 0xa89c92,
  cliffB: 0x8e8279,
  cliffC: 0xbcae9e,
  scree: 0xa39686,
  moss: 0x67913f,
  pine: 0x2f6e4c,
  pineDark: 0x23573d,
  trunk: 0x6b4a32,
  valleyGrass: 0x86b852,
  valleyDark: 0x5e9443,
  lake: 0x5fb0de,
  mountainRock: 0x6c6888,
  mountainRockFar: 0x8f98bd,
  skyZenith: 0x2a63c4,
  skyMid: 0x86b6ec,
  skyHorizonCool: 0xcfdcf0,
  sunDisk: 0xfff6dc,
} as const;

/** Direction *towards* the sun (normalized). Low warm evening sun; the world's sky disk matches it. */
export const SUN_DIR = new THREE.Vector3(-0.78, 0.45, -0.5).normalize();

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
  scene.add(new THREE.HemisphereLight(0xc4dcff, 0x8a7460, 1.6));
  const sun = new THREE.DirectionalLight(0xffe2bc, 2.9);
  sun.position.copy(SUN_DIR).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 25;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 150 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  return sun;
}
