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
  SOUND_CLASSES,
  SoundBus,
  WAVE_SPEEDS,
  type SoundClass,
  type SoundEvent,
} from '../src/paint/soundEvents';

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

  it('SUSPECTED BUG: NaN passes straight through the clamp', () => {
    // `t < 0 ? 0 : t > 1 ? 1 : t` leaves NaN as NaN, so a NaN impact speed produces a NaN paint
    // radius, which would silently poison the reveal rather than failing loudly.
    expect(SoundBus.landingRadius(NaN)).toBeNaN();
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
      x: 1, y: 2, z: 3,
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

  it('does not clamp position or radii — the bus stamps, it does not sanitise', () => {
    const bus = new SoundBus();
    const e = bus.emit({ class: 'q-ping', x: -1e6, y: 0, z: 0, paintRadius: -3 });
    expect(e.x).toBe(-1e6);
    expect(e.paintRadius).toBe(-3);
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

describe('every class round-trips through emit', () => {
  it.each(Object.keys(SOUND_CLASSES) as SoundClass[])('%s', (cls) => {
    const bus = new SoundBus();
    const profile = SOUND_CLASSES[cls];
    const e = bus.emit({ class: cls, x: 0, y: 0, z: 0 });
    expect(e.class).toBe(cls);
    expect(e.paintRadius).toBe(profile.paintRadius);
    expect(e.hearingRadius).toBe(profile.hearingRadius);
    expect(e.intensity).toBe(profile.intensity);
    expect(e.waveSpeed).toBe(WAVE_SPEEDS[profile.wave]);
    // No aim was given, so every class comes out omnidirectional regardless of its profile cone.
    expect(e.coneAngleDeg).toBe(360);
  });
});
