/**
 * Characterization tests for `src/paint/soundEvents.ts` — the bus every noise in the game goes
 * through. Design law 2 ("the system never lies") is only enforceable because there is no second
 * path, so the stamping and validation this file pins are the guarantee itself.
 *
 * The §3.3 table values are pinned as data, not restated as intent: playtests are expected to
 * move them, and the diff is supposed to be visible when they do.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LANDING_FULL_IMPACT,
  LANDING_MAX_RADIUS,
  LANDING_MIN_IMPACT,
  NO_EMITTER,
  PLAYER_EMITTER_ID,
  SOUND_CLASSES,
  SoundBus,
  WAVE_SPEEDS,
  eventTint,
  isComposedClass,
  isContactClass,
  type SoundClass,
  type SoundEvent,
  type SoundSource,
} from '../src/paint/soundEvents';
import { MAT_CONCRETE } from '../src/paint/materials';

/**
 * The bodies a class has to be handed before it will emit at all.
 *
 * Read off `CONTACT_CLASSES` and `COMPOSED_CLASSES` rather than from a list of names, so a loop
 * over the whole table keeps working when the table grows — which is the only reason the loops
 * below survived M2's three new rows without being rewritten. Concrete on both sides on purpose:
 * its multiplier is 1.0 and so is the pair's geometric mean, so a class's own numbers come
 * through the material law unchanged and the loops are testing the class and not the surface.
 */
function bodiesFor(cls: SoundClass): { mat?: number; objMat?: number } {
  if (isComposedClass(cls)) return { mat: MAT_CONCRETE, objMat: MAT_CONCRETE };
  return isContactClass(cls) ? { mat: MAT_CONCRETE } : {};
}

describe('the class table', () => {
  it('every class names a wave group that WAVE_SPEEDS defines', () => {
    for (const [name, profile] of Object.entries(SOUND_CLASSES)) {
      expect(WAVE_SPEEDS, `${name}.wave = ${profile.wave}`).toHaveProperty(profile.wave);
      expect(typeof WAVE_SPEEDS[profile.wave]).toBe('number');
      expect(WAVE_SPEEDS[profile.wave]).toBeGreaterThan(0);
    }
  });

  it('holds exactly the classes implemented so far, in §3.3 order', () => {
    expect(Object.keys(SOUND_CLASSES)).toEqual([
      'crouch-step', 'walk-step', 'sprint-step', 'landing', 'q-ping', 'e-ping',
      // M2's throwable: the rig's own arm — which §3.3 has no row for, because a wind-up is a
      // mechanism rather than a contact — and the boom the sphere ends in. The two prop rows
      // between them are §3.3's reserved contact rows, kept with no emitter: core-loop §2's
      // artifact clang and the M4 spider both want them, and a class with no emitter costs a
      // table row while a class deleted and re-added costs the halo calibration below.
      'prop-impact', 'prop-knock', 'throw-windup', 'sphere-boom',
    ]);
  });

  it('pins the current profile numbers', () => {
    // Vision §3.3 verbatim, except the e-ping: batch 2.1 re-roled it from a 25°/40 m telescope
    // to a 110°/22 m "look around", which the source comment records as a deliberate deviation.
    expect(SOUND_CLASSES).toEqual({
      'crouch-step': { paintRadius: 1.5, hearingRadius: 2, coneAngleDeg: 360, intensity: 0.7, wave: 'step' },
      'walk-step': { paintRadius: 4, hearingRadius: 11, coneAngleDeg: 360, intensity: 0.9, wave: 'step' },
      'sprint-step': { paintRadius: 7, hearingRadius: 24, coneAngleDeg: 360, intensity: 1.0, wave: 'step' },
      landing: { paintRadius: 8, hearingRadius: 28, coneAngleDeg: 360, intensity: 1.0, wave: 'step' },
      'q-ping': { paintRadius: 12, hearingRadius: 18, coneAngleDeg: 360, intensity: 1.05, wave: 'ping' },
      'e-ping': { paintRadius: 22, hearingRadius: 30, coneAngleDeg: 110, intensity: 1.15, wave: 'beam' },
      'prop-impact': { paintRadius: 8, hearingRadius: 25, coneAngleDeg: 360, intensity: 1.0, wave: 'step' },
      'prop-knock': { paintRadius: 1.5, hearingRadius: 4, coneAngleDeg: 360, intensity: 0.7, wave: 'step' },
      'throw-windup': { paintRadius: 0.5, hearingRadius: 2.5, coneAngleDeg: 360, intensity: 0.6, wave: 'step' },
      'sphere-boom': { paintRadius: 12, hearingRadius: 32, coneAngleDeg: 360, intensity: 1.0, wave: 'ping' },
    });
    expect(WAVE_SPEEDS).toEqual({ step: 25, ping: 25, beam: 45 });
    expect([LANDING_MIN_IMPACT, LANDING_FULL_IMPACT, LANDING_MAX_RADIUS]).toEqual([5, 14, 14]);
  });
});

