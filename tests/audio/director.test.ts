/**
 * The decision layer, checked without making a sound.
 *
 * Everything the player is *promised* about what they hear — §3.1's one hearing law, §3.3's two
 * columns, §3.9's loudness — is arithmetic, and this file is where it is checked as arithmetic.
 * No context, no render, no sample rate: if a level is wrong the failure points at one pure
 * function instead of at a biquad.
 *
 * The gate assertions are the ones worth reading twice. They are written from *both* sides
 * (the listener's range and the event's carry) and cross-checked against `SoundBus.canHear`
 * itself over a sweep, because the failure mode they exist for is not "the gate is wrong" — it
 * is "the gate is a second, slightly different copy of the gate the paint system uses", which
 * looks correct in every single-case test and makes sight and hearing disagree in play.
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIO_CLASS_VOICES,
  AudioDirector,
  EDGE_GAIN,
  NEAR_FIELD_M,
  gainFor,
  isContactVoice,
  type ListenerState,
} from '../../src/audio/director';
import {
  MAT_CONCRETE,
  MAT_DUST,
  MAT_METAL,
  MAT_STONE,
  MATERIAL_NAMES,
  materialLoudness,
} from '../../src/paint/materials';
import {
  PLAYER_EMITTER_ID,
  SOUND_CLASSES,
  SoundBus,
  isComposedClass,
  type SoundClass,
  type SoundEvent,
} from '../../src/paint/soundEvents';

const ORIGIN: ListenerState = { x: 0, y: 0, z: 0, range: 18, emitter: PLAYER_EMITTER_ID };

/** One event, emitted through the real bus so every radius is the real radius. */
function emit(
  cls: SoundClass,
  at: { x?: number; y?: number; z?: number } = {},
  extra: Partial<{
    mat: number;
    objMat: number;
    source: 'player' | 'prop' | 'spider' | 'world';
    emitter: number;
  }> = {},
): SoundEvent {
  const bus = new SoundBus();
  const ping = !SOUND_CLASSES[cls] ? {} : cls.endsWith('ping') ? { dirX: 1, dirY: 0, dirZ: 0 } : {};
  /*
   * A composed class is refused by the bus unless it is told what struck the surface, so the
   * helper names one when the class needs one and never otherwise. Concrete, because its
   * multiplier is 1.0 and so is the geometric mean of it with itself: the pair costs the class
   * nothing, and every sweep below goes on measuring the class and the *struck* surface exactly
   * as it did before there were two-bodied classes. A caller that wants a real pair passes its
   * own `objMat` through `extra`.
   */
  const struck = isComposedClass(cls) ? { objMat: MAT_CONCRETE } : {};
  return bus.emit({
    class: cls,
    x: at.x ?? 0,
    y: at.y ?? 0,
    z: at.z ?? 0,
    ...ping,
    ...struck,
    ...extra,
  });
}

describe('the director is a decision, not a sound', () => {
  /**
   * The guard the whole split exists for. `src/audio/director.ts` must import nothing that needs
   * a browser, a device or a user gesture — the day it does, every assertion in this file starts
   * depending on an audio backend and the pure layer has quietly stopped being pure.
   */
  it('runs in an environment with no WebAudio at all', () => {
    expect(typeof AudioContext).toBe('undefined');
    expect(typeof OfflineAudioContext).toBe('undefined');
    // And it still decides, in that environment.
    expect(new AudioDirector(ORIGIN).decide(emit('walk-step', { x: 3 }))).not.toBeNull();
  });
});

