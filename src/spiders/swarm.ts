/**
 * The spiders — M4.
 *
 * The human's words, and the whole brief: «пауки должны типо как акулы или волки быть. кружат,
 * сталкерят, потом атакуют. но они мелкие им страшно как бы, поэтому просто не раздерут сразу».
 *
 * So this is not "enemy sees player, enemy runs at player". It is a pack that circles at the
 * edge of what it thinks it knows, borrows nerve from its neighbours, loses all of it the
 * moment something bangs, and rushes only when enough of it has gathered in one place. Death
 * is the player letting the pack assemble, not one mistake.
 *
 * Four rules hold the design together:
 *
 * 1. **They are blind and they are deaf to the lidar.** The only channel in is `SoundBus`, and
 *    the lidar is deliberately not on it. Everything a spider believes came from an event that
 *    physics actually raised. The one exception is documented at `FEEL_RANGE`: at arm's length
 *    a spider feels the player directly, because a creature standing *on* you is not reasoning
 *    about footsteps any more.
 *
 * 2. **Belief, not knowledge.** Each spider carries one point and one confidence. Confidence
 *    decays; a noise refreshes it; nothing else does. Two spiders can believe different things,
 *    and usually do — which is what makes the pack look like it is searching rather than
 *    following a waypoint.
 *
 * 3. **Chatter is the pack's state, made audible.** A click is a real bus event with a real
 *    loudness, so it draws a mark on the player's HUD like anything else. The click rate is a
 *    direct function of arousal, so a silent pack is nearly invisible and a pack about to
 *    commit lights up the room. That is the tell the player has to learn to read, and it is why
 *    clicks are not flavour.
 *
 * 4. **Courage is social and fragile.** It grows from neighbours, from confidence, and from the
 *    player standing still; a loud event burns it to nothing and scatters whoever heard it. One
 *    spider alone will circle you all night and never come in.
 *
 * Determinism: one seeded RNG for the whole swarm, advanced only inside the fixed step; every
 * timer is on the simulation clock. Same seed and same player actions give the same hunt.
 *
 * Cost: hearing is O(spiders) per *event*, not per frame. Steering, the only non-trivial work,
 * runs on a staggered slice — each spider re-decides at `decisionHz`, spread across ticks by
 * index, so no frame ever pays for the whole pack at once. Integration and the contact test are
 * a handful of flops each and run every tick.
 */
import * as THREE from 'three';

import { StaticWorld, canOccupy, moveBody, type Aabb, type BodyShape } from '../core/collision';
import { makeRng, range, type Rng } from '../core/rng';
import type { SoundBus, SoundEvent } from '../events/bus';

/**
 * What a spider is doing, in the order the hunt normally walks through them.
 *
 * `rally` is the important one and the one a reader should not skim: it is a deliberate pause
 * with the chatter turned all the way up, so the attack is *announced* a second and a half
 * before it lands. Without it the pack is unfair — the player has no way to know, and the whole
 * click mechanic pays for nothing.
 */
export type SpiderState =
  | 'idle'
  | 'stalk'
  | 'creep'
  | 'rally'
  | 'commit'
  | 'recoil'
  | 'flee'
  | 'panic';

export const SPIDER_STATES: readonly SpiderState[] = [
  'idle',
  'stalk',
  'creep',
  'rally',
  'commit',
  'recoil',
  'flee',
  'panic',
];

/** Debug-overlay colour per state. Kept here so the panel and the gizmos cannot disagree. */
export const STATE_COLORS: Record<SpiderState, number> = {
  idle: 0x5a6b76,
  stalk: 0x4fb0c6,
  creep: 0x6fd3a0,
  rally: 0xffd166,
  commit: 0xff5d5d,
  recoil: 0xc07fd0,
  flee: 0x8fa2ff,
  panic: 0xff8a3d,
};

export interface SpiderTunables {
  /** How many spiders the hall gets. */
  count: number;
  /** Steering/decision rate, Hz. Movement itself integrates every tick; only the *choice* is sliced. */
  decisionHz: number;

  // --- body ---------------------------------------------------------------
  radius: number;
  height: number;
  /** Ledge a spider walks up without any special case. This is "лазают по стеллажам". */
  stepHeight: number;
  /** Metres per second, per state family. */
  speedIdle: number;
  speedStalk: number;
  speedCreep: number;
  speedCommit: number;
  speedFlee: number;
  /** How fast the body can change the direction it is pushing, m/s². */
  accel: number;

  // --- hearing and belief -------------------------------------------------
  /**
   * Multiplier on an event's loudness before the audibility test. 1.0 means a spider hears
   * exactly as far as the debug rings drawn in M2 say it does — the same number, one scale.
   */
  hearing: number;
  /** Seconds for belief confidence to fall to 1/e with nothing new heard. */
  beliefTau: number;
  /** Weight on the confidence a fresh event can install, per source family. */
  weightPlayer: number;
  weightProp: number;
  weightChatter: number;
  /** Metres: two belief points closer than this count as "the same place" for the pinned timer. */
  pinnedRadius: number;

  // --- fear ---------------------------------------------------------------
  /** Loudness, in metres of notice, at or above which a heard event is frightening, not just informative. */
  scareLoudness: number;
  /** Seconds a startled spider runs before it will even consider stalking again. */
  scareSeconds: number;
  /** Courage burnt by one scare. */
  scareCost: number;

