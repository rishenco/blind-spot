# BLIND SPOT — Visual Brief

*v1.0, 2026-08-23. Output of the Phase-1 visual interview. This document REFINES
`doc/vision.md` — it never overrides it. Where vision.md states a law, the law wins.*

## 0. Purpose

The visual prototype exists to answer one question: **is a sound-painted world readable and
thrilling at parkour speed?** Everything below serves that. Three competing art directions
("schools") will be built on one shared engine; this brief holds what is common to all three.

## 1. Locked decisions (from the interview)

1. **Register: tense flow.** Ghostrunner / Mirror's Edge kin. The dark is a puzzle you rush;
   dread exists but mastery converts it to speed. Visuals are crisp and confident, never
   oppressive, never horror-first.
2. **Reveal: hybrid by verb.** Deliberate acts (Q/E pings, detonations) propagate a visible
   wavefront; geometry crystallizes as the front passes. Movement sounds (footsteps, slides,
   landings, prop knocks) paint instantly — headlights, not questions.
3. **Grain: dots + edge lines.** Surfaces are filled with dots; edges and holds are crisp
   micro-lines. "Dots are matter, lines are holds" (vision §5) is universal.
4. **Structural lattice.** Dots sit on a fixed, evenly-spaced world lattice — the same surface
   always lights the same dots at the same spots. No random scatter, no shimmer. Dense up
   close; per-dot stable dither thins coverage with paint intensity, distance fades alpha so
   the far field never becomes mess.
5. **Finish: restrained micro-glow.** Each splat carries a tight halo. Fresh paint feels
   energized; the frame as a whole never blooms out. No heavy neon.
6. **Body: hands on interaction.** Faint machine hands/forearms appear only during mantles,
   vaults, ladder climbs (and later: handoffs). Invisible in plain running.
7. **Void: absolute black.** #000000. Unknown space is nothing. The only exception is the
   contact shell (≤2 m, vision §3.1). No ambient light, no fog, no vignette that implies space.
8. **Speed: camera energy.** FOV widens on sprint, head cadence locks to footfall audio,
   landings dip, slides tilt. No motion blur (vision §12). The world itself never fakes speed.
9. **Dog: readable quadruped.** Rendered in the same lattice as the world, wrapped in its
   jagged red-orange event smear. Pose, gait, and facing must read — the Lantern Test depends
   on it.
10. **HUD: all in the reticle.** One glance point. The Halo ring = current audible radius
    (brightness) with a hum pitch to match; a thin arc on the same ring = energy; chip pips
    sit under it (later). Nothing in the corners. Debug overlays are dev-only.
11. **Ping look: racing rim.** The wavefront is visible only where it touches matter: a bright
    rim races across surfaces, the lattice crystallizes behind it and cools from ice-white.
    Empty air shows nothing.
12. **Aging: thin + dim.** As paint cools, dots drop out; edge-lines are retained longest.
    Old areas decay from cloud → line drawing. The permanent memory skeleton is a sparse dim
    navy blueprint (alpha floor ~0.22, vision §3.6).
13. **Noise-makers are stains.** The event-layer marker at a sound's origin renders as a
    soft stain (The Last of Us listen-mode kin), not a crisp icon. Signal quality drives
    definition: a close, loud source is a bright, tight, almost-shaped stain; a far, weak,
    or through-wall source is a dim, spread, vague smudge. Distance and loudness are read
    at a glance from how *defined* the stain is.

## 2. Derived rendering rules (binding for all schools)

- **Lattice:** world-axis-aligned triplanar grid, spacing ~0.18–0.25 m (tune). Per-dot stable
  dither value decides drop-out order for both intensity and age thinning — the same dots
  always drop first, so re-scans refresh in place (vision §12).
- **Age is temperature, in-family only:** fresh ice-white → cyan-family hue → dim navy →
  skeleton floor. Each school picks its exact ramp inside the cyan family; age must be a
  monotone, unmistakable read. Matter NEVER takes an event source's color (vision §3.2).
- **Event layer** is transient markers at origins, colored by source (vision §3.2 table:
  self amber, dog red-orange jagged, prop pale yellow, objective gold, detonation white,
  teammate green+glyph). Shape + motion always accompany hue (colorblind law).
