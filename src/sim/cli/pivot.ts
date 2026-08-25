/**
 * The joint sweep: rule set × team size × pitch.
 *
 * It exists because the three of them are ONE tuning surface and measuring them apart measures
 * nothing. The previous pass already learned that the hard way: 3×3 produced more passing than
 * 2×2 and three times the scrum, almost certainly because the pitch stayed 24×14 — three bodies
 * a side on a court sized for two is not a test of team size, it is a test of density.
 *
 * The two columns that decide the question are the two the человек named:
 *
 *   scrum%   share of ticks with three or more bodies inside a 3 m circle — the picture he
 *            sent a screenshot of, as a number;
 *   shot IQR the spread of shot distances, p75 − p25. Not the median: the complaint is that
 *            every shot comes from the same band, and a median cannot see that.
 *
 *   npm run pivot
 *   npm run pivot -- --rules classic,touch --team 2,3 --fields 24x14,28x16,32x18 --seeds 1-12
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { applyRuleset, cloneConfig, defaultConfig, resizeField, type Ruleset, type SimConfig } from '../config';
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

interface Job {
  ruleset: Ruleset;
  team: number;
  field: string;
  seed: number;
  secs: number;
  a: string;
  b: string;
}

interface JobResult extends Job {
  stats: MatchStats;
}

export function buildConfig(job: Pick<Job, 'ruleset' | 'team' | 'field' | 'secs'>): SimConfig {
  const config = applyRuleset(cloneConfig(defaultConfig()), job.ruleset);
  config.teamSize = job.team;
  const dims = job.field.split('x').map(Number);
  if (dims.length === 2 && dims[0]! > 0 && dims[1]! > 0) resizeField(config, dims[0]!, dims[1]!);
  config.match.durationSec = job.secs;
  config.match.goalsToWin = 1e9;
  config.match.kickoffTeam = 'alternate';
  return config;
}

function runJob(job: Job): JobResult {
  const config = buildConfig(job);
  const match = new Match({ config, seed: job.seed, controllers: roster(job.a, job.b, config.teamSize) });
  return { ...job, stats: match.run().stats };
}

if (process.env.PIVOT_WORKER === '1') {
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
            env: { ...process.env, PIVOT_WORKER: '1' },
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

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (xs.length - 1));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true') {
    console.log(
      'usage: npm run pivot -- [--rules classic,touch] [--team 2,3] [--fields 24x14,28x16]\n' +
        '                       [--seeds 1-12] [--secs 90] [--a bot --b bot] [--workers 8]',
    );
    process.exit(0);
  }
  const rules = (args.rules ?? 'classic,touch').split(',').map((s) => s.trim()) as Ruleset[];
  const teams = (args.team ?? '2,3').split(',').map(Number);
  const fields = (args.fields ?? '24x14,28x16,32x18').split(',').map((s) => s.trim());
  const seeds = parseSeeds(args.seeds ?? '1-12');
  const secs = Number(args.secs ?? 90);
  const a = args.a ?? 'bot';
  const b = args.b ?? 'bot';
  const workers = Number(args.workers ?? Math.max(1, Math.min(cpus().length, 8)));

  const jobs: Job[] = [];
  for (const ruleset of rules) {
    for (const team of teams) {
      for (const field of fields) {
        for (const seed of seeds) jobs.push({ ruleset, team, field, seed, secs, a, b });
      }
    }
  }

  const t0 = process.hrtime.bigint();
  const results = await runAll(jobs, workers);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const head = [
    'rules', 'N', 'field', 'scrum%', 'shot IQR', 'shot sd', 'p25', 'p50', 'p75', 'shots/min',
    'goals/min', 'own-goal%', 'pair d', 'near-opp%', 'pass/attack', 'attacks/min', 'wild%', 'silent%', 'ping/min',
  ];
  const body: string[][] = [];
  for (const ruleset of rules) {
    for (const team of teams) {
      for (const field of fields) {
        const stats = results
          .filter((r) => r.ruleset === ruleset && r.team === team && r.field === field)
          .map((r) => r.stats);
        if (stats.length === 0) continue;
        const agg = aggregate(stats);
        const sh = agg.shape;
        const mins = (Math.max(1e-6, agg.duration) * stats.length) / 60;
        const dist = [...sh.shotDistances].sort((x, y) => x - y);
        const sum = (f: (p: (typeof agg.players)[number]) => number) => agg.players.reduce((s, p) => s + f(p), 0);
        const attacks = Math.max(1, sh.possessions);
        body.push([
          ruleset,
          `${team}v${team}`,
          field,
          ((sh.scrumTicks / Math.max(1, sh.positionTicks)) * 100).toFixed(1),
          (quantile(dist, 0.75) - quantile(dist, 0.25)).toFixed(1),
          stdev(dist).toFixed(1),
          quantile(dist, 0.25).toFixed(1),
          quantile(dist, 0.5).toFixed(1),
          quantile(dist, 0.75).toFixed(1),
          (sh.shots / mins).toFixed(2),
          (sh.goals / mins).toFixed(2),
          ((sh.ownGoals / Math.max(1, sh.goals)) * 100).toFixed(0),
          (sh.pairDistanceSum / Math.max(1, sh.pairSamples)).toFixed(2),
          ((sh.nearOpponentTicks / Math.max(1, sh.positionTicks * team * 2)) * 100).toFixed(1),
          (sh.passes / attacks).toFixed(2),
          (attacks / mins).toFixed(1),
          ((sh.wildStrikes / Math.max(1, sh.strikes)) * 100).toFixed(0),
          ((agg.players.length ? sum((p) => p.silentShare) / agg.players.length : 0) * 100).toFixed(0),
          sum((p) => p.pingsPerMinute).toFixed(2),
        ]);
      }
    }
  }
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((x) => x[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i]!)).join('  ');
  console.log(`\nrule set × team size × pitch — ${seeds.length} seeds × ${secs}s, ${a} vs ${b}\n`);
  console.log(line(head));
  for (const x of body) console.log(line(x));
  console.log(`\n${results.length} matches in ${(ms / 1000).toFixed(1)} s`);
}
