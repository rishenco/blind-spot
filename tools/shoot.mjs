/**
 * Keyframe generator for M1.
 *
 * Headless chromium opens the single-file build over file://, then drives the simulation by
 * hand: fixed seed, fixed step, no wall clock anywhere in the loop. Every scenario ends in a
 * PNG, and every PNG that claims something is checked photometrically — you cannot eyeball a
 * black screen, so the frames are measured instead of trusted.
 *
 *   node tools/shoot.mjs [dist/index.html] [out]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  decodePng,
  meanLuminance as meanLuminanceRect,
  litFraction as litFractionRect,
  whiteFraction as whiteFractionRect,
} from './png.mjs';

/** png.mjs measures rectangles and returns records; M1 only ever asks about the whole frame. */
const whole = (img) => ({ x: 0, y: 0, w: img.width, h: img.height });
const litFraction = (img) => litFractionRect(img, whole(img)).fraction;
const meanLuminance = (img) => meanLuminanceRect(img, whole(img)).mean;
const whiteFraction = (img, threshold = 100) => whiteFractionRect(img, whole(img), threshold).fraction;

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
const outDir = resolve(process.argv[3] ?? 'out');

if (!existsSync(htmlPath)) {
  console.error(`[shoot] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

const failures = [];
const notes = [];
const consoleErrors = [];

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const PREINSTALLED = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(PREINSTALLED)) launchOptions.executablePath = PREINSTALLED;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

function check(label, ok, detail = '') {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(`[shoot] ${line}`);
  if (!ok) failures.push(line);
}

const shots = [];
async function shot(name, note) {
  const file = join(outDir, name);
  const t0 = Date.now();
  const buf = await page.screenshot({ path: file, timeout: 180000 });
  const captureMs = Date.now() - t0;
  const img = decodePng(buf);
  shots.push({ name, note, lit: litFraction(img), mean: meanLuminance(img) });
  console.log(
    `[shoot] shot ${name}  lit=${litFraction(img).toFixed(4)} mean=${meanLuminance(img).toFixed(2)} capture=${captureMs}ms`,
  );
  return img;
}

/** Runs `seconds` of simulation, drawing `draws` frames spread over it (draws pump the lidar). */
const advance = (seconds, draws = 4) =>
  page.evaluate(
    ([sec, n]) => {
      const bs = window.bs;
      const slice = sec / n;
      for (let i = 0; i < n; i++) {
        bs.step(slice);
        bs.draw();
      }
    },
    [seconds, draws],
  );

/** Fires and runs the world forward until both fronts have been handed to the renderer. */
const ping = () =>
  page.evaluate(() => {
    const bs = window.bs;
    bs.fire();
    for (let i = 0; i < 200; i++) {
      bs.step(1 / 120);
      bs.draw();
      const s = bs.stats();
      if (i > 3 && s.lidar.queued === 0 && s.paint.pending === 0) break;
    }
    return bs.stats();
  });

const call = (fn, ...args) =>
  page.evaluate(
    ([f, a]) => {
      const r = window.bs[f](...a);
      return r === undefined ? null : r;
    },
    [fn, args],
  );
const stats = () => page.evaluate(() => window.bs.stats());

// ---------------------------------------------------------------------------
const url = `${pathToFileURL(htmlPath).href}?harness=1&seed=20260824`;
console.log(`[shoot] ${url}`);
await page.goto(url);
await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 20000 });

const boot = await page.evaluate(() => ({
  seed: window.bs.seed,
  boxes: window.bs.boxes,
  buildMs: window.bs.buildMs(),
  stats: window.bs.stats(),
}));
console.log(
  `[shoot] hall: seed=${boot.seed} boxes=${boot.boxes} lattice build=${boot.buildMs.toFixed(0)} ms ` +
    `dots=${boot.stats.paint.dots} edges=${boot.stats.paint.edges}`,
);
notes.push(
  `hall ${boot.boxes} boxes · ${boot.stats.paint.dots} dots · ${boot.stats.paint.edges} edge segments · lattice build ${boot.buildMs.toFixed(0)} ms`,
);
await call('hud', false);
await advance(0.5, 2);

// --- 01/02 lights on: the hall as it actually is ---------------------------
await call('lights', true);
// The top camera follows the player, so put him in the middle for the establishing shot.
await call('pose', 0, 0, 35);
await call('view', 'top');
await call('topHeight', 58);
await advance(0.1, 2);
const lit1 = await shot('01-hall-lit-top.png', 'the whole hall under full light, from above');
check('lit top view is bright', litFraction(lit1) > 0.5, `lit=${litFraction(lit1).toFixed(3)}`);

await call('view', 'player');
await call('pose', -30, -20, 35);
await advance(0.1, 2);
const lit2 = await shot('02-hall-lit-player.png', 'same spawn pose, darkness switched off');
check('lit player view is bright', litFraction(lit2) > 0.4, `lit=${litFraction(lit2).toFixed(3)}`);

// --- 03 the ground state: black ------------------------------------------
await call('lights', false);
await call('clear');
await call('touch', false);
await advance(0.2, 2);
const dark = await shot('03-spawn-dark.png', 'spawn, darkness on, nothing scanned yet');
check('unscanned world renders black', litFraction(dark) < 0.01, `lit=${litFraction(dark).toFixed(4)}`);

// --- 04..06 one ping, aged ------------------------------------------------
await call('touch', true);
const fired = await ping();
// One trigger pull queues two fronts: the cone and the small halo around the player.
check('lidar fired', fired.lidar.fired === 2, `fronts=${fired.lidar.fired}`);
await advance(0.25, 3);
const p0 = await shot('04-ping-t0.png', 'the ping, ~0.2 s in: the front is still travelling');
check('ping paints something', litFraction(p0) > 0.005, `lit=${litFraction(p0).toFixed(4)}`);
check('front is hot', whiteFraction(p0, 100) > 0, 'white pixels on the wave front');

await advance(0.75, 4);
const p1 = await shot('05-ping-t1.png', 'same ping at +1 s: the cone has landed, map is fresh');
await advance(4, 6);
const p5 = await shot('06-ping-t5.png', 'same ping at +5 s: cooled to the skeleton, still readable');
check('the map dims but does not die', litFraction(p5) > 0.003, `lit=${litFraction(p5).toFixed(4)}`);
check('cold map is dimmer than fresh', meanLuminance(p5) < meanLuminance(p1),
  `mean ${meanLuminance(p5).toFixed(2)} < ${meanLuminance(p1).toFixed(2)}`);
const seen1 = (await stats()).paint.unlockedDots;

// --- 07/08 several scans from different places accumulate -----------------
const scanPoints = [
  [-28, -16, 60],
  [-24, -4, 90],
  [-10, 0, 90],
  [6, 2, 75],
];
let grew = true;
let prev = seen1;
const series = [];
for (const [x, z, yaw] of scanPoints) {
  await call('pose', x, z, yaw);
  await call('refill');
  await ping();
  await advance(0.6, 3);
  const now = (await stats()).paint.unlockedDots;
  if (now <= prev) grew = false;
  series.push(now);
  prev = now;
}
check('each scan adds new ground', grew, `unlocked dots ${seen1} -> ${series.join(' -> ')}`);
await shot('07-accum-player.png', 'four scans from four places, seen from the last of them');
await call('view', 'top');
await call('topHeight', 74);
await advance(0.1, 2);
await shot('08-accum-top.png', 'the same accumulated map from above — what you have learned so far');
await call('view', 'player');

// --- 09 the tactile layer up against a shelf ------------------------------
await call('clear');
await call('pose', -27.4, 8, 90);
await call('touch', true);
await advance(0.6, 3);
const touchStats = await stats();
const t1 = await shot('09-touch-shelf.png', 'no scan at all: only what is within arm\'s reach of you');
check('touch layer finds the shelf', touchStats.touch.segments > 0,
  `${touchStats.touch.segments} segments, ${touchStats.touch.near} in reach, ${touchStats.touch.remembered} remembered`);
check('touch shows something', litFraction(t1) > 0.0005, `lit=${litFraction(t1).toFixed(4)}`);
check('touch shows almost nothing else', litFraction(t1) < 0.08, `lit=${litFraction(t1).toFixed(4)}`);

// --- 10..13 the readability gate: spawn -> gate on lidar alone ------------
await call('clear');
await call('pose', -30, -20, 35);
await advance(0.4, 2);
await call('refill');
await ping();
await advance(0.7, 4);
await shot('10-gate-start.png', 'first scan from the spawn corner — where do you even go');

// The east end is split by a solid 6 m rack run (x 22..23.4, z -18..6): the only way through
// to the gate is around its north end.
const route = [
  [-26, -14],
  [-24, -2],
  [-14, 0],
  [-2, 2],
  [10, 4],
  [18, 9],
  [26, 8],
  [29, 0],
];
const trace = await page.evaluate(
  ([waypoints]) => {
    const bs = window.bs;
    const dt = 1 / 120;
    const log = [];
    let pings = 0;
    let stuck = 0;
    let strafe = null;
    let sinceScan = 1e9;

    const pos = () => bs.stats().pos;
    const heading = (dx, dz) => (Math.atan2(-dx, -dz) * 180) / Math.PI;

    bs.keys(['KeyW'], []);
    for (const [wx, wz] of waypoints) {
      let last = pos();
      for (let tick = 0; tick < 120 * 25; tick++) {
        const p = pos();
        const dx = wx - p[0];
        const dz = wz - p[2];
        const dist = Math.hypot(dx, dz);
        if (dist < 1.4) break;
        // Scan every 2 s of walking: this is the whole point — you move on what you last saw.
        if (sinceScan > 2) {
          bs.refill();
          bs.fire();
          pings++;
          sinceScan = 0;
        }
        bs.aim(heading(dx, dz) + (strafe ?? 0), 0);
        bs.step(dt);
        sinceScan += dt;
        if (tick % 6 === 0) bs.draw();
        if (tick % 60 === 59) {
          const moved = Math.hypot(p[0] - last[0], p[2] - last[2]);
          last = p;
          if (moved < 0.35) {
            // Walked into something. Peel off 55 degrees and try again — a blind person's
            // wall-follow, not a pathfinder.
            stuck++;
            strafe = strafe === null ? 55 : -strafe;
          } else if (moved > 1.2) {
            strafe = null;
          }
        }
      }
      const p = pos();
      log.push({ wp: [wx, wz], at: [Number(p[0].toFixed(1)), Number(p[2].toFixed(1))] });
    }
    bs.keys([], ['KeyW']);
    for (let i = 0; i < 60; i++) {
      bs.step(dt);
      bs.draw();
    }
    const s = bs.stats();
    return { log, pings, stuck, gate: s.gate, pos: s.pos, paint: s.paint, frameMs: s.frameMs };
  },
  [route],
);
console.log('[shoot] route', JSON.stringify(trace.log));
console.log(
  `[shoot] gate run: ${trace.pings} pings, ${trace.stuck} stuck-recoveries, ${trace.gate.toFixed(1)} m from the gate`,
);
notes.push(
  `gate run: ${trace.pings} pings, ${trace.stuck} stuck-recoveries, ended ${trace.gate.toFixed(1)} m from the gate`,
);
await shot('11-gate-arrive.png', 'standing in the gate, on what the last few pings drew');
check('reached the gate', trace.gate < 4, `${trace.gate.toFixed(1)} m`);

await call('view', 'top');
await call('topHeight', 80);
await advance(0.1, 2);
await shot('12-gate-map-top.png', 'everything the walk revealed, from above — the route as a map');
await call('lights', true);
await advance(0.1, 2);
await shot('13-gate-truth-top.png', 'the same instant with the lights on: map versus reality');

// --- perf ------------------------------------------------------------------
await call('lights', false);
await call('view', 'player');
await call('hud', true);
await advance(0.3, 2);
// Measured the way the game actually runs: amortised unlock, one chunk per frame. The
// harness's force-drain is a screenshot aid and would show up here as a fake 30 ms hitch.
await call('sync', false);
const perf = await page.evaluate(async () => {
  const bs = window.bs;
  // Two different costs, and they must not be confused. `cpu` is our own work for the frame
  // (sim + unlock + issuing draws). `wall` is rAF-to-rAF, so it also contains whatever the
  // rasteriser does after we return — which, on a software GL, is nearly all of it.
  const wall = [];
  const cpu = [];
  const paintPing = [];
  const paintQuiet = [];
  await new Promise((done) => {
    let i = 0;
    let prevRaf = 0;
    const tick = (now) => {
      const isPing = i % 30 === 0;
      if (isPing) {
        bs.refill();
        bs.fire();
      }
      if (prevRaf !== 0) wall.push(now - prevRaf);
      prevRaf = now;
      const t0 = performance.now();
      bs.step(1 / 60);
      bs.draw();
      cpu.push(performance.now() - t0);
      const ms = bs.stats().frameMs.paintMs;
      (isPing ? paintPing : paintQuiet).push(ms);
      if (++i >= 120) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const q = (arr, p) => {
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * p))];
  };
  const s = bs.stats();
  return {
    wallMedian: q(wall, 0.5),
    wallP95: q(wall, 0.95),
    cpuMedian: q(cpu, 0.5),
    cpuP95: q(cpu, 0.95),
    cpuMax: Math.max(...cpu),
    paintPingMax: Math.max(...paintPing),
    paintQuietMax: Math.max(...paintQuiet),
    calls: s.calls,
    dots: s.paint.unlockedDots,
    edges: s.paint.unlockedEdges,
    totalDots: s.paint.dots,
    sim: s.frameMs.simMs,
  };
});
console.log(
  `[shoot] cpu frame: median ${perf.cpuMedian.toFixed(2)} ms · p95 ${perf.cpuP95.toFixed(2)} ms · max ${perf.cpuMax.toFixed(2)} ms` +
    ` | swiftshader wall frame: median ${perf.wallMedian.toFixed(0)} ms · p95 ${perf.wallP95.toFixed(0)} ms` +
    ` | ${perf.calls} draw calls · ${perf.dots}/${perf.totalDots} dots unlocked · sim ${perf.sim.toFixed(2)} ms`,
);
notes.push(
  `perf, 1280x720, 120 frames with a ping every 30, map fully walked: our own per-frame cost ` +
    `median ${perf.cpuMedian.toFixed(2)} ms / p95 ${perf.cpuP95.toFixed(2)} ms / max ${perf.cpuMax.toFixed(2)} ms; ` +
    `unlock work on a ping frame max ${perf.paintPingMax.toFixed(2)} ms (budget 4 ms/frame), quiet frame max ${perf.paintQuietMax.toFixed(2)} ms; ` +
    `${perf.calls} draw calls, ${perf.dots} of ${perf.totalDots} dots unlocked. ` +
    `Wall frame under llvmpipe/swiftshader software GL: median ${perf.wallMedian.toFixed(0)} ms / p95 ${perf.wallP95.toFixed(0)} ms — that is the software rasteriser, not the simulation.`,
);
check('the unlock stays inside its amortisation budget', perf.paintPingMax < 12,
  `worst ping frame spent ${perf.paintPingMax.toFixed(2)} ms unlocking (chunk budget 4 ms)`);
await call('sync', true);
check('a ping does not spike our own frame cost', perf.cpuMax < perf.cpuMedian + 25,
  `max ${perf.cpuMax.toFixed(2)} ms vs median ${perf.cpuMedian.toFixed(2)} ms`);
await shot('14-hud.png', 'the debug overlay: position, landmark, lidar charge, sound bus, frame cost');

// --- contact sheet ---------------------------------------------------------
const html = `<!doctype html><meta charset="utf-8"><title>BLIND SPOT M1 — keyframes</title>
<style>body{background:#0a0d10;color:#cfdbe4;font:13px/1.5 ui-monospace,monospace;margin:24px}
h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#6fd3e0}
figure{margin:0 0 28px}img{width:100%;max-width:1280px;border:1px solid #223}
figcaption{padding:6px 2px;color:#8fa2b0}</style>
<h1>BLIND SPOT — M1 keyframes</h1>
<p>${notes.map((n) => `${n}<br>`).join('')}</p>
${shots
  .map(
    (s) =>
      `<figure><img src="${s.name}"><figcaption>${s.name} — ${s.note} · lit ${s.lit.toFixed(4)} · mean ${s.mean.toFixed(2)}</figcaption></figure>`,
  )
  .join('\n')}`;
await writeFile(join(outDir, 'index.html'), html);

await browser.close();

if (consoleErrors.length > 0) {
  console.log(`[shoot] console errors:\n  ${consoleErrors.slice(0, 8).join('\n  ')}`);
  failures.push(`${consoleErrors.length} console error(s)`);
}
console.log(`[shoot] ${shots.length} frames -> ${outDir}`);
if (failures.length > 0) {
  console.error(`[shoot] ${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('[shoot] all checks passed');
