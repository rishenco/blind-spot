# BLIND SPOT — Core Loop v0.5

*Draft for playtest, 2026-08-24. Laws are fixed; numbers are first-pass tuning values. This doc
is the home of the mode (**the Retrieval**), the map (**the Unfinished Tower**), the enemy
(**the Spider**), and the build order (§11). Perception, energy, movement, tone, and the laws
live in doc/vision.md (v1.1) — the two docs are reconciled as of this version, so the override
list of v0.4 is gone: vision.md no longer says the things it overrode. Anything marked
**unbuilt** is plan, not code.*

## 0. The loop

Spend noise to buy the map on the way down; spend the map to outrun your noise on the way home.

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
- **Materials are the floor plan's voice.** The completion gradient is also a material
  gradient: bare steel frame up top, poured concrete mid-tower, stone and dust pockets below.
  Every surface's material class scales the sound of crossing it (vision §3.9) — the loud-fast
  steel walkway versus the quiet-slow dust slab is the tower's most frequent routing choice,
  and the spider's footfall timbre tells you which surface it is on.
- **Props.** Construction clutter is the authored sound-trap set — pipe stacks, sheet metal,
  chain curtains, glass panes — at chokepoints. Readable via the 2 m contact shell before they
  trigger at walk speed.
- **Freight hoist.** Unlockable in-run shortcut: 20–30 s loud activation, persists for the run.
- **Crane-cable gondolas.** Hanging platforms reachable only by jump or throw. Spiders cannot
  traverse cables (§3.1). Caching artifacts there is legal, but a parked hum accrues besiegers
  below and around it — playtest watch item.

## 2. Mode — The Retrieval

One session = one map, 15–25 min. Solo-first; co-op 1–4 later under the same rules (voice is
diegetic per vision §10).

- **Objective.** 4 humming artifacts (power cells) sit in finished-room pockets at increasing
  depth. Free order. Carry each to the crane base; a banked artifact is locked forever — the
  run ratchet. Win = all 4 banked. Solo death = run over.
- **The artifact, not the player, is the sound source.** It hums every 2 s (audible 12 m) when
  held or at rest; flight is silent — a throw teleports the sound origin, and the landing is a
  loud clang that paints. A parked or thrown artifact accrues spiders
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

The only enemy. A **persistent stalker**: it closes, strikes, and keeps hunting. It has no
detonation, is never spent, and does not die to kill you — you can be hurt, retreat, break
line-of-hearing, and be hunted again, and it will still be there. The counterplay verbs are
therefore **read, avoid, bait, juke, break contact** — "spend" is gone from the list, and what
spending used to buy (light) is paid out by the hunt itself (§3.4). All of §3 is **unbuilt**
(milestone M4).

- **Senses.** Hearing only, plus its own tap-sonar: it taps a leg to ping, gaining knowledge
  and revealing itself in the same act — its taps paint around it. The enemy pays for
  questions too. It never pathfinds to the player's true position — only to sound origins.
  Every death must trace to a sound the player made.
- **Modes and speeds:** patrol 2.5 / investigate 4.0 / attack 5.5 m/s — always slower than
  player sprint (6.0). It wins by geometry, not speed.

### 3.1 The Four Teeth

1. **Continuity vs gaps.** It moves on any connected surface — floors, walls, and ceilings,
   including hanging inverted and dropping from the ceiling onto the floor (§3.5). It cannot
   jump (the pounce is its only flight) and cannot traverse cables or nets. The player's graph
   is gaps and wires; its graph is continuity. A 2 m gap is your step and its detour.
   The consequence is worth stating flat: **altitude is not safety.** The old "high routes are
   safe but slow" rule (vision v1.0) is dead — a wall is a road and a ceiling is an ambush
   floor. Your safety comes from *sound discipline and geometry-reading*: quiet surfaces,
   broken lines of hearing, and the discontinuities — gaps, cables, nets, drops — that its
   graph cannot cross and yours is built on.
2. **Motion always sounds.** Every step is audible and rendered as light at the real contact
   points — a scuttling constellation whose chain gives direction (§3.2). Only a stationary,
   silent spider is invisible.
3. **The pounce is ballistic.** Rising chitter wind-up 0.7 s, unmaskable by ambient noise. In
   flight it cannot steer — jukeable. A miss lands hard: loud, ~2 s recovery.
4. **Webs are territory made readable.** It strings snare-lines in its zone; crossing one
   rings and summons investigation. Snares read by paint or by contact shell at crouch speed.
   Learn the web = read the patrol.