describe('the hearing gate is the bus\'s, from both sides (§3.1)', () => {
  it('answers exactly what SoundBus.canHear answers, over every class and a sweep of distances', () => {
    // The cross-check that makes a second copy of the predicate impossible to introduce
    // accidentally: not "the gate works" but "the gate is *that* gate".
    const director = new AudioDirector(ORIGIN);
    let heard = 0;
    let deaf = 0;
    for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
      for (let d = 0; d <= 40; d += 0.25) {
        const event = emit(cls, { x: d });
        const expected = SoundBus.canHear(event, ORIGIN.x, ORIGIN.y, ORIGIN.z, ORIGIN.range);
        expect(director.decide(event) !== null, `${cls} at ${d} m`).toBe(expected);
        if (expected) heard++;
        else deaf++;
      }
    }
    // Both branches were actually exercised — a sweep that is all-audible proves nothing.
    expect(heard).toBeGreaterThan(50);
    expect(deaf).toBeGreaterThan(50);
  });

  it('goes deaf beyond the listener\'s own range, even to something that carries further', () => {
    // A sprint-step carries 24 m. An 18 m ear does not get 24 m of it.
    const near = new AudioDirector(ORIGIN).decide(emit('sprint-step', { x: 17 }));
    const far = new AudioDirector(ORIGIN).decide(emit('sprint-step', { x: 19 }));
    expect(near).not.toBeNull();
    expect(far).toBeNull();
    // And the Sensitivity chip's +8 m is all it takes to hear it — the range is the only thing
    // that changed, so this is the listener's half of the gate and nothing else.
    const sharp = new AudioDirector({ ...ORIGIN, range: 26 }).decide(emit('sprint-step', { x: 19 }));
    expect(sharp).not.toBeNull();
  });

  it('goes deaf beyond the *event\'s* carry, however good the ears are', () => {
    // §3.1, the strict half: "a crouch-step carries 2 m; standing 10 m away you do not hear it,
    // and neither does anything else." A 60 m ear does not change that.
    const bat = new AudioDirector({ ...ORIGIN, range: 60 });
    expect(bat.decide(emit('crouch-step', { x: 1.9 }))).not.toBeNull();
    expect(bat.decide(emit('crouch-step', { x: 2.1 }))).toBeNull();
    // The material moves that boundary, because it moved the carry: dust halves it, steel
    // stretches it, and the ear never learns about either directly.
    expect(bat.decide(emit('crouch-step', { x: 2.1 }, { mat: MAT_METAL }))).not.toBeNull();
    expect(bat.decide(emit('crouch-step', { x: 1.4 }, { mat: MAT_DUST }))).toBeNull();
  });
});

