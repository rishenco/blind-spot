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
import { AudioStage, defaultAudioTunables } from './audio/audio';
import { renderAll as renderAudioScenes, phraseShapes } from './audio/offline';
import { Concussion, defaultConcussionTunables } from './fx/concussion';
import { SoundBus } from './events/bus';
import { Hud, type HelpRow } from './debug/hud';
import { Lidar, defaultLidarTunables } from './lidar/lidar';
import { StructuredPaint, defaultStructuredTunables } from './lidar/structured';
import { defaultAgeRamp } from './lidar/palette';
import { TouchLayer, defaultTouchTunables } from './touch/touch';
import { Carry, defaultCarryTunables } from './carry/carry';
import { HeldView, defaultHeldViewTunables } from './carry/heldview';
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
import { BodyUnion } from './lidar/bodies';
import { SpiderBodies } from './spiders/bodies';
import { ARCHETYPES } from './props/shapes';
import {
  MARKER_STYLES,
  SoundMarkers,
  defaultMarkerTunables,
  type MarkerStyle,
} from './sound/markers';
import { FIRE_MODES, Rifle, defaultRifleTunables, type FireMode, type Shot } from './weapon/rifle';
import { MuzzleFlash, defaultFlashTunables } from './weapon/flash';
import { RifleViewModel, defaultViewModelTunables } from './weapon/viewmodel';
import { ShotTracers } from './weapon/tracers';
import { Swarm, defaultSpiderTunables } from './spiders/swarm';
import { SpiderOverlay } from './spiders/overlay';
import { PlayerVitals, defaultVitalsTunables } from './hud/vitals';
import { Radio, defaultRadioTunables } from './radio/radio';
import { NoiseCompass, defaultCompassTunables } from './hud/compass';
import {
  PlayerHudLayer,
  defaultHudLayerTunables,
  screenAngle,
  HUD_STYLES,
  type CompassNotch,
  type HudStyle,
  type Instruments,
} from './hud/overlay';

type ViewMode = 'player' | 'third' | 'top';

const HELP: HelpRow[] = [
  { keys: 'W A S D', action: 'move' },
  { keys: 'Shift / Ctrl', action: 'run / crouch' },
  { keys: 'Space', action: 'jump, climb at a ledge' },
  { keys: 'F  or  RMB', action: 'lidar ping — cone forward + halo around you' },
  { keys: 'Q  or  LMB', action: 'shoot — flash, recoil, and the loudest noise in the hall' },
  { keys: 'R', action: 'reload — 3 seconds of being blind, useless and (quietly) audible' },
  { keys: 'E', action: 'left hand: pick up the nearest small thing / throw it where you look' },
  { keys: 'X', action: 'fire mode: auto / single' },
  { keys: 'Y', action: 'debug: hold the flash open (it lives 3 frames)' },
  { keys: 'U', action: 'debug: hitscan tracers — where the bullets really went' },
  { keys: 'L', action: 'debug: darkness off (lights on)' },
  { keys: 'V', action: 'debug: view — player / third / top' },
  { keys: 'T', action: 'radio power switch (picking it up is automatic, just walk over it)' },
  { keys: 'C', action: 'debug: touch layer on/off' },
  { keys: 'M', action: 'sound markers on/off' },
  { keys: 'N', action: 'debug: audibility radius of each sound event' },
  { keys: 'K', action: 'debug: clear the accumulated map' },
  { keys: 'B', action: 'debug: shove the clutter in front of you (make a mess)' },
  { keys: 'J', action: 'debug: refill the lidar' },
  { keys: 'G', action: 'debug: tuning panel' },
  { keys: 'O', action: 'noise compass on/off — bearings to noises you cannot see' },
  { keys: 'P', action: 'debug: spider overlay — state, goal, belief, above each spider' },
  { keys: 'I', action: 'debug: damage feedback (wedge, flinch, dark edge) on/off' },
  { keys: 'Z', action: 'debug: take a bite — from the nearest spider, else from behind' },
  { keys: 'Backspace', action: 'respawn (debug) · after death or the gate: restart, same seed' },
  { keys: 'Enter', action: 'after death or the gate: restart with a new seed' },
  { keys: 'H', action: 'this help' },
];

const HINT =
  'WASD move · Shift run · Ctrl crouch · F lidar ping · Q/LMB shoot · R reload · E take/throw · T radio · X fire mode · O compass · Y hold flash · P spiders · U tracers · L lights · V view · G tuning · H help';

/** Where the muzzle is relative to the eye, metres — matches the rifle's collider box. */
const MUZZLE_AHEAD = 0.55;
const MUZZLE_DROP = 0.14;
/** How close to `GATE_TARGET` counts as "reached it", metres. */
const GATE_REACH = 2.5;

/** How much of the loudness scale each thing the body does is worth, in metres of notice. */
const STEP_LOUDNESS: Record<string, number> = { crouch: 3, walk: 9, sprint: 16 };

interface Perf {
  simMs: number;
  paintMs: number;
  renderMs: number;
  frameMs: number;
}

/**
 * The camera's right axis, from its forward. World up is used as the reference, which is exactly
 * right for a first-person camera that never rolls; straight up or straight down would degenerate,
 * so those fall back to the yaw-only right vector.
 */
