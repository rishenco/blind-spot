/**
 * The simulation — the whole game, minus every way of looking at it.
 *
 * A dead industrial room with no lights, no fog and no ambient anything, where the *only* thing
 * that is ever known is the geometry that sound has unlocked (vision §3). Walk and your
 * footsteps light the floor ahead of you; press Q for a 12 m room read; press E to look around a
 * 110° arc of the next 22 m. Everything you learn is bought with noise, everything is learned at
 * the speed the wavefront travels, and everything you have learned cools from ice-white to a
 * permanent navy memory skeleton.
 *
 * This class owns the clock, the body, the sound bus and the reveal, and it is deliberately free
 * of `window`, `document`, WebGL and lil-gui: it runs in bare Node, at whatever rate the caller
 * ticks it, which is what makes the simulation testable at all (`game/headless.ts`). three.js is
 * pure JS below `WebGLRenderer`, so the paint stack moves in here whole — meshes and shader
 * materials included, inert headless and drawn in the browser. Nothing about it is abstracted
 * behind a presenter: there is exactly one reveal and there is not going to be a second.
 *
 * `game/game.ts` is the browser half — scene wiring, bloom, the dev panel, the HUD — and it owns
 * a `GameSim`. Everything either of them knows about the other is on this file's public surface.
 */

import * as THREE from 'three';
import { StaticWorld } from '../core/collision';
import type { GameInputSource } from '../core/inputSource';
import {
  DEFAULT_SEED,
  STREAM_DUST,
  STREAM_LATTICE,
  streamSeed,
  type SeedConfig,
} from '../core/rng';
import {
  PlayerController,
  defaultBobTunables,
  defaultCameraFeelTunables,
  defaultCameraTunables,
  defaultMantleTunables,
  defaultMovementTunables,
  defaultThirdPersonTunables,
  type PlayerEvent,
  type StepTier,
} from '../player/controller';
import {
  LANDING_MIN_IMPACT,
  PLAYER_EMITTER_ID,
  SoundBus,
  defaultSoundTunables,
  type SoundClass,
  type SoundEvent,
  type SoundTunables,
} from '../paint/soundEvents';
import {
  PaintSystem,
  defaultPerceptionTunables,
  defaultWaveTunables,
} from '../paint/paintSystem';
import { Halo } from '../paint/halo';
import { defaultAgeRamp } from '../paint/ageRamp';
import { defaultStructuredTunables } from '../paint/structured';
import { PROBE_REGIONS, SPAWN, SPAWN_YAW_DEG, buildRoom, type Room } from '../world/room';
import {
  SPHERE_EMITTER_BASE,
  SPHERE_RADIUS,
  Spheres,
  type SphereSound,
} from './spheres';

/** Shared ping cooldown, seconds (§3.5). */
const PING_COOLDOWN = 0.75;
/**
 * Where the Q-ping leaves the rig, metres above the feet: the reactor, not the head.
 *
 * The two pings do not share an origin, and the difference is a claim rather than a leftover.
 * The E-ping is *aimed* — it carries the look vector — so it has no freedom at all: it must
 * leave from the point the aim leaves from, which is `E_PING_HEIGHT`, the ears. The Q-ping is
 * 360° (§3.5) and has no aim to be pinned to, so the only thing that can fix its origin is which
 * part of the chassis radiates it. That part is the reactor (§2, "a robot powered by an internal
 * reactor"), and this is the height the reactor is at: `game.ts` hangs the rig marker — the one
 * thing ever drawn that sound did not reveal — on this same constant. It is exported so those
 * are one fact instead of two literals that happen to agree.
 *
 * Two things go wrong if it is raised to the head. The pulse and the beam become one lantern in
 * two shapes, and the room-read stops being a *body* reading the room from where the body is.
 * And at 1.5 m it leaves a crouched rig entirely — `crouchHeight` is 1.2 — so §3.5's panic
 * button, the ping you press from behind cover, would radiate from a point the rig does not
 * occupy: law 2's "every blip and sound has a real physical source", missed by 30 cm. The beam's
 * origin does not follow the crouch either, but it is pinned to the aim and has no choice; the
 * pulse has a choice, and this is it.
 *
 * It is also the horizon a 360° ping paints from: raised, the rays graze the floor later and
 * clear more of the low crates, so every dot the room hands back moves. That consequence has a
 * witness — the whole-room golden in `tests/raycast.test.ts` — but a golden fails on any change
 * to geometry or emission and is regenerated whenever one is legitimate, so it stops guarding
 * this number at the moment it would matter. The claim above is asserted on its own terms in
 * `tests/headless.test.ts`.
 */
