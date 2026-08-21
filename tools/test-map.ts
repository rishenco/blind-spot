import { buildMap, GW, GH } from '../src/shared/map.ts';
import { Mat } from '../src/shared/world.ts';

const m = buildMap();
const g = m.grid;
let fail = 0;

console.log(`boxes: ${m.boxes.length}`);

// Flood fill from spawn 0
const seen = new Uint8Array(GW * GH);
const start = [Math.floor(m.spawns[0]!.x), Math.floor(m.spawns[0]!.z)] as const;
if (g.get(start[0], start[1]) !== 1) { console.log('FAIL spawn0 is inside a wall'); fail++; }
const q = [start[1] * GW + start[0]];
seen[q[0]!] = 1;
let openTotal = 0;
for (let i = 0; i < g.cells.length; i++) if (g.cells[i] === 1) openTotal++;
while (q.length) {
  const c = q.pop()!;
  const x = c % GW, z = (c / GW) | 0;
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
    const nx = x + dx, nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= GW || nz >= GH) continue;
    const ni = nz * GW + nx;
    if (seen[ni] || g.cells[ni] !== 1) continue;
    seen[ni] = 1; q.push(ni);
  }
}
let reached = 0;
for (let i = 0; i < seen.length; i++) if (seen[i]) reached++;
console.log(`open cells: ${openTotal}, reachable from spawn A: ${reached}`);
if (reached !== openTotal) { console.log(`FAIL: ${openTotal - reached} open cells are isolated`); fail++; }

// Spawns and sites must be in open, reachable space
for (const [i, s] of m.spawns.entries()) {
  const ok = seen[Math.floor(s.z) * GW + Math.floor(s.x)];
  if (!ok) { console.log(`FAIL spawn ${i} unreachable at ${s.x},${s.z}`); fail++; }
}
for (const s of m.sites) {
  const ok = seen[Math.floor(s.z) * GW + Math.floor(s.x)];
  if (!ok) { console.log(`FAIL site ${s.name} unreachable/solid at ${s.x},${s.z}`); fail++; }
}

// Nothing a player must stand on may be inside solid geometry.
const R = 0.34, H = 1.7;
const insideAnyBox = (x: number, z: number) => m.boxes.some((b) =>
  x + R > b.min.x && x - R < b.max.x && z + R > b.min.z && z - R < b.max.z &&
  b.min.y < H && b.max.y > 0.05);
for (const [i, s] of m.spawns.entries())
  if (insideAnyBox(s.x, s.z)) { console.log(`FAIL spawn ${i} is inside geometry`); fail++; }
for (const s of m.sites)
  if (insideAnyBox(s.x, s.z)) { console.log(`FAIL relic site ${s.name} is inside geometry`); fail++; }
if (insideAnyBox(m.extraction.x, m.extraction.z)) { console.log('FAIL extraction point is inside geometry'); fail++; }
// The extraction RING must be standable, not just its centre.
for (let a = 0; a < 8; a++) {
  const rx = m.extraction.x + Math.cos((a / 8) * 6.283) * 1.6;
  const rz = m.extraction.z + Math.sin((a / 8) * 6.283) * 1.6;
  if (insideAnyBox(rx, rz)) { console.log(`FAIL extraction ring blocked at ${a * 45} deg`); fail++; }
}
console.log('standability checks done');

// Raycast perf on the REAL map
const w = m.world;
const t0 = performance.now();
let hits = 0;
for (let i = 0; i < 100000; i++) {
  const a = (i / 1000) * 2.399963;
  const p = Math.sin(i * 0.01) * 0.5;
  const cp = Math.cos(p);
  if (w.raycast(13, 1.6, 13, Math.cos(a) * cp, Math.sin(p), Math.sin(a) * cp, 45)) hits++;
}
const ms = performance.now() - t0;
console.log(`raycast on real map: 100k rays in ${ms.toFixed(0)}ms => ${(100000/ms).toFixed(0)} rays/ms, hitrate ${(hits/1000).toFixed(0)}%`);
if (100000 / ms < 150) { console.log('FAIL: raycast too slow for interactive scanning'); fail++; }

// Material census
const census = new Map<number, number>();
for (const b of m.boxes) census.set(b.mat, (census.get(b.mat) ?? 0) + 1);
const MatName = ['Concrete','Metal','Glass','Cloth','Grate','Objective'];
console.log('materials:', [...census].map(([k, v]) => `${MatName[k] ?? k}=${v}`).join(' '));

// ASCII preview
const CH = ['#', '.', ' '];
let art = '';
for (let z = 0; z < GH; z++) {
  let row = '';
  for (let x = 0; x < GW; x++) {
    const open = g.cells[z * GW + x] === 1;
    if (open) { row += seen[z * GW + x] ? '.' : '!'; continue; }
    const mm = g.mats[z * GW + x];
    row += mm === Mat.Cloth ? 'c' : mm === Mat.Glass ? 'g' : mm === Mat.Metal ? 'M' : mm === Mat.Grate ? 'r' : '#';
  }
  art += row + '\n';
}
// overlay spawns/sites
const lines = art.split('\n');
const put = (x: number, z: number, ch: string) => {
  const r = lines[Math.floor(z)]; if (!r) return;
  lines[Math.floor(z)] = r.slice(0, Math.floor(x)) + ch + r.slice(Math.floor(x) + 1);
};
m.spawns.forEach((s, i) => put(s.x, s.z, i === 0 ? 'A' : 'B'));
m.sites.forEach((s) => put(s.x, s.z, '*'));
console.log('\n' + lines.join('\n'));
console.log(fail ? `\n${fail} FAILURES` : '\nMAP OK');
process.exit(fail ? 1 : 0);
