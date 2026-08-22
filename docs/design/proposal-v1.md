# BLIND SPOT — PROPOSAL v1

*Lead designer, 2026-08-22. Reaction document — react, correct, and I revise. Tags: [EVIDENCE] research-backed · [V1] validated by the shipped prototype · [JUDGMENT] my call, arguable · [YOUR CALL] you decide.*

---

## 1. Verdict

**Conditional GO.** The mechanic is proven fun (Muffled Warfare players logged 189–655 hours; it died of empty lobbies, not boredom), the niche is empty (nobody has shipped co-op roguelike echolocation), the tech is solved (~1M points mid-range; v1 ran the renderer in a browser), and the market fits ($8–12 co-op with a renderer no clone farm can copy). Conditions C1–C7 are law; this proposal is built inside them. Shipping ranked 1v1/2v2 at launch (C1) or failing the readability gate (C4) reopens no-go.

## 2. The game in one paragraph

**BLIND SPOT** is a 1–4 player co-op roguelike where you see with sound. Your salvage rig paints the pitch-black world in sonar pulses — every picture is already old, and every pulse tells the dark where you are. Sprint, climb, and slide through dead megastructures on stale afterimages; hunt the hidden Core by ringing ancient resonators; then carry it out while it sings your position to things that hunt by ear. Seeing, running, and shooting all drain one reactor. The silhouette frozen in your doorway is a photograph. It might be old. It might not.

## 3. Design pillars

1. **Every question has a price.** [V1] Learning anything emits something. *This means we never* ship free, passive, or long-uptime intel — no minimap radar, no wallhack augment, no silent scan.
2. **The system never lies.** [EVIDENCE: Hunt's no-fake contract] Every echo, blip, and sound was caused by something real; only players may buy deception (decoys), and fakes render through the identical code path. *This means we never* script a fake footstep, phantom echo, or jump-scare that has no physical source.
3. **Age is a color, absence is black.** Fresh, stale, and memory are visually distinct states; the unknown is never rendered. *This means we never* draw ambient light, outlines, fog, or "helpful" geometry the player didn't earn.
4. **The world is loud before it is lethal.** Every hazard and threat sings its rhythm in advance. *This means we never* ship a silent instakill or a sound without a findable source.

## 4. The core loop

**The 30-second unit:** choose a gait (crouch silent / walk quiet / sprint loud), move through remembered navy geometry → the auto-tick keeps the floor alive → spend a Focus Pulse on the riskiest unknown → interpret the photograph (fresh wall, cooling ghost, Warden tread rising) → commit — route around, bait, grab, or fight → consequence arrives as sound (Moths bloom toward your pulse, the Warden turns) → go dark and rebuild uncertainty. Library quiet punctuated by flashbulb violence [V1].

**The run arc (20–35 min):** three zones, descending. Per zone (~8–10 min): drop in → strike **Resonators**, each ring *eliminating* map regions where the Core cannot be (Hunt's monotone narrowing [EVIDENCE]) at the cost of waking the zone → locate the Vault → pulling the **Core** starts it singing (carrier broadcast every 5s, no sprint [V1]) → carry to the Lift → 3.5s channel, fully lit, all-aboard bonus → descend into a **Quiet Room** (anechoic safe room: draft an augment, swap engine profile, revive). Zone 3 Core to the surface = extraction win. Clues and Cores bank partial credit even on a wipe (Hunt's losing-team payout [EVIDENCE]); XP is kept.

## 5. Perception system

**Auto-pulse (the anti-fatigue floor).** A cheap omni tick, ~12m radius, low density, at a profile-set interval notch: **0.6s / 1.2s / 2.4s**. An augment unlocks a 0.4s notch; **0.4s is the hard floor, forever**. This diverges from your 0.1–3s brief: 0.1s fails photosensitivity guidelines on three axes [EVIDENCE: XAG-118] and 10Hz is functionally just vision — the interval fantasy survives as notches, not the floor. Pulses are chroma events on a raised black floor, never luminance strobes; a reduce-flashing mode cross-fades reveals.

**Focus Pulse (the tactical layer).** Manual, directional: 70°×43° elliptical cone (circular wastes rays on floor/ceiling [V1]), 30m, rendered as a 60 m/s wavefront, ≤22k points, 0.045m voxel dedup so rescans refresh in place [V1]. Costs 18 reactor, 1s minimum spacing. Reciprocity: anyone (and any thing) within 35m hears it and receives your position + facing as a COARSE flash [V1]. Your multi-directional and N-bounce fantasies live in the legendary augment pool: **Overpulse** (360°/20m) and **Ricochet Ping** (one bounce, sees around one corner, double cost) [JUDGMENT: one bounce, not N — cost and readability].

**Staleness.** Two named, tunable stats [EVIDENCE: MWO Target Decay / Radar Deprivation]: **Retention** — how long your cloud holds detail (fresh ice-white → cyan over 4s → dim navy *memory skeleton* at 30s, alpha floor 0.22, held until evicted — the map never fully vanishes [V1]); **Slip** — how fast others' picture of *you* rots (including the Warden's belief-ghost of you).

