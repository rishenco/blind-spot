# BLIND SPOT — Vision

*v1.1, 2026-08-24. Laws are fixed; numbers are first-pass tuning values — playtests change
numbers, not laws.*

*What this document is for: the laws, the perception model, energy, movement, tone, and
non-goals — the parts of the game that survive any mode or map. The mode (**the Retrieval**),
the map (**the Unfinished Tower**), the enemy (**the Spider**), and the build order live in
`doc/core-loop.md`; where this file used to define an earlier mode and enemy (the Descent
Contract, the kamikaze robo-dog) it now points there instead of restating. Where a number here
disagreed with the shipped code, the code won and the deviation is noted. Anything marked
**unbuilt** is plan, not code.*

## TL;DR

- **What:** a first-person parkour-stealth game about seeing with sound. Solo or co-op up to 4. Web (for now).
- **Core fantasy:** fast, responsive movement through a world you only partially understand. Mastery is navigating efficiently and predicting routes based on enemy movement.
- **Perception:** the world is black. Every sound — footsteps, pings, the enemy, machinery — paints geometry as blips: louder = denser, source = color. Your own footsteps are your headlights; whatever lets you see also gives you away.
- **You:** a robot with an internal reactor. Energy pays for sonar pings, abilities, and (slightly) sprinting. Noise is movement's real price; energy is the price of deliberate acts.
- **View:** first person is the only camera. Third person exists, at most, as a debug affordance.
- **Enemy:** the Spider — a persistent stalker that hunts by ear (patrol → investigate → attack) and walks floors, walls, and ceilings. It closes and strikes; you take graded damage, retreat, break line-of-hearing, and get hunted again. You never fight it and can never remove it — the counterplay verbs are read, avoid, bait, juke, **break contact**. Defined in core-loop.md §3–4.
- **Loop (the Retrieval):** the ship docks at the crane atop an unfinished high-rise. Four humming artifacts sit at increasing depth; carry each to the crane and bank it. Outbound buys the map; the return ascent spends it while the enemy converges on the hum. Defined in core-loop.md §1–2.
- **Map:** the Unfinished Tower — a completion gradient from bare frame down to sealed rooms; deeper is quieter, blinder, richer. Rendering is culled to a radius and to ±1 floor. Defined in core-loop.md §1, §5.
- **Audio:** in scope, synthesized WebAudio, no sampled assets — a subscriber to the same sound-event bus that paints geometry, so what you hear and what you see can never disagree (§1).
- **Look:** matter is cyan and cools with age into a permanent dim skeleton; sound events are colored by source; the unknown is never drawn. Cold precision world; the warmth is the players' own voices (built-in voice chat, diegetic).
- **Order of work:** the agreed milestones M0–M5 in core-loop.md §11; the readability gates (Blindfold Gauntlet, Lantern Test) before any content; co-op once the loop is fun. Never reuse pre-reset code.

## 1. Design laws

1. **Every question has a price.** Every way of learning emits sound the world can hear. No free, passive, or silent intel — on either side.
2. **The system never lies.** Every blip and sound has a real physical source. No scripted fake noises, no phantom echoes, no jump-scares without a findable cause.
3. **Age is a color; absence is black.** Fresh, stale, and remembered are visually distinct. Unknown space is never rendered — no ambient light, no fog, no helpful outlines.
4. **Loud before lethal.** Every threat and hazard telegraphs in audio before it can hurt you. No silent kills.
5. **Movement stays genuinely good.** Speed is the fantasy, information is the tension. Nothing may turn movement into rationing: no encumbrance, no fall damage, no meaningful stamina tax.

Law-adjacent commitments — not laws, but consequences of them we have locked in:

- **One bus, two senses** (law 2). Every audible thing in the game is one event on the sound
  bus (`src/paint/soundEvents.ts`); the paint system and the audio mixer are both subscribers
  to that same stream. The *same* event paints the world and makes the noise, so sight and
  hearing can never disagree — a sound with no paint, or paint with no sound, is impossible to
  produce. Both subscribers ship: the reveal and the synthesized mixer (`src/audio/`) read the
  same events, and every voice the mixer builds takes its level from the event's own hearing
  radius. There is exactly one sound in the game that is not on the bus — §3.8's Halo hum — and
  it is not an exception to this. The law forbids a sound *the world makes* that paints nothing;
  the hum is the rig's own gauge, has no position and no emitter, is audible to nobody but its
  pilot, and nothing in the world can hear it. A hum with a place in the world would be a
  violation, which is why it is not given one.
