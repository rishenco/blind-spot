// BLIND SPOT — "Substation 7". One hand-authored compact map.
//
// Authored on a 1m occupancy grid, then compiled to merged AABBs so the raycaster
// stays cheap. Design intent, zone by zone:
//   CONCOURSE  large pillared hall (north-west) — long sightlines, dramatic scans, mezzanine
//   LATTICE    tight offset-doorway cells (north-east) — scans die fast, ambush country
//   SPINE      the central artery — fastest route, most exposed
//   BAFFLES    acoustic-dead panels (south-west) — your reconstruction grows holes here
//   VAULT      glass-walled objective chamber (south-east) — scan through it, walk around it
// Loops everywhere: no zone is a dead end, every fight has at least two exits.

import { Mat, World, type Box } from './world.ts';

export const CELL = 1.0;
export const GW = 57; // grid width  (metres)
export const GH = 53; // grid depth  (metres)
export const WALL_H = 4.2;
export const MEZZ_H = 2.6;

const SOLID = 0, OPEN = 1;

class Grid {
  cells = new Uint8Array(GW * GH);
  mats = new Uint8Array(GW * GH);
  constructor() { this.cells.fill(SOLID); this.mats.fill(Mat.Concrete); }
  idx(x: number, z: number) { return z * GW + x; }
  inb(x: number, z: number) { return x >= 0 && z >= 0 && x < GW && z < GH; }
  get(x: number, z: number) { return this.inb(x, z) ? this.cells[this.idx(x, z)]! : SOLID; }
  carve(x0: number, z0: number, x1: number, z1: number) {
    for (let z = Math.max(0, z0); z <= Math.min(GH - 1, z1); z++)
      for (let x = Math.max(0, x0); x <= Math.min(GW - 1, x1); x++) this.cells[this.idx(x, z)] = OPEN;
  }
  fill(x0: number, z0: number, x1: number, z1: number, m: Mat = Mat.Concrete) {
    for (let z = Math.max(0, z0); z <= Math.min(GH - 1, z1); z++)
      for (let x = Math.max(0, x0); x <= Math.min(GW - 1, x1); x++) {
        this.cells[this.idx(x, z)] = SOLID; this.mats[this.idx(x, z)] = m;
      }
  }
}

export interface MapDef {
  world: World;
  boxes: Box[];
  spawns: { x: number; y: number; z: number; yaw: number }[];
  /** Candidate objective sites; the server picks per match. */
  siteNames: string[];
  sites: { x: number; y: number; z: number; name: string }[];
  grid: Grid;
  extent: { w: number; h: number };
}

function buildGrid(): Grid {
  const g = new Grid();

  // ───────── CONCOURSE: 24 x 20 pillared hall ─────────
  g.carve(2, 2, 25, 21);
  // Pillars on a 6m lattice — the landmark that makes this room readable from any scan.
  for (const px of [7, 13, 19]) for (const pz of [7, 13, 19]) g.fill(px, pz, px + 1, pz + 1, Mat.Metal);
  // Crate cover clusters (emitted separately as half-height boxes)

  // ───────── LATTICE: offset-doorway cell grid ─────────
  // 5 column bands x 4 row bands = 20 small cells. Connectivity is constructed, not hoped for:
  // every vertical partition is gapped once per row band (so a band is internally connected),
  // and every horizontal partition is gapped twice (so the bands chain together, with loops).
  g.carve(32, 2, 55, 21);
  const colStart = [32, 37, 42, 47, 52];
  const rowStart = [2, 7, 12, 17];
  for (let i = 0; i < 4; i++) {
    const x = 36 + i * 5;
    g.fill(x, 2, x, 21);
    for (let b = 0; b < 4; b++) {
      const gz = rowStart[b]! + ((i + b) % 2) * 2;
      g.carve(x, gz, x, gz + 1);
    }
  }
  for (let j = 0; j < 3; j++) {
    const z = 6 + j * 5;
    g.fill(32, z, 55, z);
    for (const k of [j % 5, (j + 2) % 5]) {
      const gx = colStart[k]! + 1;
      g.carve(gx, z, gx + 1, z);
    }
  }

  // ───────── SPINE: central E-W artery ─────────
  g.carve(2, 25, 55, 28);

  // Concourse -> Spine (three mouths, so the hall can always be left under cover)
  g.carve(5, 21, 7, 25);
  g.carve(14, 21, 16, 25);
  g.carve(23, 21, 24, 25);
  // Lattice -> Spine
  g.carve(34, 21, 35, 25);
  g.carve(44, 21, 45, 25);
  g.carve(53, 21, 54, 25);
  // Concourse <-> Lattice at the top (the north shortcut)
  g.carve(26, 4, 31, 6);
  g.carve(26, 16, 31, 18);

  // ───────── BAFFLES: south-west acoustic-dead zone ─────────
  g.carve(2, 31, 25, 51);
  // Cloth panels: solid, but they return almost nothing — they read as openings.
  g.fill(6, 34, 6, 41, Mat.Cloth);
  g.fill(11, 37, 18, 37, Mat.Cloth);
  g.fill(14, 42, 14, 49, Mat.Cloth);
  g.fill(19, 33, 19, 39, Mat.Cloth);
  g.fill(8, 45, 15, 45, Mat.Cloth);
  g.fill(21, 43, 21, 50, Mat.Cloth);
  // A couple of real concrete stubs mixed in, so "gap == wall" is never a safe assumption.
  g.fill(10, 32, 10, 35, Mat.Concrete);
  g.fill(17, 47, 22, 47, Mat.Concrete);

  // ───────── VAULT: south-east, glass inner chamber inside a service loop ─────────
  g.carve(31, 31, 55, 51);
  // Inner chamber walls: glass on three sides, metal on the fourth.
  g.fill(38, 37, 48, 37, Mat.Glass);
  g.fill(38, 38, 38, 45, Mat.Glass);
  g.fill(48, 38, 48, 45, Mat.Glass);
  g.fill(38, 46, 48, 46, Mat.Metal);
  // Two entrances into the chamber, on opposite sides.
  g.carve(42, 37, 44, 37);
  g.carve(48, 41, 48, 42);
  // Service obstacles in the surrounding loop
  g.fill(33, 33, 35, 34, Mat.Metal);
  g.fill(51, 48, 53, 49, Mat.Metal);
  g.fill(44, 49, 45, 51, Mat.Grate);

  // Spine -> south zones
  g.carve(6, 28, 8, 31);
  g.carve(19, 28, 21, 31);
  g.carve(35, 28, 37, 31);
  g.carve(50, 28, 52, 31);
  // Baffles <-> Vault (south belt) — closes the big outer loop
  g.carve(25, 46, 31, 49);
  // West rim corridor: Concourse north-west down to the Baffles, bypassing the Spine
  g.carve(2, 21, 3, 31);
  // East rim corridor: Lattice down to the Vault, bypassing the Spine
  g.carve(54, 21, 55, 31);

  return g;
}

