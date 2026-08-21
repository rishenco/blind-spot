// The lobby must be usable on short screens: every control has to be reachable.
import { launch, openGame, settle } from './shot.ts';
const b = await launch();
let fail = 0;
for (const [w, h] of [[900, 560], [1280, 760], [1024, 640], [1440, 900]] as const) {
  const A = await openGame(b, undefined, w, h);
  await A.click('#b-create');
  await A.waitForSelector('#s-lobby:not(.hidden)');
  await settle(A, 0.4);
  const r = await A.evaluate(() => {
    const btn = document.getElementById('b-ready')!.getBoundingClientRect();
    const card = document.querySelector('#s-lobby .card')!.getBoundingClientRect();
    return { btnTop: btn.top, btnBottom: btn.bottom, cardTop: card.top, vh: innerHeight,
             scrollable: (document.getElementById('s-lobby') as HTMLElement).scrollHeight >
                         (document.getElementById('s-lobby') as HTMLElement).clientHeight };
  });
  // Either it fits, or the screen scrolls so it can be reached.
  const reachable = (r.btnBottom <= r.vh && r.btnTop >= 0) || r.scrollable;
  console.log(`  ${reachable ? 'ok  ' : 'FAIL'} ${w}x${h}: READY at ${r.btnTop.toFixed(0)}..${r.btnBottom.toFixed(0)} ` +
              `of ${r.vh}${r.scrollable ? ' (scrollable)' : ''}`);
  if (!reachable) fail++;
  await A.context().close();
}
console.log(fail ? `\n${fail} FAILED` : '\nUI FITS');
await b.close();
process.exit(fail ? 1 : 0);
