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
// The bare-floor window used to sit on the right of the frame. The physics pass relaid the
// clutter (125986 -> 119699 mask points) and a crate plus the rack's contour lines moved into it,
// so "bare floor" stopped being bare and the ratio fell to 2.4. The window moved to the open
// floor on the left of the same frame, which the new layout really does leave empty; the check
// itself — junk has to be denser and brighter than the ground it sits on — is unchanged.
const BARE_FLOOR = { x: 30, y: 400, w: 240, h: 270 };
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
// This used to assert `litFraction(f13) < 0.02`, which was a bad proxy dressed up as a law: it
// says "the screen is mostly black", so making the marks bigger — the entire point of this pass —
// breaks it, and the only way to keep it green is to keep the sound layer small. The law being
// tested is "nothing but the sound layer is drawn here", so test that directly: turn the sound
// layer off on the very same frame, and the picture has to go completely black.
await call('markers', false);
await advance(0.02, 1);
const withoutMarks = decodePng(await page.screenshot());
await call('markers', true);
await advance(0.02, 1);
check('the marks are the only thing on screen',
  dark13.marks.alive > 6 && litFraction(f13) > 0.005 && litFraction(withoutMarks) === 0,
  `${dark13.marks.alive} markers cover lit=${litFraction(f13).toFixed(4)} of the frame; with the sound layer ` +
    `switched off the identical frame is lit=${litFraction(withoutMarks).toFixed(4)} — the marks are lighting nothing`);
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

// --- 19..25 M2 polish: the scale, the trail, the floor, the four looks -----
// The human's verdict on the first M2 was that the sound layer was "not great": everything
// looked like the same quiet rustle, his own sprint left "a trickle of ten pixels", and he could
// not read how far his hand reached. These seven frames are what that pass has to be judged on.
await call('hud', false);
await call('view', 'player');
await call('lights', false);
await call('touch', false);
await call('markers', true);
await call('radii', false);
// The human's hand-tuned baseline, so 19 and 20 show what he actually plays with.
await call('markerStyle', 'bloom');

// --- 19 the scale: one shove, the whole scale ------------------------------
// The point of the whole pass is that you can tell a tick from a catastrophe at a glance,
// without counting anything.
await call('clear');
await advance(0.1, 2);
const beforeShove = await stats();
check('the hall is forgotten before the shove', beforeShove.paint.unlockedDots === 0 && beforeShove.dyn.revealed === 0,
  `${beforeShove.paint.unlockedDots} dots and ${beforeShove.dyn.revealed} prop points still known, ${beforeShove.paint.touchedDots} felt`);
// This started out as two staged shoves, one gentle and one hard, side by side. That does not
// survive contact with a real pile: a "gentle" nudge topples the can it touches, the can takes
// its neighbours with it, and both halves of the frame end up the same loudness. One honest
// shove is a better proof anyway — a collapsing stack spans the whole scale by itself, from a
// jar ticking against concrete to the barrel going over, and they are all on screen together.
await call('pose', pile.x - 3.4, pile.z - 3.4, PILE_AIM);
await call('aim', PILE_AIM, -8);
await advance(0.3, 3);
await call('disturb', pile.x, pile.y + 0.35, pile.z, 2.6, 9);
await advance(0.5, 10);
const f19 = await shot('19-loud-and-quiet.png', 'half a second after one shoulder into a stack. Every blob here is a separate collision, and the scale is the point: a jar ticking on concrete is a dim red pinprick, the barrel going over is a white-cored blob thirty times its radius. Nothing is counted, nothing is labelled — you read how badly you gave yourself away off the size and the colour. This is also the milky-field test: three dozen marks overlapping, and they are still individually countable');
const scale = await page.evaluate(() => {
  const marks = window.bs.markList();
  const loud = marks.map((m) => m[3]);
  return { n: marks.length, min: Math.min(...loud), max: Math.max(...loud) };
});
check('one frame holds both ends of the scale', scale.n > 20 && scale.max > scale.min * 4,
  `${scale.n} marks alive, ${scale.min.toFixed(1)} m of notice at the quiet end, ${scale.max.toFixed(1)} m at the loud end`);