- **No canned walk cycles** (law 2). Enemy movement animation is procedural, contact-driven IK
  — never a keyframed cycle. A keyframed cycle foot-slides, and a sliding foot would emit a
  footfall sound (and therefore paint geometry) at a point where no foot actually touched
  anything: the system would be lying. Every footfall the world hears must correspond to a
  real contact at a real place on a real surface.
- **Material voices** (laws 1–2). Surfaces have a material class that gives every contact
  sound its voice (§3.9). What a thing is made of is audible, on both sides of the hunt.

## 2. The player

A robot powered by an internal reactor, carrying two perception systems — a sonar (active pings)
and an audio system that reconstructs geometry from *any* sound it hears. Movement handles like
The Finals: responsive, momentum-preserving first-person parkour. First person is the only view.

## 3. Perception: sound paints the world

### 3.1 The rule

Every sound event is a paint source: it reveals static geometry around its **origin**. Blip
density scales with intensity; falloff is quadratic. Without sound you perceive only contact
geometry (a faint shell within 2 m of your body, plus surfaces you touch).

**One hearing law, for every ear.** You receive an event's paint only if you can hear it, and
"can hear it" means the same thing for you as it does for the spider: the distance is within
**both** your own hearing range (base 18 m, raised by the Sensitivity chip) **and** the event's
own carry radius — the right-hand column of §3.3. A crouch-step carries 2 m; standing 10 m away
you do not hear it, and neither does anything else. This is deliberately stricter than "18 m and
you hear everything": a listener whose ears obeyed different physics than the enemy's would make
§3.3's right column a fiction on one side of the hunt and a rule on the other. One predicate
governs the player's paint, the spider's hearing, and every ear added later.

### 3.2 Two color layers

- **Matter layer** — painted geometry is always cyan-family, regardless of what painted it.
  Age is temperature: fresh ice-white → cyan → dim navy. Depth cues live only inside this band.
- **Event layer** — a transient marker at the sound's origin, colored by source, fading in 2.5–6 s:
  self = amber · teammate = green (+ a steady glyph pip — never hue alone) · spider = red-orange,
  jagged, motion-smeared · prop/machinery = pale yellow · objective = gold (reserved).
  For the spider, "origin" is plural: the marker is the real constellation of its foot contacts,
  not a single blob (core-loop §3.2). Implemented today: the self/amber family only.

One layer answers "what is there"; the other answers "what just happened". Geometry never takes
a source's color — that would make age and trust unreadable.

### 3.3 Event classes (paint radius at origin / range the enemy hears it)

The shipped classes match `src/paint/soundEvents.ts` exactly; rows marked **unbuilt** are
designed but have no emitter yet. The right-hand column is live for every ear that exists
today: `SoundBus.canHear` is the one place it is read, and the player's own paint is already
gated on it (§3.1). The spider joins that predicate at M4 rather than bringing its own.

| Event | Paint | Enemy hears |
|---|---|---|
| Crouch step | 1.5 m | 2 m |
| Walk step | 4 m | 11 m |
| Sprint step | 7 m | 24 m |
| Landing (scales with impact, ~0.8–6 m drop) | 8–14 m | 28 m |
| Q-ping (360°) | 12 m | 18 m |
| E-ping (110° cone) | 22 m | 30 m — at **both ends** of the beam |
| Slide — **unbuilt** | 5 m continuous | 16 m |
| Thrown-object impact (a can landing) — **emitter M2** | 8–12 m by impact speed | 25 m |
| Prop knock — a can settling, a can lifted — **emitter M2** | 1.5 m | 4 m |
| Throw wind-up — start, and the full-tension click — **emitter M2** | 0.5 m | 2.5 m |
| Spider gait cycle: patrol / investigate / chase — **unbuilt**, M4 | 2 / 4 / 8 m around the body | — |
| Carried artifact hum (every 2 s) — **unbuilt** | 2 m self-halo | 12 m |
| Voice (open mic) — **unbuilt** | scales with volume | scales with volume |

The three M2 rows replace v1.0's single "prop knock, 8–12 / 25" guess, which conflated three
different sounds a throwable makes into one. Class and voice shipped ahead of the emitter: each
is a row in `SOUND_CLASSES` and in `CONTACT_CLASSES` (`src/paint/soundEvents.ts`) and the mixer
already builds all three, but nothing yet makes them — the throw verb is what turns them on.

