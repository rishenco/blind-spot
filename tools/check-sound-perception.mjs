import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const html = resolve(process.argv[2] ?? 'dist/index.html');
if (!existsSync(html)) { console.error('[sound-perception] build not found'); process.exit(2); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`[sound-perception] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && ` — ${detail}`}`);
  if (!ok) failures.push(name);
};
const call = (path, ...args) => page.evaluate(([p, a]) => {
  let x = window.bs;
  const bits = p.split('.');
  while (bits.length > 1) x = x[bits.shift()];
  return x[bits[0]](...a);
}, [path, args]);
const step = (seconds) => page.evaluate((s) => {
  for (let i = 0; i < Math.round(s * 120); i++) window.bs.step(1 / 120);
  window.bs.draw();
}, seconds);

await page.goto(`${pathToFileURL(html).href}?harness=1&seed=20260826`);
await page.waitForFunction(() => window.bs !== undefined);
await call('audio', false);
await call('spiders.spawn', 0);
await call('pose', 0, 0, 0);
await step(1 / 120); // updates the tactical ear to the posed render camera

const eye = (await call('stats')).eye;
const EVENT_Y = 0.2; // `spiders.noise`, identical to a real floor spider's event height
const horizontalAtDistance = (distance) => Math.sqrt(Math.max(0, distance ** 2 - (eye[1] - EVENT_Y) ** 2));
const probe = async (distance3d, loudness, kind) => {
  await call('clear');
  const accepted = await call('spiders.perception', horizontalAtDistance(distance3d), 0, loudness, kind);
  await step(1 / 120);
  const stats = await call('stats');
  return { ...accepted, marks: stats.marks.alive, rejected: stats.marks.outOfRange };
};

// Floor footsteps are the reported regression: their 1.6 m sound used to paint a guaranteed
// 22 px red mark from the other end of the hall. Mixer, marker and compass share the mixer's
// existing 1.2x final inverse-rolloff margin, hence a 1.92 m three-dimensional boundary.
const stepNear = await probe(1.91, 1.6, 'step');
const stepFar = await probe(1.93, 1.6, 'step');
check('near spider footfall is admitted by all three sinks',
  stepNear.audio && stepNear.marker && stepNear.compass && stepNear.marks === 1,
  `1.91m: ${JSON.stringify(stepNear)}`);
check('footfall beyond the shared boundary is rejected by all three',
  !stepFar.audio && !stepFar.marker && !stepFar.compass && stepFar.rejected === 1,
  `1.93m: ${JSON.stringify(stepFar)}`);

// Chatter's deliberate 2.6x carry is part of that same contract, not private audio knowledge:
// 12m loudness * 1.2 margin * 2.6 carry = 37.44m for every player perception sink.
const talkNear = await probe(37.43, 12, 'chatter');
const talkFar = await probe(37.45, 12, 'chatter');
const talkDistant = await probe(50, 12, 'chatter');
check('audible long-range chatter is admitted by audio, marker and compass',
  talkNear.audio && talkNear.marker && talkNear.compass && talkNear.marks === 1,
  `37.43m: ${JSON.stringify(talkNear)}`);
check('chatter boundary is identical for all three sinks',
  !talkFar.audio && !talkFar.marker && !talkFar.compass && talkFar.rejected === 1,
  `37.45m: ${JSON.stringify(talkFar)}`);
check('distant chatter remains wholly unknown',
  !talkDistant.audio && !talkDistant.marker && !talkDistant.compass && talkDistant.rejected === 1,
  `50.00m: ${JSON.stringify(talkDistant)}`);

const perf = await page.evaluate(() => {
  const t0 = performance.now();
  for (let i = 0; i < 100000; i++) {
    window.bs.spiders.noise('spider', 40 + (i % 3), 0, 1.6);
  }
  return performance.now() - t0;
});
check('range rejection stays constant-time', perf < 250, `${(perf / 100000 * 1000).toFixed(3)} µs/event, ${perf.toFixed(1)} ms total`);

await browser.close();
if (failures.length) process.exit(1);
