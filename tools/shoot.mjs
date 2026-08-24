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
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, meanLuminance, litFraction, hueFamilies } from './png.mjs';

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

/** Same, but hands back the PNG so it can be measured as well as looked at. */
const shotBuf = async (name) => {
  const buf = await page.screenshot();
  await writeFile(join(outDir, name), buf);
  console.log(`[shoot] wrote ${name}`);
  return buf;
};

/**
 * The sonar lab's assertions are photometric, and the only things on screen that the renderer
 * did *not* draw are DOM: the HUD panel (top left), the lil-gui panel (right), the hint line
 * and capture prompt (bottom) and the reticle (centre). This window sits clear of all of them
 * except the reticle, which is punched out.
 */
const FRAME = { x: 400, y: 200, w: 600, h: 420 };
const FRAME_HOLES = [{ x: 620, y: 340, w: 40, h: 40 }];
/** The near floor: where a footstep's paint lands when you are looking straight ahead. */
const FLOOR_BAND = { x: 300, y: 430, w: 700, h: 190 };
/**
 * Everything the renderer drew, minus the DOM. Wider than FRAME on purpose: the material
 * voices only show where the materials are, and the metal in this room (tank, crates) sits off
 * to one side, so a window tight around the reticle would report a cyan-only frame and call the
 * gold missing.
 */
const CANVAS = { x: 360, y: 40, w: 650, h: 600 };
/** A box around the reticle, where the firing streak lands and nothing else does. */
const AIM_BOX = { x: 500, y: 230, w: 280, h: 260 };

/** Mean luminance (0-255) and lit fraction of a screenshot, over a DOM-free window. */
function photo(buf, rect = FRAME, holes = FRAME_HOLES) {
  const img = decodePng(buf);
  return {
    mean: meanLuminance(img, rect, holes).mean,
    lit: litFraction(img, rect, 8).fraction,
  };
}
/** Splits a screenshot's lit pixels into the cool (cyan) and warm (gold) families. */
function hues(buf, rect = CANVAS) {
  return hueFamilies(decodePng(buf), rect);
}
const pct = (v) => `${(v * 100).toFixed(2)}%`;
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
// Sleep the release time, then poll: under a stalled software-GL frame the loop clamps its
// accumulator, so a wall-clock wait does not guarantee the same amount of *simulated* time.
await wait(500);
const afterStrafe = await poll((s) => Math.abs(Number(s.camRoll)) < 0.2, 2000);
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
const settled = await poll((s) => Math.abs(Number(s.camRoll)) < 0.2, 2000);
check(
  'roll returns to zero within 0.5 s of the input stopping',
  Math.abs(Number(settled.camRoll)) < 0.2,
  `${Number(settled.camRoll).toFixed(4)} deg`,
);

// ===========================================================================
//  SONAR LAB
//
//  Everything past here is about one question: does the dark read? The scene draws exactly
//  one thing — the point cloud sound paints — so every assertion is either "the buffer has
//  the blips it should" (state) or "the frame looks the way it should" (pixels).
// ===========================================================================

/** Yaw, in the controller's convention, that points from one XZ spot at another. */
const yawTo = (fromX, fromZ, toX, toZ) =>
  (Math.atan2(-(toX - fromX), -(toZ - fromZ)) * 180) / Math.PI;

/** Pitches the view by dragging vertically. Dragging down looks down, hence the sign. */
async function pitchBy(degrees, sensitivity) {
  const dy = -degrees / sensitivity;
  await page.mouse.move(640, 360);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(640, 360 + (dy * i) / 10);
    await wait(6);
  }
  await page.mouse.up();
  await wait(120);
}

/** Turns to an absolute yaw by dragging. Dragging right lowers yaw, hence the sign. */
async function turnTo(targetDeg, sensitivity) {
  const current = Number((await state()).yawDeg);
  let delta = targetDeg - current;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  if (Math.abs(delta) > 0.5) await dragLook(-delta, sensitivity);
  await wait(120);
}

/**
 * Fires a ping and waits for the bus to have delivered it.
 *
 * Waits out the shared cooldown first. A ping pressed while the previous one is still cooling
 * is refused by design, and a refused ping would otherwise surface much later as a mystery:
 * stale, zeroed stats belonging to whatever event actually landed last.
 */
