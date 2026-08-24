#!/usr/bin/env node
/**
 * Screenshot driver and smoke suite.
 *
 *   node tools/shoot.mjs [dist/index.html] [outdir]
 *
 * Opens the single-file build over file:// in headless chromium and drives it with real input
 * events only — no teleporting, no state injection. The page exposes a read-only
 * `window.__blindspot.getState()` handle, plus `probe('region', …)` for questions about the world
 * that no amount of state dumping would answer ("how much of the geometry inside this box is
 * known?"). Every assertion is therefore either "the body did the thing" (state), "the room knows
 * what it should and nothing more" (probe) or "the frame looks the way it should" (pixels).
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
const DEFAULT_OUT = process.env.BLINDSPOT_SHOTS ?? 'shots';

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
const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
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
// The build ships as a single file behind a strict CSP: nothing may leave the page.
const externalRequests = [];
page.on('request', (req) => {
  const u = req.url();
  if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')) {
    externalRequests.push(`${req.method()} ${u}`);
  }
});

const shot = async (name) => {
  const buf = await page.screenshot();
  await writeFile(join(outDir, name), buf);
  console.log(`[shoot] wrote ${name}`);
  return buf;
};

/**
 * Measurement windows, in viewport pixels.
 *
 * The only things on screen the renderer did *not* draw are DOM: the HUD panel (top left), the
 * dev panel (right), the title, the hint line and the reticle (centre). FRAME sits clear of all
 * of them except the reticle, which is punched out.
 */
const FRAME = { x: 400, y: 200, w: 600, h: 420 };
const FRAME_HOLES = [{ x: 620, y: 340, w: 40, h: 40 }];
/** The near floor: where a footstep's reveal lands when you are looking straight ahead. */
const FLOOR_BAND = { x: 300, y: 430, w: 700, h: 190 };
/** Everything the renderer drew, minus the DOM — wide enough to take in a whole room read. */
const CANVAS = { x: 360, y: 40, w: 650, h: 600 };

/**
 * Mean luminance (0-255) and lit fraction of a screenshot over a DOM-free window.
 *
 * `hot` and `sat` are the top of the same histogram: how much of the window is near the ceiling
 * of the 8-bit framebuffer, and how much has hit it. The reveal is drawn with additive blending
 * onto an LDR target, so those two are the only way to see the failure mode brightness tuning
 * exists to prevent — a frame that is not brighter so much as *clipped*.
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
const hues = (buf, rect = CANVAS) => hueFamilies(decodePng(buf), rect);

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const wait = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__blindspot.getState());
const spread = (values) => Math.max(...values) - Math.min(...values);
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

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
 * Polls the live state until `pred` holds (or the budget runs out).
 *
 * Headless software rendering only manages 5-20 fps, so anything shorter than ~200 ms of sim —
 * a jump arc, a respawn — has to be caught by polling rather than by sleeping a fixed amount.
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
 * View effects (head bob, the landing dip) live on the render camera, and a driver-side poll
 * adds a CDP round-trip per sample. Sampling in a rAF loop instead pins the sample rate to the
 * actual frame rate, which is the best any observer can do.
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
            boom: s.boom,
          });
          // The window is a duration *and* a frame count: a 700 ms window that returned two
          // samples is not a short measurement of the thing, it is no measurement of the thing.
          const enough = t >= duration && out.length >= wanted;
          if (!enough && t < duration * 4 + 2000) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
    [ms, minFrames],
  );
}

/**
 * Turns the view by dragging — the pointer-lock-free look path.
 *
 * A 90° turn is ~750 px at the default sensitivity, which does not fit in a 1280 px viewport
 * starting from the centre, so the gesture is split into chunks that each stay on screen. Every
 * chunk is its own press/drag/release and the look handler measures per-gesture deltas, so the
 * rotations simply add up.
 */
async function dragLook(degrees, sensitivity) {
  const total = degrees / sensitivity;
  const dir = Math.sign(total) || 1;
  const maxChunk = 600;
  let remaining = Math.abs(total);
  while (remaining > 0.5) {
    const chunk = Math.min(remaining, maxChunk);
    const startX = 640 - (dir * chunk) / 2;
    await page.mouse.move(startX, 360);
    await page.mouse.down();
    for (let i = 1; i <= 16; i++) {
      await page.mouse.move(startX + (dir * chunk * i) / 16, 360);
      await wait(6);
    }
    await page.mouse.up();
    await wait(40);
    remaining -= chunk;
  }
}

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

/** Yaw, in the controller's convention, that points from one XZ spot at another. */
const yawTo = (fromX, fromZ, toX, toZ) =>
  (Math.atan2(-(toX - fromX), -(toZ - fromZ)) * 180) / Math.PI;

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
  await wait(80); // one more frame, so velocity readings are the post-respawn ones
}