function rightOf(fx: number, _fy: number, fz: number): [number, number, number] {
  const rx = -fz;
  const rz = fx;
  const len = Math.hypot(rx, rz);
  if (len < 1e-4) return [1, 0, 0];
  return [rx / len, 0, rz / len];
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
  /** The left hand. Exists only once the prop world does — there is nothing to pick up before. */
  private carry: Carry | null = null;
  /** The contour of whatever is in the left hand. Built with the props, like the carry system. */
  private heldView: HeldView | null = null;
  /**
   * The sound layer. It listens to the bus and to nothing else, exactly as the concept demands:
   * it has no idea what physics or the player did, only that a noise happened at a point.
   */
  private readonly markers = new SoundMarkers(3072, defaultMarkerTunables());
  /**
   * The ear. A second, wholly independent bus subscriber: it knows nothing about the markers and
   * the markers know nothing about it, which is the point of routing every noise through the bus
   * in the first place. Silent until a key press starts the device, so the headless harness never
   * opens an AudioContext.
   */
  private readonly audio = new AudioStage(defaultAudioTunables());
  /**
   * Being concussed, on screen. A bus subscriber like everything else — the shot is not told
   * about it, it just happens to be the loudest thing on the bus. See `src/fx/concussion.ts`.
   */
  private readonly concussion = new Concussion(defaultConcussionTunables());
  private readonly player: PlayerController;
  /** Built after the wasm is up, so everything that touches them is null-guarded. */
  private props: PropWorld | null = null;
  private dyn: DynamicPaint | null = null;
  private propReveal: PropReveal | null = null;

  private readonly lights = new THREE.Group();
  private gui: GUI | null = null;

  /**
   * The rifle (M3). Built with the props, because a hitscan needs something to hit — the same
   * Rapier world the clutter lives in, so bullets and barrels share one truth.
   */
  private rifle: Rifle | null = null;
  /** The one real light in the game. Always in the scene; dark, and free, until a shot. */
  private readonly flash = new MuzzleFlash(defaultFlashTunables());
  /**
   * The gun in your hands (M4d). It is a child of the camera and it is lit by the flash and by
   * nothing else — with no flash in flight it is switched off, which is the only way a
   * viewmodel is allowed to exist under law 1.
   */
  private readonly rifleView = new RifleViewModel(defaultViewModelTunables());
  /** Debug overlay: where the hitscans actually went. Off by default (law 1). */
  private readonly tracers = new ShotTracers(64);
  /** Shots that left the barrel this tick. Reused; a burst is at most one round per tick. */
  private readonly shotBuf: Shot[] = [];

  /**
   * The pack (M4). Third consumer of the sound bus and the only one that acts on what it hears.
   * Built with the props so a panicking spider has something to throw about.
   */
  private spiders: Swarm | null = null;
  /** The mandatory M4 state overlay. Off by default; P toggles it. */
  private readonly spiderOverlay = new SpiderOverlay();
  /** True while the truth geometry is on screen because the flash is burning. */
  private flashRevealed = false;

  /**
   * The player's body and his own HUD (M5). The pack bites; this is what a bite costs and how
   * the player is told about it. All three parts switch off independently — the human judges
   * this by hand, with and without.
   */
  private readonly vitals = new PlayerVitals(defaultVitalsTunables());
  /** Fourth bus subscriber: bearings to noises whose marks are off-screen. Off by default. */
  private readonly compass = new NoiseCompass(this.bus, defaultCompassTunables());
  /**
   * M7 — the reason to go anywhere. A fifth bus emitter (not a subscriber): it pings the shared
   * bus like every other physical noise, and the marker layer / spider hearing pick it up with
   * zero changes of their own. See `src/radio/radio.ts` for the whole design.
   */
  private readonly radio = new Radio(defaultRadioTunables());
  /** The round (M7 "Раунд целиком"): a beginning, a wave timer, and exactly one of two endings. */
  private roundState: 'playing' | 'won' | 'dead' = 'playing';
  /** Slider-backed wave knobs — kept here because `spawn()` is the only public entry point
   *  `swarm.ts` offers, and it is destructive (see the task report's deviations section). */
  private readonly wave = { cap: 24, intervalS: 60, step: 6 };
  private nextWaveAt = 60;
  private readonly playerHud = new PlayerHudLayer(defaultHudLayerTunables());
  /** Rebuilt per frame from the live blips. Never grows past the compass's own capacity. */
  private readonly notches: CompassNotch[] = [];
  private readonly scratchProject = new THREE.Vector3();

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
    this.bus.subscribe((event) => this.audio.handle(event));
    this.bus.subscribe((event) => {
      if (event.source === 'gunshot') this.concussion.hit(event.time);
    });
    this.scene.add(this.markers.object);

    // Lights-on debug view. Off by default and, being a Group, costs nothing while it is.
    this.lights.add(new THREE.HemisphereLight(0xbfd4e6, 0x202428, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(0.4, 1, 0.25);
    this.lights.add(key);
    this.hall.reveal.visible = false;
    this.lights.visible = false;
    this.scene.add(this.hall.reveal, this.lights);

    /*
     * The flash. Concept: "единственный настоящий свет в игре… резкие тени".
     *
     * Shadows are switched on globally but their *auto* update is switched off: the flash is
     * pinned in space at the instant of the shot and the hall is a still life for the three
     * frames it burns, so exactly one cube-map render per shot is not a saving, it is the
     * correct number. `render()` asks the flash whether this is that frame.
     */
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.add(this.flash.object);
    this.scene.add(this.tracers.object);
    // The viewmodel is held in view space, so the camera has to be part of the graph for its
    // children to be drawn at all.
    this.scene.add(this.camera);
    this.camera.add(this.rifleView.object);
    this.hall.reveal.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });

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
    // The pack. Its own seed stream, so how long you survive cannot perturb the layout RNG.
    // Built before the lidar because the lidar scans spiders as bodies like any other.
    this.spiders = new Swarm(this.hall.world, this.bus, this.seed, defaultSpiderTunables());
    this.dyn = new DynamicPaint(
      // Clutter and spiders as one flat body list: spiders are matter, so they are scanned by
      // the same pass, with the same cloud mechanics, and the lidar knows nothing about them.
      new BodyUnion(this.props, new SpiderBodies(this.spiders)),
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
    // The third thing the hand can feel is the rifle it is holding — same channel, same switch.
    this.touch.attach(this.rifleView);
    this.propReveal = new PropReveal(this.props);
    this.propReveal.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    this.scene.add(this.propReveal.object);
    // The rifle gets the prop world as its hitscan target and a seed stream of its own, so how
    // much you shoot cannot perturb the layout RNG and break every other keyframe.
    this.rifle = new Rifle(this.bus, this.props, this.seed, defaultRifleTunables());
    this.carry = new Carry(this.props, defaultCarryTunables());
    // The fourth thing the hand can feel is whatever it picked up — same channel, same shader,
    // same switch as the rifle, because it is the same gesture.
    this.heldView = new HeldView(this.props, defaultHeldViewTunables());
    this.scene.add(this.heldView.object);
    this.touch.attach(this.heldView);
    this.propsMs = performance.now() - t0;

    this.spiders.setProps(this.props);
    /*
     * The contract with the pack, and the whole of it: a spider that lands a bite says so, with
     * where it was standing. Everything about health, direction and feedback is decided here,
     * outside the AI, so the swarm has no idea whether damage exists at all.
     */
    this.spiders.onStrike((strike) => {
      const p = this.player.position;
      this.vitals.bite(strike.x, strike.z, p.x, p.z, this.player.yaw);
    });
    this.scene.add(this.spiderOverlay.object, this.spiderOverlay.bodies);

    // Let the pile settle before anyone looks at it: laid-out props start a few millimetres
    // above their support and would otherwise be caught mid-drop on frame one.
    for (let i = 0; i < 90; i++) this.props.step(1 / 60, 0);
    this.props.settle();
    // Spawned after the clutter has settled, so nobody starts the game inside a barrel.
    this.spiders.spawn(undefined, this.player.position);
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
      // Whatever is in the left hand rides the camera the same way the rifle's collider does,
      // and for the same reason: it is a kinematic body in the world, not a picture.
      this.updateCarry(eye);
      // Before the step, so a bullet's impulse is resolved by the very tick it was fired on.
      this.updateWeapon(dt, eye);
      this.props.step(dt, this.time);
      this.dyn?.update(this.time);
      if (this.propReveal !== null && this.lightsOn) this.propReveal.sync();
    }

    if (this.spiders !== null) {
      const p = this.player.position;
      this.spiders.setPlayer(p.x, p.y, p.z);
      this.spiders.setPlayerAlive(this.vitals.alive);
      this.spiders.update(dt, this.time);
    }

    // M7 — the round. Everything below is a no-op once it has ended: the point of a death or a
    // win is that the black hall stops asking anything more of you until you restart.
    if (this.roundState === 'playing') {
      this.radio.update(dt, this.time, this.bus, this.player.position);

      // Reinforcements, roughly once a minute, capped and kept off the player's back. `spawn()`
      // is the swarm's only public entry point and it rebuilds the whole pack rather than adding
      // to it — see the report's deviations section for why a wave is a re-spawn here, not a
      // true reinforcement.
      if (this.spiders !== null && this.time >= this.nextWaveAt) {
        this.nextWaveAt = this.time + this.wave.intervalS;
        const st = this.spiders.tunables;
        st.count = Math.min(this.wave.cap, st.count + this.wave.step);
        this.spiders.spawn(st.count, this.player.position);
      }

      if (!this.vitals.alive) {
        this.roundState = 'dead';
      } else if (this.radio.carried) {
        const p = this.player.position;
        const dGate = Math.hypot(p.x - GATE_TARGET.x, p.z - GATE_TARGET.z);
        if (dGate < GATE_REACH) this.roundState = 'won';
      }
    }
    if (this.roundState === 'dead') {
      // Reused, not reinvented: the same pass the gunshot already drives, pinned above 1 every
      // tick so `advance()`'s exponential decay never gets a chance to run before the next pin.
      this.concussion.setLevel(1.6, this.time);
    }

    /*
     * The body. Its aim kick and its tremor move the *real* heading — being bitten costs you
     * your aim, not just a shake — so they are applied here, in the simulation, and clamped
     * exactly like mouse look. The flinch itself is render-only and lives in `render`.
     */
    this.vitals.update(dt, this.time);
    {
      const kick = this.vitals.consumeAimKick();
      const breath = this.vitals.tremor(dt);
      const dPitch = kick.pitch + breath.pitch;
      const dYaw = kick.yaw + breath.yaw;
      if (dPitch !== 0 || dYaw !== 0) {
        this.player.pitch += dPitch;
        this.player.yaw += dYaw;
        const clamp = (defaultCameraTunables().pitchClampDeg * Math.PI) / 180;
        if (this.player.pitch > clamp) this.player.pitch = clamp;
        if (this.player.pitch < -clamp) this.player.pitch = -clamp;
      }
    }

    this.touch.update(eye.x, eye.y, eye.z);

    this.audio.setSceneTime(this.time);

    this.input.endTick();
    this.perf.simMs = performance.now() - t0;
  }

  private hotkeys(): void {
    const i = this.input;
    // Browsers refuse to start an AudioContext outside a gesture, so the first key the player
    // presses — any key — is what turns the world audible.
    if (i.anyKeyPressed()) {
      this.audio.resume();
      this.radio.resume();
    }
    if (i.wasKeyPressed('KeyF')) this.pendingFire = true;
    if (i.wasKeyPressed('KeyL')) this.setLights(!this.lightsOn);
    if (i.wasKeyPressed('KeyV')) this.cycleView();
    // M7 took `T` for the radio's own switch (process.md: "геймплей важнее дебага"); the touch
    // debug toggle that used to live here moved to `C`, the one still-unused letter.
    if (i.wasKeyPressed('KeyT')) this.radio.toggle(this.time);
    if (i.wasKeyPressed('KeyC')) this.touch.setVisible(!this.touch.visible);
    if (i.wasKeyPressed('KeyM')) this.markers.setVisible(!this.markers.visible);
    if (i.wasKeyPressed('KeyN')) this.markers.setRadiusVisible(!this.markers.radiusVisible);
    if (i.wasKeyPressed('KeyK')) this.clearMap();
    if (i.wasKeyPressed('KeyB')) this.shove();
    if (i.wasKeyPressed('KeyJ')) this.lidar.refill();
    if (i.wasKeyPressed('KeyG')) this.toggleGui();
    if (i.wasKeyPressed('KeyH')) this.hud.toggleHelp();
    // M6a. `R` is the reload, because that is what `R` is in every shooter ever made; respawn —
    // a debug affordance, not a verb of the game — moved off it onto Backspace.
    if (i.wasKeyPressed('KeyR')) this.rifle?.beginReload();
    if (i.wasKeyPressed('KeyE')) this.toggleCarry();
    if (i.wasKeyPressed('Backspace')) {
      if (this.roundState === 'playing') {
        this.player.respawn();
        this.rifle?.resetRecoil();
        this.rifle?.refillMag();
        this.carry?.dropInPlace();
        this.vitals.reset();
        this.compass.clear();
      } else {
        // M7: dead or through the gate — same seed, so the hall you just learned is the hall
        // you get to try again on. A fresh App instance is the honest way to reset the wasm
        // world, the pack and the clutter together; a full reload is the least code that can do
        // it without three subsystems drifting out of sync with each other.
        this.restartRound(this.seed);
      }
    }
    if (i.wasKeyPressed('Enter') && this.roundState !== 'playing') {
      // A new seed is a fresh round's choice of layout, not simulation state — the same
      // exemption `process.md` already grants continuous audio playback its real-time clock.
      this.restartRound(Date.now() % 100000000);
    }
    if (i.wasKeyPressed('KeyX')) this.cycleFireMode();
    if (i.wasKeyPressed('KeyY')) this.flash.setHold(!this.flash.holding);
    if (i.wasKeyPressed('KeyU')) this.tracers.setVisible(!this.tracers.visible);
    if (i.wasKeyPressed('KeyP')) this.spiderOverlay.setVisible(!this.spiderOverlay.visible);
    if (i.wasKeyPressed('KeyO')) this.compass.enabled = !this.compass.enabled;
    if (i.wasKeyPressed('KeyI')) this.playerHud.showDamage = !this.playerHud.showDamage;
    if (i.wasKeyPressed('KeyZ')) this.biteMe();
  }

  /**
   * M7's restart. Full page reload rather than an in-place teardown: the wasm world, the pack,
   * the clutter and the round state would otherwise have to be reset in lock-step by hand, and
   * a stray leftover is exactly the kind of bug a "just reload" approach makes structurally
   * impossible. The seed becomes the URL's own `?seed=`, so "same seed" is simply not touching it.
   */
  private restartRound(seed: number): void {
    const url = new URL(location.href);
    url.searchParams.set('seed', String(seed));
    location.href = url.toString();
  }

  /**
   * The rifle's tick. Everything here is on the simulation clock and on the player's own heading
   * rather than on the render camera: the aim kick moves where you are *actually* pointing, and
   * a recoil that depended on frame rate would not survive the keyframe generator.
   */
  private updateWeapon(dt: number, eye: THREE.Vector3): void {
    const rifle = this.rifle;
    if (rifle === null) return;
    const i = this.input;

    // Heading → direction. Same convention as the camera (YXZ, forward is -Z at yaw 0).
    const cp = Math.cos(this.player.pitch);
    const fx = -Math.sin(this.player.yaw) * cp;
    const fy = Math.sin(this.player.pitch);
    const fz = -Math.cos(this.player.yaw) * cp;
    // The muzzle, roughly where the rifle's collider box ends. The flash has to be born out
    // there and not inside your own head, or the light is occluded by nothing at all.
    const mx = eye.x + fx * MUZZLE_AHEAD;
    const my = eye.y + fy * MUZZLE_AHEAD - MUZZLE_DROP;
    const mz = eye.z + fz * MUZZLE_AHEAD;

    this.shotBuf.length = 0;
    rifle.update(
      dt,
      i.isDown('fire'),
      i.wasPressed('fire'),
      mx, my, mz,
      fx, fy, fz,
      this.time,
      this.shotBuf,
    );

    // The kick moves the player's real heading. Clamped exactly like mouse look, so emptying a
    // magazine at the ceiling cannot flip you over backwards.
    const kick = rifle.consumeAimKick();
    if (kick.pitch !== 0 || kick.yaw !== 0) {
      this.player.pitch += kick.pitch;
      this.player.yaw += kick.yaw;
      const clamp = (defaultCameraTunables().pitchClampDeg * Math.PI) / 180;
      if (this.player.pitch > clamp) this.player.pitch = clamp;
      if (this.player.pitch < -clamp) this.player.pitch = -clamp;
    }

    for (const shot of this.shotBuf) {
      this.flash.trigger(shot.ox, shot.oy, shot.oz, shot.time);
      this.tracers.add(shot);
      // The rifle is a ray and knows nothing about spiders; the swarm owns its own hitboxes.
      this.spiders?.shoot(shot.ox, shot.oy, shot.oz, shot.ex, shot.ey, shot.ez);
    }
  }

  private cycleFireMode(): FireMode {
    const rifle = this.rifle;
    if (rifle === null) return 'auto';
    rifle.tunables.mode = rifle.tunables.mode === 'auto' ? 'single' : 'auto';
    return rifle.tunables.mode;
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

  /**
   * The left hand's tick: drive whatever is in it, from the camera's own basis.
   *
   * Runs before `props.step`, like `placeRifle`, so the held body's kinematic target is set for
   * the very step that is about to run and it never lags a tick behind the head.
   */
  private updateCarry(eye: THREE.Vector3): void {
    const carry = this.carry;
    if (carry === null) return;
    if (carry.takeChanged()) {
      // Standing still and picking something up has to make it felt *now*; the touch layer only
      // re-queries when the player moves, and the player has not.
      this.touch.poke();
    }
    if (carry.holding < 0) return;
    const f = this.scratchDir;
    this.camera.getWorldDirection(f);
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    const [rx, ry, rz] = rightOf(f.x, f.y, f.z);
    carry.update(eye.x, eye.y, eye.z, f.x, f.y, f.z, rx, ry, rz);
  }

  /**
   * One press of `E`. Empty hand takes the nearest thing small enough; full hand throws it where
   * you are looking. There is no third case and no held-to-charge: the human asked for two
   * presses and two presses is what makes it usable in the dark, where you cannot see a meter.
   */
  private toggleCarry(): 'picked' | 'thrown' | 'nothing' {
    const carry = this.carry;
    if (carry === null) return 'nothing';
    const eye = this.player.eye;
    const f = this.scratchDir;
    this.camera.getWorldDirection(f);
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    const [rx, ry, rz] = rightOf(f.x, f.y, f.z);
    return carry.toggle(eye.x, eye.y, eye.z, f.x, f.y, f.z, rx, ry, rz);
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
    /*
     * The view punch. Render-only and deliberately applied *after* the controller has posed the
     * camera: the shot has already moved where you are pointing (that is the aim kick, in the
     * simulation), and this is only the body flinching. Keeping the two apart is what makes it
     * possible to tune "it feels violent" without also tuning "it is unaimable".
     */
    const punch = this.rifle?.viewPunch;
    if (punch !== undefined && (punch.pitch !== 0 || punch.yaw !== 0 || punch.back !== 0)) {
      this.camera.rotation.x += punch.pitch;
      this.camera.rotation.y += punch.yaw;
      const f = this.camera.getWorldDirection(this.scratchDir);
      this.camera.position.addScaledVector(f, -punch.back);
      this.camera.updateMatrixWorld();
    }
    /*
     * The flinch from a bite. Same split as the rifle's punch and for the same reason: the aim
     * kick has already moved where you are *pointing* (in the simulation, a tick ago), and this
     * is only the head snapping round. Roll is included — a hit from the side turns the
     * shoulder, and it is the cheapest thing on screen that reads as a body rather than a
     * camera.
     */
    const hurt = this.vitals.viewPunch;
    if (hurt.pitch !== 0 || hurt.yaw !== 0 || hurt.roll !== 0) {
      this.camera.rotation.x += hurt.pitch;
      this.camera.rotation.y += hurt.yaw;
      this.camera.rotation.z += hurt.roll;
      this.camera.updateMatrixWorld();
    }
    // The ear rides the *render* camera, not the sim eye: it is the only place the smoothed head
    // orientation exists, and half a tick of lag in a pan is audible as a swim.
    {
      const c = this.camera;
      const f = c.getWorldDirection(this.scratchDir);
      this.audio.setEar(c.position.x, c.position.y, c.position.z);
      this.audio.setListener(c.position.x, c.position.y, c.position.z, f.x, f.y, f.z);
    }

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

    /*
     * The flash frame. The truth geometry — the same instanced boxes the `L` debug view uses —
     * is switched on for exactly as long as the light burns, and the cube shadow map is
     * re-rendered exactly once per shot. Nothing about this is on by default: with no flash in
     * flight the scene is the same black nothing it was in M1.
     */
    const envelope = this.flash.sample(renderTime);
    this.setFlashReveal(envelope > 0);
    /*
     * The rifle in your hands. Everything it needs is the flash's own light — the position it
     * was pinned at and the candela left in it this frame — so there is exactly one number that
     * decides whether a gun exists on screen, and it is the envelope. In the top and third-person
     * debug views it is switched off outright: a viewmodel seen from outside the head is a prop
     * floating in the hall, which is the very thing this must not become.
     */
    {
      const first = this.view === 'player';
      const gunPunch = this.rifle?.viewPunch;
      const lp = this.flash.light.position;
      const cp = this.camera.position;
      this.rifleView.update(
        first,
        first && this.lightsOn,
        first ? this.flash.light.intensity : 0,
        lp.x, lp.y, lp.z,
        cp.x, cp.y, cp.z,
        gunPunch?.pitch ?? 0, gunPunch?.back ?? 0,
      );
      // The radio, strapped to the handguard — same contour, same felt/solid gate `update()`
      // just computed. Its own method so no other caller of `update()` has to change.
      this.rifleView.setRadio(this.radio.carried, this.radio.indicator(renderTime), this.radio.blinkOn(renderTime));
      // And the thing in the other hand, drawn in the same tactile alphabet the rifle uses.
      this.heldView?.update(this.carry?.holding ?? -1, first);
    }
    this.renderer.shadowMap.needsUpdate = this.flash.takeShadowUpdate();

    if (this.spiders !== null) this.spiderOverlay.sync(this.spiders, camera);

    const renderStart = performance.now();
    // Through the concussion pass, which is a plain pass-through unless a round has just gone off.
    this.concussion.render(this.renderer, this.scene, camera, renderTime);
    this.perf.renderMs = performance.now() - renderStart;

    this.drawPlayerHud(renderTime, camera);

    this.perf.frameMs = performance.now() - frameStart;
    this.frameTimes.push(this.perf.frameMs);
    if (this.frameTimes.length > 240) this.frameTimes.shift();
    this.updateHud();
  }

  /**
   * The player's own HUD: bite wedges and the noise ring, drawn on a 2D canvas over the frame.
   *
   * The off-screen test is done here rather than inside the compass because this is the only
   * place that knows what the camera can see: every live blip is projected with the *active*
   * camera, and one whose mark is already in frame is dropped. The compass therefore never
   * repeats information the sound layer has already given — it only refuses to lose the half of
   * the room behind your head.
   */
  private drawPlayerHud(renderTime: number, camera: THREE.PerspectiveCamera): void {
    this.compass.setTime(renderTime);
    const c = this.compass.tunables;
    const notches = this.notches;
    notches.length = 0;
    if (this.compass.enabled) {
      const p = this.player.position;
      const yaw = this.camera.rotation.y;
      for (const b of this.compass.live) {
        const v = this.scratchProject.set(b.x, b.y, b.z).project(camera);
        const onScreen = v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95;
        if (c.offscreenOnly && onScreen) continue;
        // Loudness sets brightness and nothing sets distance: the set can honestly tell a bang
        // from a scratch, and it cannot tell you how far away either of them was.
        const loud = Math.min(1, b.loudness / Math.max(1, c.loudRef));
        const strength = this.compass.age(b) * (0.35 + 0.65 * loud);
        if (strength <= 0.02) continue;
        notches.push({
          angle: screenAngle(Math.atan2(b.x - p.x, b.z - p.z), yaw),
          strength,
          seq: b.seq,
          // Colour is identity, not quantity: red is "something alive that is not you", and it
          // is the compass's only hue. Keyed off the event's `source`, which is the field the
          // bus has always had; the swarm's newer `kind` ('chatter' | 'step' | 'bite' | 'death')
          // splits *spider* noises further and is deliberately not used here — every one of
          // them is still a spider, and that is the whole of what the ring is allowed to say.
          alien: NoiseCompass.alien(b.source),
          color: NoiseCompass.color(b.source),
        });
      }
    }
    this.playerHud.draw(this.vitals, this.camera.rotation.y, renderTime, notches, {
      radius: c.radius,
      widthDeg: c.widthDeg,
      thickness: c.thickness,
      brightness: c.brightness,
    }, this.instruments());
  }

  /**
   * The three things the kit is allowed to say about the player's own hands (M6a): rounds,
   * scanner, left hand. Assembled here because it is the only place that can see all three
   * devices; the HUD decides when any of it is worth drawing.
   */
  private instruments(): Instruments | null {
    const rifle = this.rifle;
    if (rifle === null) return null;
    const r = rifle.getStats();
    const l = this.lidar.state;
    return {
      rounds: r.rounds,
      magazine: r.magazine,
      reloading: r.reloading,
      reloadProgress: r.reloadProgress,
      scanCharge: l.progress,
      scanReady: l.ready,
      held: (this.carry?.holding ?? -1) >= 0,
    };
  }

  /** Debug: bite yourself. The nearest spider if there is one within earshot, else from behind. */
  private biteMe(): number {
    const p = this.player.position;
    // Two metres behind the head, in the camera's convention (forward is -Z at yaw 0).
    let fx = p.x + Math.sin(this.player.yaw) * 2;
    let fz = p.z + Math.cos(this.player.yaw) * 2;
    let best = Infinity;
    for (const s of this.spiders?.list() ?? []) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (d < best) {
        best = d;
        fx = s.x;
        fz = s.z;
      }
    }
    this.vitals.bite(fx, fz, p.x, p.z, this.player.yaw);
    return this.vitals.health;
  }

  /**
   * Shows or hides the lit truth of the hall for the duration of a flash.
   *
   * There is no second, prettier hall to light: these are the collider boxes themselves, so the
   * one frame you see really is the room you are about to walk into. While the debug lights are
   * on this does nothing — the geometry is already up and the flash simply adds to it.
   */
  private setFlashReveal(on: boolean): void {
    if (this.lightsOn || on === this.flashRevealed) return;
    this.flashRevealed = on;
    this.hall.reveal.visible = on;
    this.propReveal?.setVisible(on);
    // A spider caught in the muzzle flash is the whole point of the muzzle flash.
    this.spiderOverlay.setBodiesVisible(on);
    // Props move; the flash is an instant. Sync once, as the light comes up.
    if (on) this.propReveal?.sync();
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
    const audio = this.audio.getStats();
    const rifle = this.rifle?.getStats() ?? null;
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
      ['sound', `${this.bus.emitted} ev · step ${counts.get('player-step') ?? 0} · prop ${counts.get('prop-impact') ?? 0} · shot ${counts.get('gunshot') ?? 0} · hit ${counts.get('bullet-hit') ?? 0}`],
      ['view', this.lightsOn ? `${this.view} + lights` : this.view],
      [
        'rifle',
        rifle === null
          ? 'off'
          : `${this.rifle!.tunables.mode} · ${rifle.shots} shot / ${rifle.hits} hit · spread ${rifle.spreadDeg.toFixed(2)}°`,
      ],
      // M6a: the two things that can stop you acting — an empty magazine and a spent scanner —
      // and the one thing that changes what E does next.
      [
        'mag',
        rifle === null
          ? '-'
          : rifle.reloading
            ? `RELOADING ${(rifle.reloadProgress * 100) | 0}%`
            : `${rifle.rounds} / ${rifle.magazine}${rifle.rounds === 0 ? ' · EMPTY' : ''}`,
      ],
      [
        'hand',
        this.carry === null
          ? 'off'
          : this.carry.holding < 0
            ? `empty · ${this.carry.state.picks} taken / ${this.carry.state.throws} thrown`
            : `${this.carry.state.material} ${this.carry.state.mass.toFixed(1)} kg · #${this.carry.holding}`,
      ],
      [
        'recoil',
        rifle === null
          ? '-'
          : `pitch ${rifle.risePitchDeg.toFixed(2)}° yaw ${rifle.riseYawDeg.toFixed(2)}°`,
      ],
      [
        'pack',
        this.spiders === null
          ? 'off'
          : `${this.spiders.mode} · ${this.spiders.getStats().count} · courage ${this.spiders.getStats().meanCourage.toFixed(2)} · ${this.spiders.getStats().chatter.toFixed(1)} click/s`,
      ],
      [
        'vitals',
        !this.vitals.enabled
          ? 'immortal'
          : `${this.vitals.alive ? `${Math.ceil(this.vitals.health)} hp` : 'DOWN'} · ${this.vitals.bites} bites` +
            `${this.vitals.degrade > 0 ? ` · set ${(this.vitals.degrade * 100) | 0}% failing` : ''}` +
            `${this.compass.enabled ? ` · compass ${this.notches.length}/${this.compass.count}` : ' · compass off'}`,
      ],
      [
        'flash',
        `${this.flash.count} · ${(this.flash.envelope * 100) | 0}%${this.flash.holding ? ' · HELD' : ''}${this.tracers.visible ? ` · ${this.tracers.count} tracers` : ''}`,
      ],
      [
        'radio',
        !this.radio.carried
          ? 'on the floor · broadcasting'
          : `carried · ${this.radio.powered ? this.radio.indicator(this.time) : 'off'}`,
      ],
      ['round', `${this.roundState} · next wave ${Math.max(0, this.nextWaveAt - this.time).toFixed(0)}s · pack cap ${this.wave.cap}`],
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
      ['audio', audio.state === 'off' ? 'off (press a key)' : `${audio.state} · ${audio.active}/${this.audio.tunables.voices} voices · ${audio.dropped} dropped`],
      [
        'spiders',
        this.spiders === null
          ? 'off'
          : `${this.spiders.getStats().updateMs.toFixed(2)} ms · ${this.spiders.getStats().decisions} dec/tick`,
      ],
      ['calls', `${this.renderer.info.render.calls}`],
    ]);

    let prompt: string | null =
      this.harness || this.input.isCapturing ? null : 'click to capture the mouse';
    if (this.roundState === 'dead') {
      prompt = 'DOWN — Backspace: restart, same seed · Enter: restart, new seed';
    } else if (this.roundState === 'won') {
      prompt = 'THROUGH THE GATE — Backspace: restart, same seed · Enter: restart, new seed';
    }
    this.hud.setCapturePrompt(prompt);
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
    // The flash borrows the same meshes, so the two owners of "is the truth visible" have to
    // agree on the answer when the debug switch moves.
    this.flashRevealed = on;
    this.hall.reveal.visible = on;
    this.lights.visible = on;
    this.paint.setActive(!on);
    this.dyn?.setActive(!on);
    this.touch.setVisible(!on);
    this.propReveal?.setVisible(on);
    this.spiderOverlay.setBodiesVisible(on);
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
    // Fronts already in flight would land after the wipe and repaint what was just forgotten.
    this.lidar.flush();
    this.paint.clear();
    // The props hold their own mask, so forgetting the map has to forget them too — otherwise
    // "clear" leaves a hall full of remembered barrels, which is law 1 with extra steps.
    this.dyn?.clear();
    this.touch.clear();
    this.markers.clear();
    // The tracer overlay is a memory of where rounds went, so "forget the map" has to forget it
    // too — otherwise a wiped hall still has last minute's burst drawn across it.
    this.tracers.clear();
  }

  private toggleGui(): void {
    if (this.gui !== null) {
      this.gui.destroy();
      this.gui = null;
      return;
    }
    const gui = new GUI({ title: 'lidar / perf' });
    this.gui = gui;
    /*
     * The GUI needs no key relay of its own any more.
     *
     * It used to re-dispatch key events on the window, because lil-gui calls stopPropagation()
     * inside its controllers — but that only ever fixed half of the reported bug ("когда
     * настройки трогаешь, если не кликать ещё юай, то видимо перехват WASD отрубается"): a
     * number widget is a real <input> that keeps focus after you drag its slider, and the relay
     * deliberately bailed out on fields being typed into, so WASD went on being typed into the
     * box. The fix now lives one level down, in `Input`: it listens in the capture phase (so
     * stopPropagation cannot reach it) and blurs a focused field the moment a *game* key
     * arrives, while digits and arrows still reach the box. See src/core/input.ts.
     */
    const t = this.paint.tunables;
    const lidar = this.lidar.tunables;

    const shape = gui.addFolder('ping shape');
    shape.add(lidar, 'coneAngleDeg', 10, 180, 1);
    shape.add(lidar, 'coneRange', 5, 60, 1);
    shape.add(lidar, 'haloRange', 1, 20, 0.5);
    shape.add(lidar, 'waveSpeed', 8, 120, 1);
    shape.add(lidar, 'rechargeSeconds', 0.2, 20, 0.1);
    shape.add(lidar, 'charges', 1, 4, 1).name('charges held');

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
    // The look is undecided on purpose: four different answers, switched here by hand. See the
    // header of src/sound/markers.ts for what each one is arguing.
    sound
      .add(m, 'style', MARKER_STYLES as unknown as string[])
      .onChange((v: MarkerStyle) => this.markers.setStyle(v));
    sound.add(m, 'life', 1, 20, 0.5).onChange(() => this.markers.applyLook());
    sound.add(m, 'scale', 40, 600, 5).onChange(() => this.markers.applyLook());
    sound.add(m, 'loudRef', 3, 26, 0.5).onChange(() => this.markers.applyLook());
    sound.add(m, 'loudPower', 0.6, 2.4, 0.05).onChange(() => this.markers.applyLook());
    sound.add(m, 'minRadius', 2, 40, 1).onChange(() => this.markers.applyLook());
    sound.add(m, 'maxRadius', 40, 900, 10).onChange(() => this.markers.applyLook());
    sound.add(m, 'spread', 30, 600, 5).onChange(() => this.markers.applyLook());
    sound.add(m, 'softness', 0.6, 6, 0.1).onChange(() => this.markers.applyLook());
    sound.add(m, 'brightness', 0, 2, 0.05).onChange(() => this.markers.applyLook());
    // M6a: «большие области шума не должны уходить в белый». `peak` is the ceiling one
    // mark may reach; `capOverlap` decides whether two overlapping marks add up past it
    // (the old additive look) or stop at the brighter of the two.
    sound.add(m, 'peak', 0.15, 1, 0.01).name('ceiling (below white)').onChange(() => this.markers.applyLook());
    sound.add(m, 'capOverlap').name('overlap: max, not sum').onChange(() => this.markers.applyLook());
    sound.open();

    /*
     * The rifle and the flash. The human asked for two of these knobs by name: the flash's
     * lifetime ("вынеси в настройки да, тут надо прочувствовать" — the difference between two
     * and six frames is the difference between a blink and reading the room) and the fire mode
     * ("хз, тоже в настройки давай"). Both ranges are deliberately wider than any sane value.
     */
    const gun = gui.addFolder('rifle / flash');
    const r = this.rifle?.tunables ?? defaultRifleTunables();
    const fl = this.flash.tunables;
    gun.add(r, 'mode', FIRE_MODES as unknown as string[]);
    gun.add(r, 'rpm', 120, 1100, 10);
    // M6a: the magazine is the brake on «бесконечно себе светить». Reload is loud, but
    // much quieter than the shot that made you need it.
    gun.add(r, 'magazine', 1, 60, 1).name('magazine, rounds');
    gun.add(r, 'reloadSeconds', 0.5, 8, 0.1).name('reload, seconds');
    gun.add(r, 'reloadLoudness', 0, 60, 1).name('reload loudness (m)');
    gun.add({ reload: () => { this.rifle?.beginReload(); } }, 'reload').name('reload now (R)');
    gun.add(fl, 'life', 0.008, 0.5, 0.002);
    gun.add(fl, 'intensity', 20, 2000, 5);
    gun.add(fl, 'range', 8, 120, 1);
    gun.add(fl, 'decay', 0.5, 6, 0.1);
    gun.add(fl, 'shadows');
    gun.add(fl, 'shadowSize', [128, 256, 512, 1024]).onChange(() => this.flash.applyShadowSize());
    gun.add(fl, 'flareSize', 0, 2, 0.05);
    gun.add(fl, 'flareGain', 0, 4, 0.05);
    /*
     * The weight of the shot. The human asked for "чуть потяжелее" and the two halves of that
     * are deliberately separate knobs: `rise*` really moves where the barrel points and is the
     * price he pays, `punch*` is only the body flinching and is free. Both are here so he can
     * find the line between them by hand rather than by argument.
     */
    gun.add(r, 'risePitchDeg', 0, 3, 0.02).name('aim kick: pitch (the price)');
    gun.add(r, 'riseYawDeg', 0, 2, 0.02).name('aim kick: yaw');
    gun.add(r, 'recoverRate', 1, 40, 0.5);
    gun.add(r, 'recoverDelay', 0, 0.5, 0.01);
    gun.add(r, 'recoverFraction', 0, 1, 0.02).name('how much comes back');
    gun.add(r, 'punchPitchDeg', 0, 6, 0.1).name('view punch: pitch');
    gun.add(r, 'punchYawDeg', 0, 3, 0.05).name('view punch: yaw');
    gun.add(r, 'punchBackM', 0, 0.3, 0.005).name('view punch: shove back');
    gun.add(r, 'punchDecay', 2, 40, 0.5);
    gun.add(r, 'spreadPerShot', 0, 2, 0.02);
    gun.add(r, 'gunshotLoudness', 10, 200, 1);
    gun.add(r, 'hitImpulse', 0, 30, 0.5);
    // The mesh in your hands. `visible` is a measuring switch, not a play switch: the gun is
    // already invisible whenever nothing is lighting it.
    const vm = this.rifleView.tunables;
    gun.add(vm, 'visible').name('rifle mesh');
    gun.add(vm, 'albedo', 0, 1, 0.02).onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'gain', 0, 0.03, 0.0005);
    gun.add(vm, 'exposure', 0.2, 5, 0.05).onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'rim', 0, 2, 0.05).onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'feel', 0, 6, 0.05).name('by touch: how bright');
    gun.add(vm, 'feelEdge', 0.5, 6, 0.1).name('by touch: contour vs body').onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'wrap', 0, 2, 0.05).onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'kickBack', 0, 3, 0.05).name('mesh kick: back');
    gun.add(vm, 'kickPitch', 0, 3, 0.05).name('mesh kick: pitch');
    gun.add(vm, 'ahead', 0.3, 1.6, 0.02).name('hold: out in front').onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'drop', -0.2, 0.8, 0.01).name('hold: below the eye').onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'side', -0.6, 0.6, 0.01).name('hold: off to the right').onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'cant', -0.8, 0.8, 0.01).name('hold: to the shoulder').onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'tilt', -0.6, 0.6, 0.01).name('hold: below the sight line').onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'roll', -0.6, 0.6, 0.01).name('hold: roll').onChange(() => this.rifleView.applyLook());
    gun.add(vm, 'scale', 0.2, 1.4, 0.02).name('hold: size').onChange(() => this.rifleView.applyLook());
    gun.open();

    /*
     * The player's own HUD. Everything here is a switch because the human judges it by hand and
     * has to be able to see the frame with and without: `damage` makes him immortal again,
     * `compass` is the argument of the milestone, and `health` is a slider so the degraded set
     * can be looked at without being bitten seven times first.
     */
    const me = gui.addFolder('player / hud');
    const vt = this.vitals.tunables;
    /*
     * The look is undecided on purpose, exactly as with the marker styles: four different
     * theories of what a HUD *is* in this game, judged by eye and not by argument. See the
     * header of src/hud/overlay.ts for what each one claims and for what was wrong with `ring`.
     */
    me.add(this.playerHud.tunables, 'style', HUD_STYLES as unknown as string[])
      .name('look')
      .onChange((v: HudStyle) => this.playerHud.setStyle(v));
    me.add(this.vitals, 'enabled').name('damage');
    me.add(this.vitals, 'effects').name('flinch');
    me.add(this.playerHud, 'showDamage').name('wedge + dark edge');
    me.add({ health: this.vitals.health }, 'health', 0, vt.maxHealth, 1)
      .listen()
      .onChange((v: number) => this.vitals.setHealth(v));
    me.add({ bite: () => this.biteMe() }, 'bite').name('bite me (Z)');
    me.add({ heal: () => this.vitals.reset() }, 'heal').name('patch up');
    me.add(vt, 'biteDamage', 1, 50, 1);
    me.add(vt, 'regenRate', 0, 10, 0.1);
    me.add(vt, 'punchPitchDeg', 0, 12, 0.1);
    me.add(vt, 'punchRollDeg', 0, 12, 0.1);
    me.add(vt, 'kickDeg', 0, 8, 0.1);
    me.add(vt, 'tremorDeg', 0, 4, 0.05);
    me.add(vt, 'lowHealth', 0, 1, 0.05);
    me.add(vt, 'markLife', 0.4, 8, 0.1);
    me.add(this.playerHud.tunables, 'lagPx', 0, 1600, 20).name('flinch lag (px/rad)');
    me.add(this.playerHud.tunables, 'refreshHz', 1, 20, 0.5).name('sonar refresh');
    me.add(this.playerHud.tunables, 'sectors', 8, 96, 1).name('sonar sectors');
    me.add(this.playerHud.tunables, 'brightness', 0, 2, 0.05);
    me.add(this.playerHud.tunables, 'wedgeRadius', 0.15, 1, 0.01).name('ring: radius');
    me.add(this.playerHud.tunables, 'stingDark', 0, 1, 0.02);
    me.add(this.playerHud.tunables, 'lowDark', 0, 1, 0.02);
    // M6a instruments: rounds, scanner, left hand. They live inside the sonar readout and
    // fade out again, so the screen is black by default and speaks only when something changed.
    me.add(this.playerHud.tunables, 'instBright', 0, 2, 0.05).name('instruments: bright');
    me.add(this.playerHud.tunables, 'instHold', 0, 8, 0.1).name('instruments: hold, s');
    me.add(this.playerHud.tunables, 'instSpan', 0.2, 1, 0.02).name('instruments: width');
    me.add(this.playerHud.tunables, 'instDrop', 0.4, 0.95, 0.01).name('instruments: height');
    me.open();

    // M6a — the left hand. Thresholds are the whole design question here: a can yes, a
    // barrel no, and where exactly the line falls is his to find.
    if (this.carry !== null) {
      const hand = gui.addFolder('left hand (M6a)');
      const c = this.carry.tunables;
      hand.add(c, 'reach', 0.5, 5, 0.1).name('reach, m');
      hand.add(c, 'maxMass', 0.2, 40, 0.2).name('max mass, kg');
      hand.add(c, 'maxSpan', 0.1, 2, 0.02).name('max size, m');
      hand.add(c, 'throwSpeed', 2, 30, 0.5).name('throw speed, m/s');
      hand.add(c, 'throwLoftDeg', -10, 30, 0.5).name('throw loft, deg');
      hand.add(c, 'throwSpin', 0, 30, 0.5).name('throw spin');
      hand.add(c, 'holdForward', 0.1, 1.2, 0.02).name('hold: out in front');
      hand.add(c, 'holdLeft', 0, 0.8, 0.02).name('hold: off to the left');
      hand.add(c, 'holdDrop', 0, 0.8, 0.02).name('hold: below the eye');
      if (this.heldView !== null) {
        hand.add(this.heldView.tunables, 'bright', 0, 3, 0.05).name('contour brightness');
        hand.add(this.heldView.tunables, 'visible').name('draw the contour');
      }
      hand.add({ drop: () => { this.carry?.dropInPlace(); } }, 'drop').name('put it down');
      hand.close();
    }

    // M6b — the spiders' own knobs. «Радиус в тюнеры — человек будет щупать сам.»
    if (this.spiders !== null) {
      const sp = gui.addFolder('spiders (M6b)');
      const st = this.spiders.tunables;
      sp.add(st, 'smellRange', 0, 8, 0.1).name('nose radius, m');
      sp.add(st, 'smellRise', 0.5, 6, 0.1).name('nose height, m');
      sp.add(st, 'hopDistance', 0.5, 5, 0.1).name('hop length, m');
      sp.add(st, 'hopRise', 0.5, 6, 0.1).name('hop up to, m');
      sp.add(st, 'hopArc', 0.1, 3, 0.05).name('hop apex, m');
      sp.add(st, 'restCalm', 0, 3, 0.05).name('freeze calm, s');
      sp.add(st, 'restHot', 0, 1.5, 0.02).name('freeze rushing, s');
      sp.add(st, 'clickSlow', 1, 20, 0.5).name('click gap, listening');
      sp.add(st, 'clickFast', 0.05, 3, 0.05).name('click gap, attacking');
      sp.add(st, 'clickCloseRange', 0, 20, 0.5).name('loud only within, m');
      sp.close();
    }

    const cp = gui.addFolder('noise compass');
    const ct = this.compass.tunables;
    cp.add(this.compass, 'enabled').name('compass (O)');
    cp.add(ct, 'offscreenOnly').name('off-screen only');
    cp.add(ct, 'life', 0.3, 8, 0.1);
    cp.add(ct, 'loudRef', 3, 60, 1);
    cp.add(ct, 'minLoudness', 0, 12, 0.5);
    cp.add(ct, 'radius', 0.3, 1.1, 0.01);
    cp.add(ct, 'widthDeg', 2, 40, 1);
    cp.add(ct, 'thickness', 1, 12, 0.5);
    cp.add(ct, 'brightness', 0, 2, 0.05);
    cp.open();

    const ear = gui.addFolder('audio');
    ear.add(this.audio.tunables, 'volume', 0, 1, 0.02).onChange((v: number) => this.audio.setVolume(v));
    ear.add(this.audio.tunables, 'maxLatency', 0.05, 1, 0.05);
    // The shot's aftermath, tuned by ear: how far the hall drops behind the blast and how long
    // it takes to climb back.
    ear.add(this.audio.tunables, 'deafDepth', 0, 1, 0.02);
    ear.add(this.audio.tunables, 'deafSeconds', 0, 2, 0.05);
    ear.add(this.audio.tunables, 'deafCutoff', 150, 8000, 10);
    ear.add(this.audio.tunables, 'tinnitus', 0, 0.2, 0.005);
    ear.add(this.audio.tunables, 'tinnitusSeconds', 0.5, 12, 0.5);
    ear.add(this.audio.tunables, 'tinnitusFreq', 1200, 8000, 50);
    ear.close();

    // The other half of the same concussion: how long the frame stays unwell and how badly.
    const cc = gui.addFolder('concussion (view)');
    const ct2 = this.concussion.tunables;
    cc.add(ct2, 'enabled');
    cc.add(ct2, 'seconds', 0.5, 12, 0.5);
    cc.add(ct2, 'strength', 0, 1, 0.02);
    cc.add(ct2, 'wobble', 0, 0.08, 0.002);
    cc.add(ct2, 'tear', 0, 0.15, 0.005);
    cc.add(ct2, 'tearRows', 0, 0.6, 0.02);
    cc.add(ct2, 'grain', 0, 1, 0.02);
    cc.add(ct2, 'vignette', 0, 1, 0.02);
    cc.add(ct2, 'pulse', 0.2, 8, 0.1);
    cc.add(ct2, 'ghost', 0, 0.5, 0.02);
    cc.close();

    // M7 — the radio and the round it turns the prototype into.
    const rd = gui.addFolder('radio (M7)');
    const rt = this.radio.tunables;
    rd.add(rt, 'pickupRadius', 0.2, 3, 0.1).name('pickup radius, m');
    rd.add(rt, 'captureSeconds', 0.2, 8, 0.1).name('switch-on delay, s');
    rd.add(rt, 'pingInterval', 0.1, 3, 0.05).name('ping interval, s');
    rd.add(rt, 'groundLoudness', 5, 90, 1).name('ground ping, m of notice');
    rd.add(rt, 'carryLoudness', 5, 120, 1).name('carried ping, m of notice');
    rd.add(rt, 'clarityNear', 0, 30, 0.5).name('clear inside, m from gate');
    rd.add(rt, 'clarityFar', 10, 90, 1).name('pure noise beyond, m from gate');
    rd.add(rt, 'blinkHz', 0.5, 6, 0.1).name('indicator blink rate');
    rd.add(rt, 'noiseGain', 0, 0.3, 0.005).name('hiss volume');
    rd.add(rt, 'melodyGain', 0, 0.3, 0.005).name('melody volume');
    rd.add(this.wave, 'cap', 4, 60, 1).name('spider pop. cap');
    rd.add(this.wave, 'intervalS', 10, 180, 5).name('wave interval, s');
    rd.add(this.wave, 'step', 1, 20, 1).name('spiders added per wave');
    rd.close();
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
    this.playerHud.resize();
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
      /**
       * The *lidar* ping. Kept under this name on purpose: every M1/M2 scenario in the frame
       * generator already calls `bs.fire()` meaning "ping", and quietly turning that into a
       * gunshot would rewrite the meaning of a dozen existing keyframes. The rifle is `shoot()`.
       */
      fire: () => {
        this.pendingFire = true;
      },
      /** One round, right now, from wherever the player is pointing. Returns the trace. */
      shoot: () => {
        const rifle = this.rifle;
        if (rifle === null) return null;
        const eye = this.player.eye;
        const cp = Math.cos(this.player.pitch);
        const fx = -Math.sin(this.player.yaw) * cp;
        const fy = Math.sin(this.player.pitch);
        const fz = -Math.cos(this.player.yaw) * cp;
        this.shotBuf.length = 0;
        // The edge and the hold are both asserted, and the cooldown is cleared, so a scenario
        // gets exactly one round per call in either fire mode regardless of the cyclic rate.
        rifle.forceReady();
        rifle.update(
          this.loop.stepSeconds, true, true,
          eye.x + fx * MUZZLE_AHEAD, eye.y + fy * MUZZLE_AHEAD - MUZZLE_DROP, eye.z + fz * MUZZLE_AHEAD,
          fx, fy, fz,
          this.time,
          this.shotBuf,
        );
        const kick = rifle.consumeAimKick();
        this.player.pitch += kick.pitch;
        this.player.yaw += kick.yaw;
        for (const shot of this.shotBuf) {
          this.flash.trigger(shot.ox, shot.oy, shot.oz, shot.time);
          this.tracers.add(shot);
          this.spiders?.shoot(shot.ox, shot.oy, shot.oz, shot.ex, shot.ey, shot.ez);
        }
        return this.shotBuf.length > 0 ? { ...this.shotBuf[0]! } : null;
      },
      /** Holds the trigger down / lets it go, so a scenario can fire an honest burst. */
      trigger: (on: boolean) => {
        window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code: 'KeyQ' }));
      },
      fireMode: (mode?: FireMode) => {
        const rifle = this.rifle;
        if (rifle === null) return 'auto';
        if (mode !== undefined) rifle.tunables.mode = mode;
        return rifle.tunables.mode;
      },
      /** Debug: freeze the flash at full so a three-frame event can be photographed. */
      flashHold: (on: boolean) => {
        this.flash.setHold(on);
        return this.flash.holding;
      },
      /** Live flash knobs — the keyframe pass measures what the expensive ones cost. */
      flashTune: (patch: Partial<Record<string, number | boolean>>) => {
        Object.assign(this.flash.tunables, patch);
        if ('shadowSize' in patch) this.flash.applyShadowSize();
        return { ...this.flash.tunables };
      },
      rifleTune: (patch: Partial<Record<string, number | string>>) => {
        if (this.rifle === null) return null;
        Object.assign(this.rifle.tunables, patch);
        return { ...this.rifle.tunables };
      },
      /** M6a: rounds left, whether a reload is running, and how far along it is. */
      ammo: () => {
        const st = this.rifle?.getStats() ?? null;
        if (st === null) return null;
        return {
          rounds: st.rounds,
          magazine: st.magazine,
          reloading: st.reloading,
          reloadProgress: st.reloadProgress,
          ready: st.ready,
        };
      },
      /** Leave exactly n rounds in the gun — how a scenario photographs an empty magazine. */
      setRounds: (n: number) => {
        this.rifle?.setRounds(n);
        return this.rifle?.getStats().rounds ?? 0;
      },
      /** Start a reload the way R does. False when it is already running or the mag is full. */
      reload: () => this.rifle?.beginReload() ?? false,
      /** The left hand, exactly as E drives it: take the nearest small thing, or throw it. */
      hand: () => {
        const c = this.carry;
        if (c === null) return null;
        const st = c.state;
        return {
          held: c.holding,
          material: st.material,
          mass: st.mass,
          picks: st.picks,
          throws: st.throws,
          lastThrow: [st.lastThrowX, st.lastThrowY, st.lastThrowZ] as [number, number, number],
          /** Which prop the tactile contour is actually drawing this frame, or -1. */
          contour: this.heldView?.drawing ?? -1,
        };
      },
      /*
       * One press of E, applied now rather than queued as a key event: the generator wants the
       * answer in the same call ("did it take anything?"), and a dispatched KeyE would only be
       * read on the next fixed tick.
       */
      handToggle: () => {
        this.toggleCarry();
        return this.carry?.holding ?? -1;
      },
      /** Put whatever is in the hand back on the floor without throwing it. */
      handDrop: () => {
        this.carry?.dropInPlace();
        return this.carry?.holding ?? -1;
      },
      /** Debug/keyframes: the rifle mesh on or off, to measure what it adds to a flash frame. */
      viewmodel: (on?: boolean) => {
        if (on !== undefined) this.rifleView.tunables.visible = on;
        return this.rifleView.tunables.visible;
      },
      viewmodelTune: (patch: Partial<Record<string, number | boolean>>) => {
        Object.assign(this.rifleView.tunables, patch);
        this.rifleView.applyLook();
        return { ...this.rifleView.tunables };
      },
      tracers: (on: boolean) => {
        this.tracers.setVisible(on);
        return this.tracers.visible;
      },
      /** Every recent trace, muzzle → impact, for scenarios that check where rounds landed. */
      shotList: () => this.rifle?.recentShots.map((sh) => ({ ...sh })) ?? [],
      /**
       * `y` is optional and defaults to the floor, which is every existing call. M6b needs the
       * player standing on top of a cupboard — the one place the pack was not supposed to be able
       * to reach — and there is no other way to get him up there deterministically.
       */
      pose: (x: number, z: number, yawDeg: number, y = 0) => {
        // A teleport is not a shooting stance: drop the climb the last burst left in the body,
        // or every scenario inherits the drift of the one before it.
        this.rifle?.resetRecoil();
        // Same argument for the magazine and for the left hand: a scenario that teleports must
        // not inherit the ammunition — or the can — that the previous scenario left behind.
        this.rifle?.refillMag();
        this.carry?.dropInPlace();
        // M7: a scenario that teleports must not inherit whether a previous step picked up or
        // switched on the radio — same reasoning as the mag refill and the dropped can above it.
        this.radio.reset();
        this.player.setSpawn(new THREE.Vector3(x, y, z), yawDeg);
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
      /*
       * The rifle in his own hands, on/off. A measuring switch for the keyframe generators, not
       * a play switch: the gun is drawn in the bottom-right corner of every first-person frame,
       * it is the *touch* channel and not the sound layer, and its felt contour resamples every
       * draw — so any photometric A/B pair ("with the wedge / without it", "sound layer off ⇒
       * black") differs by the gun unless it can be taken out of the picture.
       */
      rifleMesh: (on: boolean) => {
        this.rifleView.tunables.visible = on;
        return on;
      },
      audio: (on: boolean) => this.audio.setEnabled(on),
      /**
       * Offline proof of the mixer: renders the fixed audio scenes through the same synthesis
       * the player hears and hands back WAVs. `tools/audio.mjs` is the only caller. Needs no
       * device and no gesture, and touches nothing in the simulation.
       */
      audioRender: (opts?: Record<string, unknown>) => renderAudioScenes(opts ?? {}),
      /** Onsets of the pack's phrases, for the rhythm check in `tools/audio.mjs`. */
      audioPhrases: (count?: number) => phraseShapes(count),
      /** The visual half of the concussion, for `tools/concussion.mjs` and for tuning by hand. */
      concussion: {
        state: () => ({
          charge: this.concussion.charge,
          amount: this.concussion.amount(this.time),
          frames: this.concussion.rendered,
          ...this.concussion.tunables,
        }),
        tune: (patch: Partial<Record<string, number | boolean>>) => {
          Object.assign(this.concussion.tunables, patch);
          return { ...this.concussion.tunables };
        },
        /** Force a level and hold it there, so a still frame can be photographed. */
        set: (level: number) => {
          this.concussion.setLevel(level, this.time);
          return this.concussion.charge;
        },
      },
      /** M7. `tools/radio.mjs`'s whole surface: pickup/switch state and the clarity numbers. */
      radio: {
        state: () => {
          const pos = this.radio.position(this.player.position);
          return {
            carried: this.radio.carried,
            powered: this.radio.powered,
            indicator: this.radio.indicator(this.time),
            clarity: this.radio.lastComputedClarity,
            position: pos.toArray(),
            distanceToGate: Math.hypot(pos.x - GATE_TARGET.x, pos.z - GATE_TARGET.z),
          };
        },
        /** Clarity as a pure function of a world point — for the "gate vs. far corner" numbers,
         *  without having to actually walk the player there first. */
        clarityAt: (x: number, z: number) => this.radio.clarity(new THREE.Vector3(x, 0, z)),
        toggle: () => {
          this.radio.toggle(this.time);
          return this.radio.powered;
        },
        setCarried: (on: boolean) => {
          this.radio.setCarried(on);
          return this.radio.carried;
        },
        tune: (patch: Partial<Record<string, number>>) => {
          Object.assign(this.radio.tunables, patch);
          return { ...this.radio.tunables };
        },
      },
      /** M7. The round machine itself: state, the wave clock and the two restart forms. */
      round: {
        state: () => this.roundState,
        wave: () => ({ ...this.wave, nextAt: this.nextWaveAt, count: this.spiders?.tunables.count ?? 0 }),
        tune: (patch: Partial<typeof this.wave>) => {
          Object.assign(this.wave, patch);
          return { ...this.wave };
        },
        /** Force a result, for scenarios that need to photograph the ending without playing
         *  the whole round to reach it. */
        force: (state: 'playing' | 'won' | 'dead') => {
          this.roundState = state;
          return this.roundState;
        },
        /** The URL a restart would navigate to — read, never navigated, so a keyframe run can
         *  check the seed logic without actually leaving the page mid-scenario. */
        restartUrl: (sameSeed: boolean) => {
          const url = new URL(location.href);
          url.searchParams.set('seed', String(sameSeed ? this.seed : 0));
          return url.toString();
        },
      },
      audioTune: (patch: Partial<Record<string, number>>) => {
        Object.assign(this.audio.tunables, patch);
        if ('volume' in patch) this.audio.setVolume(this.audio.tunables.volume);
        return { ...this.audio.tunables };
      },
      markers: (on: boolean) => this.markers.setVisible(on),
      radii: (on: boolean) => this.markers.setRadiusVisible(on),
      /** Which of the four looks to draw the marks in. Free to switch: it is one uniform. */
      markerStyle: (name?: MarkerStyle) => {
        // Reading it is what the keyframe pass needs first — it has to record the default the
        // game boots with before it starts switching looks about.
        if (name !== undefined) this.markers.setStyle(name);
        return this.markers.style;
      },
      markerStyles: () => [...MARKER_STYLES],
      /** M6a: the ceiling knobs, live — `tools/hands.mjs` shoots the A/B pair with them. */
      markerTune: (patch: Partial<Record<string, number | boolean>>) => {
        Object.assign(this.markers.tunables, patch);
        this.markers.applyLook();
        return { ...this.markers.tunables };
      },
      markList: () => this.markers.list(),
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
      /** The pack, for the M4 scenarios: look at it, move it, hurt it, switch the overlay. */
      spiders: {
        list: () => this.spiders?.list() ?? [],
        stats: () => this.spiders?.getStats() ?? null,
        mode: () => this.spiders?.mode ?? 'off',
        spawn: (n?: number) => {
          this.spiders?.spawn(n, this.player.position);
          return this.spiders?.getStats().count ?? 0;
        },
        place: (i: number, x: number, z: number, y?: number) =>
          this.spiders?.place(i, x, z, y) ?? false,
        hurt: (i: number) => this.spiders?.hurt(i) ?? false,
        overlay: (on: boolean) => {
          this.spiderOverlay.setVisible(on);
          return this.spiderOverlay.visible;
        },
        tune: (patch: Partial<Record<string, number>>) => {
          if (this.spiders === null) return null;
          Object.assign(this.spiders.tunables, patch);
          return { ...this.spiders.tunables };
        },
      },
      /** The body and the player's own HUD, for the M5 scenarios. */
      vitals: {
        state: () => ({
          health: this.vitals.health,
          frac: this.vitals.healthFrac,
          alive: this.vitals.alive,
          bites: this.vitals.bites,
          damage: this.vitals.damage,
          degrade: this.vitals.degrade,
          sting: this.vitals.sting,
          lastHitAgo: this.vitals.lastHitAgo,
          marks: this.vitals.marks.map((m) => ({ ...m })),
          punch: { ...this.vitals.viewPunch },
          compass: { enabled: this.compass.enabled, blips: this.compass.count, drawn: this.notches.length },
        }),
        /** A bite from a world point, exactly as a spider would land it. */
        bite: (x: number, z: number, amount?: number) => {
          const p = this.player.position;
          return this.vitals.bite(x, z, p.x, p.z, this.player.yaw, amount);
        },
        /** A bite from a bearing in degrees, 0 = straight ahead, +90 = your right. */
        biteFrom: (deg: number, amount?: number) => {
          const p = this.player.position;
          const a = this.player.yaw - (deg * Math.PI) / 180 + Math.PI;
          return this.vitals.bite(p.x + Math.sin(a) * 2, p.z + Math.cos(a) * 2, p.x, p.z, this.player.yaw, amount);
        },
        health: (v: number) => {
          this.vitals.setHealth(v);
          return this.vitals.health;
        },
        reset: () => this.vitals.reset(),
        damage: (on: boolean) => {
          this.vitals.enabled = on;
          return this.vitals.enabled;
        },
        effects: (on: boolean) => {
          this.vitals.effects = on;
          this.playerHud.showDamage = on;
          return on;
        },
        /** Which of the four looks the player's layer draws in. One switch, no rebuild. */
        hudStyle: (name: HudStyle) => {
          this.playerHud.setStyle(name);
          return this.playerHud.style;
        },
        hudStyles: () => [...HUD_STYLES],
        layer: (on: boolean) => {
          this.playerHud.setVisible(on);
          return this.playerHud.visible;
        },
        compass: (on: boolean) => {
          this.compass.enabled = on;
          return this.compass.enabled;
        },
        compassTune: (patch: Partial<Record<string, number | boolean>>) => {
          Object.assign(this.compass.tunables, patch);
          return { ...this.compass.tunables };
        },
        tune: (patch: Partial<Record<string, number>>) => {
          Object.assign(this.vitals.tunables, patch);
          return { ...this.vitals.tunables };
        },
        /** Every notch the compass drew on the last frame — bearing in screen degrees. */
        notches: () =>
          this.notches.map((n) => ({
            deg: (n.angle * 180) / Math.PI,
            strength: n.strength,
            seq: n.seq,
            alien: n.alien,
            color: n.color,
          })),
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
        audio: this.audio.getStats(),
        props: this.props?.getStats() ?? null,
        rifle: this.rifle?.getStats() ?? null,
        flash: {
          count: this.flash.count,
          envelope: this.flash.envelope,
          lit: this.flash.lit,
          held: this.flash.holding,
          life: this.flash.tunables.life,
          shadows: this.flash.tunables.shadows,
        },
        gun: {
          mesh: this.rifleView.tunables.visible,
          lit: this.rifleView.lit,
          energy: this.rifleView.energy,
          felt: this.rifleView.felt,
        },
        aim: { yawDeg: (this.player.yaw * 180) / Math.PI, pitchDeg: (this.player.pitch * 180) / Math.PI },
        dyn: this.dyn?.getStats() ?? null,
        spiders: this.spiders?.getStats() ?? null,
        propsMs: this.propsMs,
        sound: {
          emitted: this.bus.emitted,
          last: this.bus.lastEvent,
          // Per source, so a scenario can tell "the hall is noisy" from "you are noisy" — the
          // distinction the concept's whole cost/benefit joke rests on.
          bySource: Object.fromEntries(this.bus.countsBySource()),
        },
        gate: Math.hypot(this.player.position.x - GATE_TARGET.x, this.player.position.z - GATE_TARGET.z),
        radio: {
          carried: this.radio.carried,
          powered: this.radio.powered,
          clarity: this.radio.lastComputedClarity,
        },
        round: this.roundState,
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
