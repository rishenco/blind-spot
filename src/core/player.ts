/**
 * Player systems — the reactor, the two pings, the halo readout and the hands rig
 * (engine-plan §2 module map, §6).
 *
 * Everything here runs on SIM time inside the fixed 60 Hz step. There is no wall clock in this
 * file and there must never be one: energy, the ping cooldown and the halo are all quoted in
 * seconds of world time, and a value that decayed at the display's rate would mean something
 * different on a 144 Hz monitor than on a 60 Hz one.
 *
 * The pings go out on the ORDINARY bus (vision §1.1: every way of learning emits sound the world
 * can hear). Nothing here paints, plays or draws — paint, audio and the looks are all listeners,
 * exactly as they are for a footstep, so an E-ping is loud for the same reason and by the same
 * machinery that a sprint step is.
 *
 * What this module owns, and why each piece is not somewhere else:
 *
 *   ENERGY   one bar (vision §4). Vision law 5 — "movement stays genuinely good" — is the reason
 *            the empty bar gates pings and NOTHING else: an empty reactor never slows, blocks or
 *            shortens a stride.
 *   PINGS    the only deliberate perception verbs. Refused rather than queued, so a press during
 *            the cooldown is dropped instead of firing 0.3 s later at a pose you have left.
 *   HALO     "you always know exactly how loud you are" (vision §3.8). Derived from the events
 *            you actually emitted, never from the keys you are holding.
 *   HANDS    the POSE of the rig (visual-brief §1.6: hands appear on mantles, vaults and ladder
 *            climbs and are invisible in plain running). Looks own the geometry and styling.
 */

import {
  ENERGY_EPING,
  ENERGY_MAX,
  ENERGY_QPING,
  ENERGY_REGEN,
  ENERGY_SPRINT_DRAIN,
  EPING_FAR_HEAR,
  EV,
  HALO_DECAY,
  HALO_WINDOW,
  PING_COOLDOWN,
} from './const.js';
import type { EventBus, SoundEvent } from './events.js';
import { clamp, damp, lerp, smoothstep, yawToForward } from './math.js';
import { raycast, type World } from './map/build.js';
import type { HandsState, MovementController } from './movement.js';
import type { PlayerState } from './sim.js';

export type PingMode = 'e' | 'q';
/** Why a ping did not fire. Both are recoverable states, not errors. */
export type PingRefusal = 'cooldown' | 'energy';

export interface PingResult {
  readonly mode: PingMode;
  /** The emitted event, or null when the ping was refused. */
  readonly event: SoundEvent | null;
  /** Null when it fired. */
  readonly refused: PingRefusal | null;
  /**
   * Sim time the press RESOLVED. A refusal emits nothing, so it has no event to carry its own
   * stamp, and a readout that shows the reason has to know how old it is (vision §3.5: the ping
   * is a decision made at a place — the answer to a press must not outlive the place).
   */
  readonly at: number;
}

/**
 * Edge-triggered ping presses, consumed by the next fixed step and then cleared — the same
 * discipline as `MoveInput.jumpPressed`, and for the same reason: a press collected between two
 * steps must be applied exactly once, inside a step, with that step's pose and that step's clock.
 * Firing straight from the keydown handler would stamp the event with the previous step's time.
 */
export interface PlayerIntent {
  pingE: boolean;
  pingQ: boolean;
}

/**
 * One rigid part of the hands rig, in CAMERA SPACE: +x right, +y up, −z forward, metres, with the
 * eye at the origin.
 *
 * Camera space rather than world space is a deliberate choice with a cost. The rig is a keyframed
 * animation hanging off the head, so a mantle's plant is authored in front of your face instead of
 * being nailed to the world ledge — look around mid-mantle and the hands come with you. Pinning
 * them to the ledge would need the glide target out of movement's private state, and would buy
 * realism the visual brief never asked for: §1.6 wants faint machine hands that say "you are
 * climbing", and they say it from wherever you are looking.
 *
 * `rot` is Euler radians [pitch, yaw, roll] in THREE's 'YXZ' order — the same convention the
 * camera itself is driven with in main.ts. A bone's LONG AXIS is its local +z, so a look can draw
 * any prism it likes along +z and the arm points the right way.
 */
