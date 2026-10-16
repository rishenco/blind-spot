// Headless gameplay bot: the player stands with their back to the rim and dodges sideways when the
// charging ram is `dodgeAt` meters away. Reports what the ram did each trial.
// usage: node scripts/bot.mjs <url> '<json array of dodgeAt values>' [trials]
import { chromium } from 'playwright-core';

const [url, listJson, trialsArg] = process.argv.slice(2);
const list = JSON.parse(listJson);
const trials = Number(trialsArg ?? 3);
const center = process.argv[5] === 'center';
const startCharges = Number(process.env.CHARGES ?? 0);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__game);
for (const dodgeAt of list) {
  for (let t = 0; t < trials; t++) {
    const r = await page.evaluate(([dodgeAt, seed, center, startCharges]) => {
      const g = window.__game;
      g.input.pressed.add('AnyClick');
      g.advance(1 / 60, false);
      const P = g.player, R = g.ram;
      R.charges = startCharges;
      const ang = seed * 2.1 + 0.4;
      // back to the rim: 0.8 m inside it
      let r0 = 3;
      for (; r0 < 12; r0 += 0.05) { const x = Math.cos(ang) * r0, z = Math.sin(ang) * r0; if (!g.__edge(x, z)) break; }
      if (center) P.pos.set(0, 0, 0); else P.pos.set(Math.cos(ang) * (r0 - 0.8), 0, Math.sin(ang) * (r0 - 0.8));
      const log = [];
      let last = '', dodged = false, frames = 0;
      while (frames++ < 60 * 25) {
        if (R.state !== last) { log.push(`${(frames / 60).toFixed(2)}:${R.state}${R.state === 'paw' ? '(' + Math.hypot(P.pos.x, P.pos.z).toFixed(1) + ')' : ''}`); last = R.state; }
        if (g.phase !== 'fight') break;
        if (R.state === 'charge' && !dodged) {
          const dx = P.pos.x - R.pos.x, dz = P.pos.z - R.pos.z;
          const along = dx * R.dir.x + dz * R.dir.z;
          if (along < dodgeAt) {
            const sx = R.dir.z, sz = -R.dir.x; const s = (sx * -P.pos.x + sz * -P.pos.z) >= 0 ? 1 : -1;
            P.yaw = Math.atan2(sx * s, sz * s);
            g.input.pressed.add('Space');
            dodged = true;
            log.push(`dodge@${along.toFixed(2)}${R.feint ? 'F' : ''}`);
          }
        }
        if (dodged && R.state !== 'charge' && P.state === 'move' && R.state !== 'falling') {
          // walk back to the rim spot for the next charge
          dodged = false;
        }
        g.advance(1 / 60, false);
      }
      const res = { phase: g.phase, ram: R.state, player: P.state, log: log.slice(0, 40).join(' ') };
      return res;
    }, [dodgeAt, t, center, startCharges]);
    console.log(`dodgeAt=${dodgeAt} trial=${t}`, JSON.stringify(r));
    await page.evaluate(() => location.reload());
    await page.waitForFunction(() => window.__game);
  }
}
await browser.close();