describe('how loud, at a distance', () => {
  it('falls off as 1/d outside the near field', () => {
    const event = emit('sprint-step', { x: 0 });
    // Halving the distance doubles the amplitude — 6 dB per doubling, the inverse-distance law.
    expect(gainFor(event, 12) / gainFor(event, 6)).toBeCloseTo(0.5, 12);
    expect(gainFor(event, 6) / gainFor(event, 3)).toBeCloseTo(0.5, 12);
  });

  it('stops rising inside the near field, so a sound at the ear is not infinite', () => {
    const ping = emit('e-ping');
    // Every ping is emitted at head height, i.e. at zero distance from the ears.
    expect(Number.isFinite(gainFor(ping, 0))).toBe(true);
    expect(gainFor(ping, 0)).toBe(gainFor(ping, NEAR_FIELD_M));
    expect(gainFor(ping, NEAR_FIELD_M / 2)).toBe(gainFor(ping, NEAR_FIELD_M));
    expect(gainFor(ping, NEAR_FIELD_M * 2)).toBeLessThan(gainFor(ping, NEAR_FIELD_M));
  });

  it('arrives at exactly EDGE_GAIN at the edge of its carry — every class, every material', () => {
    // The property that makes the gate a whisper rather than a click, and the reason the level
    // law and the §3.3 table are the same statement: at the last audible metre, everything is
    // equally quiet, whatever it is and whatever it struck.
    let checked = 0;
    for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
      for (const mat of [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST]) {
        const event = emit(cls, {}, isContactVoice(cls) ? { mat } : {});
        if (event.hearingRadius < NEAR_FIELD_M) continue; // see the next test
        expect(gainFor(event, event.hearingRadius), `${cls}/${MATERIAL_NAMES[mat]}`).toBeCloseTo(
          EDGE_GAIN,
          12,
        );
        checked++;
      }
    }
    // Ten classes over four materials, less the single cell that never reaches the near field
    // (the next test names it). It read 23 while the table held six classes and 35 at nine: this
    // is the *cardinality of the sweep*, pinned so that a class silently dropping out of the
    // loop is a failure rather than a quieter test, and it moves when the class table does.
    expect(checked).toBe(39);
  });

  it('except for the one sound that never carries as far as your own feet', () => {
    // A crouch-step on dust carries 1.2 m — less than the 1.5 m from the rig's ears to its own
    // soles — so its whole audible life happens inside the near field and it tops out at
    // 1.2/1.5 of the edge gain. That is the right answer rather than an exception to patch: a
    // sound that dies closer than your own footfall never gets to be as loud as the quietest
    // thing you can hear at range. It is also the only one of the thirty-six, which is the
    // number worth pinning — a second one appearing means a class or a multiplier moved. (It
    // was the only one of twenty-four before the three throw classes joined the table; the
    // quietest cell either of them can reach is a dust-on-dust knock at 2.4 m.)
    const belowNearField = (Object.keys(SOUND_CLASSES) as SoundClass[]).flatMap((cls) =>
      [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST]
        .map((mat) => emit(cls, {}, isContactVoice(cls) ? { mat } : {}))
        .filter((e) => e.hearingRadius < NEAR_FIELD_M)
        .map((e) => `${cls}/${MATERIAL_NAMES[e.mat ?? MAT_CONCRETE]}`),
    );
    expect(belowNearField).toEqual(['crouch-step/dust']);
    const dusty = emit('crouch-step', {}, { mat: MAT_DUST });
    expect(gainFor(dusty, dusty.hearingRadius)).toBeCloseTo((EDGE_GAIN * 1.2) / NEAR_FIELD_M, 12);
    expect(gainFor(dusty, dusty.hearingRadius)).toBeLessThan(EDGE_GAIN);
  });

  it('charges for height: a floor above is a distance, not a discount', () => {
    /*
     * The gain law's third dimension, asserted on the gain rather than on the number the spec
     * reports afterwards. `decide` measures the distance once and both the level and
     * `spec.distance` are drawn from it, so a self-consistency check — "the gain matches the
     * distance it says it used" — cannot tell a 3D measurement from a 2D one that happens to be
     * quoted honestly. `tests/hearing.test.ts` makes the 3D claim about `canHear`; this is the
     * same claim about how loud the thing that got through the gate arrives.
     *
     * It matters at tower scale rather than in this room. §3.4 gives the loud class a bleed
     * through floors, which is the whole reason the vertical axis exists: an event one storey up
     * is *far*, and a mixer that measured only the floor plan would put it at the listener's ear
     * — a footfall on the ceiling arriving at the level of your own boots.
     */
    const eightUp = new AudioDirector(ORIGIN).decide(emit('walk-step', { y: 8 }));
    const eightAlong = new AudioDirector(ORIGIN).decide(emit('walk-step', { x: 8 }));
    // A walk-step carries 11 m and the ear reaches 18, so 8 m is audible whichever way it lies.
    expect(eightUp, 'a walk-step 8 m overhead is inside both halves of the gate').not.toBeNull();
    expect(eightAlong).not.toBeNull();
    expect(eightUp!.gain).toBeCloseTo(eightAlong!.gain, 12);
    // And neither is riding the near-field clamp, which is exactly how a dropped axis hides: a
    // 2D distance of zero clamps to 1.5 m and reads as the loudest a walk-step can ever be.
    expect(eightUp!.gain).toBeLessThan(gainFor(emit('walk-step'), 0));
  });

  it('is loudest at your own feet, and that is the ceiling of the whole mix', () => {
    // `NEAR_FIELD_M` is ear-to-foot, so nothing outranks your own step on the same surface.
    const loudest = Math.max(
      ...(Object.keys(SOUND_CLASSES) as SoundClass[]).flatMap((cls) =>
        [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST].map((mat) => {
          const event = emit(cls, {}, isContactVoice(cls) ? { mat } : {});
          return gainFor(event, 0);
        }),
      ),
    );
    // A landing on steel, at the ear: 42 m of carry over 1.5 m of near field, times EDGE_GAIN.
    expect(loudest).toBeCloseTo((EDGE_GAIN * 42) / NEAR_FIELD_M, 9);
    // Under unity with room to spare, because two of these can land in the same millisecond.
    expect(loudest).toBeLessThan(0.7);
  });
});

