// Screenshot a page with headless Chromium (WebGL via SwiftShader).
// usage: node scripts/shot.mjs <url> <out.png> [width] [height]
import { chromium } from 'playwright-core';

const [url, out, w = '1000', h = '750'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [width] [height]');
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
if (errors.length) console.error('PAGE ERRORS:\n' + errors.join('\n'));
console.log('saved', out);
