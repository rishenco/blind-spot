#!/usr/bin/env node
/**
 * Verification run (engine-plan §10).
 *
 * Builds, serves `dist/` from a tiny static server, drives it in Playwright chromium and drops
 * screenshots into `verify-out/` (git-ignored). Asserts boot + console cleanliness on every
 * capture. Milestone 1 verifies the boot screen and the top-down debug view, milestone 2 adds the
 * two scripted movement routes (`?sim=script`, `?sim=script2`) and reads the route out of the
 * debug trail as well as out of the end state. Milestone 3 adds the FIRST-PERSON captures: the
 * black world, the world after a scripted route has painted it, the world a test detonation
 * lights, and the F3 numbers behind all three. Milestone 4 adds the sonar route (`?sim=script3`)
 * and runs the detonation at a second window size.
 *
 * Every capture measures TWO inks, and the difference matters:
 *   - `ink`   — the 2D debug overlay canvas (`#overlay canvas`), read with getImageData.
 *   - `glInk` — the first-person WebGL drawing buffer, read with readPixels inside the page
 *               (`window.blindspot.ink()`), which renders and reads back in the same task
 *               because a drawing buffer is undefined the moment you yield. Three thresholds and
 *               one structure: `lit` is paint, `any` also catches the 2 m contact shell, which is
 *               meant to be nearly invisible (vision §3.1), `white` is saturation, and
 *               `whiteBlob` is the largest connected run of saturated pixels — the only one of
 *               the four that can tell a field of separate dots from a sheet.
 * A black screenshot that should show paint is a FAILURE even when every number passes, so the
 * captures are written to be looked at as well as asserted on.
 *
 * WHAT MAKES AN INK FRACTION COMPARABLE AT ALL. The near-field splat cap is a fraction of frame
 * HEIGHT (looks/debug), so a capped dot's area scales as H² while the number of dots a surface
 * puts on screen scales as W/H — their product is W·H, and a coverage FRACTION is therefore a
 * property of the image rather than of the window. That is what lets a fence be written once and
 * mean the same thing in every window, and `fp-detonation` is run at two materially different
 * viewports to assert it instead of assuming it.
 *
 *   node scripts/verify.mjs [--no-build] [--port 4180]
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'verify-out');
const CHROMIUM = '/opt/pw-browsers/chromium';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(opt('--port', '4180'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function run(cmd, cmdArgs) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${cmdArgs.join(' ')} exited ${code}`))));
    p.on('error', fail);
  });
}

function serve(dir, port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = join(dir, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(dir)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

const problems = [];
const note = (m) => console.log(`  ${m}`);
const pct = (v) => `${(v * 100).toFixed(3)}%`;

function assertAll(name, table) {
  for (const [label, ok] of Object.entries(table)) {
    if (!ok) problems.push(`${name}: failed check "${label}"`);
  }
}

/**
 * The reference viewport every measured figure in this file is quoted at, and one materially
 * different in BOTH size and aspect (1.60 vs 1.78) for the scale-stability pair.
 */
const VIEWPORT = { width: 1600, height: 1000 };
const VIEWPORT_SMALL = { width: 1280, height: 720 };

/**
 * One capped dot's area in pixels, at a frame `h` px tall — the unit the structural fences below
 * are written in, so that they say the same thing at every window size.
 *
 * The near-field cap is a fraction of frame HEIGHT and the splat is round (the dot fragment shader
 * discards outside r = 0.5), so a dot drawn at the cap covers π·(frac·h/2)² px. The fraction is
 * read out of the look rather than copied into this file: it is look-private tuning (visual-brief
 * §2), and a gate that hard-codes the number it is measuring against stops measuring the day the
 * number moves.
 */
const capMatch = /const SPLAT_CAP_FRAC = ([0-9.]+)/.exec(
  await readFile(join(ROOT, 'src/looks/debug/index.ts'), 'utf8'),
);
if (!capMatch) throw new Error('SPLAT_CAP_FRAC not found in src/looks/debug/index.ts');
const SPLAT_CAP_FRAC = Number(capMatch[1]);
const dotArea = (h) => Math.PI * ((SPLAT_CAP_FRAC * h) / 2) ** 2;

/**
 * ANTI-SHEET GUARD, in dot areas (vision §12: "visual porridge must be structurally impossible").
 *
 * A coverage percentage cannot tell a cloud from a sheet: a frame of separate saturated dots and a
 * frame with one saturated rectangle can read the same percentage, and only the second has lost
 * the near-field read. So the largest connected run of saturated pixels is fenced instead, in
 * units of one capped dot.
 *
 * DERIVATION. Measured, at the peak of a point-blank detonation: 1.03 dot areas at 1600×1000,
 * 1.06 at 1280×720, 1.04 at 1920×1080, 1.03 at 1366×768 — one dot, everywhere, because capped
 * dots at a 46 px lattice pitch cannot touch. (Just over 1.00 because a rasterised disc covers a
 * few more pixels than πr².) The threshold is set an order of magnitude above that: a dozen dots
 * would have to fuse into one connected region before it trips, which no measured frame comes
 * within 11× of. The failure it exists for is far above even that — building the same capture
 * with the cap lifted (splats at their raw footprint, the pre-cap behaviour) puts the largest blob
 * at 478 dot areas at 1600×1000 and 353 at 1280×720, i.e. 40× and 29× over this line.
 */
const SHEET_BLOB_DOTS = 12;

/** How far two ink fractions measured at different viewports may disagree (see the header). */
const SCALE_TOL = 0.15;

/**
 * In-page recorder, installed before the page's own scripts. One row per frame —
 * [sim time, painted dots, energy, audible radius] — plus the worst white frame inside the sim
 * seconds `inkFrom .. inkTo`.
 *
 * Ink is a full render plus a readback, so it is sampled across the window a capture actually
 * asks about and not for the whole route. The rest is four numbers a frame and costs nothing.
 */