  // --- courage ------------------------------------------------------------
  /** Courage per second at full pack support and full confidence. */
  courageGain: number;
  /** Courage lost per second when the spider believes nothing. */
  courageDecay: number;
  /** Neighbours within `packRadius` needed for full support. */
  packSize: number;
  packRadius: number;
  /** Extra courage per second while the player has not moved his noise for `pinnedSeconds`. */
  pinnedGain: number;
  pinnedSeconds: number;

  // --- the decision -------------------------------------------------------
  /** Courage a spider needs before it counts itself ready. */
  readyCourage: number;
  /** Ready spiders needed before the pack rallies. */
  quorum: number;
  /** Seconds of loud coordination between "we are going" and going. */
  rallySeconds: number;
  /** Seconds a commit may last before nerve fails. */
  commitSeconds: number;
  /** Seconds of running away after a strike lands. */
  recoilSeconds: number;

  // --- geometry of the circling ------------------------------------------
  stalkRadius: number;
  creepRadius: number;
  /** Metres of belief-distance inside which a stalker switches to creeping. */
  creepCourage: number;
  /** How fast the orbit slot walks around the belief, degrees per second. */
  orbitSpeed: number;

  // --- contact ------------------------------------------------------------
  /** Metres at which a spider touching the player counts as a strike. */
  strikeRange: number;
  /** Loudness of the strike screech. */
  strikeLoudness: number;

  // --- noise --------------------------------------------------------------
  /** Metres walked between footfalls. */
  /** Metres per second up a wall face, once it has decided to climb one. */
  climbSpeed: number;
  /** It will not climb higher than this: a spider hanging under the roof is a bug, not a wolf. */
  climbCeiling: number;
  stride: number;
  /** Loudness of a footfall on concrete, and on anything the spider is standing on top of. */
  stepLoudnessFloor: number;
  stepLoudnessMetal: number;
  /** Loudness of one click. This is the number that makes the pack findable. */
  clickLoudness: number;
  /** Seconds between clicks at zero and at full arousal. */
  clickSlow: number;
  clickFast: number;
  /** Seconds between panic smashes, and the impulse each one puts into the clutter. */
  smashSeconds: number;
  smashImpulse: number;
}

export function defaultSpiderTunables(): SpiderTunables {
  return {
    count: 14,
    decisionHz: 15,

    radius: 0.3,
    height: 0.36,
    stepHeight: 0.62,
    speedIdle: 1.0,
    speedStalk: 2.4,
    speedCreep: 1.2,
    speedCommit: 5.2,
    speedFlee: 6.0,
    accel: 14,

    hearing: 1,
    beliefTau: 9,
    weightPlayer: 1,
    weightProp: 0.65,
    weightChatter: 0.5,
    pinnedRadius: 2.5,

    // A gunshot is 90 m of notice and a barrel going over caps at 34; a sprint is 16. So this
    // line puts "the world fell over" and "he fired" on the frightening side and leaves ordinary
    // walking on the informative side, which is exactly the split the concept asks for.
    scareLoudness: 20,
    scareSeconds: 3.2,
    scareCost: 0.75,

    courageGain: 0.22,
    courageDecay: 0.05,
    packSize: 3,
    packRadius: 11,
    pinnedGain: 0.1,
    pinnedSeconds: 5,

    readyCourage: 0.55,
    quorum: 3,
    rallySeconds: 1.6,
    commitSeconds: 6,
    recoilSeconds: 1.8,

    stalkRadius: 7,
    creepRadius: 3.4,
    creepCourage: 0.32,
    orbitSpeed: 26,

    strikeRange: 0.85,
    strikeLoudness: 24,

    climbSpeed: 1.5,
    climbCeiling: 3,
    stride: 0.85,
    stepLoudnessFloor: 1.6,
    stepLoudnessMetal: 3.6,
    clickLoudness: 12,
    clickSlow: 12,
    clickFast: 0.55,
    smashSeconds: 0.7,
    smashImpulse: 4.5,
  };
}

/** One spider's memory of where the player is. Everything it does comes off these four numbers. */
export interface Belief {
  x: number;
  z: number;
  /** 0..1, decaying. */
  confidence: number;
  /** Simulation time the belief was last refreshed. */
  at: number;
  /** Seconds the belief has stayed in essentially the same place — "he has not moved". */
  pinnedFor: number;
}

/** What the overlay prints and what the keyframe scenarios assert against. */
export interface SpiderSnapshot {
  id: number;
  x: number;
  y: number;
  z: number;
  state: SpiderState;
  /** Seconds spent in the current state. */
  stateFor: number;
  courage: number;
  belief: Belief;
  /** Where it is walking, world XZ. */
  goalX: number;
  goalZ: number;
  /** Distance from the spider to its own belief point. */
  toBelief: number;
  /** Last thing it heard, and how long ago. */
  heard: string;
  heardAgo: number;
  /** True while the body is standing on something that is not the concrete. */
  elevated: boolean;
  alive: boolean;
}

export interface SwarmStats {
  count: number;
  /** How many spiders are in each state. */
  byState: Record<SpiderState, number>;
  mode: SpiderState;
  meanCourage: number;
  ready: number;
  /** Clicks per second across the whole pack, sampled over the last second. */
  chatter: number;
  clicks: number;
  steps: number;
  strikes: number;
  /** Simulation cost of the last update, milliseconds. */
  updateMs: number;
  /** Steering decisions taken in the last update — the sliced work, so this should be small. */
  decisions: number;
}

