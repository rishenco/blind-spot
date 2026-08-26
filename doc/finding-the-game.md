# Finding the game — research notes

*What working developers actually did about the three problems this project has. Sources are
named and linked at the bottom; everything here is someone's reported practice, not theory.*

## 0. Where the project actually is

Counted honestly, on 2026-08-26:

| | |
|---|---|
| Design spec | ~450 lines across `vision.md` (v1.0) + `core-loop.md` (v0.4) |
| Engine code | ~6,900 lines (movement, collision, sound bus, wave propagation, Blueprint reveal) |
| Enemies implemented | 0 |
| Objectives implemented | 0 |
| Loops playable end to end | 0 |
| People who have played it | ~1 |

The spec has also been rewritten under itself at least once: the enemy went robo-dog → spider,
the map went five stacked floors → completion-gradient tower, Heat went decay → ratchet. That
churn is the tell. **The design is being iterated in prose instead of in play** — which is the
one place iteration is cheap in tokens and worthless in information.

Everything below is aimed at inverting that ratio.

---

## 1. "I don't know what I want to build"

### 1.1 The single most-cited answer: build the *toy* first

Kyle Gabler and the Carnegie Mellon Experimental Gameplay Project (World of Goo came out of it)
wrote the canonical piece on this after shipping 50+ prototypes in a semester. Their rules were
brutal and worth copying verbatim:

1. each game made in **under seven days**,
2. by **exactly one person**,
3. around **one theme** (gravity, swarms, vegetation).

Their development lessons, in their words:

- **"Build the toy first."** Get the core interaction satisfying *with no goals attached*. If
  moving the thing around isn't fun with no rules on it, no rules will save it.
- **"You can't polish a turd."** Theming and juice multiply a good mechanic; they do not rescue
  a bad one.
- **"Fake it."** Drop shadow instead of a lighting rig. Faked pattern-recognition instead of
  real AI. Nobody sees the backend.
- **Brainstorming is a myth** — "not a single one [of the good games] was the result of sitting
  down as a group for a brainstorm session." Ideas came from concrete things being poked at.
- **"Days spent in pre-production were unquestionably more valuable than days spent in actual
  development"** — but their pre-production is *mental simulation of the played experience*
  ("imagine yourself pushing the buttons"), not spec-writing. If you can't simulate it in your
  head, it's too complex.
- **Emotional targets**: collect the art/music/film that gives you the feeling you're chasing,
  and use it — not a design document — as the arbiter of decisions.

This is directly usable here: **your toy is not "the Retrieval."** Your toy is *move through
black space and hear it light up*. That's already built. The unanswered question is whether a
second toy — *a thing that hunts you by sound* — is fun for 90 seconds against it. That is a
one-day build, not a design chapter.

### 1.2 The hook is usually discovered in a playtest, not chosen in a document

**Dark Echo** (RAC7) is the closest existing relative of Blind Spot: black screen, you see only
the visualised propagation of your own footsteps, enemies are red squiggles, and quiet play is
the stealth verb. Its history:

- Built solo in **48 hours** for Ludum Dare 26 (theme: minimalism) as *You Must Escape*.
- Placed **2nd of ~1,600 entries** — that ranking was the validation to keep going.
- The team then tried to expand it into a bigger game and **abandoned that attempt**.
- The direction that shipped came from watching testers: *"people started saying they were kind
  of getting scared."* They found out they had made a horror game. That wasn't the plan.
- They cut the story entirely — "making stories is really hard, and neither one of us is a very
  good writer" — and replaced it with one word per level.

Read that against your two docs: your spec already asserts the answer to a dozen questions
("mastery is prediction", "the return sprint is the payoff", "the duel is a matador dance") that
Dark Echo only learned by putting it in front of people. **You cannot know which of your ideas
is the hook until strangers react to one of them.**

### 1.3 What to write instead of a spec

Rami Ismail's most repeated structural point: most indies confuse the **prototype** with the
**vertical slice**, and lose months to it. Different artefacts, different questions:

