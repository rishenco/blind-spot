/**
 * Ballistics — the swept integrator for a thrown body.
 *
 * A can leaves your hand, arcs, strikes a wall, bounces, rolls, and stops. Everything in that
 * sentence except the sound happens here.
 *
 * ## Why this is not `moveBody`
 *
 * `moveBody` next door is two hundred lines of player-stance machinery — step-up, mantle slack,
 * ground snap, coyote edges — none of which a can wants, and it resolves motion in a way a can
 * cannot survive. `slideXZ` teleports the body to `p + v·dt` and then depenetrates it from
 * whatever it overlaps *there*, and `circlePush` ejects through the box's **nearest** face, so a
 * step that lands past a box's midplane is pushed out of the far side. The tunnelling law is
 * therefore `speed·dt > thickness/2 + radius`, not `thickness + 2·radius`: measured, a 0.06 m
 * body at 24 m/s passes clean through a 0.1 m wall. Every sound-trap the tower plans — a pane,
 * a chain curtain, a railing — is far thinner than that, and a thrown can is exactly the speed
 * that breaks it.
 *
 * The second reason is worse than the first, because it bites even where nothing tunnels:
 * `slideXZ` zeroes the into-wall component of the velocity. That is slide semantics, correct for
 * feet and wrong for everything else. A can that cannot bounce is not a can; it is a dart that
 * sticks to the first wall by dying there.
 *
 * So the body here is *swept*, never teleported: each tick is a short sequence of `raycastWorld`
 * segments that stop at whatever they strike, and a contact is resolved by reflecting or
 * clamping the velocity — never by pushing the body back out of a box it should not have
 * entered in the first place.
 *
 * ## The body is a point
 *
 * Not a sphere. `raycastWorld`'s contract was written for exactly this consumer — inclusive
 * `maxDist` "for a thrown object stepped by `speed * dt`", `t = 0` means contact rather than
 * impact, an origin inside a box answers with a reflectable normal — and thirty-nine tests pin
 * it. The alternative does not exist yet: `sweepSphereWorld` returns a bare distance, with no
 * normal and no box, so it cannot tell you what you hit or which way to leave, and it could not
 * voice the impact (§3.9 makes the struck surface's material the sound). Building a sphere query
 * that can is a new, untested narrowphase whose Minkowski corners over-report — a bounce off the
 * square corner of an inflated box is a bounce off empty air, and in a game where paint is sight
 * that is a law-2 smell.
 *
 * What a point costs is bounded by a real can's radius, ~0.05 m: every impact point and every
 * resting pose is within one lattice-dot spacing of where a body with a volume would have put
 * it, and nothing in §3.3 resolves below half a metre. What it permits — slipping through a gap
 * narrower than a can — has no instance in the shipped room, whose thinnest authored axis is a
 * 0.28 m stair riser. The day M3's traps want *volumetric* interaction (a can threading a chain
 * curtain should ring it) is the day to add an inflated nearest-hit query, with its own
 * corner-behaviour tests, and not a day sooner.
 *
 * ## What this module refuses to know
 *
 * There is no `SoundBus` import here and there must never be one. Contacts are reported as
 * plain records and the throwable system turns them into emits — the same division
 * `PlayerController` and `sim.ts` already ship, for the same reason: the physics cannot be
 * wrong about §3.9's material voices if it never touches a radius. It hands over the struck
 * `Aabb`, which is the one answer that cannot disagree with what the body actually touched, and
 * stops there.
 *
 * ## Module-level scratch
 *
 * `rayHit` is one shared `RayHit`, filled and read inside a single `stepBallistic` call and
 * never held past it — the same contract, and the same two failure modes (reentrancy,
 * retention), that `collision.ts` documents at length for its own scratch. Any number of bodies
 * may be stepped as long as the calls are sequential on one thread, which is exactly what a
 * fixed update over a pool of cans is.
 *
 * The contact records themselves are *not* pooled: each one is freshly allocated. That is a
 * deliberate few bytes per contact-edge, and the alternative was measured against it and lost.
 * Pooling would mean the caller's array quietly changing contents under it on the next body's
 * step — a far sneakier hazard than `world.query` handing back the buffer you gave it, and the
 * caller here is meant to keep records long enough to sort, merge and emit them. A contact is an
 * *edge*, not a state: a can in free flight produces none at all, a whole throw produces two to
 * five, and the ticks that allocate are the ticks that were about to make a noise anyway.
 */

