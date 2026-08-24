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
import { decodePng, meanLuminance, litFraction, hueFamilies, whiteFraction } from './png.mjs';

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

/**
 * Mean luminance (0-255) and lit fraction of a screenshot, over a DOM-free window.
 *
 * `hot` and `sat` are the top of the same histogram: how much of the window is near the ceiling
 * of the 8-bit framebuffer, and how much has hit it. The cloud is drawn with additive blending
 * onto an LDR target, so those two are the only way to see the failure mode the brightness pass
 * exists to prevent — a frame that is not brighter so much as *clipped*, with the age band and
 * the material voices flattened into the same white.
 */
function photo(buf, rect = FRAME, holes = FRAME_HOLES) {
  const img = decodePng(buf);
  return {
    mean: meanLuminance(img, rect, holes).mean,
    lit: litFraction(img, rect, 8).fraction,
    hot: litFraction(img, rect, 200).fraction,
    sat: litFraction(img, rect, 250).fraction,
  };
}
/** Splits a screenshot's lit pixels into the cool (cyan) and warm (gold) families. */
function hues(buf, rect = CANVAS) {
  return hueFamilies(decodePng(buf), rect);
}
/**
 * How much of a window has gone ice-white, at four thresholds on the dimmest channel.
 *
 * Cooled paint is cyan however much of it piles up — red stays down — so the dimmest channel is
 * what tells a fresh return from a bright old one. `w100` is the number the batch-2.3.1
 * assertions rest on; the others are printed alongside it so a shifting threshold is visible in
 * the log rather than silently doing the arguing.
 */
function white(buf, rect = FLOOR_BAND, holes = []) {
  const img = decodePng(buf);
  return {
    w60: whiteFraction(img, rect, 60, holes).fraction,
    w100: whiteFraction(img, rect, 100, holes).fraction,
    w140: whiteFraction(img, rect, 140, holes).fraction,
    w190: whiteFraction(img, rect, 190, holes).fraction,
  };
}
const whiteLine = (w) =>
  `≥60 ${pct(w.w60)} · ≥100 ${pct(w.w100)} · ≥140 ${pct(w.w140)} · ≥190 ${pct(w.w190)}`;
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
function sampleFrames(ms, minFrames = 0) {
  return page.evaluate(
    ([duration, wanted]) =>
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
          /*
           * The window is a duration *and* a frame count. Headless software GL drops to a few
           * frames a second under load, and a 700 ms window that returned two samples is not a
           * short measurement of the thing, it is no measurement of the thing. The wall-clock
           * ceiling keeps a stalled page from hanging the run.
           */
          const enough = t >= duration && out.length >= wanted;
          if (!enough && t < duration * 4 + 2000) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
    [ms, minFrames],
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
/*
 * Measured at simulation rate, not at frame rate. The dip attacks and decays inside a few fixed
 * ticks; a rAF sampler on a 14 fps software rasteriser lands on whatever the last tick of a
 * rendered frame left behind, which is usually well past the peak — this assertion failed at
 * 29.3 mm against a 30 mm bar for exactly that reason, with nothing wrong underneath it. The
 * controller now holds the deepest dip since the respawn, so what is asserted is the dip that
 * happened rather than the one that happened to be visible.
 */
const dipHeld = Number((await state()).landDipPeak);
check(
  'landing dipped the camera',
  dipHeld > 0.03,
  `${(dipHeld * 1000).toFixed(1)} mm peak dip held by the sim (max is 120 mm), ` +
    `${(dipPeak * 1000).toFixed(1)} mm caught by the ${falling.length}-frame sampler`,
);
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
// Six frames minimum: the claim is about a clip advancing, and a two-sample window cannot see
// one advance. Frames past the end of the lane are harmless — both assertions below tolerate a
// body that has stopped.
const tpRun = await sampleFrames(700, 6);
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
  // Not `=== 0`: the blend is an exponential ease and lands on 1e-16 about as often as on a
  // clean zero. The poll above already treats 0.001 as arrived; the assertion now agrees with it.
  'V returns to first person',
  fpBack.view === 'first' && Number(fpBack.viewBlend) < 0.001,
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
  return poll(
    (s) => s.waveLive === false && Number(s.pendingRays) === 0 && Number(s.structPending) === 0,
    budgetMs,
  );
}

/**
 * Waits for look 5's contour strokes as well.
 *
 * They start at the front rather than a phase behind it (batch 2.3 removed the delay), but a
 * stroke still takes `inkSeconds` to draw itself, so the last few segments are still going when
 * the wave stops. Harmless on looks 1-4, where there are no contours and the counter is always
 * zero.
 */
async function settleInk(budgetMs = 40000) {
  await settle(budgetMs);
  return poll((s) => Number(s.structPendingEdges) === 0, budgetMs);
}

/**
 * Empties the painted map and waits for it to actually be empty.
 *
 * Look 5 keeps no blips, so `points` is already zero there and polling it alone would return
 * before the keystroke had even been read — hence the second, structured half of the condition.
 */
async function clearPaint() {
  await page.keyboard.press('k');
  await poll((s) => Number(s.points) === 0 && Number(s.structUnlockedDots) === 0, 4000);
}

/** Counts what look 5 knows inside one of the scene's named world boxes. */
const probeRegion = (region) =>
  page.evaluate((r) => window.__blindspot.probe('region', { region: r }), region);

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
  // Changed in batch 2.2: the scene gained a fifth look, so the hint line it owns now says 1-5.
  (await page.textContent('.bs-hint')).includes('Q ping · E beam · L reveal · 1-5 looks'),
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
// Since batch 2.3 the field also ships switched off — §30d checks the default and the checkbox.
const airLive = await state();
check(
  'the lit air is switched off when no front is travelling',
  airLive.dustLit === false,
  `dustLit=${airLive.dustLit} waveLive=${airLive.waveLive} dustEnabled=${airLive.dustEnabled}`,
);

await setTimeScale(1);
await pitchBy(-28, sens);

/*
 * ===========================================================================
 *  30a-30d THE RESTAMP POLICY (batch 2.3)
 * ===========================================================================
 *
 * Sound that reaches ground somebody has already painted is not news. Before this batch the
 * renderer treated it as news anyway: a restamped blip was reborn — gated behind the new front,
 * flashed white when it arrived — so a second ping swept a bright band back across a room you
 * already knew, and every footfall re-flashed the floor under a sprinting player three times a
 * second. Two complaints out of the same playtest, one line of shader.
 *
 * The policy now branches on whether a blip has a previous arrival stamp. Virgin ground gets the
 * whole wave, with the arrival eased in over `arriveSeconds` rather than popping. Known ground
 * refreshes silently: never gated, never flashed, its age gliding from what it was to zero over
 * `refreshSeconds`. Each half is checked below, in state and in pixels.
 */

/*
 * --- 30a a re-ping refreshes known ground silently --------------------------
 *
 * Photographed at x0.1, where the 12 m front takes nearly five seconds to cross the room and a
 * software-GL screenshot is a snapshot rather than a smear. The claim is about what the frame
 * does *while* the second front travels: it may end brighter — a refresh is supposed to make the
 * room fresh again — but nothing may ride across it on the way.
 */
await setVariant('1', 'Dust');
await respawn();
await clearPaint();
/*
 * Saturate the voxel grid first. Sampling is stochastic, so an early re-ping still finds
 * thousands of cells nobody has hit, and those are legitimately new — the case this section is
 * about is the one where almost everything the front touches is already known.
 */
let warmed;
for (let i = 0; i < 5; i++) warmed = await ping('q-ping');
check(
  'after five pings from one spot, a sixth is a refresh rather than a discovery',
  Number(warmed.lastRefreshed) > Number(warmed.lastDeposited) * 2.5,
  `+${warmed.lastDeposited} new / ~${warmed.lastRefreshed} refreshed on the fifth ping`,
);

await setTimeScale(0.1);
await poll((s) => Number(s.pingCooldown) === 0, 8000);
const beforeRestamp = Number((await state()).soundEvents);
await page.keyboard.press('q');
await poll((s) => Number(s.soundEvents) > beforeRestamp, 8000);
const sweep = [];
let sweepShot = false;
for (let i = 0; i < 30; i++) {
  const s = await state();
  const buf = await page.screenshot();
  const band = photo(buf, FLOOR_BAND, []);
  const live = s.waveLive === true;
  sweep.push({ front: Number(s.waveFront), live, refreshing: Number(s.refreshingPoints), ...band });
  // The picture the complaint was about: the middle of the second wave, over known floor.
  if (!sweepShot && live && Number(s.waveFront) > 5) {
    sweepShot = true;
    await writeFile(join(outDir, '38a-restamp-second-wave.png'), buf);
    console.log('[shoot] wrote 38a-restamp-second-wave.png');
  }
  if (!live && Number(s.refreshingPoints) === 0) break;
}
const inFlightBand = sweep.filter((v) => v.live);
const landedBand = sweep.find((v) => !v.live) ?? sweep[sweep.length - 1];
const peakRefreshing = Math.max(...sweep.map((v) => v.refreshing));
console.log(
  '  second wave over known floor: ' +
    sweep
      .map((v) => `${v.live ? v.front.toFixed(1) : 'done'}m:${v.mean.toFixed(1)}`)
      .join(' '),
);
check(
  'the second front goes down the silent branch, not the arrival branch',
  peakRefreshing > 1000,
  `${peakRefreshing} blips easing their age over at the peak, none of them gated or flashed`,
);
check(
  'no bright band travels back across ground you already know',
  inFlightBand.length >= 3 &&
    Math.max(...inFlightBand.map((v) => v.mean)) <= landedBand.mean * 1.08 &&
    Math.max(...inFlightBand.map((v) => v.hot)) <= landedBand.hot * 1.25 + 0.002,
  `floor band peaks at ${Math.max(...inFlightBand.map((v) => v.mean)).toFixed(2)}/255 while the ` +
    `front travels and settles at ${landedBand.mean.toFixed(2)} · ` +
    `near-white ${pct(Math.max(...inFlightBand.map((v) => v.hot)))} vs ${pct(landedBand.hot)} ` +
    `over ${inFlightBand.length} in-flight frames`,
);
check(
  'and the refresh still lands — the room does come back fresher than it was',
  landedBand.mean > inFlightBand[0].mean * 1.05,
  `floor band ${inFlightBand[0].mean.toFixed(2)} → ${landedBand.mean.toFixed(2)}/255`,
);
await settle(40000);
await setTimeScale(1);

/*
 * --- 30b virgin ground fades in ---------------------------------------------
 *
 * The other half of the same complaint — "they don't appear smoothly". New paint is no longer
 * switched on at full strength the instant its front arrives; it rises over `arriveSeconds`.
 * Counted rather than photographed, because the ramp is a per-blip property and a screenshot of
 * a travelling front cannot separate "this blip is dim because it is new" from "this blip is dim
 * because it is far away". The counter comes off the same stamps the shader eases on.
 */
await clearPaint();
await respawn();
await poll((s) => Number(s.pingCooldown) === 0, 8000);
const rampTrace = page.evaluate(
  (ms) =>
    new Promise((done) => {
      const out = [];
      const t0 = performance.now();
      const tick = () => {
        const s = window.__blindspot.getState();
        out.push([performance.now() - t0, s.rampingPoints, s.visiblePoints]);
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else done(out);
      };
      requestAnimationFrame(tick);
    }),
  2500,
);
await page.keyboard.press('q');
const rampRows = await rampTrace;
let rampRun = 0;
let rampBest = 0;
for (const r of rampRows) {
  if (r[1] > 0) rampBest = Math.max(rampBest, ++rampRun);
  else rampRun = 0;
}
const rampPeak = Math.max(...rampRows.map((r) => r[1]));
const rampFinal = Math.max(...rampRows.map((r) => r[2]));
const rampState = await state();
check(
  'virgin blips rise into view over several frames instead of popping',
  rampBest >= 4 && rampPeak > rampFinal * 0.1 && Number(rampState.arriveSeconds) > 0,
  `${rampBest} consecutive rendered frames had blips mid-ramp, peaking at ${rampPeak} of ` +
    `${rampFinal} drawn (${pct(rampPeak / rampFinal)} of the ping in mid-rise at once) · ` +
    `arrival ramp ${rampState.arriveSeconds} s`,
);
await settle(20000);

/*
 * --- 30c footsteps never re-flash the ground under you ----------------------
 *
 * The flicker, measured where it lives. Every visual property of a blip is a function of its
 * age, so "the dots under my feet flicker" is "the age of the paint under my feet jumps". The
 * scene reports the mean age of the blips within 3 m of the listener under two curves at once:
 * the shipped eased one, and the pre-2.3 stepped one computed from the same stamps in the same
 * frame. Sprinting over painted floor, the old curve drops off a cliff at every footfall and the
 * new one glides — and having both on the same blips is what makes that a measurement rather
 * than an assertion of taste.
 *
 * Sampled in a rAF loop rather than by screenshot: a footfall cadence is ~3.4 Hz and a
 * software-GL screenshot takes the better part of a second, so pixels cannot see this at all.
 */
await respawn();
await clearPaint();
await dragLook(LANE_TURN, sens);
await wait(150);
await ping('q-ping');
await ping('e-ping');
const paintedLane = await state();
const feetTrace = page.evaluate(
  (ms) =>
    new Promise((done) => {
      const out = [];
      const t0 = performance.now();
      const tick = () => {
        const s = window.__blindspot.getState();
        out.push([performance.now() - t0, s.nearBlips, s.nearAgeEased, s.nearAgeStep, s.speed]);
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else done(out);
      };
      requestAnimationFrame(tick);
    }),
  2600,
);
// Out and back over the same painted floor, so the run stays inside the lane it painted.
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await wait(1000);
await page.keyboard.up('w');
await page.keyboard.down('s');
await wait(1000);
await page.keyboard.up('s');
await page.keyboard.up('Shift');
const feetRows = await feetTrace;
/** Worst single-frame *fall* in one of the two age curves, over frames with enough blips. */
const worstDrop = (rows, idx) => {
  let worst = 0;
  let usable = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][1] < 200 || rows[i - 1][1] < 200) continue;
    usable++;
    worst = Math.max(worst, rows[i - 1][idx] - rows[i][idx]);
  }
  return { worst, usable };
};
const easedDrop = worstDrop(feetRows, 2);
const stepDrop = worstDrop(feetRows, 3);
const moving = feetRows.filter((r) => r[4] > 4).length;
console.log(
  `  ${feetRows.length} rendered frames, ${moving} of them at sprint, ` +
    `${easedDrop.usable} usable frame pairs over ${paintedLane.points} painted blips`,
);
check(
  'a footfall on known ground never snaps the age of the paint under it',
  easedDrop.usable >= 8 &&
    easedDrop.worst < 0.25 &&
    easedDrop.worst < stepDrop.worst * 0.6 &&
    stepDrop.worst > 0.2,
  `worst single-frame age drop under the feet: ${easedDrop.worst.toFixed(3)} s eased ` +
    `vs ${stepDrop.worst.toFixed(3)} s under the old restamp — the same blips, the same frames`,
);