export interface RigBone {
  pos: [number, number, number];
  rot: [number, number, number];
}

export interface RigArm {
  /** Centred between elbow and wrist. */
  readonly forearm: RigBone;
  /** At the wrist, continuing the forearm's axis. */
  readonly hand: RigBone;
}

export interface HandsPose {
  state: HandsState;
  /** 0..1 through the current verb; for a ladder it is one grab CYCLE and wraps. */
  phase: number;
  /**
   * 0 = fully out of view. Smoothed, so releasing a ladder retracts the rig instead of popping
   * it out of existence; a look may fade with it or simply skip drawing at 0.
   */
  visibility: number;
  readonly left: RigArm;
  readonly right: RigArm;
}

// ---------------------------------------------------------------------------------------------
// The hands rig: authored curves (engine-plan §6)
// ---------------------------------------------------------------------------------------------

/**
 * One keyframe of one arm. Positions are authored for the RIGHT arm and mirrored in x for the
 * left; `vis` is read from the leading arm only, because the rig fades as a whole.
 *
 * Authoring the ELBOW rather than a rotation is what keeps the curves editable: an arm is two
 * points, the bones are derived from them, and a keyframe cannot describe a forearm that fails to
 * reach its own hand.
 */
interface Key {
  readonly t: number;
  /** Wrist. */
  readonly h: readonly [number, number, number];
  readonly e: readonly [number, number, number];
  readonly vis: number;
}

/** Lowered out of the frame: at z −0.3 the 92° vertical FOV sees |y| < 0.31. */
const REST: readonly Key[] = [{ t: 0, h: [0.24, -0.92, -0.3], e: [0.32, -1.22, -0.16], vis: 0 }];

/** Mantle: reach → plant → the body rises past the planted hands → push away. */
const MANTLE: readonly Key[] = [
  { t: 0.0, h: [0.22, -0.75, -0.34], e: [0.3, -1.05, -0.2], vis: 0 },
  { t: 0.18, h: [0.3, -0.1, -0.55], e: [0.4, -0.62, -0.3], vis: 1 },
  { t: 0.36, h: [0.32, 0.26, -0.62], e: [0.42, -0.28, -0.36], vis: 1 },
  { t: 0.62, h: [0.33, -0.06, -0.56], e: [0.46, -0.55, -0.28], vis: 1 },
  { t: 0.8, h: [0.33, -0.44, -0.46], e: [0.48, -0.85, -0.22], vis: 1 },
  { t: 1.0, h: [0.28, -0.95, -0.32], e: [0.36, -1.25, -0.18], vis: 0 },
];

/** Vault: one plant, swept back under you as you pass over. This is the arm that plants. */
const VAULT_PLANT: readonly Key[] = [
  { t: 0.0, h: [0.24, -0.8, -0.32], e: [0.32, -1.1, -0.18], vis: 0 },
  { t: 0.22, h: [0.22, -0.34, -0.66], e: [0.36, -0.72, -0.34], vis: 1 },
  { t: 0.55, h: [0.3, -0.4, -0.44], e: [0.44, -0.8, -0.22], vis: 1 },
  { t: 0.8, h: [0.38, -0.62, -0.18], e: [0.5, -0.95, -0.06], vis: 1 },
  { t: 1.0, h: [0.26, -0.92, -0.3], e: [0.34, -1.2, -0.16], vis: 0 },
];

/** …and the arm that does not: a low counter-swing, mostly under the frame. */
const VAULT_TRAIL: readonly Key[] = [
  { t: 0.0, h: [0.24, -0.86, -0.3], e: [0.32, -1.14, -0.16], vis: 0 },
  { t: 0.35, h: [0.3, -0.66, -0.4], e: [0.4, -0.98, -0.22], vis: 1 },
  { t: 0.75, h: [0.26, -0.8, -0.26], e: [0.36, -1.08, -0.14], vis: 1 },
  { t: 1.0, h: [0.24, -0.9, -0.3], e: [0.32, -1.18, -0.16], vis: 0 },
];

