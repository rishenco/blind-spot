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
  /**
   * Which suite this belongs to.
   *
   * `deception` scenarios measure a bot's *belief* against the truth and are the answer to "can
   * this bot still be lied to". `mechanic` scenarios measure the *rules*: a steal happened, a
   * tackle connected, a shot went past a defender. They share this list because they share the
   * playground dropdown and the keyframe generator, and a mechanic whose picture and whose
   * number came from two different setups proves nothing.
   */
  suite?: 'deception' | 'mechanic';
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

/**
 * Runs a scenario without looking inside anybody's head.
 *
 * The mechanic suite does not need a belief log — what it is checking is that the rules produced
 * the event they promise, which is a fact about the match, not about a bot. Returns the finished
 * match so `measure` can read the statistics and the timeline.
 */
export function runPlain(s: AiScenario): { match: Match; log: SampleLog } {
  const { config, controllers } = s.build();
  const match = new Match({ config, seed: s.seed, controllers, keepLog: true });
  for (let i = 0; i < s.ticks && !match.isOver; i++) match.step();
  return { match, log: emptyLog() };
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
  // The observer may not ping. Every scenario in this suite is about what a bot believes from
  // what it *heard*, and a ping that sees the whole pitch answers the question the experiment is
  // asking — the observer would simply look, and the belief being measured would never form.
  const out: { name: string; make: ControllerFactory }[] = [makeController('statue')];
  for (let i = 1; i < size; i++) out.push(makeController('bot-mute'));
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

/** The mechanic suite, kept addressable on its own so the deception CLI can skip it. */
export const MECHANIC_SCENARIOS: AiScenario[] = [];

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

// ===========================================================================
// The mechanic suite: proof that the fight for the ball does what it says.
//
// These are not about belief. Each one is a fixed, scripted collision between two bodies whose
// outcome is a rule firing, and each `measure` reads that rule's own counter out of the match
// statistics. They exist because "steal works" is not a claim anybody should have to take on
// trust, and because every one of them is also a keyframe.
// ===========================================================================

/** A clean 2×2 with no spawn jitter, so a scripted collision lands in the same place every time. */
function riggedConfig(only: 'steal' | 'tackle' | 'collision' | 'block' | 'none'): SimConfig {
  const c = configFromPreset('default');
  c.match.spawnJitter = 0;
  c.match.kickoffTeam = 'fixed';
  c.match.carryTimeoutSec = 0;
  // One mechanic at a time. A frame that proves "the ball came loose" proves nothing if three
  // different rules could have knocked it loose, so every scenario switches the others off.
  c.contest.steal.enabled = only === 'steal';
  c.contest.tackle.enabled = only === 'tackle';
  c.contest.collision.enabled = only === 'collision';
  c.contest.block.mode = only === 'block' ? 'speed' : 'always';
  if (only === 'block') {
    // A tighter reach for this scenario only. With catching automatic, the band in which a ball
    // touches a body and is still uncatchable is what "the block is not a wall" now means — and
    // at the default span that band is a hand's width. Widening it here makes the frame legible
    // without changing what the rule says.
    c.catching.catchSpeedSpan = 14;
  }
  return c;
}

/** Kickoff geometry with jitter off: P0 (-6.8,-5) has the ball, P2 (4.2,-5) faces him. */
function duel(
  p0: { name: string; make: ControllerFactory },
  p2: { name: string; make: ControllerFactory },
): { name: string; make: ControllerFactory }[] {
  return [p0, makeController('statue'), p2, makeController('statue')];
}

const contestCount = (m: Match, kind: string): number =>
  m.timeline.filter((e) => e.kind === 'contest' && e.label.includes(kind)).length;

MECHANIC_SCENARIOS.push(
  {
    name: 'mech-steal',
    suite: 'mechanic',
    // Rewritten 2026-08-25: touch never takes the ball off a carrier any more (concept, "убери
    // все способы забрать мяч из рук соперника прикосновением"). This scenario used to prove the
    // proximity steal worked; it now proves the opposite on purpose — the exact same script that
    // used to strip the ball leaves it alone, because there is nothing left in the rules that
    // reads "stood next to him long enough".
    note: 'the steal, retired: a hunter runs the carrier down and stays glued to his shoulder for six seconds straight',
    expect: 'zero steals, zero possession changes — proximity alone does not take the ball off anybody any more',
    seed: 101,
    ticks: 220,
    eyes: 0,
    build: () => {
      const config = riggedConfig('none');
      const carrier = scripted([{ for: 6, walk: [1, 0], aim: [1, 0], label: 'walking it up' }], 'carrier');
      const hunter = scripted(
        [
          { for: 1.25, run: [-1, 0], aim: [-1, 0], label: 'closing him down' },
          { for: 6, walk: [1, 0], label: 'and staying on his shoulder — and doing nothing else' },
        ],
        'hunter',
      );
      return { config, controllers: duel({ name: 'carrier', make: carrier }, { name: 'hunter', make: hunter }) };
    },
    measure: (m) => ({
      steals: m.stats.players.reduce((a, p) => a + p.steals, 0),
      robbed: m.stats.players.reduce((a, p) => a + p.robbed, 0),
      carrier: m.sim.state.ball.carrier ?? -1,
      possessionChanges: m.stats.possessionChanges,
    }),
  },
  {
    name: 'mech-tackle',
    suite: 'mechanic',
    // Rewritten 2026-08-25: the dive stopped being an attack. It is a bet on where somebody is
    // GOING to walk, laid down as an obstacle ahead of time — so this scenario now has the
    // defender commit to lying down first, off to the side of the carrier's line, and the
    // carrier (scripted, blind to the trap exactly like a human would be) simply keeps running
    // his own line and finds it.
    note: 'the trap, sprung: the defender lies down ahead of the carrier’s line; the carrier runs it, blind, and finds him',
    expect: 'one tackle; the carrier is the one who goes down, and the ball comes off him — the trapper never moved towards him',
    seed: 102,
    ticks: 220,
    eyes: 3,
    build: () => {
      const config = riggedConfig('tackle');
      const carrier = scripted([{ for: 6, run: [1, 0], aim: [1, 0], label: 'driving forward, straight down his line' }], 'carrier');
      const tackler = scripted(
        [
          { for: 0.3, run: [-1, 0], aim: [-1, 0], label: 'stepping onto the line' },
          { dive: true, label: 'lying down across it' },
          { for: 4, label: 'and waiting — this body is not attacking anybody' },
        ],
        'tackler',
      );
      return { config, controllers: duel({ name: 'carrier', make: carrier }, { name: 'tackler', make: tackler }) };
    },
    measure: (m) => ({
      tackles: contestCount(m, 'tackles'),
      down: m.sim.state.players.filter((p) => p.downT > 0).length,
      fumbles: m.stats.players.reduce((a, p) => a + p.fumbles, 0),
      // Loose *from the carrier's point of view*: with catching automatic, whoever is standing
      // over the spilled ball picks it up within a tick or two, which is the mechanic working.
      carrierLostIt: m.sim.state.ball.carrier === 0 ? 0 : 1,
    }),
  },
  {
    name: 'mech-tackle-miss',
    suite: 'mechanic',
    // Rewritten 2026-08-25 to match: a trap that catches nobody, because it was laid somewhere
    // the carrier's line never crosses. There is no "too early" or "too late" any more — the
    // dive always pays the same cost (`dive.durationSec + lieSec + getUpSec`) whether or not
    // anybody ever walks into it, which is the whole point of turning it from a bet on timing
    // into a bet on geography.
    note: 'the trap, empty: the defender guesses wrong and lies down off the carrier’s line entirely',
    expect: 'no tackle, one tackle-miss; the same dive, the same floor time, paid for nothing',
    seed: 103,
    ticks: 220,
    eyes: 3,
    build: () => {
      const config = riggedConfig('tackle');
      const carrier = scripted([{ for: 6, walk: [1, 0], aim: [1, 0], label: 'walking it up, dead straight' }], 'carrier');
      const tackler = scripted(
        [
          { for: 0.2, run: [0, 1], aim: [0, 1], label: 'reading it wrong' },
          { dive: true, label: 'lying down off the line' },
          { for: 5, label: 'waiting for a carrier who is nowhere near' },
        ],
        'tackler',
      );
      return { config, controllers: duel({ name: 'carrier', make: carrier }, { name: 'tackler', make: tackler }) };
    },
    measure: (m) => ({
      tackles: contestCount(m, 'tackles'),
      misses: m.stats.players.reduce((a, p) => a + p.tackleMisses, 0),
      carrierStillHasIt: m.sim.state.ball.carrier === 0 ? 1 : 0,
    }),
  },
  {
    name: 'mech-screen',
    suite: 'mechanic',
    // Rewritten 2026-08-25: this was always a carrier running into a silent body, but the
    // physics used to split the bump 50/50 — which let a carrier simply barge a defender aside a
    // few centimetres at a time and walk through him. The corridor is now asymmetric: the
    // defender holds almost all of the ground, and it is the carrier who gets walked backwards
    // for as long as the defender keeps the spot (`carrierYieldShare`, concept item 2).
    note: 'the screen, and who loses the ground: a silent body plants itself in the corridor, and the carrier — not the defender — is the one shoved backwards',
    expect: 'one collision, the runner staggered and audible, and he keeps the ball — but he ends the run barely past where he met the wall, nowhere near a free 5.5 m/s sprint',
    seed: 104,
    ticks: 200,
    eyes: 3,
    build: () => {
      const config = riggedConfig('collision');
      const runner = scripted([{ for: 6, run: [1, 0], aim: [1, 0], label: 'straight into him' }], 'runner');
      return { config, controllers: duel({ name: 'runner', make: runner }, makeController('statue')) };
    },
    measure: (m) => ({
      collisions: m.stats.players.reduce((a, p) => a + p.collisions, 0) / 2,
      fumbles: m.stats.players.reduce((a, p) => a + p.fumbles, 0),
      stillHasIt: m.sim.state.ball.carrier === 0 ? 1 : 0,
      // He was silent up to the moment of contact and is the loudest thing on the pitch after it.
      thuds: m.log.filter((e) => e.kind === 'brake').length,
      // The corridor: how far the carrier actually got in 200 ticks against how far a free
      // 5.5 m/s sprint would have covered (over 3.33 s, ~18.3 m). A screen that works reads as a
      // small fraction here; the old symmetric bump used to let him creep most of the way through.
      runnerAdvance: m.sim.state.players[0]!.pos.x - -6.8,
    }),
  },
  {
    name: 'mech-block',
    suite: 'mechanic',
    note: 'the block that is no longer absolute: a hard throw straight at a parked defender',
    expect: 'the ball goes past him (ballsThrough ≥ 1) instead of the old guaranteed fumble',
    seed: 2,
    ticks: 160,
    eyes: 2,
    build: () => {
      const config = riggedConfig('block');
      const shooter = scripted(
        [
          // Fired past his shoulder rather than into his chest: at 16 m/s a body catches only
          // what hits its hands, so a ball aimed dead centre is simply caught and proves nothing.
          { for: 0.7, charge: true, aim: [1, 0.04], label: 'wind-up' },
          { for: 5, label: 'released' },
        ],
        'shooter',
      );
      return { config, controllers: duel({ name: 'shooter', make: shooter }, makeController('statue')) };
    },
    measure: (m) => ({
      ballsThrough: m.stats.players.reduce((a, p) => a + p.ballsThrough, 0),
      fumbles: m.stats.players.reduce((a, p) => a + p.fumbles, 0),
    }),
  },
);

// ===========================================================================
// The three mechanics added on 2026-08-25: the keeper, the ball's own voice, and a pass thrown
// into the dark at a man nobody can hear. Each one is a rule the человек asked for, so each one
// arrives with a measurement and a pair of keyframes rather than with a promise.
// ===========================================================================

MECHANIC_SCENARIOS.push(
  {
    name: 'mech-keeper',
    suite: 'mechanic',
    note: 'the keeper: the one body allowed inside its own crease, saving a shot it can only hear',
    expect: 'one save; the shot does not go in',
    seed: 111,
    ticks: 200,
    eyes: 2,
    build: () => {
      const config = configFromPreset('default');
      config.match.spawnJitter = 0;
      config.match.kickoffTeam = 'fixed';
      // The shooter walks into range and fires at the near half of the mouth. He is aiming at a
      // goal he cannot see, at a keeper he cannot hear — which is the whole situation.
      const shooter = scripted(
        [
          { for: 1.9, run: [1, 0.62], aim: [1, 0], label: 'closing in' },
          { for: 0.5, charge: true, aim: [1, -0.06], label: 'wind-up' },
          { for: 4, label: 'released' },
        ],
        'shooter',
      );
      // The keeper walks back onto his line and stands. He may be in there; nobody else may.
      const keeper = scripted(
        [
          { for: 1.6, run: [1, 0.66], aim: [-1, 0], label: 'back to the line' },
          { for: 6, stand: true, aim: [-1, 0], label: 'on the line, listening' },
        ],
        'keeper',
      );
      return { config, controllers: duel({ name: 'shooter', make: shooter }, { name: 'keeper', make: keeper }) };
    },
    measure: (m) => ({
      saves: m.timeline.filter((e) => e.kind === 'contest' && e.label.includes('saves')).length,
      goals: m.stats.score[0],
      keeperInCrease: m.sim.state.players.filter((p) => p.keeper).length,
    }),
  },
  {
    name: 'mech-ball-voice',
    suite: 'mechanic',
    note: 'the ball in the hands: silent for a moment after a catch, then beeping louder and faster',
    expect: 'nothing audible in the first second, and a rising trail of beeps after it',
    seed: 112,
    ticks: 400,
    // Watched from an opponent standing perfectly still eleven metres away: what he hears IS the
    // mechanic. Early on, nothing. Later, a bright line of beeps walking across his screen.
    eyes: 2,
    build: () => {
      const config = configFromPreset('default');
      config.match.spawnJitter = 0;
      config.match.kickoffTeam = 'fixed';
      config.match.carryTimeoutSec = 0;
      const carrier = scripted([{ for: 9, walk: [1, 0.35], aim: [1, 0], label: 'walking it up' }], 'carrier');
      return { config, controllers: duel({ name: 'carrier', make: carrier }, makeController('statue')) };
    },
    measure: (m) => ({
      beeps: m.log.filter((e) => e.kind === 'ball-carry').length,
      firstBeepAt: +(m.log.find((e) => e.kind === 'ball-carry')?.t ?? -1).toFixed(2),
      firstLoudness: +(m.log.find((e) => e.kind === 'ball-carry')?.intensity ?? 0).toFixed(1),
      lastLoudness: +(m.log.filter((e) => e.kind === 'ball-carry').pop()?.intensity ?? 0).toFixed(1),
    }),
  },
  {
    name: 'mech-pass-dark',
    suite: 'mechanic',
    note: 'a pass into the dark: a silent man shouts once, and the bot throws at the shout',
    expect: 'the shout is heard and the pass is completed',
    seed: 113,
    ticks: 900,
    eyes: 0,
    build: () => {
      const config = configFromPreset('default');
      config.match.spawnJitter = 0;
      config.match.kickoffTeam = 'fixed';
      // P1 is a stand-in for a person: he walks quietly into space, stands, and shouts once.
      // Nothing else about him is audible, which is exactly the problem the shout exists for —
      // a bot cannot throw the ball at a body it has no way to place.
      const human = scripted(
        [
          { for: 1.2, walk: [1, -0.5], aim: [1, 0], label: 'quietly into space' },
          { for: 0.4, stand: true, label: 'and silent' },
          { call: true, label: 'HERE' },
          { for: 2.5, stand: true, label: 'waiting for it' },
          { call: true, label: 'HERE' },
          { for: 2.5, stand: true, label: 'still waiting' },
          { call: true, label: 'HERE' },
          { for: 2.5, stand: true, label: 'still waiting' },
          { call: true, label: 'HERE' },
          { for: 2.5, stand: true, label: 'still waiting' },
          { call: true, label: 'HERE' },
          { for: 6, stand: true, label: 'waiting for it' },
        ],
        'human',
      );
      // A live defence, because the question only exists when there is one: with an empty net
      // the man with the ball shoots and no pass is ever worth making.
      return {
        config,
        controllers: [
          makeController('bot'),
          { name: 'human', make: human },
          makeController('bot'),
          makeController('bot'),
        ],
      };
    },
    measure: (m) => ({
      calls: m.log.filter((e) => e.kind === 'call').length,
      passesToHim: m.timeline.filter((e) => e.kind === 'catch' && e.label.includes('P1 takes the pass')).length,
      passes: m.stats.shape.passes,
    }),
  },
);

MECHANIC_SCENARIOS.push({
  name: 'contest-match',
  suite: 'mechanic',
  note: 'a real match under the winning rule set: four bots, every contest mechanic live',
  expect: 'the ball changes hands repeatedly, and nobody is standing still for the whole of it',
  seed: 7,
  ticks: 900,
  eyes: 0,
  build: () => {
    const config = configFromPreset('default');
    config.match.goalsToWin = 1e9;
    config.match.kickoffTeam = 'fixed';
    return { config, controllers: [makeController('bot'), makeController('bot'), makeController('bot'), makeController('bot')] };
  },
  measure: (m) => ({
    score: `${m.stats.score[0]}:${m.stats.score[1]}`,
    possessionChanges: m.stats.possessionChanges,
    steals: m.stats.players.reduce((a, p) => a + p.steals, 0),
    tackles: m.stats.players.reduce((a, p) => a + p.tackles, 0),
    collisions: m.stats.players.reduce((a, p) => a + p.collisions, 0) / 2,
    ballsThrough: m.stats.players.reduce((a, p) => a + p.ballsThrough, 0),
    'silent%': +(
      m.stats.players.reduce((a, p) => a + p.silentTicks / Math.max(1, p.ticks), 0) /
      Math.max(1, m.stats.players.length)
    ).toFixed(2),
  }),
});

for (const s of MECHANIC_SCENARIOS) AI_SCENARIOS.push(s);

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
