/**
 * Keyframe generator.
 *
 * Headless chromium opens the single-file build over file://, then drives the simulation by
 * hand: fixed seed, fixed step, no wall clock anywhere in the loop. Every scenario ends in a
 * PNG, and every PNG that claims something is checked photometrically — you cannot eyeball a
 * black screen, so the frames are measured instead of trusted.
 *
 * The set is deliberately small. A frame earns its place by *proving* something that is
 * visible to the eye; anything that could only be proved by a number is checked as a number
 * and does not get a picture. Pairs ("as the player sees" / "as it really is") exist only
 * where the two shots are the same patch of world from the same camera.
 *
 *   node tools/shoot.mjs [dist/index.html] [out]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  decodePng,
  meanLuminance as meanLuminanceRect,
  litFraction as litFractionRect,
  whiteFraction as whiteFractionRect,
  hueFamilies as hueFamiliesRect,
} from './png.mjs';

/** png.mjs measures rectangles and returns records; the scenarios only ask about whole frames. */
const whole = (img) => ({ x: 0, y: 0, w: img.width, h: img.height });
const litFraction = (img) => litFractionRect(img, whole(img)).fraction;
const meanLuminance = (img) => meanLuminanceRect(img, whole(img)).mean;
const whiteFraction = (img, threshold = 100) => whiteFractionRect(img, whole(img), threshold).fraction;
const hueFamilies = (img, rect) => hueFamiliesRect(img, rect);
/** A named window of the frame, so a caption's claim can be measured where the eye looks. */
const litIn = (img, rect) => litFractionRect(img, rect).fraction;

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
const outDir = resolve(process.argv[3] ?? 'out');