export const Q_PING_HEIGHT = 1.15;
/**
 * Where the E-ping leaves the rig, metres above the feet — and where the ears are.
 *
 * One constant doing both jobs on purpose. `syncListener` puts the paint listener here, so the
 * beam leaves from the point that does the hearing and cannot drift away from it; and
 * `NEAR_FIELD_M` in `audio/director.ts` is this height read as a distance — ear to sole, which
 * is what makes the player's own footfall the reference level of the whole mix. Split them and
 * the aim, the ears and the mix's reference are three numbers that can disagree.
 */
export const E_PING_HEIGHT = 1.5;
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
 * How far off the struck face a sphere's boom radiates from, metres.
 *
 * The same problem `STEP_HEIGHT` solves, and it is not cosmetic. `ballistics.ts` reports a
 * contact at the point on the face, and a point source lying exactly *on* a plane meets that
 * plane at 90° everywhere: measured in this room, a prop sound emitted at y = 0 on the floor
 * unlocks **0 dots out of 33 880 rays**, and the same sound one millimetre up unlocks 39 362.
 * A sphere that painted nothing is the whole verb quietly not working.
 *
 * `SPHERE_RADIUS` rather than an epsilon, because it is the honest distance rather than a nudge
 * away from a numerical cliff: physics treats a sphere as a point (`core/ballistics.ts`),
 * perception treats it as a 6 cm object, and when that object touches a face its centre is one
 * radius off it. Along the contact normal, not up — unlike a footfall, a sphere goes off against
 * walls and ceilings, and the sound leaves the side of the wall the sphere is on.
 */
const BOOM_STANDOFF = SPHERE_RADIUS;

/**
 * Which sound class a gait tier makes — the one place the two vocabularies meet.
 *
 * The body speaks in `StepTier` (what the legs are doing) and the bus speaks in `SoundClass`
 * (what §3.3 prices). Both the footstep emitter and §3.8's Halo have to cross that line, and
 * they have to cross it the same way or the readout reports a class the world never emits.
 */
export function stepClassOf(tier: StepTier): SoundClass {
  return tier === 'crouch' ? 'crouch-step' : tier === 'sprint' ? 'sprint-step' : 'walk-step';
}

/**
 * Debug-only paint clock multipliers, cycled with T.
 *
 * ×10 and ×60 exist because ageing takes a minute and tests do not. ×0.1 exists for the
 * opposite reason: a wavefront crosses a room in half a second, which at software-GL frame
 * rates is three frames, and the only way to *look* at a front in flight — or to screenshot one
 * at a known fraction of its travel — is to slow the clock the wave rides on.
 */
export const TIME_SCALES: readonly number[] = Object.freeze([1, 0.1, 10, 60]);

export interface GameSimOptions {
  /**
   * The run's seed. Omitted — or present but not explicit — means every random stream keeps the
   * constant it was born with, so the default run is the run it has always been (`core/rng.ts`).
   */
  seed?: SeedConfig;
}

export class GameSim {
  readonly world = new StaticWorld();
  readonly room: Room;
  readonly seed: SeedConfig;

  readonly movement = defaultMovementTunables();
  readonly cameraTunables = defaultCameraTunables();
  readonly bobTunables = defaultBobTunables();
  readonly mantleTunables = defaultMantleTunables();
  readonly thirdPersonTunables = defaultThirdPersonTunables();
  readonly feelTunables = defaultCameraFeelTunables();
  readonly player: PlayerController;

  /**
   * This run's copy of the sound table (§3.3) and of the wavefront speeds.
   *
   * Per-instance on purpose: the module-level tables in `soundEvents.ts` are frozen defaults, so
   * a dev-panel slider tunes *this* simulation and no other, and a seeded run reproduces whether
   * or not somebody has been dragging sliders in the same process.
   */
  readonly sound: SoundTunables = defaultSoundTunables();
  readonly bus = new SoundBus(this.sound);
  readonly paint: PaintSystem;

