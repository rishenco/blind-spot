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
 * The driver owns the clock: it holds the display clock still and advances the simulation by
 * exact numbers of fixed ticks (`stepTicks`), so a screenshot is a photograph of a named instant
 * rather than of whatever a busy machine managed in 800 ms. See "Pacing" below for why, and §07
 * for the one measurement that is deliberately still made against the wall clock.
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
  // Two frames, so the picture is of the tick that was just stepped rather than of the one the
  // compositor had already presented. Cheap here and worth being sure about: the whole point of
  // stepping is that a screenshot names an instant.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const buf = await page.screenshot();
  const s = await state();
  await writeFile(join(outDir, name), buf);
  console.log(`[shoot] wrote ${name} at tick ${s.simTicks}`);
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
/**
 * Counts the pixels two screenshots disagree about inside `rect`, and by how much at worst.
 *
 * `rect` is FRAME rather than CANVAS for the same reason the measurements use it: FRAME is the
 * window with no DOM in it, and the HUD prints a frame rate. Two runs that draw the byte-identical
 * picture still disagree over the ~100 pixels that spell "9.1" — measured, and the whole of the
 * difference between two runs' screenshots outside §07.
 */
function pixelDiff(a, b, rect = FRAME) {
  const x = decodePng(a);
  const y = decodePng(b);
  let pixels = 0;
  let worst = 0;
  for (let row = rect.y; row < rect.y + rect.h; row++) {
    for (let col = rect.x; col < rect.x + rect.w; col++) {
      const i = (row * x.width + col) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(x.data[i + c] - y.data[i + c]));
      if (d > 0) pixels++;
      if (d > worst) worst = d;
    }
  }
  return { pixels, of: rect.w * rect.h, worst };
}

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const wait = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__blindspot.getState());
const spread = (values) => Math.max(...values) - Math.min(...values);
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/*
 * ===========================================================================
 *  Pacing: the suite's unit of time is the tick, not the millisecond
 * ===========================================================================
 *
 * `core/loop.ts` drops any frame longer than 0.25 s rather than banking it, so under software GL
 * — where frames routinely run longer than that — the amount of *simulated* time behind a given
 * `await wait(800)` is a fact about how busy the machine was. Screenshots taken that way are
 * pictures of an unknown instant, which is why this suite used to drift on most of its
 * assertions across runs of byte-identical builds.
 *
 * So the driver stops the display clock (`stepTicks` suspends it on first use) and asks for
 * exact numbers of fixed ticks instead. Everything else is unchanged and deliberately so: the
 * page is the real single-file build, the renderer is the real WebGL renderer, input is real key
 * and mouse events, and frames keep being drawn the whole time. Only the pacing is the driver's.
 *
 * Two things still belong to wall time and say so where they are used: the frame rate, and the
 * cost of the amortised unlock pass. `resumeClock()` hands the clock back for those.
 */

/** The loop's fixed timestep. Asserted against the page at boot. */
const TICK_HZ = 120;
/**
 * The tick every run starts its first assertion from.
 *
 * Boot itself has to run on the display clock — the lattice build is a real hitch, and the frame
 * rate reported below is about real frames — so the tick the suspension lands on belongs to the
 * host (80-95 of them here). Rather than measure everything from that moving origin, the driver
 * steps up to this fixed one first: the paint clock behind every screenshot is then the same
 * number in every run, which is what makes age-dependent readings comparable between runs and
 * not merely stable within one. Generous headroom over the observed boot; a host fast enough to
 * overrun it fails the handshake loudly instead of drifting quietly.
 */
const BOOT_TICK = 600;
/** Ticks covering `ms` of simulated time — for reading the intent of the old wall-clock waits. */
const ticksFor = (ms) => Math.max(1, Math.round((ms * TICK_HZ) / 1000));
/** Advances the simulation by exactly `n` ticks and returns the state after them. */
const step = (n = 0) => page.evaluate((k) => window.__blindspot.stepTicks(k), n);
/** Hands the simulation back to the display clock. */
const resumeClock = () => page.evaluate(() => window.__blindspot.resumeTicks());

