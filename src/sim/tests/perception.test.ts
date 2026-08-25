/**
 * The perception contract. These tests are the reason the AI agent can trust the channel it is
 * given: they pin anonymity, range, error growth, latency, the team link and the wavefront.
 */
import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../config';
import { Perceiver } from '../perception';
import { Simulation } from '../sim';
import { BALL_ID, idleIntent, type Intent, type SoundEvent } from '../types';

const idleFor = (n: number): Intent[] => Array.from({ length: n }, () => idleIntent());

/** One noisy world: everyone sprints, so there are footsteps to hear. */
function noisyWorld(seed = 7, ticks = 120) {
  const cfg = defaultConfig();
  const sim = new Simulation(cfg, seed);
  const events: SoundEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const intents = idleFor(sim.playerCount);
    for (const [k, intent] of intents.entries()) {
      intent.move = { x: k % 2 === 0 ? 1 : -1, y: k < 2 ? 1 : -1 };
      intent.moveMode = 'run';
      intent.aim = intent.move;
    }
    events.push(...sim.step(intents).events);
  }
  return { cfg, sim, events };
}

describe('perception', () => {
  it('never names an opponent, and always names self, team-mates and the ball', () => {
    const { cfg, sim, events } = noisyWorld();
    const ears = new Perceiver(0, cfg, 7);
    const heard = ears.hear(sim.state, events);
    expect(heard.length).toBeGreaterThan(0);
    // Team 0 is ids 0 and 1; 2 and 3 are the opposition and must arrive nameless.
    for (const obs of heard) {
      expect([null, 0, 1, BALL_ID]).toContain(obs.sourceId);
    }
    expect(heard.some((o) => o.sourceId === null)).toBe(true);
    expect(heard.some((o) => o.sourceId === 0)).toBe(true);
  });

  it('names everyone when anonymity is switched off — the knob is a knob', () => {
    const { cfg, sim, events } = noisyWorld();
    cfg.perception.anonymousSources = false;
    const ears = new Perceiver(0, cfg, 7);
    for (const obs of ears.hear(sim.state, events)) expect(obs.sourceId).not.toBeNull();
  });

  it('drops what is out of earshot and keeps what is inside it', () => {
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 1);
    const ears = new Perceiver(0, cfg, 1);
    const me = sim.state.players[0]!.pos;
    const near: SoundEvent = {
      t: 0, tick: 0, kind: 'step-walk', pos: { x: me.x + 2, y: me.y }, intensity: 4, sourceId: 2,
    };
    const far: SoundEvent = {
      t: 0, tick: 0, kind: 'step-walk', pos: { x: me.x + 9, y: me.y }, intensity: 4, sourceId: 2,
    };
    const heard = ears.hear(sim.state, [near, far]);
    expect(heard.length).toBe(1);
    expect(heard[0]!.distance).toBeLessThan(4);
  });

  it('your own noise always reaches you, however quiet', () => {
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 1);
    const ears = new Perceiver(0, cfg, 1);
    const me = sim.state.players[0]!.pos;
    const own: SoundEvent = {
      t: 0, tick: 0, kind: 'step-walk', pos: { x: me.x, y: me.y }, intensity: 4, sourceId: 0,
    };
    const heard = ears.hear(sim.state, [own]);
    expect(heard.length).toBe(1);
    expect(heard[0]!.self).toBe(true);
    expect(heard[0]!.sigma).toBe(0);
  });

  it('localises worse with distance, and never worse than the cap', () => {
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 1);
    const ears = new Perceiver(0, cfg, 1);
    const me = sim.state.players[0]!.pos;
    const at = (dx: number) => ({
      t: 0, tick: 0, kind: 'fumble' as const, pos: { x: me.x + dx, y: me.y }, intensity: 20, sourceId: 3,
    });
    const near = ears.hear(sim.state, [at(2)])[0]!;
    const far = ears.hear(sim.state, [at(15)])[0]!;
    expect(far.sigma).toBeGreaterThan(near.sigma);
    expect(far.sigma).toBeLessThanOrEqual(cfg.perception.localizationSigmaCap);
    // Statistically the reported position of a far sound is off; the honest sigma says so.
    expect(near.sigma).toBeCloseTo(cfg.perception.localizationSigmaPerMeter * 2, 6);
  });

  it('hears a ping exactly — that is what makes it expensive', () => {
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 1);
    const ears = new Perceiver(1, cfg, 1);
    const ping: SoundEvent = {
      t: 0, tick: 0, kind: 'sonar', pos: { x: 3, y: -2 }, intensity: 40, sourceId: 2,
    };
    const heard = ears.hear(sim.state, [ping])[0]!;
    expect(heard.sigma).toBe(0);
    expect(heard.pos).toEqual({ x: 3, y: -2 });
    // ...but it still does not say who fired it.
    expect(heard.sourceId).toBeNull();
  });

  it('holds an event back for the reaction latency', () => {
    const cfg = defaultConfig();
    cfg.perception.reactionLatencySec = 0.25;
    const sim = new Simulation(cfg, 1);
    const ears = new Perceiver(0, cfg, 1);
    const me = sim.state.players[0]!.pos;
    ears.hear(sim.state, [
      { t: 0, tick: 0, kind: 'fumble', pos: { x: me.x + 1, y: me.y }, intensity: 20, sourceId: 3 },
    ]);
    let delivered = 0;
    for (let i = 0; i < 30; i++) {
      sim.step(idleFor(sim.playerCount));
      delivered += ears.frame(sim.state, sim.field).events.length;
      if (delivered > 0) {
        expect(sim.state.t).toBeGreaterThan(0.24);
        break;
      }
    }
    expect(delivered).toBe(1);
  });

  it('always hears the ball, as a continuous estimate rather than as marks', () => {
    const { cfg, sim, events } = noisyWorld();
    expect(events.some((e) => e.kind === 'ball-hum')).toBe(false);
    const ears = new Perceiver(0, cfg, 7);
    const frame = ears.frame(sim.state, sim.field);
    expect(frame.emitters.length).toBe(1);
    const ball = frame.emitters[0]!;
    expect(ball.kind).toBe('ball');
    const trueBall = sim.state.ball.pos;
    const err = Math.hypot(ball.pos.x - trueBall.x, ball.pos.y - trueBall.y);
    expect(err).toBeLessThan(3 * cfg.perception.localizationSigmaCap + 0.01);
  });

  it('cannot be averaged away: the ball error is correlated in time', () => {
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 3);
    const ears = new Perceiver(0, cfg, 3);
    const errs: number[] = [];
    for (let i = 0; i < 60; i++) {
      sim.step(idleFor(sim.playerCount));
      const em = ears.frame(sim.state, sim.field).emitters[0]!;
      errs.push(em.pos.x - sim.state.ball.pos.x);
    }
    // Consecutive errors are close to each other: the walk drifts, it does not resample.
    let jumps = 0;
    for (let i = 1; i < errs.length; i++) if (Math.abs(errs[i]! - errs[i - 1]!) > 0.2) jumps++;
    expect(jumps).toBeLessThan(errs.length / 4);
  });

  it('reveals a ping from near to far when the front travels, and all at once when it does not', () => {
    for (const [waveSpeed, expectMultiTick] of [[42, true], [Infinity, false]] as const) {
      const cfg = defaultConfig();
      cfg.ping.waveSpeed = waveSpeed;
      const sim = new Simulation(cfg, 9);
      const ears = new Perceiver(0, cfg, 9);
      const firing = idleFor(sim.playerCount);
      firing[0]!.ping = true;
      let ticksWithHits = 0;
      let firstBatchMax = 0;
      let lastBatchMax = 0;
      for (let i = 0; i < 60; i++) {
        const out = sim.step(i === 0 ? firing : idleFor(sim.playerCount));
        for (const ret of out.sonar) if (ret.owner === 0) ears.receiveSonar(ret);
        const frame = ears.frame(sim.state, sim.field);
        for (const ret of frame.sonar) {
          if (ret.hits.length === 0) continue;
          ticksWithHits++;
          const maxD = Math.max(
            ...ret.hits.map((h) => Math.hypot(h.pos.x - ret.origin.x, h.pos.y - ret.origin.y)),
          );
          if (ticksWithHits === 1) firstBatchMax = maxD;
          lastBatchMax = maxD;
        }
      }
      expect(ticksWithHits).toBeGreaterThan(0);
      if (expectMultiTick) {
        expect(ticksWithHits).toBeGreaterThan(1);
        expect(lastBatchMax).toBeGreaterThan(firstBatchMax);
      } else {
        expect(ticksWithHits).toBe(1);
      }
    }
  });

  it('passes team-mates their team-mates’ observations only when teamShare is on', () => {
    const cfg = defaultConfig();
    cfg.perception.teamShare = false;
    const sim = new Simulation(cfg, 12);
    const a = new Perceiver(0, cfg, 12);
    const b = new Perceiver(1, cfg, 12);
    const far = sim.state.players[3]!.pos;
    const ev: SoundEvent = {
      t: 0, tick: 0, kind: 'fumble', pos: { x: far.x, y: far.y }, intensity: 20, sourceId: 3,
    };
    const heardByA = a.hear(sim.state, [ev]);
    b.relay(sim.state, heardByA);
    sim.step(idleFor(sim.playerCount));
    const frame = b.frame(sim.state, sim.field);
    const relayed = frame.events.filter((e) => e.relayed);
    expect(relayed.length).toBe(heardByA.length);
    for (const r of relayed) expect(r.self).toBe(false);
  });

  it('keeps a listening bot from averaging the ball into a perfect fix', () => {
    // The honesty hole the research pass found: a continuously singing ball plus independent
    // per-frame noise at 60 Hz lets a consumer average dozens of samples and know the ball
    // better than any human could. The correlated error is what closes it, and this is the
    // number that proves the door stays shut.
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 21);
    const ears = new Perceiver(0, cfg, 21);
    // A still ball, a still listener: the friendliest possible case for an averager.
    sim.state.players[0]!.hasBall = false;
    sim.state.ball.carrier = null;
    sim.state.ball.pos = { x: 4, y: 3 };
    sim.state.ball.vel = { x: 0, y: 0 };
    const window = cfg.ai.observationMemory as number;
    const errors: number[] = [];
    for (let trial = 0; trial < 40; trial++) {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < window; i++) {
        sim.step(idleFor(sim.playerCount));
        const em = ears.frame(sim.state, sim.field).emitters[0]!;
        sx += em.pos.x;
        sy += em.pos.y;
      }
      errors.push(Math.hypot(sx / window - 4, sy / window - 3));
    }
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const d = Math.hypot(4 - sim.state.players[0]!.pos.x, 3 - sim.state.players[0]!.pos.y);
    const sigma = Math.min(cfg.perception.localizationSigmaCap, cfg.perception.localizationSigmaPerMeter * d);
    // Averaging `observationMemory` frames must not buy more than a modest fraction of sigma:
    // independent noise would have divided it by sqrt(12) ≈ 3.5.
    expect(mean).toBeGreaterThan(sigma * 0.3);
  });

  it('reports the volume a ping actually checked, not only what it found', () => {
    // Negative information: the belief layer has to be able to carve out empty space.
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 31);
    const ears = new Perceiver(0, cfg, 31);
    const firing = idleFor(sim.playerCount);
    firing[0]!.ping = true;
    let covered = 0;
    let maxSwept = 0;
    for (let i = 0; i < 60; i++) {
      const out = sim.step(i === 0 ? firing : idleFor(sim.playerCount));
      for (const ret of out.sonar) if (ret.owner === 0) ears.receiveSonar(ret);
      for (const ret of ears.frame(sim.state, sim.field).sonar) {
        expect(ret.sweptTo).toBeGreaterThanOrEqual(ret.sweptFrom);
        expect(ret.coneCos).toBe(-1); // the concept's 360° ping
        covered += ret.sweptTo - ret.sweptFrom;
        maxSwept = Math.max(maxSwept, ret.sweptTo);
      }
    }
    // The annuli tile the whole disc exactly once, out to the ping's range.
    expect(maxSwept).toBeCloseTo(cfg.ping.range, 5);
    expect(covered).toBeCloseTo(cfg.ping.range, 5);
  });

  it('tells the listener how far each kind of silence reaches', () => {
    const cfg = defaultConfig();
    cfg.perception.hearingScale = 1.5;
    const sim = new Simulation(cfg, 41);
    const ears = new Perceiver(0, cfg, 41);
    sim.step(idleFor(sim.playerCount));
    const frame = ears.frame(sim.state, sim.field);
    expect(frame.hearing['step-run']).toBeCloseTo(cfg.loudness['step-run'] * 1.5, 6);
    expect(frame.hearing['step-walk']).toBeLessThan(frame.hearing['step-run']);
  });

  it('shapes the hearing error like a cigar, not a disc', () => {
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 51);
    const ears = new Perceiver(0, cfg, 51);
    const me = sim.state.players[0]!.pos;
    let along = 0;
    let across = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const truth = { x: me.x + 8, y: me.y };
      const obs = ears.hear(sim.state, [
        { t: 0, tick: 0, kind: 'fumble', pos: truth, intensity: 14, sourceId: 3 },
      ])[0]!;
      along += (obs.pos.x - truth.x) ** 2;
      across += (obs.pos.y - truth.y) ** 2;
    }
    const alongSigma = Math.sqrt(along / n);
    const acrossSigma = Math.sqrt(across / n);
    expect(alongSigma).toBeGreaterThan(acrossSigma * 1.6);
    expect(acrossSigma).toBeGreaterThan(0);
  });

  it('hands a controller nothing that leads back into the world', () => {
    const cfg = defaultConfig();
    const sim = new Simulation(cfg, 2);
    const ears = new Perceiver(0, cfg, 2);
    sim.step(idleFor(sim.playerCount));
    const frame = ears.frame(sim.state, sim.field);
    // Structural: the frame is plain data. Mutating it must not touch the world.
    frame.self.pos.x = 999;
    expect(sim.state.players[0]!.pos.x).not.toBe(999);
    const json = JSON.stringify(frame);
    expect(json.includes('"players"')).toBe(false);
    expect(json.includes('"carrier"')).toBe(false);
    expect(json.includes('"pings"')).toBe(false);
  });
});
