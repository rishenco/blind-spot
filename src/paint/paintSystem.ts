/**
 * The paint system — the thing that turns sound into everything the player ever sees.
 *
 * Vision §3.1: the world is black, and the only reason any of it is on screen is that a noise
 * reached it. This class is the whole of that pipeline's *shared* half — the part that belongs
 * to the sound rather than to how the sound is drawn:
 *
 *  - the **hearing gate** (§3.1). An event outside your own hearing range paints you nothing,
 *    whatever it did to the room. No free intel, ever.
 *  - the **event layer** (§3.2): a transient amber marker at the origin of a noise you made,
 *    fading in a couple of seconds. It answers "what just happened"; the matter layer answers
 *    "what is there", and the two never share a palette.
 *  - the **wavefront**. Nothing an event reveals exists before the front has physically reached
 *    it, so every reveal is stamped `event.time + distance / waveSpeed` and the answer arrives
 *    at the speed the sound travels. The live fronts are published for the dust field, for the
 *    reveal shaders and for the HUD.
 *  - the **firing streak** of an E-ping, and the **suspended dust** the front lights on its way.
 *
 * The reveal itself — what the room actually looks like once a sound has found it — belongs to
 * `structured.ts`, which is handed each heard event and answers it by *unlocking* the geometry
 * the sound reached. That is the only representation this branch has, and it is deliberate: the
 * stochastic blip clouds the prototype compared it against are gone, along with the machinery
 * for switching between them.
 */

import * as THREE from 'three';
import type { StaticWorld } from '../core/collision';
import { DEFAULT_DUST_SEED, makeRng } from '../core/rng';
import { SoundBus, type SoundClass, type SoundEvent } from './soundEvents';
import { type AgeRamp, defaultAgeRamp } from './ageRamp';
import { MAX_LIVE_WAVES, TracerStreaks, WaveDust, type LiveWave } from './waveFx';
import {
  StructuredPaint,
  defaultStructuredTunables,
  type StructuredTunables,
} from './structured';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * The wave's own numbers: how a refresh eases, what the firing looks like, and whether the air
 * shows the front. Speeds live on the sound classes (`WAVE_SPEEDS`), because how fast a noise
 * travels is a property of the noise, not of how we draw it.
 */
export interface WaveTunables {
  /**
   * How long a *known* surface takes to ease from its old age to its refreshed one, seconds.
   *
   * The whole of the silent refresh. It never dims, never flashes and never waits for the new
   * front — it just gets younger over this long, so re-hearing a place you already know
   * brightens it smoothly instead of re-scanning it.
   */
  refreshSeconds: number;
  /**
   * How young a *footstep* is allowed to make paint it has already painted, in units of the
   * ramp's white band (0 = all the way to ice-white, 1 = the end of the band, 2 = a band past
   * it).
   *
   * The sprint blotch, in one number. Steps fire three or four times a second and each one used
   * to walk the age of everything inside its radius back to zero — and zero is the ice-white end
   * of the ramp, which the ramp deliberately lingers on. Sprinting over floor painted a minute
   * ago therefore stamped footfall-shaped patches of white onto cooled cyan, four times a
   * second, and the eye reads that as strobing however smoothly the age underneath it eased.
   *
   * A step is not a question. It is allowed to say "still here" — to hold the paint at the
   * *bottom* of the white band, fresh cyan, clearly newer than the floor either side of the lane
   * — and it is not allowed to say "look again", because the player did not ask. Pings and
   * landings keep the full refresh (floor 0) and re-whiten what they reach, which is precisely
   * the difference in price between a footfall and a deliberate act. Zero here restores the old
   * behaviour exactly, for the comparison.
   */
  stepFloor: number;
  /**
   * Where a refresh starts fading out, as a fraction of the event's own paint radius.
   *
   * Every point inside the radius used to take the whole refresh and every point outside it took
   * none, which is a border — and a border on a footfall is a footprint stencilled onto the
   * floor. Past this fraction the refresh tapers to nothing at the rim, so what a step leaves
   * behind is a soft brightening in the middle of the paint it already owns rather than a patch
   * with an edge. 1 is the old hard-edged behaviour.
   */
  featherStart: number;
  /** Lifetime of the E-ping's tracer streak, seconds. */
  tracerSeconds: number;
  /** How far ahead of the rig the fan begins, metres. */
  tracerStart: number;
  /** How far along the aim the streak reaches from there, metres. */
  tracerLength: number;
  /** How far below the emission point the fan starts, metres — a small drop puts it under the
   *  reticle instead of concentric with it, which reads as coming from the rig. */
  tracerDrop: number;
  /** Streak gain. Dim on purpose: this is a question being asked, not a shot being fired. */
  tracerBrightness: number;
  /** Whether suspended particulate shows the front crossing empty air. */
  dust: boolean;
  /** Mote gain. */
  dustGain: number;
  /** Mote diameter, world metres. */
  dustSize: number;
  /** Thickness of the lit shell behind the front, metres. Distance, never time: the shell must
   *  look the same at 25 m/s and at 45 m/s or the fast beam reads as a filled cone. */
  dustShell: number;
}

