# BLIND SPOT — Vision

*v1.0, 2026-08-22. This document defines the game. Laws are fixed; numbers are first-pass
tuning values — playtests change numbers, not laws.*

## TL;DR

- **What:** a first-person parkour-stealth game about seeing with sound. Solo or co-op up to 4. Web (for now).
- **Core fantasy:** fast, responsive movement through a world you only partially understand. Mastery is navigating efficiently and predicting routes based on enemy movement.
- **Perception:** the world is black. Every sound — footsteps, pings, dogs, machinery — paints geometry as blips: louder = denser, source = color. Your own footsteps are your headlights; whatever lets you see also gives you away.
- **You:** a robot with an internal reactor. Energy pays for sonar pings, abilities, and (slightly) sprinting. Noise is movement's real price; energy is the price of deliberate acts.
- **Enemy:** kamikaze robo-dogs that hunt by ear (patrol → investigate → attack). No weapons — you read, avoid, bait, juke, and *spend* them: their detonation is the loudest map-paint in the game.
- **Loop (the Descent Contract):** your ship docks atop a dead industrial facility. Descend five floors, take the power cells, return. Going down builds your map; the return sprint through geometry you now own is the payoff. Noise raises Heat; Heat sends dogs. Optional deeper floors and side-vaults hold equipable chips.
- **Map:** rectangular industrial floors joined by stairs and shafts; loud sound crosses floors. Rendering is culled to a radius and to ±1 floor.
- **Look:** matter is cyan and cools with age into a permanent dim skeleton; sound events are colored by source; the unknown is never drawn. Cold precision world; the warmth is the players' own voices (built-in voice chat, diegetic).
- **Order of work:** solo prototype first; the readability gates (Blindfold Gauntlet, Lantern Test) before any content; co-op once the loop is fun. Never reuse pre-reset code.

## 1. Design laws

1. **Every question has a price.** Every way of learning emits sound the world can hear. No free, passive, or silent intel — on either side.
2. **The system never lies.** Every blip and sound has a real physical source. No scripted fake noises, no phantom echoes, no jump-scares without a findable cause.
3. **Age is a color; absence is black.** Fresh, stale, and remembered are visually distinct. Unknown space is never rendered — no ambient light, no fog, no helpful outlines.
4. **Loud before lethal.** Every threat and hazard telegraphs in audio before it can hurt you. No silent kills.
5. **Movement stays genuinely good.** Speed is the fantasy, information is the tension. Nothing may turn movement into rationing: no encumbrance, no fall damage, no meaningful stamina tax.

## 2. The player

A robot powered by an internal reactor, carrying two perception systems — a sonar (active pings)
and an audio system that reconstructs geometry from *any* sound it hears. Movement handles like
The Finals: responsive, momentum-preserving first-person parkour.

## 3. Perception: sound paints the world

### 3.1 The rule

Every sound event is a paint source: it reveals static geometry around its **origin**. Blip
density scales with intensity; falloff is quadratic. You receive an event's paint only if the
event is within your own hearing range (base 18 m). Without sound you perceive only contact
geometry (a faint shell within 2 m of your body, plus surfaces you touch).

### 3.2 Two color layers

- **Matter layer** — painted geometry is always cyan-family, regardless of what painted it.
  Age is temperature: fresh ice-white → cyan → dim navy. Depth cues live only inside this band.
- **Event layer** — a transient marker at the sound's origin, colored by source, fading in 2.5–6 s:
  self = amber · teammate = green (+ a steady glyph pip — never hue alone) · dog = red-orange,
  jagged, motion-smeared · prop/machinery = pale yellow · objective = gold (reserved) ·
  detonation = white flash.

One layer answers "what is there"; the other answers "what just happened". Geometry never takes
a source's color — that would make age and trust unreadable.

### 3.3 Event classes (paint radius at origin / range dogs hear it)

| Event | Paint | Dogs hear |
|---|---|---|
| Crouch step | 1.5 m | 2 m |
| Walk step | 4 m | 11 m |
| Sprint step | 7 m | 24 m |
| Landing (>2 m drop) | 8–14 m | 28 m |
| Slide | 5 m continuous | 16 m |
| Prop knock (can, chain, glass) | 8–12 m | 25 m |
| Q-ping (360°) | 12 m | 18 m |
| E-ping (25° cone) | 40 m | 30 m — at **both ends** of the beam |
| Dog gait: patrol / investigate / chase | 2 / 4 / 8 m around the dog | — |
| Detonation | 22 m omni, through floors | 60 m |
| Carried cell hum (every 2 s) | 2 m self-halo | 12 m |
| Voice (open mic) | scales with volume | scales with volume |

Consequences to protect: sprinting lights your path ~7 m ahead per footfall — moving fast **is**
scanning; dogs are walking lanterns you track by their own paint; the E-ping wakes the room it
looks into, making it a bait tool, not a free telescope.

