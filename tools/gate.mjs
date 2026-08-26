/**
 * Numeric M7 exit check — deliberately no screenshots and no output directory.
 *
 * It proves the semantic boundary of the win condition: proximity and standing in the doorway
 * are insufficient; only moving from inside to outside through the generated aperture wins, and
 * it still requires carrying the radio.
 *
 *   node tools/gate.mjs [dist/index.html]
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
if (!existsSync(htmlPath)) {
  console.error('[gate] build not found (run `npm run build` first)');
  process.exit(2);
}

const failures = [];
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(`[gate] ${line}`);
  if (!ok) failures.push(line);
};

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const preinstalled = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(preinstalled)) launchOptions.executablePath = preinstalled;
const browser = await chromium.launch(launchOptions);
const consoleErrors = [];
const walls = new Set();

// A single north-wall seed let an inverted east/west heading table stay green. Generate until
// every wall orientation has exercised the real controller and the real round state machine.
for (let seed = 1; seed <= 64 && walls.size < 4; seed++) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`seed ${seed}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`seed ${seed}: pageerror: ${e.message}`));
  await page.goto(`${pathToFileURL(htmlPath).href}?harness=1&seed=${seed}`);
  await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 30000 });

  const call = (fn, ...args) => page.evaluate(
    ([f, a]) => {
      const path = f.split('.');
      let obj = window.bs;
      while (path.length > 1) obj = obj[path.shift()];
      return obj[path[0]](...a);
    },
    [fn, args],
  );
  const advance = (seconds) => page.evaluate((s) => {
    for (let i = 0; i < Math.ceil(s * 120); i++) window.bs.step(1 / 120);
  }, seconds);

  await call('audio', false);
  await call('spiders.spawn', 0);
  const plan = await call('worldPlan');
  const gate = plan.gate;
  if (walls.has(gate.wall)) {
    await page.close();
    continue;
  }
  walls.add(gate.wall);

  // Camera convention: yaw 0 is north (-Z), -90 is east (+X).
  const yaw = { east: -90, west: 90, north: 0, south: 180 }[gate.wall];
  const moveOut = async (seconds = 0.9) => {
    await call('keys', ['KeyW'], []);
    await advance(seconds);
    await call('keys', [], ['KeyW']);
  };
  const detail = `seed=${seed}, wall=${gate.wall}, opening=${gate.opening.toFixed(1)}m`;

  // Gameplay obtains the radio by entering its real pickup radius, rather than by a harness flag.
  await call('pose', 0, 0, 0);
  await advance(1 / 60);
  check(`${gate.wall}: ground radio is actually picked up`, (await call('radio.state')).carried, detail);

  // The planned gate point is 1.25m inside. Walking toward the opening but remaining inside must
  // not award a win merely for proximity.
  await call('pose', gate.x, gate.z, yaw);
  await call('round.force', 'playing');
  await call('radio.setCarried', true);
  await moveOut(0.08);
  check(`${gate.wall}: approaching the opening does not win`, (await call('round.state')) === 'playing', detail);

  // Crossing the identical aperture empty-handed is also not a win.
  await call('pose', gate.x, gate.z, yaw);
  await call('round.force', 'playing');
  await moveOut();
  check(`${gate.wall}: crossing empty-handed does not win`, (await call('round.state')) === 'playing', detail);

  // Positive case: same controller path, carried state live before and after the segment.
  await call('pose', gate.x, gate.z, yaw);
  await call('round.force', 'playing');
  await call('radio.setCarried', true);
  const before = await call('stats');
  await moveOut();
  const after = await call('stats');
  check(
    `${gate.wall}: carrying the radio and crossing wins`,
    before.radio.carried && after.radio.carried && after.round === 'won',
    `${detail}, ${before.pos[0].toFixed(2)},${before.pos[2].toFixed(2)} → ${after.pos[0].toFixed(2)},${after.pos[2].toFixed(2)}`,
  );
  await page.close();
}

check('all four generated gate walls were exercised', walls.size === 4, [...walls].join(', '));

check('browser reported no errors', consoleErrors.length === 0, consoleErrors.join(' | '));
await browser.close();
if (failures.length > 0) process.exitCode = 1;
