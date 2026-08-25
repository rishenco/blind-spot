/**
 * Two measurements the AI brief asks for by name, and neither of them is about winning.
 *
 * **1. The ball-hum hole.** The ball never stops singing, and a bot receives its position sixty
 * times a second. If it could average all of that, the error would fall as 1/sqrt(n) and the bot
 * would know the ball several times better than a human could — at `truthLeak = 0`, with nothing
 * in the honesty knobs to blame for it. The simulation already fights this with a temporally
 * correlated error (`emitterNoiseSmoothing`); `ai.observationMemory` bounds what is left. This
 * prints both, so the question "is the correlated noise enough on its own" has a number.
 *
 * **2. Does the whole difficulty range fit in the information knobs?** The human's hypothesis is
 * that it does, and that `truthLeak` is never needed. This sweeps each knob on its own and
 * prints the resulting scoreline against a fixed opponent, so the hypothesis can be answered
 * with a table instead of an opinion.
 *
 *   npm run honesty
 *   npm run honesty -- --seeds 1-10 --only ball
 */
import { configFromPreset, type SimConfig } from '../config';
import { Bot } from '../ai/bot';
import { makeController } from '../controllers';
import { Match } from '../match';
import { dist2 } from '../math';

declare const process: { argv: string[]; exit(code?: number): never };

const args: Record<string, string> = {};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith('--') ? next : 'true';
}
const seeds = ((): number[] => {
  const spec = args.seeds ?? '1-6';
  const m = spec.match(/^(\d+)-(\d+)$/);
  if (!m) return spec.split(',').map(Number);
  const out: number[] = [];
  for (let s = Number(m[1]); s <= Number(m[2]); s++) out.push(s);
  return out;
})();
const only = args.only;

const roster = (a: string, b: string, size: number) => [
  ...Array.from({ length: size }, () => makeController(a)),
  ...Array.from({ length: size }, () => makeController(b)),
];

// -- 1. the ball hum --------------------------------------------------------

/**
 * Mean error of what the bot believes about the ball, against the mean error of one raw
 * observation. The ratio is the whole question: 1.0 means the bot is exactly as well informed as
 * a human staring at one blob; 0.3 means it has quietly bought three times the eyesight.
 */
function ballAccuracy(
  memory: number,
  smoothing: number,
): { belief: number; raw: number; naive: number; ratio: number } {
  let beliefErr = 0;
  let rawErr = 0;
  let naiveErr = 0;
  let n = 0;
  for (const seed of seeds) {
    const cfg: SimConfig = configFromPreset('default');
    cfg.ai.observationMemory = memory;
    cfg.perception.emitterNoiseSmoothing = smoothing;
    cfg.match.durationSec = 40;
    const match = new Match({ config: cfg, seed, controllers: roster('bot', 'striker', cfg.teamSize) });
    // The control: the dumbest possible cheat, a flat mean of the last `memory` observations.
    // If THIS beats one raw sample by a lot, the hole is real whatever the bot happens to do.
    const window: { x: number; y: number }[] = [];
    while (!match.isOver) {
      match.step();
      const bot = match.controllers[0];
      if (!(bot instanceof Bot)) continue;
      const est = bot.beliefState.ball;
      const frame = match.frameOf(0);
      const raw = frame?.emitters.find((e) => e.kind === 'ball');
      if (!est || !raw) continue;
      const truth = match.sim.state.ball.pos;
      window.push({ x: raw.pos.x, y: raw.pos.y });
      if (window.length > memory) window.shift();
      let mx = 0;
      let my = 0;
      for (const w of window) {
        mx += w.x / window.length;
        my += w.y / window.length;
      }
      beliefErr += dist2(est.pos, truth);
      rawErr += dist2(raw.pos, truth);
      naiveErr += dist2({ x: mx, y: my }, truth);
      n++;
    }
  }
  if (n === 0) return { belief: 0, raw: 0, naive: 0, ratio: 1 };
  return {
    belief: beliefErr / n,
    raw: rawErr / n,
    naive: naiveErr / n,
    ratio: naiveErr / Math.max(1e-9, rawErr),
  };
}

