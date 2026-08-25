/**
 * M4 keyframes — the pack.
 *
 * A separate generator from `tools/shoot.mjs` on purpose: that file is being extended by the
 * M3 pass at the same time as this one, and two agents appending to one 900-line script is a
 * merge conflict with no upside. Same conventions, same determinism rules, its own output
 * directory:
 *
 *   node tools/spiders.mjs [dist/index.html] [out/spiders]
 *
 * Every frame is shot twice where the pair means anything: "как есть на самом деле" (lights on,
 * overhead, state overlay) and "как видит игрок" (black hall, sound marks only). The whole
 * milestone is about a thing you cannot see, so the lit frame is the evidence and the dark
 * frame is the experience.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, meanLuminance as meanRect, litFraction as litRect } from './png.mjs';

const whole = (img) => ({ x: 0, y: 0, w: img.width, h: img.height });
const litFraction = (img) => litRect(img, whole(img)).fraction;
const meanLuminance = (img) => meanRect(img, whole(img)).mean;

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
const outDir = resolve(process.argv[3] ?? 'out/spiders');

if (!existsSync(htmlPath)) {
  console.error(`[spiders] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
for (const f of await readdir(outDir)) {
  if (f.endsWith('.png')) await unlink(join(outDir, f));
}

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
  console.log(`[spiders] ${line}`);
  if (!ok) failures.push(line);
}

const shots = [];
async function shot(name, note) {
  const buf = await page.screenshot({ path: join(outDir, name), timeout: 180000 });
  const img = decodePng(buf);
  shots.push({ name, note, lit: litFraction(img), mean: meanLuminance(img) });
  console.log(
    `[spiders] shot ${name}  lit=${litFraction(img).toFixed(4)} mean=${meanLuminance(img).toFixed(2)}`,
  );
  return img;
}

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

/** Runs `sec` of simulation at the fixed step, drawing every `every` ticks. */
const advance = (sec, every = 8) =>
  page.evaluate(
    ([s, e]) => {
      const bs = window.bs;
      const n = Math.round(s * 120);
      for (let i = 0; i < n; i++) {
        bs.step(1 / 120);
        if (i % e === 0) bs.draw();
      }
      bs.draw();
    },
    [sec, every],
  );

/**
 * The player paces on the spot: a step forward, a step back, over and over. This is the whole
 * input the hunt needs — he is not running away, he is just being audible, which is exactly the
 * situation the concept says gets you killed.
 */
const pace = (sec) =>
  page.evaluate(
    ([s]) => {
      const bs = window.bs;
      const n = Math.round(s * 120);
      for (let i = 0; i < n; i++) {
        const phase = Math.floor(i / 84) % 2;
        if (i % 84 === 0) {
          bs.keys([phase === 0 ? 'KeyW' : 'KeyS'], [phase === 0 ? 'KeyS' : 'KeyW']);
        }
        bs.step(1 / 120);
        if (i % 24 === 0) bs.draw();
      }
      bs.keys([], ['KeyW', 'KeyS']);
      bs.draw();
    },
    [sec],
  );

/**
 * Paces until at least `min` spiders are hunting (stalk or creep) but stops the instant the pack
 * escalates past that, so the "circling" frame is caught in the window where the hunt is on and
 * the charge is not. Timing this by hand is brittle: the pack escalates in a few seconds.
 */
const paceUntilHunting = (min, minSeconds = 0, limit = 30) =>
  page.evaluate(
    ([want, floorSec, max]) => {
      const bs = window.bs;
      const n = Math.round(max * 120);
      let best = null;
      for (let i = 0; i < n; i++) {
        const phase = Math.floor(i / 84) % 2;
        if (i % 84 === 0) {
          bs.keys([phase === 0 ? 'KeyW' : 'KeyS'], [phase === 0 ? 'KeyS' : 'KeyW']);
        }
        bs.step(1 / 120);
        if (i % 24 === 0) bs.draw();
        const st = bs.spiders.stats();
        const hunting = st.byState.stalk + st.byState.creep;
        const hot = st.byState.rally + st.byState.commit;
        if (hot > 0) break;
        if (hunting >= want) best = { seconds: i / 120, stats: st };
        if (best !== null && i / 120 >= floorSec) break;
      }
      bs.keys([], ['KeyW', 'KeyS']);
      bs.draw();
      return best ?? { seconds: max, stats: bs.spiders.stats() };
    },
    [min, minSeconds, limit],
  );

