/**
 * Boot: the renderer, the singletons the game hangs off, and the fixed-step loop.
 *
 * There is exactly one scene and exactly one look. The prototype this branch was distilled from
 * carried a lab harness — a scene registry, a picker, number-key variants, four alternative
 * point-cloud looks and a lit graybox room to compare movement against. All of it did its job
 * (choosing between them) and none of it is a game, so none of it is here.
 */

import * as THREE from 'three';
import GUI from 'lil-gui';
import { Input } from './core/input';
import { Loop } from './core/loop';
import { parseSeed } from './core/rng';
import { Hud } from './ui/hud';
import { Game } from './game/game';

const mount = document.getElementById('app');
if (mount === null) throw new Error('#app mount point is missing');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
mount.append(renderer.domElement);

const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.05, 300);
const scene = new THREE.Scene();

const input = new Input(renderer.domElement);
// `?look=drag` forces the fallback path — handy for headless tooling and for iframes where
// pointer lock is silently denied.
if (new URLSearchParams(window.location.search).get('look') === 'drag') input.forceDragLook();
else input.detectLookMode();

const hud = new Hud();
const gui = new GUI({ title: 'Blind Spot' });
gui.domElement.style.zIndex = '15';

// `?seed=N` reseeds every random stream in the simulation from N, so a run can be handed to
// someone else as a link. Without it the streams keep their historical constants and the game is
// bit-for-bit the game it has always been (see core/rng.ts). The URL is the only way in: it is
// real input, which is why this does not need a setter on the debug handle below.
const seed = parseSeed(window.location.search);

const game = new Game({ scene, camera, renderer, input, hud, gui, seed });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function updateCapturePrompt(): void {
  if (input.isCapturing) {
    hud.setCapturePrompt(null);
    return;
  }
  hud.setCapturePrompt(
    input.lookMode === 'pointerlock' ? 'click to capture mouse' : 'drag to look · Esc releases',
  );
}

let perfTimer = 0;

const loop = new Loop({
  fixedUpdate: (dt) => {
    if (input.wasKeyPressed('KeyH')) hud.toggleHelp();
    if (input.wasKeyPressed('Escape')) hud.setHelpVisible(false);
    game.update(dt);
    input.endTick();

    perfTimer -= dt;
    if (perfTimer <= 0) {
      perfTimer = 0.25;
      hud.setPerf([
        ['fps', loop.fps.toFixed(0)],
        ['look', input.lookMode],
      ]);
      updateCapturePrompt();
    }
  },
  render: (alpha) => {
    game.render(alpha);
    // The game draws itself only when it owns a post chain; otherwise take the direct path.
    if (!game.renderFrame(scene, camera)) renderer.render(scene, camera);
  },
});

loop.start();

// Read-only handle for the Playwright screenshot driver and manual debugging.
// Deliberately exposes no setters: tooling drives the game through real input.
interface DebugHandle {
  getState(): Record<string, unknown>;
  probe(name: string, args?: Record<string, unknown>): unknown;
}
(window as unknown as { __blindspot: DebugHandle }).__blindspot = {
  probe: (name, args) => game.debugProbe(name, args),
  getState: () => ({
    fps: loop.fps,
    lookMode: input.lookMode,
    pointerLocked: document.pointerLockElement === renderer.domElement,
    ...game.debugState(),
  }),
};
