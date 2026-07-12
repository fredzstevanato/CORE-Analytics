# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    ffmpeg \
    git \
    p7zip-full \
    python3 \
    python3-pip \
    tesseract-ocr \
    tesseract-ocr-por \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
     > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps

ENV NODE_ENV=development

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN npm ci
RUN NEXT_VERSION=$(node -p "require('./package-lock.json').packages['node_modules/next'].version") \
  && npm install --no-save "@next/swc-linux-x64-gnu@$NEXT_VERSION"
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

FROM deps AS builder

ENV NODE_ENV=production
ENV DATABASE_URL=postgresql://core:core@postgres:5432/core_analytics?schema=public
ENV REDIS_URL=redis://redis:6379
ENV OPENSEARCH_URL=http://opensearch:9200
ENV SESSION_SECRET=docker-build-session-secret
ENV TURBO_TELEMETRY_DISABLED=1

RUN npx turbo run build --env-mode=loose
RUN node scripts/docker-use-dist-workspace-packages.mjs

FROM base AS runner

ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
ENV STORAGE_ROOT=/data/storage
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ENV FFMPEG_BIN=ffmpeg
ENV SEVEN_Z_BIN=7z
ENV TESSERACT_BIN=tesseract

COPY --from=builder /app /app
COPY docker/entrypoint.sh /usr/local/bin/core-entrypoint

RUN chmod +x /usr/local/bin/core-entrypoint \
  && mkdir -p /data/storage \
  && chown -R node:node /app /data

USER node

EXPOSE 3001

ENTRYPOINT ["core-entrypoint"]
CMD ["npm", "run", "--workspace", "@core/web", "start"]