/** Just enough of `PropWorld` for a panicking spider to wreck the place. */
export interface Smashable {
  disturb(x: number, y: number, z: number, radius: number, impulse: number): number;
}

interface Spider {
  id: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  grounded: boolean;
  alive: boolean;
  state: SpiderState;
  stateAt: number;
  courage: number;
  belief: Belief;
  /** Angular slot around the belief. Spread at spawn, and walked, so the pack encircles. */
  orbit: number;
  /** Which way round it is walking. */
  orbitDir: number;
  goal: THREE.Vector3;
  /** Unit heading chosen by the last steering decision. */
  headX: number;
  headZ: number;
  /** Metres walked since the last footfall. */
  sinceStep: number;
  /** Simulation time until which the body is clinging to a wall and going up it. */
  climbUntil: number;
  /** Seconds until the next click. */
  clickIn: number;
  /** Seconds until the next panic smash. */
  smashIn: number;
  /** Where the last thing it heard came from, for the overlay. */
  heard: string;
  heardAt: number;
  /** Set while a scare is still running the body. */
  scaredUntil: number;
  scareX: number;
  scareZ: number;
  /** Tick offset, so the pack's steering is spread across frames. */
  phase: number;
}

const UP_EPS = 0.05;
/**
 * The one non-acoustic sense in the file, and it is deliberate: inside this radius a spider is
 * close enough to feel the player through the floor and the air, so belief snaps to the truth.
 * Without it a blind pack that has physically surrounded you still gropes past your feet, which
 * reads as broken rather than as blind. It is short enough that it can never *find* anybody —
 * it only stops a spider losing someone it is already touching.
 */
const FEEL_RANGE = 1.6;

/** Candidate headings for the whisker steering, in degrees off the desired direction. */
const FAN = [0, 18, -18, 38, -38, 62, -62, 88, -88, 120, -120, 165];

export class Swarm {
  readonly tunables: SpiderTunables;
  private readonly spiders: Spider[] = [];
  private readonly rng: Rng;
  private readonly shape: BodyShape;
  private readonly unsubscribe: () => void;
  private props: Smashable | null = null;

  private time = 0;
  private tick = 0;
  private readonly player = new THREE.Vector3();
  private playerAlive = true;

  /** Pack-level decision, recomputed on the decision slice and shared by everyone. */
  private packMode: 'hunt' | 'rally' | 'commit' = 'hunt';
  private packUntil = 0;

  private stats: SwarmStats = {
    count: 0,
    byState: emptyStateCounts(),
    mode: 'idle',
    meanCourage: 0,
    ready: 0,
    chatter: 0,
    clicks: 0,
    steps: 0,
    strikes: 0,
    updateMs: 0,
    decisions: 0,
  };
  private clickWindow: number[] = [];

  private readonly scratchBoxes: Aabb[] = [];
  private readonly scratchVel = new THREE.Vector3();

  constructor(
    private readonly world: StaticWorld,
    private readonly bus: SoundBus,
    seed: number,
    tunables: SpiderTunables = defaultSpiderTunables(),
  ) {
    this.tunables = tunables;
    this.rng = makeRng(seed ^ 0x5eed_a1);
    this.shape = {
      radius: tunables.radius,
      height: tunables.height,
      stepHeight: tunables.stepHeight,
    };
    // The third bus consumer, and it knows nothing about the other two. A spider hears exactly
    // what the marker layer draws and what the synth voices — no private channel, no cheat.
    this.unsubscribe = bus.subscribe((event) => this.hear(event));
  }

  /** Lets a panicking spider throw the clutter about. Optional: the pack works without it. */
  setProps(props: Smashable | null): void {
    this.props = props;
  }

  get count(): number {
    return this.spiders.length;
  }

  get all(): readonly Spider[] {
    return this.spiders;
  }

  /**
   * Puts `n` spiders into the hall at a deterministic spread of spots, none of them near the
   * player's spawn. Called once; a scenario may call it again to reset the hunt.
   */
  spawn(n = this.tunables.count, awayFrom?: THREE.Vector3): void {
    this.spiders.length = 0;
    const shun = awayFrom ?? new THREE.Vector3(-30, 0, -20);
    let placed = 0;
    let attempts = 0;
    while (placed < n && attempts < n * 60) {
      attempts++;
      const x = range(this.rng, -31, 31);
      const z = range(this.rng, -21, 21);
      if (Math.hypot(x - shun.x, z - shun.z) < 14) continue;
      if (!this.free(x, 0.05, z)) continue;
      this.spiders.push(this.make(placed, x, z));
      placed++;
    }
    this.stats.count = this.spiders.length;
  }

