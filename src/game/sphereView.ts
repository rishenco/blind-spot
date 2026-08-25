/**
 * The sphere you can see: the beacon it lights in the hand and in the air, and the arc it draws
 * while the arm is wound.
 *
 * ## Why this is drawn at all
 *
 * Law 3 says absence is black and §3.1 says every way of learning emits sound, so almost nothing
 * in this game reaches the screen without a sound having put it there. This file is the other
 * thing, and it is not smuggled in: vision §1's **Rig-own instruments** commitment says the rig
 * may show its pilot its own equipment — the Halo, the hands, the spheres in the rack and the one
 * in the air — without a sound having painted it, because a machine is allowed to know where its
 * own parts are. `rigMarker` in `game/game.ts` is the same concession, older.
 *
 * The rule that keeps it honest is the one §1 states: *a rig-own instrument reports only itself —
 * its position, its state, its charge — and never the world.* Both halves of this file are inside
 * that. The beacon telemeters one sphere's coordinates back to its owner; the arc is the charge,
 * drawn as a parabola through empty space. The walls the beacon shines through stay black, and
 * the first thing a sphere ever says about the room is the boom, on the bus, at the speed of
 * sound like everything else. Apply §1's own test — could the pilot learn a fact about the world
 * from this that no event on the bus told them? — and the answer has to stay no, which is
 * `buildArc`'s standing prohibition on world queries.
 *
 * ## Why it is drawn without a depth test
 *
 * Because the alternative answers "where did my sphere go" with silence. Unpainted geometry is
 * not drawn, but it is still *there*, and a depth-tested beacon would vanish behind a wall the
 * player cannot see — indistinguishable from a beacon that had gone out. A pure beacon is
 * lawful here by the rule above: it is a claim about the sphere and never about what is in front
 * of it, and it says nothing about the wall it shines through except that the wall did not stop
 * the rig's own telemetry.
 *
 * ## Why it pulses
 *
 * This is the single feature that makes the whole thing legible, and it is worth being blunt
 * about why. The screen is a field of thousands of static dots. One more static dot is one more
 * dot. A dot that *breathes* at 3 Hz is separable from that field pre-attentively — the eye finds
 * it without looking for it — and it reads as a piece of powered equipment rather than as a
 * fleck of revealed matter. Brightness and not size: a size pulse would make the beacon's screen
 * footprint argue with the distance cue it is otherwise carrying.
 */

import * as THREE from 'three';
import { SPHERE_MUZZLE_M, SPHERE_RADIUS, arcPoints, type SphereReadout } from './spheres';

/**
 * Where the rig carries the next sphere, metres from the eye in the aim's own frame.
 *
 * Down and well out to the side, and that is a design constraint rather than a pose. The centre
 * of this screen is the only instrument the player has: it holds the reticle, §3.8's ring, the
 * rack row, and every blip that answers a question. A permanently lit object anywhere near it
 * would be a light the player has to read *past* for the whole run. So the carry is pushed into
 * the low corner of the view, where the rig's own hardware sits in peripheral vision and the
 * middle of the frame stays the world's.
 *
 * What fixes the beacon *on screen* is the ratio of each offset to the forward one, and these
 * three put it about a third of the way in from the lower-left corner at a 90° vertical field of
 * view. What fixes the distance is the rig's own arm: 62 cm from the eye, which is §8's 60 cm
 * reach and not a number picked to make the picture work. It does make the picture work, though,
 * and that is worth recording because the shorter arm this started on did not. At 27 cm the
 * first tick of flight swept 150 px of screen — one straight streak out of the hand, and a
 * straight streak toward the reticle is the laser `paint/waveFx.ts` forbids. Perspective near
 * the lens is violent, and how violent is set by how far out the near end starts.
 */
const HAND_FORWARD = 0.4;
/** Negative is the rig's left: the off hand, so the throwing side of the view stays clear. */
const HAND_RIGHT = -0.415;
const HAND_UP = -0.218;

