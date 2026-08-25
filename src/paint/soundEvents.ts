/**
 * The sound event bus — vision doc §3.1 and design laws 1 and 2.
 *
 * *Every* noise in the game goes through `SoundBus.emit`. There is deliberately no second
 * path: if a thing can be heard, it exists here, with a real origin and a real loudness, and
 * anything that listens (the paint system today; dog hearing, heat and the audio mixer later)
 * subscribes to the same stream. That is what makes law 2 — "the system never lies" —
 * enforceable rather than aspirational: geometry drawn with no event behind it is impossible
 * to produce.
 *
 * An event carries two radii, and they are not the same number:
 *  - `paintRadius`  — how much static geometry the sound reveals around its origin (§3.3,
 *                     left column). This is what the *player* gets out of the noise.
 *  - `hearingRadius`— how far away a listener can notice the event at all (§3.3, right
 *                     column). `SoundBus.canHear` is the one place it is read, and every ear in
 *                     the game reads it through that.
 *
 * Both of them leave `emit` multiplied by the voice of whatever was struck (§3.9), which is why
 * that multiplication lives in `emit` and not in any emitter.
 *
 * It also carries who made it — `source` and `emitter` — and that pair is deliberately *not* a
 * viewer's reading of it. See `SoundSource` and `eventTint`.
 *
 * The bus itself is inert: it stamps, validates and fans out. All interpretation belongs to
 * subscribers. Two rules make that fan-out something a growing cast of emitters can rely on:
 *
 *  - **A listener must not emit.** Doing so throws. A sound is made by the simulation, never by
 *    another sound's delivery; anything that answers what it hears answers in its own tick phase,
 *    at most one tick (8 ms) later. See `emit`.
 *  - **An event's listeners are the ones that existed when it was emitted.** Fan-out walks a
 *    snapshot, so subscribing mid-delivery means "from the next event" and unsubscribing
 *    mid-delivery still receives this one — neither depends on registration order.
 *
 * Neither is a limit on how *much* can be emitted. The bus never drops, throttles or defers
 * anything: a sound the world made and did not paint is precisely what law 2 forbids. It only
 * counts (`emittedThisTick`, `maxEmittedPerTick`), so that an emitter firing per tick instead of
 * per contact shows up as a number rather than as a mystery.
 */

import { MAT_CONCRETE, materialLoudness } from './materials';

/**
 * Sound classes implemented so far. `slide`, spider gaits and the carried-artifact hum are
 * additional rows in the same table of §3.3 and need no new machinery — a class name, a profile
 * entry, an emitter.
 *
 * `sphere-boom` and `throw-windup` are M2's throwable: the arm winding, and the sphere going off
 * against whatever it reaches. Neither strikes a surface in the sense §3.9 means — the wind-up
 * strikes nothing at all, and a detonation is loud because of what it *is* — so neither is a
 * contact class, and both are here because §1 has no second path for a noise the world can hear.
 *
 * The two `prop-*` rows have no emitter today. They are kept because they are the game's only
 * *composed* classes — the pair of materials §3.9 prices as a geometric mean — and the things
 * that will emit them are already named: core-loop §2's artifact set down on a floor, and M4's
 * spider putting a foot on one. Deleting a priced row to re-derive it later is how a table
 * becomes two tables.
 */
export type SoundClass =
  | 'crouch-step'
  | 'walk-step'
  | 'sprint-step'
  | 'landing'
  | 'q-ping'
  | 'e-ping'
  | 'prop-impact'
  | 'prop-knock'
  | 'throw-windup'
  | 'sphere-boom';

/**
 * Who made a noise — the *kind* of thing, never a viewer's relationship to it.
 *
 * There is deliberately no `'self'` here. Self is not a property of an event: it is a
 * relationship between an event and whoever is looking at it, and two players hearing the same
 * footstep have to be able to disagree about it (§3.2 paints one of them amber and the other
 * green). Resolving that at emit time would bake one viewer's perspective into data that every
 * viewer shares, and the bug it produces — a teammate's step rendered as your own on their
 * screen — is invisible in solo play and very hard to see in co-op. So the bus records what a
 * thing *is* (`'player'`) plus which one (`emitter`), and the renderer and the audio director
 * ask `eventTint` who that is to them.
 *
 * `'world'` is the level itself: machinery, hoists, a dispatch hatch — audible things with no
 * entity behind them. `'prop'` is a thing that was knocked, thrown or rattled (§8), which does
 * have one.
 */
export type SoundSource = 'player' | 'prop' | 'spider' | 'world';

/**
 * The local player's entity id.
 *
 * A constant rather than a lookup because there is exactly one body in the game today. Co-op
 * (§10) hands the other three rigs their own ids and nothing here changes: `emitter` is already
 * the field that tells them apart, and `eventTint` is already the only place that compares it
 * against the viewer.
 */
export const PLAYER_EMITTER_ID = 0;

/** The emitter id of a sound no entity made — `'world'` events, and an unattributed emit. */
export const NO_EMITTER = -1;

/**
 * How the event layer of §3.2 should colour an event, from the point of view of one listener:
 * self = amber, teammate = green, spider = red-orange, prop = pale yellow. Machinery shares the
 * prop tint, which is why `'world'` and `'prop'` answer alike — §3.2 names one colour for both.
 */
export type EventTint = 'self' | 'teammate' | 'spider' | 'prop';

/**
 * The amber-vs-green rule of §3.2, in one function.
 *
 * The source decides the family and `emitter` only ever splits `'player'` in two, so an event
 * that merely happens to carry the viewer's id — a prop with entity id 0, machinery emitting
 * with the default — can never come back as `'self'`. Getting that backwards (comparing ids
 * first and asking what made the noise second) is the mistake this function exists to make
 * unavailable.
 *
 * **Nothing in `src/` calls this yet, and that is the finding rather than the plumbing.** §3.2's
 * event layer is what needs it, and `paintSystem.ts`'s `EVENT_COLORS` is a `Record<SoundClass,
 * number>` — an amber ramp with no source axis at all, which is honest today because every
 * shipped emitter is the local player. It stops being honest at M2: a sphere's boom is
 * `source: 'prop'`, §3.2 says pale yellow, and it would render self-amber. The audio director
 * used to call this and store the answer on `VoiceSpec`, where nothing read it — a paint concept
 * parked in the mixer, which looked like wiring and was not.
 *
 * Whoever wires it: §3.2 asks for hue *and* a glyph pip for the teammate family — "never hue
 * alone" — so a palette keyed on this function is half the job, not the whole of it.
 */
