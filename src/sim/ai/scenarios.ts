/**
 * The deceivability suite — the deliverable the AI brief cares about most.
 *
 * Each entry is a fixed seed, a scripted "human" playing one specific trick from the concept
 * (the running feint, the lying ping, silence, the quiet walk away), and one bot listening. Each
 * one reports numbers taken out of the bot's own belief, so "the bot fell for it" stops being an
 * anecdote and becomes a measurement that a later change can break.
 *
 * The numbers are deliberately about *belief*, not about goals. A bot that is fooled and still
 * wins is fine; a bot that cannot be fooled has deleted the game.
 *
 * Run them with `npm run deception`. The same list feeds the playground's dropdown and the
 * keyframe generator, so every number here also has a picture.
 */
import { configFromPreset, type SimConfig } from '../config';
import { makeController, scripted } from '../controllers';
import { dist2 } from '../math';
import type { ControllerFactory } from '../match';
import { Match } from '../match';
import type { EntityId, Vec2 } from '../types';
import { Bot } from './bot';

export interface AiScenario {
  name: string;
  /** One line, printed under the keyframe. */
  note: string;
  /** What the numbers should show if the bot is behaving. */
  expect: string;
  seed: number;
  ticks: number;
  /** Whose belief the playground draws. Always a bot. */
  eyes: EntityId;
  build(): { config: SimConfig; controllers: { name: string; make: ControllerFactory }[] };
  /** Reads numbers out of the finished match. Only ever from a bot's own belief. */
  measure(m: Match, log: SampleLog): Record<string, number | string>;
}

/** Per-tick record of one bot's belief against the truth, for the measurements below. */
export interface SampleLog {
  t: number[];
  /** Distance from the bot's belief peak for the tracked opponent to where he really is. */
  error: number[];
  /** Signed error along the trick's axis: positive means fooled in the direction of the lie. */
  along: number[];
  /** Belief mass within 2 m of the truth: does the bot still consider the right answer at all. */
  truthMass: number[];
  /** Effective area of the belief, m². */
  area: number[];
  /** What the bot chose, and how loudly it moved. */
  action: string[];
  loudness: number[];
  /** Mirror: how sure the bot thinks the opposition is about where it is. */
  mirrorKnown: number[];
  /** Where the tracked body really was, tick by tick — the harness's copy, never the bot's. */
  truth: { x: number; y: number }[];
  /**
   * A frozen way to ask "how much belief was on this spot at that moment". The grid itself is
   * live and keeps changing, so a measurement taken at the end of the run would describe the end
   * of the run — which is how the first version of the feint measurement concluded that the bot
   * had not been fooled, when in fact it had been fooled and then had found him again.
   */
  snapshots: { massAt(p: { x: number; y: number }): number }[];
}

function emptyLog(): SampleLog {
  return { t: [], error: [], along: [], truthMass: [], area: [], action: [], loudness: [], mirrorKnown: [], truth: [], snapshots: [] };
}

/**
 * Runs one scenario and records, every tick, what the bot believes against what is true.
 *
 * The truth is read here, in the harness, and never handed to the bot — this function is the
 * measuring instrument, not part of the bot. It is the only place in the AI directory that
 * touches `Match.sim`, and it exists so that the report can contain numbers instead of claims.
 */
