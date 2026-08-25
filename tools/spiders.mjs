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


/**
 * The headline scenario, in one page call: the player stands *perfectly still* — no keys, no
 * footfalls, nothing on the bus at all — and the pack is sampled once a second. Returns the
 * distance track, which is the actual proof: if these numbers do not fall, the milestone failed.
 */
const standStill = (sec, hx, hz) =>
  page.evaluate(
    ([s, x, z]) => {
      const bs = window.bs;
      const track = [];
      for (let t = 0; t < s; t++) {
        for (let i = 0; i < 120; i++) {
          bs.step(1 / 120);
          if (i % 24 === 0) bs.draw();
        }
        const list = bs.spiders.list().filter((sp) => sp.alive);
        const ds = list.map((sp) => Math.hypot(sp.x - x, sp.z - z)).sort((a, b) => a - b);
        const st = bs.spiders.stats();
        track.push({
          t: t + 1,
          near: ds[0] ?? Infinity,
          near3: ds.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, ds.length),
          mean: ds.reduce((a, b) => a + b, 0) / ds.length,
          mode: st.mode,
          courage: st.meanCourage,
          strikes: st.strikes,
        });
      }
      bs.draw();
      return track;
    },
    [sec, hx, hz],
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
// 0. «Выдал себя, стою N секунд — и они пришли.»
//
// The milestone's headline claim, and the one the human said was broken: he fired, which is the
// loudest event the game has, and the pack stayed «где-то далеко». So: fourteen spiders on a
// 20 m ring, one round fired, and then the player does *nothing at all* — no keys, no steps, no
// further noise — for half a minute. The only thing the pack ever gets is that single bang.
//
// The numbers under the frames are the proof, not the pictures.
// ===========================================================================
const HOME = { x: 2, z: 2 };
await call('spiders.spawn', 14);
await call('pose', HOME.x, HOME.z, 90);
const RING = 20;
await ring(HOME.x, HOME.z, RING);
await advance(0.5, 4);
const beforeShot = await spiderList();
const startDists = beforeShot
  .map((s) => Math.hypot(s.x - HOME.x, s.z - HOME.z))
  .sort((a, b) => a - b);

await call('aim', 90, 0);
await call('shoot');
await truthCam(HOME.x, HOME.z, 40);
await advance(0.02, 1);
await shot(
  '00a-gave-myself-away.png',
  `t=0. One round, then the player freezes. Fourteen spiders on a ${RING} m ring, nearest ${startDists[0].toFixed(1)} m, furthest ${startDists[13].toFixed(1)} m. The first thing a bang does is scare them — blue-lilac FLEE, goal lines pointing outwards — but every belief sphere has just snapped onto the muzzle`,
);

const trackA = await standStill(10, HOME.x, HOME.z);
await truthCam(HOME.x, HOME.z, 40);
await advance(0.02, 1);
await shot(
  '00b-they-are-coming.png',
  `t=10 s of standing still. The fright has worn off and the leads have not: nearest ${trackA[9].near.toFixed(1)} m, mean ${trackA[9].mean.toFixed(1)} m, pack mode ${trackA[9].mode}. Every goal line points inwards at the same spot. Nobody has heard anything since the shot — they are walking to a memory`,
);

const trackB = await standStill(20, HOME.x, HOME.z);
// trackB counts its own seconds from zero; the track is one continuous stand-still, so shift it.
const track = [...trackA, ...trackB.map((r) => ({ ...r, t: r.t + trackA.length }))];
await truthCam(HOME.x, HOME.z, 26);
await advance(0.02, 1);
await shot(
  '00c-they-came.png',
  `t=30 s. Same camera, tighter. Nearest ${track[track.length - 1].near.toFixed(1)} m, mean of the closest three ${track[track.length - 1].near3.toFixed(1)} m, ${track[track.length - 1].strikes} bites landed. He never moved and never made another sound after the shot`,
);

console.log('[spiders] stand-still track — distance to the player, metres:');
console.log(`[spiders]   t=0   near ${startDists[0].toFixed(1)}  mean ${(startDists.reduce((a, b) => a + b, 0) / startDists.length).toFixed(1)}`);
for (const r of track) {
  if (r.t % 2 !== 0 && r.t !== 1) continue;
  console.log(
    `[spiders]   t=${String(r.t).padStart(2)}s near ${r.near.toFixed(1).padStart(5)}  near3 ${r.near3.toFixed(1).padStart(5)}` +
      `  mean ${r.mean.toFixed(1).padStart(5)}  ${r.mode.padEnd(6)} courage ${r.courage.toFixed(2)} strikes ${r.strikes}`,
  );
}
notes.push(
  `stand-still track (one shot, then nothing): near ` +
    [0, 4, 9, 14, 19, 24, 29].map((i) => (i === 0 ? startDists[0] : track[i].near).toFixed(1)).join(' → ') +
    ` m at t = 0, 5, 10, 15, 20, 25, 30 s.`,
);

