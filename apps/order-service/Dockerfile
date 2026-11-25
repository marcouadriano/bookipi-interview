# Build from the repo root:  docker build -f apps/order-service/Dockerfile .
# The default command runs the worker. The migration runs from the same image:
#   node --import tsx scripts/migrate.ts
FROM docker.io/library/node:24-slim

RUN npm install --global pnpm@12.4.1
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/order-service/package.json apps/order-service/
RUN pnpm install --frozen-lockfile --prod --filter @flashsale/order-service...

COPY packages/shared packages/shared
COPY apps/order-service apps/order-service

ENV NODE_ENV=production
WORKDIR /app/apps/order-service
USER node
CMD ["node", "--import", "tsx", "src/index.ts"]
