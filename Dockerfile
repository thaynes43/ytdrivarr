# --- Build stage: install deps, compile TypeScript, prune to production deps.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

# --- Runtime stage: non-root TS core (the out-of-process Peloton worker is a separate image, M3).
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Drizzle SQL migrations run on boot (idempotent); they ship uncompiled next to the app.
COPY migrations ./migrations
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
