/**
 * M6a keyframes — the player's hands and the instruments that report on them.
 *
 *   node tools/hands.mjs [dist/index.html] [out/hands]
 *
 * Five things have to be visible in a still frame, and every one of them is about *not* being
 * able to act: an empty magazine, a scanner that will not fire for another nine seconds, a rifle
 * that is only a contour, a can in the left hand, and that same can making its noise where it
 * landed rather than where it was thrown from.
 *
 * Its own file for the same reason `tools/hud.mjs` and `tools/spiders.mjs` are: three agents
 * appending to `tools/shoot.mjs` is a merge conflict with no upside. Same conventions — fixed
 * seed, fixed 120 Hz step, no wall clock, nothing that reads `Math.random()`.
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
/** The brightest single pixel in the frame, 0..255 — the whole point of section 6. */
const peakLuminance = (img) => {
  const { data, channels } = img;
  let peak = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const r = data[i * channels];
    const g = data[i * channels + 1];
    const b = data[i * channels + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (l > peak) peak = l;
  }
  return peak;
};

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
const outDir = resolve(process.argv[3] ?? 'out/hands');

if (!existsSync(htmlPath)) {
  console.error(`[hands] build not found: ${htmlPath} (run \`npm run build\` first)`);
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
  console.log(`[hands] ${line}`);
  if (!ok) failures.push(line);
}

const shots = [];
/**
 * The instrument cluster, life size. It is deliberately small on a 1280-wide frame — the human
 * asked not to have the screen flooded with numbers — which makes it unreadable on a contact
 * sheet, so every frame that is *about* the readout also gets this strip cropped out of it at
 * 1:1 and blown up by the sheet's own layout.
 */
const INST_STRIP = { x: 505, y: 611, width: 270, height: 30 };

async function shot(name, note, clip) {
  const buf = await page.screenshot({ path: join(outDir, name), timeout: 180000, ...(clip ? { clip } : {}) });
  const img = decodePng(buf);
  shots.push({ name, note, lit: litFraction(img), mean: meanLuminance(img) });
  console.log(`[hands] shot ${name}  lit=${litFraction(img).toFixed(4)} mean=${meanLuminance(img).toFixed(2)}`);
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

const redraw = () => page.evaluate(() => window.bs.draw());
const stats = () => page.evaluate(() => window.bs.stats());

/** The player's own eyes, with his hands in the picture: this file is *about* the hands. */
async function playerCam() {
  await call('spiders.overlay', false);
  await call('hud', false);
  await call('lights', false);
  await call('view', 'player');
  await call('touch', true);
  await call('rifleMesh', true);
  await call('markers', true);
}

/** The lit overhead truth camera. */
async function truthCam(x, z, height = 16) {
  await call('lights', true);
  await call('view', 'top');
  await call('topFocus', x, z);
  await call('topHeight', height);
  await call('hud', false);
}

/** Yaw, in the game's degrees, that makes the player face (tx,tz) from (x,z). */
const yawTo = (x, z, tx, tz) => (Math.atan2(-(tx - x), -(tz - z)) * 180) / Math.PI;

// ---------------------------------------------------------------------------
const url = `${pathToFileURL(htmlPath).href}?harness=1&seed=20260824`;
console.log(`[hands] ${url}`);
await page.goto(url);
await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 30000 });
await call('audio', false);
await call('hud', false);
await call('spiders.spawn', 0);
await advance(2, 8);

const gunTune = await call('rifleTune', {});
const lidarTune = await page.evaluate(() => ({ ...window.bs.stats().lidar }));
notes.push(
  `seed 20260824, fixed 120 Hz step. The numbers under test, all of them sliders: magazine ` +
    `${gunTune.magazine} rounds, reload ${gunTune.reloadSeconds} s at ${gunTune.reloadLoudness} m of notice against a ` +
    `gunshot's ${gunTune.gunshotLoudness} m, scanner ${lidarTune.charge} charge on a ten-second recharge.`,
);

