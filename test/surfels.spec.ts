/**
 * The surfel bake (engine-plan §3) — where a dot may exist at all.
 *
 * Paint decides what is lit; this file decides what is even there to light, and the three laws it
 * has to keep are all structural rather than numeric:
 *
 *   visual-brief §2  the lattice is WORLD-AXIS and absolute — the same world position is the same
 *                    dot with the same dither, across faces, across solids, across runs. A solid
 *                    parked at x = 2.13 does not get its own private grid.
 *   vision §1.3      absence is black — a face buried inside another solid is a surface no sound
 *                    can ever reach, so it must not exist. Culled at bake time, never at draw time.
 *   vision §5        dots are matter, lines are holds — a bright micro-line promises a traversal,
 *                    so the hold classifier has to agree with what the movement code will actually
 *                    do. The duct lip and the pit lip are the two the map is built around.
 *
 * Most cases run on a small fixture whose numbers are readable by eye; the cases that are really
 * claims about the authored map ("the duct lip is a hold") run on "Dock Approach" itself.
 */

import { describe, expect, it } from 'vitest';
import {
  EDGE_SEG_MAX,
  FACE_PROBE,
  HEIGHT_STAND,
  HOLD_MAX_STEP,
  HOLD_MIN_CLEARANCE,
  HOLD_MIN_STEP,
  PATCH_SIZE,
  SURFEL_SPACING,
} from '../src/core/const.js';
import { latticeCentre } from '../src/core/math.js';
import { buildWorld, insideAir, pointInSolid, queryXZ } from '../src/core/map/build.js';
import { sampleMap } from '../src/core/map/sampleMap.js';
import type { MapDef, Solid, SolidKind } from '../src/core/map/types.js';
import { bakeSurfels, surfelDither, UNPAINTED, type SurfelField } from '../src/core/surfels.js';

// ------------------------------------------------------------------------------------------
// Fixture (12 x 12 m of floor, ceilingless, air 0..4 high):
//   slab        x 2.13..4.13   deliberately OFF the lattice — the world-axis law's witness
//   flushA/B    meet at x = 9  two faces buried in each other: the buried-face cull
//   coplanarA/B share the +x plane at x = 10, meeting exactly ON a lattice centre: the
//               same-position-same-dot dedupe
//   shelf       top at 1.4     a hold (0.7 <= drop <= 2.6)
//   overhang    bottom at 1.2  a duct-like overhead lip: a hold you go UNDER
//   pedestal    top at 0.4     too shallow to be a hold (drop < HOLD_MIN_STEP)
// ------------------------------------------------------------------------------------------

const box = (id: string, kind: SolidKind, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Solid => ({
  type: 'box',
  id,
  kind,
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});

/** Where coplanarA ends and coplanarB begins: exactly a lattice centre, so both faces want it. */
const SHARED_Z = latticeCentre(31, SURFEL_SPACING);

const fixtureMap: MapDef = {
  name: 'bake fixture',
  solids: [
    box('ground', 'floor', 0, -0.4, 0, 12, 0, 12),
    box('slab', 'crate', 2.13, 0, 3.07, 4.13, 1.0, 5.07),
    box('flushA', 'wall', 8, 0, 2, 9, 3, 4),
    box('flushB', 'wall', 9, 0, 2, 10, 3, 4),
    box('coplanarA', 'wall', 8, 0, 6, 10, 2, SHARED_Z),
    box('coplanarB', 'wall', 8, 0, SHARED_Z, 10, 2, 8),
    box('shelf', 'crate', 5, 0, 8, 7, 1.4, 10),
    box('overhang', 'machine', 1, 1.2, 8, 3, 3, 10),
    box('pedestal', 'pedestal', 0.5, 0, 0.5, 1.5, 0.4, 1.5),
  ],
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [6, 0, 6], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [12, 4, 12] }],
  markers: [],
  bounds: { min: [0, -0.4, 0], max: [12, 4, 12] },
};

const fx = buildWorld(fixtureMap);
const fxField = bakeSurfels(fx);

const world = buildWorld(sampleMap);
const field = bakeSurfels(world);

// ------------------------------------------------------------------------------------------
// Readers
// ------------------------------------------------------------------------------------------