export function defaultWaveTunables(): WaveTunables {
  return {
    refreshSeconds: 0.3,
    stepFloor: 1,
    featherStart: 0.55,
    tracerSeconds: 0.25,
    tracerStart: 1.4,
    tracerLength: 3.2,
    tracerDrop: 0.05,
    tracerBrightness: 0.55,
    /*
     * Off by default (playtest). The lit air is a real effect and a genuinely pretty one, but at
     * 17 motes per m³ what it actually reads as in play is a shell of grain crossing the room
     * *in front of* the answer — a second thing arriving, on every ping, competing with the
     * geometry for the eye. The switch stays; the default is quiet. Off costs exactly nothing:
     * the field's object is `visible = false` and never enters the draw list.
     */
    dust: false,
    dustGain: 1.7,
    dustSize: 0.02,
    dustShell: 2.0,
  };
}

/** What the rig itself can hear and how much of what it knows it draws. */
export interface PerceptionTunables {
  /** §3.1: paint is only received from events inside your own hearing range, metres. */
  hearingRange: number;
  /** §3.6: only geometry within this radius of the listener is drawn, metres. */
  windowRadius: number;
  /**
   * Minimum wall-clock gap between chunks of reveal work, ms — what makes it one chunk per
   * frame.
   *
   * Unlocking a beam's worth of lattice is tens of thousands of point-in-radius tests, and law 5
   * says movement never pays for information, so the work is amortised. It is only possible
   * *because* of the wave: a surface's arrival stamp comes from the event's own time and the
   * distance to it, so geometry reached three frames late still lights at exactly the instant
   * the front gets there, and no one can tell.
   */
  chunkGapMs: number;
}

export function defaultPerceptionTunables(): PerceptionTunables {
  return {
    hearingRange: 18,
    windowRadius: 45,
    chunkGapMs: 6,
  };
}

/** True for the classes a body makes by moving, as opposed to the ones a player chooses to make. */
function isStep(cls: SoundClass): boolean {
  return cls === 'crouch-step' || cls === 'walk-step' || cls === 'sprint-step';
}

/**
 * The youngest age a class's refresh may hand to geometry that is already known, in seconds.
 *
 * A footfall is not allowed to look like news: `stepFloor` is authored in bands of the ramp's
 * white stage, so one setting means one colour. Pings and landings return 0 — they re-whiten
 * everything they reach, which is exactly the difference in price between a footfall and a
 * deliberate act.
 */
function floorAgeFor(cls: SoundClass, wave: WaveTunables, ramp: AgeRamp): number {
  return isStep(cls) ? ramp.freshSeconds * wave.stepFloor : 0;
}

