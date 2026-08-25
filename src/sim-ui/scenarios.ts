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
import { AI_SCENARIOS } from '../sim/ai/scenarios';
import { applyRuleset, configFromPreset, type SimConfig } from '../sim/config';
import { makeController, scripted } from '../sim/controllers';
import type { ControllerFactory, TimelineEntry } from '../sim/match';
import type { EntityId, Vec2 } from '../sim/types';
import { CatchHand, LoudHand, PingHand, ThrowHand, TouchHand, type HandScript } from './hands';

export interface ScenarioSetup {
  config: SimConfig;
  seed: number;
  controllers: { name: string; make: ControllerFactory }[];
  /** Whose ears the right-hand pane listens with. */
  eyes: EntityId;
}

/** A scripted pair of human hands bound to one slot — see `hands.ts` for why this exists. */
export interface HandSlot {
  slot: EntityId;
  script: HandScript;
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
  /**
   * Slots driven by a script instead of by a controller. The playground feeds them through
   * `Match.setExternalIntent`, which is the same door a person at a keyboard goes through, so
   * the cockpit, the audio and the feedback layer all behave exactly as they would for a human.
   */
  hands?: HandSlot[];
  /** Whose cockpit is drawn — the HUD is only ever shown for a slot a human (or a script) drives. */
  playerSlot?: EntityId;
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
    // Negative lead = a few ticks AFTER the moment, so the catch is visible rather than pending.
    stopOn: { kind: 'interception', lead: -6 },
    make: () => {
      const config = configFromPreset('default');
      return { config, seed: 3, controllers: pair('striker', 'goalie', config.teamSize), eyes: 2 };
    },
  },
  {
    name: 'fumble',
    note: 'a mistimed grab: the ball bounces off a body and the mistake is heard 14 m away',
    stopOn: { kind: 'fumble', lead: -6 },
    make: () => {
      const config = configFromPreset('default');
      // Seed changed from 3 with the contest rules: a body on the ball's line is no longer a
      // guaranteed fumble, so the old seed now plays out without one at all and the scenario had
      // nothing to show. This one fumbles early and in the open.
      return { config, seed: 9, controllers: pair('striker', 'ballchaser', config.teamSize), eyes: 3 };
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
          // Identical to `ping-self` down to the tick — the A/B is worthless otherwise.
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
          makeController('statue'),
          makeController('statue'),
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
  {
    name: 'bot-match',
    note: 'a real match: two bots (cyan) against two strikers, with P0’s belief drawn over its own blind pane',
    ticks: 480,
    make: () => {
      const config = configFromPreset('default');
      return { config, seed: 4, controllers: pair('bot', 'striker', config.teamSize), eyes: 0 };
    },
  },
];


/**
 * The hands suite: the feel of the four things a person actually does.
 *
 * Each one is a storyboard rather than a single frame — the keyframe generator steps them and
 * shoots several moments of one action — because feel is a thing that happens over 300 ms and a
 * single screenshot of it proves nothing. `spawnJitter` is zeroed so the geometry of a pass is
 * the same picture every time; everywhere else the jitter is what makes seeds differ.
 */
const RECEIVER: Vec2 = { x: 2.0, y: -1.0 };
/** The passer stands still long enough for the receiver to have walked into place. */
const PASS_DELAY = 2.6;

function handsConfig(): SimConfig {
  const config = configFromPreset('default');
  config.match.spawnJitter = 0;
  return config;
}

/**
 * The second rule set, in pictures.
 *
 * Three of them, and each one is a claim the report makes: a match plays; a settled strike goes
 * where it was aimed; the same strike made at a sprint does not.
 */
/** Where the receiver stands in the touch storyboards — the ball is struck at this point. */
const TOUCH_RECEIVER: Vec2 = { x: 4.2, y: 0 };
/** And where the man who gets it wrong is standing when the same ball is struck at him. */
const TOUCH_SPRINT: Vec2 = { x: 4.2, y: -5 };

function touchConfig(): SimConfig {
  const config = applyRuleset(configFromPreset('default'), 'touch');
  config.match.spawnJitter = 0;
  return config;
}

const TOUCH_SCENARIOS: Scenario[] = [
  {
    name: 'touch-match',
    note: 'the touch rule set, four bots: nobody can hold the ball, so every meeting with it is a strike',
    ticks: 420,
    make: () => {
      const config = applyRuleset(configFromPreset('default'), 'touch');
      return { config, seed: 4, controllers: pair('bot', 'bot', config.teamSize), eyes: 0 };
    },
  },
  {
    name: 'touch-strike',
    note: 'the strike, done properly: walk onto the line early, stop, and let it arrive on a loaded swing',
    ticks: 260,
    playerSlot: 2,
    hands: [
      // The passer: walks the two steps to the restart ball and strikes it at the receiver.
      { slot: 0, script: new TouchHand('settle', TOUCH_RECEIVER, 'passer', null, 2.6) },
      { slot: 2, script: new TouchHand('settle', null, 'settler', TOUCH_RECEIVER) },
    ],
    make: () => {
      const config = touchConfig();
      const setup = {
        config,
        seed: 20260825,
        controllers: [
          makeController('human'),
          makeController('statue'),
          makeController('human'),
          makeController('statue'),
        ],
        eyes: 2,
      };
      return setup;
    },
  },
  {
    name: 'touch-wild',
    note: 'the same ball, met at a full sprint: a ricochet rather than a shot, and the read-out says why',
    ticks: 260,
    playerSlot: 2,
    hands: [
      // The same pass, struck at the man rather than in front of him — and the only thing he
      // does differently is run at it instead of standing still and letting it come.
      { slot: 0, script: new TouchHand('settle', TOUCH_SPRINT, 'passer', null, 2.6) },
      { slot: 2, script: new TouchHand('charge', null, 'sprinter', null, 2.9) },
    ],
    make: () => {
      const config = touchConfig();
      return {
        config,
        seed: 20260825,
        controllers: [
          makeController('human'),
          makeController('statue'),
          makeController('human'),
          makeController('statue'),
        ],
        eyes: 2,
      };
    },
  },
];

SCENARIOS.push(...TOUCH_SCENARIOS);

const HAND_SCENARIOS: Scenario[] = [
  {
    name: 'hands-throw',
    note: 'the wind-up: hold, commit, release — the one action the concept asks to feel like a punch',
    ticks: 60,
    playerSlot: 0,
    hands: [{ slot: 0, script: new ThrowHand(0.5) }],
    make: () => ({
      config: handsConfig(),
      seed: 20260825,
      controllers: [makeController('human'), makeController('statue'), makeController('statue'), makeController('statue')],
      eyes: 0,
    }),
  },
  {
    name: 'hands-catch',
    note: 'a pass taken at the moment of closest approach — the catch as it is meant to work',
    ticks: 240,
    playerSlot: 2,
    hands: [
      { slot: 0, script: new ThrowHand(0.45, 'passer', RECEIVER, PASS_DELAY) },
      { slot: 2, script: new CatchHand('timed', 3.2, 'receiver', RECEIVER) },
    ],
    make: () => ({
      config: handsConfig(),
      seed: 20260825,
      controllers: [makeController('human'), makeController('statue'), makeController('human'), makeController('statue')],
      eyes: 2,
    }),
  },
  {
    name: 'hands-catch-early',
    note: 'the same pass, taken at a full sprint: it bounces off, and the read-out says why',
    ticks: 240,
    playerSlot: 2,
    hands: [
      { slot: 0, script: new ThrowHand(0.45, 'passer', RECEIVER, PASS_DELAY) },
      // The only way left to drop a pass: run at it. Catching itself needs no button.
      { slot: 2, script: new CatchHand('charge', 6.5, 'receiver', RECEIVER) },
    ],
    make: () => ({
      config: handsConfig(),
      seed: 20260825,
      controllers: [makeController('human'), makeController('statue'), makeController('human'), makeController('statue')],
      eyes: 2,
    }),
  },
  {
    name: 'hands-loud',
    note: 'the loudness dial, as the player sees it: sprint, walk, stand still',
    ticks: 360,
    playerSlot: 2,
    hands: [{ slot: 2, script: new LoudHand() }],
    make: () => ({
      config: handsConfig(),
      seed: 20260825,
      controllers: [makeController('statue'), makeController('statue'), makeController('human'), makeController('statue')],
      eyes: 2,
    }),
  },
  {
    name: 'hands-ping',
    note: 'the scream: one second of sight, bought with your exact position',
    ticks: 100,
    playerSlot: 2,
    hands: [{ slot: 2, script: new PingHand() }],
    make: () => ({
      config: handsConfig(),
      seed: 20260825,
      controllers: [makeController('statue'), makeController('statue'), makeController('human'), makeController('statue')],
      eyes: 2,
    }),
  },
];

SCENARIOS.push(...HAND_SCENARIOS);

/**
 * The AI suite, adapted into playground scenarios.
 *
 * They are defined once, in `sim/ai/scenarios.ts`, because the same setups have to serve three
 * consumers that must not be allowed to drift apart: the numbers (`npm run deception`), the
 * pictures (`npm run shots:handball`) and the hands (the dropdown in the playground). A trick
 * whose number and whose keyframe came from two different scripts proves nothing.
 */
for (const s of AI_SCENARIOS) {
  SCENARIOS.push({
    name: s.name,
    note: s.note,
    ticks: s.ticks,
    make: () => {
      const built = s.build();
      return { config: built.config, seed: s.seed, controllers: built.controllers, eyes: s.eyes };
    },
  });
}

export function findScenario(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario: ${name}`);
  return s;
}
