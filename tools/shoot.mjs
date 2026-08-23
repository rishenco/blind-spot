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
await page.keyboard.press('Space');
// The arc is only a handful of headless frames, so poll for the airborne sample instead of
// sleeping and hoping — and shoot immediately, while the player is still up there.
const jumped = await poll((s) => s.grounded === false && Number(s.y) > 0.2, 2000);
check('airborne after jump', jumped.grounded === false && Number(jumped.y) > 0.2, `y=${Number(jumped.y).toFixed(2)}`);
await shot('05-jump.png');
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
await wait(2600);
const blocked = await state();
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
await wait(5200);
const onPlatform = await state();
check(
  'reached the 3 m platform via the stairs',
  Number(onPlatform.y) > 2.9 && onPlatform.grounded === true,
  `pos=${Number(onPlatform.x).toFixed(1)} ${Number(onPlatform.y).toFixed(2)} ${Number(onPlatform.z).toFixed(1)}`,
);
await shot('08-platform.png');
await page.keyboard.up('w');
await wait(200);

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