describe('§3.9: the multiplier is the only thing that makes one material louder', () => {
  /**
   * The invariant §3.9 states in one line: "a material's attack-window RMS minus concrete's
   * equals 20·log10(multiplier), within half a dB, for all four."
   *
   * Checked here on the *gain*, which is the director's whole contribution to it — the voices
   * are normalized on their attack so that a gain ratio is an attack-RMS ratio, and
   * `tests/audio/materialVoices.test.ts` checks that half on rendered audio.
   */
  it('scales the gain by exactly the multiplier, in dB, for all four materials', () => {
    const at = 5;
    const gainOn = (mat: number) => gainFor(emit('walk-step', {}, { mat }), at);
    const reference = gainOn(MAT_CONCRETE);
    for (const mat of [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST]) {
      const deltaDb = 20 * Math.log10(gainOn(mat) / reference);
      const promised = 20 * Math.log10(materialLoudness(mat));
      expect(Math.abs(deltaDb - promised), `${MATERIAL_NAMES[mat]}: ${deltaDb.toFixed(2)} dB`)
        .toBeLessThanOrEqual(0.5);
    }
  });

  it('and applies it once, not twice — the radius already carries it', () => {
    // The mistake this catches is a director that multiplies by `materialLoudness` on top of a
    // radius that was already multiplied in `SoundBus.emit`: metal would arrive at 2.25×, i.e.
    // 7.0 dB where §3.9 promises 3.5, and nothing outside a measurement would notice.
    const at = 5;
    const metal = gainFor(emit('walk-step', {}, { mat: MAT_METAL }), at);
    const concrete = gainFor(emit('walk-step', {}, { mat: MAT_CONCRETE }), at);
    expect(metal / concrete).toBeCloseTo(1.5, 12);
    expect(20 * Math.log10(metal / concrete)).toBeCloseTo(3.522, 3);
  });

  /**
   * The composed half of the same law: a pair of bodies reaches the ear at the mean of their two
   * promises, in dB, and it does so without the director ever knowing there were two.
   *
   * `gainFor` reads `hearingRadius` and nothing else, so the geometric mean the bus applied is
   * already in the level by the time the mixer sees it — which is what keeps §3.9's "the level
   * is the carry radius" true for pairs as well as for surfaces. Read in decibels the geometric
   * mean becomes the arithmetic mean of the two rows of the promised-dB table, which is the
   * whole content of choosing it over the product: the product would double the distance from
   * concrete at every pair.
   */
  it('prices a two-bodied contact at the mean of the two promises, in dB', () => {
    const at = 5;
    const MATERIALS = [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST];
    const promisedDb = (mat: number): number => 20 * Math.log10(materialLoudness(mat));
    const gainOn = (obj: number, surf: number): number =>
      gainFor(emit('prop-impact', {}, { mat: surf, objMat: obj }), at);
    const reference = gainOn(MAT_CONCRETE, MAT_CONCRETE);
    for (const obj of MATERIALS) {
      for (const surf of MATERIALS) {
        const label = `${MATERIAL_NAMES[obj]} on ${MATERIAL_NAMES[surf]}`;
        const deltaDb = 20 * Math.log10(gainOn(obj, surf) / reference);
        expect(deltaDb, label).toBeCloseTo((promisedDb(obj) + promisedDb(surf)) / 2, 12);
      }
    }
    // And the diagonal is the single-material promise, unchanged: a steel can on a steel plate
    // arrives at the same 3.5 dB above concrete that a footfall on that plate does.
    expect(20 * Math.log10(gainOn(MAT_METAL, MAT_METAL) / reference)).toBeCloseTo(3.522, 3);
  });

  it('reads the same loudness the spider will: level tracks hearingRadius, class by class', () => {
    // Sight, hearing and the hunt from one number. If a class is ever given a volume of its own
    // beside its §3.3 row, this is what says so.
    const at = 6;
    for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
      const event = emit(cls);
      expect(gainFor(event, at), cls).toBeCloseTo((EDGE_GAIN * event.hearingRadius) / at, 12);
    }
  });
});