export function eventTint(event: SoundEvent, localEmitter: number): EventTint {
  switch (event.source) {
    case 'player':
      return event.emitter === localEmitter ? 'self' : 'teammate';
    case 'spider':
      return 'spider';
    default:
      return 'prop';
  }
}

/**
 * Which wavefront speed a class travels at. Three groups rather than a number per class:
 * everything a body does to the floor propagates alike, the two pings are the two deliberate
 * acts, and three sliders are a tuning surface a playtest can actually hold in its head.
 */
export type WaveGroup = 'step' | 'ping' | 'beam';

/**
 * How fast each group's wavefront expands, m/s. The frozen default; the dev panel tunes a
 * simulation's own copy (`SoundTunables`), never this.
 *
 * Not the speed of sound: 343 m/s crosses a 30 m room in 90 ms, which at any frame rate is
 * an instant pop — the thing the wave engine exists to abolish. These are *readable* speeds,
 * chosen so a room read takes about half a second to sweep: the player watches the answer
 * arrive and can tell near from far by when it lit, which is information the pop never gave.
 * The beam is the faster of the two because a directed question should feel like a thrown
 * torch, not a released balloon.
 */
export const WAVE_SPEEDS: Readonly<Record<WaveGroup, number>> = Object.freeze({
  step: 25,
  ping: 25,
  beam: 45,
});

export interface SoundClassProfile {
  /** Paint radius at intensity 1, metres (§3.3). Tunable at runtime. */
  paintRadius: number;
  /** How far this class carries, metres (§3.3, right column). Read by `SoundBus.canHear`. */
  hearingRadius: number;
  /** Full apex angle of the emission cone in degrees; 360 means omnidirectional. */
  coneAngleDeg: number;
  /** Loudness multiplier applied when the emitter does not name one. Inert — see `SoundEvent`. */
  intensity: number;
  /** Which entry of `WAVE_SPEEDS` this class's front travels at. */
  readonly wave: WaveGroup;
}

/**
 * §3.3, verbatim where the table gives a single number. `landing` is the one range in the
 * table (8-14 m); its emitter picks a point in that range from the impact speed, so the value
 * here is only the floor.
 *
 * **The E-ping deliberately deviates from §3.3/§3.5.** The doc specifies a 25° cone reaching
 * 40 m: a telescope. Played, that is a bad question — a 25° slit answers "what is exactly
 * where I am already looking", which the player mostly knows, and answers it about a room they
 * cannot reach before the paint has cooled. Batch 2.1 re-roles it as *look around*: a 110°
 * cone at 22 m, which is the width of a corridor plus both its walls and the depth of one
 * decision. Q stays the 360° behind-your-back read, so the two now differ in *shape* rather
 * than in reach, and the E-ping's price (§3.3 right column: dogs hear it at both ends of the
 * beam) is unchanged. The docs get updated when the design settles; until then this comment is
 * the record that the difference is a choice and not a drift.
 *
 * **The throwable's two rows.** `sphere-boom` is the sphere going off — 12 m of paint and 32 m
 * of carry, a `ping` front because a detonation arrives fast and all at once rather than
 * travelling as a knock does. It paints exactly what a Q-ping paints and is heard nearly twice
 * as far, which is the whole shape of the verb: a question asked from somewhere you are not,
 * that answers a room-sized patch of geometry to you and announces itself to everything within
 * half the floor. `throw-windup` is the rig's arm winding up — 0.5 m and 2.5 m, the quietest
 * thing in the table — and the reason it is *in* the table is §1: a mechanism the world can hear
 * has to paint, so the wind-up's tell and the wind-up's noise are one event or they are a lie.
 *
 * Both stay under the Halo's ceiling by construction, and the boom does it *without* being
 * scaled: it is not a contact class, so its 32 m is 32 m on any floor, against the landing's
 * 28 x 1.5 = 42 (`HALO_MAX_RADIUS_M`). §3.8's dial does not stretch and no hum calibration moves.
 * A class that out-carried the landing would silently re-scale the player's own loudness
 * readout — see `paint/halo.ts`, and `tests/spheres.test.ts`, which pins exactly this.
 *
 * The two `prop-*` rows are emitterless (see the class union). Their numbers are the ones a can
 * was priced at and they are left alone: an unemitted row is a promise about a future emitter,
 * and re-tuning it now would be tuning against nothing.
 *
 * **Frozen, and both tables are.** They are the *defaults* every simulation copies from, not
 * live state: a dev-panel slider bound straight into this object used to tune every `SoundBus`
 * in the process at once and to make a seeded run irreproducible after anyone had touched the
 * panel. `defaultSoundTunables()` below hands each run its own copy, and freezing these means
 * the old mistake throws instead of quietly coming back (module code is strict mode).
 */
