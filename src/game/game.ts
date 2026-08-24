/**
 * The game.
 *
 * A dead industrial room with no lights, no fog and no ambient anything, where the *only* thing
 * ever drawn is the geometry that sound has unlocked (vision §3). Walk and your footsteps light
 * the floor ahead of you; press Q for a 12 m room read; press E to look around a 110° arc of the
 * next 22 m. Everything you learn is bought with noise, everything is learned at the speed the
 * wavefront travels, and everything you have learned cools from ice-white to a permanent navy
 * memory skeleton.
 *
 * This class is glue and nothing else. It owns the clock, wires the player's body to the sound
 * bus and the sound bus to the reveal, reads the keys the prototype needs, and publishes a
 * read-only state for tooling. The three things it is gluing live elsewhere: movement in
 * `player/controller.ts`, the room in `world/room.ts`, perception in `paint/`.
 *
 * `L` turns the lights on for comparison — a debug view, never a thing the game has. Collision
 * and the reveal both run against the `StaticWorld` box list, never against those meshes, so
 * with the reveal hidden the frame contains exactly one thing: what was heard.
 */

import * as THREE from 'three';
import type GUI from 'lil-gui';
import { StaticWorld } from '../core/collision';
import type { Input } from '../core/input';
import type { HelpRow, Hud } from '../ui/hud';
import {
  PlayerController,
  defaultBobTunables,
  defaultCameraFeelTunables,
  defaultCameraTunables,
  defaultMantleTunables,
  defaultMovementTunables,
  defaultThirdPersonTunables,
  type PlayerEvent,
} from '../player/controller';
import {
  LANDING_MIN_IMPACT,
  SOUND_CLASSES,
  SoundBus,
  WAVE_SPEEDS,
  type SoundClass,
} from '../paint/soundEvents';
import {
  PaintSystem,
  defaultPerceptionTunables,
  defaultWaveTunables,
} from '../paint/paintSystem';
import { defaultAgeRamp } from '../paint/ageRamp';
import { defaultStructuredTunables } from '../paint/structured';
import { BloomChain, defaultBloomTunables, isSoftwareRenderer } from '../paint/post';
import { PROBE_REGIONS, REVEAL_BACKGROUND, SPAWN, SPAWN_YAW_DEG, buildRoom, type Room } from '../world/room';

/** Shared ping cooldown, seconds (§3.5). */
const PING_COOLDOWN = 0.75;
/** Where a ping is emitted from, metres above the feet. */
const Q_PING_HEIGHT = 1.15;
const E_PING_HEIGHT = 1.5;
/**
 * Where a footfall radiates from, metres above the contact point.
 *
 * Not zero, and that is a design decision rather than a fudge. A point source lying *on* the
 * floor plane meets that plane at 90° everywhere and reveals a puddle a handspan wide however
 * much of it is heard — the returns all come back grazing. Vision §3.3 wants a walk step to
 * paint 4 m and a sprint step to light the path ~7 m ahead, so the sound has to leave the rig,
 * not the floor: the strike rings up through the chassis and radiates from about knee height.
 */
const STEP_HEIGHT = 0.65;

/**
 * Debug-only paint clock multipliers, cycled with T.
 *
 * ×10 and ×60 exist because ageing takes a minute and tests do not. ×0.1 exists for the
 * opposite reason: a wavefront crosses a room in half a second, which at software-GL frame
 * rates is three frames, and the only way to *look* at a front in flight — or to screenshot one
 * at a known fraction of its travel — is to slow the clock the wave rides on.
 */
const TIME_SCALES = [1, 0.1, 10, 60];

const HINT =
  'WASD move · Q ping · E beam · L reveal · B bloom · T clock · K clear · V view · R respawn · H help';

const HELP: HelpRow[] = [
  { keys: 'W A S D', action: 'move' },
  { keys: 'Shift / C', action: 'sprint / crouch — louder and quieter paint' },
  { keys: 'Space', action: 'jump — landings paint hard · at a ledge, climb' },
  { keys: 'Q', action: 'spatial ping — 360°, 12 m, the room read' },
  { keys: 'E', action: 'directed ping — 110°, 22 m, the look-around' },
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
}

export class Game {
  readonly title = 'Blind Spot';