  /**
   * §3.8's self-readout — the ring's brightness and the hum's pitch, as one glided number.
   *
   * On the simulation and not on the browser half, even though both of its faces are presentation:
   * the *quantity* is a fact about the body and the sound table, and a headless run can therefore
   * assert on it. It emits nothing and nothing in the world reads it.
   */
  readonly halo = new Halo();

  /**
   * The hand (§M2): the rack, the charge, every sphere in the air and every noise one makes.
   *
   * It emits nothing itself — see `emitSphereSound` below, which is the only place a sphere's
   * noise becomes a `SoundEvent`, exactly as `onPlayerEvent` is the only place a footfall does.
   */
  readonly spheres: Spheres;

  private readonly unsubscribeBus: () => void;
  private readonly unsubscribeHalo: () => void;
  private readonly unsubscribePlayer: () => void;

  private paintTime = 0;
  private timeScaleIndex = 0;
  private pingCooldown = 0;

  private readonly aim = new THREE.Vector3();

  constructor(options: GameSimOptions = {}) {
    this.seed = options.seed ?? DEFAULT_SEED;

    this.room = buildRoom(this.world);
    /*
     * The reveal precomputes its lattice off the collider list, so the world has to be populated
     * *before* the paint system is constructed. Reordering these two lines does not fail — it
     * silently yields an empty lattice and a game where nothing is ever revealed — so the
     * ordering is asserted rather than left to a comment.
     */
    if (this.world.boxes.length === 0) {
      throw new Error(
        'GameSim: the room must populate StaticWorld before PaintSystem is built ' +
          '(the reveal lattice precomputes off the collider list).',
      );
    }

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
      latticeSeed: streamSeed(this.seed, STREAM_LATTICE),
      dustSeed: streamSeed(this.seed, STREAM_DUST),
    });
    /*
     * The hand takes no world data at all: a sphere is equipment the rig owns, not a prop the
     * level authored, so there is nothing for the room to place and nothing for a reset to
     * restore. That is the difference between the sphere and the can it replaced, in one
     * constructor.
     */
    this.spheres = new Spheres({
      world: this.world,
      thrower: this.player,
      movement: this.movement,
    });
    this.unsubscribeBus = this.bus.subscribe(this.paint.handle);
    this.unsubscribeHalo = this.bus.subscribe(this.onOwnNoise);
    this.unsubscribePlayer = this.player.onEvent(this.onPlayerEvent);

    this.syncListener();
  }

  // ---- sound ---------------------------------------------------------------

  /**
   * Every noise *this* body makes, onto the Halo's peak-hold.
   *
   * A third subscriber to the same stream, which is the only honest way to do it: the readout
   * quotes the event's own `hearingRadius` rather than recomputing one, so §3.8's ring cannot
   * claim a loudness the world did not carry. Recomputing it here is the bug this exists to
   * avoid — there would then be two answers to "how far is that heard", and §3.9's material
   * voice would have to be remembered in a second place.
   *
   * Filtered to the local player, not to `'player'`: in co-op a teammate's sprint is on this bus
   * too and it is *their* lantern, not yours. The Halo answers "how loud am I", and a ring that
   * flared at somebody else's footsteps would answer a question nobody asked.
   */
  private onOwnNoise = (event: SoundEvent): void => {
    if (event.emitter !== PLAYER_EMITTER_ID) return;
    this.halo.mark(event.hearingRadius);
  };

  private onPlayerEvent = (event: PlayerEvent): void => {
    if (event.type === 'footstep') {
      this.bus.emit({
        class: stepClassOf(event.tier),
        source: 'player',
        emitter: PLAYER_EMITTER_ID,
        x: event.x,
        y: event.y + STEP_HEIGHT,
        z: event.z,
        // §3.9: the surface has a say in how loud the stride is, and the controller took it off
        // the box the collision pass resolved against — the foot's own contact, not a re-probe.
        mat: event.mat,
      });
      return;
    }
    // §3.3 only gives landings above a 2 m drop a paint radius; stepping off a kerb is not a
    // flashbulb, and a respawn settling onto the floor certainly is not.
    if (event.impactSpeed < LANDING_MIN_IMPACT) return;
    const radius = SoundBus.landingRadius(event.impactSpeed);
    this.bus.emit({
      class: 'landing',
      source: 'player',
      emitter: PLAYER_EMITTER_ID,
      x: event.x,
      y: event.y + STEP_HEIGHT,
      z: event.z,
      // An explicit radius, and it is scaled by the material anyway (§3.9: "the multiplier
      // scales every radius the event carries"). A 14 m/s landing on steel is 14 x 1.5 = 21 m —
      // louder than a Q-ping, which is what makes dropping onto a steel floor a decision.
      paintRadius: radius,
      // Nothing reads this yet (see `SoundEvent.intensity`), and when something does, this line
      // is wrong as written: `radius` here is pre-material, so §3.9's voice never reaches it.
      intensity: 0.95 + 0.35 * ((radius - 8) / 6),
      mat: event.mat,
    });
  };

  /**
   * One noise the hand made, priced and put on the bus (§3.3's two throwable rows).
   *
   * The whole of M2's emit policy, in one function, next to the footstep's. Four decisions live
   * here and nowhere else:
   *
   *  - **The wind-up is the player.** `source: 'player'` and the local emitter id, because it is
   *    the rig's own arm — as much "you" as a footstep — so §3.8's Halo flares for it, faintly
   *    (2.5 m). Both stages emit the same event; they are 0.9 s apart and the first coincides
   *    with the keypress, so which is which is never in doubt.
   *  - **A sphere is not the player.** `source: 'prop'` and an emitter id well clear of the local
   *    one (`SPHERE_EMITTER_BASE`), because `onOwnNoise` decides the Halo on emitter alone: a
   *    sphere emitting as the player would make the ring claim *you* were audible at 32 m the
   *    moment your sphere went off across the room.
   *  - **Off the face it struck.** The boom is stood off along the contact normal by
   *    `BOOM_STANDOFF`; see that constant for the measurement that makes it load-bearing.
   *  - **No material, ever.** The boom is the sphere's own voice, not the surface's, so it names
   *    no material and the bus scales neither of its radii (`CONTACT_CLASSES` gives the argument
   *    in full). Naming one here would throw, which is the point: the refusal is structural
   *    rather than a convention this function is trusted to keep.
   */
  private emitSphereSound(s: SphereSound): void {
    if (s.kind === 'windup') {
      this.bus.emit({
        class: 'throw-windup',
        source: 'player',
        emitter: PLAYER_EMITTER_ID,
        x: s.x,
        y: s.y,
        z: s.z,
      });
      return;
    }
    this.bus.emit({
      class: 'sphere-boom',
      source: 'prop',
      emitter: SPHERE_EMITTER_BASE + s.sphere,
      x: s.x + s.nx * BOOM_STANDOFF,
      y: s.y + s.ny * BOOM_STANDOFF,
      z: s.z + s.nz * BOOM_STANDOFF,
    });
  }

  /** Emits a ping and starts the shared cooldown. Public so the dev panel can push the button. */
  firePing(kind: 'q-ping' | 'e-ping'): void {
    const p = this.player.position;
    if (kind === 'q-ping') {
      this.bus.emit({
        class: 'q-ping',
        source: 'player',
        emitter: PLAYER_EMITTER_ID,
        x: p.x,
        y: p.y + Q_PING_HEIGHT,
        z: p.z,
      });
    } else {
      const cp = Math.cos(this.player.pitch);
      this.aim.set(
        -Math.sin(this.player.yaw) * cp,
        Math.sin(this.player.pitch),
        -Math.cos(this.player.yaw) * cp,
      );
      this.bus.emit({
        class: 'e-ping',
        source: 'player',
        emitter: PLAYER_EMITTER_ID,
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

  /**
   * How far away the body can be heard right now, metres — §3.3's right-hand column for the
   * gait it is currently in, on the surface it is currently on, with §3.9's voice applied.
   *
   * Zero while the body is silent (still, airborne, mid-climb), which is the honest answer and
   * the most important single reading the Halo gives: nothing can hear you.
   *
   * Every part of the number comes from somewhere that already had to be right — the tier from
   * the controller's own gait ladder, the surface from the box the collision pass resolved
   * against, the radius from the bus that will emit the footfall. Nothing here recomputes §3.9.
   */
  audibleRadius(): number {
    const tier = this.player.stepTier;
    if (tier === null) return 0;
    return this.bus.carryRadius(stepClassOf(tier), this.player.groundMaterial);
  }

  /**
   * The ears, and the shell they are mounted in, moved to where the body is.
   *
   * Two calls because they answer two questions: the listener is a point at eye height and gates
   * what is heard, the shell is a cylinder standing on the floor and gates what the event layer
   * is allowed to draw a marker inside (`PaintSystem.insideOwnBody`). Both are set here, on the
   * same line of the tick, because a shell that lagged the ears by a frame would suppress markers
   * around where the rig *was*.
   */
  private syncListener(): void {
    const p = this.player.position;
    this.paint.setListener(p.x, p.y + E_PING_HEIGHT, p.z);
    const m = this.movement;
    const height = this.player.state.stance === 'crouch' ? m.crouchHeight : m.standHeight;
    this.paint.setBody(p.x, p.y, p.z, m.radius, height);
  }

  // ---- the tick ------------------------------------------------------------

  /**
   * One fixed simulation tick, in the order it has always run in.
   *
   * **The order is load-bearing and it is silent when broken** — nothing here throws, the numbers
   * just quietly stop meaning what they said. The shape of it is: bring the whole world up to
   * *this* instant first (clock, bus stamp, ears, reveal), and only then let anything emit.
   *
   *  - `bus.setTime` before any emission, or events carry the previous tick's timestamp and every
   *    wavefront arrives a frame early.
   *  - `syncListener` before any emission, or the hearing gate (§3.1) answers for a body that is
   *    not there — most visibly across a respawn, which moves the ears 20 m mid-tick.
   *  - `paint.advance` before `handle`, or the reveal stamps arrivals off the last tick's clock.
   *  - the cooldown decrements *before* the ping fires, so the ping the decrement just enabled
   *    starts its own 0.75 s from the top rather than a tick short of it.
   *  - `player.update` last, so a ping is asked from the body the tick started with.
   *
   * Each of those five is pinned by a test in `tests/headless.test.ts`; each was checked by
   * making the reordering and watching the right test go red.
   *
   * The Halo is advanced after all of it, and is the one thing here that is not part of that
   * order: it emits nothing, so it cannot disturb what anything else hears, and reading it last
   * is what makes it describe the tick that just ran rather than the one before. It is advanced
   * on the *raw* `dt` and not the paint clock — T scales how fast the world's memory ages, and
   * how loud the player is right now is not a thing that ages.
   */
  tick(dt: number, input: GameInputSource): void {
    this.paintTime += dt * TIME_SCALES[this.timeScaleIndex]!;
    this.bus.setTime(this.paintTime);
    this.syncListener();
    this.paint.advance(this.paintTime);

    if (input.wasKeyPressed('KeyR')) {
      this.player.respawn();
      // The body and whatever it has in the air are one situation, and R restarts it.
      this.spheres.reset();
    }
    if (input.wasKeyPressed('KeyT')) {
      this.timeScaleIndex = (this.timeScaleIndex + 1) % TIME_SCALES.length;
    }
    if (input.wasKeyPressed('KeyK')) this.paint.clear();

    if (this.pingCooldown > 0) this.pingCooldown -= dt;
    if (this.pingCooldown <= 0) {
      if (input.wasKeyPressed('KeyQ')) this.firePing('q-ping');
      else if (input.wasKeyPressed('KeyE')) this.firePing('e-ping');
    }

    /*
     * The hand runs before the body, on the pose the tick started with — the same rule the pings
     * follow, so a throw goes where the player was looking when they let go.
     *
     * The drain is the seam: `update` fills a queue and emits nothing, and this loop is the only
     * thing that turns a sphere's contact into a sound.
     */
    this.spheres.update(dt, input);
    for (const s of this.spheres.sounds) this.emitSphereSound(s);

    this.player.update(dt, input);
    this.halo.advance(this.audibleRadius(), dt);
  }

  // ---- readouts ------------------------------------------------------------

  /** The paint clock, seconds. Scaled by T, which is why it is not the wall clock. */
  get clock(): number {
    return this.paintTime;
  }

  /** Current multiplier the paint clock runs at. */
  get timeScale(): number {
    return TIME_SCALES[this.timeScaleIndex]!;
  }

  /** Seconds until the next ping is allowed; 0 means ready. */
  get pingCooldownSeconds(): number {
    return Math.max(0, this.pingCooldown);
  }

  /** Read-only structured state for the screenshot driver and for manual debugging. */
  debugState(): Record<string, unknown> {
    const s = this.player.state;
    const last = this.bus.lastEvent;
    const diag = this.paint.diagnostics();
    const st = this.paint.structured.getStats();
    const d = this.paint.structured.diagnostics();
    const t = this.paint.structured.tunables;
    return {
      // --- the run. `seedExplicit` false means the streams are on their historical constants,
      // which is why `seed` alone is not enough to tell you which world you are in.
      seed: this.seed.seed,
      seedExplicit: this.seed.explicit,
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
      // --- the pose the camera will be built from. The render camera's own numbers are
      // presentation and are added by `Game.debugState`.
      view: this.player.viewMode,
      viewBlend: this.player.viewBlend,
      boom: this.player.boomLength,
      boomRest: this.player.boomRest,
      landDip: this.player.landDipOffset,
      landDipPeak: this.player.landDipPeakOffset,
      // --- sound
      soundEvents: this.bus.emitted,
      // Emission rate, as observability rather than as a limit — the bus never drops anything,
      // so a flood is an emitter bug and these are what make it loud. One player emits at most a
      // couple a tick; M2's spheres and M4's spiders are the ones worth watching.
      soundEmittedThisTick: this.bus.emittedThisTick,
      soundMaxEmittedPerTick: this.bus.maxEmittedPerTick,
      lastEvent: last?.class ?? null,
      lastEventSeq: last?.seq ?? -1,
      lastEventTime: last?.time ?? -1,
      lastEventSpeed: last?.waveSpeed ?? 0,
      lastEventRadius: last?.paintRadius ?? 0,
      // Where it happened. Published because a sound is the only thing in this game that decides
      // *where* the light lands, and the browser suite has to aim a measurement window at that
      // place to photograph it — a boom eight metres out and a boom at your boots unlock the
      // same dot count and are the entire difference the throw verb sells (`tools/shoot.mjs`).
      lastEventX: last?.x ?? 0,
      lastEventY: last?.y ?? 0,
      lastEventZ: last?.z ?? 0,
      pingCooldown: this.pingCooldownSeconds,
      // --- the hand (§M2). `chargeT` is seconds of wind-up, not a fraction: the charge curve is
      // authored in seconds and a fraction would hide the cap. `spherePoses` is what lets the
      // browser suite project a sphere onto the screen and check the light lands where it does.
      carriedSpheres: this.spheres.carried,
      chargeT: this.spheres.charge,
      chargeFraction: this.spheres.chargeFraction,
      charging: this.spheres.charging,
      throwSpeed: this.spheres.pendingSpeed,
      spheresThrown: this.spheres.thrown,
      spheresRefused: this.spheres.refused,
      worldSpheres: this.spheres.inWorld,
      spherePoses: this.spheres.spheresSnapshot(),
      sphereRecharge: this.spheres.rechargeSeconds,
      sphereRebuild: this.spheres.rebuildFraction,
      eConeDeg: this.sound.classes['e-ping'].coneAngleDeg,
      eRange: this.sound.classes['e-ping'].paintRadius,
      hearingRange: this.paint.perception.hearingRange,
      // --- the Halo (§3.8). `haloRadius` is the glided reading both faces of the readout are
      // drawn from; `haloTarget` is where it is heading, so a driver can see the glide happening
      // rather than only its endpoints.
      haloRadius: this.halo.radius,
      haloTarget: this.halo.targetRadius,
      haloHz: this.halo.pitchHz,
      haloBrightness: this.halo.brightness,
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
      // --- clock
      paintTime: this.paintTime,
      paintTimeScale: this.timeScale,
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
    this.unsubscribeHalo();
    this.unsubscribePlayer();
    this.bus.dispose();
    this.paint.dispose();
    this.room.dispose();
    this.world.clear();
  }
}