/** Paces until the pack reaches `mode`, or gives up. Returns the stats at the moment it did. */
const paceUntil = (mode, limit = 40) =>
  page.evaluate(
    ([want, max]) => {
      const bs = window.bs;
      const n = Math.round(max * 120);
      for (let i = 0; i < n; i++) {
        const phase = Math.floor(i / 84) % 2;
        if (i % 84 === 0) {
          bs.keys([phase === 0 ? 'KeyW' : 'KeyS'], [phase === 0 ? 'KeyS' : 'KeyW']);
        }
        bs.step(1 / 120);
        if (i % 24 === 0) bs.draw();
        if (bs.spiders.stats().mode === want) {
          bs.keys([], ['KeyW', 'KeyS']);
          bs.draw();
          return { reached: true, seconds: i / 120, stats: bs.spiders.stats() };
        }
      }
      bs.keys([], ['KeyW', 'KeyS']);
      bs.draw();
      return { reached: false, seconds: max, stats: bs.spiders.stats() };
    },
    [mode, limit],
  );

const spiderStats = () => page.evaluate(() => window.bs.spiders.stats());
const spiderList = () => page.evaluate(() => window.bs.spiders.list());

/** Rings the pack around a point at a fixed radius — a deterministic start for every scenario. */
const ring = (x, z, radius) =>
  page.evaluate(
    ([cx, cz, r]) => {
      const bs = window.bs;
      const n = bs.spiders.list().length;
      let placed = 0;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        if (bs.spiders.place(i, cx + Math.cos(a) * r, cz + Math.sin(a) * r)) placed++;
      }
      return placed;
    },
    [x, z, radius],
  );

/** The lit overhead "as it really is" camera, pinned so two frames are comparable. */
async function truthCam(x, z, height = 34) {
  await call('lights', true);
  await call('view', 'top');
  await call('topFocus', x, z);
  await call('topHeight', height);
  await call('hud', true);
  await call('spiders.overlay', true);
}

/** The player's own eyes: black hall, sound marks, no HUD. */
async function playerCam(yawDeg = 0, pitchDeg = 0) {
  await call('spiders.overlay', false);
  await call('hud', false);
  await call('lights', false);
  await call('view', 'player');
  await call('aim', yawDeg, pitchDeg);
  await call('markers', true);
}

// ---------------------------------------------------------------------------
const url = `${pathToFileURL(htmlPath).href}?harness=1&seed=20260824`;
console.log(`[spiders] ${url}`);
await page.goto(url);
await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 30000 });
await call('audio', false);
await call('hud', false);
// Let the clutter finish falling: the settle is 100-odd real impacts, and every one of them is a
// real sound that would scatter the pack before the first frame.
await advance(3, 8);

const boot = await spiderStats();
console.log(`[spiders] boot: ${boot.count} spiders, mode ${boot.mode}`);
notes.push(
  `${boot.count} spiders, seed 20260824, fixed 120 Hz step. Hearing is the bus and nothing else; ` +
    `the lidar is not on the bus, so pinging never gives a spider anything.`,
);

// ===========================================================================
// 1. The pack circles.
// ===========================================================================
const HOME = { x: 2, z: 2 };
await call('pose', HOME.x, HOME.z, 90);
await call('spiders.spawn', 14);
// 8 m: a walking footfall carries 9 m, so the whole ring is inside earshot and the pack
// hunts as a pack. Any wider and half of them simply never hear him and stay idle.
await ring(HOME.x, HOME.z, 8);
await advance(0.4, 4);
const hunt = await paceUntilHunting(8, 5, 30);

const circling = await spiderStats();
const circlingList = await spiderList();
const ringDists = circlingList
  .map((s) => Math.hypot(s.x - HOME.x, s.z - HOME.z))
  .sort((a, b) => a - b);

