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
  | 'search'
  | 'stalk'
  | 'creep'
  | 'rally'
  | 'commit'
  | 'recoil'
  | 'flee'
  | 'panic';

export const SPIDER_STATES: readonly SpiderState[] = [
  'idle',
  'search',
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
  search: 0x9aa7ae,
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
  /**
   * How much slower a belief fades while the spider is still walking towards it.
   *
   * This number is why the pack arrives at all. `beliefTau` is tuned for "he was here a moment
   * ago and I am standing on the spot" — but a gunshot carries ninety metres and a stalker walks
   * at 2.4 m/s, so a spider that heard one from thirty metres away needs a quarter of a minute
   * just to get there. With one flat tau it forgets halfway, drops to `idle` and stands in the
   * dark: exactly the "они где-то далеко чилят" the player saw. A lead is only disproven by
   * *arriving* and finding nothing, so it is held while the spider is still on its way.
   */
  approachPatience: number;
  /** Weight on the confidence a fresh event can install, per source family. */
  weightPlayer: number;
  weightProp: number;
  weightChatter: number;
  /** Metres: two belief points closer than this count as "the same place" for the pinned timer. */
  pinnedRadius: number;
  /**
   * Ceiling on the confidence a *rumour* can install — a click carries what the speaker
   * believes, and hearsay must never be worth as much as hearing the thing yourself.
   *
   * Without this cap the pack talks itself into certainty: A tells B, B tells A, and both
   * beliefs are refreshed to 1 forever, so the belief can never go stale and the whole swarm
   * spends the rest of the match charging a spot the player left a minute ago. That is exactly
   * the "собираются в кучу и дрожат" the playtest saw.
   */
  rumourCap: number;
  /**
   * Seconds a spider refuses rumours about a place it has just been to and found empty.
   *
   * Arriving is the only way a belief is ever disproven, so the disproof has to stick for
   * longer than it takes a neighbour to click. A *real* noise from that place clears the mark
   * immediately — new evidence beats an old conclusion.
   */
  checkedSeconds: number;

  // --- fear ---------------------------------------------------------------
  /** Loudness, in metres of notice, below which a noise can never be frightening however close. */
  scareLoudness: number;
  /**
   * The distance half of fright: `loudness / distance` at or above this and the spider bolts.
   *
   * Fear used to be decided on the event's raw loudness alone, so one shot scattered every
   * spider in the hall — including the ones seventy metres away, who then spent three seconds
   * running *further* away from the only clue they had all game. A bang is terrifying next to
   * you and merely interesting across the warehouse, and that is what this expresses: a gunshot
   * (90) frightens inside 30 m, a toppling barrel (34) inside 11 m, a running footfall (16)
   * inside 5 m.
   */
  scarePressure: number;
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
  /**
   * Fraction of its nerve a spider keeps when a commit collapses. The pack is supposed to come
   * back in waves — burning it all meant one failed rush ended the fight for the next minute.
   */
  waveCourageKeep: number;
  /**
   * Metres. A spider this close to a belief it is sure of, with a full nerve, bites without
   * waiting for the pack. This is the answer to "если я их вижу я просто расстреляю их": the
   * one you are staring at is not a stationary target, it is the one already in range.
   */
  lungeRange: number;
  /** Confidence needed for that solo lunge. */
  lungeConfidence: number;

  // --- searching ----------------------------------------------------------
  /**
   * Seconds a spider keeps combing the area around a spent lead before it gives up and idles.
   * "Стою N секунд и они пришли" needs this: the player who makes one noise and then freezes
   * gives them nothing more to home in on, so the last stretch has to be a search.
   */
  searchSeconds: number;
  /** Metres the search sweep widens to around the last belief. */
  searchRadius: number;

  // --- flesh --------------------------------------------------------------
  /** Hit points. One rifle round does `bulletDamage`; «пара выстрелов» is the human's brief. */
  hp: number;
  bulletDamage: number;
  /** Loudness of the death screech — the pack hears one of its own die. */
  deathLoudness: number;
  /**
   * Bullet hitbox radius, metres. Deliberately a touch larger than the body: the target is
   * knee-high, moving and lit for two frames by a muzzle flash, so a hitbox tight to the mesh
   * would read as "the gun does not work" rather than as difficulty.
   */
  hitRadius: number;

  // --- geometry of the circling ------------------------------------------
  stalkRadius: number;
  creepRadius: number;
  /** Metres of belief-distance inside which a stalker switches to creeping. */
  creepCourage: number;
  /** How fast the orbit slot walks around the belief, degrees per second. */
  orbitSpeed: number;

  // --- contact ------------------------------------------------------------
  /** Metres from its belief at which a charging spider counts as "there" and can be disappointed. */
  arriveRadius: number;
  /** Metres of personal space, and how hard a body is pushed out of a neighbour's, m/s. */
  separation: number;
  separationPush: number;

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
    speedStalk: 3.2,
    speedCreep: 2.0,
    speedCommit: 5.2,
    speedFlee: 6.0,
    accel: 14,

    hearing: 1,
    beliefTau: 9,
    approachPatience: 5,
    weightPlayer: 1,
    weightProp: 0.65,
    weightChatter: 0.5,
    pinnedRadius: 2.5,
    rumourCap: 0.55,
    checkedSeconds: 10,

    // A gunshot is 90 m of notice and a barrel going over caps at 34; a sprint is 16. So this
    // line puts "the world fell over" and "he fired" on the frightening side and leaves ordinary
    // walking on the informative side, which is exactly the split the concept asks for.
    scareLoudness: 20,
    scarePressure: 4.5,
    scareSeconds: 1.5,
    scareCost: 0.45,

    courageGain: 0.45,
    courageDecay: 0.05,
    packSize: 3,
    packRadius: 11,
    pinnedGain: 0.16,
    pinnedSeconds: 5,

    readyCourage: 0.45,
    quorum: 3,
    rallySeconds: 1.2,
    commitSeconds: 6,
    recoilSeconds: 1.8,
    waveCourageKeep: 0.6,
    lungeRange: 3.2,
    lungeConfidence: 0.45,

    searchSeconds: 45,
    searchRadius: 6,

    hp: 2,
    bulletDamage: 1,
    deathLoudness: 26,
    hitRadius: 0.34,

    stalkRadius: 5.5,
    creepRadius: 2.4,
    creepCourage: 0.25,
    orbitSpeed: 26,

    arriveRadius: 0.9,
    separation: 1.15,
    separationPush: 3.2,

    strikeRange: 0.85,
    strikeLoudness: 24,

    climbSpeed: 1.5,
    climbCeiling: 3,
    stride: 0.85,
    stepLoudnessFloor: 1.6,
    stepLoudnessMetal: 3.6,
    clickLoudness: 12,
    clickSlow: 4.5,
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
  hp: number;
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
  /** Spiders shot dead since the swarm was spawned. */
  kills: number;
  /** Simulation cost of the last update, milliseconds. */
  updateMs: number;
  /** Steering decisions taken in the last update — the sliced work, so this should be small. */
  decisions: number;
}

