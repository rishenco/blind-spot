URL ?= http://localhost:8080

.PHONY: up down rebuild logs open dev shoot

## up: build the game image, serve it at $(URL), open the browser
up:
	docker compose up -d --build
	@printf 'waiting for %s ' "$(URL)"; \
	for i in $$(seq 1 60); do \
	    curl -sf -o /dev/null "$(URL)" && break; \
	    printf '.'; sleep 0.5; \
	done; echo
	@$(MAKE) --no-print-directory open
	@echo "BLIND SPOT is up at $(URL)   (make down to stop, make logs for logs)"

## down: stop and remove the container
down:
	docker compose down

## rebuild: force a clean image rebuild and restart
rebuild:
	docker compose build --no-cache
	docker compose up -d
	@$(MAKE) --no-print-directory open

## logs: follow the server logs
logs:
	docker compose logs -f

## open: open the game in the default browser
open:
	@if command -v open >/dev/null 2>&1; then open "$(URL)"; \
	elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$(URL)"; \
	elif command -v python3 >/dev/null 2>&1; then python3 -m webbrowser "$(URL)"; \
	else echo "open $(URL) in your browser"; fi

## dev: run the Vite dev server directly (needs Node 22, no docker)
dev:
	npm install
	npm run dev -- --host

## shoot: headless Playwright screenshot pass over the built game
shoot:
	npm run build
	node tools/shoot.mjs
