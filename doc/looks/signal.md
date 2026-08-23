# Look proposal 3 — SIGNAL

*School: raw-data heritage. The world as a transmission being decoded in real time.
Obeys `doc/visual-brief.md` §1–2 and the Look contract in `doc/engine-plan.md` §9.*

## Fantasy

Nothing you see is the world — it is telemetry, decoded barely in time. Paint doesn't
appear; it RESOLVES: a burst of quantized samples that locks into the lattice a breath
later. Electric cyan, squared samples, a whisper of chromatic fringe on the newest
information only. The most aggressive of the three — Ghostrunner energy applied to
perception itself. Tense flow reads as: outrunning your own decoder.

## Palette

| Role | Hex | Notes |
|---|---|---|
| Void | `#000000` | absolute |
| Matter: fresh flash | `#F0FCFF` | decode frame |
| Matter: hot | `#6EE8FF` | |
| Matter: mid | `#17B4E8` | signature tone |
| Matter: cool | `#0D5E85` | |
| Matter: skeleton | `#082C40` at alpha 0.22 | permanent |
| Edge lines | `#C9F2FF` | |
| Hold lines | `#FFFFFF` core | dashed micro-pattern (below) |
| Rim | `#FFFFFF` + ±1 px chroma fringe | the only permanently fringed element |
| Events | self `#FFB454` · dog `#FF5433` · prop `#E6D97A` · objective `#FFCF4D` · detonation `#FFFFFF` | per law |

## Dots

Axis-aligned square samples (hard-ish edge, 1-px soft rim), 3 px near, micro-glow as a
faint dark-cyan underlay square 1.6× behind each sample (reads as sensor cell, not
bloom). **Decode resolve:** fresh paint appears in two steps inside 100 ms — first frame
a quarter-density ordered-dither preview at 2× size, next step the full lattice locks in
at true size. Under reduce-flashing the preview step is skipped (plain 100 ms ease).
Samples never rotate; the grid is the truth.

## Edges & aging

Edge lines crisp, with holds carrying a fine dash micro-pattern (6 px dash, 2 px gap,
screen-space) that makes grabbable lips read as "active" without animation. Aging per
core semantics; Signal's dressing: the hot→mid transition quantizes brightness in 4
visible steps (posterized cooling — data losing precision), then cool→skeleton is
continuous. Old areas read as low-bitrate memory: sparse squares + intact edges.

## Rim (racing rim)

A 0.4 m band of white samples at 2× brightness with ±1 px RGB split on its leading edge
only. Behind the rim, the decode resolve plays. On the E-ping, the rim band is slightly
denser along the cone axis — the beam reads directional. Chroma split is chroma-only
(no luminance pulse) and small; under reduce-flashing it drops entirely.

## Noise stains

Interference blobs: a soft stain whose interior carries a faint animated noise texture
(2–3 Hz shimmer, chroma-stable, amplitude scales with quality — never strobes). High
quality: compact, bright, its noise coherent (almost resolving into a shape). Low
quality: wide, dim, noise incoherent — static you can't lock onto. Dog stains: jagged
sawtooth perimeter, one radial glitch-dart per gait tick toward its heading; prop: a
single square ripple; objective: gold stain with a slow 4 s coherence breath. Under
reduce-flashing, interior shimmer freezes to a static texture; darts remain (motion, not
flash).

## Dog & ghosts

Dog cloud in matter cyan (law), but sampled one lattice step coarser than the world —
the decoder prioritizes terrain over threats; its red-orange stain + darts do the
threat-shouting. Ghosts: freeze, then dissolve by ordered dither (samples wink out in
Bayer order) while cooling to rust `#83372A` — data being deallocated. The 0.3 s smear
renders as 2–3 offset coarse copies at decreasing alpha (a dropped-frame trail), never a
blur.

## Hands, halo, HUD

Hands: filled matte dark panels with `#C9F2FF` edge seams; on grab, the contact edge
runs its dash pattern once. Halo: a segmented ring of 24 short strokes (like a signal-
strength dial) — lit stroke count + brightness = audibleRadius; energy is an inner thin
bar-ring that drains counterclockwise in visible quanta of ~4; reticle is a single
square dot. UI in `#9FE8FF`; events never recolor it. Everything monospaced-feeling,
nothing decorative.

## Post chain

1. Chromatic fringe: applied ONLY via rim/stain materials (no full-screen aberration).
2. A 0.75 % static blue-noise dither over the final frame (kills banding on stain
   gradients; imperceptible as texture).
No accumulation, no scanlines, no vignette, no full-screen glitch — Signal's glitch
lives exclusively in births and deaths of information (decode, dissolve), never idle.

## Don'ts

Never full-screen RGB split (comfort + porridge); never glitch at rest — a still,
painted room must look perfectly stable; posterized cooling stays subtle (≤4 steps, low
contrast); square samples must not alias-crawl when strafing (superellipse corners ~15 %).

## Tuning surface (`src/looks/signal/params.ts`)

`DECODE_MS`, `DECODE_PREVIEW_SCALE`, `RIM_FRINGE_PX`, `POSTERIZE_STEPS`,
`STAIN_NOISE_HZ`, `DASH_PATTERN`, dot size/underlay ratios, palette table above.

## Acceptance moments

1. Sprint C: footfall bursts decoding just ahead of you — the decoder barely keeping up.
2. E-ping the tank: fringed rim + resolve wave climbing the cylinder.
3. Lantern rig: incoherent static blob tightening into an almost-shape as the dog nears
   the wall's far side.
4. Ghost: Bayer-dissolve of a paused dog in E.
5. Old B hall: low-bitrate memory — sparse squares, crisp edges, dashed holds.
6. F7 detonation: the one sanctioned violence — full-white decode burst through the
   floor patch, then instant discipline again.