/** How many beacons may be lit at once — a full rack in the air, plus the one in the hand. */
const MAX_BEACONS = 12;

/**
 * The beacon's screen size, px, and the world size it is derived from.
 *
 * A 6 cm sphere at 20 m subtends about two pixels, which is a beacon that cannot be found. So
 * the sprite has a floor: it shrinks with distance down to `BEACON_MIN_PX` and no further, which
 * keeps the core (the inner 38 % of the sprite) at about four pixels across at any range. The
 * ceiling is the other end of the same problem — the carried sphere sits 40 cm in front of the
 * lens, where true size is 260 px of screen and the readout would be a wall.
 *
 * `BEACON_WORLD` is the sphere's own diameter with room for the halo around it, so between the
 * two clamps the beacon really is scaled by distance and really does read as approaching.
 */
const BEACON_WORLD = SPHERE_RADIUS * 2 * 2.4;
const BEACON_MIN_PX = 11;
const BEACON_MAX_PX = 26;

/** Pulse rate, Hz, and the fraction of full brightness the trough sits at. */
const BEACON_PULSE_HZ = 3;
const BEACON_PULSE_FLOOR = 0.42;

const BEACON_VERTEX = /* glsl */ `
  uniform float uProjScale;
  uniform float uSize;
  uniform vec2  uPxRange;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * uProjScale / max(0.05, -mv.z), uPxRange.x, uPxRange.y);
  }
`;

/**
 * A white-hot core inside a tight warm halo.
 *
 * White because it has to be unmistakable against both of §3.2's layers at a glance: the matter
 * band is cyan-family from ice-white through to navy, and the event layer's self marker is
 * amber. A beacon in either family would be read as a blip. White belongs to neither — and the
 * halo is warm rather than amber-warm so that the two never trade places at the edge of vision.
 */
const BEACON_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uPulse;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    float core = 1.0 - smoothstep(0.30, 0.46, r);
    float halo = exp(-r * r * 5.0) * 0.55;
    float a = (core + halo) * uPulse;
    if (a < 0.004) discard;
    vec3 col = vec3(1.0) * core + vec3(1.0, 0.84, 0.62) * halo;
    gl_FragColor = vec4(col * uPulse, 1.0);
  }