describe('SoundBus.landingRadius', () => {
  const base = SOUND_CLASSES.landing.paintRadius; // 8

  it('is flat at the base below and at LANDING_MIN_IMPACT', () => {
    expect(SoundBus.landingRadius(-5)).toBe(base);
    expect(SoundBus.landingRadius(0)).toBe(base);
    expect(SoundBus.landingRadius(4.999)).toBe(base);
    expect(SoundBus.landingRadius(LANDING_MIN_IMPACT)).toBe(base);
  });

  it('starts rising immediately above LANDING_MIN_IMPACT', () => {
    expect(SoundBus.landingRadius(LANDING_MIN_IMPACT + 1e-4)).toBeCloseTo(8.000066666666667, 12);
  });

  it('interpolates linearly across the 8-14 m band', () => {
    expect(SoundBus.landingRadius(9.5)).toBe(11); // halfway
    expect(SoundBus.landingRadius(6.5)).toBe(9); // a quarter
    expect(SoundBus.landingRadius(12.5)).toBe(13); // three quarters
  });

  it('clamps at LANDING_MAX_RADIUS from LANDING_FULL_IMPACT upward', () => {
    expect(SoundBus.landingRadius(LANDING_FULL_IMPACT)).toBe(LANDING_MAX_RADIUS);
    expect(SoundBus.landingRadius(100)).toBe(LANDING_MAX_RADIUS);
    expect(SoundBus.landingRadius(Infinity)).toBe(LANDING_MAX_RADIUS);
  });

  it('answers the band floor for NaN instead of poisoning the radius', () => {
    // NaN fails `t < 0` and `t > 1` alike, so an ordinary clamp hands it straight back. A NaN
    // radius does not throw — it paints nothing, because every distance test downstream is
    // false — and a landing that was emitted, heard and not drawn is a law-2 lie. The floor of
    // the band is the honest answer: we could not measure the impact, so it rings out as the
    // quietest thing a landing can be.
    expect(SoundBus.landingRadius(NaN)).toBe(base);
  });

  it('never leaves the 8-14 m band, whatever it is handed', () => {
    // The claim the NaN case is one instance of. If a future edit reintroduces a path out of
    // the band — a new early return, a different clamp — this names it without needing to have
    // predicted which input finds it.
    const nasty = [
      NaN, Infinity, -Infinity, 0, -0, 5, 14, 1e308, -1e308, 1e-308,
      Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
    ];
    for (const v of nasty) {
      const r = SoundBus.landingRadius(v);
      expect(Number.isFinite(r), `landingRadius(${v}) = ${r}`).toBe(true);
      expect(r).toBeGreaterThanOrEqual(base);
      expect(r).toBeLessThanOrEqual(LANDING_MAX_RADIUS);
    }
  });
});

