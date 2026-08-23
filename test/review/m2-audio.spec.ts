/**
 * M2 ADVERSARIAL REVIEW — the synthesised audio engine (engine-plan §8).
 *
 * Contract under test:
 *   audio.ts:5   "Audio is a CONSUMER OF THE EVENT BUS, never a second truth… If you can hear it,
 *                an event exists that says so — and that same event paints the world."
 *   vision §1.2  "The system never lies" — the ears and the dots must agree.
 *   vision §3.3  landing paints 8 m at the threshold and 14 m at the top of the scale, so a 2 m
 *                step-down and an 8 m plunge must not sound alike (the claimed M2 fix).
 *   vision §3.8  "You always know exactly how loud you are."
 *
 * WebAudio does not exist in node, so these probes install a recording stub as
 * `globalThis.AudioContext` and read back the graph the engine actually built. The stub is torn
 * down in `finally`; nothing under src/ is touched.
 *
 * Labels: PIN = passes today, pins verified-correct behaviour. BUG = fails today, on purpose.
 */

import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/core/audio.js';
import { EV } from '../../src/core/const.js';
import { EventBus, type SoundClass, type SoundEvent } from '../../src/core/events.js';

// ------------------------------------------------------------------------------------------
// A recording WebAudio stub — enough surface for audio.ts, and it remembers every value set.
// ------------------------------------------------------------------------------------------

interface Rec {
  nodes: string[];
  /** `<node>.<param>.<op>` -> the values passed, in order. */
  calls: Array<[string, number]>;
  starts: Array<[string, number, number | undefined]>;
}