/*
 * The half that must not be broken by any of this: your own footsteps are still your headlights
 * (§3.3). Sprinting into ground nobody has painted has to light it.
 */
await respawn();
await clearPaint();
await dragLook(LANE_TURN, sens);
await pitchBy(-25, sens);
await wait(200);
const beforeHeadlights = photo(await shotBuf('38b-headlights-dark.png'), FLOOR_BAND, []);
const darkPoints = Number((await state()).points);
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await wait(1200);
const headlightBuf = await shotBuf('38c-headlights.png');
await page.keyboard.up('w');
await page.keyboard.up('Shift');
const headlights = photo(headlightBuf, FLOOR_BAND, []);
const litPoints = Number((await state()).points);
check(
  'sprinting into unpainted ground still lights the way ahead (§3.3)',
  litPoints > darkPoints + 2000 && headlights.mean > beforeHeadlights.mean + 2 && headlights.lit > 0.03,
  `${darkPoints} → ${litPoints} blips · floor band ${beforeHeadlights.mean.toFixed(2)} → ` +
    `${headlights.mean.toFixed(2)}/255, lit ${pct(beforeHeadlights.lit)} → ${pct(headlights.lit)}`,
);
await pitchBy(25, sens);

/*
 * ===========================================================================
 *  30e-30i THE REFRESH BOUNDS (batch 2.3.1)
 * ===========================================================================
 *
 * Batch 2.3 stopped a restamp from *flashing*. It did not stop one from turning cooled floor
 * white: the age still eased all the way to zero, and zero is the ice-white end of the ramp, so
 * a player sprinting over ground they painted a minute ago laid footfall-shaped patches of white
 * onto navy — smoothly, three times a second, with a hard border where the paint radius stopped.
 * The ease smoothed time and left colour distance alone.
 *
 * Two bounds close it, both stored per blip at the restamp. A footstep may only walk the age back
 * to the end of the white band (`stepFloor`), never to zero — a step says "still here", a ping
 * says "look again", and only one of those was paid for. And every refresh fades out over the last
 * of its own radius (`featherStart`), so a patch has no edge to see.
 *
 * The pixel case is below in four parts: virgin ground must still ignite, the lane must stay cyan
 * under a sprint of the same length, a ping must still re-whiten, and dialling both bounds back
 * out must put the blotch back — the control runs first so the aged lane has something to be
 * quiet against, and the last part is what stops the other three from being a test of a dark room.
 */

/** Eyes down the way you sprint in the dark: the floor band then holds the ground ahead. */
const LANE_PITCH = -25;

/**
 * Types a value into one of the lil-gui number rows, found by its label.
 *
 * Real input into a real widget, like the front-dust checkbox click: the driver never writes game
 * state. lil-gui commits a number on `input`, so filling the field is what a player typing into
 * it does, and Enter blurs it exactly as they would.
 */
async function setKnob(label, value) {
  const index = await page.evaluate((name) => {
    const inputs = [...document.querySelectorAll('.lil-controller input[type="text"]')];
    const row = [...document.querySelectorAll('.lil-controller')].find(
      (c) => c.querySelector('.lil-name')?.textContent === name,
    );
    const input = row?.querySelector('input[type="text"]');
    return input === undefined || input === null ? -1 : inputs.indexOf(input);
  }, label);
  if (index < 0) return false;
  const input = page.locator('.lil-controller input[type="text"]').nth(index);
  await input.fill(String(value));
  await input.press('Enter');
  await wait(80);
  return true;
}

/**
 * Buys a lane of floor, saturates its voxels, and lets it cool well out of the white band.
 *
 * Saturation is the whole setup: sampling is stochastic, so a return trip over a lightly painted
 * lane finds thousands of cells nobody has hit yet and lights them — legitimately, as virgin
 * ground, in the same colour this section is hunting. Out and back at a sprint plus three
 * deliberate questions from the same spot leaves almost nothing new to find.
 */
async function ageTheLane(seconds = 4.5) {
  await respawn();
  await clearPaint();
  await dragLook(LANE_TURN, sens);
  await pitchBy(LANE_PITCH, sens);
  await wait(150);
  // Out and back further than the measured sprint runs, so that the run below finishes on ground
  // this pass actually bought: a run that overshoots the painted lane is measuring virgin floor.
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await wait(1500);
  await page.keyboard.up('w');
  await page.keyboard.down('s');
  await wait(1500);
  await page.keyboard.up('s');
  await page.keyboard.up('Shift');
  await ping('q-ping');
  await ping('e-ping');
  await ping('q-ping');
  // The white band is freshSeconds / coolRate = 2 s on this look, so this is well past it and
  // the lane is unambiguously in the cyan.
  const t0 = Number((await state()).paintTime);
  return poll((s) => Number(s.paintTime) - t0 >= seconds, 40000);
}

