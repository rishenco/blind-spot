# Look proposal 1 — PHOSPHOR

*School: oscilloscope heritage. The world as a beautiful slow-decay sonar scope.
Obeys `doc/visual-brief.md` §1–2 and the Look contract in `doc/engine-plan.md` §9.*

## Fantasy

You are reading the world off a cathode instrument that remembers. Every dot is a struck
phosphor grain: it flares, breathes, and refuses to die completely. Sound doesn't just
reveal the world — it *charges* it. The warmest of the three machine looks: green-leaning
cyan, soft persistence, hairline graticule UI. Tense flow reads as: a lab instrument
running much too fast.

## Palette (matter stays cyan-family; age is temperature)

| Role | Hex | Notes |
|---|---|---|
| Void | `#000000` | absolute |
| Matter: fresh flash | `#EFFFF8` | first 0.4 s |
| Matter: hot | `#7DFFD4` | |
| Matter: mid | `#1FD4A8` | the look's signature tone |
| Matter: cool | `#0E6B5B` | |
| Matter: skeleton | `#07332C` at alpha 0.22 | permanent |
| Edge lines | `#BFFFE9` | slightly brighter than dots of same age |
| Hold lines | `#E4FFF4` | +20 % width |
| Rim | white core `#FFFFFF` → `#7DFFD4` skirt | |
| Events | self `#FFB454` · dog `#FF5A3A` · prop `#E6D97A` · objective `#FFCF4D` · detonation `#FFFFFF` | per law |

## Dots

Round soft-core splats (gaussian-ish falloff inside the point sprite), 3–4 px at 1080p
near, micro-glow as a tight 1.5× halo baked into the sprite (no bloom pass). Fresh dots
overshoot ~35 % brightness for 0.4 s then settle (the phosphor strike). **Persistence:**
a low-mix accumulation buffer (previous frame × 0.90 composited under the current frame)
gives everything a faint trailing afterglow — THE school signature. Reduce-flashing: the
overshoot becomes a plain ease; accumulation stays (it is steady, not strobing).

## Edges & aging

Edge lines are hairline (1.5 px) with the same afterglow. Aging follows core semantics;
Phosphor's dressing: the cool→skeleton transition adds a barely-visible per-dot flicker
of ±3 % luminance ONCE (a dying grain), never repeating (skip entirely under
reduce-flashing). Old areas read as a scope trace that has nearly, but never fully, faded.

## Rim (racing rim)

A soft-edged bright band ~0.6 m deep sweeping across surfaces, with a 0.2 s afterglow
tail courtesy of the accumulation buffer — the rim visibly *drags* light behind it.
E-ping rim slightly elongated along the beam direction.

## Noise stains

Soft gaussian smudges, like a fingerprint of light on the scope glass. High quality:
tight (0.5–1 m), bright core, faint concentric ring. Low quality: 2.5–4 m wide, 20 %
alpha, no core — pure breath. Dog stains pulse once per gait tick and carry 2–3 jagged
darts of `#FF5A3A` toward the movement direction; prop stains ring outward once;
objective stains breathe on a 4 s cycle. All stains inherit the afterglow (smudge trails
behind a moving dog — the Lantern rig's key read).

## Dog & ghosts

The dog cloud renders in matter cyan (law) wrapped in its red-orange stain + smear darts.
Ghosts: the frozen pose keeps afterglow for its first second (it visibly "stops"), then
cools `#FF5A3A → #8A3B2A` rust over 10 s and dissolves dot-by-dot (dither order).

## Hands, halo, HUD

Hands: dark forearms with phosphor-edge outlines (`#BFFFE9`), faint screen-space
afterglow while moving. Halo: a fine graticule ring — hairline circle with tick marks
every 30°, brightness = audibleRadius; energy is a second thinner arc inside it, gap
opens clockwise as energy spends; text-free. A tiny center dot as reticle. Everything in
`#9FFFE0` tones, events never recolor the halo.

## Post chain

1. Accumulation (persistence) buffer, mix 0.90.
2. Very fine static grain (1 % luminance, chroma-free) — scope glass, not film.
3. Subtle horizontal 1-px line pattern at 4 % opacity, static (no roll). Off under
   reduce-flashing? — it is static, so it stays; the DYING-grain flicker and strike
   overshoot are the flags that soften.
No chromatic aberration, no vignette, no curvature.

## Don'ts

No green matter drifting out of cyan-family into pure `#00FF00` scope cliché; no rolling
scanlines; no bloom pass; afterglow mix never above 0.92 (porridge risk); stains never
develop hard edges.

## Tuning surface (`src/looks/phosphor/params.ts`)

`ACCUM_MIX`, `STRIKE_OVERSHOOT`, `STRIKE_MS`, `RIM_DEPTH`, `RIM_TAIL`, `GRAIN_AMT`,
`STAIN_Q_CURVE`, dot size/glow ratios, palette table above.

## Acceptance moments (screenshot each via `?autotest` + manual)

1. Sprint trail in C: amber self-stains + afterglowing footfall pools behind you.
2. E-ping the tank: rim drag across its curve; silhouette mass readable in one ping.
3. Lantern rig: dog smudge-trail crawling along the listening wall, fuzzed paint blobs.
4. Ghost: dog pause in E — freeze, rust, dissolve.
5. Skeleton hall after 2 min quiet: near-dead scope trace, still navigable.
6. F7 detonation: white strike + longest afterglow of any event, then fast settle.
