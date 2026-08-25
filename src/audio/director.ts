/**
 * The audio director — what a sound event *means*, before anything makes a noise.
 *
 * This is the decision half of M1 and it contains no WebAudio at all: no context, no nodes, no
 * scheduling, nothing that needs a browser or a user gesture. It takes a `SoundEvent` and a
 * listener, and answers with a plain-data `VoiceSpec` — which voice, how loud, how bright, what
 * material, how long — or with `null`, meaning the listener never heard it.
 *
 * Splitting it out is not tidiness. It is what makes the two senses testable against each other:
 * every claim §3.3 and §3.9 make about *what the player receives* can be checked here, in
 * arithmetic, without rendering a single sample. `src/audio/system.ts` turns these specs into
 * sound and nothing else; if a level is wrong, it is wrong in one pure function.
 *
 * Two laws are load-bearing here, and both are borrowed rather than restated:
 *
 *  - **The hearing gate is `SoundBus.canHear`** (§3.1) — the same call `PaintSystem.handle`
 *    makes, with the listener's own range. Not a copy of the predicate, not a second range: an
 *    ear that decided for itself what it could hear would be the "one bus, two senses"
 *    commitment of §1 broken silently, with the world painting a footfall it never played or
 *    playing one it never painted.
 *  - **Level comes from `hearingRadius`** (§3.9) — see `gainFor`. The director never multiplies
 *    by a material's voice, because the radius it reads has already been multiplied by it, in
 *    `SoundBus.emit`, once.
 */

import {
  SOUND_CLASSES,
  SoundBus,
  eventTint,
  isContactClass,
  type EventTint,
  type SoundClass,
  type SoundEvent,
} from '../paint/soundEvents';

/**
 * Which builder makes the noise. Deliberately coarser than `SoundClass`: a crouch-step and a
 * landing are the same synthesis — an exciter striking a modal bank — differing only in the
 * numbers this spec carries. A ping is a different thing entirely.
 */
export type VoiceKind = 'contact' | 'ping';

/** Everything `src/audio/voices.ts` needs to make one sound, as plain data. */
export interface VoiceSpec {
  /** Which builder. */
  readonly voice: VoiceKind;
  /** The class it came from — carried through so a mix decision can branch on it later. */
  readonly cls: SoundClass;
  /** Linear output gain, 0–1ish. See `gainFor` for what the number means. */
  readonly gain: number;
  /** Material index (`paint/materials`) for a contact, `null` for a ping. */
  readonly mat: number | null;
  /** §3.2's event layer, resolved for *this* listener: self, teammate, spider or prop. */
  readonly tint: EventTint;
  /** Metres from the listener to the origin — the number `gainFor` used, kept for the mixer. */
  readonly distance: number;
  /** Where it happened, world space. Panning input the day spatialization lands. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * How hard the contact was, as a multiplier on the voice's exciter brightness. 1 is a walk.
   * A ping reports 1 and ignores it.
   */
  readonly bright: number;
  /** The voice's fundamental, Hz: a contact's thump, a ping's tone. */
  readonly toneHz: number;
  /** How long the voice runs, seconds — long enough to contain the longest material ring. */
  readonly durationSec: number;
  /**
   * The emission cone, degrees; 360 is omnidirectional. Carried so the two pings can *sound*
   * like their shapes — Q is the room-read, E is the beam — rather than differing only in a
   * number the player cannot hear.
   */
  readonly coneAngleDeg: number;
  /**
   * Seed for whatever noise the voice needs, taken from the event's sequence number.
   *
   * From the event rather than from `Math.random` for the same reason `probeVoices` is seeded:
   * a render nobody can reproduce is a render no test can pin. From `seq` rather than a counter
   * of our own so two subscribers to the same bus make the same noise, and so a footstep sounds
   * a little different from the one before it instead of being a loop.
   */
  readonly seed: number;
}

/** Where the ears are, how far they reach, and whose body they belong to. */
export interface ListenerState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * §3.1's hearing range, metres — base 18, raised by the Sensitivity chip.
   *
   * Passed in rather than defaulted here. A default in this file would be a *second* answer to
   * "how far can the player hear", and the day the chip moved one of them the ear and the eye
   * would disagree about the same footstep. `PaintSystem.perception.hearingRange` is the answer;
   * the audio system hands it over every tick.
   */
  readonly range: number;
  /** Which emitter id is "me" — the only input `eventTint` needs to split self from teammate. */
  readonly emitter: number;
}

