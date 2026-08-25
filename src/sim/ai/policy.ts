/**
 * Layer 2 — belief into action.
 *
 * A utility system, not a behaviour tree and not a search. The reason is the brief's hardest
 * requirement, "show me the top three options and their scores": a tree expresses priority, and
 * the questions this game asks ("ping now or stay a ghost for one more second") are not
 * priorities, they are trades between incommensurable things. Only a system that produces a
 * *number per option* can be read, argued with, or tuned.
 *
 * There is no tree search here on purpose. The decision horizon is one or two moves and all the
 * work is in evaluating a position, so the research pass recommended decoupling belief sampling
 * (which we do) from MCTS/PIMC (which we do not).
 *
 * Two behaviours that usually have to be hardcoded fall out of the axes instead:
 *
 *   - **standing still and shutting up** wins whenever a shadow already holds a good receiving
 *     spot and the opponents are close enough to hear him move. Nothing says "sometimes hold";
 *     `uQuiet` and the mirror belief say it.
 *   - **the feint and the lying ping** are ordinary candidates whose deception axis is high
 *     because they move the opponents' picture of me away from where I will actually be. They
 *     are macros (a loud leg then a quiet one), which is how a one-ply chooser buys a two-part
 *     idea — but *whether* to play one is a score, never a rule.
 */
import { clamp, dist2, len2, norm2, sub2 } from '../math';
import type { SimConfigView, Vec2 } from '../types';
import { chargeForSpeed, travelTime } from './ball';
import type { Belief } from './belief';
import {
  advance,
  laneClear,
  leadPoint,
  legalPoint,
  opponentArrival,
  receiveValue,
  shotValue,
  threatAt,
  type Features,
  type Role,
} from './features';

export type ActionKind =
  | 'hold'
  | 'move'
  | 'ping'
  | 'shoot'
  | 'pass'
  | 'feint'
  | 'dive'
  | 'investigate'
  /** Close on the believed carrier and stay on him until the ball comes loose. */
  | 'contest'
  /** Throw the body at where an opponent is going to be. */
  | 'tackle'
  /** Shout for the ball: tell the man with it where I am, and everybody else too. */
  | 'call';

export interface Action {
  kind: ActionKind;
  /** Stable identity for hysteresis and for the overlay. */
  tag: string;
  /** Where to go (move, feint's quiet leg). */
  to?: Vec2;
  /** The loud leg of a feint. */
  via?: Vec2;
  mode?: 'walk' | 'run';
  /** Throw aim point. */
  target?: Vec2;
  charge?: number;
  dir?: Vec2;
  /** Which opponent track an `investigate` is about. */
  track?: number;
}

export interface ScoredAction {
  action: Action;
  score: number;
  axes: Record<string, number>;
  /** Where this action expects to leave the body, for the overlay. */
  endPos: Vec2;
}

export interface PolicyWeights {
  pos: number;
  safe: number;
  quiet: number;
  info: number;
  deceive: number;
  team: number;
  commit: number;
}

const WEIGHTS: Record<Role, PolicyWeights> = {
  // The carrier is already a beacon — the ball hums in his hands — so silence costs him almost
  // nothing and buys him almost nothing. He is here to shoot or to pass.
  // `safe` used to be an afterthought for the carrier, and correctly so: with no steal and no
  // tackle, an opponent standing next to him could do precisely nothing. Now proximity is the
  // way the ball is lost, so "how long have I got" is the carrier's second question after
  // "where is the goal".
  carrier: { pos: 3.0, safe: 1.6, quiet: 0.25, info: 1.1, deceive: 0.35, team: 0.5, commit: 0.7 },
  // The shadow is the whole point of the team game: he is useful precisely because nobody knows
  // where he is, so exposure is his dominant cost and staying put is a real option.
  support: { pos: 2.2, safe: 0.9, quiet: 1.9, info: 0.35, deceive: 0.7, team: 0.9, commit: 0.8 },
  chase: { pos: 3.2, safe: 0.4, quiet: 0.45, info: 0.25, deceive: 0.2, team: 1.1, commit: 0.7 },
  guard: { pos: 2.2, safe: 0.6, quiet: 1.2, info: 1.0, deceive: 0.5, team: 0.9, commit: 0.8 },
  // The keeper has one job and no secrets worth keeping: he is standing in the one place on the
  // pitch everybody already knows about. Position dominates, deception is meaningless, and being
  // heard costs him almost nothing — which is why he is the one body that can afford to ask.
  keeper: { pos: 3.4, safe: 0.3, quiet: 0.3, info: 1.2, deceive: 0.15, team: 0.5, commit: 0.9 },
};

/** How much a role cares about being heard. A carrier hums anyway; a shadow lives on silence. */
// The carrier's 0.12 dated from the ball that hummed forever: he was a beacon whatever he did,
// so noise was free to him. He is not a beacon any more — for the first second he is the quietest
// man on the pitch — so being heard costs him something like what it costs anybody else, and the
// mirror belief goes back to being what decides whether he is already given away.
const EXPOSURE: Record<Role, number> = { carrier: 0.3, support: 1, chase: 0.5, guard: 0.9, keeper: 0.15 };
/** How much a role wants to know where the opponents are. Defenders need it most. */
const INFO_NEED: Record<Role, number> = { carrier: 0.7, support: 0.4, chase: 0.35, guard: 1, keeper: 0.8 };

