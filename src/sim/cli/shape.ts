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
    name: 'no-keeper',
    note: 'the crease is forbidden to everybody — the rule that left the goal mouth empty',
    apply: (c) => {
      c.keeper.enabled = false;
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
}

interface JobResult extends Job {
  stats: MatchStats;
}

function buildConfig(job: Job): SimConfig {
  const row = ROWS.find((r) => r.name === job.row);
  if (!row) throw new Error(`unknown row: ${job.row}`);
  const config = cloneConfig(defaultConfig());
  row.apply(config);
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
  const workers = Number(args.workers ?? Math.max(1, Math.min(cpus().length, 8)));

  const jobs: Job[] = [];
  for (const r of rows) for (const seed of seeds) jobs.push({ row: r.name, seed, secs, a, b });

  const t0 = process.hrtime.bigint();
  const results = await runAll(jobs, workers);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const head = ['row', 'goals/min', 'pass/poss', 'pass/goal', 'passes', 'hold→shot', 'hold→throw', 'shots/min', 'shot d p25', 'p50', 'p75', 'direct%', 'poss/min', 'saves/min', 'silent%', 'ping/min'];
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
      (sh.keeperSaves / mins).toFixed(2),
      ((agg.players.length ? sum((p) => p.silentShare) / agg.players.length : 0) * 100).toFixed(0),
      sum((p) => p.pingsPerMinute).toFixed(2),
    ]);
  }
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((x) => x[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i]!)).join('  ');
  console.log(`\nshape of the play — ${seeds.length} seeds × ${secs}s, ${a} vs ${b}\n`);
  console.log(line(head));
  for (const x of body) console.log(line(x));
  console.log('\nrows:');
  for (const r of rows) console.log(`  ${r.name.padEnd(12)} ${r.note}`);
  console.log(`\n${results.length} matches in ${(ms / 1000).toFixed(1)} s`);
}
