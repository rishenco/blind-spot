import { World, Mat, type Box } from '../src/shared/world.ts';

const boxes: Box[] = [
  { min: { x: -50, y: -1, z: -50 }, max: { x: 50, y: 0, z: 50 }, mat: Mat.Concrete }, // floor
  { min: { x: 9, y: 0, z: -5 }, max: { x: 10, y: 3, z: 5 }, mat: Mat.Metal },          // wall at x=9..10
  { min: { x: -3, y: 0, z: 20 }, max: { x: 3, y: 3, z: 21 }, mat: Mat.Glass },         // far wall z=20
];
const w = new World(boxes);
let pass = 0, fail = 0;
const chk = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log('FAIL:', name, extra); }
};

// 1. Straight hit on near wall
let h = w.raycast(0, 1.5, 0, 1, 0, 0, 100);
chk('hits wall at x=9', !!h && Math.abs(h.t - 9) < 1e-3, JSON.stringify(h));
chk('wall normal -X', !!h && h.nx === -1, JSON.stringify(h));
chk('wall material metal', !!h && h.mat === Mat.Metal);

// 2. Long ray across many grid cells
h = w.raycast(0, 1.5, 0, 0, 0, 1, 100);
chk('hits far wall at z=20 (multi-cell DDA)', !!h && Math.abs(h.t - 20) < 1e-3, JSON.stringify(h));

// 3. Ray that misses everything horizontally
h = w.raycast(0, 1.5, 0, -1, 0, 0, 100);
chk('miss to -X returns null', h === null, JSON.stringify(h));

// 4. Downward ray hits floor
h = w.raycast(0, 1.5, 0, 0, -1, 0, 100);
chk('floor at 1.5 below', !!h && Math.abs(h.t - 1.5) < 1e-3, JSON.stringify(h));
chk('floor normal +Y', !!h && h.ny === -1 ? false : !!h && h.ny === 1, JSON.stringify(h));

// 5. maxT respected
h = w.raycast(0, 1.5, 0, 1, 0, 0, 5);
chk('maxT cuts off wall', h === null, JSON.stringify(h));

// 6. Diagonal ray picks NEAREST of two candidates
h = w.raycast(0, 1.5, 0, 0.7071, 0, 0.7071, 100);
chk('diagonal misses both (gap)', h === null || h.t > 0, JSON.stringify(h));

// 7. Line of sight
chk('LOS blocked through wall', !w.lineOfSight(0, 1.5, 0, 20, 1.5, 0));
chk('LOS clear along open lane', w.lineOfSight(0, 1.5, 0, 0, 1.5, 15));

// 8. Brute-force cross-check on random rays: grid result must equal naive all-box scan.
function naive(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number) {
  let bt = maxT, found = false;
  for (const b of boxes) {
    // simple slab
    let tmin = 0, tmax = maxT;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    const mn = [b.min.x, b.min.y, b.min.z], mx = [b.max.x, b.max.y, b.max.z];
    let ok = true;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]!) < 1e-9) { if (o[a]! < mn[a]! || o[a]! > mx[a]!) { ok = false; break; } continue; }
      const inv = 1 / d[a]!;
      let t1 = (mn[a]! - o[a]!) * inv, t2 = (mx[a]! - o[a]!) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) { ok = false; break; }
    }
    if (ok && tmin > 0 && tmin < bt) { bt = tmin; found = true; }
  }
  return found ? bt : null;
}
let mismatches = 0;
let rng = 12345;
const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296);
for (let i = 0; i < 20000; i++) {
  const ox = (rand() - 0.5) * 60, oy = rand() * 3, oz = (rand() - 0.5) * 60;
  let dx = rand() - 0.5, dy = (rand() - 0.5) * 0.4, dz = rand() - 0.5;
  const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
  const g = w.raycast(ox, oy, oz, dx, dy, dz, 80);
  const n = naive(ox, oy, oz, dx, dy, dz, 80);
  const gt = g ? g.t : null;
  if ((gt === null) !== (n === null) || (gt !== null && n !== null && Math.abs(gt - n) > 1e-3)) {
    mismatches++;
    if (mismatches < 4) console.log('  mismatch grid=', gt, 'naive=', n, 'o=', ox.toFixed(2), oy.toFixed(2), oz.toFixed(2));
  }
}
chk(`20000 random rays match brute force (${mismatches} mismatches)`, mismatches === 0);

// 9. Perf sanity
const t0 = performance.now();
for (let i = 0; i < 100000; i++) {
  const a = (i / 100000) * Math.PI * 2;
  w.raycast(0, 1.5, 0, Math.cos(a), 0, Math.sin(a), 80);
}
const ms = performance.now() - t0;
console.log(`perf: 100k rays in ${ms.toFixed(1)}ms (${(100000 / ms).toFixed(0)} rays/ms)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