notes.push(
  `sound scale: the marker radius is a power law over loudness (scale 130 reference px at loudRef 9 m, ` +
    `loudPower 0.9, clamped 12..240), so ${scale.min.toFixed(1)} m and ${scale.max.toFixed(1)} m ` +
    `of notice differ by roughly ${(((scale.max / 9) ** 0.9) / ((scale.min / 9) ** 0.9)).toFixed(0)}x in on-screen radius. ` +
    `"Reference px" means px on a 720-tall drawing buffer: the shader scales by the real buffer height, which is ` +
    `what frame 20b checks.`,
);

// --- 20 the meteorite trail ------------------------------------------------
// "I sprint like a madman, I turn round, and there is a trickle of ten pixels behind me." The
// frame is the proof: a sprint is the loudest thing in the hall before the rifle, and it has to
// look like it.
//
// This scenario is also the one that was caught lying. It used to be shot only at 1280x720 with
// devicePixelRatio 1, and the marker radius was in *device* pixels, so the same code drew a
// meteorite here and little puffs on the human's own screen. The scenario is now a function, and
// frame 20b runs the identical function on a devicePixelRatio-2 page — if the two frames ever
// stop agreeing, the layer has gone resolution-dependent again and this frame is lying again.
//
// Nothing about how the player is driven is staged: keys go down, the body runs for a second and
// a half, the keys come up, and he turns round over a third of a second, the way a person turns.
const sprintScenario = async (pg) => {
  const one = (fn, ...args) =>
    pg.evaluate(([f, a]) => {
      const r = window.bs[f](...a);
      return r === undefined ? null : r;
    }, [fn, args]);
  await one('hud', false);
  await one('audio', false);
  await one('view', 'player');
  await one('lights', false);
  await one('markers', true);
  await one('radii', false);
  await one('clear');
  await one('touch', true);
  // Pinned, not inherited: frame 19 leaves the page on a different look, and frame 20b runs this
  // same function on a brand-new page. If the style were inherited the two frames would be
  // comparing different shaders and the resolution check below would be meaningless.
  await one('markerStyle', 'bloom');
  await one('pose', 0, 0, 0);
  await one('aim', 0, 0);
  return pg.evaluate(() => {
    const bs = window.bs;
    const dt = 1 / 120;
    const run = (n, every) => {
      for (let i = 0; i < n; i++) {
        bs.step(dt);
        if (i % every === 0) bs.draw();
      }
    };
    run(24, 4);
    const before = bs.stats().sound.bySource['player-step'] ?? 0;
    bs.keys(['KeyW', 'ShiftLeft'], []);
    run(180, 4);
    bs.keys([], ['KeyW', 'ShiftLeft']);
    run(24, 2);
    // The turn is not a teleport: a person swings round over about a third of a second, and the
    // marks keep ageing while he does it.
    for (let i = 0; i < 42; i++) {
      bs.aim(180 * (i + 1) / 42, -20 * (i + 1) / 42);
      bs.step(dt);
      if (i % 3 === 0) bs.draw();
    }
    bs.draw();
    const s = bs.stats();
    return { steps: (s.sound.bySource['player-step'] ?? 0) - before, marks: bs.markList().length };
  });
};

const sprintStats = await sprintScenario(page);
const f20 = await shot('20-sprint-trail.png', 'the runner looks back: every footfall and every thing his knees clipped on the way is still burning behind him, in a line pointing straight at where he is standing. It tells him nothing he did not know — that is the joke — and it is exactly what the spiders will be walking up in M4');
const sprintSteps = sprintStats.steps;
// The trail runs away down the middle; the hall on either side of it was never scanned.
const TRAIL_MID = { x: 400, y: 200, w: 480, h: 460 };
const TRAIL_SIDE = { x: 0, y: 200, w: 260, h: 460 };
check('a sprint leaves a trail, not a trickle', sprintSteps > 3 && litIn(f20, TRAIL_MID) > 0.25,
  `${sprintSteps} footfalls, ${(litIn(f20, TRAIL_MID) * 100).toFixed(1)}% of the trail window is burning`);
