// Honest perf breakdown. This machine renders through SwiftShader (software GL), so the
// absolute numbers are not representative of a GPU — but the RATIO between configurations
// tells us where the cost is.
import { launch, openGame, settle, solo, place, pulse } from './shot.ts';
const b = await launch();
const p = await openGame(b, undefined, 1280, 760);
await solo(p);
for (let i = 0; i < 6; i++) {
  await place(p, 10 + i * 3, 11.5, Math.PI / 2 + i * 0.4, 0);
  await pulse(p); await settle(p, 1.0);
}
const measure = async (label: string, cfg: [boolean, boolean, boolean]) => {
  await p.evaluate(([post, bloom, pts]) => {
    const bs = (window as any).__bs;
    bs.post.enabled = post; bs.post.bloom.enabled = bloom; bs.per.group.visible = pts;
  }, cfg as any);
  await settle(p, 1.2);
  // Passed as a source string: esbuild's keep-names transform injects a __name helper into
  // any function it can see, and that helper does not exist in the page.
  const r = (await p.evaluate(`new Promise(function (res) {
    var n = 0, t0 = performance.now();
    function tick() { if (++n < 40) requestAnimationFrame(tick); else res(40000 / (performance.now() - t0)); }
    requestAnimationFrame(tick);
  })`)) as number;
  console.log(`  ${label.padEnd(28)} ${r.toFixed(1)} fps`);
};
const pts = await p.evaluate(() => (window as any).__bs.per.structural.used);
console.log(`points in field: ${pts}`);
await measure('full chain', [true, true, true]);
await measure('no bloom', [true, false, true]);
await measure('no post at all', [false, false, true]);
await measure('post on, no points', [true, true, false]);
await b.close();
