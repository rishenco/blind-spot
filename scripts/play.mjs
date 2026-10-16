// Scripted playtest in headless Chromium.
// usage: node scripts/play.mjs <url> <outDir> '<steps json>'
// steps: [["click"], ["wait", ms], ["down", "KeyW"], ["up", "KeyW"], ["press", "Space"],
//         ["shot", "name"], ["eval", "js expression"], ["mouse", dx, dy]]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [url, outDir, stepsJson] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const steps = JSON.parse(stepsJson);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log('CONSOLE', m.type(), m.text()));
await page.goto(url);
await page.waitForTimeout(1500);
for (const [op, a, b] of steps) {
  if (op === 'click') await page.mouse.click(480, 300);
  else if (op === 'wait') await page.waitForTimeout(a);
  else if (op === 'down') await page.keyboard.down(a);
  else if (op === 'up') await page.keyboard.up(a);
  else if (op === 'press') await page.keyboard.press(a);
  else if (op === 'shot') await page.screenshot({ path: `${outDir}/${a}.png` });
  else if (op === 'eval') console.log('EVAL', a, '=>', JSON.stringify(await page.evaluate(a)));
  else if (op === 'mouse') await page.evaluate(([dx, dy]) => { const g = window.__game; g.input.locked = true; g.input.mouseDX += dx; g.input.mouseDY += dy; }, [a, b]);
}
await browser.close();
