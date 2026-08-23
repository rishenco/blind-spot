/**
 * M2 ADVERSARIAL REVIEW — the event bus, the one thing every later milestone hangs off.
 *
 * Contract under test:
 *   events.ts:168  "Monotonic, never reused — `fuzzSeed` and stain identity both hang off it."
 *   events.ts:10   the milestone seam: `wallsToListener` / `distToListener` / `quality` are
 *                  DELIVERY fields owned by M3 and must be neutral at emission in M2.
 *   events.ts:155  "Emission is synchronous: listeners run inside the emitting fixed step, so
 *                  audio and paint see events in exactly the order they happened."
 *   vision §3.6    paint is kept for the WHOLE RUN, so a stain's identity has to outlive
 *                  anything that clears the ring.
 *
 * Labels: PIN = passes today, pins verified-correct behaviour. BUG = fails today, on purpose.
 */

import { describe, expect, it } from 'vitest';
import { EV, EVENT_RING } from '../../src/core/const.js';
import { EventBus, type SoundEvent } from '../../src/core/events.js';
import { hash1 } from '../../src/core/math.js';

const spec = (n: number) => ({ class: 'walkStep', source: 'self', x: n, y: 0, z: 0 }) as const;

// ==========================================================================================
// PIN — the parts that are right
// ==========================================================================================

describe('PIN · the ring, the ordering and the M2 delivery seam', () => {
  it('keeps exactly EVENT_RING events, newest first, and never mixes up the wraparound', () => {
    const bus = new EventBus();
    const total = EVENT_RING * 2 + 7;
    for (let i = 0; i < total; i++) bus.emit(spec(i));

    expect(bus.size).toBe(EVENT_RING);
    expect(bus.at(0)!.origin[0]).toBe(total - 1); // newest
    expect(bus.at(EVENT_RING - 1)!.origin[0]).toBe(total - EVENT_RING); // oldest kept
    expect(bus.at(EVENT_RING)).toBeNull();
    expect(bus.at(-1)).toBeNull();

    // Strictly descending, no duplicates, no holes — the wraparound arithmetic is exact.
    for (let i = 1; i < EVENT_RING; i++) {
      expect(bus.at(i)!.id, `slot ${i}`).toBe(bus.at(i - 1)!.id - 1);
    }
    // Lifetime tallies are NOT the ring: eviction must not lose the count (the F3 line and
    // verify.mjs both read these).
    expect(bus.emitted).toBe(total);
    expect(bus.counts.walkStep).toBe(total);

    const r = bus.recent(5);
    expect(r.map((e) => e.id)).toEqual([0, 1, 2, 3, 4].map((i) => bus.at(i)!.id));
  });

  it('stamps the sim clock the sim wrote, never a clock of its own', () => {
    const bus = new EventBus();
    bus.now = 12.5;
    const a = bus.emit(spec(1));
    bus.now = 12.5 + 1 / 60;
    const b = bus.emit(spec(2));
    expect(a.time).toBe(12.5);
    expect(b.time).toBe(12.5 + 1 / 60);
    expect(b.time).toBeGreaterThan(a.time);
  });

  it('derives fuzzSeed from the id deterministically, in [0,1)', () => {
    const bus = new EventBus();
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const e = bus.emit(spec(i));
      expect(e.fuzzSeed).toBe(hash1(e.id));
      expect(e.fuzzSeed).toBeGreaterThanOrEqual(0);
      expect(e.fuzzSeed).toBeLessThan(1);
      seen.add(e.fuzzSeed);
    }
    expect(seen.size).toBe(64); // 64 events, 64 distinct jitters
  });

  it('leaves the M3 delivery fields neutral at emission (engine-plan §11 milestone seam)', () => {
    const bus = new EventBus();
    const e = bus.emit(spec(0));
    expect(e.wallsToListener).toBe(0);
    expect(e.distToListener).toBe(0);
    expect(e.quality).toBe(1);
    // …and the class row is applied from const.ts, not hard-coded at the call site.
    expect(e.paintRadius).toBe(EV.walkStep.paint);
    expect(e.hearRadius).toBe(EV.walkStep.hear);
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

    bus.emit(spec(1));
    bus.emit(spec(2));
    offA();
    offC();
    // b heard the first event, was gone for the second, and its removal did not skip c.
    expect(order).toEqual(['a', 'b', 'c', 'a', 'c']);
  });

  it('handles an event emitted from inside a listener without corrupting the ring', () => {
    const bus = new EventBus();
    let depth = 0;
    const off = bus.on(() => {
      if (depth++ > 0) return;
      bus.emit({ class: 'landing', source: 'self', x: 9, y: 0, z: 0 });
    });
    const outer = bus.emit(spec(1));
    off();

    expect(bus.emitted).toBe(2);
    expect(bus.size).toBe(2);
    expect(bus.at(0)!.class).toBe('landing'); // the nested one is genuinely newer
    expect(bus.at(1)!.id).toBe(outer.id);
    expect(bus.last!.class).toBe('landing');
  });

  it('reset() drops history and tallies but keeps listeners subscribed', () => {
    const bus = new EventBus();
    let heard = 0;
    const off = bus.on(() => heard++);
    bus.emit(spec(1));
    bus.reset();
    expect(bus.size).toBe(0);
    expect(bus.emitted).toBe(0);
    expect(bus.last).toBeNull();
    expect(bus.counts.walkStep).toBe(0);
    bus.emit(spec(2));
    off();
    expect(heard).toBe(2);
  });

  it('NOTE · a listener subscribed DURING dispatch also receives the in-flight event', () => {
    // Not asserted as desirable — recorded because `emit` iterates the live Set (events.ts:209)
    // and JS Set iteration visits entries added behind the cursor. Harmless in M2 (nothing
    // subscribes mid-dispatch); a hazard the moment M3's paint pass attaches on demand.
    const bus = new EventBus();
    const heard: string[] = [];
    const off = bus.on(() => {
      heard.push('outer');
      bus.on(() => heard.push('late'));
    });
    bus.emit(spec(1));
    off();
    expect(heard).toEqual(['outer', 'late']);
  });
});

// ==========================================================================================
// BUG — reset() breaks the id invariant the file itself declares
// ==========================================================================================

describe('BUG · reset() restarts the id counter (events.ts:168 says ids are never reused)', () => {
  /**
   * events.ts:250 — `this.nextId = 1` inside `reset()`. The field is documented one line above
   * its declaration as "Monotonic, never reused — fuzzSeed and stain identity both hang off it",
   * and vision §3.6 keeps painted geometry for the whole run, so any consumer that keys a stain
   * (or a de-dup cache, or a network ack) by event id sees two different events claim one id.
   * `reset()` is called by the debug overlay's clear and by run restarts, not only by specs.
   */
  it('expected: ids keep climbing across a reset — actual: they restart at 1', () => {
    const bus = new EventBus();
    const before: SoundEvent[] = [];
    for (let i = 0; i < 5; i++) before.push(bus.emit(spec(i)));
    bus.reset();
    const after = bus.emit(spec(99));

    expect(after.id).toBeGreaterThan(before[before.length - 1]!.id);
  });

  it('expected: fuzzSeed is unique per event — actual: it repeats exactly after a reset', () => {
    const bus = new EventBus();
    const a = bus.emit(spec(0));
    bus.reset();
    const b = bus.emit(spec(1));
    // Two physically different sounds, at two different places, with byte-identical jitter.
    expect(b.origin[0]).not.toBe(a.origin[0]);
    expect(b.fuzzSeed).not.toBe(a.fuzzSeed);
  });
});