  private readonly ctx: GameCtx;
  private readonly input: Input;

  private readonly world = new StaticWorld();
  private readonly room: Room;

  private readonly movement = defaultMovementTunables();
  private readonly cameraTunables = defaultCameraTunables();
  private readonly bobTunables = defaultBobTunables();
  private readonly mantleTunables = defaultMantleTunables();
  private readonly thirdPersonTunables = defaultThirdPersonTunables();
  private readonly feelTunables = defaultCameraFeelTunables();
  private readonly player: PlayerController;

  private readonly bus = new SoundBus();
  private readonly paint: PaintSystem;
  private readonly unsubscribeBus: () => void;
  private readonly unsubscribePlayer: () => void;

  private revealOn = false;
  private readonly rigMarker: THREE.Mesh;
  private readonly rigGeometry: THREE.SphereGeometry;
  private readonly rigMaterial: THREE.MeshBasicMaterial;

  private readonly bloomTunables = defaultBloomTunables();
  private bloomChain: BloomChain | null = null;
  /** Public because the dev panel binds directly to it; B toggles the same flag. */
  bloomOn = false;
  private readonly softwareGl: boolean;

  private paintTime = 0;
  private timeScaleIndex = 0;
  private pingCooldown = 0;
  private hudTimer = 0;

  private readonly aim = new THREE.Vector3();

  constructor(ctx: GameCtx) {
    this.ctx = ctx;
    this.input = ctx.input;

    // Law 3: absence is black. No ambient light, no fog, no helpful outlines — ever.
    ctx.scene.background = new THREE.Color(0x000000);
    ctx.scene.fog = null;

    // The room first: the reveal precomputes its lattice off the collider list, so the world
    // has to be populated before the paint system is constructed.
    this.room = buildRoom(this.world);
    ctx.scene.add(this.room.reveal);

    this.player = new PlayerController(
      this.world,
      this.movement,
      this.cameraTunables,
      this.bobTunables,
      this.mantleTunables,
      this.thirdPersonTunables,
      this.feelTunables,
    );
    this.player.setSpawn(SPAWN, SPAWN_YAW_DEG);

    this.paint = new PaintSystem(this.world, {
      perception: defaultPerceptionTunables(),
      ramp: defaultAgeRamp(),
      wave: defaultWaveTunables(),
      structured: defaultStructuredTunables(),
    });
    ctx.scene.add(this.paint.object);
    this.unsubscribeBus = this.bus.subscribe(this.paint.handle);
    this.unsubscribePlayer = this.player.onEvent(this.onPlayerEvent);

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

    this.syncListener();
    this.buildGui();
    ctx.hud.setTitle(this.title);
    ctx.hud.setHint(HINT);
    ctx.hud.setHelp(HELP);
  }

  // ---- sound ---------------------------------------------------------------

  private onPlayerEvent = (event: PlayerEvent): void => {
    if (event.type === 'footstep') {
      const cls: SoundClass =
        event.tier === 'crouch' ? 'crouch-step' : event.tier === 'sprint' ? 'sprint-step' : 'walk-step';
      this.bus.emit({ class: cls, x: event.x, y: event.y + STEP_HEIGHT, z: event.z });
      return;
    }
    // §3.3 only gives landings above a 2 m drop a paint radius; stepping off a kerb is not a
    // flashbulb, and a respawn settling onto the floor certainly is not.
    if (event.impactSpeed < LANDING_MIN_IMPACT) return;
    const radius = SoundBus.landingRadius(event.impactSpeed);
    this.bus.emit({
      class: 'landing',
      x: event.x,
      y: event.y + STEP_HEIGHT,
      z: event.z,
      paintRadius: radius,
      intensity: 0.95 + 0.35 * ((radius - 8) / 6),
    });
  };

  private firePing(kind: 'q-ping' | 'e-ping'): void {
    const p = this.player.position;
    if (kind === 'q-ping') {
      this.bus.emit({ class: 'q-ping', x: p.x, y: p.y + Q_PING_HEIGHT, z: p.z });
    } else {
      const cp = Math.cos(this.player.pitch);
      this.aim.set(
        -Math.sin(this.player.yaw) * cp,
        Math.sin(this.player.pitch),
        -Math.cos(this.player.yaw) * cp,
      );
      this.bus.emit({
        class: 'e-ping',
        x: p.x,
        y: p.y + E_PING_HEIGHT,
        z: p.z,
        dirX: this.aim.x,
        dirY: this.aim.y,
        dirZ: this.aim.z,
      });
    }
    this.pingCooldown = PING_COOLDOWN;
  }

