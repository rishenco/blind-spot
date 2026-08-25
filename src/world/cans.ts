/**
 * The can — the one throwable of M2, and the numbers both halves of it agree on.
 *
 * A can is the smallest complete statement the game can make: a sound you chose to put
 * somewhere you are not. The E-ping wakes *both* ends of its beam (vision §3.3); a thrown can
 * wakes only the far end. That asymmetry is the entire reason the verb exists, and every number
 * below is chosen to protect it — nothing here may make a throw loud at the thrower's end
 * beyond the wind-up's 2.5 m, because a throw that announces the thrower is just an expensive
 * ping.
 *
 * **Why this file exists rather than the constants living where they are used.** The can is
 * authored in two places that must not disagree: `world/room.ts` places a stack of them and
 * `tests/room.test.ts` asserts you can still walk past it, while the sim owns the rack, the
 * throw and the retrieval. A stack whose clearance was measured against one reach and toppled
 * against another would pass both suites and play wrong. One file, one set of numbers, both
 * halves importing them.
 *
 * **A can is a point.** `core/ballistics.ts` integrates a point against `raycastWorld` — there
 * is no can-shaped collider anywhere in the game, and `CAN_RADIUS` below is a *drawing* number,
 * not a physics one. This is deliberate: the perception of a can is its resting print (a cairn
 * of matter-layer dots), and a print is drawn around a position. Giving physics a radius would
 * buy nothing the player can perceive and would cost the swept integrator its ray.
 */

import { MAT_METAL } from '../paint/materials';

/**
 * A can is metal — the hot voice, ×1.5 (§3.9). This is the *attack* half of every impact it
 * makes; the struck surface answers with its own resonance and the level is the mean of the two
 * in dB (`paint/soundEvents.ts`, `materialVoiceFor`). A metal can on dust is quiet and dull; the
 * same can on the steel bench rings. The can never changes, so what you hear when it lands is a
 * statement about *where it landed* — which is the whole point of throwing it.
 */
export const CAN_MAT = MAT_METAL;

/**
 * Metres, the visual radius of a can's resting print — the ring the cairn's dots sit on.
 *
 * 6 cm, so the glyph is 12 cm across: under the lattice's 0.18 m spacing (`paint/structured.ts`),
 * which is what makes it read as a *placed thing* rather than as floor. A cairn is locally
 * denser than any patch of lattice can be, and that density is the encoding — never a hue of its
 * own (§3.2 forbids geometry taking a source's colour) and never a marker that outlives its age
 * ramp.
 */
export const CAN_RADIUS = 0.06;

/**
 * How many cans the rig's rack holds, and how many it starts a run with.
 *
 * Four, because humans subitize up to four: a four-pip readout is *perceived*, not counted, and
 * the whole count fits in a player's head mid-chase without a number on screen. Three invites
 * hoarding — lose one in the dark and a third of the kit is gone, and an unthrown can is a
 * mechanic that does not exist. Five needs counting and invites spam.
 */
export const CAN_RACK_CAP = 4;

/**
 * Metres per second, the charge curve's ends: `v(t) = CAN_THROW_MIN + (CAN_THROW_MAX -
 * CAN_THROW_MIN) · clamp01(t / CAN_CHARGE_SECONDS)`, held at the cap indefinitely.
 *
 * Linear in speed is quadratic in range, which puts the fine control at short range — the
 * feed-the-gap tosses, where a metre matters — and the coarse control at long range, where the
 * landing zone is a room rather than a spot. A tap carries ~2.5–4 m level; a full charge ~8 m
 * level and ~20 m lofted, which clears the E-ping's 22 m only by aiming up. That the loft is a
 * skill with no arc preview, taught by hearing where the clang lands, is the design.
 *
 * The cap was originally justified as a *safety* number — 18 m/s is 0.15 m per 120 Hz tick,
 * inside the unswept solver's tunnelling envelope for this room. That argument is now stale in
 * the good direction: a can never enters `moveBody`, it runs on the swept integrator, and
 * `doc/known-issues.md` records why. 18 stays because it is the right design number, and it is
 * now free to move on playtest evidence alone.
 */
export const CAN_THROW_MIN = 6;
export const CAN_THROW_MAX = 18;

/** Seconds from wind-up start to full tension. */
export const CAN_CHARGE_SECONDS = 0.9;

/**
 * Metres in front of the eye that a released can appears, along the aim.
 *
 * The launch point is the *eye at the current stance height*, not a fixed height: a crouched rig
 * throws from where a crouched rig's hand is. This deliberately does not inherit the E-beam's
 * recorded law-2 debt (`doc/known-issues.md`: the beam leaves from 30 cm above a crouched head).
 * New emitters do not inherit old bugs.
 */
export const CAN_MUZZLE_M = 0.35;

/**
 * Metres. How close the rig's body centre must come to a can, in three dimensions, to touch it.
 *
 * There is no pickup key. The rig stoops for a can its body meets, which is exactly the register
 * of §3.1's "surfaces you touch" — and the reason a key would be wrong is that a key implies a
 * prompt, and a prompt implies the game telling you a can is there. The can's resting print
 * already told you.
 */
export const CAN_REACH = 0.6;

/**
 * Metres. A can you released is inert until you have been this far from it at least once.
 *
 * Without it, setting a can down at your feet is a pickup loop — release, re-collect, release —
 * and the emergent throw-cancel (aim down, tap, catch it back on the way out) becomes a
 * stutter instead of a priced abort. Too short and a can that bounces back to your feet
 * re-vacuums; too long and a can lying a stride away is mysteriously inert, which reads as a
 * bug rather than a rule. Both failure directions are visible in play, so this moves on
 * evidence.
 */
export const CAN_REARM_M = 1.5;

/**
 * Metres per second. Below this the rig lifts a can it touches; at or above it, it kicks it.
 *
 * **This one number produces four behaviours, which is why it is one number and not four.**
 * Walk (3.5 m/s) up to your own can and you pick it up — retrieval never fights you, and a
 * mechanic whose retrieval fights you is a mechanic nobody uses twice. Sprint (6.0 m/s) into it
 * and you boot it across the floor, loudly, which is the same lesson the game teaches
 * everywhere: it prices, it does not prevent. Walk the north lane and you can thread the stack
 * or lift cans off it one at a time; sprint the north lane blind and the stack comes down on
 * you. The lane was already "fast and loud" — this makes it "fast, loud, and it bites if you
 * run it blind", without adding a second fork to a room that only wants one.
 *
 * 4.5 sits clear of both stances rather than between two adjacent ones: 1.0 above walk and 1.5
 * below sprint, so the boundary is never ambiguous to a player who is not thinking about it.
 */
export const CAN_LIFT_SPEED = 4.5;

/**
 * Metres between the centres of two cans in an authored stack.
 *
 * A stack is a *column*, not a pile, and the reason is perceptual rather than physical. Every
 * other thing in the room is a lattice-sampled surface, so a flat pile competes directly with
 * the floor beneath it; a tight vertical bar of cairns 0.7 m tall competes with nothing and
 * reads instantly as something a person stacked. The room is black — the silhouette is the only
 * thing a player gets, so the silhouette has to do the work.
 */
export const CAN_STACK_PITCH = 0.12;

/**
 * One authored can in a stack: a pose, and how far the column leans by the time it reaches this
 * can.
 *
 * The lean is authored rather than random because a seeded run has to be reproducible, and it
 * exists because a perfectly plumb column reads as a rendered primitive while a leaning one
 * reads as a thing somebody balanced badly. It is 2–4 cm of drift, well under `CAN_RADIUS`, so
 * the column is still a column.
 */
export interface CanPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