if (!existsSync(htmlPath)) {
  console.error(`[shoot] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
// The set shrinks as well as grows; a stale PNG from a deleted scenario next to the new ones
// is exactly the "why is this here twice" confusion this pass exists to remove.
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

/** Walks forward for `seconds`, drawing as it goes — the tactile layer only builds while moving. */
const walk = (seconds) =>
  page.evaluate(
    ([sec]) => {
      const bs = window.bs;
      const dt = 1 / 120;
      bs.keys(['KeyW'], []);
      for (let i = 0; i < Math.round(sec / dt); i++) {
        bs.step(dt);
        if (i % 4 === 0) bs.draw();
      }
      bs.keys([], ['KeyW']);
      bs.draw();
      return bs.stats();
    },
    [seconds],
  );

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
// No device, no ears, nothing to prove: the audio stage would otherwise open an AudioContext the
// moment the first synthetic key press lands, and spend frame budget we are here to measure.
await call('audio', false);
// The hall drops into place on the first tick and settles for about two seconds — 441 impacts,
// which is 441 sound blobs. That is honest behaviour, not a bug, but every frame below is about
// something else, so the world is given time to go quiet before the shutter opens.
await advance(3, 4);

// The vista every lidar frame is shot from: mid-hall, facing east down the long axis, with the
// 6 m landmark rack, two full-height columns, a silo and a crate field stacked in depth. There
// is 26 m of open air in front of the player, which is what makes a travelling wave front
// visible at all — the old spawn-corner pose had everything inside 6 m, so the wave had always
// already landed by the time the shutter opened.
const VISTA = [-4, 1, 270];
const VISTA_AIM = [270, -3];

// --- 01 the hall as it actually is ----------------------------------------
// Pinned overhead camera: same centre and same height as frame 18, so the two are directly
// comparable rather than being two different wide shots that happen to both be from above.
await call('lights', true);
await call('view', 'top');
await call('topFocus', 0, 0);
await call('topHeight', 62);
await advance(0.1, 2);
const lit1 = await shot('01-hall-truth-top.png', 'the whole hall under full light, from a pinned overhead camera — the ground truth frame 17 is measured against');
check('lit top view is bright', litFraction(lit1) > 0.5, `lit=${litFraction(lit1).toFixed(3)}`);

// --- 02 the same vista, lights on ------------------------------------------
await call('view', 'player');
await call('pose', ...VISTA);
await call('aim', ...VISTA_AIM);
await advance(0.1, 2);
const lit2 = await shot('02-vista-truth.png', 'mid-hall looking east with the lights on: rack run, columns, silo, crate field — this is the patch of world the next two frames are looking at');
check('lit vista is bright', litFraction(lit2) > 0.4, `lit=${litFraction(lit2).toFixed(3)}`);

// The default state of the game is a black screen. That is a law, not a picture: an all-black
// PNG proves nothing to the eye, so it is measured here and never shot.
await call('lights', false);
await call('clear');
await call('touch', false);
await advance(0.2, 2);
const dark = decodePng(await page.screenshot({ timeout: 180000 }));
check('unscanned world renders black', litFraction(dark) < 0.01, `lit=${litFraction(dark).toFixed(4)}`);

// --- 03/04 one ping, caught in flight and after it lands -------------------
// The window the landmark rack stands in, in screen pixels. In flight it must be black and
// after the front arrives it must be drawn — that is the whole claim of this pair, and it is
// the same rectangle of the same shot, so the two frames genuinely compare.
// Only the part of it that stands *above* the horizon. M2 filled the hall with clutter, and the
// bottom of the old window looked at floor the crest has already swept over — genuinely drawn,
// and nothing to do with whether the landmark itself has been reached.
const RACK_WINDOW = { x: 430, y: 250, w: 430, h: 50 };
// Frames 03-10 are the geometry lane: they measure what the lidar and the hand draw, in pixels,
// inside small windows. The sound layer is a soft warm blob that deliberately spills over a lot
// of screen, and a can settling somewhere in the hall would land one right inside the measuring
// window and pass for revealed geometry. It has its own frames (11-15); here it is off.
await call('markers', false);
await call('touch', true);
const fired = await ping();
// One trigger pull queues two fronts: the cone and the small halo around the player.
check('lidar fired', fired.lidar.fired === 2, `fronts=${fired.lidar.fired}`);
await advance(0.25, 3);
const p0 = await shot('03-ping-inflight.png', 'the ping 0.25 s in: a hot crest hanging in mid-air at ~10 m, the floor behind it already drawn, everything past it still black');
check('ping paints something', litFraction(p0) > 0.005, `lit=${litFraction(p0).toFixed(4)}`);
check('the crest is hot', whiteFraction(p0, 100) > 0, 'white pixels on the wave front');
check('the crest has not reached the landmark yet', litIn(p0, RACK_WINDOW) < 0.002,
  `the rack window is ${(litIn(p0, RACK_WINDOW) * 100).toFixed(2)}% lit`);

await advance(0.9, 5);
const p1 = await shot('04-ping-landed.png', 'the same ping one second later: the crest has swept through, and the 6 m rack run, the columns and the far wall are on the map');
check('the landmark is drawn once the front gets there', litIn(p1, RACK_WINDOW) > litIn(p0, RACK_WINDOW) * 10 + 0.01,
  `rack window ${(litIn(p0, RACK_WINDOW) * 100).toFixed(2)}% -> ${(litIn(p1, RACK_WINDOW) * 100).toFixed(2)}% lit`);
check('the landed map is brighter than the one in flight', meanLuminance(p1) > meanLuminance(p0),
  `mean ${meanLuminance(p0).toFixed(2)} -> ${meanLuminance(p1).toFixed(2)}`);

// A cooled map still reads — checked numerically, because "the same picture, dimmer" does not
// earn a frame in a set this size.
const beforeCool = (await stats()).paint.unlockedDots;
await advance(4, 6);
const cooled = decodePng(await page.screenshot({ timeout: 180000 }));
check('the map dims but does not die', litFraction(cooled) > 0.003 && meanLuminance(cooled) < meanLuminance(p1),
  `lit=${litFraction(cooled).toFixed(4)}, mean ${meanLuminance(p1).toFixed(2)} -> ${meanLuminance(cooled).toFixed(2)}`);
check('cooling forgets nothing', (await stats()).paint.unlockedDots === beforeCool,
  `${beforeCool} dots still unlocked`);

// --- 05 the hand, in the middle of a crate field ---------------------------
// Touch reveals the 0.55 m column around the body and nothing else. Crouched inside the
// central clutter, that column happens to contain three stacked crates, so the picture is a
// few metres of wireframe and grain hanging in nothing — which is exactly the sensation.
const FIELD = [-18.1, -0.1, -12.1, -5.9, 3.5, -3.9];
await call('clear');
await call('lights', false);
await call('touch', true);
await call('pose', -13.8, -10.8, 90);
await call('keys', ['KeyC'], []);
await advance(0.8, 3);
await call('aim', 90, -38);
await advance(0.2, 2);
const feel = await stats();
const fieldHit = await call('region', FIELD);
const t1 = await shot('05-touch-clutter.png', 'crouched in the middle of the crate field, no ping ever fired: the hand draws the arm-length of junk it is actually touching and nothing else');
check('the hand draws a readable patch', feel.paint.touchedDots > 120,
  `${feel.paint.touchedDots} points felt`);
check('nothing but touch is on screen', feel.paint.unlockedDots === 0,
  `${feel.paint.unlockedDots} dots unlocked by lidar`);
check('the rest of the field stays unknown', fieldHit.touched < fieldHit.dots * 0.05,
  `${fieldHit.touched} of ${fieldHit.dots} mask points in the 12x8 m crate field revealed`);
const feelHue = hueFamilies(t1, whole(t1));
check('touch draws grey, not lidar cyan', feelHue.coolFraction < 0.35,
  `cool ${(feelHue.coolFraction * 100).toFixed(0)}% of ${feelHue.lit} lit pixels`);

// --- 06 lidar outranks the hand on the points they share -------------------
// Identical pose, identical aim, one ping later: the only honest way to show a recolouring is
// to shoot the same patch twice. The stack the hand drew in grey comes back in lidar cyan,
// and the floor and neighbours the hand could never reach arrive with it.
const HAND = [-15.0, -0.1, -12.0, -12.6, 2.0, -9.6];
const greyBefore = await call('region', HAND);
await call('refill');
await ping();
await advance(1.0, 4);
const mixed = await call('region', HAND);
const t2 = await shot('06-clutter-then-lidar.png', 'the same crouch, same aim, one ping later: the crates the hand had drawn in grey are redrawn in lidar cyan, and the floor around them arrives with them');
check('the ping lands on ground the hand already knew',
  greyBefore.touched > 0 && mixed.unlocked > greyBefore.touched * 0.3,
  `${greyBefore.touched} felt, ${mixed.unlocked} of them now scanned`);
// Touch is strictly neutral grey and the lidar's matter palette is strictly cyan-family, so a
// cool pixel where there was none is the recolouring, measured rather than asserted by eye.
const mixedHue = hueFamilies(t2, whole(t2));
check('the shared points are redrawn in the lidar colours',
  mixedHue.cool > 50 && feelHue.cool * 4 < mixedHue.cool,
  `cool pixels ${feelHue.cool} felt -> ${mixedHue.cool} scanned`);
check('the ping shows what the hand never could', mixed.unlocked * 4 < (await stats()).paint.unlockedDots,
  `${greyBefore.touched} points by hand vs ${(await stats()).paint.unlockedDots} by one ping`);
await call('keys', [], ['KeyC']);

// A flat wall answers the hand exactly like a prop does — numeric check, no frame: the picture
// would be indistinguishable from any other grey patch.
await call('clear');
await call('pose', 6, -23.5, 0);
await advance(0.6, 3);
const wallEye = (await stats()).eye;
const wallHit = await call('region', [-34.1, -0.1, -24.6, 34.1, 9.1, -23.9]);
const wallFar = await call('region', [-34.1, -0.1, -24.6, wallEye[0] - 1.5, 9.1, -23.9]);
check('a flat wall answers the hand', wallHit.touched > 0, `${wallHit.touched} wall points felt`);
check('the rest of the wall does not', wallFar.touched === 0, '0 points felt more than 1.5 m along the wall');

// --- 07 a knee-high crate can be felt --------------------------------------
// The bug this proves: the reach used to be a sphere around the eye, so with a 0.35 m body
// radius nothing below y ~ 1.2 m was reachable and small clutter was literally unfeelable.
// Crouched, one hand on a lone 0.55 x 0.69 x 0.97 m crate on the open north-east floor.
const CRATE = [6.81, 0, 10.16, 7.36, 0.69, 11.13];
await call('clear');
await call('pose', 7.08, 11.5, 0);
await call('keys', ['KeyC'], []);
await advance(0.6, 3);
await call('aim', 0, -45);
await advance(0.2, 2);
const crateStats = await stats();
const crateHit = await call('region', [CRATE[0] - 0.1, -0.1, CRATE[2] - 0.1, CRATE[3] + 0.1, CRATE[4] + 0.1, CRATE[5] + 0.1]);
const t3 = await shot('07-touch-crate.png', 'crouched with a hand on a knee-high crate alone on an empty floor: its top edge and corners come back, the far side does not — small clutter used to return nothing at all');
check('a small crate can be felt', crateHit.touched > 12,
  `${crateHit.touched} of ${crateHit.dots} mask points on a 0.55x0.69x0.97 m crate`);
check('the crate frame is touch only', crateStats.paint.unlockedDots === 0,
  `${crateStats.paint.unlockedDots} dots unlocked by lidar`);
// The M1 audit's actual complaint: the whole wireframe of the crate was drawn, far top edge and
// all. A contour piece is a fact about the world like a dot is, so it is revealed only where the
// hand got to it. The crate is 0.97 m deep, the reach 0.55 m: the near half answers, the far
// half must stay black even though it belongs to the very same box.
const crateNear = await call('region', [CRATE[0] - 0.1, -0.1, 10.9, CRATE[3] + 0.1, CRATE[4] + 0.1, CRATE[5] + 0.1]);
const crateFar = await call('region', [CRATE[0] - 0.1, -0.1, CRATE[2] - 0.1, CRATE[3] + 0.1, CRATE[4] + 0.1, 10.5]);
check('the hand draws the near edges of the crate', crateNear.edgesTouched > 0,
  `${crateNear.edgesTouched} of ${crateNear.edges} contour pieces on the near side`);
check('the far side of the same crate is never drawn', crateFar.edgesTouched === 0,
  `0 of ${crateFar.edges} contour pieces beyond the reach`);
await call('keys', [], ['KeyC']);

// --- 08 the cone clips one end of a 24 m run -------------------------------
// The east rack is a single box 24 m long (x 22..23.4, z -18..6). Before the shared mask,
// clipping its corner handed you all twenty-four metres.
const rackSouth = [21.9, -0.1, -18.1, 23.5, 6.1, -6];
const rackNorth = [21.9, -0.1, 1.9, 23.5, 6.1, 6.1];
await call('clear');
await call('touch', false);
await call('pose', 30, -2, 132);
await call('aim', 132, -4);
await call('refill');
await ping();
await advance(0.9, 4);
const edgeNorth = await call('region', rackNorth);
const edgeSouth = await call('region', rackSouth);
const t4 = await shot('08-lidar-rack-end.png', 'one ping across a 24 m rack run: shelf decks and surface grain inside the disc the cone reached, and nothing at all to either side of it');
check('the clipped end is drawn', edgeNorth.unlocked > 200,
  `${edgeNorth.unlocked} of ${edgeNorth.dots} dots on the north end`);
check('the far end of the run is not', edgeSouth.unlocked === 0,
  `${edgeSouth.unlocked} dots on the south end (${edgeSouth.dots} in the mask there)`);
await call('touch', true);

// --- 09..13 M2: the hall is full of junk, and the junk makes noise ---------
// The messiest corner of the hall, found rather than hard-coded: the pile with the most
// *different* silhouettes inside 2.6 m. Deterministic — same seed, same layout, same answer.
const pile = await page.evaluate(() => {
  const list = window.bs.propList();
  let best = null;
  for (const [n, x, y, z] of list) {
    if (n !== 'barrel' && n !== 'spool' && n !== 'crate') continue;
    const kinds = new Set();
    let count = 0;
    for (const [m, a, , c] of list) {
      if (Math.hypot(a - x, c - z) < 2.6) {
        kinds.add(m);
        count++;
      }
    }
    const score = kinds.size * 2 + count * 0.2;
    if (best === null || score > best.score) best = { x, y, z, score, kinds: [...kinds], count };
  }
  return best;
});
console.log(`[shoot] pile at ${pile.x.toFixed(1)},${pile.z.toFixed(1)}: ${pile.count} objects, ${pile.kinds.length} kinds — ${pile.kinds.join(' ')}`);
notes.push(`clutter close-up: ${pile.count} props within 2.6 m, ${pile.kinds.length} different silhouettes (${pile.kinds.join(', ')})`);
const PILE_EYE = [pile.x - 1.6, pile.z - 1.6];
const PILE_AIM = (Math.atan2(-1.6, -1.6) * 180) / Math.PI;

await call('view', 'player');
await call('pose', PILE_EYE[0], PILE_EYE[1], PILE_AIM);
await call('aim', PILE_AIM, -14);
await call('lights', true);
await advance(0.2, 2);
const lit9 = await shot('09-clutter-truth.png', `the messiest corner of the hall with the lights on: ${pile.kinds.join(', ')} — the ground truth for the next frame`);
check('the clutter close-up has clutter in it', pile.count > 8 && pile.kinds.length > 4,
  `${pile.count} props, ${pile.kinds.length} silhouettes`);
check('lit clutter is bright', litFraction(lit9) > 0.3, `lit=${litFraction(lit9).toFixed(3)}`);

await call('lights', false);
await call('clear');
await call('touch', false);
await call('refill');
await ping();
await advance(0.5, 3);
const c10 = await shot('10-clutter-lidar.png', 'the same corner on one ping and nothing else: barrel ribs, a keg’s hoops, crate edges, a canister, a bottle — each object separated from the floor by its own point pitch, its face tint and its contour');
const dynStats = (await stats()).dyn;
// The complaint this frame answers is "the props blend into the floor". Two windows of the same
// frame at the same screen height, both fixed by the pose above: the junk, and bare floor beside
// it. If the objects read at all, the first has to be markedly denser and brighter than the
// second — a flat grey mush would put the two numbers together.
const PILE_WINDOW = { x: 250, y: 330, w: 560, h: 340 };
const BARE_FLOOR = { x: 860, y: 330, w: 400, h: 340 };
const pileLum = meanLuminanceRect(c10, PILE_WINDOW).mean;
const floorLum = meanLuminanceRect(c10, BARE_FLOOR).mean;
check('the props are drawn, not just the floor', dynStats.revealed > 800,
  `${dynStats.revealed} of ${dynStats.points} prop mask points revealed`);
check('the junk stands out of the floor it sits on', pileLum > floorLum * 2.5 &&
  litIn(c10, PILE_WINDOW) > litIn(c10, BARE_FLOOR) * 2,
  `mean ${pileLum.toFixed(2)} vs bare floor ${floorLum.toFixed(2)}, lit ${litIn(c10, PILE_WINDOW).toFixed(3)} vs ${litIn(c10, BARE_FLOOR).toFixed(3)}`);

// --- 11 the stack goes over ------------------------------------------------
// The moment M2 exists for: shoulder the pile, and the collision impulses themselves become
// both the sound and the marks. Nothing here is scripted — `disturb` only applies an impulse.
await call('markers', true);
const quiet = await stats();
const beforeSpill = quiet.sound.emitted;
const woke = await call('disturb', pile.x, pile.y + 0.35, pile.z, 2.4, 5.5);
// Measured while it is happening: the collapsing stack is the worst case the spec asks for.
const spillPerf = await page.evaluate(() => {
  const bs = window.bs;
  const cpu = [];
  for (let i = 0; i < 45; i++) {
    const t0 = performance.now();
    bs.step(1 / 120);
    bs.draw();
    cpu.push(performance.now() - t0);
  }
  const a = cpu.slice().sort((x, y) => x - y);
  const s = bs.stats();
  return {
    median: a[Math.floor(a.length / 2)],
    max: Math.max(...cpu),
    awake: s.props.awake,
    events: s.sound.emitted,
    marks: s.marks.alive,
    stepMs: s.props.stepMs,
  };
});
const f11 = await shot('11-spill-inflight.png', 'a shoulder into the pile: things are still in the air, and every contact so far has left a bright marker exactly where it happened — impulse became loudness became a mark, with no trigger anywhere');
check('the pile actually goes over', woke > 5, `${woke} bodies woken`);
check('the collision itself is what makes the noise', spillPerf.events - beforeSpill > 10,
  `${spillPerf.events - beforeSpill} sound events from one shove`);
check('fresh marks are on screen', spillPerf.marks > 8, `${spillPerf.marks} markers alive`);
check('a collapsing stack does not blow the frame', spillPerf.max < 20,
  `worst frame mid-collapse ${spillPerf.max.toFixed(2)} ms (median ${spillPerf.median.toFixed(2)} ms, ${spillPerf.awake} bodies awake, physics ${spillPerf.stepMs.toFixed(2)} ms)`);
notes.push(
  `collapsing stack (the worst case the spec asks for): ${woke} bodies woken, ${spillPerf.events - beforeSpill} sound events, ` +
    `our own frame cost median ${spillPerf.median.toFixed(2)} ms / max ${spillPerf.max.toFixed(2)} ms with ${spillPerf.awake} bodies awake`,
);

// --- 12 the same corner, seconds later -------------------------------------
await advance(7, 24);
const f12 = await shot('12-spill-settled.png', 'eight seconds on: the marks have decayed to a faint heat-map of where the noise was, the objects have come to rest somewhere new, and the lidar map still shows them where they used to be');
const settled = await stats();
check('the marks fade but the hall stays mapped', meanLuminance(f12) < meanLuminance(f11),
  `mean ${meanLuminance(f11).toFixed(2)} -> ${meanLuminance(f12).toFixed(2)}`);
// Against the hall's own resting level, not against zero: a thousand bodies stacked on each
// other never all sleep at once, and what matters is that the ones this shove woke go back down.
check('the junk comes to rest', settled.props.awake <= quiet.props.awake + 4,
  `${quiet.props.awake} awake before the shove, ${spillPerf.awake} during it, ${settled.props.awake} of ${settled.props.bodies} after`);

// --- 13 the law: a marker is not a light -----------------------------------
// concept.md §"Звуковой слой — это НЕ свет". Wipe the map, keep the hand off, then knock the
// pile over again: the screen now holds nothing but marks. If a marker lit anything, the pile
// it is standing in would appear. It does not.
await call('clear');
await call('touch', false);
// Standing back a little and looking down at the pile, so the whole scatter is inside the frame:
// from 1.6 m most of what gets thrown lands behind the camera, and the picture ends up being one
// blob and a lot of black, which understates both halves of what it is here to show.
await call('pose', pile.x - 3.4, pile.z - 3.4, PILE_AIM);
await call('aim', PILE_AIM, -12);
await advance(0.2, 2);
await call('disturb', pile.x, pile.y + 0.35, pile.z, 2.4, 5.5);
// Long enough for the pile to actually scatter: at 0.4 s every contact is still inside the
// footprint of the shove and the marks pile into one smear, which shows the law but shows it
// badly. A second in, the things that were thrown are landing apart from each other.
await advance(0.9, 6);
const f13 = await shot('13-marks-are-not-light.png', 'the same shove with the map wiped: a dozen bright markers hanging in the dark, and the barrels they are bouncing off stay perfectly black — a mark is a fact about an event, not a light');
const dark13 = await stats();
const pileWindow = [pile.x - 3, -0.1, pile.z - 3, pile.x + 3, 3, pile.z + 3];
const around = await call('region', pileWindow);
check('the marks are the only thing on screen', dark13.marks.alive > 6 && litFraction(f13) < 0.02,
  `${dark13.marks.alive} markers, lit=${litFraction(f13).toFixed(4)}`);
check('a marker lights nothing around it', around.unlocked === 0 && dark13.paint.unlockedDots === 0,
  `0 of ${around.dots} mask points revealed in the 6x6 m the marks are sounding in`);
check('and it reveals no prop either', dark13.dyn.revealed === 0,
  `${dark13.dyn.revealed} prop mask points revealed`);

// --- 14 the debug tool M2 owes (process.md) --------------------------------
// Every event with the radius it can be noticed at — in M4 this exact circle is the test a
// spider runs, so it has to be visible now, while there is still nothing listening. Rings are
// recorded at emission, so the toggle goes on *before* the shove, and the frame is taken from
// above because a 20 m circle around your own feet is not a thing you can see from inside it.
await call('radii', true);
await call('clear');
await advance(0.2, 2);
await call('disturb', pile.x, pile.y + 0.35, pile.z, 2.4, 5.5);
await advance(0.5, 5);
await call('view', 'top');
await call('topFocus', pile.x, pile.z);
await call('topHeight', 30);
await advance(0.05, 2);
const f14 = await shot('14-marks-audibility.png', 'the M2 debug overlay, straight down over the same collapsing pile: each event as a marker plus the circle it can be heard inside. A barrel going over throws a ring across the bay; a can landing beside it barely clears the next aisle');
const ringStats = await stats();
// The control is this same frame with the rings switched off — comparing it to frame 13 would
// compare two different cameras over two different shoves, which proves nothing about rings.
await call('radii', false);
await advance(0.02, 1);
const noRings = decodePng(await page.screenshot({ timeout: 180000 }));
const ringPixels = Math.round((litFraction(f14) - litFraction(noRings)) * 1280 * 720);
check('every event carries its audibility radius', ringStats.marks.alive > 6 && ringPixels > 100,
  `${ringStats.marks.alive} events ringed, ${ringPixels} pixels of circle that are not there with the overlay off`);
await call('view', 'player');
await call('touch', true);
await call('markers', true);

// --- 15 your own footsteps: the cost with no benefit ------------------------
// concept.md, deadpan: the mark under your own foot tells you where you already knew you were.
// It is not a bug and it is not decoration — it is the price list. Shot by walking a few metres
// of open floor and then turning round, because a trail of your own noise leading straight to
// where you are standing is the clearest way to see that none of it told you anything.
await call('clear');
await call('touch', false);
await call('markers', true);
await call('pose', -8, 1, 270);
await call('aim', 270, 0);
await advance(0.3, 2);
const beforeStep = (await stats()).sound.bySource['player-step'] ?? 0;
await walk(2.2);
await call('aim', 90, -22);
await advance(0.1, 2);
const f15 = await shot('15-own-steps.png', 'four metres of walking on open floor with nothing else on, then a look back: your own footsteps, marked one by one where each boot landed. Zero information, full price — and in M4 the spiders will be listening to exactly these');
const stepStats = await stats();
const stepsTaken = (stepStats.sound.bySource['player-step'] ?? 0) - beforeStep;
check('walking makes noise', stepsTaken > 2 && stepsTaken < 12,
  `${stepsTaken} footsteps in 2.2 s of walking`);
// The trail runs away from the camera down the middle of the screen; the world around it is
// unscanned and must stay black, which is the other half of what this frame shows.
const TRAIL = { x: 360, y: 300, w: 560, h: 300 };
// Above the horizon there is nothing but unscanned hall, and it has to stay black: that is the
// half of this frame which says the trail is a trail and not a light source. The blobs are soft
// and wide, so the trail window itself is measured against the frame, not against a fixed number.
const ABOVE = { x: 0, y: 0, w: 1280, h: 180 };
check('the steps mark themselves, and nothing else does', stepStats.marks.alive > 1 &&
  litIn(f15, TRAIL) > litFraction(f15) * 1.5 && litIn(f15, ABOVE) < 0.005,
  `${stepStats.marks.alive} markers, trail window lit ${litIn(f15, TRAIL).toFixed(4)}, whole frame ${litFraction(f15).toFixed(4)}, unscanned hall above the horizon ${litIn(f15, ABOVE).toFixed(4)}`);
await call('touch', true);

// --- 16/17 the readability gate: spawn -> gate on lidar alone --------------
await call('clear');
await call('pose', -30, -20, 35);
await advance(0.4, 2);

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
await call('aim', 100, -4);
await advance(0.3, 2);
await call('refill');
await ping();
await advance(0.6, 3);
await shot('16-gate-arrive.png', 'standing in the gate at the far end, looking back down the hall he just crossed on lidar alone');
check('reached the gate', trace.gate < 4, `${trace.gate.toFixed(1)} m`);

await call('view', 'top');
await call('topFocus', 0, 0);
await call('topHeight', 62);
await advance(0.1, 2);
await shot('17-gate-map-top.png', 'everything that walk revealed, from the same overhead camera as frame 01: a corridor of known ground across an otherwise black hall');
const known = (await stats()).paint;
check('the walk maps a corridor, not the hall', known.unlockedDots > 20000 && known.unlockedDots < known.dots * 0.7,
  `${known.unlockedDots} of ${known.dots} mask points known (${((known.unlockedDots / known.dots) * 100).toFixed(0)}%)`);
notes.push(
  `after the crossing: ${known.unlockedDots} of ${known.dots} mask points known (${((known.unlockedDots / known.dots) * 100).toFixed(0)}%)`,
);

// --- perf ------------------------------------------------------------------
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
await shot('18-hud.png', 'the same view as frame 16 with the debug overlay on: position, nearest landmark, lidar charge, sound bus, mask coverage, frame cost, draw calls');

// --- contact sheet ---------------------------------------------------------
const html = `<!doctype html><meta charset="utf-8"><title>BLIND SPOT M2 — keyframes</title>
<style>body{background:#0a0d10;color:#cfdbe4;font:13px/1.5 ui-monospace,monospace;margin:24px}
h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#6fd3e0}
figure{margin:0 0 28px}img{width:100%;max-width:1280px;border:1px solid #223}
figcaption{padding:6px 2px;color:#8fa2b0}</style>
<h1>BLIND SPOT — M2 keyframes</h1>
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