### 3.4 Propagation

- Direct line-of-hearing: full values.
- Through one wall: radius −60 %, origin fuzzed ±2 m, dimmer paint. Through two or more: nothing.
- **Floors:** only the loud class (landings, detonations, dispatch hatches, lift machinery)
  bleeds through, rendered as a dim moving patch on your floor/ceiling — 3D information without
  3D geometry.

### 3.5 Active sonar

Manual only; two modes; cost and shape modified by chips; minimum 0.75 s between pings.

- **E — directed ping** (primary): 25° cone, 40 m, 18 energy. The question-asker. At range it
  returns edge-biased silhouette lines, not fog.
- **Q — spatial ping**: 360°, 12 m, 10 energy. The room-read and panic button.

### 3.6 Permanence and the visibility window

Scanned geometry is kept for the whole run: detail decays with age, but every surface cools into
a permanent dim **memory skeleton** (alpha floor ~0.22) — you never lose the map, only the fine
read. Rendering is windowed: only points within ~45 m **and** within one floor above/below your
position are drawn. Data outside the window persists and reappears as you approach.

### 3.7 Ghosts

Moving things freeze where last heard/painted: a posed silhouette with a 0.3 s motion smear that
cools (hot → rust, ~10 s) and then visibly dissolves. Never interpolated, never predicted by the
renderer — a ghost is a photograph, and prediction is the player's job.

### 3.8 The Halo (self-readout)

A ring around the reticle whose brightness equals your current audible radius, plus a matching
hum pitch. You always know exactly how loud you are. Non-negotiable: the genre's most-repeated
complaint is "I can't tell when I'm detectable."

## 4. Energy: the reactor

One bar. Capacity 100, regeneration 6 /s.