await truthCam(HOME.x, HOME.z, 30);
await advance(0.02, 1);
await shot(
  '01-circling-truth.png',
  'as it really is: nine seconds after the player started pacing on the spot. The pack has beliefs (the small spheres) clustered on him, every spider is walking an orbit slot around that belief rather than at it, and the state colours are still cold — blue stalk, green creep. Nobody has committed to anything',
);
check(
  'the pack is circling, not charging',
  circling.byState.stalk + circling.byState.creep >= 8 &&
    circling.byState.rally + circling.byState.commit === 0,
  `stalk ${circling.byState.stalk} · creep ${circling.byState.creep} · rally ${circling.byState.rally} · ` +
    `commit ${circling.byState.commit} after ${hunt.seconds.toFixed(1)} s of pacing`,
);
check(
  'and it is a ring, not a queue',
  ringDists[ringDists.length - 1] - ringDists[0] < 10,
  `nearest ${ringDists[0].toFixed(1)} m, furthest ${ringDists[ringDists.length - 1].toFixed(1)} m from the player`,
);

await playerCam(90, 0);
await advance(0.02, 1);
const dark1 = await shot(
  '02-circling-player.png',
  'the identical moment as the player experiences it: a black hall with a handful of soft marks in it. That is a stalking pack — a footfall carries about a metre and a half and a bored spider clicks once every ten seconds, so almost nothing reaches you. The silence is the information',
);
check(
  'a stalking pack is nearly invisible',
  litFraction(dark1) < 0.06,
  `lit=${litFraction(dark1).toFixed(4)} of the frame, chatter ${circling.chatter.toFixed(1)} clicks/s`,
);
const quietChatter = circling.chatter;

// ===========================================================================
// 2. The moment it decides.
// ===========================================================================
const rally = await paceUntil('rally', 40);
const rallyStats = rally.stats;
await truthCam(HOME.x, HOME.z, 24);
await advance(0.02, 1);
await shot(
  '03-rally-truth.png',
  'the decision. Quorum reached: enough of them are brave enough and close enough at the same time, so the pack has gone to RALLY — amber in the overlay. They stop, hold their ring at knife range and shout. This state exists to be heard: it is the second and a half of warning the player gets',
);
check(
  'the pack rallies before it charges',
  rally.reached && rallyStats.byState.rally >= 3,
  `${rallyStats.byState.rally} rallying after ${rally.seconds.toFixed(1)} s of pacing`,
);

await playerCam(90, 0);
await advance(1.1, 2);
const rallyDark = await shot(
  '04-rally-player.png',
  'the same rally from inside it. This is the frame the whole "щёлканье — это геймплей" rule is for: the room fills with click marks, close and all around, several a second instead of one every few seconds. Nothing is lit — every blob is a click that actually happened at that point',
);
const rallyChatter = (await spiderStats()).chatter;
check(
  'a rally is loud, a stalk is not',
  rallyChatter > quietChatter * 1.8,
  `${quietChatter.toFixed(1)} clicks/s circling vs ${rallyChatter.toFixed(1)} clicks/s rallying`,
);
check(
  'and it shows on the player’s screen',
  litFraction(rallyDark) > litFraction(dark1),
  `lit ${litFraction(dark1).toFixed(4)} circling vs ${litFraction(rallyDark).toFixed(4)} rallying`,
);

const commit = await paceUntil('commit', 12);
await truthCam(HOME.x, HOME.z, 20);
await advance(0.02, 1);
await shot(
  '05-commit-truth.png',
  'and in they go. Red is COMMIT: the orbit slot is dropped, the goal line points straight at the belief, and they run. A spider that reaches him bites once, screeches (the loudest noise it can make) and bounces off into RECOIL — purple. They are small and frightened; nobody stays on top of you',
);
const committed = await spiderStats();
check(
  'the pack commits together',
  committed.byState.commit + committed.byState.recoil >= 4,
  `commit ${committed.byState.commit} · recoil ${committed.byState.recoil} · ${committed.strikes} strikes so far`,
);
await advance(2.5, 4);
const struck = await spiderStats();
check(
  'and it actually reaches him',
  struck.strikes > 0,
  `${struck.strikes} strikes, then they bounce off — a strike costs the spider 70% of its nerve`,
);

// ===========================================================================
// 3. A loud noise scatters them.
// ===========================================================================
const beforeBang = await spiderStats();
const beforeList = await spiderList();
await truthCam(HOME.x, HOME.z, 20);
await advance(0.02, 1);
await shot(
  '06-before-the-bang.png',
  'the instant before the trigger is pulled: the pack is on him, red and committed, and every belief sphere is sitting on the player',
);

