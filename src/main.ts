/**
 * Boot (engine-plan §2).
 *
 * Milestone 2 puts a body in the world: pointer-lock look, the movement verbs, camera energy
 * and procedural step audio. The renderer still draws nothing — surfels arrive in M3, the look
 * registry and its 1/2/3 switching with them — so what the milestone shows is the top-down
 * debug view (M) with the player moving on it, the F3 readout, and the sound of your own feet.
 *
 * Keys:  WASD move · Shift sprint · Ctrl/C crouch (slide at speed) · Space jump/mantle
 *        M top-down debug view · F3 stats · F6 dog 2 on the plan · B head bob · 0 mute
 * Query: ?topdown   open with the top-down view up (deterministic headless capture)
 *        ?stats     open with the F3 readout up
 *        ?nobob     start with head bob off (comfort law, vision §12)
 *        ?sim=script  run a scripted movement route instead of reading the keyboard
 *                     (script|script1|corridor, script2|mantle — see core/debug.ts SCRIPTS)
 */

import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { AudioEngine } from './core/audio.js';
import { FOV_BASE, MOUSE_SENSITIVITY, SIM_STEP } from './core/const.js';
import { DebugOverlay, SCRIPTS, SCRIPT_ALIASES, ScriptedInput } from './core/debug.js';
import { yawToThreeRotationY } from './core/math.js';
import { sampleMap } from './core/map/sampleMap.js';
import { CameraRig } from './core/movement.js';
import { Sim } from './core/sim.js';

const params = new URLSearchParams(window.location.search);

const app = document.getElementById('app');
const overlayRoot = document.getElementById('overlay');
const boot = document.getElementById('boot');
if (!app || !overlayRoot) throw new Error('boot: #app / #overlay missing from index.html');

const sim = new Sim(sampleMap);
const debug = new DebugOverlay(overlayRoot, sim);
const rig = new CameraRig();
const audio = new AudioEngine();
audio.attach(sim.bus);

/**
 * Scripted mode steps the sim a FIXED number of times per frame instead of chasing the wall
 * clock: the route then plays out identically on a 144 Hz desktop and a throttled headless
 * browser, which is the whole point of using it as a verification fixture.
 */
const scriptId = SCRIPT_ALIASES[params.get('sim') ?? ''];
const script = scriptId ? new ScriptedInput(sim, SCRIPTS[scriptId]!) : null;
const SCRIPT_STEPS_PER_FRAME = 4;

// ---------------------------------------------------------------------------------------
// Renderer. Optional: the top-down view is 2D, so a machine without WebGL still boots and
// still verifies. A failure is reported once, loudly, and never again.
// ---------------------------------------------------------------------------------------

const scene = new Scene();
const camera = new PerspectiveCamera(FOV_BASE, 1, 0.05, 200);

let renderer: WebGLRenderer | null = null;
try {
  renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  app.appendChild(renderer.domElement);
} catch (err) {
  console.warn('WebGL unavailable — running overlay-only.', err);
}

function syncCamera(): void {
  const p = sim.player;
  camera.position.set(p.x, p.y + rig.eyeOffset, p.z);
  camera.rotation.set(p.pitch, yawToThreeRotationY(p.yaw), rig.roll, 'YXZ');
  if (Math.abs(camera.fov - rig.fov) > 0.005) {
    camera.fov = rig.fov;
    camera.updateProjectionMatrix();
  }
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  renderer?.setSize(w, h, false);
  debug.resize(w, h);
}

window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------

const held = new Set<string>();

function firstGesture(): void {
  // Autoplay policy: an AudioContext only starts inside a user gesture.
  audio.resume();
}

function readKeyboard(): void {
  const forward = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
  const right = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
  sim.input.forward = forward;
  sim.input.right = right;
  sim.input.sprint = held.has('ShiftLeft') || held.has('ShiftRight');
  sim.input.crouch = held.has('ControlLeft') || held.has('ControlRight') || held.has('KeyC');
}

window.addEventListener('keydown', (e) => {
  firstGesture();
  if (e.repeat) return;
  held.add(e.code);
  switch (e.code) {
    case 'Space':
      sim.input.jumpPressed = true;
      e.preventDefault();
      break;
    case 'KeyM':
      debug.toggleTopDown();
      e.preventDefault();
      break;
    case 'F3':
      debug.toggleStats();
      e.preventDefault();
      break;
    case 'F6':
      debug.toggleDog2();
      e.preventDefault();
      break;
    case 'KeyB':
      rig.bobEnabled = !rig.bobEnabled;
      break;
    case 'Digit0':
      audio.toggleMute();
      break;
    default:
      break;
  }
});

window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear());

app.addEventListener('pointerdown', () => {
  firstGesture();
  if (!document.pointerLockElement) void app.requestPointerLock();
});

window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== app) return;
  // Yaw 0 == +x increasing toward +z, so a rightward mouse move is +yaw. Pitch is inverted:
  // screen-space "up" is a negative movementY.
  sim.input.yawDelta += e.movementX * MOUSE_SENSITIVITY;
  sim.input.pitchDelta -= e.movementY * MOUSE_SENSITIVITY;
});

// ---------------------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------------------

let last = performance.now();

function frame(now: number): void {
  const dtMs = Math.min(250, now - last);
  last = now;

  let simDt: number;
  if (script) {
    for (let i = 0; i < SCRIPT_STEPS_PER_FRAME; i++) {
      script.sync();
      sim.step(SIM_STEP);
    }
    simDt = SCRIPT_STEPS_PER_FRAME * SIM_STEP;
  } else {
    readKeyboard();
    simDt = sim.advance(dtMs / 1000) * SIM_STEP;
  }

  rig.update(simDt || dtMs / 1000, sim.movement);
  syncCamera();
  renderer?.render(scene, camera);
  debug.update(dtMs);
  requestAnimationFrame(frame);
}

if (params.has('topdown')) debug.setTopDown(true);
if (params.has('stats')) debug.toggleStats();
if (params.has('nobob')) rig.bobEnabled = false;

boot?.classList.add('hidden');
syncCamera();
requestAnimationFrame(frame);

// Handy for the verify script and the browser console.
declare global {
  interface Window {
    blindspot?: {
      sim: Sim;
      debug: DebugOverlay;
      rig: CameraRig;
      audio: AudioEngine;
      script: ScriptedInput | null;
    };
  }
}
window.blindspot = { sim, debug, rig, audio, script };
