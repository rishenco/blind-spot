/**
 * The loop's second gear: stepping.
 *
 * `Loop` normally paces the simulation off the display clock, and deliberately *drops* a frame
 * longer than `maxFrameSeconds` rather than banking it — correct for a player, useless for a
 * test, because it makes the simulated time behind a wall-clock wait a fact about the host. The
 * screenshot suite drives the game by tick count instead (`tools/shoot.mjs`), and this is the
 * contract it drives it through. It is checked here rather than only in the browser because
 * "did exactly N ticks run" deserves a faster oracle than a screenshot.
 *
 * Only the stepped path is covered. The wall-clock path needs `requestAnimationFrame` and a real
 * clock, and what it does with them is the thing every other test in this directory already
 * measures through `GameSim`.
 */

import { describe, expect, it } from 'vitest';
import { Loop } from '../src/core/loop';

function spy() {
  const calls = { fixed: [] as number[], render: [] as number[], draw: 0, settle: 0 };
  const loop = new Loop({
    fixedUpdate: (dt) => calls.fixed.push(dt),
    render: (alpha) => calls.render.push(alpha),
    draw: () => (calls.draw += 1),
    settleTick: () => (calls.settle += 1),
  });
  return { loop, calls };
}

describe('Loop.step', () => {
  it('runs exactly the ticks it is asked for, at the fixed timestep', () => {
    const { loop, calls } = spy();
    loop.step(7);
    expect(calls.fixed).toHaveLength(7);
    expect(new Set(calls.fixed)).toEqual(new Set([loop.stepSeconds]));
    expect(loop.ticks).toBe(7);
    expect(loop.ticksLastFrame).toBe(7);
    expect(loop.step(3)).toBe(10);
    expect(calls.fixed).toHaveLength(10);
  });

  it('suspends the display clock on first use, and hands it back on resume', () => {
    const { loop } = spy();
    expect(loop.suspended).toBe(false);
    loop.step(1);
    expect(loop.suspended).toBe(true);
    loop.resume();
    expect(loop.suspended).toBe(false);
    // Resuming banks nothing: the time the clock spent suspended is not owed to the simulation.
    expect(loop.ticks).toBe(1);
  });

  it('poses the frame once per step, at alpha 1', () => {
    const { loop, calls } = spy();
    loop.step(4);
    loop.step(0);
    // A pose per call, including the zero-tick one — that is how the driver reads state without
    // moving the world. `alpha` is 1 every time: a stepped frame describes the tick that just
    // ran, never a blend of it with the one before.
    expect(calls.render).toEqual([1, 1]);
    // ...and no GPU frame: drawing belongs to the display clock, which is still running.
    expect(calls.draw).toBe(0);
  });

  it('settles amortised work on every stepped tick', () => {
    const { loop, calls } = spy();
    loop.step(5);
    expect(calls.settle).toBe(5);
  });

  it('treats a negative or fractional tick count as the whole ticks it can honour', () => {
    const { loop, calls } = spy();
    loop.step(-3);
    expect(calls.fixed).toHaveLength(0);
    loop.step(2.9);
    expect(calls.fixed).toHaveLength(2);
    expect(loop.ticks).toBe(2);
  });
});