  private syncListener(): void {
    const p = this.player.position;
    this.paint.setListener(p.x, p.y + E_PING_HEIGHT, p.z);
  }

  // ---- dev panel -----------------------------------------------------------

  private buildGui(): void {
    const gui = this.ctx.gui;
    const push = (): void => this.paint.applyTunables();

    const g = gui.addFolder('Game');
    g.add({ respawn: () => this.player.respawn() }, 'respawn').name('Respawn (R)');
    g.add({ ping: () => this.firePing('q-ping') }, 'ping').name('Q ping (360°, 12 m)');
    g.add({ beam: () => this.firePing('e-ping') }, 'beam').name('E beam (110°, 22 m)');
    g.add({ clear: () => this.paint.clear() }, 'clear').name('Clear map (K)');
    g.add({ toggle: () => this.setReveal(!this.revealOn) }, 'toggle').name('Reveal lights (L)');
    g.add({ view: () => this.player.toggleView() }, 'view').name('Toggle view (V)');

    /*
     * The reveal's own numbers.
     *
     * Three of them — spacing, jitter and segment length — are *build* parameters: they change
     * the lattice itself, so they rebuild it and drop whatever was known, which is why they are
     * on `onFinishChange` (a rebuild per mouse-move would be a slideshow). Everything else is a
     * uniform and is live.
     */
    const s = this.paint.structured.tunables;
    const rebuild = (): void => {
      this.paint.structured.rebuild();
      this.paint.clear();
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
    const w = this.paint.wave;
    const wf = gui.addFolder('Wave');
    wf.add(WAVE_SPEEDS, 'step', 4, 120, 1).name('speed: steps (m/s)');
    wf.add(WAVE_SPEEDS, 'ping', 4, 120, 1).name('speed: Q ping (m/s)');
    wf.add(WAVE_SPEEDS, 'beam', 4, 200, 1).name('speed: E beam (m/s)');
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
    const ramp = this.paint.ramp;
    r.add(ramp, 'freshSeconds', 0.2, 10, 0.1).name('white→cyan (s)').onChange(push);
    r.add(ramp, 'coolSeconds', 1, 60, 0.5).name('cyan→navy (s)').onChange(push);
    r.add(ramp, 'coldSeconds', 5, 240, 1).name('navy→skeleton (s)').onChange(push);
    r.add(ramp, 'skeletonAlpha', 0, 1, 0.01).name('skeleton alpha').onChange(push);
    r.add(ramp, 'skeletonSize', 0.2, 1, 0.05).name('skeleton size').onChange(push);

    const p = gui.addFolder('Perception');
    const per = this.paint.perception;
    p.add(per, 'hearingRange', 2, 60, 1).name('hearing (m)');
    p.add(per, 'windowRadius', 5, 120, 1).name('draw window (m)').onChange(push);
    p.add(per, 'chunkGapMs', 0, 32, 1).name('reveal chunk gap (ms)');

    const beam = gui.addFolder('Ping shape');
    beam.add(SOUND_CLASSES['e-ping'], 'coneAngleDeg', 10, 180, 1).name('E cone (°)');
    beam.add(SOUND_CLASSES['e-ping'], 'paintRadius', 5, 60, 1).name('E range (m)');
    beam.add(SOUND_CLASSES['q-ping'], 'paintRadius', 3, 30, 1).name('Q range (m)');

    const bl = gui.addFolder('Bloom');
    bl.add(this, 'bloomOn').name('bloom (B)').listen();
    bl.add(this.bloomTunables, 'strength', 0, 2, 0.02).name('strength');
    bl.add(this.bloomTunables, 'radius', 0, 1, 0.02).name('radius');
    bl.add(this.bloomTunables, 'threshold', 0, 1, 0.01).name('threshold');
  }

  // ---- lifecycle -----------------------------------------------------------

  private setReveal(on: boolean): void {
    this.revealOn = on;
    this.room.reveal.visible = on;
    (this.ctx.scene.background as THREE.Color).setHex(on ? REVEAL_BACKGROUND : 0x000000);
  }

  update(dt: number): void {
    this.paintTime += dt * TIME_SCALES[this.timeScaleIndex]!;
    this.bus.setTime(this.paintTime);
    this.syncListener();
    this.paint.advance(this.paintTime);

    if (this.input.wasKeyPressed('KeyR')) this.player.respawn();
    if (this.input.wasKeyPressed('KeyV')) this.player.toggleView();
    if (this.input.wasKeyPressed('KeyL')) this.setReveal(!this.revealOn);
    if (this.input.wasKeyPressed('KeyB')) this.bloomOn = !this.bloomOn;
    if (this.input.wasKeyPressed('KeyT')) {
      this.timeScaleIndex = (this.timeScaleIndex + 1) % TIME_SCALES.length;
    }
    if (this.input.wasKeyPressed('KeyK')) this.paint.clear();

    if (this.pingCooldown > 0) this.pingCooldown -= dt;
    if (this.pingCooldown <= 0) {
      if (this.input.wasKeyPressed('KeyQ')) this.firePing('q-ping');
      else if (this.input.wasKeyPressed('KeyE')) this.firePing('e-ping');
    }

    this.player.update(dt, this.input);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.publishHud();
    }
  }