**Moving-object ghosts.** Live things freeze as timestamped photographs: posed silhouette + 0.3s motion smear, cooling hot-orange → rust over 10s, then *dissolving outward* (t², up to 0.38m) so a stale sighting visibly comes apart; never interpolated; invalidated by re-scan [V1]. This is the trailer shot.

**Color language.** The Three-Color Law [V1]: cyan family = matter (age = temperature; depth encoded only inside this band), orange family = hostile life & sound events, gold = objective only. Co-op adds **green = teammates** — your ask — but never hue alone [EVIDENCE: colorblind guidelines]: teammates also carry a steady glyph pip and steady motion; hostiles are jagged, smeared, cooling. Colorblind presets recolor the life layers only.

**Self-readout: the Halo.** A ring around the reticle showing your current emission level (gait, engine strain, pulse afterglow, Core carry) with an audio component — your rig's hum pitch [EVIDENCE: Thief's light gem, Chaos Theory's sound meter; Muffled Warfare's #1 complaint was "can't tell when I'm visible"].

**Counterplay.** Absorbent terrain (draped/overgrown zones eat pulses), Slip augments, crouch-stillness (**Cold Blood** [V1]), and priced decoys. No un-counterable intel exists on either side [EVIDENCE: Apex Seer revolt].

## 6. Energy system: the Reactor

One bar, 100 capacity, constant regen ~6/s (your nuclear-engine fiction, kept). Crysis-2 discipline [EVIDENCE]: **twitch-frequency actions auto-draw** — sprint ~4/s, climb/mantle small sips, auto-tick ~1.5 per tick; **deliberate acts are manual spends** — Focus Pulse 18, gunshot 6, legendary actives 20–30, revive surge 30.

