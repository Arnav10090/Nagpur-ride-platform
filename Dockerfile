FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── Dependencies layer (cached unless package*.json changes) ──
COPY package.json package-lock.json* ./
RUN npm ci --production=false

# ── Admin console build ──
COPY mobile/packages/ mobile/packages/
COPY mobile/apps/admin/ mobile/apps/admin/
COPY mobile/package.json mobile/tsconfig*.json mobile/vitest.config.ts mobile/
RUN cd mobile && npm ci && npm run build:admin

# ── API source ──
COPY apps/ apps/
COPY tsconfig.json ./

# ── Type check (build-time gate) ──
RUN npx tsc --noEmit

# ── Production image ──
FROM node:22-slim AS production
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=base /app/apps/ apps/
COPY --from=base /app/mobile/apps/admin/dist/ mobile/apps/admin/dist/
COPY tsconfig.json ./

# Non-root for security
RUN groupadd -r ride && useradd -r -g ride ride
USER ride

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)})"

ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "apps/api/src/http/main.ts"]
