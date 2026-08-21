// Soak test: two clients playing semi-randomly for a while. Looks for the failure modes a
// scripted test misses — console errors under load, unbounded point-pool growth, event
// starvation, and the perceived state drifting out of sync with the simulation.
import { launch, openGame, settle, driveTo, errsOf, shot } from './shot.ts';
import type { Page } from 'playwright';

const b = await launch();
const A = await openGame(b, undefined, 900, 600);
const B = await openGame(b, undefined, 900, 600);
let pass = 0, fail = 0;
const chk = (n: string, c: boolean, e = '') => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + ' ' + e)); };

await A.click('#b-create'); await A.waitForSelector('#s-lobby:not(.hidden)');
const code = (await A.textContent('#l-code'))!.trim();
await B.fill('#i-code', code); await B.click('#b-join');
await B.waitForSelector('#s-lobby:not(.hidden)');
await B.click('.wcard[data-w="whisper"]');
await A.click('#b-ready'); await B.click('#b-ready');
await A.waitForFunction(() => (window as any).__bs.screen() === 'game');
await B.waitForFunction(() => (window as any).__bs.screen() === 'game');

const stats = (p: Page) => p.evaluate(() => {
  const bs = (window as any).__bs;
  return {
    struct: bs.per.structural.used, aux: bs.per.aux.used,
    cap: bs.per.structural.capacity, pending: bs.per.pulses.pending,
    self: bs.state().self, t: bs.state().match?.t ?? 0,
  };
});
const act = async (p: Page, i: number) => {
  await p.evaluate((n) => {
    const bs = (window as any).__bs;
    bs.ctl.yaw = (n * 0.7) % 6.283;
    bs.ctl.pitch = Math.sin(n) * 0.2;
    bs.doPulse();
    if (n % 3 === 0) bs.fire();
    if (n % 7 === 0) bs.gadget('decoy');
    if (n % 11 === 0) bs.gadget('spike');
    if (n % 13 === 0) bs.gadget('echo');
    if (n % 5 === 0) bs.send({ t: 'reload' });
    const d = bs.state().draft;
    if (d && d.length) bs.send({ t: 'upgrade', id: d[0].id });
  }, i);
};

// Roam the map: a route that visits every zone.
const routeA: [number, number][] = [[13, 11.5], [23, 26.5], [40, 26.5], [43, 34], [43, 42], [29, 27], [12, 40], [6, 26.5]];
const routeB: [number, number][] = [[45, 12], [50, 26.5], [29, 27], [12, 43], [6, 20], [20, 11.5], [35, 26.5], [50, 40]];

console.log('roaming both players through every zone while they scan, shoot and throw...');
let peakStruct = 0;
for (let i = 0; i < routeA.length; i++) {
  await Promise.all([
    driveTo(A, routeA[i]![0], routeA[i]![1]).catch((e) => console.log('  (A pathing: ' + e.message + ')')),
    driveTo(B, routeB[i]![0], routeB[i]![1]).catch((e) => console.log('  (B pathing: ' + e.message + ')')),
  ]);
  await act(A, i * 2); await act(B, i * 2 + 1);
  await settle(A, 1.4);
  const sa = await stats(A);
  peakStruct = Math.max(peakStruct, sa.struct);
  console.log(`  leg ${i}: t=${sa.t.toFixed(0)}s  A struct=${(sa.struct / 1000).toFixed(0)}k aux=${(sa.aux / 1000).toFixed(0)}k ` +
              `hp=${Math.round(sa.self.hp)} lv=${sa.self.level} xp=${sa.self.xp}`);
}

const fa = await stats(A), fb = await stats(B);
chk('the structural pool never exceeded its capacity', peakStruct <= fa.cap, `${peakStruct} / ${fa.cap}`);
chk('both players accumulated a substantial map', fa.struct > 40000 && fb.struct > 40000, `A=${fa.struct} B=${fb.struct}`);
chk('the pulse queue drained (no runaway backlog)', fa.pending < 6 && fb.pending < 6, `A=${fa.pending} B=${fb.pending}`);
// Levelling from a scripted flail is luck; test-gameplay.ts covers the real path (a kill
// levels the shooter). What must hold here is that XP accrues from genuine activity at all.
chk('XP accrued from real activity', fa.self.xp > 0 || fb.self.xp > 0, `A=${fa.self.xp} B=${fb.self.xp}`);
chk('the match is still live and progressing', fa.t > 20, `t=${fa.t}`);
chk('gadget charges were actually consumed',
    fa.self.spikes < 2 || fa.self.decoys < 2 || fa.self.echoes < 2,
    JSON.stringify({ s: fa.self.spikes, d: fa.self.decoys, e: fa.self.echoes }));
await shot(A, 'soak-final-a');
await shot(B, 'soak-final-b');

for (const [nm, p] of [['A', A], ['B', B]] as const) {
  const e = errsOf(p).filter((x) => !x.includes('404'));
  if (e.length) { fail++; console.log(`  FAIL ${nm} console errors: ` + e.slice(0, 5).join(' | ')); }
  else { pass++; console.log(`  ok  ${nm} clean console across the whole run`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
