/**
 * The map lab — M5's debug tool and its proof frames.
 *
 * Two halves, and the first one is the point:
 *
 *  1. **The plan view.** `src/world/hall.ts` is bundled for node, ten seeds are generated, and
 *     each one is drawn as a labelled floor plan — rooms with their names and characters,
 *     every passage marked and named by the two rooms it joins, every landmark drawn with its
 *     own glyph. Ten of them go on one contact sheet, because the only way to tell "this
 *     generator makes warehouses" from "this generator makes porridge" is to look at ten in a
 *     row. Tuning a hall generator by walking around in the dark is not tuning, it is guessing.
 *
 *  2. **The proof frames**, driven through the built app: the same hall lit from above, the
 *     same hall through the player's eyes with the map he accumulated on a walk, the same seed
 *     twice byte-for-byte, and three seeds side by side.
 *
 *   node tools/world.mjs [dist/index.html] [outDir]
 */
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, litFraction, meanLuminance } from './png.mjs';

/** Whole-frame rectangle — these are full-scene shots, there is no region toisolate. */
const full = (img) => ({ x: 0, y: 0, w: img.width, h: img.height });

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
const outDir = resolve(process.argv[3] ?? 'out-world');
if (!existsSync(htmlPath)) {
  console.error(`[world] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
for (const f of await readdir(outDir)) {
  if (f.endsWith('.png') || f.endsWith('.json')) await unlink(join(outDir, f));
}

const SEEDS = [20260824, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const failures = [];
const shots = [];
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(`[world] ${line}`);
  if (!ok) failures.push(line);
};

// ---------------------------------------------------------------------------
// 1. The plans. Generated in node, straight out of the same module the game imports, so the
//    picture cannot drift from the hall the player walks in.
// ---------------------------------------------------------------------------

const bundle = await build({
  entryPoints: [resolve('src/world/hall.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  logLevel: 'error',
});
const modUrl =
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text, 'utf8').toString('base64');
const { buildHall, HALL } = await import(modUrl);

const plans = [];
for (const seed of SEEDS) {
  // Two builds of the same seed, so determinism is asserted on the data as well as on the pixels.
  const t0 = performance.now();
  const hall = buildHall(seed);
  const genMs = performance.now() - t0;
  const again = buildHall(seed);
  const digest = (h) => createHash('sha1').update(JSON.stringify(h.plan)).digest('hex').slice(0, 12);
  plans.push({
    seed,
    genMs,
    boxes: hall.boxCount,
    plan: hall.plan,
    hash: digest(hall),
    hashAgain: digest(again),
  });
}

for (const p of plans) {
  const r = p.plan.reach;
  console.log(
    `[world] seed ${String(p.seed).padEnd(9)} boxes ${String(p.boxes).padStart(4)} ` +
      `rooms ${String(p.plan.rooms.length).padStart(2)} passages ${String(p.plan.passages.length).padStart(2)} ` +
      `landmarks ${p.plan.landmarks.length} gate=${r.gate} rooms-reached ${r.roomsReached}/${r.rooms} ` +
      `open ${r.openFraction.toFixed(3)} gen ${p.genMs.toFixed(1)}ms`,
  );
}

check('every seed reproduces itself', plans.every((p) => p.hash === p.hashAgain));
check('every seed differs from the others', new Set(plans.map((p) => p.hash)).size === SEEDS.length);
check(
  'the whole floor is one connected space',
  plans.every((p) => p.plan.reach.openFraction > 0.999),
  `worst ${Math.min(...plans.map((p) => p.plan.reach.openFraction)).toFixed(3)}`,
);
check(
  'every room is walkable from spawn',
  plans.every((p) => p.plan.reach.roomsReached === p.plan.reach.rooms),
);
check('the gate is reachable in every hall', plans.every((p) => p.plan.reach.gate));
check(
  'rooms, not a field and not a maze',
  plans.every((p) => p.plan.rooms.length >= 7 && p.plan.rooms.length <= 13),
  `${Math.min(...plans.map((p) => p.plan.rooms.length))}..${Math.max(...plans.map((p) => p.plan.rooms.length))} rooms`,
);
check(
  'every room has a way in',
  plans.every((p) => p.plan.rooms.every((r) => p.plan.passages.some((g) => g.a === r.id || g.b === r.id))),
);
check(
  'landmarks are all different shapes',
  plans.every((p) => new Set(p.plan.landmarks.map((l) => l.kind)).size === p.plan.landmarks.length),
  'three identical columns are a trap, not a landmark',
);
check(
  'landmarks stand above the clutter',
  plans.every((p) => p.plan.landmarks.every((l) => l.kind === 'spawn' || l.top >= 5)),
  `lowest ${Math.min(...plans.flatMap((p) => p.plan.landmarks.filter((l) => l.kind !== 'spawn').map((l) => l.top))).toFixed(1)} m`,
);
check(
  'landmarks are far enough apart to tell where you are',
  plans.every((p) =>
    p.plan.landmarks.every((a, i) =>
      p.plan.landmarks.every((b, j) => i >= j || Math.hypot(a.x - b.x, a.z - b.z) > 10),
    ),
  ),
);
check(
  'generation stays cheap',
  plans.every((p) => p.genMs < 120),
  `worst ${Math.max(...plans.map((p) => p.genMs)).toFixed(1)} ms`,
);

await writeFile(
  join(outDir, 'plans.json'),
  JSON.stringify(plans.map((p) => ({ seed: p.seed, boxes: p.boxes, hash: p.hash, plan: p.plan })), null, 1),
);

// ---------------------------------------------------------------------------
// The drawing itself lives in the browser only because a 2D canvas is there for free.
// ---------------------------------------------------------------------------

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const PREINSTALLED = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(PREINSTALLED)) launchOptions.executablePath = PREINSTALLED;
const browser = await chromium.launch(launchOptions);

const drawPage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await drawPage.setContent('<body style="margin:0;background:#0b0d10"></body>');
await drawPage.addScriptTag({ content: PLAN_PAINTER() });

/** Renders one labelled plan (or a grid of small ones) and returns the PNG. */
async function paint(payload, width, height) {
  await drawPage.setViewportSize({ width, height });
  await drawPage.evaluate((p) => window.paintPlans(p), payload);
  return drawPage.locator('canvas').screenshot();
}

const save = async (name, buf, note) => {
  await writeFile(join(outDir, name), buf);
  const img = decodePng(buf);
  shots.push({ name, note, lit: litFraction(img, full(img)).fraction, mean: meanLuminance(img, full(img)).mean });
  console.log(`[world] ${name} — ${note}`);
};

for (const p of [plans[0], plans[2], plans[5]]) {
  await save(
    `plan-${p.seed}.png`,
    await paint({ mode: 'single', plans: [p], hall: { halfX: HALL.halfX, halfZ: HALL.halfZ } }, 1280, 960),
    `labelled plan of seed ${p.seed}: ${p.plan.rooms.length} rooms, ${p.plan.passages.length} passages, ${p.plan.landmarks.length} landmarks`,
  );
}
await save(
  'plans-ten-seeds.png',
  await paint({ mode: 'sheet', plans, hall: { halfX: HALL.halfX, halfZ: HALL.halfZ } }, 1800, 820),
  'the debug tool: ten seeds side by side — different warehouses, same grammar',
);

// ---------------------------------------------------------------------------
// 2. The proof frames, through the real build.
// ---------------------------------------------------------------------------

/** Opens the app at a seed and hands back a page with the harness ready. */
async function open(seed, size = { width: 1080, height: 720 }) {
  const page = await browser.newPage({ viewport: size });
  page.on('pageerror', (e) => failures.push(`pageerror(seed ${seed}): ${e.message}`));
  await page.goto(`${pathToFileURL(htmlPath).href}?seed=${seed}`);
  await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 180000 });
  await page.evaluate(() => {
    window.bs.hud(false);
    window.bs.audio(false);
  });
  return page;
}

/**
 * The hall from the ceiling, lit — the "how it really is" half of every pair.
 *
 * `freeze` is for the determinism pair: the pack is parked far out of frame and not a single
 * step is taken, so what the frame contains is the *generated hall* and nothing else. The
 * spiders are M6's business and they wander on their own clock; leaving them in would turn a
 * question about the generator into a question about the pack.
 */
async function topDown(page, freeze = false) {
  await page.evaluate((frozen) => {
    const bs = window.bs;
    if (frozen) {
      // The pack goes away entirely. Parking it 180 m out was not enough — the overlay and the
      // bodies still put a few bright specks in the frame, and where they land depends on M6's
      // own clock, not on the generator. Despawning removes the whole question.
      bs.spiders.spawn(0);
      // Same reason for the sound layer: the settling clutter leaves a few heat blobs whose
      // fade is M2's clock, not the generator's. The question here is the shape of the hall.
      bs.markers(false);
    }
    bs.clear();
    bs.lights(true);
    bs.view('top');
    // Focused on the middle of the hall, high enough that all 68 x 48 m of it are in frame —
    // the point of this view is the whole plan, not the corner the player happens to stand in.
    bs.topFocus(0, 0);
    bs.topHeight(50);
    if (!frozen) bs.step(0.4);
    bs.draw();
  }, freeze);
  return page.screenshot();
}

const main = await open(SEEDS[0]);
await save(
  'hall-top-lit.png',
  await topDown(main),
  `seed ${SEEDS[0]} from the ceiling with the lights on: rack runs cut the hall into rooms, gaps in them are the passages, the tall shapes are the landmarks`,
);

/**
 * The walk. Waypoints are the room centres in the order a player would meet them, and the
 * lidar is fired at four headings from each, so what accumulates is the hall itself and not a
 * corridor of points along one line of sight.
 */
const route = (() => {
  const plan = plans[0].plan;
  const pts = [...plan.rooms]
    .map((r) => ({ x: r.cx, z: r.cz, d: Math.hypot(r.cx - plan.spawn.x, r.cz - plan.spawn.z) }))
    .sort((a, b) => a.d - b.d);
  return [{ x: plan.spawn.x, z: plan.spawn.z }, ...pts, { x: plan.gate.x - 4, z: plan.gate.z }];
})();

// The walk is a lot of frames, and every one of them is drawn by a software rasteriser here.
// It happens at a small viewport and is put back afterwards: what accumulates is the *map*,
// which lives in world space and does not care how big the window was.
await main.setViewportSize({ width: 480, height: 320 });
const walk = await page_walk(main, route);
await main.setViewportSize({ width: 1080, height: 720 });
async function page_walk(page, waypoints) {
  return page.evaluate((wps) => {
    const bs = window.bs;
    bs.clear();
    bs.lights(false);
    bs.view('fps');
    // A point is only refused as a stance if something solid is actually standing in it.
    const boxes = bs.solids();
    const blocked = (x, z) =>
      boxes.some(
        (b) => x > b[0] - 0.4 && x < b[3] + 0.4 && z > b[2] - 0.4 && z < b[5] + 0.4 && b[4] > 0.5 && b[1] < 1.7,
      );
    let pings = 0;
    let skipped = 0;
    for (const w of wps) {
      let x = w.x;
      let z = w.z;
      if (blocked(x, z)) {
        // Step off the pile in a widening ring rather than dropping the waypoint.
        let found = false;
        for (let r = 1.5; r <= 6 && !found; r += 1.5) {
          for (let a = 0; a < 8 && !found; a++) {
            const nx = w.x + Math.cos((a * Math.PI) / 4) * r;
            const nz = w.z + Math.sin((a * Math.PI) / 4) * r;
            if (!blocked(nx, nz)) {
              x = nx;
              z = nz;
              found = true;
            }
          }
        }
        if (!found) {
          skipped++;
          continue;
        }
      }
      for (let q = 0; q < 3; q++) {
        bs.pose(x, z, q * 120 + 20);
        bs.aim(q * 120 + 20, -6);
        // The generator is not here to prove the recharge — that is M1's scenario. Topping the
        // device up keeps the walk to the length a player would actually take to cross the hall.
        bs.refill();
        bs.fire();
        // The unlock work happens in the renderer, so a ping that is never drawn paints nothing.
        // Step *and* draw until both fronts have landed, exactly as the M1 generator does.
        for (let i = 0; i < 150; i++) {
          bs.step(1 / 120);
          bs.draw();
          const st = bs.stats();
          if (i > 4 && st.lidar.queued === 0 && st.paint.pending === 0) break;
        }
        pings++;
      }
    }
    return { pings, skipped, paint: bs.stats().paint, stops: wps.length };
  }, waypoints);
}
check('the walk visited every room', walk.skipped === 0, `${walk.stops} stops, ${walk.pings} pings`);
check(
  'the walk left a map behind',
  walk.paint.unlockedDots > 20000,
  `${walk.paint.unlockedDots} dots and ${walk.paint.unlockedEdges} edges held`,
);

// The map as the player owns it: dark, first person, standing back at the gate end.
await main.evaluate(() => {
  const bs = window.bs;
  bs.pose(20, 0, 250);
  bs.aim(250, -4);
  bs.step(0.1);
  bs.draw();
});
await save(
  'map-eyes.png',
  await main.screenshot(),
  "the accumulated map through the player's eyes after that walk — no lights, only what the lidar remembers",
);

// And the same memory from above, which is where "does it read as a floor plan" is decided.
await main.evaluate(() => {
  const bs = window.bs;
  bs.view('top');
  bs.topFocus(0, 0);
  bs.topHeight(50);
  bs.step(0.1);
  bs.draw();
});
const mapTop = await main.screenshot();
await save(
  'map-top.png',
  mapTop,
  'the same accumulated map from the ceiling with the lights still off: the rack runs, the passages between them and the landmarks are all in it',
);
const mapTopImg = decodePng(mapTop);
check(
  'the map from above is a plan, not a cloud',
  litFraction(mapTopImg, full(mapTopImg)).fraction > 0.02 && litFraction(mapTopImg, full(mapTopImg)).fraction < 0.5,
  `${(litFraction(mapTopImg, full(mapTopImg)).fraction * 100).toFixed(1)}% of the frame carries points`,
);

// --- determinism: the same seed twice, pixel for pixel ---------------------
/**
 * Both halves come from fresh pages that have done exactly the same thing, because "the same
 * seed" is a claim about generation: a page that has already been walked around in carries a
 * different simulation behind it and would prove nothing either way.
 *
 * The comparison is on decoded pixels rather than on the PNG file, because chromium's encoder
 * is free to pick different filters for identical images — file bytes would report a difference
 * that is not in the picture.
 *
 * The generator's own determinism is asserted exactly, on data, further up: the plan of every
 * seed is built twice and hashed. This check is about the *rendered* hall, and there the
 * swiftshader rasteriser is allowed a little noise of its own — a dozen edge pixels off by a
 * step or two, never a moved wall. So it demands: no pixel off by more than `SHADE_SLACK`, and
 * fewer than one in ten thousand pixels touched at all. A hall that generated differently would
 * blow through both by orders of magnitude.
 */
const SHADE_SLACK = 24;
const twinA = await open(SEEDS[0]);
const twinB = await open(SEEDS[0]);
const firstTop = await topDown(twinA, true);
const twinTop = await topDown(twinB, true);
await twinA.close();
await twinB.close();
await save('determinism-a.png', firstTop, `seed ${SEEDS[0]}, first run, lit from above`);
await save('determinism-b.png', twinTop, `seed ${SEEDS[0]}, a second run in a fresh page — the same hall, pixel for pixel`);
/** sha of the decoded pixels — used below to tell three seeds apart. */
const pixels = (buf) => createHash('sha256').update(decodePng(buf).data).digest('hex');
const imgA = decodePng(firstTop);
const imgB = decodePng(twinTop);
let touched = 0;
let worst = 0;
for (let i = 0; i < imgA.data.length; i += 4) {
  let d = 0;
  for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(imgA.data[i + c] - imgB.data[i + c]));
  if (d > 0) touched++;
  if (d > worst) worst = d;
}
const pixelCount = imgA.width * imgA.height;
check(
  'same seed, same hall — the second run draws the same picture',
  imgA.data.length === imgB.data.length && worst <= SHADE_SLACK && touched / pixelCount < 1e-4,
  `${touched} of ${pixelCount} pixels touched, worst channel off by ${worst}, sha ${createHash('sha256')
    .update(imgA.data)
    .digest('hex')
    .slice(0, 16)}`,
);

// --- three seeds, so nobody has to take "they differ" on trust --------------
const others = [];
for (const seed of [SEEDS[1], SEEDS[2]]) {
  const page = await open(seed);
  others.push({ seed, buf: await topDown(page, true), page });
}
await save('hall-top-seed-a.png', firstTop, `seed ${SEEDS[0]} — for comparison with the two below`);
for (const o of others) {
  await save(`hall-top-seed-${o.seed}.png`, o.buf, `seed ${o.seed} — different rooms, different passages, different landmarks`);
  await o.page.close();
}
check(
  'three seeds are three warehouses',
  new Set([firstTop, ...others.map((o) => o.buf)].map(pixels)).size === 3,
);

// --- what the hall costs ----------------------------------------------------
const perf = await main.evaluate(() => {
  const bs = window.bs;
  bs.view('fps');
  bs.lights(false);
  bs.clear();
  bs.pose(-24, -14, 60);
  bs.step(3);
  const rest = bs.stats();
  const frames = [];
  for (let i = 0; i < 90; i++) {
    const t = performance.now();
    bs.step(1 / 60);
    bs.draw();
    frames.push(performance.now() - t);
  }
  frames.sort((a, b) => a - b);
  return {
    boxes: bs.boxes,
    buildMs: bs.buildMs(),
    paint: rest.paint,
    props: rest.props,
    median: frames[Math.floor(frames.length / 2)],
    p95: frames[Math.floor(frames.length * 0.95)],
    calls: rest.calls,
  };
});
console.log(
  `[world] perf: ${perf.boxes} static boxes, hall build ${perf.buildMs?.toFixed?.(1) ?? perf.buildMs} ms, ` +
    `props ${perf.props ? `${perf.props.bodies} bodies / ${perf.props.awake} awake / step ${perf.props.stepMs.toFixed(2)} ms` : 'n/a'}, ` +
    `lidar lattice ${perf.paint.dots} dots / ${perf.paint.edges} edges built in ${perf.paint.buildMs.toFixed(0)} ms, ` +
    `frame median ${perf.median.toFixed(2)} ms p95 ${perf.p95.toFixed(2)} ms, ${perf.calls} draw calls`,
);
check('the hall sleeps when nobody touches it', !perf.props || perf.props.awake === 0, `${perf.props?.awake ?? 0} awake`);
check('frames stay under the 16.7 ms budget', perf.median < 16.7, `median ${perf.median.toFixed(2)} ms`);

await main.close();
await drawPage.close();
await browser.close();

// --- contact page -----------------------------------------------------------
const html = `<!doctype html><meta charset="utf-8"><title>M5 — the map</title>
<style>body{background:#0b0d10;color:#c8d2dc;font:14px/1.5 system-ui,sans-serif;margin:0;padding:32px}
h1{font-weight:600;letter-spacing:.04em}figure{margin:0 0 40px}img{max-width:100%;border:1px solid #263039}
figcaption{padding-top:8px;color:#8fa0af}</style>
<h1>M5 — rooms, passages, landmarks</h1>
${shots
  .map((s) => `<figure><img src="${s.name}"><figcaption><b>${s.name}</b> — ${s.note} <i>(lit ${(s.lit * 100).toFixed(1)}%)</i></figcaption></figure>`)
  .join('\n')}`;
await writeFile(join(outDir, 'index.html'), html);

console.log(`[world] ${shots.length} frames -> ${outDir}`);
if (failures.length > 0) {
  console.error(`[world] ${failures.length} FAILURES`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('[world] all checks passed');

/**
 * The painter, injected into the drawing page. Kept as one string so the tool stays a single
 * file: it is a debug view, not a product.
 */
function PLAN_PAINTER() {
  return String.raw`
const GLYPH = {
  silo: 'circle', 'twin columns': 'twin', ziggurat: 'stepped', 'high rack': 'bar',
  'pipe stack': 'pipes', 'buttress column': 'cross', gate: 'gate', spawn: 'spawn',
};
function drawPlan(ctx, p, hall, box, opts) {
  const { x0, y0, w, h } = box;
  const s = Math.min(w / (hall.halfX * 2), h / (hall.halfZ * 2));
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const X = (wx) => cx + wx * s;
  const Y = (wz) => cy + wz * s;
  ctx.save();
  ctx.fillStyle = '#0f1318';
  ctx.fillRect(X(-hall.halfX), Y(-hall.halfZ), hall.halfX * 2 * s, hall.halfZ * 2 * s);
  ctx.strokeStyle = '#3d4b57';
  ctx.lineWidth = 2;
  ctx.strokeRect(X(-hall.halfX), Y(-hall.halfZ), hall.halfX * 2 * s, hall.halfZ * 2 * s);

  // rooms
  for (const r of p.rooms) {
    ctx.fillStyle = r.character === 'open' ? '#161d24' : '#131920';
    ctx.fillRect(X(r.minX), Y(r.minZ), (r.maxX - r.minX) * s, (r.maxZ - r.minZ) * s);
    ctx.strokeStyle = '#2b3742';
    ctx.lineWidth = 1;
    ctx.strokeRect(X(r.minX), Y(r.minZ), (r.maxX - r.minX) * s, (r.maxZ - r.minZ) * s);
    if (opts.labels) {
      ctx.fillStyle = '#7f97ab';
      ctx.textAlign = 'center';
      ctx.font = '600 12px system-ui,sans-serif';
      ctx.fillText(r.name, X(r.cx), Y(r.cz) - 4);
      ctx.font = '10px system-ui,sans-serif';
      ctx.fillStyle = '#5b6d7d';
      ctx.fillText(
        (r.maxX - r.minX).toFixed(0) + ' x ' + (r.maxZ - r.minZ).toFixed(0) + ' m',
        X(r.cx), Y(r.cz) + 10,
      );
    }
  }

  // dividers: the racking that makes the rooms rooms
  ctx.fillStyle = '#46586a';
  for (const d of p.dividers) {
    if (d.axis === 'x') {
      ctx.fillRect(X(d.at - d.thickness / 2), Y(d.from), d.thickness * s, (d.to - d.from) * s);
    } else {
      ctx.fillRect(X(d.from), Y(d.at - d.thickness / 2), (d.to - d.from) * s, d.thickness * s);
    }
  }
  // passages: punched back out of the racking, and labelled by what they join
  for (const g of p.passages) {
    ctx.fillStyle = '#0f1318';
    if (g.axis === 'x') ctx.fillRect(X(g.x - 1), Y(g.z - g.width / 2), 2 * s, g.width * s);
    else ctx.fillRect(X(g.x - g.width / 2), Y(g.z - 1), g.width * s, 2 * s);
    ctx.strokeStyle = '#d99a3c';
    ctx.lineWidth = opts.labels ? 2 : 1.2;
    ctx.beginPath();
    if (g.axis === 'x') {
      ctx.moveTo(X(g.x), Y(g.z - g.width / 2));
      ctx.lineTo(X(g.x), Y(g.z + g.width / 2));
    } else {
      ctx.moveTo(X(g.x - g.width / 2), Y(g.z));
      ctx.lineTo(X(g.x + g.width / 2), Y(g.z));
    }
    ctx.stroke();
    if (opts.labels) {
      ctx.fillStyle = '#c08a3a';
      ctx.font = '9px system-ui,sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(g.name, X(g.x) + 5, Y(g.z) - 3);
    }
  }

  // landmarks
  for (const l of p.landmarks) {
    const gx = X(l.x);
    const gy = Y(l.z);
    const r = Math.max(4, (l.radius || 2) * s);
    ctx.strokeStyle = '#69d1c8';
    ctx.fillStyle = 'rgba(105,209,200,0.16)';
    ctx.lineWidth = 2;
    const glyph = GLYPH[l.kind] || 'circle';
    ctx.beginPath();
    if (glyph === 'twin') {
      ctx.arc(gx - r * 0.6, gy, r * 0.5, 0, 7); ctx.moveTo(gx + r * 1.1, gy);
      ctx.arc(gx + r * 0.6, gy, r * 0.5, 0, 7);
    } else if (glyph === 'stepped') {
      ctx.rect(gx - r, gy - r, r * 2, r * 2); ctx.rect(gx - r * 0.55, gy - r * 0.55, r * 1.1, r * 1.1);
    } else if (glyph === 'bar') {
      ctx.rect(gx - r * 1.6, gy - r * 0.5, r * 3.2, r);
    } else if (glyph === 'pipes') {
      for (let i = -1; i <= 1; i++) { ctx.moveTo(gx + i * r * 0.8 + r * 0.35, gy); ctx.arc(gx + i * r * 0.8, gy, r * 0.35, 0, 7); }
    } else if (glyph === 'cross') {
      ctx.moveTo(gx - r, gy); ctx.lineTo(gx + r, gy); ctx.moveTo(gx, gy - r); ctx.lineTo(gx, gy + r);
    } else if (glyph === 'gate') {
      ctx.rect(gx - r * 0.4, gy - r * 1.6, r * 0.8, r * 3.2);
    } else if (glyph === 'spawn') {
      ctx.moveTo(gx, gy - r); ctx.lineTo(gx + r, gy + r); ctx.lineTo(gx - r, gy + r); ctx.closePath();
    } else {
      ctx.arc(gx, gy, r, 0, 7);
    }
    ctx.fill();
    ctx.stroke();
    if (opts.labels) {
      ctx.fillStyle = '#8fe4dc';
      ctx.font = '600 11px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(l.name + '  (' + l.top.toFixed(0) + ' m)', gx, gy - r - 6);
    }
  }

  // spawn and gate, always drawn, labels or not
  ctx.strokeStyle = '#e0e6ec';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(X(p.spawn.x), Y(p.spawn.z), 4, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.arc(X(p.gate.x), Y(p.gate.z), 4, 0, 7); ctx.stroke();

  // north arrow — the compass in the room names means nothing without it
  ctx.strokeStyle = '#7f97ab';
  ctx.fillStyle = '#7f97ab';
  ctx.beginPath();
  ctx.moveTo(x0 + 18, y0 + 34); ctx.lineTo(x0 + 18, y0 + 12); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x0 + 18, y0 + 8); ctx.lineTo(x0 + 13, y0 + 18); ctx.lineTo(x0 + 23, y0 + 18); ctx.closePath();
  ctx.fill();
  ctx.font = '10px system-ui,sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('N', x0 + 26, y0 + 18);
  ctx.restore();
}

window.paintPlans = function (payload) {
  document.body.innerHTML = '';
  const c = document.createElement('canvas');
  c.width = innerWidth;
  c.height = innerHeight;
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.textBaseline = 'middle';
  const hall = payload.hall;
  if (payload.mode === 'single') {
    const p = payload.plans[0];
    ctx.fillStyle = '#d7e0e8';
    ctx.font = '600 18px system-ui,sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('seed ' + p.seed, 24, 26);
    ctx.fillStyle = '#8fa0af';
    ctx.font = '13px system-ui,sans-serif';
    ctx.fillText(
      p.plan.rooms.length + ' rooms   ' + p.plan.passages.length + ' passages   ' +
        p.plan.landmarks.length + ' landmarks   ' + p.boxes + ' static boxes   ' +
        'floor reachable ' + (p.plan.reach.openFraction * 100).toFixed(1) + '%',
      24, 50,
    );
    drawPlan(ctx, p.plan, hall, { x0: 70, y0: 80, w: c.width - 140, h: c.height - 110 }, { labels: true });
  } else {
    const cols = 5;
    const rows = Math.ceil(payload.plans.length / cols);
    const cw = c.width / cols;
    const ch = (c.height - 34) / rows;
    ctx.fillStyle = '#d7e0e8';
    ctx.font = '600 16px system-ui,sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('ten seeds — rooms outlined, racking solid, passages amber, landmarks teal', 16, 18);
    payload.plans.forEach((p, i) => {
      const x0 = (i % cols) * cw + 8;
      const y0 = 34 + Math.floor(i / cols) * ch + 18;
      ctx.fillStyle = '#8fa0af';
      ctx.font = '11px system-ui,sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(
        'seed ' + p.seed + ' — ' + p.plan.rooms.length + ' rooms, ' + p.plan.passages.length +
          ' passages, ' + p.plan.landmarks.length + ' landmarks',
        x0, y0 - 8,
      );
      drawPlan(ctx, p.plan, hall, { x0, y0, w: cw - 30, h: ch - 30 }, { labels: false });
    });
  }
};
`;
}