if (!only || only === 'ball') {
  console.log('\n=== 1. the ball hum: can a bot average its way to better ears than a human? ===');
  console.log('   catchRadius = 1.2 m — an error much below that is the difference between');
  console.log('   "catches every time" and "catches when it deserves to".\n');
  console.log('observationMemory  smoothing   belief err   raw err   naive mean   naive/raw');
  for (const smoothing of [0, 0.97]) {
    for (const memory of [1, 4, 12, 30, 60, 120]) {
      const r = ballAccuracy(memory, smoothing);
      console.log(
        `${String(memory).padStart(17)}  ${smoothing.toFixed(2).padStart(9)}   ` +
          `${r.belief.toFixed(3).padStart(10)}   ${r.raw.toFixed(3).padStart(7)}   ` +
          `${r.naive.toFixed(3).padStart(10)}   ${r.ratio.toFixed(2).padStart(9)}`,
      );
    }
  }
}

// -- 2. the difficulty dial -------------------------------------------------

/**
 * Goals per minute, not goals.
 *
 * The first version of this table used the normal match rules and reported 5.00 for the bot in
 * every single row, including telepathy — because a match ends at five goals, so the metric
 * saturates and measures the length of the match instead of the strength of the player. With the
 * cap lifted and the clock fixed, the knobs separate.
 *
 * Note the honest limitation: `config.perception` is one object for the whole match, so a knob
 * turned here is turned for *both* sides. Against a dummy that has no belief layer the effect is
 * asymmetric anyway (it only ever hears the ball), but the numbers are a comparison between
 * worlds, not a handicap applied to one player.
 */
function play(mutate: (c: SimConfig) => void, opponent: string): { us: number; them: number } {
  let us = 0;
  let them = 0;
  let minutes = 0;
  for (const seed of seeds) {
    const cfg = configFromPreset('default');
    cfg.match.kickoffTeam = 'alternate';
    cfg.match.goalsToWin = 999;
    cfg.match.durationSec = 120;
    mutate(cfg);
    const res = new Match({ config: cfg, seed, controllers: roster('bot', opponent, cfg.teamSize) }).run();
    us += res.stats.score[0];
    them += res.stats.score[1];
    minutes += res.stats.duration / 60;
  }
  return { us: us / minutes, them: them / minutes };
}

if (!only || only === 'knobs') {
  console.log('\n=== 2. does the difficulty range fit in the information knobs at truthLeak = 0? ===\n');
  const opponent = args.opponent ?? 'striker';
  const rows: { label: string; mutate: (c: SimConfig) => void }[] = [
    { label: 'baseline (honest)', mutate: () => {} },
    { label: 'hearingScale 0.6', mutate: (c) => void (c.perception.hearingScale = 0.6) },
    { label: 'hearingScale 0.35', mutate: (c) => void (c.perception.hearingScale = 0.35) },
    { label: 'hearingScale 1.5', mutate: (c) => void (c.perception.hearingScale = 1.5) },
    { label: 'sigma/m 0.18', mutate: (c) => void (c.perception.localizationSigmaPerMeter = 0.18) },
    { label: 'sigma/m 0.4, cap 5', mutate: (c) => { c.perception.localizationSigmaPerMeter = 0.4; c.perception.localizationSigmaCap = 5; } },
    { label: 'latency 0.25 s', mutate: (c) => void (c.perception.reactionLatencySec = 0.25) },
    { label: 'latency 0.6 s', mutate: (c) => void (c.perception.reactionLatencySec = 0.6) },
    { label: 'decisionQuality 0.5', mutate: (c) => void (c.ai.decisionQuality = 0.5) },
    { label: 'decisionQuality 0.25', mutate: (c) => void (c.ai.decisionQuality = 0.25) },
    { label: 'beliefHz 3 (slow brain)', mutate: (c) => void (c.ai.beliefHz = 3) },
    { label: 'teamShare on (voice)', mutate: (c) => void (c.perception.teamShare = true) },
    { label: 'anonymousSources off', mutate: (c) => void (c.perception.anonymousSources = false) },
    { label: 'truthLeak 0.5 (cheat)', mutate: (c) => void (c.perception.truthLeak = 0.5) },
    { label: 'truthLeak 1.0 (telepathy)', mutate: (c) => void (c.perception.truthLeak = 1) },
  ];
  console.log(`bot (team 0) vs ${opponent}, ${seeds.length} seeds each, 2 min per match, no goal cap\n`);
  console.log('knob                        goals/min      diff/min');
  for (const row of rows) {
    const r = play(row.mutate, opponent);
    console.log(
      `${row.label.padEnd(26)}  ${r.us.toFixed(2)}:${r.them.toFixed(2)}      ` +
        `${r.us - r.them >= 0 ? '+' : ''}${(r.us - r.them).toFixed(2)}`,
    );
  }
}