/**
 * Ladder: one grab cycle, reach-high → pull-down → swing back up. The two arms sample this same
 * track half a cycle apart, which is what makes them alternate. First and last key are identical
 * so the cycle wraps without a seam — movement advances `handsPhase` by metres climbed and wraps
 * it at 1, so this track is walked round and round for as long as the climb lasts.
 */
const LADDER: readonly Key[] = [
  { t: 0.0, h: [0.17, 0.42, -0.4], e: [0.3, 0.02, -0.26], vis: 1 },
  { t: 0.36, h: [0.17, 0.02, -0.42], e: [0.34, -0.36, -0.26], vis: 1 },
  { t: 0.72, h: [0.17, -0.38, -0.44], e: [0.36, -0.74, -0.28], vis: 1 },
  { t: 0.86, h: [0.24, -0.1, -0.34], e: [0.38, -0.48, -0.2], vis: 1 },
  { t: 1.0, h: [0.17, 0.42, -0.4], e: [0.3, 0.02, -0.26], vis: 1 },
];

/** How fast the rig fades in and out of view, 1/s. */
const HANDS_FADE = 22;

const bone = (): RigBone => ({ pos: [0, 0, 0], rot: [0, 0, 0] });
const arm = (): RigArm => ({ forearm: bone(), hand: bone() });

const scratchHand: [number, number, number] = [0, 0, 0];
const scratchElbow: [number, number, number] = [0, 0, 0];

/**
 * Sample one arm track at `t`, writing the wrist and elbow into the scratch tuples and returning
 * the keyframed visibility. Segments are eased with a smoothstep rather than a straight lerp: the
 * curves are five keys long, and linear segments read as a machine hitting hard stops.
 */
function sampleArm(keys: readonly Key[], t: number, mirror: boolean): number {
  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1]!.t) i++;
  const a = keys[i]!;
  const b = keys[i + 1] ?? a;
  const u = b === a ? 0 : smoothstep(a.t, b.t, t);
  const sx = mirror ? -1 : 1;
  scratchHand[0] = sx * lerp(a.h[0], b.h[0], u);
  scratchHand[1] = lerp(a.h[1], b.h[1], u);
  scratchHand[2] = lerp(a.h[2], b.h[2], u);
  scratchElbow[0] = sx * lerp(a.e[0], b.e[0], u);
  scratchElbow[1] = lerp(a.e[1], b.e[1], u);
  scratchElbow[2] = lerp(a.e[2], b.e[2], u);
  return lerp(a.vis, b.vis, u);
}

/**
 * Derive the two bones from the sampled wrist and elbow. Both carry the arm's axis: a boxy robot
 * hand continues its forearm, so there is one orientation per arm and the look never has to
 * invent a wrist joint.
 */
function writeArm(out: RigArm): void {
  const dx = scratchHand[0] - scratchElbow[0];
  const dy = scratchHand[1] - scratchElbow[1];
  const dz = scratchHand[2] - scratchElbow[2];
  const len = Math.hypot(dx, dy, dz);
  // Local +z maps to (cosP·sinY, −sinP, cosP·cosY) under 'YXZ', so this is that inverted.
  const pitch = len > 1e-6 ? -Math.asin(clamp(dy / len, -1, 1)) : 0;
  const yaw = Math.atan2(dx, dz);
  out.forearm.pos[0] = (scratchHand[0] + scratchElbow[0]) * 0.5;
  out.forearm.pos[1] = (scratchHand[1] + scratchElbow[1]) * 0.5;
  out.forearm.pos[2] = (scratchHand[2] + scratchElbow[2]) * 0.5;
  out.forearm.rot[0] = pitch;
  out.forearm.rot[1] = yaw;
  out.hand.pos[0] = scratchHand[0];
  out.hand.pos[1] = scratchHand[1];
  out.hand.pos[2] = scratchHand[2];
  out.hand.rot[0] = pitch;
  out.hand.rot[1] = yaw;
}

