// Unit test for pulse yield. A pulse that returns almost nothing is invisible, and it is
// far cheaper to catch that here than by staring at screenshots.
import { buildMap } from '../src/shared/map.ts';
import { PulseJob } from '../src/client/scan.ts';

const map = buildMap();
class MockField {
  n = 0;
  vox = new Set<number>();
  push(x: number, y: number, z: number, _b: number, _d: number, _i: number, _k: number) {
    this.n++;
    const V = 0.045;
    this.vox.add((Math.floor(x / V) + 1024) + (Math.floor(y / V) + 128) * 2048 + (Math.floor(z / V) + 1024) * 2048 * 256);
  }
}

let fail = 0;
function run(name: string, spec: any, minKept: number, minVox: number) {
  const f = new MockField();
  const job = new PulseJob(spec);
  let guard = 0;
  while (!job.done && guard++ < 200) job.run(map.world, f as any, 4200);
  const yieldPct = (f.n / spec.rays) * 100;
  const ok = f.n >= minKept && f.vox.size >= minVox;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: ${f.n} points from ${spec.rays} rays ` +
              `(${yieldPct.toFixed(1)}% yield), ${f.vox.size} distinct voxels`);
  if (!ok) fail++;
  return f;
}

const base = {
  dx: -0.72, dy: 0, dz: 0.69, halfAngle: (35 * Math.PI) / 180, range: 28,
  waveSpeed: 60, startTime: 0, densityFalloff: 1, seed: 5, rays: 46000,
};
console.log('Concourse, 46k-ray cone pulse:');
// Facing into the length of the hall, not into the wall three metres behind it.
run('open hall', { ...base, ox: 22, oy: 1.58, oz: 18, dx: -1, dy: 0, dz: 0 }, 12000, 8000);
run('short range (wall 3.6m away)', { ...base, ox: 22, oy: 1.58, oz: 18 }, 10000, 3400);
console.log('Spine corridor:');
run('corridor', { ...base, ox: 8, oy: 1.58, oz: 26.5, dx: 1, dy: 0, dz: 0 }, 10000, 5000);
console.log('Touch radius (omni, short, low gain):');
run('touch', { ...base, ox: 22, oy: 1.58, oz: 18, halfAngle: Math.PI, range: 2.5, rays: 2400,
               densityFalloff: 0, gain: 0.2, elevMax: 1.35 }, 240, 230);

console.log(fail ? `\n${fail} FAILED` : '\nSCAN OK');
process.exit(fail ? 1 : 0);