`;

/**
 * How long a preview is, in ticks, at no charge and at full tension.
 *
 * **This is the charge meter, and there is no other one.** `game/spheres.ts` makes the argument
 * for why there is no bar: the wind-up is audible exactly twice and between them the player
 * estimates. What the arc adds is the *spatial* half of that estimate — where a release right now
 * would put the sound — and it has to grow with the charge or it is answering a question about
 * some other throw. Between these two the drawn line goes from 2.3 m to 15.5 m of world, because
 * the launch speed is climbing over the same stretch — and see `ARC_DOT_K` for why that is a
 * reading the player takes off the arc's *shape* and its landing rather than off its length in
 * pixels, which perspective flattens almost out of existence.
 */
const ARC_TICKS_MIN = 36;
const ARC_TICKS_MAX = 96;

/**
 * The dot pattern: how far apart the beads of the preview are, as a fraction of the distance
 * that piece of the arc already is from the eye, and how much that spacing opens out by the far
 * end.
 *
 * **Dots, never a continuous line.** `paint/waveFx.ts` states the rule for the E-beam tracer —
 * "it is not a laser and must never read as one: the player is asking a question, not shooting" —
 * and a solid line leaving the hand toward the reticle is exactly the thing that rule forbids. A
 * broken line reads as a plotted path; an unbroken one reads as a sight.
 *
 * **Beads rather than dashes, because a WebGL line is one pixel wide and cannot be made wider.**
 * `linewidth` is ignored on every platform this ships to, and a one-pixel diagonal spends most of
 * its brightness on coverage: measured against this room, a dashed arc peaked around 70/255 while
 * the cyan contour lines it has to be read against sit near 200. Dim is the intent; three times
 * dimmer than the geometry is not, and it is not a thing more alpha can fix, because the alpha was
 * already nearly saturated. A point sprite is sized in pixels, so the preview gets to be legible
 * without getting to be a line.
 *
 * **The period goes as the square of depth, which is what makes the pattern even on screen.** A
 * gap of a fixed number of ticks is 6 cm of world at the hand and 6 cm of world at fifteen metres,
 * and those are 150 px and 2 px of screen: the near end fuses into a streak and the far end into a
 * solid thread. Scaling it by depth is the obvious correction and it is not enough, because almost
 * all of this arc's travel is *along* the view axis rather than across it: a bead's distance from
 * the vanishing point goes as one over depth, so evenly-spaced screen beads want evenly-spaced
 * **inverse** depths, and that asks for a period going as depth squared. Measured, it delivers a
 * 27–30 px bead pitch from the hand to the far end at every charge, against 64 px falling to 10 px
 * for the linear rule.
 *
 * `ARC_SPREAD` opens the period out a little along the arc, and the alpha falls to nothing on top
 * of it, so the far end thins and dissolves instead of stopping. The arc is a vacuum parabola and
 * its far end is the part real geometry is most likely to have already interrupted; a hard endpoint
 * would be a promise — *it lands exactly here* — that a preview which has asked the world nothing
 * is in no position to make.
 *
 * What this pattern deliberately does *not* try to do is make the charge readable as screen
 * length. It cannot be: perspective converges every ballistic arc on the same vanishing point, so
 * a 2.3 m stub runs 310 px out from the hand and a 15.5 m throw only 388. What separates them on
 * screen is *shape* — the tap's beads dive, the full throw's flatten out sixty pixels higher up
 * the frame — and what separates them in the world is the reach itself, read against whatever
 * geometry the room has already painted. That is the charge meter; the pixels are only how it is
 * delivered.
 */
const ARC_DOT_K = 0.07;
const ARC_SPREAD = 0.8;
/** The shortest period, ticks — a progress guarantee, not a look. */
const ARC_SPAN_FLOOR = 0.25;
/** Bead diameter, px — under half the beacon's floor: the preview is smaller than its subject. */
const ARC_DOT_PX = 5;
/** Peak alpha at the near end, and the exponent that takes it to zero at the far one. */
const ARC_ALPHA = 0.85;
const ARC_FRAY = 1.1;
/** One vertex a bead; comfortably past what the pattern above produces at full tension. */
const MAX_ARC_DOTS = 96;

/**
 * Seconds of flight over which the arc leaves the hand and rejoins the trajectory.
 *
 * The sphere launches from the eye (`Spheres.launch`) and the preview is drawn from the hand,
 * which is 47 cm away from it. Those cannot both be the near end of one line, so the carry offset
 * is faded out along the arc: the drawn line starts at the hand and is exactly the flown parabola
 * by the time it is half a second out. The half that could mislead anybody — the far end, the
 * part that answers *where will this go* — is the half with no offset left in it, and the near
 * end's error is an arm's length at arm's length, which is not a claim about the world at all.
 *
 * It is also what keeps the preview out of the 40 px keep-out box at the centre of the screen
 * (`CENTRE_SAFE_BOX_PX`, `ui/hud.ts`). An arc drawn from the eye along the aim projects to a
 * plumb line hanging off the reticle — through the ring, through the rack row, and reading as a
 * sight into the bargain. Leaving from the hand instead swings it out to the side, and the
 * quadratic fade holds it clear right through the crossover: measured at a level aim and full
 * tension, the nearest bead to the reticle is 56 px out, against the box's 20
 * (`tools/shoot.mjs` §09b).
 */
const ARC_CARRY_SECONDS = 0.5;

const ARC_VERTEX = /* glsl */ `
  attribute float aAlpha;
  uniform float uDotPx;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Flat in pixels, unlike the beacon: the spacing is already angular, so a bead that shrank
    // with range would make one uniform pattern read as two.
    gl_PointSize = uDotPx;
  }