export function runScenario(
  s: AiScenario,
  opts: { tracked: EntityId; axis: Vec2; observer?: EntityId },
): { match: Match; log: SampleLog } {
  const { config, controllers } = s.build();
  const match = new Match({ config, seed: s.seed, controllers, keepLog: true });
  const observer = opts.observer ?? s.eyes;
  const log = emptyLog();
  for (let i = 0; i < s.ticks && !match.isOver; i++) {
    match.step();
    const bot = match.controllers[observer];
    if (!(bot instanceof Bot)) continue;
    const belief = bot.beliefState;
    const track = belief.opponents.find((t) => t.id === opts.tracked);
    if (!track) continue;
    const truth = match.sim.state.players[opts.tracked]!.pos;
    const peak = track.grid.mode().pos;
    log.t.push(match.sim.state.t);
    log.error.push(dist2(peak, truth));
    log.along.push((peak.x - truth.x) * opts.axis.x + (peak.y - truth.y) * opts.axis.y);
    log.truthMass.push(track.grid.massInCircle(truth, 2));
    log.area.push(track.grid.effectiveArea());
    const debug = bot.debugSnapshot();
    log.action.push(debug?.scores?.[0]?.action ?? '—');
    log.loudness.push(match.sim.state.players[observer]!.loudness);
    log.mirrorKnown.push(bot.featureState?.mirrorKnown ?? 0);
    log.truth.push({ x: truth.x, y: truth.y });
    const frozen = Float32Array.from(track.grid.p);
    const grid = track.grid;
    log.snapshots.push({
      massAt(p) {
        const { nx, ny, cell } = grid.spec;
        let sum = 0;
        for (let iy = 0; iy < ny; iy++) {
          const dy = grid.cellY(iy) - p.y;
          if (Math.abs(dy) > 3) continue;
          for (let ix = 0; ix < nx; ix++) {
            const dx = grid.cellX(ix) - p.x;
            if (dx * dx + dy * dy <= 9) sum += frozen[iy * nx + ix]!;
          }
        }
        void cell;
        return sum;
      },
    });
  }
  return { match, log };
}

