# Dev container for the prototype: node + vite dev server, nothing else.
# Dependencies are NOT baked into the image — they live in a named volume mounted at
# /app/node_modules, so they survive rebuilds and never collide with the host's node_modules.
FROM node:22-bookworm-slim

WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 5173

# npm install on start is a ~1s no-op once the volume is warm, and picks up package.json edits.
# --host is mandatory: vite binds 127.0.0.1 by default, which is unreachable from the host.
CMD ["sh", "-c", "npm install && exec npm run dev -- --host 0.0.0.0 --port 5173 --strictPort"]