import { createRayHit, raycastWorld, type Aabb, type RayHit, type StaticWorld } from './collision';

/**
 * A thrown body: a point with a velocity, plus the two bits of regime state that decide which
 * physics it gets this tick.
 *
 * Plain mutable data on purpose — the throwable system owns the pool, assigns the slots, and
 * wakes bodies by writing to them (`wakeBallistic`). Nothing here is private and nothing here
 * is derived: what you read is what the next tick integrates.
 */
export interface BallisticBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /**
   * Constrained to a support face and rolling out. A grounded body gets no gravity, never moves
   * on Y, and sits exactly `skin` above the surface it rests on; the tick it rolls off an edge
   * the support probe falsifies this and it falls.
   */
  grounded: boolean;
  /** At rest. `stepBallistic` returns immediately — no queries, no arithmetic, no records. */
  asleep: boolean;
}

/**
 * What a contact was, which is what decides whether the world gets to hear about it.
 *
 * - `bounce` — a real impact that reflected. The loud ones; they decay geometrically, so a throw
 *   makes two to five of them and then stops making them.
 * - `ground` — a touchdown too soft to bounce, on an upward face. Recorded **however soft**, and
 *   the system emits every one of them: see `stepBallistic` for why the quiet ones are the
 *   important ones.
 * - `graze` — a contact that resolved without a bounce and without landing: a slow scrape along
 *   a wall, or a `t = 0` separation. Reported for observability, never emitted in M2.
 * - `rest` — not a collision at all: the one record that marks the body falling asleep, carrying
 *   its final pose and the surface it came to rest on. Fires exactly once per settle.
 */
export type ContactKind = 'bounce' | 'ground' | 'graze' | 'rest';

export interface BallisticContact {
  kind: ContactKind;
  /**
   * Approach speed along the normal in m/s — `|v·n|` as it stood *before* the contact was
   * resolved. This is the number an impact's loudness is a function of, which is why it is the
   * approach and not the rebound: what you hear is the energy that arrived.
   *
   * Zero on a `rest` record, which arrives at no speed by definition.
   */
  speed: number;
  /**
   * Where the contact happened — the point on the struck face, *before* the standoff below
   * nudges the body clear of it. The standoff is a numerical device and has no business leaking
   * into what the world hears: the sound comes from where the two surfaces met.
   */
  x: number;
  y: number;
  z: number;
  /** The struck face's unit normal, pointing back at the body. `(0, 1, 0)` on a `rest` record. */
  nx: number;
  ny: number;
  nz: number;
  /**
   * The box that was struck — the world's own box, not a copy, valid until the world is rebuilt.
   * `box.mat` is the impact's voice (§3.9) and the only reason the physics reports a box at all.
   */
  box: Aabb;
}

/**
 * First-pass tuning values, in one place because the whole point of one place is that the day a
 * playtest says "a can off dust should not bounce like a can off steel" the fix is a column in
 * `MATERIALS` and a five-line diff here, not a hunt.
 */
