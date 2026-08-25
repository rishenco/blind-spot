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
 *    physics actually raised. The one exception is the nose (M6b, `smellRange`): inside two
 *    metres a spider simply knows, because a blind predator standing next to you does not need
 *    to reason about footsteps — and because standing still must not make you furniture.
 *
 * 2. **Belief, not knowledge.** Each spider carries one point and one confidence. Confidence
 *    decays; a noise refreshes it; nothing else does. Two spiders can believe different things,
 *    and usually do — which is what makes the pack look like it is searching rather than
 *    following a waypoint.
 *
 * 3. **Chatter is the pack's state, made audible.** A click is a real bus event with a real
 *    loudness, so it draws a mark on the player's HUD like anything else. Since M6b a spider
 *    speaks in exactly two situations — frozen and listening (rare, one at a time) or committed
 *    and on top of you (dense) — and is silent in between; see `voice`. That is the tell the
 *    player has to learn to read, and it is why clicks are not flavour.
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
 *
 * M4f — three fixes after the first playtest, each independent and each with its own keyframe:
 *
 * 5. **A gunshot is a call, not a threat.** The muzzle blast pulls belief towards it like any
 *    loud noise, but the loudness-based fright test now excludes it outright — see `hear`. What
 *    personally frightens a spider is the bullet's real path, tested every shot in `shoot`
 *    against every spider's actual body: inside `hitRadius` it is a hit, out to `nearMissRadius`
 *    it is a graze that only spooks (`nearMiss`).
 *
 * 6. **Walking is close to silent; running is not.** `hear` hard-caps how far a `player-step`
 *    event can be heard at all when its loudness says "walk" (`stepQuietLoudness` /
 *    `stepQuietReach`) — a sprint is left at its ordinary loudness-times-`hearing` reach. The
 *    spread between the two is deliberately large, not a tuning nudge.
 *
 * 7. **The pack is 2-3 companies, not one mob.** `spawn` splits it into `groups` territorial
 *    clusters; `click`'s rumour propagation refuses to cross into another spider's `groupId`
 *    (scaled by `crossGroupChatter`, 0 by default). Real bus events are still heard by everyone
 *    — only hearsay is partitioned, which is what lets one company rally while another, out of
 *    earshot of the chatter, never finds out.
 */
import * as THREE from 'three';

