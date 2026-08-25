/**
 * The Halo — §3.8's self-readout, and the one number both halves of it are made of.
 *
 * "A ring around the reticle whose brightness equals your current audible radius, plus a matching
 * hum pitch. You always know exactly how loud you are. **Non-negotiable:** the genre's
 * most-repeated complaint is 'I can't tell when I'm detectable.'"
 *
 * That is the only place the vision doc says *non-negotiable*, and the reason it is worth a file
 * of its own is the word *matching*. The ring and the hum are two readouts of one quantity, and
 * the failure mode is not that either is wrong — it is that they are computed in two places and
 * drift, so the player learns to trust one and the other becomes decoration. So this module owns
 * the quantity, and the ring's brightness is derived *from* the hum's pitch (`haloBrightness`).
 * Neither can move without the other, structurally, rather than because somebody remembered.
 *
 * **What the radius is.** §3.3's right-hand column — how far away you can be *heard* — and not
 * the left one. A crouch-step paints 1.5 m and carries 2 m; the Halo reports the 2. The number
 * comes from `SoundBus.carryRadius`, which is the same arithmetic `emit` uses, so §3.9's material
 * voice is in it: the same stride reads 0.6× on dust and 1.5× on steel. That consequence is the
 * point rather than a side effect — the ring is how a player learns that the walkway they are
 * about to cross is the loud one, without having to cross it first.
 *
 * **Why it glides.** §3.8: "It glides continuously rather than stepping between stances, because
 * the ring is continuous and the two must never disagree; quantizing the hum into gears would
 * hide exactly the in-between states where you most want to know how loud you are." The radius
 * the world actually emits *is* piecewise constant — a footfall belongs to one of three classes
 * and strikes one of four surfaces — so the continuity has to come from somewhere, and it comes
 * from here: `advance` moves toward the target on a time constant, and both readouts read the
 * glided value. Standing up out of a crouch, accelerating into a sprint, stepping off dust onto
 * steel: each is a sweep the player can hear and see, not a gear change.
 *
 * **What it does not report.** Landings. A landing is the loudest single thing a body does
 * (§3.3: 28 m, and 42 on steel), and it is an *instant*, not a state — a spike on a readout whose
 * job is to answer "how loud am I being". The paint flash already announces it, loudly, in the
 * channel built for events. The Halo answers for the gait.
 */

import { maxMaterialLoudness } from './materials';
import { SOUND_CLASSES } from './soundEvents';

/**
 * The radius the pitch map is referenced to, metres — §3.8's `55·√(r/1.5)`.
 *
 * It is deliberately *not* a stance: the quietest stance is a crouch at 2 m on concrete, and 1.2
 * on dust. 1.5 is the divisor of the formula the doc fixes, and it doubles as the floor of the
 * readout, because a pitch cannot encode zero and a body standing still emits nothing at all.
 * Everything quieter than this — a standstill, a dusty crouch — reads as the bottom of the ring
 * and the bottom of the hum. That is a real loss of resolution at the very bottom, and it is the
 * honest one: the reading it collapses to is "nothing more than a metre and a half away can hear
 * you", which is the answer a player at that end of the range is actually asking for.
 */
export const HALO_REFERENCE_M = 1.5;

/** The hum's fundamental at the reference radius, Hz (§3.8) — felt more than heard. */
export const HALO_REFERENCE_HZ = 55;

/**
 * The loudest reading, metres: a sprint-step on the loudest surface the game has.
 *
 * 24 m × 1.5 = 36 today. Derived from the two tables rather than written down, so a louder
 * material or a louder sprint raises the ceiling instead of silently saturating against it —
 * a readout that pegs is a readout that has stopped answering.
 *
 * Read from the *frozen* class table and not from a simulation's tunable copy, because the
 * ceiling is the scale the ring is drawn against and a scale that moved while a dev-panel slider
 * was dragged would make two frames incomparable. The reading itself does follow the sliders (see
 * `SoundBus.carryRadius`); only the top of the dial is fixed.
 */
export const HALO_MAX_RADIUS_M = SOUND_CLASSES['sprint-step'].hearingRadius * maxMaterialLoudness();