// A real gunshot on the real bus — 90 m of notice. Nothing here is scripted at the spiders.
await call('aim', 90, 0);
const trace = await call('shoot');
await advance(0.5, 4);
const afterBang = await spiderStats();
const afterList = await spiderList();
await truthCam(HOME.x, HOME.z, 26);
await advance(0.02, 1);
await shot(
  '07-after-the-bang.png',
  'half a second later. Same camera. Every spider is blue-lilac FLEE or orange PANIC, the goal lines all point away, and the belief spheres have jumped onto the muzzle — they know exactly where you are now, and that is the trade: the shot bought you four seconds of nobody being brave, and told all fourteen of them your address',
);

const shotX = trace ? trace.ox : 0;
const shotZ = trace ? trace.oz : 0;
const beliefBefore =
  beforeList.reduce((a, s) => a + Math.hypot(s.belief.x - shotX, s.belief.z - shotZ), 0) /
  beforeList.length;
const beliefAfter =
  afterList.reduce((a, s) => a + Math.hypot(s.belief.x - shotX, s.belief.z - shotZ), 0) /
  afterList.length;
check(
  'the bang scatters the pack',
  afterBang.byState.flee + afterBang.byState.panic >= 8,
  `flee ${afterBang.byState.flee} · panic ${afterBang.byState.panic} (was commit ${beforeBang.byState.commit})`,
);
check(
  'and it spends their nerve',
  afterBang.meanCourage < beforeBang.meanCourage,
  `courage ${beforeBang.meanCourage.toFixed(2)} before, ${afterBang.meanCourage.toFixed(2)} after`,
);
check(
  'while the belief snaps onto the noise',
  beliefAfter <= beliefBefore + 0.5,
  `mean belief was ${beliefBefore.toFixed(2)} m from the muzzle, now ${beliefAfter.toFixed(2)} m`,
);

await playerCam(90, 0);
await advance(0.02, 1);
await shot(
  '08-after-the-bang-player.png',
  'what he actually saw for his money: the gunshot mark swallowing the near half of the hall, bullet-hit marks stippled where the round landed, and a scattering pack he cannot see running away from all of it',
);

// ===========================================================================
// 4. Up the rack.
// ===========================================================================
const rack = await page.evaluate(() => {
  // Something standing on the floor, tall enough that walking round it is the obvious move —
  // which is exactly the choice the climb is meant to override.
  const cands = window.bs
    .solids()
    .filter((b) => b[1] < 0.15 && b[4] > 1.0 && b[4] < 2.6 && Math.abs(b[0]) < 28 && Math.abs(b[2]) < 18);
  cands.sort((a, b) => b[4] - a[4]);
  const b = cands[0];
  return b ? { minX: b[0], maxY: b[4], minZ: b[2], maxX: b[3], maxZ: b[5] } : null;
});
check('the hall has something worth climbing', rack !== null, rack ? `top at ${rack.maxY.toFixed(1)} m` : '');

let climbStats = null;
if (rack !== null) {
  const cx = (rack.minX + rack.maxX) / 2;
  const cz = (rack.minZ + rack.maxZ) / 2;
  // Player on the far side of it, the pack hard against the near face. The short way to him is
  // over the top, and a spider takes the short way.
  await call('spiders.spawn', 14);
  await call('pose', cx, cz + (rack.maxZ - rack.minZ) / 2 + 2.5, 0);
  await page.evaluate(
    ([x, z]) => {
      for (let i = 0; i < 14; i++) {
        window.bs.spiders.place(i, x - 2.4 + (i % 6) * 0.9, z - 1.1 - Math.floor(i / 6) * 0.9);
      }
    },
    [cx, rack.minZ],
  );
  await advance(0.3, 2);

  climbStats = await page.evaluate(() => {
    const bs = window.bs;
    let best = { y: 0, id: -1 };
    for (let i = 0; i < 120 * 26; i++) {
      const phase = Math.floor(i / 84) % 2;
      if (i % 84 === 0) bs.keys([phase === 0 ? 'KeyW' : 'KeyS'], [phase === 0 ? 'KeyS' : 'KeyW']);
      bs.step(1 / 120);
      if (i % 24 === 0) bs.draw();
      if (i % 12 === 0) {
        for (const s of bs.spiders.list()) if (s.y > best.y) best = { y: s.y, id: s.id, t: i / 120 };
      }
      if (best.y > 0.9) break;
    }
    bs.keys([], ['KeyW', 'KeyS']);
    bs.draw();
    return { best, elevated: bs.spiders.list().filter((s) => s.elevated).length, stats: bs.spiders.stats() };
  });

  const high = (await spiderList()).slice().sort((a, b) => b.y - a.y)[0];
  // A close, low, lit camera: from overhead a climb is invisible, and this frame exists to
  // show a spider standing on something.
  await call('lights', true);
  await call('spiders.overlay', true);
  await call('hud', true);
  await call('view', 'top');
  await call('topFocus', high.x, high.z);
  await call('topHeight', 9);
  await advance(0.02, 1);
  await shot(
    '09-climb-truth.png',
    `as it really is, close in from above: spider #${high.id} is standing at ${high.y.toFixed(2)} m — on top of the thing, not beside it. There is no pathfinder and no climb animation: it walked into a face, felt free air above it and went up, which is why a warehouse full of racks is their terrain and not yours`,
  );

  await playerCam(0, -6);
  await advance(1.2, 3);
  await shot(
    '10-climb-player.png',
    'the same spiders from the floor. Steps taken on steel are louder than steps on concrete, so a pack working across the racking above you leaves a line of marks in mid-air — the only time footfalls ever tell you anything',
  );

  check(
    'a spider climbs onto the rack',
    climbStats.best.y > 0.9,
    `highest spider ${climbStats.best.y.toFixed(2)} m (obstacle top ${rack.maxY.toFixed(1)} m) after ${(climbStats.best.t ?? 0).toFixed(1)} s`,
  );
  check(
    'and it is not a fluke of one body',
    climbStats.elevated >= 1,
    `${climbStats.elevated} of 14 off the concrete at the moment of the shot`,
  );
}

