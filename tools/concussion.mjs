/**
 * M6c keyframes — the *visual* half of the concussion.
 *
 *   node tools/concussion.mjs [dist/index.html] [out/concussion]
 *
 * Four frames and a page of numbers, per `doc/proto/process.md` §«Скриншоты — это пруф, но пруф
 * дешёвый»: the PNGs exist to be *looked at*, and nothing here is measured by decoding one. Every
 * number below is read off the canvas inside the page — two draws of the same simulation tick, one
 * with the pass off and one with it on, compared in a single JS task.
 *
 * The claim has two parts, and the second is a law from `doc/proto/concept.md`:
 *
 *   1. the frame is *unwell* right after the shot — it swims and tears — and it is still unwell
 *      seconds later, then recovers on its own;
 *   2. it never lights the world. Law 1 says nothing renders for convenience: the effect may only
 *      move, dim and resample pixels the renderer had already earned. So every measured moment is
 *      an A/B against the identical tick with the pass off, and if a frame ever gets *brighter*,
 *      or contains a pixel brighter than its twin's brightest, this generator fails.
 *
 * The four frames are the *before/after of the softening*: the human's verdict on the first cut
 * was «контузия слишком жесткая, ничего не видно совсем» — so frame 3 re-renders the very same
 * tick as frame 2 with the old, blinding tunables, and the pair is the whole argument.
 *
 * The muzzle flash is a real light and it would ruin the comparison, so no frame here is taken
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

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
const outDir = resolve(process.argv[3] ?? 'out/concussion');
if (!existsSync(htmlPath)) {
  console.error(`[fx] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
for (const f of await readdir(outDir)) if (f.endsWith('.png')) await unlink(join(outDir, f));

/** The tunables the human threw out, kept only so frame 3 can show what they looked like. */
const OLD = { wobble: 0.026, tear: 0.045, tearRows: 0.16, grain: 0.5, vignette: 0.55, ghost: 0.34 };

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
const shot = (name) => page.screenshot({ path: join(outDir, name), timeout: 180000 });

/**
 * One moment, measured twice inside the page: the pass off and the pass on, with nothing between
 * the two draws but the switch. Reading the drawing buffer in the same task as the draw is what
 * makes this possible without `preserveDrawingBuffer` — the buffer is cleared only afterwards.
 *
 * Returns the mean and peak luminance of both halves and the mean absolute difference between
 * them, normalised to 0..1. A pass-through scores ~0; a swimming frame scores a lot more, with no
 * assumption about *which* pixels moved.
 */
async function moment(tag) {
  const m = await page.evaluate(() => {
    // The page has more than one canvas (the HUD keeps a 2D one); the drawing buffer we want is
    // the one that answers to a WebGL context.
    const all = [...document.querySelectorAll('canvas')];
    let cvs = null;
    let gl = null;
    for (const c of all) {
      const g = c.getContext('webgl2') ?? c.getContext('webgl');
      if (g !== null) { cvs = c; gl = g; break; }
    }
    if (gl === null) throw new Error(`no WebGL canvas among ${all.length}`);
    // Straight off the drawing buffer. A 2D `drawImage` of this canvas comes back nearly black —
    // the scene is drawn with an alpha of zero over a transparent page — so the honest reading is
    // `readPixels` on the live context, in the same task as the draw, before the compositor
    // clears the buffer.
    const w = cvs.width;
    const h = cvs.height;
    const px = new Uint8Array(w * h * 4);
    const grab = () => {
      window.bs.draw();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const n = w * h;
      const lum = new Float32Array(n);
      let sum = 0;
      let top = 0;
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        const l = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
        lum[i] = l;
        sum += l;
        if (l > top) top = l;
      }
      return { lum, n, mean: sum / n, peak: top };
    };
    window.bs.concussion.tune({ enabled: false });
    const off = grab();
    window.bs.concussion.tune({ enabled: true });
    const on = grab();
    let acc = 0;
    for (let i = 0; i < off.n; i++) acc += Math.abs(on.lum[i] - off.lum[i]);
    return {
      d: acc / off.n / 255,
      meanOn: on.mean, meanOff: off.mean,
      peakOn: on.peak, peakOff: off.peak,
      amount: window.bs.concussion.state().amount,
    };
  });
  console.log(
    `[fx] ${tag.padEnd(16)} amount ${m.amount.toFixed(3)}  moved ${(m.d * 100).toFixed(2)}%  ` +
      `mean ${m.meanOn.toFixed(2)} on / ${m.meanOff.toFixed(2)} off  ` +
      `peak ${m.peakOn.toFixed(0)} / ${m.peakOff.toFixed(0)}`,
  );
  return { tag, ...m };
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

// The control. Nothing has gone off; the pass must be a literal pass-through here, or every frame
// in the game is paying for an effect that is not happening. Measured, not photographed.
const before = await moment('0-before');

