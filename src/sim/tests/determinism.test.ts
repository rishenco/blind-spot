/**
 * The determinism suite. If this file goes red, nothing else in the project means anything:
 * no replay, no keyframe, no bug report, no comparison of two bots.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { applyRuleset, defaultConfig } from '../config';
import { CONTROLLERS, roster } from '../controllers';
import { Match } from '../match';
import { newRecording, recordInput, replayTo } from '../replay';
import { hashNumbers } from '../sim';
import { idleIntent, type Intent } from '../types';

function playHashes(seed: number, a = 'striker', b = 'goalie', ticks = 2400, ruleset: 'classic' | 'touch' = 'classic'): number[] {
  const cfg = applyRuleset(defaultConfig(), ruleset);
  const m = new Match({ config: cfg, seed, controllers: roster(a, b, cfg.teamSize) });
  const hashes: number[] = [];
  for (let i = 0; i < ticks && !m.isOver; i++) {
    m.step();
    hashes.push(m.sim.hash());
  }
  return hashes;
}

/** The same scripted "human" every time — no wall clock, no unseeded randomness. */
function fakeHumanIntent(tick: number): Intent {
  const intent = idleIntent();
  const wobble = ((tick * 7919) % 200) / 100 - 1;
  intent.move = { x: 1, y: wobble };
  intent.moveMode = tick % 240 < 120 ? 'run' : 'walk';
  intent.aim = { x: 1, y: 0 };
  intent.catch = tick % 37 === 0;
  intent.ping = tick % 211 === 0;
  return intent;
}

describe('determinism', () => {
  it('replays a match bit for bit from the same seed', () => {
    const a = playHashes(20260825);
    const b = playHashes(20260825);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(100);
    expect(hashNumbers(a)).toBe(hashNumbers(b));
  });

  it('replays a TOUCH match bit for bit, and it is a different match from the classic one', () => {
    const a = playHashes(20260825, 'bot', 'bot', 1200, 'touch');
    const b = playHashes(20260825, 'bot', 'bot', 1200, 'touch');
    expect(hashNumbers(a)).toBe(hashNumbers(b));
    expect(hashNumbers(a)).not.toBe(hashNumbers(playHashes(20260825, 'bot', 'bot', 1200, 'classic')));
  });

  it('produces different matches from different seeds', () => {
    expect(hashNumbers(playHashes(1))).not.toBe(hashNumbers(playHashes(2)));
  });

  it('reproduces a match that had external (human) input, by re-simulating it', () => {
    const cfg = defaultConfig();
    const seed = 99;
    const names = ['human', 'striker', 'goalie', 'goalie'];
    const rec = newRecording(seed, cfg, names);
    const live = new Match({
      config: cfg,
      seed,
      controllers: names.map((n) => ({ name: n, make: CONTROLLERS[n]! })),
    });
    for (let tick = 1; tick <= 900; tick++) {
      const intent = fakeHumanIntent(tick);
      recordInput(rec, tick, 0, intent);
      live.setExternalIntent(0, intent);
      live.step();
    }
    rec.ticks = live.sim.state.tick;

    const replayed = replayTo(rec, rec.ticks);
    expect(replayed.sim.state.tick).toBe(live.sim.state.tick);
    expect(replayed.sim.hash()).toBe(live.sim.hash());
    expect(replayed.stats.players[0]!.pings).toBe(live.stats.players[0]!.pings);
    expect(replayed.stats.score).toEqual(live.stats.score);
  });

  it('scrubs to a middle tick and lands on exactly the state that tick had', () => {
    const cfg = defaultConfig();
    const rec = newRecording(4242, cfg, ['striker', 'striker', 'goalie', 'ballchaser']);
    const live = replayTo(rec, 1500);
    const midHash: number[] = [];
    const again = replayTo(rec, 1500, (m) => {
      if (m.sim.state.tick === 700) midHash.push(m.sim.hash());
    });
    expect(again.sim.hash()).toBe(live.sim.hash());
    const direct = replayTo(rec, 700);
    expect(midHash[0]).toBe(direct.sim.hash());
  });

  it('is not affected by the perception settings — hearing never moves the physics', () => {
    const cfg = defaultConfig();
    const m1 = new Match({ config: cfg, seed: 5, controllers: roster('statue', 'statue', cfg.teamSize) });
    for (let i = 0; i < 300; i++) m1.step();

    const cfg2 = defaultConfig();
    cfg2.perception.localizationSigmaPerMeter = 0.5;
    cfg2.perception.reactionLatencySec = 0.3;
    cfg2.perception.teamShare = true;
    const m2 = new Match({ config: cfg2, seed: 5, controllers: roster('statue', 'statue', cfg2.teamSize) });
    for (let i = 0; i < 300; i++) m2.step();

    expect(m1.sim.hash()).toBe(m2.sim.hash());
  });

  it('bans Math.random and wall-clock reads inside the simulation', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          // Comments are allowed to name the banned things — that is how the ban is explained.
          const src = readFileSync(path, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
          if (/Math\s*\.\s*random/.test(src)) offenders.push(`${path}: Math.random`);
          if (/Date\s*\.\s*now|performance\s*\.\s*now/.test(src)) offenders.push(`${path}: wall clock`);
        }
      }
    };
    walk('src/sim');
    expect(offenders).toEqual([]);
  });
});
