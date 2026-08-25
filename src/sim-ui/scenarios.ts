/**
 * Named, reproducible situations.
 *
 * One list serves three consumers: the playground's dropdown, the keyframe generator, and
 * (soon) the deception tests the AI brief asks for. A scenario is data — a seed, a config, a
 * roster, and a rule for when to stop — so adding one is three lines and no plumbing.
 *
 * Stopping "on the first interception" is resolved by running the match once, headless, reading
 * its timeline, and then running it AGAIN from tick zero to the tick just before the moment.
 * That is only affordable because the match is deterministic and a full 2×2 match re-simulates
 * in tens of milliseconds — the same property that makes the scrubber possible.
 */
import { configFromPreset, type SimConfig } from '../sim/config';
import { makeController, scripted } from '../sim/controllers';
import type { ControllerFactory, TimelineEntry } from '../sim/match';
import type { EntityId } from '../sim/types';

export interface ScenarioSetup {
  config: SimConfig;
  seed: number;
  controllers: { name: string; make: ControllerFactory }[];
  /** Whose ears the right-hand pane listens with. */
  eyes: EntityId;
}

export interface Scenario {
  name: string;
  /** One line, printed under the keyframe. */
  note: string;
  make(): ScenarioSetup;
  /** Run until the first timeline entry of this kind, then back off `lead` ticks. */
  stopOn?: { kind: TimelineEntry['kind']; lead?: number };
  /** Otherwise: run exactly this many ticks. */
  ticks?: number;
}

const pair = (a: string, b: string, size: number) => [
  ...Array.from({ length: size }, () => makeController(a)),
  ...Array.from({ length: size }, () => makeController(b)),
];

export const SCENARIOS: Scenario[] = [
  {
    name: 'kickoff',
    note: 'the opening seconds: two strikers against two goalies, ball with P0',
    ticks: 45,
    make: () => {
      const config = configFromPreset('default');
      return { config, seed: 20260825, controllers: pair('striker', 'goalie', config.teamSize), eyes: 2 };
    },
  },
  {
    name: 'goal',
    note: 'the baseline striker finishing into an unguarded net — the frame before the ball crosses',
    stopOn: { kind: 'goal', lead: 4 },
    make: () => {
      const config = configFromPreset('default');
      return { config, seed: 11, controllers: pair('striker', 'statue', config.teamSize), eyes: 2 };
    },
  },
  {
    name: 'interception',
    note: 'a throw taken out of the air by the other team',
    stopOn: { kind: 'interception', lead: 2 },
    make: () => {
      const config = configFromPreset('default');
      return { config, seed: 3, controllers: pair('striker', 'goalie', config.teamSize), eyes: 2 };
    },
  },
  {
    name: 'fumble',
    note: 'a mistimed grab: the ball bounces off a body and the mistake is heard 20 m away',
    stopOn: { kind: 'fumble', lead: 1 },
    make: () => {
      const config = configFromPreset('default');
      return { config, seed: 3, controllers: pair('striker', 'ballchaser', config.teamSize), eyes: 3 };
    },
  },
  {
    name: 'ping',
    note: 'P0 pings: the front is still travelling, and every other player has already heard exactly where P0 is',
    ticks: 30,
    make: () => {
      const config = configFromPreset('default');
      const prober = scripted(
        [
          { for: 0.15, aim: [1, 0] },
          { ping: true, label: 'ping' },
          { for: 3, label: 'listen' },
        ],
        'prober',
      );
      return {
        config,
        seed: 5,
        controllers: [
          { name: 'prober', make: prober },
          makeController('statue'),
          makeController('statue'),
          makeController('statue'),
        ],
        // Watched from a silent opponent: the pane shows one white mark at P0's exact position
        // and nothing else — being pinged tells you where the pinger is, not what it saw.
        eyes: 2,
      };
    },
  },
  {
    name: 'ping-instant',
    note: 'the same ping with waveSpeed = ∞ — the whole snapshot lands on one tick, for comparison',
    ticks: 8,
    make: () => {
      const config = configFromPreset('default');
      config.ping.waveSpeed = Infinity;
      const prober = scripted(
        [
          { for: 0.15, aim: [1, 0] },
          { ping: true, label: 'ping' },
          { for: 3, label: 'listen' },
        ],
        'prober',
      );
      return {
        config,
        seed: 5,
        controllers: [
          { name: 'prober', make: prober },
          makeController('statue'),
          makeController('statue'),
          makeController('statue'),
        ],
        eyes: 0,
      };
    },
  },
  {
    name: 'ping-self',
    note: 'the travelling front, seen by the pinger 0.1 s in: near geometry has resolved, far geometry has not',
    ticks: 8,
    make: () => {
      const config = configFromPreset('default');
      const prober = scripted(
        [
          { for: 0.05, aim: [1, 0] },
          { ping: true, label: 'ping' },
          { for: 3, label: 'listen' },
        ],
        'prober',
      );
      return {
        config,
        seed: 5,
        controllers: [
          { name: 'prober', make: prober },
          makeController('statue'),
          makeController('randomwalker'),
          makeController('randomwalker'),
        ],
        eyes: 0,
      };
    },
  },
  {
    name: 'feint',
    note: 'the run-and-stop feint: P0 sprints right, brakes loudly, then walks quietly the other way — watched from P2',
    ticks: 210,
    make: () => {
      const config = configFromPreset('default');
      const feint = scripted(
        [
          { for: 1.2, run: [1, 0.2], aim: [1, 0], label: 'break right' },
          { for: 0.35, stand: true, label: 'the loud stop' },
          { for: 2.0, walk: [-0.2, -1], label: 'away, quietly' },
        ],
        'feint',
      );
      return {
        config,
        seed: 8,
        controllers: [
          { name: 'feint', make: feint },
          makeController('statue'),
          makeController('statue'),
          makeController('statue'),
        ],
        eyes: 2,
      };
    },
  },
  {
    name: 'silence',
    note: 'a striker hunting two statues: its pane holds its own noise and the ball, and not one trace of either opponent',
    ticks: 120,
    make: () => {
      const config = configFromPreset('default');
      return { config, seed: 2, controllers: pair('striker', 'statue', config.teamSize), eyes: 0 };
    },
  },
];

export function findScenario(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario: ${name}`);
  return s;
}
