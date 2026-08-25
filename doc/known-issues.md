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

The assertion currently closest to the edge is **`a settled drawing is cyan-family (§3.2)`**
(`tools/shoot.mjs`, ~line 628), which needs `coolFraction > 0.8`. Measured across six runs of
two byte-identical builds it reads 79.81 / 88.07 / 98.03 and 97.43 / 86.66 / 88.82 — an ~18
point swing against 7 points of margin, and it has already failed once at 79.81 on code that was
otherwise 62/62. The mechanism is the same one: the amount of simulated time behind the
screenshot decides how much of the warm event layer has faded and how many contours are still
flashing, so an unlucky frame is caught mid-flash and reads warm.

Recorded by name so the next person to see it fail checks this entry before bisecting. It is
also the reason not to reach for the easy fix — lowering the threshold to 0.75 buys one more
point of luck and hides the next regression. The frame genuinely is cyan-family; the test just
cannot say *when* it is looking.

**Owner: unscheduled.** Worth doing before the suite grows much larger — and this assertion is
the clock on it.

### `dotGeometry.setDrawRange(0, dots)` with `frustumCulled = false`

The whole lattice buffer is submitted every frame with culling switched off. At one room and
~95k dots this is fine. At five floors it is the first thing that will fall over, and it will
fall over as a frame-rate cliff rather than as an error.

**Owner: M3/M5**, flagged now because the fix (per-floor draw ranges) is much cheaper to
design in than to retrofit.
