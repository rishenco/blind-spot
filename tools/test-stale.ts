/**
 * THE ACCEPTANCE TEST.
 *
 * Two real browser clients in a real room against the real server.
 *   A scans B  ->  capture A's view
 *   B walks away, nobody scans  ->  capture A's view again
 *   assert: the ghost has NOT moved, and B's live position is NOT on A's screen
 *   A scans again  ->  assert the ghost jumps to where B actually is now
 */
import { launch, openGame, shot, settle, errsOf, driveTo, serverPos } from './shot.ts';
import type { Page } from 'playwright';

const b = await launch();
const A = await openGame(b, undefined, 1180, 700);
const B = await openGame(b, undefined, 1180, 700);
let pass = 0, fail = 0;
const chk = (n: string, c: boolean, extra = '') => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + ' ' + extra)); };

const ev = (p: Page, fn: string, arg?: any) => p.evaluate(([f, a]) => (window as any).__bs[f as string](a), [fn, arg] as any);

// ── set up a real room ────────────────────────────────────────────────
await A.click('#b-create');
await A.waitForSelector('#s-lobby:not(.hidden)', { timeout: 8000 });
const code = (await A.textContent('#l-code'))!.trim();
console.log('room code:', code);
chk('server issued a 6-character room code', /^[A-Z0-9]{6}$/.test(code), code);

await B.fill('#i-code', code);
await B.click('#b-join');
await B.waitForSelector('#s-lobby:not(.hidden)', { timeout: 8000 });
await A.click('#b-ready');
await B.click('#b-ready');
await A.waitForFunction(() => (window as any).__bs.screen() === 'game', null, { timeout: 8000 });
await B.waitForFunction(() => (window as any).__bs.screen() === 'game', null, { timeout: 8000 });
chk('both clients entered the match', true);

// Park them in the Concourse's clear lane, A looking at B, 16m apart.
const LANE = 11.5;
await Promise.all([driveTo(A, 4, LANE, -Math.PI / 2), driveTo(B, 20, LANE, Math.PI / 2)]);
await settle(A, 0.8);
const pa = await serverPos(A), pb = await serverPos(B);
console.log(`  server has A at (${pa.x.toFixed(2)},${pa.z.toFixed(2)}), B at (${pb.x.toFixed(2)},${pb.z.toFixed(2)})`);
chk('both players are where the test put them (server-side)',
    Math.hypot(pa.x - 4, pa.z - LANE) < 0.6 && Math.hypot(pb.x - 20, pb.z - LANE) < 0.6);
await shot(A, 'mp-0-dark');

const ghostCount = (p: Page) => p.evaluate(() => {
  const g = (window as any).__bs.per.ghosts;
  const B = (g as any).birth.array as Float32Array;
  const P = (g as any).pos.array as Float32Array;
  let n = 0, sx = 0, sz = 0;
  for (let i = 0; i < B.length; i++) if (B[i] > -1e8) { n++; sx += P[i * 3]; sz += P[i * 3 + 2]; }
  return { n, x: n ? sx / n : 0, z: n ? sz / n : 0 };
});

console.log('\n[1] before any scan, A holds no ghost of B');
let g = await ghostCount(A);
chk('A has zero ghost points', g.n === 0, `n=${g.n}`);

console.log('\n[2] A pulses — B is captured');
await ev(A, 'doPulse');
await settle(A, 1.4);
await shot(A, 'mp-1-scan-sees-enemy');
g = await ghostCount(A);
chk('A now holds a ghost', g.n > 300, `n=${g.n}`);
chk('the ghost sits where B actually is', Math.hypot(g.x - pb.x, g.z - pb.z) < 1.2, `(${g.x.toFixed(2)},${g.z.toFixed(2)})`);
const frozen = { x: g.x, z: g.z, n: g.n };