/**
 * The glide's time constant, seconds — how fast the readout catches up with the body.
 *
 * First-pass tuning, and the two failure modes it sits between are both real: too fast and the
 * "glide" is a step in disguise, hiding the in-between states §3.8 wants exposed; too slow and
 * the ring is reporting the stance you were in rather than the one you are in, which is worse
 * than no readout at all. 0.18 s puts a crouch→sprint transition at roughly a third of a second
 * of audible sweep — about one stride at full speed.
 */
export const HALO_GLIDE_SEC = 0.18;

/**
 * The radius, clamped into the range the readout can express.
 *
 * NaN answers with the floor rather than passing through, for the reason `SoundBus.landingRadius`
 * gives about the same trapdoor: NaN fails every comparison it is given, so it slips through any
 * clamp written as a pair of them. Here the consequence is a readout that goes dead rather than
 * one that goes wrong — `humPitch` would hand the oscillator a NaN frequency — and a dead readout
 * is precisely the complaint §3.8 exists to answer.
 */
function clampRadius(radiusM: number): number {
  if (!(radiusM > HALO_REFERENCE_M)) return HALO_REFERENCE_M;
  return radiusM > HALO_MAX_RADIUS_M ? HALO_MAX_RADIUS_M : radiusM;
}

/**
 * Audible radius (m) → the Halo hum's fundamental (Hz): `55·√(r/1.5)`, §3.8.
 *
 * A square-root — half-log — map, so the quiet end gets the resolution: that is where the player
 * is making decisions about being heard, and where a linear map would put crouch and walk on
 * nearly the same note. The reference radius reads 55 Hz and a 24 m sprint reads 220, two
 * octaves apart; the loudest surface carries the top a little further (`HALO_MAX_HZ`).
 */
export function humPitch(radiusM: number): number {
  return HALO_REFERENCE_HZ * Math.sqrt(clampRadius(radiusM) / HALO_REFERENCE_M);
}

/** The hum's fundamental at the loudest reading, Hz. */
export const HALO_MAX_HZ = humPitch(HALO_MAX_RADIUS_M);

/**
 * The ring's brightness, 0 at the quietest reading and 1 at the loudest.
 *
 * Derived from `humPitch` rather than from the radius directly, and that is the whole trick: the
 * two readouts of §3.8 are then the *same* function of the radius up to an affine map, so they
 * cannot disagree about which of two states is louder, about where the readout saturates, or
 * about how much of the dial the quiet end deserves. Compute the brightness independently — the
 * obvious `r / max` — and the ring spends 94 % of its range above a walk while the hum spends
 * half of its below one, and a player reading both is reading two different games.
 */
export function haloBrightness(radiusM: number): number {
  return (humPitch(radiusM) - HALO_REFERENCE_HZ) / (HALO_MAX_HZ - HALO_REFERENCE_HZ);
}

/**
 * The live readout: the radius the body is heard at, glided.
 *
 * Owns no game state and asks nothing of the player — the caller hands it the target every tick
 * (`GameSim.audibleRadius`), which keeps "what is the body doing" and "what does the readout say
 * about it" in different files.
 */
export class Halo {
  private glided = 0;
  private wanted = 0;

  /**
   * Takes a new target and advances the glide by `dt` seconds.
   *
   * `dt` is *wall* time, not the paint clock: T scales how fast the world's memory ages, and the
   * player's own loudness is not a thing that ages. A frame-rate-independent exponential approach,
   * so the readout is the same at 60 Hz and at 120.
   */
  advance(targetRadiusM: number, dt: number): void {
    this.wanted = Number.isFinite(targetRadiusM) && targetRadiusM > 0 ? targetRadiusM : 0;
    if (!(dt > 0)) return;
    this.glided += (this.wanted - this.glided) * (1 - Math.exp(-dt / HALO_GLIDE_SEC));
  }

  /** Jumps straight to a radius, skipping the glide — for a respawn or a fresh run. */
  reset(radiusM = 0): void {
    this.wanted = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 0;
    this.glided = this.wanted;
  }

  /** The reading: how far away the body can be heard, as the readout currently says it. */
  get radius(): number {
    return this.glided;
  }

  /** Where the reading is heading — the body's true current carry radius, ungliding. */
  get targetRadius(): number {
    return this.wanted;
  }

  /** The hum's fundamental for this reading, Hz. */
  get pitchHz(): number {
    return humPitch(this.glided);
  }

  /** The ring's brightness for this reading, 0–1. */
  get brightness(): number {
    return haloBrightness(this.glided);
  }
}