export interface BallisticTunables {
  /**
   * Metres per second squared, downward. **Plain 16 — the world constant**, with no
   * `fallGravityMult`. The player's 1.6× fall multiplier is a game-feel cheat for a body with a
   * jump arc to land out of, and `LANDING_MIN_IMPACT`'s "≈ a 0.8 m drop" is only true at 16, so
   * a can that keeps the plain constant keeps every derived band honest. A can and a falling
   * player genuinely descend at different rates; both are invisible in flight, and the player's
   * is the licensed lie.
   */
  gravity: number;
  /** Fraction of the approach speed returned along the normal by a bounce. */
  restitution: number;
  /** Fraction of the tangential velocity a bounce keeps. Friction, in one number. */
  tangentKeep: number;
  /**
   * Reflected normal speed, m/s, below which there is no bounce: the contact grounds out or
   * clamps instead. This is a **physics** cut — where bouncing stops — and it is deliberately
   * not the audibility floor, which is a *loudness* cut owned by the emitter. Conflating them
   * would tie "can you hear it" to "does it still bounce", and those are different questions
   * about the same thud.
   *
   * 1.0 m/s of rebound is an apex of about 3 cm. It is what kills the Zeno tail in a single
   * comparison, and it is one of four independent fences against a can bouncing forever: the
   * others are geometric decay (`restitution < 1` shrinks every apex by its square), the roll
   * to `restSpeed`, and `maxSweeps` bounding any one tick.
   */
  bounceMin: number;
  /** Horizontal deceleration, m/s², while grounded. Rolling friction, in one number. */
  rollDecel: number;
  /** Horizontal speed, m/s, below which a grounded body stops and sleeps. */
  restSpeed: number;
  /**
   * Metres of standoff along the contact normal after every resolved contact — `collision.ts`'s
   * `EPS`, and **load-bearing rather than hygiene**. Measured: a ray whose origin sits exactly on
   * the floor's top face with direction `(1, −0.01, 0)` reports `t = 0` with the normal
   * `(−1, 0, 0)` — a *sideways* exit face, exactly as `raycastWorld`'s docstring warns it may
   * for an oblique ray. From 1e-3 above that face the same ray reports the honest `(0, 1, 0)` at
   * the honest distance, and a purely horizontal ray from up there misses the floor entirely (which
   * is what lets a rolling body travel without its own support blocking it). Without the
   * standoff, every tick of a roll starts on the face and gets a sideways answer.
   */
  skin: number;
  /**
   * Contacts resolved per tick before the residual motion is dropped. Four is a corner plus
   * slack; the tick that needs more is a wedge, and losing a couple of centimetres of travel
   * inside one is the safe direction to be wrong in. Gaining penetration never is.
   */
  maxSweeps: number;
}

export function defaultBallisticTunables(): BallisticTunables {
  return {
    gravity: 16,
    restitution: 0.45,
    tangentKeep: 0.75,
    bounceMin: 1.0,
    rollDecel: 8,
    restSpeed: 0.15,
    skin: 1e-3,
    maxSweeps: 4,
  };
}

/** The one shared hit — see the scratch note at the top of the file. */
const rayHit: RayHit = createRayHit();

/**
 * Kicks a body: sets its velocity and clears `asleep`.
 *
 * `grounded` is deliberately left alone rather than cleared. A kicked body that is still over
 * its support should stay constrained to it and roll; one that is not will be falsified by the
 * support probe at the end of this very tick, which is the one place in the module that is
 * allowed to have an opinion about whether a surface is there. Guessing here would be a second
 * opinion, and a second opinion is how a body ends up airborne a millimetre above a floor.
 *
 * A sleeping body's velocity is zero, so "set" and "add an impulse to" are the same operation on
 * the case this exists for; the magnitudes are the caller's tuning.
 */
export function wakeBallistic(body: BallisticBody, vx: number, vy: number, vz: number): void {
  body.vx = vx;
  body.vy = vy;
  body.vz = vz;
  body.asleep = false;
}

function record(
  contacts: BallisticContact[],
  kind: ContactKind,
  speed: number,
  x: number,
  y: number,
  z: number,
  hit: RayHit,
): void {
  contacts.push({
    kind,
    speed,
    x,
    y,
    z,
    nx: hit.nx,
    ny: hit.ny,
    nz: hit.nz,
    box: hit.box,
  });
}

