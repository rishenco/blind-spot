# BLIND SPOT — Design Document

**Premise in one line:** Two players hunt each other and a hidden objective inside a pitch-black maze they can only perceive as aging point-cloud memories — every way of learning something announces something about you.

**The invariant that survives every round of this document:** players act on an incomplete, potentially stale reconstruction of reality. The game must repeatedly produce the thought: *"I know what used to be here. I must decide what is probably here now."*

Stack constraints acknowledged: TS/Vite/Three.js client, Node/ws server, 2 players, room codes, server-authoritative, ≤300k rendered points, 4–8 min matches, brutal scope.

---

# ROUND 1 — CORE EXPERIENCE

## 1.1 Design

### Core fantasy
You are not a soldier with a flashlight. You are a mind assembling a world from fragments — a sonar operator walking inside their own scope. The enemy is not a target you track; the enemy is a *hypothesis you maintain*. The fantasy is being the person who reads three stale clues correctly and puts a shot through a doorway a half-second before a body walks into it.

### The knowledge taxonomy (what the player has)
Every piece of the player's world is in exactly one of four states:

1. **KNOWN (fresh):** geometry or an enemy silhouette captured in the last few seconds. Trustworthy for walls, already decaying in trust for anything that moves.
2. **STALE:** a frozen capture. Walls stay ~true (walls don't move). An enemy ghost is a *photograph of the past* — it never updates itself. This is the signature asset of the game.
3. **UNKNOWN:** black. Never rendered. Most of the screen, most of the time.
4. **FALSE:** planted by the opponent (decoys, baits). Indistinguishable from KNOWN at the moment of capture — only cross-referencing and behavior expose it.

### The one rule everything hangs on: the Reciprocity Law
**Every emission is two-sided. There is no way to learn about the world that does not teach the world about you.**

- Your **pulse** paints geometry for you — and paints *your position and facing* for the enemy, through walls.
- Your **footsteps** move you — and drip position blips to anyone in earshot.
- Your **gunshots** can kill and can be used as improvised scans — and they flare your position brighter than any pulse.
- The **objective** helps you win — and sings your location while you hold it.

This is the anti-spam answer and the anti-"dark FPS" answer in one law (expanded in 1.1.6).

### Core loop (the 30-second unit of play)
1. **Move** through remembered geometry (choose: crouch = silent/slow, walk = quiet/normal, sprint = loud/fast).
2. **Spend a pulse** — choose *direction* (it's a cone) and *moment* (it reveals you). Read the returned photograph.
3. **Interpret** — fresh silhouette? stale ghost? footstep blips through a wall? an enemy pulse blooming two rooms over?
4. **Commit** — stalk, ambush, bait, reposition, or push the objective.
5. **Exchange** — combat is short and loud; both players come out of it *lit up*, then must go dark again and rebuild uncertainty.

The rhythm alternates between **library quiet** (information gathering, 10–30s) and **flashbulb violence** (2–8s), and the transition between the two is always caused by an information decision someone made.

### Why not "just spam the scan key" — five stacked reasons
1. **Reciprocity:** every pulse is a flare. The enemy sees a bloom at your position *through walls*, with your facing. Spamming scan = broadcasting a live tracking beacon of yourself. The question always answers back.
2. **Directionality:** the pulse is a 70° cone. Scanning the corridor ahead means NOT scanning behind you. Spam doesn't buy omniscience; it buys tunnel vision plus a beacon.
3. **Cooldown (4s):** a pacing floor, not the real defense. It exists so the point budget and the audio mix survive, not to carry the design.
4. **Tempo reads:** a player who pulses on cooldown becomes *predictable* — the enemy learns the 4-second metronome and moves between beats. Scan rhythm is itself information.
5. **No XP for noise:** progression rewards *first-paints, hits, and objective play* — never pulse count.

### Why this is not a dark FPS
In a dark FPS, light is continuous, free, and asymmetric (I can see you without you knowing). Here, perception is **discrete** (photographs, not video), **frozen** (observations never self-update), and **reciprocal** (observing announces the observer). A flashlight answers "what is there?" A pulse answers "what *was* there, and by the way, everyone now knows where *you* are." The core verb isn't "look" — it's **"trade."**

### Skill expression
- **Scan discipline:** when, where, and whether. The best players pulse *less* than beginners.
- **Sound management:** movement-mode micro-decisions every corridor.
- **Prediction:** leading a shot off a stale ghost + its motion smear ("he was walking left, 6 seconds ago, toward the rotunda…").
- **Information warfare:** bait pulses (scan, then immediately relocate so the enemy pushes your afterimage), decoy placement, exploiting the enemy's scan tempo.
- **Map memory:** the accumulated cloud is a *personal* map; players who route through remembered geometry without re-scanning move faster and quieter.
- **Aim under commitment:** shots are hitscan and honest; the hard part is the decision to fire, because firing is the loudest sentence you can say.

### Frustration vs excitement ledger
**Excitement:** the first silhouette capture; realizing a ghost is stale mid-aim; hearing a pulse bloom through a wall and knowing *exactly* what the enemy just learned; winning a fight you started with better information rather than better aim.
**Frustration risks (each gets a design answer):** dying to something never perceived (→ death always teaches, see revision); wandering blind (→ passive touch radius); stalemates where both hide (→ objective forcing function); shooting at ghosts feeling like a coin flip (→ hit confirms + tracers make every shot produce information even on a miss).

### Replayability
Same map, but the *information layout* is new every match: relic spawn varies, upgrade draft varies, and above all the opponent's habits vary. The real content is the other human's scan tempo, movement discipline, and gullibility. 4–8 minute matches with room codes make "run it back" frictionless; the roguelite draft (Round 2) makes each rematch open with a different strategic posture.

## 1.2 Critical review (attack)

1. **The hiding meta kills it.** Two informed players both know the optimal play is crouch in a corner, emit nothing, and let the other player go bankrupt on pulses. With no forcing function this game is 8 minutes of nothing. Fatal if unsolved.
2. **"Reveal on scan" might be toothless.** If being seen through a wall doesn't convert to danger (walls block bullets; by the time the enemy arrives I've moved), the reciprocity cost is theatrical and spam returns as dominant. The cost must be *actionable* by the receiver.
3. **First contact latency.** Two players on a 44×44 maze can orbit each other for minutes. Boring period detected.
4. **Shooting ghosts is a lottery.** Firing at a 10-second-old silhouette is ~always a miss; players learn that shooting without fresh info is pure waste, so fights only happen with mutual fresh info, so the staleness fantasy never actually matters in combat. This would gut the central idea.
5. **Death feels unauthored.** Getting killed by someone you never perceived is the single biggest ragequit generator this design can produce.
6. **Cloud rot.** After 4 minutes the accumulated point cloud is a uniformly dim porridge — old walls and old ghosts blur together and the player can't tell 3-second-old info from 3-minute-old info at a glance. If age isn't *legible*, "stale" isn't a mechanic, it's a bug.
7. **Close-quarters collapse.** Once both players are in the same room with fresh paints, doesn't it become a normal (bad) FPS duel for 3 seconds? Is that a betrayal of the concept?

## 1.3 Revision

1. **Forcing function → the Relic** (full spec Round 2): a hidden objective that *emits on a schedule*, dragging both players toward the same coordinates and mechanically punishing infinite stillness. Passive hiding now loses to the clock.
2. **Make reveals actionable:** an enemy pulse-flash is rendered at true map position through walls AND persists as a stale marker — so it feeds *stalking*, not just awareness. Combined with the relic forcing proximity, "he pulsed 12m north" is a playable sentence, not trivia. Additionally, gunshot blooms are bright and omni: shooting someone who has your position is genuinely fatal, so being painted right before a fight is a real disadvantage.
3. **First contact ≤ ~60s:** relic heartbeat every 20s reveals its neighborhood to both players from t=0 → both converge on the same third of the map immediately.
4. **Every shot is a scan:** tracers draw a thin line of true geometry; impacts bloom a patch of true geometry; **hit confirms** re-paint the victim's silhouette to the shooter for a beat, and the victim receives the shot's incoming direction. Shooting at a stale ghost is no longer a lottery ticket — it's a *paid question*: even a miss returns "the corridor is empty and here is its exact shape." Firing blind becomes a legitimate, priced information play.
5. **Death always teaches:** on death, the victim sees their killer's full silhouette and the killing shot's path for 2s ("death burst"). Every death converts to a lesson about what emission betrayed you. Also: respawn keeps your accumulated point cloud — death costs tempo and the relic, not your knowledge.
6. **Age must be legible → three-lifecycle rendering** (full curves in the Brief): *transient* sound info dies in seconds and vanishes; *structural* geometry cools from ice-white through blue to a dim navy "memory" state; *ghosts* hold a distinct hot-orange family that cools but never blends into architecture. Plus hard pool budgets with oldest-first eviction so porridge cannot accumulate.
7. **Close-quarters is allowed to be an FPS for 3 seconds — on purpose.** The duel is the cadence resolving; the game's identity lives in the 30 seconds before and after. What we protect: fights stay *short* (fast TTK), *loud* (both players fully lit), and *destabilizing* (post-fight, both must vanish and rebuild). The FPS moment is the punctuation mark, not the sentence.

---

# ROUND 2 — SYSTEMS & EMERGENT GAMEPLAY

## 2.1 Design

### Resolution vocabulary (used by every system below)
- **FULL** — dense posed humanoid silhouette (~600 pts), exact position/pose + 0.3s motion smear.
- **COARSE** — blob (~80 pts), position ±1m, facing wedge, no pose.
- **TRACE** — ≤20 pts, direction/existence only.

### Weapons — information tradeoffs first, damage second
Pick ONE at spawn; may switch only on respawn (weapon choice is a strategic posture, and death is the pivot point).

**THE JUDGE (hand cannon)** — *the loud truth-teller.*
- 50 dmg, 1.1s between shots, hitscan, no falloff, 5-round cylinder, 2.4s reload. TTK: 2 hits = 1.1s.
- Information signature: firing creates (a) COARSE shooter bloom, omni, through walls, 40m — you are lit; (b) a tracer line of true geometry along the bullet path, visible to BOTH players; (c) an impact bloom revealing 3m of true geometry at the hit point, visible to BOTH. The Judge is also the game's best *improvised scanner*: shoot a far wall to cheaply photograph a room you refuse to enter — at the price of telling the enemy exactly where you stand.

**THE WHISPER (needler)** — *the quiet knife.*
- 16 dmg/dart, 8.3 darts/s, 24-dart mag, 1.8s reload; damage falls to 8 beyond 14m. Realistic TTK inside 12m: ~1.2–1.8s.
- Information signature: near-silent — TRACE audible only within 6m; tracers and impact blooms render for the SHOOTER ONLY (tiny, 0.75m). The Whisper lets you fight without lighting up — but it forces you to *close distance*, which forces movement, which drips footsteps. Its cost is paid in the approach, not the trigger pull.

**Asymmetric duel logic:** Judge wants standoff geometry and pre-fight information advantage; Whisper wants silence, flanks, and the relic carrier's back. Mirror matches are also legible (Judge/Judge = artillery chess; Whisper/Whisper = knife-quiet horror).

**Considered and included as a maybe: the SPIKE (melee, silent 60 dmg lunge).** Flagged for the critique.

### Echolocation variants
- **Base pulse:** 70° cone, 28m, 4s cooldown, instant capture rendered as a 60 m/s expanding wavefront (drama + readability). Captures static geometry + FULL silhouette of an enemy in cone with line of sight.
- Enemy within 35m (through walls) receives your **pulse-flash**: COARSE position + facing wedge, then it goes stale like everything else. They do NOT learn whether your cone actually had line of sight to them — *"was I seen?"* is deliberately unanswerable at base. (An upgrade sells the answer.)
- Variants exist only as draft upgrades (Long/Wide/Over-pulse) — not as a second input. One scan key, period.

### Gadgets (everyone carries all three; no loadout screen)
1. **SENSOR SPIKE** (2 charges) — placed on any surface, arms in 1s, invisible to the enemy unless scanned (returns a tiny 8-pt glint — findable by the paranoid). One-shot tripwire: first enemy within 6m triggers a FULL silhouette + smear to the owner, through walls, silent to the victim. Spent after firing. This is territory control: it makes a corridor *cost something to walk*.
2. **DECOY SHARD** (2 charges) — thrown, sticks, after 1s emits fake *walking* footstep blips for 12s, wandering ±1.5m. If caught in an enemy pulse it returns a COARSE humanoid blob. If the enemy shoots it, it shatters — and the shooter has just gunshot-bloomed themselves for nothing (owner gets the full gunshot info + 40 XP). Misinformation with a punishment attached.
3. **ECHO BOMB** (2 charges, 25s cooldown between throws) — grenade; on landing, reveals a 10m omni sphere of true geometry + any enemy inside as FULL, to the OWNER ONLY. The detonation is loud: the enemy receives a COARSE bloom at the *bomb's* position (not yours). This is "scan a place I'm not standing" — the counter to holding an angle on the carrier's only route.
4. **DAMPER FIELD** (1 charge) — a 5m zone that absorbs pulses; scans return nothing inside. A guaranteed-unknown bubble. Flagged for the critique.

### Sound-as-information (systemic, not cosmetic)
Every audio event has a visual body in the perceived world — sound *is* rendered as points:
- Footsteps → amber blips at true position, through walls: crouch silent, walk audible 9m, sprint 18m.
- Gunshots, pulses, echo bombs, relic heartbeat → blooms as specified above, each with distinct point-splash shapes.
- Bullet impacts → geometry echo fragments (the "shoot the wall to see the room" mechanic).
Sound events are **transient**: they decay to nothing in seconds. Geometry persists; noises evaporate; ghosts freeze. Three different truths, three different lifetimes.

### Environment
One handcrafted map, 44×44m, single floor, 3m walls, no doors, no moving geometry. Three landmark set-pieces so cloud-memory has anchors: the **Rotunda** (curved wall — reads unmistakably in point cloud), the **Colonnade** (pillar rhythm — creates scan-shadow lanes), and the central **Atrium** (extraction stage, 4 entrances, waist-high cover ring). Scan shadows are level design: pillars and kinks mean one pulse never captures a whole room — geometry itself creates blind spots.

### Objective — the Relic arc (a single flag is NOT enough; a *singing* flag is)
- **Phase 1 — Hunt (0:00–~1:30):** the Relic spawns at 1 of 5 nodes, location unknown to both. Every 20s it emits a **heartbeat**: both players receive true geometry in a 6m radius around it (through walls, map-accurate) + a directional thump. The maze funnels both players toward the same coordinates → guaranteed convergence, guaranteed first contact.
- **Phase 2 — Contest:** touching the Relic picks it up. The carrier **cannot sprint** and the Relic **sings**: every 5s the opponent receives the carrier as COARSE, through walls. Carrying is voluntarily wearing a bell. The hunter becomes the hunted — the information asymmetry flips the moment you succeed.
- **Phase 3 — Extraction:** on first pickup, the Atrium beacon ignites for both players (permanent gold pillar, visible through walls — the one landmark that never decays). Carrier must channel 3.5s standing in the 2m ring; channeling emits a continuous FULL reveal of the carrier. Kill the carrier → Relic drops at the body (heartbeat resumes at 10s cadence).
- **Clock:** at 6:00, **Overdrive** — heartbeat and sing cadences halve; at 8:00 hard cap: current carrier wins; if uncarried, the next touch wins instantly ("golden relic" — findable because Overdrive is screaming). Matches cannot stall past 8:00.
- Kills never win directly; they buy tempo (4s respawn at the far spawn node, relic dropped). This keeps the duel constant but aims it at a stage.

### Progression — in-match roguelite draft
XP for *information plays*, levels gate three tiers of strategy-changing upgrades, drafted mid-match from 3 offered cards (pick with a keypress; no pause — full spec in the Brief). Losing player tends to level from hits/paints even without kills → natural comeback pressure without rubber-banding.

## 2.2 Critical review (attack + CUT)

1. **The SPIKE (melee) is a fantasy, not a mechanic.** Closing to 2.5m on an aware opponent basically never happens; on an unaware one, the Whisper already owns that niche. It's a third weapon's worth of scope for one gank per hundred matches. **CUT.**
2. **DAMPER FIELD creates non-information, which is non-interaction.** A bubble where scans fail produces the least interesting sentence in the game: "nothing." It removes decisions instead of creating them, and "my scan returned a suspicious hole" is unreadable to newcomers. **CUT.** (Cold Blood, an upgrade, delivers the "absent from scans" thrill attached to a real cost — stillness.)
3. **Gadget count vs. comprehension:** three gadgets × charges × a pulse × two movement sound tiers is already at the ceiling of what a player learns in match one. Anything more starves the core. **Freeze at exactly 3 gadgets.**
4. **Decoy might be a noob trap** — veterans will clock the wander pattern in two matches. Acceptable: its *threat* keeps working even when identified (any footstep might be fake now — the decoy poisons trust in ALL footsteps, which is the actual product). Keep, but its fake steps must use the true footstep renderer — pixel-identical.
5. **Spike as permanent area denial would warp the map** — a re-arming spike makes corridors permanently taxed and turtling viable again. The one-shot version is correct. Confirmed one-shot.
6. **Two extraction points / random extraction** was considered for variety — it dilutes the Atrium as THE stage and doubles set-piece design. One fixed extraction, always center. The relic spawn already provides layout variety.
7. **Carrier sing at 5s might be too oppressive** — carrying could feel like pure punishment, so nobody picks up until forced. Mitigation: sing is COARSE (±1m, no pose) — it says *where*, not *how to aim*; carrier retains pulse and gadgets; and the no-sprint rule is the real cost. If playtests show relic-avoidance, first lever to pull is sing interval 5s→7s, not resolution.
8. **XP-for-hits could reward spray.** The Whisper lands 7+ hits per kill vs the Judge's 2 — XP must be per-damage-second, not per-dart, or Whisper levels twice as fast. Fix in revision.
9. **Upgrade drafting mid-combat is a griefable distraction.** A modal UI in a horror-tension game is tonal vandalism. Fix: a one-line prompt, keypress 1/2/3, no pause, offer persists until spent. Never auto-picks.

## 2.3 Revision — the locked systems list

**KEPT (and final):** Judge, Whisper (2 weapons, chosen at spawn, swappable on death only). Sensor Spike (one-shot, 2×), Decoy Shard (2×), Echo Bomb (2×, 25s spacing) — exactly 3 gadgets, all carried by everyone. One pulse with draft-only variants. Relic arc with heartbeat/sing/beacon/Overdrive/golden-relic cap. One map, three landmarks, fixed central extraction. Sound-as-points with transient decay. Death burst, hit confirms, touch radius.

**CUT:** melee weapon, damper field, any 4th gadget, moving geometry/doors, multiple extraction points, loadout screens, scoreboards mid-match, any minimap or compass.

**FIXED:** XP normalized per damage (1 XP / 4 damage dealt) so weapons level evenly; upgrade draft is non-modal keypress; decoy footsteps rendered by the identical code path as real footsteps.

The final system count: **1 scan, 2 weapons, 3 gadgets, 3 movement tiers, 1 objective arc, 1 draft.** Every pair of systems intersects (e.g., Echo Bomb ↔ Atrium channel; Decoy ↔ footstep audio; Whisper ↔ carrier sing; spike ↔ relic routes), which is where the emergence lives.

---

# ROUND 3 — CREATIVE DIRECTION

## 3.1 Design

### Identity in one phrase
**"The world as afterimage."** Alternate internal motto: *seeing is a verb with a cost.*

### The 25-second legibility test (what a viewer must grasp from a clip)
Black screen. A soft *whoom* — a cone of ice-white points blossoms outward at 60 m/s, sketching a corridor. In the doorway: a burning-orange human silhouette, frozen mid-stride. The player aims at it… and holds. The silhouette has cooled to rust — it's old. The player swings 90° and fires into blank darkness; the tracer draws a hallway out of nothing and a fresh orange body lights up at its end. Viewer's takeaway, unprompted: *"you shoot memories in this game, and sometimes the memory is wrong."* Not another FPS — provably, in one clip, because the player aimed at a person-shape and *chose not to fire.*

### The Three-Color Law (total visual language)
The entire game renders in three hue families on pure black. No textures, no skybox, no lit surfaces. If a pixel is colored, it is *information*, and its hue states the information's type:
- **CYAN family = matter.** Ice-white fresh → cyan → deep navy memory. Cold, architectural, trustworthy.
- **ORANGE family = life & sound.** Hot orange fresh → amber → dull rust. Ghosts, footsteps, blooms, muzzle events. Warm things move and lie.
- **GOLD = the objective.** Relic heartbeat, carrier sing, beacon pillar. Only the win condition may be gold.
Age is temperature: everything cools. A player reads *what* (hue), *how sure* (brightness/alpha), and *how old* (temperature within the family) in a single glance, preverbal.

### Sound direction
The game is *about* sound made visible, so audio is causally honest: nothing is heard that isn't rendered, nothing rendered that isn't heard. Eight core sounds, each with a unique point-splash shape: pulse (breathy whoom), enemy pulse (same, wall-muffled), footsteps (three intensities), Judge (cannon crack + long stone reverb), Whisper (paper-tear hiss), echo bomb (glass chime burst), heartbeat (sub-bass thump felt at 20s intervals — the match's metronome), extraction channel (rising choral drone audible map-wide — the "everyone converge" siren). Baseline is near-silence with a faint room tone; the mix is empty enough that one footstep is an *event.*

### UI: almost nothing, and diegetic where possible
No minimap (the point cloud IS the map — that's the product). No compass, no killfeed, no hitmarkers-as-crosses, no enemy healthbars. HUD total: a 2px reticle dot with a thin cooldown arc, ammo pips, gadget pips, XP sliver, match clock. Health is a vignette + heartbeat audio. Upgrade draft is one line of text + three keys. The screen belongs to the dark.

### Pacing & atmosphere
Horror-adjacent tension without horror content: dread comes from *epistemic* vulnerability (what don't I know?) not gore or jumpscares. The 20s heartbeat is the tension metronome; Overdrive at 6:00 is the composed accelerando; extraction channel is the crescendo everyone can hear. Matches are structured like a song: quiet verse, violent chorus, quiet verse, gold-lit finale.

### Map architecture as memory palace
Every space answers "could you sketch it after one pulse?" — rooms are geometrically *pronounceable* (the curve, the pillars, the long straight). Corridors kink so pulses never resolve them fully. The Atrium is the stage: any spectator instantly reads "that gold pillar is where this ends."

### Signature moments (the prototype must reliably produce these)
1. **The Ghost Standoff** — both players stalking each other's stale silhouettes; both photographs are wrong; the winner is whoever *disbelieves theirs first.*
2. **Shooting the Past** — unloading into a frozen silhouette that isn't there anymore; your own tracers sketch the empty corridor — and flare your position. Punished, educated, lit.
3. **The Bait Pulse** — deliberately scanning to be heard, then relocating; the enemy pushes your afterimage and walks into the Whisper.
4. **Reading the Smear** — leading a shot into blank darkness off a ghost's motion smear and its age — and the hit confirm blooms. The single highest-skill feeling in the game.
5. **The Carrier's Gauntlet** — walking the Relic through the dark while it sings you out every 5 seconds, enemy footsteps orbiting; the 3.5s channel under a gold pillar with a fully lit silhouette. Win or die *seen.*

## 3.2 Critical review (attack)

1. **The screensaver problem.** Point clouds are gorgeous and *illegible* — after minutes of accumulation the frame is ambient art, not a game state. Beauty that costs readability is a failure here.
2. **Streaming/compression reality:** dim navy memory-points at 15–20% alpha will be *eaten alive* by video compression and cheap laptop panels. If the clip-goer can't see the memory layer, the whole "old vs new" story dies in the marketing medium the game depends on.
3. **First-match confusion:** a new player spawns into literal blackness with an unexplained key. 30 seconds of flailing = closed tab. The aesthetic forbids tutorial popups.
4. **Colorblind hazard:** orange/gold separation fails for some players; orange/cyan is safe, but the objective must not depend on hue alone.
5. **Motion sickness / eye strain:** full-screen darkness with high-contrast sparkle and an expanding wavefront is a vestibular gamble; point shimmer at 60fps can be miserable.
6. **Death-cam tone:** the death burst (seeing your killer) is pedagogically right but risks reading as a generic killcam, breaking the diegesis.

## 3.3 Revision

1. **Readability is enforced by budget, not restraint:** hard pool caps + oldest-first eviction (Brief §Visual) mean the frame *cannot* accumulate porridge; memory-state points are also rendered smaller (1.5px), so freshness dominates the frame compositionally, always.
2. **Raise the floor:** memory-state alpha floor is 0.22 (not 0.10) and the navy is value-brightened; verify on a 6-bit panel and a 1500kbps stream capture during development. The dim layer must survive YouTube.
3. **Diegetic onboarding:** each spawn alcove is *pre-revealed* in cool cyan with the three verbs stenciled as point-glyphs on its walls (RMB PULSE / SHIFT LOUD / CTRL SILENT — rendered as point-cloud lettering, in-fiction). First pulse is free of the flash cost while standing in the spawn alcove — the alcove is the tutorial.
4. **Objective redundancy:** gold events also carry unique *shape and rhythm* (the beacon is the only vertical column; heartbeat points shimmer at 2Hz; the relic thump is sub-bass) — hue-independent identification everywhere.
5. **Comfort passes:** wavefront is an alpha ramp, not a strobe; point shimmer capped (no per-frame flicker; age transitions ease over seconds); FOV stable; an accessibility toggle for "steady points" ships in the prototype settings.
6. **Death burst stays in-language:** the killer's silhouette renders as points in signal orange with the tracer line, on the same black — no camera cut, no slow-mo, no UI frame. It's a final photograph, not a killcam.

---
---

# PROTOTYPE DESIGN BRIEF

*Everything below is final. Where a choice existed, it has been made.*

## Core loop

Repeat unit (~30s), from either player's seat:
- **0–5s:** choose movement tier, advance through remembered (navy) geometry toward the current gold clue (relic neighborhood or beacon).
- **~5s:** spend a pulse on the riskiest unknown (usually the direction you must cross next). Read the photograph: fresh cyan walls, maybe an orange body.
- **5–15s:** act on it — stalk a blip, place a spike behind you, throw a decoy ahead, or hold still through the enemy's expected scan beat.
- **15–25s:** an information event forces a decision — their pulse blooms through a wall / footsteps patter / heartbeat thumps. Commit: ambush, bait, push, or relocate.
- **25–30s:** exchange or evade (2–8s, loud, both lit) → disengage into dark → regen window → rebuild uncertainty.
Match macro-rhythm: Hunt (0:00–~1:30) → Contest cycles (~1:30–6:00) → Overdrive endgame (6:00–8:00 hard cap).

## Information model

**Perception firewall (architecture rule):** the client maintains two strictly separate stores. **SIM state** (own transform, HP, cooldowns, static map collision) and **PERCEIVED state** (an append-only log of information events + the point pools derived from them). The renderer reads PERCEIVED only. The server never transmits enemy transform/pose/HP except embedded inside a legitimate information event payload. The static map mesh IS shipped to the client (needed for local point generation and prediction) — the secret is never the walls; the secret is the enemy and the relic. Reveal events for entities carry a server-stamped snapshot: `{pos, yaw, stance, velocity, timestamp, resolution}`; the client renders posed humanoid point-sprites from it. Geometry reveals carry only the emitter params (origin, cone/sphere, range, seed); the client raycasts its local mesh to generate points — cheap, deterministic, bandwidth-trivial.

**Resolutions:** FULL = posed silhouette ~600 pts + 0.3s motion smear. COARSE = ~80-pt blob, ±1m, facing wedge. TRACE = ≤20 pts, direction only.

**What is never visible:** anything not delivered by an event. No ambient light, no outlines, no shadows, no minimap. Enemy ghosts NEVER self-update — they freeze at capture and only a new event replaces them.

**Staleness clocks:** structural points cool over 30s to a permanent dim memory state (evicted only by pool pressure). Entity ghosts cool over 10s to a rust hold-state and persist until replaced. Transient (sound) points die completely in 2.5–6s. Exact curves in §Visual model.

### The complete enumerated information events

| # | Event | Trigger | Reveals (to whom) | Resolution | Range | Cost / risk to emitter |
|---|-------|---------|-------------------|------------|-------|------------------------|
| 1 | Pulse capture | Player presses scan (4s CD) | Static geometry + enemy in cone w/ LOS (to scanner) | Geometry + FULL | 70° cone, 28m | Emits event #2; cone tunnel-vision; tempo read |
| 2 | Pulse flash | Enemy pulse fires within 35m | Scanner's position + facing wedge, through walls (to non-scanner) | COARSE | 35m | — (this IS the cost of #1) |
| 3 | Footsteps | Moving at walk/sprint | Mover's position blip, through walls (to enemy in radius) | TRACE (walk) / COARSE (sprint) | walk 9m / sprint 18m / crouch 0m | Continuous drip while moving |
| 4 | Gunshot bloom | Judge fires | Shooter position, omni, through walls (to enemy) | COARSE | 40m | The loudest voluntary emission |
| 5 | Whisper hiss | Whisper fires | Shooter direction (to enemy) | TRACE | 6m | Near-silent; the weapon's whole premise |
| 6 | Tracer | Any shot travels | True geometry line along path — Judge: BOTH players; Whisper: shooter only | Geometry (~200 pts) | full path | Draws a line pointing back at the shooter (Judge) |
| 7 | Impact bloom | Bullet hits world | True geometry sphere at impact — Judge 3m to BOTH; Whisper 0.75m shooter-only | Geometry | at impact | Judge: gifts the enemy the same wall you scanned |
| 8 | Hit confirm | Bullet hits enemy | Victim silhouette refresh 0.5s (to shooter); incoming-shot direction wedge (to victim) | FULL (to shooter) / TRACE (to victim) | — | Confirms your firing line to the victim |
| 9 | Touch radius | Always on | Static geometry within 2.5m (self only), faint | Geometry | 2.5m | None — anti-frustration floor |
| 10 | Relic heartbeat | Every 20s (10s once dropped-after-carry; halved in Overdrive) | Geometry 6m around relic, map-accurate through walls (BOTH) + directional thump | Geometry | map-wide audio, 6m reveal | None — the forcing function |
| 11 | Carrier sing | Every 5s while carried (2.5s in Overdrive) | Carrier position, through walls (to opponent) | COARSE | map-wide | The price of holding the win condition |
| 12 | Extraction beacon | First relic pickup, permanent | Gold pillar at Atrium, through walls (BOTH) | Landmark | map-wide | Tells the defender exactly where to be |
| 13 | Channel glow | Carrier channels extraction (3.5s) | Carrier, continuous (to opponent) | FULL | map-wide | Maximum exposure at maximum stakes |
| 14 | Sensor spike | Enemy enters 6m of armed spike | Trespasser + smear, through walls (to owner); silent to victim | FULL | 6m trigger | One-shot; scannable 8-pt glint betrays it |
| 15 | Decoy footsteps | 1s after decoy lands, 12s duration | Fake walk-blips at decoy, wandering ±1.5m (to enemy in 9m) | TRACE (identical renderer to #3) | 9m | Enemy who shoots it self-blooms; owner +40 XP |
| 16 | Decoy scan return | Enemy pulse hits decoy | Fake humanoid blob (to the scanner — misinformation) | COARSE | as pulse | — |
| 17 | Echo bomb | Grenade lands | Geometry 10m omni + any enemy inside (to OWNER only); bomb-position bloom (to enemy, 30m) | Geometry + FULL / COARSE | 10m / 30m | Enemy learns where you're *looking* |
| 18 | Death burst | A player dies | Killer silhouette + killing tracer, 2s (to victim); death position marker (to killer) | FULL | — | None — every death must teach |

This table is exhaustive. If it's not on this list, it does not create points on anyone's screen.

## Combat model

100 HP. Regen 10 HP/s starting 8s after last damage taken (creates the disengage-and-rehide rhythm). Hitscan, server-side rays, no headshot multiplier (you aim at silhouettes, not heads).

| | THE JUDGE | THE WHISPER |
|---|---|---|
| Damage | 50 | 16 (falls to 8 past 14m) |
| Fire interval | 1.1s | 0.12s (8.3/s) |
| Magazine / reload | 5 / 2.4s | 24 / 1.8s |
| TTK (realistic) | 2 hits = 1.1s | ~7 hits ≈ 1.2–1.8s inside 12m |
| Spread | none | 1.5° cone |
| Info signature | Bloom COARSE omni 40m; tracer + 3m impact reveal to BOTH | TRACE 6m; tracer + 0.75m impact to shooter only |
| Identity | Loud truth-teller; doubles as a paid scanner | Silent closer; pays its cost in approach noise |

Chosen at spawn; switchable only on respawn. No pickups, no ammo scarcity (reload is the only ammo pressure — ammo here is a *noise* economy, not a logistics one).

## Utility model

All players carry all three. No loadout screen.

| Gadget | Charges | Spacing | Exact behavior |
|---|---|---|---|
| Sensor Spike | 2 | none | Place on surface (3m placement reach). Arms in 1s. First enemy within 6m → event #14, then spent. Enemy pulses render it as an 8-pt glint. Destroyed by 1 damage. |
| Decoy Shard | 2 | none | Thrown (12 m/s arc), sticks on landing. After 1s: 12s of fake walk footsteps (events #15/#16). Shattered by 1 damage → owner gets shooter's gunshot info + 40 XP. |
| Echo Bomb | 2 | 25s between throws | Thrown (14 m/s arc). On landing: event #17. No damage. |

## Progression model (in-match roguelite draft)

**XP sources:** first-paint of enemy via FULL reveal you caused (pulse/spike/echo bomb) = 25, lockout 15s per source; damage dealt = 1 XP per 4 dmg; kill = 100; relic pickup = 60; enemy damages your decoy = 40.
**Levels:** L2 = 100 XP → draft from Tier 1. L3 = 250 → Tier 2. L4 = 450 → Tier 3. On level: 3 of the tier's 4 cards offered (server-random), one line of HUD text, pick with 1/2/3 anytime, no pause, offer persists until spent.

**Tier 1 — perception stance (L2):**
1. **LONG LENS** — pulse becomes 35° / 45m. (Sniper's eye; hallway specialist.)
2. **WIDE LENS** — pulse becomes 110° / 18m. (Room-clearer; close-range security.)
3. **SOFT STEP** — walking emits no footsteps (sprint unchanged). (Changes your default gait forever.)
4. **KEEN EAR** — you receive footstep events at 2× radius (walk 18m, sprint 36m). (Turtle-and-listen becomes a real posture.)

**Tier 2 — counter-intelligence (L3):**
5. **RETORT** — an enemy pulse that captures you returns their FULL silhouette to you (instead of the COARSE flash). (Being scanned becomes a trade you can want.)
6. **COLD BLOOD** — while crouched AND stationary, enemy pulses do not capture you. (You can now *choose* to be a hole in their photograph — at the price of stillness.)
7. **TREMOR SENSE** — a sprinting enemy within 12m auto-reveals as TRACE each step. (Punishes panic sprints; you feel charges coming.)
8. **PHANTOM SHARD** — decoys return FULL fake silhouettes to pulses, and their fake steps read as sprint. (Your lies get expensive to disbelieve.)

**Tier 3 — power plays (L4):**
9. **OVERPULSE** — pulse becomes 360° / 20m, cooldown 8s. (Trades tempo for omniscience bursts.)
10. **GHOST ROUNDS** — your tracers and impact blooms are invisible to the enemy (Judge keeps its shooter bloom; Whisper becomes fully dark). (Missing no longer teaches them.)
11. **EXTRAPOLATOR** — enemy ghosts display a 1.5s dotted predicted path from captured velocity. (The game does your leading math; you choose whether to trust it.)
12. **DEAD SONG** — while you carry the relic: sing drops to TRACE and interval becomes 8s. (Makes the carry-first strategy viable; the objective build.)

Every card changes *what you do*, not a damage number. No card stacks with itself; L2/L3/L4 gives each player at most 3 cards per match.

## Objective model

- 0:00 — Relic spawns at 1 of 5 fixed nodes (server random). Heartbeat every 20s (event #10) from t=0.
- Pickup on touch. Carrier: no sprint, sings every 5s (event #11). Extraction beacon ignites permanently on first pickup (event #12).
- Extraction: stand in the Atrium 2m ring, channel 3.5s stationary (moving cancels; damage does not; death obviously does). Completion = **match win**.
- Death drops the Relic at the corpse; its heartbeat resumes at 10s cadence. Killer respawn tax: victim respawns after 4s at the spawn node farthest from the enemy, keeps their entire perceived cloud and XP, may switch weapon.
- 6:00 — **Overdrive:** heartbeat every 10s (5s if dropped), sing every 2.5s, heartbeat reveal radius 6m→12m.
- 8:00 — hard cap: current carrier wins; if the Relic is uncarried, the next player to touch it wins instantly. No draws, no sudden-death limbo.

## Visual model

**Baseline:** pure black clear color. No ambient, no fog rendering, no skybox. Player self-render: faint gray-blue body/hands points, α 0.20.

**Point pools (hard caps, oldest-first eviction, 0.15m voxel dedup for structural):**
- Structural pool: **240,000** pts (a full pulse contributes ≤22,000).
- Transient pool: **30,000** pts (footstep splashes ~20 pts each, blooms 80–400, tracers ~200).
- Entity pool: **8,000** pts (ghost sprites 600, smears, death burst).
- Touch-radius rolling buffer: **8,000** pts.
- Total worst case **286,000** — under the 300k ceiling with headroom. GPU: single THREE.Points buffer per pool, per-point attributes `{birthTime, typeId}`; aging computed in the vertex shader from uniforms (no per-frame CPU touch), eviction = ring-buffer overwrite.

**Aging curves (authoritative):**
- *Structural:* spawn 3.0px, #CFF6FF, α 1.0 → ease over 0–4s to #4FA8D8, α 0.55, 2.0px → ease 4–30s to #1B3A66, α 0.22, 1.5px → hold ("memory") until evicted.
- *Entity ghost:* spawn #FF5A2D, α 1.0, with 0.3s motion-smear trail → cool 0–10s to #B0401F, α 0.60 → hold at #6E2A18, α 0.35 *forever* until replaced by a newer capture of that entity. Never blends with architecture hues.
- *Transient (sound):* spawn #FFB347, α 0.9, 4px → linear to α 0, 1px over 4s (footstep blips: 2.5s). Then gone completely.
- *Gold (objective):* #FFD34D, α 0.9, shimmer 2Hz; heartbeat reveals age like structural but in gold family; beacon pillar never decays.

**Scan propagation:** capture is instantaneous server-side; render reveals points in an expanding shell at 60 m/s (full 28m cone ≈ 0.47s) with an alpha ramp (no strobe). Pulse-flash (event #2) renders as a brief expanding arc of ~120 amber points at the scanner's true position.

**Dynamic objects:** the only dynamic renderables are the two player silhouettes (posed point-sprite humanoids from snapshot `{pos,yaw,stance,velocity}`), the relic (gold cluster), gadgets (tiny clusters), and projectile tracers. Everything else is static geometry.

**Comfort:** no per-frame point flicker; all state transitions ease ≥1s; "steady points" accessibility toggle disables shimmer.

## Signature moments (acceptance criteria — the prototype must produce all five)

1. **The Ghost Standoff** — both players maneuvering on mutually stale silhouettes; produced by ghost persistence + pulse reciprocity making refresh expensive.
2. **Shooting the Past** — firing on a stale ghost, tracers sketching an empty corridor, position flared; produced by events #6/#7 + Judge bloom.
3. **The Bait Pulse** — pulse, relocate, punish the push; produced by event #2's persistence as a stale stalkable marker.
4. **Reading the Smear** — a led shot into darkness off smear + age, confirmed by event #8; produced by motion smear on ghosts + hit confirm.
5. **The Carrier's Gauntlet** — the sung carry and the fully-lit 3.5s channel; produced by events #11/#12/#13.

## Scope

**MUST HAVE (the prototype IS this list):**
- Rooms via codes; 2 players; server-authoritative sim (20Hz tick); perception firewall exactly as specified.
- One handcrafted 44×44m map (Rotunda, Colonnade, Atrium, 5 relic nodes, 4 spawn nodes, spawn-alcove point-glyph tutorial).
- Pulse + full event table #1–#18; point pools with aging shaders and eviction.
- Three movement tiers with footstep events; touch radius.
- Both weapons; all three gadgets; hit confirm; death burst; regen.
- Full Relic arc: heartbeat → pickup/sing → beacon → channel → Overdrive → 8:00 golden-relic cap.
- XP + Level 2 + all four Tier-1 upgrades; non-modal draft UI.
- The 8 core sounds; three-color rendering with the exact aging curves; minimal HUD (reticle+arc, pips, clock, XP sliver); end screen with rematch button (same room, one keypress).

**OPTIONAL (only after MUST is playtested):**
- Tier 2 and Tier 3 upgrades (design is final above; ship when stable).
- Dual-perception replay/spectate (side-by-side of both players' perceived worlds — the killer marketing tool).
- Second map; additional relic nodes; controller support; settings beyond the comfort toggle; cosmetic point palettes; positional audio occlusion beyond simple distance-muffle; persistent cross-match stats.

## Numbers table (paste into shared/config)

| Constant | Value |
|---|---|
| Match hard cap | 480 s (Overdrive at 360 s) |
| Server tick | 20 Hz |
| Player HP / regen | 100 / 10 HP·s after 8 s no damage |
| Speed: crouch / walk / sprint / carrier max | 1.6 / 3.2 / 5.0 / 3.2 m·s |
| Footstep audibility: crouch / walk / sprint | 0 / 9 / 18 m |
| Footstep cadence: walk / sprint | 0.45 / 0.35 s |
| Pulse: cone / range / cooldown / render speed | 70° / 28 m / 4 s / 60 m·s |
| Pulse flash audibility (event #2) | 35 m |
| Judge: dmg / interval / mag / reload / bloom range / impact reveal | 50 / 1.1 s / 5 / 2.4 s / 40 m / 3 m |
| Whisper: dmg / falloff / interval / mag / reload / audible / impact reveal | 16 (8 past 14 m) / 0.12 s / 24 / 1.8 s / 6 m / 0.75 m |
| Whisper spread | 1.5° |
| Hit confirm: refresh to shooter / wedge to victim | 0.5 s FULL / TRACE |
| Touch radius | 2.5 m |
| Spike: charges / arm time / trigger radius / placement reach | 2 / 1 s / 6 m / 3 m |
| Decoy: charges / delay / duration / wander / audibility | 2 / 1 s / 12 s / ±1.5 m / 9 m |
| Echo bomb: charges / spacing / reveal radius / enemy-bloom audibility / throw speed | 2 / 25 s / 10 m / 30 m / 14 m·s |
| Decoy-shattered XP / first-paint XP (lockout) / damage XP / kill XP / pickup XP | 40 / 25 (15 s) / 1 per 4 dmg / 100 / 60 |
| Level thresholds L2 / L3 / L4 | 100 / 250 / 450 XP |
| Relic heartbeat: base / after-drop / Overdrive / reveal radius (OD) | 20 s / 10 s / halved / 6 m (12 m) |
| Carrier sing: base / Overdrive / resolution | 5 s / 2.5 s / COARSE |
| Extraction: channel / ring radius | 3.5 s / 2 m |
| Respawn delay | 4 s |
| Death burst duration | 2 s |
| Ghost: FULL pts / smear window / cool time / hold α | 600 / 0.3 s / 10 s / 0.35 |
| COARSE pts / TRACE pts | 80 / ≤20 |
| Structural aging: fresh→cool / cool→memory / memory α / sizes | 4 s / 30 s / 0.22 / 3.0→2.0→1.5 px |
| Transient lifetime: blooms / footsteps | 4 / 2.5 s |
| Pools: structural / transient / entity / touch | 240k / 30k / 8k / 8k pts |
| Per-pulse point cap / voxel dedup | 22k / 0.15 m |
| Map / walls / doorways | 44×44 m / 3 m / 1.2 m |
| Relic nodes / spawn nodes / extraction | 5 / 4 / Atrium center, fixed |
| Upgrades: Long Lens / Wide Lens / Overpulse | 35°·45 m / 110°·18 m / 360°·20 m·8 s CD |
| Keen Ear ×2 / Tremor Sense / Cold Blood condition | 18·36 m / 12 m / crouched+stationary |
| Dead Song: resolution / interval | TRACE / 8 s |
| Colors: fresh matter / cool / memory | #CFF6FF / #4FA8D8 / #1B3A66 |
| Colors: fresh life / cooled / hold | #FF5A2D / #B0401F / #6E2A18 |
| Colors: sound / objective | #FFB347 / #FFD34D |

---

*Final word: the prototype succeeds when a playtester, aiming dead-center at a humanoid silhouette, lowers the gun and says "…that's old." Everything in this document exists to manufacture that sentence.*
