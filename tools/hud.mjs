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
/**
 * Fraction of the frame that is unmistakably *red* — red at least 30/255 above both other
 * channels. This is the only way to check the "colour is identity" rule as a number: a spider
 * on the ring has to come back red and a falling crate must not, at any brightness.
 */
const redFraction = (img) => {
  const { data, channels } = img;
  const px = img.width * img.height;
  let red = 0;
  for (let i = 0; i < px; i++) {
    const r = data[i * channels];
    const g = data[i * channels + 1];
    const b = data[i * channels + 2];
    if (r > 40 && r - Math.max(g, b) > 30) red++;
  }
  return red / px;
};
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
  /*
   * The touch channel is off in every frame this generator takes, and it is not a cosmetic
   * choice. It draws the tactile contour of the rifle in your own hands, it *accumulates* felt
   * points as the frame is drawn, and two consecutive redraws of one simulation tick therefore
   * differ — which destroys the A/B pairs this whole file is built on (the wedge frame and its
   * twin without the wedge would differ by the gun, not by the wedge) and puts a lit object in
   * the corner of the "sound layer off ⇒ black" proof that has nothing to do with the sound
   * layer. It belongs to another channel and to another generator.
   */
  await call('touch', false);
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
/*
 * Two channels that are not the subject of this file are switched off before the first tick.
 *
 * The touch layer paints what the player's hand has felt into the *shared* point cloud, so it
 * has to go off before anything is simulated rather than before the first screenshot — switch
 * it off later and it hides the layer while leaving everything it already painted.
 *
 * The rifle in his own hands (another agent's viewmodel, M4d) is drawn in the bottom-right of
 * every first-person frame whether or not a noise has ever happened, and its felt contour
 * resamples on every draw. Left on, it makes each A/B pair here differ by the gun instead of by
 * the switch under test, and it makes "the sound layer off ⇒ the frame is black" unprovable —
 * there would always be a rifle in it. It is a real part of his screen and it is somebody
 * else's proof; it is not evidence about the HUD.
 */
await call('touch', false);
await call('rifleMesh', false);
// Read before anything is switched: the style the game boots with is itself a deliverable.
const bootMarkerStyle = await call('markerStyle');
const bootHudStyle = await page.evaluate(() => window.bs.vitals.hudStyles()[0]);
// Whether the noise compass is on when the game opens is itself a decision the human made, so
// it is read here — before any scenario touches the switch — and checked in section 8.
const bootCompass = (await page.evaluate(() => window.bs.vitals.state())).compass.enabled;
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
// 6. The look of the HUD. The player's verdict on the M5 layer was that it
//    "по визуалу ломает иммершн", so this section is not a demo of a feature —
//    it is a menu. One identical tick, one identical bite, one identical noise
//    behind him, through all four theories of what the HUD is. He picks.
// ===========================================================================
await call('vitals.reset');
await call('vitals.health', 100);
await call('pose', HOME.x, HOME.z, 90);
await call('clear');
await call('spiders.spawn', 0);
await advance(0.6, 4);
await playerCam(90, 0);
await call('vitals.compass', true);
// Something behind him to put on the compass, and something to the side, so every style has to
// draw both of the things it draws.
const NOISY = await propInArc(100, 175, 6, 15);
if (NOISY !== null) await call('disturb', NOISY.x, NOISY.y + 0.2, NOISY.z, 2.6, 6);
await call('vitals.biteFrom', -145);
// A third of a second after the bite: long enough that `sonar` has had a refresh tick and the
// flinch is still swinging, which is the moment all four looks differ most.
await advance(0.33, 2);

await call('vitals.layer', false);
await redraw();
const lookOff = await shot(
  '10-look-none.png',
  'the control for the four frames below: the same tick with the player layer switched off entirely. Whatever the next four frames ' +
    'show, they show it against this',
);
await call('vitals.layer', true);