export const SOUND_CLASSES: Readonly<Record<SoundClass, Readonly<SoundClassProfile>>> =
  Object.freeze({
    'crouch-step': Object.freeze({ paintRadius: 1.5, hearingRadius: 2, coneAngleDeg: 360, intensity: 0.7, wave: 'step' as const }),
    'walk-step': Object.freeze({ paintRadius: 4, hearingRadius: 11, coneAngleDeg: 360, intensity: 0.9, wave: 'step' as const }),
    'sprint-step': Object.freeze({ paintRadius: 7, hearingRadius: 24, coneAngleDeg: 360, intensity: 1.0, wave: 'step' as const }),
    landing: Object.freeze({ paintRadius: 8, hearingRadius: 28, coneAngleDeg: 360, intensity: 1.0, wave: 'step' as const }),
    'q-ping': Object.freeze({ paintRadius: 12, hearingRadius: 18, coneAngleDeg: 360, intensity: 1.05, wave: 'ping' as const }),
    'e-ping': Object.freeze({ paintRadius: 22, hearingRadius: 30, coneAngleDeg: 110, intensity: 1.15, wave: 'beam' as const }),
    'prop-impact': Object.freeze({ paintRadius: 8, hearingRadius: 25, coneAngleDeg: 360, intensity: 1.0, wave: 'step' as const }),
    'prop-knock': Object.freeze({ paintRadius: 1.5, hearingRadius: 4, coneAngleDeg: 360, intensity: 0.7, wave: 'step' as const }),
    'throw-windup': Object.freeze({ paintRadius: 0.5, hearingRadius: 2.5, coneAngleDeg: 360, intensity: 0.6, wave: 'step' as const }),
    'sphere-boom': Object.freeze({ paintRadius: 12, hearingRadius: 32, coneAngleDeg: 360, intensity: 1.0, wave: 'ping' as const }),
  });

/**
 * Which classes are made by something striking a surface — §3.9's "all contact-made classes".
 *
 * This is the structural statement that **a ping is not a contact sound**. A footfall, a
 * landing, an artifact set down on a floor and (at M4) a spider's foot all happen *because* a
 * body met a surface, so the surface has a say in how loud they are. A ping is a rig emitting into the air
 * from wherever the rig happens to be: nothing is struck, no material is involved, and scaling
 * it by whatever the player is standing on would mean a Q-ping fired from a steel walkway
 * reaches 18 m while the same Q-ping fired one step later on concrete reaches 12 — a deliberate
 * act whose price moves under the player's feet for no reason they can see or predict.
 *
 * A `Record<SoundClass, boolean>` rather than a set of names, because the compiler then refuses
 * a new class that has not answered the question. `emit` reads it, and reads it from *here*
 * rather than from a bus's tunables copy, for the same reason `landingRadius` reads the frozen
 * table: whether a sound strikes something is a fact about the class, not a knob.
 */
export const CONTACT_CLASSES: Readonly<Record<SoundClass, boolean>> = Object.freeze({
  'crouch-step': true,
  'walk-step': true,
  'sprint-step': true,
  landing: true,
  'q-ping': false,
  'e-ping': false,
  'prop-impact': true,
  'prop-knock': true,
  // The rig's own arm. Nothing is struck — the wind-up is a mechanism, not a contact — so no
  // floor gets a say in how loud it is, for the same reason a ping's price does not move under
  // the player's feet.
  'throw-windup': false,
  /*
   * **A detonation is not a contact sound**, and this is the row where that is decided.
   *
   * A sphere does touch a surface — that is what sets it off — so the tempting answer is `true`.
   * It is wrong, and the reason is §3.9's own definition: a contact class is scaled by the struck
   * material because the *surface* is what is speaking. A footfall on steel is loud because steel
   * is loud. A sphere going off on dust is loud because the sphere went off; the dust contributes
   * nothing to it and muffles nothing of it. Scaled by material the same throw would carry 19.2 m
   * on dust and 48 on the steel walkway — a 2.5× swing in the one property the player is using
   * the sphere to control, decided by a surface they threw at precisely because they could not
   * see it.
   *
   * `false` therefore does two things at once: it makes the boom one constant, learnable
   * loudness, and it keeps `HALO_MAX_RADIUS_M` where it is (32 raw, under the landing's 42).
   * The struck surface is still the *paint's* origin and still the thing the geometry is drawn
   * from — it just does not get a vote on the volume.
   */
  'sphere-boom': false,
});

/** True when this class is made by a body meeting a surface, and therefore has a material. */
export function isContactClass(cls: SoundClass): boolean {
  return CONTACT_CLASSES[cls];
}

/**
 * Which contact classes are made by **two bodies whose materials are both known** — §3.9 asked
 * of a dropped object rather than of a boot.
 *
 * Every contact has two sides. What makes these classes different is that the game knows *both*:
 * a footfall is "the rig" hitting a floor and the rig has no material in the table, so the
 * surface is the whole of the answer. A steel artifact set down on a dusty slab is two materials,
 * and both are facts the emitter is holding at the moment it emits. Those are the classes whose
 * loudness is the geometric mean of the two voices (see `materialVoiceFor`) and whose sound is
 * built from two rows of `MATERIAL_VOICES` (see `audio/voices.ts`'s `contactVoice`).
 *
 * A `Record<SoundClass, boolean>` for the same reason `CONTACT_CLASSES` is one: the compiler
 * refuses a new class that has not answered. Two rules hold it to `CONTACT_CLASSES`, both
 * asserted at module load below: composed implies contact (a pair of bodies that never met is
 * not a sound), and a composed class must be given its second material or the emit throws — the
 * game always knows what it threw, and a default would price a steel can as concrete.
 */
export const COMPOSED_CLASSES: Readonly<Record<SoundClass, boolean>> = Object.freeze({
  'crouch-step': false,
  'walk-step': false,
  'sprint-step': false,
  landing: false,
  'q-ping': false,
  'e-ping': false,
  'prop-impact': true,
  'prop-knock': true,
  'throw-windup': false,
  // Not a contact at all (see `CONTACT_CLASSES`), so there is no pair to compose. The module-load
  // check below is what makes that consistency a compile-and-boot fact rather than a convention.
  'sphere-boom': false,
});

/** True when this class is a contact between two bodies the game has a material for. */
export function isComposedClass(cls: SoundClass): boolean {
  return COMPOSED_CLASSES[cls];
}

for (const cls of Object.keys(COMPOSED_CLASSES) as SoundClass[]) {
  if (isComposedClass(cls) && !isContactClass(cls)) {
    throw new Error(
      `paint/soundEvents: '${cls}' is composed but not a contact class. A composed class is a ` +
        'contact between two bodies; a class that strikes nothing has no pair to compose.',
    );
  }
}

