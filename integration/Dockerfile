# syntax=docker/dockerfile:1
#
# Stiga monitor — background server image.
#
# The build context MUST be the repository root (the Dockerfile COPYs api/ and tools/):
#   docker build -f integration/Dockerfile -t stiga-monitor ..
# or just use integration/docker-compose.yml, which sets the context for you.

# ---- builder: compile the native modules (better-sqlite3, canvas) -------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /opt/stiga-api

# Toolchain + headers to build better-sqlite3, and canvas when no prebuilt binary exists for the
# target arch (e.g. building on a Raspberry Pi / arm64).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 pkg-config \
        libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libpixman-1-dev \
    && rm -rf /var/lib/apt/lists/*

# package-lock.json is intentionally not committed to this repo, so use `npm install` (not `npm ci`).
COPY package.json ./
RUN npm install --omit=dev

# ---- runtime ------------------------------------------------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /opt/stiga-api

# Shared libraries the native modules dlopen at runtime. better-sqlite3 (the --capture engine) needs
# only libstdc++ (already present); the cairo/pango set is for the canvas-based analysis tools, so
# `docker exec ... stiga-analyse` / position rendering work inside the container too.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/stiga-api/node_modules ./node_modules
# Only the code — never the dev capture.db, configs or scratch files (see .dockerignore + narrow COPY).
COPY api ./api
COPY tools ./tools
COPY package.json ./

# /config holds the mounted stiga-config.js; /data holds everything the container writes
# (capture.db, persisted breadcrumb trail) so it survives container restarts/rebuilds.
ENV STIGA_CONFIG=/config/stiga-config.js
VOLUME ["/config", "/data"]
EXPOSE 3001

# Background server (no TTY): web/JSON API on :3001 + a retained capture.db.
#   --background        run headless; expose the IPC socket for `--connect` (see INTEGRATION.md)
#   --directory=/data   ALL writable state lives on the mounted volume, nothing in the image layer
#   --capture           record every MQTT frame to /data/capture.db (directory + 'capture.db')
#   --persist=...       keep the breadcrumb trail across restarts
#   --webstatus=3001    serve the page + /api/* endpoints
# To require auth on the command endpoints, override command: in compose with --webstatus=3001/<pass>/commands
CMD ["node", "tools/stiga-monitor.js", \
     "--background", \
     "--directory=/data", \
     "--capture", \
     "--persist=/data/persist", \
     "--webstatus=3001"]