/**
 * A landed bite, handed to whoever cares (M5's player vitals). The swarm itself has no opinion
 * about damage: it reports where the bite came from and moves on, so the health model can live
 * entirely outside this file and be switched off without the pack noticing.
 */
export interface StrikeEvent {
  /** Which spider. */
  readonly id: number;
  /** Where it was standing when it bit — the direction the player was hit from. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly time: number;
}

export type StrikeListener = (strike: StrikeEvent) => void;

/** Just enough of `PropWorld` for a panicking spider to wreck the place. */
export interface Smashable {
  disturb(x: number, y: number, z: number, radius: number, impulse: number): number;
}

interface Spider {
  id: number;
  hp: number;
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
  /** Horizontal velocity the last steering decision asked for, before personal space is added. */
  steerX: number;
  steerZ: number;
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
  /** Simulation time it last had a belief worth walking to — the clock the search runs on. */
  ledAt: number;
  /** The last place it walked to and found empty, and when. Rumours about it are ignored. */
  checkedX: number;
  checkedZ: number;
  checkedAt: number;
  /** Sweep angle of the search pattern, radians. */
  sweep: number;
  /** Simulation time it died, or Infinity. A corpse is furniture: it stops moving and stays. */
  deadAt: number;
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
  private readonly strikeListeners = new Set<StrikeListener>();

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
    kills: 0,
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