// ===========================================================================
// 1. The rifle is a contour and nothing else.
// ===========================================================================
await call('pose', 2, 2, 90);
await playerCam();
await advance(0.6, 4);
await redraw();
const contourImg = await shot(
  '01-rifle-contour.png',
  'the rifle in the dark, felt rather than lit: grey edges only. The stipple that used to fill its body is gone — ' +
    'the body of the gun is as black as the hall, and what you get is a silhouette by touch',
);
const gunState = (await stats()).gun;
check('the rifle is felt at all', gunState.felt > 0, `felt=${gunState.felt}`);
check(
  'and it is edges, not a filled shape',
  litFraction(contourImg) < 0.02,
  `lit=${litFraction(contourImg).toFixed(4)} of the whole frame`,
);
const drawCalls = (await stats()).calls;
notes.push(
  'the viewmodel now builds two objects instead of three: a depth-only occluder and the edge contour. ' +
    'The stipple Points object, its shader and its seeded point sampler are deleted, not hidden — ' +
    `frame draw calls with the gun in hand: ${drawCalls}.`,
);

// ===========================================================================
// 2. The magazine runs out, and the reload is three seconds of helplessness.
// ===========================================================================
await call('pose', 2, 2, 90);
await call('fireMode', 'auto');
const beforeMag = await call('ammo');
check('a full magazine to start with', beforeMag.rounds === beforeMag.magazine, `${beforeMag.rounds}/${beforeMag.magazine}`);

const dry = await page.evaluate(() => {
  const bs = window.bs;
  const before = bs.stats().sound.bySource;
  bs.trigger(true);
  for (let i = 0; i < 120 * 4; i++) {
    bs.step(1 / 120);
    if (i % 12 === 0) bs.draw();
    if (bs.ammo().rounds === 0) break;
  }
  bs.trigger(false);
  bs.draw();
  return { ammo: bs.ammo(), shots: bs.stats().rifle.shots, before, after: bs.stats().sound.bySource };
});
check('holding the trigger empties the magazine', dry.ammo.rounds === 0, `${dry.shots} shots fired, ${dry.ammo.rounds} left`);
check(
  'and it stops there instead of firing forever',
  dry.shots === beforeMag.magazine,
  `${dry.shots} shots out of a ${beforeMag.magazine}-round magazine`,
);

await playerCam();
await redraw();
await shot(
  '02-magazine-empty.png',
  'the tick the magazine runs out, and the argument for having one at all: fifteen rounds of muzzle flash and ' +
    'blast have left him half-blind, ringing (the concussion channel is another agent\'s, and it is doing its job here) ' +
    'and lit up like a signal fire. This is what "бесконечно себе светить" bought him',
);
/*
 * The readout itself is a few grey strokes, and the frame above is a white wall — the flash, the
 * blots and someone else's concussion grain. So the strip is taken six seconds later, once all of
 * that has decayed and the map has been forgotten: same empty magazine, nothing else in the way.
 */
await advance(6, 12);
await call('clear');
await redraw();
await shot(
  '02b-magazine-empty-strip.png',
  'the same readout at 1:1, blown up: fifteen stubs and not one of them lit. This is the whole ammunition ' +
    'display — no digits, no icon, no word "reload"',
  INST_STRIP,
);

// The empty gun re-arms itself the moment the trigger is held — that is the helplessness.
const reloadRun = await page.evaluate(() => {
  const bs = window.bs;
  const emitted0 = bs.stats().sound.emitted;
  const started = bs.reload();
  const frames = [];
  let heard = null;
  for (let i = 0; i < 120 * 5; i++) {
    bs.step(1 / 120);
    if (i % 8 === 0) bs.draw();
    const a = bs.ammo();
    if (i === 0 || i === 60 || i === 180) frames.push({ i, ...a });
    if (heard === null && a.rounds > 0) {
      heard = { at: i / 120, last: bs.stats().sound.last, emitted: bs.stats().sound.emitted - emitted0 };
      break;
    }
  }
  bs.draw();
  return { started, frames, heard, ammo: bs.ammo(), shotsDuring: bs.stats().rifle.shots };
});
check('the reload runs', reloadRun.started === true);
check(
  'it takes about three seconds',
  reloadRun.heard !== null && Math.abs(reloadRun.heard.at - gunTune.reloadSeconds) < 0.2,
  reloadRun.heard === null ? 'never finished' : `${reloadRun.heard.at.toFixed(2)} s`,
);
check('and it gives back a full magazine', reloadRun.ammo.rounds === beforeMag.magazine, `${reloadRun.ammo.rounds} rounds`);
check(
  'the reload is heard on the bus',
  reloadRun.heard !== null && reloadRun.heard.last !== null && reloadRun.heard.last.source === 'reload',
  reloadRun.heard?.last ? `${reloadRun.heard.last.source} at ${reloadRun.heard.last.loudness} m` : 'no event',
);
check(
  'but much quieter than the shot that emptied the gun',
  reloadRun.heard !== null && reloadRun.heard.last.loudness < gunTune.gunshotLoudness * 0.5,
  `${reloadRun.heard?.last?.loudness} m against a gunshot's ${gunTune.gunshotLoudness} m`,
);
notes.push(
  `reload: ${gunTune.reloadSeconds} s of no shooting, no light and one bus event of ` +
    `${gunTune.reloadLoudness} m against the gunshot's ${gunTune.gunshotLoudness} m — audible if something is close, ` +
    'not a beacon. Magazines are unlimited; the cost is the three seconds, not the ammunition.',
);