/**
 * §3.9's multiplier for one class on one surface — the loudness law, in the only place it lives.
 *
 * A contact class is scaled by what it struck; a ping strikes nothing and is scaled by 1, which
 * is concrete's voice and deliberately not a special case in the arithmetic (see `emit`).
 *
 * Exported because `emit` is no longer the only thing that needs the answer. §3.8's Halo has to
 * report the radius the player is *currently* heard at, which is the radius `emit` would give
 * their next footfall — and a Halo that recomputed `hearingRadius × materialLoudness` for itself
 * would be a second copy of this law, free to drift from the one the world actually obeys. One
 * function, read by the emitter and by the readout, is what stops the ring from claiming an
 * audible radius the bus does not give.
 *
 * **Two bodies compose as the geometric mean, `√(m_object · m_surface)`.** A composed class is
 * the case where §3.9 has two materials to price and not one, and the mean is the only rule of
 * the four considered that keeps every property the law already relies on:
 *
 *  - **It reduces to `m` on the diagonal.** `√(m·m) = m` — exactly, in IEEE, for all four
 *    shipped multipliers — so a metal can dropped on a metal floor is scaled by the same 1.5 a
 *    metal footfall is. A *product* would put that pair at 2.25, outside §3.9's whole tuned band,
 *    and make a footfall and an impact on one floor obey different physics. Anything that fails
 *    `compose(m, m) = m` is not a generalization of the law, it is a second law.
 *  - **It is symmetric and strictly monotonic in both arguments.** `min` is neither: it flattens
 *    the entire dust row *and* column, so a dust clod thrown at steel and at concrete would paint
 *    identical radii — a probe that has stopped reporting the world. Taking the surface alone
 *    (and ignoring what struck it) makes the object's material strategically free, which §1's
 *    "every question has a price" refuses: the can's voice would cost nothing.
 *  - **It is closed on the tuned band.** All sixteen pairs land inside [0.6, 1.5], the extremes
 *    only on the diagonal, so no pair is louder than the loudest material or quieter than the
 *    quietest — which is what keeps `HALO_MAX_RADIUS_M` an honest ceiling.
 *  - **It is the arithmetic mean in decibels**, `½·(P(o) + P(s))`, so the invariant §3.9 states
 *    for one material generalizes to a pair by averaging the same promised-dB table rather than
 *    by inventing a second one. `tests/audio/materialVoices.test.ts` asserts exactly that.
 *
 * The asymmetry this appears to ignore — a steel bolt on dust is not a dust clod on steel — is
 * real and is carried by **timbre**, not by level, which is §3.9's own split of the question.
 * Measured on the shipped voices, those two pairs ring 150-300 ms after the strike at −89.9 dBFS
 * and −43.4, with attack centroids of 250 Hz and 999: equal loudness, unmistakably different
 * sounds. `audio/voices.ts` is where that half lives.
 */
export function materialVoiceFor(
  cls: SoundClass,
  mat: number | null | undefined,
  objMat?: number | null,
): number {
  const surface = materialLoudness(isContactClass(cls) ? mat ?? MAT_CONCRETE : MAT_CONCRETE);
  if (!isComposedClass(cls)) return surface;
  return Math.sqrt(surface * materialLoudness(objMat ?? MAT_CONCRETE));
}

/**
 * The materials a class is allowed to be given, checked in the one place both callers share.
 *
 * `emit` and `carryRadius` ask the same question — how loud is this class on these materials —
 * so they have to refuse the same nonsense, or the Halo would happily report a radius the bus
 * would have thrown on. Three refusals, and each one is a misunderstanding rather than an
 * inconvenience:
 *
 *  - **a material on a class that strikes nothing** (either ping, the wind-up): the emitter
 *    thinks it is making a contact sound and it is not.
 *  - **a second material on a class with only one body in it** (a footfall, a landing): the
 *    rig has no material in the table, and accepting one here would let a caller sneak a
 *    loudness multiplier onto a footstep through a field the eye never sees.
 *  - **no second material on a composed class**: silently defaulting to concrete would price a
 *    steel can as a lump of concrete — 1.22x quieter — and nothing downstream could tell that
 *    the number was a guess. The game always knows what it threw.
 *
 * `null` and `undefined` mean the same thing here ("not named"), because `emit` omits a field
 * and `carryRadius` defaults one, and a law that treated those two as different answers would
 * be a law with a spelling.
 */
function assertMaterials(
  who: string,
  cls: SoundClass,
  mat: number | null | undefined,
  objMat: number | null | undefined,
): void {
  const named = (v: number | null | undefined): boolean => v !== undefined && v !== null;
  if (named(mat) && !isContactClass(cls)) {
    throw new Error(
      `${who}('${cls}') was given mat=${mat}, but '${cls}' strikes nothing. Only contact ` +
        'classes have a material — see CONTACT_CLASSES.',
    );
  }
  if (named(objMat) && !isComposedClass(cls)) {
    throw new Error(
      `${who}('${cls}') was given objMat=${objMat}, but '${cls}' is not a contact between two ` +
        'bodies the game has materials for — see COMPOSED_CLASSES.',
    );
  }
  if (!named(objMat) && isComposedClass(cls)) {
    throw new Error(
      `${who}('${cls}') named no objMat. '${cls}' is a contact between two bodies (see ` +
        'COMPOSED_CLASSES) and §3.9 prices it by both: name the material of the thing that ' +
        'struck, or the steel can is charged as concrete.',
    );
  }
}

/**
 * A radius has to be a positive, finite number of metres, or the event is not a sound.
 *
 * Written as `!(r > 0)` rather than `r <= 0`, and the difference is the whole point: NaN fails
 * every comparison it is given, so `r <= 0` waves it through and `!(r > 0)` catches it. That is
 * the same trapdoor `SoundBus.landingRadius` guards against downstream, arriving here by the
 * emitter's front door instead.
 *
 * Zero is rejected alongside the impossible values, and deliberately: an emitter asking for a
 * radius of zero is asking for half a sound, and half a sound is the one thing §1 promises the
 * bus cannot carry. There is no legitimate caller — a noise nobody can hear and nothing can see
 * is not a quiet noise, it is an absent one, and the way to emit nothing is to emit nothing.
 */
