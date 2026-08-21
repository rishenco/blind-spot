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

/**
 * Walk a client to a position the way the server will accept: a BFS path over the shared
 * map grid, followed in legal-sized steps, each uploaded as a real input message and
 * steered by the server's OWN reported position. The server owns movement, so this is the
 * only honest way for a test to position a player.
 */
export async function driveTo(page: Page, x: number, z: number, yaw?: number) {
  const ok = await page.evaluate(async ([tx, tz, ty]) => {
    const bs = (window as any).__bs;
    const GW = bs.map.extent.w as number, GH = bs.map.extent.h as number;
    const cells = bs.map.nav as Uint8Array;
    const start = [Math.floor(bs.state().self?.x ?? bs.ctl.pos.x), Math.floor(bs.state().self?.z ?? bs.ctl.pos.z)];
    const goal = [Math.floor(tx as number), Math.floor(tz as number)];
    // BFS from goal so the parent chain reads forward from start.
    const prev = new Int32Array(GW * GH).fill(-1);
    const seen = new Uint8Array(GW * GH);
    const q: number[] = [goal[1]! * GW + goal[0]!];
    seen[q[0]!] = 1;
    for (let h = 0; h < q.length; h++) {
      const c = q[h]!, cx = c % GW, cz = (c / GW) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx!, nz = cz + dz!;
        if (nx < 0 || nz < 0 || nx >= GW || nz >= GH || cells[nz * GW + nx] !== 1) continue;
        const ni = nz * GW + nx;
        if (seen[ni]) continue;
        seen[ni] = 1; prev[ni] = c; q.push(ni);
      }
    }
    const path: number[][] = [];
    let cur = start[1]! * GW + start[0]!;
    if (!seen[cur]) return false;
    for (let guard = 0; guard < 4000 && cur !== goal[1]! * GW + goal[0]!; guard++) {
      path.push([(cur % GW) + 0.5, ((cur / GW) | 0) + 0.5]);
      const nx = prev[cur]!;
      if (nx < 0) break;
      cur = nx;
    }
    path.push([tx as number, tz as number]);

    for (const [wx, wz] of path) {
      for (let i = 0; i < 90; i++) {
        const s = bs.state().self;
        const cx = s ? s.x : bs.ctl.pos.x, cz = s ? s.z : bs.ctl.pos.z;
        const dx = wx! - cx, dz = wz! - cz;
        const d = Math.hypot(dx, dz);
        if (d < 0.45) break;
        const step = Math.min(0.8, d);
        bs.ctl.teleport({ x: cx + (dx / d) * step, y: 0, z: cz + (dz / d) * step });
        if (ty !== undefined) bs.ctl.yaw = ty as number;
        bs.send({ t: 'input', seq: i, x: bs.ctl.pos.x, y: bs.ctl.pos.y, z: bs.ctl.pos.z,
                  yaw: bs.ctl.yaw, pitch: bs.ctl.pitch, stance: 1, vx: 0, vz: 0 });
        await new Promise((r) => setTimeout(r, 18));
      }
    }
    if (ty !== undefined) bs.ctl.yaw = ty as number;
    const s = bs.state().self;
    const err = Math.hypot((s?.x ?? 0) - (tx as number), (s?.z ?? 0) - (tz as number));
    if (err >= 1.2) console.warn('driveTo stalled at', s?.x?.toFixed(2), s?.z?.toFixed(2), 'err', err.toFixed(2));
    return err < 1.2;
  }, [x, z, yaw] as any);
  if (!ok) throw new Error(`driveTo(${x},${z}) did not converge`);
}

/** The server's authoritative position for this client. */
export async function serverPos(page: Page): Promise<{ x: number; z: number }> {
  return page.evaluate(() => {
    const s = (window as any).__bs.state().self;
    return { x: s?.x ?? 0, z: s?.z ?? 0 };
  });
}

export async function pulse(page: Page) {
  await page.evaluate(() => { const b = (window as any).__bs; b.pulseReset?.(); b.doPulse(); });
}

/** Enter the offline sandbox, where the client owns its own pulses. */
export async function solo(page: Page) {
  await page.evaluate(() => (window as any).__bs.startSolo());
  await page.waitForTimeout(400);
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
  await solo(p);
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
