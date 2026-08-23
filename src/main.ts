/**
 * Boot (engine-plan §2).
 *
 * Milestone 1 boots the sim, opens a black WebGL canvas (the void is absolute —
 * visual-brief §1.7) and wires the debug overlays. The renderer draws nothing yet: surfels
 * arrive in M3, the look registry and its 1/2/3 switching with them. Everything the
 * milestone has to show is the top-down debug view on the M key.
 *
 * Keys:  M  top-down debug view    F3  stats
 * Query: ?topdown  open with the top-down view already up (deterministic headless capture)
 */

import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { EYE_STAND, FOV_BASE } from './core/const.js';
import { DebugOverlay } from './core/debug.js';
import { yawToThreeRotationY } from './core/math.js';
import { sampleMap } from './core/map/sampleMap.js';
import { Sim } from './core/sim.js';

const params = new URLSearchParams(window.location.search);

const app = document.getElementById('app');
const overlayRoot = document.getElementById('overlay');
const boot = document.getElementById('boot');
if (!app || !overlayRoot) throw new Error('boot: #app / #overlay missing from index.html');

const sim = new Sim(sampleMap);
const debug = new DebugOverlay(overlayRoot, sim);

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
  camera.position.set(p.x, p.y + EYE_STAND, p.z);
  camera.rotation.set(p.pitch, yawToThreeRotationY(p.yaw), 0, 'YXZ');
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
// Input (debug only until M2 owns the controller)
// ---------------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  switch (e.code) {
    case 'KeyM':
      debug.toggleTopDown();
      e.preventDefault();
      break;
    case 'F3':
      debug.toggleStats();
      e.preventDefault();
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------------------

let last = performance.now();

function frame(now: number): void {
  const dtMs = Math.min(250, now - last);
  last = now;
  sim.advance(dtMs / 1000);
  syncCamera();
  renderer?.render(scene, camera);
  debug.update(dtMs);
  requestAnimationFrame(frame);
}

if (params.has('topdown')) debug.setTopDown(true);
if (params.has('stats')) debug.toggleStats();

boot?.classList.add('hidden');
syncCamera();
requestAnimationFrame(frame);

// Handy for the verify script and the browser console.
declare global {
  interface Window {
    blindspot?: { sim: Sim; debug: DebugOverlay };
  }
}
window.blindspot = { sim, debug };
