# BLIND SPOT

A 1v1 browser game about **seeing the past**.

The substation is in total darkness. You perceive it only through echolocation pulses that
reconstruct space as glowing point clouds — and a pulse is a photograph, not a window. What
it shows you was true when the wave passed. It does not update. If your opponent was
standing in that doorway six seconds ago, they are *probably* not standing there now.

Every emission is two-sided. Your pulse paints the room for you and paints **you** for them,
through walls. That is the whole game: deciding when knowing is worth being known.

![A corridor drawn entirely from memory](docs/shots/play-2-looking-back-at-memory.png)
*Nothing here is lit. Every point is a measurement you took earlier, and the dim blue ones
are old enough that they might already be wrong.*

## Run it

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. (For a single-process build instead: `npm run serve`, then
open <http://localhost:8787> — the game server serves the built client and the websocket
from the same port.)

 One player clicks **CREATE ROOM** and reads out the six-letter
code; the other types it into **JOIN**. Both pick a weapon and hit **READY**.

**SOLO WALK** is an offline sandbox with no opponent — the fastest way to learn to read the
space before anyone is hunting you.

### With Docker

```bash
docker compose up --build
```

Open <http://localhost:8787>. The image builds the client with vite and then runs the
game server, which serves that bundle and the websocket from a single port — so one
published port is all the game needs. Override it with `PORT=9000 docker compose up`.

Plain docker works too:

```bash
docker build -t blind-spot .
docker run --init -p 8787:8787 blind-spot
```

Behind a TLS-inspecting proxy, hand the build your CA once — both install steps pick
it up, and without the secret the mount is simply absent:

```bash
docker build --secret id=ca,src=/path/to/ca.crt -t blind-spot .
```

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

## What it looks like

| | |
|---|---|
| ![wavefront](docs/shots/w1-wavefront.png) | **A pulse in flight.** The reveal is not an animation — every point carries the time the wave reaches it, so space materialises outward at 60 m/s. |
| ![a fresh sighting](docs/shots/age-0-fresh.png) | **A fresh contact.** Bright orange, posed, with a motion smear you can lead a shot from. |
| ![the same sighting, twenty seconds later](docs/shots/age-3-twenty-seconds.png) | **The same contact, twenty seconds later.** It cooled to rust and came apart. Somebody *was* there. |
| ![the extraction beacon](docs/shots/beacon-2-from-afar-scanned.png) | **The extraction beacon**, once the relic has been touched — a gold column through the ceiling that both players can see from anywhere. |

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

Eleven suites, including the acceptance test that matters: two real browser clients, where
one scans the other, the other walks away, and the ghost is proven **not** to follow.

The browser suites take their target from `BS_URL`, so they can be pointed at any running
server — a container included:

```bash
docker run -d --init -p 8787:8787 -e BS_ROOM_SEED=7 blind-spot
BS_URL=http://localhost:8787 npx tsx tools/test-stale.ts
```

`BS_ROOM_SEED` pins the relic site; `tools/test-match.ts` needs `7` to know where to look.

See `DESIGN.md` for the full design brief and `PROJECT_STATE.md` for architecture.
