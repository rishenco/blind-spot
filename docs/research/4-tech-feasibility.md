# Tech & Production Feasibility — Research Brief

## TL;DR

- **The reveal is a solved problem with known numbers.** Scanner Sombre did it with Unity's Shuriken particles and "easily millions of points"; the open-source clone [LANTICE](https://github.com/lunkums/LANTICE) benchmarked all three approaches: GameObject decals cap ~50k, compute buffer + `DrawMeshInstancedIndirect` handles 1M cleanly (2M cooked the dev's GPU), VFX Graph with points baked into a Texture2D (RGB=XYZ, A=visible) scaled best. Budget ~1M live points on mid-range.
- **The 0.1s auto-pulse is a hard no.** 10 Hz full-screen dark→bright is a textbook failure of [Xbox Accessibility Guideline 118](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/118) (>3 flashes/sec, ≥10% luminance change, ≥20% of screen) and WCAG 2.3.1/2.3.2. Floor the interval at ~0.25–0.4s and make the pulse a *contrast* event, not a luminance flash.
- **Per-player reveal state costs almost no bandwidth** — it's derived client-side from a ~40-byte pulse event. ~16 MB/client of point memory. Non-problem.
- **The anti-cheat story is unusually good — if designed for from day one.** The design legitimately needs enemy positions only at pulse instants, so Valorant-style server-side gating is a natural fit, not a retrofit. Real-time *hearing* is the leak that reopens it.
- **Streamability is the most underrated risk.** Dark + per-frame point noise is worst-case for H.264 at Twitch's ~6 Mbps ceiling.
- **Timeline: 6–9 months solo, 3–5 months for 2–4 devs** to a playable MVP. Do not benchmark against PEAK's month — those hits carried near-zero tech risk.
- **Multiplayer echolocation has thin market precedent**: Muffled Warfare is Very Positive (83%/87 reviews) but 0–20k owners with dead lobbies.

---

## Findings

### 1. Rendering the reveal

**Precedent.** Scanner Sombre (Introversion, 2017) used Unity's Shuriken particle system; Chris Delay called supporting the point count "probably the biggest technical challenge of the project" ([TechCrunch](https://techcrunch.com/2017/04/24/scanner-sombre-arms-you-with-lidar-for-a-gorgeous-creepy-explore-em-up/), [Geo Week](https://www.geoweeknews.com/blogs/scanner-sombre-eerie-first-person-lidar-exploration-game)). Points were colored by *depth* (rainbow, cribbed from Radiohead's "House of Cards") — that depth-coding does most of the readability work.