/**
 * Waits for a ping to have finished happening.
 *
 * Two things outlive the keystroke. The front takes travel time to cross the room, and geometry
 * is invisible until it reaches it; and unlocking is amortised over several frames, so the far
 * half of a beam lands well after it was fired. A screenshot taken before both are done is a
 * picture of a ping in progress — a fine thing to assert on deliberately (see "one front"), and
 * a terrible thing to assert on by accident.
 */
const settle = (budgetMs = 12000) =>
  poll((s) => s.waveLive === false && Number(s.structPending) === 0, budgetMs);

/**
 * ...and for the contour strokes as well. They start at the front rather than a phase behind it,
 * but a stroke still takes `inkSeconds` to draw itself, so the last few are still going when the
 * wave stops.
 */
async function settleInk(budgetMs = 40000) {
  await settle(budgetMs);
  return poll((s) => Number(s.structPendingEdges) === 0, budgetMs);
}

/**
 * Fires a ping and waits for the bus to have delivered it.
 *
 * Waits out the shared cooldown first. A ping pressed while the previous one is still cooling is
 * refused by design, and a refused ping would otherwise surface much later as a mystery: stale,
 * zeroed statistics belonging to whatever event actually landed last.
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
  await wait(180); // one more frame, so the screenshot has the new geometry in it
  return state();
}

/** Empties the map and waits for it to actually be empty. */
async function clearMap() {
  await page.keyboard.press('k');
  await poll((s) => Number(s.structUnlockedDots) === 0, 4000);
}

/** Counts what the reveal knows inside one of the room's named world boxes. */
const probeRegion = (region) =>
  page.evaluate((r) => window.__blindspot.probe('region', { region: r }), region);

/**
 * Cycles the paint clock's debug multiplier (T: ×1 → ×0.1 → ×10 → ×60) until it reads `target`.
 *
 * One press per rung, each confirmed before the next: key presses are edge-triggered per sim
 * tick, so two presses inside one tick collapse into one and the scale silently lands wrong.
 */
async function setTimeScale(target) {
  for (let i = 0; i < 5; i++) {
    const before = Number((await state()).paintTimeScale);
    if (before === target) return;
    await page.keyboard.press('t');
    await poll((s) => Number(s.paintTimeScale) !== before, 3000);
  }
  const s = await state();
  check(`paint clock reached x${target}`, Number(s.paintTimeScale) === target, `x${s.paintTimeScale}`);
}

const setReveal = async (on) => {
  if ((await state()).reveal === on) return;
  await page.keyboard.press('l');
  await poll((s) => s.reveal === on, 3000);
  await wait(200);
};

// `?look=drag` pins the build to the drag-look fallback: pointer lock is unreliable in headless
// chromium, and this is the path the screenshots are meant to prove works.
const url = `${pathToFileURL(htmlPath).href}?look=drag`;
console.log(`[shoot] ${url}`);
await page.goto(url);
await page.waitForFunction(() => window.__blindspot !== undefined, null, { timeout: 15000 });
// The lattice is precomputed at boot, which is the one hitch the game deliberately takes up
// front rather than on the first ping.
await poll((s) => s.structBuilt === true, 30000);
await wait(500);

const loaded = await state();
const sens = Number(loaded.sensitivity);
console.log('[shoot] initial state', JSON.stringify(loaded));

// ===========================================================================
//  01  the game boots into the dark
// ===========================================================================
check('renderer running', Number(loaded.fps) > 0, `fps=${Number(loaded.fps).toFixed(1)}`);
check(
  'the reveal lattice is precomputed at boot',
  loaded.structBuilt === true && Number(loaded.structDots) > 10000,
  `${Number(loaded.structDots).toLocaleString('en-US')} dots · ` +
    `${Number(loaded.structEdges).toLocaleString('en-US')} segments · ` +
    `${(Number(loaded.structBytes) / 1e6).toFixed(2)} MB · built in ${Number(loaded.structBuildMs).toFixed(0)} ms`,
);
check(
  'nothing is known until something is heard',
  Number(loaded.structUnlockedDots) === 0 && Number(loaded.structUnlockedEdges) === 0,
  `${loaded.structUnlockedDots} dots / ${loaded.structUnlockedEdges} lines known`,
);
check(
  'the game owns the hint line',
  (await page.textContent('.bs-hint')).includes('Q ping · E beam · L reveal'),
  await page.textContent('.bs-hint'),
);

