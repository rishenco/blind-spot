/**
 * Boot: renderer, harness singletons, and the global hotkeys the lab owns.
 *
 * The active scene is chosen by `location.hash` (e.g. #movement-playground) so a specific
 * experiment can be linked to directly; changing the hash swaps scenes live.
 */

import * as THREE from 'three';
import GUI from 'lil-gui';
import { Input } from './core/input';
import { Loop } from './core/loop';
import { Hud, DEFAULT_HELP, DEFAULT_HINT } from './ui/hud';
import { SceneHost, hasScene, listScenes } from './lab/registry';
import { ScenePicker } from './lab/picker';

// Scene modules self-register on import; add future scenes here.
import './scenes/movement-playground';
import './scenes/sonar-lab';

const DEFAULT_SCENE = 'movement-playground';

const mount = document.getElementById('app');
if (mount === null) throw new Error('#app mount point is missing');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
mount.append(renderer.domElement);

const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.05, 300);

const input = new Input(renderer.domElement);
// `?look=drag` forces the fallback path — handy for headless tooling and for iframes where
// pointer lock is silently denied.
if (new URLSearchParams(window.location.search).get('look') === 'drag') input.forceDragLook();
else input.detectLookMode();

const hud = new Hud();
hud.setHint(DEFAULT_HINT);

const gui = new GUI({ title: 'Blind Spot — Lab' });
gui.domElement.style.zIndex = '15';

const host = new SceneHost({ camera, renderer, input, hud, gui });
const picker = new ScenePicker((id) => {
  window.location.hash = id;
});

function sceneIdFromHash(): string {
  const id = window.location.hash.replace(/^#/, '').trim();
  return id !== '' && hasScene(id) ? id : DEFAULT_SCENE;
}

function activate(id: string): void {
  host.activate(id);
  picker.setActive(id);
  hud.setSceneLabel(host.current?.title ?? id, host.currentVariantName);
  // Scenes may own the hint line and the help card; both fall back to the lab defaults, so
  // switching away from a scene that customised them restores the originals.
  hud.setHint(host.current?.hint ?? DEFAULT_HINT);
  hud.setHelp(host.current?.help ?? DEFAULT_HELP);
}

activate(sceneIdFromHash());

window.addEventListener('hashchange', () => {
  const id = sceneIdFromHash();
  if (id !== host.currentId) activate(id);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function handleGlobalKeys(): void {
  if (input.wasKeyPressed('Backquote')) picker.toggle();
  if (input.wasKeyPressed('KeyH')) hud.toggleHelp();
  if (input.wasKeyPressed('Escape')) {
    picker.setVisible(false);
    hud.setHelpVisible(false);
  }
  const variants = host.current?.variants;
  if (variants !== undefined && variants.length > 0) {
    for (let i = 0; i < Math.min(9, variants.length); i++) {
      if (!input.wasKeyPressed(`Digit${i + 1}`)) continue;
      host.setVariant(i);
      hud.setSceneLabel(host.current?.title ?? '', host.currentVariantName);
    }
  }
}

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
    handleGlobalKeys();
    host.update(dt);
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
    host.render(alpha);
    renderer.render(host.scene, camera);
  },
});

loop.start();

// Read-only handle for the Playwright screenshot driver and manual debugging.
// Deliberately exposes no setters: tooling drives the game through real input.
interface DebugHandle {
  getState(): Record<string, unknown>;
  listScenes(): string[];
}
(window as unknown as { __blindspot: DebugHandle }).__blindspot = {
  getState: () => ({
    scene: host.currentId,
    variant: host.currentVariantName,
    variantIndex: host.currentVariantIndex,
    fps: loop.fps,
    lookMode: input.lookMode,
    pointerLocked: document.pointerLockElement === renderer.domElement,
    ...(host.current?.debugState?.() ?? {}),
  }),
  listScenes: () => listScenes().map((s) => s.id),
};