/**
 * Linear gain of an event heard at exactly the edge of its own carry radius.
 *
 * Everything else in the mix is stated relative to this: it is the quietest a sound ever gets
 * before the hearing gate cuts it off entirely, so it sets both the noise floor of the mix and,
 * with `NEAR_FIELD_M`, the loudest anything can be. Small on purpose — an event that is *just*
 * audible should be just audible.
 */
export const EDGE_GAIN = 0.02;

/**
 * The closest a sound is allowed to get, metres — inside this the level stops rising.
 *
 * 1.5 m is not a round number picked for safety: it is the distance from the rig's ears to its
 * own feet (`E_PING_HEIGHT` above the body, footsteps just above the floor). So the player's own
 * footfall sits exactly *at* the clamp, which makes "your own step" the reference level of the
 * whole mix rather than a special case, and means nothing can ever be louder than your own feet
 * on the same surface. Without a clamp, an event emitted at the ear — every ping is — divides by
 * something near zero.
 */
export const NEAR_FIELD_M = 1.5;

/** Per-class voice shaping: how bright the strike is, what it thumps at, how long it runs. */
interface ClassVoice {
  readonly voice: VoiceKind;
  readonly bright: number;
  readonly toneHz: number;
  readonly durationSec: number;
}

/**
 * The shape of each class, as opposed to its level.
 *
 * Level is deliberately absent: it comes from `hearingRadius` and from nowhere else (see
 * `gainFor`). What lives here is everything level *cannot* say — a crouch-step is not a quiet
 * sprint-step, it is a softer and duller one, and a landing is a heavier thump than either.
 * Sorting the classes by `bright` reads as the gait ladder, which is the check that this table
 * is describing effort rather than volume.
 *
 * `durationSec` must outlast the longest material ring the voice can produce (metal's modes run
 * ~0.38 s) or the material fingerprint of §3.9 is cut off by the schedule rather than by physics.
 */
const CLASS_VOICES: Readonly<Record<SoundClass, ClassVoice>> = Object.freeze({
  'crouch-step': Object.freeze({ voice: 'contact' as const, bright: 0.55, toneHz: 132, durationSec: 0.6 }),
  'walk-step': Object.freeze({ voice: 'contact' as const, bright: 1.0, toneHz: 120, durationSec: 0.7 }),
  'sprint-step': Object.freeze({ voice: 'contact' as const, bright: 1.35, toneHz: 112, durationSec: 0.7 }),
  landing: Object.freeze({ voice: 'contact' as const, bright: 1.6, toneHz: 92, durationSec: 0.9 }),
  // The two pings differ in shape, not reach (§3.5), so they differ in timbre here: Q is the
  // round 360° room-read, E is the bright directed beam. `voices.ts` reads `coneAngleDeg` to
  // tell them apart, and `toneHz` sets how high each one sits.
  'q-ping': Object.freeze({ voice: 'ping' as const, bright: 1.0, toneHz: 420, durationSec: 1.1 }),
  'e-ping': Object.freeze({ voice: 'ping' as const, bright: 1.0, toneHz: 760, durationSec: 1.0 }),
});

/**
 * How loud an event is, at a distance — and the one place §3.9's loudness reaches the ear.
 *
 * `gain = EDGE_GAIN · hearingRadius / max(distance, NEAR_FIELD_M)`.
 *
 * **The level is the carry radius.** Not a per-class volume table beside the §3.3 table, and not
 * `materialLoudness` applied a second time: `event.hearingRadius` left `SoundBus.emit` already
 * multiplied by the struck surface's voice, so reading it here makes the ear and the spider agree
 * about how loud a thing is *by construction*. A metal footstep carries 1.5× as far and arrives
 * 1.5× as loud because those are one fact, which is exactly what §3.9's "one knob per question"
 * ruling asks for. Multiplying by `materialLoudness` here would apply the voice twice — 2.25× for
 * metal — and the §3.9 invariant would fail by 3.5 dB in the direction nobody would notice.
 *
 * The inverse-distance shape is the same claim read the other way. Amplitude ∝ 1/d means a sound
 * is audible out to a distance proportional to its source level, which *is* §3.3's right-hand
 * column: double the loudness, double the carry. It also makes the cutoff quiet rather than
 * abrupt — at exactly `hearingRadius` every event, of every class, on every material, arrives at
 * `EDGE_GAIN`, so the gate closes on a whisper instead of on a click.
 *
 * The class profile's `intensity` is deliberately *not* a factor. It scales how much an event
 * reveals — paint density — and using it for level too would be a second loudness knob for one
 * question, which is the arrangement §3.9 spent a commit ruling against.
 */