const darkBuf = await shot('01-dark.png');
const dark = photo(darkBuf);
// Law 3: absence is black. Nothing but what sound found may put light on the screen, so with
// nothing heard the frame has to be *actually* black, not nearly black.
check(
  'an unheard room is not drawn (law 3: absence is black)',
  dark.mean < 2 && dark.lit < 0.005,
  `mean=${dark.mean.toFixed(3)}/255 lit=${pct(dark.lit)} with ${loaded.structDots} dots in memory`,
);

// ===========================================================================
//  02  movement
//
//  Law 5: movement stays genuinely good. These run with the debug lights on, because a
//  screenshot of a body moving through a black room is a screenshot of a black room; the
//  assertions themselves are state and do not care either way.
// ===========================================================================
await setReveal(true);

// --- look ------------------------------------------------------------------
const beforeLook = await state();
await dragLook(90, sens);
await wait(250);
const afterLook = await state();
let dYaw = Number(afterLook.yawDeg) - Number(beforeLook.yawDeg);
while (dYaw > 180) dYaw -= 360;
while (dYaw < -180) dYaw += 360;
// Magnitude only: dragging right *lowers* yaw in the controller's convention, and which way
// round that is is a matter for the sensitivity sign, not for this check.
check(
  'dragging turns the view',
  Math.abs(Math.abs(dYaw) - 90) < 6,
  `look=${afterLook.lookMode}, yaw moved ${dYaw.toFixed(1)}°`,
);
await respawn();

// --- walk / sprint / crouch -------------------------------------------------
for (const [label, keys, want, tol] of [
  ['walk', ['w'], 3.5, 0.35],
  ['sprint', ['Shift', 'w'], 6.0, 0.5],
  ['crouch', ['c', 'w'], 1.7, 0.3],
]) {
  await respawn();
  await page.keyboard.down(keys[keys.length - 1]);
  for (const k of keys.slice(0, -1)) await page.keyboard.down(k);
  const top = await poll((s) => Number(s.speed) > want - tol, 4000);
  const held = await state();
  for (const k of keys) await page.keyboard.up(k);
  await wait(150);
  check(
    `${label} reaches ${want} m/s`,
    Math.abs(Number(held.speed) - want) < tol,
    `${Number(held.speed).toFixed(2)} m/s (peak ${Number(top.speed).toFixed(2)}), stance=${held.stance}`,
  );
}
// Crouch is a stance, not just a speed: the eye drops half a metre.
await respawn();
const standing = await state();
await page.keyboard.down('c');
const crouched = await poll((s) => s.stance === 'crouch', 3000);
await wait(250);
const crouchedCam = await state();
await page.keyboard.up('c');
check(
  'crouching lowers the eye',
  crouched.stance === 'crouch' && Number(standing.camY) - Number(crouchedCam.camY) > 0.35,
  `camY ${Number(standing.camY).toFixed(2)} → ${Number(crouchedCam.camY).toFixed(2)} m`,
);

// --- jump -------------------------------------------------------------------
// Down the spawn heading: clear floor to the chokepoint doorway, which is more than the run-up
// plus the whole arc. Space is *held*, not tapped — a tap is cut short on release by design and
// only clears a quarter of a metre, which is not the jump being measured here.
await respawn();
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await poll((s) => Number(s.speed) > 5, 4000);
await page.keyboard.down('Space');
// The arc is a handful of headless frames, so poll it rather than sleeping and hoping.
let apex = 0;
let sawAir = false;
let landed = null;
const jumpDeadline = Date.now() + 4000;
while (Date.now() < jumpDeadline) {
  const s = await state();
  apex = Math.max(apex, Number(s.y));
  if (s.grounded === false) sawAir = true;
  else if (sawAir) {
    landed = s;
    break;
  }
}
await page.keyboard.up('Space');
await page.keyboard.up('w');
await page.keyboard.up('Shift');
await wait(250);
check(
  'a running jump leaves the ground',
  sawAir && apex > 0.6,
  `apex ${apex.toFixed(2)} m (jumpVelocity 5.4 at gravity 16 is 0.91 m)`,
);
check(
  'and lands again',
  landed !== null,
  landed === null ? 'never came down inside 4 s' : `y=${Number(landed.y).toFixed(3)} m`,
);

// --- head bob and the landing dip -------------------------------------------
await respawn();
await page.keyboard.down('w');
const bob = await sampleFrames(1400, 10);
await page.keyboard.up('w');
const bobbing = bob.filter((f) => f.speed > 2);
check(
  'the camera bobs while walking',
  bobbing.length > 5 && spread(bobbing.map((f) => f.camY)) > 0.01,
  `${spread(bobbing.map((f) => f.camY)).toFixed(4)} m of camY spread over ${bobbing.length} moving frames`,
);
check(
  'and footsteps come out of that stride',
  Number(bob[bob.length - 1].steps) > Number(bob[0].steps),
  `${bob[0].steps} → ${bob[bob.length - 1].steps} steps`,
);