const looks = {};
for (const [name, file, note] of [
  [
    'visor',
    '11-look-visor.png',
    'visor — the HUD is a physical piece of glass in front of his face. There is not one shape in it: the bite is heat soaking into ' +
      'the corner it came from, lopsided and off-centre, the noise behind him is a faint smudge at the rim, and the whole layer swings ' +
      'against the flinch because glass has mass. The dark closes in harder from the side that hurt him, so the bearing survives ' +
      'without a marker',
  ],
  [
    'sonar',
    '12-look-sonar.png',
    'sonar — the HUD is a device with a bad refresh rate. Bearings are snapped to 32 sectors, brightness to three levels, and the ' +
      'whole readout steps at 4 Hz, so a bite is reported a beat after it lands. Thin colourless ticks, no ring drawn between them. ' +
      'It reads as an instrument precisely because it is visibly worse than the truth',
  ],
  [
    'bone',
    '13-look-bone.png',
    'bone — there is no instrument at all. Nothing is drawn, ever: the only element is the dark, it closes in harder from the side he ' +
      'was bitten from, it leans in from the bearing of a noise, and it breathes at a rate that climbs as he bleeds. The most literal ' +
      'reading of law 1 in the set — at full health with a quiet hall it renders zero pixels',
  ],
  [
    'ring',
    '14-look-ring.png',
    'ring — the M5 layer, unchanged, so the other three are judged against the thing that was rejected and not against memory. Two ' +
      'mathematically exact circles centred on the reticle in the muzzle flash’s own hue, pinned to the pixel grid while the head ' +
      'is knocked. Everything in this frame that reads as "interface stuck on top of the game" is on that list',
  ],
]) {
  await call('vitals.hudStyle', name);
  await redraw();
  const img = await shot(file, note);
  looks[name] = { lit: litFraction(img), mean: meanLuminance(img) };
}
check(
  'all four looks draw the same event differently',
  new Set(Object.values(looks).map((l) => l.lit.toFixed(4))).size === 4,
  Object.entries(looks)
    .map(([k, v]) => `${k} lit ${v.lit.toFixed(4)}`)
    .join(', '),
);
check(
  'and none of them is a bright screen',
  Object.values(looks).every((l) => l.lit < 0.35),
  Object.entries(looks)
    .map(([k, v]) => `${k} ${v.lit.toFixed(4)}`)
    .join(', '),
);
check(
  'bone only ever subtracts light',
  looks.bone.mean <= meanLuminance(lookOff) + 0.01,
  `bone mean ${looks.bone.mean.toFixed(2)} against ${meanLuminance(lookOff).toFixed(2)} with the layer off`,
);
check(
  'and the HUD look the game boots with is the one he picked',
  bootHudStyle === 'sonar',
  `boots as ${bootHudStyle}`,
);
notes.push(
  'what broke the immersion in the M5 HUD, named rather than tuned: perfect circles (the only Euclidean object in a game made of ' +
    'boxes, dots and blobs), a look that never changes and never lags, being pinned to the pixel grid while the head is knocked, and ' +
    'owning the muzzle flash’s own hue. Frames 11-14 are four different answers, switchable in the GUI (player / hud → look).',
);

// ===========================================================================
// 7. The sound layer: `pulse` is the explicitly chosen default. The law that is easy
//    to break here is law 2 — the layer draws
//    events, it does not light the room — so the section ends by switching it
//    off and proving the same frame is black.
// ===========================================================================
await call('vitals.layer', false);
await call('vitals.compass', false);
await call('vitals.reset');
await call('pose', HOME.x, HOME.z, 90);
await call('clear');
await advance(0.5, 4);
await playerCam(90, 0);

// Three real props in front of him, knocked over at the same tick, so every style is drawing the
// identical set of events at the identical age.
const TARGETS = [];
for (const [lo, hi] of [[-40, -8], [-8, 12], [12, 44]]) {
  const t = await propInArc(lo, hi, 4, 12);
  if (t !== null) TARGETS.push(t);
}
check('the hall has something to knock over in front of him', TARGETS.length >= 2, `${TARGETS.length} props found`);
for (const t of TARGETS) await call('disturb', t.x, t.y + 0.2, t.z, 2.4, 7);
// A quarter of a second in: `pulse`'s shells are mid-flight, which is the only moment that
// tells the two versions of it apart.
await advance(0.26, 2);

