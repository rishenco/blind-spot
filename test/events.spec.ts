/**
 * The sound-event bus (engine-plan §4) — the M2/M3 seam.
 *
 * These specs pin the two things M3 is about to build on: the SHAPE of a `SoundEvent` (every
 * field vision §3.3 names, filled from the class table so no emitter can invent a number), and
 * the CONTRACT of the bus (synchronous delivery, emission order, monotonic ids, a bounded ring).
 * The delivery fields are pinned at their neutral values on purpose: if M3's propagation pass
 * ever starts filling them at emission time instead of per listener, that is a regression here.
 */

import { describe, expect, it } from 'vitest';
import { EV, EVENT_RING, WAVE_SPEED_DETONATION, WAVE_SPEED_E, WAVE_SPEED_Q } from '../src/core/const.js';
import {
  classDefaults,
  EventBus,
  SOUND_CLASSES,
  type SoundClass,
  type SoundEvent,
} from '../src/core/events.js';
import { hash1 } from '../src/core/math.js';

const step = (bus: EventBus, cls: SoundClass, x = 0, y = 0, z = 0): SoundEvent =>
  bus.emit({ class: cls, source: 'self', x, y, z });

describe('class table (vision §3.3)', () => {
  it('gives every declared class a row', () => {
    for (const c of SOUND_CLASSES) {
      const d = classDefaults(c);
      expect(d.paint, c).toBeGreaterThan(0);
      expect(d.hear, c).toBeGreaterThan(0);
      expect(d.intensity, c).toBeGreaterThan(0);
      expect(d.intensity, c).toBeLessThanOrEqual(1);
      expect(d.wave, c).toBeGreaterThan(0);
    }
  });

  it('reproduces the vision §3.3 numbers for the movement classes', () => {
    expect(classDefaults('crouchStep')).toMatchObject({ paint: 1.5, hear: 2 });
    expect(classDefaults('walkStep')).toMatchObject({ paint: 4, hear: 11 });
    expect(classDefaults('sprintStep')).toMatchObject({ paint: 7, hear: 24 });
    expect(classDefaults('landing')).toMatchObject({ paint: 8, paintMax: 14, hear: 28 });
    expect(classDefaults('slide')).toMatchObject({ paint: 5, hear: 16 });
  });

  it('splits variants that share a class but not their numbers', () => {
    expect(classDefaults('dogGait', 'patrol')).toBe(EV.dogGaitPatrol);
    expect(classDefaults('dogGait', 'investigate')).toBe(EV.dogGaitInvestigate);
    expect(classDefaults('dogGait', 'chase')).toBe(EV.dogGaitChase);
    // Patrol is the quiet default: an unqualified gait must never read as a chase.
    expect(classDefaults('dogGait')).toBe(EV.dogGaitPatrol);
    expect(classDefaults('chainRattle', 'quiet')).toBe(EV.chainRattleQuiet);
    expect(classDefaults('chainRattle', 'loud')).toBe(EV.chainRattleLoud);
    expect(classDefaults('chainRattle')).toBe(EV.chainRattleLoud);
  });

  it('marks only the travelling classes with a finite wave speed', () => {
    expect(classDefaults('qPing').wave).toBe(WAVE_SPEED_Q);
    expect(classDefaults('ePing').wave).toBe(WAVE_SPEED_E);
    expect(classDefaults('detonation').wave).toBe(WAVE_SPEED_DETONATION);
    for (const c of ['crouchStep', 'walkStep', 'sprintStep', 'landing', 'slide', 'dogGait'] as const) {
      expect(classDefaults(c).wave, c).toBe(Infinity);
    }
  });

  it('gives the E-ping a cone and nothing else one', () => {
    expect(classDefaults('ePing').coneDeg).toBe(25);
    for (const c of SOUND_CLASSES) {
      if (c !== 'ePing') expect(classDefaults(c).coneDeg, c).toBeUndefined();
    }
  });
});