// --- collision ---------------------------------------------------------------
await respawn();
await turnTo(90, sens); // -X, into the west wall
await hold(['w'], 2500);
await wait(200);
const stopped = await state();
check(
  'the wall stops the body',
  Number(stopped.x) > -15 && Number(stopped.x) < -14,
  `stopped at x=${Number(stopped.x).toFixed(2)} (wall face at -15, body radius 0.35)`,
);

// --- stairs -------------------------------------------------------------------
// The flight rises in +X across z ∈ [-9.4, -5.8], so the walk is two legs: out to its low end
// (a diagonal that clears the crate at (-11.5, -3.5)), then straight up it.
await respawn();
const atSpawnForStairs = await state();
await turnTo(yawTo(Number(atSpawnForStairs.x), Number(atSpawnForStairs.z), -14.2, -7.5), sens);
await page.keyboard.down('w');
const atFoot = await poll((s) => Number(s.z) < -7.0, 15000);
await page.keyboard.up('w');
await wait(200);
check(
  'the foot of the stairs is reachable',
  Number(atFoot.z) < -7.0 && Number(atFoot.x) < -13.5,
  `at (${Number(atFoot.x).toFixed(2)}, ${Number(atFoot.z).toFixed(2)})`,
);
await turnTo(-90, sens); // +X, up the flight
await page.keyboard.down('w');
// Poll for the deck rather than holding a fixed time: the deck ends at x = -5.2, and a walk
// long enough to be safe on a slow host is a walk that steps off the end of it and falls.
const climbed = await poll((s) => Number(s.y) > 2.4, 10000);
await page.keyboard.up('w');
await wait(250);
check(
  'the flight is walkable up to its deck',
  Number(climbed.y) > 2.0,
  `walked up to y=${Number(climbed.y).toFixed(2)} m at (${Number(climbed.x).toFixed(1)}, ` +
    `${Number(climbed.z).toFixed(1)}) — nine 0.28 m risers to a 2.52 m deck`,
);

// --- mantle --------------------------------------------------------------------
// The 1 m test crate, which is a low vault: run at it and press Space at the wall.
await respawn();
const atSpawnForCrate = await state();
await turnTo(yawTo(Number(atSpawnForCrate.x), Number(atSpawnForCrate.z), -9.0, -3.2), sens);
await page.keyboard.down('w');
await poll((s) => Math.hypot(Number(s.x) + 9.0, Number(s.z) + 3.2) < 1.4, 12000);
await page.keyboard.press('Space');
const onCrate = await poll((s) => Number(s.y) > 0.9, 5000);
await page.keyboard.up('w');
await wait(250);
check(
  'a 1 m crate is vaulted, not bumped into',
  Number(onCrate.y) > 0.9,
  `feet at y=${Number(onCrate.y).toFixed(2)} m on a 1.0 m box`,
);

// --- third person ----------------------------------------------------------------
await respawn();
await page.keyboard.press('v');
const third = await poll((s) => Number(s.viewBlend) > 0.99, 5000);
await wait(250);
const thirdBuf = await shot('02-third-person.png');
check(
  'V pulls the camera out to a boom',
  third.view === 'third' && Number(third.boom) > 1.5,
  `boom ${Number(third.boom).toFixed(2)} m of a ${Number(third.boomRest).toFixed(2)} m rest length`,
);
check('and the lit view still draws', photo(thirdBuf).lit > 0.3, `lit=${pct(photo(thirdBuf).lit)}`);
await page.keyboard.press('v');
await poll((s) => Number(s.viewBlend) < 0.01, 5000);

const revealBuf = await shot('03-reveal.png');
const reveal = photo(revealBuf);
check(
  'the debug reveal shows the room the sonar has to find',
  reveal.mean > 40 && reveal.lit > 0.5,
  `mean=${reveal.mean.toFixed(1)}/255 lit=${pct(reveal.lit)}`,
);
await setReveal(false);

// ===========================================================================
//  03  the reveal: sound draws the room
// ===========================================================================
await respawn();
await clearMap();

