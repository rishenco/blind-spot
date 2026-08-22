# BLIND SPOT — Research Synthesis & Go/No-Go Assessment

*Synthesized 2026-08-22 from four research briefs (files 1–4 in this directory), the v1 prototype's recovered docs (../legacy/), and the owner's concept brief (../USER-BRIEF.md).*

---

## Verdict: CONDITIONAL GO

No evidence anywhere in the corpus says the mechanic can't work — and four independent lines say it can:

1. **The mechanic is proven fun.** Muffled Warfare (the only shipped PvP echolocation game) died of empty lobbies, not of boredom — players logged 189–655 hours. No echolocation game in the corpus died because the mechanic failed.
2. **The niche is empty where we'd enter it.** Nobody has ever shipped co-op roguelike echolocation. The 2026 wave of LIDAR-horror titles confirms live audience interest; none of them are multiplayer-action.
3. **The market shape fits.** 2025–26 breakouts are $5–12, co-op-first, one-sentence-hook, clip-generating games from teams of 1–7. A perception-rendering twist is explicitly the "fresh" category — and unlike Meccha Chameleon's asset-swappable hide-and-seek, a point-cloud renderer cannot be cloned by a Roblox farm in three weeks. The renderer is the moat.
4. **The tech is solved with known numbers.** ~1M points on mid-range GPUs (multiple independent benchmarks), per-player reveal state ≈ free bandwidth, Valorant-published server-side info gating fits this design natively. And the v1 prototype already validated the renderer, ghosts, and perception firewall in a *browser*.

### The conditions (each is evidence-backed, violating any reopens no-go)

- **C1. Co-op-first. Ranked 1v1/2v2 is cut from launch.** Symmetric small-N indie PvP is a confirmed death zone (Duel Corp: 2,485 → 8 CCU in 5 months at *Mostly Positive*; Spectre Divide: $60M → shutdown in 6 months; Rematch −95%). Co-op decays gracefully (R.E.P.O. holds 11% of peak 18 months later); PvP decays to zero. PvP later, only after a population exists, and asymmetric/party-framed rather than ranked-symmetric.
- **C2. One flagship mode, executed hard.** Mode sprawl (solo + 1v1 + 2v2 + co-op) = four populations and four balance surfaces; nothing in 2025–26 data rewards it. Solo exists as onboarding + 3am hedge, not as a marketed mode.
- **C3. Auto-pulse default with a floor ≥ ~0.3s; manual pulse is the tactical layer.** "Hold the trigger for 80 minutes" is the genre's loudest single complaint; 0.1s auto-pulse fails photosensitivity guidelines (XAG 118: >3 flashes/sec) on three axes at once, and 10Hz is functionally just vision — it deletes the game.
- **C4. Readability-under-movement is the project gate.** Scanner Sombre players got lost and misjudged depth with NO time pressure and NO parkour. Parkour at speed in a point cloud is the one genuinely unvalidated core claim. The first build milestone is the readability test: a playtester runs a parkour route on ~0.5s pulses without falling. Pass → everything else proceeds. Fail → redesign perception before building anything.
- **C5. Navigation affordances are funded from day one.** Perception (MC 56) proves getting-lost kills; shipped fixes exist (memory-skeleton persistence, scale-based landmarks, per-zone palettes, placed beacons). Dark spaces read ~30–40% bigger than they are — shrink maps accordingly (CANARI postmortem).
- **C6. Streamability constraints are honored in the renderer.** Chunky splats (≥2–3px), temporal stability (no per-frame noise), bright accents above the compression floor. Indie sales run on clips; near-black 1px noise is the worst case H.264 content that exists.
- **C7. Price $8–12, scope like a 1–4 person team, 12–18 months to Early Access.** Above $10 conversion halves. Comparable-timeline evidence: Lethal Company solo ≈ 16mo; 2–4 devs ≈ 3–5mo to MVP, 10–16mo to EA — plus this game's real tech risk on top.

---

## What the evidence locks in (design constraints the proposal should treat as law)