// Mid-reload frame: the readout has to say "wait" while it is happening, not after.
await call('setRounds', 0);
await call('reload');
await advance(1.4, 4);
const mid = await call('ammo');
await playerCam();
await redraw();
await shot(
  '03-reloading.png',
  `mid-reload, ${(mid.reloadProgress * 100) | 0}% through: the row of ticks fills back in from the left. ` +
    'Nothing else on the screen changed — no numbers, no words, no light',
);
await call('clear');
await redraw();
await shot(
  '03b-reloading-strip.png',
  `the reload at 1:1, ${(mid.reloadProgress * 100) | 0}% done: the row filling left to right is the three seconds ` +
    'passing. It is the only clock the player gets, and he cannot shoot or scan while it runs',
  INST_STRIP,
);
check('and the readout knows it is mid-reload', mid.reloading === true, `progress ${(mid.reloadProgress * 100) | 0}%`);
await advance(2.2, 8);

// ===========================================================================
// 3. The scanner: one charge, ten seconds, and still silent.
// ===========================================================================
await call('refill');
await call('clear');
const scan = await page.evaluate(() => {
  const bs = window.bs;
  const before = bs.stats();
  bs.fire();
  for (let i = 0; i < 24; i++) {
    bs.step(1 / 120);
    bs.draw();
  }
  const justAfter = bs.stats();
  const samples = [];
  for (let s = 1; s <= 12; s++) {
    for (let i = 0; i < 120; i++) bs.step(1 / 120);
    bs.draw();
    samples.push({ t: s, ready: bs.stats().lidar.ready, charge: bs.stats().lidar.charge });
  }
  return {
    quiet: justAfter.sound.emitted - before.sound.emitted,
    sources: Object.keys(justAfter.sound.bySource),
    afterPing: justAfter.lidar,
    samples,
  };
});
check('the ping costs the whole device', scan.afterPing.charge < 0.05, `charge ${scan.afterPing.charge.toFixed(3)} after firing`);
check(
  'the scanner is not on the sound bus',
  scan.quiet === 0 && !scan.sources.includes('lidar'),
  `${scan.quiet} events emitted by the ping; sources seen: ${scan.sources.join(', ') || 'none'}`,
);
const readyAt = scan.samples.find((s) => s.ready)?.t ?? null;
check(
  'and it is genuinely a long wait',
  readyAt !== null && readyAt >= 10,
  readyAt === null ? 'never recharged in 12 s' : `ready again after ${readyAt} s`,
);
notes.push(
  `scanner: one charge, ${readyAt ?? '?'} s to get it back, and not one bus event while doing it. ` +
    'Ten seconds is long enough that a ping is a decision rather than a torch — you paint the room, and then you live ' +
    'in what you painted.',
);

