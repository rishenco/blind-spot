/**
 * The rule tournament — the answer to "is this a game yet".
 *
 * The concept's test is three questions, and none of them is about who wins:
 *
 *   1. a telepath must beat an honest bot — otherwise knowledge has no price;
 *   2. a bot that may ping must beat one that may not — otherwise the game's central mechanic
 *      is decoration, and its ping rate must be above zero without anybody bribing it;
 *   3. standing still and shutting up must keep a share of the decisions — otherwise contact
 *      has turned the pitch into a brawl, which is a different failure, not a success.
 *
 * This runner asks all three of one rule set at a time, over a fixed list of seeds, on matches
 * of FIXED LENGTH. The last part matters: "first to five goals" saturates, and a saturated
 * scoreline measures how long the match took rather than who was better. Everything here is
 * per minute.
 *
 *   npm run contest                          # every variant, the default seeds
 *   npm run contest -- --only steal,all      # two variants
 *   npm run contest -- --seeds 1-12 --secs 90
 *   npm run contest -- --json
 *
 * Side bias is cancelled by playing every pairing twice with the roles swapped, so a variant is
 * never rewarded for the kickoff.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { cloneConfig, defaultConfig, type PerceptionConfig, type SimConfig } from '../config';
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

// --- the rule variants ------------------------------------------------------

export interface RuleVariant {
  name: string;
  note: string;
  apply(c: SimConfig): void;
}

const off = (c: SimConfig): void => {
  c.contest.steal.enabled = false;
  c.contest.tackle.enabled = false;
  c.contest.collision.enabled = false;
  c.contest.block.mode = 'always';
};

export const VARIANTS: RuleVariant[] = [
  { name: 'none', note: 'the v1 rules: no contact of any kind (control group)', apply: off },
  {
    name: 'steal',
    note: 'proximity steal only — 1.5 m for 0.5 s takes the ball',
    apply: (c) => {
      off(c);
      c.contest.steal.enabled = true;
    },
  },
  {
    name: 'steal-press',
    note: 'the steal as a timed action: the thief has to be holding the catch button',
    apply: (c) => {
      off(c);
      c.contest.steal.enabled = true;
      c.contest.steal.requirePress = true;
    },
  },
  {
    name: 'steal-loose',
    note: 'the steal knocks the ball loose instead of handing it over',
    apply: (c) => {
      off(c);
      c.contest.steal.enabled = true;
      c.contest.steal.knockLoose = true;
    },
  },
  {
    name: 'tackle',
    note: 'the dive tackle only — a dive that connects puts a body on the floor for a second',
    apply: (c) => {
      off(c);
      c.contest.tackle.enabled = true;
    },
  },
  {
    name: 'collision',
    note: 'body contact only — bodies stop passing through each other, hard bumps drop the ball',
    apply: (c) => {
      off(c);
      c.contest.collision.enabled = true;
    },
  },
  {
    name: 'block',
    note: 'no contact, but a body on the shot line is no longer an absolute wall',
    apply: (c) => {
      off(c);
      c.contest.block.mode = 'speed';
    },
  },
  {
    name: 'steal+block',
    note: 'the cheapest pair: hunt the carrier, and let a hard shot get past a parked defender',
    apply: (c) => {
      off(c);
      c.contest.steal.enabled = true;
      c.contest.block.mode = 'speed';
    },
  },
  {
    name: 'steal+tackle',
    note: 'both ways of taking the ball, and no body contact to muddle them',
    apply: (c) => {
      off(c);
      c.contest.steal.enabled = true;
      c.contest.tackle.enabled = true;
    },
  },
  {
    name: 'tackle+block',
    note: 'prediction and a soft block, but no walk-in steal',
    apply: (c) => {
      off(c);
      c.contest.tackle.enabled = true;
      c.contest.block.mode = 'speed';
    },
  },
  {
    name: 'all',
    note: 'everything on: steal, tackle, body contact, soft block',
    apply: () => {},
  },
  {
    name: 'tackle+screen',
    note: 'tackle and soft block, plus body contact that blocks and staggers but does not spill the ball',
    apply: (c) => {
      off(c);
      c.contest.tackle.enabled = true;
      c.contest.block.mode = 'speed';
      // Body contact earns its place as a *screen*: a silent body in the corridor is a wall.
      // Making it also spill the ball turned the pitch into a fumble machine — sixteen a minute
      // in the `collision` row, one every four seconds — which is the "свалка" failure the
      // concept's third test is there to catch.
      c.contest.collision.enabled = true;
      c.contest.collision.dropsBall = false;
      c.contest.collision.loudSpeed = 4.5;
    },
  },
  {
    name: 'chosen',
    note: 'the proposed default: tackle, soft block, a screen that does not spill the ball, and a steal that has to be worked for',
    apply: (c) => {
      // Assembled from the parts each of which measured well on its own, then re-measured as a
      // whole — because "these three were fine separately" is not a measurement of the three.
      c.contest.tackle.enabled = true;
      c.contest.block.mode = 'speed';
      c.contest.collision.enabled = true;
      c.contest.collision.dropsBall = false;
      c.contest.collision.loudSpeed = 4.5;
      c.contest.steal.enabled = true;
      c.contest.steal.radius = 1;
      c.contest.steal.holdSec = 1;
      c.contest.steal.graceSec = 1.5;
    },
  },
  {
    name: 'tackle+hardsteal',
    note: 'tackle and soft block, plus a steal that has to be worked for: 1.0 m held for a full second',
    apply: (c) => {
      off(c);
      c.contest.tackle.enabled = true;
      c.contest.block.mode = 'speed';
      c.contest.steal.enabled = true;
      c.contest.steal.radius = 1;
      c.contest.steal.holdSec = 1;
      c.contest.steal.graceSec = 1.5;
    },
  },
  // --- the ping economy: is a rarer, stronger question a better one? ------------------------
  {
    name: 'ping-3s',
    note: 'a 3 s cooldown instead of 1.5: half as many questions, so each one has to be a decision',
    apply: (c) => {
      c.ping.cooldownSec = 3;
    },
  },
  {
    name: 'ping-4s-far',
    note: '4 s cooldown, and a ping that sees the whole pitch and lasts twice as long',
    apply: (c) => {
      c.ping.cooldownSec = 4;
      c.ping.range = 24;
      c.ping.lifeSec = 2;
    },
  },
  {
    name: 'ping-3s-far',
    note: '3 s cooldown with the longer, brighter snapshot',
    apply: (c) => {
      c.ping.cooldownSec = 3;
      c.ping.range = 24;
      c.ping.lifeSec = 2;
    },
  },
  {
    name: 'ping-cone',
    note: 'a 120° cone instead of 360°: a question you have to point',
    apply: (c) => {
      c.ping.cooldownSec = 2.5;
      c.ping.coneDeg = 120;
      c.ping.range = 24;
    },
  },
  {
    name: 'ball-hum-14',
    note: 'a LOOSE ball that only carries 14 m instead of the whole pitch — the last free fact, priced',
    apply: (c) => {
      c.loudness['ball-hum'] = 14;
    },
  },
  {
    name: 'ball-hum-9',
    note: 'a loose ball audible at 9 m: finding it becomes a search of its own',
    apply: (c) => {
      c.loudness['ball-hum'] = 9;
    },
  },
  {
    name: 'all-fastthrow',
    note: 'everything on, but back to the old 22 m/s release and 3 m goal',
    apply: (c) => {
      // The control row for the numbers the concept revised and the config had never followed.
      // A 22 m/s release covers eight metres in 0.36 s, which is below anybody's reaction time,
      // so it is worth knowing what the rest of the table looks like when a shot cannot be
      // contested at all.
      c.throwing.maxSpeed = 22;
      c.field.goalWidth = 3;
    },
  },
  {
    name: 'all-nocol',
    note: 'everything except body contact — bodies still pass through each other',
    apply: (c) => {
      c.contest.collision.enabled = false;
    },
  },
];

// --- the handicaps used by the tests ----------------------------------------

/** The literal reading of the concept's first test: perfect localisation of what you can hear. */
const TRUTH: Partial<PerceptionConfig> = { truthLeak: 1 };

