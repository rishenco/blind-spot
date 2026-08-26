/**
 * Text-only regression for weak-sound attention. It deliberately takes no PNG: the evidence is
 * state and distance, and rendering would only make this check slower and noisier.
 *
 * One company hears the real floor-radio, verifies it, shares the negative result, and spreads into an
 * 8–14 m search. Repeating that weak source cannot pull it back during the 18 s memory; a
 * gunshot and a loud impact at the same point both immediately restore it as a lead.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
if (!existsSync(htmlPath)) {
  console.error('[spider-attention] build not found (run `npm run build` first)');
  process.exit(2);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const failures = [];
const check = (label, ok, detail) => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`;
  console.log(`[spider-attention] ${line}`);
  if (!ok) failures.push(line);
};
const call = (fn, ...args) => page.evaluate(
  ([f, a]) => {
    const path = f.split('.');
    let obj = window.bs;
    while (path.length > 1) obj = obj[path.shift()];
    return obj[path[0]](...a);
  },
  [fn, args],
);
const advance = (seconds) => page.evaluate((sec) => {
  const n = Math.round(sec * 120);
  for (let i = 0; i < n; i++) window.bs.step(1 / 120);
}, seconds);
const boot = async () => {
  await page.goto(`${pathToFileURL(htmlPath).href}?harness=1&seed=20260826`);
  await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 30_000 });
  await call('audio', false);
};

try {
  await boot();

  // The actual complaint: untouched round, real generated spawn, real floor-radio, no probe and
  // no staging. At least one company must physically verify the central transmitter within the
  // first half-minute; otherwise a perfect close-range unit test is meaningless to the player.
  const idleRound = await page.evaluate(() => {
    let peakIgnore = 0;
    let peakSearch = 0;
    for (let i = 0; i < 35 * 120; i++) {
      window.bs.step(1 / 120);
      const list = window.bs.spiders.list();
      for (const z of window.bs.spiders.zones()) peakIgnore = Math.max(peakIgnore, z.remaining);
      peakSearch = Math.max(peakSearch, list.filter((s) => s.state === 'search').length);
    }
    return {
      zones: window.bs.spiders.zones(),
      list: window.bs.spiders.list(),
      radio: window.bs.stats().sound.bySource.radio ?? 0,
      peakIgnore,
      peakSearch,
    };
  });
  check(
    'idle generated round reaches and checks the real floor radio',
    idleRound.zones.length > 0 && idleRound.peakIgnore > 17.5 && idleRound.peakSearch > 0,
    `${idleRound.radio} pings; peak ignore ${idleRound.peakIgnore.toFixed(1)}s, peak search ${idleRound.peakSearch}; ` +
      `zones ${idleRound.zones.map((z) => `pack@${z.x.toFixed(1)},${z.z.toFixed(1)} ${z.remaining.toFixed(1)}s`).join(' | ') || 'none'}; ` +
      `states ${idleRound.list.map((s) => `${s.id}:${s.state}:${s.toBelief.toFixed(1)}`).join(' ')}`,
  );

  // Quiet territorial search: a fixed, cluttered rectangle with the player silent and out of
  // smell range. The floor radio is carried-but-off here only to isolate the zero-information
  // case; all cells still come from the real StaticWorld collision checks.
  await call('spiders.searchRegion', -12, 12, -10, 10);
  await call('spiders.spawn', 14);
  await call('pose', -30, -20, 0);
  await call('radio.setCarried', true);
  await advance(60);
  const quietCoverage = await call('spiders.coverage');
  const quietStates = await call('spiders.list');
  check(
    'silent pack meaningfully covers the reachable cluttered search region',
    quietCoverage.fraction >= 0.8,
    `${quietCoverage.covered}/${quietCoverage.walkable} = ${(quietCoverage.fraction * 100).toFixed(1)}%; ` +
      `${quietStates.filter((s) => s.state === 'search').length}/14 still searching`,
  );
  const quietPerf = await page.evaluate(() => {
    const samples = [];
    for (let i = 0; i < 600; i++) {
      window.bs.step(1 / 120);
      samples.push(window.bs.spiders.stats().updateMs);
    }
    samples.sort((a, b) => a - b);
    return { mean: samples.reduce((a, b) => a + b, 0) / samples.length, p95: samples[Math.floor(samples.length * 0.95)] };
  });
  console.log(`[spider-attention] quiet-search cost mean ${quietPerf.mean.toFixed(3)} ms, p95 ${quietPerf.p95.toFixed(3)} ms (14 spiders)`);
  await call('spiders.searchRegion', -30, 30, -20, 20);

  // The nose is the only sense silence cannot defeat. These are free, fixed floor cells in the
  // same generated clutter; the player never takes a step. A majority must be physically found
  // by a spider entering the two-metre smell radius, not by an injected belief.
  const smellTargets = [[-8.5, -6.5], [4.5, 7.5], [10.5, -4.5]];
  let smelled = 0;
  const smellDetails = [];
  for (const [x, z] of smellTargets) {
    await boot();
    await call('spiders.searchRegion', -12, 12, -10, 10);
    await call('pose', x, z, 0);
    await call('radio.setCarried', true);
    await call('vitals.health', 100);
    await call('spiders.spawn', 14);
    await advance(60);
    const vitals = await call('vitals.state');
    const hit = vitals.bites > 0;
    if (hit) smelled++;
    smellDetails.push(`${x},${z}:${hit ? 'smell' : 'miss'}`);
  }
  check(
    'silent player is physically found through the 2 m smell radius',
    smelled >= 2,
    `${smelled}/${smellTargets.length} fixed free positions — ${smellDetails.join(' · ')}`,
  );

  // Exact hearing boundary for an ordinary walking step. The probe is the real SoundBus event
  // shape emitted by PlayerController; only its deterministic timing is bypassed.
  const stepHear = async (distance) => {
    await boot();
    await call('pose', distance, 0, 0);
    await call('radio.setCarried', true);
    await call('spiders.spawn', 1);
    await call('spiders.place', 0, 0, 0);
    const before = (await call('spiders.list'))[0];
    await call('spiders.noise', 'player-step', before.x + distance, before.z, 9);
    await advance(0.1);
    return (await call('spiders.list'))[0];
  };
  const step49 = await stepHear(4.9);
  const step51 = await stepHear(5.1);
  check('ordinary player step is heard at 4.9 m and not at 5.1 m',
    step49.belief.confidence > 0.1 && step51.belief.confidence === 0,
    `4.9 m p${step49.belief.confidence.toFixed(2)}; 5.1 m p${step51.belief.confidence.toFixed(2)}`,
  );

  await boot();
  await call('radio.tune', { pingInterval: 0.2, groundLoudness: 12 });
  await call('spiders.tune', { groups: 1, decisionHz: 120, speedStalk: 4.2, speedCreep: 3.2 });
  await call('spiders.spawn', 4);
  await call('pose', -30, -20, 0);

  // A close, deterministic company makes the test about memory rather than path-finding luck.
  for (const [i, x, z] of [[0, -5, 0], [1, 5, 0], [2, 0, -6], [3, 0, 6]]) {
    const placed = await call('spiders.place', i, x, z);
    check(`place #${i}`, placed, `${x}, ${z}`);
  }

  // No injected radio event here: this is the actual ground unit's update path and cadence.
  await advance(3.2);
  const radioEvents = (await call('stats')).sound.bySource.radio ?? 0;
  const checked = await call('spiders.list');
  const ignored = checked.filter((s) => s.ignoreFor > 15);
  const spread = checked.map((s) => Math.hypot(s.goalX, s.goalZ));
  check(
    'the real floor radio supplied the weak evidence',
    radioEvents >= 8,
    `${radioEvents} floor-radio pings through Radio.update → SoundBus → Swarm.hear`,
  );
  check(
    'one verified weak source informs the whole company',
    ignored.length === 4,
    `${ignored.length}/4 remember it for ${checked.map((s) => s.ignoreFor.toFixed(1)).join(', ')} s`,
  );
  check(
    'post-check search fans beyond the empty point',
    spread.every((d) => d > 2.5) && new Set(checked.map((s) => `${s.goalX.toFixed(0)},${s.goalZ.toFixed(0)}`)).size >= 3,
    `goal radii ${spread.map((d) => d.toFixed(1)).join(', ')} m`,
  );

  await advance(0.5); // several actual floor-radio pings while the conclusion is live
  const repeated = await call('spiders.list');
  check(
    'repeated weak source does not override the shared memory',
    repeated.every((s) => s.ignoreFor > 14 && s.belief.confidence < 0.1) &&
      repeated.some((s) => s.heard.includes('checked, ignored')),
    repeated.map((s) => `#${s.id} p${s.belief.confidence.toFixed(2)} ignore ${s.ignoreFor.toFixed(1)} ${s.heard}`).join(' | '),
  );

  await call('spiders.noise', 'gunshot', 0, 0, 90);
  await advance(0.1);
  const shot = await call('spiders.list');
  check(
    'gunshot immediately overrides the old conclusion',
    shot.every((s) => s.ignoreFor === 0 && s.belief.source === 'gunshot' && s.belief.confidence > 0.1),
    shot.map((s) => `#${s.id} ${s.belief.source} p${s.belief.confidence.toFixed(2)}`).join(' | '),
  );

  // Re-establish a checked weak source, then prove a real collapse can do the same override.
  await call('spiders.spawn', 4);
  for (const [i, x, z] of [[0, -5, 0], [1, 5, 0], [2, 0, -6], [3, 0, 6]]) await call('spiders.place', i, x, z);
  await call('spiders.noise', 'radio', 0, 0, 12);
  await advance(3.2);
  await call('spiders.noise', 'prop-impact', 0, 0, 28);
  await advance(0.1);
  const collapse = await call('spiders.list');
  check(
    'loud collapse immediately overrides the old conclusion',
    collapse.every((s) => s.ignoreFor === 0 && s.belief.source === 'prop-impact' && s.belief.confidence > 0.1),
    collapse.map((s) => `#${s.id} ${s.belief.source} p${s.belief.confidence.toFixed(2)}`).join(' | '),
  );

  const perf = await page.evaluate(() => {
    const samples = [];
    for (let i = 0; i < 240; i++) {
      window.bs.step(1 / 120);
      samples.push(window.bs.spiders.stats().updateMs);
    }
    samples.sort((a, b) => a - b);
    return { mean: samples.reduce((a, b) => a + b, 0) / samples.length, p95: samples[Math.floor(samples.length * 0.95)] };
  });
  console.log(`[spider-attention] cost mean ${perf.mean.toFixed(3)} ms, p95 ${perf.p95.toFixed(3)} ms (4 spiders)`);
} finally {
  await browser.close();
}

if (failures.length > 0) process.exitCode = 1;
