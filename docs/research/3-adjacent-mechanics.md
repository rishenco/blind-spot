# Adjacent Mechanics — Research Brief

## TL;DR

- **The scan-meta lesson is about uptime, not power.** Respawn's own framing of Apex's problem was that scans "killed 'rat' plays, and make 'game sense' obsolete." They fixed it by cutting *duration and frequency* (Bloodhound tactical 3s→1s; Seer ult 30s→25s, cooldown 120s→180s), not by deleting the fantasy — plus a hard counter (Catalyst's Dark Veil) and a class system that gates who gets intel.
- **Every good reveal mechanic makes the revealer visible too.** Bloodhound's scan emits a giant orange wave; Crypto is helpless while droning; Siege drones emit noise and a bright yellow light; Sova's Recon Bolt is shootable *and* Riot deliberately buffed its in-flight audio so targets can read its "directionality, point of impact, and reveal radius."
- **Hunt's real innovation isn't 3D audio, it's the trust contract: "there is no fake."** Every crow, dog, chain, or glass crunch was caused by a player. Trustworthy signal is what makes listening learnable — and CS2 shows the inverse: an audio bug that drops footsteps produces instant community fury because the contract broke.
- **Mirror's Edge's white city was a motion-sickness fix, not a style choice.** A gritty brown prototype made testers sick; stripping detail and reserving bold color for interactables solved comfort and readability at once. A direct argument for a sparse point cloud with a tiny reserved palette.
- **Dark spaces feel bigger than they are** — so shrink them and use *scale*, not color, as the landmark vocabulary ("the room with the double stalactite").
- **One-bar systems drift toward fewer manual claims over time.** Crysis 1's four manual modes collapsed into Crysis 2's automatic "Power" + two manual toggles. Barotrauma's real-time power routing "quickly becomes a solved problem" and gets automated by players.
- **Hunt's clue chain is the best available template for the hidden flag** — monotone narrowing plus an objective that broadcasts contact.
- **Watch the RoR2 co-op failure mode:** shared scarce loot + a global timer makes co-op feel like "versus co-op."

---

## Findings

### 1. Scan/reveal in competitive games

Apex's Season 10 (Aug 2021) Seer launch is the canonical blow-up; Respawn's Season 16 corrective explicitly targeted "the scan meta" ([GameSpot](https://www.gamespot.com/articles/apex-legends-season-16-takes-a-swing-at-the-scan-meta-buffs-wraith-and-pathfinder/1100-6511289/), [esports.gg](https://esports.gg/news/apex-legends/bloodhound-rework-buff-season-16/)). Three levers were pulled: shorten reveal duration, lengthen cooldowns, and introduce a dedicated counter ([Dexerto on Catalyst's Dark Veil](https://www.dexerto.com/apex-legends/catalyst-finally-counters-the-scan-meta-recon-abilities-in-apex-legends-1967464/)). The pre-existing counterplay that players *never* complained about was self-telegraphing: Bloodhound's orange sonar wave, Crypto's body left defenceless ([CheckpointXP](https://checkpointxp.com/2021/08/16/the-problem-with-seer-in-apex-legends/)).

Riot's patch history converges on the same rules from a different angle ([Patch 11.00](https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-11-00/)): shootable intel objects need *hit-confirm feedback* (they added audio/visual confirms to Leer because players couldn't tell if their shots were landing); reveal devices need audible signature so the revealed player knows; and fast-activating abilities were retuned because "their fast activation left little time for opponents to respond" — telegraph time is a fairness axis independent of raw strength.

Siege treats intel as a literal budget: two drones per attacker, one auto-spent in prep, and time itself is the co-resource — over-droning means a frantic last-second push ([Reforged Gaming, "Drone Economy"](https://reforgedgaming.org/2019/02/09/rainbow-six-siege-drone-economy/); [r6siegecenter](https://r6siegecenter.com/guides/attack/droning/)).

For staleness specifically, MechWarrior Online has explicit shipped knobs: **Target Decay** (how long a lock persists after LOS breaks) and **Radar Deprivation** (a module that instantly drops enemy locks on you when you break LOS) — [MWO forums](https://mwomercs.com/forums/topic/251146-target-decay-vs-radar-deprivation/). That's the point-cloud staleness dial, already play-tested by a community for a decade.

**Converged rules:** (1) the act of gathering info exposes the gatherer; (2) intel is denyable — destructible device, blocking field, or a movement style that defeats it; (3) decay is the primary balance lever; (4) counterplay needs feedback of its own; (5) nerf uptime before identity; (6) telegraph time ≠ power.

### 2. Sound as primary information

Crytek frames Hunt's audio around three pillars — feedback, immersion, emotion — where feedback answers "What was that sound? Where is it coming from? Is it dangerous?" and "audio readability" is defined as the clarity with which essential gameplay information can be understood by listening alone ([Hunt dev insight](https://www.huntshowdown.com/news/hunt-audio-readability-realism-and-consistency); [PlayStation.Blog](https://blog.playstation.com/2020/02/17/listen-closely-insight-into-the-sound-design-of-hunt-showdown/)). CrySpatial (HRTF, 2019) gives above/behind/below resolution, and footsteps are authored *differently* for above vs below inside buildings ([3D audio deep dive](https://www.huntshowdown.com/news/dev-insight-a-deep-dive-into-3d-audio-in-hunt)).

Two structural pieces matter more than the tech:
- **Placed sound traps as level-design objects**: glass piles, hanging cans, jangling chains, crows, dogs — information mines the designer positions at chokepoints.
- **The no-fake contract**: a crow burst or barrel blast always means a player. Signal is never noise, so listening is *learnable*.
- **Layered range bands**: gunshots and explosions carry map-wide for strategic reads ("how many hunters are left"), while footsteps are intimate.

CS2 confirms the failure mode: HRTF plus occlusion-based muffling lets players estimate distance, footsteps ~20m — but when a backend change broke directional audio and dropped footsteps, trust collapsed immediately ([CSDB audio guide](https://csdb.gg/guides/audio-guide/)). Also worth noting: players actively disable "virtual surround" because it muddies footsteps — ship a clean raw/HRTF option.

For *self*-readout, Thief's light gem is the reference: a UI gem that brightens/dims with your visibility, "with also an audio component," which the team added because players couldn't otherwise tell their own state ([GameDeveloper on Thief's stealth system](https://www.gamedeveloper.com/design/building-the-original-i-thief-s-i-revolutionary-stealth-system)). Splinter Cell: Chaos Theory extended this to a **sound meter measuring player-made noise against ambient noise** ([Splinter Cell Wiki](https://splintercell.fandom.com/wiki/Stealth_Meter)) — precisely the readout a pulse-emitting robot needs.

Proximity-voice games add the social layer: Lethal Company's most-cited horror beat is a teammate's voice cutting off mid-sentence; walkie-talkies are battery-limited (comms as consumable) and a ship operator holds asymmetric radar intel ([Game Design Library](https://www.gamedesignlibrary.com/post/proximity-chat-changes-the-game-how-lethal-company-s-game-design-innovated-multiplayer-horror-games)). PEAK ties comms *range* to distance, mechanically forcing cohesion ([TheGamer](https://www.thegamer.com/proximity-chat-is-incredible-peak-repo-lethal-company-phasmophobia-among-us/)).

### 3. First-person parkour readability

**Mirror's Edge**: Runner Vision paints usable geometry red. At GDC, level designer Elisabetta Silli admitted "Red is an odd choice because it means danger or stop" — she stopped dead at a red door on her first play — but concluded "Red is perfect for Faith, I wouldn't change it" ([Engadget/GDC](https://www.engadget.com/2010-08-17-overheard-gdc-mirrors-edges-odd-go-here-color.html)). The takeaway is *absolute reservation*: one color means one verb, everywhere, forever. Separately, the white low-detail city was adopted because a gritty brown prototype caused severe motion sickness ([Notebookcheck, devs](https://www.notebookcheck.net/Devs-Mirror-s-Edge-s-clean-white-city-a-practical-fix-not-a-pure-artistic-vision.1208014.0.html)).

**Titanfall 2**: wall-run speed *increases the longer you hold it*, which mechanically rewards chaining; the wall-run "feels skillful to pull off, despite actually being simple to initiate" — low execution floor, high expressive ceiling ([design breakdown](https://medium.com/@abhishekiyer_25378/titanfall-2-how-design-informs-speed-f14998d7f470)). Their "action block" level-prototyping process is worth reading for map construction ([GameDeveloper](https://www.gamedeveloper.com/design/understanding-i-titanfall-2-i-s-action-block-level-prototyping-process)).

**Neon White / Ghostrunner**: zero friction between attempts. Neon White's instant restart means "learning is not punished" ([Corerunner review](https://corerunner.substack.com/p/neon-white-review); [Epilogue Gaming](https://epiloguegaming.com/neon-white-player-fatigue-and-gaming-burnout/)). Ghostrunner pairs one-hit death with near-instant respawn and dense checkpoints.

**Cautionary — Rooftops & Alleys**: first-person mode ships a locked ~130–140 FOV with no slider, and reviewers report nausea "almost instantly" even without prior sensitivity ([Steam Deck HQ](https://steamdeckhq.com/game-reviews/rooftops-alleys/)). PEAK has open motion-sickness threads too. Baseline comfort kit: FOV 80–110 player-controlled, toggleable head bob / camera shake / motion blur, optional world-space horizon anchor.

### 4. Single-resource energy systems

Crysis 1 put Armor/Strength/Speed/Cloak on one manual bar; Crysis 2 folded Strength+Speed into a **context-sensitive automatic "Power"** (sprint, power jumps, slides, melee auto-draw), keeping only Armor and Cloak as manual toggles; Crysis 3 removed the sprint drain almost entirely ([Crysis Wiki: Nanosuit 2](https://crysis.fandom.com/wiki/CryNet_Nanosuit_2)). The historical drift is unambiguous: **twitch-frequency claims on the bar get automated; deliberate claims stay manual.**

Souls stamina is "the tempo governor... it forces commitment budgeting, punishes greed (the fifth swing that leaves nothing for the dodge)" and differentiates gear (heavy weapons cost more per swing, heavy armor slows regen) ([Game Mechanics Hoard](https://gamemechanicshoard.com/mechanic/stamina-management/)). MechWarrior heat works because *running dry is catastrophic and immediate* — forced shutdown, ammo cook-off, limb loss ([Skeleton Code Machine, "MECH WEEK: Heat"](https://www.skeletoncodemachine.com/p/mech-week-heat)). Invisible Inc's PWR is one currency for all Incognita actions, hard-capped, with tiny passive regen (Power Drip +1/turn) and the *map* as the faucet — you harvest PWR from consoles ([TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/InvisibleInc)).

The negative case is Barotrauma: real-time reactor routing "quickly becomes a solved problem," and players build automated controllers to remove the decision entirely ([Barotrauma discussions](https://github.com/FakeFishGames/Barotrauma/discussions/8702)). **Real-time percentage-allocation sliders get solved and then automated; discrete spend decisions under time pressure do not.**

### 5. Roguelike co-op structure + hidden objective

**Hunt's clue chain is the template.** Up to three clues per boss; investigating one **greys out a region where the target cannot be and disables the remaining clues there** — monotone narrowing rather than a hot/cold wander. Dark Sight shows a blue mist that grows and brightens with proximity plus an eerie audio cue. Crucially, clues **turn from white to red and emit a loud noise when two different teams are within radius** — the objective itself broadcasts contact. And clues pay out at extraction even if you lose the bounty: partial credit for the losing team ([Hunt wiki: Clues and Rifts](https://huntshowdown.fandom.com/wiki/Clues_and_Rifts), [Bounty Hunt](https://huntshowdown.wiki.gg/wiki/Game_Modes/Bounty_Hunt), [Dark Sight](https://huntshowdown.wiki.gg/wiki/Dark_Sight)).

**Deep Rock Galactic** defines its four roles by *traversal verb*, not damage type: Gunner ziplines, Driller tunnels, Engineer platforms, Scout grapples ([GameTyrant interview](https://gametyrant.com/news/deep-rock-galactic-interview-a-balanced-co-op-challenge-game)). Its procgen history is directly relevant: free-form intersecting cave generation was "too random and often not good for combat," so they constrained generation for control while keeping variation ([GamingBolt interview](https://gamingbolt.com/deep-rock-galactic-interview-heigh-ho-off-to-plunder-we-go)).

**Risk of Rain 2** supplies both the pressure clock (a global timer that scales enemies continuously, with an exponential jump per stage) and the co-op failure mode: scarce per-stage loot plus a fixed boss timer makes teams scatter and compete, so it "doesn't really feel co-op but more like a versus co-op" ([Steam discussions](https://steamcommunity.com/app/632360/discussions/0/1768134097430214039/)).

**Meta-progression:** community consensus is sharply against stat trees — "just playing until character stats are good enough to finish a run" — and in favor of unlocks that add variety, sidegrades, and new challenges ([ResetEra thread](https://www.resetera.com/threads/im-starting-to-feel-that-stat-based-meta-progression-is-starting-to-ruin-roguelites-generally-speaking.1509337/page-2)).

### 6. Level design for information games

The single most on-point source is CANARI's dark-game postmortem ([GameDeveloper](https://www.gamedeveloper.com/design/navigation-and-wayfinding-in-a-quot-dark-game-quot---part-1)): they **cut dungeon size from 9–18 rooms to 6–12** because "our brains fill in the gaps when we are void of information" — unlit space feels far larger than it is. They replaced visual landmarks with **scale-based weenies** ("this is the room with the double stalactite") and layered decoration in three passes: reused large-scale base objects → thematic overlay signalling progression → diegetic props signalling room function. Named pitfall: playtesters *quit* after getting lost.

General landmark theory agrees: landmarks must be unique in appearance *or size* relative to surroundings; tall landmarks with wide sightlines; dense detail clusters against sparse backgrounds; the space should be navigable with the HUD off ([Level Design Book](https://book.leveldesignbook.com/process/blockout/wayfinding)).

Hunt's compound revisions show the combat-space grammar for info games: equidistant compound spacing at varied sizes, multi-level access points, **long sightlines deliberately broken up**, more entrances to the objective room so flanking beats camping, and reduced clutter/vegetation so movement stays clean ([Crytek compound changes](https://www.huntshowdown.com/news/stillwater-and-lawson-details-of-the-compound-changes-coming-with-up)).

---

## Steal this

1. **Pulse = self-telegraph.** Every pulse must be audible and visibly directional to anyone it touches — the Bloodhound orange wave rule. Consider a Valorant-style buff: enemies should be able to read direction, origin, and radius from the pulse sound alone.
2. **Ship staleness as two named, tunable stats** — MWO's Target Decay (how long the cloud persists) and Radar Deprivation (an augment that wipes enemies' stale cloud of you the instant you break LOS). These are the primary balance levers, above radius and above power cost.
3. **The no-fake contract.** No system-generated false echoes, ever. If a return exists, something made it. This is what converts listening from noise into skill.
4. **Placed sound traps as level-design objects**: glass fields, chain curtains, resonant grating, startled drones/birds. Author them at chokepoints; they are your crows.
5. **A Chaos Theory emission meter**: a persistent readout of how loud/bright *you* currently are relative to ambient, with an audio component (Thief's gem). Players cannot tune their own energy settings intelligently without it.
6. **Reserve exactly one color for "usable geometry"** in the point cloud, and never spend it elsewhere. Mirror's Edge red, applied to a sparse cloud.
7. **Hunt's clue chain for the hidden flag**: 3 successive clues, each investigation *eliminating* a map region rather than nudging a compass; proximity indicated by density + brightness + audio; the clue turns red and screams when two teams are near it; partial payout for clues collected even on a loss.
8. **DRG's role rule**: define co-op roles by *how they move and reveal* (long-range single ping, wide-cone sweep, wall-tag beacons, silent runner), not by damage.
9. **Neon White's zero-friction restart** for solo/roguelike attempts, and Ghostrunner-style dense checkpoints.
10. **Shrink dark maps ~30–40% below what looks right on paper**, and build landmarks from *silhouette scale* — a hall with a 20m sphere in it — since a point cloud transmits mass and shape long before it transmits texture.

## Avoid this

1. **Continuous real-time allocation sliders** (Barotrauma reactors). Make energy allocation a *loadout-time* commitment (pulse strength/rate vs sprint vs weapon draw, chosen pre-run and swappable at safe points) plus *discrete moment-to-moment spends*. Don't ask players to ride a mixer mid-fight.
2. **Manual claims on the bar for twitch-frequency actions.** Follow Crysis 2: sprint and parkour should draw automatically and contextually; only the deliberate acts (a big pulse, a weapon, a cloak) stay on a button.
3. **Long-duration or high-frequency reveals.** Uptime is the feel-bad axis. A short, punchy, expensive pulse beats a lingering wallhack; "scans make game sense obsolete" is the exact failure to design against.
4. **Un-counterable intel.** Ship an anti-echo answer from day one — absorbent surfaces, a Dark Veil-style field, a decoy emitter, a silent-run mode — rather than patching one in two seasons later.
5. **Locked high FOV, forced head bob.** Rooftops & Alleys is the cautionary tale. FOV 80–110 slider, toggleable bob/shake/blur, shipped at launch.
6. **Scarce contested loot on a global timer in co-op** — the RoR2 "versus co-op" trap. Instance or duplicate rewards, or pay the team collectively.
7. **Stat-only meta-progression trees.** Bias the XP tree toward new verbs and sidegrades (a wall-tag pulse, a listening augment, a silent landing) rather than +8% energy regen.
8. **Free-form procedural geometry.** DRG tried it and abandoned it: constrain generation to authored room/compound grammars and vary the contents.
9. **Uniform corridor geometry.** In a point cloud, two similar corridors are literally indistinguishable; every space needs a scale signature.
10. **Any inconsistency in the audio pipeline.** CS2's dropped-footstep incident shows that a single unreliable frame of audio in an audio-primary game costs more community trust than any balance mistake.

## Confidence & gaps

**High confidence:** Apex scan-meta history and the specific nerf numbers; Hunt's clue/Dark Sight mechanics and audio pillars; Mirror's Edge motion-sickness origin and the GDC red-color anecdote; the CANARI dark-wayfinding techniques; Crysis 1→2→3 nanosuit simplification; Titanfall 2 wall-run acceleration; the roguelite meta-progression consensus.

**Medium confidence:** Respawn's internal reasoning ("scans killed rat plays") is quoted through GameSpot, not a first-party design blog. Riot's counterplay philosophy is assembled from patch notes rather than a single design article. The MWO Target Decay/Radar Deprivation framing comes from community forums, reliable on mechanics but not on intent.

**Gaps:** (a) huntshowdown.com blocks automated fetching (HTTP 403), so the two best primary audio articles are cited via search summaries; (b) no GDC talk located specifically on Hunt audio or DRG procgen, only interviews; (c) FTL's power-routing design intent went uncovered — Barotrauma carried the thread; (d) Fade (Valorant) and Seer's post-2023 state not surveyed — treat the scan-meta narrative as ending ~Season 21; (e) no source found on echo/point-cloud-specific readability — that remains the genuinely novel risk and needs prototype playtesting rather than research.
