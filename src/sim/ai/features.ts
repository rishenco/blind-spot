/**
 * Layer 1.5 — the derived quantities decisions are actually made of.
 *
 * The brief is explicit that the policy must read *features* of the belief, never raw events:
 * a threat map, a pass corridor, an interception time, "how long have I been invisible", "how
 * sure is he about me". This file is where a probability distribution turns into those numbers,
 * and it is the only place that is allowed to know both.
 *
 * Uncertainty is carried through by deterministic stratified samples of each opponent grid
 * rather than by a mean: a belief that says "he is either at the left post or at the right one"
 * must produce danger on both sides, and an average would produce danger in the middle, where
 * nobody is. The samples are re-drawn every decision from the same cumulative-sum rule, so they
 * move smoothly and never flicker.
 */
import { clamp, dist2, len2, norm2, sub2 } from '../math';
import type { EntityId, FieldInfo, SimConfigView, Vec2 } from '../types';
import { pointToSegment, predictBall, solveIntercept, travelTime, type BallEstimate, type InterceptSolution } from './ball';
import type { Belief } from './belief';

export type Role = 'carrier' | 'support' | 'chase' | 'guard' | 'keeper';

export interface Features {
  now: number;
  me: Vec2;
  mySpeed: number;
  team: number;
  role: Role;
  /** True when this bot is the one who should go for a loose ball. */
  primary: boolean;
  goal: Vec2;
  ownGoal: Vec2;
  field: FieldInfo;
  ball: BallEstimate | null;
  ballPos: Vec2 | null;
  intercept: InterceptSolution | null;
  /** Stratified samples of each opponent's belief, in track order. */
  oppSamples: { pos: Vec2; weight: number }[][];
  /** Effective support area of each opponent belief, m² — how blind I am about each of them. */
  oppArea: number[];
  oppAge: number[];
  mate: { pos: Vec2; fresh: boolean } | null;
  /** Highest confidence any opponent has about where I am, 0..1. */
  mirrorKnown: number;
  /** Effective area of the opponents' picture of me, m² — the currency stealth is paid in. */
  mirrorArea: number;
  secondsUnseen: number;
  /** Where the opponents collectively think I am; the anchor of every deception score. */
  mirrorCentre: Vec2;
  /** Seconds this bot has been holding the ball — the passivity clock, felt from the inside. */
  carrySeconds: number;
  /** The passivity limit, or 0 when the rule is off. */
  carryLimit: number;
  /** True when this body wears the gloves: it may stand in its own crease and nothing else may. */
  keeper: boolean;
  /**
   * Where the keeper belongs: on the line from the believed ball to the centre of his own goal.
   *
   * That line is the whole of goalkeeping in a game with no sight. He cannot know which corner
   * the shot is going to — nothing he can hear says so — so the only thing he can do is stand
   * where the angle is smallest and spend his reach on the half he guessed.
   */
  keeperPost: Vec2;
  /** The post a defender should hold, derived from the believed ball and my own goal. */
  guardPost: Vec2;
  /** The post the second defender should hold: between the *unknown* opponent and my goal. */
  coverPost: Vec2;
  /** Peak of each opponent's belief — the single best guess, for aiming a tackle. */
  oppMode: Vec2[];
  /** Each opponent's decaying "he was heading this way" estimate, m/s, and its age. */
  oppDir: Vec2[];
  oppDirAge: number[];
  /**
   * Seconds before the nearest believed opponent could be standing on top of me.
   *
   * The whole point of the contest rules, expressed as one number: a carrier who cannot answer
   * "how long have I got" has no reason to want to know where anybody is.
   */
  huntTime: number;
}

const SAMPLES = 7;