async function ping(cls) {
  await poll((s) => Number(s.pingCooldown) === 0, 6000);
  const before = Number((await state()).soundEvents);
  await page.keyboard.press(cls === 'q-ping' ? 'q' : 'e');
  const landed = await poll((x) => Number(x.soundEvents) > before && x.lastEvent === cls, 6000);
  check(
    `${cls} landed`,
    Number(landed.soundEvents) > before && landed.lastEvent === cls,
    `soundEvents ${before} -> ${landed.soundEvents}, lastEvent=${landed.lastEvent}`,
  );
  await settle();
  await wait(180); // one more frame, so the screenshot has the new blips in it
  return state();
}

/**
 * Waits for a ping to have finished happening.
 *
 * Two things now outlive the keystroke. The front takes travel time to cross the room, and
 * blips are invisible until it reaches them; and sampling is amortised over several frames, so
 * the last rays of a beam are cast well after it was fired. A screenshot taken before both are
 * done is a picture of a ping in progress, which is a fine thing to assert on deliberately (see
 * the wave-in-flight section) and a terrible thing to assert on by accident.
 */
async function settle(budgetMs = 12000) {
  return poll((s) => s.waveLive === false && Number(s.pendingRays) === 0, budgetMs);
}

/** Empties the painted map and waits for it to actually be empty. */
async function clearPaint() {
  await page.keyboard.press('k');
  await poll((s) => Number(s.points) === 0, 4000);
}

/**
 * Cycles the paint clock's debug multiplier (T: ×1 → ×10 → ×60) until it reads `target`.
 *
 * One press per step, each confirmed before the next: key presses are edge-triggered per sim
 * tick, so two presses inside one tick collapse into one and the scale silently lands on the
 * wrong rung.
 */
async function setTimeScale(target) {
  for (let i = 0; i < 4; i++) {
    const before = Number((await state()).paintTimeScale);
    if (before === target) return;
    await page.keyboard.press('t');
    await poll((s) => Number(s.paintTimeScale) !== before, 3000);
  }
  const s = await state();
  check(`paint clock reached x${target}`, Number(s.paintTimeScale) === target, `x${s.paintTimeScale}`);
}

// --- 23 sonar lab loads black ----------------------------------------------
await page.goto(`${url}#sonar-lab`);
await page.waitForFunction(() => window.__blindspot !== undefined, null, { timeout: 15000 });
await wait(900);

const sonar = await state();
console.log('[shoot] sonar-lab state', JSON.stringify(sonar));
check('sonar lab booted from the hash route', sonar.scene === 'sonar-lab', `scene=${sonar.scene}`);
check('sonar renderer running', Number(sonar.fps) > 0, `fps=${Number(sonar.fps).toFixed(1)}`);
check('the map starts empty', Number(sonar.points) === 0, `points=${sonar.points}`);
check(
  'the scene owns the hint line',
  (await page.textContent('.bs-hint')).includes('Q ping · E beam · L reveal · 1-4 looks'),
  await page.textContent('.bs-hint'),
);

const darkBuf = await shotBuf('23-sonar-dark.png');
const dark = photo(darkBuf);
// Law 3: absence is black. Nothing but the point cloud may put light on the screen, so with
// nothing painted the frame has to be *actually* black, not nearly black.
check(
  'the unpainted frame is black',
  dark.mean < 2 && dark.lit < 0.005,
  `mean=${dark.mean.toFixed(3)}/255 lit=${pct(dark.lit)}`,
);

// --- 24 footsteps paint ----------------------------------------------------
// Eyes down, the way you walk in the dark. A footstep paints a 4 m puddle around the sole,
// and at a level gaze that puddle lives in the bottom sliver of the frame — the paint is
// identical either way, but this is the pose that shows it.
await pitchBy(-22, sens);
const looking = await state();
check(
  'looking down at the floor ahead',
  Math.abs(Number(looking.pitchDeg) + 22) < 3,
  `pitch=${Number(looking.pitchDeg).toFixed(1)} deg`,
);
await page.keyboard.down('w');
await wait(2200);
const walkBuf = await shotBuf('24-sonar-walk.png');
const walking = await state();
await page.keyboard.up('w');
await wait(250);

