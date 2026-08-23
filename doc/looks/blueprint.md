# Look proposal 2 — BLUEPRINT

*School: drafting heritage. The world as a living technical drawing plotting itself in
real time. Obeys `doc/visual-brief.md` §1–2 and the Look contract in
`doc/engine-plan.md` §9.*

## Fantasy

Your sensor doesn't show the world — it *drafts* it. Every sound is a plotter pass:
lines snap first, fields hatch in behind them, and what survives age is exactly what an
architect would keep — the edges. Ice-blue on black, ruthless clarity, annotation-tick
UI. The line-first school: of the three looks, this is the one where "dots are matter,
lines are holds" becomes the entire aesthetic. Tense flow reads as: sight-reading a
drawing at 6 m/s.

## Palette

| Role | Hex | Notes |
|---|---|---|
| Void | `#000000` | absolute |
| Matter: fresh flash | `#F6FCFF` | first 0.3 s |
| Matter: hot | `#BBE7FF` | |
| Matter: mid | `#4FA8E0` | signature tone |
| Matter: cool | `#1C4E78` | |
| Matter: skeleton | `#0C2B47` at alpha 0.22 | permanent |
| Edge lines | `#DFF3FF` | **brighter than any dot of equal age** |
| Hold lines | `#FFFFFF` core, `#DFF3FF` skirt | +tick terminals (below) |
| Rim | `#FFFFFF`, hairline | plotter head |
| Events | self `#FFB454` · dog `#FF5A3A` · prop `#E6D97A` · objective `#FFCF4D` · detonation `#FFFFFF` | per law |

## Dots

Small, crisp, round-square (superellipse sprite), 2.5–3 px, minimal glow (a 1.2× skirt),
NO overshoot — Blueprint never flares, it *registers*. The lattice must read as fine
graph paper wrapped over surfaces: at fresh+close density the grid alignment is plainly
visible (this is the structural-lattice decision made loud). Fresh paint arrives dots-
snap-in with a 60 ms ease, no flicker.

## Edges & aging — the school's core

Edges lead everything. On any paint event covering an edge, its line draws in FIRST
(80 ms wipe along the segment), dots hatch in behind. Line weight: hairline 1.5 px far,
2.5 px near. Holds get **tick terminals** — tiny perpendicular end-marks like dimension
ticks — making grabbable lips read as annotated. Aging: dots thin out exactly per core
semantics but edges dim only to skeleton floor and never thin — an old room is a pure
navy line drawing (the memory skeleton as an actual blueprint). The cool stage
desaturates slightly toward slate before settling in navy.

## Rim (racing rim)

A hairline white front — the plotter head — with NO tail and a 0.15 m bright zone. On
surfaces it reads as a precise sweep line; where it crosses an edge, the edge flashes
one frame brighter (crisp, non-strobing single highlight; under reduce-flashing this
becomes a 120 ms ease).

## Noise stains

Graphite smudges: matte, soft, minimal glow — pencil shading on the drawing, distinctly
NOT geometry. High quality: small dense smudge with a faint containment circle (a
draftsman's mark) and 1–2 short hatch strokes oriented toward the source's heading. Low
quality: wide, pale, edgeless smudge, containment circle absent — an uncommitted pencil
cloud. Dog stains: the hatch strokes jag; prop stains: a single containment ring that
expands and fades; objective: gold smudge with a tiny diamond mark (shape channel).

## Dog & ghosts

Dog cloud in matter tones, but its SILHOUETTE outline (depth-edge of the cloud) is drawn
as a fine line — the drawing convention applied to the enemy; red-orange stain + jagged
hatch smear on top. Ghosts: onion-skin — the frozen pose collapses to its outline line
work within 1 s, cools to rust `#7A3B2E`, then the outline erases along its length
(a line being unplotted) over the last 2 s.

## Hands, halo, HUD

Hands: pure line-work — wireframe robot hands, no fill, `#DFF3FF`, with one dimension
tick at the grip point during mantles. Halo: a thin ring with 4 compass ticks;
brightness = audibleRadius; energy is a fine arc with 10 graduation marks (empty marks
vanish); reticle is a 3-px crosshair gap. Under the ring, chip pips would sit as small
squares (future). All UI hairline, all `#DFF3FF`, nothing filled.

## Post chain

None. Blueprint is the control group: raw renderer output, no accumulation, no grain, no
aberration. Its identity must survive with zero post — clarity IS the post.

## Don'ts

No glow ramps, no afterglow, no texture noise; edge brightness hierarchy (holds > edges >
dots) may never invert; stains must never gain sharp boundaries; the graph-paper read
must never become a moiré (cap dot size growth near camera; sprite superellipse, not
hard square, to avoid aliasing crawl).

## Tuning surface (`src/looks/blueprint/params.ts`)

`EDGE_LEAD_MS`, `LINE_W_NEAR/FAR`, `TICK_LEN`, `DOT_SNAP_MS`, `RIM_ZONE_M`,
`STAIN_HATCH_LEN`, palette table above.

## Acceptance moments

1. Sprint C: the corridor as rushing graph paper; duct lip's hold ticks readable at 6 m/s.
2. E-ping the tank: plotter rim sweeps the cylinder; its edge circle draws before its
   surface hatches.
3. Lantern rig: pencil smudge sliding along the wall, hatch strokes pointing its heading.
4. Ghost: dog outline un-plotting itself in E.
5. Old B hall: a pure navy architectural drawing, holds still ticked.
6. High shelf survey of D1: near-cloud vs far-line-drawing depth discipline in one frame.