export function deriveFeatures(
  belief: Belief,
  selfPos: Vec2,
  selfSpeed: number,
  hasBall: boolean,
  team: number,
  selfId: EntityId,
  field: FieldInfo,
  cfg: SimConfigView,
  isKeeper = false,
): Features {
  const goal = field.goalCentre[team === 0 ? 1 : 0]!;
  const ownGoal = field.goalCentre[team === 0 ? 0 : 1]!;
  const ball = belief.ball;
  const ballPos = ball ? ball.pos : null;

  const oppSamples: { pos: Vec2; weight: number }[][] = [];
  const oppArea: number[] = [];
  const oppAge: number[] = [];
  for (let i = 0; i < belief.opponents.length; i++) {
    oppSamples.push(belief.opponentSamples(i, SAMPLES));
    oppArea.push(belief.opponents[i]!.grid.effectiveArea());
    oppAge.push(clamp(belief.now - belief.opponents[i]!.lastSeenT, 0, 99));
  }

  const oppMode: Vec2[] = [];
  const oppDir: Vec2[] = [];
  const oppDirAge: number[] = [];
  for (const t of belief.opponents) {
    oppMode.push(t.grid.mode().pos);
    oppDir.push({ x: t.dir.x, y: t.dir.y });
    oppDirAge.push(clamp(belief.now - t.dirT, 0, 99));
  }

  let mirrorKnown = 0;
  let mirrorArea = 0;
  let mcx = 0;
  let mcy = 0;
  for (let i = 0; i < belief.mirrors.length; i++) {
    mirrorKnown = Math.max(mirrorKnown, belief.mirrorMass(i, selfPos, 2.5));
    mirrorArea += belief.mirrors[i]!.grid.effectiveArea();
    const c = belief.mirrors[i]!.grid.centroid();
    mcx += c.x;
    mcy += c.y;
  }
  const nm = Math.max(1, belief.mirrors.length);
  mirrorArea /= nm;
  const mirrorCentre = { x: mcx / nm, y: mcy / nm };

  const intercept =
    ball && belief.possession !== 'self' && belief.possession !== 'mate'
      ? solveIntercept(
          selfPos,
          selfSpeed,
          ball,
          field,
          belief.ballPhysics,
          cfg.player.accel,
          cfg.player.runSpeed,
          cfg.catching.radius * 0.7,
        )
      : null;

  const mate = belief.mate ? { pos: belief.mate.pos, fresh: belief.mate.fresh } : null;

  // Who goes for the ball: a deterministic function of what both of us can see, so two bots
  // running the same code usually agree without saying a word (RoboCup's trick). When the
  // team-mate's position has gone stale they can disagree — and that is honest, not a bug.
  let primary = true;
  if (mate && ballPos) {
    const target = intercept ? intercept.point : ballPos;
    const dMe = dist2(selfPos, target);
    const dMate = dist2(mate.pos, target);
    if (mate.fresh) primary = dMe < dMate - 0.25 || (Math.abs(dMe - dMate) <= 0.25 && selfId < belief.mate!.id);
    else primary = selfId < belief.mate!.id;
  }

  let role: Role;
  if (hasBall) role = 'carrier';
  else if (isKeeper && cfg.keeper.enabled) role = 'keeper';
  else if (belief.possession === 'mate') role = 'support';
  else if (belief.possession === 'opponent') role = 'guard';
  else role = primary ? 'chase' : 'guard';

  // The post a defender holds: on the line from the believed ball to my own goal, just outside
  // the crease. It is where a shot has to pass through, which is the only thing a body with no
  // tackle and no hands on the ball can actually do about a carrier.
  const anchor = ballPos ?? { x: 0, y: 0 };
  const toGoal = norm2(sub2(anchor, ownGoal), { x: team === 0 ? 1 : -1, y: 0 });
  const standoff = field.creaseRadius + cfg.player.radius + 0.6;
  const guardPost = { x: ownGoal.x + toGoal.x * standoff, y: ownGoal.y + toGoal.y * standoff };

  // The second defender covers the opponent nobody can hear — the one whose belief is vaguest.
  let vaguest = 0;
  for (let i = 1; i < oppArea.length; i++) if (oppArea[i]! > oppArea[vaguest]!) vaguest = i;
  const ghost = belief.opponents[vaguest]?.grid.centroid() ?? anchor;
  const coverPost = {
    x: ownGoal.x + (ghost.x - ownGoal.x) * 0.55,
    y: ownGoal.y + (ghost.y - ownGoal.y) * 0.55,
  };

  // The keeper's line. When his own side has the ball he steps up to the edge of his crease —
  // he is the outlet, and a keeper glued to his line in attack is a man his team-mate cannot use
  // — and he drops back onto the goal the moment the ball belongs to anybody else.
  const attacking = belief.possession === 'self' || belief.possession === 'mate';
  const depth = attacking ? cfg.keeper.attackDepth : cfg.keeper.depth;
  const line = norm2(sub2(anchor, ownGoal), { x: team === 0 ? 1 : -1, y: 0 });
  const keeperPost = { x: ownGoal.x + line.x * depth, y: ownGoal.y + line.y * depth };

  const f: Features = {
    now: belief.now,
    me: selfPos,
    mySpeed: selfSpeed,
    team,
    role,
    primary,
    goal,
    ownGoal,
    field,
    ball,
    ballPos,
    intercept,
    oppSamples,
    oppArea,
    oppAge,
    mate,
    mirrorKnown,
    mirrorArea,
    secondsUnseen: belief.secondsUnseen(),
    mirrorCentre,
    carrySeconds: hasBall ? clamp(belief.now - belief.possessionT, 0, 99) : 0,
    carryLimit: cfg.match.carryTimeoutSec,
    keeper: isKeeper && cfg.keeper.enabled,
    keeperPost,
    guardPost,
    coverPost,
    oppMode,
    oppDir,
    oppDirAge,
    huntTime: 99,
  };
  f.huntTime = opponentArrival(f, selfPos, cfg);
  return f;
}