The wind-up is the odd one of the three twice over. It is the only one that strikes nothing, so
it is the only one that answers `false` in `CONTACT_CLASSES` and the only one no material scales.
And it is, deliberately, the entire charge meter: there is no charge bar anywhere on screen, the
full-tension click is how you know the arm is wound, and that click is a real sound anything
within 2.5 m hears. A readout that is also a price is the shape law 1 asks for, and it is why
the throw costs no energy at all — the arm is a mechanism, not the reactor, and its price is
already threefold in the game's own currencies: finite cans, the wind-up's noise, and the walk
back to fetch one.

All contact-made classes (steps, landings, slides, knocks, impacts, spider footfalls) are
scaled by the surface's material voice (§3.9) — and where two bodies meet, by the mean of both
of theirs. The detonation row of v1.0 is gone with the kamikaze enemy — its map-paint role is
inherited by the hunt itself (core-loop §3.4).

Consequences to protect: sprinting lights your path ~7 m ahead per footfall — moving fast **is**
scanning; the spider is a walking lantern you track by its own paint; the E-ping wakes the room
it looks into, making it a bait tool, not a free telescope.

### 3.4 Propagation (design — occlusion is **unbuilt**; today the hearing gate is straight-line distance)

- Direct line-of-hearing: full values.
- Through one wall: radius −60 %, origin fuzzed ±2 m, dimmer paint. Through two or more: nothing.
- **Floors:** only the loud class (landings, pounce misses, ceiling-drop wind-ups and impacts,
  dispatch hatches, hoist machinery) bleeds through, rendered as a dim moving patch on your
  floor/ceiling — 3D information without 3D geometry. This overhead patch is also the canvas
  for the spider's ceiling-drop tell (core-loop §3.5).

### 3.5 Active sonar

Manual only; two modes; cost and shape modified by chips; minimum 0.75 s between pings.

- **E — directed ping** (primary): 110° cone, 22 m, 18 energy. The *look-around*: the width of
  a corridor plus both its walls, the depth of one decision. (v1.0 specified a 25° × 40 m
  telescope; played, that answered "what is exactly where I am already looking" about rooms too
  far to matter. The code re-roled it and the code is right — E and Q now differ in *shape*,
  not reach. The price is unchanged: it wakes both ends of the beam.)
- **Q — spatial ping**: 360°, 12 m, 10 energy. The room-read, the panic button, the ceiling check.

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

The hum's **pitch** is the readout, not its volume: `55·√(r/1.5)` Hz, where `r` is the radius at
which you can be **heard** — §3.3's right-hand column, scaled by the material you are standing on
(§3.9) — not the radius you paint. 1.5 m is the formula's reference and the pitch floor, not a
stance: a crouch-step on concrete carries 2 m and sits at 63 Hz, felt more than heard, and a
24 m sprint reaches 220 Hz, insistent. Loud ground pushes past that — a sprint on metal carries
36 m and rings at 269 Hz — which is the point: the ring and the hum report the radius the world
actually hears, so the surface under your feet moves the readout. It glides continuously rather
than stepping between stances, because the ring is continuous and the two must never disagree;
quantizing the hum into gears would hide exactly the in-between states where you most want to
know how loud you are. Level stays low and near-constant (≈ −21 dBFS) and ducks under events, so
the information rides on pitch and the tone can sit under everything without fatiguing. A volume slider is an accessibility control, not a retreat — the ring remains
the guaranteed readout. **Playtest gate:** if more than half of testers mute it, the stepped
variant is the prepared fallback.

### 3.9 Material voices

Every collider carries a material class — concrete (the default), metal, stone, and **dust**
(`src/paint/materials.ts`). Material is what gives every contact sound its voice: different
timbre, different loudness — and therefore different paint radius and different hearing range.
First-pass multipliers: metal ×1.5 · stone ×1.15 · concrete ×1.0 · dust ×0.6.

**The multiplier scales every radius the event carries, not just the class default.** A landing
that computed its own 8–14 m from impact speed is scaled by the surface it struck, as is a
thrown object's impact. The surface speaks whatever loudness arrives at it, and keeping the law
in one place is what stops each new emitter from having to remember it — M2's throwables and
M4's spider would forget. The consequence is real and intended: a hard landing on steel is
14 × 1.5 = 21 m of paint, louder than a Q-ping, which makes a steel floor a genuinely dangerous
thing to drop onto.

