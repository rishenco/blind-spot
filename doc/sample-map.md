# BLIND SPOT — Sample Map "Dock Approach" (visual-test floor)

*v1.0, 2026-08-23. Phase-2 design. One authored floor whose only job is to exercise every
visual system at parkour speed. The engine implements this exactly as
`src/core/map/sampleMap.ts`; the top-down debug view must visibly match the plan below.*

## 0. Conventions

- Axes: **x east (0→45), z south (0→30), y up**. Interior floor top at y=0, interior height
  7 (ceiling slab 7..7.4). Exterior shell walls sit OUTSIDE the 45×30 interior; interior
  partition walls are 0.4 thick and occupy interior space.
- Door openings are 1.6 wide, 2.4 tall unless noted. Author walls as explicit segments
  around openings (no CSG).
- All geometry is axis-aligned boxes plus one cylinder (the tank, may be a 16-gon prism).
  A `kind` tag per solid: `wall | floor | ceiling | machine | crate | catwalk | beam |
  tank | pedestal`.

## 1. Zone plan

```
x→  0    4    8   12   16   20   24   28   32   36   40   44
z↓ ┌────────────────────────────────────────────────────────┐
 0 │  A  ║            C  corridor   [D]   ≈pit≈             │
 2 │─────╨──[b]────────────────────────[c]──────────────────│
 4 │ ▒▒catwalk▒▒ ┊beam                │                     │
 6 │──┬──╥──     ┊                    │   D1  storage       │
 8 │  │  ║       ┊                    │   (crate field,     │
10 │  │ [d]      ┊                    [e]  high shelf →)    │
12 │  │  ║       ┊      ┌────┐        │                     │
14 │ ▒│  ║       ┊      │TANK│        │                     │
16 │ ▒│  ║  B machine   │Ø6  │        ├────────────[f]──────│
18 │ ▒│  ║     hall     └────┘        │██│                  │
20 │ ▒│  ║       ┊beam end            │██│   D2 quiet room  │
22 │ L│  ║                            │██│   (beacon ●)     │
24 │──┘  ║ ▓▓▓▓ machinery row ▓▓▓▓    │██│                  │
26 │─[g]─╨────── listening wall ──────┤██├──[h]─────────────│
28 │        E  gallery  (dog patrol)  │                     │
30 └────────────────────────────────────────────────────────┘
      ▒ = mezzanine catwalk y3.5   ┊ = gantry beam y4.2   ██ = solid mass block
      L = ladder   ● = beacon   [D] = slide duct   ≈ = floor pit → trench
```

Doors: **[b]** C→B at z=2.2, x 10..11.6 · **[c]** C→D1 at z=2.2, x 30..31.6 (chain
curtain) · **[d]** A→B at z=6, x 2.5..4.1 · **[e]** B→D1 at x=24, z 10..11.6 · **[f]**
D1→D2 at z=16, x 40..41.6 (can field) · **[g]** B→E at z=26, x 0.3..1.9 · **[h]** E→D2 at
x=26, z 27..28.6 · A→C at x=6, z 0.3..1.9.

### §1 sketch errata

The ASCII plan above is a sketch, not the spec. Where it disagrees with the door list and
the §2 prose, those govern — and the sketch is wrong in three places:

- The `║` column running down through zone B at x ≈ 9 (rows z 6..26) is a drafting artefact
  of the sketch's character grid. **There is no wall there.** B is one open machine hall
  (§2 B), the door list gives that wall no door, and dog 2's B-hall loop (§3) would be cut
  in half by it. The engine deliberately does not build it.
- The `[d]` label sits on the z=10 row; the door itself is at **z=6**, per the door list
  (A's south wall — A is x 0..6, z 0..6).
- §3's "Loop ≈ 75 s" for dog 1 is arithmetic drift: the route is 69.6 m, which at 3.0 m/s
  is 23.2 s of walking, plus the 4 + 6 + 3 = 13 s of pauses — **≈ 36 s**, not 75 s.

## 2. Zones and what each one tests

### A — Spawn Dock (x 0..6, z 0..6)
Small quiet room. Spawn at (3, 0, 3) facing +x. First footsteps in absolute black; the
contact shell and first paint lesson happen here. Tests: cold boot readability.

### C — North Corridor (x 6..45, z 0..2.2)
The sprint lane / Blindfold-Gauntlet seed.
- **Slide duct** at x 24: box spanning the corridor, underside at y 1.2 (solid from y 1.2
  to ceiling, 0.8 thick in x). Sprint-slide under it.
- **Floor pit** x 31..35 (full corridor width): opening in the floor slab; sprint-jump
  clears it (4 m gap), walking doesn't. Falling in = 2.8 m drop into the trench (loud
  landing showcase, no damage).
- Two loose cans near x 20 against the north wall (early trap lesson, avoidable).
Tests: footfall-headlight sprinting, slide paint, landing paint, gap reading at speed.

### Trench (x 31..35, z 0..2.2, floor y −2.8)
Dead-end service pit under C. **Ladder** on its east face (x 34.6) back up to corridor
level. Tests: loud drop vs silent ladder ascent contrast; (stretch) below-floor bleed
patch when a loud event happens above.