function assertRadius(cls: SoundClass, field: string, radius: number): void {
  if (!(radius > 0) || radius === Infinity) {
    throw new Error(
      `SoundBus.emit('${cls}') resolved ${field}=${radius}. Every radius must be a positive, ` +
        'finite number of metres: the paint and the sound are two readings of one event, and a ' +
        'radius that is zero, negative or non-finite makes them disagree (see vision.md §1).',
    );
  }
}

/**
 * One simulation's own copy of the two tables above.
 *
 * The dev panel writes *here*, which is what makes two `GameSim`s in one process independent and
 * a seeded run reproducible regardless of what anybody dragged. `SoundBus` reads it on every
 * emit, so a slider takes effect on the next sound and never retroactively.
 */
export interface SoundTunables {
  readonly classes: Record<SoundClass, SoundClassProfile>;
  readonly waveSpeeds: Record<WaveGroup, number>;
}

/** A fresh, independent, mutable copy of the frozen defaults. */
export function defaultSoundTunables(): SoundTunables {
  const classes = {} as Record<SoundClass, SoundClassProfile>;
  for (const key of Object.keys(SOUND_CLASSES) as SoundClass[]) {
    classes[key] = { ...SOUND_CLASSES[key] };
  }
  return { classes, waveSpeeds: { ...WAVE_SPEEDS } };
}

/** Softest landing that rings out at all, m/s — roughly a 0.8 m drop at the default gravity. */
export const LANDING_MIN_IMPACT = 5;
/** Impact speed that earns the top of the 8-14 m landing band, m/s (~a 6 m drop). */
export const LANDING_FULL_IMPACT = 14;
/** Top of the landing paint band, metres (§3.3). */
export const LANDING_MAX_RADIUS = 14;


export interface SoundEvent {
  readonly class: SoundClass;
  /** What kind of thing made this noise (§3.2). Never a viewer's relationship to it. */
  readonly source: SoundSource;
  /**
   * Which one of them — the entity id, `NO_EMITTER` for a sound with no entity behind it.
   *
   * Paired with `source` rather than sufficient alone: `eventTint` splits `'player'` into self
   * and teammate with it, and the spider will use it to tell one set of footfalls from another.
   */
  readonly emitter: number;
  /** Origin — the place the sound was made, which is what the paint spreads from. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * What was struck — an index into `paint/materials` — or `null` for a class that strikes
   * nothing (either ping).
   *
   * Carried on the event rather than left to the emitter, because §3.9's voice is *two* things
   * and only one of them is a radius. The multiplier is already baked into `paintRadius` and
   * `hearingRadius` below, so a listener that only wants to know how far the noise reaches never
   * needs this field. A listener that has to make the *sound* does: metal and concrete at the
   * same loudness are still not the same noise, and "a change of timbre mid-stride is a change
   * of surface" (§3.9) is a claim about timbre, which no radius can carry.
   *
   * `null` rather than concrete's 0 for a ping, because a ping did not strike concrete — it
   * struck nothing, and a field that answers `0` there is a lie a reader has no way to detect.
   * The compiler makes every consumer say what it does about the case.
   */
  readonly mat: number | null;
  /**
   * What *struck* it — the other body's material — or `null` when no second body is named.
   *
   * `mat` keeps its exact meaning ("what was struck") and this is the half that was missing. It
   * is `null` for every class the game emitted before the throwable existed, and that is not a
   * gap to be filled in later: a footfall is the rig hitting a floor and the rig has no material
   * in §3.9's table, so the surface is genuinely the whole of the answer. `null` says "one body
   * had no voice", which is a different statement from "both bodies were concrete".
   *
   * Like `mat`, its loudness is already spent by the time the event leaves `emit` — both radii
   * carry `√(L(objMat)·L(mat))` — so a listener that only wants reach never reads it. One
   * that has to make the *sound* does: the strike belongs to the can and the ring belongs to the
   * floor (`audio/voices.ts`), and no radius can carry which was which.
   */
  readonly objMat: number | null;
  readonly paintRadius: number;
  readonly hearingRadius: number;
  /**
   * Loudness, ~1 = the class's nominal value.
   *
   * **Inert in the shipped configuration, and this comment is the only thing standing between
   * that and an afternoon of tuning with no effect.** §3.1 specifies it — "blip density scales
   * with intensity; falloff is quadratic" — but `structured.ts`, which is what actually unlocks
   * dots and edges, never reads it: a reveal is uniform inside its radius and stops dead at the
   * edge. The one consumer is `waveFx.ts`'s suspended-dust shader, and `WaveTunables.dust`
   * defaults to `false`, so on a default run the field is not even in the draw list.
   *
   * Kept rather than deleted because the doc asks for it and the shape it asks for is worth
   * having — a reveal that fades out toward its edge reads as a sound rather than as a stencil,
   * and puts the brightest blips at the origin where the information is. Wiring it in changes
   * every dot in every golden fixture, which is a change that deserves its own commit and its
   * own screenshots rather than a corner of an audio milestone.
   *
   * Whoever does that: `sim.ts`'s landing emitter derives its intensity from a radius that has
   * **not** been through §3.9's material voice yet, so a landing on steel would light the room
   * as though it had landed on concrete. One knob per question — the multiplier already scales
   * both radii, and it would have to scale this too, or this would have to stop being derived
   * from a radius at all.
   */
  readonly intensity: number;
  /** Unit aim vector; (0, 0, 0) for an omnidirectional event. */
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  /** Full apex angle in degrees; 360 for omnidirectional. */
  readonly coneAngleDeg: number;
  /**
   * How fast this event's wavefront expands, m/s. Nothing the event reveals exists before the
   * front has physically reached it: a surface's birth stamp is `time + distance / waveSpeed`.
   */
  readonly waveSpeed: number;
  /** Scene clock at emission, seconds. */
  readonly time: number;
  /** Monotonic counter — a stable identity for tooling and for seeding per-event sampling. */
  readonly seq: number;
}

