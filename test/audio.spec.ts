/**
 * The synthesised audio engine (engine-plan §8).
 *
 * Contract under test:
 *   audio.ts     "Audio is a CONSUMER OF THE EVENT BUS, never a second truth… If you can hear it,
 *                an event exists that says so — and that same event paints the world."
 *   vision §1.2  "The system never lies" — the ears and the dots must agree.
 *   vision §3.3  landing paints 8 m at the threshold and 14 m at the top of the scale, so a 2 m
 *                step-down and an 8 m plunge must not sound alike.
 *   vision §3.8  "You always know exactly how loud you are."
 *
 * WebAudio does not exist in node, so these probes install a recording stub as
 * `globalThis.AudioContext` and read back the graph the engine actually built. The stub is torn
 * down in `finally`; nothing under src/ is touched.
 */

import { describe, expect, it } from 'vitest';
import { AudioEngine, type DeliveredFeed } from '../src/core/audio.js';
import {
  AUDIO_MASTER_GAIN,
  COYOTE_TIME,
  EPING_FAR_HEAR,
  EV,
  HALO_FULL_M,
  HEARING_BASE,
  SIM_STEP,
} from '../src/core/const.js';
import { EventBus, type SoundClass, type SoundEvent } from '../src/core/events.js';
import type { MapDef, Solid } from '../src/core/map/types.js';
import type { MoveInput } from '../src/core/movement.js';
import { PaintPipeline } from '../src/core/paint.js';
import { Sim } from '../src/core/sim.js';
import { bakeSurfels } from '../src/core/surfels.js';

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

/**
 * A stand-in for the DELIVERED feed audio actually subscribes to (`PaintPipeline.onDelivered`):
 * republishes everything a bus carries, at a chosen delivery quality.
 *
 * The engine no longer listens to raw emission — the gate that decides audibility lives in
 * core/paint.ts and is computed once (engine-plan §4, §8) — so a probe about what a sound SOUNDS
 * LIKE has to hand it a delivered event. Quality 1 is "heard at the source", which is what every
 * pre-existing synth expectation below was written against. The gate itself is pinned in
 * test/paint.spec.ts, and the end-to-end claim that audio never sounds what paint missed is
 * pinned at the bottom of this file against a real pipeline.
 */
class BusFeed implements DeliveredFeed {
  private readonly fns = new Set<(e: SoundEvent) => void>();

  constructor(bus: EventBus, private readonly quality = 1) {
    bus.on((e) => {
      for (const fn of this.fns) fn({ ...e, quality: this.quality });
    });
  }

  onDelivered(fn: (e: SoundEvent) => void): () => void {
    this.fns.add(fn);
    return () => {
      this.fns.delete(fn);
    };
  }
}