/**
 * Steps until `pred` holds, in blocks, and returns the state it stopped on.
 *
 * The replacement for `poll`: same shape, but the budget is simulated ticks rather than
 * milliseconds, so where it stops is a fact about the build. `block` is the granularity — the
 * predicate can only be seen to flip on a block boundary, which is fine as long as the boundary
 * is the same on every host, and it is.
 */
async function stepUntil(pred, maxTicks = 2400, block = 8) {
  let s = await step(0);
  let spent = 0;
  while (!pred(s) && spent < maxTicks) {
    s = await step(block);
    spent += block;
  }
  return s;
}

const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/** Holds a set of keys for `ticks` of simulated time, then releases them. */
async function hold(keys, ticks) {
  for (const k of keys) await page.keyboard.down(k);
  await step(ticks);
  for (const k of keys) await page.keyboard.up(k);
  // One tick with the keys up, so the release is in the simulation before anything is read.
  await step(1);
}

/**
 * Polls the *live* state until `pred` holds (or the wall-clock budget runs out).
 *
 * Only for the stretches that deliberately run on the display clock — boot, and the frame-rate
 * measurement in §07. Everywhere else the question "has it happened yet" is asked of the tick
 * count instead, with `stepUntil`.
 */
async function poll(pred, budgetMs = 4000) {
  const deadline = Date.now() + budgetMs;
  let last = await state();
  while (!pred(last) && Date.now() < deadline) last = await state();
  return last;
}

/**
 * Samples the read-only state every `every` ticks, `count` times.
 *
 * View effects (head bob, the landing dip) live on the render camera, which `Loop.step` poses at
 * the end of every step — so a sample taken straight after a step describes the tick that just
 * ran. This used to sample once per rendered frame, which measured the same thing at whatever
 * rate software GL happened to manage: same measurement, but the sample times were the host's.
 */
async function sampleTicks(count, every) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = await step(every);
    out.push({
      tick: Number(s.simTicks),
      camY: s.camY,
      camRoll: s.camRoll,
      steps: s.steps,
      y: s.y,
      dip: s.landDip,
      grounded: s.grounded,
      speed: s.speed,
      boom: s.boom,
    });
  }
  return out;
}

/**
 * Turns the view by dragging — the pointer-lock-free look path.
 *
 * A 90° turn is ~750 px at the default sensitivity, which does not fit in a 1280 px viewport
 * starting from the centre, so the gesture is split into chunks that each stay on screen. Every
 * chunk is its own press/drag/release and the look handler measures per-gesture deltas, so the
 * rotations simply add up.
 *
 * The gesture is delivered with the simulation stopped, so the whole drag lands on one tick. The
 * input layer accumulates look deltas until a tick consumes them and the controller applies them
 * linearly, so this is the same rotation the same drag would produce spread over twenty frames —
 * arriving at a known tick instead of at an unknown number of them.
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
    }
    await page.mouse.up();
    remaining -= chunk;
  }
  await step(1);
}

/** Pitches the view by dragging vertically. Dragging down looks down, hence the sign. */
async function pitchBy(degrees, sensitivity) {
  const dy = -degrees / sensitivity;
  await page.mouse.move(640, 360);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(640, 360 + (dy * i) / 10);
  }
  await page.mouse.up();
  await step(1);
}

/** Turns to an absolute yaw by dragging. Dragging right lowers yaw, hence the sign. */
async function turnTo(targetDeg, sensitivity) {
  const current = Number((await state()).yawDeg);
  let delta = targetDeg - current;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  if (Math.abs(delta) > 0.5) await dragLook(-delta, sensitivity);
  await step(1);
}

/** Yaw, in the controller's convention, that points from one XZ spot at another. */
const yawTo = (fromX, fromZ, toX, toZ) =>
  (Math.atan2(-(toX - fromX), -(toZ - fromZ)) * 180) / Math.PI;

