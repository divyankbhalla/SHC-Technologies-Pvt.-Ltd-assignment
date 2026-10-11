# syntax=docker/dockerfile:1

# ---- Stage 1: compile TypeScript ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: production-only dependencies ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 3: minimal runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    INPUT_FILE=/data/patients.csv \
    FAILED_RECORDS_FILE=/output/failed_records.json \
    BATCH_SIZE=100 \
    MAX_RPS=5 \
    MAX_RETRIES=5
WORKDIR /app
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Writable output dir for the non-root user; input is mounted read-only at /data.
RUN mkdir -p /data /output && chown node:node /output
USER node
# SHC_API_TOKEN (or SHC_API_TOKEN_FILE) must be supplied at runtime, never baked into the image.
CMD ["node", "dist/index.js"]