export interface SoundEmitSpec {
  class: SoundClass;
  x: number;
  y: number;
  z: number;
  /**
   * Who is making it. Defaults to `'world'` with `NO_EMITTER`, which is the honest answer for an
   * emit that does not say: a noise the level made, belonging to nobody. It is deliberately not
   * `'player'` — defaulting to a player would hand every unattributed sound an identity it never
   * claimed, and `eventTint` would then colour it as somebody.
   */
  source?: SoundSource;
  emitter?: number;
  /**
   * What was struck, for a contact class — an index into `paint/materials`. Omitted means
   * concrete, the ordinary surface.
   *
   * Naming one on a class that strikes nothing (either ping) throws, rather than being ignored:
   * an emitter that thinks a ping has a material has misunderstood what it is emitting, and a
   * silently discarded field is how that misunderstanding survives to the next reader.
   */
  mat?: number;
  /**
   * What struck it, for a composed class — the arriving body's own material.
   *
   * Required on a composed class and refused on every other, both by `assertMaterials`. Required
   * because a default would be a guess with a price: concrete's 1.0 would quietly charge a steel
   * can 1.22x less carry than it earns, and nothing downstream could tell. Refused elsewhere
   * because a footfall has no second material to name, and a field that is silently ignored is
   * how a caller's misunderstanding survives to the next reader.
   */
  objMat?: number;
  /** Overrides the class profile (landings, and chip-modified pings later). */
  paintRadius?: number;
  hearingRadius?: number;
  intensity?: number;
  /** Aim for a directional class. Normalised here; ignored by omnidirectional classes. */
  dirX?: number;
  dirY?: number;
  dirZ?: number;
  coneAngleDeg?: number;
  /** Overrides the class's wave group speed (chips that change how a ping propagates). */
  waveSpeed?: number;
}

export type SoundListener = (event: SoundEvent) => void;

/**
 * The fan-out buffer, and the flag that makes one buffer enough.
 *
 * Both are module-level and they are a pair — the same scope on purpose. `src/core/collision.ts`
 * documents the convention: a module-level scratch is correct exactly as long as calls happen
 * sequentially on one thread, and the one thing that breaks it is reentrancy. Collision can rely
 * on that for free because nothing there takes a callback. A bus is nothing *but* callbacks, so
 * it has to enforce the property instead of assuming it, and `fanningOut` is that enforcement.
 *
 * Which is why the flag cannot be per-instance while the buffer is shared: bus A mid-fan-out
 * while a listener emits on bus B would leave B's copy sitting in the array A is still walking.
 * One flag over one buffer means the only way to reach the buffer twice at once now throws.
 */
const fanoutScratch: SoundListener[] = [];
let fanningOut = false;

export class SoundBus {
  /**
   * This bus's sound table. Owned by whoever constructed it (the simulation), never shared with
   * another bus unless a caller deliberately hands the same object to both.
   */
  readonly tunables: SoundTunables;

  private readonly listeners = new Set<SoundListener>();
  private seq = 0;
  private now = 0;
  private last: SoundEvent | null = null;
  private tickCount = 0;
  private tickPeak = 0;

  constructor(tunables: SoundTunables = defaultSoundTunables()) {
    this.tunables = tunables;
  }

  /**
   * Scene clock, in seconds. Set once per tick before anything emits — which is what makes it
   * the tick boundary, and therefore the place the per-tick emission counter resets.
   */
  setTime(seconds: number): void {
    this.now = seconds;
    this.tickCount = 0;
  }

  get time(): number {
    return this.now;
  }

  /** The most recent event, for HUD readouts and tooling. */
  get lastEvent(): SoundEvent | null {
    return this.last;
  }

  /** Events emitted since construction. */
  get emitted(): number {
    return this.seq;
  }

  /**
   * Events emitted since the last `setTime` — this tick's total.
   *
   * Observability, never a gate. The bus does not drop, throttle or defer anything however high
   * this climbs: a dropped event is a sound with no paint, which is the one thing design law 2
   * forbids the system to produce. A flood is a bug in whatever is emitting, and the only useful
   * thing the bus can do about it is make the number impossible to miss. Today one player emits
   * at most a handful a tick; M2 adds a rack of spheres and M4 adds spiders, and the day one of
   * them emits per-tick instead of per-contact this is what says so.
   */
  get emittedThisTick(): number {
    return this.tickCount;
  }

  /** The worst tick so far, by `emittedThisTick`. Never reset; a high-water mark. */
  get maxEmittedPerTick(): number {
    return this.tickPeak;
  }

  /**
   * How far a sound of this class on this surface would carry — §3.3's right-hand column, with
   * §3.9's voice already in it.
   *
   * The same number `emit` writes into `SoundEvent.hearingRadius`, asked *before* the sound
   * exists. §3.8's Halo is the caller: "how loud am I right now" is a question about the footfall
   * the body is in the middle of making, and it has to be answerable between footfalls, while
   * airborne, and while standing still — none of which produce an event to read.
   *
   * An instance method rather than a static one, because the class table is this simulation's own
   * copy (`SoundTunables`): drag the hearing radius of a sprint-step on the dev panel and the
   * ring follows it in the same frame, which is the whole reason the panel is worth having.
   * `mat` is `null` for a class that strikes nothing, exactly as on the event, and `objMat` is
   * `null` for anything that is not a contact between two bodies — the same three refusals
   * `emit` makes, from the same function, so the ring can never quote a radius the bus would
   * have thrown on.
   */
  carryRadius(cls: SoundClass, mat: number | null = null, objMat: number | null = null): number {
    assertMaterials('SoundBus.carryRadius', cls, mat, objMat);
    return this.tunables.classes[cls].hearingRadius * materialVoiceFor(cls, mat, objMat);
  }