  /**
   * Debug/keyframes: put spider `i` down at a chosen spot, keeping its head clear. The hall is
   * full of clutter, so the exact spot asked for is often solid; we spiral out a little and take
   * the nearest free one instead of quietly leaving the spider inside a shelf.
   */
  place(i: number, x: number, z: number, y = 0.02): boolean {
    const s = this.spiders[i];
    if (s === undefined) return false;
    for (let r = 0; r <= 2.4; r += 0.4) {
      const steps = r === 0 ? 1 : 12;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (!this.free(px, y + this.shape.height * 0.5, pz)) continue;
        s.pos.set(px, y, pz);
        s.vel.set(0, 0, 0);
        return true;
      }
    }
    return false;
  }

  private make(id: number, x: number, z: number): Spider {
    const angle = (id / Math.max(1, this.tunables.count)) * Math.PI * 2;
    return {
      id,
      pos: new THREE.Vector3(x, 0.02, z),
      vel: new THREE.Vector3(),
      grounded: false,
      alive: true,
      state: 'idle',
      stateAt: this.time,
      courage: range(this.rng, 0.05, 0.2),
      belief: { x, z, confidence: 0, at: -99, pinnedFor: 0 },
      orbit: angle,
      orbitDir: this.rng() < 0.5 ? -1 : 1,
      goal: new THREE.Vector3(x, 0, z),
      headX: Math.cos(angle),
      headZ: Math.sin(angle),
      sinceStep: range(this.rng, 0, this.tunables.stride),
      climbUntil: 0,
      clickIn: range(this.rng, 0.5, 4),
      smashIn: 0,
      heard: '-',
      heardAt: -99,
      scaredUntil: 0,
      scareX: x,
      scareZ: z,
      phase: id,
    };
  }

  /** The player's body, in world space. Used for contact and for `FEEL_RANGE` only. */
  setPlayer(x: number, y: number, z: number): void {
    this.player.set(x, y, z);
  }

  // ---- hearing ------------------------------------------------------------

  /**
   * One sound event, offered to every spider. This is the whole input surface of the AI.
   *
   * A spider's own noise is skipped by position rather than by identity: the bus carries no
   * emitter id, and inventing one purely for this would put spider bookkeeping into a contract
   * three unrelated subsystems share. Two spiders standing on the same tile hearing each other's
   * footfall is harmless — they already believe the same thing.
   */
  private hear(event: SoundEvent): void {
    const t = this.tunables;
    const reach = event.loudness * t.hearing;
    if (reach <= 0) return;
    const scary = event.loudness >= t.scareLoudness;

    for (const s of this.spiders) {
      if (!s.alive) continue;
      const d = Math.hypot(s.pos.x - event.x, s.pos.z - event.z);
      if (d > reach) continue;
      if (event.source === 'spider' && d < 0.35) continue; // its own foot

      // How good the fix is: right on top of it is a certainty, at the edge of hearing it is
      // barely a direction.
      const quality = Math.max(0.12, 1 - d / reach);
      let weight = t.weightPlayer;
      if (event.source === 'prop-impact') weight = t.weightProp;
      else if (event.source === 'spider') weight = t.weightChatter;

      if (event.source === 'spider') {
        // Chatter does not point at the player — it points at what the *speaker* believes.
        // Handled in `click`, which knows who spoke. Here the click only counts as arousal.
        s.heard = 'chatter';
        s.heardAt = this.time;
        continue;
      }

      this.updateBelief(s, event.x, event.z, quality * weight);
      s.heard = `${event.source} ${event.loudness.toFixed(0)}m @${d.toFixed(0)}m`;
      s.heardAt = this.time;

      if (scary) {
        // The concept, verbatim: a shot or a falling barrel *scatters* them as well as
        // attracting them. The belief is updated above — they know where the bang was — and
        // then they get off that spot as fast as they can, which is why shooting is a trade
        // and not a solution.
        const bite = (t.scareCost * Math.max(0.3, 1 - d / reach)) / 1;
        s.courage = Math.max(0, s.courage - bite);
        s.scaredUntil = Math.max(s.scaredUntil, this.time + t.scareSeconds * Math.max(0.35, 1 - d / reach));
        s.scareX = event.x;
        s.scareZ = event.z;
        this.enter(s, event.source === 'bullet-hit' && d < 1.2 ? 'panic' : 'flee');
      }
    }
  }

  private updateBelief(s: Spider, x: number, z: number, quality: number): void {
    const b = s.belief;
    const moved = Math.hypot(b.x - x, b.z - z);
    if (quality >= b.confidence) {
      b.x = x;
      b.z = z;
      b.confidence = Math.min(1, quality);
    } else {
      // A weaker fix still nudges: it is evidence, just not better evidence.
      const k = (quality / Math.max(1e-3, b.confidence)) * 0.35;
      b.x += (x - b.x) * k;
      b.z += (z - b.z) * k;
      b.confidence = Math.min(1, b.confidence + quality * 0.1);
    }
    b.at = this.time;
    if (moved > this.tunables.pinnedRadius) b.pinnedFor = 0;
  }

  // ---- update -------------------------------------------------------------

  update(dt: number, now: number): void {
    const t0 = performance.now();
    this.time = now;
    this.tick++;
    this.stats.decisions = 0;

    const t = this.tunables;
    const every = Math.max(1, Math.round(1 / (dt * t.decisionHz)));

    this.pack(dt);

    for (const s of this.spiders) {
      if (!s.alive) continue;
      this.decay(s, dt);
      // Steering — the only part that costs anything — is sliced across ticks by index.
      if ((this.tick + s.phase) % every === 0) {
        this.decide(s, dt * every);
        this.stats.decisions++;
      }
      this.integrate(s, dt);
      this.voice(s, dt);
      this.contact(s);
    }

    this.summarise();
    this.stats.updateMs = performance.now() - t0;
  }

  /** Confidence decay, courage bookkeeping and the pinned timer. Cheap, so it runs every tick. */
  private decay(s: Spider, dt: number): void {
    const t = this.tunables;
    const b = s.belief;
    b.confidence *= Math.exp(-dt / t.beliefTau);
    if (b.confidence < 0.02) b.confidence = 0;
    b.pinnedFor = b.confidence > 0.1 ? b.pinnedFor + dt : 0;

    // Arm's length: a spider that is standing on you does not need to work it out.
    const d = Math.hypot(s.pos.x - this.player.x, s.pos.z - this.player.z);
    if (this.playerAlive && d < FEEL_RANGE) {
      b.x = this.player.x;
      b.z = this.player.z;
      b.confidence = 1;
      b.at = this.time;
      s.heard = 'touch';
      s.heardAt = this.time;
    }

    if (this.time < s.scaredUntil) {
      s.courage = Math.max(0, s.courage - dt * 0.4);
      return;
    }

    const support = Math.min(1, this.neighbours(s) / t.packSize);
    const gain = t.courageGain * support * b.confidence;
    // «или когда ты слишком долго стоял на месте» — noise coming from the same place for long
    // enough is its own kind of invitation, even to a coward.
    const pinned = b.pinnedFor > t.pinnedSeconds ? t.pinnedGain * b.confidence : 0;
    s.courage = clamp01(s.courage + dt * (gain + pinned - t.courageDecay * (1 - b.confidence)));
  }

  private neighbours(s: Spider): number {
    const r2 = this.tunables.packRadius * this.tunables.packRadius;
    let n = 0;
    for (const o of this.spiders) {
      if (o === s || !o.alive) continue;
      if (o.belief.confidence < 0.15) continue;
      const dx = o.pos.x - s.pos.x;
      const dz = o.pos.z - s.pos.z;
      if (dx * dx + dz * dz < r2) n++;
    }
    return n;
  }

  /**
   * The pack-level decision — the "wolves, not zombies" part.
   *
   * Nobody charges alone. The swarm counts how many of its members are both brave enough and
   * already close to what they believe; when that reaches quorum it rallies (loudly, for
   * `rallySeconds`, which is the player's warning), and only then commits. A commit that finds
   * nothing inside `commitSeconds` collapses back to circling with everyone's nerve spent.
   */
  private pack(dt: number): void {
    const t = this.tunables;
    void dt;
    let ready = 0;
    for (const s of this.spiders) {
      if (!s.alive || this.time < s.scaredUntil) continue;
      if (s.courage < t.readyCourage) continue;
      if (s.belief.confidence < 0.25) continue;
      if (Math.hypot(s.pos.x - s.belief.x, s.pos.z - s.belief.z) > t.stalkRadius * 1.4) continue;
      ready++;
    }
    this.stats.ready = ready;

    if (this.packMode === 'hunt') {
      if (ready >= t.quorum) {
        this.packMode = 'rally';
        this.packUntil = this.time + t.rallySeconds;
      }
      return;
    }
    if (this.packMode === 'rally') {
      // A bang during the rally calls the whole thing off — that is the pack being small and
      // frightened, which is the point.
      if (ready < Math.max(1, t.quorum - 1)) {
        this.packMode = 'hunt';
        return;
      }
      if (this.time >= this.packUntil) {
        this.packMode = 'commit';
        this.packUntil = this.time + t.commitSeconds;
      }
      return;
    }
    if (this.time >= this.packUntil || ready === 0) {
      this.packMode = 'hunt';
      for (const s of this.spiders) {
        if (s.state === 'commit' || s.state === 'rally') {
          s.courage *= 0.35;
          this.enter(s, 'stalk');
        }
      }
    }
  }

  private enter(s: Spider, state: SpiderState): void {
    if (s.state === state) return;
    s.state = state;
    s.stateAt = this.time;
  }

  /** Picks this spider's state and the point it walks towards, then a heading it can actually use. */
  private decide(s: Spider, dt: number): void {
    const t = this.tunables;
    const b = s.belief;

    // --- state ------------------------------------------------------------
    if (s.state === 'panic') {
      if (this.time > s.scaredUntil) this.enter(s, 'flee');
    } else if (s.state === 'recoil') {
      if (this.time - s.stateAt > t.recoilSeconds) this.enter(s, 'stalk');
    } else if (this.time < s.scaredUntil) {
      this.enter(s, 'flee');
    } else if (b.confidence < 0.1) {
      this.enter(s, 'idle');
    } else if (this.packMode === 'commit' && s.courage > t.readyCourage * 0.6) {
      this.enter(s, 'commit');
    } else if (this.packMode === 'rally' && s.courage > t.readyCourage * 0.6) {
      this.enter(s, 'rally');
    } else if (s.courage > t.creepCourage) {
      this.enter(s, 'creep');
    } else {
      this.enter(s, 'stalk');
    }

    // --- goal -------------------------------------------------------------
    s.orbit += (t.orbitSpeed * Math.PI / 180) * dt * s.orbitDir;
    let speed = t.speedStalk;
    let gx = s.goal.x;
    let gz = s.goal.z;

    switch (s.state) {
      case 'idle': {
        speed = t.speedIdle;
        // Drift, slowly, and mostly stand still: an idle spider that patrols is a spider the
        // player can hear. Silence is the pack's camouflage.
        if (this.rng() < 0.06) {
          gx = s.pos.x + range(this.rng, -6, 6);
          gz = s.pos.z + range(this.rng, -6, 6);
        } else if (this.rng() < 0.5) {
          gx = s.pos.x;
          gz = s.pos.z;
        }
        break;
      }
      case 'stalk':
      case 'creep': {
        const r = s.state === 'creep' ? t.creepRadius : t.stalkRadius;
        speed = s.state === 'creep' ? t.speedCreep : t.speedStalk;
        // The orbit slot is what makes this circling rather than converging: every spider owns
        // a different angle around the belief and walks it, so the pack closes as a ring.
        gx = b.x + Math.cos(s.orbit) * r;
        gz = b.z + Math.sin(s.orbit) * r;
        break;
      }
      case 'rally': {
        // Hold, and shout. Standing still here is what gives the player the second and a half.
        speed = 0.35;
        gx = b.x + Math.cos(s.orbit) * (t.creepRadius + 0.6);
        gz = b.z + Math.sin(s.orbit) * (t.creepRadius + 0.6);
        break;
      }
      case 'commit': {
        speed = t.speedCommit;
        gx = b.x;
        gz = b.z;
        break;
      }
      case 'recoil':
      case 'flee':
      case 'panic': {
        speed = s.state === 'panic' ? t.speedStalk : t.speedFlee;
        const ax = s.state === 'recoil' ? b.x : s.scareX;
        const az = s.state === 'recoil' ? b.z : s.scareZ;
        const dx = s.pos.x - ax;
        const dz = s.pos.z - az;
        const len = Math.max(0.001, Math.hypot(dx, dz));
        gx = s.pos.x + (dx / len) * 9;
        gz = s.pos.z + (dz / len) * 9;
        break;
      }
    }

    s.goal.set(clamp(gx, -33, 33), 0, clamp(gz, -23, 23));

    // --- heading ----------------------------------------------------------
    let dx = s.goal.x - s.pos.x;
    let dz = s.goal.z - s.pos.z;
    let len = Math.hypot(dx, dz);
    if (len < 0.25) {
      // Arrived. Keep the last heading rather than jittering on the spot.
      dx = s.headX;
      dz = s.headZ;
      len = 1;
      speed = Math.min(speed, t.speedIdle * 0.4);
    }
    dx /= len;
    dz /= len;

    // Personal space, so the ring does not collapse into one clump of overlapping bodies.
    for (const o of this.spiders) {
      if (o === s || !o.alive) continue;
      const ox = s.pos.x - o.pos.x;
      const oz = s.pos.z - o.pos.z;
      const d2 = ox * ox + oz * oz;
      if (d2 > 2.25 || d2 < 1e-6) continue;
      const inv = 1 / Math.sqrt(d2);
      dx += ox * inv * 0.8;
      dz += oz * inv * 0.8;
    }
    const dl = Math.max(1e-4, Math.hypot(dx, dz));
    dx /= dl;
    dz /= dl;

    // Up, before around. A spider that has walked into the side of a crate or into a shelf
    // upright would rather go over it than take the long way — that is what makes a warehouse
    // full of racks *their* terrain and not the player's. `climbable` refuses anything whose
    // top it cannot find below the ceiling limit, so the hall's outer walls are still walls.
    const face = this.climbable(s, dx, dz);
    if (face > 0) {
      s.climbUntil = this.time + 0.45;
      s.headX = dx;
      s.headZ = dz;
      s.vel.x = dx * speed * 0.6;
      s.vel.z = dz * speed * 0.6;
      return;
    }

    const chosen = this.whisker(s, dx, dz);
    s.headX = chosen.x;
    s.headZ = chosen.z;
    s.vel.x = chosen.x * speed;
    s.vel.z = chosen.z * speed;
  }

  /**
   * Is the thing straight ahead something this spider can get on top of?
   *
   * Returns the height it would crest at, or 0 for "go round". The test is deliberately crude —
   * blocked at foot level, free at some height below `climbCeiling` — because that is exactly
   * what a blind animal can find out by feeling: my feet are against something, and higher up
   * there is nothing.
   */
  private climbable(s: Spider, dx: number, dz: number): number {
    const t = this.tunables;
    const px = s.pos.x + dx * 0.45;
    const pz = s.pos.z + dz * 0.45;
    if (this.free(px, s.pos.y + t.stepHeight * 0.9, pz)) return 0;
    for (let h = s.pos.y + 0.75; h <= t.climbCeiling; h += 0.55) {
      if (this.free(px, h, pz)) return h;
    }
    return 0;
  }

  private readonly headScratch = { x: 0, z: 0 };

  /**
   * Obstacle avoidance without a pathfinder: probe a fan of headings and take the best
   * compromise between "where I want to go" and "where I can actually get".
   *
   * A pathfinder would be the wrong tool anyway. A spider does not know the room — it knows a
   * direction and what its feet run into, and a blind creature bouncing off a rack is the
   * correct behaviour, not a failure of navigation. The probe is done at the stepped-up height,
   * so a shelf deck or a crate reads as walkable rather than as a wall, which is where "лазают
   * по стеллажам" comes from.
   */
  private whisker(s: Spider, dx: number, dz: number): { x: number; z: number } {
    const t = this.tunables;
    const probe = s.state === 'commit' || s.state === 'flee' ? 1.6 : 1.1;
    const base = Math.atan2(dz, dx);
    let bestX = dx;
    let bestZ = dz;
    let best = -Infinity;
    for (const off of FAN) {
      const a = base + (off * Math.PI) / 180;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      const px = s.pos.x + cx * probe;
      const pz = s.pos.z + cz * probe;
      const clear = this.free(px, s.pos.y + t.stepHeight * 0.9, pz) ? 1 : 0;
      // Half-step too, so a spider does not walk into a corner it can enter but not leave.
      const half = this.free(
        s.pos.x + cx * probe * 0.5,
        s.pos.y + t.stepHeight * 0.9,
        s.pos.z + cz * probe * 0.5,
      )
        ? 1
        : 0;
      const align = cx * dx + cz * dz;
      const score = clear * 2 + half * 0.6 + align;
      if (score > best) {
        best = score;
        bestX = cx;
        bestZ = cz;
      }
    }
    this.headScratch.x = bestX;
    this.headScratch.z = bestZ;
    return this.headScratch;
  }

  private free(x: number, feetY: number, z: number): boolean {
    const t = this.tunables;
    const boxes = this.world.query(
      x - t.radius,
      feetY,
      z - t.radius,
      x + t.radius,
      feetY + t.height,
      z + t.radius,
      this.scratchBoxes,
    );
    return canOccupy(boxes, x, feetY, z, t.radius, t.height);
  }

  /** Gravity, collide-and-slide, and the ledge climbing that comes with it for free. */
  private integrate(s: Spider, dt: number): void {
    const t = this.tunables;
    const v = this.scratchVel;
    v.copy(s.vel);
    // «Ползают, лазают по предметам и стеллажам»: a shelf upright is not an obstacle to a
    // spider, it is a road. While the body is pressed against something it wants to get past,
    // gravity is replaced by a climb — which is also why a rack ends up full of them.
    const climbing = this.time < s.climbUntil && s.pos.y < t.climbCeiling;
    v.y = climbing ? t.climbSpeed : s.vel.y - 9.81 * dt;
    const bx = s.pos.x;
    const by = s.pos.y;
    const bz = s.pos.z;
    const res = moveBody(this.world, s.pos, v, dt, this.shape, s.grounded && !climbing);
    s.vel.y = climbing ? 0 : v.y;
    s.grounded = res.grounded;
    if (res.grounded && !climbing) s.vel.y = 0;

    const moved = Math.hypot(s.pos.x - bx, s.pos.z - bz);
    const wanted = Math.hypot(s.vel.x, s.vel.z) * dt;
    if (res.hitWall && wanted > 1e-4 && moved < wanted * 0.5 && s.pos.y < t.climbCeiling) {
      // Blocked and still pushing. Keep the cling alive for a moment past the last contact, so
      // cresting the lip does not drop it back down the face it just came up.
      s.climbUntil = this.time + 0.35;
    } else if (climbing && !res.hitWall) {
      s.climbUntil = 0;
    }
    // Vertical travel counts as walking: going up a steel upright is exactly the noisy part.
    s.sinceStep += moved + Math.abs(s.pos.y - by) * 0.8;
  }

  // ---- the voice ----------------------------------------------------------

  /**
   * Footfalls and clicks.
   *
   * Both are real bus events with real loudness, so they draw marks and can be heard by other
   * spiders exactly like anything else. The click rate is the whole tell: a `clickSlow` of
   * seven seconds means an idle pack is essentially silent, and `clickFast` of half a second
   * during a rally means the room fills with marks a beat before the rush.
   */
  private voice(s: Spider, dt: number): void {
    const t = this.tunables;

    if (s.sinceStep >= t.stride) {
      s.sinceStep = 0;
      // «По железному стеллажу громче, чем по бетону» — standing on anything at all means the
      // spider is on steel shelving or a crate lid, and it rings.
      const elevated = s.pos.y > UP_EPS;
      this.bus.emit({
        source: 'spider',
        x: s.pos.x,
        y: s.pos.y + 0.08,
        z: s.pos.z,
        loudness: elevated ? t.stepLoudnessMetal : t.stepLoudnessFloor,
        material: elevated ? 'steel' : undefined,
      });
      this.stats.steps++;
    }

    // The gap is recomputed every tick from the *current* mood, not from the mood the spider was
    // in when it last spoke. Without the clamp a spider that fell quiet while stalking sits on a
    // ten-second timer straight through the rally it is supposed to be shouting during — which is
    // exactly the bug that made a rally sound like a stalk.
    const gap = t.clickSlow + (t.clickFast - t.clickSlow) * this.arousal(s);
    if (s.clickIn > gap * 1.5) s.clickIn = gap * range(this.rng, 0.6, 1.5);
    s.clickIn -= dt;
    if (s.clickIn <= 0) {
      this.click(s);
      s.clickIn = gap * range(this.rng, 0.6, 1.5);
    }

    if (s.state === 'panic') {
      s.smashIn -= dt;
      if (s.smashIn <= 0 && this.props !== null) {
        // «Подстреленный или напуганный паук в панике крушит пропы — и этим освещает ползала.»
        // Nothing is faked: the impulse goes into Rapier and the marks come from the contacts.
        this.props.disturb(s.pos.x, s.pos.y + 0.3, s.pos.z, 1.8, t.smashImpulse);
        s.smashIn = t.smashSeconds * range(this.rng, 0.7, 1.4);
      }
    }
  }

  /** 0..1 — how wound up this spider is. Drives the click rate and nothing else. */
  private arousal(s: Spider): number {
    if (s.state === 'rally') return 1;
    if (s.state === 'commit') return 0.9;
    if (s.state === 'panic') return 0.85;
    if (s.state === 'flee' || s.state === 'recoil') return 0.45;
    if (s.state === 'idle') return 0.05;
    // Stalking and creeping: the more it believes and the braver it is, the more it talks.
    // Deliberately low: a stalking pack has to be *almost* silent, or the rally has nothing
    // to contrast with and the player cannot read "now it starts" off the click density.
    return clamp01(s.belief.confidence * 0.5 + s.courage * 0.5) * (s.state === 'creep' ? 0.18 : 0.32);
  }

  private click(s: Spider): void {
    const t = this.tunables;
    this.bus.emit({
      source: 'spider',
      x: s.pos.x,
      y: s.pos.y + 0.2,
      z: s.pos.z,
      loudness: t.clickLoudness,
    });
    this.stats.clicks++;
    this.clickWindow.push(this.time);

    // The click's *meaning*, which the bus deliberately does not carry: whoever hears it learns
    // what the speaker thinks, weakly. This is why a pack converges on one belief without any
    // shared blackboard, and why one spider blundering into you brings the others round.
    if (s.belief.confidence < 0.15) return;
    const reach = t.clickLoudness * t.hearing;
    for (const o of this.spiders) {
      if (o === s || !o.alive) continue;
      const d = Math.hypot(o.pos.x - s.pos.x, o.pos.z - s.pos.z);
      if (d > reach) continue;
      const quality = Math.max(0.1, 1 - d / reach) * t.weightChatter * s.belief.confidence;
      this.updateBelief(o, s.belief.x, s.belief.z, quality);
      o.heard = `chatter #${s.id}`;
      o.heardAt = this.time;
    }
  }

  // ---- contact ------------------------------------------------------------

  /**
   * The strike. It is not a kill: a spider that reaches the player bites, screeches — which is
   * the loudest thing it ever does, and gives away the whole pack — and bounces off. «Мелкие,
   * им страшно, поэтому просто не раздерут сразу.» Damage is M5's problem; the recoil is the
   * behaviour the milestone is about.
   */
  private contact(s: Spider): void {
    if (s.state !== 'commit') return;
    const t = this.tunables;
    const dx = s.pos.x - this.player.x;
    const dz = s.pos.z - this.player.z;
    if (dx * dx + dz * dz > t.strikeRange * t.strikeRange) return;
    this.bus.emit({
      source: 'spider',
      x: s.pos.x,
      y: s.pos.y + 0.2,
      z: s.pos.z,
      loudness: t.strikeLoudness,
    });
    this.stats.strikes++;
    s.courage *= 0.3;
    this.enter(s, 'recoil');
  }

  /** Debug/M5 hook: hurt spider `i` — it panics, wrecks the clutter, and takes the pack with it. */
  hurt(i: number): boolean {
    const s = this.spiders[i];
    if (s === undefined || !s.alive) return false;
    s.courage = 0;
    s.scaredUntil = this.time + this.tunables.scareSeconds * 2;
    s.scareX = this.player.x;
    s.scareZ = this.player.z;
    s.smashIn = 0;
    this.enter(s, 'panic');
    return true;
  }

  // ---- reporting ----------------------------------------------------------

  private summarise(): void {
    const by = emptyStateCounts();
    let courage = 0;
    let alive = 0;
    let mode: SpiderState = 'idle';
    let modeN = -1;
    for (const s of this.spiders) {
      if (!s.alive) continue;
      alive++;
      by[s.state]++;
      courage += s.courage;
    }
    for (const st of SPIDER_STATES) {
      if (by[st] > modeN) {
        modeN = by[st];
        mode = st;
      }
    }
    const cut = this.time - 1;
    while (this.clickWindow.length > 0 && this.clickWindow[0]! < cut) this.clickWindow.shift();
    this.stats.byState = by;
    this.stats.count = alive;
    this.stats.mode = mode;
    this.stats.meanCourage = alive === 0 ? 0 : courage / alive;
    this.stats.chatter = this.clickWindow.length;
  }

  getStats(): SwarmStats {
    return this.stats;
  }

  get mode(): 'hunt' | 'rally' | 'commit' {
    return this.packMode;
  }

  /** Everything the overlay and the scenarios read. Allocates — debug paths only. */
  list(): SpiderSnapshot[] {
    return this.spiders.map((s) => ({
      id: s.id,
      x: s.pos.x,
      y: s.pos.y,
      z: s.pos.z,
      state: s.state,
      stateFor: this.time - s.stateAt,
      courage: s.courage,
      belief: { ...s.belief },
      goalX: s.goal.x,
      goalZ: s.goal.z,
      toBelief: Math.hypot(s.pos.x - s.belief.x, s.pos.z - s.belief.z),
      heard: s.heard,
      heardAgo: this.time - s.heardAt,
      elevated: s.pos.y > UP_EPS,
      alive: s.alive,
    }));
  }

  dispose(): void {
    this.unsubscribe();
  }
}

function emptyStateCounts(): Record<SpiderState, number> {
  return { idle: 0, stalk: 0, creep: 0, rally: 0, commit: 0, recoil: 0, flee: 0, panic: 0 };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