/*
 * `positionDiscount` (below, and in `config.ai`) is how much a *position* is worth compared to
 * the shot it promises. Without it the axes lie to each other: standing on a good shooting spot
 * scores the same as shooting from it, and since standing makes no noise, a carrier with a clear
 * sight of goal decides that the quietest thing to do is nothing. It held the ball until the
 * passivity whistle in almost every possession of the first tournament run. A position is a
 * promise; a throw is the payment.
 */

/**
 * The handful of scalars worth sweeping, exposed through `config.ai` so a tournament can tune
 * them without a rebuild. Weights are a multiplier on every role's row, which keeps the search
 * space to something a grid search can actually cover (`npm run tune`) — the research pass's
 * recommended answer to "eight weights are impossible to balance by hand".
 */
export interface PolicyKnobs {
  posMul: number;
  safeMul: number;
  quietMul: number;
  infoMul: number;
  deceiveMul: number;
  positionDiscount: number;
  /** Metres past the crease at which a shot is worth nothing. Smaller = the bot closes in more. */
  shotRangeSpan: number;
}

export function policyKnobs(cfg: SimConfigView): PolicyKnobs {
  const ai = cfg.ai as Record<string, unknown>;
  const num = (k: string, d: number): number => {
    const v = ai[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  return {
    posMul: num('posMul', 1),
    safeMul: num('safeMul', 1),
    quietMul: num('quietMul', 1),
    // The grid search (`npm run tune --grid infoMul=1,4,12,40`) found 4–12 flatly better than 1
    // against both the striker and the goalie panels, and 1 produced a bot that pinged roughly
    // once every ten minutes — which makes the game's central mechanic invisible. Six is the
    // middle of the flat region.
    infoMul: num('infoMul', 4),
    deceiveMul: num('deceiveMul', 1),
    positionDiscount: num('positionDiscount', 0.5),
    shotRangeSpan: num('shotRangeSpan', 10),
  };
}

const HORIZON = 0.9;
const COMPASS: Vec2[] = [
  { x: 1, y: 0 },
  { x: 0.7071, y: 0.7071 },
  { x: 0, y: 1 },
  { x: -0.7071, y: 0.7071 },
  { x: -1, y: 0 },
  { x: -0.7071, y: -0.7071 },
  { x: 0, y: -1 },
  { x: 0.7071, y: -0.7071 },
];

export interface PolicyInput {
  features: Features;
  belief: Belief;
  cfg: SimConfigView;
  /** Ping cooldown remaining, seconds. */
  pingCooldown: number;
  /** Shout cooldown remaining, seconds. */
  callCooldown: number;
  /** Tag chosen last time — the hysteresis anchor. */
  lastTag: string | null;
  /** 0..1: how many of the generated candidates the bot is allowed to look at. */
  decisionQuality: number;
  /** false removes the ping from the candidate list entirely — the ping test's control group. */
  allowPing?: boolean;
}

/**
 * Generates candidates in a fixed, meaningful order.
 *
 * The order is the `decisionQuality` knob: cutting the list short removes the exotic options
 * (macros, far-flung repositioning) first and leaves the obvious ones, which is what a worse
 * player looks like — narrower imagination, not deliberately worse execution.
 */
export function generateCandidates(input: PolicyInput): Action[] {
  const { features: f, cfg } = input;
  const out: Action[] = [];
  const R = cfg.player.radius;
  // The keeper plans inside his own crease; everybody else has it clipped away, exactly as the
  // simulation would clip it.
  const access = f.keeper ? f.team : -1;
  const legal = (p: Vec2): Vec2 => legalPoint(f.field, p, R, access);

  out.push({ kind: 'hold', tag: 'hold' });

  const shootSpot = legal({
    x: f.goal.x + norm2(sub2(f.me, f.goal), { x: f.team === 0 ? -1 : 1, y: 0 }).x * (f.field.creaseRadius + 1.4),
    y: f.goal.y + norm2(sub2(f.me, f.goal), { x: f.team === 0 ? -1 : 1, y: 0 }).y * (f.field.creaseRadius + 1.4),
  });

  if (f.role === 'carrier') {
    const shot = shotValue(f, f.me, cfg);
    out.push({ kind: 'shoot', tag: 'shoot', target: shot.target, charge: shot.charge });
    // A pass is offered even when the team-mate has gone quiet. He is a body that has not made a
    // sound, which is exactly what a good receiver looks like — and with a human in that slot it
    // is the normal case, not the exception. The staleness is priced on the position axis rather
    // than used as a gate, because "I cannot hear him" and "he is not there" are different
    // statements and only the first one is true.
    if (f.mate) {
      const lead = { x: f.mate.pos.x, y: f.mate.pos.y };
      const speed = clamp(dist2(f.me, lead) * 1.6, cfg.throwing.minSpeed, cfg.throwing.maxSpeed);
      out.push({ kind: 'pass', tag: 'pass', target: lead, charge: chargeForSpeed(speed, cfg.throwing) });
    }
    // Shooting positions: a short arc just outside the crease, plus straight at the goal.
    for (const k of [-1, 0, 1]) {
      const dir = norm2(sub2(f.me, f.goal), { x: f.team === 0 ? -1 : 1, y: 0 });
      const rot = { x: dir.x - k * 0.55 * dir.y, y: dir.y + k * 0.55 * dir.x };
      const n = norm2(rot, dir);
      const spot = legal({
        x: f.goal.x + n.x * (f.field.creaseRadius + 1.4),
        y: f.goal.y + n.y * (f.field.creaseRadius + 1.4),
      });
      out.push({ kind: 'move', tag: `shootspot${k}`, to: spot, mode: 'run' });
    }
  }

  // Hunting the carrier. He hums across the whole pitch, so getting to him is never the hard
  // part — but standing on him for half a second while he runs, throws and lies about where he
  // is going, is. This is the candidate that turns "I know where you are" into a ball.
  if (f.role !== 'carrier' && f.role !== 'keeper' && cfg.contest.steal.enabled && f.ballPos && input.belief.possession === 'opponent') {
    const lead = f.ball
      ? { x: f.ballPos.x + f.ball.vel.x * 0.35, y: f.ballPos.y + f.ball.vel.y * 0.35 }
      : f.ballPos;
    out.push({ kind: 'contest', tag: 'strip', to: legal(lead), mode: 'run' });
  }

  // The dive tackle: a bet on where a body will be when the dive lands. Only offered when the
  // believed body is roughly a dive away — the reach is `dive.speed × dive.durationSec`.
  // Never to the keeper: a keeper who dives at a body is a keeper lying on the floor while the
  // ball goes into the net behind him. His dive is for the ball and it is a reflex, not a plan.
  if (cfg.contest.tackle.enabled && f.role !== 'keeper') {
    const reach = cfg.dive.speed * cfg.dive.durationSec;
    for (let i = 0; i < f.oppMode.length; i++) {
      const lead = leadPoint(f, i, cfg.dive.durationSec * 0.6);
      const d = dist2(f.me, lead);
      if (d > reach + 1 || d < 0.4) continue;
      out.push({ kind: 'tackle', tag: `tackle${i}`, dir: norm2(sub2(lead, f.me), { x: 1, y: 0 }), to: lead, track: i });
    }
  }

  if (f.role === 'keeper') {
    // The line, walked to rather than sprinted to: a keeper who arrives at a run has told the
    // shooter where he is standing, and the shooter is the one man who benefits from knowing.
    out.push({ kind: 'move', tag: 'keeper-post', to: legal(f.keeperPost), mode: 'walk' });
    out.push({ kind: 'move', tag: 'keeper-post-run', to: legal(f.keeperPost), mode: 'run' });
    // A ball loose in his own area is his. So is a loose ball anywhere, if nobody else is going
    // to get there first: a keeper who never leaves his line is a keeper who watches the ball sit
    // in the middle of an empty pitch. Outside those two cases it is somebody else's problem —
    // chasing is how a keeper ends up not being in goal when the shot comes.
    const loose = input.belief.possession === 'loose';
    const mine = f.ballPos && dist2(f.ballPos, f.ownGoal) < f.field.creaseRadius + 2.5;
    if (f.ballPos && (mine || (loose && f.primary))) {
      out.push({ kind: 'move', tag: 'keeper-collect', to: legal(f.intercept?.point ?? f.ballPos), mode: 'run' });
    }
    if (f.intercept && f.intercept.slack > -0.3 && dist2(f.intercept.point, f.ownGoal) < f.field.creaseRadius + 3) {
      out.push({ kind: 'move', tag: 'keeper-cut', to: legal(f.intercept.point), mode: 'run' });
    }
  }

  if (f.role === 'chase' && f.intercept) {
    out.push({ kind: 'move', tag: 'intercept-run', to: legal(f.intercept.point), mode: 'run' });
    out.push({ kind: 'move', tag: 'intercept-walk', to: legal(f.intercept.point), mode: 'walk' });
  }

  if (f.role === 'guard') {
    out.push({ kind: 'move', tag: 'post', to: legal(f.primary ? f.guardPost : f.coverPost), mode: 'walk' });
    out.push({ kind: 'move', tag: 'post-run', to: legal(f.primary ? f.guardPost : f.coverPost), mode: 'run' });
    if (f.intercept && f.intercept.slack > -0.35) {
      out.push({ kind: 'move', tag: 'intercept-run', to: legal(f.intercept.point), mode: 'run' });
    }
  }

  // Asking for it. A pass can only be thrown at somebody the thrower can place, and a body that
  // has been standing still is by definition unplaceable — so somebody has to speak. The cost is
  // real and symmetric (9 m, exactly where I stand), which is why it is a scored option and not
  // a reflex, and why it wins only when the ball is near, my man has it, and I am open.
  if (f.role === 'support' && input.callCooldown <= 1e-6) {
    out.push({ kind: 'call', tag: 'call' });
  }

  if (f.role === 'support' || f.role === 'guard') {
    // Receiving spots: spread across the attacking half at the crease's shooting radius.
    const sign = f.team === 0 ? 1 : -1;
    for (const y of [-4.5, 0, 4.5]) {
      const spot = legal({ x: sign * (f.field.halfWidth - f.field.creaseRadius - 2.2), y });
      out.push({ kind: 'move', tag: `slot${y}`, to: spot, mode: 'walk' });
    }
  }

  // Going to look. There is no tackle in this game, so walking towards a body achieves nothing
  // except *hearing* it: a walking step carries three metres, so the only way to find a quiet
  // opponent without a ping is to be near him. Running there is loud, and that is the point —
  // the concept's rule is that a bot which has been fooled has to be *audibly* fooled, or the
  // player never learns that the trick worked.
  if (f.role !== 'carrier' && f.role !== 'keeper') {
    for (let i = 0; i < f.oppAge.length; i++) {
      if (f.oppAge[i]! < 0.9) continue;
      const guess = input.belief.opponents[i]?.grid.mode().pos;
      if (!guess) continue;
      out.push({ kind: 'investigate', tag: `check${i}`, to: legal(guess), mode: 'run', track: i });
    }
  }

  for (const d of COMPASS) {
    out.push({ kind: 'move', tag: `w${d.x.toFixed(1)},${d.y.toFixed(1)}`, to: legal({ x: f.me.x + d.x * 2.2, y: f.me.y + d.y * 2.2 }), mode: 'walk' });
  }
  for (const d of COMPASS) {
    out.push({ kind: 'move', tag: `r${d.x.toFixed(1)},${d.y.toFixed(1)}`, to: legal({ x: f.me.x + d.x * 5, y: f.me.y + d.y * 5 }), mode: 'run' });
  }

  if (input.pingCooldown <= 1e-6 && input.allowPing !== false) {
    // Asking a question does not have to mean standing still while you ask it, so the ping
    // candidate carries the destination the role would have moved to anyway.
    // The destination is deliberately the one this role would have chosen anyway, so the two
    // candidates differ only in whether the question gets asked. Otherwise the ping loses on
    // the position axis for reasons that have nothing to do with the price of asking.
    const along =
      f.role === 'carrier'
        ? shootSpot
        : f.role === 'keeper'
          ? legal(f.keeperPost)
          : f.role === 'guard'
          ? legal(f.primary ? f.guardPost : f.coverPost)
          : f.role === 'chase' && f.intercept
            ? legal(f.intercept.point)
            : undefined;
    out.push({
      kind: 'ping',
      tag: 'ping',
      to: along,
      mode: f.role === 'guard' || f.role === 'support' || f.role === 'keeper' ? 'walk' : 'run',
    });
  }

  // Macros. A one-ply chooser cannot invent "be loud here, then be somewhere else"; offering it
  // as a single candidate lets the deception axis decide whether it is worth the noise.
  for (const d of COMPASS) {
    if (d.y === 0 && d.x === 0) continue;
    const via = legal({ x: f.me.x + d.x * 2.6, y: f.me.y + d.y * 2.6 });
    const to = legal({ x: f.me.x - d.x * 3.4, y: f.me.y - d.y * 3.4 });
    out.push({ kind: 'feint', tag: `feint${d.x.toFixed(1)},${d.y.toFixed(1)}`, via, to, mode: 'walk' });
  }

  if (f.ballPos && f.role !== 'carrier' && f.role !== 'keeper') {
    const d = dist2(f.me, f.ballPos);
    if (d < 4 && f.ball && len2(f.ball.vel) > 3) {
      out.push({ kind: 'dive', tag: 'dive', dir: norm2(sub2(f.ballPos, f.me), { x: 1, y: 0 }) });
    }
  }

  const quality = clamp(input.decisionQuality, 0.1, 1);
  const keep = Math.max(3, Math.round(out.length * quality));
  return out.length > keep ? out.slice(0, keep) : out;
}

/** Scores every candidate and returns them sorted, best first. The overlay prints the top three. */
export function choose(input: PolicyInput): ScoredAction[] {
  const candidates = generateCandidates(input);
  const scored: ScoredAction[] = [];
  for (const a of candidates) scored.push(score(a, input));
  scored.sort((x, y) => (y.score === x.score ? x.action.tag.localeCompare(y.action.tag) : y.score - x.score));
  return scored;
}

function score(action: Action, input: PolicyInput): ScoredAction {
  const { features: f, belief, cfg } = input;
  const k = policyKnobs(cfg);
  const base = WEIGHTS[f.role];
  const w: PolicyWeights = {
    pos: base.pos * k.posMul,
    safe: base.safe * k.safeMul,
    quiet: base.quiet * k.quietMul,
    info: base.info * k.infoMul,
    deceive: base.deceive * k.deceiveMul,
    team: base.team,
    commit: base.commit,
  };
  const speed = action.mode === 'run' ? cfg.player.runSpeed : cfg.player.walkSpeed;

  // --- where does this leave me, and what does it shout on the way -------------
  //
  // Two different positions matter and confusing them is the classic myopia bug: the body is
  // *judged* where the action finally puts it (so running eight metres to a shooting spot is
  // worth what the spot is worth, discounted for the time it takes), but it is *heard* along
  // the way. Judging at the 0.9 s mark instead made the carrier prefer a hopeless shot from
  // midfield over the run that would have given it a real one.
  let dest: Vec2 = f.me;
  let noisePos: Vec2 = f.me;
  let noiseRadius = 0;
  let travelT = 0;
  switch (action.kind) {
    case 'hold': {
      // Stopping is not free: a body that drops more than `brakeSpeedDrop` m/s rings out at the
      // brake radius, which is louder than running. Standing still is only silent once you are.
      if (f.mySpeed >= cfg.player.brakeSpeedDrop) noiseRadius = cfg.loudness.brake;
      else if (f.mySpeed > 0.3) noiseRadius = cfg.loudness['step-walk'];
      break;
    }
    case 'move':
    case 'investigate':
    case 'contest':
    case 'ping': {
      if (action.to) {
        dest = action.to;
        travelT = travelTime(dist2(f.me, dest), f.mySpeed, cfg.player.accel, speed);
        const mid = advance(f.me, dest, speed, Math.min(travelT, HORIZON) / 2);
        noisePos = mid;
        noiseRadius = action.mode === 'run' ? cfg.loudness['step-run'] : cfg.loudness['step-walk'];
      }
      if (action.kind === 'ping') {
        noisePos = f.me;
        noiseRadius = cfg.loudness.sonar;
      }
      break;
    }
    case 'shoot':
    case 'pass': {
      noiseRadius = cfg.loudness.throw;
      break;
    }
    case 'call': {
      noiseRadius = cfg.loudness.call;
      break;
    }
    case 'feint': {
      // Loud leg out, quiet leg back past the start — the noise is at the turn, the body is not.
      noisePos = action.via!;
      noiseRadius = cfg.loudness.brake;
      dest = action.to!;
      travelT = 0.45 + travelTime(dist2(action.via!, dest), 0, cfg.player.accel, cfg.player.walkSpeed);
      break;
    }
    case 'dive':
    case 'tackle': {
      const reach = cfg.dive.speed * cfg.dive.durationSec;
      dest = { x: f.me.x + action.dir!.x * reach, y: f.me.y + action.dir!.y * reach };
      noiseRadius = cfg.loudness.dive;
      travelT = cfg.dive.durationSec + cfg.dive.recoverySec;
      break;
    }
  }
  // The ball in my hands is a noise I am making, and it gets worse. Any plan that still has the
  // ball at the end of it is at least as loud as the beep will be by then; a throw and a pass
  // are not, because the ball will not be mine. That asymmetry is the whole reason to pass, and
  // it belongs on the noise axis rather than in a rule.
  if (f.role === 'carrier') {
    const v = cfg.ball.voice;
    const held = f.carrySeconds + Math.min(travelT, HORIZON);
    if (held > v.quietSec && action.kind !== 'shoot' && action.kind !== 'pass') {
      const ramp = clamp((held - v.quietSec) / Math.max(1e-6, v.rampSec), 0, 1);
      const full = cfg.loudness['ball-carry'];
      noiseRadius = Math.max(noiseRadius, full * v.startLoudFrac + (full - full * v.startLoudFrac) * ramp);
      noisePos = dest;
    }
  }
  // Everything a plan promises is worth less the longer it takes to arrive, and a plan that
  // takes four seconds in a game whose belief rots in two is worth almost nothing.
  const arrival = clamp(1 - travelT / 3.5, 0.25, 1);
  const endPos = dest;

  // --- how likely is any opponent to hear it ------------------------------------
  let pHeard = 0;
  if (noiseRadius > 0) {
    let survive = 1;
    for (const t of belief.opponents) survive *= 1 - clamp(t.grid.massInCircle(noisePos, noiseRadius), 0, 0.99);
    pHeard = 1 - survive;
  }

  // --- the axes -----------------------------------------------------------------
  const uPos = positionValue(action, endPos, travelT, arrival, input);
  // Danger means "somebody can be standing on me shortly", and that only costs anything while I
  // still have the ball. Getting rid of it is the answer to being hunted, not another way of
  // being caught — without this exemption a threatened carrier scores holding still exactly as
  // well as throwing, and the whole point of knowing where the hunters are evaporates.
  const releases = action.kind === 'shoot' || action.kind === 'pass';
  const danger = threatAt(f, endPos, cfg);
  // Whose danger, though. For a carrier an opponent arriving is the ball gone, and that is worth
  // being afraid of. For anybody else it is a body walking past: the worst it can do is tackle,
  // which is rare, telegraphed and survivable. Charging both of them the same price is what kept
  // the bot from ever hunting a carrier — the one place on the pitch it most wants to stand is
  // by definition the place with an opponent in it, so `strip` scored 0.15 on safety and never
  // once won a decision.
  const uSafe = releases ? 1 : 1 - (f.role === 'carrier' ? 0.85 : 0.25) * danger;
  // Noise only costs what secrecy is still worth. If the opposition already has a fix on me —
  // because I am the one carrying the humming ball, or because somebody just pinged me — then
  // being loud costs nothing and the bot is free to ask questions. That is the mirror belief
  // paying for itself: this used to be a constant, and the carrier never pinged in its life.
  const exposure = EXPOSURE[f.role] * (1 - 0.85 * clamp(f.mirrorKnown, 0, 1));
  const uQuiet = clamp(1 - pHeard * exposure, 0.03, 1);
  const uInfo = infoValue(action, input, pHeard);
  const uDeceive = deceptionValue(action, endPos, noisePos, pHeard, input);
  const uTeam = teamValue(endPos, input);
  const uCommit = input.lastTag === action.tag ? 1 : 0.87;

  const axes = { pos: uPos, safe: uSafe, quiet: uQuiet, info: uInfo, deceive: uDeceive, team: uTeam, commit: uCommit };
  // Weighted geometric mean, not a product: with seven axes a plain product collapses to noise
  // (Dave Mark's compensation problem), and a plain sum lets one good axis hide a fatal one.
  const total = w.pos + w.safe + w.quiet + w.info + w.deceive + w.team + w.commit;
  let logSum = 0;
  logSum += w.pos * lnApprox(uPos);
  logSum += w.safe * lnApprox(uSafe);
  logSum += w.quiet * lnApprox(uQuiet);
  logSum += w.info * lnApprox(uInfo);
  logSum += w.deceive * lnApprox(uDeceive);
  logSum += w.team * lnApprox(uTeam);
  logSum += w.commit * lnApprox(uCommit);
  const score = expApproxPos(logSum / total);
  return { action, score, axes, endPos };
}

/** ln for values in (0, 1], by Newton refinement of a cheap seed. No `Math.log`. */
function lnApprox(v: number): number {
  const x = clamp(v, 1e-4, 1);
  // ln(x) = 2*atanh((x-1)/(x+1)), expanded — accurate to ~1e-4 over (0.01, 1] after 6 terms.
  const z = (x - 1) / (x + 1);
  const z2 = z * z;
  let sum = 0;
  let term = z;
  for (let k = 1; k <= 15; k += 2) {
    sum += term / k;
    term *= z2;
  }
  return 2 * sum;
}

/** exp for values <= 0. Inverse of `lnApprox`, same no-transcendentals rule. */
function expApproxPos(v: number): number {
  if (v >= 0) return 1;
  if (v < -12) return 0;
  let r = 1 + v / 1024;
  if (r < 0) r = 0;
  for (let i = 0; i < 10; i++) r *= r;
  return r;
}

function positionValue(action: Action, endPos: Vec2, travelT: number, arrival: number, input: PolicyInput): number {
  const { features: f, belief, cfg } = input;
  if (action.kind === 'shoot') {
    return clamp(shotValue(f, f.me, cfg).value, 0.02, 1);
  }
  if (action.kind === 'pass') {
    const to = action.target!;
    const speed = clamp(dist2(f.me, to) * 1.6, cfg.throwing.minSpeed, cfg.throwing.maxSpeed);
    const complete = laneClear(f, f.me, to, speed, cfg);
    // A pass is only worth making if the man it reaches is worth more than I am right now.
    const after = shotValue(f, to, cfg).value;
    const mine = shotValue(f, f.me, cfg).value;
    const gain = after > mine * 0.9 ? 1 : 0.55;
    // Throwing at a place you last heard him four seconds ago is a worse idea than throwing at
    // one you heard him in half a second ago, but it is not a forbidden idea.
    // A shout is the strongest fix there is on a team-mate: he said where he was, by name, on
    // purpose. It is also the only way a human team-mate is ever placed at all.
    const trust = f.mateCalled < 2.5 ? 1.15 : f.mate && f.mate.fresh ? 1 : 0.45;
    // And the half of a pass that has nothing to do with where it lands: it takes the ball out
    // of a pair of hands that has been beeping for four seconds and puts it into a pair that is
    // silent. Getting quiet again is a reason to pass, and it is the reason the человек asked
    // for — "пас… становится способом снова стать невидимым".
    const relief = 0.6 + 0.9 * f.carryNoise;
    return clamp(0.8 * complete * (0.3 + 0.7 * after) * gain * trust * relief, 0.02, 1);
  }
  if (action.kind === 'dive') {
    if (!f.intercept) return 0.05;
    return clamp(1 - dist2(endPos, f.intercept.point) / 3, 0.05, 1);
  }
  if (action.kind === 'contest') {
    // Worth exactly what the chance of arriving in time is worth. The carrier is the one body in
    // the game whose position is not a guess, so this is a race against his legs, not a search.
    const to = action.to ?? endPos;
    const mine = travelTime(dist2(f.me, to), f.mySpeed, cfg.player.accel, cfg.player.runSpeed);
    // Can I get there before he has finished with it, and is he anywhere worth stopping? A
    // carrier walking it up in his own half is not worth chasing across the pitch; one arriving
    // at the crease is worth everything a defender has.
    const reachable = clamp(1 - mine / 3, 0.05, 1);
    const threat = clamp(1 - (dist2(to, f.ownGoal) - f.field.creaseRadius) / 12, 0.15, 1);
    return clamp(reachable * (0.35 + 0.65 * threat), 0.02, 1);
  }
  if (action.kind === 'tackle') {
    const i = action.track ?? 0;
    // The probability the dive connects: how much of the belief about that body actually sits
    // where the dive will end. A vague belief scores badly all by itself, which is the honest
    // way for a bot to decline a bet it cannot price.
    const track = belief.opponents[i];
    if (!track) return 0.02;
    const hit = clamp(track.grid.massInCircle(endPos, cfg.contest.tackle.radius + cfg.player.radius), 0, 1);
    // Flattening a body matters most when it is the one holding the ball, and second-most when
    // it is between me and my goal.
    const isCarrier =
      belief.possession === 'opponent' && f.ballPos ? clamp(1 - dist2(endPos, f.ballPos) / 3, 0, 1) : 0;
    const worth = 0.35 + 0.65 * isCarrier;
    // A miss is 0.4 s of dive plus a full recovery flat on the floor. That cost is not on the
    // safety axis (nobody has to be near me for it to hurt), so it is priced here.
    return clamp(hit * worth + (1 - hit) * 0.03, 0.02, 1);
  }
  if (action.kind === 'call') {
    // Worth exactly what a pass to me would be worth, times how badly the man with the ball
    // needs one — and nothing at all if he has not got it, or if he can already place me.
    if (belief.possession !== 'mate' || !f.ballPos) return 0.02;
    const worth = receiveValue(f, f.me, f.ballPos, cfg);
    const alreadyKnown = f.mate && f.mate.fresh ? 0.45 : 1;
    // A ball that has been in one pair of hands for a while is a ball whose owner is looking for
    // somewhere to put it. That is the moment to speak.
    const v = cfg.ball.voice;
    const hisTrouble = clamp(0.35 + 0.65 * clamp((f.now - belief.possessionT - v.quietSec) / v.rampSec, 0, 1), 0, 1);
    return clamp(worth * alreadyKnown * hisTrouble, 0.02, 1);
  }
  if (action.kind === 'investigate') {
    const i = action.track ?? 0;
    // Worth doing in proportion to how stale the guess is, how vague it is, and how much it
    // would matter to be wrong about that particular body.
    const stale = clamp(f.oppAge[i]! / 2.5, 0, 1);
    const vague = clamp(f.oppArea[i]! / 80, 0, 1);
    const matters =
      f.role === 'guard'
        ? clamp(1 - dist2(endPos, f.ownGoal) / 16, 0.15, 1)
        : clamp(1 - dist2(endPos, f.ballPos ?? f.me) / 14, 0.15, 1);
    return clamp(arrival * (0.15 + 0.85 * stale) * (0.25 + 0.75 * vague) * matters, 0.02, 1);
  }

  switch (f.role) {
    case 'carrier': {
      const shot = shotValue(f, endPos, cfg).value;
      const closer = clamp(1 - (dist2(endPos, f.goal) - f.field.creaseRadius) / 12, 0.05, 1);
      // The clock that matters is no longer the passivity rule, it is the ball itself. Every
      // extra second in one pair of hands makes it beep louder and more often, so a plan that
      // *keeps* the ball is worth less the longer it has already been kept — and the bot works
      // that out from a noise it can hear itself making, not from a rule it was told.
      const v = cfg.ball.voice;
      const ramp = clamp((f.carrySeconds + travelT - v.quietSec) / Math.max(1e-6, v.rampSec), 0, 1);
      const clock = f.carryLimit > 0 ? clamp(1 - (f.carrySeconds + travelT) / f.carryLimit, 0, 1) : 1;
      const urgency = (0.3 + 0.7 * clock) * (1 - 0.7 * ramp);
      return clamp(policyKnobs(cfg).positionDiscount * arrival * (0.2 * closer + 0.8 * shot) * urgency, 0.02, 1);
    }
    case 'chase': {
      if (!f.ballPos) return 0.1;
      const target = f.intercept ? f.intercept.point : f.ballPos;
      const speed = action.mode === 'run' ? cfg.player.runSpeed : cfg.player.walkSpeed;
      // Whether this action wins the race, not whether it points in roughly the right
      // direction: my time to the ball's landing point against the best time the belief gives
      // any opponent. Standing still scores well only when I am already there.
      const mineT = travelTime(
        Math.max(0, dist2(endPos, target) - cfg.catching.radius * 0.6),
        f.mySpeed,
        cfg.player.accel,
        speed,
      ) + travelT;
      const theirs = opponentArrival(f, target, cfg);
      const race = clamp(0.5 + (theirs - mineT) / 1.4, 0.05, 1);
      // Arriving long after the ball has gone past is not an interception, it is a jog.
      const ballT = f.intercept?.t ?? 0;
      const timing = clamp(1 - Math.max(0, mineT - ballT) / 1.2, 0.05, 1);
      return clamp(race * timing, 0.02, 1);
    }
    case 'support': {
      const from = f.ballPos ?? f.me;
      const base = receiveValue(f, endPos, from, cfg);
      // A spot only pays while they cannot cover it, so its value is scaled by how badly the
      // mirror belief knows me. This is where "stay a ghost" becomes a number.
      const known = mirrorAt(belief, endPos);
      return clamp(arrival * base * (0.3 + 0.7 * (1 - known)), 0.02, 1);
    }
    case 'keeper': {
      // Everything is measured against the line from the ball to the middle of my own goal.
      // There is no cleverer quantity available to a blind keeper: he cannot know the corner,
      // so the best he can do is stand where the angle is narrowest and keep his feet.
      const target = f.intercept?.point ?? f.ballPos;
      const loose = belief.possession === 'loose';
      const collectable =
        target !== null &&
        (dist2(target, f.ownGoal) < f.field.creaseRadius + 2.5 || (loose && f.primary));
      // How much the line is worth holding at all. Against a carrier it is everything; with the
      // ball loose and nobody else going for it, standing on it is how a keeper watches the ball
      // sit in the middle of an empty pitch.
      const threat =
        belief.possession === 'opponent' ? 1 : loose ? (f.primary && collectable ? 0.25 : 0.6) : 0.4;
      const hold = clamp(1 - dist2(endPos, f.keeperPost) / 3.5, 0.05, 1) * threat;
      const collect = target && collectable ? clamp(1 - dist2(endPos, target) / 4, 0, 1) : 0;
      return clamp(arrival * Math.max(hold, collect), 0.02, 1);
    }
    case 'guard': {
      const post = f.primary ? f.guardPost : f.coverPost;
      const hold = clamp(1 - dist2(endPos, post) / 7, 0.05, 1);
      const cutBall =
        f.ballPos && f.intercept && f.intercept.slack > -0.4
          ? clamp(1 - dist2(endPos, f.intercept.point) / 6, 0, 1)
          : 0;
      // A defender who cannot tackle has exactly two jobs: be on the line the shot has to cross,
      // and be the nearest body when the passivity whistle hands the ball over.
      const nearCarrier =
        f.ballPos && dist2(f.ballPos, f.me) < 14 ? clamp(1 - dist2(endPos, f.ballPos) / 9, 0, 1) : 0;
      const known = mirrorAt(belief, endPos);
      const core = Math.max(hold, cutBall, nearCarrier * 0.85);
      return clamp(arrival * core * (0.45 + 0.55 * (1 - known)), 0.02, 1);
    }
  }
}

/** How sure the opponents are, collectively, that I am at `q`. 0 = they have no idea. */
function mirrorAt(belief: Belief, q: Vec2): number {
  let known = 0;
  for (const m of belief.mirrors) known = Math.max(known, m.grid.massInCircle(q, 2.5));
  return clamp(known, 0, 1);
}

/**
 * The price of asking.
 *
 * A ping is the loudest thing in the game and it hands over the asker's exact position, so it
 * can never be a reflex. Its information value is the belief mass it would actually resolve
 * times how badly this role needs to know; its cost is already paid through `uQuiet`, which for
 * a ping is the worst score any action can get.
 */
function infoValue(action: Action, input: PolicyInput, pHeard: number): number {
  const { features: f, belief, cfg } = input;
  if (action.kind !== 'ping') return 0.5;
  const fieldArea = f.field.width * f.field.height;
  let coverage = 0;
  let vagueness = 0;
  for (let i = 0; i < belief.opponents.length; i++) {
    coverage += belief.opponents[i]!.grid.massInCircle(f.me, cfg.ping.range);
    vagueness += clamp(f.oppArea[i]! / (fieldArea * 0.35), 0, 1);
  }
  const n = Math.max(1, belief.opponents.length);
  coverage /= n;
  vagueness /= n;
  void pHeard;
  let need = INFO_NEED[f.role];
  // What is the question FOR. A ping is worth what it changes about the next decision, and there
  // are exactly two decisions in this game that a fuzzy belief cannot be made: whether to throw
  // the body at somebody (a tackle is a bet on a position, and a bet you cannot price is a bet
  // you decline), and whether the man about to take the ball off me is close enough to matter.
  // Before the contest rules existed neither of those decisions existed either, which is the
  // real reason the bot used to ping once every ten minutes: it had nothing to ask about.
  const stakes = clamp(1 - f.huntTime / 3, 0, 1);
  need = clamp(Math.max(need, stakes * vagueness * (f.role === 'carrier' ? 1 : 0.8)), 0, 1);
  if (f.role === 'carrier') {
    // A carrier's question is not "where are they" in general, it is "is my shooting lane
    // blocked" — and that question is only worth asking when the answer is genuinely in doubt.
    // 4p(1-p) peaks exactly where the belief is torn, which is where a ping earns its noise.
    const p = shotValue(f, f.me, cfg).value;
    const doubt = 4 * p * (1 - p);
    const aboutToShoot = clamp(1 - (dist2(f.me, f.goal) - f.field.creaseRadius) / 6, 0, 1);
    need = clamp(need * (0.25 + 0.75 * doubt) * (0.3 + 0.7 * aboutToShoot), 0, 1);
  }
  return clamp(0.06 + 0.94 * coverage * vagueness * need, 0.02, 1);
}

/**
 * How far this action would drag the opponents' picture of me away from where I will be.
 *
 * Note that "hold" scores well on this axis whenever they already believe I am somewhere else:
 * doing nothing is a deception when the lie is already told. That is the shape of the mechanic
 * the concept calls "тишина как позиция", arrived at by arithmetic rather than by a rule.
 */
function deceptionValue(action: Action, endPos: Vec2, noisePos: Vec2, pHeard: number, input: PolicyInput): number {
  const { features: f } = input;
  // A throw is not a manoeuvre: judging it on where it leaves the opposition's picture of me
  // would tax every shot in the game for a benefit that belongs to positioning.
  if (action.kind === 'shoot' || action.kind === 'pass' || action.kind === 'dive' || action.kind === 'tackle') {
    return 0.5;
  }
  const believed = pHeard > 0.4 ? noisePos : f.mirrorCentre;
  // Where I will really be a moment after the action has finished making its noise.
  const future = action.kind === 'feint' ? action.to! : endPos;
  const displacement = dist2(believed, future);
  return clamp(0.1 + displacement / 9, 0.02, 1);
}

function teamValue(endPos: Vec2, input: PolicyInput): number {
  const { features: f } = input;
  if (!f.mate || !f.mate.fresh) return 0.7;
  const gap = dist2(endPos, f.mate.pos);
  return clamp(0.25 + 0.75 * clamp(gap / 5, 0, 1), 0.05, 1);
}

/** Direction to face. The carrier aims where he intends to throw; everyone else at the ball. */
export function aimFor(action: Action, f: Features): Vec2 {
  if (action.kind === 'shoot' || action.kind === 'pass') return norm2(sub2(action.target!, f.me), { x: 1, y: 0 });
  if (action.kind === 'tackle') return action.dir!;
  if (action.kind === 'contest' && action.to) return norm2(sub2(action.to, f.me), { x: 1, y: 0 });
  if (f.role === 'carrier') {
    const target = action.kind === 'move' && action.to ? action.to : f.goal;
    return norm2(sub2(target, f.me), { x: 1, y: 0 });
  }
  if (f.ballPos) return norm2(sub2(f.ballPos, f.me), { x: 1, y: 0 });
  return { x: f.team === 0 ? 1 : -1, y: 0 };
}