**Engine profiles, not sliders** [EVIDENCE: Barotrauma's solved-then-automated trap — diverging from your real-time-tuning brief]. A profile is three dials with discrete notches — **Pulse** (tick interval + density), **Legs** (sprint speed vs drain), **Arms** (weapon mode) — set at loadout, swappable only in Quiet Rooms. Three starter profiles ship (SURVEYOR, RUNNER, SIEGE); the tree unlocks notches. "Boost the engine, then re-tune": reactor augments raise regen/capacity mid-run; the next Quiet Room is where you re-spec.

**Running dry: Brownout.** Dramatic and legible [EVIDENCE: MechWarrior heat]: 3 seconds of no sprint, no pulse, your rig whining ~50% louder — you become the loudest thing in the zone precisely when you're helpless — then recover to 25. Never death by bar; always a vulnerability spike you caused.

## 7. Movement & parkour (C4 — the project gate)

**Verbs at launch:** sprint, jump, mantle, vault, slide, ledge-grab, drop-catch. Wall-run is deferred until the gate passes [JUDGMENT].

**How parkour stays readable in a point cloud — four laws:**
1. **Dots are matter; lines are holds.** Traversal affordances (ledges, lips, rails, ladder rungs, platform edges) render as short solid micro-lines inside the cyan band, ~2× brightness. One reserved encoding, one verb, everywhere, forever [EVIDENCE: Mirror's Edge red; shape-based, so colorblind-safe].
2. **Your body is a sensor.** Touch radius paints geometry within 2.5m continuously [V1]; landings and grabs splash local detail — momentum generates its own picture.
3. **The floor is never dark at legal speed.** Sprint ≈ 6 m/s against a 12m auto-tick at ≤0.6s means ≥2 fresh paints of any surface before you reach it. Tick notch and sprint notch are coupled in profiles so players can't configure blindness at speed.
4. **Memory persists.** The navy skeleton (alpha floor 0.22) means you parkour through remembered space, not blackness [V1 — when it faded further, the game quietly became last-4-seconds-only].

**The readability test — the Blindfold Gauntlet (Milestone Zero).** A fixed loop: two gaps, a mantle chain, a rhythmic crusher, a blind drop. **Pass:** a mid-skill playtester, first session, clears it at sprint on 0.6s ticks with ≤1 fall across 3 consecutive runs, and can sketch the route after. Fail after two perception redesigns → pivot toward deliberate pace before building anything else. No data exists anywhere on point-cloud readability at speed [EVIDENCE: open item] — so we buy that data first.

## 8. The flagship mode — SALVAGE RUN

One mode, executed hard (C2): the co-op hidden-objective hunt described in §4. Full arc mechanics:

- **Resonators (clue grammar).** Two per zone. Striking one rings zone-wide (everything hears it — clue-gathering is priced) and greys out eliminated regions on your **holo-recall**: hold a key to project your *own accumulated memory cloud* as a diegetic tabletop overview. It shows only what you've perceived — the perception firewall stands [V1] — and it exists because getting lost kills these games (Perception, MC 56; overhead maps are the shipped fix [EVIDENCE]). This diverges from v1's no-minimap purism: right for an 8-minute duel arena, wrong for 30-minute co-op zones.
- **Proximity read.** Near the Vault, gold density/brightness/audio rise — density, not compass [EVIDENCE: Hunt's Dark Sight].
- **The carry.** Core sings every 5s (COARSE, to threats), carrier can't sprint, Lift beacon ignites gold for everyone on first pickup, 3.5s fully-lit channel to leave [V1's relic arc, retuned for AI opposition]. The hunter-becomes-hunted flip is the mode's signature.
- **Anti-stall.** Per-zone escalation clock thickens Moths and shortens Warden patrols over time; rewards are team-collective (clues pay everyone) — never scarce contested loot on a timer [EVIDENCE: RoR2's "versus co-op" trap].

**Mode roadmap.** *Solo* is Salvage Run tuned for one rig — the onboarding path and the 3am hedge, never a marketed mode [EVIDENCE]. *PvP*, honestly: ranked 1v1/2v2 at launch is the confirmed death zone (Duel Corp 2,485→8 CCU; Spectre Divide $60M→shutdown) [EVIDENCE] — cut from launch, not from the game. Post-population (gate: ~1,000 sustained CCU): **Duels** — unranked, room-code 1v1 on the v1 ruleset, which already exists and is tuned [V1]; then **Rival Salvage** — two duos race one Core through a live zone, Hunt-shaped PvPvE, party-framed, no ladder. That's your 1v1 and 2v2, sequenced so they can survive.

## 9. Threats & traps

All opposition obeys the pillars: audible before lethal, no fakes, and *they perceive like we do* — by sound and stale belief.

- **The Warden** (launch's one real AI): a blind heavy that hunts by ear. Its tread is always audible in-range; a map-wide horn sounds when it acquires a target [EVIDENCE: Hunt's layered range bands]. It navigates to a *last-known-position belief* of you — you can watch its ghost of you rot; Slip rots it faster [EVIDENCE: Splinter Cell LKP]. Between your pulses it exists only as sound and afterimage.
- **Moths**: cheap swarmers that fly toward pulse origins — the co-op anti-spam mechanism made flesh. Over-scanning literally breeds contact.
- **Chimes**: roosting glass-drones that shriek and scatter when disturbed — our crows [EVIDENCE: Hunt's placed sound traps], authored at chokepoints.
- **Traps**: every hazard sings its rhythm — crushers thump their cycle, platforms clank at each terminus, grates creak before failing. You *time them by ear* and confirm by pulse: heard always, seen only when pulsed — your moving-platforms ask, made sound-first. Few per zone, telegraphed, introduced one at a time.

## 10. Progression

**In-run: Augments** (drafted in Quiet Rooms, run-scoped, Hades-shaped), in your three rarities: **Common** — sidegrades and engine tweaks (reactor capacity, Slip, Keen Ear); **Amplifier** — your "xp augmentations": XP gain, clue sense, extra draft options; **Legendary** — new verbs: Overpulse, Ricochet Ping, Tripflare (your motion-detection grenade — v1's Sensor Spike, renamed), Dead Song (quieter carry), Ghost Rounds, Extrapolator, Slip Cloak. v1's 12 cards seed the pool; all are verb-changers [V1].

**Persistent: the License Tree** — verbs and options only, never raw stats [EVIDENCE: roguelite community consensus is hostile to stat-tree meta]: new profile notches (including the 0.4s tick), lens patterns (Long/Wide), movement verbs (slide first, wall-run if gated in), gadget types, weapon modes, and new *draftable* augments. This diverges from your brief's "upgrade speed/gun" stat framing — same fantasy, delivered as unlocked capabilities.

**XP sources:** information plays — first-paints, resonator rings, Core carries, revives, extractions; 1 XP per 4 damage; zero XP for pulse count [V1]. Team events pay everyone.

## 11. Maps

Three zone archetypes at EA, one setting: the **Husk**, a dead megastructure you descend through.

1. **The Foundry** (launch archetype): industrial vertical — gantries, chain curtains, crushers. Best parkour affordance, best sound-trap authoring, machine silhouettes read instantly at pulse range. Palette: steel-cyan.
2. **The Cistern**: flooded stone galleries — water amplifies movement noise (a whole zone that retunes your gait math), curved chambers read unmistakably in cloud [V1: the Rotunda]. Palette: deep teal.
3. **The Overgrowth**: pulse-absorbent flora — the counterplay terrain — plus Chime roosts and organic asymmetry. Palette: violet. (Ships during EA, not at.)

**Why per-zone palettes:** location identity is a shipped anti-lost fix [EVIDENCE: LiDAR Exploration Program]. **Generation:** authored room grammar + procedural contents — hand-built compound library, procedurally selected/rotated, with Resonator/Vault/Lift/threat placement randomized [EVIDENCE: DRG abandoned free-form procgen]. **Readability rules:** zones sized 30–40% smaller than looks right on paper (dark reads bigger [EVIDENCE: CANARI]); one mega-silhouette landmark per zone ("the double stalactite" rule — point clouds transmit mass before texture); long sightlines broken; Vault rooms always multi-entrance [EVIDENCE: Hunt compounds]; no two corridors with the same scale signature.

## 12. Tone & fiction [YOUR CALL]

**My recommendation: warm crew, cold world.** Goofy, clanky, paintable salvage rigs with open proximity voice, inside a genuinely dreadful dark. Market evidence: R.E.P.O. is literally goofy robots at ~$10 and sold 18.4M; tense+funny is the proven 2025–26 co-op register, tense+sleek a smaller audience [EVIDENCE]. The dread survives because it is *epistemic*, not aesthetic. v1 was cold sonar-noir — I diverge from v1 on market evidence, and the mechanics survive either tone, so it's yours to overrule: **(a)** warm crew / cold world *(recommended)*, or **(b)** cold noir throughout, accepting a smaller, sharper audience.

## 13. Your three problems, answered

**Not boring — the forcing functions.** Stillness loses: resonator rings are priced but mandatory (monotone narrowing pulls you forward), the escalation clock thickens threats, the Core sing makes success itself dangerous, Brownout punishes greed, and the draft re-postures every zone. v1 killed the hiding meta with the relic heartbeat [V1]; the same shape works here — the objective drags everyone toward the same coordinates. And the real content is other people: proximity-voice co-op under emission discipline generates its own stories [EVIDENCE: Lethal Company's cut-off-mid-sentence beat].

**Non-glitchy, non-confusing — the legibility laws.** Hard pool budgets with oldest-first eviction (porridge cannot accumulate) [V1]; surface splatting sized to voxel footprint; tangential jitter (isotropic puffs walls into fog) [V1]; Three-Color Law with age-as-temperature; depth encoded only inside the cyan band (a warm silhouette can never read as near geometry — full rainbow depth was tried and rejected [V1]); dots-vs-lines traversal; memory alpha floor; splats ≥2–3px and temporal stability so the image survives H.264 [EVIDENCE: C6]; per-zone palettes; the holo-recall. Plus the comfort floor: FOV 80–110, no motion blur, toggleable bob/shake, steady-points mode, reduce-flashing mode [EVIDENCE].

**Intense — the tension engine.** Reciprocity makes every question a wager; the no-fake contract makes every sound real, so silence is never safe *and* never wasted; the Warden is always audible, rarely seen, and what you see of it is old; the carry is a sung gauntlet ending in a fully-lit 3.5s channel [V1]; Brownout at the wrong moment is self-authored catastrophe; open mics are diegetic speakers — the Warden hears your teammate laughing [JUDGMENT: default on, toggleable]. Intensity is the cost of knowing, compounding.

## 14. Scope & build reality

**Team assumption [stated]:** you + Claude Code agents, v1-style (v1 shipped in roughly a day of agent time); calendar estimates below use human-team comparables as the ceiling.

**Engine — staged [YOUR CALL].** Stage A: extend the browser v1 stack (TS/Three.js/Node) through Milestone Zero and a 4-player co-op slice — the renderer is validated there [V1], and link-click playtesting is a real asset when the core question is "is this readable to a stranger." Stage B: if gate and slice hold, port to **Unity 6 URP + NGO/Facepunch + Steam Audio** for Steam production [EVIDENCE: tech brief; Steam Audio is now Apache-2.0]. Cost: one port. Alternative: Unity from day one — cleaner path to EA, slower first playtest. I recommend the stage: C4 is the project risk, and the browser is the fastest instrument that measures it.

**MVP (playable vertical slice):** one Foundry zone, full perception + Reactor + parkour verbs, Warden + Moths + Chimes, complete Core arc, 6 augments, 2 weapons (v1's Judge/Whisper port [V1]), 1–4 players, no meta tree.

**Phases:** **M0** Blindfold Gauntlet (weeks 2–4) → **M1** co-op netcode + Warden (≈month 3) → **M2** full slice, friends playtest, *fun verdict* (month 4–5) → **M3** 3-zone run + draft + Cistern (month 7–9) → **M4** Unity port, meta tree, Steam demo ≥2,000 wishlists before any fest [EVIDENCE] → **Early Access at 12–18 months, $9.99** (C7).

## 15. Risk register

| Risk | Mitigation | Kill-signal |
|---|---|---|
| 1. Readability at parkour speed (C4) | M0 gate; dots-vs-lines; tick/sprint coupling; memory floor | 3 testers fail the Gauntlet after 2 perception redesigns → pivot to deliberate pace |
| 2. Onboarding cost (hard first 10 min) [EVIDENCE: friendslop wins in 60s] | Diegetic spawn-alcove tutorial [V1]; profiles hide tuning; solo path | New testers can't explain "pulse costs position" after run one; >40% quit inside 10 min |
| 3. One-trick shallowness ("tech demo") [EVIDENCE: the genre's #1 killer] | Opposing agents + roguelike variety + co-op chemistry from M2 | M2 slice testers don't start a second run unprompted |
| 4. Streamability (C6) | Chunky stable splats; bright accents; streamer exposure floor; 1500kbps capture test in CI [V1 practice] | Clips unreadable at 720p/6Mbps in M2 captures |
| 5. Scope creep via modes/PvP | C1/C2 as law; PvP gated on population milestone | Any launch-scoped ranked mode reappears → synthesis says this reopens no-go |

## 16. What I need from you

1. **Tone:** warm-goofy crew in a cold world *(my rec)*, or v1's cold sonar-noir? This decides voice, art direction, and marketing register.
2. **Engine staging:** browser-first gate then Unity port *(my rec)*, or Unity from day one and accept a slower first playtest?
3. **v1's status:** parts library + future Duels seed *(my rec)*, or baseline-to-extend? (You reset the tree but kept history — I've treated it as evidence, not plan.)
4. **PvP path:** do you accept Duels/Rival Salvage as *post-population, unranked, party-framed* — i.e., your 1v1/2v2 arrive late and unranked or not at all *(my rec: accept)*?
5. **Voice-as-emission:** threats hear open mics by default (toggle exists) *(my rec: yes — it fuses the comedy and the terror)*, or voice stays out-of-world?