const last = track[track.length - 1];
check(
  'the pack closes on a player who only gave himself away once',
  last.near3 < startDists[2] * 0.4,
  `nearest three were ${((startDists[0] + startDists[1] + startDists[2]) / 3).toFixed(1)} m at the shot, ${last.near3.toFixed(1)} m thirty seconds later`,
);
check(
  'and it gets all the way in, not to some standoff radius',
  Math.min(...track.map((r) => r.near)) < 2.5,
  `closest approach ${Math.min(...track.map((r) => r.near)).toFixed(1)} m, ${last.strikes} bites`,
);

await playerCam(90, 0);
await advance(0.02, 1);
await shot(
  '00d-they-came-player.png',
  'the same thirty seconds from inside his head: he fired once and then heard them arrive. Every blob is a click or a footfall that really happened at that point — the pack talking itself into range around a man who is standing perfectly still',
);

// The control, and the reason this is not just "the aggression was turned up": identical setup,
// identical thirty seconds, no shot fired. Nothing is ever heard, so nothing ever comes.
await call('spiders.spawn', 14);
await call('pose', HOME.x, HOME.z, 90);
await ring(HOME.x, HOME.z, RING);
await advance(0.5, 4);
// Strikes are a lifetime counter for the whole run, so the control is judged on its own delta.
const strikesAtControl = (await spiderStats()).strikes;
const silent = await standStill(30, HOME.x, HOME.z);
await truthCam(HOME.x, HOME.z, 40);
await advance(0.02, 1);
await shot(
  '00e-silent-control.png',
  `the control: the same ring, the same thirty seconds, but the player never fires and never moves. Nearest ${silent[29].near.toFixed(1)} m, mean ${silent[29].mean.toFixed(1)} m, courage ${silent[29].courage.toFixed(2)}, ${silent[29].strikes - strikesAtControl} bites — they wander where they were. The pack is not attracted to the player, it is attracted to noise`,
);
check(
  'silence is safe — the fix is hearing, not aggression',
  silent[29].near3 > 8 && silent[29].strikes === strikesAtControl,
  `no shot fired: nearest three ${silent[29].near3.toFixed(1)} m after 30 s, courage ${silent[29].courage.toFixed(2)}, ${silent[29].strikes - strikesAtControl} bites`,
);

// ===========================================================================
// 1. The pack circles.
// ===========================================================================
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
// 5. Two rounds kill one.
//
// «Пауков должно быть можно убить, пара выстрелов думаю.» The rifle is a plain hitscan and knows
// nothing about spiders; the swarm tests the bullet segment against its own bodies. So the proof
// has to be a real shot from the real gun at a real spider, which means the scenario first has to
// work out how to point the player at a thing — hence the two calibration rounds.
// ===========================================================================
await call('spiders.spawn', 14);
await call('pose', HOME.x, HOME.z, 0);
const aimCal = await (async () => {
  const a = await call('shoot');
  await call('aim', 20, 0);
  const b = await call('shoot');
  await call('aim', 0, 10);
  const c = await call('shoot');
  const ang = (t) => Math.atan2(t.ez - t.oz, t.ex - t.ox);
  let d = ang(b) - ang(a);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return {
    base: ang(a),
    yawSign: Math.sign(d) || 1,
    pitchSign: Math.sign(c.ey - c.oy) || 1,
  };
})();
/** Yaw/pitch in the game's own degrees that puts the muzzle on a world point. */
const aimAt = (eye, x, y, z) => {
  let d = Math.atan2(z - eye[2], x - eye[0]) - aimCal.base;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const flat = Math.hypot(x - eye[0], z - eye[2]);
  return {
    yaw: (aimCal.yawSign * d * 180) / Math.PI,
    pitch: (aimCal.pitchSign * Math.atan2(y - eye[1], flat) * 180) / Math.PI,
  };
};

