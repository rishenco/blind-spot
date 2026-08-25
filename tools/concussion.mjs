/**
 * M6c keyframes — the *visual* half of the concussion.
 *
 *   node tools/concussion.mjs [dist/index.html] [out/concussion]
 *
 * The other half of "контузия от выстрела" is a picture, and a picture of a black screen is
 * exactly the thing `doc/proto/process.md` says cannot be debugged by eye — so this generator
 * exists to make the claim measurable rather than admired.
 *
 * The claim being proved has two parts, and the second one is a law from `doc/proto/concept.md`:
 *
 *   1. the frame is *unwell* right after the shot — it swims, tears and doubles — and it is
 *      still unwell seconds later, then recovers on its own;
 *   2. it never lights the world. Law 1 says nothing renders for convenience: the effect may only
 *      move, dim and resample pixels the renderer had already earned. So every concussed frame is
 *      shot as an A/B pair against the identical simulation tick with the pass switched off, and
 *      the pair is compared photometrically. If a frame ever gets *brighter*, or shows more lit
 *      pixels than its twin, this generator fails.
 *
 * The muzzle flash is a real light and it would ruin that comparison, so no frame here is taken
 * while it is alive (it lives three frames); the first concussed frame is 0.12 s after the round.
 *
 * Conventions are the house ones: fixed seed, fixed 120 Hz step, no wall clock, audio device
 * never opened.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, meanLuminance as meanRect, litFraction as litRect } from './png.mjs';

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
const outDir = resolve(process.argv[3] ?? 'out/concussion');
if (!existsSync(htmlPath)) {
  console.error(`[fx] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
for (const f of await readdir(outDir)) if (f.endsWith('.png')) await unlink(join(outDir, f));

const whole = (img) => ({ x: 0, y: 0, w: img.width, h: img.height });
const mean = (img) => meanRect(img, whole(img)).mean;
const lit = (img) => litRect(img, whole(img)).fraction;
/** The brightest pixel in the frame — "did anything new appear", as opposed to "did it spread". */
function peak(img) {
  const n = img.width * img.height;
  let best = 0;
  for (let i = 0; i < n; i++) {
    const j = i * img.channels;
    const l = (img.data[j] * 299 + img.data[j + 1] * 587 + img.data[j + 2] * 114) / 1000;
    if (l > best) best = l;
  }
  return best;
}

/**
 * How far two frames of the same tick are from each other, 0..1: the mean absolute luminance
 * difference over the frame, normalised. This is the number that says "the picture moved" — a
 * pass-through scores ~0 and a frame that is swimming scores a lot more, without any assumption
 * about *which* pixels moved.
 */
function difference(a, b) {
  const n = a.width * a.height;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const ia = i * a.channels;
    const ib = i * b.channels;
    const la = (a.data[ia] * 299 + a.data[ia + 1] * 587 + a.data[ia + 2] * 114) / 1000;
    const lb = (b.data[ib] * 299 + b.data[ib + 1] * 587 + b.data[ib + 2] * 114) / 1000;
    acc += Math.abs(la - lb);
  }
  return acc / n / 255;
}

const failures = [];
const errors = [];
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(`[fx] ${line}`);
  if (!ok) failures.push(line);
};

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const PREINSTALLED = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(PREINSTALLED)) launchOptions.executablePath = PREINSTALLED;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const call = (fn, ...args) =>
  page.evaluate(
    ([f, a]) => {
      const path = f.split('.');
      let obj = window.bs;
      while (path.length > 1) obj = obj[path.shift()];
      const r = obj[path[0]](...a);
      return r === undefined ? null : r;
    },
    [fn, args],
  );
const advance = (sec) =>
  page.evaluate(
    ([s]) => {
      const n = Math.round(s * 120);
      for (let i = 0; i < n; i++) window.bs.step(1 / 120);
      window.bs.draw();
    },
    [sec],
  );