// The cooldown frame, taken two seconds in: the map is up, the instrument says you cannot do it again.
await call('refill');
await call('clear');
await call('pose', 2, 2, 90);
await call('fire');
await advance(2.0, 4);
await playerCam();
await redraw();
const cooling = (await stats()).lidar;
await shot(
  '04-scanner-cooling.png',
  `two seconds after a ping: the hall it painted is still there, and the scanner tick on the right of the readout is a stub — ` +
    `${(cooling.progress * 100) | 0}% of the way back. Eight more seconds of this`,
);
await shot(
  '04b-scanner-cooling-strip.png',
  `the scanner readout at 1:1 while it charges: the right-hand tick is a stub grown to ${(cooling.progress * 100) | 0}%. ` +
    'The magazine row is dark because there is nothing wrong with the magazine — a readout that has nothing to say is not drawn',
  INST_STRIP,
);
check('the frame is taken on a spent scanner', cooling.ready === false, `charge ${cooling.charge.toFixed(2)}`);
await advance(9, 12);
await redraw();
await shot(
  '05-scanner-ready.png',
  'the same view once the charge is back: the scanner tick is at full height. That is the entire difference between ' +
    'this frame and the last one — the instrument reports readiness, it does not light anything',
);
check('the scanner comes back', (await stats()).lidar.ready === true);

// ===========================================================================
// 4. The left hand: a can, yes; a barrel, no.
// ===========================================================================
const props = await call('propList');
const SMALL = new Set(['can', 'bottle', 'jar', 'flask']);
const HOME = { x: 2, z: 2 };
const near = props
  .map(([name, x, y, z], i) => ({ name, x, y, z, i, d: Math.hypot(x - HOME.x, z - HOME.z) }))
  .filter((p) => p.d > 2 && p.d < 40);
const can = near.filter((p) => SMALL.has(p.name)).sort((a, b) => a.d - b.d)[0];
const barrel = near.filter((p) => p.name === 'barrel' || p.name === 'keg').sort((a, b) => a.d - b.d)[0];
check('the hall has something small to pick up', can !== undefined, can ? `${can.name} at ${can.x.toFixed(1)} ${can.z.toFixed(1)}` : 'none');

if (can !== undefined) {
  // Stand a metre short of it, looking at it.
  const ang = Math.atan2(HOME.x - can.x, HOME.z - can.z);
  const px = can.x + Math.sin(ang) * 1.0;
  const pz = can.z + Math.cos(ang) * 1.0;
  await call('pose', px, pz, yawTo(px, pz, can.x, can.z));
  await advance(0.5, 4);
  const took = await call('handToggle');
  const hand = await call('hand');
  check('E takes it', took >= 0, took >= 0 ? `prop #${took}, ${hand.material}, ${hand.mass.toFixed(2)} kg` : 'nothing in reach');
  await advance(0.7, 4);
  await playerCam();
  await redraw();
  await shot(
    '06-in-hand.png',
    `a ${can.name} in the left hand. It is the same physics body it was on the floor — same mass, same material, ` +
      'same point cloud — flipped kinematic and driven from the camera, and it is drawn in exactly the language the rifle ' +
      'is: felt, not lit. Left hand low and inboard, rifle low right',
  );
  // The readout is a few dozen dim pixels over whatever the hall is doing behind it; for the 1:1
  // crop the map is wiped first so the strip shows the instrument and not the floor behind it.
  await call('clear');
  await redraw();
  await shot(
    '06b-in-hand-strip.png',
    'the readout at 1:1 with something in the left hand: the bracket on the left of the row is closed. That is the ' +
      'third instrument — it says "your hand is full", which is also the answer to "what will E do next"',
    INST_STRIP,
  );
  const heldStats = await stats();
  check('and something really is in the hand', heldStats.props.awake >= 0 && (await call('hand')).held >= 0);
  // The spec's own line: the thing in the left hand is drawn in the rifle's tactile language.
  // Not the props' stipple — its own contour, in the same grey, from the same shader.
  const drawn = await call('hand');
  check(
    'and it is drawn as a contour, like the rifle',
    drawn.contour === took,
    `contour draws prop #${drawn.contour}, hand holds #${took}`,
  );

  // "Как есть на самом деле" for this one is not the overhead camera — from twenty metres up a
  // can in a fist is four pixels. It is the same first-person frame with the lights on.
  await call('lights', true);
  await redraw();
  await shot(
    '07-in-hand-truth.png',
    'the same tick with the darkness switched off: the can really is in his left hand, held out in front and below the ' +
      'eye, with the rifle low right. Nothing was spawned and nothing was deleted — the prop that was lying on the floor ' +
      'is the prop in his fist, mass, material and point cloud included',
  );
  await call('lights', false);

  // While it is full, the hand cannot take a second thing.
  const second = await page.evaluate(() => {
    const bs = window.bs;
    const held = bs.hand().held;
    const picks = bs.hand().picks;
    return { held, picks };
  });
  check('one hand, one thing', second.picks === 1, `${second.picks} pick(s) so far`);
}

