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
    // The catch is a timed action now: one press opens the hands for `reachSec` and holding the
    // button does nothing after the first tick. The ball leaves at 0.5 s and covers the ten
    // metres between them in about 0.63 s, so the grab has to be made just before it lands.
    const catcher = scripted([{ for: 1.0 }, { catch: true }, { for: 4 }], 'catcher');
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

  it('never lets the ball leave the world, goal mouths included', () => {
    // The mouth is a hole in the wall: a ball that goes through it without a valid release is
    // not a goal, and there is nothing behind the net to stop it. It has to become a dead ball.
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const cfg = defaultConfig();
      cfg.match.durationSec = 60;
      const m = new Match({ config: cfg, seed, controllers: roster('striker', 'ballchaser', cfg.teamSize) });
      const limit = Math.hypot(m.field.halfWidth, m.field.halfHeight) + 1;
      while (!m.isOver) {
        m.step();
        const b = m.sim.state.ball;
        expect(Math.hypot(b.pos.x, b.pos.y)).toBeLessThan(limit);
      }
    }
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

/**
 * The fight for the ball.
 *
 * Each of these pins one contest rule to the smallest situation that can break it, and each one
 * also pins its OFF switch: the rule tournament is only meaningful if `contest.*.enabled = false`
 * really does restore the old behaviour, so a variant row measures the rule and not a bug.
 */
describe('the fight for the ball', () => {
  /** Puts two bodies at chosen spots with the ball in P0's hands, everything else neutral. */
  function rigged(mutate: (c: ReturnType<typeof defaultConfig>) => void) {
    const cfg = defaultConfig();
    cfg.teamSize = 1;
    cfg.match.spawnJitter = 0;
    cfg.match.carryTimeoutSec = 0;
    cfg.contest.steal.enabled = false;
    cfg.contest.tackle.enabled = false;
    cfg.contest.collision.enabled = false;
    cfg.contest.block.mode = 'always';
    mutate(cfg);
    return new Simulation(cfg, 5);
  }

  const place = (sim: Simulation, a: { x: number; y: number }, b: { x: number; y: number }): void => {
    sim.state.players[0]!.pos = { ...a };
    sim.state.players[1]!.pos = { ...b };
    sim.state.ball.pos = { x: a.x + 0.85, y: a.y };
  };

  it('gives the ball to an opponent who stays close for long enough, and not before', () => {
    const sim = rigged((c) => {
      c.contest.steal.enabled = true;
    });
    const hold = sim.config.contest.steal.holdSec;
    place(sim, { x: 0, y: 0 }, { x: 0.9, y: 0 });
    expect(sim.state.ball.carrier).toBe(0);
    // Short of the hold time: still his.
    run(sim, Math.floor((hold - 0.06) * 60), () => idleFor(2));
    expect(sim.state.ball.carrier).toBe(0);
    let out = sim.step(idleFor(2));
    for (let i = 0; i < 8 && sim.state.ball.carrier === 0; i++) out = sim.step(idleFor(2));
    expect(sim.state.ball.carrier).toBe(1);
    // And it is a sound, not a silent teleport — a slap at the thief's feet.
    expect(out.events.some((e) => e.kind === 'steal')).toBe(true);
  });

  it('never steals when the rule is off, however long the two stand together', () => {
    const sim = rigged(() => {});
    place(sim, { x: 0, y: 0 }, { x: 0.9, y: 0 });
    run(sim, 600, () => idleFor(2));
    expect(sim.state.ball.carrier).toBe(0);
  });

  it('resets the steal clock the moment the thief drops out of range', () => {
    const sim = rigged((c) => {
      c.contest.steal.enabled = true;
      c.contest.steal.radius = 1;
    });
    place(sim, { x: 0, y: 0 }, { x: 1.2, y: 0 });
    // Walk him in and straight out again, twice as long as the hold in total.
    for (let i = 0; i < 120; i++) {
      sim.state.players[1]!.pos = { x: i % 20 < 10 ? 1.2 : 4, y: 0 };
      sim.step(idleFor(2));
    }
    expect(sim.state.ball.carrier).toBe(0);
  });

  it('puts a body on the floor when a dive connects, and the diver on the floor when it does not', () => {
    const sim = rigged((c) => {
      c.contest.tackle.enabled = true;
    });
    place(sim, { x: 0, y: 0 }, { x: 2.5, y: 0 });
    const dive = idleFor(2);
    dive[1]!.dive = true;
    dive[1]!.move = { x: -1, y: 0 };
    dive[1]!.aim = { x: -1, y: 0 };
    sim.step(dive);
    let hit = false;
    for (let i = 0; i < 40; i++) {
      const out = sim.step(idleFor(2));
      if ((out.contests ?? []).some((c) => c.kind === 'tackle')) hit = true;
    }
    expect(hit).toBe(true);
    expect(sim.state.players[0]!.downT).toBeGreaterThan(0);
    // The tackled carrier loses the ball, loudly.
    expect(sim.state.ball.carrier).toBeNull();

    const missSim = rigged((c) => {
      c.contest.tackle.enabled = true;
      c.contest.tackle.missPenalty = 2;
    });
    place(missSim, { x: 0, y: 0 }, { x: 9, y: 0 });
    const wild = idleFor(2);
    wild[1]!.dive = true;
    wild[1]!.move = { x: 0, y: 1 };
    wild[1]!.aim = { x: 0, y: 1 };
    missSim.step(wild);
    let missed = false;
    for (let i = 0; i < 40; i++) {
      const out = missSim.step(idleFor(2));
      if ((out.contests ?? []).some((c) => c.kind === 'tackle-miss')) missed = true;
    }
    expect(missed).toBe(true);
    expect(missSim.state.ball.carrier).toBe(0);
    expect(missSim.state.players[1]!.recoverT).toBeGreaterThan(missSim.config.dive.recoverySec);
  });

  it('stops bodies passing through each other once contact is on, and rings out when it is hard', () => {
    const sim = rigged((c) => {
      c.contest.collision.enabled = true;
    });
    place(sim, { x: -3, y: 0 }, { x: 0, y: 0 });
    let heard = false;
    let staggered = false;
    for (let i = 0; i < 90; i++) {
      const intents = idleFor(2);
      intents[0]!.move = { x: 1, y: 0 };
      intents[0]!.moveMode = 'run';
      intents[0]!.aim = { x: 1, y: 0 };
      const out = sim.step(intents);
      if ((out.contests ?? []).some((c) => c.kind === 'collision')) heard = true;
      if (sim.state.players[0]!.staggerT > 0) staggered = true;
    }
    expect(heard).toBe(true);
    expect(staggered).toBe(true);
    const gap = Math.hypot(
      sim.state.players[0]!.pos.x - sim.state.players[1]!.pos.x,
      sim.state.players[0]!.pos.y - sim.state.players[1]!.pos.y,
    );
    expect(gap).toBeGreaterThanOrEqual(sim.config.player.radius * 2 - 1e-6);
    // The default rule is a screen, not a mugging: he is stopped, staggered and loud, and he
    // keeps the ball. Spilling it as well measured at sixteen fumbles a minute.
    expect(sim.state.ball.carrier).toBe(0);

    // The switch still works the other way, because the tournament needs both rows.
    const spill = rigged((c) => {
      c.contest.collision.enabled = true;
      c.contest.collision.dropsBall = true;
    });
    place(spill, { x: -3, y: 0 }, { x: 0, y: 0 });
    for (let i = 0; i < 90; i++) {
      const intents = idleFor(2);
      intents[0]!.move = { x: 1, y: 0 };
      intents[0]!.moveMode = 'run';
      intents[0]!.aim = { x: 1, y: 0 };
      spill.step(intents);
    }
    // He loses it. Who ends up with it is another matter — catching is automatic now, so the
    // body he ran into simply picks the loose ball up off the floor.
    expect(spill.state.ball.carrier).not.toBe(0);
  });

  it('shrinks the reach as the ball speeds up: a pass is caught off the line, a shot is not', () => {
    // The rule that replaced the catch button. Catching is automatic, so the skill is no longer
    // *when* you press but *where you are standing*: the faster the ball, the smaller the area
    // it can be taken in. Same geometry, same offset, two release speeds.
    const attempt = (charge: number, offset: number): boolean => {
      const cfg = defaultConfig();
      cfg.teamSize = 1;
      cfg.match.spawnJitter = 0;
      cfg.match.carryTimeoutSec = 0;
      cfg.contest.steal.enabled = false;
      cfg.contest.tackle.enabled = false;
      cfg.contest.collision.enabled = false;
      const sim = new Simulation(cfg, 7);
      sim.state.players[0]!.pos = { x: -6, y: 0 };
      sim.state.players[1]!.pos = { x: 4, y: offset };
      sim.state.ball.pos = { x: -5.15, y: 0 };
      const hold = idleFor(2);
      hold[0]!.charge = true;
      hold[0]!.aim = { x: 1, y: 0 };
      run(sim, Math.max(2, Math.round(charge * 60)), () => hold);
      for (let i = 0; i < 200; i++) {
        const intents = idleFor(2);
        intents[0]!.aim = { x: 1, y: 0 };
        sim.step(intents);
        if (sim.state.ball.carrier === 1) return true;
        if (sim.state.players[1]!.lastCatchFail) return false;
        // Once it is behind him the question is answered: what it does off the far wall a second
        // later is a different ball.
        if (sim.state.ball.pos.x > sim.state.players[1]!.pos.x + 1) return false;
      }
      return false;
    };
    // A lob, taken a metre off its line.
    expect(attempt(0, 1.0)).toBe(true);
    // A full-power shot at the same offset: out of reach at that speed.
    expect(attempt(0.6, 1.0)).toBe(false);
    // The same shot straight at him is caught — he is in front of it.
    expect(attempt(0.6, 0)).toBe(true);
  });

  it('catches with no button at all, and drops it only at a full sprint', () => {
    const takeIt = (sprint: boolean): { caught: boolean; fail: string | null } => {
      const cfg = defaultConfig();
      cfg.teamSize = 1;
      cfg.match.spawnJitter = 0;
      cfg.match.carryTimeoutSec = 0;
      cfg.contest.steal.enabled = false;
      cfg.contest.tackle.enabled = false;
      cfg.contest.collision.enabled = false;
      const sim = new Simulation(cfg, 4);
      sim.state.players[0]!.pos = { x: -6, y: 0 };
      sim.state.players[1]!.pos = { x: 6, y: 0 };
      sim.state.ball.pos = { x: -5.15, y: 0 };
      const hold = idleFor(2);
      hold[0]!.charge = true;
      hold[0]!.aim = { x: 1, y: 0 };
      run(sim, 30, () => hold);
      for (let i = 0; i < 200; i++) {
        const intents = idleFor(2);
        intents[0]!.aim = { x: 1, y: 0 };
        if (sprint) {
          // Running at the ball at full speed: the one way left to drop a catch.
          intents[1]!.move = { x: -1, y: 0 };
          intents[1]!.moveMode = 'run';
          intents[1]!.aim = { x: -1, y: 0 };
        }
        sim.step(intents);
        if (sim.state.ball.carrier === 1) return { caught: true, fail: null };
        const fail = sim.state.players[1]!.lastCatchFail;
        if (fail) return { caught: false, fail };
      }
      return { caught: false, fail: null };
    };
    // Nobody pressed anything, and it is in his hands.
    expect(takeIt(false).caught).toBe(true);
    expect(takeIt(true)).toEqual({ caught: false, fail: 'sprint' });
  });

  it('never takes the ball or lets it past in silence', () => {
    // Two different silent punishments, both fixed: a steal that nobody could hear, and a ball
    // that slipped past a body which had just pressed a button and got nothing back.
    const sim = rigged((c) => {
      c.contest.steal.enabled = true;
    });
    place(sim, { x: 0, y: 0 }, { x: 0.9, y: 0 });
    let stealHeard = false;
    for (let i = 0; i < 120; i++) {
      const out = sim.step(idleFor(2));
      if (out.events.some((e) => e.kind === 'steal')) stealHeard = true;
    }
    expect(stealHeard).toBe(true);

    const past = rigged((c) => {
      c.contest.block.mode = 'speed';
      // Shrink the reach hard, so there is a band where the ball touches the body and is still
      // uncatchable — that band is what this sound exists for.
      c.catching.catchSpeedSpan = 14;
      c.contest.block.minStop = 0; // make the pass-through certain, so the test is about the sound
      c.contest.block.speedSpan = 1;
    });
    past.state.players[0]!.pos = { x: -6, y: 0 };
    // Grazing him, not hitting him: at full speed his reach is smaller than his own body, so the
    // ball touches him without ever being catchable — which is the case this sound exists for.
    past.state.players[1]!.pos = { x: 4, y: 0.42 };
    past.state.ball.pos = { x: -5.15, y: 0 };
    const charge = idleFor(2);
    charge[0]!.charge = true;
    charge[0]!.aim = { x: 1, y: 0 };
    run(past, 45, () => charge);
    let nearHeard = false;
    for (let i = 0; i < 200; i++) {
      const intents = idleFor(2);
      intents[0]!.aim = { x: 1, y: 0 };
      const out = past.step(intents);
      if (out.events.some((e) => e.kind === 'ball-near')) {
        nearHeard = true;
        // And the body it went past is told why, on the same tick. (Read here rather than at the
        // end of the loop: the ball comes off the far wall and can be picked up later, which
        // clears the flag — as it should.)
        expect(past.state.players[1]!.lastCatchFail).toBe('past');
        break;
      }
    }
    expect(nearHeard).toBe(true);
  });

  it('rings out when a runner changes direction hard, and stays quiet when a walker does', () => {
    const cut = (mode: 'run' | 'walk'): boolean => {
      const cfg = defaultConfig();
      cfg.teamSize = 1;
      const sim = new Simulation(cfg, 3);
      sim.state.players[0]!.pos = { x: 0, y: 0 };
      let brakes = 0;
      const leg = (dir: { x: number; y: number }, ticks: number) => {
        for (let i = 0; i < ticks; i++) {
          const intents = idleFor(2);
          intents[0]!.move = dir;
          intents[0]!.moveMode = mode;
          intents[0]!.aim = dir;
          const out = sim.step(intents);
          if (out.events.some((e) => e.kind === 'brake' && e.sourceId === 0)) brakes++;
        }
      };
      leg({ x: 1, y: 0 }, 70);
      leg({ x: 0, y: 1 }, 70);
      return brakes > 0;
    };
    expect(cut('run')).toBe(true);
    // Walking into a corner is how a body arrives anywhere quietly; it must stay free.
    expect(cut('walk')).toBe(false);
  });
});
