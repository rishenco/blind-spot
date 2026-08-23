# BLIND SPOT — prototype

A first-person parkour-stealth game about seeing with sound. See `doc/vision.md`.

## Run it

Needs Docker (with the compose plugin) and `make`:

```sh
make up      # builds the game image, serves it, opens http://localhost:8080
make down    # stop
make logs    # server logs
make rebuild # clean rebuild (if a stale image misbehaves)
```

After pulling a new version of the branch, just run `make up` again — it rebuilds.

## Dev (no docker)

Needs Node 22:

```sh
make dev     # vite dev server with hot reload
make shoot   # headless build + Playwright screenshot pass (tools/shoot.mjs)
```

## Controls

WASD move · Shift sprint · C/Ctrl crouch · Space jump · R respawn · H help · ` scene picker.
Click the canvas to capture the mouse; Esc releases.
