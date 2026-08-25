/**
 * The silence check.
 *
 * The concept's first law of atmosphere is that an untouched hall makes no sound at all: a
 * thousand props leaning on each other must reach *zero* awake bodies and *zero* sound events,
 * not "almost none". This scenario proves it as a number, which is why it has no PNG — a black
 * frame cannot show the absence of a marker that would have been drawn a second ago.
 *
 * Two acts:
 *   1. untouched — the hall is stepped for N seconds with nobody moving. Expect 0 awake, 0 events.
 *   2. disturbed — a pile is shoved over, then left alone. Expect it to go quiet and fall asleep
 *      within a few seconds, and to stay that way.
 *
 *   node tools/quiet.mjs [dist/index.html]
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
if (!existsSync(htmlPath)) {
  console.error(`[quiet] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const PREINSTALLED = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(PREINSTALLED)) launchOptions.executablePath = PREINSTALLED;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(pathToFileURL(htmlPath).href);
await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 180000 });

const failures = [];
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(`[quiet] ${line}`);
  if (!ok) failures.push(line);
};

/** Steps `seconds` of simulation without drawing, sampling awake/events every 0.5 s. */
const soak = (seconds) =>
  page.evaluate((sec) => {
    const bs = window.bs;
    const before = bs.stats();
    const base = before.sound.emitted;
    const trace = [];
    let worstStep = 0;
    let stepSum = 0;
    let samples = 0;
    let quietAt = null;
    let sleepAt = null;
    const slice = 0.5;
    for (let i = 0; i < Math.round(sec / slice); i++) {
      const mark = bs.stats().sound.emitted;
      bs.step(slice);
      const s = bs.stats();
      const ms = s.props ? s.props.stepMs : 0;
      worstStep = Math.max(worstStep, ms);
      stepSum += ms;
      samples++;
      const awake = s.props ? s.props.awake : 0;
      const newEvents = s.sound.emitted - mark;
      trace.push({ t: +(slice * (i + 1)).toFixed(2), awake, newEvents });
      if (quietAt === null && newEvents === 0) quietAt = slice * (i + 1);
      if (quietAt !== null && newEvents > 0) quietAt = null;
      if (sleepAt === null && awake === 0) sleepAt = slice * (i + 1);
      if (sleepAt !== null && awake > 0) sleepAt = null;
    }
    const after = bs.stats();
    return {
      trace,
      events: after.sound.emitted - base,
      bySource: after.sound.bySource,
      awake: after.props ? after.props.awake : 0,
      bodies: after.props ? after.props.bodies : 0,
      rescued: after.props ? after.props.rescued : 0,
      avgStepMs: samples ? stepSum / samples : 0,
      worstStepMs: worstStep,
      quietAt,
      sleepAt,
    };
  }, seconds);

// --- act 1: the untouched hall ------------------------------------------------
const idle = await soak(30);
console.log(`[quiet] idle 30 s: awake=${idle.awake}/${idle.bodies} events=${idle.events} rescued=${idle.rescued}`);
console.log(`[quiet] idle step ms: avg=${idle.avgStepMs.toFixed(3)} worst=${idle.worstStepMs.toFixed(3)}`);
console.log(`[quiet] idle trace: ${idle.trace.map((r) => `${r.t}s:${r.awake}a/${r.newEvents}e`).join(' ')}`);
check('untouched hall emits no sound', idle.events === 0, `${idle.events} events`);
check('untouched hall is fully asleep', idle.awake === 0, `${idle.awake} awake of ${idle.bodies}`);

// --- act 2: shove a pile over, then leave it alone -----------------------------
const woke = await page.evaluate(() => {
  const bs = window.bs;
  // Aim at the densest cluster of props so the shove really is a collapsing pile.
  const list = bs.propList();
  let best = null;
  for (const [, x, y, z] of list) {
    if (y > 1.2) continue;
    let n = 0;
    for (const [, ox, oy, oz] of list) {
      if (Math.abs(oy - y) < 1.5 && Math.hypot(ox - x, oz - z) < 1.6) n++;
    }
    if (best === null || n > best.n) best = { n, x, y, z };
  }
  return { hit: bs.disturb(best.x, best.y + 0.2, best.z, 1.8, 3.0), where: best };
});
console.log(`[quiet] shoved ${woke.hit} bodies at (${woke.where.x.toFixed(1)}, ${woke.where.z.toFixed(1)}) — cluster of ${woke.where.n}`);

const spill = await soak(30);
console.log(`[quiet] after shove: awake=${spill.awake} events=${spill.events} quietAt=${spill.quietAt}s sleepAt=${spill.sleepAt}s`);
console.log(`[quiet] spill trace: ${spill.trace.map((r) => `${r.t}s:${r.awake}a/${r.newEvents}e`).join(' ')}`);
console.log(`[quiet] spill step ms: avg=${spill.avgStepMs.toFixed(3)} worst=${spill.worstStepMs.toFixed(3)}`);
check('a shove makes noise', spill.events > 0, `${spill.events} events`);
check('the spill settles back to silence', spill.awake === 0 && spill.quietAt !== null,
  `awake=${spill.awake} quietAt=${spill.quietAt}`);
check('the spill settles within 8 s', spill.sleepAt !== null && spill.sleepAt <= 8, `sleepAt=${spill.sleepAt}s`);

// --- act 3: and it stays quiet -------------------------------------------------
const after = await soak(15);
console.log(`[quiet] settled 15 s: awake=${after.awake} events=${after.events}`);
check('the hall stays silent afterwards', after.events === 0 && after.awake === 0,
  `${after.events} events, ${after.awake} awake`);

for (const e of errors) console.log(`[quiet] console: ${e}`);
await browser.close();
if (failures.length > 0) {
  console.error(`[quiet] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('[quiet] all checks passed');
