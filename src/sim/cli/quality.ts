/**
 * One question, asked properly: does cutting the bot's candidate list make it stronger?
 *
 * The previous report found that `decisionQuality = 0.25` — which *removes* options — beat the
 * full search, and that is a statement about calibration, not about difficulty: if throwing away
 * the tail helps, the tail is scoring higher than it is worth. This runner plays each setting
 * against the full-search bot over a list of seeds, both sides swapped, and prints the margin.
 *
 *   npm run quality -- --seeds 1-16 --grid 0.25,0.5,0.75,1
 */
import { configFromPreset } from '../config';
import { roster } from '../controllers';
import { Match } from '../match';

declare const process: { argv: string[]; exit(code?: number): never };

const args: Record<string, string> = {};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith('--') ? next : 'true';
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

const seeds = parseSeeds(args.seeds ?? '1-8');
const secs = Number(args.secs ?? 90);
const grid = (args.grid ?? '0.25,0.5,1').split(',').map(Number);

console.log(`\ncandidate-list width against the full search — ${seeds.length} seeds × ${secs}s, swapped\n`);
console.log(['quality', 'Δgoals/min', 'Δposs%', 'pings/min'].map((h) => h.padStart(11)).join('  '));

for (const q of grid) {
  let dg = 0;
  let dp = 0;
  let pings = 0;
  let n = 0;
  for (const seed of seeds) {
    for (const swap of [false, true]) {
      const config = configFromPreset('default');
      config.match.durationSec = secs;
      config.match.goalsToWin = 1e9;
      config.match.kickoffTeam = 'alternate';
      // Both sides are the same bot; only the width of the candidate list differs, and it is a
      // per-team knob for the length of this experiment.
      config.ai.decisionQuality = q;
      config.ai.decisionQualityTeam = swap ? 1 : 0;
      const match = new Match({ config, seed, controllers: roster('bot', 'bot', config.teamSize) });
      const res = match.run();
      const cut = swap ? 1 : 0;
      const full = cut === 0 ? 1 : 0;
      const mins = Math.max(1e-6, res.stats.duration) / 60;
      dg += (res.stats.score[cut]! - res.stats.score[full]!) / mins;
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
      dp += share(cut) - share(full);
      pings += res.stats.players.reduce((a, p) => a + (p.pings * 60) / Math.max(1e-6, res.stats.duration), 0);
      n++;
    }
  }
  console.log(
    [q.toFixed(2), (dg / n).toFixed(2), ((dp / n) * 100).toFixed(1), (pings / n).toFixed(2)]
      .map((c) => c.padStart(11))
      .join('  '),
  );
}
