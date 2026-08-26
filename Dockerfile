# --- Build stage: compile the single-file game build -------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Serve stage: nginx hosting the static build -----------------------------
FROM nginx:alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/index.html /usr/share/nginx/html/index.html
EXPOSE 80