**One knob per question: the multiplier is the only thing that makes one material louder than
another.** A material voice has two independent ways to be loud — the multiplier above, and the
gains of its own resonant modes — and left alone they disagree. Measured against the M1 probe
voices, metal lands exactly on its ×1.5, stone misses by 1.23× and dust by 2.05×: dust paints
0.6× as far while reaching the ear at 0.29×. That is the "one bus, two senses" commitment of §1
broken in the only way it can be — the blip says one thing and the ear says another — and it
takes §3.8's Halo down with it, since the ring claims to show an audible radius the sound does
not have. So every voice is **normalized on its attack** (the first ~85 ms, the part that
answers "how loud was that") to the same level at unit gain, and the multiplier is then applied
on top as the sole level difference. Timbre and decay are untouched and are what carry identity —
metal's 0.3 s ring is metal's whole signature, and normalizing the attack leaves it alone.

The invariant that enforces it: a material's attack-window RMS minus concrete's equals
`20·log10(multiplier)`, within half a dB, for all four. The consequence to accept is that dust
gets *louder* than it currently sounds; if ×0.6 then plays as insufficiently stealthy, the fix
is to lower the multiplier — which shortens its paint radius and the spider's hearing of it
together, which is the honest trade and the one that belongs in this table rather than buried in
a modal gain nobody reads.

**Two bodies, one contact: the level is the mean of the two multipliers in dB.** A footfall is
one body meeting one surface, so a single multiplier answers for it. A thrown can is two — the
can and the slab it lands on — and the table above gives each of them a number. The rule for
combining them is the **geometric mean**, `√(m_object · m_surface)`, which is the arithmetic
mean in decibels: metal on dust and dust on metal both land at ×0.95, halfway between ×1.5 and
×0.6 on the only scale a listener uses.

Three other rules were measured and rejected. The **product** breaks the diagonal — metal on
metal would be ×2.25, outside the band this table defines, and every single-body contact in the
game would then have to be special-cased back out of it. The **minimum** flattens the whole dust
row and the whole dust column onto one value, so a dust can on steel and a dust can on dust
become the same sound and the surface stops being information. **Asymmetric weights** are a
second knob with nothing behind them, and the paragraph above exists to say there is only one.
The geometric mean is closed on [0.6, 1.5], so no pair escapes the band, and it reduces exactly
to `m` on the diagonal — so a footfall is structurally unchanged by this rule rather than
coincidentally unchanged by it.

**What the mean throws away is level, not identity.** "Metal struck dust" and "dust struck
metal" reach the ear at the same loudness and sound nothing alike, because the asymmetry is
carried entirely by **timbre**: the arriving body is the *attack*, the struck surface is the
*resonance*. A metal can hitting dust is a bright tick into a dead thud, tailing near 250 Hz; a
dust clod hitting steel is a soft slap that sets a 0.3 s ring going near 1 kHz. Which of the two
happened is the information — where the object came from, and what it found — and timbre is
where a listener actually reads it. A level difference would only be legible to someone who had
heard the other case to compare it against, which in a black room is nobody.

Status: live. `materialVoiceFor` in `src/paint/soundEvents.ts` is the one place the mean is
taken, and it is taken for composed classes only — a footfall returns before reaching it.
`objMat` on the event carries the arriving body's material through to the mixer, which builds
the two-part voice in `src/audio/voices.ts` with no per-emitter knowledge of what is striking
what. All sixteen pairs are asserted to arrive at one level, and the timbre split is asserted
separately, in `tests/audio/composedVoice.test.ts`.

Dust is the quiet end, and it exists so the tower has a floor to reward: without a class below
concrete, every surface is normal-or-louder and "go slow and stay quiet" has nothing to pay it.

The player-facing consequence: crossing the steel walkway is loud and fast, crossing the dusty
slab is quiet and slow — a real routing choice, priced in the same currency as everything else,
and at tower scale one the player meets every few seconds (core-loop §1). And it cuts both
ways: the spider's footfalls carry the material they strike, so its voice tells you what it is
walking on and therefore *where it is* — a change of timbre mid-stride is a change of surface
(core-loop §3.2).

Status: the multipliers are live. `SoundBus.emit` scales both radii of every contact-class
event by the struck surface's voice, and the surface comes from the box the collision pass
resolved against (`MoveResult.groundBox`), so what the world hears is what the body actually
touched. Pings are not contact sounds and are not scaled — naming a material on one throws.