- **Prototype** — answers *is this mechanic worth building a game around?* Ugly, throwaway, no
  content, no art, no menus. Its output is a yes/no and a pile of dead ends.
- **Vertical slice** — answers *does the finished thing look and feel like the pitch?* Built
  only after the prototype said yes; production-quality, tiny in scope.

Your `core-loop.md` §8 ("First playable — The Span", with three falsifiable questions) is
already the correct document, and it is the only part of the spec that is. The rest —
lighthouses, sound-topology quotas, chip tables, the Spice shelf — is vertical-slice and
production thinking written before the prototype question got answered. It isn't wasted, but
it's frozen capital.

**Concrete move:** delete nothing, but demote everything. One page, pinned, containing only:

- one sentence of pitch ("a first-person stealth game where you only see what you hear, and
  everything hunting you hears the same way"),
- 3 pillars max, each phrased so a build can violate it,
- the **one** falsifiable question the current build exists to answer,
- the kill criterion for that question.

Everything else moves to `doc/parked/`.

---

## 2. Making visuals with an AI assistant, cheaply

The token burn has a specific cause: **the model can't see the frame.** Every blind visual edit
is a guess, and guesses are re-guessed. Four fixes, in order of payoff.

### 2.1 You already own the right machine — point it at the look

`tools/shoot.mjs` is a headless Playwright driver with a PNG decoder and photometric assertions
("this frame is black", "this region dimmed but did not vanish"). That is a *look-development
rig*, and it's better than what most solo devs have. Use it deliberately:

- One command produces a numbered contact sheet of ~14 canonical frames.
- Claude reads those PNGs directly (image input) and judges them, instead of reasoning about
  shader code it cannot see.
- Lock the look with **golden-image assertions** — mean luminance, lit fraction, hue-family
  split, all of which `png.mjs` already computes. Then a visual regression fails loudly instead
  of being re-litigated in prose.

Rule of thumb: **never make a visual change without a before/after pair of the same frame in the
same message.** One change per cycle. Batched blind edits are what burns tokens.

### 2.2 Target image first, code second

The industry name is a *target render* / *beautiful corner*: produce the single frame the game
should look like before writing the renderer that produces it. Options, cheapest first: a
screenshot of Scanner Sombre or the Afterimage repo with your palette pasted over it; a
generated concept frame; a paint-over of your own current screenshot.

Then the iteration prompt is not "make it look better" (unanswerable, expensive) but "close the
gap between shot 03 and target.png; the difference is X". Gabler's "emotional targets" is the
same instinct, twenty years earlier.

### 2.3 The model wires the knobs; *you* turn them

You already ship `lil-gui`. The division of labour that keeps costs sane:

- Claude implements parameters and their plumbing (cheap, verifiable, testable).
- You drag sliders in the browser for ten minutes — the thing a human does in seconds and a
  language model does in a thousand tokens per guess.
- You dump the tunables to JSON; Claude commits them as the new defaults.

Look tuning is a real-time perceptual task. Delegating it to a text model is the single most
expensive thing in this workflow.

### 2.4 Art direction as a constraint list (and the non-artist's rules)

Your `vision.md` §3.2 is genuinely strong art direction — two layers, cyan-family matter, age as
temperature, "dots are matter, lines are holds", source colour never touching geometry. Keep
enforcing it as a written rule set; constraints are what make cheap art cohere. The standard
non-artist rules that stack on top:

- **4–8 colours, hard limit.** Contrast and readability come free.
- **Silhouette test.** If it isn't readable as a flat shape, colour won't fix it. (For you: does
  a blip cloud read as *a wall* / *a doorway* / *a hold*?)
- **One light direction**, everywhere, forever.
- **Post-processing hides the lack of art** — bloom, grain, chromatic aberration, vignette. You
  have a post stack; it's doing more work for you than any model would.
- **Juice**: Gabler's word is *"bouncing and wiggling and squirting and making a little
  noise"*; Vlambeer's Jan Willem Nijman gave 30 concrete tricks in *The Art of Screenshake* —
  hit-stop (~0.2 s freeze on impact), camera kick opposite the action, muzzle flash,
  permanence (shells, scorch), random variation on death. Cheap, mechanical, enormous felt
  difference. This is the highest-return "visual" work available to a programmer and none of
  it is art.

### 2.5 Buy, don't generate

Where a well-maintained thing exists, take it: `three` post-processing passes, Shadertoy
implementations of the effect you want, Kenney/Quaternius assets for greybox props, the
Afterimage repo you already cite as a reference. Generating bespoke visual code is the most
expensive way to obtain any of it.

---

## 3. "How did people test whether an idea was cool, before AI?"

They shipped tiny versions of it to real humans, fast, and watched. Five mechanisms, all still
in use.

### 3.1 Jams and hard timeboxes

- **Experimental Gameplay Project**: 7 days, one person, one theme → World of Goo.
- **Ludum Dare 48h**: → Dark Echo (2nd/1600, then a commercial game).
- **Ojiro Fumoto**: 12 rapid prototypes in 12 weeks → Downwell.
- **Double Fine's Amnesia Fortnight** (since 2007): the whole studio drops everything for two
  weeks, anyone can pitch, the studio (and later the public, by paid vote) picks which
  prototypes get built. Costume Quest, Hack 'n' Slash and Spacebase DF-9 all came out of it;
  most prototypes died there, which is the point.

The EGP found **no correlation between development time and final quality** of a prototype.
Extra weeks bought nothing. That's the strongest single argument for timeboxing yours.

### 3.2 RITE: the small-N playtest loop that game studios actually use

Rapid Iterative Testing and Evaluation, defined by Michael Medlock, Dennis Wixon, Bill Fulton,
Mark Terrano and Ramon Romero at Microsoft Game Studios on **Age of Empires II**. The difference
from academic usability testing: you analyse and **change the build after every single
participant**, then test the fix on the next one. On AoE II, after 10 participants no changes
were needed for the following 6 — that's the stopping rule.

You do not need 30 testers. You need **one person at a time, repeatedly**, and the discipline to
patch between them. Protocol that works for a game like yours:

- Say nothing. Explain no mechanic. Hand over the controls.
- Think-aloud: "tell me what you think is happening."
- Keep a **confusion log**: timestamp every moment they hesitate, backtrack, or say "wait,
  what?" Confusion is your only real currency — this game lives or dies on readability.
- Ask afterwards: *"what were you trying to do just then?"*, never *"did you like it?"*

### 3.3 The 2D proxy: prove the information design before the 3D

**Mark of the Ninja** is the reference for exactly your problem. Nels Anderson's rules:

1. **Transparent stealth system** — binary states, no meters: concealed is black-with-red, lit
   is fully coloured. *Every single noise is visualised, with its radius drawn.*
2. **Transparent AI** — three awareness levels with distinct cues; *"if a guard's behavior ever
   changes, the player will immediately understand what set it off"*; a ghost marks where the
   guard last saw you, and markers show where sounds came from.
3. Narrow the gulf of execution (don't make the player fight the controls).
4. Cheap failure — checkpoints between encounters; retry must be instant or stealth becomes
   tedium.
5. Keep the space small — screen size plus half a screen; *"mentally mapping 2D space is really
   not something our brains are meant to do."*

Two things fall out of this for Blind Spot. First, your design laws are already an aggressive
version of rules 1–2 (noise radius, belief pin, "state may never be hidden"), which is a good
sign. Second — and this is the cheap-testing move — **Mark of the Ninja and Dark Echo both prove
the entire information design works in 2D.** A top-down 2D Blind Spot (canvas, circles for sound
propagation, one spider, one artifact, WASD) is a **1–2 day build** that answers your three §8
questions:

- does the hum-siege break with throw / lure / gaps, unprompted, in <45 s?
- is the return route runnable from memory after one pass?
- is a stationary silent enemy *tense* or *unfair*?

None of those three questions is about 3D, parkour feel, or the point-cloud look. They are about
sound, belief and routing — all fully testable in a flat prototype that costs 2% of the 3D one,
and can be handed to ten friends over a URL the same evening. Rule 4 also transfers directly:
**instant retry**. If a death costs 30 seconds of walking back, testers stop experimenting and
your data dies.

Note also Anderson's rule 5 in your context: your spec's own instinct ("floors sized 30–40%
smaller than looks right — dark space reads bigger") is the same finding. Trust it harder.

### 3.4 Build in public: the audience as a continuous poll

Vlambeer's *performative game development* on Nuclear Throne: development livestreamed twice a
week, weekly public builds, community feedback taken live. It funded the studio (~$200k in early
access) and doubled as marketing. Their honest downsides: it's exhausting ("It really is
performance… And it's exhausting" — Rami Ismail), weekly builds prevent deep refactors, and you
can't keep secrets.

The lightweight version, which is what most solo devs do: **one GIF a week**, posted to
#screenshotsaturday / r/IndieDev / TikTok. The engagement *is* the poll. A GIF that gets no
reaction three weeks running is telling you something a design doc never will. Practical bar
from that scene: the GIF is 5–20 s, and **a viewer decides in 2–3 seconds** — the first frame
must communicate the game on its own.

### 3.5 Market-testing the concept before you build it

The modern pre-build test, per Chris Zukowski (How To Market A Game), is the **Steam
coming-soon page**. Publishers do the same thing at scale: post several concepts, build the one
that pulls.

What he says you need before posting: genre locked, art style decided, **three distinct
environments** shown, a professional capsule (hire it out), and a 30 s gameplay trailer with
gameplay in the first 5 seconds. Trailers may be "smoke and mirrors, but not lying" — in-engine
Potemkin villages you implement later. Then:

- **Wishlist velocity** (wishlists ÷ time) is the read on whether the concept is landing.
- Wishlists don't decay — a page up 6+ months before launch compounds.
- ~5,500–7,000+ wishlists puts you on Popular Upcoming, which is the visibility cliff.
- One r/games front-page post has earned a two-person team **11,000 wishlists**.
- Festivals and demos (Steam Next Fest) are the top wishlist generators.
- Test the positioning on strangers: show them the page and ask **what game this reminds them
  of**. Wrong or vague answers mean the positioning is broken, not the audience.

### 3.6 The cautionary data point you should look at hardest

**Scanner Sombre** — Introversion, 2017, the direct visual ancestor of Blind Spot (black world,
LIDAR point-cloud reveal), critically well received — **sold ~6,000 copies on Steam in two
months** and, in Chris Delay's words, "bombed in a big way". This from a studio that had just
sold 2 million copies of Prison Architect and had a real audience and press access. Mark Morris'
own post-mortem: having Prison Architect to fall back on meant they never committed properly.

The lesson is not "don't make this game". It's that **the black-screen aesthetic is a known
marketing liability**: it's near-invisible in a capsule, a thumbnail, and a muted autoplaying
GIF — precisely the three surfaces that sell games now. Two implications:

1. Test the *capsule and GIF* early — earlier than feels reasonable — because for this look it's
   a genuine risk, not a launch-week detail. If a 3-second muted GIF of Blind Spot doesn't read,
   that's a design constraint feeding back into the renderer (brighter event layer, higher
   contrast, more legible motion), not a marketing task for later.
2. Scanner Sombre was a walking-sim; Blind Spot is a stealth game with a hunter, a co-op hook,
   and an extraction loop. Those are the differentiators that need to be visible in three
   seconds.

---

## 4. What this suggests doing next

A concrete four-week shape, in priority order. Each step has a kill criterion.

**Week 1 — the 2D proxy.** Top-down canvas prototype: sound rings, one spider with the three
belief states, one humming artifact, throw, instant retry. No art, no polish, no 3D. Ship the
URL to 5 friends. *Kill criterion:* if nobody breaks a siege unprompted in <45 s across 5
testers, the enemy design — not the level, not the look — is wrong.

**Week 2 — RITE on the proxy.** One tester at a time, patch between each, confusion log. Stop
when two consecutive testers surface nothing new. Rewrite the one-page pitch from what actually
happened, not from what you intended.

**Week 3 — port the winning loop into the 3D build.** The engine already has movement, sound
bus, wave propagation and the reveal. Add: one spider, one artifact, one extraction. Nothing
else. Keep `shoot.mjs` green.

**Week 4 — the three-second test.** Record a 15 s GIF and a 30 s trailer of the 3D build. Post
one GIF a week to r/IndieDev + TikTok. If the aesthetic reads and the reaction is real, put up a
Steam coming-soon page and watch wishlist velocity. If three weeks of GIFs get nothing, the
readability problem is upstream in the renderer and you've learned it for the price of three
GIFs instead of a year.

Two standing rules from the research, worth pinning:

- **No design document may grow while zero people have played the current build.**
- **Every prototype gets one falsifiable question and a kill criterion, written before it's
  built.** (`core-loop.md` §8 already does this. It's the template.)

---

## Sources

- Kyle Gabler, Kyle Gray, Matt Kucic, Shalin Shodhan — *How to Prototype a Game in Under 7 Days*
  (Gamasutra / GDC 2006, Experimental Gameplay Project):
  https://www.gamedeveloper.com/game-platforms/how-to-prototype-a-game-in-under-7-days
  (full text mirror: https://www.cs.hmc.edu/~markk/SWE_copies/gabler_prototyping.html)
- Luis Carli — *On Prototyping Games Quickly* (Will Wright, Vlambeer, Downwell, EGP):
  https://luiscarli.com/2020/04/22/on-prototyping-games-quickly/
- Rami Ismail — *Prototypes & Vertical Slice*, Levelling The Playing Field:
  https://ltpf.ramiismail.com/prototypes-and-vertical-slice/
- Vlambeer — *Performative Game Development* (Nuclear Throne, GDC):
  https://www.gamedeveloper.com/business/vlambeer-s-performative-game-development---the-way-of-the-future
- Jan Willem Nijman — *The Art of Screenshake* (INDIGO 2013):
  https://archive.org/details/the-art-of-screenshake
- Nels Anderson — *Mark of the Ninja*'s five stealth design rules (GDC 2013):
  https://www.gamedeveloper.com/design/-i-mark-of-the-ninja-i-s-five-stealth-design-rules ·
  https://www.pcgamer.com/stealth-game-design-mark-of-the-ninja/
- RAC7 (Jesse Ringrose, Jason Ennis) — *Making Dark Echo*:
  https://animalnewyork.com/2015/03/06/making-dark-echo-minimalist-game-echolocation-fear/
- Double Fine — *Amnesia Fortnight*: https://www.doublefine.com/dftv/amnesia-fortnight
- Medlock, Wixon, Fulton, Terrano, Romero — *the RITE method* (Microsoft Game Studios, Age of
  Empires II): https://en.wikipedia.org/wiki/RITE_Method ·
  https://www.jpattonassociates.com/wp-content/uploads/2015/04/rite_method.pdf
- Chris Zukowski — *When should I post my Steam coming-soon page?*:
  https://howtomarketagame.com/2025/03/10/when-should-i-post-my-steam-coming-soon-page/ ·
  *10-step plan*: https://howtomarketagame.com/2021/07/12/how-to-market-your-indie-game-a-10-step-plan/ ·
  *Wishlist velocity*: https://howtomarketagame.com/2024/06/04/what-is-wishlist-velocity-and-is-it-a-better-indicator-of-success/ ·
  *11,000 wishlists from one Reddit post*:
  https://howtomarketagame.com/2022/01/10/how-a-two-person-team-earned-11000-wishlists-with-one-reddit-post/
- Introversion Software on the commercial failure of *Scanner Sombre*:
  https://www.gamereactor.eu/introversion-on-the-commercial-failure-of-scanner-sombre/
- Ryan Clark (Brace Yourself Games) — *How to Consistently Make Profitable Indie Games* (GDC),
  on hooks and market analysis: https://www.gdcvault.com/play/1023684/How-to-Consistently-Make-Profitable
