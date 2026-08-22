# BLIND SPOT — Review of Your v2 Spec

*Lead designer, 2026-08-22. Your reformalization is the new baseline — I am not re-pitching Proposal v1. This document does four jobs: names two things your rules already solve, specs the one system v2 leaves undefined, answers your seven problems with mechanisms and first-pass numbers, and lists what still has no spec. It is written to be argued with. Tags as before: [EVIDENCE] / [V1] / [JUDGMENT] / [YOUR CALL].*

---

## 0. Verdict on v2

The reformalization is a real sharpening. "Fast, responsive movement through a world you only partially understand; mastery is navigating efficiently and predicting routes from enemy movement" is a better core fantasy than v1's extraction-horror framing: it is one sentence, it is a skill claim, and no shipped game owns it. The two strongest ideas in v2 are ones you may not have noticed you invented (§1). The riskiest line in v2 is five words long: "what consumes energy: movement" (§4f). And the single biggest missing piece is that "all sounds generate a map" is stated but not specified — that model is load-bearing for everything else, so I spec it first (§2).

## 1. Two convergences worth naming — your rules already contain them

**1a. Gait is the perception dial.** If *all* sound paints the map, then your own footsteps are a passive sonar. Sprint = loud = paints a wide halo around you every footfall = you see well at speed — and every dog in earshot sees *you*. Crouch = near-silent = near-blind. Walk sits between. This one consequence quietly solves three standing problems at once: the genre's scan-fatigue complaint (no trigger to hold — moving *is* scanning) [EVIDENCE: "hold the trigger for 80 minutes" is the corpus's loudest review], the parkour-readability requirement that the floor is never dark at legal speed (faster = brighter, mechanically coupled, no artificial timer) [C4], and the Reciprocity Law, now fully diegetic: the exact thing that lets you see is the exact thing that betrays you [V1]. Manual pings stop being life support and become punctuation — long-range questions and deliberate bait. I propose we adopt this as the system's spine.

**1b. You don't fight dogs — you spend them.** A kamikaze detonation is the loudest event in the game. Under sound-paints rules, every explosion is therefore a *flashbulb*: it maps a huge sphere of geometry, through floors. So the dog is a walking, hostile resource: bait it with a ping, juke the telegraphed lunge, and choose *where* it detonates — spending its one life to buy a chunk of map and a repositioned threat field (the blast summons neighbors — §4d). Your own note — "a dog crashing through something inadvertently reveals geometry" — is this idea; it generalizes. Dogs are also *lanterns*: their patrol sounds paint faint geometry around them as they move, so the enemy is literally your light source, and tracking it by ear is both threat-reading and map-building. This is the combat answer (§3, P2).

## 2. The missing load-bearing spec: the sound-painting model

