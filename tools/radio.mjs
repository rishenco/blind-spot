/**
 * M7 keyframes — the radio, and the round it turns the prototype into.
 *
 *   node tools/radio.mjs [dist/index.html] [out/radio]
 *
 * Four frames, one scenario, per `doc/proto/process.md`'s budget. The mechanic itself is a
 * distance-only number (`Radio.clarity`, see `src/radio/radio.ts`) — that is a fact for a text
 * check, not a picture, so most of what this file proves is printed, not photographed:
 *
 *   1. the ground unit pings *unconditionally*, far enough to read from across the hall, before
 *      anyone has touched it — the whole tutorial in one mark (`01-ground-ping-from-afar.png`);
 *   2/3. the indicator's off/settling/ready states are a real before/after pair on the rifle's own
 *      handguard, not a claim (`02-indicator-off.png`, `03-indicator-ready.png`);
 *   4. reaching the gate while carrying it ends the round (`04-round-won.png`).
 *
 * Death reuses `Concussion.setLevel`, already proven photogenic by whichever feature shipped it —
 * this file only asserts the number (maxed, not decaying), it does not shoot a fifth frame of a
 * screen that is, by design, one flat colour.
 *
 * Own file, own `out/radio`, same conventions as `tools/hands.mjs`: fixed seed, fixed 120 Hz step,
 * no wall clock, nothing that reads `Math.random()`.
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
const outDir = resolve(process.argv[3] ?? 'out/radio');

if (!existsSync(htmlPath)) {
  console.error(`[radio] build not found: ${htmlPath} (run \`npm run build\` first)`);
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
  console.log(`[radio] ${line}`);
  if (!ok) failures.push(line);
}

const shots = [];
async function shot(name, note, clip) {
  const buf = await page.screenshot({ path: join(outDir, name), timeout: 180000, ...(clip ? { clip } : {}) });
  const img = decodePng(buf);
  shots.push({ name, note, lit: litFraction(img), mean: meanLuminance(img) });
  console.log(`[radio] shot ${name}  lit=${litFraction(img).toFixed(4)} mean=${meanLuminance(img).toFixed(2)}`);
  return img;
}

/** A frame we look at but do not keep — see `tools/hands.mjs`'s note on the same helper. */
async function grab(clip) {
  const buf = await page.screenshot({ timeout: 180000, ...(clip ? { clip } : {}) });
  return decodePng(buf);
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

async function playerCam() {
  await call('spiders.overlay', false);
  await call('hud', false);
  await call('lights', false);
  await call('view', 'player');
  await call('touch', true);
  await call('rifleMesh', true);
  await call('markers', true);
}

async function truthCam(x, z, height = 20) {
  await call('lights', true);
  await call('view', 'top');
  await call('topFocus', x, z);
  await call('topHeight', height);
  await call('hud', false);
}

const yawTo = (x, z, tx, tz) => (Math.atan2(-(tx - x), -(tz - z)) * 180) / Math.PI;

// The radio's contour sits on the handguard near the front sight — a real but small accessory
// in a 1280x720 frame. A full-frame shot technically contains it but no one glancing at the
// picture would find it, which fails the actual point of a proof frame (process.md: the
// orchestrator only ever looks at the picture). So the two indicator frames crop in on the
// handguard, the same way tools/hands.mjs crops its own instrument strip.
const HANDGUARD_CROP = { x: 640, y: 380, width: 560, height: 340 };

// ---------------------------------------------------------------------------
const url = `${pathToFileURL(htmlPath).href}?harness=1&seed=20260825`;
console.log(`[radio] ${url}`);
await page.goto(url);
await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 30000 });
await call('audio', false);
await call('hud', false);
await call('spiders.spawn', 0);
await advance(2, 8);

const gate = { x: 29, z: 0 };
const groundPos = { x: 0, z: 0 };
const spawn = await page.evaluate(() => window.bs.stats().pos);
const tune = await call('radio.tune', {});
notes.push(
  `seed 20260825, fixed 120 Hz step. Radio sliders: pickup ${tune.pickupRadius} m, capture ` +
    `${tune.captureSeconds} s (constant, not distance-scaled — the law this file cares most about), ` +
    `ping every ${tune.pingInterval} s, ${tune.groundLoudness} m on the floor vs. ${tune.carryLoudness} m ` +
    `carried and switched on, clarity from ${tune.clarityFar} m (noise) down to ${tune.clarityNear} m ` +
    'from the gate (melody).',
);

