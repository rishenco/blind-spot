/**
 * Headless batch runner — the strength meter.
 *
 * Runs M matches of one strategy pairing over a list of seeds with no renderer at all, and
 * prints the table the AI brief asks for: goals, possession, interceptions, fumbles, ping rate,
 * silent share and mean distance to the ball. Nothing here is AI-specific; when the real bot
 * lands it registers a name and appears in this table next to the dummies.
 *
 *   npm run batch -- --a striker --b goalie --seeds 1-50
 *   npm run batch -- --a striker --b statue --seeds 1-20 --config sprint --json
 */
import { configFromPreset } from '../config';
import { CONTROLLERS, makeController } from '../controllers';
import { Match } from '../match';
import { aggregate, summarise, type MatchStats } from '../stats';

declare const process: {
  argv: string[];
  exit(code?: number): never;
  hrtime: { bigint(): bigint };
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = 'true';
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** "1-50", "1,4,9" or "7" — whatever is least annoying to type. */
function parseSeeds(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const range = part.match(/^(-?\d+)\s*(?:-|\.\.)\s*(-?\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let s = from; s <= to; s++) out.push(s);
    } else if (part.trim() !== '') out.push(Number(part));
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help === 'true') {
  console.log(
    'usage: npm run batch -- --a <strategy> --b <strategy> [--seeds 1-20] [--config default]\n' +
      `       [--teamSize N] [--json] [--per-match]\nstrategies: ${Object.keys(CONTROLLERS).join(', ')}`,
  );
  process.exit(0);
}

const aName = args.a ?? 'striker';
const bName = args.b ?? 'goalie';
const seeds = parseSeeds(args.seeds ?? '1-20');
const config = configFromPreset(args.config ?? 'default');
if (args.teamSize) config.teamSize = Number(args.teamSize);
// Batch runs are about numbers, not pictures: no event log, no timeline weight.
const results: MatchStats[] = [];

const t0 = process.hrtime.bigint();
let ticks = 0;
for (const seed of seeds) {
  const controllers = [
    ...Array.from({ length: config.teamSize }, () => makeController(aName)),
    ...Array.from({ length: config.teamSize }, () => makeController(bName)),
  ];
  const match = new Match({ config, seed, controllers });
  const res = match.run();
  ticks += res.stats.ticks;
  results.push(res.stats);
}
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

if (args.json === 'true') {
  console.log(JSON.stringify({ a: aName, b: bName, seeds, results }, null, 2));
  process.exit(0);
}

const wins = [0, 0, 0]; // team0, team1, draw
for (const r of results) {
  if (r.score[0] > r.score[1]) wins[0]!++;
  else if (r.score[1] > r.score[0]) wins[1]!++;
  else wins[2]!++;
}

const agg = aggregate(results);
console.log(
  `\n${aName} (team 0) vs ${bName} (team 1) — ${results.length} matches, ${config.teamSize}v${config.teamSize}, ` +
    `preset ${args.config ?? 'default'}`,
);
console.log(
  `score ${agg.score[0].toFixed(2)} : ${agg.score[1].toFixed(2)}   ` +
    `wins ${wins[0]}/${wins[1]} (${wins[2]} draws)   ` +
    `mean match ${(results.reduce((s, r) => s + r.duration, 0) / results.length).toFixed(1)} s`,
);

const head = [
  'player', 'ctrl', 'goals', 'poss%', 'catch', 'intcp', 'fumbl', 'throw', 'ping/min', 'silent%', 'ball d', 'run m',
];
const rows = agg.players.map((p) => [
  `P${p.id} (t${p.team})`,
  p.controller,
  p.goals.toFixed(2),
  (p.possessionShare * 100).toFixed(1),
  p.catches.toFixed(2),
  p.interceptions.toFixed(2),
  p.fumbles.toFixed(2),
  p.throws.toFixed(2),
  p.pingsPerMinute.toFixed(1),
  (p.silentShare * 100).toFixed(1),
  p.avgDistanceToBall.toFixed(2),
  p.distanceRun.toFixed(0),
]);
const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i]!)).join('  ');
console.log(line(head));
for (const r of rows) console.log(line(r));

if (args['per-match'] === 'true') {
  console.log('\nper match:');
  for (const r of results) {
    const s = summarise(r);
    console.log(
      `  seed ${String(r.seed).padStart(6)}  ${r.score[0]}:${r.score[1]}  ${r.duration.toFixed(1)}s  ` +
        `pings ${s.reduce((acc, p) => acc + p.pings, 0)}  fumbles ${s.reduce((acc, p) => acc + p.fumbles, 0)}`,
    );
  }
}

console.log(
  `\n${results.length} matches, ${ticks} ticks in ${elapsedMs.toFixed(0)} ms ` +
    `(${((ticks / elapsedMs) * 1000).toFixed(0)} ticks/s, ${(elapsedMs / results.length).toFixed(1)} ms/match)`,
);
