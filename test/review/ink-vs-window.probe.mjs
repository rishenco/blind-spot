#!/usr/bin/env node
/**
 * BUG(ink-fences-are-window-bound) — browser-side evidence for the M4 review.
 *
 * Vitest does not collect this file (it is not a *.spec.*). Run it by hand:
 *
 *     npm run build
 *     node test/review/ink-vs-window.probe.mjs
 *
 * Optionally point it at a second build to diff against — the review used the pre-M4 tree
 * (`git archive df018cf | tar -x` somewhere, `npx vite build`) to measure the regression:
 *
 *     BLINDSPOT_OLD_DIST=/path/to/df018cf/dist node test/review/ink-vs-window.probe.mjs
 *
 * What it demonstrates, in four sections:
 *
 *   A  `blast.after.ink.white < 0.05` — the fence the near-field rework is measured against — is
 *      not a property of the image. Splats are capped in PIXELS, so the white pixel COUNT is
 *      roughly constant across canvas sizes and the FRACTION scales as 1/(W*H). The same scene
 *      that reads 3.4 % at verify's hard-coded 1600x1000 reads over 5 % at 1366x768.
 *   B  the fence is sampled 1000 ms after the flash, which is off the plateau. The peak is
 *      higher than anything verify photographs, and M4 raised that peak sharply against df018cf.
 *   C  the same window dependence in the re-baselined fp-boot band: the "shell is drawn" floor
 *      and the "only a shell" ceiling are both violated inside the range of ordinary laptop and
 *      desktop window sizes. The `feetInk` claim (0.892 %, and exactly 0 at eye level) is
 *      re-measured here too.
 *   D  the worst case for the near-field cap that verify never photographs: a FRESH close wall,
 *      face-on, lit by one E-ping. `npm run verify` fires no ping at all, so nothing in the
 *      browser gate exercises the M4 ping path.
 *
 * Read-only: serves a built `dist/` over loopback and drives it. Writes nothing.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from '../../node_modules/playwright/index.mjs';

const NEW_DIST = resolve(new URL('../../dist', import.meta.url).pathname);
const OLD_DIST = process.env.BLINDSPOT_OLD_DIST ? resolve(process.env.BLINDSPOT_OLD_DIST) : null;
const PORT = Number(process.env.BLINDSPOT_PROBE_PORT ?? 4193);
const CHROMIUM = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serve(dir, port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = join(dir, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(dir)) return void res.writeHead(403).end();
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

const pct = (v) => `${(v * 100).toFixed(3)}%`;
const pad = (s, n) => String(s).padStart(n);

async function open(browser, width, height, query = '') {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.blindspot), null, { timeout: 20000 });
  await page.waitForTimeout(650);
  return { page, errors };
}

// verify.mjs's own numbers, so the report can be checked against the source of truth.
const WHITE_FENCE = 0.05;
const BOOT_ANY_MIN = 0.0003;
const BOOT_ANY_MAX = 0.002;
const FEET_ANY_MIN = 0.003;
const BLAST_ANY = [0.04, 0.12];
const VERIFY_VIEWPORT = [1600, 1000];

// ------------------------------------------------------------------------------------------

async function sectionA(browser) {
  console.log('\n=== A. fp-detonation ink vs. window size (verify measures ONE of these rows) ===');
  console.log(`    fences: white < ${WHITE_FENCE} · any in [${BLAST_ANY[0]}, ${BLAST_ANY[1]}] · verify viewport ${VERIFY_VIEWPORT.join('x')}`);
  console.log('    window       lit        any      white    whitePx   verdict');
  for (const [w, h] of [
    [3840, 2160],
    [1920, 1080],
    [1600, 1000],
    [1440, 900],
    [1366, 768],
    [1280, 720],
    [1024, 640],
    [900, 560],
    [800, 500],
    [640, 400],
  ]) {
    const { page, errors } = await open(browser, w, h);
    await page.keyboard.press('F7');
    await page.waitForTimeout(1000); // the instant verify's `blast.after` samples
    const ink = await page.evaluate(() => window.blindspot.ink());
    const px = Math.round(ink.white * ink.width * ink.height);
    const bad = [];
    if (!(ink.white < WHITE_FENCE)) bad.push('WHITE FAIL');
    if (!(ink.any > BLAST_ANY[0] && ink.any < BLAST_ANY[1])) bad.push('ANY FAIL');
    console.log(
      `    ${pad(w, 4)}x${pad(h, 4)} ${pad(pct(ink.lit), 9)} ${pad(pct(ink.any), 10)} ${pad(pct(ink.white), 9)} ${pad(px, 9)}   ${bad.join(' · ') || 'ok'}` +
        (errors.length ? `  ERR ${errors.join('|')}` : ''),
    );
    await page.close();
  }
  console.log('    (whitePx is near-constant: the cap is in pixels, so the FRACTION is 1/(W*H).)');
}

async function sectionB(browser, label) {
  const [w, h] = VERIFY_VIEWPORT;
  console.log(`\n=== B. ${label}: the same blast sampled every frame at ${w}x${h} ===`);
  const { page } = await open(browser, w, h);
  await page.keyboard.press('F7');
  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    const ink = await page.evaluate(() => window.blindspot.ink());
    rows.push([Date.now() - t0, ink]);
    await page.waitForTimeout(90);
  }
  let peak = 0;
  for (const [ms, ink] of rows) {
    peak = Math.max(peak, ink.white);
    console.log(`    +${pad(ms, 4)} ms  any ${pad(pct(ink.any), 9)}  white ${pad(pct(ink.white), 9)}`);
  }
  console.log(`    PEAK white ${pct(peak)} — headroom to the ${WHITE_FENCE} fence: ${((WHITE_FENCE - peak) * 100).toFixed(3)} points`);
  await page.close();
  return peak;
}

async function sectionC(browser) {
  console.log('\n=== C. fp-boot ink vs. window size ===');
  console.log(`    fences: any > ${BOOT_ANY_MIN} ("the shell is drawn") · any < ${BOOT_ANY_MAX} ("only a shell") · feetInk.any > ${FEET_ANY_MIN}`);
  console.log('    window     whole-frame     feetInk      eye-box   verdict');
  for (const [w, h] of [
    [3840, 2160],
    [1920, 1080],
    [1600, 1000],
    [1366, 768],
    [1280, 720],
    [1024, 640],
    [800, 500],
  ]) {
    const { page } = await open(browser, w, h);
    const r = await page.evaluate(() => ({
      all: window.blindspot.ink(),
      // verify's own box: the bottom-centre sixth of the frame.
      feet: window.blindspot.ink([0.3, 0.0, 0.4, 0.16]),
      // The same box at eye level, which the M4 report claims reads exactly 0.
      eye: window.blindspot.ink([0.3, 0.42, 0.4, 0.16]),
      heard: window.blindspot.stats().heard,
    }));
    const bad = [];
    if (!(r.all.any > BOOT_ANY_MIN)) bad.push('DRAWN FAIL');
    if (!(r.all.any < BOOT_ANY_MAX)) bad.push('SHELL FAIL');
    if (!(r.feet.any > FEET_ANY_MIN)) bad.push('FEET FAIL');
    console.log(
      `    ${pad(w, 4)}x${pad(h, 4)} ${pad(pct(r.all.any), 12)} ${pad(pct(r.feet.any), 12)} ${pad(pct(r.eye.any), 12)}   ${bad.join(' · ') || 'ok'}  (heard ${r.heard})`,
    );
    await page.close();
  }
}

async function sectionD(browser) {
  console.log('\n=== D. the frame verify never photographs: a fresh close wall, face-on, one E-ping ===');
  console.log('    Dock Approach solid `w-b-d1` is the plane x = 24; the camera stands d metres short of it.');
  const [w, h] = VERIFY_VIEWPORT;
  const { page, errors } = await open(browser, w, h);
  const rows = await page.evaluate(async () => {
    const bs = window.blindspot;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = [];
    for (const d of [1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20]) {
      bs.field.resetPaint();
      bs.paint.reset();
      const p = bs.sim.player;
      p.x = 24 - d;
      p.y = 0;
      p.z = 6;
      p.yaw = 0;
      p.pitch = 0;
      bs.sim.playerSystems.energy = 100;
      await sleep(140);
      const r = bs.sim.playerSystems.ping('e');
      await sleep(900); // 40 m at 85 m/s is 0.47 s; give the pipeline room
      const ink = bs.ink();
      out.push({ d, refused: r.refused, painted: bs.field.paintedDots, lit: ink.lit, any: ink.any, white: ink.white });
      await sleep(180);
    }
    return out;
  });
  console.log('    d (m)   painted        lit         any       white   verdict');
  for (const r of rows) {
    console.log(
      `    ${pad(r.d, 5)} ${pad(r.painted, 9)} ${pad(pct(r.lit), 11)} ${pad(pct(r.any), 11)} ${pad(pct(r.white), 11)}   ` +
        (r.white < WHITE_FENCE ? 'ok' : 'WHITE FAIL') +
        (r.refused ? ` · REFUSED ${r.refused}` : ''),
    );
  }
  if (errors.length) console.log(`    ERRORS: ${errors.join(' | ')}`);
  await page.close();
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl', '--no-sandbox'],
  });
  let server = await serve(NEW_DIST, PORT);
  try {
    await sectionA(browser);
    const peakNew = await sectionB(browser, 'this build');
    await sectionC(browser);
    await sectionD(browser);
    if (OLD_DIST) {
      server.close();
      await new Promise((r) => setTimeout(r, 200));
      server = await serve(OLD_DIST, PORT);
      const peakOld = await sectionB(browser, `baseline build (${OLD_DIST})`);
      console.log(`\n    peak white: this build ${pct(peakNew)} vs baseline ${pct(peakOld)} — ${(peakNew / Math.max(peakOld, 1e-9)).toFixed(1)}x`);
    } else {
      console.log('\n    (set BLINDSPOT_OLD_DIST to a second built tree to diff the peak against it.)');
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
