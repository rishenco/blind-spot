# syntax=docker/dockerfile:1
#
# Two images out of one file:
#   target `dev`   — node + vite dev server. Small, starts instantly.
#   target `shots` — the same plus playwright + chromium, only for `make shots`.
#
# Dependencies are installed AT BUILD TIME, in their own layer: package.json/package-lock.json
# are copied first, so the (slow) install is re-run only when they actually change.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json ./
RUN npm ci


# ---- dev server -------------------------------------------------------------------------
FROM deps AS dev
# The sources are bind-mounted over /app in compose; this copy is what makes the image usable
# on its own (CI, `docker run` without compose).
COPY . .
EXPOSE 5173
# --host is mandatory: vite binds 127.0.0.1 by default, which is unreachable from the host.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]


# ---- keyframe generator -----------------------------------------------------------------
FROM deps AS shots
# Chromium and its system libraries live in the image, not in a volume filled on first run.
# PLAYWRIGHT_BROWSERS_PATH puts the browser outside /app, so no bind mount can shadow it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright
COPY . .
CMD ["npm", "run", "shots"]