/**
 * The strong reading: hears everything wherever it happens, locates it perfectly, and knows who
 * made it. Still not literal telepathy — a body that makes no sound is still invisible, because
 * there is no channel in this game through which silence could be heard.
 */
const OMNI: Partial<PerceptionConfig> = {
  truthLeak: 1,
  hearingScale: 8,
  localizationSigmaPerMeter: 0,
  localizationBearingDeg: 0,
  anonymousSources: false,
  emitterNoiseSmoothing: 0,
  // Actual telepathy, ten times a second. Without it the "omniscient" side still cannot see a
  // body that is standing still and saying nothing — which is most of what this game hides.
  xrayHz: 10,
};

// --- one job ----------------------------------------------------------------

interface Job {
  variant: string;
  /** 'truth' and 'omni' are the telepathy tests, 'ping' the ping test, 'play' the playability run. */
  test: 'truth' | 'omni' | 'ping' | 'play';
  seed: number;
  /** true = the advantaged side plays as team 1 instead of team 0. */
  swap: boolean;
  secs: number;
  /** Players per team. Defaults to 2×2; `--team 3` runs the same tournament at 3×3. */
  team: number;
}

interface JobResult extends Job {
  /** Goals per minute scored by the ADVANTAGED side, and by the plain one. */
  strong: number;
  weak: number;
  /**
   * Possession share of each side.
   *
   * Goals per minute is the metric that matters and the metric that is far too noisy to iterate
   * on: five goals a match, Poisson-shaped, means a difference of half a goal a minute needs a
   * hundred matches to see. Possession is measured every tick of every match, so it settles in
   * a handful of seeds — and in a game whose entire subject is taking the ball off somebody, it
   * is not a proxy for strength so much as a second reading of it.
   */
  strongPoss: number;
  weakPoss: number;
  stats: MatchStats;
}