check(
  'walking paints the floor',
  Number(walking.points) > 500 && String(walking.lastEvent).endsWith('step'),
  `points=${walking.points} lastEvent=${walking.lastEvent} +${walking.lastDeposited}/~${walking.lastRefreshed} rays=${walking.lastRays}`,
);
check(
  'a footstep paints out to about its 4 m radius',
  Number(walking.lastMaxRange) > 2.5 && Number(walking.lastMaxRange) <= 4.01,
  `lastMaxRange=${Number(walking.lastMaxRange).toFixed(2)} m`,
);
const walkShot = photo(walkBuf, FLOOR_BAND, []);
check(
  'the footstep trail is visible in front of the player',
  walkShot.mean > 0.5 && walkShot.lit > 0.02,
  `floor band mean=${walkShot.mean.toFixed(3)}/255 lit=${pct(walkShot.lit)}`,
);

// The trail behind you is out of frame in first person — this is the shot that shows it.
await page.keyboard.press('v');
await poll((s) => Number(s.viewBlend) > 0.99, 4000);
await wait(250);
const trailBuf = await shotBuf('25-sonar-walk-third.png');
const trail = photo(trailBuf);
check(
  'the trail reads from behind the rig',
  trail.lit > 0.02 && (await state()).view === 'third',
  `lit=${pct(trail.lit)} mean=${trail.mean.toFixed(2)}/255`,
);
await page.keyboard.press('v');
await poll((s) => Number(s.viewBlend) < 0.01, 4000);

// --- 25 Q ping: the room read ----------------------------------------------
await clearPaint();
await respawn();
await wait(250);
const qState = await ping('q-ping');
const qBuf = await shotBuf('26-sonar-qping.png');
const q = photo(qBuf);
check(
  'the Q ping reads the room',
  Number(qState.points) > 5000 && Number(qState.lastDeposited) > 5000,
  `points=${qState.points} +${qState.lastDeposited}/~${qState.lastRefreshed} in ${Number(qState.lastPaintMs).toFixed(1)} ms`,
);
check(
  'the Q ping paints its whole 12 m radius and no further',
  Number(qState.lastMaxRange) > 9 && Number(qState.lastMaxRange) <= 12.01,
  `lastMaxRange=${Number(qState.lastMaxRange).toFixed(2)} m`,
);
check(
  'the room read lights the frame',
  q.mean > 4 && q.lit > 0.05,
  `mean=${q.mean.toFixed(2)}/255 lit=${pct(q.lit)}`,
);

// The shared 0.75 s cooldown (§3.5). Fired back to back with no waiting in between, so the
// test does not depend on how long a software-GL screenshot happens to take.
await poll((s) => Number(s.pingCooldown) === 0, 4000);
const beforeCooldown = Number((await state()).soundEvents);
await page.keyboard.press('q');
await page.keyboard.press('e');
await poll((s) => Number(s.soundEvents) > beforeCooldown, 4000);
await wait(200);
const cooling = await state();
check(
  'a second ping inside the cooldown is refused',
  Number(cooling.soundEvents) === beforeCooldown + 1 && cooling.lastEvent === 'q-ping',
  `soundEvents ${beforeCooldown} -> ${cooling.soundEvents}, lastEvent=${cooling.lastEvent}, cooldown=${Number(cooling.pingCooldown).toFixed(2)} s`,
);
// ...and once it has expired the same key works.
await poll((s) => Number(s.pingCooldown) === 0, 4000);
const afterCooldown = await ping('e-ping');
check(
  'the beam fires once the cooldown expires',
  Number(afterCooldown.soundEvents) === beforeCooldown + 2,
  `soundEvents=${afterCooldown.soundEvents} lastEvent=${afterCooldown.lastEvent}`,
);

/*
 * --- 26 E beam: the 22 m look-around ---------------------------------------
 *
 * Batch 2.1 changed what this key is for. It used to be a 25° × 40 m telescope; it is now a
 * 110° × 22 m look-around, and the assertions below were rewritten to match — the old ones
 * ("reaches across the far room", "is a cone, not a sphere") are gone because they described a
 * shape the beam deliberately no longer has. Note that this is a *documented* deviation from
 * vision §3.3/§3.5, recorded in SOUND_CLASSES; the numbers here and there must move together.
 */
