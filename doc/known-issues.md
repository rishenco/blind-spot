# Known issues

Things that are wrong, or missing, and are *deliberately still wrong*. M0 was a
behaviour-neutral milestone — its whole point was to build a net that catches changes, so
nothing here was fixed during it. Fixing a bug and building the thing that would have caught
the fix are two jobs, and doing them in one commit means neither is verified.

Each entry says where it lives, what it costs, and which milestone owns it. An entry leaves
this file when the fix lands *with a test that fails without it* — not when someone believes
it is fixed.

---

## Blocking

None. The `slideXZ` tunneling entry lived here until M2 measured it and found that M2 routes
around it rather than being stopped by it — it now sits below, with a corrected failure law
and a new owner.

---

## Real, and deferred on purpose

Wrong, not blocking anything, and cheaper to fix when the thing that makes them matter exists.

### `slideXZ` depenetrates instead of sweeping, and the threshold is half what this file claimed

`src/core/collision.ts` (~line 232). The horizontal pass advances the body the full tick
(`s.x += dx`), then pushes it back out of anything it now overlaps, up to four iterations.
Nothing looks at the *path* between where the body was and where it landed.

**The failure law recorded here until M2 was wrong, and wrong in the dangerous direction.**
This entry used to say a body tunnels when it crosses a thin obstacle *entirely* within one
tick — i.e. when `speed * dt > thickness + 2r`. Measured, the real threshold is:

```
speed * dt  >  thickness / 2 + radius
```

Half of what was claimed. The reason is `circlePush`: its centre-inside branch ejects the body
through the face it is *nearest to*, so a step that lands past a box's midplane is pushed out
the **far** side and arrives on the other side of the wall having never been outside it. The
body does not need to clear the box. It only needs to overshoot the middle of it. A 0.06 m body
at 24 m/s passes a 0.1 m wall; a 0.3 m wall held 0 phases out of 40 only because the
approach-tick graze zeroes the velocity before the overshoot tick can happen, which is luck
about tick phase rather than a margin.

**There is a second defect underneath the first, and it has no threshold at all.** `slideXZ`
implements *slide* semantics: a contact kills the normal component of velocity. A body moved
through `moveBody` therefore cannot bounce, at any speed, on any wall — it can only stop and
slide. For the player that is the correct feel and the whole point. For anything thrown it is
wrong everywhere, not just where it tunnels, and no amount of sweeping fixes it.

**Owner: M4, and it no longer blocks M2.** M2 does not fix this and does not need it fixed:
thrown bodies never enter `moveBody`. They run on their own swept integrator — landing during
M2 as `src/core/ballistics.ts` — built on `raycastWorld`, whose contract was authored for exactly
this — inclusive `maxDist` "for a thrown object stepped by `speed * dt`", the `t = 0`
separate-don't-reflect rule, and a reflectable normal from inside a box. A can needs none of
`moveBody`'s stance machinery (step-up, mantle slack, ground snap, coyote edges) and gets
bounce for free by not asking for slide.

What still owns the bug is the next fast mover that genuinely *is* a `moveBody` body: M4's
spider, which pounces. The M4 fix is a swept horizontal pass, and it should land with a test
built from the corrected law above rather than the old one — a suite written against
`thickness + 2r` passes on a body that is already tunnelling.

**Do not let the old number survive as a safety argument.** Any claim of the form "X m/s is
safe because the thinnest collider is Y m thick" must be recomputed against `Y/2 + r`, and any
such claim about *unswept* motion is a smell in the first place.

### The ears do not crouch, and the beam leaves from above a crouched head

`src/game/sim.ts`. `E_PING_HEIGHT` is 1.5 m and does two jobs: `syncListener` puts the paint
listener there, and the E-ping radiates from there. Neither follows the stance. The *camera* does
— `eyeStand` 1.62 drops to `eyeCrouch` 1.12 — so a crouched rig looks out at 1.12 m, listens at
1.5 m, and fires its beam from 1.5 m through a collider whose top is `crouchHeight`, 1.2 m.

Two separate costs. The listener sitting 38 cm above the eye is an inconsistency and nothing more:
a listener is not an emitter, it paints nothing and emits nothing, and 38 cm is far inside every
tolerance in §3.3's table. The *emitter* is the law-2 problem — "every blip and sound has a real
physical source" — because a crouched rig's beam, and the paint it hands back, originate from 30 cm
of empty air above its own head. §3.5 calls Q the panic button pressed from behind cover; E is the
one you would use from behind the same cover to look down a corridor without standing up.

Not fixed here because the blast radius is out of proportion to the miss. `NEAR_FIELD_M` in
`audio/director.ts` is this same height read as a distance — ear to sole, the thing that makes your
own footfall the reference level of the whole mix — so making the height track the stance re-bases
the level law, every pinned figure in `tests/audio/`, and the whole-room raycast golden, in exchange
for 30 cm in a room where nothing yet rewards crouching. `Q_PING_HEIGHT` is bounded onto the body in
both stances (`tests/headless.test.ts`), so the pulse is already honest; it is the beam that is not.