function buildConfig(job: Job): { config: SimConfig; a: string; b: string } {
  const variant = VARIANTS.find((v) => v.name === job.variant);
  if (!variant) throw new Error(`unknown variant: ${job.variant}`);
  const config = cloneConfig(defaultConfig());
  variant.apply(config);
  config.teamSize = job.team;
  // Fixed length, never "first to N": a race to five goals turns the scoreline into a clock.
  config.match.durationSec = job.secs;
  config.match.goalsToWin = 1e9;
  config.match.kickoffTeam = 'alternate';
  const strongTeam = job.swap ? 1 : 0;
  let a = 'bot';
  let b = 'bot';
  if (job.test === 'truth' || job.test === 'omni') {
    const over = job.test === 'truth' ? TRUTH : OMNI;
    config.perceptionByTeam = [null, null];
    config.perceptionByTeam[strongTeam] = { ...over };
  } else if (job.test === 'ping') {
    // The weak side is the one that may not ask.
    if (strongTeam === 0) b = 'bot-mute';
    else a = 'bot-mute';
  }
  return { config, a, b };
}

function runJob(job: Job): JobResult {
  const { config, a, b } = buildConfig(job);
  const match = new Match({ config, seed: job.seed, controllers: roster(a, b, config.teamSize) });
  const res = match.run();
  const dur = Math.max(1e-6, res.stats.duration) / 60;
  const strongTeam = job.swap ? 1 : 0;
  const share = (team: number): number => {
    let ticks = 0;
    let held = 0;
    for (const p of res.stats.players) {
      if (p.team !== team) continue;
      ticks = Math.max(ticks, p.ticks);
      held += p.possessionTicks;
    }
    return ticks > 0 ? held / ticks : 0;
  };
  return {
    ...job,
    strong: res.stats.score[strongTeam]! / dur,
    weak: res.stats.score[strongTeam === 0 ? 1 : 0]! / dur,
    strongPoss: share(strongTeam),
    weakPoss: share(strongTeam === 0 ? 1 : 0),
    stats: res.stats,
  };
}

// --- worker mode ------------------------------------------------------------

if (process.env.CONTEST_WORKER === '1') {
  process.on('message', (msg) => {
    const jobs = msg as Job[];
    const out = jobs.map(runJob);
    process.send?.(out);
  });
} else {
  await main();
}

// --- the driver -------------------------------------------------------------

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

/** Runs the jobs across N processes. The bot costs ~0.4 ms a tick; a tournament is minutes. */
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
            env: { ...process.env, CONTEST_WORKER: '1' },
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

interface Row {
  variant: string;
  note: string;
  truthEdge: number;
  truthPoss: number;
  omniEdge: number;
  omniPoss: number;
  pingEdge: number;
  pingPoss: number;
  pingRate: number;
  silent: number;
  goalsPerMin: number;
  turnoversPerMin: number;
  fumblesPerMin: number;
  stealsPerMin: number;
  tacklesPerMin: number;
  score: string;
}

