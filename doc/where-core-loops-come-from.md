# Where core loops come from — research notes

*Companion to `doc/finding-the-game.md`. Case histories of how the loops in the games you named
actually got built, the moves that recur across all of them, and what that implies for Blind
Spot. Sources at the bottom.*

## 0. The finding, up front

Across every case I could source, **nobody invented a core loop from nothing.** In each one the
loop was a known skeleton with exactly one thing swapped, or two known loops welded together.
The invention is always small and always *specific*; the skeleton is always borrowed.

| Game | Skeleton it borrowed | The one thing swapped |
|---|---|---|
| Deep Rock Galactic | Left 4 Dead co-op waves | Minecraft's caves — fully destructible, procedural, vertical |
| Among Us | Mafia (a tabletop game from 1986) | Tasks: gives the innocent something to *do* and the liar something to fake |
| Vampire Survivors | Magic Survival (an Android game), cloned verbatim | A Castlevania-flavoured asset pack the dev already owned |
| PUBG | ARMA/DayZ mod, itself a mod | The 2000 film *Battle Royale*: last man standing, shrinking circle |
| Left 4 Dead | A Counter-Strike: Source mod ("Terror") | PvP dropped after playtests; "lone wolves die" made mechanical |
| The Finals | Objective-hold shooter (attack/defend a point) | Destruction tech came *first*; the objective was designed to use it |
| Lethal Company | Scavenge-for-quota, decades old | Proximity voice chat as a **design law**, not a feature |
| Content Warning | Lethal Company's shape | The camera: the goal is *footage*, so danger must be filmed, not avoided |
| PEAK | Content Warning's production model | Climbing with stamina — one continuous vertical route |

That is the whole answer to "how do you come up with core loops": you don't come up with them,
you **recombine** them, and then you spend all your effort on the one substitution.

---

## 1. The case histories

### Deep Rock Galactic — the loop came from an itch in another game

Lead programmer Jonas Møller was exploring caves in **Minecraft** and thought: *"If only we had
big guns, this could be really awesome."* That sentence is the entire design. Procedural
destructible caves + co-op in the Left 4 Dead mould; dwarves because dwarves dig and fight; in
space to avoid pure fantasy stereotype; tonal reference points Aliens and The Abyss (horror and
humour together, same as Lethal Company later). Ghost Ship Games was **founded around the
concept** — the idea recruited the studio, not the other way round. They also started posting
prototype screenshots and video roughly six months in, on the principle that the next upload
would always look better.

**The move:** notice the moment in someone else's game where you wish a different verb existed,
and build the game where it does.

### The Finals — the loop was reverse-engineered from the tech

Embark (largely ex-DICE) had the destruction technology first. The design question was
therefore: *what objective forces players to use it?* Their answer: modes where a team must
hold a fixed point for an extended time, because that is the situation that maximally rewards
blowing out a floor, punching a new sightline, or cutting a route. Cashout exists to make
destruction matter; a deathmatch would have wasted it. Tonal pillars: "appeal and brutality" —
inviting and playful on the surface, violent underneath. The gameshow framing is what makes
respawns, arenas and a scoreboard diegetic.

**The move:** if you already have one extraordinary mechanic, don't design a loop *around* it —
design the loop that would be broken without it.

### Lethal Company — the loop is old, the social system is the invention

Zeekerss started making games at 10 on Roblox and shipped **19 games before Lethal Company**,
including It Steals, Dead Seater and The Upturned. His stated breakthrough came after Dead
Seater: he had been "intentionally holding back a lot of [his] identity" by playing horror
straight, and realised his games "had always been funny accidentally." Lethal Company is that
realisation made systemic — *"it's actually a game about laughing at death."*

Mechanically, quota-scavenging is ancient. What is new is that **proximity voice is load-bearing**:
you can only hear nearby teammates without a walkie-talkie, so the monster that separates you
also silences you, and the fear is immediately followed by laughter when you regroup and
compare stories. Development was public on Patreon from May 2022 with weekly logs, and he
scrapped a large amount of content in late 2022 to "rediscover what the game was going to be."

**The move:** pick the constraint that makes *players* generate the content. LC's monsters are
cheap; the stories are free.