// ===========================================================================
// 5. What it costs.
// ===========================================================================
const perf = await page.evaluate(() => {
  const bs = window.bs;
  const sample = (label) => {
    const runs = [];
    for (let i = 0; i < 600; i++) {
      bs.step(1 / 120);
      if (i % 24 === 0) bs.draw();
      runs.push(bs.spiders.stats().updateMs);
    }
    const sorted = runs.slice().sort((a, b) => a - b);
    return {
      label,
      count: bs.spiders.stats().count,
      mean: runs.reduce((a, b) => a + b, 0) / runs.length,
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted[sorted.length - 1],
      decisions: bs.spiders.stats().decisions,
    };
  };
  const out = [];
  bs.spiders.spawn(14);
  out.push(sample('14 spiders'));
  bs.spiders.spawn(48);
  out.push(sample('48 spiders'));
  bs.spiders.spawn(96);
  out.push(sample('96 spiders'));
  bs.spiders.spawn(14);
  return out;
});
for (const p of perf) {
  console.log(
    `[spiders] ${p.label}: mean ${p.mean.toFixed(3)} ms · p95 ${p.p95.toFixed(3)} ms · max ${p.max.toFixed(3)} ms · ${p.decisions} steering decisions per tick`,
  );
}
notes.push(
  `cost of the whole AI per simulation tick (120 Hz): ` +
    perf.map((p) => `${p.label} ${p.mean.toFixed(3)} ms (p95 ${p.p95.toFixed(3)})`).join(' · ') +
    `. Hearing is event-driven, not polled; steering is sliced by index so only about a fifteenth ` +
    `of the pack re-decides on any tick (${perf[0].decisions} of ${perf[0].count} at the sample above).`,
);
check(
  'the pack is cheap enough to be a pack',
  perf[1].p95 < 1.0,
  `48 spiders cost ${perf[1].p95.toFixed(3)} ms at p95 out of an 8.3 ms tick`,
);

// --- contact sheet ---------------------------------------------------------
const html = `<!doctype html><meta charset="utf-8"><title>BLIND SPOT M4 — spiders</title>
<style>body{background:#0a0d10;color:#cfdbe4;font:13px/1.5 ui-monospace,monospace;margin:24px}
h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#ffd166}
figure{margin:0 0 28px}img{width:100%;max-width:1280px;border:1px solid #223}
figcaption{padding:6px 2px;color:#8fa2b0}</style>
<h1>BLIND SPOT — M4 keyframes: the pack</h1>
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
  console.log(`[spiders] console errors:\n  ${consoleErrors.slice(0, 8).join('\n  ')}`);
  failures.push(`${consoleErrors.length} console error(s)`);
}
console.log(`[spiders] ${shots.length} frames -> ${outDir}`);
if (failures.length > 0) {
  console.error(`[spiders] ${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('[spiders] all checks passed');
