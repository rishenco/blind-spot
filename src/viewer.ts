import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { setupLights } from './style';
import { MODELS } from './models';

// viewer.html?model=player&pose=idle&t=0.3&yaw=30&pitch=10&dist=6&ty=1&freeze=1
const q = new URLSearchParams(location.search);
const modelName = q.get('model') ?? 'player';
const poseName = q.get('pose') ?? 'idle';
const fixedT = q.has('t') ? Number(q.get('t')) : null;
const yaw = THREE.MathUtils.degToRad(Number(q.get('yaw') ?? 30));
const pitch = THREE.MathUtils.degToRad(Number(q.get('pitch') ?? 12));
const targetY = Number(q.get('ty') ?? 1);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc4ee);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 5000);
setupLights(scene);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, targetY, 0);

const def = (await MODELS[modelName]()).default;
const root = def.build();
root.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
});
scene.add(root);

if (modelName !== 'world') {
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(8, 32).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x8a8580, flatShading: true }),
  );
  ground.receiveShadow = true;
  scene.add(ground);
}

const dist = Number(q.get('dist') ?? def.viewDistance ?? 6);
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

const pose = def.poses[poseName];
const clock = new THREE.Clock();
let frames = 0;
renderer.setAnimationLoop(() => {
  const t = fixedT ?? clock.getElapsedTime();
  pose?.(root, t);
  controls.update();
  renderer.render(scene, camera);
  if (++frames === 3) (window as any).__ready = true;
});
(window as any).__poses = Object.keys(def.poses);
