import { launch, openGame, settle, driveTo, serverPos } from './shot.ts';
const b = await launch();
const A = await openGame(b, undefined, 900, 600);
const B = await openGame(b, undefined, 900, 600);
await A.click('#b-create'); await A.waitForSelector('#s-lobby:not(.hidden)');
const code = (await A.textContent('#l-code'))!.trim();
await B.fill('#i-code', code); await B.click('#b-join');
await B.waitForSelector('#s-lobby:not(.hidden)');
await A.click('#b-ready'); await B.click('#b-ready');
await A.waitForFunction(() => (window as any).__bs.screen() === 'game');
await B.waitForFunction(() => (window as any).__bs.screen() === 'game');
await driveTo(A, 43, 42);
await settle(A, 0.8);
console.log('carrying:', (await A.evaluate(() => (window as any).__bs.state().self.carrying)));
await driveTo(A, 29, 26.5);
await settle(A, 0.5);
console.log('after driveTo, server pos:', await serverPos(A));
for (let i = 0; i < 20; i++) {
  await A.evaluate(() => {
    const bs = (window as any).__bs;
    bs.send({ t: 'input', seq: 0, x: 29, y: 0, z: 26.5, yaw: bs.ctl.yaw, pitch: 0, stance: 1, vx: 0, vz: 0 });
  });
  await settle(A, 0.15);
  const s = await A.evaluate(() => (window as any).__bs.state());
  if (i % 4 === 0) console.log(`t=${s.match.t.toFixed(1)} pos=(${s.self.x.toFixed(2)},${s.self.z.toFixed(2)}) ` +
    `dist=${Math.hypot(s.self.x-29, s.self.z-26.5).toFixed(2)} channel=${s.self.channel.toFixed(2)} carrying=${s.self.carrying} alive=${s.self.alive}`);
  if (await A.evaluate(() => (window as any).__bs.screen() === 'over')) { console.log('OVER at i=' + i); break; }
}
await b.close();
