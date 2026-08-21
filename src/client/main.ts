import * as THREE from 'three';
import { buildMap } from '../shared/map.ts';
import { Controller } from './controller.ts';
import { PointField, PKind } from './pointfield.ts';
import { PulseQueue } from './scan.ts';
import { PULSE, TOUCH, POOL, AGE, PLAYER } from '../shared/config.ts';
import { dirFromAngles } from '../shared/math.ts';
import { Post } from './post.ts';

const app = document.getElementById('app')!;
const centerEl = document.getElementById('center')!;
const statsEl = document.getElementById('stats')!;

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.08, 260);

const map = buildMap();
const field = new PointField(POOL.structural, {
  transient: AGE.transient,
  structFresh: AGE.structuralFresh,
  structMemory: AGE.structuralMemory,
  entity: AGE.entityCool,
});
field.dpr = Math.min(devicePixelRatio, 2);
scene.add(field.points);

const pulses = new PulseQueue(map.world, field, 4200);
const ctl = new Controller(map.spawns[0]!, map.world);
ctl.tuning.walk = PLAYER.walkSpeed;
ctl.tuning.sprint = PLAYER.sprintSpeed;
ctl.tuning.crouch = PLAYER.crouchSpeed;

// ── input ─────────────────────────────────────────────────────────────
let locked = false;
const SENS = 0.0022;
renderer.domElement.addEventListener('click', () => { if (!locked) renderer.domElement.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  centerEl.classList.toggle('hidden', locked);
});
document.addEventListener('mousemove', (e) => { if (locked) ctl.look(e.movementX, e.movementY, SENS); });
addEventListener('keydown', (e) => { ctl.keys.add(e.code); if (e.code === 'Space') e.preventDefault(); });
addEventListener('keyup', (e) => ctl.keys.delete(e.code));
addEventListener('blur', () => ctl.keys.clear());
const post = new Post(renderer, scene, camera);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
});

// ── pulse ─────────────────────────────────────────────────────────────
let pulseReadyAt = 0;
let seed = 1;
function firePulse(now: number) {
  if (now < pulseReadyAt) return;
  pulseReadyAt = now + PULSE.cooldownS;
  const d = dirFromAngles(ctl.yaw, ctl.pitch);
  pulses.add({
    ox: ctl.pos.x, oy: ctl.eyeY, oz: ctl.pos.z,
    dx: d.x, dy: d.y, dz: d.z,
    rays: PULSE.rays,
    halfAngle: (PULSE.halfAngleDeg * Math.PI) / 180,
    range: PULSE.range,
    waveSpeed: PULSE.waveSpeed,
    startTime: now,
    densityFalloff: 1,
    seed: seed++,
  });
}
renderer.domElement.addEventListener('mousedown', (e) => { if (locked && e.button === 0) firePulse(clock()); });

// ── touch radius: the anti-frustration floor. You always feel the wall beside you. ──
let touchAt = 0;
function touchPulse(now: number) {
  if (now < touchAt) return;
  touchAt = now + TOUCH.intervalS;
  pulses.add({
    ox: ctl.pos.x, oy: ctl.eyeY, oz: ctl.pos.z,
    dx: 0, dy: -1, dz: 0,
    rays: TOUCH.rays, halfAngle: Math.PI, range: TOUCH.radius,
    waveSpeed: 400, startTime: now, densityFalloff: 0, seed: seed++,
    elevMax: 1.3,
  });
}

// ── loop ──────────────────────────────────────────────────────────────
const t0 = performance.now();
const clock = () => (performance.now() - t0) / 1000;
let last = clock();
let frames = 0, fpsAcc = 0, fps = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = clock();
  let dt = now - last; last = now;
  if (dt > 0.1) dt = 0.1;

  if (locked) ctl.step(dt);
  touchPulse(now);
  pulses.step();
  field.update(now);

  camera.position.set(ctl.pos.x, ctl.eyeY, ctl.pos.z);
  camera.rotation.set(ctl.pitch, ctl.yaw, 0, 'YXZ');
  if (post.enabled) post.render(now); else renderer.render(scene, camera);

  frames++; fpsAcc += dt;
  if (fpsAcc > 0.5) { fps = frames / fpsAcc; frames = 0; fpsAcc = 0; }
  const cd = Math.max(0, pulseReadyAt - now);
  statsEl.innerHTML =
    `<b>${fps.toFixed(0)}</b> fps · <b>${(field.used / 1000).toFixed(0)}k</b> pts · queue <b>${pulses.pending}</b><br/>` +
    `pos <b>${ctl.pos.x.toFixed(1)} ${ctl.pos.z.toFixed(1)}</b><br/>` +
    `pulse ${cd > 0 ? `<b>${cd.toFixed(1)}s</b>` : '<b>READY</b>'}`;
}
frame();

// Expose a hook for automated visual testing.
(window as any).__bs = {
  ctl, firePulse, clock, field, camera, map, pulses, scene, renderer,
  pulseReset: () => { pulseReadyAt = 0; },
  post,
  clearField: () => field.clearAll(),
};
