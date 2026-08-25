/**
 * Runs the deceivability suite and prints its numbers.
 *
 *   npm run deception
 *   npm run deception -- --only ai-feint
 *
 * Every row is a fixed seed and a scripted trick; every column is read out of the bot's own
 * belief. This is the report the AI brief asks for first — strength comes second, and a bot that
 * cannot be lied to has broken the game whatever the scoreline says.
 */
import { AI_SCENARIOS, MECHANIC_SCENARIOS, runPlain, runScenario, SCENARIO_AXES } from '../ai/scenarios';

declare const process: { argv: string[]; exit(code?: number): never };

const args: Record<string, string> = {};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith('--') ? next : 'true';
}

const only = args.only;
let failures = 0;

for (const s of AI_SCENARIOS) {
  if (s.suite === 'mechanic') continue;
  if (only && s.name !== only) continue;
  const axes = SCENARIO_AXES[s.name] ?? { tracked: 0, axis: { x: 1, y: 0 } };
  const { match, log } = runScenario(s, axes);
  const numbers = s.measure(match, log);
  console.log(`\n${s.name}  (seed ${s.seed}, ${log.t.length} ticks observed)`);
  console.log(`  ${s.note}`);
  console.log(`  expect: ${s.expect}`);
  console.log(
    `  ${Object.entries(numbers)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ')}`,
  );
  if (log.t.length === 0) {
    console.log('  FAIL: the observer produced no belief at all');
    failures++;
  }
}

// The mechanic suite. Different question, same file, because they share the scenario list, the
// playground dropdown and the keyframe generator — and a rule whose picture and whose number
// came from two different setups proves nothing.
console.log('\n--- mechanics: the fight for the ball ---');
for (const s of MECHANIC_SCENARIOS) {
  if (only && s.name !== only) continue;
  const { match, log } = runPlain(s);
  const numbers = s.measure(match, log);
  console.log(`\n${s.name}  (seed ${s.seed}, ${s.ticks} ticks)`);
  console.log(`  ${s.note}`);
  console.log(`  expect: ${s.expect}`);
  console.log(`  ${Object.entries(numbers).map(([k, v]) => `${k}=${v}`).join('  ')}`);
}

if (failures > 0) process.exit(1);
