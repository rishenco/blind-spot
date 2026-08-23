#!/usr/bin/env node
/**
 * Verification run (engine-plan §10).
 *
 * Builds, serves `dist/` from a tiny static server, drives it in Playwright chromium and drops
 * screenshots into `verify-out/` (git-ignored). Asserts boot + console cleanliness on every
 * capture. Milestone 1 verifies the boot screen and the top-down debug view, milestone 2 adds the
 * two scripted movement routes (`?sim=script`, `?sim=script2`) and reads the route out of the
 * debug trail as well as out of the end state. Milestone 3 adds the four FIRST-PERSON captures:
 * the black world, the world after a scripted route has painted it, the world a test detonation
 * lights, and the F3 numbers behind all three.
 *
 * Every capture measures TWO inks, and the difference matters:
 *   - `ink`   — the 2D debug overlay canvas (`#overlay canvas`), read with getImageData.
 *   - `glInk` — the first-person WebGL drawing buffer, read with readPixels inside the page
 *               (`window.blindspot.ink()`), which renders and reads back in the same task
 *               because a drawing buffer is undefined the moment you yield. Two thresholds:
 *               `lit` is paint, `any` also catches the 2 m contact shell, which is meant to be
 *               nearly invisible (vision §3.1).
 * A black screenshot that should show paint is a FAILURE even when every number passes, so the
 * captures are written to be looked at as well as asserted on.
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

async function capture(browser, name, query, checks, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.blindspot), null, { timeout: 15000 });
  if (opts.scripted) {
    // Scripted mode steps a fixed number of times per frame, so the route takes as long as the
    // browser needs and not a second of wall clock more — wait on the route, never on a timer.
    await page.waitForFunction(() => window.blindspot.script?.done === true, null, { timeout: 60000 });
  }
  await page.waitForTimeout(600);

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
    // Watch `paintPending` on every frame from here on. This is the STRUCTURAL discriminator for
    // the schedule (review A5): a blast that was painted whole inside `hear()` would show a peak
    // of zero, because it would already be finished before the next frame ever ran. A wall-clock
    // ceiling cannot tell those two apart — a fast machine passes it either way.
    await page.evaluate(() => {
      window.__pendPeak = 0;
      window.__pendFrames = 0;
      const until = performance.now() + 1500;
      const tick = () => {
        const n = window.blindspot.stats().paintPending;
        if (n > window.__pendPeak) window.__pendPeak = n;
        if (n > 0) window.__pendFrames++;
        if (performance.now() < until) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.keyboard.press('F7');
    // A detonation's wavefront takes paintRadius / WAVE_SPEED_DETONATION = 22/140 = 157 ms to
    // finish arriving, plus the late bound a patch is released on (one patch radius plus the
    // fuzz allowance, ~21 ms) — call it 180 ms (vision §3.3, engine-plan §3–§4). Wait well past
    // it, then read the settled world.
    await page.waitForTimeout(1000);
    const after = await sample();
    const schedule = await page.evaluate(() => ({ peak: window.__pendPeak, frames: window.__pendFrames }));
    blast = { before, after, schedule };
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
  note(
    `first-person ink lit ${(state.glInk.lit * 100).toFixed(3)}% · any ${(state.glInk.any * 100).toFixed(3)}%` +
      ` · white ${(state.glInk.white * 100).toFixed(3)}%` +
      ` · ${state.glInk.width}x${state.glInk.height} · look ${st.look} · ${st.drawCalls} draw calls` +
      ` · ${st.fps.toFixed(1)} fps`,
  );
  if (blast) {
    note(
      `F7 detonation: painted ${blast.before.painted} → ${blast.after.painted} dots · ink lit ` +
        `${(blast.before.ink.lit * 100).toFixed(3)}% → ${(blast.after.ink.lit * 100).toFixed(3)}%` +
        ` · white ${(blast.after.ink.white * 100).toFixed(3)}%`,
    );
    note(
      `  schedule: pending peaked at ${blast.schedule.peak} patches over ${blast.schedule.frames} frames` +
        ` · drained to ${blast.after.pending}`,
    );
  }
  note(`player ${state.pos.map(f2).join(' ')} · ${state.stance} · hands ${state.hands} · fall ${f2(state.lastFall)} m`);
  const c = state.counts;
  note(
    `events ${state.events} — walk ${c.walkStep} sprint ${c.sprintStep} crouch ${c.crouchStep}` +
      ` slide ${c.slide} land ${c.landing} mantle ${c.mantle}`,
  );
  note(`fov ${f2(state.fov)}°`);
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
  for (const [label, ok] of Object.entries({ ...universal, ...checks(state, blast) })) {
    if (!ok) problems.push(`${name}: failed check "${label}"`);
  }
  return state;
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
        'the route painted its baseline dots exactly': s.stats.paintedDots === 6853,
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
      // Measured 1.245%. The floor catches a shell that stopped drawing; the ceiling catches one
      // that grew into a lantern, which would be law 1 broken — free light nobody paid for.
      'the contact shell is drawn': s.glInk.any > 0.004,
      'the contact shell is only a shell': s.glInk.any < 0.04,
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
        // the two would mean the render path had somehow got into the paint path.
        'its own footsteps painted the route': s.stats.paintedDots === 6853,
        'holds along the route were painted too': s.stats.paintedEdgeVerts === 232,
        // Not black, and not a flood. `any` is the whole read (paint + shell); `lit` is paint
        // bright enough to navigate by. Both fences are set around the measured 5.1% lit / 38.8%
        // any with roughly a factor of two either side, tight enough that halving the splat size
        // or doubling it trips one of them — a wide-open band here caught nothing at all.
        // Vision §3.6: the route's first steps are ~13 s old by now and must still be drawn, so
        // `lit` is also what stops `paintedDots` being a tally of surfaces that have gone dark.
        'the canvas is not black': s.glInk.lit > 0.02,
        'the canvas is not flooded': s.glInk.any > 0.15 && s.glInk.any < 0.65,
        // Vision §12, the other end of the same band: a mid-route first-person frame is mostly
        // 3-15 m geometry, where nothing should saturate at all. Anything above a percent here
        // means near-field splats have grown back into a sheet and eaten the depth cues.
        'nothing on the route saturates to white': s.glInk.white < 0.05,
      }),
      { scripted: true },
    );

    // (c) F7 through the real key, from the spawn. One detonation, one bus event, and a world
    // that was black a second ago is lit — the loudest map-paint in the game (vision §6).
    await capture(
      browser,
      'fp-detonation',
      '',
      (s, blast) => ({
        'F7 emitted exactly one detonation': s.counts.detonation === 1,
        'it went out on the ordinary bus': s.events === 1,
        'the listener heard its own blast': s.stats.heard === 1 && s.stats.missed === 0,
        'it was black before': blast.before.painted === 0 && blast.before.ink.lit === 0,
        'the blast painted geometry': blast.after.painted > 1_000,
        'the blast lit the screen': blast.after.ink.lit > blast.before.ink.lit + 0.01,
        // Vision §12: "depth cues live only inside the cyan band", "splats sized to voxel
        // footprint". A point-blank blast is the worst case for near-field ink — every splat in
        // front of your face is metres of footprint wide — and when the splats overlap into a
        // solid sheet the band collapses: no depth, no structure, just a lit rectangle. Ink is
        // conserved against footprint in the shader (looks/debug `uSplatInk`), so a screen-filling
        // near cloud stays a cloud. The pure-white fraction is what that failure looks like from
        // the outside: 41.4% of the frame at full white before the fix, ~1% after.
        'the near field is a cloud, not a white sheet': blast.after.ink.white < 0.05,
        // Measured 49.7%: a 22 m sphere from the spawn lights most of what is in front of you,
        // but a bit under half the frame is still black — the shadowed side of the hall and the
        // geometry the blast never reached. The band, not just an upper fence: `any` collapsing
        // means the blast stopped painting, `any` at 0.85 means the splats have flooded.
        'and it did not flood the screen': blast.after.ink.any > 0.3 && blast.after.ink.any < 0.7,
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
      }),
      { detonate: true },
    );

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
          // Measured 3.4% lit / 78.5% any: the machinery-row vantage is a metre from a wall, so
          // most of the frame is close geometry at low alpha. That is exactly the frame the ink
          // bound is for — it must stay a cloud, not saturate.
          'the canvas is not black': s.glInk.lit > 0.01,
          'the near wall stays a cloud': s.glInk.white < 0.05,
        };
      },
      { scripted: true },
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