### Among Us — port an analog loop, then fix its dead air

Marcus Bromander had played **Mafia** since childhood; after watching *The Thing* he pitched a
space version, originally called Space Mafia. The design problem with a literal port is that
Mafia's players wander around doing nothing between kills. Their fix — **tasks** — is the whole
game: it gives crewmates a win condition, a reason to be alone in a room, an alibi, and a visual
tell the impostor has to fake. Three people, mobile, 2018, near-total silence for two years,
then streamers.

**The move:** take a proven social loop from another medium and add the one mechanic that fills
its dead time.

### Vampire Survivors — clone it exactly, then find the skin

Luca Galante cloned the Android game **Magic Survival** "just for fun", got a prototype that
played exactly like it, and considered himself done. Then he dug out a Castlevania-flavoured
asset pack he'd bought years earlier, dropped it in, and "absolutely fell in love with the
visuals." From there he "didn't have a vision" and "just started to build the game, piece by
piece."

**The move:** building a known-fun loop verbatim is a legitimate way to *start*. You cannot
iterate on a loop you haven't felt.

### Left 4 Dead — the loop was found by playtest, and the AI is a magic trick

It began as **Terror**, a Counter-Strike: Source mod: humans versus AI zombie waves, evolving
into 4v4 with player-controlled specials. Internal playtesting killed that: one strong infected
player could ruin the match, and Gabe Newell's question — why wouldn't I just play Counter-Strike?
— forced the pivot to co-op-against-AI as the primary mode. The single design razor that came
out of it, cutting through every later decision: **"lone wolves die."**

And the AI Director, the system everyone credits with the game's genius? Chet Faliszek, fifteen
years later: *"It didn't really care about the player. It was a random number generator that kind
of just worked its way out."* Players attributed intention to it anyway.

**The move, twice:** the loop you ship is the one that survived a playtest, not the one you
pitched. And perceived intelligence beats actual intelligence — the cheap version of your
director will be credited with a mind if its output is legible.

### Content Warning and PEAK — the loop as a four-week production

Content Warning: five developers, February–April 2024, most of it a **month-long internal game
jam in Seoul**. Released free for 24 hours on April Fools' Day — 6.6 million claims, 204k peak
concurrent. Its substitution into the Lethal Company shape is one word: **camera**. Because the
objective is footage, danger must be approached and filmed rather than avoided; the whole risk
calculus inverts.

PEAK: Aggro Crab (3) + Landfall (4), four weeks in an Airbnb in Seoul, **under $200,000 total**
("a couple months salaries and the Airbnb, flights, and food"), announcement to launch in five
days, 1.6 million sales in the first week. The concept had been pitched a year earlier — the
teams argued about direction over Discord ("text is evil") and only converged in person, on
free-form climbing with stamina. Their governing constraint: **"the game jam IS the game."** By
the end of the month the core was done; the rest was UI, meta-progression and easter eggs. And
the stated motive for making it at all was jealousy that Content Warning had been built in a
month.

**The move:** the timebox isn't a constraint you accept, it's the design tool. A four-week ceiling
forces the loop to be simple enough to be explained in a clip.

### The extraction loop itself — why your skeleton works

Escape from Tarkov (early access, 2017) and Hunt: Showdown (2018) established the pattern: go in,
gather, and **get out or lose it all**. Everything else — loot tables, AI, maps — exists to
manufacture one recurring decision: *leave now with what you have, or push deeper and risk all
of it.* The genre's real question is "how much is enough?", and it works because losing is
possible, which is what makes winning mean anything.

---

## 2. The five moves, extracted

Every case above is one of these. They are the actual generative methods.

1. **Substitute the verb.** Keep a proven loop skeleton; change what the player *does* inside it.
   (Deep Rock: L4D's loop, but you dig. Content Warning: LC's loop, but you film.)
2. **Substitute the information channel.** Keep the loop; change what the player can *know*, or
   how they can *communicate*. (Lethal Company: proximity voice. Among Us: hidden roles.) This is
   the cheapest source of genuinely new play, because information rules rewrite behaviour without
   requiring new content.
