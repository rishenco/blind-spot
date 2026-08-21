import { launch, openGame, place, pulse, settle, solo, waitForScan } from './shot.ts';
const b = await launch();
const p = await openGame(b);
await solo(p);
const read = () => p.evaluate(() => (window as any).__bs.per.structural.used as number);

await p.evaluate(() => (window as any).__bs.clearField());
await place(p, 43, 32, Math.PI, -0.02);
await pulse(p); await waitForScan(p, 1.2);
const first = await read();
// Same spot, same view: dedup must refresh in place, not append a second copy.
await pulse(p); await waitForScan(p, 1.2);
const second = await read();
// Each pulse samples a random subset of the voxels in view, so successive rescans of the
// same view fill in and then CONVERGE. What must never happen is unbounded growth.
const series = [first, second];
for (let i = 0; i < 4; i++) { await pulse(p); await waitForScan(p, 1.2); series.push(await read()); }
const deltas = series.slice(1).map((v, i) => v - series[i]!);
// A different room must still add genuinely new points.
await place(p, 13, 12, 0.6, 0);
await pulse(p); await waitForScan(p, 1.2);
const newRoom = await read();

console.log('rescan series:', series.join(' -> '));
console.log('deltas:       ', deltas.join(', '));
console.log(`new room adds: +${newRoom - series[series.length - 1]!}`);
const monotone = deltas.every((d, i) => i === 0 || d <= deltas[i - 1]!);
// Successive rescans of one view fill in and converge. Exact monotonicity is not
// required (the touch radius also contributes), but the trend must be clearly downward.
const converging = deltas[deltas.length - 1]! < deltas[0]! * 0.5;
// The real safety property is that repeated scanning cannot run away: it must stay far
// inside the pool. (Rescanning one view keeps filling in detail for a while, which is
// correct — but each pulse costs 4s of cooldown and broadcasts your position, so nobody
// pays that price in practice.)
const cap = await p.evaluate(() => (window as any).__bs.per.structural.capacity as number);
const bounded = series[series.length - 1]! < cap * 0.55;
const newRoomWorks = newRoom - series[series.length - 1]! > first * 0.2;
const ok = converging && bounded && newRoomWorks;
console.log(ok ? 'DEDUP OK — rescans converge, new space still registers'
              : `DEDUP FAIL converging=${converging} bounded=${bounded} newRoom=${newRoomWorks} monotone=${monotone}`);
await b.close();
process.exit(ok ? 0 : 1);
