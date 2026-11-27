# Runtime image for the api. Build context is dist/apps/api from `nx build api`
# (main.js bundle + the pruned package.json/package-lock.json it generates).
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY main.js ./

# The platform sets PORT (e.g. Cloud Run: 8080); the api falls back to 3000.
USER node
CMD ["node", "main.js"]