// --- footsteps ---------------------------------------------------------------
// Eyes down, the way you walk in the dark. A footstep reveals a 4 m puddle around the sole, and
// at a level gaze that puddle lives in the bottom sliver of the frame.
await pitchBy(-22, sens);
check(
  'looking down at the floor ahead',
  Math.abs(Number((await state()).pitchDeg) + 22) < 3,
  `pitch=${Number((await state()).pitchDeg).toFixed(1)}°`,
);
await page.keyboard.down('w');
await wait(2200);
const walkBuf = await shot('04-footsteps.png');
const walking = await state();
await page.keyboard.up('w');
await wait(250);
check(
  'walking draws the floor',
  Number(walking.structUnlockedDots) > 500 && String(walking.lastEvent).endsWith('step'),
  `${walking.structUnlockedDots} dots known · lastEvent=${walking.lastEvent} · ` +
    `${walking.structLastDots} dots / ${walking.structLastEdges} lines off the last one`,
);
const walkShot = photo(walkBuf, FLOOR_BAND, []);
check(
  'the footstep trail is visible in front of the player',
  walkShot.mean > 0.5 && walkShot.lit > 0.02,
  `floor band mean=${walkShot.mean.toFixed(3)}/255 lit=${pct(walkShot.lit)}`,
);

// --- Q ping: the room read -----------------------------------------------------
await respawn();
await clearMap();
await pitchBy(12, sens);
const qState = await ping('q-ping');
await settleInk(60000);
const qBuf = await shot('05-q-ping.png');
const q = photo(qBuf);
check(
  'the Q ping reads the room',
  Number(qState.structLastDots) > 2000 && Number(qState.structLastEdges) > 100,
  `${qState.structLastRays} items tested → ${qState.structLastDots} dots and ` +
    `${qState.structLastEdges} segments in ${Number(qState.structLastMs).toFixed(1)} ms`,
);
check(
  'the room read lights the frame',
  q.mean > 1 && q.lit > 0.02,
  `mean=${q.mean.toFixed(2)}/255 lit=${pct(q.lit)}`,
);
// §3.2, on a frame whose contours have finished flashing: the matter layer is cyan, and only
// cyan, whatever the surface is made of.
const qHue = hues(qBuf);
check(
  'a settled drawing is cyan-family, always (§3.2)',
  qHue.coolFraction > 0.8 && qHue.warmFraction < 0.02,
  `cool=${pct(qHue.coolFraction)} warm=${pct(qHue.warmFraction)} of ${qHue.lit} lit px`,
);

/*
 * --- bloom -----------------------------------------------------------------------
 *
 * This is the one path the headless run would otherwise never take. Bloom is what a real GPU
 * boots with, and software GL vetoes it — so without pressing B here, `renderFrame` returns
 * false on every frame of the suite and the composer is never even constructed. The room is
 * already drawn, so the pair below is the same picture through the two paths.
 */
const bloomOff = photo(qBuf);
await page.keyboard.press('b');
await poll((s) => s.bloom === true, 4000);
await wait(400);
const bloomBuf = await shot('05b-bloom.png');
const bloomOn = photo(bloomBuf);
check(
  'B takes the frame through the bloom chain',
  (await state()).bloom === true && bloomOn.lit > bloomOff.lit,
  `lit ${pct(bloomOff.lit)} → ${pct(bloomOn.lit)}, mean ${bloomOff.mean.toFixed(2)} → ` +
    `${bloomOn.mean.toFixed(2)}/255 (halo spreads light into pixels the raw path leaves black)`,
);
check(
  'and does not re-grade it: bloom adds a halo, it does not clip the picture',
  bloomOn.sat < 0.02 && hues(bloomBuf).warmFraction < 0.02,
  `saturated=${pct(bloomOn.sat)} hot=${pct(bloomOn.hot)} warm=${pct(hues(bloomBuf).warmFraction)}`,
);
await page.keyboard.press('b');
await poll((s) => s.bloom === false, 4000);
await wait(250);

// --- the shared cooldown (§3.5) --------------------------------------------------
// Fired back to back with no waiting in between, so the test does not depend on how long a
// software-GL screenshot happens to take.
await poll((s) => Number(s.pingCooldown) === 0, 4000);
const beforeCooldown = Number((await state()).soundEvents);
await page.keyboard.press('q');
await page.keyboard.press('e');
await poll((s) => Number(s.soundEvents) > beforeCooldown, 4000);
await wait(200);
const cooling = await state();
check(
  'a second ping inside the 0.75 s cooldown is refused',
  Number(cooling.soundEvents) === beforeCooldown + 1 && cooling.lastEvent === 'q-ping',
  `soundEvents ${beforeCooldown} → ${cooling.soundEvents}, lastEvent=${cooling.lastEvent}`,
);

// --- E beam: the 22 m look-around -------------------------------------------------
await respawn();
await clearMap();
const eState = await ping('e-ping');
await settleInk(60000);
const eBuf = await shot('06-e-beam.png');
check(
  'the beam fires once the cooldown expires',
  Number(eState.soundEvents) === beforeCooldown + 2,
  `soundEvents=${eState.soundEvents} lastEvent=${eState.lastEvent}`,
);
check(
  'the beam is a real question: it costs rays and it answers with geometry',
  Number(eState.structLastDots) > 1000 && Number(eState.structLastRays) > 1000,
  `${eState.structLastRays} items tested → ${eState.structLastDots} dots and ` +
    `${eState.structLastEdges} segments · ${Number(eState.eConeDeg)}° × ${Number(eState.eRange)} m`,
);
check('the beam is visible', photo(eBuf).lit > 0.01, `lit=${pct(photo(eBuf).lit)}`);