`;

const ARC_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    float a = vAlpha * (1.0 - smoothstep(0.45, 1.0, r));
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

/** What one frame of the hand looks like, as the browser layer sees it. */
export interface SphereViewFrame {
  /**
   * The eye the hand hangs off — the *render* camera's, not the simulation's.
   *
   * The two differ by the head bob and the landing dip, at most a couple of centimetres. Hung off
   * the simulation's eye instead, the whole readout would swim against the view every time the
   * player walked: two centimetres of disagreement at 40 cm of depth is eighteen pixels of
   * wobble, on the one object that is supposed to be bolted to the rig.
   */
  readonly eye: THREE.Vector3;
  readonly yaw: number;
  readonly pitch: number;
  /** Every sphere in the air, from `Spheres.spheresSnapshot`. */
  readonly live: readonly SphereReadout[];
  /** Spheres in the rack. Zero means there is nothing in the hand to draw. */
  readonly carried: number;
  readonly charging: boolean;
  /** What a release right now would launch at, m/s. */
  readonly speed: number;
  readonly chargeFraction: number;
  /**
   * First person only. From outside, `rigMarker` is the whole rig and a hand beacon hanging in
   * front of the boom camera would be a piece of the rig drawn a couple of metres away from it.
   */
  readonly firstPerson: boolean;
}

/**
 * The beacons and the preview, as one thing the scene can hold.
 *
 * Both live in the browser layer and read the simulation without touching it, the same seam the
 * paint system and the rig marker sit on. Nothing here can emit, and nothing here is asked
 * anything about the world.
 */
export class SphereView {
  readonly object = new THREE.Group();

  /** Where the hand is this frame, world coordinates. Published for tooling; see `debugState`. */
  readonly hand = new THREE.Vector3();
  /** Metres from the eye to the far end of the drawn preview; 0 when the arm is down. */
  reach = 0;

  private readonly beaconGeometry = new THREE.BufferGeometry();
  private readonly beaconMaterial: THREE.ShaderMaterial;
  private readonly beaconPositions = new Float32Array(MAX_BEACONS * 3);
  private readonly beacons: THREE.Points;

  private readonly arcGeometry = new THREE.BufferGeometry();
  private readonly arcMaterial: THREE.ShaderMaterial;
  private readonly arcPositions = new Float32Array(MAX_ARC_DOTS * 3);
  private readonly arcAlphas = new Float32Array(MAX_ARC_DOTS);
  private readonly arcDots: THREE.Points;
  private readonly arcScratch = new Float32Array(ARC_TICKS_MAX * 3);

  /**
   * The pulse's own clock, seconds.
   *
   * Not `GameSim.clock`, which is the *paint* clock and carries T's debug multiplier: at ×60 the
   * beacon would strobe sixty times a second, and the thing T exists to do — watch a wavefront in
   * slow motion — has nothing to do with how fast the rig's own hardware blinks. Not the wall
   * clock either, because a screenshot taken at a named tick has to be the same picture on every
   * host. So it is the fixed step, accumulated.
   */
  private clock = 0;
  private stepSeconds = 1 / 120;

  constructor() {
    this.beaconGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.beaconPositions, 3),
    );
    this.beaconGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.beaconGeometry.setDrawRange(0, 0);
    this.beaconMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uProjScale: { value: 500 },
        uSize: { value: BEACON_WORLD },
        uPxRange: { value: new THREE.Vector2(BEACON_MIN_PX, BEACON_MAX_PX) },
        uPulse: { value: 1 },
      },
      vertexShader: BEACON_VERTEX,
      fragmentShader: BEACON_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.beacons = new THREE.Points(this.beaconGeometry, this.beaconMaterial);
    this.beacons.frustumCulled = false;
    this.beacons.renderOrder = 6;

    this.arcGeometry.setAttribute('position', new THREE.BufferAttribute(this.arcPositions, 3));
    this.arcGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.arcAlphas, 1));
    this.arcGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.arcGeometry.setDrawRange(0, 0);
    this.arcMaterial = new THREE.ShaderMaterial({
      uniforms: {
        // Cool white, and deliberately inside the margin `tools/png.mjs` calls neutral: the
        // preview belongs to the sphere's family, not to the cyan the matter layer owns.
        uColor: { value: new THREE.Color(0.95, 0.97, 1.0) },
        uDotPx: { value: ARC_DOT_PX },
      },
      vertexShader: ARC_VERTEX,
      fragmentShader: ARC_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.arcDots = new THREE.Points(this.arcGeometry, this.arcMaterial);
    this.arcDots.frustumCulled = false;
    this.arcDots.renderOrder = 5;

    this.object.add(this.arcDots);
    this.object.add(this.beacons);
  }

  /** World units to pixels for `gl_PointSize`, the same factor the paint system computes. */
  setProjScale(scale: number): void {
    this.beaconMaterial.uniforms.uProjScale!.value = scale;
  }

  /** One fixed tick of the pulse. The step is remembered: the arc is generated against it. */
  advance(dt: number): void {
    if (dt > 0) {
      this.clock += dt;
      this.stepSeconds = dt;
    }
  }

  /** Poses everything for this frame. Allocates nothing. */
  draw(frame: SphereViewFrame): void {
    const phase = Math.cos(2 * Math.PI * BEACON_PULSE_HZ * this.clock);
    this.beaconMaterial.uniforms.uPulse!.value =
      BEACON_PULSE_FLOOR + (1 - BEACON_PULSE_FLOOR) * (0.5 + 0.5 * phase);

    const cp = Math.cos(frame.pitch);
    const fx = -Math.sin(frame.yaw) * cp;
    const fy = Math.sin(frame.pitch);
    const fz = -Math.cos(frame.yaw) * cp;
    const rx = Math.cos(frame.yaw);
    const rz = -Math.sin(frame.yaw);
    // up = right × forward, with right's y known to be zero.
    const ux = -rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy;

    const e = frame.eye;
    this.hand.set(
      e.x + HAND_FORWARD * fx + HAND_RIGHT * rx + HAND_UP * ux,
      e.y + HAND_FORWARD * fy + HAND_UP * uy,
      e.z + HAND_FORWARD * fz + HAND_RIGHT * rz + HAND_UP * uz,
    );

    let n = 0;
    // The hand first, so a rack with something in it is a beacon the player owns whether or not
    // anything is in the air — §8's "a prop can also be a supply" cuts the other way here: a
    // supply you cannot see is a supply you do not spend.
    if (frame.carried > 0 && frame.firstPerson) {
      this.beaconPositions[n * 3] = this.hand.x;
      this.beaconPositions[n * 3 + 1] = this.hand.y;
      this.beaconPositions[n * 3 + 2] = this.hand.z;
      n++;
    }
    for (const s of frame.live) {
      if (n >= MAX_BEACONS) break;
      this.beaconPositions[n * 3] = s.x;
      this.beaconPositions[n * 3 + 1] = s.y;
      this.beaconPositions[n * 3 + 2] = s.z;
      n++;
    }
    this.beaconGeometry.setDrawRange(0, n);
    if (n > 0) {
      (this.beaconGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    if (!frame.charging || !frame.firstPerson) {
      // Cut at release, with nothing left behind. A preview that outlived the throw would be a
      // string of beads pointing at a place the sphere has already left.
      this.arcGeometry.setDrawRange(0, 0);
      this.reach = 0;
      return;
    }
    this.buildArc(frame, e, fx, fy, fz);
  }

  /**
   * Fills the bead buffer from `arcPoints` — the discrete sum, never a parabola of our own.
   *
   * `game/spheres.ts` makes the argument at length: the integrator is semi-implicit Euler and the
   * textbook parabola is half a tick of fall short of it, which is 13 cm by two seconds. A line
   * that disagrees with where the sphere actually goes is the system lying in the one place the
   * player is looking (law 2), so the preview is generated by the same function and against the
   * same fixed step the flight will be integrated at.
   *
   * **No world query, ever.** Terminating this arc on real geometry would be free, silent sonar:
   * sweep the aim across a dark room and the endpoint would trace out the walls, at no cost and
   * with nothing emitted — law 1 ("every question has a price") broken by an aiming aid. So the
   * arc is a vacuum parabola, and the fraying is what says so.
   */
  private buildArc(
    frame: SphereViewFrame,
    eye: THREE.Vector3,
    fx: number,
    fy: number,
    fz: number,
  ): void {
    const dt = this.stepSeconds;
    const span = ARC_TICKS_MAX - ARC_TICKS_MIN;
    const n = Math.round(ARC_TICKS_MIN + span * Math.min(1, Math.max(0, frame.chargeFraction)));
    const arc = arcPoints(
      eye.x + SPHERE_MUZZLE_M * fx,
      eye.y + SPHERE_MUZZLE_M * fy,
      eye.z + SPHERE_MUZZLE_M * fz,
      fx,
      fy,
      fz,
      frame.speed,
      dt,
      n,
      this.arcScratch,
    );
    // The launch point is on the aim; the hand is off to the side. This is the difference the
    // fade below spends.
    const cx = this.hand.x - (eye.x + SPHERE_MUZZLE_M * fx);
    const cy = this.hand.y - (eye.y + SPHERE_MUZZLE_M * fy);
    const cz = this.hand.z - (eye.z + SPHERE_MUZZLE_M * fz);

    const last = n - 1;
    const carryTicks = ARC_CARRY_SECONDS / dt;
    // The arm expressed in the cursor's own units. A tick is a fixed slice of *world*, and what
    // the spacing wants to be a fraction of is **depth**, which at tick t is the arm plus t ticks
    // of flight. Measuring the arm in ticks lets one addition convert between the two, and it is
    // the forward offset rather than the arm's true length because a perspective divide only ever
    // sees the forward one.
    const armTicks = HAND_FORWARD / Math.max(1e-3, frame.speed * dt);
    let v = 0;
    let t = 0;
    while (t <= last && v < MAX_ARC_DOTS) {
      this.writeArcDot(v++, arc, t, last, carryTicks, cx, cy, cz);
      const depth = t + armTicks;
      const spread = 1 + ARC_SPREAD * (t / last);
      t += Math.max(ARC_SPAN_FLOOR, (ARC_DOT_K * depth * depth * spread) / armTicks);
    }
    this.arcGeometry.setDrawRange(0, v);
    (this.arcGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.arcGeometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    this.reach = Math.hypot(
      arc[last * 3]! - eye.x,
      arc[last * 3 + 1]! - eye.y,
      arc[last * 3 + 2]! - eye.z,
    );
  }

  /**
   * One bead at a fractional tick `k`, interpolated between the two samples around it.
   *
   * Interpolating is exact rather than approximate: within one tick the integrator moves in a
   * straight line, so a point between two samples really is on the flown path and not near it.
   */
  private writeArcDot(
    v: number,
    arc: Float32Array,
    k: number,
    last: number,
    carryTicks: number,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    const i = Math.min(last, Math.floor(k));
    const j = Math.min(last, i + 1);
    const f = k - i;
    // Quadratic rather than linear, so the line hugs the hand for the first few centimetres
    // instead of visibly peeling off it, and is on the trajectory well before the far end.
    const s = k / carryTicks;
    const hold = s >= 1 ? 0 : 1 - s * s;
    for (let axis = 0; axis < 3; axis++) {
      const a = arc[i * 3 + axis]!;
      this.arcPositions[v * 3 + axis] = a + (arc[j * 3 + axis]! - a) * f;
    }
    this.arcPositions[v * 3] += cx * hold;
    this.arcPositions[v * 3 + 1] += cy * hold;
    this.arcPositions[v * 3 + 2] += cz * hold;
    this.arcAlphas[v] = ARC_ALPHA * Math.pow(Math.max(0, 1 - k / last), ARC_FRAY);
  }

  dispose(): void {
    this.beaconGeometry.dispose();
    this.beaconMaterial.dispose();
    this.arcGeometry.dispose();
    this.arcMaterial.dispose();
  }
}