/**
 * Integrates one body for one tick, mutating it, and appends whatever it touched to `contacts`.
 *
 * `contacts` is **cleared at the top of every call** — `world.query`'s convention, and the one
 * that makes "drain it immediately after the step" the only way to use it. The records
 * themselves are fresh objects, so the caller may keep them (sort them, merge two bodies' logs,
 * emit them next frame) without copying.
 *
 * ## The order of a tick
 *
 * Semi-implicit Euler, gravity into the velocity *first* and then move with the new velocity,
 * matching `PlayerController`'s convention exactly so that the game's two integrators agree on
 * what a tick is.
 *
 * 1. Asleep bodies return immediately. Not an optimisation — a sleeping can that still queried
 *    the world would be paying for a decision it already made, once per tick, forever, times
 *    every can ever thrown and never picked up.
 * 2. Grounded bodies roll: horizontal speed decays by `rollDecel·dt`, and below `restSpeed` the
 *    body stops and sleeps. Airborne bodies fall: `vy -= gravity·dt`.
 * 3. The swept loop, at most `maxSweeps` iterations, on a **remaining-time** budget. Each
 *    iteration casts the rest of the tick's motion, advances to whatever it strikes, stands off
 *    along the normal, and resolves the velocity.
 * 4. A grounded body re-probes for its support. Gone means it rolled off an edge: it goes
 *    airborne, silently. Flight is silent; the next touchdown pays for the landing.
 *
 * ## Time is what gets consumed, not distance
 *
 * The budget the loop spends is `tRemain`, and a contact costs it `hit.t / speed`. After a
 * bounce the speed changes, so the remaining *distance* is not conserved across an iteration and
 * subtracting metres would silently lengthen or shorten the tick. Remaining time is conserved by
 * construction, and it is the only thing a variable-speed sweep can budget in.
 *
 * ## Why the standoff is not optional
 *
 * See `BallisticTunables.skin`: without it every contact leaves the body sitting exactly on a
 * face, and the next cast from a point exactly on a face answers with whichever face the ray
 * leaves through first — sideways, for an oblique direction. A rolling body would spend its
 * whole life bouncing off normals that name walls it is nowhere near.
 *
 * ## `t = 0` is contact, not impact
 *
 * `raycastWorld` reports geometry it is touching, and pins that a `t = 0` answer must be
 * *separated* from rather than reflected off — reflecting there would bounce a can resting on a
 * floor back into the floor, manufacturing energy out of a query result. So the normal component
 * is clamped, the body is stood off, an inaudible `graze` is recorded for observability, and the
 * iteration is consumed without consuming any time.
 *
 * That path is also the defensive one for a body illegally spawned inside a box: the reversed
 * exit-face normal plus the clamp walk it back out over a few ticks instead of oscillating. It
 * is not free of consequence, and the consequence is worth stating: `raycastWorld` guarantees
 * `n · d < 0` for *every* answer, so a body sitting exactly on a face and moving **away** from it
 * gets a normal pointing back into the box, has its departure clamped, and is stood off a
 * millimetre inside — from where it walks itself out over the next two or three ticks. The fix
 * would be to ask a second question (is the origin strictly inside, or merely touching?) and
 * branch on the answer; the pose that needs it is one the thrower's spawn contract already
 * forbids — spawn at `min(handDist, hit.t − skin)` along the aim, never on a face — so the
 * branch would be untested machinery guarding an unreachable state, which is worse than a
 * documented recovery.
 *
 * ## Cap exhaustion drops the residual
 *
 * A tick that uses all `maxSweeps` iterations keeps its resolved position and velocity and
 * simply does not advance the rest. Losing a couple of centimetres of travel in a degenerate
 * corner is safe; ending the tick inside geometry is not. A caller that wants to watch for it has
 * one signal — a full budget of records on one body in one tick — and should treat it as
 * observability, never as a gate.
 */