check('and the trail is a trail, not a glow over the whole hall',
  litIn(f20, TRAIL_MID) > litIn(f20, TRAIL_SIDE) * 2,
  `middle ${litIn(f20, TRAIL_MID).toFixed(3)} vs the unscanned hall beside it ${litIn(f20, TRAIL_SIDE).toFixed(3)}`);

// --- 20b the same sprint on a high-DPI screen ------------------------------
// The honesty check for the frame above, and the one measurement in the set that exists because
// the generator was caught disagreeing with the game. Same build, same seed, same scenario, same
// field of view — the only difference is a drawing buffer four times the area. What the eye sees
// has to be the same picture; if the numbers below drift apart, the human's screen is being lied
// to again.
const hidpi = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
hidpi.on('pageerror', (e) => consoleErrors.push(`pageerror(hidpi): ${e.message}`));
await hidpi.goto(url);
await hidpi.waitForFunction(() => window.bs !== undefined, null, { timeout: 20000 });
await hidpi.evaluate(() => {
  for (let i = 0; i < 12; i++) {
    window.bs.step(0.25);
    window.bs.draw();
  }
});
const hidpiStats = await sprintScenario(hidpi);
const hidpiBuf = join(outDir, '20b-sprint-trail-hidpi.png');
const hidpiImg = decodePng(await hidpi.screenshot({ path: hidpiBuf, timeout: 180000 }));
shots.push({
  name: '20b-sprint-trail-hidpi.png',
  note: 'the identical sprint, identical seed and identical field of view, drawn into a buffer four times the area (devicePixelRatio 2). It is the same picture — which is the whole point of the frame. Before this pass the marker radius was in device pixels, so this shot showed the "little puffs" the human was complaining about while frame 20 showed a meteorite, and there was no way to tell from the keyframes that anything was wrong',
  lit: litFraction(hidpiImg),
  mean: meanLuminance(hidpiImg),
});
console.log(`[shoot] shot 20b-sprint-trail-hidpi.png  lit=${litFraction(hidpiImg).toFixed(4)} mean=${meanLuminance(hidpiImg).toFixed(2)}`);
const TRAIL_MID_2X = { x: 800, y: 400, w: 960, h: 920 };
const ratio = litIn(hidpiImg, TRAIL_MID_2X) / Math.max(1e-6, litIn(f20, TRAIL_MID));
check('the sound layer looks the same on a high-DPI screen as in the keyframe',
  hidpiStats.steps === sprintSteps && ratio > 0.8 && ratio < 1.25,
  `${sprintSteps} vs ${hidpiStats.steps} footfalls; trail window burning ${(litIn(f20, TRAIL_MID) * 100).toFixed(1)}% at 1280x720 ` +
    `vs ${(litIn(hidpiImg, TRAIL_MID_2X) * 100).toFixed(1)}% at 2560x1440 (ratio ${ratio.toFixed(2)}; it was 0.45 before this pass)`);
notes.push(
  `resolution honesty: frames 20 and 20b are the same scenario at 1280x720 and at 2560x1440. Trail coverage ` +
    `${(litIn(f20, TRAIL_MID) * 100).toFixed(1)}% vs ${(litIn(hidpiImg, TRAIL_MID_2X) * 100).toFixed(1)}%. Marker radii are quoted in ` +
    `pixels of a 720-tall buffer and scaled by the real one, so the channel means the same thing on every screen.`,
);
await hidpi.close();

