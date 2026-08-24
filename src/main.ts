/**
 * BLIND SPOT — M1 "чёрный зал".
 *
 * One question, and the whole milestone exists to answer it: can you navigate a black, cluttered
 * hall on lidar alone? Everything here is in service of that — the hall, the ping, the touch
 * layer, the debug views you need to check your own answer, and the frame timer that decides
 * whether the answer is worth anything.
 *
 * The scene renders nothing by default. Black is the ground state, not a background.
 */
import * as THREE from 'three';
import GUI from 'lil-gui';

import { Input } from './core/input';
import { Loop } from './core/loop';
import { SoundBus } from './events/bus';
import { Hud, type HelpRow } from './debug/hud';
import { Lidar, defaultLidarTunables } from './lidar/lidar';
import { StructuredPaint, defaultStructuredTunables } from './lidar/structured';
import { defaultAgeRamp } from './lidar/palette';
import { TouchLayer, defaultTouchTunables } from './touch/touch';
import {
  PlayerController,
  defaultCameraTunables,
  defaultMovementTunables,
  type PlayerEvent,
} from './player/controller';
import { GATE_TARGET, HALL, LANDMARKS, buildHall } from './world/hall';
import { PropWorld, defaultPropTunables, loadRapier } from './props/props';
import { PropReveal } from './props/reveal';
import { DynamicPaint } from './lidar/dynamic';
import { ARCHETYPES } from './props/shapes';
import { SoundMarkers, defaultMarkerTunables } from './sound/markers';

type ViewMode = 'player' | 'third' | 'top';

const HELP: HelpRow[] = [
  { keys: 'W A S D', action: 'move' },
  { keys: 'Shift / Ctrl', action: 'run / crouch' },
  { keys: 'Space', action: 'jump, climb at a ledge' },
  { keys: 'F  or  RMB', action: 'lidar ping — cone forward + halo around you' },
  { keys: 'L', action: 'debug: darkness off (lights on)' },
  { keys: 'V', action: 'debug: view — player / third / top' },
  { keys: 'T', action: 'debug: touch layer on/off' },
  { keys: 'M', action: 'sound markers on/off' },
  { keys: 'N', action: 'debug: audibility radius of each sound event' },
  { keys: 'K', action: 'debug: clear the accumulated map' },
  { keys: 'B', action: 'debug: shove the clutter in front of you (make a mess)' },
  { keys: 'J', action: 'debug: refill the lidar' },
  { keys: 'G', action: 'debug: tuning panel' },
  { keys: 'R', action: 'respawn' },
  { keys: 'H', action: 'this help' },
];

const HINT =
  'WASD move · Shift run · Ctrl crouch · F lidar ping · L lights · V view · T touch · M markers · G tuning · H help';

/** How much of the loudness scale each thing the body does is worth, in metres of notice. */
const STEP_LOUDNESS: Record<string, number> = { crouch: 3, walk: 9, sprint: 16 };

interface Perf {
  simMs: number;
  paintMs: number;
  renderMs: number;
  frameMs: number;
}

class App {
  private readonly params = new URLSearchParams(location.search);
  readonly harness = this.params.get('harness') === '1';
  /**
   * Harness only: force-finish the unlock inside the frame that started it, so a screenshot
   * never catches a half-painted map. It is a determinism aid and NOT how the game runs, so
   * the perf pass turns it off — measuring it would measure the harness, not the lidar.
   */
  private syncPaint = true;
  private readonly seed = Number(this.params.get('seed') ?? '20260824');

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly topCamera = new THREE.PerspectiveCamera(60, 1, 0.5, 400);
  private readonly hud = new Hud();
  private readonly input: Input;
  private readonly loop: Loop;

  private readonly hall = buildHall(this.seed);
  private readonly bus = new SoundBus();
  private readonly lidar = new Lidar(defaultLidarTunables());
  private readonly paint: StructuredPaint;
  private readonly touch: TouchLayer;
  /**
   * The sound layer. It listens to the bus and to nothing else, exactly as the concept demands:
   * it has no idea what physics or the player did, only that a noise happened at a point.
   */
  private readonly markers = new SoundMarkers(3072, defaultMarkerTunables());
  private readonly player: PlayerController;
  /** Built after the wasm is up, so everything that touches them is null-guarded. */
  private props: PropWorld | null = null;
  private dyn: DynamicPaint | null = null;
  private propReveal: PropReveal | null = null;