await clearPaint();
await respawn();
await wait(250);
const eState = await ping('e-ping');
const eBuf = await shotBuf('27-sonar-eping.png');
check(
  'the E beam reaches its 22 m range and stops there',
  Number(eState.lastMaxRange) > 18 && Number(eState.lastMaxRange) <= 22.01,
  `lastMaxRange=${Number(eState.lastMaxRange).toFixed(2)} m of ${eState.eRange} m · ${eState.lastFar20} blips past 20 m`,
);
check(
  'the beam opens at least 90° across',
  Number(eState.lastSpanDeg) >= 90 && Number(eState.lastSpanDeg) <= Number(eState.eConeDeg) + 2,
  `span=${Number(eState.lastSpanDeg).toFixed(1)}° of a ${eState.eConeDeg}° cone`,
);
check(
  'the beam is that wide at range, not just at the muzzle',
  Number(eState.lastLateral) > 6.5,
  `paint reaches ${Number(eState.lastLateral).toFixed(2)} m off the aim axis (≥6.5 m is 110° held out to 8 m)`,
);
check(
  'the beam is still a cone: nothing lands behind the player',
  Number(eState.lastSpanDeg) < 180,
  `span=${Number(eState.lastSpanDeg).toFixed(1)}° · +${eState.lastDeposited} blips over 22 m vs +${qState.lastDeposited} for Q over 12 m`,
);
check(
  'the beam is visible',
  photo(eBuf).lit > 0.01,
  `lit=${pct(photo(eBuf).lit)}`,
);

/*
 * The landmark shot: walk up to the doorway and put the beam on the tank at (8.5, -2).
 *
 * This used to assert that the furthest blip came back from roughly the tank's distance, which
 * worked while the beam was a 25° slit — aim it at a thing and that thing is what answers. A
 * 110° beam is not a pointer: the same shot now takes in the tank *and* the wall behind it and
 * both side walls, so `lastMaxRange` reports the room, not the landmark. What is asserted
 * instead is the property the wide beam is *for*: from one press at the doorway, the whole
 * depth of the room comes back at once.
 */
await clearPaint();
await respawn();
await wait(200);
await hold(['w'], 2000);
await wait(300);
await clearPaint();
const atDoor = await state();
await turnTo(yawTo(Number(atDoor.x), Number(atDoor.z), 8.5, -2), sens);
const tankState = await ping('e-ping');
const tankBuf = await shotBuf('28-sonar-eping-tank.png');
check(
  'one look from the doorway takes in the landmark and the room behind it',
  Number(tankState.lastMaxRange) > 15 &&
    Number(tankState.lastSpanDeg) >= 90 &&
    photo(tankBuf).lit > 0.05,
  `from x=${Number(atDoor.x).toFixed(1)} yaw=${Number(tankState.yawDeg).toFixed(1)} · ` +
    `${Number(tankState.lastMaxRange).toFixed(2)} m deep, ${Number(tankState.lastSpanDeg).toFixed(0)}° wide, lit=${pct(photo(tankBuf).lit)}`,
);

// L is a debug reveal, not a light source the game has: it must change the picture completely.
await page.keyboard.press('l');
await poll((s) => s.reveal === true, 3000);
await wait(300);
const revealBuf = await shotBuf('29-sonar-reveal.png');
const reveal = photo(revealBuf);
check(
  'the reveal shows the geometry the beam found',
  reveal.mean > 40 && reveal.lit > 0.5,
  `mean=${reveal.mean.toFixed(1)}/255 lit=${pct(reveal.lit)}`,
);
await page.keyboard.press('l');
await poll((s) => s.reveal === false, 3000);

// --- 27 ageing: the memory skeleton ----------------------------------------
await clearPaint();
await respawn();
await wait(250);
await ping('q-ping');
const freshBuf = await shotBuf('30-sonar-fresh.png');
const fresh = photo(freshBuf);
const beforeAge = await state();

// The paint clock has a debug multiplier on T (×1 → ×10 → ×60) so ageing can be watched
// without waiting a minute for it. Poll the clock rather than sleeping a guessed amount.
await setTimeScale(10);
const clock0 = Number((await state()).paintTime);
await poll((s) => Number(s.paintTime) - clock0 >= 20, 15000);
await setTimeScale(1);
await wait(200);