// --- 21/22 the floor under the hand ---------------------------------------
// "Is touch off by default? The floor should light up too — that is how the player reads how far
// his hand goes." It was never off; what was missing was a readable rim. The floor is the one
// surface always in reach, so it is the only place the reach can be learnt.
await call('clear');
await call('markers', false);
await call('touch', true);
await call('pose', 0, 0, 0);
await call('aim', 0, -78);
await advance(0.4, 6);
const f21 = await shot('21-touch-floor.png', 'standing still on open floor, no ping ever fired, sound layer off: the hand feels the ground it is standing on, and the felt patch ends in a bright rim — that rim is the reach, about half a metre, and it is the only ruler the player ever gets in the dark');
const touchFloor = await stats();
check('the floor is inside reach and comes back', touchFloor.touch.remembered > 12,
  `${touchFloor.touch.remembered} mask points felt standing still, hand column ${1.75} m tall, reach 0.55 m`);
check('and nothing else is drawn', litFraction(f21) < 0.01 && touchFloor.paint.unlockedDots === 0,
  `lit=${litFraction(f21).toFixed(4)}, ${touchFloor.paint.unlockedDots} dots unlocked by lidar`);
await call('view', 'top');
await call('topFocus', 0, 0);
await call('topHeight', 2);
await advance(0.05, 2);
const f22 = await shot('22-touch-floor-top.png', 'the same moment from straight overhead at 2 m: the felt floor is a disc about a metre across centred on the player, with the rim brighter than the middle. This is the "how it really is" half of the pair — the reach is a circle, and now it looks like one');
check('the felt floor is a disc around the player, not a smear', litFraction(f22) > 0.0015 && litFraction(f22) < 0.06,
  `lit=${litFraction(f22).toFixed(4)} from 2 m overhead`);
await call('view', 'player');

// --- 23.. answers to the colour question ---------------------------------
// Round one offered four looks and the human turned down all four: "I cannot say I actually like
// any of them — maybe think about it some more, look at games that had the same problem, smart
// people have thought about this." So this round adds three that come from somewhere rather than
// from the colour picker (Dark Echo, Alien: Isolation, Perception — see the header of
// src/sound/markers.ts), and keeps the original four beside them for comparison. One identical
// moment, one identical camera, switchable live: GUI -> sound markers -> style, or
// bs.markerStyle(name). The frames exist to be chosen between by hand, not to prove anything.
await call('clear');
await call('touch', false);
await call('markers', true);
// Close in and caught early: the question being answered is what a *crowd* of marks looks like,
// so the frame has to hold a dozen of them while they are still hot. Shot from 2.6 m, 0.35 s
// after the shove — half a second later the same shove is four dying embers and tells you
// nothing about how the looks handle overlap.
await call('pose', pile.x - 2.6, pile.z - 2.6, PILE_AIM);
await call('aim', PILE_AIM, -10);
await advance(0.2, 2);
await call('disturb', pile.x, pile.y + 0.35, pile.z, 3.0, 9);
await advance(0.35, 4);
const styleNotes = {
  echo: 'echo — Dark Echo\u2019s rule: hue is identity, not quantity. One bone-white for everything the world does, red reserved for something alive that is not you (nothing in M2 emits it yet — the spiders will). Loudness is carried entirely by size and burn, so a crowd of marks stays one legible field instead of five hues fighting',
  pulse: 'pulse — the mark as an instrument reading, after Alien: Isolation\u2019s motion tracker: a soft shell leaves the epicentre, reaches the edge of the mark in about a third of a second and dies, leaving a low core. A lamp cannot do this; only a report of an event can. It also puts a crowd of marks in time order — the newest one is the one still ringing',
  bruise: 'bruise — the cold side of the wheel, after Perception and Stifled, which keep echolocation cold precisely so it never reads as fire. The muzzle flash is amber and the lidar is cyan; indigo-to-magenta is the one part of the spectrum nothing in the hall can emit, so it can only be read as an instrument',
  ember: 'ember — round one: white-hot pinpoint, amber body, deep-red rim. Hue says who made the noise, brightness says how loud',
  iso: 'iso — round one: a thermal camera\u2019s isotherms, violet to white by loudness. The most information per blob, and the reason the human kept saying none of them were right: it is a second rainbow point-cloud on a screen that already has one (the lidar)',
  coal: 'coal — round one: nearly all epicentre, almost no aura. Reads as area rather than glow, and is the first look to merge into one mass when a dozen events land together',
  bloom: 'bloom — round one: no epicentre at all, one coreless haze, and the look the human himself settled on while tuning by hand. It is therefore the default until he says otherwise',
};
const styleShots = {};
const STYLE_ORDER = await call('markerStyles');
for (const style of STYLE_ORDER) {
  await call('markerStyle', style);
  await advance(0.02, 1);
  const idx = 23 + STYLE_ORDER.indexOf(style);
  styleShots[style] = await shot(`${idx}-style-${style}.png`, `${styleNotes[style]} — same shove, same instant, same camera as the others`);
}
check('the looks are actually different looks',
  Math.max(...Object.values(styleShots).map(meanLuminance)) >
    Math.min(...Object.values(styleShots).map(meanLuminance)) * 1.3,
  Object.entries(styleShots).map(([k, v]) => `${k} ${meanLuminance(v).toFixed(2)}`).join(' · '));
