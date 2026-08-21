// Iterations 3 & 4 through two real browser clients: combat, its information cost,
// gadgets, deception, and the upgrade draft.
import { launch, openGame, settle, shot, driveTo, serverPos, errsOf } from './shot.ts';
import type { Page } from 'playwright';

const b = await launch();
const A = await openGame(b, undefined, 1100, 680);
const B = await openGame(b, undefined, 1100, 680);
let pass = 0, fail = 0;
const chk = (n: string, c: boolean, e = '') => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + ' ' + e)); };
const state = (p: Page) => p.evaluate(() => (window as any).__bs.state().self);
const ghostN = (p: Page) => p.evaluate(() => {
  const G = (window as any).__bs.per.ghosts;
  const Bi = (G as any).birth.array as Float32Array;
  let n = 0; for (let i = 0; i < Bi.length; i++) if (Bi[i] > -1e8) n++;
  return n;
});
const auxN = (p: Page) => p.evaluate(() => (window as any).__bs.per.aux.used as number);
const lookAt = (p: Page, x: number, z: number) => p.evaluate(([tx, tz]) => {
  const bs = (window as any).__bs;
  const s = bs.state().self;
  bs.ctl.yaw = Math.atan2(-((tx as number) - s.x), -((tz as number) - s.z));
  bs.ctl.pitch = 0;
}, [x, z] as any);

await A.click('#b-create'); await A.waitForSelector('#s-lobby:not(.hidden)');
const code = (await A.textContent('#l-code'))!.trim();
await B.fill('#i-code', code); await B.click('#b-join');
await B.waitForSelector('#s-lobby:not(.hidden)');
// B takes the Whisper so both information profiles are exercised.
await B.click('.wcard[data-w="whisper"]');
await A.click('#b-ready'); await B.click('#b-ready');
await A.waitForFunction(() => (window as any).__bs.screen() === 'game');
await B.waitForFunction(() => (window as any).__bs.screen() === 'game');
chk('weapon choice reached the server', (await state(B)).weapon === 'whisper', (await state(B)).weapon);

const LANE = 11.5;
await Promise.all([driveTo(A, 6, LANE, -Math.PI / 2), driveTo(B, 16, LANE, Math.PI / 2)]);
await settle(A, 0.5);
const pb = await serverPos(B);
await lookAt(A, pb.x, pb.z);

console.log('\n[1] the Judge: damage, and the room it lights for BOTH of you');
const bAux0 = await auxN(B);
await A.evaluate(() => (window as any).__bs.fire());
await settle(A, 0.8);
let sb = await state(B);
chk('the Judge lands 50 damage', Math.abs(sb.hp - 50) < 1, `hp=${sb.hp}`);
chk('the victim is handed geometry by the shot', (await auxN(B)) > bAux0 + 40, `aux ${bAux0} -> ${await auxN(B)}`);
chk('the victim learns the bearing the round came from', await B.evaluate(() => {
  const h = (window as any).__bs.per.lastHit; return !!h && Math.hypot(h.fx, h.fy, h.fz) > 0.5;
}));
let sa = await state(A);
chk('the shooter earned XP for the damage', sa.xp >= 12, `xp=${sa.xp}`);
chk('ammo was consumed', sa.ammo === 4, `ammo=${sa.ammo}`);
await shot(B, 'gp-1-shot-at-me');

console.log('\n[2] the Whisper says much less');
const aAux0 = await auxN(A);
await lookAt(B, (await serverPos(A)).x, (await serverPos(A)).z);
await B.evaluate(() => (window as any).__bs.fire());
await settle(B, 0.7);
sa = await state(A);
chk('the Whisper lands 16 damage', Math.abs(sa.hp - 84) < 1, `hp=${sa.hp}`);
const aAux1 = await auxN(A);
chk('the Whisper hands its victim far less than the Judge did',
    aAux1 - aAux0 < (await auxN(B)) - bAux0, `whisper gave ${aAux1 - aAux0}, judge gave ${(await auxN(B)) - bAux0}`);

