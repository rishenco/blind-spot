// Does the extraction beacon read as a landmark from across the map?
import { launch, openGame, settle, shot, driveTo, waitForScan } from './shot.ts';
const b = await launch();
const A = await openGame(b, undefined, 1100, 680);
const B = await openGame(b, undefined, 1100, 680);
await A.click('#b-create'); await A.waitForSelector('#s-lobby:not(.hidden)');
const code = (await A.textContent('#l-code'))!.trim();
await B.fill('#i-code', code); await B.click('#b-join');
await B.waitForSelector('#s-lobby:not(.hidden)');
await A.click('#b-ready'); await B.click('#b-ready');
await A.waitForFunction(() => (window as any).__bs.screen() === 'game');
await B.waitForFunction(() => (window as any).__bs.screen() === 'game');
// A takes the relic (seed 7 -> VAULT) so the beacon lights for both.
await driveTo(A, 43, 42);
await settle(A, 1.0);
// B walks down the Spine and looks at The Well from 20m west of it.
await driveTo(B, 12, 26.5);
await B.evaluate(() => { const bs = (window as any).__bs;
  const s = bs.state().self; bs.ctl.yaw = Math.atan2(-(29 - s.x), -(26.5 - s.z)); bs.ctl.pitch = 0.06; });
await settle(B, 1.2);
await shot(B, 'beacon-1-from-afar-unscanned');
await B.evaluate(() => (window as any).__bs.doPulse());
await waitForScan(B, 1.4);
await shot(B, 'beacon-2-from-afar-scanned');
// And from inside the ring, as the carrier sees it.
await driveTo(A, 29, 26.5);
await A.evaluate(() => { (window as any).__bs.ctl.yaw = Math.PI / 2; (window as any).__bs.ctl.pitch = 0; });
await settle(A, 1.2);
await shot(A, 'beacon-3-from-inside-the-ring');
console.log('captured');
await b.close();