// ---------------------------------------------------------------------------------------------
// Pings
// ---------------------------------------------------------------------------------------------

/**
 * How far short of the surface the E-ping's far end is placed, metres. The beam's far end is a
 * sound made BY the wall it lands on, so its origin belongs on the near face: an origin buried
 * inside the slab is excluded from its own wall count (`originSolids` in paint.ts) and would be
 * heard through the wall for free — the far end would leak into the next room.
 */
const EPING_FAR_BACKOFF = 0.05;

interface PendingEvent {
  /** Sim time the wavefront reaches the far end. */
  at: number;
  x: number;
  y: number;
  z: number;
}

export class PlayerSystems {
  readonly world: World;
  readonly player: PlayerState;
  readonly movement: MovementController;
  readonly bus: EventBus;

  /** Vision §4: one bar, capacity 100, regenerating 6/s. Chips reserve capacity (vision §9). */
  energy = ENERGY_MAX;
  energyMax = ENERGY_MAX;

  /** Vision §3.8: how loud you are right now, in metres. */
  audibleRadius = 0;

  readonly intent: PlayerIntent = { pingE: false, pingQ: false };
  /** The most recent resolved ping, fired or refused. Audio and the HUD may react to it. */
  lastPing: PingResult | null = null;

  readonly hands: HandsPose = {
    state: 'none',
    phase: 0,
    visibility: 0,
    left: arm(),
    right: arm(),
  };

  /** Sim time the next ping is allowed at. Shared by both modes (vision §3.5, §12). */
  private pingReady = 0;
  private lastSelfSound = -1e9;
  private pending: PendingEvent | null = null;
  private readonly detachBus: () => void;

  constructor(world: World, player: PlayerState, movement: MovementController, bus: EventBus) {
    this.world = world;
    this.player = player;
    this.movement = movement;
    this.bus = bus;
    this.detachBus = bus.on((e) => this.hearSelf(e));
    this.pose(0);
    this.hands.visibility = 0;
  }

  /** The sim's clock. The bus carries it, so an event's stamp and this can never disagree. */
  private get now(): number {
    return this.bus.now;
  }

  /** One fixed tick, run after movement so a ping leaves from the pose this step produced. */
  update(dt: number): void {
    this.updateEnergy(dt);
    this.updateHalo(dt);
    this.releasePending();
    this.consumeIntent();
    this.pose(dt);
  }

  /**
   * Fire a ping, or refuse it. Public so specs and the console can drive it without a keypress;
   * the keyboard goes through `intent` instead, to land inside a step.
   *
   * Refused, never queued: a press that arrives during the cooldown is dropped. Queuing it would
   * fire the ping from a pose the player has already left, and the whole cost model of vision
   * §3.5 is that a ping is a decision made at a place.
   *
   * The cooldown is tested before the energy, so a spent-and-recharging player is told the reason
   * with the known expiry rather than the one that may resolve at any moment.
   */
  ping(mode: PingMode): PingResult {
    const cost = mode === 'e' ? ENERGY_EPING : ENERGY_QPING;
    if (this.now < this.pingReady) return this.refuse(mode, 'cooldown');
    if (this.energy < cost) return this.refuse(mode, 'energy');

    this.energy -= cost;
    this.pingReady = this.now + PING_COOLDOWN;

    const p = this.player;
    // Eye, not feet: the sonar is in the head, and the SIM's posture rather than the rig's
    // smoothed one — an event origin is simulation truth, not picture (engine-plan §11.1).
    const ex = p.x;
    const ey = p.y + this.movement.eyeTarget;
    const ez = p.z;

    if (mode === 'q') {
      const event = this.bus.emit({ class: 'qPing', source: 'self', x: ex, y: ey, z: ez });
      const out: PingResult = { mode, event, refused: null, at: this.now };
      this.lastPing = out;
      return out;
    }

    const [fx, , fz] = yawToForward(p.yaw);
    const cp = Math.cos(p.pitch);
    const dx = fx * cp;
    const dy = Math.sin(p.pitch);
    const dz = fz * cp;
    const event = this.bus.emit({
      class: 'ePing',
      source: 'self',
      x: ex,
      y: ey,
      z: ez,
      cone: { dir: [dx, dy, dz], angleDeg: EV.ePing.coneDeg },
    });
    this.scheduleFarEnd(event, ex, ey, ez, dx, dy, dz);
    const out: PingResult = { mode, event, refused: null, at: this.now };
    this.lastPing = out;
    return out;
  }

