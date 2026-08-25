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

### `slideXZ` depenetrates instead of sweeping — fast movers tunnel

`src/core/collision.ts` (~line 232). The horizontal pass advances the body the full tick
(`s.x += dx`), then pushes it back out of anything it now overlaps, up to four iterations.
Nothing looks at the *path* between where the body was and where it landed. A body that
crosses a thin obstacle entirely within one tick overlaps nothing at the end of the tick, so
there is nothing to push out of, and it passes through.

At 120 Hz a sprinting player covers 0.05 m per tick, which is thinner than any wall in the
room, so this has never bitten. A thrown can at 15 m/s covers 0.125 m per tick, which is
thicker than a chain curtain, a railing or a pane of glass — exactly the props §8 of the
vision calls "authored sound-traps". A trap you can throw straight through is not a trap.

**Owner: M2, and it blocks M2** — throwables cannot land on top of this. The fix is a swept
test, which is also what `raycastWorld` is being built to serve.

---

## Live bugs

### `SoundBus.landingRadius(NaN)` returns NaN

`src/paint/soundEvents.ts` (~line 264). The clamp is `t < 0 ? 0 : t > 1 ? 1 : t`, and NaN
fails both comparisons, so it falls through as NaN and poisons the radius. Every other
degenerate input is handled. Low severity — no caller can currently produce a NaN impact
speed — but it is one arithmetic slip upstream away from painting a NaN-radius event, and a
NaN radius will not throw, it will just silently paint nothing.

**Owner: M1**, with the landing-edge fix, since they touch the same path.

### `aabbFromFootprint` leaves `mat` and `shell` undefined

`src/core/collision.ts` (~line 79). Its sibling `aabbFromBounds` defaults them to `0` and
`false`; the footprint variant omits them entirely. Both readings are *correct* per the `Aabb`
doc comment ("absent means concrete"), so nothing is broken today.

It is recorded because it is a trap with a fuse. Half the world's boxes have `mat === 0` and
half have `mat === undefined`, so `b.mat === 0` is a test that silently answers "no" for half
the level. M2 gives materials their first real consumer — a can off metal and a can off
concrete are different sounds — and that is exactly the shape of code someone will write.

**Owner: M2.** Either default them in the factory or make `mat` non-optional and force every
construction site to say what it is made of. The second is better.

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

### The browser screenshot suite is not reproducible against itself

`tools/shoot.mjs` drives the game for **wall-clock** durations, while `src/core/loop.ts`
(line 64) *discards* any frame longer than `maxFrameSeconds` (0.25 s) rather than simulating
it in bulk. Under a software GL renderer, frames routinely exceed that. So the amount of
simulated time behind a given `await wait(800)` depends on how busy the machine was.

Measured: two consecutive `npm run shoot` runs of byte-identical code drifted on **39 of 56
assertions**, and **14 of 14 screenshots differed byte-for-byte** — including the frame that
is entirely black.

This is why the Node characterization tests exist and why they, not the screenshots, are the
bit-identity oracle. `shoot.mjs` remains valuable — it is the only thing that exercises the
real renderer, the real GPU path and the real event loop — but it is a **threshold** test,
and it must be read as pass/fail with margin, never as a set of numbers to diff.

Do not "fix" this by widening thresholds until two runs agree. The honest fix is to drive the
simulation by tick count rather than by wall clock, which is now possible: `GameSim` runs
headless and `ScriptedInput` plays a deterministic timeline.

**Owner: unscheduled.** Worth doing before the suite grows much larger.

### `dotGeometry.setDrawRange(0, dots)` with `frustumCulled = false`

The whole lattice buffer is submitted every frame with culling switched off. At one room and
~95k dots this is fine. At five floors it is the first thing that will fall over, and it will
fall over as a frame-rate cliff rather than as an error.

**Owner: M3/M5**, flagged now because the fix (per-floor draw ranges) is much cheaper to
design in than to retrofit.