// A fresh pack, everyone parked in a far corner, one volunteer three metres in front.
await call('spiders.spawn', 14);
await page.evaluate(() => {
  for (let i = 1; i < 14; i++) window.bs.spiders.place(i, -30 + (i % 5), -18 + Math.floor(i / 5));
});
const eye = (await page.evaluate(() => window.bs.stats().eye));
await page.evaluate(
  ([x, z, b]) => window.bs.spiders.place(0, x + Math.cos(b) * 3, z + Math.sin(b) * 3),
  [HOME.x, HOME.z, aimCal.base],
);
await advance(0.2, 2);
const victim = (await spiderList())[0];
const look = aimAt(eye, victim.x, victim.y + 0.18, victim.z);
await call('aim', look.yaw, look.pitch);
const killsBefore = (await spiderStats()).kills;
await call('shoot');
await advance(0.05, 1);
const wounded = (await spiderList())[0];
await call('lights', true);
await call('spiders.overlay', true);
await call('hud', true);
await call('view', 'top');
await call('topFocus', victim.x, victim.z);
await call('topHeight', 7);
await advance(0.02, 1);
await shot(
  '11-one-hit-panic.png',
  `one round in it. The label over its head says hp 1 and PANIC: a spider that survives being shot does not keep circling, it bolts and wrecks whatever it can reach, which is loud — a wounded spider lights up half the hall for you`,
);
check(
  'a hit registers and hurts',
  wounded.hp === 1,
  `spider #0 hp ${wounded.hp} after one round (state ${wounded.state})`,
);
await call('shoot');
await advance(0.05, 1);
const afterKill = await spiderStats();
await advance(0.02, 1);
await shot(
  '12-two-shots-dead.png',
  `and the second round kills it. The corpse stays where it fell — it is still matter, so the lidar can still find it — and its death went out on the bus as a real noise the rest of the pack heard`,
);
check(
  'two rounds kill a spider',
  afterKill.kills === killsBefore + 1 && afterKill.count === 13,
  `${afterKill.kills - killsBefore} kill from two rounds, ${afterKill.count} spiders left alive`,
);

// ===========================================================================
// 6. The lidar sees them.
//
// «Пауков должно быть можно сканить лидаром аналогично мелким объектам.» Not a spider renderer:
// they are bodies in the same dynamic paint pass as the clutter, with a point cloud sampled by
// the same `sampleShape`. The proof is a difference measurement — the same ping into the same
// corner of the same hall, with and without spiders standing in it.
// ===========================================================================
await call('spiders.spawn', 14);
await call('pose', HOME.x, HOME.z, 0);
await page.evaluate(
  ([x, z, b]) => {
    const bs = window.bs;
    for (let i = 0; i < 14; i++) {
      if (i < 5) {
        const off = (i - 2) * 1.1;
        bs.spiders.place(i, x + Math.cos(b) * (4.5 + (i % 2)) - Math.sin(b) * off, z + Math.sin(b) * (4.5 + (i % 2)) + Math.cos(b) * off);
      } else {
        bs.spiders.place(i, -30 + (i % 5), -18 + Math.floor(i / 5));
      }
    }
  },
  [HOME.x, HOME.z, aimCal.base],
);
// Frozen where they stand: this measures the scan, not the walk.
await call('spiders.tune', { speedIdle: 0, speedStalk: 0, speedCreep: 0, speedCommit: 0, speedFlee: 0 });
await advance(0.2, 2);
await playerCam((aimCal.yawSign * 0 * 180) / Math.PI, -4);
await call('aim', 0, -4);
await call('clear');
// Wait for the hall itself to go quiet first: a crate still rocking from the two rounds of
// section 5 is a real noise the pack is entitled to hear, and it would be dishonest to charge
// that to the lidar. Once nothing has hit the bus for half a second, the only thing left to
// blame for a change in belief is the ping.
const quiet = await page.evaluate(async () => {
  const bs = window.bs;
  // Spiders talking to each other is not the hall being noisy, and it is not the lidar either,
  // so it does not count here.
  const world = () =>
    Object.entries(bs.stats().sound.bySource)
      .filter(([k]) => k !== 'spider')
      .reduce((a, [, v]) => a + v, 0);
  let last = world();
  for (let s = 0; s < 40; s++) {
    for (let i = 0; i < 60; i++) bs.step(1 / 120);
    const now = world();
    if (now === last) return { waited: s * 0.5, emitted: now };
    last = now;
  }
  return { waited: 20, emitted: last };
});
const beliefOf = () =>
  page.evaluate(() => ({
    belief: window.bs.spiders.list().reduce((a, s) => Math.max(a, s.belief.confidence), 0),
    emitted: Object.entries(window.bs.stats().sound.bySource)
      .filter(([k]) => k !== 'spider')
      .reduce((a, [, v]) => a + v, 0),
  }));
