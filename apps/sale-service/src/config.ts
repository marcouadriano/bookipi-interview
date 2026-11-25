import { int } from '@flashsale/shared/node';

const env = process.env;

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function time(name: string): number {
  const ms = Date.parse(required(name));
  if (Number.isNaN(ms)) throw new Error(`${name} must be an ISO-8601 time`);
  return ms;
}

export interface Config {
  redisUrl: string;
  saleId: string;
  saleStartMs: number;
  saleEndMs: number;
  totalStock: number;
  waitingRoomPort: number;
  purchasePort: number;
  admitBatchSize: number; // users admitted per tick
  admitIntervalMs: number; // time between ticks
  admitWindowMs: number; // how long an admitted user may buy
  runIdCheckMs: number;
  rateLimitUserMax: number;
  rateLimitUserWindowMs: number;
  rateLimitIpEnabled: boolean;
  rateLimitIpMax: number;
  rateLimitIpWindowMs: number;
}

export function loadConfig(): Config {
  const config: Config = {
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    saleId: env.SALE_ID ?? 'flash-sale-1',
    saleStartMs: time('SALE_START'),
    saleEndMs: time('SALE_END'),
    totalStock: int('TOTAL_STOCK', 100),
    waitingRoomPort: int('WAITING_ROOM_PORT', 3000),
    purchasePort: int('PURCHASE_PORT', 3002),
    admitBatchSize: int('ADMIT_BATCH_SIZE', 50, 1),
    admitIntervalMs: int('ADMIT_INTERVAL_MS', 2000, 1),
    admitWindowMs: int('ADMIT_WINDOW_MS', 120_000, 1),
    runIdCheckMs: int('RUN_ID_CHECK_MS', 1000, 1),
    rateLimitUserMax: int('RATE_LIMIT_USER_MAX', 5),
    rateLimitUserWindowMs: int('RATE_LIMIT_USER_WINDOW_MS', 10_000, 1),
    rateLimitIpEnabled: env.RATE_LIMIT_IP_ENABLED !== 'false',
    rateLimitIpMax: int('RATE_LIMIT_IP_MAX', 100),
    rateLimitIpWindowMs: int('RATE_LIMIT_IP_WINDOW_MS', 10_000, 1),
  };

  if (config.saleEndMs <= config.saleStartMs) throw new Error('SALE_END must be after SALE_START');
  return config;
}

// Purchase app only: the read-only Postgres user used by the rebuild.
export const loadReaderDatabaseUrl = () => required('SALE_READER_DATABASE_URL');