// ===========================================================================
// 1. The ground unit: pinging before anyone has touched it, readable from across the hall.
// ===========================================================================
await call('pose', spawn[0] ?? -30, spawn[2] ?? -20, 40);
await call('clear');
const preTouch = await call('radio.state');
check('untouched at start', preTouch.carried === false, `carried=${preTouch.carried}`);
await advance(3.0, 8); // several ping intervals — enough for a mark to exist and be settled
const groundState = await call('radio.state');
check(
  'still on the floor at this distance',
  groundState.carried === false,
  `distance to radio ${groundState.distanceToGate.toFixed(1)} m from the gate, player far outside pickup radius`,
);
await playerCam();
await redraw();
const soundBefore = (await stats()).sound.bySource;
check(
  'and it has already pinged the bus, unconditionally',
  (soundBefore.radio ?? 0) > 0,
  `${soundBefore.radio ?? 0} radio event(s) heard with nobody near it`,
);
await shot(
  '01-ground-ping-from-afar.png',
  `the radio, ${Math.hypot(spawn[0] - groundPos.x, spawn[2] - groundPos.z).toFixed(0)} m away in the middle of the hall, ` +
    'pinging on its own before the player has ever gone near it — the mark is a fact ("a sound happened there"), ' +
    'not a light: the hall around it stays black. This one mark is the entire tutorial for what a round is now about.',
);

// Compass law: spin on the spot, nothing about the reading may move.
const spin = await page.evaluate(() => {
  const bs = window.bs;
  const at = (x, z) => bs.radio.clarityAt(x, z);
  const readings = [];
  for (let yaw = 0; yaw < 360; yaw += 45) {
    bs.aim(yaw, 0);
    readings.push(at(bs.stats().pos[0], bs.stats().pos[2]));
  }
  return readings;
});
check(
  'turning the head changes nothing about the reading',
  spin.every((r) => Math.abs(r - spin[0]) < 1e-9),
  `clarity at 8 headings: ${spin.map((r) => r.toFixed(4)).join(' ')}`,
);
const clarityGate = await call('radio.clarityAt', gate.x, gate.z);
const clarityFar = await call('radio.clarityAt', spawn[0] ?? -30, spawn[2] ?? -20);
check('clarity is near 1 at the gate itself', clarityGate > 0.95, `clarity(gate) = ${clarityGate.toFixed(3)}`);
check(
  'and near 0 in the far corner it started in',
  clarityFar < 0.05,
  `clarity(spawn corner) = ${clarityFar.toFixed(3)}`,
);
notes.push(
  `no compass: clarity is a pure function of distance to the gate — 8 headings on the spot gave the identical number ` +
    `every time (${spin[0].toFixed(4)}), and it runs from ${clarityFar.toFixed(3)} in the spawn corner up to ` +
    `${clarityGate.toFixed(3)} at the gate.`,
);

// ===========================================================================
// 2/3. Pick it up, switch it on — the indicator's off/settling/ready states are real geometry.
// ===========================================================================
await call('pose', groundPos.x + 0.2, groundPos.z + 0.2, 90);
await advance(0.3, 4);
const picked = await call('radio.state');
check('walking over it picks it up automatically — no key', picked.carried === true, `carried=${picked.carried}`);
const stillFree = await page.evaluate(() => {
  const bs = window.bs;
  const props = bs.propList();
  const px = bs.stats().pos[0];
  const pz = bs.stats().pos[2];
  const near = props
    .map(([name, x, y, z], i) => ({ name, x, y, z, i, d: Math.hypot(x - px, z - pz) }))
    .filter((p) => ['can', 'bottle', 'jar', 'flask'].includes(p.name))
    .sort((a, b) => a.d - b.d)[0];
  return near ?? null;
});
if (stillFree !== null) {
  await call('pose', stillFree.x + 0.6, stillFree.z + 0.6, yawTo(stillFree.x + 0.6, stillFree.z + 0.6, stillFree.x, stillFree.z));
  await advance(0.3, 4);
  const took = await call('handToggle');
  check('E still works — the radio never occupies the left hand', took >= 0, `picked prop #${took} with E while carrying the radio`);
  await call('handDrop');
}

