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

export interface MatchStats {
  seed: number;
  ticks: number;
  duration: number;
  score: [number, number];
  players: PlayerStats[];
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
  silentShare: number;
  avgDistanceToBall: number;
  pingsPerMinute: number;
  heardPerSecond: number;
}

export function summarise(stats: MatchStats): PlayerSummary[] {
  return stats.players.map((p) => ({
    ...p,
    possessionShare: p.ticks ? p.possessionTicks / p.ticks : 0,
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
} {
  if (all.length === 0) return { matches: 0, score: [0, 0], players: [] };
  const n = all.length;
  const score: [number, number] = [0, 0];
  const acc = new Map<EntityId, PlayerSummary>();
  for (const m of all) {
    score[0] += m.score[0] / n;
    score[1] += m.score[1] / n;
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
  return { matches: n, score, players };
}