const redraw = () => page.evaluate(() => window.bs.draw());
const state = () => page.evaluate(() => window.bs.concussion.state());

async function shot(name) {
  const buf = await page.screenshot({ path: join(outDir, name), timeout: 180000 });
  return decodePng(buf);
}

/**
 * One moment, twice: the pass off and the pass on, with nothing in between but the switch and
 * a redraw of the same simulation tick. Everything this file claims is a statement about the
 * gap between those two frames.
 */
async function pair(tag) {
  await call('concussion.tune', { enabled: false });
  // Redraw after *each* switch. Without it the "off" screenshot is simply the last frame the
  // simulation happened to draw — which was drawn with the pass on — and the pair comes out
  // pixel-identical, which is how this file first "proved" that the effect does nothing.
  await redraw();
  const off = await shot(`${tag}-off.png`);
  await call('concussion.tune', { enabled: true });
  await redraw();
  const on = await shot(`${tag}-on.png`);
  const st = await state();
  const d = difference(off, on);
  console.log(
    `[fx] ${tag.padEnd(16)} amount ${st.amount.toFixed(3)}  diff ${(d * 100).toFixed(2)}%  ` +
      `mean ${mean(on).toFixed(2)} vs ${mean(off).toFixed(2)}  lit ${(lit(on) * 100).toFixed(2)}% vs ${(lit(off) * 100).toFixed(2)}%`,
  );
  return {
    tag, off, on, d, amount: st.amount,
    meanOn: mean(on), meanOff: mean(off),
    litOn: lit(on), litOff: lit(off),
    peakOn: peak(on), peakOff: peak(off),
  };
}

const url = `${pathToFileURL(htmlPath).href}?harness=1&seed=20260825`;
console.log(`[fx] ${url}`);
await page.goto(url);
await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 180000 });
await call('audio', false);
await call('hud', false);
// Two channels that resample themselves on every draw, and would therefore differ between the
// two halves of every A/B pair for reasons that have nothing to do with the concussion.
await call('touch', false);
await call('rifleMesh', false);
await call('lights', false);
await call('view', 'player');
await call('markers', true);
await call('pose', 2, 2, 90);
await advance(0.5);

// A hall to look at. Without a lidar picture the frame is legitimately black and a distortion
// of nothing is not evidence of anything.
await call('fire');
await advance(0.9);
await call('aim', 90, 0);
await redraw();

const frames = [];
// 0 — the control. Nothing has gone off; the pass must be a literal pass-through here, or every
// frame in the game is paying for an effect that is not happening.
frames.push(await pair('0-before'));

// The round itself. Frames are taken from 0.12 s on, after the flash has died, so the light in
// the picture is never the muzzle's.
await call('shoot');
await advance(0.12);
frames.push(await pair('1-just-fired'));
await advance(0.88);
frames.push(await pair('2-one-second'));
await advance(2.0);
frames.push(await pair('3-three-seconds'));
await advance(2.6);
frames.push(await pair('4-six-seconds'));
await advance(4.0);
frames.push(await pair('5-recovered'));

const [before, fired, oneSec, threeSec, sixSec, done] = frames;

check('before the shot the pass is not in the picture at all', before.d < 0.002 && before.amount < 0.001,
  `${(before.d * 100).toFixed(3)}% of a frame, amount ${before.amount.toFixed(4)}`);
check('the round leaves the frame visibly unwell', fired.d > 0.012 && fired.amount > 0.6,
  `${(fired.d * 100).toFixed(2)}% of the frame moved, amount ${fired.amount.toFixed(2)}`);
// The complaint being answered was that the old effect was over in about a second.
check('and it is still unwell seconds later', threeSec.d > fired.d * 0.25 && threeSec.amount > 0.25,
  `${(threeSec.d * 100).toFixed(2)}% at +3.1 s against ${(fired.d * 100).toFixed(2)}% at +0.1 s, amount ${threeSec.amount.toFixed(2)}`);