**2.1 The rule.** Every sound event is a paint source: it reveals geometry within a radius of its *origin* (the robot's audio system reconstructs surfaces from any sound, not just its own pings). Density scales with intensity — your "intensity → density" line, kept. Falloff is quadratic. You perceive a sound event (and its paint) only if it is within *your* hearing range.

**2.2 Two layers — reconciling "color by source" with the Three-Color Law.** If painted *geometry* took the color of whatever sound painted it, the map would become a confetti quilt and age/trust would be unreadable — your own "visuals confusing" fear, self-inflicted. So: **matter is always cyan-family, whoever painted it** (age = temperature, fresh ice-white → navy memory skeleton, v1's tuned curves [V1]). Source color lives on the **event layer**: a transient marker at the sound's origin, dying in 2.5–6s [V1]. Proposed semantics: self = amber; teammates = green (plus steady pip — never hue alone [EVIDENCE: colorblind guidelines]); dogs = red-orange, jagged, smeared; neutral props = pale yellow; objective = gold only; detonation = white flash. Your "different sources → different colors of blip" survives intact — one layer down.

**2.3 Event classes — first-pass numbers.** Format: paint radius at origin / audible-to-dogs range.

| Event | Paint | Dogs hear |
|---|---|---|
| Crouch step | 1.5m | 2m |
| Walk step | 4m | 11m |
| Sprint step | 7m | 24m |
| Landing (>2m drop) | 8–14m | 28m |
| Slide | 5m continuous | 16m |
| Prop knock (can, chain, glass) | 8–12m | 25m |
| Q ping (360°, LOS) | 12m | 18m |
| E ping (25° cone, LOS) | 40m | 30m — **at both ends of the beam** |
| Dog patrol / investigate / chase gait | 2 / 4 / 8m around the dog | — |
| Detonation | 22m omni, **through floors** | 60m |
| Carried cell hum (2s pulse) | 2m self-halo | 12m |

The E-ping being audible at its far end matters: pinging a distant room *wakes that room*. That makes E the deliberate bait tool, not a free telescope [V1: the Bait Pulse, reborn].

**2.4 Propagation.** Line-of-hearing, cheap version: direct path = full values; through one wall = radius −60%, position fuzz ±2m, dimmer paint; more than one wall = inaudible. **Floors are special:** only the loud class (landings, howls, detonations, lift machinery) bleeds through, rendering as a dim moving patch on your floor/ceiling. That patch is the vertical game (§3, P3): you track the dog below through the grate under your feet. Player hearing: base 18m; Sensitivity chip +8m.

**2.5 One flag on your word "permanently."** Scans permanently building the map is right in spirit — but full-detail permanence is the documented tension-killer [EVIDENCE: Scanner Sombre's permanent cloud forced scripted scares to carry the game] and a point-budget explosion [V1: hard pools]. Proposal: the **skeleton is permanent, detail decays** — geometry cools to the dim navy memory state and never vanishes (you always keep the map; you lose only the fine read) [V1: alpha floor 0.22, tuned]. You keep "permanent map"; the game keeps its tension. [YOUR CALL if you truly want full-detail permanence — I'd want the gate test to prove me wrong.]

## 3. Your seven problems, answered

**P1 — Core loop.** Your constraints: not collect-junk-sell-buy, objectives push *deeper*, optional rewards create risk appetite, must fit precision movement. Proposal — the **Descent Contract**: a facility of 5 stacked industrial floors (plus 2 optional deeper ones), ship docked topside. The objective — **power cells** (count = player count, min 1) — sits at marked depth, floor 5. *Down is the compass*: no clue system needed, architecture itself is the monotone narrowing [replaces v1's resonator grammar with zero systems]. Cells are small and never slow you — hauling-encumbrance is exactly how LC/R.E.P.O. kill movement, so we refuse it — but a carried cell *hums* (audible 12m, 2s pulse): the return trip is hot. The loop's shape: **buy the map going down, spend it coming up.** Outbound = stealth, routing, cache raids; return = the payoff sprint through geometry you now own, dogs converging on the hum. Optional risk: side-vaults on every floor hold equipable chips behind sound-trap fields; floors 6–7 hold the rare ones. Risk is paid in noise and rewarded in **route**: unlockable freight lifts and drop-chutes (loud 20–30s to open) that shorten the return. No shop, no currency — "pay in noise, get paid in route." Extraction: cells + living players aboard, hold 5s, gold horn. Cells bank individually — partial credit on a bad run [EVIDENCE: Hunt's losing-team payout]. Session 15–25 min.

**P2 — Combat: should it be there?** **No guns.** Your own clarification already decided this — dogs are "a routing/prediction threat, not targets" — and every working flow game agrees: combat must be a movement problem or it competes with movement for mastery [EVIDENCE: Neon White, Ghostrunner — defense is footwork]. The verb set: *read* (track by ear), *avoid*, *bait* (E-ping a place you aren't), *juke* (dodge the telegraphed lunge), *spend* (choose the detonation's location — §1b). One safety-valve verb if tests show helplessness: a **Shove** (12 energy, staggers a lunging dog 1s, very loud). Kill-signal for the no-gun call: playtesters cornered with no counterplay in ≥1 encounter per run → add Shove; guns re-enter only if the routing fantasy itself fails.

**P3 — Vertical gameplay.** Verticality is where a sound-game beats a light-game: information crosses floors before bodies do. Three mechanisms: (1) **through-floor paint** (§2.4) — the dim patch of the dog below is 3D information, not 3D geometry; (2) **vertical asymmetry** — descending is fast and loud (drops paint big and ring out), ascending is slow and quiet (ladders, 2.5 m/s, silent) — so diving deep is easy and coming home is the commitment, which the unlockable lifts/chutes then relieve (the reward loop lands here); (3) **traversal asymmetry** — dogs use stairs and ramps but cannot climb ladders or mantle above 1.2m [JUDGMENT — sharpening your "roughly the same spaces": without a relief valve, routing mastery has no expression]. High routes = safe but slow; floor routes = fast but patrolled. That is the whole vertical game and none of it needs destruction.

**P4 — Blips at long range.** Renderer law, three parts: (1) distance-stratified detail — full splat density only within ~20m; beyond that render the memory-skeleton representation regardless of age; (2) a screen-space density cap — max ~6 points per 16px cell beyond 20m, evict oldest, keep edges [V1: surface splatting already sizes far points to grain]; (3) the **E-ping returns edges, not fog** — long-range captures render as sparse silhouette lines (the dots-are-matter / lines-are-structure law applied to range). Distant space reads as a drawing, near space as a cloud. This is buildable and testable in Stage A.

**P5 — Overall visuals.** The v1 legibility laws port whole and are non-negotiable [V1, all playtested in-browser]: hard pool budgets with oldest-first eviction (porridge cannot accumulate); tangential jitter; depth encoded only inside the cyan band; age = temperature; splats ≥2–3px, temporally stable [C6 — streams eat per-frame noise]; the two-layer color model (§2.2); per-floor palette accent + one large-silhouette landmark per floor ("the room with the double stalactite" rule) [EVIDENCE: CANARI; LiDAR Exploration Program]; floors sized 30–40% smaller than paper-right [EVIDENCE: dark reads bigger].

**P6 — Parkour's purpose.** The Finals earns parkour with destruction and map chaos; we earn it with *knowledge*: **map quality is the speed limit.** Outbound, you can only move as fast as your paint; return, you sprint full-tilt through geometry you built, threading predicted patrols — flow as the payoff of information, not a toy next to it. Parkour is also the counterplay layer (P3's high routes) and the juke layer (lunges are dodged, not tanked). So it has three jobs, none decorative. Map complexity stays modest — difficulty lives in the information state, not maze-ness [C5] — which answers your worry that Finals-like complexity would fight navigation.

**P7 — Roguelite-ness.** Thin at first, by design [EVIDENCE: roguelike depth is retention, not acquisition — don't build it before the loop is proven]. Runs: floors assembled from an authored room library with randomized dog patrols, cache and cell placement, trap arming [EVIDENCE: DRG abandoned free-form procgen]. In-run: found **chips**, equipped on the spot (§6 — slots and wattage). Between runs: meta unlocks are *new options, never raw stats* — new chip types entering the pool, new ping modes, new movement verbs [EVIDENCE: stat-tree meta measurably rots roguelites; your listed upgrades live in-run, where stat boosts are fine — see §4g]. Death: banked cells and meta XP persist; the run's unequipped haul does not.

## 4. Inconsistencies in the v2 spec

**(a) "Directed by default" vs Q being 360°.** Just a naming slip. Proposal: E (directed, 40m) is the *primary* — the question-asker; Q (360°, 12m) is the *room-read* — the panic button. Costs 18 / 10 energy respectively.

**(b) Everything-manual sonar vs scan-fatigue evidence.** Would be a real violation of C3's spirit — except §1a dissolves it: footstep-paint is the always-on layer, so manual-only pings are now fine. C3's letter is formally renegotiated (§7). The Milestone-Zero gauntlet must verify it: can a player run an unfamiliar route lit only by their own footfalls plus memory skeleton?

**(c) If all sound paints, can a dog ever surprise you?** Yes — through the mode-loudness table (§2.3) and one rule that falls out of your own system: **a stationary, silent dog is invisible to sound.** Patrol gait is quiet (heard 8m direct, ~4m through a wall, fuzzed). And when a dog stops to listen, it vanishes from your map, leaving only its cooling ghost. The same rule that hides you (crouch-still) hides it. "It stopped moving" becomes the scariest sentence in the game — consistent, no cheating.

**(d) Kamikaze = single-use dogs vs a dead return trip.** Verified as v2's biggest boredom hole; three fixes, all sourced (no-fake contract intact): (1) **detonations summon** — each blast pulls 1–2 dogs from adjacent floors, arriving via audible dispatch hatches (8s, telegraphed): your outbound spending seeds your return threat; (2) **per-floor Heat 0–3** — loud events raise it, each step dispatches one extra patrol, decays after ~2 min of quiet: the facility remembers your noise, so a loud descent buys a hot ascent; (3) the cell hum makes carriers specifically findable. Net effect: the return trip's difficulty is a mirror of how you played the outbound. That *is* the mastery loop.

**(e) Knockable-props noise vs your rejection of LC/R.E.P.O. slapstick.** Compatible if props are *authored sound-traps, not physics clutter*: sparse, deliberate placements — glass fields, chain curtains, stacked cans — at chokepoints, with crisp single audio signatures [EVIDENCE: Hunt's crows]. They are read-and-route puzzles (crouch through, go around), not comedy piles. This also gives blind movement its real price: crossing unpainted space risks traps you never saw. No ragdoll comedy anywhere.

**(f) "Movement consumes energy" vs "good movement should stay genuinely good."** The direct contradiction in v2, and I recommend resolving it by **cutting movement's energy cost entirely** [JUDGMENT, but firm]. Movement already pays the better currency — noise (§1a): sprint feeds every dog in 24m and lights you up. Charging energy on top double-taxes the core fantasy and turns flow into rationing; the reference games meter no base movement, and Crysis itself walked sprint-drain back release by release until it was gone [EVIDENCE: Crysis 2→3]. Reactor energy then gates only deliberate acts: pings, Shove, boost-verbs, chip wattage. If you want an energy-movement link, put it at the top end only: an optional boost-dash chip that drinks 22 per use — never the base run.

**(g) Your upgrade list is raw stats vs the verbs evidence.** Split it by scope and both truths hold: *in-run* chips may be stats (Sensitivity +8m hearing, Ping Power +50% E-range, Reactor +2/s regen) — run-scoped boosts are the Hades shape and feel great; the *meta* layer must sell verbs and options, not percentages [EVIDENCE]. "Better movement - ?" becomes verb-chips: Damped Soles (silent landings), Mag Grips (fast ladder work), Long Slide. See §6 for the slot model, which also redeems your original "everything draws from one engine" fantasy: chips reserve reactor capacity, so loadout *is* the energy-allocation game — discrete, no sliders [EVIDENCE: Barotrauma's solved-then-automated trap].

**(h) "Labyrinth-like" vs "intuitive."** Fine if labyrinth-ness lives in *route choice* (three ways down every floor, different noise/speed prices) and never in disorientation (C5 laws, P5's landmarks). A maze you can't read is a quit generator [EVIDENCE: Perception, MC 56].

## 5. Dropped v1 pieces that leave specific holes

Only the ones with evidence attached, each restated in v2's terms:

1. **The self-readout meter.** With gait as the perception dial, the player *must* know how loud they currently are — this was Muffled Warfare's #1 gameplay complaint ("can't tell when I'm visible") [EVIDENCE]. Restore: a reticle ring whose brightness = your current audible radius, with a pitch component [EVIDENCE: Thief's gem; Chaos Theory's sound meter]. Cheap, mandatory.
2. **Ghosts for dogs.** v2 says predict routes from enemy movement — prediction needs a substrate. When a dog leaves your hearing or goes silent, its marker must freeze as a timestamped ghost with a motion smear, dissolving with age, never interpolated [V1 — the corpus's one validated solution to moving-things-in-stale-clouds]. Without this, dogs pop in and out and prediction is vibes.
3. **Death teaches.** On a down, 2s replay of the killing dog's approach path and the sound that betrayed you [V1]. The single cheapest anti-ragequit device we have.
4. **Partial credit** (folded into P1: cells bank individually) [EVIDENCE: Hunt].

## 6. Components v2 doesn't spec yet — proposed defaults

| Component | Default [JUDGMENT unless marked] |
|---|---|
| Player count | 1–4, tuned at 2–3; solo fully supported (3am hedge) [EVIDENCE: C1/C2] — [YOUR CALL] |
| Session | 15–25 min; 5 floors + 2 optional; floor ≈ 45×30m, ≥2 stair/shaft links + 1 unlockable |
| HP / downs | 100 HP; detonation 100 ≤2m / 45 at 4m / 12 at 6m + knockback; downed 25s, revive 3s (audible 14m); solo death ends run |
| Fall damage | **None** — falls cost noise and a >4m landing stagger (0.3s), not HP; fall damage fights the flow fantasy |
| Dog spec | patrol 3.0 / investigate 4.5 / chase 7.0 m/s (faster than sprint 6.0 in a straight line; 3m turn radius — corners are your friend); lunge from 5m; proximity fuse: 0.7s beep-spool inside 2.5m = the juke window (pillar: loud before lethal); counts: 2 on floor 1, +1 per floor, cap 6 |
| Dog senses | hearing per §2.3; investigation = go to last-heard origin, search 10s, decay to patrol; its belief of you is a ghost that rots — visible logic, learnable |
| Movement | crouch 1.7 / walk 3.5 / sprint 6.0 m/s; mantle ≤2.2m; ladders 2.5 m/s silent |
| Energy | cap 100, regen 6/s; E-ping 18, Q-ping 10, Shove 12, boost-chip verbs 20–25; movement free (§4f) |
| Chips | 3 slots; swap anytime out of chase; passives reserve reactor capacity (Sensitivity −12 cap, Damped Soles −8...) — the discrete allocation game |
| Cells | count = players (min 1); no movement penalty; hum 12m / 2s pulse; handoff 2s; stacking multiple on one carrier stacks hums — the loud-mule gambit is legal |
| Ship | docked topside the whole run, no day timer; extraction = cells + living players aboard, hold 5s; no hard run timer — Heat is the clock (watch for stalling in tests) |
| Co-op perception | shared team geometry map (diegetic uplink), personal event markers; PvE means v1's anti-cheat perception firewall relaxes to shared truth — a large Stage-A scope cut [V1] |

## 7. Constraint ledger after v2

Standing: **C1/C2** (co-op PvE flagship, one mode — v2 is even more compliant than v1 was), **C4** (now *the* gate — see §9), **C5, C6, C7**, the **Reciprocity Law** (strengthened: now diegetic), the **no-fake contract** (hatches, traps, and summons all have audible sources), all readability laws. Renegotiated: **C3** — its letter (auto-pulse default) is replaced by footstep-painting as the always-on layer; its spirit (no scan fatigue, perception floor, flash-safety) is preserved — ping spacing ≥0.75s, chroma events, reduce-flashing mode still ship.

## 8. Tone

You didn't answer the warm-vs-cold fork, but you answered it sideways: "crappy/sloppy vibe" is a rejection of the R.E.P.O. register, and a precision-flow fantasy wants precision aesthetics. Revised recommendation [JUDGMENT, reversing my v1 lean]: **cold, clean, kinetic world — Mirror's Edge/Ghostrunner register, not R.E.P.O. — with all warmth supplied by the humans**: proximity voice between teammates (and the option that dogs hear open mics) provides the comedy and camaraderie the market evidence values, without one goofy asset on screen [EVIDENCE: the LC/PEAK laughter loop is voice-driven, not asset-driven]. The robots are sleek; the players are funny. Question 3 below.

## 9. Web and Milestone Zero

Web accepted (Stage A) — and note the PvE simplification in §6 makes Stage A cheaper than v1's PvP netcode was. Milestone Zero stands and is now *more* central, since the core fantasy is movement itself. Redefined for v2, two tests: **the Blindfold Gauntlet** — sprint an unfamiliar route lit only by your own footfall-paint plus partial memory skeleton, ≤1 fall across 3 consecutive runs, sketch the route after; and **the Lantern Test** — track an unseen patrolling dog through one wall by sound-paint for 20s and call its exit point. Pass both → build everything else. Fail after two perception redesigns → the fantasy needs re-scoping before content exists [C4 — still the only genuinely unvalidated claim in the corpus].

## 10. Questions that need you

1. **Movement energy:** do you accept cutting it (movement priced in noise only, reactor gates deliberate acts)? My rec: yes — it is the one line in v2 that fights your own core fantasy.
2. **Combat baseline:** no guns, verbs = read/avoid/bait/juke/spend, Shove as the tested fallback. Accept, or do you want a weapon slot held open in the design?
3. **Tone:** cold precision world, warmth from player voices (my rec) — or do you want any goofiness in the fiction itself?
4. **Player count:** 1–4 scaling tuned at 2–3, solo first-class? (Affects cell counts, dog tuning, and Stage-A netcode scope.)
5. **Map permanence:** skeleton-permanent with decaying detail (my rec), or the full-detail permanent map your spec literally says — accepting the tension and budget costs?

*Backup file: `/tmp/claude-0/-home-user-blind-spot/8654358d-db3b-55a4-9c72-cb9759b139a4/scratchpad/design/review-v2.md`. Carried forward, not guessed at: point-cloud readability at speed remains unvalidated by anyone anywhere — M0 buys that answer before we spend on content.*
