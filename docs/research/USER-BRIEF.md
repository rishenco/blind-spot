# Owner's concept brief (verbatim, 2026-08-22)

I want to develop a game. I have the following view of what it's about:

* [core] You can see things using echolocation, echolocation is manual/automatic with interval - so you see stale picture of things. You can gain experience points and upgrade your skills (in the skill tree): echo-location (as a fundamental mechanic) and other stuff (e.g. your gun, speed, stealth, etc.)
* [core] You can hear things (even though your vision is delayed)
* [core] You have good parkour mechanics: running, climbing, jumping, etc.
* [not sure] echo-location is similar to scanner sombre, different kinds of textures get different colors (e.g. other players are red (enemies) / green (teammates)), echo scanner can be upgraded to send signals in different directions at once and have pulses bounce off up to N times
* [not sure] Maps should have traps / challenges - e.g. moving platforms
* [not sure] It should have coop
* [not sure] final game I imagined (not one we must build, just for inspiration). You play as robots that can get "augmentations" (common augmentations or "xp" augmentations give you boost to xp and allow to get new skills in the skill tree; legendary augmentations give you new weapon abilities, or act as move detection grenades, or whatever). You spawn on a map and need to capture the flag that is hidden somewhere on the map. What stops you: traps of the map, other players. Modes: Solo (training), 1-vs-1 (you play against another user), 2-vs-2 (like wingman in cs). Ultimately, it is a coop rogue-like game.
* [not sure] Stamina system: a single bar of "energy" points that allow you to make echo-location requests, shoot and run.
   * You constantly gain stamina points (in the lore of robots it could be the nuclear engine working)
   * You can set up the echo-location settings (e.g. bouncing echo-location is more costly), echo-location interval (e.g. from 0.1s to 3s), running speed, gun modes, etc. Everything compounds and takes energy from the single source.
   * Then you adjust settings after boosting the stamina engine.
* [problem] I am not sure how to make it: interesting (not boring), visually non-glitchy and non-confusing, intense. Also, I don't know what kind of maps I should pick.

## Session goal
Prepare a prod-ready design doc for this game, or say it is a no-go.

## Context discovered in the repo
A previous session built and shipped a complete 1v1 browser prototype ("BLIND SPOT", TS/Three.js/Node) on this exact concept, then the owner reset the working tree (history preserved). The v1 docs are in ../legacy/. The owner has not yet said whether v1's design choices should be treated as baseline or as one discarded draft — surface this as an open question, treat v1's *validated learnings* as evidence either way.