// The round itself, from 0.12 s on — after the flash has died, so the light in the picture is
// never the muzzle's.
await call('shoot');
await advance(0.12);
const fired = await moment('1-just-fired');
// Frame 1: the reference. The same tick with the pass switched off — what the hall actually is.
await call('concussion.tune', { enabled: false });
await redraw();
await shot('1-just-fired-off.png');
// Frame 2: the concussion as it now ships.
await call('concussion.tune', { enabled: true });
await redraw();
await shot('2-just-fired-on.png');
// Frame 3: the same tick again, with the tunables the human called blinding. Frames 2 and 3 are
// the before/after of this change, and the reason the hall is readable in one and gone in the other.
// `tune({})` is a no-op patch that returns the current tunables — the ones to restore after.
const now = await call('concussion.tune', {});
await call('concussion.tune', OLD);
const old = await moment('1-just-fired (old)');
await redraw();
await shot('3-just-fired-old-tuning.png');
await call('concussion.tune', now);

await advance(0.88);
const oneSec = await moment('2-one-second');
await advance(2.0);
const threeSec = await moment('3-three-seconds');
// Frame 4: seconds later. Still unwell, and still a hall.
await redraw();
await shot('4-three-seconds-on.png');
await advance(2.6);
const sixSec = await moment('4-six-seconds');
await advance(4.0);
const done = await moment('5-recovered');

const frames = [before, fired, old, oneSec, threeSec, sixSec, done];

check('before the shot the pass is not in the picture at all', before.d < 0.002 && before.amount < 0.001,
  `${(before.d * 100).toFixed(3)}% of a frame, amount ${before.amount.toFixed(4)}`);
check('the round leaves the frame visibly unwell', fired.d > 0.004 && fired.amount > 0.6,
  `${(fired.d * 100).toFixed(2)}% of the frame moved, amount ${fired.amount.toFixed(2)}`);
// The complaint being answered was that the old effect was over in about a second.
check('and it is still unwell seconds later', threeSec.d > fired.d * 0.25 && threeSec.amount > 0.25,
  `${(threeSec.d * 100).toFixed(2)}% at +3.1 s against ${(fired.d * 100).toFixed(2)}% at +0.1 s, amount ${threeSec.amount.toFixed(2)}`);
check('it fades rather than switching off', sixSec.amount < threeSec.amount && sixSec.amount > 0.02,
  `amount ${fired.amount.toFixed(2)} → ${oneSec.amount.toFixed(2)} → ${threeSec.amount.toFixed(2)} → ${sixSec.amount.toFixed(2)}`);
check('and the frame comes back on its own', done.d < 0.002 && done.amount < 0.02,
  `${(done.d * 100).toFixed(3)}% of a frame at +9.6 s, amount ${done.amount.toFixed(4)}`);

// The point of this revision, as a number rather than as an impression: how much of the hall's
// light the effect eats at its worst. The old tuning took a quarter of it away *and* split every
// remaining line into two half-brightness copies; the gate says the shipped one may not take more
// than a tenth, and what it does take is grain speckle rather than contrast on the geometry.
{
  const kept = fired.meanOn / fired.meanOff;
  const keptOld = old.meanOn / old.meanOff;
  check('the hall stays visible through it', kept > 0.9,
    `${(kept * 100).toFixed(1)}% of the hall's light survives the pass, against ` +
      `${(keptOld * 100).toFixed(1)}% under the old tuning — ${((1 - keptOld) / Math.max(1e-6, 1 - kept)).toFixed(1)}x less taken away`);
}

// The law. Not an aspiration — a numeric gate on every measured moment in this run.
{
  const worstMean = Math.max(...frames.map((f) => f.meanOn - f.meanOff));
  const worstPeak = Math.max(...frames.map((f) => f.peakOn - f.peakOff));
  check('concept law 1: it never lights the hall', worstMean <= 0.01,
    `total light on screen never rises; the worst case is ${worstMean.toFixed(3)} of 255`);
  check('and nothing in it gets brighter than the renderer drew it', worstPeak <= 1.5,
    `the brightest pixel moves by at most ${worstPeak.toFixed(1)} of 255`);
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
    '',
    '1-just-fired-off      the hall as it is, 0.12 s after the round, pass switched off.',
    '2-just-fired-on       the same tick with the concussion as it ships.',
    '3-just-fired-old-tuning  the same tick again with the first, blinding tuning.',
    '4-three-seconds-on    +3.1 s: still unwell, still a hall.',
    '',
    'Numbers are printed by the generator, not measured from these PNGs.',
    ...frames.map(
      (f) =>
        `${f.tag}: amount ${f.amount.toFixed(3)}, ${(f.d * 100).toFixed(2)}% of the frame moved, ` +
        `mean luminance ${f.meanOn.toFixed(2)} on / ${f.meanOff.toFixed(2)} off`,
    ),
  ].join('\n'),
);

console.log(`[fx] 4 frames → ${outDir}`);
await browser.close();
if (failures.length > 0) {
  console.error(`[fx] ${failures.length} check(s) failed`);
  process.exit(1);
}