// Back to a clean, known spot for the indicator photographs.
await call('pose', groundPos.x + 1.5, groundPos.z, 180);
await call('radio.setCarried', true);
await call('clear');
await playerCam();
await redraw();
const offImg = await shot(
  '02-indicator-off.png',
  'carried but switched off: a felt contour on the handguard, dot dark. Nothing about a signal is visible yet — ' +
    'switching on costs the loudest sound in the hall, so the player has not paid for a reading. Cropped in on the ' +
    'handguard — the accessory is real geometry but small at full-frame scale.',
  HANDGUARD_CROP,
);
const offState = await call('radio.state');
check('the frame above is genuinely unpowered', offState.powered === false, `indicator=${offState.indicator}`);

const toggled = await call('radio.toggle');
check('T switches it on', toggled === true);
const justOn = await call('radio.state');
check('and it is not instant — settling first', justOn.indicator === 'settling', `indicator=${justOn.indicator}`);
await advance(tune.captureSeconds + 0.3, 4);
const settled = await call('radio.state');
check(
  `after the ${tune.captureSeconds} s capture delay it is trustworthy`,
  settled.indicator === 'ready',
  `indicator=${settled.indicator} at t+${(tune.captureSeconds + 0.3).toFixed(1)} s`,
);
await redraw();
const onImg = await shot(
  '03-indicator-ready.png',
  `the same handguard, ${tune.captureSeconds} s later: dot steady. Off/settling/ready are the indicator's only three ` +
    'states, drawn by multiplying the rifle\'s own already-computed brightness by 0 or 1 — the reading can never leak ' +
    "through the dot's brightness, rate or colour, only through the sound the player chose to make to get it. Same crop as above.",
  HANDGUARD_CROP,
);
check(
  'and the two frames are visibly different, not a claim',
  Math.abs(litFraction(onImg) - litFraction(offImg)) > 0.00005 || meanLuminance(onImg) !== meanLuminance(offImg),
  `lit ${litFraction(offImg).toFixed(5)} → ${litFraction(onImg).toFixed(5)}`,
);
const soundAfterOn = (await stats()).sound.bySource.radio ?? 0;
check(
  'switching on makes the player the loudest thing in the hall',
  soundAfterOn > (soundBefore.radio ?? 0),
  `${soundAfterOn} radio events on the bus now`,
);
notes.push(
  `capture delay is a flat ${tune.captureSeconds} s regardless of distance — encoding distance twice (once in the ` +
    'delay, once in clarity) would double the same fact. Ground ping: ' + `${tune.groundLoudness} m; carried & on: ` +
    `${tune.carryLoudness} m.`,
);

// ===========================================================================
// Waves: the pack reinforces on its own clock, capped, away from the player.
// ===========================================================================
const wave0 = await call('round.wave');
await page.evaluate(([at]) => window.bs.step(Math.max(0, at + 0.05)), [wave0.nextAt]);
const wave1 = await call('spiders.stats');
const waveState = await call('round.wave');
check(
  'a wave fires on its own clock and grows the pack',
  waveState.count > 0,
  `count now ${waveState.count} (cap ${waveState.cap}), pack reports ${wave1?.count ?? 0}`,
);
const spread = await page.evaluate(() => {
  const bs = window.bs;
  const p = bs.stats().pos;
  return bs.spiders
    .list()
    .map((s) => Math.hypot(s.x - p[0], s.z - p[2]))
    .reduce((min, d) => Math.min(min, d), Infinity);
});
check('and it does not spawn on top of the player', spread > 5, `nearest spider ${Number.isFinite(spread) ? spread.toFixed(1) : 'n/a'} m away`);
await call('round.tune', { cap: 6 });
await page.evaluate(() => {
  const bs = window.bs;
  for (let i = 0; i < 3; i++) window.bs.step(Math.max(0.1, bs.round.wave().intervalS + 0.05));
});
const waveCapped = await call('round.wave');
check('and it stops at the cap, not forever', waveCapped.count <= 6, `count ${waveCapped.count} against cap 6`);
notes.push(
  `waves: every ${wave0.intervalS} s the pack's target count ratchets up by ${wave0.step}, capped at ` +
    `${wave0.cap} simultaneous spiders, respawned away from wherever the player is standing — a disclosed ` +
    "simplification of “reinforcements”, see the report's deviations section.",
);

