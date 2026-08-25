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
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.goto(`${pathToFileURL(htmlPath).href}?harness=1&seed=20260825`);
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
const gate = await call('worldPlan');
const yaw = { east: 90, west: -90, north: 0, south: 180 }[gate.gate.wall];
const moveOut = async () => {
  await call('keys', ['KeyW'], []);
  await advance(0.9);
  await call('keys', [], ['KeyW']);
};

// A player can stand at the interior threshold as long as needed; that is not an exit.
await call('pose', gate.gate.x, gate.gate.z, yaw);
await call('round.force', 'playing');
await call('radio.setCarried', true);
await advance(0.4);
check('standing in the generated doorway does not win', (await call('round.state')) === 'playing');

// Crossing the identical aperture empty-handed is also not a win.
await call('pose', gate.gate.x, gate.gate.z, yaw);
await call('round.force', 'playing');
await moveOut();
check('crossing empty-handed does not win', (await call('round.state')) === 'playing');

// The positive case must cross the wall plane in a movement tick; teleporting to the gate never
// exercises that condition.
await call('pose', gate.gate.x, gate.gate.z, yaw);
await call('round.force', 'playing');
await call('radio.setCarried', true);
await moveOut();
check(
  'carrying the radio and crossing the aperture wins',
  (await call('round.state')) === 'won',
  `wall=${gate.gate.wall}, opening=${gate.gate.opening.toFixed(1)}m`,
);

check('browser reported no errors', consoleErrors.length === 0, consoleErrors.join(' | '));
await browser.close();
if (failures.length > 0) process.exitCode = 1;