/**
 * Sprints a fixed distance down the lane and then stands still, and reads the floor from there.
 *
 * The measurement is taken standing, not mid-run, and that is the whole point: a footfall's paint
 * lives for the length of the white band, so a still camera a moment after the last one shows
 * exactly what that footfall did to the floor — while a frame grabbed mid-sprint shows whatever
 * phase of the stride the shutter happened to land on, at whatever point down the lane a 5-20 fps
 * screenshot took to arrive. Same feet, same ground, no phase in the number.
 *
 * The settle is measured in paint clock rather than wall time so the refresh ease has provably
 * finished (0.3 s) before the shutter, on a frame rate the driver does not control.
 */
async function sprintTheLane(sprintMs = 800, settleSeconds = 0.35) {
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  const moving = await page.screenshot();
  await wait(sprintMs);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  const during = await state();
  const t0 = Number(during.paintTime);
  await poll((s) => Number(s.paintTime) - t0 >= settleSeconds, 20000);
  const standing = [await page.screenshot(), await page.screenshot()];
  return { moving, standing, during };
}

/*
 * --- 30e the control: virgin ground still ignites ----------------------------
 *
 * §3.3, and the half of this that must not be broken by any of it: your own footsteps are your
 * headlights. Run first, so that the quiet lane below is quiet against a number measured the same
 * way — same pose, same sprint, same band — rather than against a threshold picked by hand.
 */
await setVariant('1', 'Dust');
await respawn();
await clearPaint();
await dragLook(LANE_TURN, sens);
await pitchBy(LANE_PITCH, sens);
await wait(150);
const virgin = await sprintTheLane();
await writeFile(join(outDir, '38e-sprint-over-virgin.png'), virgin.moving);
await writeFile(join(outDir, '38e2-after-virgin-sprint.png'), virgin.standing[0]);
console.log('[shoot] wrote 38e-sprint-over-virgin.png, 38e2-after-virgin-sprint.png');
const virginWhite = virgin.standing.map((b) => white(b));
const bestVirginWhite = Math.max(...virginWhite.map((w) => w.w100));
console.log(
  `  standing after a virgin sprint: ` + virginWhite.map((w) => pct(w.w100)).join(' ') +
    ` · ${whiteLine(virginWhite[0])}`,
);
check(
  'a sprint over unpainted floor ignites it white (§3.3)',
  bestVirginWhite > 0.004 && Number(virgin.during.lastDeposited) > 500,
  `${pct(bestVirginWhite)} of the floor band is still near-white a moment after the last ` +
    `footfall · that footfall discovered +${virgin.during.lastDeposited} blips and refreshed ` +
    `~${virgin.during.lastRefreshed}`,
);

// --- 30f sprinting over floor you already own leaves it cyan -----------------
const agedState = await ageTheLane();
const laneBuf = await shotBuf('38f-aged-lane.png');
const agedBand = photo(laneBuf, FLOOR_BAND, []);
const agedWhite = white(laneBuf);
console.log(`  aged lane: ${whiteLine(agedWhite)} · band mean ${agedBand.mean.toFixed(2)}/255`);
check(
  'the lane is painted, and has cooled out of the white band before the run',
  agedBand.lit > 0.02 && agedWhite.w100 < 0.0005 && Number(agedState.points) > 20000,
  `${Number(agedState.points).toLocaleString('en-US')} blips · band lit ${pct(agedBand.lit)} ` +
    `mean ${agedBand.mean.toFixed(2)}/255 · near-white ${pct(agedWhite.w100)}`,
);

const run = await sprintTheLane();
await writeFile(join(outDir, '38g-sprint-over-aged-lane.png'), run.moving);
await writeFile(join(outDir, '38h-after-sprint.png'), run.standing[0]);
console.log('[shoot] wrote 38g-sprint-over-aged-lane.png, 38h-after-sprint.png');
const runWhite = run.standing.map((b) => white(b));
const runBand = run.standing.map((b) => photo(b, FLOOR_BAND, []));
const worstRunWhite = Math.max(...runWhite.map((w) => w.w100));
const afterRunBand = runBand[0];
console.log(
  `  standing after a sprint over the aged lane: ` +
    runWhite.map((w, i) => `${pct(w.w100)}@${runBand[i].mean.toFixed(1)}`).join(' ') +
    ` · ${whiteLine(runWhite[0])}`,
);
/*
 * Bounded against the control rather than against zero. A sprint down a lane that has been
 * saturated three ways still finds a few hundred cells nobody has hit yet, and those are
 * *legitimately* white — virgin ground, §3.3, the thing 30e just measured. What the bounds have to
 * kill is the restamp blotch, which is an order of magnitude larger and covers the lane rather
 * than speckling it: a quarter of the control is well below the speckle floor and far below
 * anything a player would read as a patch.
 */
check(
  'sprinting over floor you already own leaves it cyan, not white',
  worstRunWhite < 0.008 && worstRunWhite < bestVirginWhite * 0.25,
  `worst near-white in the floor band ${pct(worstRunWhite)} a moment after the last footfall vs ` +
    `${pct(bestVirginWhite)} for the same sprint over virgin ground ` +
    `(${(bestVirginWhite / Math.max(1e-6, worstRunWhite)).toFixed(0)}x) · the lane read ` +
    `${pct(agedWhite.w100)} before the run`,
);
/*
 * The other way to pass the check above is to stop painting, so: the floor is still there at the
 * end of the run, and the engine says the footfalls spent themselves refreshing ground that was
 * already known rather than discovering it. The lit fraction is held to an absolute bar rather
 * than to the pre-run reading, because the player has moved nine metres down the lane between the
 * two frames and is looking at a different piece of floor — what it rules out is a dark screen.
 */
check(
  'and the floor under the run is still there — refreshed, not merely absent',
  afterRunBand.lit > 0.05 &&
    Number(run.during.lastRefreshed) > Number(run.during.lastDeposited) * 3,
  `band lit ${pct(agedBand.lit)} before the run → ${pct(afterRunBand.lit)} standing at the end of ` +
    `it · the last footfall refreshed ~${run.during.lastRefreshed} blips and found ` +
    `+${run.during.lastDeposited} new`,
);

/*
 * --- 30g the bounds are what did it -----------------------------------------
 *
 * Dial both back out — floor 0, feather 1 — and the policy is exactly the pre-2.3.1 one. If the
 * blotch does not come back, then the lane above was cyan for some other reason and none of this
 * proves anything.
 */
const knobsOff =
  (await setKnob('step age floor (bands)', 0)) && (await setKnob('refresh feather', 1));
const offState = await poll(
  (s) => Number(s.stepFloor) === 0 && Number(s.refreshFeatherStart) === 1,
  4000,
);
check(
  'the two bounds are live knobs, and the old policy is 0 / 1',
  knobsOff && Number(offState.stepFloor) === 0 && Number(offState.refreshFeatherStart) === 1,
  `stepFloor=${offState.stepFloor} featherStart=${offState.refreshFeatherStart}`,
);
await ageTheLane();
const oldPolicy = await sprintTheLane();
await writeFile(join(outDir, '38i-sprint-old-policy.png'), oldPolicy.moving);
await writeFile(join(outDir, '38i2-after-sprint-old-policy.png'), oldPolicy.standing[0]);
console.log('[shoot] wrote 38i-sprint-old-policy.png, 38i2-after-sprint-old-policy.png');
const oldWhite = oldPolicy.standing.map((b) => white(b));
const worstOldWhite = Math.max(...oldWhite.map((w) => w.w100));
console.log(
  `  standing after the same sprint, bounds off: ` + oldWhite.map((w) => pct(w.w100)).join(' ') +
    ` · ${whiteLine(oldWhite[0])}`,
);
check(
  'with the floor and the feather dialled out, the white patches come back',
  worstOldWhite > 0.004 && worstOldWhite > worstRunWhite * 4,
  `near-white in the floor band ${pct(worstOldWhite)} with the bounds off vs ` +
    `${pct(worstRunWhite)} with them on — the same lane, aged the same way`,
);
const knobsBack =
  (await setKnob('step age floor (bands)', 1)) && (await setKnob('refresh feather', 0.55));
const restored = await poll(
  (s) => Number(s.stepFloor) === 1 && Math.abs(Number(s.refreshFeatherStart) - 0.55) < 1e-6,
  4000,
);
check(
  'and the defaults go back',
  knobsBack &&
    Math.abs(Number(restored.stepFloor) - 1) < 1e-6 &&
    Math.abs(Number(restored.refreshFeatherStart) - 0.55) < 1e-6,
  `stepFloor=${restored.stepFloor} featherStart=${restored.refreshFeatherStart}`,
);

/*
 * --- 30h a ping still re-whitens the room -----------------------------------
 *
 * The floor is per class, and that is the whole design: a footfall is a byproduct of moving and
 * gets a floor, a ping is a question the player paid noise for and gets none. Asked over ground
 * it already owns, the beam has to make it new again.
 */
const agedForPing = await ageTheLane();
const beforePingBuf = await shotBuf('38j-aged-before-ping.png');
const beforePing = white(beforePingBuf);
const pinged = await ping('e-ping');
const rewhitenBuf = await shotBuf('38k-ping-rewhitens.png');
const rewhiten = white(rewhitenBuf);
console.log(
  `  E-ping over known floor: ${whiteLine(beforePing)} → ${whiteLine(rewhiten)} · ` +
    `+${pinged.lastDeposited} new / ~${pinged.lastRefreshed} refreshed`,
);
check(
  'an E-ping over ground you already own makes it white again',
  rewhiten.w100 > 0.004 &&
    rewhiten.w100 > beforePing.w100 * 8 &&
    Number(pinged.lastRefreshFloor) === 0 &&
    Number(pinged.lastRefreshed) > Number(pinged.lastDeposited) * 2,
  `near-white ${pct(beforePing.w100)} → ${pct(rewhiten.w100)} · floor ${pinged.lastRefreshFloor} s · ` +
    `~${pinged.lastRefreshed} refreshed against +${pinged.lastDeposited} discovered · ` +
    `aged lane was ${Number(agedForPing.points).toLocaleString('en-US')} blips`,
);

