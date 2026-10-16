# RAMPAGE PEAK — MVP design

One plateau, one ram, one topless bodybuilder. Third-person. Low poly, fast, a bit stupid.
**Win: the ram goes off the cliff. Lose: you do.** No health, no meters. Restart is instant.

The only way to win is to fool the ram, and to fool it you have to let it think it fooled you.

## Arena
Small rocky summit, ~13 m across (rim radius 5.9–7.0 m), sheer drop on every side, no invisible walls.
Small on purpose: there's no safe middle, every fight happens near an edge.
Background: low-poly mountain ranges, sea of clouds with holes, gradient sky, low sun.

## Controls
| Input | Action |
|---|---|
| Mouse | camera |
| WASD | move |
| Space | dodge: quick short dash (~2.4 m), can't be hit, can take you off the cliff. ~0.45 s cooldown after |

When the ram hits you, you fly ~5 m in its charge direction. You can steer a little in the air (WASD).
Land on the plateau = fine (but now you're near an edge). Miss = fall.

## The ram: smart, except when locked on
- **Stalks.** Circles you at ~4.5 m, always trying to get *you* between *it* and the nearest rim. Keeps
  circling even when lined up, so you keep turning and repositioning. Never goes near the rim itself.
- **Paws** (~0.9 s, shorter later) facing you, then **charges in a straight line** (no homing).
- **Locked on while charging.** It plans to stop *on you*, so it doesn't brake for the rim.
  - You stay in its line → it hits you, then brakes as hard as it needs to stay up (it's smart).
  - **You leave its line late** (it's ~1.5–4 m away) → it notices after ~0.1 s and brakes as hard as it can.
    Too little room left = it goes over. **This is the only way to win**, and it only works with the rim
    right behind you, which is exactly where the ram wants you.
  - **You leave its line early** (it saw it coming) → it stops safely and immediately charges again with
    almost no wind-up, while your dodge is still on cooldown.
  - Stops right at the rim → teeters (comedy), backs off.
- **Feints** (from the 3rd charge, more often later): charges a couple of meters and stops short on
  purpose. Dodged it? Instant real charge. Held your nerve? A short paw, then the real charge.
- **Escalation** every charge: faster charge, shorter wind-up and stalking, more feints.

Standing in the middle doesn't work: the ram lines up anyway, the first hit throws you near the rim,
the second throws you off.

## The fall (either character)
Slow-mo at the lip → the body falls physically, collides with the mountain, ragdolls after the first
impact → through the cloud sea → valley floor → **BOOM** → cut back up: the winner on top
(ram headbangs / you flex) → any key retries.

## Later (not MVP)
Time limit: crumbling summit (rim chunks break off over time). Flex (taunt) mechanics.
Riding, more attacks, more levels, gamepad.

## Tech
Three.js + TypeScript + Vite, procedural low-poly meshes (`src/models/*`, previewed in `viewer.html`),
procedural Web Audio. Deployed to GitHub Pages from `gh-pages`.
Headless balance check: `node scripts/bot.mjs "http://localhost:5173/?test" '[4.4,3.6,2.6,1.8]' 3`
(player with back to the rim, dodging when the ram is N m away; `CHARGES=8` to test an escalated ram).
