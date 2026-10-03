FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.build.json

FROM base AS migrate
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild @prisma/engines \
 && test -x node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x \
 && npm cache clean --force
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM base AS runtime-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm pkg delete dependencies.prisma \
 && npm prune --omit=dev --omit=peer --ignore-scripts \
 && rm -rf node_modules/typescript node_modules/@types \
 && find node_modules/@prisma/client/runtime -name 'query_compiler_*' ! -name '*postgresql*' -delete \
 && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
 && test ! -e node_modules/prisma \
 && test ! -e node_modules/@prisma/engines \
 && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist/main.js"]