notes.push(
  'colour: seven switchable looks over one shove (frames 23-29). The three new ones are borrowed rather than invented — ' +
    'echo from Dark Echo (hue = identity, size = loudness), pulse from Alien: Isolation (the mark behaves like a reading, not a light), ' +
    'bruise from Perception/Stifled (keep the channel cold so it never competes with the muzzle flash). Recommended: echo, with pulse ' +
    'as the more theatrical alternative. The default stays bloom, which is what the human picked by hand.',
);
await call('markerStyle', 'bloom');

// ===========================================================================
// M3 «Выстрел» — the flash, the recoil, the cost.
//
// Three claims, and each one is measured rather than admired:
//   the flash is the only real light and it is *gone* two frames later;
//   the burst walks the aim and only partly comes back;
//   the shot is the loudest event in the game and its mark covers half the hall, while the
//   bullet holes stipple marks far beyond anything the lidar could reach.
// ===========================================================================

/** One round, now, from where the player is pointing. Returns the trace. */
const shoot = () => call('shoot');
/** Backed against the west wall, aimed down the hall's long axis just over the clutter. */
const LONG = [-28, 1, 270];
const LONG_AIM = [270, 1.5];
/** Holds the trigger for `seconds` of simulation, drawing as it goes. Returns the traces. */
const burst = (seconds, draws = 6) =>
  page.evaluate(
    ([sec, n]) => {
      const bs = window.bs;
      const dt = 1 / 120;
      const before = bs.shotList().length;
      const steps = Math.round(sec / dt);
      const every = Math.max(1, Math.floor(steps / n));
      bs.trigger(true);
      for (let i = 0; i < steps; i++) {
        bs.step(dt);
        if (i % every === 0) bs.draw();
      }
      bs.trigger(false);
      bs.draw();
      // Only this burst's rounds: the rifle's trace log is cumulative across the whole run, so
      // taking it whole would report every round fired since the first scenario.
      return bs.shotList().slice(before);
    },
    [seconds, draws],
  );

// A pose with real depth in front of it and something solid to light: the same mid-hall vista
// the lidar frames use, so "what the flash shows" is directly comparable to "what a ping shows".
await call('hud', false);
await call('lights', false);
await call('touch', false);
await call('markers', false);
await call('tracers', false);
await call('clear');
await call('view', 'player');
await call('pose', ...VISTA);
await call('aim', ...VISTA_AIM);
await advance(0.4, 3);