const agedBuf = await shotBuf('31-sonar-aged.png');
const aged = photo(agedBuf);
const afterAge = await state();
check(
  'painted geometry cools with age',
  aged.mean < fresh.mean * 0.75,
  `mean ${fresh.mean.toFixed(2)} -> ${aged.mean.toFixed(2)}/255 over ${(Number(afterAge.paintTime) - clock0).toFixed(0)} s`,
);
check(
  'it cools to a memory skeleton, not to nothing',
  aged.mean > fresh.mean * 0.02 && aged.lit > 0.01,
  `mean=${aged.mean.toFixed(3)}/255 (${pct(aged.mean / fresh.mean)} of fresh) lit=${pct(aged.lit)}`,
);
check(
  'ageing costs no blips — the map persists (§3.6)',
  Number(afterAge.points) === Number(beforeAge.points),
  `points ${beforeAge.points} -> ${afterAge.points}`,
);

// --- 28 the four looks -----------------------------------------------------
// Identical scripted sequence for each look, from the same spawn with the same seed, so the
// four frames differ only in how the same events were sampled and drawn.
const looks = [];
for (const [key, name] of [
  ['1', 'Dust'],
  ['2', 'Blips'],
  ['3', 'Grain'],
  ['4', 'Afterimage'],
]) {
  await setVariant(key, name);
  await respawn();
  await clearPaint();
  await wait(200);
  await ping('q-ping');
  await wait(800);
  const s = await ping('e-ping');
  const buf = await shotBuf(`32-sonar-look-${name.toLowerCase()}.png`);
  const m = photo(buf);
  const h = hues(buf);
  looks.push({ name, points: Number(s.points), mix: Number(s.materialMix), ...m, hue: h });
  console.log(
    `  look ${name}: points=${s.points} mean=${m.mean.toFixed(2)}/255 lit=${pct(m.lit)} ` +
      `cool=${pct(h.coolFraction)} warm=${pct(h.warmFraction)} of ${h.lit} lit px`,
  );
}
check(
  'all four looks paint a legible frame',
  looks.every((l) => l.points > 1000 && l.lit > 0.05),
  looks.map((l) => `${l.name} ${l.points} pts ${pct(l.lit)}`).join(' · '),
);
check(
  'the looks are genuinely different samplings, not restyles',
  new Set(looks.map((l) => l.points)).size === 4,
  looks.map((l) => `${l.name}=${l.points}`).join(' '),
);

/*
 * §3.2: geometry is cyan-family, always — except that look 4 is the candidate that gives matter
 * a material voice, so it is the one look allowed a second hue family. Both halves are asserted,
 * because "look 4 has gold in it" is only interesting if the others provably do not.
 */
const cyanOnly = looks.filter((l) => l.name !== 'Afterimage');
check(
  'looks 1-3 keep matter inside the cyan band (§3.2)',
  cyanOnly.every((l) => l.hue.warmFraction < 0.02 && l.hue.coolFraction > 0.2 && l.mix === 0),
  cyanOnly.map((l) => `${l.name} warm=${pct(l.hue.warmFraction)} cool=${pct(l.hue.coolFraction)}`).join(' · '),
);
const after = looks.find((l) => l.name === 'Afterimage');
check(
  'look 4 speaks in two material voices at once — cyan concrete and gold metal',
  after.hue.coolFraction > 0.1 && after.hue.warmFraction > 0.02 && after.mix === 1,
  `cool=${pct(after.hue.coolFraction)} warm=${pct(after.hue.warmFraction)} of ${after.hue.lit} lit px · materialMix=${after.mix}`,
);

/*
 * --- 29 the wave in flight -------------------------------------------------
 *
 * The batch's headline change: a sound no longer paints instantly. Every blip carries the
 * instant its own front reaches it, and the shader will not draw it before then, so a ping is a
 * shell expanding through the room rather than a room appearing.
 *
 * Two claims are worth machine-checking, and they are opposite sides of the same invariant.
 * Nothing may be lit *outside* the front — that would be the system lying about what it has
 * heard (law 2) — and something must still be waiting *inside* the range, or the front has
 * already finished and there is nothing to see. The map is cleared first so every blip on
 * screen belongs to the event under test: a blip remembered from an earlier ping is legitimately
 * drawn ahead of the new front, and would make the first claim meaningless.
 */
await setVariant('1', 'Dust');
await respawn();
await setTimeScale(0.1);