// ===========================================================================
// 4. The round ends: reach the gate carrying the radio.
// ===========================================================================
await call('round.tune', { cap: 24 });
await call('spiders.spawn', 0);
await call('round.force', 'playing');
// `pose()` re-homes the radio to the floor on every teleport, the same way it refills the
// magazine and drops the left hand — so it is always called *before* `radio.setCarried`, never
// after, or the very thing under test would be wiped out by the move itself.
await call('pose', gate.x - 1.5, gate.z, yawTo(gate.x - 1.5, gate.z, gate.x, gate.z));
await call('radio.setCarried', true); // (not powered — winning does not require it switched on)
const preWin = await call('round.state');
check('still playing one step short of the gate', preWin === 'playing', `state=${preWin}`);
await advance(0.5, 4);
const wonState = await call('round.state');
check('walking up to the gate while carrying it wins the round', wonState === 'won', `state=${wonState}`);

await call('round.force', 'playing');
await call('pose', gate.x - 1.5, gate.z, yawTo(gate.x - 1.5, gate.z, gate.x, gate.z)); // resets carried to false
await advance(0.5, 4);
const withoutRadio = await call('round.state');
check(
  'but the same spot without it does not end anything',
  withoutRadio === 'playing',
  `state=${withoutRadio} while standing on the gate empty-handed`,
);

// Re-set the win for the photograph.
await call('round.force', 'playing');
await call('pose', gate.x - 1.5, gate.z, yawTo(gate.x - 1.5, gate.z, gate.x, gate.z));
await call('radio.setCarried', true);
await advance(0.5, 4);
await playerCam();
// The restart prompt lives in the same DOM node the debug HUD toggle hides, so it has to be
// switched back on for this one frame — otherwise the proof photograph of "the round ended"
// would show nothing different from any other frame in the file, which defeats the point of it.
await call('hud', true);
await call('clear');
await redraw();
await shot(
  '04-round-won.png',
  'the round ends at the gate, radio in hand — the capture prompt at the bottom, which used to invite clicking to ' +
    'play, now reads the restart prompt instead. This is the only new ending the round has: without the radio the ' +
    'gate is simply a wall that does not care you found it.',
);
const promptText = await page.evaluate(() => document.querySelector('.bs-capture')?.textContent ?? '');
check(
  'the frame above actually carries the restart prompt, not a claim about it',
  promptText.includes('THROUGH THE GATE'),
  `prompt text: "${promptText}"`,
);
await call('hud', false);

// Restart plumbing: the two keys resolve to two different URLs, both carrying a seed.
const sameUrl = await call('round.restartUrl', true);
const newUrl = await call('round.restartUrl', false);
check('same-seed restart keeps the seed', sameUrl.includes(`seed=${await page.evaluate(() => window.bs.seed)}`));
check('new-seed restart asks for a different one', sameUrl !== newUrl, `${sameUrl} vs ${newUrl}`);
notes.push(
  'restart is a full page reload with an updated `?seed=`, not an in-place teardown — rebuilding Rapier, the props, ' +
    'the pack and the round state by hand in lock-step was judged riskier than the reload it replaces. Backspace keeps ' +
    "the seed; Enter asks for a new one (`Date.now() % 1e8` at the real keypress — a session choice, not simulation " +
    'state, the same class of exemption `process.md` already grants continuous audio playback).',
);