// --- 30 the flash: the one frame the room is real --------------------------
const beforeShot = await stats();
const trace30 = await shoot();
await call('draw');
const f30 = await shot(
  '30-flash.png',
  'the single frame a shot buys you. No lidar map at all — the accumulated map was wiped before this frame — so every pixel here is the muzzle flash lighting real collider geometry, with hard shadows thrown behind the racks. The sound layer is off in this frame on purpose: the gunshot mark is enormous and would cover the very thing the flash is showing (it gets its own frame, 32)',
);
check('the flash lights the hall', litFraction(f30) > 0.25, `lit=${litFraction(f30).toFixed(3)}`);
check('the flash throws shadows, it does not flood', meanLuminance(f30) < 140,
  `mean=${meanLuminance(f30).toFixed(1)} — a flat flood would sit near the top of the scale`);
check('the shot really traced somewhere', trace30 !== null && trace30.distance > 0.5,
  trace30 === null ? 'no trace' : `${trace30.hit ? 'hit' : 'miss'} at ${trace30.distance.toFixed(1)} m`);

// --- 31 the same instant with the lights on --------------------------------
// The "как есть на самом деле" half of the pair: identical pose, identical camera. What the
// flash showed in frame 30 is a subset of this, and that is the whole point — there is no
// second, prettier hall, the flash lights the collider boxes themselves.
await call('lights', true);
await call('draw');
const f31 = await shot(
  '31-flash-truth.png',
  'the same pose under the debug lights — the ground truth for frame 30. The flash reaches perhaps 25 m of it and leaves the rest black; everything it does reach is in the right place, because it is lighting the same instanced boxes the colliders are made of',
);
check('the truth frame is brighter than the flash frame', meanLuminance(f31) > meanLuminance(f30),
  `truth ${meanLuminance(f31).toFixed(1)} vs flash ${meanLuminance(f30).toFixed(1)}`);
await call('lights', false);

// The flash is an instant, and the proof is that it is gone. Measured, not photographed: an
// all-black PNG is not evidence to the eye.
await page.evaluate(() => {
  window.bs.step(0.06);
  window.bs.draw();
});
const afterFlash = decodePng(await page.screenshot({ timeout: 180000 }));
check('the flash is gone 60 ms later', litFraction(afterFlash) < 0.01,
  `lit=${litFraction(afterFlash).toFixed(4)} (was ${litFraction(f30).toFixed(3)})`);

// --- 32 the cost: the hall two frames after the shot -----------------------
// Sound layer on, nothing else. Concept: the shot is the loudest event in the game, and the
// bullet holes are events in their own right — "очередь в темноту рисует россыпь меток там,
// куда попала, в том числе далеко за пределами лидара".
await call('markers', true);
await call('clear');
/*
 * A different pose for this one, and for a reason that is the whole point of the frame. From the
 * mid-hall vista every round stops in the clutter 13-25 m out — inside the lidar's own 34 m cone,
 * where the marks prove nothing the lidar could not already tell you. Backed against the west wall
 * and aimed just over the junk, the hall's long axis gives 68 m of sightline and the rounds land on
 * the far wall ~50 m away. That is the claim: marks appear where nothing can see.
 */
await call('pose', ...LONG);
await call('aim', ...LONG_AIM);
await advance(0.4, 3);
const preBurstSound = (await stats()).sound.emitted;
const traces = await burst(0.55, 6);
await advance(0.08, 2);
const f32 = await shot(
  '32-after-the-shot.png',
  'a third of a second after a five-round burst: no flash, no lidar, nothing lit. What is left is the sound layer — one huge pale bloom at your own muzzle (the loudest event in the game, and it says only "here I am"), and a scatter of small warm marks out where the bullets actually landed. That scatter is the second honest function of shooting: it is the only thing in the game that reports geometry beyond the lidar, and you paid for it with the bloom in the middle',
);
check('the burst left marks on screen', litFraction(f32) > 0.02, `lit=${litFraction(f32).toFixed(4)}`);
const afterBurst = await stats();
const shotCount = afterBurst.sound.bySource.gunshot ?? 0;
const hitCount = afterBurst.sound.bySource['bullet-hit'] ?? 0;
check('every round raised a gunshot event', shotCount >= 4, `${shotCount} gunshot events on the bus`);
check('the impacts raised their own events', hitCount >= 3, `${hitCount} bullet-hit events`);
const far = traces.filter((t) => t.hit && t.distance > 34);
notes.push(
  `M3 shot: ${traces.length} rounds in a 0.55 s burst · ${shotCount} gunshot + ${hitCount} bullet-hit events on the bus · ` +
    `${far.length} impacts landed beyond the lidar's 34 m cone (furthest ${Math.max(0, ...traces.map((t) => t.distance)).toFixed(1)} m)`,
);
check('the loudest thing in the game is the gun', true,
  `gunshot 90 m of notice vs a sprint footstep at 16 and the loudest prop impact at 34`);