/** Fires one ping on an empty map and reports at fractions of the front's travel. */
async function waveInFlight(cls, tag, fractions) {
  await clearPaint();
  await poll((s) => Number(s.pingCooldown) === 0, 8000);
  const before = Number((await state()).soundEvents);
  await page.keyboard.press(cls === 'q-ping' ? 'q' : 'e');
  await poll((x) => Number(x.soundEvents) > before && x.lastEvent === cls, 8000);
  const seen = [];
  for (const f of fractions) {
    const s = await poll((x) => Number(x.waveProgress) >= f, 40000);
    const buf = await shotBuf(`36-sonar-wave-${tag}-${Math.round(f * 100)}.png`);
    const front = Number(s.waveFront);
    const arrived = Number(s.arrivedMax);
    const pending = Number(s.pendingMin);
    const m = photo(buf);
    seen.push({ f, front, lit: m.lit, visible: Number(s.visiblePoints), points: Number(s.points) });
    console.log(
      `  ${tag} @${pct(Number(s.waveProgress))}: front=${front.toFixed(2)} m ` +
        `arrived=${arrived.toFixed(2)} pending=${pending.toFixed(2)} ` +
        `visible=${s.visiblePoints}/${s.points} lit=${pct(m.lit)}`,
    );
    check(
      `${tag} @${Math.round(f * 100)}%: nothing is lit beyond the front`,
      arrived <= front + 0.02,
      `furthest lit blip ${arrived.toFixed(2)} m, front ${front.toFixed(2)} m`,
    );
    check(
      `${tag} @${Math.round(f * 100)}%: the far side is still dark`,
      pending < 0 || pending >= front - 0.02,
      `nearest unlit blip ${pending.toFixed(2)} m, front ${front.toFixed(2)} m`,
    );
    check(
      `${tag} @${Math.round(f * 100)}%: the map is only partly drawn`,
      Number(s.visiblePoints) < Number(s.points),
      `${s.visiblePoints} of ${s.points} blips drawn`,
    );
  }
  /*
   * "More of the map is drawn each time", counted in blips rather than in lit pixels. Screen
   * brightness is not monotonic and should not be: the arrival flash is the brightest thing in
   * the frame, so as the front moves off to the far wall it takes its own glare with it and
   * leaves cooled paint behind. Lit fraction is printed above because it is worth reading; it
   * is not asserted on, because a falling one is the ramp working, not the wave failing.
   */
  check(
    `${tag}: the map fills in as the front travels`,
    seen.every((v, i) => i === 0 || v.visible > seen[i - 1].visible),
    seen.map((v) => `${Math.round(v.f * 100)}%=${v.visible}`).join(' → ') + ' blips drawn',
  );
  await settle(40000);
}

await waveInFlight('q-ping', 'q', [0.2, 0.5, 0.9]);
await waveInFlight('e-ping', 'e', [0.2, 0.5, 0.9]);

/*
 * --- 30 the firing streak --------------------------------------------------
 *
 * The E beam has to have a visible cause. The proof is arranged so that nothing else can
 * account for it: the map is emptied, the view is pitched up at open air, and the shot is taken
 * while the front has travelled under two metres — there is no geometry that close in that
 * direction, so any light in the box around the reticle is the streak.
 */
await clearPaint();
await respawn();
await pitchBy(28, sens);
await wait(200);
const beforeFire = photo(await shotBuf('37-sonar-tracer-before.png'), AIM_BOX, []);
check(
  'the aim box is black before firing',
  beforeFire.mean < 1 && beforeFire.lit < 0.002,
  `mean=${beforeFire.mean.toFixed(3)}/255 lit=${pct(beforeFire.lit)}`,
);

await poll((s) => Number(s.pingCooldown) === 0, 8000);
const beforeTracer = Number((await state()).soundEvents);
await page.keyboard.press('e');
const fired = await poll((x) => Number(x.soundEvents) > beforeTracer && x.tracerAlive === true, 8000);
const tracerBuf = await shotBuf('38-sonar-tracer.png');
const tracerShot = photo(tracerBuf, AIM_BOX, []);
const tracerFront = Number(fired.waveFront);
check(
  'the streak is on screen the moment the beam fires',
  fired.tracerAlive === true && tracerShot.lit > beforeFire.lit + 0.001 && tracerFront < 2,
  `lit ${pct(beforeFire.lit)} → ${pct(tracerShot.lit)} with the front only ${tracerFront.toFixed(2)} m out`,
);
const goneAt = await poll((s) => s.tracerAlive === false, 30000);
check(
  'and it is gone well inside 0.4 s',
  goneAt.tracerAlive === false && Number(goneAt.tracerAge) < 0.4,
  `age=${Number(goneAt.tracerAge).toFixed(3)} s`,
);
await shotBuf('39-sonar-tracer-gone.png');
await settle(40000);

