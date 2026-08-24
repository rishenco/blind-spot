# One-command dev loop for the prototype. Needs only docker (with compose v2) and make.
PORT ?= 5173
URL  := http://localhost:$(PORT)

# On Linux the container runs as you, so files it writes into the repo (dist/, out/) belong
# to you and not to root. On macOS/Windows the bind mount already remaps ownership.
HOST_UID ?= $(shell sh -c '[ "$$(uname -s)" = Linux ] && id -u || echo 0')
HOST_GID ?= $(shell sh -c '[ "$$(uname -s)" = Linux ] && id -g || echo 0')

DC := PORT=$(PORT) HOST_UID=$(HOST_UID) HOST_GID=$(HOST_GID) docker compose

.PHONY: up down logs build shots sh reset

## up: start the dev server in docker, wait until it answers, open it in the browser
up:
	$(DC) up -d --build --renew-anon-volumes
	@PORT=$(PORT) sh tools/open-when-ready.sh $(URL) || { echo "server did not come up; try: make logs"; exit 1; }

## down: stop the container
down:
	$(DC) down

## logs: follow the dev server output
logs:
	$(DC) logs -f dev

## build: production build (tsc + vite) inside the container -> dist/
build:
	@mkdir -p dist
	$(DC) run --rm --build --user $(HOST_UID):$(HOST_GID) -e HOME=/tmp dev npm run build
	@sh tools/fix-owner.sh dist

## shots: regenerate the keyframes -> out/ (headless chromium, separate image)
shots:
	@mkdir -p out dist
	$(DC) run --rm --build shots
	@sh tools/fix-owner.sh dist out

## sh: shell inside the dev container
sh:
	$(DC) run --rm --build dev bash

## reset: drop the containers, their volumes and the built images
reset:
	$(DC) down -v --rmi local
