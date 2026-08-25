/**
 * M5 keyframes — the player's HUD: damage, direction, and the noise compass.
 *
 *   node tools/hud.mjs [dist/index.html] [out/hud]
 *
 * Its own generator, for the same reason `tools/spiders.mjs` is: two agents appending to one
 * script is a merge conflict with no upside. Same conventions — fixed seed, fixed 120 Hz step,
 * no wall clock anywhere — and the same two-frame habit where it means anything: "как есть на
 * самом деле" (lit, overhead, overlays) and "как видит игрок" (black hall, his own HUD only).
 *
 * The hard part of proving anything here is that the subject is a *comparison*: a wedge is only
 * evidence if the identical frame without it is next to it. So the A/B pairs below are shot at
 * the same simulation time, with nothing between them but the switch.
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
const outDir = resolve(process.argv[3] ?? 'out/hud');

if (!existsSync(htmlPath)) {
  console.error(`[hud] build not found: ${htmlPath} (run \`npm run build\` first)`);
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
  console.log(`[hud] ${line}`);
  if (!ok) failures.push(line);
}

const shots = [];
async function shot(name, note) {
  const buf = await page.screenshot({ path: join(outDir, name), timeout: 180000 });
  const img = decodePng(buf);
  shots.push({ name, note, lit: litFraction(img), mean: meanLuminance(img) });
  console.log(`[hud] shot ${name}  lit=${litFraction(img).toFixed(4)} mean=${meanLuminance(img).toFixed(2)}`);
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

/** Draws one frame without advancing the clock — the A/B pairs depend on this. */
const redraw = () => page.evaluate(() => window.bs.draw());
const vitals = () => page.evaluate(() => window.bs.vitals.state());

/** The lit overhead truth camera, pinned so two frames are comparable. */
async function truthCam(x, z, height = 22) {
  await call('lights', true);
  await call('view', 'top');
  await call('topFocus', x, z);
  await call('topHeight', height);
  await call('hud', true);
  await call('spiders.overlay', true);
}

/** The player's own eyes: black hall, his marks, his HUD, no debug text. */
async function playerCam(yawDeg = 0, pitchDeg = 0) {
  await call('spiders.overlay', false);
  await call('hud', false);
  await call('lights', false);
  await call('view', 'player');
  if (yawDeg !== null) await call('aim', yawDeg, pitchDeg);
  await call('markers', true);
}

// ---------------------------------------------------------------------------
const url = `${pathToFileURL(htmlPath).href}?harness=1&seed=20260824`;
console.log(`[hud] ${url}`);
await page.goto(url);
await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 30000 });
await call('audio', false);
await call('hud', false);
await advance(3, 8);
notes.push(
  'seed 20260824, fixed 120 Hz step, damage model: 100 hp, 14 hp a bite, 0.35 s of grace ' +
    'between bites, 1.4 hp/s trickling back after twelve quiet seconds.',
);

