# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app
# Toolchain for better-sqlite3 in case no prebuilt binary matches.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential python3 && \
    rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
# Defaults so the image runs anywhere; override with -e. PUBLIC_URL (the
# address the QR codes point to) has no sensible default, so set it per host.
ENV NODE_ENV=production \
    PORT=8080 \
    LIGHTSHOW_DATA_DIR=/data
COPY --from=build /app/package.json /app/next.config.ts ./
# next.config.ts imports server/lan.ts at startup.
COPY --from=build /app/server/lan.ts ./server/lan.ts
COPY --from=build /app/node_modules ./node_modules
# Next writes its runtime cache under .next, so the app user must own it.
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/dist ./dist
# The database and uploaded audio live in /data: mount a volume there.
RUN mkdir /data && chown node:node /data
# Run as the unprivileged user the Node image ships with, not root.
USER node
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
