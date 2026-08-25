/**
 * Ballistics — the swept integrator for a thrown body.
 *
 * A sphere leaves your hand, arcs, and goes off against the first thing it touches. Everything in
 * that sentence except the sound happens here, and the whole module is that one sentence: this
 * reports **first contact and stops**. There is no restitution, no rolling, no rest state and no
 * contact taxonomy, because a thrown thing in this game does not survive what it hits
 * (`game/spheres.ts`). Whatever it struck is the last thing anyone needs to know about it.
 *
 * ## Why this is not `moveBody`
 *
 * `moveBody` next door is two hundred lines of player-stance machinery — step-up, mantle slack,
 * ground snap, coyote edges — none of which a projectile wants, and it resolves motion in a way a
 * projectile cannot survive. `slideXZ` teleports the body to `p + v·dt` and then depenetrates it
 * from whatever it overlaps *there*, and `circlePush` ejects through the box's **nearest** face,
 * so a step that lands past a box's midplane is pushed out of the far side. The tunnelling law is
 * therefore `speed·dt > thickness/2 + radius`, not `thickness + 2·radius`: measured, a 0.06 m
 * body at 24 m/s passes clean through a 0.1 m wall. Every sound-trap the tower plans — a pane, a
 * chain curtain, a railing — is far thinner than that, and a thrown sphere is exactly the speed
 * that breaks it. A sphere that tunnelled would be a boom that never happened, which is the verb
 * silently not working.
 *
 * So the body here is *swept*, never teleported: one `raycastWorld` segment per tick, stopping at
 * whatever it strikes. That is the whole reason this module exists and it is the one part of it
 * that may not be simplified away.
 *
 * ## The body is a point
 *
 * Not a sphere. `raycastWorld`'s contract was written for exactly this consumer — inclusive
 * `maxDist` "for a thrown object stepped by `speed * dt`", `t = 0` means contact rather than
 * impact, an origin inside a box answers with a usable normal — and thirty-nine tests pin it. The
 * alternative does not exist yet: `sweepSphereWorld` returns a bare distance, with no normal and
 * no box, so it cannot tell you what you hit or which way the sound leaves the surface.
 *
 * What a point costs is bounded by `SPHERE_RADIUS`, 0.06 m: every contact point is within one
 * lattice-dot spacing of where a body with a volume would have put it, and nothing in §3.3
 * resolves below half a metre. What it permits — slipping through a gap narrower than a sphere —
 * has no instance in the shipped room, whose thinnest authored axis is a 0.28 m stair riser.
 *
 * ## What this module refuses to know
 *
 * There is no `SoundBus` import here and there must never be one. The contact is reported as a
 * plain record and `game/spheres.ts` turns it into a queue the sim emits from — the same division
 * `PlayerController` and `sim.ts` already ship, for the same reason: the physics cannot be wrong
 * about §3.9's material voices if it never touches a radius. It hands over the struck `Aabb`,
 * which is the one answer that cannot disagree with what the body actually touched, and stops
 * there. (The sphere's boom is its own voice and is not scaled by that material — see
 * `SOUND_CLASSES['sphere-boom']` — but the box is what a future emitter would price, and the
 * physics is not the place to decide it.)
 *
 * ## Module-level scratch
 *
 * `rayHit` is one shared `RayHit`, filled and read inside a single `stepBallistic` call and never
 * held past it — the same contract, and the same two failure modes (reentrancy, retention), that
 * `collision.ts` documents at length for its own scratch. Any number of bodies may be stepped as
 * long as the calls are sequential on one thread, which is exactly what a fixed update over a
 * pool of spheres is. The contact record is the caller's, passed in and filled: one allocation
 * per pool slot, forever, and no per-contact garbage on the tick that was about to make a noise.
 */

import { createRayHit, raycastWorld, type Aabb, type RayHit, type StaticWorld } from './collision';

/**
 * A thrown body: a point with a velocity, and nothing else.
 *
 * No `grounded`, no `asleep`. A sphere is airborne from launch to contact and does not exist
 * afterwards, so the regime state a bouncing can needed has nobody left to describe.
 *
 * Plain mutable data on purpose — `game/spheres.ts` owns the pool, assigns the slots, and starts
 * bodies by writing to them. Nothing here is private and nothing here is derived: what you read
 * is what the next tick integrates.
 */
export interface BallisticBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/**
 * Where a body first touched the world — the record `stepBallistic` fills and hands back.
 *
 * There is deliberately no `kind` and no approach speed. A contact is the end of the body's life,
 * so there is nothing to distinguish a hard one from a soft one *for*: the boom is one constant
 * voice (§3.3), not a band read off a speed, and the day something wants a graded impact back it
 * should arrive with the emitter that needs it rather than as a field nobody reads.
 */
export interface BallisticContact {
  /**
   * Where the contact happened — the point on the struck face, *before* the standoff below
   * nudges the body clear of it. The standoff is a numerical device and has no business leaking
   * into what the world hears: the sound comes from where the two surfaces met.
   */
  x: number;
  y: number;
  z: number;
  /** The struck face's unit normal, pointing back at the body. */
  nx: number;
  ny: number;
  nz: number;
  /**
   * The box that was struck — the world's own box, not a copy, valid until the world is rebuilt.
   * The one answer that cannot disagree with what the body actually touched.
   */
  box: Aabb;
}

/** An empty contact record for a caller to keep and refill. `box` is replaced on every hit. */
export function createBallisticContact(): BallisticContact {
  return { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, box: EMPTY_BOX };
}