**Owner: M3.** The gym is the first level that makes crouching a route rather than a stance, and
the fix should land with it — as a stance-tracking ear, with the mix's reference level re-derived
deliberately rather than inherited.

---

## Not bugs — checked and cleared

Recorded so the next person does not spend the afternoon I spent.

- **`hitWall` was suspected of being an edge rather than a state.** It is a state.
  `plain.hitWall` is reset at the top of every `moveBody` call and set by any push during that
  tick, and a body held against a wall re-overlaps it every tick, so it reports `true`
  continuously. No fix needed.
- **`canOccupyWorld` and `canOccupy` were suspected of disagreeing at the `EPS` boundary.**
  They agree. `StaticWorld.query` uses non-`EPS` bounds and a square footprint, both of which
  make it a strict superset of what `canOccupy` treats as blocking; `canOccupy` then filters
  with the tighter `EPS` and circle tests. Superset-then-filter is the correct arrangement.
- **Screenshot numbers that still differ between runs are the host, not the game.** The suite
  used to drift against itself badly: two runs of byte-identical code disagreed on 39 of 56
  assertions, all 14 screenshots differed byte for byte, and `a settled drawing is cyan-family
  (§3.2)` swung between 74 % and 98 % against an 80 % bar — failing on luck twice in one day and
  costing two sessions to rule out as a real regression. The cause was pacing: `tools/shoot.mjs`
  drove the game for wall-clock durations while `core/loop.ts` *drops* any frame longer than
  `maxFrameSeconds` rather than banking it, so under software GL the simulated time behind
  `await wait(800)` was a measurement of how busy the machine was. The driver is on the tick
  clock now — `Loop.suspend`/`Loop.step` hold the display clock still and advance the fixed
  timestep an exact number of ticks, `main.ts` exposes that as `window.__blindspot.stepTicks(n)`
  (inert unless a test calls it), and the run steps up to a fixed origin tick before its first
  assertion, so the paint clock behind every screenshot is the same number every time. Everything
  else is deliberately unchanged: the real single-file build, the real WebGL renderer, real key
  and mouse events, real frames drawn throughout. Only the pacing is the driver's.
  What that bought, measured over five runs of the same build: **thirteen of the fourteen
  screenshots are identical pixel for pixel between runs** across the measurement window, and
  **59 of 65 assertions read the same numbers to the digit**. Every one of the six that move is
  the host being measured on purpose — three are costs in milliseconds (the boot frame rate, the
  lattice build, the Q-ping's ray time, whose dot and segment counts beside it are identical),
  one is the boot tick count the handshake reports absorbing, and two are §07, which keeps the
  wall clock deliberately because `six beams back to back keep the frame rate up` is a statement
  about this host's frame rate and amortised chunk cost. That section's screenshot is the
  fourteenth, and inherits its clock, which is why its assertion is the one property that does
  not care: nothing clips.
  Two assertions hold it there, and both fail if the pacing is put back — measured, by re-pacing
  a copy of the driver onto the wall clock. `the same script twice paints the same instant` runs
  the Q-ping sequence twice in one session and requires the two frames to be pixel-identical
  (0 of 252,000 px differ on the tick clock; 13,416 differ on the wall clock, and mean luminance
  moves 0.0467 against a 0.005 bar). `the driver and the loop agree on what a tick is` catches
  the tick rate — or the tick the run starts from — drifting from the loop's, and reads
  `stepping=false` outright if the driver stops driving. So do not "fix" a flake here by widening
  a threshold: check first whether the stretch that produced it is still on the tick clock.

---

## Not built yet

Not bugs — gaps between the vision doc and the code, listed so they are not mistaken for
finished work.

- **The 2 m contact shell** (vision §3.1: "without sound you perceive only contact geometry —
  a faint shell within 2 m of your body, plus surfaces you touch") does not exist. Nothing in
  `src/paint/` paints from the body. Every use of the word "shell" in the paint code means the
  *room* shell or the dust wave's thickness — different concepts. Until this lands, a
  perfectly silent player is perfectly blind, which is not what §3.1 promises.
- **Bodies do not collide with each other.** `moveBody` takes a `StaticWorld` and nothing
  else. Two players, or a spider and a player, pass through one another. M4 needs a mechanism
  that does not exist yet; this is not a tuning change.
- **`BodyShape` is mutated in place** rather than replaced, so a body's shape object must not
  be shared between bodies. Currently there is one body, so it cannot bite. Stating the rule
  here because the crash it produces later would be very hard to read backwards.

---

## Infrastructure

### `dotGeometry.setDrawRange(0, dots)` with `frustumCulled = false`

The whole lattice buffer is submitted every frame with culling switched off. At one room and
~95k dots this is fine. At five floors it is the first thing that will fall over, and it will
fall over as a frame-rate cliff rather than as an error.

**Owner: M3/M5**, flagged now because the fix (per-floor draw ranges) is much cheaper to
design in than to retrofit.