/*
 * --- 30i the same claims, in the data ---------------------------------------
 *
 * Pixels prove the frame; the probe proves the mechanism. `refreshProbe` hands back the two
 * numbers each restamp actually wrote, banded across the event's own radius, plus the raw
 * attributes of the blips under the player — which is the only way to check from outside the
 * renderer that the floor is a floor, that the feather tapers, and that the stamp written back
 * across a restamp is the age that was on screen.
 */
const refreshProbe = (args = {}) =>
  page.evaluate((a) => window.__blindspot.probe('refresh', a), args);

/** A band's feather for the report line — and a word rather than a crash when no band has one. */
const bandFeather = (b) => (b === undefined ? 'no populated band' : b.meanFeather.toFixed(3));

/*
 * Sampled at a *fixed* world point rather than around the player, so that a probe taken before a
 * footfall and one taken after it describe the same blips: the sphere follows the player by
 * default, and a player who has walked two metres between two probes is looking at two different
 * sets of ground.
 */
const cooledFrom = Number((await state()).paintTime);
await poll((s) => Number(s.paintTime) - cooledFrom >= 4.5, 40000);
const probeSpot = await state();
const here = {
  x: Number(probeSpot.x),
  y: Number(probeSpot.y) + 0.1,
  z: Number(probeSpot.z),
  radius: 3,
  rows: 80,
};
const beforeStep = await refreshProbe(here);
await page.keyboard.down('w');
await wait(500);
await page.keyboard.up('w');
const stepState = await poll((s) => String(s.lastEvent).endsWith('step'), 6000);
const stepProbe = await refreshProbe(here);
const populated = stepProbe.bands.filter((b) => b.known > 20);
const innerBand = populated[0];
const outerBand = populated[populated.length - 1];
console.log(
  `  step probe (${stepState.lastEvent}, r=${stepProbe.radius} m, ${stepProbe.stamped} blips stamped): ` +
    stepProbe.bands
      .map((b) => `${Math.round(b.lo * 100)}-${Math.round(b.hi * 100)}%:${b.known}×f${b.meanFeather.toFixed(2)}`)
      .join(' '),
);
check(
  "a footstep's restamps carry a floor at the end of the white band",
  Math.abs(Number(stepState.lastRefreshFloor) - 2) < 0.01 &&
    innerBand !== undefined &&
    Math.abs(innerBand.meanFloor - 2) < 0.01 &&
    Number(stepState.lastFloored) > 100,
  `floor ${Number(stepState.lastRefreshFloor).toFixed(2)} s = freshSeconds ${2} / coolRate ` +
    `${stepState.coolRate} × stepFloor ${stepState.stepFloor} · ` +
    `${stepState.lastFloored} restamps were older than it and were held there`,
);
check(
  'the refresh is total in the middle of the patch and tapers away at its rim',
  innerBand !== undefined &&
    outerBand !== undefined &&
    innerBand.meanFeather > 0.99 &&
    outerBand.meanFeather < 0.6 &&
    outerBand.meanFeather < innerBand.meanFeather * 0.7 &&
    Number(stepState.lastFeatherMean) < 1,
  `feather ${bandFeather(innerBand)} at ${Math.round((innerBand?.lo ?? 0) * 100)}-` +
    `${Math.round((innerBand?.hi ?? 0) * 100)}% of the radius → ${bandFeather(outerBand)} at ` +
    `${Math.round((outerBand?.lo ?? 0) * 100)}-${Math.round((outerBand?.hi ?? 0) * 100)}% · ` +
    `event mean ${Number(stepState.lastFeatherMean).toFixed(3)}`,
);
/*
 * The claim the whole batch is about, on the blips themselves: ground that was cold when the
 * footfall landed on it is not in the white afterwards. Restricted to blips the *earlier* probe
 * also saw as cold, because a blip a step deposits for the first time and its neighbour restamps
 * a third of a second later is legitimately young — the floor is a floor and never a ceiling, and
 * it is not supposed to age fresh paint back down to it.
 */
const wasCold = new Map(beforeStep.rows.filter((r) => r.age > 3).map((r) => [r.i, r]));
const flooredRows = stepProbe.rows.filter((r) => r.floor > 0 && wasCold.has(r.i));
const youngestFloored = Math.min(...flooredRows.map((r) => r.age));
check(
  'and no blip that was cold when a footfall reached it is left sitting in the white band',
  flooredRows.length > 5 && youngestFloored > 1.9,
  `${flooredRows.length} of ${stepProbe.rows.length} sampled blips were cold and then refreshed ` +
    `by a step; the youngest of them now displays ${youngestFloored.toFixed(2)} s of age, and the ` +
    `white band ends at 2.00 s`,
);

/*
 * The continuity construction, from the attributes themselves.
 *
 * A bounded refresh leaves a blip *between* its two stamps, so the stamp handed to the next event
 * has to be the one that reproduces what is on screen rather than the raw old arrival. Run at the
 * x0.1 clock: the 0.3 s ease then takes three seconds of wall time, so a probe taken right after
 * an event catches the restamp before the ease has moved anything, and what is left in the
 * measurement is the restamp itself. The old construction's error is computed alongside, on the
 * same rows, so the number has something to be compared with.
 */
await setTimeScale(0.1);
const quietFrom = Number((await state()).paintTime);
await poll((s) => Number(s.paintTime) - quietFrom > 0.5, 60000);
const standingAgain = await state();
const there = {
  x: Number(standingAgain.x),
  y: Number(standingAgain.y) + 0.1,
  z: Number(standingAgain.z),
  radius: 3,
  rows: 80,
};
const eventsBefore = Number((await state()).soundEvents);
/*
 * Walk until a footfall actually lands, re-probing the whole way and keeping the last reading
 * taken before it did.
 *
 * Two things have to be true at once and they pull against each other. A step is spent by
 * distance covered, so at a tenth of the clock a press long enough at 1x is a shuffle — pressing
 * for a fixed stretch of wall time measures a restamp that never happened. But the two probes
 * also have to be close together in *paint* clock: the pair is compared by assuming a blip ages
 * a second per second between them, which is exactly what a floored blip does not do while it is
 * held at the end of the white band. Walking until the step lands and keeping the newest probe
 * before it satisfies both — the gap that matters shrinks to the round trip that detected it.
 */
await page.keyboard.down('w');
let priorProbe = await refreshProbe(there);
let stepped = await state();
const walkUntil = Date.now() + 30000;
while (Number(stepped.soundEvents) === eventsBefore && Date.now() < walkUntil) {
  const candidate = await refreshProbe(there);
  stepped = await state();
  if (Number(stepped.soundEvents) === eventsBefore) priorProbe = candidate;
}
await page.keyboard.up('w');
const laterProbe = await refreshProbe(there);
const beforeById = new Map(priorProbe.rows.map((r) => [r.i, r]));
const dt = laterProbe.now - priorProbe.now;
const moved = [];
for (const row of laterProbe.rows) {
  const was = beforeById.get(row.i);
  if (was === undefined || Math.abs(was.birth - row.birth) < 1e-4) continue;
  moved.push({
    // What the age did across the restamp, against what the clock alone accounts for.
    shipped: Math.abs(row.age - (was.age + dt)),
    // What it would have done had the raw old arrival been written back as the baseline.
    naive: Math.abs(laterProbe.now - was.birth - (was.age + dt)),
  });
}
const worstShipped = moved.length === 0 ? Infinity : Math.max(...moved.map((m) => m.shipped));
const worstNaive = moved.length === 0 ? 0 : Math.max(...moved.map((m) => m.naive));
console.log(
  `  ${moved.length} blips restamped between the two probes over ${dt.toFixed(3)} s of paint clock: ` +
    `displayed age moved ${worstShipped.toFixed(3)} s worst case, ` +
    `${mean(moved.map((m) => m.shipped)).toFixed(3)} s mean`,
);
check(
  'a restamp writes back the age that was on screen, not the stamp underneath it',
  moved.length >= 5 && worstShipped < 0.15 && worstNaive > 0.4,
  `worst displayed-age step across the restamp: ${worstShipped.toFixed(3)} s shipped vs ` +
    `${worstNaive.toFixed(3)} s if the raw previous arrival were written back instead ` +
    `(${moved.length} blips, ${dt.toFixed(3)} s of clock between the probes, ` +
    `${stepped.lastEvent} landed)`,
);
await setTimeScale(1);

/*
 * The other half of the class split, in the data: a ping's restamps carry no floor at all, so the
 * room it re-asks answers new. Taken after the continuity pair on purpose — a ping would reset
 * every blip under the player to an unbounded refresh, which is exactly the state that makes the
 * construction above impossible to see.
 */
const pingedAgain = await ping('q-ping');
const pingProbe = await refreshProbe({ radius: 3, rows: 60 });
const pingBands = pingProbe.bands.filter((b) => b.known > 20);
const pingInner = pingBands[0];
const pingOuter = pingBands[pingBands.length - 1];
check(
  "a ping's restamps carry no floor at all — it re-asks the room, so the room answers new",
  Number(pingedAgain.lastRefreshFloor) === 0 &&
    pingBands.length >= 2 &&
    pingBands.every((b) => b.meanFloor === 0) &&
    pingInner !== undefined &&
    pingInner.meanFeather > 0.99,
  `floor ${pingedAgain.lastRefreshFloor} s across ${pingBands.length} populated bands of a ` +
    `${pingProbe.radius} m ping · feather ${bandFeather(pingInner)} → ${bandFeather(pingOuter)}`,
);