export function stepBallistic(
  world: StaticWorld,
  body: BallisticBody,
  dt: number,
  contacts: BallisticContact[],
  t: BallisticTunables,
): void {
  contacts.length = 0;
  if (body.asleep) return;

  if (body.grounded) {
    // Rolling friction, and the settle that ends it. `sp === 0` takes the rest branch rather
    // than dividing by it.
    const sp = Math.hypot(body.vx, body.vz);
    const next = sp - t.rollDecel * dt;
    if (next >= t.restSpeed) {
      const keep = next / sp;
      body.vx *= keep;
      body.vz *= keep;
    } else {
      // The settle. The support is probed rather than remembered because the `rest` record has
      // to name a surface — a resting print is made of something (§3.9) — and the only answer
      // that cannot disagree with the physics is the box that is under the body right now.
      const support = raycastWorld(world, body.x, body.y, body.z, 0, -1, 0, 3 * t.skin, rayHit);
      if (support !== null) {
        body.vx = 0;
        body.vy = 0;
        body.vz = 0;
        body.asleep = true;
        record(contacts, 'rest', 0, body.x, body.y, body.z, support);
        return;
      }
      // Grounded with nothing underneath: the body rolled off an edge on the very tick it would
      // have stopped. It falls instead, and the fall is silent.
      body.grounded = false;
    }
  }
  if (!body.grounded) body.vy -= t.gravity * dt;

  let tRemain = dt;
  for (let sweep = 0; sweep < t.maxSweeps; sweep++) {
    const speed = Math.hypot(body.vx, body.vy, body.vz);
    const reach = speed * tRemain;
    // Catches a stopped body, a spent budget, and the sliver of negative `tRemain` that the
    // division below can leave behind — all three would otherwise ask `raycastWorld` for a
    // non-positive ray, and one of them would walk the body backwards.
    if (!(reach > 0)) break;

    const dx = body.vx / speed;
    const dy = body.vy / speed;
    const dz = body.vz / speed;
    const hit = raycastWorld(world, body.x, body.y, body.z, dx, dy, dz, reach, rayHit);
    if (hit === null) {
      // Nothing in the way: spend the whole remainder. Stepped by the velocity rather than by
      // `direction * reach` so free flight is exactly `p + v·dt` — the normalise-and-rescale
      // round trip is a rounding error the body has no reason to carry.
      body.x += body.vx * tRemain;
      body.y += body.vy * tRemain;
      body.z += body.vz * tRemain;
      break;
    }

    const nx = hit.nx;
    const ny = hit.ny;
    const nz = hit.nz;
    const cx = body.x + dx * hit.t;
    const cy = body.y + dy * hit.t;
    const cz = body.z + dz * hit.t;
    body.x = cx + nx * t.skin;
    body.y = cy + ny * t.skin;
    body.z = cz + nz * t.skin;
    tRemain -= hit.t / speed;

    // Negative for every answer `raycastWorld` gives — the normal always faces the ray — so the
    // approach speed below is positive, at `t = 0` as well as at a real impact.
    const vn = body.vx * nx + body.vy * ny + body.vz * nz;
    const approach = -vn;

    if (hit.t > 0 && t.restitution * approach >= t.bounceMin) {
      const rebound = t.restitution * approach;
      body.vx = (body.vx - vn * nx) * t.tangentKeep + rebound * nx;
      body.vy = (body.vy - vn * ny) * t.tangentKeep + rebound * ny;
      body.vz = (body.vz - vn * nz) * t.tangentKeep + rebound * nz;
      record(contacts, 'bounce', approach, cx, cy, cz, hit);
      continue;
    }

    // No bounce: kill the component that was driving into the surface and keep the tangent.
    body.vx -= vn * nx;
    body.vy -= vn * ny;
    body.vz -= vn * nz;

    if (hit.t <= 0) {
      // Contact, not impact — separated above, and inaudible by construction.
      record(contacts, 'graze', approach, cx, cy, cz, hit);
      continue;
    }
    if (ny > 0.5) {
      body.grounded = true;
      // Recorded **unconditionally, however soft**, and the emitter is expected to voice every
      // one of them. Measured on the prototype: with a loudness threshold on touchdowns, a hard
      // wall hit can be followed by a silent flight and a landing under the floor, leaving the
      // can 2.56 m from the last thing that painted it — a retrieval promise quietly broken. Pay
      // the quiet thud and everything after the last paint is *rolling*, which `rollDecel` bounds
      // at `v²/(2·rollDecel)`, about a metre.
      record(contacts, 'ground', approach, cx, cy, cz, hit);
      continue;
    }
    record(contacts, 'graze', approach, cx, cy, cz, hit);
  }

  if (body.grounded) {
    // Still supported? A grounded body sits `skin` above its surface, so the probe only has to
    // reach a hair further than that. A miss means the roll went over an edge.
    if (raycastWorld(world, body.x, body.y, body.z, 0, -1, 0, 3 * t.skin, rayHit) === null) {
      body.grounded = false;
    }
  }
}