/**
 * The placeholder a fresh record carries until it has been filled.
 *
 * A record that has never reported a contact has no box to name, and `Aabb` has no null. This one
 * is degenerate on every axis, so anything that reads it before a hit gets an obviously empty
 * answer rather than a plausible wrong one.
 */
const EMPTY_BOX: Aabb = Object.freeze({
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 0,
  maxY: 0,
  maxZ: 0,
  mat: 0,
  shell: false,
});

/**
 * Metres per second squared, downward. **Plain 16 — the world constant**, with no
 * `fallGravityMult`.
 *
 * The player's 1.6× fall multiplier is a game-feel cheat for a body with a jump arc to land out
 * of, and `LANDING_MIN_IMPACT`'s "≈ a 0.8 m drop" is only true at 16, so a thrown thing that
 * keeps the plain constant keeps every derived band honest. A sphere and a falling player
 * genuinely descend at different rates; both are invisible in flight, and the player's is the
 * licensed lie.
 *
 * Exported because `arcPoints` (`game/spheres.ts`) has to draw the arc this number produces, and
 * a preview drawn against a second copy of gravity is a preview that can be wrong.
 */
export const BALLISTIC_GRAVITY = 16;

/**
 * The two numbers a swept point needs. First-pass tuning values, in one place.
 */
export interface BallisticTunables {
  /** Downward acceleration, m/s². See `BALLISTIC_GRAVITY`. */
  gravity: number;
  /**
   * Metres of standoff along the contact normal, `collision.ts`'s `EPS` — and **load-bearing
   * rather than hygiene**. Measured: a ray whose origin sits exactly on the floor's top face with
   * direction `(1, −0.01, 0)` reports `t = 0` with the normal `(−1, 0, 0)` — a *sideways* exit
   * face, exactly as `raycastWorld`'s docstring warns it may for an oblique ray. From 1e-3 above
   * that face the same ray reports the honest `(0, 1, 0)` at the honest distance.
   *
   * A sphere is removed the tick it makes contact, so the standoff no longer has a roll to
   * protect. What it still protects is the *spawn* contract `game/spheres.ts` keeps —
   * `min(handDist, hit.t − skin)` along the aim — which is what stops a sphere charged
   * nose-against-concrete from being born inside the wall and going off through it.
   */
  skin: number;
}

export function defaultBallisticTunables(): BallisticTunables {
  return { gravity: BALLISTIC_GRAVITY, skin: 1e-3 };
}

/** The one shared hit — see the scratch note at the top of the file. */
const rayHit: RayHit = createRayHit();

/**
 * Integrates one body for one tick, mutating it, and returns the contact it made or `null`.
 *
 * ## The order of a tick
 *
 * Semi-implicit Euler, gravity into the velocity *first* and then move with the new velocity,
 * matching `PlayerController`'s convention exactly so that the game's two integrators agree on
 * what a tick is. After `n` ticks a body launched at `v_0` is therefore at
 * `p_0 + n·dt·v_0 + g·dt²·n(n+1)/2` — half a tick of extra fall against the textbook parabola,
 * which is why `arcPoints` draws the sum and not the parabola.
 *
 * ## One sweep, not a loop
 *
 * The tick casts the whole of its motion once. If nothing is in the way the body spends the
 * entire step in free flight, exactly `p + v·dt`; if something is, the body is advanced to the
 * contact point, stood off along the normal, and the rest of the tick is dropped along with the
 * rest of the body's life. There is nothing left to resolve — no rebound to compute, no residual
 * motion to spend — so the multi-iteration budget a bouncing body needed has no work to do here.
 *
 * ## `t = 0` is contact, not impact
 *
 * `raycastWorld` reports geometry it is already touching, and a `t = 0` answer is one of those.
 * It is a contact like any other for a sphere: the body is standing on the thing it is about to
 * go off against. The caller voices it and removes the body, so the oscillation a `t = 0` answer
 * used to threaten — reflect, re-enter, reflect — cannot happen: there is no next tick.
 */
export function stepBallistic(
  world: StaticWorld,
  body: BallisticBody,
  dt: number,
  t: BallisticTunables,
  out: BallisticContact,
): BallisticContact | null {
  body.vy -= t.gravity * dt;

  const speed = Math.hypot(body.vx, body.vy, body.vz);
  const reach = speed * dt;
  // Catches a stopped body, a zero-length tick, and NaN — all three would otherwise ask
  // `raycastWorld` for a non-positive ray, and one of them would walk the body backwards.
  if (!(reach > 0)) return null;

  const dx = body.vx / speed;
  const dy = body.vy / speed;
  const dz = body.vz / speed;
  const hit = raycastWorld(world, body.x, body.y, body.z, dx, dy, dz, reach, rayHit);
  if (hit === null) {
    // Nothing in the way. Stepped by the velocity rather than by `direction * reach` so free
    // flight is exactly `p + v·dt` — the normalise-and-rescale round trip is a rounding error the
    // body has no reason to carry, and `arcPoints` is drawing the un-rounded version.
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    body.z += body.vz * dt;
    return null;
  }

  const cx = body.x + dx * hit.t;
  const cy = body.y + dy * hit.t;
  const cz = body.z + dz * hit.t;
  // The pose the body ends the tick in: on the contact, a skin clear of the face. Whatever draws
  // a sphere reads this, so it may not be left inside the surface it just struck.
  body.x = cx + hit.nx * t.skin;
  body.y = cy + hit.ny * t.skin;
  body.z = cz + hit.nz * t.skin;

  out.x = cx;
  out.y = cy;
  out.z = cz;
  out.nx = hit.nx;
  out.ny = hit.ny;
  out.nz = hit.nz;
  out.box = hit.box;
  return out;
}