  subscribe(listener: SoundListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(spec: SoundEmitSpec): SoundEvent {
    /*
     * A sound is made by the simulation, never by another sound's delivery.
     *
     * Something that reacts audibly to what it hears — a spider that skitters when a ping lands,
     * a prop that rattles when something loud goes past — emits in its *own* tick phase, one tick
     * later at most: 8 ms at 120 Hz, which no player can perceive. Queuing the reentrant emit
     * instead would work, and that is the problem: it would bury a real ordering decision inside
     * the bus, where nobody making a game-design choice would ever look for it. Whether the
     * spider's answer is heard before or after the rest of this tick's sounds would then depend
     * on which listener happened to be registered first, which is exactly the "who heard what
     * first" ambiguity determinism exists to kill.
     *
     * Thrown before the sequence number is taken, so a rejected emit leaves no trace on the bus.
     */
    if (fanningOut) {
      throw new Error(
        `SoundBus.emit('${spec.class}') was called from inside another event's fan-out. ` +
          'A listener must not emit: emit from the emitter\'s own tick phase instead.',
      );
    }
    const profile = this.tunables.classes[spec.class];
    /*
     * §3.9 — the material's voice, applied here and nowhere else.
     *
     * "The multiplier scales every radius the event carries, not just the class default." That
     * sentence is why this is a factor on the *resolved* radii rather than a different number in
     * the class table: a landing has already computed its own 8-14 m from impact speed and a
     * chip-modified ping will arrive with its own override, and both of those still have to be
     * scaled by what they struck. Keeping the law at the single choke point every noise passes
     * through is what stops each new emitter — M2's spheres, M4's spider — from having to
     * remember it. The consequence is real and intended: a hard landing on steel is
     * 14 x 1.5 = 21 m of paint, louder than a Q-ping, so a steel floor is a genuinely dangerous
     * thing to drop onto.
     *
     * Both radii, by the same factor. They are two readings of one sound (how far it paints,
     * how far it is heard), and a material that made a footfall paint further without making it
     * carry further would be a surface that is loud to the player and quiet to the spider —
     * law 2, and the exact asymmetry `canHear` exists to prevent.
     *
     * A composed class (one known body striking another) is priced by *both*,
     * `√(L(objMat)·L(mat))`, and it is priced **here** rather than by the emitter for the same
     * reason everything else is: the choke point is what stops each new emitter, and M4's spider,
     * from having to remember the law.
     * An emitter that arrived with a pre-multiplied radius would be invisible to the guards
     * above and would then be scaled by the surface a second time.
     */
    const contact = isContactClass(spec.class);
    assertMaterials('SoundBus.emit', spec.class, spec.mat, spec.objMat);
    /*
     * One question, asked once, answering both halves of §3.9.
     *
     * `mat` is what the event *records* — the surface, for whoever has to give the noise a voice
     * — and `loudness` is what the event *spends* it on. They are read from the same `contact`
     * answer deliberately: an event that recorded a material and then failed to scale by it (or
     * scaled by one it did not record) is precisely the sight-and-sound disagreement the bus
     * exists to make impossible.
     *
     * A ping records `null` and multiplies by concrete's 1.0, which is not the same statement:
     * the first says nothing was struck, the second says nothing was struck *and therefore*
     * nothing changes the reach. Both are true and neither implies the other.
     */
    const mat = contact ? spec.mat ?? MAT_CONCRETE : null;
    /*
     * `?? null` and no default of its own, because the guard above has already decided: a
     * composed class reached this line only by naming one, and every other class reached it only
     * by naming none. A `?? MAT_CONCRETE` here would be unreachable code pretending to be a
     * policy — and the policy it pretends to is the one the guard exists to refuse.
     */
    const objMat = spec.objMat ?? null;
    const loudness = materialVoiceFor(spec.class, spec.mat, spec.objMat);
    /*
     * Both radii, checked before anything is allowed to carry them.
     *
     * §1's "one bus, two senses" says a sound with no paint — or paint with no sound — is
     * impossible to produce. Wiring both subscribers to one stream makes that true of the
     * *plumbing*; it says nothing about the *numbers*, and the numbers are the half an emitter
     * supplies. Unchecked, the override path breaks the claim three separate ways, all measured:
     *
     *  - `paintRadius: 0` emits a voice at a real footstep's gain and unlocks nothing. That is
     *    the law's own counterexample, produced through the public API in one line.
     *  - `paintRadius: NaN` unlocks 36 250 dots where a walk-step unlocks 1 838 — it paints the
     *    room and everything past it, because every downstream reject test has the shape
     *    `if (tooFar) continue`, and NaN fails that comparison, so nothing is ever rejected.
     *    Not painting *less*: painting *twenty times more*.
     *  - `hearingRadius: Infinity` hands the mixer a gain of `Infinity`.
     *
     * So the boundary rejects rather than repairs. A silent clamp would leave the violation
     * possible and merely quiet, which is worse than a crash: it is a law broken in a way nobody
     * can see. This follows the material check just above it — an emitter that names a radius it
     * does not mean has misunderstood what it is emitting, exactly as one that gives a ping a
     * surface has, and a misunderstanding survives to the next reader only if it is swallowed.
     *
     * Resolved values, not the overrides, so one predicate covers the class table too: those
     * numbers are live on the dev panel, and a slider dragged to zero is the same bug arriving
     * by a different road.
     */
    const paintRadius = (spec.paintRadius ?? profile.paintRadius) * loudness;
    const hearingRadius = (spec.hearingRadius ?? profile.hearingRadius) * loudness;
    assertRadius(spec.class, 'paintRadius', paintRadius);
    assertRadius(spec.class, 'hearingRadius', hearingRadius);
    let dx = spec.dirX ?? 0;
    let dy = spec.dirY ?? 0;
    let dz = spec.dirZ ?? 0;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) {
      dx /= len;
      dy /= len;
      dz /= len;
    } else {
      dx = 0;
      dy = 0;
      dz = 0;
    }
    const cone = spec.coneAngleDeg ?? profile.coneAngleDeg;
    const event: SoundEvent = {
      class: spec.class,
      source: spec.source ?? 'world',
      emitter: spec.emitter ?? NO_EMITTER,
      x: spec.x,
      y: spec.y,
      z: spec.z,
      mat,
      objMat,
      paintRadius,
      hearingRadius,
      intensity: spec.intensity ?? profile.intensity,
      // A cone with no aim is a contradiction; fall back to omni rather than paint a slit.
      dirX: dx,
      dirY: dy,
      dirZ: dz,
      coneAngleDeg: len > 1e-6 ? cone : 360,
      waveSpeed: Math.max(0.5, spec.waveSpeed ?? this.tunables.waveSpeeds[profile.wave]),
      time: this.now,
      seq: this.seq++,
    };
    this.last = event;
    this.tickCount++;
    if (this.tickCount > this.tickPeak) this.tickPeak = this.tickCount;

    /*
     * Fan out over a snapshot, not over the live set.
     *
     * A JS `Set` iterated with for-of visits entries added *during* the iteration, so a listener
     * that subscribes while an event is being delivered would receive that same event — and one
     * that unsubscribes would or would not, depending on where in the set it sat. Both make
     * delivery depend on registration order rather than on subscription time. The snapshot fixes
     * the answer in one direction for both: the set of listeners for an event is the set that
     * existed when it was emitted. Subscribing during fan-out means "from the next event";
     * unsubscribing during fan-out still receives this one.
     */
    fanoutScratch.length = 0;
    for (const listener of this.listeners) fanoutScratch.push(listener);
    fanningOut = true;
    try {
      for (let i = 0; i < fanoutScratch.length; i++) fanoutScratch[i]!(event);
    } finally {
      // `finally`, so a listener that throws does not wedge the bus shut for the rest of the
      // run. The throw itself still propagates — the bus does not swallow other people's errors.
      fanningOut = false;
      fanoutScratch.length = 0;
    }
    return event;
  }