### 3.2 The sound model — one event per gait cycle

The spider emits **one sound event per gait cycle, not one per leg**. That single event
carries, as a payload, the real contact points of the legs that touched down during the cycle,
each tagged with the material of the surface it struck (vision §3.9).

Why this split: the expensive half of a sound — propagation, occlusion, the geometry paint —
is paid once, from the body's centroid; the cheap half — the event layer, the transient
colored markers the player sees — draws the real constellation of feet. The player sees a
scatter of contacts, not a single blob, and **every dot in that scatter is a real foot at a
real place**. Eight legs on eight surfaces read as a texture; a spider crossing from dust onto
steel changes voice mid-stride, and that change *is* the information.

This is only honest if the feet are honest, which is why the gait is procedural,
contact-driven IK and never a keyframed cycle — a canned cycle foot-slides, and a sliding foot
would sound a footfall where nothing touched anything, which law 2 forbids (vision §1,
law-adjacent commitments).

### 3.3 The strike — graded damage *(numbers are a proposal, first-pass tuning)*

Player HP 100 (vision §10). No one-hit kills, no flat cost — a strike hurts, glancing contact
hurts less:

- **Pounce, clean connect** (contact within ~0.5 m of its body line): 40 dmg + knockback.
- **Pounce, glancing** (clipped at the edge of its reach, or caught mid-juke, out to ~1.2 m):
  15 dmg, no knockback. Beyond 1.2 m: a miss.
- **Close-quarters strike** (standing within 1.5 m of a spider that is not recovering): 25 dmg,
  at most once per 1.2 s per spider.
- After any hit, 0.5 s of player recovery during which it cannot strike again, plus the
  knockback separation — a hit is a beat in the duel, never a blender.

So roughly three clean pounces kill, and retreat is always live: take the hit, break
line-of-hearing, and it degrades to investigating your last-heard origin (§4). Stalked in
silence — never killed in silence.

### 3.4 The lantern — what replaced the detonation

The kamikaze's detonation was the game's biggest free map-paint and the reward for baiting.
Its inheritor is **the hunt itself**, paid out continuously instead of as one flashbulb
*(design proposal)*:

- Chase gait paints 8 m around the body per gait cycle — a chasing spider floodlights every
  room it crosses, in the material voice of whatever it runs on.
- It crashes through props while hunting; each prop sounds and paints in its own voice.
- A missed pounce lands hard: ~10 m paint at the impact plus the 2 s recovery whine.
- Its tap-sonar and hunting sting paint around it; its ceiling drop paints above you (§3.5).

Baiting stays a first-class play: E-ping a place you aren't, and the spider lights the way
there for you. This is strictly better information than the flashbulb was — continuous,
directional, readable as a moving chain — and it costs more nerve, because the light never
removes the threat: the lantern is always on loan.

### 3.5 The ceiling drop — signature move *(tell is a proposal, first-pass tuning)*

The spider can cross the ceiling above you and drop onto the floor. Per law 4 (loud before
lethal) the drop has an unmaskable audible wind-up: to release it must unlatch, leg by leg — a
**0.9 s ratchet of unlatching taps directly overhead**, rising in tempo, rendered through the
existing cross-floor/overhead bleed (vision §3.4) as a dim patch on your ceiling that then
falls. The landing is a loud full-radius paint. The drop is a repositioning, not an attack: it
lands staggered for 0.5 s and cannot strike or pounce during the wind-up, the fall, or the
stagger — the taps are your window to move, and a player who reads them is standing somewhere
else when the floor shakes.

### 3.6 Siege

Spiders besiege the hum anchor (ceiling positions included), never the player as such. Native
counters: throw the artifact (displace the anchor), E-ping lure, gondola cache, crouch-out
without cargo (≤2 m audibility).

**Counts:** ~2–3 at run start; the ratchet adds; cap ~6 per zone.

## 4. The Duel

Four beats. Matador, not soldier.