const styleShots = {};
for (const [name, file, note] of [
  [
    'echo',
    '15-marks-echo.png',
    'echo — the previous default, retained as a selectable comparison. Hue is identity and never quantity: everything the world ' +
      'does is one bone-white, anything alive that is not you is red, and loudness is carried by size and burn alone',
  ],
  [
    'pulse-v1',
    '16-pulse-before.png',
    'pulse, before. One fat shell over the first third of a second and then a filled core for the remaining six and a half seconds — ' +
      'which is why it was only "близко": for 95% of a mark’s life it was a dimmer echo, not a different channel',
  ],
  [
    'pulse',
    '17-pulse-after.png',
    'pulse, after. Hollow. A finite generator launches ten waves every 0.67 seconds; each successor follows a smooth smaller death radius, ' +
      'so several generations overlap without a persistent centre pip. Nothing else in the set has a hollow middle, and a hollow ring is the ' +
      'strongest available statement that this is a reading and not a lamp: light fills, an instrument rings',
  ],
]) {
  await call('markerStyle', name);
  await redraw();
  const img = await shot(file, note);
  styleShots[name] = { lit: litFraction(img), mean: meanLuminance(img) };
}
check(
  'the finished pulse is not a variation of echo',
  styleShots.pulse.lit < styleShots.echo.lit * 0.5,
  `the same three events: echo fills ${(styleShots.echo.lit * 100).toFixed(2)}% of the frame as soft blobs, ` +
    `pulse only ${(styleShots.pulse.lit * 100).toFixed(2)}% as thin travelling shells`,
);
check(
  'and the finished one is hollow where the old one was filled',
  styleShots.pulse.lit < styleShots['pulse-v1'].lit * 0.7,
  `the same three events cover ${(styleShots['pulse-v1'].lit * 100).toFixed(2)}% of the frame as filled discs and ` +
    `${(styleShots.pulse.lit * 100).toFixed(2)}% as rings`,
);

check('pulse is the style the game boots with', bootMarkerStyle === 'pulse', `booted as ${bootMarkerStyle}`);

// The law. Same tick, same three collapsed stacks, the sound layer switched off: if any pixel
// survives, something in this layer has been lighting the room.
await call('markerStyle', 'echo');
await call('markers', false);
await redraw();
const dark = await shot(
  '18-marks-off-black.png',
  'the identical tick with the sound layer switched off. It is black to the last pixel, which is the proof of law 2: the marks draw ' +
    'the *fact* that three stacks went over in front of him and light nothing — no wall, no floor, no shadow. Everything visible in ' +
    'frames 15-17 is the event itself and none of it is illumination',
);
check('with the sound layer off the same frame is pure black', litFraction(dark) === 0, `lit ${litFraction(dark).toFixed(6)}, mean ${meanLuminance(dark).toFixed(4)}`);
await call('markers', true);
await call('vitals.layer', true);
notes.push(
  'law 2 checked as a number, not as an opinion: frame 18 is the same simulation tick as 15-17 with the sound layer switched off, ' +
    'and it is black to the last pixel.',
);

// ===========================================================================
// 8. The colour of a sound. Red is "something alive that is not you" and it is
//    the only hue on the ring; everything else the world does is one neutral
//    bone grey. Colour answers *who*, never *how loud* and never *how far* —
//    those are already brightness, and encoding them twice only makes the ring
//    harder to read. The section shoots the two side by side and then measures
//    the red as a number, because "it looks reddish" is not a proof.
// ===========================================================================
await call('vitals.reset');
await call('markerStyle', 'echo');
await call('pose', HOME.x, HOME.z, 0);
await call('clear');
await call('vitals.compass', true);
await call('vitals.hudStyle', 'sonar');
await playerCam(0, 0);

// A crate goes over behind his left shoulder: the neutral half of the palette, and a real
// physical event rather than a poked bus.
const CRATE = await propInArc(110, 175, 5, 14);
check('a crate to knock over behind him', CRATE !== null, CRATE ? `${CRATE.d.toFixed(1)} m away at ${CRATE.deg.toFixed(0)}°` : 'none found');
if (CRATE !== null) await call('disturb', CRATE.x, CRATE.y + 0.2, CRATE.z, 2.6, 6);
await advance(0.3, 3);
const crateOnly = await shot(
  '19-colour-crate.png',
  'sonar, the look he picked, with the noise compass on — which is now the default. A stack of clutter has just gone over behind ' +
    'his right shoulder and the ring reports it as a neutral bone-grey tick: a bearing, a brightness, and no claim about what it was',
);
const crateNotches = await call('vitals.notches');

