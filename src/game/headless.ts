/**
 * The whole game, in Node, with no screen and no clock.
 *
 * `core/loop.ts` cannot be used here and that is the entire point of this file. The loop drives
 * the simulation from *wall time* and drops any frame longer than `maxFrameSeconds` instead of
 * banking it, so a "two second" hold under a slow renderer simulates an unknown amount of time —
 * which is why the browser screenshot suite drifts across runs of identical code and cannot serve
 * as a refactoring net. Here the caller counts ticks. The same script always simulates the same
 * number of seconds, so the same script always produces the same trace, and a behavioural change
 * shows up as an exact numeric diff in milliseconds.
 *
 * The tick order — `sim.tick`, then `input.endTick` — is the loop's own order (`main.ts`), so a
 * key tapped for one tick is seen by exactly one tick here too.
 */

import { ScriptedInput } from '../core/scriptedInput';
import type { SeedConfig } from '../core/rng';
import { GameSim } from './sim';

/** The rate the browser loop runs the simulation at; matched here so traces are comparable. */
const DEFAULT_HZ = 120;

export interface HeadlessGame {
  readonly sim: GameSim;
  readonly input: ScriptedInput;
  /** Fixed timestep, seconds. */
  readonly stepSeconds: number;
  /** Runs `ticks` fixed steps (default 1). */
  step(ticks?: number): void;
  /** Runs whole ticks covering `seconds` of simulated time. */
  run(seconds: number): void;
}

export interface HeadlessOptions {
  /** Reseeds every random stream, as `?seed=N` does. Omitted keeps the historical constants. */
  seed?: number;
  /** Simulation rate, Hz. */
  hz?: number;
}

export function createHeadlessGame(opts: HeadlessOptions = {}): HeadlessGame {
  const seed: SeedConfig | undefined =
    opts.seed === undefined ? undefined : { seed: Math.trunc(opts.seed) >>> 0, explicit: true };
  const sim = new GameSim({ seed });
  const input = new ScriptedInput();
  const stepSeconds = 1 / (opts.hz ?? DEFAULT_HZ);

  const step = (ticks = 1): void => {
    for (let i = 0; i < ticks; i++) {
      sim.tick(stepSeconds, input);
      input.endTick();
    }
  };

  return {
    sim,
    input,
    stepSeconds,
    step,
    run: (seconds: number): void => step(Math.round(seconds / stepSeconds)),
  };
}