console.log('\n[3] a kill, a death burst and a respawn');
await A.evaluate(() => (window as any).__bs.fire());
await settle(A, 1.3);
await A.evaluate(() => (window as any).__bs.fire());
await settle(A, 1.0);
sb = await state(B);
chk('B was killed', !sb.alive || sb.hp <= 0, `hp=${sb.hp} alive=${sb.alive}`);
chk('B sees their killer (death burst)', (await ghostN(B)) > 300, `n=${await ghostN(B)}`);
await shot(B, 'gp-2-death-burst');
sa = await state(A);
chk('the kill is worth 100 XP and levels the shooter', sa.level >= 2, `xp=${sa.xp} lv=${sa.level}`);

console.log('\n[4] the level-up draft is offered and takes effect');
const cards = await A.evaluate(() => (window as any).__bs.state().draft);
chk('three cards are offered', Array.isArray(cards) && cards.length === 3, JSON.stringify(cards?.map((c: any) => c.id)));
await shot(A, 'gp-3-draft');
const wantLens = cards?.find((c: any) => c.id === 'longlens' || c.id === 'widelens') ?? cards?.[0];
await A.evaluate((id) => (window as any).__bs.send({ t: 'upgrade', id }), wantLens.id);
await settle(A, 0.5);
sa = await state(A);
chk(`the upgrade "${wantLens.id}" was applied`, sa.upgrades.includes(wantLens.id), JSON.stringify(sa.upgrades));
chk('the draft cleared from the HUD', await A.evaluate(() => document.getElementById('draft')!.classList.contains('hidden')));

console.log('\n[5] gadgets');
await settle(B, 4.5); // wait out the respawn
await driveTo(A, 6, LANE, -Math.PI / 2);
sa = await state(A);
const sp0 = sa.spikes, de0 = sa.decoys, ec0 = sa.echoes;
await A.evaluate(() => (window as any).__bs.gadget('spike'));
await settle(A, 0.4);
await A.evaluate(() => (window as any).__bs.gadget('decoy'));
await settle(A, 0.4);
const auxBefore = await auxN(A);
await A.evaluate(() => (window as any).__bs.gadget('echo'));
await settle(A, 1.6);
sa = await state(A);
chk('a spike was spent', sa.spikes === sp0 - 1, `${sp0} -> ${sa.spikes}`);
chk('a decoy was spent', sa.decoys === de0 - 1, `${de0} -> ${sa.decoys}`);
chk('an echo bomb was spent', sa.echoes === ec0 - 1, `${ec0} -> ${sa.echoes}`);
chk('the echo bomb revealed geometry somewhere else',
    (await A.evaluate(() => (window as any).__bs.per.structural.used as number)) > 0);
await shot(A, 'gp-4-echo-bomb');

console.log('\n[6] the decoy lies to the enemy');
// B walks near A's decoy; the fake footsteps must reach B and be indistinguishable.
const bBefore = await auxN(B);
await driveTo(B, 9, LANE);
await settle(B, 2.5);
chk('B hears footsteps that nobody is making', (await auxN(B)) > bBefore, `aux ${bBefore} -> ${await auxN(B)}`);
await shot(B, 'gp-5-decoy-lies');

console.log('\n[7] the spike reports a trespasser to its owner, silently');
await settle(A, 1.0);
chk('A was told someone crossed the spike', (await ghostN(A)) > 300, `n=${await ghostN(A)}`);
await shot(A, 'gp-6-spike-tripped');

for (const [nm, p] of [['A', A], ['B', B]] as const) {
  const e = errsOf(p).filter((x) => !x.includes('404'));
  if (e.length) { fail++; console.log(`  FAIL ${nm} console errors: ` + e.slice(0, 4).join(' | ')); }
  else { pass++; console.log(`  ok  ${nm} clean console`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
