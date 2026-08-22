# BLIND SPOT — container image.
#
# One process serves everything: the built client over HTTP and the authoritative
# match loop over a WebSocket on the same port, so a single published port is all
# the game needs.
#
# Debian rather than Alpine, deliberately: package-lock.json resolves esbuild's
# glibc binary (@esbuild/linux-x64) and carries no musl variant, so `npm ci` on
# Alpine would leave tsx without a working esbuild and the server would not boot.
# Moving to Alpine means regenerating the lockfile on musl first.
#
# Behind a TLS-inspecting proxy (many corporate networks, and some CI sandboxes),
# hand the build your CA once and both install steps will trust it:
#   docker build --secret id=ca,src=/path/to/ca.crt -t blind-spot .
# Without the secret the mount is simply absent and the builds run unchanged.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app

# playwright is a devDependency used only by the browser test harness. Its
# postinstall would otherwise download ~150MB of browsers this image never runs.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,target=/tmp/proxy-ca.crt \
    if [ -s /tmp/proxy-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/proxy-ca.crt; fi; \
    npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY tools ./tools

# `npm run build` is `tsc --noEmit && vite build`: typechecks src + tools (both are
# in tsconfig's include), then emits the client bundle to dist/.
RUN npm run build

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787

COPY package.json package-lock.json ./
# three is a client dependency that vite has already inlined into dist/. Nothing
# under src/server or src/shared imports it, so it does not ship at runtime.
RUN --mount=type=secret,id=ca,target=/tmp/proxy-ca.crt \
    if [ -s /tmp/proxy-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/proxy-ca.crt; fi; \
    npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf node_modules/three

# The server runs its TypeScript sources directly: the shared modules use
# `const enum`, which needs a real TS loader rather than node's type stripping.
COPY tsconfig.json ./
COPY src ./src
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8787

# Node 22 ships a global fetch, so the probe needs nothing extra installed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# --import keeps tsx in-process, so node is PID 1 and receives SIGTERM directly.
CMD ["node", "--import", "tsx", "src/server/index.ts"]
