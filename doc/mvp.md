# BLIND SPOT — MVP demo scope

*v0.1, 2026-08-23. Companion to `doc/vision.md`. The vision defines the game; this defines the
smallest thing we build next and the questions it must answer. Written after a full teardown of
[`sxuff/afterimage`](https://github.com/sxuff/afterimage).*

---

## Part 1 — What AFTERIMAGE actually does

Worth knowing precisely, because roughly half of it is a solved problem we should copy and the
other half is exactly where our game diverges.

### 1.1 The perception pipeline

Nothing is screen-space, nothing is instant, and the renderer never draws surfaces — only points.

1. **The world is pre-sampled into points, once.** `world/levelData.js` is 1100 lines of authored
   *brushes* (box / cyl / pipe / arch / statue / grate / stair / ring), each with a material class.
   `world/builder.js` turns that one list into three parallel realities: an invisible **occluder
   mesh**, a set of **OBB colliders** + broadphase grid, and **millions of surface point samples**.
   Points are never created at runtime — they exist from load, they are just *invisible*.
2. **A pulse captures occlusion at fire time.** `ScanSystem.fire()` renders a **distance cubemap**
   (R16F, 768 or 1024 px, back faces) of the whole occluder scene *from the emitter*. Moving bodies
   are injected as box proxies for that one capture, so the creature genuinely shadows the wall
   behind it. This is the trick that makes occlusion cheap and exact: one cubemap render per ping,
   then every point can test itself against it for free.
3. **The wave travels.** Wide pulse: 76° cone, 62 m, 46 m/s. Narrow: 9.5° cone, 175 m, 74 m/s.
   Max 4 concurrent pulses (one cubemap slot each).
4. **A GPU pass advances every point each frame.** `PointCloud.step()` runs a fragment shader over
   a point-state texture (`RGBA32F`: hitTime, intensity, distance, flags — ping-ponged). Per point
   it tests *only the thin shell the wave crossed since the last frame*, then rejects: outside the
   cone, facing away from the emitter (`dot(n, -rd) < 0.06`), beyond the cubemap depth, or lost to a
   distance/grazing-angle **return probability**. Survivors write their hit time.
5. **The point shader draws from that state.** Colour = material hot→cool ramp, a white flash at the
   instant of return, drift to violet with age, and a per-point stochastic dropout so the cloud
   **dissolves grain by grain** instead of dimming. Splat size grows as `1/d^0.8` — deliberately
   *not* physically correct, because a fixed world-spacing cloud reads as separated specks up close
   and as solid texture far away, which is the inverse of how a scanner feels.
6. **`NearCloud` is a scrolling clipmap** (5×5 columns of 5.4 m, one storey tall). The static cloud
   holds the *memory* of the whole facility at ~25 cm spacing; the clipmap re-samples whatever
   column you walk into at ~6 cm. Columns keep their texture rows, so scan state you already earned
   inside the window survives; only ground you were never near loses detail.
7. **`EchoCloud` handles things that move.** Creature returns are written on the **CPU**, at the
   world position the body occupied *at the instant the wave touched it*, and then left there.
   The creature walks away; the afterimage stays. That gap is the entire game.

### 1.2 Memory model

`uLife = 34 s`. Everything fades. There is no permanent skeleton — the map is a decaying
after-image of your own pulses, and the pressure to re-ping is the horror engine.

### 1.3 The creature

`Creature.js` is a 20-capsule posed body (pose = 18 named parameters, blended with a ~0.4 s time
constant), never rendered, only ever sampled by a passing wave. Behaviour: `dormant → hunting →
stalking → charging → retreating → kill`, A* over an authored nav graph (`Nav.js`). Two mechanics
worth stealing outright:

- **Every scan hands it your position.** It paths to the *scan origin*, not to you.
- **Repeat-scanning from the same spot compounds aggression** (~1.25× speed per repeat within 3 m /
  25 s, capped 3×). The counterplay to information cost is *movement*, which is exactly our fantasy.

### 1.4 Audio

`AudioEngine.js` is 1550 lines of **100% procedural WebAudio — zero sample files**. One convolver
with a generated cavern IR, `dry`/`verb`/`lfe` buses, HRTF panners, hard voice cap. Returns are
audibilised as a **click stream** whose density is driven by `ScanSystem.estimateReturnRate()`, with
far returns delayed by round-trip time. Footsteps are three synthesised bands (body 200 Hz, grit
3.5 kHz, scuff sweep) — this is the "muffled distant footsteps" you flagged as the strongest thing
in the build, and it is ~40 lines of code, not an asset pipeline.

### 1.5 What this means for us

| Copy | Diverge |
|---|---|
| Points pre-sampled from authored brushes; GPU point-state texture; ping-pong compute pass | **Scans are not the only paint source.** Ours must paint from *every* sound event |
| Per-pulse distance cubemap for exact, cheap occlusion | 4 cubemap slots is fine for pings, impossible for footsteps at 4/s (see §4.1) |
| NearCloud clipmap for near-field fidelity | Their memory is 34 s and total. Ours is an open decision (§3) |
| CPU-written EchoCloud for moving bodies = ghosts | Their creature is a horror set-piece; ours is a readable routing threat |
| Procedural WebAudio, click-density return stream, footstep synth | Their audio is atmosphere; ours is the primary *information* channel |
| Brushes-as-code + a headless validator (`tools/validate-level.mjs`) | Their level is one bespoke 1100-line dungeon; ours needs a reusable room library |
| Splat sizing, stochastic dissolve, material colour ramp | Their palette codes *material*; ours codes *age* (matter) and *source* (events) — §3.2 of the vision |

One structural warning: AFTERIMAGE is fundamentally *click → look at the returned photo*. Movement
is slow (3.05 / 5.35 m/s, no vault, no slide, no verticality beyond stairs) because the whole design
assumes you stop to think. Our core fantasy is the opposite. **If we inherit their code we must not
inherit their tempo.**

---

## Part 2 — The one thing the demo exists to prove

> After a ping, the player sees **several distinct route options within 1–2 seconds**, picks one,
> and keeps moving.

Everything below is subordinate to that. If a ping only tells you where the walls are, the loop is
dead and no amount of content saves it.

Three falsifiable tests, in priority order. All three run in the *same* single-room demo.

### T1 — The Snapshot Test (the make-or-break)
Tester pings in an unfamiliar room. Measure **time from ping to committed movement** and **how many
distinct routes they can name afterwards**.
- Pass: ≤2 s to commit, ≥2 routes named, and their choice changes when we move the dog.
- Fail: they ping again before moving, or they name one route ("the corridor").
- Instrumented automatically: `t(ping) → t(first sustained input in a new heading)`.

### T2 — The Blindfold Gauntlet (movement readability)
Vision §15. Tester sprints an unfamiliar route lit only by **their own footfall paint** plus
whatever memory the current decay model leaves. ≤1 fall/wall-slam across 3 runs, and they can
sketch the route afterwards.
- This is the test that decides whether passive sound-painting is real. It is also the answer to
  *"надо что-то делать, чтобы не кликать постоянно"*: **footsteps carry navigation, pings carry
  tactics.** If T2 passes, the player never has to spam ping to walk.

### T3 — The Lantern Test (enemy readability)
Tester tracks one patrolling dog **through a wall**, by its own gait paint and audio, for 20 s, and
calls its exit point correctly.
- This is what makes dogs a *routing* threat instead of a jump-scare. It is also the second reason
  to ping in known space (vision: "in a known room, dynamic info about dogs becomes the reason to
  ping").

**Kill signal:** if T1 fails after two perception redesigns, the ping is not a tactical instrument
and we re-scope before building floors, cells, Heat, or co-op.

---

## Part 3 — The one design decision the demo must settle: memory

This is currently a contradiction in our own docs and it should be **a runtime slider, not a
document argument**:

- `vision.md §3.6`: scans are permanent; detail decays to a dim skeleton (alpha floor ~0.22) that
  you never lose.
- Your reaction to AFTERIMAGE: non-persistent feels good, more horror — but forces constant clicking.

Ship all three in the demo behind `F1/F2/F3` and let T1/T2 decide:

| Preset | Behaviour | Predicted failure |
|---|---|---|
| **A — Permanent** (vision) | detail decays ~30 s → permanent dim skeleton | room becomes solved; ping loses purpose; visual porridge at range |
| **B — Total decay** (afterimage) | everything gone at ~35 s | ping spam; movement becomes stop-start; kills our tempo |
| **C — Hybrid** (recommended default) | detail decays fast (~12 s); a **sparse** skeleton persists — hard density cap, edge-biased retention, ~15 % of points survive, alpha floor low | tuning-heavy; needs the density cap to be real, not cosmetic |

C is the honest reading of both positions: you keep the *shape* of what you learned (so you can
sprint home through it — the payoff the whole loop exists for) but not the *read* (so pinging still
buys something). Note that C makes passive footstep-paint the thing that refreshes local detail,
which is exactly the behaviour we want to reward.

**Second-order decision, same slider:** does *sound-painted* geometry persist like *ping-painted*
geometry, or does only the ping write to long-term memory? Cheap to try both; a real difference in
how much the player pings.

---

## Part 4 — Demo scope

### 4.1 Systems (build in this order)

1. **Renderer core.** Brushes → occluders + colliders + points; GPU point-state pass; splat shader
   with our two-layer palette (matter = cyan/age, events = source colour). Straight port of the
   AFTERIMAGE architecture, our colour rules.
2. **Movement.** The Finals-register first-person controller: walk 3.5 / sprint 6.0 / crouch 1.7,
   jump, mantle ≤2.2 m, vault, slide, ledge-grab, ladder. No fall damage. This is a *first-class*
   milestone, not a stub — half our tests are about tempo.
3. **The sound-event bus.** *The core architectural difference from AFTERIMAGE and the thing that
   must be right from day one.* Everything emits `{origin, intensity, class, t}` and **paint is
   derived from events**, never authored directly. Solo-only demo, but the bus is what makes co-op a
   transport problem instead of a rewrite (vision §16).
   - **Two paint tiers**, because a cubemap per event is impossible at 4 footsteps/s:
     - **Tier 1 — pings** (rare, directed, long): full AFTERIMAGE treatment — distance cubemap,
       finite wave speed, cone mask.
     - **Tier 2 — ambient events** (footsteps, dog gait, prop knocks; radius 1.5–8 m): *no* per-event
       cubemap. Instant (a 4 m radius at 340 m/s is 12 ms — finite speed is invisible and not worth
       a slot). Occlusion from a **room/portal graph** (§4.3) + the existing normal-facing test:
       an event paints points in its own room, and through a portal at −60 % radius. This is
       cheaper than a cubemap, matches vision §3.4's wall rule exactly, and it is the same graph
       the dogs listen through.
4. **One dog.** Patrol → investigate → attack → kamikaze lunge, with the two AFTERIMAGE mechanics:
   pathing to the **acoustic origin** (specifically: to the *portal the sound arrived through*, not
   to your true position) and compounding aggression on repeat pings from one spot. A* over an
   authored nav graph. No pack behaviour, no dispatch, no Heat.
5. **Audio.** Port the procedural approach wholesale. Footsteps, dog gait, ping chirp, return-click
   density, detonation, and the Halo hum (vision §3.8). **Budget real time here** — your own read
   was that sound design is 10× the weight, and this demo's tests are all audio-first.

### 4.2 Explicitly out of scope

Five floors · cells · Heat · chips/upgrades · co-op · voice · extraction · meta · procedural room
assembly · props beyond 2–3 trap types · more than one dog type · any UI beyond the Halo and a
1 px reticle.

### 4.3 The map: one graybox, authored as code

Build **exactly one space** — the automated cargo/sorting bay from your round-2 notes. It is chosen
because it can host all three tests at once.

Target metrics (dark space reads ~35 % bigger than paper — vision §11):

- **Footprint** ~40×28 m, ~9 m to the ceiling. One readable volume, not a labyrinth.
- **3–4 machine/conveyor islands** — massive silhouettes, 4–6 m tall, that block sight and sound and
  create the braid. These are what make a ping return *several* answers instead of one.
- **Three route classes across the bay**, differing in *properties*, not in danger:
  1. **Bay floor** — fastest, widest, loudest, patrolled, worst acoustic isolation.
  2. **Service passage / trench** — slow, quiet, excellent isolation, narrow escape, blind.
  3. **Catwalk / mezzanine at ~5 m** — best scan position (less occlusion, sees the most routes),
     slow to reach, and a ping from up there is heard by *more* of the room. This is our answer to
     "3D for sensor positioning": **height buys information and costs exposure.**
- **2–4 exits** into notional neighbouring zones (dead-ended in the demo; they exist so routes
  converge and diverge).
- **2 authored sound-traps** at chokepoints (chain curtain, glass field) — vision §8.
- **One large-silhouette landmark** for orientation.

Authoring method, copied from AFTERIMAGE and worth copying:

- **The level is a `.js` data module of brushes**, written with local helper factories
  (`box()`, `pipe()`, `stair()`, …), with the layout documented in a header comment as literal
  coordinate ranges. Text-diffable, agent-editable, no editor to build, no binary assets.
- **Alongside the brushes, author two graphs by hand:**
  - the **nav graph** (dog pathing), and
  - the **room/portal graph** (acoustics + tier-2 occlusion): convex-ish volumes and the openings
    between them, each portal with an attenuation. This is a dozen entries for this bay, and it is
    what makes "dogs go to the doorway the sound came through" a five-line rule instead of an
    acoustic simulation.
- **Write the headless validator on day one** (`tools/validate-level.mjs` is the model): it re-implements
  the collision queries with plain arrays and asserts every nav link is actually walkable, every
  region reachable, no ceiling under 1.05 m on a route. Catching a broken graybox in `node` instead
  of by walking it in the dark is worth an order of magnitude of iteration time.
- When it comes time to procedurally arrange authored rooms (vision §11), the portal graph is
  already the connection contract. Nothing to redesign.

### 4.4 Instrumentation (build it with the demo, not after)

The tests above are only real if the demo measures them:

- ping timestamps, positions, mode; **ping→movement latency**; ping interval histogram
- full position trace per run + a top-down replay renderer (this is also the sketch-comparison tool
  for T2)
- collisions with walls per 100 m sprinted; falls; deaths; dog state timeline
- one hotkey to dump the run as JSON

---

## Part 5 — Decisions that stay open until the demo answers them

1. **Memory model** — A / B / C (§3). Decided by T1+T2, not by argument.
2. **Do ambient sound events write to long-term memory, or only pings?** (§3)
3. **Does the sprint energy drain earn its place**, or is noise the only price? (vision §17.1)
   The demo can answer this cheaply: run it both ways for one session.
4. **Ping cost/recharge tuning** — the target is "ping when the situation changed", never "ping on a
   metronome". Watch the interval histogram: a flat distribution is health, a spike at the cooldown
   is failure.
5. **Combat** — stays a non-goal. Revisit only on the vision's own kill-signal (testers cornered
   without counterplay ≥1×/run → add the loud Shove).
6. **Roguelite-ness** — unanswerable at this scale and deliberately untouched. It is a question
   about session-to-session retention; this demo is about second-to-second legibility. Do not let it
   influence the demo's design.
7. **Ghost fidelity for dogs** — how much of the dog's silhouette a passive gait event should paint
   vs. a direct ping. Directly determines whether T3 is possible.
