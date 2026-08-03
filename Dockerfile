# syntax=docker/dockerfile:1

# The API image. Also hosts the queue workers when RUN_WORKER_IN_PROCESS=true,
# which is how it runs on hosts with no separate worker service type.

FROM node:22-slim AS base
# Prisma's query engine needs OpenSSL, and the image does not ship it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# --- Dependencies -----------------------------------------------------------
# Only the manifests, so this layer survives source changes.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/core/package.json      packages/core/
COPY packages/db/package.json        packages/db/
COPY packages/adapters/package.json  packages/adapters/
COPY packages/agent/package.json     packages/agent/
COPY packages/api/package.json       packages/api/
COPY packages/worker/package.json    packages/worker/
COPY packages/websdk/package.json    packages/websdk/
COPY apps/dashboard/package.json     apps/dashboard/
RUN npm ci --include=dev

# --- Build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY scripts scripts
# Generate the Prisma client before compiling: @kyc/db imports its output.
RUN npm run -w @kyc/db generate
RUN npm run build:packages

# --- Runtime ----------------------------------------------------------------
FROM base AS runtime
COPY package.json package-lock.json ./
COPY packages/core/package.json      packages/core/
COPY packages/db/package.json        packages/db/
COPY packages/adapters/package.json  packages/adapters/
COPY packages/agent/package.json     packages/agent/
COPY packages/api/package.json       packages/api/
COPY packages/worker/package.json    packages/worker/
RUN npm ci --omit=dev --workspaces --include-workspace-root \
  && npm cache clean --force

# Compiled output and the generated Prisma client.
COPY --from=build /app/packages/core/dist      packages/core/dist
COPY --from=build /app/packages/db/dist        packages/db/dist
COPY --from=build /app/packages/db/generated   packages/db/generated
COPY --from=build /app/packages/adapters/dist  packages/adapters/dist
COPY --from=build /app/packages/agent/dist     packages/agent/dist
COPY --from=build /app/packages/api/dist       packages/api/dist
COPY --from=build /app/packages/worker/dist    packages/worker/dist

# Migrations are applied at container start by the entrypoint, not at build.
COPY packages/db/prisma packages/db/prisma
COPY --from=build /app/node_modules/.bin/prisma node_modules/.bin/prisma
COPY --from=build /app/node_modules/prisma node_modules/prisma
COPY --from=build /app/node_modules/@prisma node_modules/@prisma
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Never run as root: a container escape should not start with uid 0.
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/api/dist/server.js"]
