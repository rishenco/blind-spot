// Visual review of every non-game screen.
import { launch, openGame, settle, shot, driveTo } from './shot.ts';
const b = await launch();
const A = await openGame(b, undefined, 1280, 760);
const B = await openGame(b, undefined, 1280, 760);
await settle(A, 0.5);
await shot(A, 'ui-1-menu');
await A.click('#b-create'); await A.waitForSelector('#s-lobby:not(.hidden)');
await settle(A, 0.4);
await shot(A, 'ui-2-lobby-waiting');
const code = (await A.textContent('#l-code'))!.trim();
await B.fill('#i-code', code); await B.click('#b-join');
await B.waitForSelector('#s-lobby:not(.hidden)');
await B.click('.wcard[data-w="whisper"]');
await B.click('#b-ready');
await settle(A, 0.5);
await shot(A, 'ui-3-lobby-opponent-ready');
await A.click('#b-ready');
await A.waitForFunction(() => (window as any).__bs.screen() === 'game');
await settle(A, 1.0);
// Force a draft offer to review its presentation.
await A.evaluate(() => {
  (window as any).__bs.per.notices.push({ id: 77, text: 'RELIC TAKEN. YOU ARE SINGING.', tone: 'good', at: (window as any).__bs.clock() });
});
await settle(A, 0.4);
await shot(A, 'ui-4-hud');
await b.close();
console.log('captured');
