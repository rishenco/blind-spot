/**
 * One focused keyframe for the approved sound-pulse visual.
 *
 *   node tools/sound-pulse.mjs [dist/index.html] [out/sound-pulse]
 *
 * Five bus events at one deterministic tick: three neutral world/self readings and two spider
 * readings. At 2.35 seconds four sequential generations overlap. Exactly one PNG is written.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
const outDir = resolve(process.argv[3] ?? 'out/sound-pulse');
const outPath = join(outDir, '01-three-lines-and-source-colours.png');

if (!existsSync(htmlPath)) {
  console.error(`[sound-pulse-shot] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const preinstalled = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(preinstalled)) launchOptions.executablePath = preinstalled;

const errors = [];
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  const url = `${pathToFileURL(htmlPath).href}?harness=1&seed=20260826`;
  await page.goto(url);
  await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 30000 });

  const result = await page.evaluate(() => {
    const bs = window.bs;
    bs.audio(false);
    bs.hud(false);
    bs.touch(false);
    bs.rifleMesh(false);
    bs.lights(false);
    bs.markers(true);
    bs.markerStyle('pulse');
    bs.pose(2, 2, 0);
    bs.view('player');
    // Let procedural clutter finish its initial contacts, then erase those unrelated events.
    for (let i = 0; i < 3 * 120; i++) bs.step(1 / 120);
    bs.clear();
    // Admission uses the player's tactical ear. Prime it from the player camera before moving
    // only the proof camera overhead.
    bs.draw();

    // Same physical bus used by the game. The arrangement keeps the colours separate enough to
    // judge and uses two loudnesses without changing the approved size-response tunables.
    bs.spiders.noise('player-step', -3.0, -0.5, 14);
    bs.spiders.noise('prop-impact', 2.0, -0.5, 18);
    bs.spiders.noise('bullet-hit', 7.0, -0.5, 14);
    bs.spiders.noise('spider', -0.5, 5.0, 16, 'chatter');
    bs.spiders.noise('spider', 4.5, 5.0, 16, 'chatter');

    for (let i = 0; i < Math.round(2.35 * 120); i++) bs.step(1 / 120);
    bs.view('top');
    bs.topFocus(2, 2);
    bs.topHeight(18);
    // Exercise the selectable straight-segment branch in the same runtime scenario without
    // producing a second gallery frame, then return to rounded pulse for the sole proof PNG.
    bs.markerStyle('pulse-poly');
    bs.draw();
    const polyStyle = bs.markerStyle();
    bs.markerStyle('pulse');
    bs.draw();
    return { style: bs.markerStyle(), polyStyle, marks: bs.stats().marks };
  });

  await page.screenshot({ path: outPath, timeout: 180000 });
  // The five authored readings are the proof subject. Real settling contacts are intentionally
  // not muted: the sound layer remains subscribed to physics even in a keyframe harness.
  if (result.style !== 'pulse' || result.polyStyle !== 'pulse-poly' || result.marks.alive < 5 || errors.length > 0) {
    throw new Error(
      `bad focused frame: style=${result.style}, poly=${result.polyStyle}, alive=${result.marks.alive}, errors=${errors.join(' | ') || 'none'}`,
    );
  }
  console.log(
    `[sound-pulse-shot] PASS ${outPath} — style=pulse, poly-branch=${result.polyStyle}, authored=5, alive=${result.marks.alive}, age=2.35s, png=1`,
  );
} finally {
  await browser.close();
}
