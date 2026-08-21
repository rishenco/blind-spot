// Movement and collision through the real controller, in a real browser, with real keys.
import { launch, openGame, settle, solo, place } from './shot.ts';
import type { Page } from 'playwright';

const b = await launch();
const p = await openGame(b, undefined, 900, 600);
await solo(p);
let pass = 0, fail = 0;
const chk = (n: string, c: boolean, e = '') => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + ' ' + e)); };
const pos = (pg: Page) => pg.evaluate(() => { const c = (window as any).__bs.ctl; return { x: +c.pos.x.toFixed(3), y: +c.pos.y.toFixed(3), z: +c.pos.z.toFixed(3) }; });
const hold = async (pg: Page, codes: string[], secs: number) => {
  await pg.evaluate((cs) => { const c = (window as any).__bs.ctl; for (const k of cs) c.keys.add(k); }, codes);
  await settle(pg, secs);
  await pg.evaluate(() => (window as any).__bs.ctl.keys.clear());
  await settle(pg, 0.25);
};

// Open lane in the Concourse, facing -X.
await place(p, 20, 11.5, Math.PI / 2, 0);
await settle(p, 0.4);

console.log('[1] walking');
let a = await pos(p);
await hold(p, ['KeyW'], 1.2);
let bpos = await pos(p);
const walked = Math.hypot(bpos.x - a.x, bpos.z - a.z);
chk('W moves the player forward', walked > 2.5, `${walked.toFixed(2)}m in 1.2s`);
chk('forward is the direction being faced (-X)', bpos.x < a.x - 2 && Math.abs(bpos.z - a.z) < 1.0,
    `(${a.x},${a.z}) -> (${bpos.x},${bpos.z})`);

console.log('[2] sprint is faster than walk');
await place(p, 20, 11.5, Math.PI / 2, 0); await settle(p, 0.4);
a = await pos(p); await hold(p, ['KeyW', 'ShiftLeft'], 1.2); bpos = await pos(p);
const sprinted = Math.hypot(bpos.x - a.x, bpos.z - a.z);
chk('sprinting covers more ground', sprinted > walked * 1.25, `walk ${walked.toFixed(2)} vs sprint ${sprinted.toFixed(2)}`);

console.log('[3] crouch is slower and lowers the eye');
await place(p, 20, 11.5, Math.PI / 2, 0); await settle(p, 0.4);
const eyeStanding = await p.evaluate(() => (window as any).__bs.ctl.eyeY);
a = await pos(p); await hold(p, ['KeyW', 'ControlLeft'], 1.2); bpos = await pos(p);
const crouched = Math.hypot(bpos.x - a.x, bpos.z - a.z);
chk('crouching covers less ground', crouched < walked * 0.75, `${crouched.toFixed(2)} vs ${walked.toFixed(2)}`);
await p.evaluate(() => (window as any).__bs.ctl.keys.add('ControlLeft'));
await settle(p, 0.3);
const eyeCrouched = await p.evaluate(() => (window as any).__bs.ctl.eyeY);
await p.evaluate(() => (window as any).__bs.ctl.keys.clear());
chk('the eye drops when crouched', eyeCrouched < eyeStanding - 0.4, `${eyeStanding.toFixed(2)} -> ${eyeCrouched.toFixed(2)}`);

console.log('[4] walls stop the player');
// Face +X toward the Concourse east wall. Open cells run to x=25, so the wall face is at
// x=26 and a player of radius 0.34 should stop at 25.66.
await place(p, 21, 11.5, -Math.PI / 2, 0); await settle(p, 0.4);
await hold(p, ['KeyW', 'ShiftLeft'], 2.5);
bpos = await pos(p);
chk('the player does not pass through the wall', bpos.x <= 25.67, `x=${bpos.x}`);
chk('the player is stopped exactly one radius short of it', bpos.x > 25.5, `x=${bpos.x}`);

console.log('[5] strafing works and does not drift vertically');
await place(p, 20, 11.5, Math.PI / 2, 0); await settle(p, 0.4);
a = await pos(p); await hold(p, ['KeyD'], 1.0); bpos = await pos(p);
chk('D strafes sideways', Math.abs(bpos.z - a.z) > 1.5 && Math.abs(bpos.x - a.x) < 1.0,
    `(${a.x},${a.z}) -> (${bpos.x},${bpos.z})`);
chk('the player stays on the floor', Math.abs(bpos.y) < 0.05, `y=${bpos.y}`);

console.log('[6] the mezzanine ramp can be climbed');
// The ramp is a stair of 0.325m steps climbing toward -X, from x~23 to x~14.
await place(p, 23.5, 7.5, Math.PI / 2, 0); await settle(p, 0.4);
await hold(p, ['KeyW'], 3.0);
bpos = await pos(p);
chk('the ramp lifts the player off the floor', bpos.y > 0.4, `y=${bpos.y}`);

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