function makeStub(rec: Rec) {
  let n = 0;
  const param = (owner: string, name: string) => {
    const p = {
      _v: 0,
      get value() {
        return p._v;
      },
      set value(x: number) {
        p._v = x;
        rec.calls.push([`${owner}.${name}.value`, x]);
      },
      setValueAtTime: (x: number) => rec.calls.push([`${owner}.${name}.setValueAtTime`, x]),
      linearRampToValueAtTime: (x: number) => rec.calls.push([`${owner}.${name}.linearRamp`, x]),
      exponentialRampToValueAtTime: (x: number) => rec.calls.push([`${owner}.${name}.expRamp`, x]),
      setTargetAtTime: (x: number) => rec.calls.push([`${owner}.${name}.setTarget`, x]),
    };
    return p;
  };
  const connectable = <T extends object>(o: T): T & { connect: (d: unknown) => unknown } =>
    Object.assign(o, { connect: (d: unknown) => d });

  class StubCtx {
    state = 'running';
    currentTime = 0;
    sampleRate = 48000;
    destination = {};
    createGain() {
      const id = `gain${n++}`;
      rec.nodes.push(id);
      return connectable({ gain: param(id, 'gain') });
    }
    createBufferSource() {
      const id = `src${n++}`;
      rec.nodes.push(id);
      return connectable({
        buffer: null as unknown,
        playbackRate: param(id, 'rate'),
        start: (t: number, off?: number) => rec.starts.push([id, t, off]),
        stop: () => undefined,
      });
    }
    createBiquadFilter() {
      const id = `biq${n++}`;
      rec.nodes.push(id);
      return connectable({ type: '', frequency: param(id, 'freq'), Q: param(id, 'Q') });
    }
    createOscillator() {
      const id = `osc${n++}`;
      rec.nodes.push(id);
      return connectable({
        type: '',
        frequency: param(id, 'freq'),
        start: (t: number) => rec.starts.push([id, t, undefined]),
        stop: () => undefined,
      });
    }
    createBuffer(_ch: number, len: number) {
      return { getChannelData: () => new Float32Array(len) };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  return StubCtx;
}

/** Run `body` with a stubbed AudioContext and hand it the recording. */
function withAudio(body: (bus: EventBus, engine: AudioEngine, rec: Rec) => void): void {
  const rec: Rec = { nodes: [], calls: [], starts: [] };
  const g = globalThis as { AudioContext?: unknown };
  const had = 'AudioContext' in g;
  const prev = g.AudioContext;
  g.AudioContext = makeStub(rec);
  const engine = new AudioEngine();
  const bus = new EventBus();
  try {
    engine.resume();
    engine.attach(bus);
    rec.nodes.length = 0;
    rec.calls.length = 0;
    rec.starts.length = 0;
    body(bus, engine, rec);
  } finally {
    engine.dispose();
    if (had) g.AudioContext = prev;
    else delete g.AudioContext;
  }
}

const ev = (cls: SoundClass, over: Partial<SoundEvent> = {}) =>
  ({ class: cls, source: 'self' as const, x: 0, y: 0, z: 0, ...over });

/**
 * Everything the engine SET, as a comparable fingerprint. Node serial numbers are stripped —
 * two events build fresh nodes, and only the VALUES on them are the sound.
 */
const fingerprint = (rec: Rec): string =>
  rec.calls.map(([k, v]) => `${k.replace(/\d+/, '')}=${v.toFixed(6)}`).join('|');

// ==========================================================================================
// PIN — the bus is the only input, and the landing round-trip works
// ==========================================================================================

describe('PIN · audio is a pure consumer of the bus (engine-plan §8)', () => {
  it('is a harmless no-op where WebAudio does not exist', () => {
    const g = globalThis as { AudioContext?: unknown; webkitAudioContext?: unknown };
    const had = 'AudioContext' in g;
    const prev = g.AudioContext;
    delete g.AudioContext;
    delete g.webkitAudioContext;
    try {
      const engine = new AudioEngine();
      const bus = new EventBus();
      expect(engine.available).toBe(false);
      expect(engine.running).toBe(false);
      engine.resume(); // must not throw
      engine.attach(bus);
      for (const c of ['walkStep', 'sprintStep', 'landing', 'slide'] as SoundClass[]) bus.emit(ev(c));
      expect(engine.played).toBe(0);
      expect(bus.emitted).toBe(4); // the bus is unaffected by audio being absent
      engine.detach();
      engine.dispose();
      engine.setMuted(true);
      engine.toggleMute();
    } finally {
      if (had) g.AudioContext = prev;
    }
  });

  it('sounds exactly the M2 self classes and silently ignores the rest', () => {
    withAudio((bus, engine) => {
      for (const c of ['crouchStep', 'walkStep', 'sprintStep', 'landing', 'slide'] as SoundClass[]) {
        bus.emit(ev(c));
      }
      expect(engine.played).toBe(5);
      // Classes whose milestone has not landed yet are ignored, not faked.
      for (const c of ['qPing', 'ePing', 'detonation', 'propKnock', 'beaconHum'] as SoundClass[]) {
        bus.emit(ev(c));
      }
      expect(engine.played).toBe(5);
      // And a sound that is not yours is not played (M3 owns delivery).
      bus.emit({ ...ev('sprintStep'), source: 'dog' });
      expect(engine.played).toBe(5);
    });
  });

  it('attach() replaces its subscription instead of stacking them', () => {
    withAudio((bus, engine) => {
      engine.attach(bus);
      engine.attach(bus);
      bus.emit(ev('walkStep'));
      expect(engine.played).toBe(1); // not 3
      engine.detach();
      bus.emit(ev('walkStep'));
      expect(engine.played).toBe(1);
    });
  });

  it('the landing thud really does scale with the fall (the claimed M2 fix)', () => {
    // audio.ts:120 recovers strength = invLerp(8, 14, paintRadius); thud gain is 0.25 + 0.35*s
    // and the tick gain 0.35 + 0.35*s, so soft and hard landings must build different graphs.
    const gains = (paint: number): number[] => {
      const out: number[] = [];
      withAudio((bus, _e, rec) => {
        bus.emit(ev('landing', { paintRadius: paint } as Partial<SoundEvent>));
        for (const [k, v] of rec.calls) if (k.endsWith('gain.setValueAtTime')) out.push(v);
      });
      return out;
    };
    const soft = gains(EV.landing.paint); // a 2 m step-down
    const hard = gains(EV.landing.paintMax); // an 8 m plunge
    expect(soft.length).toBe(2);
    expect(hard.length).toBe(2);
    expect(hard[0]!).toBeCloseTo(soft[0]! + 0.35, 6); // the tick body
    expect(hard[1]!).toBeCloseTo(soft[1]! + 0.35, 6); // the sine body
    // …and it saturates rather than running away past the top of the §3.3 row.
    expect(gains(EV.landing.paintMax + 50)).toEqual(hard);
    expect(gains(EV.landing.paint - 50)).toEqual(soft);
  });

  it('per-event jitter reaches the synth, so two footsteps are never bit-identical', () => {
    const fps: string[] = [];
    withAudio((bus, _e, rec) => {
      for (let i = 0; i < 4; i++) {
        rec.calls.length = 0;
        bus.emit(ev('walkStep'));
        fps.push(fingerprint(rec));
      }
    });
    expect(new Set(fps).size, 'four walk steps produced four different graphs').toBe(4);
  });
});

// ==========================================================================================
// BUG (minor) — the one synth that throws its jitter away
// ==========================================================================================

describe('BUG (minor) · every slide scrape is bit-identical (audio.ts:123, :166)', () => {
  /**
   * `case 'slide': this.scrape(t, 0.22)` — `e.fuzzSeed` is never passed, and `scrape()` takes no
   * seed. It also plays from a FIXED offset into the noise buffer (`src.start(t, 0.05)`), so
   * every scrape in a run replays the same 0.26 s of the same 0.5 s buffer at the same rate.
   * `tick()` (the footsteps) does the opposite: it varies playback rate, filter centre AND the
   * buffer offset from the seed.
   *
   * A slide emits one event per SLIDE_STRIDE (0.5 m), so at SLIDE_BOOST_SPEED that is ~15 copies
   * of the identical grain per second, overlapping. Identical overlapping noise grains do not sum
   * to noise, they sum to a periodic comb — the slide is the one movement verb whose sound will
   * ring rather than hiss. That matters beyond taste here: vision §3.8 makes the audio a readout
   * of how loud you are, and events.ts already computed a free per-event seed for exactly this.
   *
   * Severity: NIT. Fix direction: `this.scrape(t, 0.22, e.fuzzSeed)` and use the seed for the
   * buffer offset and the low-pass corner, the same way `tick()` already does.
   */
  it('expected: two slide events build different graphs — actual: they are identical', () => {
    const fps: string[] = [];
    const offsets: Array<number | undefined> = [];
    withAudio((bus, _e, rec) => {
      for (let i = 0; i < 3; i++) {
        rec.calls.length = 0;
        rec.starts.length = 0;
        bus.emit(ev('slide'));
        fps.push(fingerprint(rec));
        offsets.push(rec.starts[0]?.[2]);
      }
    });
    expect(new Set(offsets).size, `buffer offsets: ${offsets.join(', ')}`).toBeGreaterThan(1);
    expect(new Set(fps).size, 'three slide events produced one distinct graph').toBe(3);
  });

  it('expected: the slide varies the way footsteps do — actual: footsteps vary, slides do not', () => {
    const distinct = (cls: SoundClass): number => {
      const fps: string[] = [];
      withAudio((bus, _e, rec) => {
        for (let i = 0; i < 6; i++) {
          rec.calls.length = 0;
          bus.emit(ev(cls));
          fps.push(fingerprint(rec));
        }
      });
      return new Set(fps).size;
    };
    const steps = distinct('sprintStep');
    const slides = distinct('slide');
    expect(steps, 'the footstep synth does vary').toBe(6);
    expect(slides, `sprintStep: ${steps}/6 distinct, slide: ${slides}/6`).toBe(6);
  });
});
