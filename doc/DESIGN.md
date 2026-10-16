# RAMPAGE PEAK — MVP design

One plateau, one ram, one topless bodybuilder. Third-person. Low poly, fast, a bit stupid.
Win: the ram goes off the cliff. Lose: you do. Restart is instant.

## Arena
- Rocky plateau, ~18 m across, sheer drop on all sides. **No invisible walls** — anything can go over.
- Lip zone (outer ~1.5 m): walking slowly into it plays a teeter/arm-windmill animation (warning, not a wall).
  Running, rolling or being launched through it takes you over.
- Background: low-poly mountain ranges, sea of clouds below, gradient sky, low sun.

## Controls (keyboard + mouse)
| Input | Action |
|---|---|
| WASD | move (relative to camera) |
| Mouse | camera, soft lock-on to the ram |
| Space | jump |
| Shift | dodge-roll |
| LMB | kick |
| RMB | grab — the one "grab anything" button: horns, ledge |
| F | flex (taunt) |

## Player states — who controls what
| State | Player control | Exits |
|---|---|---|
| **Free** (on ground) | full: move, jump, roll, kick, grab, flex | any action / hit / walking off the edge |
| **Dodge-roll** (0.35 s, invulnerable) | none — direction locked at start. **You can roll off the cliff.** | Free; or Airborne if it ended past the lip |
| **Perfect dodge** (roll just as a charge reaches you) | time slows to ~20% for ~1 s, full control; ram stumbles past | Free |
| **Kick** (0.3 s) | can rotate, can't move | Free |
| **Jump / walked off** — Airborne | air steering ~60% | land → Free; reach the lip while holding RMB → Hanging; drop below the point of no return → Fall |
| **Launched** by a hit | 0.4 s tumble with **no control**, then air steering ~35% (enough to fight back toward the plateau) | same as Airborne |
| **Hanging** on the ledge (fingertips) | A/D shimmy, W/Space climb up (0.6 s), S let go | climb → Free; ram stomp → Fall |
| **Horn struggle** | mash LMB/RMB alternately to push; A/D turn the pair (aim at the edge); Shift lets go (stumble) | win → you throw the ram (Launched ram); lose → you're thrown (Launched) |
| **Fall** (point of no return) | no steering; any key = flail/flex pose (comedy only) | fall cinematic → BOOM → retry |
| **Flex** (1 s) | none; ram gets angrier (faster for a while) | Free |

## The ram (one ram, three attacks + one fake)
Each attack has a distinct, readable warning sign (Punch-Out!! logic).

| Attack | Warning sign | Effect if it hits |
|---|---|---|
| **Charge** | paws the ground 3×, snorts, lowers head | big horizontal launch |
| **Headbutt** (short range) | rears back a little | medium launch |
| **Rear kick** (when you're behind it) | ears flick, glances back | big **upward** launch — you steer in the air |
| **Feint** | same as the charge start, then stops and bleats | none (comedy) |

- Your launches are fixed per attack: the center is safe, the edge is deadly. Positioning is the game.
- **Ram dizziness** builds from kicks, wall/rock bumps and missed charges. Higher dizziness = it flies farther
  when kicked/thrown (Smash Bros %). Shown as wobble + stars, no numbers.
- Missed charge: it skids. If it skids past the lip it **scrambles at the edge** (hooves clawing) for ~1.5 s.
  Kick it then = it falls. Ignore it = it climbs back, angrier.
- Ram on stun / scramble can be grabbed safely; **catching a charge by the horns** (RMB at contact) is a
  risky parry: you get shoved back a few meters, then struggle.
- Ram stomps at your fingers when you hang on the ledge (telegraphed hoof raise) — shimmy away.
- Enrage over time: faster wind-ups, chains two attacks.

## Ways to win
1. Sidestep a charge near the edge → it skids over → kick the scrambling ram.
2. Build dizziness with kicks, then one kick sends it flying off.
3. Catch the horns, win the struggle facing the cliff → suplex it off.

## Fall cinematic (either character, ~4 s, skippable after 1 s)
1. Slow-mo at the lip, camera swings out over the drop.
2. Camera follows the faller: cliff face, ledges and rocks rush past; limbs windmill.
3. Punch through the cloud layer (whiteout + whoosh).
4. Valley floor rushes up → **BOOM**: dust mushroom, camera shake.
5. Cut back to the top: winner on the edge. Ram headbangs and bleats, or you flex.
6. Retry (any key) — no menus in between.

## Out of MVP (later)
Riding the ram, choose-your-action QTE on perfect dodge, more rams/levels, crumbling arena, gamepad.

## Tech
Three.js + TypeScript + Vite; procedural low-poly meshes and animation; procedural Web Audio SFX/music;
static build deployed to GitHub Pages from the `gh-pages` branch.