/**
 * Event-layer palette (§3.2): self is amber, and the pings are the same self, brighter.
 *
 * The `prop-*` rows and `sphere-boom` are §3.2's pale yellow, which is the right *colour*
 * arriving by the wrong road — this table is keyed on the class and §3.2's palette is keyed on
 * the source, and the two only agree because no player-made class is a prop and no prop-made
 * class is a rig's. That coincidence ends the moment anything else can set a prop off, and
 * `eventTint` (`soundEvents.ts`) is the function that already answers the question properly and
 * that nothing calls. Wiring it is a separate job with its own screenshots; what is here is the
 * honest minimum, so a sphere going off does not render as the player's own footstep.
 *
 * `sphere-boom` is the brightest of that family and deliberately the brightest marker in the
 * table: it is the loudest single thing the player can put anywhere, and the marker is the only
 * part of it drawn at a place rather than across the geometry it reached.
 *
 * `throw-windup` stays in the amber family and at the bottom of it, because it *is* the rig: the
 * arm winding up is the player making a noise, exactly as a crouch-step is, and it is the
 * quietest thing either of them does. In practice it is never drawn — its origin is the rig's own
 * hand, which `handle` refuses markers inside — and it keeps a row because the table is total.
 */
const EVENT_COLORS: Record<SoundClass, number> = {
  'crouch-step': 0xd98a2b,
  'walk-step': 0xffa63c,
  'sprint-step': 0xffb95a,
  landing: 0xffd08a,
  'q-ping': 0xffe6b4,
  'e-ping': 0xfff0cc,
  'prop-impact': 0xf2df9a,
  'prop-knock': 0xd9c47e,
  'throw-windup': 0xd98a2b,
  'sphere-boom': 0xfff2c0,
};

/** How many event-layer markers can be alive at once. */
const EVENT_CAPACITY = 512;
/**
 * Event marker fade, seconds (§3.2 asks for 2.5-6 s).
 *
 * Exported because it bounds something outside its own layer. The event marker and the matter
 * layer's white band are the same claim made twice — "this happened just now" — one at the
 * origin of the sound and one across the geometry it reached. If the white band outlived the
 * marker, geometry would still be shouting *new* after the sound that painted it had gone, and
 * the two layers §3.2 keeps deliberately separate would be telling the player different times
 * for the same event. So this is the ceiling on `AgeRamp.freshSeconds`, and
 * `tests/ageRamp.test.ts` holds the ramp to it.
 */
export const EVENT_FADE = 2.5;
/** Event marker diameter, world metres. */
const EVENT_SIZE = 0.55;

/**
 * Motes in the dust field, and the side of the cube they wrap around the listener in.
 *
 * These two are really one number — motes per m³ — because that is what decides how many grains
 * a passing shell actually lights, and the count in view is what makes it read as a front rather
 * than as noise. The shell's lit volume grows as r², so a field big enough to cover a 22 m beam
 * is a field too thin to see: 48k motes in a 14 m cube is 17 per m³, a few hundred grains at the
 * front, at the price of the effect being a near-field one. That is the right trade — past a few
 * metres the front is already carried by the geometry it is drawing, and dust that dims with
 * distance is what suspended particulate actually does.
 */
const DUST_COUNT = 48_000;
const DUST_EXTENT = 14;

/** Birth stamp meaning "nothing was ever known here". */
const NEVER = -1e9;

/** Colours are authored in sRGB and written straight to the framebuffer by the raw shaders. */
function rawColor(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
}