function traceScript(win) {
  window.__trace = [];
  window.__peak = null;
  window.__peakT = -1;
  const tick = () => {
    const bs = window.blindspot;
    if (bs) {
      const t = bs.sim.time;
      const ps = bs.sim.playerSystems;
      window.__trace.push([t, bs.field.paintedDots, ps.energy, ps.audibleRadius]);
      if (t >= win.inkFrom && t <= win.inkTo) {
        const ink = bs.ink();
        if (!window.__peak || ink.white > window.__peak.white) {
          window.__peak = ink;
          window.__peakT = t;
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function capture(browser, name, query, checks, opts = {}) {
  const viewport = opts.viewport ?? VIEWPORT;
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // Watch the run from its first frame. A scripted route is over before an `evaluate` issued from
  // node could install anything, and everything a sonar capture needs to see happens mid-route:
  // the painted count in the silence before the press, the dip in the reactor, the halo's peak.
  // An init script runs before the page's own scripts do, so no frame is missed.
  if (opts.trace) await page.addInitScript(traceScript, opts.trace);

  // EVERY capture states its roster, and the default is NOBODY (core/roster.ts). A patrolling dog
  // emits every 0.8 m and a beacon hums every 4 s whether or not anyone is listening, so a world
  // with either in it cannot reproduce a number measured in a world without them — paint is one
  // shared buffer and the dot count is the sum of everything that ever sounded. A capture that
  // is ABOUT a dog says so in its own query and overrides this.
  const q = new URLSearchParams(query.replace(/^\?/, ''));
  if (!q.has('dogs')) q.set('dogs', 'none');
  if (!q.has('props')) q.set('props', 'none');
  await page.goto(`http://127.0.0.1:${PORT}/index.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.blindspot), null, { timeout: 15000 });
  if (opts.scripted) {
    // Scripted mode steps a fixed number of times per frame, so the route takes as long as the
    // browser needs and not a second of wall clock more — wait on the route, never on a timer.
    await page.waitForFunction(() => window.blindspot.script?.done === true, null, { timeout: 60000 });
  }
  await page.waitForTimeout(600);

  let trace = null;
  if (opts.trace) {
    trace = await page.evaluate((quietUntil) => {
      const rows = window.__trace;
      let minEnergy = Infinity;
      let maxAudible = 0;
      let paintedQuiet = -1;
      let gap = 0;
      for (let i = 0; i < rows.length; i++) {
        minEnergy = Math.min(minEnergy, rows[i][2]);
        maxAudible = Math.max(maxAudible, rows[i][3]);
        if (rows[i][0] < quietUntil) paintedQuiet = rows[i][1];
        if (i > 0) gap = Math.max(gap, rows[i][0] - rows[i - 1][0]);
      }
      return {
        rows: rows.length,
        gap,
        paintedQuiet,
        minEnergy,
        maxAudible,
        peak: window.__peak,
        peakT: window.__peakT,
      };
    }, opts.trace.quietUntil);
  }

  // ---------------------------------------------------------------------------------------
  // F7 through the REAL key (engine-plan §10, §11). Not `blindspot.detonate()`: the point of
  // the capture is that the hotkey is wired, that the event goes out on the ordinary bus with
  // no special-casing, and that what comes back is paint. Before/after on both sides.
  // ---------------------------------------------------------------------------------------
  let blast = null;
  if (opts.detonate) {
    const sample = () =>
      page.evaluate(() => ({
        painted: window.blindspot.field.paintedDots,
        detonations: window.blindspot.sim.bus.counts.detonation,
        pending: window.blindspot.stats().paintPending,
        ink: window.blindspot.ink(),
      }));
    const before = await sample();
    // Watch every frame from here on, through the flash and out the other side. Two different
    // things need per-frame sampling, and neither survives being read once:
    //
    //   `paintPending` is the STRUCTURAL discriminator for the schedule: a blast painted whole
    //   inside `hear()` would show a peak of zero, because it would be finished before the next
    //   frame ever ran. A wall-clock ceiling cannot tell those two apart — a fast machine passes
    //   it either way.
    //
    //   WHITE peaks in the first tenth of a second and is half gone a second later. The peak is
    //   the only honest reading of saturation, and the peak FRAME is kept whole — its blob
    //   included — so the anti-sheet guard runs on the worst frame rather than a convenient one.
    //   The peak's instant is measured from the frame the detonation first appears on the bus,
    //   not from the keypress, which node cannot time inside the page.
    await page.evaluate((flashMs) => {
      const st = { pendPeak: 0, pendFrames: 0, frames: 0, blastAt: 0, peakMs: -1, peak: null, done: false };
      window.__watch = st;
      const until = performance.now() + flashMs;
      const tick = () => {
        const s = window.blindspot.stats();
        if (s.paintPending > st.pendPeak) st.pendPeak = s.paintPending;
        if (s.paintPending > 0) st.pendFrames++;
        if (!st.blastAt && window.blindspot.sim.bus.counts.detonation > 0) st.blastAt = performance.now();
        const ink = window.blindspot.ink();
        st.frames++;
        if (!st.peak || ink.white > st.peak.white) {
          st.peak = ink;
          st.peakMs = st.blastAt ? Math.round(performance.now() - st.blastAt) : -1;
        }
        if (performance.now() < until) requestAnimationFrame(tick);
        else st.done = true;
      };
      requestAnimationFrame(tick);
    }, 1500);
    await page.keyboard.press('F7');
    // A detonation's wavefront takes paintRadius / WAVE_SPEED_DETONATION = 22/140 = 157 ms to
    // finish arriving, plus the late bound a patch is released on (one patch radius plus the
    // fuzz allowance, ~21 ms) — call it 180 ms (vision §3.3, engine-plan §3–§4). So a second
    // later `after` is the SETTLED world: every dot the blast painted is on screen and none of
    // them is fresh. That is what it is asserted on — coverage, not brightness.
    await page.waitForTimeout(1000);
    const after = await sample();
    await page.waitForFunction(() => window.__watch.done === true, null, { timeout: 30000 });
    const watch = await page.evaluate(() => window.__watch);
    blast = {
      before,
      after,
      peak: watch.peak,
      peakMs: watch.peakMs,
      schedule: { peak: watch.pendPeak, frames: watch.pendFrames, inkFrames: watch.frames },
    };
  }

  const state = await page.evaluate(() => {
    const sim = window.blindspot.sim;
    const p = sim.player;
    const m = sim.movement;
    const trail = window.blindspot.debug.trailPoints;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < trail.length; i += 2) {
      minX = Math.min(minX, trail[i]);
      maxX = Math.max(maxX, trail[i]);
      minZ = Math.min(minZ, trail[i + 1]);
      maxZ = Math.max(maxZ, trail[i + 1]);
    }
    // Ink coverage of the debug overlay canvas: the fraction of pixels carrying any real
    // luminance. A screenshot proves a file was written, not that anything was DRAWN — an
    // empty canvas, a black-on-black palette or a crash mid-draw all still screenshot fine.
    // Low ink = the drawing is missing; very high ink = a runaway fill has flooded it.
    let ink = 0;
    const canvas = document.querySelector('#overlay canvas');
    if (canvas) {
      const g = canvas.getContext('2d');
      const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
      }
      ink = lit / (d.length / 4);
    }
    return {
      boot: document.getElementById('boot')?.classList.contains('hidden') ?? false,
      topDown: window.blindspot.debug.state.topDown,
      // Milestone 3. `stats()` and `extraLines()` are the SAME numbers the F3 panel prints
      // (core/debug.ts `extraLines`), so asserting on them is asserting on the overlay.
      stats: window.blindspot.stats(),
      f3: window.blindspot.debug.extraLines ? window.blindspot.debug.extraLines() : [],
      glInk: window.blindspot.ink(),
      // The floor within arm's reach, in the bottom-centre sixth of the frame. Vision §3.1
      // measures the contact shell from the BODY, and this box is where that claim is visible:
      // standing, the eye is 1.7 m up, so the floor only enters the frame past 1.64 m and the
      // shell's own edge is at 2 m — a thin arc at the bottom. A shell measured from the EYE
      // instead reaches only 1.05 m of floor and would leave this box completely black.
      feetInk: window.blindspot.ink([0.3, 0.0, 0.4, 0.16]),
      // The control: the same box lifted to eye level, where a body-measured shell reaches
      // nothing at all. Two boxes make the claim falsifiable; one only says "there is ink".
      eyeInk: window.blindspot.ink([0.3, 0.42, 0.4, 0.16]),
      solids: sim.world.solids.length,
      walkables: sim.world.walkables.length,
      steps: sim.steps,
      map: sim.map.name,
      ink,
      webgl: Boolean(document.querySelector('#app canvas')),
      scriptDone: window.blindspot.script?.done ?? null,
      pos: [p.x, p.y, p.z],
      stance: p.stance,
      hands: m.hands,
      lastFall: m.lastFall,
      events: sim.bus.emitted,
      counts: sim.bus.counts,
      trail: { n: trail.length / 2, minX, maxX, minZ, maxZ },
      fov: window.blindspot.rig.fov,
      dog2On: sim.map.dogRoutes.find((r) => r.id === 'dog2')?.defaultOn ?? null,
      // What the LOOK is given (core/dog.ts DogView): poses on screen now, ghosts remembered.
      dogs: sim.dogs.views.map((d) => ({
        poses: d.poseHistory.length,
        ghosts: d.ghosts.length,
        quality: d.lastEventQuality,
        cloud: d.cloudGeom.getAttribute('position').count,
      })),
      // The delivered feed itself, filtered to the dog: the Lantern read, event by event.
      dogHeard: (() => {
        const r = window.blindspot.paint.recent(96).filter((e) => e.source === 'dog');
        return {
          n: r.length,
          walls: [...new Set(r.map((e) => e.wallsToListener))].sort(),
          maxQuality: r.length ? Math.max(...r.map((e) => e.quality)) : -1,
          minQuality: r.length ? Math.min(...r.map((e) => e.quality)) : -1,
          classes: [...new Set(r.map((e) => e.class))].sort(),
        };
      })(),
    };
  });

  // The debug hotkeys are only reachable here: they live on a `window` keydown listener, and no
  // DOM environment is installed for vitest. This round trip proves the whole chain — real key,
  // real handler, real mutation of THIS Sim's own map — and restores the flag it flipped.
  let hotkeys = null;
  if (opts.hotkeys) {
    const read = () =>
      page.evaluate(() => window.blindspot.sim.map.dogRoutes.find((r) => r.id === 'dog2')?.defaultOn ?? null);
    const before = await read();
    await page.keyboard.press('F6');
    const flipped = await read();
    await page.keyboard.press('F6');
    const restored = await read();
    hotkeys = { before, flipped, restored };
  }

  const shot = join(OUT, `${name}.png`);
  await page.screenshot({ path: shot });
  await page.close();

  const f2 = (v) => v.toFixed(2);
  console.log(`- ${name}${query || ''}`);
  note(`map ${state.map} · ${state.solids} solids · ${state.walkables} walkable tops · ${state.steps} sim steps`);
  note(`boot hidden ${state.boot} · top-down ${state.topDown} · webgl canvas ${state.webgl}`);
  note(`overlay ink ${(state.ink * 100).toFixed(2)}%`);
  const st = state.stats;
  note(
    `surfels ${st.surfels} dots · ${st.edges} edges (${st.holds} holds) · ${st.patches} patches` +
      ` · bake ${st.bakeMs.toFixed(0)} ms`,
  );
  note(
    `painted ${st.paintedDots} dots · ${st.paintedEdgeVerts} edge verts · heard ${st.heard}` +
      ` missed ${st.missed} · paint worst ${st.paintMaxMs.toFixed(2)} ms/frame · pending ${st.paintPending}`,
  );
  const dots = (ink) => (ink.whiteBlob / dotArea(ink.height)).toFixed(2);
  note(
    `first-person ink lit ${pct(state.glInk.lit)} · any ${pct(state.glInk.any)}` +
      ` · white ${pct(state.glInk.white)} (blob ${dots(state.glInk)} dots)` +
      ` · ${state.glInk.width}x${state.glInk.height} · look ${st.look} · ${st.drawCalls} draw calls` +
      ` · ${st.fps.toFixed(1)} fps`,
  );
  if (blast) {
    note(
      `F7 detonation: painted ${blast.before.painted} → ${blast.after.painted} dots · ink lit ` +
        `${pct(blast.before.ink.lit)} → ${pct(blast.after.ink.lit)} · settled white ${pct(blast.after.ink.white)}`,
    );
    note(
      `  peak white ${pct(blast.peak.white)} at +${blast.peakMs} ms · any there ${pct(blast.peak.any)}` +
        ` · largest white blob ${blast.peak.whiteBlob} px = ${dots(blast.peak)} dots` +
        ` · ${blast.schedule.inkFrames} frames sampled`,
    );
    note(
      `  schedule: pending peaked at ${blast.schedule.peak} patches over ${blast.schedule.frames} frames` +
        ` · drained to ${blast.after.pending}`,
    );
  }
  if (trace) {
    note(
      `trace: ${trace.rows} frames (worst sim gap ${trace.gap.toFixed(3)} s) · painted ${trace.paintedQuiet}` +
        ` before the first press → ${st.paintedDots} · reactor low ${trace.minEnergy.toFixed(2)}` +
        ` · halo peak ${trace.maxAudible.toFixed(2)} m`,
    );
    if (trace.peak)
      note(
        `  flash peak white ${pct(trace.peak.white)} at sim t ${trace.peakT.toFixed(2)} s` +
          ` · any there ${pct(trace.peak.any)} · largest white blob ${dots(trace.peak)} dots`,
      );
  }
  note(`player ${state.pos.map(f2).join(' ')} · ${state.stance} · hands ${state.hands} · fall ${f2(state.lastFall)} m`);
  const c = state.counts;
  note(
    `events ${state.events} — walk ${c.walkStep} sprint ${c.sprintStep} crouch ${c.crouchStep}` +
      ` slide ${c.slide} land ${c.landing} mantle ${c.mantle}`,
  );
  note(`fov ${f2(state.fov)}°`);
  if (state.dogs.length) {
    const d = state.dogs[0];
    const h = state.dogHeard;
    note(
      `dog ${state.dogs.length} alive · ${d.cloud} cloud points · ${d.poses} poses ${d.ghosts} ghosts` +
        ` · gait ${c.dogGait}`,
    );
    note(
      `heard ${h.n} dog events (of the last 96) · ${h.classes.join(',') || '—'}` +
        ` · walls ${h.walls.join(',')} · quality ${h.minQuality.toFixed(3)}..${h.maxQuality.toFixed(3)}`,
    );
  }
  if (hotkeys) note(`F6 dog-2 route ${hotkeys.before} → ${hotkeys.flipped} → ${hotkeys.restored}`);
  if (state.trail.n > 1) {
    const t = state.trail;
    note(`trail ${t.n} crumbs · x ${f2(t.minX)}..${f2(t.maxX)} · z ${f2(t.minZ)}..${f2(t.maxZ)}`);
  }
  note(`screenshot ${shot}`);
  if (!state.webgl) console.warn('  !! WebGL canvas missing — headless GPU unavailable, overlay-only run');
  for (const e of errors) problems.push(`${name}: ${e}`);

  // Universal, on every capture: vision §12's comfort floor is "FOV 80–110", and the rig smooths
  // toward its target every frame, so the only honest place to assert the band is at the end of a
  // real run in a real browser — standing, sprinting, sliding, mid-route, whatever this one did.
  const universal = {
    'fov inside the vision §12 comfort band (80–110)': state.fov >= 80 && state.fov <= 110,
  };
  if (state.webgl) {
    // Vision §12 caps the point pool at ~1 M and asks for a handful of draw calls, and the bake
    // is the same on every capture — so the budget is asserted everywhere rather than once.
    universal['a look is live'] = st.look !== 'none';
    universal['surfel pool inside the ~1 M point ceiling (vision §12)'] =
      st.surfels > 0 && st.surfels + st.edges * 2 < 1_000_000;
    universal['the whole world draws in a handful of calls'] = st.drawCalls > 0 && st.drawCalls <= 8;
    universal['nothing is painted that was never heard'] = st.paintedDots === 0 || st.heard > 0;
  }
  if (hotkeys) {
    universal['F6 flips dog 2 on this Sim’s own map'] =
      typeof hotkeys.before === 'boolean' && hotkeys.flipped === !hotkeys.before;
    universal['F6 again restores it'] = hotkeys.restored === hotkeys.before;
  }
  assertAll(name, { ...universal, ...checks(state, blast, trace) });
  return { ...state, blast, trace };
}

async function main() {
  if (!flag('--no-build') || !existsSync(DIST)) await run('npx', ['vite', 'build']);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const server = await serve(DIST, PORT);
  console.log(`serving dist/ on http://127.0.0.1:${PORT}`);

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl', '--no-sandbox'],
  });

  try {
    await capture(browser, 'boot', '', (s) => ({
      'boot overlay hidden': s.boot,
      'sim is running': s.steps > 0,
      'top-down closed by default': !s.topDown,
    }));
    await capture(
      browser,
      'topdown',
      '?topdown&stats',
      (s) => ({
        'top-down open': s.topDown,
        'map loaded': s.map === 'Dock Approach',
        // Exact, not a floor: these are the authored counts of "Dock Approach" (test/map.spec.ts
        // pins the same two numbers). Update BOTH deliberately when the map changes — a drifting
        // ">" would let a whole zone go missing without failing anything.
        'solids baked': s.solids === 63,
        'walkable tops found': s.walkables === 21,
        'top-down drawing has ink': s.ink > 0.02 && s.ink < 0.6,
        'body has not moved on its own': Math.abs(s.pos[0] - 3) < 0.01 && Math.abs(s.pos[2] - 3) < 0.01,
        'a silent body paints nothing': s.events === 0,
        // The Sim deep-clones the map def, so F6 must reach a per-Sim copy — a live route the
        // overlay reads, not the shared module constant. Asserted by the universal hotkey checks.
        'the running Sim carries its own dog routes': typeof s.dog2On === 'boolean',
      }),
      { hotkeys: true },
    );

    // ---------------------------------------------------------------------------------------
    // Milestone 2: the scripted routes. Both are asserted in full by test/scripts.spec.ts; what
    // these captures add is that they still do it in the SHIPPED bundle, in a real browser, on
    // the real clock — and a picture of the trail to read them by (core/debug.ts SCRIPTS).
    // ---------------------------------------------------------------------------------------

    await capture(
      browser,
      'script-corridor',
      '?sim=script&topdown&stats',
      (s) => ({
        'route ran to the end': s.scriptDone === true,
        // Out of the trench, east of the pit (x 31..35), standing on corridor C's floor.
        'ended east down corridor C': s.pos[0] > 40 && Math.abs(s.pos[1]) < 0.01 && s.pos[2] > 0.4 && s.pos[2] < 1.9,
        'ended on its feet': s.stance === 'stand' && s.hands === 'none',
        // Braking at the lip is the point: sprint over it and you catch the rungs in mid-air,
        // and a 2.8 m descent paints nothing at all.
        'heard itself hit the trench floor': s.counts.landing === 1 && Math.abs(s.lastFall - 2.8) < 0.02,
        'sprinted, slid and crouched': s.counts.sprintStep > 3 && s.counts.slide > 5 && s.counts.crouchStep > 0,
        // `hands` passes through 'mantle' at the top of the ladder — the pull-up reuses the glide
        // — but vision §5 buys the climb silence, top-out included. Exactly zero.
        'the ladder top-out stays silent': s.counts.mantle === 0,
        // The route's one jump (t 3.1, at a sprint) apexes at 1.1 m — under LANDING_MIN_FALL — so
        // before the takeoff emitter it was a completely silent traversal. Eight sprint rows is
        // seven strides plus that takeoff; drop the takeoff and this reads seven. A floor, not an
        // equality: verify keeps stepping for 600 ms after the route reports done.
        'the jump at the duct is heard leaving the ground': s.counts.sprintStep >= 8,
        'trail crosses the whole corridor': s.trail.maxX - s.trail.minX > 38 && s.trail.maxZ - s.trail.minZ < 3.5,
        'trail was sampled': s.trail.n > 40,
        'top-down open': s.topDown,
        'top-down drawing has ink': s.ink > 0.02 && s.ink < 0.6,
        // Exact, like the solid counts above. Every class on this route is instant (only the two
        // pings and the detonation travel), the script is a fixed input list and paint is a pure
        // function of the delivered events — so this route paints the same dots every time, on
        // every machine, and a ">" here would hide a whole zone going dark.
        //
        // RE-BASELINED under ruling R3 (through-wall fuzz clamped to the degraded radius): was
        // 6842 dots / 232 edge verts. The fuzz magnitude is now min(WALL_FUZZ, WALL1_RADIUS x R),
        // which moves the muffled origins of this route's 3 walk steps (2.0 m -> 1.6 m) and 3
        // crouch steps (2.0 m -> 0.6 m) and so shifts +11 dots' worth of through-wall paint. The
        // 8 sprint steps, 10 slides and 1 landing are all >= 5 m classes and are untouched, which
        // is why the edge-vert count did not move at all.
        //
        // RE-BASELINED again now the chain curtain is MATTER: 6853 -> 6893 dots. The curtain at
        // door [c] (x 30..31.6, y 0..2.4, z 2.0..2.4) is a real surface that hangs in a real
        // doorway — a sound in that doorway has to come back off it — so it joins the static bake
        // as paintable non-solid geometry, adding 88 surfels to the map (118306 -> 118394). This
        // is the only route that walks through [c], and it lights 40 of them. Measured by baking
        // the same route against a map with the curtain removed: every other number, this route's
        // holds included, is unchanged, because a hanging curtain carries no traversal affordance.
        'the route painted its baseline dots exactly': s.stats.paintedDots === 6893,
        'and its baseline holds exactly': s.stats.paintedEdgeVerts === 232,
      }),
      { scripted: true },
    );

    await capture(
      browser,
      'script-mantle',
      '?sim=script2&topdown&stats',
      (s) => ({
        'route ran to the end': s.scriptDone === true,
        // The machinery row is x 4..20, z 24..26, top at exactly MANTLE_MAX_HEIGHT (2.2).
        'ended on top of the machinery row':
          Math.abs(s.pos[1] - 2.2) < 0.01 && s.pos[0] > 4 && s.pos[0] < 20 && s.pos[2] > 24 && s.pos[2] < 26,
        'ended on its feet': s.stance === 'stand' && s.hands === 'none',
        'climbed rather than fell onto it': s.counts.landing === 0,
        // One climb, one scuff (the proposed §3.3 addendum — see doc/engine-plan.md §4.1).
        'the climb was heard exactly once': s.counts.mantle === 1,
        'crossed the hall at a sprint': s.counts.sprintStep > 3,
        'trail crosses the machine hall': s.trail.maxZ - s.trail.minZ > 20,
        'trail was sampled': s.trail.n > 40,
        'top-down open': s.topDown,
        'top-down drawing has ink': s.ink > 0.02 && s.ink < 0.6,
        // RE-BASELINED under ruling R3, same reason as the corridor route: was 4574 dots / 213
        // edge verts, and the clamp moves this route's 3 walk steps and 1 crouch step by -1 dot.
        'the route painted its baseline dots exactly': s.stats.paintedDots === 4573,
        'and its baseline holds exactly': s.stats.paintedEdgeVerts === 213,
      }),
      { scripted: true },
    );

    // ---------------------------------------------------------------------------------------
    // Milestone 3: the first person. Four captures, and they are meant to be LOOKED at — the
    // numbers below only fence off the two ways a renderer lies (an empty frame, a flooded one).
    // ---------------------------------------------------------------------------------------

    // (a) The black world. Vision §1.3: absence is black. Nothing has made a sound yet, so
    // nothing may be drawn — except the 2 m contact shell of §3.1, which must be there and must
    // be almost nothing. `lit` exactly 0 is the law; `any` between a whisper and a smear is the
    // shell doing its one job.
    await capture(browser, 'fp-boot', '', (s) => ({
      'nothing has been heard yet': s.stats.heard === 0 && s.events === 0,
      'nothing has been painted': s.stats.paintedDots === 0 && s.stats.paintedEdgeVerts === 0,
      'the world is black': s.glInk.lit === 0,
      // Measured 0.057% here, and 0.051%–0.057% across six window sizes from 800×500 to
      // 1920×1080 — the band is a property of the image, not of this viewport (see the header:
      // the cap scales with frame height, so a coverage fraction does not move with the window).
      // The floor catches a shell that stopped drawing; the ceiling catches one that grew into a
      // lantern, which would be law 1 broken — free light nobody paid for — and it also catches
      // the cap being lifted back off, which puts this straight over a percent.
      'the contact shell is drawn': s.glInk.any > 0.0003,
      'the contact shell is only a shell': s.glInk.any < 0.002,
      // Vision §3.1, the part a whole-frame fraction cannot see: the shell is measured from the
      // BODY. Measured 0.892% inside the bottom-centre box against 0.057% over the whole frame,
      // and exactly 0 in the same box at eye level — the ink is where the feet are. An
      // eye-measured shell reaches 1.05 m of floor, all of it below the bottom of the frame, and
      // would read 0 in the low box while the whole-frame fence above still passed on the walls.
      // The eye box is the control: without it, "there is ink somewhere low" is the whole claim.
      'the shell reaches the floor at your feet': s.feetInk.any > 0.003,
      'and nothing at all at eye level': s.eyeInk.any === 0,
      'the bake found geometry': s.stats.surfels > 50_000 && s.stats.patches > 1_000,
      'the bake found holds to draw as lines': s.stats.holds > 0 && s.stats.edges > s.stats.holds,
    }));

    // (b) The world a route paints. Same map, same script, same seam as `script-corridor` above —
    // the end pose and the event tallies are re-asserted here so that turning the first person on
    // is provably a rendering change and not a simulation one.
    await capture(
      browser,
      'fp-script',
      '?sim=script',
      (s) => ({
        'route ran to the end': s.scriptDone === true,
        'ended east down corridor C': s.pos[0] > 40 && Math.abs(s.pos[1]) < 0.01 && s.pos[2] > 0.4 && s.pos[2] < 1.9,
        'heard itself hit the trench floor': s.counts.landing === 1 && Math.abs(s.lastFall - 2.8) < 0.02,
        'the ladder top-out stays silent': s.counts.mantle === 0,
        'the footsteps were delivered': s.stats.heard > 10 && s.stats.missed === 0,
        // The same route through the same paint pipeline, so the same two numbers as the top-down
        // capture — asserted here too, because it is the FIRST-PERSON run and a divergence between
        // the two would mean the render path had somehow got into the paint path. Re-baselined
        // with it: 6853 -> 6893, the chain curtain at door [c] joining the bake (see above).
        'its own footsteps painted the route': s.stats.paintedDots === 6893,
        'holds along the route were painted too': s.stats.paintedEdgeVerts === 232,
        // Not black, and not a flood. `any` is the whole read (paint + shell); `lit` is paint
        // bright enough to navigate by. Measured 0.107% lit / 0.878% any, re-baselined from 5.1%
        // / 38.8%: the dot cap did not remove a single dot from this frame, it stopped ~150 of
        // them being drawn as 70 px discs. Both fences keep the old shape — a factor of two
        // either side, tight enough that halving or doubling the cap trips one of them.
        // Vision §3.6: the route's first steps are ~13 s old by now and must still be drawn, so
        // `lit` is also what stops `paintedDots` being a tally of surfaces that have gone dark.
        'the canvas is not black': s.glInk.lit > 0.0005,
        'the canvas is not flooded': s.glInk.any > 0.004 && s.glInk.any < 0.018,
        // Vision §12, the other end of the same band: a mid-route first-person frame is mostly
        // 3-15 m geometry, where nothing should saturate at all. A law, not a baseline — the
        // worst white this build produces is recorded once, on `fp-detonation`, and this frame is
        // nowhere near it. The blob guard rides along: it is the measure that would notice near
        // splats fusing back into a sheet even at a coverage the fraction is happy with.
        'nothing on the route saturates to white': s.glInk.white < 0.05,
        'and no white sheet anywhere in it': s.glInk.whiteBlob <= SHEET_BLOB_DOTS * dotArea(s.glInk.height),
      }),
      { scripted: true },
    );

    // (c) F7 through the real key, from the spawn. One detonation, one bus event, and a world
    // that was black a second ago is lit — the loudest map-paint in the game (vision §6). Run
    // TWICE, at two window sizes: every fence here is a fraction, and a fraction that moves with
    // the window is not a fence at all. The pair is compared below.
    const detonationChecks = (s, blast) => ({
      'F7 emitted exactly one detonation': s.counts.detonation === 1,
      'it went out on the ordinary bus': s.events === 1,
      'the listener heard its own blast': s.stats.heard === 1 && s.stats.missed === 0,
      'it was black before': blast.before.painted === 0 && blast.before.ink.lit === 0,
      'the blast painted geometry': blast.after.painted > 1_000,
      'the blast lit the screen': blast.after.ink.lit > blast.before.ink.lit + 0.01,
      // Vision §12: "depth cues live only inside the cyan band", "splats sized to voxel
      // footprint". A point-blank blast is the worst case for near-field ink — the wall three
      // metres from your face is lit at full intensity all at once — and when the splats overlap
      // into a solid sheet the band collapses: no depth, no structure, just a lit rectangle.
      // What stops that is the dot cap (looks/debug `SPLAT_CAP_FRAC`): a near dot is held at 12 px
      // of a 1000 px frame while its lattice neighbour is 46 px away, so the near field opens out
      // into separate dots instead of closing into halftone.
      //
      // THE CANONICAL WORST WHITE: 4.844% of the frame, at 1600×1000, on the first frame sampled
      // after the blast reaches the bus (+45..70 ms — one frame of quantisation, not a range in
      // the image). That is the largest saturated fraction this build produces anywhere; every
      // other white fence in the tree is a law, not a measurement. And it is a FLASH: the same
      // frame reads ~3% a second later, which is why the peak is sampled per frame instead of
      // photographed once at the settle, where it would read 40% low.
      //
      // Saturation itself is intended (visual-brief §2): fresh paint in this deliberately
      // achromatic look tops out at white, and the near field is meant to be brightest at the
      // instant it arrives. What is NOT allowed is contiguity, which is what the guard below
      // measures — a saturated dot is a dot; a saturated region is porridge.
      'the flash stays inside the saturation bound': blast.peak.white <= 0.06,
      'the near field is a cloud, not a white sheet':
        blast.peak.whiteBlob <= SHEET_BLOB_DOTS * dotArea(blast.peak.height),
      // Coverage at the settle, when every dot the blast painted is on screen: measured 7.364%
      // here and 6.834% at 1280×720. The band, not just an upper bound — `any` collapsing means
      // the blast stopped painting, `any` back near half the frame means the cap is gone (it
      // reads 49.7% with splats drawn at their raw footprint).
      'and it did not flood the screen': blast.after.ink.any > 0.04 && blast.after.ink.any < 0.12,
      // ---- the schedule, asserted structurally ---------------------------------------------
      // A detonation's 5286 patches are released over the ~180 ms its wavefront takes to
      // cross, so `paintPending` must be non-zero on the frames in between. If a future change
      // ever paints the sphere whole inside `hear()` again, the peak goes to zero and this
      // fails on any machine, fast or slow — which the wall-clock ceiling below cannot do.
      'the blast was spread over frames, not painted whole': blast.schedule.peak > 100,
      'it took more than one frame to arrive': blast.schedule.frames >= 2,
      // …and it drains: a second after the blast nothing is still waiting on its wave.
      'the blast finished arriving': blast.after.pending === 0,
      'nothing was still queued before it went off': blast.before.pending === 0,
      // ---- machine-dependent smoke bound ---------------------------------------------------
      // NOT a discriminator, and deliberately labelled as one that is not: it is a wall-clock
      // number on a headless SwiftShader box, so it says nothing portable and passes trivially
      // on fast hardware. It is kept only to catch a gross regression — a frame that suddenly
      // spends a tenth of a second painting is a hitch at the loudest moment in the game
      // (engine-plan §10, vision §12 "60 fps"), and this notices. The real contract — converges
      // to a picture that depends only on the event set, never paints ahead of a wavefront,
      // never leaves due work behind, hands one frame only the slice its wave released — is
      // pinned deterministically in test/paint.spec.ts.
      'smoke bound (machine-dependent): no frame spends 18 ms painting': s.stats.paintMaxMs < 18,
    });
    const det = await capture(browser, 'fp-detonation', '', detonationChecks, { detonate: true });
    const detSmall = await capture(browser, 'fp-detonation-small', '', detonationChecks, {
      detonate: true,
      viewport: VIEWPORT_SMALL,
    });

    // ---- (c2) the same blast, measured at two window sizes ---------------------------------
    // The instrument that makes every fraction above meaningful. With the cap in absolute pixels
    // the white FRACTION scaled as 1/(W·H) — the identical scene saturated half again as much of
    // a 1366×768 frame as of a 1600×1000 one, so the fence measured the harness's window as much
    // as it measured the renderer, and passed or failed partly by luck.
    // With the cap a fraction of frame height, the residual difference is aspect only (vertical
    // FOV is fixed, so a wider frame adds horizontal content at the same dot size): measured 7.7%
    // apart on peak white and 7.5% on settled coverage between 1.60 and 1.78 aspect, against a
    // tolerance of 15%. A cap that went back to absolute pixels would land ~74% apart here.
    const rel = (a, b) => Math.abs(a - b) / Math.max(1e-9, (a + b) / 2);
    const dWhite = rel(det.blast.peak.white, detSmall.blast.peak.white);
    const dAny = rel(det.blast.after.ink.any, detSmall.blast.after.ink.any);
    console.log(`- scale stability ${VIEWPORT.width}x${VIEWPORT.height} vs ${VIEWPORT_SMALL.width}x${VIEWPORT_SMALL.height}`);
    note(
      `peak white ${pct(det.blast.peak.white)} vs ${pct(detSmall.blast.peak.white)}` +
        ` — ${(dWhite * 100).toFixed(1)}% apart (tolerance ${(SCALE_TOL * 100).toFixed(0)}%)`,
    );
    note(
      `settled coverage ${pct(det.blast.after.ink.any)} vs ${pct(detSmall.blast.after.ink.any)}` +
        ` — ${(dAny * 100).toFixed(1)}% apart`,
    );
    note(
      `largest white blob ${(det.blast.peak.whiteBlob / dotArea(det.blast.peak.height)).toFixed(2)} vs ` +
        `${(detSmall.blast.peak.whiteBlob / dotArea(detSmall.blast.peak.height)).toFixed(2)} dot areas` +
        ` (limit ${SHEET_BLOB_DOTS})`,
    );
    assertAll('scale-stability', {
      'peak white is the same fraction of a small frame as of a large one': dWhite <= SCALE_TOL,
      'so is the settled coverage': dAny <= SCALE_TOL,
      // In dot areas the blob is not just stable, it is the SAME NUMBER — one dot, at any window.
      // That is the whole claim of the near-field rework, stated as a measurement.
      'and the largest white blob is one dot at either size':
        det.blast.peak.whiteBlob <= SHEET_BLOB_DOTS * dotArea(det.blast.peak.height) &&
        detSmall.blast.peak.whiteBlob <= SHEET_BLOB_DOTS * dotArea(detSmall.blast.peak.height),
    });

    // (d) The F3 numbers themselves (engine-plan §10: fps, frame ms, surfel count, painted count,
    // draw calls, event/s). Parsed out of the very strings the overlay prints, on the mantle
    // route so the panel has a painted world behind it.
    await capture(
      browser,
      'fp-stats',
      '?sim=script2&stats',
      (s) => {
        const line = (word) => s.f3.find((l) => l.startsWith(word)) ?? '';
        const num = (word, after) => {
          const m = new RegExp(`${after}\\s+([0-9.]+)`).exec(line(word));
          return m ? Number(m[1]) : NaN;
        };
        const inkDots = (s.glInk.any * s.glInk.width * s.glInk.height) / dotArea(s.glInk.height);
        return {
          'route ran to the end': s.scriptDone === true,
          'ended on top of the machinery row': Math.abs(s.pos[1] - 2.2) < 0.01,
          'F3 prints the surfel count': /^surfels\s+\d+ dots/.test(line('surfels')),
          'F3 prints the painted count': /^painted\s+\d+ dots/.test(line('painted')),
          'F3 prints the paint cost': /^paint\s+[0-9.]+ ms/.test(line('paint ')),
          'F3 prints draw calls and event rate': /draw calls/.test(line('render')) && /event\/s/.test(line('render')),
          'F3 prints the halo readout': /m audible/.test(line('halo')),
          'the F3 surfel count is the baked one': num('surfels', 'surfels') === s.stats.surfels,
          'the F3 painted count is the painted one': num('painted', 'painted') === s.stats.paintedDots,
          // The same route as `script-mantle`, so the same baseline (see the R3 note there).
          'F3 painted count is the route baseline': s.stats.paintedDots === 4573,
          'surfel count inside budget': s.stats.surfels < 1_000_000,
          // Headless swiftshader is not a GPU, so this is a liveness floor, not the 60 fps target
          // of vision §12 — a stalled loop or a frame in the seconds reads as broken here.
          'the frame loop is alive': s.stats.fps > 5 && s.stats.frameMs < 200,
          // The one structural reading of this frame, and deliberately not a fraction: ink
          // measured in DOT AREAS is a count of the dots actually drawn, so it means the same
          // thing at any window size (a fraction only survives scaling; this survives the aspect
          // change too). This vantage is a metre from a wall the route never painted, so what
          // fills the frame is the contact shell and almost nothing else — which is why `lit` is
          // a single dot's worth here and painted route geometry is fenced on fp-script instead.
          // Measured 102 dot areas at 1600×1000 and 99 at 1280×720: a wall at 1 m has a 106 px
          // lattice pitch, so each capped dot covers ~1% of the area it sits on. The band is a
          // factor of ~1.6 either way — the shell going dark and the shell growing into a lantern
          // both trip it, and neither can hide behind a window size.
          'the shell fills the near wall without flooding it': inkDots > 60 && inkDots < 160,
          'the near wall stays a cloud, not a sheet':
            s.glInk.white < 0.05 && s.glInk.whiteBlob <= SHEET_BLOB_DOTS * dotArea(s.glInk.height),
        };
      },
      { scripted: true },
    );

    // ---------------------------------------------------------------------------------------
    // Milestone 4: the sonar route (core/debug.ts SCRIPTS `ping`). The only capture where paint
    // is bought with the reactor instead of with footfalls, and the only one that exercises E and
    // Q at all: engine-plan §10's beats are "Q the room, then E real geometry", and everything
    // downstream of a press — energy, cooldown, halo, the far end at beam impact — is invisible
    // to a route that only walks.
    //
    // The route walks south out of A, stops on the tank's centre line, goes quiet for over a
    // second, Q-pings the room and then E-pings the tank 10 m away. The silence before the first
    // press is what makes the paint delta exact: nothing is in flight, so the count sampled just
    // before the press is stable and everything above it was bought by the two pings.
    // ---------------------------------------------------------------------------------------
    await capture(
      browser,
      'fp-ping',
      '?sim=script3',
      (s, _blast, t) => ({
        'route ran to the end': s.scriptDone === true,
        'ended on the tank’s centre line': Math.abs(s.pos[0] - 3) < 0.05 && Math.abs(s.pos[2] - 15.62) < 0.5,
        'both presses were made': s.counts.qPing === 1 && s.counts.ePing === 2,
        // Two ePing rows for one press is the far end (engine-plan §6): the beam's impact centre
        // re-radiates as its own event. It is a real event on the bus, it is delivered — and it
        // paints nothing, because a far end's paint radius is zero (test/paint.spec.ts pins that
        // the pipeline hears it and enqueues no patch). The delta below is what proves it here:
        // if the far end painted its own sphere the route's total would not be this number.
        'every sound on the route was delivered': s.stats.heard === 9 && s.stats.missed === 0,
        // Exact on both sides. The route is a fixed input list, paint is a pure function of the
        // delivered events and every walk class is instant, so the count in the quiet second
        // before the first press is 1191 on every machine, and the two pings add exactly 6810
        // dots on top of it. A ">" here would let the Q-ping go missing and still pass.
        'the world was already painted by the walk in': t.paintedQuiet === 1191,
        'and the two pings painted exactly their own wavefronts': s.stats.paintedDots === 8001,
        'the ping also painted the holds it found': s.stats.paintedEdgeVerts === 330,
        // Vision §3.8: the halo is what you are audible at, and an E-ping is the loudest thing a
        // silent player does — 30 m at both ends of the beam. Sampled per frame, so this is the
        // peak over the whole run and not wherever the last frame happened to land.
        'the halo lit to the E-ping’s own range': Math.abs(t.maxAudible - 30) < 0.01,
        // Vision §4: Q costs 10, E costs 18, the bar regenerates at 6/s. Full at the Q (100 → 90),
        // back to 99 over the 1.5 s to the E, then 81 — the low-water mark of the run. The frame
        // sampler can only catch it within one frame of regeneration (≤ 0.4), hence the band; what
        // it is really fencing is that a press costs the bar something and costs it the RIGHT
        // amount. A ping that stopped charging reads 100 here.
        'the reactor paid for both pings': t.minEnergy > 80.5 && t.minEnergy < 82.5,
        // The saturation law, on the frame that actually flashes: sampled every frame from just
        // before the Q to a second after the E. The tank is 10 m away so this is nowhere near the
        // point-blank worst case (fp-detonation), but it is the only ping flash the gate photographs.
        'the ping flash stays inside the saturation bound': t.peak.white <= 0.06,
        'and paints dots, not a sheet': t.peak.whiteBlob <= SHEET_BLOB_DOTS * dotArea(t.peak.height),
      }),
      {
        scripted: true,
        // Sim seconds: the pings are at 5.0 (Q) and 6.5 (E), the route ends at 7.5. `quietUntil`
        // is the instant the paint delta is measured from — inside the silence, before the press.
        trace: { quietUntil: 5.0, inkFrom: 4.9, inkTo: 8.2 },
      },
    );

    // ---------------------------------------------------------------------------------------
    // Milestone 5: the Lantern rig (vision §15.2 — "track an unseen patrolling dog through one
    // wall by its sound-paint"). The only capture with an animal in the world, and the only one
    // whose paint is bought by something that is not the player.
    //
    // The route (core/debug.ts SCRIPTS `lantern`) sprints down hall B, mantles the 2.2 m
    // machinery row and walks east along the top of it to a listening post at x ≈ 13, then stops
    // and stays stopped. The post is ON the row for a reason: at floor level the wall stack
    // between that ear and dog 1's patrol lane is two deep, and two walls is silence (vision
    // §3.4). Standing on the row leaves exactly one — `w-listening` — so every dog event that
    // arrives has `wallsToListener === 1` and a quality scaled by WALL1_QUALITY. That is the
    // whole test: a dog that is never seen, never pinged and never in line of sight, painting a
    // room through a wall for a player who is making no sound at all.
    //
    // `dogs=dog1` is the capture's own override of the roster default every other capture takes
    // (see `capture()`): this is the one world that is supposed to have an animal in it.
    // ---------------------------------------------------------------------------------------
    await capture(
      browser,
      'fp-dog',
      '?sim=script4&dogs=dog1',
      (s, _blast, t) => ({
        'route ran to the end': s.scriptDone === true,
        'ended at the listening post on top of the machinery row':
          Math.abs(s.pos[1] - 2.2) < 0.01 && Math.abs(s.pos[0] - 13.09) < 0.2 && Math.abs(s.pos[2] - 25.45) < 0.2,
        // Exact, on a fixed input list: the whole self-noise budget of the run is these thirteen
        // events, and then nothing. The route deliberately spends its noise early (sprint down the
        // hall) and buys silence with the rest — a footfall after the post would put the player's
        // own paint into the number below and the read would stop being the dog's.
        'the player spent exactly the route’s own noise':
          s.counts.sprintStep === 6 &&
          s.counts.walkStep === 5 &&
          s.counts.crouchStep === 1 &&
          s.counts.mantle === 1 &&
          s.counts.landing === 0 &&
          s.counts.slide === 0,
        // Vision §3.3: a patrolling dog emits its gait every 0.8 m travelled, so a dog that is
        // walking at all cannot be quiet. Sixty is a floor, not a measurement — what it fences is
        // a route follower that stalled or a gait emitter that stopped emitting.
        'the dog trotted the whole run': s.counts.dogGait > 60,
        // The Lantern claim itself, read off the delivered feed. Every dog event arrived through
        // exactly one wall (never zero — line of sight would make this a different test — and
        // never two, which the pipeline drops), and the qualities are real numbers inside the
        // one-wall band: WALL1_QUALITY (0.45) is the ceiling a through-wall event can ever reach,
        // and `maxQuality > 0` is the difference between hearing the dog and merely logging it.
        'the dog was heard, and only through the wall':
          s.dogHeard.n > 0 &&
          s.dogHeard.classes.length === 1 &&
          s.dogHeard.classes[0] === 'dogGait' &&
          s.dogHeard.walls.length === 1 &&
          s.dogHeard.walls[0] === 1,
        'through-wall quality stayed inside its own band':
          s.dogHeard.maxQuality > 0 && s.dogHeard.maxQuality <= 0.45 && s.dogHeard.minQuality >= 0,
        // `quietUntil: 10` samples the painted count nearly four seconds after the player's last
        // footfall, so everything above it was painted by the animal. Vision §6: "dogs are walking
        // lanterns". This is that sentence as a number.
        'the dog kept painting after the player went silent': s.stats.paintedDots > t.paintedQuiet + 300,
        // Vision §3.7: what the look is handed is a photograph, never a prediction — live poses
        // for what is being heard now, frozen ghosts for what was. Both present means the freeze
        // path ran and the prune did not eat it.
        'the look was given both live poses and cooling ghosts':
          s.dogs.length === 1 && s.dogs[0].poses > 0 && s.dogs[0].ghosts > 0,
        // The body is a point cloud like everything else (vision §12): a fixed lattice solve, not
        // a mesh. Exact, because the solver is deterministic and the budget is ~600 points a dog.
        'the dog body is the budgeted cloud': s.dogs[0].cloud === 596,
        // The dog's own layer obeys the same saturation law as the world's (vision §12): red-orange
        // is not white, and a body at 3 m through a wall must not fuse into a sheet.
        'the dog never saturates the frame': t.peak.white <= 0.02,
        'and is drawn as dots, not a sheet': t.peak.whiteBlob <= SHEET_BLOB_DOTS * dotArea(t.peak.height),
      }),
      {
        scripted: true,
        // Sim seconds: the player's last sound is at 6.38 and the route ends at 32.0, which puts
        // the capture inside dog 1's audible window on the far side of the wall. The ink window
        // is the tail of that — the frames where the dog is actually on screen.
        trace: { quietUntil: 10, inkFrom: 28, inkTo: 40 },
      },
    );
  } finally {
    await browser.close();
    server.close();
  }

  if (problems.length) {
    console.error(`\nVERIFY FAILED (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('\nVERIFY OK');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
