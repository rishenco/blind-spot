// Headless visual harness: drives the game through the __bs hook and captures frames.
import { chromium, type Page, type Browser } from 'playwright';
import { mkdirSync } from 'node:fs';

export const URL_BASE = process.env.BS_URL ?? 'http://localhost:5173';
mkdirSync('shots', { recursive: true });

export async function launch(): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.BS_CHROME ?? '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--no-sandbox'],
  });
}

export async function openGame(browser: Browser, url = URL_BASE, w = 1280, h = 760): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  (page as any).__errs = errs;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__bs !== undefined, null, { timeout: 20000 });
  await page.evaluate(() => document.getElementById('center')?.classList.add('hidden'));
  return page;
}

export const errsOf = (p: Page): string[] => (p as any).__errs ?? [];

export async function place(page: Page, x: number, z: number, yaw: number, pitch = 0) {
  await page.evaluate(([x, z, yaw, pitch]) => {
    const b = (window as any).__bs;
    b.ctl.teleport({ x, y: 0, z }, yaw);
    b.ctl.pitch = pitch;
  }, [x, z, yaw, pitch]);
}

export async function pulse(page: Page) {
  await page.evaluate(() => { const b = (window as any).__bs; b.pulseReset?.(); b.firePulse(b.clock()); });
}

export async function settle(page: Page, seconds: number) {
  // Let rAF run; the wavefront and the pulse queue both need real frames.
  await page.waitForTimeout(seconds * 1000);
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `shots/${name}.png` });
  return `shots/${name}.png`;
}

// --- standalone run -------------------------------------------------
if (process.argv[1]?.endsWith('shot.ts')) {
  const b = await launch();
  const p = await openGame(b);
  // Down the Spine: the longest sightline on the map, the real depth test.
  await place(p, 5, 26.5, -Math.PI / 2, -0.03);
  await settle(p, 0.6); await shot(p, '01-dark');
  await pulse(p);
  await settle(p, 0.22); await shot(p, '02-wave-early');
  await settle(p, 0.30); await shot(p, '03-wave-mid');
  await settle(p, 1.2);  await shot(p, '04-spine-revealed');
  await settle(p, 7.0);  await shot(p, '05-spine-cooled');
  // Concourse: pillars + mezzanine, the volumetric test.
  await place(p, 22, 18, Math.PI * 0.82, 0.02);
  await pulse(p); await settle(p, 1.4); await shot(p, '06-concourse');
  // Vault: scanning through glass at a room you cannot enter.
  await p.evaluate(() => (window as any).__bs.clearField());
  await place(p, 43, 32, Math.PI, -0.02);
  await pulse(p); await settle(p, 1.4); await shot(p, '07-vault-glass');
  // Baffles: the cloth panels that read as open doorways but are solid wall.
  await p.evaluate(() => (window as any).__bs.clearField());
  await place(p, 12, 40, -Math.PI / 2, 0);
  await pulse(p); await settle(p, 1.4); await shot(p, '08-baffles');
  const e = errsOf(p);
  console.log(e.length ? 'CONSOLE ERRORS:\n' + e.slice(0, 10).join('\n') : 'no console errors');
  await b.close();
}