  private readonly lights = new THREE.Group();
  private gui: GUI | null = null;

  /** Simulation clock, seconds. Never wall-clock: the keyframe generator depends on it. */
  private time = 0;
  private view: ViewMode = 'player';
  private lightsOn = false;
  private pendingFire = false;
  private buildMs = 0;
  private propsMs = 0;

  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchSize = new THREE.Vector2();
  /** Rolling events/sec, sampled once a second — the overlay line the spec asks for. */
  private eventRate = 0;
  private rateAt = 0;
  private rateSeq = 0;
  private readonly frameTimes: number[] = [];
  private perf: Perf = { simMs: 0, paintMs: 0, renderMs: 0, frameMs: 0 };
  private topHeight = 62;
  /** Pins the top-down camera to a fixed spot instead of the player. Debug/keyframes only. */
  private topFocus: { x: number; z: number } | null = null;

  /** Live look/quality knobs the tuning panel owns. */
  private readonly look = {
    windowRadius: 55,
    refreshSeconds: 0.3,
    featherStart: 0.55,
    renderScale: 1,
    chunkGapMs: 0,
  };

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
    document.body.append(canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: this.harness,
    });
    this.renderer.setClearColor(0x000000, 1);

    const cameraTunables = defaultCameraTunables();
    this.camera = new THREE.PerspectiveCamera(cameraTunables.fov, 1, 0.05, 260);

    this.player = new PlayerController(this.hall.world, defaultMovementTunables(), cameraTunables);
    this.player.setSpawn(HALL.spawn, HALL.spawnYawDeg);

    this.paint = new StructuredPaint(this.hall.world, defaultAgeRamp(), defaultStructuredTunables());
    const t0 = performance.now();
    this.paint.ensureBuilt();
    this.buildMs = performance.now() - t0;
    this.paint.setActive(true);
    this.paint.applyLook(this.look.windowRadius, this.look.refreshSeconds, this.look.featherStart);
    this.scene.add(this.paint.object);

    // The hand writes into the paint's mask rather than owning geometry of its own, so it needs
    // the paint and nothing else — and it adds no draw call.
    this.touch = new TouchLayer(this.paint, defaultTouchTunables());

    // Concept §"звуковой слой — это НЕ свет": the marker is drawn at the point the event
    // happened and nowhere else. It is a bus subscriber, so it cannot accidentally learn
    // anything the ear would not have known.
    this.markers.applyLook();
    this.bus.subscribe((event) => this.markers.handle(event));
    this.scene.add(this.markers.object);

    // Lights-on debug view. Off by default and, being a Group, costs nothing while it is.
    this.lights.add(new THREE.HemisphereLight(0xbfd4e6, 0x202428, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(0.4, 1, 0.25);
    this.lights.add(key);
    this.hall.reveal.visible = false;
    this.lights.visible = false;
    this.scene.add(this.hall.reveal, this.lights);

    this.input = new Input(canvas);
    if (this.harness || this.params.get('look') === 'drag') this.input.forceDragLook();
    else this.input.detectLookMode();

    this.player.onEvent((event) => this.onPlayerEvent(event));

    this.hud.setSceneLabel('BLIND SPOT', 'M1 — dark hall');
    this.hud.setHelp(HELP);
    this.hud.setHint(HINT);
    this.hud.setHelpVisible(false);

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) this.pendingFire = true;
    });
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.loop = new Loop(
      { fixedUpdate: (dt) => this.fixedUpdate(dt), render: (a) => this.render(a) },
      { hz: 120 },
    );
  }

  /**
   * Second half of construction: Rapier's wasm has to be decoded before a single prop can exist,
   * and that is a promise. Nothing publishes `window.bs` until this resolves, so the keyframe
   * generator never catches a hall without its clutter.
   */
  async start(): Promise<void> {
    const R = await loadRapier();
    const t0 = performance.now();
    this.props = new PropWorld(R, this.hall.world, this.bus, this.seed, defaultPropTunables());
    this.dyn = new DynamicPaint(
      this.props,
      this.hall.world,
      defaultAgeRamp(),
      this.paint.tunables,
      // Shared by reference: a ping's ripple crest must not stop at the edge of a barrel.
      this.paint.waveUniforms(),
    );
    this.dyn.setActive(!this.lightsOn);
    this.dyn.setWindow(this.look.windowRadius, this.look.refreshSeconds);
    this.scene.add(this.dyn.object);
    this.touch.attach(this.dyn);
    this.propReveal = new PropReveal(this.props);
    this.scene.add(this.propReveal.object);
    this.propsMs = performance.now() - t0;

    // Let the pile settle before anyone looks at it: laid-out props start a few millimetres
    // above their support and would otherwise be caught mid-drop on frame one.
    for (let i = 0; i < 90; i++) this.props.step(1 / 60, 0);
    this.props.settle();
    this.hud.setSceneLabel('BLIND SPOT', 'M2 — clutter');
    if (!this.harness) this.loop.start();
  }

  // ---- simulation ---------------------------------------------------------

  private fixedUpdate(dt: number): void {
    const t0 = performance.now();
    this.time += dt;
    this.bus.setTime(this.time);

    this.hotkeys();
    this.player.update(dt, this.input);
    this.lidar.update(dt);

    if (this.pendingFire) {
      this.pendingFire = false;
      this.fire();
    }

    const eye = this.player.eye;

    if (this.props !== null) {
      const p = this.player.position;
      this.props.setPlayer(p.x, p.y, p.z, this.player.bodyRadius, this.player.bodyHeight);
      this.placeRifle(eye);
      this.props.step(dt, this.time);
      this.dyn?.update(this.time);
      if (this.propReveal !== null && this.lightsOn) this.propReveal.sync();
    }

    this.touch.update(eye.x, eye.y, eye.z);

    this.input.endTick();
    this.perf.simMs = performance.now() - t0;
  }

  private hotkeys(): void {
    const i = this.input;
    if (i.wasKeyPressed('KeyF')) this.pendingFire = true;
    if (i.wasKeyPressed('KeyL')) this.setLights(!this.lightsOn);
    if (i.wasKeyPressed('KeyV')) this.cycleView();
    if (i.wasKeyPressed('KeyT')) this.touch.setVisible(!this.touch.visible);
    if (i.wasKeyPressed('KeyM')) this.markers.setVisible(!this.markers.visible);
    if (i.wasKeyPressed('KeyN')) this.markers.setRadiusVisible(!this.markers.radiusVisible);
    if (i.wasKeyPressed('KeyK')) this.clearMap();
    if (i.wasKeyPressed('KeyB')) this.shove();
    if (i.wasKeyPressed('KeyJ')) this.lidar.refill();
    if (i.wasKeyPressed('KeyG')) this.toggleGui();
    if (i.wasKeyPressed('KeyH')) this.hud.toggleHelp();
    if (i.wasKeyPressed('KeyR')) this.player.respawn();
  }

  /**
   * The rifle's physical collider — concept: "если резко крутиться в тесноте, стволом сшибаешь
   * вещи". It is kinematic and rides the camera, so the barrel really does sweep through a
   * shelf when you spin, and the contact forces that come back out are ordinary sound events.
   */
  private placeRifle(eye: THREE.Vector3): void {
    const f = this.scratchDir;
    this.camera.getWorldDirection(f);
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    this.props?.setRifle(
      eye.x + f.x * 0.42,
      eye.y + f.y * 0.42 - 0.16,
      eye.z + f.z * 0.42,
      this.camera.quaternion.x,
      this.camera.quaternion.y,
      this.camera.quaternion.z,
      this.camera.quaternion.w,
    );
  }

  /** Debug: kick over whatever is a couple of metres ahead. The mess-maker for the keyframes. */
  private shove(): number {
    if (this.props === null) return 0;
    const eye = this.player.eye;
    const f = this.scratchDir;
    this.camera.getWorldDirection(f);
    return this.props.disturb(eye.x + f.x * 2, eye.y - 0.6, eye.z + f.z * 2, 2.2, 2.4);
  }

  /** Fires the lidar from the eye, along the look direction. */
  fire(): boolean {
    const eye = this.player.eye;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    return this.lidar.fire(eye, forward, this.time);
  }

  private onPlayerEvent(event: PlayerEvent): void {
    // The body is the only thing making noise in M1 — and, as the concept points out, it is
    // noise that tells *you* nothing. It is here because the bus has to be load-bearing from
    // the first milestone, not because it helps you see.
    if (event.type === 'footstep') {
      this.bus.emit({
        source: 'player-step',
        x: event.x, y: event.y, z: event.z,
        loudness: STEP_LOUDNESS[event.tier] ?? 9,
      });
      return;
    }
    this.bus.emit({
      source: 'player-land',
      x: event.x, y: event.y, z: event.z,
      loudness: Math.min(26, 6 + event.impactSpeed * 2.2),
    });
  }

  // ---- render -------------------------------------------------------------

  private render(alpha: number): void {
    const frameStart = performance.now();
    this.player.applyToCamera(this.camera, alpha);

    const renderTime = this.time + alpha * this.loop.stepSeconds;
    const eye = this.camera.position;
    this.paint.setListener(eye.x, eye.y, eye.z);
    this.dyn?.setListener(eye.x, eye.y, eye.z);

    const paintStart = performance.now();
    // One front at a time: the renderer finishes unlocking before it is handed the next.
    const busy = this.paint.getStats().pending > 0 || (this.dyn?.getStats().pending ?? 0) > 0;
    this.lidar.pump(busy, (ping) => {
      this.paint.handle(ping, renderTime, 0);
      // The prop layer stamps its points with the slot the hall's paint just claimed, so both
      // buffers read the same wave uniform and the crest crosses the boundary unbroken.
      this.dyn?.handle(ping, this.paint.lastWaveSlot);
      if (this.harness && this.syncPaint) {
        this.paint.drain();
        this.dyn?.drain();
      }
    });
    this.paint.advance(renderTime, this.look.chunkGapMs);
    this.dyn?.advance(this.paint.tunables.chunkMs);
    this.perf.paintMs = performance.now() - paintStart;

    const camera = this.activeCamera();
    const projScale = (camera.projectionMatrix.elements[5] ?? 1) * this.drawHeight() * 0.5;
    this.paint.setProjScale(projScale);
    this.dyn?.setProjScale(projScale);
    // Markers size themselves in pixels, so they need the drawing-buffer size, not the CSS one.
    const buffer = this.renderer.getDrawingBufferSize(this.scratchSize);
    this.markers.setTime(renderTime);
    this.markers.setViewport(buffer.x, buffer.y);
    this.markers.setProjScale(projScale);

    const renderStart = performance.now();
    this.renderer.render(this.scene, camera);
    this.perf.renderMs = performance.now() - renderStart;

    this.perf.frameMs = performance.now() - frameStart;
    this.frameTimes.push(this.perf.frameMs);
    if (this.frameTimes.length > 240) this.frameTimes.shift();
    this.updateHud();
  }

  private activeCamera(): THREE.PerspectiveCamera {
    if (this.view !== 'top') return this.camera;
    const p = this.player.position;
    // The top view normally follows the player, but a map screenshot has to be able to stand
    // still: a map and the lit truth of the same hall are only comparable if the camera did
    // not move between them.
    const fx = this.topFocus?.x ?? p.x;
    const fz = this.topFocus?.z ?? p.z;
    this.topCamera.position.set(fx, this.topHeight, fz + 0.001);
    this.topCamera.lookAt(fx, 0, fz);
    this.topCamera.updateMatrixWorld();
    this.topCamera.updateProjectionMatrix();
    return this.topCamera;
  }

  private drawHeight(): number {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    return size.y * this.renderer.getPixelRatio();
  }

  private percentile(p: number): number {
    if (this.frameTimes.length === 0) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  }

  private updateHud(): void {
    const p = this.player.position;
    const st = this.lidar.state;
    const paint = this.paint.getStats();
    const props = this.props?.getStats() ?? null;
    const dyn = this.dyn?.getStats() ?? null;
    const counts = this.bus.countsBySource();
    const marks = this.markers.getStats();
    if (this.time - this.rateAt >= 1) {
      this.eventRate = (this.bus.emitted - this.rateSeq) / Math.max(0.001, this.time - this.rateAt);
      this.rateAt = this.time;
      this.rateSeq = this.bus.emitted;
    }
    const gate = Math.hypot(p.x - GATE_TARGET.x, p.z - GATE_TARGET.z);

    this.hud.setDebug([
      ['pos', `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`],
      ['near', this.nearestLandmark(p.x, p.z)],
      ['gate', `${gate.toFixed(1)} m`],
      ['lidar', st.ready ? `ready ${st.charge.toFixed(2)}` : `charging ${(st.progress * 100) | 0}%`],
      ['pings', `${st.fired}${st.queued > 0 ? ` (+${st.queued})` : ''}`],
      ['sound', `${this.bus.emitted} ev · step ${counts.get('player-step') ?? 0} · prop ${counts.get('prop-impact') ?? 0}`],
      ['view', this.lightsOn ? `${this.view} + lights` : this.view],
    ]);

    this.hud.setPerf([
      // Under the keyframe harness the rAF loop is not running at all — the sim is stepped by
      // hand — so there is no such thing as a frame rate. Say so instead of printing a zero that
      // reads like a hang.
      ['fps', this.loop.fps > 0 ? this.loop.fps.toFixed(0) : 'n/a (stepped)'],
      ['frame', `${this.perf.frameMs.toFixed(1)} ms · p95 ${this.percentile(0.95).toFixed(1)}`],
      ['sim/gpu', `${this.perf.simMs.toFixed(2)} / ${this.perf.renderMs.toFixed(2)} ms`],
      ['paint', `${this.perf.paintMs.toFixed(2)} ms · pend ${paint.pending}`],
      ['dots', `${paint.unlockedDots} / ${paint.dots}`],
      ['edges', `${paint.unlockedEdges} / ${paint.edges}`],
      ['touch', `${this.touch.getStats().remembered} pt · ${this.touch.getStats().segments} ends`],
      ['props', props === null ? 'off' : `${props.awake} awake / ${props.bodies - props.awake} asleep · ${props.stepMs.toFixed(2)} ms`],
      ['prop pts', dyn === null ? '-' : `${dyn.revealed} / ${dyn.points}`],
      ['marks', `${marks.alive} live · ${this.eventRate.toFixed(1)} ev/s`],
      ['calls', `${this.renderer.info.render.calls}`],
    ]);

    this.hud.setCapturePrompt(
      this.harness || this.input.isCapturing ? null : 'click to capture the mouse',
    );
  }

  private nearestLandmark(x: number, z: number): string {
    let best = LANDMARKS[0]!;
    let bestD = Infinity;
    for (const l of LANDMARKS) {
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return `${best.name} ${bestD.toFixed(0)} m`;
  }

  // ---- debug switches -----------------------------------------------------

  setLights(on: boolean): void {
    this.lightsOn = on;
    this.hall.reveal.visible = on;
    this.lights.visible = on;
    this.paint.setActive(!on);
    this.dyn?.setActive(!on);
    this.touch.setVisible(!on);
    this.propReveal?.setVisible(on);
    if (on) this.propReveal?.sync();
  }

  setView(mode: ViewMode): void {
    this.view = mode;
    this.player.setViewMode(mode === 'third' ? 'third' : 'first');
    // The top camera sits above the ceiling, so from up there the lit hall would be one grey
    // slab. Drop the roof for that view only; the lidar map never has this problem because an
    // unscanned ceiling is not drawn at all.
    this.hall.setRoofVisible(mode !== 'top');
  }

  private cycleView(): void {
    this.setView(this.view === 'player' ? 'third' : this.view === 'third' ? 'top' : 'player');
  }

  clearMap(): void {
    this.paint.clear();
    // The props hold their own mask, so forgetting the map has to forget them too — otherwise
    // "clear" leaves a hall full of remembered barrels, which is law 1 with extra steps.
    this.dyn?.clear();
    this.touch.clear();
    this.markers.clear();
  }

  private toggleGui(): void {
    if (this.gui !== null) {
      this.gui.destroy();
      this.gui = null;
      return;
    }
    const gui = new GUI({ title: 'lidar / perf' });
    this.gui = gui;
    const t = this.paint.tunables;
    const lidar = this.lidar.tunables;

    const shape = gui.addFolder('ping shape');
    shape.add(lidar, 'coneAngleDeg', 10, 180, 1);
    shape.add(lidar, 'coneRange', 5, 60, 1);
    shape.add(lidar, 'haloRange', 1, 20, 0.5);
    shape.add(lidar, 'waveSpeed', 8, 120, 1);
    shape.add(lidar, 'rechargeSeconds', 0.2, 20, 0.1);

    const cost = gui.addFolder('cost (the lag knobs)');
    cost.add(t, 'spacing', 0.08, 0.6, 0.01).onFinishChange(() => this.rebuildPaint());
    cost.add(t, 'segment', 0.1, 1, 0.05).onFinishChange(() => this.rebuildPaint());
    cost.add(t, 'pixelCap', 1, 24, 1).onChange(() => this.applyLook());
    cost.add(this.look, 'windowRadius', 5, 140, 1).onChange(() => this.applyLook());
    cost.add(t, 'chunkItems', 250, 20000, 250);
    cost.add(t, 'chunkMs', 0.5, 16, 0.5);
    cost.add(this.look, 'chunkGapMs', 0, 33, 1);
    cost.add(this.look, 'renderScale', 0.35, 1, 0.05).onChange(() => this.resize());

    const style = gui.addFolder('look');
    style.add(t, 'dotBright', 0, 2, 0.01).onChange(() => this.applyLook());
    style.add(t, 'dotSize', 0.01, 0.2, 0.005).onChange(() => this.applyLook());
    style.add(t, 'contourBright', 0, 3, 0.05).onChange(() => this.applyLook());
    style.add(t, 'ripple', 0, 0.3, 0.005).onChange(() => this.applyLook());
    style.add(this.look, 'refreshSeconds', 0, 2, 0.05).onChange(() => this.applyLook());
    style.close();

    const tactile = gui.addFolder('touch');
    tactile.add(this.touch.tunables, 'range', 0.2, 2, 0.05);
    tactile.add(this.touch.tunables, 'drop', 0, 1.6, 0.05);
    tactile.add(this.touch.tunables, 'nearAlpha', 0, 1, 0.02);
    tactile.add(this.touch.tunables, 'memoryAlpha', 0, 0.6, 0.01);
    tactile.close();

    const sound = gui.addFolder('sound markers');
    const m = this.markers.tunables;
    sound.add(m, 'life', 1, 20, 0.5).onChange(() => this.markers.applyLook());
    sound.add(m, 'pixelsAtOneMetre', 4, 80, 1).onChange(() => this.markers.applyLook());
    sound.add(m, 'minRadius', 2, 30, 1).onChange(() => this.markers.applyLook());
    sound.add(m, 'maxRadius', 10, 160, 2).onChange(() => this.markers.applyLook());
    sound.add(m, 'dotPixels', 1, 6, 0.2).onChange(() => this.markers.applyLook());
    sound.add(m, 'brightness', 0, 2, 0.05).onChange(() => this.markers.applyLook());
    sound.add(m, 'glitchSeconds', 0, 1.5, 0.05).onChange(() => this.markers.applyLook());
    sound.close();
  }

  private applyLook(): void {
    this.paint.applyLook(this.look.windowRadius, this.look.refreshSeconds, this.look.featherStart);
  }

  private rebuildPaint(): void {
    const t0 = performance.now();
    this.paint.rebuild();
    this.buildMs = performance.now() - t0;
    this.applyLook();
  }

  private resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const scale = this.look.renderScale;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * scale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.topCamera.aspect = w / h;
    this.topCamera.updateProjectionMatrix();
  }

  // ---- keyframe-generator surface -----------------------------------------

  /**
   * Everything `tools/shoot.mjs` is allowed to touch. The generator drives the simulation by
   * hand — fixed step, fixed seed, no wall clock anywhere — because a scenario that depends on
   * how fast the machine ran is not a proof of anything.
   */
  api(): Record<string, unknown> {
    return {
      seed: this.seed,
      boxes: this.hall.boxCount,
      buildMs: () => this.buildMs,
      step: (seconds: number) => {
        const n = Math.max(0, Math.round(seconds / this.loop.stepSeconds));
        for (let i = 0; i < n; i++) this.fixedUpdate(this.loop.stepSeconds);
      },
      draw: () => this.render(0),
      fire: () => {
        this.pendingFire = true;
      },
      pose: (x: number, z: number, yawDeg: number) => {
        this.player.setSpawn(new THREE.Vector3(x, 0, z), yawDeg);
        // The ping direction is read off the camera, so the camera has to already be there.
        this.player.applyToCamera(this.camera, 0);
      },
      aim: (yawDeg: number, pitchDeg = 0) => {
        this.player.setHeading(yawDeg, pitchDeg);
        this.player.applyToCamera(this.camera, 0);
      },
      keys: (down: string[], up: string[]) => {
        for (const code of down) window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        for (const code of up) window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      },
      lights: (on: boolean) => this.setLights(on),
      view: (mode: ViewMode) => this.setView(mode),
      topHeight: (h: number) => {
        this.topHeight = h;
      },
      topFocus: (x: number | null, z = 0) => {
        this.topFocus = x === null ? null : { x, z };
      },
      /** Every solid in the hall, as flat bounds — lets a scenario *find* its subject. */
      solids: () =>
        this.hall.world.boxes.map((b) => [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ]),
      touch: (on: boolean) => this.touch.setVisible(on),
      markers: (on: boolean) => this.markers.setVisible(on),
      radii: (on: boolean) => this.markers.setRadiusVisible(on),
      /** Debug: shove the clutter around a world point. Returns how many bodies woke up. */
      disturb: (x: number, y: number, z: number, radius: number, impulse: number) =>
        this.props?.disturb(x, y, z, radius, impulse) ?? 0,
      shove: () => this.shove(),
      /** Every prop as [archetype, x, y, z] — lets a scenario aim at a real object. */
      propList: () => {
        const p = this.props;
        if (p === null) return [];
        const out: Array<[string, number, number, number]> = [];
        for (let i = 0; i < p.count; i++) {
          out.push([
            ARCHETYPES[p.arch[i]!]!.name,
            p.pos[i * 3]!, p.pos[i * 3 + 1]!, p.pos[i * 3 + 2]!,
          ]);
        }
        return out;
      },
      clear: () => this.clearMap(),
      refill: () => this.lidar.refill(),
      hud: (on: boolean) => this.hudVisible(on),
      sync: (on: boolean) => {
        this.syncPaint = on;
      },
      stats: () => ({
        time: this.time,
        pos: this.player.position.toArray(),
        eye: this.player.eye.toArray(),
        lidar: this.lidar.state,
        paint: { ...this.paint.getStats() },
        diag: this.paint.diagnostics(),
        touch: this.touch.getStats(),
        marks: this.markers.getStats(),
        props: this.props?.getStats() ?? null,
        dyn: this.dyn?.getStats() ?? null,
        propsMs: this.propsMs,
        sound: { emitted: this.bus.emitted, last: this.bus.lastEvent },
        gate: Math.hypot(this.player.position.x - GATE_TARGET.x, this.player.position.z - GATE_TARGET.z),
        frameMs: this.perf,
        calls: this.renderer.info.render.calls,
      }),
      region: (b: number[]) =>
        this.paint.regionStats(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!),
    };
  }

  private hudVisible(on: boolean): void {
    document.querySelectorAll<HTMLElement>('.bs-hud').forEach((el) => {
      el.style.display = on ? '' : 'none';
    });
  }
}

const app = new App();
void app.start().then(() => {
  (window as unknown as Record<string, unknown>).bs = app.api();
});