// The air itself: a field of motes lit only by a passing front, and not drawn at all otherwise.
const airLive = await state();
check(
  'the lit air is switched off when no front is travelling',
  airLive.dustLit === false,
  `dustLit=${airLive.dustLit} waveLive=${airLive.waveLive}`,
);

await setTimeScale(1);
await pitchBy(-28, sens);

/*
 * --- 31 the near field -----------------------------------------------------
 *
 * A world-sized splat grows as 1/depth, so pinging a wall you are hugging used to fill the
 * screen with overlapping dinner plates. The clamp is what makes that a look rather than a bug,
 * and the assertion has two halves: the splat the formula *wanted* has to be far over the cap
 * (or the test is proving nothing) and what is drawn has to be under it.
 */
await clearPaint();
await respawn();
await page.keyboard.down('w');
await poll((s) => Number(s.speed) < 0.4 && Number(s.x) > -6, 15000);
await page.keyboard.up('w');
await wait(300);
await clearPaint();
const nearState = await ping('e-ping');
await shotBuf('40-sonar-near-wall.png');
check(
  'nose to a wall, no blip exceeds the screen-size cap',
  Number(nearState.maxBlipPixels) <= Number(nearState.pixelCap) + 0.01 &&
    Number(nearState.maxBlipWant) > Number(nearState.pixelCap) * 5,
  `wanted ${Number(nearState.maxBlipWant).toFixed(0)} px, drew ${Number(nearState.maxBlipPixels).toFixed(2)} px, cap ${nearState.pixelCap}`,
);

/*
 * --- 32 bloom --------------------------------------------------------------
 *
 * Look 4 asks for a bloom pass. Under a software rasteriser it is vetoed on sight — the pass
 * costs more than the whole rest of the frame there — so headless boots it off and B forces it
 * on for the comparison pair. Off must cost exactly nothing: the composer is bypassed, not run
 * with its strength at zero.
 */
await setVariant('4', 'Afterimage');
await respawn();
await clearPaint();
await ping('q-ping');
const bloomOff = await state();
check(
  'software GL vetoes bloom on its own',
  bloomOff.softwareGl === true ? bloomOff.bloom === false : bloomOff.bloom === true,
  `softwareGl=${bloomOff.softwareGl} bloom=${bloomOff.bloom}`,
);
/*
 * Each frame of the pair gets its own fresh ping first. Paint cools in real time and the three
 * shots are seconds apart, so comparing them without repainting would be measuring the age ramp
 * and calling it bloom — the first version of this test "proved" that switching bloom off makes
 * a frame 43 % darker than it started, which was entirely the paint getting older.
 */
const plainBuf = await shotBuf('41-sonar-bloom-off.png');
const plain = photo(plainBuf);
const plainFps = Number((await state()).fps);
await page.keyboard.press('b');
await poll((s) => s.bloom === true, 5000);
await ping('q-ping');
await wait(600);
const bloomedBuf = await shotBuf('42-sonar-bloom-on.png');
const bloomed = photo(bloomedBuf);
const bloomState = await state();
check(
  'bloom lifts the frame',
  bloomed.mean > plain.mean * 1.15 && bloomed.lit > plain.lit,
  `mean ${plain.mean.toFixed(2)} → ${bloomed.mean.toFixed(2)}/255 · lit ${pct(plain.lit)} → ${pct(bloomed.lit)} · ` +
    `${plainFps.toFixed(1)} → ${Number(bloomState.fps).toFixed(1)} fps (software GL, half-res pass)`,
);
await page.keyboard.press('b');
await poll((s) => s.bloom === false, 5000);
await ping('q-ping');
await wait(600);
const backBuf = await shotBuf('43-sonar-bloom-off-again.png');
const back = photo(backBuf);
/*
 * Not pixel-identical to the first frame, and it should not be: every shot in this trio is
 * preceded by its own ping, which restamps the room fresh *and* finds a few voxels the last one
 * missed, so the plain frame creeps up a little each time. What is asserted is the claim that
 * matters — the glow is gone, and the frame is back in the same register it started in.
 */
