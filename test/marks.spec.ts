/**
 * The event layer as a look builds it (visual-brief §1.13, vision §3.2, §3.7).
 *
 * `src/looks/debug/marks.ts` is the one look file with real state in it — a ring of stains and a
 * merged buffer of dog poses — so it is checked as an object rather than only as source. What is
 * pinned here is the part a screenshot cannot argue with:
 *
 *   vision §3.2  two layers. A mark is coloured by its SOURCE and lives 2.5–6 s; geometry never
 *                takes a source's colour, so nothing here writes to the matter layer.
 *   §1.13        quality drives definition, not just brightness: a confident read is a small,
 *                tight, bright, long-lived stain and a vague one is a wide dim smudge.
 *   vision §3.4  a through-wall mark sits at the origin the PAINT used — the fuzzed one. Two
 *                answers to "where did that happen" is a lie.
 *   vision §3.7  a ghost is aged from `frozenAt` and from nothing else; live poses are ranked
 *                newest-first for the smear.
 *   vision §12   nothing in the event layer writes depth, and the layer is one draw call each.
 *
 * The GLSL is asserted as source for the same reason test/looks.spec.ts does it: a headless test
 * cannot run a shader, and a source pin naming the exact expression is what makes a silent edit
 * fail here instead of quietly in a picture nobody looks at.
 */

import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, type ShaderMaterial } from 'three';
import marksSource from '../src/looks/debug/marks.ts?raw';
import { CORE_CONSTANTS, SIM_STEP, STAIN_FADE_MAX, STAIN_FADE_MIN } from '../src/core/const.js';
import type { DogView, GhostSnapshot, PoseSample } from '../src/core/dog.js';
import { EventBus, type SoundEvent } from '../src/core/events.js';
import { DogField, StainField, type MarkFrame } from '../src/looks/debug/marks.js';

const frame = (now: number): MarkFrame => ({
  now,
  camPos: [0, 1.6, 0],
  projScale: 500,
  pixelRatio: 1,
  capPx: 12,
  floorCentre: 0,
  floorSpan: 8,
});

/** A delivered event, built the way the bus builds one and then marked as heard. */
function heard(patch: Partial<SoundEvent> & Pick<SoundEvent, 'source'>, quality: number): SoundEvent {
  const bus = new EventBus();
  bus.now = patch.time ?? 1;
  const e = bus.emit({
    class: patch.class ?? 'walkStep',
    source: patch.source,
    x: patch.origin?.[0] ?? 4,
    y: patch.origin?.[1] ?? 0.1,
    z: patch.origin?.[2] ?? 5,
  });
  return { ...e, ...patch, quality, wallsToListener: patch.wallsToListener ?? 0 };
}

const attr = (f: StainField, name: string): Float32Array =>
  f.points.geometry.getAttribute(name).array as Float32Array;

