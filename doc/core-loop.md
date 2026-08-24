# BLIND SPOT — Core Loop v0.4

*Draft for playtest, 2026-08-24. Laws are fixed; numbers are first-pass tuning values. This doc
extends doc/vision.md — perception and movement stay there; the mode, the enemy, and the map are
defined here. Overrides of vision.md are listed in §9.*

## 0. The loop and the Razor

**The loop:** spend noise to buy the map on the way down; spend the map to outrun your noise on
the way home.

**The Razor.** Every rule must be expressible in the currency **sound → knowledge → risk**. If a
mechanic cannot be restated that way, it does not ship. Corollary: express a need in this
currency before importing a foreign one — no timers, no stamina, no encumbrance.

## 1. Setting — the Unfinished Tower

A dead high-rise, abandoned mid-construction. The ship docks at the tower crane on top: base
camp and artifact bank.

- **Completion gradient = occlusion gradient.** Top floors are bare frame — columns, beams, no
  walls: sound carries far, parkour is dense, wind sings. Lower floors are progressively
  finished: partial walls → corridors → sealed rooms. Deeper is quieter, blinder, richer.
- **No façade; the edge always howls.** The perimeter is open void: falling off the building is
  death. Wind at open edges is a permanent real sound source — it faintly self-paints the rim,
  is audible always, and masks footsteps near the edge. Perimeter routes are fast, quiet,
  lethal: a priced trade. Interior falls stay soft-fail per vision §5 — land one floor down,
  loud paint flash + 0.3 s stagger, no damage. Authored construction nets catch falls in
  designated bays (loud bounce).
- **Props.** Construction clutter is the authored sound-trap set — pipe stacks, sheet metal,
  chain curtains, glass panes — at chokepoints. Readable via the 2 m contact shell before they
  trigger at walk speed.
- **Freight hoist.** Unlockable in-run shortcut: 20–30 s loud activation, persists for the run.
- **Crane-cable gondolas.** Hanging platforms reachable only by jump or throw. Spiders cannot
  traverse cables (§3). Caching artifacts there is legal, but a parked hum accrues besiegers
  below and around it — playtest watch item.

## 2. Mode — The Retrieval

One session = one map, 15–25 min. Solo-first; co-op 1–4 later under the same rules (voice is
diegetic per vision §10).

- **Objective.** 4 humming artifacts (power cells) sit in finished-room pockets at increasing
  depth. Free order. Carry each to the crane base; a banked artifact is locked forever — the
  run ratchet. Win = all 4 banked. Solo death = run over.
- **The artifact, not the player, is the sound source.** It hums every 2 s, audible 12 m. It is
  throwable: landing = a loud clang that paints. A parked or thrown artifact accrues spiders
  around it. Throwing down through gaps is legal — gravity is a currency: passing down is
  free-but-loud; up must be carried. Co-op: throw/catch = handoff; a caught hum switches
  pursuit mid-air.
- **Undocking is the act boundary.** Freeing a cell from its alarmed cradle is very loud —
  heard across the floor. Per-trip arc: quiet outbound (buy the map) → undock (the hum starts;
  silence is now impossible) → return ascent (cash the map at speed while spiders converge on
  the hum).
- **Heat ratchet (per zone, 0–3).** Loud events raise it; it decays only down to
  (max reached − 1); dispatched spiders never despawn. Dispatch arrives via audible hatches
  (8 s telegraph) authored at architectural bottlenecks. There is no run timer and never will
  be: the ratchet is the clock.

## 3. The Spider

The only enemy. Replaces the robo-dog of vision §6.

- **Senses.** Hearing only, plus its own tap-sonar: it taps a leg to ping, gaining knowledge
  and revealing itself in the same act — its taps paint around it. The enemy pays for
  questions too. It never pathfinds to the player's true position — only to sound origins.
  Every death must trace to a sound the player made.
- **Modes and speeds:** patrol 2.5 / investigate 4.0 / attack 5.5 m/s — always slower than
  player sprint (6.0). It wins by geometry, not speed.

### 3.1 The Four Teeth

1. **Continuity vs gaps.** It moves only on connected surfaces — floors, walls, ceilings. It
   cannot jump (the pounce is its only flight) and cannot traverse cables or nets. The
   player's graph is gaps and wires; its graph is continuity. A 2 m gap is your step and its
   detour.
2. **Motion always sounds.** Every step is an audible footfall rendered as a light pulse at
   the contact point — 8 legs, a scuttling constellation; the chain gives direction. Only a
   stationary, silent spider is invisible.
3. **The pounce is ballistic.** Rising chitter wind-up 0.7 s, unmaskable by ambient noise. In
   flight it cannot steer — jukeable. A miss lands hard: loud, ~2 s recovery.
4. **Webs are territory made readable.** It strings snare-lines in its zone; crossing one
   rings and summons investigation. Snares read by paint or by contact shell at crouch speed.
   Learn the web = read the patrol.

### 3.2 Rendering

Delta over vision §3.2 and §3.7, which otherwise stand.

