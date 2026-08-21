// A full match, end to end, through two browser clients: find the relic, carry it,
// extract, and confirm the win screen.
import { launch, openGame, settle, shot, driveTo, serverPos, errsOf } from './shot.ts';
import type { Page } from 'playwright';

const b = await launch();
const A = await openGame(b, undefined, 1100, 680);
const B = await openGame(b, undefined, 1100, 680);
let pass = 0, fail = 0;
const chk = (n: string, c: boolean, e = '') => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + ' ' + e)); };
const state = (p: Page) => p.evaluate(() => (window as any).__bs.state());

await A.click('#b-create'); await A.waitForSelector('#s-lobby:not(.hidden)');
const code = (await A.textContent('#l-code'))!.trim();
await B.fill('#i-code', code); await B.click('#b-join');
await B.waitForSelector('#s-lobby:not(.hidden)');
await A.click('#b-ready'); await B.click('#b-ready');
await A.waitForFunction(() => (window as any).__bs.screen() === 'game');
await B.waitForFunction(() => (window as any).__bs.screen() === 'game');

console.log('\n[1] the relic announces itself to both players');
await settle(A, 3.0);
const goldA = (p: Page) => p.evaluate(() => {
  const f = (window as any).__bs.per.aux;
  const K = (f as any).kind.array as Float32Array;
  const Bi = (f as any).birth.array as Float32Array;
  let n = 0; for (let i = 0; i < (f.used as number); i++) if (Bi[i] > -1e8 && K[i] === 3) n++;
  return n;
});
chk('A heard the heartbeat and sees gold', await A.evaluate(() =>
  (window as any).__bs.per.lastHeartbeatAt > 0));
chk('B heard it too', await B.evaluate(() => (window as any).__bs.per.lastHeartbeatAt > 0));
await shot(A, 'match-1-heartbeat');

console.log('\n[2] A walks to the relic and takes it');
// BS_ROOM_SEED=7 puts the relic in the VAULT at (43, 42).
await driveTo(A, 43, 42);
await settle(A, 1.0);
let sa = await state(A);
chk('A is carrying the relic', sa.self.carrying, JSON.stringify({ carrying: sa.self.carrying }));
chk('the pickup is worth XP', sa.self.xp >= 60, `xp=${sa.self.xp}`);
chk('the extraction beacon lit for both', sa.match.beaconLit && (await state(B)).match.beaconLit);
chk('the carrier cannot sprint', await A.evaluate(() => (window as any).__bs.ctl.canSprint === false));

console.log('\n[3] the carrier sings — B gets a fix without doing anything');
const bGhost = () => B.evaluate(() => {
  const G = (window as any).__bs.per.ghosts;
  const Bi = (G as any).birth.array as Float32Array;
  let n = 0; for (let i = 0; i < Bi.length; i++) if (Bi[i] > -1e8) n++;
  return n;
});
await settle(B, 6.0);
chk('B holds a contact of the carrier purely from the sing', (await bGhost()) > 0, `n=${await bGhost()}`);
await shot(B, 'match-2-carrier-sings');

console.log('\n[4] extraction');
await driveTo(A, 29, 26.5);
await A.evaluate(() => { const c = (window as any).__bs.ctl; c.vel.x = 0; c.vel.z = 0; });
// Hold still in the ring; the server channels for 3.5s.
let shotTaken = false;
for (let i = 0; i < 90; i++) {
  await A.evaluate(([bx, bz]) => {
    const bs = (window as any).__bs;
    bs.ctl.teleport({ x: bx as number, y: 0, z: bz as number });
    bs.ctl.vel.x = 0; bs.ctl.vel.z = 0;
    bs.send({ t: 'input', seq: 0, x: bx, y: 0, z: bz, yaw: bs.ctl.yaw, pitch: 0, stance: 1, vx: 0, vz: 0 });
  }, [29, 26.5] as any);
  await settle(A, 0.09);
  if (await A.evaluate(() => (window as any).__bs.screen() === 'over')) { console.log(`  channel completed on iteration ${i}`); break; }
  const s = await state(A);
  if (!shotTaken && s.self.channel > 0.45) { shotTaken = true; await shot(A, 'match-3-channelling'); }
  if (i % 20 === 0) console.log(`  i=${i} channel=${s.self.channel.toFixed(2)} carrying=${s.self.carrying} dist=${Math.hypot(s.self.x - 29, s.self.z - 26.5).toFixed(2)}`);
}
await settle(A, 0.6);
chk('A reached the end screen', await A.evaluate(() => (window as any).__bs.screen() === 'over'));
chk('A is shown as the winner', (await A.textContent('#o-title'))?.trim() === 'EXTRACTED',
    (await A.textContent('#o-title')) ?? '');
chk('B is shown as the loser', (await B.textContent('#o-title'))?.trim() === 'LOST',
    (await B.textContent('#o-title')) ?? '');
await shot(A, 'match-4-extracted');

console.log('\n[5] rematch returns both players to the lobby');
await A.click('#b-rematch');
await settle(A, 0.8);
chk('A is back in the lobby', await A.evaluate(() => (window as any).__bs.screen() === 'lobby'));

for (const [nm, p] of [['A', A], ['B', B]] as const) {
  const e = errsOf(p).filter((x) => !x.includes('404'));
  if (e.length) { fail++; console.log(`  FAIL ${nm} console errors: ` + e.slice(0, 4).join(' | ')); }
  else { pass++; console.log(`  ok  ${nm} clean console`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
