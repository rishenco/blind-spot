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
import { existsSync, readdirSync, statSync } from 'node:fs';
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

/*
 * Refuse to photograph a build that is older than the code it claims to be.
 *
 * This suite tests `dist/`, and `npm run shoot` does not build. So a failed build leaves the
 * *previous* bundle sitting there and every assertion below goes on passing — against code
 * nobody is running any more. That is the one failure mode a gate must not have: not a red run
 * that turns out to be fine, but a green run that means nothing. It has already happened here
 * once, while checking a mutation by hand: the mutant was reverted in `src/` and the mutant's
 * bundle was still the thing being photographed.
 *
 * Mtime rather than a hash because it answers the question actually being asked — "was this
 * built after the code was last touched" — with no bookkeeping to keep in sync, and because
 * being wrong in the safe direction (a rebuild that changed nothing still refreshes the mtime)
 * costs a rebuild and nothing else.
 */
function newestMtimeMs(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs);
  }
  return newest;
}

const builtAtMs = statSync(htmlPath).mtimeMs;
const sourceAtMs = Math.max(
  ...['src', 'index.html', 'vite.config.ts', 'tsconfig.json']
    .filter((p) => existsSync(resolve(p)))
    .map((p) => {
      const full = resolve(p);
      return statSync(full).isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs;
    }),
);
if (sourceAtMs > builtAtMs) {
  const behind = ((sourceAtMs - builtAtMs) / 1000).toFixed(0);
  console.error(
    `[shoot] stale build: ${htmlPath} is ${behind}s older than the newest source file.\n` +
      '[shoot] this suite photographs dist/, so it would be testing code you have since changed.\n' +
      '[shoot] run `npm run build` first (`npm run check` builds too).',
  );
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
/*
 * A ratio of two measurements, for the lines that report one reading against another.
 *
 * Both of these exist because the readings they format are the readings a broken build makes,
 * and a broken build is where the line has to stay readable: divide the mean of a black frame
 * by the mean of a black frame and the report says `NaN%`, or `Infinity×` if only the
 * denominator is black. The check itself is unaffected either way — this is about the sentence
 * the failure prints, which is the only thing anyone reads when it does.
 */
const pct2 = (a, b) => (b > 0 ? pct(a / b) : 'n/a');
const times = (a, b) => (b > 0 ? `${(a / b).toFixed(1)}×` : 'unmeasurably more than');
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
// Each verb named separately rather than one contiguous run of the string: a new verb landing
// in the middle of the line is the *expected* change (F throw did exactly that), and a check
// that breaks on it teaches you to loosen the check. What must never happen is a verb quietly
// dropping out of the one line the game uses to tell anybody it exists.
const hintLine = await page.textContent('.bs-hint');
check(
  'the game owns the hint line, and every verb is named on it',
  ['WASD move', 'Q ping', 'E beam', 'F throw', 'L reveal', 'H help'].every((v) =>
    hintLine.includes(v),
  ),
  hintLine,
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

/*
 * The paint clock has a debug multiplier on T so ageing can be watched without waiting a minute
 * for it. Ticks are counted at the scaled clock, not guessed at, so the ages below are the same
 * ages every run whatever the frame rate.
 *
 * Two photographs, at two named ages, because the ramp has three stages and one photograph can
 * only ever be of one of them. The old reading was a single shot at 20 s against a
 * `coldSeconds` of 60 — a picture taken mid-ramp, of paint still on its way down, and called
 * "aged". It was then tested against a one-sided floor, which any brightness above zero passes.
 * Between them those two facts let `skeletonAlpha` be set to zero — §3.6's law deleted, the map
 * going black behind the player — with this suite and the Node suite both green. The
 * arithmetic side of that hole is closed in `tests/ageRamp.test.ts`; this is the pixel side, and
 * it needs to photograph the stage the law is about.
 *
 * So: 10 s is the middle of the ramp (the cyan → navy stage runs 2-20 s) and 70 s is past the
 * end of it (`coldSeconds` 60), which is the memory skeleton itself and nothing else. Both
 * readings are bands rather than floors. A floor cannot tell "settled on the skeleton" from
 * "still cooling towards it", and it is the *ceiling* that catches a ramp which never finishes.
 */
await setTimeScale(10);
const clock0 = Number((await state()).paintTime);
await stepUntil((s) => Number(s.paintTime) - clock0 >= 10, ticksFor(25000), 4);
await setTimeScale(1);
await step(ticksFor(250));
const midBuf = await shot('11b-cooling.png');
const mid = photo(midBuf);
const midAge = Number((await state()).paintTime) - clock0;
// ×60 for the rest of it: the last stage is 40 s of paint clock wide and nothing in it needs
// resolving finer than the ×10 leg above did.
await setTimeScale(60);
await stepUntil((s) => Number(s.paintTime) - clock0 >= 70, ticksFor(25000), 4);
await setTimeScale(1);
await step(ticksFor(250));
const agedBuf = await shot('12-aged.png');
const aged = photo(agedBuf);
const afterAge = await state();
check(
  'what was heard cools with age',
  aged.mean < fresh.mean * 0.75,
  `mean ${fresh.mean.toFixed(2)} → ${mid.mean.toFixed(2)} → ${aged.mean.toFixed(2)}/255 over ` +
    `${(Number(afterAge.paintTime) - clock0).toFixed(0)} s`,
);
check(
  'and it cools through a middle rather than off a cliff (§3.2)',
  mid.mean > fresh.mean * 0.2 && mid.mean < fresh.mean * 0.9,
  `at ${midAge.toFixed(0)} s: mean=${mid.mean.toFixed(2)}/255 (${pct(mid.mean / fresh.mean)} ` +
    `of fresh, ${times(mid.mean, aged.mean)} the skeleton) lit=${pct(mid.lit)}`,
);
check(
  'and settles on a memory skeleton rather than on nothing',
  aged.mean > fresh.mean * 0.02 && aged.mean < fresh.mean * 0.1 && aged.lit > 0.005,
  `mean=${aged.mean.toFixed(3)}/255 (${pct(aged.mean / fresh.mean)} of fresh) lit=${pct(aged.lit)}`,
);
/*
 * And then the load-bearing word of §3.6: *permanent*.
 *
 * A band around the 70 s reading can say the picture is faint. It cannot say the picture has
 * stopped, and those are different claims with the same photograph behind them — a ramp whose
 * last stage is ten minutes long is also faint at 70 s, only 1.8× brighter than a settled one,
 * which is inside any band wide enough to be worth setting. So the second half of the question
 * is asked the only way a photograph can ask it: take the same picture again much later and
 * require that nothing moved. At the skeleton, two shots 130 s of paint clock apart are the
 * same shot. On a ramp still cooling they are not, and the gap between them is the ramp's
 * remaining travel, whatever its shape.
 */
await setTimeScale(60);
await stepUntil((s) => Number(s.paintTime) - clock0 >= 200, ticksFor(25000), 4);
await setTimeScale(1);
await step(ticksFor(250));
const stillBuf = await shot('12b-still-there.png');
const still = photo(stillBuf);
const lateAge = Number((await state()).paintTime) - clock0;
check(
  'and stays there: the skeleton is a floor, not a slower fade (§3.6)',
  // `aged.mean > 0` is not redundant with the check above it: two black frames are also two
  // frames that agree, and "nothing moved" has to mean the picture held rather than that there
  // was no picture to move.
  aged.mean > 0 &&
    Math.abs(still.mean - aged.mean) <= aged.mean * 0.05 &&
    Math.abs(still.lit - aged.lit) <= 0.005,
  `mean ${aged.mean.toFixed(3)} at ${(Number(afterAge.paintTime) - clock0).toFixed(0)} s → ` +
    `${still.mean.toFixed(3)}/255 at ${lateAge.toFixed(0)} s ` +
    `(${pct2(Math.abs(still.mean - aged.mean), aged.mean)} apart) · ` +
    `lit ${pct(aged.lit)} → ${pct(still.lit)}`,
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

// --- the Halo ring (§3.8) ----------------------------------------------------
/*
 * "A ring around the reticle whose brightness equals your current audible radius."
 *
 * `tests/halo.test.ts` owns the numbers — the carry radius, the pitch, the brightness, and the
 * affine map from brightness to opacity. What no node test can answer is whether any of that
 * reaches the screen: a `setHalo` nobody calls, an element nobody appends and a stylesheet with
 * a typo in it all leave the whole suite green. So this is the pixel end of it, and the question
 * is deliberately the crudest one available — is the ring brighter when the body is louder.
 *
 * **It lives here, after the wipe, because the reading has to be of the ring and not of the
 * room.** Getting into a stance means moving, moving paints, and painted floor sits behind the
 * reticle: measured in the movement section, the window read 28.5 → 39.1 with about 22 of that
 * being geometry the sprint had just revealed. A brighter ring and a busier room are the same
 * number. So every reading below wipes the map on the frame it is taken, which costs nothing —
 * the map is already black here and §07 below clears it again before using it.
 *
 * The window is the hole FRAME already punches out of its own, which is why the ring was sized
 * to fit inside it: every other pixel golden in this file is read over FRAME, and a ring that
 * leaked past the hole would move all of them at once.
 */
const RETICLE = FRAME_HOLES[0];
/** A screenshot without writing one — the same two-frame settle `shot` uses. */
async function frame() {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return page.screenshot();
}

/**
 * Settles the body into a stance, wipes the room, and reads both faces of the readout.
 *
 * The extra 600 ms past top speed is the glide (`HALO_GLIDE_SEC`, 0.18 s): §3.8 has the readout
 * lag the body on purpose, so a reading taken the instant the speed arrives is a reading of the
 * glide rather than of the stance. Three-plus time constants puts it inside a percent.
 */
async function ringIn(keys, minSpeed) {
  await respawn();
  for (const k of keys) await page.keyboard.down(k);
  await stepUntil((s) => Number(s.speed) > minSpeed, ticksFor(1500), 4);
  await step(ticksFor(600));
  await clearMap();
  const s = await state();
  const luma = meanLuminance(decodePng(await frame()), RETICLE, []).mean;
  for (const k of keys) await page.keyboard.up(k);
  await step(1);
  return { luma, radius: Number(s.haloRadius), brightness: Number(s.haloBrightness) };
}

const ringCrouch = await ringIn(['c', 'w'], 1.5);
const ringWalk = await ringIn(['w'], 3.2);
const ringSprint = await ringIn(['Shift', 'w'], 5.6);
check(
  'the Halo ring gets brighter the further away you can be heard (§3.8)',
  ringCrouch.luma < ringWalk.luma && ringWalk.luma < ringSprint.luma,
  `crouch ${ringCrouch.radius.toFixed(1)} m → ${ringCrouch.luma.toFixed(2)}/255 · ` +
    `walk ${ringWalk.radius.toFixed(1)} m → ${ringWalk.luma.toFixed(2)} · ` +
    `sprint ${ringSprint.radius.toFixed(1)} m → ${ringSprint.luma.toFixed(2)}`,
);
/*
 * ...and the pixels are the *readout*, not merely something that rises with it.
 *
 * Ordering alone would pass on a ring wired to speed, to the stance, or to the radius scaled
 * linearly — the obvious `r / max`, which `tests/halo.test.ts` rejects on the simulation side for
 * putting a walk a third of the way up the ring while the hum puts it nearly half. What pins the
 * pixels to §3.8 is that they rise *in step with* `haloBrightness`, the same number the hum is
 * built from, so where the walk sits between crouch and sprint has to agree on both.
 */
const lumaSpan = ringSprint.luma - ringCrouch.luma;
const lumaShare = (ringWalk.luma - ringCrouch.luma) / lumaSpan;
const brightShare =
  (ringWalk.brightness - ringCrouch.brightness) /
  (ringSprint.brightness - ringCrouch.brightness);
check(
  'and it is the brightness it is drawn from, not just something that rises with pace',
  lumaSpan > 8 && Math.abs(lumaShare - brightShare) < 0.06,
  `walk sits ${(lumaShare * 100).toFixed(1)}% up the measured span, ` +
    `${(brightShare * 100).toFixed(1)}% up the readout's (span ${lumaSpan.toFixed(2)}/255)`,
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
//  09  the throw: the light lands where the can does
//
//  The verb's whole promise (`world/cans.ts`) is a sound somewhere you are not, and the half of
//  that a camera can settle is *where the light is*. No dot count can settle it: a can that lit
//  the room from the rig's own boots would unlock exactly as many dots as one that lit it from
//  eight metres out. It has to be read off the picture, through two windows — one on the floor
//  the can struck, one on the floor 2.5 m in front of the rig.
//
//  Both windows are aimed in world coordinates, because "where the can landed" is not a place
//  on screen until the can has landed. `project` below is the camera's own transform written
//  out once; §10 and §11 aim their windows with it too.
//
//  Each window is read black first, before the arm moves — a control frame that also proves
//  neither window has drifted onto a piece of the HUD — and then under each of three sounds
//  fired from that one stand: the throw, an E-beam down the same aim, and a Q-ping.
//
//  **The far window is brighter for free, which is why there are three sounds and not one.** It
//  looks at floor 8 m out, where the lattice's 0.18 m spacing covers a third as many pixels as
//  it does at 2.5 m, so far-over-near is a large ratio before anything is thrown. The Q-ping is
//  what measures that ratio and takes it off the table: 360°, 12 m, centred on the rig — the one
//  source in this game whose paint is symmetric about the player *by construction*, so any skew
//  it shows through these two windows is the windows and not the sound. Against that yardstick a
//  throw's skew means what it says, and a raw far-over-near number would have meant almost
//  nothing.
//
//  **The claim this section refused to make.** It was written to assert both halves of
//  `cans.ts`'s asymmetry — the far end lights, *and* the thrower's own end stays darker than a
//  beam would have left it. The second half is not true of the picture: the rig's own floor
//  reads 3.09/255 after the throw against 3.48 after the beam, 1.1×, and lofting the can to 17 m
//  only bounces it back to 13.7 m and repaints the near field anyway. The claim was wrong, not
//  the measurement. An impact carries 8–12 m of paint scaled by the metal-on-concrete voice
//  (§3.9) — up to ~14.7 m — radiating from a point 8.4 m out, so its sphere covers the thrower
//  with room to spare. The asymmetry `cans.ts` is really claiming lives in the *hearing* column
//  of §3.3, 25 m off the impact against 2.5 m off the wind-up, and a hearing radius is precisely
//  the thing that paints nothing for a camera to find. Both numbers stay in the log below so
//  that the next person to reach for this comparison finds the answer already taken.
// ===========================================================================
/**
 * A point in the world, in viewport pixels — the camera's own transform, written out.
 *
 * `getState` publishes the render camera's position and the two look angles, and `src/main.ts`
 * builds the projection from a 90° vertical field of view. That is the whole mapping, and
 * having it here is what lets a measurement window be aimed at a *place* — the spot a can
 * struck, the floor a cairn stands on — instead of at a rectangle eyeballed off one screenshot
 * and quietly wrong the day the room moves.
 */
const PIXELS_PER_TANGENT = 360; // 90° vertical FOV over a 720-tall viewport: half of it per unit
function project(s, p) {
  const yaw = (Number(s.yawDeg) * Math.PI) / 180;
  const pitch = (Number(s.pitchDeg) * Math.PI) / 180;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const fwd = [-sy * Math.cos(pitch), Math.sin(pitch), -cy * Math.cos(pitch)];
  const right = [cy, 0, -sy];
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  const d = [p.x - Number(s.camX), p.y - Number(s.camY), p.z - Number(s.camZ)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(d, fwd);
  return {
    depth,
    x: 640 + (PIXELS_PER_TANGENT * dot(d, right)) / depth,
    y: 360 - (PIXELS_PER_TANGENT * dot(d, up)) / depth,
  };
}
/** A square measurement window of a given pixel size, centred on a projected point. */
const windowAt = (p, size) => ({
  x: Math.round(p.x - size / 2),
  y: Math.round(p.y - size / 2),
  w: size,
  h: size,
});
/**
 * Is this window looking at the renderer's output and nothing else?
 *
 * Measured on a black frame of this build: inside x ∈ [300, 1020) the only rows carrying DOM ink
 * are 10-214 (the HUD panel and the title), 345-374 (the reticle) and 639-705 (the two hint
 * lines). A derived window is aimed by the camera, so a change of stance or of pitch can walk it
 * onto the reticle, where it would read the game's own overlay as if it were revealed geometry.
 * Cheaper to refuse the reading than to explain it later.
 *
 * The reticle is why this is a list of two bands and not one range. It sits dead centre and
 * splits the clear middle of the frame in half, and the two halves are where the two kinds of
 * reading in these sections naturally land: a patch of floor falls below it, a stacked column
 * seen from a few metres off falls above it. A window must fit wholly inside one band — one
 * that straddles the reticle is reading the overlay whichever band you would rather it were in.
 */
const DOM_FREE_ROWS = [
  [215, 344],
  [375, 638],
];
const domFree = (r) =>
  r.x >= 300 &&
  r.x + r.w <= 1020 &&
  DOM_FREE_ROWS.some(([top, bottom]) => r.y >= top && r.y + r.h <= bottom + 1);
/** The point on the floor `metres` straight ahead of the body. */
const groundAhead = (s, metres) => {
  const yaw = (Number(s.yawDeg) * Math.PI) / 180;
  return {
    x: Number(s.x) - Math.sin(yaw) * metres,
    y: 0,
    z: Number(s.z) - Math.cos(yaw) * metres,
  };
};
/** Winds the arm for `ticks` of simulated time and lets go, on the tick the can leaves. */
async function throwCan(ticks) {
  const before = Number((await state()).cansThrown);
  await page.keyboard.down('f');
  await step(ticks);
  await page.keyboard.up('f');
  return stepUntil((s) => Number(s.cansThrown) > before, 30, 1);
}
/**
 * Every can in the world asleep.
 *
 * A thrown can bounces, and `paint/prints.ts` lays its cairn where it *stops* — so a picture
 * taken before the world is still is a picture of a can that has not finished arriving.
 */
const cansAtRest = () => stepUntil((s) => s.canPoses.every((c) => c.asleep), ticksFor(9000), 2);
/** The id the world gave the can that was not there a moment ago. */
const newCanId = (before, after) => {
  const had = new Set(before.canPoses.map((c) => c.id));
  return after.canPoses.find((c) => !had.has(c.id))?.id ?? -1;
};

await respawn();
await clearMap();
await settleInk();
const beforeThrow = await state();
// The control frame, taken before anything is thrown and read through the two windows the throw
// is about to define. It answers two questions at once: the room is black, and neither window is
// looking at a piece of DOM — a reticle inside a window would read as paint that no sound made.
const darkFrame = await frame();

const launched = await throwCan(ticksFor(1200)); // well past CAN_CHARGE_SECONDS, so: the cap
const thrownId = newCanId(beforeThrow, launched);
const launchSeq = Number(launched.lastEventSeq);
const struck = await stepUntil(
  (s) => Number(s.lastEventSeq) > launchSeq && s.lastEvent === 'prop-impact',
  ticksFor(4000),
  1,
);
const strikePose = struck.canPoses.find((c) => c.id === thrownId);
const strikeRange = Math.hypot(
  strikePose.x - Number(beforeThrow.x),
  strikePose.z - Number(beforeThrow.z),
);
await cansAtRest();
await settleInk();
const throwBuf = await shot('15-throw-impact.png');

const shooting = await state();
const LANDING = windowAt(project(shooting, strikePose), 64);
const OWN_GROUND = windowAt(project(shooting, groundAhead(shooting, 2.5)), 64);
const darkLanding = photo(darkFrame, LANDING, []);
const darkOwn = photo(darkFrame, OWN_GROUND, []);
const thrownLanding = photo(throwBuf, LANDING, []);
const thrownOwn = photo(throwBuf, OWN_GROUND, []);

// The same aim, the same spot, the other two ways of asking. The beam is the throw's rival for
// the far end and is priced at 18 energy for it (§3.5); the Q-ping is not a rival at all — it is
// the yardstick, a sphere centred on the rig, and its far-over-near reading is what these two
// windows do to a sound that cannot favour either of them.
await clearMap();
await ping('e-ping');
await settleInk();
const beamBuf = await frame();
const beamLanding = photo(beamBuf, LANDING, []);
const beamOwn = photo(beamBuf, OWN_GROUND, []);

await clearMap();
await ping('q-ping');
await settleInk();
const sphereBuf = await frame();
const sphereLanding = photo(sphereBuf, LANDING, []);
const sphereOwn = photo(sphereBuf, OWN_GROUND, []);

/** How far out a source threw its light, in these two windows, before the yardstick. */
const skew = (far, near) => far.mean / Math.max(near.mean, 0.01);
const thrownSkew = skew(thrownLanding, thrownOwn);
const beamSkew = skew(beamLanding, beamOwn);
const sphereSkew = skew(sphereLanding, sphereOwn);

console.log(
  `  can struck the floor ${strikeRange.toFixed(2)} m out, came to rest ` +
    `${Math.hypot(
      Number(shooting.canPoses.find((c) => c.id === thrownId).x) - Number(beforeThrow.x),
      Number(shooting.canPoses.find((c) => c.id === thrownId).z) - Number(beforeThrow.z),
    ).toFixed(2)} m out, ${shooting.structUnlockedDots} dots unlocked\n` +
    `  landing window ${LANDING.x},${LANDING.y} ${LANDING.w}px: ` +
    `${darkLanding.mean.toFixed(3)} dark → ${thrownLanding.mean.toFixed(2)} thrown → ` +
    `${beamLanding.mean.toFixed(2)} beamed → ${sphereLanding.mean.toFixed(2)} q-pinged\n` +
    `  own-ground window ${OWN_GROUND.x},${OWN_GROUND.y} ${OWN_GROUND.w}px: ` +
    `${darkOwn.mean.toFixed(3)} dark → ${thrownOwn.mean.toFixed(2)} thrown → ` +
    `${beamOwn.mean.toFixed(2)} beamed → ${sphereOwn.mean.toFixed(2)} q-pinged\n` +
    `  far over near: ${thrownSkew.toFixed(2)}× thrown, ${beamSkew.toFixed(2)}× beamed, ` +
    `${sphereSkew.toFixed(2)}× q-pinged — the last of those is the windows themselves`,
);
check(
  'both windows are black before the arm moves, and neither is looking at the HUD',
  darkLanding.mean < 0.05 && darkOwn.mean < 0.05 && domFree(LANDING) && domFree(OWN_GROUND),
  `landing ${darkLanding.mean.toFixed(3)}/255, own ground ${darkOwn.mean.toFixed(3)}/255`,
);
check(
  'a thrown can lights the floor it struck',
  strikeRange > 6 && thrownLanding.mean > 6,
  `struck ${strikeRange.toFixed(2)} m out — ${thrownLanding.mean.toFixed(2)}/255, ` +
    `${pct(thrownLanding.lit)} of the window lit, from ${darkLanding.mean.toFixed(3)}/255 black`,
);
check(
  'out where it struck rather than around the rig, past what the windows do for free',
  thrownOwn.mean < thrownLanding.mean * 0.3 && thrownSkew > sphereSkew * 1.25,
  `${thrownOwn.mean.toFixed(2)}/255 (${pct(thrownOwn.lit)} lit) at the rig's feet against ` +
    `${thrownLanding.mean.toFixed(2)}/255 (${pct(thrownLanding.lit)}) where the can landed — ` +
    `${thrownSkew.toFixed(2)}× far over near, against the ${sphereSkew.toFixed(2)}× a Q-ping ` +
    `shows through the same two windows: ${times(thrownSkew, sphereSkew)} the skew a sound ` +
    `centred on the rig can produce`,
);
check(
  'and buys the far picture an 18-energy beam buys, for a can',
  thrownLanding.mean > beamLanding.mean * 0.8 &&
    thrownLanding.mean < beamLanding.mean * 1.25 &&
    thrownLanding.lit > beamLanding.lit * 0.8,
  `landing window ${thrownLanding.mean.toFixed(2)}/255 and ${pct(thrownLanding.lit)} lit from ` +
    `the can against ${beamLanding.mean.toFixed(2)}/255 and ${pct(beamLanding.lit)} from the ` +
    `beam — ${pct2(Math.abs(thrownLanding.mean - beamLanding.mean), beamLanding.mean)} apart, ` +
    `for a can and no energy; the two sounds' own near ground reads ` +
    `${thrownOwn.mean.toFixed(2)}/255 against ${beamOwn.mean.toFixed(2)}, which settles nothing`,
);

// ===========================================================================
//  10  the cairn: a stacked column against the floor it stands on (§8)
//
//  `world/cans.ts` justifies `CAN_STACK_PITCH` on a perceptual claim that nothing had ever
//  checked: a column of cairns "reads instantly as something a person stacked" because it is
//  locally denser than any patch of lattice can be — 0.12 m of glyph against 0.18 m of spacing.
//  That is a statement about pixels in a black room, so it is answerable, and it deserved
//  answering before anything else was stacked on top of it.
//
//  The reading is one Q-ping onto a wiped map, from a stand a few metres short of the column in
//  the north lane, and it is deliberately not a reading of the walk that got there: what a
//  player sees when a sound arrives is what the claim is about. The window is the column's own
//  silhouette, and the controls are four windows of exactly that size beside it at the same
//  screen rows — so both are looking at the same heights above the same floor at the same
//  range, and the only difference between them is that one has cans in it.
// ===========================================================================
await respawn();
await clearMap();
await page.keyboard.down('w');
await stepUntil((s) => Number(s.x) > 4.0, ticksFor(30000), 4);
await page.keyboard.up('w');
await step(1);
// North onto the lane first, then east along it. Pointing at the stack from anywhere further
// west means pointing through the tank, and walking at it means walking into the tank.
await turnTo(180, sens);
await page.keyboard.down('w');
await stepUntil((s) => Number(s.z) > 1.9, ticksFor(20000), 1);
await page.keyboard.up('w');
await stepUntil((s) => Number(s.speed) === 0, ticksFor(3000), 2);
await turnTo(-90, sens);
await page.keyboard.down('w');
await stepUntil((s) => Number(s.x) > 5.5, ticksFor(10000), 2);
await page.keyboard.up('w');
await stepUntil((s) => Number(s.speed) === 0, ticksFor(3000), 2);
const atStand = await state();
const column = atStand.canPoses[Math.floor(atStand.canPoses.length / 2)];
await turnTo(yawTo(Number(atStand.x), Number(atStand.z), column.x, column.z), sens);
// Pitched well down: at −30 the column projects into the reticle's rows and the reading would
// be of the reticle. The stand is close enough that the angle to the cairns is steep anyway.
await pitchBy(-40 - Number((await state()).pitchDeg), sens);
await clearMap();
await ping('q-ping');
await settleColour();
const cairnBuf = await shot('16-resting-print.png');

const atColumn = await state();
const stackPts = atColumn.canPoses.map((c) => project(atColumn, c));
const canPixels = (PIXELS_PER_TANGENT * 0.06) / mean(stackPts.map((p) => p.depth));
const COLUMN = {
  x: Math.round(Math.min(...stackPts.map((p) => p.x)) - canPixels),
  y: Math.round(Math.min(...stackPts.map((p) => p.y)) - canPixels),
  w: Math.round(2 * canPixels + spread(stackPts.map((p) => p.x))),
  h: Math.round(2 * canPixels + spread(stackPts.map((p) => p.y))),
};
const BESIDE = [-3, -2, 2, 3].map((k) => ({ ...COLUMN, x: Math.round(COLUMN.x + k * COLUMN.w) }));
const cairns = photo(cairnBuf, COLUMN, []);
const beside = BESIDE.map((r) => photo(cairnBuf, r, []));
const besideMean = mean(beside.map((b) => b.mean));
const besideLit = mean(beside.map((b) => b.lit));
const standRange = Math.hypot(
  column.x - Number(atColumn.x),
  column.z - Number(atColumn.z),
);
console.log(
  `  stood ${standRange.toFixed(2)} m off the column, ${COLUMN.w}x${COLUMN.h} px of silhouette ` +
    `at ${COLUMN.x},${COLUMN.y}\n  column ${cairns.mean.toFixed(2)}/255 ` +
    `(${pct(cairns.lit)} lit) · ` +
    `four windows beside it ${beside.map((b) => b.mean.toFixed(1)).join(', ')} ` +
    `(mean ${besideMean.toFixed(2)}/255, ${pct(besideLit)} lit)`,
);
check(
  'one ping, and every can in the column has a print on the map',
  Number(atColumn.canPrintsKnown) === atColumn.canPoses.length &&
    Number(atColumn.canPrintDots) === Number(atColumn.canPrintsKnown) * 7,
  `${atColumn.canPrintsKnown} of ${atColumn.canPrints} prints known, ` +
    `${atColumn.canPrintDots} dots — seven a can`,
);
check(
  'and the column reads denser than the floor lattice either side of it',
  domFree(COLUMN) &&
    BESIDE.every(domFree) &&
    cairns.mean > besideMean * 2 &&
    cairns.lit > besideLit * 2,
  `from ${standRange.toFixed(2)} m: ${cairns.mean.toFixed(2)}/255 and ${pct(cairns.lit)} lit ` +
    `against ${besideMean.toFixed(2)}/255 and ${pct(besideLit)} beside it — ` +
    `${times(cairns.mean, besideMean)} the brightness and ` +
    `${times(cairns.lit, besideLit)} the coverage`,
);

// ===========================================================================
//  11  the pickup: the print goes when the can does (law 2, at its smallest scale)
//
//  A cairn is drawn at a pose (`world/cans.ts`), so a cairn still on the floor after the can has
//  gone into the rack would be the system lying about a thing the player is standing on top of.
//  It is the smallest lie the game is capable of telling and one of the easiest to ship, because
//  nothing else in the frame would look wrong.
//
//  Two frames, and the trap they have to avoid: the lift is itself a `prop-knock`, so the floor
//  where the can was is *brighter* a moment after the pickup than a moment before. Read raw,
//  the after-frame wins and the print appears to have survived. So both frames are taken the
//  same way — wipe, one Q-ping, let the ramp cool — which makes the reveal identical and leaves
//  the cans as the only difference between them.
//
//  The window is a patch of *floor*, projected fresh in each frame from the same world square,
//  because the body is 0.5 m closer for the second one and a fixed pixel rectangle would be
//  looking at a different amount of ground. Its control is the same square of floor a stride to
//  either side, and what is compared is the excess: how much brighter the can's own patch is
//  than the floor around it. West of the chokepoint on purpose — the authored stack is 21 m
//  away, outside the Q-ping's reach, so the print counts below belong to this can alone.
// ===========================================================================
await respawn();
await clearMap();
await pitchBy(-35, sens);
const beforeToss = await state();
const tossed = await throwCan(1); // a tap: CAN_THROW_MIN, and a few metres of floor
const tossedId = newCanId(beforeToss, tossed);
await cansAtRest();
await settleInk();
const atRest = await state();
const restingCan = atRest.canPoses.find((c) => c.id === tossedId);
await turnTo(
  yawTo(Number(atRest.x), Number(atRest.z), restingCan.x, restingCan.z),
  sens,
);
// Stopped short of `CAN_REACH`, so the before-frame is of a can nobody has touched. Walking is
// 3.5 m/s, under `CAN_LIFT_SPEED`, which is what makes the second half of this a lift and not a
// boot — the same approach at a sprint is §12.
await page.keyboard.down('w');
await stepUntil(
  (s) => Math.hypot(restingCan.x - Number(s.x), restingCan.z - Number(s.z)) < 1.35,
  ticksFor(8000),
  1,
);
await page.keyboard.up('w');
await stepUntil((s) => Number(s.speed) === 0, ticksFor(2000), 2);
await pitchBy(-40 - Number((await state()).pitchDeg), sens);

/** The screen rectangle a square of floor `2·half` across, centred on a world point, occupies. */
function floorPatch(s, at, half) {
  const pts = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].map(([u, v]) => project(s, { x: at.x + u * half, y: 0, z: at.z + v * half }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    x: Math.round(Math.min(...xs)),
    y: Math.round(Math.min(...ys)),
    w: Math.max(2, Math.round(spread(xs))),
    h: Math.max(2, Math.round(spread(ys))),
  };
}
/** The same patch, one stride left and one stride right of it across the camera's own axis. */
function floorBeside(s, at, half, metres) {
  const yaw = (Number(s.yawDeg) * Math.PI) / 180;
  return [-1, 1].map((k) =>
    floorPatch(
      s,
      { x: at.x + k * metres * Math.cos(yaw), z: at.z - k * metres * Math.sin(yaw) },
      half,
    ),
  );
}
async function readCairnFloor(name) {
  await clearMap();
  await ping('q-ping');
  await settleColour();
  const buf = await shot(name);
  const s = await state();
  const on = floorPatch(s, restingCan, 0.12);
  const off = floorBeside(s, restingCan, 0.12, 0.6);
  const cairn = photo(buf, on, []);
  const floor = mean(off.map((r) => photo(buf, r, []).mean));
  return { s, on, off, cairn, floor, excess: cairn.mean - floor };
}
const before = await readCairnFloor('17-pickup.png');
await page.keyboard.down('w');
const took = await stepUntil(
  (s) => Number(s.carriedCans) > Number(before.s.carriedCans),
  ticksFor(4000),
  1,
);
await page.keyboard.up('w');
await stepUntil((s) => Number(s.speed) === 0, ticksFor(2000), 2);
// Back to the stand the first picture was taken from. The lift fires at `CAN_REACH`, so a body
// that stops where it stopped is a third of a metre from the floor it is being asked about, and
// a patch of ground that close is half a screen tall and running off the bottom of it. Backing
// off costs nothing: both frames wipe the map and re-light it with one ping, so the walk back
// is not in either picture.
await page.keyboard.down('s');
await stepUntil(
  (s) => Math.hypot(restingCan.x - Number(s.x), restingCan.z - Number(s.z)) > 0.9,
  ticksFor(4000),
  1,
);
await page.keyboard.up('s');
await stepUntil((s) => Number(s.speed) === 0, ticksFor(2000), 2);
const after = await readCairnFloor('17b-pickup-taken.png');
console.log(
  `  can at rest ${Math.hypot(
    restingCan.x - Number(beforeToss.x),
    restingCan.z - Number(beforeToss.z),
  ).toFixed(2)} m out · lifted from ` +
    `${Math.hypot(restingCan.x - Number(took.x), restingCan.z - Number(took.z)).toFixed(2)} m\n` +
    `  its patch of floor ${before.on.w}x${before.on.h} px: ${before.cairn.mean.toFixed(2)}/255 ` +
    `against ${before.floor.toFixed(2)} beside it (excess ${before.excess.toFixed(2)})\n` +
    `  the same square after the lift ${after.on.w}x${after.on.h} px: ` +
    `${after.cairn.mean.toFixed(2)}/255 against ${after.floor.toFixed(2)} (excess ` +
    `${after.excess.toFixed(2)})`,
);
check(
  'a can that has come to rest puts a cairn on the floor where it lies',
  domFree(before.on) && Number(before.s.canPrintDots) === 7 && before.excess > 4,
  `${before.cairn.mean.toFixed(2)}/255 on the can's own square of floor against ` +
    `${before.floor.toFixed(2)}/255 a stride either side, ` +
    `${before.s.canPrintDots} print dots known`,
);
check(
  'and walking into it takes the cairn away with the can',
  Number(after.s.carriedCans) === Number(before.s.carriedCans) + 1 &&
    Number(after.s.worldCans) === Number(before.s.worldCans) - 1 &&
    Number(after.s.canPrintDots) === 0,
  `rack ${before.s.carriedCans} → ${after.s.carriedCans}, cans in the world ` +
    `${before.s.worldCans} → ${after.s.worldCans}, print dots ` +
    `${before.s.canPrintDots} → ${after.s.canPrintDots}`,
);
check(
  'leaving floor that reads like floor',
  domFree(after.on) && Math.abs(after.excess) < before.excess * 0.25,
  `excess over the surrounding floor ${before.excess.toFixed(2)}/255 before the lift, ` +
    `${after.excess.toFixed(2)}/255 after`,
);

// ===========================================================================
//  12  the stack: the same column, walked up to and sprinted through (§8)
//
//  §8 prices the stack as a fork rather than an obstacle: walk up with room in the rack and you
//  mine it off the top for four soft knocks, sprint the same line and you boot it across the
//  loudest lane in the room. Two passes, one difference, and the frames have to be able to tell
//  them apart — the whole point of authoring a prop as a sound trap is that the wrong approach
//  is *visible* to everything with ears, and this suite is the only thing here that has eyes.
//
//  The rack starts full, so both passes empty it into the floor at spawn first: with four cans
//  already carried there is no room to mine into, and the difference under test would be a
//  difference in pockets rather than in speed.
//
//  Both frames are taken looking **up**. Reading the floor was tried first and it cannot answer:
//  the rig is standing next to the column when the picture is taken, so its own footsteps have
//  painted every square metre within four of it and the near floor is bright in both passes —
//  measured, 14.2 against 14.7 out of 255, which is no answer at all. The ceiling is 7 m up,
//  past a walk-step's 4 m and at the very limit of a sprint-step's 7, and a boot's `prop-impact`
//  carries 11 m from the floor — so what is overhead is lit by the cans coming down and by
//  almost nothing else. That the fork is priced twice, once in gait and once in what your leg
//  does to the column, is not a confound to be subtracted: it is what §8 means by the loud lane.
// ===========================================================================
const CEILING = { x: 360, y: 376, w: 650, h: 254 };
/**
 * Four cans straight into the floor at the rig's feet.
 *
 * Down rather than out, because a can released at the ceiling of its arc lands where the pass is
 * about to run and would be kicked twice. `CAN_REARM_M` leaves these four inert until the walk
 * east has taken the body 1.5 m clear of them, which is the same rule that makes a throw-cancel
 * a priced abort rather than a pickup loop.
 */
async function emptyTheRack() {
  await pitchBy(-80 - Number((await state()).pitchDeg), sens);
  while (Number((await state()).carriedCans) > 0) {
    await throwCan(1);
    await cansAtRest();
  }
  await pitchBy(0 - Number((await state()).pitchDeg), sens);
}
/**
 * One pass down the north lane at one speed, photographed from where it ends.
 *
 * `laneZ` is the whole fork's other half. The stack stands at z = 1.8; reach is a 0.6 m cylinder
 * and the body is 0.35 m across (`game/throwables.ts`), so a lane between those two — 2.15 to
 * 2.37 m — is one the arm can mine and the leg never touches. That quarter-metre is where §8's
 * "walk up ... and mine it off the top" actually lives, and running it is what turns the same
 * 0.22 m of floor into five cans across the lane.
 */
async function lanePass(name, keys, laneZ, releaseX) {
  await respawn();
  await emptyTheRack();
  await page.keyboard.down('w');
  await stepUntil((s) => Number(s.x) > 4.6, ticksFor(30000), 4);
  await page.keyboard.up('w');
  await step(1);
  await turnTo(180, sens);
  await page.keyboard.down('w');
  await stepUntil((s) => Number(s.z) > laneZ - 0.22, ticksFor(20000), 1);
  await page.keyboard.up('w');
  await stepUntil((s) => Number(s.speed) === 0, ticksFor(3000), 2);
  await turnTo(-90, sens);
  const lane = await state();
  await clearMap();
  for (const k of keys) await page.keyboard.down(k);
  const crossing = await stepUntil((s) => Number(s.x) > releaseX, ticksFor(12000), 1);
  for (const k of keys) await page.keyboard.up(k);
  await stepUntil((s) => Number(s.speed) === 0, ticksFor(4000), 2);
  await cansAtRest();
  await settleInk();
  await turnTo(90, sens);
  await pitchBy(65 - Number((await state()).pitchDeg), sens);
  await settleInk();
  const buf = await shot(name);
  const s = await state();
  const left = s.canPoses.filter((c) => c.x > 5);
  return {
    s,
    lane,
    speed: Number(crossing.speed),
    left,
    strewn: left.length > 1 ? spread(left.map((c) => c.x)) : 0,
    up: photo(buf, CEILING, []),
  };
}
const minePass = await lanePass('18-stack-mined.png', ['w'], 2.26, 9.3);
const bootPass = await lanePass('18b-stack-booted.png', ['Shift', 'w'], 1.8, 8.9);
console.log(
  `  walked the lane at z=${Number(minePass.lane.z).toFixed(2)}, ` +
    `${minePass.speed.toFixed(2)} m/s: rack ${minePass.s.carriedCans}, ` +
    `${minePass.left.length} can(s) still by the tank, ` +
    `${minePass.s.structUnlockedDots} dots, ceiling ${minePass.up.mean.toFixed(2)}/255 ` +
    `(${pct(minePass.up.lit)} lit)\n` +
    `  sprinted it at z=${Number(bootPass.lane.z).toFixed(2)}, ` +
    `${bootPass.speed.toFixed(2)} m/s: rack ${bootPass.s.carriedCans}, ` +
    `${bootPass.left.length} can(s) strewn over ` +
    `${bootPass.strewn.toFixed(2)} m, ${bootPass.s.structUnlockedDots} dots, ceiling ` +
    `${bootPass.up.mean.toFixed(2)}/255 (${pct(bootPass.up.lit)} lit)`,
);
check(
  'walking the mining lane takes the column apart and leaves one can standing',
  Number(minePass.s.carriedCans) === 4 && minePass.left.length === 1 && minePass.strewn === 0,
  `rack ${minePass.s.carriedCans} of 4, ${minePass.left.length} can left at ` +
    `(${minePass.left[0]?.x.toFixed(2)}, ${minePass.left[0]?.z.toFixed(2)}) — the one the arm ` +
    `could not pocket and the leg never reached`,
);
check(
  'sprinting the column line pockets nothing and puts five cans across the lane',
  Number(bootPass.s.carriedCans) === 0 && bootPass.left.length === 5 && bootPass.strewn > 0.5,
  `rack ${bootPass.s.carriedCans}, ${bootPass.left.length} cans spread over ` +
    `${bootPass.strewn.toFixed(2)} m of floor at ${bootPass.speed.toFixed(2)} m/s`,
);
check(
  'and the two frames say which of them was the loud one',
  bootPass.up.mean > minePass.up.mean * 2.5 && bootPass.up.lit > minePass.up.lit * 2.5,
  `ceiling ${minePass.up.mean.toFixed(2)}/255 and ${pct(minePass.up.lit)} lit after the mine, ` +
    `${bootPass.up.mean.toFixed(2)}/255 and ${pct(bootPass.up.lit)} after the boot — ` +
    `${times(bootPass.up.mean, minePass.up.mean)} the light for the same six metres of lane`,
);

// ===========================================================================
//  13  the rack: four dots that are four dots, and a centre that goes dark again
//
//  `world/cans.ts` justifies a four-can rack on a perceptual claim — "humans subitize up to
//  four: a four-pip readout is *perceived*, not counted" — and `ui/hud.ts` spends that claim on
//  a row 18 px wide with 2 px between the dots, tucked inside a 30 px ring. Subitizing four
//  things requires four things. At three pixels a dot, with the browser antialiasing a
//  border-radius circle, "four dots" and "a dash" are the same amount of ink and it is the gaps
//  that decide which one a player sees. Nothing but a decoded frame can answer that.
//
//  It also settles a worry that turns out not to exist. The reveal is bloomed and 3 px of cyan
//  1.3 px inside a 2 px cyan ring sounds like a smear waiting to happen — but the row is DOM
//  over the canvas and the bloom pass runs on the renderer's target, so it never touches these
//  pixels. The columns below are the proof rather than the argument.
//
//  Two claims, and the second is the one the rest of this file depends on. §14 rules out a
//  minimap, a compass and objective markers, and a permanently lit glyph at the centre of a
//  black screen is the same thing wearing a smaller footprint: the row has to *leave*. And every
//  photometric golden in this suite is a reading of the frame minus a 40 px hole at the centre
//  (`FRAME_HOLES`), so a row that painted one pixel outside it would move all of them at once —
//  which is why the strip read here is bounded by the ring's own inner edge and the ring by the
//  hole.
// ===========================================================================
/**
 * The strip of screen the four pips live in, and the two bands beside it.
 *
 * `ui/hud.ts` puts the row's centre 6 px below the screen centre, 3 px tall and 18 px wide, so
 * the pips occupy rows 364-367 and columns 631-648. The strip is 22 px of that row: wide enough
 * to catch a pip that has walked sideways, narrow enough to stay clear of the Halo ring, whose
 * stroke crosses this row at x ~ 626 and ~ 654 (a 30 px circle is 13.7 px wide at 6 px off its
 * own centre). Row 363 is left out — the reticle's disc ends at 362.5 and its antialiasing does
 * not.
 */
const PIP_STRIP = { x: 629, y: 364, w: 22, h: 4 };
/** Columns the four pips sit on, and the three gaps between them — `RACK_PIP_GAP_PX` apart. */
const PIP_COLUMNS = [
  [631, 633],
  [636, 638],
  [641, 643],
  [646, 648],
];
const PIP_GAPS = [
  [634, 635],
  [639, 640],
  [644, 645],
];
/**
 * One pixel's luminance out of a decoded frame.
 *
 * `channels` and not 4: `tools/png.mjs` decodes colour type 2 as three bytes a pixel and type 6
 * as four, and a Playwright screenshot of an opaque page is type 2. Assuming RGBA reads every
 * fourth byte of a three-byte stride, which does not fail — it returns a plausible, wrong,
 * period-3 pattern that looks like a rendering artefact and costs an afternoon.
 */
function luminanceAt(img, col, row) {
  const i = (row * img.width + col) * img.channels;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
}
/** Peak luminance down a column range of the pip strip — the brightest row of those four. */
function stripProfile(buf) {
  const img = decodePng(buf);
  const at = ([from, to]) => {
    let best = 0;
    for (let col = from; col <= to; col++) {
      for (let row = PIP_STRIP.y; row < PIP_STRIP.y + PIP_STRIP.h; row++) {
        const l = luminanceAt(img, col, row);
        if (l > best) best = l;
      }
    }
    return best;
  };
  return { pips: PIP_COLUMNS.map(at), gaps: PIP_GAPS.map(at) };
}
/**
 * Every lit pixel of the row, as a box measured from the screen centre.
 *
 * Read over a 60 px square rather than over the 40 px hole, so that a row which had escaped the
 * hole would be *seen* escaping rather than silently cropped to the edge of the window looking
 * for it. The room is black and wiped for these frames, so anything lit in here is chrome.
 */
function rowInk(buf) {
  const img = decodePng(buf);
  const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity, lit: 0 };
  for (let row = 330; row < 390; row++) {
    for (let col = 610; col < 670; col++) {
      const dx = col - 640;
      const dy = row - 360;
      // The reticle and the ring are the centre's other two tenants, and they are drawn in both
      // frames: the disc out to 3 px, the ring's stroke from 13 px out. Between them is a 10 px
      // annulus that belongs to nothing else, and the row's own furthest corner is 11.7 px out —
      // which is `ui/hud.ts`'s stated clearance, read here rather than taken on trust.
      const r2 = dx * dx + dy * dy;
      if (r2 <= 16 || r2 >= 144) continue;
      if (luminanceAt(img, col, row) < 8) continue;
      box.lit++;
      box.left = Math.min(box.left, dx);
      box.right = Math.max(box.right, dx);
      box.top = Math.min(box.top, dy);
      box.bottom = Math.max(box.bottom, dy);
    }
  }
  return box;
}

await respawn();
await pitchBy(0 - Number((await state()).pitchDeg), sens);
await clearMap();
// A run opens with a full rack, which is a change from the readout's own zero, so the row states
// the count once at spawn. Wait it out: what "dark" means here is *after* everything the boot
// had to say, and a frame taken inside that first showing would call a working row a stuck one.
await step(ticksFor(2500));
await settleInk();
const idleFrame = await frame();
const idle = rowInk(idleFrame);

// Winding, not throwing. `charging` is a level rather than an edge (`ui/hud.ts`), so the row is
// up for as long as the arm is back and the frame can be taken at leisure — and the wind-up's
// paint is 0.5 m around the eye, which at a level aim is floor far below the bottom of the
// screen and nothing at all in the strip below.
await page.keyboard.down('f');
await stepUntil((s) => s.charging === true, 30, 1);
await step(ticksFor(200));
const fullFrame = await shot('19-rack-pips.png');
const full = stripProfile(fullFrame);
const fullInk = rowInk(fullFrame);
await page.keyboard.up('f');
await cansAtRest();

// Two cans down, and the same picture again: the count is the only thing that changed.
await throwCan(1);
await cansAtRest();
await page.keyboard.down('f');
await stepUntil((s) => s.charging === true, 30, 1);
await step(ticksFor(200));
const twoFrame = await frame();
const two = stripProfile(twoFrame);
await page.keyboard.up('f');
await cansAtRest();
const twoState = await state();

console.log(
  `  idle centre: ${idle.lit} lit pixel(s) in the rack's own strip\n` +
    `  full rack → pips ${full.pips.map((v) => v.toFixed(0)).join(', ')} ` +
    `· gaps ${full.gaps.map((v) => v.toFixed(0)).join(', ')}\n` +
    `  rack ${twoState.carriedCans} → pips ${two.pips.map((v) => v.toFixed(0)).join(', ')} ` +
    `· gaps ${two.gaps.map((v) => v.toFixed(0)).join(', ')}\n` +
    `  row ink x ∈ [${fullInk.left}, ${fullInk.right}], y ∈ [${fullInk.top}, ${fullInk.bottom}] ` +
    `px from centre, ${fullInk.lit} lit`,
);
check(
  'the centre of a black screen is black again once the rack has finished speaking',
  idle.lit === 0,
  `${idle.lit} lit pixel(s) below the reticle after the boot showing expired — ` +
    `§14 gets no exception for chrome that is only 18 px wide`,
);
check(
  'a wind-up puts four separate dots there, not a dash',
  full.pips.every((v) => v > 60) && full.gaps.every((g) => g < Math.min(...full.pips) * 0.6),
  `pips ${full.pips.map((v) => v.toFixed(0)).join('/')} against gaps ` +
    `${full.gaps.map((v) => v.toFixed(0)).join('/')} out of 255 — the dimmest dot is ` +
    `${times(Math.min(...full.pips), Math.max(...full.gaps))} the brightest gap`,
);
check(
  'and the row says how many, by filling from the left',
  Number(twoState.carriedCans) === 3 &&
    two.pips[0] > 60 &&
    two.pips[1] > 60 &&
    two.pips[2] > 60 &&
    two.pips[3] < two.pips[2] * 0.5,
  `carrying ${twoState.carriedCans}: ${two.pips.map((v) => v.toFixed(0)).join('/')} — the spent ` +
    `slot is still drawn, at ${pct2(two.pips[3], two.pips[2])} of a full one, because the ` +
    `readout's claim is "three of four" and not "three"`,
);
check(
  'and every pixel of it is inside the 40 px hole the rest of this file measures around',
  fullInk.lit > 0 &&
    Math.max(Math.abs(fullInk.left), Math.abs(fullInk.right)) <= 20 &&
    Math.max(Math.abs(fullInk.top), Math.abs(fullInk.bottom)) <= 20,
  `x ∈ [${fullInk.left}, ${fullInk.right}], y ∈ [${fullInk.top}, ${fullInk.bottom}] px from ` +
    `centre against the hole's ±20 — a pixel outside it is counted as world paint by every ` +
    `mean-luminance golden above`,
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