- **Spends:** E-ping 18 · Q-ping 10 · chip actives 20–25 · revive surge 30.
- **Drains:** sprint 1 /s (a light tax — noise, not energy, is sprint's real price). All other
  movement is free.
- **Chips reserve capacity** (§9): equipping passives lowers max energy. Loadout is the
  energy-allocation game — discrete choices, no sliders.
- **Empty bar** blocks pings and actives only; it never stops you from moving.

## 5. Movement

- Verbs: crouch 1.7 · walk 3.5 · sprint 6.0 m/s · jump · mantle (≤2.2 m) · vault · slide ·
  ledge-grab · ladder climb (2.5 m/s, silent).
- No fall damage: a >4 m landing costs a 0.3 s stagger and a loud paint flash instead.
- Descending is fast and loud (drops ring out); ascending is slow and quiet (ladders). Diving
  deep is easy — coming home is the commitment.
- Traversal affordances (ledges, rails, rungs, lips) render as short bright micro-lines inside
  the cyan band: **dots are matter, lines are holds** — one encoding, everywhere, forever.

## 6. The robo-dog

The only enemy for now. It perceives exactly as you do — by ear — and it is a routing/prediction
threat, not a combat target.

- **Modes:** patrol (routes, quiet — heard 8 m direct, ~4 m fuzzed through a wall) →
  investigate (heard something, never confirmed: moves to the last-heard origin, searches 10 s,
  decays back) → attack (confirmed: chase).
- **Speeds:** 3.0 / 4.5 / 7.0 m/s. Chase beats sprint in a straight line; its 3 m turn radius
  means corners and verticality beat it.
- **Kamikaze:** lunges from 5 m; inside 2.5 m a 0.7 s beep-spool arms the fuse — that window is
  the juke. Detonation: 100 dmg ≤2 m, 45 at 4 m, 12 at 6 m, plus knockback.
- **Traversal:** stairs and ramps only — no ladders, no mantling above 1.2 m. High routes are
  safe but slow; floor routes are fast but patrolled.
- **A stationary, silent dog is invisible.** When it stops to listen it vanishes from your map,
  leaving a cooling ghost. The rule that hides you hides it.
- **Its belief of you** is also a rotting ghost: it navigates to where it last heard you, and
  its search logic is learnable and readable.
- **Spent, not fought:** a detonation is a 22 m flashbulb through floors — bait a dog (E-ping a
  place you aren't), juke the lunge, choose where it explodes. A dog crashing through props
  paints geometry for you the same way. Every death illuminates.
- Counts: 2 on floor 1, +1 per floor down, cap 6 per floor.

## 7. Core loop: the Descent Contract

The run (15–25 min): your airborne ship docks topside. Retrieve the materials — **power cells**
— from marked depth (floor 5) and get everyone home.

- **Down is the compass.** Five stacked floors plus two optional deeper ones; architecture
  itself narrows the search — no clue system.
- **Outbound = buy the map.** Stealth, routing, cache raids; every sound spent paints geometry
  that stays.
- **Cells:** one per player (min 1). Small — they never slow or encumber you — but a carried
  cell hums (12 m, every 2 s). Handoff 2 s. Stacking cells on one carrier stacks hums: the
  loud-mule gambit is legal.
- **Return = spend the map.** Sprint full-tilt through geometry you own while dogs converge on
  the hum. This is the payoff the whole game exists for.
- **Heat (per floor, 0–3):** loud events raise it; each step dispatches an extra patrol via an
  audible hatch (8 s telegraph); decays after ~2 min of quiet. Detonations also summon 1–2 dogs
  from adjacent floors. The return trip's difficulty is a mirror of how you played the outbound.
- **Route rewards:** side-vaults (multi-entrance) hold chips behind sound-trap fields; floors
  6–7 hold the rare ones. Unlockable freight lifts and drop-chutes (loud, 20–30 s to open,
  persist for the run) shorten the way home. Pay in noise, get paid in route. No shop, no
  currency.
- **Extraction:** all cells aboard + all living players aboard, hold 5 s. A cell placed aboard
  is banked even if the run later wipes.
- **No hard timer.** Heat is the clock. (Watch for stalling in playtests.)

## 8. Props and traps

Knockable props are authored sound-traps, never physics clutter: sparse, deliberate placements —
chain curtains, glass fields, stacked cans — at chokepoints, each with a crisp single audio
signature. They are read-and-route puzzles (crouch through, go around), and they are the real
price of moving through unpainted space. Machinery hazards obey law 4: they sing their rhythm
(crushers thump their cycle) — timed by ear, confirmed by ping. No ragdoll comedy anywhere.

## 9. Upgrades

**In-run: chips.** Found in vaults and caches, equipped on the spot. 3 slots; swap any time out
of chase. Passives reserve reactor capacity; actives cost energy per use. Run-scoped stat boosts
are fine here. Starting pool:

| Chip | Effect | Cost |
|---|---|---|
| Sensitivity | +8 m hearing (hear farther without pinging louder) | −12 max energy |
| Ping Power | +50 % E-ping range and density | pings cost +6 |
| Reactor | +2 /s regeneration | — (rare) |
| Damped Soles | silent landings | −8 max energy |
| Mag Grips | double ladder speed, silent mantles | −8 max energy |
| Long Slide | extended slide, quieter | −6 max energy |
| Boost Dash | active: burst dash | 22 / use, loud |

**Meta (between runs):** unlocks are new options only, never raw stat growth — new chip types
entering the pool, new ping modes, new movement verbs. XP comes from banked cells and
information plays, never from ping count. Meta stays thin until the core loop is proven fun.

## 10. Co-op and voice

- 1–4 players; solo is first-class (and the first prototype).
- Shared team geometry map (a diegetic uplink between rigs); event markers stay personal.
- **Voice chat is mandatory scope**, positional and proximity-based. Default is diegetic: voice
  is sound, so it paints and dogs hear it — an open mic is a lantern and a liability. Per-lobby
  toggle to out-of-world voice.
- Downed state 25 s; revive 3 s (audible 14 m) + 30 energy. Solo death ends the run. Player HP 100.
- On death: a 2 s replay of the killing dog's approach and the sound that betrayed you.

## 11. Maps

- Rectangular industrial floors, ~45×30 m, ~6–8 m tall, joined by side stairs and occasional
  multi-level rooms/shafts that create real vertical play and cross-floor sound. (The circular
  silo concept is parked, not dead.)
- Labyrinth-ness lives in **route choice** — ≥2 fixed links between adjacent floors plus 1
  unlockable shortcut, three viable paths across every floor at different noise/speed prices —
  never in disorientation.
- Per floor: one large-silhouette landmark (point clouds transmit mass before texture) and one
  palette accent for location identity.
- Floors are sized 30–40 % smaller than looks right on paper — dark space reads bigger.
- Assembly: authored room library, procedurally selected and rotated; dog patrols, cell
  placement, cache and trap arming randomized per run.

## 13. Tone

Cold, clean, precise — Mirror's Edge / Ghostrunner register, not R.E.P.O. Sleek rigs, dead
industrial dark, zero goofy assets. All warmth is human: the proximity voices of your team,
including the comedy of an open mic at the wrong moment. The robots are sleek; the players are
funny.

## 14. Non-goals (for now)

- No weapons. Counterplay verbs: read, avoid, bait, juke, spend. (Fallback if playtests show
  cornered-helplessness: a loud 12-energy Shove that staggers a lunging dog — added only on that
  evidence.)
- No PvP and no ranked modes at launch; revisit only after a stable co-op population exists.
- No destruction. No fall damage. No encumbrance. No shop/currency. No hard run timer.
- No minimap, no compass, no objective markers — navigation is diegetic (memory skeleton,
  landmarks, sound).

# Visual references
- Scanner Sombre
- After Image: https://github.com/altaidevorg/afterimage
