import { launch, openGame, place, pulse, settle, solo } from './shot.ts';
const b = await launch();
const p = await openGame(b);
await solo(p);
const read = () => p.evaluate(() => (window as any).__bs.per.structural.used as number);

await p.evaluate(() => (window as any).__bs.clearField());
await place(p, 43, 32, Math.PI, -0.02);
await pulse(p); await settle(p, 1.6);
const first = await read();
// Same spot, same view: dedup must refresh in place, not append a second copy.
await pulse(p); await settle(p, 1.6);
const second = await read();
// Each pulse samples a random subset of the voxels in view, so successive rescans of the
// same view fill in and then CONVERGE. What must never happen is unbounded growth.
const series = [first, second];
for (let i = 0; i < 4; i++) { await pulse(p); await settle(p, 1.4); series.push(await read()); }
const deltas = series.slice(1).map((v, i) => v - series[i]!);
// A different room must still add genuinely new points.
await place(p, 13, 12, 0.6, 0);
await pulse(p); await settle(p, 1.6);
const newRoom = await read();

console.log('rescan series:', series.join(' -> '));
console.log('deltas:       ', deltas.join(', '));
console.log(`new room adds: +${newRoom - series[series.length - 1]!}`);
const monotone = deltas.every((d, i) => i === 0 || d <= deltas[i - 1]!);
const converging = monotone && deltas[deltas.length - 1]! < deltas[0]! * 0.45;
const bounded = series[series.length - 1]! < first * 2.5;
const newRoomWorks = newRoom - series[series.length - 1]! > first * 0.3;
const ok = converging && bounded && newRoomWorks;
console.log(ok ? 'DEDUP OK — rescans converge, new space still registers'
              : `DEDUP FAIL converging=${converging} bounded=${bounded} newRoom=${newRoomWorks}`);
await b.close();
process.exit(ok ? 0 : 1);