import { StaticWorld, canOccupy, highestTopUnder, type Aabb, type BodyShape } from '../core/collision';
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

  // --- smell (M6b) --------------------------------------------------------
  /**
   * The one non-acoustic sense, and it is deliberately tiny: «паукам дать обоняние, чтобы вблизи
   * они меня чуяли и нападали. а то можно стоять и они мимо ходят».
   *
   * Inside this radius a spider knows where the player is without a single sound, and — this is
   * the half that matters — it *attacks* rather than walking past. Standing perfectly still still
   * saves you from the hall; it stops saving you the moment one of them is at your feet.
   *
   * It must never grow into a second, bigger sense of hearing: two metres is one body length plus
   * a jump, and the whole value of silence rests on this number staying that small.
   */
  smellRange: number;
  /** Metres of height difference the nose still works across — a floor away is not "вблизи". */
  smellRise: number;

  // --- hearing and belief -------------------------------------------------
  /**
   * Multiplier on an event's loudness before the audibility test. 1.0 means a spider hears
   * exactly as far as the debug rings drawn in M2 say it does — the same number, one scale.
   */
  hearing: number;
  /**
   * M4f: «если ходить а не бегать пауки не должны находить особо тебя, только если они и так
   * близко». A footstep at or below this loudness (`player-step` only — a landing thump is its
   * own event and is left alone) counts as a *walk*, and a walk is not allowed to reach further
   * than `stepQuietReach` no matter what `hearing` says — the ordinary loudness-times-hearing
   * reach still applies above this line, which is what lets a sprint (16 m of loudness) carry
   * across most of a room while a walk (9 m) carries almost nothing. The split lives here rather
   * than in the loudness numbers themselves (owned by `main.ts`, not this file) because "how far
   * a given loudness travels" is exactly what `hear` already owns.
   */
  stepQuietLoudness: number;
  /** Metres a walking footstep can be heard at, full stop — see `stepQuietLoudness`. */
  stepQuietReach: number;
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
  /**
   * M4f: «пауки пугаются любого выстрела, а должны только когда почти или попадаешь». The
   * muzzle blast itself no longer runs the generic loudness/distance fear test at all (see
   * `hear`) — a gunshot is a *call*, not a threat, and only draws belief. What still frightens a
   * spider personally is the bullet's actual path: `Swarm.shoot` already tests the shot segment
   * against a hit sphere, and a *miss* is the same geometry with a bigger radius. This is that
   * radius, in metres of perpendicular distance from the segment. Inside `hitRadius` it is a
   * hit and does damage; between that and here it is a miss close enough to spook.
   */
  nearMissRadius: number;

  // --- groups ---------------------------------------------------------------
  /**
   * M4f: «раздели их на 2-3 группы, а то сейчас как один большой моб себя ведут». Spawn splits
   * the pack into this many territorial companies (nearest-cluster-centre, decided once at
   * spawn) and `click` only lets a rumour cross into a spider's own company — see
   * `crossGroupChatter`. Real events (footsteps, impacts, gunshots, bites, deaths) are heard by
   * everybody regardless of group; only hearsay is partitioned. This is not a faction system —
   * groups do not know about each other at all, they simply never talk.
   */
  groups: number;
  /**
   * 0..1 multiplier on a rumour's quality when it would cross from one group into another. 0 —
   * the human's «либо никак» — means groups never learn anything from each other's chatter.
   */
  crossGroupChatter: number;

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

  // --- the jump (M6b) -----------------------------------------------------
  /**
   * Metres of one hop at stalking pace; a faster state leaps proportionally further. The whole
   * gait is this: crouch, leap, land, freeze. «Прыжок сам по себе даёт то, за чем мы гонимся, —
   * замер, рывок, замер, — без всякой имитации рваной скорости.»
   */
  hopDistance: number;
  /** Metres it can crest in one leap — how high a shelf or cupboard top it always reaches. */
  hopRise: number;
  /** Metres it will drop off in one leap. Falling further is not refused, it is just not aimed at. */
  hopFall: number;
  /** Apex of the arc above the higher of the two ends, metres. This is what clears the clutter. */
  hopArc: number;
  /** Floor on the airborne time, seconds — a hop shorter than this reads as a twitch, not a leap. */
  hopMinAir: number;
  /** Seconds of freeze between hops: calm (stalking, searching) and hot (rushing, fleeing). */
  restCalm: number;
  restHot: number;
  /** Fraction of a hop cycle the freeze is allowed to eat. Above this the pack stops arriving. */
  restShare: number;
  /**
   * Metres from the player a flying spider will brush the clutter it passes through, and the
   * impulse it puts in. «Мусор на траекторию НЕ влияет — задевание нужно только как подсказка
   * игроку, что мимо него что-то пролетело.» So it is a cue, not physics: it never deflects the
   * jump and it only happens near enough to the player to be one.
   */
  hopBrushRange: number;
  hopBrushImpulse: number;

  // --- noise --------------------------------------------------------------
  /** Loudness of a footfall on concrete, and on anything the spider is standing on top of. */
  stepLoudnessFloor: number;
  stepLoudnessMetal: number;
  /** Loudness of one click. This is the number that makes the pack findable. */
  clickLoudness: number;
  /**
   * Seconds between clicks while frozen and listening, and while rushing.
   *
   * M6b, and this is the rule the milestone would sacrifice anything else for: a spider clicks
   * *only* when it is standing still between hops (rare, one at a time) or when it has committed
   * (dense, panicked, and by then it is next to you). While it is crossing the floor it is
   * silent. Three readable states of the world, on the ear alone: silence means they are moving,
   * a lone click means one is stopped and listening, a rash of them means it is too late.
   */
  clickSlow: number;
  clickFast: number;
  /**
   * Metres from the spot it is charging at, inside which a hot spider is allowed to be loud.
   * «Пошёл в атаку ВБЛИЗИ — плотно, паника, красное рядом.» A pack that has been called and is
   * still crossing the floor is a pack in rally, and rally used to chatter the whole way across
   * the hall — which turned the crossing, the one thing that has to be silent, into the loudest
   * moment in the game. So the dense voice is bought with proximity to its own target, not with
   * the state alone.
   */
  clickCloseRange: number;
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

    smellRange: 2,
    smellRise: 2,

    hearing: 1,
    // Walk is 9 m of loudness in main.ts, sprint is 16 — on their own that is a 1.8x spread,
    // which the playtest correctly called "not on 20%". Capping a walk's reach at 2.5 m (inside
    // the nose plus a hop) while leaving a sprint's 16 m untouched makes it a ~6.4x spread:
    // only spiders already close hear you walk, and running lights up most of a room.
    stepQuietLoudness: 10,
    stepQuietReach: 2.5,
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
    // hitRadius is 0.34 m; a bullet passing within a metre of a spider it did not touch is still
    // a very close call.
    nearMissRadius: 1.1,

    groups: 3,
    crossGroupChatter: 0,

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

    hopDistance: 2,
    // A cupboard is about 2 m and a shelf deck about 1.8: «всегда попадает на верх поверхности»
    // means this has to clear the tallest thing a player can get on top of, with margin.
    hopRise: 2.6,
    hopFall: 3.2,
    hopArc: 0.85,
    hopMinAir: 0.16,
    restCalm: 0.55,
    restHot: 0.1,
    restShare: 0.7,
    hopBrushRange: 3.5,
    hopBrushImpulse: 0.9,

    stepLoudnessFloor: 1.6,
    stepLoudnessMetal: 3.6,
    clickLoudness: 12,
    // A frozen spider speaks about once every seven seconds, and a committed one three times a
    // second. That is the whole dynamic range of the pack, and it is deliberately enormous.
    clickSlow: 7,
    clickFast: 0.32,
    clickCloseRange: 6,
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
  /** Which company it belongs to — see `SpiderTunables.groups`. */
  groupId: number;
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
  /** Where the spider is in its hop cycle — 'air' is mid-leap, 'rest' is the freeze. */
  phase: HopPhase;
  /** Seconds it has been in that phase. A long 'rest' is a spider standing and listening. */
  phaseFor: number;
  alive: boolean;
  hp: number;
}

/**
 * Where a spider is in one jump. There is no walking any more: a spider is either in the air or
 * frozen on a surface, and the freeze is the only time a calm one makes a sound.
 */
export type HopPhase = 'rest' | 'air';