describe('noise stains (visual-brief §1.13, vision §3.2)', () => {
  it('is not drawn at all until something has been heard', () => {
    const f = new StainField(CORE_CONSTANTS, false);
    expect(f.points.visible).toBe(false);
    f.update(frame(0));
    // Vision §1.3's black world has to survive an empty ring: a draw call that renders nothing is
    // still a draw call.
    expect(f.points.visible).toBe(false);
    expect(f.count(0)).toBe(0);
    f.dispose();
  });

  it('turns quality into size, brightness, definition and lifetime, in that one direction', () => {
    const f = new StainField(CORE_CONSTANTS, false);
    f.stamp(heard({ source: 'self', time: 1 }, 1));
    f.stamp(heard({ source: 'self', time: 1 }, 0));
    const radius = attr(f, 'aRadius');
    const peak = attr(f, 'aPeak');
    const sharp = attr(f, 'aSharp');
    const fade = attr(f, 'aFade');

    // A confident read is small, bright, defined and long-lived; a vague one is the opposite of
    // all four at once. Any one of them inverting would make a far-off guess read as a fact.
    expect(radius[0]!).toBeLessThan(radius[1]!);
    expect(peak[0]!).toBeGreaterThan(peak[1]!);
    expect(sharp[0]!).toBeGreaterThan(sharp[1]!);
    expect(fade[0]!).toBeGreaterThan(fade[1]!);

    // The lifetime is vision §3.2's window verbatim, spent on the events that told you something.
    expect(fade[0]!).toBeCloseTo(STAIN_FADE_MAX, 9);
    expect(fade[1]!).toBeCloseTo(STAIN_FADE_MIN, 9);

    // And the peak is airy: an additive mark over an already-bright lattice is how a near field
    // fuses into a sheet (vision §12).
    expect(peak[0]!).toBeLessThan(0.35);
    f.dispose();
  });

  it('colours a mark by its source, never by what it painted', () => {
    const f = new StainField(CORE_CONSTANTS, false);
    const sources: SoundEvent['source'][] = ['self', 'teammate', 'dog', 'prop', 'objective', 'detonation'];
    for (const source of sources) f.stamp(heard({ source }, 1));
    const c = attr(f, 'aColor');
    const rgb = (i: number): [number, number, number] => [c[i * 3]!, c[i * 3 + 1]!, c[i * 3 + 2]!];

    // Vision §3.2's table: self amber, teammate green, dog red-orange, prop pale yellow,
    // objective gold, detonation a white flash. Every one distinct from every other.
    const seen = sources.map((_, i) => rgb(i).join(','));
    expect(new Set(seen).size).toBe(sources.length);
    expect(rgb(0)[0]).toBeGreaterThan(rgb(0)[2]); // self: warm
    expect(rgb(1)[1]).toBeGreaterThan(rgb(1)[0]); // teammate: green-dominant
    expect(rgb(2)[0]).toBeGreaterThan(rgb(2)[1]); // dog: red-orange
    expect(rgb(5)).toEqual([1, 1, 1]); // detonation: white
    f.dispose();
  });

  it('marks a walled read where the paint went, fuzz and all (vision §3.4)', () => {
    const f = new StainField(CORE_CONSTANTS, false);
    const clean = heard({ source: 'dog', origin: [10, 0.1, 5], wallsToListener: 0 }, 0.5);
    const walled: SoundEvent = { ...clean, wallsToListener: 1 };
    f.stamp(clean);
    f.stamp(walled);
    const p = attr(f, 'position');
    expect(Math.hypot(p[0]! - 10, p[1]! - 0.1, p[2]! - 5)).toBeLessThan(1e-6);
    // Through a wall the origin the pipeline painted from is displaced, and the mark goes with it:
    // the mark and the geometry it lit have to agree about where the sound was.
    const moved = Math.hypot(p[3]! - 10, p[4]! - 0.1, p[5]! - 5);
    expect(moved).toBeGreaterThan(0);
    f.dispose();
  });

  it('counts down and goes dark on its own clock', () => {
    const f = new StainField(CORE_CONSTANTS, false);
    f.stamp(heard({ source: 'self', time: 1 }, 1));
    expect(f.count(1)).toBe(1);
    f.update(frame(1));
    expect(f.points.visible).toBe(true);

    expect(f.count(1 + STAIN_FADE_MAX - SIM_STEP)).toBe(1);
    expect(f.count(1 + STAIN_FADE_MAX + SIM_STEP)).toBe(0);
    f.update(frame(1 + STAIN_FADE_MAX + SIM_STEP));
    expect(f.points.visible).toBe(false);
    f.dispose();
  });

  it('is a hard pool: the oldest mark is overwritten, never a growing buffer', () => {
    const f = new StainField(CORE_CONSTANTS, false);
    const cap = Number(/const STAIN_CAP = (\d+)/.exec(marksSource)![1]);
    const slots = attr(f, 'position').length / 3;
    expect(slots).toBe(cap);
    for (let i = 0; i < cap * 2; i++) f.stamp(heard({ source: 'self', time: 100 }, 1));
    // Vision §12: a mark layer that can grow without bound is a way for the screen to become
    // porridge no fence can see coming.
    expect(attr(f, 'position').length / 3).toBe(cap);
    expect(f.count(100)).toBe(cap);
    f.dispose();
  });

  it('softens its onset and its peak in reduce-flashing mode, without changing what it means', () => {
    const loud = new StainField(CORE_CONSTANTS, false);
    const calm = new StainField(CORE_CONSTANTS, true);
    const e = heard({ source: 'detonation', time: 1 }, 1);
    loud.stamp(e);
    calm.stamp(e);
    expect(attr(calm, 'aPeak')[0]!).toBeLessThan(attr(loud, 'aPeak')[0]!);
    // Same place, same colour, same lifetime — the comfort setting is a fade, not a different map.
    expect(attr(calm, 'aFade')[0]!).toBe(attr(loud, 'aFade')[0]!);
    expect(attr(calm, 'aRadius')[0]!).toBe(attr(loud, 'aRadius')[0]!);
    expect(Array.from(attr(calm, 'aColor').slice(0, 3))).toEqual(Array.from(attr(loud, 'aColor').slice(0, 3)));
    const onset = /uOnset: \{ value: reduceFlashing \? STAIN_ONSET_CALM : STAIN_ONSET \}/.test(marksSource);
    expect(onset).toBe(true);
    loud.dispose();
    calm.dispose();
  });
});

