# Tolly: one image with the API and the built web app.
#
#   docker build -t tolly .
#   docker run -p 8787:8787 --env-file .env -e NODE_ENV=production tolly
#
# NODE_ENV=production needs STAFF_PASSWORD. Set DATABASE_URL to a real Postgres.

# ── Stage 1: build the web app ─────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── Stage 2: run the server ────────────────────────────────────────
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY tsconfig.json tsconfig.server.json ./
COPY src/server ./src/server
COPY --from=build /app/dist ./dist
# The embedded database (used only when DATABASE_URL is empty) writes here.
RUN mkdir -p .data && chown -R node:node .data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server/server.ts"]