export interface SwarmStats {
  count: number;
  /** How many spiders are in each state. */
  byState: Record<SpiderState, number>;
  mode: SpiderState;
  meanCourage: number;
  ready: number;
  /**
   * M4f debug tool: how many living spiders each company has, index = groupId. Only real way to
   * see the split from the outside without walking the raw list — the point of grouping is that
   * it does not show up as a single pack-wide number, so the pack-wide numbers need this next to
   * them or the feature is unverifiable from the panel.
   */
  byGroup: number[];
  /** Clicks per second across the whole pack, sampled over the last second. */
  chatter: number;
  clicks: number;
  /** M6b debug: how many of the pack are in the air right now, and hops taken since the spawn. */
  airborne: number;
  hops: number;
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
 * What a reinforcement call actually managed to place.  This is deliberately richer than a
 * boolean: the round/debug UI can say whether a wave was capped, blocked by the player, or
 * fully admitted without inspecting the swarm's private array.
 */
export interface ReinforcementResult {
  requested: number;
  added: number;
  alive: number;
  /** The maximum simultaneous living pack size, fixed from the round's initial spawn count. */
  cap: number;
  /** Candidate positions tested; bounded so a blocked edge cannot hitch the frame. */
  attempts: number;
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
  /** Which company it belongs to — see `SpiderTunables.groups`. Set once, at spawn. */
  groupId: number;
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
  /** The hop cycle — see `HopPhase`. `hopT` runs from 0 to `hopDur` inside the current phase. */
  hopPhase: HopPhase;
  hopT: number;
  hopDur: number;
  /** The two ends of the current leap and the height of its arc above them. */
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
  arc: number;
  /** One clutter brush per hop, so a leap past the player's face is a single cue and not a rake. */
  brushed: boolean;
  /**
   * The gait's own silence timer. A leap is silent; so is the short pause between two leaps of a
   * crossing. Only a *listening* pause — one the spider spends deliberately, every few hops —
   * carries a click. `listenIn` counts the hops left until the next one.
   */
  listen: boolean;
  listenIn: number;
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
  slice: number;
  /**
   * This spider's own random stream.
   *
   * It used to draw from one swarm-wide generator, which meant the order in which fourteen
   * spiders happened to consume it decided what every one of them rolled: adding a scenario, or
   * a single extra tick, reshuffled idle wander for the whole pack downstream and broke checks
   * in unrelated sections of the keyframe run. Per-spider streams make a spider's own behaviour
   * depend on its own history and the seed, and nothing else.
   */
  rng: Rng;
  /** Simulation time it last had a belief worth walking to — the clock the search runs on. */
  ledAt: number;
  /**
   * Places this spider has been to and found empty. «Проверил точку, никого нет — пометил её как
   * пустую и ушёл, и на этот же самый старый звук больше не возвращается.» A short ring, because
   * the point is to forget an exhausted lead, not to build a map.
   */
  checked: { x: number; z: number; at: number }[];
  /** Sweep angle of the search pattern, radians. */
  sweep: number;
  /** Simulation time it died, or Infinity. A corpse is furniture: it stops moving and stays. */
  deadAt: number;
}

const UP_EPS = 0.05;

/**
 * The states in which a spider is loud. Everything else is silent while it is moving and rare
 * while it is frozen — see `SpiderTunables.clickSlow`.
 */
const HOT_STATES = new Set<SpiderState>(['rally', 'commit', 'recoil', 'panic']);

/** The states that stop to listen, and so are allowed the occasional lone click. */
const LISTENING_STATES = new Set<SpiderState>(['idle', 'search', 'stalk', 'creep']);

/** Landing spots are looked for along these bearings, in degrees off the way it wants to go. */
const HOP_FAN = [0, 20, -20, 42, -42, 68, -68, 96, -96, 130, -130, 168];

/** ...and at these fractions of the full hop length, nearest-first for the same bearing. */
const HOP_REACH = [1, 0.66, 0.38];

/** Points along the parabola the clearance test samples. Cheap, and enough to keep walls solid. */
const ARC_SAMPLES = [0.25, 0.5, 0.75];

export class Swarm {
  readonly tunables: SpiderTunables;
  private readonly spiders: Spider[] = [];
  private readonly rng: Rng;
  private readonly shape: BodyShape;
  private readonly seed: number;
  /** The round starts with this many predators; reinforcements replace losses, never escalate it. */
  private readonly reinforcementCap: number;
  /** Territorial anchors are made by `spawn` and retained by incremental arrivals. */
  private groupCentres: { x: number; z: number }[] = [];
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
    byGroup: [],
    chatter: 0,
    clicks: 0,
    airborne: 0,
    hops: 0,
    steps: 0,
    strikes: 0,
    kills: 0,
    updateMs: 0,
    decisions: 0,
  };
  private clickWindow: number[] = [];

  private readonly scratchBoxes: Aabb[] = [];

  constructor(
    private readonly world: StaticWorld,
    private readonly bus: SoundBus,
    seed: number,
    tunables: SpiderTunables = defaultSpiderTunables(),
  ) {
    this.tunables = tunables;
    this.seed = seed | 0;
    this.reinforcementCap = Math.max(0, Math.round(tunables.count));
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
    // M4f grouping: pick `groups` cluster centres, deterministically, and hand each spawned
    // spider to whichever centre it landed nearest. This is the "by spawn / by territory" split
    // the brief left up to us — cheap, and it naturally gives each company its own corner of the
    // hall instead of the whole pack starting as one interleaved blob.
    const groupCount = Math.max(1, Math.round(this.tunables.groups));
    const centres: { x: number; z: number }[] = [];
    for (let g = 0; g < groupCount; g++) {
      centres.push({ x: range(this.rng, -28, 28), z: range(this.rng, -19, 19) });
    }
    this.groupCentres = centres;
    let placed = 0;
    let attempts = 0;
    while (placed < n && attempts < n * 60) {
      attempts++;
      const x = range(this.rng, -31, 31);
      const z = range(this.rng, -21, 21);
      if (Math.hypot(x - shun.x, z - shun.z) < 14) continue;
      if (!this.free(x, 0.05, z)) continue;
      let groupId = 0;
      let best = Infinity;
      for (let g = 0; g < centres.length; g++) {
        const d = Math.hypot(x - centres[g]!.x, z - centres[g]!.z);
        if (d < best) {
          best = d;
          groupId = g;
        }
      }
      this.spiders.push(this.make(placed, x, z, groupId));
      placed++;
    }
    this.stats.count = this.spiders.length;
  }