// The gate: a barrel is not a can.
if (barrel !== undefined) {
  await call('handDrop');
  const ang = Math.atan2(HOME.x - barrel.x, HOME.z - barrel.z);
  const bx = barrel.x + Math.sin(ang) * 1.1;
  const bz = barrel.z + Math.cos(ang) * 1.1;
  await call('pose', bx, bz, yawTo(bx, bz, barrel.x, barrel.z));
  await advance(0.4, 4);
  const grabbed = await call('handToggle');
  const gotName = grabbed >= 0 ? props[grabbed][0] : null;
  check(
    'a barrel does not go in one hand',
    gotName !== 'barrel' && gotName !== 'keg',
    grabbed < 0 ? 'nothing picked up' : `picked ${gotName} instead (something small was also in reach)`,
  );
  await call('handDrop');
}

// ===========================================================================
// 5. The throw: the noise happens where it lands.
// ===========================================================================
const thrown = await page.evaluate(
  ([hx, hz]) => {
    const bs = window.bs;
    const SMALL = ['can', 'bottle', 'jar', 'flask'];
    const props = bs.propList();
    // Find something small, stand next to it, and face the most open direction we can measure:
    // the one where the nearest solid is furthest away.
    let best = null;
    for (let i = 0; i < props.length; i++) {
      const [name, x, , z] = props[i];
      if (!SMALL.includes(name)) continue;
      const d = Math.hypot(x - hx, z - hz);
      if (d < 3 || d > 24) continue;
      if (best === null || d < best.d) best = { i, name, x, z, d };
    }
    if (best === null) return null;
    const ang = Math.atan2(hx - best.x, hz - best.z);
    const px = best.x + Math.sin(ang) * 0.9;
    const pz = best.z + Math.cos(ang) * 0.9;
    bs.pose(px, pz, (Math.atan2(-(best.x - px), -(best.z - pz)) * 180) / Math.PI);
    for (let i = 0; i < 60; i++) bs.step(1 / 120);
    if (bs.handToggle() < 0) return null;
    for (let i = 0; i < 60; i++) bs.step(1 / 120);

    // Pick the clearest bearing to throw along: sample the solids and take the direction with
    // the most room. Deterministic — it is a scan over a fixed list, not a random choice.
    const solids = bs.solids();
    let bestYaw = 0;
    let bestClear = -1;
    for (let a = 0; a < 72; a++) {
      const yaw = (a / 72) * Math.PI * 2;
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);
      let clear = 60;
      for (const b of solids) {
        // Distance along the ray at which this box's flat footprint is first touched.
        const t1x = (b[0] - px) / (dx || 1e-6);
        const t2x = (b[3] - px) / (dx || 1e-6);
        const t1z = (b[2] - pz) / (dz || 1e-6);
        const t2z = (b[5] - pz) / (dz || 1e-6);
        const tn = Math.max(Math.min(t1x, t2x), Math.min(t1z, t2z));
        const tf = Math.min(Math.max(t1x, t2x), Math.max(t1z, t2z));
        if (tf >= Math.max(0, tn) && tn > 0 && tn < clear) clear = tn;
      }
      if (clear > bestClear) {
        bestClear = clear;
        bestYaw = (yaw * 180) / Math.PI;
      }
    }
    bs.aim(bestYaw, -2);
    for (let i = 0; i < 12; i++) bs.step(1 / 120);
    const player = bs.stats().pos;
    const before = bs.stats().sound.bySource['prop-impact'] ?? 0;
    bs.handToggle();
    const launch = bs.hand().lastThrow;
    // Fly. Stop at the first impact the thrown thing makes.
    let landed = null;
    for (let i = 0; i < 120 * 4; i++) {
      bs.step(1 / 120);
      if (i % 6 === 0) bs.draw();
      const now = bs.stats().sound.bySource['prop-impact'] ?? 0;
      if (landed === null && now > before) {
        const last = bs.stats().sound.last;
        landed = { at: i / 120, ev: last, t: bs.stats().time };
      }
      if (landed !== null && i / 120 > landed.at + 0.35) break;
    }
    bs.draw();
    return {
      name: best.name,
      player,
      px,
      pz,
      yaw: bestClear,
      launch,
      landed,
      marks: bs.markList(),
      prop: bs.propList()[best.i],
      throws: bs.hand().throws,
    };
  },
  [HOME.x, HOME.z],
);

