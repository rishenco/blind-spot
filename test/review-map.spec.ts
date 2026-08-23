/**
 * REVIEW SPEC (milestone-1 adversarial review) — src/core/map/sampleMap.ts vs doc/sample-map.md.
 *
 * Each `it` names one finding, except the last two which are positive regression guards
 * worth keeping regardless.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld, countWalls, groundUnder } from '../src/core/map/build.js';
import { sampleMap } from '../src/core/map/sampleMap.js';
import { CAN_RADIUS, CAPSULE_RADIUS, HEIGHT_CROUCH } from '../src/core/const.js';

const world = buildWorld(sampleMap);
const R = CAPSULE_RADIUS;

describe('review: mezzanine ladder landing', () => {
  it('the ladder top has a surface to step off onto', () => {
    // doc/sample-map.md §2 B: "Ladder floor->catwalk on the west wall at z 23", and §4 test
    // line 2 requires climbing it. sampleMap derivation 3 claims the hatch makes the climber
    // "arrive ON the catwalk"; the hatch (z 22.5..23.5) is centred on the ladder instead.
    const l = world.ladders.find((v) => v.def.id === 'ladder-mezzanine');
    expect(l).toBeTruthy();
    const top = l!.yTop;

    // Step off in the ladder's facing direction (+x), one capsule radius clear of the rungs.
    const stepX = l!.maxX + R;
    const stepZ = (l!.minZ + l!.maxZ) / 2;
    expect(groundUnder(world, stepX, stepZ, top, R, 0.6)?.solid.id).toBeTruthy();
  });
});

describe('review: authored solid overlaps', () => {
  it('no two crates interpenetrate', () => {
    // engine-plan §10 vitest list: "no overlapping solids where rooms should be".
    // doc §2 D1 calls crate (41.8, z 7) "adjacent" to the 2.0 stack at (42, 0, 6).
    const crates = world.solids.filter((s) => s.kind === 'crate');
    const bad: string[] = [];
    for (let i = 0; i < crates.length; i++) {
      for (let k = i + 1; k < crates.length; k++) {
        const a = crates[i]!;
        const b = crates[k]!;
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        if (ox > 1e-6 && oy > 1e-6 && oz > 1e-6) bad.push(`${a.id} x ${b.id} (${ox}x${oy}x${oz} m)`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('review: dog routes', () => {
  it('no patrol leg passes through a solid at dog height', () => {
    const bad: string[] = [];
    for (const route of sampleMap.dogRoutes) {
      const wps = route.waypoints;
      for (let i = 0; i < wps.length; i++) {
        const a = wps[i]!;
        const b = wps[(i + 1) % wps.length]!;
        const walls = countWalls(world, a.x, 0.5, a.z, b.x, 0.5, b.z);
        if (walls > 0) bad.push(`${route.id} (${a.x},${a.z})->(${b.x},${b.z}) crosses ${walls}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('review: positive regression guards (currently pass)', () => {
  it('a straight crouch lane exists through the can field into door [f]', () => {
    // doc §2 D2: "crouch line through is authored to exist".
    const door = sampleMap.doors.find((d) => d.id === 'f')!;
    const cans = sampleMap.props.filter((p) => p.type === 'can' && p.id.startsWith('can-field'));
    const need = R + CAN_RADIUS;
    let best = -1;
    for (let x = door.from + R; x <= door.to - R; x += 0.005) {
      let clear = Infinity;
      for (const c of cans) clear = Math.min(clear, Math.abs(x - (c as { x: number }).x));
      if (clear > best) best = clear;
    }
    expect(best).toBeGreaterThan(need);
  });

  it('the slide duct is crouchable and not standable', () => {
    const duct = world.solids.find((s) => s.id === 'duct')!;
    expect(duct.minY).toBeGreaterThan(HEIGHT_CROUCH);
    expect(duct.minY).toBeLessThan(1.7);
  });
});
