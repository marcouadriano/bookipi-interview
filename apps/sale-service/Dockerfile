# Build from the repo root:  docker build -f apps/sale-service/Dockerfile .
# One image, two apps. The command picks which one runs:
#   node --import tsx src/waiting-room.ts   (default)
#   node --import tsx src/purchase.ts
FROM docker.io/library/node:24-slim

RUN npm install --global pnpm@12.4.1
WORKDIR /app

# Dependencies first, so this layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/sale-service/package.json apps/sale-service/
RUN pnpm install --frozen-lockfile --prod --filter @flashsale/sale-service...

COPY packages/shared packages/shared
COPY apps/sale-service apps/sale-service

ENV NODE_ENV=production
WORKDIR /app/apps/sale-service
USER node
CMD ["node", "--import", "tsx", "src/waiting-room.ts"]
