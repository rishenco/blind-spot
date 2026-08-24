#!/usr/bin/env node
/**
 * Screenshot driver for the lab build.
 *
 *   node tools/shoot.mjs [dist/index.html] [outdir]
 *
 * Opens the single-file build over file:// in headless chromium and drives it with real
 * input events only — no teleporting, no state injection. The page exposes a read-only
 * `window.__blindspot.getState()` handle which is used to assert that each step actually
 * did something (the camera moved, the player is airborne, collision stopped him, ...).
 *
 * Exits non-zero on any page error, console error, or failed assertion.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_HTML = 'dist/index.html';
const DEFAULT_OUT =
  '/tmp/claude-0/-home-user-blind-spot/ba9a7722-be6a-5281-adc4-66e57e68b60b/scratchpad/shots';

const htmlPath = resolve(process.argv[2] ?? DEFAULT_HTML);
const outDir = resolve(process.argv[3] ?? DEFAULT_OUT);

if (!existsSync(htmlPath)) {
  console.error(`[shoot] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

const failures = [];
const consoleErrors = [];
const consoleWarnings = [];

// SwiftShader gives a real (software) WebGL2 context in headless.
const launchOptions = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
// Preinstalled browser bundle: resolve it explicitly, since the local playwright package's
// expected revision may not match what is on the image.
const PREINSTALLED = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(PREINSTALLED)) launchOptions.executablePath = PREINSTALLED;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

page.on('console', (msg) => {
  const text = `${msg.type()}: ${msg.text()}`;
  if (msg.type() === 'error') consoleErrors.push(text);
  else if (msg.type() === 'warning') consoleWarnings.push(text);
});
page.on('pageerror', (err) => {
  consoleErrors.push(`pageerror: ${err.message}`);
});
// The build ships as a claude.ai Artifact behind a strict CSP: nothing may leave the page.
const externalRequests = [];
page.on('request', (req) => {
  const u = req.url();
  if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')) {
    externalRequests.push(`${req.method()} ${u}`);
  }
});

const shot = async (name) => {
  await page.screenshot({ path: join(outDir, name) });
  console.log(`[shoot] wrote ${name}`);
};
const wait = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__blindspot.getState());

const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/** Holds a set of keys for `ms`, then releases them. */
async function hold(keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await wait(ms);
  for (const k of keys) await page.keyboard.up(k);
}

/**
 * Turns the view by dragging — the pointer-lock-free look path.
 *
 * A 90 deg turn is ~750 px at the default sensitivity, which does not fit in a 1280 px
 * viewport starting from the centre, so the gesture is split into chunks that each stay
 * on screen. Every chunk is its own press/drag/release, and the look handler measures
 * per-gesture deltas, so the rotations simply add up.
 */
async function dragLook(degrees, sensitivity) {
  const total = degrees / sensitivity;
  const dir = Math.sign(total) || 1;
  const cy = 360;
  const maxChunk = 600;
  let remaining = Math.abs(total);
  while (remaining > 0.5) {
    const chunk = Math.min(remaining, maxChunk);
    const startX = 640 - (dir * chunk) / 2;
    await page.mouse.move(startX, cy);
    await page.mouse.down();
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(startX + (dir * chunk * i) / steps, cy);
      await wait(6);
    }
    await page.mouse.up();
    await wait(40);
    remaining -= chunk;
  }
}

/**
 * Polls the live state until `pred` holds (or the budget runs out). Headless software
 * rendering only manages 5-20 fps, so anything shorter than ~200 ms of sim — a jump arc, a
 * respawn — has to be caught by polling rather than by sleeping a fixed amount.
 */
async function poll(pred, budgetMs = 4000) {
  const deadline = Date.now() + budgetMs;
  let last = await state();
  while (!pred(last) && Date.now() < deadline) last = await state();
  return last;
}

/**
 * Samples the read-only state once per rendered frame, from inside the page.
 *
 * View effects (head bob, the landing dip) live on the render camera, and a driver-side
 * poll adds a CDP round-trip per sample. Sampling in a rAF loop instead pins the sample
 * rate to the actual frame rate, which is the best any observer can do.
 */