describe('SoundBus state', () => {
  it('starts at time 0 with nothing emitted', () => {
    const bus = new SoundBus();
    expect(bus.time).toBe(0);
    expect(bus.emitted).toBe(0);
    expect(bus.lastEvent).toBeNull();
  });

  it('setTime stamps every subsequent event until it changes', () => {
    const bus = new SoundBus();
    bus.setTime(3.25);
    expect(bus.time).toBe(3.25);
    expect(bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0 }).time).toBe(3.25);
    expect(bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0 }).time).toBe(3.25);
    bus.setTime(4);
    expect(bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0 }).time).toBe(4);
  });

  it('seq is monotonic from 0 and `emitted` is the count', () => {
    const bus = new SoundBus();
    const seqs = [];
    for (let i = 0; i < 5; i++) seqs.push(bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 }).seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    expect(bus.emitted).toBe(5);
  });

  it('lastEvent is the most recent event, by reference', () => {
    const bus = new SoundBus();
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    const second = bus.emit({ class: 'q-ping', x: 1, y: 2, z: 3 });
    expect(bus.lastEvent).toBe(second);
  });
});

describe('SoundBus.emit', () => {
  it('fills every field from the class profile when the spec names none', () => {
    const bus = new SoundBus();
    bus.setTime(2);
    expect(bus.emit({ class: 'walk-step', x: 1, y: 2, z: 3 })).toEqual({
      class: 'walk-step',
      // An emit that does not say who made it is the world's, belonging to no entity — never a
      // player, which would hand an anonymous noise an identity `eventTint` would then colour.
      source: 'world',
      emitter: NO_EMITTER,
      x: 1, y: 2, z: 3,
      // A contact class that names no surface struck the ordinary one — the same default the
      // radii above were scaled by, so what the event says it hit and what it was priced as are
      // never two different answers.
      mat: MAT_CONCRETE,
      // No second body: a walk-step is the rig meeting a floor, and the rig has no material.
      objMat: null,
      paintRadius: 4,
      hearingRadius: 11,
      intensity: 0.9,
      dirX: 0, dirY: 0, dirZ: 0,
      coneAngleDeg: 360,
      waveSpeed: 25,
      time: 2,
      seq: 0,
    });
  });

  it('lets the spec override radii, intensity, cone and wave speed', () => {
    const bus = new SoundBus();
    const e = bus.emit({
      class: 'landing', x: 0, y: 0, z: 0,
      paintRadius: 13, hearingRadius: 40, intensity: 1.3, coneAngleDeg: 90,
      dirX: 0, dirY: -1, dirZ: 0, waveSpeed: 60,
    });
    expect(e.paintRadius).toBe(13);
    expect(e.hearingRadius).toBe(40);
    expect(e.intensity).toBe(1.3);
    expect(e.coneAngleDeg).toBe(90);
    expect(e.waveSpeed).toBe(60);
  });

  it('normalises a non-unit aim direction', () => {
    const bus = new SoundBus();
    const e = bus.emit({ class: 'e-ping', x: 0, y: 0, z: 0, dirX: 3, dirY: 0, dirZ: 4 });
    expect(e.dirX).toBe(0.6);
    expect(e.dirY).toBe(0);
    expect(e.dirZ).toBe(0.8);
    expect(Math.hypot(e.dirX, e.dirY, e.dirZ)).toBeCloseTo(1, 15);
    expect(e.coneAngleDeg).toBe(110); // the aim survives, so the cone does too
  });

  it('a cone with no aim direction degrades to 360 rather than painting a slit', () => {
    const bus = new SoundBus();
    const e = bus.emit({ class: 'e-ping', x: 0, y: 0, z: 0 });
    expect(e.dirX).toBe(0);
    expect(e.dirY).toBe(0);
    expect(e.dirZ).toBe(0);
    expect(e.coneAngleDeg).toBe(360);
  });

  it('an explicit cone is discarded too when the aim is below the 1e-6 length floor', () => {
    const bus = new SoundBus();
    const tiny = bus.emit({ class: 'e-ping', x: 0, y: 0, z: 0, dirX: 1e-7, coneAngleDeg: 20 });
    expect(tiny.coneAngleDeg).toBe(360);
    expect(tiny.dirX).toBe(0);
    // Just above the floor, the aim (and the cone) is kept — and normalised to unit length.
    const kept = bus.emit({ class: 'e-ping', x: 0, y: 0, z: 0, dirX: 1e-5, coneAngleDeg: 20 });
    expect(kept.coneAngleDeg).toBe(20);
    expect(kept.dirX).toBe(1);
  });

  it('clamps waveSpeed to a 0.5 m/s floor', () => {
    const bus = new SoundBus();
    expect(bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0, waveSpeed: 0.1 }).waveSpeed).toBe(0.5);
    expect(bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0, waveSpeed: 0 }).waveSpeed).toBe(0.5);
    expect(bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0, waveSpeed: -50 }).waveSpeed).toBe(0.5);
    expect(bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0, waveSpeed: 0.5 }).waveSpeed).toBe(0.5);
  });

  /**
   * Position is stamped; radii are checked. The split is not an inconsistency, it is the line
   * between a value that can be strange and one that can be wrong.
   *
   * A sound 1000 km away is a *legitimate* sound at an unhelpful place: both senses agree it is
   * inaudible, they agree for the same reason, and nothing about §1 is bent by it. A radius of
   * −3 is not a place, it is a claim about how far the event reaches, and the two subscribers
   * answer it differently — which is the one thing the bus exists to prevent. So the bus stamps
   * what it is told about *where*, and refuses what it is told about *how far*.
   */
  it('stamps a position as given, however far away it is', () => {
    const bus = new SoundBus();
    const e = bus.emit({ class: 'q-ping', x: -1e6, y: 0, z: 0 });
    expect(e.x).toBe(-1e6);
    expect(e.paintRadius).toBe(SOUND_CLASSES['q-ping'].paintRadius);
  });
});

