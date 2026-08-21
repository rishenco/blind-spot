# TASKS

## Iteration 1 — Core sensory experience  [DONE]
- [x] Shared math / AABB world / DDA raycast (brute-force cross-checked)
- [x] Player collision & step-up; map "Substation 7" + connectivity/standability tests
- [x] PointField ring buffer, aging shader, wavefront-from-data, voxel dedup
- [x] PulseJob / PulseQueue with per-frame ray budget
- [x] Three-Color Law palette; surface splatting; elliptical cone; tangential jitter
- [x] HDR target + ACES grade + bloom; adaptive quality
- [x] Repeated screenshot → critique → adjust passes

## Iteration 2 — Multiplayer  [DONE]
- [x] ws server, rooms with 6-char codes, lobby, weapon select, start
- [x] 20Hz authoritative sim with server-side movement validation
- [x] Perception firewall: server emits degraded Observations only
- [x] Pulse capture (elliptical cone + LOS) and the Reciprocity Law flash
- [x] Footstep events; ghost renderer with motion smear
- [x] **Stale-information acceptance test with two browser clients**

## Iteration 3 — Combat & information warfare  [DONE]
- [x] Judge + Whisper with asymmetric information cost; server hitscan
- [x] Tracers, impact blooms, gunshot bloom / whisper hiss, incoming-bearing arc
- [x] Sensor Spike, Decoy Shard, Echo Bomb
- [x] Death burst, respawn, relic drop

## Iteration 4 — Progression  [DONE]
- [x] XP sources, level thresholds, non-modal 3-card draft with server confirmation
- [x] All 12 upgrades across 3 tiers wired into the simulation

## Iteration 5 — Director's pass  [DONE]
- [x] Full match arc: heartbeat → pickup → sing → beacon → channel → win
- [x] Sudden death; rematch
- [x] Solo Walk tutorial with a live relic heartbeat
- [x] Real-input movement test (found: W walked backwards)
- [x] Perf breakdown; visual survey of every zone

## Known limitations (deliberate, not forgotten)
- Movement is client-authoritative with server validation (step clamp + collision
  re-simulation). Fine for a 2-player prototype; a determined cheat could still micro-teleport
  within the clamp.
- No lag compensation on hitscan: the server resolves against its own current positions.
- Audio is synthesised, not spatialised through HRTF — stereo pan + distance only.
- Perf verified only under software GL; GPU numbers are inferred from the measured ratios.