describe('emit', () => {
  it('fills every field from the class row', () => {
    const bus = new EventBus();
    bus.now = 4.25;
    const e = bus.emit({ class: 'sprintStep', source: 'self', x: 1, y: 2, z: 3 });
    expect(e.origin).toEqual([1, 2, 3]);
    expect(e.time).toBe(4.25);
    expect(e.class).toBe('sprintStep');
    expect(e.source).toBe('self');
    expect(e.paintRadius).toBe(EV.sprintStep.paint);
    expect(e.hearRadius).toBe(EV.sprintStep.hear);
    expect(e.intensity).toBe(EV.sprintStep.intensity);
    expect(e.waveSpeed).toBe(Infinity);
    expect(e.cone).toBeUndefined();
  });

  it('lets an emitter override a scaling field without touching the rest', () => {
    const bus = new EventBus();
    const e = bus.emit({ class: 'landing', source: 'self', x: 0, y: 0, z: 0, paintRadius: 11.5 });
    expect(e.paintRadius).toBe(11.5);
    expect(e.hearRadius).toBe(EV.landing.hear);
    expect(e.intensity).toBe(EV.landing.intensity);
  });

  it('stamps time from the bus clock, never from the emitter', () => {
    const bus = new EventBus();
    bus.now = 0.5;
    const a = step(bus, 'walkStep');
    bus.now = 1.5;
    const b = step(bus, 'walkStep');
    expect(a.time).toBe(0.5);
    expect(b.time).toBe(1.5);
  });

  it('leaves the delivery fields neutral — M3 owns them, per listener', () => {
    const bus = new EventBus();
    const e = step(bus, 'detonation', 30, 0, 30);
    expect(e.wallsToListener).toBe(0);
    expect(e.distToListener).toBe(0);
    expect(e.quality).toBe(1);
  });

  it('gives ids that are monotonic and seeds that are a pure function of them', () => {
    const bus = new EventBus();
    const a = step(bus, 'walkStep');
    const b = step(bus, 'walkStep');
    expect(b.id).toBe(a.id + 1);
    expect(a.fuzzSeed).toBe(hash1(a.id));
    expect(b.fuzzSeed).toBe(hash1(b.id));
    expect(a.fuzzSeed).toBeGreaterThanOrEqual(0);
    expect(a.fuzzSeed).toBeLessThan(1);
  });

  it('is deterministic: two identical buses produce identical seeds', () => {
    const seeds = (): number[] => {
      const bus = new EventBus();
      return SOUND_CLASSES.map((c) => step(bus, c).fuzzSeed);
    };
    expect(seeds()).toEqual(seeds());
  });

  it('carries a cone only when one is given', () => {
    const bus = new EventBus();
    const e = bus.emit({
      class: 'ePing',
      source: 'self',
      x: 0,
      y: 0,
      z: 0,
      cone: { dir: [1, 0, 0], angleDeg: 25 },
    });
    expect(e.cone?.angleDeg).toBe(25);
    expect(e.cone?.dir).toEqual([1, 0, 0]);
  });
});

describe('bus', () => {
  it('delivers synchronously, in emission order, inside the emitting call', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.on((e) => seen.push(e.id));
    const a = step(bus, 'walkStep');
    expect(seen).toEqual([a.id]);
    const b = step(bus, 'landing');
    expect(seen).toEqual([a.id, b.id]);
  });

  it('unsubscribes', () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.on(() => n++);
    step(bus, 'walkStep');
    off();
    step(bus, 'walkStep');
    expect(n).toBe(1);
  });

  it('tallies per class and in total', () => {
    const bus = new EventBus();
    step(bus, 'walkStep');
    step(bus, 'walkStep');
    step(bus, 'landing');
    expect(bus.counts.walkStep).toBe(2);
    expect(bus.counts.landing).toBe(1);
    expect(bus.counts.sprintStep).toBe(0);
    expect(bus.emitted).toBe(3);
    expect(bus.last?.class).toBe('landing');
  });

  it('reads back newest-first', () => {
    const bus = new EventBus();
    const a = step(bus, 'walkStep');
    const b = step(bus, 'sprintStep');
    expect(bus.at(0)?.id).toBe(b.id);
    expect(bus.at(1)?.id).toBe(a.id);
    expect(bus.at(2)).toBeNull();
    expect(bus.at(-1)).toBeNull();
    expect(bus.recent().map((e) => e.id)).toEqual([b.id, a.id]);
    expect(bus.recent(1).map((e) => e.id)).toEqual([b.id]);
  });

  it('is a bounded ring — history is capped, tallies are not', () => {
    const bus = new EventBus();
    const n = EVENT_RING + 20;
    for (let i = 0; i < n; i++) step(bus, 'walkStep', i);
    expect(bus.size).toBe(EVENT_RING);
    expect(bus.emitted).toBe(n);
    expect(bus.counts.walkStep).toBe(n);
    // The oldest 20 have been evicted; the newest is still the newest.
    expect(bus.at(0)?.origin[0]).toBe(n - 1);
    expect(bus.at(EVENT_RING - 1)?.origin[0]).toBe(n - EVENT_RING);
    expect(bus.at(EVENT_RING)).toBeNull();
    expect(bus.recent()).toHaveLength(EVENT_RING);
  });

  it('wraps around more than once without mixing up a single slot', () => {
    // Two full laps plus a partial one: the modular arithmetic in `at()` has to survive a head
    // that has lapped the array, not just a head that has filled it once.
    const bus = new EventBus();
    const total = EVENT_RING * 2 + 7;
    for (let i = 0; i < total; i++) step(bus, 'walkStep', i);

    expect(bus.size).toBe(EVENT_RING);
    expect(bus.at(0)?.origin[0]).toBe(total - 1);
    expect(bus.at(EVENT_RING - 1)?.origin[0]).toBe(total - EVENT_RING);
    // Strictly descending, no duplicates, no holes.
    for (let i = 1; i < EVENT_RING; i++) {
      expect(bus.at(i)!.id, `slot ${i}`).toBe(bus.at(i - 1)!.id - 1);
    }
    expect(bus.recent(5).map((e) => e.id)).toEqual([0, 1, 2, 3, 4].map((i) => bus.at(i)!.id));
  });

  it('survives a listener unsubscribing itself mid-dispatch', () => {
    const bus = new EventBus();
    const order: string[] = [];
    const offA = bus.on(() => order.push('a'));
    let offB: (() => void) | null = null;
    offB = bus.on(() => {
      order.push('b');
      offB!();
    });
    const offC = bus.on(() => order.push('c'));

    step(bus, 'walkStep', 1);
    step(bus, 'walkStep', 2);
    offA();
    offC();
    // b heard the first event, was gone for the second, and its removal did not skip c.
    expect(order).toEqual(['a', 'b', 'c', 'a', 'c']);
  });

  it('handles an event emitted from inside a listener without corrupting the ring', () => {
    // A dog reacting to a sound by making one is the whole M3/M4 shape, so re-entrant emission
    // has to be ordinary: the nested event is genuinely newer, and neither event is lost.
    const bus = new EventBus();
    let depth = 0;
    const off = bus.on(() => {
      if (depth++ > 0) return;
      step(bus, 'landing', 9);
    });
    const outer = step(bus, 'walkStep', 1);
    off();

    expect(bus.emitted).toBe(2);
    expect(bus.size).toBe(2);
    expect(bus.at(0)?.class).toBe('landing');
    expect(bus.at(1)?.id).toBe(outer.id);
    expect(bus.last?.class).toBe('landing');
  });

  it('NOTE · a listener subscribed DURING dispatch also receives the in-flight event', () => {
    // Not asserted as desirable — recorded because `emit` iterates the live Set and JS Set
    // iteration visits entries added behind the cursor. Harmless while nothing subscribes
    // mid-dispatch; a hazard the moment M3's paint pass attaches on demand. Reviewed and left
    // as-is deliberately (finding N7: no code change) — this probe is the tripwire if the
    // dispatch loop is ever rewritten.
    const bus = new EventBus();
    const heard: string[] = [];
    const off = bus.on(() => {
      heard.push('outer');
      bus.on(() => heard.push('late'));
    });
    step(bus, 'walkStep');
    off();
    expect(heard).toEqual(['outer', 'late']);
  });
});