/** Presses R and steps the one tick that consumes it. */
async function respawn() {
  const before = Number((await state()).respawnCount);
  await page.keyboard.press('r');
  const after = await stepUntil((s) => Number(s.respawnCount) > before, 8, 1);
  if (Number(after.respawnCount) <= before) {
    check('respawn lands', false, `respawnCount stuck at ${after.respawnCount}`);
  }
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
const settle = (budgetTicks = 1200) =>
  stepUntil((s) => s.waveLive === false && Number(s.structPending) === 0, budgetTicks, 4);

/**
 * ...and for the contour strokes as well. They start at the front rather than a phase behind it,
 * but a stroke still takes `inkSeconds` to draw itself, so the last few are still going when the
 * wave stops.
 */
async function settleInk(budgetTicks = 1200) {
  await settle(budgetTicks);
  return stepUntil((s) => Number(s.structPendingEdges) === 0, budgetTicks, 4);
}

/**
 * ...and for the ramp to have carried the drawing out of its ice-white band.
 *
 * A frame is "settled" for a question about *colour* only once the white band is behind it: a
 * dot's first two seconds (`ageRamp.freshSeconds`) are ice-white, which is neither hue family,
 * and §3.2's claim is about the cyan the ramp cools into. Wall-clock pacing used to leave this
 * to luck — the old suite's settle took as many seconds of simulated time as the host felt like
 * giving it, which is exactly why the cyan-family assertion read anywhere from 74 % to 98 %
 * across runs of identical builds. Named and paid for, it is the same number every time.
 */
const WHITE_BAND_SECONDS = 2; // src/paint/ageRamp.ts, `freshSeconds`
async function settleColour() {
  await settleInk();
  // Half again past the band, so that nudging `freshSeconds` moves the reading rather than
  // landing the screenshot exactly on the boundary it is trying to be clear of.
  return step(ticksFor(WHITE_BAND_SECONDS * 1.5 * 1000));
}

/**
 * Fires a ping and waits for the bus to have delivered it.
 *
 * Waits out the shared cooldown first. A ping pressed while the previous one is still cooling is
 * refused by design, and a refused ping would otherwise surface much later as a mystery: stale,
 * zeroed statistics belonging to whatever event actually landed last.
 */
async function ping(cls) {
  await stepUntil((s) => Number(s.pingCooldown) === 0, ticksFor(2000), 4);
  const before = Number((await state()).soundEvents);
  await page.keyboard.press(cls === 'q-ping' ? 'q' : 'e');
  const landed = await stepUntil(
    (x) => Number(x.soundEvents) > before && x.lastEvent === cls,
    8,
    1,
  );
  check(
    `${cls} landed`,
    Number(landed.soundEvents) > before && landed.lastEvent === cls,
    `soundEvents ${before} -> ${landed.soundEvents}, lastEvent=${landed.lastEvent}`,
  );
  await settle();
  return state();
}

/**
 * The wall-clock ping, for §07 only.
 *
 * Same gesture as `ping`, driven by the display clock: the amortised unlock pass has to be left
 * to amortise over real frames there, because how much it costs per frame is the measurement.
 */
async function pingLive(cls) {
  await poll((s) => Number(s.pingCooldown) === 0, 6000);
  const before = Number((await state()).soundEvents);
  await page.keyboard.press(cls === 'q-ping' ? 'q' : 'e');
  const landed = await poll((x) => Number(x.soundEvents) > before && x.lastEvent === cls, 6000);
  check(
    `${cls} landed`,
    Number(landed.soundEvents) > before && landed.lastEvent === cls,
    `soundEvents ${before} -> ${landed.soundEvents}, lastEvent=${landed.lastEvent}`,
  );
  await poll((s) => s.waveLive === false && Number(s.structPending) === 0, 12000);
  return state();
}

/** Empties the map and steps the tick that consumes the keystroke. */
async function clearMap() {
  await page.keyboard.press('k');
  await stepUntil((s) => Number(s.structUnlockedDots) === 0, 8, 1);
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
    await stepUntil((s) => Number(s.paintTimeScale) !== before, 8, 1);
  }
  const s = await state();
  check(`paint clock reached x${target}`, Number(s.paintTimeScale) === target, `x${s.paintTimeScale}`);
}