/*
 * The same invariant at speed, measured by the engine at the instant of every restamp: the age
 * the blip was displaying under its old stamps against the age it displays under its new ones, at
 * one clock value. At a sprint the footfalls land every ~0.29 s and the ease is 0.3 s, so every
 * restamp in this trace is a re-restamp mid-ease — the case the construction exists for.
 *
 * `lastRestampLate` is read alongside it and deliberately not asserted on. Sampling is amortised
 * over frames, so at 5-20 fps a sprint step reaches thousands of blips whose arrival has already
 * gone by; those have no ease left to run and take their new age in one step, which is lateness
 * in the sampler rather than the policy — the same reading on hardware GL is a rounding error.
 * What the batch owes them is that the step lands somewhere survivable, and that is the floor's
 * job, checked on the blips themselves above.
 */
const jumpTrace = page.evaluate(
  (ms) =>
    new Promise((done) => {
      const out = [];
      const t0 = performance.now();
      const tick = () => {
        const s = window.__blindspot.getState();
        out.push([
          performance.now() - t0,
          s.lastRestampJump,
          s.lastRefreshed,
          s.lastRestampLate,
          s.lastLateStep,
        ]);
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else done(out);
      };
      requestAnimationFrame(tick);
    }),
  2400,
);
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await wait(1000);
await page.keyboard.up('w');
await page.keyboard.down('s');
await wait(1000);
await page.keyboard.up('s');
await page.keyboard.up('Shift');
const jumpRows = await jumpTrace;
const refreshingFrames = jumpRows.filter((r) => Number(r[2]) > 0);
const worstJump = Math.max(0, ...refreshingFrames.map((r) => Number(r[1])));
const mostRefreshed = Math.max(0, ...refreshingFrames.map((r) => Number(r[2])));
const mostLate = Math.max(0, ...refreshingFrames.map((r) => Number(r[3])));
const worstLateStep = Math.max(0, ...refreshingFrames.map((r) => Number(r[4])));
console.log(
  `  sprint restamps: worst in-flight discontinuity ${worstJump.toFixed(4)} s · ` +
    `up to ${mostLate} of them reached late by the amortised sampler ` +
    `(worst step ${worstLateStep.toFixed(2)} s, software GL)`,
);
check(
  'and at a sprint, where every restamp lands mid-ease, none of them steps the picture',
  refreshingFrames.length >= 8 && mostRefreshed > 500 && worstJump < 0.02,
  `worst age discontinuity ${worstJump.toFixed(4)} s over ${refreshingFrames.length} rendered ` +
    `frames of refreshing (up to ${mostRefreshed} blips restamped by a single footfall, ` +
    `${mostLate} of them reached after their front had passed and excluded)`,
);
await pitchBy(-LANE_PITCH, sens);

/*
 * --- 30d the front dust ships switched off ----------------------------------
 *
 * The airborne shell the same playtest called part of the "second wave". It stays in the build
 * as a knob, off by default, and off has to mean *absent*: the field's object never enters the
 * draw list, so a front travelling with dust disabled costs exactly nothing.
 */
await setVariant('1', 'Dust');
await respawn();
await clearPaint();
const dustDefault = await state();
check(
  'the front dust is off out of the box',
  dustDefault.dustEnabled === false && dustDefault.dustLit === false,
  `dustEnabled=${dustDefault.dustEnabled} dustLit=${dustDefault.dustLit}`,
);
await poll((s) => Number(s.pingCooldown) === 0, 8000);
const beforeDustOff = Number((await state()).soundEvents);
await page.keyboard.press('q');
const dustOffFlight = await poll(
  (s) => Number(s.soundEvents) > beforeDustOff && s.waveLive === true,
  8000,
);
check(
  'and a front travelling with it off draws no air at all',
  dustOffFlight.dustLit === false,
  `front at ${Number(dustOffFlight.waveFront).toFixed(2)} m, dustLit=${dustOffFlight.dustLit}`,
);
await settle(20000);

// The checkbox is still there, and it still works: found by its own label, clicked, not poked.
const dustClick = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.lil-controller')].find(
    (c) => c.querySelector('.lil-name')?.textContent === 'front dust',
  );
  if (row === undefined) return 'no such row';
  const box = row.querySelector('input[type="checkbox"]');
  if (box === null) return 'no checkbox';
  box.click();
  return 'clicked';
});
const dustOn = await poll((s) => s.dustEnabled === true, 4000);
await poll((s) => Number(s.pingCooldown) === 0, 8000);
const beforeDustOn = Number((await state()).soundEvents);
await page.keyboard.press('q');
const dustOnFlight = await poll(
  (s) => Number(s.soundEvents) > beforeDustOn && s.dustLit === true,
  8000,
);
await shotBuf('38d-front-dust-on.png');
check(
  'the checkbox brings it back',
  dustClick === 'clicked' && dustOn.dustEnabled === true && dustOnFlight.dustLit === true,
  `${dustClick} · dustEnabled=${dustOn.dustEnabled} · lit at ${Number(dustOnFlight.waveFront).toFixed(2)} m`,
);
await settle(20000);
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.lil-controller')].find(
    (c) => c.querySelector('.lil-name')?.textContent === 'front dust',
  );
  row?.querySelector('input[type="checkbox"]')?.click();
});
await poll((s) => s.dustEnabled === false, 4000);

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

/*
 * --- 32a ping spam stays inside the band ------------------------------------
 *
 * The third thing the playtest reported: hammering Q and E made the frame so bright it was hard
 * to look at. The cloud is drawn additively onto an 8-bit target, so overlapping returns do not
 * blend, they *sum* — and a frame that has summed past 255 has thrown away the age band and the
 * material voices along with the headroom, which is the whole readable language of the look.
 *
 * Batch 2.3 took the reference's own answer: hold the return at unit strength, add the arrival
 * flash rather than multiplying by it, and let age carry the brightness down faster (look 4 cools
 * at 1.8x the shared ramp). The caps below are measured, not guessed — see the report — and they
 * sit far under the ceiling: the worst frame here is under a fifth of full scale.
 *
 * The mean and the near-white fraction are the discriminating pair: look 4 measured 53.6/255 and
 * 12.7% before this batch and runs at 33-37 and 3.4-4.2% after, so both caps fail the old build
 * and pass the new one with room. The clipped fraction is noisier — where the five shots land in
 * their fronts moves it by 4x run to run — so it is carried as a blowout backstop rather than as
 * the number the case rests on.
 */
for (const [key, name, capMean, capHot, capSat] of [
  ['1', 'Dust', 60, 0.12, 0.03],
  ['4', 'Afterimage', 45, 0.06, 0.03],
]) {
  await setVariant(key, name);
  await respawn();
  await clearPaint();
  await ping('q-ping');
  const single = photo(await shotBuf(`43a-spam-${name.toLowerCase()}-single.png`));
  const spamFrames = [];
  for (let i = 0; i < 5; i++) {
    await poll((x) => Number(x.pingCooldown) === 0, 8000);
    const before = Number((await state()).soundEvents);
    await page.keyboard.press(i % 2 === 0 ? 'q' : 'e');
    await poll((x) => Number(x.soundEvents) > before, 8000);
    spamFrames.push(photo(await page.screenshot()));
  }
  const spamBuf = await shotBuf(`43b-spam-${name.toLowerCase()}.png`);
  const spam = photo(spamBuf);
  const peak = spamFrames.reduce((a, b) => (b.mean > a.mean ? b : a), spam);
  console.log(
    `  ${name}: one ping ${single.mean.toFixed(2)}/255 → five back-to-back ` +
      `${spamFrames.map((f) => f.mean.toFixed(1)).join(' ')} → ${spam.mean.toFixed(2)} · ` +
      `near-white ${pct(peak.hot)} · clipped ${pct(peak.sat)}`,
  );
  check(
    `${name}: five pings back to back stay inside the band`,
    peak.mean < capMean && peak.hot < capHot && peak.sat < capSat,
    `peak ${peak.mean.toFixed(2)}/255 (cap ${capMean}) · near-white ${pct(peak.hot)} ` +
      `(cap ${pct(capHot)}) · clipped ${pct(peak.sat)} (cap ${pct(capSat)})`,
  );
  check(
    `${name}: spamming is brighter than one ping, but not by an order of magnitude`,
    peak.mean > single.mean && peak.mean < single.mean * 4,
    `${single.mean.toFixed(2)} → ${peak.mean.toFixed(2)}/255 (${(peak.mean / single.mean).toFixed(2)}x)`,
  );
  await settle(40000);
}

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

/*
 * ===========================================================================
 *  34 BLUEPRINT — the structured reveal (look 5)
 * ===========================================================================
 *
 * Looks 1-4 answer a ping by sampling: cast rays, drop a blip wherever one lands, and let the
 * density of the spray stand in for the shape. Look 5 answers a different question. The room's
 * surfaces are laid out once, up front, as a dot lattice and a set of edge segments, and a sound
 * does not *deposit* anything — it *unlocks* what was already there. So the frame it produces is
 * a drawing rather than a spray, and every claim below is about the drawing being honest.
 *
 * It runs last on purpose. It is the only look with a build step and the only one with per-item
 * state, so putting it after the perf section keeps its costs out of everybody else's numbers.
 *
 * The scene it runs in gained one wall for this batch (§4 of the vision's propagation rule: two
 * walls between you and a sound means nothing at all comes back). The side chamber's only entrance
 * is a corner doorway, which is what makes "ping from here, see nothing; walk through, see all of
 * it" a thing a machine can check.
 */
await setVariant('5', 'Blueprint');
await poll((s) => s.structBuilt === true, 30000);
await respawn();
await clearPaint();
// Level the gaze: everything before this left the view pitched down at the floor.
await pitchBy(12, sens);
await wait(200);

