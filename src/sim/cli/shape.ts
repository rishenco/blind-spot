/**
 * The shape of the play — the degeneracy meter.
 *
 * `npm run contest` answers "is this a game" (does knowledge pay, does the ping pay, is silence
 * still worth anything). It cannot answer the complaint that started this task: *"they have
 * simply learned who gets to the ball first, and then throw it straight at the goal."* A match
 * like that has a healthy scoreline, a healthy possession split and a healthy turnover count.
 * What it does not have is a second idea in it.
 *
 * So this runner measures the idea, not the outcome:
 *
 *   passes/possession   near zero = the ball never changes hands inside an attack;
 *   hold before a shot  one second = nobody ever does anything with the ball but release it;
 *   shot distance       the spread says whether shooting has a geography at all;
 *   direct goals        goals scored in an attack that contained no pass, as a share.
 *
 *   npm run shape                          # every row, default seeds
 *   npm run shape -- --only base,keeper --seeds 1-24 --secs 90
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { cloneConfig, defaultConfig, type SimConfig } from '../config';
import { roster } from '../controllers';
import { Match } from '../match';
import { aggregate, type MatchStats } from '../stats';

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  hrtime: { bigint(): bigint };
  on(ev: string, fn: (m: unknown) => void): void;
  send?: (m: unknown) => void;
};

export interface ShapeRow {
  name: string;
  note: string;
  apply(c: SimConfig): void;
}

export const ROWS: ShapeRow[] = [
  { name: 'base', note: 'the rules as they are', apply: () => {} },
  {
    name: 'v1',
    note: 'the rules as they were before this pass: no keeper, ball humming for ever, timed catch, proximity steal, 2.5 m goal, 1.5 s ping',
    apply: (c) => {
      c.keeper.enabled = false;
      c.field.goalWidth = 2.5;
      c.catching.auto = false;
      c.catching.catchSpeedSpan = 1e9;
      c.contest.steal.enabled = true;
      c.match.carryTimeoutSec = 5;
      c.ping.cooldownSec = 1.5;
      c.ping.range = 14;
      c.ping.lifeSec = 1;
      // The ball as it was: a continuous whole-pitch hum in the hands as well as in flight.
      c.ball.voice.quietSec = 0;
      c.ball.voice.rampSec = 0.01;
      c.ball.voice.intervalStart = 0.2;
      c.ball.voice.intervalMin = 0.2;
      c.ball.voice.startLoudFrac = 1;
      c.loudness['ball-carry'] = 30;
    },
  },
  {
    name: 'no-keeper',
    note: 'the crease is forbidden to everybody — the rule that left the goal mouth empty',
    apply: (c) => {
      c.keeper.enabled = false;
    },
  },
  // --- the ball's voice: the main tuning surface of the game now ---------------------------
  {
    name: 'v-eager',
    note: 'a short quiet window (0.8 s) and a fast ramp (3 s): carrying gets expensive quickly',
    apply: (c) => {
      c.ball.voice.quietSec = 0.8;
      c.ball.voice.rampSec = 3;
      c.ball.voice.intervalStart = 0.9;
    },
  },
  {
    name: 'v-eager2',
    note: 'shorter still: 0.6 s of quiet, a 2.5 s ramp, first beep at 0.7 s',
    apply: (c) => {
      c.ball.voice.quietSec = 0.6;
      c.ball.voice.rampSec = 2.5;
      c.ball.voice.intervalStart = 0.7;
    },
  },
  {
    name: 'v-eager3',
    note: 'the eager rhythm with a louder first beep (0.45 of full) — carrying is costly at once',
    apply: (c) => {
      c.ball.voice.quietSec = 0.8;
      c.ball.voice.rampSec = 3;
      c.ball.voice.intervalStart = 0.9;
      c.ball.voice.startLoudFrac = 0.45;
    },
  },
  {
    name: 'v-lazy',
    note: 'a long quiet window (2 s) and a slow ramp (7 s): carrying stays cheap for a while',
    apply: (c) => {
      c.ball.voice.quietSec = 2;
      c.ball.voice.rampSec = 7;
    },
  },
  {
    name: 'v-loud',
    note: 'the same rhythm, but a fully-ramped ball is audible from 30 m — the whole pitch',
    apply: (c) => {
      c.loudness['ball-carry'] = 30;
    },
  },
  {
    name: 'v-soft',
    note: 'a fully-ramped ball only carries 14 m: holding it is much cheaper',
    apply: (c) => {
      c.loudness['ball-carry'] = 14;
    },
  },
  {
    name: 'v-always',
    note: 'the old rule for comparison: the ball hums across the whole pitch, in the hands too',
    apply: (c) => {
      c.ball.voice.quietSec = 0;
      c.ball.voice.rampSec = 0.01;
      c.ball.voice.intervalStart = 0.2;
      c.ball.voice.intervalMin = 0.2;
      c.ball.voice.startLoudFrac = 1;
      c.loudness['ball-carry'] = 30;
    },
  },
  {
    name: 'k-3.2-hands',
    note: '3.2 m mouth, keeper as configured (2.4× reach at 1.4 m out)',
    apply: (c) => {
      c.field.goalWidth = 3.2;
    },
  },
  {
    name: 'k-3.2-small',
    note: '3.2 m mouth, smaller hands (1.8×) and a keeper on his line (1.0 m)',
    apply: (c) => {
      c.field.goalWidth = 3.2;
      c.keeper.reachMul = 1.8;
      c.keeper.depth = 1;
    },
  },
  {
    name: 'k-4.0-hands',
    note: '4 m mouth, 2.4× reach at 1.4 m out',
    apply: (c) => {
      c.field.goalWidth = 4;
    },
  },
  {
    name: 'k-4.0-small',
    note: '4 m mouth, 1.8× reach on the line',
    apply: (c) => {
      c.field.goalWidth = 4;
      c.keeper.reachMul = 1.8;
      c.keeper.depth = 1;
    },
  },
  {
    name: 'goal-3.2',
    note: 'a 3.2 m mouth: the goal was narrowed to 2.5 m because the net was empty, and it no longer is',
    apply: (c) => {
      c.field.goalWidth = 3.2;
    },
  },
  {
    name: 'goal-4.0',
    note: 'a 4 m mouth — wider than the keeper can cover from the middle, whatever his timing',
    apply: (c) => {
      c.field.goalWidth = 4;
    },
  },
  {
    name: 'goal-3.2-flat',
    note: '3.2 m, keeper on his line (0.8 m) and no reach bonus: the mouth is open and he has to pick a half',
    apply: (c) => {
      c.field.goalWidth = 3.2;
      c.keeper.depth = 0.8;
      c.keeper.reachMul = 1;
    },
  },
  {
    name: 'goal-4.0-flat',
    note: '4 m, keeper on his line, no reach bonus',
    apply: (c) => {
      c.field.goalWidth = 4;
      c.keeper.depth = 0.8;
      c.keeper.reachMul = 1;
    },
  },
  {
    name: 'goal-3.2-deep',
    note: '3.2 m and a keeper who steps out to 2.2 m — the angle-closing extreme',
    apply: (c) => {
      c.field.goalWidth = 3.2;
      c.keeper.depth = 2.2;
    },
  },
];

interface Job {
  row: string;
  seed: number;
  secs: number;
  a: string;
  b: string;
  /** Players per team. Defaults to the concept's 2×2; `--team 3` runs the 3×3 comparison. */
  team: number;
}