const EVENT_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uFade;
  uniform float uProjScale;
  uniform float uSizeWorld;

  attribute float aBirth;
  attribute float aScale;
  attribute vec3  aColor;

  varying float vT;
  varying vec3  vColor;

  void main() {
    vT = (uTime - aBirth) / max(0.001, uFade);
    vColor = aColor;
    if (vT < 0.0 || vT >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float grow = 0.6 + 0.55 * smoothstep(0.0, 0.4, vT);
    gl_PointSize = clamp(uSizeWorld * aScale * grow * uProjScale / max(0.001, -mv.z), 4.0, 72.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const EVENT_FRAGMENT = /* glsl */ `
  precision highp float;
  varying float vT;
  varying vec3  vColor;

  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    float core = 1.0 - smoothstep(0.0, 0.4, r);
    float glow = pow(1.0 - r, 2.5);
    float fade = 1.0 - vT;
    float a = (core * 0.85 + glow * 0.5) * fade * fade;
    gl_FragColor = vec4(vColor * (0.55 + 0.6 * core), a);
  }
`;

// ---------------------------------------------------------------------------

/** What the newest front is doing, for the HUD and for tooling. */
export interface PaintDiagnostics {
  /** True while the newest event's front is still expanding. */
  waveLive: boolean;
  /** Radius the newest front has reached, metres. */
  waveFront: number;
  /** That front's full paint radius. */
  waveRange: number;
  /** 0-1 along its travel. */
  waveProgress: number;
}

export class PaintSystem {
  readonly perception: PerceptionTunables;
  readonly ramp: AgeRamp;
  readonly wave: WaveTunables;
  /** The reveal itself: exact geometry, unlocked by sound. */
  readonly structured: StructuredPaint;
  private readonly eventPositions = new Float32Array(EVENT_CAPACITY * 3);
  private readonly eventColors = new Float32Array(EVENT_CAPACITY * 3);
  private readonly eventBirths = new Float32Array(EVENT_CAPACITY);
  private readonly eventScales = new Float32Array(EVENT_CAPACITY);
  private eventIndex = 0;
  private readonly eventGeometry = new THREE.BufferGeometry();
  private readonly eventMaterial: THREE.ShaderMaterial;
  private readonly eventPoints: THREE.Points;

  private readonly waves: LiveWave[] = [];
  private readonly tracer: TracerStreaks;
  private readonly dust: WaveDust;

  private readonly root = new THREE.Group();

  private time = 0;
  private readonly listener = new THREE.Vector3();
  /**
   * The rig's own shell: feet at `y`, `radius` across, `height` tall. Zero until something says
   * otherwise, which is what makes the guard below inert for a `PaintSystem` nobody has told
   * about a body (a unit test, a tool staging events by hand).
   */
  private readonly body = { x: 0, y: 0, z: 0, radius: 0, height: 0 };
  private readonly viewportSize = new THREE.Vector2();
  private readonly scratchColor = new THREE.Color();
  private projScale = 500;

  /** The refresh floor the newest event carried — published so a test can read the policy. */
  private lastRefreshFloor = 0;

  private diag: PaintDiagnostics = {
    waveLive: false,
    waveFront: 0,
    waveRange: 0,
    waveProgress: 1,
  };
  private diagTime = Number.NaN;

  constructor(
    world: StaticWorld,
    options: {
      perception?: PerceptionTunables;
      ramp?: AgeRamp;
      wave?: WaveTunables;
      structured?: StructuredTunables;
      /** Seeds for the two random streams; omitted means "the constant this has always used". */
      latticeSeed?: number;
      dustSeed?: number;
    } = {},
  ) {
    this.perception = options.perception ?? defaultPerceptionTunables();
    this.ramp = options.ramp ?? defaultAgeRamp();
    this.wave = options.wave ?? defaultWaveTunables();
    this.structured = new StructuredPaint(
      world,
      this.ramp,
      options.structured ?? defaultStructuredTunables(),
      options.latticeSeed,
    );

    this.eventGeometry.setAttribute('position', new THREE.BufferAttribute(this.eventPositions, 3));
    this.eventGeometry.setAttribute('aColor', new THREE.BufferAttribute(this.eventColors, 3));
    this.eventGeometry.setAttribute('aBirth', new THREE.BufferAttribute(this.eventBirths, 1));
    this.eventGeometry.setAttribute('aScale', new THREE.BufferAttribute(this.eventScales, 1));
    this.eventGeometry.setDrawRange(0, 0);
    this.eventBirths.fill(NEVER);

    this.eventMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: EVENT_FADE },
        uProjScale: { value: 500 },
        uSizeWorld: { value: EVENT_SIZE },
      },
      vertexShader: EVENT_VERTEX,
      fragmentShader: EVENT_FRAGMENT,
      transparent: true,
      // The reveal is memory, not line of sight (§3.6): it draws through walls, and nothing
      // else in this scene writes depth anyway.
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.eventPoints = new THREE.Points(this.eventGeometry, this.eventMaterial);
    this.eventPoints.frustumCulled = false;
    this.eventPoints.renderOrder = 3;

    this.tracer = new TracerStreaks(rawColor(EVENT_COLORS['e-ping']));
    this.tracer.setLook(this.wave.tracerSeconds, this.wave.tracerBrightness);
    const dustSeed = options.dustSeed ?? DEFAULT_DUST_SEED;
    this.dust = new WaveDust(DUST_COUNT, DUST_EXTENT, makeRng(dustSeed));
    this.dust.setLook(this.wave.dustGain, this.wave.dustSize, this.wave.dustShell);

    this.root.add(this.eventPoints, this.tracer.object, this.dust.object, this.structured.object);
    this.structured.setActive(true);
    this.applyTunables();
  }

  /** The object to add to the scene. */
  get object(): THREE.Object3D {
    return this.root;
  }

  /** Pushes ramp/window/wave edits from the dev panel into the shaders. */
  applyTunables(): void {
    this.tracer.setLook(this.wave.tracerSeconds, this.wave.tracerBrightness);
    this.dust.setLook(this.wave.dustGain, this.wave.dustSize, this.wave.dustShell);
    this.structured.applyLook(
      this.perception.windowRadius,
      this.wave.refreshSeconds,
      this.wave.featherStart,
    );
  }

  /**
   * Advances the paint clock and everything derived from it: which fronts are still expanding,
   * how much outstanding reveal work gets done this frame, and what the air between them looks
   * like. The game owns the clock so it can be scaled for ageing and wave-travel tests.
   */
  advance(seconds: number): void {
    this.time = seconds;
    this.eventMaterial.uniforms.uTime!.value = seconds;
    this.tracer.setTime(seconds);
    this.structured.advance(seconds, this.perception.chunkGapMs);

    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i]!;
      if ((seconds - w.t0) * w.speed > w.radius) this.waves.splice(i, 1);
    }
    this.dust.update(seconds, this.listener, this.waves, this.wave.dust);
  }

  get clock(): number {
    return this.time;
  }

  /** Where the ears are: gates which events are heard and which geometry is drawn. */
  setListener(x: number, y: number, z: number): void {
    this.listener.set(x, y, z);
    this.structured.setListener(x, y, z);
  }

  /**
   * Where the ears currently are. Read-only by convention (it is the live vector, not a copy —
   * this is a tick path). Exposed so a test can prove *when* in the tick the ears were moved:
   * the hearing gate answers a different question if the listener lags the body by a frame.
   */
  get listenerPosition(): THREE.Vector3 {
    return this.listener;
  }

  /**
   * Where the rig's own shell is: feet at (x, feetY, z), `radius` across, `height` tall.
   *
   * Separate from `setListener` because they are different things measured from different
   * places — the ear is a point at eye height, the shell is a cylinder standing on the floor —
   * and the one rule that reads this (`insideOwnBody`) is a rule about the *volume*. Set to a
   * zero radius, or never set at all, and that rule is inert.
   */
  setBody(x: number, feetY: number, z: number, radius: number, height: number): void {
    this.body.x = x;
    this.body.y = feetY;
    this.body.z = z;
    this.body.radius = radius;
    this.body.height = height;
  }

  /**
   * Recomputes the world-units-to-pixels factor for `gl_PointSize`. Depends on the vertical
   * FOV and the drawing buffer height, so it is refreshed every frame rather than cached.
   */
  updateView(camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.viewportSize);
    this.projScale = (camera.projectionMatrix.elements[5] ?? 1) * this.viewportSize.y * 0.5;
    this.eventMaterial.uniforms.uProjScale!.value = this.projScale;
    this.dust.setProjScale(this.projScale);
    this.structured.setProjScale(this.projScale);
  }

  /** Forgets the whole map: nothing has ever been heard. */
  clear(): void {
    this.eventIndex = 0;
    this.eventBirths.fill(NEVER);
    this.eventGeometry.setDrawRange(0, 0);
    this.waves.length = 0;
    this.tracer.clear();
    this.lastRefreshFloor = 0;
    this.diagTime = Number.NaN;
    this.structured.clear();
    this.flushEvents();
  }

  // ---- the hook the bus calls ---------------------------------------------

  handle = (event: SoundEvent): void => {
    /*
     * §3.1: no free intel. An event you cannot hear paints you nothing — and "can hear it" is
     * `SoundBus.canHear`, not a comparison of our own. This used to gate on the rig's 18 m
     * alone, which quietly granted the player paint from sounds that carry two metres. The
     * predicate lives on the bus because the spider will ask it the same question with its own
     * range, and two ears reading §3.3's right column differently is the table becoming fiction.
     */
    if (
      SoundBus.canHear(
        event,
        this.listener.x,
        this.listener.y,
        this.listener.z,
        this.perception.hearingRange,
      )
    ) {
      this.lastRefreshFloor = floorAgeFor(event.class, this.wave, this.ramp);
      /*
       * §3.2's event layer marks *where something happened*, and a place inside your own chassis
       * is not one. The marker is a world-sized sprite, so an origin a few centimetres from the
       * eye covers the screen: the wind-up, emitted at the rig's own hand, drew an amber wash
       * across the middle of the frame every time the arm went back — a readout nobody asked for,
       * in the one place §14 keeps clear, reporting a position the player already occupies.
       *
       * The guard is the volume and not the class, so it protects every emitter that will ever
       * put a sound on the rig: the arm today, a chip active, a revive, an artifact clanging
       * against the rack. The consequence, stated because it is the whole of the change: *no*
       * noise the body makes at the body draws a marker any more — footfalls, landings and both
       * pings all originate inside the shell. None of them were ever visible (a sprite at zero
       * depth is clipped, not drawn), so what this removes is the near-miss cases where the
       * camera's bob put one just far enough away to bloom. The paint and the sound are
       * untouched: the room still lights, the world still hears it, and the Halo still flares.
       */
      if (!this.insideOwnBody(event)) this.addEventMarker(event);
      this.addWave(event);
      if (event.class === 'e-ping') this.fireTracer(event);
      // Everything above this line belongs to the *sound* — the marker, the travelling front,
      // the firing streak. Below it is the reveal: what the room looks like once the sound has
      // found it. The refresh floor is a property of the sound, not of the reveal, so it is
      // handed over rather than re-derived.
      this.structured.handle(event, this.time, this.lastRefreshFloor);
    }
    this.diagTime = Number.NaN;
  };

  /** The floor the newest heard event's refresh carried, seconds. */
  get refreshFloor(): number {
    return this.lastRefreshFloor;
  }

  /**
   * How many event-layer markers have been drawn this run — monotonic, and never reset.
   *
   * Published for the same reason `refreshFloor` is: the guard in `handle` is a *policy* (a
   * sound made inside your own shell is heard and paints, and is not marked), and a policy
   * nothing can read is a policy nothing can hold. The ring buffer clamps the draw range, not
   * this count, so a test can ask "did that event draw a marker" without owning a renderer.
   */
  get eventMarkers(): number {
    return this.eventIndex;
  }

  /** Fronts still expanding, newest last. Read by the dust field and by the diagnostics. */
  get liveWaves(): readonly LiveWave[] {
    return this.waves;
  }

  /** Whether the air is currently showing a front. False costs exactly nothing — the field is
   *  not in the draw list. */
  get dustLit(): boolean {
    return this.dust.object.visible;
  }

  get tracerAlive(): boolean {
    return this.tracer.alive(this.time);
  }

  get tracerAge(): number {
    return this.time - this.tracer.lastFired;
  }

  private addWave(event: SoundEvent): void {
    const omni = event.coneAngleDeg >= 359.9;
    this.waves.push({
      x: event.x,
      y: event.y,
      z: event.z,
      dirX: event.dirX,
      dirY: event.dirY,
      dirZ: event.dirZ,
      cosHalf: omni ? -1 : Math.cos((event.coneAngleDeg * Math.PI) / 360),
      t0: event.time,
      speed: event.waveSpeed,
      radius: event.paintRadius,
      intensity: event.intensity,
    });
    while (this.waves.length > MAX_LIVE_WAVES) this.waves.shift();
  }

  private fireTracer(event: SoundEvent): void {
    this.tracer.fire(
      event.x,
      event.y - this.wave.tracerDrop,
      event.z,
      event.dirX,
      event.dirY,
      event.dirZ,
      this.wave.tracerStart,
      this.wave.tracerLength,
      event.time,
    );
  }

  /** Is this event's origin inside the rig's own shell? See the guard in `handle`. */
  private insideOwnBody(event: SoundEvent): boolean {
    const b = this.body;
    if (!(b.radius > 0)) return false;
    const dy = event.y - b.y;
    if (dy < 0 || dy > b.height) return false;
    const dx = event.x - b.x;
    const dz = event.z - b.z;
    return dx * dx + dz * dz <= b.radius * b.radius;
  }

  private addEventMarker(event: SoundEvent): void {
    const slot = this.eventIndex % EVENT_CAPACITY;
    const i3 = slot * 3;
    this.eventPositions[i3] = event.x;
    this.eventPositions[i3 + 1] = event.y;
    this.eventPositions[i3 + 2] = event.z;
    this.scratchColor.setHex(EVENT_COLORS[event.class], THREE.LinearSRGBColorSpace);
    this.eventColors[i3] = this.scratchColor.r;
    this.eventColors[i3 + 1] = this.scratchColor.g;
    this.eventColors[i3 + 2] = this.scratchColor.b;
    this.eventBirths[slot] = this.time;
    this.eventScales[slot] = Math.min(2.2, 0.6 + event.paintRadius * 0.09);
    this.eventIndex++;
    this.flushEvents();
  }

  private flushEvents(): void {
    this.eventGeometry.setDrawRange(0, Math.min(this.eventIndex, EVENT_CAPACITY));
    for (const name of ['position', 'aColor', 'aBirth', 'aScale']) {
      (this.eventGeometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  diagnostics(): PaintDiagnostics {
    if (this.diagTime === this.time) return this.diag;
    this.diagTime = this.time;

    const d = this.diag;
    const newest = this.waves.length > 0 ? this.waves[this.waves.length - 1]! : null;
    if (newest === null) {
      d.waveLive = false;
      d.waveFront = 0;
      d.waveRange = 0;
      d.waveProgress = 1;
    } else {
      const front = Math.max(0, (this.time - newest.t0) * newest.speed);
      d.waveLive = front <= newest.radius;
      d.waveFront = Math.min(front, newest.radius);
      d.waveRange = newest.radius;
      d.waveProgress = newest.radius > 0 ? Math.min(1, front / newest.radius) : 1;
    }
    return d;
  }

  dispose(): void {
    this.eventGeometry.dispose();
    this.eventMaterial.dispose();
    this.tracer.dispose();
    this.dust.dispose();
    this.structured.dispose();
    this.root.clear();
  }
}
