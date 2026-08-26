import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const html = resolve(process.argv[2] ?? 'dist/index.html');
if (!existsSync(html)) { console.error('[finale] build not found'); process.exit(2); }
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const failures = [];
const check = (name, ok, detail = '') => { console.log(`[finale] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && ` — ${detail}`}`); if (!ok) failures.push(name); };
const call = (path, ...args) => page.evaluate(([p, a]) => {
  let x = window.bs; const bits = p.split('.'); while (bits.length > 1) x = x[bits.shift()]; return x[bits[0]](...a);
}, [path, args]);
const step = (seconds) => page.evaluate((s) => { for (let i = 0; i < Math.round(s * 120); i++) window.bs.step(1 / 120); window.bs.draw(); }, seconds);

await page.goto(`${pathToFileURL(html).href}?harness=1&seed=481516`);
await page.waitForFunction(() => window.bs !== undefined);
await call('audio', false);

await call('round.force', 'dead');
const dead0 = await call('round.finale');
await step(1.3);
const dead1 = await call('round.finale');
const audio1 = await call('stats');
check('death owns finale layer', dead0.state === 'dead');
check('death concussion ramps', dead1.concussion > dead0.concussion + 0.2, `${dead0.concussion.toFixed(2)} → ${dead1.concussion.toFixed(2)}`);
check('death elapsed is scene-time', dead1.elapsed > 1.2 && dead1.elapsed < 1.4, `${dead1.elapsed.toFixed(2)}s`);
check('death fades the scene mix', audio1.audio.sceneFade < 0.7, `${audio1.audio.sceneFade.toFixed(2)}`);

await page.goto(`${pathToFileURL(html).href}?harness=1&seed=20260825`);
await page.waitForFunction(() => window.bs !== undefined);
await call('audio', false);
await call('spiders.spawn', 0);
const plan = await call('worldPlan');
const yaw = { east: 90, west: -90, north: 0, south: 180 }[plan.gate.wall];
await call('pose', plan.gate.x, plan.gate.z, yaw);
await call('radio.setCarried', true);
await step(0.4);
await call('keys', ['KeyW'], []);
await step(0.9);
await call('keys', [], ['KeyW']);
const won = await call('round.finale');
const wonStats = await call('stats');
const wonRadio = await call('radio.state');
const oldUrl = await call('round.restartUrl', true);
const newUrl = await call('round.restartUrl', false);
check('real crossing of the generated gate reaches victory', won.state === 'won', `wall=${plan.gate.wall}`);
check('victory enables the WebGL tableau', won.tableau === true);
check('victory reports completion time', won.elapsed >= 0 && won.endedAt > 0);
check('victory mutes world voices', wonStats.audio.sceneFade === 0, `${wonStats.audio.sceneFade.toFixed(2)}`);
check('victory mutes the radio synth path', wonRadio.audioFade === 0, `${wonRadio.audioFade.toFixed(2)}`);
check('victory hides the first-person weapon', wonStats.gun.lit === false);
check('Enter gets a new seed URL', oldUrl !== newUrl, `${oldUrl} != ${newUrl}`);

await browser.close();
if (failures.length) process.exit(1);