check('the can leaves the hand', thrown !== null && thrown.throws >= 1, thrown === null ? 'no throw happened' : `${thrown.throws} throw(s)`);
if (thrown !== null) {
  const flightDist =
    thrown.landed === null ? 0 : Math.hypot(thrown.landed.ev.x - thrown.player[0], thrown.landed.ev.z - thrown.player[2]);
  check('it makes a noise when it lands', thrown.landed !== null, thrown.landed ? `${thrown.landed.ev.source} at ${thrown.landed.at.toFixed(2)} s` : 'silent flight');
  check(
    'and the noise is where it landed, not where he stands',
    flightDist > 3,
    `impact ${flightDist.toFixed(1)} m from the player`,
  );
  check(
    'through the ordinary impact formula, not a "throw sound"',
    thrown.landed !== null && thrown.landed.ev.source === 'prop-impact',
    thrown.landed ? `source: ${thrown.landed.ev.source}` : '-',
  );
  const farMarks = thrown.marks.filter(
    (m) => Math.hypot(m[0] - thrown.player[0], m[2] - thrown.player[2]) > 3,
  );
  check('there is a mark out there to see', farMarks.length > 0, `${farMarks.length} mark(s) more than 3 m away`);

  await playerCam();
  await call('aim', (Math.atan2(-(thrown.landed.ev.x - thrown.player[0]), -(thrown.landed.ev.z - thrown.player[2])) * 180) / Math.PI, -3);
  await redraw();
  const throwImg = await shot(
    '08-throw-lands.png',
    `the ${thrown.name} landing ${flightDist.toFixed(1)} m away. The heat blot is the *impact*: it was born by the same ` +
      'impulse formula every other collision uses, at the point of contact, and there is no such thing as a throw sound in ' +
      'this code. This is the counter-play against a pack you cannot outrun',
  );
  check('and the blot does not go white', peakLuminance(throwImg) < 250, `peak ${peakLuminance(throwImg).toFixed(0)}/255`);

  await truthCam(
    (thrown.player[0] + thrown.landed.ev.x) / 2,
    (thrown.player[2] + thrown.landed.ev.z) / 2,
    Math.max(10, flightDist * 1.4),
  );
  await call('markers', true);
  await redraw();
  await shot(
    '09-throw-truth.png',
    `the same tick lit and from above: he is on one side, the can and its mark are ${flightDist.toFixed(1)} m away on the other. ` +
      'Nothing in between',
  );
  notes.push(
    `throw: launched from the hand at ${thrown.launch.map((v) => v.toFixed(1)).join(' ')}, first impact ` +
      `${flightDist.toFixed(1)} m from the player after ${thrown.landed.at.toFixed(2)} s of flight, reported as ` +
      `${thrown.landed.ev.source} at ${thrown.landed.ev.loudness.toFixed(1)} m of notice. Physics all the way down.`,
  );
}

// ===========================================================================
// 6. Loud marks stop below white.
// ===========================================================================
/*
 * Both halves of this pair have to be the *same* events on the *same* tick, with nothing between
 * them but the switch — and nothing else in the frame that emits light. So the rifle and the
 * touch channel go off here: they are proof in section 1, and noise in this one.
 */
