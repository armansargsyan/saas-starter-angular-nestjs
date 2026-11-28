# Runtime image for the api (Cloud Run).
#
# Build context: dist/apps/api, the output of `nx build api`. It holds the
# webpack bundle (main.js + chunks + source maps; libs/shared is bundled in)
# and the package.json/package-lock.json that Nx generates with only the
# runtime dependencies. node_modules stay external to the bundle, so they are
# installed here.
#
#   npx nx docker-build api          # local image, tag saas-starter-api:local
#   scripts/deploy.sh deploy         # Cloud Build → Artifact Registry → Cloud Run

# Base image pinned by digest (a multi-arch index, so it works for amd64 and
# arm64). To bump it: `docker buildx imagetools inspect node:24-slim`, then
# put the new version and the printed Digest in NODE_IMAGE.
ARG NODE_IMAGE=node:24.22.3-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530

# ── 1. Production dependencies ────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts are needed (geoip-lite ships its data files).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ── 2. Runtime ────────────────────────────────────────────────
FROM ${NODE_IMAGE}
# NO_COLOR: plain log lines (no ANSI codes) in Cloud Logging.
ENV NODE_ENV=production NO_COLOR=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# Only the top-level bundle files are copied (and let through by
# Dockerfile.dockerignore). If the build starts emitting other runtime files
# (e.g. src/assets → dist/apps/api/assets, or chunks in subfolders), add
# them here and in Dockerfile.dockerignore.
COPY *.js *.js.map ./

# Unprivileged user from the base image. Cloud Run sets PORT (8080); the api
# reads it and falls back to 3000.
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "main.js"]