  /**
   * **One hearing law, for every ear** — §3.1.
   *
   * An event reaches a listener only when the distance is inside *both* numbers: the listener's
   * own range (18 m for the player's rig, more with the Sensitivity chip, whatever the spider
   * turns out to have) and the event's own carry radius, the right-hand column of §3.3. A
   * crouch-step carries 2 m, so standing 10 m away you do not hear it — and neither does
   * anything else.
   *
   * `Math.min` of the two, in one place, deliberately. The alternative is a listener whose ears
   * obey different physics from the enemy's, which would make §3.3's right column a rule on one
   * side of the hunt and a fiction on the other: the player would receive paint from a footfall
   * quiet enough that the spider two metres from it heard nothing. The whole table is a set of
   * promises about *how far a sound goes*, and a sound that goes further for one listener than
   * for another is the system lying (law 2).
   *
   * Static and instance-free because it is a law rather than a tuning knob — the same reason
   * `landingRadius` is. M4's spider calls this exact function with its own range; so does every
   * ear added after it.
   */
  static canHear(
    event: SoundEvent,
    listenerX: number,
    listenerY: number,
    listenerZ: number,
    listenerRange: number,
  ): boolean {
    const distance = Math.hypot(
      event.x - listenerX,
      event.y - listenerY,
      event.z - listenerZ,
    );
    return distance <= Math.min(listenerRange, event.hearingRadius);
  }

  /**
   * Landing paint radius from touchdown speed — the 8-14 m band of §3.3.
   *
   * Static, and reads the frozen default rather than a bus's own table, because the landing band
   * is not on the dev panel: nothing can tune it, so nothing can make two buses disagree. Give it
   * a slider one day and it moves onto the instance with the rest of them.
   */
  static landingRadius(impactSpeed: number): number {
    const base = SOUND_CLASSES.landing.paintRadius;
    const t = speedFraction(impactSpeed, LANDING_MIN_IMPACT, LANDING_FULL_IMPACT);
    return base + (LANDING_MAX_RADIUS - base) * t;
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/**
 * Where a contact speed sits in a class's speed band, 0 to 1 — the clamp every band shares.
 *
 * One function because the trapdoor below is one trapdoor, and a second band written out by hand
 * is a second chance to reopen it. The landing is the only band today — the thrown can's 8-12 m
 * impact band went with the can, because a detonation has one voice and is not priced by how fast
 * it arrived — and the bands M4 adds for the spider will come back through here.
 */
function speedFraction(speed: number, min: number, full: number): number {
  const t = (speed - min) / (full - min);
  /*
   * NaN is answered with the floor of the band, not passed through.
   *
   * `t < 0 ? 0 : t > 1 ? 1 : t` is a correct clamp for every number and a trapdoor for the
   * one value that is not one: NaN fails both comparisons and falls out the bottom unchanged,
   * so a NaN impact speed used to produce a NaN paint radius. That does not throw, and what it
   * does instead is the opposite of harmless. Every reject test downstream has the shape
   * `if (tooFar) continue`, and NaN fails *that* comparison too, so nothing is ever rejected:
   * a NaN radius does not paint nothing, it paints everything. Measured, it unlocks 36 250 dots
   * where an honest walk-step unlocks 1 838 — the room, and the rooms past it, floodlit by a
   * landing whose speed we could not read. That is the law-2 lie in its loudest form: the world
   * drew geometry no sound reached.
   *
   * So a contact whose speed we cannot measure is still a contact, and it rings out at the
   * quietest thing of its class. The order matters: the NaN test has to come first, or the
   * comparisons it is protecting against have already run.
   *
   * ±Infinity needs no guard and deliberately does not get one — they are not degenerate, they
   * are the ends of the band. -Infinity clamps to 0 and +Infinity to 1, which is the loudest
   * possible contact answering with the widest radius its band has.
   */
  return Number.isNaN(t) || t < 0 ? 0 : t > 1 ? 1 : t;
}
