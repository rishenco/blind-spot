/**
 * The mixer's half of "one bus, two senses" (§1) — and the platform rules it has to survive.
 *
 * `AudioSystem` is deliberately thin: the director decides, the voices build, and what is left
 * here is a context and a gesture to start it with. So this file checks two things and not much
 * else. First, that it really is a *sibling* subscriber — the same bus, the same predicate, the
 * same events the paint system sees, with no emitter and no second path of its own. Second, that
 * every way a browser can refuse to make a sound ends in a counted drop rather than in a throw,
 * a warning, or a stalled frame.
 *
 * That second half is not defensive programming for its own sake. `tools/shoot.mjs` drives the
 * real game in a real browser that nobody has clicked, and fails the build on a single console
 * error or warning. A mixer that logged "autoplay blocked" once per footstep would either fail
 * that suite or teach everyone to ignore it.
 */

import { describe, expect, it, vi } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { hasNaN, peakInfo, rmsDb, type AudioBufferLike } from '../support/audioMetrics';
import { MAX_PEAK_DBFS } from '../support/audioSpec';
import { TEST_SAMPLE_RATE } from '../support/audioRender';
import { AudioSystem, DEFAULT_MASTER_GAIN } from '../../src/audio/system';
import { type ListenerState } from '../../src/audio/director';
import { createHeadlessGame } from '../../src/game/headless';
import { MAT_METAL } from '../../src/paint/materials';
import { PLAYER_EMITTER_ID, SoundBus, type SoundEmitSpec } from '../../src/paint/soundEvents';

const AT_ORIGIN: ListenerState = { x: 0, y: 0, z: 0, range: 18, emitter: PLAYER_EMITTER_ID };
const RENDER_SECONDS = 1.4;

/**
 * A real offline context wearing a chosen `state`.
 *
 * Everything below the state flag is genuine — real `createGain`, real biquads, a real render —
 * so what these tests exercise is the shipped graph and not a mock of it. Only the two things a
 * headless renderer cannot have are supplied: a browser's notion of "running", and a `resume`
 * that returns instead of blocking (`OfflineAudioContext.resume` waits for a render loop that a
 * test never starts, which would hang the suite rather than fail it).
 */
function contextIn(state: AudioContextState, target: OfflineAudioContext): BaseAudioContext {
  return new Proxy(target, {
    get(t, key) {
      if (key === 'state') return state;
      if (key === 'resume') return () => Promise.resolve();
      const value = Reflect.get(t, key) as unknown;
      return typeof value === 'function' ? value.bind(t) : value;
    },
  }) as unknown as BaseAudioContext;
}

function offline(seconds = RENDER_SECONDS): OfflineAudioContext {
  return new OfflineAudioContext(2, Math.ceil(seconds * TEST_SAMPLE_RATE), TEST_SAMPLE_RATE);
}

/** An audio system on a fresh bus, wired to a context in the given state. */
function mounted(
  state: AudioContextState = 'running',
  options: { masterGain?: number; seconds?: number } = {},
) {
  const bus = new SoundBus();
  const target = offline(options.seconds);
  let contexts = 0;
  let ears: ListenerState = AT_ORIGIN;
  const audio = new AudioSystem({
    bus,
    listener: () => ears,
    createContext: () => {
      contexts++;
      return contextIn(state, target);
    },
    ...(options.masterGain === undefined ? {} : { masterGain: options.masterGain }),
  });
  return {
    bus,
    audio,
    target,
    contexts: () => contexts,
    moveEars: (next: ListenerState) => {
      ears = next;
    },
    emit: (spec: SoundEmitSpec) => bus.emit(spec),
    render: (): Promise<AudioBufferLike> => target.startRendering(),
  };
}

const step = (x = 0, mat?: number): SoundEmitSpec => ({
  class: 'walk-step',
  x,
  y: 0,
  z: 0,
  source: 'player',
  emitter: PLAYER_EMITTER_ID,
  ...(mat === undefined ? {} : { mat }),
});

// ---------------------------------------------------------------------------

