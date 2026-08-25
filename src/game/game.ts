/**
 * The browser half of the game: everything that needs a screen.
 *
 * The simulation itself is `game/sim.ts` and knows nothing about any of this. What is left here
 * is presentation and only presentation — the scene the sim's objects are hung in, the bloom
 * chain, the reveal debug view, the dev panel, the HUD, and the three hotkeys that drive them.
 * `update` is three lines: the presentation keys, one sim tick, the HUD.
 *
 * `L` turns the lights on for comparison — a debug view, never a thing the game has. Collision
 * and the reveal both run against the `StaticWorld` box list, never against those meshes, so
 * with the reveal hidden the frame contains exactly one thing: what was heard.
 */

import * as THREE from 'three';
import type GUI from 'lil-gui';
import type { Input } from '../core/input';
import type { SeedConfig } from '../core/rng';
import type { HelpRow, Hud } from '../ui/hud';
import { AudioSystem } from '../audio/system';
import { BloomChain, defaultBloomTunables, isSoftwareRenderer } from '../paint/post';
import { REVEAL_BACKGROUND } from '../world/room';
import { PLAYER_EMITTER_ID } from '../paint/soundEvents';
import type { ListenerState } from '../audio/director';
import { GameSim, Q_PING_HEIGHT } from './sim';
import { SPHERE_CHARGE_SECONDS, SPHERE_COUNT } from './spheres';
import { SphereView } from './sphereView';

/**
 * The one line of text on screen, and the whole of the game's discoverability.
 *
 * Exported alongside `HELP` because a verb that only exists in the source is a verb nobody
 * finds: the suite pins that every key `core/input.ts` binds is named here, so adding a verb
 * without telling the player is a red test rather than a silent omission.
 */
export const HINT =
  'WASD move · Q ping · E beam · F throw · L reveal · B bloom · ' +
  'T clock · K clear · V view · R respawn · H help';

export const HELP: HelpRow[] = [
  { keys: 'W A S D', action: 'move' },
  { keys: 'Shift / C', action: 'sprint / crouch — louder and quieter paint' },
  { keys: 'Space', action: 'jump — landings paint hard · at a ledge, climb' },
  { keys: 'Q', action: 'spatial ping — 360°, 12 m, the room read' },
  { keys: 'E', action: 'directed ping — 110°, 22 m, the look-around' },
  { keys: 'F', action: 'throw a sphere — hold to charge · one boom where it lands' },
  { keys: 'L', action: 'reveal — lights on, for comparison only' },
  { keys: 'B', action: 'bloom on / off' },
  { keys: 'T', action: 'paint clock speed — x1, x0.1 (watch a wave), x10, x60' },
  { keys: 'K', action: 'clear the map' },
  { keys: 'V / R', action: 'view / respawn' },
  { keys: 'H', action: 'toggle this help' },
];

export interface GameCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  input: Input;
  gui: GUI;
  hud: Hud;
  /**
   * The run's seed. Omitted — or present but not explicit — means every random stream keeps the
   * constant it was born with, so the default run is the run it has always been (`core/rng.ts`).
   */
  seed?: SeedConfig;
}

export class Game {
  readonly title = 'Blind Spot';

  /** The game. Everything else on this class is a way of looking at it. */
  readonly sim: GameSim;

  /**
   * The bus's second subscriber (§1, "one bus, two senses").
   *
   * It lives here and not in `GameSim` on purpose. A context is a browser object and a gesture is
   * a browser event, and `sim.ts` is the half of the game that has neither — the headless runs
   * and the whole determinism oracle depend on it staying that way. The sim makes the noises;
   * this side is what turns them into sound.
   */
  readonly audio: AudioSystem;
  /** Set once audio is live, so the gesture check stops running every frame forever. */
  private audioLive = false;

  private readonly ctx: GameCtx;
  private readonly input: Input;

  private revealOn = false;
  private readonly rigMarker: THREE.Mesh;
  private readonly rigGeometry: THREE.SphereGeometry;
  private readonly rigMaterial: THREE.MeshBasicMaterial;