- **Passive:** footfall pulses only. Tempo + hue = state — patrol: dim amber, slow ripple;
  investigate: stop-start taps; chase: fast saturated red. Never hue alone: tempo and a
  transition sting always accompany color.
- **Active:** your ping returns a full pose snapshot — a ghost photograph.
- **Staleness:** pulses cool with age; positional uncertainty visibly grows.
- **Belief pin:** when you hear its sting, a marker shows where *it* last heard *you*.

### 3.3 Kamikaze and siege

- **Detonation on contact:** 100 dmg ≤2 m / 45 at 4 m / 12 at 6 m, plus knockback. The blast
  paints 22 m through floors. Spending a spider — baiting its pounce or detonation where you
  want light or need it gone — is a first-class play. Blast-jumps are legal emergent tech,
  not a built system.
- **Siege.** Spiders besiege the hum anchor (ceiling positions included), never the player as
  such. Native counters: throw the artifact (displace the anchor), E-ping lure, gondola
  cache, crouch-out without cargo (≤2 m audibility).
- **Counts:** ~2–3 at run start; the ratchet adds; cap ~6 per zone.

## 4. The Duel

Four beats. Matador, not soldier.

| Beat | Its tell | Your counter |
|---|---|---|
| Lock | Hunting sting — loud, recruits nearby spiders | Break line-of-hearing before the sting ends |
| Run-down | Cuts through wall/ceiling continuity; chase gait = red drumroll | Win on straights and gaps |
| Wind-up + pounce | Rising chitter, unmaskable; flight is ballistic | The juke: hard lateral or vertical cut |
| Overshoot | Loud landing, ~2 s recovery whine | Spend it (bait the next pounce where the blast serves) or shed it (break the sound chain; its belief pin searches the wrong room) |

**State law:** position may be hidden; state may never be. Stalked in silence — never killed
in silence.

## 5. Map doctrine — the Tower in rules

- **Two graphs by construction.** The spider graph is surface continuity; the player graph is
  gaps, cables, nets, drops. Every artifact room and every hatch is spider-reachable.
- **Sound topology quota:** ~25 % open frame (transparent — sound carries) · ~25 % porch (one
  wall: fuzzed leakage — the decision space) · ~50 % sealed rooms (pure black outside your
  own noise; enter and ask). Never two sealed spaces adjacent; each pocket has exactly one
  sound-well to the open frame — a two-way listening keyhole.
- **Lighthouses.** Looping machinery, unique rhythm + timbre, self-painting every ~5 s, at
  junctions, chained ≤25 m along main routes — diegetic signage.
- **Quantized affordances.** One jump-gap width (2 m); two mantle tiers (1.1 / 2.2 m); "dots
  are matter, lines are holds" everywhere.
- **Entry is the spine.** The outbound entry hall of every pocket is its return spine: the
  outbound pass necessarily paints the return sprint's geometry. The return runs on memory
  skeleton.
- **Proc-gen contract.** Authored segments ship both graphs plus metadata: occlusion class;
  lighthouse, hatch, and gondola slots; route price tier. Assembly validates: spider graph
  spans all artifacts and hatches; ≥2 links per zone + 1 unlockable shortcut; three
  price-tier routes (loud-fast / mid / silent-slow) to every artifact; no sealed–sealed
  adjacency.

## 6. Player economy

Unchanged from vision §4–5: movement verbs and speeds stand; ladders are silent at 2.5 m/s.
The Halo shows net self-loudness, masking wind included. A rim-glow directional hearing cue is
accessibility-tier (no-headphones play), kept minimal. Chips (vision §9) are post-first-playable.

| Stat | Value |
|---|---|
| Energy / regen | 100 / 6 per s |
| E-ping (cone; wakes what it sees) | 18 |
| Q-ping (360°, 12 m — the ceiling check) | 10 |
| Sprint drain | 1 /s |

## 7. Debrief — mastery made measurable

- Per-trip return splits vs personal best.
- Noise ledger: every sound spent, where, and what it cost.
- On death: a 2 s replay naming the betraying sound.
- One "a faster line existed here" reveal per run.

## 8. First playable — "The Span"

Crane base + one open-frame span + one finished-room pocket below it. 3 spiders, 1 artifact,
ratchet on. No chips, no vaults, no masking extras. Three falsifiable questions:

1. Does the hum-siege break with native tools — throw, lure, gaps — in under 45 s,
   unprompted?
2. Is the return ascent completable on memory skeleton after one outbound pass?
3. Is gondola/perch camp time under 60 s?

If (1) stalls, no content fixes it.

## 9. Overrides vs doc/vision.md

- Vision §6 robo-dog → **the spider** (this doc §3–4).
- Vision §7 Descent Contract (five stacked floors) → **the Retrieval** in the Tower (this
  doc §1–2).
- Heat decay-after-quiet → **ratchet**: decays only to (max reached − 1); dispatched
  spiders persist.
- Vision §11 stacked industrial floors → **completion-gradient tower** (this doc §1, §5).
- Fall rule amended: interior falls soft-fail (unchanged); **perimeter void is lethal**,
  always telegraphed by wind, with authored nets in designated bays.

Everything else in vision.md stands.