export function gainFor(event: SoundEvent, distance: number): number {
  return (EDGE_GAIN * event.hearingRadius) / Math.max(distance, NEAR_FIELD_M);
}

/**
 * Turns events into voice specs for one listener.
 *
 * Stateless apart from the listener, and the listener is replaced wholesale rather than mutated
 * in pieces, so a spec is always computed against one coherent pose — the same reason
 * `GameSim.tick` syncs the paint listener before anything is allowed to emit.
 */
export class AudioDirector {
  private listener: ListenerState;

  constructor(listener: ListenerState) {
    this.listener = listener;
  }

  setListener(listener: ListenerState): void {
    this.listener = listener;
  }

  get listenerState(): ListenerState {
    return this.listener;
  }

  /**
   * What this listener should hear of this event, or `null` if they heard nothing.
   *
   * `null` rather than a silent spec: an inaudible event must not reach the mixer at all, or the
   * voice count grows with the whole world's noise instead of with what is audible, and every
   * "why is this quiet" question gains a second possible answer.
   */
  decide(event: SoundEvent): VoiceSpec | null {
    const l = this.listener;
    if (!SoundBus.canHear(event, l.x, l.y, l.z, l.range)) return null;

    const distance = Math.hypot(event.x - l.x, event.y - l.y, event.z - l.z);
    const shape = CLASS_VOICES[event.class];
    return {
      voice: shape.voice,
      cls: event.class,
      gain: gainFor(event, distance),
      /*
       * Straight from the event, including the `null`. The alternative — defaulting a ping to
       * concrete so the voice builder has "something" — would hand the sonar pulse a footfall's
       * material, and `isContactClass` is asserted against it below so the two can never drift.
       */
      mat: event.mat,
      tint: eventTint(event, l.emitter),
      distance,
      x: event.x,
      y: event.y,
      z: event.z,
      bright: shape.bright,
      toneHz: shape.toneHz,
      durationSec: shape.durationSec,
      coneAngleDeg: event.coneAngleDeg,
      seed: event.seq,
    };
  }
}

/**
 * The shaping table, exposed read-only for tests and for the dev panel.
 *
 * Frozen, and a copy is not handed out per simulation the way `SoundTunables` is: these are
 * timbre, not gameplay reach, so two simulations in one process sharing them cannot make a
 * seeded run irreproducible — nothing in the sim reads them.
 */
export const AUDIO_CLASS_VOICES = CLASS_VOICES;

/** True when the class's voice is a struck surface, which is exactly the classes with a material. */
export function isContactVoice(cls: SoundClass): boolean {
  return CLASS_VOICES[cls].voice === 'contact';
}

/**
 * Every class in the sound table has a voice, checked at module load.
 *
 * The `Record<SoundClass, ClassVoice>` type already refuses a missing row at compile time. This
 * catches the other half — a row whose `voice` disagrees with `isContactClass`, i.e. a class the
 * bus says strikes a surface but the audio says is a ping, which would give it a material the
 * builder has no use for (or take away one it needs).
 */
for (const cls of Object.keys(SOUND_CLASSES) as SoundClass[]) {
  if (isContactVoice(cls) !== isContactClass(cls)) {
    throw new Error(
      `audio/director: '${cls}' is ${isContactClass(cls) ? '' : 'not '}a contact class on the ` +
        `bus but its voice is '${CLASS_VOICES[cls].voice}'. See CONTACT_CLASSES.`,
    );
  }
}
