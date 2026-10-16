# RAMPAGE PEAK — MVP design

One plateau, one ram, one topless bodybuilder. Third-person. Low poly, fast, a bit stupid.
**Win: the ram goes off the cliff. Lose: you do.** No health, no meters. Restart is instant.

## Arena
Rocky plateau ~18 m across, sheer drop on every side, no invisible walls.
Background: low-poly mountain ranges, sea of clouds below, gradient sky, low sun.

## Controls
| Input | Action |
|---|---|
| Mouse | camera |
| WASD | move |
| Space | dodge (quick dash, can't be hit — and can take you off the cliff) |
| LMB | kick — shoves the ram a short way; a long way if it's stunned |
| RMB | grab — press just as the charging ram reaches you: you flip it over your shoulder, it flies the way you face. Wrong timing = you get hit |
| F | flex (just for fun) |

When the ram hits you, you fly. You can steer a little in the air (WASD). Land on the plateau = fine. Miss = fall.

## The ram
One loop: **paw the ground (≈1 s warning) → charge in a straight line → if it misses, skid and stand stunned ≈1.5 s → turn → repeat.**
It brakes when it sees the edge, but late: dodge at the last moment near the edge and it skids off.
Gets a little faster over the fight.

## Ways to win
1. Dodge a charge near the edge — it skids off.
2. Kick it off while it's stunned near the edge.
3. Grab-flip it at the edge.

## The fall (either character, ~4 s, skippable)
Slow-mo at the lip → camera follows the faller down the cliff face → through the cloud sea →
valley floor → **BOOM** (dust, shake) → cut back up: the winner on top (ram headbangs / you flex) → any key retries.

## Later (not MVP)
Riding, more attacks (rear kick, feint), choice QTE, more levels, gamepad.

## Tech
Three.js + TypeScript + Vite, procedural low-poly meshes (`src/models/*`, previewed in `viewer.html`),
procedural Web Audio. Deployed to GitHub Pages from `gh-pages`.