const setReveal = async (on) => {
  if ((await state()).reveal === on) return;
  await page.keyboard.press('l');
  await stepUntil((s) => s.reveal === on, 8, 1);
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

// Boot is over, and with it the last of the wall clock. From here the driver owns the clock:
// every wait below is a number of simulated ticks, so every screenshot is of a named instant.
const booted = await state();
const bootTicks = Number((await step(0)).simTicks);
// Step up to the canonical origin, so the paint clock behind every screenshot below is the same
// number in every run rather than "however many ticks this host managed during boot".
const loaded = await step(BOOT_TICK - bootTicks);
const sens = Number(loaded.sensitivity);
console.log('[shoot] initial state', JSON.stringify(loaded));

// ===========================================================================
//  01  the game boots into the dark
// ===========================================================================
// Boot ran on the display clock, so this is a real frame rate off real frames.
check('renderer running', Number(booted.fps) > 0, `fps=${Number(booted.fps).toFixed(1)}`);
check(
  'the driver and the loop agree on what a tick is',
  Number(loaded.simHz) === TICK_HZ && loaded.stepping === true && Number(loaded.simTicks) === BOOT_TICK,
  `${loaded.simHz} Hz, stepping=${loaded.stepping}, at tick ${loaded.simTicks} of ${BOOT_TICK} ` +
    `(${bootTicks} ran on the display clock during boot)`,
);
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
  // Up to speed, then a fixed quarter second more, so what is read is the steady state rather
  // than whatever point of the acceleration curve the host happened to sample. Short on purpose:
  // the spawn heading is clear as far as the chokepoint doorway and no further.
  const top = await stepUntil((s) => Number(s.speed) > want - tol, ticksFor(1500), 4);
  const held = await step(ticksFor(250));
  for (const k of keys) await page.keyboard.up(k);
  await step(1);
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
const crouched = await stepUntil((s) => s.stance === 'crouch', ticksFor(1000), 1);
const crouchedCam = await step(ticksFor(250));
await page.keyboard.up('c');
await step(1);
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
await stepUntil((s) => Number(s.speed) > 5, ticksFor(1500), 4);
await page.keyboard.down('Space');
// The arc is walked a tick at a time: at 120 Hz the apex is sampled to within a millimetre, and
// the same tick is the apex on every host.
let apex = 0;
let sawAir = false;
let landed = null;
for (let i = 0; i < ticksFor(4000); i++) {
  const s = await step(1);
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
await step(1);
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
// 1.4 s of walking, sampled every 8 ticks: 21 poses of the render camera, at the same 21 instants
// on every host.
const bob = await sampleTicks(21, 8);
await page.keyboard.up('w');
await step(1);
const bobbing = bob.filter((f) => f.speed > 2);
check(
  'the camera bobs while walking',
  bobbing.length > 5 && spread(bobbing.map((f) => f.camY)) > 0.01,
  `${spread(bobbing.map((f) => f.camY)).toFixed(4)} m of camY spread over ${bobbing.length} moving poses`,
);
check(
  'and footsteps come out of that stride',
  Number(bob[bob.length - 1].steps) > Number(bob[0].steps),
  `${bob[0].steps} → ${bob[bob.length - 1].steps} steps`,
);

// --- collision ---------------------------------------------------------------
await respawn();
await turnTo(90, sens); // -X, into the west wall
await hold(['w'], ticksFor(2500));
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
const atFoot = await stepUntil((s) => Number(s.z) < -7.0, ticksFor(15000), 8);
await page.keyboard.up('w');
await step(1);
check(
  'the foot of the stairs is reachable',
  Number(atFoot.z) < -7.0 && Number(atFoot.x) < -13.5,
  `at (${Number(atFoot.x).toFixed(2)}, ${Number(atFoot.z).toFixed(2)})`,
);
await turnTo(-90, sens); // +X, up the flight
await page.keyboard.down('w');
// Walk until the deck rather than for a fixed distance: the deck ends at x = -5.2, and a walk
// long enough to be sure of arriving is a walk that steps off the end of it and falls.
const climbed = await stepUntil((s) => Number(s.y) > 2.4, ticksFor(10000), 8);
await page.keyboard.up('w');
await step(1);
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
await stepUntil((s) => Math.hypot(Number(s.x) + 9.0, Number(s.z) + 3.2) < 1.4, ticksFor(12000), 4);
await page.keyboard.press('Space');
const onCrate = await stepUntil((s) => Number(s.y) > 0.9, ticksFor(5000), 2);
await page.keyboard.up('w');
await step(1);
check(
  'a 1 m crate is vaulted, not bumped into',
  Number(onCrate.y) > 0.9,
  `feet at y=${Number(onCrate.y).toFixed(2)} m on a 1.0 m box`,
);

// --- third person ----------------------------------------------------------------
await respawn();
await page.keyboard.press('v');
const third = await stepUntil((s) => Number(s.viewBlend) > 0.99, ticksFor(5000), 2);
await step(ticksFor(250));
const thirdBuf = await shot('02-third-person.png');
check(
  'V pulls the camera out to a boom',
  third.view === 'third' && Number(third.boom) > 1.5,
  `boom ${Number(third.boom).toFixed(2)} m of a ${Number(third.boomRest).toFixed(2)} m rest length`,
);
check('and the lit view still draws', photo(thirdBuf).lit > 0.3, `lit=${pct(photo(thirdBuf).lit)}`);
await page.keyboard.press('v');
await stepUntil((s) => Number(s.viewBlend) < 0.01, ticksFor(5000), 2);

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
await step(ticksFor(2200));
const walkBuf = await shot('04-footsteps.png');
const walking = await state();
await page.keyboard.up('w');
await step(1);
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
await settleColour();
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
//
// The bar was 0.8 while the reading was a lottery between 74 % and 98 %; on the tick clock it is
// 98.01 % in every run, so the margin can go back to being about the picture. Tightened on five
// runs of evidence, not on one.
const qHue = hues(qBuf);
check(
  'a settled drawing is cyan-family, always (§3.2)',
  qHue.coolFraction > 0.9 && qHue.warmFraction < 0.02,
  `cool=${pct(qHue.coolFraction)} warm=${pct(qHue.warmFraction)} of ${qHue.lit} lit px`,
);

/*
 * ...and the same drawing again, from the same script.
 *
 * This is the assertion the tick-driven pacing exists for. Every number above is a measurement
 * of a *moment* — how far the front got, how much of the warm flash has faded, how many contours
 * are still drawing themselves — and driven by wall clock the moment behind a screenshot was
 * whatever the host managed in 800 ms. Run twice, the same script then produced different
 * pictures, and the assertion nearest the edge (cyan-family, above) drifted eighteen points
 * across runs of byte-identical builds and failed on luck. Driven by ticks, the same script
 * describes the same instant, and the two pictures have to agree. If this ever fails, nothing
 * below it means what it says.
 *
 * The cooldown is waited out *before* the sequence starts, so the repeat spends the same number
 * of ticks between the respawn and the ping as the original did.
 */
await stepUntil((x) => Number(x.pingCooldown) === 0, ticksFor(2000), 4);
await respawn();
await clearMap();
await pitchBy(12, sens);
await ping('q-ping');
await settleColour();
const qBuf2 = await shot('05b-q-ping-again.png');
const q2 = photo(qBuf2);
const qHue2 = hues(qBuf2);
const dMean = Math.abs(q2.mean - q.mean);
const dLit = Math.abs(q2.lit - q.lit);
const dCool = Math.abs(qHue2.coolFraction - qHue.coolFraction);
const dPix = pixelDiff(qBuf, qBuf2);
/*
 * The bar is exact, because the answer turned out to be exact: the two frames are identical
 * pixel for pixel over the whole measurement window, in five runs out of five, and so are the
 * other twelve screenshots compared against a different run of the same script. Re-paced onto
 * the wall clock this same pair reads Δ0.0559 of mean luminance, eleven times a bar that is
 * otherwise never off zero. The aggregates are kept beside the pixel count so that a failure
 * says *how* the two disagree — a shifted front and a warmer flash look nothing alike.
 */
check(
  'the same script twice paints the same instant',
  dPix.pixels === 0 && dMean < 0.005 && dLit < 0.0002 && dCool < 0.001,
  `mean ${q.mean.toFixed(3)} vs ${q2.mean.toFixed(3)} (Δ${dMean.toFixed(4)}), ` +
    `lit ${pct(q.lit)} vs ${pct(q2.lit)}, cool ${pct(qHue.coolFraction)} vs ` +
    `${pct(qHue2.coolFraction)} · ${dPix.pixels} of ${dPix.of} px differ in frame` +
    `${dPix.pixels > 0 ? `, worst ${dPix.worst}/255` : ''}`,
);

// --- the shared cooldown (§3.5) --------------------------------------------------
// One tick apart: the Q lands, and the E arrives 8 ms later, well inside the 0.75 s the cooldown
// is supposed to hold the door shut. Fired back to back on the wall clock this used to be a race
// between two keystrokes and one frame, and on a slow host both landed on the same tick — where
// what refuses the E is `firePing`'s else-branch, not the cooldown the assertion names.
await stepUntil((s) => Number(s.pingCooldown) === 0, ticksFor(2000), 4);
const beforeCooldown = Number((await state()).soundEvents);
await page.keyboard.press('q');
await step(1);
await page.keyboard.press('e');
const cooling = await step(1);
check(
  'a second ping inside the 0.75 s cooldown is refused',
  Number(cooling.soundEvents) === beforeCooldown + 1 && cooling.lastEvent === 'q-ping',
  `soundEvents ${beforeCooldown} → ${cooling.soundEvents}, lastEvent=${cooling.lastEvent}`,
);

// --- E beam: the 22 m look-around -------------------------------------------------
await respawn();
await clearMap();
const eState = await ping('e-ping');
await settleInk();
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
await settleInk();
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
await settleInk();
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
const pastChoke = await stepUntil((s) => Number(s.x) > -2.6, ticksFor(25000), 8);
await page.keyboard.up('w');
await step(1);
await turnTo(180, sens); // +Z
await page.keyboard.down('w');
const inChamber = await stepUntil((s) => Number(s.z) > 8.4, ticksFor(25000), 8);
await page.keyboard.up('w');
await step(1);
check(
  'the doorway is walkable',
  Number(inChamber.z) > 8.4 && Number(pastChoke.x) > -2.6,
  `walked to (${Number(inChamber.x).toFixed(2)}, ${Number(inChamber.z).toFixed(2)})`,
);
await turnTo(-90, sens); // +X, down the length of the chamber
// Wiped first, so the answer below can only be the one ping fired from inside.
await clearMap();
await ping('e-ping');
await settleInk();
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
//  is out at the doorjamb — which is what "at the front" means. The clock runs at ×0.1, which
//  buys the sampler ten ticks of front travel where it would otherwise have one.
// ===========================================================================
await respawn();
await clearMap();
await setTimeScale(0.1);
await stepUntil((s) => Number(s.pingCooldown) === 0, ticksFor(2000), 4);
const beforeFront = Number((await state()).soundEvents);
await page.keyboard.press('q');
await stepUntil((s) => Number(s.soundEvents) > beforeFront && s.lastEvent === 'q-ping', 8, 1);

let inFlight = null;
let jambAtRing = null;
let dotFront = Number.NaN;
let inkFront = Number.NaN;
// Two ticks per sample: at ×0.1 that is ~8 cm of front travel, so where the jamb lights and
// where its first contour closes are read to the same centimetre on every host. This used to be
// bounded by wall time, and how finely it sampled — and therefore both numbers below — was a
// measure of how fast the host could round-trip a state read and a region probe.
const frontBudget = ticksFor(12000);
for (let spent = 0; spent < frontBudget; spent += 2) {
  const s = await step(2);
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
await settleInk();
await setTimeScale(1);

// ===========================================================================
//  06  age: the fine read decays, the map does not (§3.6)
// ===========================================================================
await respawn();
await clearMap();
await ping('q-ping');
await settleInk();
const freshBuf = await shot('11-fresh.png');
const fresh = photo(freshBuf);
const beforeAge = await state();

// The paint clock has a debug multiplier on T so ageing can be watched without waiting a
// minute for it. Ticks are counted at the scaled clock, not guessed at: 20 s of ageing is 20 s
// of ageing whatever the frame rate, so `fresh → aged` is now the same drop every run.
await setTimeScale(10);
const clock0 = Number((await state()).paintTime);
await stepUntil((s) => Number(s.paintTime) - clock0 >= 20, ticksFor(25000), 8);
await setTimeScale(1);
await step(ticksFor(250));
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
await step(ticksFor(700));
await page.keyboard.up('w');
const stepped = await stepUntil((s) => String(s.lastEvent).endsWith('step'), ticksFor(2000), 4);
await settleInk();
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
// The body first: it is still coasting to a stop from the walk above, and a footfall after the
// wipe repaints the floor. On the wall clock this settled itself, because everything between
// here and there took whole seconds of real time.
await stepUntil((s) => Number(s.speed) < 0.01, ticksFor(2000), 4);
await clearMap();
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
/*
 * The one stretch that is genuinely about wall time, so it gets the wall clock back.
 *
 * Both halves of the assertion below are measurements of *this host*: the frame rate the
 * software rasteriser manages under load, and how much of a millisecond budget one chunk of the
 * amortised unlock pass actually spends. Stepping would answer neither — a stepped tick settles
 * its unlock pass in full by design, which is the right thing everywhere except here, where the
 * amortisation is the thing under test. This is a threshold test and is meant to be read as one.
 */
await resumeClock();
const cost = [];
for (let i = 0; i < 6; i++) {
  const s = await pingLive('e-ping');
  cost.push({
    total: Number(s.structLastMs),
    worst: Number(s.structLastChunkMs),
    chunks: Number(s.structLastChunks),
    rays: Number(s.structLastRays),
    dots: Number(s.structLastDots),
  });
}
await poll((s) => s.waveLive === false && Number(s.structPendingEdges) === 0, 40000);
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
// Back on the driver's clock for the picture. The frame rate above is a measurement of the
// host; the screenshot is a photograph of the game, and only one of the two wants the host in
// it. What the six beams unlocked is already settled, so this only pins *when* it is looked at.
//
// It cannot pin *when they were fired*, though: the six went out on the display clock, spaced by
// whatever it was doing, so their paint ages differ by a little from run to run and the numbers
// printed below move with them (mean 8.8-10.9 across five runs, against nothing in the assertion
// that reads mean). This is the one screenshot in the suite that inherits §07's wall clock, and
// the assertion is deliberately the one property that does not care: nothing clips.
await step(0);
await settleInk();
const stressBuf = await shot('14-six-beams.png');
const stress = photo(stressBuf);
check(
  'and the picture stays inside the framebuffer instead of clipping',
  stress.sat < 0.02,
  `mean=${stress.mean.toFixed(2)}/255 lit=${pct(stress.lit)} hot=${pct(stress.hot)} saturated=${pct(stress.sat)}`,
);

// ===========================================================================
//  08  material: the same stride on the loud floor and on the quiet one (§3.9)
//
//  Last, and deliberately so. Everything above is paced in ticks so that a screenshot describes
//  a *moment*, and the strictest assertion in the file compares two frames pixel for pixel. The
//  age a dot is drawn at is `paintTime - stamp`, and how much simulated time has already gone by
//  when that subtraction happens is not free of rounding: inserting this walk earlier moved one
//  pixel of that pair by one level out of 255. So the surface test goes after the tests it would
//  otherwise perturb, and perturbs nothing.
// ===========================================================================
// §3.9's routing choice, in pixels — the only question worth asking about a stealth surface is
// whether the player can tell, and the player is in the dark. Dust is ×0.6, so the same
// walk-step paints 2.4 m instead of 4; paint falls off with distance from the origin, so the
// floor that comes back is not 60 % of the concrete one but nearer a third of it.
//
// Both samples are one footstep onto a cleared map, so what is measured is that step and not
// the walk that got there. Both are taken in the far room, a few metres apart on the same
// north-south lane at x ~ 3.8 — west of the tank, east of the chokepoint wall, open floor
// either side of the door-line — so that what differs between the two frames is the surface and
// not the architecture. The lane is walked in two legs, east to the sample point and then due
// south across `APRON_Z` onto the dust, because pointing at the apron from anywhere further
// east means pointing through the tank.
//
// The walk has to *stop* for each sample. A held key fires the next footfall a stride later,
// which starts a second wave over the first, so how much of the picture is one step and how
// much is two would come down to where in the stride the map happened to be cleared — the one
// thing the reading must not depend on. So the key goes up the instant the event lands, before
// the ink is allowed to settle, and 0.26 m of deceleration is far short of the 1.58 m to the
// next footfall. The body is then let come to a stop before the ink settles, so that both
// frames are shot from a standing camera — head bob is a function of speed, and a photograph
// of the same floor from two different heights is not a photograph of the floor.
async function oneStepOnACleanMap() {
  await clearMap();
  const before = Number((await state()).lastEventSeq);
  await page.keyboard.down('w');
  const stepped = await stepUntil((s) => Number(s.lastEventSeq) > before, ticksFor(3000), 1);
  await page.keyboard.up('w');
  await stepUntil((s) => Number(s.speed) === 0, ticksFor(2000), 1);
  await settleInk();
  return stepped;
}

await respawn();
await clearMap();
await pitchBy(-22, sens);
await page.keyboard.down('w');
await stepUntil((s) => Number(s.x) > 2, ticksFor(12000), 4);
await page.keyboard.up('w');
await step(1);
const concreteStep = await oneStepOnACleanMap();
const onSlab = await state();
const concreteBuf = await shot('04b-step-on-concrete.png');
const concreteFloor = photo(concreteBuf, FLOOR_BAND, []);

const beforeTurn = await state();
await turnTo(yawTo(Number(beforeTurn.x), Number(beforeTurn.z), Number(beforeTurn.x), -9), sens);
await page.keyboard.down('w');
await stepUntil((s) => Number(s.z) < -4.5, ticksFor(12000), 4);
await page.keyboard.up('w');
await step(1);
const dustStep = await oneStepOnACleanMap();
const onApron = await state();
const dustBuf = await shot('04c-step-on-dust.png');
const dustFloor = photo(dustBuf, FLOOR_BAND, []);

console.log(
  `  step on concrete at (${Number(onSlab.x).toFixed(1)}, ${Number(onSlab.z).toFixed(1)}): ` +
    `r=${Number(concreteStep.lastEventRadius).toFixed(2)} m, ` +
    `${concreteStep.structLastDots} dots, floor band mean=${concreteFloor.mean.toFixed(3)}\n` +
    `  step on dust at (${Number(onApron.x).toFixed(1)}, ${Number(onApron.z).toFixed(1)}): ` +
    `r=${Number(dustStep.lastEventRadius).toFixed(2)} m, ${dustStep.structLastDots} dots, ` +
    `floor band mean=${dustFloor.mean.toFixed(3)}`,
);
check(
  'the apron is dust underfoot, and the bus says so in metres',
  Math.abs(Number(concreteStep.lastEventRadius) - 4) < 1e-6 &&
    Math.abs(Number(dustStep.lastEventRadius) - 2.4) < 1e-6,
  `${Number(concreteStep.lastEventRadius).toFixed(3)} m on concrete, ` +
    `${Number(dustStep.lastEventRadius).toFixed(3)} m on dust — ×` +
    `${(Number(dustStep.lastEventRadius) / Number(concreteStep.lastEventRadius)).toFixed(3)}`,
);
check(
  'and the quiet step hands back a fraction of the floor',
  Number(dustStep.structLastDots) > 50 &&
    Number(dustStep.structLastDots) < Number(concreteStep.structLastDots) * 0.5,
  `${dustStep.structLastDots} dots off the dust step against ` +
    `${concreteStep.structLastDots} off the concrete one`,
);
check(
  'and you can see the difference in the dark, which is the only place it matters',
  dustFloor.mean < concreteFloor.mean * 0.75 && dustFloor.mean > 0.05,
  `floor band mean ${dustFloor.mean.toFixed(3)}/255 on dust against ` +
    `${concreteFloor.mean.toFixed(3)}/255 on concrete`,
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