// ===========================================================================
//  04  propagation: an object surfaces whole, and a room with no path stays black
// ===========================================================================

// --- whole object ------------------------------------------------------------------
// A sampling renderer draws the faces its rays happen to strike, so a crate you have walked all
// the way around is still a set of unrelated patches. Here, hearing *any* face of an object
// hands you the object. The proof needs both halves: the crate's far side must come back from a
// ping that can only have touched its near side, and something with no sound path to it must
// stay black in the same breath, or "whole object" would just be "everything".
await respawn();
await clearMap();
const regions = (await state()).probeRegions;
const crateX = (regions.crateFront[0] + regions.crateBack[3]) / 2;
const crateZ = (regions.crateFront[2] + regions.crateFront[5]) / 2;
const atSpawn = await state();
await turnTo(yawTo(Number(atSpawn.x), Number(atSpawn.z), crateX, crateZ), sens);
await ping('e-ping');
await settleInk(60000);
const crateFront = await probeRegion('crateFront');
const crateBack = await probeRegion('crateBack');
const crateBuf = await shot('07-whole-object.png');
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
check('the crate reads on screen', photo(crateBuf).lit > 0.005, `lit=${pct(photo(crateBuf).lit)}`);

// --- two walls and no path -----------------------------------------------------------
// The side chamber's doorway is on a corner, so from anywhere in the main room every straight
// line into it is stopped by one of the two partitions. Whole-object reveal does not leak
// through that: an object is surfaced by a sound that *touches* it, and nothing here touches
// anything in there.
await respawn();
await clearMap();
const fromMain = await ping('e-ping');
await settleInk(60000);
const chamberBefore = await probeRegion('chamber');
const chamberCrateBefore = await probeRegion('chamberCrate');
await shot('08-outside-the-chamber.png');
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
    `${chamberCrateBefore.unlocked} of ${chamberCrateBefore.dots} crate dots — from a beam that ` +
    `unlocked ${fromMain.structLastDots} dots elsewhere`,
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
const inChamber = await poll((s) => Number(s.z) > 8.4, 25000);
await page.keyboard.up('w');
await wait(200);
check(
  'the doorway is walkable',
  Number(inChamber.z) > 8.4 && Number(pastChoke.x) > -2.6,
  `walked to (${Number(inChamber.x).toFixed(2)}, ${Number(inChamber.z).toFixed(2)})`,
);
await turnTo(-90, sens); // +X, down the length of the chamber
// Wiped first, so the answer below can only be the one ping fired from inside.
await clearMap();
await ping('e-ping');
await settleInk(60000);
const chamberAfter = await probeRegion('chamber');
const chamberCrateAfter = await probeRegion('chamberCrate');
const chamberBuf = await shot('09-inside-the-chamber.png');
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
    `${chamberCrateAfter.unlocked} of ${chamberCrateAfter.dots} on the crate (was ` +
    `${chamberCrateBefore.unlocked}), ${chamberAfter.edgesInked} contours inked`,
);
check('and the chamber reads on screen', photo(chamberBuf).lit > 0.005, `lit=${pct(photo(chamberBuf).lit)}`);

// ===========================================================================
//  05  one front, and the drawing happens at it
//
//  The ring *is* the front: it displaces and burns the lattice as it passes, and a contour
//  starts drawing itself the moment the front reaches it. Everything is asserted where the front
//  is, not globally, because near the origin the drawing has long finished by the time the ring
//  is out at the doorjamb — which is what "at the front" means. The clock runs at ×0.1 so a
//  0.48 s crossing is five seconds of wall time.
// ===========================================================================
await respawn();
await clearMap();
await setTimeScale(0.1);
await poll((s) => Number(s.pingCooldown) === 0, 8000);
const beforeFront = Number((await state()).soundEvents);
await page.keyboard.press('q');
await poll((s) => Number(s.soundEvents) > beforeFront && s.lastEvent === 'q-ping', 8000);