// ==========================================================================================
// The dog field
// ==========================================================================================

/** A three-point stand-in for the body cloud: the transform is what is under test, not the dog. */
function stubCloud(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  return g;
}

const pose = (time: number, x: number, z: number): PoseSample => ({
  time,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1],
});

function stubDog(
  cloud: BufferGeometry,
  poses: PoseSample[],
  ghosts: GhostSnapshot[],
  quality = 0.5,
): DogView {
  return {
    id: 0,
    cloudGeom: cloud,
    cloudSpacing: 0.04,
    poseHistory: poses,
    ghosts,
    lastEventQuality: quality,
  };
}

const dogAttr = (f: DogField, name: string): Float32Array =>
  f.points.geometry.getAttribute(name).array as Float32Array;

describe('the dog field (vision §6, §3.7)', () => {
  it('draws nothing for a dog nobody has heard', () => {
    const f = new DogField(CORE_CONSTANTS);
    const cloud = stubCloud();
    f.update([stubDog(cloud, [], [])], frame(0));
    // "A stationary, silent dog is invisible" — the rule that hides you hides it.
    expect(f.points.visible).toBe(false);
    expect(f.points.geometry.drawRange.count).toBe(0);
    f.dispose();
  });

  it('places every pose in the world by its own matrix', () => {
    const f = new DogField(CORE_CONSTANTS);
    const cloud = stubCloud();
    f.update([stubDog(cloud, [pose(1, 7, 3)], [])], frame(1));
    expect(f.points.visible).toBe(true);
    expect(f.points.geometry.drawRange.count).toBe(3);
    const p = dogAttr(f, 'position');
    expect([p[0], p[1], p[2]]).toEqual([7, 0, 3]);
    expect([p[3], p[4], p[5]]).toEqual([8, 0, 3]);
    expect([p[6], p[7], p[8]]).toEqual([7, 1, 3]);
    f.dispose();
  });

  it('ranks the live smear newest-first and marks ghosts as ghosts', () => {
    const f = new DogField(CORE_CONSTANTS);
    const cloud = stubCloud();
    const ghost: GhostSnapshot = { pose: pose(2, 1, 1), frozenAt: 2.4, quality: 0.25 };
    f.update([stubDog(cloud, [pose(1, 0, 0), pose(1.2, 1, 0)], [ghost], 0.8)], frame(3));

    const kind = dogAttr(f, 'aKind');
    const rank = dogAttr(f, 'aRank');
    const born = dogAttr(f, 'aBorn');
    const quality = dogAttr(f, 'aQuality');

    // Poses first, in history order: the OLDER sample carries the higher rank, so the smear fades
    // backwards in time from the last thing actually heard.
    expect(rank[0]).toBe(1);
    expect(rank[3]).toBe(0);
    expect(kind[0]).toBe(0);
    expect(kind[3]).toBe(0);
    expect(quality[0]).toBeCloseTo(0.8, 6);

    // The ghost is aged from `frozenAt` and from nothing else — not from the pose's own time, and
    // never from a frame counter.
    expect(kind[6]).toBe(1);
    expect(born[6]).toBeCloseTo(2.4, 6);
    expect(quality[6]).toBeCloseTo(0.25, 6);
    f.dispose();
  });

  it('rebuilds only when the pose set changes', () => {
    const f = new DogField(CORE_CONSTANTS);
    const cloud = stubCloud();
    const poses = [pose(1, 0, 0)];
    const dog = stubDog(cloud, poses, []);
    f.update([dog], frame(1));
    const buffer = f.points.geometry.getAttribute('position').array;

    // Ageing is entirely a shader job: what a frame changes is the clock, and the clock is a
    // uniform. A per-frame CPU rebuild of every dog is the cost this exists to avoid.
    f.update([dog], frame(1.5));
    expect(f.points.geometry.getAttribute('position').array).toBe(buffer);

    poses.push(pose(1.2, 2, 0));
    f.update([dog], frame(1.5));
    expect(f.points.geometry.drawRange.count).toBe(6);
    f.dispose();
  });

  it('draws the body at its own lattice pitch, not the world’s', () => {
    const f = new DogField(CORE_CONSTANTS);
    const cloud = stubCloud();
    f.update([stubDog(cloud, [pose(1, 0, 0)], [])], frame(1));
    const spacing = (f.points.material as ShaderMaterial).uniforms.uSpacing!.value as number;
    // The dog is sampled far finer than the map, so borrowing SURFEL_SPACING would draw it as a
    // solid slab at any range you could actually hear it from.
    expect(spacing).toBeCloseTo(0.04, 9);
    expect(spacing).toBeLessThan(CORE_CONSTANTS.SURFEL_SPACING);
    f.dispose();
  });

  it('never disposes the cloud it was lent (looks/types.ts)', () => {
    const f = new DogField(CORE_CONSTANTS);
    const cloud = stubCloud();
    let disposed = false;
    cloud.addEventListener('dispose', () => {
      disposed = true;
    });
    f.update([stubDog(cloud, [pose(1, 0, 0)], [])], frame(1));
    f.dispose();
    // The body cloud belongs to core and is shared by every dog: a look that disposed it would
    // take the other dogs with it.
    expect(disposed).toBe(false);
    expect(cloud.getAttribute('position').count).toBe(3);
  });
});