describe('what a spec says', () => {
  it('gives every class a voice, and the voice agrees with the bus about contact', () => {
    const director = new AudioDirector(ORIGIN);
    for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
      const spec = director.decide(emit(cls, { x: 1 }))!;
      expect(spec, cls).not.toBeNull();
      expect(spec.cls).toBe(cls);
      expect(['contact', 'ping']).toContain(spec.voice);
      // A contact carries a material; a ping carries none. Same statement as CONTACT_CLASSES,
      // read off the spec the builder actually receives.
      if (spec.voice === 'contact') expect(spec.mat, cls).not.toBeNull();
      else expect(spec.mat, cls).toBeNull();
      expect(spec.durationSec).toBeGreaterThan(0.4);
      expect(spec.toneHz).toBeGreaterThan(0);
    }
  });

  it('carries the material it was given, unchanged, for every material', () => {
    const director = new AudioDirector(ORIGIN);
    for (const mat of [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST]) {
      expect(director.decide(emit('landing', { x: 1 }, { mat }))!.mat, MATERIAL_NAMES[mat]).toBe(mat);
    }
  });

  it('carries the second body too, and null when there is not one', () => {
    // The wire §3.9's timbre half rides on: `voices.ts` selects the exciter row from `objMat` and
    // the modal bank from `mat`, so a director that dropped this field would make every thrown
    // thing sound like the floor it hit — and nothing about the level would move, because the
    // level is the radius and the radius already spent the pair. This is the only assertion
    // between the bus and the synthesis that says the second material survives the trip.
    const director = new AudioDirector(ORIGIN);
    for (const obj of [MAT_CONCRETE, MAT_METAL, MAT_STONE, MAT_DUST]) {
      const spec = director.decide(emit('prop-impact', { x: 1 }, { mat: MAT_STONE, objMat: obj }))!;
      expect(spec.objMat, MATERIAL_NAMES[obj]).toBe(obj);
      expect(spec.mat, MATERIAL_NAMES[obj]).toBe(MAT_STONE);
    }
    // A footfall struck the floor with a body the game has no material for, and a ping struck
    // nothing at all. Both say so, and `null` is what puts the voice back on the diagonal.
    expect(director.decide(emit('walk-step', { x: 1 }))!.objMat).toBeNull();
    expect(director.decide(emit('q-ping'))!.objMat).toBeNull();
  });

  it('carries the cone, so the two pings can sound like their shapes (§3.5)', () => {
    const director = new AudioDirector(ORIGIN);
    expect(director.decide(emit('q-ping'))!.coneAngleDeg).toBe(360);
    expect(director.decide(emit('e-ping'))!.coneAngleDeg).toBe(110);
    // And a footstep is omnidirectional, which is why the cone alone tells the pings apart.
    expect(director.decide(emit('walk-step', { x: 1 }))!.coneAngleDeg).toBe(360);
  });

  it('shapes the gait ladder with brightness rather than with level', () => {
    // Level is `hearingRadius`; effort is `bright`. A crouch-step is a duller strike, not just a
    // quieter one, so the two can be told apart at the same distance and the same volume.
    const v = AUDIO_CLASS_VOICES;
    expect(v['crouch-step'].bright).toBeLessThan(v['walk-step'].bright);
    expect(v['walk-step'].bright).toBeLessThan(v['sprint-step'].bright);
    expect(v['sprint-step'].bright).toBeLessThan(v.landing.bright);
    // And the thump gets lower as the contact gets heavier, which is the other half of weight.
    expect(v.landing.toneHz).toBeLessThan(v['sprint-step'].toneHz);
    expect(v['sprint-step'].toneHz).toBeLessThan(v['walk-step'].toneHz);
  });

  it('lasts long enough to contain metal\'s ring, in every contact class', () => {
    // Metal's longest mode is 0.38 s. A voice scheduled for less than that would cut §3.9's
    // fingerprint off with the scheduler, and the material test would be measuring the clock.
    for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
      if (!isContactVoice(cls)) continue;
      expect(AUDIO_CLASS_VOICES[cls].durationSec, cls).toBeGreaterThan(0.45);
    }
  });

  it('seeds the voice from the event, so the same event is the same noise', () => {
    const bus = new SoundBus();
    const director = new AudioDirector(ORIGIN);
    const first = bus.emit({ class: 'walk-step', x: 1, y: 0, z: 0 });
    const second = bus.emit({ class: 'walk-step', x: 1, y: 0, z: 0 });
    expect(director.decide(first)!.seed).toBe(first.seq);
    // Consecutive footsteps differ, so a stride is not an audible loop.
    expect(director.decide(second)!.seed).not.toBe(director.decide(first)!.seed);
  });

  it('reports the distance it priced the gain at', () => {
    const spec = new AudioDirector(ORIGIN).decide(emit('walk-step', { x: 3, y: 4 }))!;
    expect(spec.distance).toBeCloseTo(5, 12);
    expect(spec.gain).toBeCloseTo(gainFor(emit('walk-step', { x: 3, y: 4 }), 5), 12);
    expect(spec.x).toBe(3);
    expect(spec.y).toBe(4);
  });
});


describe('the listener is replaced whole, never edited in pieces', () => {
  it('decides against the pose it was given', () => {
    const director = new AudioDirector(ORIGIN);
    const event = emit('walk-step', { x: 10 });
    expect(director.decide(event)).not.toBeNull();
    director.setListener({ ...ORIGIN, x: 30 });
    expect(director.decide(event)).toBeNull();
    expect(director.listenerState.x).toBe(30);
  });
});