// ===========================================================================
// Death: reuses `Concussion`, maxed and non-decaying — no second effect, no fifth frame.
// ===========================================================================
await call('round.force', 'playing');
await call('vitals.reset');
await call('pose', 2, 2, 0);
await call('vitals.health', 0);
await advance(1.0, 8);
const dead = await call('round.state');
check('health reaching zero ends the round', dead === 'dead', `state=${dead}`);
const c1 = await call('concussion.state');
await advance(2.0, 8);
const c2 = await call('concussion.state');
check(
  'and the concussion channel is pinned, not decaying like a normal hit',
  Math.abs(c2.amount - c1.amount) < 1e-6 && c2.amount > 0.9,
  `amount ${c1.amount.toFixed(3)} → ${c2.amount.toFixed(3)} across 2 s`,
);
notes.push(
  'death re-pins `Concussion.setLevel(1.6, time)` every tick instead of a second effect — the screen is the same ' +
    "flat, maxed grain the concussion channel already draws for a bad hit, held open rather than left to decay. " +
    "That look was proven photogenic by whichever feature shipped `concussion.ts`; this file only asserts the " +
    'number stays pinned, so as not to shoot a duplicate of somebody else\'s frame.',
);

// ===========================================================================
// Performance.
// ===========================================================================
await call('round.force', 'playing');
await call('vitals.reset');
await call('radio.setCarried', false);
await call('pose', spawn[0] ?? -30, spawn[2] ?? -20, 40);
const perf = await page.evaluate(() => {
  const bs = window.bs;
  const sample = (n = 240) => {
    // A short, discarded warm-up first: the very first frame after a state change (visibility
    // flip, first draw of a shader that has not run in a while) is routinely a GC/JIT outlier
    // that has nothing to do with the feature's steady-state cost, so it is not allowed to swing
    // the number `check()` below is judged on. Median, not mean, for the same reason.
    for (let i = 0; i < 8; i++) {
      bs.step(1 / 120);
      bs.draw();
    }
    const runs = [];
    for (let i = 0; i < n; i++) {
      bs.step(1 / 120);
      bs.draw();
      runs.push(bs.stats().frameMs.frameMs);
    }
    const sorted = runs.slice().sort((a, b) => a - b);
    return {
      mean: runs.reduce((a, b) => a + b, 0) / runs.length,
      median: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
    };
  };
  const idle = sample();
  bs.radio.setCarried(true);
  bs.radio.toggle();
  const carrying = sample();
  return { idle, carrying };
});
console.log(
  `[radio] frame cost: ground unit only ${perf.idle.median.toFixed(2)} ms median (mean ${perf.idle.mean.toFixed(2)}, ` +
    `p95 ${perf.idle.p95.toFixed(2)}) · carried & on ${perf.carrying.median.toFixed(2)} ms median (mean ` +
    `${perf.carrying.mean.toFixed(2)}, p95 ${perf.carrying.p95.toFixed(2)})`,
);
check(
  'the radio is not a frame-cost feature',
  perf.carrying.median < perf.idle.median + 0.5,
  `${perf.idle.median.toFixed(2)} → ${perf.carrying.median.toFixed(2)} ms per frame (median)`,
);
notes.push(
  `cost: ${perf.idle.median.toFixed(2)} ms/frame median with the radio still on the floor against ` +
    `${perf.carrying.median.toFixed(2)} ms carried and switched on (p95 ${perf.idle.p95.toFixed(2)} → ` +
    `${perf.carrying.p95.toFixed(2)}). One extra bus emission every ${tune.pingInterval} s and a handful of extra ` +
    'triangles on the handguard; the synth itself runs on its own `AudioContext`, off the render thread.',
);

// --- contact sheet ---------------------------------------------------------
const html = `<!doctype html><meta charset="utf-8"><title>BLIND SPOT M7 — the radio and the round</title>
<style>body{background:#0a0d10;color:#cfdbe4;font:13px/1.5 ui-monospace,monospace;margin:24px}
h1{font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#ffd166}
figure{margin:0 0 28px}img{width:100%;max-width:1280px;border:1px solid #223}
figcaption{padding:6px 2px;color:#8fa2b0}</style>
<h1>BLIND SPOT — keyframes: the radio, and the round it makes out of the prototype</h1>
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
  console.log(`[radio] console errors:\n  ${consoleErrors.slice(0, 8).join('\n  ')}`);
  failures.push(`${consoleErrors.length} console error(s)`);
}
console.log(`[radio] ${shots.length} frames -> ${outDir}`);
if (failures.length > 0) {
  console.error(`[radio] ${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('[radio] all checks passed');
