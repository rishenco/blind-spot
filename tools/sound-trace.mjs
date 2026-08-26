/**
 * One focused dense keyframe for the `trace` sound-marker style.
 *
 *   node tools/sound-trace.mjs [dist/index.html] [out/sound-trace]
 *
 * Nearby quiet/world/spider events overlap into soft activity regions. One fresh 90m event proves
 * the sharp onset in the same frame. Exactly one PNG is written; timing is checked numerically by
 * `check:sound-trace`, not inferred from pixels.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
const outDir = resolve(process.argv[3] ?? 'out/sound-trace');
const outPath = join(outDir, '01-dense-traces-and-sharp-onset.png');

if (!existsSync(htmlPath)) {
  console.error(`[sound-trace-shot] build not found: ${htmlPath} (run \`npm run build\` first)`);
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

  await page.goto(`${pathToFileURL(htmlPath).href}?harness=1&seed=20260826`);
  await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 30000 });

  const result = await page.evaluate(() => {
    const bs = window.bs;
    bs.audio(false);
    bs.hud(false);
    bs.vitals.layer(false);
    bs.vitals.compass(false);
    bs.touch(false);
    bs.rifleMesh(false);
    bs.lights(false);
    bs.markers(true);
    bs.markerStyle('trace');
    bs.pose(2, 2, 0);
    bs.view('player');
    for (let i = 0; i < 3 * 120; i++) bs.step(1 / 120);
    bs.clear();
    // One honest lidar sweep supplies the precise cyan geometry this soft channel is meant to
    // contrast with. It creates no sound event and does not illuminate anything.
    bs.fire();
    for (let i = 0; i < Math.round(0.75 * 120); i++) bs.step(1 / 120);
    bs.draw();

    // Two clusters, deliberately close enough for max-composited residues to merge into areas.
    const events = [
      ['prop-impact', -1.8, -3.8, 12], ['prop-impact', -1.4, -4.0, 18],
      ['player-step', -1.0, -3.7, 9], ['prop-impact', -0.6, -4.1, 14],
      ['spider', 2.1, -4.3, 3.6, 'step'], ['spider', 2.5, -4.0, 9, 'chatter'],
      ['spider', 2.8, -4.4, 16, 'chatter'], ['spider', 3.1, -4.1, 11, 'chatter'],
    ];
    for (const [source, x, z, loudness, kind] of events) {
      bs.spiders.noise(source, x, z, loudness, kind);
    }
    for (let i = 0; i < Math.round(0.86 * 120); i++) bs.step(1 / 120);

    // A fresh loud event remains caught in its fast, single expanding front.
    // Deliberately emitted as physics/world noise at rifle-scale loudness: timing is a function of
    // loudness alone, and this avoids bringing the rifle's separate concussion post-effect into
    // a frame whose subject is the sound marker.
    bs.spiders.noise('prop-impact', 0.9, -5.9, 90);
    for (let i = 0; i < Math.round(0.10 * 120); i++) bs.step(1 / 120);

    bs.view('top');
    bs.topFocus(0.8, -4.2);
    bs.topHeight(13);
    bs.draw();
    return { style: bs.markerStyle(), marks: bs.stats().marks };
  });

  await page.screenshot({ path: outPath, timeout: 180000 });
  if (result.style !== 'trace' || result.marks.alive < 9 || errors.length > 0) {
    throw new Error(
      `bad focused frame: style=${result.style}, alive=${result.marks.alive}, errors=${errors.join(' | ') || 'none'}`,
    );
  }
  console.log(
    `[sound-trace-shot] PASS ${outPath} — style=trace, authored=9, alive=${result.marks.alive}, ` +
      'residue-age=0.96s, loud-onset-age=0.10s, png=1',
  );
} finally {
  await browser.close();
}