function summarise(variant: string, note: string, results: JobResult[]): Row {
  const pick = (test: Job['test']) => results.filter((r) => r.test === test);
  const edge = (test: Job['test']): number => {
    const rs = pick(test);
    if (rs.length === 0) return 0;
    return rs.reduce((s, r) => s + (r.strong - r.weak), 0) / rs.length;
  };
  const possEdge = (test: Job['test']): number => {
    const rs = pick(test);
    if (rs.length === 0) return 0;
    return rs.reduce((s, r) => s + (r.strongPoss - r.weakPoss), 0) / rs.length;
  };
  const play = pick('play');
  const stats = play.map((r) => r.stats);
  const agg = aggregate(stats);
  const mins = Math.max(1e-6, agg.duration) / 60;
  const sum = (f: (p: (typeof agg.players)[number]) => number) => agg.players.reduce((s, p) => s + f(p), 0);
  // The ping rate that counts is the one the bot chooses on its own, in a plain match.
  return {
    variant,
    note,
    truthEdge: edge('truth'),
    truthPoss: possEdge('truth'),
    omniEdge: edge('omni'),
    omniPoss: possEdge('omni'),
    pingEdge: edge('ping'),
    pingPoss: possEdge('ping'),
    pingRate: sum((p) => p.pingsPerMinute),
    silent: agg.players.length ? sum((p) => p.silentShare) / agg.players.length : 0,
    goalsPerMin: (agg.score[0] + agg.score[1]) / mins,
    turnoversPerMin: agg.possessionChanges / mins,
    fumblesPerMin: sum((p) => p.fumbles) / mins,
    stealsPerMin: sum((p) => p.steals) / mins,
    tacklesPerMin: sum((p) => p.tackles) / mins,
    score: `${agg.score[0].toFixed(1)}:${agg.score[1].toFixed(1)}`,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true') {
    console.log(
      'usage: npm run contest -- [--only a,b] [--seeds 1-8] [--secs 90] [--workers 4] [--json]\n' +
        `variants: ${VARIANTS.map((v) => v.name).join(', ')}`,
    );
    process.exit(0);
  }
  const only = args.only ? args.only.split(',').map((s) => s.trim()) : null;
  const variants = VARIANTS.filter((v) => !only || only.includes(v.name));
  const seeds = parseSeeds(args.seeds ?? '1-8');
  const secs = Number(args.secs ?? 90);
  const team = Number(args.team ?? 2);
  const tests: Job['test'][] = (args.tests ?? 'truth,omni,ping,play').split(',') as Job['test'][];
  const workers = Number(args.workers ?? Math.max(1, Math.min(cpus().length, 8)));

  const jobs: Job[] = [];
  for (const v of variants) {
    for (const test of tests) {
      for (const seed of seeds) {
        // Both role assignments, always: the kickoff is worth real goals and it must not land
        // on the same side as the advantage.
        jobs.push({ variant: v.name, test, seed, swap: false, secs, team });
        if (test !== 'play') jobs.push({ variant: v.name, test, seed, swap: true, secs, team });
      }
    }
  }

  const t0 = process.hrtime.bigint();
  const results = await runAll(jobs, workers);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const ticks = results.reduce((s, r) => s + r.stats.ticks, 0);

  const rows = variants.map((v) =>
    summarise(v.name, v.note, results.filter((r) => r.variant === v.name)),
  );

  if (args.json === 'true') {
    console.log(JSON.stringify({ seeds, secs, rows }, null, 2));
    process.exit(0);
  }

  const head = ['variant', 'truth Δg', 'truth Δp', 'omni Δg', 'omni Δp', 'ping Δg', 'ping Δp', 'ping/min', 'silent%', 'goals/min', 'turnov/min', 'fumbl/min', 'steal/min', 'tackl/min'];
  const body = rows.map((r) => [
    r.variant,
    r.truthEdge.toFixed(2),
    (r.truthPoss * 100).toFixed(1),
    r.omniEdge.toFixed(2),
    (r.omniPoss * 100).toFixed(1),
    r.pingEdge.toFixed(2),
    (r.pingPoss * 100).toFixed(1),
    r.pingRate.toFixed(2),
    (r.silent * 100).toFixed(0),
    r.goalsPerMin.toFixed(2),
    r.turnoversPerMin.toFixed(1),
    r.fumblesPerMin.toFixed(1),
    r.stealsPerMin.toFixed(1),
    r.tacklesPerMin.toFixed(1),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i]!)).join('  ');
  console.log(
    `\nrule tournament — ${seeds.length} seeds × ${secs}s, both sides swapped.\n` +
      `Δg = the advantaged side's goals per minute minus the plain side's.\n` +
      `Δp = the same in possession share, percentage points — the same question asked with a\n` +
      `hundred times less noise, because it is sampled every tick instead of every goal.\n`,
  );
  console.log(line(head));
  for (const b of body) console.log(line(b));
  console.log('\nnotes:');
  for (const r of rows) console.log(`  ${r.variant.padEnd(13)} ${r.note}`);
  console.log(
    `\n${results.length} matches, ${ticks} ticks in ${(ms / 1000).toFixed(1)} s ` +
      `(${((ticks / ms) * 1000).toFixed(0)} ticks/s across ${workers} workers)`,
  );
}
