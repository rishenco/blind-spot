# TASKS

## Iteration 1 — Core sensory experience  [IN PROGRESS]
- [x] Shared math / AABB world / DDA raycast (+ brute-force test)
- [x] Player collision & step-up
- [x] Map "Substation 7" + connectivity test + ASCII preview
- [x] PointField ring buffer + aging shader + wavefront-from-data
- [x] PulseJob / PulseQueue with per-frame ray budget
- [x] shared/config.ts from the design brief
- [ ] Client bootstrap: renderer, pointer lock, controller wiring
- [ ] Pulse on click w/ cooldown; touch radius; HUD
- [ ] Three-Color Law palette pass (cyan matter / orange life / gold objective)
- [ ] Screenshot → visual critique → adjust (x3 minimum)
- [ ] Relic in world + heartbeat reveal

## Iteration 2 — Multiplayer
- [ ] ws server, room create/join with 6-char code, lobby, start
- [ ] Server sim: authoritative positions, movement validation
- [ ] **Perception firewall**: server emits Observation events only
- [ ] Pulse capture (cone + LOS) -> FULL ghost to scanner
- [ ] Pulse flash -> COARSE to the other player (Reciprocity Law)
- [ ] Footstep events (walk/sprint/crouch radii)
- [ ] Ghost renderer: posed humanoid point sprite, frozen, motion smear
- [ ] **Stale-information acceptance test** with two Playwright clients

## Iteration 3 — Combat & information warfare
- [ ] Judge + Whisper, server hitscan, hit confirm
- [ ] Tracers + impact blooms (asymmetric visibility)
- [ ] Gunshot bloom / whisper hiss
- [ ] Sensor Spike, Decoy Shard, Echo Bomb
- [ ] Death burst + respawn + relic drop

## Iteration 4 — Progression
- [ ] XP sources, levels, non-modal 3-card draft
- [ ] Tier 1 upgrades (Long Lens / Wide Lens / Soft Step / Keen Ear)
- [ ] Tier 2 + Tier 3 upgrades if stable

## Iteration 5 — Director's pass
- [ ] Playtest, cut weak mechanics, tune pacing
- [ ] Audio pass
- [ ] Final screenshots + acceptance tests