// ===========================================================================
// 1. A real bite. No scripting: the pack is rung around the player, he paces on
//    the spot until somebody commits, and the frame is taken on the tick the
//    first strike lands.
// ===========================================================================
const HOME = { x: 2, z: 2 };
await call('pose', HOME.x, HOME.z, 90);
await call('spiders.spawn', 14);
await page.evaluate(
  ([cx, cz, r]) => {
    const n = window.bs.spiders.list().length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      window.bs.spiders.place(i, cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
  },
  [HOME.x, HOME.z, 7],
);
await call('vitals.reset');
await call('vitals.compass', false);

const firstBite = await page.evaluate(() => {
  const bs = window.bs;
  for (let i = 0; i < 120 * 60; i++) {
    const phase = Math.floor(i / 84) % 2;
    if (i % 84 === 0) bs.keys([phase === 0 ? 'KeyW' : 'KeyS'], [phase === 0 ? 'KeyS' : 'KeyW']);
    bs.step(1 / 120);
    if (i % 24 === 0) bs.draw();
    const v = bs.vitals.state();
    if (v.bites > 0) {
      bs.keys([], ['KeyW', 'KeyS']);
      bs.draw();
      // Whoever is closest at the tick of the bite is the one that bit him.
      const p = bs.stats().pos;
      const near = bs.spiders
        .list()
        .map((s) => ({ id: s.id, d: Math.hypot(s.x - p[0], s.z - p[2]), x: s.x, z: s.z, state: s.state }))
        .sort((a, b) => a.d - b.d)[0];
      return { seconds: i / 120, v, near, aim: bs.stats().aim, pos: p };
    }
  }
  bs.keys([], ['KeyW', 'KeyS']);
  bs.draw();
  return null;
});
check('a spider actually bites him', firstBite !== null, firstBite ? `after ${firstBite.seconds.toFixed(1)} s of pacing` : 'no strike in 60 s');

if (firstBite !== null) {
  await truthCam(firstBite.pos[0], firstBite.pos[2], 14);
  await redraw();
  await shot(
    '01-bite-truth.png',
    `as it really is, one tick after the first bite: spider #${firstBite.near.id} is ${firstBite.near.d.toFixed(2)} m from him — ` +
      `that is the strike range, not a near miss. He is on ${Math.ceil(firstBite.v.health)} hp of 100. Nothing about the pack changed; ` +
      `the swarm reports the strike and has no idea what it costs`,
  );

  await playerCam(null);
  await redraw();
  const bitten = await shot(
    '02-bite-player.png',
    'the same tick from inside his head. The wedge on the inner ring is the bearing to the thing that bit him — world-locked, so ' +
      'turning to face it walks the wedge to the top of the screen — and the frame has closed down at the edges. No red wash: in a ' +
      'game whose default frame is black, a full-screen flash erases the map, the marks and the muzzle flash all at once',
  );

  const st = await vitals();
  const mark = st.marks[st.marks.length - 1];
  const trueBearing = (Math.atan2(firstBite.near.x - firstBite.pos[0], firstBite.near.z - firstBite.pos[2]) * 180) / Math.PI;
  const wedge = (mark.bearing * 180) / Math.PI;
  const err = Math.abs(((wedge - trueBearing + 540) % 360) - 180);
  check(
    'the wedge points at the spider that bit him',
    err < 20,
    `wedge bearing ${wedge.toFixed(0)}°, spider at ${trueBearing.toFixed(0)}° (${err.toFixed(0)}° apart)`,
  );
  check('and the bite costs health', st.health < 100, `${Math.ceil(st.health)} hp after ${st.bites} bite(s)`);
  check('the frame is still readable', litFraction(bitten) < 0.35, `lit=${litFraction(bitten).toFixed(4)}`);
}

// ===========================================================================
// 2. The A/B: the same tick, with the damage feedback and without it. This is
//    the switch the human is going to flip, so it is the frame he gets.
// ===========================================================================
await call('vitals.reset');
await call('pose', HOME.x, HOME.z, 90);
await call('spiders.spawn', 0);
await advance(0.5, 4);
await playerCam(90, 0);
// From behind and to his left: the case the whole indicator exists for.
await call('vitals.biteFrom', -145);
await advance(0.1, 1);
const wedgeOn = await shot(
  '03-wedge-on.png',
  'a bite from 145° to his left — i.e. behind his shoulder — with an empty hall around him so nothing else is on screen. This is ' +
    'the entire message the player gets: a bearing and a flinch. He never sees a number',
);
await call('vitals.effects', false);
await redraw();
const wedgeOff = await shot(
  '04-wedge-off.png',
  'the identical tick with the damage feedback switched off (I, or the GUI). Same health, same everything: this is what being ' +
    'eaten in the dark looked like before this milestone — nothing at all',
);
await call('vitals.effects', true);
check(
  'the wedge is the only difference between the two frames',
  litFraction(wedgeOn) > litFraction(wedgeOff),
  `lit ${litFraction(wedgeOn).toFixed(4)} with, ${litFraction(wedgeOff).toFixed(4)} without`,
);
const punch = (await vitals()).punch;
check(
  'and the head is knocked away from the bite',
  Math.abs(punch.pitch) > 0 && Math.abs(punch.yaw) > 0,
  `flinch pitch ${((punch.pitch * 180) / Math.PI).toFixed(2)}° yaw ${((punch.yaw * 180) / Math.PI).toFixed(2)}° roll ${((punch.roll * 180) / Math.PI).toFixed(2)}°`,
);

// ===========================================================================
// 3. Low health: the set starts failing, and the rifle starts wandering.
// ===========================================================================
await call('vitals.reset');
await call('vitals.health', 18);
await call('vitals.compass', true);
// Something to hear, all round him, so there is a set to watch fail.
for (const [dx, dz] of [[6, 0], [-6, 1], [0, -7], [-4, -5]]) {
  await call('disturb', HOME.x + dx, 0.4, HOME.z + dz, 2.4, 3.2);
}
await advance(0.35, 2);
const lowShot = await shot(
  '05-low-health.png',
  '18 hp. The frame is permanently closed down at the edges, and the noise ring behind him is dropping notches and stuttering the ' +
    'ones it keeps — the tactical set is a device, and a hurt man\'s device works badly. The dropout is a hash of the event id and ' +
    'the clock, so this frame replays to the pixel',
);
const low = await vitals();
check('low health degrades the set', low.degrade > 0.5, `degrade ${low.degrade.toFixed(2)} at ${Math.ceil(low.health)} hp`);

// The tremor is simulation, not decoration: it moves where the rifle is actually pointing.
const wander = await page.evaluate(() => {
  const bs = window.bs;
  const sample = (hp) => {
    bs.vitals.health(hp);
    bs.aim(90, 0);
    let min = 1e9;
    let max = -1e9;
    for (let i = 0; i < 120 * 4; i++) {
      bs.step(1 / 120);
      const y = bs.stats().aim.yawDeg;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    return max - min;
  };
  const hurt = sample(18);
  const well = sample(100);
  return { hurt, well };
});
check(
  'and it spoils the aim for real',
  wander.hurt > wander.well + 0.15,
  `heading wandered ${wander.hurt.toFixed(2)}° over four seconds at 18 hp, ${wander.well.toFixed(2)}° at full health`,
);
notes.push(
  `the tremor is simulation, not a camera effect: at 18 hp the *real* heading wanders ${wander.hurt.toFixed(2)}° over four ` +
    `seconds against ${wander.well.toFixed(2)}° healthy, so a hurt player misses.`,
);

// ===========================================================================
// 4. The compass. A noise behind him: nothing in frame, a notch on the ring.
// ===========================================================================
await call('vitals.reset');
await call('vitals.health', 100);
await call('pose', HOME.x, HOME.z, 90);
await call('clear');
await advance(0.6, 4);
await playerCam(90, 0);

/**
 * Picks a real prop in a given screen-relative arc, so the noise has something to come from.
 * Guessing coordinates does not work: the hall is procedural and half of "nine metres that way"
 * is empty floor, which makes a noise nobody made.
 */
const propInArc = (fromDeg, toDeg, minD, maxD) =>
  page.evaluate(
    ([lo, hi, near, far]) => {
      const bs = window.bs;
      const p = bs.stats().pos;
      const yaw = (bs.stats().aim.yawDeg * Math.PI) / 180;
      let best = null;
      for (const [, x, y, z] of bs.propList()) {
        const d = Math.hypot(x - p[0], z - p[2]);
        if (d < near || d > far) continue;
        // Screen bearing: 0 straight ahead, +90 to his right.
        let deg = ((Math.atan2(x - p[0], z - p[2]) - yaw + Math.PI) * 180) / Math.PI;
        deg = -(((deg + 540) % 360) - 180);
        if (deg < lo || deg > hi) continue;
        if (best === null || d < best.d) best = { x, y, z, d, deg };
      }
      return best;
    },
    [fromDeg, toDeg, minD, maxD],
  );

// Behind his head: the mark for this noise is drawn in the world, at the point it happened,
// which is exactly where he cannot see it.
const BEHIND = await propInArc(120, 180, 6, 14);
check('the hall has something to knock over behind him', BEHIND !== null, BEHIND ? `${BEHIND.d.toFixed(1)} m away at ${BEHIND.deg.toFixed(0)}°` : '');
await call('vitals.compass', true);
await call('disturb', BEHIND.x, BEHIND.y + 0.2, BEHIND.z, 2.6, 6);
await advance(0.2, 2);
const compassOn = await shot(
  '06-compass-on.png',
  `a stack of clutter has just gone over ${BEHIND.d.toFixed(0)} m behind him, at ${BEHIND.deg.toFixed(0)}° off his nose. The mark for it is ` +
    'drawn in the world at the point it happened — behind his head, so he cannot see it at all. The notches on the outer ring are the only ' +
    'thing that tells him: a bearing, brightness by loudness, and deliberately no distance',
);
const notches = await page.evaluate(() => window.bs.vitals.notches());
check('the compass reports the noise behind him', notches.length > 0, `${notches.length} notch(es) drawn`);
if (notches.length > 0) {
  const err = Math.min(...notches.map((n) => Math.abs(((n.deg - BEHIND.deg + 540) % 360) - 180)));
  check(
    'and it puts it in the right direction, behind him',
    notches.every((n) => Math.abs(n.deg) > 90) && err < 30,
    `notches at ${notches.map((n) => `${n.deg.toFixed(0)}°`).join(', ')} against ${BEHIND.deg.toFixed(0)}° true`,
  );
}

await call('vitals.compass', false);
await redraw();
const compassOff = await shot(
  '07-compass-off.png',
  'the identical tick with the compass off (O). This is the frame that makes the argument: everything that happened behind him is ' +
    'simply lost. Whether that loss is the game or a bug is the one design question in this milestone',
);
check(
  'without it the same event leaves nothing on screen',
  litFraction(compassOn) > litFraction(compassOff),
  `lit ${litFraction(compassOn).toFixed(4)} with the compass, ${litFraction(compassOff).toFixed(4)} without`,
);

await truthCam((HOME.x + BEHIND.x) / 2, (HOME.z + BEHIND.z) / 2, 26);
await redraw();
await shot(
  '08-compass-truth.png',
  `as it really is: the player at ${HOME.x}, ${HOME.z} facing +X, and the clutter he heard at ${BEHIND.x.toFixed(0)}, ${BEHIND.z.toFixed(0)} — ` +
    'the far side of him. The bearing on the ring in frame 06 is that direction and nothing else: the compass is never told how far it was',
);

// The other half of the rule: a noise he can already see is NOT repeated on the ring. The ring
// has to be given time to empty first, or the previous crash is still on it.
await call('vitals.compass', true);
await playerCam(90, 0);
await advance(2.5, 8);
await call('clear');
const AHEAD = await propInArc(-24, 24, 5, 13);
check('and something to knock over in front of him', AHEAD !== null, AHEAD ? `${AHEAD.d.toFixed(1)} m away at ${AHEAD.deg.toFixed(0)}°` : '');
await call('disturb', AHEAD.x, AHEAD.y + 0.2, AHEAD.z, 2.6, 6);
await advance(0.2, 2);
const front = await page.evaluate(() => ({
  drawn: window.bs.vitals.notches().length,
  blips: window.bs.vitals.state().compass.blips,
}));
await shot(
  '09-compass-in-frame.png',
  'the same trick played in front of him instead. The marks are there in the world where they belong, and the ring is empty: a noise ' +
    'whose mark he can already see is never repeated as a notch. The compass only ever refuses to lose information — it never adds any',
);
check(
  'a noise in frame is not duplicated on the ring',
  front.drawn === 0 && front.blips > 0,
  `${front.blips} live blip(s), ${front.drawn} drawn`,
);

// ===========================================================================
// 5. What it costs.
// ===========================================================================
const perf = await page.evaluate(() => {
  const bs = window.bs;
  const sample = () => {
    const runs = [];
    for (let i = 0; i < 240; i++) {
      bs.step(1 / 120);
      bs.draw();
      runs.push(bs.stats().frameMs.frameMs);
    }
    const sorted = runs.slice().sort((a, b) => a - b);
    return { mean: runs.reduce((a, b) => a + b, 0) / runs.length, p95: sorted[Math.floor(sorted.length * 0.95)] };
  };
  bs.vitals.compass(false);
  bs.vitals.effects(false);
  const off = sample();
  bs.vitals.compass(true);
  bs.vitals.effects(true);
  // Keep the ring full while it is measured: a compass with nothing on it is not a measurement.
  const busy = (() => {
    const runs = [];
    for (let i = 0; i < 240; i++) {
      if (i % 12 === 0) bs.disturb(2 + ((i % 5) - 2) * 3, 0.5, 2 + ((i % 7) - 3) * 2, 2.2, 2.6);
      bs.step(1 / 120);
      bs.draw();
      runs.push(bs.stats().frameMs.frameMs);
    }
    const sorted = runs.slice().sort((a, b) => a - b);
    return { mean: runs.reduce((a, b) => a + b, 0) / runs.length, p95: sorted[Math.floor(sorted.length * 0.95)], notches: bs.vitals.notches().length };
  })();
  return { off, busy };
});
console.log(
  `[hud] frame cost: HUD off ${perf.off.mean.toFixed(2)} ms (p95 ${perf.off.p95.toFixed(2)}) · ` +
    `HUD on with a busy ring ${perf.busy.mean.toFixed(2)} ms (p95 ${perf.busy.p95.toFixed(2)})`,
);
notes.push(
  `cost of the whole layer, measured on the same frames: ${perf.off.mean.toFixed(2)} ms/frame with it off against ` +
    `${perf.busy.mean.toFixed(2)} ms with damage feedback and a busy compass on (p95 ${perf.off.p95.toFixed(2)} → ` +
    `${perf.busy.p95.toFixed(2)}). It is one 2D canvas, cleared once and skipped entirely when there is nothing to say.`,
);
check(
  'the layer is close to free',
  perf.busy.mean < perf.off.mean + 1.0,
  `${perf.off.mean.toFixed(2)} ms → ${perf.busy.mean.toFixed(2)} ms per frame`,
);

// --- contact sheet ---------------------------------------------------------
const html = `<!doctype html><meta charset="utf-8"><title>BLIND SPOT M5 — player HUD</title>
<style>body{background:#0a0d10;color:#cfdbe4;font:13px/1.5 ui-monospace,monospace;margin:24px}
h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#ffd166}
figure{margin:0 0 28px}img{width:100%;max-width:1280px;border:1px solid #223}
figcaption{padding:6px 2px;color:#8fa2b0}</style>
<h1>BLIND SPOT — keyframes: damage, direction, noise compass</h1>
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
  console.log(`[hud] console errors:\n  ${consoleErrors.slice(0, 8).join('\n  ')}`);
  failures.push(`${consoleErrors.length} console error(s)`);
}
console.log(`[hud] ${shots.length} frames -> ${outDir}`);
if (failures.length > 0) {
  console.error(`[hud] ${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('[hud] all checks passed');