interface JobResult extends Job {
  stats: MatchStats;
}

function buildConfig(job: Job): SimConfig {
  const row = ROWS.find((r) => r.name === job.row);
  if (!row) throw new Error(`unknown row: ${job.row}`);
  const config = cloneConfig(defaultConfig());
  row.apply(config);
  config.teamSize = job.team;
  config.match.durationSec = job.secs;
  config.match.goalsToWin = 1e9;
  config.match.kickoffTeam = 'alternate';
  return config;
}

function runJob(job: Job): JobResult {
  const config = buildConfig(job);
  const match = new Match({ config, seed: job.seed, controllers: roster(job.a, job.b, config.teamSize) });
  const res = match.run();
  return { ...job, stats: res.stats };
}

if (process.env.SHAPE_WORKER === '1') {
  process.on('message', (msg) => {
    const jobs = msg as Job[];
    process.send?.(jobs.map(runJob));
  });
} else {
  await main();
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (!x.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[x.slice(2)] = 'true';
    else {
      out[x.slice(2)] = next;
      i++;
    }
  }
  return out;
}

function parseSeeds(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.match(/^(-?\d+)\s*(?:-|\.\.)\s*(-?\d+)$/);
    if (m) for (let s = Number(m[1]); s <= Number(m[2]); s++) out.push(s);
    else if (part.trim() !== '') out.push(Number(part));
  }
  return out;
}