  /**
   * The other thing drawn that sound did not reveal: the rig's own spheres, and the arc while
   * the arm is wound. Its own file argues for the exception; what it needs from here is a pose
   * and a projection scale, once a frame.
   */
  private readonly sphereView = new SphereView();
  /** Scratch for the drawing-buffer size, so `render` allocates nothing. */
  private readonly viewportSize = new THREE.Vector2();

  private readonly bloomTunables = defaultBloomTunables();
  private bloomChain: BloomChain | null = null;
  /** Public because the dev panel binds directly to it; B toggles the same flag. */
  bloomOn = false;
  private readonly softwareGl: boolean;

  private hudTimer = 0;

  /** The folders this game added to the shared panel, so `dispose` can take them with it. */
  private readonly folders: GUI[] = [];

  /**
   * The hand's two live numbers, mirrored for the dev panel.
   *
   * lil-gui's `listen()` polls an object, so the readout needs one to poll; these are refreshed
   * once per frame from the sim and are never read back. Two disabled rows rather than a HUD-only
   * reading because the rack is the one piece of state the throw verb has that the world does not
   * show you — a sphere you are carrying makes no sound and paints nothing.
   */
  private readonly handReadout = { spheres: 0, charge: 0 };

  constructor(ctx: GameCtx) {
    this.ctx = ctx;
    this.input = ctx.input;

    // Law 3: absence is black. No ambient light, no fog, no helpful outlines — ever.
    ctx.scene.background = new THREE.Color(0x000000);
    ctx.scene.fog = null;

    this.sim = new GameSim({ seed: ctx.seed });
    // Subscribed to the *same* bus the paint system is on, before anything can emit.
    this.audio = new AudioSystem({
      bus: this.sim.bus,
      listener: () => this.listenerNow(),
    });
    ctx.scene.add(this.sim.room.reveal);
    ctx.scene.add(this.sim.paint.object);

    /*
     * Bloom is what gives a contour its halo, and it is also five mip levels of separable
     * gaussian — which a CPU rasteriser will not give away. Under software GL it is off by
     * default and the pass runs at half resolution when it is turned on, so the headless driver
     * can still take an on/off pair without the frame rate collapsing.
     */
    this.softwareGl = isSoftwareRenderer(ctx.renderer);
    this.bloomOn = !this.softwareGl;

    // The only thing drawn that sound did not reveal: your own reactor, and only from outside
    // your own head. Without it the third-person view has no anchor at all in the dark.
    this.rigGeometry = new THREE.SphereGeometry(0.1, 10, 8);
    this.rigMaterial = new THREE.MeshBasicMaterial({ color: 0xffa63c });
    this.rigMarker = new THREE.Mesh(this.rigGeometry, this.rigMaterial);
    this.rigMarker.visible = false;
    ctx.scene.add(this.rigMarker);
    ctx.scene.add(this.sphereView.object);

    this.buildGui();
    ctx.hud.setTitle(this.title);
    ctx.hud.setHint(HINT);
    ctx.hud.setHelp(HELP);
  }

  // ---- dev panel -----------------------------------------------------------