const bp0 = await state();
const regions = bp0.probeRegions;
console.log('[shoot] blueprint state', JSON.stringify(bp0));
check(
  'look 5 is the structured reveal, and its lattice is precomputed',
  bp0.structured === true && bp0.structBuilt === true && Number(bp0.structDots) > 10000,
  `${Number(bp0.structDots).toLocaleString('en-US')} dots · ` +
    `${Number(bp0.structEdges).toLocaleString('en-US')} segments · ` +
    `${(Number(bp0.structBytes) / 1e6).toFixed(2)} MB · built in ${Number(bp0.structBuildMs).toFixed(0)} ms`,
);
check(
  'the HUD names the look',
  (await page.textContent('.bs-debug')).includes('Blueprint'),
  (await page.textContent('.bs-debug')).split('\n')[0],
);
/*
 * The lattice is *not* a point cloud with extra steps: nothing is deposited into the ring buffer
 * at all on this look, so the two representations can never both be on screen.
 */
check(
  'the blueprint deposits no blips — one representation per look',
  Number(bp0.points) === 0,
  `points=${bp0.points} of ${bp0.capacity} · structured=${bp0.structured}`,
);
const bpDark = photo(await shotBuf('47-blueprint-dark.png'));
check(
  'an unheard lattice is not drawn (law 3: absence is black)',
  bpDark.mean < 2 && bpDark.lit < 0.005,
  `mean=${bpDark.mean.toFixed(3)}/255 lit=${pct(bpDark.lit)} with ${bp0.structDots} dots in memory`,
);
// The look asks for bloom; software GL vetoes it exactly as it does for look 4.
check(
  'Blueprint asks for bloom, and software GL still gets its veto',
  bp0.bloomWanted === true && (bp0.softwareGl === true ? bp0.bloom === false : bp0.bloom === true),
  `wanted=${bp0.bloomWanted} softwareGl=${bp0.softwareGl} effective=${bp0.bloom}`,
);

/*
 * --- 34a one front, and the drawing happens at it ---------------------------
 *
 * This section used to assert the opposite, and the change is the point. The reveal ran in two
 * phases: a ring of hot displaced dots, and then, `phaseDelay` later, a second pass in which the
 * contours inked. Playtested, the lag read as a bug — a second wave crossing the room behind the
 * first — so the delay and the wake that bridged it are gone, code and GUI both, and the ink now
 * happens *at* the ring. What survives is the ripple: the ring is the front itself, displacing
 * and burning the lattice as it goes, and a contour starts drawing itself the moment the front
 * reaches it, taking `inkSeconds` to complete the stroke.
 *
 * Everything is asserted where the front is, not globally, because near the origin the drawing
 * has long finished by the time the ring is out at the doorjamb — which is what "at the front"
 * means. The clock runs at x0.1 so a 0.48 s crossing is five seconds of wall time.
 */
await setTimeScale(0.1);
await clearPaint();
await poll((s) => Number(s.pingCooldown) === 0, 8000);
const beforeBp = Number((await state()).soundEvents);
await page.keyboard.press('q');
await poll((s) => Number(s.soundEvents) > beforeBp && s.lastEvent === 'q-ping', 8000);

/*
 * One pass down the room, watching the chokepoint's doorjamb: the front position at which its
 * lattice first draws, and the front position at which its first contour is finished. The gap
 * between those two numbers *is* the lag between the ring and the drawing, measured in metres of
 * travel, and it is the number this batch changed. Sampled rather than asserted at one instant
 * because a stroke is 0.06 s — a metre and a half of front travel — and a screenshot is slower
 * than that even at x0.1.
 */
let inFlight = null;
let ringBuf = null;
let jambRing = null;
let dotFront = Number.NaN;
let inkFront = Number.NaN;
// Bounded by wall time, not by an iteration count: a state read plus a region probe is a few
// milliseconds and the front takes five seconds to cross, so a count large enough on one host
// is a count that gives up halfway on the next.
const bpDeadline = Date.now() + 60000;
while (Date.now() < bpDeadline) {
  const s = await state();
  const j = await probeRegion('jamb');
  const front = s.waveLive === true ? Number(s.waveFront) : Number(s.waveRange);
  if (Number.isNaN(dotFront) && j.drawn > 20) dotFront = front;
  if (Number.isNaN(inkFront) && j.edgesInked > 0) inkFront = front;
  if (inFlight === null && Number(s.waveFront) >= 9.8 && s.waveLive === true) {
    inFlight = s;
    jambRing = j;
    ringBuf = await shotBuf('48-blueprint-at-the-front.png');
  }
  if (!Number.isNaN(inkFront) && inFlight !== null) break;
  if (s.waveLive !== true) break;
}
// The loop should always have caught the front mid-room; if it somehow did not, take the sample
// anyway so the checks below fail on their own terms rather than on a null.
if (inFlight === null) {
  inFlight = await state();
  jambRing = await probeRegion('jamb');
  ringBuf = await shotBuf('48-blueprint-at-the-front.png');
}
console.log(
  `  front=${Number(inFlight?.waveFront ?? 0).toFixed(2)} m: jamb ${jambRing?.drawn}/${jambRing?.dots} dots drawn, ` +
    `${jambRing?.edgesUnlocked} segments unlocked, ${jambRing?.edgesInked} inked · ` +
    `${inFlight?.structInkedEdges}/${inFlight?.structUnlockedEdges} inked room-wide, ` +
    `${inFlight?.structPendingEdges} mid-stroke · ripple max ` +
    `${(Number(inFlight?.structRippleMax ?? 0) * 100).toFixed(1)} cm on ${inFlight?.structRippling} dots`,
);
check(
  'the ring has reached the doorjamb and lit its lattice',
  jambRing !== null && jambRing.drawn > 20 && jambRing.unlocked > 20,
  `${jambRing?.drawn} of ${jambRing?.dots} dots drawn at the jamb, front at ` +
    `${Number(inFlight?.waveFront ?? 0).toFixed(2)} m`,
);
/*
 * The inversion. This assertion used to read "not one contour has inked where the ring is", and
 * the number it printed was zero — the drawing did not start until `phaseDelay` (0.3 s, seven and
 * a half metres of travel) after the ring had gone by. The lag is now one stroke.
 */
check(
  'contours ink as the front passes them, not a phase later',
  Number.isFinite(inkFront) && Number.isFinite(dotFront) && inkFront - dotFront < 2.5,
  `the jamb's lattice lit with the front at ${dotFront.toFixed(2)} m and its first contour was ` +
    `whole at ${inkFront.toFixed(2)} m — ${(inkFront - dotFront).toFixed(2)} m of lag, against ` +
    `${(Number(bp0.structInkSeconds) * 25).toFixed(2)} m for one ${bp0.structInkSeconds} s stroke ` +
    `(the old confirm delay alone was 7.50 m)`,
);
check(
  'the drawing keeps up with the front room-wide',
  Number(inFlight.structInkedEdges) > Number(inFlight.structUnlockedEdges) * 0.4,
  `${inFlight.structInkedEdges} inked of ${inFlight.structUnlockedEdges} unlocked, ` +
    `${inFlight.structPendingEdges} still mid-stroke`,
);
check(
  'dots at the front are displaced by it, and the displacement is real',
  Number(inFlight.structRippling) > 0 && Number(inFlight.structRippleMax) > 0.03,
  `${inFlight.structRippling} dots riding the ring, peak offset ` +
    `${(Number(inFlight.structRippleMax) * 100).toFixed(1)} cm of an amplitude of ` +
    `${(Number(inFlight.structRipple) * 100).toFixed(0)} cm`,
);
/*
 * Law 2, in the one place this look could break it. The ripple is a *render-time* offset off the
 * stored position — the data never moves — so nothing is unlocked ahead of the front, and dots
 * whose front has not arrived are not drawn at all.
 */
check(
  'the far side of the room is unlocked but not yet drawn',
  Number(inFlight.structDrawnDots) < Number(inFlight.structUnlockedDots),
  `${inFlight.structDrawnDots} drawn of ${inFlight.structUnlockedDots} unlocked`,
);

/*
 * The moment the front stops. This used to be "the wave has stopped and the ink is still
 * catching up", polled on there *being* a backlog; the backlog is now only the last stroke's
 * worth, so what is asserted is its size rather than its existence. Anything left is a segment
 * the front passed within the last `inkSeconds`.
 */
const between = await poll((s) => s.waveLive === false, 60000);
const betweenBuf = await shotBuf('49-blueprint-front-stopped.png');
check(
  'when the front stops, the drawing is all but finished with it',
  Number(between.structInkedEdges) > Number(between.structUnlockedEdges) * 0.75,
  `front finished with ${between.structInkedEdges} of ${between.structUnlockedEdges} segments ` +
    `inked, ${between.structPendingEdges} still mid-stroke`,
);
/*
 * And the removed mechanics are gone from the panel too, not merely defaulted to zero — the two
 * rows that drove the second front no longer exist.
 */
const bpRows = await page.$$eval('.lil-name', (els) => els.map((e) => e.textContent));
check(
  'the second front is gone from the GUI as well as from the shader',
  bpRows.length > 20 && !bpRows.some((n) => /confirm delay|probe wake/i.test(n ?? '')),
  `${bpRows.length} controls, none of them a confirm delay or a probe wake`,
);

/*
 * Settled: everything the ping unlocked is drawn, and the ring has passed out of existence. The
 * two do not finish together — a stroke is `inkSeconds` and the ring's tail is a few tenths of a
 * second of travel past that — so the ring is waited out explicitly rather than assumed. (At the
 * x0.1 clock this section runs on, "a few tenths" is a few seconds of wall time, which is how
 * this came to be a wait rather than an assumption.)
 */
