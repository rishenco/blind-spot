/** The rules of the concept, each one pinned by the smallest situation that can break it. */
import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../config';
import { roster, scripted } from '../controllers';
import { insideCrease } from '../field';
import { Match } from '../match';
import { Simulation } from '../sim';
import { idleIntent, type Intent } from '../types';

/** Runs the simulation with a fixed intent for everyone (handy for a one-body experiment). */
function run(sim: Simulation, ticks: number, make: (tick: number) => Intent[]): void {
  for (let i = 0; i < ticks; i++) sim.step(make(i));
}

const idleFor = (n: number): Intent[] => Array.from({ length: n }, () => idleIntent());

describe('field and rules', () => {
  it('keeps every body out of both creases, however hard it runs at one', () => {
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 1);
    const n = sim.playerCount;
    run(sim, 600, () => {
      const intents = idleFor(n);
      for (const intent of intents) {
        intent.move = { x: 1, y: 0 };
        intent.moveMode = 'run';
        intent.aim = { x: 1, y: 0 };
      }
      return intents;
    });
    for (const p of sim.state.players) {
      expect(insideCrease(sim.field, p.pos)).toBe(false);
      expect(Math.abs(p.pos.x)).toBeLessThanOrEqual(sim.field.halfWidth);
    }
  });

  it('bounces the ball off a wall and says so out loud', () => {
    const cfg = defaultConfig();
    cfg.teamSize = 1;
    const sim = new Simulation(cfg, 2);
    // Aim a body at the long wall and throw: the wall is the only thing it can hit.
    const intents = idleFor(2);
    intents[0]!.aim = { x: 0, y: 1 };
    intents[0]!.charge = true;
    run(sim, 40, () => intents);
    const release = idleFor(2);
    release[0]!.aim = { x: 0, y: 1 };
    const out = sim.step(release);
    expect(out.events.some((e) => e.kind === 'throw')).toBe(true);
    let bounced = false;
    for (let i = 0; i < 120; i++) {
      const o = sim.step(idleFor(2));
      if (o.events.some((e) => e.kind === 'ball-wall')) bounced = true;
    }
    expect(bounced).toBe(true);
    expect(Math.abs(sim.state.ball.pos.y)).toBeLessThanOrEqual(sim.field.halfHeight);
  });

  it('scores a goal thrown from outside the crease and restarts with the conceding team', () => {
    const cfg = defaultConfig();
    cfg.teamSize = 1;
    const sim = new Simulation(cfg, 3);
    // In 1v1 both bodies line up on y = 0, so the opponent stands in the shooting lane. Step it
    // aside: this test is about the goal rule, not about deflections.
    sim.state.players[1]!.pos = { x: 4.2, y: 5 };
    // Player 0 holds the ball at kickoff; wind up fully and fire at the far goal.
    const hold = idleFor(2);
    hold[0]!.aim = { x: 1, y: 0 };
    hold[0]!.charge = true;
    run(sim, 40, () => hold);
    const fire = idleFor(2);
    fire[0]!.aim = { x: 1, y: 0 };
    sim.step(fire);
    let goals = 0;
    for (let i = 0; i < 200 && goals === 0; i++) goals += sim.step(idleFor(2)).goals.length;
    expect(goals).toBe(1);
    expect(sim.state.score[0]).toBe(1);
    expect(sim.state.phase).toBe('restart');
    // The team that conceded restarts with the ball.
    expect(sim.state.restartTeam).toBe(1);
    expect(sim.state.players[1]!.hasBall).toBe(true);
  });

  it('hands a ball that dies inside a crease to the defending team', () => {
    const cfg = defaultConfig();
    cfg.teamSize = 1;
    cfg.field.creaseBallTimeoutSec = 0.5;
    const sim = new Simulation(cfg, 4);
    // Park the ball inside team 1's crease by hand — this is a rules test, not a physics one.
    sim.state.players[0]!.hasBall = false;
    sim.state.ball.carrier = null;
    sim.state.ball.pos = { x: sim.field.halfWidth - 1.5, y: 0.4 };
    sim.state.ball.vel = { x: 0, y: 0 };
    let turnovers = 0;
    for (let i = 0; i < 120; i++) turnovers += sim.step(idleFor(2)).turnovers.length;
    expect(turnovers).toBe(1);
    expect(sim.state.ball.carrier).toBe(1);
  });

  it('tells a pass from an interception', () => {
    const cfg = defaultConfig();
    cfg.teamSize = 2;
    // Team 0: P0 winds up and throws straight at P1, who is told to catch.
    const throwRight = scripted([
      { for: 0.5, charge: true, aim: [0, 1] },
      { for: 4 },
    ], 'thrower');
    const catcher = scripted([{ for: 0.55 }, { for: 4, catch: true }], 'catcher');
    const m = new Match({
      config: cfg,
      seed: 11,
      controllers: [
        { name: 'thrower', make: throwRight },
        { name: 'catcher', make: catcher },
        ...roster('statue', 'statue', 1),
      ],
    });
    for (let i = 0; i < 240; i++) m.step();
    const p1 = m.stats.players[1]!;
    // P0 starts at (-6.8, -5) and P1 at (-6.8, +5): a throw along +y goes straight to a teammate.
    expect(p1.catches + p1.fumbles).toBeGreaterThan(0);
    expect(p1.interceptions).toBe(0);
  });

  it('runs 1v1, 2v2 and 3v3 without leaving the pitch', () => {
    for (const size of [1, 2, 3]) {
      const cfg = defaultConfig();
      cfg.teamSize = size;
      cfg.match.durationSec = 20;
      const m = new Match({ config: cfg, seed: 1000 + size, controllers: roster('striker', 'ballchaser', size) });
      m.run();
      expect(m.stats.players.length).toBe(size * 2);
      for (const p of m.sim.state.players) {
        expect(Math.abs(p.pos.x)).toBeLessThanOrEqual(m.field.halfWidth + 1e-6);
        expect(Math.abs(p.pos.y)).toBeLessThanOrEqual(m.field.halfHeight + 1e-6);
      }
      expect(m.isOver).toBe(true);
    }
  });
});