  private buildGui(): void {
    const paint = this.sim.paint;
    const push = (): void => paint.applyTunables();
    const gui = {
      addFolder: (name: string): GUI => {
        const folder = this.ctx.gui.addFolder(name);
        this.folders.push(folder);
        return folder;
      },
    };

    const g = gui.addFolder('Game');
    g.add({ respawn: () => this.sim.player.respawn() }, 'respawn').name('Respawn (R)');
    g.add({ ping: () => this.sim.firePing('q-ping') }, 'ping').name('Q ping (360°, 12 m)');
    g.add({ beam: () => this.sim.firePing('e-ping') }, 'beam').name('E beam (110°, 22 m)');
    g.add({ clear: () => paint.clear() }, 'clear').name('Clear map (K)');
    g.add({ toggle: () => this.setReveal(!this.revealOn) }, 'toggle').name('Reveal lights (L)');
    g.add({ view: () => this.sim.player.toggleView() }, 'view').name('Toggle view (V)');
    const hand = this.handReadout;
    hand.spheres = this.sim.spheres.carried;
    const rack = g.add(hand, 'spheres', 0, SPHERE_COUNT, 1).name('spheres in rack (F throws)');
    rack.listen().disable();
    g.add(hand, 'charge', 0, SPHERE_CHARGE_SECONDS, 0.01).name('wind-up (s)').listen().disable();
    /*
     * The rack's refill rate, live — the one number of the throw verb that is genuinely open.
     *
     * A slider rather than a constant to edit because the two ends of it are both *uses*: 0 is an
     * instant refill, which is how you tune anything else about the sphere without the wait
     * getting in the way, and a large value is the off switch for a session that wants to know
     * what four spheres and no more feels like. `Spheres.rechargeSeconds` is public and mutable
     * for exactly this, and `advanceRecharge` reads it every tick, so a drag takes effect on the
     * next one rather than at the next throw.
     */
    g.add(this.sim.spheres, 'rechargeSeconds', 0, 60, 0.5).name('sphere recharge (s)');

    /*
     * The reveal's own numbers.
     *
     * Three of them — spacing, jitter and segment length — are *build* parameters: they change
     * the lattice itself, so they rebuild it and drop whatever was known, which is why they are
     * on `onFinishChange` (a rebuild per mouse-move would be a slideshow). Everything else is a
     * uniform and is live.
     */
    const s = paint.structured.tunables;
    const rebuild = (): void => {
      paint.structured.rebuild();
      paint.clear();
    };
    const b = gui.addFolder('Blueprint');
    b.add(s, 'spacing', 0.08, 0.5, 0.01).name('lattice spacing (m)').onFinishChange(rebuild);
    b.add(s, 'jitter', 0, 0.3, 0.01).name('lattice jitter ×spacing').onFinishChange(rebuild);
    b.add(s, 'segment', 0.1, 1, 0.05).name('contour piece (m)').onFinishChange(rebuild);
    b.add(s, 'ripple', 0, 0.15, 0.005).name('ripple amplitude (m)').onChange(push);
    b.add(s, 'ringWidth', 0.2, 4, 0.1).name('ring width (m)').onChange(push);
    b.add(s, 'inkSeconds', 0.01, 0.5, 0.01).name('ink-in (s)').onChange(push);
    b.add(s, 'contourBright', 0, 3, 0.05).name('contour brightness').onChange(push);
    b.add(s, 'dotBright', 0, 2, 0.02).name('lattice brightness').onChange(push);
    b.add(s, 'dotSize', 0.01, 0.2, 0.005).name('lattice dot (m)').onChange(push);
    b.add(s, 'probeBright', 0, 6, 0.1).name('probe boost ×').onChange(push);
    b.add(s, 'probeSize', 0, 5, 0.1).name('probe swell ×').onChange(push);
    b.add(s, 'probeSoftness', 0, 1, 0.02).name('probe blur').onChange(push);
    b.add(s, 'dotSoftness', 0, 1, 0.02).name('lattice blur').onChange(push);
    b.add(s, 'pixelCap', 2, 20, 0.5).name('dot px cap').onChange(push);

    // How the wave announces itself: speed, the silent refresh, the firing streak, the lit air.
    // The speeds are *this run's* copy of the table, never the module default (see `sim.sound`):
    // a slider bound into the frozen export would tune every simulation in the process at once.
    const w = paint.wave;
    const speeds = this.sim.sound.waveSpeeds;
    const wf = gui.addFolder('Wave');
    wf.add(speeds, 'step', 4, 120, 1).name('speed: steps (m/s)');
    wf.add(speeds, 'ping', 4, 120, 1).name('speed: Q ping (m/s)');
    wf.add(speeds, 'beam', 4, 200, 1).name('speed: E beam (m/s)');
    wf.add(w, 'refreshSeconds', 0.02, 1, 0.01).name('refresh ease (s)').onChange(push);
    // The two bounds on a refresh (playtest: sprinting over aged floor stamped white footprints
    // onto it). 0 on either restores exactly what the complaint was about.
    wf.add(w, 'stepFloor', 0, 2, 0.05).name('step age floor (bands)').onChange(push);
    wf.add(w, 'featherStart', 0, 1, 0.05).name('refresh feather').onChange(push);
    wf.add(w, 'tracerSeconds', 0.05, 1, 0.01).name('tracer life (s)').onChange(push);
    wf.add(w, 'tracerStart', 0, 4, 0.05).name('tracer start (m)');
    wf.add(w, 'tracerLength', 1, 22, 0.5).name('tracer length (m)');
    wf.add(w, 'tracerDrop', 0, 1.2, 0.05).name('tracer drop (m)');
    wf.add(w, 'tracerBrightness', 0, 2, 0.05).name('tracer brightness').onChange(push);
    wf.add(w, 'dust').name('front dust');
    wf.add(w, 'dustGain', 0, 4, 0.05).name('dust gain').onChange(push);
    wf.add(w, 'dustSize', 0.002, 0.05, 0.001).name('dust size (m)').onChange(push);
    wf.add(w, 'dustShell', 0.2, 6, 0.1).name('dust shell (m)').onChange(push);

    const r = gui.addFolder('Age ramp');
    const ramp = paint.ramp;
    r.add(ramp, 'freshSeconds', 0.2, 10, 0.1).name('white→cyan (s)').onChange(push);
    r.add(ramp, 'coolSeconds', 1, 60, 0.5).name('cyan→navy (s)').onChange(push);
    r.add(ramp, 'coldSeconds', 5, 240, 1).name('navy→skeleton (s)').onChange(push);
    r.add(ramp, 'skeletonAlpha', 0, 1, 0.01).name('skeleton alpha').onChange(push);
    r.add(ramp, 'skeletonSize', 0.2, 1, 0.05).name('skeleton size').onChange(push);

    const p = gui.addFolder('Perception');
    const per = paint.perception;
    p.add(per, 'hearingRange', 2, 60, 1).name('hearing (m)');
    p.add(per, 'windowRadius', 5, 120, 1).name('draw window (m)').onChange(push);
    p.add(per, 'chunkGapMs', 0, 32, 1).name('reveal chunk gap (ms)');

    const classes = this.sim.sound.classes;
    const beam = gui.addFolder('Ping shape');
    beam.add(classes['e-ping'], 'coneAngleDeg', 10, 180, 1).name('E cone (°)');
    beam.add(classes['e-ping'], 'paintRadius', 5, 60, 1).name('E range (m)');
    beam.add(classes['q-ping'], 'paintRadius', 3, 30, 1).name('Q range (m)');

    const bl = gui.addFolder('Bloom');
    bl.add(this, 'bloomOn').name('bloom (B)').listen();
    bl.add(this.bloomTunables, 'strength', 0, 2, 0.02).name('strength');
    bl.add(this.bloomTunables, 'radius', 0, 1, 0.02).name('radius');
    bl.add(this.bloomTunables, 'threshold', 0, 1, 0.01).name('threshold');
  }