describe('SoundBus.subscribe', () => {
  it('fans out synchronously, inside the emit call, in subscription order', () => {
    const bus = new SoundBus();
    const order: string[] = [];
    bus.subscribe(() => order.push('a'));
    bus.subscribe(() => order.push('b'));
    order.push('before');
    const e = bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    order.push('after');
    expect(order).toEqual(['before', 'a', 'b', 'after']);
    expect(e.seq).toBe(0);
  });

  it('hands every listener the same event object the caller gets back', () => {
    const bus = new SoundBus();
    let seen: SoundEvent | null = null;
    bus.subscribe((event) => { seen = event; });
    const returned = bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0 });
    expect(seen).toBe(returned);
  });

  it('the returned unsubscribe removes exactly that listener', () => {
    const bus = new SoundBus();
    const a = vi.fn();
    const b = vi.fn();
    const stopA = bus.subscribe(a);
    bus.subscribe(b);
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    stopA();
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    stopA(); // idempotent
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('subscribing the same function twice registers it once (listeners are a Set)', () => {
    const bus = new SoundBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    bus.subscribe(fn);
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a listener that emits throws, rather than quietly reordering the tick', () => {
    // A sound is made by the simulation, never by another sound's delivery. The alternative —
    // queuing the reentrant emit — would decide "who heard what first" inside the bus, where no
    // one making that call would think to look, and would make it depend on registration order.
    const bus = new SoundBus();
    const stop = bus.subscribe(() => {
      bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0 });
    });
    expect(() => bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 })).toThrow(/fan-out/);
    stop();

    // The refusal leaves no trace: the rejected emit took no sequence number, moved no counter,
    // and did not wedge the bus shut behind it.
    expect(bus.emitted).toBe(1);
    expect(bus.emittedThisTick).toBe(1);
    const after = bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect(after.seq).toBe(1);
  });

  it('and the refusal is the module, not the instance — A fanning out blocks B too', () => {
    // The fan-out buffer is shared between every bus in the process, so a listener on A emitting
    // on B would overwrite the array A is still walking. One flag over one buffer is what makes
    // the single buffer safe; a per-instance flag would leave exactly that hole open.
    const a = new SoundBus();
    const b = new SoundBus();
    const stop = a.subscribe(() => {
      b.emit({ class: 'q-ping', x: 0, y: 0, z: 0 });
    });
    expect(() => a.emit({ class: 'walk-step', x: 0, y: 0, z: 0 })).toThrow(/fan-out/);
    stop();
    // Sequentially, of course, they are completely independent.
    a.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    b.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect([a.emitted, b.emitted]).toEqual([2, 1]);
  });

  it('a listener that throws does not wedge the bus shut', () => {
    const bus = new SoundBus();
    const stop = bus.subscribe(() => {
      throw new Error('listener exploded');
    });
    const after = vi.fn();
    bus.subscribe(after);
    expect(() => bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 })).toThrow('listener exploded');
    stop();
    // The fan-out flag was cleared on the way out, so the next emit is not refused as reentrant.
    expect(() => bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('subscribing during a fan-out starts at the NEXT event, not this one', () => {
    // `Set` iteration visits entries added while it is running, so without the snapshot the new
    // listener would receive the very event that added it.
    const bus = new SoundBus();
    const late = vi.fn();
    let added = false;
    bus.subscribe(() => {
      if (added) return;
      added = true;
      bus.subscribe(late);
    });
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect(late).not.toHaveBeenCalled();

    const second = bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0 });
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0]![0]).toBe(second);
  });

  it('unsubscribing during a fan-out still delivers the event it was unsubscribed in', () => {
    // The other half of the same rule, and the half a live `Set` gets wrong in the opposite
    // direction: an entry deleted before the iterator reaches it is never visited. The snapshot
    // says instead that an event's listeners are the ones that existed when it was emitted.
    const bus = new SoundBus();
    const victim = vi.fn();
    let stopVictim = (): void => {};
    bus.subscribe(() => stopVictim());
    stopVictim = bus.subscribe(victim);

    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect(victim).toHaveBeenCalledTimes(1);
    // ...and it really is gone for everything after it.
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect(victim).toHaveBeenCalledTimes(1);
  });

  it('dispose drops every listener but keeps the clock and the counter', () => {
    const bus = new SoundBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    bus.setTime(7);
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    bus.dispose();
    const after = bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(after.seq).toBe(1);
    expect(after.time).toBe(7);
    expect(bus.emitted).toBe(2);
  });
});

