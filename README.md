# BLIND SPOT

A 1v1 browser game about **seeing the past**.

The substation is in total darkness. You perceive it only through echolocation pulses that
reconstruct space as glowing point clouds — and a pulse is a photograph, not a window. What
it shows you was true when the wave passed. It does not update. If your opponent was
standing in that doorway six seconds ago, they are *probably* not standing there now.

Every emission is two-sided. Your pulse paints the room for you and paints **you** for them,
through walls. That is the whole game: deciding when knowing is worth being known.

## Run it

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. One player clicks **CREATE ROOM** and reads out the six-letter
code; the other types it into **JOIN**. Both pick a weapon and hit **READY**.

**SOLO WALK** is an offline sandbox with no opponent — the fastest way to learn to read the
space before anyone is hunting you.

## Controls

| | |
|---|---|
| `WASD` | move |
| `SHIFT` | sprint (loud) |
| `CTRL` / `C` | crouch (silent) |
| `RMB` or `SPACE` | **pulse** |
| `LMB` | fire |
| `R` | reload |
| `Q` | Sensor Spike · `E` Decoy Shard · `F` Echo Bomb |
| `1` `2` `3` | take an upgrade when one is offered |
| `ESC` | release the mouse |

## Reading the screen

| Colour | Meaning |
|---|---|
| **pale cyan** | matter you just measured |
| **blue → navy** | matter you measured a while ago — your map, and it may be wrong |
| **orange** | a person, frozen at the instant you saw them. It cools but never leaves until a newer sighting replaces it |
| **amber** | sound: footsteps, gunfire, an enemy pulse arriving through a wall |
| **gold** | the relic and the extraction beacon |

## Winning

A relic is hidden at one of five sites. Every 20 seconds it sings, painting its
neighbourhood gold for **both** players. Pick it up and you cannot sprint and you sing your
own position every five seconds. Carry it to The Well and hold still for 3.5 seconds, fully
lit, while the other player knows exactly where you are. At 6:00 everything gets louder. At
8:00 whoever holds it wins — so camping the extraction loses.

## Tests

```bash
sh tools/test-all.sh
```

Nine suites, including the acceptance test that matters: two real browser clients, where
one scans the other, the other walks away, and the ghost is proven **not** to follow.

See `DESIGN.md` for the full design brief and `PROJECT_STATE.md` for architecture.