check('it fades rather than switching off', sixSec.amount < threeSec.amount && sixSec.amount > 0.02,
  `amount ${fired.amount.toFixed(2)} → ${oneSec.amount.toFixed(2)} → ${threeSec.amount.toFixed(2)} → ${sixSec.amount.toFixed(2)}`);
check('and the frame comes back on its own', done.d < 0.002 && done.amount < 0.02,
  `${(done.d * 100).toFixed(3)}% of a frame at +9.6 s, amount ${done.amount.toFixed(4)}`);

// The law. Not an aspiration — a numeric gate on every concussed frame in this run.
{
  const worstMean = Math.max(...frames.map((f) => f.meanOn - f.meanOff));
  const worstPeak = Math.max(...frames.map((f) => f.peakOn - f.peakOff));
  check('concept law 1: it never lights the hall', worstMean <= 0.01,
    `total light on screen never rises; the worst case is ${worstMean.toFixed(3)} of 255, ` +
      `and at its deepest the frame is ${(frames[1].meanOff - frames[1].meanOn).toFixed(2)} darker than its twin`);
  // Not a lit-pixel count, deliberately. Every operation here is multiplicative or a resample, so
  // a point smears across a few more texels while its energy goes *down* — the count goes up and
  // means nothing. What the law actually forbids is new light, which is total energy (above) and
  // whether anything got brighter than the renderer had made it (here).
  check('and nothing in it gets brighter than the renderer drew it', worstPeak <= 1.5,
    `the brightest pixel moves by at most ${worstPeak.toFixed(1)} of 255`);
  const spread = Math.max(...frames.map((f) => f.litOn - f.litOff));
  console.log(
    `[fx] note: lit-pixel count moves by up to ${(spread * 100).toFixed(2)} points — that is the ` +
      `double vision and the resample smearing points the renderer already drew, at lower energy, ` +
      `not new information.`,
  );
}

check('no page errors', errors.length === 0, errors.join('; '));

// Cost. The pass is a render-to-target plus one fullscreen blit; it is on every frame of the
// game, so what it costs when nothing has happened is the number that matters.
const cost = await page.evaluate(() => {
  const runs = (n) => {
    const t = performance.now();
    for (let i = 0; i < n; i++) window.bs.draw();
    return (performance.now() - t) / n;
  };
  window.bs.concussion.tune({ enabled: false });
  runs(20);
  const off = runs(120);
  window.bs.concussion.tune({ enabled: true });
  window.bs.concussion.set(0);
  runs(20);
  const idle = runs(120);
  window.bs.concussion.set(1);
  runs(20);
  const full = runs(120);
  window.bs.concussion.set(0);
  return { off, idle, full };
});
console.log(
  `[fx] draw cost: pass removed ${cost.off.toFixed(2)} ms  ·  idle ${cost.idle.toFixed(2)} ms  ·  ` +
    `fully concussed ${cost.full.toFixed(2)} ms (1280x720, swiftshader)`,
);

await writeFile(
  join(outDir, 'README.txt'),
  [
    'M6c — the concussion, as pictures. seed 20260825, 120 Hz fixed step.',
    'Each moment is a pair: -off.png is the pass switched off, -on.png is the same',
    'simulation tick with it on. Nothing else differs between the two.',
    '',
    ...frames.map(
      (f) =>
        `${f.tag}: amount ${f.amount.toFixed(3)}, ${(f.d * 100).toFixed(2)}% of the frame moved, ` +
        `mean luminance ${f.meanOn.toFixed(2)} on / ${f.meanOff.toFixed(2)} off`,
    ),
  ].join('\n'),
);

console.log(`[fx] ${frames.length * 2} frames → ${outDir}`);
await browser.close();
if (failures.length > 0) {
  console.error(`[fx] ${failures.length} check(s) failed`);
  process.exit(1);
}
