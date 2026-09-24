# --- Build stage: install deps, compile TypeScript, prune to production deps.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# builds the operator-console assets (dist/public), the provider downloader assets (dist/assets —
# e.g. Peloton's yt-dlp plugin, projected beside each fed Library's subscriptions.yaml, issue #40)
# and the server bundle (dist/index.js)
RUN pnpm build
RUN pnpm prune --prod

# --- Runtime stage: non-root TS core (the out-of-process Peloton worker is a separate image, M3).
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
# dist/ carries index.js + public/ (console) + assets/ (provider downloader assets; the core
# resolves /app/dist/assets beside the bundle and refuses to boot if a declared tree is missing).
COPY --from=build /app/dist ./dist
# Drizzle SQL migrations run on boot (idempotent); they ship uncompiled next to the app.
COPY migrations ./migrations
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