| Beat | Its tell | Your counter |
|---|---|---|
| Lock | Hunting sting — loud, recruits nearby spiders | Break line-of-hearing before the sting ends |
| Run-down | Cuts through wall/ceiling continuity; chase gait = red drumroll | Win on straights and gaps |
| Wind-up + pounce | Rising chitter, unmaskable; flight is ballistic | The juke: hard lateral or vertical cut |
| Overshoot | Loud landing, ~2 s recovery whine | Punish or shed: pass through its zone while it recovers — grab, cross, cache — or break the sound chain and let its belief pin search the wrong room |

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
- **Authored-first level contract.** The tower is authored for now: hand-built levels in a
  declarative level format with a prefab library (M5). The format stays proc-gen-ready —
  segments carry both graphs plus metadata (occlusion class; material palette; lighthouse,
  hatch, and gondola slots; route price tier) — but there is **no generator yet**; a generator
  is post-MVP. The invariants below are validated on authored levels today and become the
  generator's contract later: spider graph spans all artifacts and hatches; ≥2 links per zone
  + 1 unlockable shortcut; three price-tier routes (loud-fast / mid / silent-slow) to every
  artifact; no sealed–sealed adjacency.

## 6. Player economy

Unchanged from vision §4–5: movement verbs and speeds stand (see there for built vs unbuilt).
The Halo shows net self-loudness, masking wind included. A rim-glow directional hearing cue is
accessibility-tier (no-headphones play), kept minimal. Chips (vision §9) are post-first-playable.

| Stat | Value |
|---|---|
| Energy / regen | 100 / 6 per s |
| E-ping (110° cone, 22 m — the look-around; wakes what it sees) | 18 |
| Q-ping (360°, 12 m — the ceiling check) | 10 |
| Sprint drain | 1 /s |

## 7. Debrief — mastery made measurable

- Per-trip return splits vs personal best.
- Noise ledger: every sound spent, where, and what it cost.
- On death: a 2 s replay naming the betraying sound.
- One "a faster line existed here" reveal per run.

## 8. First playable — "The Span" *(parked)*

*Parked, kept as an illustrative sketch — not the plan of record. The build order in §11
supersedes it: the actual first playable is the gym (M3). The falsifiable questions below stay
worth asking when the siege exists.*

Crane base + one open-frame span + one finished-room pocket below it. 3 spiders, 1 artifact,
ratchet on. No chips, no vaults, no masking extras. Three falsifiable questions:

1. Does the hum-siege break with native tools — throw, lure, gaps — in under 45 s,
   unprompted?
2. Is the return ascent completable on memory skeleton after one outbound pass?
3. Is gondola/perch camp time under 60 s?

If (1) stalls, no content fixes it.

## 9. Spice — the creative pass

- **Masking law + hum-walking.** Any sound covers sounds under half its intensity,
  symmetrically for all ears. Corollary: the hum masks walk-steps inside its 12 m — step
  on the beat and vanish inside the beacon everyone hears.
- **Everything that falls, paints (M2).** Any loose object can be picked up, dropped, or
  thrown: flight is silent; the impact sounds in its material's voice (vision §3.9), paints
  the area around the landing, and draws investigation. Every piece of debris is a portable
  question and a portable lure — spiders divert to it like to any other sound origin.
- **Wounded reactor.** Under 25 HP the cracked chassis whines every 3 s (6 m audible):
  dying makes you glow. Banking repairs.
- **Shelf (post-MVP):** Dock Bloom · weather draws · girder chord · molt cycle · egg
  clutches · the funeral · brownout · the choir · Broodmother · ghost freight · stolen
  tripwires · scribe slides.

## 10. Relation to doc/vision.md

As of vision v1.1 / core-loop v0.5 the two docs are reconciled — there is no override list.
Division of labor: **vision.md** holds the laws, perception, energy, movement, tone, and
non-goals; **this doc** holds the mode, the map, the enemy, and the build order. If they ever
disagree again, the more specific doc wins for its own subjects and the disagreement is a bug
to fix here. Where either doc disagrees with shipped code, the code wins and the doc must say
so (currently: none — the E-ping reconciliation is recorded in vision §3.5).

## 11. Build order

The agreed milestones, in order. Each is done when it is demoable and reviewed; co-op comes
after all of them.

- **M0 — the instrument bench.** Make the codebase measurable, testable, and scalable before
  adding content. No observable behaviour change.
- **M1 — the noise crystallizer.** One mechanism for every sound in the game: multi-emitter
  safety, the hearing *query* that AI will consume, source identity on events, material
  voices (vision §3.9), audio — the synthesized WebAudio subscriber on the same bus.
- **M2 — throwables.** The cheapest non-player emitter, and M1's integration test.
- **M3 — the gym.** One authored level containing exactly one instance of every mechanism the
  tower will later multiply. The actual first playable.
- **M4 — the spider.** Behaviour and tells first, then procedural contact-driven gait (§3.2),
  then its tap-sonar.
- **M5 — the tower.** 5+ floors, authored, in a declarative level format with a prefab
  library (§5).