  /**
   * Add replacements without touching any existing body or brain.
   *
   * Unlike `spawn`, this is safe to call during a round: living spiders keep their belief,
   * current hop and state; corpses remain in the lidar/body list as settled props.  Arrivals are
   * sampled from an inset around the hall perimeter, shun the player, and stop after a bounded
   * number of candidates so a cluttered edge cannot turn a wave into an unbounded search.
   */
  reinforce(requested: number, awayFrom?: THREE.Vector3): ReinforcementResult {
    const wanted = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
    const live = this.liveCount();
    const room = Math.max(0, this.reinforcementCap - live);
    const target = Math.min(wanted, room);
    const shun = awayFrom ?? this.player;
    const attemptsLimit = target * 48;
    let attempts = 0;
    let added = 0;

    this.ensureGroupCentres();
    while (added < target && attempts < attemptsLimit) {
      attempts++;
      const candidate = this.edgeCandidate();
      if (Math.hypot(candidate.x - shun.x, candidate.z - shun.z) < 16) continue;
      if (!this.free(candidate.x, 0.05, candidate.z)) continue;
      if (!this.clearOfLiving(candidate.x, candidate.z)) continue;
      this.spiders.push(this.make(this.spiders.length, candidate.x, candidate.z, this.groupFor(candidate.x, candidate.z)));
      added++;
    }
    this.summarise();
    return { requested: wanted, added, alive: this.stats.count, cap: this.reinforcementCap, attempts };
  }

  private liveCount(): number {
    let live = 0;
    for (const s of this.spiders) if (s.alive) live++;
    return live;
  }

  /** Hall bounds are fixed by the generator today; keep arrivals inside the walls, at their edge. */
  private edgeCandidate(): { x: number; z: number } {
    switch (Math.floor(this.rng() * 4)) {
      case 0:
        return { x: range(this.rng, -30.5, -25), z: range(this.rng, -19, 19) };
      case 1:
        return { x: range(this.rng, 25, 30.5), z: range(this.rng, -19, 19) };
      case 2:
        return { x: range(this.rng, -30, 30), z: range(this.rng, -20.5, -15) };
      default:
        return { x: range(this.rng, -30, 30), z: range(this.rng, 15, 20.5) };
    }
  }

  private clearOfLiving(x: number, z: number): boolean {
    const min = this.tunables.radius * 2.25;
    const min2 = min * min;
    for (const s of this.spiders) {
      if (!s.alive) continue;
      const dx = s.pos.x - x;
      const dz = s.pos.z - z;
      if (dx * dx + dz * dz < min2) return false;
    }
    return true;
  }

  private ensureGroupCentres(): void {
    const groups = Math.max(1, Math.round(this.tunables.groups));
    if (this.groupCentres.length === groups) return;
    this.groupCentres = [];
    for (let g = 0; g < groups; g++) {
      this.groupCentres.push({ x: range(this.rng, -28, 28), z: range(this.rng, -19, 19) });
    }
  }