let inFlight = null;
let jambAtRing = null;
let dotFront = Number.NaN;
let inkFront = Number.NaN;
// Bounded by wall time, not by an iteration count: a state read plus a region probe is a few
// milliseconds and the front takes five seconds to cross, so a count large enough on one host
// is a count that gives up halfway on the next.
const frontDeadline = Date.now() + 60000;
while (Date.now() < frontDeadline) {
  const s = await state();
  const j = await probeRegion('jamb');
  const front = s.waveLive === true ? Number(s.waveFront) : Number(s.waveRange);
  if (Number.isNaN(dotFront) && j.drawn > 20) dotFront = front;
  if (Number.isNaN(inkFront) && j.edgesInked > 0) inkFront = front;
  if (inFlight === null && Number(s.waveFront) >= 9.8 && s.waveLive === true) {
    inFlight = s;
    jambAtRing = j;
    await shot('10-at-the-front.png');
  }
  if (!Number.isNaN(inkFront) && inFlight !== null) break;
  if (s.waveLive !== true) break;
}
if (inFlight === null) {
  // The loop should always have caught the front mid-room; if it somehow did not, take the
  // sample anyway so the checks below fail on their own terms rather than on a null.
  inFlight = await state();
  jambAtRing = await probeRegion('jamb');
  await shot('10-at-the-front.png');
}
console.log(
  `  front=${Number(inFlight.waveFront).toFixed(2)} m: jamb ${jambAtRing.drawn}/${jambAtRing.dots} dots drawn, ` +
    `${jambAtRing.edgesUnlocked} segments unlocked, ${jambAtRing.edgesInked} inked · ` +
    `${inFlight.structInkedEdges}/${inFlight.structUnlockedEdges} inked room-wide, ` +
    `${inFlight.structPendingEdges} mid-stroke · ripple max ` +
    `${(Number(inFlight.structRippleMax) * 100).toFixed(1)} cm on ${inFlight.structRippling} dots`,
);
check(
  'the ring reaches the doorjamb and lights its lattice',
  jambAtRing.drawn > 20 && jambAtRing.unlocked > 20,
  `${jambAtRing.drawn} of ${jambAtRing.dots} dots drawn at the jamb, front at ` +
    `${Number(inFlight.waveFront).toFixed(2)} m`,
);
check(
  'contours ink as the front passes them, not a phase later',
  Number.isFinite(inkFront) && Number.isFinite(dotFront) && inkFront - dotFront < 2.5,
  `the jamb's lattice lit with the front at ${dotFront.toFixed(2)} m and its first contour was ` +
    `whole at ${inkFront.toFixed(2)} m — ${(inkFront - dotFront).toFixed(2)} m of lag, against ` +
    `${(Number(inFlight.structInkSeconds) * 25).toFixed(2)} m for one ` +
    `${inFlight.structInkSeconds} s stroke`,
);
check(
  'the ring displaces the lattice it is passing through',
  Number(inFlight.structRippling) > 0 && Number(inFlight.structRippleMax) > 0.001,
  `${inFlight.structRippling} dots displaced, worst ` +
    `${(Number(inFlight.structRippleMax) * 100).toFixed(1)} cm of a ` +
    `${(Number(inFlight.structRipple) * 100).toFixed(1)} cm amplitude`,
);
await settleInk(60000);
await setTimeScale(1);

// ===========================================================================
//  06  age: the fine read decays, the map does not (§3.6)
// ===========================================================================
await respawn();
await clearMap();
await ping('q-ping');
await settleInk(60000);
const freshBuf = await shot('11-fresh.png');
const fresh = photo(freshBuf);
const beforeAge = await state();

// The paint clock has a debug multiplier on T so ageing can be watched without waiting a
// minute for it. Poll the clock rather than sleeping a guessed amount.
await setTimeScale(10);
const clock0 = Number((await state()).paintTime);
await poll((s) => Number(s.paintTime) - clock0 >= 20, 25000);
await setTimeScale(1);
await wait(250);
const agedBuf = await shot('12-aged.png');
const aged = photo(agedBuf);
const afterAge = await state();
check(
  'what was heard cools with age',
  aged.mean < fresh.mean * 0.75,
  `mean ${fresh.mean.toFixed(2)} → ${aged.mean.toFixed(2)}/255 over ` +
    `${(Number(afterAge.paintTime) - clock0).toFixed(0)} s`,
);
check(
  'and settles on a memory skeleton rather than on nothing',
  aged.mean > fresh.mean * 0.02 && aged.lit > 0.005,
  `mean=${aged.mean.toFixed(3)}/255 (${pct(aged.mean / fresh.mean)} of fresh) lit=${pct(aged.lit)}`,
);
check(
  'ageing unlocks nothing and forgets nothing (§3.6)',
  Number(afterAge.structUnlockedDots) === Number(beforeAge.structUnlockedDots) &&
    Number(afterAge.structUnlockedEdges) === Number(beforeAge.structUnlockedEdges),
  `dots ${beforeAge.structUnlockedDots} → ${afterAge.structUnlockedDots}, ` +
    `segments ${beforeAge.structUnlockedEdges} → ${afterAge.structUnlockedEdges}`,
);

