/**
 * Match statistics — the future measuring stick for bot strength.
 *
 * The columns are chosen from the AI brief's success criteria: goals and possession say who is
 * winning, interceptions and fumbles say who reads the ball, and ping rate plus silent time say
 * whether a strategy understands the *information* game at all. A bot that scores by never
 * shutting up is not the bot we want, and these two columns are how that shows up as a number.
 */
import type { EntityId, TeamId } from './types';

export interface PlayerStats {
  id: EntityId;
  team: TeamId;
  controller: string;
  goals: number;
  possessionTicks: number;
  catches: number;
  /** Catches of a ball thrown by the other team. */
  interceptions: number;
  /** Catches of a teammate's throw. */
  passesReceived: number;
  throws: number;
  fumbles: number;
  pings: number;
  /** The fight for the ball, from this body's point of view. */
  steals: number;
  robbed: number;
  tackles: number;
  tackleMisses: number;
  tackled: number;
  collisions: number;
  /** Balls that went straight past this body because it had not timed them. */
  ballsThrough: number;
  /** Ticks in which this body made no sound at all (and carried no ball). */
  silentTicks: number;
  /**
   * Discrete sounds this player actually received. The headline number for whether the pitch
   * and the loudness table are in proportion: if everyone hears everything all the time,
   * distance has stopped being a dimension of the game.
   */
  heardEvents: number;
  distanceToBallSum: number;
  distanceRun: number;
  ticks: number;
}

/**
 * The shape of the play, as opposed to who won it.
 *
 * These are the degeneracy metrics: "два бота научились кто первый добежит до мяча и кидает
 * сразу в ворота" is not visible in a scoreline, in possession or in a turnover count — every
 * one of those looks healthy while the match is one dominant line repeated forty times. What it
 * IS visible in is how long the ball stays in a pair of hands before it is thrown, how often it
 * ever changes hands inside one attack, and from how far the shot is taken.
 */
export interface ShapeStats {
  /** Attacks: a team gaining the ball and keeping it until the other team gets it. */
  possessions: number;
  /** Completed passes between team-mates. */
  passes: number;
  /** Throws that were aimed into the opponent's goal mouth — a shot, not a pass. */
  shots: number;
  shotDistanceSum: number;
  /** Every shot's distance to goal, for the histogram. One match makes a few dozen entries. */
  shotDistances: number[];
  /** Seconds between a body getting the ball and releasing a shot with it, summed over shots. */
  holdBeforeShotSum: number;
  /** Same, over every throw (a pass included). */
  holdBeforeThrowSum: number;
  throws: number;
  goals: number;
  /** Goals scored in a possession in which the ball never changed hands inside the team. */
  goalsWithoutPass: number;
  possessionTimeSum: number;
  /** Saves: a shot stopped by a keeper inside his own crease. */
  keeperSaves: number;
  /** The longest anybody held the ball, seconds — the check that carrying has a real price. */
  holdMax: number;
}

export function emptyShapeStats(): ShapeStats {
  return {
    possessions: 0,
    passes: 0,
    shots: 0,
    shotDistanceSum: 0,
    shotDistances: [],
    holdBeforeShotSum: 0,
    holdBeforeThrowSum: 0,
    throws: 0,
    goals: 0,
    goalsWithoutPass: 0,
    possessionTimeSum: 0,
    keeperSaves: 0,
    holdMax: 0,
  };
}

export interface MatchStats {
  seed: number;
  ticks: number;
  duration: number;
  score: [number, number];
  players: PlayerStats[];
  /**
   * How many times the ball changed teams. The one playability number that says whether a rule
   * set produced a game rather than a procession: a match nobody can take the ball in and a
   * match that is nothing but turnovers are both failures, and they look identical on the
   * scoreline.
   */
  possessionChanges: number;
  /** What kind of game this was, not who won it. */
  shape: ShapeStats;
}

export function emptyPlayerStats(id: EntityId, team: TeamId, controller: string): PlayerStats {
  return {
    id,
    team,
    controller,
    goals: 0,
    possessionTicks: 0,
    catches: 0,
    interceptions: 0,
    passesReceived: 0,
    throws: 0,
    fumbles: 0,
    pings: 0,
    steals: 0,
    robbed: 0,
    tackles: 0,
    tackleMisses: 0,
    tackled: 0,
    collisions: 0,
    ballsThrough: 0,
    silentTicks: 0,
    heardEvents: 0,
    distanceToBallSum: 0,
    distanceRun: 0,
    ticks: 0,
  };
}

/** Per-player derived numbers, in the units a human reads. */
export interface PlayerSummary extends PlayerStats {
  possessionShare: number;
  stealsPerMinute: number;
  silentShare: number;
  avgDistanceToBall: number;
  pingsPerMinute: number;
  heardPerSecond: number;
}

export function summarise(stats: MatchStats): PlayerSummary[] {
  return stats.players.map((p) => ({
    ...p,
    possessionShare: p.ticks ? p.possessionTicks / p.ticks : 0,
    stealsPerMinute: stats.duration > 0 ? (p.steals * 60) / stats.duration : 0,
    silentShare: p.ticks ? p.silentTicks / p.ticks : 0,
    avgDistanceToBall: p.ticks ? p.distanceToBallSum / p.ticks : 0,
    pingsPerMinute: stats.duration > 0 ? (p.pings * 60) / stats.duration : 0,
    heardPerSecond: stats.duration > 0 ? p.heardEvents / stats.duration : 0,
  }));
}

/** Averages a set of matches into one row per player slot. */
export function aggregate(all: MatchStats[]): {
  matches: number;
  score: [number, number];
  players: PlayerSummary[];
  possessionChanges: number;
  duration: number;
  /** Summed, not averaged: the shape metrics are ratios of each other and must divide as totals. */
  shape: ShapeStats;
} {
  if (all.length === 0) {
    return { matches: 0, score: [0, 0], players: [], possessionChanges: 0, duration: 0, shape: emptyShapeStats() };
  }
  const n = all.length;
  const score: [number, number] = [0, 0];
  let possessionChanges = 0;
  let duration = 0;
  const acc = new Map<EntityId, PlayerSummary>();
  const shape = emptyShapeStats();
  for (const m of all) {
    for (const key of Object.keys(shape) as (keyof ShapeStats)[]) {
      if (key === 'shotDistances') continue;
      if (key === 'holdMax') {
        shape.holdMax = Math.max(shape.holdMax, m.shape.holdMax);
        continue;
      }
      (shape[key] as number) += m.shape[key] as number;
    }
    shape.shotDistances.push(...m.shape.shotDistances);
    score[0] += m.score[0] / n;
    score[1] += m.score[1] / n;
    possessionChanges += m.possessionChanges / n;
    duration += m.duration / n;
    for (const p of summarise(m)) {
      const cur = acc.get(p.id);
      if (!cur) {
        acc.set(p.id, { ...p });
        continue;
      }
      for (const key of Object.keys(p) as (keyof PlayerSummary)[]) {
        if (key === 'id' || key === 'team') continue; // identities are not quantities
        const v = p[key];
        if (typeof v === 'number') (cur[key] as number) += v;
      }
    }
  }
  const players = [...acc.values()]
    .map((p) => {
      const out = { ...p };
      for (const key of Object.keys(out) as (keyof PlayerSummary)[]) {
        const v = out[key];
        if (typeof v === 'number' && key !== 'id' && key !== 'team') (out[key] as number) = v / n;
      }
      return out;
    })
    .sort((a, b) => a.id - b.id);
  return { matches: n, score, players, possessionChanges, duration, shape };
}
