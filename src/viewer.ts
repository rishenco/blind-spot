import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { setupLights } from './style';
import { MODELS } from './models';
import type { ModelDef } from './models/types';

// Single model: viewer.html?model=player&pose=idle&t=0.3&yaw=30&pitch=10&dist=6&ty=1
// Everything together: viewer.html?model=scene&pose=idle&ramPose=paw&gap=4&t=0.3&yaw=180&pitch=20&dist=7
//   (world + player at origin facing +Z + ram `gap` m in front facing the player)
const q = new URLSearchParams(location.search);
const modelName = q.get('model') ?? 'player';
const poseName = q.get('pose') ?? 'idle';
const ramPoseName = q.get('ramPose') ?? 'idle';
const fixedT = q.has('t') ? Number(q.get('t')) : null;
const yaw = THREE.MathUtils.degToRad(Number(q.get('yaw') ?? 30));
const pitch = THREE.MathUtils.degToRad(Number(q.get('pitch') ?? 12));
const targetY = Number(q.get('ty') ?? 1);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc4ee);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 5000);
setupLights(scene);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, targetY, 0);

type Animated = { def: ModelDef; root: THREE.Object3D; pose: string };
const animated: Animated[] = [];

async function add(name: string, pose: string): Promise<Animated> {
  const def = (await MODELS[name]()).default;
  const root = def.build();
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
  });
  scene.add(root);
  const a = { def, root, pose };
  animated.push(a);
  return a;
}

let viewDistance = 6;
if (modelName === 'scene') {
  await add('world', 'idle');
  await add('player', poseName);
  const ram = await add('ram', ramPoseName);
  ram.root.position.set(0, 0, Number(q.get('gap') ?? 4));
  ram.root.rotation.y = Math.PI; // face the player
  viewDistance = 7;
} else {
  const a = await add(modelName, poseName);
  viewDistance = a.def.viewDistance ?? 6;
  if (modelName !== 'world') {
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(8, 32).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x8a8580, flatShading: true }),
    );
    ground.receiveShadow = true;
    scene.add(ground);
  }
}

const dist = Number(q.get('dist') ?? viewDistance);
camera.position.set(
  Math.sin(yaw) * Math.cos(pitch) * dist,
  targetY + Math.sin(pitch) * dist,
  Math.cos(yaw) * Math.cos(pitch) * dist,
);
controls.update();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
let frames = 0;
renderer.setAnimationLoop(() => {
  const t = fixedT ?? clock.getElapsedTime();
  for (const a of animated) a.def.poses[a.pose]?.(a.root, t);
  controls.update();
  renderer.render(scene, camera);
  if (++frames === 3) (window as any).__ready = true;
});
(window as any).__poses = animated.map((a) => Object.keys(a.def.poses));