Dust has a floor to stand on as of the test room's **apron**: the far room south of the
chokepoint door-line is the same continuous slab as the rest of the floor in a different
material band, which turns the tank in the middle of that room into a fork — a short loud lane
north of it, a long quiet one south of it (`src/world/room.ts`; the two lanes are searched,
measured and pinned in `tests/room.test.ts`). One fork in one room is a probe of the mechanic,
not the cadence this section asks for; that arrives with the gym (core-loop §11, M3) and the
tower's material gradient (core-loop §1). What the probe does establish is that the difference
survives the only condition the game is ever played in: one walk-step on concrete hands back
2184 dots of floor and one on dust 673, and the screenshots are a lit room against a puddle at
your own feet (`tools/shoot.mjs` §08).

The difference is now audible as well as visible: `src/audio/voices.ts` synthesizes the four
voices and normalizes each one's attack as described above, and the invariant is asserted in
`tests/audio/materialVoices.test.ts` at every stance, not only at the one the fit was made at.

## 4. Energy: the reactor

One bar. Capacity 100, regeneration 6 /s.

- **Spends:** E-ping 18 · Q-ping 10 · chip actives 20–25 · revive surge 30.
- **Drains:** sprint 1 /s (a light tax — noise, not energy, is sprint's real price). All other
  movement is free.
- **Chips reserve capacity** (§9): equipping passives lowers max energy. Loadout is the
  energy-allocation game — discrete choices, no sliders.
- **Empty bar** blocks pings and actives only; it never stops you from moving.
- **Throwing costs nothing.** The spends above are all *reactor* acts — a rig converting stored
  energy into a deliberate emission. An arm is a mechanism, and taxing it here would double-charge
  a verb whose price is already threefold and already in the game's native currencies: a finite
  supply, the wind-up's noise, and the walk back to fetch what you threw. Charging it in energy
  as well would push every player back onto pings, which would delete the one thing a throwable
  can do that nothing else can — put a sound somewhere you are not (§3.3, M2 rows).

## 5. Movement

- Built: crouch 1.7 · walk 3.5 · sprint 6.0 m/s · jump (tap-cut, buffered) · low vault ≤1.2 m ·
  mantle ≤2.2 m. **Unbuilt:** slide · ledge-grab · ladder climb (2.5 m/s, silent).
- No fall damage: a >4 m landing costs a 0.3 s stagger and a loud paint flash instead. (The
  tower adds one amendment: the *perimeter void* is lethal, always telegraphed by wind —
  core-loop §1. Interior falls stay soft-fail.)
- Descending is fast and loud (drops ring out); ascending is slow and quiet (ladders, once
  built). Diving deep is easy — coming home is the commitment.
- Traversal affordances (ledges, rails, rungs, lips) render as short bright micro-lines inside
  the cyan band: **dots are matter, lines are holds** — one encoding, everywhere, forever.

## 6. The enemy

The kamikaze robo-dog of v1.0 is retired, and with it everything it implied: the detonation
damage curve, the "spent, not fought" economy, "every death illuminates", the 22 m blast as the
game's biggest map-paint, and detonations summoning reinforcements. **The enemy is the Spider**
— a persistent stalker that traverses floors, walls, and ceilings, strikes for graded damage,
and can be escaped but never removed. It is defined in one place: core-loop.md §3–4.

Two things worth restating here because they touch the laws:

- The detonation's design *function* — a huge paint event as the reward for baiting — is
  inherited by the hunt itself: a chasing spider is a continuous lantern, and baiting it
  through a room floodlights that room (core-loop §3.4). Better than the flashbulb: it is
  continuous, directional, and readable — and the light is always on loan.
- Because it cannot be spent, the counterplay verb list changes: **read, avoid, bait, juke,
  break contact** (formerly "spend").

## 7. Core loop

The Descent Contract of v1.0 (five stacked facility floors, power cells, Heat that decays) is
superseded by **the Retrieval** in the Unfinished Tower — core-loop.md §1–2. What survives of
it, generalized: outbound buys the map, the return spends it; the objective hums and cannot be
silenced once undocked; banked objectives are ratcheted forever; shortcuts are paid for in
noise; there is no hard timer — escalation is the clock.

## 8. Props and traps

Knockable props are authored sound-traps, never physics clutter: sparse, deliberate placements —
chain curtains, glass fields, stacked cans — at chokepoints, each with a crisp single audio
signature. They are read-and-route puzzles (crouch through, go around), and they are the real
price of moving through unpainted space. Machinery hazards obey law 4: they sing their rhythm
(crushers thump their cycle) — timed by ear, confirmed by ping. No ragdoll comedy anywhere.

**A prop can also be a supply**, and the stacked cans are the first one that is. The verb list
grows a third entry beside crouch-through and go-around: *take from*. The same column reads two
ways depending on the speed you meet it at, which is `CAN_LIFT_SPEED` doing the same job
everywhere else in this document — pricing rather than preventing. Walk up with room in the rack
and you mine it off the top, one can per touch, for four soft knocks nobody hears past 6 m.
Sprint the same line and you boot the column across the loudest lane in the room and come out
the far side with an empty-handed rack and a floor full of metal. It is deliberately not "the
fast route that also resupplies you": you pay, and you get nothing for it.

The constraint this puts on whoever authors the next one: **a column may be no taller than the
rig can reach**, because retrieval takes the highest can in reach and a can above that line is
one nobody can ever pick up — reaching for it hands you the can below and drops the stranded one
on the pile, a clang on the first touch of every run that no skill avoids. `world/room.ts`
derives its count from the reach rather than choosing it, so the tower's stacks cannot quietly
inherit the bug the test room found.

## 9. Upgrades

**In-run: chips** — post-first-playable (core-loop §6); all **unbuilt**. Found in vaults and
caches, equipped on the spot. 3 slots; swap any time out of chase. Passives reserve reactor
capacity; actives cost energy per use. Run-scoped stat boosts are fine here. Starting pool:

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
entering the pool, new ping modes, new movement verbs. XP comes from banked artifacts and
information plays, never from ping count. Meta stays thin until the core loop is proven fun.

## 10. Co-op and voice

- 1–4 players; solo is first-class (and the first prototype).
- Shared team geometry map (a diegetic uplink between rigs); event markers stay personal.
- **Voice chat is mandatory scope**, positional and proximity-based. Default is diegetic: voice
  is sound, so it paints and the spider hears it — an open mic is a lantern and a liability.
  Per-lobby toggle to out-of-world voice.
- Downed state 25 s; revive 3 s (audible 14 m) + 30 energy. Solo death ends the run. Player HP
  100; the spider's graded strike damage is defined in core-loop §3.3.
- On death: a 2 s replay of the hunting spider's approach and the sound that betrayed you.

## 11. Maps

Map doctrine lives with the map: the Unfinished Tower is defined in core-loop.md §1 and §5
(occlusion gradient, sound-topology quota, lighthouses, quantized affordances, the two-graph
rule). Kept here because they generalize:

- **Authored for now.** Levels are hand-built first, in a declarative level format with a
  prefab library that stays proc-gen-ready — segment metadata and validation invariants are
  specified in core-loop §5 — but **no generator yet**; a generator is post-MVP.
- Labyrinth-ness lives in **route choice** — never in disorientation.
- Per zone: one large-silhouette landmark (point clouds transmit mass before texture) and one
  palette accent for location identity.
- Spaces are sized 30–40 % smaller than looks right on paper — dark space reads bigger.

## 13. Tone

Cold, clean, precise — Mirror's Edge / Ghostrunner register, not R.E.P.O. Sleek rigs, dead
industrial dark, zero goofy assets. All warmth is human: the proximity voices of your team,
including the comedy of an open mic at the wrong moment. The robots are sleek; the players are
funny.

## 14. Non-goals (for now)

- No weapons. Counterplay verbs: read, avoid, bait, juke, break contact. (Fallback if playtests
  show cornered-helplessness: a loud 12-energy Shove that staggers a pouncing spider — added
  only on that evidence.) **A thrown can is not a weapon and must never become one**: it does no
  damage, it cannot stagger, and hitting the spider with one is worth exactly what hitting a wall
  with one is worth — a sound, at that spot. The day a can does damage, every player aims at the
  enemy instead of past it, and the verb stops being about information. It is a way of asking a
  question from somewhere you are not standing, and that is all it is.
- No third-person camera — first person is the only view; third person is a debug affordance
  at most, never a player-facing mode.
- No sampled audio assets — everything is synthesized (WebAudio), driven by the event bus (§1).
- No PvP and no ranked modes at launch; revisit only after a stable co-op population exists.
- No destruction. No fall damage. No encumbrance. No shop/currency. No hard run timer.
- No minimap, no compass, no objective markers — navigation is diegetic (memory skeleton,
  landmarks, sound).

# Visual references
- Scanner Sombre
- After Image: https://github.com/altaidevorg/afterimage