1. **Reciprocity** (v1's law, independently confirmed by the scan-meta history): every way of learning teaches the world about you. Bloodhound's orange wave, Sova's audible dart, Siege's noisy drones — self-telegraph is the fairness mechanism players accept. Un-counterable or long-uptime intel is the one they revolt against (Apex Seer 2021).
2. **Staleness is the differentiator** — and it ships as two named tunable stats (MWO precedent: Target Decay / Radar Deprivation). Scanner Sombre's permanent cloud killed tension; full erasure recreates Perception's lostness. Answer: detail decays, a dim memory-skeleton persists (v1's navy "memory" state — already built and tuned).
3. **Live things are a different kind of render than dead things.** No shipped game solved moving-objects-in-stale-clouds; v1's solution (frozen timestamped ghosts that dissolve with age + motion smear, never interpolated) matches exactly what the tech brief independently derived. This is the trailer shot.
4. **The no-fake contract** (Hunt): the system never lies. Every echo, blip, and sound was caused by something real. Player-made deception (decoys) is allowed *because* it's player-made and priced — v1's decoy rule (fakes render through the identical code path) is compatible and correct.
5. **Energy: one bar, but with Crysis-2 discipline.** Twitch-frequency actions (run, jump, climb) draw automatically; deliberate acts (big pulse, shot, special) are manual spends. Allocation/tuning happens at loadout time or safe points — never real-time sliders (Barotrauma's solved-then-automated trap). Souls-stamina tempo: the bar is a commitment budget; running dry must be dramatic and legible (MechWarrior heat).
6. **Self-readout is mandatory**: a Thief-light-gem / Chaos-Theory-style emission meter showing how visible/loud YOU currently are. Muffled Warfare's #1 gameplay complaint was "can't tell when I'm visible."
7. **Sound is authored as information**: no-fake contract, layered range bands (map-wide events vs intimate footsteps), placed sound-traps as level objects (Hunt's crows = our glass fields/chain curtains), HRTF via Steam Audio (now Apache-2.0 open source).
8. **The hidden flag uses Hunt's clue grammar**: successive clues that *eliminate* map regions (monotone narrowing, never hot/cold wandering), proximity read via density+brightness+audio, and an objective that broadcasts contact when two parties converge. v1's relic arc (heartbeat → carrier sings → lit extraction channel) is the same shape, already tuned for anti-stall.
9. **Maps: authored grammar + procedural contents** (DRG's lesson — free-form procgen failed), landmarks by silhouette scale (point clouds transmit mass before texture), long sightlines broken up, multiple entrances to objective rooms, verticality for parkour.
10. **Progression: verbs, not stats.** Roguelite community consensus is hostile to stat-tree meta-progression. XP tree and augmentations should unlock new *verbs and sidegrades* (wall-tag pulse, silent landing, keen-ear) — v1's 12 upgrade cards are all verb-changers and are a validated starting pool. Roguelike depth is retention, not acquisition — don't build it before the core loop is proven.
11. **Comfort/accessibility floor:** FOV 80–110 slider, toggleable bob/shake/blur, no motion blur by default, colorblind-safe encoding (hue + shape + motion, never hue alone), "reduce flashing" mode, chroma-not-luminance pulses.
12. **Tone: goofy robots beat cold robots** (market evidence: R.E.P.O.; tense+funny is achievable and sells; tense+sleek is a smaller audience). Tension comes from epistemic vulnerability, comedy from physicality and proximity voice. This is a genuine open fork for the owner — v1 was cold/horror-adjacent.

## Where the owner's brief and the evidence disagree (designer must resolve, explicitly)

| Owner's brief | Evidence says | Resolution space |
|---|---|---|
| 1v1 and 2v2 as core modes | Ranked small-N PvP = death zone (C1) | Co-op flagship; 1v1 custom/unranked side mode later; or asymmetric party PvP post-population |
| Echo interval settable 0.1s–3s | 0.1s fails photosensitivity + is "just vision" (C3) | Interval band ~0.3s–3s, upgrades widen options, not floor |
| Stamina powers everything, settings tuned continuously | Real-time allocation gets solved & automated; twitch actions must auto-draw | Loadout-time presets + discrete in-run spends; "engine profiles" swappable at safe points |
| Skill tree (XP) + augmentations | Stat-trees rot roguelites; verbs work | Tree of verbs/sidegrades; augmentations as run-scoped boons (Hades-shape) |
| Maps have traps/moving platforms | v1 cut moving geometry for scope; stale-vision + movers is readability risk AND opportunity | Movers are loud (heard always, seen only when pulsed) — traps become sound-first hazards; introduce few, telegraphed |
| "Robots" fiction | Market: goofy robots sell; v1: cold sonar-noir | Owner taste decision — the mechanics survive either tone |

## What v1 already answered (don't re-litigate without new evidence)

Rendering: surface splatting sized to voxel footprint; voxel dedup (rescans refresh in place); wavefront-as-data (zero per-frame CPU); elliptical pulse cone (circular wastes rays on floor/ceiling); tangential jitter (isotropic puffs walls into fog); memory layer stays bright (α floor 0.22); ghosts dissolve outward with age (t², 0.38m) because color alone doesn't read peripherally; high-threshold bloom; depth encoded ONLY inside the matter-color band (a warm silhouette can never read as near geometry — full rainbow depth rejected for exactly this). Perf: point cloud nearly free, full-screen post passes dominate. Architecture: perception firewall (server degrades to FULL/COARSE/TRACE before send; client renderer reads only the perceived-event store); static geometry ships to client, only dynamic reveals cross the wire. All of this ran in a browser at playable ratios under software GL.

## Open items the corpus could not settle

- Echophobia (1v3 LIDAR asymmetric, in playtest) is the closest thing to a competitor — watch it.
- No data exists on point-cloud readability at parkour speed (C4 gate exists because of this).
- FTL's power-routing intent, Hunt primary audio articles (403-blocked) — minor gaps.
- Exact 2026 figures for Meccha Chameleon vary by source (13M–20M+ units); directionally certain.
