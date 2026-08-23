/**
 * The look boundary (engine-plan §9) — the parts of a look that can be checked without a GPU.
 *
 * Three art directions are going to be built against `looks/types.ts`, and two of the debug look's
 * decisions are load-bearing for every one of them:
 *
 *   THE SPLAT CLAMP   The near-field dot cap (visual-brief §2) is a look-private ceiling, but the
 *                     FLOORS it is clamped against are core constants (`SPLAT_MIN_PX`,
 *                     `SPLAT_NEAR_PX`) that a tuning pass may raise. GLSL leaves `clamp` UNDEFINED
 *                     when minVal > maxVal, so an ordering owned by two different modules is a
 *                     driver-dependent hazard unless the shader is written to survive it.
 *   THE RIG CONTRACT  Core hands a look four bones, not geometry (`RigArm` in core/player.ts). The
 *                     forearm bone is the elbow-wrist MIDPOINT, so a look reconstructs the bone's
 *                     length as twice its distance from the hand. If either side stops believing
 *                     that, the arm is drawn at double length and nothing throws.
 *
 * These read the look's SOURCE. That is deliberate: the assertions are about decisions written in
 * GLSL and in scene-graph setup, neither of which a headless test can execute, and a source pin
 * that names the exact expression is what makes a silent edit fail loudly here instead of quietly
 * in a screenshot nobody looks at. Runtime behaviour of the same rig is pinned in
 * test/player.spec.ts; browser-side ink is pinned by `npm run verify`.
 */

import { describe, expect, it } from 'vitest';
import lookSource from '../src/looks/debug/index.ts?raw';
import { CORE_CONSTANTS } from '../src/core/const.js';

describe('the near-field splat cap (visual-brief §2, vision §12)', () => {
  it('MUST be a fraction of frame height, fed as a uniform and recomputed on resize', () => {
    // An absolute pixel cap means a different thing in every window: the lattice's screen pitch
    // scales with frame HEIGHT (uProjScale = viewH/2 / tan(fov/2)), so a cap that does not scale
    // with height stops matching the pitch it was tuned against the moment the window changes.
    const m = /const SPLAT_CAP_FRAC = ([0-9.]+)/.exec(lookSource);
    expect(m).not.toBeNull();
    const frac = Number(m![1]);
    expect(Number.isFinite(frac)).toBe(true);
    expect(frac).toBeGreaterThan(0);
    expect(frac).toBeLessThan(1);

    // Set once at init and again on every resize — a cap fixed at boot is an absolute cap wearing
    // a fraction's clothes.
    expect(lookSource).toContain('uSplatCap: { value: SPLAT_CAP_FRAC * viewH }');
    expect(lookSource).toContain("setUniform(dotMat, 'uSplatCap', SPLAT_CAP_FRAC * viewH)");

    // And no absolute cap left behind under the old name.
    expect(lookSource).not.toContain('SPLAT_CAP_PX');
  });

  it('MUST write a clamp that cannot invert, whatever core raises its floors to', () => {
    // `clamp(x, lo, hi)` with lo > hi is UNDEFINED in GLSL — not clamped, not an error: whatever
    // the driver does. The floors come from core and the ceiling from the look, so the shader
    // resolves the conflict itself with `max(cap, floor)`: the floor wins, which is the ordering
    // vision §12 demands ("splats >= 2-3 px and temporally stable").
    expect(lookSource).toContain('float floorPx = mix(uSplatNear, uSplatMin, far);');
    expect(lookSource).toContain('float size = clamp(foot, floorPx, max(uSplatCap, floorPx));');

    // The floors themselves still obey the vision's own minimum.
    expect(CORE_CONSTANTS.SPLAT_MIN_PX).toBeGreaterThanOrEqual(2);
    expect(CORE_CONSTANTS.SPLAT_NEAR_PX).toBeGreaterThanOrEqual(CORE_CONSTANTS.SPLAT_MIN_PX);
  });

  it('leaves no half-removed ink machinery behind', () => {
    expect(lookSource).not.toContain('uSplatInk');
    expect(lookSource).not.toContain('SPLAT_INK');
  });
});

describe('the hands rig as a look consumes it (engine-plan §6)', () => {
  it('MUST reconstruct the bone as twice the forearm→hand distance', () => {
    // Core writes the forearm bone at the elbow-wrist midpoint (pinned exactly in
    // test/player.spec.ts). This is the other half of that contract: the look scales its forearm
    // mesh by `half * 2`, which is the true elbow→wrist length only while the midpoint law holds.
    expect(lookSource).toContain('half * 2');
  });
});

describe('the refusal readout (vision §3.8, §3.5)', () => {
  it('MUST print why a press made no sound, and stop printing it', () => {
    // A refused ping is the one event in the game with no sound of its own, so silence after a
    // press is otherwise indistinguishable from a dead key. Core owns the reason and the instant
    // (`PingResult`); the look owns the styling and how long it lingers.
    const m = /const REFUSAL_SHOW = ([0-9.]+)/.exec(lookSource);
    expect(m).not.toBeNull();
    const show = Number(m![1]);
    expect(show).toBeGreaterThan(0.2);
    expect(show).toBeLessThan(2);
    expect(lookSource).toContain('lp.refused');
    expect(lookSource).toContain('now - lp.at < REFUSAL_SHOW');
  });
});