interface Dot {
  readonly i: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

const dot = (f: SurfelField, i: number): Dot => ({
  i,
  x: f.positions[i * 3]!,
  y: f.positions[i * 3 + 1]!,
  z: f.positions[i * 3 + 2]!,
  nx: f.normals[i * 3]!,
  ny: f.normals[i * 3 + 1]!,
  nz: f.normals[i * 3 + 2]!,
});

const dots = (f: SurfelField, keep: (d: Dot) => boolean): Dot[] => {
  const out: Dot[] = [];
  for (let i = 0; i < f.count; i++) {
    const d = dot(f, i);
    if (keep(d)) out.push(d);
  }
  return out;
};

interface Seg {
  readonly s: number;
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
  readonly hold: boolean;
  readonly vertical: boolean;
}

const seg = (f: SurfelField, s: number): Seg => {
  const y0 = f.edgePositions[s * 6 + 1]!;
  const y1 = f.edgePositions[s * 6 + 4]!;
  return {
    s,
    x0: f.edgePositions[s * 6]!,
    y0,
    z0: f.edgePositions[s * 6 + 2]!,
    x1: f.edgePositions[s * 6 + 3]!,
    y1,
    z1: f.edgePositions[s * 6 + 5]!,
    hold: f.edgeHold[s * 2] === 1,
    vertical: Math.abs(y1 - y0) > 1e-9,
  };
};

const segs = (f: SurfelField, keep: (s: Seg) => boolean): Seg[] => {
  const out: Seg[] = [];
  for (let s = 0; s < f.edgeCount; s++) {
    const e = seg(f, s);
    if (keep(e)) out.push(e);
  }
  return out;
};

/**
 * Positions come back through a Float32Array, so an exact lattice centre arrives with ~1e-7
 * relative error. The tolerance is in LATTICE UNITS and is four orders of magnitude tighter than
 * the half-cell that would let a dot pass as a neighbour's.
 */
const LATTICE_EPS = 1e-3;
const onLattice = (v: number): boolean => {
  const k = v / SURFEL_SPACING - 0.5;
  return Math.abs(k - Math.round(k)) < LATTICE_EPS;
};

const near = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------------------------------

describe('the lattice is world-axis and absolute (visual-brief §2)', () => {
  it('puts every dot on lattice centres in the two axes its face spans', () => {
    // A box face fixes one coordinate to its plane and walks the other two along the lattice; a
    // cylinder fixes one to the circle. Either way, two of the three are always lattice centres —
    // if a solid ever got its own local grid, this is what would break first.
    let bad: Dot | null = null;
    for (let i = 0; i < field.count && !bad; i++) {
      const d = dot(field, i);
      const n = (onLattice(d.x) ? 1 : 0) + (onLattice(d.y) ? 1 : 0) + (onLattice(d.z) ? 1 : 0);
      if (n < 2) bad = d;
    }
    expect(bad, bad ? `dot ${bad.i} at ${bad.x},${bad.y},${bad.z}` : '').toBeNull();
  });

  it('does not let an off-lattice solid drag the lattice with it', () => {
    // `slab` sits at x 2.13..4.13, z 3.07..5.07 — none of those are multiples of anything. Its
    // TOP face still samples the same y-and-z grid every other surface in the world uses.
    const top = dots(fxField, (d) => d.ny === 1 && near(d.y, 1.0) && d.x > 2.13 && d.x < 4.13);
    expect(top.length).toBeGreaterThan(50);
    for (const d of top) {
      expect(onLattice(d.x), `x ${d.x}`).toBe(true);
      expect(onLattice(d.z), `z ${d.z}`).toBe(true);
      expect(d.y).toBeCloseTo(1.0, 5);
    }
    // …and the face plane itself is the authored number, never snapped to the grid.
    const side = dots(fxField, (d) => d.nx === -1 && d.x < 5 && d.y > 0.1 && d.y < 0.9 && d.z > 3.2 && d.z < 4.9);
    expect(side.length).toBeGreaterThan(5);
    for (const d of side) expect(d.x).toBeCloseTo(2.13, 5);
  });

  it('derives dither from the world position alone', () => {
    for (let i = 0; i < field.count; i += 11) {
      const d = dot(field, i);
      expect(field.dither[i]).toBeCloseTo(surfelDither(d.x, d.y, d.z), 6);
    }
    for (let i = 0; i < field.count; i += 97) {
      expect(field.dither[i]).toBeGreaterThanOrEqual(0);
      expect(field.dither[i]).toBeLessThan(1);
    }
  });

  it('gives the same world position exactly one dot — even where two faces want it', () => {
    // coplanarA and coplanarB share the +x plane at x = 10 and meet exactly ON a lattice centre,
    // so both faces produce a sample at (10, y, SHARED_Z). Two dots there would double every
    // sound's contribution at one spot forever.
    const shared = dots(fxField, (d) => d.nx === 1 && near(d.x, 10) && near(d.z, SHARED_Z, 1e-3));
    expect(shared.length).toBeGreaterThan(0);
    const byY = new Set(shared.map((d) => d.y.toFixed(4)));
    expect(byY.size).toBe(shared.length);
  });

  it('never emits the same position twice anywhere in the authored map', () => {
    const seen = new Set<string>();
    for (let i = 0; i < field.count; i++) {
      seen.add(
        `${Math.round(field.positions[i * 3]! * 1e4)},${Math.round(field.positions[i * 3 + 1]! * 1e4)},${Math.round(
          field.positions[i * 3 + 2]! * 1e4,
        )}`,
      );
    }
    expect(seen.size).toBe(field.count);
  });

  it('is reproducible: two bakes of the same world are byte-identical', () => {
    const again = bakeSurfels(buildWorld(fixtureMap));
    expect(again.count).toBe(fxField.count);
    expect(again.edgeCount).toBe(fxField.edgeCount);
    expect(again.patchCount).toBe(fxField.patchCount);
    expect(Array.from(again.positions)).toEqual(Array.from(fxField.positions));
    expect(Array.from(again.normals)).toEqual(Array.from(fxField.normals));
    expect(Array.from(again.dither)).toEqual(Array.from(fxField.dither));
    expect(Array.from(again.edgePositions)).toEqual(Array.from(fxField.edgePositions));
    expect(Array.from(again.edgeHold)).toEqual(Array.from(fxField.edgeHold));
  });

  it('reads the world it is handed, not the imported map module', () => {
    // engine-plan §11.1: the bake takes `sim.world`. Proving it by construction — a world the
    // sample map never saw bakes a completely different field.
    expect(fxField.count).not.toBe(field.count);
    expect(fxField.count).toBeGreaterThan(0);
    // Nothing from "Dock Approach" leaked in: the fixture has no geometry past x = 12.
    expect(dots(fxField, (d) => d.x > 12.5)).toHaveLength(0);
  });
});

describe('absence is black: buried faces do not exist (vision §1.3)', () => {
  it('culls the plane where two solids meet flush', () => {
    // flushA (…8..9) and flushB (9..10) touch at x = 9. Neither face is reachable by any sound.
    expect(dots(fxField, (d) => near(d.x, 9) && d.y > 0 && d.y < 3 && d.z > 2 && d.z < 4)).toHaveLength(0);
    // The pair's OUTER faces are still there, so the cull is a cull and not a deletion.
    expect(dots(fxField, (d) => near(d.x, 8) && d.nx === -1).length).toBeGreaterThan(50);
    expect(dots(fxField, (d) => near(d.x, 10) && d.nx === 1 && d.z > 2 && d.z < 4).length).toBeGreaterThan(50);
  });

  it('culls everything outside the authored air', () => {
    // The floor's underside and its outer rim are not buried in anything — only the air volume
    // makes them "outside the world". Without that rule the bake doubles for free.
    expect(dots(fxField, (d) => d.ny === -1 && d.y < 0)).toHaveLength(0);
    expect(dots(fxField, (d) => d.x < 0 || d.x > 12 || d.z < 0 || d.z > 12 || d.y > 4)).toHaveLength(0);
  });

  it('leaves no dot inside a solid, and every dot with open air in front of it', () => {
    const cand: number[] = [];
    let buried = 0;
    let blind = 0;
    for (let i = 0; i < field.count; i += 29) {
      const d = dot(field, i);
      const px = d.x + d.nx * FACE_PROBE;
      const py = d.y + d.ny * FACE_PROBE;
      const pz = d.z + d.nz * FACE_PROBE;
      if (!insideAir(world, px, py, pz)) blind++;
      else {
        queryXZ(world, px, pz, px, pz, cand);
        if (cand.some((k) => pointInSolid(world.solids[k]!, px, py, pz))) blind++;
      }
      queryXZ(world, d.x, d.z, d.x, d.z, cand);
      for (const k of cand) {
        const s = world.solids[k]!;
        if (s.shape !== 'box') continue;
        const inside =
          d.x > s.minX + 1e-3 &&
          d.x < s.maxX - 1e-3 &&
          d.y > s.minY + 1e-3 &&
          d.y < s.maxY - 1e-3 &&
          d.z > s.minZ + 1e-3 &&
          d.z < s.maxZ - 1e-3;
        if (inside) buried++;
      }
    }
    expect(buried).toBe(0);
    expect(blind).toBe(0);
  });

  it('gives every dot a unit axis-or-radial normal', () => {
    for (let i = 0; i < field.count; i += 17) {
      const d = dot(field, i);
      expect(Math.hypot(d.nx, d.ny, d.nz)).toBeCloseTo(1, 5);
    }
  });
});

describe('dots are matter, lines are holds (vision §5)', () => {
  it('MUST flag the slide duct lip as a hold', () => {
    // sample-map: `duct` is solid from y 1.2 to the ceiling across corridor C. You get under it by
    // sliding, so its underside lip is exactly the affordance a bright micro-line is for.
    const lip = segs(
      field,
      (e) => near(e.y0, 1.2) && (near(e.x0, 23.6) || near(e.x0, 24.4)) && e.z0 > -0.5 && e.z0 < 2.1 && !e.vertical,
    );
    expect(lip.length).toBeGreaterThan(0);
    for (const e of lip) expect(e.hold, `duct lip at z ${e.z0}`).toBe(true);
  });

  it('MUST flag the corridor pit lip as a hold', () => {
    // The pit drops 2.8 m to the trench — past HOLD_MAX_STEP, but its lip is the top of a surface
    // a body stands on, which is the clause that keeps engine-plan §3's "shelf/catwalk/beam lips"
    // honest. Get this wrong and the one edge you must not run off stops being drawn as an edge.
    const lip = segs(
      field,
      (e) => near(e.y0, 0) && (near(e.x0, 31) || near(e.x0, 35)) && e.z0 > -0.5 && e.z0 < 2.1 && !e.vertical,
    );
    expect(lip.length).toBeGreaterThan(0);
    for (const e of lip) expect(e.hold, `pit lip at x ${e.x0} z ${e.z0}`).toBe(true);
  });

  it('flags the mezzanine, the gantry beam, the high shelf and the tank rim', () => {
    const holdsAt = (y: number): number => segs(field, (e) => e.hold && !e.vertical && near(e.y0, y)).length;
    expect(holdsAt(3.5), 'catwalk y3.5').toBeGreaterThan(0);
    expect(holdsAt(4.2), 'gantry beam y4.2').toBeGreaterThan(0);
    expect(holdsAt(3.3), 'high shelf y3.3').toBeGreaterThan(0);
    expect(holdsAt(6.5), 'tank rim y6.5').toBeGreaterThan(0);
    expect(holdsAt(2.2), 'machinery row y2.2').toBeGreaterThan(0);
  });

  it('refuses the ceiling and the door lintels', () => {
    // A 2.4 m lintel is a doorway, not an affordance; the ceiling underside at 7 m is nothing at
    // all. Drawing either as a hold would promise a traversal the movement code refuses —
    // vision §1.2, the system never lies.
    expect(segs(field, (e) => e.hold && near(e.y0, 2.4))).toHaveLength(0);
    expect(segs(field, (e) => e.hold && near(e.y0, 7))).toHaveLength(0);
    // Height alone is not the test — the crate stack's 2.0 top is above standing height and is a
    // perfectly good mantle — but nothing in this map is an affordance above the tank rim at 6.5,
    // and a classifier that started decorating the roof line would show up here first.
    const high = segs(field, (e) => e.hold && Math.max(e.y0, e.y1) > 6.5 + 1e-6);
    expect(high.map((e) => `${e.x0},${e.y0},${e.z0}`)).toHaveLength(0);
    // The stack top IS a hold, and it is above HEIGHT_STAND: the law is the drop, not the height.
    expect(segs(field, (e) => e.hold && near(e.y0, 2.0) && e.y0 > HEIGHT_STAND).length).toBeGreaterThan(0);
  });

  it('treats a shallow step as scenery and a reachable lip as a hold', () => {
    // pedestal top 0.4 (drop < HOLD_MIN_STEP) vs shelf top 1.4 (inside [HOLD_MIN_STEP, HOLD_MAX_STEP]).
    expect(HOLD_MIN_STEP).toBeGreaterThan(0.4);
    expect(HOLD_MAX_STEP).toBeGreaterThan(1.4);
    const pedestal = segs(fxField, (e) => near(e.y0, 0.4) && !e.vertical);
    expect(pedestal.length).toBeGreaterThan(0);
    for (const e of pedestal) expect(e.hold, 'pedestal lip').toBe(false);

    const shelf = segs(fxField, (e) => near(e.y0, 1.4) && !e.vertical);
    expect(shelf.length).toBeGreaterThan(0);
    expect(shelf.some((e) => e.hold)).toBe(true);
  });

  it('treats an overhead lip you can duck under as a hold', () => {
    // `overhang` bottoms out at 1.2: at least HOLD_MIN_CLEARANCE of gap and below standing height,
    // so going under it is a decision.
    expect(1.2).toBeGreaterThanOrEqual(HOLD_MIN_CLEARANCE);
    expect(1.2).toBeLessThanOrEqual(HEIGHT_STAND);
    const under = segs(fxField, (e) => near(e.y0, 1.2) && !e.vertical);
    expect(under.length).toBeGreaterThan(0);
    expect(under.some((e) => e.hold)).toBe(true);
  });

  it('never makes a vertical crease a hold — only ladder rails climb', () => {
    // Nothing in the movement set grabs a vertical corner. Ladders are the exception by
    // construction (engine-plan §3 names rails + rungs), and they are not creases at all.
    const vertical = segs(field, (e) => e.vertical && e.hold);
    expect(vertical.length).toBeGreaterThan(0);
    for (const e of vertical) {
      const onLadder = world.ladders.some(
        (l) =>
          e.x0 >= Math.min(l.minX, l.def.x) - 0.5 &&
          e.x0 <= Math.max(l.maxX, l.def.x) + 0.5 &&
          e.z0 >= Math.min(l.minZ, l.def.z) - 0.5 &&
          e.z0 <= Math.max(l.maxZ, l.def.z) + 0.5,
      );
      expect(onLadder, `vertical hold at ${e.x0},${e.y0},${e.z0}`).toBe(true);
    }
    // The fixture has no ladders, so it must have no vertical holds at all.
    expect(segs(fxField, (e) => e.vertical && e.hold)).toHaveLength(0);
  });

  it('makes a ladder nothing but holds', () => {
    // Matched on the ladder's own climbing plane, not on a box around it: a fuzzy box also catches
    // the wall creases the ladder is bolted to, which are correctly NOT holds.
    for (const l of world.ladders) {
      const d = l.def;
      const half = d.width / 2;
      const across = l.outX !== 0 ? 'z' : 'x';
      const plane = l.outX !== 0 ? d.x : d.z;
      const centre = l.outX !== 0 ? d.z : d.x;
      const onPlane = (e: Seg): boolean =>
        near(across === 'z' ? e.x0 : e.z0, plane) &&
        near(across === 'z' ? e.x1 : e.z1, plane) &&
        Math.abs((across === 'z' ? e.z0 : e.x0) - centre) <= half + 1e-6 &&
        Math.abs((across === 'z' ? e.z1 : e.x1) - centre) <= half + 1e-6 &&
        Math.min(e.y0, e.y1) >= l.yBase - 1e-6 &&
        Math.max(e.y0, e.y1) <= l.yTop + 1e-6;
      const mine = segs(field, onPlane);
      expect(mine.length, d.id).toBeGreaterThan(4);
      for (const e of mine) expect(e.hold, `${d.id} segment at y ${e.y0}`).toBe(true);
      // Rails AND rungs: a ladder you can only see the sides of is not a ladder.
      expect(mine.some((e) => e.vertical), `${d.id} rails`).toBe(true);
      expect(mine.some((e) => !e.vertical), `${d.id} rungs`).toBe(true);
    }
  });

  it('subdivides creases and keeps both vertices of a segment in agreement', () => {
    for (let s = 0; s < field.edgeCount; s++) {
      const e = seg(field, s);
      const len = Math.hypot(e.x1 - e.x0, e.y1 - e.y0, e.z1 - e.z0);
      expect(len, `segment ${s}`).toBeGreaterThan(0);
      expect(len, `segment ${s}`).toBeLessThanOrEqual(EDGE_SEG_MAX + 1e-6);
      // `hold` is a property of the segment; a look reads it per vertex and must never see a
      // segment that is half-hold.
      expect(field.edgeHold[s * 2], `segment ${s}`).toBe(field.edgeHold[s * 2 + 1]);
    }
  });

  it('counts its own holds honestly', () => {
    let n = 0;
    for (let s = 0; s < field.edgeCount; s++) if (field.edgeHold[s * 2] === 1) n++;
    expect(field.counts.holds).toBe(n);
    expect(field.counts.edges).toBe(field.edgeCount);
    expect(field.counts.surfels).toBe(field.count);
    expect(field.counts.holds).toBeGreaterThan(0);
    expect(field.counts.holds).toBeLessThan(field.edgeCount);
  });
});

describe('patch table (engine-plan §3)', () => {
  const both = [fxField, field];

  it('partitions the buffers exactly once, in order', () => {
    for (const f of both) {
      let d = 0;
      let s = 0;
      for (let p = 0; p < f.patchCount; p++) {
        expect(f.patchDotStart[p]).toBe(d);
        expect(f.patchSegStart[p]).toBe(s);
        d += f.patchDotCount[p]!;
        s += f.patchSegCount[p]!;
      }
      expect(d).toBe(f.count);
      expect(s).toBe(f.edgeCount);
    }
  });

  it('gives every patch members from one PATCH_SIZE cell', () => {
    const cell = (v: number): number => Math.floor(v / PATCH_SIZE);
    for (let p = 0; p < field.patchCount; p++) {
      const d0 = field.patchDotStart[p]!;
      const n = field.patchDotCount[p]!;
      if (n === 0) continue;
      const cx = cell(field.positions[d0 * 3]!);
      const cy = cell(field.positions[d0 * 3 + 1]!);
      const cz = cell(field.positions[d0 * 3 + 2]!);
      for (let i = d0; i < d0 + n; i++) {
        expect(cell(field.positions[i * 3]!), `patch ${p} dot ${i} x`).toBe(cx);
        expect(cell(field.positions[i * 3 + 1]!), `patch ${p} dot ${i} y`).toBe(cy);
        expect(cell(field.positions[i * 3 + 2]!), `patch ${p} dot ${i} z`).toBe(cz);
      }
    }
  });

  it('orders patches floor-major, then coherently within the floor', () => {
    // Floor-major is what makes the ±1-floor render window a contiguous slice; Morton within the
    // floor is what makes a sound's footprint a handful of index runs instead of a scatter, which
    // is the entire justification for ranged uploads over re-sending the buffer.
    const cellY = (p: number): number => Math.floor(field.positions[field.patchDotStart[p]! * 3 + 1]! / PATCH_SIZE);
    let prev = -Infinity;
    const steps: number[] = [];
    for (let p = 0; p < field.patchCount; p++) {
      if (field.patchDotCount[p] === 0) continue;
      const y = cellY(p);
      expect(y, `patch ${p}`).toBeGreaterThanOrEqual(prev);
      prev = y;
      if (p > 0) {
        steps.push(
          Math.hypot(
            field.patchCentre[p * 3]! - field.patchCentre[(p - 1) * 3]!,
            field.patchCentre[p * 3 + 1]! - field.patchCentre[(p - 1) * 3 + 1]!,
            field.patchCentre[p * 3 + 2]! - field.patchCentre[(p - 1) * 3 + 2]!,
          ),
        );
      }
    }
    steps.sort((a, b) => a - b);
    // Morton takes the occasional long jump; the median is what the upload merger actually sees.
    expect(steps[steps.length >> 1]!).toBeLessThan(2 * PATCH_SIZE);
  });

  it('bounds every member inside the patch sphere', () => {
    for (let p = 0; p < field.patchCount; p++) {
      const cx = field.patchCentre[p * 3]!;
      const cy = field.patchCentre[p * 3 + 1]!;
      const cz = field.patchCentre[p * 3 + 2]!;
      const r = field.patchRadius[p]!;
      const d0 = field.patchDotStart[p]!;
      for (let i = d0; i < d0 + field.patchDotCount[p]!; i++) {
        const d = Math.hypot(field.positions[i * 3]! - cx, field.positions[i * 3 + 1]! - cy, field.positions[i * 3 + 2]! - cz);
        expect(d, `patch ${p} dot ${i}`).toBeLessThanOrEqual(r + 1e-4);
      }
      const s0 = field.patchSegStart[p]!;
      for (let s = s0; s < s0 + field.patchSegCount[p]!; s++) {
        for (const v of [0, 3]) {
          const d = Math.hypot(
            field.edgePositions[s * 6 + v]! - cx,
            field.edgePositions[s * 6 + v + 1]! - cy,
            field.edgePositions[s * 6 + v + 2]! - cz,
          );
          expect(d, `patch ${p} seg ${s}`).toBeLessThanOrEqual(r + 1e-4);
        }
      }
    }
  });

  it('records the smallest dither in the patch, which is what the prune trusts', () => {
    for (let p = 0; p < field.patchCount; p += 7) {
      let min = 1;
      const d0 = field.patchDotStart[p]!;
      for (let i = d0; i < d0 + field.patchDotCount[p]!; i++) if (field.dither[i]! < min) min = field.dither[i]!;
      const s0 = field.patchSegStart[p]!;
      for (let k = s0 * 2; k < (s0 + field.patchSegCount[p]!) * 2; k++) if (field.edgeDither[k]! < min) min = field.edgeDither[k]!;
      expect(field.patchMinDither[p], `patch ${p}`).toBeCloseTo(min, 6);
    }
  });

  it('starts every line-of-sight probe in open air, never inside the face it belongs to', () => {
    // A probe buried in its own wall counts that wall for every sound there will ever be, and the
    // map stays black no matter how loud you are. This is the regression that costs the milestone.
    //
    // "Buried" means strictly inside by a margin, not touching. A patch made only of creases (a
    // gantry beam's silhouette, a tank rim) has no dot to lift, so its probe falls back to a
    // segment midpoint, which lies exactly ON the surface the crease belongs to — a closed-set
    // point-in-solid test calls that inside. It is harmless: the occluder chord through a solid
    // you are merely touching is zero, and `countWalls` drops runs shorter than OCCLUDER_MIN_CHORD.
    // What must never happen is a probe a real distance inside matter.
    const cand: number[] = [];
    const M = 1e-3;
    const buriedIn = (x: number, y: number, z: number): string | undefined => {
      queryXZ(world, x, z, x, z, cand);
      for (const k of cand) {
        const s = world.solids[k]!;
        if (y <= s.minY + M || y >= s.maxY - M) continue;
        if (s.shape === 'cyl') {
          if (Math.hypot(x - s.cx, z - s.cz) < s.r - M) return s.id;
          continue;
        }
        if (x > s.minX + M && x < s.maxX - M && z > s.minZ + M && z < s.maxZ - M) return s.id;
      }
      return undefined;
    };
    let dotless = 0;
    for (let p = 0; p < field.patchCount; p++) {
      const x = field.patchProbe[p * 3]!;
      const y = field.patchProbe[p * 3 + 1]!;
      const z = field.patchProbe[p * 3 + 2]!;
      expect(buriedIn(x, y, z), `patch ${p} probe buried`).toBeUndefined();
      if (field.patchDotCount[p] === 0) {
        dotless++;
        continue;
      }
      // A patch that owns dots has a normal to lift along, so its probe is genuinely in free air.
      const inside = cand.find((k) => pointInSolid(world.solids[k]!, x, y, z));
      expect(inside === undefined, `patch ${p} probe inside ${inside !== undefined ? world.solids[inside]!.id : ''}`).toBe(
        true,
      );
      expect(insideAir(world, x, y, z), `patch ${p} probe outside authored air`).toBe(true);
    }
    // …and the fallback is the rare case, not the rule.
    expect(dotless).toBeLessThan(field.patchCount / 10);
  });

  it('answers a sphere query with exactly the patches that reach it', () => {
    const out: number[] = [];
    const probes: Array<[number, number, number, number]> = [
      [3, 1, 3, 4],
      [16, 2, 16, 9],
      [33, -1, 1, 6],
      [24, 1.5, 1, 3],
      [8.6, 3.5, 25, 12],
      [-20, 40, -20, 5],
    ];
    for (const [x, y, z, r] of probes) {
      field.queryPatches(x, y, z, r, out);
      const got = new Set(out);
      const want = new Set<number>();
      for (let p = 0; p < field.patchCount; p++) {
        const d = Math.hypot(field.patchCentre[p * 3]! - x, field.patchCentre[p * 3 + 1]! - y, field.patchCentre[p * 3 + 2]! - z);
        if (d <= r + field.patchRadius[p]!) want.add(p);
      }
      expect(got.size, `query ${x},${y},${z} r${r}`).toBe(out.length);
      expect([...want].filter((p) => !got.has(p)), `missed by hash at ${x},${y},${z} r${r}`).toHaveLength(0);
      expect([...got].filter((p) => !want.has(p)), `spurious at ${x},${y},${z} r${r}`).toHaveLength(0);
    }
  });
});

describe('budget and paint buffers', () => {
  it('bakes "Dock Approach" well inside the ~1 M point ceiling (vision §12)', () => {
    // One floor of five. Edge vertices count too — they are points on the GPU like any other.
    const points = field.counts.surfels + field.counts.edges * 2;
    expect(points).toBeLessThan(1_000_000);
    // Headroom, not just compliance: five stacked floors of this size have to fit the same budget.
    expect(points * 5).toBeLessThan(1_000_000);
    expect(field.counts.samples).toBeGreaterThan(field.counts.surfels);
  });

  it('starts black: nothing is painted that was never heard', () => {
    const fresh = bakeSurfels(buildWorld(fixtureMap));
    expect(fresh.paintedDots).toBe(0);
    expect(fresh.paintedEdgeVerts).toBe(0);
    expect(fresh.paintTime.every((v) => v === UNPAINTED)).toBe(true);
    expect(fresh.edgePaintTime.every((v) => v === UNPAINTED)).toBe(true);
    expect(fresh.paintIntensity.every((v) => v === 0)).toBe(true);
    expect(fresh.edgePaintIntensity.every((v) => v === 0)).toBe(true);
  });

  it('keeps UNPAINTED exactly representable in a float32 attribute', () => {
    // Paint's "have I ever been lit" test is `paintTime[i] === UNPAINTED`. If the sentinel did not
    // survive the round trip, every dot would look painted and `paintedDots` would never move.
    expect(new Float32Array([UNPAINTED])[0]).toBe(UNPAINTED);
    expect(Math.fround(UNPAINTED)).toBe(UNPAINTED);
    // …and it is far enough below any real sim time that an age computed from it is astronomical.
    expect(UNPAINTED).toBeLessThan(-1e6);
  });

  it('hands the looks shared geometry with dynamic paint attributes', () => {
    for (const [g, n] of [
      [fxField.geometry, fxField.count],
      [fxField.edgeGeometry, fxField.edgeCount * 2],
    ] as const) {
      const pt = g.getAttribute('paintTime');
      const pi = g.getAttribute('paintIntensity');
      expect(pt.array.length).toBe(n);
      expect(pi.array.length).toBe(n);
      expect(pt.itemSize).toBe(1);
      // The buffers paint writes into ARE the attribute arrays — no copy, no staging.
      expect(g.getAttribute('position').array.length).toBe(n * 3);
    }
    expect(fxField.geometry.getAttribute('paintTime').array).toBe(fxField.paintTime);
    expect(fxField.geometry.getAttribute('paintIntensity').array).toBe(fxField.paintIntensity);
    expect(fxField.edgeGeometry.getAttribute('paintTime').array).toBe(fxField.edgePaintTime);
    expect(fxField.edgeGeometry.getAttribute('flagsHold').array).toBe(fxField.edgeHold);
    expect(fxField.geometry.getAttribute('dither').array).toBe(fxField.dither);
  });
});
