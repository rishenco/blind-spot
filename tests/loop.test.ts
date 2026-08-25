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
 * Both gears are covered here. The stepped one is the screenshot driver's; the wall-clock one is
 * every player's, and its numbers — the spiral-of-death clamp, the accumulator's carry, the
 * interpolation alpha — are measured nowhere else. This file used to say they were "the thing
 * every other test in this directory already measures through `GameSim`", and that was not true:
 * the `GameSim` tests advance the simulation by calling `sim.update(dt)` or `loop.step(n)`
 * directly, and none of them ever lets `frame` run. Replacing the first line of `frame` with a
 * throw passed the entire suite. `performance.now` and `requestAnimationFrame` are the only two
 * host facilities it touches, and a test can supply both.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * The loop's first gear: the display clock.
 *
 * Everything below is reachable only by letting `frame` execute, which means standing in for the
 * two globals it reaches for. The stubs are a clock the test moves by hand and a one-slot frame
 * queue — enough to make "how much simulated time came out of this much wall-clock time" a
 * question with an exact answer, which is the whole thing the accumulator exists to guarantee.
 */
describe('Loop on the display clock', () => {
  // Restored here rather than at the end of each test: a stubbed `performance` that outlived a
  // failing assertion would take the rest of the file down with it, and the second failure would
  // be the one anyone read.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function driven() {
    const { loop, calls } = spy();
    const clock = { t: 0 };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('performance', { now: () => clock.t });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.push(cb), 1));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    loop.start();
    /** Puts the clock at `ms` and delivers the frame that was waiting for it. */
    const jumpTo = (ms: number): void => {
      clock.t = ms;
      frames.pop()!(clock.t);
    };
    /** Moves the clock on by `ms` and delivers the frame that was waiting for it. */
    const advance = (ms: number): void => jumpTo(clock.t + ms);
    return { loop, calls, advance, jumpTo };
  }

  it('drops a stalled frame rather than banking it into a catch-up storm', () => {
    const { loop, advance } = driven();
    advance(3000); // tab hidden, GC pause, shader compile
    // 0.25 s of catch-up, not 3 s: 30 ticks at 120 Hz, not 360. Every extra tick would emit its
    // own footfall onto the sound bus, so an unclamped stall is a paint flash as well as a hitch —
    // and the flash is the worse half, because law 2 says every blip has a real source and thirty
    // of those thirty-one footsteps happened nowhere.
    expect(loop.ticksLastFrame).toBe(Math.floor(0.25 / loop.stepSeconds));
  });

  it('banks the remainder of a short frame instead of discarding it', () => {
    const { loop, advance } = driven();
    advance(5);
    expect(loop.ticksLastFrame).toBe(0); // 5 ms < one 8.33 ms tick
    advance(5);
    expect(loop.ticksLastFrame).toBe(1); // ...and the two halves add up to one
  });

  it('poses the frame at the leftover fraction of a tick, not at a constant', () => {
    const { loop, calls, advance } = driven();
    advance(5);
    advance(5);
    const alpha = calls.render.at(-1)!;
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
    expect(alpha).toBeCloseTo((0.01 - loop.stepSeconds) / loop.stepSeconds, 6);
  });

  /**
   * The reachable half of the frame-time guard.
   *
   * `performance.now` is specified monotonic and in practice never returns NaN, so the
   * `Number.isFinite` half of that line is belt-and-braces and is left untested on purpose —
   * and it would not survive being reached anyway, because `lastTime` is assigned *before* the
   * guard runs, so one NaN reading poisons every frame after it. Going backwards is the half
   * that has actually happened in the wild (clock adjustments, throttled tabs resuming), and it
   * is the half with a defined right answer.
   */
  it('ignores a clock that jumps backwards instead of running the sim in reverse', () => {
    const { loop, advance, jumpTo } = driven();
    advance(5); // 5 ms banked, no tick yet
    jumpTo(1); // ...and now the clock is 4 ms earlier than it was
    expect(loop.ticksLastFrame).toBe(0);
    // The banked 5 ms is still banked. A backwards frame is worth zero and never a debit:
    // unguarded, the accumulator drops to 1 ms and the frame after this one comes up a tick
    // short, which is the simulation quietly falling behind the world — the one thing a fixed
    // timestep exists to prevent.
    jumpTo(6);
    expect(loop.ticksLastFrame).toBe(1);
  });
});