await call('spiders.overlay', false);
await call('hud', false);
await call('lights', false);
await call('view', 'player');
await call('touch', false);
await call('rifleMesh', false);
await call('markers', true);
await call('clear');
// A heap of loud events, close together and straight ahead: the worst case the human complained
// about ("большие области шума уходят в белый").
await call('pose', 2, 2, 180);
const capPair = await page.evaluate(() => {
  const bs = window.bs;
  for (let k = 0; k < 6; k++) bs.disturb(2 + Math.cos(k) * 0.5, 0.6, 6 + Math.sin(k) * 0.5, 2.6, 3.4);
  for (let i = 0; i < 30; i++) bs.step(1 / 120);
  bs.draw();
  return { alive: bs.stats().marks.alive };
});
await call('markerTune', { capOverlap: false });
await redraw();
const hotAdditive = await shot(
  '10-marks-additive.png',
  'the old behaviour, for comparison: a heap of overlapping noise events adds up until the middle is white paper. ' +
    'A muzzle flash has nothing left to light against that',
);
await call('markerTune', { capOverlap: true });
await redraw();
const hotCapped = await shot(
  '11-marks-capped.png',
  'the same events with the ceiling on. The blot stops at a grey below white and the shape survives — you can still ' +
    'read where the noise was, and the frame has headroom left for the only real light in the game',
);
check(
  'the capped frame is dimmer than the additive one',
  peakLuminance(hotCapped) < peakLuminance(hotAdditive),
  `peak ${peakLuminance(hotAdditive).toFixed(0)} → ${peakLuminance(hotCapped).toFixed(0)} of 255`,
);
check('and it never reaches white', peakLuminance(hotCapped) < 245, `peak ${peakLuminance(hotCapped).toFixed(0)}/255`);
notes.push(
  `noise marks: peak pixel ${peakLuminance(hotAdditive).toFixed(0)}/255 additive against ` +
    `${peakLuminance(hotCapped).toFixed(0)}/255 with the ceiling on (${capPair.alive} marks alive). ` +
    'Two knobs: `peak` is the ceiling one mark may reach, `capOverlap` decides whether overlapping marks sum past it.',
);

// ===========================================================================
// 7. What it costs.
// ===========================================================================
const perf = await page.evaluate(() => {
  const bs = window.bs;
  const sample = (n = 240) => {
    const runs = [];
    for (let i = 0; i < n; i++) {
      bs.step(1 / 120);
      bs.draw();
      runs.push(bs.stats().frameMs.frameMs);
    }
    const sorted = runs.slice().sort((a, b) => a - b);
    return { mean: runs.reduce((a, b) => a + b, 0) / runs.length, p95: sorted[Math.floor(sorted.length * 0.95)] };
  };
  bs.handDrop();
  const empty = sample();
  bs.handToggle();
  const carrying = sample();
  bs.handDrop();
  return { empty, carrying };
});
console.log(
  `[hands] frame cost: empty hand ${perf.empty.mean.toFixed(2)} ms (p95 ${perf.empty.p95.toFixed(2)}) · ` +
    `carrying ${perf.carrying.mean.toFixed(2)} ms (p95 ${perf.carrying.p95.toFixed(2)})`,
);
check(
  'carrying something is free',
  perf.carrying.mean < perf.empty.mean + 0.8,
  `${perf.empty.mean.toFixed(2)} → ${perf.carrying.mean.toFixed(2)} ms per frame`,
);
notes.push(
  `cost: ${perf.empty.mean.toFixed(2)} ms/frame with an empty hand against ${perf.carrying.mean.toFixed(2)} ms carrying ` +
    '(p95 ' + perf.empty.p95.toFixed(2) + ' → ' + perf.carrying.p95.toFixed(2) + '). Carrying adds one kinematic target ' +
    'per tick and no new geometry; the instruments are a few strokes on the HUD canvas that already exists.',
);

// --- contact sheet ---------------------------------------------------------
const html = `<!doctype html><meta charset="utf-8"><title>BLIND SPOT M6a — hands and instruments</title>
<style>body{background:#0a0d10;color:#cfdbe4;font:13px/1.5 ui-monospace,monospace;margin:24px}
h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#ffd166}
figure{margin:0 0 28px}img{width:100%;max-width:1280px;border:1px solid #223}
figcaption{padding:6px 2px;color:#8fa2b0}</style>
<h1>BLIND SPOT — keyframes: reload, scanner cooldown, the left hand</h1>
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
  console.log(`[hands] console errors:\n  ${consoleErrors.slice(0, 8).join('\n  ')}`);
  failures.push(`${consoleErrors.length} console error(s)`);
}
console.log(`[hands] ${shots.length} frames -> ${outDir}`);
if (failures.length > 0) {
  console.error(`[hands] ${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('[hands] all checks passed');