describe('the per-tick emission counters', () => {
  it('count this tick, remember the worst tick, and reset on setTime', () => {
    const bus = new SoundBus();
    expect([bus.emittedThisTick, bus.maxEmittedPerTick]).toEqual([0, 0]);

    bus.setTime(1);
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0 });
    expect([bus.emittedThisTick, bus.maxEmittedPerTick]).toEqual([2, 2]);

    // `setTime` is the tick boundary — `GameSim.tick` stamps the clock once, at the top, before
    // anything is allowed to emit — so it is where the per-tick count resets.
    bus.setTime(2);
    expect([bus.emittedThisTick, bus.maxEmittedPerTick]).toEqual([0, 2]);
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect([bus.emittedThisTick, bus.maxEmittedPerTick]).toEqual([1, 2]);

    // The peak is a high-water mark: it only ever climbs.
    bus.setTime(3);
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0 });
    expect([bus.emittedThisTick, bus.maxEmittedPerTick]).toEqual([3, 3]);
    expect(bus.emitted).toBe(6);
  });

  it('observe without gating: a flood is counted, and every event of it is delivered', () => {
    // The counters exist so an emitter bug is loud, never so the bus can protect itself by
    // dropping. A dropped event is a sound that made no paint, which is the one thing design
    // law 2 forbids the system to produce — so however high this climbs, all of it goes out.
    const bus = new SoundBus();
    const heard: number[] = [];
    bus.subscribe((e) => heard.push(e.seq));
    bus.setTime(1);
    for (let i = 0; i < 500; i++) bus.emit({ class: 'walk-step', x: i, y: 0, z: 0 });
    expect(bus.emittedThisTick).toBe(500);
    expect(bus.maxEmittedPerTick).toBe(500);
    expect(heard).toHaveLength(500);
    expect(heard[0]).toBe(0);
    expect(heard[499]).toBe(499);
  });
});