// --- the refresh bounds ---------------------------------------------------------
// The lattice is aged to the skeleton and every dot around the player is known, which is the
// state the footstep policy is about: a footfall may only walk the age back to the end of the
// white band (`stepFloor`), and only fully in the middle of its own radius (`featherStart`), and
// the restamp itself must be invisible — the displayed age may not jump.
await page.keyboard.down('w');
await wait(700);
await page.keyboard.up('w');
const stepped = await poll((s) => String(s.lastEvent).endsWith('step'), 8000);
await settleInk(30000);
const afterStep = await state();
console.log(
  `  footfall: floor ${Number(afterStep.structLastFloor).toFixed(2)} s · ` +
    `feather ${Number(afterStep.structLastFeatherMean).toFixed(3)} · ` +
    `${afterStep.structLastRefreshed} dots refreshed, ${afterStep.structLastFloored} of them floored`,
);
check(
  'a footstep refreshes known ground under a floor and a feather',
  String(stepped.lastEvent).endsWith('step') &&
    Math.abs(Number(afterStep.structLastFloor) - Number(afterStep.refreshFloor)) < 0.01 &&
    Number(afterStep.structLastFeatherMean) > 0 &&
    Number(afterStep.structLastFeatherMean) < 1 &&
    Number(afterStep.structLastRefreshed) > 500 &&
    Number(afterStep.structLastFloored) > 100,
  `floor ${Number(afterStep.structLastFloor).toFixed(2)} s · mean feather ` +
    `${Number(afterStep.structLastFeatherMean).toFixed(3)} over ` +
    `${afterStep.structLastRefreshed} refreshed dots, ${afterStep.structLastFloored} held at the floor`,
);
check(
  'and the restamp is invisible: no age discontinuity on screen',
  Number(afterStep.structLastJump) < 0.02,
  `worst displayed-age step ${Number(afterStep.structLastJump).toFixed(4)} s across the whole ` +
    `unlock pass · ${afterStep.structLastLate} dots the amortised job reached after their front ` +
    `had passed are excluded, worst step ${Number(afterStep.structLastLateStep).toFixed(2)} s`,
);

// --- K forgets everything ----------------------------------------------------------
await clearMap();
await wait(250);
const cleared = await state();
const clearedBuf = await shot('13-cleared.png');
check(
  'K forgets the map and the room goes black again',
  Number(cleared.structUnlockedDots) === 0 && photo(clearedBuf).lit < 0.005,
  `${cleared.structUnlockedDots} dots known, lit=${pct(photo(clearedBuf).lit)}`,
);

// ===========================================================================
//  07  cost
//
//  Law 5 again: unlocking a beam's worth of lattice is tens of thousands of point-in-radius
//  tests, so it is amortised over frames. What matters is the worst single frame, not the total
//  — the total is only ever felt one frame at a time.
// ===========================================================================
await respawn();
await clearMap();
const cost = [];
for (let i = 0; i < 6; i++) {
  const s = await ping('e-ping');
  cost.push({
    total: Number(s.structLastMs),
    worst: Number(s.structLastChunkMs),
    chunks: Number(s.structLastChunks),
    rays: Number(s.structLastRays),
    dots: Number(s.structLastDots),
  });
}
await settleInk(60000);
const stressed = await state();
console.log(
  `  ${mean(cost.map((c) => c.total)).toFixed(1)} ms per beam ` +
    `(${mean(cost.map((c) => c.rays)).toFixed(0)} items tested, ${cost[0].dots} dots unlocked on the ` +
    `first), spread over ${mean(cost.map((c) => c.chunks)).toFixed(1)} frames, worst single frame ` +
    `${Math.max(...cost.map((c) => c.worst)).toFixed(1)} ms`,
);
check(
  'six beams back to back keep the frame rate up',
  Number(stressed.fps) > 3 && Math.max(...cost.map((c) => c.worst)) < 60,
  `fps=${Number(stressed.fps).toFixed(1)} on software GL, worst chunk ` +
    `${Math.max(...cost.map((c) => c.worst)).toFixed(1)} ms`,
);
const stressBuf = await shot('14-six-beams.png');
const stress = photo(stressBuf);
check(
  'and the picture stays inside the framebuffer instead of clipping',
  stress.sat < 0.02,
  `mean=${stress.mean.toFixed(2)}/255 lit=${pct(stress.lit)} hot=${pct(stress.hot)} saturated=${pct(stress.sat)}`,
);

// ===========================================================================
//  report
// ===========================================================================
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
  console.error(
    `\n[shoot] FAILED — ${failures.length} assertion(s), ${consoleErrors.length} console error(s)`,
  );
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n[shoot] OK — screenshots in ${outDir}`);