/**
 * Where a believed body will be `t` seconds from now, if it keeps doing what it was last heard
 * doing. The aiming point of a dive tackle: the mechanic is a bet on prediction, so this is the
 * only place in the bot where a belief is extrapolated forward rather than merely diffused.
 */
export function leadPoint(f: Features, i: number, t: number): Vec2 {
  const at = f.oppMode[i] ?? f.me;
  const dir = f.oppDir[i];
  if (!dir) return { x: at.x, y: at.y };
  // A heading estimate rots fast: a body heard running two seconds ago has had ample time to
  // turn, so past a second the lead collapses back onto the last known position.
  const trust = clamp(1 - (f.oppDirAge[i] ?? 99) / 1.2, 0, 1);
  return { x: at.x + dir.x * t * trust, y: at.y + dir.y * t * trust };
}

/**
 * How soon an opponent could be at `q`, taken pessimistically.
 *
 * `caution` picks the quantile over the belief's samples: 0 is "assume the worst sample is
 * true", 1 is "assume the best". Anything in between is the one honest dial for how nervous the
 * bot is, and it replaces the usual pile of hand-written "if enemy near" thresholds.
 */
export function opponentArrival(f: Features, q: Vec2, cfg: SimConfigView, caution = 0.2): number {
  let soonest = 99;
  for (const samples of f.oppSamples) {
    if (samples.length === 0) continue;
    const times: number[] = [];
    for (const s of samples) {
      times.push(travelTime(dist2(s.pos, q), 0, cfg.player.accel, cfg.player.runSpeed));
    }
    times.sort((a, b) => a - b);
    const idx = clamp(Math.floor(caution * (times.length - 1)), 0, times.length - 1);
    soonest = Math.min(soonest, times[idx]!);
  }
  return soonest;
}

/** 0..1 danger at `q`: 1 when an opponent is on top of it, 0 when nobody can be there soon. */
export function threatAt(f: Features, q: Vec2, cfg: SimConfigView, horizon = 2.2): number {
  const t = opponentArrival(f, q, cfg);
  return clamp(1 - t / horizon, 0, 1);
}

/**
 * Probability that a throw along a-b survives: nobody the belief puts near the line has time to
 * get onto it before the ball passes. This is the pass corridor, and it is the only reason the
 * shadow's position is worth anything.
 */
export function laneClear(f: Features, a: Vec2, b: Vec2, ballSpeed: number, cfg: SimConfigView): number {
  const length = dist2(a, b);
  if (length < 1e-3) return 1;
  let survive = 1;
  for (const samples of f.oppSamples) {
    let blocked = 0;
    for (const s of samples) {
      const { dist, u } = pointToSegment(s.pos, a, b);
      const tBall = (length * u) / Math.max(1e-3, ballSpeed);
      const tThem = travelTime(Math.max(0, dist - cfg.catching.radius), 0, cfg.player.accel, cfg.player.runSpeed);
      // Being in the way is not enough: he has to be there before the ball is.
      if (tThem <= tBall + 0.12) blocked += s.weight;
    }
    survive *= 1 - clamp(blocked, 0, 0.97);
  }
  return survive;
}