describe('every class round-trips through emit', () => {
  it.each(Object.keys(SOUND_CLASSES) as SoundClass[])('%s', (cls) => {
    const bus = new SoundBus();
    const profile = SOUND_CLASSES[cls];
    const e = bus.emit({ class: cls, x: 0, y: 0, z: 0, ...bodiesFor(cls) });
    expect(e.class).toBe(cls);
    expect(e.paintRadius).toBe(profile.paintRadius);
    expect(e.hearingRadius).toBe(profile.hearingRadius);
    expect(e.intensity).toBe(profile.intensity);
    expect(e.waveSpeed).toBe(WAVE_SPEEDS[profile.wave]);
    // No aim was given, so every class comes out omnidirectional regardless of its profile cone.
    expect(e.coneAngleDeg).toBe(360);
  });
});

describe('who made the noise (§3.2)', () => {
  it('carries source and emitter through the bus unchanged, to the listener and the caller', () => {
    const bus = new SoundBus();
    let heard: SoundEvent | null = null;
    bus.subscribe((e) => {
      heard = e;
    });
    const e = bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0, source: 'spider', emitter: 42 });
    expect(e.source).toBe('spider');
    expect(e.emitter).toBe(42);
    expect(heard).toBe(e);
  });

  it('takes every source, and an emitter of any shape, without interpreting either', () => {
    // The bus stamps; it does not decide. A spider with the player's id is a strange world and
    // the bus's job is to report it faithfully, not to correct it.
    const bus = new SoundBus();
    const sources: SoundSource[] = ['player', 'prop', 'spider', 'world'];
    for (const source of sources) {
      const e = bus.emit({ class: 'q-ping', x: 0, y: 0, z: 0, source, emitter: PLAYER_EMITTER_ID });
      expect(e.source).toBe(source);
      expect(e.emitter).toBe(PLAYER_EMITTER_ID);
    }
  });

  it('defaults each half of the pair independently', () => {
    // Naming one and not the other is a mistake worth being able to see, so neither field
    // reaches for the other's value.
    const bus = new SoundBus();
    expect(bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0, source: 'spider' }).emitter)
      .toBe(NO_EMITTER);
    expect(bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0, emitter: 7 }).source).toBe('world');
  });

  it('pins the two emitter ids', () => {
    expect(PLAYER_EMITTER_ID).toBe(0);
    expect(NO_EMITTER).toBe(-1);
    expect(NO_EMITTER).not.toBe(PLAYER_EMITTER_ID);
  });
});

describe('eventTint — amber vs green (§3.2)', () => {
  const bus = new SoundBus();
  const step = (source: SoundSource, emitter: number): SoundEvent =>
    bus.emit({ class: 'walk-step', x: 0, y: 0, z: 0, source, emitter });

  it('is a relationship, not a property: one event, two viewers, two answers', () => {
    // The whole reason the bus has no `'self'` source. This event was emitted once, by player 0,
    // and it must read amber on that player's screen and green on their teammate's.
    const mine = step('player', PLAYER_EMITTER_ID);
    expect(eventTint(mine, PLAYER_EMITTER_ID)).toBe('self');
    expect(eventTint(mine, 1)).toBe('teammate');
  });

  it('a teammate is anybody else with a player source', () => {
    expect(eventTint(step('player', 1), PLAYER_EMITTER_ID)).toBe('teammate');
    expect(eventTint(step('player', 3), PLAYER_EMITTER_ID)).toBe('teammate');
    expect(eventTint(step('player', NO_EMITTER), PLAYER_EMITTER_ID)).toBe('teammate');
  });

  it('the spider is the spider to everyone, whatever id it carries', () => {
    expect(eventTint(step('spider', 9), PLAYER_EMITTER_ID)).toBe('spider');
    expect(eventTint(step('spider', PLAYER_EMITTER_ID), PLAYER_EMITTER_ID)).toBe('spider');
  });

  it('source decides the family first, so a matching id never smuggles in `self`', () => {
    // The mutation this exists to catch: comparing emitters before asking what made the noise.
    // A knocked can and a hoist both carry §3.2's prop colour, and neither is ever you.
    expect(eventTint(step('prop', PLAYER_EMITTER_ID), PLAYER_EMITTER_ID)).toBe('prop');
    expect(eventTint(step('world', PLAYER_EMITTER_ID), PLAYER_EMITTER_ID)).toBe('prop');
    expect(eventTint(step('world', NO_EMITTER), NO_EMITTER)).toBe('prop');
  });
});

