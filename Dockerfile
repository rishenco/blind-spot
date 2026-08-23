# Build stage: the client is a static Vite bundle — node is only needed to produce dist/.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src/ src/
RUN npm run build

# Serve stage: nothing runs server-side (vision §16 — the solo prototype is fully
# client-side), so shipping is just static files behind nginx.
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