  private publishHud(): void {
    const last = this.bus.lastEvent;
    const scale = TIME_SCALES[this.timeScaleIndex]!;
    const s = this.player.state;
    const diag = this.paint.diagnostics();
    const st = this.paint.structured.getStats();
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
      [
        'ping',
        this.pingCooldown > 0 ? `cooling ${this.pingCooldown.toFixed(2)} s` : 'ready  Q · E',
      ],
      ['clock', `${this.paintTime.toFixed(1)} s ×${scale}`],
      ['speed', `${s.speed.toFixed(2)} m/s · ${s.stance}${s.grounded ? '' : ' · air'}`],
      ['view', `${this.bloomOn ? 'bloom' : 'raw'}${this.revealOn ? ' · REVEAL' : ''}`],
    ]);
  }

  render(alpha: number): void {
    this.player.applyToCamera(this.ctx.camera, alpha);
    this.paint.updateView(this.ctx.camera, this.ctx.renderer);
    const p = this.player.renderPosition;
    this.rigMarker.position.set(p.x, p.y + 1.15, p.z);
    this.rigMarker.visible = this.player.viewBlend > 0.05;
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

  /** Read-only structured state for the screenshot driver and for manual debugging. */
  debugState(): Record<string, unknown> {
    const s = this.player.state;
    const cam = this.ctx.camera;
    const last = this.bus.lastEvent;
    const diag = this.paint.diagnostics();
    const st = this.paint.structured.getStats();
    const d = this.paint.structured.diagnostics();
    const t = this.paint.structured.tunables;
    return {
      // --- body
      x: this.player.position.x,
      y: this.player.position.y,
      z: this.player.position.z,
      yawDeg: (this.player.yaw * 180) / Math.PI,
      pitchDeg: (this.player.pitch * 180) / Math.PI,
      speed: s.speed,
      grounded: s.grounded,
      stance: s.stance,
      sprinting: s.sprinting,
      mantling: s.mantling,
      steps: this.player.stepCount,
      respawnCount: this.player.respawnCount,
      sensitivity: this.cameraTunables.sensitivity,
      // --- camera. What the *render* camera is doing, which is where bob and the dip live.
      view: this.player.viewMode,
      viewBlend: this.player.viewBlend,
      boom: this.player.boomLength,
      boomRest: this.player.boomRest,
      camX: cam.position.x,
      camY: cam.position.y,
      camZ: cam.position.z,
      camRoll: (cam.rotation.z * 180) / Math.PI,
      landDip: this.player.landDipOffset,
      landDipPeak: this.player.landDipPeakOffset,
      // --- sound
      soundEvents: this.bus.emitted,
      lastEvent: last?.class ?? null,
      lastEventSeq: last?.seq ?? -1,
      lastEventTime: last?.time ?? -1,
      lastEventSpeed: last?.waveSpeed ?? 0,
      lastEventRadius: last?.paintRadius ?? 0,
      pingCooldown: Math.max(0, this.pingCooldown),
      eConeDeg: SOUND_CLASSES['e-ping'].coneAngleDeg,
      eRange: SOUND_CLASSES['e-ping'].paintRadius,
      hearingRange: this.paint.perception.hearingRange,
      // --- the wave
      waveLive: diag.waveLive,
      waveFront: diag.waveFront,
      waveRange: diag.waveRange,
      waveProgress: diag.waveProgress,
      refreshFloor: this.paint.refreshFloor,
      refreshSeconds: this.paint.wave.refreshSeconds,
      stepFloor: this.paint.wave.stepFloor,
      refreshFeatherStart: this.paint.wave.featherStart,
      tracerAlive: this.paint.tracerAlive,
      tracerAge: this.paint.tracerAge,
      dustEnabled: this.paint.wave.dust,
      dustLit: this.paint.dustLit,
      // --- clock and view state
      paintTime: this.paintTime,
      paintTimeScale: TIME_SCALES[this.timeScaleIndex],
      reveal: this.revealOn,
      bloom: this.bloomOn,
      softwareGl: this.softwareGl,
      // --- the reveal
      structBuilt: st.built,
      structBuildMs: st.buildMs,
      structDots: st.dots,
      structEdges: st.edges,
      structBytes: st.bytes,
      structUnlockedDots: st.unlockedDots,
      structUnlockedEdges: st.unlockedEdges,
      structLastDots: st.lastDots,
      structLastEdges: st.lastEdges,
      structLastRays: st.lastRays,
      structLastRefreshed: st.lastRefreshed,
      // What the last event's refreshes were allowed to do, and what they did. `structLastJump`
      // is the continuity invariant itself — the worst age step any of those restamps put on
      // screen, which the effective-stamp construction holds at zero. Restamps the amortised
      // job reached after their own front had gone by are reported separately, because a
      // slow-frame artefact and a policy violation are not the same number.
      structLastFloor: st.lastFloor,
      structLastFeatherMean: st.lastFeatherMean,
      structLastFloored: st.lastFloored,
      structLastJump: st.lastJump,
      structLastLate: st.lastLate,
      structLastLateStep: st.lastLateStep,
      // Total CPU spent unlocking the last event, and the worst single frame's share of it —
      // the second is the one that can be felt, so it is the one the driver asserts on.
      structLastMs: st.lastMs,
      structLastChunkMs: st.lastChunkMs,
      structLastChunks: st.lastChunks,
      structPending: st.pending,
      structDrawnDots: d.drawnDots,
      structInkedEdges: d.inkedEdges,
      structPendingEdges: d.pendingEdges,
      structRippling: d.rippling,
      structRippleMax: d.rippleMax,
      structInkSeconds: t.inkSeconds,
      structRipple: t.ripple,
      structRingWidth: t.ringWidth,
      structSpacing: t.spacing,
      probeRegions: PROBE_REGIONS,
    };
  }

  /**
   * Named world-box queries for tooling: how much of the geometry inside a region is known, and
   * how much of it is drawn right now. This is the only way to prove the propagation rules from
   * outside the renderer — that a crate's far side answered with its near side, and that the room
   * behind a wall did not answer at all.
   */
  debugProbe(name: string, args?: Record<string, unknown>): unknown {
    if (name !== 'region') return null;
    const key = typeof args?.region === 'string' ? args.region : null;
    const named = key !== null ? PROBE_REGIONS[key] : null;
    const raw = Array.isArray(args?.box) ? (args.box as number[]) : null;
    const b = named ?? raw;
    if (b === null || b === undefined || b.length < 6) return null;
    return {
      region: key ?? 'custom',
      box: b,
      ...this.paint.structured.regionStats(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!),
    };
  }

  dispose(): void {
    this.unsubscribeBus();
    this.unsubscribePlayer();
    this.bus.dispose();
    this.paint.dispose();
    this.bloomChain?.dispose();
    this.bloomChain = null;
    this.ctx.scene.remove(this.paint.object);
    this.ctx.scene.remove(this.room.reveal);
    this.ctx.scene.remove(this.rigMarker);
    this.room.dispose();
    this.rigGeometry.dispose();
    this.rigMaterial.dispose();
    this.world.clear();
  }
}