console.log('\n[3] B walks away. NOBODY scans.');
// B retreats ~10m down the same lane. Movement goes through the real input path, and at
// zero reported velocity the server emits no footsteps, so A gets nothing at all.
await driveTo(B, 10.5, LANE, Math.PI / 2);
await settle(A, 0.6);
const bPos = await serverPos(B);
console.log(`  B is now at (${bPos.x.toFixed(2)}, ${bPos.z.toFixed(2)})`);
chk('B genuinely moved', Math.hypot(bPos.x - pb.x, bPos.z - pb.z) > 2.5, `moved ${Math.hypot(bPos.x - pb.x, bPos.z - pb.z).toFixed(1)}m`);

await shot(A, 'mp-2-ghost-is-stale');
g = await ghostCount(A);
chk('A\'s ghost did NOT follow B', Math.hypot(g.x - frozen.x, g.z - frozen.z) < 0.02,
    `drifted ${Math.hypot(g.x - frozen.x, g.z - frozen.z).toFixed(3)}m`);
chk('A\'s ghost is now far from B\'s real position',
    Math.hypot(g.x - bPos.x, g.z - bPos.z) > 2.5,
    `${Math.hypot(g.x - bPos.x, g.z - bPos.z).toFixed(1)}m apart`);

console.log('\n[4] nothing on A\'s screen reveals where B actually is');
// Structural geometry near B is legitimate — A scanned that *room*, and walls are not the
// secret. What must be absent is any LIFE or SOUND point at B's live position: those are
// the only two ways a player is ever drawn.
const near = await A.evaluate(([bx, bz]) => {
  const bs = (window as any).__bs;
  let hits = 0;
  const f = bs.per.aux;
  const P = (f as any).pos.array as Float32Array;
  const Bi = (f as any).birth.array as Float32Array;
  for (let i = 0; i < (f.used as number); i++) {
    if (Bi[i] <= -1e8) continue;
    if (Math.hypot(P[i * 3] - (bx as number), P[i * 3 + 2] - (bz as number)) < 1.6) hits++;
  }
  const G = bs.per.ghosts;
  const GB = (G as any).birth.array as Float32Array, GP = (G as any).pos.array as Float32Array;
  for (let i = 0; i < GB.length; i++) {
    if (GB[i] <= -1e8) continue;
    if (Math.hypot(GP[i * 3] - (bx as number), GP[i * 3 + 2] - (bz as number)) < 1.6) hits++;
  }
  return hits;
}, [bPos.x, bPos.z] as any);
chk(`no life or sound point sits at B's live position (${near} within 1.6m)`, near < 20, `${near} points`);

console.log('\n[5] a fresh scan updates the observation');
await A.evaluate(([bx, bz]) => {
  const bs = (window as any).__bs;
  const dx = (bx as number) - bs.ctl.pos.x, dz = (bz as number) - bs.ctl.pos.z;
  bs.ctl.yaw = Math.atan2(-dx, -dz);
  bs.ctl.pitch = 0;
}, [bPos.x, bPos.z] as any);
await settle(A, 4.2);           // wait out the pulse cooldown
await ev(A, 'doPulse');
await settle(A, 1.4);
await shot(A, 'mp-3-rescan-updates');
g = await ghostCount(A);
chk('the ghost moved to B\'s current position', Math.hypot(g.x - bPos.x, g.z - bPos.z) < 1.6,
    `ghost (${g.x.toFixed(2)},${g.z.toFixed(2)}) vs B (${bPos.x.toFixed(2)},${bPos.z.toFixed(2)})`);

console.log('\n[6] reciprocity: B saw A\'s pulses');
const gb = await ghostCount(B);
chk('B holds a ghost of A purely because A scanned', gb.n > 20, `n=${gb.n}`);
await shot(B, 'mp-4-reciprocity-b-view');

for (const [nm, p] of [['A', A], ['B', B]] as const) {
  const e = errsOf(p).filter((x) => !x.includes('404'));
  if (e.length) { fail++; console.log(`  FAIL ${nm} console errors:\n   ` + e.slice(0, 5).join('\n   ')); }
  else { pass++; console.log(`  ok  ${nm} has no console errors`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