3. **Reverse-engineer from the signature mechanic.** If you have one extraordinary system, design
   the objective that would be pointless without it. (The Finals.)
4. **Port a loop from another medium.** Tabletop, film, a job, a sport. (Among Us from Mafia,
   PUBG from a film.)
5. **Clone-first, then swap the skin.** Build the known-fun thing verbatim so you can feel it,
   then find what it's actually about. (Vampire Survivors.)

Two structural facts sit under all five, from Daniel Cook's *Loops and Arcs*: loops are cheap to
build and consumed forever; arcs (cutscenes, set-piece levels, authored content) are expensive
and consumed once. Games that lean on loops scale; games that lean on arcs burn out their
studios. And loops nest — the 5-second loop, the 20-minute session loop, the multi-week meta
loop — and a game is judged by whether all three are honest.

### A test for a candidate loop

Before building one, check it against what the cases actually rewarded:

- **Does it force a decision every ~10 seconds?** ("push deeper or extract" is the extraction
  loop's entire engine.)
- **Does it manufacture stories the players tell each other?** LC, PEAK and Among Us are
  story-generators; that is why they were streamed and clipped.
- **Does it survive fifty repetitions?** Loops must get *richer* with practice, not just longer.
- **Can a streamer explain it in one sentence, and can a viewer see it in three seconds?**
- **Is there a one-line razor that settles arguments?** "Lone wolves die." "The game jam IS the
  game." If you can't state yours, the loop isn't decided yet.

---

## 3. Applied to Blind Spot

### 3.1 What your loop actually is, in this vocabulary

- **Skeleton:** the extraction loop (Tarkov/Lethal Company): go down, take a thing, get out or
  lose it.
- **Substitution:** the information channel — *sound is the only way to see*. That's move 2, the
  highest-value one, and it's a real substitution: nobody in the co-op-extraction lineage has
  taken it.
- **Currency:** noise. Every question costs volume, and volume is what hunts you.

That is a legitimately strong recombination, and it's already there in `vision.md` law 1 ("every
question has a price"). The tower, the spider, the chips, the Heat ratchet are *not* the
invention — they're interchangeable furniture. This matters, because your two design documents
spend most of their words on the furniture.

### 3.2 The Finals test, applied

Embark's rule: design the objective that would be pointless without your signature mechanic. Run
it on your candidates:

- A **stealth escape** where you avoid all noise → punishes the mechanic; a silent player sees
  nothing and the screen is black. Anti-loop.
- A **quota scavenge** (LC-shaped) → good: repeated trips through geometry you paid for.
- **Your Retrieval** (undock a humming artifact, run it home) → strongest, because the objective
  *is* a sound source you cannot switch off. The moment the artifact starts humming, silence
  becomes impossible and every skill you built on the way down gets cashed. Keep this. It is the
  one part of `core-loop.md` that passes the Finals test.
- A **hold-the-point** variant (Finals-shaped: stay in one place while a machine howls) → worth
  prototyping precisely because it forces sustained noise instead of a single sprint.

Your razor, if you want one in the "lone wolves die" register: **the only way to see is to be
heard.** Any feature that lets a player learn something for free violates it. That single line
kills more design arguments than another spec revision will.

### 3.3 The thing the case histories suggest you're under-weighting

Lethal Company, Content Warning and PEAK are the three biggest recent breakouts in your shape,
and in all three **the social system is the product**. LC's proximity voice, CW's shared camera,
PEAK's four bodies on one rope. Your vision doc has this — diegetic positional voice that *paints
geometry and attracts enemies* is, honestly, the best single idea in the document, because it is
move 2 and move 1 at once: your voice is both the communication channel and the light source.
It's currently scheduled after everything else.

The uncomfortable version: solo-first + black screen + cold precision is the **Scanner Sombre**
position (6,000 copies). Co-op + voice-as-lantern + laughing at death is the **Lethal Company**
position (millions). Your `vision.md` §13 explicitly rejects the latter's register ("not
R.E.P.O."). That's a legitimate choice — Mirror's Edge cold is a real aesthetic — but it should be
made *knowingly*, because it is also the choice between the two market outcomes, and the loop
you prototype first should match it.

### 3.4 Three loop variants worth a day each

All three testable in the 2D proxy from the previous brief, same code, different rules:

1. **The Retrieval** (current spec, minimal): one artifact, undock, carry home. Question: is the
   hum-siege a fun problem or a punishment?
2. **The Quota** (LC-shaped): several small items, free order, a target sum, no escalation except
   the noise you make. Question: does the greed decision ("one more room?") appear on its own?
3. **The Hold** (Finals-shaped): activate a machine and survive near it for 60 loud seconds.
   Question: is sustained forced noise more interesting than a single loud sprint?

Same rig, three rule sets, three evenings. Then let the testers' behaviour pick, the way L4D's
playtests picked co-op over 4v4.

### 3.5 The production lesson

Content Warning: 5 people, 1 month. PEAK: 7 people, 4 weeks, <$200k, announcement to launch in 5
days. Lethal Company: 1 person — with 19 shipped games behind him. Nobody in this lineage spent a
year on a spec. The corresponding rule for you is PEAK's: **decide the timebox first, and let it
decide the scope.**

---

## Sources

- Deep Rock Galactic origin (Jonas Møller, Minecraft caves + Left 4 Dead; Ghost Ship founding):
  https://www.thegamer.com/deep-rock-galactic-making-of/ ·
  https://www.unrealengine.com/developer-interviews/guns-gold-and-glory-in-the-caverns-of-deep-rock-galactic ·
  https://gamerant.com/deep-rock-galactic-interview-ghost-ship-history-player-growth-3-million/
- The Finals — Embark on destruction-driven objective design:
  https://mp1st.com/news/the-finals-interview-embark-talks-balancing-destruction-and-more
- Lethal Company / Zeekerss — the 10-year, 19-game run and the design of the social system:
  https://www.pushtotalk.gg/p/how-lethal-company-sold-10-million-copies ·
  https://www.pcgamer.com/games/horror/lethal-company-developer-says-the-freedom-afforded-by-text-adventure-design-is-why-his-latest-game-took-10-years-to-make-that-made-it-very-easy-for-this-project-to-spiral-out-of-control/
- Among Us — Mafia + The Thing, and why tasks exist:
  https://gameworldobserver.com/2022/04/20/how-the-thing-inspired-innersloth-to-make-among-us
- Vampire Survivors — cloning Magic Survival, then the asset pack:
  https://www.pcgamer.com/vampire-survivors-creator-didnt-have-a-vision-when-he-started-making-the-game-that-allowed-him-to-quit-his-job/ ·
  https://www.nme.com/features/vampire-survivors-creator-luca-galante-talks-quitting-his-job-to-fulfil-his-promise-3153107
- Battle royale lineage — Greene's ARMA/DayZ mods to PUBG:
  https://gameinformer.com/b/features/archive/2018/04/17/from-mod-to-phenomenon-a-short-history-of-battle-royale.aspx ·
  https://www.vice.com/en/article/the-creator-of-pubg-on-where-battle-royale-started-and-where-its-going/
- Left 4 Dead — Terror mod, the playtest pivot, "lone wolves die", the Director as an RNG:
  https://www.gamedeveloper.com/design/15-years-later-chet-faliszek-dishes-on-the-making-of-left-4-dead
- PEAK — four weeks, seven people, under $200k:
  https://www.gamedeveloper.com/production/how-co-op-climbing-hit-peak-achieved-2-million-sales-for-less-than-200-000- ·
  https://www.gamespot.com/articles/how-the-developers-of-peak-primarily-made-the-game-out-of-jealousy/1100-6532754/
- Content Warning — month-long jam in Seoul, free-for-24-hours launch:
  https://landfall.se/content-warning-press-kit ·
  https://www.pcgamer.com/games/horror/content-warning-a-free-co-op-horror-game-where-you-go-viral-on-spooktube-or-die-trying-is-rapidly-climbing-the-steam-charts/
- Extraction shooters — the genre's core risk/reward loop:
  https://www.gfinityesports.com/article/history-of-extraction-shooters ·
  https://antiherostudios.com/blog/what-is-an-extraction-shooter
- Daniel Cook — *Loops and Arcs*: https://lostgarden.com/2012/04/30/loops-and-arcs/