- **Noise stains:** the marker is a soft additive billboard stain at the fuzzed origin.
  Define `quality ∈ [0,1]` from intensity-at-listener, distance / hearing range, and wall
  count. High quality → small radius, high alpha, defined texture; low quality → large
  radius, low alpha, blurred, with visible positional vagueness (the ±2 m through-wall fuzz
  from vision §3.4 is drawn as spread, using a stable per-event seed — no jitter). Repeating
  sources (dog gait, slides) re-stamp, so a moving source reads as a moving smudge trail.
  Fade 2.5–6 s. Per-source texture keeps the hue+shape law: dog stains are jagged and pulse
  with the gait; prop stains ring outward; self stains are soft. A stain is always airy and
  diffuse — it must never be mistakable for lattice geometry (vision §12: a warm silhouette
  must never read as near geometry).
- **Rim** = the moment `now − paintTime` is small. `paintTime` includes propagation delay for
  wavefront events, so the rim choreography falls out of the data; schools style it (width,
  brightness, trail) but may not change its timing.
- **Ghosts** (vision §3.7): frozen pose snapshot + 0.3 s motion smear, cools hot → rust
  ~10 s, then visibly dissolves. Never interpolated or predicted.
- **Distance discipline:** beyond ~20 m bias to edges and cap screen-space density; hard
  window 45 m and ±1 floor (vision §3.6, §12). Near = cloud, far = drawing.
- **Near field: dots stay dots** *(user ruling, 2026-08-23, on the M3 captures)*. A splat is
  drawn at its projected footprint only up to a small screen-space cap (order 8–14 px at
  1080p; each school tunes inside its own brief's stated dot sizes). Literal footprint
  splatting at arm's length — large soft discs — is rejected. The near field reads as a
  crisp sparse lattice over black with the 2 m contact shell under it; "nearby reads as a
  cloud" is achieved by density and brightness, never by disc size. Vision §12 "splats
  sized to voxel footprint" is a ceiling (a dot never grows past its cell), not a mandate
  to fill the cell at any range. A loud flash may briefly saturate individual fresh dots —
  bounded at ≤6 % of the reference frame at its peak, and never as contiguous sheets (the
  largest saturated region stays one dot's area) — which is what "brightness carries the
  near read" costs in a look with no headroom above white; art looks keep freshness inside
  their own ramp's headroom instead.
- **Comfort:** FOV 80–110 (sprint kick stays inside), no motion blur, reduce-flashing mode
  must remain implementable (no school may depend on strobing), chroma-not-luminance pulses,
  ping spacing ≥0.75 s, splats ≥2–3 px and temporally stable.

## 3. The three schools (Phase-4 proposals)

All three obey §1–§2. Each gets a full brief in `doc/looks/<school>.md`.

- **Phosphor** — oscilloscope heritage. Green-leaning cyan, dots with faint persistence
  afterglow like a slow-decay CRT, hairline lab-instrument reticle. The world as a beautiful
  sonar scope. The warmest machine look.
- **Blueprint** — drafting heritage. Ice-blue/white, strongest edge-line emphasis, lattice
  reads as fine graph paper wrapped over surfaces, annotation-tick reticle. The world as a
  living technical drawing. Maximum clarity.
- **Signal** — raw-data heritage. Electric cyan with a whisper of chromatic fringe, squarer
  samples, paint lands with a one-frame decode resolve, burst-like event markers. The world
  as a decoded transmission. The most aggressive look.

Schools differ in: exact palette ramp, dot/splat shape and micro-glow character, edge-line
weight, rim styling, event-marker language, ghost dressing, reticle dressing, post chain.
Schools may NOT differ in: simulation, timing, radii, lattice positions, aging semantics,
event colors' meanings, comfort rules.

## 4. What the prototype must let a tester feel

1. Sprint a corridor lit only by their own footfalls and trust it (Blindfold Gauntlet seed).
2. Fire an E-ping down a hall and *watch the question travel*.
3. Track a patrolling dog through a solid wall by its gait-paint (Lantern Test seed).
4. Watch a dog stop, vanish, and leave a cooling ghost.
5. Kick a can and regret it — the trap paints the room and the Halo flares.
6. Stand still in absolute black, hear nothing, see only the old navy skeleton, and feel
   the map they bought.