  private groupFor(x: number, z: number): number {
    let groupId = 0;
    let best = Infinity;
    for (let g = 0; g < this.groupCentres.length; g++) {
      const c = this.groupCentres[g]!;
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < best) {
        best = d;
        groupId = g;
      }
    }
    return groupId;
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
        // A parked spider is parked, not still mid-leap towards wherever it was going.
        s.hopPhase = 'rest';
        s.hopT = 0;
        s.hopDur = range(s.rng, 0.05, this.tunables.restCalm);
        s.fromX = px;
        s.fromY = y;
        s.fromZ = pz;
        s.toX = px;
        s.toY = y;
        s.toZ = pz;
        s.brushed = true;
        return true;
      }
    }
    return false;
  }

  private make(id: number, x: number, z: number, groupId = 0): Spider {
    const angle = (id / Math.max(1, this.tunables.count)) * Math.PI * 2;
    return {
      id,
      groupId,
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
      hopPhase: 'rest',
      hopT: 0,
      hopDur: range(this.rng, 0.1, this.tunables.restCalm),
      fromX: x,
      fromY: 0.02,
      fromZ: z,
      toX: x,
      toY: 0.02,
      toZ: z,
      arc: 0,
      brushed: true,
      listen: true,
      listenIn: Math.round(range(this.rng, 1, 5)),
      clickIn: range(this.rng, 0.5, 6),
      smashIn: 0,
      heard: '-',
      heardAt: -99,
      scaredUntil: 0,
      scareX: x,
      scareZ: z,
      slice: id,
      rng: makeRng((this.seed ^ 0x51de_1000) + id * 0x9e37_79b1),
      ledAt: -99,
      checked: [],
      sweep: angle,
      deadAt: Infinity,
    };
  }

  /** The player's body, in world space. Used for contact and for the nose only. */
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
    let reach = event.loudness * t.hearing;
    // M4f: a walked footstep must not carry like a run. `main.ts` already emits a much quieter
    // event for a walk than for a sprint (9 m of loudness against 16), but on their own those
    // numbers are only a 1.8x spread — this is where the spread becomes the "не на 20%" the
    // brief asked for: a walk is hard-capped to `stepQuietReach` regardless of `hearing`, and a
    // sprint is left exactly as loud as its loudness says.
    if (event.source === 'player-step' && event.loudness <= t.stepQuietLoudness) {
      reach = Math.min(reach, t.stepQuietReach);
    }
    if (reach <= 0) return;
    // M4f: «пауки пугаются любого выстрела, а должны только когда почти или попадаешь». The
    // muzzle blast (`gunshot`) is a call, not a threat — it still updates belief below like any
    // other loud, distant noise, it just never runs the fright test. What actually frightens a
    // spider about a shot is the bullet's own path, tested against every spider individually in
    // `shoot`/`nearMiss` with the real geometry, not the loudness of the bang.
    const loudEnough = event.loudness >= t.scareLoudness && event.source !== 'gunshot';

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

      /*
       * M6b #4 — «паук приходит на звук, ничего не находит и остаётся там жить».
       *
       * A place this spider has already been to and found empty is not evidence any more, and
       * the thing that keeps dragging it back is precisely the noise that is still coming from
       * there: a barrel it knocked over itself and that is still rocking, a crate it keeps
       * bumping. So a *world* noise (clutter, another spider) from a checked spot is refused,
       * and refusing it keeps the mark alive — a prop that rattles for a minute stays written
       * off for that minute instead of re-founding the club every two seconds.
       *
       * A noise the *player* made is different: he was not there, and now something over there
       * is his. That clears the mark outright — new evidence beats an old conclusion.
       */
      if (event.source === 'prop-impact') {
        if (this.isChecked(s, event.x, event.z, true)) {
          s.heard = `${event.source} (checked, ignored)`;
          s.heardAt = this.time;
          continue;
        }
      } else {
        this.clearChecked(s, event.x, event.z);
      }
      this.updateBelief(s, event.x, event.z, quality * weight);
      s.heard = `${event.source} ${event.loudness.toFixed(0)}m @${d.toFixed(0)}m`;
      s.heardAt = this.time;

      // Fright is loudness *at the ear*, not loudness at the source — for whatever is still
      // eligible here. `gunshot` itself opted out above (M4f): the bang no longer scares by
      // loudness at any range, only the bullet's real path does (`shoot`/`nearMiss`). What is
      // left on this test is everything else honestly loud at close range: a barrel going over,
      // a bullet actually striking something (`bullet-hit`) nearby, a dying spider's screech.
      const pressure = event.loudness / Math.max(1, d);
      if (loudEnough && pressure >= t.scarePressure) {
        const bite = t.scareCost * Math.min(1, pressure / (t.scarePressure * 2));
        // The concept, verbatim: a loud event *scatters* them as well as attracting them. The
        // belief is updated above — they know where the noise was — and then they get off that
        // spot as fast as they can.
        s.courage = Math.max(0, s.courage - bite);
        s.scaredUntil = Math.max(
          s.scaredUntil,
          this.time + t.scareSeconds * Math.min(1, pressure / (t.scarePressure * 2)),
        );
        s.scareX = event.x;
        s.scareZ = event.z;
        // A spider already in panic is not talked down by a noise. Being shot puts it in panic;
        // the bullet's own impact, going off against the wall a few metres behind it, used to
        // arrive a tick later and demote it to a merely frightened FLEE — the wound's reaction
        // undone by the wound's own sound.
        if (s.state !== 'panic') {
          this.enter(s, event.source === 'bullet-hit' && d < 1.2 ? 'panic' : 'flee');
        }
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
      if (this.isChecked(s, x, z, false)) return;
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
      if ((this.tick + s.slice) % every === 0) {
        this.decide(s, dt * every);
        this.stats.decisions++;
      }
      this.hop(s, dt);
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

    // The nose (M6b). «Слепой хищник вблизи чует» — inside `smellRange` the spider simply
    // knows where he is, with no sound involved at all, which is what stops a motionless player
    // being invisible to something that has walked up to him. It is deliberately *not* a second
    // hearing: two metres, and it needs the player to be at roughly the spider's own level.
    if (this.smells(s)) {
      b.x = this.player.x;
      b.z = this.player.z;
      b.confidence = 1;
      b.at = this.time;
      s.heard = 'smell';
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
    this.markChecked(s, s.belief.x, s.belief.z);
    s.belief.confidence = 0;
    s.belief.pinnedFor = 0;
    s.ledAt = this.time;
    s.sweep += 1.3;
    this.enter(s, 'search');
  }

  /** Writes a place down as empty. The ring is short on purpose: this is forgetting, not mapping. */
  private markChecked(s: Spider, x: number, z: number): void {
    const t = this.tunables;
    for (const c of s.checked) {
      if (Math.hypot(c.x - x, c.z - z) < t.pinnedRadius) {
        c.x = x;
        c.z = z;
        c.at = this.time;
        return;
      }
    }
    s.checked.push({ x, z, at: this.time });
    if (s.checked.length > 3) s.checked.shift();
  }

  /**
   * Has this spider written this place off? `refresh` keeps the mark alive for as long as the
   * same dead noise keeps arriving from it, which is what stops a still-rattling prop from
   * re-founding the club around itself the moment `checkedSeconds` runs out.
   */
  private isChecked(s: Spider, x: number, z: number, refresh: boolean): boolean {
    const t = this.tunables;
    for (const c of s.checked) {
      if (this.time - c.at >= t.checkedSeconds) continue;
      if (Math.hypot(c.x - x, c.z - z) >= t.pinnedRadius) continue;
      if (refresh) c.at = this.time;
      return true;
    }
    return false;
  }

  /** New evidence from a written-off place: the conclusion is dropped. */
  private clearChecked(s: Spider, x: number, z: number): void {
    const t = this.tunables;
    for (let i = s.checked.length - 1; i >= 0; i--) {
      if (Math.hypot(s.checked[i]!.x - x, s.checked[i]!.z - z) < t.pinnedRadius) s.checked.splice(i, 1);
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
    } else if (this.smells(s)) {
      // Inside the nose there is no deliberation and no quorum: «внутри этого радиуса — атака,
      // а не „прошёл мимо“». It sits below the fright branches on purpose — a spider that has
      // just been shot at still runs, however close the player is.
      this.enter(s, 'commit');
    } else if (b.confidence < 0.1) {
      // Out of belief, but not necessarily out of the hunt: a spider that had a lead recently
      // combs the place it lost it instead of standing in the dark. This is the last stretch of
      // "выдал себя, стою — и они пришли": one noise gets them into the room, the search walks
      // them onto him, and the nose closes it.
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

    // Where it *wants* to go, and how fast on average. Nothing here avoids anything: obstacles
    // are the jump's problem now, because the jump is what picks the spot it lands on.
    s.headX = dx;
    s.headZ = dz;
    s.steerX = dx * speed;
    s.steerZ = dz * speed;
  }

  /**
   * The nose. Two metres, and roughly level — a player on top of a cupboard is not smelled from
   * the floor, he is jumped up to.
   */
  private smells(s: Spider): boolean {
    if (!this.playerAlive || !s.alive) return false;
    const t = this.tunables;
    const dx = s.pos.x - this.player.x;
    const dz = s.pos.z - this.player.z;
    if (dx * dx + dz * dz > t.smellRange * t.smellRange) return false;
    return Math.abs(s.pos.y - this.player.y) <= t.smellRise;
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

  // ---- the gait -----------------------------------------------------------

  /**
   * They do not walk. They jump — «как клещи»: freeze, leap, freeze.
   *
   * The whole gait is one kinematic parabola between two chosen spots, with a freeze at each
   * end. That is a cheat and a deliberate one (the human asked for it): there is no gravity
   * integration here, so a jump cannot be short, cannot be nudged by a crate it clips, and
   * always ends exactly on top of something the spider can stand on. The clutter it flies
   * through is not simulated against the body — it is only *brushed*, near the player, as a cue
   * that something went past.
   *
   * The average speed is preserved, so every `speed*` tunable still means what it meant when
   * they walked: one cycle takes `distance / speed`, the freeze eats up to `restShare` of it and
   * the leap gets the rest. A stalking spider therefore covers the hall at stalking pace, in
   * jerks; a committing one crosses the last few metres in two long leaps.
   */
  private hop(s: Spider, dt: number): void {
    if (s.hopPhase === 'air') {
      s.hopT += dt;
      const u = s.hopDur > 1e-5 ? Math.min(1, s.hopT / s.hopDur) : 1;
      s.pos.x = s.fromX + (s.toX - s.fromX) * u;
      s.pos.z = s.fromZ + (s.toZ - s.fromZ) * u;
      s.pos.y = s.fromY + (s.toY - s.fromY) * u + s.arc * 4 * u * (1 - u);
      s.grounded = false;
      // Reported velocity is the honest average of the leap: the renderer's yaw and anything
      // else reading `vel` sees a creature travelling, which it is.
      s.vel.set((s.toX - s.fromX) / Math.max(1e-4, s.hopDur), 0, (s.toZ - s.fromZ) / Math.max(1e-4, s.hopDur));
      if (!s.brushed && u > 0.4) this.brush(s);
      if (u >= 1) {
        s.pos.set(s.toX, s.toY, s.toZ);
        s.vel.set(0, 0, 0);
        s.grounded = true;
        s.hopPhase = 'rest';
        s.hopT = 0;
        s.hopDur = this.restFor(s);
        // Every few hops it stops to listen properly instead of merely gathering itself for the
        // next leap, and that longer pause is the only quiet moment it will speak in.
        s.listen = --s.listenIn <= 0;
        if (s.listen) {
          s.listenIn = Math.round(range(s.rng, 3, 7));
          s.hopDur = Math.max(s.hopDur, this.tunables.restCalm * range(s.rng, 0.8, 1.5));
        }
        this.stats.hops++;
        // The second of the two thumps. «Толчок и приземление — ДВА отдельных звуковых события»:
        // between them the spider makes no sound at all, and the ear builds the arc from the pair.
        this.thump(s);
      }
      return;
    }

    // Frozen. This is the only moment a spider is jostled, clicks, or can be shoved out of a
    // neighbour's body — mid-air it is committed to its parabola and nothing touches it.
    s.vel.set(0, 0, 0);
    s.grounded = true;
    this.deoverlap(s);
    this.settle(s);
    s.hopT += dt;
    if (s.hopT < s.hopDur) return;
    this.launch(s);
  }

  /** A parked or shoved spider drops onto whatever is actually under it. No free-fall needed. */
  private settle(s: Spider): void {
    const top = this.topUnder(s.pos.x, s.pos.z, s.pos.y + 0.35);
    if (top === -Infinity) return;
    if (Math.abs(s.pos.y - top) > 0.01) s.pos.y = top;
  }

  /** Highest surface top under (x,z) at or below `ceilY`, or -Infinity if there is none. */
  private topUnder(x: number, z: number, ceilY: number): number {
    const t = this.tunables;
    const boxes = this.world.query(x - t.radius, -2, z - t.radius, x + t.radius, ceilY, z + t.radius, this.scratchBoxes);
    return highestTopUnder(boxes, x, z, t.radius, -2, ceilY);
  }

  /** Seconds of freeze after the hop just landed — capped so the pack still arrives on time. */
  private restFor(s: Spider): number {
    const t = this.tunables;
    const base = HOT_STATES.has(s.state) ? t.restHot : t.restCalm;
    const dist = Math.hypot(s.toX - s.fromX, s.toZ - s.fromZ);
    const speed = Math.hypot(s.steerX, s.steerZ);
    const rest = dist < 0.05 || speed < 0.05 ? base : Math.min(base, (dist / speed) * t.restShare);
    return Math.max(0.05, rest * range(s.rng, 0.7, 1.35));
  }

  /**
   * Choose a landing spot and leave the ground.
   *
   * The search is a fan of bearings around where the spider wants to go, nearest-aligned first,
   * and for each bearing the longest reach that works. "Works" is three tests: there is a
   * surface top under the spot within `hopRise` above and `hopFall` below, the body fits
   * standing on it, and the arc between here and there is not driven straight through a wall.
   * That last test is the only thing the cheat is not allowed to skip — a spider that can leap
   * through the hall's outer wall is not a predator, it is a bug.
   */
  private launch(s: Spider): void {
    const t = this.tunables;
    const speed = Math.hypot(s.steerX, s.steerZ);
    if (speed < 0.05) {
      // Nowhere to be. Keep freezing, and keep listening — this is the state the rare single
      // click comes from.
      s.hopT = 0;
      s.hopDur = t.restCalm * range(s.rng, 0.7, 1.6);
      s.listen = true;
      return;
    }
    const dirX = s.steerX / speed;
    const dirZ = s.steerZ / speed;
    const base = Math.atan2(dirZ, dirX);
    const full = t.hopDistance * clamp(speed / Math.max(0.1, t.speedStalk), 0.5, 1.7);

    let toX = 0;
    let toZ = 0;
    let toY = 0;
    let found = false;
    for (const off of HOP_FAN) {
      const a = base + (off * Math.PI) / 180;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      for (const reach of HOP_REACH) {
        const d = full * reach;
        const px = clamp(s.pos.x + cx * d, -33, 33);
        const pz = clamp(s.pos.z + cz * d, -23, 23);
        const top = this.topUnder(px, pz, s.pos.y + t.hopRise);
        if (top === -Infinity || top < s.pos.y - t.hopFall) continue;
        if (!this.free(px, top + 0.02, pz)) continue;
        if (!this.arcClear(s.pos.x, s.pos.y, s.pos.z, px, top, pz)) continue;
        toX = px;
        toZ = pz;
        toY = top + 0.02;
        found = true;
        break;
      }
      if (found) break;
    }
    if (!found) {
      // Boxed in. Freeze a beat and try a different heading next time rather than grinding.
      s.hopT = 0;
      s.hopDur = t.restCalm * range(s.rng, 0.4, 0.9);
      s.listen = true;
      s.orbitDir = -s.orbitDir;
      return;
    }

    const dist = Math.hypot(toX - s.pos.x, toZ - s.pos.z);
    const cycle = dist / speed;
    const rest = Math.min(HOT_STATES.has(s.state) ? t.restHot : t.restCalm, cycle * t.restShare);
    s.fromX = s.pos.x;
    s.fromY = s.pos.y;
    s.fromZ = s.pos.z;
    s.toX = toX;
    s.toY = toY;
    s.toZ = toZ;
    // The apex clears the higher end, which is what lets it crest a rack lip from below.
    s.arc = t.hopArc + Math.max(0, toY - s.pos.y) * 0.35;
    s.hopPhase = 'air';
    s.listen = false;
    s.hopT = 0;
    s.hopDur = Math.max(t.hopMinAir, cycle - rest);
    s.brushed = false;
    // The first of the two thumps: the push-off, from where it stood.
    this.thump(s);
  }

  /** Is the parabola between these two points free of solid geometry at its sampled points? */
  private arcClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const arc = this.tunables.hopArc;
    for (const u of ARC_SAMPLES) {
      const x = ax + (bx - ax) * u;
      const z = az + (bz - az) * u;
      const y = ay + (by - ay) * u + arc * 4 * u * (1 - u);
      if (!this.free(x, y, z)) return false;
    }
    return true;
  }

  /**
   * «Задевание мусора нужно только как подсказка игроку, что мимо него что-то пролетело.»
   * So it is a one-shot nudge into the clutter, once per hop, and only close enough to the
   * player to be a cue. It never touches the trajectory.
   */
  private brush(s: Spider): void {
    s.brushed = true;
    const t = this.tunables;
    if (this.props === null) return;
    const dx = s.pos.x - this.player.x;
    const dz = s.pos.z - this.player.z;
    if (dx * dx + dz * dz > t.hopBrushRange * t.hopBrushRange) return;
    this.props.disturb(s.pos.x, s.pos.y - 0.15, s.pos.z, 0.6, t.hopBrushImpulse);
  }

  /** One end of a leap, as a bus event. «По железному стеллажу громче, чем по бетону.» */
  private thump(s: Spider): void {
    const t = this.tunables;
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

  // ---- the voice ----------------------------------------------------------

  /**
   * When they are heard. This is the most important rule in M6b and everything else bends to it.
   *
   * A spider makes a sound in exactly two situations:
   *
   * - **frozen and listening** — one click, rarely, `clickSlow` apart. It only ticks while the
   *   spider is at rest between hops, so a pack crossing the floor cannot produce it;
   * - **committed, next to you** — `clickFast` apart, which is a rash of marks, and by then it
   *   is already inside biting distance.
   *
   * Between those two: silence. That gives the player three readable states of the world with no
   * numbers on screen — silence means they are moving, a lone click means one is stopped and
   * listening (do not move), a solid wash of red means it is too late. Fleeing is silent too: a
   * scattering pack is running, not talking.
   *
   * The two thumps of each leap are emitted by `hop`, not here, and they are quiet enough to be
   * a near-contact cue rather than a tracking channel.
   */
  private voice(s: Spider, dt: number): void {
    const t = this.tunables;
    // A panicking spider wrecks whatever it is standing in whether or not it is within earshot
    // of anything — that is a body thrashing, not a voice, so it sits above the silence rule.
    if (s.state === 'panic') {
      s.smashIn -= dt;
      if (s.smashIn <= 0 && this.props !== null) {
        // «Подстреленный или напуганный паук в панике крушит пропы — и этим освещает ползала.»
        // Nothing is faked: the impulse goes into Rapier and the marks come from the contacts.
        this.props.disturb(s.pos.x, s.pos.y + 0.3, s.pos.z, 1.8, t.smashImpulse);
        s.smashIn = t.smashSeconds * range(s.rng, 0.7, 1.4);
      }
    }
    // Hot, and close enough to what it is charging at for the excitement to be about *this*
    // moment. A rally still crossing the hall is hot and silent; the same spider three metres
    // from where it thinks he is, is a wall of noise.
    const hot =
      HOT_STATES.has(s.state) &&
      Math.hypot(s.pos.x - s.belief.x, s.pos.z - s.belief.z) < t.clickCloseRange;
    const listening = LISTENING_STATES.has(s.state) && s.hopPhase === 'rest' && s.listen;
    if (!hot && !listening) {
      // Moving, or fleeing. Say nothing — and do not bank up the timer while silent, or the
      // first freeze after a long run would fire a click instantly.
      if (s.clickIn < 0.15) s.clickIn = 0.15;
      return;
    }
    const gap = hot ? t.clickFast : t.clickSlow;
    if (s.clickIn > gap * 1.6) s.clickIn = gap * range(s.rng, 0.6, 1.5);
    s.clickIn -= dt;
    if (s.clickIn <= 0) {
      this.click(s);
      s.clickIn = gap * range(s.rng, 0.6, 1.5);
    }
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
    //
    // M4f: "round" now stops at the edge of its own company. «Группы не должны знать всё, что
    // знают другие» — a rumour crossing into another `groupId` is scaled by `crossGroupChatter`
    // (0 by default: never), so two companies on opposite sides of the hall genuinely do not
    // hear about each other. Real events on the bus are untouched by this — only hearsay is
    // partitioned, which is the whole difference between "these are two packs" and "half the pack
    // went deaf".
    if (s.belief.confidence < 0.15) return;
    const reach = t.clickLoudness * t.hearing;
    for (const o of this.spiders) {
      if (o === s || !o.alive) continue;
      let crossGroup = 1;
      if (o.groupId !== s.groupId) {
        if (t.crossGroupChatter <= 0) continue;
        crossGroup = t.crossGroupChatter;
      }
      const d = Math.hypot(o.pos.x - s.pos.x, o.pos.z - s.pos.z);
      if (d > reach) continue;
      const quality = Math.max(0.1, 1 - d / reach) * t.weightChatter * s.belief.confidence * crossGroup;
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
   *
   * M4f: this is also the only place a gunshot personally frightens anybody now. Every alive
   * spider is tested against the same segment; inside `hitRadius` it is the hit above, between
   * that and `nearMissRadius` it is a close flyby and gets `nearMiss` instead — «пугать должно
   * только то, что случилось лично с этим пауком: попадание, и пролёт пули близко». A miss can
   * spook more than one spider in a line; a hit can only ever be the first one.
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
    const t = this.tunables;
    const dx = ex - ox;
    const dy = ey - oy;
    const dz = ez - oz;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 <= 1e-6) return -1;
    const r = t.hitRadius;
    const missR = t.nearMissRadius;
    let best: Spider | null = null;
    let bestT = Infinity;
    for (const s of this.spiders) {
      if (!s.alive) continue;
      const cx = s.pos.x - ox;
      const cy = s.pos.y + t.height * 0.5 - oy;
      const cz = s.pos.z - oz;
      // Closest approach of the segment to the body centre, clamped to the segment.
      let u = (cx * dx + cy * dy + cz * dz) / len2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = cx - dx * u;
      const py = cy - dy * u;
      const pz = cz - dz * u;
      const d2 = px * px + py * py + pz * pz;
      if (d2 <= r * r) {
        if (u < bestT) {
          bestT = u;
          best = s;
        }
        continue;
      }
      if (missR > r && d2 <= missR * missR) {
        this.nearMiss(s, ox + dx * u, oz + dz * u, Math.sqrt(d2));
      }
    }
    if (best === null) return -1;
    this.damage(best, damage);
    return best.id;
  }

  /**
   * «Промах рядом» — a bullet that passed close enough to feel without touching. Uses the same
   * scare/flee machinery as a loud noise (`hear`'s pressure branch), just entered directly with
   * real geometry instead of loudness-over-distance: `dist` is already the perpendicular metres
   * from the shot to this spider, at the closest point on its actual flight. 1 right at the edge
   * of the hit sphere, fading to 0 at `nearMissRadius` — a graze is terrifying, a shot that went
   * a metre wide is merely a bad afternoon.
   */
  private nearMiss(s: Spider, x: number, z: number, dist: number): void {
    const t = this.tunables;
    const span = Math.max(1e-3, t.nearMissRadius - t.hitRadius);
    const scale = clamp01(1 - (dist - t.hitRadius) / span);
    if (scale <= 0) return;
    s.courage = Math.max(0, s.courage - t.scareCost * scale);
    s.scaredUntil = Math.max(s.scaredUntil, this.time + t.scareSeconds * scale);
    s.scareX = x;
    s.scareZ = z;
    this.enter(s, 'flee');
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
    const byGroup: number[] = new Array(Math.max(1, Math.round(this.tunables.groups))).fill(0);
    let courage = 0;
    let alive = 0;
    let mode: SpiderState = 'idle';
    let modeN = -1;
    let airborne = 0;
    for (const s of this.spiders) {
      if (!s.alive) continue;
      alive++;
      if (s.hopPhase === 'air') airborne++;
      by[s.state]++;
      courage += s.courage;
      byGroup[s.groupId] = (byGroup[s.groupId] ?? 0) + 1;
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
    this.stats.byGroup = byGroup;
    this.stats.count = alive;
    this.stats.mode = mode;
    this.stats.meanCourage = alive === 0 ? 0 : courage / alive;
    this.stats.chatter = this.clickWindow.length;
    this.stats.airborne = airborne;
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
      groupId: s.groupId,
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
      phase: s.hopPhase,
      phaseFor: s.hopT,
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
