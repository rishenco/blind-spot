/**
 * The unified hearing law — vision §3.1, and the §3.3 table's right-hand column.
 *
 * An event reaches an ear only when the distance is inside *both* the ear's own range and the
 * event's own carry radius. One predicate, `SoundBus.canHear`, answers that for the player's
 * paint today and for the spider's hearing at M4.
 *
 * **Why this file exists as its own thing.** The game cannot currently produce the situation the
 * law is about. There is exactly one emitter (the player) and it is also the only listener, so
 * every event in every scripted run is emitted a few centimetres from the ears: a footstep at
 * the feet, a ping at the head. `heard` is ~0 and both gates pass trivially, which means the
 * whole existing suite would go green against a hearing gate that did not exist at all. So the
 * tests below build the thing the game has no way to build yet — an emitter that is somewhere
 * else — and they check the `min` from *both* sides, because a test that only checks one side
 * passes against `distance <= listenerRange`, which is exactly the code this replaced.
 */

import { describe, expect, it } from 'vitest';
import { StaticWorld } from '../src/core/collision';
import { PaintSystem, defaultPerceptionTunables } from '../src/paint/paintSystem';
import {
  PLAYER_EMITTER_ID,
  SOUND_CLASSES,
  SoundBus,
  type SoundClass,
  type SoundEvent,
} from '../src/paint/soundEvents';
import { buildRoom } from '../src/world/room';

/** The rig's own range (§3.1: base 18 m, raised by the Sensitivity chip). */
const RIG_RANGE = defaultPerceptionTunables().hearingRange;

/** An event of `cls`, stamped by a real bus, sitting at (x, y, z). */
function eventAt(cls: SoundClass, x: number, y: number, z: number): SoundEvent {
  return new SoundBus().emit({
    class: cls,
    source: 'player',
    emitter: PLAYER_EMITTER_ID,
    x,
    y,
    z,
  });
}

