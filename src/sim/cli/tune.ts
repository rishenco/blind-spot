/**
 * Deterministic grid search over the bot's utility knobs.
 *
 * This is not learning and it is not a substitute for understanding the axes — it is the answer
 * the research pass gave to the one failure mode every utility system has: "tuning one weight
 * breaks three scenarios out of five". A dozen constants, a fixed grid, a fixed set of seeds, a
 * fixed opponent panel, and the whole thing is reproducible to the last goal.
 *
 *   npm run tune                       # the default grid
 *   npm run tune -- --seeds 1-8 --opponents striker,ballchaser,goalie
 *   npm run tune -- --grid shotTimeSpan=1.0,1.35,1.8 --grid infoMul=1,2.5
 *
 * The score is goal difference per match against the whole panel, summed. It is a blunt
 * instrument on purpose: readability is judged by the deception scenarios (`npm run deception`)
 * and by the keyframes, never by this table.
 */
import { configFromPreset, type SimConfig } from '../config';
import { makeController } from '../controllers';
import { Match } from '../match';

declare const process: { argv: string[]; exit(code?: number): never; hrtime: { bigint(): bigint } };

function parseArgs(argv: string[]): { flags: Record<string, string>; grids: string[] } {
  const flags: Record<string, string> = {};
  const grids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? 'true' : next;
    if (value !== 'true') i++;
    if (key === 'grid') grids.push(value);
    else flags[key] = value;
  }
  return { flags, grids };
}

const { flags, grids } = parseArgs(process.argv.slice(2));

const seeds = (flags.seeds ?? '1-6').split(',').flatMap((part) => {
  const m = part.match(/^(\d+)-(\d+)$/);
  if (!m) return [Number(part)];
  const out: number[] = [];
  for (let s = Number(m[1]); s <= Number(m[2]); s++) out.push(s);
  return out;
});
const opponents = (flags.opponents ?? 'striker,ballchaser,goalie,statue').split(',');

/** The default grid: the knobs that actually changed behaviour during development. */
const DEFAULT_GRID: Record<string, number[]> = {
  shotTimeSpan: [1, 1.35, 1.8],
  positionDiscount: [0.5, 0.7],
  infoMul: [1, 2.5],
};

const grid: Record<string, number[]> = grids.length > 0 ? {} : DEFAULT_GRID;
for (const spec of grids) {
  const [key, values] = spec.split('=');
  if (!key || !values) throw new Error(`bad --grid: ${spec} (want key=1,2,3)`);
  grid[key] = values.split(',').map(Number);
}

const keys = Object.keys(grid);
const combos: Record<string, number>[] = [{}];
for (const key of keys) {
  const next: Record<string, number>[] = [];
  for (const base of combos) for (const v of grid[key]!) next.push({ ...base, [key]: v });
  combos.length = 0;
  combos.push(...next);
}

function evaluate(overrides: Record<string, number>): { diff: number; per: string[] } {
  let total = 0;
  const per: string[] = [];
  for (const opponent of opponents) {
    let mine = 0;
    let theirs = 0;
    for (const seed of seeds) {
      const cfg: SimConfig = configFromPreset(flags.config ?? 'default');
      cfg.match.kickoffTeam = 'alternate';
      Object.assign(cfg.ai, overrides);
      const controllers = [
        makeController('bot'),
        makeController('bot'),
        makeController(opponent),
        makeController(opponent),
      ].slice(0, cfg.teamSize * 2);
      const res = new Match({ config: cfg, seed, controllers }).run();
      mine += res.stats.score[0];
      theirs += res.stats.score[1];
    }
    const n = seeds.length;
    total += (mine - theirs) / n;
    per.push(`${opponent} ${(mine / n).toFixed(2)}:${(theirs / n).toFixed(2)}`);
  }
  return { diff: total, per };
}

const t0 = process.hrtime.bigint();
const rows: { label: string; diff: number; per: string[] }[] = [];
for (const combo of combos) {
  const label = keys.map((k) => `${k}=${combo[k]}`).join(' ');
  const { diff, per } = evaluate(combo);
  rows.push({ label, diff, per });
  console.log(`${label.padEnd(52)} diff ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}   ${per.join('  ')}`);
}
rows.sort((a, b) => b.diff - a.diff);
console.log(`\nbest: ${rows[0]!.label}  (diff ${rows[0]!.diff.toFixed(2)})`);
console.log(
  `${combos.length} configs x ${opponents.length} opponents x ${seeds.length} seeds in ` +
    `${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(0)} s`,
);