describe('ids outlive reset (finding S4)', () => {
  /**
   * `nextId` is documented as "monotonic, never reused" and vision §3.6 keeps painted geometry
   * for the WHOLE RUN — so a stain, a de-dup cache or a network ack keyed by event id has to
   * stay unambiguous across the resets that run restarts and the debug overlay perform.
   */
  it('keeps climbing across a reset', () => {
    const bus = new EventBus();
    const before: SoundEvent[] = [];
    for (let i = 0; i < 5; i++) before.push(step(bus, 'walkStep', i));
    bus.reset();
    const after = step(bus, 'walkStep', 99);
    expect(after.id).toBeGreaterThan(before[before.length - 1]!.id);
  });

  it('never replays a fuzzSeed after a reset', () => {
    const bus = new EventBus();
    const a = step(bus, 'walkStep', 0);
    bus.reset();
    const b = step(bus, 'walkStep', 1);
    // Two physically different sounds at two different places must not share byte-identical
    // jitter: that is vision §1.2's "the system never lies" quietly failing.
    expect(b.origin[0]).not.toBe(a.origin[0]);
    expect(b.fuzzSeed).not.toBe(a.fuzzSeed);
  });

  it('hands out 64 distinct seeds in [0,1) over a run', () => {
    const bus = new EventBus();
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const e = step(bus, 'walkStep', i);
      expect(e.fuzzSeed).toBe(hash1(e.id));
      expect(e.fuzzSeed).toBeGreaterThanOrEqual(0);
      expect(e.fuzzSeed).toBeLessThan(1);
      seen.add(e.fuzzSeed);
    }
    expect(seen.size).toBe(64);
  });

  it('resets history and tallies but keeps listeners', () => {
    const bus = new EventBus();
    let n = 0;
    bus.on(() => n++);
    step(bus, 'walkStep');
    bus.reset();
    expect(bus.size).toBe(0);
    expect(bus.emitted).toBe(0);
    expect(bus.counts.walkStep).toBe(0);
    expect(bus.last).toBeNull();
    expect(bus.at(0)).toBeNull();
    step(bus, 'walkStep');
    expect(n).toBe(2);
    expect(bus.emitted).toBe(1);
  });
});