const before = await beliefOf();
const heardBefore = before.belief;
await call('fire');
await advance(1.5, 2);
const after = await beliefOf();
const heardAfter = after.belief;
const withSpiders = await page.evaluate(() => window.bs.stats().dyn.revealed);
const lidarShot = await shot(
  '13-lidar-sees-them.png',
  'one lidar ping down the aisle, nothing else on screen. The five knots of points standing clear of the clutter are spiders: same point cloud mechanism, same occlusion, same age fade as a crate — they are matter, so they scan. The lidar is silent, so scanning them does not tell them anything',
);
// Same ping, same everything, spiders taken out of the room.
await page.evaluate(() => {
  for (let i = 0; i < 14; i++) window.bs.spiders.place(i, -30 + (i % 5), -18 + Math.floor(i / 5));
});
await advance(0.2, 2);
await call('clear');
await call('fire');
await advance(1.5, 2);
const withoutSpiders = await page.evaluate(() => window.bs.stats().dyn.revealed);
await shot(
  '14-lidar-without-them.png',
  'the control: identical ping, identical aisle, spiders moved out of the hall. The difference between this frame and the last one is the pack',
);
check(
  'the lidar paints spiders like it paints clutter',
  withSpiders > withoutSpiders + 200,
  `${withSpiders} points revealed with five spiders in the aisle vs ${withoutSpiders} without — ${withSpiders - withoutSpiders} of them are spider`,
);
check(
  'and scanning them tells them nothing',
  heardAfter <= heardBefore + 1e-6,
  `hall quiet after ${quiet.waited.toFixed(1)} s; strongest belief in the pack ${heardBefore.toFixed(3)} before the ping, ` +
    `${heardAfter.toFixed(3)} after, ${after.emitted - before.emitted} world sounds in between — the lidar is not on the sound bus`,
);
await call('spiders.tune', { speedIdle: 1.0, speedStalk: 2.4, speedCreep: 1.2, speedCommit: 5.2, speedFlee: 6.0 });

// ===========================================================================
// 7. The overlay, rebuilt.
// ===========================================================================
await call('spiders.spawn', 14);
await call('pose', HOME.x, HOME.z, 90);
await ring(HOME.x, HOME.z, 7);
await advance(0.4, 4);
await paceUntilHunting(6, 3, 20);
// The pack is hunting; this puts the half of it that is closing from the front into the frame,
// because a label you cannot see proves nothing. Nobody's state, belief or goal is touched.
await page.evaluate(
  ([x, z, dir]) => {
    for (let i = 0; i < 6; i++) {
      const a = dir + (i - 2.5) * 0.22;
      const d = 4.5 + (i % 3) * 1.6;
      window.bs.spiders.place(i, x + Math.cos(a) * d, z + Math.sin(a) * d);
    }
  },
  [HOME.x, HOME.z, aimCal.base + aimCal.yawSign * (Math.PI / 2)],
);
await advance(0.3, 3);
await call('lights', false);
await call('hud', true);
await call('spiders.overlay', true);
await call('view', 'third');
await advance(0.02, 1);
await shot(
  '15-overlay.png',
  'the debug overlay as it is now: each spider carries its own card — id, state and how long it has held it, which way it is walking and how far, its nerve, how far its belief is and how much it trusts it, and the last thing it heard. The table is a 300 px card in the corner that names its own key (SPIDERS [P]) instead of the half-screen block of text it used to be',
);
const panel = await page.evaluate(() => {
  const el = document.querySelector('.bs-spiders');
  const r = el.getBoundingClientRect();
  const labels = [...document.querySelectorAll('.bs-sp-label')].filter((n) => n.style.display !== 'none');
  return {
    frac: (r.width * r.height) / (window.innerWidth * window.innerHeight),
    labels: labels.length,
    sample: labels[0]?.textContent ?? '',
  };
});
check(
  'the panel does not cover the game any more',
  panel.frac < 0.09,
  `${(panel.frac * 100).toFixed(1)}% of the screen (it was up to 46% wide before)`,
);
check(
  'and the state is written in the world over each spider',
  panel.labels >= 4,
  `${panel.labels} world labels, e.g. "${panel.sample.replace(/\s+/g, ' ').slice(0, 60)}"`,
);

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