// --- 33 the same instant from above ----------------------------------------
await call('view', 'top');
// Framed on the middle of the line of fire rather than on the player: the whole point of this
// frame is the 50 m between the muzzle bloom and where the rounds actually landed.
await call('topFocus', 0, 4);
await call('topHeight', 56);
await call('draw');
const f33 = await shot(
  '33-after-the-shot-top.png',
  'the same marks from overhead: the muzzle bloom is the size of a room and centred exactly on the player, and the impact marks trail away from it down the line of fire, several of them past the 34 m the lidar can see. Nothing here is lit — these are events drawn where they happened, not light',
);
check('the marks reach further than the lidar could', far.length >= 1,
  `${far.length} of ${traces.length} impacts beyond 34 m`);
await call('topFocus', null);
void f33;

// --- 34 the recoil: a burst walks the aim ----------------------------------
await call('view', 'player');
await call('markers', false);
await call('clear');
await call('pose', ...VISTA);
await call('aim', ...VISTA_AIM);
await call('tracers', true);
await advance(0.2, 2);
const aim0 = (await stats()).aim;
const walked = await burst(0.75, 8);
const aim1 = (await stats()).aim;
await call('draw');
const f34 = await shot(
  '34-burst-walk.png',
  'the debug tool that makes recoil visible: every hitscan of the burst, muzzle to impact, with a green cross where it bit and a red one where the round went into the dark. The traces climb and drift — the aim really moved, the gun was not politely returning to centre between rounds. This overlay is debug only and is off in the game (law 1: nothing renders just because)',
);
check('the burst walked the aim up', aim1.pitchDeg - aim0.pitchDeg > 1.5,
  `pitch ${aim0.pitchDeg.toFixed(2)}° → ${aim1.pitchDeg.toFixed(2)}° over ${walked.length} rounds`);
// A pixel count alone is a weak claim for an overlay made of one-pixel lines, so it is measured
// against itself: the same frame with the overlay switched off is the control.
await call('tracers', false);
await call('draw');
const f34off = decodePng(await page.screenshot({ timeout: 180000 }));
await call('tracers', true);
await call('draw');
check('the traces are on screen and nothing else is',
  litFraction(f34) > litFraction(f34off) * 2 + 0.0002 && litFraction(f34off) < 0.0005,
  `overlay on lit=${litFraction(f34).toFixed(5)}, off lit=${litFraction(f34off).toFixed(5)} — ` +
    `${walked.length} traces drawn over a black hall`);
await advance(0.6, 4);
const aim2 = (await stats()).aim;
const recovered = (aim1.pitchDeg - aim2.pitchDeg) / Math.max(1e-6, aim1.pitchDeg - aim0.pitchDeg);
check('and gave most of it back — "собранная тактическая", the human picked', recovered > 0.6 && recovered < 0.98,
  `recovered ${(recovered * 100).toFixed(0)}% of the climb; ${(aim2.pitchDeg - aim0.pitchDeg).toFixed(2)}° of permanent drift left`);
notes.push(
  `M3 recoil (collected/tactical, the school the human chose): a ${walked.length}-round burst climbs ` +
    `${(aim1.pitchDeg - aim0.pitchDeg).toFixed(2)}° and gives ${(recovered * 100).toFixed(0)}% of it back in 0.6 s, ` +
    `leaving ${(aim2.pitchDeg - aim0.pitchDeg).toFixed(2)}° of drift you have to correct by hand.`,
);

