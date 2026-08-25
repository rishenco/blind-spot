/**
 * The bot's own suite.
 *
 * Three things are being defended here, in descending order of how expensive it would be to
 * lose them:
 *
 *   1. **The decision layer cannot see the world.** Enforced by reading the imports of every
 *      file under `sim/ai/`, not by trusting anybody. This is the failure mode the brief warns
 *      about, and it is invisible on screen — a bot that peeks looks exactly like a bot that
 *      does not, only better.
 *   2. **Negative information never deletes the truth.** The classic occupancy-map bug: one
 *      over-confident "I checked there" and the bot spends the rest of the match hunting
 *      confidently in the wrong half. It reads as broken, not as mistaken.
 *   3. **Silence has the right shape.** The doughnut is the most game-specific thing the belief
 *      layer does; if it ever quietly becomes a disc, everything downstream still runs and only
 *      the behaviour gets worse.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Belief } from '../ai/belief';
import { Bot } from '../ai/bot';
import { gridMaskFor, OccupancyGrid } from '../ai/grid';
import { generateCandidates } from '../ai/policy';
import { deriveFeatures } from '../ai/features';
import { defaultConfig } from '../config';
import { makeController, roster } from '../controllers';
import { makeField } from '../field';
import { Match } from '../match';
import { makeRng } from '../../core/rng';
import type { ControllerContext } from '../types';

function context(self = 0): ControllerContext {
  const config = defaultConfig();
  const field = makeField(config.field);
  const size = config.teamSize;
  const team = self < size ? 0 : 1;
  const teammates: number[] = [];
  const opponents: number[] = [];
  for (let i = 0; i < size * 2; i++) {
    if (i === self) continue;
    ((i < size ? 0 : 1) === team ? teammates : opponents).push(i);
  }
  return { self, team, teammates, opponents, field, config, rng: makeRng(1) };
}

describe('the honesty boundary', () => {
  it('never lets the decision layer import the world', () => {
    // `ai/scenarios.ts` is the measuring harness, not the bot: it compares belief against truth
    // and is allowed to hold a Match. Everything else must be reachable only through frames.
    const allowed = new Set(['scenarios.ts']);
    const offenders: string[] = [];
    for (const entry of readdirSync('src/sim/ai', { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (allowed.has(entry.name)) continue;
      const src = readFileSync(`src/sim/ai/${entry.name}`, 'utf8');
      for (const [, spec] of src.matchAll(/from\s+'([^']+)'/g)) {
        if (/\/sim$|\/match$|\/perception$|\/replay$/.test(spec)) {
          offenders.push(`${entry.name} imports ${spec}`);
        }
      }
      if (/WorldState|WorldView|PlayerState\b/.test(src)) offenders.push(`${entry.name} names a world type`);
    }
    expect(offenders).toEqual([]);
  });

  it('plays a bot match bit for bit the same twice', () => {
    const play = (): number => {
      const cfg = defaultConfig();
      const m = new Match({ config: cfg, seed: 777, controllers: roster('bot', 'striker', cfg.teamSize) });
      for (let i = 0; i < 900 && !m.isOver; i++) m.step();
      return m.sim.hash();
    };
    expect(play()).toBe(play());
  });

  it('does not change the physics by adding a bot to the other team', () => {
    // Controllers have their own RNG streams; a bot must not consume the simulation's.
    const cfg = defaultConfig();
    const a = new Match({ config: cfg, seed: 31, controllers: roster('statue', 'statue', cfg.teamSize) });
    const b = new Match({
      config: defaultConfig(),
      seed: 31,
      controllers: [makeController('statue'), makeController('statue'), makeController('statue'), makeController('bot')],
    });
    for (let i = 0; i < 240; i++) {
      a.step();
      b.step();
    }
    // Only P3 differs, and only because it moves; P0..P2 and their sounds must be untouched.
    expect(a.sim.state.players[0]!.pos).toEqual(b.sim.state.players[0]!.pos);
    expect(a.sim.state.players[1]!.pos).toEqual(b.sim.state.players[1]!.pos);
  });
});

describe('the occupancy grid', () => {
  const cfg = defaultConfig();
  const field = makeField(cfg.field);
  const mask = gridMaskFor(field, 0.5, cfg.player.radius);

  it('keeps its mass and stays out of the creases', () => {
    const g = new OccupancyGrid(mask);
    g.setPoint({ x: 0, y: 0 }, 1);
    for (let i = 0; i < 40; i++) {
      g.predict({
        dt: 0.1,
        wStand: 0.3,
        wWalk: 0.35,
        wRun: 0.35,
        walkSpeed: cfg.player.walkSpeed,
        runSpeed: cfg.player.runSpeed,
        silentWalk: null,
        silentRun: null,
        floor: 0.01,
      });
    }
    let sum = 0;
    for (const v of g.p) sum += v;
    expect(sum).toBeCloseTo(1, 4);
    // Nobody may stand inside the crease, so no belief may either.
    expect(g.massInCircle(field.goalCentre[0]!, field.creaseRadius - 0.5)).toBe(0);
    expect(g.massInCircle(field.goalCentre[1]!, field.creaseRadius - 0.5)).toBe(0);
  });

  it('never lets a negative sweep make the truth impossible', () => {
    const g = new OccupancyGrid(mask);
    const truth = { x: 6, y: 4 };
    // Twenty full-pitch sweeps that all miss him. A p_detect of 1 would have annihilated the
    // cell twenty times over; the whole point of keeping it below 1 is that it cannot.
    for (let i = 0; i < 20; i++) {
      g.multiplyNegativeSector({ x: 0, y: 0 }, 0, 14, { x: 1, y: 0 }, -1, 0.9, [], 0);
      g.predict({
        dt: 0.1,
        wStand: 0.3,
        wWalk: 0.35,
        wRun: 0.35,
        walkSpeed: cfg.player.walkSpeed,
        runSpeed: cfg.player.runSpeed,
        silentWalk: null,
        silentRun: null,
        floor: 0.012,
      });
    }
    expect(g.massInCircle(truth, 2)).toBeGreaterThan(0);
  });

  it('grows silence as a doughnut, not as a disc', () => {
    // Silence does not delete belief, it *freezes* it: near the listener a moving body would
    // have been heard, so the belief there can only stand still, while beyond the audible radius
    // it spreads at walking and running speed. The result is a cloud that grows outwards — the
    // ring — and that is what these two assertions pin down.
    const listener = { x: 0, y: 0 };
    const audible = 5;
    const build = (withSilence: boolean): OccupancyGrid => {
      const g = new OccupancyGrid(mask);
      g.setPoint({ x: 4, y: 0 }, 0.6);
      const silent = new Float32Array(mask.spec.nx * mask.spec.ny);
      for (let iy = 0; iy < mask.spec.ny; iy++) {
        for (let ix = 0; ix < mask.spec.nx; ix++) {
          const x = mask.spec.ox + ix * mask.spec.cell - listener.x;
          const y = mask.spec.oy + iy * mask.spec.cell - listener.y;
          silent[iy * mask.spec.nx + ix] = Math.sqrt(x * x + y * y) < audible ? 0.15 : 1;
        }
      }
      for (let i = 0; i < 25; i++) {
        g.predict({
          dt: 0.1,
          wStand: 0.3,
          wWalk: 0.35,
          wRun: 0.35,
          walkSpeed: cfg.player.walkSpeed,
          runSpeed: cfg.player.runSpeed,
          silentWalk: withSilence ? silent : null,
          silentRun: withSilence ? silent : null,
          floor: 0.012,
        });
      }
      return g;
    };
    const quiet = build(true);
    const deaf = build(false);
    // Nothing moves near a listener without being heard, so the cloud spreads less overall...
    expect(quiet.effectiveArea()).toBeLessThan(deaf.effectiveArea());
    // ...and what spreading it does do happens on the far side: the belief is pushed outwards.
    expect(quiet.meanDistanceFrom(listener)).toBeGreaterThan(deaf.meanDistanceFrom(listener));
  });

  it('draws deterministic, stable samples', () => {
    const g = new OccupancyGrid(mask);
    g.setPoint({ x: -3, y: 2 }, 2);
    const a: { pos: { x: number; y: number }; weight: number }[] = [];
    const b: { pos: { x: number; y: number }; weight: number }[] = [];
    g.samples(7, a);
    g.samples(7, b);
    expect(a).toEqual(b);
    expect(a.length).toBe(7);
  });
});

describe('the belief layer', () => {
  it('moves onto a heard event and spreads again when the pitch goes quiet', () => {
    const cfg = defaultConfig();
    const m = new Match({ config: cfg, seed: 5, controllers: roster('bot', 'ballchaser', cfg.teamSize) });
    for (let i = 0; i < 200; i++) m.step();
    const bot = m.controllers[0] as Bot;
    const belief = bot.beliefState;
    expect(belief.opponents.length).toBe(cfg.teamSize);
    const areas = belief.opponents.map((t) => t.grid.effectiveArea());
    // A running opponent is heard, so at least one track must be sharper than the pitch.
    expect(Math.min(...areas)).toBeLessThan(cfg.field.width * cfg.field.height * 0.5);
  });

  it('keeps its opinion of the ball inside the honesty budget', () => {
    // `observationMemory` is the knob that bounds how much a bot may average the hum. Whatever
    // it is set to, the belief must not be dramatically better than one honest observation —
    // that is the one cheat no perception knob can catch. See `npm run honesty`.
    const cfg = defaultConfig();
    const m = new Match({ config: cfg, seed: 9, controllers: roster('bot', 'striker', cfg.teamSize) });
    let belief = 0;
    let raw = 0;
    let n = 0;
    for (let i = 0; i < 900 && !m.isOver; i++) {
      m.step();
      const bot = m.controllers[0] as Bot;
      const est = bot.beliefState.ball;
      const obs = m.frameOf(0)?.emitters.find((e) => e.kind === 'ball');
      if (!est || !obs) continue;
      const truth = m.sim.state.ball.pos;
      belief += Math.hypot(est.pos.x - truth.x, est.pos.y - truth.y);
      raw += Math.hypot(obs.pos.x - truth.x, obs.pos.y - truth.y);
      n++;
    }
    expect(n).toBeGreaterThan(100);
    expect(belief / n).toBeLessThan((raw / n) * 2.5);
    expect(belief / n).toBeGreaterThan((raw / n) * 0.5);
  });
});

describe('the policy', () => {
  it('always offers standing still and shutting up', () => {
    const ctx = context(0);
    const belief = new Belief(ctx);
    const f = deriveFeatures(belief, { x: 0, y: 0 }, 0, false, 0, 0, ctx.field, ctx.config);
    const candidates = generateCandidates({
      features: f,
      belief,
      cfg: ctx.config,
      pingCooldown: 0,
      callCooldown: 0,
      lastTag: null,
      decisionQuality: 1,
    });
    expect(candidates.some((c) => c.kind === 'hold')).toBe(true);
    expect(candidates.some((c) => c.kind === 'ping')).toBe(true);
    expect(candidates.some((c) => c.kind === 'feint')).toBe(true);
  });

  it('degrades the input, never the choice: decisionQuality only narrows the list', () => {
    const ctx = context(0);
    const belief = new Belief(ctx);
    const f = deriveFeatures(belief, { x: 0, y: 0 }, 0, false, 0, 0, ctx.field, ctx.config);
    const make = (q: number): number =>
      generateCandidates({ features: f, belief, cfg: ctx.config, pingCooldown: 0, callCooldown: 0, lastTag: null, decisionQuality: q })
        .length;
    expect(make(0.3)).toBeLessThan(make(1));
    // Holding is first in the list, so it survives any amount of narrowing.
    const narrow = generateCandidates({
      features: f,
      belief,
      cfg: ctx.config,
      pingCooldown: 0,
      callCooldown: 0,
      lastTag: null,
      decisionQuality: 0.1,
    });
    expect(narrow[0]!.kind).toBe('hold');
  });

  it('publishes a readable debug snapshot with belief grids and scored alternatives', () => {
    const cfg = defaultConfig();
    const m = new Match({ config: cfg, seed: 3, controllers: roster('bot', 'striker', cfg.teamSize) });
    for (let i = 0; i < 120; i++) m.step();
    const debug = (m.controllers[0] as Bot).debugSnapshot();
    expect(debug).toBeTruthy();
    expect(debug!.beliefs!.length).toBe(cfg.teamSize * 2);
    expect(debug!.beliefs!.some((b) => String(b.about).startsWith('mirror'))).toBe(true);
    expect(debug!.scores!.length).toBeGreaterThan(2);
    expect(debug!.scores![0]!.score).toBeGreaterThanOrEqual(debug!.scores![1]!.score);
  });
});
