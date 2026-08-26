/** Numeric spawn/first-lidar proof. Deliberately no screenshots or output directory. */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
if (!existsSync(htmlPath)) {
  console.error('[spawn-lidar] build not found (run `npm run build` first)');
  process.exit(2);
}

const failures = [];
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(`[spawn-lidar] ${line}`);
  if (!ok) failures.push(line);
};

const DEG = Math.PI / 180;
const RANGE = 34;
const CONE = 62;
const direction = (yawDeg) => [-Math.sin(yawDeg * DEG), -Math.cos(yawDeg * DEG)];

function clearance(boxes, ox, oy, oz, yawDeg) {
  const [dx, dz] = direction(yawDeg);
  let nearest = RANGE;
  for (const [minX, minY, minZ, maxX, maxY, maxZ] of boxes) {
    if (oy < minY || oy > maxY) continue;
    let lo = 0;
    let hi = nearest;
    for (const [o, d, min, max] of [[ox, dx, minX, maxX], [oz, dz, minZ, maxZ]]) {
      if (Math.abs(d) < 1e-9) {
        if (o < min || o > max) lo = Infinity;
        continue;
      }
      let a = (min - o) / d;
      let b = (max - o) / d;
      if (a > b) [a, b] = [b, a];
      lo = Math.max(lo, a);
      hi = Math.min(hi, b);
    }
    if (lo <= hi && lo < nearest) nearest = lo;
  }
  return nearest;
}

function visibleArea(boxes, eye, yawDeg) {
  const intervals = 31;
  const step = CONE / intervals;
  let squared = 0;
  for (let i = 0; i <= intervals; i++) {
    const d = clearance(boxes, eye[0], eye[1], eye[2], yawDeg - CONE / 2 + step * i);
    squared += d * d * (i === 0 || i === intervals ? 0.5 : 1);
  }
  return 0.5 * squared * step * DEG;
}

const launchOptions = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
const preinstalled = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(preinstalled)) launchOptions.executablePath = preinstalled;
const browser = await chromium.launch(launchOptions);
const seeds = [20260824, 20260825, 20260826, 7, 41, 9973];
const rows = [];
const consoleErrors = [];

for (const seed of seeds) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`seed ${seed}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`seed ${seed}: pageerror: ${e.message}`));
  await page.goto(`${pathToFileURL(htmlPath).href}?harness=1&seed=${seed}`);
  await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 30000 });
  await page.evaluate(() => {
    window.bs.audio(false);
    window.bs.spiders.spawn(0);
  });
  const before = await page.evaluate(() => ({ stats: window.bs.stats(), boxes: window.bs.solids() }));
  const yaw = before.stats.aim.yawDeg;
  const selectedArea = visibleArea(before.boxes, before.stats.eye, yaw);
  let bestArea = 0;
  for (let candidate = -180; candidate < 180; candidate += 5) {
    bestArea = Math.max(bestArea, visibleArea(before.boxes, before.stats.eye, candidate));
  }
  await page.evaluate(() => {
    window.bs.fire();
    window.bs.step(1 / 120);
    window.bs.draw();
  });
  const after = await page.evaluate(() => window.bs.stats());
  rows.push({
    seed,
    heading: before.stats.spawnHeading,
    yaw,
    quality: selectedArea / bestArea,
    area: selectedArea,
    forward: clearance(before.boxes, before.stats.eye[0], before.stats.eye[1], before.stats.eye[2], yaw),
    dots: after.paint.lastDots,
    edges: after.paint.lastEdges,
  });
  await page.close();
}

for (const row of rows) {
  const detail = `yaw ${row.yaw.toFixed(0)}°, area ${row.area.toFixed(1)}m², ` +
    `quality ${(row.quality * 100).toFixed(1)}%, forward ${row.forward.toFixed(1)}m, ` +
    `${row.dots} dots/${row.edges} edges, plan ${row.heading.planningMs.toFixed(2)}ms`;
  check(`seed ${row.seed} faces a near-best first-ping sector`, row.quality >= 0.9, detail);
  check(`seed ${row.seed} does not face a nearby wall`, row.forward >= 6, detail);
  check(`seed ${row.seed} first cone covers a useful floor sector`, row.area >= 150, detail);
  check(`seed ${row.seed} first cone reaches the real paint pass`, row.dots >= 400 && row.edges >= 10, detail);
}

const worstPlan = Math.max(...rows.map((r) => r.heading.planningMs));
check('spawn planning stays out of frame-scale cost', worstPlan < 12, `worst ${worstPlan.toFixed(2)}ms`);
check('browser reported no errors', consoleErrors.length === 0, consoleErrors.join(' | '));
await browser.close();
if (failures.length > 0) process.exitCode = 1;