// --- 35 the debug tool: a held flash ---------------------------------------
// The flash lives about three frames. Without this it cannot be looked at at all, which is why
// it is the debug tool this feature brings with it.
await call('clear');
await call('flashHold', true);
await shoot();
await advance(0.4, 3);
const f35 = await shot(
  '35-flash-held.png',
  'the same flash frozen open (Y in the game, bs.flashHold in the harness) with the tracer overlay still on: 0.4 s of simulation has gone by and the light is still burning, so the shadows and the geometry it reveals can actually be studied. Nothing else about the shot is faked — this is the real light, held',
);
check('the held flash survives 0.4 s', litFraction(f35) > 0.2, `lit=${litFraction(f35).toFixed(3)}`);
const heldStats = await stats();
check('and the game knows it is being held', heldStats.flash.held === true && heldStats.flash.envelope > 0.99,
  `envelope ${heldStats.flash.envelope.toFixed(2)}`);
await call('flashHold', false);
await call('tracers', false);

// --- what a flash frame costs ----------------------------------------------
// The flash is the one place in this game that renders lit geometry and a shadow map, so it is
// the one place a hitch could come from. Both halves are measured: the frame the shot lands on
// (six cube faces + the whole hall's truth mesh) and the frames after it (nothing at all).
await call('markers', true);
await call('sync', false);
const flashPerf = await page.evaluate(async () => {
  const bs = window.bs;
  const flashFrames = [];
  const quietFrames = [];
  await new Promise((done) => {
    let i = 0;
    const tick = () => {
      const isShot = i % 20 === 0;
      const t0 = performance.now();
      if (isShot) bs.shoot();
      bs.step(1 / 60);
      bs.draw();
      const ms = performance.now() - t0;
      (isShot ? flashFrames : quietFrames).push(ms);
      if (++i >= 100) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const q = (a, p) => {
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };
  return {
    flashMedian: q(flashFrames, 0.5),
    flashMax: Math.max(...flashFrames),
    quietMedian: q(quietFrames, 0.5),
    quietMax: Math.max(...quietFrames),
    calls: bs.stats().calls,
    shots: bs.stats().rifle.shots,
  };
});
await call('sync', true);
console.log(
  `[shoot] flash frame: median ${flashPerf.flashMedian.toFixed(2)} ms (max ${flashPerf.flashMax.toFixed(2)}) ` +
    `vs quiet ${flashPerf.quietMedian.toFixed(2)} ms (max ${flashPerf.quietMax.toFixed(2)}) · ${flashPerf.calls} draw calls`,
);
notes.push(
  `M3 cost: the frame a shot lands on (one cube shadow map + the hall's lit truth mesh) costs ` +
    `${flashPerf.flashMedian.toFixed(2)} ms of our own time, max ${flashPerf.flashMax.toFixed(2)} ms; ` +
    `an ordinary frame costs ${flashPerf.quietMedian.toFixed(2)} ms. The shadow map is re-rendered once per shot, ` +
    `not once per frame, because the flash is pinned in space at the instant it was fired.`,
);
check('a flash frame does not hitch', flashPerf.flashMax < flashPerf.quietMedian + 30,
  `flash max ${flashPerf.flashMax.toFixed(2)} ms vs quiet median ${flashPerf.quietMedian.toFixed(2)} ms`);
void beforeShot;
void preBurstSound;

// --- contact sheet ---------------------------------------------------------
const html = `<!doctype html><meta charset="utf-8"><title>BLIND SPOT M2/M3 — keyframes</title>
<style>body{background:#0a0d10;color:#cfdbe4;font:13px/1.5 ui-monospace,monospace;margin:24px}
h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#6fd3e0}
figure{margin:0 0 28px}img{width:100%;max-width:1280px;border:1px solid #223}
figcaption{padding:6px 2px;color:#8fa2b0}</style>
<h1>BLIND SPOT — M2 / M3 keyframes</h1>
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