  // ---- lifecycle -----------------------------------------------------------

  private setReveal(on: boolean): void {
    this.revealOn = on;
    this.sim.room.reveal.visible = on;
    (this.ctx.scene.background as THREE.Color).setHex(on ? REVEAL_BACKGROUND : 0x000000);
  }

  /**
   * Where the ears are, and how far they reach — read from the paint system rather than kept
   * here, because §3.1 has one hearing range and a second copy of it on this class would be a
   * second answer that nothing keeps in step.
   *
   * Handed to `AudioSystem` as a function, so it is evaluated when an event arrives rather than
   * once a tick: the paint system reads the same pose at the same moment, and the two senses
   * cannot disagree about whether something was in range.
   */
  private listenerNow(): ListenerState {
    const l = this.sim.paint.listenerPosition;
    return {
      x: l.x,
      y: l.y,
      z: l.z,
      range: this.sim.paint.perception.hearingRange,
      emitter: PLAYER_EMITTER_ID,
    };
  }

  update(dt: number): void {
    // The presentation hotkeys, which the simulation has no opinion about. V is here with them
    // because which camera you are watching from is not a fact about the world; it reaches the
    // sim's body only as a view preference, and nothing between here and `tick` reads it.
    if (this.input.wasKeyPressed('KeyL')) this.setReveal(!this.revealOn);
    if (this.input.wasKeyPressed('KeyB')) this.bloomOn = !this.bloomOn;
    if (this.input.wasKeyPressed('KeyV')) this.sim.player.toggleView();

    /*
     * Audio starts on the player's first key or click and not one frame before.
     *
     * Every browser refuses to start a context without a gesture, and building one anyway costs a
     * console warning and a suspended context that swallows what is scheduled into it. So the
     * gesture count is the trigger, and a run that never gets one — `tools/shoot.mjs` drives the
     * game through synthetic input on a page nobody clicked — never constructs a context at all.
     */
    if (!this.audioLive && this.input.gestures > 0) this.audioLive = this.audio.unlock();

    this.sim.tick(dt, this.input);

    /*
     * §3.8's two faces, both fed from the tick that just moved the readout.
     *
     * One `Halo`, read twice on the same line, so the ring and the hum cannot report different
     * frames. Every frame and not on the HUD's tenth-of-a-second timer below: §3.8 says the
     * readout glides rather than stepping between stances, and a ring refreshed at 10 Hz beside
     * a hum that glides at 60 is exactly the disagreement the doc rules out — visible on the one
     * as a staircase the other does not have.
     */
    this.audio.setHaloRadius(this.sim.halo.radius, this.sim.halo.silent);
    this.ctx.hud.setHalo(this.sim.halo.brightness);

    /*
     * The rack row, on the same per-frame line and for the same reason: it is triggered by an
     * *edge* — the count changing, the arm starting to wind, a refusal — and an edge sampled on
     * the HUD's tenth-of-a-second timer below is an edge that can be missed entirely. A tap of F
     * on an empty rack lives for one tick; at 10 Hz the refusal would flash on some presses and
     * not others, which is a readout that teaches the player nothing except not to trust it.
     *
     * `Spheres` is handed over whole rather than copied into a literal: it already reads as a
     * `RackSample` structurally, so this is one call and no allocation on a path that runs 120
     * times a second.
     */
    this.ctx.hud.setRack(this.sim.spheres, dt);

    this.handReadout.spheres = this.sim.spheres.carried;
    this.handReadout.charge = this.sim.spheres.charge;

    // The beacon's pulse runs off the fixed step, not off the wall clock and not off the paint
    // clock: see `SphereView.clock` for why both of those are wrong.
    this.sphereView.advance(dt);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.publishHud();
    }
  }

  private publishHud(): void {
    const last = this.sim.bus.lastEvent;
    const s = this.sim.player.state;
    const diag = this.sim.paint.diagnostics();
    const st = this.sim.paint.structured.getStats();
    const cooldown = this.sim.pingCooldownSeconds;
    const hand = this.sim.spheres;
    const handState = hand.charging
      ? `winding ${hand.charge.toFixed(2)} s → ${hand.pendingSpeed.toFixed(1)} m/s`
      : hand.inWorld > 0
        ? `${hand.inWorld} out`
        : 'F throws';
    this.ctx.hud.setDebug([
      [
        'known',
        `${st.unlockedDots.toLocaleString('en-US')} / ${st.dots.toLocaleString('en-US')} dots · ` +
          `${st.unlockedEdges.toLocaleString('en-US')} / ${st.edges.toLocaleString('en-US')} lines`,
      ],
      [
        'event',
        last === null
          ? '—'
          : `${last.class} · ${st.lastRays} rays · ${st.lastDots} dots / ${st.lastEdges} lines`,
      ],
      [
        'wave',
        diag.waveLive
          ? `${diag.waveFront.toFixed(1)} / ${diag.waveRange.toFixed(0)} m · ${(
              diag.waveProgress * 100
            ).toFixed(0)}%`
          : 'settled',
      ],
      ['ping', cooldown > 0 ? `cooling ${cooldown.toFixed(2)} s` : 'ready  Q · E'],
      ['hand', `${hand.carried} spheres · ${handState}`],
      ['clock', `${this.sim.clock.toFixed(1)} s ×${this.sim.timeScale}`],
      ['speed', `${s.speed.toFixed(2)} m/s · ${s.stance}${s.grounded ? '' : ' · air'}`],
      ['view', `${this.bloomOn ? 'bloom' : 'raw'}${this.revealOn ? ' · REVEAL' : ''}`],
    ]);
  }

  render(alpha: number): void {
    this.sim.player.applyToCamera(this.ctx.camera, alpha);
    this.sim.paint.updateView(this.ctx.camera, this.ctx.renderer);
    const p = this.sim.player.renderPosition;
    // On `Q_PING_HEIGHT` rather than a literal of its own: the reactor is the thing that
    // radiates the 360° pulse, so the dot you can see and the point the pulse leaves from
    // are one fact. Two copies of it would let the drawn rig drift off its own sonar.
    this.rigMarker.position.set(p.x, p.y + Q_PING_HEIGHT, p.z);
    this.rigMarker.visible = this.sim.player.viewBlend > 0.05;

    /*
     * The hand, posed off the camera the frame was actually built with.
     *
     * Same world-units-to-pixels factor the paint system just recomputed, worked out again here
     * rather than reached for through it: `PaintSystem` keeps that number private and a beacon
     * that borrowed it would be a second class holding the first one's internals to get a size
     * right. It is two multiplies off the projection matrix.
     */
    const camera = this.ctx.camera;
    this.ctx.renderer.getDrawingBufferSize(this.viewportSize);
    const projScale = (camera.projectionMatrix.elements[5] ?? 1) * this.viewportSize.y * 0.5;
    this.sphereView.setProjScale(projScale);
    const hand = this.sim.spheres;
    this.sphereView.draw({
      eye: camera.position,
      yaw: this.sim.player.yaw,
      pitch: this.sim.player.pitch,
      live: hand.spheresSnapshot(),
      carried: hand.carried,
      charging: hand.charging,
      speed: hand.pendingSpeed,
      chargeFraction: hand.chargeFraction,
      firstPerson: this.sim.player.viewBlend <= 0.05,
    });
  }

  /**
   * Draws the frame, and says so.
   *
   * Bloom is the only reason the game draws itself rather than letting the boot loop do it.
   * Off — under software GL until B says otherwise — this returns false immediately and the
   * frame takes the direct path at zero cost. The reveal view is excluded because its lit
   * materials are graded by the renderer, and a composer without an output pass would hand them
   * to the screen ungraded.
   */
  renderFrame(scene: THREE.Scene, camera: THREE.PerspectiveCamera): boolean {
    if (!this.bloomOn || this.revealOn) return false;
    this.bloomChain ??= new BloomChain(
      this.ctx.renderer,
      this.bloomTunables,
      this.softwareGl ? 0.5 : 1,
    );
    this.bloomChain.render(scene, camera);
    return true;
  }

  /**
   * Read-only structured state for the screenshot driver and for manual debugging.
   *
   * The sim's own keys plus the ones only a screen has. The union is what `tools/shoot.mjs`
   * reads by name, so keys may be added here but never renamed or dropped.
   */
  debugState(): Record<string, unknown> {
    const cam = this.ctx.camera;
    return {
      ...this.sim.debugState(),
      // --- camera. What the *render* camera is doing, which is where bob and the dip land.
      camX: cam.position.x,
      camY: cam.position.y,
      camZ: cam.position.z,
      camRoll: (cam.rotation.z * 180) / Math.PI,
      // --- the hand as it is *drawn*. `spherePoses` (the sim's) says where a sphere is; these
      // say where the rig is holding the next one and how far down the aim the preview reaches,
      // which is what lets the browser suite aim a window at a beacon and photograph it.
      handX: this.sphereView.hand.x,
      handY: this.sphereView.hand.y,
      handZ: this.sphereView.hand.z,
      arcReach: this.sphereView.reach,
      // --- view state
      reveal: this.revealOn,
      bloom: this.bloomOn,
      softwareGl: this.softwareGl,
    };
  }

  /** See `GameSim.debugProbe`. */
  debugProbe(name: string, args?: Record<string, unknown>): unknown {
    return this.sim.debugProbe(name, args);
  }

  dispose(): void {
    this.audio.dispose();
    this.bloomChain?.dispose();
    this.bloomChain = null;
    this.ctx.scene.remove(this.sim.paint.object);
    this.ctx.scene.remove(this.sim.room.reveal);
    this.ctx.scene.remove(this.rigMarker);
    this.ctx.scene.remove(this.sphereView.object);
    this.sphereView.dispose();
    this.sim.dispose();
    this.rigGeometry.dispose();
    this.rigMaterial.dispose();
    for (const folder of this.folders) folder.destroy();
    this.folders.length = 0;
  }
}
