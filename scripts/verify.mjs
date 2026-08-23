#!/usr/bin/env node
/**
 * Verification run (engine-plan §10).
 *
 * Builds, serves `dist/` from a tiny static server, drives it in Playwright chromium and drops
 * screenshots into `verify-out/` (git-ignored). Asserts boot + console cleanliness on every
 * capture. The `?autotest` demo and the surfel/paint assertions arrive with their milestones;
 * milestone 1 verifies the boot screen and the top-down debug view.
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

async function capture(browser, name, query, checks) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.blindspot), null, { timeout: 15000 });
  await page.waitForTimeout(600);

  const state = await page.evaluate(() => {
    const sim = window.blindspot.sim;
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
      solids: sim.world.solids.length,
      walkables: sim.world.walkables.length,
      steps: sim.steps,
      map: sim.map.name,
      ink,
      webgl: Boolean(document.querySelector('#app canvas')),
    };
  });

  const shot = join(OUT, `${name}.png`);
  await page.screenshot({ path: shot });
  await page.close();

  console.log(`- ${name}${query || ''}`);
  note(`map ${state.map} · ${state.solids} solids · ${state.walkables} walkable tops · ${state.steps} sim steps`);
  note(`boot hidden ${state.boot} · top-down ${state.topDown} · webgl canvas ${state.webgl}`);
  note(`overlay ink ${(state.ink * 100).toFixed(2)}%`);
  note(`screenshot ${shot}`);
  if (!state.webgl) console.warn('  !! WebGL canvas missing — headless GPU unavailable, overlay-only run');
  for (const e of errors) problems.push(`${name}: ${e}`);
  for (const [label, ok] of Object.entries(checks(state))) {
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
    await capture(browser, 'topdown', '?topdown&stats', (s) => ({
      'top-down open': s.topDown,
      'map loaded': s.map === 'Dock Approach',
      // Exact, not a floor: these are the authored counts of "Dock Approach" (test/map.spec.ts
      // pins the same two numbers). Update BOTH deliberately when the map changes — a drifting
      // ">" would let a whole zone go missing without failing anything.
      'solids baked': s.solids === 63,
      'walkable tops found': s.walkables === 21,
      'top-down drawing has ink': s.ink > 0.02 && s.ink < 0.6,
    }));
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