**Hard numbers.** LANTICE's three iterations: decals ≈50k ceiling (GameObject overhead), compute buffer = 1M points "no noticeable performance impact" / 2M = thermal failure, final VFX Graph solution with multiple `VisualEffect` instances when capacity is exceeded. Independent Unity work agrees on [~1M particles for decent VFX Graph performance](https://github.com/pablothedolphin/Point-Cloud-Renderer). Unreal's [Niagara LiDAR Point Cloud plugin](https://www.fab.com/listings/c5f5efa4-e7d2-4edd-830f-ee0cad90cf5d) states ~2M on GPU emitters, ~200k on CPU, using the same position-baked-to-texture trick; Unreal also ships a first-party [LiDAR Point Cloud plugin](https://dev.epicgames.com/documentation/en-us/unreal-engine/lidar-point-cloud-plugin-for-unreal-engine). Godot's GPUParticles3D has a [high fixed base cost](https://forum.godotengine.org/t/cpu-vs-gpu-particles-2d-performance-study-careful-gpu-particles-seem-to-have-a-high-base-cost/67850) and struggles with dense systems.

**The rate problem nobody mentions.** At 20k points/pulse and 10 Hz you generate 200k points/sec — a 1M cap is 5 seconds of history. Point budget and pulse rate are the same knob. Tie points-per-pulse to the energy bar and the problem self-regulates.

**Recommendation:** a bounded GPU ring buffer (500k–1M cap, oldest evicted, per-point `age` → fade/desaturate), rendered via VFX Graph or a custom instanced-indirect pass. Staleness becomes a shader parameter (`now - lastSeen`), not a buffer-management problem — which is exactly what you want, since decay *is* the mechanic. Persistent per-surface "paint" (writing last-seen-time into surface UV space or a sparse voxel grid) is O(surface area) instead of O(pulses) and never grows — hold as a phase-2 option if permanent mapping proves necessary. *Confidence: high on numbers, medium-high on the recommendation.*

### 2. Moving objects in stale point clouds

Shipped competitive games essentially **never** make stale enemy positions the primary read. Apex's Bloodhound scan is a 1s full-body reveal plus a ~3s tracking marker that *follows* the enemy ([Apex wiki](https://apexlegends.fandom.com/wiki/Bloodhound)). Sova's Owl Drone dart "periodically reveal[s] their location with real-time silhouettes over several seconds" ([Valorant wiki](https://valorant.fandom.com/wiki/Owl_Drone)). Siege drones are a live feed while the drone survives. The one canonical stale ghost is single-player: Splinter Cell: Conviction's [Last Known Position](https://splintercell.fandom.com/wiki/Last_Known_Position) — a white translucent silhouette representing *the AI's belief*, deliberately legible as a different category of information.

**Design implication:** stale ghosts read only when they are distinct *in kind* from live info. Concretely: (a) parent echo points to the character rig at pulse time so the silhouette is coherent, then detach/freeze; (b) timestamp every ghost and drive opacity + desaturation + dissolve from age; (c) store velocity at hit time and extrude a short motion streak so direction is readable; (d) invalidate on re-scan — a new pulse clears ghosts inside its cone so you never see two copies of one robot. *Confidence: high.*

### 3. Multiplayer architecture and anti-cheat

**Reveal state is derived, not replicated.** Send the pulse event (origin, orientation, time, cone, seed, ~40 bytes); every client re-traces locally against server-authoritative geometry. 1M points × 16 B ≈ 16 MB client-side. Per-player persistence is a non-problem for static geometry.

**Enemies are the whole problem — and the best asset.** A normal shooter must stream continuous enemy transforms. This design doesn't: the client legitimately needs an enemy's position *only at pulse instants*. Run the pulse trace server-side, return a snapshot (positions + sample points + timestamp), send nothing between pulses. That is Valorant's Fog of War shape, arrived at natively.

Riot's [published implementation](https://www.riotgames.com/en/news/demolishing-wallhacks-valorants-fog-war) is the reference: single raycast (too pessimistic, pop-in) → 10 raycasts ("10x more expensive") → precomputed **Potentially Visible Sets** with a voxel-to-voxel table lookup, "much faster than raycasting." Bounding boxes are expanded by velocity × latency with a look-ahead exceeding expected ping. Cost fell from ~50% of server frame time to **under 2%**, and it *reduced* network traffic. Riot's stated meta-lesson: they started security work extremely early so it shaped core systems. A [community CS2 equivalent](https://gameriv.com/cs2-modder-builds-a-server-side-anti-wallhack-that-could-also-boost-your-fps/) now exists, confirming the technique is tractable outside AAA.

**The audio leak.** Real-time hearing means continuous emitter positions — which is exactly what you just refused to send. Mitigation: transmit *events* (sound class, position, time) rather than transforms, gated server-side by an audible-range/propagation test. A continuously sprinting robot is the hard case; quantize position and rate-limit.

**Stacks, with shipped proof.** Lethal Company: Unity **NGO + Facepunch Steamworks transport**, host-authoritative P2P over Steam relay, no CCU bills ([modding wiki](https://lethal.wiki/dev/advanced/networking)). R.E.P.O.: Unity + **Photon PUN**, scaled 0 → hundreds of thousands CCU; the dev quote is "as a team with no prior experience with multiplayer, this was a breeze to get set up," followed by "making all the physics feel smooth for clients was something we struggled with for a long time" ([Photon blog](https://blog.photonengine.com/r-e-p-o-multiplayer-success-powered-by-photon/)). Note **PUN 2 is maintenance/LTS only** — new projects go Fusion 2 (100 CCU free, then $125/mo at 500 CCU, [pricing](https://doc.photonengine.com/photon/current/pricing)). FishNet/Mirror are free alternatives with the same host-authoritative shape. *Confidence: high.*

### 4. Spatial audio

[Steam Audio 4.8.1](https://github.com/ValveSoftware/steam-audio/releases) is now fully open source under Apache 2.0, with HRTF binaural, directivity, occlusion, transmission, reflections, reverb and pathing, supporting Unity 2017.3+, UE 4.27+, FMOD 2.0+ and Wwise 2023.1+. Godot only via a [third-party GDExtension](https://github.com/stechyo/godot-steam-audio) — a genuine risk when audio is a primary sense.

Cost knobs from the [Unity settings docs](https://valvesoftware.github.io/steam-audio/doc/unity/settings.html): real-time rays, bounces, IR duration and ambisonic order each trade CPU; baked reflections/pathing are far cheaper at runtime; reflections require tagged Steam Audio Geometry + materials, and Unity's built-in raytracer is explicitly "not suitable for modeling reflections, reverb, or pathing." Realistic small-team cost: **1–2 weeks to integrate and tag one map**, then continuous mix work. The plugin is not the hard part — making distance, material and elevation legible by ear is, and that is what separates Hunt: Showdown and Hellblade from everyone else. *Confidence: high.*

### 5. Perception, accessibility, streaming

- **Photosensitivity:** XAG 118 defines a flash as ≥10% luminance change with the darker value below 0.8; >~3/sec fails, ≥~20% of screen fails, and sustained low-intensity flicker also fails. A 0.1s auto-pulse violates all three axes at once. Mitigations: never ramp global luminance on pulse; keep a raised black floor so the pulse is a chroma/contrast event; clamp minimum interval; ship a "reduce flashing" mode that cross-fades reveals.
- **Motion sickness:** ~30% of players report some simulator sickness; vection from near-uniform full-field motion is the driver and motion blur is the single largest trigger. Parkour + camera shake + dark tunnels stacks all of it. Defaults: no motion blur, FOV slider, reduced head-bob/camera roll, persistent static reticle as a fixation anchor.
- **Colorblindness:** never encode team/enemy in hue alone ([Game Accessibility Guidelines](https://gameaccessibilityguidelines.com/ensure-no-essential-information-is-conveyed-by-a-fixed-colour-alone/)). Use hue + silhouette + motion signature; deuteranopia-safe triads (e.g. purple/indigo/salmon); presets *plus* a custom picker; recolor the point/outline layer only, never a whole-screen filter.
- **Streaming:** low bitrate turns dark gradients into banding and blockiness; pure black compresses fine, it's the *near-black detail* that falls apart, and testers report AV1 on YouTube handling dark scenes [worse than Twitch H.264](https://obsproject.com/forum/threads/streaming-quality-issues-in-av1-with-dark-images.168453/) in some cases. Twitch's practical ~6 Mbps at 1080p60 cannot carry per-pixel dithered points that change every frame. Mitigations: minimum screen-space splat size of 2–3 px (chunky, not 1-px salt-and-pepper); **temporal stability is mandatory** — no per-frame stochastic dithering or reprojection noise; coherent color regions; bright saturated accents (teammates, objectives) always above the noise floor; a streamer-mode exposure floor. *Confidence: high on guidelines, medium on the streaming magnitude — evidence is practitioner forums, not measured studies.*

### 6. Scope benchmarks

| Game | Team | Time | Stack |
|---|---|---|---|
| [Lethal Company](https://en.wikipedia.org/wiki/Lethal_Company) | 1 (Zeekerss) | Patreon devlogs from ~May 2022 → EA Oct 2023 ≈ **15–17 mo** | Unity, NGO + Facepunch |
| [Content Warning](https://en.wikipedia.org/wiki/Content_Warning) | 5 | **Feb–Apr 2024 (~3 mo)**, most in a month-long Seoul jam | Unity |
| [PEAK](https://www.gamedeveloper.com/business/aggro-crab-side-hustle-peak-has-sold-100-000-copies-in-24-hours) | Aggro Crab + Landfall | core in **~4 weeks**, ~4 mo total | Unity |
| R.E.P.O. | Semiwork | EA Feb 2025; 8.7M copies in March alone | Unity + Photon PUN |

All four are low-tech-risk social-comedy games. Blind Spot adds a custom render path, a stale-state simulation, server-side info gating, and gameplay-critical audio. **Estimates for an MVP** (echo render + parkour + 4p co-op + one map + one enemy, vertical-slice quality): **1 experienced dev: 6–9 months** (12+ if learning shaders *or* netcode); **2–4 devs: 3–5 months to playable MVP, 10–16 months to EA-shippable.** PvP adds dedicated servers, server-side FoW and lag comp: **+4–6 months** plus ongoing hosting. *Confidence: medium — estimates are inference from comparables, not measured.*

### 7. Hard no-go signals

No absolute blockers on rendering. Three conditional ones:

1. **0.1s auto-pulse as a shipped setting.** Fails photosensitivity guidance, blows the point budget, and 10 Hz is functionally just *vision* — it deletes the fiction. Fix by design.
2. **Matchmade PvP with client-held stale ghosts + real-time hearing.** A wallhack in a game whose intended information state is near-zero is catastrophically stronger than in a normal shooter. Either build server-side gating from day one (Riot's own lesson) or ship co-op/PvE only. Retrofitting on a small team is a no-go.
3. **Godot for this specific game.** Dense-particle base cost, no first-party Steam Audio, no shipped precedent at this combination.

Also flag: **Scanner Sombre's own reviews** say navigating "can become confusing and frustrating due to everything being made of the same beams of light," with players dying from bad depth reads ([PC Gamer](https://www.pcgamer.com/scanner-sombre-review/), [OpenCritic](https://opencritic.com/game/4248/scanner-sombre)) — in a game with *no* time pressure and *no* parkour.

---

## Recommendation for Blind Spot

**Stack:** Unity 6 (URP) · NGO + Facepunch Steam transport (or FishNet), host-authoritative over Steam Datagram Relay · Steam Audio 4.8.x + FMOD · VFX Graph point layer fed by a compute-shader pulse tracer. Unreal is fully viable (Niagara LiDAR plugin, better out-of-box networking) — pick it if the team is already Unreal-native. Team familiarity, not capability, should decide.

**Approach:** bounded GPU ring buffer of aged points (cap 500k–1M) with age→fade; a separate ghost pass for characters (points parented to the rig at pulse time, then frozen, timestamped, streaked, invalidated on re-scan); server-authoritative pulse tracing that returns snapshots and sends nothing between pulses; audio as gated events, not transforms.

**MVP scope:** one hand-built map, 4-player co-op, one enemy type, manual pulse + slow auto (0.4s floor), no PvP, no procedural generation. **Build the readability test first**, before any netcode: can a playtester run a parkour route at 0.5s pulse without falling? That is the project's real gate.

**Risks, ranked:** (1) readability under movement — the thing Scanner Sombre only half-solved standing still; (2) streamability, which drives indie sales; (3) anti-cheat, but only if PvP survives; (4) audio mix quality; (5) point budget, the *least* scary item.

## Confidence & gaps

**High:** point-count numbers, Valorant Fog of War mechanics, Steam Audio capability/cost, accessibility guideline thresholds, netcode precedents. **Medium:** streaming bitrate magnitude; timeline estimates (inference from dissimilar comparables). **Low / gaps:** no shipped multiplayer game combines persistent stale point clouds *with* server-side info gating — Echophobia (1v3 lidar-sonar hunter) is unreleased and would be the closest precedent to watch; no published data on point-cloud rendering under video compression; no dev postmortem found for a stale-reveal netcode design. The hybrid surface-cache persistence approach is a synthesis, not a shipped pattern.
