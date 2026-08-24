# One-command dev loop for the prototype. Needs only docker (with compose v2) and make.
PORT ?= 5173
URL  := http://localhost:$(PORT)
DC   := PORT=$(PORT) docker compose

.PHONY: up down logs build shots sh reset

## up: start the dev server in docker, wait until it answers, open it in the browser
up:
	$(DC) up -d --build
	@PORT=$(PORT) sh tools/open-when-ready.sh $(URL) || { echo "server did not come up; try: make logs"; exit 1; }

## down: stop the container (dependency volumes are kept)
down:
	$(DC) down

## logs: follow the dev server output
logs:
	$(DC) logs -f dev

## build: production build (tsc + vite) inside the container -> dist/
build:
	$(DC) run --rm dev sh -c 'npm install && npm run build'
	@sh tools/fix-owner.sh dist

## shots: regenerate the keyframes -> out/
shots:
	$(DC) run --rm dev sh -c 'npm install && npx playwright install --with-deps chromium && npm run shots'
	@sh tools/fix-owner.sh dist out

## reset: drop the container and the dependency volumes (use after an interrupted npm install)
reset:
	$(DC) down -v

## sh: shell inside the dev container
sh:
	$(DC) run --rm dev bash
