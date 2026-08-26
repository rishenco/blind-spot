import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const started = performance.now();
const guard = setTimeout(() => {
  console.error('[prop-touch] FAIL exceeded 30 second guard');
  process.exit(2);
}, 30_000);

const dir = await mkdtemp(resolve('.tmp-prop-touch-'));
try {
  const outfile = resolve(dir, 'entry.mjs');
  await build({
    entryPoints: ['tools/lib/check-prop-touch-entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    external: ['@dimforge/rapier3d-compat'],
    logLevel: 'silent',
  });
  const module = await import(pathToFileURL(outfile).href);
  const matrix = await module.runThrowMatrix();
  const powerless = await module.runPowerlessRelease();
  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`[prop-touch] ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
    if (!ok) failures.push(name);
  };
  for (const r of matrix) {
    const s = r.stats;
    console.log(
      `[prop-touch] ${r.name.padEnd(12)} mass=${r.mass.toFixed(3)}kg span=${r.span.toFixed(3)}m` +
      ` carry=${r.carryable} dynamic=${r.dynamic} awake=${r.awake}` +
      ` contacts=${s.contacts} maxForce=${s.maxForce.toFixed(1)}N gates=` +
      `${s.rejectedForce}/${s.rejectedWeight}/${s.rejectedSpeed}/${s.rejectedGap}/${s.rejectedLoudness}` +
      ` events=${r.events.length}${r.events[0] ? ` loud=${r.events[0].loudness.toFixed(2)}m` : ''}`,
    );
    if (r.carryable) {
      check(`${r.name} wakes as a real Dynamic body`, r.dynamic && r.awake,
        `dynamic=${r.dynamic} awake=${r.awake}`);
      check(`${r.name} reaches contact-force processing`, r.stats.contacts > 0,
        `${r.stats.contacts} callback(s), max ${r.stats.maxForce.toFixed(1)}N`);
      check(`${r.name} emits a perceptible prop-impact`, r.events.length > 0 && r.events[0].loudness >= 0.6,
        `${r.events.length} event(s), ${r.events[0]?.loudness.toFixed(2) ?? '0.00'}m`);
    }
  }
  check('powerless near-floor release stays quiet', powerless.events === 0,
    `${powerless.events} events; contacts=${powerless.stats.contacts}, speed rejects=${powerless.stats.rejectedSpeed}`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(`[prop-touch] total ${(performance.now() - started).toFixed(1)}ms including focused bundle + Rapier init`);
clearTimeout(guard);