// ==========================================================================================
// What only the source can say
// ==========================================================================================

describe('the event layer’s standing rules (vision §3.2, §3.6, §12)', () => {
  it('never writes depth, and always annotates the matter layer rather than hiding it', () => {
    // Two materials, both transparent, both additive, neither writing depth: a warm mark that
    // wrote depth would occlude the cyan lattice and start reading as near geometry.
    expect(marksSource.match(/depthWrite: false/g)?.length).toBe(2);
    expect(marksSource.match(/blending: AdditiveBlending/g)?.length).toBe(2);
    expect(marksSource).not.toContain('depthTest: false');
  });

  it('obeys the same hard window as the matter layer (vision §3.6)', () => {
    // 45 m and ±1 floor, culled in the vertex stage of BOTH shaders: the event layer does not get
    // to see further than the geometry does.
    expect(marksSource.match(/distance\(position, uCamPos\) > uWindowRadius\) CULL\(\)/g)?.length).toBe(2);
    expect(marksSource.match(/abs\(position\.y - uFloorCentre\) > uFloorSpan\) CULL\(\)/g)?.length).toBe(2);
    expect(marksSource).toContain('uWindowRadius: { value: constants.WINDOW_RADIUS }');
  });

  it('caps a mark at a splat’s own ceiling and floors it above sub-pixel', () => {
    // Uncapped, a low-quality 2 m smudge heard from three metres away is most of the frame; and a
    // mark under a few pixels is a shimmer rather than a reading (vision §12).
    expect(marksSource.match(/clamp\(px, uMinPx, max\(uCapPx, uMinPx\)\) \* uPixelRatio/g)?.length).toBe(2);
  });

  it('takes the mark’s position from the pipeline’s own delivered origin', () => {
    expect(marksSource).toContain("import { deliveredOrigin } from '../../core/paint.js'");
    expect(marksSource).toContain('const o = deliveredOrigin(e);');
  });
});