  dispose(): void {
    this.detachBus();
  }

  // ------------------------------------------------------------------------------------------

  private refuse(mode: PingMode, refused: PingRefusal): PingResult {
    const out: PingResult = { mode, event: null, refused, at: this.now };
    this.lastPing = out;
    return out;
  }

  /**
   * The E-ping is heard at BOTH ends (engine-plan §6): the beam lands somewhere and that landing
   * is a sound in its own right, 30 m worth of it, in a room you may be nowhere near. It is the
   * reason the directed ping is a bait tool and not a free telescope — it wakes what it looks at.
   *
   * The far end exists only where the beam IMPACTS something (engine-plan §6: "at beam impact
   * center"). A beam that reaches its 40 m without touching a surface schedules nothing at all:
   * vision law 2 — every sound has a real physical source — and the sound here is made by the
   * struck surface, not by the beam. A miss is silent past your own outgoing chirp, and nothing
   * may be added to compensate: hearing nothing come back IS the answer to the question.
   * `hit.inside` (the beam started within a solid) has no near face to re-radiate, so it counts
   * as no impact too.
   *
   * It PAINTS NOTHING (radius 0). The cone already painted everything the beam swept on its way
   * out; a second sphere at the far end would hand the player free geometry around a corner they
   * never illuminated.
   *
   * Held here and emitted when the wavefront actually arrives, never backdated onto the bus:
   * event times are monotonic within the bus and consumers schedule off them (`PaintJob`), so a
   * late-arriving event with an early stamp would paint into the past. The release is at most one
   * step (16.7 ms) late and never early, which is the same bound `PaintPipeline.pump` works to.
   */
  private scheduleFarEnd(
    e: SoundEvent,
    ex: number,
    ey: number,
    ez: number,
    dx: number,
    dy: number,
    dz: number,
  ): void {
    const hit = raycast(this.world, ex, ey, ez, dx, dy, dz, e.paintRadius);
    if (!hit || hit.inside) return;
    const reach = Math.max(0, Math.min(e.paintRadius, hit.t - EPING_FAR_BACKOFF));
    // One slot is enough by construction: the flight of the longest beam is 40/85 = 0.47 s and
    // PING_COOLDOWN is 0.75 s, so a pending far end is always emitted before the next E-ping.
    this.pending = {
      at: e.time + reach / e.waveSpeed,
      x: ex + dx * reach,
      y: ey + dy * reach,
      z: ez + dz * reach,
    };
  }

  private releasePending(): void {
    const q = this.pending;
    if (!q || this.now < q.at) return;
    this.pending = null;
    this.bus.emit({
      class: 'ePing',
      source: 'self',
      variant: 'far',
      x: q.x,
      y: q.y,
      z: q.z,
      paintRadius: 0,
      hearRadius: EPING_FAR_HEAR,
    });
  }

  private consumeIntent(): void {
    const i = this.intent;
    if (i.pingE) {
      i.pingE = false;
      this.ping('e');
    }
    if (i.pingQ) {
      i.pingQ = false;
      this.ping('q');
    }
  }