/** How good a shot from `q` would be, if it were taken right now. */
export function shotValue(f: Features, q: Vec2, cfg: SimConfigView): { value: number; target: Vec2; charge: number } {
  const half = f.field.goalWidth / 2 - 0.3;
  const targets: Vec2[] = [
    { x: f.goal.x, y: half },
    { x: f.goal.x, y: 0 },
    { x: f.goal.x, y: -half },
  ];
  const d = dist2(q, f.goal);
  const legal = d > f.field.creaseRadius + cfg.player.radius * 0.5;
  // Distance term. Steeper than it looks like it should be, and deliberately: a throw is
  // perfectly accurate in this simulation, so the only thing distance really buys the defence is
  // *time* to be on the line — but that is exactly the thing the shooter cannot see. A gentle
  // curve made the bot fire from twelve metres into two defenders it could not hear, eleven
  // times a match, and score once.
  const span = typeof cfg.ai.shotRangeSpan === 'number' ? cfg.ai.shotRangeSpan : 10;
  const range = clamp(1 - (d - f.field.creaseRadius) / span, 0.05, 1);
  let best = { value: 0, target: targets[1]!, charge: cfg.throwing.maxCharge };
  if (!legal) return best;
  for (const t of targets) {
    const clear = laneClear(f, q, t, cfg.throwing.maxSpeed, cfg);
    const value = range * clear;
    if (value > best.value) best = { value, target: t, charge: cfg.throwing.maxCharge };
  }
  return best;
}

/** Value of standing at `q` as a receiver: open, reachable by a pass, and dangerous once there. */
export function receiveValue(f: Features, q: Vec2, from: Vec2, cfg: SimConfigView): number {
  const open = clamp(opponentArrival(f, q, cfg) / 2.5, 0, 1);
  const lane = laneClear(f, from, q, cfg.throwing.minSpeed, cfg);
  const shot = shotValue(f, q, cfg).value;
  const spacing = clamp(dist2(q, from) / 6, 0, 1);
  return clamp(0.15 + 0.85 * open * lane * (0.35 + 0.65 * shot) * (0.4 + 0.6 * spacing), 0, 1);
}

/** Where the ball will be in `t` seconds, according to belief. */
export function ballAt(f: Features, belief: Belief, t: number): Vec2 | null {
  if (!f.ball) return null;
  return predictBall(f.ball, f.field, belief.ballPhysics, t);
}

/** Straight-line distance travelled from `from` toward `to` in `t` seconds at `speed`. */
export function advance(from: Vec2, to: Vec2, speed: number, t: number): Vec2 {
  const d = sub2(to, from);
  const l = len2(d);
  if (l < 1e-6) return { x: from.x, y: from.y };
  const travel = Math.min(l, speed * t);
  return { x: from.x + (d.x / l) * travel, y: from.y + (d.y / l) * travel };
}

/**
 * Keeps a candidate point on the pitch and out of both creases — except the one crease this body
 * is allowed inside. `creaseAccess` mirrors the simulation's own rule and has to: a keeper whose
 * candidate points are all pushed out of his crease can never plan to stand in it.
 */
export function legalPoint(field: FieldInfo, p: Vec2, bodyRadius: number, creaseAccess = -1): Vec2 {
  const maxX = field.halfWidth - bodyRadius - 0.1;
  const maxY = field.halfHeight - bodyRadius - 0.1;
  let x = clamp(p.x, -maxX, maxX);
  let y = clamp(p.y, -maxY, maxY);
  for (let gi = 0; gi < field.goalCentre.length; gi++) {
    if (gi === creaseAccess) continue;
    const g = field.goalCentre[gi]!;
    const dx = x - g.x;
    const dy = y - g.y;
    const r = field.creaseRadius + bodyRadius + 0.2;
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r) {
      const d = Math.sqrt(Math.max(1e-6, d2));
      x = g.x + (dx / d) * r;
      y = g.y + (dy / d) * r;
    }
  }
  return { x, y };
}