### B — Machine Hall (x 0..24, z 2.2..26, minus A)
The landmark room and the map's heart.
- **Tank landmark**: cylinder Ø6, h 6.5, center (16, 16). Large silhouette — mass must
  read from a single ping (vision §11).
- **Columns** 0.6², full height, at x ∈ {6, 12, 18} × z ∈ {10, 20} (skip any overlapping
  the tank — none do). Rhythm for pings to reveal.
- **Machinery row**: box mass x 4..20, z 24..26, h 2.2, climbable top (mantle 2.2 exactly).
  Standing on it puts your head near the listening wall.
- **Mezzanine catwalk** (slab 0.25 at y 3.5): west run x 0..1.6, z 6..26 + north run
  x 0..10, z 2.2..3.8. Guard-rail-free edges (edge lines must sell the drop).
- **Ladder** floor→catwalk on the west wall at z 23.
- **Gantry beam**: walkable slab x 9.2..10.0, z 3.8..20, top at y 4.2 (0.3 thick). Reached
  by a 0.7 mantle from the north catwalk run; south end is a free drop (4.2 m = loud).
Tests: landmark mass, vertical routes, mantle chain, high-vs-floor route choice, drop
loudness, Lantern-wall listening post (from machinery row top).

### E — South Gallery (x 0..26, z 26..30) — the Lantern rig
A 4 m-wide gallery behind the **listening wall** (z=26, solid from x 2..26). The dog
patrols here. Player tracks it from B through the wall: fuzzed paint + vague stain.
Tests: the Lantern Test seed, through-wall stain quality, ghost on pause.

### D1 — Storage (x 24..45, z 2.2..16)
Crate parkour field. Crates (tops are walkable):
- 1.2³ crates at (27, 0, 6), (30, 0, 12), (34, 0, 5), (38, 0, 9), (28, 0, 14)
- 2.0-high stack at (42, 0, 6) (base 1.6×1.6)
- **High shelf**: platform x 43.4..45, z 4..10, top y 3.3 — mantle chain floor → 1.2 crate
  (41.8, z 7, adjacent) → 2.0 stack → 3.3 shelf. Overlooks D1.
- **Chain curtain** hangs in door [c] (from C): pass = rattle; crouch-pass = soft rattle.
Tests: mantle affordance lines at speed, hold-vs-matter encoding, high-route survey view.

### D2 — Quiet Room (x 26..45, z 16..30)
Stillest room; entered through the **can field** door [f] (six cans scattered x 39.5..42,
z 15..17.2 — crouch line through is authored to exist) or from the gallery [h].
- **Beacon pedestal** at (35, 0, 23): 0.5² h 1.0; emits a soft objective hum every 4 s
  (paint 3 m, hear 12 m, **gold** event class). Test scaffold for the reserved gold
  marker + stain-at-a-distance; not canon cell behavior.
- **Solid mass block** x 24..26, z 16..26 (full height) — thick machinery mass separating
  D1/D2 from E's corner; also the "two or more walls = nothing" propagation test body.
Tests: gold event language, quiet-room stillness, 2-wall silence, can-trap regret.

## 3. Dog patrol (1 dog; second toggleable)

**Dog 1 route** (patrol 3.0 m/s), waypoints (x, z), pauses are stop-and-listen (dog goes
silent → vanishes → ghost):
(2, 28) → (14, 28) **pause 4 s** → (24.5, 28) → through [h] → (30, 27.5) → (32, 21)
**pause 6 s** → (30, 27.5) → back through [h] → (14, 28) → (2, 28) **pause 3 s** → loop.
Loop ≈ 75 s. The E-leg drives the Lantern rig; the D2-leg gives open-room tracking near
the beacon.

**Dog 2** (dev toggle, default off): B-hall loop around the tank (10, 10) → (22, 10) →
(22, 22) → (10, 22), 2 s pause at each corner. For pressure/ghost testing in the open.

## 4. Suggested test choreography (what a tester is told to do)

1. Sprint C end-to-end: slide the duct, jump the pit. Only your own paint lights the way.
2. Drop into the pit on purpose; climb the ladder silently; feel the contrast.
3. Chain-curtain into D1 loud, then again crouched. Mantle to the high shelf; E-ping D1
   from above; drop (loud).
4. Thread the can field into D2 crouched. Watch the beacon's gold stain breathe.
5. Climb the machinery row in B; track dog 1 through the listening wall by stain + fuzzed
   paint for 20 s; call its exit door. (Lantern Test.)
6. Stand still in B until the world is only skeleton; then E-ping the tank once.

## 5. Data format (for the engine)

`src/core/map/sampleMap.ts` exports a typed `MapDef`:
solids (box: min/max/kind; cylinder: center/r/h/kind), ladders (base, top, facing),
props (`can | chain | beacon` with position/orientation/extent), dogRoutes (waypoints +
pause list), spawn (pos, yaw), and named debug markers for the top-down view. Walls are
authored as explicit segments around door openings. Hold/edge affordances are **derived**,
not authored: any walkable top edge 0.7..2.6 above an adjacent standing surface emits hold
lines; ladder rails/rungs emit hold lines (vision §5).