const at = (log: SampleLog, t: number): number => {
  let best = 0;
  for (let i = 0; i < log.t.length; i++) if (Math.abs(log.t[i]! - t) < Math.abs(log.t[best]! - t)) best = i;
  return best;
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * The panel: a statue holding the ball, the listening bot beside it, the scripted trickster
 * opposite, and a statue behind him.
 *
 * The ball has to be parked in a *statue's* hands and nowhere else. It hums across the whole
 * pitch by design, and the bot folds that hum into whichever opponent it believes is carrying —
 * correctly, because a carrier is never a secret. The first version of this suite handed the
 * ball to the trickster, so every trick was measured against a body the rules say is visible,
 * and every scenario reported a belief error under two metres. That was the measurement being
 * wrong, not the bot being clever.
 */
function panel(script: { name: string; make: ControllerFactory }, size: number): { name: string; make: ControllerFactory }[] {
  const out: { name: string; make: ControllerFactory }[] = [makeController('statue')];
  for (let i = 1; i < size; i++) out.push(makeController('bot'));
  out.push(script);
  for (let i = 1; i < size; i++) out.push(makeController('statue'));
  return out;
}

function quietConfig(): SimConfig {
  const c = configFromPreset('default');
  // Nothing must interrupt the experiment: the statue holding the ball keeps it for the whole
  // run, so the only sounds on the pitch are the ones the script makes.
  c.match.carryTimeoutSec = 0;
  c.match.kickoffTeam = 'fixed';
  return c;
}

export const AI_SCENARIOS: AiScenario[] = [
  {
    name: 'ai-feint',
    note: 'the running feint: P0 sprints right, brakes hard, then walks quietly the other way — P2 is a bot, listening',
    expect: 'belief error jumps after the brake and stays on the wrong side of the pitch; the bot commits to the lie',
    seed: 8,
    ticks: 380,
    eyes: 1,
    build: () => {
      const config = quietConfig();
      // He has to close first. Kickoff puts the two of them fifteen metres apart, and a running
      // step carries nine — a feint nobody can hear is not a feint, it is a walk.
      const feint = scripted(
        [
          { for: 1.5, run: [-1, 0.85], aim: [-1, 0], label: 'closing in' },
          { for: 0.9, run: [1, 0], label: 'break right' },
          { for: 0.4, stand: true, label: 'the loud stop' },
          { for: 3.0, walk: [-1, 0], label: 'away, quietly' },
        ],
        'feint',
      );
      return { config, controllers: panel({ name: 'feint', make: feint }, config.teamSize) };
    },
    measure: (m, log) => {
      const hook = at(log, 2.9);
      // 4.6 s: the man has walked five metres from the braking sound and is still outside the
      // three-metre walking radius. A second later he crosses it and the bot re-finds him for
      // free, which is the honest end of every feint in this game.
      const late = at(log, 4.6);
      // The honest question is not "where is the peak" — a broad belief puts its peak anywhere.
      // It is: does the bot put more probability on the lie than on the truth? The lie is where
      // the braking sound came from; the truth is where the man walked to afterwards.
      const lie = log.truth[hook]!;
      const now = log.truth[late]!;
      // Measured on the belief the bot held at 4.6 s, not at the end: by the end the man has
      // walked into earshot and been found, which is the trick expiring rather than failing.
      const snap = log.snapshots[late]!;
      const massLie = snap.massAt(lie);
      const massTruth = snap.massAt(now);
      return {
        'err@2.9s': +log.error[hook]!.toFixed(2),
        'err@4.6s': +log.error[late]!.toFixed(2),
        'massOnTheLie': +massLie.toFixed(3),
        'massOnTheTruth': +massTruth.toFixed(3),
        'lieOverTruth': +(massLie / Math.max(1e-6, massTruth)).toFixed(2),
        'gapLieToTruth': +Math.hypot(lie.x - now.x, lie.y - now.y).toFixed(2),
        'loud%': +(log.loudness.filter((l) => l > 5).length / Math.max(1, log.loudness.length)).toFixed(2),
        goals: `${m.stats.score[0]}:${m.stats.score[1]}`,
      };
    },
  },
  {
    name: 'ai-false-ping',
    note: 'the lying ping: P0 pings from the left, then walks away in silence. The ping is exact — and instantly out of date',
    expect: 'belief snaps onto the ping (error ≈ 0), then rots in place while P0 walks off: error grows, truth stays possible',
    seed: 12,
    ticks: 300,
    eyes: 1,
    build: () => {
      const config = quietConfig();
      const liar = scripted(
        [
          { for: 0.5, stand: true, aim: [1, 0], label: 'still' },
          { ping: true, label: 'the lie' },
          { for: 4.0, walk: [0, 1], label: 'away, quietly' },
        ],
        'liar',
      );
      return { config, controllers: panel({ name: 'liar', make: liar }, config.teamSize) };
    },
    measure: (_m, log) => {
      const shot = at(log, 0.8);
      const late = at(log, 4.4);
      return {
        'err@0.8s': +log.error[shot]!.toFixed(2),
        'err@4.4s': +log.error[late]!.toFixed(2),
        'area@0.8s': +log.area[shot]!.toFixed(1),
        'area@4.4s': +log.area[late]!.toFixed(1),
        'truthMass@4.4s': +log.truthMass[late]!.toFixed(3),
      };
    },
  },
  {
    name: 'ai-silence',
    note: 'silence as a position: P0 stands perfectly still in a corner for six seconds while the bot listens and pings',
    expect: 'the belief spreads but never deletes the corner — a ping that finds nothing must not make the truth impossible',
    seed: 21,
    ticks: 420,
    eyes: 1,
    build: () => {
      const config = quietConfig();
      const ghost = scripted(
        [
          { for: 1.0, walk: [-1, -1], label: 'into the corner' },
          { for: 20, stand: true, label: 'silent' },
        ],
        'ghost',
      );
      return { config, controllers: panel({ name: 'ghost', make: ghost }, config.teamSize) };
    },
    measure: (_m, log) => ({
      'minTruthMass': +Math.min(...log.truthMass.slice(60)).toFixed(4),
      'truthMass@end': +log.truthMass[log.truthMass.length - 1]!.toFixed(3),
      'area@end': +log.area[log.area.length - 1]!.toFixed(1),
      'meanErr': +mean(log.error.slice(60)).toFixed(2),
    }),
  },
  {
    name: 'ai-doughnut',
    note: 'the shape of silence: P0 is heard once at 8 m, then goes quiet. Near the listener a runner would have been heard, so the belief can only grow outwards',
    expect: 'the belief is a ring, not a disc: it stays thin close to the bot and spreads fast beyond the running-step radius',
    seed: 33,
    ticks: 360,
    eyes: 1,
    build: () => {
      const config = quietConfig();
      // He has to be inside the running-step radius for the fix to happen at all — the whole
      // point of the picture is a belief that starts as a point and grows into a ring.
      const walker = scripted(
        [
          { for: 1.7, run: [-1, 0.8], aim: [-1, 0], label: 'heard running' },
          { for: 20, stand: true, label: 'silence' },
        ],
        'walker',
      );
      return { config, controllers: panel({ name: 'walker', make: walker }, config.teamSize) };
    },
    measure: (m, log) => {
      const bot = m.controllers[1] as Bot;
      const track = bot.beliefState.opponents.find((t) => t.id === 2)!;
      const me = m.sim.state.players[1]!.pos;
      const truth = m.sim.state.players[2]!.pos;
      // The doughnut, as a number: the belief's mean distance from the listener against the
      // real distance to the man. Silence pushes the cloud outwards, so the belief must sit
      // *further away* than the truth does. An isotropic disc would leave the two equal.
      const beliefDist = track.grid.meanDistanceFrom(me);
      const truthDist = dist2(me, truth);
      const walkR = m.config.loudness['step-walk'];
      const runR = m.config.loudness['step-run'];
      return {
        'truthDist': +truthDist.toFixed(2),
        'beliefMeanDist': +beliefDist.toFixed(2),
        'pushedOutBy': +(beliefDist - truthDist).toFixed(2),
        // The hole in the middle of the doughnut. Nobody can creep up on a listener: inside the
        // walking radius even a walk would have been heard, so belief there is all but deleted.
        [`massWithin${walkR}m`]: +track.grid.massInCircle(me, walkR).toFixed(4),
        [`massWithin${runR}m`]: +track.grid.massInCircle(me, runR).toFixed(3),
        'area@end': +log.area[log.area.length - 1]!.toFixed(1),
      };
    },
  },
  {
    name: 'ai-shadow',
    note: 'the mirror belief: a bot with no ball, deciding how loud to be while it thinks about how much the opposition knows',
    expect: 'mirrorKnown is ~1 the instant the ping lands and decays as the bot stays quiet; the bot mostly holds or walks',
    seed: 44,
    ticks: 420,
    eyes: 1,
    build: () => {
      const config = quietConfig();
      // He pings once. A ping is heard by the whole pitch and it *sees* the whole pitch, so from
      // that instant the bot knows it has been seen — and the question the axes have to answer is
      // how long it takes for that to stop being true if it says nothing.
      const prober = scripted(
        [
          { for: 1.6, walk: [-1, 0.8], aim: [-1, 0], label: 'close in' },
          { ping: true, label: 'ping' },
          { for: 30, stand: true, label: 'silence' },
        ],
        'prober',
      );
      return { config, controllers: panel({ name: 'prober', make: prober }, config.teamSize) };
    },
    measure: (_m, log) => {
      const early = at(log, 1.9);
      const late = at(log, 6.0);
      const quiet = log.loudness.filter((l) => l <= 0).length / Math.max(1, log.loudness.length);
      return {
        'known@1.9s': +log.mirrorKnown[early]!.toFixed(3),
        'known@6.0s': +log.mirrorKnown[late]!.toFixed(3),
        'silentShare': +quiet.toFixed(2),
        'held%': +(log.action.filter((a) => a === 'hold').length / Math.max(1, log.action.length)).toFixed(2),
      };
    },
  },
];

/** The tracked body and the axis of the trick, per scenario. */
export const SCENARIO_AXES: Record<string, { tracked: EntityId; axis: Vec2 }> = {
  'ai-feint': { tracked: 2, axis: { x: 1, y: 0 } },
  'ai-false-ping': { tracked: 2, axis: { x: 0, y: -1 } },
  'ai-silence': { tracked: 2, axis: { x: -1, y: -1 } },
  'ai-doughnut': { tracked: 2, axis: { x: 1, y: 0 } },
  'ai-shadow': { tracked: 2, axis: { x: 1, y: 0 } },
};

export function findAiScenario(name: string): AiScenario {
  const s = AI_SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown ai scenario: ${name}`);
  return s;
}