const settledBp = await poll((s) => Number(s.structRippling) === 0, 60000);
await settleInk(60000);
await wait(250);
const settledBuf = await shotBuf('50-blueprint-settled.png');
const jambSettled = await probeRegion('jamb');
check(
  'settled: the contours inked in where the ring had been',
  jambSettled.edgesInked > 0 && jambSettled.edgesInked === jambSettled.edgesUnlocked,
  `${jambSettled.edgesInked} of ${jambSettled.edgesUnlocked} unlocked segments inked in the ring zone`,
);
check(
  'settled: the ripple is gone — every dot is back on its exact surface',
  Number(settledBp.structRippling) === 0 && Number(settledBp.structRippleMax) === 0,
  `rippling=${settledBp.structRippling} max=${settledBp.structRippleMax}`,
);
const settledShot = photo(settledBuf);
check(
  'settled: the blueprint is legible',
  settledShot.lit > 0.02 && settledShot.mean > 1,
  `mean=${settledShot.mean.toFixed(2)}/255 lit=${pct(settledShot.lit)} · ` +
    `${settledBp.structUnlockedDots} dots, ${settledBp.structInkedEdges} contours`,
);
/*
 * §3.2: the accent channel exists on both lattice and contour, but it is reserved for traversal
 * holds and is not spent yet, so a blueprint frame has to be as free of gold as looks 1-3 are.
 *
 * Only the warm half is asserted *here*. This particular frame is a quarter of a second past the
 * moment its contours inked, and inking is the brightest a line ever gets — the whole drawing is
 * clipping to the ice-white top of the band, which is §3.2's hot end doing its job rather than a
 * hue leaving the family. The cool half of the claim is asserted on a settled frame below.
 */
const settledHue = hues(settledBuf);
check(
  'the blueprint spends no second hue — the accent channel is reserved (§3.2)',
  settledHue.warmFraction < 0.02,
  `cool=${pct(settledHue.coolFraction)} neutral=${pct(settledHue.neutral / settledHue.lit)} ` +
    `warm=${pct(settledHue.warmFraction)} of ${settledHue.lit} lit px, one frame past the ink flash`,
);
/*
 * Pixel evidence for the ripple, over and above the shader's own numbers: a box on the doorjamb,
 * photographed while the ring was inside it and again once it had settled. A hot displaced ring
 * and a cold committed drawing cannot look the same, and here they measurably do not.
 */
const RING_BOX = { x: 470, y: 250, w: 200, h: 210 };
const ringHot = photo(ringBuf, RING_BOX, []);
const ringCold = photo(settledBuf, RING_BOX, []);
const ringMid = photo(betweenBuf, RING_BOX, []);
check(
  'the ring zone is a different picture while the front is in it',
  Math.abs(ringHot.mean - ringCold.mean) > 0.5 || Math.abs(ringHot.lit - ringCold.lit) > 0.01,
  `doorjamb box: ring ${ringHot.mean.toFixed(2)}/255 lit ${pct(ringHot.lit)} → ` +
    `between ${ringMid.mean.toFixed(2)} lit ${pct(ringMid.lit)} → ` +
    `settled ${ringCold.mean.toFixed(2)} lit ${pct(ringCold.lit)}`,
);
await setTimeScale(1);

/*
 * --- 34b an object surfaces whole ------------------------------------------
 *
 * The propagation rule this look is built on. A sampling look paints the faces its rays happen
 * to strike, which means a crate you have walked all the way around is still a set of unrelated
 * patches. Here, hearing *any* face of an object hands you the object: every face of it inside
 * the sound's radius unlocks together, back faces included. A thing you have heard is a thing you
 * know the shape of, which is the only reading that lets you route around it in the dark.
 *
 * The proof needs both halves. The crate's far side must come back from a ping that can only have
 * touched its near side — and something farther away, with no sound path to it at all, must stay
 * black in the same breath, or "whole object" would just be "everything".
 */
await respawn();
await clearPaint();
const atSpawn = await state();
const crateX = (regions.crateFront[0] + regions.crateBack[3]) / 2;
const crateZ = (regions.crateFront[2] + regions.crateFront[5]) / 2;
await turnTo(yawTo(Number(atSpawn.x), Number(atSpawn.z), crateX, crateZ), sens);
const crateState = await ping('e-ping');
await settleInk(60000);
const crateFront = await probeRegion('crateFront');
const crateBack = await probeRegion('crateBack');
const crateShot = await shotBuf('51-blueprint-whole-object.png');
console.log(
  `  crate at (${crateX.toFixed(1)}, ${crateZ.toFixed(1)}): ` +
    `front ${crateFront.unlocked}/${crateFront.dots}, back ${crateBack.unlocked}/${crateBack.dots}`,
);
check(
  'the struck face of the crate comes back',
  crateFront.unlocked === crateFront.dots && crateFront.dots > 10,
  `${crateFront.unlocked} of ${crateFront.dots} dots, ${crateFront.edgesUnlocked} of ${crateFront.edges} segments`,
);
check(
  'and so does the face behind it — an object you hear, you hear whole',
  crateBack.unlocked === crateBack.dots && crateBack.dots > 10 && crateBack.edgesInked > 0,
  `${crateBack.unlocked} of ${crateBack.dots} dots on the far side, ` +
    `${crateBack.edgesInked} of ${crateBack.edges} segments inked`,
);
check(
  'the beam that did it is a real beam, not a reveal',
  Number(crateState.structLastDots) > 1000 && Number(crateState.structLastRays) > 1000,
  `${crateState.structLastRays} rays unlocked ${crateState.structLastDots} dots and ` +
    `${crateState.structLastEdges} segments in ${Number(crateState.structLastMs).toFixed(1)} ms`,
);
check(
  'the beam is visible',
  photo(crateShot).lit > 0.01,
  `lit=${pct(photo(crateShot).lit)}`,
);
// The other half of §3.2, on a frame whose contours have finished flashing: cyan, and only cyan.
const crateHue = hues(crateShot);
check(
  'and a settled blueprint is cyan-family, always (§3.2)',
  crateHue.coolFraction > 0.8 && crateHue.warmFraction < 0.02,
  `cool=${pct(crateHue.coolFraction)} warm=${pct(crateHue.warmFraction)} of ${crateHue.lit} lit px`,
);

/*
 * --- 34c two walls and no path ---------------------------------------------
 *
 * The other half of the rule, at room scale. The side chamber's doorway is on a corner, so from
 * anywhere in the main room every straight line into it is stopped by one of the two partitions.
 * Whole-object reveal does not leak through that: an object is surfaced by a sound that *touches*
 * it, and nothing here touches anything in there.
 */
await respawn();
await clearPaint();
const fromMain = await ping('e-ping');
await settleInk(60000);
const chamberBefore = await probeRegion('chamber');
const chamberCrateBefore = await probeRegion('chamberCrate');
await shotBuf('52-blueprint-outside-chamber.png');
console.log(
  `  from the main room: chamber ${chamberBefore.unlocked}/${chamberBefore.dots} dots, ` +
    `crate ${chamberCrateBefore.unlocked}/${chamberCrateBefore.dots}`,
);
check(
  'a beam from the main room leaves the side chamber completely black',
  chamberBefore.unlocked === 0 &&
    chamberBefore.edgesUnlocked === 0 &&
    chamberCrateBefore.unlocked === 0,
  `${chamberBefore.unlocked} of ${chamberBefore.dots} chamber dots and ` +
    `${chamberCrateBefore.unlocked} of ${chamberCrateBefore.dots} crate dots — ` +
    `from a beam that unlocked ${fromMain.structLastDots} dots elsewhere`,
);

/*
 * Walk it: down the lane, through the chokepoint, then north through the chamber's doorway and
 * on up the far side of the full-height pillar at (0.5, 7.0) — which stands squarely on the
 * sight-line from the doorway and shadows the whole of the chamber floor behind it. That is the
 * rule working, not a hole in it, but it makes the doorway itself a bad place to ask the
 * question from, so the beam below is fired from a spot with an actual line down the chamber.
 */
await page.keyboard.down('w');
const pastChoke = await poll((s) => Number(s.x) > -2.6, 25000);
await page.keyboard.up('w');
await wait(200);
await turnTo(180, sens); // +Z
await page.keyboard.down('w');
const inChamberPos = await poll((s) => Number(s.z) > 8.4, 25000);
await page.keyboard.up('w');
await wait(200);
check(
  'the doorway is walkable',
  Number(inChamberPos.z) > 8.4 && Number(pastChoke.x) > -2.6,
  `walked to (${Number(inChamberPos.x).toFixed(2)}, ${Number(inChamberPos.z).toFixed(2)})`,
);
await turnTo(-90, sens); // +X, down the length of the chamber
// Wiped first, so the answer below can only be the one ping fired from inside.
await clearPaint();
const fromInside = await ping('e-ping');
await settleInk(60000);
const chamberAfter = await probeRegion('chamber');
const chamberCrateAfter = await probeRegion('chamberCrate');
const chamberBuf = await shotBuf('53-blueprint-inside-chamber.png');
console.log(
  `  from inside: chamber ${chamberAfter.unlocked}/${chamberAfter.dots} dots ` +
    `(${chamberAfter.edgesInked} contours), crate ${chamberCrateAfter.unlocked}/${chamberCrateAfter.dots}`,
);
check(
  'step through the doorway and one beam hands you the whole chamber',
  chamberAfter.unlocked > 500 &&
    chamberAfter.edgesInked > 0 &&
    chamberCrateAfter.unlocked > chamberCrateAfter.dots * 0.9,
  `${chamberAfter.unlocked} of ${chamberAfter.dots} chamber dots (was ${chamberBefore.unlocked}), ` +
    `${chamberCrateAfter.unlocked} of ${chamberCrateAfter.dots} on the crate (was ${chamberCrateBefore.unlocked}), ` +
    `${chamberAfter.edgesInked} contours inked`,
);
check(
  'and the chamber reads on screen',
  photo(chamberBuf).lit > 0.01,
  `lit=${pct(photo(chamberBuf).lit)} mean=${photo(chamberBuf).mean.toFixed(2)}/255`,
);

/*
 * --- 34d ageing to the skeleton --------------------------------------------
 *
 * §3.6 applies to the drawing exactly as it does to the cloud: the fine read decays, the map
 * does not. Nothing may be *forgotten* by the passage of time — only dimmed to the floor.
 */