/** Greedily merge runs of solid cells into as few AABBs as possible. */
function compile(g: Grid, y0: number, y1: number): Box[] {
  const out: Box[] = [];
  const used = new Uint8Array(GW * GH);
  for (let z = 0; z < GH; z++) {
    for (let x = 0; x < GW; x++) {
      const i = g.idx(x, z);
      if (g.cells[i] !== SOLID || used[i]) continue;
      const m = g.mats[i]!;
      // extend in X
      let x1 = x;
      while (x1 + 1 < GW && g.cells[g.idx(x1 + 1, z)] === SOLID && !used[g.idx(x1 + 1, z)] && g.mats[g.idx(x1 + 1, z)] === m) x1++;
      // extend in Z while the whole row matches
      let z1 = z;
      outer: while (z1 + 1 < GH) {
        for (let xx = x; xx <= x1; xx++) {
          const j = g.idx(xx, z1 + 1);
          if (g.cells[j] !== SOLID || used[j] || g.mats[j] !== m) break outer;
        }
        z1++;
      }
      for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) used[g.idx(xx, zz)] = 1;
      out.push({ min: { x, y: y0, z }, max: { x: x1 + 1, y: y1, z: z1 + 1 }, mat: m as Mat });
    }
  }
  return out;
}

export function buildMap(): MapDef {
  const g = buildGrid();
  const boxes: Box[] = [];

  // Floor & ceiling slabs
  boxes.push({ min: { x: -1, y: -1, z: -1 }, max: { x: GW + 1, y: 0, z: GH + 1 }, mat: Mat.Concrete });
  boxes.push({ min: { x: -1, y: WALL_H, z: -1 }, max: { x: GW + 1, y: WALL_H + 1, z: GH + 1 }, mat: Mat.Concrete });

  // Walls
  boxes.push(...compile(g, 0, WALL_H));

  // Half-height crate cover in the Concourse and Spine — shoot over, don't walk through.
  const crates: [number, number, number, number][] = [
    [4, 4, 6, 6], [21, 17, 24, 19], [4, 17, 6, 19], [21, 4, 24, 6],
    [12, 9, 15, 11], [9, 26, 12, 27], [28, 25, 31, 27], [40, 26, 43, 27],
    [33, 41, 35, 43], [50, 34, 52, 36], [8, 48, 11, 50], [23, 33, 25, 35],
  ];
  for (const [x0, z0, x1, z1] of crates) boxes.push({ min: { x: x0, y: 0, z: z0 }, max: { x: x1, y: 1.05, z: z1 }, mat: Mat.Metal });

  // Mezzanine: a catwalk over the Concourse's north edge, reached by a ramp.
  boxes.push({ min: { x: 3, y: MEZZ_H, z: 2 }, max: { x: 25, y: MEZZ_H + 0.3, z: 6 }, mat: Mat.Grate });
  boxes.push({ min: { x: 3, y: MEZZ_H + 1.1, z: 2 }, max: { x: 3.3, y: MEZZ_H + 1.3, z: 6 }, mat: Mat.Metal }); // rail hint
  // Ramp as a short stack of steps (STEP_HEIGHT handles the climb).
  for (let s = 0; s < 8; s++) {
    const y = (MEZZ_H / 8) * (s + 1);
    boxes.push({ min: { x: 22 - s * 1.2, y: 0, z: 6 }, max: { x: 23.2 - s * 1.2, y, z: 9 }, mat: Mat.Grate });
  }

  const spawns = [
    { x: 10.5, y: 0, z: 4.5, yaw: Math.PI },        // Concourse, north edge
    { x: 46.5, y: 0, z: 49.5, yaw: 0 },             // Vault, south service loop
  ];

  const sites = [
    { x: 43.0, y: 0, z: 42.0, name: 'VAULT' },
    { x: 16.5, y: 0, z: 10.5, name: 'CONCOURSE' },
    { x: 43.5, y: 0, z: 13.5, name: 'LATTICE' },
    { x: 12.0, y: 0, z: 43.0, name: 'BAFFLES' },
    { x: 29.0, y: 0, z: 26.5, name: 'SPINE' },
  ];

  return {
    world: new World(boxes),
    boxes,
    spawns,
    sites,
    siteNames: sites.map((s) => s.name),
    grid: g,
    extent: { w: GW, h: GH },
  };
}