  /** Tells `listener` about every landed bite. Returns the unsubscribe. */
  onStrike(listener: StrikeListener): () => void {
    this.strikeListeners.add(listener);
    return () => {
      this.strikeListeners.delete(listener);
    };
  }

  /**
   * A downed player stops being felt at arm's length — he is still heard like anything else,
   * he is simply no longer a body the pack can locate by touch.
   */
  setPlayerAlive(alive: boolean): void {
    this.playerAlive = alive;
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
        s.steerX = 0;
        s.steerZ = 0;
        return true;
      }
    }
    return false;
  }

  private make(id: number, x: number, z: number): Spider {
    const angle = (id / Math.max(1, this.tunables.count)) * Math.PI * 2;
    return {
      id,
      hp: this.tunables.hp,
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
      steerX: 0,
      steerZ: 0,
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
      ledAt: -99,
      checkedX: 0,
      checkedZ: 0,
      checkedAt: -99,
      sweep: angle,
      deadAt: Infinity,
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
    const loudEnough = event.loudness >= t.scareLoudness;

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

      // A real noise from a place this spider had written off is new evidence, and beats the
      // old conclusion: the mark is cleared before the belief is written.
      if (Math.hypot(event.x - s.checkedX, event.z - s.checkedZ) < t.pinnedRadius) {
        s.checkedAt = -99;
      }
      this.updateBelief(s, event.x, event.z, quality * weight);
      s.heard = `${event.source} ${event.loudness.toFixed(0)}m @${d.toFixed(0)}m`;
      s.heardAt = this.time;

      // Fright is loudness *at the ear*, not loudness at the source. A gunshot across the hall
      // is the best news a blind hunter ever gets; a gunshot at your feet is a reason to run.
      const pressure = event.loudness / Math.max(1, d);
      if (loudEnough && pressure >= t.scarePressure) {
        const bite = t.scareCost * Math.min(1, pressure / (t.scarePressure * 2));
        // The concept, verbatim: a shot or a falling barrel *scatters* them as well as
        // attracting them. The belief is updated above — they know where the bang was — and
        // then they get off that spot as fast as they can, which is why shooting *at close
        // range* is a trade and not a solution. From across the hall it is a free address.
        s.courage = Math.max(0, s.courage - bite);
        s.scaredUntil = Math.max(
          s.scaredUntil,
          this.time + t.scareSeconds * Math.min(1, pressure / (t.scarePressure * 2)),
        );
        s.scareX = event.x;
        s.scareZ = event.z;
        this.enter(s, event.source === 'bullet-hit' && d < 1.2 ? 'panic' : 'flee');
      }
    }
  }

  /**
   * Fold one piece of evidence into a belief.
   *
   * `rumour` marks a click — what a neighbour thinks, not what this spider heard. Hearsay is
   * capped and can be refused outright, and that is not a detail: without the cap the pack is a
   * feedback loop that manufactures certainty out of nothing (see `rumourCap`).
   */
  private updateBelief(s: Spider, x: number, z: number, quality: number, rumour = false): void {
    const t = this.tunables;
    const b = s.belief;
    if (rumour) {
      // "I have just been there. There is nothing there. Stop telling me about it."
      if (
        this.time - s.checkedAt < t.checkedSeconds &&
        Math.hypot(x - s.checkedX, z - s.checkedZ) < t.pinnedRadius
      ) {
        return;
      }
      if (b.confidence >= t.rumourCap) return;
      quality = Math.min(quality, t.rumourCap - b.confidence * 0.5);
      if (quality <= 0) return;
    }
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
    if (rumour) b.confidence = Math.min(b.confidence, t.rumourCap);
    b.at = this.time;
    if (moved > t.pinnedRadius) b.pinnedFor = 0;
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
      this.separate(s);
      this.integrate(s, dt);
      this.deoverlap(s);
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
    /*
     * The fix that makes them arrive.
     *
     * A belief is a claim about a place, and the only thing that can disprove it is going there.
     * While the spider is still outside its own stalk ring the claim is untested, so it fades
     * `approachPatience` times more slowly — the lead survives the walk. Once it is on the spot
     * the ordinary tau applies and the belief goes stale in seconds, which is what keeps this
     * "belief" and not "knowledge": standing where the bang was, hearing nothing, it loses him.
     */
    const toBelief = Math.hypot(s.pos.x - b.x, s.pos.z - b.z);
    const enRoute = toBelief > t.stalkRadius;
    b.confidence *= Math.exp(-dt / (enRoute ? t.beliefTau * t.approachPatience : t.beliefTau));
    if (b.confidence < 0.02) b.confidence = 0;
    if (b.confidence > 0.1) s.ledAt = this.time;
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
          s.courage *= t.waveCourageKeep;
          this.enter(s, 'stalk');
        }
      }
    }
  }

  /**
   * "I went there. He is not there." Writes the disproof down — the belief collapses, the place
   * is marked as checked so the pack cannot immediately talk this spider back into it, and the
   * spider starts combing outwards instead of standing on the spot it was wrong about.
   */
  private giveUp(s: Spider): void {
    s.checkedX = s.belief.x;
    s.checkedZ = s.belief.z;
    s.checkedAt = this.time;
    s.belief.confidence = 0;
    s.belief.pinnedFor = 0;
    s.ledAt = this.time;
    s.sweep += 1.3;
    this.enter(s, 'search');
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
      // Out of belief, but not necessarily out of the hunt: a spider that had a lead recently
      // combs the place it lost it instead of standing in the dark. This is the last stretch of
      // "выдал себя, стою — и они пришли": one noise gets them into the room, the search walks
      // them onto him, and `FEEL_RANGE` closes it.
      this.enter(s, this.time - s.ledAt < t.searchSeconds ? 'search' : 'idle');
    } else if (this.packMode === 'commit' && s.courage > t.readyCourage * 0.6) {
      this.enter(s, 'commit');
    } else if (this.packMode === 'rally' && s.courage > t.readyCourage * 0.6) {
      this.enter(s, 'rally');
    } else if (
      // The solo lunge. The pack still decides the mass attack, but a brave spider that is
      // already inside biting distance of something it is sure of does not stand there being
      // shot at while it waits for a quorum.
      s.courage >= t.readyCourage &&
      b.confidence >= t.lungeConfidence &&
      Math.hypot(s.pos.x - b.x, s.pos.z - b.z) < t.lungeRange
    ) {
      this.enter(s, 'commit');
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
      case 'search': {
        // A widening sweep about the point the trail went cold. Slow — it is feeling its way,
        // and a spider that ran the search would be a spider the player can hear coming.
        speed = t.speedCreep;
        const age = this.time - b.at;
        const r = Math.min(t.searchRadius, 1.2 + age * 0.25);
        // The sweep point walks at the spider's own pace, not at a fixed angular rate. With a
        // fixed rate the target ran round the circle faster than the spider could follow at any
        // useful radius, so fourteen searchers all spiralled into the middle and combed the one
        // spot they already knew was empty — the pack looked like a huddle.
        s.sweep += (speed / Math.max(1.2, r)) * dt * s.orbitDir;
        gx = b.x + Math.cos(s.sweep) * r;
        gz = b.z + Math.sin(s.sweep) * r;
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
        // Arrived at the spot it was sure of, and nothing is there. Before this test the pack
        // had no way to be wrong: fourteen bodies converged on one point, jammed against each
        // other and ran on the spot at attack speed for as long as the belief lasted — and the
        // belief lasted forever, because they kept telling each other about it. Going there and
        // finding nobody is the disproof, so it has to actually disprove something.
        if (
          Math.hypot(s.pos.x - b.x, s.pos.z - b.z) < t.arriveRadius &&
          Math.hypot(s.pos.x - this.player.x, s.pos.z - this.player.z) > t.strikeRange * 2
        ) {
          this.giveUp(s);
          return;
        }
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
      // Arrived: stop. It used to keep a fifth of walking pace "so it does not jitter on the
      // spot", which meant an idle spider drifted across the hall for ever, ground along every
      // shelf it met and never shut up — a permanent noise floor made of spiders going nowhere.
      dx = s.headX;
      dz = s.headZ;
      len = 1;
      speed = 0;
    }
    dx /= len;
    dz /= len;

    // Up, before around. A spider that has walked into the side of a crate or into a shelf
    // upright would rather go over it than take the long way — that is what makes a warehouse
    // full of racks *their* terrain and not the player's. `climbable` refuses anything whose
    // top it cannot find below the ceiling limit, so the hall's outer walls are still walls.
    const face = this.climbable(s, dx, dz);
    if (face > 0) {
      s.climbUntil = this.time + 0.45;
      s.headX = dx;
      s.headZ = dz;
      s.steerX = dx * speed * 0.6;
      s.steerZ = dz * speed * 0.6;
      return;
    }

    const chosen = this.whisker(s, dx, dz);
    s.headX = chosen.x;
    s.headZ = chosen.z;
    s.steerX = chosen.x * speed;
    s.steerZ = chosen.z * speed;
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

  /**
   * Personal space, as a continuous force on the velocity, every tick.
   *
   * It used to be a kick added to the steering direction on the decision slice, with a hard
   * cutoff at 1.5 m: inside the ring a spider was shoved out at full strength, one frame later
   * it was outside and walked straight back in, and at fifteen decisions a second that reads as
   * a knot of spiders vibrating. A smooth falloff applied every tick cannot oscillate — the
   * push fades to nothing exactly where it stops applying — and it costs a handful of flops.
   */
  private separate(s: Spider): void {
    const t = this.tunables;
    const r = t.separation;
    // The steering decision is the baseline every tick; the push is added on top of it and never
    // to itself, or eight ticks between decisions would compound into a launch.
    s.vel.x = s.steerX;
    s.vel.z = s.steerZ;
    let px = 0;
    let pz = 0;
    for (const o of this.spiders) {
      if (o === s || !o.alive) continue;
      const dx = s.pos.x - o.pos.x;
      const dz = s.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const w = 1 - d / r;
      px += (dx / d) * w * w;
      pz += (dz / d) * w * w;
    }
    if (px === 0 && pz === 0) return;
    const len = Math.hypot(px, pz);
    const push = Math.min(1, len) * t.separationPush;
    s.vel.x = s.steerX + (px / len) * push;
    s.vel.z = s.steerZ + (pz / len) * push;
  }

  /**
   * Spiders are bodies, and two bodies cannot be in the same place. They collide with the world
   * but never collided with each other, which is why fourteen of them committing on one point
   * ended up 8 cm apart, inside each other. A force cannot fix that — at 5.2 m/s of commit speed
   * any force loses to the goal line — so overlap is resolved as position, once per tick, half
   * the error each (the other half arrives when the neighbour's turn comes round).
   *
   * Height is respected: one on a shelf above another is not overlapping it, it is standing on it.
   */
  private deoverlap(s: Spider): void {
    const min = this.tunables.radius * 2;
    for (const o of this.spiders) {
      if (o === s || !o.alive) continue;
      if (Math.abs(s.pos.y - o.pos.y) > this.tunables.radius) continue;
      const dx = s.pos.x - o.pos.x;
      const dz = s.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > min * min) continue;
      // Exactly coincident bodies (a spawn on a spawn) need a direction from somewhere; the id
      // gives a deterministic one, which is what matters more than which way it points.
      const d = Math.sqrt(d2);
      const nx = d > 1e-6 ? dx / d : Math.cos(s.id * 2.399);
      const nz = d > 1e-6 ? dz / d : Math.sin(s.id * 2.399);
      const fix = (min - d) * 0.5;
      s.pos.x += nx * fix;
      s.pos.z += nz * fix;
    }
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
        kind: 'step',
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
    // «чтобы переговоры были слышны не только у взвинченной стаи, а в целом»: even a pack with
    // nothing to say checks in with itself. The contrast with a rally is still an order of
    // magnitude, which is the part that has to survive.
    if (s.state === 'idle') return 0.18;
    // A searching pack talks: it has lost him and is asking the others where he went. It is also
    // the player's cue that his one noise is still being worked on.
    if (s.state === 'search') return 0.45;
    // Stalking and creeping: the more it believes and the braver it is, the more it talks.
    // Deliberately low: a stalking pack has to be *almost* silent, or the rally has nothing
    // to contrast with and the player cannot read "now it starts" off the click density.
    return (
      0.14 +
      clamp01(s.belief.confidence * 0.5 + s.courage * 0.5) * (s.state === 'creep' ? 0.3 : 0.45)
    );
  }

  private click(s: Spider): void {
    const t = this.tunables;
    this.bus.emit({
      source: 'spider',
      x: s.pos.x,
      y: s.pos.y + 0.2,
      z: s.pos.z,
      loudness: t.clickLoudness,
      kind: 'chatter',
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
      this.updateBelief(o, s.belief.x, s.belief.z, quality, true);
      o.heard = `chatter #${s.id}`;
      o.heardAt = this.time;
    }
  }

  // ---- contact ------------------------------------------------------------

  /**
   * The strike. It is not a kill: a spider that reaches the player bites, screeches — which is
   * the loudest thing it ever does, and gives away the whole pack — and bounces off. «Мелкие,
   * им страшно, поэтому просто не раздерут сразу.» How much that bite *hurts* is not decided
   * here: the strike is announced through `onStrike` and the health model outside owns the
   * answer. The recoil is the behaviour this milestone is about.
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
      kind: 'bite',
    });
    this.stats.strikes++;
    for (const listener of this.strikeListeners) {
      listener({ id: s.id, x: s.pos.x, y: s.pos.y, z: s.pos.z, time: this.time });
    }
    s.courage *= 0.3;
    this.enter(s, 'recoil');
  }

  /**
   * A bullet, as a segment. `main.ts` hands us every hitscan the rifle resolved this frame; we
   * test it against the pack ourselves rather than making the weapon know what a spider is —
   * the rifle stays a ray, the swarm owns its own hitboxes.
   *
   * The body is a sphere around the thorax: the shape file draws legs, but a leg-accurate hitbox
   * on a knee-high, fast, unlit target would make the pack unhittable in the dark, and the
   * human's yardstick is «пара выстрелов», not «пара выстрелов если попал в грудь».
   *
   * Returns the id of the spider hit, or -1. The nearest one along the segment wins, so a
   * bullet cannot kill two spiders standing in a line — it stops in the first.
   */
  shoot(
    ox: number,
    oy: number,
    oz: number,
    ex: number,
    ey: number,
    ez: number,
    damage = this.tunables.bulletDamage,
  ): number {
    const dx = ex - ox;
    const dy = ey - oy;
    const dz = ez - oz;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 <= 1e-6) return -1;
    const r = this.tunables.hitRadius;
    let best: Spider | null = null;
    let bestT = Infinity;
    for (const s of this.spiders) {
      if (!s.alive) continue;
      const cx = s.pos.x - ox;
      const cy = s.pos.y + this.tunables.height * 0.5 - oy;
      const cz = s.pos.z - oz;
      // Closest approach of the segment to the body centre, clamped to the segment.
      let u = (cx * dx + cy * dy + cz * dz) / len2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = cx - dx * u;
      const py = cy - dy * u;
      const pz = cz - dz * u;
      if (px * px + py * py + pz * pz > r * r) continue;
      if (u < bestT) {
        bestT = u;
        best = s;
      }
    }
    if (best === null) return -1;
    this.damage(best, damage);
    return best.id;
  }

  /**
   * Takes `amount` off a spider. A wound that does not kill throws it into panic — it is a small
   * frightened animal, and being shot at is the loudest argument in the game for running away and
   * wrecking whatever is in reach. A wound that kills emits one honest event on the bus at the
   * body's position: the death is *heard* by the rest of the pack like any other noise, which is
   * why killing one in the open pulls the others towards the corpse.
   */
  private damage(s: Spider, amount: number): void {
    s.hp -= amount;
    if (s.hp > 0) {
      this.scare(s, this.player.x, this.player.z, 2);
      return;
    }
    s.alive = false;
    s.deadAt = this.time;
    s.steerX = 0;
    s.steerZ = 0;
    s.hp = 0;
    s.vel.set(0, 0, 0);
    s.state = 'idle';
    s.belief.confidence = 0;
    s.courage = 0;
    this.stats.kills++;
    this.bus.emit({
      source: 'spider',
      x: s.pos.x,
      y: s.pos.y + 0.1,
      z: s.pos.z,
      loudness: this.tunables.deathLoudness,
      kind: 'death',
    });
    this.summarise();
  }

  /** Shared body of «something terrible happened right here»: nerve gone, run, smash things. */
  private scare(s: Spider, x: number, z: number, scale: number): void {
    s.courage = 0;
    s.scaredUntil = this.time + this.tunables.scareSeconds * scale;
    s.scareX = x;
    s.scareZ = z;
    s.smashIn = 0;
    this.enter(s, 'panic');
  }

  /** Debug/M5 hook: hurt spider `i` — it panics, wrecks the clutter, and takes the pack with it. */
  hurt(i: number): boolean {
    const s = this.spiders[i];
    if (s === undefined || !s.alive) return false;
    this.scare(s, this.player.x, this.player.z, 2);
    return true;
  }

  // ---- the swarm as matter -------------------------------------------------

  /**
   * Writes every spider's world transform into the arrays the lidar's body source hands us.
   * Deliberately allocation-free and dumb: the lidar must not have to know what a `Spider` is,
   * and the swarm must not have to know what a point cloud is.
   *
   * `moving` is 1 for a living spider and 0 for a corpse, which is the whole behaviour the human
   * asked for: a spider you scanned crawls out of its own point cloud and the points fade, a
   * spider you shot stays on the floor as a permanent stamp — the lidar remembers the kill.
   *
   * Bodies past `count` are parked far below the hall so a scan can never touch them.
   */
  poseInto(pos: Float32Array, quat: Float32Array, moving: Uint8Array, settleAt: Float32Array): void {
    const cap = moving.length;
    for (let i = 0; i < cap; i++) {
      const s = this.spiders[i];
      if (s === undefined) {
        pos[i * 3] = 0;
        pos[i * 3 + 1] = -1000;
        pos[i * 3 + 2] = 0;
        quat[i * 4] = 0;
        quat[i * 4 + 1] = 0;
        quat[i * 4 + 2] = 0;
        quat[i * 4 + 3] = 1;
        moving[i] = 0;
        settleAt[i] = 0;
        continue;
      }
      pos[i * 3] = s.pos.x;
      pos[i * 3 + 1] = s.pos.y;
      pos[i * 3 + 2] = s.pos.z;
      // Yaw only: the body is flat and the shape is symmetric about its own vertical.
      const half = Math.atan2(s.headZ, s.headX) * -0.5;
      quat[i * 4] = 0;
      quat[i * 4 + 1] = Math.sin(half);
      quat[i * 4 + 2] = 0;
      quat[i * 4 + 3] = Math.cos(half);
      moving[i] = s.alive ? 1 : 0;
      settleAt[i] = s.alive ? 0 : s.deadAt;
    }
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
      hp: s.hp,
    }));
  }

  dispose(): void {
    this.unsubscribe();
    this.strikeListeners.clear();
  }
}

function emptyStateCounts(): Record<SpiderState, number> {
  return { idle: 0, search: 0, stalk: 0, creep: 0, rally: 0, commit: 0, recoil: 0, flee: 0, panic: 0 };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