/** Run `body` with a stubbed AudioContext and hand it the recording. */
function withAudio(body: (bus: EventBus, engine: AudioEngine, rec: Rec) => void, quality = 1): void {
  const rec: Rec = { nodes: [], calls: [], starts: [] };
  const g = globalThis as { AudioContext?: unknown };
  const had = 'AudioContext' in g;
  const prev = g.AudioContext;
  g.AudioContext = makeStub(rec);
  const engine = new AudioEngine();
  const bus = new EventBus();
  const feed = new BusFeed(bus, quality);
  try {
    engine.resume();
    engine.attach(feed);
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
// The bus is the only input, and the landing round-trip works
// ==========================================================================================

describe('audio is a pure consumer of the bus (engine-plan §8)', () => {
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
      engine.attach(new BusFeed(bus));
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

  it('sounds exactly the implemented self classes and silently ignores the rest', () => {
    withAudio((bus, engine) => {
      // `mantle` gives the pull-up its own scuff, so the ears agree with the event the verb
      // publishes; the two pings are the deliberate perception verbs (vision §3.5).
      for (const c of [
        'crouchStep',
        'walkStep',
        'sprintStep',
        'landing',
        'slide',
        'mantle',
        'qPing',
        'ePing',
      ] as SoundClass[]) {
        bus.emit(ev(c));
      }
      expect(engine.played).toBe(8);
      // Classes whose milestone has not landed yet are ignored, not faked.
      for (const c of ['detonation', 'propKnock', 'beaconHum', 'dogGait'] as SoundClass[]) {
        bus.emit(ev(c));
      }
      expect(engine.played).toBe(8);
      // And a sound that is not yours is not played (M3 owns delivery).
      bus.emit({ ...ev('sprintStep'), source: 'dog' });
      expect(engine.played).toBe(8);
    });
  });

  it('attach() replaces its subscription instead of stacking them', () => {
    withAudio((bus, engine) => {
      const feed = new BusFeed(bus);
      engine.attach(feed);
      engine.attach(feed);
      bus.emit(ev('walkStep'));
      expect(engine.played).toBe(1); // not 3
      engine.detach();
      bus.emit(ev('walkStep'));
      expect(engine.played).toBe(1);
    });
  });

  it('the landing thud really does scale with the fall', () => {
    // `play()` recovers strength = invLerp(8, 14, paintRadius); thud gain is 0.25 + 0.35*s
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
// Every grain carries the event's own jitter — no synth throws it away
// ==========================================================================================

describe('the swept-noise synths jitter per event, so nothing combs (review finding: slide)', () => {
  /**
   * Before the fix, `case 'slide'` called `this.scrape(t, 0.22)` and `scrape()` took no seed: it
   * played a FIXED offset into the noise buffer at a fixed rate through a fixed filter, so every
   * scrape in a run was the same 0.26 s of the same 0.5 s buffer.
   *
   * A slide emits one event per SLIDE_STRIDE (0.5 m), so at SLIDE_BOOST_SPEED that is ~15 copies
   * of one grain per second, overlapping. Identical overlapping noise grains do not sum to noise,
   * they sum to a periodic comb — the slide would ring rather than hiss. `scrape` now takes the
   * seed and moves the playback rate, both filter corners AND the buffer offset with it, exactly
   * as `tick()` always did for footsteps.
   */
  it('two slide events build different graphs', () => {
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

  it('the slide and the mantle scuff vary the way footsteps do', () => {
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
    const mantles = distinct('mantle');
    expect(steps, 'the footstep synth does vary').toBe(6);
    expect(slides, `sprintStep: ${steps}/6 distinct, slide: ${slides}/6`).toBe(6);
    expect(mantles, `mantle: ${mantles}/6 distinct`).toBe(6);
  });

  it('the E-ping chirp rises 300 -> 1400 Hz, and its far end is the same chirp, quieter', () => {
    // Engine-plan §8 fixes the sweep. The far end is the beam landing somewhere and being heard
    // back (core/player.ts): the SAME question returning, so it must not be a different sound —
    // only a quieter, duller one. Anything else would be a scripted echo, and vision §1.2 forbids
    // a sound the world did not actually make.
    const chirp = (over: Partial<SoundEvent> = {}): { from: number; to: number; gain: number } => {
      let from = 0;
      let to = 0;
      let gain = 0;
      withAudio((bus, _e, rec) => {
        bus.emit(ev('ePing', over));
        for (const [k, v] of rec.calls) {
          if (k.endsWith('freq.setValueAtTime')) from = v;
          if (k.endsWith('freq.expRamp')) to = v;
          if (k.endsWith('gain.linearRamp')) gain = v;
        }
      });
      return { from, to, gain };
    };
    const out = chirp();
    expect(out.from).toBe(300);
    expect(out.to).toBe(1400);
    const far = chirp({ variant: 'far' } as Partial<SoundEvent>);
    expect(far.from).toBe(300);
    expect(far.to).toBe(1400);
    expect(far.gain).toBeLessThan(out.gain);
  });

  it('the mantle scuff sweeps UP where the slide sweeps down, so they never read alike', () => {
    // Deviation 4: same machinery (a swept filter over noise), opposite direction and a shorter,
    // quieter grain — a braced heave, not a scrape along the floor.
    const sweep = (cls: SoundClass): [number, number] => {
      let from = 0;
      let to = 0;
      withAudio((bus, _e, rec) => {
        bus.emit(ev(cls, { fuzzSeed: 0.5 } as Partial<SoundEvent>));
        for (const [k, v] of rec.calls) {
          if (k.endsWith('freq.setValueAtTime')) from = v;
          if (k.endsWith('freq.expRamp')) to = v;
        }
      });
      return [from, to];
    };
    const [slideFrom, slideTo] = sweep('slide');
    const [mantleFrom, mantleTo] = sweep('mantle');
    expect(slideTo).toBeLessThan(slideFrom); // 2200 -> 700 Hz
    expect(mantleTo).toBeGreaterThan(mantleFrom); // 900 -> 2600 Hz
  });
});

// ==========================================================================================
// The halo hum: the audible half of "you always know exactly how loud you are"
// ==========================================================================================

describe('the halo hum tracks audibleRadius (vision §3.8, engine-plan §8)', () => {
  /** Every value the hum's own oscillator/gain were steered to, in order. */
  const humSteers = (radii: number[]): { freq: number[]; gain: number[] } => {
    const freq: number[] = [];
    const gain: number[] = [];
    withAudio((_bus, engine, rec) => {
      for (const r of radii) {
        rec.calls.length = 0;
        engine.setHalo(r);
        for (const [k, v] of rec.calls) {
          if (k.endsWith('freq.setTarget')) freq.push(v);
          if (k.endsWith('gain.setTarget')) gain.push(v);
        }
      }
    });
    return { freq, gain };
  };

  it('BOTH volume and pitch rise with loudness, monotonically', () => {
    const { freq, gain } = humSteers([0, 2, 11, 24, 30]);
    expect(freq.length).toBe(5);
    expect(gain.length).toBe(5);
    for (let i = 1; i < freq.length; i++) {
      expect(freq[i]!, `pitch at step ${i}`).toBeGreaterThan(freq[i - 1]!);
      expect(gain[i]!, `volume at step ${i}`).toBeGreaterThan(gain[i - 1]!);
    }
    // A crouch step must be audible but ignorable next to a sprint step (engine-plan §8).
    expect(gain[1]!).toBeLessThan(gain[3]! * 0.3);
  });

  it('saturates at full scale rather than running away past it', () => {
    const { freq, gain } = humSteers([HALO_FULL_M, HALO_FULL_M * 4]);
    expect(freq[1]).toBe(freq[0]);
    expect(gain[1]).toBe(gain[0]);
  });

  it('survives being steered before the context exists, and applies the last value on resume', () => {
    const rec: Rec = { nodes: [], calls: [], starts: [] };
    const g = globalThis as { AudioContext?: unknown };
    const had = 'AudioContext' in g;
    const prev = g.AudioContext;
    const engine = new AudioEngine();
    try {
      // Autoplay policy: the boot layer steers the hum every frame from the first one, which is
      // long before the first user gesture. That must be silent, not a crash.
      engine.setHalo(24);
      g.AudioContext = makeStub(rec);
      engine.resume();
      const steered = rec.calls.filter(([k]) => k.endsWith('freq.setTarget')).map(([, v]) => v);
      expect(steered.length).toBeGreaterThan(0);
      expect(steered[0]!).toBeGreaterThan(100); // the 24 m it was told about while asleep
    } finally {
      engine.dispose();
      if (had) g.AudioContext = prev;
      else delete g.AudioContext;
    }
  });

  it('runs under the master gain, so mute silences it like everything else', () => {
    withAudio((_bus, engine, rec) => {
      engine.setHalo(30);
      rec.calls.length = 0;
      engine.setMuted(true);
      const targets = rec.calls.filter(([k]) => k.endsWith('gain.setTarget')).map(([, v]) => v);
      expect(targets).toContain(0);
      rec.calls.length = 0;
      engine.setMuted(false);
      const back = rec.calls.filter(([k]) => k.endsWith('gain.setTarget')).map(([, v]) => v);
      expect(back).toContain(AUDIO_MASTER_GAIN);
    });
  });
});

// ==========================================================================================
// Delivery: the ears hear what the LISTENER received, and only that
// ==========================================================================================

const box = (
  id: string,
  kind: Solid['kind'],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): Solid => ({ type: 'box', id, kind, min: [x0, y0, z0], max: [x1, y1, z1] });

/** A hall whose only wall is 39 m down it: the beam lands well outside your own 30 m hearing. */
const longHall: MapDef = {
  name: 'long hall',
  solids: [box('floor', 'floor', 0, -1, 0, 50, 0, 20), box('far wall', 'wall', 40, 0, 0, 40.4, 6, 20)],
  ladders: [],
  props: [],
  doors: [],
  dogRoutes: [],
  spawn: { pos: [1, 0, 5], yaw: 0 },
  air: [{ min: [0, 0, 0], max: [50, 6, 20] }],
  markers: [],
  bounds: { min: [0, -1, 0], max: [50, 6, 20] },
};

const NEUTRAL: MoveInput = {
  forward: 0,
  right: 0,
  jumpPressed: false,
  crouch: false,
  sprint: false,
  yawDelta: 0,
  pitchDelta: 0,
};

describe('audio obeys the delivery gate (engine-plan §4, §8)', () => {
  it('MUST NOT sound a far end 38.95 m away that its own paint pipeline scored as missed', () => {
    // `AudioEngine.play` used to short-circuit on `e.source === 'self'` with no audibility test.
    // That was sound while every self event originated AT the player. The E-ping's far end broke
    // it: a self event up to 40 m away, which the delivery gate
    // (`d <= max(HEARING_BASE, hearRadius)`) rejects past 30 m. The ears and the dots would then
    // disagree about the same event — which is exactly what engine-plan §8 forbids ("audio is a
    // consumer of the same bus — never a separate truth") and what vision §1.2 calls a lie.
    const rec: Rec = { nodes: [], calls: [], starts: [] };
    const g = globalThis as { AudioContext?: unknown };
    const had = 'AudioContext' in g;
    const prev = g.AudioContext;
    g.AudioContext = makeStub(rec);
    const audio = new AudioEngine();
    try {
      const sim = new Sim(longHall);
      const p = sim.player;
      p.x = 1;
      p.y = 0;
      p.z = 5;
      p.yaw = 0;
      p.pitch = 0;
      p.vx = p.vy = p.vz = 0;
      p.grounded = true;
      sim.movement.apexY = 0;
      sim.movement.coyote = COYOTE_TIME;
      sim.bus.reset();

      const field = bakeSurfels(sim.world);
      const paint = new PaintPipeline(field, sim.world);
      paint.attach(sim.bus);
      audio.resume();
      audio.attach(paint);
      const before = audio.played;

      const seen: SoundEvent[] = [];
      const off = sim.bus.on((e) => seen.push(e));
      paint.setListener(p.x, p.y + sim.movement.eyeTarget, p.z);
      sim.playerSystems.intent.pingE = true;
      for (let i = 0; i < Math.round(1.0 / SIM_STEP); i++) {
        Object.assign(sim.input, NEUTRAL);
        sim.step(SIM_STEP);
      }
      off();

      const far = seen.find((e) => e.variant === 'far')!;
      const d = Math.hypot(far.origin[0] - p.x, far.origin[2] - p.z);
      // The premise, asserted rather than assumed: the far end really is out of earshot.
      expect(d).toBeGreaterThan(Math.max(HEARING_BASE, EPING_FAR_HEAR));
      expect(paint.missed).toBe(1);

      // …so exactly one ping was audible: the one that left your own head.
      expect(audio.played - before).toBe(1);
    } finally {
      audio.dispose();
      if (had) g.AudioContext = prev;
      else delete g.AudioContext;
    }
  });

  it('MUST play a delivered sound at the strength it arrived with, and never at zero', () => {
    // Vision §3.4: distance and a wall make a sound quieter, not different. The E-ping's return is
    // the case that matters — the same wall answering from 5 m and from 30 m has to read as a
    // RANGE, not as a beep that either happens or does not. `quality` is the event's own delivery
    // number (core/math.ts `eventQuality`), and it is the only input to this.
    const farGain = (quality: number): number => {
      let gain = 0;
      withAudio(
        (bus, _e, rec) => {
          bus.emit(ev('ePing', { variant: 'far' } as Partial<SoundEvent>));
          for (const [k, v] of rec.calls) if (k.endsWith('gain.linearRamp')) gain = v;
        },
        quality,
      );
      return gain;
    };
    const point = farGain(1);
    const mid = farGain(0.5);
    const rim = farGain(0);
    expect(mid).toBeLessThan(point);
    expect(rim).toBeLessThan(mid);
    // Delivery is the world's statement that you heard it, and `quality` hits 0 exactly AT the
    // hear radius — so the rim of audibility is a hint, never silence.
    expect(rim).toBeGreaterThan(0);
  });
});