/**
 * The radii are the half of §1 the wiring cannot guarantee.
 *
 * "One bus, two senses" is usually read as a claim about plumbing — one stream, two subscribers,
 * so neither can be fed something the other was not. That much the architecture does enforce.
 * What it never enforced is the *numbers* on the event, and those come from the emitter: before
 * this guard, `paintRadius: 0` produced a mixer voice at a real footstep's gain while unlocking
 * nothing (a sound with no paint, written in one line through the public API), and
 * `paintRadius: NaN` unlocked 36 250 dots against a walk-step's 1 838, because every reject test
 * downstream is `if (tooFar) continue` and NaN fails it — so the trapdoor floodlights the map
 * instead of darkening it.
 *
 * These assert the rejection, not the repair. A clamp would keep the violation reachable and
 * merely quiet, and a law that fails silently is worse than one that throws.
 */
describe('a radius is positive, finite metres, or it is not a sound (§1)', () => {
  const at = { x: 0, y: 0, z: 0 } as const;

  for (const field of ['paintRadius', 'hearingRadius'] as const) {
    for (const bad of [0, -1, -0.0001, NaN, Infinity, -Infinity]) {
      it(`rejects ${field}=${String(bad)}`, () => {
        const bus = new SoundBus();
        expect(() => bus.emit({ class: 'walk-step', ...at, [field]: bad })).toThrow(
          /positive, finite/,
        );
        bus.dispose();
      });
    }

    it(`rejects a dev-panel slider that drags ${field} to zero`, () => {
      const bus = new SoundBus();
      bus.tunables.classes['walk-step'][field] = 0;
      expect(() => bus.emit({ class: 'walk-step', ...at })).toThrow(/positive, finite/);
      bus.dispose();
    });
  }

  it('nothing is emitted when a radius is refused — the counter does not move', () => {
    const bus = new SoundBus();
    const heard: number[] = [];
    bus.subscribe((e) => heard.push(e.seq));
    const before = bus.emitted;
    expect(() => bus.emit({ class: 'walk-step', ...at, paintRadius: NaN })).toThrow();
    expect(bus.emitted).toBe(before);
    expect(heard).toEqual([]);
    bus.dispose();
  });

  it('the seq is not burned by a refused emit — the next honest sound gets it', () => {
    const bus = new SoundBus();
    const first = bus.emit({ class: 'walk-step', ...at });
    expect(() => bus.emit({ class: 'walk-step', ...at, paintRadius: 0 })).toThrow();
    const next = bus.emit({ class: 'walk-step', ...at });
    expect(next.seq).toBe(first.seq + 1);
    bus.dispose();
  });

  it('every shipped class passes its own defaults, on every material', () => {
    const bus = new SoundBus();
    for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
      // Which materials a class may be handed is the bus's own question, asked of the predicates
      // rather than of the class's name — a composed class is handed a pair, and every pair.
      const mats = isContactClass(cls) ? [0, 1, 2, 3] : [undefined];
      const objMats = isComposedClass(cls) ? [0, 1, 2, 3] : [undefined];
      for (const mat of mats) {
        for (const objMat of objMats) {
          expect(() =>
            bus.emit({
              class: cls,
              ...at,
              ...(mat === undefined ? {} : { mat }),
              ...(objMat === undefined ? {} : { objMat }),
            }),
          ).not.toThrow();
        }
      }
    }
    bus.dispose();
  });

  it('the quietest real sound in the game is still a sound — a dust crouch-step survives', () => {
    const bus = new SoundBus();
    const e = bus.emit({ class: 'crouch-step', ...at, mat: 3 });
    expect(e.paintRadius).toBeGreaterThan(0);
    expect(e.hearingRadius).toBeGreaterThan(0);
    bus.dispose();
  });
});