  /**
   * Vision §4: regeneration 6/s, sprint drains 1/s. They run TOGETHER, which is what makes the
   * drain "a light tax" rather than a stamina bar — a sprinting reactor still recharges, at 5/s
   * instead of 6/s. Suppressing regen while sprinting would make a long run cost you your pings,
   * and rationing movement against information is exactly what law 5 forbids. (Vision §17.1 has
   * the drain itself down as an open playtest question.)
   *
   * The clamp's LOWER bound is the law, not the arithmetic: the bar floors at 0 and an empty bar
   * refuses pings and nothing else. It never stops, slows or shortens a stride (vision §4).
   *
   * "Sprinting" is the BODY's gait, not the sprint key — the same predicate that decides which
   * footstep row you publish (movement.ts `gaitForSpeed`). Charging the key would bill you for
   * holding shift against a wall, and not charging inherited overspeed would let a slide-jump
   * travel at 7 m/s for free.
   */
  private updateEnergy(dt: number): void {
    const drain = this.movement.gait === 'sprint' ? ENERGY_SPRINT_DRAIN : 0;
    this.energy = clamp(this.energy + (ENERGY_REGEN - drain) * dt, 0, this.energyMax);
  }

  /**
   * Vision §3.8: the halo is the loudest thing you have emitted recently, held for HALO_WINDOW
   * and then bled away at HALO_DECAY. Held rather than instantaneous because the readout has to
   * answer "how loud am I", and a value that dropped to zero between two footfalls would say you
   * are silent while you are sprinting.
   */
  private updateHalo(dt: number): void {
    if (this.now - this.lastSelfSound > HALO_WINDOW) {
      this.audibleRadius = Math.max(0, this.audibleRadius - HALO_DECAY * dt);
    }
  }

  /**
   * The halo listens to the BUS rather than to what was delivered back to this listener: it is a
   * readout of what you EMITTED, and whether you could hear yourself is a different question. In
   * practice every self event is delivered to self anyway (you stand at its origin); the one that
   * is not is the E-ping's far end, which is genuinely part of the same emission and genuinely
   * part of how loud that ping made you.
   *
   * So the hold is EMISSION-TIME and the far end refreshes it: vision §3.8's readout answers "how
   * loud am I", a beam still in flight has not finished making you loud, and it lands as a 30 m
   * event that anything near it can hear. A long beam therefore keeps the ring lit past the press.
   */
  private hearSelf(e: SoundEvent): void {
    if (e.source !== 'self') return;
    if (e.hearRadius > this.audibleRadius || e.time - this.lastSelfSound > HALO_WINDOW) {
      this.audibleRadius = e.hearRadius;
    }
    this.lastSelfSound = e.time;
  }

  /**
   * Drive the rig from movement's verb and phase. Core owns the pose only — a look decides what
   * a hand is made of and how it is lit (engine-plan §9).
   *
   * With no verb running the pose is FROZEN where the last one left it and only the visibility
   * retracts, so letting go of a ladder mid-pull withdraws that pose instead of snapping to a
   * rest pose nobody was ever in. The next verb re-poses while the rig is still out of view.
   */
  private pose(dt: number): void {
    const h = this.hands;
    const m = this.movement;
    h.state = m.hands;
    h.phase = m.handsPhase;

    let vis = 0;
    if (h.state === 'mantle') {
      vis = sampleArm(MANTLE, h.phase, false);
      writeArm(h.right);
      sampleArm(MANTLE, h.phase, true);
      writeArm(h.left);
    } else if (h.state === 'vault') {
      vis = sampleArm(VAULT_PLANT, h.phase, false);
      writeArm(h.right);
      sampleArm(VAULT_TRAIL, h.phase, true);
      writeArm(h.left);
    } else if (h.state === 'ladder') {
      vis = sampleArm(LADDER, h.phase, false);
      writeArm(h.right);
      sampleArm(LADDER, (h.phase + 0.5) % 1, true);
      writeArm(h.left);
    } else if (h.visibility <= 0.001) {
      // Fully retracted and idle: park the rig so a fresh Sim has a defined pose.
      sampleArm(REST, 0, false);
      writeArm(h.right);
      sampleArm(REST, 0, true);
      writeArm(h.left);
    }

    h.visibility = dt > 0 ? damp(h.visibility, vis, HANDS_FADE, dt) : vis;
  }
}