// Now the other half: live spiders behind him, at his back where the sound layer cannot draw
// them, making their own real noises on the same bus.
await call('spiders.spawn', 6);
await page.evaluate(([cx, cz]) => {
  const bs = window.bs;
  const n = bs.spiders.list().length;
  for (let i = 0; i < n; i++) {
    // A fan behind his head, 6-9 m out: off-screen, so the compass is the only channel that can
    // report them at all — which is the whole reason it exists.
    const a = Math.PI + (i - (n - 1) / 2) * 0.26;
    const r = 6 + (i % 3);
    bs.spiders.place(i, cx + Math.sin(a) * r, cz + Math.cos(a) * r);
  }
}, [HOME.x, HOME.z]);
await advance(1.6, 4);
const spiderNotches = await call('vitals.notches');
const spiderShot = await shot(
  '20-colour-spiders.png',
  'the same look, the same ring, one second later: six spiders are fanned out behind him and every noise they make comes back red. ' +
    'Nothing else in the game draws red on this layer, so the reading is unambiguous at a glance and in the corner of the eye — ' +
    'and it says who, not how close: a faint spider is a dim red tick, a loud one a bright red tick',
);

const alienDrawn = spiderNotches.filter((n) => n.alien).length;
const neutralDrawn = spiderNotches.filter((n) => !n.alien).length;
check(
  'the pack behind him is on the ring at all',
  alienDrawn > 0,
  `${alienDrawn} living notch(es) of ${spiderNotches.length} drawn, none of them visible in frame`,
);
check(
  'and the ring says who, not how loud',
  crateNotches.length > 0 && crateNotches.every((n) => !n.alien),
  `the crate drew ${crateNotches.length} neutral notch(es) and 0 red ones; the pack drew ${alienDrawn} red and ${neutralDrawn} neutral`,
);
check(
  'red on screen is exactly the living half',
  redFraction(spiderShot) > 0 && redFraction(crateOnly) < redFraction(spiderShot) * 0.25,
  `spiders ${(redFraction(spiderShot) * 100).toFixed(3)}% of the frame is red, the crate alone ${(redFraction(crateOnly) * 100).toFixed(3)}%`,
);
check('the noise compass is on when the game opens', bootCompass === true, `boots ${bootCompass ? 'on' : 'off'}`);

// The same instant in `visor`, because the human kept it alive ("мб потом все таки визор
// заюзаем") and it has to carry the same law: heat off a living thing is red heat.
await call('vitals.hudStyle', 'visor');
await redraw();
await shot(
  '21-colour-visor.png',
  'the identical tick in `visor` — kept in the set at his request. Same rule, different physics: the ring is gone and what is left is ' +
    'red heat soaking into the glass from the bearing the pack is on, with the crate a colourless smudge on the other side',
);

// And the law, once more, on the coloured layer: colour is not permission to light the room.
await call('vitals.hudStyle', 'sonar');
await call('vitals.layer', false);
await call('markers', false);
await redraw();
const colourDark = await shot(
  '22-colour-off-black.png',
  'the same tick with the sound layer and the HUD layer both off. Black to the last pixel: six spiders are moving eight metres behind ' +
    'him and colour has not lit one photon of the hall. Red is a reading about who made a noise, not a light source',
);
check(
  'colour did not turn the layer into a lamp',
  litFraction(colourDark) === 0,
  `lit ${litFraction(colourDark).toFixed(6)}, mean ${meanLuminance(colourDark).toFixed(4)}`,
);
await call('markers', true);
await call('vitals.layer', true);
await call('spiders.spawn', 0);
notes.push(
  'colour now means one thing and only one thing: who made the noise. Red = something alive that is not you, one neutral grey = ' +
    'everything else. Loudness stays brightness and distance stays unsaid, so the palette is two entries wide and does not grow.',
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
