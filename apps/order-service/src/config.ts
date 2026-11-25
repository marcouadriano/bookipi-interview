import { hostname } from 'node:os';

import { int } from '@flashsale/shared/node';

const env = process.env;

export function loadConfig() {
  return {
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/flashsale',
    saleId: env.SALE_ID ?? 'flash-sale-1',
    totalStock: int('TOTAL_STOCK', 100),
    consumerName: env.CONSUMER_NAME ?? `${hostname()}-${process.pid}`,
    batchSize: int('BATCH_SIZE', 100, 1),
    blockMs: int('BLOCK_MS', 2000, 1), // 0 would make Redis block forever
    reclaimIdleMs: int('RECLAIM_IDLE_MS', 30_000),
    reclaimIntervalMs: int('RECLAIM_INTERVAL_MS', 10_000),
    maxDeliveries: int('MAX_DELIVERIES', 5),
    healthPort: int('HEALTH_PORT', 3001),
  };
}
