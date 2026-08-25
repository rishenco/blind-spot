/**
 * Recording and replay.
 *
 * A match is a pure function of `(seed, config, controller names, intents that came from
 * outside)`. So a recording is not a dump of the world — it is that tuple plus the handful of
 * keystrokes a human contributed, and replaying is literally re-playing: the same simulation is
 * run again from tick 0 and produces the same match, bit for bit.
 *
 * That is what makes the scrubber honest. Scrubbing to tick N re-runs ticks 0..N and lets the
 * observer's perception be rebuilt along the way, so "what did player 2 hear at the moment of
 * the goal" is answered by the real perception pipeline rather than by a cache of pictures.
 * A three-minute 2×2 match is ~10 800 ticks and re-runs in a few milliseconds, which is why
 * this is affordable at all.
 */
import type { SimConfig } from './config';
import { cloneConfig } from './config';
import { makeController } from './controllers';
import { Match } from './match';
import type { StepOutput } from './sim';
import type { EntityId, Intent } from './types';

export interface RecordedInput {
  tick: number;
  id: EntityId;
  intent: Intent;
}

export interface Recording {
  version: 1;
  seed: number;
  /** Full config, so a replay does not depend on today's defaults. */
  config: SimConfig;
  controllers: string[];
  /** Only intents that came from outside the controllers — in practice, a human's. */
  inputs: RecordedInput[];
  ticks: number;
}

export function newRecording(seed: number, config: SimConfig, controllers: string[]): Recording {
  return { version: 1, seed, config: cloneConfig(config), controllers, inputs: [], ticks: 0 };
}

/** Records the external intent applied at `tick` (the tick that is about to be simulated). */
export function recordInput(rec: Recording, tick: number, id: EntityId, intent: Intent): void {
  rec.inputs.push({
    tick,
    id,
    intent: {
      move: { x: intent.move.x, y: intent.move.y },
      moveMode: intent.moveMode,
      aim: { x: intent.aim.x, y: intent.aim.y },
      ping: intent.ping,
      charge: intent.charge,
      catch: intent.catch,
      dive: intent.dive,
      call: intent.call,
    },
  });
}

export function buildMatch(rec: Recording, keepLog = true): Match {
  return new Match({
    config: rec.config,
    seed: rec.seed,
    controllers: rec.controllers.map((n) => makeController(n)),
    keepLog,
  });
}

/**
 * Re-runs a recording up to and including `targetTick`.
 *
 * `onTick` sees every step on the way, which is how the playground rebuilds a perceived view
 * for an arbitrary moment: it feeds its renderer model from the same perception frames the
 * controllers got.
 */
export function replayTo(
  rec: Recording,
  targetTick: number,
  onTick?: (match: Match, out: StepOutput) => void,
  match?: Match,
): Match {
  const m = match ?? buildMatch(rec);
  // Inputs are grouped by tick once, so the replay does not scan the list per tick.
  const byTick = new Map<number, RecordedInput[]>();
  for (const input of rec.inputs) {
    const list = byTick.get(input.tick);
    if (list) list.push(input);
    else byTick.set(input.tick, [input]);
  }
  while (m.sim.state.tick < targetTick && !m.isOver) {
    const next = m.sim.state.tick + 1;
    for (let i = 0; i < m.controllers.length; i++) m.setExternalIntent(i, null);
    for (const input of byTick.get(next) ?? []) m.setExternalIntent(input.id, input.intent);
    const out = m.step();
    onTick?.(m, out);
  }
  return m;
}

export function serialiseRecording(rec: Recording): string {
  return JSON.stringify(rec);
}

export function parseRecording(text: string): Recording {
  const rec = JSON.parse(text) as Recording;
  if (rec.version !== 1) throw new Error(`unsupported recording version: ${rec.version}`);
  return rec;
}