describe('the audio system is a subscriber, not an emitter (§1)', () => {
  /**
   * The shape of the commitment: one event goes onto the bus and *both* senses answer it. Not
   * "audio plays a sound and paint paints" as two coincidences — the same `SoundEvent` object
   * reaches both, which is what makes a sound with no paint impossible to produce rather than
   * merely unlikely.
   */
  it('sees the same event object every other subscriber sees', () => {
    const { bus, audio, emit } = mounted();
    const seen: unknown[] = [];
    bus.subscribe((event) => seen.push(event));
    audio.unlock();
    const event = emit(step());
    expect(seen).toEqual([event]);
    expect(audio.played).toBe(1);
  });

  /**
   * And it hears through the *bus's* predicate, not one of its own. A walk-step carries 11 m
   * (§3.3) into an 18 m ear, so the event's own carry is what closes the gate — the case a
   * second, listener-range-only copy of the rule would get wrong in exactly one direction.
   */
  it('hears an event exactly as far as the bus says it carries', () => {
    const { audio, emit } = mounted();
    audio.unlock();
    emit(step(10.9));
    expect(audio.played).toBe(1);
    emit(step(11.1));
    expect(audio.played).toBe(1);
    // The one it never heard is not a "silent drop": it never reached the mixer at all.
    expect(audio.droppedSilent).toBe(0);
  });

  /**
   * The ears are read when the event arrives, not pushed in once a tick — so a body that moved
   * between the frame boundary and the footfall is heard from where it actually was. It is the
   * same pose the paint system reads at the same moment, which is what keeps the two senses from
   * disagreeing about whether something was in range at all.
   */
  it('reads the ears at the moment of the sound, not at the frame boundary', () => {
    const { audio, emit, moveEars } = mounted();
    audio.unlock();
    emit(step(20));
    expect(audio.played).toBe(0);
    moveEars({ ...AT_ORIGIN, x: 15 });
    emit(step(20));
    expect(audio.played).toBe(1);
  });

  /** Disposal really unsubscribes — a mixer left on a dead bus is a leak with a heartbeat. */
  it('stops listening when disposed', () => {
    const { audio, emit } = mounted();
    audio.unlock();
    emit(step());
    audio.dispose();
    emit(step());
    expect(audio.played).toBe(1);
    // And off the bus, not merely without a context to play into: a system that still received
    // the event and dropped it for want of a context would pass the line above and leak.
    expect(audio.droppedSilent).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('what it builds, when the browser lets it', () => {
  it('renders a real voice through a real graph', async () => {
    const m = mounted();
    expect(m.audio.unlock()).toBe(true);
    expect(m.audio.running).toBe(true);
    m.emit(step(0, MAT_METAL));
    expect(m.audio.played).toBe(1);
    const buffer = await m.render();
    expect(hasNaN(buffer)).toBe(false);
    const peak = peakInfo(buffer);
    expect(peak.clipped).toBe(false);
    expect(peak.peakDb).toBeLessThan(MAX_PEAK_DBFS);
    // Something actually happened: a dropped voice and a built one both render finite silence.
    expect(rmsDb(buffer, undefined, 0, 0.3)).toBeGreaterThan(-60);
  });

  /**
   * Everything goes through one gain node. §3.8's Halo has to duck under events and a volume
   * slider has to exist, and both need a single point to hold — retrofitting one means finding
   * every `connect(ctx.destination)` written without it, so it is here from the first commit.
   * Halving it is exactly −6.02 dB, which is the assertion that nothing bypasses it.
   */
  it('sums everything through one master bus', async () => {
    const loud = mounted('running', { masterGain: DEFAULT_MASTER_GAIN });
    const quiet = mounted('running', { masterGain: DEFAULT_MASTER_GAIN / 2 });
    for (const m of [loud, quiet]) {
      m.audio.unlock();
      m.emit(step(0, MAT_METAL));
    }
    // Float32, because an `AudioParam` is: 0.85 stores as 0.85000002.
    expect(loud.audio.masterBus?.gain.value).toBeCloseTo(DEFAULT_MASTER_GAIN, 6);
    const a = rmsDb(await loud.render(), undefined, 0, 0.3);
    const b = rmsDb(await quiet.render(), undefined, 0, 0.3);
    expect(a - b).toBeCloseTo(20 * Math.log10(2), 5);
  });

  /** Built once. A context per gesture is a resource leak the browser eventually refuses. */
  it('builds one context however many times it is unlocked', () => {
    const m = mounted();
    for (let i = 0; i < 5; i++) m.audio.unlock();
    expect(m.contexts()).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('and when it does not', () => {
  /**
   * The headless case `tools/shoot.mjs` runs in: a page nobody clicked. Every audible event is
   * counted and dropped, `lastFailure` stays empty because nothing failed — this is the normal
   * state of a freshly loaded tab — and the console stays completely clean.
   */
  it('makes no sound and no noise before the first gesture', () => {
    const spy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    try {
      const { audio, emit } = mounted();
      for (let i = 0; i < 3; i++) emit(step());
      expect(audio.running).toBe(false);
      expect(audio.played).toBe(0);
      expect(audio.droppedSilent).toBe(3);
      expect(audio.lastFailure).toBeNull();
      expect(audio.masterBus).toBeNull();
      expect(spy.log).not.toHaveBeenCalled();
      expect(spy.warn).not.toHaveBeenCalled();
      expect(spy.error).not.toHaveBeenCalled();
    } finally {
      for (const s of Object.values(spy)) s.mockRestore();
    }
  });

  /**
   * A context the browser has handed back suspended. Nothing may be scheduled into it: a
   * suspended context swallows what it is given and then plays all of it at once on resume,
   * which is the autoplay bug everyone has heard — an inbox of footsteps arriving as a bang.
   * Asserted as a silent render, which is the only way to prove nothing was scheduled.
   */
  it('drops into a suspended context rather than scheduling into it', async () => {
    const m = mounted('suspended');
    // Not live yet: `resume`'s promise settles after `unlock` returns, so callers ask again on
    // the next gesture. Returning `true` here would let a caller stop asking, forever.
    expect(m.audio.unlock()).toBe(false);
    expect(m.audio.running).toBe(false);
    m.emit(step(0, MAT_METAL));
    expect(m.audio.played).toBe(0);
    expect(m.audio.droppedSilent).toBe(1);
    const buffer = await m.render();
    expect(rmsDb(buffer, undefined, 0, RENDER_SECONDS)).toBeLessThan(-100);
  });

  /** A platform with no WebAudio at all. Asked once, then never again. */
  it('asks once on a platform that has no audio, then stops asking', () => {
    const bus = new SoundBus();
    let asked = 0;
    const audio = new AudioSystem({
      bus,
      listener: () => AT_ORIGIN,
      createContext: () => {
        asked++;
        return null;
      },
    });
    for (let i = 0; i < 4; i++) expect(audio.unlock()).toBe(false);
    expect(asked).toBe(1);
    bus.emit(step());
    expect(audio.played).toBe(0);
    expect(audio.droppedSilent).toBe(1);
    expect(audio.lastFailure).toBeNull();
  });

  /** A constructor that throws is a platform, not a defect. Recorded as a value; never logged. */
  it('records a refusing constructor instead of throwing it at the frame', () => {
    const bus = new SoundBus();
    const audio = new AudioSystem({
      bus,
      listener: () => AT_ORIGIN,
      createContext: () => {
        throw new Error('NotAllowedError: audio is disabled');
      },
    });
    expect(() => audio.unlock()).not.toThrow();
    expect(audio.lastFailure).toContain('NotAllowedError');
    expect(() => bus.emit(step())).not.toThrow();
    expect(audio.droppedSilent).toBe(1);
  });

  /**
   * A graph that will not build must not take the frame down with it. Law 5 — movement stays
   * genuinely good — means the mixer is never on the critical path: a failed voice is one
   * missing sound, not a dropped frame and not a dead run.
   */
  it('survives a context that fails mid-graph', () => {
    const bus = new SoundBus();
    const target = offline();
    const broken = new Proxy(target, {
      get(t, key) {
        if (key === 'state') return 'running';
        if (key === 'createBufferSource') {
          return () => {
            throw new Error('out of memory');
          };
        }
        const value = Reflect.get(t, key) as unknown;
        return typeof value === 'function' ? value.bind(t) : value;
      },
    }) as unknown as BaseAudioContext;
    const audio = new AudioSystem({ bus, listener: () => AT_ORIGIN, createContext: () => broken });
    audio.unlock();
    expect(() => bus.emit(step())).not.toThrow();
    expect(audio.played).toBe(0);
    expect(audio.droppedSilent).toBe(1);
    expect(audio.lastFailure).toContain('out of memory');
  });
});

// ---------------------------------------------------------------------------

describe('mounted on the running game', () => {
  /**
   * The end-to-end shape: the real simulation, the real bus, the real events a player's own feet
   * and pings produce, through the real synthesis. Nothing in this test names a sound class — if
   * a later commit adds an emitter, this counts its output automatically, which is the property
   * that makes "a sound with no paint is impossible" checkable rather than aspirational.
   */
  it('makes a voice for every sound the simulation heard, and nothing else', async () => {
    const game = createHeadlessGame();
    const target = offline(2);
    const ears = (): ListenerState => {
      const p = game.sim.paint.listenerPosition;
      return {
        x: p.x,
        y: p.y,
        z: p.z,
        range: game.sim.paint.perception.hearingRange,
        emitter: PLAYER_EMITTER_ID,
      };
    };
    const audio = new AudioSystem({
      bus: game.sim.bus,
      listener: ears,
      createContext: () => contextIn('running', target),
    });
    expect(audio.unlock()).toBe(true);

    let heard = 0;
    game.sim.bus.subscribe((event) => {
      const p = game.sim.paint.listenerPosition;
      if (SoundBus.canHear(event, p.x, p.y, p.z, game.sim.paint.perception.hearingRange)) heard++;
    });

    game.input.hold('forward');
    for (let tick = 0; tick < 120; tick++) {
      if (tick === 30) game.input.tapKey('KeyQ');
      if (tick === 90) game.input.tapKey('KeyE');
      game.step();
    }

    // A run that emitted nothing would pass every count below, so the counts are pinned too:
    // one Q, one E, and the footfalls of a second of walking.
    expect(game.sim.bus.emitted).toBeGreaterThan(2);
    expect(heard).toBe(game.sim.bus.emitted);
    expect(audio.played).toBe(heard);
    expect(audio.droppedSilent).toBe(0);
    expect(audio.lastFailure).toBeNull();

    const buffer = await target.startRendering();
    expect(hasNaN(buffer)).toBe(false);
    expect(peakInfo(buffer).clipped).toBe(false);
    expect(rmsDb(buffer, undefined, 0, 1)).toBeGreaterThan(-60);
    audio.dispose();
  });
});