check(
  'and turning it off takes the glow with it',
  back.mean < bloomed.mean * 0.6 &&
    back.lit < bloomed.lit * 0.5 &&
    back.mean < plain.mean * 1.6,
  `mean ${plain.mean.toFixed(2)} → ${bloomed.mean.toFixed(2)} → ${back.mean.toFixed(2)}/255 · ` +
    `lit ${pct(plain.lit)} → ${pct(bloomed.lit)} → ${pct(back.lit)}`,
);

// --- 33 perf and the ring buffer -------------------------------------------
await setVariant('1', 'Dust');
await respawn();
await clearPaint();
const cost = [];
for (let i = 0; i < 10; i++) {
  const s = await ping('e-ping'); // ping() waits out the cooldown and the wave itself
  cost.push({
    total: Number(s.lastPaintMs),
    worstFrame: Number(s.lastChunkMs),
    chunks: Number(s.lastChunks),
    rays: Number(s.lastRays),
  });
}
await wait(400);
const stressed = await state();
console.log('[shoot] after 10 E pings', JSON.stringify(stressed));
console.log(
  `  E-ping CPU: ${mean(cost.map((c) => c.total)).toFixed(1)} ms total per beam ` +
    `(${mean(cost.map((c) => c.rays)).toFixed(0)} rays), spread over ` +
    `${mean(cost.map((c) => c.chunks)).toFixed(1)} frames, ` +
    `worst single frame ${Math.max(...cost.map((c) => c.worstFrame)).toFixed(1)} ms`,
);
check(
  'ten E beams keep the frame rate up',
  Number(stressed.fps) > 8,
  `${Number(stressed.fps).toFixed(1)} fps (software GL) · ${stressed.points} blips`,
);
check(
  'the ring buffer is inside its cap',
  Number(stressed.points) <= Number(stressed.capacity) && stressed.wrapped === false,
  `${stressed.points} / ${stressed.capacity} blips, wrapped=${stressed.wrapped}`,
);
/*
 * Law 5: movement never pays for information. A 110° beam is ten thousand rays and tens of
 * thousands of blips — done in one tick that is a visible hitch, so sampling is amortised over
 * however many frames it takes. What must stay small is therefore not the beam's total cost but
 * its worst *single frame's* share, which is what a player would feel.
 */
const worstFrame = Math.max(...cost.map((c) => c.worstFrame));
const meanTotal = mean(cost.map((c) => c.total));
check(
  'no single frame pays for a whole beam',
  // Two bounds, because one alone would lie. The absolute one is what a player would feel; the
  // relative one is what actually proves the work is being spread, and it holds whatever speed
  // the host runs at — a machine half as fast fails the first and still passes the second.
  worstFrame < 16 && worstFrame < meanTotal * 0.75 && cost.every((c) => c.chunks >= 2),
  cost
    .slice(0, 4)
    .map((c) => `${c.total.toFixed(1)} ms over ${c.chunks}`)
    .join(' · ') +
    ` … worst frame ${worstFrame.toFixed(1)} ms of ${meanTotal.toFixed(1)} ms mean`,
);
check(
  'and sampling always finishes — nothing is left pending',
  Number(stressed.pendingRays) === 0,
  `pendingRays=${stressed.pendingRays}`,
);
await shot('44-sonar-stress.png');

// A painted third-person frame, and back — both views must draw the same cloud.
await page.keyboard.press('v');
await poll((s) => Number(s.viewBlend) > 0.99, 4000);
await wait(250);
const tpBuf = await shotBuf('45-sonar-third.png');
check(
  'the cloud draws in third person too',
  photo(tpBuf).lit > 0.03,
  `lit=${pct(photo(tpBuf).lit)}`,
);
await page.keyboard.press('v');
await poll((s) => Number(s.viewBlend) < 0.01, 4000);

// K clears the map: the black we started from is reachable again.
await clearPaint();
await wait(250);
const cleared = await state();
const clearedShot = photo(await shotBuf('46-sonar-cleared.png'));
check(
  'clearing the map returns the scene to black',
  Number(cleared.points) === 0 && clearedShot.mean < 2,
  `points=${cleared.points} mean=${clearedShot.mean.toFixed(3)}/255`,
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
