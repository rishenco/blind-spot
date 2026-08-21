// Close-up visual inspection of the three contact resolutions.
import { launch, openGame, settle, shot, driveTo, serverPos } from './shot.ts';

const b = await launch();
const A = await openGame(b, undefined, 900, 700);
const B = await openGame(b, undefined, 900, 700);
await A.click('#b-create'); await A.waitForSelector('#s-lobby:not(.hidden)');
const code = (await A.textContent('#l-code'))!.trim();
await B.fill('#i-code', code); await B.click('#b-join');
await B.waitForSelector('#s-lobby:not(.hidden)');
await A.click('#b-ready'); await B.click('#b-ready');
await A.waitForFunction(() => (window as any).__bs.screen() === 'game');
await B.waitForFunction(() => (window as any).__bs.screen() === 'game');

const LANE = 11.5;
// Close enough that the silhouette fills a good part of the frame.
await Promise.all([driveTo(A, 8, LANE, -Math.PI / 2), driveTo(B, 15, LANE, Math.PI / 2)]);
await settle(A, 0.6);
console.log('A', await serverPos(A), 'B', await serverPos(B));
await A.evaluate(() => (window as any).__bs.doPulse());
await settle(A, 1.2);
await shot(A, 'ghost-full');
await settle(A, 9);
await shot(A, 'ghost-full-cooled');
console.log('captured');
await b.close();