async function runAll(jobs: Job[], workers: number): Promise<JobResult[]> {
  if (workers <= 1) return jobs.map(runJob);
  const self = fileURLToPath(import.meta.url);
  const chunks: Job[][] = Array.from({ length: workers }, () => []);
  jobs.forEach((j, i) => chunks[i % workers]!.push(j));
  const results = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<JobResult[]>((resolve, reject) => {
          if (chunk.length === 0) return resolve([]);
          const child = fork(self, [], {
            env: { ...process.env, SHAPE_WORKER: '1' },
            execArgv: (process as unknown as { execArgv: string[] }).execArgv,
          });
          child.on('message', (m) => {
            resolve(m as JobResult[]);
            child.kill();
          });
          child.on('error', reject);
          child.send(chunk);
        }),
    ),
  );
  return results.flat();
}

/** Quantiles of the shot-distance list — the distribution, not just its mean. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true') {
    console.log(`usage: npm run shape -- [--only a,b] [--seeds 1-16] [--secs 90] [--a bot --b bot]\nrows: ${ROWS.map((r) => r.name).join(', ')}`);
    process.exit(0);
  }
  const only = args.only ? args.only.split(',').map((s) => s.trim()) : null;
  const rows = ROWS.filter((r) => !only || only.includes(r.name));
  const seeds = parseSeeds(args.seeds ?? '1-16');
  const secs = Number(args.secs ?? 90);
  const a = args.a ?? 'bot';
  const b = args.b ?? 'bot';
  const team = Number(args.team ?? 2);
  const workers = Number(args.workers ?? Math.max(1, Math.min(cpus().length, 8)));

  const jobs: Job[] = [];
  for (const r of rows) for (const seed of seeds) jobs.push({ row: r.name, seed, secs, a, b, team });

  const t0 = process.hrtime.bigint();
  const results = await runAll(jobs, workers);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const head = [
    'row', 'goals/min', 'pass/poss', 'pass/goal', 'passes', 'hold→shot', 'hold→throw', 'shots/min',
    'shot d p25', 'p50', 'p75', 'direct%', 'poss/min', 'hold max', 'saves/min', 'silent%', 'ping/min',
    // The positional-play columns — added for the "either they bomb it or it's a scrum" pass.
    'scrum%', 'avg pair d', 'near-opp%', 'pat/min',
  ];
  const body: string[][] = [];
  for (const r of rows) {
    const stats = results.filter((x) => x.row === r.name).map((x) => x.stats);
    const agg = aggregate(stats);
    const sh = agg.shape;
    const mins = (Math.max(1e-6, agg.duration) * stats.length) / 60;
    const dist = [...sh.shotDistances].sort((x, y) => x - y);
    const sum = (f: (p: (typeof agg.players)[number]) => number) => agg.players.reduce((s, p) => s + f(p), 0);
    body.push([
      r.name,
      (sh.goals / mins).toFixed(2),
      (sh.passes / Math.max(1, sh.possessions)).toFixed(3),
      (sh.passes / Math.max(1, sh.goals)).toFixed(2),
      String(sh.passes),
      (sh.holdBeforeShotSum / Math.max(1, sh.shots)).toFixed(2),
      (sh.holdBeforeThrowSum / Math.max(1, sh.throws)).toFixed(2),
      (sh.shots / mins).toFixed(2),
      quantile(dist, 0.25).toFixed(1),
      quantile(dist, 0.5).toFixed(1),
      quantile(dist, 0.75).toFixed(1),
      ((sh.goalsWithoutPass / Math.max(1, sh.goals)) * 100).toFixed(0),
      (sh.possessions / mins).toFixed(1),
      sh.holdMax.toFixed(1),
      (sh.keeperSaves / mins).toFixed(2),
      ((agg.players.length ? sum((p) => p.silentShare) / agg.players.length : 0) * 100).toFixed(0),
      sum((p) => p.pingsPerMinute).toFixed(2),
      ((sh.scrumTicks / Math.max(1, sh.positionTicks)) * 100).toFixed(1),
      (sh.pairDistanceSum / Math.max(1, sh.pairSamples)).toFixed(2),
      ((sh.nearOpponentTicks / Math.max(1, sh.positionTicks * team * 2)) * 100).toFixed(1),
      (sh.passivityTurnovers / mins).toFixed(2),
    ]);
  }
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((x) => x[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i]!)).join('  ');
  console.log(`\nshape of the play — ${seeds.length} seeds × ${secs}s, ${a} vs ${b}, ${team}×${team}\n`);
  console.log(line(head));
  for (const x of body) console.log(line(x));
  console.log('\nrows:');
  for (const r of rows) console.log(`  ${r.name.padEnd(12)} ${r.note}`);
  console.log(`\n${results.length} matches in ${(ms / 1000).toFixed(1)} s`);
}