describe('SoundBus.canHear — both gates, or neither (§3.1)', () => {
  it('pins the two carries the rest of this file leans on', () => {
    // A crouch-step that carried 24 m would make every "clipped by the event" case below pass
    // for the wrong reason, so the two numbers are stated where they are used.
    expect(SOUND_CLASSES['crouch-step'].hearingRadius).toBe(2);
    expect(SOUND_CLASSES['sprint-step'].hearingRadius).toBe(24);
    expect(SOUND_CLASSES['e-ping'].hearingRadius).toBe(30);
    expect(RIG_RANGE).toBe(18);
  });

  it('the event clips the ear: a 2 m crouch-step is silent 10 m away, to an 18 m ear', () => {
    // §3.1 verbatim. This is the half that a listener-range-only gate gets wrong, and the half
    // that decides whether §3.3's right column means anything at all.
    const step = eventAt('crouch-step', 10, 0, 0);
    expect(SoundBus.canHear(step, 0, 0, 0, RIG_RANGE)).toBe(false);
    expect(SoundBus.canHear(step, 8.5, 0, 0, RIG_RANGE)).toBe(true);
  });

  it('the ear clips the event: a 30 m e-ping is silent 20 m away, to an 18 m ear', () => {
    // And this is the half a carry-only gate gets wrong. Both are needed; either alone is a
    // predicate that passes half the table.
    const ping = eventAt('e-ping', 20, 0, 0);
    expect(SoundBus.canHear(ping, 0, 0, 0, RIG_RANGE)).toBe(false);
    expect(SoundBus.canHear(ping, 3, 0, 0, RIG_RANGE)).toBe(true);
  });

  it('a sprint-step at the same 10 m, to the same ear, is heard', () => {
    // The control for the crouch-step case: the distance and the listener are identical and
    // only the class changed, so the difference is the carry radius and nothing else.
    const step = eventAt('sprint-step', 10, 0, 0);
    expect(SoundBus.canHear(step, 0, 0, 0, RIG_RANGE)).toBe(true);
  });

  it('is inclusive at the boundary, from whichever side the boundary comes', () => {
    // `<=`, not `<`. Exactly at the limit is audible; one ulp past it is not.
    const carryLimited = eventAt('crouch-step', 2, 0, 0);
    expect(SoundBus.canHear(carryLimited, 0, 0, 0, RIG_RANGE)).toBe(true);
    expect(SoundBus.canHear(eventAt('crouch-step', 2.0000001, 0, 0), 0, 0, 0, RIG_RANGE)).toBe(false);

    const earLimited = eventAt('e-ping', 18, 0, 0);
    expect(SoundBus.canHear(earLimited, 0, 0, 0, RIG_RANGE)).toBe(true);
    expect(SoundBus.canHear(eventAt('e-ping', 18.0000001, 0, 0), 0, 0, 0, RIG_RANGE)).toBe(false);
  });

  it('measures in three dimensions, so a floor above is a distance and not a free listen', () => {
    // A landing carries 28 m, so it is the ear that clips here; the point is that the vertical
    // component counts. Two floors up is far away even when it is directly overhead.
    const overhead = eventAt('landing', 0, 20, 0);
    expect(SoundBus.canHear(overhead, 0, 0, 0, RIG_RANGE)).toBe(false);
    expect(SoundBus.canHear(overhead, 0, 4, 0, RIG_RANGE)).toBe(true);
    // And the diagonal is a real hypotenuse, not a per-axis test: 12-9-12 is 19.2 m away.
    const corner = eventAt('landing', 12, 9, 12);
    expect(Math.hypot(12, 9, 12)).toBeGreaterThan(RIG_RANGE);
    expect(SoundBus.canHear(corner, 0, 0, 0, RIG_RANGE)).toBe(false);
  });

  it('one predicate, two ears: the same event answers differently for different ranges', () => {
    // The reason it is a static on the bus rather than a method on the paint system. An e-ping
    // 25 m away is beyond the rig's 18 m and inside its own 30 m carry, so whether it is heard
    // is entirely a property of the ear asking — which is what M4 needs.
    const ping = eventAt('e-ping', 25, 0, 0);
    expect(SoundBus.canHear(ping, 0, 0, 0, RIG_RANGE)).toBe(false);
    expect(SoundBus.canHear(ping, 0, 0, 0, 26)).toBe(true);
    // But no ear, however good, hears past the event's own carry.
    const crouch = eventAt('crouch-step', 10, 0, 0);
    expect(SoundBus.canHear(crouch, 0, 0, 0, 1000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/**
 * Three places in the real room, chosen so that every "painted nothing" below means the gate
 * refused rather than that there was nothing there to find. All three sit in open air with
 * floor under them and geometry within a couple of metres; the far one is inside the side
 * chamber, which is 20.9 m from the ear and the only way to get past 18 m without leaving the
 * building.
 */
const EAR = { x: -13, y: 1.5, z: 0 };
/** 10 m from the ear: the chokepoint doorway, both jambs and the floor within a metre or two. */
const AWAY = { x: -3, y: 1.5, z: 0 };
/** 20.9 m from the ear, deep in the side chamber. */
const FAR = { x: 7, y: 1.5, z: 6 };

interface Painted {
  unlockedDots: number;
  liveWaves: number;
}

/** Emits one event `spec` metres from the ear and reports what the reveal did about it. */
function paintFrom(cls: SoundClass, at: { x: number; y: number; z: number }): Painted {
  const world = new StaticWorld();
  const room = buildRoom(world);
  const paint = new PaintSystem(world);
  const bus = new SoundBus();
  bus.subscribe(paint.handle);

  paint.setListener(EAR.x, EAR.y, EAR.z);
  paint.advance(0);
  bus.setTime(0);
  bus.emit({ class: cls, source: 'player', emitter: PLAYER_EMITTER_ID, x: at.x, y: at.y, z: at.z });
  // Unlocking is amortised over frames (law 5), so finish the outstanding work before counting.
  paint.structured.drain();

  const result = { unlockedDots: paint.structured.getStats().unlockedDots, liveWaves: paint.liveWaves.length };
  paint.dispose();
  room.dispose();
  return result;
}

describe('the reveal obeys the same law (§3.1)', () => {
  it('a crouch-step 10 m away paints nothing — its carry is 2 m', () => {
    const painted = paintFrom('crouch-step', AWAY);
    expect(painted.unlockedDots).toBe(0);
    expect(painted.liveWaves).toBe(0);
  });

  it('a sprint-step from the same spot paints — its carry is 24 m', () => {
    // Same distance, same ear, same room: only the class differs, so the two tests together are
    // the event's carry deciding, and nothing else.
    const painted = paintFrom('sprint-step', AWAY);
    expect(painted.unlockedDots).toBeGreaterThan(0);
    expect(painted.liveWaves).toBe(1);
  });

  it('the crouch-step is heard when the ear is close enough for its 2 m carry', () => {
    // The control that stops the first test passing because crouch-steps paint nothing at all.
    const painted = paintFrom('crouch-step', { x: EAR.x + 1, y: EAR.y, z: EAR.z });
    expect(painted.unlockedDots).toBeGreaterThan(0);
    expect(painted.liveWaves).toBe(1);
  });

  it('an e-ping 20.9 m away paints nothing — the rig only hears 18 m of its 30 m carry', () => {
    // The other side of the `min`, through the reveal: a 22 m beam that would have lit half the
    // room is not heard at all, so none of it arrives.
    const painted = paintFrom('e-ping', FAR);
    expect(painted.unlockedDots).toBe(0);
    expect(painted.liveWaves).toBe(0);
  });
});