await respawn();
await clearPaint();
await ping('q-ping');
await settleInk(60000);
const bpFreshBuf = await shotBuf('54-blueprint-fresh.png');
const bpFresh = photo(bpFreshBuf);
const bpBeforeAge = await state();
await setTimeScale(10);
const bpClock0 = Number((await state()).paintTime);
await poll((s) => Number(s.paintTime) - bpClock0 >= 20, 25000);
await setTimeScale(1);
await wait(250);
const bpAgedBuf = await shotBuf('55-blueprint-aged.png');
const bpAged = photo(bpAgedBuf);
const bpAfterAge = await state();
check(
  'the blueprint cools with age',
  bpAged.mean < bpFresh.mean * 0.75,
  `mean ${bpFresh.mean.toFixed(2)} → ${bpAged.mean.toFixed(2)}/255 over ` +
    `${(Number(bpAfterAge.paintTime) - bpClock0).toFixed(0)} s`,
);
check(
  'and settles on a memory skeleton rather than on nothing',
  bpAged.mean > bpFresh.mean * 0.02 && bpAged.lit > 0.005,
  `mean=${bpAged.mean.toFixed(3)}/255 (${pct(bpAged.mean / bpFresh.mean)} of fresh) lit=${pct(bpAged.lit)}`,
);
check(
  'ageing unlocks nothing and forgets nothing (§3.6)',
  Number(bpAfterAge.structUnlockedDots) === Number(bpBeforeAge.structUnlockedDots) &&
    Number(bpAfterAge.structUnlockedEdges) === Number(bpBeforeAge.structUnlockedEdges),
  `dots ${bpBeforeAge.structUnlockedDots} → ${bpAfterAge.structUnlockedDots}, ` +
    `segments ${bpBeforeAge.structUnlockedEdges} → ${bpAfterAge.structUnlockedEdges}`,
);

/*
 * --- 34d (cont.) the refresh bounds are one policy, not two -------------------
 *
 * The lattice is aged to the skeleton and every dot around the player is known, which is exactly
 * the state §30f is about — so walking on it here answers the same question on the other backend.
 * A footstep has to arrive with the same floor and the same feather it carries into the blip
 * cloud, and its restamps have to be as invisible: one policy, owned by the wave, spent by
 * whichever representation happens to be drawing.
 */
await page.keyboard.down('w');
await wait(700);
await page.keyboard.up('w');
const bpStep = await poll((s) => String(s.lastEvent).endsWith('step'), 8000);
await settleInk(30000);
const bpStepped = await state();
console.log(
  `  blueprint footfall: floor ${Number(bpStepped.structLastFloor).toFixed(2)} s · ` +
    `feather ${Number(bpStepped.structLastFeatherMean).toFixed(3)} · ` +
    `${bpStepped.structLastRefreshed} dots refreshed, ${bpStepped.structLastFloored} of them floored`,
);
check(
  'a footstep bounds the structured refresh exactly as it bounds the cloud',
  String(bpStep.lastEvent).endsWith('step') &&
    Math.abs(Number(bpStepped.structLastFloor) - 2) < 0.01 &&
    Number(bpStepped.structLastFeatherMean) > 0 &&
    Number(bpStepped.structLastFeatherMean) < 1 &&
    Number(bpStepped.structLastRefreshed) > 500 &&
    Number(bpStepped.structLastFloored) > 100,
  `floor ${Number(bpStepped.structLastFloor).toFixed(2)} s (cloud: ` +
    `${Number(bpStepped.lastRefreshFloor).toFixed(2)} s) · mean feather ` +
    `${Number(bpStepped.structLastFeatherMean).toFixed(3)} over ` +
    `${bpStepped.structLastRefreshed} refreshed dots, ${bpStepped.structLastFloored} held at the floor`,
);
check(
  'and its restamps are as invisible there as they are here',
  Number(bpStepped.structLastJump) < 0.02,
  `worst displayed-age discontinuity ${Number(bpStepped.structLastJump).toFixed(4)} s across the ` +
    `whole unlock pass · ${bpStepped.structLastLate} dots the amortised job reached after their ` +
    `front had passed are excluded, worst step ${Number(bpStepped.structLastLateStep).toFixed(2)} s`,
);

/*
 * --- 34e the cost of a reveal ----------------------------------------------
 *
 * Law 5 again, and it bites harder here than on the sampling looks: unlocking a beam's worth of
 * lattice is tens of thousands of point-in-radius tests. It is amortised over frames for the same
 * reason ray sampling is, and the assertion is the same shape — what matters is the worst single
 * frame, not the total.
 */
await respawn();
await clearPaint();
const bpCost = [];
for (let i = 0; i < 6; i++) {
  const s = await ping('e-ping');
  bpCost.push({
    total: Number(s.structLastMs),
    worst: Number(s.structLastChunkMs),
    chunks: Number(s.structLastChunks),
    rays: Number(s.structLastRays),
    dots: Number(s.structLastDots),
  });
}
await settleInk(60000);
const bpStress = await state();
console.log(
  `  blueprint CPU: ${mean(bpCost.map((c) => c.total)).toFixed(1)} ms per beam ` +
    `(${mean(bpCost.map((c) => c.rays)).toFixed(0)} items tested, ${bpCost[0].dots} dots unlocked on the first), ` +
    `spread over ${mean(bpCost.map((c) => c.chunks)).toFixed(1)} frames, ` +
    `worst single frame ${Math.max(...bpCost.map((c) => c.worst)).toFixed(1)} ms`,
);
check(
  'six blueprint beams keep the frame rate up',
  Number(bpStress.fps) > 8,
  `${Number(bpStress.fps).toFixed(1)} fps (software GL) · ` +
    `${bpStress.structUnlockedDots} dots and ${bpStress.structUnlockedEdges} segments known`,
);
const bpWorst = Math.max(...bpCost.map((c) => c.worst));
check(
  'no single frame pays for a whole reveal',
  bpWorst < 16 && bpCost[0].chunks >= 2 && bpCost[0].worst < bpCost[0].total * 0.75,
  `first beam ${bpCost[0].total.toFixed(1)} ms over ${bpCost[0].chunks} frames ` +
    `(worst ${bpCost[0].worst.toFixed(1)} ms) · worst across all six ${bpWorst.toFixed(1)} ms`,
);
check(
  'and unlocking always finishes — nothing is left pending',
  Number(bpStress.structPending) === 0 && Number(bpStress.structPendingEdges) === 0,
  `pending=${bpStress.structPending} pendingEdges=${bpStress.structPendingEdges}`,
);
await shotBuf('56-blueprint-stress.png');

/*
 * --- 34f the spam frame, on the structured look ------------------------------
 *
 * The same acceptance test §32a runs on the sampling looks. The blueprint cannot double up on
 * itself the way a blip cloud can — a dot is unlocked once and drawn once, however many times it
 * is heard — so this is the cheapest of the three to keep quiet, and the number is here as the
 * floor of the comparison rather than as a worry.
 */
await respawn();
await clearPaint();
await ping('q-ping');
await settleInk(60000);
const bpSingle = photo(await shotBuf('56a-spam-blueprint-single.png'));
const bpSpamFrames = [];
for (let i = 0; i < 5; i++) {
  await poll((x) => Number(x.pingCooldown) === 0, 8000);
  const before = Number((await state()).soundEvents);
  await page.keyboard.press(i % 2 === 0 ? 'q' : 'e');
  await poll((x) => Number(x.soundEvents) > before, 8000);
  bpSpamFrames.push(photo(await page.screenshot()));
}
const bpSpam = photo(await shotBuf('56b-spam-blueprint.png'));
const bpPeak = bpSpamFrames.reduce((a, b) => (b.mean > a.mean ? b : a), bpSpam);
console.log(
  `  Blueprint: one ping ${bpSingle.mean.toFixed(2)}/255 → five back to back ` +
    `${bpSpamFrames.map((f) => f.mean.toFixed(1)).join(' ')} · near-white ${pct(bpPeak.hot)} ` +
    `· clipped ${pct(bpPeak.sat)}`,
);
check(
  'Blueprint: five pings back to back stay inside the band',
  bpPeak.mean < 25 && bpPeak.hot < 0.03 && bpPeak.sat < 0.012,
  `peak ${bpPeak.mean.toFixed(2)}/255 (cap 25) · near-white ${pct(bpPeak.hot)} (cap 3.00%) · ` +
    `clipped ${pct(bpPeak.sat)} (cap 1.20%)`,
);
await settleInk(60000);

/*
 * --- 34g switching looks -----------------------------------------------------
 *
 * Two representations exist and only one may ever be live. Switching drops whatever the other
 * one knew, so a look change can neither leave a ghost of the previous look on screen nor paint
 * the same event twice.
 */
await setVariant('1', 'Dust');
await wait(250);
const backToDust = await state();
const dustAfterBp = photo(await shotBuf('57-blueprint-switch-away.png'));
check(
  'switching away from Blueprint takes its drawing with it',
  Number(backToDust.structUnlockedDots) === 0 &&
    Number(backToDust.points) === 0 &&
    dustAfterBp.mean < 2,
  `structDots known=${backToDust.structUnlockedDots} points=${backToDust.points} ` +
    `mean=${dustAfterBp.mean.toFixed(3)}/255`,
);
const dustAgain = await ping('q-ping');
check(
  'and the sampling looks still work afterwards',
  Number(dustAgain.points) > 1000 && Number(dustAgain.structUnlockedDots) === 0,
  `points=${dustAgain.points} · structured dots known=${dustAgain.structUnlockedDots}`,
);
await setVariant('5', 'Blueprint');
await wait(250);
const backToBp = await state();
check(
  'and switching back drops the blips instead',
  Number(backToBp.points) === 0 && Number(backToBp.structUnlockedDots) === 0,
  `points=${backToBp.points} structDots known=${backToBp.structUnlockedDots}`,
);
await setVariant('1', 'Dust');
await clearPaint();

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