function sampleFrames(ms) {
  return page.evaluate(
    (duration) =>
      new Promise((done) => {
        const out = [];
        const t0 = performance.now();
        const tick = () => {
          const s = window.__blindspot.getState();
          const t = performance.now() - t0;
          out.push({
            t,
            camY: s.camY,
            camRoll: s.camRoll,
            steps: s.steps,
            y: s.y,
            dip: s.landDip,
            grounded: s.grounded,
            speed: s.speed,
            anim: s.anim,
            animTime: s.animTime,
            boom: s.boom,
          });
          if (t < duration) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

const spread = (values) => Math.max(...values) - Math.min(...values);
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/**
 * Arms a non-blocking in-page observer that records extremes once per rendered frame.
 *
 * The blocking `sampleFrames` cannot be used while the driver is also dragging the mouse —
 * both are page operations and would serialise — so anything that has to be measured *during*
 * an input gesture (the camera squeezing against a wall as the boom orbits, the roll of a
 * strafing turn) goes through this instead. It only ever reads `getState()`.
 */
async function startProbe() {
  await page.evaluate(() => {
    const p = {
      on: true,
      samples: 0,
      minBoom: Infinity,
      maxBoom: 0,
      maxAbsRoll: 0,
      lastRoll: 0,
      camMinX: Infinity,
      camMaxX: -Infinity,
      camMinZ: Infinity,
      camMaxZ: -Infinity,
    };
    window.__probe = p;
    const tick = () => {
      const s = window.__blindspot.getState();
      p.samples++;
      p.minBoom = Math.min(p.minBoom, s.boom);
      p.maxBoom = Math.max(p.maxBoom, s.boom);
      if (Math.abs(s.camRoll) > Math.abs(p.maxAbsRoll)) p.maxAbsRoll = s.camRoll;
      p.lastRoll = s.camRoll;
      p.camMinX = Math.min(p.camMinX, s.camX);
      p.camMaxX = Math.max(p.camMaxX, s.camX);
      p.camMinZ = Math.min(p.camMinZ, s.camZ);
      p.camMaxZ = Math.max(p.camMaxZ, s.camZ);
      if (p.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readProbe() {
  return page.evaluate(() => {
    window.__probe.on = false;
    return window.__probe;
  });
}

/** Switches scene variant by its number key and waits for the rebuild to land. */
async function setVariant(key, expected) {
  await page.keyboard.press(key);
  await poll((s) => s.variant === expected, 4000);
  await wait(200);
  const s = await state();
  check(`variant "${expected}" active`, s.variant === expected, `variant=${s.variant}`);
}

/**
 * Presses R and waits for the reset to actually land. Headless software rendering runs at
 * 5-20 fps, so a fixed sleep is not enough: poll the respawn counter instead.
 */
async function respawn() {
  const before = Number((await state()).respawnCount);
  await page.keyboard.press('r');
  await page.waitForFunction(
    (n) => Number(window.__blindspot.getState().respawnCount) > n,
    before,
    { timeout: 5000, polling: 30 },
  );
  // Let one more frame settle so velocity readings are the post-respawn ones.
  await wait(80);
}

// `?look=drag` pins the build to the drag-look fallback: pointer lock is unreliable in
// headless chromium, and this is the path we want the screenshots to prove works.
const url = `${pathToFileURL(htmlPath).href}?look=drag`;
console.log(`[shoot] ${url}`);
await page.goto(url);
await page.waitForFunction(() => window.__blindspot !== undefined, null, { timeout: 15000 });
await wait(700);

// --- 01 load ---------------------------------------------------------------
const loaded = await state();
console.log('[shoot] initial state', JSON.stringify(loaded));
check('scene booted', loaded.scene === 'movement-playground', `scene=${loaded.scene}`);
check('renderer running', loaded.fps > 0, `fps=${Number(loaded.fps).toFixed(1)}`);
check('player on the ground', loaded.grounded === true, `y=${Number(loaded.y).toFixed(2)}`);
check('drag-look fallback active', loaded.lookMode === 'drag', `lookMode=${loaded.lookMode}`);
await shot('01-load.png');

// --- 02 drag look ----------------------------------------------------------
const sens = Number(loaded.sensitivity);
const yawBefore = Number(loaded.yawDeg);
await dragLook(40, sens);
await wait(250);
const afterLook = await state();
const yawDelta = Number(afterLook.yawDeg) - yawBefore;
check(
  'drag-look rotated the view ~40 deg',
  Math.abs(Math.abs(yawDelta) - 40) < 6,
  `look=${afterLook.lookMode} yaw ${yawBefore.toFixed(1)} -> ${Number(afterLook.yawDeg).toFixed(1)}`,
);
await shot('02-look.png');

// --- 03 walk ---------------------------------------------------------------
// Both speed tests run down the -Z lane: 15 m of clear floor at the spawn's x, so neither
// run is cut short by the stair flight that sits straight ahead of the spawn.
const LANE_TURN = -90;
await respawn();
await dragLook(LANE_TURN, sens);
await wait(150);
const walkStart = await state();
await hold(['w'], 1500);
const walked = await state();
const walkDist = Math.hypot(walked.x - walkStart.x, walked.z - walkStart.z);
check('walk translated the camera', walkDist > 3, `${walkDist.toFixed(2)} m in 1.5 s`);
await page.keyboard.down('w');
await wait(150);
await shot('03-walk.png');
const walkSpeed = Number((await state()).speed);
check('walk speed ~3.5 m/s', Math.abs(walkSpeed - 3.5) < 0.4, `${walkSpeed.toFixed(2)} m/s`);
await page.keyboard.up('w');

// --- 04 sprint -------------------------------------------------------------
await respawn();
await dragLook(LANE_TURN, sens);
await wait(150);
const sprintStart = await state();
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await wait(600);
// Shot mid-run, while there is still room ahead — the end-of-run pose is a wall close-up.
await shot('04-sprint.png');
await wait(900);
const sprinted = await state();
const sprintDist = Math.hypot(sprinted.x - sprintStart.x, sprinted.z - sprintStart.z);
check('sprint speed ~6.0 m/s', Math.abs(Number(sprinted.speed) - 6) < 0.5, `${Number(sprinted.speed).toFixed(2)} m/s`);
check('sprint outran the walk', sprintDist > walkDist + 1, `${sprintDist.toFixed(2)} m vs ${walkDist.toFixed(2)} m walking`);
await page.keyboard.up('w');
await page.keyboard.up('Shift');
await wait(300);

// --- 05 jump mid-sprint ----------------------------------------------------
// Down the spawn heading: 8 m of clear floor before the stairs, which is enough for the
// run-up plus the whole 0.575 s arc, and the platform stays in frame.
await respawn();
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await poll((s) => Number(s.x) > -17, 3000);
// Held, not tapped: a tap is cut short on release (see the jump-cut scenario) and only
// clears ~0.23 m, which is not the jump this shot is meant to show.
await page.keyboard.down('Space');
// The arc is only a handful of headless frames, so poll for the airborne sample instead of
// sleeping and hoping — and shoot immediately, while the player is still up there.
const jumped = await poll((s) => s.grounded === false && Number(s.y) > 0.4, 2000);
check('airborne after jump', jumped.grounded === false && Number(jumped.y) > 0.4, `y=${Number(jumped.y).toFixed(2)}`);
await shot('05-jump.png');
await page.keyboard.up('Space');
await page.keyboard.up('w');
await page.keyboard.up('Shift');
await wait(600);

// --- 06 crouch -------------------------------------------------------------
await respawn();
await page.keyboard.down('c');
await page.keyboard.down('w');
await wait(900);
const crouched = await state();
check('stance is crouched', crouched.stance === 'crouch', `stance=${crouched.stance}`);
check('crouch speed ~1.7 m/s', Math.abs(Number(crouched.speed) - 1.7) < 0.3, `${Number(crouched.speed).toFixed(2)} m/s`);
await shot('06-crouch.png');
await page.keyboard.up('w');
await page.keyboard.up('c');
await wait(400);

// --- 07 collision against a crate -----------------------------------------
// Face +Z (a 2.2 m crate sits 6 m off the spawn on that heading) and walk into it.
await respawn();
await dragLook(90, sens);
await wait(150);
await page.keyboard.down('w');
// Poll for "arrived and stalled" rather than sleeping: the assertion is that the crate stops a
// body still holding W, not that it does so within some wall-clock window.
const blocked = await poll((s) => Number(s.z) > 3 && Number(s.speed) < 0.6, 8000);
check(
  'stopped by the crate',
  Number(blocked.z) < 5.0 && Number(blocked.speed) < 0.6,
  `z=${Number(blocked.z).toFixed(2)} speed=${Number(blocked.speed).toFixed(2)} (still holding W)`,
);
await shot('07-collide.png');
await page.keyboard.up('w');
await wait(300);

// --- 08 stairs onto the platform ------------------------------------------
await respawn();
await page.keyboard.down('w');
// Polled, not slept: the sim clamps its per-frame catch-up, so on a slow frame sim time falls
// behind wall time and a fixed sleep lands the walk one riser short of the deck.
const onPlatform = await poll((s) => Number(s.y) > 2.9 && s.grounded === true, 12000);
check(
  'reached the 3 m platform via the stairs',
  Number(onPlatform.y) > 2.9 && onPlatform.grounded === true,
  `pos=${Number(onPlatform.x).toFixed(1)} ${Number(onPlatform.y).toFixed(2)} ${Number(onPlatform.z).toFixed(1)}`,
);
await shot('08-platform.png');
await page.keyboard.up('w');
await wait(200);

// --- 09-11 stairs taken at an angle ----------------------------------------
/**
 * Sprints the stair flight from its foot at `deg` off the perpendicular.
 *
 * The approach is deliberately two-phase — walk to the foot, stop, *then* turn and sprint —
 * so every angle starts from the same place and the timing measures the climb rather than
 * the run-up. The flight is 16 m wide precisely so a 60 deg line stays on the treads.
 */
async function stairRun(label, deg, strafeToZ, shotName) {
  await respawn();
  await page.keyboard.down('w');
  await poll((s) => Number(s.x) > -12.4, 8000);
  await page.keyboard.up('w');
  await wait(350);
  if (strafeToZ !== null) {
    // Strafe left (-Z) along the bottom riser to the start of the diagonal line.
    await page.keyboard.down('a');
    await poll((s) => Number(s.z) < strafeToZ, 8000);
    await page.keyboard.up('a');
    await wait(350);
  }
  if (deg !== 0) {
    await dragLook(deg, sens);
    await wait(150);
  }
  const base = await state();

  const t0 = Date.now();
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  let onTreads = 0;
  let speedSum = 0;
  let top = base;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    top = await state();
    const y = Number(top.y);
    if (y > 0.2 && y < 2.9) {
      onTreads += 1;
      speedSum += Number(top.speed);
    }
    if (y > 2.9) break;
  }
  const elapsed = (Date.now() - t0) / 1000;
  await shot(shotName);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await wait(300);

  const avgSpeed = onTreads > 0 ? speedSum / onTreads : 0;
  // The wall-clock bound is only a coarse "it never pinned" guard — software GL runs anywhere
  // from 5 to 20 fps, and the sim clamps its catch-up, so wall time is not sim time. The real
  // quality gate is the sampled average speed below: that one is a sim quantity.
  check(
    `${label}: climbed to the 3 m level`,
    Number(top.y) > 2.9 && elapsed < 9,
    `y=${Number(top.y).toFixed(2)} in ${elapsed.toFixed(2)} s, from z=${Number(base.z).toFixed(1)} to z=${Number(top.z).toFixed(1)}`,
  );
  check(
    `${label}: stairs did not eat the sprint`,
    avgSpeed > 3,
    `${avgSpeed.toFixed(2)} m/s average over ${onTreads} tread samples`,
  );
}

await stairRun('stairs head-on', 0, null, '09-stairs-0.png');
await stairRun('stairs at 30 deg', 30, null, '10-stairs-30.png');
await stairRun('stairs at 60 deg', 60, -6, '11-stairs-60.png');

// --- 12 vault: a 1 m ledge at a sprint --------------------------------------
await setVariant('4', 'Mantle Lane');
await respawn();
await page.keyboard.down('Shift');
await page.keyboard.down('w');
// The 1.0 m ledge's face is at x = -13.25 and the probe reaches 0.65 m past the body, so
// anywhere from about -14.2 inwards is a legal climb from the ground.
await poll((s) => Number(s.x) > -14.15, 6000);
await page.keyboard.down('Space');
const vaulting = await poll((s) => s.mantling === true, 2500);
check('vault started at the 1 m ledge', vaulting.mantling === true, `x=${Number(vaulting.x).toFixed(2)}`);
await shot('12-vault.png');
// `grounded` is part of the predicate on purpose: at 6-12 fps a sample can otherwise land in
// the airborne instant right after the vault exits, or past the far edge of the deck.
const vaulted = await poll(
  (s) => s.mantling === false && s.grounded === true && Number(s.y) > 0.9,
  3000,
);
await page.keyboard.up('Space');
check(
  'vault finished standing on the ledge',
  Math.abs(Number(vaulted.y) - 1) < 0.05 && vaulted.grounded === true,
  `y=${Number(vaulted.y).toFixed(2)} grounded=${vaulted.grounded}`,
);
check('vault kept the momentum', Number(vaulted.speed) > 3, `${Number(vaulted.speed).toFixed(2)} m/s on exit`);
await page.keyboard.up('w');
await page.keyboard.up('Shift');
await wait(400);

// --- 13 pull-up: the tallest legal ledge ------------------------------------
await respawn();
await dragLook(-90, sens); // face -Z, down the pull-up lane
await wait(200);
await page.keyboard.down('w');
const atBlock = await poll((s) => Number(s.speed) < 0.5 && Number(s.z) < -3, 8000);
check('walked into the 2.2 m block', Number(atBlock.z) < -3.5, `z=${Number(atBlock.z).toFixed(2)}`);
await page.keyboard.down('Space');
const pulling = await poll((s) => s.mantling === true, 2500);
check('pull-up started', pulling.mantling === true, `y=${Number(pulling.y).toFixed(2)}`);
await shot('13-pullup.png');
const pulled = await poll(
  (s) => s.mantling === false && s.grounded === true && Number(s.y) > 2,
  3000,
);
check(
  'pull-up finished on top of the 2.2 m block',
  Math.abs(Number(pulled.y) - 2.2) < 0.05 && pulled.grounded === true,
  `y=${Number(pulled.y).toFixed(2)} grounded=${pulled.grounded}`,
);
await page.keyboard.up('Space');
await page.keyboard.up('w');
await wait(400);

// --- 14 jump cut: tap versus hold -------------------------------------------
await setVariant('2', 'Bare Room');

/** Jumps once from a standstill and returns the highest sampled feet height. */
async function jumpApex(held) {
  await respawn();
  await wait(150);
  if (held) await page.keyboard.down('Space');
  else await page.keyboard.press('Space');
  let apex = 0;
  let sawAir = false;
  const deadline = Date.now() + 1600;
  while (Date.now() < deadline) {
    const s = await state();
    apex = Math.max(apex, Number(s.y));
    if (s.grounded === false) sawAir = true;
    else if (sawAir) break;
  }
  if (held) await page.keyboard.up('Space');
  await wait(250);
  return apex;
}

const taps = [];
for (let i = 0; i < 3; i++) taps.push(await jumpApex(false));
const holds = [];
for (let i = 0; i < 2; i++) holds.push(await jumpApex(true));
const tapApex = Math.min(...taps);
const holdApex = Math.max(...holds);
check(
  'held jump clears ~0.9 m',
  holdApex > 0.75 && holdApex < 1.1,
  `apex ${holdApex.toFixed(2)} m (samples ${holds.map((v) => v.toFixed(2)).join(', ')})`,
);
check(
  'released jump is cut short',
  tapApex < 0.6 * holdApex,
  `tap ${tapApex.toFixed(2)} m vs hold ${holdApex.toFixed(2)} m (taps ${taps.map((v) => v.toFixed(2)).join(', ')})`,
);

// --- 15 head bob -------------------------------------------------------------
await respawn();
await wait(400);
const standing = await sampleFrames(700);
check(
  'camera is still when standing still',
  spread(standing.map((s) => s.camY)) < 0.005,
  `${(spread(standing.map((s) => s.camY)) * 1000).toFixed(2)} mm over ${standing.length} frames`,
);

await page.keyboard.down('Shift');
await page.keyboard.down('w');
await wait(400); // let the stride envelope reach full gain before measuring
const running = await sampleFrames(2000);
await shot('14-bob.png');
await page.keyboard.up('w');
await page.keyboard.up('Shift');
await wait(300);

const bobSpread = spread(running.map((s) => s.camY));
const rollSpread = spread(running.map((s) => s.camRoll));
const stepDelta = running[running.length - 1].steps - running[0].steps;
const runSeconds = (running[running.length - 1].t - running[0].t) / 1000;
check(
  'sprint bobs the camera',
  bobSpread > 0.02 && bobSpread < 0.09,
  `${(bobSpread * 1000).toFixed(1)} mm peak-to-peak over ${running.length} frames (2 x vertAmp = 70 mm)`,
);
check('sprint rolls the camera', rollSpread > 0.05, `${rollSpread.toFixed(3)} deg peak-to-peak`);
check(
  'footfalls land ~2 per stride cycle',
  stepDelta / runSeconds > 2.4 && stepDelta / runSeconds < 5.2,
  `${stepDelta} steps in ${runSeconds.toFixed(2)} s = ${(stepDelta / runSeconds).toFixed(2)}/s (2 x strideFreq = 3.8/s)`,
);

// --- 16 landing dip ----------------------------------------------------------
await setVariant('1', 'Full Playground');
await respawn();
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await poll((s) => Number(s.y) > 2.9, 10000);
// Straight on across the deck and off the far lip: a 3 m drop, ~9.8 m/s at impact.
await poll((s) => s.grounded === false && Number(s.y) < 2.95, 6000);
const falling = await sampleFrames(1600);
await shot('15-land.png');
await page.keyboard.up('w');
await page.keyboard.up('Shift');
await wait(300);

const dipPeak = Math.max(...falling.map((s) => s.dip));
const dipTail = falling[falling.length - 1].dip;
const landed = falling.some((s) => s.grounded === true);
check('the 3 m drop landed', landed, `${falling.length} frames sampled`);
check('landing dipped the camera', dipPeak > 0.03, `${(dipPeak * 1000).toFixed(1)} mm dip (max is 120 mm)`);
check('the dip recovers', dipTail < 0.02, `${(dipTail * 1000).toFixed(2)} mm left after ${(falling[falling.length - 1].t / 1000).toFixed(2)} s`);

// --- 17 third person: the V toggle -------------------------------------------
// Everything from here on is batch 1.2: a visible body and the third-person boom.
await respawn();
// Off the spawn wall first, so the boom has room and the assertion measures the rest length
// rather than a legitimate squeeze.
await page.keyboard.down('w');
await poll((s) => Number(s.x) > -17, 6000);
await page.keyboard.up('w');
await wait(400);

const beforeToggle = await state();
check(
  'player model loaded',
  beforeToggle.avatarReady === true,
  beforeToggle.avatarReady === true ? 'Xbot.glb parsed' : `error=${beforeToggle.avatarError}`,
);
check(
  'first person is the default',
  beforeToggle.view === 'first' && Number(beforeToggle.viewBlend) === 0,
  `view=${beforeToggle.view} blend=${beforeToggle.viewBlend}`,
);

await page.keyboard.press('v');
await poll((s) => Number(s.viewBlend) >= 0.999, 4000);
await wait(350);
const tpOn = await state();
check(
  'V switches to third person',
  tpOn.view === 'third' && Number(tpOn.viewBlend) >= 0.999,
  `view=${tpOn.view} blend=${Number(tpOn.viewBlend).toFixed(3)}`,
);

// Where the camera sits relative to the body it is following.
const backVec = {
  x: Number(tpOn.camX) - Number(tpOn.bodyX),
  z: Number(tpOn.camZ) - Number(tpOn.bodyZ),
};
const backDist = Math.hypot(backVec.x, backVec.z);
const yawRad = (Number(tpOn.yawDeg) * Math.PI) / 180;
// Positive = the camera is behind the look direction (forward at yaw f is (-sin f, 0, -cos f)).
const behind = -(backVec.x * -Math.sin(yawRad) + backVec.z * -Math.cos(yawRad));
check(
  'camera sits a boom length behind the character',
  Math.abs(backDist - 3.22) < 0.5 && behind > 2.8,
  `${backDist.toFixed(2)} m away, ${behind.toFixed(2)} m behind, boom=${Number(tpOn.boom).toFixed(2)}`,
);
check(
  'camera rides above the neck pivot',
  Math.abs(Number(tpOn.camY) - Number(tpOn.bodyY) - 1.85) < 0.2,
  `camY-bodyY=${(Number(tpOn.camY) - Number(tpOn.bodyY)).toFixed(2)} m (pivot 1.5 + height 0.35)`,
);
check('character is drawn in third person', tpOn.avatarVisible === true, `visible=${tpOn.avatarVisible}`);
await shot('16-tp-toggle.png');

// --- 18 third person: the run cycle ------------------------------------------
// Down the -Z lane, the same clear 15 m the walk/sprint scenarios use.
await respawn();
await dragLook(LANE_TURN, sens);
await wait(150);
await page.keyboard.down('Shift');
await page.keyboard.down('w');
// Polled, not slept: the sampling window has to sit entirely inside the clear part of the
// lane, and at 4-15 headless fps a fixed sleep can run the whole 14 m into the far wall —
// where the body stops, drops out of the run cycle, and the assertion below has every right
// to fail.
const upToSpeed = await poll((s) => Number(s.z) < -4, 6000);
check(
  'the run cycle is playing at sprint speed',
  upToSpeed.anim === 'run' && Number(upToSpeed.speed) > 5.5,
  `anim=${upToSpeed.anim} at ${Number(upToSpeed.speed).toFixed(2)} m/s, weights ${JSON.stringify(upToSpeed.animWeights)}`,
);
await shot('17-tp-run.png');
const tpRun = await sampleFrames(700);
await page.keyboard.up('w');
await page.keyboard.up('Shift');
await wait(400);

// The gate is "whenever the body is sprinting it is in the run cycle", not "every sampled
// frame is". Headless frame rates are erratic enough that a sampling window can straddle the
// end of the lane, and a body that has stopped moving has every right to leave the run cycle.
const sprintFrames = tpRun.filter((s) => Number(s.speed) > 4);
const strays = sprintFrames.filter((s) => s.anim !== 'run');
const clipTimes = tpRun.map((s) => s.animTime);
const clipSpread = spread(clipTimes);
check(
  'sprinting frames stay in the run clip',
  tpRun.length > 2 && sprintFrames.length > 0 && strays.length === 0,
  `${sprintFrames.length}/${tpRun.length} frames above 4 m/s, ${strays.length} of them off "run" [${tpRun
    .map((s) => `${s.anim}@${Number(s.speed).toFixed(1)}`)
    .join(' ')}]`,
);
check(
  'the animation clock advances',
  new Set(clipTimes).size >= 3 && clipSpread > 0.05,
  `${new Set(clipTimes).size} distinct clip times spanning ${clipSpread.toFixed(3)} s over ${tpRun.length} frames (clip is 0.70 s)`,
);
check(
  'no stride bob on the boom',
  spread(tpRun.map((s) => s.camY)) < 0.02,
  `${(spread(tpRun.map((s) => s.camY)) * 1000).toFixed(1)} mm of camera rise (first person bobs 55 mm)`,
);

// --- 19 third person: the boom against a wall ---------------------------------
await respawn();
// Straight back into the -X wall: the room's inner face is at x = -22.5 and the body radius
// is 0.35, so the boom has nowhere to go and has to pull in to the character.
await page.keyboard.down('s');
const atWall = await poll((s) => Number(s.x) < -21.9 && Number(s.speed) < 0.5, 10000);
await page.keyboard.up('s');
await wait(400);
const squeezed = await state();
check(
  'backed into the wall',
  Number(atWall.x) < -21.9,
  `x=${Number(squeezed.x).toFixed(2)} (wall face at -22.5)`,
);
check(
  'the boom pulls in hard against the wall',
  Number(squeezed.boom) < 0.6,
  `boom=${Number(squeezed.boom).toFixed(2)} m of a ${Number(squeezed.boomRest).toFixed(2)} m rest length`,
);
check(
  'the squeezed camera stays inside the room',
  Number(squeezed.camX) > -22.5,
  `camX=${Number(squeezed.camX).toFixed(2)}`,
);

// Orbit through ~140 deg with the wall behind: the boom has to track it the whole way.
await startProbe();
await dragLook(-70, sens);
await dragLook(140, sens);
await dragLook(-70, sens);
const orbit = await readProbe();
check(
  'the boom shrinks below its default while orbiting a wall',
  orbit.minBoom < 3.0 && orbit.samples > 4,
  `min ${orbit.minBoom.toFixed(2)} m / max ${orbit.maxBoom.toFixed(2)} m over ${orbit.samples} frames (default 3.2)`,
);
check(
  'the camera never leaves the room while orbiting',
  orbit.camMinX > -22.5 && orbit.camMaxX < 22.5 && orbit.camMinZ > -15 && orbit.camMaxZ < 15,
  `x ${orbit.camMinX.toFixed(2)}..${orbit.camMaxX.toFixed(2)}, z ${orbit.camMinZ.toFixed(2)}..${orbit.camMaxZ.toFixed(2)} (room is 45 x 30)`,
);

// Step off the wall until the boom is mid-squeeze — the readable version of the same shot.
await page.keyboard.down('w');
await poll((s) => Number(s.boom) > 0.9, 5000);
await page.keyboard.up('w');
await wait(250);
const midSqueeze = await state();
await shot('18-tp-wall.png');
check(
  'the boom recovers smoothly as the wall is left behind',
  Number(midSqueeze.boom) > 0.6 && Number(midSqueeze.boom) < 2.6,
  `boom=${Number(midSqueeze.boom).toFixed(2)} m at x=${Number(midSqueeze.x).toFixed(2)}`,
);

// --- 20 third person: vaulting -----------------------------------------------
await setVariant('4', 'Mantle Lane');
await respawn();
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await poll((s) => Number(s.x) > -14.15, 6000);
await page.keyboard.down('Space');
const tpVaulting = await poll((s) => s.mantling === true, 2500);
check(
  'third-person vault started',
  tpVaulting.mantling === true && tpVaulting.view === 'third',
  `x=${Number(tpVaulting.x).toFixed(2)} anim=${tpVaulting.anim}`,
);
// A vault is 0.25 s, which at headless frame rates is one or two frames: wait for the body to
// actually be off the floor before shooting, otherwise the "climb" shot is of a standing man.
await poll((s) => Number(s.y) > 0.5, 900);
await shot('19-tp-mantle.png');
const tpVaulted = await poll(
  (s) => s.mantling === false && s.grounded === true && Number(s.y) > 0.9,
  3000,
);
await page.keyboard.up('Space');
await page.keyboard.up('w');
await page.keyboard.up('Shift');
check(
  'third-person vault finished on the ledge',
  Math.abs(Number(tpVaulted.y) - 1) < 0.05 && tpVaulted.grounded === true,
  `y=${Number(tpVaulted.y).toFixed(2)} grounded=${tpVaulted.grounded}`,
);
check(
  'the body stayed drawn through the climb',
  tpVaulted.avatarVisible === true,
  `visible=${tpVaulted.avatarVisible} boom=${Number(tpVaulted.boom).toFixed(2)}`,
);
await wait(400);

// --- 21 back to first person: no body in shot ---------------------------------
await page.keyboard.press('v');
await poll((s) => Number(s.viewBlend) <= 0.001, 4000);
await wait(300);
const fpBack = await state();
check(
  'V returns to first person',
  fpBack.view === 'first' && Number(fpBack.viewBlend) === 0,
  `view=${fpBack.view} blend=${fpBack.viewBlend}`,
);
check(
  'the body is not drawn in first person',
  fpBack.avatarVisible === false,
  `avatarVisible=${fpBack.avatarVisible}`,
);
check(
  'the camera is back at eye height',
  Math.abs(Number(fpBack.camY) - Number(fpBack.bodyY) - 1.62) < 0.03 &&
    Math.hypot(Number(fpBack.camX) - Number(fpBack.bodyX), Number(fpBack.camZ) - Number(fpBack.bodyZ)) < 0.05,
  `camY-bodyY=${(Number(fpBack.camY) - Number(fpBack.bodyY)).toFixed(3)} m`,
);
await shot('20-fp-hidden.png');

// --- 22 strafe and turn roll ---------------------------------------------------
await setVariant('2', 'Bare Room');
await respawn();
await wait(300);

// A pure strafe: no look input at all, so this isolates the lateral-velocity term.
await page.keyboard.down('a');
await wait(900);
const strafing = await sampleFrames(800);
await page.keyboard.up('a');
const strafeRoll = mean(strafing.map((s) => s.camRoll));
check(
  'strafing leans the camera',
  Math.abs(strafeRoll) > 0.9 && Math.abs(strafeRoll) < 2.6,
  `${strafeRoll.toFixed(2)} deg mean over ${strafing.length} frames (strafeRollDeg = 1.5)`,
);
await wait(500);
const afterStrafe = await state();
check(
  'the strafe lean releases',
  Math.abs(Number(afterStrafe.camRoll)) < 0.2,
  `${Number(afterStrafe.camRoll).toFixed(3)} deg 0.5 s after the key came up`,
);

// The full thing: a sprinting A-strafe circle, roll from both sources at once.
await respawn();
await wait(200);
await startProbe();
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await page.keyboard.down('a');
await wait(450);
await dragLook(120, sens);
await shot('21-roll.png');
await page.keyboard.up('a');
await page.keyboard.up('w');
await page.keyboard.up('Shift');
const rollProbe = await readProbe();
check(
  'a hard strafing turn rolls the camera',
  Math.abs(rollProbe.maxAbsRoll) > 0.9 && Math.abs(rollProbe.maxAbsRoll) < 4.5,
  `${rollProbe.maxAbsRoll.toFixed(2)} deg peak over ${rollProbe.samples} frames (1.5 strafe + 1.0 turn + 0.25 stride)`,
);
await wait(600);
const settled = await state();
check(
  'roll returns to zero within 0.5 s of the input stopping',
  Math.abs(Number(settled.camRoll)) < 0.2,
  `${Number(settled.camRoll).toFixed(4)} deg`,
);

// --- report ----------------------------------------------------------------
check(
  'no external requests',
  externalRequests.length === 0,
  externalRequests.length === 0 ? 'file:// only' : externalRequests.join(', '),
);

console.log(`\n[shoot] console errors: ${consoleErrors.length}`);
for (const e of consoleErrors) console.log(`  ERROR ${e}`);
console.log(`[shoot] console warnings: ${consoleWarnings.length}`);
for (const w of consoleWarnings) console.log(`  WARN  ${w}`);

await browser.close();

if (consoleErrors.length > 0 || failures.length > 0) {
  console.error(`\n[shoot] FAILED — ${failures.length} assertion(s), ${consoleErrors.length} console error(s)`);
  process.exit(1);
}
console.log(`\n[shoot] OK — screenshots in ${outDir}`);
